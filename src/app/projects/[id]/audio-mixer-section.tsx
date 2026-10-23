"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Headphones, RotateCcw, Save, Trash2, Wand2 } from "lucide-react";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import {
  applyAudioPresetAction,
  audioPresetsAction,
  audioPreviewAction,
  deleteAudioPresetAction,
  remixAudioAction,
  remixAvailabilityAction,
  saveAudioPresetAction,
} from "@/app/actions/audio-mixer";
import {
  AudioMixerSchema,
  DEFAULT_AUDIO_PRESET_ID,
  PREVIEW_KINDS,
  VI_PREVIEW_KIND,
  type AudioMixer,
  type AudioPreset,
  type PreviewKind,
} from "@/domain/audio-mixer";
import type { OutputControls } from "@/domain/output-controls";

const media = (p: string) => `/api/media/${p.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

type Audio = OutputControls["audio"];

/**
 * AUDIO MIXER (QĐ-150) inside VIDEO OUTPUT. Everything here is mixed on this
 * machine: changing a level, previewing and REMIX AUDIO never create new
 * voice, pictures or video, and cost $0 in API.
 */
export function AudioMixerSection({
  projectId,
  audio,
  hasMusic,
  pending,
  change,
}: {
  projectId: string;
  audio: Audio;
  hasMusic: boolean;
  pending: boolean;
  /** Same contract as the card's `aud`: persist=false only updates the screen. */
  change: (patch: Partial<Audio>, persist?: boolean) => void;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [presets, setPresets] = useState<AudioPreset[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [remix, setRemix] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);

  const reload = () => void audioPresetsAction().then((r) => setPresets(r.presets));
  useEffect(reload, []);
  useEffect(() => {
    void remixAvailabilityAction(projectId).then(setRemix);
  }, [projectId, audio.mixer]);

  const m = audio.mixer;
  const selected = presets.find((p) => p.id === m?.presetId) ?? null;
  const disabled = pending || busy;

  const applyPreset = (id: string) =>
    start(async () => {
      const r = await applyAudioPresetAction(projectId, id);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok && r.controls) change(r.controls.audio, false);
      router.refresh();
    });

  /** Any knob change: the values stop being "the preset" (they were copied, not linked). */
  const mix = (p: Partial<AudioMixer>, persist = true) => {
    if (!m) return;
    const next = AudioMixerSchema.parse({ ...m, ...p, presetId: p.presetId === undefined ? null : p.presetId });
    change({ mixer: next }, persist);
  };

  const listen = (kind: PreviewKind) =>
    start(async () => {
      const r = await audioPreviewAction(projectId, kind, audio);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok && r.path) setPreviewSrc(`${media(r.path)}?t=${Date.now()}`);
    });

  const numberBox = (value: number, min: number, max: number, step: number, onDone: (v: number) => void, unit: string) => (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        key={value}
        defaultValue={value}
        className="w-20"
        onBlur={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v)) onDone(Math.min(max, Math.max(min, v)));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <span className="text-[11px] text-ink-500">{unit}</span>
    </div>
  );

  const range = (value: number, min: number, max: number, step: number, onMove: (v: number) => void, onDone: (v: number) => void) => (
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

  if (!m) {
    return (
      <div className="space-y-2 rounded-lg border border-warn-500/40 bg-ink-850 p-2 text-xs">
        <p className="text-ink-300">
          Video này đang dùng <b>bộ trộn cũ</b> (nhạc có thể bị giật ở chỗ chuyển cảnh, xem QĐ-149). Bật <b>Audio Mixer</b> để nhạc chạy liền, hạ nhẹ khi có lời
          và chỉnh được sau khi xuất. Video cũ không tự đổi.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select defaultValue={DEFAULT_AUDIO_PRESET_ID} id="mixer-enable-preset" className="w-56" disabled={disabled}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="primary"
            disabled={disabled || presets.length === 0}
            onClick={() => applyPreset((document.getElementById("mixer-enable-preset") as HTMLSelectElement | null)?.value ?? DEFAULT_AUDIO_PRESET_ID)}
          >
            <Wand2 className="h-3 w-3" /> Bật Audio Mixer
          </Button>
        </div>
        {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-ink-800 p-3 text-xs">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Audio preset">
          <Select value={m.presetId ?? ""} className="w-56" disabled={disabled} onChange={(e) => e.currentTarget.value && applyPreset(e.currentTarget.value)}>
            {m.presetId === null ? <option value="">Tuỳ chỉnh (chưa lưu)</option> : null}
            <optgroup label="Hệ thống">
              {presets.filter((p) => p.system).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {presets.some((p) => !p.system) ? (
              <optgroup label="Của tôi">
                {presets.filter((p) => !p.system).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        </Field>
        {selected && !selected.system ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              start(async () => {
                const r = await deleteAudioPresetAction(selected.id);
                setMsg({ ok: r.ok, text: r.message });
                if (r.ok) mix({ presetId: null });
                reload();
              })
            }
          >
            <Trash2 className="h-3 w-3" /> Xoá preset này
          </Button>
        ) : null}
      </div>
      {selected ? <p className="text-[11px] text-ink-500">{selected.description}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Âm lượng nhạc nền: ${pct(m.musicPct)}`}>
          {range(m.musicPct, 0, 2, 0.01, (v) => mix({ musicPct: v }, false), (v) => mix({ musicPct: v }))}
          <div className="flex items-center gap-2">
            {numberBox(Math.round(m.musicPct * 100), 0, 200, 1, (v) => mix({ musicPct: v / 100 }), "%")}
            <Button size="sm" variant="ghost" disabled={disabled || m.musicPct === 1} onClick={() => mix({ musicPct: 1 })}>
              Về 100%
            </Button>
          </div>
          <p className="text-[10px] text-ink-500">100% = mức nhạc đã nghe duyệt (bài nào cũng được đo và đưa về cùng độ to). 200% = +6 dB.</p>
          {!hasMusic ? <p className="text-[10px] text-warn-500">Chưa có nhạc nền - tải nhạc lên ở trên.</p> : null}
        </Field>
        <Field label={`Âm lượng giọng đọc: ${pct(audio.narrationVolume)}`}>
          {range(audio.narrationVolume, 0, 2, 0.01, (v) => change({ narrationVolume: v }, false), (v) => change({ narrationVolume: v }))}
          <div className="flex items-center gap-2">
            {numberBox(Math.round(audio.narrationVolume * 100), 0, 200, 1, (v) => change({ narrationVolume: v / 100 }), "%")}
            <Button size="sm" variant="ghost" disabled={disabled || audio.narrationVolume === 1} onClick={() => change({ narrationVolume: 1 })}>
              Về 100%
            </Button>
          </div>
          <p className="text-[10px] text-ink-500">Chỉ đổi độ to file giọng đã có: không tạo giọng mới, không đổi tốc độ / cao độ / thời điểm.</p>
        </Field>
      </div>

      <div className="space-y-2 rounded border border-ink-800 p-2">
        <label className="flex items-center gap-2 text-ink-300">
          <input type="checkbox" checked={audio.duckMusic} disabled={disabled} onChange={(e) => change({ duckMusic: e.currentTarget.checked, mixer: { ...m, presetId: null } })} />
          Tự động giảm nhạc khi có lời thoại (Auto Ducking)
        </label>
        {audio.duckMusic ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={`Mức giảm: -${m.duckDb} dB`}>
              {range(m.duckDb, 0, 24, 0.5, (v) => mix({ duckDb: v }, false), (v) => mix({ duckDb: v }))}
            </Field>
            <Field label="Attack (giảm trước câu)">{numberBox(m.attackMs, 20, 1000, 10, (v) => mix({ attackMs: v }), "ms")}</Field>
            <Field label="Release (hồi sau câu)">{numberBox(m.releaseMs, 50, 3000, 50, (v) => mix({ releaseMs: v }), "ms")}</Field>
            <p className="text-[10px] text-ink-500 sm:col-span-3">
              Vùng giảm lấy từ timeline lời thoại. Khoảng nghỉ ngắn hơn Attack + Release ({((m.attackMs + m.releaseMs) / 1000).toFixed(2)} s) giữ nhạc ở mức đã giảm,
              nên nhạc không bật lên rồi tụt xuống ở chỗ chuyển cảnh.
            </p>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fade in nhạc">{numberBox(m.fadeInSec, 0, 10, 0.1, (v) => mix({ fadeInSec: v }), "s")}</Field>
        <Field label="Fade out nhạc">{numberBox(m.fadeOutSec, 0, 10, 0.1, (v) => mix({ fadeOutSec: v }), "s")}</Field>
        <p className="text-[10px] text-ink-500 sm:col-span-2">Chỉ ở đầu và cuối video, chỉ cho nhạc; không fade lại ở mỗi cảnh, giọng không bị fade.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-400">
          <Headphones className="inline h-3 w-3" /> Nghe thử:
        </span>
        {PREVIEW_KINDS.map((k) => (
          <Button key={k} size="sm" variant="outline" disabled={disabled} onClick={() => listen(k)}>
            {VI_PREVIEW_KIND[k]}
          </Button>
        ))}
        {previewSrc ? <audio src={previewSrc} controls autoPlay className="h-8" /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {saveName === null ? (
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => setSaveName(selected && !selected.system ? selected.name : "")}>
            <Save className="h-3 w-3" /> Lưu preset
          </Button>
        ) : (
          <>
            <Input autoFocus placeholder="Tên preset" className="w-48" value={saveName} onChange={(e) => setSaveName(e.currentTarget.value)} />
            {selected && !selected.system ? (
              <Button size="sm" variant="outline" disabled={disabled || !saveName.trim()} onClick={() => savePreset(selected.id)}>
                Ghi đè "{selected.name}"
              </Button>
            ) : null}
            <Button size="sm" variant="primary" disabled={disabled || !saveName.trim()} onClick={() => savePreset(null)}>
              Lưu thành preset mới
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSaveName(null)}>
              Huỷ
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => applyPreset(selected?.id ?? DEFAULT_AUDIO_PRESET_ID)}>
          <RotateCcw className="h-3 w-3" /> Khôi phục mặc định{selected ? ` (${selected.name})` : ""}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => change({ mixer: null })}>
          Tắt Audio Mixer
        </Button>
      </div>

      <div className="space-y-1 rounded border border-ink-800 bg-ink-850 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={disabled || !remix?.ok}
            onClick={() =>
              start(async () => {
                const r = await remixAudioAction(projectId);
                setMsg({ ok: r.ok, text: r.message });
                router.refresh();
              })
            }
          >
            <Wand2 className="h-3 w-3" /> REMIX AUDIO · $0 API
          </Button>
          <span className="text-ink-500">Áp thiết lập trên vào video đã xuất: chỉ trộn lại âm thanh tại máy, giữ nguyên hình, xuất file video mới.</span>
        </div>
        {remix && !remix.ok ? <p className="text-[11px] text-warn-500">{remix.message}</p> : null}
        <p className="text-[10px] text-ink-500">
          Chi phí: chỉnh âm lượng, nghe thử, Remix Audio và nghe lại file đã có đều xử lý tại máy ($0 API). Chỉ tạo GIỌNG MỚI (đổi giọng/tốc độ) mới có thể tốn phí và luôn hỏi trước.
        </p>
      </div>
      {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}
    </div>
  );

  function savePreset(id: string | null) {
    if (!m || saveName === null) return;
    start(async () => {
      const { presetId: _presetId, ...rest } = m;
      const r = await saveAudioPresetAction({
        id,
        name: saveName.trim(),
        values: { ...rest, voicePct: audio.narrationVolume, duck: audio.duckMusic, sfxPct: audio.sfxVolume },
      });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok && r.id) {
        setSaveName(null);
        reload();
        mix({ presetId: r.id });
      }
    });
  }
}
