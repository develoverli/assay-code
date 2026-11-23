import * as db from "@/lib/db";

/**
 * How many findings one Fix run may carry. The cap is the user's choice, never a
 * silent one; small batches keep a fix run's unstaged changes reviewable.
 */
export const FIX_LIMITS = [10, 25, 50, 100, 0] as const;

export const DEFAULT_FIX_LIMIT = 25;

const KEY = "fix.limit";

export async function getFixLimit(): Promise<number> {
  const raw = await db.getSetting(KEY);
  const n = Number(raw);
  return FIX_LIMITS.includes(n as (typeof FIX_LIMITS)[number]) ? n : DEFAULT_FIX_LIMIT;
}

export async function setFixLimit(n: number): Promise<void> {
  await db.setSetting(KEY, String(n));
}

/** `0` means "everything I picked", so it is the one value that never trims. */
export function applyFixLimit<T>(items: T[], limit: number): T[] {
  return limit > 0 ? items.slice(0, limit) : items;
}
