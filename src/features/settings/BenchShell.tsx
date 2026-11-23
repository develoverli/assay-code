import { SquareTerminal } from "lucide-react";
import * as React from "react";
import * as db from "@/lib/db";
import {
  resetShellCache,
  resolveShell,
  SHELL_OPTIONS,
  SHELL_SETTING,
  type ShellSpec,
} from "@/lib/bench-term";
import { Button, Card, Field, Input, Select } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

const CUSTOM = "custom";

/**
 * Which shell Workspace terminals open. Windows Terminal is deliberately absent:
 * it is an emulator, not a shell, and would open its own window.
 */
export function BenchShell() {
  const t = useT();
  const [choice, setChoice] = React.useState<string>("auto");
  const [customPath, setCustomPath] = React.useState("");
  const [resolved, setResolved] = React.useState<ShellSpec | null>(null);

  const refresh = React.useCallback(() => {
    resetShellCache();
    void resolveShell()
      .then(setResolved)
      .catch(() => setResolved(null));
  }, []);

  React.useEffect(() => {
    void db.getSetting(SHELL_SETTING).then((v) => {
      const stored = v === null ? "auto" : v;
      if (SHELL_OPTIONS.some((o) => o.value === stored)) {
        setChoice(stored);
      } else {
        setChoice(CUSTOM);
        setCustomPath(stored);
      }
      refresh();
    });
  }, [refresh]);

  const store = (value: string) => {
    void db.setSetting(SHELL_SETTING, value).then(refresh);
  };

  const pick = (v: string) => {
    setChoice(v);
    if (v === CUSTOM) {
      if (customPath.trim()) store(customPath.trim());
    } else {
      store(v);
    }
  };

  return (
    <Card className="mb-4 flex flex-col gap-3 p-4">
      <div className="flex items-start gap-2.5">
        <SquareTerminal className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">{t("Bench shell")}</h2>
          <p className="text-[11px] text-text-3">
            {t(
              "What a Bench terminal opens. Windows Terminal is not an option: it is a terminal emulator, not a shell, so it would open its own window instead of a tab here.",
            )}
          </p>
        </div>
      </div>

      <Field label={t("Shell")}>
        <div className="flex gap-2">
          <Select
            className="flex-1"
            value={choice}
            onChange={pick}
            aria-label={t("Bench shell")}
            options={[
              ...SHELL_OPTIONS.map((o) => ({ value: o.value, label: t(o.label), hint: o.hint ? t(o.hint) : undefined })),
              { value: CUSTOM, label: t("Custom path…") },
            ]}
          />
          <Button variant="ghost" size="sm" onClick={refresh}>
            {t("Re-check")}
          </Button>
        </div>
      </Field>

      {choice === CUSTOM && (
        <Input
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
          onBlur={() => customPath.trim() && store(customPath.trim())}
          placeholder="C:\\Program Files\\Git\\bin\\bash.exe"
          aria-label={t("Path to the shell")}
          className="font-mono text-xs"
        />
      )}

      <p className="font-mono text-[11px] text-text-2">
        {resolved
          ? t("Using {shell} — {path}", { shell: resolved.label, path: resolved.program })
          : t("checking…")}
      </p>
    </Card>
  );
}
