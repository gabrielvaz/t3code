import { describe, expect, it } from "vite-plus/test";

import { BOT_AVATAR_OBJECT_IDS, isBotAvatarColor, renderBotAvatarSvg } from "./botAvatar.ts";

describe("renderBotAvatarSvg", () => {
  it("draws a gallery object with its silhouette and eyes", () => {
    const svg = renderBotAvatarSvg({ kind: "object", shape: "rocket", color: "blue" }, "Ada");
    expect(svg).toContain('<path d="M');
    expect(svg).toContain('fill="#1084fe"');
    expect(svg.match(/<ellipse /g)).toHaveLength(2);
  });

  it("falls back to a monogram for an unknown object", () => {
    const svg = renderBotAvatarSvg({ kind: "object", shape: "nope", color: "teal" }, "ada");
    expect(svg).toContain(">A</text>");
  });

  it("escapes the monogram letter and keeps whole code points", () => {
    expect(renderBotAvatarSvg({ kind: "monogram", color: "red" }, "<b>")).toContain(">&lt;</text>");
    expect(renderBotAvatarSvg({ kind: "monogram", color: "red" }, "👍 bot")).toContain(
      ">👍</text>",
    );
  });

  it("picks ink that reads on the fill", () => {
    expect(renderBotAvatarSvg({ kind: "ball", color: "white" }, "x")).toContain('fill="#151515"');
    expect(renderBotAvatarSvg({ kind: "ball", color: "black" }, "x")).toContain('fill="#ffffff"');
  });

  it("uses a custom hex colour and falls back to teal for an unknown name", () => {
    expect(renderBotAvatarSvg({ kind: "ball", color: "#ABCDEF" }, "x")).toContain("#abcdef");
    expect(renderBotAvatarSvg({ kind: "ball", color: "mauve" }, "x")).toContain("#1cc3b0");
  });
});

describe("bot avatar palette", () => {
  it("accepts palette names and hex colours only", () => {
    expect(isBotAvatarColor("teal")).toBe(true);
    expect(isBotAvatarColor("#00ff00")).toBe(true);
    expect(isBotAvatarColor("mauve")).toBe(false);
    expect(isBotAvatarColor("#0f0")).toBe(false);
  });

  it("lists the 22 gallery objects", () => {
    expect(BOT_AVATAR_OBJECT_IDS).toHaveLength(22);
  });
});
