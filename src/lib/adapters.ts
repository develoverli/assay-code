import { SEVERITY_RANK, type Project, type RawFinding, type Severity, type Tool } from "@/types";
import type { ProcResult } from "@/lib/exec";
import { gitleaksHistory, ruffSelect } from "@/lib/tool-options";
import { graphSummaryOf } from "@/lib/graphify";
import { canonicalTags } from "@/lib/detect";
import { exists, readDir, readTextFile } from "@tauri-apps/plugin-fs";

export interface AdapterCtx {
  project: Project;
  /** The tool as configured, when a message depends on the options it ran with. */
  tool?: Tool;
}

export interface AdapterResult {
  findings: RawFinding[];
  /**
   * One sentence for the tool's card. "Nothing found" and "could not run" go
   * here, never as an invented finding nobody could triage.
   */
  summary?: string;
}

export type Adapter = (res: ProcResult, ctx: AdapterCtx) => Promise<AdapterResult>;

/* --------------------------------- helpers ---------------------------------- */
/** A tool's JSON as it arrives; `obj()` narrows into it and `str()` reads a field as text. */
type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return typeof v === "object" && v !== null ? (v as Json) : {};
}

/** Trailing separators come off in a loop: `/[\\/]+$/` backtracks quadratically. */
function stripTrailingSep(value: string): string {
  let out = value;
  while (out.endsWith("/") || out.endsWith("\\")) out = out.slice(0, -1);
  return out;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  return typeof v === "string" ? v : String(v);
}

/** Own-key read of SEVERITY_RANK, which is keyed by a value from the data. */
const SEVERITY_RANK_BY_KEY = new Map<string, number>(Object.entries(SEVERITY_RANK));

function severityRank(sv: Severity): number {
  return SEVERITY_RANK_BY_KEY.get(sv) ?? 0;
}

/** The last `lines` lines of a run's output, flattened to one short string. */
function logTail(res: ProcResult, lines = 2): string {
  return res.combined.trim().split(/\r?\n/).slice(-lines).join(" ").slice(0, 200);
}

function normSeverity(v: unknown): Severity {
  const s = String(v ?? "").toLowerCase();
  if (["critical", "crit", "blocker"].includes(s)) return "critical";
  if (["high", "error", "err", "major"].includes(s)) return "high";
  if (["medium", "warning", "warn", "moderate"].includes(s)) return "medium";
  if (["low", "minor"].includes(s)) return "low";
  return "info";
}

/** Parse JSON out of CLI output that may have npm/npx noise around it. */
function extractJson(text: string): unknown {
  const t = text.trim();
  // 1. whole thing is JSON
  try {
    return JSON.parse(t);
  } catch {
    /* keep trying */
  }
  // 2. slice from first opener to last closer (handles noise + strings with braces)
  const first = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const last = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (first != null && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

const TIER_SEVERITY = new Map<string, Severity>([
  ["P0", "critical"],
  ["P1", "high"],
  ["P2", "medium"],
  ["P3", "low"],
]);

function asArray(...cands: unknown[]): unknown[] {
  for (const c of cands) if (Array.isArray(c)) return c;
  return [];
}

/* ------------------------------- react-doctor ------------------------------- */
/** diagnostics live at top level; fall back to per-project lists */
function reactDoctorDiagnostics(json: Json): unknown[] {
  const top = asArray(json.diagnostics);
  if (top.length) return top;
  return asArray(json.projects).flatMap((p) => asArray(obj(p).diagnostics));
}

/** rule -> tier map (for severity), merged across projects */
function reactDoctorTiers(json: Json): Map<string, string | undefined> {
  const tierByRule = new Map<string, string | undefined>();
  for (const p of asArray(json.projects)) {
    for (const [rule, meta] of Object.entries(obj(obj(obj(p).score).rules))) {
      tierByRule.set(rule, str(obj(meta).tier));
    }
  }
  return tierByRule;
}

function reactDoctorFinding(raw: unknown, tierByRule: Map<string, string | undefined>): RawFinding {
  const d = obj(raw);
  const ruleKey = d.plugin ? `${String(d.plugin)}/${String(d.rule)}` : String(d.rule);
  const tier = tierByRule.get(ruleKey);
  const tierSeverity = tier ? TIER_SEVERITY.get(tier) : undefined;
  return {
    severity: tierSeverity ?? normSeverity(d.severity),
    category: str(d.category) ?? str(d.rule),
    file: str(d.filePath) ?? str(d.normalizedFilePath),
    line: typeof d.line === "number" && d.line > 0 ? d.line : undefined,
    message: d.title ? `${String(d.title)} — ${String(d.message)}` : String(d.message ?? d.rule ?? "Issue"),
    raw,
  };
}

const reactDoctor: Adapter = async (res) => {
  const json = extractJson(res.combined);
  const findings: RawFinding[] = [];

  if (json) {
    const tierByRule = reactDoctorTiers(obj(json));
    for (const d of reactDoctorDiagnostics(obj(json))) findings.push(reactDoctorFinding(d, tierByRule));
  }

  if (!findings.length && res.code !== 0) {
    return {
      findings: [],
      summary: `react-doctor produced no parseable output (exit ${res.code}) — check the raw log.`,
    };
  }

  const score = obj(obj(json).summary).score ?? obj(obj(json).score).score;
  const plural = findings.length === 1 ? "" : "s";
  const summary = [
    score != null ? `Score ${String(score)}/100` : null,
    findings.length ? `${findings.length} finding${plural}` : "no findings",
  ].filter(Boolean).join(" · ");
  return { findings, summary };
};

/* -------------------------------- unlighthouse ------------------------------ */
// [needs-improvement, poor] thresholds per Core Web Vitals (ms, except CLS unitless).
const METRIC_THRESHOLDS = new Map<string, [number, number]>([
  ["largest-contentful-paint", [2500, 4000]],
  ["first-contentful-paint", [1800, 3000]],
  ["interactive", [3800, 7300]],
  ["total-blocking-time", [200, 600]],
  ["cumulative-layout-shift", [0.1, 0.25]],
  ["max-potential-fid", [130, 250]],
  ["speed-index", [3400, 5800]],
]);

function metricSeverity(key: string, nv: number): Severity {
  const [warn, poor] = METRIC_THRESHOLDS.get(key) ?? [Infinity, Infinity];
  if (nv >= poor) return "high";
  return nv >= warn ? "medium" : "info";
}

/** Prefer the on-disk CI result; fall back to whatever JSON is in stdout. */
async function readUnlighthouseData(res: ProcResult, path?: string | null): Promise<unknown> {
  if (path) {
    const p = `${stripTrailingSep(path)}/.unlighthouse/ci-result.json`;
    try {
      if (await exists(p)) return JSON.parse(await readTextFile(p));
    } catch {
      /* scope/parse issue → fall through to stdout */
    }
  }
  return extractJson(res.combined);
}

function categorySeverity(pct: number): Severity {
  if (pct < 50) return "high";
  if (pct < 75) return "medium";
  return "low";
}

/** category scores below 90 */
function unlighthouseCategoryFindings(r: Json, where: string, catMeta: Map<string, unknown>): RawFinding[] {
  const out: RawFinding[] = [];
  for (const [key, c] of Object.entries(obj(r.categories))) {
    const score = typeof c === "number" ? c : obj(c).score;
    if (typeof score !== "number") continue;
    const pct = score <= 1 ? Math.round(score * 100) : Math.round(score);
    if (pct >= 90) continue;
    const title = str(obj(catMeta.get(key)).title) ?? key;
    out.push({
      severity: categorySeverity(pct),
      category: title,
      file: where,
      message: `${title}: ${pct}/100 on ${where}`,
      raw: { type: "category", key, score: pct, route: where },
    });
  }
  return out;
}

/** performance metrics (load times) — always surfaced so the values are visible */
function unlighthouseMetricFindings(r: Json, where: string, metricMeta: Map<string, unknown>): RawFinding[] {
  const out: RawFinding[] = [];
  for (const [key, m] of Object.entries(obj(r.metrics))) {
    const nv = obj(m).numericValue;
    if (typeof nv !== "number") continue;
    const meta = obj(metricMeta.get(key));
    const title = str(meta.title) ?? key;
    const dv = str(obj(m).displayValue) ?? String(nv);
    out.push({
      severity: metricSeverity(key, nv),
      category: "Web Vitals",
      file: where,
      message: `${title}: ${dv} on ${where}`,
      raw: { type: "metric", key, numericValue: nv, displayValue: dv, description: meta.description },
    });
  }
  return out;
}

const unlighthouse: Adapter = async (res, ctx) => {
  const findings: RawFinding[] = [];
  const data = await readUnlighthouseData(res, ctx.project.path);

  const meta = obj(obj(data).metadata);
  const metricMeta = new Map<string, unknown>(Object.entries(obj(meta.metrics)));
  const catMeta = new Map<string, unknown>(Object.entries(obj(meta.categories)));
  const routes = asArray(obj(data).routes, obj(data).results, Array.isArray(data) ? data : undefined);

  for (const raw of routes) {
    const r = obj(raw);
    const where: string = str(r.path) ?? str(obj(r.route).path) ?? str(r.url) ?? "/";
    findings.push(
      ...unlighthouseCategoryFindings(r, where, catMeta),
      ...unlighthouseMetricFindings(r, where, metricMeta),
    );
  }

  if (!findings.length) {
    return {
      findings: [],
      summary: "Unlighthouse ran but produced no parseable routes. Check that Chrome is installed, then see the .unlighthouse report.",
    };
  }

  const summaryScore = obj(obj(data).summary).score;
  const score = typeof summaryScore === "number" ? Math.round(summaryScore * 100) : undefined;
  return {
    findings,
    summary: [score != null ? `Score ${score}/100` : null, `${findings.length} signals`].filter(Boolean).join(" · "),
  };
};

/* ----------------------------------- strix ---------------------------------- */
/** Best-effort read of strix's structured report from strix_runs/<latest>/. */
async function readStrixReport(path?: string | null): Promise<unknown> {
  if (!path) return null;
  try {
    const base = `${stripTrailingSep(path)}/strix_runs`;
    if (!(await exists(base))) return null;
    const entries = await readDir(base);
    const dirs: string[] = [];
    for (const e of entries) if (e.isDirectory) dirs.push(e.name);
    dirs.sort((a, b) => a.localeCompare(b));
    if (!dirs.length) return null;
    const latest = dirs[dirs.length - 1];
    for (const f of ["findings.json", "report.json", "run.json", "results.json", "vulnerabilities.json"]) {
      const p = `${base}/${latest}/${f}`;
      try {
        if (await exists(p)) return JSON.parse(await readTextFile(p));
      } catch {
        /* try next */
      }
    }
  } catch {
    /* no dir / no perms */
  }
  return null;
}

/** The headings that end a section body. */
const STRIX_SECTIONS = ["impact", "technical analysis", "evidence", "poc", "remediation", "references"];

/** Does this line open one of the sections that follow a body (heading + word boundary)? */
function startsSection(line: string): boolean {
  const l = line.trimStart().toLowerCase();
  return STRIX_SECTIONS.some((name) => l.startsWith(name) && !/\w/.test(l.charAt(name.length)));
}

/** Parse the `VULN-NNNN` report boxes strix prints to stdout (ASCII or Unicode borders). */
function parseStrixStdout(text: string): RawFinding[] {
  const blocks = text.split(/VULN-\d{3,}/i).slice(1);
  const seen = new Set<string>();
  const out: RawFinding[] = [];
  for (const raw of blocks) {
    // strip side borders ("| … |" or "│ … │"); the trailing one without a regex,
    // since `/\s*[│|]\s*$/` backtracks quadratically
    const stripBorders = (l: string): string => {
      const head = l.replace(/^\s*[│|]\s?/, "");
      const tail = head.trimEnd();
      if (!tail.endsWith("│") && !tail.endsWith("|")) return head;
      return tail.slice(0, -1).trimEnd();
    };
    const clean = raw.split("\n").map(stripBorders).join("\n");
    // scanned line by line, never via a RegExp built from the label
    const lines = clean.split("\n");
    const grab = (label: string): string | undefined => {
      for (const line of lines) {
        const at = line.toLowerCase().indexOf(label.toLowerCase());
        if (at < 0) continue;
        let rest = line.slice(at + label.length).trimStart();
        if (rest.startsWith(":")) rest = rest.slice(1);
        rest = rest.trim();
        if (rest) return rest;
      }
      return undefined;
    };
    const section = (label: string): string => {
      const head = lines.findIndex((line) => {
        const at = line.toLowerCase().indexOf(label.toLowerCase());
        return at >= 0 && line.slice(at + label.length).trim() === "";
      });
      if (head < 0) return "";
      const body: string[] = [];
      for (const line of lines.slice(head + 1)) {
        if (startsSection(line)) break;
        body.push(line);
      }
      return body.join(" ").replace(/\s+/g, " ").trim();
    };
    const title = grab("Title");
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const cvss = grab("CVSS Score");
    const desc = section("Description").slice(0, 400);
    const remediation = section("Remediation").slice(0, 600);
    out.push({
      severity: normSeverity(grab("Severity")),
      category: cvss ? `vuln · CVSS ${cvss}` : "vuln",
      file: grab("Target"),
      message: desc ? `${title} — ${desc}` : title,
      // `help` is picked up by the fix prompt as the remediation hint
      raw: { title, severity: grab("Severity"), cvss, target: grab("Target"), vector: grab("CVSS Vector"), description: desc, help: remediation },
    });
  }
  return out;
}

/** Fall back to the structured report on disk / any JSON in stdout. */
async function strixReportFindings(res: ProcResult, path?: string | null): Promise<RawFinding[]> {
  const json = (await readStrixReport(path)) ?? extractJson(res.combined);
  if (!json) return [];
  const j = obj(json);
  const vulns = asArray(j.vulnerabilities, j.findings, j.results, Array.isArray(json) ? json : undefined);
  return vulns.map((raw) => {
    const v = obj(raw);
    return {
      severity: normSeverity(v.severity ?? v.risk ?? v.level ?? v.cvss_severity),
      category: str(v.type) ?? str(v.category) ?? str(v.name) ?? str(v.owasp) ?? "vuln",
      file: str(v.url) ?? str(v.endpoint) ?? str(v.location) ?? str(v.target),
      message: String(v.title ?? v.name ?? v.description ?? "Finding"),
      raw,
    };
  });
}

/** Why a strix run ended with nothing to show. Reported as an outcome, not as a finding. */
function strixEmptyOutcome(res: ProcResult): string {
  const failedWrite = /PermissionError|WinError 5|Acceso denegado|Failed to save scan data/i.test(res.combined);
  if (failedWrite) {
    return "Strix could not save its report (file permission or lock — WinError 5) and printed no parseable vulnerabilities. Fix write access to the strix_runs folder and run it again.";
  }
  if (res.code === 0) {
    return "Strix completed and no structured findings were parsed. Check the strix_runs report or the raw log.";
  }
  return "Strix did not complete cleanly. Verify strix, docker, the LLM key and that the target is reachable.";
}

const strix: Adapter = async (res, ctx) => {
  // 1. strix prints full VULN reports to stdout — parse those first (works even
  //    when the strix_runs file write fails).
  const findings: RawFinding[] = parseStrixStdout(res.combined);

  if (!findings.length) findings.push(...(await strixReportFindings(res, ctx.project.path)));
  if (!findings.length) return { findings: [], summary: strixEmptyOutcome(res) };

  return { findings, summary: `${findings.length} item${findings.length === 1 ? "" : "s"}` };
};

/* --------------------------------- sonarqube -------------------------------- */
/** Legacy `issue.severity`, used only when the server predates `impacts[]`. */
const SONAR_LEGACY = new Map<string, Severity>([
  ["BLOCKER", "critical"],
  ["CRITICAL", "critical"],
  ["MAJOR", "high"],
  ["MINOR", "medium"],
  ["INFO", "info"],
]);
/** `impacts[].severity` (Sonar 10.4+). */
const SONAR_IMPACT = new Map<string, Severity>([
  ["BLOCKER", "critical"],
  ["HIGH", "high"],
  ["MEDIUM", "medium"],
  ["LOW", "low"],
  ["INFO", "info"],
]);
const HOTSPOT_SEVERITY = new Map<string, Severity>([
  ["HIGH", "high"],
  ["MEDIUM", "medium"],
  ["LOW", "low"],
]);

/** Sonar reports files as `<projectKey>:src/foo.ts` — the fix agent needs the path. */
function sonarFile(component: unknown, key: string): string | undefined {
  const c = String(component ?? "");
  if (!c) return undefined;
  return c.startsWith(`${key}:`) ? c.slice(key.length + 1) : c;
}

function issueSeverity(issue: Json): Severity {
  let best: Severity | null = null;
  for (const i of asArray(issue.impacts)) {
    const s = SONAR_IMPACT.get(String(obj(i).severity ?? "").toUpperCase());
    if (s && (best === null || severityRank(s) < severityRank(best))) best = s;
  }
  return best ?? SONAR_LEGACY.get(String(issue.severity ?? "").toUpperCase()) ?? "info";
}

/** Sonar reports a line either directly or inside `textRange`. */
function lineOf(line: unknown, startLine: unknown): number | undefined {
  if (typeof line === "number") return line;
  return typeof startLine === "number" ? startLine : undefined;
}

function sonarIssueFinding(raw: unknown, key: string, rules: Map<string, unknown>): RawFinding {
  const i = obj(raw);
  const rule = i.rule ? String(i.rule) : "";
  const meta = obj(rules.get(rule));
  const quality = obj(asArray(i.impacts)[0]).softwareQuality ?? i.type ?? "ISSUE";
  const startLine = obj(i.textRange).startLine;
  return {
    severity: issueSeverity(i),
    category: [String(quality).toLowerCase(), rule].filter(Boolean).join(" · "),
    file: sonarFile(i.component, key),
    line: lineOf(i.line, startLine),
    message: String(i.message ?? rule ?? "Issue"),
    raw: { ...i, rule, help: meta.help, sonarRuleName: meta.name },
  };
}

function sonarHotspotFinding(raw: unknown, key: string): RawFinding {
  const h = obj(raw);
  const startLine = obj(h.textRange).startLine;
  return {
    severity: HOTSPOT_SEVERITY.get(String(h.vulnerabilityProbability ?? "").toUpperCase()) ?? "medium",
    category: ["security hotspot", str(h.securityCategory)].filter(Boolean).join(" · "),
    file: sonarFile(h.component, key),
    line: lineOf(h.line, startLine),
    message: String(h.message ?? "Security hotspot"),
    raw: { ...obj(raw), help: "Security hotspot: review whether this code is safe in context; fix it if the risk is real." },
  };
}

function sonarGateFinding(gate: Json): RawFinding {
  const failed: string[] = [];
  for (const raw of asArray(gate.conditions)) {
    const c = obj(raw);
    if (c.status !== "ERROR") continue;
    const comparator = typeof c.comparator === "string" ? c.comparator.toLowerCase() : "";
    failed.push(`${String(c.metricKey)} ${comparator} ${String(c.errorThreshold)} (actual ${String(c.actualValue)})`);
  }
  const detail = failed.join("; ");
  const passed = gate.status === "OK";
  return {
    severity: passed ? "info" : "high",
    category: "quality gate",
    message: passed ? "Quality gate passed" : `Quality gate failed — ${detail || "see the Sonar dashboard"}`,
    raw: gate,
  };
}

function sonarSummary(dataRaw: unknown, gateRaw: unknown): string {
  const data = obj(dataRaw);
  const gate = obj(gateRaw);
  const m = obj(data.measures);
  const hotspots = asArray(data.hotspots).length;
  return [
    gate.status ? `Gate ${String(gate.status)}` : null,
    `${asArray(data.issues).length} issues`,
    hotspots ? `${hotspots} hotspots` : null,
    m.coverage ? `${String(m.coverage)}% coverage` : null,
    m.duplicated_lines_density ? `${String(m.duplicated_lines_density)}% dup` : null,
    m.sqale_index ? `${Math.round(Number(m.sqale_index) / 60)}h debt` : null,
    m.ncloc ? `${String(m.ncloc)} LOC` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Parses the Web API payload runner.ts collected, not the scanner's stdout (which only uploads). */
const sonarqube: Adapter = async (res) => {
  const data = obj(extractJson(res.combined));
  const key: string = str(data.key) ?? "";
  const rules = new Map<string, unknown>(Object.entries(obj(data.rules)));

  const findings: RawFinding[] = [
    ...asArray(data.issues).map((i) => sonarIssueFinding(i, key, rules)),
    ...asArray(data.hotspots).map((h) => sonarHotspotFinding(h, key)),
  ];

  const gate = obj(data.qualityGate);
  if (gate.status) findings.push(sonarGateFinding(gate));

  if (!findings.length) {
    return { findings: [], summary: sonarSummary(data, gate) || "No open issues." };
  }

  return { findings, summary: sonarSummary(data, gate) };
};

/* ----------------------------------- eslint --------------------------------- */
/** Linters report absolute paths; Findings shows them relative like every other tool. */
function relativeTo(root: string | null | undefined, file: unknown): string | undefined {
  const norm = (v: string) => stripTrailingSep(v.replace(/\\/g, "/"));
  const f = norm(String(file ?? "").trim());
  if (!f) return undefined;
  const r = norm(String(root ?? ""));
  if (r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return f.slice(r.length + 1);
  return f;
}

const ESLINT_SEVERITY = new Map<number, Severity>([
  [2, "high"],
  [1, "medium"],
]);

function eslintFinding(file: string | undefined, raw: unknown): RawFinding {
  const m = obj(raw);
  const rule = m.ruleId ? String(m.ruleId) : null;
  let severity: Severity = ESLINT_SEVERITY.get(Number(m.severity)) ?? "medium";
  if (m.fatal) severity = "critical";
  else if (rule?.startsWith("security/")) severity = "high";
  const text = String(m.message ?? "").trim();
  return {
    severity,
    category: rule ?? "parse error",
    file,
    line: typeof m.line === "number" && m.line > 0 ? m.line : undefined,
    message: rule ? `${text || rule} (${rule})` : text || "Parse error",
    raw: {
      ...m,
      help: rule
        ? `ESLint rule ${rule}. Fix the code itself — never silence it with an eslint-disable comment.`
        : "ESLint could not parse this file.",
    },
  };
}

const eslint: Adapter = async (res, ctx) => {
  const json = extractJson(res.combined);
  const files = Array.isArray(json) ? json : [];
  const findings: RawFinding[] = [];
  let dirty = 0;
  for (const f of files) {
    const rel = relativeTo(ctx.project.path, obj(f).filePath);
    const msgs = asArray(obj(f).messages);
    if (msgs.length) dirty++;
    for (const m of msgs) findings.push(eslintFinding(rel, m));
  }

  if (!findings.length) {
    // exit 2 (or no JSON at all) means ESLint itself failed — that has to surface
    if (!files.length && res.code !== 0) {
      const tail = logTail(res);
      return {
        findings: [],
        summary: `ESLint produced no report (exit ${res.code}). ${tail || "Check the raw log."}`,
      };
    }
    return {
      findings: [],
      summary: `No problems in ${files.length} file${files.length === 1 ? "" : "s"}.`,
    };
  }

  return { findings, summary: `${findings.length} problem${findings.length === 1 ? "" : "s"} in ${dirty} file${dirty === 1 ? "" : "s"}` };
};

/* ------------------------------------ ruff ---------------------------------- */
/** Ruff codes carry their own severity: bandit and hard errors first, style last. */
const RUFF_SEVERITY: [RegExp, Severity][] = [
  [/^S/, "high"],
  [/^(F82|E9|PLE)/, "high"],
  [/^(F|B|PL|ASYNC)/, "medium"],
  [/^(E|W|I|N|UP|SIM)/, "low"],
];

function ruffSeverity(code: string): Severity {
  for (const [re, sev] of RUFF_SEVERITY) if (re.test(code)) return sev;
  return "medium";
}

/** The rule's docs link and whether Ruff can rewrite it, when it says so. */
function ruffHelp(code: string, url: unknown, fix: unknown): string {
  if (!url) return `Ruff rule ${code}.`;
  const autofix = fix ? "Ruff can fix this automatically." : "";
  return `Ruff rule ${code}: ${String(url)}. ${autofix}`.trim();
}

function ruffFinding(raw: unknown, root: string | null | undefined): RawFinding {
  const d = obj(raw);
  const code = String(d.code ?? "").trim();
  const text = String(d.message ?? "").trim();
  const row = Number(obj(d.location).row ?? 0);
  return {
    severity: code ? ruffSeverity(code) : "medium",
    category: code || "ruff",
    file: relativeTo(root, d.filename),
    line: row > 0 ? row : undefined,
    message: code ? `${text || code} (${code})` : text || "Ruff finding",
    raw: {
      ...d,
      help: ruffHelp(code, d.url, d.fix),
    },
  };
}

/** Which kind of nothing Ruff reported: a failed run, no Python, or clean files (and which rule sets). */
function ruffEmptySummary(res: ProcResult, ctx: AdapterCtx): string {
  if (res.code !== 0 && res.code !== null) {
    const tail = logTail(res);
    return `Ruff produced no report (exit ${res.code}). ${tail || "Check the raw log."}`;
  }
  // "no Python" is Assay's detection, not Ruff's claim, so the summary says so
  const sets = ctx.tool ? ruffSelect(ctx.tool).join(", ") : "";
  const known = ctx.project.stack.length > 0;
  const python = canonicalTags(ctx.project.stack).includes("python");
  const scope = sets ? ` Rule sets: ${sets}.` : "";
  if (known && !python) {
    return `Nothing reported, and Assay detected no Python file in this project — there was probably nothing to check.${scope}`;
  }
  return `No problems in this project's Python files.${scope}`;
}

const ruff: Adapter = async (res, ctx) => {
  const json = extractJson(res.combined);
  const items = Array.isArray(json) ? json : [];
  if (!items.length) return { findings: [], summary: ruffEmptySummary(res, ctx) };
  const findings = items.map((d) => ruffFinding(d, ctx.project.path));
  const touched = new Set<string>();
  for (const f of findings) if (f.file) touched.add(f.file);
  const files = touched.size;
  return { findings, summary: `${findings.length} problem${findings.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}` };
};

/* --------------------------------- gitleaks --------------------------------- */
/** Every secret is critical. Gitleaks runs redacted: only the rule and location are kept, never the value. */
const gitleaks: Adapter = async (res, ctx) => {
  const json = extractJson(res.combined);
  const items = Array.isArray(json) ? json : [];
  const history = ctx.tool ? gitleaksHistory(ctx.tool) : false;

  if (!items.length) {
    // gitleaks exits 1 on findings, so empty + non-zero is a failure (often "not
    // a git repository" in history mode)
    if (res.code !== 0) {
      const tail = logTail(res);
      return {
        findings: [],
        summary: `Gitleaks produced no report (exit ${res.code}). ${tail || "Check the raw log."}`,
      };
    }
    return {
      findings: [],
      summary: history
        ? "No secrets in this project's git history. Files that were never committed were not read in this mode."
        : "No secrets in the files on disk. Git history was not scanned, so a secret that was committed and later deleted would not show up here — turn on \"Scan git history instead\" in Configure to look for those.",
    };
  }
  const findings = items.map((raw): RawFinding => {
    const d = obj(raw);
    const rule = String(d.RuleID ?? d.rule ?? "secret");
    const line = Number(d.StartLine ?? d.startLine ?? 0);
    return {
      severity: "critical",
      category: `secret · ${rule}`,
      file: relativeTo(ctx.project.path, d.File ?? d.file),
      line: line > 0 ? line : undefined,
      message: `${String(d.Description ?? "Secret detected")} (${rule})`,
      // the match is redacted by the run itself; keep the location, not the value
      raw: {
        rule,
        file: d.File,
        line,
        commit: d.Commit || undefined,
        author: d.Author || undefined,
        date: d.Date || undefined,
        help: "Rotate this credential first, then remove it from the code and from git history.",
      },
    };
  });
  return { findings, summary: `${findings.length} secret${findings.length === 1 ? "" : "s"}` };
};

/* ------------------------------- osv-scanner -------------------------------- */
/** CVSS bands, the same ones the NVD publishes. */
function cvssSeverity(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "info";
}

function osvSeverityOf(group: unknown, vuln: Json): Severity {
  const raw = obj(group).max_severity ?? obj(vuln.database_specific).severity ?? "";
  const score = Number(raw);
  if (Number.isFinite(score) && score > 0) return cvssSeverity(score);
  const word = String(raw).toUpperCase();
  if (word === "CRITICAL") return "critical";
  if (word === "HIGH") return "high";
  if (word === "MODERATE" || word === "MEDIUM") return "medium";
  if (word === "LOW") return "low";
  // an advisory with no severity is still a known vulnerability
  return "medium";
}

/**
 * The upgrade command for the user to run (the fix agent may not edit lockfiles),
 * picked by the lockfile OSV reported.
 */
function upgradeCommand(lockfile: string | undefined, name: string): string | null {
  if (!lockfile) return null;
  const file = lockfile.split("/").pop()?.toLowerCase() ?? "";
  if (file === "pnpm-lock.yaml") return `pnpm up ${name}`;
  if (file === "package-lock.json") return `npm update ${name}`;
  if (file === "yarn.lock") return `yarn up ${name}`;
  if (file === "cargo.lock") return `cargo update -p ${name}`;
  if (file === "go.sum" || file === "go.mod") return `go get -u ${name}`;
  if (file === "requirements.txt" || file === "poetry.lock" || file === "pipfile.lock") {
    return `pip install -U ${name}`;
  }
  if (file === "composer.lock") return `composer update ${name}`;
  if (file === "gemfile.lock") return `bundle update ${name}`;
  return null;
}

/** One lookup table per package: the ids repeat for every vulnerability. */
function osvGroupIndex(pkg: Json): Map<string, unknown> {
  const byId = new Map<string, unknown>();
  for (const g of asArray(pkg.groups)) {
    for (const gid of asArray(obj(g).ids)) {
      const key = String(gid);
      if (!byId.has(key)) byId.set(key, g);
    }
  }
  return byId;
}

/** Every advisory reported against one package in one lockfile. */
function osvPackageFindings(raw: unknown, file: string | undefined): RawFinding[] {
  const pkg = obj(raw);
  const pkgMeta = obj(pkg.package);
  const name = String(pkgMeta.name ?? "dependency");
  const version = String(pkgMeta.version ?? "");
  const ecosystem = String(pkgMeta.ecosystem ?? "");
  const groupById = osvGroupIndex(pkg);
  const upgrade = upgradeCommand(file, name);
  const out: RawFinding[] = [];
  for (const v of asArray(pkg.vulnerabilities)) {
    const vuln = obj(v);
    const id = String(vuln.id ?? "");
    const summary = String(vuln.summary ?? vuln.details ?? "Known vulnerability").split("\n")[0];
    out.push({
      severity: osvSeverityOf(groupById.get(id), vuln),
      category: `dependency · ${id}`,
      file,
      message: `${name}@${version}: ${summary} (${id})`,
      raw: {
        id,
        package: name,
        version,
        ecosystem,
        aliases: vuln.aliases,
        fixed: obj(asArray(vuln.affected)[0]).ranges,
        help: [
          `Upgrade ${name} past the affected range.`,
          upgrade ? `Run: ${upgrade}` : "",
          "Fix with AI cannot do this: the agent may not edit a lockfile.",
          `Advisory: https://osv.dev/vulnerability/${id}`,
        ]
          .filter(Boolean)
          .join(" "),
      },
    });
  }
  return out;
}

const osvScanner: Adapter = async (res, ctx) => {
  const json = extractJson(res.combined);
  const findings: RawFinding[] = [];
  for (const src of asArray(obj(json).results)) {
    const source = obj(src);
    const file = relativeTo(ctx.project.path, obj(source.source).path);
    for (const p of asArray(source.packages)) findings.push(...osvPackageFindings(p, file));
  }
  if (!findings.length) {
    return {
      findings: [],
      summary: "No known vulnerabilities in this project's dependencies.",
    };
  }
  const packages = new Set(findings.map((f) => String(obj(f.raw).package))).size;
  return {
    findings,
    summary: `${findings.length} advisor${findings.length === 1 ? "y" : "ies"} in ${packages} package${packages === 1 ? "" : "s"}`,
  };
};

/* --------------------------------- semgrep ---------------------------------- */
const SEMGREP_SEVERITY = new Map<string, Severity>([
  ["ERROR", "high"],
  ["WARNING", "medium"],
  ["INFO", "low"],
]);

/** One semgrep result, normalised. */
function semgrepFinding(raw: unknown, ctx: AdapterCtx): RawFinding {
  const r = obj(raw);
  const rule = String(r.check_id ?? "semgrep");
  const extra = obj(r.extra);
  const metadata = obj(extra.metadata);
  const line = Number(obj(r.start).line ?? 0);
  // a rule tagged as security outranks its own reported severity
  const isSecurity = String(metadata.category ?? "").toLowerCase() === "security";
  const base = SEMGREP_SEVERITY.get(String(extra.severity ?? "").toUpperCase()) ?? "medium";
  return {
    severity: isSecurity && base === "medium" ? "high" : base,
    category: rule.split(".").slice(-2).join("."),
    file: relativeTo(ctx.project.path, r.path),
    line: line > 0 ? line : undefined,
    message: `${String(extra.message ?? rule).trim()} (${rule})`,
    raw: {
      rule,
      cwe: metadata.cwe,
      owasp: metadata.owasp,
      references: metadata.references,
      lines: extra.lines,
      help: `Semgrep rule ${rule}. ${String(asArray(metadata.references)[0] ?? "")}`.trim(),
    },
  };
}

/** Why semgrep reported nothing: an error, a missing report, or a clean tree. */
function semgrepEmptySummary(json: unknown, errors: unknown[], res: ProcResult): string {
  if (errors.length) {
    return `Semgrep could not complete: ${String(obj(errors[0]).message ?? "unknown error").slice(0, 200)}`;
  }
  // no JSON at all is a failed process, not an empty result
  if (!json) {
    const tail = logTail(res);
    return `Semgrep produced no report (exit ${res.code}). ${tail || "Check the raw log."}`;
  }
  // "no matches" over four files is not "no matches" over the whole tree
  const paths = obj(json).paths;
  const scanned = asArray(obj(paths).scanned).length;
  const skipped = asArray(obj(paths).skipped).length;
  const plural = scanned === 1 ? "" : "s";
  const alsoSkipped = skipped ? ` and skipped ${skipped}` : "";
  const read = scanned
    ? ` It read ${scanned} file${plural}${alsoSkipped}.`
    : " It read no files at all — check the ignore rules and the folder.";
  const coverage = paths ? read : "";
  return `No matches for the selected rules.${coverage}`;
}

const semgrep: Adapter = async (res, ctx) => {
  const json = extractJson(res.combined);
  const results = asArray(obj(json).results);
  const findings = results.map((r): RawFinding => semgrepFinding(r, ctx));

  const errors = asArray(obj(json).errors);
  if (!findings.length) {
    return { findings: [], summary: semgrepEmptySummary(json, errors, res) };
  }
  const touched = new Set<string>();
  for (const f of findings) if (f.file) touched.add(f.file);
  const files = touched.size;
  return { findings, summary: `${findings.length} in ${files} file${files === 1 ? "" : "s"}` };
};

/* ---------------------------------- generic --------------------------------- */
const generic: Adapter = async (res) => {
  const tail = logTail(res, 3);
  return {
    findings: [],
    summary: tail || (res.code === 0 ? "Completed." : `Exited with errors (exit ${res.code}).`),
  };
};

/* --------------------------------- graphify --------------------------------- */
/** Graphify makes a map, not a claim about the code: no findings, just the graph it wrote. */
const graphify: Adapter = async (res) => ({ findings: [], summary: graphSummaryOf(res) });

const ADAPTERS = new Map<string, Adapter>([
  ["graphify", graphify],
  ["react-doctor", reactDoctor],
  ["eslint", eslint],
  ["ruff", ruff],
  ["gitleaks", gitleaks],
  ["osv-scanner", osvScanner],
  ["semgrep", semgrep],
  ["unlighthouse", unlighthouse],
  ["strix", strix],
  ["sonarqube", sonarqube],
  ["generic", generic],
]);

export function getAdapter(name: string): Adapter {
  return ADAPTERS.get(name) ?? generic;
}
