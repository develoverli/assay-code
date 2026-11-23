import { Download, RefreshCw, Trash2 } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import {
  ensureNodeSandbox,
  ensureRuff,
  invalidateNodeSandbox,
  removeSandbox,
  sandboxStatus,
  type SandboxStatus,
} from "@/lib/sandbox";
import { eslintPackages } from "@/lib/tool-options";
import { Button, Card, Spinner } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

/** Repair, update or remove the ESLint/Ruff sandbox that scans install on their own. */
export function LinterSandbox() {
  const tools = useApp((s) => s.tools);
  const setError = useApp((s) => s.setError);
  const t = useT();
  const [status, setStatus] = React.useState<SandboxStatus | null>(null);
  const [busy, setBusy] = React.useState<null | "install" | "remove">(null);
  const [log, setLog] = React.useState<string>("");

  const refresh = React.useCallback(() => {
    sandboxStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  React.useEffect(refresh, [refresh]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const tail = (chunk: string) => setLog((cur) => (cur + chunk).split("\n").slice(-4).join("\n"));

  const install = () => {
    setBusy("install");
    setLog("");
    const eslint = tools.find((t) => t.id === "eslint");
    void (async () => {
      await invalidateNodeSandbox();
      if (eslint) await ensureNodeSandbox(eslintPackages(eslint), tail);
      await ensureRuff(tail);
    })()
      .catch(fail)
      .finally(() => {
        setBusy(null);
        refresh();
      });
  };

  const wipe = () => {
    setBusy("remove");
    setLog("");
    void removeSandbox()
      .catch(fail)
      .finally(() => {
        setBusy(null);
        refresh();
      });
  };

  const eslintLine = status?.eslintInstalled
    ? `ESLint ${status.eslintVersion ?? t("installed")} · ${t("via {pm}", { pm: status.packageManager })}`
    : t("ESLint not installed yet — the first ESLint run installs it");
  const ruffFrom = status?.ruffSource === "PATH" ? t("your own install on PATH") : t("downloaded by Assay");
  const ruffLine = status?.ruffSource
    ? `${status.ruffVersion ?? "Ruff"} · ${ruffFrom}`
    : t("Ruff not present yet — the first Ruff run fetches it");

  return (
    <Card className="mb-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">{t("Linters")}</h2>
          <p className="text-[11px] text-text-3">
            {t(
              "Assay keeps its own ESLint and Ruff outside your projects, so a scan never adds a config, a dependency or a lockfile to the code it audits.",
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" size="sm" loading={busy === "install"} onClick={install}>
            {status?.eslintInstalled ? <RefreshCw className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
            {status?.eslintInstalled ? t("Reinstall") : t("Install")}
          </Button>
          <Button variant="danger" size="sm" loading={busy === "remove"} onClick={wipe}>
            <Trash2 className="h-3.5 w-3.5" /> {t("Uninstall")}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-1 text-[11px] text-text-2">
        {!status ? (
          <span className="flex items-center gap-2 text-text-3">
            <Spinner /> {t("checking…")}
          </span>
        ) : (
          <>
            <span className="font-mono">{eslintLine}</span>
            <span className="font-mono">{ruffLine}</span>
            <span className="truncate font-mono text-[10px] text-text-3" title={status.root}>
              {status.root}
            </span>
          </>
        )}
      </div>

      {log && (
        <pre className="mt-3 max-h-24 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-[10px] text-text-3 selectable">
          {log}
        </pre>
      )}
    </Card>
  );
}
