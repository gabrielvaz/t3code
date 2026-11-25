import type { BotBoardItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardRows, draftInput, draftOf } from "./botsBoard.logic";

const item = (id: string, overrides: Partial<BotBoardItem> = {}): BotBoardItem => ({
  id,
  kind: "task",
  title: id,
  status: "todo",
  fields: {},
  links: [],
  pinned: false,
  archived: false,
  createdAt: `2026-11-25T00:00:0${id.length}.000Z`,
  updatedAt: "2026-11-25T00:00:00.000Z",
  createdBy: { type: "user" },
  updatedBy: { type: "user" },
  ...overrides,
});

describe("Projects board rows", () => {
  it("groups by area, then kind, and hides archived items unless asked", () => {
    const items = [
      item("a", { area: "work", kind: "project" }),
      item("b", { area: "work", parentId: "a" }),
      item("c"),
      item("d", { area: "work", archived: true }),
    ];
    const rows = boardRows(items, { search: "", showArchived: false });
    expect(rows.map((row) => row.key)).toEqual([
      "area:work",
      "group:work:project",
      "item:a",
      "group:work:task",
      "item:b",
      "area:",
      "group::task",
      "item:c",
    ]);
    expect(rows[4]).toMatchObject({ parentTitle: "a" });
    expect(boardRows(items, { search: "", showArchived: true })).toHaveLength(9);
    expect(boardRows(items, { search: "C", showArchived: false }).map((row) => row.key)).toEqual([
      "area:",
      "group::task",
      "item:c",
    ]);
  });

  it("sends only what changed", () => {
    const existing = item("a", { area: "work" });
    expect(draftInput(existing, draftOf(existing))).toBeNull();
    expect(draftInput(existing, { ...draftOf(existing), area: "", due: "2026-12-01" })).toEqual({
      id: "a",
      area: null,
      fields: { due: "2026-12-01" },
    });
    expect(draftInput(null, { ...draftOf(null, "project"), title: " Launch " })).toEqual({
      kind: "project",
      title: "Launch",
    });
  });
});
