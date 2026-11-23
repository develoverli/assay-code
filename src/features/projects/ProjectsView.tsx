import { Download, Eraser, FolderGit2, Globe, Lock, Pencil, Play, Plus, Settings2, ShieldCheck, Tags as TagsIcon, Trash2, X } from "lucide-react";
import * as React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import * as db from "@/lib/db";
import type { Project, Severity } from "@/types";
import { SEVERITY_RANK } from "@/types";
import { Badge, Button, Card, EmptyState } from "@/components/ui/primitives";
import { SeverityDot } from "@/components/ui/severity";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ProjectDialog } from "@/features/projects/ProjectDialog";
import { CloneDialog } from "@/features/github/CloneDialog";
import { GitHubMark } from "@/features/github/GitHubMark";
import { ProjectActivity, useOrderedProjects } from "@/features/projects/ProjectActivity";
import { ManageTagsDialog, TagPill } from "@/features/projects/Tags";
import { GithubFilterSelect, TagFilterSelect } from "@/features/projects/ProjectFilters";
import { filterByTags, groupByTag, tagsOf } from "@/lib/tags";
import { filterByGithubOwner, githubOwners } from "@/lib/github";
import { ViewHeader } from "@/components/layout/ViewHeader";
import { useT } from "@/lib/i18n";
import { useDates } from "@/lib/dates";

// Own-key Map read rather than indexing SEVERITY_RANK with a variable.
const SEVERITY_RANK_BY_KEY = new Map<string, number>(Object.entries(SEVERITY_RANK));

function severityRank(sv: Severity): number {
  return SEVERITY_RANK_BY_KEY.get(sv) ?? 0;
}

/** What a card shows of a project's history: its newest run and its open findings by severity. */
interface ProjectSummary {
  lastRunAt: number | null;
  bySev: Map<Severity, number>;
  open: number;
}

const EMPTY_SUMMARY: ProjectSummary = { lastRunAt: null, bySev: new Map(), open: 0 };

/**
 * One read of runs and one of findings for the whole list, grouped by project, so a
 * `dataVersion` bump costs two queries rather than two per card.
 */
function useProjectSummaries(): Map<string, ProjectSummary> {
  const dataVersion = useApp((s) => s.dataVersion);
  const [summaries, setSummaries] = React.useState<Map<string, ProjectSummary>>(() => new Map());
  React.useEffect(() => {
    let ignore = false;
    void Promise.all([db.listRuns(), db.currentFindingsAll()]).then(([runs, findings]) => {
      if (ignore) return;
      const next = new Map<string, ProjectSummary>();
      const of = (id: string): ProjectSummary => {
        let sum = next.get(id);
        if (!sum) {
          sum = { lastRunAt: null, bySev: new Map(), open: 0 };
          next.set(id, sum);
        }
        return sum;
      };
      // newest first, so the first run seen for a project is its last one
      for (const r of runs) {
        const sum = of(r.project_id);
        if (sum.lastRunAt === null) sum.lastRunAt = r.started_at;
      }
      for (const f of findings) {
        if (f.fixed) continue;
        const sum = of(f.project_id);
        sum.open += 1;
        sum.bySev.set(f.severity, (sum.bySev.get(f.severity) ?? 0) + 1);
      }
      setSummaries(next);
    });
    return () => {
      ignore = true;
    };
  }, [dataVersion]);
  return summaries;
}

function ProjectCard({ project, summary }: { project: Project; summary: ProjectSummary }) {
  const { setActiveProject, deleteProject, clearChecks } = useApp(
    useShallow((s) => ({
      setActiveProject: s.setActiveProject,
      deleteProject: s.deleteProject,
      clearChecks: s.clearChecks,
    })),
  );
  const tags = useApp((s) => s.tags);
  const t = useT();
  const dates = useDates();
  const setView = useUI((s) => s.setView);
  const [edit, setEdit] = React.useState(false);
  const [del, setDel] = React.useState(false);
  const [reset, setReset] = React.useState(false);

  const own = tagsOf(project, tags);
  const { lastRunAt, bySev, open } = summary;

  return (
    <Card className="flex flex-col gap-3 p-4 transition-colors hover:border-border/80">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FolderGit2 className="h-4 w-4 shrink-0 text-text-3" />
          <span className="truncate text-[13px] font-semibold">{project.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ProjectActivity projectId={project.id} />
          {project.url &&
            (project.authorized ? (
              <Badge tone="success">
                <ShieldCheck className="h-3 w-3" /> {t("authorized")}
              </Badge>
            ) : (
              <Badge tone="warn">{t("unauthorized")}</Badge>
            ))}
        </div>
      </div>

      <div className="flex flex-col gap-1 font-mono text-[11px] text-text-3">
        {project.path && <span className="truncate selectable">{project.path}</span>}
        {project.github_repo && (
          <span className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="flex min-w-0 cursor-pointer items-center gap-1 truncate text-left hover:text-text-2"
              title={t("Open on GitHub")}
              onClick={() => void openUrl(`https://github.com/${project.github_repo}`)}
            >
              <GitHubMark className="h-3 w-3 shrink-0" /> <span className="truncate">{project.github_repo}</span>
            </button>
            {/* the word next to the icon: a padlock alone is easy to misread */}
            {project.github_private != null && (
              <Badge tone="neutral" className="shrink-0 font-sans">
                {project.github_private ? <Lock className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
                {project.github_private ? t("Private") : t("Public")}
              </Badge>
            )}
          </span>
        )}
        {project.url && (
          <span className="flex items-center gap-1 truncate selectable">
            <Globe className="h-3 w-3" /> {project.url}
          </span>
        )}
      </div>

      {own.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {own.map((tag) => (
            <TagPill key={tag.id} tag={tag} />
          ))}
        </div>
      )}

      {project.stack.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {project.stack.map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border-soft pt-2.5 text-[11px] text-text-3">
        <span className="tnum">
          {lastRunAt
            ? t("scanned {when}", { when: dates.ago(lastRunAt) })
            : t("never scanned")}
        </span>
        {open > 0 && (
          <span className="flex items-center gap-2">
            {[...bySev.keys()]
              .sort((a, b) => severityRank(a) - severityRank(b))
              .map((s) => (
                <span key={s} className="flex items-center gap-1 tnum">
                  <SeverityDot severity={s} /> {bySev.get(s) ?? 0}
                </span>
              ))}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="subtle"
          size="sm"
          className="flex-1"
          onClick={() => {
            setActiveProject(project.id);
            setView("tools");
          }}
        >
          <Play className="h-3.5 w-3.5" /> {t("Run tools")}
        </Button>
        <Button variant="ghost" size="icon" aria-label={t("Edit")} onClick={() => setEdit(true)}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("Reset checks")}
          title={t("Reset checks — empties Findings, keeps Audit and Stats")}
          onClick={() => setReset(true)}
        >
          <Eraser className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t("Remove project")} onClick={() => setDel(true)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ProjectDialog open={edit} onOpenChange={setEdit} project={project} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        danger
        title={t("Remove project?")}
        confirmLabel={t("Remove")}
        body={
          <div className="flex flex-col gap-2">
            <span>
              {t("Remove {project} from Assay. Files on disk are not touched.", { project: project.name })}
            </span>
            <span className="text-text-3">
              {t(
                "Its runs and findings stay in Audit and Stats, marked as no longer tracked, so the record of work you already did is not rewritten.",
              )}
            </span>
          </div>
        }
        onConfirm={() => void deleteProject(project.id)}
      />
      <ConfirmDialog
        open={reset}
        onOpenChange={setReset}
        title={t("Reset checks?")}
        confirmLabel={t("Reset checks")}
        body={
          <div className="flex flex-col gap-2">
            <span>
              {t("Findings for {project} starts empty, as if it had never been scanned.", {
                project: project.name,
              })}
            </span>
            <span className="text-text-3">
              {t(
                "Audit keeps every run and Stats keeps the whole evolution — only the current board is cleared. Scan again to fill it.",
              )}
            </span>
          </div>
        }
        onConfirm={() => void clearChecks(project.id)}
      />
    </Card>
  );
}

/**
 * Tag and GitHub-account filters plus the grouping switches. Each control appears
 * only once there is something to filter by (first tag, first clone).
 */
function TagFilterBar({
  onManage,
}: {
  onManage: () => void;
}) {
  const tags = useApp((s) => s.tags);
  const projects = useApp((s) => s.projects);
  const {
    projectTagFilter,
    projectGithubFilter,
    projectsGroupByTag,
    toggleProjectTag,
    setProjectGithubFilter,
    clearProjectTagFilter,
    setProjectsGroupByTag,
  } = useUI();
  const t = useT();
  const owners = React.useMemo(() => githubOwners(projects), [projects]);
  if (!tags.length && !owners.length) return null;

  const filtering = projectTagFilter.length > 0 || projectGithubFilter !== null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-2">
      {tags.length > 0 && (
        <TagFilterSelect tags={tags} picked={projectTagFilter} usage={projects} onToggle={toggleProjectTag} />
      )}
      {owners.length > 0 && (
        <GithubFilterSelect
          owners={owners}
          total={projects.length}
          value={projectGithubFilter}
          onChange={setProjectGithubFilter}
        />
      )}
      {filtering && (
        <Button variant="ghost" size="sm" onClick={clearProjectTagFilter}>
          <X className="h-3.5 w-3.5" /> {t("Clear filter")}
        </Button>
      )}
      {tags.length > 0 && (
      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant={projectsGroupByTag ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={projectsGroupByTag}
          onClick={() => setProjectsGroupByTag(!projectsGroupByTag)}
          title={t("Split the list into one section per tag")}
        >
          {t("Group by tag")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onManage} title={t("Rename, recolour or delete tags")}>
          <Settings2 className="h-3.5 w-3.5" /> {t("Manage tags")}
        </Button>
      </div>
      )}
    </div>
  );
}

function ProjectGrid({
  projects,
  summaries,
}: {
  projects: Project[];
  summaries: Map<string, ProjectSummary>;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => (
        <ProjectCard key={p.id} project={p} summary={summaries.get(p.id) ?? EMPTY_SUMMARY} />
      ))}
    </div>
  );
}

export function ProjectsView() {
  const tags = useApp((s) => s.tags);
  const projects = useOrderedProjects();
  const summaries = useProjectSummaries();
  const { projectTagFilter, projectGithubFilter, projectsGroupByTag } = useUI();
  const t = useT();
  const [add, setAdd] = React.useState(false);
  const [cloning, setCloning] = React.useState(false);
  const [managing, setManaging] = React.useState(false);

  const visible = filterByGithubOwner(filterByTags(projects, projectTagFilter), projectGithubFilter);
  const groups = projectsGroupByTag ? groupByTag(visible, tags, projectTagFilter) : [];

  return (
    <div className="mx-auto max-w-6xl p-5">
      <ViewHeader
        title={t("Projects")}
        subtitle={t("Local folders and published URLs you test against.")}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setCloning(true)}>
              <Download className="h-4 w-4" /> {t("Clone from GitHub")}
            </Button>
            <Button variant="primary" onClick={() => setAdd(true)}>
              <Plus className="h-4 w-4" /> {t("Add project")}
            </Button>
          </div>
        }
      />
      {projects.length > 0 && <TagFilterBar onManage={() => setManaging(true)} />}

      {projects.length === 0 && (
        <EmptyState
          icon={FolderGit2}
          title={t("No projects yet")}
          desc={t("Add a local folder or a published URL to start running tools against it.")}
          action={
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setCloning(true)}>
                <Download className="h-4 w-4" /> {t("Clone from GitHub")}
              </Button>
              <Button variant="primary" onClick={() => setAdd(true)}>
                <Plus className="h-4 w-4" /> {t("Add project")}
              </Button>
            </div>
          }
        />
      )}

      {projects.length > 0 && visible.length === 0 && (
        <EmptyState
          icon={TagsIcon}
          title={projectGithubFilter ? t("Nothing matches these filters") : t("Nothing with those tags")}
          desc={
            projectGithubFilter
              ? t("No project cloned from {owner} carries the tags you picked.", { owner: projectGithubFilter })
              : t("No project carries any of the tags you picked.")
          }
        />
      )}

      {visible.length > 0 &&
        (projectsGroupByTag ? (
          <div className="flex flex-col gap-6">
            {groups.map((g) => (
              <section key={g.tag?.id ?? "untagged"} className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  {g.tag ? (
                    <TagPill tag={g.tag} />
                  ) : (
                    <span className="text-[11px] uppercase tracking-wide text-text-3">{t("No tag")}</span>
                  )}
                  <span className="text-[11px] text-text-3">{g.projects.length}</span>
                </div>
                <ProjectGrid projects={g.projects} summaries={summaries} />
              </section>
            ))}
          </div>
        ) : (
          <ProjectGrid projects={visible} summaries={summaries} />
        ))}

      <ProjectDialog open={add} onOpenChange={setAdd} />
      <CloneDialog open={cloning} onOpenChange={setCloning} />
      <ManageTagsDialog open={managing} onOpenChange={setManaging} />
    </div>
  );
}
