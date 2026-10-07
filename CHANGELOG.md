# Changelog

## 0.1.1

- Allow images in Collage Studio to zoom out to 10%, in both previews and exports.

## 0.1.0

- Refined the cozy pastel interface with offline fonts, clearer controls, useful disabled-state explanations, image context menus, and responsive layouts while preserving the cat and folder colors.
- Added workspace navigation that preserves the collage across switches and browser history, plus import/export progress and a lighter initial load.
- Fixed distorted portrait previews, stale removal Undo actions, and cancelled crop/divider gestures. Bounded collage undo memory and preview preloading by decoded image size.
- Hardened interrupted-move recovery and large folder scans, and made exports replace existing files atomically so a failed write cannot damage the previous export.

- Sped up collage imports by reusing prepared images, and exports with parallel image decoding, binary desktop transfers, and faster lossless PNG compression.

- Combined collage file and folder import under **Add images**, with mixed file/folder selection on macOS.
- Automatically reduced desktop PNG/JPEG export sizes with lossless compression optimization.

- Added subtle dragged-image and hover-target indicators when swapping collage images.

- Fixed collage sliders getting stuck to the pointer or failing to follow a drag on macOS, while preserving one undo step per drag.
- Images in the sorter now fit fully in the preview by default, with zoom in/out, a Fit reset, and scrolling to inspect enlarged images. Each new image starts fitted.

- Added a collage studio with folder, file, drop and clipboard import, suggested layouts, even adjustable margins, draggable frame resizing and image swapping, crop and zoom controls, undo/redo, and PNG/JPEG export.

- Simplified the app icon to its pastel gradient and sparkles.
- Added native drag-and-drop input for folders, sets of media files, and mixed selections.
- Added the initial CuteImageSorter desktop experience with recursive media discovery, up to four spatial destinations, keyboard and drag-and-drop sorting, serialized atomic and crash-recoverable background moves, tokenized localhost range streaming, bounded preview preloading, collision-safe filenames, durable output markers, and optional source-structure preservation.
