# Assay — build, check and ship your own projects

Desktop app (Tauri 2) to take your own projects from first line to production in one place: real
terminals and an editor over the working tree, the linters, scanners and ethical-pentest tools you
trust, and AI agents — local models or cloud ones — that fix what those tools find.
No server, no account: everything runs on the user's machine, over code and targets the user owns.
Open source under GPL-3.0-only (`LICENSE`); contributor guide in `CONTRIBUTING.md`.

## Stack

- **Tauri 2** (Rust shell) + **Vite 7** + **React 19** + **TypeScript strict** + **Tailwind 4**
- **SQLite** via `tauri-plugin-sql` — `assay.db`, migrations in `src-tauri/migrations/`
- **zustand** for state, **Radix UI** primitives, **lucide-react** icons
- **monaco-editor** (Bench editor), **@xterm/xterm** + **@xterm/addon-fit** (Bench terminals)
- **portable-pty** (Rust) — real PTYs, so interactive agents run inside the app
- **sysinfo** (Rust) — the status bar's memory reading
- **tauri-plugin-notification** — system notifications when a run finishes
- **tauri-plugin-clipboard-manager** — the clipboard behind the terminals, Rust side only: its
  commands are invoked directly, so there is no npm wrapper in `package.json`
- **russh** + **russh-sftp** (SFTP) and **keyring** (OS keychain) — Deploy, Rust side only
- **tauri-plugin-updater** + **tauri-plugin-process** — self-update from GitHub Releases and the
  relaunch after it
- **vitest** — unit tests for the pure logic (adapters, tokenizer, config builder)
- **pnpm** package manager. Never npm or yarn.
- **No i18n library**: `lib/i18n.ts` plus one dictionary per language

Entry: `index.html` → `src/main.tsx` → `src/App.tsx` → `AppShell`.
There is no Next.js, no App Router, no server routes. Rendering is client-side inside the webview.

## Structure

```
src/
  App.tsx                  boot: init store, then AppShell
  components/
    layout/AppShell.tsx    sidebar (Ctrl+B to fold) + header + view switch
    layout/WindowChrome.tsx custom titlebar, close-to-tray, quit/reload guards
    layout/StatusBar.tsx   thin bottom line: Claude's plan limits and context (ClaudeUsage.tsx)
                           on the left, memory Assay is using right now on the right; not
                           mounted on Workspace, whose footer carries both
    RunDock.tsx            in-flow bar of active runs
    RunWindow.tsx          floating log of the selected run
    ui/                    primitives, dialog, data-table, severity, terminal
  features/                one folder per view: projects, tools, findings, bench, audit,
                           skills, commands, processes, stats, settings, shared; plus ports
                           (Workspace's Ports panel) and updates (the header's update chip)
  lib/
    exec.ts                spawn tools via tauri-plugin-shell, stream stdout/stderr
    runner.ts              run orchestration (start, stream, persist)
    db.ts                  SQLite queries + the finding normalization rule
    adapters.ts            tool output -> normalized findings
    importers.ts           import reports produced outside the app
    detect.ts              detect installed tools / project type
    sonar.ts               SonarQube integration
    sandbox.ts             Assay's own linter install in appdata (ESLint, Ruff)
    graphify.ts            the project's knowledge graph: state, headless commands, install
    export.ts              findings out as SARIF or Markdown
    notify.ts              system notifications, off until asked for
    schedule.ts            unattended scans on an interval
    tool-options.ts        per-tool option schemas + generated ESLint flat config
    ai.ts, agent-stream.ts the AI per task, what can answer (inventory), one-shot runs, AI fix loop
    agent-bins.ts          where claude / opencode / hermes / ollama / lms / cloudflared live,
                           PATH or not
    toolchain.ts           what Assay needs on the machine, and the recipe that installs each
    local-models.ts        local model discovery (Ollama & friends)
    pty.ts                 front half of the Rust PTY sessions
    agent-signals.ts       Claude's Stop hook and status line, as events per terminal
    claude-limits.ts       how plan limits read in the status bar (tone, reset, countdown)
    tab-order.ts           the Workspace tab strip in the user's order
    scripts.ts             the project's own scripts (package.json, Cargo, Makefile, composer)
    bench-term.ts          shell detection + terminal launchers (Claude, OpenCode, Hermes)
    clipboard.ts           copy/paste that survives the webview, for terminals and text fields
    file-drop.ts           desktop files dropped on the workspace, by zone
    dates.ts               relative and absolute times in the app's language
    harden.ts              production-only: no webview reload, menu or devtools keys
    fs-tree.ts             lazy project tree, name search, open/save guards, language mapping
    git.ts                 git: branch, working tree, commits, per-file status, and the writes a
                           button asks for
    deploy.ts              Deploy: sftp.json in and out, the change list, the calls into deploy.rs
    ports.ts               Ports: which rows a project shows, when a quiet link closes, the calls
    updater.ts             self-update: settings, intervals, install kind, release links
    sessions.ts            Claude Code transcripts on disk for a project
    code-search.ts         content search via ripgrep / git grep / grep, whichever exists
    monaco.ts              Monaco workers + the theme built from the design tokens
    i18n.ts                language state, `useT()` in components, `tr()` outside React
    tray.ts                system tray icon and menu
    window-frame.ts        frame detection and styling shared by the chrome
    run-view.ts, verify.ts, utils.ts
  store/                   app.ts (projects, runs, findings), ui.ts (view, selection),
                           bench.ts (terminals, open files and git status, per project),
                           claude-usage.ts (plan limits and context per terminal),
                           deploy.ts (servers, pending changes, uploads, folder watchers),
                           ports.ts (listening ports, hand-added ports, public links),
                           updater.ts (the version found, download, install now or on quit)
  i18n/es.ts               Spanish dictionary (English is the key, so it needs none)
  styles/globals.css       design tokens (dark-first) + frame styling
src-tauri/
  src/lib.rs               plugin registration + migrations + PTY commands
  src/pty.rs               PTY sessions that outlive the webview
  src/agent_signals.rs     the folder Claude's hook and status line write into, and its watcher
  src/usage.rs             memory of this process plus its webview children
  src/clipboard.rs         clipboard images to a PNG on disk, and copied file paths
  src/sessions.rs          agent transcripts summarised without loading them into the UI
  src/deploy.rs            Deploy: disk scan and hashes, SFTP (russh), FTP/FTPS (curl), keychain
  src/ports.rs             listening TCP ports (netstat / lsof / ss) and the project each belongs to
  src/tunnel.rs            cloudflared quick tunnels that outlive the webview and die with the app
  capabilities/default.json permission scopes
  migrations/*.sql         schema
docs/design/               PRODUCT.md + DESIGN.md (design system source of truth)
scripts/bump-version.mjs   one version across package.json, tauri.conf.json, Cargo.toml/lock, CHANGELOG
```

## Rules

1. **TypeScript strict, never `any`.** Explicit types at module boundaries.
2. **No new dependency without asking.** The tool surface is a security product; every dep is
   supply chain. `pnpm-workspace.yaml` enforces a `minimumReleaseAge` and a trust policy — never
   relax them to get an install through.
3. **Only the user's own targets.** The app runs scanners over folders and URLs the user owns.
   Nothing in the codebase targets third parties.
4. **No secrets in the repo.** Tokens live in the SQLite DB on the user's machine, never in git.
   Bench opens a real `.env` read-only.
5. **Design tokens, not raw hex.** Colors, radii, and spacing come from `styles/globals.css`
   and `docs/design/DESIGN.md`. Monaco and xterm read the same tokens at runtime.
6. **Long-running work streams.** A scan reports progress line by line; never block the UI on a
   process.
7. **Every finding says something.** `db.normalizeFinding` is the single gate: a message is
   mandatory (rebuilt from the category when an adapter leaves it empty, dropped if even that is
   empty), paths are relative and slash-separated, and a line is kept only when it is positive and
   attached to a file. Findings with no file are labelled `project` / `site`, never blank.
7c. **The fix agent runs against hard limits, not good intentions.** `runner.fixPrompt` states them:
   only files a finding points at, never a suppression comment or a weakened test, no dependency or
   config changes, no renames or API changes, no destructive commands, and skip anything it isn't
   sure about. Verifying after a fix is opt-in.
7b. **A decision about a finding outlives the scan.** `fingerprintOf` (tool + rule + file +
   digit-normalised message, deliberately without the line number) is its identity; ignoring or
   accepting one is stored against that fingerprint and re-applied by `insertFindings` on the next
   scan. Fix never touches anything the user dismissed.
8. **Never write into the audited project.** Linters run from Assay's own sandbox
   (`%APPDATA%/…/linters`) with a generated config; the scanned repo gets no config, dependency or
   lockfile.
9. **Every user-facing string goes through `t()`.** The key is the English sentence, so an
   untranslated string still renders correctly. Never translate what a tool printed — a finding's
   message, a command, a rule id and a path stay exactly as the tool wrote them.
10. **Editing source during `tauri dev` reloads the webview** (Vite's watcher), which kills in-flight
   runs. Bench survives it: the PTYs live in Rust and `restoreTerminals()` picks them back up from
   `pty_list` on mount. Runs do not — finish or cancel them first.

## Project tags

The user's own labels, because a list of thirty projects says nothing about what any of them is.
`tags` and `project_tags` (migration 008) rather than a JSON column: a tag is renamed, recoloured and
deleted as one thing, and a unique index on `lower(name)` refuses a second "Frontend" — two spellings
of one word are one tag to the person reading the list. `lib/tags.ts` holds the decisions:
`filterByTags` is **OR** across the picked tags (an AND of two categories is empty almost always),
`groupByTag` lists a project under every tag it carries and puts the untagged ones last, and
`tagNameError` turns the index's constraint into a sentence before SQLite has to raise it.

Colour comes from nine `--color-tag-*` tokens in `globals.css`, deliberately apart from the severity
palette — a red tag is a category, not a critical finding — and a pill always shows the **name** next
to the dot, since colour alone says nothing to a reader who cannot separate amber from green.

Projects is where all of it lives: the filter bar (a **Tags** menu with a checkbox per tag, a
**GitHub** menu that narrows the list to the account a project was cloned from — one at a time,
counted, `All accounts` to lift it — a `Group by tag` toggle, `Manage tags`; both live in
`features/projects/ProjectFilters` and the bar appears with the first tag or the first clone),
the pills on each card, and the picker in the project dialog, which can create a tag on the spot —
a tag is born while looking at the project that needs it. The filter is session state in `store/ui`
(a question being asked now); grouping is stored (`ui.projectsGroupByTag`), because it is a way of
looking at the list. Deleting a tag removes the label and nothing else: `deleteTag` clears the join
rows itself rather than trusting a foreign key, since SQLite only enforces those when asked to.

## Project order and activity

The list of projects, in Projects and in the header switcher, is ordered by **last use**, not by
`updated_at`: renaming a project abandoned a year ago should not lift it above the one scanned this
morning. `last_used_at` (migration 009, backfilled from each project's newest run) moves only on
real work — a run started by hand, which every entry point routes through `track`, and a terminal
or agent opened in Workspace (`newTerminal`). Selecting a project is looking, not working, so it
does not count; neither does the scheduler, which passes `{ unattended: true }` through `scanAll`
and `scan` so `track` leaves the row alone. Never-used projects come after the used ones, newest
added first. `db.listProjects` orders that way in SQL, and `lib/project-activity.sortByLastUse`
applies the same rule in memory when `touchProject` lands, so the list answers before the write
does — which is also why the project Assay opens on at launch is the one worked on last. Grouping by
tag keeps the order inside each group, and `listAllProjects` (Stats, Audit) follows the same rule, so
a retired project sits where its last work left it. On top of that, the two lists put the projects
with something **going** first — `useOrderedProjects` partitions the store's order with `activeFirst`,
each half keeping its last-use order — because a list is read for what needs attention now, and an
idle project used an hour ago should not sit between two that have agents running. The partition is
keyed on `activeProjectKey`, one sorted string of ids, so it recomputes when a run or a terminal
starts or ends and not on every log chunk.

The same module counts what is live in a project — runs still `running`, terminals still `alive` —
and `features/projects/ProjectActivity` shows it on the card and on each row of the switcher: a
pulsing `accent` dot with the words beside it (`1 run · 2 terminals`), because a dot alone says
nothing to a reader who cannot tell accent from grey. The hook subscribes to the two **counts**, not
the arrays: the log stream mutates `runs` many times a second, and a number changes only when a run
starts or ends. Nothing is rendered when the project is quiet.

## Tables

`components/ui/data-table.tsx` wraps TanStack Table v9 (already a dependency) for the two long lists,
Findings and Audit: it owns sorting and paging, the views own the markup and the cells. Findings adds
a text filter over message/path/rule, select-all, bulk triage, and a row expansion that shows the
`raw.help` line the adapter recorded.

## Fix diffs and Revert

A fix records only what the agent changed. Before the agent runs, `runner` snapshots the working
tree into a tree object through a **temporary** index (`GIT_INDEX_FILE`, `git add -A`,
`git write-tree`); after it finishes it does the same and stores `git diff --binary <before>
<after>`. The user's index, stash and working tree are never touched, so uncommitted work the user
had before the fix is not in the patch, and Revert (`git apply -R`) cannot undo it. New and binary
files the agent creates are included.

## Reporting

`lib/export.ts` writes SARIF 2.1.0 (for GitHub code scanning and any CI that reads it; triage
decisions travel as `suppressions`) and Markdown (to paste into a pull request). Both export exactly
what is on screen — the tool's own words, plus the user's decision.

## Tests

`pnpm test` (vitest, node environment) covers the pure logic that breaks silently: every adapter
against a fixture in the shape its tool really prints, the command tokenizer, the generated ESLint
config, and the translator's fallback. CI (`.github/workflows/ci.yml`) runs typecheck, tests and
build on Windows, plus `cargo check` for the Rust half.

## Tools with options

A tool declares a schema in `lib/tool-options.ts` and Tools renders the checkboxes for it
generically; the answers are stored as JSON in `tools.config` (migration 005), global to the tool,
not per project. `runner.startLintScan` then makes the sandbox current and builds the real command,
so `tools.cmd` is only a preview for these.

- **ESLint** — rule groups (JS, TypeScript, type-aware, React + Hooks, a11y, security, imports,
  Node, unicorn) plus user-added npm plugins. `lib/tool-options.buildEslintConfig` writes the flat
  config into the sandbox before every run.
- **Ruff** — rule sets mapped to `--select` prefixes. Not published to npm, so `lib/sandbox.ensureRuff`
  uses the user's own binary, then a cached one, then downloads the official release with curl + tar.
  Every download Assay makes (ruff, osv-scanner, gitleaks) is checked against the SHA-256 that the
  same release publishes before it is unpacked or made executable; a mismatch or a missing
  checksum deletes it and fails the install.
- **Semgrep** — rule packs as `--config` flags; semgrep fetches them itself.
- **Gitleaks** — writes its JSON to a temp file rather than stdout, so the run collects it from
  there. It runs `--redact`: Assay records the rule and the location, never the secret.
- **OSV Scanner** — plain command, JSON on stdout; severity comes from the advisory's CVSS score.
- **SonarQube** — the managed Community Build container is published on `127.0.0.1` only, and if
  rotating its default `admin/admin` password fails the setup stops instead of carrying on with it.

`scanAll` runs every enabled tool that applies to a project, one at a time (they share a working
tree). `lib/schedule.ts` can do that unattended on an interval, never while another run is going.

Settings › Linters shows what is installed and can reinstall or remove it.

## Graphify

`graphify` is a tool in Tools, and the only one whose buttons are a state rather than a verb: what
`lib/graphify.ts` looks at is `<project>/graphify-out/graph.json`, so the row offers **Build graph**
when there is none and **Update** (primary) plus **Rebuild** when there is, with the age of the file
beside them. `graphState` asks the folder every time the project changes or a run ends — a graph is a
file a checkout or the post-commit hook can create behind Assay's back.

The point of running it here rather than through the skill is that nothing stops to ask. The skill is
a pipeline an agent walks step by step, and a scan has nobody to answer it; the CLI's headless
commands do the same work unattended:

- **Build / Rebuild** — `graphify extract <path> --code-only`, one full extraction. `--code-only` is
  what makes it unattended: docs, papers and images are the only inputs that would need an LLM
  backend, so without them there is no key, no network call and no prompt. Community *labelling*
  lives in `cluster-only`, not in `extract`, so no model is reached either way.
- **Update** — `graphify update <path>`, AST over what changed since the last manifest. Minutes
  cheaper, and the mode a plain Run resolves to when a graph is already there.

Options (`tool-options.ts`, stored like every other tool's) are all off by default, and the first of
them each trade that guarantee for something: **Include docs, papers and images** drops `--code-only`
and brings a backend into it, **Deep mode** and **Directed graph** cost time, **Skip clustering** buys
it back on a huge repo. `update` takes only the ones it can act on.

The last four options are not flags at all — they are the files an extraction does **not** write.
`extract` and `update` produce `graph.json` and stop, so a run that finished happily left no page and
no report behind and read as a failure. **Report (GRAPH_REPORT.md)**, **Interactive graph
(graph.html)**, **File tree (GRAPH_TREE.html)** and **Call flow** each name a second graphify command,
and `graphify.artifactCommands` turns the ticked boxes into the list `startGraphifyRun` executes after
the graph is written — same run, same log, each command echoed with its own `$` line, and a non-zero
exit named rather than swallowed (the graph is fine; a missing page is not). Two details are load
bearing: the report goes through `cluster-only`, which writes `graph.html` on its way, so asking for
both is one command; and `--no-viz` is never passed, because it *deletes* an existing `graph.html`
instead of skipping it. Only that first command takes the project path — the exports resolve
`graphify-out/` against the working directory, which the run has already set to the project. None of
them needs a key: `cluster-only` names communities when an LLM backend happens to be configured and
keeps `Community N` when there is none.

Once one of those files exists, an **Open** menu appears on the row and hands it to the system opener.
`opener:allow-open-path` carries a scope of exactly `**/graphify-out/*`, not the `**` the fs
permissions use: a project lives wherever the user put it, so the folder cannot be named literally,
but nothing outside a graphify output directory ever needs the machine's own handler — and `*` rather
than `**` keeps it to the files that directory holds directly. The menu lists what `graphArtifacts`
actually finds in `graphify-out/` — asked
of the folder on the same signal as the graph's own age, since these files outlive the option that
wrote them — and shows each file's real name next to what it is, because that is the name the user
will look for in the folder. `artifactOf` matches the call flow by its `-callflow.html` suffix: that
one is named after the project directory, which is not always the name Assay has for the project.

Everything graphify writes is a derived artifact — megabytes of JSON and single-line HTML that
`graphify update` rewrites in seconds — so it belongs in `.gitignore` the way `dist/` does, and once
a graph exists the row offers **Ignore in git**. This is the one write Assay makes into the audited
project that is not `graphify-out/` itself and it lands in a *versioned* file, so it is a per-project
click behind a confirmation rather than a tool option: `tools.config` is global to the tool, and a
checkbox there would quietly edit repositories the user never looked at. `gitignoreState` asks git
rather than reading the file — `check-ignore` also answers for a parent directory's rules,
`.git/info/exclude` and the user's global ignore file, so someone who already ignores build output
everywhere is never offered a line they have — and the offer disappears in all three of its own
negative cases: no repository, already ignored, no graph yet. `addToGitignore` writes to
`<project>/.gitignore`, not the repository toplevel: the leading slash in `/graphify-out/` then
anchors correctly whether the project is the root or a package in a monorepo, and in the second case
the rule sits beside the directory it ignores instead of in a file another team owns. Nothing already
in the file is rewritten, reordered or trimmed. The comment above the entry is written in English
whatever language Assay is running in, because it is read by whoever clones the repository and not by
the person who clicked. Two things the dialog says out loud: the exact lines, before anything is
written, since the user meets them again in a diff; and, when `git ls-files` finds the graph already
in the index, that the entry alone will not remove it — with `git rm -r --cached graphify-out` named
for the user to run, never run by Assay, since dropping files from the index is a different act from
adding a line to a text file and one the user may have meant to avoid.

It is a tool but not a scanner: it reports no findings — `db.normalizeFinding` would have nothing to
gate, and a row nobody can triage is worse than none — so `NON_SCAN_TOOL_IDS` keeps it out of Run all
and the scheduler. The run is recorded like any other and its summary is the graph it wrote
(`1,204 nodes · 3,910 edges`). Everything it writes stays inside `graphify-out/`; rule 8 is about
Assay's own configs, and this one is the project's graph, asked for by name.

Installing it is the third `InstallPlan`: `{ kind: "command" }`, resolved to `uv tool install`, then
`pipx install`, then `pip install --user` — never a bare `pip`, never a script piped into a shell —
and the exact command is shown before it runs. uv and pipx put the binary in the user's own bin
directory, which a running process does not learn about, so a successful install that still fails to
probe says to restart Assay rather than claiming nothing happened.

The **Agents** button on that row is the other half: graphify's skill and hook, in the agents that
would read them. The CLI installs one platform per run — a bare `graphify install` picks a single
default (`windows` on Windows, `claude` elsewhere) — and the copy it wrote carries the version that
wrote it, so an upgrade of the package leaves every skill on disk quietly behind. `lib/graphify.ts`
reads the folder each platform uses (`readAgentSkills`) and the version the binary answers with
(`graphifyVersion`, which reads only the line that *is* the answer, since the warnings quote versions
too); `skillStanding` compares them, and the row says up to date / outdated / not installed with the
word, not only the colour. The badge on the button counts **stale** skills alone: an agent the user
does not have is an offer, not a fault. Installing runs `graphify install --platform <p>` **from the
home directory** — a global install still writes a few things relative to the working directory
(opencode's `.opencode/plugins/graphify.js` among them), and rule 8 says none of that lands in the
scanned project.

The same dialog offers the **language extractors** graphify ships as Python extras. Only `sql` is
listed, because only one kind of extra is worth a button: a language whose extractor is missing is
skipped *in silence* — the file counts as code, the run exits 0, and nothing in the graph says the
migrations were never read. Assay cannot see inside the installed package, so it never claims the
extra is missing; it says what the extra buys and re-runs the install with `graphifyy[sql]` through
the same package manager as the first one.

## GitHub

The linked account lives in Settings › General (`features/github/GitHubCard`) and is used by one
thing: **Clone from GitHub** in Projects (`features/github/CloneDialog`). Nothing in it writes to
GitHub. `lib/github.ts` owns the whole of it.

Linking is an OAuth **device flow**: Assay asks GitHub for a code, the user types it at
`github.com/login/device`, and Assay polls until a token comes back. Device flow has no client
secret, no local web server and no custom URL scheme, which is what fits a desktop app that never
listens on a port; the one thing it needs is an OAuth App registered with "Enable Device Flow"
ticked, whose public id is `GITHUB_CLIENT_ID`. The scopes are `repo read:org` — reading private
repositories and the ones an organisation shares. The token is stored in the settings table like
SonarQube's and never leaves the machine except as the header of a request to GitHub.
**Disconnect** forgets it here and says so out loud: revoking the grant itself needs the client
secret the app deliberately lacks, so that is done under GitHub › Settings › Applications.
`readPollAnswer` is the pure half of the poll loop (pending, slow_down, and the final errors),
because timing decisions are the part that breaks silently.

The app hands out **expiring** tokens: the access token lives 8 hours and comes with a refresh
token that lives 6 months (`expires_in`, `refresh_token`, `refresh_token_expires_in`). Ignoring the
refresh half is what made the link die every morning, and GitHub's security log shows it as
`oauth_access.regenerate` by GitHub System, not as a revocation. `grantFrom` keeps all of it
(`github.refreshToken`, `github.expiresAt`, `github.refreshExpiresAt` beside `github.token`), and
every use goes through `withGitHubToken`: a token within 5 minutes of its end is renewed first, a
401 is answered with one renewal and one retry, and only a refusal that survives that forgets the
token. Renewing needs no client secret because the token came from the device flow — that is what
lets this app do it at all. The refresh token is single use and rotates on every renewal, so
`renewOnce` shares one in-flight renewal between callers; two at once would spend it twice and the
second answer would sign the user out. When the refresh token itself is past its six months the
link has to be made again, and the connect row says so with GitHub's own words
(`TokenRejectedError.detail`) under the sentence, rather than claiming a revocation it cannot know
about. A token that does not expire carries neither field and is used as it is.

Cloning is the user's own `git clone --progress`, streamed into the dialog, with the destination
`<clone root>/<repo name>` shown as a command line before it runs. For a private repository the
token travels through `GIT_CONFIG_COUNT` / `http.extraHeader` in the **environment** — not on the
command line, and not into the clone's `.git/config`, so a later `git remote -v` shows nothing —
and `GIT_TERMINAL_PROMPT=0` makes a refused clone fail with a message rather than hang on a
password prompt nobody can see. The folder must not exist beforehand; the dialog says so instead of
letting git say it.

Push and pull in Workspace › Git use the same token, so a machine where git was never signed in (a
fresh Mac) pushes with the account linked here instead of asking for `gh auth login`. It applies when
an account is linked and the branch's remote (`branch.<name>.remote`, else the first one) is
`https://github.com/…` (`isGitHubHttpsRemote`), and it goes ahead of the user's credential helper so
every machine behaves alike. The header is scoped by URL — `http.https://github.com/.extraHeader`
(`remoteAuthEnv`) — so no other host ever receives it, and it travels in the environment like the
clone's. A refusal gets one renewal and one retry through `withGitHubToken`. An ssh remote, another
host, or no linked account is plain git with the user's own credentials, as before.

When the clone lands, the folder becomes a project the way Add project would have made it — name,
path, detected stack — plus `github_repo` (`owner/name`, migration 010). That column is set by the
clone and by nothing else: a folder added by hand is not claimed even when its origin points at
GitHub, because the link records how the project entered Assay, not a guess about its remote. The
dialog reads it to mark a repository as **in Assay** so the same one is not cloned twice, and the
card shows it as a line that opens the repository in the browser.

Beside that line the card says **Private** or **Public**, with the word and not only the padlock.
`github_private` (migration 011) is written by the clone and refreshed every time the dialog lists
the account's repositories (`syncGithubVisibility`), because that listing already carries the
visibility and a repository can change it after it was cloned — no extra request is made for it.
Only rows whose answer changed are written. NULL means not known yet (cloned before the column
existed), and then the pill is simply absent.

## Workspace (the `bench` view)

A real shell on the active project, with the code beside it (empty state when the project has no
local folder). The work area on the left has **one tab strip**: terminals and open files sit in it
together, and the surface below shows whichever is selected (both stay mounted — an unmounted xterm
loses its screen, an unmounted Monaco its cursor). The right is a dock: a rail that is always visible
(Files · Search · Findings) plus the open panel, resizable, folded only by the button in its header.
A footer is the view's whole status line — the shell's own `StatusBar` is not mounted on Workspace
(when the project has a folder), so nothing is said twice. Left, where the path used to be, Claude's
limits and context (`ClaudeUsage`), which give way first when the window narrows. Right: the
project's published site, its repository, its folder, then the resolved shell, this project's live
terminal count, a menu of the sessions still running under other projects when there are any, and
the memory reading at the far end. The site is `projects.url`, shown as its host with a ↗ and opened
in the system browser; with none saved the same place says **Add URL** and opens the project dialog
with that field focused. The repository is read from `origin` (`remoteWebUrl`), so it works for any
project and not only the ones cloned here: GitHub's mark for github.com, a generic git icon for any
other host, nothing without a remote. `git.webUrlFromRemote` (pure, tested) is the one place that
URL is made, for this link and for the Git panel's pull request alike: only http(s), and any user
or token an https remote carries in its authority is dropped before it reaches a tooltip, the
browser or its history. The folder is an icon whose tooltip is
the path; a click reveals it in the file manager (`revealItemInDir`, already allowed, rather than a
new permission to launch the file manager on an arbitrary path).

Everything here is **scoped to the active project**. Terminals and open files are kept for every
project at once and filtered down to the one on screen: switching projects hides the others rather
than killing them, because a PTY holds a live agent. `store/bench.ts` tags each session and each open
file with its `projectId`, remembers which tab each project was left on, and clears the search hits
and the git status, which belong to the tree they were read from. The dock is keyed by project id, so
its panels remount instead of carrying the last repo's staged files and commit message into the next.

- **Files** — the search box (File names filters the tree as you type; In files shells out to
  ripgrep, then `git grep`, then grep, and lists `file:line` hits; the query never reaches a command
  line — git grep gets it as an argument with no shell, rg and grep read it from a temp pattern file —
  so `%VAR%`, `&` and quotes are searched for literally) over the lazy tree. Rows carry the
  working-tree state the way an editor does: the name takes the colour and the letter git printed —
  `M` modified and `R` renamed in `warn`, `A` added and `U` untracked in `success`, `D` deleted in
  `danger`, `!` conflict in `crit` — and a folder with a change somewhere underneath gets an amber
  dot without a letter. The letter is not decoration: colour alone would say nothing to a reader who
  cannot separate amber from green. The open file's tab carries the same mark.
- **Search** — the same panel already switched to In files.
- **Git** — branch switching (`git switch`, never `--force`, so git refuses rather than discarding
  work), the working tree with a checkbox per file, a commit message box with **Write with AI**
  (the `commit` task's default, or any AI from the caret beside it, turns the diff into one gitmoji +
  Conventional Commits subject), and commit / push / pull / pull request. Pushing and opening a PR
  leave the machine, so both confirm first; pull runs without asking, because it sends nothing out:
  `git pull --no-rebase --ff --no-edit` fast-forwards when it can and otherwise merges with git's own
  message, overriding the user's `pull.rebase` / `pull.ff`; a clashing merge lands in the Conflicts
  panel. The status is read with
  `git status --porcelain=v1 -z`: without `-z` git C-quotes any path with a space, a quote or a
  non-ASCII byte, and handing that back to `git add` matched nothing and aborted the whole list. A
  rename carries its source (`GitChange.from`), and staging or unstaging one takes both paths. The
  `↑N ↓N` beside the branch sits in a slot that is always there, so a push that empties it does not
  move the row; and a `Button` that is loading swaps its icon for the spinner instead of adding one,
  so it never widens and pushes its neighbours onto the next line. The panel re-reads itself
  whenever the heartbeat below sees the working tree change, so an agent's edits show up without
  leaving the tab. Nothing here rewrites history: no reset, no force, no discarding a working tree.
- **Sessions** — the Claude Code transcripts already on disk for this folder
  (`~/.claude/projects/<slug>/*.jsonl`): what each session was asked to do, who spoke last and what
  they said, so a row is recognisable without opening it. One click resumes one in a terminal.
  `src-tauri/src/sessions.rs` streams the files — a transcript runs to megabytes and only the
  summary crosses into the webview. Nothing is stored and nothing leaves the machine.
- **Findings** — this project's open findings grouped by file; clicking one opens the file *at the
  finding's line*, which is the whole reason the workspace lives inside Assay. Findings with no file
  are listed apart rather than attached to an invented location.

The view is labelled **Workspace**; the view id, folder and store are still `bench`.

Tree is lazy and hides build output until asked — and says so: the root is read with the ignored
folders in, and a line at the foot names how many are hidden (`4 folders hidden (node_modules,
dist…) · Show`), only at the root, since counting deeper would mean walking the tree the laziness
exists to avoid. Monaco saves only on Ctrl+S and warns when the file changed on disk.

The tab strip is in the user's order. `lib/tab-order` keeps one list of keys (`t:<id>`, `f:<path>`)
for every project, and a tab never moved sits at the end in the order it opened, so opening one
never writes there. Tabs are dragged with pointer events, not HTML5 drag and drop: Tauri takes drops
at the OS level for desktop files, which on Windows leaves the webview's own `dragover`/`drop`
silent. `Ctrl+Shift+PageUp/PageDown` moves the tab in front one place — not the arrows, which the
editor and every shell use to select words. A terminal tab is renamed with a double-click or its
right-click menu; `pty_rename` keeps the name in Rust beside the one it was spawned with, so a reload
brings it back and an empty name restores the original. File tabs are not renamable: that would
read as renaming the file. Terminals are PTYs owned by Rust and keyed by id, so leaving the view, hiding to the
tray, switching project or remounting React never kills a session — only closing the tab or quitting
does. Live terminals count in the quit confirmation and block reload, like runs, and so do open files
with unsaved edits, from any project: a tab hidden behind a project switch is exactly the one whose
work would go quietly. `pty.rs` carries the `project_id` alongside the title and the kind, so a
dev-server reload puts each session back under its own project; anything older is matched by its
`cwd`, and what matches nothing stays alive, counted, and reachable from that footer menu.

Git status feeding the tree and the tabs is one `git status --porcelain` per read, kept in the bench
store. It is refreshed when Bench opens or the project changes, after a Ctrl+S, from whatever the Git
panel just fetched, and on a 10 s heartbeat that only beats while the window has focus — because in
Assay the thing editing your files is usually an agent in the terminal next door, not you.

Terminals carry link providers (`features/bench/terminal-links.ts`): **Ctrl/Cmd+click** on a
`path:line` an agent printed opens it in the editor at that line, and on a URL opens the browser.
Plain clicks are left alone — a terminal has to keep selecting text — and a path is only a link when
the file actually exists on disk.

Copy and paste work the way a terminal's do, and `lib/clipboard.ts` is what makes them work inside a
webview — it reads the clipboard through Rust (`plugin:clipboard-manager|read_text`) and falls back to
`navigator.clipboard`, which is all `pnpm dev` has in a plain browser. The gestures: **Ctrl+V** / **Ctrl+Shift+V** paste through `term.paste`, which brackets the text so an agent
takes twenty lines as one block instead of running each as its newline lands; **Ctrl+Shift+C** copies
the selection; **Ctrl+C** copies only when something is selected and otherwise stays what stops an
agent. Right-click means one thing everywhere — with a selection it copies, without one it pastes —
in the terminals and in every text field of the app, since `installClipboardFallback()` hooks the
document once rather than each input. The shortcut is never cancelled: the fallback waits a beat and
only reads the clipboard itself if the webview's own paste never arrived, so nothing is pasted twice.
Monaco is left out of all of it — it brings its own clipboard and its own undo stack.

A paste is not always text, and a PTY has no way to take a picture: what an agent can act on is a
**path**. So `pasteIntoTerminal` answers in the order the clipboard does — text first; then the paths
of files copied in the file manager (`clipboard_files`, `CF_HDROP` on Windows), typed exactly as a
drop types them, through the same `droppedPathText`; then the clipboard's own bitmap, which
`clipboard_image_to_temp_file` encodes to a PNG under the temp directory (`assay-paste-<ms>-<n>.png`,
pruned after a day) and whose path is what reaches the shell. `src-tauri/src/clipboard.rs` does the
encoding, because the RGBA of a 4K screenshot is 33 MB that would otherwise cross the IPC boundary as
JSON only to come back as a file. Claude Code turns that path into its own `[Image #1]` — the app
never draws one.

The text fields answer the same three ways, because a prompt asking about a screenshot is worth as
much as a command about one: `installClipboardFallback` inserts the text when there is text and
`clipboardPathText` otherwise — the same paths, absolute and slash separated, with nothing quoted,
since no shell reads that line. Monaco stays out of it.

Files dragged in from the desktop land in `lib/file-drop.ts`. The webview never sees them: Tauri takes
the drop at the OS level (and `harden.ts` cancels the HTML one, because a file dropped on a webview
navigates it away and the app disappears), so the paths and the cursor position arrive through
`onDragDropEvent`. The position is what lets one window mean two things — the surfaces carry
`data-drop-zone`, the one under the cursor is ringed in `--color-accent` while the drag is in flight,
and dropping on the **terminal** types the paths into the live command line (slash-separated, relative
to that session's `cwd` when they lie under it, quoted only when a shell would misread them, trailing
space, never a newline: nothing is executed) while dropping on the **editor** or the tab strip opens
them. A folder is not an error there, it is simply not a file, and a binary or an oversized one meets
the guard `fs-tree.openFile` already has.

The shell is resolved by `lib/bench-term.resolveShell()`: the `bench.shell` setting, else Git Bash →
pwsh → powershell → cmd on Windows and bash → sh elsewhere. Windows Terminal is not a candidate — it
is a terminal emulator, not a shell. An agent (`claude`, `opencode`, `hermes`) is passed as a shell
**argument**, never typed into the PTY: input written before the shell's line editor is up is
swallowed, and the argument form also leaves a live shell behind when the agent exits.

## Claude in a terminal: turns and limits

A PTY only says when its process dies, and Claude waiting for the next prompt is very much alive.
So every `claude` Workspace opens (plain, from a skill, or resumed) starts with
`--settings "$ASSAY_CLAUDE_SETTINGS"` — a file `src-tauri/src/agent_signals.rs` writes once per run
into `<temp>/assay-agent-signals/<pid>/`. `--settings` adds to the user's own settings for that
session and edits none of their files. The path travels in the environment for the same reason the
prompt does, and so do `ASSAY_PTY_ID` and `ASSAY_SIGNAL_DIR`, which tell the hook which terminal it
fired in and where to write. No port is opened: the folder is the whole channel, and a thread polls
it, reads each file, deletes it and emits an event.

- **Stop hook** — writes `<pty id>.<pid>.stop` at the end of every turn; `agent://stop` carries the
  first line of `last_assistant_message`. `bench.agentStopped` marks the tab with an `accent` dot when
  that terminal is not what the user is looking at (window focused, Workspace open, that tab in
  front), and — when notifications are on and `notify.agents` is not off — sends
  `Claude finished · <project> › <tab>`. Looking at it is silence, since the hook fires every turn.
  Opening the tab, or focusing the window with it in front, clears the dot.
- **Status line** — the plan limits and the context only reach Claude's status line, so the same
  settings file sets one. It saves its input as `<pty id>.status` (written aside and moved, so the
  watcher never reads half of one) and then pipes the same input to the user's own status line from
  `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR`), keeping its padding and refresh, so the terminal
  still shows the user's bar: `statusLine` is a scalar and `--settings` outranks their file, so
  without the chain it would vanish. `agent://status` feeds `store/claude-usage`: the 5-hour and
  weekly windows are the account's, so the newest reading wins and is kept in `claude.limits` to
  survive a restart; context is per session and kept per terminal. The status bar shows `5h` with
  the time to its reset, `Week` with the day and hour of its reset, and the context of the Claude tab
  in front (else the one in this project that reported last), toned `warn` from 80 % and `danger`
  from 95 % with the number always beside the colour. A window past its `resets_at` says reset
  rather than keep a percentage that no longer holds. Limits exist only on a Pro or Max plan and
  only after the first answer, so a reading without them never wipes the last one.

Only Claude has these hooks; OpenCode and Hermes get neither flag. The user's status line is read
once per run, so changing it needs a restart of Assay, and a project-level `statusLine` is not
chained.

## Deploy

What VS Code's SFTP extension does with `uploadOnSave`, for a workspace where the thing writing files
is an agent that never presses Save. A project can have several **servers** (`deploy_servers`,
migration 013 — staging, production), one of them the default; each keeps a **manifest**
(`deploy_files`: path, size, mtime, SHA-256 as the server last received them). `deploy_scan`
(`src-tauri/src/deploy.rs`) walks the local folder, hashes only what moved since the manifest, and
answers added / modified / deleted, plus *touched* — same bytes, new mtime — which is written back to
the manifest and never uploaded. It works the same in a repository or not, and it deliberately
ignores `.gitignore`: what gets deployed is so often exactly what git ignores (`dist/`, `vendor/`).
What it skips is the server's own **Never upload** list (gitignore-lite: a bare name matches any
segment, a path with `/` is rooted), which starts from `DEFAULT_EXCLUDES` — `.env` among them.

Transport lives in Rust. **SFTP** goes through `russh` + `russh-sftp` (built on `ring`, not aws-lc,
which needs cmake and NASM on Windows) with a key or a password, falling back to keyboard-interactive
for servers that turn the `password` method off; a key path left empty tries `~/.ssh/id_ed25519`,
`id_ecdsa`, `id_rsa`. **FTP / FTPS** (explicit TLS, `ssl-reqd`) go through the system's own curl, one
login per batch of 25 files, with the login in a temp config file (`-K`, mode 0600, deleted after) —
never on a command line another process can read — and one `write-out` line per transfer as the
per-file answer. Passwords and key passphrases live in the **OS keychain** (`keyring`, service
`assay-deploy`, account = server id); the webview can set, delete and ask whether one exists, and
never read it back. Test connection writes a typed secret under a scratch account
(`<server id>:test`) and deletes it afterwards, so the server's own entry changes only on Save and
Cancel never leaves a different password behind.

Paths coming from the webview are refused unless they are plain relative paths inside the deploy
folder (no `..`, root, drive letter or UNC prefix), and FTP refuses any path or value with CR, LF
or NUL: curl's config file would read a line break as a second FTP command.

A server's SSH host key is **pinned on first use**: the first connection records the fingerprint and
refuses, Test connection shows it (`SHA256:…`) with **Trust this key**, and a key that later differs
is refused outright with both fingerprints and the explanation. Nothing is uploaded to an SFTP server
whose key nobody accepted.

The UI is the **Deploy** panel in Workspace's dock (`features/deploy`), with a badge counting what
the default server has not received, and a footer chip (`DeployChip`: *N to upload*, *Uploading…*,
*Deploy failed*, *Deployed*) that is absent for a project with no server. Changes are ticked by
default and survive rescans; **deletions are listed apart, never ticked on their own**, and deleting
on the server takes a danger confirmation. Every upload confirms first, because it leaves the machine.
Progress streams on `deploy://progress`, **Stop** cancels between two files, a failed file does not
stop the others, and the manifest takes exactly what the server confirmed. A server that never
received anything from Assay makes every file look new, so the panel offers **Mark all as uploaded**:
the disk as it is becomes the manifest, nothing is sent.

**Upload automatically** is per server. `store/deploy.syncWatchers` watches every project that has an
auto-upload server — from launch, whatever view is open — plus the project on screen while it has
servers, through `tauri-plugin-fs`'s `watch` (feature `watch`, debounced 3 s, `.git` and
`node_modules` events ignored). A change rescans and sends what is pending; auto-upload **never
deletes**, never runs on a server whose manifest is still empty, and reports a failure as a system
notification, since nobody is looking.

A project with `.vscode/sftp.json` offers its servers on the empty panel (comments and trailing
commas allowed; one config, a list, or `profiles` each becoming a server, `defaultProfile` the
default; `secure` FTP becomes FTPS; `context` becomes the local folder; a password written in the
file moves to the keychain). **Save as .vscode/sftp.json** writes them back for the extension — with
`uploadOnSave` on and never a password — behind a confirmation that shows the file. It is the one
Deploy write into the project, and only on that click. Add project has a **Publishes to a server**
switch that lands the new project on its Deploy panel with the server form open.

## Ports

What VS Code's port forwarding does, for a dev server an agent started in the terminal next door:
the **Ports** panel in Workspace's dock lists what the project is serving, and each port is one click
from a public `https://<random>.trycloudflare.com` link to send to someone.

`src-tauri/src/ports.rs` asks the OS with the tool it already ships — `netstat -ano` on Windows,
`lsof -iTCP -sTCP:LISTEN -F pn` on macOS, `ss -ltnp` then `lsof` on Linux — rather than a socket
crate. On Windows the state column is translated (`ESCUCHANDO`), so a listening row is recognised by
its peer address (`0.0.0.0:0`, `[::]:0`), never by the word. Only sockets reachable through loopback
count (wildcard, `127.*`, `::1`); one bound to a LAN address alone is left out, since a tunnel on
this machine could not reach it. A port **belongs to a project** when the listening process descends
from one of that project's terminals — `pty.rs` keeps each shell's pid, and `sysinfo` walks parent
links up to it — or, for servers outside the shell's tree such as a container, when one of those
terminals printed `localhost:<port>` (the scrollback tail is searched with escape sequences taken
out, because Vite prints its port in bold). The panel shows only the active project's ports and
follows a project switch; nothing running gives an empty state that says how to get a row.

Something running outside Assay is added by hand (**Add port**). Those ports are stored per project
(`project_ports`, migration 014) and stay listed while nothing listens on them; detected ports are
never stored. Storing a port never opens a link.

A link is `cloudflared tunnel --url http://<host>:<port>`: an outbound connection, no account, no
inbound port. It is held in Rust (`src-tauri/src/tunnel.rs`), so it survives a reload and a project
switch the way a terminal does, and links held by other projects are listed in the footer with a
way back and a Stop. The webview picks the binary (PATH, a known install folder, or the path set in
Toolchain) but `tunnel_start` refuses anything not called `cloudflared` and any host that is not
loopback. `--http-host-header localhost:<port>` is passed because dev servers refuse an unknown Host
(Vite answers "Blocked request"); an app that builds absolute URLs from that header will build them
with `localhost`. The URL is read from cloudflared's log, copied to the clipboard as soon as it
appears, and the row offers Copy, Open and Stop.

A quick tunnel has **no password**, so every Share confirms first and says so, and a live link
carries a **Public** badge in `warn` on its row, a count on the rail, and a chip in the footer. A link
closes on Stop, when its port is silent on two polls in a row (a dev server restarting on save does
not cost the link everyone was sent), and when Assay exits — `RunEvent::Exit` kills every tunnel. If
Assay crashes instead of exiting, cloudflared is not killed. Links count in the quit confirmation
but do not block a reload, since they live in Rust. Ports are read on a 10 s heartbeat while the
panel is on screen and the window has focus, and whenever a link is up.

cloudflared is a Toolchain row (winget `Cloudflare.cloudflared`, brew, the download page on Linux),
and the panel shows that same row, with its Install, when the binary is missing.

## Scripts

The ▶ beside `+` in the tab strip (or **Ctrl+Shift+R**) opens a palette of the project's own
commands, and the starred ones sit next to it as chips. `lib/scripts.detectScripts` reads only what
the root declares: `package.json` scripts run the way the lockfile's manager does (`pnpm dev`,
`npm run dev`, `yarn`, `bun`), `Cargo.toml` offers run / build / test / check, a `Makefile` its
targets (not special, pattern or underscore ones), `composer.json` its scripts. Nothing else is
guessed — Python has no standard for it — and a monorepo's inner packages are added by hand.

What the user adds lives in `project_commands` (migration 012), which holds two kinds of row: a
detected script kept only for its star (deleted when unstarred, the script itself is read from the
repo every time), and a hand-written command. The command line is the identity inside a project.

Running one opens a terminal tab named `▸ <name>`, because the one that matters most — a dev server
— never ends: a PTY is what lets it be watched, kept alive across views and stopped. The line travels
in `ASSAY_COMMAND` (a user-written line survives no quoting round trip through MSYS2), and bash runs
it under `trap : INT` so Ctrl+C stops the server without ending the `bash -c` waiting on it — the tab
falls back to a live shell instead of dying with the process.

## Skills

The view has two lists, and they are not the same kind of thing.

**In this project** is what the repo versions with its code: `<root>/.claude/skills/<name>/SKILL.md`
and its `.opencode` twin, found by `importers.discoverInProject`. They are read where they lie and
never copied on sight, so the list follows the active project and empties when you switch to one that
has none (and the whole section disappears rather than sitting there empty). They can be run and
copied, never edited or deleted: that file belongs to the repo, and rule 8 stands. **Copy to Assay**
takes one into the database, where editing it costs the repo nothing; a name already there shows as
copied instead.

**In Assay** is the rest: written in the dialog, or imported from `~/.claude` and
`~/.config/opencode` with the Import button. Those are rows in `tools` and behave as they always did.

A project skill has no row to point at, so `runner.SkillLike` is what running one actually needs —
name, goal, prompt — and a `Tool` satisfies it. `store/app.runProjectSkill` runs one, and `startSkill`
records `tool_id` as null for it, the way an agentic fix already does.

## Skills in a terminal

A skill runs two ways, and they are not the same trade. **Run** (`runner.startSkill`) is headless: it
streams into the run dock and is persisted, so Audit can show it later. **Use** opens a Bench terminal
on the `skills` task's agent with the skill's prompt already passed as an argument. The caret beside
them does both for this one use: *Run headless with* any agent or opencode model, *Open a terminal
with* another agent. Nothing is recorded, because a terminal is a PTY and not a
run; what you get instead is watching it work and taking over mid-way.

`bench-term.agentCommand()` builds that command, and **the prompt never goes in it**. It travels in
the environment instead — `promptEnv()` sets `ASSAY_PROMPT`, `pty_spawn` takes an `env` map, and the
command reads it back as one whole argument (`claude "$ASSAY_PROMPT"`, `claude $env:ASSAY_PROMPT`,
`claude "%ASSAY_PROMPT%"`). Quoting it into the command line does not survive Windows: MSYS2 programs
re-parse the command line themselves and eat the escaping, so a prompt with an apostrophe reached
bash as an unterminated quote and the session died on `unexpected EOF`. cmd is the one shell that
still needs care, because `%VAR%` is expanded textually before anything runs, so only there is the
value flattened to one line. The variable stays set in the shell the agent leaves behind: it is the
user's own text, and `echo $ASSAY_PROMPT` says what was sent. The prompt itself comes from
`runner.skillTerminalPrompt`, which is the headless prompt minus its opening line: `startSkill` tells
the agent that nobody can answer it, and in a terminal somebody can.

## AI per task

Every place Assay asks an AI for something is an `AITask`, and each has its own default in
Settings › AI › **AI per task**: `fix` (Fix with AI), `skills` (skills and commands), `commit` (the
message in Workspace › Git) and `improve` (*Improve with AI* on a skill). The first two read files,
edit them and run commands, so only a CLI agent can do them; the last two are one prompt in and one
answer out, which any model answers — a small local one for free, on the machine.

A choice is one string, `agent:<provider>[:<model>]` or `local:<runtime>:<model>`, split on the first
two colons only, since `qwen2.5-coder:7b` and `lmstudio/qwen/qwen3-coder` carry their own.
`parseAIChoice` refuses anything it does not recognise instead of trusting it. A task nobody has set
yet starts from the two settings that came before (`ai.provider` + its model, and `ai.textEngine`),
so an upgrade changes nothing; `getTaskChoice` reads each task once per session and `setTaskChoice`
is the only writer.

The default is where each place **starts**, not what it is stuck with: Findings keeps its picker
beside Fix, Workspace › Git has a caret beside *Write with AI*, a skill card's caret offers *Run
headless with* any agent, the command Run dialog has an AI field, and the skill dialog picks the
engine for Improve. A pick there is for that one use and is never written back to Settings.

What the pickers list comes from `loadAIInventory()`, found once per session and shared by every
picker on screen (`opencode models` alone takes seconds): claude; opencode with **every** model it has
configured, local ones included — which is how a local model fixes code, through opencode, never on
its own; hermes with its default plus the models the user typed in Settings, because Hermes has no
command that lists them; and Ollama / LM Studio models directly. `aiOptions` keeps what cannot be
used listed and greyed with the reason — an agent not installed, a bare local model on a task that
edits files, a runtime installed but not running — because a choice that silently vanished reads as
a bug. `runOneShot` runs a text task through whatever was picked, and an engine that is not there
**fails and says which**: no silent fallback, since falling back would spend a frontier model's
tokens on precisely the task the user moved to a free local one. `probeLocalRuntimes()` is the one
place that reads the configured runtime URLs.

## Finding the agents

`lib/agent-bins.ts` answers where each binary lives, because PATH is not the whole truth on Windows:
opencode's installer writes `~/.opencode/bin` into `~/.profile`, which only Git Bash reads, so the CLI
answered in the user's terminal and was "missing" in Assay, which probes through `cmd /c`. The order
is a path the user set in Toolchain (`bin.<id>`), then PATH, then the homes each installer uses
(`knownBinPaths`, pure and tested). A binary found outside PATH is run by its full path everywhere:
headless runs and one-shots (`runner.buildAgentCmd`, where a claude under a path with spaces goes out
as tokens so cmd still sees the pipe), and Workspace terminals, where `bench-term.binForShell` gives
bash forward slashes and quotes only when a space forces it (PowerShell then needs `&`).

Settings › Tools › **Toolchain** is where that is visible and fixable: each row says found, missing
or — for Ollama and LM Studio — installed but not running, with **Start** (`ollama serve` detached
through `start` / `nohup`, so it outlives Assay the way it would had the user started it; `lms server
start` for LM Studio). A missing tool offers **Install** only when a package manager already on the
machine can do it — npm for claude and opencode, uv or pipx for strix, winget on Windows and brew on
macOS for the rest — with the exact command in a confirmation first and its output streamed into the
row. What only ships as a script piped into a shell (Hermes) or as an installer that wants admin and a
reboot (Docker Desktop) gets **How to install** and the command to copy instead. `toolchain.installRecipe`
makes that call, and it is pure and tested.

## Language

English and Spanish, chosen in Settings and stored in the DB (`ui.language`); the first run follows
the OS locale. `useT()` inside components (it re-renders on a change), `tr()` in stores and lib code.
Adding a language means adding a map to `DICTIONARIES` in `lib/i18n.ts` and an entry in `LANGUAGES`.

Dates go through `lib/dates.ts` (`useDates().ago/at`), which carries the matching date-fns locale.
Interpolating a raw `formatDistanceToNow` into a translated sentence is how you end up with
"escaneado about 2 hours ago", so no view calls date-fns directly.

## Commands

```bash
pnpm dev            # vite dev server (browser only, no tauri APIs)
pnpm tauri dev      # the real app
pnpm build          # tsc + vite build
pnpm tauri build    # bundled desktop app
pnpm build:win      # Windows NSIS installer (tauri build --bundles nsis)
pnpm build:mac      # universal macOS .dmg, on a Mac only (vite build directly, 4 GB node heap)
pnpm exec tsc --noEmit   # typecheck
pnpm test           # vitest
pnpm version:bump 0.2.0  # set the version everywhere and open it in CHANGELOG.md
```

## Releases

Versions follow SemVer and `CHANGELOG.md` follows Keep a Changelog. `pnpm version:bump X.Y.Z` writes
the version into every file that carries it and turns `## [Unreleased]` into the new section; it
commits and tags nothing. The maintainer commits, tags `vX.Y.Z` and pushes; the tag runs
`.github/workflows/release.yml`, which builds every platform into a **draft** release.

### Updates

Installed copies update themselves from GitHub Releases through `tauri-plugin-updater`. They read
`releases/latest/download/latest.json` — the newest **published** release, which never includes a
draft or a pre-release — so publishing the draft on GitHub is the act that ships a version to
everyone, and a broken build that stays a draft reaches nobody.

Every installer is signed with minisign. The public key is `plugins.updater.pubkey` in
`tauri.conf.json`; the private key and its password are the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets, and the release build fails without them
rather than publishing an unsigned release. `createUpdaterArtifacts` is switched on by `--config` in
`release.yml` and not in `tauri.conf.json`, so a local `pnpm build:win` keeps working without the
key. `tauri-action` uploads `latest.json` (`includeUpdaterJson`), pointing Windows at the NSIS
installer rather than the MSI. Losing the private key means installed copies refuse every later
update and have to be reinstalled by hand; it is kept outside the repository and backed up.

`store/updater.ts` looks 15 s after launch and every 6 hours while Assay runs (it lives in the tray
for days), unless **Look for updates automatically** in Settings › General is off; **Check now**
always works. The request is a plain GET of that file and sends nothing about the user. A version
found shows as a chip in the header; nothing downloads until the user asks. The dialog shows the
release notes and offers **Update and restart**, **Install when I quit** (downloaded now, installed by
`applyUpdateOnQuit`, which every quit path in `WindowChrome` goes through) and **Skip this version**
(`updates.skipped`; a manual check shows it again). With runs, terminals, public links or unsaved
files open, the dialog lists them the way the quit confirmation does and the button turns danger.
Windows installs in NSIS `passive` mode; macOS and AppImage relaunch through `tauri-plugin-process`.
A `.deb` or `.rpm` cannot replace itself (`install_kind` reads `APPIMAGE` on Linux), so there the
chip leads to the release page instead. A development run never looks on its own, and cannot
install. An automatic check that fails says nothing; only one the user asked for reports the error.

## Installers

**Windows** ships an NSIS installer branded from the same tokens as the app: `src-tauri/installer/`
holds the header (150x57) and sidebar (164x314) bitmaps — NSIS takes BMP only and ignores alpha, so
both are drawn flat on `--color-bg`. Configured under `bundle.windows.nsis`: app icon, those two
images, the LICENSE page, a language selector with English and Spanish, and `installMode:
currentUser` so installing needs no admin. Re-running the installer over an existing version is
detected from the registry and offers repair or upgrade; the database in `%APPDATA%` is never
touched, and pending migrations run on the next launch. `pnpm build:win` builds it alone, into
`src-tauri/target/release/bundle/nsis/`.

**macOS** ships a `.dmg` with a matching background (`installer/dmg-background.png`, 660x400) and the
icon and Applications alias placed by `bundle.macOS.dmg`. It **must be built on macOS** — the `.dmg`
needs `hdiutil` and `codesign`, so there is no cross-compiling it from Windows. Either run
`pnpm build:mac` on a Mac (a universal `.dmg`, which needs `rustup target add aarch64-apple-darwin
x86_64-apple-darwin` once; it swaps `beforeBuildCommand` for a bare `vite build` under
`NODE_OPTIONS=--max-old-space-size=4096`, since `tsc` plus the bundle ran out of memory there and
the typecheck already runs in CI), or push a `v*` tag and let
`.github/workflows/release.yml` build all three platforms on their own runners. Without an Apple
Developer ID the build still produces a `.dmg`; macOS then warns on first open until the user
right-clicks → Open. Setting the `APPLE_*` repository secrets makes the workflow sign and notarise it.

`src-tauri/installer/generate.py` regenerates all three images from the design tokens.

## Shipped build

`lib/harden.ts` runs before the first render and only in production: it cancels the webview's own
context menu (except inside Monaco and text fields, which have their own), the reload / view-source /
devtools shortcuts, and file drops — a file dropped on a webview navigates it away and the app
simply disappears. Release builds have no devtools compiled in either: the `devtools` cargo feature
is off, and `devtools` stays out of `tauri.conf.json` so `tauri dev` keeps them.

None of this makes the frontend private. A desktop bundle carries its JavaScript inside the
executable and anyone can extract it; that is why no secret is ever compiled into the frontend and
why anything that must stay private belongs in Rust or behind a server.

## Window chrome

Windows / Linux: `decorations: false` + `transparent: true`; the app draws its own
minimize / maximize / close in the header (`components/layout/WindowChrome.tsx`) and the drag
region is the header plus the sidebar logo row.
macOS: keeps the native frame via `src-tauri/tauri.macos.conf.json` (`titleBarStyle: "Overlay"`),
so the custom controls render nothing and the sidebar reserves room for the traffic lights.

Closing hides to the system tray instead of quitting, because scans and agents keep running; the
notice explaining that is shown once. Quitting for real is the tray menu, which asks first when
anything is still in flight.
