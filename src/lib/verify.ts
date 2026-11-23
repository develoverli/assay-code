/**
 * Build verification after an AI fix: the project's own commands, detected from
 * what the repo declares, never invented.
 */
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { makeTargets } from "@/lib/scripts";

export interface Check {
  /** Stable id, also the settings key: "npm:build", "cargo:check"… */
  id: string;
  label: string;
  /** argv, run without a shell. */
  tokens: string[];
  /** Why Assay thinks this exists. */
  source: string;
}

/** Package-manager scripts worth running, in the order they should run. */
const SCRIPT_ORDER = ["typecheck", "type-check", "tsc", "lint", "build", "test"];

/** A parsed JSON object: its fields are unknown until they are read. */
function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await exists(path)) ? await readTextFile(path) : null;
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    if (!(await exists(path))) return null;
    return JSON.parse(await readTextFile(path));
  } catch {
    return null;
  }
}

/** Which package manager the lockfile says to use. */
async function packageManager(dir: string): Promise<"pnpm" | "yarn" | "npm"> {
  if (await exists(await join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(await join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Everything this project can be checked with. Order matters: cheap and precise
 * first (types), slow and broad last (tests), so a failure surfaces fast.
 */
export async function detectChecks(projectPath: string): Promise<Check[]> {
  const out: Check[] = [];

  const pkg = obj(await readJson(await join(projectPath, "package.json")));
  const scripts = new Map<string, unknown>(Object.entries(obj(pkg.scripts)));
  if (scripts.size) {
    const pm = await packageManager(projectPath);
    for (const name of SCRIPT_ORDER) {
      if (typeof scripts.get(name) !== "string") continue;
      out.push({
        id: `${pm}:${name}`,
        label: `${pm} ${name}`,
        tokens: [pm, "run", name],
        source: `package.json script "${name}"`,
      });
    }
  }

  if (await exists(await join(projectPath, "Cargo.toml"))) {
    out.push({ id: "cargo:check", label: "cargo check", tokens: ["cargo", "check"], source: "Cargo.toml" });
    out.push({ id: "cargo:test", label: "cargo test", tokens: ["cargo", "test"], source: "Cargo.toml" });
  }

  if (await exists(await join(projectPath, "go.mod"))) {
    out.push({ id: "go:build", label: "go build ./…", tokens: ["go", "build", "./..."], source: "go.mod" });
    out.push({ id: "go:test", label: "go test ./…", tokens: ["go", "test", "./..."], source: "go.mod" });
  }

  // pytest.ini wins over pyproject.toml when both exist, as it does for pytest itself
  const pyFile = (await exists(await join(projectPath, "pytest.ini")))
    ? "pytest.ini"
    : (await exists(await join(projectPath, "pyproject.toml")))
      ? "pyproject.toml"
      : null;
  if (pyFile) out.push({ id: "py:pytest", label: "pytest", tokens: ["pytest", "-q"], source: pyFile });

  // a Makefile alone says nothing: `make build` without that target only fails
  const makefile = await readText(await join(projectPath, "Makefile"));
  if (makefile !== null && makeTargets(makefile).includes("build")) {
    out.push({ id: "make:build", label: "make build", tokens: ["make", "build"], source: 'Makefile target "build"' });
  }

  return out;
}

/** Default selection: the first build check, else the first check found. */
export function defaultSelection(checks: Check[]): string[] {
  const preferred = checks.find((c) => c.id.endsWith("build")) ?? checks[0];
  return preferred ? [preferred.id] : [];
}
