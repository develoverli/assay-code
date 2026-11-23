import { Download, Plug, RefreshCw } from "lucide-react";
import * as React from "react";
import { Badge, Button } from "@/components/ui/primitives";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { useApp } from "@/store/app";
import { useT } from "@/lib/i18n";
import {
  AGENT_PLATFORMS,
  GRAPHIFY_EXTRAS,
  agentInstallTokens,
  detectInstallCommand,
  graphifyVersion,
  installAgentSkill,
  installGraphify,
  readAgentSkills,
  skillStanding,
  staleSkillCount,
  type AgentPlatform,
  type AgentSkill,
  type GraphifyExtra,
  type InstallCommand,
  type SkillStanding,
} from "@/lib/graphify";

/**
 * What graphify has installed *outside* this project: the skill each agent
 * reads, and the extractors the CLI was built with. Machine state, not a scan.
 */

interface AgentSkillsState {
  skills: AgentSkill[];
  /** The installed package's version, or null when it would not say. */
  pkg: string | null;
  /** Installed skills that are behind the package — the only count worth a badge. */
  stale: number;
  loading: boolean;
  refresh: () => void;
}

/**
 * Read the skills and the package version, whenever there is a graphify to ask.
 * Kept in the row, not the dialog, so the badge shows stale skills unopened.
 */
export function useAgentSkills(enabled: boolean): AgentSkillsState {
  const [skills, setSkills] = React.useState<AgentSkill[]>([]);
  const [pkg, setPkg] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    if (!enabled) {
      setSkills([]);
      setPkg(null);
      return;
    }
    let ignore = false;
    setLoading(true);
    void Promise.all([readAgentSkills(), graphifyVersion()])
      .then(([list, v]) => {
        if (ignore) return;
        setSkills(list);
        setPkg(v);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [enabled, version]);

  const refresh = React.useCallback(() => setVersion((v) => v + 1), []);
  return { skills, pkg, stale: staleSkillCount(skills, pkg), loading, refresh };
}

/** The header button: what it says when nothing is wrong, and when something is. */
export function AgentSkillsButton({ stale, onClick }: { stale: number; onClick: () => void }) {
  const t = useT();
  return (
    <Button
      variant={stale > 0 ? "subtle" : "ghost"}
      size="sm"
      onClick={onClick}
      title={t("The skill and hook graphify installs into your AI agents")}
    >
      <Plug className="h-3.5 w-3.5" /> {t("Agents")}
      {stale > 0 && (
        // the number alone would read as "Agents 2" to a screen reader
        <Badge tone="warn" aria-label={t("{n} outdated", { n: String(stale) })}>
          {stale}
        </Badge>
      )}
    </Button>
  );
}

const STANDING_TONE: Record<SkillStanding, "success" | "warn" | "neutral"> = {
  current: "success",
  stale: "warn",
  missing: "neutral",
  unknown: "neutral",
};

/** One agent: where its skill is, how it compares, and the button that fixes it. */
function SkillRow({
  skill,
  pkg,
  busy,
  onInstall,
}: {
  skill: AgentSkill;
  pkg: string | null;
  busy: boolean;
  onInstall: () => void;
}) {
  const t = useT();
  const standing = skillStanding(skill, pkg);
  // the word carries the state; the colour only repeats it
  const label: Record<SkillStanding, string> = {
    current: t("up to date"),
    stale: t("outdated"),
    missing: t("not installed"),
    unknown: t("version unknown"),
  };
  const action = standing === "missing" ? t("Install") : standing === "stale" ? t("Update") : t("Reinstall");

  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-soft bg-surface-2 px-2.5 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-text">{skill.label}</span>
          <Badge tone={STANDING_TONE[standing]}>{label[standing]}</Badge>
          {standing === "stale" && (
            <span className="font-mono text-[10px] text-text-3">
              {skill.version} → {pkg}
            </span>
          )}
        </div>
        <p className="truncate font-mono text-[10px] text-text-3 selectable" title={skill.dir}>
          {skill.dir}
        </p>
      </div>
      <Button
        variant={standing === "current" || standing === "unknown" ? "ghost" : "primary"}
        size="sm"
        loading={busy}
        onClick={onInstall}
      >
        {standing === "stale" ? <RefreshCw className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
        {action}
      </Button>
    </div>
  );
}

/**
 * An optional extractor, offered rather than reported: Assay cannot see inside
 * the installed package, so it never claims the extra is missing.
 */
function ExtraRow({
  extra,
  busy,
  onInstall,
}: {
  extra: { id: GraphifyExtra; label: string; files: string };
  busy: boolean;
  onInstall: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-soft bg-surface-2 px-2.5 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-text">{extra.label}</span>
        <p className="text-[11px] leading-relaxed text-text-3">
          {t(
            "Without it, {files} files are skipped in silence: they count as code, the run still succeeds, and nothing says they were never read.",
            { files: extra.files },
          )}
        </p>
      </div>
      <Button variant="secondary" size="sm" loading={busy} onClick={onInstall}>
        <Download className="h-3.5 w-3.5" /> {t("Install")}
      </Button>
    </div>
  );
}

/** What a confirmation is about: one agent's skill, or one extractor. */
type Pending =
  | { kind: "agent"; id: AgentPlatform; label: string }
  | { kind: "extra"; id: GraphifyExtra; label: string };

export function GraphifyAgentsDialog({
  open,
  onOpenChange,
  state,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  state: AgentSkillsState;
}) {
  const t = useT();
  const setError = useApp((s) => s.setError);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [plan, setPlan] = React.useState<InstallCommand | null | undefined>(undefined);

  // the extra's command depends on the machine's package manager, so it is
  // resolved when the confirmation opens; an agent's command never varies
  React.useEffect(() => {
    if (pending?.kind !== "extra") return;
    let ignore = false;
    setPlan(undefined);
    void detectInstallCommand([pending.id]).then((p) => {
      if (!ignore) setPlan(p);
    });
    return () => {
      ignore = true;
    };
  }, [pending]);

  const run = () => {
    if (!pending) return;
    const job =
      pending.kind === "agent"
        ? installAgentSkill(pending.id, () => {})
        : installGraphify(() => {}, [pending.id]);
    setBusy(pending.id);
    setPending(null);
    void job
      .then(() => state.refresh())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const command =
    pending?.kind === "agent" ? agentInstallTokens(pending.id).join(" ") : (plan?.tokens.join(" ") ?? "");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          title={t("Graphify on this machine")}
          desc={
            state.pkg
              ? t("graphify {version} is installed.", { version: state.pkg })
              : state.loading
                ? undefined // "could not read it" is not yet true while it is being read
                : t("Assay could not read graphify's version, so it cannot tell which skills are behind.")
          }
        >
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <h3 className="text-[13px] font-semibold text-text">{t("Agents")}</h3>
                <p className="text-[11px] leading-relaxed text-text-3">
                  {t(
                    "The skill and hook that teach an agent to ask the graph before it reads files. graphify installs one agent per run, and a skill already on disk does not update itself when the package does.",
                  )}
                </p>
              </div>
              {/* until the folders answer, every row would wrongly claim "not installed" */}
              {state.loading && !state.skills.length ? (
                <p className="text-[11px] text-text-3">{t("Checking what each agent has…")}</p>
              ) : (
                AGENT_PLATFORMS.map((p) => {
                  const known = state.skills.find((s) => s.id === p.id);
                  const skill: AgentSkill = known ?? {
                    id: p.id,
                    label: p.label,
                    dir: "",
                    installed: false,
                    version: null,
                  };
                  return (
                    <SkillRow
                      key={p.id}
                      skill={skill}
                      pkg={state.pkg}
                      busy={busy === p.id}
                      onInstall={() => setPending({ kind: "agent", id: p.id, label: p.label })}
                    />
                  );
                })
              )}
            </section>

            <section className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <h3 className="text-[13px] font-semibold text-text">{t("Language extractors")}</h3>
                <p className="text-[11px] leading-relaxed text-text-3">
                  {t("Languages whose extractor ships as a separate dependency of the graphify package.")}
                </p>
              </div>
              {GRAPHIFY_EXTRAS.map((x) => (
                <ExtraRow
                  key={x.id}
                  extra={x}
                  busy={busy === x.id}
                  onInstall={() => setPending({ kind: "extra", id: x.id, label: x.label })}
                />
              ))}
            </section>

            <p className="text-[11px] leading-relaxed text-text-3">
              {t("Both run from your home folder: nothing is written into the scanned project.")}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={
          pending?.kind === "extra"
            ? t("Install {name} support?", { name: pending.label })
            : t("Install the graphify skill for {agent}?", { agent: pending?.label ?? "" })
        }
        confirmLabel={t("Install")}
        confirmDisabled={pending?.kind === "extra" && !plan}
        body={
          <div className="flex flex-col gap-2">
            {pending?.kind === "extra" && plan === undefined && (
              <span>{t("Looking for a Python package manager…")}</span>
            )}
            {pending?.kind === "extra" && plan === null && (
              <span>
                {t("No Python package manager found (uv, pipx or pip). Install uv first, then try again.")}
              </span>
            )}
            {!!command && (
              <>
                <span>{t("Runs this command from your home folder:")}</span>
                <code className="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-2 selectable break-all">
                  {command}
                </code>
              </>
            )}
            {pending?.kind === "agent" && (
              <span className="text-text-3">
                {t(
                  "Writes the skill, and the hook that goes with it, into that agent's own config. It is safe to re-run.",
                )}
              </span>
            )}
            {pending?.kind === "extra" && (
              <span className="text-text-3">
                {t(
                  "Reinstalls the graphify package with that extractor included. The graph is not touched — rebuild it to pick those files up.",
                )}
              </span>
            )}
          </div>
        }
        onConfirm={run}
      />
    </>
  );
}
