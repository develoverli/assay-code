import { BellRing, Bot, CalendarClock, Power } from "lucide-react";
import * as React from "react";
import {
  agentNotificationsEnabled,
  notificationsEnabled,
  setAgentNotificationsEnabled,
  setNotificationsEnabled,
} from "@/lib/notify";
import { autostartEnabled, setAutostartEnabled } from "@/lib/autostart";
import { SCHEDULE_CHOICES, scheduleHours, setScheduleHours } from "@/lib/schedule";
import * as Switch from "@radix-ui/react-switch";
import { Card, Select } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

/** Autostart, scheduled scans and notifications — all off until asked for. */
export function BackgroundCard() {
  const t = useT();
  const [notify, setNotify] = React.useState(false);
  const [agentNotify, setAgentNotify] = React.useState(true);
  const [hours, setHours] = React.useState(0);
  const [denied, setDenied] = React.useState(false);
  const [autostart, setAutostart] = React.useState(false);
  const [autostartFailed, setAutostartFailed] = React.useState(false);

  React.useEffect(() => {
    void notificationsEnabled().then(setNotify);
    void agentNotificationsEnabled().then(setAgentNotify);
    void scheduleHours().then(setHours);
    // read from the OS, not from a stored copy: it can be changed from there too
    void autostartEnabled().then(setAutostart);
  }, []);

  const toggleAutostart = (on: boolean) => {
    void setAutostartEnabled(on).then((applied) => {
      setAutostart(applied);
      setAutostartFailed(applied !== on);
    });
  };

  const toggleNotify = (on: boolean) => {
    void setNotificationsEnabled(on).then((applied) => {
      setNotify(applied);
      // the OS can refuse; saying so beats a switch that silently springs back
      setDenied(on && !applied);
    });
  };

  const label = (h: number) => {
    if (h === 0) return t("Off");
    if (h === 168) return t("Weekly");
    if (h === 24) return t("Daily");
    return t("Every {n} hours", { n: h });
  };

  return (
    <Card className="mb-4 flex flex-col divide-y divide-border-soft px-4 py-1">
      <div>
        <SettingRow icon={Power} label={t("Open Assay when I sign in")}>
          <Switch.Root
            checked={autostart}
            onCheckedChange={toggleAutostart}
            aria-label={t("Open Assay when I sign in")}
            className={SWITCH}
          >
            <Switch.Thumb className={THUMB} />
          </Switch.Root>
        </SettingRow>
        {autostartFailed && (
          <p role="alert" className="pb-2 pl-[26px] text-[11px] text-warn">
            {t("The system did not accept the change. This needs an installed build, not a development run.")}
          </p>
        )}
      </div>

      <div>
        <SettingRow icon={BellRing} label={t("Notify when a run finishes")}>
          <Switch.Root
            checked={notify}
            onCheckedChange={toggleNotify}
            aria-label={t("Notify when a run finishes")}
            className={SWITCH}
          >
            <Switch.Thumb className={THUMB} />
          </Switch.Root>
        </SettingRow>
        {denied && (
          <p role="alert" className="pb-2 pl-[26px] text-[11px] text-warn">
            {t("The system refused notification permission. Turn it on for Assay in the OS settings.")}
          </p>
        )}
        {/* narrows the switch above, so it only means something while that one is on */}
        <SettingRow icon={Bot} label={t("Also when Claude finishes in a Workspace terminal")}>
          <Switch.Root
            checked={notify && agentNotify}
            disabled={!notify}
            title={!notify ? t("Turn on the notifications above first.") : undefined}
            onCheckedChange={(on) => {
              setAgentNotify(on);
              void setAgentNotificationsEnabled(on);
            }}
            aria-label={t("Also when Claude finishes in a Workspace terminal")}
            className={`${SWITCH} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <Switch.Thumb className={THUMB} />
          </Switch.Root>
        </SettingRow>
        <p className="pb-2 pl-[26px] text-[11px] text-text-3">
          {t("Only when that terminal is not on screen. Its tab shows a dot either way.")}
        </p>
      </div>

      <SettingRow icon={CalendarClock} label={t("Scheduled scans")}>
        <Select
          className="w-[150px] shrink-0"
          value={String(hours)}
          onChange={(v) => {
            const n = Number(v);
            setHours(n);
            void setScheduleHours(n);
          }}
          aria-label={t("Scheduled scans")}
          options={SCHEDULE_CHOICES.map((h) => ({ value: String(h), label: label(h) }))}
        />
      </SettingRow>
    </Card>
  );
}

export const SWITCH =
  "relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-surface-3 transition-colors data-[state=checked]:bg-accent focus-visible:outline-2 focus-visible:outline-accent";
export const THUMB =
  "block h-4 w-4 translate-x-0.5 rounded-full bg-accent-fg transition-transform data-[state=checked]:translate-x-[18px]";

/** One option, one line: what it is and the control. */
export function SettingRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center gap-2.5 py-2">
      <Icon className="h-4 w-4 shrink-0 text-text-3" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{label}</span>
      {children}
    </div>
  );
}
