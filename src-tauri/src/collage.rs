use crate::AppState;
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader};
use serde::Serialize;
use std::{collections::HashSet, fs, io::Cursor, path::PathBuf, sync::Arc};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

const EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "ico",
];
#[derive(Serialize)]
pub struct ImportedImage {
    name: String,
    data: String,
    width: u32,
    height: u32,
}
#[derive(Default, Serialize)]
pub struct ImportResult {
    images: Vec<ImportedImage>,
    warnings: Vec<String>,
}
fn encode(image: image::DynamicImage, name: String) -> Result<ImportedImage, String> {
    let image = if image.width() > 2400 || image.height() > 2400 {
        image.resize(2400, 2400, image::imageops::FilterType::Lanczos3)
    } else {
        image
    };
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(ImportedImage {
        name,
        width: image.width(),
        height: image.height(),
        data: STANDARD.encode(bytes.into_inner()),
    })
}
fn import_paths(paths: Vec<PathBuf>, recursive: bool, capacity: usize) -> ImportResult {
    let mut result = ImportResult::default();
    let mut pending = paths;
    pending.sort();
    pending.reverse();
    let mut seen = HashSet::new();
    let mut visited = 0;
    let mut pixels = 0u64;
    while let Some(path) = pending.pop() {
        visited += 1;
        if visited > 20_000 {
            result
                .warnings
                .push("Folder scan stopped after 20,000 entries. Choose a smaller folder.".into());
            break;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            result
                .warnings
                .push(format!("Could not read {}", path.display()));
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            match fs::read_dir(&path) {
                Ok(entries) => {
                    let mut children: Vec<_> = entries
                        .filter_map(Result::ok)
                        .map(|e| e.path())
                        .filter(|p| recursive || !p.is_dir())
                        .collect();
                    children.sort();
                    children.reverse();
                    pending.extend(children);
                }
                Err(_) => result
                    .warnings
                    .push(format!("Could not read folder {}", path.display())),
            }
            continue;
        }
        if !meta.is_file()
            || !EXTENSIONS.contains(
                &path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
                    .as_str(),
            )
        {
            continue;
        }
        if !seen.insert(path.clone()) {
            continue;
        }
        if result.images.len() >= capacity.min(24) {
            result
                .warnings
                .push("Image limit reached. Add the remaining images to another collage.".into());
            break;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let read = || -> Result<ImportedImage, String> {
            if meta.len() > 100 * 1024 * 1024 {
                return Err("file exceeds 100 MB".into());
            }
            let mut reader = ImageReader::open(&path)
                .map_err(|e| e.to_string())?
                .with_guessed_format()
                .map_err(|e| e.to_string())?;
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(20_000);
            limits.max_image_height = Some(20_000);
            limits.max_alloc = Some(256 * 1024 * 1024);
            reader.limits(limits);
            let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
            use image::ImageDecoder;
            let orientation = decoder.orientation().map_err(|e| e.to_string())?;
            let mut image =
                image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
            image.apply_orientation(orientation);
            encode(image, name.clone())
        };
        match read() {
            Ok(image) => {
                // Bound the response as well as each individual decoder allocation.
                let estimate = image.data.len() as u64;
                pixels += estimate;
                if pixels > 160 * 1024 * 1024 {
                    result
                        .warnings
                        .push("Import size limit reached. Choose fewer images.".into());
                    break;
                }
                result.images.push(image);
            }
            Err(error) => result.warnings.push(format!("{name}: {error}")),
        }
    }
    result
}
// AppKit allows files and folders in one panel; the cross-platform dialog API does not.
#[cfg(target_os = "macos")]
fn pick_paths(app: &AppHandle, _folder: bool) -> Result<Option<Vec<PathBuf>>, String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
        use objc2_foundation::NSString;

        let result = (|| {
            let main = MainThreadMarker::new().ok_or("Image picker requires the main thread")?;
            let panel = NSOpenPanel::openPanel(main);
            panel.setCanChooseFiles(true);
            panel.setCanChooseDirectories(true);
            panel.setAllowsMultipleSelection(true);
            panel.setCanCreateDirectories(false);
            panel.setTitle(Some(&NSString::from_str("Add images")));
            panel.setPrompt(Some(&NSString::from_str("Add images")));
            panel.setMessage(Some(&NSString::from_str(
                "Select images, folders, or both.",
            )));
            // Let directories remain selectable; import_paths filters supported images.
            if panel.runModal() != NSModalResponseOK {
                return Ok(None);
            }
            let paths = panel
                .URLs()
                .iter()
                .map(|url| {
                    url.path()
                        .map(|path| PathBuf::from(path.to_string()))
                        .ok_or_else(|| "Could not read the selected path".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(paths))
        })();
        let _ = send.send(result);
    })
    .map_err(|e| e.to_string())?;
    receive.recv().map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "macos"))]
fn pick_paths(app: &AppHandle, folder: bool) -> Result<Option<Vec<PathBuf>>, String> {
    let picker = app.dialog().file().set_title("Add images");
    let selected = if folder {
        picker.blocking_pick_folder().map(|p| vec![p])
    } else {
        picker
            .add_filter("Images", EXTENSIONS)
            .blocking_pick_files()
    };
    selected
        .map(|paths| {
            paths
                .into_iter()
                .map(|p| p.into_path().map_err(|e| e.to_string()))
                .collect()
        })
        .transpose()
}

#[tauri::command]
pub async fn collage_pick(
    app: AppHandle,
    folder: bool,
    recursive: bool,
    capacity: usize,
) -> Result<Option<ImportResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(pick_paths(&app, folder)?.map(|paths| import_paths(paths, recursive, capacity)))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn collage_drop(
    state: State<'_, Arc<AppState>>,
    token: String,
    recursive: bool,
    capacity: usize,
) -> Result<ImportResult, String> {
    let paths = {
        let mut data = state.inner.lock().map_err(|_| "Could not accept drop")?;
        if data.pending_source_drop.as_ref().map(|(t, _)| t) != Some(&token) {
            return Err("That drop expired. Drop the images again.".into());
        }
        data.pending_source_drop.take().unwrap().1
    };
    tauri::async_runtime::spawn_blocking(move || import_paths(paths, recursive, capacity))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn collage_clipboard() -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let data = clipboard
            .get_image()
            .map_err(|_| "Copy an image to the clipboard first.".to_string())?;
        if data.width.saturating_mul(data.height) > 40_000_000 {
            return Err("Clipboard image is too large. Import it as a file instead.".into());
        }
        let image = image::RgbaImage::from_raw(
            data.width as u32,
            data.height as u32,
            data.bytes.into_owned(),
        )
        .ok_or("Invalid clipboard image")?;
        Ok(ImportResult {
            images: vec![encode(image.into(), "Clipboard image.png".into())?],
            warnings: vec![],
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Repack the existing encoded image without resizing or another lossy encode.
/// Keep the original if a codec fails or cannot produce a smaller file.
fn optimize_export(bytes: Vec<u8>, format: ImageFormat) -> Vec<u8> {
    let mut best = bytes;
    match format {
        ImageFormat::Png => {
            // Interactive saves favor fast lossless compression over exhaustive filter trials.
            let mut options = oxipng::Options::from_preset(0);
            options.timeout = Some(std::time::Duration::from_millis(500));
            options.strip = oxipng::StripChunks::None;
            options.optimize_alpha = false;
            if let Ok(candidate) = oxipng::optimize_from_memory(&best, &options)
                && candidate.len() < best.len()
            {
                best = candidate;
            }
        }
        ImageFormat::Jpeg => {
            if let Ok(mut transformer) = turbojpeg::Transformer::new() {
                for progressive in [false, true] {
                    let mut transform = turbojpeg::Transform::default();
                    transform.optimize = true;
                    transform.progressive = progressive;
                    transform.copy_none = false;
                    if let Ok(candidate) = transformer.transform_to_vec(&transform, &best)
                        && candidate.len() < best.len()
                    {
                        best = candidate;
                    }
                }
            }
        }
        _ => {}
    }
    best
}

// Validate the raw payload before opening a dialog or running a codec optimizer.
fn export_format(bytes: &[u8]) -> Result<ImageFormat, String> {
    if bytes.len() > 150 * 1024 * 1024 {
        return Err("Export is too large. Try smaller dimensions.".into());
    }
    let format = image::guess_format(bytes).map_err(|e| e.to_string())?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg) {
        return Err("Unsupported export format".into());
    }
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|e| e.to_string())?;
    if width == 0 || height == 0 || width > 6000 || height > 6000 {
        return Err("Export dimensions must be between 1 and 6000 pixels per edge.".into());
    }
    Ok(format)
}

#[tauri::command]
pub async fn collage_save(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected an image payload".into());
    };
    if bytes.len() > 150 * 1024 * 1024 {
        return Err("Export is too large. Try smaller dimensions.".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let expected = export_format(&bytes)?;
        let ext = if expected == ImageFormat::Png {
            "png"
        } else {
            "jpg"
        };
        let Some(path) = app
            .dialog()
            .file()
            .set_title("Save collage")
            .set_file_name(format!("collage.{ext}"))
            .add_filter("Image", &[ext])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        fs::write(path, optimize_export(bytes, expected)).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn assert_lossless_smaller(original: Vec<u8>, format: ImageFormat) -> Vec<u8> {
        let optimized = optimize_export(original.clone(), format);
        let before = image::load_from_memory(&original).unwrap().to_rgba8();
        let after = image::load_from_memory(&optimized).unwrap().to_rgba8();
        assert_eq!(
            before, after,
            "Optimization must preserve every decoded pixel"
        );
        assert!(optimized.len() < original.len());
        println!("{format:?}: {} → {} bytes", original.len(), optimized.len());
        let repeated = optimize_export(optimized.clone(), format);
        assert!(repeated.len() <= optimized.len());
        assert_eq!(
            after,
            image::load_from_memory(&repeated).unwrap().to_rgba8()
        );
        optimized
    }

    #[test]
    fn png_optimization_preserves_color_and_transparent_pixels() {
        use image::{
            ImageEncoder,
            codecs::png::{CompressionType, FilterType, PngEncoder},
        };
        let image = image::RgbaImage::from_fn(257, 193, |x, y| {
            image::Rgba([
                (x % 256) as u8,
                (y % 256) as u8,
                120,
                [0, 128, 255][(x % 3) as usize],
            ])
        });
        let mut original = Vec::new();
        PngEncoder::new_with_quality(&mut original, CompressionType::Fast, FilterType::NoFilter)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        assert_lossless_smaller(original, ImageFormat::Png);
    }

    #[test]
    fn jpeg_optimization_preserves_pixels_dimensions_and_markers() {
        let image = image::RgbImage::from_fn(257, 193, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 120])
        });
        let mut original = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut original, 95)
            .encode_image(&image)
            .unwrap();
        // An APP2 marker has the same structure as a color-profile segment.
        let profile = b"ICC_PROFILE\0\x01\x01profile-preservation-fixture";
        let mut marker = vec![0xff, 0xe2];
        marker.extend_from_slice(&((profile.len() + 2) as u16).to_be_bytes());
        marker.extend_from_slice(profile);
        original.splice(2..2, marker);
        let optimized = assert_lossless_smaller(original, ImageFormat::Jpeg);
        assert!(optimized.windows(profile.len()).any(|part| part == profile));
    }

    #[test]
    fn failed_optimization_preserves_original_bytes() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg] {
            let bytes = b"invalid image".to_vec();
            assert_eq!(optimize_export(bytes.clone(), format), bytes);
        }
    }

    #[test]
    fn normalized_import_reports_dimensions_and_preserves_alpha() {
        let original = image::RgbaImage::from_fn(31, 17, |x, y| {
            image::Rgba([x as u8, y as u8, 123, [0, 128, 255][x as usize % 3]])
        });
        let imported = encode(original.clone().into(), "alpha.png".into()).unwrap();
        assert_eq!((imported.width, imported.height), (31, 17));
        let decoded = image::load_from_memory(&STANDARD.decode(imported.data).unwrap()).unwrap();
        assert_eq!(decoded.to_rgba8(), original);
        let large = encode(image::RgbImage::new(3000, 30).into(), "large.png".into()).unwrap();
        assert_eq!((large.width, large.height), (2400, 24));
    }

    #[test]
    fn binary_exports_validate_format_and_dimensions() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg] {
            let mut bytes = Cursor::new(Vec::new());
            image::RgbImage::new(60, 30)
                .write_to(&mut bytes, format)
                .unwrap();
            assert_eq!(export_format(bytes.get_ref()).unwrap(), format);
        }
        let mut bytes = Cursor::new(Vec::new());
        image::RgbImage::new(6001, 1)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        assert!(export_format(bytes.get_ref()).is_err());
        bytes = Cursor::new(Vec::new());
        image::RgbImage::new(10, 10)
            .write_to(&mut bytes, ImageFormat::Bmp)
            .unwrap();
        assert!(export_format(bytes.get_ref()).is_err());
        assert!(export_format(b"invalid").is_err());
    }

    // Run with --release --ignored --nocapture; timings are diagnostic, not CI assertions.
    #[test]
    #[ignore]
    fn benchmark_png_export() {
        for (width, height) in [(2400, 1800), (4800, 3600)] {
            let mut random = 42u32;
            let image = image::RgbImage::from_fn(width, height, |x, y| {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                let noise = (random % 32) as u8;
                image::Rgb([
                    (x / 16) as u8 ^ noise,
                    (y / 16) as u8 ^ noise,
                    ((x + y) / 32) as u8 ^ noise,
                ])
            });
            let mut bytes = Cursor::new(Vec::new());
            image.write_to(&mut bytes, ImageFormat::Png).unwrap();
            let bytes = bytes.into_inner();
            let mut previous = oxipng::Options::from_preset(3);
            previous.timeout = Some(std::time::Duration::from_secs(5));
            let start = std::time::Instant::now();
            let old = oxipng::optimize_from_memory(&bytes, &previous).unwrap();
            let old_time = start.elapsed();
            let start = std::time::Instant::now();
            let new = optimize_export(bytes.clone(), ImageFormat::Png);
            let new_time = start.elapsed();
            assert_eq!(image::load_from_memory(&new).unwrap().to_rgb8(), image);
            println!(
                "{width}x{height}: previous {old_time:?} / {} bytes; fast {new_time:?} / {} bytes; input {} bytes",
                old.len(),
                new.len(),
                bytes.len()
            );
        }
    }

    #[test]
    fn imports_mixed_formats_skips_bad_files_and_honors_capacity() {
        let dir = std::env::temp_dir().join(format!("collage-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("nested")).unwrap();
        image::RgbImage::new(60, 30)
            .save(dir.join("a.jpg"))
            .unwrap();
        image::RgbImage::new(30, 60)
            .save(dir.join("nested/b.png"))
            .unwrap();
        fs::write(dir.join("broken.png"), b"bad").unwrap();
        let result = import_paths(vec![dir.clone()], true, 24);
        assert_eq!(result.images.len(), 2);
        assert_eq!(result.warnings.len(), 1);
        let bytes = STANDARD.decode(&result.images[0].data).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (60, 30));
        assert_eq!(import_paths(vec![dir.clone()], false, 24).images.len(), 1);
        // Selecting both a directory and a file inside it must not add duplicates.
        assert_eq!(
            import_paths(vec![dir.clone(), dir.join("a.jpg")], true, 24)
                .images
                .len(),
            2
        );
        assert_eq!(import_paths(vec![dir.clone()], true, 1).images.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
