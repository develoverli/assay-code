import {
  Braces,
  FileCode2,
  FileImage,
  FileJson,
  FileLock2,
  FileText,
  FileType2,
  Hexagon,
  Package,
  Settings2,
  Sparkles,
  SquareTerminal,
  Terminal,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { extensionOf, isSecretFile } from "@/lib/fs-tree";
import type { TermKind } from "@/lib/bench-term";
import type { GitFileStatus } from "@/lib/git";

/**
 * One glyph per kind of thing. Colours come from the status tokens, not brand
 * palettes: the point is telling file kinds apart at a glance.
 */

/**
 * How a working-tree change reads in the tree and on a tab. The letter (git's
 * own) keeps the state readable for anyone who cannot tell amber from green.
 */
interface StatusGlyph {
  tone: string;
  letter: string;
  /** English label, translated where it is shown. */
  label: string;
}

const STATUS: Record<GitFileStatus, StatusGlyph> = {
  modified: { tone: "text-warn", letter: "M", label: "Modified" },
  added: { tone: "text-success", letter: "A", label: "Added" },
  untracked: { tone: "text-success", letter: "U", label: "Untracked" },
  deleted: { tone: "text-danger", letter: "D", label: "Deleted" },
  renamed: { tone: "text-warn", letter: "R", label: "Renamed" },
  conflict: { tone: "text-crit", letter: "!", label: "Conflict" },
};

export function statusGlyph(status: GitFileStatus): StatusGlyph {
  return STATUS[status];
}

interface FileGlyph {
  Icon: LucideIcon;
  /** Token-based colour class. */
  tone: string;
}

const BY_EXT: Record<string, FileGlyph> = {
  ts: { Icon: FileCode2, tone: "text-low" },
  tsx: { Icon: FileCode2, tone: "text-low" },
  mts: { Icon: FileCode2, tone: "text-low" },
  cts: { Icon: FileCode2, tone: "text-low" },
  js: { Icon: FileCode2, tone: "text-med" },
  jsx: { Icon: FileCode2, tone: "text-med" },
  mjs: { Icon: FileCode2, tone: "text-med" },
  cjs: { Icon: FileCode2, tone: "text-med" },
  json: { Icon: FileJson, tone: "text-med" },
  jsonc: { Icon: FileJson, tone: "text-med" },
  lock: { Icon: FileLock2, tone: "text-text-3" },
  py: { Icon: FileCode2, tone: "text-success" },
  rs: { Icon: FileCode2, tone: "text-high" },
  go: { Icon: FileCode2, tone: "text-low" },
  java: { Icon: FileCode2, tone: "text-high" },
  rb: { Icon: FileCode2, tone: "text-crit" },
  php: { Icon: FileCode2, tone: "text-accent" },
  c: { Icon: FileCode2, tone: "text-text-2" },
  h: { Icon: FileCode2, tone: "text-text-2" },
  cpp: { Icon: FileCode2, tone: "text-text-2" },
  cs: { Icon: FileCode2, tone: "text-accent" },
  html: { Icon: FileType2, tone: "text-high" },
  htm: { Icon: FileType2, tone: "text-high" },
  css: { Icon: Braces, tone: "text-low" },
  scss: { Icon: Braces, tone: "text-crit" },
  less: { Icon: Braces, tone: "text-low" },
  md: { Icon: FileText, tone: "text-text-2" },
  mdx: { Icon: FileText, tone: "text-text-2" },
  txt: { Icon: FileText, tone: "text-text-3" },
  yml: { Icon: Settings2, tone: "text-text-2" },
  yaml: { Icon: Settings2, tone: "text-text-2" },
  toml: { Icon: Settings2, tone: "text-text-2" },
  ini: { Icon: Settings2, tone: "text-text-2" },
  xml: { Icon: FileType2, tone: "text-text-2" },
  sh: { Icon: Terminal, tone: "text-success" },
  bash: { Icon: Terminal, tone: "text-success" },
  zsh: { Icon: Terminal, tone: "text-success" },
  ps1: { Icon: Terminal, tone: "text-low" },
  sql: { Icon: Hexagon, tone: "text-low" },
  png: { Icon: FileImage, tone: "text-accent" },
  jpg: { Icon: FileImage, tone: "text-accent" },
  jpeg: { Icon: FileImage, tone: "text-accent" },
  gif: { Icon: FileImage, tone: "text-accent" },
  svg: { Icon: FileImage, tone: "text-warn" },
  webp: { Icon: FileImage, tone: "text-accent" },
  ico: { Icon: FileImage, tone: "text-accent" },
};

const FALLBACK: FileGlyph = { Icon: FileText, tone: "text-text-3" };

/** The glyph for a file name — secrets and manifests get their own. */
export function fileGlyph(name: string): FileGlyph {
  const lower = name.toLowerCase();
  if (isSecretFile(name)) return { Icon: FileLock2, tone: "text-warn" };
  if (lower === "package.json") return { Icon: Package, tone: "text-crit" };
  if (lower === "dockerfile") return { Icon: Package, tone: "text-low" };
  if (lower === "makefile") return { Icon: Settings2, tone: "text-text-2" };
  return BY_EXT[extensionOf(name)] ?? FALLBACK;
}

const LAUNCHER_ICONS: Record<TermKind, LucideIcon> = {
  shell: SquareTerminal,
  claude: Sparkles,
  opencode: Braces,
  hermes: Zap,
};

const LAUNCHER_TONES: Record<TermKind, string> = {
  shell: "text-text-2",
  claude: "text-accent",
  opencode: "text-low",
  hermes: "text-warn",
};

// Own-key Map reads rather than indexing the records with a variable.
const LAUNCHER_ICON_BY_KIND = new Map<string, LucideIcon>(Object.entries(LAUNCHER_ICONS));
const LAUNCHER_TONE_BY_KIND = new Map<string, string>(Object.entries(LAUNCHER_TONES));

export function launcherGlyph(kind: TermKind): FileGlyph {
  return {
    Icon: LAUNCHER_ICON_BY_KIND.get(kind) ?? LAUNCHER_ICONS.shell,
    tone: LAUNCHER_TONE_BY_KIND.get(kind) ?? LAUNCHER_TONES.shell,
  };
}
