import * as Switch from "@radix-ui/react-switch";
import { CloudDownload, RefreshCw } from "lucide-react";
import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { Button, Card } from "@/components/ui/primitives";
import { useDates } from "@/lib/dates";
import { useT } from "@/lib/i18n";
import { useUpdater } from "@/store/updater";
import { SettingRow, SWITCH, THUMB } from "./BackgroundCard";

/**
 * Updates: whether Assay looks for a new version on its own, and a check that
 * always works. Looking is one GET of the release's latest.json; nothing about
 * the user goes with it, and nothing installs until they choose to.
 */
export function UpdatesCard() {
  const t = useT();
  const { ago } = useDates();
  const s = useUpdater(
    useShallow((st) => ({
      auto: st.auto,
      phase: st.phase,
      checkedAt: st.checkedAt,
      update: st.update,
      error: st.error,
    })),
  );
  const setAuto = useUpdater((st) => st.setAuto);
  const checkNow = useUpdater((st) => st.checkNow);
  const setDialogOpen = useUpdater((st) => st.setDialogOpen);
  // only what this card itself asked for is reported under it
  const [asked, setAsked] = React.useState(false);

  let status: React.ReactNode = null;
  if (s.phase === "checking") status = t("Checking…");
  else if (asked && s.phase === "error" && s.error) status = <span className="text-danger">{t("The check failed: {error}", { error: s.error })}</span>;
  else if (s.update && s.phase !== "idle")
    status = (
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="cursor-pointer rounded text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {t("Assay {version} is available", { version: s.update.version })}
      </button>
    );
  else if (s.checkedAt) status = t("Up to date · checked {when}", { when: ago(s.checkedAt) });

  return (
    <Card className="mb-4 flex flex-col divide-y divide-border-soft px-4 py-1">
      <div>
        <SettingRow icon={CloudDownload} label={t("Look for updates automatically")}>
          <Switch.Root
            checked={s.auto}
            onCheckedChange={(on) => void setAuto(on)}
            aria-label={t("Look for updates automatically")}
            className={SWITCH}
          >
            <Switch.Thumb className={THUMB} />
          </Switch.Root>
        </SettingRow>
        <p className="pb-2 pl-[26px] text-[11px] text-text-3">
          {t("After launch and every 6 hours, Assay reads the newest published release on GitHub. Nothing about you is sent, and nothing installs until you choose.")}
        </p>
      </div>
      <div className="flex min-h-11 items-center gap-2.5 py-2">
        <span className="min-w-0 flex-1 pl-[26px] text-[12px] text-text-2" role="status" aria-live="polite">
          {status}
        </span>
        <Button
          variant="secondary"
          size="sm"
          loading={s.phase === "checking"}
          onClick={() => {
            setAsked(true);
            void checkNow(true);
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" /> {t("Check now")}
        </Button>
      </div>
    </Card>
  );
}
