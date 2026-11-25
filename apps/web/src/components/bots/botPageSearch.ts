export const BOT_PAGE_TABS = ["details", "instructions", "memory", "routines"] as const;
export type BotPageTab = (typeof BOT_PAGE_TABS)[number];

export function validateBotPageSearch(raw: Record<string, unknown>): { tab?: BotPageTab } {
  const tab = BOT_PAGE_TABS.find((candidate) => candidate === raw.tab);
  return tab === undefined || tab === "details" ? {} : { tab };
}
