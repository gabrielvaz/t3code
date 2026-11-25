import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { BotConflictError, EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { EnvironmentBot } from "../../state/bots";

/** Pinned Bots first, then the saved order, then the oldest. */
export function sortBotsForSidebar(
  bots: ReadonlyArray<EnvironmentBot>,
): ReadonlyArray<EnvironmentBot> {
  return bots.toSorted(
    (left, right) =>
      Number(right.bot.pinned) - Number(left.bot.pinned) ||
      left.bot.order - right.bot.order ||
      left.bot.createdAt.localeCompare(right.bot.createdAt) ||
      left.bot.id.localeCompare(right.bot.id),
  );
}

export function botThreadKeys(bots: ReadonlyArray<EnvironmentBot>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const { environmentId, bot } of bots) {
    if (bot.threadId !== null)
      keys.add(scopedThreadKey(scopeThreadRef(environmentId, bot.threadId)));
  }
  return keys;
}

/** Bot threads live in the sidebar's Bots section, so the shelves leave them out. */
export function withoutBotThreads<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(threads: ReadonlyArray<T>, botKeys: ReadonlySet<string>): ReadonlyArray<T> {
  if (botKeys.size === 0) return threads;
  const kept = threads.filter(
    (thread) => !botKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  return kept.length === threads.length ? threads : kept;
}

/** A save that lost a race keeps the user's draft and shows what the file holds now. */
export function isBotConflictError(error: unknown): error is BotConflictError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "BotConflictError"
  );
}

/** One entry per line, blank lines dropped; how the permission lists are edited. */
export function parseBotRuleList(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
