import type { TabKey } from "@/lib/tab-order";

/**
 * Workspace's split panes, as a tree. A leaf is a **group**: a tab strip of its
 * own and one surface showing the tab in front. A **split** lays its children
 * out in a row (side by side) or a column (stacked), each with a share of the
 * space. Every tab lives in exactly one group; a group left empty closes, and a
 * split left with one child is replaced by that child.
 *
 * Pure on purpose: dragging a tab onto an edge, closing the last tab of a group,
 * restoring a layout whose terminals died with the last run — the cases that
 * break silently are all here, and all tested.
 */

export interface PaneGroup {
  kind: "group";
  id: string;
  /** In the strip's order. */
  tabs: TabKey[];
  /** The tab whose surface is showing; null only while the group is empty. */
  front: TabKey | null;
}

export interface PaneSplit {
  kind: "split";
  id: string;
  /** `row`: children side by side. `column`: stacked. */
  dir: "row" | "column";
  children: PaneNode[];
  /** One share per child, summing to 1. */
  sizes: number[];
}

export type PaneNode = PaneGroup | PaneSplit;

export interface PaneLayout {
  root: PaneNode;
  /** The group new tabs open in, and the one the keyboard talks to. */
  active: string;
}

/** Where a tab is dropped on a group: one of its edges splits it, the centre joins it. */
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

/** The smallest a pane may get, in CSS pixels; a split that would go below is refused. */
export const MIN_PANE_WIDTH = 240;
export const MIN_PANE_HEIGHT = 120;

let seq = 0;
/** Ids only need to be unique inside one layout; a counter plus the clock is plenty. */
function newId(prefix: "g" | "s"): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

export function emptyLayout(): PaneLayout {
  const id = newId("g");
  return { root: { kind: "group", id, tabs: [], front: null }, active: id };
}

/** Every group, in reading order (left to right, top to bottom). */
export function groupsOf(layout: PaneLayout): PaneGroup[] {
  const out: PaneGroup[] = [];
  const walk = (n: PaneNode) => {
    if (n.kind === "group") out.push(n);
    else n.children.forEach(walk);
  };
  walk(layout.root);
  return out;
}

export function groupById(layout: PaneLayout, id: string): PaneGroup | null {
  return groupsOf(layout).find((g) => g.id === id) ?? null;
}

export function groupOfTab(layout: PaneLayout, key: TabKey): PaneGroup | null {
  return groupsOf(layout).find((g) => g.tabs.includes(key)) ?? null;
}

export function activeGroup(layout: PaneLayout): PaneGroup {
  return groupById(layout, layout.active) ?? groupsOf(layout)[0];
}

/* --------------------------------- rebuilding -------------------------------- */

/** Rebuild the tree, replacing groups through `fn` (returning null drops the group). */
function mapGroups(node: PaneNode, fn: (g: PaneGroup) => PaneNode | null): PaneNode | null {
  if (node.kind === "group") return fn(node);
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const next = mapGroups(c, fn);
    if (next) {
      children.push(next);
      sizes.push(node.sizes[i] ?? 1 / node.children.length);
    }
  });
  if (!children.length) return null;
  return { ...node, children, sizes };
}

/** Shares that are positive and sum to 1, whatever came in. */
export function normalizeSizes(sizes: number[], count: number): number[] {
  const clean = Array.from({ length: count }, (_, i) => {
    const v = sizes[i];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1 / count;
  });
  const total = clean.reduce((a, b) => a + b, 0);
  return clean.map((v) => v / total);
}

/**
 * A split with one child becomes that child, a split inside a split going the
 * same way is folded into it (its shares scaled into the slot it had), and the
 * shares are made to sum to 1.
 */
function normalizeNode(node: PaneNode): PaneNode {
  if (node.kind === "group") return node;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  const own = normalizeSizes(node.sizes, node.children.length);
  node.children.forEach((raw, i) => {
    const child = normalizeNode(raw);
    if (child.kind === "split" && child.dir === node.dir) {
      const inner = normalizeSizes(child.sizes, child.children.length);
      child.children.forEach((c, j) => {
        children.push(c);
        sizes.push(own[i] * inner[j]);
      });
    } else {
      children.push(child);
      sizes.push(own[i]);
    }
  });
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: normalizeSizes(sizes, children.length) };
}

/**
 * Drop empty groups (the root group stays, even empty: the surface needs one),
 * collapse what that leaves, and point `active` at a group that exists.
 */
function settle(layout: PaneLayout): PaneLayout {
  const groups = groupsOf(layout);
  const keepOne = groups.every((g) => !g.tabs.length);
  const root = keepOne
    ? (layout.root.kind === "group" ? layout.root : { ...groups[0], tabs: [], front: null })
    : (mapGroups(layout.root, (g) => (g.tabs.length ? g : null)) ?? emptyLayout().root);
  const next = { ...layout, root: normalizeNode(root) };
  const ids = groupsOf(next).map((g) => g.id);
  return ids.includes(next.active) ? next : { ...next, active: ids[0] };
}

function withGroup(layout: PaneLayout, id: string, fn: (g: PaneGroup) => PaneGroup): PaneLayout {
  return { ...layout, root: mapGroups(layout.root, (g) => (g.id === id ? fn(g) : g)) ?? layout.root };
}

/** The tab that takes the front when `key` leaves: the one before it, else the one after. */
function neighbourOf(tabs: TabKey[], key: TabKey): TabKey | null {
  const i = tabs.indexOf(key);
  const rest = tabs.filter((k) => k !== key);
  if (!rest.length) return null;
  return rest[Math.max(0, Math.min(i - 1, rest.length - 1))] ?? rest[0];
}

function withoutTab(g: PaneGroup, key: TabKey): PaneGroup {
  if (!g.tabs.includes(key)) return g;
  const front = g.front === key ? neighbourOf(g.tabs, key) : g.front;
  return { ...g, tabs: g.tabs.filter((k) => k !== key), front };
}

/* ----------------------------------- tabs ------------------------------------ */

/**
 * Bring a tab to the front and make its group the active one. A tab that is in
 * no group yet joins the active group — that is where a new tab opens.
 */
export function focusTab(layout: PaneLayout, key: TabKey): PaneLayout {
  const home = groupOfTab(layout, key);
  if (home) {
    const next = withGroup(layout, home.id, (g) => ({ ...g, front: key }));
    return { ...next, active: home.id };
  }
  const target = activeGroup(layout);
  return withGroup(layout, target.id, (g) => ({ ...g, tabs: [...g.tabs, key], front: key }));
}

export function focusGroup(layout: PaneLayout, id: string): PaneLayout {
  return groupById(layout, id) ? { ...layout, active: id } : layout;
}

/** A closed tab leaves its group; the group closes with its last tab. */
export function removeTab(layout: PaneLayout, key: TabKey): PaneLayout {
  const home = groupOfTab(layout, key);
  if (!home) return layout;
  return settle(withGroup(layout, home.id, (g) => withoutTab(g, key)));
}

/**
 * Bring the layout in line with the tabs that exist: the ones gone (a terminal
 * that died with the last run, a file closed elsewhere) leave, the ones no group
 * holds join the active group in the order given.
 */
export function reconcile(layout: PaneLayout, existing: TabKey[]): PaneLayout {
  const live = new Set(existing);
  const heldNow = groupsOf(layout).flatMap((g) => g.tabs);
  // nothing gone, nothing new: the same object, so nobody re-renders or saves for it
  if (heldNow.every((k) => live.has(k)) && existing.every((k) => heldNow.includes(k))) return layout;
  let next: PaneLayout = {
    ...layout,
    root:
      mapGroups(layout.root, (g) =>
        // one at a time, so the front passes to the neighbour exactly as a direct close would
        g.tabs.filter((k) => !live.has(k)).reduce(withoutTab, g),
      ) ?? layout.root,
  };
  const held = new Set(groupsOf(next).flatMap((g) => g.tabs));
  const orphans = existing.filter((k) => !held.has(k));
  if (orphans.length) {
    const target = activeGroup(next);
    next = withGroup(next, target.id, (g) => ({ ...g, tabs: [...g.tabs, ...orphans], front: g.front ?? orphans[0] }));
  }
  return settle(next);
}

/** Reorder inside the group that holds both tabs: `from` takes `to`'s place. */
export function reorderTab(layout: PaneLayout, from: TabKey, to: TabKey): PaneLayout {
  const home = groupOfTab(layout, from);
  if (!home || !home.tabs.includes(to) || from === to) return layout;
  return withGroup(layout, home.id, (g) => {
    const tabs = g.tabs.filter((k) => k !== from);
    tabs.splice(g.tabs.indexOf(to), 0, from);
    return { ...g, tabs };
  });
}

/** One place left or right inside its group, wrapping nothing. */
export function nudgeInGroup(layout: PaneLayout, key: TabKey, step: -1 | 1): PaneLayout {
  const home = groupOfTab(layout, key);
  if (!home) return layout;
  const i = home.tabs.indexOf(key);
  const j = i + step;
  if (j < 0 || j >= home.tabs.length) return layout;
  return reorderTab(layout, key, home.tabs[j]);
}

/** Whether dropping on that edge would do anything (a group's only tab onto its own edge would not). */
export function canDrop(layout: PaneLayout, key: TabKey, targetId: string, edge: DropEdge): boolean {
  const source = groupOfTab(layout, key);
  const target = groupById(layout, targetId);
  if (!source || !target) return false;
  if (edge === "center") return source.id !== target.id;
  return !(source.id === target.id && source.tabs.length === 1);
}

/**
 * Move a tab onto a group: the centre puts it in that group's strip (before
 * `beforeKey` when given), an edge splits the group and puts the tab in a new
 * one on that side. The moved tab is in front, and its group is active.
 */
export function moveTab(
  layout: PaneLayout,
  key: TabKey,
  targetId: string,
  edge: DropEdge,
  beforeKey: TabKey | null = null,
): PaneLayout {
  const source = groupOfTab(layout, key);
  const target = groupById(layout, targetId);
  if (!source || !target) return layout;

  if (edge === "center") {
    if (source.id === target.id) return beforeKey ? focusTab(reorderTab(layout, key, beforeKey), key) : layout;
    const lifted = withGroup(layout, source.id, (g) => withoutTab(g, key));
    const placed = withGroup(lifted, target.id, (g) => {
      const tabs = [...g.tabs];
      const at = beforeKey ? tabs.indexOf(beforeKey) : -1;
      tabs.splice(at < 0 ? tabs.length : at, 0, key);
      return { ...g, tabs, front: key };
    });
    return settle({ ...placed, active: target.id });
  }

  if (!canDrop(layout, key, targetId, edge)) return layout;
  const fresh: PaneGroup = { kind: "group", id: newId("g"), tabs: [key], front: key };
  const dir: PaneSplit["dir"] = edge === "left" || edge === "right" ? "row" : "column";
  const first = edge === "left" || edge === "top";
  const lifted = withGroup(layout, source.id, (g) => withoutTab(g, key));
  // split the target where it stands; normalising folds it into a parent going the same way
  const split = {
    ...lifted,
    root:
      mapGroups(lifted.root, (g): PaneNode => {
        if (g.id !== target.id) return g;
        return { kind: "split", id: newId("s"), dir, children: first ? [fresh, g] : [g, fresh], sizes: [0.5, 0.5] };
      }) ?? lifted.root,
  };
  return settle({ ...split, active: fresh.id });
}

/** Ctrl+\: the active group's front tab into a new group on its right. */
export function splitActive(layout: PaneLayout, edge: Exclude<DropEdge, "center"> = "right"): PaneLayout {
  const g = activeGroup(layout);
  if (!g.front) return layout;
  return moveTab(layout, g.front, g.id, edge);
}

/* ---------------------------------- sizes ------------------------------------ */

export function setSizes(layout: PaneLayout, splitId: string, sizes: number[]): PaneLayout {
  const walk = (n: PaneNode): PaneNode => {
    if (n.kind === "group") return n;
    if (n.id === splitId) return { ...n, sizes: normalizeSizes(sizes, n.children.length) };
    return { ...n, children: n.children.map(walk) };
  };
  return { ...layout, root: walk(layout.root) };
}

/**
 * Moving the divider between children `i` and `i + 1` by `delta` (a share of
 * the split's length), held so neither side drops below `minShare`.
 */
export function dragDivider(sizes: number[], i: number, delta: number, minShare: number): number[] {
  const out = [...sizes];
  const pair = out[i] + out[i + 1];
  const left = Math.min(Math.max(out[i] + delta, minShare), pair - minShare);
  if (pair - 2 * minShare < 0) return out;
  out[i] = left;
  out[i + 1] = pair - left;
  return out;
}

/** Whether a group this big can be split on that edge without either half going under the minimum. */
export function splitFits(width: number, height: number, edge: DropEdge): boolean {
  if (edge === "center") return true;
  if (edge === "left" || edge === "right") return width / 2 >= MIN_PANE_WIDTH;
  return height / 2 >= MIN_PANE_HEIGHT;
}

/** Which part of a group a point falls in: the outer quarter on each side is an edge, the rest the centre. */
export function edgeAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): DropEdge {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const near = Math.min(fx, 1 - fx, fy, 1 - fy);
  if (near > 0.25) return "center";
  if (near === fx) return "left";
  if (near === 1 - fx) return "right";
  if (near === fy) return "top";
  return "bottom";
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The group the keyboard moves to: the nearest one whose centre lies in that
 * direction, preferring the one most in line with where focus is now.
 */
export function neighbourGroup(
  rects: Record<string, Rect>,
  fromId: string,
  dir: "left" | "right" | "up" | "down",
): string | null {
  const from = rects[fromId];
  if (!from) return null;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: { id: string; score: number } | null = null;
  for (const [id, r] of Object.entries(rects)) {
    if (id === fromId) continue;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const ahead = dir === "left" ? cx - x : dir === "right" ? x - cx : dir === "up" ? cy - y : y - cy;
    if (ahead <= 1) continue;
    const off = dir === "left" || dir === "right" ? Math.abs(y - cy) : Math.abs(x - cx);
    const score = ahead + off * 2;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

/* ------------------------------- persistence --------------------------------- */

const isTabKey = (v: unknown): v is TabKey => typeof v === "string" && /^[tfpc]:./.test(v);

function parseNode(raw: unknown, depth: number): PaneNode | null {
  if (depth > 16 || typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  if (r.kind === "group") {
    const tabs = Array.isArray(r.tabs) ? r.tabs.filter(isTabKey) : [];
    const front = isTabKey(r.front) && tabs.includes(r.front) ? r.front : (tabs[0] ?? null);
    return { kind: "group", id: r.id, tabs, front };
  }
  if (r.kind === "split" && (r.dir === "row" || r.dir === "column") && Array.isArray(r.children)) {
    const children = r.children.map((c) => parseNode(c, depth + 1)).filter((c): c is PaneNode => c !== null);
    if (!children.length) return null;
    const sizes = Array.isArray(r.sizes) ? r.sizes.map(Number) : [];
    return { kind: "split", id: r.id, dir: r.dir, children, sizes: normalizeSizes(sizes, children.length) };
  }
  return null;
}

/** A stored layout, or null when the text is not one. A tab claimed twice keeps its first group. */
export function parseLayout(text: string | null): PaneLayout | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const root = parseNode(r.root, 0);
  if (!root) return null;
  const seen = new Set<TabKey>();
  const dedup =
    mapGroups(root, (g) => {
      const tabs = g.tabs.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
      return { ...g, tabs, front: g.front && tabs.includes(g.front) ? g.front : (tabs[0] ?? null) };
    }) ?? root;
  const layout: PaneLayout = { root: dedup, active: typeof r.active === "string" ? r.active : "" };
  return settle(layout);
}

export function serializeLayout(layout: PaneLayout): string {
  return JSON.stringify(layout);
}
