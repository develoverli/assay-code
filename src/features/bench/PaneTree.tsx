import * as React from "react";
import { dragDivider, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, type PaneNode, type PaneSplit } from "@/lib/pane-layout";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The split tree laid out with flex: each child takes its share, with a divider
 * between neighbours that can be dragged (pointer captured, so a terminal or a
 * page under the pointer cannot swallow the move) or nudged with the arrow keys.
 */

/** How much one arrow-key press moves a divider, as a share of the split. */
const KEY_STEP = 0.02;

function Divider({
  split,
  index,
  containerRef,
  onSizes,
}: {
  split: PaneSplit;
  index: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSizes: (splitId: string, sizes: number[]) => void;
}) {
  const t = useT();
  const row = split.dir === "row";
  const start = React.useRef<{ pos: number; sizes: number[]; length: number } | null>(null);

  const minShare = (length: number) => Math.min(0.45, (row ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT) / Math.max(length, 1));
  const lengthNow = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect ? (row ? rect.width : rect.height) : 0;
  };

  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={t("Resize panes")}
      aria-valuenow={Math.round((split.sizes[index] ?? 0) * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: row ? e.clientX : e.clientY, sizes: split.sizes, length: lengthNow() };
        document.body.style.cursor = row ? "col-resize" : "row-resize";
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || !s.length) return;
        const delta = ((row ? e.clientX : e.clientY) - s.pos) / s.length;
        onSizes(split.id, dragDivider(s.sizes, index, delta, minShare(s.length)));
      }}
      onPointerUp={() => {
        start.current = null;
        document.body.style.cursor = "";
      }}
      onPointerCancel={() => {
        start.current = null;
        document.body.style.cursor = "";
      }}
      onKeyDown={(e) => {
        const back = row ? "ArrowLeft" : "ArrowUp";
        const fwd = row ? "ArrowRight" : "ArrowDown";
        if (e.key !== back && e.key !== fwd) return;
        e.preventDefault();
        const step = e.key === fwd ? KEY_STEP : -KEY_STEP;
        onSizes(split.id, dragDivider(split.sizes, index, step, minShare(lengthNow())));
      }}
      className={cn(
        "group relative z-10 shrink-0 bg-border transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        row ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
    >
      {/* a wider invisible grip than the 1px line it draws */}
      <span aria-hidden className={cn("absolute", row ? "inset-y-0 -left-1.5 -right-1.5" : "inset-x-0 -top-1.5 -bottom-1.5")} />
    </div>
  );
}

export function PaneTree({
  node,
  renderGroup,
  onSizes,
}: {
  node: PaneNode;
  renderGroup: (groupId: string) => React.ReactNode;
  onSizes: (splitId: string, sizes: number[]) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  if (node.kind === "group") return <>{renderGroup(node.id)}</>;
  const row = node.dir === "row";
  return (
    <div ref={containerRef} className={cn("flex h-full min-h-0 w-full min-w-0", row ? "flex-row" : "flex-col")}>
      {node.children.map((child, i) => (
        <React.Fragment key={child.id}>
          {i > 0 && <Divider split={node} index={i - 1} containerRef={containerRef} onSizes={onSizes} />}
          <div className="flex min-h-0 min-w-0" style={{ flex: `${node.sizes[i] ?? 1} 1 0px` }}>
            <PaneTree node={child} renderGroup={renderGroup} onSizes={onSizes} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
