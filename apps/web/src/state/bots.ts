import { useAtomValue } from "@effect/atom-react";
import type { Bot, BotId, BotsSharedSettings, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentBot {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
}

export interface EnvironmentBotsState {
  readonly bots: ReadonlyArray<EnvironmentBot>;
  readonly settingsByEnvironment: ReadonlyMap<EnvironmentId, BotsSharedSettings>;
  /** Connected environments whose server answered the Bots subscription. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}

const botsListAtom = environmentAtomList("web-bots-list", (environmentId) =>
  serverEnvironment.botsLive({ environmentId, input: {} }),
);

const EMPTY_STATE: EnvironmentBotsState = {
  bots: [],
  settingsByEnvironment: new Map(),
  environmentIds: [],
};

// Servers without Bots fail the subscription; they simply contribute none.
const environmentBotsAtom = Atom.make((get): EnvironmentBotsState => {
  const ids = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const results = get(botsListAtom(environmentIdsKey(ids)));
  const bots: EnvironmentBot[] = [];
  const settingsByEnvironment = new Map<EnvironmentId, BotsSharedSettings>();
  const environmentIds: EnvironmentId[] = [];
  results.forEach((result, index) => {
    const data = AsyncResult.getOrElse(result, () => null);
    const environmentId = ids[index];
    if (data === null || environmentId === undefined) return;
    environmentIds.push(environmentId);
    settingsByEnvironment.set(environmentId, data.settings);
    for (const bot of data.bots) bots.push({ environmentId, bot });
  });
  const previous = Option.getOrNull(get.self<EnvironmentBotsState>());
  if (bots.length === 0 && environmentIds.length === 0) return previous ?? EMPTY_STATE;
  return { bots, settingsByEnvironment, environmentIds };
}).pipe(Atom.withLabel("web-environment-bots"));

export function useEnvironmentBots(): EnvironmentBotsState {
  return useAtomValue(environmentBotsAtom);
}

const botByIdAtom = Atom.family((botId: string) =>
  Atom.make(
    (get) => get(environmentBotsAtom).bots.find((entry) => entry.bot.id === botId) ?? null,
  ).pipe(Atom.withLabel(`web-environment-bot:${botId}`)),
);

const botByThreadAtom = Atom.family((threadKey: string) =>
  Atom.make(
    (get) =>
      get(environmentBotsAtom).bots.find(
        (entry) => `${entry.environmentId}\n${entry.bot.threadId}` === threadKey,
      ) ?? null,
  ).pipe(Atom.withLabel(`web-environment-bot-thread:${threadKey}`)),
);

export function useEnvironmentBot(botId: BotId | string): EnvironmentBot | null {
  return useAtomValue(botByIdAtom(botId));
}

export function useBotForThread(
  environmentId: EnvironmentId,
  threadId: string,
): EnvironmentBot | null {
  return useAtomValue(botByThreadAtom(`${environmentId}\n${threadId}`));
}

/** The New Bot dialog is opened from the sidebar, the palette and settings, and rendered once. */
export const newBotDialogOpenAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("bots:new-dialog-open"),
);

export function openNewBotDialog(): void {
  appAtomRegistry.set(newBotDialogOpenAtom, true);
}
