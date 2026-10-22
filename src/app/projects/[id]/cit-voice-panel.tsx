"use client";

import { useEffect, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Field, Select } from "@/components/ui";
import { citStatusAction } from "@/app/actions/output-controls";
import type { CitStatusView } from "@/services/cit-catalog";
import { CIT_AUTO_VOICE, CIT_MODEL, CIT_OFFLINE_GUIDE, CIT_PROVIDER } from "@/domain/cit";
import type { OutputControls } from "@/domain/output-controls";
import { MIND_LABEL, MIND_MODEL, MIND_PROVIDER } from "@/domain/mind-voice";
import type { MindUseCase } from "@/domain/voice-quality";
import { MindVoiceDetails } from "./mind-voice-panel";

/**
 * GIỌNG THUYẾT MINH → Nhà cung cấp. Tự động leaves the narrator as it was;
 * OpenAI pins the paid TTS; Mind Voice Local (QĐ-145) and CIT - Legacy (QĐ-144)
 * pin a local, $0 voice. An offline local service is shown with what to do -
 * nothing falls back to a paid voice.
 */
const OPENAI = { provider: "openai", model: "gpt-4o-mini-tts" } as const;
export function CitVoicePanel({
  voice,
  language,
  useCase = null,
  onChange,
  disabled,
}: {
  voice: OutputControls["voice"];
  language: string;
  /** QĐ-146: the project's kind of video, for Mind Voice suggestions. */
  useCase?: MindUseCase | null;
  onChange: (patch: Partial<OutputControls["voice"]>) => void;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<CitStatusView | null>(null);
  const [checking, start] = useTransition();
  const usingCit = voice.provider === CIT_PROVIDER;

  const check = () =>
    start(async () => {
      const r = await citStatusAction();
      if (r.status) setStatus(r.status);
    });
  useEffect(() => {
    // Asked once each time CIT is chosen; "Kiểm tra lại" asks again.
    if (usingCit) check();
  }, [usingCit]);

  const chosen = status?.voices.find((v) => v.id === voice.voiceId) ?? null;
  const engines = [...new Set((status?.voices ?? []).map((v) => v.engineLabel))];

  return (
    <div className="space-y-2">
      <Field label="Nhà cung cấp giọng">
        <Select
          value={voice.provider === CIT_PROVIDER || voice.provider === MIND_PROVIDER || voice.provider === OPENAI.provider ? voice.provider : ""}
          disabled={disabled}
          onChange={(e) => {
            const v = e.currentTarget.value;
            onChange(
              v === CIT_PROVIDER
                ? { provider: CIT_PROVIDER, model: CIT_MODEL, voiceId: null }
                : v === MIND_PROVIDER
                  ? { provider: MIND_PROVIDER, model: MIND_MODEL, voiceId: null }
                  : v === OPENAI.provider
                    ? { provider: OPENAI.provider, model: OPENAI.model, voiceId: null }
                    : { provider: null, model: null, voiceId: null },
            );
          }}
        >
          <option value="">Tự động (giọng của Người dẫn chuyện)</option>
          <option value={OPENAI.provider}>OpenAI TTS (trả phí)</option>
          <option value={MIND_PROVIDER}>{MIND_LABEL}</option>
          <option value={CIT_PROVIDER}>CIT Local — Legacy ($0)</option>
        </Select>
      </Field>
      {voice.provider === MIND_PROVIDER ? <MindVoiceDetails voice={voice} language={language} useCase={useCase} onChange={onChange} disabled={disabled} /> : null}
      {usingCit ? (
        <div className="space-y-2 rounded-lg border border-ink-800 bg-ink-850 p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className={status?.online ? "font-semibold text-ok-500" : "font-semibold text-warn-500"}>
              {status ? (status.online ? "● Online" : "● Offline") : "Đang kiểm tra…"}
            </span>
            <span className="text-ink-400">{status?.baseUrl ?? ""}</span>
            {status?.version ? <span className="text-ink-500">v{status.version}</span> : null}
            <Button size="sm" variant="ghost" disabled={checking} onClick={check}>
              <RefreshCw className="mr-1 h-3 w-3" /> Kiểm tra lại
            </Button>
          </div>
          {status && !status.online ? <p className="text-warn-500">{status.message || CIT_OFFLINE_GUIDE}</p> : null}
          <p className="text-ink-300">
            Provider: CIT Local · Engine: {chosen ? chosen.engineLabel : `Tự động theo ngôn ngữ (${engines.join(" / ") || "VieNeu / Supertonic"})`} · Language: {language} · Voice:{" "}
            {chosen?.label ?? "Tự động"} · Chi phí: $0
          </p>
          <Field label={`Giọng CIT (${status?.voiceCount ?? 0} giọng)`}>
            <Select value={voice.voiceId ?? CIT_AUTO_VOICE} disabled={disabled} onChange={(e) => onChange({ voiceId: e.currentTarget.value === CIT_AUTO_VOICE ? null : e.currentTarget.value })}>
              <option value={CIT_AUTO_VOICE}>Tự động (Tiếng Việt → VieNeu, English → Supertonic)</option>
              {engines.map((engine) => (
                <optgroup key={engine} label={engine}>
                  {(status?.voices ?? [])
                    .filter((v) => v.engineLabel === engine)
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                        {v.gender ? ` · ${v.gender}` : ""}
                        {v.languages.length ? ` · ${v.languages.join(", ")}` : ""}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          {status?.engines.length ? (
            <ul className="space-y-0.5 text-ink-400">
              {status.engines.map((e) => (
                <li key={e.name}>
                  {e.label} ({e.name}) · {e.installed === false ? "chưa tải - mở CIT → Cài đặt → Mô hình" : e.installed ? "sẵn sàng" : "không rõ"}
                  {e.license ? ` · giấy phép ${e.license}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {status?.languages.length ? <p className="text-ink-500">Ngôn ngữ CIT báo hỗ trợ: {status.languages.join(", ")}</p> : null}
          <p className="text-ink-500">{status?.pronunciation ?? ""}</p>
          <p className="text-[10px] text-ink-500">
            Chạy tại máy, $0, không ghi sổ chi. Khi CIT tắt, giọng sẽ KHÔNG tự chuyển sang nhà cung cấp trả phí. Voice instruction kiểu OpenAI không được gửi cho CIT;
            Voice Director chỉ thêm ít tag engine hỗ trợ ([cười], [thở dài]…); ngắt nghỉ bằng xuống dòng, không dùng thẻ [nghỉ].
          </p>
        </div>
      ) : null}
    </div>
  );
}
