import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import * as React from "react";
import {
  aiChoiceLabel,
  aiChoiceValue,
  aiOptions,
  getTaskChoice,
  loadAIInventory,
  parseAIChoice,
  type AIInventory,
  type AITask,
} from "@/lib/ai";
import type { AIProvider } from "@/types";
import { Select, type SelectOption } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The heading each agent's models sit under, as `aiOptions` names them. */
const PROVIDER_GROUP: Record<AIProvider, string> = { claude: "Claude", opencode: "OpenCode", hermes: "Hermes" };

/** Everything that can answer a prompt; discovery runs once per session in `lib/ai`. */
export function useAIInventory(): { inventory: AIInventory | null; loading: boolean; refresh: () => Promise<void> } {
  const [inventory, setInventory] = React.useState<AIInventory | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let ignore = false;
    void loadAIInventory()
      .then((inv) => {
        if (!ignore) setInventory(inv);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      setInventory(await loadAIInventory(true));
    } finally {
      setLoading(false);
    }
  }, []);

  return { inventory, loading, refresh };
}

/** A task's Settings default as the starting value; changing it overrides this screen only. */
export function useTaskChoice(task: AITask): [string, (value: string) => void] {
  const [value, setValue] = React.useState("");
  React.useEffect(() => {
    let ignore = false;
    void getTaskChoice(task).then((c) => {
      if (!ignore) setValue((cur) => cur || aiChoiceValue(c));
    });
    return () => {
      ignore = true;
    };
  }, [task]);
  return [value, setValue];
}

/**
 * The options for a task, plus the current value when discovery did not list it,
 * so a removed model stays visible and says so instead of silently changing.
 */
function usePickerOptions(inventory: AIInventory | null, task: AITask, value: string): SelectOption[] {
  const t = useT();
  return React.useMemo(() => {
    const options: SelectOption[] = inventory ? aiOptions(inventory, task) : [];
    const choice = parseAIChoice(value);
    if (choice && !options.some((o) => o.value === value)) {
      options.unshift({
        value,
        label: aiChoiceLabel(choice),
        hint: inventory ? t("not found on this machine") : t("detecting…"),
        group: choice.kind === "local" ? t("Local models") : PROVIDER_GROUP[choice.provider],
      });
    }
    return options;
  }, [inventory, task, value, t]);
}

export function AIPicker({
  task,
  value,
  onChange,
  inventory,
  size,
  className,
  "aria-label": ariaLabel,
  title,
}: {
  task: AITask;
  value: string;
  onChange: (value: string) => void;
  inventory: AIInventory | null;
  size?: "sm" | "md";
  className?: string;
  "aria-label": string;
  title?: string;
}) {
  const t = useT();
  const options = usePickerOptions(inventory, task, value);
  return (
    <Select
      value={value}
      onChange={onChange}
      options={
        options.length
          ? options
          : [
              {
                value,
                label: inventory
                  ? t("Nothing available. Install or start one in Settings › Tools › Toolchain")
                  : t("detecting…"),
                disabled: true,
              },
            ]
      }
      size={size}
      className={cn("font-mono", className)}
      aria-label={ariaLabel}
      title={title}
    />
  );
}

/** The same options as items inside a caller's dropdown; `value` gets the tick. */
export function AIMenuItems({
  task,
  inventory,
  value,
  onPick,
}: {
  task: AITask;
  inventory: AIInventory | null;
  value: string;
  onPick: (value: string) => void;
}) {
  const t = useT();
  const options = usePickerOptions(inventory, task, value);
  if (!options.length) {
    return (
      <p className="px-2.5 py-1.5 text-[12px] text-text-3">
        {inventory ? t("Nothing available. Install or start one in Settings › Tools › Toolchain") : t("detecting…")}
      </p>
    );
  }
  return (
    <>
      {options.map((o, i) => {
        const heading = o.group && o.group !== options[i - 1]?.group ? o.group : null;
        return (
          <React.Fragment key={o.value}>
            {heading && (
              <Dropdown.Label className="px-2.5 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-text-3 first:pt-1">
                {heading}
              </Dropdown.Label>
            )}
            <Dropdown.Item
              disabled={o.disabled}
              onSelect={() => onPick(o.value)}
              className={cn(
                "flex items-start gap-2 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors",
                o.disabled
                  ? "cursor-not-allowed text-text-3 opacity-60"
                  : "cursor-pointer text-text-2 data-[highlighted]:bg-surface-2 data-[highlighted]:text-text",
              )}
            >
              <Check aria-hidden className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", o.value !== value && "invisible")} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-[12px]">{o.label}</span>
                {o.hint && <span className="truncate text-[10px] text-text-3">{o.hint}</span>}
              </span>
            </Dropdown.Item>
          </React.Fragment>
        );
      })}
    </>
  );
}
