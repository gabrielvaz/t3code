import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotRooms from "./BotRooms.ts";
import * as BotService from "./BotService.ts";

const mainModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
const bot = (id: string, name: string): Bot => ({
  id: BotId.make(id),
  slug: id,
  name,
  role: "",
  avatar: { kind: "ball", color: "teal" },
  projectId: ProjectId.make(`project:${id}`),
  threadId: ThreadId.make(`main:${id}`),
  model: null,
  runtimeMode: "auto",
  pinned: false,
  order: 0,
  primary: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  memoryTidy: "off",
  memoryTidyTaskId: null,
  executorApproval: "ask",
});
const ana = bot("ana", "Ana");
const bo = bot("bo", "Bo");
/** What each member answers, by Bot id. */
const answers: Record<string, string> = { ana: "Ship the API first.", bo: "(pass)" };

const harness = () => {
  const calls = {
    launched: [] as Array<ThreadLaunchService.ThreadLaunchInput>,
    dispatched: [] as Array<OrchestrationV2ServerCommand>,
    sent: [] as Array<ThreadManagementService.ThreadManagementSendInput>,
  };
  // Every run the fake threads hold: id → thread, answer and when it ended.
  const runs = new Map<string, { threadId: string; text: string; at: number }>();
  const layer = BotRooms.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(BotService.BotService)({
          list: Effect.sync(() => ({
            bots: [ana, bo],
            settings: {
              userName: "",
              timezone: "",
              alwaysAsk: [],
              allowWithoutAsking: [],
              mainBotId: null,
            },
          })),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              calls.launched.push(input);
              return {
                threadId: ThreadId.make(`room:${input.projectId}`),
                projection: {} as never,
                resumed: false,
              };
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed({
              id: threadId,
              modelSelection: mainModel,
              runtimeMode: "full-access",
            } as never),
          dispatch: (command) =>
            Effect.sync(() => {
              calls.dispatched.push(command);
              return {} as never;
            }),
          sendToThread: (input) =>
            Effect.gen(function* () {
              calls.sent.push(input);
              const runId = `run-${calls.sent.length}`;
              const owner = input.threadId.replace("room:project:", "");
              // A reply lands a moment after the message it answers.
              const at = (yield* Clock.currentTimeMillis) + 1;
              runs.set(runId, { threadId: input.threadId, text: answers[owner] ?? "", at });
              return { run: { id: RunId.make(runId) } } as never;
            }),
          waitForThread: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              run: { id: input.runId, status: "completed" } as never,
              timedOut: false,
            }),
          getThreadRecords: ((
            threadId: ThreadId,
            _fields: unknown,
            filter?: { runIds?: string[]; messageRunIds?: string[] },
          ) =>
            Effect.sync(() => {
              const ids = filter?.runIds ?? filter?.messageRunIds ?? [];
              const owned = ids.flatMap((id) => {
                const run = runs.get(id);
                return run !== undefined && run.threadId === threadId ? [{ id, ...run }] : [];
              });
              return {
                runs: owned.map((run) => ({ id: run.id, status: "completed" })),
                messages: owned.map((run) => ({
                  id: `message-${run.id}`,
                  runId: run.id,
                  role: "assistant",
                  text: run.text,
                  updatedAt: DateTime.makeUnsafe(run.at),
                })),
                turnItems: [],
              };
            })) as never,
        }),
        ServerSettings.layerTest(),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bot-rooms-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { calls, layer };
};

/** The turn engine runs in the background; wait for the room to go quiet. */
const idle = (rooms: BotRooms.BotRooms["Service"]) =>
  rooms.subscribe().pipe(
    Stream.filter((snapshot) => snapshot.statuses.every((status) => status.turnId === null)),
    Stream.runHead,
  );

describe("BotRooms", () => {
  it.effect(
    "launches a thread per member, then dispatches each message to the right members",
    () => {
      const { calls, layer } = harness();
      return Effect.gen(function* () {
        const rooms = yield* BotRooms.BotRooms;
        const room = yield* rooms.create({ name: "launch", memberIds: [ana.id, bo.id] });

        expect(calls.launched).toMatchObject([
          {
            projectId: ana.projectId,
            title: "#launch",
            modelSelection: mainModel,
            runtimeMode: "full-access",
          },
          {
            projectId: bo.projectId,
            title: "#launch",
            modelSelection: mainModel,
            runtimeMode: "full-access",
          },
        ]);
        expect(calls.dispatched).toMatchObject([
          { type: "thread.auto-settle.set", threadId: "room:project:ana", enabled: false },
          { type: "thread.auto-settle.set", threadId: "room:project:bo", enabled: false },
        ]);
        expect(room.members.map((member) => member.threadId)).toEqual([
          "room:project:ana",
          "room:project:bo",
        ]);
        expect(room.settings.lead).toBe(ana.id);

        const { stateDir } = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stored = yield* fileSystem.stat(path.join(stateDir, "bots", ".shared", "rooms.json"));
        expect(stored.mode & 0o777).toBe(0o600);

        // Nobody named: only the lead answers.
        yield* rooms.send({ id: room.id, text: "What ships first?" });
        yield* idle(rooms);
        yield* TestClock.adjust("1 minute");
        expect(calls.sent.map((sent) => sent.threadId)).toEqual(["room:project:ana"]);
        const first = calls.sent[0];
        assert(first !== undefined);
        expect(first).toMatchObject({ mode: "queue", projectId: ana.projectId });
        expect(first.text).toContain('[Room "#launch" · with Bo]');
        expect(first.text).toContain("The user's message:\nWhat ships first?");
        expect(first.text.endsWith("It's your turn, Ana.")).toBe(true);

        // @Bo in the text addresses Bo alone, who sees what Ana said.
        yield* rooms.send({ id: room.id, text: "@Bo do you agree?" });
        yield* idle(rooms);
        yield* TestClock.adjust("1 minute");
        expect(calls.sent.map((sent) => sent.threadId)).toEqual([
          "room:project:ana",
          "room:project:bo",
        ]);
        expect(calls.sent[1]?.text).toContain("Ana: Ship the API first.");

        // The composer's @all reaches everyone.
        yield* rooms.send({ id: room.id, text: "Anything else?", mentions: ["all"] });
        const snapshot = yield* idle(rooms);
        assert(snapshot._tag === "Some");
        expect(snapshot.value.statuses[0]?.members).toEqual(
          expect.arrayContaining([
            { botId: ana.id, state: "replied" },
            { botId: bo.id, state: "passed" },
          ]),
        );
        expect(calls.sent).toHaveLength(4);

        const transcript = yield* rooms.transcript({ id: room.id });
        expect(transcript.entries.map((entry) => [entry.botId ?? "user", entry.text])).toEqual([
          ["user", "What ships first?"],
          ["ana", "Ship the API first."],
          ["user", "@Bo do you agree?"],
          ["user", "Anything else?"],
          ["ana", "Ship the API first."],
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("deletes the member threads with the room", () => {
    const { calls, layer } = harness();
    return Effect.gen(function* () {
      const rooms = yield* BotRooms.BotRooms;
      const room = yield* rooms.create({ name: "temp", memberIds: [ana.id, bo.id] });
      yield* rooms.delete(room.id);
      expect(calls.dispatched.filter((command) => command.type === "thread.delete")).toMatchObject([
        { threadId: "room:project:ana" },
        { threadId: "room:project:bo" },
      ]);
      const missing = yield* rooms.transcript({ id: room.id }).pipe(Effect.flip);
      expect(missing._tag).toBe("BotRoomNotFoundError");
    }).pipe(Effect.provide(layer));
  });
});
