import { Check, Download, RefreshCw } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import { discover, type ImportCandidate } from "@/lib/importers";
import { Badge, Button, Spinner } from "@/components/ui/primitives";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * Copies skills or commands installed for Claude / opencode into Assay. A copy,
 * not a link: editing here must never write back to the other tool's file.
 */
export function ImportDialog({
  kind,
  open,
  onOpenChange,
}: {
  kind: "skill" | "command";
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const tools = useApp((s) => s.tools);
  const saveTool = useApp((s) => s.saveTool);
  const reloadTools = useApp((s) => s.reloadTools);
  const t = useT();
  const [items, setItems] = React.useState<ImportCandidate[] | null>(null);
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setItems(null);
    setError(null);
    try {
      setItems(await discover(kind));
    } catch (e) {
      setError((e as Error).message);
      setItems([]);
    }
  }, [kind]);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const already = React.useMemo(() => {
    const names = new Set<string>();
    for (const tool of tools) if (tool.source === kind) names.add(tool.name.toLowerCase());
    return names;
  }, [tools, kind]);

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const importSelected = async () => {
    if (!items) return;
    setBusy(true);
    setError(null);
    try {
      const picked: ImportCandidate[] = [];
      for (const c of items) if (sel.has(c.id)) picked.push(c);
      await Promise.all(
        picked.map((c) =>
          saveTool({
            name: c.name,
            source: kind,
            kind: "cli-agent",
            scope: "local",
            stack: [],
            cmd: "",
            adapter: "generic",
            prompt: c.body,
            builtin: false,
            enabled: true,
            notes: c.description || t("Imported from {origin}", { origin: c.origin }),
          }),
        ),
      );
      // the per-save reloads can settle out of order — take one final snapshot
      await reloadTools();
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = kind === "skill" ? t("skills") : t("commands");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(680px,94vw)]"
        title={t("Import {kind}", { kind: label })}
        desc={t(
          "Found in ~/.claude and ~/.config/opencode. Assay copies them, so your original files stay untouched.",
        )}
      >
      {error && <p className="mb-2 text-[11px] text-danger">{error}</p>}
      {items === null && (
        <div className="flex items-center gap-2 py-6 text-xs text-text-3">
          <Spinner className="h-3.5 w-3.5" /> {t("Looking for {kind} on this machine…", { kind: label })}
        </div>
      )}
      {items !== null && items.length === 0 && (
        <p className="py-6 text-xs text-text-3">
          {t("Nothing found. Assay looks in ~/.claude and ~/.config/opencode.")}
        </p>
      )}
      {items !== null && items.length > 0 && (
        <div className="max-h-[46vh] overflow-auto pr-1">
          {items.map((c) => {
            const dup = already.has(c.name.toLowerCase());
            const on = sel.has(c.id);
            return (
              <button
                type="button"
                key={c.id}
                onClick={() => toggle(c.id)}
                aria-pressed={on}
                className={cn(
                  "mb-1.5 flex w-full cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors",
                  on ? "border-accent/40 bg-accent-soft" : "border-border bg-surface-2 hover:bg-surface-3",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                    on ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface",
                  )}
                >
                  {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className={cn("truncate text-[13px] font-medium", on && "text-accent")}>{c.name}</span>
                    <Badge>{c.origin}</Badge>
                    {dup && <Badge tone="warn">{t("already here")}</Badge>}
                  </span>
                  {c.description && (
                    <span className="mt-0.5 line-clamp-2 block text-[11px] text-text-2">{c.description}</span>
                  )}
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-text-3" title={c.path}>
                    {c.path}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 border-t border-border-soft pt-3">
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={items === null}>
          <RefreshCw className="h-3.5 w-3.5" /> {t("Rescan")}
        </Button>
        <span className="mr-auto text-[11px] text-text-3">
          {items === null
            ? t("scanning…")
            : t("{found} found · {selected} selected", { found: items.length, selected: sel.size })}
        </span>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t("Cancel")}
        </Button>
        <Button variant="primary" loading={busy} disabled={!sel.size} onClick={() => void importSelected()}>
          <Download className="h-4 w-4" /> {sel.size ? t("Import {n}", { n: sel.size }) : t("Import")}
        </Button>
      </div>
      </DialogContent>
    </Dialog>
  );
}
