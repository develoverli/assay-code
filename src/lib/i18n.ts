import { create } from "zustand";
import * as db from "@/lib/db";
import { ES } from "@/i18n/es";

/**
 * Translations without a library. The key is the English sentence, so English needs
 * no dictionary and an untranslated string still renders. Tool output is never translated.
 */

export type Lang = "en" | "es";

export const LANGUAGES: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

export type Vars = Record<string, string | number>;

const DICTIONARIES: Record<Lang, Record<string, string>> = { en: {}, es: ES };

// Maps, not records: a record indexed by an arbitrary key can reach the prototype.
const DICTIONARY_BY_LANG = new Map<string, Map<string, string>>(
  Object.entries(DICTIONARIES).map(([lang, dict]) => [lang, new Map(Object.entries(dict))]),
);

const LANG_SETTING = "ui.language";

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  const values = new Map<string, string | number>(Object.entries(vars));
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = values.get(name);
    return v === undefined ? whole : String(v);
  });
}

export function translate(lang: Lang, key: string, vars?: Vars): string {
  return interpolate(DICTIONARY_BY_LANG.get(lang)?.get(key) ?? key, vars);
}

/** The system's choice, used until the user picks one. */
function detectLang(): Lang {
  const nav = typeof navigator === "undefined" ? "" : navigator.language;
  return nav.toLowerCase().startsWith("es") ? "es" : "en";
}

interface LangState {
  lang: Lang;
  /** False until the stored preference has been read, so nothing flashes. */
  ready: boolean;
  init: () => Promise<void>;
  setLang: (lang: Lang) => Promise<void>;
}

export const useLang = create<LangState>((set) => ({
  lang: detectLang(),
  ready: false,
  init: async () => {
    try {
      const stored = await db.getSetting(LANG_SETTING);
      set({ lang: stored === "es" || stored === "en" ? stored : detectLang(), ready: true });
    } catch {
      set({ ready: true });
    }
  },
  setLang: async (lang) => {
    set({ lang });
    await db.setSetting(LANG_SETTING, lang).catch(() => {});
  },
}));

/**
 * Translate inside a component. The hook subscribes to the language, so
 * switching it re-renders everything that uses it.
 */
export function useT(): (key: string, vars?: Vars) => string {
  const lang = useLang((s) => s.lang);
  return (key, vars) => translate(lang, key, vars);
}

/** Translate outside React (stores, lib code that builds a user-facing message). */
export function tr(key: string, vars?: Vars): string {
  return translate(useLang.getState().lang, key, vars);
}
