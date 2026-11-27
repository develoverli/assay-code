import * as React from "react";
import { canDrop, edgeAt, splitFits, type DropEdge, type PaneLayout } from "@/lib/pane-layout";
import type { TabKey } from "@/lib/tab-order";

/**
 * Dragging a tab: onto another tab (reorder, or join that pane before it), onto
 * a pane's strip (join it at the end), or onto a pane's surface, where the outer
 * quarter on each side splits the pane and the middle joins it.
 *
 * Pointer events, not HTML5 drag and drop: Tauri takes drops at the OS level,
 * which on Windows silences the webview's `dragover`/`drop`. The pointer is
 * captured once the drag starts, so an iframe (a pinned page) or a terminal under
 * it cannot swallow the moves.
 */

export type DragTarget =
  | { kind: "tab"; key: TabKey; group: string }
  | { kind: "strip"; group: string }
  | { kind: "edge"; group: string; edge: DropEdge };

export interface TabDragProps {
  tabKey: TabKey;
  state: "source" | "target" | null;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
}

export interface PaneDrag {
  /** The tab being dragged and where it would land; null when nothing is dragged. */
  active: { from: TabKey; target: DragTarget | null } | null;
  tabProps: (key: TabKey) => TabDragProps;
}

/** How far the pointer travels before a press on a tab becomes a drag, not a click. */
const DRAG_THRESHOLD = 5;

/** Where a drag at this point would land, or null when nowhere would take it. */
function targetAt(x: number, y: number, from: TabKey, layout: PaneLayout): DragTarget | null {
  const el = document.elementFromPoint(x, y);
  const groupEl = el?.closest("[data-pane-group]");
  const group = groupEl?.getAttribute("data-pane-group");
  if (!el || !group) return null;

  const tab = el.closest("[data-tab-key]")?.getAttribute("data-tab-key") as TabKey | null | undefined;
  if (tab && tab !== from) return { kind: "tab", key: tab, group };

  if (el.closest("[data-pane-strip]")) return canDrop(layout, from, group, "center") ? { kind: "strip", group } : null;

  const surface = el.closest("[data-pane-surface]");
  if (!surface) return null;
  const rect = surface.getBoundingClientRect();
  const edge = edgeAt(rect, x, y);
  // a split that would leave a pane under the minimum is not offered at all
  if (!splitFits(rect.width, rect.height, edge)) return null;
  return canDrop(layout, from, group, edge) ? { kind: "edge", group, edge } : null;
}

const sameTarget = (a: DragTarget | null, b: DragTarget | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function usePaneDrag(layout: PaneLayout, onDrop: (from: TabKey, target: DragTarget) => void): PaneDrag {
  const [active, setActive] = React.useState<PaneDrag["active"]>(null);
  const press = React.useRef<{
    key: TabKey;
    x: number;
    y: number;
    moving: boolean;
    el: HTMLElement;
    pointer: number;
  } | null>(null);
  // the listeners are registered once; what they read moves through refs
  const latest = React.useRef({ layout, onDrop });
  React.useEffect(() => {
    latest.current = { layout, onDrop };
  });

  React.useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.moving) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
        p.moving = true;
        try {
          p.el.setPointerCapture(p.pointer);
        } catch {
          /* the element left the DOM between press and move; the window listeners still work */
        }
        document.body.style.cursor = "grabbing";
      }
      const target = targetAt(e.clientX, e.clientY, p.key, latest.current.layout);
      setActive((cur) => (cur && cur.from === p.key && sameTarget(cur.target, target) ? cur : { from: p.key, target }));
    };
    const onUp = (e: PointerEvent) => {
      const p = press.current;
      press.current = null;
      if (!p?.moving) return;
      document.body.style.cursor = "";
      const target = targetAt(e.clientX, e.clientY, p.key, latest.current.layout);
      setActive(null);
      if (target) latest.current.onDrop(p.key, target);
    };
    const onCancel = () => {
      if (press.current?.moving) document.body.style.cursor = "";
      press.current = null;
      setActive(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  const tabProps = (key: TabKey): TabDragProps => ({
    tabKey: key,
    state:
      active?.from === key ? "source" : active?.target?.kind === "tab" && active.target.key === key ? "target" : null,
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      press.current = { key, x: e.clientX, y: e.clientY, moving: false, el: e.currentTarget, pointer: e.pointerId };
    },
  });

  return { active, tabProps };
}
