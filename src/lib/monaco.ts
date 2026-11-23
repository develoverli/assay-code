import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

/**
 * Monaco, wired for a bundled offline app: workers come from the bundle (no CDN,
 * which the webview would block anyway) and the theme is built from the design
 * tokens so the editor is the same colour as the rest of Assay.
 */

const WORKERS: Record<string, () => Worker> = {
  json: () => new jsonWorker(),
  css: () => new cssWorker(),
  scss: () => new cssWorker(),
  less: () => new cssWorker(),
  html: () => new htmlWorker(),
  handlebars: () => new htmlWorker(),
  razor: () => new htmlWorker(),
  typescript: () => new tsWorker(),
  javascript: () => new tsWorker(),
};

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

export const ASSAY_THEME = "assay-dark";

const token = (name: string, fallback: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

const WORKER_BY_LABEL = new Map<string, () => Worker>(Object.entries(WORKERS));

let initialized = false;

/** Idempotent: sets up the workers and the theme the first time it is called. */
export function initMonaco(): typeof monaco {
  if (initialized) return monaco;
  initialized = true;

  window.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      return (WORKER_BY_LABEL.get(label) ?? (() => new editorWorker()))();
    },
  };

  monaco.editor.defineTheme(ASSAY_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: token("--color-text-3", "#868d95").slice(1), fontStyle: "italic" },
      { token: "keyword", foreground: token("--color-accent", "#7c5cff").slice(1) },
      { token: "string", foreground: token("--color-success", "#3dd68c").slice(1) },
      { token: "number", foreground: token("--color-brass", "#c9973f").slice(1) },
      { token: "type", foreground: token("--color-low", "#4da3ff").slice(1) },
    ],
    colors: {
      "editor.background": token("--color-bg", "#0a0b0d"),
      "editor.foreground": token("--color-text", "#e6e8eb"),
      "editorLineNumber.foreground": token("--color-text-3", "#868d95"),
      "editorLineNumber.activeForeground": token("--color-text-2", "#9ba1a9"),
      "editorCursor.foreground": token("--color-accent", "#7c5cff"),
      "editor.lineHighlightBackground": token("--color-surface", "#141619"),
      "editor.selectionBackground": token("--color-accent-soft", "#211c3d"),
      "editorWidget.background": token("--color-surface", "#141619"),
      "editorWidget.border": token("--color-border", "#26292f"),
      "editorGutter.background": token("--color-bg", "#0a0b0d"),
      "scrollbarSlider.background": token("--color-surface-3", "#22262c"),
    },
  });

  // the project's own tsconfig isn't loaded here, so keep the editor quiet about
  // imports it can't resolve — this is a viewer/editor, not a type checker
  const quiet = { noSemanticValidation: true, noSyntaxValidation: false };
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(quiet);
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(quiet);

  return monaco;
}

export type { monaco };
