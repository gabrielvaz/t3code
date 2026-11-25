// Adapted from Threebot server/vault-mcp.mts (MIT, Copyright (c) 2026 Threebot contributors).
//
// The Bots' Vault tools. A Bot never sees a website password: T3 types it into the Bot's own
// browser tab after checking the tab is on the login's site. Results and errors never carry secrets.
import {
  type BotVaultError,
  OrchestratorMcpFailure,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotService from "../../../bots/BotService.ts";
import * as BotVault from "../../../bots/BotVault.ts";
import { hostOf, matchesSite, siteDomain } from "../../../bots/BotVault.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { BotsToolkit } from "./tools.ts";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const fromVault = (error: BotVaultError) =>
  failure(
    error.reason === "invalid" || error.reason === "not-found"
      ? "invalid_request"
      : "orchestration_error",
    error.message,
  );

/** The tools are listed only in a Bot's thread; calls are checked again here. */
const requireBot = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const bots = yield* BotService.BotService;
  const bot = scope.thread === undefined ? null : yield* bots.botForThread(scope.thread.threadId);
  if (bot === null) {
    return yield* failure("capability_denied", "Vault tools work only in a Bot's own thread.");
  }
  return bot;
});

interface Tab {
  readonly tabId: PreviewTabId;
  readonly url: string;
}

const fill = (field: "username" | "password") =>
  McpToolAccess.actsAsCaller(
    ({ loginId, tabId }: { readonly loginId: string; readonly tabId?: PreviewTabId | undefined }) =>
      Effect.gen(function* () {
        yield* requireBot;
        const vault = yield* BotVault.BotVault;
        const login = yield* vault.login(loginId).pipe(Effect.mapError(fromVault));
        const value = field === "password" ? login.password : login.username;
        if (!value) return yield* failure("invalid_request", `That login has no saved ${field}.`);
        const domains = login.websites.map(siteDomain).filter(Boolean);
        if (domains.length === 0) {
          return yield* failure(
            "invalid_request",
            "That login has no website saved, so it fills nowhere. Ask the user to add one in Settings › Bots › Vault.",
          );
        }

        const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
          Effect.mapError(() =>
            failure("capability_denied", "This thread has no browser to fill into."),
          ),
        );
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const status = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            operation: "status",
            input: {},
            updateCurrentTab: false,
            ...(tabId === undefined ? {} : { tabId }),
          })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        const tabs: ReadonlyArray<Tab> = (
          status.tabs ?? (status.tabId === null ? [] : [{ tabId: status.tabId, url: status.url }])
        ).flatMap((tab) => (tab.url === null ? [] : [{ tabId: tab.tabId, url: tab.url }]));
        const onSite = (tab: Tab) => login.websites.some((site) => matchesSite(tab.url, site));

        let tab: Tab | undefined;
        if (tabId !== undefined) {
          tab =
            tabs.find((entry) => entry.tabId === tabId) ??
            (status.tabId === tabId && status.url !== null
              ? { tabId, url: status.url }
              : undefined);
          if (tab === undefined) {
            return yield* failure("invalid_request", "That tab isn't open in your browser.");
          }
        } else if (tabs.length === 0) {
          return yield* failure(
            "invalid_request",
            "You have no browser tab open. Open the site's sign-in page first.",
          );
        } else if (tabs.length === 1) {
          tab = tabs[0];
        } else {
          const matching = tabs.filter(onSite);
          tab =
            matching.length === 1
              ? matching[0]
              : matching.find((entry) => entry.tabId === status.tabId);
          if (tab === undefined) {
            return yield* failure(
              "invalid_request",
              `Several tabs are open; pass tabId. Tabs: ${tabs.map((entry) => `${entry.tabId} (${hostOf(entry.url)})`).join(", ")}`,
            );
          }
        }
        if (tab === undefined || !onSite(tab)) {
          return yield* failure(
            "capability_denied",
            `Refused: the tab is on ${tab === undefined ? "an unknown page" : hostOf(tab.url) || "an unknown page"}, but this login is saved for ${domains.join(", ")} and their subdomains. A lookalike site could take it. Ask the user whether this is the same service; they can add the site in Settings › Bots › Vault.`,
          );
        }
        const target = tab;
        yield* broker
          .invoke({ scope, operation: "type", input: { text: value }, tabId: target.tabId })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        const site = login.websites.find((entry) => matchesSite(target.url, entry)) ?? "";
        return { filled: true, field, site: siteDomain(site), tabId: target.tabId };
      }),
  );

export const layer = McpToolAccess.toLayer(BotsToolkit, {
  vault_list: McpToolAccess.readsAsCaller(({ kind, search }) =>
    Effect.gen(function* () {
      yield* requireBot;
      const vault = yield* BotVault.BotVault;
      const { items } = yield* vault.list.pipe(Effect.mapError(fromVault));
      const query = search?.trim().toLowerCase() ?? "";
      return {
        items: items.flatMap((item) => {
          if (item === undefined || (kind !== undefined && item.kind !== kind)) return [];
          const { createdAt: _createdAt, updatedAt: _updatedAt, ...visible } = item;
          if (query && !JSON.stringify(visible).toLowerCase().includes(query)) return [];
          return [visible];
        }),
      };
    }),
  ),
  vault_fill_username: fill("username"),
  vault_fill_password: fill("password"),
  vault_save_login: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireBot;
      const vault = yield* BotVault.BotVault;
      const { item, updated } = yield* vault
        .saveLoginFromSecretFile(input)
        .pipe(Effect.mapError(fromVault));
      return {
        saved: true,
        updated,
        loginId: item.id,
        title: item.title,
        apiToken: item.botCanRead,
      };
    }),
  ),
  vault_save_contact: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireBot;
      const vault = yield* BotVault.BotVault;
      const { item } = yield* vault
        .upsert({ kind: "contact", ...input })
        .pipe(Effect.mapError(fromVault));
      return { saved: true, contactId: item.id };
    }),
  ),
  vault_secret_file: McpToolAccess.actsAsCaller(({ loginId }) =>
    Effect.gen(function* () {
      yield* requireBot;
      const vault = yield* BotVault.BotVault;
      const login = yield* vault.login(loginId).pipe(Effect.mapError(fromVault));
      if (!login.botCanRead) {
        return yield* failure(
          "capability_denied",
          'That\'s a website password, which Bots never read. Fill it with vault_fill_password. If it really is an API token, ask the user to turn on "Bots can read this" in Settings › Bots › Vault.',
        );
      }
      if (!login.password)
        return yield* failure("invalid_request", "That login has no saved token.");
      return yield* vault.writeSecretFile(login).pipe(Effect.mapError(fromVault));
    }),
  ),
});
