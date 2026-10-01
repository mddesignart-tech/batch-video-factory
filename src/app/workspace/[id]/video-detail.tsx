"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Alert, Badge, Button, Input, Textarea } from "@/components/ui";
import { CopyTextButton } from "@/components/copy-path-button";
import {
  exportSelectedAction,
  saveSocialMetaAction,
  setThumbnailAction,
  uploadThumbnailAction,
  videoDetailAction,
} from "@/app/actions/workspace";
import type { VideoDetail } from "@/services/daily-actions";

/**
 * One video's publishing details (V1.2 Phase 6, QĐ-114): the words to post,
 * the thumbnail, a safe-area preview, and the EXPORT READY checks. Everything
 * here is local - no AI writes the metadata, no image API draws the thumbnail.
 */
export function VideoDetailPanel({ projectId, batchId, onClose }: { projectId: string; batchId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [overlay, setOverlay] = useState(true);
  // Bumped on every reload so a re-exported thumbnail is fetched again.
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async () => {
    const r = await videoDetailAction(projectId);
    if (!r.ok || !r.detail) {
      setError(r.message);
      return;
    }
    setDetail(r.detail);
    setTitle(r.detail.social.title ?? "");
    setDescription(r.detail.social.description ?? "");
    setTags((r.detail.social.tags ?? []).join(", "));
    setHashtags((r.detail.social.hashtags ?? []).join(" "));
    setNonce((n) => n + 1);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, fn: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(key);
    try {
      const r = await fn();
      setMessage({ ok: r.ok, text: r.message });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const zones = detail?.safeArea.zones ?? null;
  const thumbSrc = detail?.output ? `/api/media/${detail.output.relative}/thumbnail.jpg?v=${nonce}` : null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-ink-800 bg-ink-950 p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Chi tiết video"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink-100">{detail?.title ?? "…"}</h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Đóng">
            <X className="h-4 w-4" />
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {!detail ? (
          <p className="text-sm text-ink-400">Đang đọc…</p>
        ) : (
          <div className="space-y-5">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-ink-200">Metadata đăng bài</h3>
              <p className="text-[11px] text-ink-500">
                Để trống = dùng mẫu trong Cài đặt ({"{{title}}"}, {"{{summary}}"}, {"{{hashtags}}"}). Không gọi AI.
              </p>
              <label className="block text-xs text-ink-400">
                Tiêu đề
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={detail.title} className="mt-1" />
              </label>
              <label className="block text-xs text-ink-400">
                Mô tả
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="mt-1" />
              </label>
              <label className="block text-xs text-ink-400">
                Tags (cách nhau bằng dấu phẩy)
                <Input value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1" />
              </label>
              <label className="block text-xs text-ink-400">
                Hashtags
                <Input value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="#shorts #ai" className="mt-1" />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => void act("meta", () => saveSocialMetaAction({ projectId, title, description, tags, hashtags }))}
                >
                  {busy === "meta" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  LƯU METADATA
                </Button>
                <CopyTextButton text={title || detail.title} label="COPY TITLE" />
                <CopyTextButton text={description} label="COPY DESCRIPTION" />
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-ink-200">Thumbnail</h3>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="neutral">
                  {detail.thumbnail.mode === "DEFAULT"
                    ? "Mặc định (khung hình từ video)"
                    : detail.thumbnail.mode === "SCENE"
                      ? `Cảnh ${detail.thumbnail.sceneNumber}`
                      : "Ảnh tải lên"}
                </Badge>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act("thumb", () => setThumbnailAction(projectId, "DEFAULT"))}>
                  Dùng mặc định
                </Button>
                <label className="cursor-pointer rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-300 hover:border-brand-500">
                  Tải ảnh riêng
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.currentTarget.files?.[0];
                      if (!f) return;
                      const form = new FormData();
                      form.append("projectId", projectId);
                      form.append("file", f);
                      void act("upload", () => uploadThumbnailAction(form));
                    }}
                  />
                </label>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {detail.scenes
                  .filter((s) => s.imagePath)
                  .map((s) => (
                    <button
                      key={s.sceneNumber}
                      type="button"
                      onClick={() => void act("thumb", () => setThumbnailAction(projectId, "SCENE", s.sceneNumber))}
                      className={`shrink-0 rounded border ${
                        detail.thumbnail.mode === "SCENE" && detail.thumbnail.sceneNumber === s.sceneNumber ? "border-brand-500" : "border-ink-700"
                      }`}
                      title={`Dùng cảnh ${s.sceneNumber}`}
                    >
                      <img src={`/api/media/${s.imagePath}`} alt={`cảnh ${s.sceneNumber}`} className="h-20 w-12 object-cover" loading="lazy" />
                    </button>
                  ))}
              </div>
              <p className="text-[11px] text-ink-500">Cắt khung tại máy (FFmpeg), không gọi Image API. Áp dụng khi XUẤT LẠI.</p>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-ink-200">
                Vùng an toàn · {detail.preset.name} ({detail.preset.width}x{detail.preset.height}, phụ đề {detail.preset.subtitleMode})
              </h3>
              {detail.aspectNote ? <Alert tone="warn">{detail.aspectNote}</Alert> : null}
              {zones ? (
                <div className="flex gap-4">
                  <div className="relative h-64 w-36 shrink-0 overflow-hidden rounded bg-ink-800">
                    {thumbSrc ? <img src={thumbSrc} alt="" className="h-full w-full object-cover" /> : null}
                    {overlay ? (
                      <>
                        <div className="absolute inset-x-0 top-0 bg-danger-500/30" style={{ height: `${zones.top * 100}%` }} />
                        <div className="absolute inset-x-0 bottom-0 bg-danger-500/30" style={{ height: `${zones.bottom * 100}%` }} />
                        <div className="absolute right-0 bg-warn-500/30" style={{ width: `${zones.right * 100}%`, top: "40%", bottom: `${zones.bottom * 100}%` }} />
                        <div
                          className="absolute inset-x-[7.5%] border border-dashed border-accent-500"
                          style={{ bottom: "20%", height: "10%" }}
                          title="Vùng phụ đề in lên video"
                        />
                      </>
                    ) : null}
                  </div>
                  <div className="space-y-1 text-xs">
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
                      Hiện vùng bị che (gần đúng)
                    </label>
                    {detail.safeArea.warnings.length === 0 ? (
                      <p className="text-ok-500">Phụ đề nằm ngoài vùng bị che.</p>
                    ) : (
                      <ul className="list-inside list-disc text-warn-500">
                        {detail.safeArea.warnings.map((w) => (
                          <li key={w.zone}>{w.message}</li>
                        ))}
                      </ul>
                    )}
                    <p className="text-[11px] text-ink-500">Chỉ cảnh báo — không tự sửa nội dung.</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-ink-500">Preset này không có vùng an toàn riêng (video ngang).</p>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-ink-200">Sẵn sàng đăng</h3>
              {detail.exportReady ? (
                <>
                  <Badge tone={detail.exportReady.ready ? "ok" : "danger"}>
                    {detail.exportReady.ready ? "READY TO PUBLISH" : "CHƯA SẴN SÀNG"}
                  </Badge>
                  <ul className="space-y-0.5 text-xs">
                    {detail.exportReady.checks.map((c) => (
                      <li key={c.id} className={c.ok ? "text-ok-500" : c.required ? "text-danger-500" : "text-warn-500"}>
                        {c.ok ? "✓" : c.required ? "✗" : "!"} {c.label} — <span className="text-ink-400">{c.detail}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-ink-500">Chưa kiểm tra (video chưa xuất).</p>
              )}
              {detail.output ? (
                <p className="break-all font-mono text-[11px] text-ink-500">
                  {detail.output.dir} — {detail.output.files.join(", ")}
                </p>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null || !detail.output}
                onClick={() => void act("export", () => exportSelectedAction(batchId, [projectId]))}
              >
                {busy === "export" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                XUẤT LẠI (tại máy, $0)
              </Button>
            </section>
            {message ? <Alert tone={message.ok ? "ok" : "danger"}>{message.text}</Alert> : null}
          </div>
        )}
      </div>
    </div>
  );
}
