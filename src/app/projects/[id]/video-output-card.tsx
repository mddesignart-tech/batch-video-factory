"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2, Play, RefreshCw } from "lucide-react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import {
  clearMusicAction,
  narratorInfoAction,
  previewNarratorAction,
  previewSubtitleAction,
  rerenderAction,
  saveOutputControlsAction,
  uploadMusicAction,
  type NarratorInfo,
} from "@/app/actions/output-controls";
import {
  SUBTITLE_POSITIONS,
  SUBTITLE_SIZES,
  SUBTITLE_STYLES,
  VI_SUBTITLE_POSITION,
  VI_SUBTITLE_SIZE,
  VI_SUBTITLE_STYLE,
  type OutputControls,
} from "@/domain/output-controls";

const media = (p: string) => `/api/media/${p.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * VIDEO OUTPUT: subtitles, voice, music, effects in plain words. Everything
 * except a different voice is applied by RENDER LẠI on this machine - $0, no
 * request of any kind. Technical knobs sit under "Nâng cao".
 */
export function VideoOutputCard({
  projectId,
  initial,
  music,
  frame,
}: {
  projectId: string;
  initial: OutputControls;
  music: { filename: string; durationSec: number | null } | null;
  frame: { width: number; height: number };
}) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [narrator, setNarrator] = useState<NarratorInfo | null>(null);
  const [voiceQuote, setVoiceQuote] = useState<{ cost: number; posts: number; mock: boolean } | null>(null);
  const [audio, setAudio] = useState<string | null>(null);

  useEffect(() => {
    void narratorInfoAction(projectId).then((r) => r.info && setNarrator(r.info));
  }, [projectId]);

  const save = (patch: Parameters<typeof saveOutputControlsAction>[1]) =>
    start(async () => {
      const r = await saveOutputControlsAction(projectId, patch);
      setMsg({ ok: r.ok, text: r.message });
      if (r.voiceChanged) {
        const info = await narratorInfoAction(projectId);
        if (info.info) setNarrator(info.info);
      }
      router.refresh();
    });
  const sub = (p: Partial<OutputControls["subtitles"]>, persist = true) => {
    setC((x) => ({ ...x, subtitles: { ...x.subtitles, ...p } }));
    if (persist) save({ subtitles: p });
  };
  const adv = (p: Partial<OutputControls["subtitles"]["advanced"]>) => {
    setC((x) => ({ ...x, subtitles: { ...x.subtitles, advanced: { ...x.subtitles.advanced, ...p } } }));
    save({ subtitles: { advanced: { ...c.subtitles.advanced, ...p } } });
  };
  const aud = (p: Partial<OutputControls["audio"]>, persist = true) => {
    setC((x) => ({ ...x, audio: { ...x.audio, ...p } }));
    if (persist) save({ audio: p });
  };

  const listenOrQuote = (confirm: boolean) =>
    start(async () => {
      const r = await previewNarratorAction(projectId, confirm && voiceQuote ? { confirmPaid: true, expectedCost: voiceQuote.cost } : {});
      if (r.status === "NEEDS_CONFIRMATION" && r.plan) {
        setVoiceQuote({ cost: r.plan.incrementalCost, posts: r.plan.expectedPosts, mock: r.plan.mockMode });
        setMsg({ ok: true, text: r.message });
        return;
      }
      setVoiceQuote(null);
      setMsg({ ok: r.status === "DONE", text: r.message });
      if (r.audioPath) setAudio(`${media(r.audioPath)}?t=${Date.now()}`);
    });

  const slider = (value: number, min: number, max: number, step: number, onMove: (v: number) => void, onDone: (v: number) => void) => (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      className="w-full accent-brand-500"
      onChange={(e) => onMove(Number(e.currentTarget.value))}
      onPointerUp={(e) => onDone(Number(e.currentTarget.value))}
      onKeyUp={(e) => onDone(Number(e.currentTarget.value))}
    />
  );

  return (
    <Card id="video-output">
      <CardHeader>
        <CardTitle>Video output</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* ------------------------------------------------------- PHỤ ĐỀ */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">Phụ đề</p>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={c.subtitles.enabled} onChange={(e) => sub({ enabled: e.currentTarget.checked })} />
              {c.subtitles.enabled ? "Bật" : "Tắt"}
            </label>
          </div>
          {c.subtitles.enabled ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Kích thước">
                <Select value={c.subtitles.size} onChange={(e) => sub({ size: e.currentTarget.value as OutputControls["subtitles"]["size"] })}>
                  {SUBTITLE_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {VI_SUBTITLE_SIZE[s]}
                    </option>
                  ))}
                </Select>
                {c.subtitles.size === "CUSTOM"
                  ? slider(c.subtitles.customScale, 0.5, 1.8, 0.05, (v) => sub({ customScale: v }, false), (v) => sub({ customScale: v }))
                  : null}
              </Field>
              <Field label="Vị trí">
                <Select value={c.subtitles.position} onChange={(e) => sub({ position: e.currentTarget.value as OutputControls["subtitles"]["position"] })}>
                  {SUBTITLE_POSITIONS.map((s) => (
                    <option key={s} value={s}>
                      {VI_SUBTITLE_POSITION[s]}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-[11px] text-ink-500">Dịch lên / xuống: {c.subtitles.offsetPct > 0 ? "+" : ""}{c.subtitles.offsetPct}%</p>
                {slider(c.subtitles.offsetPct, -20, 20, 1, (v) => sub({ offsetPct: v }, false), (v) => sub({ offsetPct: v }))}
              </Field>
              <Field label="Kiểu">
                <Select value={c.subtitles.style} onChange={(e) => sub({ style: e.currentTarget.value as OutputControls["subtitles"]["style"] })}>
                  {SUBTITLE_STYLES.map((s) => (
                    <option key={s} value={s}>
                      {VI_SUBTITLE_STYLE[s]}
                    </option>
                  ))}
                </Select>
                <label className="mt-1 flex items-center gap-2 text-xs text-ink-300">
                  <input type="checkbox" checked={c.subtitles.autoFit} onChange={(e) => sub({ autoFit: e.currentTarget.checked })} />
                  Tự động vừa khung
                </label>
              </Field>
            </div>
          ) : (
            <p className="text-xs text-ink-500">Video sẽ không có chữ trên hình. Phụ đề vẫn được giữ và vẫn xuất file .srt.</p>
          )}
        </section>

        {/* ------------------------------------------------------- GIỌNG ĐỌC */}
        <section className="space-y-2">
          <p className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">Giọng thuyết minh</p>
          {narrator ? (
            <p className="text-xs text-ink-500">
              {narrator.provider} · {narrator.model} · {narrator.language}
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Giọng">
              <Select
                value={c.voice.voiceId ?? narrator?.voiceId ?? ""}
                onChange={(e) => {
                  const voiceId = e.currentTarget.value;
                  setC((x) => ({ ...x, voice: { ...x.voice, voiceId } }));
                  save({ voice: { voiceId } });
                }}
              >
                {narrator && !narrator.voices.some((v) => v.id === narrator.voiceId) ? <option value={narrator.voiceId}>{narrator.voiceId}</option> : null}
                {(narrator?.voices ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Tốc độ: ${(c.voice.speed ?? narrator?.speed ?? 1).toFixed(2)}x`}>
              {slider(
                c.voice.speed ?? narrator?.speed ?? 1,
                0.5,
                2,
                0.05,
                (v) => setC((x) => ({ ...x, voice: { ...x.voice, speed: v } })),
                (v) => save({ voice: { speed: v } }),
              )}
              <p className="text-[10px] text-ink-500">Đổi giọng/tốc độ = cần tạo giọng mới (xem giá khi Nghe thử).</p>
            </Field>
            <Field label={`Âm lượng lời đọc: ${pct(c.audio.narrationVolume)}`}>
              {slider(c.audio.narrationVolume, 0, 2, 0.05, (v) => aud({ narrationVolume: v }, false), (v) => aud({ narrationVolume: v }))}
              <label className="flex items-center gap-2 text-xs text-ink-300">
                <input type="checkbox" checked={c.audio.normalizeNarration} onChange={(e) => aud({ normalizeNarration: e.currentTarget.checked })} />
                Chuẩn hoá âm lượng lời đọc
              </label>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {voiceQuote ? (
              <>
                <span className="text-xs text-warn-500">
                  Cần tạo {voiceQuote.posts} câu giọng mới · ~${voiceQuote.cost.toFixed(4)}
                  {voiceQuote.mock ? " (giá giả lập)" : ""}
                </span>
                <Button size="sm" variant="primary" disabled={pending} onClick={() => listenOrQuote(true)}>
                  Xác nhận & nghe thử
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setVoiceQuote(null)}>
                  Huỷ
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" disabled={pending || !narrator?.sceneId} onClick={() => listenOrQuote(false)}>
                <Play className="h-3 w-3" /> Nghe thử
              </Button>
            )}
            {audio ? <audio src={audio} controls autoPlay className="h-8" /> : null}
          </div>
        </section>

        {/* ------------------------------------------------------- NHẠC NỀN */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">Nhạc nền</p>
            {music ? (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={c.audio.musicEnabled} onChange={(e) => aud({ musicEnabled: e.currentTarget.checked })} />
                {c.audio.musicEnabled ? "Bật" : "Tắt"}
              </label>
            ) : null}
          </div>
          {music ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label={`Âm lượng: ${pct(c.audio.musicVolume)}`}>
                {slider(c.audio.musicVolume, 0, 1, 0.01, (v) => aud({ musicVolume: v }, false), (v) => aud({ musicVolume: v }))}
              </Field>
              <div className="space-y-1 text-xs text-ink-300">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={c.audio.duckMusic} onChange={(e) => aud({ duckMusic: e.currentTarget.checked })} />
                  Tự hạ nhạc khi có lời
                </label>
                <p className="text-ink-500">
                  {music.filename}
                  {music.durationSec ? ` · ${Math.round(music.durationSec)}s` : ""}{" "}
                  <button type="button" className="text-accent-500 underline" onClick={() => start(async () => { const r = await clearMusicAction(projectId); setMsg({ ok: r.ok, text: r.message }); router.refresh(); })}>
                    Bỏ nhạc
                  </button>
                </p>
              </div>
            </div>
          ) : (
            <label className="block text-xs text-ink-400">
              Chưa có nhạc nền.{" "}
              <span className="cursor-pointer text-accent-500 underline">
                Tải nhạc lên (MP3/WAV/M4A)
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    if (!f) return;
                    const data = new FormData();
                    data.append("music", f);
                    start(async () => {
                      const r = await uploadMusicAction(projectId, data);
                      setMsg({ ok: r.ok, text: r.message });
                      router.refresh();
                    });
                  }}
                />
              </span>
            </label>
          )}
        </section>

        {/* ---------------------------------------------- HIỆU ỨNG ÂM THANH */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">Hiệu ứng âm thanh</p>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={c.audio.sfxEnabled} onChange={(e) => aud({ sfxEnabled: e.currentTarget.checked })} />
              {c.audio.sfxEnabled ? "Bật" : "Tắt"}
            </label>
          </div>
          {c.audio.sfxEnabled ? (
            <Field label={`Âm lượng: ${pct(c.audio.sfxVolume)}`}>
              {slider(c.audio.sfxVolume, 0, 1, 0.01, (v) => aud({ sfxVolume: v }, false), (v) => aud({ sfxVolume: v }))}
            </Field>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input type="checkbox" checked={c.audio.fades} onChange={(e) => aud({ fades: e.currentTarget.checked })} />
            Mở / kết âm thanh nhẹ nhàng (fade)
          </label>
        </section>

        <details className="rounded-lg border border-ink-800 px-3 py-2">
          <summary className="cursor-pointer text-xs text-ink-400">Nâng cao (không bắt buộc)</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <Field label="Font">
              <Input defaultValue={c.subtitles.advanced.font ?? "Arial"} onBlur={(e) => adv({ font: e.currentTarget.value || undefined })} />
            </Field>
            <Field label="Màu chữ">
              <Input type="color" defaultValue={c.subtitles.advanced.color ?? "#ffffff"} onBlur={(e) => adv({ color: e.currentTarget.value })} />
            </Field>
            <Field label="Số dòng tối đa">
              <Select value={c.subtitles.maxLines} onChange={(e) => sub({ maxLines: Number(e.currentTarget.value) })}>
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Độ dày viền: ×${(c.subtitles.advanced.outlineScale ?? 1).toFixed(1)}`}>
              {slider(c.subtitles.advanced.outlineScale ?? 1, 0, 3, 0.1, () => undefined, (v) => adv({ outlineScale: v }))}
            </Field>
            <Field label={`Độ đậm nền: ${pct(c.subtitles.advanced.backgroundOpacity ?? 0.55)}`}>
              {slider(c.subtitles.advanced.backgroundOpacity ?? 0.55, 0, 1, 0.05, () => undefined, (v) => adv({ backgroundOpacity: v }))}
            </Field>
            <Field label={`Độ rộng tối đa: ${c.subtitles.advanced.maxWidthPct ?? "tự động"}${c.subtitles.advanced.maxWidthPct ? "%" : ""}`}>
              {slider(c.subtitles.advanced.maxWidthPct ?? 80, 40, 95, 1, () => undefined, (v) => adv({ maxWidthPct: v }))}
            </Field>
            <label className="flex items-center gap-2 text-xs text-ink-300">
              <input type="checkbox" checked={c.subtitles.advanced.bold ?? c.subtitles.style !== "MINIMAL"} onChange={(e) => adv({ bold: e.currentTarget.checked })} /> Chữ đậm
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-300">
              <input type="checkbox" checked={c.subtitles.advanced.shadow ?? c.subtitles.style !== "MINIMAL"} onChange={(e) => adv({ shadow: e.currentTarget.checked })} /> Bóng chữ
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-300">
              <input type="checkbox" checked={c.subtitles.advanced.showSafeArea ?? false} onChange={(e) => adv({ showSafeArea: e.currentTarget.checked })} /> Hiện vùng an toàn khi xem trước
            </label>
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await previewSubtitleAction(projectId);
                if (r.ok && r.path) setPreview(`${media(r.path)}?t=${Date.now()}`);
                else setMsg({ ok: false, text: r.message });
              })
            }
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />} XEM TRƯỚC
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await rerenderAction(projectId);
                setMsg({ ok: r.ok, text: r.message });
                router.refresh();
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" /> RENDER LẠI
          </Button>
          <span className="text-xs text-ink-500">Phụ đề, âm lượng, nhạc, hiệu ứng: chỉ xử lý tại máy, $0.</span>
        </div>
        {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}
        {preview ? (
          <img
            src={preview}
            alt="Xem trước khung hình"
            className="max-h-[480px] rounded border border-ink-700"
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
