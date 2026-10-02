"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mic, Play } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { getSceneVoicePlan, makeSceneVoiceAction } from "@/app/actions/projects";
import type { SceneVoiceLinePlan, SceneVoicePlan } from "@/services/generation";

/**
 * Voice of ONE scene, line by line (QĐ-117).
 *
 * "NGHE THỬ GIỌNG" makes the scene's real voice - saved as its Asset - so the
 * later DUYỆT & CHẠY / TIẾP TỤC / render reuse it at $0. Lines that would cost
 * money are shown with their price and need a second, explicit click.
 */

const STATE_LABEL: Record<SceneVoiceLinePlan["state"], { text: string; tone: "ok" | "info" | "warn" | "danger" | "neutral" }> = {
  DONE: { text: "ĐÃ TẠO", tone: "ok" },
  REUSE: { text: "REUSE", tone: "info" },
  WILL_CREATE: { text: "CHƯA CÓ / CẦN TẠO", tone: "warn" },
  MISSING_LOCAL_FILE: { text: "MISSING", tone: "danger" },
  INVALID: { text: "INVALID", tone: "danger" },
  NEEDS_RECOVERY: { text: "CẦN KIỂM TRA", tone: "danger" },
  BLOCKED: { text: "BỊ CHẶN", tone: "danger" },
};

export function SceneVoicePanel({ sceneId, dialogueKey }: { sceneId: string; dialogueKey: string }) {
  const router = useRouter();
  const [plan, setPlan] = useState<SceneVoicePlan | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmCost, setConfirmCost] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // A second click while the first is in flight never reaches the server.
  const inFlight = useRef(false);
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await getSceneVoicePlan(sceneId);
    if (r.ok && r.plan) setPlan(r.plan);
    else setMessage({ ok: false, text: r.message });
  }, [sceneId]);

  useEffect(() => {
    setPlan(null);
    setMessage(null);
    setConfirmCost(null);
    setPlaying(null);
    void load();
  }, [load, dialogueKey]);

  async function make(confirm: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const r = await makeSceneVoiceAction(sceneId, confirm ? { confirmPaid: true, expectedCost: confirmCost ?? undefined } : {});
      if (r.plan) setPlan(r.plan);
      if (r.status === "NEEDS_CONFIRMATION") {
        setConfirmCost(r.plan?.incrementalCost ?? 0);
        setMessage({ ok: true, text: r.message });
        return;
      }
      setConfirmCost(null);
      setMessage({ ok: r.status === "DONE", text: r.message });
      if (r.status === "DONE") {
        const first = r.plan?.lines.find((l) => l.audioPath);
        if (first?.audioPath) setPlaying(first.audioPath);
        router.refresh();
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const money = (n: number) => `$${n.toFixed(6)}`;
  const lines = plan?.lines ?? [];

  return (
    <div className="mb-3 rounded-lg border border-ink-800 bg-ink-850 p-3 text-[11px]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-semibold text-ink-200">
          <Mic className="h-3 w-3" /> VOICE
        </span>
        {plan ? (
          <span className="text-ink-400">
            Chạy lại: {plan.expectedPosts === 0 ? "$0 (REUSE)" : `${plan.expectedPosts} TTS POST · ${money(plan.incrementalCost)}`}
            {plan.mockMode ? " · Mock" : ""}
          </span>
        ) : null}
      </div>

      {!plan ? (
        <p className="text-ink-500">Đang đọc trạng thái giọng...</p>
      ) : lines.length === 0 ? (
        <p className="text-ink-500">Cảnh không có lời thoại / lời dẫn.</p>
      ) : (
        <ul className="space-y-1.5">
          {lines.map((l) => {
            const label = STATE_LABEL[l.state];
            return (
              <li key={l.lineNumber} className="rounded border border-ink-800 p-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={label.tone}>{label.text}</Badge>
                  <span className="text-ink-300">
                    {l.lineNumber}. {l.speaker}
                  </span>
                  <span className="text-ink-500">
                    {l.provider ? `${l.provider}/${l.model}` : "router"} · {l.voiceId}
                  </span>
                  {l.durationSec ? <span className="text-ink-500">{l.durationSec.toFixed(2)}s</span> : null}
                  <span className="text-ink-500">
                    đã trả {money(l.paidCost)} · chạy lại {money(l.incrementalCost)}
                  </span>
                  {l.audioPath ? (
                    <button
                      type="button"
                      className="ml-auto inline-flex items-center gap-1 text-brand-400 hover:text-brand-300"
                      onClick={() => setPlaying(l.audioPath)}
                    >
                      <Play className="h-3 w-3" /> Nghe
                    </button>
                  ) : null}
                </div>
                <p className="mt-1 text-ink-400">&ldquo;{l.text}&rdquo;</p>
                {l.message ? <p className="mt-1 text-warn-500">{l.message}</p> : null}
              </li>
            );
          })}
        </ul>
      )}

      {playing ? (
        <audio key={playing} src={`/api/media/${playing.split(/[\\/]/).join("/")}`} controls autoPlay className="mt-2 w-full" />
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {confirmCost === null ? (
          <Button size="sm" variant="outline" disabled={busy || !plan || lines.length === 0} onClick={() => void make(false)}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            NGHE THỬ GIỌNG
          </Button>
        ) : (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void make(true)}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Xác nhận tạo giọng ({money(confirmCost)}{plan?.mockMode ? " giả lập" : ""})
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmCost(null)}>
              Huỷ
            </Button>
          </>
        )}
      </div>
      {message ? <p className={`mt-2 ${message.ok ? "text-ok-500" : "text-danger-500"}`}>{message.text}</p> : null}
    </div>
  );
}
