import { Archive, CheckCircle2, Download, FolderOpen, GitFork, Lock, RefreshCw, Search, XCircle } from "lucide-react";
import * as React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import { useGitHub } from "@/store/github";
import { detectStack } from "@/lib/detect";
import {
  cloneCommandPreview,
  cloneDestination,
  cloneRepo,
  filterRepos,
  getCloneRoot,
  listRepos,
  samePath,
  withGitHubToken,
  TokenRejectedError,
  setCloneRoot,
  type Repo,
} from "@/lib/github";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Badge, Button, Field, Input, Spinner } from "@/components/ui/primitives";
import { Terminal } from "@/components/ui/terminal";
import { useT } from "@/lib/i18n";
import { useDates } from "@/lib/dates";
import { GitHubConnect } from "./GitHubConnect";

/** Enough lines of git's progress to see it moving, not enough to become a log viewer. */
const LOG_TAIL_LINES = 6;

type Repos = { kind: "loading" } | { kind: "ready"; repos: Repo[] } | { kind: "error"; message: string };

type Clone =
  | { kind: "idle" }
  | { kind: "running"; repo: Repo; log: string }
  | { kind: "done"; repo: Repo; dest: string }
  | { kind: "failed"; repo: Repo; log: string; message: string };

/** git prints progress with carriage returns; keep only what the last few lines say. */
function tail(log: string, lines: number): string {
  return log.split(/\r?\n|\r/).filter(Boolean).slice(-lines).join("\n");
}

function RepoRow({
  repo,
  cloned,
  busy,
  onClone,
}: {
  repo: Repo;
  /** Already a project in Assay, so the button offers nothing. */
  cloned: boolean;
  /** Another clone is running: one working tree at a time. */
  busy: boolean;
  onClone: () => void;
}) {
  const t = useT();
  const dates = useDates();
  return (
    <li className="flex items-center gap-3 border-b border-border-soft px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[12px] text-text">
            <span className="text-text-3">{repo.owner}/</span>
            {repo.name}
          </span>
          {repo.private && (
            <Lock className="h-3 w-3 shrink-0 text-text-3" aria-label={t("private")}>
              <title>{t("private")}</title>
            </Lock>
          )}
          {repo.fork && (
            <GitFork className="h-3 w-3 shrink-0 text-text-3" aria-label={t("fork")}>
              <title>{t("fork")}</title>
            </GitFork>
          )}
          {repo.archived && (
            <Badge tone="warn">
              <Archive className="h-3 w-3" /> {t("archived")}
            </Badge>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-text-3">
          {repo.language && <span className="shrink-0">{repo.language}</span>}
          {repo.description && <span className="truncate">{repo.description}</span>}
          <span className="ml-auto shrink-0 tnum">{dates.ago(repo.pushedAt)}</span>
        </div>
      </div>
      {cloned ? (
        <Badge tone="success">
          <CheckCircle2 className="h-3 w-3" /> {t("in Assay")}
        </Badge>
      ) : (
        <Button
          variant="subtle"
          size="sm"
          disabled={busy}
          title={busy ? t("Wait for the current clone to finish") : undefined}
          onClick={onClone}
        >
          <Download className="h-3.5 w-3.5" /> {t("Clone")}
        </Button>
      )}
    </li>
  );
}

/**
 * Projects › Clone from GitHub: lists the account's repositories, streams git's
 * progress, and registers the clone as a project with its stack detected.
 */
export function CloneDialog({ open: isOpen, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT();
  const { account, loaded, load, forgetRejected } = useGitHub();
  const projects = useApp((s) => s.projects);
  const createProject = useApp((s) => s.createProject);
  const syncGithubVisibility = useApp((s) => s.syncGithubVisibility);
  const [repos, setRepos] = React.useState<Repos>({ kind: "loading" });
  const [query, setQuery] = React.useState("");
  const [root, setRoot] = React.useState("");
  const [clone, setClone] = React.useState<Clone>({ kind: "idle" });
  const cloning = clone.kind === "running";

  React.useEffect(() => {
    if (!isOpen) return;
    if (!loaded) void load();
    void getCloneRoot().then(setRoot);
    setClone({ kind: "idle" });
  }, [isOpen, loaded, load]);

  const linked = !!account;
  const fetchRepos = React.useCallback(async () => {
    if (!linked) return;
    setRepos({ kind: "loading" });
    try {
      // renewed on the way when it is about to expire; the store picks up the new one
      const listed = await withGitHubToken(listRepos);
      void load();
      setRepos({ kind: "ready", repos: listed });
      // the listing already says who is private: the cards learn it for free
      void syncGithubVisibility(listed).catch(() => {});
    } catch (e) {
      // the connect row takes over, with a Reconnect button and the reason
      if (e instanceof TokenRejectedError) await forgetRejected(e.detail);
      else setRepos({ kind: "error", message: (e as Error).message });
    }
  }, [linked, load, forgetRejected, syncGithubVisibility]);

  React.useEffect(() => {
    if (isOpen && linked) void fetchRepos();
  }, [isOpen, linked, fetchRepos]);

  // "in Assay" means a project already lives where this clone would land, so
  // pointing the root somewhere else offers the same repository again
  const projectPaths = React.useMemo(() => projects.map((p) => p.path).filter((p): p is string => !!p), [projects]);
  const trimmedRoot = root.trim();
  const isCloned = (repo: Repo) => {
    if (!trimmedRoot) return false;
    const dest = cloneDestination(trimmedRoot, repo.name);
    return projectPaths.some((p) => samePath(p, dest));
  };

  const visible = React.useMemo(
    () => (repos.kind === "ready" ? filterRepos(repos.repos, query) : []),
    [repos, query],
  );

  const pickRoot = async () => {
    const sel = await open({ directory: true, multiple: false, defaultPath: root || undefined });
    if (typeof sel === "string") {
      setRoot(sel);
      await setCloneRoot(sel);
    }
  };

  const start = async (repo: Repo) => {
    if (!linked || !root.trim()) return;
    await setCloneRoot(root.trim());
    setClone({ kind: "running", repo, log: "" });
    let log = "";
    try {
      const r = await withGitHubToken((token) =>
        cloneRepo(repo, root.trim(), token, (chunk) => {
          log += chunk;
          setClone({ kind: "running", repo, log });
        }),
      );
      if (r.code !== 0) {
        setClone({ kind: "failed", repo, log, message: t("git exited with code {code}", { code: String(r.code ?? "?") }) });
        return;
      }
      const stack = await detectStack(r.dest);
      await createProject({ name: repo.name, path: r.dest, url: null, stack, authorized: false, github_repo: repo.fullName, github_private: repo.private });
      setClone({ kind: "done", repo, dest: r.dest });
    } catch (e) {
      if (e instanceof TokenRejectedError) await forgetRejected(e.detail);
      setClone({ kind: "failed", repo, log, message: (e as Error).message });
    }
  };

  const noRoot = !root.trim();

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(v) => {
        // a clone in flight has a git process behind it; closing would only hide it
        if (!v && cloning) return;
        onOpenChange(v);
      }}
    >
      <DialogContent
        title={t("Clone from GitHub")}
        desc={t("Pick a repository; it is cloned into the folder below and added as a project.")}
        className="w-[min(680px,92vw)]"
      >
        {!account ? (
          <GitHubConnect />
        ) : (
          <div className="flex flex-col gap-4">
            <Field
              label={t("Clone into")}
              hint={t("Each repository gets its own folder here, named after it.")}
              htmlFor="clone-root"
            >
              <div className="flex gap-2">
                <Input
                  id="clone-root"
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                  onBlur={() => void setCloneRoot(root.trim())}
                  placeholder={t("Choose a folder")}
                  className="font-mono text-xs"
                  disabled={cloning}
                />
                <Button variant="secondary" type="button" onClick={() => void pickRoot()} disabled={cloning}>
                  <FolderOpen className="h-3.5 w-3.5" /> {t("Browse")}
                </Button>
              </div>
            </Field>

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("Filter by name or description")}
                  aria-label={t("Filter repositories")}
                  className="pl-8"
                />
              </div>
              {repos.kind === "ready" && (
                <span className="shrink-0 text-[11px] text-text-3 tnum">
                  {t("{n} of {total}", { n: String(visible.length), total: String(repos.repos.length) })}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("Reload")}
                title={t("Reload")}
                onClick={() => void fetchRepos()}
                disabled={repos.kind === "loading"}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>

            {noRoot && (
              <p className="text-[11px] text-warn">{t("Choose a folder to clone into before picking a repository.")}</p>
            )}

            <div className="max-h-[40vh] overflow-auto rounded-md border border-border bg-surface-2">
              {repos.kind === "loading" && (
                <div className="flex items-center gap-2 px-3 py-6 text-[11px] text-text-3">
                  <Spinner className="h-3.5 w-3.5" /> {t("Asking GitHub for your repositories…")}
                </div>
              )}
              {repos.kind === "error" && (
                <p role="alert" className="flex items-start gap-1.5 px-3 py-6 text-[11px] text-danger">
                  <XCircle className="mt-px h-3.5 w-3.5 shrink-0" /> {repos.message}
                </p>
              )}
              {repos.kind === "ready" && visible.length === 0 && (
                <p className="px-3 py-6 text-[11px] text-text-3">
                  {repos.repos.length === 0 ? t("This account sees no repositories.") : t("Nothing matches that filter.")}
                </p>
              )}
              {repos.kind === "ready" && visible.length > 0 && (
                <ul>
                  {visible.map((r) => (
                    <RepoRow
                      key={r.id}
                      repo={r}
                      cloned={isCloned(r)}
                      busy={cloning || noRoot}
                      onClone={() => void start(r)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {clone.kind !== "idle" && (
              <div className="flex flex-col gap-2 animate-in">
                <p className="font-mono text-[11px] text-text-3 selectable">
                  $ {cloneCommandPreview(clone.repo, root.trim())}
                </p>
                {clone.kind === "running" && (
                  <>
                    <Terminal text={tail(clone.log, LOG_TAIL_LINES) || t("starting git…")} className="max-h-32" />
                    <p className="flex items-center gap-1.5 text-[11px] text-text-3">
                      <Spinner className="h-3.5 w-3.5" /> {t("Cloning {repo}…", { repo: clone.repo.fullName })}
                    </p>
                  </>
                )}
                {clone.kind === "done" && (
                  <p className="flex items-start gap-1.5 text-[11px] text-success">
                    <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>
                      {t("Cloned and added as a project.")}{" "}
                      <span className="font-mono text-text-3 selectable">{clone.dest}</span>
                    </span>
                  </p>
                )}
                {clone.kind === "failed" && (
                  <>
                    {clone.log && <Terminal text={tail(clone.log, LOG_TAIL_LINES)} className="max-h-32" />}
                    <p role="alert" className="flex items-start gap-1.5 text-[11px] text-danger">
                      <XCircle className="mt-px h-3.5 w-3.5 shrink-0" /> {clone.message}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
