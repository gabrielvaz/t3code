import { describe, expect, it } from "vite-plus/test";

import {
  addressedMembers,
  isMentionBoundary,
  mentionQueryAt,
  mentionSegments,
  mentionsInText,
} from "./botMentions.ts";

const members = [
  { id: "a", name: "Ana" },
  { id: "ab", name: "Ana Bot" },
  { id: "c", name: "Cy" },
];

describe("bot mentions", () => {
  it("needs a word boundary before @", () => {
    expect(isMentionBoundary("@Ana", 0)).toBe(true);
    expect(isMentionBoundary("hi @Ana", 3)).toBe(true);
    expect(isMentionBoundary("me@Ana", 2)).toBe(false);
    expect(isMentionBoundary("path/@Ana", 5)).toBe(false);
  });

  it("matches the longest name and ignores code", () => {
    expect(mentionsInText("@Ana Bot please", ["Ana", "Ana Bot"], "anywhere")).toEqual(["Ana Bot"]);
    expect(mentionsInText("ask `@Cy` or @ana", ["Ana", "Cy"], "anywhere")).toEqual(["Ana"]);
    expect(mentionsInText("```\n@Cy\n```\nhey", ["Cy"], "anywhere")).toEqual([]);
    expect(mentionsInText("@Anabel", ["Ana"], "anywhere")).toEqual([]);
  });

  it("counts only opening mentions under the leading policy", () => {
    expect(mentionsInText("@Ana, @Cy and me", ["Ana", "Cy"], "leading")).toEqual(["Ana", "Cy"]);
    expect(mentionsInText("hey @Ana", ["Ana"], "leading")).toEqual([]);
  });

  it("keeps the original text in segments", () => {
    expect(mentionSegments("hi @ana!", ["Ana"])).toEqual([
      { text: "hi " },
      { text: "@ana", name: "Ana" },
      { text: "!" },
    ]);
  });

  it("finds the query being typed", () => {
    expect(mentionQueryAt("hello @An", 9)).toEqual({ start: 6, query: "An" });
    expect(mentionQueryAt("hello @Ana ", 11, ["Ana"])).toBeNull();
    expect(mentionQueryAt("mail me@x", 9)).toBeNull();
  });

  it("resolves members in mention order and @all to everyone", () => {
    expect(addressedMembers("@Cy then @Ana", members, "anywhere")).toEqual({
      ids: ["c", "a"],
      all: false,
    });
    expect(addressedMembers("@everyone hi", members, "anywhere")).toEqual({
      ids: ["a", "ab", "c"],
      all: true,
    });
  });
});
