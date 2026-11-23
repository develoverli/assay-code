import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { CircleSlash, EyeOff, MoreHorizontal, RotateCcw, ShieldCheck } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import type { Finding, FindingStatus } from "@/types";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button, Input } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The answer to a finding. Ignoring or accepting one asks for a reason, and the
 * decision is keyed by fingerprint, so it survives the next scan.
 */

const CHOICES: { status: FindingStatus; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { status: "ignored", label: "Ignore", icon: EyeOff },
  { status: "false-positive", label: "False positive", icon: CircleSlash },
  { status: "accepted", label: "Accept the risk", icon: ShieldCheck },
];

const STATUS_TONE: Record<FindingStatus, string> = {
  open: "text-text-3",
  ignored: "text-text-3",
  "false-positive": "text-low",
  accepted: "text-warn",
};

export function StatusTag({ finding }: { finding: Finding }) {
  const t = useT();
  if (finding.status === "open") return null;
  return (
    <span
      className={cn("text-[10px] uppercase tracking-wide", STATUS_TONE[finding.status])}
      title={finding.status_reason ?? undefined}
    >
      {t(finding.status)}
    </span>
  );
}

export function TriageControl({ finding, projectId }: { finding: Finding; projectId: string }) {
  const t = useT();
  const setFindingStatus = useApp((s) => s.setFindingStatus);
  const [asking, setAsking] = React.useState<FindingStatus | null>(null);
  const [reason, setReason] = React.useState("");

  const fingerprint = finding.fingerprint;

  const apply = (status: FindingStatus, why: string | null) => {
    if (!fingerprint) return;
    void setFindingStatus(projectId, fingerprint, status, why);
  };

  return (
    <>
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            aria-label={t("Triage this finding")}
            title={t("Triage this finding")}
            disabled={!fingerprint}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded transition-colors",
              "focus-visible:outline-2 focus-visible:outline-accent",
              fingerprint
                ? "cursor-pointer text-text-3 hover:bg-surface-2 hover:text-text"
                : "cursor-not-allowed text-text-3 opacity-40",
            )}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-[190px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
          >
            {finding.status !== "open" && (
              <Dropdown.Item
                onSelect={() => apply("open", null)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
              >
                <RotateCcw className="h-3.5 w-3.5" /> {t("Reopen")}
              </Dropdown.Item>
            )}
            {CHOICES.filter((c) => c.status !== finding.status).map((c) => (
              <Dropdown.Item
                key={c.status}
                onSelect={() => {
                  setReason("");
                  setAsking(c.status);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
              >
                <c.icon className="h-3.5 w-3.5" /> {t(c.label)}
              </Dropdown.Item>
            ))}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>

      <Dialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <DialogContent
          title={t("Why?")}
          desc={t("It applies to this finding in every scan, past and future, until you reopen it.")}
        >
          <p className="mb-3 rounded-md border border-border bg-surface-2 px-2.5 py-2 text-[12px] text-text-2 selectable">
            {finding.message}
          </p>
          <Input
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !reason.trim() || !asking) return;
              apply(asking, reason.trim());
              setAsking(null);
            }}
            placeholder={t("e.g. test fixture, not shipped")}
            aria-label={t("Reason")}
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!reason.trim()}
              onClick={() => {
                if (!asking) return;
                apply(asking, reason.trim());
                setAsking(null);
              }}
            >
              {t("Save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The same decision applied to everything selected. */
export function BulkTriageBar({
  projectId,
  findings,
  onClear,
}: {
  projectId: string;
  findings: Finding[];
  onClear: () => void;
}) {
  const t = useT();
  const setFindingStatus = useApp((s) => s.setFindingStatus);
  const [asking, setAsking] = React.useState<FindingStatus | null>(null);
  const [reason, setReason] = React.useState("");

  const apply = (status: FindingStatus, why: string) => {
    const seen = new Set<string>();
    for (const f of findings) {
      if (!f.fingerprint || seen.has(f.fingerprint)) continue;
      seen.add(f.fingerprint);
      void setFindingStatus(projectId, f.fingerprint, status, why);
    }
    onClear();
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-[12px]">
      <span className="tnum text-accent">{t("{n} selected", { n: findings.length })}</span>
      <div className="ml-auto flex items-center gap-1.5">
        {CHOICES.map((c) => (
          <Button
            key={c.status}
            variant="secondary"
            size="sm"
            onClick={() => {
              setReason("");
              setAsking(c.status);
            }}
          >
            <c.icon className="h-3.5 w-3.5" /> {t(c.label)}
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t("Clear selection")}
        </Button>
      </div>

      <Dialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <DialogContent
          title={t("Why?")}
          desc={t("The same reason is recorded for all {n} of them.", { n: findings.length })}
        >
          <Input
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("e.g. test fixture, not shipped")}
            aria-label={t("Reason")}
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!reason.trim()}
              onClick={() => {
                if (!asking) return;
                apply(asking, reason.trim());
                setAsking(null);
              }}
            >
              {t("Save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
