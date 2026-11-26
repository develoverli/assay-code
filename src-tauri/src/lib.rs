mod agent_signals;
mod clipboard;
mod deploy;
mod ports;
mod pty;
mod sessions;
mod tunnel;
mod usage;

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// A migration's SQL with LF line endings, whatever the checkout wrote.
///
/// sqlx checksums applied migrations and refuses new ones when an old one's
/// bytes differ, so a CRLF checkout (`core.autocrlf`) must embed the same bytes.
fn lf(sql: &'static str) -> &'static str {
    if sql.contains('\r') {
        Box::leak(sql.replace("\r\n", "\n").into_boxed_str())
    } else {
        sql
    }
}

/// How this copy was installed, so the updater knows whether it can replace it.
/// On Linux only an AppImage can; a .deb or .rpm belongs to the package manager.
#[tauri::command]
fn install_kind() -> &'static str {
    if !cfg!(target_os = "linux") {
        "bundle"
    } else if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else {
        "package"
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial schema",
            sql: lf(include_str!("../migrations/001_init.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "sonarqube built-in tool",
            sql: lf(include_str!("../migrations/002_sonarqube.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "project retirement and check reset",
            sql: lf(include_str!("../migrations/003_project_lifecycle.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "tombstones for removed built-in tools",
            sql: lf(include_str!("../migrations/004_deleted_builtins.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "per-tool options",
            sql: lf(include_str!("../migrations/005_tool_config.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "finding triage status, fingerprints and indexes",
            sql: lf(include_str!("../migrations/006_finding_status.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "tool stack tags in the detected vocabulary",
            sql: lf(include_str!("../migrations/007_tool_stacks.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "user tags for projects",
            sql: lf(include_str!("../migrations/008_project_tags.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "last use of a project, for ordering",
            sql: lf(include_str!("../migrations/009_project_last_used.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "github repository a project was cloned from",
            sql: lf(include_str!("../migrations/010_project_github.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "whether a cloned project's github repository is private",
            sql: lf(include_str!("../migrations/011_project_github_private.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "starred scripts and hand-written commands per project",
            sql: lf(include_str!("../migrations/012_project_commands.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "deploy servers and what each one last received",
            sql: lf(include_str!("../migrations/013_deploy.sql")),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "ports added by hand to a project's Ports panel",
            sql: lf(include_str!("../migrations/014_project_ports.sql")),
            kind: MigrationKind::Up,
        },
    ];

    let builder = tauri::Builder::default();
    // self-update: checks GitHub Releases, verifies the minisign signature against
    // the public key in tauri.conf.json, installs; process relaunches afterwards
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .manage(pty::PtyState::default())
        .manage(usage::UsageState::default())
        .manage(ports::PortsState::default())
        .manage(tunnel::TunnelState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_scrollback,
            pty::pty_kill,
            pty::pty_list,
            pty::pty_rename,
            clipboard::clipboard_files,
            clipboard::clipboard_image_to_temp_file,
            sessions::list_agent_sessions,
            usage::memory_usage,
            agent_signals::agent_signals,
            deploy::deploy_scan,
            deploy::deploy_test,
            deploy::deploy_upload,
            deploy::deploy_cancel,
            deploy::deploy_secret_set,
            deploy::deploy_secret_delete,
            deploy::deploy_secret_has,
            ports::ports_list,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_list,
            install_kind,
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // off until Settings turns it on; the argument tells the app it was autostarted
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:assay.db", migrations)
                .build(),
        )
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // a public link must not outlive the app that opened it
            if let tauri::RunEvent::Exit = event {
                app.state::<tunnel::TunnelState>().kill_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::lf;

    #[test]
    fn migrations_checksum_the_same_from_any_checkout() {
        assert_eq!(lf("CREATE TABLE a (x);\r\n-- c\r\n"), "CREATE TABLE a (x);\n-- c\n");
        assert_eq!(lf("already lf\n"), "already lf\n");
    }
}
