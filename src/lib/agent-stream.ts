/* ----------------------------- claude event stream --------------------------- */
/** Shorten a value so one event stays one readable line. */
const brief = (v: unknown, max = 90): string => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** An event as it arrives: its fields are unknown until they are read. */
type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return typeof v === "object" && v !== null ? (v as Json) : {};
}

/** What a tool call is doing, in the words a person would use. */
function describeToolUse(name: string, input: unknown): string {
  const arg = obj(input);
  const file = arg.file_path ?? arg.path ?? arg.notebook_path;
  switch (name) {
    case "Read":
      return `Reading ${brief(file)}`;
    case "Edit":
    case "NotebookEdit":
      return `Editing ${brief(file)}`;
    case "Write":
      return `Writing ${brief(file)}`;
    case "Bash":
      return `Running ${brief(arg.command)}`;
    case "Grep":
      return `Searching for ${brief(arg.pattern)}`;
    case "Glob":
      return `Listing ${brief(arg.pattern)}`;
    case "Task":
      return `Delegating: ${brief(arg.description)}`;
    case "TodoWrite":
      return "Updating its plan";
    default: {
      if (file) return `${name} ${brief(file)}`;
      const args = input ? ` ${brief(JSON.stringify(input), 60)}` : "";
      return `${name}${args}`;
    }
  }
}

/** Assistant turn: its prose plus one line per tool call. */
function renderAssistantEvent(ev: Json): string {
  let out = "";
  const content = obj(ev.message).content;
  for (const raw of Array.isArray(content) ? content : []) {
    const c = obj(raw);
    const text = c.text;
    if (c.type === "text" && typeof text === "string" && text.trim()) out += `${text.trim()}\n`;
    else if (c.type === "tool_use") out += `  · ${describeToolUse(String(c.name), c.input)}\n`;
  }
  return out;
}

/** Final event: outcome, turns, cost, and the answer itself. */
function renderResultEvent(ev: Json): string {
  const cost = typeof ev.total_cost_usd === "number" ? ` · $${ev.total_cost_usd.toFixed(4)}` : "";
  const turns = ev.num_turns ? ` · ${String(ev.num_turns)} turns` : "";
  const outcome = ev.subtype === "success" ? "done" : String(ev.subtype ?? "finished");
  let out = `\n[claude] ${outcome}${turns}${cost}\n`;
  const result = ev.result;
  if (typeof result === "string" && result.trim()) out += `${result.trim()}\n`;
  return out;
}

/** One decoded event -> the text to show (empty for events with nothing to say). */
function renderEvent(ev: Json): string {
  if (ev.type === "system" && ev.subtype === "init") {
    const model = ev.model ? ` · ${String(ev.model)}` : "";
    return `[claude] session started${model}\n`;
  }
  if (ev.type === "assistant") return renderAssistantEvent(ev);
  if (ev.type === "result") return renderResultEvent(ev);
  return "";
}

/** One NDJSON line -> text. Anything that isn't JSON passes through verbatim. */
function renderLine(line: string): string {
  const t = line.trim();
  if (!t) return "";
  if (!t.startsWith("{")) return `${t}\n`;
  let ev: unknown;
  try {
    ev = JSON.parse(t);
  } catch {
    return `${t}\n`;
  }
  return renderEvent(obj(ev));
}

/**
 * Turn Claude's `--output-format stream-json` NDJSON into readable lines (plain `-p`
 * prints nothing until the agent is done). Returns a chunk transformer that buffers
 * partial lines and passes non-JSON (warnings, crashes) straight through.
 */
export function streamJsonToText(): (chunk: string) => string {
  let pending = "";
  return (chunk: string): string => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    let out = "";
    for (const line of lines) out += renderLine(line);
    return out;
  };
}
