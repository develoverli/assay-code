import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  AlertTriangle,
  Code2,
  LineChart,
  PanelLeft,
  ChevronsUpDown,
  FolderGit2,
  History,
  Settings,
  ShieldAlert,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import * as React from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useApp, useRunningCount } from "@/store/app";
import { liveTerminals, useBench } from "@/store/bench";
import { useUI, type View } from "@/store/ui";
import { useDeploy } from "@/store/deploy";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { RunDock } from "@/components/RunDock";
import { StatusBar } from "@/components/layout/StatusBar";
import {
  macTrafficLightInset,
  nativeFrame,
  useFrameStyling,
  useMaximized,
} from "@/lib/window-frame";
import { WindowControls } from "@/components/layout/WindowChrome";
import { UpdateChip } from "@/features/updates/UpdateChip";
import { RunWindow } from "@/components/RunWindow";
import { RunDetail } from "@/features/audit/RunDetail";
import { ProjectsView } from "@/features/projects/ProjectsView";
import { ProjectActivity, useOrderedProjects } from "@/features/projects/ProjectActivity";
import { ToolsView } from "@/features/tools/ToolsView";
import { FindingsView } from "@/features/findings/FindingsView";
import { BenchView } from "@/features/bench/BenchView";
import { AuditView } from "@/features/audit/AuditView";
import { SkillsView } from "@/features/skills/SkillsView";
import { CommandsView } from "@/features/commands/CommandsView";
import { SettingsView } from "@/features/settings/SettingsView";
import { ProcessesView } from "@/features/processes/ProcessesView";
import { StatsView } from "@/features/stats/StatsView";

const NAV: { id: View; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "findings", label: "Findings", icon: ShieldAlert },
  { id: "bench", label: "Workspace", icon: Code2 },
  { id: "audit", label: "Audit", icon: History },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "commands", label: "Commands", icon: Terminal },
  { id: "processes", label: "Processes", icon: Activity },
  { id: "stats", label: "Stats", icon: LineChart },
  { id: "settings", label: "Settings", icon: Settings },
];

/** The assay streak: the mark a tested sample leaves, thinning as it goes. */
function AssayMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Assay">
      <g stroke="currentColor" strokeWidth={7} strokeLinecap="round" fill="none">
        <path d="M16 46 L34 16" />
        <path d="M28 46 L40 26" opacity={0.62} />
        <path d="M40 46 L46 36" opacity={0.34} />
      </g>
    </svg>
  );
}

/**
 * The version the bundle was built as, asked of Tauri once. In plain `pnpm dev`
 * (a browser, no Tauri) there is nobody to ask, and nothing is shown rather
 * than a number that could be wrong.
 */
function useAppVersion(): string | null {
  const [version, setVersion] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {
        if (alive) setVersion(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  return version;
}

function Sidebar() {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const version = useAppVersion();
  const t = useT();
  // select the count, not the array: the log stream mutates runs many times a second
  const running = useRunningCount();
  const terminals = useBench((s) => liveTerminals(s.terminals).length);
  const busy = running + terminals;
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
      <div
        data-tauri-drag-region
        className="flex h-9 items-center gap-2.5 border-b border-border px-4"
        style={nativeFrame ? { paddingLeft: macTrafficLightInset } : undefined}
      >
        <AssayMark className="pointer-events-none h-5 w-5 shrink-0 text-brass" />
        <span className="pointer-events-none text-[13px] font-semibold tracking-tight">Assay</span>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {NAV.map((n) => {
          const active = view === n.id;
          return (
            <button
              type="button"
              key={n.id}
              onClick={() => setView(n.id)}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors cursor-pointer",
                active ? "bg-accent-soft text-accent font-medium" : "text-text-2 hover:bg-surface-2 hover:text-text",
              )}
            >
              <n.icon className="h-4 w-4 shrink-0" />
              {t(n.label)}
              {n.id === "processes" && running > 0 && (
                <span className="tnum ml-auto rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  {running}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-t border-border bg-surface px-4 text-[10px] text-text-3">
        {version && (
          <>
            <span className="tnum">v{version}</span>
            <span>·</span>
          </>
        )}
        {busy > 0 ? (
          <span className="flex items-center gap-1.5 text-accent">
            <span
              className="h-1.5 w-1.5 rounded-full bg-accent"
              style={{ animation: "assay-pulse 1.4s ease-in-out infinite" }}
              aria-hidden
            />
            <span className="tnum">{t("{n} working", { n: busy })}</span>
          </span>
        ) : (
          <span>{t("idle")}</span>
        )}
      </div>
    </aside>
  );
}

function scrollIntoViewOnMount(el: HTMLElement | null) {
  el?.scrollIntoView({ block: "nearest" });
}

function ProjectSwitcher() {
  const activeProjectId = useApp((s) => s.activeProjectId);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const projects = useOrderedProjects();
  const t = useT();
  const active = projects.find((p) => p.id === activeProjectId);
  if (!projects.length) return <span className="text-xs text-text-3">{t("No projects yet")}</span>;
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" className="flex h-7 items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text hover:bg-surface-3 cursor-pointer">
          <span className="max-w-[220px] truncate font-medium">{active?.name ?? t("Select project")}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 text-text-3" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="start"
          sideOffset={6}
          // about five and a half rows: the cut-off one says the list goes on
          className="z-50 max-h-[min(272px,var(--radix-dropdown-menu-content-available-height))] min-w-[240px] overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
        >
          {projects.map((p) => (
            <Dropdown.Item
              key={p.id}
              // the list opens scrolled to where you are, not to the top
              ref={p.id === activeProjectId ? scrollIntoViewOnMount : undefined}
              onSelect={() => setActiveProject(p.id)}
              className={cn(
                "flex cursor-pointer flex-col rounded-md px-2.5 py-1.5 text-[13px] outline-none",
                p.id === activeProjectId ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text",
              )}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{p.name}</span>
                <ProjectActivity projectId={p.id} compact />
              </span>
              <span className="truncate font-mono text-[10px] text-text-3">{p.path ?? p.url}</span>
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function ErrorBar() {
  const error = useApp((s) => s.error);
  const setError = useApp((s) => s.setError);
  const t = useT();
  if (!error) return null;
  return (
    <div className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 selectable">{error}</span>
      <button
        type="button"
        onClick={() => setError(null)}
        aria-label={t("Dismiss error")}
        title={t("Dismiss")}
        className="cursor-pointer text-danger/70 hover:text-danger"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Content() {
  const view = useUI((s) => s.view);
  switch (view) {
    case "projects":
      return <ProjectsView />;
    case "tools":
      return <ToolsView />;
    case "findings":
      return <FindingsView />;
    case "bench":
      return <BenchView />;
    case "audit":
      return <AuditView />;
    case "skills":
      return <SkillsView />;
    case "commands":
      return <CommandsView />;
    case "processes":
      return <ProcessesView />;
    case "stats":
      return <StatsView />;
    case "settings":
      return <SettingsView />;
  }
}

export function AppShell() {
  const selectedRunId = useUI((s) => s.selectedRunId);
  const sidebarHidden = useUI((s) => s.sidebarHidden);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const initUI = useUI((s) => s.initUI);
  const t = useT();
  const maximized = useMaximized();
  useFrameStyling(maximized);
  // Workspace's own footer carries the status line; it exists whenever the
  // project has a folder (without one Workspace is an empty state, no footer)
  const onBench = useUI((s) => s.view === "bench");
  const hasFolder = useApp((s) => !!s.projects.find((p) => p.id === s.activeProjectId)?.path);
  const benchFooter = onBench && hasFolder;

  React.useEffect(() => {
    void initUI();
  }, [initUI]);

  // auto-upload servers are watched from launch, whichever view is open:
  // an agent working in the background is exactly who they are for
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const syncDeployWatchers = useDeploy((s) => s.syncWatchers);
  React.useEffect(() => {
    void syncDeployWatchers(projects, activeProjectId);
  }, [projects, activeProjectId, syncDeployWatchers]);

  // Ctrl/Cmd+B, the shortcut every editor and browser already uses for this
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key !== "b" && e.key !== "B")) return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-text">
      {!sidebarHidden && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region
          className="flex h-9 shrink-0 items-center gap-3 border-b border-border px-3"
          // with no sidebar the traffic lights land on the header instead
          style={nativeFrame && sidebarHidden ? { paddingLeft: macTrafficLightInset } : undefined}
        >
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarHidden ? t("Show the sidebar") : t("Hide the sidebar")}
            title={`${sidebarHidden ? t("Show the sidebar") : t("Hide the sidebar")} (Ctrl+B)`}
            className={cn(
              "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
              sidebarHidden ? "text-accent hover:bg-accent-soft" : "text-text-3 hover:bg-surface-2 hover:text-text",
            )}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <ProjectSwitcher />
          <div data-tauri-drag-region className="h-full flex-1" />
          <UpdateChip />
          <WindowControls maximized={maximized} />
        </header>
        <ErrorBar />
        <main className="min-h-0 flex-1 overflow-auto">
          <Content />
        </main>
        <RunDock />
        {!benchFooter && <StatusBar />}
      </div>
      <RunWindow />
      {selectedRunId && <RunDetail runId={selectedRunId} />}
    </div>
  );
}
