//! Reading just enough of an agent transcript to recognise it.
//!
//! Claude Code transcripts (JSONL) run to megabytes, so they are streamed here
//! and only a summary crosses into the webview. Nothing is stored.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

/// Past this, a transcript is listed but not read.
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const PREVIEW_CHARS: usize = 240;

#[derive(Clone, Serialize)]
pub struct SessionSummary {
    id: String,
    /// Epoch millis of the last write.
    modified: u64,
    bytes: u64,
    /// The first thing the user asked, which is what the session is about.
    title: String,
    /// "user" | "assistant" | "" when the file had nothing readable.
    last_role: String,
    last_text: String,
    /// User and assistant turns; tool traffic is not counted.
    messages: u32,
}

/// Text out of a message body, which is either a string or a content array.
fn text_of(message: &Value) -> String {
    match &message["content"] {
        Value::String(s) => s.trim().to_string(),
        Value::Array(parts) => {
            let mut out = String::new();
            for part in parts {
                if part["type"] == "text" {
                    if let Some(t) = part["text"].as_str() {
                        if !out.is_empty() {
                            out.push(' ');
                        }
                        out.push_str(t.trim());
                    }
                }
            }
            out.trim().to_string()
        }
        _ => String::new(),
    }
}

fn shorten(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= PREVIEW_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(PREVIEW_CHARS - 1).collect();
    format!("{cut}…")
}

/// The lines Claude Code writes for its own bookkeeping, not for a person.
fn is_noise(text: &str) -> bool {
    text.is_empty()
        || text.starts_with("<command-")
        || text.starts_with("<local-command")
        || text.starts_with("Caveat:")
        || text.starts_with("<system-reminder")
}

fn summarise(path: &Path, id: String, modified: u64, bytes: u64) -> SessionSummary {
    let mut summary = SessionSummary {
        id,
        modified,
        bytes,
        title: String::new(),
        last_role: String::new(),
        last_text: String::new(),
        messages: 0,
    };
    if bytes > MAX_SCAN_BYTES {
        return summary;
    }
    let Ok(file) = File::open(path) else {
        return summary;
    };

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let role = match event["type"].as_str() {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let text = text_of(&event["message"]);
        if is_noise(&text) {
            continue;
        }
        summary.messages += 1;
        if role == "user" && summary.title.is_empty() {
            summary.title = shorten(&text);
        }
        summary.last_role = role.to_string();
        summary.last_text = shorten(&text);
    }
    summary
}

/// The newest sessions in `dir`, summarised. An unreadable file is skipped, not
/// an error: a half-written transcript should not empty the panel.
#[tauri::command]
pub fn list_agent_sessions(dir: String, limit: usize) -> Result<Vec<SessionSummary>, String> {
    let base = Path::new(&dir);
    if !base.is_dir() {
        return Ok(vec![]);
    }
    let entries = std::fs::read_dir(base).map_err(|e| e.to_string())?;

    let mut files: Vec<(String, u64, u64, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        files.push((id, modified, meta.len(), path));
    }

    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    files.truncate(limit.clamp(1, 100));

    Ok(files
        .into_iter()
        .map(|(id, modified, bytes, path)| summarise(&path, id, modified, bytes))
        .collect())
}
