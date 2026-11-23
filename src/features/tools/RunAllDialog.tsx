import { ListChecks } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import type { Project, Tool } from "@/types";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Badge, Button } from "@/components/ui/primitives";
import { canonicalTags, stackApplies } from "@/lib/detect";
import { checkTool, NON_SCAN_TOOL_IDS, type Availability } from "@/lib/runner";
import { useT } from "@/lib/i18n";

/**
 * Which tools "Run all" actually runs. Everything applicable starts ticked;
 * tools that can't run here are listed greyed out with the reason. A tool whose
 * language wasn't detected starts unticked but stays tickable: detection is
 * evidence, not a verdict.
 */

/** Why a tool cannot run here at all. */
function why(
  tool: Tool,
  project: Project,
  t: (k: string) => string,
  available?: Availability,
): string | null {
  if (available && !available.ok) return t("not installed");
  if (!tool.enabled) return t("disabled");
  if (tool.scope === "local" && !project.path) return t("needs a local folder");
  if (tool.scope === "url" && !project.url) return t("needs a URL");
  if (tool.scope === "url" && !project.authorized) return t("URL not authorized");
  return null;
}

/** Why a tool would probably find nothing here, without stopping the user. */
function unlikely(
  tool: Tool,
  project: Project,
  t: (k: string, v?: Record<string, string | number>) => string,
): string | null {
  if (stackApplies(tool.stack, project.stack)) return null;
  return t("no {stack} here", { stack: canonicalTags(tool.stack).join(" / ") });
}

export function RunAllDialog({
  project,
  open,
  onOpenChange,
  onRun,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRun: (toolIds: string[]) => void;
}) {
  const t = useT();
  const tools = useApp((s) => s.tools);
  // graphify is a tool but not a scanner: it reports nothing to triage
  const scanners = React.useMemo(
    () => tools.filter((x) => x.source === "tool" && !NON_SCAN_TOOL_IDS.has(x.id)),
    [tools],
  );
  const [picked, setPicked] = React.useState<string[]>([]);
  const [available, setAvailable] = React.useState<Record<string, Availability>>({});

  // the set of scanners, not the array: `tools` is a new array on every store write
  const scannerIds = scanners.map((x) => x.id).join(",");

  // Opening (or another project) starts from "everything that applies", not
  // from last time; the probe then drops only what turned out not to be
  // installed, so a box the user unticked meanwhile stays unticked. Keyed on
  // the project's id, not the object: reloadProjects/touchProject hand out a
  // new one for the same project, and that must not undo the user's picks.
  React.useEffect(() => {
    if (!open) return;
    let ignore = false;
    setPicked(
      scanners.reduce<string[]>((ids, x) => {
        if (!why(x, project, t) && !unlikely(x, project, t)) ids.push(x.id);
        return ids;
      }, []),
    );
    // probed on open, so a tool installed since last time is offered again
    void Promise.all(scanners.map(async (x) => [x.id, await checkTool(x)] as const)).then((pairs) => {
      if (ignore) return;
      const next: Record<string, Availability> = Object.fromEntries(pairs);
      setAvailable(next);
      const missing = new Set(pairs.filter(([, a]) => !a.ok).map(([id]) => id));
      setPicked((cur) => cur.filter((id) => !missing.has(id)));
    });
    return () => {
      ignore = true;
    };
  }, [open, project.id, scannerIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const pickedIds = new Set(picked);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("Run on {project}", { project: project.name })}
        desc={t("They run one after another; each one replaces its own previous findings.")}
      >
        <div className="flex flex-col gap-1">
          {scanners.map((tool) => {
            const reason = why(tool, project, t, available[tool.id]);
            const note = reason ? null : unlikely(tool, project, t);
            const on = pickedIds.has(tool.id);
            return (
              <label
                key={tool.id}
                className={
                  reason
                    ? "flex cursor-not-allowed items-start gap-2.5 rounded-md px-2 py-1.5 opacity-50"
                    : "flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2"
                }
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!!reason}
                  onChange={() => toggle(tool.id)}
                  className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--color-accent)] disabled:cursor-not-allowed"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] text-text">{tool.name}</span>
                    <Badge>{tool.scope}</Badge>
                    {(reason || note) && (
                      <span
                        className="text-[10px] text-text-3"
                        title={available[tool.id]?.reason ?? undefined}
                      >
                        {reason ?? note}
                      </span>
                    )}
                  </span>
                  {tool.notes && <span className="block text-[11px] text-text-3">{tool.notes}</span>}
                </span>
              </label>
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!picked.length}
            onClick={() => {
              onRun(picked);
              onOpenChange(false);
            }}
          >
            <ListChecks className="h-4 w-4" /> {t("Run {n}", { n: picked.length })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
