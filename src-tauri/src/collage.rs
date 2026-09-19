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
#[tauri::command]
pub async fn collage_pick(
    app: AppHandle,
    folder: bool,
    recursive: bool,
    capacity: usize,
) -> Result<Option<ImportResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file().set_title("Add images to your collage");
        let selected = if folder {
            picker.blocking_pick_folder().map(|p| vec![p])
        } else {
            picker
                .add_filter("Images", EXTENSIONS)
                .blocking_pick_files()
        };
        let Some(selected) = selected else {
            return Ok(None);
        };
        let paths = selected
            .into_iter()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(import_paths(paths, recursive, capacity)))
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
#[tauri::command]
pub async fn collage_save(app: AppHandle, data: String, format: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ext = match format.as_str() {
            "png" => "png",
            "jpeg" => "jpg",
            _ => return Err("Unsupported export format".into()),
        };
        if data.len() > 200 * 1024 * 1024 {
            return Err("Export is too large. Try smaller dimensions.".into());
        }
        let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
        let expected = if ext == "png" {
            ImageFormat::Png
        } else {
            ImageFormat::Jpeg
        };
        if image::guess_format(&bytes).map_err(|e| e.to_string())? != expected {
            return Err("Invalid export image".into());
        }
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
        fs::write(path, bytes).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(import_paths(vec![dir.clone()], true, 1).images.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
