import {
  BOT_BOARD_FIELD_NAMES,
  BOT_BOARD_KINDS,
  BOT_BOARD_MAX_BATCH,
  BOT_BOARD_PRIORITIES,
  BOT_BOARD_STATUSES,
  BotBoardLink,
  OrchestratorMcpFailure,
  PreviewTabId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as BotProjectsBoard from "../../../bots/BotProjectsBoard.ts";
import * as BotService from "../../../bots/BotService.ts";
import * as BotVault from "../../../bots/BotVault.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    BotProjectsBoard.BotProjectsBoard,
    BotService.BotService,
    BotVault.BotVault,
    McpInvocationContext.McpInvocationContext,
    PreviewAutomationBroker.PreviewAutomationBroker,
    ThreadManagementService.ThreadManagementService,
  ],
};

const Text = Schema.String.check(Schema.isMaxLength(4_000));
const LoginId = Schema.String.annotate({ description: "The login's id from vault_list." });

const VaultListLogin = Schema.Struct({
  kind: Schema.Literal("login"),
  id: Schema.String,
  title: Schema.String,
  websites: Schema.Array(Schema.String),
  username: Schema.String,
  hints: Schema.String,
  botCanRead: Schema.Boolean,
  hasPassword: Schema.Boolean,
});

const VaultListContact = Schema.Struct({
  kind: Schema.Literal("contact"),
  id: Schema.String,
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
});

const FillInput = Schema.Struct({
  loginId: LoginId,
  tabId: Schema.optional(PreviewTabId),
});

const FillResult = Schema.Struct({
  filled: Schema.Boolean,
  field: Schema.Literals(["username", "password"]),
  site: Schema.String,
  tabId: Schema.String,
});

const botTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenUnlessBotThread) as T;

const boardTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenUnlessBotBoard) as T;

const statusHelp = Object.entries(BOT_BOARD_STATUSES)
  .filter(([, list]) => list.length > 0)
  .map(([kind, list]) => `${kind}: ${list.join("|")}`)
  .join("; ");
const NullableId = Schema.optional(Schema.NullOr(Schema.String));
const BoardLinks = Schema.Array(BotBoardLink);
const BoardJson = Schema.Record(Schema.String, Schema.Json);

const BoardItemInput = Schema.Struct({
  id: Schema.optional(
    Schema.String.annotate({
      description: "Leave out to create. Give an id to change only what you pass.",
    }),
  ),
  ref: Schema.optional(
    Schema.String.annotate({
      description:
        'Names a new item so others in this call can use parentId or machineId "ref:<name>".',
    }),
  ),
  kind: Schema.optional(Schema.Literals(BOT_BOARD_KINDS)),
  title: Schema.optional(Schema.String),
  status: Schema.optional(
    Schema.NullOr(Schema.String).annotate({ description: `By kind: ${statusHelp}.` }),
  ),
  area: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: "e.g. work or personal. Reuse areas already on the board.",
    }),
  ),
  parentId: NullableId.annotate({ description: "The project it belongs to; null takes it out." }),
  machineId: NullableId.annotate({ description: "For services and repos: the machine item." }),
  body: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: "Markdown notes. Replaces the old body; read it first with projects_get.",
    }),
  ),
  fields: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.NullOr(Schema.Union([Schema.String, Schema.Number, Schema.Array(Schema.String)])),
    ).annotate({
      description: `Merged into existing ones; null removes one. ${BOT_BOARD_FIELD_NAMES.join(", ")}. due is YYYY-MM-DD, priority ${BOT_BOARD_PRIORITIES.join("|")}, tags a list.`,
    }),
  ),
  addLinks: Schema.optional(
    BoardLinks.annotate({
      description:
        "thread {threadId, environmentId?}, bot {slug}, item {id} or url {url}; each may have a label.",
    }),
  ),
  removeLinks: Schema.optional(BoardLinks),
  pinned: Schema.optional(Schema.Boolean),
  order: Schema.optional(Schema.NullOr(Schema.Number)),
  archived: Schema.optional(
    Schema.Boolean.annotate({ description: "true hides it without deleting; false restores." }),
  ),
});

export const BotsToolkit = Toolkit.make(
  botTool(
    Tool.make("vault_list", {
      ...shared,
      description:
        "List the user's saved logins (id, sites, username, hints, botCanRead; never secrets) and contact info. Call first whenever a site needs signing in, an API needs a token, or a form needs the user's details.",
      parameters: Schema.Struct({
        kind: Schema.optional(Schema.Literals(["login", "contact"])),
        search: Schema.optional(
          Schema.String.annotate({ description: "Match site, title, username or name." }),
        ),
      }),
      success: Schema.Struct({
        items: Schema.Array(Schema.Union([VaultListLogin, VaultListContact])),
      }),
    })
      .annotate(Tool.Readonly, true)
      .annotate(Tool.Destructive, false)
      .annotate(Tool.Idempotent, true),
  ),
  botTool(
    Tool.make("vault_fill_username", {
      ...shared,
      description:
        "Type a saved login's username into the focused field of your browser tab. Works only when the tab is on one of the login's sites or their subdomains.",
      parameters: FillInput,
      success: FillResult,
    }).annotate(Tool.Destructive, false),
  ),
  botTool(
    Tool.make("vault_fill_password", {
      ...shared,
      description:
        "Type a saved login's password into the focused field of your browser tab; you never see it. Click into the site's password field first. Works only when the tab is on one of the login's sites or their subdomains. Take a fresh snapshot after.",
      parameters: FillInput,
      success: FillResult,
    }).annotate(Tool.Destructive, false),
  ),
  botTool(
    Tool.make("vault_save_login", {
      ...shared,
      description:
        'Save a password, API token or key to the Vault. First get it with request_secret, delivery "file"; pass that file here unread. The file is deleted. Same site and username updates the saved login.',
      parameters: Schema.Struct({
        website: Text.annotate({ description: "e.g. https://github.com" }),
        secretFile: Schema.String.annotate({ description: "The file request_secret returned." }),
        username: Schema.optional(Text),
        title: Schema.optional(Text),
        hints: Schema.optional(Text.annotate({ description: "When to use it." })),
        apiToken: Schema.optional(
          Schema.Boolean.annotate({
            description:
              "true for an API token or key you must read (vault_secret_file). False for website passwords.",
          }),
        ),
      }),
      success: Schema.Struct({
        saved: Schema.Boolean,
        updated: Schema.Boolean,
        loginId: Schema.String,
        title: Schema.String,
        apiToken: Schema.Boolean,
      }),
    }).annotate(Tool.Destructive, false),
  ),
  botTool(
    Tool.make("vault_save_contact", {
      ...shared,
      description:
        "Save contact info the user gave you in chat (name, emails, phones, address) to the Vault for forms. Check vault_list first to avoid duplicates.",
      parameters: Schema.Struct({
        label: Schema.optional(Text.annotate({ description: 'e.g. "Home" or "Work".' })),
        name: Schema.optional(Text),
        emails: Schema.optional(Schema.Array(Text)),
        phones: Schema.optional(Schema.Array(Text)),
        street: Schema.optional(Text),
        apt: Schema.optional(Text),
        city: Schema.optional(Text),
        state: Schema.optional(Text),
        zip: Schema.optional(Text),
        country: Schema.optional(Text),
      }),
      success: Schema.Struct({ saved: Schema.Boolean, contactId: Schema.String }),
    }).annotate(Tool.Destructive, false),
  ),
  botTool(
    Tool.make("vault_secret_file", {
      ...shared,
      description:
        'Write a saved API token (botCanRead) to a private file, read inside a command: TOKEN="$(cat <file>)". Never print it. Deleted after an hour. Website passwords are refused; use vault_fill_password.',
      parameters: Schema.Struct({ loginId: LoginId }),
      success: Schema.Struct({
        file: Schema.String,
        expiresInMinutes: Schema.Number,
      }),
    }).annotate(Tool.Destructive, false),
  ),
  boardTool(
    Tool.make("projects_overview", {
      ...shared,
      description:
        "The user's Projects board at a glance: projects with open to-do counts, open to-dos by priority and due date, machines with what runs on each, and recent changes. Read it before adding things so you don't duplicate.",
      success: BoardJson,
    })
      .annotate(Tool.Readonly, true)
      .annotate(Tool.Destructive, false)
      .annotate(Tool.Idempotent, true),
  ),
  boardTool(
    Tool.make("projects_find", {
      ...shared,
      description:
        "Search the Projects board by words (titles, notes, tags, paths, hosts) or filter by kind, status, area, parent, machine or a linked thread.",
      parameters: Schema.Struct({
        search: Schema.optional(Schema.String),
        kind: Schema.optional(Schema.Literals(BOT_BOARD_KINDS)),
        status: Schema.optional(Schema.String),
        open: Schema.optional(Schema.Boolean.annotate({ description: "Only to-dos not done." })),
        area: Schema.optional(Schema.String),
        parentId: Schema.optional(Schema.String),
        machineId: Schema.optional(Schema.String),
        threadId: Schema.optional(Schema.String),
        includeArchived: Schema.optional(Schema.Boolean),
        limit: Schema.optional(Schema.Number),
      }),
      success: Schema.Struct({ total: Schema.Number, items: Schema.Array(BoardJson) }),
    })
      .annotate(Tool.Readonly, true)
      .annotate(Tool.Destructive, false)
      .annotate(Tool.Idempotent, true),
  ),
  boardTool(
    Tool.make("projects_get", {
      ...shared,
      description:
        "One board item in full: notes, fields, links, what's inside it, what runs on it (machines) and what links to it.",
      parameters: Schema.Struct({ id: Schema.String }),
      success: BoardJson,
    })
      .annotate(Tool.Readonly, true)
      .annotate(Tool.Destructive, false)
      .annotate(Tool.Idempotent, true),
  ),
  boardTool(
    Tool.make("projects_save", {
      ...shared,
      description: `Create or change Projects board items, up to ${BOT_BOARD_MAX_BATCH} at once, all or nothing. The user sees each change at once. To add a project with its to-dos in one call, give the project ref "x" and the to-dos parentId "ref:x". Mark a to-do done with status "done".`,
      parameters: Schema.Struct({
        items: Schema.Array(BoardItemInput).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(BOT_BOARD_MAX_BATCH),
        ),
      }),
      success: Schema.Struct({
        saved: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            kind: Schema.String,
            title: Schema.String,
            status: Schema.optional(Schema.String),
          }),
        ),
        note: Schema.optional(Schema.String),
      }),
    }).annotate(Tool.Destructive, false),
  ),
  boardTool(
    Tool.make("projects_delete", {
      ...shared,
      description:
        "Delete board items for good; what's inside moves up to their parent. Prefer archived: true with projects_save unless the user wants it gone.",
      parameters: Schema.Struct({
        ids: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
      }),
      success: Schema.Struct({ deleted: Schema.Array(Schema.String) }),
    }).annotate(Tool.Destructive, true),
  ),
);
