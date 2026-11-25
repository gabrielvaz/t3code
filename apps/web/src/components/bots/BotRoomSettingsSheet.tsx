// Room settings. Adapted from Threebot web/src/components/RoomView.tsx and RoomMembers.tsx
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
  type Bot,
  type BotId,
  type BotRoomMode,
  type BotRoomResponder,
  type BotRoomSettings,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import type { EnvironmentBotRoom } from "../../state/botRooms";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { BotField } from "./BotField";
import { BotRoomMemberPicker } from "./BotRoomMemberPicker";

export function BotRoomModeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: BotRoomMode;
  onChange: (mode: BotRoomMode) => void;
}) {
  const gt = useGT();
  const labels: Record<BotRoomMode, string> = {
    panel: gt("Panel: everyone answers at once", { $context: "room mode" }),
    roundtable: gt("Roundtable: one at a time, hearing each other", { $context: "room mode" }),
  };
  return (
    <Select
      value={value}
      items={labels}
      onValueChange={(mode) => {
        if (mode !== null) onChange(mode);
      }}
    >
      <SelectTrigger id={id} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="panel">{labels.panel}</SelectItem>
        <SelectItem value="roundtable">{labels.roundtable}</SelectItem>
      </SelectPopup>
    </Select>
  );
}

function LimitField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const gt = useGT();
  return (
    <NumberField
      id={id}
      min={min}
      max={max}
      step={1}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(Math.round(next));
      }}
    >
      <BotField label={label} htmlFor={id}>
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={gt("Decrease {label}", { label })} />
          <NumberFieldInput />
          <NumberFieldIncrement aria-label={gt("Increase {label}", { label })} />
        </NumberFieldGroup>
      </BotField>
    </NumberField>
  );
}

export function BotRoomSettingsSheet({
  entry,
  bots,
  onClose,
  onDelete,
}: {
  entry: EnvironmentBotRoom;
  bots: ReadonlyArray<Bot>;
  onClose: () => void;
  onDelete: () => void;
}) {
  const gt = useGT();
  const { room, environmentId } = entry;
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description);
  const [memberIds, setMemberIds] = useState<ReadonlyArray<BotId>>(
    room.members.map((member) => member.botId),
  );
  const [settings, setSettings] = useState<BotRoomSettings>(room.settings);
  const [saving, setSaving] = useState(false);
  const canEdit = useAtomValue(serverEnvironment.updateBotRoom.permissionAtom(environmentId));
  const updateRoom = useAtomCommand(serverEnvironment.updateBotRoom, { label: "bot room update" });
  const set = <K extends keyof BotRoomSettings>(key: K, value: BotRoomSettings[K]) =>
    setSettings((previous) => ({ ...previous, [key]: value }));
  const members = bots.filter((bot) => memberIds.includes(bot.id));
  const responders: Record<BotRoomResponder, string> = {
    lead: gt("The lead", { $context: "who answers a room message that names nobody" }),
    everyone: gt("Everyone", { $context: "who answers a room message that names nobody" }),
    mentions: gt("Only who I @mention", {
      $context: "who answers a room message that names nobody",
    }),
  };
  const ready =
    canEdit && !saving && name.trim().length > 0 && memberIds.length >= BOT_ROOM_MIN_MEMBERS;

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    const result = await updateRoom({
      environmentId,
      input: {
        id: room.id,
        name: name.trim().replace(/^#/, ""),
        description: description.trim(),
        memberIds: [...memberIds],
        settings: {
          ...settings,
          lead: settings.lead !== null && memberIds.includes(settings.lead) ? settings.lead : null,
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") return onClose();
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not save the room"),
          description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
        }),
      );
    }
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup side="right" className="max-w-lg">
        <SheetHeader>
          <SheetTitle>
            <T>Room settings</T>
          </SheetTitle>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={!canEdit || saving} className="contents">
            <BotField label={gt("Name")} htmlFor="room-settings-name">
              <Input
                id="room-settings-name"
                required
                maxLength={BOT_ROOM_NAME_MAX_CHARS}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </BotField>
            <BotField label={gt("What is it about?")} htmlFor="room-settings-about">
              <Input
                id="room-settings-about"
                maxLength={BOT_ROOM_DESCRIPTION_MAX_CHARS}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </BotField>
            <BotField label={gt("How they talk")} htmlFor="room-settings-mode">
              <BotRoomModeSelect
                id="room-settings-mode"
                value={settings.mode}
                onChange={(mode) => set("mode", mode)}
              />
            </BotField>
            <div className="grid grid-cols-2 gap-3">
              <BotField label={gt("Who answers by default")} htmlFor="room-settings-responder">
                <Select
                  value={settings.defaultResponder}
                  items={responders}
                  onValueChange={(responder) => {
                    if (responder !== null) set("defaultResponder", responder);
                  }}
                >
                  <SelectTrigger id="room-settings-responder" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="lead">{responders.lead}</SelectItem>
                    <SelectItem value="everyone">{responders.everyone}</SelectItem>
                    <SelectItem value="mentions">{responders.mentions}</SelectItem>
                  </SelectPopup>
                </Select>
              </BotField>
              <BotField label={gt("Lead", { $context: "room lead" })} htmlFor="room-settings-lead">
                <Select
                  value={settings.lead ?? members[0]?.id ?? null}
                  items={Object.fromEntries(members.map((bot) => [bot.id, bot.name]))}
                  onValueChange={(lead) => {
                    if (lead !== null) set("lead", lead);
                  }}
                >
                  <SelectTrigger id="room-settings-lead" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {members.map((bot) => (
                      <SelectItem key={bot.id} value={bot.id}>
                        {bot.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </BotField>
            </div>
            <BotField
              label={gt("Members")}
              hint={gt("{count} of 2–8", { count: memberIds.length })}
            >
              <BotRoomMemberPicker bots={bots} value={memberIds} onChange={setMemberIds} />
            </BotField>
            {settings.mode === "roundtable" ? (
              <label className="flex items-center justify-between gap-3 text-sm">
                <T>A reply that @mentions a teammate brings it back in</T>
                <Switch
                  checked={settings.allowCrossMentions}
                  onCheckedChange={(checked) => set("allowCrossMentions", checked)}
                />
              </label>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              {settings.mode === "roundtable" ? (
                <LimitField
                  id="room-settings-waves"
                  label={gt("Rounds per message")}
                  min={1}
                  max={5}
                  value={settings.maxWaves}
                  onChange={(value) => set("maxWaves", value)}
                />
              ) : null}
              <LimitField
                id="room-settings-replies"
                label={gt("Replies per message")}
                min={1}
                max={20}
                value={settings.maxReplies}
                onChange={(value) => set("maxReplies", value)}
              />
              <LimitField
                id="room-settings-member-timeout"
                label={gt("Minutes each Bot may take")}
                min={1}
                max={60}
                value={settings.memberTimeoutMin}
                onChange={(value) => set("memberTimeoutMin", value)}
              />
              <LimitField
                id="room-settings-deadline"
                label={gt("Minutes per message")}
                min={1}
                max={120}
                value={settings.turnDeadlineMin}
                onChange={(value) => set("turnDeadlineMin", value)}
              />
            </div>
          </fieldset>
          <div className="mt-auto flex items-center justify-between gap-2 pt-2">
            <Button
              type="button"
              variant="destructive-outline"
              size="sm"
              disabled={!canEdit}
              onClick={onDelete}
            >
              <T>Delete room</T>
            </Button>
            <Button type="submit" size="sm" disabled={!ready}>
              <T>Save</T>
            </Button>
          </div>
        </form>
      </SheetPopup>
    </Sheet>
  );
}
