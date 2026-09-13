"use client";

import { Card, CardContent, Field, Input, Select, Textarea } from "@/components/ui";
import {
  ActionButton,
  ActionForm,
  Disclosure,
} from "@/components/action-ui";
import {
  deleteCharacter,
  saveCharacter,
  toggleCharacter,
} from "@/app/actions/config";

const VOICE_OPTIONS = [
  { id: "mock-male-us", label: "Max (US, nam)" },
  { id: "mock-female-us", label: "Mia (US, nữ)" },
  { id: "mock-male-uk", label: "Leo (UK, nam)" },
  { id: "mock-female-uk", label: "Ella (UK, nữ)" },
];

interface CharacterData {
  id: string;
  name: string;
  description: string;
  personality: string;
  visualPrompt: string;
  negativePrompt: string;
  voiceId: string;
  notes: string;
  enabled: boolean;
  seed: number | null;
}

function CharacterFields({ character }: { character?: CharacterData }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tên nhân vật">
          <Input name="name" defaultValue={character?.name} required />
        </Field>
        <Field label="Giọng đọc">
          <Select name="voiceId" defaultValue={character?.voiceId ?? "mock-male-us"}>
            {VOICE_OPTIONS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Mô tả ngắn">
        <Input name="description" defaultValue={character?.description} />
      </Field>
      <Field label="Tính cách (tiếng Anh, dùng cho kịch bản)">
        <Textarea
          name="personality"
          rows={2}
          defaultValue={character?.personality}
        />
      </Field>
      <Field
        label="Mô tả ngoại hình (visual prompt)"
        hint="Cố định và chi tiết: tóc, màu da, trang phục, tỉ lệ. Được chèn vào mọi prompt."
      >
        <Textarea
          name="visualPrompt"
          rows={4}
          className="font-mono text-[11px]"
          defaultValue={character?.visualPrompt}
          required
        />
      </Field>
      <Field
        label="Prompt phủ định"
        hint="Những thứ cần tránh: đổi màu tóc, tay dị dạng, ảnh chụp thật..."
      >
        <Textarea
          name="negativePrompt"
          rows={2}
          className="font-mono text-[11px]"
          defaultValue={character?.negativePrompt}
        />
      </Field>
      <Field label="Ghi chú">
        <Input name="notes" defaultValue={character?.notes} />
      </Field>
    </div>
  );
}

export function CharacterEditor({ character }: { character: CharacterData }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5 text-xs">
        <div className="rounded-md border border-ink-800 bg-ink-850 p-2.5 font-mono text-[11px] text-ink-400">
          {character.visualPrompt}
        </div>
        {character.seed !== null ? (
          <p className="text-[11px] text-ink-500">
            Seed cố định: {character.seed}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <ActionButton
          size="sm"
          variant={character.enabled ? "outline" : "primary"}
          action={() => toggleCharacter(character.id, !character.enabled)}
        >
          {character.enabled ? "Tắt nhân vật" : "Bật nhân vật"}
        </ActionButton>
        <ActionButton
          size="sm"
          variant="danger"
          action={() => deleteCharacter(character.id)}
          confirm={`Xoá nhân vật "${character.name}"?`}
        >
          Xoá
        </ActionButton>
      </div>

      <Disclosure label="Chỉnh sửa">
        <ActionForm
          action={(formData) => saveCharacter(character.id, formData)}
          submitLabel="Lưu nhân vật"
        >
          <CharacterFields character={character} />
        </ActionForm>
      </Disclosure>
    </div>
  );
}

export function NewCharacterButton() {
  return (
    <Disclosure label="+ Thêm nhân vật">
      <Card>
        <CardContent>
          <ActionForm
            action={(formData) => saveCharacter(null, formData)}
            submitLabel="Tạo nhân vật"
            resetOnSuccess
          >
            <CharacterFields />
          </ActionForm>
        </CardContent>
      </Card>
    </Disclosure>
  );
}
