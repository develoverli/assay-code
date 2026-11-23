import { remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { join, tempDir } from "@tauri-apps/api/path";
import { probe, runProgram, runTokens, type ProcResult } from "@/lib/exec";
import { tr } from "@/lib/i18n";

/** Search inside the project's files with the best tool on the machine: ripgrep, `git grep`, then grep. */

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Which tool answered, for the footer of the results list. */
  engine: string;
  /** Set when the cap was reached, so the UI can say the list is partial. */
  truncated: boolean;
  error?: string;
}

const MAX_HITS = 300;
const MAX_LINE = 400;

/** `path:12:text` — the shape every one of these tools prints. */
function parseLines(out: string, root: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // the trailing slashes come off in a loop: `/\/+$/` backtracks quadratically
  let normRoot = root.replace(/\\/g, "/");
  while (normRoot.endsWith("/")) normRoot = normRoot.slice(0, -1);
  normRoot = normRoot.toLowerCase();
  for (const raw of out.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // a Windows path starts with "C:", so skip the drive colon before splitting
    const start = /^[A-Za-z]:[\\/]/.test(raw) ? 2 : 0;
    const first = raw.indexOf(":", start);
    if (first < 0) continue;
    const second = raw.indexOf(":", first + 1);
    if (second < 0) continue;
    const line = Number(raw.slice(first + 1, second));
    if (!Number.isFinite(line) || line <= 0) continue;
    let file = raw.slice(0, first).replace(/\\/g, "/").replace(/^\.\//, "");
    if (file.toLowerCase().startsWith(`${normRoot}/`)) file = file.slice(normRoot.length + 1);
    hits.push({ file, line, text: raw.slice(second + 1).trim().slice(0, MAX_LINE) });
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/**
 * How an engine receives the query. The query never travels on a command line: on
 * Windows a shell launcher is `cmd /c`, which expands `%NAME%` and splits on `&`
 * whatever the quoting, so `git` gets it as a bare argv entry and the others read
 * it from a pattern file (`-f`).
 */
export type EngineArgs =
  | { kind: "program"; program: string; args: string[] }
  | { kind: "tokens"; tokens: string[] };

interface Engine {
  name: string;
  probe: string;
  /** `patternFile` is only read by the engines that take the query from a file. */
  args: (query: string, patternFile: string) => EngineArgs;
}

/** One search, one line: a stray newline would become a second pattern, and an empty one matches everything. */
export function patternFileBody(query: string): string {
  return query.replace(/[\r\n]+/g, " ").trim();
}

export const ENGINES: readonly Engine[] = [
  {
    name: "ripgrep",
    probe: "rg --version",
    args: (_q, file) => ({
      kind: "tokens",
      tokens: ["rg", "--line-number", "--no-heading", "--color", "never", "--smart-case", "--max-count", "20", "-f", file, "."],
    }),
  },
  {
    name: "git grep",
    probe: "git --version",
    args: (q) => ({ kind: "program", program: "git", args: ["grep", "--line-number", "--no-color", "-I", "-i", "-e", q] }),
  },
  {
    name: "grep",
    probe: "grep --version",
    args: (_q, file) => ({
      kind: "tokens",
      tokens: [
        "grep",
        "-rniI",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        "--exclude-dir=target",
        "-f",
        file,
        ".",
      ],
    }),
  },
];

/** Write the query where `-f` can read it; the temp path is 8.3-short, so it needs no quoting. */
async function stagePatternFile(query: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const file = await join(await tempDir(), `assay-search-${Date.now()}-${suffix}.txt`);
  await writeTextFile(file, patternFileBody(query));
  return file;
}

async function runEngine(engine: Engine, query: string, root: string): Promise<ProcResult | null> {
  const direct = engine.args(query, "");
  if (direct.kind === "program") {
    return runProgram(direct.program, direct.args, { cwd: root }).result.catch(() => null);
  }
  const file = await stagePatternFile(query).catch(() => null);
  if (!file) return null;
  try {
    const call = engine.args(query, file);
    if (call.kind !== "tokens") return null;
    return await runTokens(call.tokens, { cwd: root }).result.catch(() => null);
  } finally {
    await remove(file).catch(() => undefined);
  }
}

/** Run the first available engine over `root`. Never throws: failures come back as `error`. */
export async function searchContent(root: string, query: string): Promise<SearchOutcome> {
  const q = query.trim();
  if (q.length < 2) return { hits: [], engine: "", truncated: false };

  for (const engine of ENGINES) {
    if (!(await probe(engine.probe))) continue;
    const res = await runEngine(engine, q, root);
    if (!res) continue;
    // exit 1 is "no matches" for every one of these, which is a result, not a failure
    if (res.code !== 0 && res.code !== 1 && !res.stdout.trim()) continue;
    const hits = parseLines(res.stdout, root);
    return { hits, engine: engine.name, truncated: hits.length >= MAX_HITS };
  }

  return {
    hits: [],
    engine: "",
    truncated: false,
    error: tr("No search tool found. Install ripgrep (rg) or git to search inside files."),
  };
}
