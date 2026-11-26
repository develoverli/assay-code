import { create } from "zustand";
import type { PreviewTarget } from "./link-detect";

/**
 * The hover preview over a terminal link. The link providers live outside React
 * (xterm calls them), so they talk to the popover through this store: hover
 * arms a timer, the popover shows once the pointer has rested, and leaving
 * gives the pointer a moment to cross into the popover before it closes.
 */

/** How long the pointer rests on a link before the preview opens. */
const OPEN_DELAY = 400;
/** Time to travel from the link into the popover without it closing. */
const CLOSE_DELAY = 200;

export interface PreviewAnchor {
  /** Viewport coordinates of the pointer when the link was hovered. */
  x: number;
  y: number;
}

interface LinkPreviewState {
  target: PreviewTarget | null;
  anchor: PreviewAnchor | null;
  /** The terminal session that printed the link, so a tab switch can close it. */
  sessionId: string | null;
}

export const useLinkPreview = create<LinkPreviewState>(() => ({ target: null, anchor: null, sessionId: null }));

let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

const clear = (t: ReturnType<typeof setTimeout> | null): null => {
  if (t) clearTimeout(t);
  return null;
};

/** The pointer reached a link: open after the rest delay, unless it moves on first. */
export function hoverLink(target: PreviewTarget, anchor: PreviewAnchor, sessionId: string): void {
  closeTimer = clear(closeTimer);
  openTimer = clear(openTimer);
  openTimer = setTimeout(() => {
    openTimer = null;
    useLinkPreview.setState({ target, anchor, sessionId });
  }, OPEN_DELAY);
}

/** The pointer left the link: cancel a pending open, and close unless it reaches the popover. */
export function leaveLink(): void {
  openTimer = clear(openTimer);
  closeTimer = clear(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    useLinkPreview.setState({ target: null, anchor: null, sessionId: null });
  }, CLOSE_DELAY);
}

/** The pointer is over the popover itself: keep it. */
export function holdPreview(): void {
  closeTimer = clear(closeTimer);
}

export function closePreview(): void {
  openTimer = clear(openTimer);
  closeTimer = clear(closeTimer);
  if (useLinkPreview.getState().target) useLinkPreview.setState({ target: null, anchor: null, sessionId: null });
}
