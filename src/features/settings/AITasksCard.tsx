import { Plus, RefreshCw, X } from "lucide-react";
import * as React from "react";
import {
  aiChoiceValue,
  AI_TASKS,
  getTaskChoice,
  setHermesModels,
  setTaskChoice,
  type AIInventory,
  type AITask,
} from "@/lib/ai";
import { Button, Card, Field, Input } from "@/components/ui/primitives";
import { AIPicker } from "@/features/shared/AIPicker";
import { useT } from "@/lib/i18n";

const TASK_TEXT: { task: AITask; label: string; hint: string }[] = [
  {
    task: "fix",
    label: "Fix with AI",
    hint: "Edits the files a finding points at. Only a CLI agent can; a local model takes part through opencode.",
  },
  {
    task: "skills",
    label: "Skills and commands",
    hint: "Run headless on the project, reading and editing files — a CLI agent too.",
  },
  {
    task: "commit",
    label: "Commit message",
    hint: "One prompt in, one line out, in Workspace › Git. Any model does it; a local one is free and never leaves the machine.",
  },
  {
    task: "improve",
    label: "Improve with AI",
    hint: "Rewrites a skill's instructions. One prompt in, one answer out.",
  },
];

/** The defaults each place starts on. Every place still lets you pick another one for that use. */
export function AITasksCard({
  inventory,
  loading,
  onRefresh,
}: {
  inventory: AIInventory | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const [values, setValues] = React.useState<Partial<Record<AITask, string>>>({});
  const [draft, setDraft] = React.useState("");

  React.useEffect(() => {
    let ignore = false;
    void Promise.all(AI_TASKS.map(async (task) => [task, aiChoiceValue(await getTaskChoice(task))] as const)).then(
      (pairs) => {
        if (!ignore) setValues(Object.fromEntries(pairs));
      },
    );
    return () => {
      ignore = true;
    };
  }, []);

  const choose = (task: AITask, value: string) => {
    setValues((cur) => ({ ...cur, [task]: value }));
    void setTaskChoice(task, value);
  };

  const valueOf = (task: AITask): string => {
    for (const [k, v] of Object.entries(values)) if (k === task) return v ?? "";
    return "";
  };

  const hermesModels = inventory?.hermesModels ?? [];
  const saveHermes = (next: string[]) => {
    void setHermesModels(next).then(onRefresh);
  };

  return (
    <Card className="mb-4 flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold">{t("AI per task")}</h2>
          <p className="text-[11px] text-text-3">
            {t("The default each place starts on. Findings, Workspace, Skills and Commands still let you pick another AI for that one use.")}
          </p>
        </div>
        <Button variant="ghost" size="sm" loading={loading} onClick={() => void onRefresh()}>
          <RefreshCw className="h-3.5 w-3.5" /> {t("Re-detect")}
        </Button>
      </div>

      {TASK_TEXT.map(({ task, label, hint }) => (
        <Field key={task} label={t(label)} hint={t(hint)}>
          <AIPicker
            task={task}
            value={valueOf(task)}
            onChange={(v) => choose(task, v)}
            inventory={inventory}
            aria-label={t(label)}
          />
        </Field>
      ))}

      {inventory?.agents.hermes.command && (
        <Field
          label={t("Hermes models")}
          hint={t(
            "Hermes cannot list its models, so the ones you add here are offered next to its default. Each is passed as --model.",
          )}
        >
          <div className="flex flex-col gap-2">
            {hermesModels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {hermesModels.map((m) => (
                  <span
                    key={m}
                    className="flex items-center gap-1 rounded-md border border-border bg-surface-2 py-0.5 pl-2 pr-1 font-mono text-[11px] text-text-2"
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => saveHermes(hermesModels.filter((x) => x !== m))}
                      aria-label={t("Remove {model}", { model: m })}
                      title={t("Remove {model}", { model: m })}
                      className="cursor-pointer rounded p-0.5 text-text-3 transition-colors hover:bg-surface-3 hover:text-danger focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!draft.trim()) return;
                saveHermes([...hermesModels, draft]);
                setDraft("");
              }}
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="anthropic/claude-sonnet-4"
                aria-label={t("Hermes model")}
                className="font-mono text-xs"
              />
              <Button type="submit" variant="secondary" size="sm" disabled={!draft.trim()}>
                <Plus className="h-3.5 w-3.5" /> {t("Add")}
              </Button>
            </form>
          </div>
        </Field>
      )}
    </Card>
  );
}
