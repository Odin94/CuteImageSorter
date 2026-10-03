export const MAX_IMAGES = 24;
export const MAX_IMAGE_EDGE = 2400;
export const MAX_TOTAL_PIXELS = 40_000_000;
export type CollageImage = {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  fit: "cover" | "contain";
  zoom: number;
  panX: number;
  panY: number;
};
export type Layout =
  | { slot: number }
  | { axis: "x" | "y"; ratio: number; first: Layout; second: Layout };
export type Rect = { x: number; y: number; width: number; height: number };
export type Cell = Rect & { slot: number };
export type Divider = Rect & {
  path: string;
  axis: "x" | "y";
  ratio: number;
  parent: Rect;
};
export function suggestLayout(
  images: Pick<CollageImage, "width" | "height">[],
  width: number,
  height: number,
  variant = 0,
): Layout | null {
  if (!images.length) return null;
  // Seven-image landscape mosaic: a tall image, a stacked center, a bottom
  // pair, and a right-hand pair, matching the reference composition.
  if (images.length === 7 && width > height && variant === 0) {
    return {
      axis: "x",
      ratio: 0.75,
      first: {
        axis: "y",
        ratio: 0.7,
        first: {
          axis: "x",
          ratio: 0.35,
          first: { slot: 0 },
          second: {
            axis: "y",
            ratio: 0.35,
            first: { slot: 1 },
            second: { slot: 2 },
          },
        },
        second: {
          axis: "x",
          ratio: 0.5,
          first: { slot: 3 },
          second: { slot: 4 },
        },
      },
      second: {
        axis: "y",
        ratio: 0.3,
        first: { slot: 5 },
        second: { slot: 6 },
      },
    };
  }
  function build(slots: number[], w: number, h: number, depth: number): Layout {
    if (slots.length === 1) return { slot: slots[0] };
    const naturalAxis = w / h > 1.15 ? "x" : "y";
    const axis =
      variant === 1 && depth === 0
        ? naturalAxis === "x"
          ? "y"
          : "x"
        : naturalAxis;
    const cut = variant === 2 && depth === 0 ? 1 : Math.ceil(slots.length / 2);
    const a = slots.slice(0, cut),
      b = slots.slice(cut);
    const weight = (group: number[]) =>
      group.reduce(
        (sum, slot) =>
          sum +
          (axis === "x"
            ? Math.sqrt(images[slot].width / images[slot].height)
            : Math.sqrt(images[slot].height / images[slot].width)),
        0,
      );
    const ratio =
      variant === 2 && depth === 0
        ? 0.55
        : Math.max(0.2, Math.min(0.8, weight(a) / (weight(a) + weight(b))));
    return {
      axis,
      ratio,
      first: build(
        a,
        axis === "x" ? w * ratio : w,
        axis === "y" ? h * ratio : h,
        depth + 1,
      ),
      second: build(
        b,
        axis === "x" ? w * (1 - ratio) : w,
        axis === "y" ? h * (1 - ratio) : h,
        depth + 1,
      ),
    };
  }
  return build(
    images.map((_, i) => i),
    width,
    height,
    0,
  );
}
// Leave at least one fifth of the smallest partition visible at the largest gutter.
export function maximumGap(
  layout: Layout | null,
  width: number,
  height: number,
): number {
  let maximum = 60;
  function walk(node: Layout, w: number, h: number) {
    if ("slot" in node) {
      maximum = Math.min(
        maximum,
        (0.8 * w * width) / (w + 1),
        (0.8 * h * height) / (h + 1),
      );
      return;
    }
    walk(
      node.first,
      node.axis === "x" ? w * node.ratio : w,
      node.axis === "y" ? h * node.ratio : h,
    );
    walk(
      node.second,
      node.axis === "x" ? w * (1 - node.ratio) : w,
      node.axis === "y" ? h * (1 - node.ratio) : h,
    );
  }
  if (layout) walk(layout, 1, 1);
  return Math.floor(maximum);
}
// Partition the entire sheet first, then inset each tile by half the gutter.
// This keeps internal gutters and the outside border exactly the same width.
export function layoutGeometry(
  layout: Layout | null,
  width: number,
  height: number,
  gap: number,
): { cells: Cell[]; dividers: Divider[] } {
  gap = Math.max(0, Math.min(gap, maximumGap(layout, width, height)));
  const cells: Cell[] = [],
    dividers: Divider[] = [];
  function walk(node: Layout, rect: Rect, path: string) {
    if ("slot" in node) {
      cells.push({
        ...rect,
        x: rect.x + gap / 2,
        y: rect.y + gap / 2,
        width: Math.max(1, rect.width - gap),
        height: Math.max(1, rect.height - gap),
        slot: node.slot,
      });
      return;
    }
    const vertical = node.axis === "x";
    const split = (vertical ? rect.width : rect.height) * node.ratio;
    dividers.push({
      ...rect,
      x: vertical ? rect.x + split : rect.x,
      y: vertical ? rect.y : rect.y + split,
      width: vertical ? 0 : rect.width,
      height: vertical ? rect.height : 0,
      path,
      axis: node.axis,
      ratio: node.ratio,
      parent: rect,
    });
    walk(
      node.first,
      {
        ...rect,
        width: vertical ? split : rect.width,
        height: vertical ? rect.height : split,
      },
      path + "a",
    );
    walk(
      node.second,
      {
        ...rect,
        x: vertical ? rect.x + split : rect.x,
        y: vertical ? rect.y : rect.y + split,
        width: vertical ? rect.width - split : rect.width,
        height: vertical ? rect.height : rect.height - split,
      },
      path + "b",
    );
  }
  if (layout)
    walk(
      layout,
      { x: gap / 2, y: gap / 2, width: width - gap, height: height - gap },
      "",
    );
  return { cells, dividers };
}
export function resizeSplit(
  layout: Layout,
  path: string,
  ratio: number,
): Layout {
  if ("slot" in layout) return layout;
  if (!path) return { ...layout, ratio: Math.max(0.2, Math.min(0.8, ratio)) };
  return path[0] === "a"
    ? { ...layout, first: resizeSplit(layout.first, path.slice(1), ratio) }
    : { ...layout, second: resizeSplit(layout.second, path.slice(1), ratio) };
}
export function imageRect(
  image: Pick<
    CollageImage,
    "width" | "height" | "fit" | "zoom" | "panX" | "panY"
  >,
  cell: Rect,
): Rect {
  const scale =
    (image.fit === "cover" ? Math.max : Math.min)(
      cell.width / image.width,
      cell.height / image.height,
    ) * image.zoom;
  const width = image.width * scale,
    height = image.height * scale;
  return {
    x: cell.x + ((cell.width - width) * image.panX) / 100,
    y: cell.y + ((cell.height - height) * image.panY) / 100,
    width,
    height,
  };
}
export async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}
function importedImage(
  url: string,
  name: string,
  width: number,
  height: number,
): CollageImage {
  return {
    id: crypto.randomUUID(),
    name,
    url,
    width,
    height,
    fit: "cover",
    zoom: 1,
    panX: 50,
    panY: 50,
  };
}
export async function normalizeImage(
  file: Blob,
  name: string,
  normalizedSize?: { width: number; height: number },
): Promise<CollageImage> {
  // Native imports are already oriented, bounded and converted to a static PNG.
  // Reuse those bytes instead of decoding and PNG-encoding them a second time.
  if (normalizedSize) {
    const { width, height } = normalizedSize;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_IMAGE_EDGE ||
      height > MAX_IMAGE_EDGE
    )
      throw new Error("Invalid normalized image dimensions.");
    return importedImage(URL.createObjectURL(file), name, width, height);
  }
  const source = URL.createObjectURL(file);
  let retained = false;
  let canvas: HTMLCanvasElement | undefined;
  try {
    const image = await loadImage(source);
    const scale = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
    );
    // JPEG is static. Keep animation-capable formats on the canvas path to freeze
    // their first frame, as before. Large JPEGs still receive the working-size cap.
    if (scale === 1 && file.type === "image/jpeg") {
      retained = true;
      return importedImage(
        source,
        name,
        image.naturalWidth,
        image.naturalHeight,
      );
    }
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image processing is unavailable.");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas!.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error("Could not read this image.")),
        "image/png",
      ),
    );
    return importedImage(
      URL.createObjectURL(blob),
      name,
      canvas.width,
      canvas.height,
    );
  } finally {
    if (!retained) URL.revokeObjectURL(source);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
export async function renderCollage(
  images: CollageImage[],
  layout: Layout,
  width: number,
  height: number,
  gap: number,
  background: string,
  format: "png" | "jpeg",
  onProgress?: (completed: number, total: number) => void,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Export is unavailable.");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  const cells = layoutGeometry(layout, width, height, gap).cells;
  try {
    onProgress?.(0, cells.length);
    for (let start = 0; start < cells.length; start += 3) {
      const batch = cells.slice(start, start + 3);
      const decoded = await Promise.all(
        batch.map((cell) => loadImage(images[cell.slot].url)),
      );
      for (const [index, cell] of batch.entries()) {
        const source = images[cell.slot];
        const image = decoded[index];
        const rect = imageRect(source, cell);
        ctx.save();
        ctx.beginPath();
        ctx.rect(cell.x, cell.y, cell.width, cell.height);
        ctx.clip();
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
      }
      onProgress?.(Math.min(start + 3, cells.length), cells.length);
      // Let progress paint and input events settle between decoding batches.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(
                new Error("Could not export this collage. Try a smaller size."),
              ),
        `image/${format}`,
        0.95,
      ),
    );
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
