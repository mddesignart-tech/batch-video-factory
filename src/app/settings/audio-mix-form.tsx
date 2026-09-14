"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-ui";
import { Alert, Badge, Button, Label } from "@/components/ui";
import { resetAudioMix, updateAudioMix } from "@/app/actions/config";
import { DEFAULT_MIX, type AudioMixSettings } from "@/media/mix-config";

/**
 * The audio mix, as five sliders.
 *
 * Sliders rather than number boxes because these are judged by ear: an operator
 * moves one, listens, moves it back. A box invites typing a value and hoping.
 *
 * Every label says what the knob DOES before it says what it is called, and the
 * live readout carries a unit. Nobody should need to know what a sidechain
 * compressor is to make the music quieter under the voice.
 */

interface Knob {
  name: keyof AudioMixSettings;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  /** How the raw number is shown to a human. */
  format: (v: number) => string;
}

const KNOBS: Knob[] = [
  {
    name: "musicGain",
    label: "Âm lượng nhạc nền",
    help: "Mức nhạc khi KHÔNG có ai nói. Cao quá thì nhạc át lời.",
    min: 0,
    max: 1,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    name: "duckDb",
    label: "Hạ nhạc khi có lời",
    help: "Nhạc tụt xuống bao nhiêu trong lúc nhân vật đang nói. Càng lớn, lời càng nổi.",
    min: 0,
    max: 30,
    step: 1,
    format: (v) => `${v} dB`,
  },
  {
    name: "attackMs",
    label: "Tốc độ hạ nhạc",
    help: "Nhạc tụt nhanh cỡ nào khi lời bắt đầu. Quá nhanh nghe giật; quá chậm thì lời đầu câu bị nhạc đè.",
    min: 1,
    max: 500,
    step: 1,
    format: (v) => `${v} ms`,
  },
  {
    name: "releaseMs",
    label: "Tốc độ nhạc trở lại",
    help: "Nhạc quay về mức cũ nhanh cỡ nào sau khi hết lời. Quá nhanh thì nhạc phập phồng giữa các câu.",
    min: 20,
    max: 2000,
    step: 10,
    format: (v) => `${v} ms`,
  },
  {
    name: "sfxGain",
    label: "Âm lượng hiệu ứng",
    help: "Mức tiếng động. Hiệu ứng cũng bị hạ khi có lời, giống nhạc.",
    min: 0,
    max: 1,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
  },
];

export function AudioMixForm({ mix }: { mix: AudioMixSettings }) {
  const [values, setValues] = useState<AudioMixSettings>(mix);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isDefault = KNOBS.every((k) => values[k.name] === DEFAULT_MIX[k.name]);

  async function doReset() {
    setResetting(true);
    try {
      const result = await resetAudioMix();
      if (result.ok) setValues({ ...DEFAULT_MIX });
      setNotice(result.message);
    } finally {
      setResetting(false);
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-ink-300 uppercase">
          Cài đặt âm thanh
        </h3>
        <Badge tone={isDefault ? "ok" : "warn"}>
          {isDefault ? "đang dùng mặc định" : "đã chỉnh"}
        </Badge>
      </div>

      <p className="mb-3 text-[11px] text-ink-400">
        Nguyên tắc duy nhất: <strong>lời thoại là chính</strong>. Nhạc và hiệu ứng
        nằm dưới. Nếu không chắc, bấm <em>Khôi phục mặc định</em> — bộ mặc định đã
        được đo và kiểm chứng cho video dạng Shorts.
      </p>

      <ActionForm action={updateAudioMix} submitLabel="Lưu cài đặt âm thanh">
        <div className="space-y-4">
          {KNOBS.map((knob) => (
            <div key={knob.name}>
              <div className="flex items-baseline justify-between">
                <Label>{knob.label}</Label>
                <span className="font-mono text-xs text-ink-200">
                  {knob.format(values[knob.name])}
                  {values[knob.name] === DEFAULT_MIX[knob.name] ? (
                    <span className="ml-2 text-ink-500">mặc định</span>
                  ) : (
                    <span className="ml-2 text-ink-500">
                      mặc định {knob.format(DEFAULT_MIX[knob.name])}
                    </span>
                  )}
                </span>
              </div>
              <input
                type="range"
                name={knob.name}
                min={knob.min}
                max={knob.max}
                step={knob.step}
                value={values[knob.name]}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [knob.name]: Number(e.target.value) }))
                }
                className="mt-1 w-full accent-brand-500"
              />
              <p className="mt-1 text-[11px] text-ink-400">{knob.help}</p>
            </div>
          ))}
        </div>
      </ActionForm>

      <div className="mt-3 flex items-center gap-2 border-t border-ink-800 pt-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => void doReset()}
          disabled={resetting || isDefault}
        >
          {resetting ? "Đang khôi phục..." : "Khôi phục mặc định"}
        </Button>
        <span className="text-[11px] text-ink-500">
          Nhạc {DEFAULT_MIX.musicGain * 100}%, hạ {DEFAULT_MIX.duckDb} dB, hạ trong{" "}
          {DEFAULT_MIX.attackMs} ms, trở lại sau {DEFAULT_MIX.releaseMs} ms, hiệu ứng{" "}
          {DEFAULT_MIX.sfxGain * 100}%
        </span>
      </div>

      {notice && (
        <div className="mt-2">
          <Alert tone="ok">{notice}</Alert>
        </div>
      )}
    </section>
  );
}
