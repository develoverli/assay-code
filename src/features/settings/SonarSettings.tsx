import { CheckCircle2, ExternalLink, Play, RefreshCw, Square, XCircle } from "lucide-react";
import * as React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as db from "@/lib/db";
import {
  SONAR_CONTAINER,
  containerState,
  getSonarConfig,
  removeServer,
  startServer,
  stopServer,
  systemStatus,
  waitUntilUp,
  type ContainerState,
  type SonarConfig,
  type SystemStatus,
} from "@/lib/sonar";
import { Badge, Button, Card, Field, Input, Spinner } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

interface State {
  container: ContainerState | null;
  status: SystemStatus | null;
}

type Busy = "start" | "stop" | "reset" | "check" | null;

const DEFAULT_PORT = "9000";

interface PanelProps {
  cfg: SonarConfig;
  state: State;
  busy: Busy;
  up: boolean;
  showSecrets: boolean;
  onToggleSecrets: () => void;
  patch: (p: Partial<SonarConfig>) => void;
  save: (key: string, value: string) => void;
  refresh: () => void;
  act: (kind: "start" | "stop" | "reset", fn: () => Promise<void>) => void;
}

/** Green when it is up, amber while it is on its way, grey otherwise. */
function badgeTone(up: boolean, pending: boolean): "success" | "warn" | "neutral" {
  if (up) return "success";
  return pending ? "warn" : "neutral";
}

/** Drop every trailing slash from a host so it can be joined with a path. */
function stripTrailingSlashes(host: string): string {
  let end = host.length;
  while (end > 0 && host[end - 1] === "/") end -= 1;
  return host.slice(0, end);
}

/** Container plus server state, and the buttons that move between them. */
function ContainerControls({
  cfg,
  state,
  busy,
  up,
  running,
  starting,
  refresh,
  act,
}: Pick<PanelProps, "cfg" | "state" | "busy" | "up" | "refresh" | "act"> & {
  running: boolean;
  starting: boolean;
}) {
  const t = useT();
  const containerTone = badgeTone(up, running);
  const statusTone = badgeTone(up, starting);
  let statusText = "…";
  if (state.status !== null) statusText = starting ? t("starting up") : t(state.status.toLowerCase());

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={containerTone}>
        {state.container === null ? "…" : t("container {state}", { state: t(state.container) })}
      </Badge>
      <Badge tone={statusTone}>{statusText}</Badge>
      <div className="ml-auto flex gap-1.5">
        <Button variant="ghost" size="sm" loading={busy === "check"} onClick={refresh}>
          <RefreshCw className="h-3.5 w-3.5" /> {t("Check")}
        </Button>
        {running ? (
          <Button variant="secondary" size="sm" loading={busy === "stop"} onClick={() => act("stop", stopServer)}>
            <Square className="h-3.5 w-3.5" /> {t("Stop")}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            loading={busy === "start"}
            onClick={() => act("start", async () => {
              await startServer(cfg.port || DEFAULT_PORT);
              // SonarQube needs about a minute after the container is up;
              // keep the button busy until it can actually answer
              await waitUntilUp(cfg.host);
            })}
          >
            <Play className="h-3.5 w-3.5" /> {t("Start")}
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={!up} onClick={() => void openUrl(cfg.host)}>
          <ExternalLink className="h-3.5 w-3.5" /> {t("Open")}
        </Button>
      </div>
    </div>
  );
}

/** The admin password Assay rotated and the analysis token it minted. */
function ManagedSecrets({
  cfg,
  showSecrets,
  onToggleSecrets,
  patch,
  save,
}: Pick<PanelProps, "cfg" | "showSecrets" | "onToggleSecrets" | "patch" | "save">) {
  const t = useT();
  const secretType = showSecrets ? "text" : "password";
  return (
    <>
      <Field
        label={t("Admin password")}
        hint={t(
          "Assay rotates the default admin/admin on first run and stores the new password here — use it to log into the web UI. Editable: if the container already had its own password, type it so Assay can mint tokens.",
        )}
      >
        <div className="flex gap-2">
          <Input
            type={secretType}
            value={cfg.adminPassword}
            onChange={(e) => patch({ adminPassword: e.target.value })}
            onBlur={() => save("sonar.adminPassword", cfg.adminPassword)}
            placeholder={t("(not set yet — defaults to admin/admin)")}
            className="font-mono text-xs"
          />
          <Button variant="ghost" size="sm" onClick={onToggleSecrets}>
            {showSecrets ? t("Hide") : t("Show")}
          </Button>
        </div>
        <p className="text-[11px] text-text-3">{t("User: admin")}</p>
      </Field>

      <Field
        label={t("Analysis token")}
        hint={t("Auto-generated. Clearing it makes Assay mint a new one on the next scan.")}
      >
        <div className="flex gap-2">
          <Input
            readOnly
            type={secretType}
            value={cfg.token || t("(not generated yet)")}
            className="font-mono text-xs"
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!cfg.token}
            onClick={() => {
              patch({ token: "" });
              save("sonar.token", "");
            }}
          >
            {t("Clear")}
          </Button>
        </div>
      </Field>
    </>
  );
}

/** The Docker container Assay provisions itself: lifecycle, admin password, token. */
function ManagedServer({ cfg, state, busy, up, showSecrets, onToggleSecrets, patch, save, refresh, act }: PanelProps) {
  const t = useT();
  const running = state.container === "running";
  /** Container is up but SonarQube hasn't finished booting — a real third state. */
  const starting = running && !up;

  return (
    <>
      <Field
        label={t("Port")}
        hint={t(
          "Published on localhost. The container is named {container}; its data lives in docker volumes, so history survives restarts.",
          { container: SONAR_CONTAINER },
        )}
      >
        <Input
          value={cfg.port}
          onChange={(e) => patch({ port: e.target.value.replace(/\D/g, "") })}
          onBlur={() => save("sonar.port", cfg.port || DEFAULT_PORT)}
          placeholder={DEFAULT_PORT}
          className="font-mono text-xs"
        />
      </Field>

      <ContainerControls
        cfg={cfg}
        state={state}
        busy={busy}
        up={up}
        running={running}
        starting={starting}
        refresh={refresh}
        act={act}
      />
      {starting && (
        <p className="text-[11px] text-warn">
          {t(
            "The container is running but SonarQube is still booting — it starts answering normally after about a minute. Re-check to see when it is up.",
          )}
        </p>
      )}
      <p className="text-[11px] text-text-3">
        {t(
          "You don't have to start it by hand — running the Sonar tool starts it and waits. First boot takes ~1-2 minutes and needs about 2 GB of RAM.",
        )}
      </p>

      <ManagedSecrets
        cfg={cfg}
        showSecrets={showSecrets}
        onToggleSecrets={onToggleSecrets}
        patch={patch}
        save={save}
      />

      <div className="flex items-center justify-between border-t border-border-soft pt-3">
        <p className="text-[11px] text-text-3">
          {t("Remove the container (analysis history is kept in its docker volumes).")}
        </p>
        <Button variant="ghost" size="sm" loading={busy === "reset"} onClick={() => act("reset", removeServer)}>
          {t("Remove container")}
        </Button>
      </div>
    </>
  );
}

/** A server the user already runs — self-hosted or SonarQube Cloud. */
function ExternalServer({
  cfg,
  state,
  busy,
  up,
  showSecrets,
  onToggleSecrets,
  patch,
  save,
  refresh,
}: Omit<PanelProps, "act">) {
  const t = useT();
  return (
    <>
      <Field label={t("Host")} hint={t("e.g. https://sonarqube.example.com or https://sonarcloud.io")}>
        <Input
          value={cfg.host}
          onChange={(e) => patch({ host: e.target.value })}
          onBlur={() => save("sonar.host", stripTrailingSlashes(cfg.host))}
          placeholder="https://sonarcloud.io"
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("Organization")}
        hint={t("SonarQube Cloud only — the organization key from its URL. Leave empty for a self-hosted server.")}
      >
        <Input
          value={cfg.organization}
          onChange={(e) => patch({ organization: e.target.value })}
          onBlur={() => save("sonar.organization", cfg.organization.trim())}
          placeholder="my-org"
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("Token")}
        hint={t("A user token with Execute Analysis permission. Stored locally in Assay.")}
      >
        <div className="flex gap-2">
          <Input
            type={showSecrets ? "text" : "password"}
            value={cfg.token}
            onChange={(e) => patch({ token: e.target.value })}
            onBlur={() => save("sonar.token", cfg.token.trim())}
            placeholder="squ_…"
            className="font-mono text-xs"
          />
          <Button variant="ghost" size="sm" onClick={onToggleSecrets}>
            {showSecrets ? t("Hide") : t("Show")}
          </Button>
        </div>
      </Field>
      <div className="flex items-center gap-2">
        <Badge tone={up ? "success" : "neutral"}>
          {state.status === null ? "…" : t(state.status.toLowerCase())}
        </Badge>
        <Button variant="ghost" size="sm" className="ml-auto" loading={busy === "check"} onClick={refresh}>
          <RefreshCw className="h-3.5 w-3.5" /> {t("Check")}
        </Button>
        <Button variant="ghost" size="sm" disabled={!cfg.host} onClick={() => void openUrl(cfg.host)}>
          <ExternalLink className="h-3.5 w-3.5" /> {t("Open")}
        </Button>
      </div>
      <p className="text-[11px] text-text-3">
        {t("The scanner still runs in Docker locally; only the server is remote.")}
      </p>
    </>
  );
}

const SERVER_MODES: { v: boolean; label: string; hint: string }[] = [
  { v: true, label: "Managed by Assay", hint: "Docker container, auto-provisioned" },
  { v: false, label: "External", hint: "your own server / SonarQube Cloud" },
];

/** Managed: the container exists and answers (or is merely stopped). External: reachable + a token. */
function isReady(cfg: SonarConfig, state: State, up: boolean): boolean {
  if (cfg.managed) return up || state.container === "stopped";
  return up && !!cfg.token;
}

/** Managed vs external picker. */
function ServerModePicker({ managed, onPick }: { managed: boolean; onPick: (v: boolean) => void }) {
  const t = useT();
  return (
    <Field label={t("Server")}>
      <div className="flex gap-2">
        {SERVER_MODES.map((m) => {
          const tone =
            managed === m.v
              ? "border-accent/40 bg-accent-soft text-accent"
              : "border-border text-text-2 hover:bg-surface-2";
          return (
            <button
              type="button"
              key={String(m.v)}
              onClick={() => onPick(m.v)}
              className={`flex-1 rounded-md border px-3 py-2.5 text-left text-xs cursor-pointer transition-colors ${tone}`}
            >
              <span className="block font-medium">{t(m.label)}</span>
              <span className="block text-[10px] text-text-3">{t(m.hint)}</span>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/** Header badge: ready / not ready. */
function ReadyBadge({ ready }: { ready: boolean }) {
  const t = useT();
  return (
    <span className={`flex items-center gap-1 text-xs ${ready ? "text-success" : "text-text-3"}`}>
      {ready ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      {ready ? t("ready") : t("not ready")}
    </span>
  );
}

export function SonarSettings() {
  const t = useT();
  const [cfg, setCfg] = React.useState<SonarConfig | null>(null);
  const [state, setState] = React.useState<State>({ container: null, status: null });
  const [busy, setBusy] = React.useState<Busy>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showSecrets, setShowSecrets] = React.useState(false);

  const load = React.useCallback(async () => {
    setCfg(await getSonarConfig());
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // never throws: a failed probe is shown under the card and the spinner always stops,
  // since the effect below and the Check buttons call it without awaiting
  const refresh = React.useCallback(async (c?: SonarConfig) => {
    setBusy((b) => b ?? "check");
    try {
      const conf = c ?? (await getSonarConfig());
      const [container, status] = await Promise.all([
        conf.managed ? containerState() : Promise.resolve<ContainerState | null>(null),
        conf.host ? systemStatus(conf.host) : Promise.resolve<SystemStatus>("UNREACHABLE"),
      ]);
      setState({ container, status });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  React.useEffect(() => {
    if (cfg) void refresh(cfg);
  }, [cfg?.managed, cfg?.host, cfg?.port]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (key: string, value: string) => {
    void (async () => {
      await db.setSetting(key, value);
      await load();
    })();
  };

  const patch = (p: Partial<SonarConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));

  const act = (kind: "start" | "stop" | "reset", fn: () => Promise<void>) => {
    void (async () => {
      setBusy(kind);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    })();
  };

  if (!cfg) {
    return (
      <Card className="mb-4 flex items-center gap-2 p-4 text-xs text-text-3">
        <Spinner className="h-3.5 w-3.5" /> {t("loading SonarQube settings…")}
      </Card>
    );
  }

  const up = state.status === "UP";
  const ready = isReady(cfg, state, up);
  const panel = {
    cfg,
    state,
    busy,
    up,
    showSecrets,
    onToggleSecrets: () => setShowSecrets((v) => !v),
    patch,
    save,
    refresh: () => void refresh(),
  };

  return (
    <Card className="mb-4 flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">SonarQube</h2>
        <ReadyBadge ready={ready} />
      </div>
      <p className="text-[11px] text-text-3">
        {t(
          "Sonar has no offline mode — the scanner uploads to a server that computes the issues. Assay can run that server for you in Docker, or use one you already have (self-hosted or SonarQube Cloud).",
        )}
      </p>

      <ServerModePicker
        managed={cfg.managed}
        onPick={(v) => {
          patch({ managed: v });
          save("sonar.managed", v ? "1" : "0");
        }}
      />

      {cfg.managed ? <ManagedServer {...panel} act={act} /> : <ExternalServer {...panel} />}

      {error && <p className="text-[11px] text-danger">{error}</p>}
    </Card>
  );
}
