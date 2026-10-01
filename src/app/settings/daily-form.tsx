"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Alert, Button, Input, Textarea } from "@/components/ui";
import { BUILT_IN_PRESETS, SUBTITLE_MODES, VI_SUBTITLE_MODE, type OutputPreset } from "@/domain/output-preset";
import { deleteCustomPresetAction, saveCustomPresetAction, saveDailySettingsAction } from "@/app/actions/workspace";

/**
 * Settings > Sản xuất hằng ngày (V1.2 Phase 6, QĐ-114). Output preset, batch
 * mode, concurrency, metadata templates. API keys are not here - they stay in
 * .env. Output root is shown, not editable: the "open folder" buttons only open
 * folders inside data/, and moving that root is an .env decision (DATA_DIR).
 */
export function DailySettingsForm({
  initial,
  outputRoot,
}: {
  initial: {
    defaultOutputPresetId: string;
    defaultBatchMode: "PARTIAL" | "STRICT";
    maxConcurrentVideos: number;
    maxConcurrentLocalRenders: number;
    maxConcurrentPaidRequests: number;
    socialTemplates: { title: string; description: string };
    customPresets: OutputPreset[];
  };
  outputRoot: string;
}) {
  const router = useRouter();
  const [f, setF] = useState({
    defaultOutputPresetId: initial.defaultOutputPresetId,
    defaultBatchMode: initial.defaultBatchMode,
    maxConcurrentVideos: String(initial.maxConcurrentVideos),
    maxConcurrentLocalRenders: String(initial.maxConcurrentLocalRenders),
    maxConcurrentPaidRequests: String(initial.maxConcurrentPaidRequests),
    socialTitleTemplate: initial.socialTemplates.title,
    socialDescriptionTemplate: initial.socialTemplates.description,
  });
  const [p, setP] = useState({
    id: "",
    name: "",
    width: "1080",
    height: "1920",
    fps: "30",
    quality: "STANDARD",
    audioBitrateKbps: "192",
    subtitleMode: "BOTH",
    thumbnail: true,
    metadata: true,
    textFiles: true,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const presets = [...BUILT_IN_PRESETS, ...initial.customPresets];

  async function run(key: string, fn: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(key);
    try {
      const r = await fn();
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const select = "mt-1 block h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100";
  return (
    <div className="space-y-5 text-xs">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-ink-400">
          Preset đầu ra mặc định
          <select className={select} value={f.defaultOutputPresetId} onChange={(e) => setF({ ...f, defaultOutputPresetId: e.target.value })}>
            {presets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.width}x{x.height})
              </option>
            ))}
          </select>
        </label>
        <label className="text-ink-400">
          Chế độ lô mặc định
          <select className={select} value={f.defaultBatchMode} onChange={(e) => setF({ ...f, defaultBatchMode: e.target.value as "PARTIAL" | "STRICT" })}>
            <option value="PARTIAL">PARTIAL — video lỗi không chặn video khác</option>
            <option value="STRICT">STRICT — có blocker thì không bắt đầu lô</option>
          </select>
        </label>
        <label className="text-ink-400">
          MAX CONCURRENT VIDEOS (1–4)
          <Input type="number" min={1} max={4} value={f.maxConcurrentVideos} onChange={(e) => setF({ ...f, maxConcurrentVideos: e.target.value })} className="mt-1" />
        </label>
        <label className="text-ink-400">
          MAX CONCURRENT LOCAL RENDERS (1–2)
          <Input type="number" min={1} max={2} value={f.maxConcurrentLocalRenders} onChange={(e) => setF({ ...f, maxConcurrentLocalRenders: e.target.value })} className="mt-1" />
        </label>
        <label className="text-ink-400">
          MAX CONCURRENT PAID REQUESTS (1–2)
          <Input type="number" min={1} max={2} value={f.maxConcurrentPaidRequests} onChange={(e) => setF({ ...f, maxConcurrentPaidRequests: e.target.value })} className="mt-1" />
        </label>
        <div className="text-ink-400">
          Thư mục output
          <p className="mt-1 break-all font-mono text-ink-300">{outputRoot}</p>
          <p className="text-[11px] text-ink-500">Đổi bằng DATA_DIR trong .env (khởi động lại).</p>
        </div>
      </div>
      <p className="text-[11px] text-ink-500">
        Khuyến nghị giữ 1/1/1: SQLite một người ghi; song song nhiều hơn không làm rẻ hơn. Khoá chi (reservation, trần video/lô/toàn cục) luôn kiểm lại ở
        từng yêu cầu trả phí — tăng song song không làm vượt ngân sách.
      </p>
      <label className="block text-ink-400">
        Mẫu tiêu đề ({"{{title}}"}, {"{{summary}}"}, {"{{hashtags}}"}, {"{{tags}}"}, {"{{batch}}"}, {"{{date}}"})
        <Input value={f.socialTitleTemplate} onChange={(e) => setF({ ...f, socialTitleTemplate: e.target.value })} className="mt-1" />
      </label>
      <label className="block text-ink-400">
        Mẫu mô tả
        <Textarea rows={3} value={f.socialDescriptionTemplate} onChange={(e) => setF({ ...f, socialDescriptionTemplate: e.target.value })} className="mt-1" />
      </label>
      <Button
        variant="primary"
        disabled={busy !== null}
        onClick={() =>
          void run("save", () =>
            saveDailySettingsAction({
              ...f,
              maxConcurrentVideos: Number(f.maxConcurrentVideos),
              maxConcurrentLocalRenders: Number(f.maxConcurrentLocalRenders),
              maxConcurrentPaidRequests: Number(f.maxConcurrentPaidRequests),
            }),
          )
        }
      >
        {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        LƯU CÀI ĐẶT HẰNG NGÀY
      </Button>

      <div className="space-y-2 border-t border-ink-800 pt-4">
        <p className="text-sm font-semibold text-ink-100">Preset tuỳ chỉnh</p>
        {initial.customPresets.length === 0 ? <p className="text-ink-500">Chưa có preset tuỳ chỉnh.</p> : null}
        {initial.customPresets.map((x) => (
          <div key={x.id} className="flex flex-wrap items-center gap-2">
            <span className="text-ink-200">
              {x.name} <span className="font-mono text-ink-500">({x.id})</span> — {x.width}x{x.height} {x.fps}fps · {x.quality} · AAC {x.audioBitrateKbps}k ·{" "}
              {VI_SUBTITLE_MODE[x.subtitleMode]}
            </span>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run(`del-${x.id}`, () => deleteCustomPresetAction(x.id))}>
              Xoá
            </Button>
          </div>
        ))}
        <div className="grid gap-2 md:grid-cols-4">
          <label className="text-ink-400">
            id
            <Input value={p.id} onChange={(e) => setP({ ...p, id: e.target.value })} placeholder="shorts-hq" className="mt-1" />
          </label>
          <label className="text-ink-400">
            Tên
            <Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="Shorts chất lượng cao" className="mt-1" />
          </label>
          <label className="text-ink-400">
            Rộng
            <Input type="number" value={p.width} onChange={(e) => setP({ ...p, width: e.target.value })} className="mt-1" />
          </label>
          <label className="text-ink-400">
            Cao
            <Input type="number" value={p.height} onChange={(e) => setP({ ...p, height: e.target.value })} className="mt-1" />
          </label>
          <label className="text-ink-400">
            FPS
            <Input type="number" value={p.fps} onChange={(e) => setP({ ...p, fps: e.target.value })} className="mt-1" />
          </label>
          <label className="text-ink-400">
            Chất lượng (H.264)
            <select className={select} value={p.quality} onChange={(e) => setP({ ...p, quality: e.target.value })}>
              <option value="HIGH">Cao (CRF 18)</option>
              <option value="STANDARD">Chuẩn (CRF 20)</option>
              <option value="SMALL">Nhẹ (CRF 23)</option>
            </select>
          </label>
          <label className="text-ink-400">
            Âm thanh AAC (kbps)
            <Input type="number" value={p.audioBitrateKbps} onChange={(e) => setP({ ...p, audioBitrateKbps: e.target.value })} className="mt-1" />
          </label>
          <label className="text-ink-400">
            Phụ đề
            <select className={select} value={p.subtitleMode} onChange={(e) => setP({ ...p, subtitleMode: e.target.value })}>
              {SUBTITLE_MODES.map((m) => (
                <option key={m} value={m}>
                  {VI_SUBTITLE_MODE[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={p.thumbnail} onChange={(e) => setP({ ...p, thumbnail: e.target.checked })} /> thumbnail.jpg
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={p.metadata} onChange={(e) => setP({ ...p, metadata: e.target.checked })} /> metadata.json
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={p.textFiles} onChange={(e) => setP({ ...p, textFiles: e.target.checked })} /> captions.txt + description.txt
          </label>
        </div>
        <p className="text-[11px] text-ink-500">Codec cố định H.264 + AAC. Intro/outro và watermark chưa hỗ trợ ở Phase 6.</p>
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() =>
            void run("preset", () =>
              saveCustomPresetAction({
                id: p.id,
                name: p.name,
                platform: "CUSTOM",
                width: Number(p.width),
                height: Number(p.height),
                fps: Number(p.fps),
                videoCodec: "h264",
                quality: p.quality,
                audioCodec: "aac",
                audioBitrateKbps: Number(p.audioBitrateKbps),
                subtitleMode: p.subtitleMode,
                thumbnail: p.thumbnail,
                metadata: p.metadata,
                textFiles: p.textFiles,
              }),
            )
          }
        >
          LƯU PRESET
        </Button>
      </div>
      {message ? <Alert tone={message.ok ? "ok" : "danger"}>{message.text}</Alert> : null}
    </div>
  );
}
