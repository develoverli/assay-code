import * as React from "react";
import { droppedPathText, resolveShell, type TermKind } from "@/lib/bench-term";
import { filesFor, previewsFor, terminalsFor, useBench } from "@/store/bench";
import { usePanes } from "@/store/panes";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { useFileDrop, type DropTarget } from "@/lib/file-drop";
import { isDirectory } from "@/lib/fs-tree";
import { ptyWrite } from "@/lib/pty";
import {
  activeGroup,
  focusGroup,
  focusTab,
  groupById,
  groupOfTab,
  groupsOf,
  moveTab,
  neighbourGroup,
  nudgeInGroup,
  reconcile,
  reorderTab,
  setSizes,
  splitFits,
  type PaneLayout,
  type Rect,
} from "@/lib/pane-layout";
import { conflictKey, fileKey, orderTabs, previewKey, terminalKey, type TabKey } from "@/lib/tab-order";
import { LinkPreviewPopover } from "./LinkPreview";
import { PaneCtx, PaneGroupView, TabMenu, type PaneContext } from "./PaneGroup";
import { PaneTree } from "./PaneTree";
import { usePaneDrag, type DragTarget } from "./pane-drag";
import { useTerminalLifecycle } from "./TerminalPane";
import { useEditorLifecycle } from "./EditorPane";

/**
 * The work area: terminals, open files, pinned previews and the conflict being
 * resolved, laid out in split panes (`lib/pane-layout`), one layout per project.
 *
 * The store keeps saying which tab is "in front" (`focus` + `activeTerminal` /
 * `activeFile` / `activePreview`), as everything else in the app reads it; here
 * that means the front tab of the **active** pane. The layout holds the fronts of
 * the others. The two are kept in step by one effect: a move in the layout (a
 * drag, a close, a click on another pane) wins and is written to the store; a
 * change in the store alone (a file opened from the tree, a new terminal) is
 * brought into the layout, landing in the active pane.
 */

/** What the user asked to close, while we ask whether they meant it. */
type PendingClose = { kind: "file"; path: string } | { kind: "terminal"; id: string };

/** The pane rectangles on screen, for the keyboard's neighbour and the split-size checks. */
function paneRects(): Record<string, Rect> {
  const out: Record<string, Rect> = {};
  for (const el of document.querySelectorAll<HTMLElement>("[data-pane-group]")) {
    const id = el.getAttribute("data-pane-group");
    if (!id) continue;
    const r = el.getBoundingClientRect();
    out[id] = { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return out;
}

export function WorkArea({ cwd }: { cwd: string }) {
  const t = useT();
  useTerminalLifecycle();
  useEditorLifecycle();

  // the panes show one project at a time; the rest stay open and keep running
  const projectId = useBench((s) => s.projectId);
  const allTerminals = useBench((s) => s.terminals);
  const allFiles = useBench((s) => s.files);
  const allPreviews = useBench((s) => s.previews);
  const terminals = React.useMemo(() => terminalsFor(allTerminals, projectId), [allTerminals, projectId]);
  const files = React.useMemo(() => filesFor(allFiles, projectId), [allFiles, projectId]);
  const previews = React.useMemo(() => previewsFor(allPreviews, projectId), [allPreviews, projectId]);
  const conflictTab = useBench((s) => s.conflict);
  const conflict = conflictTab?.projectId === projectId ? conflictTab : null;
  const focus = useBench((s) => s.focus);
  const activeTerminal = useBench((s) => s.activeTerminal);
  const activeFile = useBench((s) => s.activeFile);
  const activePreview = useBench((s) => s.activePreview);
  const gitStatus = useBench((s) => s.gitStatus);
  const attention = useBench((s) => s.attention);
  const tabOrder = useBench((s) => s.tabOrder);
  const closeTerminal = useBench((s) => s.closeTerminal);
  const closeFile = useBench((s) => s.closeFile);
  const closePreview = useBench((s) => s.closePreview);
  const closeConflict = useBench((s) => s.closeConflict);
  const saveFileAt = useBench((s) => s.saveFileAt);
  const newTerminal = useBench((s) => s.newTerminal);
  const openPath = useBench((s) => s.openPath);

  const paneKey = projectId ?? "";
  const loaded = usePanes((s) => !!s.loaded[paneKey]);
  const stored = usePanes((s) => s.layouts[paneKey]);
  const loadPanes = usePanes((s) => s.load);
  const updatePanes = usePanes((s) => s.update);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [tabMenu, setTabMenu] = React.useState<{ key: TabKey; group: string; x: number; y: number } | null>(null);
  const [pending, setPending] = React.useState<PendingClose | null>(null);

  React.useEffect(() => {
    void loadPanes(paneKey);
  }, [paneKey, loadPanes]);

  const update = React.useCallback((fn: (l: PaneLayout) => PaneLayout) => updatePanes(paneKey, fn), [paneKey, updatePanes]);

  // every tab this project has, in the order the strip had before panes existed
  const existing = React.useMemo(
    () =>
      orderTabs(
        [
          ...terminals.map((x) => terminalKey(x.id)),
          ...files.map((f) => fileKey(f.path)),
          ...previews.map((p) => previewKey(p.id)),
          ...(conflict ? [conflictKey(conflict.path)] : []),
        ],
        tabOrder,
      ),
    [terminals, files, previews, conflict, tabOrder],
  );

  /** The tab the store has in front, when it is one of this project's. */
  const storeKey = React.useMemo((): TabKey | null => {
    let key: TabKey | null = null;
    if (focus === "terminal" && activeTerminal) key = terminalKey(activeTerminal);
    else if (focus === "file" && activeFile) key = fileKey(activeFile);
    else if (focus === "preview" && activePreview) key = previewKey(activePreview);
    else if (focus === "conflict" && conflict) key = conflictKey(conflict.path);
    return key && existing.includes(key) ? key : null;
  }, [focus, activeTerminal, activeFile, activePreview, conflict, existing]);

  /** Put a tab in front in the store, the way a click on it always has. */
  const activateInStore = React.useCallback((key: TabKey) => {
    const s = useBench.getState();
    const id = key.slice(2);
    if (key.startsWith("t:")) s.setActiveTerminal(id);
    else if (key.startsWith("f:")) s.setActiveFile(id);
    else if (key.startsWith("p:")) s.setActivePreview(id);
    else useBench.setState({ focus: "conflict" });
  }, []);

  // closed tabs leave their pane, new ones join the active pane; nothing before the stored layout is read
  React.useEffect(() => {
    if (loaded) update((l) => reconcile(l, existing));
  }, [loaded, existing, update]);

  const layout = stored;
  const frontNow = layout && loaded ? activeGroup(layout).front : null;
  const seen = React.useRef<{ key: TabKey | null; front: TabKey | null; project: string } | null>(null);

  // the store and the active pane agree on what is in front; see the comment at the top
  React.useEffect(() => {
    if (!layout || !loaded) return;
    const prev = seen.current?.project === paneKey ? seen.current : null;
    seen.current = { key: storeKey, front: frontNow, project: paneKey };
    const frontMoved = !prev || prev.front !== frontNow;
    const keyMoved = !prev || prev.key !== storeKey;
    if (frontMoved && frontNow && frontNow !== storeKey && existing.includes(frontNow)) {
      activateInStore(frontNow);
      return;
    }
    if (keyMoved && storeKey && storeKey !== frontNow) update((l) => focusTab(l, storeKey));
  }, [layout, loaded, storeKey, frontNow, paneKey, existing, activateInStore, update]);

  /* --------------------------------- actions --------------------------------- */

  const activateKey = React.useCallback(
    (key: TabKey) => {
      update((l) => focusTab(l, key));
      activateInStore(key);
    },
    [update, activateInStore],
  );

  const requestClose = (key: TabKey) => {
    const id = key.slice(2);
    if (key.startsWith("t:")) {
      const target = terminals.find((x) => x.id === id);
      // a live session someone typed into is worth a question; nothing else is
      if (target?.alive && target.used) setPending({ kind: "terminal", id });
      else void closeTerminal(id);
    } else if (key.startsWith("f:")) {
      const target = files.find((f) => f.path === id);
      if (target && target.content !== target.saved) setPending({ kind: "file", path: id });
      else closeFile(id);
    } else if (key.startsWith("p:")) closePreview(id);
    else closeConflict();
  };

  /** Why `key` cannot be split off its pane on that edge right now, or null. */
  const splitBlocked = (key: TabKey, edge: "right" | "bottom"): string | null => {
    if (!layout) return t("Not ready yet.");
    const g = groupOfTab(layout, key);
    if (!g) return t("Not ready yet.");
    if (g.tabs.length < 2) return t("This is the only tab in its panel.");
    const r = paneRects()[g.id];
    if (r && !splitFits(r.width, r.height, edge)) return t("Not enough room to split this panel.");
    return null;
  };

  const split = (key: TabKey, edge: "right" | "bottom") => {
    if (!layout || splitBlocked(key, edge)) return;
    const g = groupOfTab(layout, key);
    if (g) update((l) => moveTab(l, key, g.id, edge));
  };

  const onDrop = (from: TabKey, target: DragTarget) => {
    if (target.kind === "tab") {
      const same = layout && groupOfTab(layout, from)?.id === target.group;
      update((l) => (same ? reorderTab(l, from, target.key) : moveTab(l, from, target.group, "center", target.key)));
    } else if (target.kind === "strip") update((l) => moveTab(l, from, target.group, "center"));
    else update((l) => moveTab(l, from, target.group, target.edge));
  };

  const drag = usePaneDrag(layout ?? { root: { kind: "group", id: "", tabs: [], front: null }, active: "" }, onDrop);

  // a desktop drop types the paths into that pane's terminal, or opens them in that pane
  const dropOnTerminal = async (groupId: string | null, paths: string[]): Promise<void> => {
    const g = layout && groupId ? groupById(layout, groupId) : null;
    const id = g?.front?.startsWith("t:") ? g.front.slice(2) : activeTerminal;
    if (!id) return;
    const session = terminals.find((x) => x.id === id);
    const shell = await resolveShell();
    const text = droppedPathText(shell, session?.cwd ?? cwd, paths);
    // typed, never run: no newline goes with it
    if (text) await ptyWrite(id, text);
  };

  const dropOnEditor = async (groupId: string | null, paths: string[]): Promise<void> => {
    if (groupId) update((l) => focusGroup(l, groupId));
    for (const path of paths) {
      // a folder is not an error here, it is simply not something to open
      if (await isDirectory(path)) continue;
      const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
      await openPath(path, name);
    }
  };

  const dropTarget: DropTarget | null = useFileDrop((target, paths) => {
    void (target.zone === "terminal" ? dropOnTerminal(target.group, paths) : dropOnEditor(target.group, paths));
  });

  /* -------------------------------- keyboard --------------------------------- */

  // read through a ref so the key listener is registered once
  const keys = React.useRef({
    close: () => {},
    focusTerminal: () => {},
    nudge: (_step: -1 | 1) => {},
    split: () => {},
    move: (_dir: "left" | "right" | "up" | "down") => {},
  });
  // written after the commit, before the listener below can fire: render is pure
  React.useEffect(() => {
    const front = layout ? activeGroup(layout).front : null;
    keys.current = {
      close: () => {
        if (front) requestClose(front);
      },
      focusTerminal: () => {
        const fronts = layout ? groupsOf(layout).map((g) => g.front) : [];
        const target = front?.startsWith("t:") ? front : (fronts.find((k) => k?.startsWith("t:")) ?? null);
        if (target) activateKey(target);
        else if (activeTerminal) activateKey(terminalKey(activeTerminal));
      },
      nudge: (step) => {
        if (front) update((l) => nudgeInGroup(l, front, step));
      },
      split: () => {
        if (front) split(front, "right");
      },
      move: (dir) => {
        if (!layout) return;
        const next = neighbourGroup(paneRects(), layout.active, dir);
        const g = next ? groupById(layout, next) : null;
        if (!g) return;
        update((l) => focusGroup(l, g.id));
        if (g.front) activateInStore(g.front);
      },
    };
  });

  // Ctrl+W closes the front tab; Ctrl+` focuses a shell; Ctrl+Shift+PageUp/Down moves the front
  // tab inside its pane (not the arrows: editor and shells select words with them); Ctrl+\ splits
  // it to the right; Ctrl+Alt+arrows walk between panes
  React.useEffect(() => {
    const arrows: Record<string, "left" | "right" | "up" | "down"> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.altKey) {
        const dir = arrows[e.key];
        if (dir && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          keys.current.move(dir);
        }
        return;
      }
      if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown")) {
        e.preventDefault();
        e.stopPropagation();
        keys.current.nudge(e.key === "PageUp" ? -1 : 1);
        return;
      }
      // by the character, or by the physical key: on layouts where `\` needs AltGr it never arrives as one
      if ((e.key === "\\" || e.code === "Backslash") && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        keys.current.split();
      } else if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        keys.current.close();
      } else if (e.key === "`") {
        e.preventDefault();
        keys.current.focusTerminal();
      }
    };
    // capture: the editor and xterm would otherwise take these before we see them
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /* --------------------------------- render ---------------------------------- */

  const pendingFile = pending?.kind === "file" ? files.find((f) => f.path === pending.path) : undefined;
  const pendingTerm = pending?.kind === "terminal" ? terminals.find((x) => x.id === pending.id) : undefined;
  const groups = layout ? groupsOf(layout) : [];

  const ctx: PaneContext | null = layout
    ? {
        cwd,
        projectId,
        layout,
        multi: groups.length > 1,
        terminals,
        files,
        previews,
        conflict,
        gitStatus,
        attention,
        renaming,
        setRenaming,
        activateKey,
        focusGroup: (id) => {
          update((l) => focusGroup(l, id));
          const g = groupById(layout, id);
          if (g?.front) activateInStore(g.front);
        },
        requestClose,
        openMenu: (key, group, x, y) => setTabMenu({ key, group, x, y }),
        newTerminalIn: (groupId, kind: TermKind) => {
          update((l) => focusGroup(l, groupId));
          void newTerminal(kind, cwd);
        },
        runScriptIn: (groupId, label, command) => {
          update((l) => focusGroup(l, groupId));
          void newTerminal("shell", cwd, { label, command });
        },
        drag,
        dropTarget,
      }
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {ctx && layout ? (
        <PaneCtx.Provider value={ctx}>
          <PaneTree
            node={layout.root}
            onSizes={(splitId, sizes) => update((l) => setSizes(l, splitId, sizes))}
            renderGroup={(id) => {
              const g = groupById(layout, id);
              return g ? <PaneGroupView group={g} /> : null;
            }}
          />
        </PaneCtx.Provider>
      ) : null}
      <LinkPreviewPopover />

      <TabMenu
        at={tabMenu}
        groups={groups}
        splitBlocked={(edge) => (tabMenu ? splitBlocked(tabMenu.key, edge) : null)}
        onClose={() => setTabMenu(null)}
        onRename={() => {
          if (tabMenu?.key.startsWith("t:")) setRenaming(tabMenu.key.slice(2));
          setTabMenu(null);
        }}
        onSplit={(edge) => {
          if (tabMenu) split(tabMenu.key, edge);
          setTabMenu(null);
        }}
        onMove={(groupId) => {
          if (tabMenu) update((l) => moveTab(l, tabMenu.key, groupId, "center"));
          setTabMenu(null);
        }}
      />

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
