import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as React from "react";

/**
 * Files dragged from the desktop onto the window. Tauri takes the drop at the OS
 * level, so the HTML `drop` never fires; it gives the paths plus the cursor position,
 * which picks the zone (terminal or editor).
 */

export type DropZone = "terminal" | "editor";

const ZONE_ATTR = "data-drop-zone";

/** The split pane a zone belongs to, when Workspace is split. */
const GROUP_ATTR = "data-pane-group";

/** A zone, and the pane it sits in. */
export interface DropTarget {
  zone: DropZone;
  /** The pane under the cursor; null outside the split panes. */
  group: string | null;
}

/** Which surface is under the cursor, by the attribute the panes carry. */
function zoneAt(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest(`[${ZONE_ATTR}]`);
  const zone = el?.getAttribute(ZONE_ATTR);
  if (zone !== "terminal" && zone !== "editor") return null;
  return { zone, group: el?.closest(`[${GROUP_ATTR}]`)?.getAttribute(GROUP_ATTR) ?? null };
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null): boolean =>
  a === b || (!!a && !!b && a.zone === b.zone && a.group === b.group);

/** The zone under the cursor while a drag is in flight (for the highlight), and the drop itself. */
export function useFileDrop(onDrop: (target: DropTarget, paths: string[]) => void): DropTarget | null {
  const [hover, setHover] = React.useState<DropTarget | null>(null);
  // the listener is registered once; the handler is read through a ref
  const handler = React.useRef(onDrop);
  React.useEffect(() => {
    handler.current = onDrop;
  });

  React.useEffect(() => {
    let stop: (() => void) | null = null;
    let gone = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setHover(null);
          return;
        }
        // the position is in physical pixels; the DOM is in CSS ones
        const ratio = window.devicePixelRatio || 1;
        const target = zoneAt(payload.position.x / ratio, payload.position.y / ratio);
        if (payload.type === "enter" || payload.type === "over") {
          // `over` fires on every pointer move; a new object each time would re-render for nothing
          setHover((cur) => (sameTarget(cur, target) ? cur : target));
          return;
        }
        setHover(null);
        if (target && payload.paths.length) handler.current(target, payload.paths);
      })
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      });

    return () => {
      gone = true;
      stop?.();
    };
  }, []);

  return hover;
}
