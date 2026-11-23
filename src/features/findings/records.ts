/**
 * Own-key reads of the severity records Findings passes around. They are read
 * with values that come from the data, so they never index with a variable.
 */

/** Own-key read of a severity -> flag record. */
export function flagOn(flags: Record<string, boolean>, key: string): boolean {
  for (const [k, v] of Object.entries(flags)) if (k === key) return v;
  return false;
}

/** Own-key read of a severity -> count record. */
export function countOf(counts: Record<string, number>, key: string): number {
  for (const [k, v] of Object.entries(counts)) if (k === key) return v;
  return 0;
}
