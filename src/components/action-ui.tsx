"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Alert, Button, type ButtonProps } from "@/components/ui";

/**
 * Thin client wrappers around server actions.
 *
 * Every mutation in this app is a server action, so the UI only needs two
 * shapes: a button that runs one, and a form that submits one. Both surface the
 * action's Vietnamese message inline instead of throwing a stack trace at the
 * operator.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
  details?: string[];
}

/**
 * A button that runs a server action, with an optional inline confirmation.
 *
 * The confirmation is rendered in the page rather than through `window.confirm`.
 * A native dialog cannot show the estimate, cannot be written in the app's own
 * Vietnamese voice, and blocks the whole renderer while it is open - which also
 * makes the UI impossible to drive from a test harness.
 */
export function ActionButton({
  action,
  confirm,
  children,
  onDone,
  ...props
}: Omit<ButtonProps, "onClick"> & {
  action: () => Promise<ActionResult>;
  confirm?: string;
  onDone?: (result: ActionResult) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [confirming, setConfirming] = React.useState(false);
  const router = useRouter();

  const run = () => {
    setConfirming(false);
    startTransition(async () => {
      const result = await action();
      onDone?.(result);
      router.refresh();
    });
  };

  if (confirming && confirm) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-1.5">
        <span className="text-xs text-ink-200">{confirm}</span>
        <Button size="sm" variant="primary" onClick={run}>
          Xác nhận
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Huỷ
        </Button>
      </span>
    );
  }

  return (
    <Button
      {...props}
      disabled={pending || props.disabled}
      onClick={() => {
        if (confirm) setConfirming(true);
        else run();
      }}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {children}
    </Button>
  );
}

export function ActionFeedback({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <Alert tone={result.ok ? "ok" : "danger"} title={result.message}>
      {result.details && result.details.length > 0 ? (
        <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
          {result.details.map((detail, i) => (
            <li key={i}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

/**
 * A form bound to a server action. Keeps the result on screen and refreshes the
 * server components underneath on success.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  submitLabel,
  submitVariant = "primary",
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  submitLabel: string;
  submitVariant?: ButtonProps["variant"];
}) {
  const [result, setResult] = React.useState<ActionResult | null>(null);
  const [pending, startTransition] = React.useTransition();
  const formRef = React.useRef<HTMLFormElement>(null);
  const router = useRouter();

  return (
    <form
      ref={formRef}
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(async () => {
          const res = await action(formData);
          setResult(res);
          if (res.ok) {
            if (resetOnSuccess) formRef.current?.reset();
            router.refresh();
          }
        });
      }}
    >
      {children}
      <div className="mt-4 flex items-center gap-3">
        <Button type="submit" variant={submitVariant} disabled={pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {submitLabel}
        </Button>
      </div>
      {result ? (
        <div className="mt-3">
          <ActionFeedback result={result} />
        </div>
      ) : null}
    </form>
  );
}

/** Button + inline result, for one-off actions outside a form. */
export function ActionButtonWithFeedback({
  action,
  confirm,
  children,
  ...props
}: Omit<ButtonProps, "onClick"> & {
  action: () => Promise<ActionResult>;
  confirm?: string;
}) {
  const [result, setResult] = React.useState<ActionResult | null>(null);
  return (
    <div className="space-y-2">
      <ActionButton
        {...props}
        action={action}
        confirm={confirm}
        onDone={setResult}
      >
        {children}
      </ActionButton>
      <ActionFeedback result={result} />
    </div>
  );
}

/** Collapsible panel used for the "add new" forms on catalogue pages. */
export function Disclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "Đóng" : label}
      </Button>
      {open ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
