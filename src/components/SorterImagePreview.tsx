import { Maximize, Minus, Plus } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export function SorterImagePreview({
  src,
  alt,
  onError,
}: {
  src: string;
  alt: string;
  onError: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fitScale =
    image.width && image.height
      ? Math.min(viewport.width / image.width, viewport.height / image.height)
      : 0;
  const width = image.width * fitScale * zoom;
  const height = image.height * fitScale * zoom;

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  }, [width, height]);

  return (
    <div className="sorter-image-preview">
      <div ref={viewportRef} className="sorter-image-scroll">
        <div
          className="sorter-image-canvas"
          style={{
            width: Math.max(viewport.width, width),
            height: Math.max(viewport.height, height),
          }}
        >
          <img
            src={src}
            alt={alt}
            draggable={false}
            decoding="async"
            style={{ width, height }}
            onLoad={(event) => {
              setImage({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
            }}
            onError={onError}
          />
        </div>
      </div>
      <div
        className="sorter-image-controls"
        role="group"
        aria-label="Image zoom"
        title=""
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={!fitScale || zoom <= MIN_ZOOM}
          onClick={() =>
            setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))
          }
        >
          <Minus />
        </Button>
        <output
          aria-label="Zoom relative to fit"
          aria-live="polite"
          title="Zoom relative to the fitted image"
        >
          {Math.round(zoom * 100)}%
        </output>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={!fitScale || zoom >= MAX_ZOOM}
          onClick={() =>
            setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))
          }
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Fit full image"
          title="Fit full image"
          disabled={!fitScale}
          onClick={() => setZoom(1)}
        >
          <Maximize /> Fit
        </Button>
        <span className="sorter-image-hint">
          {zoom > 1 ? "Scroll to explore" : "Full image"}
        </span>
      </div>
    </div>
  );
}
