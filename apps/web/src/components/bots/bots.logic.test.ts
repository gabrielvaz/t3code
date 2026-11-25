import { BotId, EnvironmentId, ProjectId, ThreadId, type Bot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentBot } from "../../state/bots";
import {
  botThreadKeys,
  isBotConflictError,
  parseBotRuleList,
  sortBotsForSidebar,
  withoutBotThreads,
} from "./bots.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

function bot(id: string, overrides: Partial<Bot> = {}): Bot {
  return {
    id: BotId.make(id),
    slug: id,
    name: id,
    role: "",
    avatar: { kind: "ball", color: "teal" },
    projectId: ProjectId.make(`project-${id}`),
    threadId: ThreadId.make(`thread-${id}`),
    model: null,
    runtimeMode: "auto",
    pinned: false,
    order: 0,
    primary: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryTidy: "off",
    memoryTidyTaskId: null,
    ...overrides,
  };
}

const entry = (environmentId: EnvironmentId, value: Bot): EnvironmentBot => ({
  environmentId,
  bot: value,
});

describe("withoutBotThreads", () => {
  const thread = (environmentId: EnvironmentId, id: string) => ({
    environmentId,
    id: ThreadId.make(id),
  });

  it("moves each Bot's thread out of the shelves, matching its environment", () => {
    const keys = botThreadKeys([
      entry(local, bot("scout")),
      entry(local, bot("pending", { threadId: null })),
    ]);
    const threads = [
      thread(local, "thread-scout"),
      thread(remote, "thread-scout"),
      thread(local, "other"),
    ];
    expect(withoutBotThreads(threads, keys)).toEqual([
      thread(remote, "thread-scout"),
      thread(local, "other"),
    ]);
  });

  it("keeps the same list when no Bot thread is listed, so memoized rows survive", () => {
    const threads = [thread(local, "other")];
    expect(withoutBotThreads(threads, new Set())).toBe(threads);
    expect(withoutBotThreads(threads, botThreadKeys([entry(local, bot("scout"))]))).toBe(threads);
  });
});

describe("sortBotsForSidebar", () => {
  it("lists pinned Bots first, then by saved order, then oldest first", () => {
    const sorted = sortBotsForSidebar([
      entry(local, bot("late", { createdAt: "2026-03-01T00:00:00.000Z" })),
      entry(local, bot("early", { createdAt: "2026-02-01T00:00:00.000Z" })),
      entry(local, bot("ordered", { order: -1, createdAt: "2026-04-01T00:00:00.000Z" })),
      entry(remote, bot("pinned", { pinned: true, order: 5 })),
    ]);
    expect(sorted.map(({ bot: value }) => value.id)).toEqual([
      "pinned",
      "ordered",
      "early",
      "late",
    ]);
  });
});

describe("parseBotRuleList", () => {
  it("keeps one trimmed rule per non-empty line", () => {
    expect(parseBotRuleList("  Send email \n\n Spend money\n   ")).toEqual([
      "Send email",
      "Spend money",
    ]);
  });
});

describe("isBotConflictError", () => {
  it("recognizes a save that lost a race by its tag", () => {
    expect(isBotConflictError({ _tag: "BotConflictError", currentText: "", revision: "r" })).toBe(
      true,
    );
    expect(isBotConflictError({ _tag: "BotStorageError" })).toBe(false);
    expect(isBotConflictError(null)).toBe(false);
  });
});
