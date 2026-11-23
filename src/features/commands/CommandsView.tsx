import { Download, GitCommitHorizontal, Pencil, Play, Plus, Terminal, Trash2 } from "lucide-react";
import * as React from "react";
import { useApp, blockedReason } from "@/store/app";
import { parseAIChoice } from "@/lib/ai";
import type { Tool } from "@/types";
import { AIPicker, useAIInventory, useTaskChoice } from "@/features/shared/AIPicker";
import { Button, Card, EmptyState, Field, SwitchField, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { ViewHeader } from "@/components/layout/ViewHeader";
import { SkillDialog } from "@/features/skills/SkillDialog";
import { ImportDialog } from "@/features/shared/ImportDialog";
import { useT } from "@/lib/i18n";

function RunDialog({
  open,
  onOpenChange,
  command,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  command: Tool;
}) {
  const runCommand = useApp((s) => s.runCommand);
  const t = useT();
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const [message, setMessage] = React.useState("");
  const [push, setPush] = React.useState(false);
  const { inventory } = useAIInventory();
  // Settings' default for skills and commands; a pick here is for this run only
  const [aiValue, setAiValue] = useTaskChoice("skills");
  const choice = parseAIChoice(aiValue);

  const run = () => {
    if (!project || choice?.kind !== "agent") return;
    void runCommand(
      project.id,
      command.id,
      { message: message.trim() || undefined, push },
      choice.provider,
      choice.model || undefined,
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("Run: {name}", { name: command.name })}
        desc={project ? t("on {project}", { project: project.name }) : undefined}
      >
        <div className="flex flex-col gap-4">
          <Field
            label={t("Message / intent")}
            hint={t("Optional. Guides the commit message; the agent infers the rest from the diff.")}
          >
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder={t("e.g. fix ad slot XSS refactor")}
            />
          </Field>
          <Field label={t("AI")} hint={t("Runs as a CLI agent that edits files. The default lives in Settings › AI.")}>
            <AIPicker
              task="skills"
              value={aiValue}
              onChange={setAiValue}
              inventory={inventory}
              aria-label={t("AI for this run")}
            />
          </Field>
          <SwitchField
            label={t("Push after commit")}
            hint={t("Pushes to the current branch's remote.")}
            checked={push}
            onCheckedChange={setPush}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!project?.path || choice?.kind !== "agent"}
            onClick={run}
            title={choice?.kind === "agent" ? undefined : t("Pick an AI agent to run it with")}
          >
            <Play className="h-4 w-4" /> {push ? t("Run + push") : t("Run")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CommandCard({ command }: { command: Tool }) {
  const deleteTool = useApp((s) => s.deleteTool);
  const t = useT();
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId));
  // a string or null: the log stream rewrites `runs` many times a second, this rarely changes
  const blocked = useApp((s) => blockedReason(s.runs, s.maxConcurrent, project?.id));
  const [run, setRun] = React.useState(false);
  /** Bumped on every open so the dialog remounts with an empty draft. */
  const [runSeq, setRunSeq] = React.useState(0);
  const [edit, setEdit] = React.useState(false);
  const [del, setDel] = React.useState(false);
  const Icon = command.id === "ship" ? GitCommitHorizontal : Terminal;

  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-accent" />
        <span className="truncate text-[13px] font-semibold">{command.name}</span>
      </div>
      {command.notes && <p className="text-[11px] text-text-2">{command.notes}</p>}
      {command.prompt && (
        <p className="line-clamp-3 rounded-md border border-border-soft bg-surface-2 p-2 font-mono text-[10px] text-text-3 selectable">
          {command.prompt}
        </p>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        <Button
          variant="subtle"
          size="sm"
          className="flex-1"
          disabled={!project?.path || !!blocked}
          onClick={() => {
            setRunSeq((n) => n + 1);
            setRun(true);
          }}
          title={!project?.path ? t("Active project needs a local folder") : (blocked ?? undefined)}
        >
          <Play className="h-3.5 w-3.5" /> {t("Run on {project}", { project: project?.name ?? t("project") })}
        </Button>
        <Button variant="ghost" size="icon" aria-label={t("Edit")} onClick={() => setEdit(true)}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t("Delete")} onClick={() => setDel(true)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <RunDialog key={runSeq} open={run} onOpenChange={setRun} command={command} />
      <SkillDialog open={edit} onOpenChange={setEdit} skill={command} source="command" />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        danger
        title={t("Delete command?")}
        confirmLabel={t("Delete")}
        body={
          <>
            {t(
              "Delete {name} from Assay? Nothing on disk is touched: a command imported from a .md file keeps that file, and you can import it again.",
              { name: command.name },
            )}
            {command.builtin && ` ${t("Built-in commands come back from Settings → Built-in tools.")}`}
          </>
        }
        onConfirm={() => void deleteTool(command.id)}
      />
    </Card>
  );
}

export function CommandsView() {
  const tools = useApp((s) => s.tools);
  const t = useT();
  const commands = tools.filter((t) => t.source === "command");
  const [add, setAdd] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  /** Bumped on every open so the import dialog remounts with nothing selected. */
  const [importSeq, setImportSeq] = React.useState(0);

  return (
    <div className="mx-auto max-w-5xl p-5">
      <ViewHeader
        title={t("Commands")}
        subtitle={t(
          "Reusable project actions run by an AI agent. The result is the run log, kept in Audit — commands don't create findings.",
        )}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setImportSeq((n) => n + 1);
                setImporting(true);
              }}
            >
              <Download className="h-4 w-4" /> {t("Import")}
            </Button>
            <Button variant="primary" onClick={() => setAdd(true)}>
              <Plus className="h-4 w-4" /> {t("New command")}
            </Button>
          </div>
        }
      />
      {commands.length === 0 ? (
        <EmptyState
          icon={Terminal}
          title={t("No commands")}
          desc={t("Create a command the AI runs on your project.")}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {commands.map((c) => (
            <CommandCard key={c.id} command={c} />
          ))}
        </div>
      )}
      <SkillDialog open={add} onOpenChange={setAdd} source="command" />
      <ImportDialog key={importSeq} kind="command" open={importing} onOpenChange={setImporting} />
    </div>
  );
}
