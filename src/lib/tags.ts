import { TAG_COLORS, type Project, type Tag, type TagColor } from "@/types";

/**
 * Project tags: colour, name rules, filtering and grouping. Colours are the
 * `--color-tag-<name>` tokens in `styles/globals.css`.
 */

/** The CSS custom property for a colour, resolved by name and never by index. */
const VAR_BY_COLOR = new Map<string, string>(
  TAG_COLORS.map((c) => [c, `var(--color-tag-${c})`] as const),
);

const FALLBACK: TagColor = "slate";

/** A stored colour the app still understands, or the neutral one. */
export function tagColor(value: string | null | undefined): TagColor {
  const v = String(value ?? "").trim();
  return VAR_BY_COLOR.has(v) ? (v as TagColor) : FALLBACK;
}

/** The colour as a value a style attribute can carry. */
export function tagColorVar(value: string | null | undefined): string {
  return VAR_BY_COLOR.get(tagColor(value)) ?? `var(--color-tag-${FALLBACK})`;
}

/** The one custom property `.tag-badge` in `globals.css` derives wash, border and text from. */
export function tagVars(value: string | null | undefined): Record<"--tag", string> {
  return { "--tag": tagColorVar(value) };
}

/* ---------------------------------- names ----------------------------------- */
export const TAG_NAME_MAX = 24;

/** Trimmed, collapsed and capped: what actually gets stored. */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, TAG_NAME_MAX);
}

/**
 * Why this name can't be used, or null when it can. Case-insensitive, matching the
 * unique index on `lower(name)`, so the user gets a sentence instead of a SQL error.
 */
export function tagNameError(name: string, existing: Tag[], selfId?: string): string | null {
  const clean = normalizeTagName(name);
  if (!clean) return "A tag needs a name.";
  const lower = clean.toLowerCase();
  const clash = existing.some((x) => x.id !== selfId && x.name.trim().toLowerCase() === lower);
  return clash ? "There is already a tag with that name." : null;
}

/* --------------------------------- filtering -------------------------------- */
/** The projects a filter leaves visible. Several tags mean OR (an AND of categories is almost always empty). */
export function filterByTags(projects: Project[], selected: string[]): Project[] {
  if (!selected.length) return projects;
  const want = new Set(selected);
  return projects.filter((p) => p.tags.some((id) => want.has(id)));
}

export interface TagGroup {
  /** The tag this section is for, or null for the projects that have none. */
  tag: Tag | null;
  projects: Project[];
}

/**
 * The same projects, cut into sections by tag. A project appears under every tag it
 * carries; empty sections are dropped and the untagged go last.
 */
export function groupByTag(projects: Project[], tags: Tag[], selected: string[] = []): TagGroup[] {
  const want = new Set(selected);
  const shown = selected.length ? tags.filter((x) => want.has(x.id)) : tags;
  const groups: TagGroup[] = [];

  for (const tag of shown) {
    const members = projects.filter((p) => p.tags.includes(tag.id));
    if (members.length) groups.push({ tag, projects: members });
  }

  // untagged only when no tag filter is active
  if (!selected.length) {
    const orphans = projects.filter((p) => !p.tags.length);
    if (orphans.length) groups.push({ tag: null, projects: orphans });
  }

  return groups;
}

/** The tags of one project, in the order the tag list is in. */
export function tagsOf(project: Project, tags: Tag[]): Tag[] {
  const own = new Set(project.tags);
  return tags.filter((x) => own.has(x.id));
}

/** How many projects carry a tag — what the delete confirmation has to say. */
export function tagUsage(tagId: string, projects: Project[]): number {
  return projects.reduce((n, p) => (p.tags.includes(tagId) ? n + 1 : n), 0);
}
