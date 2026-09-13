"use client";

import { Card, CardContent, Field, Input, Select, Textarea } from "@/components/ui";
import { ActionButton, ActionForm, Disclosure } from "@/components/action-ui";
import {
  deleteStylePreset,
  saveStylePreset,
  setDefaultPreset,
} from "@/app/actions/config";

interface PresetData {
  id: string;
  name: string;
  positivePrompt: string;
  negativePrompt: string;
  lightingStyle: string;
  cameraLanguage: string;
  visualTone: string;
  aspectRatio: string;
  isDefault: boolean;
}

function PresetFields({ preset }: { preset?: PresetData }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tên phong cách">
          <Input name="name" defaultValue={preset?.name} required />
        </Field>
        <Field label="Tỉ lệ khung hình">
          <Select name="aspectRatio" defaultValue={preset?.aspectRatio ?? "9:16"}>
            <option value="9:16">9:16 (Shorts / TikTok / Reels)</option>
            <option value="1:1">1:1 (vuông)</option>
            <option value="4:5">4:5 (feed dọc)</option>
            <option value="16:9">16:9 (ngang)</option>
          </Select>
        </Field>
      </div>
      <Field label="Prompt chính">
        <Textarea
          name="positivePrompt"
          rows={3}
          className="font-mono text-[11px]"
          defaultValue={preset?.positivePrompt}
          required
        />
      </Field>
      <Field label="Prompt phủ định">
        <Textarea
          name="negativePrompt"
          rows={2}
          className="font-mono text-[11px]"
          defaultValue={preset?.negativePrompt}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ánh sáng">
          <Input name="lightingStyle" defaultValue={preset?.lightingStyle} />
        </Field>
        <Field label="Ngôn ngữ máy quay">
          <Input name="cameraLanguage" defaultValue={preset?.cameraLanguage} />
        </Field>
      </div>
      <Field label="Tông màu / cảm xúc">
        <Input name="visualTone" defaultValue={preset?.visualTone} />
      </Field>
    </div>
  );
}

export function PresetEditor({ preset }: { preset: PresetData }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-ink-800 bg-ink-850 p-2.5 font-mono text-[11px] text-ink-400">
        {preset.positivePrompt}
      </div>
      <div className="space-y-0.5 text-[11px] text-ink-500">
        <p>Ánh sáng: {preset.lightingStyle}</p>
        <p>Máy quay: {preset.cameraLanguage}</p>
        <p>Tông: {preset.visualTone}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {!preset.isDefault ? (
          <ActionButton
            size="sm"
            variant="outline"
            action={() => setDefaultPreset(preset.id)}
          >
            Đặt làm mặc định
          </ActionButton>
        ) : null}
        <ActionButton
          size="sm"
          variant="danger"
          action={() => deleteStylePreset(preset.id)}
          confirm={`Xoá phong cách "${preset.name}"?`}
        >
          Xoá
        </ActionButton>
      </div>

      <Disclosure label="Chỉnh sửa">
        <ActionForm
          action={(formData) => saveStylePreset(preset.id, formData)}
          submitLabel="Lưu phong cách"
        >
          <PresetFields preset={preset} />
        </ActionForm>
      </Disclosure>
    </div>
  );
}

export function NewPresetButton() {
  return (
    <Disclosure label="+ Thêm phong cách">
      <Card>
        <CardContent>
          <ActionForm
            action={(formData) => saveStylePreset(null, formData)}
            submitLabel="Tạo phong cách"
            resetOnSuccess
          >
            <PresetFields />
          </ActionForm>
        </CardContent>
      </Card>
    </Disclosure>
  );
}
