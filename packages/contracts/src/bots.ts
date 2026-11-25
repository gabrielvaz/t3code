import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
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

/** How Executor answers its own approval prompts for this Bot: ask the model, or approve them. */
export const BotExecutorApproval = Schema.Literals(["ask", "automatic"]);
export type BotExecutorApproval = typeof BotExecutorApproval.Type;

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
  executorApproval: BotExecutorApproval.pipe(Schema.withDecodingDefault(Effect.succeed("ask"))),
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
  executorApproval: Schema.optional(BotExecutorApproval),
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

/** One Vault field; longer text is refused. */
export const BOT_VAULT_FIELD_MAX_CHARS = 4_000;
/** Websites, emails or phones on one item. */
export const BOT_VAULT_LIST_MAX = 20;
export const BOT_VAULT_MAX_ITEMS = 10_000;

const VaultText = Schema.String.check(Schema.isMaxLength(BOT_VAULT_FIELD_MAX_CHARS));
const VaultTextList = Schema.Array(VaultText).check(Schema.isMaxLength(BOT_VAULT_LIST_MAX));

export const BotVaultItemId = TrimmedNonEmptyString.pipe(Schema.brand("BotVaultItemId"));
export type BotVaultItemId = typeof BotVaultItemId.Type;

export const BotVaultItemKind = Schema.Literals(["login", "contact"]);
export type BotVaultItemKind = typeof BotVaultItemKind.Type;

/** A login as clients and Bots see it: never the password. */
export const BotVaultLoginSummary = Schema.Struct({
  kind: Schema.Literal("login"),
  id: BotVaultItemId,
  title: Schema.String,
  /** Where it fills: each site and its subdomains. Primary first. */
  websites: Schema.Array(Schema.String),
  username: Schema.String,
  hints: Schema.String,
  /** An API token or key Bots may read into a private file; other passwords are only typed into pages. */
  botCanRead: Schema.Boolean,
  hasPassword: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotVaultLoginSummary = typeof BotVaultLoginSummary.Type;

const contactFields = {
  label: Schema.String,
  name: Schema.String,
  emails: Schema.Array(Schema.String),
  phones: Schema.Array(Schema.String),
  street: Schema.String,
  apt: Schema.String,
  city: Schema.String,
  state: Schema.String,
  zip: Schema.String,
  country: Schema.String,
};

export const BotVaultContact = Schema.Struct({
  kind: Schema.Literal("contact"),
  id: BotVaultItemId,
  ...contactFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotVaultContact = typeof BotVaultContact.Type;

export const BotVaultListItem = Schema.Union([BotVaultLoginSummary, BotVaultContact]);
export type BotVaultListItem = typeof BotVaultListItem.Type;

export const BotVaultListInput = Schema.Struct({});
export type BotVaultListInput = typeof BotVaultListInput.Type;

export const BotVaultListResult = Schema.Struct({
  items: ForwardCompatibleArray(BotVaultListItem),
});
export type BotVaultListResult = typeof BotVaultListResult.Type;

export const BotVaultLoginInput = Schema.Struct({
  kind: Schema.Literal("login"),
  /** Omit to add a login. */
  id: Schema.optional(BotVaultItemId),
  title: Schema.optional(VaultText),
  websites: Schema.optional(VaultTextList),
  username: Schema.optional(VaultText),
  /** Omit to keep the saved password. */
  password: Schema.optional(VaultText),
  hints: Schema.optional(VaultText),
  botCanRead: Schema.optional(Schema.Boolean),
});
export type BotVaultLoginInput = typeof BotVaultLoginInput.Type;

export const BotVaultContactInput = Schema.Struct({
  kind: Schema.Literal("contact"),
  id: Schema.optional(BotVaultItemId),
  label: Schema.optional(VaultText),
  name: Schema.optional(VaultText),
  emails: Schema.optional(VaultTextList),
  phones: Schema.optional(VaultTextList),
  street: Schema.optional(VaultText),
  apt: Schema.optional(VaultText),
  city: Schema.optional(VaultText),
  state: Schema.optional(VaultText),
  zip: Schema.optional(VaultText),
  country: Schema.optional(VaultText),
});
export type BotVaultContactInput = typeof BotVaultContactInput.Type;

export const BotVaultUpsertInput = Schema.Union([BotVaultLoginInput, BotVaultContactInput]);
export type BotVaultUpsertInput = typeof BotVaultUpsertInput.Type;

export const BotVaultUpsertResult = Schema.Struct({ item: BotVaultListItem });
export type BotVaultUpsertResult = typeof BotVaultUpsertResult.Type;

export const BotVaultDeleteInput = Schema.Struct({ id: BotVaultItemId });
export type BotVaultDeleteInput = typeof BotVaultDeleteInput.Type;

export const BotVaultDeleteResult = Schema.Struct({ id: BotVaultItemId });
export type BotVaultDeleteResult = typeof BotVaultDeleteResult.Type;

export const BotVaultRevealInput = Schema.Struct({ id: BotVaultItemId });
export type BotVaultRevealInput = typeof BotVaultRevealInput.Type;

export const BotVaultRevealResult = Schema.Struct({ password: Schema.String });
export type BotVaultRevealResult = typeof BotVaultRevealResult.Type;

/** Rows a client parsed from a password manager's CSV export; the file never leaves the device. */
export const BotVaultImportCsvInput = Schema.Struct({
  items: Schema.Array(
    Schema.Union([
      BotVaultLoginInput.mapFields(Struct.omit(["id"])),
      BotVaultContactInput.mapFields(Struct.omit(["id"])),
    ]),
  ).check(Schema.isMaxLength(BOT_VAULT_MAX_ITEMS)),
});
export type BotVaultImportCsvInput = typeof BotVaultImportCsvInput.Type;
export type BotVaultImportItem = BotVaultImportCsvInput["items"][number];

export const BotVaultImportCsvResult = Schema.Struct({
  added: NonNegativeInt,
  updated: NonNegativeInt,
  skipped: NonNegativeInt,
});
export type BotVaultImportCsvResult = typeof BotVaultImportCsvResult.Type;

export class BotVaultError extends Schema.TaggedError<BotVaultError>()("BotVaultError", {
  reason: Schema.Literals(["locked", "damaged", "not-found", "invalid", "storage"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const BOT_BOARD_KINDS = [
  "project",
  "task",
  "machine",
  "service",
  "repo",
  "note",
  "link",
] as const;
export const BotBoardKind = Schema.Literals(BOT_BOARD_KINDS);
export type BotBoardKind = typeof BotBoardKind.Type;

/** The statuses each kind takes, first is the default (last for machines and services). */
export const BOT_BOARD_STATUSES: Readonly<Record<BotBoardKind, ReadonlyArray<string>>> = {
  project: ["active", "paused", "idea", "done"],
  task: ["todo", "doing", "waiting", "done"],
  machine: ["online", "offline", "unknown"],
  service: ["running", "stopped", "failing", "unknown"],
  repo: ["active", "archived"],
  note: [],
  link: [],
};
export const BOT_BOARD_PRIORITIES = ["high", "normal", "low"] as const;
export const BOT_BOARD_MAX_BATCH = 100;

export const BotBoardActor = Schema.Union([
  Schema.Struct({ type: Schema.Literal("user") }),
  Schema.Struct({
    type: Schema.Literal("bot"),
    name: Schema.optional(Schema.String),
    slug: Schema.optional(Schema.String),
  }),
]);
export type BotBoardActor = typeof BotBoardActor.Type;

const BoardLabel = { label: Schema.optional(Schema.String) };
export const BotBoardLink = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread"),
    threadId: Schema.String,
    environmentId: Schema.optional(Schema.String),
    ...BoardLabel,
  }),
  Schema.Struct({ type: Schema.Literal("bot"), slug: Schema.String, ...BoardLabel }),
  Schema.Struct({ type: Schema.Literal("item"), id: Schema.String, ...BoardLabel }),
  Schema.Struct({ type: Schema.Literal("url"), url: Schema.String, ...BoardLabel }),
]);
export type BotBoardLink = typeof BotBoardLink.Type;

export const BotBoardFieldValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Array(Schema.String),
]);
export type BotBoardFieldValue = typeof BotBoardFieldValue.Type;
export const BOT_BOARD_FIELD_NAMES = [
  "url",
  "path",
  "host",
  "port",
  "branch",
  "due",
  "priority",
  "owner",
  "tags",
] as const;

export const BotBoardItem = Schema.Struct({
  id: Schema.String,
  kind: BotBoardKind,
  title: Schema.String,
  status: Schema.optional(Schema.String),
  area: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  fields: Schema.Record(Schema.String, BotBoardFieldValue),
  links: Schema.Array(BotBoardLink),
  pinned: Schema.Boolean,
  order: Schema.optional(Schema.Number),
  archived: Schema.Boolean,
  doneAt: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  createdBy: BotBoardActor,
  updatedBy: BotBoardActor,
});
export type BotBoardItem = typeof BotBoardItem.Type;

export const BotBoardActivity = Schema.Struct({
  seq: Schema.Number,
  at: Schema.String,
  actor: BotBoardActor,
  itemId: Schema.String,
  kind: BotBoardKind,
  title: Schema.String,
  action: Schema.Literals(["created", "archived", "restored", "completed", "updated", "deleted"]),
  changed: Schema.Array(Schema.String),
});
export type BotBoardActivity = typeof BotBoardActivity.Type;

/** The whole board first, then only what each save or delete changed. */
export const BotBoardEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    version: Schema.Number,
    items: Schema.Array(BotBoardItem),
    activity: Schema.Array(BotBoardActivity),
  }),
  Schema.Struct({
    type: Schema.Literal("change"),
    version: Schema.Number,
    items: Schema.Array(BotBoardItem),
    removed: Schema.Array(Schema.String),
    activity: Schema.Array(BotBoardActivity),
  }),
]);
export type BotBoardEvent = typeof BotBoardEvent.Type;

export const BotBoardSubscribeInput = Schema.Struct({});
export type BotBoardSubscribeInput = typeof BotBoardSubscribeInput.Type;

const NullableText = Schema.optional(Schema.NullOr(Schema.String));

/** Without id, creates an item; with id, changes only what is given. null clears a property. */
export const BotBoardItemInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  kind: Schema.optional(BotBoardKind),
  title: Schema.optional(Schema.String),
  status: NullableText,
  area: NullableText,
  body: NullableText,
  parentId: NullableText,
  machineId: NullableText,
  fields: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(BotBoardFieldValue))),
  ),
  links: Schema.optional(Schema.NullOr(Schema.Array(BotBoardLink))),
  addLinks: Schema.optional(Schema.Array(BotBoardLink)),
  removeLinks: Schema.optional(Schema.Array(BotBoardLink)),
  pinned: Schema.optional(Schema.Boolean),
  order: Schema.optional(Schema.NullOr(Schema.Number)),
  archived: Schema.optional(Schema.Boolean),
});
export type BotBoardItemInput = typeof BotBoardItemInput.Type;

export const BotBoardSaveInput = Schema.Struct({
  items: Schema.Array(BotBoardItemInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BOT_BOARD_MAX_BATCH),
  ),
});
export type BotBoardSaveInput = typeof BotBoardSaveInput.Type;

export const BotBoardSaveResult = Schema.Struct({
  version: Schema.Number,
  items: Schema.Array(BotBoardItem),
  unchanged: Schema.optional(Schema.Boolean),
});
export type BotBoardSaveResult = typeof BotBoardSaveResult.Type;

export const BotBoardDeleteInput = Schema.Struct({
  ids: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type BotBoardDeleteInput = typeof BotBoardDeleteInput.Type;

export const BotBoardDeleteResult = Schema.Struct({
  version: Schema.Number,
  removed: Schema.Array(Schema.String),
});
export type BotBoardDeleteResult = typeof BotBoardDeleteResult.Type;

export class BotBoardError extends Schema.TaggedError<BotBoardError>()("BotBoardError", {
  reason: Schema.Literals(["invalid", "storage", "disabled"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const BotExecutorAccount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  linked: Schema.Boolean,
  signIn: Schema.Literals(["saved", "reconnect", "unavailable"]),
});
export type BotExecutorAccount = typeof BotExecutorAccount.Type;

export const BotExecutorAccountScope = Schema.Literals(["user", "app"]);
export type BotExecutorAccountScope = typeof BotExecutorAccountScope.Type;

export const BotExecutorRequirement = Schema.Struct({
  id: Schema.String,
  scope: BotExecutorAccountScope,
  name: Schema.String,
  cardinality: Schema.Literals(["one", "many"]),
  accounts: Schema.Array(BotExecutorAccount),
});
export type BotExecutorRequirement = typeof BotExecutorRequirement.Type;

export const BotExecutorApp = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["connected", "needs-connection", "ready", "unknown"]),
  requirements: Schema.Array(BotExecutorRequirement),
  error: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
});
export type BotExecutorApp = typeof BotExecutorApp.Type;

export const BotExecutorStatusInput = Schema.Struct({});
export type BotExecutorStatusInput = typeof BotExecutorStatusInput.Type;

export const BotExecutorStatus = Schema.Struct({
  configured: Schema.Boolean,
  backend: Schema.Literals(["self-hosted", "cloud"]),
  organization: Schema.NullOr(Schema.String),
  /** Where the user signs in to apps. */
  publicUrl: Schema.NullOr(Schema.String),
  hasToken: Schema.Boolean,
  /** Both the REST API and the MCP server answered. */
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  apps: Schema.optional(
    Schema.Struct({
      total: NonNegativeInt,
      connected: NonNegativeInt,
      needsConnection: NonNegativeInt,
      ready: NonNegativeInt,
      unknown: NonNegativeInt,
    }),
  ),
  mcpTools: Schema.optional(Schema.Array(Schema.String)),
});
export type BotExecutorStatus = typeof BotExecutorStatus.Type;

export const BotExecutorCatalogInput = Schema.Struct({
  search: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
});
export type BotExecutorCatalogInput = typeof BotExecutorCatalogInput.Type;

export const BotExecutorCatalogEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  icon: Schema.NullOr(Schema.String),
  auth: Schema.Array(Schema.String),
  category: Schema.optional(Schema.String),
});
export type BotExecutorCatalogEntry = typeof BotExecutorCatalogEntry.Type;

export const BotExecutorCatalogResult = Schema.Struct({
  entries: Schema.Array(BotExecutorCatalogEntry),
});
export type BotExecutorCatalogResult = typeof BotExecutorCatalogResult.Type;

export const BotExecutorInstallInput = Schema.Struct({
  entry: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type BotExecutorInstallInput = typeof BotExecutorInstallInput.Type;

export const BotExecutorAppResult = Schema.Struct({ app: BotExecutorApp });
export type BotExecutorAppResult = typeof BotExecutorAppResult.Type;

export const BotExecutorConnectionsInput = Schema.Struct({});
export type BotExecutorConnectionsInput = typeof BotExecutorConnectionsInput.Type;

export const BotExecutorConnectionsResult = Schema.Struct({
  apps: Schema.Array(BotExecutorApp),
});
export type BotExecutorConnectionsResult = typeof BotExecutorConnectionsResult.Type;

const ExecutorRequirementTarget = {
  appId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  requirement: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  scope: BotExecutorAccountScope,
};

export const BotExecutorConnectInput = Schema.Struct({
  ...ExecutorRequirementTarget,
  /** An existing account to sign in again. */
  account: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type BotExecutorConnectInput = typeof BotExecutorConnectInput.Type;

export const BotExecutorConnectResult = Schema.Struct({
  /** Executor's sign-in page for the account. */
  url: Schema.String,
  expiresAt: Schema.String,
});
export type BotExecutorConnectResult = typeof BotExecutorConnectResult.Type;

export const BotExecutorDisconnectInput = Schema.Struct({
  ...ExecutorRequirementTarget,
  account: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type BotExecutorDisconnectInput = typeof BotExecutorDisconnectInput.Type;

export class BotExecutorError extends Schema.TaggedError<BotExecutorError>()("BotExecutorError", {
  reason: Schema.Literals(["not-configured", "unreachable", "rejected", "invalid", "failed"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

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
    "memory-tidy",
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
  BotVaultError,
  BotBoardError,
  BotExecutorError,
]);
export type BotError = typeof BotError.Type;
