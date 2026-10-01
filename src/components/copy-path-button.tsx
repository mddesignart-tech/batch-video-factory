"use client";

import { useState } from "react";

/**
 * Copy an output path to the clipboard. Local, free.
 *
 * The result is always shown, and it is always the TRUE result:
 *  - the Clipboard API can reject (permission, non-secure origin) or simply
 *    never settle (seen in QA with the permission already "granted" while the
 *    window was not in the foreground) - so it gets a short deadline, then the
 *    textarea + execCommand route is tried;
 *  - a Clipboard API call that settles AFTER the deadline still counts: if it
 *    succeeds late, the button turns to ĐÃ COPY instead of staying on an error
 *    that is no longer true.
 */

export type CopyOutcome = "ok" | "failed";

const CLIPBOARD_DEADLINE_MS = 1500;

function copyWithTextarea(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export async function copyText(text: string, onLateSuccess?: () => void): Promise<CopyOutcome> {
  if (navigator.clipboard?.writeText) {
    let timedOut = false;
    const api = navigator.clipboard.writeText(text).then(
      () => {
        if (timedOut) onLateSuccess?.();
        return true;
      },
      () => false,
    );
    const deadline = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), CLIPBOARD_DEADLINE_MS));
    const first = await Promise.race([api, deadline]);
    if (first === true) return "ok";
    if (first === "timeout") timedOut = true;
  }
  return copyWithTextarea(text) ? "ok" : "failed";
}

export function CopyPathButton({ path, className }: { path: string; className?: string }) {
  const [state, setState] = useState<"idle" | "busy" | CopyOutcome>("idle");
  return (
    <button
      type="button"
      className={
        className ?? "rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:border-brand-500"
      }
      onClick={async () => {
        setState("busy");
        setState(await copyText(path, () => setState("ok")));
      }}
      title={path}
    >
      {state === "ok"
        ? "ĐÃ COPY"
        : state === "failed"
          ? "COPY LỖI — chép tay đường dẫn"
          : state === "busy"
            ? "ĐANG COPY…"
            : "COPY PATH"}
    </button>
  );
}

/**
 * COPY TITLE / COPY DESCRIPTION / COPY DANH SÁCH (V1.2 Phase 6): the same
 * honest copy as COPY PATH - Clipboard API with a deadline, textarea fallback,
 * and when both fail the text is shown selected so it can be copied by hand.
 */
export function CopyTextButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "busy" | CopyOutcome>("idle");
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        className={
          className ?? "rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:border-brand-500"
        }
        onClick={async () => {
          setState("busy");
          setState(await copyText(text, () => setState("ok")));
        }}
        title={text.slice(0, 300)}
      >
        {state === "ok" ? "ĐÃ COPY" : state === "failed" ? "COPY LỖI — chép tay bên dưới" : state === "busy" ? "ĐANG COPY…" : label}
      </button>
      {state === "failed" ? (
        <textarea
          readOnly
          value={text}
          className="h-20 w-64 rounded border border-ink-700 bg-ink-900 p-1 text-[11px] text-ink-200"
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
        />
      ) : null}
    </span>
  );
}
