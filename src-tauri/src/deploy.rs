//! Deploy: the files that changed since the last upload, and the upload itself.
//!
//! The webview hands in each server's manifest (path, size, mtime, hash from
//! assay.db); this module compares it with the disk and talks to the server.
//! SFTP goes through russh (OpenSSH only takes a password from a person), FTP
//! and FTPS through the system curl.
//!
//! Passwords live in the OS keychain and never reach the webview: it can set,
//! delete and ask whether one exists, never read it. Host keys are pinned on
//! first use; a later different key is refused outright.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use glob::{MatchOptions, Pattern};
use russh::client;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime};

/// The keychain service every server password is filed under; the account is the server id.
const KEYRING_SERVICE: &str = "assay-deploy";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// A test connection lists this much of the remote folder, enough to recognise it.
const LIST_LIMIT: usize = 40;
/// Files per curl run: one login for many files, and progress still moves.
const FTP_BATCH: usize = 25;

/* --------------------------------- scanning -------------------------------- */

#[derive(Deserialize)]
pub struct KnownFile {
    path: String,
    size: u64,
    mtime: u64,
    hash: String,
}

#[derive(Serialize, Clone)]
pub struct FileState {
    path: String,
    size: u64,
    mtime: u64,
    hash: String,
}

#[derive(Serialize)]
pub struct ScanResult {
    /// Not in the manifest at all.
    added: Vec<FileState>,
    /// In the manifest, with other content.
    modified: Vec<FileState>,
    /// Same content, new mtime: the manifest is updated, nothing is uploaded.
    touched: Vec<FileState>,
    /// In the manifest, gone from the disk.
    deleted: Vec<String>,
    /// How many files were looked at, excluded ones not counted.
    files: usize,
}

/// gitignore-lite: a pattern without a slash matches any single path segment
/// (`node_modules`, `*.log`, `.env*`); one with a slash matches from the root
/// (`dist/assets`, `/build`), or anywhere when it starts with `**/`. A trailing
/// slash is accepted and ignored. Comments and blank lines are skipped.
pub struct Excludes {
    segment: Vec<Pattern>,
    rooted: Vec<Pattern>,
}

const MATCH: MatchOptions = MatchOptions {
    case_sensitive: true,
    require_literal_separator: true,
    require_literal_leading_dot: false,
};

impl Excludes {
    pub fn new(patterns: &[String]) -> Self {
        let mut segment = Vec::new();
        let mut rooted = Vec::new();
        for raw in patterns {
            let p = raw.trim().replace('\\', "/");
            let p = p.trim_end_matches('/');
            if p.is_empty() || p.starts_with('#') {
                continue;
            }
            let Ok(pattern) = Pattern::new(p.trim_start_matches('/')) else { continue };
            if p.contains('/') {
                rooted.push(pattern);
            } else {
                segment.push(pattern);
            }
        }
        Self { segment, rooted }
    }

    /// `rel` is slash-separated and relative to the deploy root.
    pub fn matches(&self, rel: &str) -> bool {
        if rel.split('/').any(|seg| self.segment.iter().any(|p| p.matches_with(seg, MATCH))) {
            return true;
        }
        // a rooted pattern names a file or a folder: every prefix of the path is tried
        let mut end = 0;
        loop {
            let next = rel[end..].find('/').map(|i| end + i);
            let prefix = &rel[..next.unwrap_or(rel.len())];
            if self.rooted.iter().any(|p| p.matches_with(prefix, MATCH)) {
                return true;
            }
            match next {
                Some(i) => end = i + 1,
                None => return false,
            }
        }
    }
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flashing up for a background curl
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn walk_files(base: &Path, excludes: &Excludes) -> Vec<String> {
    let mut out = Vec::new();
    let walker = walkdir::WalkDir::new(base).follow_links(false).into_iter().filter_entry(|e| {
        let Ok(rel) = e.path().strip_prefix(base) else { return true };
        let rel = rel.to_string_lossy().replace('\\', "/");
        // the root itself is never excluded; everything under it is asked
        rel.is_empty() || !excludes.matches(&rel)
    });
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(base) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    out
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn scan(base: &Path, excludes: &Excludes, known: Vec<KnownFile>) -> ScanResult {
    // the server's own exclude list and nothing else: .gitignore is the wrong
    // guide here, since what gets deployed is so often what git ignores (dist/, vendor/)
    let listed = walk_files(base, excludes);
    let mut known: HashMap<String, KnownFile> = known.into_iter().map(|k| (k.path.clone(), k)).collect();
    let mut result = ScanResult { added: vec![], modified: vec![], touched: vec![], deleted: vec![], files: 0 };

    for rel in listed {
        if excludes.matches(&rel) {
            continue;
        }
        let full = base.join(&rel);
        // a file can vanish between the walk and this read; the disk is the truth
        let Ok(meta) = std::fs::metadata(&full) else { continue };
        if !meta.is_file() {
            continue;
        }
        result.files += 1;
        let size = meta.len();
        let mtime = mtime_ms(&meta);
        match known.remove(&rel) {
            Some(k) if k.size == size && k.mtime == mtime => {}
            Some(k) => {
                let Ok(hash) = hash_file(&full) else { continue };
                let state = FileState { path: rel, size, mtime, hash };
                if state.hash == k.hash {
                    result.touched.push(state);
                } else {
                    result.modified.push(state);
                }
            }
            None => {
                let Ok(hash) = hash_file(&full) else { continue };
                result.added.push(FileState { path: rel, size, mtime, hash });
            }
        }
    }
    // what is left was uploaded once and is no longer here — unless the user
    // has since excluded it, in which case it is simply no longer Deploy's business
    let mut deleted: Vec<String> = known.into_keys().filter(|p| !excludes.matches(p)).collect();
    deleted.sort();
    result.deleted = deleted;
    result
}

/// A path from the webview, accepted only when it stays inside the deploy root
/// on both ends: no absolute path, drive letter, root, `.` or `..` component.
/// Both separators are checked, since a remote Windows server honours `\` too.
fn checked_rel(rel: &str) -> Result<&str, String> {
    let refuse = || Err(format!("{rel}: not a path inside the deploy folder."));
    if rel.is_empty() || rel.split(['/', '\\']).any(|seg| seg == "..") {
        return refuse();
    }
    // `C:x` is a Normal component on Unix but a drive on the far end
    let first = rel.split(['/', '\\']).next().unwrap_or_default();
    if first.len() == 2 && first.ends_with(':') && first.as_bytes()[0].is_ascii_alphabetic() {
        return refuse();
    }
    if !Path::new(rel).components().all(|c| matches!(c, Component::Normal(_))) {
        return refuse();
    }
    Ok(rel)
}

/// `base/rel`, refused when `rel` would land outside `base`.
fn local_path(base: &Path, rel: &str) -> Result<PathBuf, String> {
    Ok(base.join(checked_rel(rel)?))
}

fn deploy_base(root: &str, local_dir: &str) -> PathBuf {
    let local = local_dir.trim().trim_matches(|c| c == '/' || c == '\\');
    if local.is_empty() {
        PathBuf::from(root)
    } else {
        Path::new(root).join(local)
    }
}

/// What changed under `root/local_dir` since the manifest was written.
#[tauri::command]
pub async fn deploy_scan(
    root: String,
    local_dir: String,
    excludes: Vec<String>,
    known: Vec<KnownFile>,
) -> Result<ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = deploy_base(&root, &local_dir);
        if !base.is_dir() {
            return Err(format!("{} is not a folder.", base.display()));
        }
        Ok(scan(&base, &Excludes::new(&excludes), known))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* --------------------------------- secrets --------------------------------- */

fn entry(server_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, server_id).map_err(|e| e.to_string())
}

fn read_secret(server_id: &str) -> Result<Option<String>, String> {
    match entry(server_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// File a server's password (or a key's passphrase) in the OS keychain.
#[tauri::command]
pub async fn deploy_secret_set(server_id: String, secret: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || entry(&server_id)?.set_password(&secret).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn deploy_secret_delete(server_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match entry(&server_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether a secret is filed — the only thing the webview ever learns about it.
#[tauri::command]
pub async fn deploy_secret_has(server_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || read_secret(&server_id).map(|s| s.is_some()))
        .await
        .map_err(|e| e.to_string())?
}

/* ------------------------------- connections ------------------------------- */

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Conn {
    server_id: String,
    /// "sftp" | "ftp" | "ftps"
    protocol: String,
    host: String,
    port: u16,
    username: String,
    /// "password" | "key" — SFTP only; FTP always uses the password.
    auth: String,
    key_path: Option<String>,
    remote_path: String,
    /// The fingerprint the user accepted, `SHA256:…`.
    host_key: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum TestResult {
    Ok { cwd: String, entries: Vec<String> },
    /// First contact: nothing was sent, the user has to accept this key.
    UnknownHost { fingerprint: String },
    /// The server answers with a key other than the one accepted. Refused.
    HostChanged { expected: String, fingerprint: String },
}

/// Why a connection did not happen, kept apart from plain errors so a host
/// key question is never mistaken for a failure.
enum Refusal {
    Unknown(String),
    Changed { expected: String, got: String },
    Error(String),
}

impl From<String> for Refusal {
    fn from(e: String) -> Self {
        Refusal::Error(e)
    }
}

/// `/var/www` + `css/site.css` → `/var/www/css/site.css`, whatever the local separator.
pub fn remote_join(base: &str, rel: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let rel = rel.trim_start_matches('/');
    if base.is_empty() {
        rel.to_string()
    } else if rel.is_empty() {
        base.to_string()
    } else {
        format!("{base}/{rel}")
    }
}

struct Pinning {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

fn fingerprint(key: &PublicKeyOrCertificate) -> String {
    match key {
        PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
        PublicKeyOrCertificate::Certificate(cert) => cert.public_key().fingerprint(HashAlg::Sha256).to_string(),
    }
}

impl client::Handler for Pinning {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = fingerprint(key);
        let accepted = self.expected.as_deref() == Some(fp.as_str());
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(fp);
        }
        Ok(accepted)
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// `~/…` is the user's home, as every ssh config writes it.
fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")), home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// The key named on the server, else the ones ssh itself would try first.
fn key_candidates(key_path: Option<&str>) -> Vec<PathBuf> {
    if let Some(p) = key_path.map(str::trim).filter(|p| !p.is_empty()) {
        return vec![expand_home(p)];
    }
    let Some(home) = home_dir() else { return vec![] };
    ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| home.join(".ssh").join(n)).filter(|p| p.is_file()).collect()
}

async fn ssh_connect(conn: &Conn) -> Result<client::Handle<Pinning>, Refusal> {
    let seen = Arc::new(Mutex::new(None));
    let handler = Pinning { expected: conn.host_key.clone(), seen: seen.clone() };
    let config = Arc::new(client::Config { inactivity_timeout: Some(Duration::from_secs(60)), ..Default::default() });
    let attempt = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, (conn.host.as_str(), conn.port), handler)).await;
    let failure = match attempt {
        Ok(Ok(handle)) => return Ok(handle),
        Ok(Err(e)) => e.to_string(),
        Err(_) => format!("{}:{} did not answer within {} s.", conn.host, conn.port, CONNECT_TIMEOUT.as_secs()),
    };
    // a refused key is not an error to the user: it is a question, or an alarm
    let got = seen.lock().ok().and_then(|s| s.clone());
    match (got, &conn.host_key) {
        (Some(got), None) => Err(Refusal::Unknown(got)),
        (Some(got), Some(expected)) if &got != expected => Err(Refusal::Changed { expected: expected.clone(), got }),
        _ => Err(Refusal::Error(failure)),
    }
}

async fn ssh_login(conn: &Conn) -> Result<client::Handle<Pinning>, Refusal> {
    let mut session = ssh_connect(conn).await?;
    let secret = read_secret(&conn.server_id)?;
    let user = conn.username.clone();
    let ok = if conn.auth == "key" {
        let candidates = key_candidates(conn.key_path.as_deref());
        if candidates.is_empty() {
            return Err(Refusal::Error("No SSH key to try: set its path on the server, or create one with ssh-keygen.".into()));
        }
        let hash = session.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
        let mut accepted = false;
        let mut last = String::new();
        for path in candidates {
            let key = match load_secret_key(&path, secret.as_deref()) {
                Ok(k) => k,
                Err(e) => {
                    last = if secret.is_none() && e.to_string().to_lowercase().contains("encrypt") {
                        format!("{} is protected by a passphrase. Save it on the server.", path.display())
                    } else {
                        format!("{}: {e}", path.display())
                    };
                    continue;
                }
            };
            let res = session
                .authenticate_publickey(user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| e.to_string())?;
            if res.success() {
                accepted = true;
                break;
            }
            last = format!("The server refused the key {}.", path.display());
        }
        if !accepted && !last.is_empty() {
            return Err(Refusal::Error(last));
        }
        accepted
    } else {
        let Some(password) = secret else {
            return Err(Refusal::Error("No password is saved for this server.".into()));
        };
        let plain = session
            .authenticate_password(user.clone(), password.clone())
            .await
            .map_err(|e| e.to_string())?
            .success();
        // plenty of servers turn the `password` method off and ask the same
        // question through keyboard-interactive instead
        plain || keyboard_interactive(&mut session, user, &password).await?
    };
    if !ok {
        return Err(Refusal::Error(format!("{} refused the login for {}.", conn.host, conn.username)));
    }
    Ok(session)
}

/// Answer every keyboard-interactive prompt with the password. A server that
/// asks more than a few rounds is asking for something else (a one-time code),
/// and that needs a person.
async fn keyboard_interactive(session: &mut client::Handle<Pinning>, user: String, password: &str) -> Result<bool, String> {
    use client::KeyboardInteractiveAuthResponse as Reply;
    let mut reply = session
        .authenticate_keyboard_interactive_start(user, None::<String>)
        .await
        .map_err(|e| e.to_string())?;
    for _ in 0..4 {
        match reply {
            Reply::Success => return Ok(true),
            Reply::Failure { .. } => return Ok(false),
            Reply::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                reply = session.authenticate_keyboard_interactive_respond(answers).await.map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(false)
}

async fn sftp_open(conn: &Conn) -> Result<(client::Handle<Pinning>, SftpSession), Refusal> {
    let session = ssh_login(conn).await?;
    let channel = session.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| e.to_string())?;
    Ok((session, sftp))
}

/* ----------------------------------- curl ---------------------------------- */

static SEQ: AtomicU32 = AtomicU32::new(0);

/// A curl config file holding the login, deleted when dropped. The password
/// goes here and not on the command line, where any process could read it.
struct CurlConfig {
    path: PathBuf,
}

impl CurlConfig {
    fn new(body: &str) -> Result<Self, String> {
        let name = format!("assay-curl-{}-{}.cfg", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed));
        // On Windows this is the per-user %LOCALAPPDATA%\Temp, whose inherited ACL
        // admits only the user, SYSTEM and Administrators; Unix gets 0600 below.
        let path = std::env::temp_dir().join(name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|e| e.to_string())?;
        file.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        Ok(Self { path })
    }
}

impl Drop for CurlConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Refuse a value curl's config parser or the FTP control channel would split:
/// a quoted `\n` comes back out of the parser as a real newline, so a path
/// carrying one could append its own FTP command (`DELE`, `RNFR`…).
fn config_safe<'a>(what: &str, value: &'a str) -> Result<&'a str, String> {
    if value.contains(['\r', '\n', '\0']) {
        return Err(format!("{what} contains a line break or NUL character; it was not sent."));
    }
    Ok(value)
}

/// A value inside a curl config file: quoted, with `\` and `"` escaped.
fn curl_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n"))
}

/// Percent-encode one path segment (RFC 3986 unreserved characters stay).
fn encode_segment(seg: &str) -> String {
    let mut out = String::new();
    for b in seg.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `ftp://host:21/%2Fvar/www/css/site.css`. An FTP URL path is relative to the
/// login directory, so an absolute remote path starts with an encoded slash.
pub fn ftp_url(host: &str, port: u16, remote: &str) -> String {
    let absolute = remote.starts_with('/');
    let segments: Vec<String> = remote.split('/').filter(|s| !s.is_empty()).map(encode_segment).collect();
    let lead = if absolute { "%2F" } else { "" };
    let host = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    format!("ftp://{host}:{port}/{lead}{}", segments.join("/"))
}

fn curl_login(conn: &Conn) -> Result<String, String> {
    let password = read_secret(&conn.server_id)?.unwrap_or_default();
    let user = format!("{}:{}", conn.username, password);
    let mut body = format!("user = {}\n", curl_quote(config_safe("The user name or password", &user)?));
    if conn.protocol == "ftps" {
        body.push_str("ssl-reqd\n");
    }
    body.push_str("silent\nshow-error\nconnect-timeout = 20\n");
    Ok(body)
}

fn run_curl(config: &CurlConfig) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("curl");
    cmd.arg("-K").arg(&config.path).stdin(Stdio::null());
    hide_window(&mut cmd);
    cmd.output().map_err(|e| format!("curl could not start: {e}"))
}

fn curl_error(out: &std::process::Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.is_empty() {
        format!("curl exited with {}", out.status.code().unwrap_or(-1))
    } else {
        err
    }
}

/* ---------------------------------- test ----------------------------------- */

/// Connect, log in and list the remote folder — nothing is written.
#[tauri::command]
pub async fn deploy_test(conn: Conn) -> Result<TestResult, String> {
    if conn.protocol == "sftp" {
        let (session, sftp) = match sftp_open(&conn).await {
            Ok(pair) => pair,
            Err(Refusal::Unknown(fingerprint)) => return Ok(TestResult::UnknownHost { fingerprint }),
            Err(Refusal::Changed { expected, got }) => {
                return Ok(TestResult::HostChanged { expected, fingerprint: got })
            }
            Err(Refusal::Error(e)) => return Err(e),
        };
        let target = if conn.remote_path.trim().is_empty() { "." } else { conn.remote_path.trim() };
        let listing = async {
            let cwd = sftp.canonicalize(target).await.map_err(|e| format!("{target}: {e}"))?;
            let mut entries: Vec<String> = sftp
                .read_dir(cwd.clone())
                .await
                .map_err(|e| format!("{cwd}: {e}"))?
                .map(|e| if e.file_type().is_dir() { format!("{}/", e.file_name()) } else { e.file_name() })
                .filter(|n| n != "./" && n != "../")
                .collect();
            entries.sort();
            entries.truncate(LIST_LIMIT);
            Ok::<_, String>(TestResult::Ok { cwd, entries })
        }
        .await;
        let _ = sftp.close().await;
        let _ = session.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        return listing;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut body = curl_login(&conn)?;
        let dir = format!("{}/", config_safe("The remote path", conn.remote_path.trim())?.trim_end_matches('/'));
        body.push_str("list-only\n");
        body.push_str(&format!("url = {}\n", curl_quote(&ftp_url(&conn.host, conn.port, &dir))));
        let config = CurlConfig::new(&body)?;
        let out = run_curl(&config)?;
        if !out.status.success() {
            return Err(curl_error(&out));
        }
        let mut entries: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && *l != "." && *l != "..")
            .map(str::to_string)
            .collect();
        entries.sort();
        entries.truncate(LIST_LIMIT);
        Ok(TestResult::Ok { cwd: conn.remote_path.clone(), entries })
    })
    .await
    .map_err(|e| e.to_string())?
}

/* --------------------------------- upload ---------------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job_id: String,
    path: String,
    /// "upload" | "delete"
    action: &'static str,
    done: usize,
    total: usize,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct Failure {
    path: String,
    error: String,
}

#[derive(Serialize, Default)]
pub struct UploadResult {
    uploaded: Vec<String>,
    deleted: Vec<String>,
    failed: Vec<Failure>,
    /// Stopped by the user before the list ran out.
    cancelled: bool,
}

/// Jobs running now, each with whether a stop was asked for. Only a running
/// job can be cancelled, so a late cancel never leaves an entry behind.
static JOBS: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);

fn is_cancelled(job: &str) -> bool {
    JOBS.lock().ok().and_then(|s| s.as_ref().and_then(|jobs| jobs.get(job).copied())).unwrap_or(false)
}

/// A job's entry in `JOBS`, removed however the job ends (error and panic included).
struct JobGuard(String);

impl JobGuard {
    fn start(job: &str) -> Self {
        if let Ok(mut s) = JOBS.lock() {
            s.get_or_insert_with(HashMap::new).insert(job.to_string(), false);
        }
        Self(job.to_string())
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = JOBS.lock() {
            if let Some(jobs) = s.as_mut() {
                jobs.remove(&self.0);
            }
        }
    }
}

/// Stop an upload between two files. A file halfway through is finished first.
#[tauri::command]
pub fn deploy_cancel(job_id: String) {
    if let Ok(mut s) = JOBS.lock() {
        if let Some(flag) = s.as_mut().and_then(|jobs| jobs.get_mut(&job_id)) {
            *flag = true;
        }
    }
}

struct Reporter<R: Runtime> {
    app: AppHandle<R>,
    job_id: String,
    total: usize,
    done: usize,
}

impl<R: Runtime> Reporter<R> {
    fn step(&mut self, path: &str, action: &'static str, error: Option<String>) {
        self.done += 1;
        let _ = self.app.emit(
            "deploy://progress",
            Progress { job_id: self.job_id.clone(), path: path.to_string(), action, done: self.done, total: self.total, error },
        );
    }
}

async fn sftp_mkdirs(sftp: &SftpSession, remote_root: &str, rel_dir: &str, made: &mut HashSet<String>) -> Result<(), String> {
    let mut current = remote_root.trim_end_matches('/').to_string();
    for seg in rel_dir.split('/').filter(|s| !s.is_empty()) {
        current = remote_join(&current, seg);
        if made.contains(&current) {
            continue;
        }
        if !sftp.try_exists(current.clone()).await.unwrap_or(false) {
            sftp.create_dir(current.clone()).await.map_err(|e| format!("mkdir {current}: {e}"))?;
        }
        made.insert(current.clone());
    }
    Ok(())
}

async fn sftp_put(sftp: &SftpSession, local: &Path, remote: &str) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut source = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
    let mut target = sftp.create(remote.to_string()).await.map_err(|e| e.to_string())?;
    tokio::io::copy(&mut source, &mut target).await.map_err(|e| e.to_string())?;
    target.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn upload_sftp<R: Runtime>(
    conn: &Conn,
    base: &Path,
    files: &[String],
    deletes: &[String],
    report: &mut Reporter<R>,
) -> Result<UploadResult, String> {
    let (session, sftp) = match sftp_open(conn).await {
        Ok(pair) => pair,
        Err(Refusal::Unknown(_)) => return Err("This server's host key has not been accepted yet. Test the connection first.".into()),
        Err(Refusal::Changed { expected, got }) => {
            return Err(format!("The server's host key changed ({got}, accepted {expected}). Nothing was uploaded."))
        }
        Err(Refusal::Error(e)) => return Err(e),
    };
    let mut result = UploadResult::default();
    let mut made = HashSet::new();
    let root = conn.remote_path.trim();
    for rel in files {
        if is_cancelled(&report.job_id) {
            result.cancelled = true;
            break;
        }
        let outcome = match local_path(base, rel) {
            Ok(local) => {
                let remote = remote_join(root, rel);
                let dir = rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
                match sftp_mkdirs(&sftp, root, dir, &mut made).await {
                    Ok(()) => sftp_put(&sftp, &local, &remote).await,
                    Err(e) => Err(e),
                }
            }
            Err(e) => Err(e),
        };
        match outcome {
            Ok(()) => {
                result.uploaded.push(rel.clone());
                report.step(rel, "upload", None);
            }
            Err(error) => {
                report.step(rel, "upload", Some(error.clone()));
                result.failed.push(Failure { path: rel.clone(), error });
            }
        }
    }
    for rel in deletes {
        if result.cancelled || is_cancelled(&report.job_id) {
            result.cancelled = true;
            break;
        }
        if let Err(error) = checked_rel(rel) {
            report.step(rel, "delete", Some(error.clone()));
            result.failed.push(Failure { path: rel.clone(), error });
            continue;
        }
        match sftp.remove_file(remote_join(root, rel)).await {
            Ok(()) => {
                result.deleted.push(rel.clone());
                report.step(rel, "delete", None);
            }
            Err(e) => {
                let error = e.to_string();
                // already gone is the outcome that was asked for
                if error.to_lowercase().contains("no such file") {
                    result.deleted.push(rel.clone());
                    report.step(rel, "delete", None);
                } else {
                    report.step(rel, "delete", Some(error.clone()));
                    result.failed.push(Failure { path: rel.clone(), error });
                }
            }
        }
    }
    let _ = sftp.close().await;
    let _ = session.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    Ok(result)
}

/// The `upload-file` / `url` pair for one file, or why it cannot be sent.
fn ftp_upload_entry(conn: &Conn, base: &Path, root: &str, rel: &str) -> Result<String, String> {
    let rel = config_safe(rel, checked_rel(rel)?)?;
    let local = local_path(base, rel)?.to_string_lossy().into_owned();
    let local = config_safe(&local, &local)?;
    let url = ftp_url(&conn.host, conn.port, &remote_join(root, rel));
    Ok(format!("upload-file = {}\nurl = {}\n", curl_quote(local), curl_quote(&url)))
}

/// The curl config that deletes one remote file with `DELE`, or why it cannot be built.
fn ftp_delete_config(conn: &Conn, login: &str, root: &str, rel: &str) -> Result<String, String> {
    let rel = config_safe(rel, checked_rel(rel)?)?;
    let remote = remote_join(root, rel);
    let (dir, name) = remote.rsplit_once('/').unwrap_or(("", remote.as_str()));
    let mut body = login.to_string();
    body.push_str("head\n");
    body.push_str(&format!("quote = {}\n", curl_quote(&format!("DELE {name}"))));
    body.push_str(&format!("url = {}\n", curl_quote(&ftp_url(&conn.host, conn.port, &format!("{dir}/")))));
    Ok(body)
}

fn upload_ftp<R: Runtime>(
    conn: &Conn,
    base: &Path,
    files: &[String],
    deletes: &[String],
    report: &mut Reporter<R>,
) -> Result<UploadResult, String> {
    let login = curl_login(conn)?;
    let root = config_safe("The remote path", conn.remote_path.trim())?;
    let mut result = UploadResult::default();

    for batch in files.chunks(FTP_BATCH) {
        if is_cancelled(&report.job_id) {
            result.cancelled = true;
            break;
        }
        let mut body = login.clone();
        body.push_str("ftp-create-dirs\n");
        // one line per transfer, in order: the only per-file answer curl gives
        body.push_str("write-out = \"%{response_code}\\t%{errormsg}\\n\"\n");
        // a file refused here fails on its own; the write-out lines then map onto `sent`
        let mut sent: Vec<&String> = Vec::with_capacity(batch.len());
        for rel in batch {
            match ftp_upload_entry(conn, base, root, rel) {
                Ok(entry) => {
                    body.push_str(&entry);
                    sent.push(rel);
                }
                Err(error) => {
                    report.step(rel, "upload", Some(error.clone()));
                    result.failed.push(Failure { path: rel.clone(), error });
                }
            }
        }
        if sent.is_empty() {
            continue;
        }
        let config = CurlConfig::new(&body)?;
        let mut cmd = Command::new("curl");
        cmd.arg("-K").arg(&config.path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        hide_window(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("curl could not start: {e}"))?;
        let stdout = child.stdout.take().ok_or("curl gave no output")?;
        // stderr drains on its own thread: read after stdout, a chatty curl could
        // fill that pipe and block before ever closing stdout
        let stderr_reader = child.stderr.take().map(|mut e| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let _ = e.read_to_end(&mut bytes);
                String::from_utf8_lossy(&bytes).into_owned()
            })
        });
        let mut answered = 0;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some(&rel) = sent.get(answered) else { break };
            answered += 1;
            let (code, msg) = line.split_once('\t').unwrap_or((line.as_str(), ""));
            let ok = code.starts_with('2') && msg.trim().is_empty();
            if ok {
                result.uploaded.push(rel.clone());
                report.step(rel, "upload", None);
            } else {
                let error = if msg.trim().is_empty() { format!("FTP answered {code}") } else { msg.trim().to_string() };
                report.step(rel, "upload", Some(error.clone()));
                result.failed.push(Failure { path: rel.clone(), error });
            }
        }
        let stderr = stderr_reader.and_then(|h| h.join().ok()).unwrap_or_default();
        let _ = child.wait();
        // a batch curl never reached (login refused, host down) fails as a whole
        for &rel in &sent[answered..] {
            let error = if stderr.trim().is_empty() { "curl stopped before this file".to_string() } else { stderr.trim().to_string() };
            report.step(rel, "upload", Some(error.clone()));
            result.failed.push(Failure { path: rel.clone(), error });
        }
    }

    for rel in deletes {
        if result.cancelled || is_cancelled(&report.job_id) {
            result.cancelled = true;
            break;
        }
        let outcome = ftp_delete_config(conn, &login, root, rel)
            .and_then(|body| CurlConfig::new(&body))
            .and_then(|config| run_curl(&config));
        match outcome {
            Ok(out) if out.status.success() => {
                result.deleted.push(rel.clone());
                report.step(rel, "delete", None);
            }
            Ok(out) => {
                let error = curl_error(&out);
                report.step(rel, "delete", Some(error.clone()));
                result.failed.push(Failure { path: rel.clone(), error });
            }
            Err(error) => {
                report.step(rel, "delete", Some(error.clone()));
                result.failed.push(Failure { path: rel.clone(), error });
            }
        }
    }
    Ok(result)
}

/// Upload `files` and delete `deletes` (both relative to `root/local_dir`),
/// reporting each one on `deploy://progress`. A file that fails does not stop
/// the others; the result says which went and which did not.
#[tauri::command]
pub async fn deploy_upload<R: Runtime>(
    app: AppHandle<R>,
    job_id: String,
    conn: Conn,
    root: String,
    local_dir: String,
    files: Vec<String>,
    deletes: Vec<String>,
) -> Result<UploadResult, String> {
    let base = deploy_base(&root, &local_dir);
    // held to the end of this function, so the job's cancel flag goes with it
    let _job = JobGuard::start(&job_id);
    let mut report = Reporter { app, job_id, total: files.len() + deletes.len(), done: 0 };
    if conn.protocol == "sftp" {
        upload_sftp(&conn, &base, &files, &deletes, &mut report).await
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            let mut report = report;
            upload_ftp(&conn, &base, &files, &deletes, &mut report)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex(p: &[&str]) -> Excludes {
        Excludes::new(&p.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn a_bare_name_matches_any_segment() {
        let e = ex(&["node_modules", "*.log", ".env*"]);
        assert!(e.matches("node_modules/a/b.js"));
        assert!(e.matches("app/node_modules/x"));
        assert!(e.matches("logs/today.log"));
        assert!(e.matches(".env.production"));
        assert!(!e.matches("src/environment.ts"));
        assert!(!e.matches("src/index.ts"));
    }

    #[test]
    fn a_pattern_with_a_slash_is_rooted() {
        let e = ex(&["/dist", "public/uploads/", "**/cache/*.tmp"]);
        assert!(e.matches("dist/app.js"));
        assert!(!e.matches("src/dist/app.js"));
        assert!(e.matches("public/uploads/a.png"));
        assert!(e.matches("a/b/cache/x.tmp"));
        assert!(!e.matches("public/index.html"));
    }

    #[test]
    fn comments_and_blanks_are_ignored() {
        let e = ex(&["# nothing", "   ", ""]);
        assert!(!e.matches("anything"));
    }

    #[test]
    fn remote_paths_join_with_one_slash() {
        assert_eq!(remote_join("/var/www/", "css/a.css"), "/var/www/css/a.css");
        assert_eq!(remote_join("/var/www", "/a"), "/var/www/a");
        assert_eq!(remote_join("", "a"), "a");
        assert_eq!(remote_join("/srv", ""), "/srv");
    }

    #[test]
    fn ftp_urls_keep_absolute_paths_absolute() {
        assert_eq!(ftp_url("example.com", 21, "/var/www/a b.css"), "ftp://example.com:21/%2Fvar/www/a%20b.css");
        assert_eq!(ftp_url("example.com", 2121, "public_html/x"), "ftp://example.com:2121/public_html/x");
        assert_eq!(ftp_url("::1", 21, "/x"), "ftp://[::1]:21/%2Fx");
    }

    #[test]
    fn curl_values_are_quoted() {
        assert_eq!(curl_quote(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    fn ftp_conn() -> Conn {
        Conn {
            server_id: "test".into(),
            protocol: "ftp".into(),
            host: "example.com".into(),
            port: 21,
            username: "u".into(),
            auth: "password".into(),
            key_path: None,
            remote_path: "/www".into(),
            host_key: None,
        }
    }

    #[test]
    fn config_values_with_line_breaks_are_refused() {
        assert!(config_safe("p", "a/b c.txt").is_ok());
        for bad in ["a\nDELE x", "a\r\nQUIT", "a\rb", "a\0b"] {
            assert!(config_safe("p", bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_delete_never_carries_a_second_ftp_command() {
        let conn = ftp_conn();
        assert!(ftp_delete_config(&conn, "", "/www", "a\nDELE index.php").is_err());
        assert!(ftp_delete_config(&conn, "", "/www", "a\r\nRMD /www").is_err());
        let body = ftp_delete_config(&conn, "", "/www", "css/a.css").unwrap();
        assert!(body.contains("quote = \"DELE a.css\"\n"));
        assert_eq!(body.lines().filter(|l| l.starts_with("quote")).count(), 1);
    }

    #[test]
    fn an_upload_entry_refuses_line_breaks_in_any_path() {
        let conn = ftp_conn();
        let base = Path::new("project");
        assert!(ftp_upload_entry(&conn, base, "/www", "a\nquote = DELE x").is_err());
        assert!(ftp_upload_entry(&conn, Path::new("pro\nject"), "/www", "a.css").is_err());
        let entry = ftp_upload_entry(&conn, base, "/www", "css/a.css").unwrap();
        assert_eq!(entry.lines().count(), 2);
        assert!(entry.contains("url = \"ftp://example.com:21/%2Fwww/css/a.css\""));
    }

    #[test]
    fn relative_paths_stay_inside_the_base() {
        for good in ["a.css", "css/a.css", "deep/er/x.min.js", "..hidden", "a..b/c"] {
            assert!(checked_rel(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "..",
            "../x",
            "a/../../x",
            "a\\..\\x",
            "/etc/passwd",
            "\\windows\\x",
            "C:/x",
            "C:x",
            "c:\\x",
            "\\\\server\\share\\x",
            "./x",
        ] {
            assert!(checked_rel(bad).is_err(), "{bad}");
        }
        assert_eq!(local_path(Path::new("base"), "css/a.css").unwrap(), Path::new("base").join("css/a.css"));
        assert!(local_path(Path::new("base"), "../x").is_err());
    }

    #[test]
    fn cancel_applies_only_to_a_running_job() {
        deploy_cancel("not-running".into());
        assert!(!is_cancelled("not-running"));
        {
            let _job = JobGuard::start("running");
            assert!(!is_cancelled("running"));
            deploy_cancel("running".into());
            assert!(is_cancelled("running"));
        }
        // the entry left with the job
        assert!(!is_cancelled("running"));
        let left = JOBS.lock().unwrap().as_ref().map_or(0, |jobs| jobs.len());
        assert_eq!(left, 0);
    }
}
