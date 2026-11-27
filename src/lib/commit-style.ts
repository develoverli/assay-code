import { exists } from "@tauri-apps/plugin-fs";
import * as db from "@/lib/db";
import type { Project } from "@/types";

/**
 * How Write with AI shapes a commit subject, per project.
 *
 * Gitmoji first (`✨ feat: …`) reads well, but release-please only recognises a
 * commit whose subject *starts* with the type, so in a repository it manages
 * those commits vanish from the changelog and never cut a release. A project
 * that carries release-please's files gets the type first (`feat: ✨ …`); the
 * user can force either style, or write a prompt of their own, per project.
 */

/** What a project resolves to. `custom` is the project's own prompt. */
export type CommitStyle = "gitmoji" | "release-please" | "custom";

/** What is stored on a project: `auto` follows what is in the repository. */
export type CommitStyleSetting = "auto" | CommitStyle;

/** The styles with a shared template, editable in Settings › AI. */
export type TemplateStyle = Exclude<CommitStyle, "custom">;

export const COMMIT_STYLE_SETTINGS: CommitStyleSetting[] = ["auto", "gitmoji", "release-please", "custom"];

/** The files whose presence says release-please manages the repository. */
export const RELEASE_PLEASE_FILES = ["release-please-config.json", ".release-please-manifest.json"] as const;

const TEMPLATE_KEY: Record<TemplateStyle, string> = {
  gitmoji: "commit.template.gitmoji",
  "release-please": "commit.template.release-please",
};

/** The prompts Assay ships. The diff is appended after them, never written into them. */
export const DEFAULT_TEMPLATES: Record<TemplateStyle, string> = {
  gitmoji: [
    "Write ONE git commit subject line for this diff. Output only that line, nothing else.",
    "Format: gitmoji + Conventional Commits, e.g. `✨ feat(auth): add magic link login`.",
    "Types: ✨ feat · 🐛 fix · ♻️ refactor · 📝 docs · 🎨 style · ⚡ perf · ✅ test · 🔧 chore · 🔒 security · ⬆️ deps.",
    "English, imperative mood, lowercase after the type, no trailing period, at most 72 characters.",
    "Describe what the change does, not which files moved.",
  ].join("\n"),
  "release-please": [
    "Write ONE git commit subject line for this diff. Output only that line, nothing else.",
    "Format: Conventional Commits with the type FIRST and the gitmoji after the colon,",
    "e.g. `feat(auth): ✨ add magic link login`. release-please ignores commits that start with an emoji.",
    "Types: feat ✨ · fix 🐛 · refactor ♻️ · docs 📝 · style 🎨 · perf ⚡ · test ✅ · chore 🔧 · build ⬆️ · ci 👷.",
    "Breaking change: add `!` after the type/scope.",
    "English, imperative mood, lowercase after the colon, no trailing period, at most 72 characters.",
    "Describe what the change does, not which files moved.",
  ].join("\n"),
};

export function isCommitStyleSetting(v: unknown): v is CommitStyleSetting {
  return typeof v === "string" && (COMMIT_STYLE_SETTINGS as string[]).includes(v);
}

/** The stored value as a setting; anything unknown (or NULL, a project from before) is `auto`. */
export function styleSettingOf(project: Pick<Project, "commit_style"> | null | undefined): CommitStyleSetting {
  const v = project?.commit_style;
  return isCommitStyleSetting(v) ? v : "auto";
}

/** `auto` becomes release-please when the repository carries its files, gitmoji otherwise. */
export function resolveStyle(setting: CommitStyleSetting, releasePleaseDetected: boolean): CommitStyle {
  if (setting !== "auto") return setting;
  return releasePleaseDetected ? "release-please" : "gitmoji";
}

/** Whether the folder has release-please's config or manifest at its root. */
export async function detectReleasePlease(root: string): Promise<boolean> {
  const base = root.replace(/[\\/]+$/, "");
  for (const name of RELEASE_PLEASE_FILES) {
    if (await exists(`${base}/${name}`).catch(() => false)) return true;
  }
  return false;
}

/** The shared template for a style: the user's edit when there is one, else Assay's. */
export async function getTemplate(style: TemplateStyle): Promise<string> {
  const saved = await db.getSetting(TEMPLATE_KEY[style]);
  return saved?.trim() ? saved : DEFAULT_TEMPLATES[style];
}

/** Saving the default text (or nothing) stores nothing, so a later improvement to the default reaches it. */
export async function setTemplate(style: TemplateStyle, text: string): Promise<void> {
  const same = !text.trim() || text.trim() === DEFAULT_TEMPLATES[style].trim();
  await db.setSetting(TEMPLATE_KEY[style], same ? "" : text);
}

/** The instructions Write with AI sends for this project, before the diff. */
export async function promptFor(style: CommitStyle, project: Pick<Project, "commit_prompt"> | null | undefined): Promise<string> {
  if (style === "custom") {
    const own = project?.commit_prompt?.trim();
    // a custom style with nothing written yet behaves like the plain default
    return own || getTemplate("gitmoji");
  }
  return getTemplate(style);
}

export function buildCommitPrompt(instructions: string, diff: string): string {
  return `${instructions.trimEnd()}\n\n${diff}`;
}

/* ---------------------------- reading a subject ----------------------------- */

/** A leading run of emoji (with variation selectors and joiners), or a `:shortcode:`. */
const LEADING_EMOJI = /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍|\p{Extended_Pictographic}|\p{Emoji_Modifier})*|:[a-z0-9_+-]+:)\s*/u;

/** `type(scope)!: description`, the header Conventional Commits defines. */
const HEADER = /^([a-zA-Z]+)(?:\(([^()\r\n]*)\))?(!)?: (.+)$/;

export interface ParsedSubject {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
  /** The subject started with an emoji, so release-please did not see it. */
  emojiFirst: boolean;
}

/**
 * The Conventional Commits header of a subject, in either order: `feat(x): ✨ y`
 * and `✨ feat(x): y` both parse, the second flagged `emojiFirst`. Null when
 * there is no header at all.
 */
export function parseSubject(subject: string): ParsedSubject | null {
  const line = subject.split(/\r?\n/, 1)[0].trim();
  const stripped = line.replace(LEADING_EMOJI, "");
  const m = HEADER.exec(stripped);
  if (!m) return null;
  return {
    type: m[1].toLowerCase(),
    scope: m[2] ?? null,
    breaking: m[3] === "!",
    description: m[4].trim(),
    emojiFirst: stripped !== line,
  };
}

/** Subjects git writes itself, which nobody expects in a changelog. */
const GIT_GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

export type SubjectCheck = "ok" | "emoji-first" | "no-type";

/**
 * Whether release-please will read this subject. Merges, reverts and fixups that
 * git wrote are left alone, and so is an empty box: there is nothing to warn about yet.
 */
export function checkReleasePleaseSubject(message: string): SubjectCheck {
  const line = message.split(/\r?\n/, 1)[0].trim();
  if (!line || GIT_GENERATED.test(line)) return "ok";
  const parsed = parseSubject(line);
  if (!parsed) return "no-type";
  return parsed.emojiFirst ? "emoji-first" : "ok";
}

/**
 * `✨ feat(x): y` → `feat(x): ✨ y`. Only the first line moves; a subject that is
 * already in order, or has no header to move to the front, comes back unchanged.
 */
export function fixTypeOrder(message: string): string {
  const [first, ...rest] = message.split(/\r?\n/);
  const line = first.trim();
  const emoji = LEADING_EMOJI.exec(line)?.[0].trim();
  if (!emoji) return message;
  const parsed = parseSubject(line);
  if (!parsed) return message;
  const header = `${parsed.type}${parsed.scope !== null ? `(${parsed.scope})` : ""}${parsed.breaking ? "!" : ""}`;
  return [`${header}: ${emoji} ${parsed.description}`, ...rest].join("\n");
}
