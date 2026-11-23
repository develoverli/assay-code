import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/primitives";

export const Dialog = D.Root;

export function DialogContent({
  className,
  children,
  title,
  desc,
}: {
  className?: string;
  children: React.ReactNode;
  title: string;
  desc?: string;
}) {
  const t = useT();
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px]" />
      <D.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] max-h-[86vh] -translate-x-1/2 -translate-y-1/2 overflow-auto",
          "rounded-xl border border-border bg-surface p-5 shadow-2xl animate-in",
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <D.Title className="text-sm font-semibold text-text">{title}</D.Title>
            {desc && <D.Description className="mt-1 text-xs text-text-3">{desc}</D.Description>}
          </div>
          <D.Close asChild>
            <Button variant="ghost" size="icon" aria-label={t("Close")}>
              <X className="h-4 w-4" />
            </Button>
          </D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  confirmDisabled,
  danger,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  /** For a dialog still resolving what it would do — the body says why. */
  confirmDisabled?: boolean;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title}>
        <div className="text-[13px] leading-relaxed text-text-2">{body}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={confirmDisabled}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel ?? t("Confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
