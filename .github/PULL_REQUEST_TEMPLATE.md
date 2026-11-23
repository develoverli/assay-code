## What and why

<!-- What this changes and the problem it solves. Link the issue: Closes #123 -->

## How it was tested

<!-- Steps you followed, platform(s) you ran it on. Add a screenshot for UI changes. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` pass
- [ ] `cargo check` and `cargo clippy -- -D warnings` pass (if Rust changed)
- [ ] New user-facing strings go through `t()` and have a Spanish entry in `src/i18n/es.ts`
- [ ] No new dependency, or it was agreed in an issue first
- [ ] Nothing new writes into the scanned project or targets a third party
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` if users will notice the change
