import type { BotAvatar as BotAvatarValue } from "@t3tools/contracts";
import { BOT_AVATAR_COLORS, BOT_AVATAR_OBJECT_IDS } from "@t3tools/shared/botAvatar";
import { msg, useGT, useMessages } from "gt-react";

import { cn } from "~/lib/utils";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { BotAvatar } from "./BotAvatar";

const OBJECT_LABELS: Readonly<Record<string, string>> = {
  barbell: msg("Barbell"),
  book: msg("Book"),
  brain: msg("Brain"),
  bull: msg("Bull"),
  bunny: msg("Bunny"),
  camera: msg("Camera"),
  cat: msg("Cat"),
  chat: msg("Chat bubble"),
  cloud: msg("Cloud"),
  controller: msg("Game controller"),
  ghost: msg("Ghost"),
  lightbulb: msg("Lightbulb"),
  magnifier: msg("Magnifier"),
  mug: msg("Mug"),
  "paint-brush": msg("Paint brush"),
  palette: msg("Palette", { $context: "painter's palette, a Bot avatar shape" }),
  rocket: msg("Rocket"),
  shield: msg("Shield"),
  sprout: msg("Sprout"),
  star: msg("Star"),
  "watering-can": msg("Watering can"),
  "witch-hat": msg("Witch hat"),
};

const COLOR_LABELS: Readonly<Record<string, string>> = {
  black: msg("Black"),
  white: msg("White"),
  brown: msg("Brown"),
  red: msg("Red"),
  orange: msg("Orange"),
  amber: msg("Amber"),
  green: msg("Green"),
  teal: msg("Teal"),
  blue: msg("Blue"),
  purple: msg("Purple"),
  pink: msg("Pink"),
  gray: msg("Gray"),
};

type FaceOption = { readonly kind: "ball" | "object" | "monogram"; readonly shape?: string };

const FACE_OPTIONS: ReadonlyArray<FaceOption> = [
  { kind: "ball" },
  ...BOT_AVATAR_OBJECT_IDS.map((shape) => ({ kind: "object" as const, shape })),
  { kind: "monogram" },
];

const SWATCH_CLASS =
  "flex cursor-pointer items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-60";

export const DEFAULT_BOT_AVATAR: BotAvatarValue = { kind: "ball", color: "teal" };

export function BotAvatarPicker({
  value,
  name,
  disabled = false,
  onChange,
}: {
  value: BotAvatarValue;
  name: string;
  disabled?: boolean;
  onChange: (avatar: BotAvatarValue) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const faceLabel = (option: FaceOption) =>
    option.kind === "ball"
      ? gt("Ball")
      : option.kind === "monogram"
        ? gt("First letter of the name")
        : messages(OBJECT_LABELS[option.shape ?? ""] ?? option.shape ?? "");
  return (
    <div className="space-y-3">
      <div
        role="radiogroup"
        aria-label={gt("Face")}
        className="grid grid-cols-8 gap-1 sm:grid-cols-12"
      >
        {FACE_OPTIONS.map((option) => {
          const selected =
            option.kind === value.kind &&
            (option.kind !== "object" || option.shape === value.shape);
          const label = faceLabel(option);
          return (
            <SharedTooltipTrigger
              key={`${option.kind}:${option.shape ?? ""}`}
              label={label}
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={label}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      kind: option.kind,
                      color: value.color,
                      ...(option.shape === undefined ? {} : { shape: option.shape }),
                    })
                  }
                  className={cn(
                    SWATCH_CLASS,
                    "aspect-square p-0.5",
                    selected ? "bg-accent ring-1 ring-inset ring-ring/60" : "hover:bg-accent/60",
                  )}
                />
              }
            >
              <BotAvatar
                avatar={{ ...option, color: value.color }}
                name={name}
                className="size-full"
              />
            </SharedTooltipTrigger>
          );
        })}
      </div>
      <div role="radiogroup" aria-label={gt("Color")} className="flex flex-wrap gap-1.5">
        {Object.entries(BOT_AVATAR_COLORS).map(([color, hex]) => {
          const label = messages(COLOR_LABELS[color] ?? color);
          return (
            <SharedTooltipTrigger
              key={color}
              label={label}
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={value.color === color}
                  aria-label={label}
                  disabled={disabled}
                  onClick={() => onChange({ ...value, color })}
                  className={cn(
                    SWATCH_CLASS,
                    "size-7 rounded-full p-1",
                    value.color === color
                      ? "ring-2 ring-inset ring-foreground/70"
                      : "ring-1 ring-inset ring-border hover:ring-foreground/30",
                  )}
                />
              }
            >
              <span className="size-full rounded-full" style={{ backgroundColor: hex }} />
            </SharedTooltipTrigger>
          );
        })}
      </div>
    </div>
  );
}
