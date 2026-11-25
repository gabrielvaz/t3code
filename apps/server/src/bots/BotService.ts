import {
  Bot,
  type BotAvatar,
  BotConflictError,
  type BotCreateInput,
  type BotDeleteInput,
  type BotDeleteResult,
  type BotGetInstructionsInput,
  type BotGetInstructionsResult,
  type BotGetMemoryInput,
  type BotGetMemoryResult,
  BotId,
  BotInvalidError,
  type BotListResult,
  type BotMutationResult,
  BotNotFoundError,
  type BotSaveInstructionsInput,
  type BotSaveMemoryInput,
  BotSaveSettingsInput,
  type BotSaveSettingsResult,
  type BotSaveTextResult,
  type BotsSharedSettings,
  BotStorageError,
  type BotUpdateInput,
  CommandId,
  type ModelSelection,
  ProjectId,
  type ScheduledTask,
  ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { isBotAvatarColor, renderBotAvatarSvg } from "@t3tools/shared/botAvatar";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { botAvatarFileName } from "./BotAvatarSvg.ts";
import {
  type BotPaths,
  botPaths,
  freeSlug,
  readTextIfExists,
  sharedPaths,
  trashFolder,
  writeTextAtomic,
  writeTextIfChanged,
} from "./BotFiles.ts";
import {
  BOT_MEMORY_LIMITS,
  memorySnapshot,
  normalizeSavedText,
  renderMemoryBlock,
  revisionOf,
} from "./BotMemory.ts";
import {
  BOT_CLAUDE_MD,
  customInstructions,
  mergeManaged,
  renderManagedBlock,
  withCustom,
} from "./BotTemplate.ts";

export type BotServiceError =
  | BotNotFoundError
  | BotConflictError
  | BotStorageError
  | BotInvalidError;

export class BotService extends Context.Service<
  BotService,
  {
    readonly list: Effect.Effect<BotListResult, BotStorageError>;
    /** The full list now, then again after every change. */
    readonly subscribe: () => Stream.Stream<BotListResult, BotStorageError>;
    readonly create: (input: BotCreateInput) => Effect.Effect<BotMutationResult, BotServiceError>;
    readonly update: (input: BotUpdateInput) => Effect.Effect<BotMutationResult, BotServiceError>;
    readonly delete: (input: BotDeleteInput) => Effect.Effect<BotDeleteResult, BotServiceError>;
    readonly getMemory: (
      input: BotGetMemoryInput,
    ) => Effect.Effect<BotGetMemoryResult, BotServiceError>;
    readonly saveMemory: (
      input: BotSaveMemoryInput,
    ) => Effect.Effect<BotSaveTextResult, BotServiceError>;
    readonly getInstructions: (
      input: BotGetInstructionsInput,
    ) => Effect.Effect<BotGetInstructionsResult, BotServiceError>;
    readonly saveInstructions: (
      input: BotSaveInstructionsInput,
    ) => Effect.Effect<BotSaveTextResult, BotServiceError>;
    readonly saveSettings: (
      input: BotSaveSettingsInput,
    ) => Effect.Effect<BotSaveSettingsResult, BotServiceError>;
    /** The Bot whose main thread this is, from memory; null for every other thread. */
    readonly botForThread: (threadId: ThreadId) => Effect.Effect<Bot | null>;
  }
>()("t3/bots/BotService") {}

export const MEMORY_TIDY_TITLE = "Tidy memory";

/** Adapted from Threebot server/memory-tidy.mts `memoryTidyPrompt` (MIT). */
const MEMORY_TIDY_PROMPT = `Tidy your memory now. Work only inside your \`memory/\` folder and answer with one short paragraph.

1. Read \`memory/MEMORY.md\` and \`memory/log.md\`.
2. Keep \`MEMORY.md\` inside the snapshot budget: ${BOT_MEMORY_LIMITS.snapshotBotLines} lines and ${BOT_MEMORY_LIMITS.snapshotBotChars.toLocaleString("en-US")} characters. Only that much is copied into a fresh session, so anything past it is invisible. Count by reading the file; do not run shell commands.
3. Merge repeated facts into one short line under its heading. When two lines disagree, keep the newest and delete the older. Move dated diary entries to \`memory/log.md\`.
4. Remove only what you can prove is stale, superseded or contradicted by a newer line. Never delete a unique fact you cannot verify; list it instead.
5. Leave the user's own wording alone when it is already a clear fact.
6. Report the final line and character count, what you merged, removed or moved, and anything you left for the user to decide. If nothing changed, say so in one line.`;

function memoryTidySchedule(frequency: "daily" | "weekly") {
  return {
    type: "fixed_time" as const,
    timeOfDay: "03:30",
    ...(frequency === "weekly" ? { weekdays: [1] } : {}),
  };
}

const DEFAULT_SETTINGS: BotsSharedSettings = {
  userName: "",
  timezone: "",
  alwaysAsk: [],
  allowWithoutAsking: [],
  mainBotId: null,
};

const DEFAULT_AVATAR: BotAvatar = { kind: "ball", color: "teal" };
const MEMORY_SEED = "# Memory\n";
const LOG_SEED = "# Work log\n";
const SHARED_MEMORY_LABEL = "../.shared/shared-memory.md";
// Saves emit several events, and a provider may write the file in pieces.
const WATCH_SETTLE = Duration.seconds(1);
const POLL_INTERVAL = Duration.seconds(3);

const decodeBot = Schema.decodeUnknownEffect(Schema.fromJsonString(Bot));
const encodeBot = Schema.encodeEffect(Bot);
const decodeSettingsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(BotSaveSettingsInput));

const storage =
  (operation: BotStorageError["operation"], id?: BotId) =>
  (cause: unknown): BotStorageError =>
    new BotStorageError({ operation, ...(id === undefined ? {} : { id }), cause });

function mergeSettings(base: BotsSharedSettings, patch: BotSaveSettingsInput): BotsSharedSettings {
  return {
    userName: patch.userName ?? base.userName,
    timezone: patch.timezone ?? base.timezone,
    alwaysAsk: patch.alwaysAsk ?? base.alwaysAsk,
    allowWithoutAsking: patch.allowWithoutAsking ?? base.allowWithoutAsking,
    mainBotId: patch.mainBotId === undefined ? base.mainBotId : patch.mainBotId,
  };
}

/** The favicon a Bot's look maps to, without checking that an image file exists. */
function expectedFaviconPath(bot: Bot): string {
  if (bot.avatar.kind === "image" && bot.avatar.imagePath !== undefined)
    return bot.avatar.imagePath;
  return `.bot/${botAvatarFileName(renderBotAvatarSvg(bot.avatar, bot.name))}`;
}

const sameModel = (a: ModelSelection | null, b: ModelSelection | null) =>
  JSON.stringify(a) === JSON.stringify(b);

function validateAvatar(avatar: BotAvatar): BotInvalidError | null {
  if (!isBotAvatarColor(avatar.color)) {
    return new BotInvalidError({ detail: "Use a palette colour or a hex colour like #3fa7d6." });
  }
  if (avatar.kind === "image" && avatar.imagePath === undefined) {
    return new BotInvalidError({ detail: "An image avatar needs an image." });
  }
  return null;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;
  // MCP asks on every request whether the caller is a Bot thread, so this stays in memory.
  const botsByThread = yield* Ref.make<ReadonlyMap<ThreadId, Bot>>(new Map());

  const root = path.join(config.stateDir, "bots");
  const shared = sharedPaths(path, root);
  const pathsOf = (bot: Pick<Bot, "slug">) => botPaths(path, root, bot.slug);
  // Every write goes through one permit, so two edits can't both pass a revision check.
  const lock = yield* Semaphore.make(1);
  // Subscribers re-read the whole list, so they need only the newest dirty signal.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const io = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const read = (file: string, id?: BotId) =>
    io(readTextIfExists(file)).pipe(Effect.mapError(storage("read", id)));
  const write = (file: string, content: string, id?: BotId) =>
    io(writeTextAtomic(file, content)).pipe(Effect.mapError(storage("write", id)));
  const writeIfChanged = (file: string, content: string, id?: BotId) =>
    io(writeTextIfChanged(file, content)).pipe(Effect.mapError(storage("write", id)));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readSettings = Effect.fn("BotService.readSettings")(function* () {
    const text = yield* read(shared.settings);
    if (text.trim() === "") return DEFAULT_SETTINGS;
    const stored = yield* decodeSettingsFile(text).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Bots settings file is invalid; using defaults.",
          Cause.pretty(cause),
        ).pipe(Effect.as<BotSaveSettingsInput>({})),
      ),
    );
    return mergeSettings(DEFAULT_SETTINGS, stored);
  });

  const writeSettings = (settings: BotsSharedSettings) =>
    write(shared.settings, `${JSON.stringify(settings, null, 2)}\n`);

  const readBots = Effect.fn("BotService.readBots")(function* () {
    const entries = yield* fileSystem.readDirectory(root).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
      Effect.mapError(storage("list")),
    );
    const bots = yield* Effect.forEach(
      entries.filter((entry) => !entry.startsWith(".")),
      (slug) =>
        read(botPaths(path, root, slug).record).pipe(
          Effect.flatMap((text) => (text === "" ? Effect.succeed(null) : decodeBot(text))),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Skipping the Bot in ${slug}: its bot.json is unreadable.`, {
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
          ),
        ),
      { concurrency: 8 },
    );
    const sorted = bots
      .filter((bot): bot is Bot => bot !== null)
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    yield* Ref.set(
      botsByThread,
      new Map(sorted.flatMap((bot) => (bot.threadId === null ? [] : [[bot.threadId, bot]]))),
    );
    return sorted;
  });

  const list: BotService["Service"]["list"] = Effect.gen(function* () {
    const [bots, settings] = yield* Effect.all([readBots(), readSettings()]);
    return { bots, settings };
  }).pipe(Effect.withSpan("BotService.list"));

  const subscribe: BotService["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change during the first read is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
        );
      }),
    );

  const findBot = Effect.fn("BotService.findBot")(function* (id: BotId) {
    const bots = yield* readBots();
    const bot = bots.find((candidate) => candidate.id === id);
    if (bot === undefined) return yield* new BotNotFoundError({ id });
    return { bot, bots };
  });

  const writeRecord = Effect.fn("BotService.writeRecord")(function* (bot: Bot) {
    const encoded = yield* encodeBot(bot).pipe(Effect.mapError(storage("write", bot.id)));
    // @effect-diagnostics-next-line globalJsonInEffect:off -- the schema's encoded form is plain JSON data
    yield* write(pathsOf(bot).record, `${JSON.stringify(encoded, null, 2)}\n`, bot.id);
    const threadId = bot.threadId;
    if (threadId !== null) {
      yield* Ref.update(botsByThread, (bots) => new Map(bots).set(threadId, bot));
    }
  });

  /** Writes the avatar SVG and returns the favicon path, relative to the Bot's folder. */
  const writeAvatar = Effect.fn("BotService.writeAvatar")(function* (bot: Bot, paths: BotPaths) {
    const svg = renderBotAvatarSvg(bot.avatar, bot.name);
    const fileName = botAvatarFileName(svg);
    yield* writeIfChanged(path.join(paths.botDir, fileName), svg, bot.id);
    // Old looks are removed so the folder holds one avatar.
    const entries = yield* fileSystem
      .readDirectory(paths.botDir)
      .pipe(Effect.mapError(storage("write", bot.id)));
    yield* Effect.forEach(
      entries.filter(
        (entry) => entry.startsWith("avatar-") && entry.endsWith(".svg") && entry !== fileName,
      ),
      (entry) => fileSystem.remove(path.join(paths.botDir, entry), { force: true }),
      { discard: true },
    ).pipe(Effect.mapError(storage("write", bot.id)));
    if (bot.avatar.kind === "image" && bot.avatar.imagePath !== undefined) {
      const hasImage = yield* fileSystem
        .exists(path.join(paths.dir, bot.avatar.imagePath))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasImage) return bot.avatar.imagePath;
    }
    return `.bot/${fileName}`;
  });

  /** Rewrites the managed block of the Bot's AGENTS.md, keeping the user's instructions. */
  const renderBot = Effect.fn("BotService.renderBot")(function* (
    bot: Bot,
    settings: BotsSharedSettings,
    options?: { readonly instructions?: string },
  ) {
    const paths = pathsOf(bot);
    const [botMemory, sharedMemory, existing] = yield* Effect.all([
      read(paths.memory, bot.id),
      read(shared.memory),
      read(paths.agents, bot.id),
    ]);
    const block = renderManagedBlock({
      bot,
      settings,
      folder: paths.dir,
      sharedMemoryFile: SHARED_MEMORY_LABEL,
      memoryBlock: renderMemoryBlock(
        memorySnapshot({
          botText: botMemory,
          sharedText: sharedMemory,
          sharedFile: SHARED_MEMORY_LABEL,
        }),
      ),
    });
    const next =
      options?.instructions !== undefined
        ? withCustom(block, options.instructions)
        : existing === ""
          ? withCustom(block, "")
          : mergeManaged(existing, block);
    yield* writeIfChanged(paths.agents, next, bot.id);
    yield* writeIfChanged(paths.claude, BOT_CLAUDE_MD, bot.id);
    return yield* writeAvatar(bot, paths);
  });

  const renderAll = Effect.fn("BotService.renderAll")(function* () {
    const [bots, settings] = yield* Effect.all([readBots(), readSettings()]);
    yield* Effect.forEach(bots, (bot) => renderBot(bot, settings), { discard: true });
  });

  const syncProject = Effect.fn("BotService.syncProject")(function* (
    bot: Bot,
    patch: { readonly title?: string; readonly faviconPath?: string },
  ) {
    if (bot.projectId === null || (patch.title === undefined && patch.faviconPath === undefined))
      return;
    const uuid = yield* random.uuidV4().pipe(Effect.mapError(storage("update-project", bot.id)));
    yield* projects
      .update({
        commandId: CommandId.make(`bot-project-sync:${bot.id}:${uuid}`),
        projectId: bot.projectId,
        ...patch,
      })
      .pipe(Effect.mapError(storage("update-project", bot.id)));
  });

  const clearOtherPrimaries = Effect.fn("BotService.clearOtherPrimaries")(function* (
    bots: ReadonlyArray<Bot>,
    keep: BotId,
  ) {
    const now = yield* nowIso;
    yield* Effect.forEach(
      bots.filter((bot) => bot.primary && bot.id !== keep),
      (bot) => writeRecord({ ...bot, primary: false, updatedAt: now }),
      { discard: true },
    );
  });

  const resolveModel = Effect.fn("BotService.resolveModel")(function* (
    model: ModelSelection | null | undefined,
  ) {
    const serverConfig = yield* serverSettings.getSettings.pipe(
      Effect.mapError(storage("resolve-model")),
    );
    return model ?? resolveProjectSettings(serverConfig, null).settings.defaultModelSelection;
  });

  const commandId = (prefix: string, id: BotId) =>
    random.uuidV4().pipe(
      Effect.map((uuid) => CommandId.make(`${prefix}:${id}:${uuid}`)),
      Effect.mapError(storage("configure-thread", id)),
    );

  /** Keeps the Bot's thread in step with its name, model and runtime mode. */
  const syncThread = Effect.fn("BotService.syncThread")(function* (bot: Bot, current: Bot) {
    const threadId = bot.threadId;
    if (threadId === null) return;
    const dispatch = (command: Parameters<typeof threads.dispatch>[0]) =>
      threads.dispatch(command).pipe(Effect.mapError(storage("configure-thread", bot.id)));
    if (bot.name !== current.name) {
      yield* dispatch({
        type: "thread.metadata.update",
        commandId: yield* commandId("bot-thread-title", bot.id),
        threadId,
        title: bot.name,
      });
    }
    if (bot.model !== null && !sameModel(bot.model, current.model)) {
      yield* dispatch({
        type: "thread.model-selection.set",
        commandId: yield* commandId("bot-thread-model", bot.id),
        threadId,
        modelSelection: bot.model,
      });
    }
    if (bot.runtimeMode !== current.runtimeMode) {
      yield* dispatch({
        type: "thread.runtime-mode.set",
        commandId: yield* commandId("bot-thread-runtime", bot.id),
        threadId,
        runtimeMode: bot.runtimeMode,
      });
    }
  });

  /**
   * Creates, edits or pauses the Bot's "Tidy memory" routine and returns its id. It runs in its own
   * thread in the Bot's project: a fresh session each night would wipe the Bot's main conversation.
   */
  const applyMemoryTidy = Effect.fn("BotService.applyMemoryTidy")(function* (bot: Bot) {
    const tidyError = storage("memory-tidy", bot.id);
    const existing: ScheduledTask | undefined =
      bot.memoryTidyTaskId === null
        ? undefined
        : (yield* scheduledTasks.list().pipe(Effect.mapError(tidyError))).tasks.find(
            (task) => task?.id === bot.memoryTidyTaskId,
          );
    if (bot.memoryTidy === "off") {
      if (existing === undefined) return null;
      yield* scheduledTasks
        .setEnabled({ id: existing.id, enabled: false })
        .pipe(Effect.mapError(tidyError));
      return existing.id;
    }
    if (bot.projectId === null) return null;
    const modelSelection = existing?.modelSelection ?? (yield* resolveModel(bot.model));
    if (modelSelection === null) {
      return yield* new BotInvalidError({ detail: "Choose a model for this Bot first." });
    }
    const saved = yield* scheduledTasks
      .upsert({
        ...(existing === undefined ? {} : { id: existing.id, requireExisting: true }),
        commandId: yield* commandId("bot-memory-tidy", bot.id),
        title: MEMORY_TIDY_TITLE,
        prompt: MEMORY_TIDY_PROMPT,
        enabled: true,
        schedule: memoryTidySchedule(bot.memoryTidy),
        projectId: bot.projectId,
        threadId: existing?.threadId ?? null,
        threadMode: "fresh_session",
        workspaceStrategy: { type: "root" },
        modelSelection,
        // It only edits files inside memory/.
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(tidyError));
    return saved.task.id;
  });

  const deleteScheduledTask = (id: string) =>
    scheduledTasks.delete({ id: ScheduledTaskId.make(id) }).pipe(Effect.ignoreCause({ log: true }));

  const create: BotService["Service"]["create"] = Effect.fn("BotService.create")(function* (input) {
    const avatar = input.avatar ?? DEFAULT_AVATAR;
    const invalid = validateAvatar(avatar);
    if (invalid !== null) return yield* invalid;
    const modelSelection = yield* resolveModel(input.model);
    if (modelSelection === null) {
      return yield* new BotInvalidError({
        detail: "Choose a model for this Bot: there is no default model.",
      });
    }

    const id = BotId.make(yield* random.uuidV7().pipe(Effect.mapError(storage("write"))));
    const created = yield* Ref.make<{ dir?: string; projectId?: ProjectId }>({});
    const cleanup = Effect.gen(function* () {
      const done = yield* Ref.get(created);
      if (done.projectId !== undefined) {
        yield* projects
          .delete({
            commandId: CommandId.make(`bot-create-rollback:${id}`),
            projectId: done.projectId,
            force: true,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      if (done.dir !== undefined) {
        yield* fileSystem
          .remove(done.dir, { recursive: true, force: true })
          .pipe(Effect.ignoreCause({ log: true }));
      }
    });

    return yield* Effect.gen(function* () {
      const [bots, settings] = yield* Effect.all([readBots(), readSettings()]);
      const taken = new Set(
        yield* fileSystem.readDirectory(root).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
          Effect.mapError(storage("list")),
        ),
      );
      const now = yield* nowIso;
      const draft: Bot = {
        id,
        slug: freeSlug(input.name, taken),
        name: input.name,
        role: input.role?.trim() ?? "",
        avatar,
        projectId: null,
        threadId: null,
        model: input.model ?? null,
        runtimeMode: input.runtimeMode ?? "auto",
        pinned: false,
        order: bots.reduce((max, bot) => Math.max(max, bot.order + 1), 0),
        primary: input.primary ?? false,
        createdAt: now,
        updatedAt: now,
        memoryTidy: "off",
        memoryTidyTaskId: null,
      };
      const paths = pathsOf(draft);
      yield* Ref.set(created, { dir: paths.dir });
      yield* fileSystem
        .makeDirectory(paths.library, { recursive: true })
        .pipe(Effect.mapError(storage("write", id)));
      yield* write(paths.memory, MEMORY_SEED, id);
      yield* write(paths.log, LOG_SEED, id);
      yield* writeRecord(draft);
      yield* renderBot(draft, settings, { instructions: input.instructions ?? "" });

      const projectId = ProjectId.make(id);
      yield* projects
        .create({
          commandId: CommandId.make(`bot-project:${id}`),
          projectId,
          title: input.name,
          workspaceRoot: paths.dir,
          createWorkspaceRootIfMissing: true,
          ...(input.model ? { defaultModelSelection: input.model } : {}),
        })
        .pipe(Effect.mapError(storage("create-project", id)));
      yield* Ref.set(created, { dir: paths.dir, projectId });

      const launched = yield* threadLaunch
        .launch({
          commandId: CommandId.make(`bot-thread:${id}`),
          projectId,
          title: input.name,
          titleRenamed: true,
          modelSelection,
          runtimeMode: draft.runtimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.catchTags({
            ThreadManagementProviderInstanceDisabledError: (error) =>
              Effect.fail(new BotInvalidError({ detail: error.message })),
            ThreadLaunchError: (error) => Effect.fail(storage("launch-thread", id)(error)),
          }),
        );

      const bot: Bot = { ...draft, projectId, threadId: launched.threadId };
      yield* writeRecord(bot);
      // The project and thread exist now; the steps below only polish them.
      yield* Ref.set(created, {});
      const faviconPath = yield* renderBot(bot, settings);
      yield* syncProject(bot, { faviconPath }).pipe(Effect.ignoreCause({ log: true }));
      // A Bot thread is long-lived: it must not settle out of the sidebar when it goes quiet.
      yield* threads
        .dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`bot-auto-settle:${id}`),
          threadId: launched.threadId,
          enabled: false,
        })
        .pipe(Effect.ignoreCause({ log: true }));
      if (bot.primary) yield* clearOtherPrimaries(bots, bot.id);
      yield* notifyChanged;
      return { bot };
    }).pipe(Effect.onError(() => cleanup));
  }, lock.withPermits(1));

  const update: BotService["Service"]["update"] = Effect.fn("BotService.update")(function* (input) {
    yield* Effect.annotateCurrentSpan({ "bot.id": input.id });
    if (input.avatar !== undefined) {
      const invalid = validateAvatar(input.avatar);
      if (invalid !== null) return yield* invalid;
    }
    const { bot: current, bots } = yield* findBot(input.id);
    const settings = yield* readSettings();
    let bot: Bot = {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.role === undefined ? {} : { role: input.role.trim() }),
      ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.order === undefined ? {} : { order: input.order }),
      ...(input.primary === undefined ? {} : { primary: input.primary }),
      ...(input.memoryTidy === undefined ? {} : { memoryTidy: input.memoryTidy }),
      updatedAt: yield* nowIso,
    };
    if (input.memoryTidy !== undefined && input.memoryTidy !== current.memoryTidy) {
      bot = { ...bot, memoryTidyTaskId: yield* applyMemoryTidy(bot) };
    }
    yield* writeRecord(bot);
    if (input.primary === true) yield* clearOtherPrimaries(bots, bot.id);
    const faviconPath = yield* renderBot(bot, settings);
    yield* syncProject(bot, {
      ...(bot.name === current.name ? {} : { title: bot.name }),
      ...(faviconPath === expectedFaviconPath(current) ? {} : { faviconPath }),
    });
    // The record is saved; a thread that cannot follow (say, mid-run) must not fail the edit.
    yield* syncThread(bot, current).pipe(Effect.ignoreCause({ log: true }));
    yield* notifyChanged;
    return { bot };
  }, lock.withPermits(1));

  const deleteBot: BotService["Service"]["delete"] = Effect.fn("BotService.delete")(function* (
    input,
  ) {
    yield* Effect.annotateCurrentSpan({ "bot.id": input.id });
    const { bot } = yield* findBot(input.id);
    // Routines bound to the Bot's thread, and its memory tidy, would otherwise outlive it.
    if (bot.threadId !== null) {
      yield* scheduledTasks.deleteForThread(bot.threadId).pipe(Effect.ignoreCause({ log: true }));
    }
    if (bot.memoryTidyTaskId !== null) yield* deleteScheduledTask(bot.memoryTidyTaskId);
    if (bot.projectId !== null) {
      // Force deletes the Bot's thread with its project.
      yield* projects
        .delete({
          commandId: CommandId.make(`bot-delete:${bot.id}`),
          projectId: bot.projectId,
          force: true,
        })
        .pipe(
          Effect.catchTags({ ProjectNotFoundError: () => Effect.void }),
          Effect.mapError(storage("delete-project", bot.id)),
        );
    }
    const nowMs = yield* Clock.currentTimeMillis;
    yield* io(trashFolder(root, bot.slug, nowMs)).pipe(Effect.mapError(storage("trash", bot.id)));
    yield* Ref.update(
      botsByThread,
      (bots) => new Map([...bots].filter(([, entry]) => entry.id !== bot.id)),
    );
    const settings = yield* readSettings();
    if (settings.mainBotId === bot.id) yield* writeSettings({ ...settings, mainBotId: null });
    yield* notifyChanged;
    return { id: bot.id };
  }, lock.withPermits(1));

  const memoryFile = Effect.fn("BotService.memoryFile")(function* (
    scope: BotSaveMemoryInput["scope"],
    id: BotId | undefined,
  ) {
    if (scope === "shared") return { file: shared.memory, bot: null };
    if (id === undefined) return yield* new BotInvalidError({ detail: "Name the Bot to save." });
    const { bot } = yield* findBot(id);
    return { file: pathsOf(bot).memory, bot };
  });

  const getMemory: BotService["Service"]["getMemory"] = Effect.fn("BotService.getMemory")(
    function* (input) {
      const sharedText = yield* read(shared.memory);
      const sharedFile = {
        path: ".shared/shared-memory.md",
        text: sharedText,
        revision: revisionOf(sharedText),
      };
      if (input.id === undefined) return { bot: null, shared: sharedFile };
      const { bot } = yield* findBot(input.id);
      const text = yield* read(pathsOf(bot).memory, bot.id);
      return {
        bot: { path: "memory/MEMORY.md", text, revision: revisionOf(text) },
        shared: sharedFile,
      };
    },
  );

  const saveMemory: BotService["Service"]["saveMemory"] = Effect.fn("BotService.saveMemory")(
    function* (input) {
      const target = yield* memoryFile(input.scope, input.id);
      const current = yield* read(target.file, input.id);
      const revision = revisionOf(current);
      if (revision !== input.expectedRevision) {
        return yield* new BotConflictError({ currentText: current, revision });
      }
      const next = normalizeSavedText(input.text);
      yield* write(target.file, next, input.id);
      const settings = yield* readSettings();
      if (target.bot === null) yield* renderAll();
      else yield* renderBot(target.bot, settings);
      return { revision: revisionOf(next) };
    },
    lock.withPermits(1),
  );

  const getInstructions: BotService["Service"]["getInstructions"] = Effect.fn(
    "BotService.getInstructions",
  )(function* (input) {
    const { bot } = yield* findBot(input.id);
    const text = customInstructions(yield* read(pathsOf(bot).agents, bot.id));
    return { text, revision: revisionOf(text) };
  });

  const saveInstructions: BotService["Service"]["saveInstructions"] = Effect.fn(
    "BotService.saveInstructions",
  )(function* (input) {
    const { bot } = yield* findBot(input.id);
    const current = customInstructions(yield* read(pathsOf(bot).agents, bot.id));
    const revision = revisionOf(current);
    if (revision !== input.expectedRevision) {
      return yield* new BotConflictError({ currentText: current, revision });
    }
    const text = input.text.trim();
    yield* renderBot(bot, yield* readSettings(), { instructions: text });
    return { revision: revisionOf(text) };
  }, lock.withPermits(1));

  const saveSettings: BotService["Service"]["saveSettings"] = Effect.fn("BotService.saveSettings")(
    function* (input) {
      const current = yield* readSettings();
      const settings = mergeSettings(current, input);
      if (input.mainBotId !== undefined && input.mainBotId !== null) {
        yield* findBot(input.mainBotId);
      }
      yield* writeSettings(settings);
      yield* renderAll();
      yield* notifyChanged;
      return { settings };
    },
    lock.withPermits(1),
  );

  yield* fileSystem
    .makeDirectory(shared.dir, { recursive: true })
    .pipe(Effect.mapError(storage("write")));
  // Picks up template changes from an upgrade and edits made while the server was down.
  yield* lock
    .withPermits(1)(renderAll())
    .pipe(Effect.ignoreCause({ log: true }));

  const rerenderAll = lock
    .withPermits(1)(renderAll())
    .pipe(Effect.ignoreCause({ log: true }));
  // The agent and the user edit memory as plain files; AGENTS.md carries a snapshot of them.
  yield* fileSystem.watch(root, { recursive: true }).pipe(
    Stream.filter(
      (event) =>
        event.path.endsWith("MEMORY.md") ||
        event.path.endsWith("shared-memory.md") ||
        event.path.endsWith("settings.json"),
    ),
    Stream.debounce(WATCH_SETTLE),
    Stream.runForEach(() => rerenderAll),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "Bot memory is not watched for changes; polling instead.",
        Cause.pretty(cause),
      ).pipe(Effect.andThen(rerenderAll.pipe(Effect.delay(POLL_INTERVAL), Effect.forever))),
    ),
    Effect.forkScoped,
  );

  return BotService.of({
    list,
    subscribe,
    create,
    update,
    delete: deleteBot,
    getMemory,
    saveMemory,
    getInstructions,
    saveInstructions,
    saveSettings,
    botForThread: Effect.fn("BotService.botForThread")(function* (threadId) {
      return (yield* Ref.get(botsByThread)).get(threadId) ?? null;
    }),
  });
});

export const layer = Layer.effect(BotService, make);
