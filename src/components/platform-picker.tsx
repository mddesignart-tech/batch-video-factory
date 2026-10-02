"use client";

import { useState } from "react";
import { Input } from "@/components/ui";
import {
  aspectOf,
  DEFAULT_PLATFORM,
  DEFAULT_PLATFORM_NOTE,
  FIT_MODES,
  PLATFORM_PRESETS,
  platformPreset,
  viShape,
  VI_FIT_MODE,
  type FitMode,
  type OutputProfile,
  type PlatformId,
} from "@/domain/platform-profile";

/**
 * "Bạn muốn đăng video ở đâu?" (QĐ-121).
 *
 * Big tiles with a small frame drawing; the size, ratio and one plain sentence
 * under the choice. Width / height / FPS / fit / subtitle position live behind
 * "Cài đặt nâng cao" - nobody has to open it.
 *
 * Works in a <form> (hidden inputs named platform / customWidth / customHeight /
 * customFps) or controlled through `onChange`.
 */

/** A small drawing of the frame, its real proportions. */
export function FrameShape({ width, height, size = 28, className = "" }: { width: number; height: number; size?: number; className?: string }) {
  const scale = size / Math.max(width, height);
  return (
    <span
      aria-hidden
      className={`inline-block rounded-[3px] border-2 border-current ${className}`}
      style={{ width: Math.max(6, Math.round(width * scale)), height: Math.max(6, Math.round(height * scale)) }}
    />
  );
}

export function PlatformPicker({
  initial,
  showFitAndSubtitles = false,
  onChange,
  formNames = true,
}: {
  initial?: Partial<OutputProfile>;
  /** Project page: fit mode and subtitle position in "Nâng cao" too. */
  showFitAndSubtitles?: boolean;
  onChange?: (profile: Partial<OutputProfile>) => void;
  /** Emit hidden inputs for a plain <form>. */
  formNames?: boolean;
}) {
  const [platform, setPlatform] = useState<PlatformId>((initial?.platform as PlatformId) ?? DEFAULT_PLATFORM);
  const base = platformPreset(platform)!;
  const [width, setWidth] = useState(String(initial?.width ?? base.width));
  const [height, setHeight] = useState(String(initial?.height ?? base.height));
  const [fps, setFps] = useState(String(initial?.fps ?? 30));
  const [fit, setFit] = useState<FitMode>(initial?.fit ?? "AUTO");
  const [bottom, setBottom] = useState(initial?.subtitleBottomPct != null ? String(initial.subtitleBottomPct) : "");
  const [advanced, setAdvanced] = useState(false);

  const custom = platform === "CUSTOM";
  const w = custom ? Number(width) || 0 : base.width;
  const h = custom ? Number(height) || 0 : base.height;

  const emit = (next: Partial<{ platform: PlatformId; width: string; height: string; fps: string; fit: FitMode; bottom: string }>) => {
    const p = next.platform ?? platform;
    const preset = platformPreset(p)!;
    const isCustom = p === "CUSTOM";
    onChange?.({
      platform: p,
      width: isCustom ? Number(next.width ?? width) : preset.width,
      height: isCustom ? Number(next.height ?? height) : preset.height,
      fps: Number(next.fps ?? fps) || 30,
      fit: next.fit ?? fit,
      subtitleBottomPct: (next.bottom ?? bottom).trim() === "" ? null : Number(next.bottom ?? bottom),
    });
  };

  const pick = (id: PlatformId) => {
    setPlatform(id);
    if (id !== "CUSTOM") {
      const p = platformPreset(id)!;
      setWidth(String(p.width));
      setHeight(String(p.height));
    }
    emit({ platform: id });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PLATFORM_PRESETS.map((p) => {
          const on = p.id === platform;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => pick(p.id)}
              aria-pressed={on}
              className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors ${
                on ? "border-brand-500 bg-brand-500/10 text-brand-400" : "border-ink-700 text-ink-300 hover:border-ink-500"
              }`}
            >
              <span className="flex h-8 items-center gap-2">
                <span className="text-lg leading-none">{p.icon}</span>
                <FrameShape width={p.id === "CUSTOM" && on ? w || 1 : p.width} height={p.id === "CUSTOM" && on ? h || 1 : p.height} />
              </span>
              <span className="text-xs font-semibold">{p.label}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-ink-800 bg-ink-850 p-3 text-xs">
        <span className="text-ink-400">
          NỀN TẢNG <strong className="ml-1 text-ink-100">{base.label}</strong>
        </span>
        <span className="text-ink-400">
          Kích thước <strong className="ml-1 text-ink-100">{w} × {h}</strong>
        </span>
        <span className="text-ink-400">
          Tỷ lệ <strong className="ml-1 text-ink-100">{w > 0 && h > 0 ? aspectOf(w, h) : "—"}</strong>
        </span>
        <span className="text-ink-300">{custom ? (w > 0 && h > 0 ? viShape(w, h) : "Nhập kích thước") : base.hint}</span>
      </div>
      {!initial?.platform ? <p className="text-[11px] text-ink-500">{DEFAULT_PLATFORM_NOTE}</p> : null}

      {custom ? (
        <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
          <label className="text-[11px] text-ink-400">
            Chiều rộng
            <Input value={width} inputMode="numeric" onChange={(e) => { setWidth(e.target.value); emit({ width: e.target.value }); }} />
          </label>
          <label className="text-[11px] text-ink-400">
            Chiều cao
            <Input value={height} inputMode="numeric" onChange={(e) => { setHeight(e.target.value); emit({ height: e.target.value }); }} />
          </label>
        </div>
      ) : null}

      <button type="button" className="text-[11px] text-ink-500 underline-offset-2 hover:text-ink-300 hover:underline" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "Ẩn cài đặt nâng cao" : "Cài đặt nâng cao"}
      </button>
      {advanced ? (
        <div className="grid gap-3 rounded-lg border border-ink-800 p-3 text-[11px] sm:grid-cols-2">
          <label className="text-ink-400">
            FPS (khung hình / giây)
            <Input value={fps} inputMode="numeric" onChange={(e) => { setFps(e.target.value); emit({ fps: e.target.value }); }} />
          </label>
          {showFitAndSubtitles ? (
            <>
              <label className="text-ink-400">
                Khớp ảnh/video vào khung
                <select
                  className="mt-1 block h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100"
                  value={fit}
                  onChange={(e) => { setFit(e.target.value as FitMode); emit({ fit: e.target.value as FitMode }); }}
                >
                  {FIT_MODES.map((m) => (
                    <option key={m} value={m}>
                      {VI_FIT_MODE[m]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-ink-400">
                Vị trí phụ đề (cách đáy, % chiều cao) — để trống: Tự động – Khuyên dùng
                <Input value={bottom} inputMode="decimal" placeholder="Tự động" onChange={(e) => { setBottom(e.target.value); emit({ bottom: e.target.value }); }} />
              </label>
            </>
          ) : null}
          <p className="text-ink-500 sm:col-span-2">Video xuất H.264 + AAC (tương thích mọi nền tảng). Ảnh/video không bao giờ bị kéo méo.</p>
        </div>
      ) : null}

      {formNames ? (
        <>
          <input type="hidden" name="platform" value={platform} />
          {custom ? (
            <>
              <input type="hidden" name="customWidth" value={width} />
              <input type="hidden" name="customHeight" value={height} />
            </>
          ) : null}
          <input type="hidden" name="customFps" value={fps} />
        </>
      ) : null}
    </div>
  );
}
