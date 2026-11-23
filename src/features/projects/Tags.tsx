import { Check, Plus, Tag as TagIcon, Trash2, X } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import { TAG_COLORS, type Tag, type TagColor } from "@/types";
import { normalizeTagName, tagColor, tagColorVar, tagNameError, tagUsage, tagVars, TAG_NAME_MAX } from "@/lib/tags";
import { Button, Input } from "@/components/ui/primitives";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * For places where the name sits beside it rather than inside a pill (the manager
 * rows, the filter menu): elsewhere `.tag-badge` (globals.css) colours the whole
 * pill from `--tag`. Colour never stands alone.
 */
export function TagDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("h-2 w-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: tagColorVar(color) }}
    />
  );
}

export function TagPill({
  tag,
  onRemove,
  className,
}: {
  tag: Tag;
  onRemove?: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <span
      style={tagVars(tag.color) as React.CSSProperties}
      className={cn(
        "tag-badge inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        className,
      )}
    >
      <span className="max-w-[12rem] truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("Remove tag {tag}", { tag: tag.name })}
          className="cursor-pointer opacity-60 transition-opacity hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/** A pill that is also a toggle: picking tags, and filtering by them. */
function TagToggle({
  tag,
  on,
  count,
  onToggle,
}: {
  tag: Tag;
  on: boolean;
  count?: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      style={tagVars(tag.color) as React.CSSProperties}
      className={cn(
        "tag-badge tag-badge--btn inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none transition-colors",
        "focus-visible:outline-2 focus-visible:outline-accent",
        on && "tag-badge--on",
      )}
    >
      <span className="max-w-[12rem] truncate">{tag.name}</span>
      {count !== undefined && <span className="opacity-60">{count}</span>}
      {on && <Check className="h-3 w-3" />}
    </button>
  );
}

/** The nine swatches, as a radio group that shows what it is choosing. */
function ColorSwatches({
  value,
  onChange,
  label,
}: {
  value: TagColor;
  onChange: (c: TagColor) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label={label}>
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          title={c}
          onClick={() => onChange(c)}
          className={cn(
            "flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border transition-colors",
            "focus-visible:outline-2 focus-visible:outline-accent",
            value === c ? "border-text" : "border-transparent hover:border-border",
          )}
        >
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: tagColorVar(c) }} />
        </button>
      ))}
    </div>
  );
}

/** Pick this project's tags, or create one on the spot without leaving the dialog. */
export function TagPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const tags = useApp((s) => s.tags);
  const createTag = useApp((s) => s.createTag);
  const setError = useApp((s) => s.setError);
  const t = useT();
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<TagColor>("violet");
  const [busy, setBusy] = React.useState(false);

  const picked = new Set(selected);
  const toggle = (id: string) =>
    onChange(picked.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const create = async () => {
    const problem = tagNameError(name, tags);
    if (problem) return setError(t(problem));
    setBusy(true);
    try {
      const tag = await createTag(normalizeTagName(name), color);
      onChange([...selected, tag.id]);
      setName("");
      setAdding(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <TagToggle key={tag.id} tag={tag} on={picked.has(tag.id)} onToggle={() => toggle(tag.id)} />
        ))}
        {!adding && (
          <Button variant="ghost" size="sm" type="button" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> {t("New tag")}
          </Button>
        )}
      </div>

      {adding && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-2">
          <div className="flex gap-2">
            <Input
              autoFocus
              value={name}
              maxLength={TAG_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
              placeholder={t("client, frontend, side project…")}
            />
            <Button variant="primary" size="sm" type="button" loading={busy} onClick={() => void create()}>
              {t("Add")}
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => setAdding(false)}>
              {t("Cancel")}
            </Button>
          </div>
          <ColorSwatches value={color} onChange={setColor} label={t("Tag colour")} />
        </div>
      )}
    </div>
  );
}

/** One row of the manager: rename it, recolour it, or take it off everything. */
function ManageRow({ tag }: { tag: Tag }) {
  const tags = useApp((s) => s.tags);
  const projects = useApp((s) => s.projects);
  const updateTag = useApp((s) => s.updateTag);
  const deleteTag = useApp((s) => s.deleteTag);
  const setError = useApp((s) => s.setError);
  const t = useT();
  const [name, setName] = React.useState(tag.name);
  const [confirming, setConfirming] = React.useState(false);
  const used = tagUsage(tag.id, projects);

  const commitName = () => {
    const clean = normalizeTagName(name);
    if (clean === tag.name) return;
    const problem = tagNameError(name, tags, tag.id);
    if (problem) {
      setName(tag.name);
      return setError(t(problem));
    }
    void updateTag(tag.id, { name: clean });
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-2">
      <TagDot color={tag.color} />
      <Input
        value={name}
        maxLength={TAG_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        aria-label={t("Tag name")}
        className="flex-1"
      />
      <ColorSwatches
        value={tagColor(tag.color)}
        onChange={(c) => void updateTag(tag.id, { color: c })}
        label={t("Tag colour")}
      />
      <span className="w-20 shrink-0 text-right text-[11px] text-text-3">
        {t("{n} projects", { n: used })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        title={t("Delete tag")}
        aria-label={t("Delete tag")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        danger
        title={t("Delete the tag {tag}?", { tag: tag.name })}
        confirmLabel={t("Delete tag")}
        body={
          <div className="flex flex-col gap-2">
            <span>
              {used > 0
                ? t("It comes off {n} projects. Nothing else about them changes.", { n: used })
                : t("It is not on any project.")}
            </span>
            <span className="text-text-3">
              {t("Only the label is removed — no project, run or finding is touched.")}
            </span>
          </div>
        }
        onConfirm={() => void deleteTag(tag.id)}
      />
    </div>
  );
}

/** Rename, recolour and delete, where the tags are actually looked at. */
export function ManageTagsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const tags = useApp((s) => s.tags);
  const t = useT();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("Manage tags")} className="w-[min(640px,94vw)]">
        {tags.length === 0 ? (
          <p className="flex items-center gap-2 text-[13px] text-text-3">
            <TagIcon className="h-4 w-4" />
            {t("No tags yet — create one while editing a project.")}
          </p>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
            {tags.map((tag) => (
              <ManageRow key={tag.id} tag={tag} />
            ))}
          </div>
        )}
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {t("Done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
