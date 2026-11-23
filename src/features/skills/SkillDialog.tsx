import { Wand2 } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import { aiChoiceValue, getTaskChoice, parseAIChoice, runOneShot } from "@/lib/ai";
import type { Tool } from "@/types";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button, Field, Input, Textarea } from "@/components/ui/primitives";
import { AIPicker, useAIInventory } from "@/features/shared/AIPicker";
import { useT } from "@/lib/i18n";

export function SkillDialog({
  open,
  onOpenChange,
  skill,
  source = "skill",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  skill?: Tool | null;
  source?: "skill" | "command";
}) {
  const saveTool = useApp((s) => s.saveTool);
  const setError = useApp((s) => s.setError);
  const t = useT();
  const word = source === "command" ? t("command") : t("skill");
  const [name, setName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  // any engine answers a rewrite — it is a single prompt, no file access
  const { inventory } = useAIInventory();
  const [engineChoice, setEngineChoice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [improving, setImproving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(skill?.name ?? "");
    setNotes(skill?.notes ?? "");
    setPrompt(skill?.prompt ?? "");
    // the dialog opens on Settings' default for Improve, and the picker stays an
    // override for this rewrite only
    void getTaskChoice("improve").then((c) => setEngineChoice(aiChoiceValue(c)));
  }, [open, skill]);

  const improve = async () => {
    if (!prompt.trim() && !notes.trim()) return setError(t("Add a goal or some instructions to improve first."));
    setImproving(true);
    try {
      const meta = [
        "You are improving an agent skill definition for an ethical security/testing tool hub.",
        "Do not ask questions or offer options — produce the result directly.",
        "Rewrite the instructions below to be clearer, more specific and more actionable for a coding agent.",
        "Return ONLY the improved instructions — no preamble, no markdown fences.",
        "",
        `Skill: ${name || "(unnamed)"}`,
        notes ? `Goal: ${notes}` : "",
        "",
        "Current instructions:",
        prompt || "(none yet — draft from the goal)",
      ].filter(Boolean).join("\n");
      const choice = parseAIChoice(engineChoice);
      if (!choice) throw new Error(t("Pick an AI to improve it with."));
      const out = await runOneShot(choice, meta);
      if (out) setPrompt(out);
      else setError(t("The engine returned nothing. Check that it is installed, logged in and reachable."));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImproving(false);
    }
  };

  const save = async () => {
    if (!name.trim()) return setError(t("A name is required."));
    setBusy(true);
    try {
      await saveTool({
        id: skill?.id,
        name: name.trim(),
        source,
        kind: "cli-agent",
        scope: "local",
        adapter: "generic",
        stack: [],
        cmd: "",
        notes: notes.trim() || null,
        prompt: prompt.trim() || null,
      });
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={skill ? t("Edit {kind}", { kind: word }) : t("New {kind}", { kind: word })}
        className="w-[min(680px,94vw)]"
      >
        <div className="flex flex-col gap-4">
          <Field label={t("Name")}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("Harden API routes")}
            />
          </Field>
          <Field label={t("Goal")} hint={t("One line — what it should accomplish.")}>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("Audit and fix missing input validation")}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-2">{t("Instructions (prompt)")}</span>
              <div className="flex items-center gap-2">
                <AIPicker
                  task="improve"
                  size="sm"
                  className="max-w-[240px]"
                  value={engineChoice}
                  onChange={setEngineChoice}
                  inventory={inventory}
                  aria-label={t("Engine for Improve with AI")}
                />
                <Button variant="subtle" size="sm" loading={improving} onClick={improve}>
                  <Wand2 className="h-3.5 w-3.5" /> {t("Improve with AI")}
                </Button>
              </div>
            </div>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={10}
              className="font-mono text-xs"
              placeholder={t("Describe exactly what the agent should do on the project…")}
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {skill ? t("Save {kind}", { kind: word }) : t("Create {kind}", { kind: word })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
