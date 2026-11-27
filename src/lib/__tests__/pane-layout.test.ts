import { describe, expect, it } from "vitest";
import {
  activeGroup,
  canDrop,
  dragDivider,
  edgeAt,
  emptyLayout,
  focusTab,
  groupOfTab,
  groupsOf,
  moveTab,
  neighbourGroup,
  nudgeInGroup,
  parseLayout,
  reconcile,
  removeTab,
  serializeLayout,
  splitActive,
  splitFits,
  type PaneLayout,
} from "@/lib/pane-layout";
import type { TabKey } from "@/lib/tab-order";

const T1: TabKey = "t:1";
const T2: TabKey = "t:2";
const F1: TabKey = "f:C:/repo/a.ts";
const F2: TabKey = "f:C:/repo/b.ts";

/** One group holding the given tabs, the last in front. */
const withTabs = (...keys: TabKey[]): PaneLayout => keys.reduce((l, k) => focusTab(l, k), emptyLayout());

describe("opening and focusing", () => {
  it("puts a new tab in the active group, in front", () => {
    const l = withTabs(T1, F1);
    expect(groupsOf(l)).toHaveLength(1);
    expect(activeGroup(l).tabs).toEqual([T1, F1]);
    expect(activeGroup(l).front).toBe(F1);
  });

  it("focusing a tab elsewhere moves the active group to it, without copying it", () => {
    let l = withTabs(T1, F1);
    l = moveTab(l, F1, activeGroup(l).id, "right");
    const left = groupOfTab(l, T1);
    expect(l.active).not.toBe(left?.id);
    l = focusTab(l, T1);
    expect(l.active).toBe(left?.id);
    expect(groupsOf(l).flatMap((g) => g.tabs).filter((k) => k === T1)).toHaveLength(1);
  });
});

describe("moveTab", () => {
  it("splits on an edge, the new group on that side and active", () => {
    const l0 = withTabs(T1, F1);
    const g = activeGroup(l0).id;
    const l = moveTab(l0, F1, g, "right");
    expect(l.root.kind).toBe("split");
    if (l.root.kind !== "split") return;
    expect(l.root.dir).toBe("row");
    const [first, second] = groupsOf(l);
    expect(first.tabs).toEqual([T1]);
    expect(second.tabs).toEqual([F1]);
    expect(l.active).toBe(second.id);
  });

  it("puts the new group first for left and top", () => {
    const l0 = withTabs(T1, F1);
    const l = moveTab(l0, F1, activeGroup(l0).id, "top");
    if (l.root.kind !== "split") throw new Error("expected a split");
    expect(l.root.dir).toBe("column");
    expect(groupsOf(l)[0].tabs).toEqual([F1]);
  });

  it("folds a split going the same way into its parent", () => {
    let l = withTabs(T1, T2, F1);
    l = moveTab(l, F1, activeGroup(l).id, "right");
    const right = activeGroup(l).id;
    l = focusTab(l, T2);
    l = moveTab(l, T2, groupOfTab(l, T2)?.id ?? "", "right");
    if (l.root.kind !== "split") throw new Error("expected a split");
    expect(l.root.children).toHaveLength(3);
    expect(l.root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(groupOfTab(l, F1)?.id).toBe(right);
  });

  it("joins another group in the centre and closes the group it left", () => {
    let l = withTabs(T1, F1);
    l = moveTab(l, F1, activeGroup(l).id, "right");
    const left = groupOfTab(l, T1)?.id ?? "";
    l = moveTab(l, F1, left, "center");
    expect(groupsOf(l)).toHaveLength(1);
    expect(activeGroup(l).tabs).toEqual([T1, F1]);
    expect(activeGroup(l).front).toBe(F1);
  });

  it("refuses a group's only tab onto its own edge or centre", () => {
    let l = withTabs(T1, F1);
    l = moveTab(l, F1, activeGroup(l).id, "right");
    const right = groupOfTab(l, F1)?.id ?? "";
    expect(canDrop(l, F1, right, "left")).toBe(false);
    expect(canDrop(l, F1, right, "center")).toBe(false);
    expect(moveTab(l, F1, right, "left")).toBe(l);
  });

  it("drops before a given tab in the target strip", () => {
    let l = withTabs(T1, T2, F1);
    l = moveTab(l, F1, activeGroup(l).id, "right");
    l = moveTab(l, F1, groupOfTab(l, T1)?.id ?? "", "center", T2);
    expect(activeGroup(l).tabs).toEqual([T1, F1, T2]);
  });
});

describe("closing", () => {
  it("brings the neighbour to the front", () => {
    let l = withTabs(T1, F1, F2);
    l = focusTab(l, F1);
    l = removeTab(l, F1);
    expect(activeGroup(l).front).toBe(T1);
  });

  it("closes a group with its last tab and collapses the split", () => {
    let l = withTabs(T1, F1);
    l = moveTab(l, F1, activeGroup(l).id, "bottom");
    l = removeTab(l, F1);
    expect(l.root.kind).toBe("group");
    expect(activeGroup(l).tabs).toEqual([T1]);
  });

  it("keeps one empty group when everything is closed", () => {
    const l = removeTab(withTabs(T1), T1);
    expect(l.root.kind).toBe("group");
    expect(activeGroup(l).tabs).toEqual([]);
    expect(activeGroup(l).front).toBeNull();
  });
});

describe("reconcile", () => {
  it("drops tabs that no longer exist and adopts new ones into the active group", () => {
    let l = withTabs(T1, F1);
    l = moveTab(l, F1, activeGroup(l).id, "right");
    l = reconcile(l, [F1, T2]);
    expect(groupsOf(l)).toHaveLength(1);
    expect(activeGroup(l).tabs).toEqual([F1, T2]);
  });
});

describe("keyboard", () => {
  it("nudges inside the group and stops at the ends", () => {
    let l = withTabs(T1, T2, F1);
    l = nudgeInGroup(l, F1, -1);
    expect(activeGroup(l).tabs).toEqual([T1, F1, T2]);
    expect(nudgeInGroup(l, T1, -1)).toBe(l);
  });

  it("splits the front tab to the right only when the group has another", () => {
    expect(groupsOf(splitActive(withTabs(T1)))).toHaveLength(1);
    expect(groupsOf(splitActive(withTabs(T1, F1)))).toHaveLength(2);
  });

  it("finds the neighbour in a direction", () => {
    const rects = {
      a: { left: 0, top: 0, width: 500, height: 400 },
      b: { left: 500, top: 0, width: 500, height: 200 },
      c: { left: 500, top: 200, width: 500, height: 200 },
    };
    expect(neighbourGroup(rects, "a", "right")).toBe("b");
    expect(neighbourGroup(rects, "c", "up")).toBe("b");
    expect(neighbourGroup(rects, "b", "left")).toBe("a");
    expect(neighbourGroup(rects, "a", "left")).toBeNull();
  });
});

describe("geometry", () => {
  const rect = { left: 0, top: 0, width: 400, height: 200 };

  it("reads the outer quarter as an edge and the rest as the centre", () => {
    expect(edgeAt(rect, 20, 100)).toBe("left");
    expect(edgeAt(rect, 390, 100)).toBe("right");
    expect(edgeAt(rect, 200, 10)).toBe("top");
    expect(edgeAt(rect, 200, 195)).toBe("bottom");
    expect(edgeAt(rect, 200, 100)).toBe("center");
  });

  it("refuses a split that would go under the minimum size", () => {
    expect(splitFits(400, 600, "right")).toBe(false);
    expect(splitFits(600, 200, "right")).toBe(true);
    expect(splitFits(600, 200, "bottom")).toBe(false);
    expect(splitFits(100, 100, "center")).toBe(true);
  });

  it("holds a dragged divider above the minimum on both sides", () => {
    expect(dragDivider([0.5, 0.5], 0, 0.2, 0.1)).toEqual([0.7, 0.30000000000000004]);
    expect(dragDivider([0.5, 0.5], 0, 0.9, 0.1)[0]).toBeCloseTo(0.9);
    expect(dragDivider([0.5, 0.5], 0, -0.9, 0.1)[0]).toBeCloseTo(0.1);
  });
});

describe("persistence", () => {
  it("round-trips a layout", () => {
    let l = withTabs(T1, F1);
    l = moveTab(l, F1, activeGroup(l).id, "right");
    const back = parseLayout(serializeLayout(l));
    expect(back && groupsOf(back).map((g) => g.tabs)).toEqual([[T1], [F1]]);
    expect(back?.active).toBe(l.active);
  });

  it("refuses junk and keeps a tab claimed twice in its first group", () => {
    expect(parseLayout("nope")).toBeNull();
    expect(parseLayout('{"root":{"kind":"x"}}')).toBeNull();
    const twice = JSON.stringify({
      active: "a",
      root: {
        kind: "split",
        id: "s",
        dir: "row",
        sizes: [1, 1],
        children: [
          { kind: "group", id: "a", tabs: [T1], front: T1 },
          { kind: "group", id: "b", tabs: [T1, F1], front: T1 },
        ],
      },
    });
    const l = parseLayout(twice);
    expect(l && groupsOf(l).map((g) => g.tabs)).toEqual([[T1], [F1]]);
    expect(l && groupsOf(l)[1].front).toBe(F1);
  });
});
