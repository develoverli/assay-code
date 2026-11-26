import { openUrl } from "@tauri-apps/plugin-opener";
import { Copy, ExternalLink, Globe, Plus, RadioTower, Share2, Square, X } from "lucide-react";
import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Badge, Button, Spinner } from "@/components/ui/primitives";
import { ToolchainRow } from "@/features/settings/ToolchainCard";
import { writeClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { linkHost, parsePort, portRows, type PortRow } from "@/lib/ports";
import {
  currentOS,
  detectManagers,
  installRecipe,
  probeEntry,
  TOOLCHAIN,
  type InstallRecipe,
  type ToolchainStatus,
} from "@/lib/toolchain";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { usePorts, watchPorts } from "@/store/ports";

/**
 * Ports, in Workspace's dock: what this project is serving, plus ports added by
 * hand, each one a click from a public link. Every link confirms first, because
 * a quick tunnel has no password; it closes on Stop, when its port goes quiet,
 * or when Assay quits.
 */

const CLOUDFLARED = TOOLCHAIN.find((e) => e.id === "cloudflared");

/** Whether cloudflared is there, and the row that installs it when it is not. */
function useCloudflared(): {
  status: ToolchainStatus | undefined;
  recipe: InstallRecipe | null;
  recheck: () => Promise<void>;
} {
  const [status, setStatus] = React.useState<ToolchainStatus | undefined>(undefined);
  const [recipe, setRecipe] = React.useState<InstallRecipe | null>(null);

  const recheck = React.useCallback(async (refresh = true) => {
    if (!CLOUDFLARED) return;
    setStatus(await probeEntry(CLOUDFLARED, refresh));
  }, []);

  React.useEffect(() => {
    let ignore = false;
    void (async () => {
      if (!CLOUDFLARED) return;
      const [s, os, managers] = await Promise.all([probeEntry(CLOUDFLARED), currentOS(), detectManagers()]);
      if (ignore) return;
      setStatus(s);
      setRecipe(installRecipe("cloudflared", os, managers));
    })();
    return () => {
      ignore = true;
    };
  }, []);

  return { status, recipe, recheck: () => recheck(true) };
}

function PortLine({
  row,
  canShare,
  onShare,
  onRemove,
}: {
  row: PortRow;
  canShare: boolean;
  onShare: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const stop = usePorts((s) => s.stop);
  const dismiss = usePorts((s) => s.dismiss);
  const flagCopied = usePorts((s) => s.flagCopied);
  const copied = usePorts((s) => (row.tunnel ? s.copied === row.tunnel.id : false));
  const setError = useApp((s) => s.setError);
  const { listening, tunnel } = row;

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const copy = (id: string, url: string) => void writeClipboard(url).then(() => flagCopied(id), fail);

  let state = t("not listening");
  if (listening) state = listening.process ?? t("listening");
  const why =
    listening?.via === "output"
      ? t("A terminal of this project printed this address")
      : listening?.pid
        ? t("Process {pid}", { pid: listening.pid })
        : undefined;

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", listening ? "bg-success" : "bg-text-3/50")}
        />
        <span className="tnum font-mono text-[13px] font-medium text-text">:{row.port}</span>
        <span className={cn("min-w-0 flex-1 truncate text-[11px]", listening ? "text-text-3" : "text-text-3/80")} title={why}>
          {state}
          {row.manual && <span className="text-text-3/80"> · {t("added by hand")}</span>}
        </span>

        {!tunnel && (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={!listening || !canShare}
              // a disabled control says why (DESIGN.md)
              title={
                !listening
                  ? t("Nothing is listening on this port")
                  : !canShare
                    ? t("cloudflared is not installed.")
                    : undefined
              }
              onClick={onShare}
            >
              <Share2 className="h-3.5 w-3.5" /> {t("Share")}
            </Button>
            {row.manual && (
              <button
                type="button"
                onClick={onRemove}
                title={t("Remove port {port}", { port: row.port })}
                aria-label={t("Remove port {port}", { port: row.port })}
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        )}
      </div>

      {tunnel?.phase === "starting" && (
        <div className="flex items-center gap-2 pl-3.5 text-[11px] text-text-3">
          <Spinner className="h-3 w-3" />
          <span className="flex-1">{t("Opening the link…")}</span>
          <Button variant="ghost" size="sm" onClick={() => void stop(tunnel.id).catch(fail)}>
            {t("Cancel")}
          </Button>
        </div>
      )}

      {tunnel?.phase === "failed" && (
        <div className="flex flex-col gap-1.5 pl-3.5">
          <p className="text-[11px] text-danger">{t("The link could not be opened.")}</p>
          {tunnel.error && (
            <pre className="selectable max-h-28 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-text-3">
              {tunnel.error}
            </pre>
          )}
          <Button variant="ghost" size="sm" className="self-start" onClick={() => dismiss(tunnel.id)}>
            {t("Dismiss")}
          </Button>
        </div>
      )}

      {tunnel?.phase === "ready" && tunnel.url && (
        <div className="flex flex-col gap-1.5 pl-3.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge tone="warn" className="shrink-0 px-1.5 text-[10px]">
              <Globe className="h-3 w-3" /> {t("Public")}
            </Badge>
            <span className="selectable min-w-0 truncate font-mono text-[11px] text-text-2" title={tunnel.url}>
              {linkHost(tunnel.url)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => copy(tunnel.id, tunnel.url ?? "")}>
              <Copy className="h-3.5 w-3.5" /> {copied ? t("Link copied") : t("Copy")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void openUrl(tunnel.url ?? "").catch(fail)}>
              <ExternalLink className="h-3.5 w-3.5" /> {t("Open")}
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void stop(tunnel.id).catch(fail)}>
              <Square className="h-3 w-3" /> {t("Stop")}
            </Button>
          </div>
          {/* one announcement, said once, without moving focus */}
          <span role="status" aria-atomic="true" className="sr-only">
            {copied ? t("Link for port {port} copied", { port: row.port }) : ""}
          </span>
        </div>
      )}
    </li>
  );
}

function AddPort({ projectId }: { projectId: string }) {
  const t = useT();
  const addManual = usePorts((s) => s.addManual);
  const setError = useApp((s) => s.setError);
  const [text, setText] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  const inputId = React.useId();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const port = parsePort(text);
    if (port === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText("");
    void addManual(projectId, port).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1 border-t border-border px-3 py-2.5">
      <label htmlFor={inputId} className="text-[11px] text-text-3">
        {t("Something running outside Assay? Add its port.")}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          id={inputId}
          inputMode="numeric"
          placeholder="8080"
          value={text}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${inputId}-error` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (invalid) setInvalid(false);
          }}
          className={cn(
            "tnum h-7 w-24 rounded-md border bg-surface-2 px-2 font-mono text-[12px] text-text placeholder:text-text-3",
            "focus-visible:outline-2 focus-visible:outline-accent",
            invalid ? "border-danger" : "border-border",
          )}
        />
        <Button variant="secondary" size="sm" type="submit" disabled={!text.trim()}>
          <Plus className="h-3.5 w-3.5" /> {t("Add port")}
        </Button>
      </div>
      {invalid && (
        <p id={`${inputId}-error`} className="text-[11px] text-danger">
          {t("A port is a number from 1 to 65535.")}
        </p>
      )}
    </form>
  );
}

export function PortsPanel({ projectId }: { projectId: string }) {
  const t = useT();
  const setError = useApp((s) => s.setError);
  const { listening, scanned, tunnels, manual } = usePorts(
    useShallow((s) => ({ listening: s.listening, scanned: s.scanned, tunnels: s.tunnels, manual: s.manual[projectId] })),
  );
  const loadManual = usePorts((s) => s.loadManual);
  const share = usePorts((s) => s.share);
  const removeManual = usePorts((s) => s.removeManual);
  const cloudflared = useCloudflared();
  const [asking, setAsking] = React.useState<PortRow | null>(null);

  React.useEffect(() => watchPorts(), []);
  React.useEffect(() => {
    void loadManual(projectId).catch(() => undefined);
  }, [loadManual, projectId]);

  const rows = React.useMemo(
    () => portRows(projectId, listening, manual ?? [], tunnels),
    [projectId, listening, manual, tunnels],
  );
  const installed = cloudflared.status?.installed === true;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {cloudflared.status?.installed === false && CLOUDFLARED && (
          <div className="border-b border-border px-3 py-2.5">
            <p className="text-[12px] leading-relaxed text-text-2">
              {t("Links are opened with cloudflared, a free Cloudflare tool that needs no account. It is not on this machine yet.")}
            </p>
            <ToolchainRow
              entry={CLOUDFLARED}
              status={cloudflared.status}
              running={false}
              recipe={cloudflared.recipe}
              onRecheck={cloudflared.recheck}
            />
          </div>
        )}

        {!scanned && (
          <p className="flex items-center gap-2 px-3 py-4 text-[12px] text-text-3">
            <Spinner className="h-3.5 w-3.5" /> {t("Looking for ports…")}
          </p>
        )}

        {scanned && rows.length === 0 && (
          <div className="flex flex-col gap-1.5 px-3 py-4 text-[12px] text-text-2">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-text">
              <RadioTower className="h-4 w-4 text-text-3" /> {t("Nothing running in this project")}
            </p>
            <p className="leading-relaxed">
              {t("Start something from the project — a dev server, an API — in a Workspace terminal, and its port shows up here to share with a link.")}
            </p>
          </div>
        )}

        {rows.length > 0 && (
          <ul className="flex flex-col divide-y divide-border-soft">
            {rows.map((row) => (
              <PortLine
                key={row.port}
                row={row}
                canShare={installed}
                onShare={() => setAsking(row)}
                onRemove={() => void removeManual(projectId, row.port).catch(fail)}
              />
            ))}
          </ul>
        )}
      </div>

      <AddPort projectId={projectId} />

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(o) => !o && setAsking(null)}
        title={t("Share port {port}?", { port: asking?.port ?? "" })}
        confirmLabel={t("Share")}
        body={
          asking && (
            <>
              <p>
                {t("{what} on this machine gets a public link at trycloudflare.com.", {
                  what: asking.listening?.process
                    ? `${asking.listening.process} (:${asking.port})`
                    : `:${asking.port}`,
                })}
              </p>
              <p className="mt-2 text-warn">
                {t("Anyone with the link can open it — there is no password. Do not share an admin panel or real data this way.")}
              </p>
              <p className="mt-2 text-text-3">
                {t("The link is copied when it is ready. It closes with Stop, when the port stops listening, or when you quit Assay.")}
              </p>
            </>
          )
        }
        onConfirm={() => {
          const row = asking;
          if (row) void share(projectId, row).catch(fail);
        }}
      />
    </div>
  );
}
