import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardPaste,
  Download,
  FolderOpen,
  ImagePlus,
  Images,
  RotateCcw,
  Trash2,
  Undo2,
  Redo2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  maximumGap,
  MAX_IMAGES,
  MAX_TOTAL_PIXELS,
  imageRect,
  layoutGeometry,
  normalizeImage,
  renderCollage,
  resizeSplit,
  suggestLayout,
  type CollageImage,
  type Divider,
  type Layout,
} from "@/lib/collage";
import "./CollageEditor.css";

type Document = {
  images: CollageImage[];
  layout: Layout | null;
  width: number;
  height: number;
  gap: number;
  background: string;
};
type ImportResult = {
  images: { name: string; data: string }[];
  warnings: string[];
};
const initial: Document = {
  images: [],
  layout: null,
  width: 2400,
  height: 1800,
  gap: 24,
  background: "#ffffff",
};
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function fromBase64(data: string): Blob {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not prepare export."));
    reader.readAsDataURL(blob);
  });
}
function DimensionInput({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const number = Number(draft);
    if (draft.trim() && Number.isFinite(number))
      onCommit(Math.max(800, Math.min(6000, Math.round(number))));
    setDraft(null);
  };
  return (
    <input
      aria-label={label}
      type="number"
      min={800}
      max={6000}
      step={100}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(null);
        }
      }}
    />
  );
}
export function CollageEditor({ active }: { active: boolean }) {
  const [doc, setDoc] = useState<Document>(initial);
  const docRef = useRef(doc);
  const undo = useRef<Document[]>([]);
  const redo = useRef<Document[]>([]);
  const rangeStart = useRef<Document | null>(null);
  const [revision, setRevision] = useState(0);
  const [historyState, setHistoryState] = useState({
    undo: false,
    redo: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [recursive, setRecursive] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<"swap" | "crop">("swap");
  const resources = useRef(new Set<string>());
  const sheet = useRef<HTMLDivElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const setDocument = useCallback((next: Document, history = true) => {
    next = {
      ...next,
      gap: Math.min(next.gap, maximumGap(next.layout, next.width, next.height)),
    };
    if (history && !rangeStart.current) {
      undo.current = [...undo.current.slice(-29), docRef.current];
      redo.current = [];
    }
    docRef.current = next;
    setDoc(next);
    setHistoryState({
      undo: undo.current.length > 0,
      redo: redo.current.length > 0,
    });
    setRevision((value) => value + 1);
  }, []);
  const travel = useCallback(
    (direction: "undo" | "redo") => {
      const source = direction === "undo" ? undo : redo,
        destination = direction === "undo" ? redo : undo;
      const next = source.current.pop();
      if (!next) return;
      destination.current.push(docRef.current);
      setDocument(next, false);
    },
    [setDocument],
  );
  useEffect(
    () => () => {
      resources.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );
  const run = useCallback(async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);
  const addBlobs = useCallback(
    async (
      entries: { blob: Blob; name: string }[],
      warnings: string[] = [],
    ) => {
      const current = docRef.current;
      const added: CollageImage[] = [];
      let pixels = current.images.reduce(
        (sum, img) => sum + img.width * img.height,
        0,
      );
      for (const entry of entries) {
        if (current.images.length + added.length >= MAX_IMAGES) {
          warnings.push(`A collage can contain up to ${MAX_IMAGES} images.`);
          break;
        }
        try {
          if (entry.blob.size > 100 * 1024 * 1024)
            throw new Error("File exceeds 100 MB");
          const image = await normalizeImage(entry.blob, entry.name);
          if (pixels + image.width * image.height > MAX_TOTAL_PIXELS) {
            URL.revokeObjectURL(image.url);
            warnings.push(
              "Working image memory limit reached. Use smaller images or start another collage.",
            );
            break;
          }
          pixels += image.width * image.height;
          resources.current.add(image.url);
          added.push(image);
        } catch {
          warnings.push(`${entry.name}: could not read this image.`);
        }
      }
      if (added.length) {
        const images = [...current.images, ...added];
        setDocument({
          ...current,
          images,
          layout: suggestLayout(images, current.width, current.height),
        });
        setSelected(added[0].id);
        toast.success(
          `Added ${added.length} image${added.length === 1 ? "" : "s"}`,
        );
      }
      if (warnings.length)
        toast.warning(
          `${warnings.length} import notice${warnings.length === 1 ? "" : "s"}`,
          { description: warnings.slice(0, 3).join("\n"), duration: 8000 },
        );
      else if (!added.length)
        toast(
          "No supported images found. Choose JPEG, PNG, WebP, GIF, BMP or TIFF images.",
        );
    },
    [setDocument],
  );
  const addNative = useCallback(
    async (result: ImportResult | null) => {
      if (result)
        await addBlobs(
          result.images.map((image) => ({
            name: image.name,
            blob: fromBase64(image.data),
          })),
          result.warnings,
        );
    },
    [addBlobs],
  );
  const addFiles = useCallback(
    (files: File[]) =>
      run(() =>
        addBlobs(files.map((file) => ({ blob: file, name: file.name }))),
      ),
    [addBlobs, run],
  );
  const pick = (folder: boolean) => {
    if (!isTauri()) {
      (folder ? folderInput : filesInput).current?.click();
      return;
    }
    void run(async () =>
      addNative(
        await invoke<ImportResult | null>("collage_pick", {
          folder,
          recursive,
          capacity: MAX_IMAGES - docRef.current.images.length,
        }),
      ),
    );
  };
  const paste = useCallback(
    () =>
      run(async () => {
        if (isTauri()) {
          await addNative(await invoke<ImportResult>("collage_clipboard"));
          return;
        }
        const items = await navigator.clipboard.read();
        const blobs = [];
        for (const item of items) {
          const type = item.types.find((type) => type.startsWith("image/"));
          if (type)
            blobs.push({
              blob: await item.getType(type),
              name: "Clipboard image.png",
            });
        }
        await addBlobs(blobs);
      }),
    [addBlobs, addNative, run],
  );
  useEffect(() => {
    if (!active) return;
    const onPaste = (event: ClipboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input,textarea,[contenteditable=true]")
      )
        return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) {
        event.preventDefault();
        void addFiles(files);
      } else if (isTauri()) {
        event.preventDefault();
        void paste();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (!busyRef.current) travel(event.shiftKey ? "redo" : "undo");
      }
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, [active, addFiles, paste, travel]);
  useEffect(() => {
    if (!active || !isTauri()) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void Promise.all([
      getCurrentWindow().listen<{ token: string }>(
        "native-source-drop",
        ({ payload }) => {
          setDragOver(false);
          void run(async () =>
            addNative(
              await invoke<ImportResult>("collage_drop", {
                token: payload.token,
                recursive,
                capacity: MAX_IMAGES - docRef.current.images.length,
              }),
            ),
          );
        },
      ),
      getCurrentWindow().onDragDropEvent(({ payload }) => {
        if (payload.type === "enter") setDragOver(true);
        if (payload.type === "leave" || payload.type === "drop")
          setDragOver(false);
      }),
    ])
      .then((list) => {
        if (disposed) list.forEach((fn) => fn());
        else cleanups.push(...list);
      })
      .catch((error) => toast.error(errorText(error)));
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, [active, recursive, run, addNative]);
  const finishRange = () => {
    const before = rangeStart.current;
    rangeStart.current = null;
    if (before && before !== docRef.current) {
      undo.current = [...undo.current.slice(-29), before];
      redo.current = [];
      setHistoryState({ undo: true, redo: false });
      setRevision((value) => value + 1);
    }
  };
  const rangeProps = {
    onPointerDown: (event: PointerEvent<HTMLInputElement>) => {
      rangeStart.current = docRef.current;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerUp: finishRange,
    onPointerCancel: finishRange,
    onBlur: finishRange,
  };
  const selectedImage = doc.images.find((image) => image.id === selected);
  const geometry = layoutGeometry(doc.layout, doc.width, doc.height, doc.gap);
  const patchImage = (patch: Partial<CollageImage>) =>
    setDocument({
      ...doc,
      images: doc.images.map((image) =>
        image.id === selected ? { ...image, ...patch } : image,
      ),
    });
  const swap = (a: number, b: number) => {
    if (a === b) return;
    const images = [...docRef.current.images];
    [images[a], images[b]] = [images[b], images[a]];
    setDocument({ ...docRef.current, images });
  };
  const remove = () => {
    const images = doc.images.filter((image) => image.id !== selected);
    setDocument({
      ...doc,
      images,
      layout: suggestLayout(images, doc.width, doc.height),
    });
    setSelected(images[0]?.id ?? null);
  };
  function gesture(
    event: PointerEvent<HTMLElement>,
    move: (dx: number, dy: number, e: globalThis.PointerEvent) => void,
    finish?: (e: globalThis.PointerEvent) => void,
  ) {
    if (event.button !== 0 || busyRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const before = docRef.current;
    const startX = event.clientX,
      startY = event.clientY;
    let changed = false;
    const onMove = (e: globalThis.PointerEvent) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 3 && !changed)
        return;
      changed = true;
      move(e.clientX - startX, e.clientY - startY, e);
    };
    const cleanup = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      target.removeEventListener("pointercancel", onCancel);
    };
    const onEnd = (e: globalThis.PointerEvent) => {
      cleanup();
      if (changed && docRef.current !== before) {
        undo.current = [...undo.current.slice(-29), before];
        redo.current = [];
        setHistoryState({ undo: true, redo: false });
        setRevision((value) => value + 1);
      }
      if (changed) finish?.(e);
    };
    const onCancel = () => {
      cleanup();
      setDocument(before, false);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", onCancel);
  }
  function resize(event: PointerEvent<HTMLElement>, divider: Divider) {
    const original = doc;
    const scale = sheet.current!.getBoundingClientRect().width / doc.width;
    gesture(event, (dx, dy) =>
      setDocument(
        {
          ...original,
          layout: resizeSplit(
            original.layout!,
            divider.path,
            divider.ratio +
              (divider.axis === "x"
                ? dx / scale / divider.parent.width
                : dy / scale / divider.parent.height),
          ),
        },
        false,
      ),
    );
  }
  const exportImage = () =>
    run(async () => {
      const current = docRef.current;
      if (!current.layout) return;
      const blob = await renderCollage(
        current.images,
        current.layout,
        current.width,
        current.height,
        current.gap,
        current.background,
        format,
      );
      if (isTauri()) {
        if (
          await invoke<boolean>("collage_save", {
            data: await toBase64(blob),
            format,
          })
        )
          toast.success("Collage saved");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `collage.${format === "jpeg" ? "jpg" : "png"}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast.success("Collage exported");
      }
    });
  // Keep working copies alive across undo/redo, then release copies no history can restore.
  useEffect(() => {
    const keep = new Set(
      [doc, ...undo.current, ...redo.current].flatMap((entry) =>
        entry.images.map((image) => image.url),
      ),
    );
    resources.current.forEach((url) => {
      if (!keep.has(url)) {
        URL.revokeObjectURL(url);
        resources.current.delete(url);
      }
    });
  }, [doc, revision]);
  return (
    <main
      className={`collage-editor ${dragOver ? "is-file-drop" : ""}`}
      hidden={!active}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={filesInput}
        type="file"
        multiple
        accept="image/*"
        hidden
        onChange={(event) => {
          void addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        accept="image/*"
        {...{ webkitdirectory: "" }}
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []).filter(
            (file) =>
              recursive || file.webkitRelativePath.split("/").length <= 2,
          );
          void addFiles(files);
          event.target.value = "";
        }}
      />
      <header className="collage-toolbar">
        <div>
          <h1>Collage studio</h1>
          <p>Bring your favorite moments together.</p>
        </div>
        <div className="collage-actions">
          <Button
            variant="ghost"
            size="icon"
            title="Undo (⌘/Ctrl Z)"
            aria-label="Undo"
            disabled={busy || !historyState.undo}
            onClick={() => travel("undo")}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Redo (⌘/Ctrl Shift Z)"
            aria-label="Redo"
            disabled={busy || !historyState.redo}
            onClick={() => travel("redo")}
          >
            <Redo2 />
          </Button>
          <Button
            disabled={busy || !doc.images.length}
            onClick={() => void exportImage()}
          >
            <Download />
            {busy ? "Working…" : "Export collage"}
          </Button>
        </div>
      </header>
      <div className="collage-body">
        <aside className="collage-library">
          <div className="collage-section-heading">
            <h2>Images</h2>
            <span>
              {doc.images.length} / {MAX_IMAGES}
            </span>
          </div>
          <div className="import-actions">
            <Button
              variant="secondary"
              disabled={busy || doc.images.length >= MAX_IMAGES}
              onClick={() => pick(false)}
            >
              <ImagePlus />
              Add images
            </Button>
            <Button
              variant="outline"
              disabled={busy || doc.images.length >= MAX_IMAGES}
              onClick={() => pick(true)}
            >
              <FolderOpen />
              Load folder
            </Button>
            <Button
              variant="ghost"
              disabled={busy || doc.images.length >= MAX_IMAGES}
              onClick={() => void paste()}
            >
              <ClipboardPaste />
              Paste image
            </Button>
          </div>
          <label className="collage-check">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(event) => setRecursive(event.target.checked)}
            />
            Include subfolders
          </label>
          <p className="collage-hint">
            Drop images anywhere or paste with ⌘/Ctrl V.
          </p>
          <div className="collage-thumbnails">
            {doc.images.map((image, index) => (
              <button
                key={image.id}
                className={selected === image.id ? "is-selected" : ""}
                aria-label={`Select ${image.name}`}
                aria-pressed={selected === image.id}
                onClick={() => setSelected(image.id)}
              >
                <img src={image.url} alt="" />
                <span>{index + 1}</span>
                <p title={image.name}>{image.name}</p>
              </button>
            ))}
          </div>
          <p className="collage-format-note">
            JPEG, PNG, WebP, GIF, BMP & TIFF.
            <br />
            Animated images use a still frame. Working copies up to 2400 px;
            originals stay untouched.
          </p>
        </aside>
        <section className="collage-workspace" aria-label="Collage preview">
          <div className="collage-stage">
            {doc.images.length ? (
              <div
                className="collage-sheet"
                ref={sheet}
                style={{
                  aspectRatio: `${doc.width}/${doc.height}`,
                  background: doc.background,
                  width: `min(100%, calc((100vh - 395px) * ${doc.width / doc.height}))`,
                }}
              >
                {geometry.cells.map((cell) => {
                  const image = doc.images[cell.slot];
                  const rect = imageRect(image, { ...cell, x: 0, y: 0 });
                  return (
                    <div
                      key={cell.slot}
                      className={`collage-tile ${selected === image.id ? "is-selected" : ""}`}
                      data-slot={cell.slot}
                      role="button"
                      tabIndex={busy ? -1 : 0}
                      aria-label={`Select ${image.name}; drag to ${mode === "swap" ? "swap images" : "adjust crop"}`}
                      style={{
                        left: `${(cell.x / doc.width) * 100}%`,
                        top: `${(cell.y / doc.height) * 100}%`,
                        width: `${(cell.width / doc.width) * 100}%`,
                        height: `${(cell.height / doc.height) * 100}%`,
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(image.id);
                        }
                      }}
                      onClick={() => setSelected(image.id)}
                      onPointerDown={(event) => {
                        setSelected(image.id);
                        const scale =
                          sheet.current!.getBoundingClientRect().width /
                          doc.width;
                        const original = doc;
                        gesture(
                          event,
                          (dx, dy) => {
                            if (mode === "crop") {
                              const px =
                                Math.abs(cell.width - rect.width) < 1
                                  ? 50
                                  : Math.max(
                                      0,
                                      Math.min(
                                        100,
                                        image.panX +
                                          (dx /
                                            scale /
                                            (cell.width - rect.width)) *
                                            100,
                                      ),
                                    );
                              const py =
                                Math.abs(cell.height - rect.height) < 1
                                  ? 50
                                  : Math.max(
                                      0,
                                      Math.min(
                                        100,
                                        image.panY +
                                          (dy /
                                            scale /
                                            (cell.height - rect.height)) *
                                            100,
                                      ),
                                    );
                              setDocument(
                                {
                                  ...original,
                                  images: original.images.map((entry) =>
                                    entry.id === image.id
                                      ? { ...entry, panX: px, panY: py }
                                      : entry,
                                  ),
                                },
                                false,
                              );
                            }
                          },
                          (e) => {
                            if (mode === "swap") {
                              const target = document
                                .elementFromPoint(e.clientX, e.clientY)
                                ?.closest<HTMLElement>("[data-slot]");
                              if (target)
                                swap(cell.slot, Number(target.dataset.slot));
                            }
                          },
                        );
                      }}
                    >
                      <img
                        draggable={false}
                        src={image.url}
                        alt={image.name}
                        style={{
                          left: `${(rect.x / cell.width) * 100}%`,
                          top: `${(rect.y / cell.height) * 100}%`,
                          width: `${(rect.width / cell.width) * 100}%`,
                          height: `${(rect.height / cell.height) * 100}%`,
                        }}
                      />
                      <span className="tile-number">{cell.slot + 1}</span>
                    </div>
                  );
                })}
                {geometry.dividers.map((divider) => (
                  <div
                    key={divider.path}
                    className={`collage-divider ${divider.axis}`}
                    role="separator"
                    tabIndex={busy ? -1 : 0}
                    aria-label="Resize adjacent images"
                    aria-orientation={
                      divider.axis === "x" ? "vertical" : "horizontal"
                    }
                    aria-valuemin={20}
                    aria-valuemax={80}
                    aria-valuenow={Math.round(divider.ratio * 100)}
                    style={{
                      left: `${(divider.x / doc.width) * 100}%`,
                      top: `${(divider.y / doc.height) * 100}%`,
                      width:
                        divider.axis === "x"
                          ? undefined
                          : `${(divider.width / doc.width) * 100}%`,
                      height:
                        divider.axis === "y"
                          ? undefined
                          : `${(divider.height / doc.height) * 100}%`,
                    }}
                    onPointerDown={(event) => resize(event, divider)}
                    onKeyDown={(event) => {
                      if (busyRef.current) return;
                      const keys =
                        divider.axis === "x"
                          ? ["ArrowLeft", "ArrowRight"]
                          : ["ArrowUp", "ArrowDown"];
                      if (keys.includes(event.key)) {
                        event.preventDefault();
                        setDocument({
                          ...doc,
                          layout: resizeSplit(
                            doc.layout!,
                            divider.path,
                            divider.ratio +
                              (event.key === keys[0] ? -0.02 : 0.02),
                          ),
                        });
                      }
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="collage-empty">
                <Images size={48} strokeWidth={1.3} />
                <h2>A little space for your memories</h2>
                <p>
                  Add a few images. We’ll arrange them with even white margins,
                  ready for your finishing touches.
                </p>
                <Button disabled={busy} onClick={() => pick(false)}>
                  <ImagePlus />
                  Choose images
                </Button>
                <span>Or drop a folder here</span>
              </div>
            )}
          </div>
          <div className="collage-canvas-footer">
            <span>
              {doc.width} × {doc.height} px
            </span>
            <span>
              {doc.images.length
                ? "Drag a divider to resize frames"
                : "Your collage will appear here"}
            </span>
            <span>{doc.gap} px margins</span>
          </div>
          <div className="collage-layouts">
            <h2>Suggested layouts</h2>
            <div>
              {["Balanced", "Wide story", "Spotlight"].map((label, index) => {
                const layout = suggestLayout(
                  doc.images,
                  doc.width,
                  doc.height,
                  index,
                );
                return (
                  <button
                    key={label}
                    disabled={busy || !layout}
                    onClick={() => setDocument({ ...doc, layout })}
                  >
                    <svg viewBox="0 0 160 100" aria-hidden="true">
                      {layoutGeometry(layout, 160, 100, 4).cells.map((cell) => (
                        <rect
                          key={cell.slot}
                          x={cell.x}
                          y={cell.y}
                          width={cell.width}
                          height={cell.height}
                          rx={1}
                        />
                      ))}
                    </svg>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            <p>
              Choosing a layout or changing the image count rearranges frames.
              Undo is always available.
            </p>
          </div>
        </section>
        <aside className="collage-inspector">
          <fieldset disabled={busy}>
            <legend>Canvas</legend>
            <label>
              Shape
              <select
                value={`${doc.width / doc.height}`}
                onChange={(event) => {
                  const ratio = Number(event.target.value);
                  setDocument({
                    ...doc,
                    width: Math.round(
                      Math.max(800 * ratio, Math.min(6000 * ratio, doc.width)),
                    ),
                    height: Math.round(
                      Math.max(800, Math.min(6000, doc.width / ratio)),
                    ),
                  });
                }}
              >
                <option value={4 / 3}>Landscape · 4:3</option>
                <option value={1}>Square · 1:1</option>
                <option value={3 / 4}>Portrait · 3:4</option>
                <option value={16 / 9}>Wide · 16:9</option>
                {![4 / 3, 1, 3 / 4, 16 / 9].includes(
                  doc.width / doc.height,
                ) && <option value={doc.width / doc.height}>Custom</option>}
              </select>
            </label>
            <div className="collage-dimensions">
              <label>
                Width
                <DimensionInput
                  label="Canvas width"
                  value={doc.width}
                  onCommit={(width) =>
                    setDocument({ ...docRef.current, width })
                  }
                />
              </label>
              <label>
                Height
                <DimensionInput
                  label="Canvas height"
                  value={doc.height}
                  onCommit={(height) =>
                    setDocument({ ...docRef.current, height })
                  }
                />
              </label>
            </div>
            <label>
              Margins <output>{doc.gap} px</output>
              <input
                type="range"
                aria-label="Margins"
                {...rangeProps}
                min={0}
                max={maximumGap(doc.layout, doc.width, doc.height)}
                value={doc.gap}
                onChange={(event) =>
                  setDocument({ ...doc, gap: Number(event.target.value) })
                }
              />
            </label>
            <label className="collage-color">
              Margin color
              <input
                type="color"
                aria-label="Margin color"
                value={doc.background}
                onChange={(event) =>
                  setDocument({ ...doc, background: event.target.value })
                }
              />
              <button
                type="button"
                onClick={() => setDocument({ ...doc, background: "#ffffff" })}
              >
                White
              </button>
            </label>
            <label>
              Export format
              <select
                value={format}
                onChange={(event) =>
                  setFormat(event.target.value as "png" | "jpeg")
                }
              >
                <option value="png">PNG · lossless</option>
                <option value="jpeg">JPEG · smaller file</option>
              </select>
            </label>
          </fieldset>
          <fieldset disabled={busy || !selectedImage}>
            <legend>Selected image</legend>
            {selectedImage ? (
              <>
                <p className="selected-image-name" title={selectedImage.name}>
                  {selectedImage.name}
                </p>
                <label>
                  Frame fit
                  <select
                    value={selectedImage.fit}
                    onChange={(event) =>
                      patchImage({
                        fit: event.target.value as "cover" | "contain",
                        zoom: 1,
                        panX: 50,
                        panY: 50,
                      })
                    }
                  >
                    <option value="cover">Fill frame · crop edges</option>
                    <option value="contain">Fit whole image</option>
                  </select>
                </label>
                <label>
                  Zoom <output>{Math.round(selectedImage.zoom * 100)}%</output>
                  <input
                    type="range"
                    aria-label="Zoom"
                    {...rangeProps}
                    min={1}
                    max={3}
                    step={0.01}
                    value={selectedImage.zoom}
                    onChange={(event) =>
                      patchImage({ zoom: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Horizontal position
                  <input
                    type="range"
                    {...rangeProps}
                    min={0}
                    max={100}
                    value={selectedImage.panX}
                    onChange={(event) =>
                      patchImage({ panX: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Vertical position
                  <input
                    type="range"
                    {...rangeProps}
                    min={0}
                    max={100}
                    value={selectedImage.panY}
                    onChange={(event) =>
                      patchImage({ panY: Number(event.target.value) })
                    }
                  />
                </label>
                <div className="collage-mode" aria-label="Image drag action">
                  <button
                    aria-pressed={mode === "swap"}
                    onClick={() => setMode("swap")}
                  >
                    Drag to swap
                  </button>
                  <button
                    aria-pressed={mode === "crop"}
                    onClick={() => setMode("crop")}
                  >
                    Drag to crop
                  </button>
                </div>
                <div className="collage-image-actions">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move image earlier"
                    disabled={busy || doc.images[0].id === selected}
                    onClick={() => {
                      const index = doc.images.findIndex(
                        (image) => image.id === selected,
                      );
                      swap(index, index - 1);
                    }}
                  >
                    <ArrowLeft />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move image later"
                    disabled={
                      busy || doc.images[doc.images.length - 1]?.id === selected
                    }
                    onClick={() => {
                      const index = doc.images.findIndex(
                        (image) => image.id === selected,
                      );
                      swap(index, index + 1);
                    }}
                  >
                    <ArrowRight />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Reset crop"
                    onClick={() =>
                      patchImage({ zoom: 1, panX: 50, panY: 50, fit: "cover" })
                    }
                  >
                    <RotateCcw />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove image"
                    onClick={remove}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </>
            ) : (
              <p className="collage-hint">
                Select an image to adjust its crop, zoom, or position.
              </p>
            )}
          </fieldset>
          <p className="collage-hint">
            Your collage stays here while you switch to sorting. Export before
            closing the app.
          </p>
        </aside>
      </div>
      {dragOver && (
        <div className="collage-drop-overlay">
          <ImagePlus />
          <strong>Drop images to add them</strong>
        </div>
      )}
    </main>
  );
}
