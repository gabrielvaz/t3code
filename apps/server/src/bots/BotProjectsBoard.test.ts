import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  applyBoardRemove,
  applyBoardSave,
  BOARD_MAX_ACTIVITY,
  type BoardContext,
  BoardInvalid,
  type BoardState,
  boardFind,
  BotProjectsBoard,
  EMPTY_BOARD,
  layer as boardLayer,
} from "./BotProjectsBoard.ts";

const context = (): BoardContext => {
  let next = 0;
  return {
    now: "2026-11-25T12:00:00.000Z",
    newId: (taken) => {
      while (taken.has(`id${++next}`));
      return `id${next}`;
    },
  };
};

const save = (state: BoardState, inputs: ReadonlyArray<unknown>, ctx = context()) =>
  applyBoardSave(state, inputs, ctx);

describe("Projects board store", () => {
  it("saves a batch all or nothing", () => {
    const first = save(EMPTY_BOARD, [{ kind: "project", title: "Launch" }]);
    expect(first.state.version).toBe(1);
    expect(() =>
      save(first.state, [
        { kind: "task", title: "Valid" },
        { kind: "task", title: "Bad status", status: "nope" },
      ]),
    ).toThrow(BoardInvalid);
    // The failed batch left nothing behind, not even its valid first item.
    expect(Object.keys(first.state.items)).toEqual(["id1"]);
    expect(first.state.version).toBe(1);
  });

  it("resolves refs within a batch for parents, machines and item links", () => {
    const { state, event } = save(EMPTY_BOARD, [
      { kind: "project", title: "Launch", ref: "launch" },
      { kind: "machine", title: "Mini", ref: "mini" },
      { kind: "task", title: "Write post", parentId: "ref:launch" },
      {
        kind: "service",
        title: "API",
        machineId: "ref:mini",
        addLinks: [{ type: "item", id: "ref:launch" }],
      },
    ]);
    const byTitle = (title: string) => Object.values(state.items).find((i) => i.title === title)!;
    expect(byTitle("Write post").parentId).toBe(byTitle("Launch").id);
    expect(byTitle("API").machineId).toBe(byTitle("Mini").id);
    expect(byTitle("API").links).toEqual([{ type: "item", id: byTitle("Launch").id }]);
    // Defaults: the first task status, the last machine/service status.
    expect(byTitle("Write post").status).toBe("todo");
    expect(byTitle("Mini").status).toBe("unknown");
    expect(event?.items).toHaveLength(4);
    expect(() => save(state, [{ kind: "task", title: "x", parentId: "ref:missing" }])).toThrow(
      /doesn't name an item/,
    );
    expect(() =>
      save(state, [{ kind: "task", title: "x", machineId: byTitle("Launch").id }]),
    ).toThrow(/must point at a machine/);
  });

  it("refuses unknown fields and cycles, and reports an unchanged save", () => {
    const { state } = save(EMPTY_BOARD, [
      { kind: "project", title: "A", ref: "a" },
      { kind: "project", title: "B", parentId: "ref:a" },
    ]);
    expect(() => save(state, [{ id: "id1", fields: { colour: "red" } }])).toThrow(/Unknown field/);
    expect(() => save(state, [{ id: "id1", parentId: "id2" }])).toThrow(/inside itself/);
    const same = save(state, [{ id: "id1", title: "A" }]);
    expect(same.event).toBeNull();
    expect(same.state).toBe(state);
  });

  it("moves children of a deleted item up to its nearest kept parent", () => {
    const { state } = save(EMPTY_BOARD, [
      { kind: "project", title: "Root", ref: "root" },
      { kind: "project", title: "Middle", ref: "middle", parentId: "ref:root" },
      { kind: "task", title: "Leaf", parentId: "ref:middle" },
      { kind: "note", title: "Ref", addLinks: [{ type: "item", id: "ref:middle" }] },
    ]);
    const removed = applyBoardRemove(state, ["id2"], { now: "2026-11-25T13:00:00.000Z" });
    expect(removed.removed).toEqual(["id2"]);
    expect(removed.state.items.id3?.parentId).toBe("id1");
    expect(removed.state.items.id4?.links).toEqual([]);
    expect(removed.event.items.map((item) => item.id).sort()).toEqual(["id3", "id4"]);
    const both = applyBoardRemove(state, ["id1", "id2"], { now: "2026-11-25T13:00:00.000Z" });
    expect(both.state.items.id3?.parentId).toBeUndefined();
    expect(() => applyBoardRemove(state, ["nope"], { now: "x" })).toThrow(BoardInvalid);
  });

  it("keeps at most the latest activity entries", () => {
    let state = EMPTY_BOARD;
    const ctx = context();
    for (let round = 0; round < 4; round++) {
      state = save(
        state,
        Array.from({ length: 100 }, (_, index) => ({ kind: "note", title: `n${round}-${index}` })),
        ctx,
      ).state;
    }
    expect(state.activity).toHaveLength(BOARD_MAX_ACTIVITY);
    expect(state.activity.at(-1)?.seq).toBe(400);
    expect(state.activity[0]?.seq).toBe(101);
  });

  it("stamps who made a change and marks a finished to-do", () => {
    const created = save(EMPTY_BOARD, [{ kind: "task", title: "Ship" }]);
    const done = applyBoardSave(created.state, [{ id: "id1", status: "done" }], {
      ...context(),
      actor: { type: "bot", name: "Ops", slug: "ops" },
    });
    expect(done.state.items.id1).toMatchObject({
      doneAt: "2026-11-25T12:00:00.000Z",
      updatedBy: { type: "bot", name: "Ops", slug: "ops" },
      createdBy: { type: "user" },
    });
    expect(done.event?.activity[0]?.action).toBe("completed");
    expect(boardFind(Object.values(done.state.items), { open: true }).total).toBe(0);
  });
});

const serviceLayer = (enabled: boolean) =>
  boardLayer.pipe(
    Layer.provide(ServerSettings.layerTest({ botsProjectsBoardEnabled: enabled })),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-board-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

describe("BotProjectsBoard service", () => {
  it.effect("refuses changes while the beta is off", () =>
    Effect.gen(function* () {
      const board = yield* BotProjectsBoard;
      const error = yield* Effect.flip(board.save([{ kind: "task", title: "x" }]));
      expect(error.reason).toBe("disabled");
    }).pipe(Effect.provide(serviceLayer(false))),
  );

  it.effect("persists a save privately and streams the snapshot, then changes", () =>
    Effect.gen(function* () {
      const board = yield* BotProjectsBoard;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      yield* board.save([{ kind: "project", title: "Launch" }]);
      const file = path.join(stateDir, "bots", ".shared", "projects.json");
      expect(JSON.parse(yield* fileSystem.readFileString(file)).version).toBe(1);
      expect(((yield* fileSystem.stat(file)).mode & 0o777).toString(8)).toBe("600");

      const events = yield* board.subscribe().pipe(Stream.take(1), Stream.runCollect);
      expect(events[0]).toMatchObject({
        type: "snapshot",
        version: 1,
        items: [{ title: "Launch" }],
      });
    }).pipe(Effect.provide(serviceLayer(true))),
  );
});
