/**
 * Local model runtimes: Ollama and LM Studio. They only serve completions over HTTP,
 * so for agentic work they sit behind opencode, hermes or strix; Assay calls them
 * directly only for one-shot text tasks.
 */
import { fetch } from "@tauri-apps/plugin-http";

export type Runtime = "ollama" | "lmstudio";

export interface RuntimeInfo {
  runtime: Runtime;
  label: string;
  /** Base URL Assay talks to. */
  url: string;
  /** OpenAI-compatible chat endpoint, for the direct text calls. */
  chatUrl: string;
  online: boolean;
  models: string[];
  hint: string;
}

const DEFAULTS: Record<Runtime, { label: string; url: string; hint: string }> = {
  ollama: {
    label: "Ollama",
    url: "http://localhost:11434",
    hint: "ollama serve · pull a model with `ollama pull qwen2.5-coder`",
  },
  lmstudio: {
    label: "LM Studio",
    url: "http://localhost:1234",
    hint: "LM Studio → Developer → Start Server",
  },
};

/** A parsed JSON object: its fields are unknown until they are read. */
function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const DEFAULT_BY_RUNTIME = new Map<string, { label: string; url: string; hint: string }>(
  Object.entries(DEFAULTS),
);

async function json(url: string, ms = 1500): Promise<unknown> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch {
    return null; // not running, wrong port, or not that runtime
  }
}

/** Ask one runtime what it has loaded. Never throws: absence is the normal case. */
export async function probeRuntime(runtime: Runtime, baseUrl?: string): Promise<RuntimeInfo> {
  const d = DEFAULT_BY_RUNTIME.get(runtime) ?? DEFAULTS.ollama;
  // the trailing slashes come off in a loop: `/\/+$/` backtracks quadratically
  let url = baseUrl || d.url;
  while (url.endsWith("/")) url = url.slice(0, -1);
  const base: RuntimeInfo = {
    runtime,
    label: d.label,
    url,
    chatUrl: `${url}/v1/chat/completions`,
    online: false,
    models: [],
    hint: d.hint,
  };

  if (runtime === "ollama") {
    // Ollama's native listing; it also serves /v1 for OpenAI-compatible clients
    const r = await json(`${url}/api/tags`);
    if (!r) return base;
    const models: string[] = [];
    for (const m of list(obj(r).models)) {
      const name = String(obj(m).name);
      if (name) models.push(name);
    }
    return { ...base, online: true, models };
  }

  const r = await json(`${url}/v1/models`);
  if (!r) return base;
  const models: string[] = [];
  for (const m of list(obj(r).data)) {
    const id = String(obj(m).id);
    if (id) models.push(id);
  }
  return { ...base, online: true, models };
}

export async function probeAll(overrides?: Partial<Record<Runtime, string>>): Promise<RuntimeInfo[]> {
  return Promise.all([
    probeRuntime("ollama", overrides?.ollama),
    probeRuntime("lmstudio", overrides?.lmstudio),
  ]);
}

/**
 * How a model should be written for each engine's model field. Both engines take
 * `provider/model`, and the provider name is whatever the user configured there,
 * so this is a suggestion rather than a guarantee.
 */
export function modelRef(runtime: Runtime, model: string): string {
  return `${runtime === "ollama" ? "ollama" : "lmstudio"}/${model}`;
}

/** One prompt in, one completion out, straight against the local endpoint. */
export async function complete(info: RuntimeInfo, model: string, prompt: string): Promise<string> {
  const res = await fetch(info.chatUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${info.label} → ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}
