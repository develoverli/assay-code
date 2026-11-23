import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  Check,
  CloudUpload,
  FolderOpen,
  GitBranch,
  GitMerge,
  MessageSquareCode,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  ShieldAlert,
  SquareCode,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { probe, runTokens } from "@/lib/exec";
import * as React from "react";
import { useBench, type DockPanel } from "@/store/bench";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { FilesPanel } from "./FilesPanel";
import { ConflictsPanel } from "./ConflictsPanel";
import { FindingsPanel } from "./FindingsPanel";
import { GitPanel } from "./GitPanel";
import { SessionsPanel } from "./SessionsPanel";
import { DeployPanel, useDeployBadge } from "@/features/deploy/DeployPanel";
import { useApp } from "@/store/app";

/**
 * The right dock: a rail of panels, always visible even when folded, plus
 * whichever panel is open. Only the fold button folds it.
 */

/** Files has no rail entry: the fold button reopens the dock on the last panel. */
const PANELS: { id: DockPanel; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "search", label: "Search", icon: Search },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "deploy", label: "Deploy", icon: CloudUpload },
  { id: "conflicts", label: "Conflicts", icon: GitMerge },
  { id: "sessions", label: "Sessions", icon: MessageSquareCode },
  { id: "findings", label: "Findings", icon: ShieldAlert },
];

/** Hidden-file toggles, and opening the folder in VS Code or the file manager. */
function FilesMenu({ root }: { root: string }) {
  const t = useT();
  const showIgnored = useBench((s) => s.showIgnored);
  const toggleShowIgnored = useBench((s) => s.toggleShowIgnored);
  const showDotfiles = useBench((s) => s.showDotfiles);
  const toggleShowDotfiles = useBench((s) => s.toggleShowDotfiles);
  const setError = useBench((s) => s.setError);
  const [hasCode, setHasCode] = React.useState(false);

  React.useEffect(() => {
    void probe("code --version").then(setHasCode);
  }, []);

  const item =
    "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text";

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          title={t("More")}
          aria-label={t("More")}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:bg-surface-2 data-[state=open]:text-text"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[230px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
        >
          <Dropdown.Item className={item} onSelect={toggleShowDotfiles}>
            <Check className={cn("h-3.5 w-3.5", !showDotfiles && "invisible")} />
            {t("Show dotfiles")}
          </Dropdown.Item>
          <Dropdown.Item className={item} onSelect={toggleShowIgnored}>
            <Check className={cn("h-3.5 w-3.5", !showIgnored && "invisible")} />
            {t("Show build output and VCS folders")}
          </Dropdown.Item>
          <Dropdown.Separator className="my-1 h-px bg-border" />
          <Dropdown.Item
            className={cn(item, !hasCode && "cursor-not-allowed opacity-50")}
            disabled={!hasCode}
            onSelect={() => {
              // argv, not a string: the path is one argument whatever it holds, no quoting
              void runTokens(["code", root]).result.catch((e: unknown) =>
                setError(e instanceof Error ? e.message : String(e)),
              );
            }}
          >
            <SquareCode className="h-3.5 w-3.5" />
            {t("Open in VS Code")}
            {!hasCode && <span className="ml-auto text-[10px]">{t("not installed")}</span>}
          </Dropdown.Item>
          <Dropdown.Item
            className={item}
            onSelect={() => {
              void revealItemInDir(root).catch((e: unknown) =>
                setError(e instanceof Error ? e.message : String(e)),
              );
            }}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("Open in the file manager")}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function DockRail() {
  const t = useT();
  const dock = useBench((s) => s.dock);
  const openDock = useBench((s) => s.openDock);
  const toggleDock = useBench((s) => s.toggleDock);
  // a count, not the map: the heartbeat replaces the map, the number rarely moves
  const conflicts = useBench((s) => Object.values(s.gitStatus).filter((v) => v === "conflict").length);
  const projectId = useApp((s) => s.activeProjectId);
  const deploy = useDeployBadge(projectId ?? "");

  return (
    <nav
      aria-label={t("Code panels")}
      className="flex w-9 shrink-0 flex-col items-center gap-1 border-l border-border bg-surface py-2"
    >
      <button
        type="button"
        onClick={toggleDock}
        aria-expanded={!!dock}
        title={dock ? t("Fold the panel") : t("Unfold the panel")}
        aria-label={dock ? t("Fold the panel") : t("Unfold the panel")}
        className={cn(
          "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors",
          "focus-visible:outline-2 focus-visible:outline-accent",
          dock ? "bg-accent-soft text-accent" : "text-text-3 hover:bg-surface-2 hover:text-text",
        )}
      >
        {dock ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
      </button>
      <span className="my-0.5 h-px w-5 bg-border" aria-hidden />
      {PANELS.map((p) => {
        const active = dock === p.id;
        // Conflicts is only there while there is something to resolve — or while
        // it is open, so finishing the merge does not pull the panel out from under you
        if (p.id === "conflicts" && !conflicts && !active) return null;
        let badge = p.id === "conflicts" && conflicts > 0 ? conflicts : 0;
        // what the default server has not received yet, the way an editor counts unsaved files
        if (p.id === "deploy") badge = deploy.pending;
        return (
          <button
            type="button"
            key={p.id}
            onClick={() => openDock(p.id)}
            aria-pressed={active}
            title={badge ? t("{label} ({n})", { label: t(p.label), n: badge }) : t(p.label)}
            aria-label={badge ? t("{label} ({n})", { label: t(p.label), n: badge }) : t(p.label)}
            className={cn(
              "relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors",
              "focus-visible:outline-2 focus-visible:outline-accent",
              active
                ? "bg-accent-soft text-accent"
                : badge && p.id === "conflicts"
                  ? "text-warn hover:bg-surface-2"
                  : "text-text-3 hover:bg-surface-2 hover:text-text-2",
            )}
          >
            <p.icon className="h-4 w-4" />
            {badge > 0 && (
              <span
                aria-hidden
                className={cn(
                  "tnum absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-semibold leading-none",
                  p.id === "deploy" ? "bg-accent text-accent-fg" : "bg-warn text-bg",
                )}
              >
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function DockPanelBody({
  root,
  rootName,
  projectId,
  width,
}: {
  root: string;
  rootName: string;
  projectId: string;
  width: number;
}) {
  const t = useT();
  const dock = useBench((s) => s.dock);
  const setSearchMode = useBench((s) => s.setSearchMode);
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const [treeSeq, setTreeSeq] = React.useState(0);

  // the Search rail entry opens on the tree: file names first, In files is one click away
  React.useEffect(() => {
    if (dock === "search") setSearchMode(root, "names");
  }, [dock, root, setSearchMode]);

  if (!dock) return null;

  let heading = rootName;
  if (dock === "findings") heading = t("Findings");
  else if (dock === "git") heading = t("Git");
  else if (dock === "deploy") heading = t("Deploy");
  else if (dock === "conflicts") heading = t("Conflicts");
  else if (dock === "sessions") heading = t("Sessions");
  const filesPanel = dock === "files" || dock === "search";

  return (
    <aside style={{ width }} className="flex shrink-0 flex-col border-l border-border bg-surface">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-2" title={root}>
          {heading}
        </span>
        {filesPanel && (
          <>
            <button
              type="button"
              onClick={() => setTreeSeq((n) => n + 1)}
              title={t("Reload the tree")}
              aria-label={t("Reload")}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <FilesMenu root={root} />
          </>
        )}
      </header>

      {dock === "findings" && <FindingsPanel root={root} projectId={projectId} />}
      {dock === "git" && <GitPanel root={root} />}
      {dock === "deploy" && project && <DeployPanel project={project} />}
      {dock === "conflicts" && <ConflictsPanel root={root} />}
      {dock === "sessions" && <SessionsPanel root={root} />}
      {filesPanel && <FilesPanel key={treeSeq} root={root} />}
    </aside>
  );
}
