import { CheckCircle2, Copy, Play, RefreshCw, XCircle } from "lucide-react";
import * as React from "react";
import { resolveBin } from "@/lib/agent-bins";
import { startRuntime, waitForRuntime } from "@/lib/ai";
import * as db from "@/lib/db";
import { modelRef, probeAll, type Runtime, type RuntimeInfo } from "@/lib/local-models";
import { Badge, Button, Card, Field, Input } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

type Located = RuntimeInfo & { installed: boolean };

const MODELS_SHOWN = 8;

function runtimeBadge(t: ReturnType<typeof useT>, i: Located): string {
  if (i.online) return t("{n} models", { n: i.models.length });
  return i.installed ? t("installed, not running") : t("not installed");
}

/** Finds local runtimes, lists their models and hands over the reference each engine expects. */
export function LocalModels({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const [infos, setInfos] = React.useState<Located[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [urls, setUrls] = React.useState<{ ollama: string; lmstudio: string }>({ ollama: "", lmstudio: "" });
  const [copied, setCopied] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState<Runtime | null>(null);
  const [startError, setStartError] = React.useState<string | null>(null);

  const scan = React.useCallback(async (o?: { ollama: string; lmstudio: string }) => {
    setBusy(true);
    try {
      // a server that is off is not the same as a runtime that is not there
      const [found, ollama, lms] = await Promise.all([
        probeAll({ ollama: o?.ollama || undefined, lmstudio: o?.lmstudio || undefined }),
        resolveBin("ollama", true),
        resolveBin("lms", true),
      ]);
      setInfos(
        found.map((i) => ({
          ...i,
          installed: i.online || (i.runtime === "ollama" ? !!ollama.command : !!lms.command),
        })),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const start = (runtime: Runtime) => {
    setStarting(runtime);
    setStartError(null);
    void (async () => {
      await startRuntime(runtime);
      if (!(await waitForRuntime(runtime))) {
        setStartError(t("Started, but it is not answering yet. Re-check in a moment."));
      }
    })()
      .catch((e: unknown) => setStartError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setStarting(null);
        void scan(urls).then(() => onChanged?.());
      });
  };

  React.useEffect(() => {
    void Promise.all([db.getSetting("local.ollamaUrl"), db.getSetting("local.lmstudioUrl")]).then(([a, b]) => {
      const next = { ollama: a ?? "", lmstudio: b ?? "" };
      setUrls(next);
      void scan(next);
    });
  }, [scan]);

  const saveUrl = (k: "ollama" | "lmstudio", v: string) => {
    setUrls((u) => ({ ...u, [k]: v }));
    void db.setSetting(k === "ollama" ? "local.ollamaUrl" : "local.lmstudioUrl", v);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard blocked — the value is selectable in place */
    }
  };

  const anyOnline = infos?.some((i) => i.online);

  let probeState = t("none running");
  if (infos === null) probeState = t("checking…");
  else if (anyOnline) probeState = t("detected");

  return (
    <Card className="mb-4 flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">{t("Local models")}</h2>
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1 text-xs ${anyOnline ? "text-success" : "text-text-3"}`}>
            {anyOnline ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {probeState}
          </span>
          <Button variant="ghost" size="sm" loading={busy} onClick={() => void scan(urls)}>
            <RefreshCw className="h-3.5 w-3.5" /> {t("Re-check")}
          </Button>
        </div>
      </div>

      <p className="text-[11px] text-text-3">
        {t(
          "Ollama and LM Studio serve model completions over HTTP; they can't read or edit files. Assay calls them directly for the commit message and “Improve with AI”, which are one prompt in and one answer out. To fix code with one, configure it in opencode: its models then show up in every AI picker.",
        )}
      </p>
      {startError && <p className="text-[11px] text-danger">{startError}</p>}

      {(infos ?? []).map((i) => (
        <div key={i.runtime} className="rounded-md border border-border bg-surface-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{i.label}</span>
              <Badge tone={i.online ? "success" : "neutral"}>
                {runtimeBadge(t, i)}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {!i.online && i.installed && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={starting === i.runtime}
                  disabled={starting !== null}
                  onClick={() => start(i.runtime)}
                >
                  <Play className="h-3.5 w-3.5" /> {t("Start")}
                </Button>
              )}
              <span className="font-mono text-[10px] text-text-3 selectable">{i.url}</span>
            </div>
          </div>

          {!i.online && (
            <p className="mt-2 text-[11px] text-text-3">
              {i.installed ? t("Installed, but its server is not answering.") : t("Not reachable.")} {i.hint}
            </p>
          )}
          {i.online && i.models.length === 0 && (
            <p className="mt-2 text-[11px] text-text-3">
              {t("Running, but no model is loaded.")} {i.hint}
            </p>
          )}
          {i.online && i.models.length > 0 && (
            <div className="mt-2.5 flex flex-col gap-1">
              {i.models.slice(0, MODELS_SHOWN).map((m) => {
                const ref = modelRef(i.runtime, m);
                return (
                  <div key={m} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-2" title={m}>
                      {m}
                    </span>
                    <button
                      type="button"
                      onClick={() => void copy(ref)}
                      title={t("Copy \"{ref}\" for the engine's Model field", { ref })}
                      aria-label={t("Copy model reference for {model}", { model: m })}
                      className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-text-3 hover:bg-surface hover:text-text-2 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <Copy className="h-3 w-3" />
                      {copied === ref ? t("copied") : ref}
                    </button>
                  </div>
                );
              })}
              {i.models.length > MODELS_SHOWN && (
                <span className="text-[10px] text-text-3">{t("+{n} more", { n: i.models.length - MODELS_SHOWN })}</span>
              )}
            </div>
          )}

          <Field label="" hint="">
            <Input
              className="mt-2.5 font-mono text-xs"
              placeholder={t("custom URL (default {url})", { url: i.url })}
              value={urls[i.runtime]}
              onChange={(e) => saveUrl(i.runtime, e.target.value)}
              onBlur={() => void scan(urls)}
              aria-label={t("{runtime} base URL", { runtime: i.label })}
            />
          </Field>
        </div>
      ))}

      <p className="text-[11px] text-text-3">
        {t("Strix takes the same endpoint in its own Base URL field above — use")}
        <span className="font-mono"> {infos?.find((i) => i.runtime === "lmstudio")?.url ?? "http://localhost:1234"}/v1</span>{" "}
        {t("for an OpenAI-compatible server.")}
      </p>
    </Card>
  );
}
