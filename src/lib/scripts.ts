import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

/**
 * The project's own commands as the repo's root declares them, never invented.
 * Stars and hand-written commands live in `project_commands` (migration 012).
 */

export type ScriptSource = "package.json" | "Cargo.toml" | "Makefile" | "composer.json";

export interface ProjectScript {
  /** What the menu and the tab call it: the script or target name. */
  name: string;
  /** The line the shell runs. Also the identity a star is stored against. */
  command: string;
  source: ScriptSource;
}

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/** Lockfiles in the order they win when a repo carries more than one. */
const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

/** The manager the lockfiles present say to use; npm when there is none. */
export function managerFrom(present: string[]): PackageManager {
  const have = new Set(present);
  return LOCKFILES.find(([file]) => have.has(file))?.[1] ?? "npm";
}

/** How that manager runs a script: npm needs `run`, the others take the name bare. */
export function runScript(pm: PackageManager, name: string): string {
  return pm === "npm" ? `npm run ${name}` : `${pm} ${name}`;
}

/** `scripts` of a package.json or composer.json, keeping only string commands. */
export function scriptNames(json: unknown): string[] {
  if (typeof json !== "object" || json === null) return [];
  const scripts = (json as Record<string, unknown>).scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  return Object.entries(scripts)
    .filter(([, v]) => typeof v === "string" || Array.isArray(v))
    .map(([k]) => k);
}

/**
 * The targets a Makefile offers to a person: a name at the start of a line,
 * followed by one colon. Pattern rules (`%.o:`), variables (`X := 1`), special
 * targets (`.PHONY`) and helpers named with a leading underscore are skipped.
 */
export function makeTargets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.\/-]*)\s*:(?![:=])/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (name.includes("%") || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** The cargo commands worth a button in any crate. */
const CARGO = ["run", "build", "test", "check"];

async function readText(path: string): Promise<string | null> {
  try {
    return (await exists(path)) ? await readTextFile(path) : null;
  } catch {
    return null;
  }
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Everything the project's root declares, grouped by where it came from. */
export async function detectScripts(root: string): Promise<ProjectScript[]> {
  const at = (file: string) => join(root, file);
  const out: ProjectScript[] = [];

  const pkg = scriptNames(parseJson(await readText(await at("package.json"))));
  if (pkg.length) {
    const present: string[] = [];
    for (const [file] of LOCKFILES) if (await exists(await at(file)).catch(() => false)) present.push(file);
    const pm = managerFrom(present);
    for (const name of pkg) out.push({ name, command: runScript(pm, name), source: "package.json" });
  }

  if (await exists(await at("Cargo.toml")).catch(() => false)) {
    for (const name of CARGO) out.push({ name, command: `cargo ${name}`, source: "Cargo.toml" });
  }

  const make = (await readText(await at("Makefile"))) ?? (await readText(await at("makefile")));
  if (make) for (const name of makeTargets(make)) out.push({ name, command: `make ${name}`, source: "Makefile" });

  for (const name of scriptNames(parseJson(await readText(await at("composer.json"))))) {
    out.push({ name, command: `composer run ${name}`, source: "composer.json" });
  }
  return out;
}
