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
 * Models are keyed by the store's path, not Monaco's URI: on Windows the URI
 * lowercases the drive letter, so a fresh model looked closed and was disposed.
 */

export function EditorPane() {
  const t = useT();
  const files = useBench((s) => s.files);
  const activeFile = useBench((s) => s.activeFile);
  const editFile = useBench((s) => s.editFile);
  const saveFileAt = useBench((s) => s.saveFileAt);
  const reveal = useBench((s) => s.reveal);
  const clearReveal = useBench((s) => s.clearReveal);

  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = React.useRef<typeof Monaco | null>(null);
  const modelsRef = React.useRef(new Map<string, Monaco.editor.ITextModel>());
  // read inside Monaco callbacks without rebuilding the editor; written after
  // the commit, because render has to stay pure
  const activeRef = React.useRef<string | null>(activeFile);
  React.useEffect(() => {
    activeRef.current = activeFile;
  });

  const file = files.find((f) => f.path === activeFile) ?? null;

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
      const path = activeRef.current;
      if (path) void saveFileAt(path);
    });
    editor.onDidChangeModelContent(() => {
      const path = activeRef.current;
      if (path) editFile(path, editor.getValue());
    });
    editorRef.current = editor;

    const models = modelsRef.current;
    return () => {
      editor.dispose();
      editorRef.current = null;
      for (const model of models.values()) model.dispose();
      models.clear();
    };
  }, [editFile, saveFileAt]);

  // one model per open file, so switching tabs keeps undo history and cursor
  React.useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    if (!file) {
      editor.setModel(null);
      return;
    }
    let model = modelsRef.current.get(file.path);
    if (!model || model.isDisposed()) {
      model = monaco.editor.createModel(file.content, languageOf(file.name), monaco.Uri.file(file.path));
      modelsRef.current.set(file.path, model);
    }
    if (editor.getModel() !== model) editor.setModel(model);
    editor.updateOptions({ readOnly: file.readOnly });
    editor.focus();
  }, [file]);

  // a search hit or a finding asks for a line: land on it, centred and selected
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

  // a closed tab's model goes with it — keyed by the same path the store uses
  React.useEffect(() => {
    const open = new Set(files.map((f) => f.path));
    for (const [path, model] of modelsRef.current) {
      if (open.has(path)) continue;
      model.dispose();
      modelsRef.current.delete(path);
    }
  }, [files]);

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
