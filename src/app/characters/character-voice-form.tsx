"use client";

import { useEffect, useMemo, useState } from "react";
import { ActionButton, ActionForm } from "@/components/action-ui";
import { Alert, Badge, Button, Field, Input, Label, Select, Textarea } from "@/components/ui";
import {
  previewVoiceChoice,
  removeCharacterVoiceProfile,
  saveCharacterVoice,
  voiceCatalogAction,
} from "@/app/actions/characters";
import { mindStartAction } from "@/app/actions/mind-voice";
import { VOICE_LOCALES, VOICE_PROFILE_STALE, voiceLocaleOf, type VoiceLocaleId } from "@/domain/voice-locale";
import type { CatalogModel, CatalogVoice, VoiceCatalog } from "@/services/voice-catalog";

/**
 * NHÂN VẬT → GIỌNG NÓI (QĐ-158).
 *
 * Language → provider / model → voice → listen → save. Every list comes from
 * the Voice Catalog (what the engine really has); nothing is typed by hand, and
 * a voice the chosen model does not have cannot be saved. A character can have
 * one voice per language; the main one is used when a line's language is not
 * otherwise known.
 *
 * Listening to a local voice (Mind Voice) is $0. A paid voice states its price
 * and is sent only after the person confirms that exact price.
 */

export interface SavedVoiceProfile {
  locale: VoiceLocaleId;
  provider: string;
  model: string;
  voiceId: string;
  speed: number;
  instructions: string;
  primary: boolean;
}

export interface LegacyVoice {
  provider: string;
  model: string;
  voiceId: string;
  speed: number;
  instructions: string;
}

const REGION_LABEL = { north: "miền Bắc", central: "miền Trung", south: "miền Nam" } as const;
const STYLE_LABEL: Record<string, string> = { natural: "tự nhiên", storytelling: "kể chuyện", news: "tin tức" };
const STATUS_TONE: Record<CatalogModel["status"], "ok" | "warn" | "danger" | "neutral" | "info"> = {
  ONLINE: "ok",
  OFFLINE: "warn",
  NOT_INSTALLED: "danger",
  NO_KEY: "danger",
  DISABLED: "danger",
  MOCK: "neutral",
};
const STATUS_LABEL: Record<CatalogModel["status"], string> = {
  ONLINE: "Online",
  OFFLINE: "Offline",
  NOT_INSTALLED: "Chưa cài model",
  NO_KEY: "Chưa có key",
  DISABLED: "Đang tắt",
  MOCK: "Giả lập",
};

const keyOf = (m: Pick<CatalogModel, "provider" | "model">) => `${m.provider}::${m.model}`;

function voiceLabel(v: CatalogVoice): string {
  const bits = [
    v.gender ? (v.gender === "female" ? "Nữ" : "Nam") + (v.genderVerified ? "" : " (chưa xác minh)") : null,
    v.region ? REGION_LABEL[v.region] : null,
    v.style ? (STYLE_LABEL[v.style] ?? v.style) : null,
  ].filter(Boolean);
  return bits.length ? `${v.label} · ${bits.join(" · ")}` : v.label;
}

export function CharacterVoiceForm({
  characterId,
  characterName,
  isNarrator,
  mockMode,
  profiles,
  legacy,
  issues,
}: {
  characterId: string;
  characterName: string;
  isNarrator: boolean;
  mockMode: boolean;
  profiles: SavedVoiceProfile[];
  /** The voice saved before languages existed (null once a language is chosen). */
  legacy: LegacyVoice | null;
  issues: { locale: VoiceLocaleId | null; detail: string }[];
}) {
  const main = profiles.find((p) => p.primary) ?? null;
  const [locale, setLocale] = useState<VoiceLocaleId>(main?.locale ?? "vi-VN");
  const [catalog, setCatalog] = useState<VoiceCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [modelKey, setModelKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [gender, setGender] = useState<"" | "male" | "female">("");
  const [region, setRegion] = useState<"" | "north" | "central" | "south">("");
  const [speed, setSpeed] = useState("1");
  const [instructions, setInstructions] = useState(main?.instructions ?? legacy?.instructions ?? "");
  const [makeMain, setMakeMain] = useState(false);
  const [sample, setSample] = useState(voiceLocaleOf(main?.locale ?? "vi-VN").sample);
  const [preview, setPreview] = useState<{ ok: boolean; message: string; audioPath?: string; cost?: number; needsConfirmation?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

  const saved = profiles.find((p) => p.locale === locale) ?? null;

  async function load(next: VoiceLocaleId, refresh = false) {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await voiceCatalogAction(next, refresh);
      if (!r.ok) {
        setLoadError(r.message);
        setCatalog(null);
        return;
      }
      setCatalog(r.catalog);
      return r.catalog;
    } finally {
      setLoading(false);
    }
  }

  // A new language: its catalog, and the voice saved for it (if any) selected.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const c = await load(locale);
      if (!alive || !c) return;
      const own = profiles.find((p) => p.locale === locale);
      const pick = own && c.models.find((m) => m.provider === own.provider && m.model === own.model);
      const first = c.models.find((m) => m.selectable && m.voices.length > 0) ?? c.models[0];
      setModelKey(pick ? keyOf(pick) : first ? keyOf(first) : "");
      setVoiceId(own && pick?.voices.some((v) => v.id === own.voiceId) ? own.voiceId : "");
      setSpeed(String(own?.speed ?? 1));
      if (own) setInstructions(own.instructions);
      setGender("");
      setRegion("");
      setSample(voiceLocaleOf(locale).sample);
      setPreview(null);
    })();
    return () => {
      alive = false;
    };
    // Only the language: profiles change only after a save, which reloads the page data.
  }, [locale]);

  const model = catalog?.models.find((m) => keyOf(m) === modelKey) ?? null;
  const voices = useMemo(
    () => (model?.voices ?? []).filter((v) => (!gender || v.gender === gender) && (!region || v.region === region)),
    [model, gender, region],
  );
  const voice = model?.voices.find((v) => v.id === voiceId) ?? null;
  const hasGender = (model?.voices ?? []).some((v) => v.gender);
  const hasRegion = (model?.voices ?? []).some((v) => v.region);
  const ready = Boolean(model?.selectable && voice);

  async function runPreview(confirmedCost?: number) {
    if (!model || !voice) return;
    setBusy(true);
    if (confirmedCost === undefined) setPreview(null);
    try {
      const r = await previewVoiceChoice(
        characterId,
        { locale, provider: model.provider, model: model.model, voiceId: voice.id, speed: Number(speed), instructions, text: sample },
        confirmedCost,
      );
      setPreview(r);
    } finally {
      setBusy(false);
    }
  }

  async function startMind() {
    setStarting("Đang khởi động Mind Voice...");
    const r = await mindStartAction();
    setStarting(r.message);
    if (r.ok) await load(locale, true);
  }

  return (
    <div className="rounded-lg border border-ink-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <Label>Giọng nói</Label>
        <Badge tone={mockMode ? "neutral" : "info"}>{mockMode ? "Mock Mode" : "Giọng thật"}</Badge>
      </div>

      {issues.length > 0 && (
        <Alert tone="warn" className="mb-3" title={VOICE_PROFILE_STALE}>
          <ul className="list-inside list-disc text-xs">
            {issues.map((i, n) => (
              <li key={n}>
                {i.locale ? `${voiceLocaleOf(i.locale).label}: ` : ""}
                {i.detail}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">Giọng cũ được giữ nguyên, không tự đổi sang giọng khác. Câu thoại đã tạo vẫn dùng được; câu mới của nhân vật này chờ bạn chọn lại giọng.</p>
        </Alert>
      )}

      {legacy && (
        <p className="mb-3 text-[11px] text-ink-400">
          Đang lưu (chưa có ngôn ngữ): <code>{legacy.provider}/{legacy.model}</code> · giọng <code>{legacy.voiceId}</code>. Chọn ngôn ngữ và giọng
          bên dưới rồi Lưu để khoá giọng theo ngôn ngữ.
        </p>
      )}

      {profiles.length > 0 && (
        <div className="mb-3 space-y-1">
          <p className="text-[11px] text-ink-400">Giọng đã lưu theo ngôn ngữ (giữ nguyên ở mọi cảnh có nhân vật này):</p>
          {profiles.map((p) => (
            <div key={p.locale} className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={p.primary ? "brand" : "neutral"}>{p.locale}</Badge>
              <span className="text-ink-200">{p.voiceId}</span>
              <span className="text-ink-500">
                {p.provider}/{p.model} · tốc độ {p.speed}
              </span>
              {p.primary ? (
                <Badge tone="brand">chính</Badge>
              ) : (
                <ActionButton
                  size="sm"
                  variant="ghost"
                  confirm={`Bỏ giọng ${p.locale} của ${characterName}? (file âm thanh đã tạo không bị xoá)`}
                  action={() => removeCharacterVoiceProfile(characterId, p.locale)}
                >
                  Bỏ
                </ActionButton>
              )}
            </div>
          ))}
        </div>
      )}

      {isNarrator && (
        <p className="mb-3 text-[11px] text-ink-400">
          Người dẫn chuyện: khi dự án bật Voice Director hoặc chọn Giọng thuyết minh riêng (VIDEO OUTPUT), giọng của dự án được dùng thay cho giọng ở đây.
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="1. Ngôn ngữ">
          <Select value={locale} onChange={(e) => setLocale(e.target.value as VoiceLocaleId)}>
            {VOICE_LOCALES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
                {profiles.some((p) => p.locale === l.id) ? " ✓" : ""}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="2. Nhà cung cấp / model">
          <Select
            value={modelKey}
            onChange={(e) => {
              setModelKey(e.target.value);
              setVoiceId("");
              setPreview(null);
            }}
            disabled={loading || !catalog}
          >
            {(catalog?.models ?? []).map((m) => (
              <option key={keyOf(m)} value={keyOf(m)}>
                {m.providerLabel} · {m.modelLabel} ({STATUS_LABEL[m.status]}, {m.voices.length} giọng)
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {loading && <p className="mt-2 text-xs text-ink-400">Đang đọc danh sách giọng...</p>}
      {loadError && (
        <Alert tone="danger" className="mt-2">
          {loadError}
        </Alert>
      )}

      {model && (
        <div className="mt-2 flex flex-wrap items-start gap-2 text-xs">
          <Badge tone={STATUS_TONE[model.status]}>{STATUS_LABEL[model.status]}</Badge>
          <Badge tone={model.local ? "ok" : "warn"}>{model.local ? "$0 API — chạy tại máy" : `Trả phí ~$${model.pricePer1kChars.toFixed(4)}/1000 ký tự`}</Badge>
          <span className="flex-1 text-ink-400">{model.statusMessage}</span>
          {model.provider === "mindvoice" && (
            <span className="flex gap-2">
              {model.status === "OFFLINE" && (
                <Button size="sm" variant="secondary" type="button" onClick={() => void startMind()} disabled={Boolean(starting?.startsWith("Đang"))}>
                  Khởi động Mind Voice
                </Button>
              )}
              <Button size="sm" variant="ghost" type="button" onClick={() => void load(locale, true)} disabled={loading}>
                Kiểm tra lại
              </Button>
            </span>
          )}
        </div>
      )}
      {starting && <p className="mt-1 text-xs text-ink-400">{starting}</p>}

      {model && (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {hasGender && (
            <Field label="Lọc giới tính">
              <Select value={gender} onChange={(e) => setGender(e.target.value as typeof gender)}>
                <option value="">Tất cả</option>
                <option value="female">Nữ</option>
                <option value="male">Nam</option>
              </Select>
            </Field>
          )}
          {hasRegion && (
            <Field label="Lọc giọng vùng">
              <Select value={region} onChange={(e) => setRegion(e.target.value as typeof region)}>
                <option value="">Tất cả</option>
                <option value="north">Miền Bắc</option>
                <option value="central">Miền Trung</option>
                <option value="south">Miền Nam</option>
              </Select>
            </Field>
          )}
          <Field label={`3. Giọng (${voices.length})`}>
            <Select
              value={voiceId}
              onChange={(e) => {
                setVoiceId(e.target.value);
                setPreview(null);
              }}
              disabled={voices.length === 0}
            >
              <option value="">— chọn giọng —</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {voiceLabel(v)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {model && model.voices.length === 0 && (
        <p className="mt-2 text-xs text-warn-500">Model này chưa có giọng nào cho {voiceLocaleOf(locale).label}. Không có giọng thay thế nào được tạo.</p>
      )}

      {voice && (
        <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
          <span className="text-ink-400">{voice.note}</span>
          {!voice.languageVerified && <Badge tone="warn">ngôn ngữ chưa xác minh</Badge>}
          {voiceLocaleOf(locale).accent && !voice.accentVerified && <Badge tone="warn">giọng {voiceLocaleOf(locale).accent} chưa xác minh</Badge>}
          {voice.gender && !voice.genderVerified && <Badge tone="neutral">giới tính chưa xác minh</Badge>}
        </div>
      )}

      {model && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Field label={`Tốc độ đọc (${model.speed.min}–${model.speed.max})`} hint="Để 1 trừ khi câu thoại không vừa thời lượng cảnh.">
            <Input type="number" step="0.05" min={model.speed.min} max={model.speed.max} value={speed} onChange={(e) => setSpeed(e.target.value)} />
          </Field>
          <div className="text-[11px] text-ink-400">
            <p className="mb-1 font-medium text-ink-300">Cảm xúc / hướng dẫn diễn</p>
            {model.emotion === "INSTRUCTIONS"
              ? "Model này nhận hướng dẫn diễn tự do (viết tiếng Anh, mô tả cách nói)."
              : model.emotion === "TAGS"
                ? "Model này KHÔNG nhận hướng dẫn tự do: chỉ chỉnh tốc độ; cảm xúc là vài thẻ có sẵn do Voice Director thêm. Ô hướng dẫn bên dưới được giữ lại nhưng không gửi đi và không bao giờ bị đọc thành lời."
                : "Model này không nhận hướng dẫn diễn; nội dung không được gửi."}
          </div>
        </div>
      )}

      {model?.supportsInstructions && (
        <Field label="Hướng dẫn diễn" hint="Viết bằng tiếng Anh. Mô tả cách nói, không phải nội dung nói.">
          <Textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
      )}

      {/* 4. Listen - outside the save form: a paid listen must never be the "save" button. */}
      <div className="mt-3 border-t border-ink-800 pt-3">
        <Label>4. Nghe thử</Label>
        <p className="mb-2 text-[11px] text-ink-400">
          {!model
            ? ""
            : model.local
              ? "Chạy tại máy, $0 API. Câu thử chỉ là lời nói - không đọc tên nhân vật."
              : mockMode
                ? "Mock Mode: âm thanh giả lập, $0."
                : "Lệnh gọi API TRẢ PHÍ: giá được báo trước, chỉ gửi khi bạn xác nhận."}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={sample} onChange={(e) => setSample(e.target.value)} maxLength={300} placeholder="Câu muốn nghe thử" />
          <Button type="button" variant="secondary" onClick={() => void runPreview()} disabled={busy || !ready || sample.trim().length === 0}>
            {busy ? "Đang tạo..." : "Nghe thử"}
          </Button>
        </div>
        {preview && (
          <div className="mt-2">
            <Alert tone={preview.ok ? "ok" : preview.needsConfirmation ? "warn" : "danger"}>{preview.message}</Alert>
            {preview.needsConfirmation && preview.cost !== undefined && (
              <div className="mt-2 flex gap-2">
                <Button size="sm" type="button" onClick={() => void runPreview(preview.cost)} disabled={busy}>
                  Xác nhận chi ~${preview.cost.toFixed(6)} và nghe thử
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setPreview(null)}>
                  Huỷ
                </Button>
              </div>
            )}
            {preview.ok && preview.audioPath && (
              <audio className="mt-2 w-full" controls src={`/api/media/${preview.audioPath.split(/[\\/]/).join("/")}`} />
            )}
          </div>
        )}
      </div>

      {/* 5. Save - checked again on the server against the same catalog. */}
      <div className="mt-3 border-t border-ink-800 pt-3">
        <ActionForm action={(formData) => saveCharacterVoice(characterId, formData)} submitLabel="5. Lưu giọng cho ngôn ngữ này" submitVariant="secondary">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="voiceProvider" value={model?.provider ?? ""} />
          <input type="hidden" name="voiceModel" value={model?.model ?? ""} />
          <input type="hidden" name="voiceId" value={voice?.id ?? ""} />
          <input type="hidden" name="voiceSpeed" value={speed} />
          <input type="hidden" name="voiceInstructions" value={instructions} />
          <input type="hidden" name="voiceGender" value={voice?.gender ?? "male"} />
          <p className="text-[11px] text-ink-400">
            {ready
              ? `Sẽ lưu: ${voice!.label} · ${model!.providerLabel} · ${voiceLocaleOf(locale).label}${saved ? " (thay giọng đã lưu cho ngôn ngữ này)" : ""}.`
              : "Chọn một giọng trong danh sách để lưu."}
          </p>
          {main && main.locale !== locale && (
            <label className="mt-1 flex items-center gap-2 text-xs text-ink-300">
              <input type="checkbox" name="makeMain" checked={makeMain} onChange={(e) => setMakeMain(e.target.checked)} />
              Đặt làm ngôn ngữ chính (hiện là {main.locale})
            </label>
          )}
        </ActionForm>
      </div>
    </div>
  );
}
