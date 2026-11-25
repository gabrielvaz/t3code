import { useAtomValue } from "@effect/atom-react";
import type { BotRoom, BotRoomStatus, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentBotRoom {
  readonly environmentId: EnvironmentId;
  readonly room: BotRoom;
  readonly status: BotRoomStatus | null;
}

const roomsListAtom = environmentAtomList("web-bot-rooms-list", (environmentId) =>
  serverEnvironment.botRoomsLive({ environmentId, input: {} }),
);

const EMPTY: ReadonlyArray<EnvironmentBotRoom> = [];

// Servers without rooms fail the subscription; they simply contribute none.
const environmentBotRoomsAtom = Atom.make((get): ReadonlyArray<EnvironmentBotRoom> => {
  const ids = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const results = get(roomsListAtom(environmentIdsKey(ids)));
  const rooms: EnvironmentBotRoom[] = [];
  let answered = 0;
  results.forEach((result, index) => {
    const data = AsyncResult.getOrElse(result, () => null);
    const environmentId = ids[index];
    if (data === null || environmentId === undefined) return;
    answered += 1;
    const statuses = new Map(data.statuses.map((status) => [status.roomId, status]));
    for (const room of data.rooms) {
      rooms.push({ environmentId, room, status: statuses.get(room.id) ?? null });
    }
  });
  // A reconnect answers nothing for a moment; keep the last rooms instead of flashing none.
  if (answered === 0)
    return Option.getOrNull(get.self<ReadonlyArray<EnvironmentBotRoom>>()) ?? EMPTY;
  return rooms.toSorted((left, right) => left.room.name.localeCompare(right.room.name));
}).pipe(Atom.withLabel("web-environment-bot-rooms"));

export function useEnvironmentBotRooms(): ReadonlyArray<EnvironmentBotRoom> {
  return useAtomValue(environmentBotRoomsAtom);
}

const roomByIdAtom = Atom.family((roomId: string) =>
  Atom.make(
    (get) => get(environmentBotRoomsAtom).find((entry) => entry.room.id === roomId) ?? null,
  ).pipe(Atom.withLabel(`web-environment-bot-room:${roomId}`)),
);

export function useEnvironmentBotRoom(roomId: string): EnvironmentBotRoom | null {
  return useAtomValue(roomByIdAtom(roomId));
}

/** The New room dialog is opened from the sidebar's Bots menu and rendered once. */
export const newBotRoomDialogOpenAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("bots:new-room-dialog-open"),
);

export function openNewBotRoomDialog(): void {
  appAtomRegistry.set(newBotRoomDialogOpenAtom, true);
}
