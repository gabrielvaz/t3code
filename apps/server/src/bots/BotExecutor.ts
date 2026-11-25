// @effect-diagnostics globalFetch:off -- the ported client takes fetch as a parameter so tests can stub it
// @effect-diagnostics globalTimers:off -- the probe's abort timer lives inside a Promise, not an Effect
// Adapted from Threebot server/executor-config.mts, executor-client.mts and executor-probe.mts
// (MIT, Copyright (c) 2026 Threebot contributors).
//
// Executor (https://executor.sh) holds the user's app accounts and serves them to Bots as one MCP
// server. T3 reads its REST API for Settings › Bots › Connected apps, and checks its MCP server the
// way a Bot's harness will reach it. Tokens never leave this module except as request headers.
import {
  type BotExecutorAccount,
  type BotExecutorAccountScope,
  type BotExecutorApp,
  type BotExecutorCatalogEntry,
  BotExecutorError,
  type BotExecutorRequirement,
  type BotExecutorStatus,
  type BotsExecutorSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";

export interface ExecutorProfile {
  readonly kind: "self-hosted" | "cloud";
  readonly organization: string;
  readonly apiUrl: string;
  readonly publicUrl: string;
  readonly mcpUrl: string;
  readonly skippedApps: ReadonlyArray<string>;
}

type Json = Record<string, unknown>;
type Fetch = typeof globalThis.fetch;

const object = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const fail = (reason: BotExecutorError["reason"], detail: string) =>
  new BotExecutorError({ reason, detail });
const isExecutorError = Schema.is(BotExecutorError);

function address(value: string, label: string, options: { https?: boolean; query?: boolean } = {}) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail("invalid", `The ${label} isn't a valid address.`);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (!options.query && url.search) ||
    (options.https && url.protocol !== "https:")
  ) {
    throw fail("invalid", `The ${label} isn't a valid address.`);
  }
  return url.href.replace(/\/$/, "");
}

/**
 * The Executor profile the settings describe, or null when they name no Executor yet.
 * Throws a BotExecutorError for an address that can't be used.
 */
export function executorProfile(settings: BotsExecutorSettings): ExecutorProfile | null {
  const organization = settings.organization.trim();
  if (organization.length > 256 || /[\u0000-\u001f]/.test(organization)) {
    throw fail("invalid", "The Executor organization name looks wrong.");
  }
  if (settings.backend === "cloud") {
    if (!organization) return null;
    const apiUrl = address(settings.url.trim() || "https://app.executor.sh", "Executor API URL", {
      https: true,
    });
    const mcpUrl = address(
      settings.mcpUrl.trim() ||
        `https://mcp.executor.sh/org/${encodeURIComponent(organization)}/mcp`,
      "Executor MCP URL",
      { https: true, query: true },
    );
    const route = new URL(mcpUrl).pathname.match(/^\/org\/([^/]+)\/mcp$/);
    if (route && decodeURIComponent(route[1]!) !== organization) {
      throw fail("invalid", "The Executor MCP URL names another organization.");
    }
    return {
      kind: "cloud",
      organization,
      apiUrl,
      publicUrl: address(settings.publicUrl.trim() || apiUrl, "Executor public URL", {
        https: true,
      }),
      mcpUrl,
      skippedApps: settings.skippedApps.map((name) => name.trim()).filter(Boolean),
    };
  }
  const url = settings.url.trim();
  if (!url) return null;
  const apiUrl = address(url, "Executor URL");
  return {
    kind: "self-hosted",
    organization: organization || "executor",
    apiUrl,
    publicUrl: address(settings.publicUrl.trim() || apiUrl, "Executor public URL"),
    mcpUrl: address(
      settings.mcpUrl.trim() ||
        `${apiUrl}${organization ? `/org/${encodeURIComponent(organization)}` : ""}/mcp`,
      "Executor MCP URL",
      { query: true },
    ),
    skippedApps: [],
  };
}

/** The headers a harness sends to Executor's MCP server. */
export function executorMcpHeaders(
  profile: ExecutorProfile,
  token: string,
): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${token}`,
    ...(profile.kind === "cloud" ? { "X-Executor-Organization": profile.organization } : {}),
  };
}

/** Executor's MCP URL for one Bot: `ask` lets the model answer approvals, `automatic` approves. */
export function executorMcpUrl(profile: ExecutorProfile, approval: "ask" | "automatic"): string {
  const url = new URL(profile.mcpUrl);
  url.searchParams.set("elicitation_mode", approval === "automatic" ? "automatic" : "model");
  return url.href.replace(/\/$/, "");
}

const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i;
/** A public logo for the app: a plain web address, or a small inline image Executor stores. */
export function appIcon(icons: unknown): string | null {
  if (!Array.isArray(icons)) return null;
  // Logos sit on a light tile, so a dark-theme variant is the last choice.
  const sorted = [...icons].sort(
    (a, b) => Number(object(a) && a.theme === "dark") - Number(object(b) && b.theme === "dark"),
  );
  for (const item of sorted) {
    if (!object(item) || !nonEmpty(item.src)) continue;
    if (IMAGE_DATA.test(item.src)) {
      if (item.src.length <= 64 * 1024) return item.src;
      continue;
    }
    try {
      const url = new URL(item.src);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
        return url.href;
      }
    } catch {
      // Not a logo.
    }
  }
  return null;
}

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The site behind an app's sign-in host, so mcp.example.com shows example.com's logo. */
function appSiteDomain(accounts: unknown): string | null {
  if (!object(accounts)) return null;
  for (const item of Object.values(accounts)) {
    const hosts = object(item) && object(item.definition) ? item.definition.hosts : undefined;
    for (const value of Array.isArray(hosts) ? hosts : []) {
      const host = typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : "";
      if (!HOST.test(host)) continue;
      const labels = host.split(".");
      // Keep three labels for two-letter country suffixes such as example.co.uk.
      const keep =
        labels.length > 2 && labels.at(-1)!.length === 2 && labels.at(-2)!.length <= 3 ? 3 : 2;
      return labels.slice(-keep).join(".");
    }
  }
  return null;
}

async function concurrent<T, R>(items: ReadonlyArray<T>, transform: (item: T) => Promise<R>) {
  const result: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await transform(items[index]!);
      }
    }),
  );
  return result;
}

const segment = (value: string) => {
  if (!nonEmpty(value) || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    throw fail("invalid", "That Executor identifier looks wrong.");
  }
  return encodeURIComponent(value);
};

/** The same REST contract is hosted and self-hosted. */
export function createExecutorClient(profile: ExecutorProfile, token: string, request: Fetch) {
  const base = `${profile.apiUrl}/api/organizations/${segment(profile.organization)}`;
  async function api(route: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await request(base + route, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    } catch {
      throw fail("unreachable", "Executor is not reachable right now.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw fail("rejected", "Executor rejected the access token.");
      if (response.status === 403) throw fail("rejected", "Executor does not permit this.");
      if (response.status === 404) throw fail("failed", "This Executor app or connection is gone.");
      throw fail("failed", "Executor could not complete this request.");
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw fail("failed", "Executor returned an invalid response.");
    }
  }
  const appPath = (id: string) => `/apps/${segment(id)}`;
  const invalidResponse = (what: string) => fail("failed", `Executor returned ${what}.`);

  function requirements(value: unknown): Array<Omit<BotExecutorRequirement, "accounts">> {
    if (!object(value)) throw invalidResponse("no account requirements");
    return Object.entries(value).map(([id, item]) => {
      if (
        !object(item) ||
        (item.scope !== "user" && item.scope !== "app") ||
        (item.cardinality !== "one" && item.cardinality !== "many")
      ) {
        throw invalidResponse("invalid account requirements");
      }
      const definition = object(item.definition) ? item.definition : {};
      return {
        id,
        scope: item.scope,
        name: nonEmpty(definition.name) ? definition.name : id,
        cardinality: item.cardinality,
      };
    });
  }

  async function app(id: string): Promise<BotExecutorApp> {
    const raw = await api(appPath(id));
    if (!object(raw) || raw.id !== id || !nonEmpty(raw.slug) || !nonEmpty(raw.name)) {
      throw invalidResponse("an invalid app");
    }
    const declared = object(raw.requirements) ? raw.requirements : {};
    const definitions = requirements(declared.accounts);
    const scopes = [...new Set(definitions.map((item) => item.scope))];
    const links = new Map(
      await concurrent(scopes, async (scope): Promise<[BotExecutorAccountScope, Json[]]> => {
        const rows = await api(`${appPath(id)}/accounts/${scope}`);
        if (
          !Array.isArray(rows) ||
          rows.some(
            (row) =>
              !object(row) ||
              !nonEmpty(row.requirement) ||
              !object(row.account) ||
              !nonEmpty(row.account.id),
          )
        ) {
          throw invalidResponse("no account links");
        }
        return [scope, rows as Json[]];
      }),
    );
    const choices = await concurrent(definitions, async (definition) => {
      const rawChoices = await api(
        `${appPath(id)}/accounts/${definition.scope}/${segment(definition.id)}`,
      );
      if (
        !object(rawChoices) ||
        rawChoices.requirement !== definition.id ||
        rawChoices.scope !== definition.scope ||
        !Array.isArray(rawChoices.accounts)
      ) {
        throw invalidResponse("no account choices");
      }
      const accounts = rawChoices.accounts.map((choice: unknown): BotExecutorAccount => {
        if (!object(choice) || typeof choice.linked !== "boolean" || !object(choice.account)) {
          throw invalidResponse("invalid account choices");
        }
        const account = choice.account;
        if (!nonEmpty(account.id)) throw invalidResponse("an invalid account");
        const name = nonEmpty(account.label)
          ? account.label
          : nonEmpty(account.name)
            ? account.name
            : account.id;
        const link = links
          .get(definition.scope)
          ?.find(
            (row) =>
              row.requirement === definition.id &&
              object(row.account) &&
              row.account.id === account.id,
          );
        const state = link && object(link.signIn) ? link.signIn.state : undefined;
        return {
          id: account.id,
          name,
          linked: choice.linked,
          signIn: choice.linked
            ? state === "saved" || state === "reconnect" || state === "unavailable"
              ? state
              : "unavailable"
            : "saved",
        };
      });
      return { ...definition, accounts };
    });
    const connected = choices.every((requirement) => {
      const linked = requirement.accounts.filter(
        (entry) => entry.linked && entry.signIn === "saved",
      );
      return requirement.cardinality === "one" ? linked.length === 1 : linked.length > 0;
    });
    const icon = appIcon(declared.icons);
    const domain = appSiteDomain(declared.accounts);
    return {
      id,
      slug: raw.slug,
      name: raw.name,
      requirements: choices,
      status: choices.length ? (connected ? "connected" : "needs-connection") : "ready",
      ...(icon ? { icon } : {}),
      ...(domain ? { domain } : {}),
    };
  }

  async function apps(): Promise<BotExecutorApp[]> {
    const rows = await api("/apps");
    if (!Array.isArray(rows)) throw invalidResponse("no app list");
    const listed = rows.filter(
      (entry): entry is Json =>
        object(entry) && entry.slug !== "executor" && entry.slug !== "executor-admin",
    );
    return concurrent(listed, async (entry): Promise<BotExecutorApp> => {
      if (!nonEmpty(entry.id) || !nonEmpty(entry.slug) || !nonEmpty(entry.name)) {
        throw invalidResponse("an invalid app");
      }
      try {
        return await app(entry.id);
      } catch (error) {
        return {
          id: entry.id,
          slug: entry.slug,
          name: entry.name,
          requirements: [],
          status: "unknown",
          error: error instanceof Error ? error.message : "Unavailable",
        };
      }
    });
  }

  async function catalog(search = ""): Promise<BotExecutorCatalogEntry[]> {
    // Every match comes back when limit is omitted; the page filters locally.
    const query = new URLSearchParams();
    if (search.trim()) query.set("search", search.trim().slice(0, 100));
    const entries = await api(`/catalog${query.size ? `?${query}` : ""}`);
    if (!Array.isArray(entries)) throw invalidResponse("no catalog");
    return entries
      .filter((entry): entry is Json => object(entry) && entry.package !== "executor")
      .map((entry) => {
        if (!nonEmpty(entry.id) || !nonEmpty(entry.name))
          throw invalidResponse("an invalid catalog entry");
        const auth = Array.isArray(entry.auth)
          ? entry.auth.flatMap((item: unknown) =>
              object(item) && nonEmpty(item.method) ? [item.method] : [],
            )
          : [];
        return {
          id: entry.id,
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
          icon: appIcon(entry.icons),
          auth,
          ...(typeof entry.category === "string" && entry.category.trim()
            ? { category: entry.category.trim() }
            : {}),
        };
      });
  }

  async function install(entry: string, name: string): Promise<BotExecutorApp> {
    const result = await api("/apps/install", {
      method: "POST",
      body: JSON.stringify({ entry, name }),
    });
    if (!object(result) || !nonEmpty(result.id)) throw invalidResponse("no installed app");
    return app(result.id);
  }

  async function requirement(appId: string, id: string, scope: BotExecutorAccountScope) {
    const selected = await app(appId);
    const found = selected.requirements.find((entry) => entry.id === id && entry.scope === scope);
    if (!found) throw fail("invalid", "The app's account requirement changed; refresh the list.");
    return found;
  }

  async function connect(input: {
    readonly appId: string;
    readonly requirement: string;
    readonly scope: BotExecutorAccountScope;
    readonly account?: string | undefined;
  }) {
    const selected = await requirement(input.appId, input.requirement, input.scope);
    const body = input.account === undefined ? {} : { account: input.account };
    if (input.account !== undefined) segment(input.account);
    const raw = await api(
      `${appPath(input.appId)}/accounts/${selected.scope}/${segment(selected.id)}/connections`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (!object(raw) || !nonEmpty(raw.url) || !nonEmpty(raw.expiresAt)) {
      throw invalidResponse("an invalid connection");
    }
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      throw invalidResponse("an invalid sign-in address");
    }
    // A sign-in link must open on the Executor the user configured.
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin !== new URL(profile.publicUrl).origin
    ) {
      throw invalidResponse("an invalid sign-in address");
    }
    return { url: url.href, expiresAt: raw.expiresAt };
  }

  async function disconnect(input: {
    readonly appId: string;
    readonly requirement: string;
    readonly scope: BotExecutorAccountScope;
    readonly account: string;
  }) {
    const selected = await requirement(input.appId, input.requirement, input.scope);
    await api(
      `${appPath(input.appId)}/accounts/${selected.scope}/${segment(selected.id)}/${segment(input.account)}`,
      { method: "DELETE" },
    );
    return app(input.appId);
  }

  return { apps, app, catalog, install, connect, disconnect };
}

const PROTOCOL_VERSIONS = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);
const EXECUTOR_MCP_TOOLS = ["skills", "search", "describe", "call", "execute", "resume"];
const MAX_PROBE_BYTES = 2 * 1024 * 1024;
const probeFailure = (detail: string) => fail("failed", detail);
const protocolFailure = () => probeFailure("Executor's MCP server returned an invalid response.");

type Found = { found: true; value: unknown } | { found: false };
function responseResult(value: unknown, id: number | undefined): Found {
  for (const message of Array.isArray(value) ? value : [value]) {
    if (!object(message) || message.id !== id || "method" in message) continue;
    if (message.jsonrpc !== "2.0" || "result" in message === "error" in message) {
      throw protocolFailure();
    }
    if ("error" in message) throw probeFailure("Executor's MCP server refused the request.");
    return { found: true, value: message.result };
  }
  return { found: false };
}

/** Reads only until our JSON-RPC response, not until an SSE stream closes. */
async function readResponse(response: Response, id: number | undefined): Promise<unknown> {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if ((type !== "application/json" && type !== "text/event-stream") || !response.body) {
    await response.body?.cancel();
    throw protocolFailure();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let event: string[] = [];
  const parse = (body: string): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      throw protocolFailure();
    }
  };
  const lines = (final = false): Found => {
    for (;;) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0 || (!final && buffer[index] === "\r" && index === buffer.length - 1)) {
        return { found: false };
      }
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1));
      if (!line) {
        if (event.length) {
          const result = responseResult(parse(event.join("\n")), id);
          event = [];
          if (result.found) return result;
        }
      } else if (line === "data" || line.startsWith("data:")) {
        event.push(line === "data" ? "" : line.slice(5).replace(/^ /, ""));
      }
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const result =
          type === "application/json" ? responseResult(parse(buffer), id) : lines(true);
        if (result.found) return result.value;
        throw protocolFailure();
      }
      bytes += value.byteLength;
      if (bytes > MAX_PROBE_BYTES) throw probeFailure("Executor's MCP answer was too large.");
      buffer += decoder.decode(value, { stream: true });
      if (type === "text/event-stream") {
        const result = lines();
        if (result.found) return result.value;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** A dedicated read-only MCP session: initialize, list tools, one management search, close. */
export async function probeExecutorMcp(
  profile: ExecutorProfile,
  token: string,
  request: Fetch,
  timeoutMs = 20_000,
): Promise<{ protocolVersion: string; tools: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let session: string | undefined;
  let version: string | undefined;
  let nextId = 0;
  const headers = () => ({
    ...executorMcpHeaders(profile, token),
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(session ? { "Mcp-Session-Id": session } : {}),
    ...(version ? { "MCP-Protocol-Version": version } : {}),
  });
  async function send(method: string, params: unknown, notification = false): Promise<unknown> {
    const id = notification ? undefined : ++nextId;
    const response = await request(profile.mcpUrl, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id }),
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw fail("rejected", "Executor's MCP server rejected the access token.");
    }
    if (notification) {
      await response.body?.cancel();
      if (response.status !== 202 && response.status !== 200) throw protocolFailure();
      return undefined;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw probeFailure("Executor's MCP request failed.");
    }
    const value = await readResponse(response, id);
    if (method === "initialize") {
      const assigned = response.headers.get("Mcp-Session-Id");
      if (assigned !== null) {
        if (!/^[\x21-\x7e]{1,4096}$/.test(assigned)) throw protocolFailure();
        session = assigned;
      }
    }
    return value;
  }
  try {
    const initialized = await send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t3-bots-verification", version: "1.0.0" },
    });
    if (
      !object(initialized) ||
      typeof initialized.protocolVersion !== "string" ||
      !PROTOCOL_VERSIONS.has(initialized.protocolVersion) ||
      !object(initialized.capabilities) ||
      !object(initialized.capabilities.tools)
    ) {
      throw protocolFailure();
    }
    version = initialized.protocolVersion;
    await send("notifications/initialized", undefined, true);
    const listed = await send("tools/list", {});
    if (!object(listed) || !Array.isArray(listed.tools)) throw protocolFailure();
    const tools = listed.tools
      .flatMap((tool: unknown) =>
        object(tool) && typeof tool.name === "string" ? [tool.name] : [],
      )
      .filter((name) => EXECUTOR_MCP_TOOLS.includes(name))
      .sort();
    if (!tools.includes("search")) {
      throw probeFailure("Executor's MCP server has no search tool.");
    }
    const searched = await send("tools/call", {
      name: "search",
      arguments: { query: "executor appManagement list" },
    });
    if (!object(searched) || !Array.isArray(searched.content) || searched.isError === true) {
      throw probeFailure("Executor's management search failed.");
    }
    return { protocolVersion: version, tools };
  } catch (error) {
    if (isExecutorError(error)) throw error;
    throw controller.signal.aborted
      ? fail("unreachable", "Executor's MCP server did not answer in time.")
      : fail("unreachable", "Executor's MCP server is not reachable.");
  } finally {
    clearTimeout(timer);
    if (session) {
      await request(profile.mcpUrl, {
        method: "DELETE",
        redirect: "error",
        headers: headers(),
        signal: AbortSignal.timeout(2000),
      })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    }
  }
}

export interface ExecutorConnection {
  readonly profile: ExecutorProfile;
  readonly token: string;
}

export class BotExecutor extends Context.Service<
  BotExecutor,
  {
    /** The configured profile and its token, or null while Executor is not set up. */
    readonly connection: Effect.Effect<ExecutorConnection | null>;
    readonly status: Effect.Effect<BotExecutorStatus>;
    readonly catalog: (
      search?: string,
    ) => Effect.Effect<ReadonlyArray<BotExecutorCatalogEntry>, BotExecutorError>;
    readonly install: (
      entry: string,
      name: string,
    ) => Effect.Effect<BotExecutorApp, BotExecutorError>;
    readonly apps: Effect.Effect<ReadonlyArray<BotExecutorApp>, BotExecutorError>;
    readonly connect: (input: {
      readonly appId: string;
      readonly requirement: string;
      readonly scope: BotExecutorAccountScope;
      readonly account?: string | undefined;
    }) => Effect.Effect<{ url: string; expiresAt: string }, BotExecutorError>;
    readonly disconnect: (input: {
      readonly appId: string;
      readonly requirement: string;
      readonly scope: BotExecutorAccountScope;
      readonly account: string;
    }) => Effect.Effect<BotExecutorApp, BotExecutorError>;
  }
>()("t3/bots/BotExecutor") {}

const makeBotExecutor = Effect.fn("BotExecutor.make")(function* (request: Fetch) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;

  const describe = Effect.gen(function* () {
    const current = (yield* settings.getSettings).botsExecutor;
    const profile = yield* Effect.try({
      try: () => executorProfile(current),
      catch: (error) =>
        isExecutorError(error) ? error : fail("invalid", "Executor settings look wrong."),
    });
    return { current, profile };
  });

  const connection: BotExecutor["Service"]["connection"] = Effect.gen(function* () {
    const { current, profile } = yield* describe;
    if (profile === null || current.token === "") return null;
    const token = yield* requireSettingsSecret(resolver, current.token);
    return token.trim() === "" ? null : { profile, token: token.trim() };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Executor is configured but its token can't be read.", cause).pipe(
        Effect.as(null),
      ),
    ),
    Effect.withSpan("BotExecutor.connection"),
  );

  const required = connection.pipe(
    Effect.filterOrFail(
      (value): value is ExecutorConnection => value !== null,
      () => fail("not-configured", "Set up Executor in Settings › Bots first."),
    ),
  );
  const call = <A>(run: (client: ReturnType<typeof createExecutorClient>) => Promise<A>) =>
    required.pipe(
      Effect.flatMap(({ profile, token }) =>
        Effect.tryPromise({
          try: () => run(createExecutorClient(profile, token, request)),
          catch: (error) =>
            isExecutorError(error)
              ? error
              : fail("failed", "Executor could not complete this request."),
        }),
      ),
    );

  const status: BotExecutor["Service"]["status"] = Effect.gen(function* () {
    const described = yield* Effect.result(describe);
    const current = described._tag === "Success" ? described.success.current : null;
    const base = {
      configured: false,
      backend: current?.backend ?? ("self-hosted" as const),
      organization: null,
      publicUrl: null,
      hasToken: current !== null && current.token !== "",
      ok: false,
    };
    if (described._tag === "Failure") {
      const error = described.failure;
      return { ...base, error: isExecutorError(error) ? error.message : "Unavailable" };
    }
    const { profile } = described.success;
    if (profile === null) return base;
    const shown = {
      ...base,
      configured: true,
      organization: profile.organization,
      publicUrl: profile.publicUrl,
    };
    const active = yield* connection;
    if (active === null) return { ...shown, error: "Add Executor's access token." };
    const checked = yield* Effect.tryPromise({
      try: async () => {
        const apps = await createExecutorClient(active.profile, active.token, request).apps();
        const counts = {
          total: apps.length,
          connected: 0,
          needsConnection: 0,
          ready: 0,
          unknown: 0,
        };
        for (const app of apps) {
          if (app.status === "needs-connection") counts.needsConnection++;
          else counts[app.status]++;
        }
        const mcp = await probeExecutorMcp(active.profile, active.token, request);
        return { apps: counts, mcpTools: mcp.tools };
      },
      catch: (error) => (isExecutorError(error) ? error : fail("failed", "Executor check failed.")),
    }).pipe(Effect.result);
    return checked._tag === "Success"
      ? { ...shown, ok: true, ...checked.success }
      : { ...shown, error: checked.failure.message };
  }).pipe(
    Effect.orElseSucceed(() => ({
      configured: false,
      backend: "self-hosted" as const,
      organization: null,
      publicUrl: null,
      hasToken: false,
      ok: false,
      error: "Settings can't be read.",
    })),
    Effect.withSpan("BotExecutor.status"),
  );

  return BotExecutor.of({
    connection,
    status,
    catalog: Effect.fn("BotExecutor.catalog")(function* (search?: string) {
      return yield* call((client) => client.catalog(search));
    }),
    install: Effect.fn("BotExecutor.install")(function* (entry: string, name: string) {
      return yield* call((client) => client.install(entry, name));
    }),
    apps: call((client) => client.apps()).pipe(Effect.withSpan("BotExecutor.apps")),
    connect: Effect.fn("BotExecutor.connect")(function* (
      input: Parameters<BotExecutor["Service"]["connect"]>[0],
    ) {
      return yield* call((client) => client.connect(input));
    }),
    disconnect: Effect.fn("BotExecutor.disconnect")(function* (
      input: Parameters<BotExecutor["Service"]["disconnect"]>[0],
    ) {
      return yield* call((client) => client.disconnect(input));
    }),
  });
});

export const layer = Layer.effect(
  BotExecutor,
  makeBotExecutor((input, init) => globalThis.fetch(input, init)),
);
