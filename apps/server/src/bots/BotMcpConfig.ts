// Adapted from Threebot server/gateway.mts `writeMcpConfig` (MIT, Copyright (c) 2026 Threebot
// contributors).
//
// T3 injects only its own MCP server into provider sessions, so a Bot's harness reaches Executor
// through the project-level MCP config each harness reads from the Bot's folder:
//   Claude  .mcp.json, plus `enableAllProjectMcpServers` in .claude/settings.json
//   Codex   .codex/config.toml, read only once the folder is trusted in Codex's own config.toml
//   Pi      .pi/mcp.json
// Only the `executor` entry is ours; every other entry in those files is left as it was. None of
// these harnesses can read a header from T3's environment, so the token is in the files, 0600.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readTextIfExists, writeTextAtomic } from "./BotFiles.ts";

const EXECUTOR_MCP_SERVER = "executor";
const CODEX_START = "# t3-bots:executor:start (written by T3 Code; edits here are replaced)";
const CODEX_END = "# t3-bots:executor:end";

export interface ExecutorMcpServer {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const writePrivate = Effect.fn("BotMcpConfig.writePrivate")(function* (
  file: string,
  content: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  if ((yield* readTextIfExists(file)) === content) return;
  yield* writeTextAtomic(file, content);
  yield* fileSystem.chmod(file, 0o600).pipe(Effect.ignore);
});

const removeIfExists = Effect.fn("BotMcpConfig.remove")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(file, { force: true });
});

function parseJsonObject(text: string): JsonObject | null {
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const formatJson = (value: JsonObject) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Reads a JSON object file; null when it holds something else, which is then left untouched so a
 * file the user broke by hand is never overwritten.
 */
const readJsonObject = Effect.fn("BotMcpConfig.readJsonObject")(function* (file: string) {
  const parsed = parseJsonObject(yield* readTextIfExists(file));
  if (parsed === null) yield* Effect.logWarning(`Leaving ${file} alone: it isn't a JSON object.`);
  return parsed;
});

/** Sets or removes `mcpServers.executor`; a file left empty is removed. */
const updateServers = Effect.fn("BotMcpConfig.updateServers")(function* (
  file: string,
  entry: JsonObject | null,
) {
  const json = yield* readJsonObject(file);
  if (json === null) return { servers: 1 };
  const servers: JsonObject = isObject(json.mcpServers) ? { ...json.mcpServers } : {};
  if (entry === null) {
    if (!(EXECUTOR_MCP_SERVER in servers)) return { servers: Object.keys(servers).length };
    delete servers[EXECUTOR_MCP_SERVER];
  } else {
    servers[EXECUTOR_MCP_SERVER] = entry;
  }
  const { mcpServers: _previous, ...rest } = json;
  const next: JsonObject =
    Object.keys(servers).length > 0 ? { ...rest, mcpServers: servers } : rest;
  if (Object.keys(next).length === 0) yield* removeIfExists(file);
  else yield* writePrivate(file, formatJson(next));
  return { servers: Object.keys(servers).length };
});

const updateClaudeSettings = Effect.fn("BotMcpConfig.updateClaudeSettings")(function* (
  file: string,
  enable: boolean,
) {
  const json = yield* readJsonObject(file);
  if (json === null) return;
  if (enable) {
    if (json.enableAllProjectMcpServers === true) return;
    yield* writePrivate(file, formatJson({ ...json, enableAllProjectMcpServers: true }));
    return;
  }
  if (!("enableAllProjectMcpServers" in json)) return;
  const { enableAllProjectMcpServers: _drop, ...rest } = json;
  if (Object.keys(rest).length === 0) yield* removeIfExists(file);
  else yield* writePrivate(file, formatJson(rest));
});

const tomlString = (value: string) => JSON.stringify(value);

/** `text` without our block, or with it replaced by `block`. */
export function withCodexBlock(text: string, block: string | null): string {
  const start = text.indexOf(CODEX_START);
  const end = start === -1 ? -1 : text.indexOf(CODEX_END, start);
  const outside =
    start === -1 || end === -1
      ? text
      : text.slice(0, start) + text.slice(end + CODEX_END.length).replace(/^\n/, "");
  const kept = outside.replace(/\n{3,}/g, "\n\n").trim();
  if (block === null) return kept === "" ? "" : `${kept}\n`;
  return kept === "" ? `${block}\n` : `${kept}\n\n${block}\n`;
}

function codexBlock(server: ExecutorMcpServer): string {
  const headers = Object.entries(server.headers)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(", ");
  return `${CODEX_START}\n[mcp_servers.${EXECUTOR_MCP_SERVER}]\nurl = ${tomlString(server.url)}\nhttp_headers = { ${headers} }\n${CODEX_END}`;
}

const updateCodexProject = Effect.fn("BotMcpConfig.updateCodexProject")(function* (
  file: string,
  server: ExecutorMcpServer | null,
) {
  const text = yield* readTextIfExists(file);
  const next = withCodexBlock(text, server === null ? null : codexBlock(server));
  if (next === text) return;
  if (next === "") yield* removeIfExists(file);
  else yield* writePrivate(file, next);
});

const trustLines = (dir: string) =>
  `[projects.${tomlString(dir)}]\ntrust_level = "trusted" # t3-bots\n`;

/** Codex loads a project's .codex/config.toml only from a folder its own config trusts. */
const updateCodexTrust = Effect.fn("BotMcpConfig.updateCodexTrust")(function* (
  globalConfig: string,
  dir: string,
  trust: boolean,
) {
  const text = yield* readTextIfExists(globalConfig);
  const lines = trustLines(dir);
  if (trust) {
    // The user may have trusted it already, in their own words.
    if (text.includes(`[projects.${tomlString(dir)}]`)) return;
    const prefix = text === "" ? "" : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
    yield* writePrivate(globalConfig, `${prefix}${lines}`);
    return;
  }
  if (!text.includes(lines)) return;
  yield* writePrivate(globalConfig, text.replace(`\n${lines}`, "").replace(lines, ""));
});

export interface BotMcpConfigTarget {
  /** The Bot's folder. */
  readonly dir: string;
  /** Codex's own config.toml (`$CODEX_HOME/config.toml`); null skips trusting the folder. */
  readonly codexGlobalConfig: string | null;
}

/**
 * Writes or removes the Executor MCP entry for one Bot in every harness's project config.
 * Idempotent: writing the same server twice changes no file.
 */
export const writeBotMcpConfig = Effect.fn("BotMcpConfig.write")(function* (
  target: BotMcpConfigTarget,
  server: ExecutorMcpServer | null,
) {
  const path = yield* Path.Path;
  const { dir } = target;
  const claude = yield* updateServers(
    path.join(dir, ".mcp.json"),
    server === null ? null : { type: "http", url: server.url, headers: server.headers },
  );
  yield* updateClaudeSettings(path.join(dir, ".claude", "settings.json"), claude.servers > 0);
  yield* updateServers(
    path.join(dir, ".pi", "mcp.json"),
    server === null
      ? null
      : {
          type: "streamable-http",
          url: server.url,
          headers: server.headers,
          description: "The user's connected apps (Executor).",
        },
  );
  yield* updateCodexProject(path.join(dir, ".codex", "config.toml"), server);
  if (target.codexGlobalConfig !== null) {
    yield* updateCodexTrust(target.codexGlobalConfig, dir, server !== null);
  }
});
