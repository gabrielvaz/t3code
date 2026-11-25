// The pure part of a room turn: who is addressed, how the prompt reads, when a reply is a pass and
// how the transcript merges. Ported from Threebot server/room-lines.mts and server/room-turn.mts
// (MIT, Copyright (c) 2026 Threebot contributors).
import {
  BOT_ROOM_MAX_MEMBERS,
  BOT_ROOM_MIN_MEMBERS,
  type BotId,
  type BotRoomMember,
  type BotRoomRecord,
  type BotRoomSettings,
  type BotRoomSettingsPatch,
  type BotRoomTranscriptEntry,
  type BotRoomTurn,
} from "@t3tools/contracts";
import { addressedMembers } from "@t3tools/shared/botMentions";
import * as DateTime from "effect/DateTime";

const DEFAULT_ROOM_SETTINGS: Omit<BotRoomSettings, "lead"> = {
  mode: "panel",
  defaultResponder: "lead",
  allowCrossMentions: true,
  maxWaves: 3,
  maxReplies: 10,
  memberTimeoutMin: 10,
  turnDeadlineMin: 20,
};
/** The room transcript a prompt carries, newest lines first to go. */
const PROMPT_LINES = 24;
const LINE_MAX_CHARS = 1_200;

export interface RoomMessage {
  readonly text: string;
  /** Bot ids or "all", as the composer resolved them. */
  readonly mentions: ReadonlyArray<string>;
}

export type RoomLine = {
  readonly at: string;
  readonly author: { readonly kind: "user" } | { readonly kind: "bot"; readonly botId: BotId };
  readonly text: string;
};

type NameOf = (botId: BotId) => string;

/** Merges a patch over the current settings; a lead that left the room hands over to the first member. */
export function normalizeRoomSettings(
  patch: BotRoomSettingsPatch | undefined,
  memberIds: ReadonlyArray<BotId>,
  current?: BotRoomSettings,
): BotRoomSettings {
  const base: BotRoomSettings = current ?? { ...DEFAULT_ROOM_SETTINGS, lead: memberIds[0] ?? null };
  const merged: BotRoomSettings = {
    mode: patch?.mode ?? base.mode,
    defaultResponder: patch?.defaultResponder ?? base.defaultResponder,
    lead: patch?.lead === undefined ? base.lead : patch.lead,
    allowCrossMentions: patch?.allowCrossMentions ?? base.allowCrossMentions,
    maxWaves: patch?.maxWaves ?? base.maxWaves,
    maxReplies: patch?.maxReplies ?? base.maxReplies,
    memberTimeoutMin: patch?.memberTimeoutMin ?? base.memberTimeoutMin,
    turnDeadlineMin: patch?.turnDeadlineMin ?? base.turnDeadlineMin,
  };
  const lead = merged.lead !== null && memberIds.includes(merged.lead) ? merged.lead : null;
  return { ...merged, lead: lead ?? memberIds[0] ?? null };
}

/**
 * Why a member list can't make a room, or null. Names must be unique inside the room: an
 * `@Name` has to resolve to exactly one member.
 */
export function memberListProblem(
  ids: ReadonlyArray<BotId>,
  bots: ReadonlyArray<{ readonly id: BotId; readonly name: string }>,
): string | null {
  const unique = [...new Set(ids)];
  if (unique.length < BOT_ROOM_MIN_MEMBERS)
    return `A room needs at least ${BOT_ROOM_MIN_MEMBERS} Bots.`;
  if (unique.length > BOT_ROOM_MAX_MEMBERS)
    return `A room holds at most ${BOT_ROOM_MAX_MEMBERS} Bots.`;
  const names = new Set<string>();
  for (const id of unique) {
    const bot = bots.find((candidate) => candidate.id === id);
    if (bot === undefined) return "One of these Bots no longer exists.";
    const key = bot.name.trim().toLowerCase();
    if (names.has(key)) return `Two members are called ${bot.name}; a room needs unique names.`;
    names.add(key);
  }
  return null;
}

/** A member with nothing to add answers exactly `(pass)`; the room never shows it. */
export function isPass(text: string): boolean {
  return /^\(?\s*pass\s*\)?\.?$/i.test(text.trim());
}

/** Cuts long text with an ellipsis; line breaks stay so lists and code keep their shape. */
export function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

function formatRoomLine(line: RoomLine, nameOf: NameOf): string {
  const who = line.author.kind === "user" ? "User" : nameOf(line.author.botId);
  return `${who}: ${clip(line.text, LINE_MAX_CHARS)}`;
}

/**
 * The members a message addresses: the composer's mentions win, then `@Name` in the text, then
 * the room's default responder (the lead, everyone, or nobody).
 */
export function speakersFor(
  room: Pick<BotRoomRecord, "settings">,
  available: ReadonlyArray<BotRoomMember>,
  message: RoomMessage,
  nameOf: NameOf,
): ReadonlyArray<BotRoomMember> {
  const byId = new Map(available.map((member) => [member.botId as string, member]));
  const named = message.mentions.map((mention) => mention.toLowerCase());
  if (named.includes("all") || named.includes("everyone")) return available;
  const explicit = message.mentions.flatMap((id) => byId.get(id) ?? []);
  if (explicit.length > 0) return explicit;
  if (message.mentions.length === 0) {
    const parsed = addressedMembers(
      message.text,
      available.map((member) => ({ id: member.botId, name: nameOf(member.botId) })),
      "anywhere",
    );
    const matched = parsed.ids.flatMap((id) => byId.get(id) ?? []);
    if (matched.length > 0) return matched;
  }
  switch (room.settings.defaultResponder) {
    case "everyone":
      return available;
    case "mentions":
      return [];
    case "lead": {
      const lead = room.settings.lead === null ? undefined : byId.get(room.settings.lead);
      return lead === undefined ? available.slice(0, 1) : [lead];
    }
  }
}

/** Round-robins a roundtable's first speaker by the turn's index, so it survives restarts. */
export function rotateSpeakers<T>(members: ReadonlyArray<T>, by: number): ReadonlyArray<T> {
  if (members.length < 2 || by <= 0) return members;
  const offset = by % members.length;
  return [...members.slice(offset), ...members.slice(0, offset)];
}

/**
 * Members a roundtable wave brings back in: the teammates a reply @mentions, or everyone but the
 * speaker for `@all`.
 */
export function crossMentions(
  replies: ReadonlyArray<{ readonly botId: BotId; readonly text: string }>,
  available: ReadonlyArray<BotRoomMember>,
  nameOf: NameOf,
): ReadonlyArray<BotRoomMember> {
  const roster = available.map((member) => ({ id: member.botId, name: nameOf(member.botId) }));
  const next = new Map<string, BotRoomMember>();
  for (const reply of replies) {
    const { ids } = addressedMembers(reply.text, roster, "anywhere");
    for (const id of ids) {
      const member = available.find((candidate) => candidate.botId === id);
      if (member !== undefined && member.botId !== reply.botId) next.set(member.botId, member);
    }
  }
  return [...next.values()];
}

/** The room lines a member has not seen: after its last turn, newest {@link PROMPT_LINES}. */
export function linesFor(
  member: Pick<BotRoomMember, "lastTurnAt">,
  history: ReadonlyArray<RoomLine>,
  nameOf: NameOf,
): ReadonlyArray<string> {
  const since = Date.parse(member.lastTurnAt ?? "");
  return history
    .filter((line) => !Number.isFinite(since) || (Date.parse(line.at) || 0) > since)
    .slice(-PROMPT_LINES)
    .map((line) => formatRoomLine(line, nameOf));
}

/** The framed prompt: who the Bot is in this room, what was said, and that it's its turn. */
export function promptFor(input: {
  readonly room: Pick<BotRoomRecord, "name" | "description" | "settings" | "members">;
  readonly member: Pick<BotRoomMember, "botId">;
  readonly message: RoomMessage;
  readonly lines: ReadonlyArray<string>;
  readonly nameOf: NameOf;
}): string {
  const { room, member, message, lines, nameOf } = input;
  const self = nameOf(member.botId);
  const others = room.members
    .filter((candidate) => candidate.botId !== member.botId)
    .map((candidate) => nameOf(candidate.botId));
  const header = `[Room "#${room.name}" · with ${others.join(", ") || "the user"}]`;
  const intro =
    `You are ${self}, in a room with the user${others.length > 0 ? ` and ${others.join(", ")}` : ""}. ` +
    "This is a shared conversation, not your private chat: keep private details from your one-to-one chats out of it. " +
    "Your final reply of this turn is the one message the room sees; keep it short. " +
    'If the user addresses you directly, answer briefly even if it is a single line; reply exactly "(pass)" only when the message is for the room in general and you have nothing to add.';
  const mode =
    room.settings.mode === "roundtable"
      ? "Members speak in order and you see what they said before you in this turn. @mention a teammate only when you need their answer: it brings them back in."
      : "Teammates in this room answer independently; they do not see your reply, and mentioning a teammate here does not wake it.";
  const recent = lines.length > 0 ? `Recent room:\n${lines.join("\n")}` : "";
  const asked = `The user's message:\n${message.text.trim()}`;
  return [header, intro, room.description.trim(), mode, recent, asked, `It's your turn, ${self}.`]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** The last non-empty assistant message of a run, in turn-item order when the items say. */
export function pickRunReply(
  records: {
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly runId: string | null;
      readonly role: string;
      readonly text: string;
      readonly updatedAt: DateTime.Utc;
    }>;
    readonly turnItems: ReadonlyArray<{
      readonly type: string;
      readonly runId: string | null;
      readonly ordinal: number;
      readonly messageId?: string | null;
    }>;
  },
  runId: string,
): { readonly id: string; readonly text: string; readonly at: string } | null {
  const messages = records.messages.filter(
    (message) =>
      message.runId === runId && message.role === "assistant" && message.text.trim() !== "",
  );
  const lastItem = records.turnItems
    .filter((item) => item.runId === runId && item.type === "assistant_message")
    .toSorted((left, right) => right.ordinal - left.ordinal)
    .find((item) => messages.some((message) => message.id === item.messageId));
  const message =
    messages.find((candidate) => candidate.id === lastItem?.messageId) ??
    messages.toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    )[0];
  if (message === undefined) return null;
  return {
    id: message.id,
    text: message.text.trim(),
    at: DateTime.formatIso(message.updatedAt),
  };
}

export interface MemberReply {
  readonly id: string;
  readonly turnId: string;
  readonly botId: BotId;
  readonly text: string;
  readonly at: string;
}

/**
 * The room as people read it: each user message, then the members' replies in time order.
 * Passes and empty replies are left out.
 */
export function mergeTranscript(
  turns: ReadonlyArray<Pick<BotRoomTurn, "id" | "at" | "text">>,
  replies: ReadonlyArray<MemberReply>,
): ReadonlyArray<BotRoomTranscriptEntry> {
  const order = new Map(turns.map((turn, index) => [turn.id, index]));
  const entries = [
    ...turns.map((turn) => ({
      entry: { id: `user:${turn.id}`, turnId: turn.id, at: turn.at, text: turn.text },
      user: 0,
    })),
    ...replies
      .filter((reply) => reply.text.trim() !== "" && !isPass(reply.text))
      .map((reply) => ({
        entry: {
          id: reply.id,
          turnId: reply.turnId,
          at: reply.at,
          botId: reply.botId,
          text: reply.text.trim(),
        },
        user: 1,
      })),
  ];
  return entries
    .toSorted(
      (left, right) =>
        (Date.parse(left.entry.at) || 0) - (Date.parse(right.entry.at) || 0) ||
        (order.get(left.entry.turnId) ?? 0) - (order.get(right.entry.turnId) ?? 0) ||
        left.user - right.user,
    )
    .map(({ entry }) => entry);
}

/** The transcript as prompt lines. */
export function transcriptLines(
  entries: ReadonlyArray<BotRoomTranscriptEntry>,
): ReadonlyArray<RoomLine> {
  return entries.map((entry) => ({
    at: entry.at,
    author: entry.botId === undefined ? { kind: "user" } : { kind: "bot", botId: entry.botId },
    text: entry.text,
  }));
}
