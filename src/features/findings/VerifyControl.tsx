import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, Hammer, SlidersHorizontal } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import * as db from "@/lib/db";
import { defaultSelection, detectChecks, type Check as VerifyCheck } from "@/lib/verify";
import type { Project } from "@/types";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const AUTO_SETTING = "verify.auto";

/**
 * Verify runs the project's own build/test commands. Which ones it runs is
 * detected from the repo and remembered per project, so the picker lives here
 * with the button it belongs to.
 */
export function VerifyControl({
  project,
  blocked,
  busy,
  dataVersion,
}: {
  project: Project;
  blocked: string | null;
  busy: boolean;
  dataVersion: number;
}) {
  const verify = useApp((s) => s.verify);
  const t = useT();
  const [checks, setChecks] = React.useState<VerifyCheck[]>([]);
  const [checkSel, setCheckSel] = React.useState<string[]>([]);
  const [autoVerify, setAutoVerify] = React.useState(false);

  const projectId = project.id;
  const projectPath = project.path ?? "";
  const checksSetting = `verify.checks.${projectId}`;

  // the checks come from what the repo declares, so they follow the project
  React.useEffect(() => {
    let ignore = false;
    void (async () => {
      const found = await detectChecks(projectPath);
      if (ignore) return;
      setChecks(found);
      const saved = await db.getSetting(checksSetting);
      if (ignore) return;
      setCheckSel(saved === null ? defaultSelection(found) : saved.split(",").filter(Boolean));
    })();
    return () => {
      ignore = true;
    };
  }, [checksSetting, projectPath, dataVersion]);

  React.useEffect(() => {
    let ignore = false;
    void db.getSetting(AUTO_SETTING).then((v) => {
      if (!ignore) setAutoVerify(v === "1");
    });
    return () => {
      ignore = true;
    };
  }, []);

  const selected = React.useMemo(() => new Set(checkSel), [checkSel]);

  const toggleCheck = (id: string) => {
    const next = selected.has(id) ? checkSel.filter((x) => x !== id) : [...checkSel, id];
    setCheckSel(next);
    void db.setSetting(checksSetting, next.join(","));
  };

  const runsLabel = React.useMemo(() => {
    const labels: string[] = [];
    for (const c of checks) if (selected.has(c.id)) labels.push(c.label);
    return labels.join(", ");
  }, [checks, selected]);

  return (
    <div className="flex items-center">
      <Button
        variant="secondary"
        className="rounded-r-none"
        disabled={busy || !project.path}
        onClick={() => void verify(project.id)}
        title={
          blocked ??
          (checks.length
            ? t("Runs: {checks}", { checks: runsLabel || t("nothing selected") })
            : t("No build or test command detected in this project"))
        }
      >
        <Hammer className="h-4 w-4" /> {t("Verify")}
      </Button>
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <Button
            variant="secondary"
            size="icon"
            className="w-7 rounded-l-none border-l-0"
            aria-label={t("Choose which checks Verify runs")}
            title={t("Choose which checks Verify runs")}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </Button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content
            align="end"
            sideOffset={6}
            className="z-50 w-[300px] rounded-lg border border-border bg-surface p-1.5 shadow-2xl animate-in"
          >
            <p className="px-1.5 pb-1 pt-0.5 text-[10px] text-text-3">
              {checks.length
                ? t("Detected from this project, not invented")
                : t("Nothing detected. Add a script to package.json, or a Cargo, Go or Make target.")}
            </p>
            {checks.map((c) => (
              <Dropdown.CheckboxItem
                key={c.id}
                checked={selected.has(c.id)}
                onCheckedChange={() => toggleCheck(c.id)}
                onSelect={(e) => e.preventDefault()}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 outline-none transition-colors",
                  "data-[highlighted]:bg-surface-2",
                  selected.has(c.id) ? "text-text" : "text-text-3",
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border",
                      selected.has(c.id) ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2",
                    )}
                  >
                    {selected.has(c.id) && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                  </span>
                  <span className="font-mono text-[11px]">{c.label}</span>
                </span>
                <span className="truncate text-[10px] text-text-3" title={c.source}>
                  {c.source}
                </span>
              </Dropdown.CheckboxItem>
            ))}
            <div className="mt-1 border-t border-border-soft pt-1">
              <Dropdown.CheckboxItem
                checked={autoVerify}
                onCheckedChange={() => {
                  const v = !autoVerify;
                  setAutoVerify(v);
                  void db.setSetting(AUTO_SETTING, v ? "1" : "0");
                }}
                onSelect={(e) => e.preventDefault()}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-text-2 outline-none data-[highlighted]:bg-surface-2"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border",
                    autoVerify ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2",
                  )}
                >
                  {autoVerify && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                </span>
                {t("Run automatically after every AI fix")}
              </Dropdown.CheckboxItem>
            </div>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
}
