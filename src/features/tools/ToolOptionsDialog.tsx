import { Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import type { Tool, ToolPlugin } from "@/types";
import { enabledGroups, pluginsOf, schemaFor } from "@/lib/tool-options";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button, Input } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

/** A plugin row while it is being edited: the identity the list is keyed by. */
interface PluginRow extends ToolPlugin {
  key: string;
}

let rowSeq = 0;
const asRow = (p: ToolPlugin): PluginRow => ({ ...p, key: `plugin-${rowSeq++}` });

/** The checkboxes behind a configurable tool, rendered from its schema in `lib/tool-options.ts`. */
export function ToolOptionsDialog({
  tool,
  open,
  onOpenChange,
}: {
  tool: Tool;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const saveToolConfig = useApp((s) => s.saveToolConfig);
  const t = useT();
  const schema = schemaFor(tool);
  const [groups, setGroups] = React.useState<string[]>([]);
  const [plugins, setPlugins] = React.useState<PluginRow[]>([]);
  const [saving, setSaving] = React.useState(false);

  // reset to what is stored every time the dialog opens
  React.useEffect(() => {
    if (!open) return;
    setGroups(enabledGroups(tool));
    setPlugins(pluginsOf(tool).map(asRow));
  }, [open, tool]);

  if (!schema) return null;

  const enabled = new Set(groups);

  const toggle = (id: string) =>
    setGroups((cur) => (cur.includes(id) ? cur.filter((g) => g !== id) : [...cur, id]));

  const setPlugin = (i: number, patch: Partial<ToolPlugin>) =>
    setPlugins((cur) => cur.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const save = () => {
    setSaving(true);
    void saveToolConfig(tool.id, {
      groups,
      plugins: plugins.reduce<ToolPlugin[]>((out, p) => {
        const pkg = p.pkg.trim();
        if (pkg) out.push({ pkg, preset: p.preset.trim() });
        return out;
      }, []),
    })
      .then(() => onOpenChange(false))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("{tool} options", { tool: tool.name })} desc={t(schema.intro)}>
        <div className="flex flex-col gap-1.5">
          {schema.options.map((o) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2"
            >
              <input
                type="checkbox"
                checked={enabled.has(o.id)}
                onChange={() => toggle(o.id)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
              />
              <span className="min-w-0">
                <span className="block text-[13px] text-text">{t(o.label)}</span>
                {o.hint && <span className="block font-mono text-[10px] text-text-3">{t(o.hint)}</span>}
              </span>
            </label>
          ))}
        </div>

        {schema.allowPlugins && (
          <div className="mt-5 border-t border-border-soft pt-4">
            <p className="text-[11px] uppercase tracking-wide text-text-3">{t("Extra plugins")}</p>
            <p className="mt-1 text-[11px] text-text-3">
              {t(
                "An npm package and the preset to take rules from — Assay installs it in its own sandbox on the next run.",
              )}
            </p>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {plugins.map((p, i) => (
                <div key={p.key} className="flex items-center gap-1.5">
                  <Input
                    value={p.pkg}
                    onChange={(e) => setPlugin(i, { pkg: e.target.value })}
                    placeholder="eslint-plugin-sonarjs"
                    aria-label={t("Plugin package")}
                    className="flex-1 font-mono text-[11px]"
                  />
                  <Input
                    value={p.preset}
                    onChange={(e) => setPlugin(i, { preset: e.target.value })}
                    placeholder="sonarjs/recommended"
                    aria-label={t("Preset")}
                    className="flex-1 font-mono text-[11px]"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("Remove plugin")}
                    title={t("Remove")}
                    onClick={() => setPlugins((cur) => cur.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => setPlugins((cur) => [...cur, asRow({ pkg: "", preset: "" })])}
              >
                <Plus className="h-3.5 w-3.5" /> {t("Add plugin")}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {t("Save options")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
