"use client";

import { useEffect, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Alert, Button, Select } from "@/components/ui";
import { audioPresetsAction, deleteAudioPresetAction, setNewProjectAudioPresetAction } from "@/app/actions/audio-mixer";
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
  const reload = () =>
    void audioPresetsAction().then((r) => {
      setPresets(r.presets);
      setCurrent(r.newProjectPresetId);
    });
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
      {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}
    </div>
  );
}
