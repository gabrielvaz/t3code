// The New room dialog. Adapted from Threebot web/src/components/Rooms.tsx
// (MIT, Copyright (c) 2026 Threebot contributors).
import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_ROOM_DESCRIPTION_MAX_CHARS,
  BOT_ROOM_MIN_MEMBERS,
  BOT_ROOM_NAME_MAX_CHARS,
  type BotId,
  type BotRoomMode,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState, type FormEvent } from "react";

import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentBots } from "../../state/bots";
import { newBotRoomDialogOpenAtom } from "../../state/botRooms";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { BotField } from "./BotField";
import { BotRoomMemberPicker } from "./BotRoomMemberPicker";
import { BotRoomModeSelect } from "./BotRoomSettingsSheet";

/** Rendered once in the chat layout; `openNewBotRoomDialog` opens it. */
export function NewBotRoomDialogHost() {
  const open = useAtomValue(newBotRoomDialogOpenAtom);
  const close = () => appAtomRegistry.set(newBotRoomDialogOpenAtom, false);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup className="max-w-lg">
        {open ? <NewBotRoomForm onClose={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function NewBotRoomForm({ onClose }: { onClose: () => void }) {
  const gt = useGT();
  const router = useRouter();
  const { bots, environmentIds } = useEnvironmentBots();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // A room's members share a server: their threads live in that server's projects.
  const environmentId: EnvironmentId | null =
    (primaryEnvironmentId !== null && environmentIds.includes(primaryEnvironmentId)
      ? primaryEnvironmentId
      : null) ??
    environmentIds[0] ??
    null;
  const environmentBots = bots
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.bot);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [memberIds, setMemberIds] = useState<ReadonlyArray<BotId>>([]);
  const [mode, setMode] = useState<BotRoomMode>("panel");
  const [saving, setSaving] = useState(false);
  const canCreate = useAtomValue(serverEnvironment.createBotRoom.permissionAtom(environmentId));
  const createRoom = useAtomCommand(serverEnvironment.createBotRoom, { label: "bot room create" });
  const trimmedName = name.trim().replace(/^#/, "");
  const ready =
    !saving &&
    environmentId !== null &&
    canCreate &&
    trimmedName.length > 0 &&
    memberIds.length >= BOT_ROOM_MIN_MEMBERS;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || environmentId === null) return;
    setSaving(true);
    const result = await createRoom({
      environmentId,
      input: {
        name: trimmedName,
        description: description.trim(),
        memberIds: [...memberIds],
        settings: { mode },
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not create the room"),
            description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
          }),
        );
      }
      return;
    }
    onClose();
    void router.navigate({
      to: "/bots/rooms/$roomId",
      params: { roomId: result.value.room.id },
    });
  };

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>
          <T>New room</T>
        </DialogTitle>
        <DialogDescription>
          <T>
            A room is a group chat with your Bots. Each Bot answers in its own thread and sees what
            the others said.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={saving} className="min-w-0 space-y-4">
          <BotField label={gt("Name")} htmlFor="new-room-name">
            <Input
              id="new-room-name"
              autoFocus
              required
              maxLength={BOT_ROOM_NAME_MAX_CHARS}
              placeholder={gt("e.g. launch")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </BotField>
          <BotField label={gt("What is it about?")} hint={gt("Optional")} htmlFor="new-room-about">
            <Input
              id="new-room-about"
              maxLength={BOT_ROOM_DESCRIPTION_MAX_CHARS}
              placeholder={gt("e.g. Plan the spring launch")}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </BotField>
          <BotField label={gt("Members")} hint={gt("{count} of 2–8", { count: memberIds.length })}>
            {environmentBots.length < BOT_ROOM_MIN_MEMBERS ? (
              <p className="text-sm text-muted-foreground">
                <T>Create at least two Bots to start a room.</T>
              </p>
            ) : (
              <BotRoomMemberPicker
                bots={environmentBots}
                value={memberIds}
                disabled={saving}
                onChange={setMemberIds}
              />
            )}
          </BotField>
          <BotField label={gt("How they talk")} htmlFor="new-room-mode">
            <BotRoomModeSelect id="new-room-mode" value={mode} onChange={setMode} />
          </BotField>
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          <T>Cancel</T>
        </DialogClose>
        <Button type="submit" size="sm" disabled={!ready}>
          <T>Create room</T>
        </Button>
      </DialogFooter>
    </form>
  );
}
