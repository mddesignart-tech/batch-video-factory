"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Loader2, Wand2 } from "lucide-react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Select } from "@/components/ui";
import { applyAudioPresetToBatchAction, audioPresetsAction, batchRemixAction } from "@/app/actions/audio-mixer";
import { DEFAULT_AUDIO_PRESET_ID, type AudioPreset } from "@/domain/audio-mixer";

export interface BatchAudioVideo {
  projectId: string;
  title: string;
  /** Preset id the video's mixer came from; null = custom values; undefined = old mix (no mixer). */
  presetId: string | null | undefined;
  hasFinal: boolean;
}

/**
 * ÂM THANH LÔ (QĐ-150): one Audio Preset for every video of the batch, the
 * preset each video has now (each stays editable on its own page), and BATCH
 * REMIX - the sound of every exported video mixed again on this machine, in the
 * local-render queue, without rendering pictures or calling any API.
 */
export function BatchAudioCard({ batchId, videos }: { batchId: string; videos: BatchAudioVideo[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [presets, setPresets] = useState<AudioPreset[]>([]);
  const [choice, setChoice] = useState(DEFAULT_AUDIO_PRESET_ID);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => void audioPresetsAction().then((r) => setPresets(r.presets)), []);

  const name = (id: string | null | undefined) =>
    id === undefined ? "Bộ trộn cũ" : id === null ? "Tuỳ chỉnh" : (presets.find((p) => p.id === id)?.name ?? id);
  const counts = new Map<string, number>();
  for (const v of videos) counts.set(name(v.presetId), (counts.get(name(v.presetId)) ?? 0) + 1);
  const exported = videos.filter((v) => v.hasFinal).length;

  return (
    <Card id="am-thanh-lo">
      <CardHeader>
        <CardTitle>Âm thanh lô</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-ink-400">
          Hiện tại: {[...counts.entries()].map(([k, n]) => `${k} × ${n}`).join(" · ") || "chưa có video"}. Mỗi video vẫn chỉnh riêng được trong trang video (Video output → Nhạc nền).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={choice} className="w-56" disabled={pending} onChange={(e) => setChoice(e.currentTarget.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.system ? "" : " (của tôi)"}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="primary"
            disabled={pending || videos.length === 0}
            onClick={() =>
              start(async () => {
                const r = await applyAudioPresetToBatchAction(batchId, choice);
                setMsg({ ok: r.ok, text: r.message });
                router.refresh();
              })
            }
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Áp dụng cho toàn bộ {videos.length} video
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || exported === 0}
            onClick={() =>
              start(async () => {
                const r = await batchRemixAction(batchId);
                setMsg({ ok: r.ok, text: r.message });
                router.refresh();
              })
            }
          >
            <Wand2 className="h-3 w-3" /> BATCH REMIX AUDIO · $0 API ({exported} video đã xuất)
          </Button>
          <span className="text-xs text-ink-500">Chỉ trộn lại âm thanh tại máy theo thiết lập hiện tại của từng video, giữ nguyên hình, không gọi API.</span>
        </div>
        {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}
      </CardContent>
    </Card>
  );
}
