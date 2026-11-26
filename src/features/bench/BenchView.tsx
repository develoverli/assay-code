import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { DeployChip } from "@/features/deploy/DeployChip";
import { PortsChip, TunnelsElsewhere } from "@/features/ports/PortsChip";
import { AlertTriangle, FolderGit2, FolderOpen, GitBranch, Globe, Plus, SquareTerminal, Trash2, X } from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import * as React from "react";
import { useApp } from "@/store/app";
import type { Project } from "@/types";
import { ProjectDialog } from "@/features/projects/ProjectDialog";
import { hiddenTerminals, liveTerminals, terminalsFor, useBench, type TermSession } from "@/store/bench";
import { resolveShell, type ShellSpec } from "@/lib/bench-term";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { launcherGlyph } from "./icons";
import { DockPanelBody, DockRail } from "./CodeDock";
import { WorkArea } from "./WorkArea";
import { remoteWebUrl } from "@/lib/git";
import { GitHubMark } from "@/features/github/GitHubMark";
import { ClaudeUsage } from "@/components/layout/ClaudeUsage";
import { MemoryReading, useMemoryUsage } from "@/components/layout/StatusBar";

/**
 * Workspace (view id `bench`): terminals and open files in one work area on the
 * left, the panel dock on the right. State lives in the store, so leaving the
 * view costs nothing.
 */

/** How often the tree re-reads git while the window has focus. */
const GIT_POLL_MS = 10_000;

const MIN_PANEL = 200;
const MIN_WORK = 320;
const DEFAULT_PANEL = 272;

function BenchError() {
  const error = useBench((s) => s.error);
  const errorDetail = useBench((s) => s.errorDetail);
  const setError = useBench((s) => s.setError);
  const t = useT();
  if (!error) return null;
  const detail = errorDetail?.error === error ? errorDetail.text : null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger"
    >
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="selectable">{error}</span>
        {detail && (
          <span className="line-clamp-3 whitespace-pre-wrap font-mono text-[10px] text-text-3 selectable" title={detail}>
            {detail}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => setError(null)}
        aria-label={t("Dismiss")}
        title={t("Dismiss")}
        className="cursor-pointer rounded transition-colors hover:text-text"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Sessions still running outside this project (another project's, or none):
 * go to one or kill it.
 */
function HiddenTerminals({ sessions }: { sessions: TermSession[] }) {
  const t = useT();
  const projects = useApp((s) => s.projects);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const setActiveTerminal = useBench((s) => s.setActiveTerminal);
  const setProject = useBench((s) => s.setProject);
  const closeTerminal = useBench((s) => s.closeTerminal);
  const [killing, setKilling] = React.useState<TermSession | null>(null);

  const goTo = (term: TermSession) => {
    const owner = projects.find((p) => p.id === term.projectId);
    if (!owner) return;
    setActiveProject(owner.id);
    // switch Bench here rather than waiting for the effect, which would restore
    // that project's remembered tab on top of the one actually asked for
    setProject(owner.id, owner.path ?? null);
    setActiveTerminal(term.id);
  };

  const item =
    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] outline-none transition-colors";

  return (
    <>
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            className={cn(
              "tnum shrink-0 cursor-pointer rounded px-1 transition-colors",
              "text-text-3 hover:bg-surface-2 hover:text-text",
              "focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:text-text",
            )}
            title={t("Still running outside this project")}
          >
            {sessions.length === 1
              ? t("1 in another project")
              : t("{n} in other projects", { n: sessions.length })}
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content
            align="end"
            side="top"
            sideOffset={6}
            className="z-50 min-w-[240px] rounded-lg border border-border bg-surface p-1.5 shadow-2xl animate-in"
          >
            {sessions.map((term, i) => {
              const owner = projects.find((p) => p.id === term.projectId);
              const { Icon, tone } = launcherGlyph(term.kind);
              return (
                <React.Fragment key={term.id}>
                  {i > 0 && <Dropdown.Separator className="my-1 h-px bg-border-soft" />}
                  {/* two items, not a row with buttons in it: a menu closes on Tab,
                      so anything nested inside a row is unreachable by keyboard */}
                  {owner && (
                    <Dropdown.Item
                      className={cn(item, "text-text-2 data-[highlighted]:bg-surface-2 data-[highlighted]:text-text")}
                      onSelect={() => goTo(term)}
                    >
                      <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
                      <span className="min-w-0 flex-1 truncate" title={term.cwd}>
                        {term.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-text-3">{owner.name}</span>
                    </Dropdown.Item>
                  )}
                  <Dropdown.Item
                    className={cn(item, "text-text-3 data-[highlighted]:bg-danger/10 data-[highlighted]:text-danger")}
                    onSelect={() => setKilling(term)}
                  >
                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {owner
                        ? t("Kill {name}", { name: term.title })
                        : t("Kill {name} — no project", { name: term.title })}
                    </span>
                  </Dropdown.Item>
                </React.Fragment>
              );
            })}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>

      <ConfirmDialog
        open={!!killing}
        onOpenChange={(o) => !o && setKilling(null)}
        danger
        title={t("Kill this session?")}
        confirmLabel={t("Kill and close")}
        body={
          <p>
            {t(
              "{name} is still running. Closing the tab kills it, and anything it was in the middle of is lost.",
              { name: killing?.title ?? "" },
            )}
          </p>
        }
        onConfirm={() => {
          if (killing) void closeTerminal(killing.id);
          setKilling(null);
        }}
      />
    </>
  );
}

/** `example.com` for `https://example.com/`. */
function siteLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The project's published site; with none saved, opens the project dialog on the URL field. */
function SiteLink({ project }: { project: Project }) {
  const t = useT();
  const setError = useApp((s) => s.setError);
  const [edit, setEdit] = React.useState(false);
  const url = project.url?.trim();
  const cls =
    "flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1 rounded px-1 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <>
      {url ? (
        <button
          type="button"
          className={cls}
          title={t("Open {url} in the browser", { url })}
          onClick={() => void openUrl(url).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
        >
          <Globe className="h-3 w-3 shrink-0" />
          <span className="truncate">{siteLabel(url)}</span>
          <span aria-hidden>↗</span>
        </button>
      ) : (
        <button type="button" className={cls} onClick={() => setEdit(true)}>
          <Plus className="h-3 w-3 shrink-0" />
          {t("Add URL")}
        </button>
      )}
      <ProjectDialog open={edit} onOpenChange={setEdit} project={project} focus="url" />
    </>
  );
}

/** `remoteWebUrl` already answers with a clean http(s) URL; this only takes it apart for the host. */
function publicRepoUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The repository behind `origin`, read from git so it works for any project, cloned here or not. */
function RepoLink({ root }: { root: string }) {
  const t = useT();
  const setError = useApp((s) => s.setError);
  const [repo, setRepo] = React.useState<URL | null>(null);

  React.useEffect(() => {
    let alive = true;
    setRepo(null);
    void remoteWebUrl(root)
      .then((raw) => {
        if (alive) setRepo(publicRepoUrl(raw));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [root]);

  // no remote, no button: there is nothing to go to
  if (!repo) return null;
  const where = `${repo.host}${repo.pathname}`;
  const label = t("Open {repo} in the browser", { repo: where });
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => void openUrl(repo.href).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
      className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
    >
      {repo.host === "github.com" ? <GitHubMark className="h-3 w-3" /> : <GitBranch className="h-3 w-3" />}
    </button>
  );
}

/** The project folder as an icon: the path in its tooltip, the file manager on a click. */
function FolderLink({ path }: { path: string }) {
  const t = useT();
  const setError = useApp((s) => s.setError);
  return (
    <button
      type="button"
      title={path}
      aria-label={t("Show {path} in the file manager", { path })}
      onClick={() => void revealItemInDir(path).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
      className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
    >
      <FolderOpen className="h-3 w-3" />
    </button>
  );
}

/**
 * The view's whole status line (the shell's StatusBar is not mounted here):
 * Claude's limits, which give way first when narrow, then project links,
 * sessions and memory.
 */
function BenchFooter({ path, projectId, project }: { path: string; projectId: string; project: Project }) {
  const t = useT();
  const memory = useMemoryUsage();
  const terminals = useBench((s) => s.terminals);
  const [shell, setShell] = React.useState<ShellSpec | null>(null);
  const live = liveTerminals(terminalsFor(terminals, projectId)).length;
  const elsewhere = hiddenTerminals(terminals, projectId);

  React.useEffect(() => {
    void resolveShell()
      .then(setShell)
      .catch(() => setShell(null));
  }, []);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-surface px-3 text-[10px] text-text-3">
      <div className="min-w-0 flex-1 overflow-hidden">
        <ClaudeUsage />
      </div>
      <SiteLink project={project} />
      <RepoLink root={path} />
      <FolderLink path={path} />
      <DeployChip project={project} />
      <PortsChip projectId={projectId} />
      {shell && (
        <span className="flex shrink-0 items-center gap-1" title={shell.program}>
          <SquareTerminal className="h-3 w-3" />
          {shell.label}
        </span>
      )}
      <span className="tnum shrink-0">
        {live === 1 ? t("1 terminal") : t("{n} terminals", { n: live })}
      </span>
      {elsewhere.length > 0 && <HiddenTerminals sessions={elsewhere} />}
      <TunnelsElsewhere projectId={projectId} />
      {memory && <MemoryReading usage={memory} />}
    </footer>
  );
}

export function BenchView() {
  const t = useT();
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const dock = useBench((s) => s.dock);
  const restoreTerminals = useBench((s) => s.restoreTerminals);
  const setProject = useBench((s) => s.setProject);
  const refreshGitStatus = useBench((s) => s.refreshGitStatus);
  const focusSearch = useBench((s) => s.focusSearch);
  const project = projects.find((p) => p.id === activeProjectId);

  // terminals and files are kept for every project at once; this is what decides
  // which of them are on screen, and it remembers the tab each one was left on
  React.useEffect(() => {
    if (project) setProject(project.id, project.path ?? null);
  }, [project?.id, project?.path, setProject]);

  // git status heartbeat: catches an agent's edits, and only beats while the window has focus
  React.useEffect(() => {
    if (!project?.path) return;
    void refreshGitStatus();
    const tick = () => {
      if (document.hasFocus()) void refreshGitStatus();
    };
    const id = window.setInterval(tick, GIT_POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, [project?.id, project?.path, refreshGitStatus]);

  // a dev-server reload wipes the store but not the PTYs, so pick them back up.
  // Read through a ref: the recovery runs once, with whatever projects exist then
  const projectsRef = React.useRef(projects);
  React.useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  React.useEffect(() => {
    void restoreTerminals(projectsRef.current);
  }, [restoreTerminals]);

  // the two shortcuts every editor has: quick open, and search in files
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if ((e.key === "p" || e.key === "P") && !e.shiftKey) {
        e.preventDefault();
        focusSearch("names");
      } else if ((e.key === "f" || e.key === "F") && e.shiftKey) {
        e.preventDefault();
        focusSearch("content");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusSearch]);

  const [panelWidth, setPanelWidth] = React.useState(DEFAULT_PANEL);
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const dragging = React.useRef(false);

  const clampWidth = React.useCallback((next: number) => {
    const box = rowRef.current?.getBoundingClientRect();
    const max = box ? Math.max(box.width - MIN_WORK, MIN_PANEL) : next;
    return Math.min(Math.max(next, MIN_PANEL), max);
  }, []);

  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !rowRef.current) return;
      const box = rowRef.current.getBoundingClientRect();
      setPanelWidth(clampWidth(box.right - e.clientX));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [clampWidth]);

  if (!project) {
    return (
      <div className="p-5">
        <EmptyState
          icon={FolderGit2}
          title={t("No project selected")}
          desc={t("Pick one in the header to work on it.")}
        />
      </div>
    );
  }

  if (!project.path) {
    return (
      <div className="p-5">
        <EmptyState
          icon={FolderGit2}
          title={t("This project has no local folder")}
          desc={t(
            "{project} only has a URL. Add a path to it in Projects to open its files and terminals here.",
            { project: project.name },
          )}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={rowRef} className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <BenchError />
          <WorkArea cwd={project.path} />
        </div>

        {dock && (
          <>
            {/* a real button so the handle is natively focusable for the arrow keys */}
            <button
              type="button"
              aria-label={t("Resize the panel")}
              onMouseDown={() => {
                dragging.current = true;
                document.body.style.cursor = "col-resize";
              }}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 64 : 16;
                if (e.key === "ArrowLeft") setPanelWidth((w) => clampWidth(w + step));
                else if (e.key === "ArrowRight") setPanelWidth((w) => clampWidth(w - step));
                else return;
                e.preventDefault();
              }}
              className={cn(
                "w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent",
                "focus-visible:bg-accent focus-visible:outline-none",
              )}
            />
            {/* keyed by project so a switch drops every panel's local state
                (staged files, commit message, expanded folders) */}
            <DockPanelBody
              key={project.id}
              root={project.path}
              rootName={project.name}
              projectId={project.id}
              width={panelWidth}
            />
          </>
        )}

        <DockRail />
      </div>
      <BenchFooter path={project.path} projectId={project.id} project={project} />
    </div>
  );
}
