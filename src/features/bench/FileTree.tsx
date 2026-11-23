import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronRight, Copy, Folder, FolderOpen, SquareArrowOutUpRight } from "lucide-react";
import * as React from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listDir, type TreeEntry } from "@/lib/fs-tree";
import { relPath } from "@/lib/git";
import { useBench } from "@/store/bench";
import { cn } from "@/lib/utils";
import { writeClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { fileGlyph, statusGlyph } from "./icons";

/**
 * The project tree, read lazily one directory at a time (a recursive read would
 * walk `node_modules`). Build output and VCS folders stay hidden until asked for.
 */

function Row({
  root,
  entry,
  depth,
  showIgnored,
  showDotfiles,
  activePath,
  onOpen,
  onContext,
}: {
  root: string;
  entry: TreeEntry;
  depth: number;
  showIgnored: boolean;
  showDotfiles: boolean;
  activePath: string | null;
  onOpen: (e: TreeEntry) => void;
  onContext: (e: TreeEntry, x: number, y: number) => void;
}) {
  const t = useT();
  const rel = relPath(root, entry.path);
  // a file carries its own state; a folder only says that something inside moved
  const status = useBench((s) => (entry.dir ? undefined : s.gitStatus[rel]));
  const dirTouched = useBench((s) => (entry.dir ? !!s.gitDirs[rel] : false));
  const mark = status ? statusGlyph(status) : null;
  const [open, setOpen] = React.useState(false);
  const [children, setChildren] = React.useState<TreeEntry[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    listDir(entry.path, showIgnored, showDotfiles)
      .then(setChildren)
      .catch(() => setChildren([]))
      .finally(() => setLoading(false));
  }, [entry.path, showIgnored, showDotfiles]);

  // a changed "show ignored" invalidates what an already-open folder read
  const openRef = React.useRef(false);
  React.useEffect(() => {
    if (openRef.current) load();
  }, [load]);

  const toggle = () => {
    if (!entry.dir) {
      onOpen(entry);
      return;
    }
    const next = !open;
    openRef.current = next;
    setOpen(next);
    if (next) load();
  };

  const active = activePath === entry.path;
  const { Icon: Glyph, tone: glyphTone } = fileGlyph(entry.name);
  const Chevron = open ? ChevronDown : ChevronRight;
  const FolderGlyph = open ? FolderOpen : Folder;

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        onContextMenu={(ev) => {
          ev.preventDefault();
          onContext(entry, ev.clientX, ev.clientY);
        }}
        title={entry.path}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-left text-[12px] transition-colors",
          active
            ? "bg-accent-soft text-accent"
            : cn(mark ? mark.tone : "text-text-2", "hover:bg-surface-2 hover:text-text"),
          entry.ignored && "opacity-50",
        )}
      >
        {entry.dir ? (
          <Chevron className="h-3 w-3 shrink-0" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {entry.dir ? (
          <FolderGlyph className="h-3.5 w-3.5 shrink-0 text-brass" />
        ) : (
          <Glyph className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : glyphTone)} />
        )}
        <span className="truncate">{entry.name}</span>
        {mark && (
          <span
            className={cn("ml-auto shrink-0 pl-1 font-mono text-[10px]", active ? "text-accent" : mark.tone)}
            title={t(mark.label)}
            aria-label={t(mark.label)}
          >
            {mark.letter}
          </span>
        )}
        {dirTouched && (
          <span
            className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
            title={t("Changes inside")}
            aria-label={t("Changes inside")}
          />
        )}
      </button>
      {open && (
        <>
          {loading && !children && (
            <p style={{ paddingLeft: 20 + depth * 12 }} className="py-[3px] text-[11px] text-text-3">
              {t("reading…")}
            </p>
          )}
          {children?.map((c) => (
            <Row
              key={c.path}
              root={root}
              entry={c}
              depth={depth + 1}
              showIgnored={showIgnored}
              showDotfiles={showDotfiles}
              activePath={activePath}
              onOpen={onOpen}
              onContext={onContext}
            />
          ))}
        </>
      )}
    </>
  );
}

/** Where the right-click landed, and on what. */
interface MenuAt {
  entry: TreeEntry;
  x: number;
  y: number;
}

/**
 * The right-click menu for a tree row, anchored to the cursor through a
 * zero-sized trigger because Radix positions against an element.
 */
function RowMenu({ at, onClose }: { at: MenuAt | null; onClose: () => void }) {
  const t = useT();
  const openPath = useBench((s) => s.openPath);
  const setError = useBench((s) => s.setError);
  if (!at) return null;
  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const item =
    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-2 outline-none transition-colors data-[highlighted]:bg-surface-2 data-[highlighted]:text-text";

  return (
    <Dropdown.Root open onOpenChange={(o) => !o && onClose()}>
      <Dropdown.Trigger asChild>
        <span
          aria-hidden
          style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }}
        />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="start"
          sideOffset={2}
          className="z-50 w-[220px] rounded-lg border border-border bg-surface p-1.5 shadow-2xl animate-in"
        >
          {!at.entry.dir && (
            <Dropdown.Item className={item} onSelect={() => void openPath(at.entry.path, at.entry.name)}>
              <SquareArrowOutUpRight className="h-3.5 w-3.5" /> {t("Open in the editor")}
            </Dropdown.Item>
          )}
          <Dropdown.Item className={item} onSelect={() => void revealItemInDir(at.entry.path).catch(report)}>
            <FolderOpen className="h-3.5 w-3.5" /> {t("Show in file manager")}
          </Dropdown.Item>
          <Dropdown.Item
            className={item}
            // through Rust first, so it works where the webview's own clipboard is blocked
            onSelect={() => void writeClipboard(at.entry.path).catch(report)}
          >
            <Copy className="h-3.5 w-3.5" /> {t("Copy path")}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function FileTree({ root }: { root: string }) {
  const t = useT();
  const showIgnored = useBench((s) => s.showIgnored);
  const showDotfiles = useBench((s) => s.showDotfiles);
  const openPath = useBench((s) => s.openPath);
  const activeFile = useBench((s) => s.activeFile);
  const toggleShowIgnored = useBench((s) => s.toggleShowIgnored);
  const [all, setAll] = React.useState<TreeEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [menu, setMenu] = React.useState<MenuAt | null>(null);

  // The root is read with the ignored folders in, so the footer can say what
  // is hidden; only the root, since counting deeper means walking the tree.
  const reload = React.useCallback(() => {
    setLoading(true);
    listDir(root, true, showDotfiles)
      .then(setAll)
      .catch(() => setAll([]))
      .finally(() => setLoading(false));
  }, [root, showDotfiles]);

  React.useEffect(reload, [reload]);

  const hidden = React.useMemo(() => all.filter((e) => e.ignored).map((e) => e.name), [all]);
  const entries = showIgnored ? all : all.filter((e) => !e.ignored);

  if (loading && !all.length) {
    return <p className="px-3 py-2 text-[11px] text-text-3">{t("reading…")}</p>;
  }

  return (
    <div className="py-1">
      {entries.map((e) => (
        <Row
          key={e.path}
          root={root}
          entry={e}
          depth={0}
          showIgnored={showIgnored}
          showDotfiles={showDotfiles}
          activePath={activeFile}
          onOpen={(x) => void openPath(x.path, x.name)}
          onContext={(entry, x, y) => setMenu({ entry, x, y })}
        />
      ))}
      {hidden.length > 0 && (
        <p className="mt-1 flex items-center gap-1 border-t border-border-soft px-3 pt-1.5 text-[10px] text-text-3">
          <span className="min-w-0 truncate" title={hidden.join(", ")}>
            {showIgnored
              ? t("Showing {n} build and cache folders", { n: hidden.length })
              : t("{n} folders hidden ({names})", {
                  n: hidden.length,
                  names: hidden.length > 2 ? `${hidden.slice(0, 2).join(", ")}…` : hidden.join(", "),
                })}
          </span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={toggleShowIgnored}
            className="shrink-0 cursor-pointer rounded text-text-2 underline-offset-2 hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {showIgnored ? t("Hide") : t("Show")}
          </button>
        </p>
      )}
      <RowMenu at={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
