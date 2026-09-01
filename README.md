# CuteImageSorter

A cozy, keyboard-first desktop app for sorting images, videos, and audio into up to four folders. Built with Tauri 2, React 19, TypeScript, Tailwind CSS 4, and shadcn/ui components.

## Features

- Scan one folder, optionally including nested subfolders.
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

## Development

Prerequisites are the standard [Tauri 2 requirements](https://v2.tauri.app/start/prerequisites/), plus Node.js and pnpm.

```bash
pnpm install
pnpm tauri dev
```

Run the full verification suite with:

```bash
pnpm check
```

Build a distributable desktop app with:

```bash
pnpm tauri build
```
