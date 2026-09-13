"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import {
  ActionButton,
  ActionFeedback,
  ActionForm,
  Disclosure,
  type ActionResult,
} from "@/components/action-ui";
import { deleteModel, saveModel, toggleModel } from "@/app/actions/config";
import { MODEL_TYPES, PRICE_UNITS } from "@/domain/enums";

interface ModelData {
  id: string;
  provider: string;
  modelId: string;
  displayName: string;
  type: string;
  price: number;
  priceOutput: number;
  priceUnit: string;
  enabled: boolean;
  maxDuration: number;
  qualityRating: number;
  speedRating: number;
  consistencyRating: number;
  notes: string;
  supportsTextToVideo: boolean;
  supportsImageToVideo: boolean;
  supportsReferenceImage: boolean;
  supportsCharacterReference: boolean;
  supports1080p: boolean;
  supportsUpscale: boolean;
}

const CAPABILITY_FIELDS = [
  { name: "supportsTextToVideo", label: "Text → Video" },
  { name: "supportsImageToVideo", label: "Image → Video" },
  { name: "supportsReferenceImage", label: "Ảnh tham chiếu" },
  { name: "supportsCharacterReference", label: "Tham chiếu nhân vật" },
  { name: "supports1080p", label: "Hỗ trợ 1080p" },
  { name: "supportsUpscale", label: "Nâng phân giải" },
] as const;

function ModelFields({
  model,
  providers,
}: {
  model?: ModelData;
  providers: { name: string; displayName: string }[];
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nhà cung cấp">
          <Select name="provider" defaultValue={model?.provider ?? "mock"}>
            {providers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Loại">
          <Select name="type" defaultValue={model?.type ?? "video"}>
            {MODEL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Mã mô hình (model id)">
          <Input name="modelId" defaultValue={model?.modelId} required />
        </Field>
        <Field label="Tên hiển thị">
          <Input name="displayName" defaultValue={model?.displayName} required />
        </Field>
        <Field
          label="Giá input (USD)"
          hint="Với model text: giá cho 1k token ĐẦU VÀO. Nhập đúng theo bảng giá nhà cung cấp."
        >
          <Input
            name="price"
            type="number"
            min={0}
            step="0.0001"
            defaultValue={model?.price ?? 0}
          />
        </Field>
        <Field
          label="Giá output (USD)"
          hint="Chỉ dùng cho model text: giá cho 1k token ĐẦU RA, thường đắt hơn input. Loại khác để 0."
        >
          <Input
            name="priceOutput"
            type="number"
            min={0}
            step="0.0001"
            defaultValue={model?.priceOutput ?? 0}
          />
        </Field>
        <Field label="Đơn vị tính giá">
          <Select name="priceUnit" defaultValue={model?.priceUnit ?? "per_second"}>
            {PRICE_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Thời lượng tối đa (giây, 0 = không áp dụng)">
          <Input
            name="maxDuration"
            type="number"
            min={0}
            max={120}
            defaultValue={model?.maxDuration ?? 0}
          />
        </Field>
        <Field label="Điểm chất lượng (1-10)">
          <Input
            name="qualityRating"
            type="number"
            min={1}
            max={10}
            defaultValue={model?.qualityRating ?? 5}
          />
        </Field>
        <Field label="Điểm nhất quán nhân vật (1-10)">
          <Input
            name="consistencyRating"
            type="number"
            min={1}
            max={10}
            defaultValue={model?.consistencyRating ?? 5}
          />
        </Field>
        <Field label="Điểm tốc độ (1-10)">
          <Input
            name="speedRating"
            type="number"
            min={1}
            max={10}
            defaultValue={model?.speedRating ?? 5}
          />
        </Field>
      </div>

      <Field label="Năng lực">
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {CAPABILITY_FIELDS.map((cap) => (
            <label
              key={cap.name}
              className="flex items-center gap-2 text-xs text-ink-300"
            >
              <input
                type="checkbox"
                name={cap.name}
                defaultChecked={model?.[cap.name] ?? false}
                className="h-3.5 w-3.5"
              />
              {cap.label}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Ghi chú">
        <Textarea name="notes" rows={2} defaultValue={model?.notes} />
      </Field>

      <label className="flex items-center gap-2 text-xs text-ink-300">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={model?.enabled ?? false}
          className="h-3.5 w-3.5"
        />
        Bật mô hình này cho AI Router
      </label>
    </div>
  );
}

export function ModelRow({
  model,
  providers,
}: {
  model: ModelData;
  providers: { name: string; displayName: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <ActionButton
          size="sm"
          variant="ghost"
          action={() => toggleModel(model.id, !model.enabled)}
          onDone={setResult}
        >
          {model.enabled ? "Tắt" : "Bật"}
        </ActionButton>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>

      {result && !result.ok ? (
        <p className="max-w-64 text-right text-[11px] text-danger-500">
          {result.message}
        </p>
      ) : null}

      {open ? (
        <div className="mt-2 w-[560px] max-w-[80vw] rounded-lg border border-ink-700 bg-ink-900 p-4 text-left">
          <ActionForm
            action={(formData) => saveModel(model.id, formData)}
            submitLabel="Lưu mô hình"
          >
            <ModelFields model={model} providers={providers} />
          </ActionForm>
          <div className="mt-3 border-t border-ink-800 pt-3">
            <ActionButton
              size="sm"
              variant="danger"
              action={() => deleteModel(model.id)}
              confirm={`Xoá mô hình "${model.displayName}"?`}
            >
              Xoá mô hình
            </ActionButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function NewModelButton({
  providers,
}: {
  providers: { name: string; displayName: string }[];
}) {
  return (
    <Disclosure label="+ Thêm mô hình">
      <Card>
        <CardContent>
          <ActionForm
            action={(formData) => saveModel(null, formData)}
            submitLabel="Tạo mô hình"
            resetOnSuccess
          >
            <ModelFields providers={providers} />
          </ActionForm>
          <div className="mt-3">
            <ActionFeedback result={null} />
          </div>
        </CardContent>
      </Card>
    </Disclosure>
  );
}
