# Contributing to Assay

Thanks for your interest. Bug reports, ideas and pull requests are all welcome. By taking part you
agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs** — open an issue with the bug report template. Include your OS, the Assay version and the
  steps to reproduce.
- **Features** — open an issue first and describe the problem it solves. Agreeing on the approach
  before writing code saves everyone a rewrite.
- **Security issues** — never in a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 20.19+ (22 recommended), pnpm 10, Rust stable, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (MSVC build tools and
WebView2 on Windows, Xcode command line tools on macOS, webkit2gtk on Linux).

```bash
pnpm install
pnpm tauri dev      # the real app
pnpm dev            # the frontend alone in a browser, without Tauri APIs
```

Editing frontend source while `pnpm tauri dev` runs reloads the webview, which cancels in-flight
scans. Workspace terminals survive the reload.

## Checks

CI runs all of these on every pull request; run them locally first:

```bash
pnpm typecheck
pnpm test
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## Rules

[AGENTS.md](AGENTS.md) holds the architecture and the reasoning behind it. The rules that matter
most for a pull request:

- **TypeScript strict, never `any`.** Explicit types at module boundaries.
- **No new dependency without discussing it in an issue first.** Assay runs security tooling, so
  every dependency is supply chain. `pnpm-workspace.yaml` enforces a minimum release age and a trust
  policy; never relax them to get an install through.
- **Only the user's own targets.** Integrations and defaults must target the user's own projects.
  URL actions stay behind the authorization confirmation.
- **Never write into the scanned project.** Linters run from Assay's sandbox with a generated config.
- **Design tokens, not raw colors.** Colors, radii and spacing come from `src/styles/globals.css`
  and [docs/design/DESIGN.md](docs/design/DESIGN.md).
- **Every user-facing string goes through `t()`.** The key is the English sentence; add the Spanish
  translation to `src/i18n/es.ts`. Never translate what a tool printed.
- **Long-running work streams.** Never block the UI on a process.
- **No native `alert`, `confirm` or `prompt`.** Use the app's dialog components.

### Adding a tool

A tool is a row in the registry plus an adapter in `src/lib/adapters.ts` that turns its output
into findings. Add a fixture in the shape the tool really prints and a test for the adapter in
`src/lib/__tests__/adapters.test.ts`. Every finding passes through `db.normalizeFinding`.

## Commits and pull requests

- Commits use [gitmoji](https://gitmoji.dev/) + [Conventional Commits](https://www.conventionalcommits.org/),
  subject line only, in English: `✨ feat(tools): add nuclei adapter`, `🐛 fix(deploy): retry after
  a dropped connection`.
- One topic per pull request. Fill in the template, link the issue, and add a screenshot for any UI
  change.
- Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would
  notice.

## Releases

Maintainers only:

```bash
pnpm version:bump 0.2.0     # syncs package.json, tauri.conf.json, Cargo.toml/lock, CHANGELOG
# edit the release notes in CHANGELOG.md, then:
git add -A && git commit -m "🔖 chore(release): v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
git push origin main --follow-tags
```

The `v*` tag triggers the release workflow, which builds the Windows, macOS and Linux installers
and attaches them to a draft release. Review the draft, paste the changelog section, and publish.

## License

By contributing, you agree that your contributions are licensed under the
[GPL-3.0-only](LICENSE) license of the project.
