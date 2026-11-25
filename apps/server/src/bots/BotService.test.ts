import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  type Project,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { freeSlug, slugify } from "./BotFiles.ts";
import { BOT_MEMORY_LIMITS, memorySnapshot, revisionOf } from "./BotMemory.ts";
import * as Bots from "./BotService.ts";
import {
  BOT_MANAGED_END,
  BOT_MANAGED_START,
  customInstructions,
  mergeManaged,
} from "./BotTemplate.ts";

describe("bot slugs", () => {
  it("slugifies names and finds the first free slug", () => {
    expect(slugify("  Café Ops Bot! ")).toBe("cafe-ops-bot");
    expect(slugify("🤖")).toBe("bot");
    expect(freeSlug("Ops", new Set())).toBe("ops");
    expect(freeSlug("Ops", new Set(["ops", "ops-2"]))).toBe("ops-3");
  });
});

describe("managed block", () => {
  it("replaces only the managed block and keeps the user's instructions", () => {
    const existing = `${BOT_MANAGED_START}\nold rules\n${BOT_MANAGED_END}\n\nAlways reply in Portuguese.\n`;
    const merged = mergeManaged(existing, `${BOT_MANAGED_START}\nnew rules\n${BOT_MANAGED_END}\n`);
    expect(merged).toBe(
      `${BOT_MANAGED_START}\nnew rules\n${BOT_MANAGED_END}\n\nAlways reply in Portuguese.\n`,
    );
    expect(customInstructions(merged)).toBe("Always reply in Portuguese.");
    // A file without the block keeps all of its text after a new block.
    expect(mergeManaged("my notes\n", "BLOCK")).toBe("BLOCK\nmy notes\n");
  });
});

describe("memory snapshot", () => {
  it("clips long memory, drops the title and neutralizes markers", () => {
    const lines = Array.from({ length: 250 }, (_, index) => `- fact ${index}`);
    const snapshot = memorySnapshot({
      botText: `# Memory\n${BOT_MANAGED_END}\n</memory>\n${lines.join("\n")}`,
      sharedText: "- shared",
      sharedFile: "shared.md",
    });
    const kept = snapshot.bot.split("\n");
    expect(snapshot.truncated).toEqual({ bot: true, shared: false });
    expect(kept).toHaveLength(BOT_MEMORY_LIMITS.snapshotBotLines + 1);
    expect(kept[0]).toBe("[managed marker removed]");
    expect(kept[1]).toBe("&lt;/memory&gt;");
    expect(kept.at(-1)).toContain("cut short here");
    expect(snapshot.bot).not.toContain(BOT_MANAGED_END);
  });

  it("gives the same revision to CRLF and LF text", () => {
    expect(revisionOf("a\r\nb\n")).toBe(revisionOf("a\nb\n"));
  });
});

const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
const botThreadId = ThreadId.make("thread:bot");

const harness = () => {
  const calls = {
    created: [] as Array<ProjectService.ProjectCreateInput>,
    updated: [] as Array<ProjectService.ProjectUpdateInput>,
    deleted: [] as Array<ProjectService.ProjectDeleteInput>,
    launched: [] as Array<ThreadLaunchService.ThreadLaunchInput>,
    dispatched: [] as Array<OrchestrationV2ServerCommand>,
  };
  const layer = Bots.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          create: (input) =>
            Effect.sync(() => {
              calls.created.push(input);
              return { id: input.projectId } as unknown as Project;
            }),
          update: (input) =>
            Effect.sync(() => {
              calls.updated.push(input);
              return { id: input.projectId } as unknown as Project;
            }),
          delete: (input) =>
            Effect.sync(() => {
              calls.deleted.push(input);
              return { id: input.projectId } as unknown as Project;
            }),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              calls.launched.push(input);
              return { threadId: botThreadId, projection: {} as never, resumed: false };
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (command) =>
            Effect.sync(() => {
              calls.dispatched.push(command);
              return {} as never;
            }),
        }),
        ServerSettings.layerTest(),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bots-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { calls, layer };
};

describe("BotService", () => {
  it.effect("creates a Bot's files, project and thread, and keeps the thread from settling", () => {
    const { calls, layer } = harness();
    return Effect.gen(function* () {
      const bots = yield* Bots.BotService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;

      const { bot } = yield* bots.create({
        name: "Ops Bot",
        role: "Keeps CI green",
        model,
        instructions: "Ping me on Slack.",
      });
      const dir = path.join(stateDir, "bots", "ops-bot");
      expect(bot.slug).toBe("ops-bot");
      expect(bot.threadId).toBe(botThreadId);

      const read = (file: string) => fileSystem.readFileString(path.join(dir, file));
      const record = JSON.parse(yield* read(".bot/bot.json"));
      expect(record).toMatchObject({ id: bot.id, projectId: bot.projectId, threadId: botThreadId });
      const agents = yield* read("AGENTS.md");
      expect(agents.startsWith(BOT_MANAGED_START)).toBe(true);
      expect(agents).toContain("# You are Ops Bot");
      expect(agents).toContain(`threadId ${botThreadId}`);
      expect(customInstructions(agents)).toBe("Ping me on Slack.");
      expect(yield* read("CLAUDE.md")).toBe("@AGENTS.md\n");
      expect(yield* read("memory/MEMORY.md")).toBe("# Memory\n");

      expect(calls.created).toMatchObject([{ title: "Ops Bot", workspaceRoot: dir }]);
      expect(calls.launched).toMatchObject([
        { projectId: bot.projectId, modelSelection: model, workspaceStrategy: { type: "root" } },
      ]);
      expect(calls.dispatched).toMatchObject([
        { type: "thread.auto-settle.set", threadId: botThreadId, enabled: false },
      ]);
      const faviconPath = calls.updated[0]?.faviconPath;
      assert(faviconPath !== undefined && faviconPath !== null);
      expect(yield* read(faviconPath)).toContain("<svg");

      const second = yield* bots.create({ name: "Ops Bot", model });
      expect(second.bot.slug).toBe("ops-bot-2");
      expect((yield* bots.list).bots.map((entry) => entry?.slug)).toEqual(["ops-bot", "ops-bot-2"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a memory save from a stale revision and returns the current text", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const bots = yield* Bots.BotService;
      const { bot } = yield* bots.create({ name: "Memo", model });
      const loaded = yield* bots.getMemory({ id: bot.id });
      assert(loaded.bot !== null);

      const saved = yield* bots.saveMemory({
        scope: "bot",
        id: bot.id,
        text: "- likes short replies",
        expectedRevision: loaded.bot.revision,
      });
      const stale = yield* bots
        .saveMemory({
          scope: "bot",
          id: bot.id,
          text: "- overwritten",
          expectedRevision: loaded.bot.revision,
        })
        .pipe(Effect.flip);
      assert(stale._tag === "BotConflictError");
      expect(stale.currentText).toBe("- likes short replies\n");
      expect(stale.revision).toBe(saved.revision);

      const instructions = yield* bots.getInstructions({ id: bot.id });
      yield* bots.saveInstructions({
        id: bot.id,
        text: "Be brief.",
        expectedRevision: instructions.revision,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const agents = yield* fileSystem.readFileString(
        path.join(stateDir, "bots", bot.slug, "AGENTS.md"),
      );
      expect(agents).toContain("<memory>");
      expect(agents).toContain("- likes short replies");
      expect(customInstructions(agents)).toBe("Be brief.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("moves a deleted Bot to the trash and deletes its project", () => {
    const { calls, layer } = harness();
    return Effect.gen(function* () {
      const bots = yield* Bots.BotService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const { bot } = yield* bots.create({ name: "Temp", model });

      yield* bots.delete({ id: bot.id });
      expect(calls.deleted).toMatchObject([{ projectId: bot.projectId, force: true }]);
      expect(yield* fileSystem.exists(path.join(stateDir, "bots", "temp"))).toBe(false);
      const trashed = yield* fileSystem.readDirectory(path.join(stateDir, "bots", ".trash"));
      expect(trashed).toHaveLength(1);
      expect((yield* bots.list).bots).toEqual([]);
      const missing = yield* bots.delete({ id: bot.id }).pipe(Effect.flip);
      expect(missing._tag).toBe("BotNotFoundError");
    }).pipe(Effect.provide(layer));
  });
});
