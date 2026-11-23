import * as React from "react";
import type { LiveRun } from "@/store/app";
import type { RunStatus } from "@/types";

export const asStatus = (s: LiveRun["status"]): RunStatus => {
  if (s === "running") return "running";
  if (s === "cancelled") return "cancelled";
  return s === "error" ? "error" : "success";
};

/** Ticks every second while a run is active so the elapsed time updates live. */
export function useElapsed(run?: Pick<LiveRun, "status" | "startedAt" | "finishedAt">): number {
  const running = run?.status === "running";
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (!run) return 0;
  return (run.finishedAt ?? Date.now()) - run.startedAt;
}
