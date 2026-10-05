"use client";

import { useMemo, useState } from "react";
import { Field, Select } from "@/components/ui";
import { TONES } from "@/domain/content-options";
import { CAMERA_PRESETS, effectiveCameraPreset, PRESET_MOTION, type CameraPresetId } from "@/domain/camera-director";
import {
  COMEDY_LEVELS,
  COMEDY_STYLES,
  CREATIVE_PRESETS,
  EMOTION_STYLES,
  ENERGY_LABELS,
  PACING_STYLES,
  PUNCHLINE_MODES,
  resolveCreativeStyle,
  type CreativePresetId,
  type StoredCreativeStyle,
  type TemplateCreative,
} from "@/domain/creative-style";

/**
 * PHONG CÁCH SÁNG TẠO (QĐ-127) - one picker for every content template.
 *
 * Simple Mode shows the preset and the fields the template marks as simple
 * (usually: mức độ hài, nhịp, cảm xúc, punchline). Kiểu hài, năng lượng and the
 * exact tone sit under "Nâng cao". Choosing a preset fills every field; changing
 * a field afterwards keeps the preset and records only that change.
 *
 * The choice travels as one hidden JSON field (`name`), parsed and validated on
 * the server (CreativeStyleSchema). "Tự động" with nothing changed sends an
 * empty style, which the server stores as NULL (template defaults).
 */
export function CreativeStylePicker({
  creative,
  initial,
  name = "creativeStyle",
  onChange,
}: {
  creative: TemplateCreative;
  initial?: StoredCreativeStyle | null;
  name?: string;
  onChange?: (stored: Partial<StoredCreativeStyle>) => void;
}) {
  const [stored, setStored] = useState<Partial<StoredCreativeStyle>>(initial ?? { preset: "AUTO" });
  const effective = useMemo(
    () => resolveCreativeStyle(creative, { version: "creative-v1", preset: "AUTO", ...stored } as StoredCreativeStyle),
    [creative, stored],
  );
  const update = (next: Partial<StoredCreativeStyle>) => {
    setStored(next);
    onChange?.(next);
  };
  const setField = <K extends keyof StoredCreativeStyle>(key: K, value: StoredCreativeStyle[K]) => update({ ...stored, [key]: value });
  const show = (field: string) => (creative.simpleFields as readonly string[]).includes(field);
  const maxComedy = creative.maxComedy ?? 5;

  const presetSelect = (
    <Field label="Phong cách video">
      <Select value={stored.preset ?? "AUTO"} onChange={(e) => update({ preset: e.currentTarget.value as CreativePresetId })}>
        {CREATIVE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  const comedy = (
    <Field label="Mức độ hài">
      <Select value={effective.comedyLevel} onChange={(e) => setField("comedyLevel", Number(e.currentTarget.value))}>
        {COMEDY_LEVELS.filter((c) => c.level <= maxComedy).map((c) => (
          <option key={c.level} value={c.level}>
            {c.level} — {c.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  const pacing = (
    <Field label="Nhịp">
      <Select value={stored.pacingStyle ?? "AUTO"} onChange={(e) => setField("pacingStyle", e.currentTarget.value as StoredCreativeStyle["pacingStyle"])}>
        {PACING_STYLES.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === "AUTO" ? `Tự động (${PACING_STYLES.find((x) => x.id === effective.pacingStyle)?.label ?? ""})` : p.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  const emotion = (
    <Field label="Cảm xúc">
      <Select value={stored.emotionStyle ?? "AUTO"} onChange={(e) => setField("emotionStyle", e.currentTarget.value as StoredCreativeStyle["emotionStyle"])}>
        {EMOTION_STYLES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id === "AUTO" && effective.emotionStyle !== "AUTO"
              ? `Tự động (${EMOTION_STYLES.find((x) => x.id === effective.emotionStyle)?.label ?? ""})`
              : m.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  const punchline = (
    <Field label="Punchline">
      <Select value={stored.punchlineMode ?? effective.punchlineMode} onChange={(e) => setField("punchlineMode", e.currentTarget.value as StoredCreativeStyle["punchlineMode"])}>
        {PUNCHLINE_MODES.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  // QĐ-128: one CAMERA choice for normal people; shot / angle / movement are per scene, under Nâng cao.
  const autoCamera = effectiveCameraPreset({
    cameraPreset: "AUTO",
    comedyLevel: effective.comedyLevel,
    tone: effective.tone,
    creativePreset: effective.preset,
    contentType: null,
    emotion: effective.emotionStyle,
    pacing: effective.pacingStyle,
  });
  const camera = (
    <Field label="Camera">
      <Select value={stored.cameraPreset ?? "AUTO"} onChange={(e) => setField("cameraPreset", e.currentTarget.value as CameraPresetId)}>
        {CAMERA_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === "AUTO" ? `Tự động (${CAMERA_PRESETS.find((x) => x.id === autoCamera)?.label ?? ""})` : p.label}
          </option>
        ))}
      </Select>
      <p className="mt-1 text-[11px] text-ink-500">{presetHint(stored.cameraPreset && stored.cameraPreset !== "AUTO" ? stored.cameraPreset : autoCamera)}</p>
    </Field>
  );
  const tone = (
    <Field label="Giọng điệu (tone)">
      <Select value={effective.tone} onChange={(e) => setField("tone", e.currentTarget.value)}>
        {TONES.filter((t) => t.id !== "AUTO").map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  const energy = (
    <Field label={`Năng lượng: ${effective.energyLevel}/5 · ${ENERGY_LABELS[effective.energyLevel] ?? ""}`}>
      <input
        type="range"
        min={1}
        max={5}
        step={1}
        value={effective.energyLevel}
        className="w-full accent-brand-500"
        onChange={(e) => setField("energyLevel", Number(e.currentTarget.value))}
      />
    </Field>
  );
  const styles = (
    <Field label="Kiểu hài (chọn một hoặc nhiều; bỏ trống = tự động)">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {COMEDY_STYLES.map((c) => (
          <label key={c.id} className="flex items-center gap-1.5 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={effective.comedyStyles.includes(c.id)}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setField("comedyStyles", on ? [...effective.comedyStyles, c.id] : effective.comedyStyles.filter((x) => x !== c.id));
              }}
            />
            {c.label}
          </label>
        ))}
      </div>
    </Field>
  );

  const simple: [string, React.ReactNode][] = [
    ["comedyLevel", comedy],
    ["pacingStyle", pacing],
    ["emotionStyle", emotion],
    ["punchlineMode", punchline],
    ["tone", tone],
    ["energyLevel", energy],
  ];
  const advanced: [string, React.ReactNode][] = [
    ["comedyStyles", styles],
    ["tone", tone],
    ["energyLevel", energy],
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {presetSelect}
        {simple.filter(([k]) => show(k)).map(([k, node]) => (
          <div key={k}>{node}</div>
        ))}
        {camera}
      </div>
      <details className="rounded-lg border border-ink-800 px-3 py-2">
        <summary className="cursor-pointer text-xs text-ink-400">Nâng cao: kiểu hài, năng lượng, giọng điệu</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {advanced.filter(([k]) => !show(k) || k === "comedyStyles").map(([k, node]) => (
            <div key={k} className={k === "comedyStyles" ? "sm:col-span-2" : undefined}>
              {node}
            </div>
          ))}
        </div>
      </details>
      <input type="hidden" name={name} value={JSON.stringify(stored)} />
    </div>
  );
}

/** G5: what a motion preset does besides the camera, in plain words. */
function presetHint(id: CameraPresetId): string {
  if (id === "AUTO") return "";
  const m = PRESET_MOTION[id];
  const ambient = m.ambient === 0 ? "không có chuyển động nền" : m.ambient < 0.6 ? "chuyển động nền rất nhẹ" : m.ambient < 0.9 ? "chuyển động nền vừa phải" : "chuyển động nền rõ";
  const join = m.transitions === "CUT" ? "chuyển cảnh: cắt thẳng" : m.transitions === "SOFT" ? "chuyển cảnh: hoà tan ngắn khi đổi bối cảnh" : "chuyển cảnh: lia nhanh khi đổi bối cảnh";
  return `${ambient} · ${join}`;
}
