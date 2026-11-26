# Changelog

All notable changes to Assay are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, a minor
release may contain breaking changes.

## [Unreleased]

### Added

- Workspace › Ports: the ports a project is serving, detected from its terminals, plus ports added
  by hand, each one a click from a public link through a cloudflared quick tunnel. Every link
  confirms first, is copied when ready, and closes on Stop, when its port goes quiet, or on quit.
- cloudflared in Settings › Tools › Toolchain, installable with winget or brew.
- Self-update from GitHub Releases: a header chip when a new version is published, release notes,
  and install now or when Assay quits. Signed with minisign; checks can be turned off in
  Settings › General. Copies installed from `.deb` or `.rpm` are pointed to the release page.
- Copies already on 0.1.0 have no updater yet: this version has to be installed by hand once.

## [0.1.0] - 2026-11-22

First open-source release.

### Added

- Projects: local folders and URLs, stack detection, tags, last-use ordering, cloning from a linked
  GitHub account (OAuth device flow).
- Tools: ESLint and Ruff from Assay's own sandbox, Semgrep, Gitleaks, OSV Scanner, React Doctor,
  SonarQube (Docker or own server), graphify, Unlighthouse and Strix, with per-tool options.
- Findings: normalized by severity, triage that survives rescans, AI fix loop with retest, SARIF and
  Markdown export.
- Workspace: PTY terminals, Monaco editor, file tree with git status, content search, Git panel,
  Claude Code sessions, project scripts, Claude plan limits and context in the status bar.
- Deploy: SFTP, FTP and FTPS with change detection, host key pinning, OS keychain and auto-upload.
- Audit trail of every run, skills and commands, AI per task (Claude, opencode, Hermes, Ollama,
  LM Studio), scheduled scans, system notifications.
- English and Spanish interface.
- Installers for Windows (NSIS), macOS (universal `.dmg`) and Linux.

### Security

- Downloads of ruff, osv-scanner and gitleaks are verified against the SHA-256 their release
  publishes before they run.
- Deploy refuses paths outside the deploy folder, and FTP refuses file names with line breaks that
  could inject FTP commands.
- The managed SonarQube container listens on `127.0.0.1` only and never keeps `admin/admin`.
- External terminals quote commands correctly on macOS and Linux; content search never puts the
  query on a shell command line; a resumed Claude session id is validated before it reaches a shell.

### Fixed

- Revert after **Fix with AI** undoes only the agent's changes, never uncommitted work that was
  there before, and includes files the agent created.
- Fix no longer skips findings beyond the 40th file of a batch.
- Terminal output keeps multi-byte characters intact across reads; closing a terminal no longer
  freezes the others.
- **Save & close** keeps the tab open when the save fails; **Cancel** after **Test connection**
  never leaves a changed deploy password; reload is blocked while files have unsaved changes.
- Switching projects never shows the previous project's findings, skills or run details; the
  findings table resets to a valid page when filtering; the selection clears on project or filter
  change.
- Pull request links work for GitLab and Bitbucket; a 403 from the remote no longer spends a GitHub
  token renewal; git, deploy and file-manager errors are shown instead of failing silently.
- Markdown export keeps multi-line messages inside the table; build checks only offer `make build`
  when the target exists.
- The app version is read from the build instead of a fixed `v0.1`.

### Performance

- Project, skill, tool, run and window components subscribe to the fields they show, so a running
  scan no longer re-renders the whole interface on every log line.
- Project cards share one query; skill cards share one agent probe; the Deploy panel scans once.

### Removed

- The built-in `sane-stack` skill.

[Unreleased]: https://github.com/develoverli/assay-code/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/develoverli/assay-code/releases/tag/v0.1.0
