import { Languages } from "lucide-react";
import { LANGUAGES, useLang, useT, type Lang } from "@/lib/i18n";
import { Card, Select } from "@/components/ui/primitives";

/** Translates Assay's own copy only; tool output is never translated. */
export function LanguageCard() {
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const t = useT();

  return (
    <Card className="mb-4 flex items-center justify-between gap-4 p-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <Languages className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">{t("Language")}</h2>
          <p className="text-[11px] text-text-3">
            {t("Applies to Assay's own interface. Tool output and findings stay in the words the tool used.")}
          </p>
        </div>
      </div>
      <Select
        className="w-[160px] shrink-0"
        value={lang}
        onChange={(v) => void setLang(v as Lang)}
        aria-label={t("Language")}
        options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
      />
    </Card>
  );
}
