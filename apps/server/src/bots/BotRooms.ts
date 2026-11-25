// Rooms: group chats between the user and 2–8 Bots. The store keeps what T3 does not keep for a
// group (membership, settings, the user's messages); each member answers in its own T3 thread,
// and the transcript is read back from those threads. Turn engine ported from Threebot
// server/rooms.mts, server/rooms-threads.mts and server/room-turn.mts (MIT, Copyright (c) 2026
// Threebot contributors).
import {
  type Bot,
  type BotId,
  BotInvalidError,
  type BotRoom,
  type BotRoomCreateInput,
  BotRoomId,
  type BotRoomMember,
  type BotRoomMemberState,
  BotRoomNotFoundError,
  BotRoomRecord,
  type BotRoomRun,
  type BotRoomSendInput,
  type BotRoomSendResult,
  type BotRoomsSnapshot,
  type BotRoomStatus,
  type BotRoomTranscriptEntry,
  type BotRoomTranscriptInput,
  type BotRoomTranscriptResult,
  type BotRoomTurn,
  type BotRoomTurnStatus,
  type BotRoomUpdateInput,
  BOT_ROOM_TRANSCRIPT_MAX_TURNS,
  BotStorageError,
  CommandId,
  MessageId,
  type ModelSelection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotService from "./BotService.ts";
import { readTextIfExists, writeTextAtomic } from "./BotFiles.ts";
import {
  clip,
  crossMentions,
  isPass,
  linesFor,
  type MemberReply,
  memberListProblem,
  mergeTranscript,
  normalizeRoomSettings,
  pickRunReply,
  promptFor,
  type RoomMessage,
  rotateSpeakers,
  speakersFor,
  transcriptLines,
} from "./BotRoomLines.ts";

export type BotRoomsError = BotRoomNotFoundError | BotInvalidError | BotStorageError;

export class BotRooms extends Context.Service<
  BotRooms,
  {
    /** Every room and its live status now, then again after every change. */
    readonly subscribe: () => Stream.Stream<BotRoomsSnapshot>;
    readonly create: (input: BotRoomCreateInput) => Effect.Effect<BotRoom, BotRoomsError>;
    readonly update: (input: BotRoomUpdateInput) => Effect.Effect<BotRoom, BotRoomsError>;
    readonly delete: (id: BotRoomId) => Effect.Effect<BotRoomId, BotRoomsError>;
    readonly send: (input: BotRoomSendInput) => Effect.Effect<BotRoomSendResult, BotRoomsError>;
    readonly stop: (id: BotRoomId) => Effect.Effect<boolean, BotRoomsError>;
    /** Forgets the room's messages; every member starts a new provider session next time. */
    readonly reset: (id: BotRoomId) => Effect.Effect<BotRoom, BotRoomsError>;
    readonly transcript: (
      input: BotRoomTranscriptInput,
    ) => Effect.Effect<BotRoomTranscriptResult, BotRoomsError>;
  }
>()("t3/bots/BotRooms") {}

const RoomsFile = Schema.Struct({ version: Schema.Literal(1), rooms: Schema.Array(BotRoomRecord) });
const decodeRoomsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(RoomsFile));
const encodeRoomsFile = Schema.encodeEffect(Schema.fromJsonString(RoomsFile));

const MAX_STORED_TURNS = 200;
const DEFAULT_TRANSCRIPT_TURNS = 50;

const storage = (cause: unknown) => new BotStorageError({ operation: "rooms", cause });

interface QueuedMessage {
  readonly turnId: string;
  readonly message: RoomMessage;
}

/** What only this process knows about a room: the turn in flight and how members are doing. */
interface RoomLive {
  readonly turnId: string | null;
  readonly fiber: Fiber.Fiber<void> | null;
  readonly threads: ReadonlySet<ThreadId>;
  readonly queue: ReadonlyArray<QueuedMessage>;
  readonly members: ReadonlyMap<BotId, BotRoomMemberState>;
  readonly revision: number;
}

const IDLE: RoomLive = {
  turnId: null,
  fiber: null,
  threads: new Set(),
  queue: [],
  members: new Map(),
  revision: 0,
};

function summary(room: BotRoomRecord): BotRoom {
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    settings: room.settings,
    members: room.members,
    formerMembers: room.formerMembers,
    lastMessageAt: room.turns.at(-1)?.at ?? null,
  };
}

const memberThreadIds = (room: BotRoomRecord): ReadonlyArray<ThreadId> => [
  ...new Set([...room.members, ...room.formerMembers].flatMap((member) => member.threadId ?? [])),
];

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const bots = yield* BotService.BotService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const layerScope = yield* Effect.scope;

  const file = path.join(config.stateDir, "bots", ".shared", "rooms.json");
  const lock = yield* Semaphore.make(1);
  const records = yield* Ref.make<ReadonlyArray<BotRoomRecord>>([]);
  const live = yield* Ref.make<ReadonlyMap<BotRoomId, RoomLive>>(new Map());
  // Subscribers rebuild the whole snapshot, so they need only the newest dirty signal.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const io = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = random.uuidV4().pipe(Effect.mapError(storage));
  const commandId = (prefix: string) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`${prefix}:${id}`)));

  const save = Effect.fn("BotRooms.save")(
    function* (next: ReadonlyArray<BotRoomRecord>) {
      const text = yield* encodeRoomsFile({ version: 1, rooms: next });
      yield* io(writeTextAtomic(file, `${text}\n`));
      yield* fileSystem.chmod(file, 0o600).pipe(Effect.ignore);
      yield* Ref.set(records, next);
    },
    Effect.mapError(storage),
    Effect.uninterruptible,
  );

  const findRoom = (id: BotRoomId) =>
    Ref.get(records).pipe(
      Effect.flatMap((rooms) => {
        const room = rooms.find((candidate) => candidate.id === id);
        return room === undefined
          ? Effect.fail(new BotRoomNotFoundError({ id }))
          : Effect.succeed(room);
      }),
    );

  /** Every write goes through one permit and replaces the cache only once the file is saved. */
  const updateRoom = (id: BotRoomId, change: (room: BotRoomRecord) => BotRoomRecord) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const rooms = yield* Ref.get(records);
        const room = rooms.find((candidate) => candidate.id === id);
        if (room === undefined) return yield* new BotRoomNotFoundError({ id });
        const next = change(room);
        yield* save(rooms.map((candidate) => (candidate.id === id ? next : candidate)));
        return next;
      }),
    );

  /** Turn bookkeeping: a room deleted mid-turn, or a failed write, must not end the turn. */
  const record = (
    id: BotRoomId,
    change: (room: BotRoomRecord) => BotRoomRecord,
  ): Effect.Effect<void> =>
    updateRoom(id, change).pipe(
      Effect.asVoid,
      Effect.catchTags({ BotRoomNotFoundError: () => Effect.void }),
      Effect.catchCause((cause) =>
        Effect.logWarning("A room's record could not be saved.", Cause.pretty(cause)),
      ),
    );

  const patchTurn = (id: BotRoomId, turnId: string, patch: Partial<BotRoomTurn>) =>
    record(id, (room) => ({
      ...room,
      turns: room.turns.map((turn) => (turn.id === turnId ? { ...turn, ...patch } : turn)),
    }));

  const patchMember = (id: BotRoomId, botId: BotId, patch: Partial<BotRoomMember>) =>
    record(id, (room) => ({
      ...room,
      members: room.members.map((member) =>
        member.botId === botId ? { ...member, ...patch } : member,
      ),
    }));

  const updateLive = (id: BotRoomId, change: (state: RoomLive) => RoomLive) =>
    Ref.update(live, (map) => new Map(map).set(id, change(map.get(id) ?? IDLE))).pipe(
      Effect.andThen(notifyChanged),
    );
  const setMemberState = (id: BotRoomId, botId: BotId, state: BotRoomMemberState) =>
    updateLive(id, (current) => ({
      ...current,
      members: new Map(current.members).set(botId, state),
    }));
  const bumpRevision = (id: BotRoomId) =>
    updateLive(id, (current) => ({ ...current, revision: current.revision + 1 }));

  const snapshot = Effect.gen(function* () {
    const [rooms, states] = yield* Effect.all([Ref.get(records), Ref.get(live)]);
    return {
      rooms: rooms.map(summary),
      statuses: rooms.map((room): BotRoomStatus => {
        const state = states.get(room.id) ?? IDLE;
        return {
          roomId: room.id,
          turnId: state.turnId,
          queued: state.queue.length,
          members: [...state.members].map(([botId, memberState]) => ({
            botId,
            state: memberState,
          })),
          revision: state.revision,
        };
      }),
    } satisfies BotRoomsSnapshot;
  });

  const subscribe: BotRooms["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change during the first read is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot)),
        );
      }),
    );

  const botsById = bots.list.pipe(
    Effect.map(({ bots: list }) => new Map(list.map((bot) => [bot.id, bot]))),
  );

  const defaultModel = serverSettings.getSettings.pipe(
    Effect.map((current) => resolveProjectSettings(current, null).settings.defaultModelSelection),
    Effect.orElseSucceed((): ModelSelection | null => null),
  );

  /**
   * Launches the member's room thread in its Bot's project. It takes the Bot's own model and
   * runtime mode from its main thread: a room never changes what a Bot may do without asking.
   */
  const launchMember = Effect.fn("BotRooms.launchMember")(function* (
    room: Pick<BotRoomRecord, "id" | "name">,
    bot: Bot,
  ) {
    if (bot.projectId === null) {
      return yield* new BotInvalidError({ detail: `${bot.name} has no project yet.` });
    }
    const shell =
      bot.threadId === null
        ? null
        : yield* threads.getThreadShell(bot.threadId).pipe(Effect.orElseSucceed(() => null));
    const modelSelection = shell?.modelSelection ?? bot.model ?? (yield* defaultModel);
    if (modelSelection === null) {
      return yield* new BotInvalidError({ detail: `Choose a model for ${bot.name} first.` });
    }
    const launched = yield* threadLaunch
      .launch({
        // One thread per member per room, even when a reply is lost and the launch is retried.
        commandId: CommandId.make(`bot-room-thread:${room.id}:${bot.id}`),
        projectId: bot.projectId,
        title: `#${room.name}`,
        titleRenamed: true,
        modelSelection,
        runtimeMode: shell?.runtimeMode ?? bot.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.catchTags({
          ThreadManagementProviderInstanceDisabledError: (error) =>
            Effect.fail(new BotInvalidError({ detail: error.message })),
          ThreadLaunchError: (error) => Effect.fail(storage(error)),
        }),
      );
    // Room threads are long-lived and live under their room, not in the sidebar's shelves.
    yield* threads
      .dispatch({
        type: "thread.auto-settle.set",
        commandId: CommandId.make(`bot-room-auto-settle:${room.id}:${bot.id}`),
        threadId: launched.threadId,
        enabled: false,
      })
      .pipe(Effect.ignoreCause({ log: true }));
    return launched.threadId;
  });

  /** Launches a thread for every member that has none and stores it. */
  const launchMissing = Effect.fn("BotRooms.launchMissing")(function* (room: BotRoomRecord) {
    const roster = yield* botsById;
    const launched = new Map<BotId, ThreadId>();
    for (const member of room.members) {
      if (member.threadId !== null) continue;
      const bot = roster.get(member.botId);
      if (bot === undefined) continue;
      launched.set(member.botId, yield* launchMember(room, bot));
    }
    if (launched.size === 0) return room;
    return yield* updateRoom(room.id, (current) => ({
      ...current,
      members: current.members.map((member) => {
        const threadId = launched.get(member.botId);
        return threadId === undefined ? member : { ...member, threadId };
      }),
    }));
  });

  const validateMembers = Effect.fn("BotRooms.validateMembers")(function* (
    ids: ReadonlyArray<BotId>,
  ) {
    const roster = yield* botsById;
    const problem = memberListProblem(ids, [...roster.values()]);
    if (problem !== null) return yield* new BotInvalidError({ detail: problem });
    return [...new Set(ids)];
  });

  const nameTaken = (name: string, except?: BotRoomId) =>
    Ref.get(records).pipe(
      Effect.map((rooms) =>
        rooms.some((room) => room.id !== except && room.name.toLowerCase() === name.toLowerCase()),
      ),
    );

  const create: BotRooms["Service"]["create"] = Effect.fn("BotRooms.create")(function* (input) {
    const memberIds = yield* validateMembers(input.memberIds);
    if (yield* nameTaken(input.name)) {
      return yield* new BotInvalidError({ detail: "A room with that name already exists." });
    }
    const now = yield* nowIso;
    const id = BotRoomId.make(yield* random.uuidV7().pipe(Effect.mapError(storage)));
    const room: BotRoomRecord = {
      id,
      name: input.name,
      description: input.description?.trim() ?? "",
      createdAt: now,
      updatedAt: now,
      settings: normalizeRoomSettings(input.settings, memberIds),
      members: memberIds.map((botId) => ({
        botId,
        threadId: null,
        lastTurnAt: null,
        addedAt: now,
      })),
      formerMembers: [],
      turns: [],
    };
    yield* lock.withPermits(1)(
      Ref.get(records).pipe(Effect.flatMap((rooms) => save([...rooms, room]))),
    );
    yield* notifyChanged;
    const launched = yield* launchMissing(room);
    yield* notifyChanged;
    return summary(launched);
  });

  const update: BotRooms["Service"]["update"] = Effect.fn("BotRooms.update")(function* (input) {
    const current = yield* findRoom(input.id);
    const memberIds =
      input.memberIds === undefined ? undefined : yield* validateMembers(input.memberIds);
    if (input.name !== undefined && (yield* nameTaken(input.name, input.id))) {
      return yield* new BotInvalidError({ detail: "A room with that name already exists." });
    }
    const now = yield* nowIso;
    const updated = yield* updateRoom(input.id, (room) => {
      let members = room.members;
      let formerMembers = room.formerMembers;
      if (memberIds !== undefined) {
        const kept = new Set<BotId>(memberIds);
        members = memberIds.map((botId) => {
          const existing =
            room.members.find((member) => member.botId === botId) ??
            // Re-adding a member keeps its thread and history instead of launching another.
            room.formerMembers.find((member) => member.botId === botId);
          return existing ?? { botId, threadId: null, lastTurnAt: null, addedAt: now };
        });
        formerMembers = [
          ...room.formerMembers.filter((member) => !kept.has(member.botId)),
          ...room.members.filter((member) => !kept.has(member.botId)),
        ];
      }
      return {
        ...room,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
        members,
        formerMembers,
        settings: normalizeRoomSettings(
          input.settings,
          members.map((member) => member.botId),
          room.settings,
        ),
        updatedAt: now,
      };
    });
    yield* notifyChanged;
    if (input.name !== undefined && input.name !== current.name) {
      yield* Effect.forEach(
        memberThreadIds(updated),
        (threadId) =>
          commandId("bot-room-title").pipe(
            Effect.flatMap((id) =>
              threads.dispatch({
                type: "thread.metadata.update",
                commandId: id,
                threadId,
                title: `#${updated.name}`,
              }),
            ),
            Effect.ignoreCause({ log: true }),
          ),
        { discard: true },
      );
    }
    const launched = yield* launchMissing(updated);
    yield* notifyChanged;
    return summary(launched);
  });

  /** Ends the room's turn in flight and drops its queue. */
  const stop: BotRooms["Service"]["stop"] = Effect.fn("BotRooms.stop")(function* (id) {
    yield* findRoom(id);
    const taken = yield* Ref.modify(live, (map) => {
      const state = map.get(id) ?? IDLE;
      const next: RoomLive = {
        ...state,
        turnId: null,
        fiber: null,
        threads: new Set(),
        queue: [],
        members: new Map(
          [...state.members].map(([botId, memberState]) => [
            botId,
            memberState === "thinking" || memberState === "waiting" ? "stopped" : memberState,
          ]),
        ),
        revision: state.revision + 1,
      };
      return [state, new Map(map).set(id, next)];
    });
    const queuedIds = new Set(taken.queue.map((entry) => entry.turnId));
    if (taken.fiber !== null) yield* Fiber.interrupt(taken.fiber);
    yield* Effect.forEach(
      taken.threads,
      (threadId) =>
        commandId("bot-room-stop").pipe(
          Effect.flatMap((stopId) =>
            threads.dispatch({
              type: "thread.stop",
              commandId: stopId,
              threadId,
              stopDelegatedTasks: true,
            }),
          ),
          Effect.ignoreCause({ log: true }),
        ),
      { discard: true, concurrency: "unbounded" },
    );
    const at = yield* nowIso;
    yield* record(id, (room) => ({
      ...room,
      turns: room.turns.map((turn) => {
        if (queuedIds.has(turn.id)) return { ...turn, status: "stopped" };
        if (turn.id !== taken.turnId || (turn.status !== "running" && turn.status !== "queued"))
          return turn;
        return {
          ...turn,
          status: "stopped",
          runs: turn.runs.map((run) =>
            run.status === undefined ? { ...run, status: "stopped", at } : run,
          ),
        };
      }),
    }));
    yield* notifyChanged;
    return taken.turnId !== null || queuedIds.size > 0;
  });

  const deleteRoom: BotRooms["Service"]["delete"] = Effect.fn("BotRooms.delete")(function* (id) {
    yield* stop(id);
    const room = yield* findRoom(id);
    yield* Effect.forEach(
      memberThreadIds(room),
      (threadId) =>
        commandId("bot-room-delete").pipe(
          Effect.flatMap((deleteId) =>
            threads.dispatch({ type: "thread.delete", commandId: deleteId, threadId }),
          ),
          Effect.ignoreCause({ log: true }),
        ),
      { discard: true },
    );
    yield* lock.withPermits(1)(
      Ref.get(records).pipe(
        Effect.flatMap((rooms) => save(rooms.filter((candidate) => candidate.id !== id))),
      ),
    );
    yield* Ref.update(live, (map) => {
      const next = new Map(map);
      next.delete(id);
      return next;
    });
    yield* notifyChanged;
    return id;
  });

  const reset: BotRooms["Service"]["reset"] = Effect.fn("BotRooms.reset")(function* (id) {
    yield* stop(id);
    const room = yield* updateRoom(id, (current) => ({
      ...current,
      turns: [],
      members: current.members.map((member) => ({ ...member, lastTurnAt: null, fresh: true })),
    }));
    yield* updateLive(id, (state) => ({
      ...state,
      members: new Map(),
      revision: state.revision + 1,
    }));
    return summary(room);
  });

  /** Each recorded run's final answer, read from the member threads, then merged with the user's turns. */
  const readTranscript = Effect.fn("BotRooms.readTranscript")(function* (
    room: BotRoomRecord,
    turns: ReadonlyArray<BotRoomTurn>,
  ) {
    const people = [...room.members, ...room.formerMembers];
    const replies = yield* Effect.forEach(
      memberThreadIds(room),
      (threadId) =>
        Effect.gen(function* () {
          const owners = new Set(
            people.filter((member) => member.threadId === threadId).map((member) => member.botId),
          );
          const parts = turns.flatMap((turn) =>
            turn.runs.flatMap((run) =>
              run.runId !== null &&
              owners.has(run.botId) &&
              run.status !== "failed" &&
              run.status !== "stopped"
                ? [{ turn, run, runId: run.resultRunId ?? run.runId }]
                : [],
            ),
          );
          if (parts.length === 0) return [];
          const runIds = [...new Set(parts.map((part) => part.runId))];
          const found = yield* threads.getThreadRecords(
            threadId,
            ["runs", "messages", "turnItems"],
            {
              runIds,
              messageRunIds: runIds,
              messageRoles: ["assistant"],
              turnItemRunIds: runIds,
              turnItemTypes: ["assistant_message"],
            },
          );
          return parts.flatMap(({ turn, run, runId }): ReadonlyArray<MemberReply> => {
            const status = found.runs.find((candidate) => candidate.id === runId)?.status;
            if (status !== "completed") return [];
            const reply = pickRunReply(found, runId);
            if (reply === null) return [];
            return [
              {
                id: `${run.botId}:${reply.id}`,
                turnId: turn.id,
                botId: run.botId,
                text: reply.text,
                at: reply.at,
              },
            ];
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "A room member's thread could not be read.",
              Cause.pretty(cause),
            ).pipe(Effect.as([])),
          ),
        ),
      { concurrency: 4 },
    );
    return mergeTranscript(turns, replies.flat());
  });

  const transcript: BotRooms["Service"]["transcript"] = Effect.fn("BotRooms.transcript")(
    function* (input) {
      const room = yield* findRoom(input.id);
      const limit = Math.min(
        input.limit ?? DEFAULT_TRANSCRIPT_TURNS,
        BOT_ROOM_TRANSCRIPT_MAX_TURNS,
      );
      const turns = room.turns.slice(-limit);
      const entries: ReadonlyArray<BotRoomTranscriptEntry> = yield* readTranscript(room, turns);
      return { entries, truncated: room.turns.length > turns.length };
    },
  );

  const settleRun = (id: BotRoomId, turnId: string, index: number, patch: Partial<BotRoomRun>) =>
    record(id, (room) => ({
      ...room,
      turns: room.turns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              runs: turn.runs.map((run, runIndex) =>
                runIndex === index ? { ...run, ...patch } : run,
              ),
            }
          : turn,
      ),
    }));

  /** Appends the run under the lock and returns its index; panel members append concurrently. */
  const addRun = (id: BotRoomId, turnId: string, run: BotRoomRun) =>
    updateRoom(id, (room) => ({
      ...room,
      turns: room.turns.map((turn) =>
        turn.id === turnId ? { ...turn, runs: [...turn.runs, run] } : turn,
      ),
    })).pipe(
      Effect.map((room) => (room.turns.find((turn) => turn.id === turnId)?.runs.length ?? 1) - 1),
    );

  /** One message, start to end: address the members, dispatch, wait, and bring teammates back in. */
  const runTurn = Effect.fn("BotRooms.runTurn")(function* (
    id: BotRoomId,
    turnId: string,
    message: RoomMessage,
  ) {
    yield* patchTurn(id, turnId, { status: "running" });
    const room = yield* findRoom(id);
    const turnIndex = room.turns.findIndex((candidate) => candidate.id === turnId);
    if (turnIndex < 0) return;
    const roster = yield* botsById;
    const nameOf = (botId: BotId) => roster.get(botId)?.name ?? "A Bot";
    // A member whose Bot was deleted never answers, even as the lead.
    const available = room.members.filter((member) => roster.has(member.botId));
    // This message is quoted in full below, and later ones still wait in the queue.
    const history = transcriptLines(yield* readTranscript(room, room.turns.slice(0, turnIndex)));
    const started = yield* Clock.currentTimeMillis;
    const turnDeadline = started + room.settings.turnDeadlineMin * 60_000;
    const memberTimeoutMs = room.settings.memberTimeoutMin * 60_000;
    const roundtable = room.settings.mode === "roundtable";
    const maxWaves = roundtable ? room.settings.maxWaves : 1;
    const budget = Math.max(1, room.settings.maxReplies);
    const spoken: Array<{ readonly botId: BotId; readonly text: string }> = [];
    const outcomes: Array<BotRoomRun["status"]> = [];

    const speakOne = Effect.fn("BotRooms.speakOne")(
      function* (candidate: BotRoomMember) {
        yield* setMemberState(id, candidate.botId, "thinking");
        const bot = roster.get(candidate.botId);
        if (bot === undefined || bot.projectId === null) {
          return yield* new BotInvalidError({ detail: "This Bot no longer exists." });
        }
        const latest = (yield* findRoom(id)).members.find(
          (member) => member.botId === candidate.botId,
        );
        const member = latest ?? candidate;
        const threadId = member.threadId ?? (yield* launchMember(room, bot));
        if (member.threadId === null) yield* patchMember(id, member.botId, { threadId });
        const floor = roundtable
          ? spoken
              .filter((line) => line.botId !== member.botId)
              .map((line) => `${nameOf(line.botId)}: ${line.text}`)
          : [];
        const text = promptFor({
          room,
          member,
          message,
          lines: [...linesFor(member, history, nameOf), ...floor],
          nameOf,
        });
        const index = yield* addRun(id, turnId, { botId: member.botId, runId: null });
        yield* updateLive(id, (state) => ({
          ...state,
          threads: new Set(state.threads).add(threadId),
        }));
        const sent = yield* threads.sendToThread({
          projectId: bot.projectId,
          commandId: yield* commandId("bot-room-send"),
          threadId,
          messageId: MessageId.make(yield* uuid),
          text,
          attachments: [],
          mode: "queue",
          ...(member.fresh === true ? { freshContext: true } : {}),
          createdBy: "user",
          creationSource: "server",
        });
        if (member.fresh === true) yield* patchMember(id, member.botId, { fresh: false });
        yield* settleRun(id, turnId, index, { runId: sent.run.id });
        // Each member gets its own wait; a late speaker must not inherit what others left.
        const now = yield* Clock.currentTimeMillis;
        const waited = yield* threads.waitForThread({
          projectId: bot.projectId,
          threadId,
          runId: sent.run.id,
          timeoutMs: Math.max(1, Math.min(turnDeadline, now + memberTimeoutMs) - now),
          untilDelegatedWorkSettled: true,
        });
        const finalRun = waited.resultRun ?? waited.run;
        let status: NonNullable<BotRoomRun["status"]>;
        let replied: string | null = null;
        let repliedAt: string | null = null;
        if (waited.timedOut || finalRun === null) status = "timeout";
        else if (finalRun.status === "completed") {
          const found = yield* threads.getThreadRecords(threadId, ["messages", "turnItems"], {
            messageRunIds: [finalRun.id],
            messageRoles: ["assistant"],
            turnItemRunIds: [finalRun.id],
            turnItemTypes: ["assistant_message"],
          });
          const reply = pickRunReply(found, finalRun.id);
          if (reply === null) status = "no-reply";
          else if (isPass(reply.text)) status = "passed";
          else {
            status = "replied";
            replied = reply.text;
            repliedAt = reply.at;
          }
        } else status = finalRun.status === "failed" ? "failed" : "stopped";
        if (replied !== null) spoken.push({ botId: member.botId, text: clip(replied, 1_200) });
        outcomes.push(status);
        const at = yield* nowIso;
        yield* settleRun(id, turnId, index, {
          status,
          at,
          ...(finalRun !== null && finalRun.id !== sent.run.id
            ? { resultRunId: finalRun.id as RunId }
            : {}),
        });
        yield* patchMember(id, member.botId, { lastTurnAt: repliedAt ?? at });
        yield* setMemberState(id, member.botId, status === "no-reply" ? "no-reply" : status);
        yield* bumpRevision(id);
      },
      (effect, candidate) =>
        effect.pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
            outcomes.push("failed");
            return Effect.logWarning(
              `A room member could not answer in ${room.name}.`,
              Cause.pretty(cause),
            ).pipe(Effect.andThen(setMemberState(id, candidate.botId, "failed")));
          }),
        ),
    );

    let speakers = speakersFor(room, available, message, nameOf);
    if (roundtable) {
      speakers = rotateSpeakers(speakers, turnIndex);
    }
    let wave = 0;
    while (
      speakers.length > 0 &&
      wave < maxWaves &&
      spoken.length < budget &&
      (yield* Clock.currentTimeMillis) < turnDeadline
    ) {
      wave += 1;
      const batch = speakers.slice(0, Math.max(1, budget - spoken.length));
      const heard = spoken.length;
      if (roundtable) {
        // A roundtable hears itself: one at a time, so each reply can be answered.
        for (const member of batch) yield* setMemberState(id, member.botId, "waiting");
        for (const member of batch) {
          if (spoken.length >= budget || (yield* Clock.currentTimeMillis) >= turnDeadline) break;
          yield* speakOne(member);
        }
      } else {
        yield* Effect.forEach(batch, speakOne, { concurrency: "unbounded", discard: true });
      }
      if (!roundtable || !room.settings.allowCrossMentions) break;
      speakers = crossMentions(spoken.slice(heard), available, nameOf);
    }
    const everyFailed =
      outcomes.length > 0 &&
      outcomes.every(
        (status) => status === "failed" || status === "timeout" || status === "stopped",
      );
    const finalStatus: BotRoomTurnStatus = everyFailed ? "failed" : "done";
    yield* patchTurn(id, turnId, { status: finalStatus });
    yield* bumpRevision(id);
  });

  /** Releases the room after its turn and starts the next queued message, if any. */
  const finish: (id: BotRoomId, turnId: string) => Effect.Effect<void> = Effect.fn(
    "BotRooms.finish",
  )(function* (id: BotRoomId, turnId: string) {
    const next = yield* Ref.modify(live, (map) => {
      const state = map.get(id) ?? IDLE;
      if (state.turnId !== turnId) return [undefined, map];
      const [head, ...rest] = state.queue;
      return [
        head,
        new Map(map).set(id, {
          ...state,
          turnId: head?.turnId ?? null,
          fiber: null,
          threads: new Set(),
          queue: rest,
        }),
      ];
    });
    yield* notifyChanged;
    if (next !== undefined) yield* begin(id, next.turnId, next.message);
  });

  const begin: (id: BotRoomId, turnId: string, message: RoomMessage) => Effect.Effect<void> =
    Effect.fn("BotRooms.begin")(function* (id: BotRoomId, turnId: string, message: RoomMessage) {
      const fiber = yield* runTurn(id, turnId, message).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("A room turn failed.", Cause.pretty(cause)).pipe(
                Effect.andThen(patchTurn(id, turnId, { status: "failed" })),
              ),
        ),
        Effect.ensuring(Effect.suspend(() => finish(id, turnId))),
        Effect.forkIn(layerScope),
      );
      // A Stop that ran while the turn was forking could not see its fiber.
      const kept = yield* Ref.modify(live, (map) => {
        const state = map.get(id);
        return state?.turnId === turnId
          ? [true, new Map(map).set(id, { ...state, fiber })]
          : [false, map];
      });
      if (!kept) yield* Fiber.interrupt(fiber);
    });

  const send: BotRooms["Service"]["send"] = Effect.fn("BotRooms.send")(function* (input) {
    yield* findRoom(input.id);
    const turn: BotRoomTurn = {
      id: yield* uuid,
      at: yield* nowIso,
      text: input.text.trim(),
      mentions: input.mentions ?? [],
      status: "queued",
      runs: [],
    };
    yield* updateRoom(input.id, (room) => ({
      ...room,
      turns: [...room.turns, turn].slice(-MAX_STORED_TURNS),
      updatedAt: turn.at,
    }));
    const message: RoomMessage = { text: turn.text, mentions: turn.mentions };
    // Reserve the room in one step: two sends in the same tick must not both start a turn.
    const startNow = yield* Ref.modify(live, (map) => {
      const state = map.get(input.id) ?? IDLE;
      const next: RoomLive =
        state.turnId === null
          ? { ...state, turnId: turn.id, members: new Map(), revision: state.revision + 1 }
          : {
              ...state,
              queue: [...state.queue, { turnId: turn.id, message }],
              revision: state.revision + 1,
            };
      return [state.turnId === null, new Map(map).set(input.id, next)];
    });
    yield* notifyChanged;
    if (startNow) yield* begin(input.id, turn.id, message);
    return { turnId: turn.id, queued: !startNow };
  });

  // A turn that was running or queued when the server stopped does not resume.
  const loaded = yield* io(readTextIfExists(file)).pipe(
    Effect.flatMap((text) =>
      text.trim() === ""
        ? Effect.succeed<ReadonlyArray<BotRoomRecord>>([])
        : decodeRoomsFile(text).pipe(Effect.map((decoded) => decoded.rooms)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "The rooms file is unreadable; starting with no rooms.",
        Cause.pretty(cause),
      ).pipe(Effect.as<ReadonlyArray<BotRoomRecord>>([])),
    ),
  );
  const interrupted = loaded.some((room) =>
    room.turns.some((turn) => turn.status === "running" || turn.status === "queued"),
  );
  const recovered = loaded.map((room) => ({
    ...room,
    turns: room.turns.map((turn) =>
      turn.status === "running" || turn.status === "queued"
        ? { ...turn, status: "interrupted" as const }
        : turn,
    ),
  }));
  yield* Ref.set(records, recovered);
  if (interrupted) yield* save(recovered).pipe(Effect.ignoreCause({ log: true }));

  return BotRooms.of({
    subscribe,
    create,
    update,
    delete: deleteRoom,
    send,
    stop,
    reset,
    transcript,
  });
});

export const layer = Layer.effect(BotRooms, make);
