import { renderBotAvatarSvg } from "@t3tools/shared/botAvatar";
import type { BotAvatar as BotAvatarValue } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

/** The Bot's face, drawn from the same static SVG the server writes as its project icon. */
export function BotAvatar({
  avatar,
  name,
  className,
}: {
  avatar: BotAvatarValue;
  name: string;
  className?: string;
}) {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderBotAvatarSvg(avatar, name))}`;
  return (
    <img
      alt=""
      aria-hidden
      draggable={false}
      src={src}
      className={cn("shrink-0 select-none", className)}
    />
  );
}
