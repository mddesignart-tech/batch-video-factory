"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  Layers,
  Loader2,
  RefreshCw,
  Star,
  X,
} from "lucide-react";
import { ActionFeedback, type ActionResult } from "@/components/action-ui";
import { Alert, Badge, Button, Field, Select, Textarea } from "@/components/ui";
import {
  approveSceneImage,
  generateAlternative,
  listSceneCandidates,
  previewSceneImage,
  promoteSceneImageToReference,
  regenerateSceneImageNow,
  selectSceneCandidate,
  type ImageCandidate,
  type SceneImagePreview,
} from "@/app/actions/images";

/**
 * Scene image review.
 *
 * Nothing here starts video generation. That separation is deliberate: video
 * costs an order of magnitude more than an image, so an image must be looked
 * at and accepted by a human before anything downstream of it runs.
 */

export interface ImageModelChoice {
  provider: string;
  modelId: string;
  displayName: string;
  price: number;
  enabled: boolean;
}

export function ImageReview({
  sceneId,
  sceneNumber,
  imagePath,
  imageProvider,
  imageModel,
  approved,
  characters,
  models,
  allowsAlternative,
}: {
  sceneId: string;
  sceneNumber: number;
  imagePath: string | null;
  imageProvider: string | null;
  imageModel: string | null;
  approved: boolean;
  characters: { id: string; name: string }[];
  models: ImageModelChoice[];
  /** QUALITY and CUSTOM offer a second option; cheaper modes do not. */
  allowsAlternative: boolean;
}) {
  const router = useRouter();
  const [preview, setPreview] = React.useState<SceneImagePreview | null>(null);
  const [selected, setSelected] = React.useState(imageModel ?? "");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<ActionResult | null>(null);
  const [large, setLarge] = React.useState(false);
  const [candidates, setCandidates] = React.useState<ImageCandidate[] | null>(null);

  // A model switch changes both the price and the prompt preview, so the stale
  // figures must go rather than sit there looking authoritative.
  React.useEffect(() => {
    setPreview(null);
  }, [selected]);

  async function loadPreview() {
    setLoading(true);
    setResult(null);
    setPreview(await previewSceneImage(sceneId, selected || undefined));
    setLoading(false);
  }

  async function run() {
    setLoading(true);
    const res = await regenerateSceneImageNow(sceneId, selected || undefined);
    setResult(res);
    setLoading(false);
    setPreview(null);
    if (res.ok) router.refresh();
  }

  async function act(fn: () => Promise<ActionResult>) {
    setLoading(true);
    const res = await fn();
    setResult(res);
    setLoading(false);
    if (res.ok) router.refresh();
  }

  async function loadCandidates() {
    setLoading(true);
    setCandidates(await listSceneCandidates(sceneId));
    setLoading(false);
  }

  async function drawAlternative() {
    setLoading(true);
    const res = await generateAlternative(sceneId, selected || undefined);
    setResult(res);
    if (res.ok) {
      setCandidates(await listSceneCandidates(sceneId));
      router.refresh();
    }
    setLoading(false);
  }

  const src = imagePath
    ? `/api/media/${imagePath.split(/[\\/]/).map(encodeURIComponent).join("/")}`
    : null;

  return (
    <div className="mt-4 rounded-lg border border-ink-800 bg-ink-850 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-ink-200">
          Duyệt ảnh cảnh {sceneNumber}
        </p>
        {imagePath ? (
          <Badge tone={approved ? "ok" : "warn"}>
            {approved ? "Đã duyệt" : "Chưa duyệt"}
          </Badge>
        ) : (
          <Badge tone="neutral">Chưa có ảnh</Badge>
        )}
      </div>

      {imageProvider ? (
        <p className="mb-2 text-[11px] text-ink-500">
          Tạo bằng{" "}
          <span className="font-mono text-ink-300">
            {imageProvider}/{imageModel}
          </span>
        </p>
      ) : null}

      <Field label="Model cho lần tạo tới">
        <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Để AI Router tự chọn</option>
          {models.map((m) => (
            <option key={`${m.provider}/${m.modelId}`} value={m.modelId}>
              {m.displayName} — ${m.price.toFixed(3)}/ảnh
              {m.enabled ? "" : " (đang tắt)"}
            </option>
          ))}
        </Select>
      </Field>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={loadPreview} disabled={loading}>
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Eye className="h-3 w-3" />
          )}
          Xem prompt và chi phí
        </Button>

        {src ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setLarge(true)}>
              <Eye className="h-3 w-3" />
              Xem ảnh lớn
            </Button>
            <Button
              size="sm"
              variant={approved ? "ghost" : "primary"}
              onClick={() => act(() => approveSceneImage(sceneId, !approved))}
              disabled={loading}
            >
              <Check className="h-3 w-3" />
              {approved ? "Bỏ duyệt" : "Duyệt ảnh"}
            </Button>
            {allowsAlternative ? (
              <Button
                size="sm"
                variant="outline"
                onClick={drawAlternative}
                disabled={loading}
              >
                <Copy className="h-3 w-3" />
                Tạo phương án khác
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={loadCandidates}
              disabled={loading}
            >
              <Layers className="h-3 w-3" />
              Các ảnh đã tạo
            </Button>
          </>
        ) : null}
      </div>

      {candidates ? (
        <div className="mt-3 rounded border border-ink-800 bg-ink-950/40 p-2">
          <p className="mb-2 text-[11px] text-ink-400">
            {candidates.length} ảnh đã tạo cho cảnh này. Chọn ảnh nào cũng miễn
            phí — mọi ảnh đều đã trả tiền rồi nên không bị mất.
          </p>
          <div className="flex flex-wrap gap-2">
            {candidates.map((c) => (
              <button
                key={c.assetId}
                type="button"
                disabled={loading || c.selected}
                onClick={() => act(() => selectSceneCandidate(sceneId, c.assetId))}
                className={`overflow-hidden rounded border ${
                  c.selected
                    ? "border-brand-400 ring-1 ring-brand-400"
                    : "border-ink-700 hover:border-ink-500"
                }`}
                title={`${c.provider}/${c.model} · $${c.actualCost.toFixed(6)} · ${c.createdAt}`}
              >
                <img
                  src={`/api/media/${c.filePath.split(/[\/]/).map(encodeURIComponent).join("/")}`}
                  alt={`Phương án cho cảnh ${sceneNumber}`}
                  className="h-24 w-16 object-cover"
                />
                <span className="block bg-ink-900 px-1 py-0.5 text-[9px] text-ink-400">
                  {c.selected ? "đang dùng" : "chọn"}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {src && characters.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {characters.map((c) => (
            <Button
              key={c.id}
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => act(() => promoteSceneImageToReference(sceneId, c.id))}
            >
              <Star className="h-3 w-3" />
              Lưu làm ảnh tham chiếu của {c.name}
            </Button>
          ))}
        </div>
      ) : null}

      {preview?.ok ? (
        <div className="mt-3 space-y-2 rounded border border-ink-800 bg-ink-950/40 p-3 text-[11px]">
          <div className="grid gap-2 sm:grid-cols-3">
            <Figure
              label={preview.mockMode ? "Giá giả lập" : "Chi phí ước tính"}
              value={`$${(preview.estimatedCost ?? 0).toFixed(4)}`}
            />
            <Figure
              label="Đã chi / hạn mức"
              value={`$${(preview.spent ?? 0).toFixed(4)} / $${(preview.cap ?? 0).toFixed(2)}`}
            />
            <Figure
              label="Ảnh tham chiếu gửi kèm"
              value={String(preview.referenceCount ?? 0)}
            />
          </div>

          {preview.policy ? (
            <p className="text-ink-500">{preview.policy}</p>
          ) : null}

          <div className="space-y-0.5 border-t border-ink-800 pt-2">
            <Row
              label="Trong khung hình"
              value={preview.charactersPresent?.join(", ") || "-"}
            />
            <Row
              label="Có thoại"
              value={preview.speakingCharacters?.join(", ") || "không ai"}
            />
            <Row
              label="Trọng tâm"
              value={preview.primaryCharacters?.join(", ") || "-"}
            />
          </div>

          {preview.repairedCharacters && preview.repairedCharacters.length > 0 ? (
            <Alert tone="warn">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Kịch bản nhắc tới {preview.repairedCharacters.join(", ")} nhưng
              không liệt kê họ trong khung hình. Đã tự bổ sung để họ được vẽ
              đúng mẫu. Nên tạo lại kịch bản để sửa tận gốc.
            </Alert>
          ) : null}

          {preview.droppedByLimit && preview.droppedByLimit.length > 0 ? (
            <Alert tone="warn">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Nhà cung cấp chỉ nhận một số ảnh tham chiếu nhất định, nên{" "}
              {preview.droppedByLimit.join(", ")} chỉ được mô tả bằng chữ trong
              cảnh này.
            </Alert>
          ) : null}

          {preview.referencedCharacters && preview.referencedCharacters.length > 0 ? (
            <p className="text-ok-500">
              Giữ nhất quán theo ảnh chuẩn của:{" "}
              {preview.referencedCharacters.join(", ")}
            </p>
          ) : null}

          {preview.missingReferences && preview.missingReferences.length > 0 ? (
            <Alert tone="warn">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              {preview.missingReferences.join(", ")} chưa có ảnh chuẩn. Ảnh cảnh
              sẽ chỉ dựa vào mô tả chữ nên dễ bị trôi hình. Tạo ảnh chuẩn ở trang
              Nhân vật trước sẽ cho kết quả ổn định hơn nhiều.
            </Alert>
          ) : null}

          <Field label="Prompt sẽ gửi">
            <Textarea
              rows={10}
              readOnly
              value={preview.prompt ?? ""}
              className="font-mono text-[10px]"
            />
          </Field>

          {preview.negativePrompt ? (
            <Field label="Prompt phủ định">
              <Textarea
                rows={3}
                readOnly
                value={preview.negativePrompt}
                className="font-mono text-[10px]"
              />
            </Field>
          ) : null}

          <Button size="sm" onClick={run} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {preview.mockMode
              ? "Tạo ảnh giả lập (miễn phí)"
              : `Tạo ảnh thật — trừ $${(preview.estimatedCost ?? 0).toFixed(4)}`}
          </Button>
        </div>
      ) : preview && !preview.ok ? (
        <Alert tone="danger" className="mt-3">
          {preview.message}
        </Alert>
      ) : null}

      {result ? (
        <div className="mt-3">
          <ActionFeedback result={result} />
        </div>
      ) : null}

      <p className="mt-3 border-t border-ink-800 pt-2 text-[10px] text-ink-500">
        Duyệt ảnh <strong>không</strong> tự động chuyển sang Video AI. Bước tạo
        video là một hành động riêng mà bạn phải tự bấm.
      </p>

      {large && src ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLarge(false)}
        >
          <div className="relative max-h-full overflow-auto">
            <img src={src} alt={`Cảnh ${sceneNumber}`} className="max-h-[85vh] rounded-lg" />
            <Button
              variant="secondary"
              className="absolute right-2 top-2"
              onClick={() => setLarge(false)}
            >
              <X className="h-3.5 w-3.5" />
              Đóng
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink-500">{label}</span>
      <span className="text-right text-ink-300">{value}</span>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-ink-500">{label}</p>
      <p className="font-mono text-ink-200">{value}</p>
    </div>
  );
}
