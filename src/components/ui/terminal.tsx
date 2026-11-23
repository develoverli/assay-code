import * as React from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function Terminal({
  text,
  className,
  autoScroll = true,
}: {
  text: string;
  className?: string;
  autoScroll?: boolean;
}) {
  const t = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  const stick = React.useRef(true);

  const clean = React.useMemo(() => text.replace(ANSI, ""), [text]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !autoScroll || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [clean, autoScroll]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={cn(
        "selectable overflow-auto rounded-md border border-border bg-bg p-3",
        "font-mono text-[12px] leading-[1.55] text-text-2 whitespace-pre-wrap break-words",
        className,
      )}
    >
      {clean || <span className="text-text-3">{t("Waiting for output…")}</span>}
    </div>
  );
}
