import { CornerDownLeft, Loader2, Search } from "lucide-react";
import * as React from "react";
import { useBench, type SearchMode } from "@/store/bench";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { FileTree } from "./FileTree";
import { fileGlyph } from "./icons";

/**
 * The file panel: a search box over the tree. Names filter as you type; content
 * search shells out to ripgrep / git grep / grep and waits for Enter, since it
 * walks the whole repo.
 */

const MODES: { id: SearchMode; label: string }[] = [
  { id: "names", label: "File names" },
  { id: "content", label: "In files" },
];

function SearchBox({ root }: { root: string }) {
  const t = useT();
  const query = useBench((s) => s.query);
  const setQuery = useBench((s) => s.setQuery);
  const mode = useBench((s) => s.searchMode);
  const setSearchMode = useBench((s) => s.setSearchMode);
  const runSearch = useBench((s) => s.runSearch);
  const searching = useBench((s) => s.searching);
  const focusSeq = useBench((s) => s.searchFocusSeq);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!focusSeq) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSeq]);

  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-2 py-2">
      <div className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 focus-within:border-accent/50">
        {searching ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        ) : (
          <Search className="h-3.5 w-3.5 shrink-0 text-text-3" />
        )}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(root, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch(root);
          }}
          placeholder={mode === "names" ? t("Search files") : t("Search in files — Enter to run")}
          aria-label={mode === "names" ? t("Search files") : t("Search in files")}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-text placeholder:text-text-3 selectable focus:outline-none"
        />
        {mode === "content" && query.trim() && (
          <CornerDownLeft className="h-3 w-3 shrink-0 text-text-3" aria-hidden />
        )}
      </div>

      <div className="flex rounded-md border border-border bg-surface-2 p-0.5">
        {MODES.map((m) => (
          <button
            type="button"
            key={m.id}
            onClick={() => setSearchMode(root, m.id)}
            aria-pressed={mode === m.id}
            className={cn(
              "flex-1 cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors",
              "focus-visible:outline-2 focus-visible:outline-accent",
              mode === m.id ? "bg-accent-soft text-accent" : "text-text-3 hover:text-text-2",
            )}
          >
            {t(m.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

function NameResults() {
  const t = useT();
  const hits = useBench((s) => s.nameHits);
  const activeFile = useBench((s) => s.activeFile);
  const openPath = useBench((s) => s.openPath);
  const searching = useBench((s) => s.searching);

  if (!hits.length) {
    return (
      <p className="px-3 py-3 text-[11px] text-text-3">
        {searching ? t("searching…") : t("No file matches that name.")}
      </p>
    );
  }

  return (
    <div className="py-1">
      {hits.map((h) => {
        const { Icon, tone } = fileGlyph(h.name);
        const active = activeFile === h.path;
        return (
          <button
            type="button"
            key={h.path}
            onClick={() => void openPath(h.path, h.name)}
            title={h.path}
            className={cn(
              "flex w-full cursor-pointer items-center gap-1.5 px-2 py-[3px] text-left text-[12px] transition-colors",
              active ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text",
            )}
          >
            <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : tone)} />
            <span className="truncate">{h.name}</span>
            <span className="ml-auto max-w-[45%] truncate font-mono text-[10px] text-text-3">{h.dir}</span>
          </button>
        );
      })}
    </div>
  );
}

function ContentResults({ root }: { root: string }) {
  const t = useT();
  const hits = useBench((s) => s.contentHits);
  const engine = useBench((s) => s.searchEngine);
  const truncated = useBench((s) => s.searchTruncated);
  const error = useBench((s) => s.searchError);
  const searching = useBench((s) => s.searching);
  const query = useBench((s) => s.query);
  const openAt = useBench((s) => s.openAt);

  if (error) return <p className="px-3 py-3 text-[11px] text-warn">{error}</p>;
  if (searching) return <p className="px-3 py-3 text-[11px] text-text-3">{t("searching…")}</p>;
  if (!query.trim()) {
    return <p className="px-3 py-3 text-[11px] text-text-3">{t("Type something and press Enter.")}</p>;
  }
  if (!hits.length) return <p className="px-3 py-3 text-[11px] text-text-3">{t("No matches.")}</p>;

  return (
    <div className="py-1">
      {hits.map((h) => {
        const name = h.file.split("/").pop() ?? h.file;
        const { Icon, tone } = fileGlyph(name);
        return (
          <button
            type="button"
            key={`${h.file}:${h.line}`}
            onClick={() => void openAt(`${root}/${h.file}`, name, h.line)}
            title={`${h.file}:${h.line}`}
            className="flex w-full cursor-pointer flex-col gap-0.5 px-2 py-1 text-left transition-colors hover:bg-surface-2"
          >
            <span className="flex items-center gap-1.5 text-[11px] text-text-2">
              <Icon className={cn("h-3 w-3 shrink-0", tone)} />
              <span className="truncate">{h.file}</span>
              <span className="tnum shrink-0 text-text-3">:{h.line}</span>
            </span>
            <span className="truncate pl-4 font-mono text-[10px] text-text-3">{h.text}</span>
          </button>
        );
      })}
      <p className="px-2 py-1.5 text-[10px] text-text-3">
        {truncated
          ? t("first {n} matches · {engine}", { n: hits.length, engine })
          : t("{n} matches · {engine}", { n: hits.length, engine })}
      </p>
    </div>
  );
}

export function FilesPanel({ root }: { root: string }) {
  const mode = useBench((s) => s.searchMode);
  const query = useBench((s) => s.query);

  let results = <FileTree root={root} />;
  if (mode === "content") results = <ContentResults root={root} />;
  else if (query.trim()) results = <NameResults />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SearchBox root={root} />
      <div className="min-h-0 flex-1 overflow-auto">{results}</div>
    </div>
  );
}
