import {
  BOT_BOARD_KINDS,
  type BotBoardItem,
  type BotBoardItemInput,
  type BotBoardKind,
  type BotBoardLink,
} from "@t3tools/contracts";

export type BoardRow =
  | { readonly kind: "area"; readonly key: string; readonly area: string; readonly count: number }
  | { readonly kind: "group"; readonly key: string; readonly itemKind: BotBoardKind }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly item: BotBoardItem;
      readonly parentTitle: string | null;
    };

/** Items without an area are listed under this key; the page names it. */
export const NO_AREA = "";

const byOrder = (a: BotBoardItem, b: BotBoardItem) =>
  Number(b.pinned) - Number(a.pinned) ||
  (a.order ?? Infinity) - (b.order ?? Infinity) ||
  a.createdAt.localeCompare(b.createdAt);

function matchesBoardSearch(item: BotBoardItem, search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const tags = item.fields.tags;
  const hay = [
    item.title,
    item.body,
    item.area,
    item.status,
    ...(Array.isArray(tags) ? tags : []),
    item.fields.url,
    item.fields.host,
    item.fields.path,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
    .toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** The board as flat rows for a virtualized list: area headings, kind headings, then items. */
export function boardRows(
  items: ReadonlyArray<BotBoardItem>,
  options: { readonly search: string; readonly showArchived: boolean },
): ReadonlyArray<BoardRow> {
  const titles = new Map(items.map((item) => [item.id, item.title]));
  const visible = items.filter(
    (item) => (options.showArchived || !item.archived) && matchesBoardSearch(item, options.search),
  );
  const areas = [...new Set(visible.map((item) => item.area ?? NO_AREA))].sort((a, b) =>
    a === NO_AREA ? 1 : b === NO_AREA ? -1 : a.localeCompare(b),
  );
  const rows: BoardRow[] = [];
  for (const area of areas) {
    const inArea = visible.filter((item) => (item.area ?? NO_AREA) === area);
    rows.push({ kind: "area", key: `area:${area}`, area, count: inArea.length });
    for (const itemKind of BOT_BOARD_KINDS) {
      const ofKind = inArea.filter((item) => item.kind === itemKind).sort(byOrder);
      if (ofKind.length === 0) continue;
      rows.push({ kind: "group", key: `group:${area}:${itemKind}`, itemKind });
      for (const item of ofKind) {
        rows.push({
          kind: "item",
          key: `item:${item.id}`,
          item,
          parentTitle: item.parentId ? (titles.get(item.parentId) ?? null) : null,
        });
      }
    }
  }
  return rows;
}

export interface BoardDraft {
  readonly kind: BotBoardKind;
  readonly title: string;
  readonly status: string;
  readonly area: string;
  readonly body: string;
  readonly parentId: string;
  readonly due: string;
  readonly priority: string;
  readonly owner: string;
  readonly url: string;
  readonly tags: string;
  readonly links: ReadonlyArray<BotBoardLink>;
  readonly archived: boolean;
  readonly pinned: boolean;
}

const fieldText = (item: BotBoardItem, key: string) => {
  const value = item.fields[key];
  return value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value);
};

export function draftOf(item: BotBoardItem | null, kind: BotBoardKind = "task"): BoardDraft {
  return {
    kind: item?.kind ?? kind,
    title: item?.title ?? "",
    status: item?.status ?? "",
    area: item?.area ?? "",
    body: item?.body ?? "",
    parentId: item?.parentId ?? "",
    due: item === null ? "" : fieldText(item, "due"),
    priority: item === null ? "" : fieldText(item, "priority"),
    owner: item === null ? "" : fieldText(item, "owner"),
    url: item === null ? "" : fieldText(item, "url"),
    tags: item === null ? "" : fieldText(item, "tags"),
    links: item?.links ?? [],
    archived: item?.archived ?? false,
    pinned: item?.pinned ?? false,
  };
}

const parseTags = (text: string) =>
  text
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

/** What to send for a draft: everything for a new item, only what changed for an existing one. */
export function draftInput(item: BotBoardItem | null, draft: BoardDraft): BotBoardItemInput | null {
  const before = draftOf(item, draft.kind);
  const changed = <K extends keyof BoardDraft>(key: K) =>
    item === null || JSON.stringify(before[key]) !== JSON.stringify(draft[key]);
  const orNull = (value: string) => (value.trim() === "" ? null : value.trim());
  const fields: Record<string, string | string[] | null> = {};
  for (const key of ["due", "priority", "owner", "url"] as const) {
    if (changed(key) && (item !== null || draft[key].trim() !== ""))
      fields[key] = orNull(draft[key]);
  }
  if (changed("tags") && (item !== null || draft.tags.trim() !== "")) {
    const tags = parseTags(draft.tags);
    fields.tags = tags.length ? tags : null;
  }
  const input: BotBoardItemInput = {
    ...(item === null ? { kind: draft.kind } : { id: item.id }),
    ...(item !== null && changed("kind") ? { kind: draft.kind } : {}),
    ...(changed("title") ? { title: draft.title.trim() } : {}),
    ...(changed("status") && (item !== null || draft.status !== "")
      ? { status: orNull(draft.status) }
      : {}),
    ...(changed("area") && (item !== null || draft.area.trim() !== "")
      ? { area: orNull(draft.area) }
      : {}),
    ...(changed("body") && (item !== null || draft.body.trim() !== "")
      ? { body: orNull(draft.body) }
      : {}),
    ...(changed("parentId") && (item !== null || draft.parentId !== "")
      ? { parentId: orNull(draft.parentId) }
      : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(changed("links") && (item !== null || draft.links.length > 0)
      ? { links: draft.links }
      : {}),
    ...(item !== null && changed("archived") ? { archived: draft.archived } : {}),
    ...(changed("pinned") && (item !== null || draft.pinned) ? { pinned: draft.pinned } : {}),
  };
  return item !== null && Object.keys(input).length === 1 ? null : input;
}

export function linkLabel(link: BotBoardLink): string {
  if (link.label) return link.label;
  switch (link.type) {
    case "thread":
      return link.threadId;
    case "bot":
      return link.slug;
    case "item":
      return link.id;
    case "url":
      return link.url;
  }
}
