import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  Download,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
} from "lucide-react";
import * as React from "react";
import {
  commit,
  conflictState,
  diffForPaths,
  explainGitError,
  gitLog,
  gitState,
  listBranches,
  pull,
  push,
  remoteWebUrl,
  stagePaths,
  switchBranch,
  unstagePaths,
  upstreamState,
  type GitChange,
  type GitCommit,
  type GitState,
} from "@/lib/git";
import { aiChoiceLabel, parseAIChoice, runOneShot, setTaskChoice, type AIInventory } from "@/lib/ai";
import { AIMenuItems, useAIInventory, useTaskChoice } from "@/features/shared/AIPicker";
import { useApp } from "@/store/app";
import { useBench } from "@/store/bench";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Button, Input, Textarea } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { useDates } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { fileGlyph } from "./icons";
import { pullRequestUrl, supportsPullRequest } from "./pr-url";

/** A rejected promise as a sentence for the error bar. */
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The working tree plus stage, commit, push, pull and pull request. Nothing here
 * rewrites history: no reset, no force; `git switch` without `--force` so git
 * refuses rather than discarding work. Push and PR leave the machine, so both
 * confirm first.
 */

const CODE_TONE: Record<string, string> = {
  M: "text-warn",
  A: "text-success",
  D: "text-danger",
  R: "text-low",
  "?": "text-text-3",
};

/** The engine a stored choice names, for a tooltip; blank while it is still being read. */
function engineName(value: string): string {
  const choice = parseAIChoice(value);
  return choice ? aiChoiceLabel(choice) : "…";
}

function changeTone(change: GitChange): string {
  return CODE_TONE[change.code.trim()[0] ?? "?"] ?? "text-text-2";
}

/** One line per commit. */
function CommitRow({ commit: entry }: { commit: GitCommit }) {
  const dates = useDates();
  return (
    <div className="flex items-start gap-1.5 px-2 py-1 text-[11px]">
      <GitCommitHorizontal className="mt-0.5 h-3 w-3 shrink-0 text-text-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-text-2">{entry.subject}</span>
        <span className="block truncate text-[10px] text-text-3">
          <span className="font-mono">{entry.hash}</span> · {entry.author} · {dates.ago(entry.at)}
        </span>
      </span>
    </div>
  );
}

function BranchMenu({
  root,
  current,
  onDone,
  onError,
}: {
  root: string;
  current: string | null;
  onDone: () => void;
  onError: (message: string | null, detail?: string | null) => void;
}) {
  const t = useT();
  const [branches, setBranches] = React.useState<string[]>([]);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");

  const load = () => {
    void listBranches(root).then((b) => setBranches(b.local));
  };

  const go = (branch: string, create = false) => {
    onError(null);
    void switchBranch(root, branch, create).then((res) => {
      if (!res.ok) {
        const plain = explainGitError(res.output);
        onError(plain ? t(plain) : res.output || t("git refused to switch branch."), plain ? res.output : null);
      }
      onDone();
    }).catch((e: unknown) => {
      onError(errorText(e));
      onDone();
    });
  };

  return (
    <>
      <Dropdown.Root onOpenChange={(o) => o && load()}>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            title={t("Switch branch")}
            aria-label={t("Switch branch")}
            className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[12px] text-text transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-brass" />
            <span className="truncate">{current ?? t("detached")}</span>
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content
            align="start"
            sideOffset={4}
            className="z-50 max-h-[300px] min-w-[220px] overflow-auto rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
          >
            {branches.map((b) => (
              <Dropdown.Item
                key={b}
                onSelect={() => b !== current && go(b)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
              >
                <Check className={cn("h-3.5 w-3.5 shrink-0", b !== current && "invisible")} />
                <span className="truncate">{b}</span>
              </Dropdown.Item>
            ))}
            <Dropdown.Separator className="my-1 h-px bg-border" />
            <Dropdown.Item
              onSelect={() => {
                setName("");
                setCreating(true);
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
            >
              <Plus className="h-3.5 w-3.5" /> {t("New branch…")}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent
          title={t("New branch")}
          desc={t("Starts from where you are now. Your uncommitted changes come with you.")}
        >
          <Input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !name.trim()) return;
              go(name.trim(), true);
              setCreating(false);
            }}
            placeholder="feat/findings-export"
            aria-label={t("Branch name")}
            className="font-mono text-xs"
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={() => {
                go(name.trim(), true);
                setCreating(false);
              }}
            >
              {t("Create")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Busy = null | "commit" | "push" | "pull" | "ai";
type Asking = null | "push" | "pr";

/** The working tree: one tickable row per change, or the clean-tree note. */
function ChangeList({
  root,
  changes,
  picked,
  onToggle,
  onPickAll,
}: {
  root: string;
  changes: GitChange[];
  picked: string[];
  onToggle: (path: string) => void;
  onPickAll: (all: boolean) => void;
}) {
  const t = useT();
  const openPath = useBench((s) => s.openPath);
  const pickedPaths = new Set(picked);
  // counted over the rows on screen: `picked` can briefly hold a path the tree lost
  const pickedHere = changes.filter((c) => pickedPaths.has(c.path)).length;
  const allPicked = changes.length > 0 && pickedHere === changes.length;
  // indeterminate is not an attribute — it only exists on the DOM node
  const headerBox = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = pickedHere > 0 && !allPicked;
  }, [pickedHere, allPicked]);
  return (
    <>
      <div className="flex items-center gap-1.5 px-2 pt-2">
        {changes.length > 0 && (
          <input
            ref={headerBox}
            type="checkbox"
            checked={allPicked}
            // from partial the click selects all, never clears a selection in progress
            onChange={() => onPickAll(!allPicked)}
            aria-label={t("Include every change in the commit")}
            className="h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-accent)]"
          />
        )}
        <p className="text-[10px] uppercase tracking-wide text-text-3">
          {changes.length === 1 ? t("1 change") : t("{n} changes", { n: changes.length })}
        </p>
      </div>
      {changes.length === 0 ? (
        <p className="px-2 py-1.5 text-[11px] text-text-3">{t("The working tree is clean.")}</p>
      ) : (
        <div className="py-1">
          {changes.map((change) => {
            const name = change.path.split("/").pop() ?? change.path;
            const { Icon, tone } = fileGlyph(name);
            return (
              <div
                key={`${change.code}${change.path}`}
                className="flex items-center gap-1.5 px-2 py-[3px] text-[12px] hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={pickedPaths.has(change.path)}
                  onChange={() => onToggle(change.path)}
                  aria-label={t("Include {file} in the commit", { file: change.path })}
                  className="h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                />
                <span className={cn("w-4 shrink-0 font-mono text-[10px]", changeTone(change))}>
                  {change.code.trim() || "?"}
                </span>
                <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
                <button
                  type="button"
                  onClick={() => void openPath(`${root}/${change.path}`, name)}
                  title={change.path}
                  className="min-w-0 flex-1 cursor-pointer truncate text-left text-text-2 transition-colors hover:text-text"
                >
                  {change.path}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** The message box and the writes; the message itself is owned by GitPanel. */
function CommitForm({
  message,
  onMessage,
  busy,
  pickedCount,
  ahead,
  behind,
  hasRemote,
  canPullRequest,
  hasUpstream,
  aiValue,
  inventory,
  onWriteMessage,
  onPickEngine,
  onCommit,
  onPush,
  onPull,
  onPullRequest,
}: {
  message: string;
  onMessage: (value: string) => void;
  busy: Busy;
  pickedCount: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  /** The remote's host has a pull request form Assay knows how to open. */
  canPullRequest: boolean;
  /** A branch never pushed has nothing to pull from. */
  hasUpstream: boolean;
  /** The default for commit messages, as a stored choice string. */
  aiValue: string;
  inventory: AIInventory | null;
  onWriteMessage: () => void;
  /** Picking from the caret only changes the engine; writing is the button's job. */
  onPickEngine: (choice: string) => void;
  onCommit: (thenPush: boolean) => void;
  onPush: () => void;
  onPull: () => void;
  onPullRequest: () => void;
}) {
  const t = useT();
  const canCommit = pickedCount > 0 && message.trim().length > 0 && busy === null;
  return (
    <div className="shrink-0 border-t border-border bg-surface p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="flex-1 text-[10px] uppercase tracking-wide text-text-3">{t("Commit message")}</span>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            className="rounded-r-none"
            loading={busy === "ai"}
            disabled={busy !== null || pickedCount === 0}
            onClick={() => onWriteMessage()}
            title={t("Write it from the diff with {engine}", { engine: engineName(aiValue) })}
          >
            <Sparkles className="h-3.5 w-3.5" /> {t("Write with AI")}
          </Button>
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-l-none px-1"
                disabled={busy !== null}
                aria-label={t("Choose the AI for commit messages")}
                title={t("Choose the AI for commit messages")}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content
                align="end"
                side="top"
                sideOffset={6}
                className="z-50 max-h-[360px] w-[280px] overflow-auto rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
              >
                <p className="px-2.5 pb-1 pt-0.5 text-[10px] text-text-3">
                  {t("Used by Write with AI from now on. Also in Settings › AI")}
                </p>
                <AIMenuItems task="commit" inventory={inventory} value={aiValue} onPick={onPickEngine} />
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        </div>
      </div>
      <Textarea
        value={message}
        onChange={(e) => onMessage(e.target.value)}
        rows={2}
        placeholder={t("✨ feat(scope): what this change does")}
        aria-label={t("Commit message")}
        className="text-[12px]"
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button variant="primary" size="sm" disabled={!canCommit} loading={busy === "commit"} onClick={() => onCommit(false)}>
          {t("Commit {n}", { n: pickedCount })}
        </Button>
        <Button variant="secondary" size="sm" disabled={!canCommit} onClick={() => onCommit(true)}>
          {t("Commit & push")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          loading={busy === "push"}
          onClick={onPush}
          title={ahead > 0 ? t("{n} commits to push", { n: ahead }) : t("Push this branch")}
        >
          <Upload className="h-3.5 w-3.5" /> {t("Push")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null || !hasUpstream}
          loading={busy === "pull"}
          onClick={onPull}
          title={
            !hasUpstream
              ? t("This branch has no upstream to pull from")
              : behind > 0
                ? t("{n} commits to pull", { n: behind })
                : t("Pull this branch")
          }
        >
          <Download className="h-3.5 w-3.5" /> {t("Pull")}
        </Button>
        {/* a host whose form is unknown gets no button rather than a link to a 404 */}
        {(canPullRequest || !hasRemote) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null || !hasRemote}
            onClick={onPullRequest}
            title={hasRemote ? t("Push and open the pull request form") : t("No remote configured")}
          >
            <GitPullRequest className="h-3.5 w-3.5" /> {t("Pull request")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Both writes that leave the machine ask here first. */
function PushConfirm({
  asking,
  branch,
  onClose,
  onPush,
  onPullRequest,
}: {
  asking: Asking;
  branch: string | null;
  onClose: () => void;
  onPush: () => void;
  onPullRequest: () => void;
}) {
  const t = useT();
  const pr = asking === "pr";
  const name = branch ?? "";
  return (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(o) => !o && onClose()}
      title={pr ? t("Push and open a pull request?") : t("Push {branch}?", { branch: name })}
      confirmLabel={pr ? t("Push & open") : t("Push")}
      body={
        <p>
          {pr
            ? t("Pushes this branch to the remote, then opens the pull request form in your browser.")
            : t("Sends your commits on {branch} to the remote. Nothing else leaves the machine.", {
                branch: name,
              })}
        </p>
      }
      onConfirm={() => (pr ? onPullRequest() : onPush())}
    />
  );
}

export function GitPanel({ root }: { root: string }) {
  const t = useT();
  const dataVersion = useApp((s) => s.dataVersion);
  const setError = useBench((s) => s.setError);
  const applyGitChanges = useBench((s) => s.applyGitChanges);
  const gitStatus = useBench((s) => s.gitStatus);

  const [state, setState] = React.useState<GitState | null>(null);
  const [commits, setCommits] = React.useState<GitCommit[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState<Busy>(null);
  const [asking, setAsking] = React.useState<Asking>(null);
  const [remote, setRemote] = React.useState<string | null>(null);
  const [hasUpstream, setHasUpstream] = React.useState(false);
  /** Paths the last read knew about — what tells a new change from an unticked one. */
  const seen = React.useRef<Set<string>>(new Set());
  /** The store's status as this panel last left it — its own write is not news. */
  const appliedStatus = React.useRef<typeof gitStatus | null>(null);

  /** Set by the background reload: a read nobody asked for does not spin the button. */
  const quiet = React.useRef(false);

  const load = React.useCallback(() => {
    if (!quiet.current) setLoading(true);
    quiet.current = false;
    void Promise.all([gitState(root), gitLog(root), remoteWebUrl(root), upstreamState(root)])
      .then(([s, c, url, up]) => {
        setState(s);
        setCommits(c);
        setRemote(url);
        setHasUpstream(up.hasUpstream);
        // the tree and the tabs paint from this same read, not a second one
        applyGitChanges(s.repo ? s.changes : []);
        appliedStatus.current = useBench.getState().gitStatus;
        const paths = s.repo ? s.changes.map((x) => x.path) : [];
        // New changes are ticked by default and unticks survive reads, but paths
        // that left the tree are dropped: `git add` fails the whole list when one
        // pathspec matches nothing.
        const live = new Set(paths);
        // read the ref outside the updater: it runs batched, after `seen` has
        // already moved to this read, and nothing would ever look fresh
        const before = seen.current;
        seen.current = live;
        setPicked((cur) => {
          const kept = cur.filter((p) => live.has(p));
          const fresh = paths.filter((p) => !before.has(p) && !kept.includes(p));
          return [...kept, ...fresh];
        });
      })
      .catch(() => setState(null))
      .finally(() => setLoading(false));
  }, [root, applyGitChanges]);

  // a finished run usually means the tree moved
  React.useEffect(load, [load, dataVersion]);

  // the heartbeat replaces `gitStatus` only when the tree changed (often an
  // agent's edit): re-read then, skipping the status this panel wrote itself
  React.useEffect(() => {
    if (appliedStatus.current === null || gitStatus === appliedStatus.current) return;
    quiet.current = true;
    load();
  }, [gitStatus, load]);

  /**
   * Puts a failed git result in the error bar: a plain sentence when one is
   * known, with git's own output underneath. Each action clears the bar first.
   */
  const fail = (res: { ok: boolean; output: string }, fallback: string) => {
    if (res.ok) return false;
    const plain = explainGitError(res.output);
    if (plain) setError(t(plain), res.output);
    else setError(res.output || fallback);
    return true;
  };

  const toggle = (path: string) =>
    setPicked((cur) => (cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]));

  /** All or nothing over what the last read saw. */
  const pickAll = (all: boolean) => setPicked(all ? (state?.changes ?? []).map((c) => c.path) : []);

  // the default lives in Settings and is re-read on every mount
  const { inventory } = useAIInventory();
  const [aiValue, setAiValue] = useTaskChoice("commit");

  const pickEngine = (value: string) => {
    setAiValue(value);
    void setTaskChoice("commit", value).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const writeMessage = () => {
    setError(null);
    const choice = parseAIChoice(aiValue);
    if (!choice) {
      setError(t("No AI is configured for commit messages. Pick one in Settings › AI."));
      return;
    }
    setBusy("ai");
    void (async () => {
      // the new files are named apart: `git diff HEAD` has no way to reach them
      const pickedSet = new Set(picked);
      const fresh = (state?.changes ?? [])
        .filter((c) => c.untracked && pickedSet.has(c.path))
        .map((c) => c.path);
      const diff = await diffForPaths(root, picked, fresh);
      if (!diff.trim()) {
        setError(t("Nothing to describe: the selected files have no changes to read."));
        return;
      }
      const prompt = [
        "Write ONE git commit subject line for this diff. Output only that line, nothing else.",
        "Format: gitmoji + Conventional Commits, e.g. `✨ feat(auth): add magic link login`.",
        "Types: ✨ feat · 🐛 fix · ♻️ refactor · 📝 docs · 🎨 style · ⚡ perf · ✅ test · 🔧 chore · 🔒 security · ⬆️ deps.",
        "English, imperative mood, lowercase after the type, no trailing period, at most 72 characters.",
        "Describe what the change does, not which files moved.",
        "",
        diff,
      ].join("\n");
      const out = await runOneShot(choice, prompt);
      // an agent that explains itself still has to hand back one line
      const line = out
        .split("\n")
        .map((l) => l.trim().replace(/^["'`]|["'`]$/g, ""))
        .find((l) => l.length > 0 && !l.startsWith("```"));
      if (line) setMessage(line);
      else setError(t("The engine returned nothing usable. Write the message by hand."));
    })()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const doCommit = async (): Promise<boolean> => {
    setError(null);
    // Re-read the tree: a file may have vanished since the list was painted, and
    // `git add` aborts the whole list when one pathspec matches nothing.
    const now = await gitState(root);
    const seenNow = new Map((now.repo ? now.changes : []).map((c) => [c.path, c] as const));
    const safe = picked.filter((p) => seenNow.has(p));
    const dropped = picked.length - safe.length;
    if (!safe.length) {
      setError(t("Those files are no longer in the working tree. The list has been refreshed."));
      load();
      return false;
    }
    // Make the index match the ticks. Unticked but staged would be committed
    // anyway, so it is unstaged (the file is untouched).
    const pickedSet = new Set(safe);
    const extras = [...seenNow.values()].filter((c) => c.staged && !pickedSet.has(c.path));
    // a rename is two paths in the index; undoing only the new one keeps the old one's deletion staged
    const cleared = await unstagePaths(root, extras.flatMap((c) => (c.from ? [c.path, c.from] : [c.path])));
    if (fail(cleared, t("git could not unstage those files."))) return false;
    // Stage only ticked paths with a working-tree change: a blank second column
    // (e.g. a staged deletion) matches no pathspec and would abort `git add`.
    const pending = safe
      .map((p) => seenNow.get(p))
      .filter((c): c is GitChange => !!c && c.code[1] !== " ")
      .flatMap((c) => (c.from ? [c.path, c.from] : [c.path]));
    const staged = await stagePaths(root, pending);
    if (fail(staged, t("git could not stage those files."))) return false;
    const done = await commit(root, message.trim());
    if (fail(done, t("git refused the commit."))) return false;
    setMessage("");
    load();
    // vanished files do not block the commit, but the user learns they were left out
    if (dropped > 0)
      setError(
        dropped === 1
          ? t("1 file was no longer in the working tree and was left out of the commit.")
          : t("{n} files were no longer in the working tree and were left out of the commit.", { n: dropped }),
      );
    return true;
  };

  const runCommit = (thenPush: boolean) => {
    setBusy("commit");
    void doCommit()
      .then((ok) => {
        if (ok && thenPush) setAsking("push");
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null));
  };

  const runPush = () => {
    setError(null);
    setBusy("push");
    void push(root)
      .then((res) => {
        fail(res, t("git could not push."));
        load();
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null));
  };

  const openDock = useBench((s) => s.openDock);

  const runPull = () => {
    setError(null);
    setBusy("pull");
    void pull(root)
      .then(async (res) => {
        load();
        if (res.ok) return;
        // a merge that clashed is not a failure to report, it is work to do
        const conflicts = await conflictState(root);
        if (conflicts.files.length) {
          setError(t("The pull brought changes that clash with yours. Resolve them in Conflicts."), res.output);
          openDock("conflicts");
          return;
        }
        fail(res, t("git could not pull."));
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null));
  };

  const openPullRequest = () => {
    setError(null);
    setBusy("push");
    void (async () => {
      const pushed = await push(root);
      if (fail(pushed, t("git could not push."))) return;
      const { branch } = await upstreamState(root);
      if (!remote || !branch) {
        setError(t("This repository has no remote to open a pull request on."));
        return;
      }
      const url = pullRequestUrl(remote, branch);
      if (!url) {
        setError(t("Assay does not know how to open a pull request on this host."));
        return;
      }
      await openUrl(url);
      load();
    })()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  if (loading && !state) return <p className="px-3 py-3 text-[11px] text-text-3">{t("reading…")}</p>;
  if (!state?.repo) {
    return <p className="px-3 py-3 text-[11px] text-text-3">{t("This folder is not a git repository.")}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-soft px-2 py-1.5">
        <BranchMenu root={root} current={state.branch} onDone={load} onError={setError} />
        {/* a slot that is always there: a push that empties it must not move the row */}
        <span
          className="tnum ml-auto min-w-[3.5rem] shrink-0 text-right text-[10px] text-text-3"
          title={
            state.ahead > 0 || state.behind > 0
              ? t("{ahead} to push, {behind} to pull", { ahead: state.ahead, behind: state.behind })
              : undefined
          }
        >
          {state.ahead > 0 && `↑${state.ahead}`}
          {state.behind > 0 && ` ↓${state.behind}`}
        </span>
        <button
          type="button"
          onClick={load}
          title={t("Reload")}
          aria-label={t("Reload")}
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <ChangeList root={root} changes={state.changes} picked={picked} onToggle={toggle} onPickAll={pickAll} />

        <p className="border-t border-border-soft px-2 pt-2 text-[10px] uppercase tracking-wide text-text-3">
          {t("Recent commits")}
        </p>
        <div className="pb-2">
          {commits.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-text-3">{t("No commits yet.")}</p>
          ) : (
            commits.map((c) => <CommitRow key={c.hash} commit={c} />)
          )}
        </div>
      </div>

      <CommitForm
        message={message}
        onMessage={setMessage}
        busy={busy}
        pickedCount={picked.length}
        ahead={state.ahead}
        behind={state.behind}
        hasRemote={!!remote}
        canPullRequest={supportsPullRequest(remote)}
        hasUpstream={hasUpstream}
        aiValue={aiValue}
        inventory={inventory}
        onWriteMessage={writeMessage}
        onPickEngine={pickEngine}
        onCommit={runCommit}
        onPush={() => setAsking("push")}
        onPull={runPull}
        onPullRequest={() => setAsking("pr")}
      />

      <PushConfirm
        asking={asking}
        branch={state.branch}
        onClose={() => setAsking(null)}
        onPush={runPush}
        onPullRequest={openPullRequest}
      />
    </div>
  );
}
