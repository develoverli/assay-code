import { Play, Plus, Star, Trash2 } from "lucide-react";
import * as React from "react";
import { detectScripts, type ProjectScript } from "@/lib/scripts";
import * as db from "@/lib/db";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button, Input } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The project's scripts: a ▶ palette of what the repo declares plus the user's
 * own commands, with starred ones as chips. Each run opens its own terminal tab,
 * so a dev server can be watched and stopped.
 */

interface Entry {
  label: string;
  command: string;
  /** Where it came from, shown small beside it; "custom" for the user's own. */
  source: ProjectScript["source"] | "custom";
  starred: boolean;
  /** The row a hand-written command lives in, so it can be deleted. */
  customId?: string;
}

/** Scripts first as the repo lists them, then the user's own, in the order written. */
function entriesFrom(scripts: ProjectScript[], saved: db.ProjectCommand[]): Entry[] {
  const starred = new Set(saved.filter((c) => c.starred).map((c) => c.command));
  const detected = new Set(scripts.map((s) => s.command));
  return [
    ...scripts.map((s) => ({ label: s.name, command: s.command, source: s.source, starred: starred.has(s.command) })),
    ...saved
      .filter((c) => c.custom && !detected.has(c.command))
      .map((c) => ({ label: c.label, command: c.command, source: "custom" as const, starred: c.starred, customId: c.id })),
  ];
}

function useProjectScripts(projectId: string | null, cwd: string) {
  const [scripts, setScripts] = React.useState<ProjectScript[]>([]);
  const [saved, setSaved] = React.useState<db.ProjectCommand[]>([]);
  // until the repo has answered, an empty list would claim there is nothing
  const [loading, setLoading] = React.useState(true);
  const reload = React.useCallback(() => {
    setLoading(true);
    void detectScripts(cwd)
      .then(setScripts)
      .catch(() => setScripts([]))
      .finally(() => setLoading(false));
    if (projectId)
      void db
        .listProjectCommands(projectId)
        .then(setSaved)
        .catch(() => setSaved([]));
    else setSaved([]);
  }, [projectId, cwd]);
  React.useEffect(reload, [reload]);
  return { entries: React.useMemo(() => entriesFrom(scripts, saved), [scripts, saved]), loading, reload };
}

export function ScriptsBar({
  projectId,
  cwd,
  onRun,
}: {
  projectId: string | null;
  cwd: string;
  onRun: (label: string, command: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const { entries, loading, reload } = useProjectScripts(projectId, cwd);
  const chips = entries.filter((e) => e.starred);

  // Ctrl+Shift+R opens the palette from anywhere in Workspace
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === "R" || e.key === "r")) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // the repo may have gained a script since the last look
  React.useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const run = (e: Entry) => {
    setOpen(false);
    onRun(e.label, e.command);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("Scripts (Ctrl+Shift+R)")}
        aria-label={t("Scripts")}
        className={cn(
          "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full",
          "bg-surface-2 text-text-2 transition-colors hover:bg-accent-soft hover:text-accent",
          "focus-visible:outline-2 focus-visible:outline-accent",
        )}
      >
        <Play className="h-3.5 w-3.5" />
      </button>
      {chips.map((c) => (
        <button
          key={c.command}
          type="button"
          onClick={() => run(c)}
          title={c.command}
          className={cn(
            "flex h-7 max-w-[140px] shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border px-2.5",
            "text-[11px] text-text-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent",
            "focus-visible:outline-2 focus-visible:outline-accent",
          )}
        >
          <Play className="h-3 w-3 shrink-0" />
          <span className="truncate">{c.label}</span>
        </button>
      ))}
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <ScriptsPalette
            projectId={projectId}
            entries={entries}
            loading={loading}
            onRun={run}
            onChanged={reload}
          />
        )}
      </Dialog>
    </>
  );
}

function ScriptsPalette({
  projectId,
  entries,
  loading,
  onRun,
  onChanged,
}: {
  projectId: string | null;
  entries: Entry[];
  loading: boolean;
  onRun: (e: Entry) => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [query, setQuery] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [adding, setAdding] = React.useState(false);
  const listRef = React.useRef<HTMLUListElement>(null);

  const q = query.trim().toLowerCase();
  const shown = q
    ? entries.filter((e) => e.label.toLowerCase().includes(q) || e.command.toLowerCase().includes(q))
    : entries;
  const at = Math.min(cursor, Math.max(shown.length - 1, 0));

  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const star = (e: Entry) => {
    if (!projectId) return;
    void db.setCommandStar(projectId, e.label, e.command, !e.starred).then(onChanged);
  };
  // two clicks in the same place, not a second dialog over this one
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const remove = (e: Entry) => {
    if (!e.customId) return;
    if (confirming !== e.customId) return setConfirming(e.customId);
    setConfirming(null);
    void db.deleteProjectCommand(e.customId).then(onChanged);
  };
  const noProject = t("Open a project first");

  return (
    <DialogContent
      title={t("Scripts")}
      desc={t("What this project declares, and the commands you added. Each one opens its own terminal tab.")}
      className="w-[min(600px,92vw)]"
    >
      <Input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor(Math.min(at + 1, shown.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor(Math.max(at - 1, 0));
          } else if (e.key === "Enter" && shown[at]) {
            e.preventDefault();
            onRun(shown[at]);
          }
        }}
        placeholder={t("Filter: dev, build, test…")}
        aria-label={t("Filter scripts")}
      />

      {/* a plain list of buttons: an ARIA option may not hold the run, star and delete controls */}
      <ul ref={listRef} aria-label={t("Scripts")} className="mt-3 max-h-[50vh] overflow-y-auto">
        {shown.length === 0 ? (
          <li className="px-2 py-6 text-center text-xs text-text-3">
            {entries.length > 0
              ? t("Nothing matches.")
              : loading
                ? t("Reading the project's scripts…")
                : t("No package.json, Cargo.toml, Makefile or composer.json scripts found. Add your own below.")}
          </li>
        ) : (
          shown.map((e, i) => (
            <li
              key={e.command}
              data-index={i}
              onMouseEnter={() => setCursor(i)}
              className={cn(
                "group flex items-center gap-2 rounded-md px-2 py-1.5",
                i === at ? "bg-surface-2" : "hover:bg-surface-2",
              )}
            >
              <button
                type="button"
                onClick={() => onRun(e)}
                // the row Enter would run, said to a screen reader and not only drawn
                aria-current={i === at ? "true" : undefined}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-accent"
              >
                <Play className="h-3.5 w-3.5 shrink-0 text-text-3" />
                <span className="shrink-0 text-[13px] font-medium text-text">{e.label}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-text-3">{e.command}</span>
              </button>
              <span className="shrink-0 text-[10px] text-text-3">
                {e.source === "custom" ? t("yours") : e.source}
              </span>
              {e.customId &&
                (confirming === e.customId ? (
                  <button
                    type="button"
                    onClick={() => remove(e)}
                    onBlur={() => setConfirming(null)}
                    autoFocus
                    className="shrink-0 cursor-pointer rounded bg-danger/15 px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger/25 focus-visible:outline-2 focus-visible:outline-danger"
                  >
                    {t("Delete?")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => remove(e)}
                    title={t("Delete command")}
                    aria-label={t("Delete command")}
                    className="shrink-0 cursor-pointer rounded p-1 text-text-3 opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ))}
              <button
                type="button"
                onClick={() => star(e)}
                disabled={!projectId}
                title={!projectId ? noProject : e.starred ? t("Remove from the bar") : t("Pin to the bar")}
                aria-label={e.starred ? t("Remove from the bar") : t("Pin to the bar")}
                aria-pressed={e.starred}
                className={cn(
                  "shrink-0 cursor-pointer rounded p-1 transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                  e.starred ? "text-accent" : "text-text-3 hover:text-text",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                <Star className={cn("h-3.5 w-3.5", e.starred && "fill-current")} />
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="mt-3 border-t border-border-soft pt-3">
        {adding && projectId ? (
          <AddCommand
            projectId={projectId}
            onDone={(added) => {
              setAdding(false);
              if (added) onChanged();
            }}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={!projectId}
            title={!projectId ? noProject : undefined}
            onClick={() => setAdding(true)}
          >
            <Plus className="h-3.5 w-3.5" /> {t("Add command")}
          </Button>
        )}
      </div>
    </DialogContent>
  );
}

/** Inline, not a second dialog: the list it adds to stays in view. */
function AddCommand({ projectId, onDone }: { projectId: string; onDone: (added: boolean) => void }) {
  const t = useT();
  const [label, setLabel] = React.useState("");
  const [command, setCommand] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const line = command.trim();
  const save = () => {
    if (!line) return;
    setBusy(true);
    // without a name, the first three words of the command stand in
    const name = label.trim() || line.split(/\s+/).slice(0, 3).join(" ");
    void db
      .addProjectCommand(projectId, name, line)
      .then(() => onDone(true))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Input
        autoFocus
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="docker compose up"
        aria-label={t("Command")}
        className="min-w-[220px] flex-1 font-mono text-xs"
      />
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t("Name (optional)")}
        aria-label={t("Name (optional)")}
        className="w-[140px]"
      />
      <Button type="submit" variant="primary" size="sm" disabled={!line} loading={busy}>
        {t("Add")}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => onDone(false)}>
        {t("Cancel")}
      </Button>
    </form>
  );
}
