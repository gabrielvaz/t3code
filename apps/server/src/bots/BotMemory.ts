// Ported from Threebot server/memory.mts (MIT, Copyright (c) 2026 Threebot contributors).
//
// A Bot's memory is plain Markdown: `memory/MEMORY.md` in its folder, plus the shared file every
// Bot reads. The agent edits these like any other file; a bounded snapshot of both is copied into
// the Bot's AGENTS.md so a fresh session starts knowing them.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous sha256 keeps these helpers pure
import * as NodeCrypto from "node:crypto";

import { BOT_MANAGED_END, BOT_MANAGED_START } from "./BotTemplate.ts";

/** How much of each file goes into AGENTS.md. The files themselves can be longer. */
export const BOT_MEMORY_LIMITS = {
  // Paid for in every session, so it stays bounded.
  snapshotBotLines: 200,
  snapshotBotChars: 8_000,
  snapshotSharedLines: 60,
  snapshotSharedChars: 2_500,
} as const;

interface BotMemorySnapshot {
  readonly bot: string;
  readonly shared: string;
  readonly truncated: { readonly bot: boolean; readonly shared: boolean };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** The revision a save must send back, so it never silently replaces a newer edit. */
export function revisionOf(content: string): string {
  return NodeCrypto.createHash("sha256").update(normalizeText(content)).digest("hex");
}

/** Saved files end with one newline, unless empty. */
export function normalizeSavedText(text: string): string {
  const next = normalizeText(text);
  return next === "" || next.endsWith("\n") ? next : `${next}\n`;
}

// The snapshot sits inside AGENTS.md's managed block and a `<memory>` element, so the file must
// not be able to close either early.
function sanitizeMemoryText(value: string): string {
  return normalizeText(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replaceAll(BOT_MANAGED_START, "[managed marker removed]")
    .replaceAll(BOT_MANAGED_END, "[managed marker removed]")
    .replaceAll("<memory>", "&lt;memory&gt;")
    .replaceAll("</memory>", "&lt;/memory&gt;");
}

function clipSnapshot(
  value: string,
  maxLines: number,
  maxChars: number,
  file: string,
): { readonly text: string; readonly truncated: boolean } {
  const lines = value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  // The file's own title is implied by the snapshot's headings.
  if (lines[0] !== undefined && /^#\s+/u.test(lines[0])) lines.shift();
  let truncated = false;
  const kept: Array<string> = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= maxLines || chars + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    kept.push(line);
    chars += line.length + 1;
  }
  if (truncated) kept.push(`(cut short here; read ${file} for the rest, and tidy it so it fits)`);
  return { text: kept.join("\n"), truncated };
}

export function memorySnapshot(input: {
  readonly botText: string;
  readonly sharedText: string;
  readonly sharedFile: string;
}): BotMemorySnapshot {
  const bot = clipSnapshot(
    sanitizeMemoryText(input.botText),
    BOT_MEMORY_LIMITS.snapshotBotLines,
    BOT_MEMORY_LIMITS.snapshotBotChars,
    "memory/MEMORY.md",
  );
  const shared = clipSnapshot(
    sanitizeMemoryText(input.sharedText),
    BOT_MEMORY_LIMITS.snapshotSharedLines,
    BOT_MEMORY_LIMITS.snapshotSharedChars,
    input.sharedFile,
  );
  return {
    bot: bot.text,
    shared: shared.text,
    truncated: { bot: bot.truncated, shared: shared.truncated },
  };
}

/** The `<memory>` block inside AGENTS.md. Memory is data; the delimiters make that explicit. */
export function renderMemoryBlock(snapshot: BotMemorySnapshot): string {
  if (!snapshot.shared.trim() && !snapshot.bot.trim()) return "";
  return [
    "<memory>",
    "### Shared by all Bots",
    snapshot.shared.trim() || "- (nothing saved yet)",
    "",
    "### This Bot (memory/MEMORY.md)",
    snapshot.bot.trim() || "- (nothing saved yet)",
    "</memory>",
  ].join("\n");
}
