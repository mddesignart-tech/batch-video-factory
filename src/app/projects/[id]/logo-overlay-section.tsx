"use client";

import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { LOGO_POSITIONS, LOGO_SIZES, VI_LOGO_POSITION, VI_LOGO_SIZE, type OutputControls } from "@/domain/output-controls";
import { LOGO_MISSING_MESSAGE } from "@/domain/logo-overlay";
import type { LogoReferenceOption, LogoState } from "@/services/logo-overlay";

const media = (p: string) => `/api/media/${p.split(/[\\/]/).map(encodeURIComponent).join("/")}`;

type Logo = OutputControls["logo"];

/**
 * LOGO section of the VIDEO OUTPUT card. The logo is one of the project's LOGO
 * References, laid over the finished video on this machine ($0). It is never
 * switched on, or swapped for another picture, by itself.
 */
export function LogoOverlaySection({
  logo,
  options,
  state,
  frame,
  change,
}: {
  logo: Logo;
  options: LogoReferenceOption[];
  state: LogoState;
  frame: { width: number; height: number };
  /** persist=false: move the slider only, save on release. */
  change: (patch: Partial<Logo>, persist?: boolean) => void;
}) {
  const chosen = options.find((o) => o.id === logo.referenceId) ?? null;
  const numberOrNull = (v: string) => (v.trim() === "" ? null : Math.max(0, Number(v)));
  const p = state.placement;

  return (
    <section className="space-y-2" id="logo-overlay">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">Logo trên video</p>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={logo.enabled}
            disabled={options.length === 0}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              // Turning it on names a LOGO Reference - only ever one of type LOGO.
              change(on && !logo.referenceId && options[0] ? { enabled: true, referenceId: options[0].id } : { enabled: on });
            }}
          />
          {logo.enabled ? "Bật" : "Tắt"}
        </label>
      </div>

      {options.length === 0 ? (
        <p className="text-xs text-ink-500">
          Dự án chưa có LOGO Reference. Thêm một tham chiếu loại <b>Logo</b> ở mục{" "}
          <a className="underline" href="#tham-chieu">
            Tài sản tham chiếu
          </a>{" "}
          (nên dùng PNG/WebP nền trong suốt) để đặt logo lên video. Logo được ghép tại máy, $0.
        </p>
      ) : null}

      {state.missing ? (
        <Alert tone="danger" title={LOGO_MISSING_MESSAGE}>
          <p className="text-xs">Video vẫn render được, chỉ không có logo. Không gọi Image AI để tạo lại logo.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => document.getElementById("logo-reference")?.focus()}>
              Chọn lại logo
            </Button>
            <Button variant="outline" onClick={() => change({ enabled: false })}>
              Tắt logo
            </Button>
          </div>
        </Alert>
      ) : null}

      {logo.enabled && options.length > 0 ? (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Logo (LOGO Reference)">
              <Select id="logo-reference" value={logo.referenceId ?? ""} onChange={(e) => change({ referenceId: e.currentTarget.value || null })}>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.exists ? "" : " (thiếu file)"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Vị trí">
              <Select value={logo.position} onChange={(e) => change({ position: e.currentTarget.value as Logo["position"] })}>
                {LOGO_POSITIONS.map((s) => (
                  <option key={s} value={s}>
                    {VI_LOGO_POSITION[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Kích thước">
              <Select value={logo.size} onChange={(e) => change({ size: e.currentTarget.value as Logo["size"] })}>
                {LOGO_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {VI_LOGO_SIZE[s]}
                  </option>
                ))}
              </Select>
              {logo.size === "CUSTOM" ? (
                <input
                  type="range"
                  min={4}
                  max={30}
                  step={1}
                  value={logo.customPct}
                  className="w-full accent-brand-500"
                  onChange={(e) => change({ customPct: Number(e.currentTarget.value) }, false)}
                  onPointerUp={(e) => change({ customPct: Number(e.currentTarget.value) })}
                  onKeyUp={(e) => change({ customPct: Number(e.currentTarget.value) })}
                />
              ) : null}
            </Field>
            <Field label={`Độ rõ: ${Math.round(logo.opacity * 100)}%`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={logo.opacity}
                className="w-full accent-brand-500"
                onChange={(e) => change({ opacity: Number(e.currentTarget.value) }, false)}
                onPointerUp={(e) => change({ opacity: Number(e.currentTarget.value) })}
                onKeyUp={(e) => change({ opacity: Number(e.currentTarget.value) })}
              />
            </Field>
            <Field label={`Cách mép: ${logo.marginPct}%`}>
              <input
                type="range"
                min={0}
                max={15}
                step={0.5}
                value={logo.marginPct}
                className="w-full accent-brand-500"
                onChange={(e) => change({ marginPct: Number(e.currentTarget.value) }, false)}
                onPointerUp={(e) => change({ marginPct: Number(e.currentTarget.value) })}
                onKeyUp={(e) => change({ marginPct: Number(e.currentTarget.value) })}
              />
            </Field>
            <Field label="Hiện từ / đến (giây, trống = cả video)">
              <div className="flex gap-1">
                <Input type="number" min={0} step={0.1} placeholder="đầu" defaultValue={logo.startSec ?? ""} onBlur={(e) => change({ startSec: numberOrNull(e.currentTarget.value) })} />
                <Input type="number" min={0} step={0.1} placeholder="cuối" defaultValue={logo.endSec ?? ""} onBlur={(e) => change({ endSec: numberOrNull(e.currentTarget.value) })} />
              </div>
            </Field>
          </div>

          <div className="flex flex-wrap items-start gap-3">
            {/* Where it lands, to scale: the frame and the logo box. */}
            <div
              className="relative shrink-0 rounded border border-ink-700 bg-ink-900"
              style={{ width: frame.width >= frame.height ? 160 : Math.round((160 * frame.width) / frame.height), aspectRatio: `${frame.width} / ${frame.height}` }}
              title="Vị trí logo trên khung hình"
            >
              {p && chosen?.path ? (
                <img
                  src={media(chosen.path)}
                  alt={chosen.name}
                  className="absolute object-contain"
                  style={{
                    left: `${(p.x / frame.width) * 100}%`,
                    top: `${(p.y / frame.height) * 100}%`,
                    width: `${(p.width / frame.width) * 100}%`,
                    height: `${(p.height / frame.height) * 100}%`,
                    opacity: logo.opacity,
                  }}
                />
              ) : null}
            </div>
            <div className="space-y-1 text-xs text-ink-400">
              {p ? (
                <p>
                  {p.width}×{p.height}px tại ({p.x}, {p.y}) trên khung {frame.width}×{frame.height}. Giữ nguyên tỷ lệ và nền trong suốt; không cắt, không kéo
                  méo, không đổi màu.
                </p>
              ) : null}
              <p>Logo ghép tại máy khi render · Logo Overlay — Local — $0. Bấm XEM TRƯỚC để xem khung thật.</p>
            </div>
          </div>

          {state.alphaWarning ? <Alert tone="warn" title={state.alphaWarning} /> : null}
          {state.clash ? (
            <Alert tone="warn" title={state.clash.message}>
              <Button variant="outline" className="mt-2" onClick={() => change({ position: state.clash!.suggest })}>
                Chuyển logo sang {VI_LOGO_POSITION[state.clash.suggest].toLowerCase()}
              </Button>
            </Alert>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
