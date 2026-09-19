import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  FileAudio2,
  Files,
  Folder,
  FolderHeart,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Music2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Video,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast, Toaster } from "sonner";

import { CollageEditor } from "@/components/CollageEditor";
import { SorterImagePreview } from "@/components/SorterImagePreview";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  directionsForCount,
  firstUnusedPresetIndex,
  isMatchingSorterDrop,
  SORTER_DRAG_TYPE,
  type Direction,
} from "@/lib/sorting";

type MediaKind = "image" | "video" | "audio";
type AppView = "setup" | "sorting" | "collage";

type MediaFile = {
  id: string;
  mediaUrl: string;
  name: string;
  relativePath: string;
  extension: string;
  kind: MediaKind;
  size: number;
};

type TargetFolder = {
  id: string;
  label: string;
  path: string;
  color: string;
  pathMode: "auto" | "custom";
  selectionId?: string;
};

type MoveResult = {
  fileId: string;
  destinationPath: string;
};

type PickerResult = { path: string; name: string; selectionId?: string };
type ScanResult = { sessionId: number; files: MediaFile[] };
type SourceSelection = {
  basePath: string;
  label: string;
  itemCount: number;
  folderCount: number;
  fileCount: number;
};
type NativeSourceDrop = { token: string };

const targetPresets = [
  { label: "Favorites", color: "#f6a9b9" },
  { label: "Keep", color: "#92cfb3" },
  { label: "Maybe", color: "#94bfe8" },
  { label: "Archive", color: "#b9a6df" },
];

const directionIcons = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown,
};

function makeTarget(index: number): TargetFolder {
  const preset = targetPresets[index];
  return {
    id: crypto.randomUUID(),
    label: preset.label,
    path: "",
    color: preset.color,
    pathMode: "auto",
  };
}

function basename(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function dirname(path: string) {
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return path;
  const prefix = path.startsWith(separator) ? separator : "";
  return `${prefix}${parts.slice(0, -1).join(separator)}`;
}

function joinPath(parent: string, child: string) {
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]$/, "")}${separator}${child}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function isAbsolutePath(path: string) {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function unloadPreload(element: HTMLImageElement | HTMLMediaElement) {
  element.removeAttribute("src");
  if (element instanceof HTMLMediaElement) {
    element.pause();
    element.load();
  }
}

function App() {
  const [view, setView] = useState<AppView>("setup");
  const [sourceSelection, setSourceSelection] =
    useState<SourceSelection | null>(null);
  const [sourceDragActive, setSourceDragActive] = useState(false);
  const [targets, setTargets] = useState<TargetFolder[]>([
    makeTarget(0),
    makeTarget(1),
  ]);
  const [recursive, setRecursive] = useState(true);
  const [keepStructure, setKeepStructure] = useState(false);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [cursor, setCursor] = useState(0);
  const [retryFiles, setRetryFiles] = useState<MediaFile[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [totalFiles, setTotalFiles] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [pendingMoves, setPendingMoves] = useState(0);
  const inFlight = useRef(new Set<string>());
  const pendingMovesRef = useRef(0);
  const scanInFlight = useRef(false);
  const moveQueue = useRef(Promise.resolve());
  const preloadCache = useRef(
    new Map<string, HTMLImageElement | HTMLMediaElement>(),
  );
  const sourcePath = sourceSelection?.basePath ?? "";
  const clearPreloads = useCallback(() => {
    preloadCache.current.forEach(unloadPreload);
    preloadCache.current.clear();
  }, []);

  const current = retryFiles[0] ?? files[cursor];
  const remainingCount = files.length - cursor + retryFiles.length;
  const sortedCount = totalFiles - remainingCount;
  const progress = totalFiles ? (sortedCount / totalFiles) * 100 : 0;
  const lookaheadFiles = useMemo(() => {
    const retries = retryFiles.slice(1, 5);
    const mainStart = retryFiles.length > 0 ? cursor : cursor + 1;
    return [
      ...retries,
      ...files.slice(mainStart, mainStart + (4 - retries.length)),
    ];
  }, [cursor, files, retryFiles]);

  const targetDirections = useMemo(() => {
    const directions = directionsForCount(targets.length);
    return targets.map((target, index) => ({
      ...target,
      direction: directions[index],
    }));
  }, [targets]);

  useEffect(() => {
    if (view !== "sorting") {
      clearPreloads();
      return;
    }
    let imageBudget = 128 * 1024 * 1024;
    const lookahead = lookaheadFiles.filter((file) => {
      if (file.kind !== "image") return true;
      if (file.size > imageBudget) return false;
      imageBudget -= file.size;
      return true;
    });
    const desiredIds = new Set(lookahead.map((file) => file.id));

    preloadCache.current.forEach((element, id) => {
      if (desiredIds.has(id)) return;
      unloadPreload(element);
      preloadCache.current.delete(id);
    });

    lookahead.forEach((file) => {
      if (preloadCache.current.has(file.id)) return;
      if (file.kind === "image") {
        const image = new Image();
        image.decoding = "async";
        image.src = file.mediaUrl;
        preloadCache.current.set(file.id, image);
        return;
      }
      const media = document.createElement(file.kind);
      media.preload = "metadata";
      media.src = file.mediaUrl;
      media.load();
      preloadCache.current.set(file.id, media);
    });
  }, [clearPreloads, lookaheadFiles, view]);

  useEffect(() => () => clearPreloads(), [clearPreloads]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (pendingMovesRef.current === 0) return;
        event.preventDefault();
        toast("Still finishing file moves", {
          description:
            "Keep CuteImageSorter open until every move is safely complete.",
        });
      })
      .then((cleanup) => {
        unlisten = cleanup;
      });
    return () => unlisten?.();
  }, []);

  const applySourceSelection = useCallback((selection: SourceSelection) => {
    setSourceSelection(selection);
    setTargets((currentTargets) =>
      currentTargets.map((target) => ({
        ...target,
        path:
          target.pathMode === "auto"
            ? joinPath(selection.basePath, target.label)
            : target.path,
      })),
    );
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlistenDrag: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;
    const appWindow = getCurrentWindow();

    void Promise.all([
      appWindow.onDragDropEvent((event) => {
        if (view !== "setup" || isScanning) return;
        if (event.payload.type === "enter") setSourceDragActive(true);
        if (event.payload.type === "leave" || event.payload.type === "drop")
          setSourceDragActive(false);
      }),
      appWindow.listen<NativeSourceDrop>(
        "native-source-drop",
        ({ payload }) => {
          if (view !== "setup" || isScanning) return;
          setSourceDragActive(false);
          void invoke<SourceSelection>("accept_source_drop", {
            token: payload.token,
          })
            .then((selection) => {
              applySourceSelection(selection);
              toast.success("Ready to sort your dropped media", {
                description:
                  selection.itemCount === 1
                    ? selection.label
                    : `${selection.folderCount} folder${selection.folderCount === 1 ? "" : "s"} and ${selection.fileCount} file${selection.fileCount === 1 ? "" : "s"}`,
              });
            })
            .catch((error: unknown) => {
              toast.error("Couldn’t use those dropped items", {
                description: errorMessage(error),
              });
            });
        },
      ),
    ]).then(([dragCleanup, dropCleanup]) => {
      if (disposed) {
        dragCleanup();
        dropCleanup();
        return;
      }
      unlistenDrag = dragCleanup;
      unlistenDrop = dropCleanup;
    });

    return () => {
      disposed = true;
      unlistenDrag?.();
      unlistenDrop?.();
      setSourceDragActive(false);
    };
  }, [applySourceSelection, isScanning, view]);

  const chooseSource = async () => {
    try {
      const selected = await invoke<SourceSelection | null>("choose_source");
      if (!selected) return;
      applySourceSelection(selected);
    } catch (error) {
      toast.error("Couldn’t open that folder", {
        description: errorMessage(error),
      });
    }
  };

  const chooseTarget = async (id: string) => {
    try {
      const selected = await invoke<PickerResult | null>("choose_destination");
      if (!selected) return;
      const path = selected.path;
      setTargets((currentTargets) =>
        currentTargets.map((target) =>
          target.id === id
            ? {
                ...target,
                path,
                label: selected.name,
                pathMode: "custom",
                selectionId: selected.selectionId,
              }
            : target,
        ),
      );
    } catch (error) {
      toast.error("Couldn’t use that destination", {
        description: errorMessage(error),
      });
    }
  };

  const updateTarget = (id: string, patch: Partial<TargetFolder>) => {
    setTargets((currentTargets) =>
      currentTargets.map((target) => {
        if (target.id !== id) return target;
        const nextPath =
          patch.label !== undefined && target.pathMode === "auto" && sourcePath
            ? joinPath(sourcePath, patch.label)
            : (patch.path ?? target.path);
        return { ...target, ...patch, path: nextPath };
      }),
    );
  };

  const addTarget = () => {
    if (targets.length >= 4) return;
    const presetIndex = firstUnusedPresetIndex(
      targets.map((target) => target.label),
      targetPresets,
    );
    const next = makeTarget(presetIndex === -1 ? targets.length : presetIndex);
    if (sourcePath) next.path = joinPath(sourcePath, next.label);
    setTargets((currentTargets) => [...currentTargets, next]);
  };

  const removeTarget = (id: string) => {
    if (targets.length === 1) return;
    setTargets((currentTargets) =>
      currentTargets.filter((target) => target.id !== id),
    );
  };

  const startSorting = async () => {
    if (!sourcePath) {
      toast.error("Choose a folder with media first.");
      return;
    }
    const incomplete = targets.find(
      (target) => !target.label.trim() || !target.path.trim(),
    );
    if (incomplete) {
      toast.error("Give every destination a name and folder path.");
      return;
    }
    if (
      targets.some(
        (target) =>
          target.pathMode === "custom" &&
          !target.selectionId &&
          !isAbsolutePath(target.path.trim()),
      )
    ) {
      toast.error("Destination folders need an absolute path.");
      return;
    }
    if (scanInFlight.current) return;
    scanInFlight.current = true;
    setIsScanning(true);
    try {
      const result = await invoke<ScanResult>("scan_media", {
        request: {
          recursive,
          targets: targets.map((target) => ({
            id: target.id,
            path:
              target.pathMode === "custom" && !target.selectionId
                ? target.path.trim()
                : null,
            selectionId: target.selectionId ?? null,
            autoName: target.pathMode === "auto" ? target.label.trim() : null,
          })),
          keepStructure,
        },
      });
      const discovered = result.files;
      setFiles(discovered);
      setCursor(0);
      setRetryFiles([]);
      setTotalFiles(discovered.length);
      setSessionId(result.sessionId);
      setView("sorting");
      if (!discovered.length) {
        toast("No supported media found", {
          description: "Try including subfolders or choose another folder.",
        });
      }
    } catch (error) {
      toast.error("Couldn’t scan that folder", {
        description: errorMessage(error),
      });
    } finally {
      scanInFlight.current = false;
      setIsScanning(false);
    }
  };

  const sortCurrent = useCallback(
    (target: TargetFolder) => {
      if (!current || sessionId === null || inFlight.current.has(current.id))
        return;
      if (pendingMovesRef.current >= 8) {
        toast("Letting file moves catch up", {
          description: "You can keep sorting in just a moment.",
        });
        return;
      }
      const movingFile = current;
      inFlight.current.add(movingFile.id);
      pendingMovesRef.current += 1;
      setPendingMoves((count) => count + 1);
      if (retryFiles[0]?.id === movingFile.id) {
        setRetryFiles((currentFiles) => currentFiles.slice(1));
      } else {
        setCursor((currentCursor) => currentCursor + 1);
      }

      const executeMove = () =>
        invoke<MoveResult>("move_media", {
          request: {
            sessionId,
            fileId: movingFile.id,
            targetId: target.id,
          },
        });
      moveQueue.current = moveQueue.current
        .then(executeMove, executeMove)
        .then(() => {
          inFlight.current.delete(movingFile.id);
          pendingMovesRef.current = Math.max(0, pendingMovesRef.current - 1);
          setPendingMoves((count) => Math.max(0, count - 1));
        })
        .catch((error: unknown) => {
          inFlight.current.delete(movingFile.id);
          pendingMovesRef.current = Math.max(0, pendingMovesRef.current - 1);
          setPendingMoves((count) => Math.max(0, count - 1));
          setRetryFiles((currentFiles) => [...currentFiles, movingFile]);
          toast.error(`Couldn’t move ${movingFile.name}`, {
            description: errorMessage(error),
          });
        });
    },
    [current, retryFiles, sessionId],
  );

  useEffect(() => {
    if (view !== "sorting" || !current) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, button:not(.drop-target), video, audio, [contenteditable='true']",
        )
      )
        return;
      const direction = event.key.replace("Arrow", "").toLowerCase();
      const target = targetDirections.find(
        (candidate) => candidate.direction === direction,
      );
      if (!target) return;
      event.preventDefault();
      sortCurrent(target);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [current, sortCurrent, targetDirections, view]);

  const reset = () => {
    if (pendingMovesRef.current > 0) {
      toast("Still finishing file moves", {
        description:
          "Wait until every move is safely complete before restarting.",
      });
      return;
    }
    setView("setup");
    setFiles([]);
    setCursor(0);
    setRetryFiles([]);
    setTotalFiles(0);
    setSessionId(null);
  };

  return (
    <TooltipProvider>
      <div className="app-shell">
        <Toaster
          position="bottom-center"
          richColors
          toastOptions={{ className: "cute-toast" }}
        />
        <header className="titlebar" data-tauri-drag-region>
          <nav className="app-mode-switch" aria-label="Workspace">
            <button
              aria-pressed={view !== "collage"}
              disabled={pendingMoves > 0 || isScanning}
              onClick={() => setView(sessionId === null ? "setup" : "sorting")}
            >
              Sort
            </button>
            <button
              aria-pressed={view === "collage"}
              disabled={pendingMoves > 0 || isScanning}
              onClick={() => setView("collage")}
            >
              Collage
            </button>
          </nav>
          <div className="brand" data-tauri-drag-region>
            <div className="brand-mark" aria-hidden="true">
              <span>•ᴗ•</span>
            </div>
            <span data-tauri-drag-region>CuteImageSorter</span>
          </div>
          <div className="titlebar-sprinkles" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </header>

        <CollageEditor active={view === "collage"} />
        {view === "collage" ? null : view === "setup" ? (
          <SetupView
            sourceSelection={sourceSelection}
            sourceDragActive={sourceDragActive}
            targets={targets}
            recursive={recursive}
            keepStructure={keepStructure}
            isScanning={isScanning}
            onChooseSource={chooseSource}
            onChooseTarget={chooseTarget}
            onUpdateTarget={updateTarget}
            onAddTarget={addTarget}
            onRemoveTarget={removeTarget}
            onRecursiveChange={setRecursive}
            onKeepStructureChange={setKeepStructure}
            onStart={startSorting}
          />
        ) : current ? (
          <SortingView
            current={current}
            targetDirections={targetDirections}
            dragTarget={dragTarget}
            sortedCount={sortedCount}
            totalFiles={totalFiles}
            progress={progress}
            onBack={reset}
            onSort={sortCurrent}
            onDragTarget={setDragTarget}
          />
        ) : (
          <FinishedView
            totalFiles={totalFiles}
            pendingMoves={pendingMoves}
            onRestart={reset}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

type SetupViewProps = {
  sourceSelection: SourceSelection | null;
  sourceDragActive: boolean;
  targets: TargetFolder[];
  recursive: boolean;
  keepStructure: boolean;
  isScanning: boolean;
  onChooseSource: () => void;
  onChooseTarget: (id: string) => void;
  onUpdateTarget: (id: string, patch: Partial<TargetFolder>) => void;
  onAddTarget: () => void;
  onRemoveTarget: (id: string) => void;
  onRecursiveChange: (value: boolean) => void;
  onKeepStructureChange: (value: boolean) => void;
  onStart: () => void;
};

function SetupView({
  sourceSelection,
  sourceDragActive,
  targets,
  recursive,
  keepStructure,
  isScanning,
  onChooseSource,
  onChooseTarget,
  onUpdateTarget,
  onAddTarget,
  onRemoveTarget,
  onRecursiveChange,
  onKeepStructureChange,
  onStart,
}: SetupViewProps) {
  const sourcePath = sourceSelection?.basePath ?? "";
  return (
    <main
      className="setup-view"
      aria-busy={isScanning}
      inert={isScanning ? true : undefined}
    >
      <section className="setup-intro">
        <div className="eyebrow">
          <Sparkles /> A tidier media folder awaits
        </div>
        <h1>Let’s sort your little treasures.</h1>
        <p>
          Drop folders or a handful of files, name a few cozy corners, then
          flick each treasure home with your arrow keys.
        </p>
      </section>

      <section
        className={cn(
          "setup-card source-card",
          sourceDragActive && "is-source-dragged-over",
        )}
      >
        <div className="step-number">1</div>
        <div className="setup-card-copy">
          <h2>Choose folders or media files</h2>
          <p>Mix images, videos, and audio from one or many places.</p>
        </div>
        <Button
          variant={sourcePath ? "secondary" : "default"}
          size="lg"
          onClick={onChooseSource}
        >
          {sourcePath ? <FolderOpen /> : <FolderHeart />}
          {sourceSelection ? sourceSelection.label : "Browse for a folder"}
        </Button>
        {sourceSelection && (
          <div className="source-selection-summary">
            <span>
              <Files />
              {sourceSelection.folderCount} folder
              {sourceSelection.folderCount === 1 ? "" : "s"} ·{" "}
              {sourceSelection.fileCount} file
              {sourceSelection.fileCount === 1 ? "" : "s"}
            </span>
            <p className="selected-path" title={sourcePath}>
              Default destination: {sourcePath}
            </p>
          </div>
        )}
        <div className="source-drop-hint">
          <FolderHeart />
          <span>
            <strong>Drop folders or a set of files</strong>
            <small>You can mix both. Duplicate paths are skipped.</small>
          </span>
        </div>
        <div className="source-drop-overlay" aria-hidden="true">
          <FolderHeart />
          <strong>Drop your media here</strong>
          <span>Folders and file selections are both welcome</span>
        </div>
      </section>

      <section className="setup-card destinations-card">
        <div className="destinations-heading">
          <div className="step-number">2</div>
          <div className="setup-card-copy">
            <h2>Create your sorting corners</h2>
            <p>Use an existing path or type a new one—we’ll create it.</p>
          </div>
          <span className="folder-count">{targets.length} / 4 folders</span>
        </div>

        <div className="target-form-list">
          {targets.map((target, index) => (
            <div className="target-form-row" key={target.id}>
              <span
                className="target-color-dot"
                style={{ backgroundColor: target.color }}
              />
              <Input
                aria-label={`Destination ${index + 1} name`}
                className="target-name-input"
                value={target.label}
                maxLength={28}
                onChange={(event) =>
                  onUpdateTarget(target.id, { label: event.target.value })
                }
              />
              <Input
                aria-label={`Destination ${index + 1} path`}
                className="target-path-input"
                value={target.path}
                placeholder="/path/to/a/new/folder"
                spellCheck={false}
                onChange={(event) =>
                  onUpdateTarget(target.id, {
                    path: event.target.value,
                    pathMode: "custom",
                    selectionId: undefined,
                  })
                }
              />
              <IconButton
                variant="outline"
                tooltip="Browse"
                aria-label={`Browse for ${target.label}`}
                onClick={() => onChooseTarget(target.id)}
              >
                <FolderOpen />
              </IconButton>
              <IconButton
                variant="ghost"
                tooltip="Remove"
                aria-label={`Remove ${target.label}`}
                disabled={targets.length === 1}
                onClick={() => onRemoveTarget(target.id)}
              >
                <Trash2 />
              </IconButton>
            </div>
          ))}
        </div>
        {targets.length < 4 && (
          <Button variant="ghost" className="add-folder" onClick={onAddTarget}>
            <Plus /> Add another folder
          </Button>
        )}
      </section>

      <section className="setup-card options-card">
        <div className="option-row">
          <div className="option-icon mint">
            <FolderOpen />
          </div>
          <label htmlFor="recursive-switch">
            <strong>Look inside subfolders</strong>
            <span>Find media nested anywhere in the source folder.</span>
          </label>
          <Switch
            id="recursive-switch"
            checked={recursive}
            onCheckedChange={onRecursiveChange}
          />
        </div>
        <div className="option-divider" />
        <div className="option-row">
          <div className="option-icon lilac">
            <Folder />
          </div>
          <label htmlFor="structure-switch">
            <strong>Keep folder structure</strong>
            <span>
              Create each destination beside the file, preserving its place.
            </span>
          </label>
          <Switch
            id="structure-switch"
            checked={keepStructure}
            onCheckedChange={onKeepStructureChange}
          />
        </div>
      </section>

      <Button
        size="lg"
        className="start-button"
        disabled={isScanning}
        onClick={onStart}
      >
        {isScanning ? <LoaderCircle className="spin" /> : <Sparkles />}
        {isScanning ? "Gathering your media…" : "Start sorting"}
      </Button>
    </main>
  );
}

type DirectedTarget = TargetFolder & { direction: Direction };

type SortingViewProps = {
  current: MediaFile;
  targetDirections: DirectedTarget[];
  dragTarget: string | null;
  sortedCount: number;
  totalFiles: number;
  progress: number;
  onBack: () => void;
  onSort: (target: TargetFolder) => void;
  onDragTarget: (id: string | null) => void;
};

function SortingView({
  current,
  targetDirections,
  dragTarget,
  sortedCount,
  totalFiles,
  progress,
  onBack,
  onSort,
  onDragTarget,
}: SortingViewProps) {
  const handleDragStart = (event: DragEvent) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(SORTER_DRAG_TYPE, current.id);
  };

  return (
    <main className="sorting-view">
      <div className="sorting-toolbar">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft /> Setup
        </Button>
        <div className="progress-cluster">
          <div className="progress-copy">
            <span>{sortedCount} tucked away</span>
            <span>{totalFiles - sortedCount} to go</span>
          </div>
          <Progress value={progress} />
        </div>
        <div className="shortcut-hint">
          <span className="keycap">↑</span>
          <span className="keycap">↓</span>
          <span className="keycap">←</span>
          <span className="keycap">→</span>
          <span>to sort</span>
        </div>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        Sorting {current.name}. {totalFiles - sortedCount} files remaining.
      </p>
      <section className="sort-stage">
        {targetDirections.map((target) => (
          <DropTarget
            key={target.id}
            target={target}
            active={dragTarget === target.id}
            expectedFileId={current.id}
            onSort={() => onSort(target)}
            onDragTarget={onDragTarget}
          />
        ))}
        <MediaPreview
          key={current.id}
          file={current}
          onDragStart={handleDragStart}
        />
      </section>
    </main>
  );
}

type DropTargetProps = {
  target: DirectedTarget;
  active: boolean;
  expectedFileId: string;
  onSort: () => void;
  onDragTarget: (id: string | null) => void;
};

function DropTarget({
  target,
  active,
  expectedFileId,
  onSort,
  onDragTarget,
}: DropTargetProps) {
  const DirectionIcon = directionIcons[target.direction];
  const style = { "--target-color": target.color } as CSSProperties;
  return (
    <button
      className={cn("drop-target", active && "is-dragged-over")}
      data-position={target.direction}
      style={style}
      aria-label={`Move ${target.direction} into ${target.label}`}
      aria-keyshortcuts={`Arrow${target.direction[0].toUpperCase()}${target.direction.slice(1)}`}
      onClick={onSort}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes(SORTER_DRAG_TYPE)) {
          event.preventDefault();
          onDragTarget(target.id);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(SORTER_DRAG_TYPE)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          onDragTarget(null);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDragTarget(null);
        if (
          isMatchingSorterDrop(
            event.dataTransfer.types,
            event.dataTransfer.getData(SORTER_DRAG_TYPE),
            expectedFileId,
          )
        ) {
          onSort();
        }
      }}
    >
      <span className="drop-target-icon">
        <FolderHeart />
      </span>
      <span className="drop-target-copy">
        <strong>{target.label}</strong>
        <span title={target.path}>{basename(target.path)}</span>
      </span>
      <span
        className="direction-badge"
        aria-label={`${target.direction} arrow`}
      >
        <DirectionIcon />
      </span>
    </button>
  );
}

function MediaPreview({
  file,
  onDragStart,
}: {
  file: MediaFile;
  onDragStart: (event: DragEvent) => void;
}) {
  const [failed, setFailed] = useState(false);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const source = file.mediaUrl;

  useEffect(() => {
    if (file.kind === "image") return;
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = 0;
    void media.play().catch(() => undefined);
  }, [file.kind, file.id]);

  return (
    <article
      className="media-card"
      draggable
      onDragStart={onDragStart}
      title="Drag me into a folder"
    >
      <div className={cn("media-viewport", `media-${file.kind}`)}>
        {failed ? (
          <div className="media-fallback">
            {file.kind === "image" ? (
              <ImageIcon />
            ) : file.kind === "video" ? (
              <Video />
            ) : (
              <FileAudio2 />
            )}
            <strong>Preview unavailable</strong>
            <span>
              Your system webview may not include a codec for .{file.extension},
              but you can still sort it.
            </span>
          </div>
        ) : file.kind === "image" ? (
          <SorterImagePreview
            src={source}
            alt={file.name}
            onError={() => setFailed(true)}
          />
        ) : file.kind === "video" ? (
          <video
            key={file.id}
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={source}
            autoPlay
            controls
            playsInline
            preload="metadata"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="audio-player">
            <div className="album-art" aria-hidden="true">
              <span className="record-ring" />
              <Music2 />
              <div className="audio-sparkles">
                <span>✦</span>
                <span>·</span>
                <span>✦</span>
              </div>
            </div>
            <div className="sound-bars" aria-hidden="true">
              {[18, 30, 42, 24, 36, 48, 28, 40, 22, 34, 46, 26].map(
                (height, index) => (
                  <span key={index} style={{ height }} />
                ),
              )}
            </div>
            <audio
              key={file.id}
              ref={mediaRef as React.RefObject<HTMLAudioElement>}
              src={source}
              autoPlay
              controls
              preload="metadata"
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
      <footer className="media-meta">
        <span className={cn("kind-pill", file.kind)}>
          {file.kind === "image" ? (
            <ImageIcon />
          ) : file.kind === "video" ? (
            <Video />
          ) : (
            <FileAudio2 />
          )}
          {file.extension.toUpperCase()}
        </span>
        <div className="media-name">
          <strong title={file.name}>{file.name}</strong>
          <span title={file.relativePath}>
            {dirname(file.relativePath)} · {formatBytes(file.size)}
          </span>
        </div>
        <span className="drag-reminder">grab &amp; drop</span>
      </footer>
    </article>
  );
}

function FinishedView({
  totalFiles,
  pendingMoves,
  onRestart,
}: {
  totalFiles: number;
  pendingMoves: number;
  onRestart: () => void;
}) {
  const empty = totalFiles === 0;
  const finishing = pendingMoves > 0;
  return (
    <main className="finished-view">
      <div className="celebration" aria-hidden="true">
        <span>✦</span>
        <div className="finished-icon">
          {empty ? (
            <FolderOpen />
          ) : finishing ? (
            <LoaderCircle className="spin" />
          ) : (
            <Check />
          )}
        </div>
        <span>✦</span>
      </div>
      <div className="eyebrow">
        {empty
          ? "A quiet little folder"
          : finishing
            ? "Almost tidy!"
            : "All tidy!"}
      </div>
      <h1>
        {empty
          ? "No media found here."
          : finishing
            ? "Finishing your file moves…"
            : "Every file found its home."}
      </h1>
      <p>
        {empty
          ? "Try another folder or turn on subfolder searching."
          : finishing
            ? `${pendingMoves} ${pendingMoves === 1 ? "move is" : "moves are"} still running safely in the background. Keep the app open.`
            : `${totalFiles} ${totalFiles === 1 ? "treasure" : "treasures"} sorted and tucked away.`}
      </p>
      <Button size="lg" disabled={finishing} onClick={onRestart}>
        {finishing ? <LoaderCircle className="spin" /> : <RotateCcw />}
        {empty
          ? "Change setup"
          : finishing
            ? "Finishing safely…"
            : "Sort another folder"}
      </Button>
    </main>
  );
}

export default App;
