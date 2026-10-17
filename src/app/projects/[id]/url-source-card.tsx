"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Globe, Loader2, Pencil } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Textarea } from "@/components/ui";
import { applyProjectUrlAction, refetchProjectUrlAction } from "@/app/actions/content";
import type { RefetchResult } from "@/services/url-source";

/**
 * NGUỒN URL of a project (QĐ-138). Shows the snapshot the script was written
 * from. Opening the project, rewriting the script, resuming and rendering all
 * read this snapshot - the page is opened again ONLY by ĐỌC LẠI TỪ WEB, and its
 * new text replaces the snapshot only after THAY NGUỒN. Never a new script,
 * never new pictures / clips / voice.
 */
export function UrlSourceCard(props: {
  projectId: string;
  url: string;
  domain: string;
  pageTitle: string;
  extractedAt: string;
  approvedAt: string;
  chars: number;
  edited: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<RefetchResult | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refetch = () =>
    start(async () => {
      setMsg(null);
      setConfirm(null);
      const r = await refetchProjectUrlAction(props.projectId);
      setResult(r.result ?? null);
      setText(r.result?.preview.text ?? "");
      setEditing(false);
      setMsg({ ok: r.ok, text: r.message });
    });

  const apply = (confirmReplace: boolean) =>
    start(async () => {
      if (!result) return;
      const r = await applyProjectUrlAction(props.projectId, text, result.preview.meta, confirmReplace);
      if (r.needsConfirmation) {
        setConfirm(r.message);
        return;
      }
      setConfirm(null);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) {
        setResult(null);
        router.refresh();
      }
    });

  return (
    <Card id="nguon-url">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Nguồn URL</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Badge>{props.domain}</Badge>
            <Badge>{props.chars.toLocaleString("vi-VN")} ký tự</Badge>
            {props.edited ? <Badge>đã chỉnh sửa</Badge> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-ink-200">{props.pageTitle || props.url}</p>
        <p className="break-all text-xs text-ink-500">
          {props.url} · đọc lúc {props.extractedAt ? new Date(props.extractedAt).toLocaleString("vi-VN") : "?"} · chấp nhận lúc{" "}
          {props.approvedAt ? new Date(props.approvedAt).toLocaleString("vi-VN") : "?"}
        </p>
        <p className="text-[11px] text-ink-500">
          Kịch bản, viết lại, tiếp tục và render đều dùng bản nội dung đã lưu này - không mở lại trang web.
        </p>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={refetch}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
          ĐỌC LẠI TỪ WEB
        </Button>
        {msg ? <Alert tone={msg.ok ? "ok" : "danger"}>{msg.text}</Alert> : null}
        {result ? (
          <div className="space-y-2 rounded-lg border border-ink-800 p-3">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={result.changed ? "warn" : "ok"}>{result.changed ? "Trang đã thay đổi" : "Không đổi"}</Badge>
              <Badge>{text.length.toLocaleString("vi-VN")} ký tự</Badge>
            </div>
            {result.preview.warnings.length > 0 ? (
              <Alert tone="warn" title="Lưu ý">
                {result.preview.warnings.join(" ")}
              </Alert>
            ) : null}
            <Textarea value={text} readOnly={!editing} rows={10} onChange={(e) => setText(e.currentTarget.value)} />
            <Alert tone="info" title="Chỉ thay nội dung nguồn">
              Kịch bản, ảnh, clip và giọng giữ nguyên ($0). Muốn áp dụng nội dung mới: bấm VIẾT LẠI KỊCH BẢN sau đó (chỉ viết lại chữ).
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" /> CHỈNH SỬA
              </Button>
              <Button type="button" variant="primary" size="sm" disabled={pending || !text.trim()} onClick={() => apply(false)}>
                <Check className="h-3.5 w-3.5" /> THAY NGUỒN
              </Button>
            </div>
            {confirm ? (
              <Alert tone="warn" title="Xác nhận">
                <p>{confirm}</p>
                <Button type="button" variant="danger" size="sm" className="mt-2" disabled={pending} onClick={() => apply(true)}>
                  XÁC NHẬN THAY NGUỒN
                </Button>
              </Alert>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
