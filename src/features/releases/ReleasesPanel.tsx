import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, Check, ChevronRight, Copy, ExternalLink, GitPullRequest, Package, RefreshCw, Tag } from "lucide-react";
import * as React from "react";
import { createTag, pushTag, tagRemote } from "@/lib/git";
import { styleSettingOf } from "@/lib/commit-style";
import {
  releasableCount,
  tagBlocker,
  tagWebUrl,
  validTagName,
  versionMismatches,
  type BumpReason,
  type ReleaseCommit,
  type ReleaseSummary,
} from "@/lib/releases";
import { writeClipboard } from "@/lib/clipboard";
import { useApp } from "@/store/app";
import { useBench } from "@/store/bench";
import { useReleases } from "@/store/releases";
import { useUI } from "@/store/ui";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Badge, Button, Input, Spinner } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { useDates } from "@/lib/dates";
import { cn } from "@/lib/utils";

/**
 * When to cut a release and what it will be: the last tag, what landed since,
 * the next version. release-please projects are read only — the action does the
 * releasing; tag projects get Create tag. Links are a line with Copy and Open,
 * never a preview.
 */

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How long "Copied" stays on a link before the button says Copy again. */
const COPIED_MS = 1600;

const REASON_TEXT: Record<BumpReason, string> = {
  breaking: "A breaking change bumps the major version.",
  "breaking-pre-major": "Before 1.0 a breaking change bumps the minor (bump-minor-pre-major).",
  feature: "A new feature bumps the minor version.",
  "feature-pre-major":
    "Before 1.0 a feature bumps only the patch (bump-patch-for-minor-pre-major). Remove that line from release-please-config.json for features to bump the minor.",
  fix: "Only fixes landed: the patch version moves.",
};

/** One URL as a line: what it is, the short form, Copy and Open. */
function LinkRow({ icon: Icon, label, url }: { icon: React.ComponentType<{ className?: string }>; label: string; url: string }) {
  const t = useT();
  const setError = useBench((s) => s.setError);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(id);
  }, [copied]);

  const short = url.replace(/^https?:\/\//, "");
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border-soft bg-surface-2 py-1 pl-2.5 pr-1">
      <Icon className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] text-text">{label}</span>
        <span className="selectable truncate font-mono text-[10px] text-text-3" title={url}>
          {short}
        </span>
      </span>
      <button
        type="button"
        onClick={() => void writeClipboard(url).then(() => setCopied(true), (e: unknown) => setError(errorText(e)))}
        title={copied ? t("Copied") : t("Copy link")}
        aria-label={copied ? t("Copied") : t("Copy link")}
        className={cn(
          "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded transition-colors",
          "focus-visible:outline-2 focus-visible:outline-accent",
          copied ? "text-success" : "text-text-3 hover:bg-surface-3 hover:text-text",
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => void openUrl(url).catch((e: unknown) => setError(errorText(e)))}
        title={t("Open in the browser")}
        aria-label={t("Open in the browser")}
        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-3 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </button>
      <span role="status" aria-atomic="true" className="sr-only">
        {copied ? t("Link copied") : ""}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[10px] font-medium uppercase tracking-wide text-text-3">{children}</h3>;
}

/** A foldable list of commits under a counted heading. */
function CommitGroup({
  title,
  items,
  tone,
  hint,
  defaultOpen,
}: {
  title: string;
  items: ReleaseCommit[];
  tone: "text" | "warn";
  hint?: string;
  defaultOpen: boolean;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(defaultOpen);
  if (!items.length) return null;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-text-3 transition-transform", open && "rotate-90")} aria-hidden />
        <span className={cn("flex-1 text-[12px] font-medium", tone === "warn" ? "text-warn" : "text-text-2")}>{title}</span>
        <span className={cn("tnum text-[11px]", tone === "warn" ? "text-warn" : "text-text-3")}>{items.length}</span>
      </button>
      {open && (
        <>
          {hint && <p className="px-1 pb-1 pl-5.5 text-[11px] text-warn">{t(hint)}</p>}
          <ul className="flex flex-col pb-1 pl-5.5">
            {items.map(({ commit, parsed }) => (
              <li key={commit.hash} className="flex min-w-0 items-baseline gap-2 py-0.5" title={commit.subject}>
                <span className="shrink-0 font-mono text-[10px] text-text-3">{commit.hash}</span>
                <span className="selectable min-w-0 truncate font-mono text-[11px] text-text-2">{commit.subject}</span>
                {parsed?.breaking && (
                  <Badge tone="danger" className="shrink-0 px-1 py-0 text-[10px]">
                    {t("breaking")}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function NextVersion({ summary }: { summary: ReleaseSummary }) {
  const t = useT();
  const first = !summary.current && summary.next;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-text-3">{t("Last release")}</span>
        <span className="tnum font-mono text-[12px] text-text-2">
          {summary.lastTag?.tag ?? (summary.current ? `${summary.prefix}${summary.current.major}.${summary.current.minor}.${summary.current.patch}` : t("none yet"))}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-text-3">{t("Next release")}</span>
        {summary.next ? (
          <span className="tnum font-mono text-[15px] font-semibold text-accent">{summary.next}</span>
        ) : (
          <span className="text-[12px] text-text-3">{t("nothing to release")}</span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-text-3">
        {first
          ? t("Never tagged: this would be the first version.")
          : summary.decision
            ? t(REASON_TEXT[summary.decision.reason])
            : t("No feature or fix since the last release. Docs, chores and refactors do not cut one on their own.")}
      </p>
    </div>
  );
}

/** release-please: the pull request it keeps open and the newest release, read from GitHub. */
function GitHubSection({ projectId, summary }: { projectId: string; summary: ReleaseSummary }) {
  const t = useT();
  const remote = useReleases((s) => s.remote[projectId]);
  const setView = useUI((s) => s.setView);
  const { ago } = useDates();

  if (!summary.githubRepo) {
    return <p className="text-[11px] text-text-3">{t("The remote is not on GitHub, so the release pull request cannot be read from here.")}</p>;
  }
  if (!remote || remote.phase === "loading") {
    return (
      <p className="flex items-center gap-2 text-[11px] text-text-3">
        <Spinner className="h-3.5 w-3.5" /> {t("Reading the release pull request from GitHub…")}
      </p>
    );
  }
  if (remote.phase === "no-account") {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <p className="text-[11px] text-text-3">{t("Link GitHub to see the release pull request and the newest release.")}</p>
        <Button variant="secondary" size="sm" onClick={() => setView("settings")}>
          {t("Open Settings")}
        </Button>
      </div>
    );
  }
  if (remote.phase === "failed") {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[11px] text-danger">{t(remote.error)}</p>
        {/* Assay's own reasons have a translation; GitHub's words have no key and stay as GitHub wrote them */}
        {remote.detail && <p className="selectable font-mono text-[10px] text-text-3">{t(remote.detail)}</p>}
      </div>
    );
  }
  const { pullRequest, latest } = remote.info;
  return (
    <div className="flex flex-col gap-1.5">
      {pullRequest ? (
        <LinkRow icon={GitPullRequest} label={`PR #${pullRequest.number} · ${pullRequest.title}`} url={pullRequest.url} />
      ) : (
        <p className="text-[11px] text-text-3">
          {releasableCount(summary.groups) > 0
            ? t("No release pull request open yet. release-please opens it after the next push to the default branch.")
            : t("No release pull request open.")}
        </p>
      )}
      {latest && (
        <LinkRow
          icon={Package}
          label={latest.publishedAt ? t("{name} · published {when}", { name: latest.name, when: ago(latest.publishedAt) }) : latest.name}
          url={latest.url}
        />
      )}
    </div>
  );
}

/** Tag mode: an annotated tag on HEAD, pushed, behind a confirmation. */
function CreateTag({ root, summary, onDone }: { root: string; summary: ReleaseSummary; onDone: (tag: string) => void }) {
  const t = useT();
  const setError = useBench((s) => s.setError);
  const [name, setName] = React.useState(summary.next ?? "");
  const [edited, setEdited] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [remote, setRemote] = React.useState<string | null>(null);

  // follow the prediction until the user types their own
  React.useEffect(() => {
    if (!edited) setName(summary.next ?? "");
  }, [summary.next, edited]);

  React.useEffect(() => {
    void tagRemote(root).then(setRemote);
  }, [root]);

  const blocker = tagBlocker(summary);
  const trimmed = name.trim();
  const valid = validTagName(trimmed);
  const exists = summary.lastTag?.tag === trimmed;
  const mismatches = valid ? versionMismatches(summary.versionFiles, trimmed) : [];

  let why: string | null = blocker ? t(blocker) : null;
  if (!why && !trimmed) why = t("Type the version to tag.");
  else if (!why && !valid) why = t("A tag here is a version: v1.2.3 or 1.2.3.");
  else if (!why && exists) why = t("That tag already exists.");

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await createTag(root, trimmed, trimmed);
      if (!made.ok) return setError(made.output || t("git refused to create the tag."));
      const sent = await pushTag(root, trimmed);
      if (!sent.ok) {
        return setError(t("The tag {tag} was created here but not pushed. Push it from a terminal with git push origin {tag}.", { tag: trimmed }), sent.output);
      }
      setEdited(false);
      onDone(trimmed);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remoteName = remote ?? "origin";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setEdited(true);
          }}
          placeholder="v1.0.0"
          aria-label={t("Version tag")}
          className="h-7 font-mono text-[12px]"
        />
        <Button variant="primary" size="sm" disabled={!!why || busy} loading={busy} onClick={() => setAsking(true)} title={why ?? undefined}>
          <Tag className="h-3.5 w-3.5" /> {t("Create tag")}
        </Button>
      </div>
      {why && <p className="text-[11px] text-text-3">{why}</p>}
      {mismatches.map((m) => (
        <p key={m.file} className="flex items-start gap-1.5 text-[11px] text-warn">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>
            {t("{file} says {version}; the tag will be {tag}. Assay does not change version files.", {
              file: m.file,
              version: m.version,
              tag: trimmed,
            })}
          </span>
        </p>
      ))}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t("Create and push {tag}?", { tag: trimmed })}
        confirmLabel={t("Create & push")}
        body={
          <div className="flex flex-col gap-2">
            <p>
              {t("Tags the current commit on {branch} and sends the tag to the remote. A pushed tag usually starts the release workflow.", {
                branch: summary.branch ?? "HEAD",
              })}
            </p>
            <pre className="selectable overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] text-text">
              {`git tag -a ${trimmed} -m "${trimmed}"\ngit push ${remoteName} refs/tags/${trimmed}`}
            </pre>
          </div>
        }
        onConfirm={() => void run()}
      />
    </div>
  );
}

export function ReleasesPanel({ projectId, root }: { projectId: string; root: string }) {
  const t = useT();
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const summary = useReleases((s) => s.local[projectId]);
  const loading = useReleases((s) => !!s.loadingLocal[projectId]);
  const loadLocal = useReleases((s) => s.loadLocal);
  const loadRemote = useReleases((s) => s.loadRemote);
  const setError = useBench((s) => s.setError);
  const setting = styleSettingOf(project);
  const [lastTagged, setLastTagged] = React.useState<string | null>(null);

  const mode = summary?.mode;
  const githubRepo = summary?.githubRepo ?? null;

  // GitHub is asked on open and on a project switch, not on every local re-read
  React.useEffect(() => {
    if (mode === "release-please" && githubRepo) void loadRemote(projectId, githubRepo);
  }, [projectId, mode, githubRepo, loadRemote]);

  React.useEffect(() => setLastTagged(null), [projectId]);

  const refresh = () => {
    void loadLocal(projectId, root, setting)
      .then((s) => {
        if (s?.mode === "release-please" && s.githubRepo) return loadRemote(projectId, s.githubRepo);
      })
      .catch((e: unknown) => setError(errorText(e)));
  };

  if (!summary) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[11px] text-text-3">
        <Spinner className="h-3.5 w-3.5" /> {t("Reading tags and commits…")}
      </div>
    );
  }

  if (!summary.repo) {
    return <p className="p-3 text-[11px] text-text-3">{t("This folder is not a git repository, so there is no release history to read.")}</p>;
  }

  const g = summary.groups;
  const since = summary.lastTag ? t("Since {tag}", { tag: summary.lastTag.tag }) : t("All commits (never tagged)");
  const taggedUrl = lastTagged ? tagWebUrl(summary.webUrl, lastTagged) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <div className="flex items-center gap-2">
        <Badge tone={summary.mode === "release-please" ? "accent" : "neutral"} className="text-[10px]">
          {summary.mode === "release-please" ? "release-please" : t("Tag releases")}
        </Badge>
        <span className="flex-1" />
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          title={t("Read again")}
          aria-label={t("Read again")}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {summary.configUnreadable && (
        <p className="flex items-start gap-1.5 text-[11px] text-warn">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {t("release-please-config.json could not be read as JSON; the prediction uses release-please's defaults.")}
        </p>
      )}

      <NextVersion summary={summary} />

      <section className="flex flex-col gap-1">
        <SectionTitle>{since}</SectionTitle>
        {g.features.length + g.fixes.length + g.other.length + g.ignored.length === 0 ? (
          <p className="text-[11px] text-text-3">{t("No commits since the last release.")}</p>
        ) : (
          <>
            <CommitGroup title={t("Features")} items={g.features} tone="text" defaultOpen />
            <CommitGroup title={t("Fixes")} items={g.fixes} tone="text" defaultOpen />
            <CommitGroup title={t("Other changes")} items={g.other} tone="text" defaultOpen={false} />
            <CommitGroup
              title={summary.mode === "release-please" ? t("Ignored by release-please") : t("Without a type")}
              items={g.ignored}
              tone="warn"
              hint={
                summary.mode === "release-please"
                  ? "release-please only reads subjects that start with the type (feat: ✨ …). These will not appear in the changelog or move the version."
                  : undefined
              }
              defaultOpen={summary.mode === "release-please"}
            />
          </>
        )}
      </section>

      {summary.mode === "release-please" ? (
        <section className="flex flex-col gap-1.5">
          <SectionTitle>GitHub</SectionTitle>
          <GitHubSection projectId={projectId} summary={summary} />
          {summary.otherPackages.length > 0 && (
            <div className="mt-1 flex flex-col gap-1">
              <p className="text-[11px] text-text-3">
                {t("Per-package prediction is not supported yet: see the release pull request.")}
              </p>
              <ul className="flex flex-col">
                {summary.otherPackages.map((p) => (
                  <li key={p.path} className="flex items-baseline justify-between gap-2 py-0.5 font-mono text-[11px]">
                    <span className="truncate text-text-2">{p.path}</span>
                    <span className="tnum shrink-0 text-text-3">{p.version ?? "—"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : (
        <section className="flex flex-col gap-1.5">
          <SectionTitle>{t("New release")}</SectionTitle>
          <CreateTag
            root={root}
            summary={summary}
            onDone={(tag) => {
              setLastTagged(tag);
              refresh();
            }}
          />
          {lastTagged && (
            <div className="flex flex-col gap-1.5">
              <p className="flex items-center gap-1.5 text-[11px] text-success">
                <Check className="h-3 w-3" aria-hidden /> {t("{tag} created and pushed.", { tag: lastTagged })}
              </p>
              {taggedUrl && <LinkRow icon={Tag} label={lastTagged} url={taggedUrl} />}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
