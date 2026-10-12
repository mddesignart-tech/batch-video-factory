"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Film, Image as ImageIcon, Upload } from "lucide-react";
import { Alert, Badge, Button, Input, Select } from "@/components/ui";
import type { ActionResult } from "@/components/action-ui";
import {
  assignClipAction,
  clipToLocalMotionAction,
  clipToVideoAiAction,
  deleteClipAction,
  unassignClipAction,
  updateClipSettingsAction,
  uploadClipForScene,
} from "@/app/actions/scene-clips";
import { CLIP_FRAMES, CLIP_SHORT_MODES, MISSING_CLIP_MESSAGE, USER_CLIP_LABEL, VI_CLIP_FRAME, VI_CLIP_SHORT_MODE } from "@/domain/user-clip";

/** One uploaded clip of the project, as the Scene Editor shows it. */
export interface ClipView {
  assetId: string;
  filename: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  hasAudio: boolean;
  aspectRatio: string;
  orientation: string;
  bytes: number;
  posterPath: string | null;
  exists: boolean;
  /** Scene numbers that show this clip. */
  usedBy: number[];
}

export interface SceneClipView {
  /** The scene's visual is the person's clip. */
  using: boolean;
  /** The clip it uses (null when the row is gone). */
  clip: ClipView | null;
  startSec: number | null;
  endSec: number | null;
  audio: "OFF" | "ON";
  audioGain: number;
  shortMode: string;
  frame: string;
}

const media = (p: string) => `/api/media/${p.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const VI_ORIENTATION: Record<string, string> = { PORTRAIT: "dọc", LANDSCAPE: "ngang", SQUARE: "vuông" };

export function clipFacts(c: ClipView): string {
  return (
    `${c.durationSec.toFixed(2)} giây · ${c.width}×${c.height} (${c.aspectRatio}, ${VI_ORIENTATION[c.orientation] ?? c.orientation}) · ` +
    `${c.fps} fps · ${c.codec} · ${c.hasAudio ? "có âm thanh" : "không có âm thanh"} · ${mb(c.bytes)}`
  );
}

/**
 * NGUỒN HÌNH ẢNH / VIDEO: the scene shows a picture, or the person's own clip.
 * Every button here is $0 - files are checked and stored on this machine, and
 * no provider is ever called. "Video của bạn" is never an AI clip.
 */
export function SceneClipPanel({
  sceneId,
  sceneNumber,
  projectId,
  view,
  library,
  onDone,
}: {
  sceneId: string;
  sceneNumber: number;
  projectId: string;
  view: SceneClipView;
  library: ClipView[];
  onDone: (result: ActionResult) => void;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [pick, setPick] = useState("");
  const [startSec, setStartSec] = useState(view.startSec === null ? "" : String(view.startSec));
  const [endSec, setEndSec] = useState(view.endSec === null ? "" : String(view.endSec));
  const [ask, setAsk] = useState<{ text: string; assetId: string } | null>(null);
  const [showClip, setShowClip] = useState(view.using);

  const run = (fn: () => Promise<ActionResult & { confirm?: boolean }>, after?: (r: ActionResult & { confirm?: boolean }) => void) =>
    start(async () => {
      const r = await fn();
      after?.(r);
      onDone(r);
      router.refresh();
    });

  const missing = view.using && (!view.clip || !view.clip.exists);
  const others = library.filter((c) => c.exists && c.assetId !== view.clip?.assetId);

  function upload(file: File) {
    const form = new FormData();
    form.set("sceneId", sceneId);
    form.set("file", file);
    run(() => uploadClipForScene(form));
    if (fileRef.current) fileRef.current.value = "";
  }

  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v.replace(",", ".")));

  return (
    <div className="mb-3 rounded-lg border border-ink-800 bg-ink-850 p-3 text-[11px]" id="nguon-hinh">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-ink-300">NGUỒN HÌNH ẢNH / VIDEO</span>
        {view.using ? <Badge tone="ok">{USER_CLIP_LABEL}</Badge> : null}
        {view.using ? <Badge tone="ok">REUSE · $0 · không gọi Video AI</Badge> : null}
      </div>

      <div className="mb-2 flex gap-1.5">
        <Button
          size="sm"
          variant={!showClip && !view.using ? "secondary" : "outline"}
          disabled={pending}
          onClick={() => {
            if (view.using) {
              if (!window.confirm(`Cảnh ${sceneNumber} thôi dùng clip và quay về ảnh? Clip vẫn nằm trong dự án.`)) return;
              run(() => unassignClipAction(sceneId));
            }
            setShowClip(false);
          }}
        >
          <ImageIcon className="h-3 w-3" /> Ảnh
        </Button>
        <Button size="sm" variant={showClip || view.using ? "secondary" : "outline"} disabled={pending} onClick={() => setShowClip(true)}>
          <Film className="h-3 w-3" /> Video clip
        </Button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".mp4,.mov,.webm,.m4v,video/mp4,video/quicktime,video/webm"
        className="hidden"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) upload(f);
        }}
      />

      {missing ? (
        <Alert tone="danger" title={MISSING_CLIP_MESSAGE}>
          <p className="text-ink-400">
            {view.clip ? `File "${view.clip.filename}" đã bị xoá hoặc di chuyển. ` : ""}Không tự gọi Video AI. Chọn cách tiếp tục:
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" disabled={pending} onClick={() => fileRef.current?.click()}>
              Chọn lại file
            </Button>
            {others.length ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setShowClip(true)}>
                Chọn asset khác (bên dưới)
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => clipToLocalMotionAction(sceneId))}>
              Dùng Local Motion
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Cảnh ${sceneNumber} chuyển sang Video AI (trả phí). Chưa gửi request: giá hiện ở PREFLIGHT và cần duyệt. Tiếp tục?`)) return;
                run(() => clipToVideoAiAction(sceneId));
              }}
            >
              Dùng Video AI
            </Button>
          </div>
        </Alert>
      ) : null}

      {view.using && view.clip && view.clip.exists ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            {view.clip.posterPath ? (
              <img src={media(view.clip.posterPath)} alt="" className="h-16 w-16 shrink-0 rounded border border-ink-700 object-cover" />
            ) : null}
            <div className="min-w-0">
              <p className="truncate font-medium text-ink-200">{view.clip.filename}</p>
              <p className="text-ink-500">{clipFacts(view.clip)}</p>
              <p className="text-ink-500">Xem trước: nút Play ở khung giữa. Chuyển động gốc của clip được giữ nguyên (không zoom/pan thêm).</p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-1.5">
            <label className="flex flex-col gap-0.5 text-ink-400">
              Bắt đầu (giây)
              <Input value={startSec} onChange={(e) => setStartSec(e.currentTarget.value)} placeholder="0" className="h-7 w-20 text-[11px]" inputMode="decimal" />
            </label>
            <label className="flex flex-col gap-0.5 text-ink-400">
              Kết thúc (giây)
              <Input
                value={endSec}
                onChange={(e) => setEndSec(e.currentTarget.value)}
                placeholder={view.clip.durationSec.toFixed(2)}
                className="h-7 w-20 text-[11px]"
                inputMode="decimal"
              />
            </label>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => updateClipSettingsAction(sceneId, { startSec: num(startSec), endSec: num(endSec) }))}>
              Lưu đoạn dùng
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-ink-400">Âm thanh clip:</span>
            <Button
              size="sm"
              variant={view.audio === "OFF" ? "secondary" : "outline"}
              disabled={pending}
              onClick={() => run(() => updateClipSettingsAction(sceneId, { audio: "OFF" }))}
            >
              Tắt âm thanh clip
            </Button>
            <Button
              size="sm"
              variant={view.audio === "ON" ? "secondary" : "outline"}
              disabled={pending || !view.clip.hasAudio}
              title={view.clip.hasAudio ? "" : "Clip này không có âm thanh"}
              onClick={() => run(() => updateClipSettingsAction(sceneId, { audio: "ON" }))}
            >
              Giữ âm thanh clip
            </Button>
            {view.audio === "ON" ? (
              <label className="flex items-center gap-1 text-ink-400">
                Mức
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  defaultValue={Math.round(view.audioGain * 100)}
                  disabled={pending}
                  onMouseUp={(e) => run(() => updateClipSettingsAction(sceneId, { audioGain: Number(e.currentTarget.value) / 100 }))}
                  onKeyUp={(e) => run(() => updateClipSettingsAction(sceneId, { audioGain: Number(e.currentTarget.value) / 100 }))}
                />
                <span>{Math.round(view.audioGain * 100)}% · tự hạ khi có lời đọc</span>
              </label>
            ) : (
              <span className="text-ink-500">Mặc định tắt: chỉ nghe lời đọc / nhạc.</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-ink-400">Clip ngắn hơn cảnh:</span>
            <Select value={view.shortMode} disabled={pending} onChange={(e) => { const v = e.currentTarget.value; run(() => updateClipSettingsAction(sceneId, { shortMode: v as never })); }} className="h-7 w-auto text-[11px]">
              {CLIP_SHORT_MODES.map((m) => (
                <option key={m} value={m}>
                  {VI_CLIP_SHORT_MODE[m]}
                </option>
              ))}
            </Select>
            <span className="text-ink-400">Khung:</span>
            <Select value={view.frame} disabled={pending} onChange={(e) => { const v = e.currentTarget.value; run(() => updateClipSettingsAction(sceneId, { frame: v as never })); }} className="h-7 w-auto text-[11px]">
              {CLIP_FRAMES.map((f) => (
                <option key={f} value={f}>
                  {VI_CLIP_FRAME[f]}
                </option>
              ))}
            </Select>
          </div>
        </div>
      ) : null}

      {showClip || view.using ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-ink-800 pt-2">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => fileRef.current?.click()}>
            <Upload className="h-3 w-3" /> {view.using ? "Thay clip" : "Tải video lên"} (.mp4 / .mov / .webm)
          </Button>
          {others.length ? (
            <>
              <Select value={pick} onChange={(e) => setPick(e.currentTarget.value)} className="h-7 w-auto max-w-[180px] text-[11px]">
                <option value="">Clip đã tải trong dự án…</option>
                {others.map((c) => (
                  <option key={c.assetId} value={c.assetId}>
                    {c.filename} · {c.durationSec.toFixed(1)}s{c.usedBy.length ? ` · cảnh ${c.usedBy.join(", ")}` : ""}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="ghost" disabled={pending || !pick} onClick={() => run(() => assignClipAction(sceneId, pick))}>
                Dùng clip này
              </Button>
            </>
          ) : null}
          {view.using ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Bỏ gán clip khỏi cảnh ${sceneNumber}? Clip vẫn nằm trong dự án.`)) return;
                run(() => unassignClipAction(sceneId));
              }}
            >
              Bỏ gán
            </Button>
          ) : null}
        </div>
      ) : null}

      {(showClip || view.using) && library.length ? (
        <div className="mt-2 space-y-1">
          <p className="text-ink-500">Video trong dự án:</p>
          {library.map((c) => (
            <div key={c.assetId} className="flex items-center justify-between gap-2">
              <span className="truncate text-ink-400">
                {c.filename} · {c.durationSec.toFixed(1)}s · {c.width}×{c.height}
                {c.exists ? "" : " · MẤT FILE"}
                {c.usedBy.length ? ` · đang dùng ở cảnh ${c.usedBy.join(", ")}` : ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  run(
                    () => deleteClipAction(projectId, c.assetId),
                    (r) => setAsk(r.confirm ? { text: r.message, assetId: c.assetId } : null),
                  )
                }
              >
                Xoá
              </Button>
            </div>
          ))}
          {ask ? (
            <Alert tone="warn" title={ask.text}>
              <div className="mt-1.5 flex gap-1.5">
                <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => deleteClipAction(projectId, ask.assetId, { confirm: true }), () => setAsk(null))}>
                  Vẫn xoá
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAsk(null)}>
                  Huỷ
                </Button>
              </div>
            </Alert>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
