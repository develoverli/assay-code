import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as React from "react";

/**
 * Files dragged from the desktop onto the window. Tauri takes the drop at the OS
 * level, so the HTML `drop` never fires; it gives the paths plus the cursor position,
 * which picks the zone (terminal or editor).
 */

export type DropZone = "terminal" | "editor";

const ZONE_ATTR = "data-drop-zone";

/** Which surface is under the cursor, by the attribute the panes carry. */
function zoneAt(x: number, y: number): DropZone | null {
  const el = document.elementFromPoint(x, y);
  const zone = el?.closest(`[${ZONE_ATTR}]`)?.getAttribute(ZONE_ATTR);
  return zone === "terminal" || zone === "editor" ? zone : null;
}

/** The zone under the cursor while a drag is in flight (for the highlight), and the drop itself. */
export function useFileDrop(onDrop: (zone: DropZone, paths: string[]) => void): DropZone | null {
  const [hover, setHover] = React.useState<DropZone | null>(null);
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
        const zone = zoneAt(payload.position.x / ratio, payload.position.y / ratio);
        if (payload.type === "enter" || payload.type === "over") {
          setHover(zone);
          return;
        }
        setHover(null);
        if (zone && payload.paths.length) handler.current(zone, payload.paths);
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
