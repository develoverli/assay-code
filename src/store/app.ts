import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AIProvider, Finding, FindingStatus, Project, Tag, TagColor, Tool, ToolConfig } from "@/types";
import * as db from "@/lib/db";
import * as sonar from "@/lib/sonar";
import { useUI } from "@/store/ui";
import { checkTool, launchInTerminal, revertFix, startCommand, startFix, startGraphifyRun, startLintScan, startScan, startSkill, startSonarScan, startVerify, MANAGED_TOOL_IDS, NON_SCAN_TOOL_IDS, type ActiveRun, type RunCallbacks, type SkillLike } from "@/lib/runner";
import { graphState, modeFor, GRAPHIFY_TOOL_ID, type GraphMode } from "@/lib/graphify";
import { notify } from "@/lib/notify";
import { detectChecks, defaultSelection } from "@/lib/verify";
import { detectStack, stackApplies } from "@/lib/detect";
import { tr } from "@/lib/i18n";
import { engineAvailable } from "@/lib/ai";
import { sortByLastUse } from "@/lib/project-activity";

/**
 * A project's stack is detected once per session, the first time it is opened:
 * every click would sweep the tree for nothing, never would miss a new language.
 */
const stackChecked = new Set<string>();

const MAX_CONCURRENT_SETTING = "runs.maxConcurrent";

/** An agent run without its CLI never starts — same rule as a missing scanner. */
async function missingEngine(
  set: (s: Partial<AppState>) => void,
  provider: AIProvider,
): Promise<boolean> {
  if (await engineAvailable(provider)) return false;
  set({ error: tr("{binary} is not installed, or not on PATH.", { binary: provider }) });
  return true;
}

/** Default cap on parallel runs — each Sonar scan alone costs a JVM. */
const DEFAULT_MAX_CONCURRENT = 3;

/** `unattended` is the scheduler: its scans leave the project's place in the list alone. */
interface RunOpts {
  unattended?: boolean;
}

export interface LiveRun {
  runId: string;
  projectId: string;
  projectName: string;
  label: string;
  cmd: string;
  status: "running" | "done" | "error" | "cancelled";
  log: string;
  startedAt: number;
  finishedAt?: number;
}

/** Runs still executing. */
export function runningRuns(runs: LiveRun[]): LiveRun[] {
  return runs.filter((r) => r.status === "running");
}

/** One run at a time per project: they share a working tree. */
function isProjectBusy(runs: LiveRun[], projectId?: string | null): boolean {
  return !!projectId && runs.some((r) => r.status === "running" && r.projectId === projectId);
}

/** Why a run can't start right now, or null if it can. */
export function blockedReason(runs: LiveRun[], max: number, projectId?: string | null): string | null {
  if (isProjectBusy(runs, projectId)) return tr("This project already has a run in progress");
  if (runningRuns(runs).length >= max) return tr("Limit of {max} concurrent runs reached", { max });
  return null;
}

interface AppState {
  ready: boolean;
  projects: Project[];
  tools: Tool[];
  activeProjectId: string | null;
  /** Every run started in this session, oldest first. */
  runs: LiveRun[];
  maxConcurrent: number;
  error: string | null;
  /** bumps whenever runs/findings change, so views refetch */
  dataVersion: number;

  init: () => Promise<void>;
  reloadProjects: () => Promise<void>;
  /** Real work happened on a project: it moves to the front of the list. */
  touchProject: (id: string) => Promise<void>;
  reloadTools: () => Promise<void>;
  setActiveProject: (id: string | null) => void;
  /** Re-detect a project's stack from disk and store it if it changed. */
  refreshStack: (projectId: string) => Promise<void>;
  setError: (e: string | null) => void;
  setMaxConcurrent: (n: number) => void;

  createProject: (p: Parameters<typeof db.createProject>[0]) => Promise<Project>;
  updateProject: (id: string, patch: Partial<Project>) => Promise<void>;
  /** Refresh cloned projects' private/public from a GitHub listing. */
  syncGithubVisibility: (repos: { fullName: string; private: boolean }[]) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  /** Empty the Findings board without touching Audit or the Stats history. */
  clearChecks: (id: string) => Promise<void>;

  /** The user's own project labels. */
  tags: Tag[];
  reloadTags: () => Promise<void>;
  createTag: (name: string, color: TagColor) => Promise<Tag>;
  updateTag: (id: string, patch: { name?: string; color?: TagColor }) => Promise<void>;
  deleteTag: (id: string) => Promise<void>;
  /** Replace a project's tags with exactly this set. */
  setProjectTags: (projectId: string, tagIds: string[]) => Promise<void>;

  saveTool: (t: Parameters<typeof db.createTool>[0] & { id?: string }) => Promise<void>;
  /** Store a tool's options (rule groups, extra plugins). */
  saveToolConfig: (id: string, config: ToolConfig) => Promise<void>;
  deleteTool: (id: string) => Promise<void>;
  /** Ids of built-in tools the user deleted; Settings offers to bring them back. */
  removedBuiltins: string[];
  reloadRemovedBuiltins: () => Promise<void>;
  restoreBuiltins: () => Promise<number>;

  scan: (projectId: string, toolId: string, opts?: RunOpts) => Promise<void>;
  /** Run the given tools (or every applicable one) on this project, in order. */
  scanAll: (projectId: string, toolIds?: string[], opts?: RunOpts) => Promise<void>;
  /** Build, rebuild or update this project's graphify graph. */
  buildGraph: (projectId: string, mode: GraphMode) => Promise<void>;
  /** The enabled tools that can run on this project right now. */
  applicableTools: (projectId: string) => Tool[];
  /** Record a triage decision; it applies to the same finding in every snapshot. */
  setFindingStatus: (
    projectId: string,
    fingerprint: string,
    status: FindingStatus,
    reason: string | null,
  ) => Promise<void>;
  /** Undo the file edits an AI fix run made. */
  revertFix: (projectId: string, runId: string) => Promise<void>;
  runExternal: (projectId: string, toolId: string) => Promise<void>;
  fix: (projectId: string, findings: Finding[], provider: AIProvider, model?: string) => Promise<void>;
  runSkill: (projectId: string, skillId: string, provider: AIProvider, model?: string) => Promise<void>;
  /** Run a skill that has no row: one read out of the project's own folder. */
  runProjectSkill: (
    projectId: string,
    skill: SkillLike,
    provider: AIProvider,
    model?: string,
  ) => Promise<void>;
  runCommand: (projectId: string, commandId: string, opts: { message?: string; push?: boolean }, provider: AIProvider, model?: string) => Promise<void>;
  /** Run the project's own build/test commands and record what broke. */
  verify: (projectId: string) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  /** Drop a finished run from the session list (it stays in Audit). */
  clearRun: (runId: string) => void;
}

/**
 * How much of a run's output is kept in memory. The full transcript is written
 * to the run row, so the panel only needs the tail.
 */
const LOG_TAIL_CHARS = 200_000;

function capLog(log: string): string {
  return log.length <= LOG_TAIL_CHARS ? log : log.slice(log.length - LOG_TAIL_CHARS);
}

/** Handles of the processes still running, so each can be cancelled on its own. */
const active = new Map<string, ActiveRun>();

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  projects: [],
  tools: [],
  activeProjectId: null,
  runs: [],
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  error: null,
  dataVersion: 0,

  init: async () => {
    await db.seedBuiltins();
    await db.markInterruptedRuns(); // clean up runs left 'running' after a reload/crash
    // …and the scanner containers those runs left behind, still burning CPU
    void sonar.killOrphanScanners();
    const [projects, tools, tags, max, removedBuiltins] = await Promise.all([
      db.listProjects(),
      db.listTools(),
      db.listTags(),
      db.getSetting(MAX_CONCURRENT_SETTING),
      db.deletedBuiltins(),
    ]);
    set({
      projects,
      tools,
      tags,
      removedBuiltins,
      maxConcurrent: Number(max) > 0 ? Number(max) : DEFAULT_MAX_CONCURRENT,
      ready: true,
      activeProjectId: get().activeProjectId ?? projects[0]?.id ?? null,
    });
    const opened = get().activeProjectId;
    if (opened) void get().refreshStack(opened);
  },

  reloadProjects: async () => set({ projects: await db.listProjects() }),
  touchProject: async (id) => {
    const at = Date.now();
    // re-sort in memory first: the list answers now, the row catches up
    set((s) => ({
      projects: sortByLastUse(s.projects.map((p) => (p.id === id ? { ...p, last_used_at: at } : p))),
    }));
    await db.touchProject(id, at).catch(() => {});
  },
  reloadTools: async () => set({ tools: await db.listTools() }),
  setActiveProject: (id) => {
    set({ activeProjectId: id });
    if (id) void get().refreshStack(id);
  },

  refreshStack: async (projectId) => {
    if (stackChecked.has(projectId)) return;
    stackChecked.add(projectId);
    const project = get().projects.find((p) => p.id === projectId);
    if (!project?.path) return;
    const stack = await detectStack(project.path);
    // an empty result means the folder is gone or unreadable: keep what we knew
    if (!stack.length) return;
    const same =
      stack.length === project.stack.length && stack.every((s) => project.stack.includes(s));
    if (same) return;
    await get().updateProject(projectId, { stack });
  },
  setError: (e) => set({ error: e }),
  setMaxConcurrent: (n) => {
    const v = Math.max(1, Math.min(10, Math.round(n)));
    set({ maxConcurrent: v });
    void db.setSetting(MAX_CONCURRENT_SETTING, String(v));
  },

  createProject: async (p) => {
    const row = await db.createProject(p);
    await get().reloadProjects();
    set({ activeProjectId: row.id });
    return row;
  },
  updateProject: async (id, patch) => {
    await db.updateProject(id, patch);
    await get().reloadProjects();
  },
  syncGithubVisibility: async (repos) => {
    const cloned = new Set(get().projects.map((p) => p.github_repo).filter(Boolean));
    const mine = repos.filter((r) => cloned.has(r.fullName));
    if (mine.length && (await db.syncGithubVisibility(mine)) > 0) await get().reloadProjects();
  },
  deleteProject: async (id) => {
    await db.deleteProject(id);
    await get().reloadProjects();
    if (get().activeProjectId === id) set({ activeProjectId: get().projects[0]?.id ?? null });
    set((s) => ({ dataVersion: s.dataVersion + 1 }));
  },

  clearChecks: async (id) => {
    await db.clearProjectChecks(id);
    await get().reloadProjects();
    set((s) => ({ dataVersion: s.dataVersion + 1 }));
  },

  tags: [],
  reloadTags: async () => set({ tags: await db.listTags() }),
  createTag: async (name, color) => {
    const tag = await db.createTag(name, color);
    await get().reloadTags();
    return tag;
  },
  updateTag: async (id, patch) => {
    await db.updateTag(id, patch);
    await get().reloadTags();
  },
  deleteTag: async (id) => {
    await db.deleteTag(id);
    // the assignments went with it, so the projects have to be re-read
    await Promise.all([get().reloadTags(), get().reloadProjects()]);
  },
  setProjectTags: async (projectId, tagIds) => {
    await db.setProjectTags(projectId, tagIds);
    await get().reloadProjects();
  },

  saveTool: async (t) => {
    if (t.id && get().tools.some((x) => x.id === t.id)) await db.updateTool(t.id, t);
    else await db.createTool(t);
    await get().reloadTools();
  },
  saveToolConfig: async (id, config) => {
    await db.updateTool(id, { config });
    await get().reloadTools();
  },
  deleteTool: async (id) => {
    await db.deleteTool(id);
    await get().reloadTools();
    await get().reloadRemovedBuiltins();
  },

  removedBuiltins: [],
  reloadRemovedBuiltins: async () => set({ removedBuiltins: await db.deletedBuiltins() }),
  restoreBuiltins: async () => {
    const n = await db.restoreBuiltins();
    await get().reloadTools();
    set({ removedBuiltins: [] });
    return n;
  },

  scan: async (projectId, toolId, opts) => {
    const project = get().projects.find((p) => p.id === projectId);
    const tool = get().tools.find((t) => t.id === toolId);
    if (!project || !tool) return;
    if (reject(get, set, projectId)) return;

    // a missing binary produces a failed run and a log nobody can act on, so it
    // never starts: the single gate every entry point goes through
    const available = await checkTool(tool);
    if (!available.ok) {
      set({ error: `${tool.name}: ${available.reason}` });
      return;
    }

    // strix needs its LLM config passed as env vars + scan-depth resolved
    let env: Record<string, string> | undefined;
    let toolToRun = tool;
    if (tool.id === "strix") {
      const strix = await strixLaunch(tool);
      env = { ...strix.env, NO_COLOR: "1" };
      toolToRun = { ...tool, cmd: strix.cmd };
    }

    // a plain Run on graphify updates the graph that is there, or builds one
    if (tool.id === GRAPHIFY_TOOL_ID) {
      await get().buildGraph(projectId, modeFor(await graphState(project.path)));
      return;
    }

    await track(set, project, tool.name, (cbs) => {
      // Sonar is orchestrated (server + scanner + Web API), not a single command.
      if (tool.adapter === "sonarqube") return startSonarScan(project, tool, cbs);
      // ESLint and Ruff run out of Assay's own sandbox with a generated config.
      if (MANAGED_TOOL_IDS.has(tool.id)) return startLintScan(project, tool, cbs);
      return startScan(project, toolToRun, cbs, env);
    }, opts);
  },

  buildGraph: async (projectId, mode) => {
    const project = get().projects.find((p) => p.id === projectId);
    const tool = get().tools.find((t) => t.id === GRAPHIFY_TOOL_ID);
    if (!project || !tool) return;
    if (reject(get, set, projectId)) return;

    const available = await checkTool(tool);
    if (!available.ok) {
      set({ error: `${tool.name}: ${available.reason}` });
      return;
    }
    await track(set, project, tool.name, (cbs) => startGraphifyRun(project, tool, mode, cbs));
  },

  applicableTools: (projectId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return [];
    return get().tools.filter((t) => {
      if (t.source !== "tool" || !t.enabled) return false;
      // a graph is not a scan: it reports nothing to triage and writes into the
      // project, so it is never swept up by Run all or the scheduler
      if (NON_SCAN_TOOL_IDS.has(t.id)) return false;
      if (t.scope === "local") return !!project.path;
      return !!project.url && project.authorized;
    });
  },

  scanAll: async (projectId, toolIds, opts) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;
    const all = get().applicableTools(projectId);
    // an explicit pick is the user's call, even against the stack; an automatic
    // run (Run all with no list, the scheduler) skips what cannot apply here
    const wanted = toolIds ? new Set(toolIds) : null;
    const applicable = wanted
      ? all.filter((t) => wanted.has(t.id))
      : all.filter((t) => stackApplies(t.stack, project.stack));
    if (!applicable.length) {
      set({ error: tr("Nothing applies to this project: it has no folder, or no authorized URL.") });
      return;
    }

    // a missing binary is not a finding: skip it and say so once, instead of
    // leaving a failed run per tool the machine never had
    const checked = await Promise.all(
      applicable.map(async (tool) => ({ tool, ok: (await checkTool(tool)).ok })),
    );
    const runnable: Tool[] = [];
    const missing: string[] = [];
    for (const { tool, ok } of checked) {
      if (ok) runnable.push(tool);
      else missing.push(tool.name);
    }

    // one at a time: they share a working tree, and Sonar alone costs a JVM
    for (const tool of runnable) {
      if (get().runs.some((r) => r.status === "running" && r.projectId === projectId)) break;
      await get().scan(projectId, tool.id, opts);
    }
    if (missing.length) {
      set({ error: tr("Skipped, not installed: {tools}", { tools: missing.join(", ") }) });
    }
  },

  setFindingStatus: async (projectId, fingerprint, status, reason) => {
    await db.setFindingStatus(projectId, fingerprint, status, reason);
    set((s) => ({ dataVersion: s.dataVersion + 1 }));
  },

  revertFix: async (projectId, runId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;
    set({ error: null });
    try {
      await revertFix(project, runId);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
    set((s) => ({ dataVersion: s.dataVersion + 1 }));
  },

  runExternal: async (projectId, toolId) => {
    const project = get().projects.find((p) => p.id === projectId);
    const tool = get().tools.find((t) => t.id === toolId);
    if (!project || !tool) return;
    // an external terminal still works on that project's tree — same lock
    if (reject(get, set, projectId)) return;
    // …and the same gate: a terminal that opens only to print "not recognized"
    // is worse than a message here
    const available = await checkTool(tool);
    if (!available.ok) {
      set({ error: `${tool.name}: ${available.reason}` });
      return;
    }
    let env: Record<string, string> | undefined;
    let toolToRun = tool;
    if (tool.id === "strix") {
      // external terminal = keep strix's native interactive TUI (drop -n, keep color)
      const strix = await strixLaunch(tool);
      env = strix.env;
      toolToRun = { ...tool, cmd: strix.cmd.replace(/\s-n\b/, "") };
    }
    set({ error: null });
    try {
      const runId = await launchInTerminal(project, toolToRun, env, {
        onStart: (id, cmd) => {
          upsert(set, id, {
            projectId,
            projectName: project.name,
            label: `${tool.name} (external)`,
            cmd,
            startedAt: Date.now(),
          });
          useUI.getState().showWindow(id);
        },
      });
      finish(set, runId, "done");
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    }
  },

  fix: async (projectId, findings, provider, model) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;
    if (reject(get, set, projectId)) return;
    if (await missingEngine(set, provider)) return;
    const toolNames = [
      ...new Set(
        findings
          .map((f) => get().tools.find((t) => t.id === f.tool_id)?.name)
          .filter((n): n is string => !!n),
      ),
    ];
    // the run label is the receipt: how many findings, from which tools, which
    // severities — otherwise "AI fix · claude" tells you nothing a week later
    const sevs = [...new Set(findings.map((f) => f.severity))];
    const scope = [
      `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      sevs.length <= 2 ? sevs.join("+") : `${sevs.length} severities`,
      toolNames.length ? toolNames.join(", ") : null,
    ]
      .filter(Boolean)
      .join(" · ");
    await track(set, project, `Fix ${scope} · ${provider}`, (cbs) =>
      startFix(project, findings, provider, model, cbs, toolNames),
    );
    // an agent's edits may have broken the build; verifying is opt-in, since it
    // is a second long run
    if ((await db.getSetting("verify.auto")) === "1") await get().verify(projectId);
  },

  runSkill: async (projectId, skillId, provider, model) => {
    const project = get().projects.find((p) => p.id === projectId);
    const skill = get().tools.find((t) => t.id === skillId);
    if (!project || !skill) return;
    if (reject(get, set, projectId)) return;
    if (await missingEngine(set, provider)) return;
    await track(set, project, `${skill.name} · ${provider}`, (cbs) =>
      startSkill(project, skill, provider, model, cbs),
    );
  },

  runProjectSkill: async (projectId, skill, provider, model) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;
    if (reject(get, set, projectId)) return;
    if (await missingEngine(set, provider)) return;
    await track(set, project, `${skill.name} · ${provider}`, (cbs) =>
      startSkill(project, skill, provider, model, cbs),
    );
  },

  runCommand: async (projectId, commandId, opts, provider, model) => {
    const project = get().projects.find((p) => p.id === projectId);
    const command = get().tools.find((t) => t.id === commandId);
    if (!project || !command) return;
    if (reject(get, set, projectId)) return;
    if (await missingEngine(set, provider)) return;
    await track(set, project, command.name, (cbs) =>
      startCommand(project, command, opts, provider, model, cbs),
    );
  },

  verify: async (projectId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project?.path) return;
    if (reject(get, set, projectId)) return;
    const [all, saved] = await Promise.all([
      detectChecks(project.path),
      db.getSetting(`verify.checks.${projectId}`),
    ]);
    const wanted = new Set(saved === null ? defaultSelection(all) : saved.split(",").filter(Boolean));
    const checks = all.filter((c) => wanted.has(c.id));
    await track(set, project, `Verify · ${checks.length || "nothing"}`, (cbs) => startVerify(project, checks, cbs));
  },

  cancel: async (runId) => {
    await active.get(runId)?.handle.kill();
    set((s) => ({
      runs: s.runs.map((r) => (r.runId === runId && r.status === "running" ? { ...r, status: "cancelled" } : r)),
    }));
  },

  clearRun: (runId) => set((s) => ({ runs: s.runs.filter((r) => r.runId !== runId) })),
}));

/* --------------------------------- helpers ---------------------------------- */
type Set_ = (fn: (s: AppState) => Partial<AppState> | AppState) => void;

/** Insert or patch a run by id — callbacks can fire before we know the id. */
function upsert(set: Set_, runId: string, patch: Partial<LiveRun>): void {
  set((s) => ({
    runs: s.runs.some((r) => r.runId === runId)
      ? s.runs.map((r) => (r.runId === runId ? { ...r, ...patch } : r))
      : [
          ...s.runs,
          {
            runId,
            projectId: "",
            projectName: "",
            label: "",
            cmd: "",
            status: "running" as const,
            log: "",
            startedAt: Date.now(),
            ...patch,
          },
        ],
  }));
}

function finish(set: Set_, runId: string, status: LiveRun["status"]): void {
  set((s) => ({
    runs: s.runs.map((r) => (r.runId === runId ? { ...r, status, finishedAt: Date.now() } : r)),
  }));
}

/** Refuse to start and say why, or allow it. */
/** Strix's LLM config as env vars plus its command with the scan depth resolved, shared by in-app and external runs. */
async function strixLaunch(tool: Tool): Promise<{ env: Record<string, string>; cmd: string }> {
  const [llm, key, base, mode] = await Promise.all([
    db.getSetting("strix.llm"),
    db.getSetting("strix.apiKey"),
    db.getSetting("strix.baseUrl"),
    db.getSetting("strix.scanMode"),
  ]);
  const env: Record<string, string> = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  if (llm) env.STRIX_LLM = llm;
  if (key) env.LLM_API_KEY = key;
  // custom OpenAI-compatible endpoint (LM Studio, local proxy, subscription bridge…)
  if (base) {
    env.OPENAI_API_BASE = base;
    env.OPENAI_BASE_URL = base;
  }
  return { env, cmd: tool.cmd.replaceAll("{depth}", mode || "quick") };
}

function reject(get: () => AppState, set: Set_, projectId: string): boolean {
  const { runs, maxConcurrent } = get();
  const why = blockedReason(runs, maxConcurrent, projectId);
  if (why) {
    set(() => ({ error: `${why}.` }));
    return true;
  }
  return false;
}

/** Tell the OS about a finished run. */
async function announce(
  project: Project,
  label: string,
  runId: string,
  status: string,
  summary?: string | null,
): Promise<void> {
  const findings = await db.listFindings({ runId }).catch(() => []);
  const bad = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
  let title = `${project.name}: ${label} done`;
  if (status === "error") title = `${project.name}: ${label} failed`;
  else if (bad) title = `${project.name}: ${bad} to look at`;
  await notify(title, summary || `${findings.length} findings`);
}

/**
 * Start a run, stream it into the session list, and record the outcome the
 * database settled on — an orchestrated run can fail with a zero exit code.
 */
async function track(
  set: Set_,
  project: Project,
  label: string,
  start: (cbs: RunCallbacks) => ActiveRun,
  opts?: RunOpts,
): Promise<void> {
  set(() => ({ error: null }));
  // a run you started is work on that project; one the scheduler started is not
  if (!opts?.unattended) void useApp.getState().touchProject(project.id);
  let id = "";
  const base = { projectId: project.id, projectName: project.name, label, startedAt: Date.now() };
  const cbs: RunCallbacks = {
    onStart: (runId, cmd) => {
      id = runId;
      upsert(set, runId, { ...base, cmd, status: "running" });
      // a run you just launched is the one you want in front — this collapses
      // whichever window was open, per the one-window-at-a-time rule
      useUI.getState().showWindow(runId);
    },
    onData: (chunk) => {
      if (!id) return;
      set((s) => ({
        runs: s.runs.map((r) => (r.runId === id ? { ...r, log: capLog(r.log + chunk) } : r)),
      }));
    },
  };

  let run: ActiveRun;
  try {
    run = start(cbs);
  } catch (e) {
    set(() => ({ error: (e as Error).message }));
    if (id) finish(set, id, "error");
    return;
  }

  active.set(run.runId, run);
  try {
    await run.done;
    const row = await db.getRun(run.runId);
    let outcome: LiveRun["status"] = "done";
    if (row?.status === "error") outcome = "error";
    else if (row?.status === "cancelled") outcome = "cancelled";
    finish(set, run.runId, outcome);
    if (row && row.status !== "cancelled") void announce(project, label, row.id, row.status, row.summary);
  } catch (e) {
    set(() => ({ error: (e as Error).message }));
    finish(set, run.runId, "error");
  } finally {
    active.delete(run.runId);
    set((s) => ({ dataVersion: s.dataVersion + 1 }));
  }
}

/* ------------------------------ run selectors ------------------------------ */
// The log stream rewrites `runs` many times a second. These subscribe to the part
// a component needs, so only a view of the log itself re-renders per chunk.

/** A run without its log: every field is a primitive, so a shallow compare holds while only the log grows. */
export type RunMeta = Omit<LiveRun, "log">;

function metaOf(run: LiveRun): RunMeta {
  const { log: _log, ...meta } = run;
  return meta;
}

/** How many runs are executing. Changes only when a run starts or ends. */
export function useRunningCount(): number {
  return useApp((s) => s.runs.reduce((n, r) => (r.status === "running" ? n + 1 : n), 0));
}

/** The ids of every run in order. Changes only when a run is added or forgotten. */
export function useRunIds(): string[] {
  return useApp(useShallow((s) => s.runs.map((r) => r.runId)));
}

/** One run's fields except the log, or null when it is gone. Ignores log chunks. */
export function useRunMeta(runId: string | null): RunMeta | null {
  return useApp(
    useShallow((s) => {
      const run = runId ? s.runs.find((r) => r.runId === runId) : undefined;
      return run ? metaOf(run) : null;
    }),
  );
}

let metasCache: { key: string; metas: RunMeta[] } = { key: "", metas: [] };

/** Every run without its log. The same array comes back until a field other than the log changes. */
export function selectRunMetas(s: { runs: LiveRun[] }): RunMeta[] {
  const key = s.runs
    .map((r) => [r.runId, r.projectId, r.projectName, r.label, r.cmd, r.status, r.startedAt, r.finishedAt ?? ""].join("\u0000"))
    .join("\u0001");
  if (key !== metasCache.key) metasCache = { key, metas: s.runs.map(metaOf) };
  return metasCache.metas;
}

/** `selectRunMetas` as a hook, for lists: re-renders on start, end and status, not on log chunks. */
export function useRunMetas(): RunMeta[] {
  return useApp(selectRunMetas);
}

/** One run's log, or "" when it is gone. The only one of these that changes per chunk. */
export function useRunLog(runId: string | null): string {
  return useApp((s) => (runId ? (s.runs.find((r) => r.runId === runId)?.log ?? "") : ""));
}
