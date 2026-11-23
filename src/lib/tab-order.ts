/**
 * The order of the Workspace tab strip, as the user arranged it. Keys are
 * `t:<session id>` or `f:<absolute path>`, one list shared by every project; a tab
 * never moved has no entry and goes at the end in opening order.
 */

export type TabKey = `t:${string}` | `f:${string}`;

export const terminalKey = (id: string): TabKey => `t:${id}`;
export const fileKey = (path: string): TabKey => `f:${path}`;

/** `keys` in the user's order; the ones never placed keep their own order, last. */
export function orderTabs(keys: TabKey[], order: TabKey[]): TabKey[] {
  const at = new Map(order.map((k, i) => [k, i] as const));
  const placed = keys.filter((k) => at.has(k)).sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0));
  return [...placed, ...keys.filter((k) => !at.has(k))];
}

/**
 * Move `from` to where `to` is: before it when dragged leftwards, after it when
 * dragged rightwards — the tab lands where it was dropped either way.
 */
export function moveTab(keys: TabKey[], from: TabKey, to: TabKey): TabKey[] {
  const src = keys.indexOf(from);
  const dst = keys.indexOf(to);
  if (src < 0 || dst < 0 || src === dst) return keys;
  const out = keys.filter((k) => k !== from);
  out.splice(dst, 0, from);
  return out;
}

/** One step left or right, for the keyboard. Stays put at either end. */
export function nudgeTab(keys: TabKey[], key: TabKey, step: -1 | 1): TabKey[] {
  const i = keys.indexOf(key);
  const j = i + step;
  if (i < 0 || j < 0 || j >= keys.length) return keys;
  return moveTab(keys, key, keys[j]);
}

/**
 * Write one project's new arrangement into the shared list: its keys come out
 * wherever they were and go back in, in the new order. Other projects' keys are
 * not touched, and the relative order between projects means nothing.
 */
export function storeOrder(order: TabKey[], arranged: TabKey[]): TabKey[] {
  const mine = new Set(arranged);
  return [...order.filter((k) => !mine.has(k)), ...arranged];
}
