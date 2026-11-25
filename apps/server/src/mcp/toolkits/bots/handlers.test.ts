import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type Bot,
  BotVaultError,
  BotVaultItemId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
import * as BotVault from "../../../bots/BotVault.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as BotsHandlers from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const botThreadId = ThreadId.make("thread:bot");
const otherThreadId = ThreadId.make("thread:other");

const login: BotVault.StoredLogin = {
  kind: "login",
  id: BotVaultItemId.make("login-1"),
  title: "PayPal",
  websites: ["https://paypal.com"],
  username: "ada@example.com",
  password: "hunter2",
  hints: "",
  botCanRead: false,
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
};

const scopeFor = (
  threadId: ThreadId,
  botThread: boolean,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:bots"),
  requestNamespace: "session:bots",
  thread: {
    threadId,
    providerSessionId: "session:bots",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "preview"] as const),
  issuedAt: 0,
  ...(botThread ? { botThread } : {}),
});

const harness = (threadId: ThreadId, pageUrl: string) => {
  const typed: Array<unknown> = [];
  const layer = McpToolAccess.HandlersLayer.layer(BotsHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.succeed(
          McpInvocationContext.McpInvocationContext,
          scopeFor(threadId, threadId === botThreadId),
        ),
        Layer.mock(BotService.BotService)({
          botForThread: (id) =>
            Effect.succeed(id === botThreadId ? ({ id: "bot-1" } as unknown as Bot) : null),
        }),
        Layer.mock(BotVault.BotVault)({
          list: Effect.succeed({
            items: [BotVault.summarize(login)],
          }),
          login: (id) =>
            id === login.id
              ? Effect.succeed(login)
              : Effect.fail(new BotVaultError({ reason: "not-found", detail: "No login." })),
        }),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
          invoke: (request) =>
            Effect.sync(() => {
              if (request.operation === "type") {
                typed.push({ tabId: request.tabId, input: request.input });
                return {} as never;
              }
              return {
                tabId: "tab-1",
                url: pageUrl,
                tabs: [{ tabId: "tab-1", url: pageUrl }],
              } as never;
            }),
        }),
      ),
    ),
  );
  return { layer, typed };
};

const call = (name: string, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const toolkit = yield* BotsToolkit;
    return yield* toolkit.handle(name as never, input as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
    );
  });

it.effect("the Vault tools are listed only in a Bot's own thread", () =>
  Effect.gen(function* () {
    const visible = (scope: McpInvocationContext.McpInvocationScope | undefined) =>
      Effect.sync(() => McpInvocationContext.hiddenUnlessBotThread()).pipe(
        scope === undefined
          ? (effect) => effect
          : Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      );
    expect(yield* visible(scopeFor(botThreadId, true))).toBe(true);
    expect(yield* visible(scopeFor(otherThreadId, false))).toBe(false);
    expect(yield* visible({ ...scopeFor(botThreadId, true), thread: undefined })).toBe(false);
    expect(yield* visible(undefined)).toBe(false);
    for (const tool of Object.values(BotsToolkit.tools)) {
      expect(Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen)).toBe(
        McpInvocationContext.hiddenUnlessBotThread,
      );
    }
  }),
);

it.effect("refuses a call from a thread that is not a Bot's", () => {
  const { layer } = harness(otherThreadId, "https://paypal.com/signin");
  return Effect.gen(function* () {
    expect(yield* call("vault_list", {})).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layer));
});

it.effect("lists logins without their passwords", () => {
  const { layer } = harness(botThreadId, "https://paypal.com/signin");
  return Effect.gen(function* () {
    const result = yield* call("vault_list", { kind: "login" });
    expect(result).toMatchObject({ items: [{ id: "login-1", hasPassword: true }] });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  }).pipe(Effect.provide(layer));
});

it.effect("fills the password on the login's site and returns only that it filled", () => {
  const { layer, typed } = harness(botThreadId, "https://www.paypal.com/signin");
  return Effect.gen(function* () {
    const result = yield* call("vault_fill_password", { loginId: "login-1" });
    expect(result).toEqual({ filled: true, field: "password", site: "paypal.com", tabId: "tab-1" });
    expect(typed).toEqual([{ tabId: "tab-1", input: { text: "hunter2" } }]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses to fill on a lookalike site", () => {
  const { layer, typed } = harness(botThreadId, "https://paypal.com.evil.io/signin");
  return Effect.gen(function* () {
    const result = yield* call("vault_fill_password", { loginId: "login-1" });
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(typed).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("never writes a website password to a file", () => {
  const { layer } = harness(botThreadId, "https://paypal.com/");
  return Effect.gen(function* () {
    expect(yield* call("vault_secret_file", { loginId: "login-1" })).toMatchObject({
      code: "capability_denied",
    });
  }).pipe(Effect.provide(layer));
});
