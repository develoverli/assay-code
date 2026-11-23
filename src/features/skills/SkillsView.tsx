import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  Copy,
  Download,
  FolderGit2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { useApp, blockedReason } from "@/store/app";
import { useUI } from "@/store/ui";
import { useBench } from "@/store/bench";
import { parseAIChoice, type AIInventory } from "@/lib/ai";
import { AIMenuItems, useAIInventory, useTaskChoice } from "@/features/shared/AIPicker";
import { availableLaunchers, LAUNCHERS, type TermKind } from "@/lib/bench-term";
import { discoverInProject, type ImportCandidate } from "@/lib/importers";
import { skillTerminalPrompt, type SkillLike } from "@/lib/runner";
import type { AIProvider, Project, Tool } from "@/types";
import { Button, Card, EmptyState } from "@/components/ui/primitives";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { ViewHeader } from "@/components/layout/ViewHeader";
import { SkillDialog } from "@/features/skills/SkillDialog";
import { ImportDialog } from "@/features/shared/ImportDialog";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The agents a terminal can be opened on: every launcher except the bare shell. */
const AGENTS = LAUNCHERS.filter((l) => l.kind !== "shell");

interface Engine {
  /** Settings' default for skills, as a stored choice string. */
  value: string;
  engine: AIProvider;
  inventory: AIInventory | null;
  ready: Record<TermKind, boolean> | null;
}

/**
 * Settings' default for skills, what can run one, and which agents a terminal can open on.
 * Resolved once by the view and shared through `EngineContext`, so the binaries are probed
 * once per visit rather than once per card.
 */
function useEngine(): Engine {
  const { inventory } = useAIInventory();
  const [value] = useTaskChoice("skills");
  const [ready, setReady] = React.useState<Record<TermKind, boolean> | null>(null);

  React.useEffect(() => {
    let ignore = false;
    void availableLaunchers().then((r) => {
      if (!ignore) setReady(r);
    });
    return () => {
      ignore = true;
    };
  }, []);

  const choice = parseAIChoice(value);
  const engine: AIProvider = choice?.kind === "agent" ? choice.provider : "claude";
  return React.useMemo(() => ({ value, engine, inventory, ready }), [value, engine, inventory, ready]);
}

const EngineContext = React.createContext<Engine>({ value: "", engine: "claude", inventory: null, ready: null });

/** The active project and whether a new run on it would be refused, without the whole store. */
function useActiveRunTarget(): { project: Project | undefined; blocked: string | null } {
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId));
  // a string or null: the log stream rewrites `runs` many times a second, this rarely changes
  const blocked = useApp((s) => blockedReason(s.runs, s.maxConcurrent, project?.id));
  return { project, blocked };
}

/** A stored choice as the provider and model a run takes, or null for one that cannot edit files. */
function agentOf(value: string): { provider: AIProvider; model?: string } | null {
  const choice = parseAIChoice(value);
  if (choice?.kind !== "agent") return null;
  return { provider: choice.provider, model: choice.model || undefined };
}

/**
 * Run is headless and persisted for Audit; Use opens a Workspace terminal with the
 * agent already on the prompt, unrecorded but watchable.
 */
function RunAndUse({
  projectName,
  hasFolder,
  canRun,
  value,
  engine,
  inventory,
  ready,
  onRun,
  onUse,
}: {
  projectName: string | undefined;
  hasFolder: boolean;
  canRun: boolean;
  /** Settings' default for skills, as a stored choice string. */
  value: string;
  engine: AIProvider;
  inventory: AIInventory | null;
  ready: Record<TermKind, boolean> | null;
  /** No argument: the default. With one: that engine, this run only. */
  onRun: (value?: string) => void;
  onUse: (kind: TermKind) => void;
}) {
  const t = useT();
  return (
    <>
      <Button
        variant="subtle"
        size="sm"
        className="min-w-0 flex-1"
        disabled={!canRun}
        onClick={() => onRun()}
        title={
          hasFolder
            ? t("Runs headless; the log is kept in Audit")
            : t("Active project needs a local folder")
        }
      >
        <Play className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {t("Run on {project}", { project: projectName ?? t("project") })}
        </span>
      </Button>

      <Button
        variant="subtle"
        size="sm"
        disabled={!hasFolder}
        onClick={() => onUse(engine)}
        title={
          hasFolder
            ? t("Opens a terminal with {engine} already working on it", { engine })
            : t("Active project needs a local folder")
        }
      >
        <SquareTerminal className="h-3.5 w-3.5 shrink-0" /> {t("Use")}
      </Button>

      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={!hasFolder}
            aria-label={t("Run or use with another AI")}
            title={t("Run or use with another AI")}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content
            align="end"
            sideOffset={6}
            className="z-50 max-h-[420px] w-[280px] overflow-auto rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
          >
            <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-text-2">{t("Run headless with")}</p>
            {canRun ? (
              <AIMenuItems task="skills" inventory={inventory} value={value} onPick={onRun} />
            ) : (
              <p className="px-2.5 pb-1 text-[11px] text-text-3">{t("Another run is in progress for this project.")}</p>
            )}
            <Dropdown.Separator className="my-1 h-px bg-border" />
            <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-text-2">{t("Open a terminal with")}</p>
            {AGENTS.map((agent) => {
              const installed = ready ? ready[agent.kind] : true;
              return (
                <Dropdown.Item
                  key={agent.kind}
                  disabled={!installed}
                  onSelect={() => onUse(agent.kind)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors",
                    installed
                      ? "cursor-pointer text-text-2 data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
                      : "cursor-not-allowed text-text-3 opacity-50",
                  )}
                >
                  <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">{agent.label}</span>
                  {agent.kind === engine && (
                    <span className="text-[10px] text-text-3">{t("default")}</span>
                  )}
                  {!installed && <span className="text-[10px]">{t("not installed")}</span>}
                </Dropdown.Item>
              );
            })}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </>
  );
}

/** Name and a two-line description; the prompt opens in the detail. */
function SkillSummary({
  icon,
  name,
  description,
  aside,
  onOpen,
}: {
  icon: React.ReactNode;
  name: string;
  description: string | null;
  aside?: React.ReactNode;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("See the whole skill")}
      className="group -m-1 flex min-w-0 cursor-pointer flex-col gap-1 rounded-md p-1 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate text-[13px] font-semibold group-hover:text-text">{name}</span>
        {aside}
      </span>
      {description && <span className="line-clamp-2 text-[11px] text-text-2">{description}</span>}
    </button>
  );
}

/** Everything the card leaves out, read only; the actions stay on the card. */
function SkillDetail({
  open,
  onOpenChange,
  name,
  description,
  prompt,
  origin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  description: string | null;
  prompt: string | null;
  origin?: string;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={name} desc={description ?? undefined} className="w-[min(720px,92vw)]">
        {origin && <p className="mb-2 font-mono text-[10px] text-text-3">{origin}</p>}
        {prompt ? (
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border-soft bg-surface-2 p-3 font-mono text-[11px] text-text-2 selectable">
            {prompt}
          </pre>
        ) : (
          <p className="text-[12px] text-text-3">{t("This skill has no prompt.")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Opening a terminal on a skill, whichever of the two lists it came from. */
function useOpenInTerminal() {
  const setView = useUI((s) => s.setView);
  const setProject = useBench((s) => s.setProject);
  const newTerminal = useBench((s) => s.newTerminal);

  return React.useCallback(
    (project: Project, skill: SkillLike, kind: TermKind) => {
      if (!project.path) return;
      // Workspace may never have been opened, and the session still has to be tagged
      setProject(project.id, project.path);
      void newTerminal(kind, project.path, {
        prompt: skillTerminalPrompt(project, skill),
        label: skill.name,
      });
      setView("bench");
    },
    [newTerminal, setProject, setView],
  );
}

/** A skill Assay holds: a row in `tools`, editable and deletable here. */
function SkillCard({ skill }: { skill: Tool }) {
  const { runSkill, deleteTool } = useApp(
    useShallow((s) => ({ runSkill: s.runSkill, deleteTool: s.deleteTool })),
  );
  const t = useT();
  const openInTerminal = useOpenInTerminal();
  const { value, engine, inventory, ready } = React.useContext(EngineContext);
  const { project, blocked } = useActiveRunTarget();
  const [edit, setEdit] = React.useState(false);
  const [del, setDel] = React.useState(false);
  const [viewing, setViewing] = React.useState(false);

  const run = (override?: string) => {
    const agent = agentOf(override ?? value);
    if (!project || !agent) return;
    void runSkill(project.id, skill.id, agent.provider, agent.model);
  };

  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <SkillSummary
        icon={<Sparkles className="h-4 w-4 shrink-0 text-accent" />}
        name={skill.name}
        description={skill.notes ?? null}
        onOpen={() => setViewing(true)}
      />
      <div className="mt-auto flex items-center gap-1.5">
        <RunAndUse
          projectName={project?.name}
          hasFolder={!!project?.path}
          canRun={!!project?.path && !blocked}
          value={value}
          engine={engine}
          inventory={inventory}
          ready={ready}
          onRun={run}
          onUse={(kind) => project && openInTerminal(project, skill, kind)}
        />

        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("More")}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content
              align="end"
              sideOffset={6}
              className="z-50 min-w-[170px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
            >
              <Dropdown.Item
                onSelect={() => setEdit(true)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text-2 outline-none transition-colors data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
              >
                <Pencil className="h-3.5 w-3.5" /> {t("Edit")}
              </Dropdown.Item>
              <Dropdown.Item
                onSelect={() => setDel(true)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text-3 outline-none transition-colors data-[highlighted]:bg-danger/10 data-[highlighted]:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" /> {t("Delete")}
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
      <SkillDetail
        open={viewing}
        onOpenChange={setViewing}
        name={skill.name}
        description={skill.notes ?? null}
        prompt={skill.prompt ?? null}
      />
      <SkillDialog open={edit} onOpenChange={setEdit} skill={skill} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        danger
        title={t("Delete skill?")}
        confirmLabel={t("Delete")}
        body={
          <>
            {t(
              "Delete {name} from Assay? Nothing on disk is touched: a skill imported from SKILL.md keeps that file, and you can import it again.",
              { name: skill.name },
            )}
            {skill.builtin && ` ${t("Built-in skills come back from Settings → Built-in tools.")}`}
          </>
        }
        onConfirm={() => void deleteTool(skill.id)}
      />
    </Card>
  );
}

/** A skill versioned in the project's repo: runnable and copyable, never edited or deleted. */
function ProjectSkillCard({ candidate, copied }: { candidate: ImportCandidate; copied: boolean }) {
  const { runProjectSkill, saveTool, reloadTools } = useApp(
    useShallow((s) => ({ runProjectSkill: s.runProjectSkill, saveTool: s.saveTool, reloadTools: s.reloadTools })),
  );
  const t = useT();
  const openInTerminal = useOpenInTerminal();
  const { value, engine, inventory, ready } = React.useContext(EngineContext);
  const { project, blocked } = useActiveRunTarget();
  const [copying, setCopying] = React.useState(false);
  const [viewing, setViewing] = React.useState(false);

  const skill: SkillLike = {
    id: "",
    name: candidate.name,
    notes: candidate.description || null,
    prompt: candidate.body || null,
  };

  const run = (override?: string) => {
    const agent = agentOf(override ?? value);
    if (!project || !agent) return;
    void runProjectSkill(project.id, skill, agent.provider, agent.model);
  };

  const copy = async () => {
    setCopying(true);
    try {
      await saveTool({
        name: candidate.name,
        source: "skill",
        kind: "cli-agent",
        scope: "local",
        stack: [],
        cmd: "",
        adapter: "generic",
        prompt: candidate.body,
        builtin: false,
        enabled: true,
        notes: candidate.description || t("Copied from this project"),
      });
      await reloadTools();
    } finally {
      setCopying(false);
    }
  };

  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <SkillSummary
        icon={<FolderGit2 className="h-4 w-4 shrink-0 text-brass" />}
        name={candidate.name}
        description={candidate.description || null}
        aside={<span className="ml-auto shrink-0 font-mono text-[10px] text-text-3">{candidate.origin}</span>}
        onOpen={() => setViewing(true)}
      />
      <SkillDetail
        open={viewing}
        onOpenChange={setViewing}
        name={candidate.name}
        description={candidate.description || null}
        prompt={candidate.body || null}
        origin={candidate.origin}
      />
      <div className="mt-auto flex items-center gap-1.5">
        <RunAndUse
          projectName={project?.name}
          hasFolder={!!project?.path}
          canRun={!!project?.path && !blocked}
          value={value}
          engine={engine}
          inventory={inventory}
          ready={ready}
          onRun={run}
          onUse={(kind) => project && openInTerminal(project, skill, kind)}
        />
        <Button
          variant="ghost"
          size="icon"
          loading={copying}
          disabled={copied}
          aria-label={copied ? t("Already in Assay") : t("Copy to Assay")}
          title={
            copied
              ? t("Already in Assay")
              : t("Copy it into Assay, where you can edit it without touching the repo")
          }
          onClick={() => void copy()}
        >
          <Copy className={cn("h-3.5 w-3.5", copied && "text-success")} />
        </Button>
      </div>
    </Card>
  );
}

/** What the project itself carries, read again whenever the project changes. */
function ProjectSkills() {
  const t = useT();
  const tools = useApp((s) => s.tools);
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const root = projects.find((p) => p.id === activeProjectId)?.path ?? null;
  const [items, setItems] = React.useState<ImportCandidate[]>([]);
  const [loading, setLoading] = React.useState(false);

  /** Bumped by Refresh; the effect below re-reads the folder on it. */
  const [reloadSeq, setReloadSeq] = React.useState(0);

  React.useEffect(() => {
    if (!root) {
      setItems([]);
      setLoading(false);
      return;
    }
    // a slower read of the project left behind must not land on the one now on screen
    let ignore = false;
    setLoading(true);
    discoverInProject(root)
      .then((found) => {
        if (!ignore) setItems(found);
      })
      .catch(() => {
        if (!ignore) setItems([]);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [root, reloadSeq]);

  const load = React.useCallback(() => setReloadSeq((n) => n + 1), []);

  const copiedNames = React.useMemo(() => {
    const names = new Set<string>();
    for (const tool of tools) if (tool.source === "skill") names.add(tool.name.toLowerCase());
    return names;
  }, [tools]);

  // a project without those folders gets no empty section to scroll past
  if (!items.length) return null;

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="shrink-0 text-[13px] font-semibold">{t("In this project")}</h2>
        <span className="truncate text-[11px] text-text-3">
          {t("Versioned in the repo. Assay runs them and never writes to them.")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          loading={loading}
          aria-label={t("Refresh")}
          title={t("Refresh")}
          onClick={load}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <ProjectSkillCard key={c.id} candidate={c} copied={copiedNames.has(c.name.toLowerCase())} />
        ))}
      </div>
    </section>
  );
}

export function SkillsView() {
  const tools = useApp((s) => s.tools);
  const t = useT();
  const engine = useEngine();
  const skills = tools.filter((t) => t.source === "skill");
  const [add, setAdd] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  /** Bumped on every open so the import dialog remounts with nothing selected. */
  const [importSeq, setImportSeq] = React.useState(0);

  return (
    <EngineContext.Provider value={engine}>
      <div className="mx-auto max-w-5xl p-5">
        <ViewHeader
          title={t("Skills")}
          subtitle={t(
            "Reusable AI tasks. Run works headless and keeps its log in Audit; Use opens a terminal with the agent already working on it. Skills don't create findings — those come from the scanners in Tools.",
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
                <Plus className="h-4 w-4" /> {t("New skill")}
              </Button>
            </div>
          }
        />

        <ProjectSkills />

        {skills.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={t("No skills yet")}
            desc={t("Create a skill — a prompt the AI runs on your project. Use “Improve with AI” to refine it.")}
            action={
              <Button variant="primary" onClick={() => setAdd(true)}>
                <Plus className="h-4 w-4" /> {t("New skill")}
              </Button>
            }
          />
        ) : (
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="shrink-0 text-[13px] font-semibold">{t("In Assay")}</h2>
              <span className="truncate text-[11px] text-text-3">
                {t("Yours: written here, or imported from this machine.")}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {skills.map((s) => (
                <SkillCard key={s.id} skill={s} />
              ))}
            </div>
          </section>
        )}
        <SkillDialog open={add} onOpenChange={setAdd} />
        <ImportDialog key={importSeq} kind="skill" open={importing} onOpenChange={setImporting} />
      </div>
    </EngineContext.Provider>
  );
}
