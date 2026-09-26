"use client";

import { useState } from "react";

/**
 * Copy an output path to the clipboard. Local, free.
 *
 * The result is always shown: a browser may refuse the Clipboard API (page not
 * focused, permission, non-secure origin), and a silent refusal reads exactly
 * like a copy that worked. The old textarea + execCommand route is the
 * fallback; if both fail the button says so and the path stays on screen.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea route
  }
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

export function CopyPathButton({ path, className }: { path: string; className?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "failed">("idle");
  return (
    <button
      type="button"
      className={
        className ?? "rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:border-brand-500"
      }
      onClick={async () => setState((await copyText(path)) ? "ok" : "failed")}
      title={path}
    >
      {state === "ok" ? "ĐÃ COPY" : state === "failed" ? "COPY LỖI — chép tay đường dẫn" : "COPY PATH"}
    </button>
  );
}
