# CuteImageSorter

A cozy, keyboard-first desktop app for sorting images, videos, and audio into up to four folders. Built with Tauri 2, React 19, TypeScript, Tailwind CSS 4, and shadcn/ui components.

## Features

- Browse for a folder or drag in folders, sets of files, or a mixture of both.
- Scan selected folders, optionally including nested subfolders.
- Sort into one to four destinations with the arrow keys, a click, or drag and drop.
- Create missing destination folders automatically.
- Move files on Rust worker threads while the next preview appears immediately.
- Stream video and audio through a private, tokenized localhost server with full RFC range support.
- Preload the next four previews without loading full media files.
- Avoid overwrites by adding a numeric suffix when a filename already exists.
- Preserve source placement by creating the selected destination beside each file.
- Serialize atomic no-clobber moves so concurrent same-name files cannot overwrite one another.
- Recover an interrupted cross-volume move safely the next time its source folder is scanned.
- Remember generated keep-structure destinations with a hidden marker so completed files stay excluded after a restart.

Preview support ultimately depends on codecs provided by the operating system webview. Files with recognized media extensions remain sortable even when the current webview cannot render their codec.

## Collage studio

Switch to **Collage** to compose images without moving or modifying originals.

- **Add images** accepts files, folders, or both in the macOS picker. Selecting a folder imports its images, optionally including subfolders. Other platforms and the browser preview offer a file/folder choice from the same button. You can also drop images or folders onto the desktop app, or paste an image with the Paste button or Cmd/Ctrl+V.
- Choose **Balanced**, **Wide story**, or **Spotlight** for an automatic arrangement. Adding or removing images rearranges frames; undo restores the previous composition.
- Drag an image onto another to swap them. The dragged image dims, and the hovered image is marked “Swap here”; release to swap or press Escape to cancel. Drag a shared divider to resize frames while keeping equal margins. Dividers also support arrow keys when focused.
- Select an image to fill or fit its frame, zoom, adjust its position, or switch to **Drag to crop**. Earlier/later buttons provide a keyboard-accessible way to reorder images.
- Set the canvas dimensions, white-by-default margin color, and margin width. Export a PNG or JPEG with dimensions from 800 to 6000 pixels per edge. Crowded layouts limit the maximum margin so every image remains visible.
- Desktop exports automatically optimize PNG compression and JPEG entropy coding, retaining the smaller result. Optimization preserves dimensions, decoded pixels, and color profiles; JPEG receives no additional lossy encoding. Browser previews use the browser’s image encoder.
- Undo/redo covers layout, crop, import, removal, and canvas changes. The collage stays available when switching to the sorter; export before closing the app.

Native import supports JPEG, PNG, WebP, GIF, BMP, TIFF, and ICO, including mixed sizes and EXIF orientation. Animated files use a still frame. Each collage supports up to 24 images, with 2400px maximum working-copy edges and a 40-megapixel working-image budget. Oversized or unreadable files are reported, and valid images are still imported. Larger exports upscale these working copies. Source files are never altered by import or editing.

## Development

Prerequisites are the standard [Tauri 2 requirements](https://v2.tauri.app/start/prerequisites/), plus Node.js, pnpm, and CMake (on macOS: `brew install cmake`). CMake builds the bundled, statically linked JPEG optimizer; users do not need to install image tools to run the app.

```bash
pnpm install
pnpm tauri dev
```

Run the full verification suite with:

```bash
pnpm check
```

Run the collage slider regression checks in WebKit (the macOS webview engine) and Chromium with:

```bash
pnpm exec playwright install chromium webkit
pnpm test:browser
```

Build a distributable desktop app with:

```bash
pnpm tauri build
```
