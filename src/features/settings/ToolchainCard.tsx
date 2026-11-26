import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, Copy, Download, ExternalLink, FolderSearch, Play, RefreshCw, XCircle } from "lucide-react";
import * as React from "react";
import { customPathKey } from "@/lib/agent-bins";
import { startRuntime, waitForRuntime } from "@/lib/ai";
import { writeClipboard } from "@/lib/clipboard";
import * as db from "@/lib/db";
import {
  currentOS,
  detectManagers,
  installRecipe,
  runInstall,
  TOOLCHAIN,
  type InstallRecipe,
  type Managers,
  type OS,
  type ToolchainEntry,
  type ToolchainId,
  type ToolchainStatus,
} from "@/lib/toolchain";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Button, Card, Input, Spinner } from "@/components/ui/primitives";
import { Terminal } from "@/components/ui/terminal";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type ToolchainStatuses = Partial<Record<ToolchainId, ToolchainStatus>>;

/** Own-key read, so an id is never used to index an object directly. */
function statusOf(statuses: ToolchainStatuses, id: ToolchainId): ToolchainStatus | undefined {
  for (const [k, v] of Object.entries(statuses)) if (k === id) return v;
  return undefined;
}

function flagOf(flags: Partial<Record<string, boolean>>, id: string): boolean {
  for (const [k, v] of Object.entries(flags)) if (k === id) return !!v;
  return false;
}

function installOutcome(t: ReturnType<typeof useT>, ok: boolean, installed: boolean): string {
  if (!ok) return t("The install failed. The output above says why.");
  if (installed) return t("Installed.");
  return t("The installer finished, but Assay cannot see the binary yet — restart Assay, or set its path.");
}

interface InstallLog {
  command: string;
  output: string;
  /** null while running. */
  ok: boolean | null;
}

/** Path to a binary Assay could not find on its own. */
function CustomPathDialog({
  entry,
  open,
  onOpenChange,
  onSaved,
}: {
  entry: ToolchainEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [value, setValue] = React.useState("");

  React.useEffect(() => {
    if (!open || !entry.bin) return;
    void db.getSetting(customPathKey(entry.bin)).then((v) => setValue(v ?? ""));
  }, [open, entry.bin]);

  const save = (next: string) => {
    if (!entry.bin) return;
    void db.setSetting(customPathKey(entry.bin), next.trim()).then(() => {
      onOpenChange(false);
      onSaved();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("Path to {tool}", { tool: entry.label })}
        desc={t("Only needed when Assay cannot find it on PATH or where its installer usually puts it.")}
      >
        <Input
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          placeholder="C:\\Users\\me\\.opencode\\bin\\opencode.exe"
          aria-label={t("Path to {tool}", { tool: entry.label })}
          className="font-mono text-xs"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => save("")}>
            {t("Clear")}
          </Button>
          <Button variant="primary" onClick={() => save(value)}>
            {t("Save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One tool: found or missing, and the way to install it. Workspace › Ports reuses it for cloudflared. */
export function ToolchainRow({
  entry,
  status,
  running,
  recipe,
  onRecheck,
}: {
  entry: ToolchainEntry;
  status: ToolchainStatus | undefined;
  /** Only meaningful for runtimes. */
  running: boolean;
  recipe: InstallRecipe | null;
  onRecheck: () => Promise<void>;
}) {
  const t = useT();
  const [asking, setAsking] = React.useState(false);
  const [log, setLog] = React.useState<InstallLog | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [pathOpen, setPathOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const install = (tokens: string[]) => {
    const command = tokens.join(" ");
    setLog({ command, output: "", ok: null });
    const { result } = runInstall(tokens, (chunk) =>
      setLog((cur) => (cur ? { ...cur, output: cur.output + chunk } : cur)),
    );
    void result
      .then((res) => setLog((cur) => (cur ? { ...cur, ok: res.code === 0 } : cur)))
      .catch((e: unknown) =>
        setLog((cur) =>
          cur ? { ...cur, ok: false, output: `${cur.output}\n${e instanceof Error ? e.message : String(e)}` } : cur,
        ),
      )
      .finally(() => void onRecheck());
  };

  const start = () => {
    if (!entry.runtime) return;
    const runtime = entry.runtime;
    setStarting(true);
    setStartError(null);
    void (async () => {
      await startRuntime(runtime);
      if (!(await waitForRuntime(runtime))) {
        setStartError(t("Started, but it is not answering yet. Re-check in a moment."));
      }
    })()
      .catch((e: unknown) => setStartError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setStarting(false);
        void onRecheck();
      });
  };

  const copyCommand = (command: string) => {
    void writeClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const installed = status?.installed;
  const installing = log?.ok === null;

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-[180px] flex-1">
          <p className="text-[13px] font-medium">{entry.label}</p>
          <p className="text-[11px] text-text-3">{t(entry.hint)}</p>
          {status?.path && (
            <p className="truncate font-mono text-[10px] text-text-3 selectable" title={status.path}>
              {status.path}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 text-xs">
          {status === undefined && (
            <span className="flex items-center gap-1.5 text-text-3">
              <Spinner className="h-3.5 w-3.5" /> {t("checking…")}
            </span>
          )}

          {installed && entry.runtime && !running && (
            <>
              <span className="text-warn">{t("installed, not running")}</span>
              <Button variant="secondary" size="sm" loading={starting} onClick={start}>
                <Play className="h-3.5 w-3.5" /> {t("Start")}
              </Button>
            </>
          )}
          {installed && (!entry.runtime || running) && (
            <span className="flex items-center gap-1 text-success">
              <CheckCircle2 className="h-4 w-4" /> {entry.runtime ? t("running") : t("found")}
            </span>
          )}

          {installed === false && (
            <>
              <span className="flex items-center gap-1 text-danger">
                <XCircle className="h-4 w-4" /> {t("missing")}
              </span>
              {recipe?.kind === "command" && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={installing}
                  onClick={() => setAsking(true)}
                  title={recipe.tokens.join(" ")}
                >
                  <Download className="h-3.5 w-3.5" /> {t("Install")}
                </Button>
              )}
              {recipe?.kind === "manual" && (
                <>
                  {recipe.command && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => recipe.command && copyCommand(recipe.command)}
                      title={recipe.command}
                    >
                      <Copy className="h-3.5 w-3.5" /> {copied ? t("copied") : t("Copy command")}
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => void openUrl(recipe.url)} title={recipe.url}>
                    <ExternalLink className="h-3.5 w-3.5" /> {t("How to install")}
                  </Button>
                </>
              )}
            </>
          )}

          {entry.bin && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setPathOpen(true)}
              aria-label={t("Set the path to {tool}", { tool: entry.label })}
              title={t("Set the path to {tool}", { tool: entry.label })}
            >
              <FolderSearch className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {startError && <p className="mt-1.5 text-[11px] text-danger">{startError}</p>}

      {log && (
        <div className="mt-2">
          {/* the shared log surface: winget and npm draw progress bars in ANSI */}
          <Terminal text={`$ ${log.command}\n${log.output}`} className="max-h-40 p-2 text-[11px]" />
          {log.ok !== null && (
            <p className={cn("mt-1.5 text-[11px]", log.ok ? "text-success" : "text-danger")}>
              {installOutcome(t, log.ok, !!installed)}
            </p>
          )}
        </div>
      )}

      {recipe?.kind === "command" && (
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          title={t("Install {tool}?", { tool: entry.label })}
          confirmLabel={t("Install")}
          body={
            <div className="flex flex-col gap-2">
              <span>{t("Runs this command, with the package manager already on this machine:")}</span>
              <code className="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-2 selectable break-all">
                {recipe.tokens.join(" ")}
              </code>
              <span className="text-text-3">
                {t("Nothing is written into your project, and no install script is piped into a shell.")}
              </span>
            </div>
          }
          onConfirm={() => install(recipe.tokens)}
        />
      )}

      <CustomPathDialog entry={entry} open={pathOpen} onOpenChange={setPathOpen} onSaved={() => void onRecheck()} />
    </div>
  );
}

/** What Assay found on the machine — the reason a tool or engine is unavailable, and the way out. */
export function ToolchainCard({
  statuses,
  running,
  probing,
  onRecheck,
  onRecheckOne,
}: {
  statuses: ToolchainStatuses;
  /** Which runtimes are answering, by toolchain id. */
  running: Partial<Record<ToolchainId, boolean>>;
  probing: boolean;
  onRecheck: () => void;
  onRecheckOne: (id: ToolchainId) => Promise<void>;
}) {
  const t = useT();
  const [os, setOs] = React.useState<OS | null>(null);
  const [managers, setManagers] = React.useState<Managers | null>(null);

  React.useEffect(() => {
    let ignore = false;
    void Promise.all([currentOS(), detectManagers()]).then(([o, m]) => {
      if (ignore) return;
      setOs(o);
      setManagers(m);
    });
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[13px] font-semibold">{t("Toolchain")}</h2>
          <p className="text-[11px] text-text-3">
            {t("Found on PATH or where its installer usually puts it. Missing ones can be installed from here when a package manager can do it.")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            // a package manager installed since the last look counts too
            void detectManagers(true).then(setManagers);
            onRecheck();
          }}
          loading={probing}
        >
          <RefreshCw className="h-3.5 w-3.5" /> {t("Re-check")}
        </Button>
      </div>
      <div className="flex flex-col divide-y divide-border-soft">
        {TOOLCHAIN.map((entry) => (
          <ToolchainRow
            key={entry.id}
            entry={entry}
            status={statusOf(statuses, entry.id)}
            running={flagOf(running, entry.id)}
            recipe={os && managers ? installRecipe(entry.id, os, managers) : null}
            onRecheck={() => onRecheckOne(entry.id)}
          />
        ))}
      </div>
    </Card>
  );
}
