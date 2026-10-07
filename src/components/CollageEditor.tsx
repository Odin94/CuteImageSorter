import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  Move,
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
  useMemo,
  useLayoutEffect,
  useState,
  type PointerEvent,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/context-menu";
import { IconButton } from "@/components/ui/icon-button";
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
} from "@/lib/collage";
import "./CollageEditor.css";

import {
  CollageDocumentHistory,
  type CollageDocument as Document,
} from "@/lib/collage-document";

type ImportResult = {
  images: { name: string; data: string; width: number; height: number }[];
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
  const decoded = atob(data);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
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
  const [history] = useState(() => new CollageDocumentHistory(initial));
  const rangePointer = useRef<number | null>(null);
  const [historyState, setHistoryState] = useState({
    undo: false,
    redo: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState({
    label: "Preparing images",
    completed: 0,
    total: 0,
  });
  const busyRef = useRef(false);
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [recursive, setRecursive] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<"swap" | "crop">("swap");
  const [swapDrag, setSwapDrag] = useState<{
    source: number;
    target: number | null;
  } | null>(null);
  const cancelGesture = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelGesture.current?.(), [active]);
  const sheet = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setStageSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const importPicker = useRef<HTMLDialogElement>(null);
  const removalUndo = useRef<{
    id: string | number;
    document: Document;
  } | null>(null);
  const dismissRemovalUndo = useCallback(() => {
    if (removalUndo.current) toast.dismiss(removalUndo.current.id);
    removalUndo.current = null;
  }, []);
  const refreshDocument = useCallback(() => {
    if (removalUndo.current && removalUndo.current.document !== history.value)
      dismissRemovalUndo();
    docRef.current = history.value;
    setDoc(history.value);
    setHistoryState({ undo: history.canUndo, redo: history.canRedo });
  }, [history, dismissRemovalUndo]);
  const setDocument = useCallback(
    (next: Document, record = true) => {
      if (record) history.commit(next);
      else history.replace(next);
      refreshDocument();
    },
    [history, refreshDocument],
  );
  const stopEditing = useCallback(() => {
    cancelGesture.current?.();
    rangePointer.current = null;
    history.finish();
    refreshDocument();
  }, [history, refreshDocument]);
  const travel = useCallback(
    (direction: "undo" | "redo") => {
      if (busyRef.current) return;
      stopEditing();
      history.travel(direction);
      refreshDocument();
    },
    [history, refreshDocument, stopEditing],
  );
  useEffect(() => () => history.dispose(), [history]);
  const run = useCallback(
    async (work: () => Promise<void>, label = "Preparing images") => {
      if (busyRef.current) return;
      stopEditing();
      dismissRemovalUndo();
      busyRef.current = true;
      setBusy(true);
      setOperation({ label, completed: 0, total: 0 });
      try {
        await work();
      } catch (error) {
        toast.error(errorText(error));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [stopEditing, dismissRemovalUndo],
  );
  const addBlobs = useCallback(
    async (
      entries: {
        blob: Blob;
        name: string;
        normalizedSize?: { width: number; height: number };
      }[],
      warnings: string[] = [],
    ) => {
      const current = docRef.current;
      const added: CollageImage[] = [];
      let pixels = current.images.reduce(
        (sum, img) => sum + img.width * img.height,
        0,
      );
      setOperation({
        label: "Importing images",
        completed: 0,
        total: entries.length,
      });
      for (const [index, entry] of entries.entries()) {
        if (current.images.length + added.length >= MAX_IMAGES) {
          warnings.push(`A collage can contain up to ${MAX_IMAGES} images.`);
          break;
        }
        try {
          if (entry.blob.size > 100 * 1024 * 1024)
            throw new Error("File exceeds 100 MB");
          const image = await normalizeImage(
            entry.blob,
            entry.name,
            entry.normalizedSize,
          );
          if (pixels + image.width * image.height > MAX_TOTAL_PIXELS) {
            URL.revokeObjectURL(image.url);
            warnings.push(
              "Working image memory limit reached. Use smaller images or start another collage.",
            );
            break;
          }
          pixels += image.width * image.height;
          added.push(image);
        } catch (error) {
          warnings.push(`${entry.name}: ${errorText(error)}`);
        } finally {
          setOperation((value) => ({ ...value, completed: index + 1 }));
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
            normalizedSize: { width: image.width, height: image.height },
          })),
          result.warnings,
        );
    },
    [addBlobs],
  );
  const addFiles = useCallback(
    (files: File[]) =>
      run(() =>
        addBlobs(
          files
            .filter(
              (file) =>
                recursive ||
                !file.webkitRelativePath ||
                file.webkitRelativePath.split("/").length <= 2,
            )
            .map((file) => ({ blob: file, name: file.name })),
        ),
      ),
    [addBlobs, run, recursive],
  );
  const pick = (folder?: boolean) => {
    if (
      folder === undefined &&
      !(isTauri() && /Mac/.test(navigator.platform))
    ) {
      importPicker.current?.showModal();
      return;
    }
    importPicker.current?.close();
    if (!isTauri()) {
      (folder ? folderInput : filesInput).current?.click();
      return;
    }
    void run(async () =>
      addNative(
        await invoke<ImportResult | null>("collage_pick", {
          folder: folder ?? false,
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
        if (!navigator.clipboard?.read)
          throw new Error(
            "This browser cannot read clipboard images. Use Cmd/Ctrl+V to paste an image, or choose Add images.",
          );
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
        !cancelGesture.current &&
        event.target instanceof HTMLElement &&
        event.target.closest(
          "input:not([type=range]),textarea,select,[contenteditable=true]",
        )
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
    const retainCleanup = (cleanup: () => void) => {
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    };
    void Promise.all([
      getCurrentWindow()
        .listen<{ token: string }>("native-source-drop", ({ payload }) => {
          if (disposed) return;
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
        })
        .then(retainCleanup),
      getCurrentWindow()
        .onDragDropEvent(({ payload }) => {
          if (disposed) return;
          if (payload.type === "enter") setDragOver(true);
          if (payload.type === "leave" || payload.type === "drop")
            setDragOver(false);
        })
        .then(retainCleanup),
    ]).catch((error) => {
      if (!disposed) toast.error(errorText(error));
    });
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, [active, recursive, run, addNative]);
  const finishRange = useCallback(() => {
    // A range's blur must never finish a crop or divider transaction.
    if (rangePointer.current === null) return;
    rangePointer.current = null;
    history.finish();
    refreshDocument();
  }, [history, refreshDocument]);
  useEffect(() => {
    const finishPointerRange = (event: globalThis.PointerEvent) => {
      if (event.pointerId === rangePointer.current) finishRange();
    };
    const finishReleasedRange = (event: globalThis.PointerEvent) => {
      if ((event.buttons & 1) === 0) finishPointerRange(event);
    };
    // Observe release at the window so an off-track release still closes the
    // undo transaction. Leave pointer capture to the native range control:
    // capturing on the input steals WebKit's internal thumb drag.
    window.addEventListener("pointerup", finishPointerRange);
    window.addEventListener("pointercancel", finishPointerRange);
    window.addEventListener("pointermove", finishReleasedRange);
    window.addEventListener("blur", finishRange);
    return () => {
      window.removeEventListener("pointerup", finishPointerRange);
      window.removeEventListener("pointercancel", finishPointerRange);
      window.removeEventListener("pointermove", finishReleasedRange);
      window.removeEventListener("blur", finishRange);
    };
  }, [finishRange]);
  const rangeProps = {
    onPointerDown: (event: PointerEvent<HTMLInputElement>) => {
      if (event.button !== 0 || !event.isPrimary || busyRef.current) return;
      finishRange();
      history.begin();
      rangePointer.current = event.pointerId;
    },
    onBlur: finishRange,
  };
  const selectedImage =
    doc.images.find((image) => image.id === selected) ?? doc.images[0];
  const selectedId = selectedImage?.id ?? null;
  const geometry = useMemo(
    () => layoutGeometry(doc.layout, doc.width, doc.height, doc.gap),
    [doc.layout, doc.width, doc.height, doc.gap],
  );
  const suggestedLayouts = useMemo(
    () =>
      [0, 1, 2].map((variant) =>
        suggestLayout(doc.images, doc.width, doc.height, variant),
      ),
    [doc.images, doc.width, doc.height],
  );
  const patchImage = (patch: Partial<CollageImage>) =>
    setDocument({
      ...doc,
      images: doc.images.map((image) =>
        image.id === selectedId ? { ...image, ...patch } : image,
      ),
    });
  const swap = (a: number, b: number) => {
    if (a === b) return;
    const images = [...docRef.current.images];
    [images[a], images[b]] = [images[b], images[a]];
    setDocument({ ...docRef.current, images });
  };
  const remove = (id = selectedId) => {
    stopEditing();
    const current = docRef.current;
    const images = current.images.filter((image) => image.id !== id);
    setDocument({
      ...current,
      images,
      layout: suggestLayout(images, current.width, current.height),
    });
    setSelected(images[0]?.id ?? null);
    const removedState = history.value;
    const toastId = toast("Image removed from collage", {
      action: {
        label: "Undo",
        onClick: () => {
          if (busyRef.current || history.value !== removedState) return;
          travel("undo");
          setSelected(id);
        },
      },
    });
    removalUndo.current = { id: toastId, document: removedState };
  };
  const imageActions = (id: string, index: number) => [
    {
      label: "Move earlier",
      icon: ArrowLeft,
      disabled: busy || index === 0,
      onSelect: () => {
        stopEditing();
        swap(index, index - 1);
      },
    },
    {
      label: "Move later",
      icon: ArrowRight,
      disabled: busy || index === doc.images.length - 1,
      onSelect: () => {
        stopEditing();
        swap(index, index + 1);
      },
    },
    {
      label: "Reset crop",
      icon: RotateCcw,
      disabled: busy,
      onSelect: () => {
        stopEditing();
        setDocument({
          ...docRef.current,
          images: docRef.current.images.map((image) =>
            image.id === id
              ? { ...image, zoom: 1, panX: 50, panY: 50, fit: "cover" }
              : image,
          ),
        });
      },
    },
    {
      label: "Remove image",
      icon: Trash2,
      disabled: busy,
      onSelect: () => remove(id),
    },
  ];
  function gesture(
    event: PointerEvent<HTMLElement>,
    move: (dx: number, dy: number, e: globalThis.PointerEvent) => void,
    finish?: (e: globalThis.PointerEvent) => void,
  ) {
    if (event.button !== 0 || !event.isPrimary || busyRef.current) return;
    stopEditing();
    history.begin();
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX,
      startY = event.clientY;
    let changed = false;
    const onMove = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 3 && !changed)
        return;
      changed = true;
      move(e.clientX - startX, e.clientY - startY, e);
    };
    const cleanup = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      target.removeEventListener("pointercancel", onPointerCancel);
      target.removeEventListener("lostpointercapture", onPointerCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onGestureKey);
      cancelGesture.current = null;
      if (target.hasPointerCapture(event.pointerId))
        target.releasePointerCapture(event.pointerId);
      setSwapDrag(null);
    };
    const onEnd = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      cleanup();
      history.finish();
      refreshDocument();
      if (changed) finish?.(e);
    };
    const onCancel = () => {
      cleanup();
      history.cancel();
      refreshDocument();
    };
    const onPointerCancel = (e: globalThis.PointerEvent) => {
      if (e.pointerId === event.pointerId) onCancel();
    };
    const onGestureKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    cancelGesture.current = onCancel;
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", onPointerCancel);
    target.addEventListener("lostpointercapture", onPointerCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onGestureKey);
  }
  function swapTargetAt(
    event: globalThis.PointerEvent,
    source: number,
  ): number | null {
    const tile = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-slot]");
    if (!tile || !sheet.current?.contains(tile)) return null;
    const slot = Number(tile.dataset.slot);
    return Number.isInteger(slot) &&
      slot >= 0 &&
      slot < docRef.current.images.length &&
      slot !== source
      ? slot
      : null;
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
        (completed, total) =>
          setOperation({ label: "Rendering collage", completed, total }),
      );
      if (isTauri()) {
        if (await invoke<boolean>("collage_save", await blob.arrayBuffer()))
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
    }, "Exporting collage");
  return (
    <main
      className={`collage-editor ${dragOver ? "is-file-drop" : ""}`}
      hidden={!active}
      aria-busy={busy}
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
      <dialog
        ref={importPicker}
        className="collage-import-picker"
        aria-labelledby="import-title"
      >
        <h2 id="import-title">Add images</h2>
        <p>Select individual images or all images in a folder.</p>
        <div>
          <Button onClick={() => pick(false)}>
            <ImagePlus />
            Select images
          </Button>
          <Button variant="secondary" onClick={() => pick(true)}>
            <FolderOpen />
            Select folder
          </Button>
          <Button variant="ghost" onClick={() => importPicker.current?.close()}>
            Cancel
          </Button>
        </div>
      </dialog>
      <header className="collage-toolbar">
        <div>
          <h1>Collage studio</h1>
          <p>Bring your favorite moments together.</p>
        </div>
        <div className="collage-actions">
          <IconButton
            variant="ghost"
            tooltip={
              busy
                ? "Wait for the current operation to finish"
                : historyState.undo
                  ? "Undo"
                  : "No edits to undo"
            }
            aria-label="Undo"
            disabled={busy || !historyState.undo}
            onClick={() => travel("undo")}
          >
            <Undo2 />
          </IconButton>
          <IconButton
            variant="ghost"
            tooltip={
              busy
                ? "Wait for the current operation to finish"
                : historyState.redo
                  ? "Redo"
                  : "No edits to redo"
            }
            aria-label="Redo"
            disabled={busy || !historyState.redo}
            onClick={() => travel("redo")}
          >
            <Redo2 />
          </IconButton>
          <Button
            disabled={busy || !doc.images.length}
            disabledReason={
              busy
                ? "Wait for the current operation to finish"
                : "Add an image before exporting"
            }
            onClick={() => void exportImage()}
          >
            <Download />
            {busy ? "Working…" : "Export collage"}
          </Button>
        </div>
      </header>
      {busy && (
        <div className="collage-operation" role="status">
          <span>
            {operation.label}
            {operation.total > 0
              ? ` · ${operation.completed} / ${operation.total}`
              : "…"}
          </span>
          <progress
            aria-label={operation.label}
            max={operation.total || 1}
            value={operation.total ? operation.completed : undefined}
          />
        </div>
      )}
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
              disabledReason={
                busy
                  ? "Wait for the current operation to finish"
                  : "This collage already has 24 images"
              }
              onClick={() => pick()}
            >
              <ImagePlus />
              Add images
            </Button>
            <Button
              variant="ghost"
              disabled={busy || doc.images.length >= MAX_IMAGES}
              disabledReason={
                busy
                  ? "Wait for the current operation to finish"
                  : "This collage already has 24 images"
              }
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
            Select images or folders. You can also drop them here or paste with
            ⌘/Ctrl V.
          </p>
          <div className="collage-thumbnails">
            {doc.images.map((image, index) => (
              <ContextMenu
                key={image.id}
                actions={imageActions(image.id, index)}
              >
                <button
                  className={selectedId === image.id ? "is-selected" : ""}
                  aria-label={`Select ${image.name}`}
                  aria-pressed={selectedId === image.id}
                  onClick={() => setSelected(image.id)}
                >
                  <img src={image.url} alt="" loading="lazy" decoding="async" />
                  <span>{index + 1}</span>
                  <p title={image.name}>{image.name}</p>
                </button>
              </ContextMenu>
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
          <div className="collage-stage" ref={stage}>
            {doc.images.length ? (
              <div
                className="collage-sheet"
                ref={sheet}
                style={{
                  aspectRatio: `${doc.width}/${doc.height}`,
                  background: doc.background,
                  width: Math.min(
                    stageSize.width,
                    (stageSize.height * doc.width) / doc.height,
                  ),
                }}
              >
                {geometry.cells.map((cell) => {
                  const image = doc.images[cell.slot];
                  const rect = imageRect(image, { ...cell, x: 0, y: 0 });
                  return (
                    <ContextMenu
                      key={image.id}
                      actions={imageActions(image.id, cell.slot)}
                    >
                      <div
                        className={`collage-tile ${selectedId === image.id ? "is-selected" : ""} ${swapDrag?.source === cell.slot ? "is-swap-source" : ""} ${swapDrag?.target === cell.slot ? "is-swap-target" : ""}`}
                        data-slot={cell.slot}
                        role="button"
                        aria-pressed={selectedId === image.id}
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
                            (dx, dy, pointer) => {
                              if (mode === "swap") {
                                const target = swapTargetAt(pointer, cell.slot);
                                setSwapDrag((current) =>
                                  current?.source === cell.slot &&
                                  current.target === target
                                    ? current
                                    : { source: cell.slot, target },
                                );
                              }
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
                                const target = swapTargetAt(e, cell.slot);
                                if (target !== null) swap(cell.slot, target);
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
                        {swapDrag?.source === cell.slot && (
                          <span className="swap-indicator" aria-hidden="true">
                            <Move />
                            <span>Moving</span>
                          </span>
                        )}
                        {swapDrag?.target === cell.slot && (
                          <span className="swap-indicator" aria-hidden="true">
                            <ArrowLeftRight />
                            <span>Swap here</span>
                          </span>
                        )}
                      </div>
                    </ContextMenu>
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
                <Button disabled={busy} onClick={() => pick()}>
                  <ImagePlus />
                  Add images
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
                const layout = suggestedLayouts[index];
                const chosen =
                  !!layout &&
                  JSON.stringify(layout) === JSON.stringify(doc.layout);
                return (
                  <button
                    key={label}
                    aria-pressed={chosen}
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
              Undo restores your previous arrangement.
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
                    min={0.1}
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
                  <IconButton
                    variant="ghost"
                    tooltip={
                      doc.images[0]?.id === selectedId
                        ? "Already the first image"
                        : "Move earlier"
                    }
                    aria-label="Move image earlier"
                    disabled={busy || doc.images[0].id === selectedId}
                    onClick={() => {
                      const index = doc.images.findIndex(
                        (image) => image.id === selectedId,
                      );
                      swap(index, index - 1);
                    }}
                  >
                    <ArrowLeft />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    tooltip={
                      doc.images[doc.images.length - 1]?.id === selectedId
                        ? "Already the last image"
                        : "Move later"
                    }
                    aria-label="Move image later"
                    disabled={
                      busy ||
                      doc.images[doc.images.length - 1]?.id === selectedId
                    }
                    onClick={() => {
                      const index = doc.images.findIndex(
                        (image) => image.id === selectedId,
                      );
                      swap(index, index + 1);
                    }}
                  >
                    <ArrowRight />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    tooltip="Reset"
                    disabled={busy}
                    aria-label="Reset crop"
                    onClick={() =>
                      patchImage({ zoom: 1, panX: 50, panY: 50, fit: "cover" })
                    }
                  >
                    <RotateCcw />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    tooltip="Remove"
                    disabled={busy}
                    aria-label="Remove image"
                    onClick={() => remove()}
                  >
                    <Trash2 />
                  </IconButton>
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
