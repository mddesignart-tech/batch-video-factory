"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { FrameShape, PlatformPicker } from "@/components/platform-picker";
import { adoptNewAssetShape, changeProjectFormat, getReshapeEstimate } from "@/app/actions/projects";
import { aspectOf, generationAspectFor, VI_FIT_MODE, type OutputProfile } from "@/domain/platform-profile";
import type { ProjectFormat } from "@/services/output-profile";

/**
 * "Định dạng video" on the project page (QĐ-121): Nền tảng / Khung hình /
 * Đầu ra, and "Đổi định dạng". Changing the format never buys anything: made
 * pictures and clips are kept and fitted locally. Re-making them in the new
 * shape is its own button, priced first, and only changes what the NEXT run
 * would make (which then asks for approval).
 */
export function VideoFormatCard({ format }: { format: ProjectFormat }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<OutputProfile>>(format.profile);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [estimate, setEstimate] = useState<{ image: number; video: number; images: number; clips: number } | null>(null);

  const p = format.profile;
  const draftAspect = draft.width && draft.height ? aspectOf(draft.width, draft.height) : format.outputAspect;
  const shapeChanges = draftAspect !== format.outputAspect;
  const fine = (n: number) => `~$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

  async function save() {
    setBusy(true);
    try {
      const r = await changeProjectFormat(format.projectId, draft);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) {
        setEditing(false);
        setConfirming(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function priceReshape() {
    setBusy(true);
    try {
      const r = await getReshapeEstimate(format.projectId);
      if (r.ok) setEstimate(r.estimate);
      else setMessage({ ok: false, text: r.message });
    } finally {
      setBusy(false);
    }
  }

  async function adopt() {
    setBusy(true);
    try {
      const r = await adoptNewAssetShape(format.projectId);
      setMessage({ ok: r.ok, text: r.message });
      setEstimate(null);
      if (r.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const assetsOtherShape = format.hasVisualAssets && format.assetAspect !== format.outputAspect;

  return (
    <Card id="dinh-dang-video">
      <CardHeader>
        <CardTitle>Định dạng video</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex items-center gap-3">
          <span className="text-ink-300">
            <FrameShape width={p.width} height={p.height} size={40} />
          </span>
          <div className="space-y-0.5">
            <p className="text-ink-400">
              Nền tảng <strong className="ml-1 text-ink-100">{format.platformLabel}</strong>
            </p>
            <p className="text-ink-400">
              Khung hình <strong className="ml-1 text-ink-100">{format.outputAspect}</strong>
            </p>
            <p className="text-ink-400">
              Đầu ra <strong className="ml-1 text-ink-100">{p.width} × {p.height}</strong>
            </p>
            <p className="text-ink-500">{format.hint}</p>
          </div>
        </div>
        {format.profile.fit !== "AUTO" ? <p className="text-ink-500">Khớp khung: {VI_FIT_MODE[format.profile.fit]}</p> : null}
        {format.note ? <p className="text-ink-500">{format.note}</p> : null}

        {editing ? (
          <div className="space-y-3">
            <PlatformPicker initial={format.profile} showFitAndSubtitles formNames={false} onChange={setDraft} />
            {confirming ? (
              <Alert tone="warn" title="Bạn đang đổi tỷ lệ video.">
                Các ảnh/video đã tạo vẫn được giữ lại và sẽ được crop/fit lại. Không phát sinh phí API lúc này.
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    ĐỔI TỶ LỆ
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                    HỦY
                  </Button>
                </div>
              </Alert>
            ) : (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => (shapeChanges && format.hasVisualAssets ? setConfirming(true) : void save())}
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Lưu định dạng
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                  Huỷ
                </Button>
              </div>
            )}
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(format.profile);
              setEditing(true);
            }}
          >
            Đổi định dạng
          </Button>
        )}

        {assetsOtherShape ? (
          <div className="space-y-1.5 border-t border-ink-800 pt-2">
            <p className="text-ink-400">
              Ảnh/clip hiện được tạo cho khung {format.assetAspect} và được khớp vào {format.outputAspect} khi render ($0).
            </p>
            {estimate ? (
              <div className="space-y-1 rounded-md border border-warn-500/40 bg-warn-500/10 p-2">
                <p>Tạo lại ảnh: {fine(estimate.image)} ({estimate.images} ảnh AI; ảnh nhập giữ nguyên)</p>
                <p>Tạo lại Video AI: {fine(estimate.video)} ({estimate.clips} clip)</p>
                <p className="text-ink-400">
                  Bấm xác nhận chỉ đổi khung tạo ảnh/clip sang {generationAspectFor(p.width, p.height)}. Chưa gửi request nào —
                  lần chạy tới sẽ hiện chi phí và cần bạn duyệt.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void adopt()}>
                    Xác nhận tạo lại theo tỷ lệ mới
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEstimate(null)}>
                    Huỷ
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void priceReshape()}>
                Tạo lại asset theo tỷ lệ mới…
              </Button>
            )}
          </div>
        ) : null}

        {message ? <p className={message.ok ? "text-ok-500" : "text-danger-500"}>{message.text}</p> : null}
      </CardContent>
    </Card>
  );
}
