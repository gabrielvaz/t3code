// Adapted from Threebot server/projects.mts (MIT, Copyright (c) 2026 Threebot contributors).
//
// The Projects board (beta): one live document the user and every Bot edit together, stored as
// `<botsRoot>/.shared/projects.json`. Items are projects, to-dos, machines, services, repos, notes
// and links. Every change is stamped with who made it; subscribers get the board once, then only
// what each save or delete changed.
import {
  BOT_BOARD_FIELD_NAMES,
  BOT_BOARD_KINDS,
  BOT_BOARD_MAX_BATCH,
  BOT_BOARD_PRIORITIES,
  BOT_BOARD_STATUSES,
  type BotBoardActivity,
  type BotBoardActor,
  BotBoardError,
  type BotBoardEvent,
  type BotBoardFieldValue,
  type BotBoardItem,
  type BotBoardKind,
  type BotBoardLink,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { readTextIfExists, writeTextAtomic } from "./BotFiles.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Item = Mutable<Omit<BotBoardItem, "fields" | "links">> & {
  fields: Record<string, BotBoardFieldValue>;
  links: BotBoardLink[];
};
type Activity = BotBoardActivity;

export interface BoardState {
  readonly version: number;
  readonly seq: number;
  readonly items: Readonly<Record<string, Item>>;
  readonly activity: ReadonlyArray<Activity>;
}

export const EMPTY_BOARD: BoardState = { version: 0, seq: 0, items: {}, activity: [] };

const MAX_ITEMS = 5000;
export const BOARD_MAX_ACTIVITY = 300;
const SNAPSHOT_ACTIVITY = 60;
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const REF_PATTERN = /^ref:([\w-]{1,40})$/;
const LINK_TYPES = ["thread", "bot", "item", "url"] as const;

/** Input the board refuses; its message is written for the user or the Bot that sent it. */
export class BoardInvalid extends Schema.TaggedError<BoardInvalid>()("BoardInvalid", {
  message: Schema.String,
}) {}
const invalid = (message: string) => new BoardInvalid({ message });
const isBoardInvalid = Schema.is(BoardInvalid);

const isKind = (value: unknown): value is BotBoardKind =>
  typeof value === "string" && (BOT_BOARD_KINDS as ReadonlyArray<string>).includes(value);

const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`${field} must be text.`);
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (trimmed.length > max) throw invalid(`${field} is longer than ${max} characters.`);
  return trimmed || undefined;
};
const oneLine = (value: unknown, field: string, max: number): string | undefined =>
  text(value, field, max)?.replace(/\s+/g, " ");

function cleanUrl(value: unknown, field = "url"): string | undefined {
  const v = oneLine(value, field, 2000);
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw invalid(`${field} must be a full address, like https://example.com.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid(`${field} must start with http:// or https://.`);
  }
  return url.href;
}

function cleanDate(value: unknown): string | undefined {
  const v = oneLine(value, "due", 10);
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw invalid("due must be a date like 2026-11-03.");
  }
  return v;
}

function cleanTags(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid("tags must be a list of words.");
  const tags = [
    ...new Set(
      value.flatMap((tag) => {
        const cleaned = oneLine(tag, "tag", 32)?.toLowerCase();
        return cleaned === undefined ? [] : [cleaned];
      }),
    ),
  ];
  if (tags.length > 12) throw invalid("Use at most 12 tags.");
  return tags.length ? tags : undefined;
}

/** Known extra fields per item. Anything else is refused, so the board stays legible. */
const FIELD_CLEANERS: Record<
  (typeof BOT_BOARD_FIELD_NAMES)[number],
  (value: unknown) => BotBoardFieldValue | undefined
> = {
  url: (v) => cleanUrl(v),
  path: (v) => oneLine(v, "path", 500),
  host: (v) => oneLine(v, "host", 200),
  port: (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw invalid("port must be a number from 1 to 65535.");
    }
    return n;
  },
  branch: (v) => oneLine(v, "branch", 200),
  due: cleanDate,
  priority: (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v !== "string" || !(BOT_BOARD_PRIORITIES as ReadonlyArray<string>).includes(v)) {
      throw invalid(`priority must be one of ${BOT_BOARD_PRIORITIES.join(", ")}.`);
    }
    return v;
  },
  owner: (v) => oneLine(v, "owner", 60),
  tags: cleanTags,
};

function cleanFields(
  input: unknown,
  previous: Record<string, BotBoardFieldValue>,
): Record<string, BotBoardFieldValue> {
  if (input === undefined) return previous;
  if (input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw invalid("fields must be an object.");
  const next = { ...previous };
  for (const [key, value] of Object.entries(input)) {
    const cleaner = Object.hasOwn(FIELD_CLEANERS, key)
      ? FIELD_CLEANERS[key as keyof typeof FIELD_CLEANERS]
      : undefined;
    if (cleaner === undefined) {
      throw invalid(
        `Unknown field "${key}". Use ${BOT_BOARD_FIELD_NAMES.join(", ")}, or put it in body.`,
      );
    }
    const cleaned = cleaner(value);
    if (cleaned === undefined) delete next[key];
    else next[key] = cleaned;
  }
  return next;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

function cleanLink(input: unknown): BotBoardLink {
  const link = record(input);
  if (link === null) throw invalid("Each link must be an object with a type.");
  const label = oneLine(link.label, "link label", 120);
  const base = label ? { label } : {};
  switch (link.type) {
    case "thread": {
      const threadId = oneLine(link.threadId, "threadId", 1024);
      if (!threadId) throw invalid("A thread link needs threadId.");
      const environmentId = oneLine(link.environmentId, "environmentId", 128);
      if (environmentId && !/^[a-zA-Z0-9_-]{1,128}$/.test(environmentId)) {
        throw invalid("environmentId looks wrong.");
      }
      return { type: "thread", threadId, ...(environmentId ? { environmentId } : {}), ...base };
    }
    case "bot": {
      const slug = oneLine(link.slug, "slug", 63);
      if (!slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
        throw invalid("A Bot link needs the Bot's slug.");
      }
      return { type: "bot", slug, ...base };
    }
    case "item": {
      const id = oneLine(link.id, "id", 40);
      if (!id) throw invalid("An item link needs id.");
      return { type: "item", id, ...base };
    }
    case "url": {
      const url = cleanUrl(link.url, "link url");
      if (!url) throw invalid("A url link needs url.");
      return { type: "url", url, ...base };
    }
    default:
      throw invalid(`Link type must be one of ${LINK_TYPES.join(", ")}.`);
  }
}

const linkTarget = (link: BotBoardLink) =>
  link.type === "thread"
    ? link.threadId
    : link.type === "bot"
      ? link.slug
      : link.type === "item"
        ? link.id
        : link.url;
const linkKey = (link: BotBoardLink) =>
  JSON.stringify([
    link.type,
    linkTarget(link),
    link.type === "thread" ? (link.environmentId ?? null) : null,
  ]);

function cleanLinks(list: unknown): BotBoardLink[] {
  if (!Array.isArray(list)) throw invalid("links must be a list.");
  const seen = new Map<string, BotBoardLink>();
  for (const link of list.map(cleanLink)) seen.set(linkKey(link), link);
  if (seen.size > 40) throw invalid("Use at most 40 links per item.");
  return [...seen.values()];
}

const asList = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [value]);
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const actorOf = (actor: BotBoardActor | undefined): BotBoardActor =>
  actor?.type === "bot"
    ? {
        type: "bot",
        ...(actor.name === undefined ? {} : { name: actor.name }),
        ...(actor.slug === undefined ? {} : { slug: actor.slug }),
      }
    : { type: "user" };

function newBoardId(taken: ReadonlySet<string>, randomBytes: () => Uint8Array): string {
  for (;;) {
    const id = Array.from(randomBytes(), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
    if (!taken.has(id)) return id;
  }
}

const withActivity = (activity: ReadonlyArray<Activity>, entries: ReadonlyArray<Activity>) => {
  const next = [...activity, ...entries];
  return next.length > BOARD_MAX_ACTIVITY ? next.slice(next.length - BOARD_MAX_ACTIVITY) : next;
};

const TRACKED = [
  "kind",
  "title",
  "status",
  "area",
  "body",
  "parentId",
  "machineId",
  "fields",
  "links",
  "pinned",
  "order",
  "archived",
] as const;

export interface BoardContext {
  readonly now: string;
  readonly actor?: BotBoardActor | undefined;
  readonly newId: (taken: ReadonlySet<string>) => string;
}

export interface SaveOutcome {
  readonly state: BoardState;
  readonly items: ReadonlyArray<BotBoardItem>;
  readonly event: Extract<BotBoardEvent, { type: "change" }> | null;
}

/**
 * Creates or changes items, all or nothing. An input without id creates one; with id it changes
 * only the given properties (null clears one). `ref` names a new item so others in the same batch
 * can use "ref:<name>" as parentId, machineId or an item link.
 */
export function applyBoardSave(
  current: BoardState,
  inputs: ReadonlyArray<unknown>,
  context: BoardContext,
): SaveOutcome {
  if (inputs.length === 0) throw invalid("Give at least one item.");
  if (inputs.length > BOT_BOARD_MAX_BATCH) {
    throw invalid(`Save at most ${BOT_BOARD_MAX_BATCH} items at a time.`);
  }
  const stamp = context.now;
  const who = actorOf(context.actor);
  const items: Record<string, Item> = structuredClone(current.items) as Record<string, Item>;
  let seq = current.seq;
  const refs = new Map<string, string>();
  const taken = new Set(Object.keys(items));
  // Every new item gets its id first, so items later in the batch can point at earlier ones and back.
  const plan = inputs.map((raw, index) => {
    const input = record(raw);
    if (input === null) throw invalid(`Item ${index + 1} must be an object.`);
    if (input.id !== undefined) {
      if (typeof input.id !== "string" || !items[input.id]) {
        throw invalid(`There's no item "${String(input.id)}". Leave id out to create one.`);
      }
      return { input, id: input.id, created: false };
    }
    const id = context.newId(taken);
    taken.add(id);
    if (input.ref !== undefined) {
      if (typeof input.ref !== "string" || !/^[\w-]{1,40}$/.test(input.ref)) {
        throw invalid("ref must be a short name of letters, digits, - or _.");
      }
      if (refs.has(input.ref)) throw invalid(`ref "${input.ref}" is used twice.`);
      refs.set(input.ref, id);
    }
    return { input, id, created: true };
  });
  if (Object.keys(items).length + plan.filter((step) => step.created).length > MAX_ITEMS) {
    throw invalid(`The board holds at most ${MAX_ITEMS} items. Archive or delete some first.`);
  }

  const resolveRef = (value: unknown, field: string): string | null | undefined => {
    if (value === null || value === "") return null;
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw invalid(`${field} must be an item id.`);
    const ref = REF_PATTERN.exec(value);
    const id = ref ? refs.get(ref[1]!) : value;
    if (!id) throw invalid(`${field} "${value}" doesn't name an item in this batch.`);
    if (!items[id]) throw invalid(`${field} "${value}" isn't on the board.`);
    return id;
  };

  for (const step of plan) {
    if (!step.created) continue;
    if (!isKind(step.input.kind))
      throw invalid(`kind must be one of ${BOT_BOARD_KINDS.join(", ")}.`);
    items[step.id] = {
      id: step.id,
      kind: step.input.kind,
      title: "(untitled)",
      fields: {},
      links: [],
      pinned: false,
      archived: false,
      createdAt: stamp,
      updatedAt: stamp,
      createdBy: who,
      updatedBy: who,
    };
  }

  const changed: Item[] = [];
  const entries: Activity[] = [];
  for (const { input, id, created } of plan) {
    const prev = current.items[id];
    const item = items[id]!;
    if (!created && input.kind !== undefined && input.kind !== item.kind) {
      if (!isKind(input.kind)) throw invalid(`kind must be one of ${BOT_BOARD_KINDS.join(", ")}.`);
      item.kind = input.kind;
    }
    if (created || input.title !== undefined) {
      const title = oneLine(input.title, "title", 200);
      if (!title) throw invalid("Every item needs a title.");
      item.title = title;
    }
    const statuses = BOT_BOARD_STATUSES[item.kind];
    if (input.status !== undefined) {
      if (input.status === null || input.status === "") delete item.status;
      else if (typeof input.status !== "string" || !statuses.includes(input.status)) {
        throw invalid(
          statuses.length
            ? `A ${item.kind}'s status is one of ${statuses.join(", ")}.`
            : `A ${item.kind} has no status.`,
        );
      } else item.status = input.status;
    }
    if (item.status && !statuses.includes(item.status)) delete item.status;
    if (!item.status && statuses.length) {
      item.status =
        item.kind === "machine" || item.kind === "service" ? statuses.at(-1) : statuses[0];
    }
    if (input.area !== undefined) {
      const area = oneLine(input.area, "area", 40)?.toLowerCase();
      if (area) item.area = area;
      else delete item.area;
    }
    if (input.body !== undefined) {
      const body = text(input.body, "body", 20_000);
      if (body) item.body = body;
      else delete item.body;
    }
    for (const key of ["parentId", "machineId"] as const) {
      if (input[key] === undefined) continue;
      const target = resolveRef(input[key], key);
      if (target === id) {
        throw invalid(`An item can't be its own ${key === "parentId" ? "parent" : "machine"}.`);
      }
      if (target && key === "machineId" && items[target]!.kind !== "machine") {
        throw invalid("machineId must point at a machine.");
      }
      if (target) item[key] = target;
      else delete item[key];
    }
    if (item.parentId) {
      for (let at: string | undefined = item.parentId, steps = 0; at; at = items[at]?.parentId) {
        if (at === id || ++steps > 50) throw invalid("An item can't be inside itself.");
      }
    }
    if (input.fields !== undefined) item.fields = cleanFields(input.fields, item.fields);
    if (input.links !== undefined) item.links = input.links === null ? [] : cleanLinks(input.links);
    if (input.addLinks !== undefined) {
      item.links = cleanLinks([...item.links, ...asList(input.addLinks)]);
    }
    if (input.removeLinks !== undefined) {
      const drop = new Set(cleanLinks(asList(input.removeLinks)).map(linkKey));
      item.links = item.links.filter((link) => !drop.has(linkKey(link)));
    }
    item.links = item.links.map((link) =>
      link.type === "item" ? { ...link, id: resolveRef(link.id, "link id") ?? link.id } : link,
    );
    if (input.pinned !== undefined) item.pinned = Boolean(input.pinned);
    if (input.order !== undefined) {
      if (input.order === null) delete item.order;
      else if (typeof input.order !== "number" || !Number.isFinite(input.order)) {
        throw invalid("order must be a number.");
      } else item.order = input.order;
    }
    if (input.archived !== undefined) item.archived = Boolean(input.archived);

    const fieldsChanged = TRACKED.filter((key) => created || !sameValue(prev?.[key], item[key]));
    if (!created && fieldsChanged.length === 0) continue;
    if (item.kind === "task" && item.status === "done" && (created || prev?.status !== "done")) {
      item.doneAt = stamp;
    }
    if (item.status !== "done") delete item.doneAt;
    item.updatedAt = stamp;
    item.updatedBy = who;
    changed.push(item);
    const action: Activity["action"] = created
      ? "created"
      : fieldsChanged.includes("archived")
        ? item.archived
          ? "archived"
          : "restored"
        : item.kind === "task" && fieldsChanged.includes("status") && item.status === "done"
          ? "completed"
          : "updated";
    entries.push({
      seq: ++seq,
      at: stamp,
      actor: who,
      itemId: id,
      kind: item.kind,
      title: item.title,
      action,
      changed: created ? [] : fieldsChanged,
    });
  }
  if (changed.length === 0) return { state: current, items: [], event: null };
  const state: BoardState = {
    version: current.version + 1,
    seq,
    items,
    activity: withActivity(current.activity, entries),
  };
  const saved = structuredClone(changed);
  return {
    state,
    items: saved,
    event: { type: "change", version: state.version, items: saved, removed: [], activity: entries },
  };
}

export interface RemoveOutcome {
  readonly state: BoardState;
  readonly removed: ReadonlyArray<string>;
  readonly event: Extract<BotBoardEvent, { type: "change" }>;
}

/** Removes items for good. Their children move up to the removed item's nearest kept parent. */
export function applyBoardRemove(
  current: BoardState,
  ids: ReadonlyArray<string>,
  context: Omit<BoardContext, "newId">,
): RemoveOutcome {
  if (ids.length === 0) throw invalid("Give at least one id.");
  const items: Record<string, Item> = structuredClone(current.items) as Record<string, Item>;
  const gone = [...new Set(ids.filter((id) => typeof id === "string" && items[id]))];
  if (gone.length === 0) throw invalid("None of those items are on the board.");
  const who = actorOf(context.actor);
  const goneSet = new Set(gone);
  const moved: Item[] = [];
  for (const item of Object.values(items)) {
    if (goneSet.has(item.id)) continue;
    let changed = false;
    if (item.parentId && goneSet.has(item.parentId)) {
      let parent = items[item.parentId]?.parentId;
      while (parent && goneSet.has(parent)) parent = items[parent]?.parentId;
      if (parent) item.parentId = parent;
      else delete item.parentId;
      changed = true;
    }
    if (item.machineId && goneSet.has(item.machineId)) {
      delete item.machineId;
      changed = true;
    }
    const links = item.links.filter((link) => !(link.type === "item" && goneSet.has(link.id)));
    if (links.length !== item.links.length) {
      item.links = links;
      changed = true;
    }
    if (changed) {
      item.updatedAt = context.now;
      moved.push(item);
    }
  }
  let seq = current.seq;
  const entries = gone.map((id): Activity => ({
    seq: ++seq,
    at: context.now,
    actor: who,
    itemId: id,
    kind: items[id]!.kind,
    title: items[id]!.title,
    action: "deleted",
    changed: [],
  }));
  for (const id of gone) delete items[id];
  const state: BoardState = {
    version: current.version + 1,
    seq,
    items,
    activity: withActivity(current.activity, entries),
  };
  return {
    state,
    removed: gone,
    event: {
      type: "change",
      version: state.version,
      items: structuredClone(moved),
      removed: gone,
      activity: entries,
    },
  };
}

/** Reads a saved board leniently: a file from an older or newer version keeps what it can. */
function parseBoardFile(raw: string): BoardState {
  if (raw.trim() === "") return EMPTY_BOARD;
  const parsed = record(JSON.parse(raw));
  if (parsed === null) return EMPTY_BOARD;
  const items = record(parsed.items) ?? {};
  return {
    version: Number(parsed.version) || 0,
    seq: Number(parsed.seq) || 0,
    items: Object.fromEntries(
      Object.entries(items).filter(
        ([, item]) => record(item) !== null && isKind(record(item)?.kind),
      ),
    ) as Record<string, Item>,
    activity: Array.isArray(parsed.activity) ? (parsed.activity as Activity[]) : [],
  };
}

const OPEN_TASK = (item: BotBoardItem) =>
  item.kind === "task" && item.status !== "done" && !item.archived;
const byOrder = (a: BotBoardItem, b: BotBoardItem) =>
  (a.order ?? Infinity) - (b.order ?? Infinity) || a.createdAt.localeCompare(b.createdAt);

/** A compact view for agents: ids, titles and where things sit, without bodies. */
function boardBrief(item: BotBoardItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    ...(item.status ? { status: item.status } : {}),
    ...(item.area ? { area: item.area } : {}),
    ...(item.parentId ? { parentId: item.parentId } : {}),
    ...(item.machineId ? { machineId: item.machineId } : {}),
    ...(Object.keys(item.fields).length ? { fields: item.fields } : {}),
    ...(item.pinned ? { pinned: true } : {}),
    ...(item.archived ? { archived: true } : {}),
    ...(item.links.length ? { links: item.links.length } : {}),
  };
}

const actorLabel = (actor: BotBoardActor) =>
  actor.type === "user" ? "user" : actor.name || actor.slug || "a Bot";

export function boardOverview(
  items: ReadonlyArray<BotBoardItem>,
  activity: ReadonlyArray<BotBoardActivity>,
) {
  const live = items.filter((item) => !item.archived);
  const titleOf = (id: string) => live.find((item) => item.id === id)?.title;
  const priority = (item: BotBoardItem) =>
    (BOT_BOARD_PRIORITIES as ReadonlyArray<unknown>).indexOf(item.fields.priority ?? "normal");
  const services = live.filter((item) => item.kind === "service" && !item.machineId);
  return {
    counts: Object.fromEntries(
      BOT_BOARD_KINDS.map((kind) => [kind, live.filter((item) => item.kind === kind).length]),
    ),
    projects: live
      .filter((item) => item.kind === "project")
      .sort(byOrder)
      .map((project) => ({
        ...boardBrief(project),
        openTasks: live.filter((item) => OPEN_TASK(item) && item.parentId === project.id).length,
      })),
    openTasks: live
      .filter(OPEN_TASK)
      .sort(
        (a, b) =>
          priority(a) - priority(b) ||
          String(a.fields.due ?? "9999").localeCompare(String(b.fields.due ?? "9999")) ||
          byOrder(a, b),
      )
      .slice(0, 60)
      .map((task) => ({
        ...boardBrief(task),
        ...(task.parentId ? { project: titleOf(task.parentId) } : {}),
      })),
    machines: live
      .filter((item) => item.kind === "machine")
      .sort(byOrder)
      .map((machine) => ({
        ...boardBrief(machine),
        services: live
          .filter((item) => item.kind === "service" && item.machineId === machine.id)
          .map(boardBrief),
        repos: live
          .filter((item) => item.kind === "repo" && item.machineId === machine.id)
          .map(boardBrief),
      })),
    ...(services.length ? { servicesWithoutMachine: services.map(boardBrief) } : {}),
    recent: activity
      .slice(-12)
      .reverse()
      .map((entry) => ({
        at: entry.at,
        who: actorLabel(entry.actor),
        action: entry.action,
        id: entry.itemId,
        title: entry.title,
      })),
  };
}

export interface BoardFindQuery {
  readonly search?: string | undefined;
  readonly kind?: BotBoardKind | undefined;
  readonly status?: string | undefined;
  readonly open?: boolean | undefined;
  readonly area?: string | undefined;
  readonly parentId?: string | undefined;
  readonly machineId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly limit?: number | undefined;
}

export function boardFind(items: ReadonlyArray<BotBoardItem>, query: BoardFindQuery) {
  const words = (query.search ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = items.filter((item) => {
    if (!query.includeArchived && item.archived) return false;
    if (query.kind && item.kind !== query.kind) return false;
    if (query.status && item.status !== query.status) return false;
    if (query.open && item.kind === "task" && item.status === "done") return false;
    if (query.area && item.area !== query.area.toLowerCase()) return false;
    if (query.parentId && item.parentId !== query.parentId) return false;
    if (query.machineId && item.machineId !== query.machineId) return false;
    if (
      query.threadId &&
      !item.links.some((link) => link.type === "thread" && link.threadId === query.threadId)
    ) {
      return false;
    }
    if (words.length === 0) return true;
    const tags = item.fields.tags;
    const hay = [
      item.title,
      item.body,
      item.area,
      ...(Array.isArray(tags) ? tags : []),
      item.fields.url,
      item.fields.path,
      item.fields.host,
    ]
      .filter((part) => part !== undefined)
      .join(" ")
      .toLowerCase();
    return words.every((word) => hay.includes(word));
  });
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50) || 50, 1), 200);
  return { total: matches.length, items: matches.sort(byOrder).slice(0, limit).map(boardBrief) };
}

export function boardDetail(items: ReadonlyArray<BotBoardItem>, id: string) {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) return null;
  const parent = item.parentId ? items.find((candidate) => candidate.id === item.parentId) : null;
  return {
    ...item,
    ...(parent ? { parent: { id: parent.id, title: parent.title, kind: parent.kind } } : {}),
    children: items
      .filter((candidate) => candidate.parentId === id && !candidate.archived)
      .sort(byOrder)
      .map(boardBrief),
    ...(item.kind === "machine"
      ? {
          onThisMachine: items
            .filter((candidate) => candidate.machineId === id && !candidate.archived)
            .map(boardBrief),
        }
      : {}),
    linkedFrom: items
      .filter((candidate) => candidate.links.some((link) => link.type === "item" && link.id === id))
      .map((candidate) => ({ id: candidate.id, title: candidate.title, kind: candidate.kind })),
  };
}

export class BotProjectsBoard extends Context.Service<
  BotProjectsBoard,
  {
    /** Whether Labs › Projects board is on; tools and RPCs refuse while it is off. */
    readonly enabled: Effect.Effect<boolean>;
    readonly snapshot: Effect.Effect<Extract<BotBoardEvent, { type: "snapshot" }>, BotBoardError>;
    readonly save: (
      inputs: ReadonlyArray<unknown>,
      actor?: BotBoardActor,
    ) => Effect.Effect<
      { version: number; items: ReadonlyArray<BotBoardItem>; unchanged?: boolean },
      BotBoardError
    >;
    readonly remove: (
      ids: ReadonlyArray<string>,
      actor?: BotBoardActor,
    ) => Effect.Effect<{ version: number; removed: ReadonlyArray<string> }, BotBoardError>;
    /** The board now, then each change. */
    readonly subscribe: () => Stream.Stream<BotBoardEvent, BotBoardError>;
  }
>()("t3/bots/BotProjectsBoard") {}

const storageError = () =>
  new BotBoardError({
    reason: "storage",
    detail: "The Projects board file can't be read or saved.",
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const file = path.join(config.stateDir, "bots", ".shared", "projects.json");
  const lock = yield* Semaphore.make(1);
  const state = yield* Ref.make<BoardState | null>(null);
  const changes = yield* PubSub.unbounded<BotBoardEvent>();

  const io = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const load = Effect.gen(function* () {
    const cached = yield* Ref.get(state);
    if (cached !== null) return cached;
    const raw = yield* io(readTextIfExists(file)).pipe(Effect.mapError(storageError));
    const loaded = yield* Effect.try({ try: () => parseBoardFile(raw), catch: storageError });
    yield* Ref.set(state, loaded);
    return loaded;
  });

  const persist = (next: BoardState) =>
    io(writeTextAtomic(file, JSON.stringify(next))).pipe(
      Effect.andThen(fileSystem.chmod(file, 0o600).pipe(Effect.ignore)),
      Effect.mapError(storageError),
      Effect.andThen(Ref.set(state, next)),
    );

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.botsProjectsBoardEnabled),
    Effect.orElseSucceed(() => false),
  );
  const requireEnabled = enabled.pipe(
    Effect.filterOrFail(
      (on) => on,
      () =>
        new BotBoardError({
          reason: "disabled",
          detail: "The Projects board is off. Turn it on in Settings › Labs.",
        }),
    ),
  );

  const fromInvalid = (error: unknown) =>
    isBoardInvalid(error)
      ? new BotBoardError({ reason: "invalid", detail: error.message })
      : new BotBoardError({
          reason: "storage",
          detail: "The Projects board could not be changed.",
        });

  const snapshot: BotProjectsBoard["Service"]["snapshot"] = load.pipe(
    Effect.map((current) => ({
      type: "snapshot" as const,
      version: current.version,
      items: Object.values(current.items),
      activity: current.activity.slice(-SNAPSHOT_ACTIVITY),
    })),
    Effect.withSpan("BotProjectsBoard.snapshot"),
  );

  const save: BotProjectsBoard["Service"]["save"] = Effect.fn("BotProjectsBoard.save")(function* (
    inputs,
    actor,
  ) {
    yield* requireEnabled;
    const current = yield* load;
    const now = DateTime.formatIso(yield* DateTime.now);
    // Eight random bytes per new item, with spares in case a short id is already taken.
    const pool = yield* random.randomBytes((inputs.length + 8) * 8);
    let offset = 0;
    const outcome = yield* Effect.try({
      try: () =>
        applyBoardSave(current, inputs, {
          now,
          actor,
          newId: (taken) =>
            newBoardId(taken, () => {
              if (offset + 8 > pool.length) throw invalid("Try saving again.");
              offset += 8;
              return pool.subarray(offset - 8, offset);
            }),
        }),
      catch: fromInvalid,
    });
    if (outcome.event === null) {
      return { version: current.version, items: [], unchanged: true };
    }
    yield* persist(outcome.state);
    yield* PubSub.publish(changes, outcome.event);
    return { version: outcome.state.version, items: outcome.items };
  }, lock.withPermits(1));

  const remove: BotProjectsBoard["Service"]["remove"] = Effect.fn("BotProjectsBoard.remove")(
    function* (ids, actor) {
      yield* requireEnabled;
      const current = yield* load;
      const now = DateTime.formatIso(yield* DateTime.now);
      const outcome = yield* Effect.try({
        try: () => applyBoardRemove(current, ids, { now, actor }),
        catch: fromInvalid,
      });
      yield* persist(outcome.state);
      yield* PubSub.publish(changes, outcome.event);
      return { version: outcome.state.version, removed: outcome.removed };
    },
    lock.withPermits(1),
  );

  const subscribe: BotProjectsBoard["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireEnabled;
        // Subscribe before the snapshot so a change made meanwhile is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const first = yield* lock.withPermits(1)(snapshot);
        const head: BotBoardEvent = first;
        return Stream.concat(
          Stream.make(head),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.version > first.version),
          ),
        );
      }),
    );

  return BotProjectsBoard.of({ enabled, snapshot, save, remove, subscribe });
});

export const layer = Layer.effect(BotProjectsBoard, make);
