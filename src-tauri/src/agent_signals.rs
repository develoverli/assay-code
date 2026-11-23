//! Knowing when Claude finished a turn in a Workspace terminal.
//!
//! A PTY only reports process exit, so `claude --settings <file>` adds a `Stop`
//! hook and a status line that drop JSON into a folder, one file per terminal
//! (`ASSAY_PTY_ID`). A thread here reads, deletes and emits each file. No port
//! is opened: the folder is the whole channel.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// How often the folder is looked at. A turn ends at human speed.
const POLL: Duration = Duration::from_millis(500);
/// A file younger than this may still be being written by the hook.
const SETTLE: Duration = Duration::from_millis(250);
/// Folders left behind by earlier runs are cleared once they are this old.
const STALE: Duration = Duration::from_secs(24 * 60 * 60);
/// How much of Claude's last message travels to the notification.
const PREVIEW_CHARS: usize = 160;

/// Where the hook writes and what `--settings` points at, slash separated so
/// bash (which is what runs Claude's hooks on Windows too) reads them as is.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSignals {
    dir: String,
    settings: String,
}

#[derive(Clone, Serialize)]
struct AgentStop {
    id: String,
    message: Option<String>,
}

/// Only a successful setup is kept: a failure (temp dir full, permissions) is
/// retried on the next terminal instead of being returned for the rest of the run.
static SETUP: Mutex<Option<AgentSignals>> = Mutex::new(None);

fn slashed(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// The hook consumes its stdin either way: a hook that leaves it unread can make
/// the writer see a broken pipe. Without the variables (a settings file reused
/// by hand) it writes nothing.
const HOOK_COMMAND: &str = r#"if [ -n "$ASSAY_SIGNAL_DIR" ] && [ -n "$ASSAY_PTY_ID" ]; then cat > "$ASSAY_SIGNAL_DIR/$ASSAY_PTY_ID.$$.stop"; else cat > /dev/null; fi"#;

/// Saves Claude's status input as `<pty id>.status` (written aside and moved, so
/// the watcher never reads half of one), then pipes it to the user's own status
/// line: `--settings` outranks their `statusLine`, so without the chain it vanishes.
fn status_command(user: Option<&str>) -> String {
    let save = r#"__assay_in=$(cat); if [ -n "$ASSAY_SIGNAL_DIR" ] && [ -n "$ASSAY_PTY_ID" ]; then printf '%s' "$__assay_in" > "$ASSAY_SIGNAL_DIR/$ASSAY_PTY_ID.status.tmp" && mv -f "$ASSAY_SIGNAL_DIR/$ASSAY_PTY_ID.status.tmp" "$ASSAY_SIGNAL_DIR/$ASSAY_PTY_ID.status"; fi"#;
    match user {
        // a newline before the brace, so a command ending in a comment still closes it
        Some(cmd) => format!("{save}; printf '%s' \"$__assay_in\" | {{ {cmd}\n}}"),
        None => save.to_string(),
    }
}

/// The user's own `statusLine`, from the file Claude Code reads it from, so it
/// can be chained rather than replaced. Only the command kind has anything to chain.
fn user_status_line(home: Option<PathBuf>) -> Option<serde_json::Value> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home.map(|h| h.join(".claude")))?;
    let raw = std::fs::read_to_string(dir.join("settings.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let line = v.get("statusLine")?.clone();
    (line.get("type").and_then(|t| t.as_str()) == Some("command")).then_some(line)
}

fn settings_json(user_line: Option<serde_json::Value>) -> String {
    let user_cmd = user_line
        .as_ref()
        .and_then(|l| l.get("command"))
        .and_then(|c| c.as_str())
        .map(str::to_string);
    // the user's padding and refresh stay theirs; only the command is wrapped
    let mut status = user_line.unwrap_or_else(|| serde_json::json!({ "type": "command" }));
    status["command"] = serde_json::Value::String(status_command(user_cmd.as_deref()));
    serde_json::json!({
        "hooks": {
            "Stop": [{ "hooks": [{ "type": "command", "command": HOOK_COMMAND }] }]
        },
        "statusLine": status
    })
    .to_string()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Window {
    used_percentage: f64,
    /// Epoch seconds.
    resets_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextUse {
    used_percentage: f64,
    used_tokens: Option<u64>,
    size: Option<u64>,
}

/// What one status line update said, reduced to what the status bar shows.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    id: String,
    five_hour: Option<Window>,
    seven_day: Option<Window>,
    context: Option<ContextUse>,
}

fn window(v: &serde_json::Value) -> Option<Window> {
    Some(Window {
        used_percentage: v.get("used_percentage")?.as_f64()?,
        resets_at: v.get("resets_at")?.as_i64()?,
    })
}

/// Each field may be absent — limits only exist on a Pro or Max plan and only
/// after the first answer — so each is read on its own.
fn status_of(id: String, raw: &str) -> Option<AgentStatus> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let limits = v.get("rate_limits");
    let ctx = v.get("context_window");
    Some(AgentStatus {
        id,
        five_hour: limits.and_then(|l| l.get("five_hour")).and_then(window),
        seven_day: limits.and_then(|l| l.get("seven_day")).and_then(window),
        context: ctx.and_then(|c| {
            Some(ContextUse {
                used_percentage: c.get("used_percentage")?.as_f64()?,
                used_tokens: c.get("total_input_tokens").and_then(|x| x.as_u64()),
                size: c.get("context_window_size").and_then(|x| x.as_u64()),
            })
        }),
    })
}

fn clear_stale(root: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for e in entries.flatten() {
        let path = e.path();
        if path == keep {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > STALE);
        if old {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

/// The first line of what Claude said last, trimmed for a notification body.
fn preview(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let text = v.get("last_assistant_message")?.as_str()?;
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut out: String = line.chars().take(PREVIEW_CHARS).collect();
    if line.chars().count() > PREVIEW_CHARS {
        out.push('…');
    }
    Some(out)
}

/// The terminal a signal file belongs to: `<pty id>.<shell pid>.stop` or
/// `<pty id>.status`. Parsed from the right, so an id that itself contains dots
/// still routes to its own terminal.
fn pty_id_of(name: &str) -> Option<&str> {
    let id = if let Some(rest) = name.strip_suffix(".stop") {
        let (id, pid) = rest.rsplit_once('.')?;
        if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        id
    } else {
        name.strip_suffix(".status")?
    };
    (!id.is_empty()).then_some(id)
}

fn watch(app: AppHandle, dir: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or_default().to_string();
            if ext != "stop" && ext != "status" {
                continue;
            }
            let settled = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age >= SETTLE);
            if !settled {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let Some(id) = pty_id_of(&name).map(str::to_string) else { continue };
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            let _ = std::fs::remove_file(&path);
            if ext == "status" {
                if let Some(status) = status_of(id, &raw) {
                    let _ = app.emit("agent://status", status);
                }
            } else {
                let _ = app.emit("agent://stop", AgentStop { id, message: preview(&raw) });
            }
        }
    });
}

fn setup(app: &AppHandle) -> Result<AgentSignals, String> {
    let root = std::env::temp_dir().join("assay-agent-signals");
    // one folder per running Assay, so a second instance never eats this one's signals
    let dir = root.join(std::process::id().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    clear_stale(&root, &dir);
    let settings = dir.join("claude-settings.json");
    let user_line = user_status_line(app.path().home_dir().ok());
    std::fs::write(&settings, settings_json(user_line)).map_err(|e| e.to_string())?;
    watch(app.clone(), dir.clone());
    Ok(AgentSignals {
        dir: slashed(&dir),
        settings: slashed(&settings),
    })
}

/// Set up once per process and hand back the two paths a terminal needs.
#[tauri::command]
pub fn agent_signals(app: AppHandle) -> Result<AgentSignals, String> {
    // the lock is held through setup so two terminals opening at once start one watcher
    let mut cached = SETUP.lock().map_err(|e| e.to_string())?;
    if let Some(signals) = cached.as_ref() {
        return Ok(signals.clone());
    }
    let signals = setup(&app)?;
    *cached = Some(signals.clone());
    Ok(signals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_takes_the_first_line_of_the_last_message() {
        let raw = r#"{"hook_event_name":"Stop","last_assistant_message":"\n  Done: fixed the tests.\nMore detail"}"#;
        assert_eq!(preview(raw).as_deref(), Some("Done: fixed the tests."));
    }

    #[test]
    fn status_reads_limits_and_context_each_on_its_own() {
        let raw = r#"{"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600}},
            "context_window":{"used_percentage":8,"total_input_tokens":15500,"context_window_size":200000}}"#;
        let s = status_of("pty_1".into(), raw).unwrap();
        assert_eq!(s.five_hour.as_ref().map(|w| w.resets_at), Some(1738425600));
        assert!(s.seven_day.is_none());
        assert_eq!(s.context.as_ref().and_then(|c| c.size), Some(200000));
    }

    #[test]
    fn status_line_chains_the_users_own_command() {
        let with = status_command(Some("~/.claude/line.sh"));
        assert!(with.contains("| { ~/.claude/line.sh\n}"));
        assert!(!status_command(None).contains('|'));
    }

    #[test]
    fn signal_files_route_to_their_terminal() {
        assert_eq!(pty_id_of("pty_1.4242.stop"), Some("pty_1"));
        assert_eq!(pty_id_of("pty_1.status"), Some("pty_1"));
        // an id with dots keeps all of them
        assert_eq!(pty_id_of("term.v2.a.4242.stop"), Some("term.v2.a"));
        assert_eq!(pty_id_of("term.v2.a.status"), Some("term.v2.a"));
    }

    #[test]
    fn other_files_route_nowhere() {
        assert_eq!(pty_id_of("pty_1.status.tmp"), None);
        assert_eq!(pty_id_of("pty_1.stop"), None);
        assert_eq!(pty_id_of("pty_1.abc.stop"), None);
        assert_eq!(pty_id_of(".status"), None);
        assert_eq!(pty_id_of(".42.stop"), None);
        assert_eq!(pty_id_of("claude-settings.json"), None);
    }

    #[test]
    fn preview_is_none_without_a_message() {
        assert_eq!(preview(r#"{"hook_event_name":"Stop"}"#), None);
        assert_eq!(preview("not json"), None);
    }
}
