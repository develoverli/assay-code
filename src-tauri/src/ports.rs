//! Which TCP ports are listening on this machine, and which project each belongs to.
//!
//! The OS is asked with the tool it already ships (`netstat` on Windows, `lsof` on
//! macOS, `ss` then `lsof` on Linux) rather than a socket crate: the parsing is a
//! few lines and every dependency is supply chain. A port belongs to a project when
//! the process listening on it descends from one of that project's terminals, or —
//! for servers that run outside the shell's tree, like a container — when one of
//! those terminals printed `localhost:<port>`.

use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::{AppHandle, Manager};

use crate::pty::PtyState;

/// How far back into a terminal's output a printed URL still counts.
const SCROLLBACK_TAIL: usize = 64 * 1024;
/// A parent chain longer than this is a cycle or something stranger; stop walking.
const MAX_DEPTH: usize = 64;

/// One listening port, as the Ports panel shows it.
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    port: u16,
    /// The loopback address a tunnel should dial: `127.0.0.1` or `[::1]`.
    host: String,
    pid: Option<u32>,
    process: Option<String>,
    project_id: Option<String>,
    /// How the project was found: `process` (descends from its terminal),
    /// `output` (its terminal printed the URL), or absent.
    via: Option<String>,
}

/// One socket the OS reported in LISTEN.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Socket {
    host: String,
    port: u16,
    pid: Option<u32>,
}

/// The process sampler survives between calls; building one costs more than a read.
pub struct PortsState(Mutex<System>);

impl Default for PortsState {
    fn default() -> Self {
        PortsState(Mutex::new(System::new_with_specifics(
            RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
        )))
    }
}

/// `host:port` split at the last colon, brackets and `%iface` zone dropped.
fn split_addr(addr: &str) -> Option<(String, u16)> {
    let (host, port) = addr.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = host.split('%').next().unwrap_or(host);
    Some((host.to_string(), port))
}

/// The address a tunnel on this machine can reach a socket bound to `host` at,
/// or `None` when it is bound to some other interface only.
fn reach_host(host: &str) -> Option<&'static str> {
    match host {
        "0.0.0.0" | "*" => Some("127.0.0.1"),
        h if h.starts_with("127.") => Some("127.0.0.1"),
        // Windows does not hand IPv4 to a `[::]` socket by default, so dial it in v6
        "::" | "::1" => Some("[::1]"),
        _ => None,
    }
}

/// `netstat -ano` (Windows). The state column is translated on non-English
/// Windows, so LISTEN is recognised by its peer address, `0.0.0.0:0` / `[::]:0`.
fn parse_netstat(text: &str) -> Vec<Socket> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() != 5 || !cols[0].eq_ignore_ascii_case("TCP") || !cols[2].ends_with(":0") {
                return None;
            }
            let (host, port) = split_addr(cols[1])?;
            Some(Socket { host, port, pid: cols[4].parse().ok() })
        })
        .collect()
}

/// `lsof -nP -iTCP -sTCP:LISTEN -F pn`: a `p<pid>` line, then one `n<addr>` per socket.
fn parse_lsof(text: &str) -> Vec<Socket> {
    let mut pid = None;
    let mut out = Vec::new();
    for line in text.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let Some(addr) = line.strip_prefix('n') {
            if let Some((host, port)) = split_addr(addr) {
                out.push(Socket { host, port, pid });
            }
        }
    }
    out
}

/// `ss -ltnp`: local address in the fourth column, `pid=<n>` inside the process one.
/// The pid is only there for the user's own processes, which is all that matters here.
fn parse_ss(text: &str) -> Vec<Socket> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 5 || cols[0] == "State" {
                return None;
            }
            let (host, port) = split_addr(cols[3])?;
            let pid = line.split_once("pid=").and_then(|(_, rest)| {
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                digits.parse().ok()
            });
            Some(Socket { host, port, pid })
        })
        .collect()
}

/// A command's stdout, or `None` when it is missing or fails. No console window on Windows.
fn run_quiet(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: a GUI app spawning netstat would flash a console otherwise
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn listening_sockets() -> Vec<Socket> {
    if cfg!(windows) {
        return run_quiet("netstat", &["-ano"]).map(|t| parse_netstat(&t)).unwrap_or_default();
    }
    let lsof = || run_quiet("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]).map(|t| parse_lsof(&t));
    if cfg!(target_os = "macos") {
        return lsof().unwrap_or_default();
    }
    run_quiet("ss", &["-ltnp"])
        .map(|t| parse_ss(&t))
        .or_else(lsof)
        .unwrap_or_default()
}

/// Terminal output with colour and cursor sequences taken out — Vite prints its
/// port in bold, which puts an escape between `localhost:` and the digits.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte in @..~
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC (hyperlinks, titles): up to BEL or ESC \
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Every port a line of output points at on this machine (`localhost:5173`, `127.0.0.1:8080`…).
fn printed_ports(text: &str) -> Vec<u16> {
    const HOSTS: [&str; 5] = ["localhost:", "127.0.0.1:", "0.0.0.0:", "[::1]:", "[::]:"];
    let mut out = Vec::new();
    for host in HOSTS {
        for (i, _) in text.match_indices(host) {
            let digits: String = text[i + host.len()..]
                .chars()
                .take(6)
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(port) = digits.parse::<u16>() {
                if port > 0 && !out.contains(&port) {
                    out.push(port);
                }
            }
        }
    }
    out
}

/// The last `max` bytes of `text`, cut on a character boundary.
fn tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut cut = text.len() - max;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    &text[cut..]
}

/// The project whose terminal `pid` runs under, walking parent links up to a shell.
fn project_of(system: &System, shells: &HashMap<u32, Option<String>>, pid: u32) -> Option<String> {
    let mut current = Some(Pid::from_u32(pid));
    for _ in 0..MAX_DEPTH {
        let p = current?;
        if let Some(project) = shells.get(&p.as_u32()) {
            return project.clone();
        }
        current = system.process(p).and_then(|proc_| proc_.parent());
    }
    None
}

/// One row per port: the v4 socket wins over the v6 one, since that is what
/// `localhost` resolves to first for most dev servers.
fn dedupe(sockets: Vec<Socket>) -> Vec<(Socket, &'static str)> {
    let mut by_port: Vec<(Socket, &'static str)> = Vec::new();
    for s in sockets {
        let Some(reach) = reach_host(&s.host) else { continue };
        match by_port.iter_mut().find(|(seen, _)| seen.port == s.port) {
            Some(slot) if slot.1 != "127.0.0.1" && reach == "127.0.0.1" => *slot = (s, reach),
            Some(_) => {}
            None => by_port.push((s, reach)),
        }
    }
    by_port.sort_by_key(|(s, _)| s.port);
    by_port
}

fn list_now(app: &AppHandle) -> Vec<ListeningPort> {
    let sockets = dedupe(listening_sockets());
    let roots = app.state::<PtyState>().shell_roots();
    let shells: HashMap<u32, Option<String>> = roots
        .iter()
        .filter_map(|r| r.pid.map(|pid| (pid, r.project_id.clone())))
        .collect();

    // ports each project's terminals printed, newest output only
    let mut printed: HashMap<u16, String> = HashMap::new();
    for root in &roots {
        let Some(project) = &root.project_id else { continue };
        let Ok(sb) = root.scrollback.lock() else { continue };
        for port in printed_ports(&strip_ansi(tail(&sb, SCROLLBACK_TAIL))) {
            printed.entry(port).or_insert_with(|| project.clone());
        }
    }

    let state = app.state::<PortsState>();
    let Ok(mut system) = state.0.lock() else {
        return Vec::new();
    };
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());

    sockets
        .into_iter()
        .map(|(s, reach)| {
            let by_process = s.pid.and_then(|pid| project_of(&system, &shells, pid));
            let (project_id, via) = match (by_process, printed.get(&s.port)) {
                (Some(p), _) => (Some(p), Some("process")),
                (None, Some(p)) => (Some(p.clone()), Some("output")),
                (None, None) => (None, None),
            };
            ListeningPort {
                port: s.port,
                host: reach.to_string(),
                pid: s.pid,
                process: s
                    .pid
                    .and_then(|pid| system.process(Pid::from_u32(pid)))
                    .map(|p| p.name().to_string_lossy().into_owned()),
                project_id,
                via: via.map(str::to_string),
            }
        })
        .collect()
}

/// Every port listening on loopback or every interface, each tagged with the
/// project it belongs to when one can be told. Off the main thread: `netstat`
/// takes a noticeable moment on Windows.
#[tauri::command]
pub async fn ports_list(app: AppHandle) -> Result<Vec<ListeningPort>, String> {
    tauri::async_runtime::spawn_blocking(move || list_now(&app))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netstat_listening_rows_are_read_in_any_language() {
        let text = "\
Conexiones activas

  Proto  Dirección local          Dirección remota        Estado           PID
  TCP    0.0.0.0:5173           0.0.0.0:0              ESCUCHANDO       4120
  TCP    127.0.0.1:5173         127.0.0.1:50122        ESTABLECIDA      4120
  TCP    [::1]:3000             [::]:0                 LISTENING        88
  UDP    0.0.0.0:5353           *:*                                     900
";
        assert_eq!(
            parse_netstat(text),
            vec![
                Socket { host: "0.0.0.0".into(), port: 5173, pid: Some(4120) },
                Socket { host: "::1".into(), port: 3000, pid: Some(88) },
            ]
        );
    }

    #[test]
    fn lsof_field_output_carries_the_pid_to_each_socket() {
        let text = "p501\nf21\nn*:5173\nf22\nn[::1]:5173\np77\nf3\nn127.0.0.1:8080\n";
        assert_eq!(
            parse_lsof(text),
            vec![
                Socket { host: "*".into(), port: 5173, pid: Some(501) },
                Socket { host: "::1".into(), port: 5173, pid: Some(501) },
                Socket { host: "127.0.0.1".into(), port: 8080, pid: Some(77) },
            ]
        );
    }

    #[test]
    fn ss_reads_the_pid_when_the_process_is_ours() {
        let text = "\
State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      511          *:5173            *:*     users:((\"node\",pid=1234,fd=20))
LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*
";
        assert_eq!(
            parse_ss(text),
            vec![
                Socket { host: "*".into(), port: 5173, pid: Some(1234) },
                Socket { host: "127.0.0.53".into(), port: 53, pid: None },
            ]
        );
    }

    #[test]
    fn a_socket_on_a_lan_address_only_is_not_reachable_through_loopback() {
        assert_eq!(reach_host("192.168.1.20"), None);
    }

    #[test]
    fn dedupe_prefers_the_ipv4_socket_for_a_port() {
        let rows = dedupe(vec![
            Socket { host: "::".into(), port: 5173, pid: Some(1) },
            Socket { host: "0.0.0.0".into(), port: 5173, pid: Some(1) },
        ]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "127.0.0.1");
    }

    #[test]
    fn a_port_printed_in_bold_is_still_found() {
        let line = "  \u{1b}[32m➜\u{1b}[39m  Local:   http://localhost:\u{1b}[1m5173\u{1b}[22m/";
        assert_eq!(printed_ports(&strip_ansi(line)), vec![5173]);
    }

    #[test]
    fn printed_ports_ignore_numbers_that_cannot_be_ports() {
        assert_eq!(printed_ports("http://localhost:99999 and 127.0.0.1:8080"), vec![8080]);
    }

    #[test]
    fn tail_never_cuts_a_character_in_half() {
        assert_eq!(tail("aé", 1), "");
        assert_eq!(tail("aé", 2), "é");
    }
}
