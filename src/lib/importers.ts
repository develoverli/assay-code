/**
 * Discovery of skills and commands already installed on this machine, and of the
 * ones a project versions with its own code.
 *
 * Claude and opencode both store them as markdown with YAML frontmatter:
 *
 *   ~/.claude/skills/<name>/SKILL.md      name + description
 *   ~/.claude/commands/<name>.md          description + argument-hint
 *   ~/.config/opencode/skills/<name>/SKILL.md
 *   ~/.config/opencode/command/<name>.md
 *
 * Assay imports a **copy** into its own registry, so editing it here never
 * touches the original file.
 */
import { exists, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { homeDir, join } from "@tauri-apps/api/path";
import type { ToolSource } from "@/types";

export type ImportOrigin = "claude" | "opencode";

export interface ImportCandidate {
  /** Stable id for selection: origin + kind + name. */
  id: string;
  origin: ImportOrigin;
  kind: Extract<ToolSource, "skill" | "command">;
  name: string;
  description: string;
  /** Markdown body with the frontmatter stripped — this becomes the prompt. */
  body: string;
  path: string;
}

interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

/** Split `---\nkey: value\n---\nbody`. Values stay raw strings; that's all we need. */
function parseFrontmatter(text: string): Frontmatter {
  const t = text.replace(/^\uFEFF/, "");
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: t.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    // no `\s*` after the colon: it overlaps `(.*)` and backtracks quadratically,
    // and the value is trimmed below anyway
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trim() };
}

async function safeDir(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}

/** `<dir>/<name>.md` files — the command layout. */
async function readCommandDir(dir: string, origin: ImportOrigin): Promise<ImportCandidate[]> {
  if (!(await safeDir(dir))) return [];
  const out: ImportCandidate[] = [];
  for (const e of await readDir(dir)) {
    if (e.isDirectory || !e.name.toLowerCase().endsWith(".md")) continue;
    const path = await join(dir, e.name);
    try {
      const { meta, body } = parseFrontmatter(await readTextFile(path));
      const name = meta.name || e.name.replace(/\.md$/i, "");
      out.push({
        id: `${origin}:command:${name}`,
        origin,
        kind: "command",
        name,
        description: meta.description || "",
        body,
        path,
      });
    } catch {
      /* unreadable file — skip it rather than failing the whole scan */
    }
  }
  return out;
}

/** `<dir>/<name>/SKILL.md` folders — the skill layout. */
async function readSkillDir(dir: string, origin: ImportOrigin): Promise<ImportCandidate[]> {
  if (!(await safeDir(dir))) return [];
  const out: ImportCandidate[] = [];
  for (const e of await readDir(dir)) {
    const path = await join(dir, e.name, "SKILL.md");
    try {
      if (!(await exists(path))) continue;
      const { meta, body } = parseFrontmatter(await readTextFile(path));
      const name = meta.name || e.name;
      out.push({
        id: `${origin}:skill:${name}`,
        origin,
        kind: "skill",
        name,
        description: meta.description || "",
        body,
        path,
      });
    } catch {
      /* symlinked or unreadable skill — skip */
    }
  }
  return out;
}

/**
 * Everything importable on this machine, for one kind.
 * Duplicated names across origins are kept: they can differ in content.
 */
export async function discover(kind: "skill" | "command"): Promise<ImportCandidate[]> {
  const home = await homeDir();
  const roots: { dir: string; origin: ImportOrigin }[] =
    kind === "skill"
      ? [
          { dir: await join(home, ".claude", "skills"), origin: "claude" },
          { dir: await join(home, ".config", "opencode", "skills"), origin: "opencode" },
        ]
      : [
          { dir: await join(home, ".claude", "commands"), origin: "claude" },
          { dir: await join(home, ".config", "opencode", "command"), origin: "opencode" },
        ];

  const lists = await Promise.all(
    roots.map((r) => (kind === "skill" ? readSkillDir(r.dir, r.origin) : readCommandDir(r.dir, r.origin))),
  );
  return lists.flat().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The skills the project itself carries (`<root>/.claude/skills/<name>/SKILL.md`
 * and its opencode twin). Read in place, never copied: they belong to the repo.
 */
export async function discoverInProject(root: string): Promise<ImportCandidate[]> {
  const roots: { dir: string; origin: ImportOrigin }[] = [
    { dir: await join(root, ".claude", "skills"), origin: "claude" },
    { dir: await join(root, ".opencode", "skills"), origin: "opencode" },
  ];
  const lists = await Promise.all(roots.map((r) => readSkillDir(r.dir, r.origin)));
  return lists.flat().sort((a, b) => a.name.localeCompare(b.name));
}
