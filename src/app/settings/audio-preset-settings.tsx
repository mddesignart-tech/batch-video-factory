"use client";

import { useEffect, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Alert, Button, Select } from "@/components/ui";
import {
  audioPresetsAction,
  deleteAudioPresetAction,
  newProjectMotionQualityAction,
  setNewProjectAudioPresetAction,
  setNewProjectMotionQualityAction,
} from "@/app/actions/audio-mixer";
import { MOTION_QUALITY_INFO, NEW_PROJECT_MOTION_QUALITIES, type NewProjectMotionQuality } from "@/domain/motion-quality";
import type { AudioPreset } from "@/domain/audio-mixer";

/**
 * AUDIO MIXER presets in Settings (QĐ-150): which preset a NEW video starts
 * with, and the person's own presets (system presets cannot be deleted).
 * Nothing here changes a video that already exists.
 */
export function AudioPresetSettings() {
  const [pending, start] = useTransition();
  const [presets, setPresets] = useState<AudioPreset[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [motion, setMotion] = useState<NewProjectMotionQuality | null>(null);
  const reload = () =>
    void audioPresetsAction().then((r) => {
      setPresets(r.presets);
      setCurrent(r.newProjectPresetId);
    });
  useEffect(() => void newProjectMotionQualityAction().then(setMotion), []);
  useEffect(reload, []);

  return (
    <div className="space-y-2 border-t border-ink-800 pt-3 text-xs">
      <p className="font-semibold text-ink-300">Audio Mixer (QĐ-150)</p>
      <label className="flex flex-wrap items-center gap-2 text-ink-400">
        Video MỚI bắt đầu với preset:
        <Select
          value={current ?? ""}
          className="w-56"
          disabled={pending}
          onChange={(e) => {
            const id = e.currentTarget.value || null;
            start(async () => {
              const r = await setNewProjectAudioPresetAction(id);
              setMsg({ ok: r.ok, text: r.message });
              reload();
            });
          }}
        >
          <option value="">Không - dùng bộ trộn cũ</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.system ? "" : " (của tôi)"}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-ink-500">Video đã có không bị đổi. Bộ 5 thanh trượt ở trên chỉ dùng cho video chưa bật Audio Mixer.</p>
      {presets.some((p) => !p.system) ? (
        <ul className="space-y-1">
          {presets
            .filter((p) => !p.system)
            .map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-ink-300">
                {p.name}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await deleteAudioPresetAction(p.id);
                      setMsg({ ok: r.ok, text: r.message });
                      reload();
                    })
                  }
                >
                  <Trash2 className="h-3 w-3" /> Xoá
                </Button>
              </li>
            ))}
        </ul>
      ) : (
        <p className="text-ink-500">Chưa có preset tự tạo - lưu từ Audio Mixer trong trang video.</p>
      )}
      <p className="pt-2 font-semibold text-ink-300">Chuyển động camera (QĐ-151)</p>
      <label className="flex flex-wrap items-center gap-2 text-ink-400">
        Video MỚI dùng Motion Quality:
        <Select
          value={motion ?? ""}
          className="w-56"
          disabled={pending || motion === null}
          onChange={(e) => {
            const q = e.currentTarget.value as NewProjectMotionQuality;
            setMotion(q);
            start(async () => {
              const r = await setNewProjectMotionQualityAction(q);
              setMsg({ ok: r.ok, text: r.message });
            });
          }}
        >
          {NEW_PROJECT_MOTION_QUALITIES.map((q) => (
            <option key={q} value={q}>
              {MOTION_QUALITY_INFO[q].label} — {MOTION_QUALITY_INFO[q].hint}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-ink-500">High Quality V2 không bao giờ là mặc định — chỉ chọn riêng cho từng video. Video đã có không bị đổi.</p>
      {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}
    </div>
  );
}
