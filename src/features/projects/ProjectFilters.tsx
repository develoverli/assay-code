import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Tags as TagsIcon } from "lucide-react";
import type { Tag } from "@/types";
import { tagUsage } from "@/lib/tags";
import type { GitHubOwnerCount } from "@/lib/github";
import { GitHubMark } from "@/features/github/GitHubMark";
import { TagDot } from "@/features/projects/Tags";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** Names the trigger spells out before it falls back to a count. */
const NAMES_ON_TRIGGER = 2;

const TRIGGER =
  "inline-flex h-7 max-w-[260px] cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 text-xs text-text " +
  "transition-colors hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent " +
  "data-[state=open]:border-accent/40 data-[state=open]:bg-accent-soft data-[state=open]:text-accent";

const CONTENT = "z-50 min-w-[220px] max-w-[320px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in";

const ITEM =
  "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors data-[highlighted]:bg-surface-2";

/** The box Radix leaves to us: ticked in accent, empty in the input colour. */
function CheckBox({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        on ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2",
      )}
    >
      {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
    </span>
  );
}

/**
 * Tag filter: a checkbox per tag with its usage count, OR across the picked ones
 * (`filterByTags`). The list stays open while ticking so several can be picked.
 */
export function TagFilterSelect({
  tags,
  picked,
  usage,
  onToggle,
}: {
  tags: Tag[];
  picked: string[];
  /** Projects to count each tag over. */
  usage: Parameters<typeof tagUsage>[1];
  onToggle: (tagId: string) => void;
}) {
  const t = useT();
  const on = new Set(picked);
  const pickedTags = tags.filter((tag) => on.has(tag.id));
  let label = t("Tags");
  if (pickedTags.length > 0) {
    const names = pickedTags.slice(0, NAMES_ON_TRIGGER).map((tag) => tag.name);
    const rest = pickedTags.length - names.length;
    label = rest > 0 ? `${names.join(", ")} +${rest}` : names.join(", ");
  }

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" className={TRIGGER} aria-label={t("Filter by tag")} title={t("Filter by tag")}>
          <TagsIcon className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
          {pickedTags.length > 0 && (
            <span className="flex shrink-0 items-center -space-x-0.5">
              {pickedTags.slice(0, NAMES_ON_TRIGGER).map((tag) => (
                <TagDot key={tag.id} color={tag.color} />
              ))}
            </span>
          )}
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="start" sideOffset={6} className={CONTENT}>
          {tags.map((tag) => {
            const checked = on.has(tag.id);
            return (
              <Dropdown.CheckboxItem
                key={tag.id}
                checked={checked}
                onCheckedChange={() => onToggle(tag.id)}
                onSelect={(e) => e.preventDefault()}
                className={cn(ITEM, checked ? "text-text" : "text-text-2")}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <CheckBox on={checked} />
                  <TagDot color={tag.color} />
                  <span className="truncate">{tag.name}</span>
                </span>
                <span className="tnum text-[11px] text-text-3">{tagUsage(tag.id, usage)}</span>
              </Dropdown.CheckboxItem>
            );
          })}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** One GitHub account at a time, or all of them: the owners projects were cloned from, with counts. */
export function GithubFilterSelect({
  owners,
  total,
  value,
  onChange,
}: {
  owners: GitHubOwnerCount[];
  /** Projects in the whole list, shown beside "All accounts". */
  total: number;
  value: string | null;
  onChange: (owner: string | null) => void;
}) {
  const t = useT();
  const ALL = "";
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          className={cn(TRIGGER, value && "border-accent/40 text-text")}
          aria-label={t("Filter by GitHub account")}
          title={t("Filter by GitHub account")}
        >
          <GitHubMark className="h-3.5 w-3.5 shrink-0 text-text-3" />
          <span className="truncate">{value ?? t("GitHub")}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="start" sideOffset={6} className={CONTENT}>
          <Dropdown.RadioGroup value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
            <Dropdown.RadioItem value={ALL} className={cn(ITEM, value === null ? "bg-accent-soft text-accent" : "text-text-2")}>
              <span className="truncate">{t("All accounts")}</span>
              <span className="tnum text-[11px] text-text-3">{total}</span>
            </Dropdown.RadioItem>
            <Dropdown.Separator className="my-1 h-px bg-border" />
            {owners.map((o) => (
              <Dropdown.RadioItem
                key={o.owner}
                value={o.owner}
                className={cn(ITEM, value === o.owner ? "bg-accent-soft text-accent" : "text-text-2")}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <GitHubMark className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate font-mono text-[12px]">{o.owner}</span>
                </span>
                <span className="tnum text-[11px] text-text-3">{o.count}</span>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
