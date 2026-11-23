import { format, formatDistanceToNow } from "date-fns";
import { enUS, es } from "date-fns/locale";
import type { Locale } from "date-fns";
import { useLang, type Lang } from "@/lib/i18n";

/** Dates in the app's language; date-fns alone defaults to English. */

// A Map so a lookup can only return a locale that was put in here.
const LOCALES = new Map<string, Locale>([
  ["en", enUS],
  ["es", es],
]);

function localeFor(lang: Lang): Locale {
  return LOCALES.get(lang) ?? enUS;
}

/** Subscribes to the language, so switching it re-renders the timestamps. */
export function useDates() {
  const lang = useLang((s) => s.lang);
  const locale = localeFor(lang);
  return {
    /** "2 hours ago" / "hace 2 horas". */
    ago: (ms: number | null | undefined) =>
      ms ? formatDistanceToNow(ms, { addSuffix: true, locale }) : "—",
    /** An absolute moment, for the audit trail. */
    at: (ms: number, pattern = "PPpp") => format(ms, pattern, { locale }),
  };
}
