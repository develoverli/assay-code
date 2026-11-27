import { RotateCcw } from "lucide-react";
import * as React from "react";
import { DEFAULT_TEMPLATES, getTemplate, setTemplate, type TemplateStyle } from "@/lib/commit-style";
import { Button, Card, Field, Textarea } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

const STYLES: { style: TemplateStyle; label: string; hint: string }[] = [
  {
    style: "gitmoji",
    label: "Gitmoji first",
    hint: "Projects without release-please: ✨ feat(scope): …",
  },
  {
    style: "release-please",
    label: "release-please",
    hint: "Projects with release-please's files, or set to it: feat(scope): ✨ …. release-please skips a subject that starts with an emoji.",
  },
];

/**
 * The instructions Write with AI sends, one per commit style. Saved when the
 * field loses focus; the diff is appended by Assay, so it is never written here.
 * A project set to Custom prompt uses its own text instead (its project dialog).
 */
export function CommitPromptsCard() {
  const t = useT();
  const [values, setValues] = React.useState<Record<TemplateStyle, string> | null>(null);
  const [saved, setSaved] = React.useState<TemplateStyle | null>(null);

  React.useEffect(() => {
    let ignore = false;
    void Promise.all([getTemplate("gitmoji"), getTemplate("release-please")]).then(([gitmoji, rp]) => {
      if (!ignore) setValues({ gitmoji, "release-please": rp });
    });
    return () => {
      ignore = true;
    };
  }, []);

  React.useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(null), 1600);
    return () => window.clearTimeout(id);
  }, [saved]);

  const save = (style: TemplateStyle, text: string) => {
    void setTemplate(style, text).then(() => setSaved(style));
  };

  return (
    <Card className="mb-4 flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-[13px] font-semibold">{t("Commit message prompts")}</h2>
        <p className="text-[11px] text-text-3">
          {t("What Write with AI asks for, per commit style. Assay adds the diff after it and keeps only the first line of the answer.")}
        </p>
      </div>
      {STYLES.map(({ style, label, hint }) => {
        const text = values?.[style] ?? "";
        const isDefault = text.trim() === DEFAULT_TEMPLATES[style].trim();
        return (
          <Field key={style} label={t(label)} hint={t(hint)}>
            <Textarea
              value={text}
              disabled={!values}
              onChange={(e) => setValues((cur) => (cur ? { ...cur, [style]: e.target.value } : cur))}
              onBlur={(e) => save(style, e.target.value)}
              rows={7}
              aria-label={t(label)}
              className="font-mono text-[11px] leading-relaxed"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!values || isDefault}
                title={isDefault ? t("Already the default") : undefined}
                onClick={() => {
                  setValues((cur) => (cur ? { ...cur, [style]: DEFAULT_TEMPLATES[style] } : cur));
                  save(style, DEFAULT_TEMPLATES[style]);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" /> {t("Restore default")}
              </Button>
              <span role="status" aria-atomic="true" className="text-[11px] text-success">
                {saved === style ? t("Saved") : ""}
              </span>
            </div>
          </Field>
        );
      })}
    </Card>
  );
}
