import type * as React from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { RunStatus, Severity } from "@/types";

interface Meta {
  label: string;
  dot: string;
  text: string;
}

const SEV_META: Record<Severity, Meta> = {
  critical: { label: "Critical", dot: "bg-crit", text: "text-crit" },
  high: { label: "High", dot: "bg-high", text: "text-high" },
  medium: { label: "Medium", dot: "bg-med", text: "text-med" },
  low: { label: "Low", dot: "bg-low", text: "text-low" },
  info: { label: "Info", dot: "bg-info", text: "text-info" },
};

// Looked up through a Map: an own-key read, never an index into an object that
// also carries a prototype.
const SEV_BY_KEY = new Map<string, Meta>(Object.entries(SEV_META));

function sevMeta(severity: Severity): Meta {
  return SEV_BY_KEY.get(severity) ?? SEV_META.info;
}

/** Severity as dot + text (never color alone — a11y). */
export function SeverityPill({ severity, className }: { severity: Severity; className?: string }) {
  const t = useT();
  const m = sevMeta(severity);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", m.text, className)}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", m.dot)} aria-hidden />
      {t(m.label)}
    </span>
  );
}

export function SeverityDot({ severity }: { severity: Severity }) {
  const t = useT();
  const m = sevMeta(severity);
  return <span className={cn("inline-block h-2 w-2 rounded-full", m.dot)} aria-label={t(m.label)} />;
}

interface StatusMeta extends Meta {
  pulse?: boolean;
}

const STATUS_META: Record<RunStatus, StatusMeta> = {
  running: { label: "Running", dot: "bg-low", text: "text-low", pulse: true },
  success: { label: "Success", dot: "bg-success", text: "text-success" },
  error: { label: "Error", dot: "bg-danger", text: "text-danger" },
  cancelled: { label: "Cancelled", dot: "bg-text-3", text: "text-text-3" },
};

const STATUS_BY_KEY = new Map<string, StatusMeta>(Object.entries(STATUS_META));

const PULSE_STYLE: React.CSSProperties = { animation: "assay-pulse 1.4s ease-in-out infinite" };

function statusMeta(status: RunStatus): StatusMeta {
  return STATUS_BY_KEY.get(status) ?? STATUS_META.error;
}

/** Status as a bare dot — for dense rows where the label doesn't fit. */
export function StatusDot({ status }: { status: RunStatus }) {
  const t = useT();
  const m = statusMeta(status);
  return (
    <span
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", m.dot)}
      style={m.pulse ? PULSE_STYLE : undefined}
      aria-label={t(m.label)}
    />
  );
}

export function StatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const t = useT();
  const m = statusMeta(status);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", m.text, className)}>
      <span
        className={cn("h-2 w-2 rounded-full", m.dot)}
        style={m.pulse ? PULSE_STYLE : undefined}
        aria-hidden
      />
      {t(m.label)}
    </span>
  );
}
