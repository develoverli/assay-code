import * as Tabs from "@radix-ui/react-tabs";
import { Bot, RotateCcw, ShieldCheck, SlidersHorizontal, Sparkles } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import { runOnce } from "@/lib/exec";
import { probeEntry, TOOLCHAIN, type ToolchainId } from "@/lib/toolchain";
import * as db from "@/lib/db";
import { Button, Card, Field, Input } from "@/components/ui/primitives";
import { ViewHeader } from "@/components/layout/ViewHeader";
import { cn } from "@/lib/utils";
import { useAIInventory } from "@/features/shared/AIPicker";
import { AITasksCard } from "./AITasksCard";
import { ToolchainCard, type ToolchainStatuses } from "./ToolchainCard";
import { SonarSettings } from "./SonarSettings";
import { LocalModels } from "./LocalModels";
import { LinterSandbox } from "./LinterSandbox";
import { LanguageCard } from "./LanguageCard";
import { BenchShell } from "./BenchShell";
import { BackgroundCard } from "./BackgroundCard";
import { DataCard } from "./DataCard";
import { GitHubCard } from "@/features/github/GitHubCard";
import { UpdatesCard } from "@/features/settings/UpdatesCard";
import { useT } from "@/lib/i18n";

/**
 * Deleted built-ins leave a tombstone so seeding stops reviving them. This is
 * the way back: it clears every tombstone and re-seeds in one go.
 */
function BuiltinTools() {
  const removed = useApp((s) => s.removedBuiltins);
  const restoreBuiltins = useApp((s) => s.restoreBuiltins);
  const setError = useApp((s) => s.setError);
  const t = useT();
  const [busy, setBusy] = React.useState(false);
  if (!removed.length) return null;
  return (
    <Card className="mb-4 flex items-center justify-between gap-4 p-4">
      <div>
        <h2 className="text-[13px] font-semibold">{t("Built-in tools")}</h2>
        <p className="text-[11px] text-text-3">
          {t("{n} removed:", { n: removed.length })} <span className="font-mono">{removed.join(", ")}</span>.{" "}
          {t("Restoring brings them back with their original command and prompt.")}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        loading={busy}
        onClick={() => {
          setBusy(true);
          restoreBuiltins()
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      >
        <RotateCcw className="h-3.5 w-3.5" /> {t("Restore")}
      </Button>
    </Card>
  );
}

type ToolStatus = Record<string, boolean | null>;

const STRIX_MODES: { v: string; label: string }[] = [
  { v: "quick", label: "Quick" },
  { v: "standard", label: "Standard (deep)" },
];

/** Reuse an API key already present in the environment (set via system env or before launch). */
async function detectEnvKey(): Promise<string | undefined> {
  try {
    const r = await runOnce(
      `node -e "const k=['LLM_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','GEMINI_API_KEY']; const o={}; k.forEach(x=>{if(process.env[x])o[x]=process.env[x]}); console.log(JSON.stringify(o))"`,
    );
    // first "{" to last "}" by index: `/\{[\s\S]*\}/` backtracks quadratically
    const open = r.stdout.indexOf("{");
    const close = r.stdout.lastIndexOf("}");
    const found = JSON.parse(open >= 0 && close > open ? r.stdout.slice(open, close + 1) : "{}");
    return Object.values(found)[0] as string | undefined;
  } catch {
    return undefined;
  }
}

const mark = (ok: unknown) => (ok ? "✓" : "✕");

/** What is still missing before strix can run. */
function StrixRequirements({ status, llm, apiKey }: { status: ToolStatus; llm: string; apiKey: string }) {
  const t = useT();
  return (
    <p className="text-[11px] text-text-3">
      {t("Needs:")} docker {mark(status.docker)} · strix {mark(status.strix)} · {t("model")}{" "}
      {mark(llm)} · {t("key")} {mark(apiKey)}. {t("Restart Assay after installing tools.")}
    </p>
  );
}

/** Everything the strix agent needs before it can be launched from Tools. */
function StrixCard({ status, models }: { status: ToolStatus; models: string[] }) {
  const t = useT();
  const [strixLlm, setStrixLlm] = React.useState("");
  const [strixKey, setStrixKey] = React.useState("");
  const [strixBase, setStrixBase] = React.useState("");
  const [strixMode, setStrixMode] = React.useState("quick");
  const [detecting, setDetecting] = React.useState(false);
  const [showKey, setShowKey] = React.useState(false);

  React.useEffect(() => {
    let ignore = false;
    void Promise.all([
      db.getSetting("strix.llm"),
      db.getSetting("strix.apiKey"),
      db.getSetting("strix.baseUrl"),
      db.getSetting("strix.scanMode"),
    ]).then(([llm, apiKey, base, mode]) => {
      if (ignore) return;
      setStrixLlm(llm ?? "");
      setStrixKey(apiKey ?? "");
      setStrixBase(base ?? "");
      setStrixMode(mode || "quick");
    });
    return () => {
      ignore = true;
    };
  }, []);

  const saveStrixLlm = (v: string) => {
    setStrixLlm(v);
    void db.setSetting("strix.llm", v);
  };
  const saveStrixKey = (v: string) => {
    setStrixKey(v);
    void db.setSetting("strix.apiKey", v);
  };
  const saveStrixBase = (v: string) => {
    setStrixBase(v);
    void db.setSetting("strix.baseUrl", v);
  };
  const saveStrixMode = (v: string) => {
    setStrixMode(v);
    void db.setSetting("strix.scanMode", v);
  };

  const detectKey = async () => {
    setDetecting(true);
    try {
      const first = await detectEnvKey();
      if (first) saveStrixKey(first);
    } finally {
      setDetecting(false);
    }
  };

  const strixReady = !!status.docker && !!status.strix && !!strixLlm && !!strixKey;

  return (
    <Card className="mb-4 flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">{t("Strix (AI pentest)")}</h2>
        <span className={`flex items-center gap-1 text-xs ${strixReady ? "text-success" : "text-text-3"}`}>
          <ShieldCheck className="h-4 w-4" /> {strixReady ? t("ready") : t("not ready")}
        </span>
      </div>
      <Field
        label={t("Scan depth")}
        hint={t("Quick = fast, fewer probes. Standard = deeper/complete, longer & more model calls.")}
      >
        <div className="flex gap-2">
          {STRIX_MODES.map((m) => (
            <button
              type="button"
              key={m.v}
              onClick={() => saveStrixMode(m.v)}
              className={`flex-1 rounded-md border px-3 py-2 text-xs cursor-pointer transition-colors ${
                strixMode === m.v ? "border-accent/40 bg-accent-soft text-accent" : "border-border text-text-2 hover:bg-surface-2"
              }`}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
      </Field>
      <Field
        label={t("LLM model (STRIX_LLM)")}
        htmlFor="strix-llm"
        hint={t("Reuse a model you already configured in opencode, or type one (format provider/model).")}
      >
        <input
          id="strix-llm"
          list="strix-models"
          value={strixLlm}
          onChange={(e) => saveStrixLlm(e.target.value)}
          placeholder="openai/gpt-4o"
          className="h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 font-mono text-xs text-text placeholder:text-text-3 focus-visible:border-accent focus-visible:outline-none"
        />
        <datalist id="strix-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>
      <Field
        label={t("API key (LLM_API_KEY)")}
        hint={t("Stored locally in Assay. Or reuse one from your environment.")}
      >
        <div className="flex gap-2">
          <Input
            type={showKey ? "text" : "password"}
            value={strixKey}
            onChange={(e) => saveStrixKey(e.target.value)}
            placeholder="sk-…"
            className="font-mono text-xs"
          />
          <Button variant="ghost" size="sm" onClick={() => setShowKey((v) => !v)}>
            {showKey ? t("Hide") : t("Show")}
          </Button>
          <Button variant="secondary" size="sm" loading={detecting} onClick={detectKey}>
            {t("Detect")}
          </Button>
        </div>
      </Field>
      <Field
        label={t("Base URL (optional)")}
        hint={t(
          "OpenAI-compatible endpoint. For LM Studio use http://localhost:1234/v1 with STRIX_LLM=openai/<model>. Leave empty for hosted providers.",
        )}
      >
        <Input
          value={strixBase}
          onChange={(e) => saveStrixBase(e.target.value)}
          placeholder="http://localhost:1234/v1"
          className="font-mono text-xs"
        />
      </Field>
      {!strixReady && <StrixRequirements status={status} llm={strixLlm} apiKey={strixKey} />}
    </Card>
  );
}

export function SettingsView() {
  const t = useT();
  const { inventory, loading: detecting, refresh: refreshInventory } = useAIInventory();
  const [statuses, setStatuses] = React.useState<ToolchainStatuses>({});
  const [probing, setProbing] = React.useState(false);

  const runProbes = React.useCallback(async (refresh = false) => {
    setProbing(true);
    try {
      const pairs = await Promise.all(TOOLCHAIN.map(async (e) => [e.id, await probeEntry(e, refresh)] as const));
      setStatuses(Object.fromEntries(pairs));
    } finally {
      setProbing(false);
    }
  }, []);

  // one tool after an install, a Start or a typed path — and the pickers learn it too
  const recheckOne = React.useCallback(
    async (id: ToolchainId) => {
      const entry = TOOLCHAIN.find((e) => e.id === id);
      if (!entry) return;
      const next = await probeEntry(entry, true);
      setStatuses((cur) => ({ ...cur, [id]: next }));
      await refreshInventory();
    },
    [refreshInventory],
  );

  React.useEffect(() => {
    void runProbes();
  }, [runProbes]);

  const status: ToolStatus = {
    docker: statuses.docker?.installed ?? null,
    strix: statuses.strix?.installed ?? null,
  };
  const running: Partial<Record<ToolchainId, boolean>> = {
    ollama: !!inventory?.runtimes.find((r) => r.runtime === "ollama")?.online,
    lmstudio: !!inventory?.runtimes.find((r) => r.runtime === "lmstudio")?.online,
  };

  // grouped by what you came to change: the app, the AI, the tools
  const sections = [
    {
      id: "general",
      label: t("General"),
      icon: SlidersHorizontal,
      body: (
        <>
          <LanguageCard />
          <GitHubCard />
          <BackgroundCard />
          <UpdatesCard />
          <DataCard />
        </>
      ),
    },
    {
      id: "ai",
      label: t("AI"),
      icon: Sparkles,
      body: (
        <>
          <AITasksCard inventory={inventory} loading={detecting} onRefresh={refreshInventory} />
          <LocalModels onChanged={() => void refreshInventory()} />
          <StrixCard status={status} models={inventory?.opencodeModels ?? []} />
        </>
      ),
    },
    {
      id: "tools",
      label: t("Tools"),
      icon: Bot,
      body: (
        <>
          <LinterSandbox />
          <SonarSettings />
          <BenchShell />
          <BuiltinTools />
          <ToolchainCard
            statuses={statuses}
            running={running}
            probing={probing}
            onRecheck={() => {
              void runProbes(true);
              void refreshInventory();
            }}
            onRecheckOne={recheckOne}
          />
        </>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-3xl p-5">
      <ViewHeader
        title={t("Settings")}
        subtitle={t("Language, AI engine, tool configuration and local toolchain.")}
      />

      <Tabs.Root defaultValue="general">
        <Tabs.List
          aria-label={t("Settings")}
          className="mb-4 flex gap-1 rounded-lg border border-border bg-surface p-1"
        >
          {sections.map((s) => (
            <Tabs.Trigger
              key={s.id}
              value={s.id}
              className={cn(
                "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-colors",
                "text-text-2 hover:bg-surface-2 hover:text-text",
                "data-[state=active]:bg-accent-soft data-[state=active]:text-accent",
                "focus-visible:outline-2 focus-visible:outline-accent",
              )}
            >
              <s.icon className="h-3.5 w-3.5" />
              {s.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {sections.map((s) => (
          <Tabs.Content key={s.id} value={s.id} className="animate-in focus-visible:outline-none">
            {s.body}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
  );
}
