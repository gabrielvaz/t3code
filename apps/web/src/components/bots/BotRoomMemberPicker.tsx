// Member list for a room. Adapted from Threebot web/src/components/RoomMembers.tsx
// (MIT, Copyright (c) 2026 Threebot contributors).
import { BOT_ROOM_MAX_MEMBERS, type Bot, type BotId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { Checkbox } from "../ui/checkbox";
import { BotAvatar } from "./BotAvatar";

export function BotRoomMemberPicker({
  bots,
  value,
  disabled,
  onChange,
}: {
  bots: ReadonlyArray<Bot>;
  value: ReadonlyArray<BotId>;
  disabled?: boolean;
  onChange: (next: ReadonlyArray<BotId>) => void;
}) {
  const gt = useGT();
  const full = value.length >= BOT_ROOM_MAX_MEMBERS;
  return (
    <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-1">
      {bots.map((bot) => {
        const checked = value.includes(bot.id);
        return (
          <li key={bot.id}>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent has-disabled:cursor-default has-disabled:opacity-60">
              <Checkbox
                checked={checked}
                disabled={disabled === true || (!checked && full)}
                aria-label={gt("Add {name} to the room", { name: bot.name })}
                onCheckedChange={(next) =>
                  onChange(next ? [...value, bot.id] : value.filter((id) => id !== bot.id))
                }
              />
              <BotAvatar avatar={bot.avatar} name={bot.name} className="size-6" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{bot.name}</span>
                {bot.role ? (
                  <span className="block truncate text-xs text-muted-foreground">{bot.role}</span>
                ) : null}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
