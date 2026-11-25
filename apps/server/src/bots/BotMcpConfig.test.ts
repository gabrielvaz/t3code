import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { SECRET_REDACTED, mapSettingsSecrets } from "../settingsSecrets.ts";
import {
  appIcon,
  createExecutorClient,
  executorMcpHeaders,
  executorMcpUrl,
  executorProfile,
  probeExecutorMcp,
} from "./BotExecutor.ts";
import { withCodexBlock, writeBotMcpConfig } from "./BotMcpConfig.ts";

const server = {
  url: "https://executor.example/mcp?elicitation_mode=model",
  headers: { Authorization: "Bearer tok-123" },
};

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bot-mcp-" });
  const dir = path.join(root, "ops");
  const codexGlobalConfig = path.join(root, "codex-home", "config.toml");
  yield* fileSystem.makeDirectory(dir, { recursive: true });
  const read = (file: string) =>
    fileSystem.readFileString(path.join(dir, file)).pipe(Effect.orElseSucceed(() => null));
  const write = (file: string, text: string) =>
    fileSystem
      .makeDirectory(path.dirname(path.join(dir, file)), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(path.join(dir, file), text)));
  return { fileSystem, path, dir, codexGlobalConfig, read, write };
});

describe("Executor MCP config writer", () => {
  it.effect("writes every harness's entry, is idempotent, and removes only its own entries", () =>
    Effect.gen(function* () {
      const { fileSystem, path, dir, codexGlobalConfig, read, write } = yield* setup;
      yield* write(".mcp.json", JSON.stringify({ mcpServers: { github: { command: "gh" } } }));
      yield* write(".claude/settings.json", JSON.stringify({ model: "opus" }));
      yield* write(".codex/config.toml", 'model = "gpt-5.5"\n');
      yield* fileSystem.makeDirectory(path.dirname(codexGlobalConfig), { recursive: true });
      yield* fileSystem.writeFileString(codexGlobalConfig, 'model = "o4"\n');

      const target = { dir, codexGlobalConfig };
      yield* writeBotMcpConfig(target, server);
      const snapshot = Effect.all([
        read(".mcp.json"),
        read(".claude/settings.json"),
        read(".codex/config.toml"),
        read(".pi/mcp.json"),
        fileSystem.readFileString(codexGlobalConfig),
      ]);
      const first = yield* snapshot;
      const mcp = JSON.parse(first[0]!);
      expect(mcp.mcpServers.github).toEqual({ command: "gh" });
      expect(mcp.mcpServers.executor).toEqual({ type: "http", ...server });
      expect(JSON.parse(first[1]!)).toEqual({ model: "opus", enableAllProjectMcpServers: true });
      expect(first[2]).toContain('model = "gpt-5.5"');
      expect(first[2]).toContain("[mcp_servers.executor]");
      expect(first[2]).toContain('"Authorization" = "Bearer tok-123"');
      expect(JSON.parse(first[3]!).mcpServers.executor).toMatchObject({
        type: "streamable-http",
        url: server.url,
      });
      expect(first[4]).toContain(`[projects.${JSON.stringify(dir)}]`);
      const mode = (yield* fileSystem.stat(path.join(dir, ".mcp.json"))).mode & 0o777;
      expect(mode.toString(8)).toBe("600");

      yield* writeBotMcpConfig(target, server);
      expect(yield* snapshot).toEqual(first);

      yield* writeBotMcpConfig(target, null);
      yield* writeBotMcpConfig(target, null);
      const off = yield* snapshot;
      expect(JSON.parse(off[0]!)).toEqual({ mcpServers: { github: { command: "gh" } } });
      // Another project server remains, so Claude still needs the switch.
      expect(JSON.parse(off[1]!)).toEqual({ model: "opus", enableAllProjectMcpServers: true });
      expect(off[2]).toBe('model = "gpt-5.5"\n');
      expect(off[3]).toBeNull();
      expect(off[4]).toBe('model = "o4"\n');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes files it created when Executor is turned off", () =>
    Effect.gen(function* () {
      const { dir, read } = yield* setup;
      const target = { dir, codexGlobalConfig: null };
      yield* writeBotMcpConfig(target, server);
      yield* writeBotMcpConfig(target, null);
      expect(yield* read(".mcp.json")).toBeNull();
      expect(yield* read(".claude/settings.json")).toBeNull();
      expect(yield* read(".codex/config.toml")).toBeNull();
      expect(yield* read(".pi/mcp.json")).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a file it can't parse alone", () =>
    Effect.gen(function* () {
      const { dir, read, write } = yield* setup;
      yield* write(".mcp.json", "{ not json");
      yield* writeBotMcpConfig({ dir, codexGlobalConfig: null }, server);
      expect(yield* read(".mcp.json")).toBe("{ not json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("replaces only its own Codex block", () => {
    const withBlock = withCodexBlock("a = 1\n", "BLOCK");
    expect(withBlock).toBe("a = 1\n\nBLOCK\n");
    expect(withCodexBlock("", null)).toBe("");
  });
});

describe("Executor profile", () => {
  it("derives MCP addresses and per-Bot approval modes", () => {
    const base = DEFAULT_SERVER_SETTINGS.botsExecutor;
    expect(executorProfile(base)).toBeNull();
    const selfHosted = executorProfile({ ...base, url: "http://localhost:4000/" })!;
    expect(selfHosted).toMatchObject({
      kind: "self-hosted",
      organization: "executor",
      mcpUrl: "http://localhost:4000/mcp",
      publicUrl: "http://localhost:4000",
    });
    expect(executorMcpUrl(selfHosted, "automatic")).toBe(
      "http://localhost:4000/mcp?elicitation_mode=automatic",
    );
    const cloud = executorProfile({ ...base, backend: "cloud", organization: "acme" })!;
    expect(cloud.mcpUrl).toBe("https://mcp.executor.sh/org/acme/mcp");
    expect(executorMcpHeaders(cloud, "t")).toEqual({
      Authorization: "Bearer t",
      "X-Executor-Organization": "acme",
    });
    expect(() =>
      executorProfile({ ...base, backend: "cloud", organization: "acme", url: "http://x" }),
    ).toThrow();
  });

  it("redacts the Executor token for clients", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      botsExecutor: { ...DEFAULT_SERVER_SETTINGS.botsExecutor, token: "tok-secret" },
    };
    const names: string[] = [];
    const redacted = mapSettingsSecrets(settings, (secret) => {
      names.push(secret.secretName);
      return { value: "", redacted: secret.value !== "" };
    });
    expect(redacted.botsExecutor.token).toBe(SECRET_REDACTED);
    expect(JSON.stringify(redacted)).not.toContain("tok-secret");
    expect(names).toContain("bots-executor-dG9rZW4");
  });
});

describe("Executor client and probe", () => {
  const profile = executorProfile({
    ...DEFAULT_SERVER_SETTINGS.botsExecutor,
    url: "https://executor.test",
  })!;

  it("reads the catalog with app logos and never sends the token anywhere else", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return Response.json([
        {
          id: "gmail",
          name: "Gmail",
          icons: [{ src: "https://cdn.test/gmail.svg" }],
          auth: [{ method: "oauth" }],
        },
        { id: "executor", name: "Executor", package: "executor" },
      ]);
    }) as typeof globalThis.fetch;
    const entries = await createExecutorClient(profile, "tok", fetch).catalog("gm");
    expect(entries).toEqual([
      {
        id: "gmail",
        name: "Gmail",
        description: "",
        icon: "https://cdn.test/gmail.svg",
        auth: ["oauth"],
      },
    ]);
    expect(seen).toEqual([
      {
        url: "https://executor.test/api/organizations/executor/catalog?search=gm",
        auth: "Bearer tok",
      },
    ]);
    expect(appIcon([{ src: "javascript:alert(1)" }])).toBeNull();
  });

  it("probes the MCP server for Executor's fixed tools", async () => {
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body));
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
          : body.method === "tools/list"
            ? { tools: ["search", "describe", "call", "other"].map((name) => ({ name })) }
            : { content: [{ type: "text", text: "{}" }] };
      return Response.json(
        { jsonrpc: "2.0", id: body.id, result },
        {
          headers: { "Mcp-Session-Id": "s1" },
        },
      );
    }) as typeof globalThis.fetch;
    expect(await probeExecutorMcp(profile, "tok", fetch)).toEqual({
      protocolVersion: "2025-06-18",
      tools: ["call", "describe", "search"],
    });
    const rejected = (async () => new Response(null, { status: 401 })) as typeof globalThis.fetch;
    await expect(probeExecutorMcp(profile, "bad", rejected)).rejects.toMatchObject({
      reason: "rejected",
    });
  });
});
