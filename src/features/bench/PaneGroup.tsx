import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  ChevronRight,
  Columns2,
  Film,
  GitMerge,
  Globe,
  Image as ImageIcon,
  Lock,
  MoveRight,
  Music,
  Pencil,
  Plus,
  Rows2,
  Save,
  X,
} from "lucide-react";
import * as React from "react";
import { availableLaunchers, LAUNCHERS, type TermKind } from "@/lib/bench-term";
import type { DropTarget } from "@/lib/file-drop";
import { relPath, type GitFileStatus } from "@/lib/git";
import type { PaneGroup, PaneLayout } from "@/lib/pane-layout";
import { conflictKey, fileKey, previewKey, terminalKey, type TabKey } from "@/lib/tab-order";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useBench, type ConflictTab, type OpenFile, type PinnedPreview, type TermSession } from "@/store/bench";
import { ConflictView } from "./ConflictView";
import { EditorSlot } from "./EditorPane";
import { fileGlyph, launcherGlyph, statusGlyph } from "./icons";
import type { PaneDrag, TabDragProps } from "./pane-drag";
import { PreviewPane } from "./PreviewPane";
import { ScriptsBar } from "./ScriptsBar";
import { TerminalSlot } from "./TerminalPane";

/**
 * One pane of the split work area: its own tab strip over one surface. The
 * surfaces of the tab kinds stay mounted and hidden: an unmounted Monaco loses
 * its cursor, and a pinned page would reload. A terminal is re-hosted rather
 * than kept, because its screen lives outside React (`TerminalPane`).
 */

export interface PaneContext {
  cwd: string;
  projectId: string | null;
  layout: PaneLayout;
  /** More than one pane: the active one is marked, and pane commands make sense. */
  multi: boolean;
  terminals: TermSession[];
  files: OpenFile[];
  previews: PinnedPreview[];
  conflict: ConflictTab | null;
  gitStatus: Record<string, GitFileStatus>;
  attention: Record<string, true>;
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  /** Click on a tab: front of its pane, pane active. */
  activateKey: (key: TabKey) => void;
  /** A press anywhere in a pane makes it the active one. */
  focusGroup: (groupId: string) => void;
  requestClose: (key: TabKey) => void;
  openMenu: (key: TabKey, groupId: string, x: number, y: number) => void;
  newTerminalIn: (groupId: string, kind: TermKind) => void;
  runScriptIn: (groupId: string, label: string, command: string) => void;
  drag: PaneDrag;
  dropTarget: DropTarget | null;
}

export const PaneCtx = React.createContext<PaneContext | null>(null);

function usePane(): PaneContext {
  const ctx = React.useContext(PaneCtx);
  if (!ctx) throw new Error("PaneGroupView outside the work area");
  return ctx;
}

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
  drag: TabDragProps;
  /** Replaces the label while the tab is being renamed. */
  editing?: React.ReactNode;
  /** Terminals only: double-click renames in place. */
  onRename?: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      data-tab-key={drag.tabKey}
      onPointerDown={drag.onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-full border pl-2.5 pr-1 text-[11px] transition-colors",
        active ? "border-accent/40 bg-accent-soft text-accent" : "border-border text-text-2 hover:bg-surface-2",
        drag.state === "source" && "opacity-50",
        drag.state === "target" && "ring-1 ring-accent",
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

const MENU_ITEM =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-2 outline-none transition-colors data-[highlighted]:bg-surface-2 data-[highlighted]:text-text data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

/** Right-click on any tab: rename (terminals), split, move to another pane. */
export function TabMenu({
  at,
  groups,
  splitBlocked,
  onRename,
  onSplit,
  onMove,
  onClose,
}: {
  at: { key: TabKey; group: string; x: number; y: number } | null;
  groups: PaneGroup[];
  /** Why splitting this tab off is not possible right now, or null when it is. */
  splitBlocked: (edge: "right" | "bottom") => string | null;
  onRename: () => void;
  onSplit: (edge: "right" | "bottom") => void;
  onMove: (groupId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  if (!at) return null;
  const others = groups.map((g, i) => ({ g, n: i + 1 })).filter(({ g }) => g.id !== at.group);
  const right = splitBlocked("right");
  const down = splitBlocked("bottom");
  return (
    <Dropdown.Root open onOpenChange={(o) => !o && onClose()}>
      <Dropdown.Trigger asChild>
        <span aria-hidden style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }} />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="start"
          sideOffset={2}
          // the rename field takes focus next; giving it back to the tab would blur it at once
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-50 min-w-[190px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
        >
          {at.key.startsWith("t:") && (
            <>
              <Dropdown.Item onSelect={onRename} className={MENU_ITEM}>
                <Pencil className="h-3.5 w-3.5" /> {t("Rename")}
              </Dropdown.Item>
              <Dropdown.Separator className="my-1 h-px bg-border" />
            </>
          )}
          <Dropdown.Item disabled={!!right} onSelect={() => onSplit("right")} className={MENU_ITEM} title={right ?? undefined}>
            <Columns2 className="h-3.5 w-3.5" />
            <span className="flex-1">{t("Split right")}</span>
            <kbd className="font-mono text-[10px] text-text-3">Ctrl+\</kbd>
          </Dropdown.Item>
          <Dropdown.Item disabled={!!down} onSelect={() => onSplit("bottom")} className={MENU_ITEM} title={down ?? undefined}>
            <Rows2 className="h-3.5 w-3.5" /> {t("Split down")}
          </Dropdown.Item>
          {(right || down) && <p className="max-w-[220px] px-2 pb-1 text-[10px] text-text-3">{right ?? down}</p>}
          {others.length > 0 && (
            <Dropdown.Sub>
              <Dropdown.SubTrigger className={MENU_ITEM}>
                <MoveRight className="h-3.5 w-3.5" />
                <span className="flex-1">{t("Move to panel")}</span>
                <ChevronRight className="h-3.5 w-3.5 text-text-3" />
              </Dropdown.SubTrigger>
              <Dropdown.Portal>
                <Dropdown.SubContent
                  sideOffset={4}
                  className="z-50 min-w-[140px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
                >
                  {others.map(({ g, n }) => (
                    <Dropdown.Item key={g.id} onSelect={() => onMove(g.id)} className={MENU_ITEM}>
                      {t("Panel {n}", { n })}
                    </Dropdown.Item>
                  ))}
                </Dropdown.SubContent>
              </Dropdown.Portal>
            </Dropdown.Sub>
          )}
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

/** Where a dragged tab would land on this pane's surface, drawn over it. */
function DropOverlay({ edge }: { edge: "left" | "right" | "top" | "bottom" | "center" }) {
  const place: Record<typeof edge, string> = {
    center: "inset-0",
    left: "inset-y-0 left-0 w-1/2",
    right: "inset-y-0 right-0 w-1/2",
    top: "inset-x-0 top-0 h-1/2",
    bottom: "inset-x-0 bottom-0 h-1/2",
  };
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-20 rounded-md border-2 border-accent bg-accent-soft/60 transition-all duration-150 ease-out",
        place[edge],
      )}
    />
  );
}

export function PaneGroupView({ group }: { group: PaneGroup }) {
  const t = useT();
  const ctx = usePane();
  const saveFileAt = useBench((s) => s.saveFileAt);
  const closeConflict = useBench((s) => s.closeConflict);
  const renameTerminal = useBench((s) => s.renameTerminal);
  const isActive = ctx.layout.active === group.id;
  const front = group.front;

  const frontTerminal = front?.startsWith("t:") ? front.slice(2) : null;
  const frontFile = front?.startsWith("f:") ? (ctx.files.find((f) => fileKey(f.path) === front) ?? null) : null;
  const frontPreview = front?.startsWith("p:") ? front.slice(2) : null;
  const showsConflict = !!ctx.conflict && front === conflictKey(ctx.conflict.path);
  const holdsConflict = !!ctx.conflict && group.tabs.includes(conflictKey(ctx.conflict.path));
  const previews = ctx.previews.filter((p) => group.tabs.includes(previewKey(p.id)));
  const terminalLayer = !front || !!frontTerminal;
  const dirty = !!frontFile && frontFile.content !== frontFile.saved;

  const drop = ctx.dropTarget?.group === group.id ? ctx.dropTarget.zone : null;
  const dragTarget = ctx.drag.active?.target;
  const overlay = dragTarget?.kind === "edge" && dragTarget.group === group.id ? dragTarget.edge : null;
  const stripTarget =
    !!ctx.drag.active && (dragTarget?.kind === "strip" || dragTarget?.kind === "tab") && dragTarget.group === group.id;

  const menu = (key: TabKey) => (x: number, y: number) => ctx.openMenu(key, group.id, x, y);

  return (
    <section
      data-pane-group={group.id}
      aria-label={t("Panel")}
      onPointerDownCapture={() => {
        if (!isActive) ctx.focusGroup(group.id);
      }}
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-bg"
    >
      <div
        data-pane-strip
        data-drop-zone="editor"
        className={cn(
          "flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2",
          // the pane the keyboard and new tabs go to, said only when there is a choice
          ctx.multi && isActive && "shadow-[inset_0_2px_0_0_var(--color-accent)]",
          drop === "editor" && !frontFile && "ring-1 ring-inset ring-accent",
          stripTarget && "bg-accent-soft/40",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {group.tabs.map((key) => {
            if (key.startsWith("t:")) {
              const term = ctx.terminals.find((x) => terminalKey(x.id) === key);
              if (!term) return null;
              const { Icon, tone } = launcherGlyph(term.kind);
              const active = front === key;
              return (
                <TabShell
                  key={key}
                  active={active}
                  title={term.cwd}
                  onSelect={() => ctx.activateKey(key)}
                  onClose={() => ctx.requestClose(key)}
                  closeLabel={t("Close {name}", { name: term.title })}
                  closeTitle={term.alive ? t("Kill and close") : t("Close")}
                  drag={ctx.drag.tabProps(key)}
                  onRename={() => ctx.setRenaming(term.id)}
                  onMenu={menu(key)}
                  editing={
                    ctx.renaming === term.id ? (
                      <span className="flex items-center gap-1.5">
                        <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : tone)} />
                        <RenameField
                          initial={term.title}
                          onDone={(name) => {
                            ctx.setRenaming(null);
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
                  {ctx.attention[term.id] && (
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
              const p = ctx.previews.find((x) => previewKey(x.id) === key);
              if (!p) return null;
              const active = front === key;
              const label = p.target.kind === "url" ? p.target.url.replace(/^https?:\/\//, "") : p.target.name;
              const PreviewIcon =
                p.target.kind === "url" ? Globe : p.target.kind === "video" ? Film : p.target.kind === "audio" ? Music : ImageIcon;
              return (
                <TabShell
                  key={key}
                  drag={ctx.drag.tabProps(key)}
                  active={active}
                  title={p.id}
                  onSelect={() => ctx.activateKey(key)}
                  onClose={() => ctx.requestClose(key)}
                  closeLabel={t("Close {name}", { name: label })}
                  closeTitle={t("Close")}
                  onMenu={menu(key)}
                >
                  <PreviewIcon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : "text-low")} />
                  <span className="max-w-[160px] truncate">{label}</span>
                </TabShell>
              );
            }
            if (key.startsWith("c:")) {
              const c = ctx.conflict;
              if (!c) return null;
              const active = front === key;
              return (
                <TabShell
                  key={key}
                  drag={ctx.drag.tabProps(key)}
                  active={active}
                  title={c.path}
                  onSelect={() => ctx.activateKey(key)}
                  onClose={closeConflict}
                  closeLabel={t("Close {name}", { name: c.name })}
                  closeTitle={t("Close")}
                  onMenu={menu(key)}
                >
                  <GitMerge className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : "text-warn")} />
                  <span className="max-w-[160px] truncate">{t("Resolve {name}", { name: c.name })}</span>
                </TabShell>
              );
            }
            const f = ctx.files.find((x) => fileKey(x.path) === key);
            if (!f) return null;
            const { Icon, tone } = fileGlyph(f.name);
            const active = front === key;
            const unsaved = f.content !== f.saved;
            // the same state the tree shows, where you are actually editing
            const status = ctx.gitStatus[relPath(ctx.cwd, f.path)];
            const mark = status ? statusGlyph(status) : null;
            return (
              <TabShell
                key={key}
                drag={ctx.drag.tabProps(key)}
                active={active}
                title={f.path}
                onSelect={() => ctx.activateKey(key)}
                onClose={() => ctx.requestClose(key)}
                closeLabel={t("Close {name}", { name: f.name })}
                closeTitle={t("Close")}
                onMenu={menu(key)}
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
                {unsaved && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t("Unsaved changes")} />}
              </TabShell>
            );
          })}

          <NewTerminalMenu onPick={(kind) => ctx.newTerminalIn(group.id, kind)} />
          <ScriptsBar
            projectId={ctx.projectId}
            cwd={ctx.cwd}
            shortcut={isActive}
            onRun={(label, command) => ctx.runScriptIn(group.id, label, command)}
          />
        </div>

        {frontFile && (
          <button
            type="button"
            onClick={() => void saveFileAt(frontFile.path)}
            disabled={!dirty || frontFile.readOnly}
            title={frontFile.readOnly ? t("Read-only") : t("Save (Ctrl+S)")}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] transition-colors",
              "focus-visible:outline-2 focus-visible:outline-accent",
              dirty && !frontFile.readOnly
                ? "cursor-pointer bg-accent-soft text-accent hover:bg-accent-soft/70"
                : "cursor-not-allowed text-text-3",
            )}
          >
            <Save className="h-3 w-3" /> {t("Save")}
          </button>
        )}
      </div>

      <div data-pane-surface className="relative min-h-0 flex-1">
        <div
          data-drop-zone="terminal"
          className={cn("absolute inset-0", !terminalLayer && "invisible", drop === "terminal" && "ring-2 ring-inset ring-accent")}
        >
          <TerminalSlot id={frontTerminal} focused={isActive && !!frontTerminal} />
        </div>
        <div
          data-drop-zone="editor"
          className={cn("absolute inset-0", !frontFile && "invisible", drop === "editor" && "ring-2 ring-inset ring-accent")}
        >
          <EditorSlot path={frontFile?.path ?? null} focused={isActive && !!frontFile} />
        </div>
        {previews.length > 0 && (
          <div className={cn("absolute inset-0", !frontPreview && "invisible")}>
            <PreviewPane previews={previews} active={frontPreview} />
          </div>
        )}
        {/* kept mounted while another tab is in front: the choices made so far live in it */}
        {holdsConflict && ctx.conflict && (
          <div className={cn("absolute inset-0", !showsConflict && "invisible")}>
            <ConflictView key={ctx.conflict.path} tab={ctx.conflict} root={ctx.cwd} />
          </div>
        )}
        {overlay && <DropOverlay edge={overlay} />}
      </div>
    </section>
  );
}
