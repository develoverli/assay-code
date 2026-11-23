import { platform } from "@tauri-apps/plugin-os";
import { binCommand, resolveBin, type ResolvedBin } from "@/lib/agent-bins";
import { runTokens } from "@/lib/exec";
import * as db from "@/lib/db";
import { complete, probeAll, probeRuntime, type Runtime, type RuntimeInfo } from "@/lib/local-models";
import { generateText } from "@/lib/runner";
import { tr } from "@/lib/i18n";
import type { AIProvider } from "@/types";

interface AIConfig {
  provider: AIProvider;
  model: string;
}

/** All models opencode has configured (e.g. minimax/MiniMax-M2.5, lmstudio/...). */
async function listOpencodeModels(): Promise<string[]> {
  try {
    const bin = (await resolveBin("opencode")).command;
    if (!bin) return [];
    const r = await runTokens([bin, "models"]).result;
    return r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.includes("/") && !s.includes(" "));
  } catch {
    return [];
  }
}

/** The legacy model setting is per provider: claude uses the CLI's own default. */
function modelKey(provider: AIProvider): string | null {
  if (provider === "opencode") return "ai.opencodeModel";
  if (provider === "hermes") return "ai.hermesModel";
  return null;
}

/** Legacy single agentic engine; a task nobody has configured yet starts from it. */
async function getAIConfig(): Promise<AIConfig> {
  const provider = ((await db.getSetting("ai.provider")) as AIProvider) || "claude";
  const key = modelKey(provider);
  const model = (key ? await db.getSetting(key) : "") || "";
  return { provider, model };
}

/* ------------------------------ availability -------------------------------- */
const PROVIDERS: AIProvider[] = ["claude", "opencode", "hermes"];

/** Is this engine on the machine right now? Bypasses the cache so a fresh install counts. */
export async function engineAvailable(p: AIProvider): Promise<boolean> {
  return (await resolveBin(p, true)).command !== null;
}

/* ---------------------------- legacy text engine ----------------------------- */
/** Legacy one-shot engine (`ai.textEngine`); read only as the commit/Improve starting point. */
export type TextEngine =
  | { kind: "agentic" }
  | { kind: "provider"; provider: AIProvider }
  | { kind: "local"; runtime: Runtime; model: string };

const TEXT_ENGINE_KEY = "ai.textEngine";
const AGENTIC: TextEngine = { kind: "agentic" };

const RUNTIMES = new Set<string>(["ollama", "lmstudio"]);
const PROVIDER_SET = new Set<string>(PROVIDERS);

/**
 * `""` for the default, a provider name, or `local:<runtime>:<model>` — and a
 * model id can itself hold colons (`qwen2.5-coder:7b`), so only the first two
 * are split off.
 */
export function parseTextEngine(value: string | null | undefined): TextEngine {
  const v = (value ?? "").trim();
  if (!v) return AGENTIC;
  if (v.startsWith("local:")) {
    const rest = v.slice("local:".length);
    const sep = rest.indexOf(":");
    if (sep <= 0) return AGENTIC;
    const runtime = rest.slice(0, sep);
    const model = rest.slice(sep + 1);
    if (!RUNTIMES.has(runtime) || !model) return AGENTIC;
    return { kind: "local", runtime: runtime as Runtime, model };
  }
  if (PROVIDER_SET.has(v)) return { kind: "provider", provider: v as AIProvider };
  return AGENTIC;
}

export function textEngineValue(engine: TextEngine): string {
  if (engine.kind === "agentic") return "";
  if (engine.kind === "provider") return engine.provider;
  return `local:${engine.runtime}:${engine.model}`;
}

async function getTextEngine(): Promise<TextEngine> {
  return parseTextEngine(await db.getSetting(TEXT_ENGINE_KEY));
}

export function textEngineLabel(engine: TextEngine, agentic: AIProvider): string {
  if (engine.kind === "local") return `${engine.runtime} · ${engine.model}`;
  if (engine.kind === "provider") return engine.provider;
  return agentic;
}

/** The URL the user configured for a runtime, or nothing for its default. */
async function runtimeUrl(runtime: Runtime): Promise<string | undefined> {
  const key = runtime === "ollama" ? "local.ollamaUrl" : "local.lmstudioUrl";
  return (await db.getSetting(key)) || undefined;
}

/** Both local runtimes, asked at the URLs the user configured for them. */
async function probeLocalRuntimes(): Promise<RuntimeInfo[]> {
  const [ollama, lmstudio] = await Promise.all([runtimeUrl("ollama"), runtimeUrl("lmstudio")]);
  return probeAll({ ollama, lmstudio });
}

/* ------------------------------- AI per task --------------------------------- */
/**
 * Every place Assay asks an AI for something, each with its own default.
 * `fix` and `skills` edit files and run commands, so only a CLI agent can do them
 * (a local model only via opencode); `commit` and `improve` are one-shot prompts.
 */
export type AITask = "fix" | "skills" | "commit" | "improve";

export const AI_TASKS: AITask[] = ["fix", "skills", "commit", "improve"];

function taskEditsFiles(task: AITask): boolean {
  return task === "fix" || task === "skills";
}

/** A model empty string means "the agent's own default". */
export type AIChoice =
  | { kind: "agent"; provider: AIProvider; model: string }
  | { kind: "local"; runtime: Runtime; model: string };

/**
 * Stored as one string: `agent:<provider>`, `agent:<provider>:<model>` or
 * `local:<runtime>:<model>`. Models carry colons and slashes of their own
 * (`qwen2.5-coder:7b`, `lmstudio/qwen/qwen3-coder`), so only the first two
 * colons are separators.
 */
export function parseAIChoice(value: string | null | undefined): AIChoice | null {
  const v = (value ?? "").trim();
  const first = v.indexOf(":");
  if (first <= 0) return null;
  const kind = v.slice(0, first);
  const rest = v.slice(first + 1);
  const second = rest.indexOf(":");
  const head = second === -1 ? rest : rest.slice(0, second);
  const model = second === -1 ? "" : rest.slice(second + 1);
  if (kind === "agent") {
    if (!PROVIDER_SET.has(head)) return null;
    return { kind: "agent", provider: head as AIProvider, model };
  }
  if (kind === "local") {
    if (!RUNTIMES.has(head) || !model) return null;
    return { kind: "local", runtime: head as Runtime, model };
  }
  return null;
}

export function aiChoiceValue(choice: AIChoice): string {
  if (choice.kind === "local") return `local:${choice.runtime}:${choice.model}`;
  return choice.model ? `agent:${choice.provider}:${choice.model}` : `agent:${choice.provider}`;
}

export function aiChoiceLabel(choice: AIChoice): string {
  if (choice.kind === "local") {
    return `${choice.runtime === "ollama" ? "Ollama" : "LM Studio"} · ${choice.model}`;
  }
  return choice.model ? `${choice.provider} · ${choice.model}` : choice.provider;
}

const taskKey = (task: AITask): string => `ai.task.${task}`;

const taskChoices = new Map<AITask, Promise<AIChoice>>();

/**
 * The default for a task, read once per session and shared (thirty skill cards ask
 * at once). `setTaskChoice` is the only writer.
 */
export function getTaskChoice(task: AITask): Promise<AIChoice> {
  let hit = taskChoices.get(task);
  if (!hit) {
    hit = readTaskChoice(task);
    taskChoices.set(task, hit);
    // a failed read must not stick for the rest of the session
    void hit.catch(() => taskChoices.delete(task));
  }
  return hit;
}

/** What the user picked, or until then what the two legacy settings said. */
async function readTaskChoice(task: AITask): Promise<AIChoice> {
  const stored = parseAIChoice(await db.getSetting(taskKey(task)));
  if (stored && !(stored.kind === "local" && taskEditsFiles(task))) return stored;
  const cfg = await getAIConfig();
  const agentic: AIChoice = { kind: "agent", provider: cfg.provider, model: cfg.model };
  if (taskEditsFiles(task)) return agentic;
  const engine = await getTextEngine();
  if (engine.kind === "local") return { kind: "local", runtime: engine.runtime, model: engine.model };
  if (engine.kind === "provider") {
    const key = modelKey(engine.provider);
    return { kind: "agent", provider: engine.provider, model: (key ? await db.getSetting(key) : "") || "" };
  }
  return agentic;
}

export async function setTaskChoice(task: AITask, value: string): Promise<void> {
  const choice = parseAIChoice(value);
  if (!choice) return;
  await db.setSetting(taskKey(task), aiChoiceValue(choice));
  taskChoices.set(task, Promise.resolve(choice));
}

/* -------------------------------- inventory ---------------------------------- */
const HERMES_MODELS_KEY = "ai.hermesModels";

/** Hermes has no command that lists models, so the ones the user typed are kept. */
async function getHermesModels(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse((await db.getSetting(HERMES_MODELS_KEY)) || "[]");
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string" && !!m.trim()) : [];
  } catch {
    return [];
  }
}

export async function setHermesModels(models: string[]): Promise<void> {
  const clean = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
  await db.setSetting(HERMES_MODELS_KEY, JSON.stringify(clean));
}

export interface RuntimeState extends RuntimeInfo {
  /** The runtime's binary is on the machine, whether or not its server answers. */
  installed: boolean;
}

/** What Hermes itself says about the model it would use. */
export interface HermesState {
  /** The default model from its config, when it names one. */
  model: string | null;
  /** Something can actually answer: a model key, a login, or a local endpoint. */
  usable: boolean;
}

/**
 * `hermes status` sections that decide whether a model can answer. The API Keys
 * section also lists tool keys (search, browsers, voice), which answer nothing.
 */
const HERMES_MODEL_SECTIONS = ["API Keys", "Auth Providers", "API-Key Providers"];
const HERMES_TOOL_KEYS = ["Firecrawl", "Tavily", "Keenable", "Browser Use", "Browserbase", "FAL", "ElevenLabs", "GitHub"];

/**
 * Read `hermes status`. A configured default model alone is not enough: without a
 * key or login it has nothing to reach the model with.
 */
export function parseHermesStatus(text: string): HermesState {
  let section = "";
  let model: string | null = null;
  let usable = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^◆\s*(.+)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const named = /^Model:\s*(\S.*)$/.exec(line);
    if (named && !model) model = named[1].trim();
    if (!HERMES_MODEL_SECTIONS.includes(section) || !line.includes("✓")) continue;
    if (HERMES_TOOL_KEYS.some((k) => line.startsWith(k))) continue;
    usable = true;
  }
  return { model, usable };
}

/** An endpoint on this machine needs no key — a local runtime behind Hermes. */
export function isLocalEndpoint(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url.trim());
}

async function readHermesState(): Promise<HermesState> {
  try {
    const bin = await binCommand("hermes");
    const [status, baseUrl] = await Promise.all([
      runTokens([bin, "status"]).result,
      runTokens([bin, "config", "get", "model.base_url"]).result,
    ]);
    const state = parseHermesStatus(status.stdout);
    const local = baseUrl.code === 0 && isLocalEndpoint(baseUrl.stdout);
    return { model: state.model, usable: state.usable || local };
  } catch {
    return { model: null, usable: false };
  }
}

export interface AIInventory {
  agents: Record<AIProvider, ResolvedBin>;
  opencodeModels: string[];
  hermesModels: string[];
  hermes: HermesState;
  runtimes: RuntimeState[];
}

async function readInventory(refresh: boolean): Promise<AIInventory> {
  const [claude, opencode, hermes, ollamaBin, lmsBin, runtimes, hermesModels] = await Promise.all([
    resolveBin("claude", refresh),
    resolveBin("opencode", refresh),
    resolveBin("hermes", refresh),
    resolveBin("ollama", refresh),
    resolveBin("lms", refresh),
    probeLocalRuntimes(),
    getHermesModels(),
  ]);
  const [opencodeModels, hermesState] = await Promise.all([
    opencode.command ? listOpencodeModels() : Promise.resolve([]),
    hermes.command ? readHermesState() : Promise.resolve({ model: null, usable: false }),
  ]);
  return {
    agents: { claude, opencode, hermes },
    opencodeModels,
    hermesModels,
    hermes: hermesState,
    runtimes: runtimes.map((r) => ({
      ...r,
      // a server that answers is installed by definition, even from a path Assay does not know
      installed: r.online || (r.runtime === "ollama" ? !!ollamaBin.command : !!lmsBin.command),
    })),
  };
}

let inventory: Promise<AIInventory> | null = null;

/**
 * Everything that can answer, found once per session and shared (`opencode models`
 * alone takes seconds). `refresh` asks again after an install or a server start.
 */
export function loadAIInventory(refresh = false): Promise<AIInventory> {
  if (!inventory || refresh) inventory = readInventory(refresh);
  return inventory;
}

export interface AIOption {
  value: string;
  label: string;
  hint?: string;
  group: string;
  disabled?: boolean;
}

/** opencode's own names for the two local runtimes. */
const LOCAL_PROVIDER_PREFIXES = ["ollama/", "lmstudio/"];

/**
 * What a picker lists for a task: only what can answer it right now, grouped by
 * agent. Missing agents, unusable Hermes, stopped runtimes and bare local models on
 * file-editing tasks are left out; the picker itself keeps showing a stale stored choice.
 */
export function aiOptions(inv: AIInventory, task: AITask): AIOption[] {
  const edits = taskEditsFiles(task);
  const defaultModel = tr("default model");
  const out: AIOption[] = [];
  // opencode lists the local runtimes from its config whether or not they run
  const onlinePrefixes = new Set(inv.runtimes.filter((r) => r.online).map((r) => `${r.runtime}/`));

  if (inv.agents.claude.command) {
    out.push({ value: "agent:claude", label: defaultModel, hint: tr("the model claude is set to"), group: "Claude" });
  }

  if (inv.agents.opencode.command) {
    out.push({ value: "agent:opencode", label: defaultModel, hint: tr("the model opencode is set to"), group: "OpenCode" });
    for (const m of inv.opencodeModels) {
      const prefix = LOCAL_PROVIDER_PREFIXES.find((p) => m.startsWith(p));
      if (prefix && !onlinePrefixes.has(prefix)) continue;
      out.push({
        value: `agent:opencode:${m}`,
        label: m,
        hint: prefix ? tr("local model, driven by opencode") : undefined,
        group: "OpenCode",
      });
    }
  }

  if (inv.agents.hermes.command && inv.hermes.usable) {
    out.push({
      value: "agent:hermes",
      label: inv.hermes.model ?? defaultModel,
      hint: tr("the model `hermes setup` configured"),
      group: "Hermes",
    });
    for (const m of inv.hermesModels) {
      if (m === inv.hermes.model) continue;
      out.push({ value: `agent:hermes:${m}`, label: m, group: "Hermes" });
    }
  }

  if (!edits) {
    const localGroup = tr("Local models");
    for (const r of inv.runtimes) {
      if (!r.online) continue;
      for (const m of r.models) {
        out.push({
          value: `local:${r.runtime}:${m}`,
          label: `${r.label} · ${m}`,
          hint: tr("local, no file access"),
          group: localGroup,
        });
      }
    }
  }
  return out;
}

/* --------------------------------- running ----------------------------------- */
/**
 * Run a one-shot prompt through one choice. A missing engine fails loudly: a silent
 * fallback would spend a frontier model's tokens on a task moved to a local model.
 */
export async function runOneShot(choice: AIChoice, prompt: string): Promise<string> {
  if (choice.kind === "local") {
    const info = await probeRuntime(choice.runtime, await runtimeUrl(choice.runtime));
    if (!info.online) {
      throw new Error(
        tr("{engine} is not answering at {url}. Start it, or pick another engine.", {
          engine: info.label,
          url: info.url,
        }),
      );
    }
    return complete(info, choice.model, prompt);
  }
  if (!(await engineAvailable(choice.provider))) {
    throw new Error(tr("{binary} is not installed, or not on PATH.", { binary: choice.provider }));
  }
  return generateText(choice.provider, prompt, choice.model || undefined);
}

/* ------------------------------ local runtimes ------------------------------- */
/**
 * Start a runtime that is installed but not serving. Ollama is detached (`start` /
 * `nohup … &`) so it outlives Assay; `lms server start` hands off to its own daemon.
 */
export async function startRuntime(runtime: Runtime): Promise<void> {
  const windows = (await platform()) === "windows";
  if (runtime === "lmstudio") {
    const res = await runTokens([await binCommand("lms"), "server", "start"]).result;
    if (res.code !== 0) throw new Error(res.combined.trim() || tr("LM Studio did not start its server."));
    return;
  }
  const bin = await binCommand("ollama");
  const res = windows
    ? await runTokens(["start", "", "/min", bin, "serve"]).result
    : await runTokens(["sh", "-c", 'nohup "$0" serve >/dev/null 2>&1 &', bin]).result;
  if (res.code !== 0) throw new Error(res.combined.trim() || tr("Ollama did not start."));
}

/** A server takes a few seconds to bind its port; ask until it answers or the time is up. */
export async function waitForRuntime(runtime: Runtime, timeoutMs = 15_000): Promise<boolean> {
  const url = await runtimeUrl(runtime);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeRuntime(runtime, url)).online) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}
