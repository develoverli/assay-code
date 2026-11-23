import { create } from "zustand";
import { binCommand } from "@/lib/agent-bins";
import {
  agentCommand,
  COMMAND_ENV,
  LAUNCHERS,
  promptEnv,
  resolveShell,
  scriptShellCommand,
  shellArgs,
  signalEnv,
  type TermKind,
} from "@/lib/bench-term";
import { agentSignalPaths, type AgentStop } from "@/lib/agent-signals";
import { agentNotificationsEnabled, notify } from "@/lib/notify";
import { useUI } from "@/store/ui";
import { modifiedAt, openFile as readForEditor, saveFile, searchFileNames, type NameHit } from "@/lib/fs-tree";
import { searchContent, type SearchHit } from "@/lib/code-search";
import { classifyStatus, gitState, type GitChange, type GitFileStatus } from "@/lib/git";
import { ptyKill, ptyList, ptyRename, ptySpawn } from "@/lib/pty";
import { storeOrder, type TabKey } from "@/lib/tab-order";
import { uid } from "@/lib/utils";
import { tr } from "@/lib/i18n";
import { useApp } from "@/store/app";

/** A Claude session id (a UUID): letters, digits and dashes only, safe in any shell unquoted. */
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(id);
}

/**
 * Bench state: the terminals and the open files. It lives in the store, not the
 * view, so a session survives leaving Bench.
 */

export interface TermSession {
  id: string;
  title: string;
  /** What it was called when it opened; clearing a rename goes back to it. */
  defaultTitle: string;
  kind: TermKind;
  cwd: string;
  /**
   * The project this session belongs to. Null when it could not be matched to
   * one — a session spawned by an older build, or whose project was deleted.
   * Those stay alive and counted, but out of every project's tab strip.
   */
  projectId: string | null;
  /** False once the process ended; the tab stays until the user closes it. */
  alive: boolean;
  /**
   * Something was actually done in here: the user typed, or the tab was opened
   * to run an agent. Closing one of these asks first; an untouched shell just
   * closes.
   */
  used: boolean;
}

interface OpenFile {
  path: string;
  name: string;
  /** The project it was opened from; tabs only show under their own project. */
  projectId: string | null;
  /** What the editor holds right now. */
  content: string;
  /** What is on disk as far as we know — `content !== saved` means unsaved. */
  saved: string;
  readOnly: boolean;
  note?: string;
  /** Modification time when it was opened, to notice edits made behind our back. */
  openedAt: number | null;
}

/** Terminals, open files and the conflict being resolved share one tab strip; this says which owns it. */
export type Focus = "terminal" | "file" | "conflict";

/** Which panel the right dock is showing (`dock` is null when folded away). */
export type DockPanel = "files" | "search" | "git" | "deploy" | "conflicts" | "sessions" | "findings";

/** The conflicted file open in the work area — one at a time, it is a task, not a document. */
export interface ConflictTab {
  /** Absolute path, to read and write. */
  path: string;
  /** Relative to the repo root, as git names it. */
  rel: string;
  name: string;
  projectId: string | null;
}

/** The search box searches names or file contents — the two tabs under it. */
export type SearchMode = "names" | "content";

/** Where the user was in a project, so coming back lands on the same tab. */
interface TabMemory {
  activeTerminal: string | null;
  activeFile: string | null;
  focus: Focus;
}

/** What `restoreTerminals` needs to put an orphaned PTY back under its project. */
interface ProjectRef {
  id: string;
  path?: string | null;
}

interface BenchState {
  /**
   * The project Bench is on. Terminals and files are kept for every project at
   * once — a session must not die because you looked at another repo — so this
   * is what decides which of them are on screen.
   */
  projectId: string | null;
  /** Which tab was in front, per project, so coming back is where you left. */
  remembered: Record<string, TabMemory>;
  /** The active project's folder, so the store can refresh git without the view. */
  root: string | null;
  /** Point Bench at a project: remember the current tab, restore that one's. */
  setProject: (projectId: string, root: string | null) => void;

  /**
   * What git says about the working tree, keyed by path relative to the root.
   * The tree and the tab strip read it; the Git panel feeds it whatever it just
   * fetched, so a commit repaints everything without a second `git status`.
   */
  gitStatus: Record<string, GitFileStatus>;
  /** Folders with a change somewhere underneath, so a collapsed one still says so. */
  gitDirs: Record<string, true>;
  refreshGitStatus: () => Promise<void>;
  applyGitChanges: (changes: GitChange[]) => void;

  terminals: TermSession[];
  activeTerminal: string | null;
  files: OpenFile[];
  activeFile: string | null;
  /** Whether the work area is showing the active terminal or the active file. */
  focus: Focus;
  showIgnored: boolean;
  /** Dotfiles are shown by default; a repo's config is usually the point. */
  showDotfiles: boolean;
  toggleShowDotfiles: () => void;
  /** Reopen a recorded Claude session in a new terminal. */
  resumeSession: (sessionId: string, cwd: string) => Promise<void>;
  error: string | null;
  /**
   * What the tool itself printed behind `error`, shown small under the plain
   * sentence. Tied to the sentence it explains: an error set elsewhere without
   * one must not inherit the last git output.
   */
  errorDetail: { error: string; text: string } | null;
  /** The conflicted file being resolved, when there is one. */
  conflict: ConflictTab | null;
  openConflict: (tab: Omit<ConflictTab, "projectId">) => void;
  closeConflict: () => void;
  dock: DockPanel | null;
  /** The panel to come back to when the dock is unfolded. */
  lastDock: DockPanel;
  openDock: (panel: DockPanel) => void;
  /** One control folds and unfolds the dock; it lives in the rail. */
  toggleDock: () => void;

  query: string;
  searchMode: SearchMode;
  nameHits: NameHit[];
  contentHits: SearchHit[];
  searchEngine: string;
  searchTruncated: boolean;
  searchError: string | null;
  searching: boolean;
  setQuery: (root: string, query: string) => void;
  /** Bumped when something asks for the search box; the panel focuses it. */
  searchFocusSeq: number;
  /** Open the dock on the search box, in the given mode. */
  focusSearch: (mode: SearchMode) => void;
  setSearchMode: (root: string, mode: SearchMode) => void;
  /** Run whichever search the current mode implies. */
  runSearch: (root: string) => Promise<void>;

  /** A line the editor should jump to once the file is open. */
  reveal: { path: string; line: number } | null;
  /** Open a file and land on a line — used by search hits and findings. */
  openAt: (path: string, name: string, line: number) => Promise<void>;
  clearReveal: () => void;

  /**
   * Open a terminal. `opts.prompt` starts the agent already working on it, which
   * is how a skill is used; `opts.label` names the tab after whatever asked.
   * `opts.command` runs a project script in a plain shell, tab named `▸ label`.
   */
  newTerminal: (
    kind: TermKind,
    cwd: string,
    opts?: { prompt?: string; label?: string; command?: string },
  ) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;
  setActiveTerminal: (id: string | null) => void;
  markTerminalDead: (id: string) => void;
  /** Called on the first keystroke a session receives. */
  markTerminalUsed: (id: string) => void;
  /**
   * Terminals whose agent finished a turn while nobody was looking at them.
   * The tab shows a dot until it is opened.
   */
  attention: Record<string, true>;
  /** Claude's `Stop` hook fired in a terminal: mark it, and notify when unseen. */
  agentStopped: (e: AgentStop) => Promise<void>;
  /** Name a terminal tab; an empty name restores the one it opened with. */
  renameTerminal: (id: string, title: string) => Promise<void>;

  /**
   * The tab strip as the user arranged it, one list for every project (see
   * `lib/tab-order`). Tabs never moved are not in it and sit at the end.
   */
  tabOrder: TabKey[];
  /** Store one project's strip in its new order. */
  arrangeTabs: (arranged: TabKey[]) => void;
  /**
   * Rebuild tabs for sessions Rust still holds but this webview doesn't know
   * about — what a dev-server reload leaves behind.
   */
  restoreTerminals: (projects: ProjectRef[]) => Promise<void>;

  openPath: (path: string, name: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string | null) => void;
  editFile: (path: string, content: string) => void;
  saveFileAt: (path: string) => Promise<void>;

  toggleShowIgnored: () => void;
  setError: (e: string | null, detail?: string | null) => void;
}

/** Sessions whose process is still running — what the quit and reload guards count. */
export function liveTerminals(terminals: TermSession[]): TermSession[] {
  return terminals.filter((t) => t.alive);
}

/** Files with edits that are not on disk — the other thing quitting would lose. */
export function dirtyFiles(files: OpenFile[]): OpenFile[] {
  return files.filter((f) => f.content !== f.saved);
}

/** The tabs one project owns; everything else stays open but out of sight. */
export function terminalsFor(terminals: TermSession[], projectId: string | null): TermSession[] {
  return terminals.filter((t) => t.projectId === projectId);
}

export function filesFor(files: OpenFile[], projectId: string | null): OpenFile[] {
  return files.filter((f) => f.projectId === projectId);
}

/**
 * Live sessions the current project does not show: other projects' terminals and
 * the ones that match no project at all. They keep running, so there has to be a
 * way to see and kill them from here.
 */
export function hiddenTerminals(terminals: TermSession[], projectId: string | null): TermSession[] {
  return terminals.filter((t) => t.projectId !== projectId && t.alive);
}

/**
 * What a Claude terminal needs for its `Stop` hook: the flag and the
 * environment. Nothing when the signal folder could not be set up — the
 * terminal still opens, it just cannot say when it is done.
 */
async function hookFor(kind: TermKind, ptyId: string): Promise<{ hooks: boolean; env?: Record<string, string> }> {
  if (kind !== "claude") return { hooks: false };
  const paths = await agentSignalPaths();
  return paths ? { hooks: true, env: signalEnv(ptyId, paths.dir, paths.settings) } : { hooks: false };
}

/** Merge two optional environments; undefined when both are. */
function withEnv(a?: Record<string, string>, b?: Record<string, string>): Record<string, string> | undefined {
  return a || b ? { ...a, ...b } : undefined;
}

/** Paths compare by shape, not by spelling: Windows mixes separators and case. */
function samePath(a: string, b: string): boolean {
  // the trailing separator comes off in a loop: an anchored `/+$` backtracks
  const norm = (v: string): string => {
    let out = v.replace(/\\/g, "/").toLowerCase();
    while (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  };
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * A closed tab must not stay in any project's memory: coming back would try to
 * select an id that no longer exists and land on nothing.
 */
function forgetTerminal(memory: Record<string, TabMemory>, id: string): Record<string, TabMemory> {
  const out: Record<string, TabMemory> = {};
  for (const [key, mem] of Object.entries(memory)) {
    out[key] = mem.activeTerminal === id ? { ...mem, activeTerminal: null } : mem;
  }
  return out;
}

function forgetFile(memory: Record<string, TabMemory>, path: string): Record<string, TabMemory> {
  const out: Record<string, TabMemory> = {};
  for (const [key, mem] of Object.entries(memory)) {
    out[key] = mem.activeFile === path ? { ...mem, activeFile: null } : mem;
  }
  return out;
}

/**
 * The status map plus every folder above a changed file, so a collapsed folder
 * can say that something inside it moved without the tree having read it.
 */
function statusFrom(changes: GitChange[]): {
  gitStatus: Record<string, GitFileStatus>;
  gitDirs: Record<string, true>;
} {
  const gitStatus: Record<string, GitFileStatus> = {};
  const gitDirs: Record<string, true> = {};
  for (const change of changes) {
    if (!change.path) continue;
    gitStatus[change.path] = classifyStatus(change.code);
    const parts = change.path.split("/");
    parts.pop();
    let dir = "";
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      gitDirs[dir] = true;
    }
  }
  return { gitStatus, gitDirs };
}

function sameStatus(
  a: Record<string, GitFileStatus>,
  b: Record<string, GitFileStatus>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** One `git status` at a time: the heartbeat must not stack up on a big repo. */
let refreshing = false;

const COLS = 80;
const ROWS = 24;

export const useBench = create<BenchState>((set, get) => ({
  projectId: null,
  root: null,
  remembered: {},
  gitStatus: {},
  gitDirs: {},

  setProject: (projectId, root) =>
    set((s) => {
      if (s.projectId === projectId) return s;
      // park where we were, so coming back is not the first tab all over again
      const remembered = s.projectId
        ? {
            ...s.remembered,
            [s.projectId]: { activeTerminal: s.activeTerminal, activeFile: s.activeFile, focus: s.focus },
          }
        : s.remembered;
      const mem = remembered[projectId];
      const terms = terminalsFor(s.terminals, projectId);
      const files = filesFor(s.files, projectId);
      const activeTerminal = terms.some((t) => t.id === mem?.activeTerminal)
        ? (mem?.activeTerminal ?? null)
        : (terms[terms.length - 1]?.id ?? null);
      const activeFile = files.some((f) => f.path === mem?.activeFile)
        ? (mem?.activeFile ?? null)
        : (files[files.length - 1]?.path ?? null);
      // whatever was remembered, the surface has to be something that exists
      let focus: Focus = mem?.focus ?? "terminal";
      if (focus === "conflict" && s.conflict?.projectId !== projectId) focus = "terminal";
      if (focus === "file" && !activeFile) focus = "terminal";
      else if (focus === "terminal" && !activeTerminal && activeFile) focus = "file";
      return {
        projectId,
        root,
        remembered,
        activeTerminal,
        activeFile,
        focus,
        // another repo's working tree says nothing about this one
        gitStatus: {},
        gitDirs: {},
        // hits and a pending jump belong to the tree they were found in
        query: "",
        nameHits: [],
        contentHits: [],
        searchError: null,
        searchTruncated: false,
        searching: false,
        reveal: null,
      };
    }),

  applyGitChanges: (changes) => {
    const next = statusFrom(changes);
    if (!sameStatus(get().gitStatus, next.gitStatus)) set(next);
  },

  refreshGitStatus: async () => {
    const { root, projectId } = get();
    if (!root || refreshing) return;
    refreshing = true;
    try {
      const state = await gitState(root);
      // the user can switch projects mid-call; a late answer must not repaint
      if (get().projectId !== projectId) return;
      const next = state.repo ? statusFrom(state.changes) : { gitStatus: {}, gitDirs: {} };
      // the heartbeat's answer is usually the same; an identical map would repaint the tree
      if (!sameStatus(get().gitStatus, next.gitStatus)) set(next);
    } catch {
      /* not a repo, no git on PATH — the tree simply shows no status */
    } finally {
      refreshing = false;
    }
  },

  terminals: [],
  activeTerminal: null,
  files: [],
  activeFile: null,
  focus: "terminal",
  showIgnored: false,
  showDotfiles: true,
  error: null,
  errorDetail: null,
  conflict: null,
  openConflict: (tab) => set((s) => ({ conflict: { ...tab, projectId: s.projectId }, focus: "conflict" })),
  closeConflict: () =>
    set((s) => ({
      conflict: null,
      focus: s.focus === "conflict" ? (filesFor(s.files, s.projectId).length && s.activeFile ? "file" : "terminal") : s.focus,
    })),
  dock: "files",
  lastDock: "files",

  openDock: (panel) => set({ dock: panel, lastDock: panel }),
  toggleDock: () => set((s) => ({ dock: s.dock ? null : s.lastDock })),

  query: "",
  searchMode: "names",
  nameHits: [],
  contentHits: [],
  searchEngine: "",
  searchTruncated: false,
  searchError: null,
  searching: false,
  searchFocusSeq: 0,

  focusSearch: (mode) =>
    set((s) => ({
      dock: "files",
      lastDock: "files",
      searchMode: mode,
      searchFocusSeq: s.searchFocusSeq + 1,
    })),

  setQuery: (root, query) => {
    set({ query });
    // names filter as you type; content search is expensive, so it waits for Enter
    if (get().searchMode === "names") void get().runSearch(root);
  },

  setSearchMode: (root, searchMode) => {
    set({ searchMode });
    if (get().query.trim()) void get().runSearch(root);
  },

  runSearch: async (root) => {
    const { query, searchMode } = get();
    const q = query.trim();
    if (!q) {
      set({ nameHits: [], contentHits: [], searchError: null, searchTruncated: false, searching: false });
      return;
    }
    set({ searching: true, searchError: null });
    try {
      if (searchMode === "names") {
        set({ nameHits: await searchFileNames(root, q), searching: false });
      } else {
        const out = await searchContent(root, q);
        set({
          contentHits: out.hits,
          searchEngine: out.engine,
          searchTruncated: out.truncated,
          searchError: out.error ?? null,
          searching: false,
        });
      }
    } catch (e) {
      set({ searching: false, searchError: e instanceof Error ? e.message : String(e) });
    }
  },

  reveal: null,
  clearReveal: () => set({ reveal: null }),
  openAt: async (path, name, line) => {
    await get().openPath(path, name);
    if (get().files.some((f) => f.path === path)) set({ reveal: { path, line } });
  },

  newTerminal: async (kind, cwd, opts) => {
    const id = uid("pty_");
    const launcher = LAUNCHERS.find((l) => l.kind === kind);
    try {
      const shell = await resolveShell();
      // the agent goes in as an argument: input written into a PTY before the
      // shell's line editor is up gets swallowed. The prompt travels in the
      // environment, because quoting it into the command line does not survive MSYS2
      const projectId = get().projectId;
      const n = terminalsFor(get().terminals, projectId).filter((t) => t.kind === kind).length + 1;
      const base = kind === "shell" ? shell.label : (launcher?.label ?? shell.label);
      const suffix = n > 1 ? ` ${n}` : "";
      // a tab opened by a skill is named after it: three "Claude" tabs say nothing
      const script = kind === "shell" && opts?.command ? opts.command : null;
      const title = script
        ? `▸ ${opts?.label ?? script}`
        : opts?.label
          ? `${base} · ${opts.label}`
          : `${base}${suffix}`;
      const hook = await hookFor(kind, id);
      await ptySpawn({
        id,
        program: shell.program,
        // the agent's full path when it lives outside PATH, so any shell can start it
        args: shellArgs(
          shell,
          script
            ? scriptShellCommand(shell)
            : agentCommand(shell, kind, opts?.prompt, launcher?.bin ? await binCommand(launcher.bin) : undefined, {
                hooks: hook.hooks,
              }),
        ),
        env: script ? { [COMMAND_ENV]: script } : withEnv(promptEnv(shell, opts?.prompt), hook.env),
        cwd,
        cols: COLS,
        rows: ROWS,
        title,
        kind,
        projectId,
      });
      set((s) => ({
        terminals: [
          ...s.terminals,
          {
            id,
            title,
            defaultTitle: title,
            kind,
            cwd,
            projectId,
            alive: true,
            // an agent tab or a script already ran a command, so it counts as used
            used: kind !== "shell" || !!opts?.prompt || !!script,
          },
        ],
        activeTerminal: id,
        focus: "terminal",
      }));
      // a shell or an agent opened here is work on this project
      if (projectId) void useApp.getState().touchProject(projectId);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  closeTerminal: async (id) => {
    await ptyKill(id).catch(() => {});
    set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id);
      const { [id]: _gone, ...attention } = s.attention;
      const mine = terminalsFor(terminals, s.projectId);
      const activeTerminal = s.activeTerminal === id ? (mine[mine.length - 1]?.id ?? null) : s.activeTerminal;
      return {
        terminals,
        activeTerminal,
        attention,
        remembered: forgetTerminal(s.remembered, id),
        // nothing left to look at on this side: fall back to a file if there is one
        focus: !activeTerminal && filesFor(s.files, s.projectId).length ? "file" : s.focus,
      };
    });
  },

  setActiveTerminal: (id) =>
    set((s) => {
      // opening the tab is having seen it
      if (!id || !s.attention[id]) return { activeTerminal: id, focus: "terminal" };
      const { [id]: _seen, ...attention } = s.attention;
      return { activeTerminal: id, focus: "terminal", attention };
    }),

  attention: {},
  agentStopped: async ({ id, message }) => {
    const s = get();
    const term = s.terminals.find((x) => x.id === id);
    if (!term) return;
    // looking at it right now: the answer is on screen, a notification is noise
    const onScreen =
      document.hasFocus() &&
      useUI.getState().view === "bench" &&
      s.projectId === term.projectId &&
      s.focus === "terminal" &&
      s.activeTerminal === id;
    if (onScreen) return;
    set((x) => ({ attention: { ...x.attention, [id]: true } }));
    if (!(await agentNotificationsEnabled())) return;
    const project = useApp.getState().projects.find((p) => p.id === term.projectId)?.name;
    const where = project ? `${project} › ${term.title}` : term.title;
    await notify(tr("Claude finished · {where}", { where }), message ?? tr("Waiting for your next message."));
  },

  markTerminalDead: (id) =>
    set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? { ...t, alive: false } : t)) })),

  markTerminalUsed: (id) =>
    set((s) =>
      s.terminals.some((t) => t.id === id && !t.used)
        ? { terminals: s.terminals.map((t) => (t.id === id ? { ...t, used: true } : t)) }
        : s,
    ),

  renameTerminal: async (id, title) => {
    try {
      const name = await ptyRename(id, title);
      set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? { ...t, title: name } : t)) }));
    } catch {
      // the process is gone and Rust forgot it; the tab still takes the name
      set((s) => ({
        terminals: s.terminals.map((t) => (t.id === id ? { ...t, title: title.trim() || t.defaultTitle } : t)),
      }));
    }
  },

  tabOrder: [],
  arrangeTabs: (arranged) => set((s) => ({ tabOrder: storeOrder(s.tabOrder, arranged) })),

  restoreTerminals: async (projects) => {
    const sessions = await ptyList().catch(() => []);
    if (!sessions.length) return;
    set((s) => {
      const known = new Set(s.terminals.map((t) => t.id));
      const recovered: TermSession[] = [];
      for (const x of sessions) {
        if (known.has(x.id)) continue;
        recovered.push({
          id: x.id,
          title: x.title,
          defaultTitle: x.defaultTitle || x.title,
          kind: (["shell", "claude", "opencode", "hermes"].includes(x.kind) ? x.kind : "shell") as TermKind,
          cwd: x.cwd,
          // Rust carries the project for anything spawned by this build; an
          // older session only left its cwd, so the folder is what identifies it
          projectId: x.projectId ?? projects.find((p) => p.path && samePath(p.path, x.cwd))?.id ?? null,
          alive: x.alive,
          // it survived a reload, so it was doing something worth keeping
          used: true,
        });
      }
      if (!recovered.length) return s;
      const terminals = [...s.terminals, ...recovered];
      const mine = terminalsFor(terminals, s.projectId);
      return { terminals, activeTerminal: s.activeTerminal ?? mine[0]?.id ?? null };
    });
  },

  openPath: async (path, name) => {
    const existing = get().files.find((f) => f.path === path);
    if (existing) {
      set({ activeFile: path, focus: "file" });
      return;
    }
    const res = await readForEditor(path, name);
    if (!res.ok) {
      set({ error: `${name}: ${res.reason}` });
      return;
    }
    const openedAt = await modifiedAt(path);
    const projectId = get().projectId;
    set((s) => ({
      // the dock stays as the user left it: the file itself shows up as a tab
      files: [
        ...s.files,
        {
          path,
          name,
          projectId,
          content: res.content,
          saved: res.content,
          readOnly: res.readOnly,
          note: res.note,
          openedAt,
        },
      ],
      activeFile: path,
      focus: "file",
      error: null,
    }));
  },

  closeFile: (path) =>
    set((s) => {
      const files = s.files.filter((f) => f.path !== path);
      const mine = filesFor(files, s.projectId);
      const activeFile = s.activeFile === path ? (mine[mine.length - 1]?.path ?? null) : s.activeFile;
      return {
        files,
        activeFile,
        remembered: forgetFile(s.remembered, path),
        // the last tab closed hands the work area back to the terminal
        focus: !activeFile ? "terminal" : s.focus,
      };
    }),

  setActiveFile: (path) => set({ activeFile: path, focus: "file" }),

  editFile: (path, content) =>
    set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, content } : f)) })),

  saveFileAt: async (path) => {
    const file = get().files.find((f) => f.path === path);
    if (!file || file.readOnly || file.content === file.saved) return;
    // an agent in the next tab may have rewritten this file while it sat open
    const current = await modifiedAt(path);
    if (file.openedAt !== null && current !== null && current > file.openedAt) {
      set({
        error: tr(
          "{name} changed on disk since you opened it. Close the tab and reopen it before saving, or your version wins.",
          { name: file.name },
        ),
      });
      set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, openedAt: current } : f)) }));
      return;
    }
    try {
      await saveFile(path, file.content);
      const savedAt = await modifiedAt(path);
      set((s) => ({
        files: s.files.map((f) => (f.path === path ? { ...f, saved: f.content, openedAt: savedAt } : f)),
        error: null,
      }));
      // the file just became modified, or stopped being — repaint the tree
      void get().refreshGitStatus();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  toggleShowIgnored: () => set((s) => ({ showIgnored: !s.showIgnored })),
  toggleShowDotfiles: () => set((s) => ({ showDotfiles: !s.showDotfiles })),

  resumeSession: async (sessionId, cwd) => {
    // the id is typed into a shell command line, so anything but a plain id is refused
    if (!isSafeSessionId(sessionId)) {
      set({ error: tr("This session id is not one Claude would write, so it was not resumed.") });
      return;
    }
    const id = uid("pty_");
    const projectId = get().projectId;
    const title = `Claude ${sessionId.slice(0, 6)}`;
    try {
      const shell = await resolveShell();
      const hook = await hookFor("claude", id);
      await ptySpawn({
        id,
        program: shell.program,
        args: shellArgs(
          shell,
          `${agentCommand(shell, "claude", undefined, await binCommand("claude"), { hooks: hook.hooks })} --resume ${sessionId}`,
        ),
        env: hook.env,
        cwd,
        cols: COLS,
        rows: ROWS,
        title,
        kind: "claude",
        projectId,
      });
      set((s) => ({
        terminals: [
          ...s.terminals,
          {
            id,
            title,
            defaultTitle: title,
            kind: "claude",
            cwd,
            projectId,
            alive: true,
            used: true,
          },
        ],
        activeTerminal: id,
        focus: "terminal",
      }));
      // resuming a session is work on this project, like opening an agent
      if (projectId) void useApp.getState().touchProject(projectId);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  setError: (error, detail = null) => set({ error, errorDetail: error && detail ? { error, text: detail } : null }),
}));
