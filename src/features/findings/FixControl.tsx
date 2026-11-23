import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, SlidersHorizontal, Wand2 } from "lucide-react";
import { parseAIChoice, type AIChoice } from "@/lib/ai";
import type { Severity } from "@/types";
import { FIX_LIMITS } from "@/lib/fix-limit";
import { SEVERITIES } from "@/types";
import { Button } from "@/components/ui/primitives";
import { AIPicker, useAIInventory, useTaskChoice } from "@/features/shared/AIPicker";
import { SeverityPill } from "@/components/ui/severity";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { countOf, flagOn } from "./records";

/**
 * Engine picker plus the Fix button and the severities it is allowed to touch.
 * The engine only matters at the moment Fix is pressed, so it is handed back to
 * the caller instead of being lifted into the view.
 */
export function FixControl({
  label,
  disabled,
  busy,
  blocked,
  filter,
  counts,
  fixSeverities,
  onToggleSeverity,
  limit,
  onLimit,
  onFix,
}: {
  label: string;
  disabled: boolean;
  busy: boolean;
  blocked: string | null;
  filter: Severity | "all";
  counts: Record<string, number>;
  fixSeverities: Record<Severity, boolean>;
  onToggleSeverity: (sv: Severity) => void;
  limit: number;
  onLimit: (n: number) => void;
  onFix: (choice: AIChoice) => void;
}) {
  const t = useT();
  const { inventory } = useAIInventory();
  // starts on Settings' default for Fix; a pick here is for this screen only
  const [value, setValue] = useTaskChoice("fix");
  const choice = parseAIChoice(value);

  return (
    <>
      <AIPicker
        task="fix"
        value={value}
        onChange={setValue}
        inventory={inventory}
        className="max-w-[240px]"
        aria-label={t("AI engine")}
        title={t("Engine used by Fix with AI")}
      />
      <div className="flex items-center">
        <Button
          variant="primary"
          className="rounded-r-none"
          disabled={disabled || choice?.kind !== "agent"}
          onClick={() => choice && onFix(choice)}
          // a disabled Fix says why: busy, blocked, or no agent picked yet
          title={
            blocked ??
            (choice?.kind === "agent" ? t("Fix the findings currently in scope") : t("Pick an AI agent to fix with"))
          }
        >
          <Wand2 className="h-4 w-4" /> {label}
        </Button>
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <Button
              variant="primary"
              size="icon"
              className="w-7 rounded-l-none border-l border-accent-fg/20"
              aria-label={t("Choose which severities Fix touches")}
              title={t("Choose which severities Fix touches")}
              disabled={busy}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </Button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content
              align="end"
              sideOffset={6}
              className="z-50 w-[240px] rounded-lg border border-border bg-surface p-1.5 shadow-2xl animate-in"
            >
              <p className="px-1.5 pb-1 pt-0.5 text-[10px] text-text-3">
                {filter === "all"
                  ? t("Severities Fix will send to the agent")
                  : t("Ignored while the {severity} tab is active", { severity: t(filter) })}
              </p>
              {SEVERITIES.map((sv) => (
                <Dropdown.CheckboxItem
                  key={sv}
                  checked={flagOn(fixSeverities, sv)}
                  onCheckedChange={() => onToggleSeverity(sv)}
                  onSelect={(e) => e.preventDefault()}
                  disabled={filter !== "all"}
                  className={cn(
                    "flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors",
                    "data-[highlighted]:bg-surface-2",
                    flagOn(fixSeverities, sv) ? "text-text" : "text-text-3",
                    filter !== "all" && "cursor-not-allowed opacity-50",
                  )}
                >
                  <span className="flex items-center gap-2">
                    {/* Radix renders no tick of its own — draw the box */}
                    <span
                      aria-hidden
                      className={cn(
                        "flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border transition-colors",
                        flagOn(fixSeverities, sv) ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2",
                      )}
                    >
                      {flagOn(fixSeverities, sv) && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    </span>
                    <SeverityPill severity={sv} />
                  </span>
                  <span className="tnum text-[11px] text-text-3">{countOf(counts, sv)}</span>
                </Dropdown.CheckboxItem>
              ))}

              {/* a capped batch keeps an agent's edits reviewable; the button says the number it sends */}
              <Dropdown.Separator className="my-1 h-px bg-border" />
              <p className="px-1.5 pb-1 pt-0.5 text-[10px] text-text-3">{t("At most, per run")}</p>
              <Dropdown.RadioGroup value={String(limit)} onValueChange={(v) => onLimit(Number(v))}>
                {FIX_LIMITS.map((n) => (
                  <Dropdown.RadioItem
                    key={n}
                    value={String(n)}
                    onSelect={(e) => e.preventDefault()}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors",
                      "data-[highlighted]:bg-surface-2",
                      limit === n ? "text-text" : "text-text-3",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex h-3.5 w-3.5 items-center justify-center rounded-full border transition-colors",
                        limit === n ? "border-accent bg-accent" : "border-border bg-surface-2",
                      )}
                    />
                    <span className="tnum">{n === 0 ? t("no limit") : n}</span>
                  </Dropdown.RadioItem>
                ))}
              </Dropdown.RadioGroup>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
    </>
  );
}
