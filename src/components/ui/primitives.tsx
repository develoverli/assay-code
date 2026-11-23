import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Switch from "@radix-ui/react-switch";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown, Loader2 } from "lucide-react";
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

/* ---------------------------------- Button ---------------------------------- */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 disabled:pointer-events-none cursor-pointer select-none",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent/90",
        secondary: "bg-surface-2 text-text hover:bg-surface-3 border border-border",
        outline: "border border-border text-text-2 hover:text-text hover:bg-surface-2",
        ghost: "text-text-2 hover:text-text hover:bg-surface-2",
        danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
        subtle: "bg-accent-soft text-accent hover:bg-accent-soft/70",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-[13px]",
        lg: "h-9 px-4 text-sm",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

/** A leading icon: a component element with no children of its own (lucide's shape). */
function isIcon(node: React.ReactNode): node is React.ReactElement<{ className?: string }> {
  if (!React.isValidElement(node) || typeof node.type === "string") return false;
  return (node.props as { children?: React.ReactNode }).children === undefined;
}

/**
 * The button keeps its width while it loads (an added spinner would push its
 * neighbours onto the next line): the spinner takes the leading icon's place,
 * or sits centred over the label, which stays in the layout hidden.
 */
function loadingContent(children: React.ReactNode): React.ReactNode {
  const parts = React.Children.toArray(children);
  const [first, ...rest] = parts;
  if (isIcon(first)) {
    return (
      <>
        <Loader2 aria-hidden className={cn("h-3.5 w-3.5", first.props.className, "animate-spin")} />
        {rest}
      </>
    );
  }
  return (
    <>
      {/* opacity, not visibility: the label still names the button to a screen reader */}
      <span className="inline-flex items-center gap-1.5 opacity-0">{children}</span>
      <Loader2 aria-hidden className="absolute h-3.5 w-3.5 animate-spin" />
    </>
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), loading && "relative", className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && !asChild ? loadingContent(children) : children}
      </Comp>
    );
  },
);
Button.displayName = "Button";

/* ----------------------------------- Card ----------------------------------- */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-surface", className)} {...props} />;
}

/* ---------------------------------- Badge ----------------------------------- */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
  {
    variants: {
      tone: {
        neutral: "border-border bg-surface-2 text-text-2",
        accent: "border-accent/30 bg-accent-soft text-accent",
        success: "border-success/30 bg-success/10 text-success",
        warn: "border-warn/30 bg-warn/10 text-warn",
        danger: "border-danger/30 bg-danger/10 text-danger",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);
export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/* ---------------------------------- Inputs ---------------------------------- */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text placeholder:text-text-3 selectable",
        "focus-visible:border-accent focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-md border border-border bg-surface-2 px-2.5 py-2 text-[13px] text-text placeholder:text-text-3 selectable resize-y",
        "focus-visible:border-accent focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

/* ---------------------------------- Select ---------------------------------- */
export interface SelectOption {
  value: string;
  label: string;
  /** Secondary line under the label (a model name, why it's unavailable…). */
  hint?: string;
  disabled?: boolean;
  /** Options sharing a group are listed under its heading, in the order given. */
  group?: string;
}

/**
 * A select on the dropdown primitive: a native `<select>` draws an OS popup
 * (light in a dark app) with no room for a hint line or a disabled reason.
 */
export function Select({
  value,
  onChange,
  options,
  className,
  size = "md",
  disabled,
  "aria-label": ariaLabel,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  className?: string;
  size?: "sm" | "md";
  /** Shown, greyed, and unopenable — the choice exists but is not yours yet. */
  disabled?: boolean;
  "aria-label"?: string;
  title?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={title}
          disabled={disabled}
          className={cn(
            "inline-flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 text-text",
            "transition-colors focus-visible:outline-2 focus-visible:outline-accent",
            disabled
              ? "cursor-not-allowed opacity-50"
              : "cursor-pointer hover:bg-surface-3 data-[state=open]:border-accent/40 data-[state=open]:bg-accent-soft data-[state=open]:text-accent",
            size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-2.5 text-[13px]",
            className,
          )}
        >
          <span className="truncate">{current?.label ?? value}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[360px] overflow-auto rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
        >
          {options.map((o, i) => {
            let tone = "cursor-pointer text-text-2 data-[highlighted]:bg-surface-2 data-[highlighted]:text-text";
            if (o.disabled) tone = "cursor-not-allowed text-text-3 opacity-60";
            else if (o.value === value) tone = "cursor-pointer bg-accent-soft text-accent";
            const heading = o.group && o.group !== options[i - 1]?.group ? o.group : null;
            return (
              <React.Fragment key={o.value}>
                {heading && (
                  <DropdownMenu.Label className="px-2.5 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-text-3 first:pt-1">
                    {heading}
                  </DropdownMenu.Label>
                )}
                <DropdownMenu.Item
                  disabled={o.disabled}
                  onSelect={() => onChange(o.value)}
                  className={cn("flex flex-col rounded-md px-2.5 py-1.5 text-[13px] outline-none", tone)}
                >
                  <span className="font-medium">{o.label}</span>
                  {o.hint && <span className="truncate text-[10px] text-text-3">{o.hint}</span>}
                </DropdownMenu.Item>
              </React.Fragment>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Label({ className, htmlFor, children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label htmlFor={htmlFor} className={cn("text-xs font-medium text-text-2", className)} {...props}>
      {children}
    </label>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  /** Ties the label to a control that isn't wrapped by it (a bare `<input>`, a datalist field…). */
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-text-3">{hint}</p>}
    </div>
  );
}

/**
 * A boxed on/off row: title, one line of explanation, and the toggle. The whole
 * box is the label, so clicking anywhere in it flips the switch.
 */
export function SwitchField({
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between rounded-md border border-border bg-surface-2 px-3 py-2.5">
      <span className="flex flex-col">
        <span className="text-[13px] font-medium text-text">{label}</span>
        <span className="text-[11px] text-text-3">{hint}</span>
      </span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative h-5 w-9 rounded-full bg-surface-3 data-[state=checked]:bg-accent transition-colors cursor-pointer"
      >
        <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-accent-fg transition-transform data-[state=checked]:translate-x-[18px]" />
      </Switch.Root>
    </label>
  );
}

/* --------------------------------- feedback --------------------------------- */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-text-3", className)} />;
}

export function EmptyState({
  icon: Icon,
  title,
  desc,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center animate-in">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-text-3">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-medium text-text">{title}</p>
        {desc && <p className="mt-1 max-w-sm text-xs text-text-3">{desc}</p>}
      </div>
      {action}
    </div>
  );
}
