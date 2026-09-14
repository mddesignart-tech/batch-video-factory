"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-ui";
import { Alert, Badge, Button, Field, Input, Label, Select, Textarea } from "@/components/ui";
import { previewVoice, saveCharacterVoice } from "@/app/actions/characters";

/**
 * Everything about how a character sounds, editable.
 *
 * Provider, model and voice are text inputs with datalist suggestions rather
 * than fixed dropdowns. A hard-coded list would mean adding ElevenLabs later
 * needs a code change here, and the whole point of the provider abstraction is
 * that it does not.
 *
 * Preview is a real paid call, so it is a separate deliberate button with its
 * cost stated - never something that fires while someone is typing.
 */

export interface VoiceFields {
  voiceProvider: string;
  voiceModel: string;
  voiceId: string;
  voiceInstructions: string;
  voiceSpeed: number;
  voiceGender: string;
  voiceAccent: string;
}

/** OpenAI's voices, offered as suggestions, not as a closed list. */
const VOICE_SUGGESTIONS = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
];

export function CharacterVoiceForm({
  characterId,
  characterName,
  voice,
  mockMode,
}: {
  characterId: string;
  characterName: string;
  voice: VoiceFields;
  mockMode: boolean;
}) {
  const [sample, setSample] = useState(
    `Hi, I'm ${characterName}. Let me spill the beans about this idiom.`,
  );
  const [preview, setPreview] = useState<{
    ok: boolean;
    message: string;
    audioPath?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function runPreview() {
    setBusy(true);
    setPreview(null);
    try {
      const result = await previewVoice(characterId, sample);
      setPreview({
        ok: result.ok,
        message: result.message,
        audioPath: result.audioPath,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-ink-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <Label>Giọng nói</Label>
        <Badge tone={mockMode ? "neutral" : "warn"}>
          {mockMode ? "Mock — miễn phí" : "Thật — có tính phí"}
        </Badge>
      </div>

      <p className="mb-3 text-[11px] text-ink-400">
        Không có giá trị nào bị khoá cứng trong mã. Đổi nhà cung cấp ở đây là đủ —
        không cần sửa code. Phần <em>Hướng dẫn diễn</em> là thứ biến giọng máy
        đọc thành giọng <em>diễn</em>; model nào không hỗ trợ thì bỏ qua nó.
      </p>

      <ActionForm
        action={(formData) => saveCharacterVoice(characterId, formData)}
        submitLabel="Lưu cấu hình giọng"
        submitVariant="secondary"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Nhà cung cấp" hint="ví dụ: openai, mock">
            <Input
              name="voiceProvider"
              defaultValue={voice.voiceProvider}
              list="voice-providers"
            />
            <datalist id="voice-providers">
              <option value="openai" />
              <option value="mock" />
            </datalist>
          </Field>

          <Field label="Model" hint="phải có trong bảng Mô hình AI và đã bật">
            <Input
              name="voiceModel"
              defaultValue={voice.voiceModel}
              list="voice-models"
            />
            <datalist id="voice-models">
              <option value="gpt-4o-mini-tts" />
              <option value="mock-voice-std" />
            </datalist>
          </Field>

          <Field label="Giọng" hint="tên giọng của nhà cung cấp">
            <Input name="voiceId" defaultValue={voice.voiceId} list="voice-ids" />
            <datalist id="voice-ids">
              {VOICE_SUGGESTIONS.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </Field>

          <Field
            label="Tốc độ đọc"
            hint="0.25–4.0. Để 1 trừ khi câu thoại không vừa thời lượng cảnh."
          >
            <Input
              name="voiceSpeed"
              type="number"
              step="0.05"
              min="0.25"
              max="4"
              defaultValue={String(voice.voiceSpeed)}
            />
          </Field>

          <Field label="Giới tính" hint="dùng khi định tuyến chọn giọng thay thế">
            <Select name="voiceGender" defaultValue={voice.voiceGender}>
              <option value="male">Nam</option>
              <option value="female">Nữ</option>
            </Select>
          </Field>

          <Field label="Giọng vùng">
            <Select name="voiceAccent" defaultValue={voice.voiceAccent}>
              <option value="US">Mỹ</option>
              <option value="UK">Anh</option>
            </Select>
          </Field>
        </div>

        <Field
          label="Hướng dẫn diễn"
          hint="Viết bằng tiếng Anh. Mô tả cách nói, không phải nội dung nói."
        >
          <Textarea
            name="voiceInstructions"
            rows={4}
            defaultValue={voice.voiceInstructions}
          />
        </Field>
      </ActionForm>

      {/* Preview is deliberately outside the save form: it spends money, and a
          button that spends money must never be the same button as "save". */}
      <div className="mt-3 border-t border-ink-800 pt-3">
        <Label>Nghe thử</Label>
        <p className="mb-2 text-[11px] text-ink-400">
          {mockMode
            ? "Đang ở Mock Mode nên bản nghe thử là âm thanh giả, miễn phí."
            : "Đây là lệnh gọi API THẬT. Câu ngắn nên rất rẻ, nhưng vẫn được ghi vào sổ chi phí."}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            maxLength={300}
            placeholder="Câu muốn nghe thử"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => void runPreview()}
            disabled={busy || sample.trim().length === 0}
          >
            {busy ? "Đang tạo..." : "Nghe thử"}
          </Button>
        </div>

        {preview && (
          <div className="mt-2">
            <Alert tone={preview.ok ? "ok" : "danger"}>{preview.message}</Alert>
            {preview.ok && preview.audioPath && (
              <audio
                className="mt-2 w-full"
                controls
                src={`/api/media/${preview.audioPath.split(/[\\/]/).join("/")}`}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
