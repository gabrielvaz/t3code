import { BotId, type BotRoomMember, type BotRoomRecord, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  crossMentions,
  isPass,
  linesFor,
  memberListProblem,
  mergeTranscript,
  normalizeRoomSettings,
  pickRunReply,
  promptFor,
  rotateSpeakers,
  speakersFor,
} from "./BotRoomLines.ts";

const ana = BotId.make("ana");
const bo = BotId.make("bo");
const cy = BotId.make("cy");
const names: Record<string, string> = { ana: "Ana", bo: "Bo", cy: "Cy" };
const nameOf = (id: BotId) => names[id] ?? id;
const member = (botId: BotId, lastTurnAt: string | null = null): BotRoomMember => ({
  botId,
  threadId: ThreadId.make(`thread:${botId}`),
  lastTurnAt,
  addedAt: "2026-01-01T00:00:00.000Z",
});
const members = [member(ana), member(bo), member(cy)];
const room = (patch: Partial<BotRoomRecord["settings"]> = {}) => ({
  name: "launch",
  description: "Plan the launch.",
  members,
  settings: { ...normalizeRoomSettings(undefined, [ana, bo, cy]), ...patch },
});

describe("room settings", () => {
  it("hands the lead to the first member when the lead leaves", () => {
    const settings = normalizeRoomSettings({ lead: cy }, [ana, bo, cy]);
    expect(settings.lead).toBe(cy);
    expect(normalizeRoomSettings({ maxWaves: 2 }, [ana, bo], settings)).toMatchObject({
      lead: ana,
      maxWaves: 2,
    });
  });

  it("needs 2–8 Bots with unique names", () => {
    const bots = [
      { id: ana, name: "Ana" },
      { id: bo, name: "ana" },
    ];
    expect(memberListProblem([ana], bots)).toContain("at least 2");
    expect(memberListProblem([ana, bo], bots)).toContain("unique names");
    expect(memberListProblem([ana, cy], bots)).toContain("no longer exists");
  });
});

describe("who speaks", () => {
  it("prefers composer mentions, then @Name in the text, then the default responder", () => {
    const text = (value: string, mentions: ReadonlyArray<string> = []) =>
      speakersFor(room(), members, { text: value, mentions }, nameOf).map((entry) => entry.botId);
    expect(text("hello", [bo])).toEqual([bo]);
    expect(text("hello", ["all"])).toEqual([ana, bo, cy]);
    expect(text("@Cy and @Bo, thoughts?")).toEqual([cy, bo]);
    expect(text("hello")).toEqual([ana]);
    expect(
      speakersFor(
        room({ defaultResponder: "everyone" }),
        members,
        { text: "hi", mentions: [] },
        nameOf,
      ),
    ).toHaveLength(3);
    expect(
      speakersFor(
        room({ defaultResponder: "mentions" }),
        members,
        { text: "hi", mentions: [] },
        nameOf,
      ),
    ).toEqual([]);
  });

  it("rotates the first roundtable speaker by the turn index", () => {
    expect(rotateSpeakers([1, 2, 3], 0)).toEqual([1, 2, 3]);
    expect(rotateSpeakers([1, 2, 3], 1)).toEqual([2, 3, 1]);
    expect(rotateSpeakers([1, 2, 3], 5)).toEqual([3, 1, 2]);
  });

  it("brings back teammates a reply mentions, never the speaker itself", () => {
    const next = crossMentions(
      [
        { botId: ana, text: "@Bo can you check? @Ana out" },
        { botId: cy, text: "@all done" },
      ],
      members,
      nameOf,
    );
    expect(next.map((entry) => entry.botId)).toEqual([bo, ana]);
  });
});

describe("prompt framing", () => {
  it("frames the room, the rules and the turn", () => {
    const prompt = promptFor({
      room: room({ mode: "roundtable" }),
      member: member(bo),
      message: { text: "What ships first?", mentions: [] },
      lines: ["User: hi", "Ana: hello"],
      nameOf,
    });
    expect(prompt.startsWith('[Room "#launch" · with Ana, Cy]')).toBe(true);
    expect(prompt).toContain("You are Bo, in a room with the user and Ana, Cy.");
    expect(prompt).toContain("shared conversation, not your private chat");
    expect(prompt).toContain('reply exactly "(pass)"');
    expect(prompt).toContain("Plan the launch.");
    expect(prompt).toContain("Members speak in order");
    expect(prompt).toContain("Recent room:\nUser: hi\nAna: hello");
    expect(prompt).toContain("The user's message:\nWhat ships first?");
    expect(prompt.endsWith("It's your turn, Bo.")).toBe(true);
  });

  it("shows only lines after the member's last turn, capped", () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      at: DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, index))),
      author: { kind: "user" as const },
      text: `line ${index}`,
    }));
    expect(linesFor(member(ana), history, nameOf)).toHaveLength(24);
    const since = linesFor(member(ana, history[37]?.at ?? null), history, nameOf);
    expect(since).toEqual(["User: line 38", "User: line 39"]);
  });
});

describe("transcript", () => {
  it("recognises a pass", () => {
    expect(isPass("(pass)")).toBe(true);
    expect(isPass(" PASS ")).toBe(true);
    expect(isPass("I pass on this one, but…")).toBe(false);
  });

  it("orders replies after their message by time and drops passes", () => {
    const turns = [
      { id: "t1", at: "2026-01-01T10:00:00.000Z", text: "first" },
      { id: "t2", at: "2026-01-01T10:05:00.000Z", text: "second" },
    ];
    const entries = mergeTranscript(turns, [
      { id: "r3", turnId: "t2", botId: ana, text: "late answer", at: "2026-01-01T10:06:00.000Z" },
      { id: "r1", turnId: "t1", botId: bo, text: "(pass)", at: "2026-01-01T10:01:00.000Z" },
      { id: "r2", turnId: "t1", botId: ana, text: " hi ", at: "2026-01-01T10:02:00.000Z" },
      { id: "r4", turnId: "t1", botId: cy, text: "   ", at: "2026-01-01T10:03:00.000Z" },
    ]);
    expect(entries.map((entry) => [entry.id, entry.text])).toEqual([
      ["user:t1", "first"],
      ["r2", "hi"],
      ["user:t2", "second"],
      ["r3", "late answer"],
    ]);
    expect(entries[1]?.botId).toBe(ana);
    expect(entries[0]?.botId).toBeUndefined();
  });

  it("picks a run's last assistant message", () => {
    const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, minute));
    const records = {
      messages: [
        { id: "m1", runId: "run", role: "assistant", text: "thinking aloud", updatedAt: at(1) },
        { id: "m2", runId: "run", role: "assistant", text: "final", updatedAt: at(2) },
        { id: "m3", runId: "other", role: "assistant", text: "elsewhere", updatedAt: at(3) },
      ],
      turnItems: [
        { type: "assistant_message", runId: "run", ordinal: 1, messageId: "m1" },
        { type: "assistant_message", runId: "run", ordinal: 2, messageId: "m2" },
      ],
    };
    expect(pickRunReply(records, "run")).toMatchObject({ id: "m2", text: "final" });
    expect(pickRunReply(records, "missing")).toBeNull();
  });
});
