import { create } from "zustand";
import * as db from "@/lib/db";
import type { AgentStatus, LimitWindow } from "@/lib/agent-signals";

/**
 * Claude's plan limits and context, as the Claude sessions running in
 * Workspace last reported them through their status line.
 *
 * The limits belong to the account, so the newest reading from any terminal is
 * the answer, and it is kept in the DB: after a restart the bar still says what
 * it last knew, and how long ago. Context belongs to one session, so it is kept
 * per terminal and only for as long as the app runs.
 */

export interface LimitsSnapshot {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  /** Epoch millis of the reading. */
  at: number;
}

export interface ContextReading {
  usedPercentage: number;
  usedTokens: number | null;
  size: number | null;
  at: number;
}

const LIMITS_SETTING = "claude.limits";

interface ClaudeUsageState {
  limits: LimitsSnapshot | null;
  context: Record<string, ContextReading>;
  /** Read the last snapshot back from the DB. */
  load: () => Promise<void>;
  apply: (s: AgentStatus) => void;
}

export const useClaudeUsage = create<ClaudeUsageState>((set, get) => ({
  limits: null,
  context: {},
  load: async () => {
    try {
      const raw = await db.getSetting(LIMITS_SETTING);
      if (raw && !get().limits) set({ limits: JSON.parse(raw) as LimitsSnapshot });
    } catch {
      /* a corrupt snapshot is simply no snapshot */
    }
  },
  apply: (s) => {
    const at = Date.now();
    const patch: Partial<ClaudeUsageState> = {};
    // a reading without limits (API key, or before the first answer) says
    // nothing about them, so it never wipes what another session reported
    if (s.fiveHour || s.sevenDay) {
      const prev = get().limits;
      const limits: LimitsSnapshot = {
        fiveHour: s.fiveHour ?? prev?.fiveHour ?? null,
        sevenDay: s.sevenDay ?? prev?.sevenDay ?? null,
        at,
      };
      patch.limits = limits;
      void db.setSetting(LIMITS_SETTING, JSON.stringify(limits)).catch(() => {});
    }
    if (s.context) {
      patch.context = {
        ...get().context,
        [s.id]: {
          usedPercentage: s.context.usedPercentage,
          usedTokens: s.context.usedTokens,
          size: s.context.size,
          at,
        },
      };
    }
    set(patch);
  },
}));
