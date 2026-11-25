// Object silhouettes in botAvatarObjects.json come from Open Bot Avatar
// (https://github.com/DominikScholz/open-bot-avatar), MIT License, Copyright (c) 2026 Dominik Scholz,
// by way of Threebot (MIT, Copyright (c) 2026 Threebot contributors).
import type { BotAvatar } from "@t3tools/contracts";

import objectAvatars from "./botAvatarObjects.json" with { type: "json" };

/** Palette names a Bot's colour may use; anything else must be "#rrggbb". */
export const BOT_AVATAR_COLORS: Readonly<Record<string, string>> = {
  black: "#000000",
  white: "#f2f2f0",
  brown: "#936439",
  red: "#ff263c",
  orange: "#ff6700",
  amber: "#ffaf38",
  green: "#00c972",
  teal: "#1cc3b0",
  blue: "#1084fe",
  purple: "#a97efe",
  pink: "#ff5eb1",
  gray: "#777777",
};

const DEFAULT_COLOR = "teal";

const OBJECTS = new Map(objectAvatars.avatars.map((avatar) => [avatar.id, avatar]));

/** Gallery object ids, in gallery order. */
export const BOT_AVATAR_OBJECT_IDS: ReadonlyArray<string> = objectAvatars.avatars.map(
  (avatar) => avatar.id,
);

export function isBotAvatarColor(color: string): boolean {
  return Object.hasOwn(BOT_AVATAR_COLORS, color) || /^#[0-9a-f]{6}$/i.test(color);
}

function avatarFill(color: string): string {
  if (Object.hasOwn(BOT_AVATAR_COLORS, color)) return BOT_AVATAR_COLORS[color]!;
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : BOT_AVATAR_COLORS[DEFAULT_COLOR]!;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** White or near-black, whichever reads better on the fill. */
function inkFor(fill: string): string {
  const light = luminance(fill);
  const onWhite = 1.05 / (light + 0.05);
  const onDark = (light + 0.05) / 0.0621;
  return onWhite > onDark ? "#ffffff" : "#151515";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const eyesSvg = (x: number, y: number, spacing: number, scale: number, ink: string) =>
  [x - spacing, x + spacing]
    .map(
      (cx) =>
        `<ellipse cx="${cx}" cy="${y}" rx="${(4 * scale).toFixed(2)}" ry="${(6 * scale).toFixed(2)}" fill="${ink}"/>`,
    )
    .join("");

const wrap = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="64" height="64">${body}</svg>\n`;

function ballSvg(fill: string): string {
  const ink = inkFor(fill);
  return wrap(
    `<defs><radialGradient id="g" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="0.45" stop-color="${fill}" stop-opacity="0"/></radialGradient></defs>` +
      `<circle cx="50" cy="50" r="42" fill="${fill}"/><circle cx="50" cy="50" r="42" fill="url(#g)"/>` +
      eyesSvg(50, 46, 14, 1, ink),
  );
}

function monogramSvg(fill: string, name: string): string {
  const letter = [...name.trim()][0]?.toLocaleUpperCase() ?? "?";
  return wrap(
    `<rect x="6" y="6" width="88" height="88" rx="24" fill="${fill}"/>` +
      `<text x="50" y="50" dy="0.35em" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="52" font-weight="600" fill="${inkFor(fill)}">${escapeXml(letter)}</text>`,
  );
}

/** A static icon for the Bot: no animation, so it is safe as a favicon on every surface. */
export function renderBotAvatarSvg(avatar: BotAvatar, name: string): string {
  const fill = avatarFill(avatar.color);
  if (avatar.kind === "ball") return ballSvg(fill);
  if (avatar.kind === "object") {
    const object = avatar.shape === undefined ? undefined : OBJECTS.get(avatar.shape);
    if (object === undefined) return monogramSvg(fill, name);
    const { x, y, spacing, scale } = object.eyes;
    return wrap(
      `<path d="${escapeXml(object.path)}" fill="${fill}"/>` +
        eyesSvg(x, y, spacing, scale, inkFor(fill)),
    );
  }
  return monogramSvg(fill, name);
}
