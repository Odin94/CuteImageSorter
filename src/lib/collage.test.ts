import { describe, it, expect } from "vitest";
import {
  imageRect,
  layoutGeometry,
  maximumGap,
  resizeSplit,
  suggestLayout,
  type Layout,
} from "./collage";
describe("collage layout", () => {
  it("offers distinct arrangements for square and portrait canvases", () => {
    const images = Array.from({ length: 7 }, () => ({
      width: 800,
      height: 1200,
    }));
    for (const [width, height] of [
      [1200, 1200],
      [900, 1200],
    ]) {
      const balanced = suggestLayout(images, width, height, 0);
      const story = suggestLayout(images, width, height, 1);
      const spotlight = suggestLayout(images, width, height, 2);
      expect(balanced).not.toEqual(story);
      expect(spotlight).not.toEqual(story);
      expect(spotlight).not.toEqual(balanced);
    }
  });
  it("partitions mixed aspect ratios without losing slots or overlapping at all supported counts", () => {
    for (let count = 1; count <= 24; count++)
      for (let variant = 0; variant < 3; variant++) {
        const images = Array.from({ length: count }, (_, i) => ({
          width: i % 2 ? 400 : 1800,
          height: i % 2 ? 1800 : 400,
        }));
        let layout = suggestLayout(images, 800, 1000, variant)!;
        layout = resizeSplit(layout, "", 0.8);
        const gap = maximumGap(layout, 800, 1000);
        const { cells } = layoutGeometry(layout, 800, 1000, gap);
        expect(cells.map((c) => c.slot).sort((a, b) => a - b)).toEqual(
          images.map((_, i) => i),
        );
        for (const a of cells) {
          expect(a.x).toBeGreaterThanOrEqual(gap - 0.00001);
          expect(a.y).toBeGreaterThanOrEqual(gap - 0.00001);
          expect(a.x + a.width).toBeLessThanOrEqual(800 - gap + 0.00001);
          expect(a.y + a.height).toBeLessThanOrEqual(1000 - gap + 0.00001);
          expect(a.width).toBeGreaterThan(0);
          expect(a.height).toBeGreaterThan(0);
          for (const b of cells)
            if (a !== b)
              expect(
                a.x + a.width <= b.x - gap + 0.00001 ||
                  b.x + b.width <= a.x - gap + 0.00001 ||
                  a.y + a.height <= b.y - gap + 0.00001 ||
                  b.y + b.height <= a.y - gap + 0.00001,
              ).toBe(true);
        }
      }
  });
  it("keeps inside and outside margins equal after a nested divider resize", () => {
    const tree: Layout = {
      axis: "x",
      ratio: 0.4,
      first: { slot: 0 },
      second: {
        axis: "y",
        ratio: 0.5,
        first: { slot: 1 },
        second: { slot: 2 },
      },
    };
    const resized = resizeSplit(tree, "b", 0.7);
    const { cells } = layoutGeometry(resized, 1200, 900, 24);
    expect(cells[0].x).toBe(24);
    expect(cells[1].x - cells[0].x - cells[0].width).toBeCloseTo(24);
    expect(cells[2].y - cells[1].y - cells[1].height).toBeCloseTo(24);
    expect(900 - cells[2].y - cells[2].height).toBeCloseTo(24);
    expect(tree).not.toEqual(resized);
  });
  it("fits without distortion and clamps cover placement to image edges", () => {
    const image = {
      width: 400,
      height: 200,
      fit: "cover" as const,
      zoom: 1,
      panX: 50,
      panY: 50,
    };
    const cell = { x: 10, y: 10, width: 100, height: 100 };
    expect(imageRect(image, cell)).toEqual({
      x: -40,
      y: 10,
      width: 200,
      height: 100,
    });
    expect(imageRect({ ...image, fit: "contain" }, cell)).toEqual({
      x: 10,
      y: 35,
      width: 100,
      height: 50,
    });
    expect(imageRect({ ...image, panX: 100 }, cell).x).toBe(-90);
  });
});
