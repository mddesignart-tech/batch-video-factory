"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ImagePlus, Loader2, Sparkles, Star, Trash2, X } from "lucide-react";
import {
  ActionFeedback,
  ActionForm,
  ActionButtonWithFeedback,
  type ActionResult,
} from "@/components/action-ui";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  Label,
  Select,
  Textarea,
} from "@/components/ui";
import {
  approveReference,
  generateMaster,
  previewMaster,
  removeReference,
  uploadReference,
} from "@/app/actions/characters";

/**
 * Character reference images.
 *
 * The approval step is the point of this component. Generating a candidate is
 * cheap to undo; silently promoting it to "what this character looks like"
 * is not, because every later scene is drawn to match it. So generation and
 * approval are two separate buttons, and the primary image never changes on
 * its own.
 */

export interface ReferenceView {
  id: string;
  filePath: string;
  source: string;
  isPrimary: boolean;
  approved: boolean;
  provider: string;
  model: string;
  prompt: string;
  characterVersion: number;
  bytes: number;
  notes: string;
  createdAt: string;
}

export interface ImageModelOption {
  provider: string;
  modelId: string;
  displayName: string;
  price: number;
  enabled: boolean;
}

export function CharacterReferences({
  characterId,
  characterName,
  characterVersion,
  references,
  models,
  mockMode,
}: {
  characterId: string;
  characterName: string;
  characterVersion: number;
  references: ReferenceView[];
  models: ImageModelOption[];
  mockMode: boolean;
}) {
  const primary = references.find((r) => r.isPrimary);
  const others = references.filter((r) => !r.isPrimary);

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Star className="h-3.5 w-3.5 text-amber-500" />
          <Label>Ảnh chuẩn (Character Master)</Label>
        </div>
        {primary ? (
          <ReferenceCard reference={primary} characterName={characterName} />
        ) : (
          <Alert tone="warn">
            Chưa có ảnh chuẩn. Mọi cảnh sẽ chỉ dựa vào mô tả chữ, nên {characterName}{" "}
            có thể đổi mặt và trang phục giữa các cảnh. Hãy tải ảnh lên hoặc tạo
            ảnh chuẩn bên dưới.
          </Alert>
        )}
      </div>

      {others.length > 0 ? (
        <div>
          <Label className="mb-2 block">Ảnh khác ({others.length})</Label>
          <div className="grid gap-3 sm:grid-cols-2">
            {others.map((reference) => (
              <ReferenceCard
                key={reference.id}
                reference={reference}
                characterName={characterName}
              />
            ))}
          </div>
        </div>
      ) : null}

      <UploadForm characterId={characterId} />

      <GenerateMasterPanel
        characterId={characterId}
        characterName={characterName}
        characterVersion={characterVersion}
        models={models}
        mockMode={mockMode}
        hasPrimary={primary !== undefined}
      />
    </div>
  );
}

function ReferenceCard({
  reference,
  characterName,
}: {
  reference: ReferenceView;
  characterName: string;
}) {
  const [large, setLarge] = React.useState(false);
  const src = `/api/media/${reference.filePath.split(/[\\/]/).map(encodeURIComponent).join("/")}`;

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setLarge(true)}
          className="shrink-0 overflow-hidden rounded border border-ink-800"
          title="Xem ảnh lớn"
        >
          <img
            src={src}
            alt={`Ảnh tham chiếu của ${characterName}`}
            className="h-28 w-20 object-cover"
          />
        </button>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {reference.isPrimary ? (
              <Badge tone="ok">Ảnh chuẩn</Badge>
            ) : reference.approved ? (
              <Badge tone="neutral">Đã duyệt</Badge>
            ) : (
              <Badge tone="warn">Chờ duyệt</Badge>
            )}
            <Badge tone="neutral">
              {reference.source === "upload" ? "Tải lên" : "AI tạo"}
            </Badge>
            <Badge tone="neutral">v{reference.characterVersion}</Badge>
          </div>

          <p className="text-[11px] text-ink-400">
            {reference.provider
              ? `${reference.provider}/${reference.model} · `
              : ""}
            {(reference.bytes / 1024).toFixed(0)} KB · {reference.createdAt}
          </p>

          {reference.notes ? (
            <p className="text-[11px] text-ink-400">{reference.notes}</p>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            {!reference.isPrimary ? (
              <ActionButtonWithFeedback
                action={() => approveReference(reference.id)}
                variant="secondary"
                confirm={`Đặt ảnh này làm ảnh chuẩn của ${characterName}? Mọi cảnh tạo sau đó sẽ khớp theo ảnh này.`}
              >
                <Check className="h-3 w-3" />
                Đặt làm ảnh chuẩn
              </ActionButtonWithFeedback>
            ) : null}
            <ActionButtonWithFeedback
              action={() => removeReference(reference.id)}
              variant="ghost"
              confirm="Xoá ảnh tham chiếu này?"
            >
              <Trash2 className="h-3 w-3" />
              Xoá
            </ActionButtonWithFeedback>
          </div>
        </div>
      </div>

      {large ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLarge(false)}
        >
          <div className="relative max-h-full max-w-full overflow-auto">
            <img
              src={src}
              alt={`Ảnh tham chiếu của ${characterName}`}
              className="max-h-[85vh] rounded-lg"
            />
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

function UploadForm({ characterId }: { characterId: string }) {
  return (
    <ActionForm
      action={uploadReference}
      submitLabel="Tải ảnh lên"
      submitVariant="secondary"
      resetOnSuccess
      className="rounded-lg border border-ink-800 p-3"
    >
      <input type="hidden" name="characterId" value={characterId} />
      <div className="mb-2 flex items-center gap-2">
        <ImagePlus className="h-3.5 w-3.5 text-ink-400" />
        <Label>Tải ảnh tham chiếu có sẵn</Label>
      </div>
      <p className="mb-3 text-[11px] text-ink-400">
        Dùng khi bạn đã có sẵn hình nhân vật. PNG, JPG hoặc WEBP, tối đa 10 MB.
        Tệp được lưu trong thư mục <code>data/characters/</code> trên máy; cơ sở
        dữ liệu chỉ ghi đường dẫn.
      </p>
      <Field label="Tệp ảnh">
        <Input type="file" name="file" accept="image/png,image/jpeg,image/webp" required />
      </Field>
      <Field label="Ghi chú (tuỳ chọn)">
        <Input name="notes" placeholder="Ví dụ: bản vẽ tay, góc nghiêng" />
      </Field>
    </ActionForm>
  );
}

function GenerateMasterPanel({
  characterId,
  characterName,
  characterVersion,
  models,
  mockMode,
  hasPrimary,
}: {
  characterId: string;
  characterName: string;
  characterVersion: number;
  models: ImageModelOption[];
  mockMode: boolean;
  hasPrimary: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState(
    models.find((m) => m.enabled)?.modelId ?? models[0]?.modelId ?? "",
  );
  const [preview, setPreview] = React.useState<
    Awaited<ReturnType<typeof previewMaster>> | null
  >(null);
  const [prompt, setPrompt] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<ActionResult | null>(null);

  const model = models.find((m) => m.modelId === selected);

  async function loadPreview() {
    if (!model) return;
    setLoading(true);
    setResult(null);
    const res = await previewMaster(characterId, model.provider, model.modelId);
    setPreview(res);
    setPrompt(res.prompt ?? "");
    setLoading(false);
  }

  async function run() {
    if (!model) return;
    setLoading(true);
    const formData = new FormData();
    formData.set("characterId", characterId);
    formData.set("provider", model.provider);
    formData.set("model", model.modelId);
    formData.set("prompt", prompt);
    const res = await generateMaster(formData);
    setResult(res);
    setLoading(false);
    if (res.ok) {
      setPreview(null);
      router.refresh();
    }
  }

  if (models.length === 0) {
    return (
      <Alert tone="warn">
        Chưa có model ảnh nào trong bảng Mô hình AI. Thêm model và nhập giá trước
        khi tạo ảnh chuẩn.
      </Alert>
    );
  }

  return (
    <div className="rounded-lg border border-ink-800 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-ink-400" />
        <Label>Tạo ảnh chuẩn bằng AI</Label>
      </div>

      <p className="mb-3 text-[11px] text-ink-400">
        Ảnh được tạo từ mô tả ngoại hình đã lưu (phiên bản v{characterVersion}),
        ở tư thế trung tính trên nền trơn để làm mốc so sánh cho mọi cảnh.
        {hasPrimary
          ? " Ảnh chuẩn hiện tại sẽ KHÔNG bị thay tự động — ảnh mới chỉ là ứng viên chờ bạn duyệt."
          : ""}
      </p>

      <Field label="Model">
        <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {models.map((m) => (
            <option key={`${m.provider}/${m.modelId}`} value={m.modelId}>
              {m.displayName} — ${m.price.toFixed(3)}/ảnh
              {m.enabled ? "" : " (đang tắt)"}
            </option>
          ))}
        </Select>
      </Field>

      {mockMode ? (
        <Alert tone="info" className="mt-3">
          Đang ở Mock Mode: ảnh sẽ do trình giả lập vẽ, <strong>không tốn tiền</strong>.
          Đặt <code>AI_MOCK_MODE=false</code> trong <code>.env</code> để gọi API thật.
        </Alert>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={loadPreview} disabled={loading || !model}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Xem trước prompt và chi phí
        </Button>
      </div>

      {preview?.ok ? (
        <div className="mt-3 space-y-3 rounded border border-ink-800 bg-ink-950/40 p-3">
          <div className="grid gap-2 text-[11px] sm:grid-cols-3">
            <Figure label="Nhà cung cấp" value={`${model?.provider}/${model?.modelId}`} />
            <Figure
              label={preview.mockMode ? "Giá giả lập" : "Chi phí ước tính"}
              value={`$${(preview.estimatedCost ?? 0).toFixed(4)}`}
            />
            <Figure
              label="Đã chi / hạn mức"
              value={`$${(preview.spent ?? 0).toFixed(4)} / $${(preview.cap ?? 0).toFixed(2)}`}
            />
          </div>

          <Field label="Prompt sẽ gửi (có thể sửa)">
            <Textarea
              rows={8}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="font-mono text-[11px]"
            />
          </Field>

          <Button onClick={run} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
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

      <p className="mt-3 text-[11px] text-ink-400">
        Ảnh vừa tạo <strong>không</strong> tự động được dùng. Bấm “Đặt làm ảnh
        chuẩn” ở ảnh bạn ưng nhất — {characterName} sẽ được vẽ khớp theo ảnh đó
        trong mọi cảnh sau này.
      </p>
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
