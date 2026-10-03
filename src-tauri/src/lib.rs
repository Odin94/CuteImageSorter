mod collage;
use filetime::FileTime;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
use filetime::set_file_times;
use hmac::{Hmac, Mac};
use http_range::HttpRange;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

const OUTPUT_MARKER_NAME: &str = ".cute-image-sorter-output";
const OUTPUT_MARKER_MAGIC: &[u8] = b"CuteImageSorter output\0v1\0";
const RECOVERY_PREFIX: &str = ".cute-image-sorter-recovery-";
const RECOVERY_MAGIC: &[u8] = b"CISR\0recovery\0v1\0";
const RECOVERY_COMMIT_MAGIC: &[u8] = b"CISR\0committed\0v1\0";
type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum MediaKind {
    Image,
    Video,
    Audio,
}

#[derive(Clone, Debug)]
struct FileRecord {
    path: PathBuf,
    source_root: PathBuf,
    identity: FileIdentity,
}

#[derive(Clone, Debug)]
struct SourceEntry {
    path: PathBuf,
    is_directory: bool,
}

#[derive(Clone, Debug)]
struct ApprovedSources {
    base: PathBuf,
    entries: Vec<SourceEntry>,
}

#[derive(Clone, Debug)]
struct DirectoryRecord {
    path: PathBuf,
    identity: Option<FileIdentity>,
}

#[derive(Debug)]
struct StagedSource {
    path: PathBuf,
    journal: PathBuf,
    commit: PathBuf,
}

#[derive(Debug)]
struct RecoveryRecord {
    original: PathBuf,
    staged: PathBuf,
    destination: PathBuf,
    size: u64,
    modified_nanos: u128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume: Option<u32>,
    #[cfg(windows)]
    index: Option<u64>,
    size: u64,
    modified_nanos: u128,
}

#[derive(Debug)]
struct Session {
    id: u64,
    targets: HashMap<String, DirectoryRecord>,
    keep_structure: bool,
    files: HashMap<String, FileRecord>,
}

#[derive(Debug, Default)]
struct StateData {
    approved_sources: Option<ApprovedSources>,
    pending_source_drop: Option<(String, Vec<PathBuf>)>,
    approved_destinations: HashMap<String, PathBuf>,
    generated_outputs: HashSet<PathBuf>,
    next_session_id: u64,
    session: Option<Session>,
}

#[derive(Debug)]
struct AppState {
    inner: Mutex<StateData>,
    move_lock: Mutex<()>,
    media_base: String,
    marker_key: [u8; 32],
}

impl AppState {
    fn new(media_base: String, marker_key: [u8; 32]) -> Self {
        Self {
            inner: Mutex::new(StateData::default()),
            move_lock: Mutex::new(()),
            media_base,
            marker_key,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickerResult {
    path: String,
    name: String,
    selection_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceSelectionResult {
    base_path: String,
    label: String,
    item_count: usize,
    folder_count: usize,
    file_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSourceDrop {
    token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaFile {
    id: String,
    media_url: String,
    name: String,
    relative_path: String,
    extension: String,
    kind: MediaKind,
    size: u64,
    preview_pixels: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetInput {
    id: String,
    path: Option<String>,
    selection_id: Option<String>,
    auto_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanRequest {
    recursive: bool,
    targets: Vec<TargetInput>,
    keep_structure: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    session_id: u64,
    files: Vec<MediaFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveRequest {
    session_id: u64,
    file_id: String,
    target_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveResult {
    file_id: String,
    destination_path: String,
}

fn lock_error() -> String {
    "CuteImageSorter’s file session is unavailable. Restart the app and try again.".to_string()
}

fn load_or_create_marker_key() -> Result<[u8; 32], String> {
    let project_dirs = directories::ProjectDirs::from("app", "CuteImageSorter", "CuteImageSorter")
        .ok_or_else(|| "Could not locate the app data folder.".to_string())?;
    let data_dir = project_dirs.data_local_dir();
    fs::create_dir_all(data_dir)
        .map_err(|error| format!("Could not create the app data folder: {error}"))?;
    let key_path = data_dir.join("output-marker.key");
    let read_key = || -> Result<[u8; 32], String> {
        let bytes = fs::read(&key_path)
            .map_err(|error| format!("Could not read the output marker key: {error}"))?;
        bytes
            .try_into()
            .map_err(|_| "The output marker key is damaged; remove it and restart.".to_string())
    };
    if key_path.exists() {
        return read_key();
    }

    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let mut key = [0_u8; 32];
    key[..16].copy_from_slice(first.as_bytes());
    key[16..].copy_from_slice(second.as_bytes());
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&key_path)
    {
        Ok(mut file) => {
            file.write_all(&key)
                .and_then(|()| file.sync_all())
                .map_err(|error| format!("Could not save the output marker key: {error}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))
                    .map_err(|error| format!("Could not protect the output marker key: {error}"))?;
            }
            Ok(key)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => read_key(),
        Err(error) => Err(format!("Could not create the output marker key: {error}")),
    }
}

impl FileIdentity {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        let modified_nanos = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_nanos());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
                size: metadata.len(),
                modified_nanos,
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            Self {
                volume: metadata.volume_serial_number(),
                index: metadata.file_index(),
                size: metadata.file_size(),
                modified_nanos,
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            Self {
                size: metadata.len(),
                modified_nanos,
            }
        }
    }

    fn same_object_as(&self, other: &Self) -> bool {
        #[cfg(unix)]
        {
            self.device == other.device && self.inode == other.inode
        }
        #[cfg(windows)]
        {
            matches!(
                (self.volume, self.index, other.volume, other.index),
                (Some(volume), Some(index), Some(other_volume), Some(other_index))
                    if volume == other_volume && index == other_index
            )
        }
        #[cfg(not(any(unix, windows)))]
        {
            self == other
        }
    }
}

fn path_contains_symlink(path: &Path, root: &Path) -> Result<bool, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "The file is outside the approved source.".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("Could not inspect {}: {error}", current.display()))?;
        if metadata.file_type().is_symlink() {
            return Ok(true);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn path_has_link_component(path: &Path) -> Result<bool, String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if !current.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("Could not inspect {}: {error}", current.display()))?;
        if metadata.file_type().is_symlink() {
            return Ok(true);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn verify_directory_record(record: &DirectoryRecord) -> Result<PathBuf, String> {
    if path_has_link_component(&record.path)? {
        return Err(format!(
            "{} now passes through a linked folder; choose it again.",
            record.path.display()
        ));
    }
    let canonical = record
        .path
        .canonicalize()
        .map_err(|error| format!("Could not inspect {}: {error}", record.path.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("Could not inspect {}: {error}", canonical.display()))?;
    if !metadata.is_dir()
        || record.identity.as_ref().is_some_and(|identity| {
            !identity.same_object_as(&FileIdentity::from_metadata(&metadata))
        })
    {
        return Err(format!(
            "{} changed after setup; choose it again.",
            record.path.display()
        ));
    }
    Ok(canonical)
}

fn verify_file_record(record: &FileRecord) -> Result<PathBuf, String> {
    if path_contains_symlink(&record.path, &record.source_root)? {
        return Err(
            "The file path changed through a link after scanning; it was not moved.".to_string(),
        );
    }
    let canonical = record
        .path
        .canonicalize()
        .map_err(|error| format!("Could not inspect {}: {error}", record.path.display()))?;
    if !canonical.starts_with(&record.source_root) {
        return Err("The file is no longer inside the approved source.".to_string());
    }
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("Could not inspect {}: {error}", canonical.display()))?;
    if FileIdentity::from_metadata(&metadata) != record.identity {
        return Err("The file changed after it was scanned; it was not moved.".to_string());
    }
    Ok(canonical)
}

fn classify(path: &Path) -> Option<(MediaKind, String)> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let kind = match extension.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "svg" | "avif"
        | "heic" | "heif" | "ico" | "jfif" | "dng" | "cr2" | "cr3" | "nef" | "arw" | "orf"
        | "rw2" | "raf" | "pef" | "srw" => MediaKind::Image,
        "mp4" | "m4v" | "mov" | "webm" | "mkv" | "avi" | "wmv" | "flv" | "mpg" | "mpeg" | "3gp"
        | "3g2" | "ogv" | "ts" | "mts" | "m2ts" | "vob" | "asf" => MediaKind::Video,
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "oga" | "opus" | "wma" | "aiff"
        | "aif" | "alac" | "amr" | "mid" | "midi" | "caf" | "ape" | "m4b" | "mka" => {
            MediaKind::Audio
        }
        _ => return None,
    };
    Some((kind, extension))
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.starts_with('.'))
}

fn normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Destination folders must use an absolute path.".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!("{} is not a safe folder path.", path.display()));
                }
            }
        }
    }
    Ok(normalized)
}

fn canonical_key(path: &Path) -> Result<PathBuf, String> {
    let normalized = normalize_absolute(path)?;
    if normalized.exists() {
        return normalized
            .canonicalize()
            .map_err(|error| format!("Could not inspect {}: {error}", normalized.display()));
    }

    let mut ancestor = normalized.as_path();
    let mut missing = Vec::<OsString>::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| format!("{} has no usable parent folder.", normalized.display()))?;
        missing.push(name.to_os_string());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| format!("{} has no usable parent folder.", normalized.display()))?;
    }
    if !ancestor.is_dir() {
        return Err(format!("{} is not a folder.", ancestor.display()));
    }
    let mut key = ancestor
        .canonicalize()
        .map_err(|error| format!("Could not inspect {}: {error}", ancestor.display()))?;
    for component in missing.iter().rev() {
        key.push(component);
    }
    Ok(key)
}

fn validate_targets(
    source_base: &Path,
    source_directories: &[PathBuf],
    inputs: Vec<TargetInput>,
    keep_structure: bool,
    approved_destinations: &HashMap<String, PathBuf>,
) -> Result<HashMap<String, DirectoryRecord>, String> {
    if inputs.is_empty() || inputs.len() > 4 {
        return Err("Choose between one and four destination folders.".to_string());
    }

    let mut targets = HashMap::new();
    let mut keys = HashSet::new();
    let mut kept_names = HashSet::new();
    let mut directory_identities = Vec::new();

    for input in inputs {
        if input.id.trim().is_empty() || targets.contains_key(&input.id) {
            return Err("Each destination needs a unique identity.".to_string());
        }
        let path = if let Some(selection_id) = input.selection_id {
            approved_destinations
                .get(&selection_id)
                .cloned()
                .ok_or_else(|| "Choose that destination folder again.".to_string())?
        } else if let Some(auto_name) = input.auto_name {
            let name_path = Path::new(auto_name.trim());
            let mut components = name_path.components();
            let Some(Component::Normal(name)) = components.next() else {
                return Err("Automatic destinations need a simple folder name.".to_string());
            };
            if components.next().is_some() {
                return Err("Automatic destinations cannot contain path separators.".to_string());
            }
            source_base.join(name)
        } else {
            let typed_path = input
                .path
                .as_deref()
                .ok_or_else(|| "Every destination needs a folder path.".to_string())?;
            normalize_absolute(Path::new(typed_path.trim()))?
        };
        let path = normalize_absolute(&path)?;
        let folder_name = path
            .file_name()
            .ok_or_else(|| "Every destination needs a folder name.".to_string())?
            .to_os_string();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let effective_name = folder_name.to_string_lossy().to_lowercase();
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let effective_name = folder_name.clone();
        if keep_structure && !kept_names.insert(effective_name) {
            return Err(
                "When keeping structure, every destination needs a different folder name."
                    .to_string(),
            );
        }

        if path_has_link_component(&path)? {
            return Err(format!(
                "{} passes through a linked folder. Choose a direct destination instead.",
                path.display()
            ));
        }
        if !keep_structure {
            fs::create_dir_all(&path)
                .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        }
        if path.exists() && !path.is_dir() {
            return Err(format!("{} is not a folder.", path.display()));
        }
        let key = canonical_key(&path)?;
        if source_directories.iter().any(|source| &key == source) {
            return Err("The source folder cannot also be a destination.".to_string());
        }
        if !keys.insert(key) {
            return Err("Each destination needs a different folder path.".to_string());
        }
        if path_has_link_component(&path)? {
            return Err(format!(
                "{} passes through a linked folder. Choose a direct destination instead.",
                path.display()
            ));
        }
        let identity = if keep_structure {
            None
        } else {
            Some(FileIdentity::from_metadata(&fs::metadata(&path).map_err(
                |error| format!("Could not inspect {}: {error}", path.display()),
            )?))
        };
        if let Some(identity) = &identity {
            if directory_identities
                .iter()
                .any(|existing: &FileIdentity| existing.same_object_as(identity))
            {
                return Err("Each destination needs a different folder path.".to_string());
            }
            directory_identities.push(identity.clone());
        }
        targets.insert(input.id, DirectoryRecord { path, identity });
    }
    Ok(targets)
}

fn marker_path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect()
    }
    #[cfg(not(any(unix, windows)))]
    {
        path.to_string_lossy().as_bytes().to_vec()
    }
}

fn path_from_native_bytes(bytes: Vec<u8>) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(OsString::from_vec(bytes)))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        if !bytes.len().is_multiple_of(2) {
            return None;
        }
        let wide = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        Some(PathBuf::from(OsString::from_wide(&wide)))
    }
    #[cfg(not(any(unix, windows)))]
    {
        String::from_utf8(bytes).ok().map(PathBuf::from)
    }
}

fn recovery_record_bytes(record: &RecoveryRecord) -> Result<Vec<u8>, String> {
    let paths = [
        marker_path_bytes(&record.original),
        marker_path_bytes(&record.staged),
        marker_path_bytes(&record.destination),
    ];
    let mut bytes = RECOVERY_MAGIC.to_vec();
    bytes.extend_from_slice(&record.size.to_le_bytes());
    bytes.extend_from_slice(&record.modified_nanos.to_le_bytes());
    for path in paths {
        let length = u32::try_from(path.len())
            .map_err(|_| "A recovery path is too long to record.".to_string())?;
        bytes.extend_from_slice(&length.to_le_bytes());
        bytes.extend_from_slice(&path);
    }
    Ok(bytes)
}

fn parse_recovery_record(bytes: &[u8]) -> Option<RecoveryRecord> {
    if bytes.len() > 64 * 1024 || !bytes.starts_with(RECOVERY_MAGIC) {
        return None;
    }
    let mut cursor = RECOVERY_MAGIC.len();
    let take = |cursor: &mut usize, length: usize| -> Option<&[u8]> {
        let end = cursor.checked_add(length)?;
        let value = bytes.get(*cursor..end)?;
        *cursor = end;
        Some(value)
    };
    let size = u64::from_le_bytes(take(&mut cursor, 8)?.try_into().ok()?);
    let modified_nanos = u128::from_le_bytes(take(&mut cursor, 16)?.try_into().ok()?);
    let mut paths = Vec::with_capacity(3);
    for _ in 0..3 {
        let length = u32::from_le_bytes(take(&mut cursor, 4)?.try_into().ok()?) as usize;
        paths.push(path_from_native_bytes(take(&mut cursor, length)?.to_vec())?);
    }
    if cursor != bytes.len() {
        return None;
    }
    Some(RecoveryRecord {
        original: paths.remove(0),
        staged: paths.remove(0),
        destination: paths.remove(0),
        size,
        modified_nanos,
    })
}

fn remove_recovery_journal(journal: &Path) -> io::Result<()> {
    let commit = journal.with_extension("commit");
    let parent = journal.parent().unwrap_or_else(|| Path::new("."));
    match fs::remove_file(commit) {
        Ok(()) => sync_directory(parent)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    };
    fs::remove_file(journal)?;
    sync_directory(parent)
}

fn mark_recovery_committed(staged: &StagedSource) -> io::Result<()> {
    let mut commit = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged.commit)?;
    commit.write_all(RECOVERY_COMMIT_MAGIC)?;
    commit.sync_all()?;
    sync_directory(staged.journal.parent().unwrap_or_else(|| Path::new(".")))
}

fn staged_path_for_recovery_journal(journal: &Path) -> Option<PathBuf> {
    let name = journal.file_name()?.to_str()?;
    let recovery_id = name.strip_prefix(RECOVERY_PREFIX)?.strip_suffix(".bin")?;
    Uuid::parse_str(recovery_id).ok()?;
    Some(
        journal
            .parent()?
            .join(format!(".cute-image-sorter-source-{recovery_id}.tmp")),
    )
}

fn read_regular_file_bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(io::Error::other(
            "file is not regular or exceeds the size limit",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("file is not regular"));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::other("file exceeds the size limit"));
    }
    Ok(bytes)
}

fn recover_staged_moves(directory: &Path, warnings: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let journal = entry.path();
        let is_journal = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(RECOVERY_PREFIX) && name.ends_with(".bin"));
        if !is_journal {
            continue;
        }
        let bytes = match read_regular_file_bounded(&journal, 64 * 1024) {
            Ok(bytes) => bytes,
            Err(error) => {
                warnings.push(format!(
                    "Could not read recovery journal {}: {error}",
                    journal.display()
                ));
                continue;
            }
        };
        let Some(record) = parse_recovery_record(&bytes) else {
            let incomplete_without_staged_file = staged_path_for_recovery_journal(&journal)
                .is_some_and(|staged| {
                    fs::symlink_metadata(staged)
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                });
            if incomplete_without_staged_file && remove_recovery_journal(&journal).is_ok() {
                continue;
            }
            warnings.push(format!(
                "Could not parse the recovery journal at {}.",
                journal.display()
            ));
            continue;
        };
        let valid_location = record.original.parent() == Some(directory)
            && record.staged.parent() == Some(directory)
            && record
                .staged
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.starts_with(".cute-image-sorter-source-"));
        if !valid_location {
            warnings.push(format!(
                "Ignored an invalid recovery journal at {}.",
                journal.display()
            ));
            continue;
        }
        let commit = journal.with_extension("commit");
        let destination_matches = fs::metadata(&record.destination).is_ok_and(|metadata| {
            let identity = FileIdentity::from_metadata(&metadata);
            identity.size == record.size && identity.modified_nanos == record.modified_nanos
        });
        let destination_is_complete =
            read_regular_file_bounded(&commit, RECOVERY_COMMIT_MAGIC.len())
                .is_ok_and(|contents| contents == RECOVERY_COMMIT_MAGIC)
                && destination_matches;
        if record.original.exists() && !record.staged.exists() {
            let _ = remove_recovery_journal(&journal);
            continue;
        }
        if !record.staged.exists() {
            if destination_is_complete || (!record.original.exists() && destination_matches) {
                let _ = remove_recovery_journal(&journal);
            } else {
                warnings.push(format!(
                    "Recovery data at {} refers to a missing file.",
                    journal.display()
                ));
            }
            continue;
        }
        if record.original.exists() {
            warnings.push(format!(
                "Both the original and recovery copy exist for {}.",
                record.original.display()
            ));
            continue;
        }
        let recovery = if destination_is_complete {
            fs::remove_file(&record.staged)
        } else {
            rename_no_replace(&record.staged, &record.original)
        };
        match recovery.and_then(|()| remove_recovery_journal(&journal)) {
            Ok(()) => {}
            Err(error) => warnings.push(format!(
                "Could not recover {}: {error}",
                record.original.display()
            )),
        }
    }
}

fn output_marker_contents(path: &Path, marker_key: &[u8; 32]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(marker_key).expect("HMAC accepts a 32-byte key");
    mac.update(OUTPUT_MARKER_MAGIC);
    mac.update(&marker_path_bytes(path));
    let mut contents = OUTPUT_MARKER_MAGIC.to_vec();
    contents.extend_from_slice(&mac.finalize().into_bytes());
    contents
}

fn has_valid_output_marker(path: &Path, marker_key: &[u8; 32]) -> bool {
    let Ok(contents) = read_regular_file_bounded(
        &path.join(OUTPUT_MARKER_NAME),
        OUTPUT_MARKER_MAGIC.len() + 32,
    ) else {
        return false;
    };
    contents == output_marker_contents(path, marker_key)
}

fn should_skip_directory(path: &Path, excluded: &HashSet<PathBuf>, marker_key: &[u8; 32]) -> bool {
    let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    has_valid_output_marker(&normalized, marker_key)
        || excluded.iter().any(|target| normalized.starts_with(target))
}

fn scan_exclusions(
    source_directories: &[PathBuf],
    targets: &HashMap<String, DirectoryRecord>,
    generated_outputs: HashSet<PathBuf>,
) -> HashSet<PathBuf> {
    let mut excluded = targets
        .values()
        .map(|target| &target.path)
        .filter(|path| path.exists())
        .filter_map(|path| path.canonicalize().ok())
        .filter(|path| {
            source_directories
                .iter()
                .any(|source| path.starts_with(source) && path != source)
        })
        .collect::<HashSet<_>>();
    excluded.extend(generated_outputs.into_iter().filter(|path| {
        path.exists()
            && source_directories
                .iter()
                .any(|source| path.starts_with(source) && path != source)
    }));
    excluded
}

fn media_url(media_base: &str, session_id: u64, file_id: &str) -> String {
    format!("{media_base}/{session_id}/{file_id}")
}

struct CollectedFile {
    dto: MediaFile,
    record: FileRecord,
}

struct ScanContext<'a> {
    root: &'a Path,
    media_base: &'a str,
    session_id: u64,
    recursive: bool,
    excluded: &'a HashSet<PathBuf>,
    marker_key: &'a [u8; 32],
}

fn collect_media_file(
    path: PathBuf,
    metadata: fs::Metadata,
    context: &ScanContext<'_>,
    output: &mut Vec<CollectedFile>,
) {
    if is_hidden(&path) {
        return;
    }
    let Some((kind, extension)) = classify(&path) else {
        return;
    };
    let file_id = Uuid::new_v4().simple().to_string();
    let relative_path = path.strip_prefix(context.root).unwrap_or(&path);
    output.push(CollectedFile {
        dto: MediaFile {
            id: file_id.clone(),
            media_url: media_url(context.media_base, context.session_id, &file_id),
            name: path
                .file_name()
                .unwrap_or_else(|| path.as_os_str())
                .to_string_lossy()
                .into_owned(),
            relative_path: relative_path.to_string_lossy().into_owned(),
            extension,
            kind,
            size: metadata.len(),
            preview_pixels: if matches!(kind, MediaKind::Image) {
                image::ImageReader::open(&path)
                    .ok()
                    .and_then(|reader| reader.with_guessed_format().ok())
                    .and_then(|reader| reader.into_dimensions().ok())
                    .map(|(width, height)| u64::from(width) * u64::from(height))
            } else {
                None
            },
        },
        record: FileRecord {
            path,
            source_root: context.root.to_path_buf(),
            identity: FileIdentity::from_metadata(&metadata),
        },
    });
}

fn collect_media(
    directory: &Path,
    context: &ScanContext<'_>,
    output: &mut Vec<CollectedFile>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let mut pending = vec![directory.to_path_buf()];
    let mut visited = 0usize;
    while let Some(current) = pending.pop() {
        recover_staged_moves(&current, warnings);
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                let message = format!("Could not read {}: {error}", current.display());
                if current == directory {
                    return Err(message);
                }
                warnings.push(message);
                continue;
            }
        };
        for entry in entries {
            visited += 1;
            if visited > 200_000 {
                return Err(
                    "Folder scan exceeded 200,000 entries. Choose a smaller source folder.".into(),
                );
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    warnings.push(format!(
                        "Could not read an entry in {}: {error}",
                        current.display()
                    ));
                    continue;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    warnings.push(format!("Could not inspect {}: {error}", path.display()));
                    continue;
                }
            };
            if file_type.is_dir() {
                if context.recursive
                    && !is_hidden(&path)
                    && !should_skip_directory(&path, context.excluded, context.marker_key)
                {
                    pending.push(path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    warnings.push(format!("Could not inspect {}: {error}", path.display()));
                    continue;
                }
            };
            collect_media_file(path, metadata, context, output);
        }
    }
    Ok(())
}

fn approve_source_paths(
    paths: Vec<PathBuf>,
) -> Result<(ApprovedSources, SourceSelectionResult), String> {
    if paths.is_empty() {
        return Err("Drop at least one media file or folder.".to_string());
    }
    if paths.len() > 10_000 {
        return Err("Drop fewer than 10,000 items at a time.".to_string());
    }

    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for path in paths {
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let metadata = fs::metadata(&canonical)
            .map_err(|error| format!("Could not inspect {}: {error}", canonical.display()))?;
        if metadata.is_dir() {
            entries.push(SourceEntry {
                path: canonical,
                is_directory: true,
            });
        } else if metadata.is_file() && classify(&canonical).is_some() {
            entries.push(SourceEntry {
                path: canonical,
                is_directory: false,
            });
        }
    }
    if entries.is_empty() {
        return Err("No supported media files or folders were dropped.".to_string());
    }

    let first = &entries[0];
    let base = if first.is_directory {
        first.path.clone()
    } else {
        first
            .path
            .parent()
            .ok_or_else(|| "The first dropped file has no parent folder.".to_string())?
            .to_path_buf()
    };
    let folder_count = entries.iter().filter(|entry| entry.is_directory).count();
    let file_count = entries.len() - folder_count;
    let label = if entries.len() == 1 {
        entries[0]
            .path
            .file_name()
            .unwrap_or_else(|| entries[0].path.as_os_str())
            .to_string_lossy()
            .into_owned()
    } else {
        format!("{} dropped items", entries.len())
    };
    let result = SourceSelectionResult {
        base_path: base.to_string_lossy().into_owned(),
        label,
        item_count: entries.len(),
        folder_count,
        file_count,
    };
    Ok((ApprovedSources { base, entries }, result))
}

fn store_approved_sources(state: &AppState, sources: ApprovedSources) -> Result<(), String> {
    let mut data = state.inner.lock().map_err(|_| lock_error())?;
    data.approved_sources = Some(sources);
    data.session = None;
    Ok(())
}

fn picker_result(path: PathBuf, selection_id: Option<String>) -> PickerResult {
    PickerResult {
        name: path
            .file_name()
            .unwrap_or_else(|| path.as_os_str())
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        selection_id,
    }
}

#[tauri::command]
async fn choose_source(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<SourceSelectionResult>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Choose your media folder")
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("Could not use that folder: {error}"))?
            .canonicalize()
            .map_err(|error| format!("Could not open that folder: {error}"))?;
        if !path.is_dir() {
            return Err("Choose an existing source folder.".to_string());
        }
        let (sources, result) = approve_source_paths(vec![path])?;
        store_approved_sources(&state, sources)?;
        Ok(Some(result))
    })
    .await
    .map_err(|error| format!("The folder picker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn accept_source_drop(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<SourceSelectionResult, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let paths = {
            let mut data = state.inner.lock().map_err(|_| lock_error())?;
            let (pending_token, paths) = data
                .pending_source_drop
                .take()
                .ok_or_else(|| "That file drop is no longer available.".to_string())?;
            if pending_token != token {
                return Err("That file drop is no longer available.".to_string());
            }
            paths
        };
        let (sources, result) = approve_source_paths(paths)?;
        store_approved_sources(&state, sources)?;
        Ok(result)
    })
    .await
    .map_err(|error| format!("The dropped items could not be accepted: {error}"))?
}

#[tauri::command]
async fn choose_destination(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<PickerResult>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Choose a destination folder")
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("Could not use that folder: {error}"))?;
        let selection_id = Uuid::new_v4().simple().to_string();
        state
            .inner
            .lock()
            .map_err(|_| lock_error())?
            .approved_destinations
            .insert(selection_id.clone(), path.clone());
        Ok(Some(picker_result(path, Some(selection_id))))
    })
    .await
    .map_err(|error| format!("The folder picker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn scan_media(
    request: ScanRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<ScanResult, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _session_guard = state.move_lock.lock().map_err(|_| lock_error())?;
        let (sources, session_id, approved_destinations, generated_outputs) = {
            let mut data = state.inner.lock().map_err(|_| lock_error())?;
            let sources = data
                .approved_sources
                .clone()
                .ok_or_else(|| "Choose or drop some source media first.".to_string())?;
            data.next_session_id = data.next_session_id.saturating_add(1).max(1);
            (
                sources,
                data.next_session_id,
                data.approved_destinations.clone(),
                data.generated_outputs.clone(),
            )
        };
        let source_directories = sources
            .entries
            .iter()
            .filter_map(|entry| {
                if entry.is_directory {
                    Some(entry.path.clone())
                } else {
                    entry.path.parent().map(Path::to_path_buf)
                }
            })
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let targets = validate_targets(
            &sources.base,
            &source_directories,
            request.targets,
            request.keep_structure,
            &approved_destinations,
        )?;
        let excluded = scan_exclusions(&source_directories, &targets, generated_outputs);

        let mut collected = Vec::new();
        let mut warnings = Vec::new();
        for entry in &sources.entries {
            let root = if entry.is_directory {
                entry.path.as_path()
            } else {
                entry
                    .path
                    .parent()
                    .ok_or_else(|| format!("{} has no parent folder.", entry.path.display()))?
            };
            let scan_context = ScanContext {
                root,
                media_base: &state.media_base,
                session_id,
                recursive: request.recursive,
                excluded: &excluded,
                marker_key: &state.marker_key,
            };
            if entry.is_directory {
                collect_media(&entry.path, &scan_context, &mut collected, &mut warnings)?;
            } else {
                let metadata = fs::metadata(&entry.path).map_err(|error| {
                    format!("Could not inspect {}: {error}", entry.path.display())
                })?;
                collect_media_file(entry.path.clone(), metadata, &scan_context, &mut collected);
            }
        }
        let mut seen_paths = HashSet::new();
        collected.retain(|file| seen_paths.insert(file.record.path.clone()));
        if !warnings.is_empty() {
            let summary = warnings.into_iter().take(3).collect::<Vec<_>>().join("\n");
            return Err(format!(
                "Some source items could not be read, so sorting did not start:\n{summary}"
            ));
        }
        collected.sort_by_cached_key(|file| {
            (
                file.dto.relative_path.to_lowercase(),
                file.record.path.clone(),
            )
        });

        let mut files = HashMap::new();
        let dtos = collected
            .into_iter()
            .map(|collected| {
                files.insert(collected.dto.id.clone(), collected.record);
                collected.dto
            })
            .collect::<Vec<_>>();
        state.inner.lock().map_err(|_| lock_error())?.session = Some(Session {
            id: session_id,
            targets,
            keep_structure: request.keep_structure,
            files,
        });
        Ok(ScanResult {
            session_id,
            files: dtos,
        })
    })
    .await
    .map_err(|error| format!("The media scan stopped unexpectedly: {error}"))?
}

fn destination_candidate(folder: &Path, file_name: &OsStr, index: usize) -> PathBuf {
    if index == 1 {
        return folder.join(file_name);
    }
    let path = Path::new(file_name);
    let stem = path.file_stem().unwrap_or_else(|| OsStr::new("media"));
    let mut name = OsString::from(stem);
    name.push(format!(" ({index})"));
    if let Some(extension) = path.extension() {
        name.push(".");
        name.push(extension);
    }
    folder.join(name)
}

enum PublishAttempt {
    Published,
    Collision,
}

#[cfg(target_os = "macos")]
fn copy_preserving_metadata(source: &Path, destination: &File, _path: &Path) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn fcopyfile(from: i32, to: i32, state: *mut std::ffi::c_void, flags: u32) -> i32;
    }
    const COPYFILE_ALL: u32 = 0x0f;
    const COPYFILE_NOCACHE: u32 = 1 << 14;
    let source_file = File::open(source)?;
    let result = unsafe {
        fcopyfile(
            source_file.as_raw_fd(),
            destination.as_raw_fd(),
            std::ptr::null_mut(),
            COPYFILE_ALL | COPYFILE_NOCACHE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn copy_preserving_metadata(source: &Path, destination: &File, path: &Path) -> io::Result<()> {
    let status = std::process::Command::new("cp")
        .arg("--preserve=all")
        .arg("--reflink=auto")
        .arg("--")
        .arg(source)
        .arg(path)
        .status();
    if status.is_ok_and(|status| status.success()) {
        Ok(())
    } else {
        let metadata = fs::metadata(source)?;
        let mut source_file = File::open(source)?;
        let mut destination_file = destination.try_clone()?;
        destination_file.set_len(0)?;
        destination_file.seek(SeekFrom::Start(0))?;
        io::copy(&mut source_file, &mut destination_file)?;
        fs::set_permissions(path, metadata.permissions())?;
        filetime::set_file_times(
            path,
            FileTime::from_last_access_time(&metadata),
            FileTime::from_last_modification_time(&metadata),
        )?;
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn copy_preserving_metadata(source: &Path, _destination: &File, path: &Path) -> io::Result<()> {
    let metadata = fs::metadata(source)?;
    fs::copy(source, path)?;
    fs::set_permissions(path, metadata.permissions())?;
    set_file_times(
        path,
        FileTime::from_last_access_time(&metadata),
        FileTime::from_last_modification_time(&metadata),
    )?;
    Ok(())
}

fn verify_copy_metadata(source: &Path, destination: &Path) -> io::Result<()> {
    let source_metadata = fs::metadata(source)?;
    let destination_metadata = fs::metadata(destination)?;
    let source_modified = FileTime::from_last_modification_time(&source_metadata);
    let destination_modified = FileTime::from_last_modification_time(&destination_metadata);
    if source_metadata.len() != destination_metadata.len()
        || source_metadata.permissions().readonly() != destination_metadata.permissions().readonly()
        || source_modified != destination_modified
    {
        return Err(io::Error::other(
            "the copied file did not preserve its size, timestamp, and permissions",
        ));
    }
    Ok(())
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn sync_rename_or_rollback<F>(
    original: &Path,
    destination: &Path,
    directories: &[&Path],
    syncer: F,
) -> io::Result<()>
where
    F: Fn(&Path) -> io::Result<()>,
{
    for directory in directories {
        if let Err(sync_error) = syncer(directory) {
            if rename_no_replace(destination, original).is_ok() {
                for directory in directories {
                    let _ = syncer(directory);
                }
                return Err(sync_error);
            }
            // The rename committed but could not be rolled back. Treat it as success so the
            // frontend never retries a file that has already moved.
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn path_c_string(path: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a null byte"))
}

#[cfg(target_os = "macos")]
fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    unsafe extern "C" {
        fn renameatx_np(
            from_fd: libc::c_int,
            from: *const libc::c_char,
            to_fd: libc::c_int,
            to: *const libc::c_char,
            flags: libc::c_uint,
        ) -> libc::c_int;
    }
    const RENAME_EXCL: libc::c_uint = 0x0000_0004;
    let source = path_c_string(source)?;
    let destination = path_c_string(destination)?;
    // SAFETY: both C strings are alive for the call and AT_FDCWD uses the absolute paths.
    let result = unsafe {
        renameatx_np(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let source = path_c_string(source)?;
    let destination = path_c_string(destination)?;
    // SAFETY: both C strings are alive for the call and AT_FDCWD uses the absolute paths.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are null-terminated and remain alive for the call. Flags 0 forbids replacement.
    let result = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::hard_link(source, destination)?;
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

fn publish_copy_without_replacement(
    source: &Path,
    destination: &Path,
) -> io::Result<PublishAttempt> {
    publish_copy_with_sync(source, destination, sync_directory)
}

fn publish_copy_with_sync<F>(
    source: &Path,
    destination: &Path,
    syncer: F,
) -> io::Result<PublishAttempt>
where
    F: Fn(&Path) -> io::Result<()> + Copy,
{
    let folder = destination.parent().unwrap_or_else(|| Path::new("."));
    let temp_path = folder.join(format!(
        ".cute-image-sorter-{}.tmp",
        Uuid::new_v4().simple()
    ));
    let temp = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)?;
    let copy_result = (|| {
        copy_preserving_metadata(source, &temp, &temp_path)?;
        temp.sync_all()?;
        verify_copy_metadata(source, &temp_path)?;
        match rename_no_replace(&temp_path, destination) {
            Ok(()) => {
                sync_rename_or_rollback(&temp_path, destination, &[folder], syncer)?;
                Ok(PublishAttempt::Published)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Ok(PublishAttempt::Collision)
            }
            Err(error) => Err(error),
        }
    })();
    drop(temp);
    let _ = fs::remove_file(&temp_path);
    copy_result
}

fn verify_identity_at_path(path: &Path, expected: &FileIdentity) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || &FileIdentity::from_metadata(&metadata) != expected {
        return Err(io::Error::other("the source changed during the move"));
    }
    Ok(())
}

fn stage_source(
    source: &Path,
    expected: &FileIdentity,
    destination: &Path,
) -> io::Result<StagedSource> {
    stage_source_with_sync(source, expected, destination, sync_directory)
}

fn stage_source_with_sync(
    source: &Path,
    expected: &FileIdentity,
    destination: &Path,
    syncer: impl Fn(&Path) -> io::Result<()>,
) -> io::Result<StagedSource> {
    let parent = source
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "source has no parent"))?;
    for _ in 0..16 {
        let recovery_id = Uuid::new_v4().simple().to_string();
        let staged = parent.join(format!(".cute-image-sorter-source-{recovery_id}.tmp",));
        let journal = parent.join(format!("{RECOVERY_PREFIX}{recovery_id}.bin"));
        let commit = journal.with_extension("commit");
        let record = RecoveryRecord {
            original: source.to_path_buf(),
            staged: staged.clone(),
            destination: destination.to_path_buf(),
            size: expected.size,
            modified_nanos: expected.modified_nanos,
        };
        let journal_bytes = recovery_record_bytes(&record).map_err(io::Error::other)?;
        let mut journal_file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&journal)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let prepare_result = journal_file
            .write_all(&journal_bytes)
            .and_then(|()| journal_file.sync_all())
            .and_then(|()| syncer(parent));
        drop(journal_file);
        if let Err(error) = prepare_result {
            let _ = remove_recovery_journal(&journal);
            return Err(error);
        }
        match rename_no_replace(source, &staged) {
            Ok(()) => {
                if verify_identity_at_path(&staged, expected).is_ok() {
                    if let Err(error) = sync_rename_or_rollback(source, &staged, &[parent], &syncer)
                    {
                        if source.exists() && !staged.exists() {
                            let _ = remove_recovery_journal(&journal);
                        }
                        return Err(error);
                    }
                    return Ok(StagedSource {
                        path: staged,
                        journal,
                        commit,
                    });
                }
                if rename_no_replace(&staged, source).is_ok() {
                    let _ = remove_recovery_journal(&journal);
                }
                return Err(io::Error::other(
                    "the source changed while it was being secured for copying",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let _ = remove_recovery_journal(&journal);
                continue;
            }
            Err(error) => {
                let _ = remove_recovery_journal(&journal);
                return Err(error);
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not reserve a temporary source name",
    ))
}

fn restore_staged_source(staged: &StagedSource, source: &Path) -> io::Result<()> {
    rename_no_replace(&staged.path, source)
        .and_then(|()| sync_directory(source.parent().unwrap_or_else(|| Path::new("."))))
        .and_then(|()| remove_recovery_journal(&staged.journal))
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!(
                    "the move failed and the original remains safely at {}: {error}",
                    staged.path.display()
                ),
            )
        })
}

fn published_destination_identity<F>(
    staged: &StagedSource,
    source: &Path,
    destination: &Path,
    read_metadata: F,
) -> io::Result<FileIdentity>
where
    F: FnOnce(&Path) -> io::Result<fs::Metadata>,
{
    match read_metadata(destination) {
        Ok(metadata) => Ok(FileIdentity::from_metadata(&metadata)),
        Err(error) => {
            let _ = fs::remove_file(destination);
            restore_staged_source(staged, source)?;
            Err(error)
        }
    }
}

fn prepare_destination_folder(
    folder: &Path,
    mark_output: bool,
    marker_key: &[u8; 32],
) -> Result<DirectoryRecord, String> {
    let existed = folder.exists();
    if path_has_link_component(folder)? {
        return Err(format!(
            "{} passes through a linked folder and cannot be used.",
            folder.display()
        ));
    }
    fs::create_dir_all(folder)
        .map_err(|error| format!("Could not create {}: {error}", folder.display()))?;
    if path_has_link_component(folder)? {
        return Err(format!(
            "{} passes through a linked folder and cannot be used.",
            folder.display()
        ));
    }
    let canonical = folder
        .canonicalize()
        .map_err(|error| format!("Could not inspect {}: {error}", folder.display()))?;
    let identity = FileIdentity::from_metadata(
        &fs::metadata(&canonical)
            .map_err(|error| format!("Could not inspect {}: {error}", canonical.display()))?,
    );
    if mark_output && !existed {
        let marker_path = canonical.join(OUTPUT_MARKER_NAME);
        let expected_contents = output_marker_contents(&canonical, marker_key);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker_path)
        {
            Ok(mut marker) => {
                marker
                    .write_all(&expected_contents)
                    .and_then(|()| marker.sync_all())
                    .map_err(|error| {
                        format!(
                            "Could not mark {} as an output: {error}",
                            canonical.display()
                        )
                    })?;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if fs::read(&marker_path).ok().as_deref() != Some(expected_contents.as_slice()) {
                    return Err(format!(
                        "{} already contains an unrelated file named {OUTPUT_MARKER_NAME}.",
                        canonical.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "Could not mark {} as an output: {error}",
                    canonical.display()
                ));
            }
        }
    }
    Ok(DirectoryRecord {
        path: canonical,
        identity: Some(identity),
    })
}

fn move_without_replacement(
    source: &Path,
    expected_source: &FileIdentity,
    folder: &DirectoryRecord,
) -> io::Result<PathBuf> {
    let folder_path = verify_directory_record(folder).map_err(io::Error::other)?;
    let file_name = source
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "source has no filename"))?;

    for index in 1.. {
        verify_identity_at_path(source, expected_source)?;
        let verified_folder = verify_directory_record(folder).map_err(io::Error::other)?;
        if verified_folder != folder_path {
            return Err(io::Error::other("the destination changed during the move"));
        }
        let destination = destination_candidate(&folder_path, file_name, index);
        match rename_no_replace(source, &destination) {
            Ok(()) => {
                if verify_identity_at_path(&destination, expected_source).is_err() {
                    let _ = rename_no_replace(&destination, source);
                    return Err(io::Error::other(
                        "the source changed during the atomic move",
                    ));
                }
                let source_parent = source.parent().unwrap_or_else(|| Path::new("."));
                if source_parent == folder_path {
                    sync_rename_or_rollback(source, &destination, &[&folder_path], sync_directory)?;
                } else {
                    sync_rename_or_rollback(
                        source,
                        &destination,
                        &[&folder_path, source_parent],
                        sync_directory,
                    )?;
                }
                return Ok(destination);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
                let staged = stage_source(source, expected_source, &destination)?;
                let publish_result = publish_copy_without_replacement(&staged.path, &destination);
                match publish_result {
                    Ok(PublishAttempt::Collision) => {
                        restore_staged_source(&staged, source)?;
                        continue;
                    }
                    Ok(PublishAttempt::Published) => {
                        let copied_identity = published_destination_identity(
                            &staged,
                            source,
                            &destination,
                            |path| fs::metadata(path),
                        )?;
                        if copied_identity.size != expected_source.size
                            || copied_identity.modified_nanos != expected_source.modified_nanos
                        {
                            let _ = fs::remove_file(&destination);
                            restore_staged_source(&staged, source)?;
                            return Err(io::Error::other(
                                "the copied file did not match the scanned source",
                            ));
                        }
                        if let Err(error) = verify_identity_at_path(&staged.path, expected_source) {
                            let _ = fs::remove_file(&destination);
                            restore_staged_source(&staged, source)?;
                            return Err(error);
                        }
                        if let Err(error) = mark_recovery_committed(&staged) {
                            let _ = fs::remove_file(&destination);
                            restore_staged_source(&staged, source)?;
                            return Err(error);
                        }
                        if let Err(error) = fs::remove_file(&staged.path) {
                            let _ = fs::remove_file(&destination);
                            restore_staged_source(&staged, source)?;
                            return Err(error);
                        }
                        let _ = remove_recovery_journal(&staged.journal);
                        // At this point the copy is published and the staged source is gone.
                        // A directory-sync failure is a durability warning, not a retryable move.
                        let _ =
                            sync_directory(staged.path.parent().unwrap_or_else(|| Path::new(".")));
                        return Ok(destination);
                    }
                    Err(error) => {
                        restore_staged_source(&staged, source)?;
                        return Err(error);
                    }
                }
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("an unused filename is always available")
}

fn destination_folder(
    source: &Path,
    target: &Path,
    keep_structure: bool,
) -> Result<PathBuf, String> {
    if !keep_structure {
        return Ok(target.to_path_buf());
    }
    let target_name = target
        .file_name()
        .ok_or_else(|| "The destination folder needs a name.".to_string())?;
    Ok(source
        .parent()
        .ok_or_else(|| "The source file has no parent folder.".to_string())?
        .join(target_name))
}

#[tauri::command]
async fn move_media(
    request: MoveRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<MoveResult, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _move_guard = state.move_lock.lock().map_err(|_| lock_error())?;
        let (record, target, keep_structure) = {
            let data = state.inner.lock().map_err(|_| lock_error())?;
            let session = data
                .session
                .as_ref()
                .filter(|session| session.id == request.session_id)
                .ok_or_else(|| "That sorting session is no longer active.".to_string())?;
            let record = session
                .files
                .get(&request.file_id)
                .ok_or_else(|| {
                    "That file was already moved or is no longer available.".to_string()
                })?
                .clone();
            let target = session
                .targets
                .get(&request.target_id)
                .ok_or_else(|| "That destination is not part of this session.".to_string())?
                .clone();
            (record, target, session.keep_structure)
        };

        let source = verify_file_record(&record)?;
        if !source.is_file() {
            return Err(format!("{} is no longer available.", source.display()));
        }
        let target_path = if keep_structure {
            target.path.clone()
        } else {
            verify_directory_record(&target)?
        };
        let folder = destination_folder(&source, &target_path, keep_structure)?;
        let folder_record = if keep_structure {
            prepare_destination_folder(&folder, true, &state.marker_key)?
        } else {
            target
        };
        let destination = move_without_replacement(&source, &record.identity, &folder_record)
            .map_err(|error| {
                format!(
                    "Could not move {} to {}: {error}",
                    source.display(),
                    folder.display()
                )
            })?;

        if let Ok(mut data) = state.inner.lock() {
            if keep_structure && let Ok(output) = folder.canonicalize() {
                data.generated_outputs.insert(output);
            }
            if let Some(session) = data
                .session
                .as_mut()
                .filter(|session| session.id == request.session_id)
            {
                session.files.remove(&request.file_id);
            }
        }
        Ok(MoveResult {
            file_id: request.file_id,
            destination_path: destination.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|error| format!("The file move stopped unexpectedly: {error}"))?
}

fn resolve_media_file(state: &AppState, request_path: &str) -> Option<(PathBuf, File)> {
    let mut parts = request_path.trim_start_matches('/').split('/');
    let session_id = parts.next()?.parse::<u64>().ok()?;
    let file_id = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let record = {
        let data = state.inner.lock().ok()?;
        let session = data
            .session
            .as_ref()
            .filter(|session| session.id == session_id)?;
        session.files.get(file_id)?.clone()
    };
    let path = verify_file_record(&record).ok()?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&path).ok()?;
    if FileIdentity::from_metadata(&file.metadata().ok()?) != record.identity {
        return None;
    }
    Some((path, file))
}

fn http_header(name: &str, value: impl AsRef<[u8]>) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_ref()).expect("valid media response header")
}

fn respond_empty(request: Request, status: u16) {
    let response = Response::empty(StatusCode(status))
        .with_header(http_header("Access-Control-Allow-Origin", "*"));
    let _ = request.respond(response);
}

fn handle_media_request(state: &AppState, token: &str, request: Request) {
    if !matches!(request.method(), Method::Get | Method::Head) {
        respond_empty(request, 405);
        return;
    }
    let request_path = request.url().split('?').next().unwrap_or(request.url());
    let mut parts = request_path.trim_start_matches('/').splitn(2, '/');
    if parts.next() != Some(token) {
        respond_empty(request, 404);
        return;
    }
    let Some((path, mut file)) = parts
        .next()
        .and_then(|path| resolve_media_file(state, path))
    else {
        respond_empty(request, 404);
        return;
    };
    let Ok(metadata) = file.metadata() else {
        respond_empty(request, 500);
        return;
    };
    let length = metadata.len();
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let base_headers = || {
        vec![
            http_header("Access-Control-Allow-Origin", "*"),
            http_header("Content-Type", mime.as_ref()),
            http_header("Accept-Ranges", "bytes"),
        ]
    };

    if request.method() == &Method::Head {
        let response = Response::empty(StatusCode(200))
            .with_header(http_header("Access-Control-Allow-Origin", "*"))
            .with_header(http_header("Content-Type", mime.as_ref()))
            .with_header(http_header("Accept-Ranges", "bytes"))
            .with_header(http_header("Content-Length", length.to_string()));
        let _ = request.respond(response);
        return;
    }

    let range_header = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"))
        .map(|header| header.value.as_str().to_string());
    if let Some(range_header) = range_header {
        let Ok(ranges) = HttpRange::parse(&range_header, length) else {
            let response = Response::empty(StatusCode(416))
                .with_header(http_header("Content-Range", format!("bytes */{length}")))
                .with_header(http_header("Access-Control-Allow-Origin", "*"));
            let _ = request.respond(response);
            return;
        };
        let Some(range) = ranges.first() else {
            respond_empty(request, 416);
            return;
        };
        let start = range.start;
        let requested_end = start.saturating_add(range.length).saturating_sub(1);
        let end = requested_end.min(length.saturating_sub(1));
        if start >= length || end < start || file.seek(SeekFrom::Start(start)).is_err() {
            respond_empty(request, 416);
            return;
        }
        let bytes_to_read = end + 1 - start;
        let Ok(data_length) = usize::try_from(bytes_to_read) else {
            respond_empty(request, 416);
            return;
        };
        let mut headers = base_headers();
        headers.push(http_header(
            "Content-Range",
            format!("bytes {start}-{end}/{length}"),
        ));
        let response = Response::new(
            StatusCode(206),
            headers,
            file.take(bytes_to_read),
            Some(data_length),
            None,
        );
        let _ = request.respond(response);
        return;
    }

    let response = Response::from_file(file)
        .with_header(http_header("Access-Control-Allow-Origin", "*"))
        .with_header(http_header("Content-Type", mime.as_ref()))
        .with_header(http_header("Accept-Ranges", "bytes"));
    let _ = request.respond(response);
}

fn start_media_server() -> Result<(Arc<Server>, String, String), String> {
    let server = Arc::new(
        Server::http("127.0.0.1:0")
            .map_err(|error| format!("Could not start the private media server: {error}"))?,
    );
    let address = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "The private media server did not get a TCP address.".to_string())?;
    let token = Uuid::new_v4().simple().to_string();
    let base = format!("http://127.0.0.1:{}/{token}", address.port());
    Ok((server, token, base))
}

fn run_media_workers(server: Arc<Server>, token: String, state: Arc<AppState>) {
    for _ in 0..4 {
        let server = Arc::clone(&server);
        let state = Arc::clone(&state);
        let token = token.clone();
        std::thread::spawn(move || {
            while let Ok(request) = server.recv() {
                handle_media_request(&state, &token, request);
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (server, token, media_base) =
        start_media_server().expect("Could not start CuteImageSorter’s private media server");
    let marker_key =
        load_or_create_marker_key().expect("Could not load CuteImageSorter’s output marker key");
    let state = Arc::new(AppState::new(media_base, marker_key));
    run_media_workers(server, token, Arc::clone(&state));
    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position: _ }) =
                event
            else {
                return;
            };
            if paths.is_empty() {
                return;
            }
            let token = Uuid::new_v4().simple().to_string();
            let state = window.state::<Arc<AppState>>();
            let Ok(mut data) = state.inner.lock() else {
                return;
            };
            data.pending_source_drop = Some((token.clone(), paths.clone()));
            drop(data);
            let _ = window.emit("native-source-drop", NativeSourceDrop { token });
        })
        .invoke_handler(tauri::generate_handler![
            collage::collage_pick,
            collage::collage_drop,
            collage::collage_clipboard,
            collage::collage_save,
            choose_source,
            accept_source_drop,
            choose_destination,
            scan_media,
            move_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running CuteImageSorter");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    const TEST_MARKER_KEY: [u8; 32] = [0x5a; 32];

    fn sandbox(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "cute-image-sorter-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).expect("create test sandbox");
        path.canonicalize().expect("canonical test sandbox")
    }

    fn collect_test_media(
        root: &Path,
        excluded: &HashSet<PathBuf>,
        files: &mut Vec<CollectedFile>,
        warnings: &mut Vec<String>,
    ) -> Result<(), String> {
        let context = ScanContext {
            root,
            media_base: "http://127.0.0.1:1/test",
            session_id: 1,
            recursive: true,
            excluded,
            marker_key: &TEST_MARKER_KEY,
        };
        collect_media(root, &context, files, warnings)
    }

    #[test]
    fn classifies_common_media_extensions_case_insensitively() {
        assert!(matches!(
            classify(Path::new("kitten.JPEG")),
            Some((MediaKind::Image, _))
        ));
        assert!(matches!(
            classify(Path::new("clip.MKV")),
            Some((MediaKind::Video, _))
        ));
        assert!(matches!(
            classify(Path::new("purr.FLAC")),
            Some((MediaKind::Audio, _))
        ));
        assert!(matches!(
            classify(Path::new("book.m4b")),
            Some((MediaKind::Audio, _))
        ));
        assert!(matches!(
            classify(Path::new("camera.DNG")),
            Some((MediaKind::Image, _))
        ));
        assert!(matches!(
            classify(Path::new("soundtrack.mka")),
            Some((MediaKind::Audio, _))
        ));
        assert!(matches!(
            classify(Path::new("legacy.asf")),
            Some((MediaKind::Video, _))
        ));
        assert!(classify(Path::new("notes.txt")).is_none());
    }

    #[test]
    fn dropped_folders_and_media_files_are_approved_together() {
        let root = sandbox("mixed-source-drop");
        let album = root.join("album");
        fs::create_dir_all(&album).expect("create album");
        let song = root.join("song.mp3");
        let note = root.join("notes.txt");
        fs::write(&song, b"song").expect("write song");
        fs::write(&note, b"not media").expect("write note");

        let (sources, result) =
            approve_source_paths(vec![album.clone(), song.clone(), note, song.clone()])
                .expect("approve mixed drop");

        assert_eq!(sources.entries.len(), 2);
        assert_eq!(sources.base, album.canonicalize().expect("canonical album"));
        assert_eq!(result.item_count, 2);
        assert_eq!(result.folder_count, 1);
        assert_eq!(result.file_count, 1);
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn individually_selected_media_file_is_collected_under_its_parent() {
        let root = sandbox("selected-media-file");
        let media = root.join("chosen.wav");
        fs::write(&media, b"audio").expect("write media");
        let excluded = HashSet::new();
        let context = ScanContext {
            root: &root,
            media_base: "http://127.0.0.1:1/test",
            session_id: 1,
            recursive: false,
            excluded: &excluded,
            marker_key: &TEST_MARKER_KEY,
        };
        let mut files = Vec::new();
        collect_media_file(
            media.clone(),
            fs::metadata(&media).expect("media metadata"),
            &context,
            &mut files,
        );

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].dto.relative_path, "chosen.wav");
        assert_eq!(files[0].record.source_root, root);
        fs::remove_dir_all(files[0].record.source_root.clone()).expect("remove sandbox");
    }

    #[test]
    fn every_selected_source_folder_is_rejected_as_a_destination() {
        let root = sandbox("multiple-source-target");
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&first).expect("create first source");
        fs::create_dir_all(&second).expect("create second source");
        let first = first.canonicalize().expect("canonical first");
        let second = second.canonicalize().expect("canonical second");

        let result = validate_targets(
            &first,
            &[first.clone(), second.clone()],
            vec![TargetInput {
                id: "target".into(),
                path: Some(second.to_string_lossy().into_owned()),
                selection_id: None,
                auto_name: None,
            }],
            false,
            &HashMap::new(),
        );

        assert!(result.is_err());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn selected_file_parent_is_rejected_as_a_destination() {
        let root = sandbox("selected-file-parent-target");
        let media = root.join("photo.jpg");
        fs::write(&media, b"photo").expect("write media");

        let result = validate_targets(
            &root,
            std::slice::from_ref(&root),
            vec![TargetInput {
                id: "target".into(),
                path: Some(root.to_string_lossy().into_owned()),
                selection_id: None,
                auto_name: None,
            }],
            false,
            &HashMap::new(),
        );

        assert!(result.is_err());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn concurrent_same_name_moves_never_overwrite() {
        let root = sandbox("concurrent");
        let left = root.join("left");
        let right = root.join("right");
        let target = root.join("target");
        fs::create_dir_all(&left).expect("create left");
        fs::create_dir_all(&right).expect("create right");
        let left_file = left.join("photo.jpg");
        let right_file = right.join("photo.jpg");
        fs::write(&left_file, b"left").expect("write left");
        fs::write(&right_file, b"right").expect("write right");
        fs::create_dir_all(&target).expect("create target");
        let target_record =
            prepare_destination_folder(&target, false, &TEST_MARKER_KEY).expect("prepare target");

        let barrier = Arc::new(Barrier::new(3));
        let handles = [left_file, right_file].map(|source| {
            let barrier = Arc::clone(&barrier);
            let target = target_record.clone();
            std::thread::spawn(move || {
                let identity =
                    FileIdentity::from_metadata(&fs::metadata(&source).expect("source metadata"));
                barrier.wait();
                move_without_replacement(&source, &identity, &target)
                    .expect("move without overwrite")
            })
        });
        barrier.wait();
        let destinations = handles.map(|handle| handle.join().expect("join move"));

        assert_ne!(destinations[0], destinations[1]);
        let mut contents = destinations
            .iter()
            .map(|path| fs::read(path).expect("read destination"))
            .collect::<Vec<_>>();
        contents.sort();
        assert_eq!(contents, vec![b"left".to_vec(), b"right".to_vec()]);
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn keep_structure_places_destination_beside_each_file() {
        let source = Path::new("/media/something/images/photo.png");
        let target = Path::new("/media/A");
        assert_eq!(
            destination_folder(source, target, true).expect("destination folder"),
            Path::new("/media/something/images/A")
        );
    }

    #[test]
    fn canonical_target_aliases_are_rejected() {
        let root = sandbox("aliases");
        let source = root.canonicalize().expect("canonical source");
        let first = root.join("first");
        fs::create_dir_all(&first).expect("create target");
        let alias = first.join("..").join("first");
        let result = validate_targets(
            &source,
            std::slice::from_ref(&source),
            vec![
                TargetInput {
                    id: "a".into(),
                    path: Some(first.to_string_lossy().into_owned()),
                    selection_id: None,
                    auto_name: None,
                },
                TargetInput {
                    id: "b".into(),
                    path: Some(alias.to_string_lossy().into_owned()),
                    selection_id: None,
                    auto_name: None,
                },
            ],
            false,
            &HashMap::new(),
        );
        assert!(result.is_err());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn recursive_scan_excludes_destination_folders() {
        let root = sandbox("exclude");
        let target = root.join("Favorites");
        fs::create_dir_all(&target).expect("create target");
        fs::write(root.join("keep.jpg"), b"keep").expect("write source");
        fs::write(target.join("skip.jpg"), b"skip").expect("write excluded");
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        collect_test_media(
            &root,
            &HashSet::from([target.canonicalize().expect("canonical target")]),
            &mut files,
            &mut warnings,
        )
        .expect("scan media");
        assert!(warnings.is_empty());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].dto.name, "keep.jpg");
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn destination_ancestor_does_not_exclude_source_children() {
        let root = sandbox("ancestor-target");
        let source = root.join("unsorted");
        let nested = source.join("album");
        fs::create_dir_all(&nested).expect("create source tree");
        fs::write(nested.join("photo.jpg"), b"photo").expect("write nested media");
        let source = source.canonicalize().expect("canonical source");
        let target = root.canonicalize().expect("canonical ancestor");
        let targets = HashMap::from([(
            "archive".to_string(),
            DirectoryRecord {
                identity: Some(FileIdentity::from_metadata(
                    &fs::metadata(&target).expect("target metadata"),
                )),
                path: target,
            },
        )]);
        let excluded = scan_exclusions(std::slice::from_ref(&source), &targets, HashSet::new());
        assert!(excluded.is_empty());
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        collect_test_media(&source, &excluded, &mut files, &mut warnings).expect("scan source");
        assert!(warnings.is_empty());
        assert_eq!(files.len(), 1);
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[cfg(unix)]
    #[test]
    fn linked_destination_is_rejected() {
        use std::os::unix::fs::symlink;

        let root = sandbox("linked-destination");
        let source = root.join("source");
        let outside = root.join("outside");
        fs::create_dir_all(&source).expect("create source");
        fs::create_dir_all(&outside).expect("create outside");
        let linked = root.join("linked");
        symlink(&outside, &linked).expect("create destination symlink");
        let result = validate_targets(
            &source.canonicalize().expect("canonical source"),
            &[source.canonicalize().expect("canonical source")],
            vec![TargetInput {
                id: "linked".into(),
                path: Some(linked.to_string_lossy().into_owned()),
                selection_id: None,
                auto_name: None,
            }],
            false,
            &HashMap::new(),
        );
        assert!(result.is_err());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn durable_output_marker_prevents_rescanning_after_restart() {
        let root = sandbox("output-marker");
        let output = root.join("trip").join("Favorites");
        let record = prepare_destination_folder(&output, true, &TEST_MARKER_KEY)
            .expect("prepare marked output");
        fs::write(record.path.join("sorted.jpg"), b"sorted").expect("write sorted media");
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        collect_test_media(&root, &HashSet::new(), &mut files, &mut warnings).expect("scan source");
        assert!(warnings.is_empty());
        assert!(files.is_empty());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn unrelated_marker_name_does_not_hide_media() {
        let root = sandbox("unrelated-marker");
        let folder = root.join("album");
        fs::create_dir_all(&folder).expect("create album");
        fs::write(folder.join(OUTPUT_MARKER_NAME), b"not a sorter marker")
            .expect("write unrelated marker");
        fs::write(folder.join("visible.jpg"), b"visible").expect("write visible media");
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        collect_test_media(&root, &HashSet::new(), &mut files, &mut warnings).expect("scan source");
        assert!(warnings.is_empty());
        assert_eq!(files.len(), 1);
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn copied_valid_marker_does_not_hide_a_different_folder() {
        let root = sandbox("copied-marker");
        let original = root.join("original");
        let copied = root.join("copied");
        prepare_destination_folder(&original, true, &TEST_MARKER_KEY)
            .expect("prepare signed output");
        fs::create_dir_all(&copied).expect("create copied folder");
        fs::copy(
            original.join(OUTPUT_MARKER_NAME),
            copied.join(OUTPUT_MARKER_NAME),
        )
        .expect("copy marker");
        fs::write(copied.join("visible.jpg"), b"visible").expect("write visible media");
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        collect_test_media(&root, &HashSet::new(), &mut files, &mut warnings).expect("scan source");
        assert!(warnings.is_empty());
        assert_eq!(files.len(), 1);
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn copied_file_publishes_without_hard_links_or_overwrite() {
        let root = sandbox("publish-copy");
        let source = root.join("source.jpg");
        let destination = root.join("destination.jpg");
        fs::write(&source, b"first").expect("write source");
        assert!(matches!(
            publish_copy_without_replacement(&source, &destination).expect("publish copy"),
            PublishAttempt::Published
        ));
        assert_eq!(fs::read(&destination).expect("read destination"), b"first");
        fs::write(&source, b"second").expect("replace source bytes");
        assert!(matches!(
            publish_copy_without_replacement(&source, &destination)
                .expect("detect destination collision"),
            PublishAttempt::Collision
        ));
        assert_eq!(fs::read(&destination).expect("read destination"), b"first");
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn failed_staging_sync_restores_original_for_retry() {
        let root = sandbox("staging-sync-failure");
        let source = root.join("source.jpg");
        fs::write(&source, b"safe").unwrap();
        let identity = FileIdentity::from_metadata(&fs::metadata(&source).unwrap());
        let calls = std::cell::Cell::new(0);
        let result = stage_source_with_sync(&source, &identity, &root.join("dest.jpg"), |_| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                Err(io::Error::other("injected sync failure"))
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&source).unwrap(), b"safe");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_recovery_looking_file_is_preserved_without_unbounded_reads() {
        let root = sandbox("oversized-journal");
        let journal = root.join(format!("{RECOVERY_PREFIX}{}.bin", Uuid::new_v4().simple()));
        File::create(&journal)
            .unwrap()
            .set_len(1024 * 1024 * 1024)
            .unwrap();
        let mut warnings = Vec::new();
        recover_staged_moves(&root, &mut warnings);
        assert_eq!(warnings.len(), 1);
        assert_eq!(fs::metadata(&journal).unwrap().len(), 1024 * 1024 * 1024);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_failure_rolls_back_same_device_rename() {
        let root = sandbox("sync-rollback-rename");
        let source = root.join("source.jpg");
        let destination = root.join("destination.jpg");
        fs::write(&source, b"safe").expect("write source");
        rename_no_replace(&source, &destination).expect("perform atomic rename");
        let result = sync_rename_or_rollback(&source, &destination, &[&root], |_| {
            Err(io::Error::other("injected sync failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&source).expect("source restored"), b"safe");
        assert!(!destination.exists());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn sync_failure_rolls_back_published_copy() {
        let root = sandbox("sync-rollback-copy");
        let source = root.join("source.jpg");
        let destination = root.join("destination.jpg");
        fs::write(&source, b"safe").expect("write source");
        let result = publish_copy_with_sync(&source, &destination, |_| {
            Err(io::Error::other("injected sync failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&source).expect("source remains"), b"safe");
        assert!(!destination.exists());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn metadata_failure_after_publish_restores_original() {
        let root = sandbox("metadata-failure-after-publish");
        let source = root.join("source.jpg");
        let destination = root.join("destination.jpg");
        fs::write(&source, b"safe").expect("write source");
        let identity =
            FileIdentity::from_metadata(&fs::metadata(&source).expect("source metadata"));
        let staged = stage_source(&source, &identity, &destination).expect("stage source");
        assert!(matches!(
            publish_copy_without_replacement(&staged.path, &destination)
                .expect("publish destination"),
            PublishAttempt::Published
        ));

        let result = published_destination_identity(&staged, &source, &destination, |_| {
            Err(io::Error::other("injected metadata failure"))
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&source).expect("source restored"), b"safe");
        assert!(!destination.exists());
        assert!(!staged.path.exists());
        assert!(!staged.journal.exists());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn empty_recovery_journal_without_staged_file_is_discarded() {
        let root = sandbox("empty-recovery-journal");
        let recovery_id = Uuid::new_v4().simple().to_string();
        let journal = root.join(format!("{RECOVERY_PREFIX}{recovery_id}.bin"));
        fs::write(&journal, []).expect("write empty journal");

        let mut warnings = Vec::new();
        recover_staged_moves(&root, &mut warnings);

        assert!(warnings.is_empty());
        assert!(!journal.exists());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn truncated_recovery_journal_without_staged_file_is_discarded() {
        let root = sandbox("truncated-recovery-journal");
        let recovery_id = Uuid::new_v4().simple().to_string();
        let journal = root.join(format!("{RECOVERY_PREFIX}{recovery_id}.bin"));
        fs::write(&journal, &RECOVERY_MAGIC[..RECOVERY_MAGIC.len() - 1])
            .expect("write truncated journal");

        let mut warnings = Vec::new();
        recover_staged_moves(&root, &mut warnings);

        assert!(warnings.is_empty());
        assert!(!journal.exists());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn interrupted_cross_volume_stage_restores_original_on_scan() {
        let root = sandbox("recover-staged-source");
        let source = root.join("photo.jpg");
        let destination = root.join("destination.jpg");
        fs::write(&source, b"recover me").expect("write source");
        let identity =
            FileIdentity::from_metadata(&fs::metadata(&source).expect("source metadata"));
        let staged = stage_source(&source, &identity, &destination).expect("stage source");
        assert!(!source.exists());
        assert!(staged.path.exists());

        let mut warnings = Vec::new();
        recover_staged_moves(&root, &mut warnings);
        assert!(warnings.is_empty());
        assert_eq!(fs::read(&source).expect("restored source"), b"recover me");
        assert!(!staged.path.exists());
        assert!(!staged.journal.exists());
        assert!(!staged.commit.exists());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn interrupted_committed_copy_is_finalized_on_scan() {
        let root = sandbox("recover-published-copy");
        let source = root.join("photo.jpg");
        let destination = root.join("destination.jpg");
        fs::write(&source, b"already copied").expect("write source");
        let identity =
            FileIdentity::from_metadata(&fs::metadata(&source).expect("source metadata"));
        let staged = stage_source(&source, &identity, &destination).expect("stage source");
        assert!(matches!(
            publish_copy_without_replacement(&staged.path, &destination)
                .expect("publish destination"),
            PublishAttempt::Published
        ));
        mark_recovery_committed(&staged).expect("mark committed copy");

        let mut warnings = Vec::new();
        recover_staged_moves(&root, &mut warnings);
        assert!(warnings.is_empty());
        assert!(!source.exists());
        assert!(!staged.path.exists());
        assert!(!staged.journal.exists());
        assert!(!staged.commit.exists());
        assert_eq!(
            fs::read(&destination).expect("published destination"),
            b"already copied"
        );
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn uncommitted_matching_destination_restores_original() {
        let root = sandbox("recover-uncommitted-matching-destination");
        let source = root.join("photo.jpg");
        let destination = root.join("destination.jpg");
        fs::write(&source, b"same bytes").expect("write source");
        fs::write(&destination, b"same bytes").expect("write destination");
        let source_metadata = fs::metadata(&source).expect("source metadata");
        filetime::set_file_mtime(
            &destination,
            FileTime::from_last_modification_time(&source_metadata),
        )
        .expect("match destination modification time");
        let identity = FileIdentity::from_metadata(&source_metadata);
        let staged = stage_source(&source, &identity, &destination).expect("stage source");

        let mut warnings = Vec::new();
        recover_staged_moves(&root, &mut warnings);

        assert!(warnings.is_empty());
        assert_eq!(fs::read(&source).expect("restored source"), b"same bytes");
        assert_eq!(
            fs::read(&destination).expect("pre-existing destination"),
            b"same bytes"
        );
        assert!(!staged.path.exists());
        assert!(!staged.journal.exists());
        assert!(!staged.commit.exists());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn half_cleaned_committed_recovery_does_not_persist() {
        let root = sandbox("recover-half-cleaned-commit");
        let source = root.join("photo.jpg");
        let destination = root.join("destination.jpg");
        fs::write(&source, b"already copied").expect("write source");
        let identity =
            FileIdentity::from_metadata(&fs::metadata(&source).expect("source metadata"));
        let staged = stage_source(&source, &identity, &destination).expect("stage source");
        assert!(matches!(
            publish_copy_without_replacement(&staged.path, &destination)
                .expect("publish destination"),
            PublishAttempt::Published
        ));
        mark_recovery_committed(&staged).expect("mark committed copy");
        fs::remove_file(&staged.path).expect("remove staged source");
        fs::remove_file(&staged.commit).expect("simulate interrupted old cleanup");

        let mut warnings = Vec::new();
        recover_staged_moves(&root, &mut warnings);

        assert!(warnings.is_empty());
        assert!(!source.exists());
        assert!(!staged.journal.exists());
        assert!(!staged.commit.exists());
        assert_eq!(
            fs::read(&destination).expect("published destination"),
            b"already copied"
        );
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn private_media_server_streams_full_and_range_responses() {
        use std::{
            io::{Read as _, Write as _},
            net::TcpStream,
        };

        let root = sandbox("protocol")
            .canonicalize()
            .expect("canonical protocol sandbox");
        let media = root.join("song.mp3");
        fs::write(&media, b"0123456789").expect("write media");
        OpenOptions::new()
            .write(true)
            .open(&media)
            .expect("open media")
            .set_len(2 * 1024 * 1024)
            .expect("extend media");
        let server = Arc::new(Server::http("127.0.0.1:0").expect("start test server"));
        let address = server.server_addr().to_ip().expect("test TCP address");
        let state = Arc::new(AppState::new(
            format!("http://127.0.0.1:{}/test-token", address.port()),
            TEST_MARKER_KEY,
        ));
        *state.inner.lock().expect("lock state") = StateData {
            approved_sources: Some(ApprovedSources {
                base: root.clone(),
                entries: vec![SourceEntry {
                    path: root.clone(),
                    is_directory: true,
                }],
            }),
            pending_source_drop: None,
            approved_destinations: HashMap::new(),
            generated_outputs: HashSet::new(),
            next_session_id: 7,
            session: Some(Session {
                id: 7,
                targets: HashMap::new(),
                keep_structure: false,
                files: HashMap::from([(
                    "opaque-id".into(),
                    FileRecord {
                        identity: FileIdentity::from_metadata(
                            &fs::metadata(&media).expect("media metadata"),
                        ),
                        path: media,
                        source_root: root.clone(),
                    },
                )]),
            }),
        };
        let worker_server = Arc::clone(&server);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            for _ in 0..3 {
                let request = worker_server.recv().expect("receive request");
                handle_media_request(&worker_state, "test-token", request);
            }
        });
        let request = |path: &str, range: Option<&str>| {
            let mut stream = TcpStream::connect(address).expect("connect to media server");
            write!(
                stream,
                "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n{}\r\n",
                range.map_or(String::new(), |value| format!("Range: {value}\r\n"))
            )
            .expect("write request");
            let mut response = Vec::new();
            stream.read_to_end(&mut response).expect("read response");
            response
        };
        let ranged = request("/test-token/7/opaque-id", Some("bytes=2-5"));
        assert!(
            ranged
                .windows(b" 206 ".len())
                .any(|bytes| bytes == b" 206 "),
            "unexpected range response: {}",
            String::from_utf8_lossy(&ranged[..ranged.len().min(200)])
        );
        assert!(ranged.windows(4).any(|bytes| bytes == b"2345"));
        let full = request("/test-token/7/opaque-id", None);
        assert!(full.windows(5).any(|bytes| bytes == b" 200 "));
        assert!(full.len() > 2 * 1024 * 1024);
        let unknown = request("/test-token/7/not-approved", None);
        assert!(unknown.windows(5).any(|bytes| bytes == b" 404 "));
        worker.join().expect("join media worker");
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[test]
    fn forced_copy_path_preserves_core_metadata() {
        let root = sandbox("metadata");
        let source = root.join("source.mp3");
        let destination = root.join("destination.tmp");
        fs::write(&source, b"metadata matters").expect("write source");
        filetime::set_file_mtime(
            &source,
            FileTime::from_unix_time(1_700_000_000, 123_000_000),
        )
        .expect("set source time");
        let mut permissions = fs::metadata(&source)
            .expect("source metadata")
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&source, permissions).expect("set source permissions");
        let destination_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .expect("create destination");

        copy_preserving_metadata(&source, &destination_file, &destination)
            .expect("metadata-preserving copy");
        destination_file.sync_all().expect("sync destination");
        verify_copy_metadata(&source, &destination).expect("verify copied metadata");
        assert_eq!(
            fs::read(&source).expect("read source"),
            fs::read(&destination).expect("read destination")
        );
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[cfg(unix)]
    #[test]
    fn swapped_parent_symlink_is_rejected_before_move() {
        use std::os::unix::fs::symlink;

        let root = sandbox("symlink-swap")
            .canonicalize()
            .expect("canonical sandbox");
        let album = root.join("album");
        let old_album = root.join("old-album");
        let outside = sandbox("outside");
        fs::create_dir_all(&album).expect("create album");
        let scanned_path = album.join("photo.jpg");
        fs::write(&scanned_path, b"approved").expect("write approved file");
        let record = FileRecord {
            identity: FileIdentity::from_metadata(
                &fs::metadata(&scanned_path).expect("scanned metadata"),
            ),
            path: scanned_path,
            source_root: root.clone(),
        };
        fs::rename(&album, &old_album).expect("move original album");
        fs::write(outside.join("photo.jpg"), b"outside").expect("write outside file");
        symlink(&outside, &album).expect("replace album with symlink");

        assert!(verify_file_record(&record).is_err());
        assert_eq!(
            fs::read(outside.join("photo.jpg")).expect("read outside"),
            b"outside"
        );
        fs::remove_dir_all(root).expect("remove sandbox");
        fs::remove_dir_all(outside).expect("remove outside sandbox");
    }

    #[test]
    fn preexisting_folder_with_target_name_is_still_scanned() {
        let root = sandbox("same-name");
        let legitimate = root.join("trip").join("Favorites");
        fs::create_dir_all(&legitimate).expect("create legitimate folder");
        fs::write(legitimate.join("unsorted.jpg"), b"unsorted").expect("write media");
        prepare_destination_folder(&legitimate, true, &TEST_MARKER_KEY)
            .expect("prepare preexisting destination");
        assert!(!legitimate.join(OUTPUT_MARKER_NAME).exists());
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        collect_test_media(&root, &HashSet::new(), &mut files, &mut warnings).expect("scan media");
        assert!(warnings.is_empty());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].dto.name, "unsorted.jpg");
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_nested_directory_is_reported() {
        use std::os::unix::fs::PermissionsExt;

        let root = sandbox("unreadable");
        let blocked = root.join("blocked");
        fs::create_dir_all(&blocked).expect("create blocked folder");
        fs::write(blocked.join("hidden.jpg"), b"hidden").expect("write hidden media");
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000))
            .expect("block directory reads");
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        collect_test_media(&root, &HashSet::new(), &mut files, &mut warnings)
            .expect("scan readable root");
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700))
            .expect("restore directory permissions");
        assert!(!warnings.is_empty());
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn backend_owned_paths_preserve_non_utf8_components() {
        use std::os::unix::ffi::OsStringExt;

        let root = sandbox("non-utf8")
            .canonicalize()
            .expect("canonical sandbox");
        let selected = root.join(OsString::from_vec(vec![b'd', b'e', b's', b't', 0xff]));
        fs::create_dir_all(&selected).expect("create non-utf8 destination");
        let targets = validate_targets(
            &root,
            std::slice::from_ref(&root),
            vec![TargetInput {
                id: "chosen".into(),
                path: None,
                selection_id: Some("opaque-selection".into()),
                auto_name: None,
            }],
            false,
            &HashMap::from([("opaque-selection".into(), selected.clone())]),
        )
        .expect("validate backend-owned target");
        assert_eq!(
            targets.get("chosen").map(|record| &record.path),
            Some(&selected)
        );
        fs::remove_dir_all(root).expect("remove sandbox");
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn keep_structure_rejects_case_colliding_folder_names() {
        let root = sandbox("case-collision")
            .canonicalize()
            .expect("canonical sandbox");
        let result = validate_targets(
            &root,
            std::slice::from_ref(&root),
            vec![
                TargetInput {
                    id: "upper".into(),
                    path: None,
                    selection_id: None,
                    auto_name: Some("A".into()),
                },
                TargetInput {
                    id: "lower".into(),
                    path: None,
                    selection_id: None,
                    auto_name: Some("a".into()),
                },
            ],
            true,
            &HashMap::new(),
        );
        assert!(result.is_err());
        fs::remove_dir_all(root).expect("remove sandbox");
    }
}
