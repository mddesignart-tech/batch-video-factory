"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, Loader2 } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import {
  chooseVideoModelAction,
  getVideoModelChoices,
  makeSceneVideoAction,
  useLocalMotionAction,
} from "@/app/actions/projects";
import { BudgetProblemBox } from "@/components/video-budget";
import { splitNeedsSelection } from "@/domain/video-selection";
import type { VideoModelChoice } from "@/services/generation";
import type { SceneVideoResult } from "@/services/scene-video";

/**
 * VIDEO MODEL NEEDS_SELECTION, in the person's terms (QĐ-120).
 *
 * One sentence and three choices instead of the router's full rejection list;
 * the list is still one click away under "Xem chi tiết kỹ thuật". Choosing a
 * model is free; the clip is bought only from "TẠO VIDEO", after the price is
 * shown, the budget checked and a second explicit click.
 */
export function VideoSelectionPanel({
  sceneId,
  sceneNumber,
  complexity,
  projectId,
  videoLimit,
  rawMessage,
  pinned,
}: {
  sceneId: string;
  sceneNumber: number;
  complexity: string;
  projectId: string;
  videoLimit: number | null;
  /** The stop message (or the plan's "needs provider" text); null when only a pin waits for its clip. */
  rawMessage: string | null;
  /** "provider/model" when a model is already chosen. */
  pinned: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<VideoModelChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [confirmCost, setConfirmCost] = useState<number | null>(null);
  const [budget, setBudget] = useState<SceneVideoResult["budget"] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setOpen(false);
    setChoices(null);
    setConfirmCost(null);
    setBudget(null);
    setMessage(null);
  }, [sceneId, pinned]);

  const split = rawMessage ? splitNeedsSelection(rawMessage) : null;
  const pinGone = Boolean(split?.summary.includes("không còn khả dụng") || split?.summary.includes("chưa hỗ trợ"));
  const shapeProblem = split?.summary.match(/Model video này chưa hỗ trợ [^.]+/)?.[0] ?? null;
  const money = (n: number) => `~$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
  const pinnedChoice = pinned && choices ? (choices.find((c) => `${c.provider}/${c.model}` === pinned) ?? null) : null;

  async function loadChoices() {
    const r = await getVideoModelChoices(sceneId);
    if (r.ok && r.data) setChoices(r.data.choices);
    else setMessage({ ok: false, text: r.message });
  }

  useEffect(() => {
    if (pinned && !choices) void loadChoices();
  }, [pinned, sceneId]);

  async function guarded(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const choose = (c: VideoModelChoice) =>
    guarded(async () => {
      const r = await chooseVideoModelAction(sceneId, c.provider, c.model);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) {
        setOpen(false);
        router.refresh();
      }
    });

  const local = (skipAi: boolean) =>
    guarded(async () => {
      const r = await useLocalMotionAction(sceneId, skipAi);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });

  const make = (confirm: boolean) =>
    guarded(async () => {
      const r = await makeSceneVideoAction(sceneId, confirm ? { confirmPaid: true, expectedCost: confirmCost ?? undefined } : {});
      setBudget(r.status === "NEEDS_BUDGET" ? ((r as SceneVideoResult).budget ?? null) : null);
      if (r.status === "NEEDS_CONFIRMATION") {
        setConfirmCost((r as SceneVideoResult).choice?.estimatedCost ?? null);
        setMessage({ ok: true, text: r.message });
        return;
      }
      setConfirmCost(null);
      if (r.status !== "NEEDS_BUDGET") setMessage({ ok: r.status === "DONE", text: r.message });
      if (r.status === "DONE") router.refresh();
    });

  const usable = (choices ?? []).filter((c) => c.selectable);
  const gone = (choices ?? []).filter((c) => !c.selectable);

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-warn-500/40 bg-warn-500/10 p-3 text-[11px] text-ink-200">
      <p className="flex items-center gap-1.5 font-semibold text-warn-500">
        <Clapperboard className="h-3.5 w-3.5" />
        {shapeProblem
          ? `${shapeProblem}.`
          : pinGone
          ? "Model cũ không còn khả dụng. Chọn model thay thế."
          : rawMessage
            ? "Không có model Video AI nào hiện đủ điều kiện chạy tự động cho cảnh này."
            : `Cảnh ${sceneNumber} dùng model chọn thủ công.`}
      </p>
      <div className="space-y-0.5 text-ink-300">
        <p>Độ phức tạp: {complexity}</p>
        <p>Video AI: {pinned && !pinGone ? `đã chọn ${pinned}` : "cần chọn thủ công"}</p>
      </div>

      {pinned && !pinGone ? (
        <div className="flex flex-wrap items-center gap-2">
          {confirmCost === null ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void make(false)}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              TẠO VIDEO{pinnedChoice?.estimatedCost != null ? ` · ${money(pinnedChoice.estimatedCost)}` : ""}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void make(true)}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Xác nhận tạo video ({money(confirmCost)})
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmCost(null)}>
                Huỷ
              </Button>
            </>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setOpen((v) => !v);
            if (!choices) void loadChoices();
          }}
        >
          {pinned && !pinGone ? "ĐỔI MODEL VIDEO" : "CHỌN MODEL VIDEO"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void local(false)}>
          DÙNG LOCAL MOTION · $0
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void local(true)}>
          BỎ QUA VIDEO AI · $0
        </Button>
        {shapeProblem ? (
          <a href="#dinh-dang-video" className="inline-flex h-8 items-center rounded-md border border-ink-600 px-3 text-xs text-ink-100 hover:bg-ink-800">
            ĐỔI ĐỊNH DẠNG VIDEO
          </a>
        ) : null}
      </div>

      {open ? (
        <div className="space-y-1.5">
          {!choices ? (
            <p className="text-ink-500">Đang tải danh sách model...</p>
          ) : usable.length === 0 ? (
            <p className="text-ink-400">Không có model nào chọn được cho cảnh này. Dùng LOCAL MOTION hoặc sửa cảnh (prompt / độ phức tạp / thời lượng).</p>
          ) : (
            usable.map((c) => (
              <div key={`${c.provider}/${c.model}`} className="rounded border border-ink-800 bg-ink-900/40 p-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-ink-100">{c.displayName || c.model}</span>
                  <span className="text-ink-500">{c.provider}/{c.model}</span>
                  <Badge tone={c.notAutoReason ? "warn" : "ok"}>{c.notAutoReason ? c.lifecycle.replace("_", " ") : "AUTO OK"}</Badge>
                  <span className="text-ink-300">{c.estimatedCost !== null ? money(c.estimatedCost) : "—"}</span>
                  <span className="text-ink-500">{c.expectedWait}</span>
                  <Button size="sm" variant="secondary" className="ml-auto" disabled={busy} onClick={() => void choose(c)}>
                    Chọn
                  </Button>
                </div>
                <p className="mt-1 text-ink-400">{c.qualityNote}</p>
                <p className="mt-0.5 text-ink-500">
                  {c.notAutoReason
                    ? `Chưa được phép tự chọn (${c.notAutoReason}), nhưng có thể chạy khi bạn xác nhận giá.`
                    : "Router có thể tự chọn model này."}
                </p>
              </div>
            ))
          )}
          {gone.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-ink-500">Model không khả dụng ({gone.length})</summary>
              <ul className="mt-1 space-y-0.5 text-ink-500">
                {gone.map((c) => (
                  <li key={`${c.provider}/${c.model}`}>
                    {c.provider}/{c.model} ({c.lifecycle}): {c.unavailableReason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {budget ? <BudgetProblemBox problem={budget} projectId={projectId} videoLimit={budget.videoLimit ?? videoLimit} onFixed={() => setBudget(null)} /> : null}
      {message ? <p className={message.ok ? "text-ok-500" : "text-danger-500"}>{message.text}</p> : null}

      {split ? (
        <details>
          <summary className="cursor-pointer text-ink-500">Xem chi tiết kỹ thuật</summary>
          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-ink-500">{split.detail}</p>
        </details>
      ) : null}
    </div>
  );
}
