import { describe, expect, it, vi } from "vitest";
import {
  CollageDocumentHistory,
  type CollageDocument,
} from "./collage-document";
import type { CollageImage } from "./collage";

const image = (url: string): CollageImage => ({
  id: url,
  url,
  name: url,
  width: 2400,
  height: 2400,
  fit: "cover",
  zoom: 1,
  panX: 50,
  panY: 50,
});
const doc = (images: CollageImage[] = []): CollageDocument => ({
  images,
  layout: images.length ? { slot: 0 } : null,
  width: 2400,
  height: 1800,
  gap: 24,
  background: "#ffffff",
});

describe("collage document history", () => {
  it("retains removed images for undo and releases abandoned redo images", () => {
    const release = vi.fn();
    const history = new CollageDocumentHistory(doc(), release);
    history.commit(doc([image("a")]));
    history.travel("undo");
    expect(release).not.toHaveBeenCalled();
    history.commit(doc([image("b")]));
    expect(release).toHaveBeenCalledExactlyOnceWith("a");
    expect(history.canRedo).toBe(false);
    history.dispose();
    expect(release).toHaveBeenCalledWith("b");
  });
  it("bounds unique image pixels across history without counting shared crop copies", () => {
    const release = vi.fn();
    const history = new CollageDocumentHistory(doc(), release);
    for (let n = 0; n < 40; n++) history.commit(doc([image(String(n))]));
    expect(release.mock.calls.length).toBe(27);
    for (let n = 0; n < 30; n++) history.commit({ ...history.value, gap: n });
    expect(release.mock.calls.length).toBe(39);
    expect(history.value.images[0].url).toBe("39");
    history.travel("undo");
    expect(history.value.gap).toBe(28);
  });
  it("groups a gesture into one undo step and protects its starting resources", () => {
    const history = new CollageDocumentHistory(doc([image("a")]), vi.fn());
    history.begin();
    for (const gap of [30, 40, 50]) history.commit({ ...history.value, gap });
    history.finish();
    history.travel("undo");
    expect(history.value.gap).toBe(24);
    expect(history.canUndo).toBe(false);
    history.travel("redo");
    expect(history.value.gap).toBe(50);
    history.begin();
    history.replace({ ...history.value, gap: 60 });
    history.cancel();
    expect(history.value.gap).toBe(50);
  });
});
