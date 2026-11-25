import { OrchestratorMcpFailure, PreviewTabId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
import * as BotVault from "../../../bots/BotVault.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
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
);
