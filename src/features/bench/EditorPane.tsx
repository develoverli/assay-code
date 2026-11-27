import * as React from "react";
import { initMonaco } from "@/lib/monaco";
import type * as Monaco from "monaco-editor";
import { languageOf } from "@/lib/fs-tree";
import { useBench } from "@/store/bench";
import { useT } from "@/lib/i18n";
import { BASE_EDITOR_OPTIONS } from "./monaco-options";

/**
 * Monaco over the project's real files. Saving is Ctrl+S only, never automatic:
 * an agent may be editing the same tree from a terminal.
 *
 * Every pane has its own editor; the models are shared, one per open file, so a
 * file moved to another pane keeps its undo history, and its cursor travels with
 * it (`viewStates`). A file is in one pane at a time, so two editors never edit
 * the same model.
 *
 * Models are keyed by the store's path, not Monaco's URI: on Windows the URI
 * lowercases the drive letter, so a fresh model looked closed and was disposed.
 */

const models = new Map<string, Monaco.editor.ITextModel>();
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState>();

function modelFor(monaco: typeof Monaco, path: string, name: string, content: string): Monaco.editor.ITextModel {
  let model = models.get(path);
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(content, languageOf(name), monaco.Uri.file(path));
    models.set(path, model);
  }
  return model;
}

/** A closed tab's model goes with it. Mounted once by the work area. */
export function useEditorLifecycle(): void {
  const files = useBench((s) => s.files);
  React.useEffect(() => {
    const open = new Set(files.map((f) => f.path));
    for (const [path, model] of models) {
      if (open.has(path)) continue;
      model.dispose();
      models.delete(path);
      viewStates.delete(path);
    }
  }, [files]);
}

/** One pane's editor, showing `path` (or nothing). `focused` gives it the keyboard. */
export function EditorSlot({ path, focused }: { path: string | null; focused: boolean }) {
  const t = useT();
  const file = useBench((s) => (path ? (s.files.find((f) => f.path === path) ?? null) : null));
  const editFile = useBench((s) => s.editFile);
  const saveFileAt = useBench((s) => s.saveFileAt);
  const reveal = useBench((s) => s.reveal);
  const clearReveal = useBench((s) => s.clearReveal);

  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = React.useRef<typeof Monaco | null>(null);
  /** The path this editor shows right now, read inside Monaco callbacks. */
  const shownRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!hostRef.current || editorRef.current) return;
    const monaco = initMonaco();
    monacoRef.current = monaco;
    const editor = monaco.editor.create(hostRef.current, {
      ...BASE_EDITOR_OPTIONS,
      renderLineHighlight: "line",
      smoothScrolling: true,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const current = shownRef.current;
      if (current) void saveFileAt(current);
    });
    editor.onDidChangeModelContent(() => {
      const current = shownRef.current;
      if (current) editFile(current, editor.getValue());
    });
    editorRef.current = editor;
    return () => {
      const current = shownRef.current;
      if (current) {
        const state = editor.saveViewState();
        if (state) viewStates.set(current, state);
      }
      // the models are shared and outlive this pane; only the editor goes
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
      shownRef.current = null;
    };
  }, [editFile, saveFileAt]);

  // show this pane's file, keeping where the cursor was when it was last on screen
  React.useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const before = shownRef.current;
    const next = file?.path ?? null;
    if (before && before !== next) {
      const state = editor.saveViewState();
      if (state) viewStates.set(before, state);
    }
    if (!file) {
      shownRef.current = null;
      editor.setModel(null);
      return;
    }
    const model = modelFor(monaco, file.path, file.name, file.content);
    if (editor.getModel() !== model) {
      shownRef.current = file.path;
      editor.setModel(model);
      const state = viewStates.get(file.path);
      if (state) editor.restoreViewState(state);
    }
    editor.updateOptions({ readOnly: file.readOnly });
  }, [file]);

  React.useEffect(() => {
    if (focused && file) editorRef.current?.focus();
  }, [focused, file]);

  // a search hit or a finding asks for a line: the pane showing that file lands on it
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!reveal || !editor || !file || file.path !== reveal.path) return;
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(Math.max(reveal.line, 1), model.getLineCount());
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
    clearReveal();
  }, [reveal, file, clearReveal]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {file?.note && (
        <p className="shrink-0 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
          {t(file.note)}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />
        {!file && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-text-3">
            {t("Pick a file from the Files panel to open it here.")}
          </div>
        )}
      </div>
    </div>
  );
}
