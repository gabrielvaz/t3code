import type { BotBoardActivity, BotBoardEvent, BotBoardItem } from "@t3tools/contracts";

/** The Projects board as a client holds it: the snapshot with every later change applied. */
export interface BotBoardState {
  readonly version: number;
  readonly items: ReadonlyArray<BotBoardItem>;
  readonly activity: ReadonlyArray<BotBoardActivity>;
}

export const EMPTY_BOT_BOARD: BotBoardState = { version: -1, items: [], activity: [] };
const KEPT_ACTIVITY = 60;

export function applyBotBoardEvent(state: BotBoardState, event: BotBoardEvent): BotBoardState {
  if (event.type === "snapshot") {
    return { version: event.version, items: event.items, activity: event.activity };
  }
  if (event.version <= state.version) return state;
  const removed = new Set(event.removed);
  const changed = new Map(event.items.map((item) => [item.id, item]));
  const kept = state.items.flatMap((item) => {
    if (removed.has(item.id)) return [];
    const next = changed.get(item.id);
    if (next === undefined) return [item];
    changed.delete(item.id);
    return [next];
  });
  return {
    version: event.version,
    items: [...kept, ...changed.values()],
    activity: [...state.activity, ...event.activity].slice(-KEPT_ACTIVITY),
  };
}
