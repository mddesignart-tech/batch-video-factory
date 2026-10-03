"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Alert, Button, Card, CardContent, Field, Input, Select, Textarea } from "@/components/ui";
import { PlatformPicker } from "@/components/platform-picker";
import { createContentVideo } from "@/app/actions/content";
import {
  CONTENT_CATEGORIES,
  CONTENT_TEMPLATES,
  templatesInCategory,
  type ContentTemplate,
} from "@/domain/content-templates";
import {
  AUDIENCES,
  BILINGUAL_MODES,
  CONTENT_SOURCE_TYPES,
  DURATION_CHOICES,
  LANGUAGES,
  TONES,
  VOICE_MODES,
} from "@/domain/content-options";
import { cn } from "@/lib/utils";

/**
 * TẠO VIDEO - four steps a non-technical person can follow:
 *
 *   1. Bạn muốn làm loại video nào?
 *   2. Bạn muốn bắt đầu từ đâu?
 *   3. Thiết lập cơ bản (ngôn ngữ, thời lượng, nền tảng, phong cách)
 *   4. TẠO KỊCH BẢN  - free; no picture, voice or clip is bought.
 *
 * Model, provider, resolution, routing and FFmpeg never appear here.
 */
/** What the uploaded pictures are, said in the template's own words (QĐ-124). */
const REFERENCE_LABEL: Partial<Record<string, string>> = {
  PRODUCT_REVIEW: "Sản phẩm tham chiếu",
  ADVERTISEMENT: "Sản phẩm / logo tham chiếu",
  TOY_WORLD: "Đồ chơi tham chiếu",
  ANIMAL_FACT: "Con vật / mascot tham chiếu",
  STORY: "Nhân vật & đồ vật",
};

export function CreateVideoWizard({ presets }: { presets: { id: string; name: string; slug: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [formatId, setFormatId] = useState<string>("");
  const [source, setSource] = useState<string | null>(null);
  const [language, setLanguage] = useState("vi");
  const [duration, setDuration] = useState<number | "custom">(30);
  const [customDuration, setCustomDuration] = useState("40");
  const [files, setFiles] = useState<File[]>([]);

  const templates = category ? templatesInCategory(category) : [];
  const template: ContentTemplate | null = useMemo(
    () => CONTENT_TEMPLATES.find((t) => t.id === templateId) ?? null,
    [templateId],
  );

  const chooseCategory = (id: string) => {
    setCategory(id);
    const list = templatesInCategory(id);
    // One template in the category: it is chosen with the card.
    const first = list.length === 1 ? list[0]! : null;
    pickTemplate(first);
  };
  const pickTemplate = (t: ContentTemplate | null) => {
    setTemplateId(t?.id ?? null);
    setFormatId(t?.formats[0]?.id ?? "");
    setSource(null);
    if (t) {
      setLanguage(t.defaultLanguage);
      setDuration((DURATION_CHOICES as readonly number[]).includes(t.defaultDuration) ? t.defaultDuration : "custom");
      setCustomDuration(String(t.defaultDuration));
    }
  };

  const sources = template ? CONTENT_SOURCE_TYPES.filter((s) => (template.sources as readonly string[]).includes(s.id)) : [];
  const legacyIdiom = template?.engine === "LEGACY_IDIOM";
  const ready = Boolean(template && source && !legacyIdiom && source !== "STORYBOARD" && source !== "IDIOM");
  const defaultStyle = presets.find((p) => p.slug === template?.defaultStyleSlug)?.id ?? "";
  const product = template?.category === "PRODUCT" || template?.category === "ADS" || template?.category === "AI";

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        data.delete("uploads");
        for (const f of files) data.append("uploads", f);
        setError(null);
        startTransition(async () => {
          const result = await createContentVideo(data);
          if (result.ok && result.projectId) router.push(`/projects/${result.projectId}#kich-ban`);
          else setError(result.message);
        });
      }}
    >
      {/* ---------------------------------------------------------- step 1 */}
      <Step n={1} title="Bạn muốn làm loại video nào?">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {CONTENT_CATEGORIES.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => chooseCategory(c.id)}
              className={cn(
                "rounded-lg border px-3 py-3 text-left transition-colors",
                category === c.id ? "border-brand-500 bg-brand-500/10" : "border-ink-700 hover:border-ink-500 hover:bg-ink-850",
              )}
            >
              <div className="text-2xl">{c.icon}</div>
              <div className="mt-1 text-sm font-semibold text-ink-100">{c.label}</div>
              <div className="text-[11px] text-ink-500">{c.hint}</div>
            </button>
          ))}
        </div>
        {templates.length > 1 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {templates.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => pickTemplate(t)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs",
                  templateId === t.id ? "border-brand-500 bg-brand-500/10 text-ink-100" : "border-ink-700 text-ink-300 hover:border-ink-500",
                )}
              >
                {t.name}
              </button>
            ))}
          </div>
        ) : null}
        {template ? (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-ink-400">{template.description}</p>
            {template.formats.length > 1 ? (
              <Field label="Dạng video">
                <Select value={formatId} onChange={(e) => setFormatId(e.currentTarget.value)} className="max-w-xs">
                  {template.formats.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
        ) : null}
        <input type="hidden" name="contentType" value={templateId ?? ""} />
        <input type="hidden" name="formatId" value={formatId} />
      </Step>

      {/* ---------------------------------------------------------- step 2 */}
      {template ? (
        <Step n={2} title="Bạn muốn bắt đầu từ đâu?">
          <div className="flex flex-wrap gap-2">
            {sources.map((s) => (
              <button
                type="button"
                key={s.id}
                disabled={!s.enabled && s.id !== "URL"}
                onClick={() => setSource(s.id)}
                className={cn(
                  "rounded-lg border px-4 py-2 text-sm",
                  source === s.id ? "border-brand-500 bg-brand-500/10 text-ink-100" : "border-ink-700 text-ink-300 hover:border-ink-500",
                )}
              >
                {s.icon} {s.label}
                {s.id === "URL" ? <span className="ml-1 text-[10px] text-ink-500">(sắp có)</span> : null}
              </button>
            ))}
          </div>
          <input type="hidden" name="sourceType" value={source ?? ""} />

          {source === "IDIOM" ? (
            <Alert tone="info" title="Thư viện 133 thành ngữ" className="mt-3">
              Video thành ngữ dùng đúng bộ viết kịch bản cũ.{" "}
              <Link href="/projects" className="underline">
                Mở trang Dự án video để chọn thành ngữ →
              </Link>
            </Alert>
          ) : null}
          {source === "STORYBOARD" ? (
            <Alert tone="info" title="Nhập storyboard có sẵn" className="mt-3">
              JSON, CSV, thư mục hoặc ZIP.{" "}
              <Link href="/import" className="underline">
                Mở trang Nhập Storyboard →
              </Link>
            </Alert>
          ) : null}

          {source && !legacyIdiom && source !== "STORYBOARD" && source !== "IDIOM" ? (
            <div className="mt-3 space-y-3">
              {product ? (
                <Field label={template.category === "AI" ? "Tên công cụ AI" : "Tên sản phẩm / thương hiệu"}>
                  <Input name="subjectName" placeholder="Ví dụ: Bình giữ nhiệt Mind 500ml" />
                </Field>
              ) : null}
              {source === "URL" ? (
                <Field label="Đường link" hint="Tool chưa tự đọc trang web. Hãy dán thêm nội dung trang vào ô bên dưới.">
                  <Input name="sourceUrl" placeholder="https://…" />
                </Field>
              ) : null}
              {source === "TEXT" || source === "URL" ? (
                <Field label="Dán nội dung" hint="Bài viết, caption, mô tả sản phẩm, script… AI giữ ý chính, rút gọn theo thời lượng, không bịa thêm.">
                  <Textarea name="sourceText" rows={8} placeholder="Dán nội dung vào đây…" />
                </Field>
              ) : null}
              <Field label={source === "TEXT" ? "Ghi chú thêm (không bắt buộc)" : "Bạn muốn video nói về điều gì?"}>
                <Textarea name="idea" rows={source === "PROMPT" ? 4 : 2} placeholder={template.ideaPlaceholder} />
              </Field>
              {product ? (
                <Field label="Thông tin bạn chắc chắn (mỗi dòng một ý)" hint="Thông số, ưu/nhược điểm, giá… Chỉ những gì bạn ghi ở đây mới được nói như sự thật.">
                  <Textarea name="factsText" rows={3} placeholder={"Dung tích 500ml\nGiữ nóng 12 giờ"} />
                </Field>
              ) : null}
              {source === "ASSETS" || product || template.sources.includes("ASSETS") ? (
                <div className="space-y-2 rounded-lg border border-ink-800 p-3">
                  <Field
                    label={`${REFERENCE_LABEL[template.id] ?? "Ảnh của bạn"}${source === "ASSETS" ? "" : " (không bắt buộc)"}`}
                    hint="Nhiều ảnh của CÙNG một thứ (mặt trước, mặt bên, hộp…). Ảnh vào Thư viện asset, được dùng nguyên bản và giữ đúng hình ở mọi cảnh. Chi phí $0."
                  >
                    <Input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      onChange={(e) => setFiles(Array.from(e.currentTarget.files ?? []))}
                    />
                    {files.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {files.map((f) => (
                          <img key={f.name} src={URL.createObjectURL(f)} alt={f.name} className="h-14 w-14 rounded border border-ink-700 object-cover" />
                        ))}
                      </div>
                    ) : null}
                  </Field>
                  {files.length > 0 && !product ? (
                    <Field label="Tên (để tool nhận ra trong kịch bản)">
                      <Input name="referenceName" placeholder="Ví dụ: Xe tải vàng của Ben, Mèo Mun" />
                    </Field>
                  ) : null}
                  {files.length > 0 ? (
                    <label className="flex items-center gap-2 text-xs text-ink-300">
                      <input type="checkbox" name="useReferenceThroughout" defaultChecked={product} key={template.id} />
                      {product ? "Dùng sản phẩm này xuyên suốt video" : "Xuất hiện xuyên suốt video"}
                    </label>
                  ) : null}
                </div>
              ) : null}
              {product || template.category === "ADS" ? (
                <Field label="Kêu gọi hành động (không bắt buộc)" hint="Số điện thoại, website, Zalo… chép đúng như bạn ghi.">
                  <Input name="cta" placeholder="Ví dụ: Liên hệ Zalo 09xx xxx xxx" />
                </Field>
              ) : null}
            </div>
          ) : null}
        </Step>
      ) : null}

      {/* ---------------------------------------------------------- step 3 */}
      {ready && template ? (
        <Step n={3} title="Thiết lập cơ bản">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Ngôn ngữ">
              <Select name="language" value={language} onChange={(e) => setLanguage(e.currentTarget.value)}>
                {LANGUAGES.filter((l) => l.enabled).map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Thời lượng">
              <Select
                value={String(duration)}
                onChange={(e) => setDuration(e.currentTarget.value === "custom" ? "custom" : Number(e.currentTarget.value))}
              >
                {DURATION_CHOICES.map((d) => (
                  <option key={d} value={d}>
                    {d} giây
                  </option>
                ))}
                <option value="custom">Tùy chỉnh</option>
              </Select>
              {duration === "custom" ? (
                <Input className="mt-2" type="number" min={10} max={180} value={customDuration} onChange={(e) => setCustomDuration(e.currentTarget.value)} />
              ) : null}
              <input type="hidden" name="durationSeconds" value={duration === "custom" ? customDuration : duration} />
            </Field>
            <Field label="Phong cách hình ảnh">
              <Select name="stylePresetId" defaultValue={defaultStyle} key={template.id}>
                <option value="">Tự động</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Video dành cho ai?">
              <Select name="audience" defaultValue={template.defaultAudience} key={`a-${template.id}`}>
                {AUDIENCES.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="mt-4 space-y-2">
            <p className="text-sm font-semibold text-ink-100">Bạn muốn đăng video ở đâu?</p>
            <PlatformPicker />
          </div>

          <details className="mt-4 rounded-lg border border-ink-800 px-3 py-2">
            <summary className="cursor-pointer text-xs text-ink-400">Tuỳ chọn thêm (không bắt buộc)</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Phong cách nội dung">
                <Select name="tone" defaultValue={template.defaultTone} key={`t-${template.id}`}>
                  {TONES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Lồng tiếng">
                <Select name="voiceMode" defaultValue={template.defaultVoiceMode} key={`v-${template.id}`}>
                  {VOICE_MODES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {language === "vi-en" ? (
                <Field label="Cách song ngữ">
                  <Select name="bilingualMode" defaultValue="VI_EXPLAIN_EN_EXAMPLE">
                    {BILINGUAL_MODES.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </div>
          </details>
        </Step>
      ) : null}

      {/* ---------------------------------------------------------- step 4 */}
      {ready ? (
        <Step n={4} title="Tạo kịch bản">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" size="lg" disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              TẠO KỊCH BẢN
            </Button>
            <p className="text-xs text-ink-500">
              Bước này chỉ viết kịch bản để bạn xem và sửa. Chưa tạo ảnh, giọng hay video - chưa tốn phí media.
            </p>
          </div>
          {error ? <Alert tone="danger" title={error} className="mt-3" /> : null}
        </Step>
      ) : null}
    </form>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-100">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500 text-xs text-ink-950">{n}</span>
          {title}
        </p>
        {children}
      </CardContent>
    </Card>
  );
}
