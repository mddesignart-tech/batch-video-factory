"use client";

import { useState, useTransition } from "react";
import { Check, Globe, Loader2, Pencil, RefreshCw } from "lucide-react";
import { Alert, Badge, Button, Field, Input, Textarea } from "@/components/ui";
import { readUrlSourceAction } from "@/app/actions/content";
import type { UrlSourcePreview } from "@/services/url-source";

const KIND_LABEL: Record<string, string> = { ARTICLE: "Bài viết", PRODUCT: "Trang sản phẩm", PAGE: "Trang web" };
const LANG_LABEL: Record<string, string> = { vi: "Tiếng Việt", en: "English" };

/**
 * NGUỒN URL in TẠO VIDEO (QĐ-138): paste a link, ĐỌC NỘI DUNG, read the
 * extracted text, CHỈNH SỬA it if needed, CHẤP NHẬN. Reading costs $0 and
 * calls no AI; nothing is fetched while typing. Only the accepted text goes to
 * the script writer, as the snapshot the project keeps.
 */
export function UrlSourcePanel({ onAcceptedChange }: { onAcceptedChange: (accepted: boolean) => void }) {
  const [pending, start] = useTransition();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UrlSourcePreview | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const setAcceptedBoth = (v: boolean) => {
    setAccepted(v);
    onAcceptedChange(v);
  };

  const read = () =>
    start(async () => {
      setError(null);
      setAcceptedBoth(false);
      setEditing(false);
      const r = await readUrlSourceAction(url);
      if (r.ok && r.preview) {
        setPreview(r.preview);
        setText(r.preview.text);
      } else {
        setPreview(null);
        setError(r.message);
      }
    });

  return (
    <div className="space-y-3 rounded-lg border border-ink-800 p-3">
      <Field label="Đường link" hint="Bài viết, bài review, trang sản phẩm, trang giới thiệu… (http / https). Đọc trang miễn phí, không gọi AI.">
        <div className="flex flex-wrap gap-2">
          <Input
            value={url}
            onChange={(e) => {
              setUrl(e.currentTarget.value);
              if (accepted) setAcceptedBoth(false);
            }}
            placeholder="Dán liên kết bài viết, trang sản phẩm hoặc website…"
            className="min-w-0 flex-1"
            inputMode="url"
          />
          <Button type="button" variant="primary" disabled={pending || !url.trim()} onClick={read}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
            ĐỌC NỘI DUNG
          </Button>
        </div>
      </Field>

      {error ? <Alert tone="danger" title="Chưa đọc được trang">{error}</Alert> : null}

      {preview ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="mr-1 text-sm font-semibold text-ink-100">{preview.meta.pageTitle || "(trang không có tiêu đề)"}</p>
            <Badge>{preview.meta.domain}</Badge>
            <Badge>{KIND_LABEL[preview.meta.kind] ?? preview.meta.kind}</Badge>
            {preview.meta.language ? <Badge>{LANG_LABEL[preview.meta.language] ?? preview.meta.language}</Badge> : null}
            <Badge tone={text.length < 600 ? "warn" : "neutral"}>{text.length.toLocaleString("vi-VN")} ký tự</Badge>
            {accepted ? <Badge tone="ok">Đã chấp nhận</Badge> : null}
          </div>
          {preview.warnings.length > 0 ? (
            <Alert tone="warn" title="Lưu ý">
              <ul className="list-disc pl-4">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <Textarea
            value={text}
            readOnly={!editing}
            rows={12}
            onChange={(e) => setText(e.currentTarget.value)}
            className={editing ? "" : "opacity-90"}
          />
          <p className="text-[11px] text-ink-500">
            Đây là nội dung sẽ dùng làm nguồn kịch bản. AI chỉ được nói những gì có ở đây (và trong phần thông tin bạn ghi) - không thêm sự
            thật mới. Ảnh trên trang không được tải về.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(true);
                setAcceptedBoth(false);
              }}
            >
              <Pencil className="h-3.5 w-3.5" /> CHỈNH SỬA
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!text.trim() || accepted}
              onClick={() => {
                setEditing(false);
                setAcceptedBoth(true);
              }}
            >
              <Check className="h-3.5 w-3.5" /> CHẤP NHẬN
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={read}>
              <RefreshCw className="h-3.5 w-3.5" /> ĐỌC LẠI
            </Button>
          </div>
        </div>
      ) : null}

      {/* Only an ACCEPTED snapshot is sent with TẠO KỊCH BẢN. */}
      {accepted && preview ? (
        <>
          <input type="hidden" name="sourceUrl" value={preview.meta.url} />
          <input type="hidden" name="sourceText" value={text} />
          <input type="hidden" name="urlSourceMeta" value={JSON.stringify(preview.meta)} />
        </>
      ) : null}
    </div>
  );
}
