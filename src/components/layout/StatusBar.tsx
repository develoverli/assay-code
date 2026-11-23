import { invoke } from "@tauri-apps/api/core";
import { MemoryStick } from "lucide-react";
import * as React from "react";
import { useT } from "@/lib/i18n";
import { useClaudeUsage } from "@/store/claude-usage";
import { ClaudeUsage } from "./ClaudeUsage";

/**
 * Bottom line: Claude's plan limits on the left, Assay's memory on the right.
 * Not mounted on Workspace, whose footer carries both. Memory covers the Rust
 * process plus every webview child — the renderer is most of it.
 */

interface MemoryUsage {
  bytes: number;
  processes: number;
}

const REFRESH_MS = 5000;

function format(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Memory in use, re-read every few seconds while mounted. Null when it cannot be read. */
export function useMemoryUsage(): MemoryUsage | null {
  const [usage, setUsage] = React.useState<MemoryUsage | null>(null);
  React.useEffect(() => {
    let alive = true;
    const read = () => {
      invoke<MemoryUsage>("memory_usage")
        .then((u) => {
          if (alive) setUsage(u);
        })
        .catch(() => {
          // no reading is better than a wrong one: the spot just stays empty
          if (alive) setUsage(null);
        });
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return usage;
}

export function MemoryReading({ usage }: { usage: MemoryUsage }) {
  const t = useT();
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <MemoryStick className="h-3 w-3" aria-hidden />
      <span className="tnum" title={t("Memory used by Assay across {n} processes", { n: usage.processes })}>
        {format(usage.bytes)}
      </span>
    </span>
  );
}

export function StatusBar() {
  const usage = useMemoryUsage();
  // the bar exists when either side has something to say
  const claude = useClaudeUsage((s) => s.limits !== null || Object.keys(s.context).length > 0);
  if (!usage && !claude) return null;

  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-surface px-3 text-[10px] text-text-3">
      <ClaudeUsage />
      {usage && (
        <span className="ml-auto">
          <MemoryReading usage={usage} />
        </span>
      )}
    </div>
  );
}
