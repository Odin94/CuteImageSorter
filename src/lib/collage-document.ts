import {
  maximumGap,
  MAX_TOTAL_PIXELS,
  type CollageImage,
  type Layout,
} from "./collage";

export type CollageDocument = {
  images: CollageImage[];
  layout: Layout | null;
  width: number;
  height: number;
  gap: number;
  background: string;
};

// Count unique working copies, not snapshots: crop edits share their image bytes.
const HISTORY_PIXEL_BUDGET = MAX_TOTAL_PIXELS * 2;
const HISTORY_LIMIT = 30;

export class CollageDocumentHistory {
  private document: CollageDocument;
  private past: CollageDocument[] = [];
  private future: CollageDocument[] = [];
  private before: CollageDocument | null = null;
  private resources = new Set<string>();

  constructor(
    initial: CollageDocument,
    private release = URL.revokeObjectURL,
  ) {
    this.document = initial;
    this.collect();
  }

  get value() {
    return this.document;
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  commit(next: CollageDocument) {
    if (next === this.document) return;
    if (!this.before) {
      this.past.push(this.document);
      this.future = [];
    }
    this.replace(next);
  }

  replace(next: CollageDocument) {
    this.document = {
      ...next,
      gap: Math.min(next.gap, maximumGap(next.layout, next.width, next.height)),
    };
    this.collect();
  }

  begin() {
    this.finish();
    this.before = this.document;
  }

  finish() {
    const before = this.before;
    this.before = null;
    if (before && before !== this.document) {
      this.past.push(before);
      this.future = [];
    }
    this.collect();
  }

  cancel() {
    if (this.before) this.document = this.before;
    this.before = null;
    this.collect();
  }

  travel(direction: "undo" | "redo") {
    this.finish();
    const source = direction === "undo" ? this.past : this.future;
    const target = direction === "undo" ? this.future : this.past;
    const next = source.pop();
    if (!next) return;
    target.push(this.document);
    this.document = next;
    this.collect();
  }

  dispose() {
    this.resources.forEach((url) => this.release(url));
    this.resources.clear();
  }

  private collect() {
    this.past = this.past.slice(-HISTORY_LIMIT);
    this.future = this.future.slice(-HISTORY_LIMIT);
    const retained = () => {
      const images = new Map<string, CollageImage>();
      for (const doc of [
        this.document,
        ...(this.before ? [this.before] : []),
        ...this.past,
        ...this.future,
      ])
        for (const image of doc.images) images.set(image.url, image);
      return images;
    };
    let images = retained();
    const pixels = () =>
      [...images.values()].reduce(
        (sum, image) => sum + image.width * image.height,
        0,
      );
    while (
      pixels() > HISTORY_PIXEL_BUDGET &&
      (this.past.length || this.future.length)
    ) {
      if (this.past.length) this.past.shift();
      else this.future.shift();
      images = retained();
    }
    for (const url of this.resources) if (!images.has(url)) this.release(url);
    this.resources = new Set(images.keys());
  }
}
