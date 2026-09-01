export type Direction = "left" | "right" | "up" | "down";
export const SORTER_DRAG_TYPE = "application/x-cute-image-sorter-file";

const layouts: Direction[][] = [
  ["right"],
  ["left", "right"],
  ["left", "right", "up"],
  ["left", "right", "up", "down"],
];

export function directionsForCount(count: number): Direction[] {
  if (count < 1 || count > 4) {
    throw new RangeError("Destination count must be between one and four.");
  }
  return layouts[count - 1];
}

export function firstUnusedPresetIndex(
  labels: string[],
  presets: ReadonlyArray<{ label: string }>,
): number {
  const used = new Set(labels);
  return presets.findIndex((preset) => !used.has(preset.label));
}

export function isMatchingSorterDrop(
  types: readonly string[],
  payload: string,
  expectedFileId: string,
): boolean {
  return types.includes(SORTER_DRAG_TYPE) && payload === expectedFileId;
}
