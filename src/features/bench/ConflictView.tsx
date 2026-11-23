import type * as Monaco from "monaco-editor";
import { Check, PencilLine, Rows3 } from "lucide-react";
import * as React from "react";
import {
  conflictState,
  hasConflictMarkers,
  isDeleteConflict,
  markResolved,
  parseConflicts,
  resolveByDeleting,
  resolveConflicts,
  type ConflictSegment,
  type HunkChoice,
} from "@/lib/git";
import { languageOf, openFile, saveFile } from "@/lib/fs-tree";
import { initMonaco } from "@/lib/monaco";
import { useBench, type ConflictTab } from "@/store/bench";
import { Button } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BASE_EDITOR_OPTIONS } from "./monaco-options";

/**
 * One conflicted file, settled block by block (mine / incoming / both), with an
 * editor for hand touch-ups. The file is written and staged only on Mark
 * resolved, and only once no conflict marker is left in it.
 */

/** Lines of agreed text shown around a clash; the rest folds into a count. */
const CONTEXT_LINES = 3;

/** Porcelain code assumed when git does not list the file: both modified. */
const DEFAULT_CONFLICT_CODE = "UU";

/** The agreed text between two clashes, folded down to its edges. */
function ContextText({ text, first, last }: { text: string; first: boolean; last: boolean }) {
  const t = useT();
  const lines = text.replace(/\n$/, "").split("\n");
  const head = first ? [] : lines.slice(0, CONTEXT_LINES);
  const tail = last ? [] : lines.slice(-CONTEXT_LINES);
  const hidden = lines.length - head.length - tail.length;
  if (hidden <= 0) {
    return <pre className="px-3 font-mono text-[11px] leading-5 text-text-3">{lines.join("\n")}</pre>;
  }
  return (
    <div className="font-mono text-[11px] leading-5 text-text-3">
      {head.length > 0 && <pre className="px-3">{head.join("\n")}</pre>}
      <p className="my-1 border-y border-border-soft bg-surface px-3 py-0.5 text-[10px]">
        {hidden === 1 ? t("1 unchanged line") : t("{n} unchanged lines", { n: hidden })}
      </p>
      {tail.length > 0 && <pre className="px-3">{tail.join("\n")}</pre>}
    </div>
  );
}

function Side({ title, label, text, picked }: { title: string; label: string; text: string; picked: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col rounded-md border", picked ? "border-accent/60" : "border-border-soft")}>
      <p className="flex items-center gap-1.5 border-b border-border-soft px-2 py-1 text-[10px] uppercase tracking-wide text-text-3">
        <span className="text-text-2">{title}</span>
        {label && <span className="truncate normal-case tracking-normal font-mono">{label}</span>}
      </p>
      <pre className="max-h-72 min-h-8 overflow-auto px-2 py-1 font-mono text-[11px] leading-5 text-text selectable">
        {text || " "}
      </pre>
    </div>
  );
}

function Hunk({
  seg,
  index,
  total,
  choice,
  onChoose,
}: {
  seg: Extract<ConflictSegment, { kind: "conflict" }>;
  index: number;
  total: number;
  choice: HunkChoice | null;
  onChoose: (choice: HunkChoice | null) => void;
}) {
  const t = useT();
  const options: { id: HunkChoice; label: string }[] = [
    { id: "ours", label: t("Keep mine") },
    { id: "theirs", label: t("Keep incoming") },
    { id: "both", label: t("Keep both") },
  ];
  return (
    <section
      aria-label={t("Conflict {n} of {total}", { n: index + 1, total })}
      className={cn("mx-3 my-2 rounded-lg border p-2", choice ? "border-border bg-surface" : "border-warn/50 bg-warn/5")}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className={cn("text-[11px] font-medium", choice ? "text-success" : "text-warn")}>
          {choice ? <Check className="mr-1 inline h-3 w-3" /> : null}
          {t("Conflict {n} of {total}", { n: index + 1, total })}
        </span>
        <div role="group" aria-label={t("Choose a version")} className="ml-auto flex flex-wrap gap-1">
          {options.map((o) => (
            <Button
              key={o.id}
              size="sm"
              variant={choice === o.id ? "primary" : "secondary"}
              aria-pressed={choice === o.id}
              onClick={() => onChoose(choice === o.id ? null : o.id)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Side
          title={t("Yours")}
          label={seg.oursLabel}
          text={seg.ours}
          picked={choice === "ours" || choice === "both"}
        />
        <Side
          title={t("Incoming")}
          label={seg.theirsLabel}
          text={seg.theirs}
          picked={choice === "theirs" || choice === "both"}
        />
      </div>
    </section>
  );
}

/** The result as a real editor, for the answer that is neither side. */
function ResultEditor({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });
  // the starting text is read once: after that the editor owns it
  const initial = React.useRef(value);

  React.useEffect(() => {
    if (!host.current) return;
    const monaco = initMonaco();
    // no URI: the same file may be open in a tab, and Monaco allows one model per URI
    const model = monaco.editor.createModel(initial.current, languageOf(name));
    const editor: Monaco.editor.IStandaloneCodeEditor = monaco.editor.create(host.current, {
      ...BASE_EDITOR_OPTIONS,
      model,
    });
    const sub = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
    editor.focus();
    return () => {
      sub.dispose();
      editor.dispose();
      model.dispose();
    };
  }, [name]);

  return <div ref={host} className="min-h-0 flex-1" />;
}

export function ConflictView({ tab, root }: { tab: ConflictTab; root: string }) {
  const t = useT();
  const closeConflict = useBench((s) => s.closeConflict);
  const openConflict = useBench((s) => s.openConflict);
  const setError = useBench((s) => s.setError);
  const refreshGitStatus = useBench((s) => s.refreshGitStatus);

  const [loading, setLoading] = React.useState(true);
  const [code, setCode] = React.useState(DEFAULT_CONFLICT_CODE);
  const [segments, setSegments] = React.useState<ConflictSegment[]>([]);
  const [choices, setChoices] = React.useState<(HunkChoice | null)[]>([]);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const hunks = segments.filter((s): s is Extract<ConflictSegment, { kind: "conflict" }> => s.kind === "conflict");
  const settled = choices.filter(Boolean).length;
  /** Per segment, its place among the conflicts (-1 for agreed text) — what `choices` is indexed by. */
  const hunkIndex = React.useMemo(() => {
    let n = 0;
    return segments.map((s) => (s.kind === "conflict" ? n++ : -1));
  }, [segments]);
  const deleteConflict = isDeleteConflict(code);

  React.useEffect(() => {
    let ignore = false;
    setLoading(true);
    setEditing(false);
    void (async () => {
      const [state, opened] = await Promise.all([conflictState(root), openFile(tab.path, tab.name)]);
      if (ignore) return;
      const entry = state.files.find((f) => f.path === tab.rel);
      setCode(entry?.code ?? DEFAULT_CONFLICT_CODE);
      const content = opened.ok ? opened.content : "";
      const parsed = parseConflicts(content);
      setSegments(parsed);
      setChoices(parsed.filter((s) => s.kind === "conflict").map(() => null));
      if (!opened.ok && !isDeleteConflict(entry?.code ?? DEFAULT_CONFLICT_CODE)) setError(`${tab.name}: ${opened.reason}`);
    })().finally(() => {
      if (!ignore) setLoading(false);
    });
    return () => {
      ignore = true;
    };
  }, [root, tab.path, tab.rel, tab.name, setError]);

  const result = editing ? draft : resolveConflicts(segments, choices);
  const unresolved = hasConflictMarkers(result);

  const chooseAll = (choice: HunkChoice) => setChoices(hunks.map(() => choice));

  const toggleEditing = () => {
    if (editing) {
      // back to blocks: whatever markers the hand edit left become blocks again
      const parsed = parseConflicts(draft);
      setSegments(parsed);
      setChoices(parsed.filter((s) => s.kind === "conflict").map(() => null));
      setEditing(false);
    } else {
      setDraft(resolveConflicts(segments, choices));
      setEditing(true);
    }
  };

  /** After a file is settled, the next one opens by itself; the last one closes the tab. */
  const next = async () => {
    await refreshGitStatus();
    const state = await conflictState(root);
    const following = state.files.find((f) => f.path !== tab.rel);
    if (!following) {
      closeConflict();
      return;
    }
    const name = following.path.split("/").pop() ?? following.path;
    openConflict({ path: `${root}/${following.path}`, rel: following.path, name });
  };

  const settle = (action: () => Promise<{ ok: boolean; output: string }>) => {
    setError(null);
    setBusy(true);
    void action()
      .then(async (res) => {
        if (!res.ok) {
          setError(res.output || t("git could not mark the file resolved."));
          return;
        }
        await next();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const markDone = () =>
    settle(async () => {
      await saveFile(tab.path, result);
      return markResolved(root, tab.rel);
    });

  if (loading) {
    return <p className="px-4 py-3 text-[12px] text-text-3">{t("reading…")}</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[12px] text-text" title={tab.rel}>
            {tab.rel}
          </p>
          {!deleteConflict && (
            <p className={cn("text-[11px]", unresolved ? "text-warn" : "text-success")}>
              {editing
                ? unresolved
                  ? t("Markers are still in the file")
                  : t("No markers left")
                : t("{done} of {total} resolved", { done: settled, total: hunks.length })}
            </p>
          )}
        </div>
        {!deleteConflict && (
          <>
            {!editing && hunks.length > 1 && (
              <>
                <Button size="sm" variant="ghost" onClick={() => chooseAll("ours")}>
                  {t("All mine")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => chooseAll("theirs")}>
                  {t("All incoming")}
                </Button>
              </>
            )}
            <Button size="sm" variant="secondary" onClick={toggleEditing} aria-pressed={editing}>
              {editing ? <Rows3 className="h-3.5 w-3.5" /> : <PencilLine className="h-3.5 w-3.5" />}
              {editing ? t("Back to blocks") : t("Edit result")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={busy || unresolved}
              title={unresolved ? t("Choose a version for every conflict first") : undefined}
              onClick={markDone}
            >
              <Check className="h-3.5 w-3.5" /> {t("Mark resolved")}
            </Button>
          </>
        )}
      </header>

      {deleteConflict ? (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[13px] text-text-2">
            {code.startsWith("D")
              ? t("You deleted this file, and the incoming changes edited it.")
              : t("You edited this file, and the incoming changes deleted it.")}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" loading={busy} onClick={() => settle(() => markResolved(root, tab.rel))}>
              {t("Keep the file")}
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => settle(() => resolveByDeleting(root, tab.rel))}>
              {t("Delete it")}
            </Button>
          </div>
        </div>
      ) : editing ? (
        <ResultEditor name={tab.name} value={draft} onChange={setDraft} />
      ) : hunks.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-text-3">
          {t("No conflict markers in this file. If it looks right, mark it resolved.")}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-2">
          {segments.map((seg, i) => {
            if (seg.kind === "text") {
              return (
                <ContextText key={`t${i}`} text={seg.text} first={i === 0} last={i === segments.length - 1} />
              );
            }
            const at = hunkIndex[i] ?? 0;
            return (
              <Hunk
                key={`c${i}`}
                seg={seg}
                index={at}
                total={hunks.length}
                choice={choices[at] ?? null}
                onChoose={(choice) => setChoices((cur) => cur.map((c, k) => (k === at ? choice : c)))}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
