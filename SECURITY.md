# Security Policy

Assay runs scanners and AI agents on your machine, stores tokens (GitHub, SonarQube) in a local
SQLite database and deploy passwords in the OS keychain. Vulnerabilities in any of that matter, and
reports are welcome.

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
|---|---|
| latest release | ✅ |
| older releases | ❌ |

## Reporting a vulnerability

**Do not open a public issue.** Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/develoverli/assay-code/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version and platform, and the steps to reproduce it.

You should get an acknowledgement within 7 days. Once the issue is confirmed, a fix is prepared in
a private fork and released, and the advisory is published with credit to you unless you prefer
otherwise.

## Scope

In scope:

- Code execution, path traversal or privilege escalation through the app, its Tauri commands or its
  capability scopes
- Secrets (tokens, passwords, keys) leaking to disk, logs, the command line, the webview or the
  network
- Writes into a scanned project beyond what the user explicitly asked for
- SSH host key verification or TLS bypasses in Deploy

Out of scope:

- Vulnerabilities in the third-party tools Assay runs (ESLint, Semgrep, Strix…) — report those
  upstream
- Findings that require an attacker who already controls the user's machine or account
- Using Assay against targets you do not own or are not authorized to test
