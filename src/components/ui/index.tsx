import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Minimal shadcn-style primitives.
 *
 * Hand-written rather than generated: the app needs about a dozen components,
 * and owning them outright avoids a code-generation step and a pile of Radix
 * dependencies for an internal single-user tool. Same API shape and Tailwind
 * class conventions, so swapping in the real shadcn/ui later is mechanical.
 */

// ----------------------------------------------------------------- button ---

type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "outline";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-500 text-ink-950 hover:bg-brand-400 disabled:bg-ink-700 disabled:text-ink-400 font-semibold",
  secondary:
    "bg-ink-700 text-ink-100 hover:bg-ink-600 disabled:bg-ink-800 disabled:text-ink-500",
  outline:
    "border border-ink-600 text-ink-100 hover:bg-ink-800 disabled:text-ink-500",
  ghost: "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
  danger: "bg-danger-600 text-white hover:bg-danger-500",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs rounded-md gap-1.5",
  md: "h-9 px-4 text-sm rounded-md gap-2",
  lg: "h-11 px-6 text-base rounded-lg gap-2",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  className,
  variant = "secondary",
  size = "md",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-70",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

// ------------------------------------------------------------------- card ---

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-ink-800 bg-ink-900 shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("border-b border-ink-800 px-5 py-3.5", className)}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-sm font-semibold text-ink-100", className)}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("mt-0.5 text-xs text-ink-400", className)} {...props} />
  );
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}

// ------------------------------------------------------------------ badge ---

type BadgeTone =
  | "neutral"
  | "brand"
  | "ok"
  | "warn"
  | "danger"
  | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-ink-800 text-ink-300 border-ink-700",
  brand: "bg-brand-500/15 text-brand-400 border-brand-500/30",
  ok: "bg-ok-500/15 text-ok-500 border-ok-500/30",
  warn: "bg-warn-500/15 text-warn-500 border-warn-500/30",
  danger: "bg-danger-500/15 text-danger-500 border-danger-500/30",
  info: "bg-accent-500/15 text-accent-500 border-accent-500/30",
};

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

// ------------------------------------------------------------------ input ---

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-ink-700 bg-ink-850 px-3 text-sm text-ink-100",
        "placeholder:text-ink-500 focus:border-accent-500 focus:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100",
        "placeholder:text-ink-500 focus:border-accent-500 focus:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-60 resize-y",
        className,
      )}
      {...props}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-ink-700 bg-ink-850 px-2 text-sm text-ink-100",
        "focus:border-accent-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
});

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "mb-1 block text-xs font-medium text-ink-300",
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint ? <p className="mt-1 text-[11px] text-ink-500">{hint}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------------ table ---

export function Table({
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}

export function Th({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "border-b border-ink-800 px-3 py-2 text-left text-xs font-semibold text-ink-400 whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}

export function Td({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn("border-b border-ink-850 px-3 py-2 align-middle", className)}
      {...props}
    />
  );
}

// ------------------------------------------------------------------ alert ---

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "warn" | "danger" | "ok";
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-accent-500/30 bg-accent-500/10 text-accent-500",
    warn: "border-warn-500/30 bg-warn-500/10 text-warn-500",
    danger: "border-danger-500/30 bg-danger-500/10 text-danger-500",
    ok: "border-ok-500/30 bg-ok-500/10 text-ok-500",
  } as const;
  return (
    <div
      className={cn("rounded-lg border px-4 py-3 text-sm", tones[tone], className)}
      role="status"
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? (
        <div className="mt-0.5 text-ink-200">{children}</div>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------- stat tile ---

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: BadgeTone;
}) {
  const accents: Record<BadgeTone, string> = {
    neutral: "text-ink-100",
    brand: "text-brand-400",
    ok: "text-ok-500",
    warn: "text-warn-500",
    danger: "text-danger-500",
    info: "text-accent-500",
  };
  return (
    <Card className="px-4 py-3">
      <p className="text-[11px] font-medium tracking-wide text-ink-400 uppercase">
        {label}
      </p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", accents[tone])}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-ink-500">{hint}</p> : null}
    </Card>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-700 px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink-200">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-xs text-ink-500">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-ink-100">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-ink-400">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function ProgressBar({
  value,
  tone = "brand",
}: {
  value: number;
  tone?: "brand" | "ok" | "danger";
}) {
  const pct = Math.min(100, Math.max(0, value * 100));
  const colors = {
    brand: "bg-brand-500",
    ok: "bg-ok-500",
    danger: "bg-danger-500",
  } as const;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
      <div
        className={cn("h-full rounded-full transition-all", colors[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
