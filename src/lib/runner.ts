import { readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { join, tempDir } from "@tauri-apps/api/path";
import { platform } from "@tauri-apps/plugin-os";
import type { AIProvider, Finding, Project, RawFinding, Tool } from "@/types";
import { openTerminal, probe, runProcess, runProgram, runTokens, runOnce, runProgramOnce, type ProcHandle, type ProcResult, type StreamKind } from "@/lib/exec";
import { getAdapter } from "@/lib/adapters";
import { ensureNodeSandbox, ensureRuff, eslintEntry, resolveBinary, writeEslintConfig, writeGitleaksConfig, type FetchableId, type Log } from "@/lib/sandbox";
import { buildEslintConfig, buildGitleaksConfig, eslintPackages, gitleaksHistory, ruffSelect, semgrepConfigs } from "@/lib/tool-options";
import { artifactCommands, graphifyTokens, GRAPHIFY_TOOL_ID, type GraphMode } from "@/lib/graphify";
import { streamJsonToText } from "@/lib/agent-stream";
import { binCommand } from "@/lib/agent-bins";
import * as sonar from "@/lib/sonar";
import type { Check } from "@/lib/verify";
import * as db from "@/lib/db";
import { tr } from "@/lib/i18n";
import { fmtDuration, now, uid } from "@/lib/utils";

export interface RunCallbacks {
  onData?: (chunk: string, stream: StreamKind) => void;
  onStart?: (runId: string, cmd: string) => void;
}

export interface ActiveRun {
  runId: string;
  handle: ProcHandle;
  done: Promise<void>;
}

type RunOutcome = "success" | "error" | "cancelled";

/** How often a streaming run's log is persisted, so a crash leaves a partial log behind. */
const PERSIST_EVERY_MS = 1000;

function buildCmd(tool: Tool, project: Project): string {
  return tool.cmd
    .replaceAll("{url}", project.url ?? "")
    .replaceAll("{path}", project.path ?? ".");
}

/** Verification runs are recorded under this synthetic tool id. */
const VERIFY_TOOL_ID = "verify";

/** Anything a shell has to interpret keeps the tool on the shell-string path. */
const SHELL_META = /[|&;<>`]/;

/** Split a command line into argv, honouring single and double quotes. */
export function tokenize(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let quoted = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (cur || quoted) out.push(cur);
      cur = "";
      quoted = false;
    } else {
      cur += ch;
    }
  }
  if (quote) return null; // unbalanced quotes — let the shell deal with it
  if (cur || quoted) out.push(cur);
  return out;
}

/**
 * Tokenized form of a tool's command, when it is a plain invocation. Substitution
 * is per token, so a `{path}` with spaces stays one argument (cmd chokes on the
 * quotes Rust escapes for it). Commands needing shell syntax return null.
 */
function buildTokens(tool: Tool, project: Project): string[] | null {
  if (SHELL_META.test(tool.cmd)) return null;
  const toks = tokenize(tool.cmd);
  if (!toks?.length) return null;
  const sub = (t: string) => t.replaceAll("{url}", project.url ?? "").replaceAll("{path}", project.path ?? ".");
  return [toks[0], ...toks.slice(1).map(sub)];
}

/* --------------------------------- scanning --------------------------------- */
export function startScan(project: Project, tool: Tool, cb: RunCallbacks = {}, env?: Record<string, string>): ActiveRun {
  if (tool.scope === "url") {
    if (!project.url) throw new Error(`"${tool.name}" needs a target URL on this project.`);
    if (!project.authorized) throw new Error(`URL scans require the project to be marked authorized (you own / may test it).`);
  }
  if (tool.scope === "local" && !project.path) {
    throw new Error(`"${tool.name}" needs a local folder on this project.`);
  }

  const runId = uid("run_");
  const cmd = buildCmd(tool, project);
  const cwd = project.path ?? undefined;
  const startedAt = now();
  let buf = "";
  let lastPersist = 0;

  cb.onStart?.(runId, cmd);

  const spawnOpts = {
    cwd,
    env,
    onData: (chunk: string, stream: StreamKind) => {
      buf += chunk;
      cb.onData?.(chunk, stream);
      const t = Date.now();
      if (t - lastPersist > PERSIST_EVERY_MS) {
        lastPersist = t;
        void db.appendRunLog(runId, buf);
      }
    },
  };
  const tokens = buildTokens(tool, project);
  const { result, handle } = tokens ? runTokens(tokens, spawnOpts) : runProcess(cmd, spawnOpts);

  const done = (async () => {
    await db.createRun({
      id: runId,
      project_id: project.id,
      tool_id: tool.id,
      tool_name: tool.name,
      kind: "scan",
      cmd,
      started_at: startedAt,
    });
    let status: RunOutcome = "success";
    let summary: string | undefined;
    try {
      const res = await result;
      // collapse strix's PTY-warning flood so the stored log stays readable
      buf = res.combined.replace(/^.*PTY process count reached warning threshold.*$\r?\n?/gm, "");
      if (res.killed) {
        status = "cancelled";
      } else {
        const adapter = getAdapter(tool.adapter);
        const parsed = await adapter(res, { project, tool });
        // each scan is an immutable snapshot: insert its findings under this run
        await db.insertFindings(runId, project.id, tool.id, parsed.findings);
        summary = parsed.summary;
        status = res.code === 0 || parsed.findings.length ? "success" : "error";
      }
    } catch (e) {
      status = "error";
      buf += `\n[assay] ${(e as Error).message}\n`;
    }
    const finishedAt = now();
    await db.finishRun(runId, {
      status,
      exit_code: null,
      log: buf,
      summary,
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });
  })();

  return { runId, handle, done };
}

/**
 * For interactive TUI tools (e.g. strix): open the command in an external
 * terminal window and record the run for audit traceability (no in-app capture).
 */
export async function launchInTerminal(
  project: Project,
  tool: Tool,
  env?: Record<string, string>,
  cb: RunCallbacks = {},
): Promise<string> {
  if (tool.scope === "url") {
    if (!project.url) throw new Error(`"${tool.name}" needs a target URL on this project.`);
    if (!project.authorized) throw new Error(`URL scans require the project to be marked authorized.`);
  }
  const runId = uid("run_");
  const cmd = buildCmd(tool, project);
  cb.onStart?.(runId, cmd);
  const startedAt = now();
  await db.createRun({
    id: runId,
    project_id: project.id,
    tool_id: tool.id,
    tool_name: tool.name,
    kind: "scan",
    cmd,
    started_at: startedAt,
  });
  await openTerminal(cmd, project.path ?? undefined, env);
  await db.finishRun(runId, {
    status: "success",
    summary: "Launched in external terminal (interactive)",
    log: `$ ${cmd}\n\n[assay] Interactive tool opened in a separate terminal window. Interact with the agent there; this run is logged for traceability.`,
    finished_at: now(),
    duration_ms: 0,
  });
  return runId;
}

/** The run log sink the drivers share: append, plus throttled persistence. */
function runLogSink(
  runId: string,
  cb: RunCallbacks,
  read: () => string,
  write: (chunk: string) => void,
): { persist: () => void; log: (chunk: string) => void } {
  let lastPersist = 0;
  const persist = () => {
    const t = Date.now();
    if (t - lastPersist < PERSIST_EVERY_MS) return;
    lastPersist = t;
    void db.appendRunLog(runId, read());
  };
  return {
    persist,
    log: (chunk: string) => {
      write(chunk);
      cb.onData?.(chunk, "stdout");
      persist();
    },
  };
}

/* --------------------------------- sonarqube -------------------------------- */
/**
 * SonarQube is orchestrated step by step: the scanner only uploads, the server
 * computes the issues asynchronously, and they come back over the Web API.
 */
export function startSonarScan(project: Project, tool: Tool, cb: RunCallbacks = {}): ActiveRun {
  if (!project.path) throw new Error(`"${tool.name}" needs a local folder on this project.`);

  const runId = uid("run_");
  const containerName = `sechub-scan-${runId.replace(/[^A-Za-z0-9_.-]/g, "")}`;
  const key = sonar.projectKey(project.id);
  const startedAt = now();
  let buf = "";
  let cancelled = false;
  let killImpl: () => Promise<void> = async () => {};

  const handle: ProcHandle = {
    kill: async () => {
      cancelled = true;
      await killImpl();
      // the scanner runs in its own container: killing the shell would leave it analysing
      await sonar.killScanner(containerName);
    },
  };

  const { persist, log } = runLogSink(
    runId,
    cb,
    () => buf,
    (chunk) => {
      buf += chunk;
    },
  );

  const done = (async () => {
    const cfg = await sonar.getSonarConfig();
    const shown = sonar.formatCmd(
      sonar.SCANNER_PROGRAM,
      sonar.scannerArgs({
        path: project.path!,
        key,
        token: "",
        hostForScanner: sonar.hostForScanner(cfg),
        containerName,
        managed: cfg.managed,
        organization: cfg.organization,
        redact: true,
      }),
    );
    cb.onStart?.(runId, shown);
    await db.createRun({
      id: runId,
      project_id: project.id,
      tool_id: tool.id,
      tool_name: tool.name,
      kind: "scan",
      cmd: shown,
      started_at: startedAt,
    });

    let status: RunOutcome = "success";
    let summary: string | undefined;
    try {
      const { host, token, managed } = await sonar.ensureServer(log);
      if (cancelled) throw new Error("cancelled");
      const provisionNote = await sonar.ensureProject(host, token, key, project.name);
      if (provisionNote) log(`[assay] could not pre-create the Sonar project (${provisionNote}) — continuing.\n`);

      const args = sonar.scannerArgs({
        path: project.path!,
        key,
        token,
        hostForScanner: sonar.hostForScanner({ managed, host }),
        containerName,
        managed,
        organization: (await sonar.getSonarConfig()).organization,
      });
      log(`\n$ ${shown}\n\n`);
      // argv, not a shell string: a path with spaces can't be quoted safely through cmd
      const { result, handle: h } = runProgram(sonar.SCANNER_PROGRAM, args, {
        cwd: project.path!,
        onData: (chunk, stream) => {
          buf += chunk;
          cb.onData?.(chunk, stream);
          persist();
        },
      });
      killImpl = h.kill;
      if (cancelled) await handle.kill();
      const res = await result;

      if (res.killed || cancelled) {
        status = "cancelled";
      } else {
        const taskId = sonar.parseTaskId(buf);
        if (!taskId) {
          throw new Error(
            res.code === 0
              ? "The scanner finished but reported no analysis id — check the log."
              : `The scanner exited with code ${res.code}. Check the log (Docker running? project path mounted?).`,
          );
        }
        await sonar.waitForTask(host, token, taskId, log);
        log("[assay] collecting issues, hotspots and the quality gate…\n");
        const payload = await sonar.collect(host, token, key);
        const adapter = getAdapter(tool.adapter);
        const parsed = await adapter(
          { code: 0, stdout: "", stderr: "", combined: JSON.stringify(payload), killed: false },
          { project, tool },
        );
        await db.insertFindings(runId, project.id, tool.id, parsed.findings);
        summary = parsed.summary;
        log(`\n[assay] ${summary ?? "done"}\n[assay] dashboard: ${sonar.dashboardUrl(host, key)}\n`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (cancelled || msg === "cancelled") {
        status = "cancelled";
      } else {
        status = "error";
        // log(), not buf: the error has to reach the live panel, not just the audit log
        log(`\n[assay] ${msg}\n`);
      }
    }

    const finishedAt = now();
    await db.finishRun(runId, {
      status,
      exit_code: null,
      log: buf,
      summary,
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });
  })();

  return { runId, handle, done };
}

/* ----------------------------- managed scanners ------------------------------ */
/**
 * Tools Assay drives itself instead of running their stored command: it installs
 * them, generates their config from the options, or has to collect their report
 * from a file. `tools.cmd` is only a preview for these.
 */
export const MANAGED_TOOL_IDS = new Set<string>(["eslint", "ruff", "semgrep", "gitleaks", "osv-scanner"]);

/** Tools whose binary Assay can fetch itself, once the user asks it to. */
export const FETCHABLE_TOOL_IDS = new Set<string>(["gitleaks", "osv-scanner"]);

/** Tools that report no findings, so "Run all" and the scheduler leave them alone. */
export const NON_SCAN_TOOL_IDS = new Set<string>([GRAPHIFY_TOOL_ID]);

/** The tools Assay installs into its own sandbox, so there is nothing to look for on PATH. */
export const SANDBOX_TOOL_IDS = new Set<string>(["eslint", "ruff"]);

/** The program a tool needs on PATH, or null when it needs none. */
export function toolBinary(tool: Tool): string | null {
  if (SANDBOX_TOOL_IDS.has(tool.id)) return null;
  // Sonar is orchestrated, but every step of it rides in a container
  if (tool.adapter === "sonarqube" || tool.kind === "docker") return "docker";
  if (tool.kind === "npx") return "npx";
  if (tool.kind !== "cli") return null;
  const first = tokenize(tool.cmd)?.[0];
  return first && !first.includes("{") ? first : null;
}

export interface Availability {
  ok: boolean;
  /** What was looked for, so the message can name it. */
  binary: string | null;
  /** Why it cannot run, already in the app's language. Null when it can. */
  reason: string | null;
}

const AVAILABLE: Availability = { ok: true, binary: null, reason: null };

/**
 * Can this tool run here, right now? Docker is probed twice: `--version` says it
 * is installed, `docker info` says the engine is actually up.
 */
export async function checkTool(tool: Tool): Promise<Availability> {
  // one Assay downloaded lives in its own folder, not on PATH
  if (FETCHABLE_TOOL_IDS.has(tool.id)) {
    if (await resolveBinary(tool.id as FetchableId)) return { ok: true, binary: tool.id, reason: null };
    return {
      ok: false,
      binary: tool.id,
      reason: tr("{binary} is not installed, or not on PATH.", { binary: tool.id }),
    };
  }

  const binary = toolBinary(tool);
  if (!binary) return AVAILABLE;
  if (!(await probe(`${binary} --version`))) {
    return { ok: false, binary, reason: tr("{binary} is not installed, or not on PATH.", { binary }) };
  }
  if (binary === "docker" && !(await probe("docker info"))) {
    return {
      ok: false,
      binary,
      reason: tr("Docker is installed but its engine is not running — start Docker Desktop and try again."),
    };
  }
  return { ok: true, binary, reason: null };
}

/** What the user sees as the command, with the options they actually enabled. */
export function lintCommandPreview(tool: Tool): string {
  if (tool.id === "ruff") {
    return `ruff check . --output-format json --select ${ruffSelect(tool).join(",")}`;
  }
  if (tool.id === "semgrep") {
    const configs = semgrepConfigs(tool)
      .map((c) => `--config ${c}`)
      .join(" ");
    return `semgrep scan --json --quiet ${configs} .`;
  }
  if (tool.id === "gitleaks") {
    const mode = gitleaksHistory(tool) ? "" : "--no-git ";
    return `gitleaks detect --config <assay sandbox>/gitleaks.toml ${mode}--no-banner --redact --report-format json --report-path <temp> --source .`;
  }
  if (tool.id === "osv-scanner") {
    return "osv-scanner --format json --recursive .";
  }
  return "node <assay sandbox>/eslint.js . --config <assay sandbox>/eslint.config.mjs --no-config-lookup --format json";
}

/** How a managed tool hands its findings over. */
interface ManagedPlan {
  tokens: string[];
  /** Set when the tool writes its report to a file instead of stdout. */
  reportPath?: string;
}

/** The path to a fetchable binary. Never downloaded by a scan: install it from Tools. */
async function fetchedBinary(id: FetchableId): Promise<string> {
  const bin = await resolveBinary(id);
  if (!bin) throw new Error(`${id} is not installed. Install it from Tools.`);
  return bin;
}

async function planManagedRun(tool: Tool, cwd: string, log: Log): Promise<ManagedPlan> {
  if (tool.id === "ruff") {
    const bin = await ensureRuff(log);
    return {
      tokens: [
        bin,
        "check",
        ".",
        "--output-format",
        "json",
        "--no-cache",
        "--force-exclude",
        "--select",
        ruffSelect(tool).join(","),
      ],
    };
  }

  if (tool.id === "osv-scanner") {
    return { tokens: [await fetchedBinary("osv-scanner"), "--format", "json", "--recursive", "."] };
  }

  if (tool.id === "semgrep") {
    const configs = semgrepConfigs(tool).flatMap((c) => ["--config", c]);
    return { tokens: ["semgrep", "scan", "--json", "--quiet", "--error", ...configs, "."] };
  }

  if (tool.id === "gitleaks") {
    // gitleaks writes JSON to a file; stdout is a human summary
    const reportPath = await join(await tempDir(), `assay-gitleaks-${uid("")}.json`);
    // without --no-git gitleaks walks the commits instead of the files on disk
    const history = gitleaksHistory(tool);
    // build output is full of high-entropy bytes; without this the report is
    // mostly .rmeta files reported as API keys
    const config = await writeGitleaksConfig(buildGitleaksConfig());
    return {
      tokens: [
        await fetchedBinary("gitleaks"),
        "detect",
        "--config",
        config,
        ...(history ? [] : ["--no-git"]),
        "--no-banner",
        "--redact",
        "--source",
        ".",
        "--report-format",
        "json",
        "--report-path",
        reportPath,
      ],
      reportPath,
    };
  }

  await ensureNodeSandbox(eslintPackages(tool), log);
  const cfg = await writeEslintConfig(buildEslintConfig(tool, cwd));
  // node + the entry point, so Windows .cmd shims never enter the picture
  return {
    tokens: [
      "node",
      await eslintEntry(),
      ".",
      "--config",
      cfg,
      "--no-config-lookup",
      "--format",
      "json",
      "--no-error-on-unmatched-pattern",
    ],
  };
}

/**
 * Managed tools (ESLint, Ruff, Semgrep, Gitleaks, OSV): Assay owns the install
 * and the config, regenerated from the options before every run. The JSON
 * report is parsed, never printed, so one huge line can't drown the log.
 */
export function startLintScan(project: Project, tool: Tool, cb: RunCallbacks = {}): ActiveRun {
  if (!project.path) throw new Error(`"${tool.name}" needs a local folder on this project.`);

  const runId = uid("run_");
  const startedAt = now();
  const cwd = project.path;
  let buf = "";
  let cancelled = false;
  let killImpl: () => Promise<void> = async () => {};

  const handle: ProcHandle = {
    kill: async () => {
      cancelled = true;
      await killImpl();
    },
  };

  const { persist, log } = runLogSink(
    runId,
    cb,
    () => buf,
    (chunk) => {
      buf += chunk;
    },
  );

  const done = (async () => {
    const shown = lintCommandPreview(tool);
    cb.onStart?.(runId, shown);
    await db.createRun({
      id: runId,
      project_id: project.id,
      tool_id: tool.id,
      tool_name: tool.name,
      kind: "scan",
      cmd: shown,
      started_at: startedAt,
    });

    let status: RunOutcome = "success";
    let summary: string | undefined;
    try {
      const plan = await planManagedRun(tool, cwd, log);
      const tokens = plan.tokens;
      if (cancelled) throw new Error("cancelled");

      log(`\n$ ${shown}\n\n`);
      let report = "";
      const { result, handle: h } = runTokens(tokens, {
        cwd,
        onData: (chunk, stream) => {
          // stdout is the JSON report: collected for the adapter, kept out of the log
          if (stream === "stdout") {
            report += chunk;
            return;
          }
          buf += chunk;
          cb.onData?.(chunk, stream);
          persist();
        },
      });
      killImpl = h.kill;
      if (cancelled) await handle.kill();
      const res = await result;

      if (res.killed || cancelled) {
        status = "cancelled";
      } else {
        // a tool that reports to a file has nothing useful on stdout
        if (plan.reportPath) {
          report = await readTextFile(plan.reportPath).catch(() => "");
          await remove(plan.reportPath).catch(() => {});
        }
        const adapter = getAdapter(tool.adapter);
        const parsed = await adapter({ ...res, stdout: report, combined: report }, { project, tool });
        const stored = await db.insertFindings(runId, project.id, tool.id, parsed.findings);
        summary = parsed.summary;
        log(`[assay] ${summary ?? "done"} — ${stored} finding${stored === 1 ? "" : "s"} recorded\n`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (cancelled || msg === "cancelled") {
        status = "cancelled";
      } else {
        status = "error";
        log(`\n[assay] ${msg}\n`);
      }
    }

    const finishedAt = now();
    await db.finishRun(runId, {
      status,
      exit_code: null,
      log: buf,
      summary,
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });
  })();

  return { runId, handle, done };
}

/* -------------------------------- graphify ---------------------------------- */
/**
 * Build, rebuild or update the project's knowledge graph. What runs depends on
 * the mode and the options, so `tools.cmd` is only a preview.
 */
export function startGraphifyRun(
  project: Project,
  tool: Tool,
  mode: GraphMode,
  cb: RunCallbacks = {},
): ActiveRun {
  if (!project.path) throw new Error(`"${tool.name}" needs a local folder on this project.`);

  const runId = uid("run_");
  const startedAt = now();
  const cwd = project.path;
  const tokens = graphifyTokens(tool, mode, cwd);
  const shown = tokens.join(" ");
  let buf = "";
  let cancelled = false;
  let killImpl: () => Promise<void> = async () => {};

  const handle: ProcHandle = {
    kill: async () => {
      cancelled = true;
      await killImpl();
    },
  };

  const { persist, log } = runLogSink(
    runId,
    cb,
    () => buf,
    (chunk) => {
      buf += chunk;
    },
  );

  const done = (async () => {
    cb.onStart?.(runId, shown);
    await db.createRun({
      id: runId,
      project_id: project.id,
      tool_id: tool.id,
      tool_name: tool.name,
      kind: "scan",
      cmd: shown,
      started_at: startedAt,
    });

    let status: RunOutcome = "success";
    let summary: string | undefined;
    try {
      log(`$ ${shown}\n\n`);
      const { result, handle: h } = runTokens(tokens, {
        cwd,
        // graphify writes its progress to both streams; the graph itself goes to
        // graphify-out, so nothing here has to be captured for parsing
        onData: (chunk, stream) => {
          buf += chunk;
          cb.onData?.(chunk, stream);
          persist();
        },
      });
      killImpl = h.kill;
      if (cancelled) await handle.kill();
      const res = await result;

      if (res.killed || cancelled) {
        status = "cancelled";
      } else {
        const parsed = await getAdapter(tool.adapter)(res, { project, tool });
        summary = parsed.summary;
        status = res.code === 0 ? "success" : "error";
        log(`\n[assay] ${summary ?? "done"}\n`);
      }

      // `extract` writes only graph.json: the report and pages are follow-up
      // commands in the same run, once the graph exists
      if (status === "success") {
        for (const cmd of artifactCommands(tool, cwd)) {
          if (cancelled) break;
          const line = cmd.join(" ");
          log(`\n$ ${line}\n\n`);
          const step = runTokens(cmd, {
            cwd,
            onData: (chunk, stream) => {
              buf += chunk;
              cb.onData?.(chunk, stream);
              persist();
            },
          });
          killImpl = step.handle.kill;
          if (cancelled) await handle.kill();
          const out = await step.result;
          if (out.killed || cancelled) {
            status = "cancelled";
            break;
          }
          if (out.code !== 0) {
            // the graph itself is fine: name the file that is missing rather
            // than letting a silent failure pass for a finished run
            status = "error";
            log(`\n[assay] ${line} failed (exit ${out.code}).\n`);
            break;
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (cancelled || msg === "cancelled") {
        status = "cancelled";
      } else {
        status = "error";
        log(`\n[assay] ${msg}\n`);
      }
    }

    const finishedAt = now();
    await db.finishRun(runId, {
      status,
      exit_code: null,
      log: buf,
      summary,
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });
  })();

  return { runId, handle, done };
}

/* --------------------------------- verify ----------------------------------- */
/** A failing check is the most severe finding Assay can report; the error tail feeds the fix agent. */
function checkFailureFinding(c: Check, res: ProcResult): RawFinding {
  // the tail is where compilers put the actual error
  const tail = res.combined.trim().split("\n").slice(-12).join("\n").slice(-1200);
  return {
    severity: "critical",
    category: `build · ${c.id}`,
    message: `${c.label} failed (exit ${res.code}). ${tail.split("\n").slice(-3).join(" ").slice(0, 200)}`,
    raw: {
      check: c.label,
      command: c.tokens.join(" "),
      exitCode: res.code,
      output: tail,
      help: `Run \`${c.tokens.join(" ")}\` and make it exit 0 without reverting the fixes that caused it.`,
    },
  };
}

/** Run one check, streaming it to the log. `finding` is set only when it fails. */
async function runCheck(
  cwd: string,
  c: Check,
  log: (chunk: string) => void,
  onHandle: (kill: () => Promise<void>) => void,
): Promise<{ killed: boolean; finding: RawFinding | null }> {
  log(`\n$ ${c.label}\n`);
  const { result, handle } = runTokens(c.tokens, { cwd, onData: (chunk) => log(chunk) });
  onHandle(handle.kill);
  const res = await result;
  if (res.killed) return { killed: true, finding: null };
  if (res.code === 0) {
    log(`[assay] ${c.label} passed\n`);
    return { killed: false, finding: null };
  }
  log(`[assay] ${c.label} FAILED (exit ${res.code})\n`);
  return { killed: false, finding: checkFailureFinding(c, res) };
}

/** The informational finding that closes a verify run, when there is one. */
function verifyOutcomeFinding(checks: Check[], failed: number, cancelled: boolean, shown: string): RawFinding | null {
  if (!checks.length) {
    return {
      severity: "info",
      message: "No build or test command detected for this project. Add one in package.json, or a Cargo/Go/Make target.",
    };
  }
  if (!cancelled && !failed) {
    return {
      severity: "info",
      category: "build",
      message: `All ${checks.length} check${checks.length === 1 ? "" : "s"} passed: ${shown}`,
    };
  }
  return null;
}

function verifySummary(total: number, failed: number): string {
  if (!total) return "nothing to verify";
  if (failed) return `${failed} of ${total} failed`;
  return `${total} passed`;
}

export function startVerify(project: Project, checks: Check[], cb: RunCallbacks = {}): ActiveRun {
  if (!project.path) throw new Error("Verification needs a local folder for this project.");

  const runId = uid("run_");
  const startedAt = now();
  let buf = "";
  let cancelled = false;
  let killImpl: () => Promise<void> = async () => {};
  const handle: ProcHandle = {
    kill: async () => {
      cancelled = true;
      await killImpl();
    },
  };
  const log = (chunk: string) => {
    buf += chunk;
    cb.onData?.(chunk, "stdout");
  };

  const shown = checks.map((c) => c.label).join(" && ") || "(nothing detected)";

  const done = (async () => {
    cb.onStart?.(runId, shown);
    await db.createRun({
      id: runId,
      project_id: project.id,
      tool_id: VERIFY_TOOL_ID,
      tool_name: "Verify",
      kind: "scan",
      cmd: shown,
      started_at: startedAt,
    });

    const findings: RawFinding[] = [];
    let failed = 0;
    let status: RunOutcome = "success";

    for (const c of checks) {
      if (cancelled) break;
      const r = await runCheck(project.path!, c, log, (kill) => {
        killImpl = kill;
      });
      if (r.killed) {
        status = "cancelled";
        break;
      }
      if (r.finding) {
        failed++;
        findings.push(r.finding);
      }
    }

    const outcome = verifyOutcomeFinding(checks, failed, status === "cancelled", shown);
    if (outcome) findings.push(outcome);

    if (status !== "cancelled") {
      await db.insertFindings(runId, project.id, VERIFY_TOOL_ID, findings);
      status = failed ? "error" : "success";
    }

    const finishedAt = now();
    await db.finishRun(runId, {
      status,
      log: buf,
      summary: verifySummary(checks.length, failed),
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });
  })();

  return { runId, handle, done };
}

/* ----------------------------------- fix ------------------------------------ */
/** Findings the fix agent may not act on: dependency upgrades are forbidden by HARD LIMIT 4. */
const AGENT_UNFIXABLE_TOOL_IDS = new Set<string>(["osv-scanner"]);

export function canAgentFix(toolId: string | null | undefined): boolean {
  return !toolId || !AGENT_UNFIXABLE_TOOL_IDS.has(toolId);
}

function fixPrompt(project: Project, findings: Finding[], toolNames: string[] = []): string {
  const lines = findings.map((f) => {
    const at = f.line ? `:${f.line}` : "";
    const loc = f.file ? ` (${f.file}${at})` : "";
    let rule = "";
    let help = "";
    try {
      const r = JSON.parse(f.raw ?? "{}");
      const plugin = r.plugin ? `${r.plugin}/` : "";
      rule = r.rule ? `${plugin}${r.rule}` : "";
      help = r.help ?? r.title ?? "";
    } catch {
      /* raw not JSON */
    }
    const ruleTag = rule ? ` [rule: ${rule}]` : "";
    return [
      `- [${f.severity}] ${f.message}${loc}${ruleTag}`,
      help ? `    remediation: ${help}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  const touched = new Set<string>();
  for (const f of findings) if (f.file) touched.add(f.file);
  // every file the batch points at: the batch is already bounded by the fix limit, and
  // a capped list would silently forbid the findings past the cap
  const files = [...touched];
  const fileList = files.length ? `: ${files.join(", ")}` : "";
  const quoted = toolNames.map((n) => `"${n}"`).join(" and ");
  const by = quoted || "the static analysis tools";
  return [
    `You are an autonomous fix agent running non-interactively (headless, no TTY). NO human can answer you.`,
    `Do not ask questions, start an interview or clarifying step, or present options — when a choice arises, pick the recommended, safest option that keeps everything working, and proceed.`,
    `Do not assume you need permission: make the sensible engineering choice and apply it.`,
    ``,
    `Fix the issues found by ${by} in the project "${project.name}".`,
    `For each finding, pick the fix that BOTH (1) makes the rule stop firing by removing the flagged pattern itself, AND (2) keeps existing behaviour working.`,
    `Follow each finding's remediation hint. Prefer the smallest change that genuinely fixes the problem.`,
    ``,
    // the agent edits a real working tree unattended: these are rules, not judgement calls
    `HARD LIMITS — treat each as a rule you cannot break:`,
    `1. Only touch files that a finding points at${fileList}. A file no finding mentions may be read, never written.`,
    `2. Never suppress instead of fixing: no eslint-disable, @ts-ignore/@ts-expect-error, # noqa, # type: ignore, nosec, pragma comments, rule-config edits, or widening a config to silence the tool.`,
    `3. Never delete or weaken a test, an assertion, or a validation to make a finding go away.`,
    `4. Do not add, remove or upgrade dependencies, and do not edit package.json, lockfiles, tsconfig, build config, CI files or Dockerfiles.`,
    `5. Do not rename or move files, do not change public APIs, exported names or function signatures, and do not reformat code you are not fixing.`,
    `6. No refactors, no "while I'm here" cleanups, no style changes. Diffs stay minimal and local.`,
    `7. Never run destructive or outward-facing commands: no git commit/push/reset/checkout/clean/stash, no rm/del of source, no installs, no deploys, no network calls, no scripts that start servers.`,
    `8. Do not touch .env files, credentials, keys or anything under .git/.`,
    `9. If a fix would need any of the above, or you are not confident it is correct, SKIP that finding and say so in your final answer. A skipped finding is a good outcome; a risky edit is not.`,
    `10. Leave every change in the working tree, unstaged, so a human reviews it.`,
    ``,
    `Finish by listing what you changed and what you skipped, one line each, with the reason.`,
    ``,
    `Findings:`,
    ...lines,
  ].join("\n");
}

/** Write the prompt to a temp file and return its path. */
async function stagePromptFile(prompt: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const file = await join(await tempDir(), `assay-prompt-${Date.now()}-${suffix}.txt`);
  await writeTextFile(file, prompt);
  return file;
}

/**
 * An agent with the prompt piped in from a temp file, never on the command line:
 * `claude -p` drops its positional prompt through cmd.exe, and a prompt with a
 * diff exceeds cmd's 8191-character line limit.
 *
 * On Windows, Rust escapes quotes as \" which cmd.exe rejects, so paths go bare
 * (%TEMP% is 8.3-shortened); a binary under a path with spaces goes out as tokens.
 */
async function pipedAgent(name: "claude" | "opencode", prompt: string, args: string[]): Promise<AgentCmd> {
  const bin = await binCommand(name);
  const file = await stagePromptFile(prompt);
  if ((await platform()) !== "windows") {
    return { kind: "shell", cmd: [`cat "${file}"`, "|", `"${bin}"`, ...args].join(" "), promptFile: file };
  }
  if (/\s/.test(bin)) return { kind: "tokens", tokens: ["type", file, "|", bin, ...args], promptFile: file };
  const reader = /\s/.test(file) ? `type "${file}"` : `type ${file}`;
  return { kind: "shell", cmd: [reader, "|", bin, ...args].join(" "), promptFile: file };
}

/**
 * How to launch an agent. claude and opencode read the prompt piped from a temp
 * file (a shell can't carry quotes + newlines); hermes takes `--query-file`.
 * `promptFile` holds code and findings, so it is deleted once the run is over.
 */
type AgentCmd = ({ kind: "shell"; cmd: string } | { kind: "tokens"; tokens: string[] }) & { promptFile: string };

/** Best effort: a prompt file left behind is a leak of code, not a reason to fail the run. */
async function dropPromptFile(agent: AgentCmd): Promise<void> {
  await remove(agent.promptFile).catch(() => {});
}

async function buildAgentCmd(provider: AIProvider, prompt: string, model?: string): Promise<AgentCmd> {
  if (provider === "claude") {
    // --dangerously-skip-permissions: headless approval for all tools (acceptEdits
    // blocks shell commands); stream-json (needs --verbose) streams each step
    return pipedAgent("claude", prompt, ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"]);
  }
  if (provider === "hermes") {
    // --yolo: no one is there to approve; --query-file keeps the prompt off the command line
    // resolve the binary first, so a failure there leaves no prompt file behind
    const bin = await binCommand("hermes");
    const file = await stagePromptFile(prompt);
    return {
      kind: "tokens",
      tokens: [bin, "chat", "--yolo", ...(model ? ["--model", model] : []), "--query-file", file],
      promptFile: file,
    };
  }
  // opencode: --auto approves edits headlessly; -m picks the model explicitly
  return pipedAgent("opencode", prompt, ["run", "--auto", ...(model ? ["-m", model] : [])]);
}

/** Command shown in the UI and stored for audit — the prompt itself is huge. */
function displayAgentCmd(c: AgentCmd, promptLen: number): string {
  if (c.kind === "shell") return c.cmd;
  const [program, ...args] = c.tokens;
  return sonar.formatCmd(program, args.map((a) => (a.length > 120 ? `<prompt: ${promptLen} chars>` : a)));
}

interface AgentOpts {
  project: Project;
  toolId: string | null;
  toolName: string;
  provider: AIProvider;
  model?: string;
  prompt: string;
  /** First line written to the log, before the agent says anything. */
  preamble?: string;
  cb: RunCallbacks;
}

function agentStatus(res: ProcResult): RunOutcome {
  if (res.killed) return "cancelled";
  return res.code === 0 ? "success" : "error";
}

/** Spawn the agent, stream it into `out.buf`, and capture the diff it produced. */
async function streamAgent(
  agent: AgentCmd,
  opts: AgentOpts,
  runId: string,
  out: { buf: string },
  isCancelled: () => boolean,
  setKill: (kill: () => Promise<void>) => void,
): Promise<RunOutcome> {
  const { project, provider, cb } = opts;
  // claude streams NDJSON; the others print for humans
  const translate = provider === "claude" ? streamJsonToText() : null;
  const spawnOpts = {
    cwd: project.path!,
    onData: (chunk: string, stream: StreamKind) => {
      const text = translate ? translate(chunk) : chunk;
      if (!text) return;
      out.buf += text;
      cb.onData?.(text, stream);
    },
  };
  // snapshot before the agent writes anything, so the recorded diff is its own work only
  const capture = await beginDiffCapture(project);
  try {
    if (isCancelled()) return "cancelled";
    const { result, handle: h } =
      agent.kind === "tokens" ? runTokens(agent.tokens, spawnOpts) : runProcess(agent.cmd, spawnOpts);
    setKill(h.kill);
    if (isCancelled()) await h.kill();
    const res = await result;
    // keep the translated transcript; res.combined is raw NDJSON for claude
    if (!translate) out.buf = res.combined;
    const status = agentStatus(res);
    await finishDiffCapture(project, runId, capture);
    return status;
  } catch (e) {
    out.buf += `\n[assay] ${(e as Error).message}\n`;
    return "error";
  } finally {
    await dropDiffCapture(capture);
  }
}

/** The prompt could not even be prepared — record the run so it isn't silent. */
async function recordPrepareFailure(opts: AgentOpts, runId: string, startedAt: number, e: Error): Promise<void> {
  const { project, provider, cb } = opts;
  const cmd = `(${provider})`;
  cb.onStart?.(runId, cmd);
  await db.createRun({ id: runId, project_id: project.id, tool_id: opts.toolId, tool_name: opts.toolName, kind: "fix", provider, cmd, started_at: startedAt });
  await db.finishRun(runId, { status: "error", log: `[assay] failed to prepare prompt: ${e.message}`, finished_at: now(), duration_ms: now() - startedAt });
}

/** Shared agentic run (fix + skill): build cmd async, stream, persist, capture diff. */
function startAgent(opts: AgentOpts): ActiveRun {
  const { project, provider, prompt, cb } = opts;
  const runId = uid("run_");
  const startedAt = now();
  const out = { buf: "" };
  let cancelled = false;
  let killImpl: () => Promise<void> = async () => {};
  const handle: ProcHandle = {
    kill: async () => {
      cancelled = true;
      await killImpl();
    },
  };

  const done = (async () => {
    let agent: AgentCmd;
    try {
      agent = await buildAgentCmd(provider, prompt, opts.model);
    } catch (e) {
      await recordPrepareFailure(opts, runId, startedAt, e as Error);
      return;
    }
    const cmd = displayAgentCmd(agent, prompt.length);

    let status: RunOutcome;
    try {
      cb.onStart?.(runId, cmd);
      await db.createRun({ id: runId, project_id: project.id, tool_id: opts.toolId, tool_name: opts.toolName, kind: "fix", provider, cmd, started_at: startedAt });

      if (opts.preamble) {
        out.buf += opts.preamble;
        cb.onData?.(opts.preamble, "stdout");
      }

      status = cancelled
        ? "cancelled"
        : await streamAgent(agent, opts, runId, out, () => cancelled, (kill) => {
            killImpl = kill;
          });
    } finally {
      // success, error or cancel: the prompt (code + findings) must not outlive the run
      await dropPromptFile(agent);
    }

    const finishedAt = now();
    await db.finishRun(runId, {
      status,
      log: out.buf,
      summary: fmtDuration(finishedAt - startedAt),
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });
  })();

  return { runId, handle, done };
}

export function startFix(
  project: Project,
  findings: Finding[],
  provider: AIProvider,
  model: string | undefined,
  cb: RunCallbacks = {},
  toolNames: string[] = [],
): ActiveRun {
  if (!project.path) throw new Error("Agentic fix needs a local folder for this project.");
  const counts = findings.reduce<Record<string, number>>((a, f) => {
    a[f.severity] = (a[f.severity] ?? 0) + 1;
    return a;
  }, {});
  const scope = Object.entries(counts)
    .map(([sv, n]) => `${n} ${sv}`)
    .join(", ");
  const from = toolNames.length ? ` from ${toolNames.join(", ")}` : "";
  const toolName = `Fix ${findings.length} · ${toolNames.join(", ") || "findings"} · ${provider}`;
  return startAgent({
    project,
    toolId: null,
    toolName,
    provider,
    model,
    prompt: fixPrompt(project, findings, toolNames),
    // opens the log with what was sent, so the run explains itself later
    preamble: `[assay] fixing ${scope}${from}\n`,
    cb,
  });
}

/**
 * What running a skill needs to know about it. A row in `tools` satisfies this,
 * and so does a `SKILL.md` read out of the project, which has no row at all.
 */
export interface SkillLike {
  /** Empty for a skill that lives in the project rather than in the database. */
  id: string;
  name: string;
  notes?: string | null;
  prompt?: string | null;
}

/** The skill prompt for an interactive terminal: `startSkill`'s headless preamble is dropped. */
export function skillTerminalPrompt(project: Project, skill: SkillLike): string {
  return [
    `Run the "${skill.name}" skill on the project "${project.name}".`,
    skill.notes ? `Goal: ${skill.notes}` : "",
    ``,
    skill.prompt ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ----------------------------------- skill ---------------------------------- */
export function startSkill(
  project: Project,
  skill: SkillLike,
  provider: AIProvider,
  model: string | undefined,
  cb: RunCallbacks = {},
): ActiveRun {
  if (!project.path) throw new Error("Skills run agentically and need a local folder.");
  const prompt = [
    `You are an autonomous agent running non-interactively (headless, no TTY). NO human can answer you.`,
    `Do not ask questions or present options — when a choice arises, pick the recommended, safest option that keeps everything working, and proceed.`,
    `Do not run git commit or git push. Leave changes in the working tree.`,
    ``,
    `Run the "${skill.name}" skill on the project "${project.name}".`,
    skill.notes ? `Goal: ${skill.notes}` : "",
    ``,
    skill.prompt ?? "",
  ].filter(Boolean).join("\n");
  return startAgent({
    project,
    // a skill read from the project's own folder has no row to point at
    toolId: skill.id || null,
    toolName: `${skill.name} · ${provider}`,
    provider,
    model,
    prompt,
    cb,
  });
}

/* ---------------------------------- command --------------------------------- */
export function startCommand(
  project: Project,
  command: Tool,
  opts: { message?: string; push?: boolean },
  provider: AIProvider,
  model: string | undefined,
  cb: RunCallbacks = {},
): ActiveRun {
  if (!project.path) throw new Error("Commands run agentically and need a local folder.");
  const prompt = [
    `You are an autonomous agent running non-interactively (headless, no TTY). NO human can answer you.`,
    `Do not ask questions or present options — when a choice arises, pick the recommended, safest option that keeps everything working, and proceed.`,
    `Work in the project "${project.name}". Do not break anything.`,
    ``,
    command.prompt ?? "",
    opts.message ? `\nIntent / notes for this run: "${opts.message}".` : "",
    opts.push
      ? `\nThe user explicitly authorizes the push. After committing, run git push to the remote tracking branch.`
      : `\nDo NOT push — leave the commit local.`,
  ]
    .filter(Boolean)
    .join("\n");
  return startAgent({
    project,
    toolId: command.id,
    toolName: `${command.name} · ${provider}`,
    provider,
    model,
    prompt,
    cb,
  });
}

/** One-shot, non-agentic text generation (used to improve a skill prompt). */
export async function generateText(
  provider: AIProvider,
  prompt: string,
  model: string | undefined,
): Promise<string> {
  // claude uses its own configured model; the one-shot never passes one
  const agent = provider === "claude" ? await pipedAgent("claude", prompt, ["-p"]) : await buildAgentCmd(provider, prompt, model);
  try {
    const res = agent.kind === "tokens" ? await runTokens(agent.tokens).result : await runOnce(agent.cmd);
    return res.stdout.trim() || res.combined.trim();
  } finally {
    await dropPromptFile(agent);
  }
}

/* --------------------------------- revert ----------------------------------- */
/** Undo an AI fix run by applying its captured `git diff` in reverse, recorded as its own run. */
export async function revertFix(project: Project, runId: string): Promise<string> {
  if (!project.path) throw new Error("Reverting needs a local folder for this project.");
  const edits = await db.listEdits(runId);
  if (!edits.length) throw new Error("This run recorded no file edits, so there is nothing to revert.");
  const plural = edits.length === 1 ? "" : "s";

  // no trimming: a binary hunk is terminated by its blank line, and git apply needs it
  const patch = edits.map((e) => (e.diff.endsWith("\n") ? e.diff : `${e.diff}\n`)).join("");
  const patchPath = await join(await tempDir(), `assay-revert-${runId}.patch`);
  await writeTextFile(patchPath, patch);

  const revertId = uid("run_");
  const startedAt = now();
  const cmd = `git apply -R ${patchPath}`;
  await db.createRun({
    id: revertId,
    project_id: project.id,
    tool_id: null,
    tool_name: `Revert · ${edits.length} file${plural}`,
    kind: "fix",
    cmd,
    started_at: startedAt,
  });

  const res = await runProgramOnce("git", ["-C", project.path, "apply", "-R", "--whitespace=nowarn", patchPath]);
  await remove(patchPath).catch(() => {});
  const ok = res.code === 0;
  const finishedAt = now();
  await db.finishRun(revertId, {
    status: ok ? "success" : "error",
    exit_code: res.code,
    log: `$ ${cmd}

${res.combined}
${
      ok
        ? "[assay] the files are back to what they were before that fix."
        : "[assay] git refused the reverse patch — the files changed after the fix, so it no longer applies cleanly."
    }
`,
    summary: ok ? `reverted ${edits.length} file${plural}` : "revert failed",
    finished_at: finishedAt,
    duration_ms: finishedAt - startedAt,
  });

  if (!ok) {
    throw new Error(
      "git could not apply the reverse patch: those files changed after the fix. Check the Revert run in Audit for the details.",
    );
  }
  return revertId;
}

/* ------------------------------ diff capture -------------------------------- */
/**
 * A tree snapshot of the working tree taken through a throwaway index. Diffing two
 * of them records only what the agent changed — new files included — and leaves the
 * user's own uncommitted work out of the patch Revert would apply.
 */
interface DiffCapture {
  path: string;
  /** Temp `GIT_INDEX_FILE`: the real index, stash and working tree are never touched. */
  index: string;
  before: string;
}

/** `git add -A` + `git write-tree` into the temp index; null when git refuses. */
async function snapshotTree(path: string, index: string): Promise<string | null> {
  const env = { GIT_INDEX_FILE: index };
  const add = await runProgramOnce("git", ["-C", path, "add", "-A"], undefined, env);
  if (add.code !== 0) return null;
  const tree = await runProgramOnce("git", ["-C", path, "write-tree"], undefined, env);
  const id = tree.stdout.trim();
  return tree.code === 0 && /^[0-9a-f]{40,64}$/.test(id) ? id : null;
}

async function beginDiffCapture(project: Project): Promise<DiffCapture | null> {
  const path = project.path!;
  let index: string | null = null;
  try {
    // argv: no shell, so a project path with spaces needs no quoting
    const isRepo = await runProgramOnce("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
    // not a repo: nothing to diff (the edits are still visible in the log)
    if (isRepo.code !== 0) return null;
    index = await join(await tempDir(), `assay-index-${uid()}`);
    const before = await snapshotTree(path, index);
    if (before) return { path, index, before };
  } catch {
    /* git absent or path issue — skip diff capture */
  }
  if (index) await remove(index).catch(() => {});
  return null;
}

async function finishDiffCapture(project: Project, runId: string, cap: DiffCapture | null): Promise<void> {
  if (!cap) return;
  try {
    // same temp index: its stat cache means only what changed gets hashed again
    const after = await snapshotTree(cap.path, cap.index);
    if (!after || after === cap.before) return;
    // --binary: a reverse `git apply` needs the full blob for binary files
    const diff = await runProgramOnce("git", ["-C", cap.path, "diff", "--no-color", "--binary", cap.before, after]);
    if (diff.code === 0 && diff.stdout.trim()) {
      await Promise.all(
        parseDiff(diff.stdout).map((e) => db.insertEdit({ run_id: runId, project_id: project.id, ...e })),
      );
    }
  } catch {
    /* git absent or path issue — skip diff capture */
  }
}

async function dropDiffCapture(cap: DiffCapture | null): Promise<void> {
  if (cap) await remove(cap.index).catch(() => {});
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Undo git's C-quoting (`"dir/caf\303\251 \"x\".txt"`); an unquoted path comes back as is. */
export function unquoteGitPath(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...enc.encode(ch));
      continue;
    }
    const next = body[i + 1] ?? "";
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 3;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

/** The path on a `--- a/x` / `+++ b/x` line; null for /dev/null. Git adds a tab after names with spaces. */
function headerPath(rest: string, prefix: "a/" | "b/"): string | null {
  const raw = rest.replace(/\t$/, "");
  if (raw === "/dev/null") return null;
  const path = unquoteGitPath(raw);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The `b/` side of `diff --git a/x b/x`, used only when no ---/+++ line exists (binary, mode-only). */
function gitHeaderPath(header: string): string | null {
  if (header.endsWith('"')) {
    const open = header.lastIndexOf(' "');
    if (open >= 0) return headerPath(header.slice(open + 1), "b/");
  }
  // unquoted and not a rename: both halves are the same path, so the split is in the middle
  if (header.startsWith("a/") && (header.length - 5) % 2 === 0) {
    const n = (header.length - 5) / 2;
    const a = header.slice(2, 2 + n);
    if (header.slice(2 + n) === ` b/${a}`) return a;
  }
  const m = / b\/(.+)$/.exec(header);
  return m ? m[1] : null;
}

/** Split a `git diff` into one entry per file, with the path and the +/- line counts. */
export function parseDiff(diff: string): { file: string; diff: string; added: number; removed: number }[] {
  const out: { file: string; diff: string; added: number; removed: number }[] = [];
  const chunks = diff.split(/^diff --git /m).filter(Boolean);
  for (const raw of chunks) {
    const body = "diff --git " + raw;
    const lines = body.split("\n");
    const header = lines[0].slice("diff --git ".length).replace(/\r$/, "");
    let plus: string | null | undefined;
    let minus: string | null | undefined;
    let renamed: string | undefined;
    let inHunk = false;
    let added = 0;
    let removed = 0;
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        // header lines only before the first hunk: an added line may itself start with "++"
        if (line.startsWith("+++ ")) plus = headerPath(line.slice(4).replace(/\r$/, ""), "b/");
        else if (line.startsWith("--- ")) minus = headerPath(line.slice(4).replace(/\r$/, ""), "a/");
        else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
          renamed = unquoteGitPath(line.slice(line.indexOf(" to ") + 4).replace(/\r$/, ""));
        }
        continue;
      }
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
    const file = plus ?? minus ?? renamed ?? gitHeaderPath(header) ?? "unknown";
    out.push({ file, diff: body, added, removed });
  }
  return out;
}
