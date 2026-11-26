import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { GitMerge, Globe, Image as ImageIcon, Lock, Pencil, Plus, Save, X } from "lucide-react";
import * as React from "react";
import { availableLaunchers, droppedPathText, LAUNCHERS, resolveShell, type TermKind } from "@/lib/bench-term";
import { filesFor, previewsFor, terminalsFor, useBench, type Focus } from "@/store/bench";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ConflictView } from "./ConflictView";
import { ScriptsBar } from "./ScriptsBar";
import { EditorPane } from "./EditorPane";
import { TerminalPane } from "./TerminalPane";
import { PreviewPane } from "./PreviewPane";
import { relPath } from "@/lib/git";
import { useFileDrop } from "@/lib/file-drop";
import { isDirectory } from "@/lib/fs-tree";
import { ptyWrite } from "@/lib/pty";
import { fileGlyph, launcherGlyph, statusGlyph } from "./icons";
import { fileKey, moveTab, nudgeTab, orderTabs, previewKey, terminalKey, type TabKey } from "@/lib/tab-order";

/**
 * One tab strip (terminals and open files together) over one surface. Both
 * surfaces stay mounted and hidden: an unmounted xterm loses its screen and an
 * unmounted Monaco its cursor.
 */

function TabShell({
  active,
  title,
  onSelect,
  onClose,
  closeLabel,
  closeTitle,
  children,
  drag,
  editing,
  onRename,
  onMenu,
}: {
  active: boolean;
  title: string;
  onSelect: () => void;
  onClose: () => void;
  closeLabel: string;
  closeTitle: string;
  children: React.ReactNode;
  /** Wiring from `useTabDrag`; the conflict tab has none, it is not movable. */
  drag?: TabDragProps;
  /** Replaces the label while the tab is being renamed. */
  editing?: React.ReactNode;
  /** Terminals only: double-click renames in place. */
  onRename?: () => void;
  /** Terminals only: right-click opens the tab's menu at the pointer. */
  onMenu?: (x: number, y: number) => void;
}) {
  return (
    <div
      data-tab-key={drag?.tabKey}
      onPointerDown={drag?.onPointerDown}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-full border pl-2.5 pr-1 text-[11px] transition-colors",
        active ? "border-accent/40 bg-accent-soft text-accent" : "border-border text-text-2 hover:bg-surface-2",
        drag?.state === "source" && "opacity-50",
        drag?.state === "target" && "ring-1 ring-accent",
      )}
    >
      {editing ?? (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={onRename}
          className="flex cursor-pointer items-center gap-1.5"
          title={title}
        >
          {children}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        title={closeTitle}
        className="cursor-pointer rounded-full p-1 text-text-3 transition-colors hover:bg-surface hover:text-danger focus-visible:outline-2 focus-visible:outline-accent"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

interface TabDragProps {
  tabKey: TabKey;
  state: "source" | "target" | null;
  onPointerDown: (e: React.PointerEvent) => void;
}

/** How far the pointer travels before a press on a tab becomes a drag, not a click. */
const DRAG_THRESHOLD = 5;

/**
 * Tab reordering on pointer events, not HTML5 drag and drop: Tauri takes drops
 * at the OS level, which on Windows silences the webview's `dragover`/`drop`.
 * The target is found by `data-tab-key`; the move happens on release.
 */
function useTabDrag(onMove: (from: TabKey, to: TabKey) => void) {
  const [drag, setDrag] = React.useState<{ from: TabKey; over: TabKey | null } | null>(null);
  const press = React.useRef<{ key: TabKey; x: number; y: number; moving: boolean } | null>(null);
  const move = React.useRef(onMove);
  React.useEffect(() => {
    move.current = onMove;
  });

  React.useEffect(() => {
    const keyAt = (x: number, y: number): TabKey | null =>
      (document.elementFromPoint(x, y)?.closest("[data-tab-key]")?.getAttribute("data-tab-key") as TabKey | null) ??
      null;
    const onMovePointer = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.moving && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
      p.moving = true;
      const over = keyAt(e.clientX, e.clientY);
      setDrag((d) => (d && d.over === over ? d : { from: p.key, over }));
    };
    const onUp = (e: PointerEvent) => {
      const p = press.current;
      press.current = null;
      if (!p?.moving) return;
      const over = keyAt(e.clientX, e.clientY);
      if (over && over !== p.key) move.current(p.key, over);
      setDrag(null);
    };
    window.addEventListener("pointermove", onMovePointer);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMovePointer);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (key: TabKey): TabDragProps => ({
    tabKey: key,
    state: drag?.from === key ? "source" : drag && drag.over === key ? "target" : null,
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      press.current = { key, x: e.clientX, y: e.clientY, moving: false };
    },
  });
}

/** The label turned into a field: Enter or leaving keeps it, Escape drops it, empty restores the original. */
function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const t = useT();
  const [value, setValue] = React.useState(initial);
  const done = React.useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
      aria-label={t("Tab name")}
      placeholder={t("Empty restores the original name")}
      className="w-[140px] bg-transparent text-[11px] text-text outline-none placeholder:text-text-3"
    />
  );
}

/** Right-click menu on a terminal tab. */
function TabMenu({
  at,
  onRename,
  onClose,
}: {
  at: { x: number; y: number } | null;
  onRename: () => void;
  onClose: () => void;
}) {
  const t = useT();
  if (!at) return null;
  return (
    <Dropdown.Root open onOpenChange={(o) => !o && onClose()}>
      <Dropdown.Trigger asChild>
        <span aria-hidden style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }} />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="start"
          sideOffset={2}
          // the field takes focus next; giving it back to the tab would blur it at once
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-50 min-w-[160px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
        >
          <Dropdown.Item
            onSelect={onRename}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-2 outline-none transition-colors data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
          >
            <Pencil className="h-3.5 w-3.5" /> {t("Rename")}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function NewTerminalMenu({ onPick }: { onPick: (kind: TermKind) => void }) {
  const t = useT();
  const [ready, setReady] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => {
    void availableLaunchers().then(setReady);
  }, []);
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full",
            "bg-surface-2 text-text-2 transition-colors hover:bg-accent-soft hover:text-accent",
            "focus-visible:outline-2 focus-visible:outline-accent",
            "data-[state=open]:bg-accent-soft data-[state=open]:text-accent",
          )}
          title={t("New terminal")}
          aria-label={t("New terminal")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-[200px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
        >
          {LAUNCHERS.map((l) => {
            const available = ready[l.kind] !== false;
            const { Icon, tone } = launcherGlyph(l.kind);
            return (
              <Dropdown.Item
                key={l.kind}
                disabled={!available}
                onSelect={() => onPick(l.kind)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors",
                  available
                    ? "cursor-pointer text-text-2 data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
                    : "cursor-not-allowed text-text-3 opacity-50",
                )}
              >
                <Icon className={cn("h-3.5 w-3.5 shrink-0", available ? tone : "text-text-3")} />
                <span className="flex-1">{t(l.label)}</span>
                {!available && <span className="text-[10px]">{t("not installed")}</span>}
              </Dropdown.Item>
            );
          })}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** What the user asked to close, while we ask whether they meant it. */
type PendingClose = { kind: "file"; path: string } | { kind: "terminal"; id: string };

export function WorkArea({ cwd }: { cwd: string }) {
  const t = useT();
  // the strip shows one project at a time; the rest stay open and keep running
  const projectId = useBench((s) => s.projectId);
  const allTerminals = useBench((s) => s.terminals);
  const allFiles = useBench((s) => s.files);
  const terminals = React.useMemo(() => terminalsFor(allTerminals, projectId), [allTerminals, projectId]);
  const files = React.useMemo(() => filesFor(allFiles, projectId), [allFiles, projectId]);
  const allPreviews = useBench((s) => s.previews);
  const previews = React.useMemo(() => previewsFor(allPreviews, projectId), [allPreviews, projectId]);
  const activePreview = useBench((s) => s.activePreview);
  const setActivePreview = useBench((s) => s.setActivePreview);
  const closePreview = useBench((s) => s.closePreview);
  const activeTerminal = useBench((s) => s.activeTerminal);
  const setActiveTerminal = useBench((s) => s.setActiveTerminal);
  const closeTerminal = useBench((s) => s.closeTerminal);
  const newTerminal = useBench((s) => s.newTerminal);
  const activeFile = useBench((s) => s.activeFile);
  const setActiveFile = useBench((s) => s.setActiveFile);
  const closeFile = useBench((s) => s.closeFile);
  const saveFileAt = useBench((s) => s.saveFileAt);
  const focus: Focus = useBench((s) => s.focus);
  const gitStatus = useBench((s) => s.gitStatus);
  const openPath = useBench((s) => s.openPath);
  const conflictTab = useBench((s) => s.conflict);
  const closeConflict = useBench((s) => s.closeConflict);
  const conflict = conflictTab?.projectId === projectId ? conflictTab : null;
  const tabOrder = useBench((s) => s.tabOrder);
  const arrangeTabs = useBench((s) => s.arrangeTabs);
  const renameTerminal = useBench((s) => s.renameTerminal);
  const attention = useBench((s) => s.attention);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [tabMenu, setTabMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);

  // the strip in the user's order; a tab never moved sits at the end
  const orderedKeys = React.useMemo(
    () =>
      orderTabs(
        [
          ...terminals.map((x) => terminalKey(x.id)),
          ...files.map((f) => fileKey(f.path)),
          ...previews.map((p) => previewKey(p.id)),
        ],
        tabOrder,
      ),
    [terminals, files, previews, tabOrder],
  );
  const dragProps = useTabDrag((from, to) => arrangeTabs(moveTab(orderedKeys, from, to)));

  const file = files.find((f) => f.path === activeFile) ?? null;
  const dirty = !!file && file.content !== file.saved;
  const showingConflict = focus === "conflict" && !!conflict;
  const showingFile = focus === "file" && !!file;
  const preview = previews.find((p) => p.id === activePreview) ?? null;
  const showingPreview = focus === "preview" && !!preview;

  // a desktop drop types the paths into the terminal, or opens them in the editor
  const dropOnTerminal = async (paths: string[]): Promise<void> => {
    if (!activeTerminal) return;
    const session = terminals.find((x) => x.id === activeTerminal);
    const shell = await resolveShell();
    const text = droppedPathText(shell, session?.cwd ?? cwd, paths);
    // typed, never run: no newline goes with it
    if (text) await ptyWrite(activeTerminal, text);
  };

  const dropOnEditor = async (paths: string[]): Promise<void> => {
    for (const path of paths) {
      // a folder is not an error here, it is simply not something to open
      if (await isDirectory(path)) continue;
      const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
      await openPath(path, name);
    }
  };

  const dropZone = useFileDrop((zone, paths) => {
    void (zone === "terminal" ? dropOnTerminal(paths) : dropOnEditor(paths));
  });

  const [pending, setPending] = React.useState<PendingClose | null>(null);
  const pendingFile = pending?.kind === "file" ? files.find((f) => f.path === pending.path) : undefined;
  const pendingTerm = pending?.kind === "terminal" ? terminals.find((x) => x.id === pending.id) : undefined;

  /** Unsaved work and live sessions are worth a question; nothing else is. */
  const requestCloseFile = (path: string) => {
    const target = files.find((f) => f.path === path);
    if (target && target.content !== target.saved) setPending({ kind: "file", path });
    else closeFile(path);
  };

  const requestCloseTerminal = (id: string) => {
    const target = terminals.find((x) => x.id === id);
    if (target?.alive && target.used) setPending({ kind: "terminal", id });
    else void closeTerminal(id);
  };

  // read through a ref so the key listener is registered once
  const shortcuts = React.useRef<{ closeActive: () => void; focusTerminal: () => void; nudge: (step: -1 | 1) => void }>({
    closeActive: () => {},
    focusTerminal: () => {},
    nudge: () => {},
  });
  // written after the commit, before the listener below can fire: render is pure
  React.useEffect(() => {
    shortcuts.current = {
      closeActive: () => {
        if (showingFile && file) requestCloseFile(file.path);
        else if (showingPreview && preview) closePreview(preview.id);
        else if (activeTerminal) requestCloseTerminal(activeTerminal);
      },
      focusTerminal: () => {
        if (activeTerminal) setActiveTerminal(activeTerminal);
      },
      nudge: (step) => {
        const key =
          showingFile && file
            ? fileKey(file.path)
            : showingPreview && preview
              ? previewKey(preview.id)
              : activeTerminal
                ? terminalKey(activeTerminal)
                : null;
        if (key) arrangeTabs(nudgeTab(orderedKeys, key, step));
      },
    };
  });

  // Ctrl+W closes the front tab; Ctrl+` focuses the shell; Ctrl+Shift+PageUp/Down
  // moves the front tab (not the arrows: editor and shells select words with them)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown")) {
        e.preventDefault();
        e.stopPropagation();
        shortcuts.current.nudge(e.key === "PageUp" ? -1 : 1);
        return;
      }
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        shortcuts.current.closeActive();
      } else if (e.key === "`") {
        e.preventDefault();
        shortcuts.current.focusTerminal();
      }
    };
    // capture: the editor would otherwise take PageUp/PageDown before we see them
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div
        data-drop-zone="editor"
        className={cn(
          "flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2",
          dropZone === "editor" && !showingFile && "ring-1 ring-inset ring-accent",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {orderedKeys.map((key) => {
            if (key.startsWith("t:")) {
              const term = terminals.find((x) => terminalKey(x.id) === key);
              if (!term) return null;
              const { Icon, tone } = launcherGlyph(term.kind);
              const active = !showingFile && !showingConflict && !showingPreview && term.id === activeTerminal;
              return (
                <TabShell
                  key={key}
                  active={active}
                  title={term.cwd}
                  onSelect={() => setActiveTerminal(term.id)}
                  onClose={() => requestCloseTerminal(term.id)}
                  closeLabel={t("Close {name}", { name: term.title })}
                  closeTitle={term.alive ? t("Kill and close") : t("Close")}
                  drag={dragProps(key)}
                  onRename={() => setRenaming(term.id)}
                  onMenu={(x, y) => setTabMenu({ id: term.id, x, y })}
                  editing={
                    renaming === term.id ? (
                      <span className="flex items-center gap-1.5">
                        <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : tone)} />
                        <RenameField
                          initial={term.title}
                          onDone={(name) => {
                            setRenaming(null);
                            if (name !== null && name !== term.title) void renameTerminal(term.id, name);
                          }}
                        />
                      </span>
                    ) : undefined
                  }
                >
                  <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : tone)} />
                  <span className={cn("max-w-[130px] truncate", !term.alive && "line-through opacity-60")}>
                    {term.title}
                  </span>
                  {attention[term.id] && (
                    <span
                      role="img"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      title={t("Claude finished while you were away")}
                      aria-label={t("Claude finished while you were away")}
                    />
                  )}
                </TabShell>
              );
            }
            if (key.startsWith("p:")) {
              const p = previews.find((x) => previewKey(x.id) === key);
              if (!p) return null;
              const active = showingPreview && p.id === activePreview;
              const label = p.target.kind === "url" ? p.target.url.replace(/^https?:\/\//, "") : p.target.name;
              const PreviewIcon = p.target.kind === "url" ? Globe : ImageIcon;
              return (
                <TabShell
                  key={key}
                  drag={dragProps(key)}
                  active={active}
                  title={p.id}
                  onSelect={() => setActivePreview(p.id)}
                  onClose={() => closePreview(p.id)}
                  closeLabel={t("Close {name}", { name: label })}
                  closeTitle={t("Close")}
                >
                  <PreviewIcon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : "text-low")} />
                  <span className="max-w-[160px] truncate">{label}</span>
                </TabShell>
              );
            }
            const f = files.find((x) => fileKey(x.path) === key);
            if (!f) return null;
            const { Icon, tone } = fileGlyph(f.name);
            const active = showingFile && f.path === activeFile;
            const unsaved = f.content !== f.saved;
            // the same state the tree shows, where you are actually editing
            const status = gitStatus[relPath(cwd, f.path)];
            const mark = status ? statusGlyph(status) : null;
            return (
              <TabShell
                key={key}
                drag={dragProps(key)}
                active={active}
                title={f.path}
                onSelect={() => setActiveFile(f.path)}
                onClose={() => requestCloseFile(f.path)}
                closeLabel={t("Close {name}", { name: f.name })}
                closeTitle={t("Close")}
              >
                <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : tone)} />
                {f.readOnly && <Lock className="h-3 w-3 shrink-0 text-warn" />}
                <span className={cn("max-w-[130px] truncate", !active && mark && mark.tone)}>{f.name}</span>
                {mark && (
                  <span
                    className={cn("shrink-0 font-mono text-[10px]", active ? "text-accent" : mark.tone)}
                    title={t(mark.label)}
                    aria-label={t(mark.label)}
                  >
                    {mark.letter}
                  </span>
                )}
                {unsaved && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t("Unsaved changes")} />
                )}
              </TabShell>
            );
          })}

          {conflict && (
            <TabShell
              active={showingConflict}
              title={conflict.path}
              onSelect={() => useBench.setState({ focus: "conflict" })}
              onClose={closeConflict}
              closeLabel={t("Close {name}", { name: conflict.name })}
              closeTitle={t("Close")}
            >
              <GitMerge className={cn("h-3.5 w-3.5 shrink-0", showingConflict ? "text-accent" : "text-warn")} />
              <span className="max-w-[160px] truncate">{t("Resolve {name}", { name: conflict.name })}</span>
            </TabShell>
          )}

          <NewTerminalMenu onPick={(kind) => void newTerminal(kind, cwd)} />
          <ScriptsBar
            projectId={projectId}
            cwd={cwd}
            onRun={(label, command) => void newTerminal("shell", cwd, { label, command })}
          />
          <TabMenu
            at={tabMenu}
            onClose={() => setTabMenu(null)}
            onRename={() => {
              if (tabMenu) setRenaming(tabMenu.id);
              setTabMenu(null);
            }}
          />
        </div>

        {showingFile && (
          <button
            type="button"
            onClick={() => void saveFileAt(file.path)}
            disabled={!dirty || file.readOnly}
            title={file.readOnly ? t("Read-only") : t("Save (Ctrl+S)")}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] transition-colors",
              "focus-visible:outline-2 focus-visible:outline-accent",
              dirty && !file.readOnly
                ? "cursor-pointer bg-accent-soft text-accent hover:bg-accent-soft/70"
                : "cursor-not-allowed text-text-3",
            )}
          >
            <Save className="h-3 w-3" /> {t("Save")}
          </button>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {/* both stay mounted: an unmounted xterm loses its screen */}
        <div
          data-drop-zone="terminal"
          className={cn(
            "absolute inset-0",
            (showingFile || showingConflict || showingPreview) && "invisible",
            dropZone === "terminal" && "ring-2 ring-inset ring-accent",
          )}
        >
          <TerminalPane />
        </div>
        <div
          data-drop-zone="editor"
          className={cn(
            "absolute inset-0",
            !showingFile && "invisible",
            dropZone === "editor" && "ring-2 ring-inset ring-accent",
          )}
        >
          <EditorPane />
        </div>
        {/* pinned previews stay mounted too: switching tabs must not reload a page */}
        <div className={cn("absolute inset-0", !showingPreview && "invisible")}>
          <PreviewPane previews={previews} active={showingPreview ? activePreview : null} />
        </div>
        {/* kept mounted while another tab is in front: the choices made so far live in it */}
        {conflict && (
          <div className={cn("absolute inset-0", !showingConflict && "invisible")}>
            <ConflictView key={conflict.path} tab={conflict} root={cwd} />
          </div>
        )}
      </div>

      <Dialog open={!!pendingFile} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent title={t("Close without saving?")}>
          <p className="text-[13px] leading-relaxed text-text-2">
            {t("{name} has changes that are not on disk. Closing the tab loses them.", {
              name: pendingFile?.name ?? "",
            })}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingFile) closeFile(pendingFile.path);
                setPending(null);
              }}
            >
              {t("Discard & close")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const target = pendingFile;
                setPending(null);
                if (!target) return;
                // saveFileAt resolves even when it refused (changed on disk) or the write failed —
                // it only sets the store's error. Close only once the tab is really clean.
                void saveFileAt(target.path).then(() => {
                  const after = useBench.getState().files.find((f) => f.path === target.path);
                  if (!after || after.content === after.saved) closeFile(target.path);
                });
              }}
            >
              {t("Save & close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!pendingTerm}
        onOpenChange={(o) => !o && setPending(null)}
        danger
        title={t("Kill this session?")}
        confirmLabel={t("Kill and close")}
        body={
          <p>
            {t(
              "{name} is still running. Closing the tab kills it, and anything it was in the middle of is lost.",
              { name: pendingTerm?.title ?? "" },
            )}
          </p>
        }
        onConfirm={() => {
          if (pendingTerm) void closeTerminal(pendingTerm.id);
          setPending(null);
        }}
      />
    </div>
  );
}
