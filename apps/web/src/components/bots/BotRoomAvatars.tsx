import type { Bot } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { BotAvatar } from "./BotAvatar";

const SHOWN = 3;

/** A room's members as overlapping faces; the first three, then a count. */
export function BotRoomAvatars({
  bots,
  size,
}: {
  bots: ReadonlyArray<Pick<Bot, "id" | "avatar" | "name">>;
  size: "sm" | "md";
}) {
  const shown = bots.slice(0, SHOWN);
  const extra = bots.length - shown.length;
  const face = size === "sm" ? "size-4" : "size-6";
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {shown.map((bot, index) => (
        <BotAvatar
          key={bot.id}
          avatar={bot.avatar}
          name={bot.name}
          className={cn(face, "rounded-full ring-2 ring-sidebar", index > 0 && "-ms-1.5")}
        />
      ))}
      {extra > 0 ? (
        <span
          className={cn(
            "-ms-1.5 inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-sidebar",
            size === "sm" ? "size-4 text-4xs" : "size-6 text-2xs",
          )}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
