//! The clipboard, for the things a PTY cannot take as bytes.
//!
//! A terminal cannot take a picture, but an agent understands a path: a bitmap
//! is written to a temp PNG and its path is pasted. Files copied in the file
//! manager are pasted as their own paths. Text needs nothing here.

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// The prefix every pasted image is written under, so old ones can be found again.
const PASTE_PREFIX: &str = "assay-paste-";
/// A pasted image is a scratch file: it is worth a day, not a disk.
const KEEP_FOR: Duration = Duration::from_secs(24 * 60 * 60);
/// 8192 x 4096. Past this the clipboard is not a screenshot.
const MAX_PIXELS: u64 = 33_554_432;

/// Two images pasted in the same millisecond still get two files.
static SEQ: AtomicU32 = AtomicU32::new(0);

/// The paths on the clipboard, when a file manager put them there.
///
/// Only Windows has a file list format (`CF_HDROP`); elsewhere this is empty.
#[tauri::command]
pub async fn clipboard_files() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        use clipboard_win::{formats, get_clipboard};
        Ok(get_clipboard(formats::FileList).unwrap_or_default())
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// The clipboard's image as a PNG on disk, or `None` when it holds no image.
///
/// The bytes never enter the webview: a 4K screenshot is 33 MB of RGBA.
#[tauri::command]
pub async fn clipboard_image_to_temp_file<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let (rgba, width, height) = match app.clipboard().read_image() {
        // `Image` borrows the clipboard's own buffer; the copy ends that
        Ok(image) => (image.rgba().to_vec(), image.width(), image.height()),
        // no image on the clipboard is the ordinary case, not a failure
        Err(_) => return Ok(None),
    };
    if width == 0 || height == 0 {
        return Ok(None);
    }
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("The copied image is too large to paste".into());
    }

    let png = encode_png(&rgba, width, height)?;
    let path = temp_path();
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(&png).map_err(|e| e.to_string())?;

    prune_old_pastes();
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

fn temp_path() -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{PASTE_PREFIX}{millis}-{seq}.png"))
}

/// Delete pastes older than a day. Best effort: the paste itself already worked.
fn prune_old_pastes() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(PASTE_PREFIX) || !name.ends_with(".png") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| now.duration_since(t).unwrap_or_default() > KEEP_FOR)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
