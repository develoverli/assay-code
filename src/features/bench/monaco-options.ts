import type * as Monaco from "monaco-editor";
import { ASSAY_THEME } from "@/lib/monaco";

/** What every Monaco in Workspace shares: the file tabs and the conflict result editor. */
export const BASE_EDITOR_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: ASSAY_THEME,
  automaticLayout: true,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12.5,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  padding: { top: 8 },
  tabSize: 2,
};
