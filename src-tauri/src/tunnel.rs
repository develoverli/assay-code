//! Public links to a local port, through a cloudflared quick tunnel.
//!
//! `cloudflared tunnel --url http://127.0.0.1:<port>` opens an outbound connection
//! to Cloudflare and prints a `https://<random>.trycloudflare.com` address; no
//! account, no inbound port. The process lives here rather than in the webview so a
//! link survives a reload the way a terminal does, and every one of them is killed
//! when Assay exits — a public URL nobody remembers opening is the failure to avoid.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Lines of cloudflared's log kept to explain a tunnel that died.
const LOG_TAIL: usize = 12;
/// The only hosts a tunnel is allowed to dial: this machine.
const LOOPBACK: [&str; 3] = ["127.0.0.1", "[::1]", "localhost"];

#[derive(Clone, Serialize)]
struct TunnelReady {
    id: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct TunnelExit {
    id: String,
    /// The end of cloudflared's log, to say why when it never produced a URL.
    detail: String,
}

/// What the UI needs to rebuild a tunnel's row after a reload.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    id: String,
    port: u16,
    project_id: Option<String>,
    url: Option<String>,
    started_at: u64,
    alive: bool,
}

struct Tunnel {
    child: Child,
    port: u16,
    project_id: Option<String>,
    url: Arc<Mutex<Option<String>>>,
    started_at: u64,
}

#[derive(Default)]
pub struct TunnelState(Mutex<HashMap<String, Tunnel>>);

impl TunnelState {
    /// Kill every tunnel. Called when the app exits, so no link outlives it.
    pub fn kill_all(&self) {
        let drained: Vec<Tunnel> = match self.0.lock() {
            Ok(mut map) => map.drain().map(|(_, t)| t).collect(),
            Err(_) => return,
        };
        for mut t in drained {
            let _ = t.child.kill();
            let _ = t.child.wait();
        }
    }
}

/// The quick-tunnel address in one line of cloudflared's log, if there is one.
/// `api.trycloudflare.com` is the service it asks, not the tunnel.
fn quick_tunnel_url(line: &str) -> Option<String> {
    const SUFFIX: &str = ".trycloudflare.com";
    let start = line.find("https://")?;
    let rest = &line[start + "https://".len()..];
    let host: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '.')
        .collect();
    let sub = host.strip_suffix(SUFFIX)?;
    (!sub.is_empty() && sub != "api" && !sub.contains('.')).then(|| format!("https://{host}"))
}

/// Only a binary called cloudflared may be started through this command: the
/// webview picks the path (PATH, a known install folder, or one set in Toolchain).
fn is_cloudflared(program: &str) -> bool {
    Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("cloudflared"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Open a tunnel to `host:port`. `id` is the caller's; `tunnel://ready` carries
/// the URL once cloudflared prints it, `tunnel://exit` the end of its log if it stops.
#[tauri::command]
pub fn tunnel_start(
    app: AppHandle,
    state: State<'_, TunnelState>,
    id: String,
    program: String,
    host: String,
    port: u16,
    project_id: Option<String>,
) -> Result<(), String> {
    if !is_cloudflared(&program) {
        return Err(format!("not cloudflared: {program}"));
    }
    if !LOOPBACK.contains(&host.as_str()) || port == 0 {
        return Err(format!("only this machine can be shared, not {host}:{port}"));
    }
    let mut tunnels = state.0.lock().map_err(|e| e.to_string())?;
    if tunnels.contains_key(&id) {
        return Ok(());
    }

    let mut cmd = Command::new(&program);
    cmd.args([
        "tunnel",
        "--no-autoupdate",
        // dev servers refuse an unknown Host (Vite: "Blocked request"); the origin
        // sees the request as if it came to localhost, which is what it was built for
        "--http-host-header",
        &format!("localhost:{port}"),
        "--url",
        &format!("http://{host}:{port}"),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flashing up behind the app
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    let stderr = child.stderr.take().ok_or("cloudflared gave no log")?;

    let url = Arc::new(Mutex::new(None));
    let thread_url = Arc::clone(&url);
    let thread_id = id.clone();
    std::thread::spawn(move || {
        let mut log: Vec<String> = Vec::with_capacity(LOG_TAIL);
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            let found = quick_tunnel_url(&line);
            if let Some(found) = found {
                let first = match thread_url.lock() {
                    Ok(mut slot) if slot.is_none() => {
                        *slot = Some(found.clone());
                        true
                    }
                    _ => false,
                };
                if first {
                    let _ = app.emit("tunnel://ready", TunnelReady { id: thread_id.clone(), url: found });
                }
            }
            if log.len() == LOG_TAIL {
                log.remove(0);
            }
            log.push(line);
        }
        let _ = app.emit(
            "tunnel://exit",
            TunnelExit { id: thread_id, detail: log.join("\n") },
        );
    });

    tunnels.insert(
        id,
        Tunnel { child, port, project_id, url, started_at: now_ms() },
    );
    Ok(())
}

/// Close a tunnel and forget it. Safe on one already gone.
#[tauri::command]
pub fn tunnel_stop(state: State<'_, TunnelState>, id: String) -> Result<(), String> {
    // out of the map under the lock, killed outside it: `wait` can block
    let removed = state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(mut t) = removed {
        let _ = t.child.kill();
        let _ = t.child.wait();
    }
    Ok(())
}

/// Every tunnel still held, so a reloaded webview can show them again.
#[tauri::command]
pub fn tunnel_list(state: State<'_, TunnelState>) -> Result<Vec<TunnelInfo>, String> {
    let mut tunnels = state.0.lock().map_err(|e| e.to_string())?;
    Ok(tunnels
        .iter_mut()
        .map(|(id, t)| TunnelInfo {
            id: id.clone(),
            port: t.port,
            project_id: t.project_id.clone(),
            url: t.url.lock().ok().and_then(|u| u.clone()),
            started_at: t.started_at,
            alive: matches!(t.child.try_wait(), Ok(None)),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_is_read_out_of_the_banner() {
        let line = "2026-11-26T10:00:00Z INF |  https://calm-river-1234.trycloudflare.com                    |";
        assert_eq!(
            quick_tunnel_url(line).as_deref(),
            Some("https://calm-river-1234.trycloudflare.com")
        );
    }

    #[test]
    fn the_service_endpoint_is_not_taken_for_the_tunnel() {
        assert_eq!(quick_tunnel_url("failed to request https://api.trycloudflare.com/tunnel"), None);
    }

    #[test]
    fn other_https_urls_are_ignored() {
        assert_eq!(quick_tunnel_url("see https://developers.cloudflare.com/x"), None);
    }

    #[test]
    fn only_a_cloudflared_binary_is_accepted() {
        assert!(is_cloudflared("C:\\Program Files (x86)\\cloudflared\\cloudflared.exe"));
        assert!(is_cloudflared("cloudflared"));
        assert!(!is_cloudflared("C:\\Windows\\System32\\cmd.exe"));
    }
}
