//! How much memory Assay is actually using, including the WebView2 / WebKit
//! child processes, which hold most of it.

use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

#[derive(Clone, Serialize)]
pub struct MemoryUsage {
    /// Resident set of this process plus every descendant, in bytes.
    bytes: u64,
    /// How many processes that covers — the webview runs several.
    processes: usize,
}

/// The sampler is kept alive between calls: rebuilding it every few seconds
/// would cost more than the reading is worth.
pub struct UsageState(Mutex<System>);

impl Default for UsageState {
    fn default() -> Self {
        UsageState(Mutex::new(System::new_with_specifics(
            RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().with_memory()),
        )))
    }
}

/// `root` and every descendant of it, found by walking parent links.
fn family(system: &System, root: Pid) -> Vec<Pid> {
    let mut found = vec![root];
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for (pid, process) in system.processes() {
            if process.parent() == Some(parent) && !found.contains(pid) {
                found.push(*pid);
                frontier.push(*pid);
            }
        }
    }
    found
}

#[tauri::command]
pub fn memory_usage(state: tauri::State<'_, UsageState>) -> Result<MemoryUsage, String> {
    let mut system = state.0.lock().map_err(|e| e.to_string())?;
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    let root = Pid::from_u32(std::process::id());
    let pids = family(&system, root);
    let mut bytes = 0;
    let mut processes = 0;
    for pid in &pids {
        if let Some(process) = system.process(*pid) {
            bytes += process.memory();
            processes += 1;
        }
    }

    Ok(MemoryUsage { bytes, processes })
}
