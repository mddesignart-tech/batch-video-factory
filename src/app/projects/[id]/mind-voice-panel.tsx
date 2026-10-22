"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Field, Select } from "@/components/ui";
import { mindStatusAction, type MindStatus } from "@/app/actions/mind-voice";
import { MIND_AUTO_VOICE, MIND_ENGINES, MIND_OFFLINE_GUIDE, mindVoiceLabel, type MindEngineId } from "@/domain/mind-voice";
import type { OutputControls } from "@/domain/output-controls";

/**
 * GIỌNG THUYẾT MINH → Mind Voice Local (QĐ-145): status, voices and the model
 * state, read from the local service. Nothing is generated here; the video's
 * voice is made by the normal pipeline (Storyboard → Voice Director → engine).
 */
export function MindVoiceDetails({
  voice,
  language,
  onChange,
  disabled,
}: {
  voice: OutputControls["voice"];
  language: string;
  onChange: (patch: Partial<OutputControls["voice"]>) => void;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<MindStatus | null>(null);
  const [checking, start] = useTransition();
  const check = () => start(async () => setStatus(await mindStatusAction()));
  useEffect(() => {
    check();
    // Asked once when Mind Voice is chosen; "Kiểm tra lại" asks again.
  }, []);

  const chosen = status?.voices.find((v) => v.id === voice.voiceId) ?? null;
  const engines: MindEngineId[] = ["vieneu", "supertonic"];

  return (
    <div className="space-y-2 rounded-lg border border-ink-800 bg-ink-850 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={status?.online ? "font-semibold text-ok-500" : "font-semibold text-warn-500"}>{status ? (status.online ? "● Online" : "● Offline") : "Đang kiểm tra…"}</span>
        <span className="text-ink-400">{status?.baseUrl ?? ""}</span>
        <Button size="sm" variant="ghost" disabled={checking} onClick={check}>
          <RefreshCw className="mr-1 h-3 w-3" /> Kiểm tra lại
        </Button>
        <Link href="/mind-voice" className="text-brand-400 underline">
          Mở Mind Voice Studio
        </Link>
      </div>
      {status && !status.online ? <p className="text-warn-500">{status.message || MIND_OFFLINE_GUIDE}</p> : null}
      <p className="text-ink-300">
        Provider: Mind Voice Local · Engine: {chosen ? MIND_ENGINES[chosen.engine].label : "Tự động theo ngôn ngữ (Tiếng Việt → VieNeu, English → Supertonic)"} · Language: {language} · Voice:{" "}
        {chosen ? mindVoiceLabel(chosen) : "Tự động"} · Chi phí: $0
      </p>
      <Field label={`Giọng Mind Voice (${status?.voices.filter((v) => v.installed).length ?? 0} giọng đã cài)`}>
        <Select value={voice.voiceId ?? MIND_AUTO_VOICE} disabled={disabled} onChange={(e) => onChange({ voiceId: e.currentTarget.value === MIND_AUTO_VOICE ? null : e.currentTarget.value })}>
          <option value={MIND_AUTO_VOICE}>Tự động (Tiếng Việt → VieNeu, English → Supertonic)</option>
          {engines.map((engine) => (
            <optgroup key={engine} label={MIND_ENGINES[engine].label}>
              {(status?.voices ?? [])
                .filter((v) => v.engine === engine && v.installed)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {mindVoiceLabel(v)}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <ul className="space-y-0.5 text-ink-400">
        {(status?.health?.engines ?? []).map((e) => (
          <li key={e.id}>
            {e.label} · {e.installed ? `đã cài (${e.variant})` : "chưa cài - mở Mind Voice Studio → Quản lý model"} · giấy phép {e.license}
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-ink-500">
        Chạy tại máy, $0, không ghi sổ chi. Khi Mind Voice tắt, giọng KHÔNG tự chuyển sang nhà cung cấp trả phí. Voice instruction kiểu OpenAI không được gửi; Voice Director
        chỉ thêm thẻ engine hiểu ([cười], [thở dài], &lt;laugh&gt;, &lt;sigh&gt;).
      </p>
    </div>
  );
}
