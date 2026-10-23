"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { Play, Power, RefreshCw } from "lucide-react";
import { Button, Field, Select } from "@/components/ui";
import { mindSpeakAction, mindStartAction, mindStatusAction, type MindStatus } from "@/app/actions/mind-voice";
import { MIND_AUTO_VOICE, MIND_CUES, MIND_ENGINES, MIND_OFFLINE_GUIDE, mindVoiceLabel, type MindEngineId } from "@/domain/mind-voice";
import type { OutputControls } from "@/domain/output-controls";
import { MIND_VOICE_SUGGESTIONS, suggestMindVoices, type MindUseCase } from "@/domain/voice-quality";
import type { StudioTake } from "@/services/mind-voice-studio";

const mediaUrl = (rel: string) => `/api/media/${rel.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
const PREVIEW_TEXT: Record<"vi" | "en", string> = {
  vi: "Xin chào, đây là bản kiểm tra giọng đọc của AIVietLab.",
  en: "Hello, this is a quick voice check.",
};

/**
 * GIỌNG THUYẾT MINH → Mind Voice Local (QĐ-145): status, voices and the model
 * state, read from the local service. Nothing is generated here; the video's
 * voice is made by the normal pipeline (Storyboard → Voice Director → engine).
 */
export function MindVoiceDetails({
  voice,
  language,
  useCase = null,
  onChange,
  disabled,
}: {
  voice: OutputControls["voice"];
  language: string;
  /** QĐ-146: suggestions for this kind of video, from voices a person listened to. */
  useCase?: MindUseCase | null;
  onChange: (patch: Partial<OutputControls["voice"]>) => void;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<MindStatus | null>(null);
  const [checking, start] = useTransition();
  const check = () => start(async () => setStatus(await mindStatusAction()));
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [take, setTake] = useState<StudioTake | null>(null);
  const [acting, act] = useTransition();
  // QĐ-153: the one launcher (voice-engine\start_voice_engine.bat), waits until it answers.
  const startMind = () =>
    act(async () => {
      setNotice({ ok: true, text: "Đang khởi động Mind Voice… (tối đa 60 giây)" });
      const r = await mindStartAction();
      setNotice({ ok: r.ok, text: r.message });
      setStatus(await mindStatusAction());
    });
  // Nghe thử: one short sentence in the chosen voice, local only, $0.
  const listen = () =>
    act(async () => {
      setNotice(null);
      const lang = language.startsWith("en") ? "en" : "vi";
      const r = await mindSpeakAction({
        text: PREVIEW_TEXT[lang],
        language: lang,
        voiceId: voice.voiceId ?? MIND_AUTO_VOICE,
        style: null,
        emotion: null,
        speed: 1,
        pause: "natural",
        preview: false,
        cues: voice.emotionCues,
      });
      setNotice({ ok: r.ok, text: r.message });
      if (r.take) setTake(r.take);
      if (!r.ok) setStatus(await mindStatusAction());
    });
  useEffect(() => {
    check();
    // Asked once when Mind Voice is chosen; "Kiểm tra lại" asks again.
  }, []);

  const chosen = status?.voices.find((v) => v.id === voice.voiceId) ?? null;
  const engines: MindEngineId[] = ["vieneu", "supertonic"];
  const installed = new Set((status?.voices ?? []).filter((v) => v.installed).map((v) => v.id));
  const suggestions = useCase ? suggestMindVoices(useCase) : [];
  const reliable = engines.flatMap((e) => Object.values(MIND_CUES[e]).filter((c) => c?.support === "reliable").map((c) => c!.tag));
  const unreliable = engines.flatMap((e) => Object.values(MIND_CUES[e]).filter((c) => c?.support === "unreliable").map((c) => c!.tag));

  return (
    <div className="space-y-2 rounded-lg border border-ink-800 bg-ink-850 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={status?.ready ? "font-semibold text-ok-500" : "font-semibold text-warn-500"}>
          {status ? (status.ready ? "● Online" : status.online ? "● Online - chưa có model" : "● Offline") : "Đang kiểm tra…"}
        </span>
        <span className="text-ink-400">{status?.baseUrl ?? ""}</span>
        <Button size="sm" variant="ghost" disabled={checking || acting} onClick={check}>
          <RefreshCw className="mr-1 h-3 w-3" /> Kiểm tra lại
        </Button>
        {status && !status.online && status.canStart ? (
          <Button size="sm" variant="secondary" disabled={checking || acting} onClick={startMind}>
            <Power className="mr-1 h-3 w-3" /> Khởi động Mind Voice
          </Button>
        ) : null}
        {status?.ready ? (
          <Button size="sm" variant="secondary" disabled={acting || (voice.voiceId !== null && !installed.has(voice.voiceId))} onClick={listen}>
            <Play className="mr-1 h-3 w-3" /> {acting ? "Đang tạo…" : "Nghe thử"}
          </Button>
        ) : null}
        <Link href="/mind-voice" className="text-brand-400 underline">
          Mở Mind Voice Studio
        </Link>
      </div>
      {status && !status.ready ? <p className="text-warn-500">{status.message || MIND_OFFLINE_GUIDE}</p> : null}
      {status?.ready ? <p className="text-ok-500">{status.message}</p> : null}
      {notice ? <p className={notice.ok ? "text-ink-300" : "text-warn-500"}>{notice.text}</p> : null}
      {take ? <audio key={take.id} controls autoPlay src={mediaUrl(take.file)} className="h-8 w-full" /> : null}
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
      {useCase ? (
        <div className="space-y-1 rounded border border-ink-800 p-2">
          <p className="text-ink-300">
            Gợi ý cho {MIND_VOICE_SUGGESTIONS[useCase].label} <span className="text-ink-500">(từ các mẫu bạn đã nghe và chấm - chỉ là gợi ý, bấm mới đổi)</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => {
              const current = voice.voiceId === s.voiceId;
              return (
                <Button
                  key={s.voiceId}
                  size="sm"
                  variant={current ? "secondary" : "ghost"}
                  disabled={disabled || current || (status !== null && !installed.has(s.voiceId))}
                  title={s.basis}
                  onClick={() => onChange({ voiceId: s.voiceId })}
                >
                  {current ? "✓ " : "Dùng "}
                  {s.voiceId}
                  {s.label ? ` (${s.label})` : ""} · {s.bestScore}/20{s.priority ? " · ưu tiên #1" : ""}{s.candidate ? " · cần thử thêm" : ""}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-ink-300">
        <input type="checkbox" checked={voice.emotionCues} disabled={disabled} onChange={(e) => onChange({ emotionCues: e.currentTarget.checked })} />
        Thẻ cảm xúc ({reliable.join(", ")})
      </label>
      <ul className="space-y-0.5 text-ink-400">
        {(status?.health?.engines ?? []).map((e) => (
          <li key={e.id}>
            {e.label} · {e.installed ? `đã cài (${e.variant})` : "chưa cài - mở Mind Voice Studio → Quản lý model"} · giấy phép {e.license}
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-ink-500">
        Chạy tại máy, $0, không ghi sổ chi. Khi Mind Voice tắt, giọng KHÔNG tự chuyển sang nhà cung cấp trả phí. Voice instruction kiểu OpenAI không được gửi; Voice Director
        chỉ thêm thẻ engine thể hiện ổn định ({reliable.join(", ")}). Không gửi {unreliable.join(", ")}: engine chưa thể hiện đúng - thay bằng nhịp câu.
      </p>
    </div>
  );
}
