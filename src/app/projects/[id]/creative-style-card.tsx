"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { CreativeStylePicker } from "@/components/creative-style-picker";
import { rewriteWithStyleAction, saveCreativeStyleAction } from "@/app/actions/content";
import type { StoredCreativeStyle, TemplateCreative } from "@/domain/creative-style";

/**
 * PHONG CÁCH SÁNG TẠO on a project (QĐ-127). Shows the style the CURRENT
 * script was written with, lets the person change it, and VIẾT LẠI KỊCH BẢN
 * rewrites only the script text (one text call, free in Mock Mode). Pictures,
 * clips and voice are never made here - media waits for DUYỆT KỊCH BẢN.
 */
export function CreativeStyleCard(props: {
  projectId: string;
  creative: TemplateCreative;
  initial: StoredCreativeStyle | null;
  writtenWith: { label: string; value: string }[];
  canRewrite: boolean;
  mediaExists: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [style, setStyle] = useState<Partial<StoredCreativeStyle>>(props.initial ?? { preset: "AUTO" });
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = (thenRewrite: boolean) =>
    start(async () => {
      const saved = await saveCreativeStyleAction(props.projectId, style);
      if (!saved.ok || !thenRewrite) {
        setMsg({ ok: saved.ok, text: saved.message });
        setDirty(false);
        router.refresh();
        return;
      }
      const r = await rewriteWithStyleAction(props.projectId);
      setMsg({ ok: r.ok, text: r.message });
      setDirty(false);
      router.refresh();
    });

  return (
    <Card id="phong-cach">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Phong cách sáng tạo</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            {props.writtenWith.map((b) => (
              <Badge key={b.label}>
                {b.label}: {b.value}
              </Badge>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-ink-500">Các nhãn trên là phong cách của kịch bản hiện tại. Đổi bên dưới rồi bấm VIẾT LẠI KỊCH BẢN để áp dụng.</p>
        <CreativeStylePicker
          creative={props.creative}
          initial={props.initial}
          name="creativeStyleEdit"
          onChange={(s) => {
            setStyle(s);
            setDirty(true);
          }}
        />
        {dirty && props.mediaExists ? (
          <Alert tone="warn" title="Bạn đã thay đổi phong cách kịch bản.">
            Media cũ vẫn được giữ, không tạo lại gì. Nếu duyệt kịch bản mới, các cảnh bị thay đổi sẽ cần cập nhật media.
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={pending || !dirty} onClick={() => save(false)}>
            <Save className="h-3.5 w-3.5" /> Lưu phong cách
          </Button>
          {props.canRewrite ? (
            <Button variant="primary" disabled={pending} onClick={() => save(true)}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              VIẾT LẠI KỊCH BẢN
            </Button>
          ) : null}
          <span className="text-xs text-ink-500">
            {props.canRewrite
              ? "Chỉ viết lại chữ, cảnh và kế hoạch media. Không tạo ảnh, giọng hay video cho tới khi bạn DUYỆT KỊCH BẢN."
              : "Dự án đã bắt đầu tạo media: không viết lại cả kịch bản (giữ media cũ). Sửa từng cảnh ở Storyboard."}
          </span>
        </div>
        {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}
      </CardContent>
    </Card>
  );
}
