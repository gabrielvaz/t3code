import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const BotId = TrimmedNonEmptyString.pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;

export const BOT_NAME_MAX_CHARS = 60;
export const BOT_ROLE_MAX_CHARS = 120;
/** A memory save larger than this is refused; it is far past what the snapshot in AGENTS.md carries. */
export const BOT_MEMORY_FILE_MAX_CHARS = 200_000;
export const BOT_INSTRUCTIONS_MAX_CHARS = 100_000;

const BotName = TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_NAME_MAX_CHARS));
const BotRole = Schema.String.check(Schema.isMaxLength(BOT_ROLE_MAX_CHARS));

export const BotAvatarKind = Schema.Literals(["ball", "object", "monogram", "image"]);
export type BotAvatarKind = typeof BotAvatarKind.Type;

/** A palette name such as "teal", or "#rrggbb". */
export const BotAvatarColor = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(#[0-9a-fA-F]{6}|[a-z]+)$/),
);

export const BotAvatar = Schema.Struct({
  kind: BotAvatarKind,
  /** For `object`, the gallery object id, such as "rocket". */
  shape: Schema.optional(TrimmedNonEmptyString),
  color: BotAvatarColor,
  /** For `image`, a file inside the Bot's `.bot/` folder, relative to the Bot's folder. */
  imagePath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isPattern(/^\.bot\/[A-Za-z0-9._-]+$/)),
  ),
});
export type BotAvatar = typeof BotAvatar.Type;

export const BotMemoryTidy = Schema.Literals(["off", "daily", "weekly"]);
export type BotMemoryTidy = typeof BotMemoryTidy.Type;

/** `bots/<slug>/.bot/bot.json`, the single source of truth for a Bot. */
export const Bot = Schema.Struct({
  id: BotId,
  slug: TrimmedNonEmptyString,
  name: BotName,
  role: BotRole,
  avatar: BotAvatar,
  /** Null only while the Bot is being created. */
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  model: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  pinned: Schema.Boolean,
  order: Schema.Number,
  primary: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  memoryTidy: BotMemoryTidy,
  memoryTidyTaskId: Schema.NullOr(Schema.String),
});
export type Bot = typeof Bot.Type;

export const BotsSharedSettings = Schema.Struct({
  userName: Schema.String,
  /** IANA zone. Empty means the server's local time. */
  timezone: Schema.String,
  alwaysAsk: Schema.Array(Schema.String),
  allowWithoutAsking: Schema.Array(Schema.String),
  mainBotId: Schema.NullOr(BotId),
});
export type BotsSharedSettings = typeof BotsSharedSettings.Type;

export const BotListInput = Schema.Struct({});
export type BotListInput = typeof BotListInput.Type;

export const BotListResult = Schema.Struct({
  bots: ForwardCompatibleArray(Bot),
  settings: BotsSharedSettings,
});
export type BotListResult = typeof BotListResult.Type;

export const BotCreateInput = Schema.Struct({
  name: BotName,
  role: Schema.optional(BotRole),
  avatar: Schema.optional(BotAvatar),
  model: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optional(RuntimeMode),
  /** Standing instructions, written after the managed block in AGENTS.md. */
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_CHARS)),
  ),
  primary: Schema.optional(Schema.Boolean),
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotMutationResult = Schema.Struct({ bot: Bot });
export type BotMutationResult = typeof BotMutationResult.Type;

export const BotUpdateInput = Schema.Struct({
  id: BotId,
  name: Schema.optional(BotName),
  role: Schema.optional(BotRole),
  avatar: Schema.optional(BotAvatar),
  model: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optional(RuntimeMode),
  pinned: Schema.optional(Schema.Boolean),
  order: Schema.optional(Schema.Number),
  primary: Schema.optional(Schema.Boolean),
  memoryTidy: Schema.optional(BotMemoryTidy),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

export const BotDeleteInput = Schema.Struct({ id: BotId });
export type BotDeleteInput = typeof BotDeleteInput.Type;

export const BotDeleteResult = Schema.Struct({ id: BotId });
export type BotDeleteResult = typeof BotDeleteResult.Type;

export const BotMemoryScope = Schema.Literals(["bot", "shared"]);
export type BotMemoryScope = typeof BotMemoryScope.Type;

export const BotTextFile = Schema.Struct({
  /** How the editor names the file, relative to the bots root or the Bot's folder. */
  path: Schema.String,
  text: Schema.String,
  /** sha256 of the normalized text; a save sends it back. */
  revision: Schema.String,
});
export type BotTextFile = typeof BotTextFile.Type;

export const BotGetMemoryInput = Schema.Struct({
  /** Omit to read only the shared memory. */
  id: Schema.optional(BotId),
});
export type BotGetMemoryInput = typeof BotGetMemoryInput.Type;

export const BotGetMemoryResult = Schema.Struct({
  bot: Schema.NullOr(BotTextFile),
  shared: BotTextFile,
});
export type BotGetMemoryResult = typeof BotGetMemoryResult.Type;

export const BotSaveMemoryInput = Schema.Struct({
  scope: BotMemoryScope,
  /** Required for the `bot` scope. */
  id: Schema.optional(BotId),
  text: Schema.String.check(Schema.isMaxLength(BOT_MEMORY_FILE_MAX_CHARS)),
  expectedRevision: Schema.String,
});
export type BotSaveMemoryInput = typeof BotSaveMemoryInput.Type;

export const BotSaveTextResult = Schema.Struct({ revision: Schema.String });
export type BotSaveTextResult = typeof BotSaveTextResult.Type;

export const BotGetInstructionsInput = Schema.Struct({ id: BotId });
export type BotGetInstructionsInput = typeof BotGetInstructionsInput.Type;

export const BotGetInstructionsResult = Schema.Struct({
  text: Schema.String,
  revision: Schema.String,
});
export type BotGetInstructionsResult = typeof BotGetInstructionsResult.Type;

export const BotSaveInstructionsInput = Schema.Struct({
  id: BotId,
  text: Schema.String.check(Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_CHARS)),
  expectedRevision: Schema.String,
});
export type BotSaveInstructionsInput = typeof BotSaveInstructionsInput.Type;

export const BotSaveSettingsInput = Schema.Struct({
  userName: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
  alwaysAsk: Schema.optional(Schema.Array(Schema.String)),
  allowWithoutAsking: Schema.optional(Schema.Array(Schema.String)),
  mainBotId: Schema.optional(Schema.NullOr(BotId)),
});
export type BotSaveSettingsInput = typeof BotSaveSettingsInput.Type;

export const BotSaveSettingsResult = Schema.Struct({ settings: BotsSharedSettings });
export type BotSaveSettingsResult = typeof BotSaveSettingsResult.Type;

export class BotNotFoundError extends Schema.TaggedError<BotNotFoundError>()("BotNotFoundError", {
  id: BotId,
}) {
  override get message(): string {
    return `Bot ${this.id} was not found.`;
  }
}

/** The file changed since the editor loaded it; `currentText` is what it holds now. */
export class BotConflictError extends Schema.TaggedError<BotConflictError>()("BotConflictError", {
  currentText: Schema.String,
  revision: Schema.String,
}) {
  override get message(): string {
    return "This changed since you opened it.";
  }
}

export class BotStorageError extends Schema.TaggedError<BotStorageError>()("BotStorageError", {
  operation: Schema.Literals([
    "list",
    "read",
    "write",
    "trash",
    "create-project",
    "update-project",
    "delete-project",
    "launch-thread",
    "configure-thread",
    "resolve-model",
  ]),
  id: Schema.optional(BotId),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Bot storage failed during ${this.operation}.`;
  }
}

/** The request is wrong, nothing failed. */
export class BotInvalidError extends Schema.TaggedError<BotInvalidError>()("BotInvalidError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const BotError = Schema.Union([
  BotNotFoundError,
  BotConflictError,
  BotStorageError,
  BotInvalidError,
]);
export type BotError = typeof BotError.Type;
