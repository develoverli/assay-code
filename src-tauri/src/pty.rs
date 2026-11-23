//! Real terminals for Workspace.
//!
//! Interactive agents need a TTY, not the piped stdout `tauri-plugin-shell` gives.
//! Sessions live on the Rust side so they outlive the webview: only closing the
//! tab or quitting Assay kills one.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// How much output a session remembers, so a remounted terminal can be redrawn.
const SCROLLBACK_LIMIT: usize = 256 * 1024;

#[derive(Clone, Serialize)]
struct PtyData {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

/// What the UI needs to rebuild a tab for a session it has lost track of.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    id: String,
    title: String,
    /// The name it was given at spawn, which a rename cleared back to.
    default_title: String,
    kind: String,
    cwd: String,
    /// The project the tab belonged to, so a reload puts it back under the same one.
    project_id: Option<String>,
    alive: bool,
}

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    scrollback: Arc<Mutex<String>>,
    /// Carried so a reloaded webview can rebuild the tab it belonged to.
    title: String,
    default_title: String,
    kind: String,
    cwd: String,
    project_id: Option<String>,
}

#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, Session>>);

fn keep_tail(buf: &mut String) {
    if buf.len() <= SCROLLBACK_LIMIT {
        return;
    }
    let cut = buf.len() - SCROLLBACK_LIMIT;
    // never slice through a multi-byte character
    let idx = buf
        .char_indices()
        .map(|(i, _)| i)
        .find(|i| *i >= cut)
        .unwrap_or(buf.len());
    *buf = buf[idx..].to_string();
}

/// Decode one read of PTY output. A multi-byte character split across two
/// reads is held in `pending` and finished by the next one; only bytes that can
/// never become valid UTF-8 turn into U+FFFD.
fn decode_utf8(pending: &mut Vec<u8>, input: &[u8]) -> String {
    pending.extend_from_slice(input);
    let mut out = String::with_capacity(pending.len());
    let mut rest: &[u8] = pending;
    let mut tail = Vec::new();
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                break;
            }
            Err(e) => {
                let (valid, after) = rest.split_at(e.valid_up_to());
                // `valid_up_to` guarantees this prefix decodes
                if let Ok(s) = std::str::from_utf8(valid) {
                    out.push_str(s);
                }
                match e.error_len() {
                    Some(len) => {
                        out.push(char::REPLACEMENT_CHARACTER);
                        rest = &after[len..];
                    }
                    None => {
                        tail = after.to_vec();
                        break;
                    }
                }
            }
        }
    }
    *pending = tail;
    out
}

/// Start a session. `id` is chosen by the caller and addresses it from then on.
#[tauri::command]
#[expect(clippy::too_many_arguments, reason = "Tauri command arguments are the IPC contract")]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    // Prompts travel here, not in the command line: MSYS2 re-parses the
    // command line on Windows and eats the quoting.
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
    title: Option<String>,
    kind: Option<String>,
    project_id: Option<String>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if sessions.contains_key(&id) {
        return Ok(());
    }

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd.clone() {
        cmd.cwd(dir);
    }
    // agents render boxes and colour; without this they fall back to dumb output
    cmd.env("TERM", "xterm-256color");
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let scrollback = Arc::new(Mutex::new(String::new()));

    let thread_scrollback = Arc::clone(&scrollback);
    let thread_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = decode_utf8(&mut pending, &buf[..n]);
                    if chunk.is_empty() {
                        continue;
                    }
                    if let Ok(mut sb) = thread_scrollback.lock() {
                        sb.push_str(&chunk);
                        keep_tail(&mut sb);
                    }
                    let _ = app.emit(
                        "pty://data",
                        PtyData {
                            id: thread_id.clone(),
                            data: chunk,
                        },
                    );
                }
            }
        }
        let _ = app.emit("pty://exit", PtyExit { id: thread_id });
    });

    sessions.insert(
        id.clone(),
        Session {
            writer,
            master: pair.master,
            child,
            scrollback,
            default_title: title.clone().unwrap_or_else(|| id.clone()),
            title: title.unwrap_or(id),
            kind: kind.unwrap_or_else(|| "shell".to_string()),
            cwd: cwd.unwrap_or_default(),
            project_id,
        },
    );
    Ok(())
}

/// Feed keystrokes to a session.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("no such terminal")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

/// Tell the program its window changed, so full-screen UIs redraw correctly.
#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("no such terminal")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Everything the session printed since it started (capped), to redraw a tab.
#[tauri::command]
pub fn pty_scrollback(state: State<'_, PtyState>, id: String) -> Result<String, String> {
    let sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("no such terminal")?;
    let sb = session.scrollback.lock().map_err(|e| e.to_string())?;
    Ok(sb.clone())
}

/// Kill the process and forget the session. Safe to call on one already gone.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    // out of the map under the lock, killed outside it: `wait` can block, and
    // every other terminal command needs that lock meanwhile
    let removed = state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(mut session) = removed {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

/// Name a tab the user's way; an empty name goes back to the one it was spawned with.
#[tauri::command]
pub fn pty_rename(state: State<'_, PtyState>, id: String, title: String) -> Result<String, String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("no such terminal")?;
    let name = title.trim();
    session.title = if name.is_empty() {
        session.default_title.clone()
    } else {
        name.to_string()
    };
    Ok(session.title.clone())
}

/// Every session still held, so the UI can rebuild its tabs after a reload.
#[tauri::command]
pub fn pty_list(state: State<'_, PtyState>) -> Result<Vec<SessionInfo>, String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    Ok(sessions
        .iter_mut()
        .map(|(id, session)| SessionInfo {
            id: id.clone(),
            title: session.title.clone(),
            default_title: session.default_title.clone(),
            kind: session.kind.clone(),
            cwd: session.cwd.clone(),
            project_id: session.project_id.clone(),
            alive: matches!(session.child.try_wait(), Ok(None)),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_split_across_reads_is_kept_whole() {
        let bytes = "aé€😀".as_bytes();
        let mut pending = Vec::new();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&decode_utf8(&mut pending, std::slice::from_ref(b)));
        }
        assert_eq!(out, "aé€😀");
        assert!(pending.is_empty());
    }

    #[test]
    fn an_incomplete_tail_waits_for_the_next_read() {
        let euro = "€".as_bytes();
        let mut pending = Vec::new();
        assert_eq!(decode_utf8(&mut pending, &[b'x', euro[0], euro[1]]), "x");
        assert_eq!(pending, &euro[..2]);
        assert_eq!(decode_utf8(&mut pending, &[euro[2], b'y']), "€y");
        assert!(pending.is_empty());
    }

    #[test]
    fn invalid_bytes_are_replaced_and_decoding_goes_on() {
        let mut pending = Vec::new();
        assert_eq!(decode_utf8(&mut pending, b"a\xffb\xc3(c"), "a\u{FFFD}b\u{FFFD}(c");
        assert!(pending.is_empty());
    }
}
