import { ChevronDown, Download, ExternalLink, EyeOff, FileCode2, FileText, Globe, Hammer, Info, ListChecks, Network, Package, Play, RefreshCw, SlidersHorizontal, Terminal as TermIcon, Wrench } from "lucide-react";
import * as React from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useApp, blockedReason } from "@/store/app";
import * as db from "@/lib/db";
import type { Project, Tool, ToolKind } from "@/types";
import { Badge, Button, Card, EmptyState } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ViewHeader } from "@/components/layout/ViewHeader";
import { ToolOptionsDialog } from "@/features/tools/ToolOptionsDialog";
import { RunAllDialog } from "@/features/tools/RunAllDialog";
import {
  AgentSkillsButton,
  GraphifyAgentsDialog,
  useAgentSkills,
} from "@/features/tools/GraphifyAgentsDialog";
import { cn } from "@/lib/utils";
import { schemaFor } from "@/lib/tool-options";
import { canonicalTags, stackApplies } from "@/lib/detect";
import { installPlanFor } from "@/lib/installers";
import { installBinary } from "@/lib/sandbox";
import { checkTool, lintCommandPreview, MANAGED_TOOL_IDS, type Availability } from "@/lib/runner";
import {
  addToGitignore,
  detectInstallCommand,
  gitignoreState,
  graphArtifacts,
  graphifyCommandLines,
  graphifyInstalled,
  graphState,
  installGraphify,
  modeFor,
  GITIGNORE_LINES,
  GITIGNORE_UNTRACK_COMMAND,
  GRAPHIFY_TOOL_ID,
  PYTHON_INSTALL_URL,
  type GitignoreState,
  type GraphArtifactId,
  type GraphFile,
  type GraphMode,
  type GraphState,
  type InstallCommand,
} from "@/lib/graphify";
import { useDates } from "@/lib/dates";
import { useT } from "@/lib/i18n";

const KIND_ICON: Record<ToolKind, React.ComponentType<{ className?: string }>> = {
  npx: Package,
  docker: Package,
  cli: TermIcon,
  "cli-agent": FileCode2,
};

/**
 * Which of these tools this machine actually has, probed when the view opens
 * rather than stored. `undefined` means "still asking": the buttons stay live.
 */
function useAvailability(tools: Tool[]): {
  map: Record<string, Availability | undefined>;
  recheck: (tool: Tool) => Promise<void>;
} {
  const [map, setMap] = React.useState<Record<string, Availability>>({});
  const ids = tools.map((x) => x.id).join(",");

  React.useEffect(() => {
    let ignore = false;
    void Promise.all(tools.map(async (x) => [x.id, await checkTool(x)] as const)).then((pairs) => {
      if (!ignore) setMap(Object.fromEntries(pairs));
    });
    return () => {
      ignore = true;
    };
    // the identity of `tools` changes on every store write; the set of ids does not
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  // after an install, ask again about that one rather than re-probing everything
  const recheck = React.useCallback(async (tool: Tool) => {
    const next = await checkTool(tool);
    setMap((cur) => ({ ...cur, [tool.id]: next }));
  }, []);

  return { map, recheck };
}

/**
 * Install a package with the machine's own package manager (`uv`, `pipx` or
 * `pip --user`), showing the resolved command before anything runs.
 */
function CommandInstallButton({ onInstalled }: { onInstalled: () => void }) {
  const t = useT();
  const setError = useApp((s) => s.setError);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [plan, setPlan] = React.useState<InstallCommand | null | undefined>(undefined);

  React.useEffect(() => {
    if (!open) return;
    let ignore = false;
    void detectInstallCommand().then((p) => {
      if (!ignore) setPlan(p);
    });
    return () => {
      ignore = true;
    };
  }, [open]);

  return (
    <>
      <Button variant="secondary" size="sm" loading={busy} onClick={() => setOpen(true)}>
        <Download className="h-3.5 w-3.5" /> {t("Install")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("Install Graphify?")}
        confirmLabel={t("Install")}
        confirmDisabled={!plan}
        body={
          <div className="flex flex-col gap-2">
            {plan === undefined && <span>{t("Looking for a Python package manager…")}</span>}
            {plan === null && (
              <span>
                {t(
                  "No Python package manager found (uv, pipx or pip). Install uv first, then try again.",
                )}{" "}
                <button
                  type="button"
                  className="cursor-pointer underline"
                  onClick={() => void openUrl(PYTHON_INSTALL_URL)}
                >
                  {PYTHON_INSTALL_URL}
                </button>
              </span>
            )}
            {plan && (
              <>
                <span>{t("Runs this command, with the package manager already on this machine:")}</span>
                <code className="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-2 selectable break-all">
                  {plan.tokens.join(" ")}
                </code>
                <span className="text-text-3">
                  {t("Nothing is written into your project, and no install script is piped into a shell.")}
                </span>
              </>
            )}
          </div>
        }
        onConfirm={() => {
          if (!plan) return;
          setBusy(true);
          void installGraphify(() => {})
            .then(async () => {
              onInstalled();
              // uv and pipx install into the user's bin directory, which a running
              // process does not see on its PATH until restarted
              if (!(await graphifyInstalled())) {
                setError(
                  t("Graphify was installed, but it is not on Assay's PATH yet — restart Assay to pick it up."),
                );
              }
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      />
    </>
  );
}

/** The way out of "not installed": install it, or link to how when Assay can't. */
function InstallButton({ tool, onInstalled }: { tool: Tool; onInstalled: () => void }) {
  const t = useT();
  const setError = useApp((s) => s.setError);
  const [busy, setBusy] = React.useState(false);
  const plan = installPlanFor(tool);
  if (!plan) return null;

  if (plan.kind === "command") return <CommandInstallButton onInstalled={onInstalled} />;

  if (plan.kind === "link") {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void openUrl(plan.url)}
        title={plan.url}
      >
        <ExternalLink className="h-3.5 w-3.5" /> {t("How to install")}
      </Button>
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      loading={busy}
      title={t("Assay downloads the official release into its own folder")}
      onClick={() => {
        setBusy(true);
        void installBinary(plan.id, () => {})
          .then(onInstalled)
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
    >
      <Download className="h-3.5 w-3.5" /> {t("Install")}
    </Button>
  );
}

function applies(tool: Tool, project?: Project): { ok: boolean; reason?: string } {
  if (!project) return { ok: false, reason: "Select a project first" };
  if (tool.scope === "local" && !project.path) return { ok: false, reason: "Project has no local folder" };
  if (tool.scope === "url" && !project.url) return { ok: false, reason: "Project has no URL" };
  return { ok: true };
}

/** A live target has to be acknowledged as the user's own before it is scanned. */
function needsAuthorization(tool: Tool, project?: Project): boolean {
  return tool.scope === "url" && !!project && !project.authorized;
}

/**
 * The tool targets stacks this project doesn't have — it will probably find
 * nothing. Still only a note: running it anyway is the user's call.
 */
function stackMismatch(tool: Tool, project?: Project): boolean {
  return !!project && !stackApplies(tool.stack, project.stack);
}

/**
 * Why the buttons beside it are dead. Long reasons are clipped so they never
 * push the buttons out of the card; the full sentence is in the tooltip.
 */
function BlockedReason({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="min-w-0 max-w-[22ch] truncate text-[10px] text-text-3 sm:max-w-[40ch]" title={text}>
      {text}
    </span>
  );
}

type RunMode = "inapp" | "terminal";

// Orchestrated tools (Assay drives several steps and reads an API) can't be
// handed to an external terminal — the run would produce no findings.
const NO_TERMINAL_TOOL_IDS = new Set<string>(["sonarqube", "eslint", "ruff", "semgrep", "gitleaks"]);

/** The two tools that really do run out of Assay's own install. */
const SANDBOX_TOOL_IDS = new Set<string>(["eslint", "ruff"]);

const DEFAULT_STRIX_DEPTH = "quick";

/** Resolve the tool's placeholders against the project, mode and stored scan depth. */
function useCommandPreview(tool: Tool, project: Project | undefined, mode: RunMode | null): string {
  const [strixMode, setStrixMode] = React.useState(DEFAULT_STRIX_DEPTH);
  React.useEffect(() => {
    if (tool.id === "strix") void db.getSetting("strix.scanMode").then((v) => setStrixMode(v || DEFAULT_STRIX_DEPTH));
  }, [tool.id]);

  // sandboxed linters don't run their stored command — Assay builds it from the options
  if (MANAGED_TOOL_IDS.has(tool.id)) return lintCommandPreview(tool);

  let preview = tool.cmd.replaceAll("{depth}", strixMode);
  if (project) preview = preview.replaceAll("{url}", project.url ?? "").replaceAll("{path}", project.path ?? ".");
  // terminal mode runs strix interactively (no -n)
  if (tool.id === "strix" && mode === "terminal") preview = preview.replace(/\s-n\b/, "");
  return preview;
}

/** What the tool is and where it can point — kind, scope and the stacks it targets. */
function ToolBadges({ tool }: { tool: Tool }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[13px] font-semibold">{tool.name}</span>
      <Badge>{tool.kind}</Badge>
      <Badge tone={tool.scope === "url" ? "accent" : "neutral"}>
        {tool.scope === "url" ? <Globe className="h-3 w-3" /> : null}
        {tool.scope}
      </Badge>
      {tool.stack.map((s) => (
        <Badge key={s}>{s}</Badge>
      ))}
    </div>
  );
}

/** Run in-app or hand the command to a terminal, with the reason when neither is possible. */
function ToolActions({
  tool,
  ok,
  reason,
  blocked,
  onRun,
  onConfigure,
}: {
  tool: Tool;
  ok: boolean;
  reason?: string;
  blocked: string | null;
  onRun: (mode: RunMode) => void;
  onConfigure?: () => void;
}) {
  const t = useT();
  const disabled = !ok || !!blocked;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {disabled && <BlockedReason text={reason ? t(reason) : blocked} />}
      <div className="flex shrink-0 items-center gap-1.5">
        {onConfigure && (
          <Button variant="ghost" size="sm" onClick={onConfigure} title={t("Choose which checks run")}>
            <SlidersHorizontal className="h-3.5 w-3.5" /> {t("Configure")}
          </Button>
        )}
        <Button variant="primary" size="sm" disabled={disabled} onClick={() => onRun("inapp")} title={blocked ?? undefined}>
          <Play className="h-3.5 w-3.5" /> {t("Run")}
        </Button>
        {!NO_TERMINAL_TOOL_IDS.has(tool.id) && (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onRun("terminal")}
            title={blocked ?? t("Open in an external terminal window")}
          >
            <ExternalLink className="h-3.5 w-3.5" /> {t("Terminal")}
          </Button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- graphify ---------------------------------- */
/** Whether this project already has a graph, re-asked on project change or run end (`dataVersion`). */
function useGraphState(path?: string | null): GraphState {
  const version = useApp((s) => s.dataVersion);
  const [state, setState] = React.useState<GraphState>({ built: false, at: null });

  React.useEffect(() => {
    let ignore = false;
    void graphState(path).then((s) => {
      if (!ignore) setState(s);
    });
    return () => {
      ignore = true;
    };
  }, [path, version]);

  return state;
}

/** The pages and the report on disk for this project, re-asked on the same signal as the graph. */
function useGraphArtifacts(path?: string | null): GraphFile[] {
  const version = useApp((s) => s.dataVersion);
  const [files, setFiles] = React.useState<GraphFile[]>([]);

  React.useEffect(() => {
    let ignore = false;
    void graphArtifacts(path).then((f) => {
      if (!ignore) setFiles(f);
    });
    return () => {
      ignore = true;
    };
  }, [path, version]);

  return files;
}

/**
 * Open what the run wrote with the system opener. Each item shows the file's
 * real name, since that is what the user will look for in the folder.
 */
function ArtifactsMenu({ files }: { files: GraphFile[] }) {
  const t = useT();
  const setError = useApp((s) => s.setError);
  const label: Record<GraphArtifactId, string> = {
    html: t("Interactive graph"),
    tree: t("File tree"),
    callflow: t("Call flow"),
    report: t("Report"),
  };

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <Button variant="ghost" size="sm" title={t("Open what the last run wrote")}>
          <FileText className="h-3.5 w-3.5" /> {t("Open")}
          <ChevronDown className="h-3 w-3 text-text-3" aria-hidden />
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[220px] rounded-lg border border-border bg-surface p-1.5 shadow-2xl animate-in"
        >
          {files.map((f) => (
            <Dropdown.Item
              key={f.path}
              className="flex cursor-pointer flex-col rounded-md px-2.5 py-1.5 text-[13px] text-text-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
              onSelect={() => {
                void openPath(f.path).catch((e: unknown) =>
                  setError(e instanceof Error ? e.message : String(e)),
                );
              }}
            >
              <span>{label[f.id]}</span>
              <span className="font-mono text-[10px] text-text-3">{f.name}</span>
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/**
 * Whether this project still needs the `.gitignore` entry. Re-asked on the same
 * signal as the graph, and by hand right after the write so the offer disappears.
 */
function useGitignore(path?: string | null): GitignoreState & { refresh: () => void } {
  const version = useApp((s) => s.dataVersion);
  const [nonce, setNonce] = React.useState(0);
  const [state, setState] = React.useState<GitignoreState>({
    repo: false,
    ignored: false,
    tracked: 0,
    file: "",
    exists: false,
  });

  React.useEffect(() => {
    let ignore = false;
    void gitignoreState(path).then((next) => {
      if (!ignore) setState(next);
    });
    return () => {
      ignore = true;
    };
  }, [path, version, nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

/**
 * Shows the exact lines before writing them into a versioned file. When the graph
 * is already tracked it names `git rm --cached` for the user to run; Assay never
 * runs it, since dropping files from the index is a different act.
 */
function GitignoreConfirm({
  state,
  open,
  onOpenChange,
  onConfirm,
}: {
  state: GitignoreState;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useT();

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("Add graphify-out/ to .gitignore?")}
      confirmLabel={t("Add to .gitignore")}
      body={
        <div className="flex flex-col gap-2">
          <span>
            {state.exists
              ? t("These two lines are appended to {path}. Nothing else in the file is touched.", {
                  path: state.file,
                })
              : t("{path} does not exist yet — it is created with these two lines.", {
                  path: state.file,
                })}
          </span>
          <code className="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-[11px] whitespace-pre text-text-2 selectable break-all">
            {GITIGNORE_LINES}
          </code>
          {state.tracked > 0 && (
            <>
              <span className="text-warn">
                {t(
                  "{n} files under graphify-out/ are already tracked: the entry alone will not remove them. Run this yourself:",
                  { n: state.tracked },
                )}
              </span>
              <code className="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-2 selectable break-all">
                {GITIGNORE_UNTRACK_COMMAND}
              </code>
            </>
          )}
        </div>
      }
      onConfirm={onConfirm}
    />
  );
}

/**
 * Graphify's buttons are its states: a missing graph can only be built; an
 * existing one is updated (only what changed) or rebuilt from scratch.
 */
function GraphifyActions({
  state,
  files,
  ok,
  reason,
  blocked,
  canIgnore,
  onIgnore,
  onRun,
  onConfigure,
}: {
  state: GraphState;
  files: GraphFile[];
  ok: boolean;
  reason?: string;
  blocked: string | null;
  canIgnore: boolean;
  onIgnore: () => void;
  onRun: (mode: GraphMode) => void;
  onConfigure: () => void;
}) {
  const t = useT();
  const { ago } = useDates();
  const disabled = !ok || !!blocked;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {disabled && <BlockedReason text={reason ? t(reason) : blocked} />}
      {!disabled && state.built && (
        <span
          className="shrink-0 text-[10px] whitespace-nowrap text-text-3"
          title={t("When the graph was last written")}
        >
          {t("graph built {when}", { when: ago(state.at) })}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        {canIgnore && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onIgnore}
            title={t("Keep graphify-out/ out of the repository")}
          >
            <EyeOff className="h-3.5 w-3.5" /> {t("Ignore in git")}
          </Button>
        )}
        {files.length > 0 && <ArtifactsMenu files={files} />}
        <Button variant="ghost" size="sm" onClick={onConfigure} title={t("Choose which checks run")}>
          <SlidersHorizontal className="h-3.5 w-3.5" /> {t("Configure")}
        </Button>
        {state.built ? (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={disabled}
              onClick={() => onRun("update")}
              title={blocked ?? t("Re-reads only the files that changed. No LLM, no key.")}
            >
              <RefreshCw className="h-3.5 w-3.5" /> {t("Update")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => onRun("rebuild")}
              title={blocked ?? t("Throws the graph away and extracts the whole project again")}
            >
              <Hammer className="h-3.5 w-3.5" /> {t("Rebuild")}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={disabled}
            onClick={() => onRun("build")}
            title={blocked ?? t("Extracts the whole project into graphify-out/")}
          >
            <Network className="h-3.5 w-3.5" /> {t("Build graph")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** What each mode is about to do, in the words of the button that was pressed. */
function GraphifyConfirm({
  tool,
  project,
  mode,
  onOpenChange,
  onConfirm,
}: {
  tool: Tool;
  project: Project;
  mode: GraphMode | null;
  onOpenChange: (o: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const TITLES: Record<GraphMode, string> = {
    build: t("Build the graph for {project}?", { project: project.name }),
    rebuild: t("Rebuild the graph for {project}?", { project: project.name }),
    update: t("Update the graph for {project}?", { project: project.name }),
  };

  return (
    <ConfirmDialog
      open={mode !== null}
      onOpenChange={onOpenChange}
      title={mode ? TITLES[mode] : ""}
      confirmLabel={t("Run")}
      body={
        <div className="flex flex-col gap-2">
          <span>
            {t("Runs this command")} {t("in")}{" "}
            <span className="font-mono text-text">{project.path}</span>:
          </span>
          {/* the extraction, then whatever the options asked it to write afterwards */}
          <div className="flex flex-col gap-1">
            {(mode ? graphifyCommandLines(tool, mode, project.path) : []).map((line) => (
              <code
                key={line}
                className="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-2 selectable break-all"
              >
                {line}
              </code>
            ))}
          </div>
          <span className="text-text-3">
            {t(
              "graphify writes only into graphify-out/ inside the project, and nothing else in it is touched. It runs to the end on its own — nothing to confirm halfway through.",
            )}
          </span>
          {mode === "rebuild" && (
            <span className="text-text-3">
              {t("The current graph is replaced. Update is the cheap one when nothing was renamed.")}
            </span>
          )}
        </div>
      }
      onConfirm={onConfirm}
    />
  );
}

/**
 * The last stop before a tool actually runs: the resolved command, the target it
 * points at, and — for live targets — the authorization the user has to accept.
 */
function RunConfirm({
  tool,
  project,
  mode,
  preview,
  needsAuth,
  mismatch,
  onOpenChange,
  onConfirm,
}: {
  tool: Tool;
  project: Project;
  mode: RunMode | null;
  preview: string;
  needsAuth: boolean;
  mismatch: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const terminal = mode === "terminal";
  let confirmLabel = t("Run");
  if (needsAuth) confirmLabel = t("I'm authorized — run");
  else if (terminal) confirmLabel = t("Open terminal");

  return (
    <ConfirmDialog
      open={mode !== null}
      onOpenChange={onOpenChange}
      title={terminal ? t("Open {tool} in a terminal?", { tool: tool.name }) : t("Run {tool}?", { tool: tool.name })}
      confirmLabel={confirmLabel}
      danger={needsAuth}
      body={
        <div className="flex flex-col gap-2">
          <span>
            {terminal ? t("Opens a new terminal window running:") : t("Runs this command")}
            {tool.scope === "url" ? (
              <>
                {" "}
                {t("against")} <span className="font-mono text-text">{project.url}</span>
              </>
            ) : (
              <>
                {" "}
                {t("in")} <span className="font-mono text-text">{project.path}</span>
              </>
            )}
            :
          </span>
          <code className="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-2 selectable break-all">
            {preview}
          </code>
          {needsAuth && (
            <span className="text-warn">
              {t(
                "Live target — only scan what you own or are authorized to test. Confirming marks this project authorized.",
              )}
            </span>
          )}
          {SANDBOX_TOOL_IDS.has(tool.id) && (
            <span className="text-text-3">
              {t(
                "Runs from Assay's own linter sandbox — the project's lint config is never read or written. The first run installs it, which takes a minute.",
              )}
            </span>
          )}
          {tool.adapter === "sonarqube" && (
            <span className="text-text-3">
              {t(
                "Assay starts the SonarQube container if it isn't running (first boot takes ~1-2 min), uploads the analysis, then pulls issues, security hotspots and the quality gate back into Findings.",
              )}
            </span>
          )}
          {mismatch && (
            <span className="text-text-3">
              {t("Note: {project} looks like {own}, but this tool targets {target} — it may find nothing.", {
                project: project.name,
                own: canonicalTags(project.stack).join(", "),
                target: canonicalTags(tool.stack).join(", "),
              })}
            </span>
          )}
        </div>
      }
      onConfirm={onConfirm}
    />
  );
}

/** The "not installed" badge and its installer, or nothing when the tool is there. */
function ToolAvailability({
  tool,
  available,
  onInstalled,
}: {
  tool: Tool;
  available?: Availability;
  onInstalled: () => void;
}) {
  const t = useT();
  if (!available || available.ok) return null;
  return (
    <>
      <Badge tone="warn" title={available.reason ?? undefined}>
        {t("not installed")}
      </Badge>
      <InstallButton tool={tool} onInstalled={onInstalled} />
    </>
  );
}

function ToolRow({
  tool,
  project,
  available,
  onInstalled,
}: {
  tool: Tool;
  project?: Project;
  available?: Availability;
  onInstalled: () => void;
}) {
  // one field each: the log stream rewrites `runs` many times a second, and a
  // row only needs to know whether its project is blocked
  const scan = useApp((s) => s.scan);
  const runExternal = useApp((s) => s.runExternal);
  const updateProject = useApp((s) => s.updateProject);
  const buildGraph = useApp((s) => s.buildGraph);
  const setError = useApp((s) => s.setError);
  const blocked = useApp((s) => blockedReason(s.runs, s.maxConcurrent, project?.id));
  const t = useT();
  const [pending, setPending] = React.useState<RunMode | null>(null);
  const [configuring, setConfiguring] = React.useState(false);
  const [info, setInfo] = React.useState(false);
  const isGraph = tool.id === GRAPHIFY_TOOL_ID;
  const [graphPending, setGraphPending] = React.useState<GraphMode | null>(null);
  const [agentsOpen, setAgentsOpen] = React.useState(false);
  const graph = useGraphState(isGraph ? project?.path : null);
  const graphFiles = useGraphArtifacts(isGraph ? project?.path : null);
  const gitignore = useGitignore(isGraph ? project?.path : null);
  const [ignoring, setIgnoring] = React.useState(false);
  // only graphify has a skill to install into an agent, and only once the CLI
  // that installs it is on the machine
  const agents = useAgentSkills(isGraph && available?.ok === true);
  const Icon = isGraph ? Network : KIND_ICON[tool.kind];
  const configurable = !!schemaFor(tool);
  // a tool that isn't on the machine outranks every other reason: it cannot run
  const a = available && !available.ok ? { ok: false, reason: available.reason ?? undefined } : applies(tool, project);
  const needsAuth = needsAuthorization(tool, project);
  const preview = useCommandPreview(tool, project, pending);

  const confirmRun = () => {
    if (!project || !pending) return;
    const go = () => {
      // the run streams into the dock like every other entry point's; nothing
      // moves the user to Findings minutes later from wherever they went
      if (pending === "inapp") void scan(project.id, tool.id);
      else void runExternal(project.id, tool.id);
      setPending(null);
    };
    if (needsAuth) void updateProject(project.id, { authorized: true }).then(go);
    else go();
  };

  return (
    <Card className="flex flex-col gap-1.5 p-2.5">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-2">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ToolBadges tool={tool} />
          <ToolAvailability tool={tool} available={available} onInstalled={onInstalled} />
          {tool.notes && (
            <button
              type="button"
              onClick={() => setInfo((v) => !v)}
              aria-expanded={info}
              aria-label={t("What this tool does")}
              title={t("What this tool does")}
              className={cn(
                "flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors",
                "focus-visible:outline-2 focus-visible:outline-accent",
                info ? "bg-accent-soft text-accent" : "text-text-3 hover:bg-surface-2 hover:text-text",
              )}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          )}
          {isGraph && available?.ok && (
            <AgentSkillsButton
              stale={agents.stale}
              // an agent installed from a terminal since the view opened is the
              // normal case here, so the folders are asked again on the way in
              onClick={() => {
                agents.refresh();
                setAgentsOpen(true);
              }}
            />
          )}
        </div>
        {isGraph ? (
          <GraphifyActions
            state={graph}
            files={graphFiles}
            ok={a.ok}
            reason={a.reason}
            blocked={blocked}
            // nothing to ignore before there is a graph, outside a repository,
            // or where some rule already covers it
            canIgnore={graph.built && gitignore.repo && !gitignore.ignored}
            onIgnore={() => setIgnoring(true)}
            onRun={setGraphPending}
            onConfigure={() => setConfiguring(true)}
          />
        ) : (
          <ToolActions
            tool={tool}
            ok={a.ok}
            reason={a.reason}
            blocked={blocked}
            onRun={setPending}
            onConfigure={configurable ? () => setConfiguring(true) : undefined}
          />
        )}
      </div>

      {info && tool.notes && (
        <div className="rounded-md border border-border-soft bg-surface-2 px-2 py-1.5">
          <p className="text-[11px] leading-relaxed text-text-2">{tool.notes}</p>
          {isGraph ? (
            graphifyCommandLines(tool, modeFor(graph), project?.path).map((line) => (
              <p key={line} className="mt-1 truncate font-mono text-[10px] text-text-3 selectable">
                {line}
              </p>
            ))
          ) : (
            <p className="mt-1 truncate font-mono text-[10px] text-text-3 selectable">
              {MANAGED_TOOL_IDS.has(tool.id) ? lintCommandPreview(tool) : tool.cmd}
            </p>
          )}
        </div>
      )}

      {configurable && (
        <ToolOptionsDialog tool={tool} open={configuring} onOpenChange={setConfiguring} />
      )}

      {isGraph && (
        <GraphifyAgentsDialog open={agentsOpen} onOpenChange={setAgentsOpen} state={agents} />
      )}

      {project?.path && isGraph && (
        <GitignoreConfirm
          state={gitignore}
          open={ignoring}
          onOpenChange={setIgnoring}
          onConfirm={() => {
            const root = project.path as string;
            setIgnoring(false);
            void addToGitignore(root)
              .then(() => gitignore.refresh())
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
          }}
        />
      )}

      {project && isGraph && (
        <GraphifyConfirm
          tool={tool}
          project={project}
          mode={graphPending}
          onOpenChange={(o) => !o && setGraphPending(null)}
          onConfirm={() => {
            if (graphPending) void buildGraph(project.id, graphPending);
            setGraphPending(null);
          }}
        />
      )}

      {project && !isGraph && (
        <RunConfirm
          tool={tool}
          project={project}
          mode={pending}
          preview={preview}
          needsAuth={needsAuth}
          mismatch={stackMismatch(tool, project)}
          onOpenChange={(o) => !o && setPending(null)}
          onConfirm={confirmRun}
        />
      )}
    </Card>
  );
}

export function ToolsView() {
  const tools = useApp((s) => s.tools);
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const scanAll = useApp((s) => s.scanAll);
  const blocked = useApp((s) => blockedReason(s.runs, s.maxConcurrent, s.activeProjectId));
  const t = useT();
  const [runningAll, setRunningAll] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const list = tools.filter((t) => t.source === "tool");
  const { map: availability, recheck } = useAvailability(list);

  return (
    <div className="mx-auto max-w-4xl p-5">
      <ViewHeader
        title={t("Tools")}
        subtitle={
          project
            ? t("Run against: {project}", { project: project.name })
            : t("Select a project to run tools against.")
        }
        action={
          project && (
            <Button
              variant="primary"
              loading={runningAll}
              disabled={!!blocked}
              title={
                blocked ??
                t("Runs every enabled tool that applies to this project, one after another")
              }
              onClick={() => setPicking(true)}
            >
              <ListChecks className="h-4 w-4" /> {t("Run all")}
            </Button>
          )
        }
      />

      {project && (
        <RunAllDialog
          project={project}
          open={picking}
          onOpenChange={setPicking}
          onRun={(ids) => {
            setRunningAll(true);
            void scanAll(project.id, ids).finally(() => setRunningAll(false));
          }}
        />
      )}
      {list.length === 0 ? (
        <EmptyState icon={Wrench} title={t("No tools")} desc={t("Built-in tools failed to seed.")} />
      ) : (
        <div className="flex flex-col gap-2.5">
          {list.map((t) => (
            <ToolRow
              key={t.id}
              tool={t}
              project={project}
              available={availability[t.id]}
              onInstalled={() => void recheck(t)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
