import { describe, expect, it } from "vitest";

import {
  directionsForCount,
  firstUnusedPresetIndex,
  isMatchingSorterDrop,
  SORTER_DRAG_TYPE,
} from "./sorting";

describe("directionsForCount", () => {
  it("maps one through four folders to their spatial arrow layout", () => {
    expect(directionsForCount(1)).toEqual(["right"]);
    expect(directionsForCount(2)).toEqual(["left", "right"]);
    expect(directionsForCount(3)).toEqual(["left", "right", "up"]);
    expect(directionsForCount(4)).toEqual(["left", "right", "up", "down"]);
  });

  it("rejects unsupported folder counts", () => {
    expect(() => directionsForCount(0)).toThrow(RangeError);
    expect(() => directionsForCount(5)).toThrow(RangeError);
  });
});

describe("isMatchingSorterDrop", () => {
  it("accepts only the private type carrying the displayed opaque file id", () => {
    expect(isMatchingSorterDrop([SORTER_DRAG_TYPE], "file-1", "file-1")).toBe(
      true,
    );
    expect(isMatchingSorterDrop(["text/plain"], "file-1", "file-1")).toBe(
      false,
    );
    expect(isMatchingSorterDrop([SORTER_DRAG_TYPE], "file-2", "file-1")).toBe(
      false,
    );
  });
});

describe("firstUnusedPresetIndex", () => {
  const presets = [
    { label: "Favorites" },
    { label: "Keep" },
    { label: "Maybe" },
    { label: "Archive" },
  ];

  it("reuses a removed middle preset instead of duplicating another target", () => {
    expect(firstUnusedPresetIndex(["Favorites", "Maybe"], presets)).toBe(1);
  });

  it("reports when all presets are in use", () => {
    expect(
      firstUnusedPresetIndex(
        ["Favorites", "Keep", "Maybe", "Archive"],
        presets,
      ),
    ).toBe(-1);
  });
});
