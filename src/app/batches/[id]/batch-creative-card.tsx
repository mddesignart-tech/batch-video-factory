"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { CreativeStylePicker } from "@/components/creative-style-picker";
import { saveBatchCreativeStyleAction } from "@/app/actions/batches";
import type { StoredCreativeStyle, TemplateCreative } from "@/domain/creative-style";

/**
 * PHONG CÁCH of a whole idiom batch (QĐ-136). Shows the style the plan was
 * made with and saves a new one onto every video of the batch. Saving never
 * rewrites a script and never makes media: each video keeps its pictures,
 * clips and voice, and VIẾT LẠI KỊCH BẢN stays a per-video choice.
 */
export function BatchCreativeCard(props: {
  batchId: string;
  creative: TemplateCreative;
  initial: StoredCreativeStyle | null;
  summary: string;
  badges: { label: string; value: string }[];
  videos: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [style, setStyle] = useState<Partial<StoredCreativeStyle>>(props.initial ?? { preset: "AUTO" });
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = () =>
    start(async () => {
      const r = await saveBatchCreativeStyleAction(props.batchId, style);
      setMsg({ ok: r.ok, text: r.message });
      setDirty(false);
      router.refresh();
    });

  return (
    <Card id="phong-cach-lo">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Phong cách của lô</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            {props.badges.map((b) => (
              <Badge key={b.label}>
                {b.label}: {b.value}
              </Badge>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-ink-400">{props.summary}</p>
        <CreativeStylePicker
          creative={props.creative}
          initial={props.initial}
          name="batchCreativeStyle"
          onChange={(next) => {
            setStyle(next);
            setDirty(true);
          }}
        />
        {dirty ? (
          <Alert tone="warn" title="Chỉ lưu phong cách">
            Lưu cho {props.videos} video của lô. Media cũ vẫn được giữ; không viết lại kịch bản, không tạo ảnh / clip / giọng ($0).
          </Alert>
        ) : null}
        <Button type="button" variant="primary" disabled={pending || !dirty} onClick={save}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          LƯU PHONG CÁCH CHO CẢ LÔ
        </Button>
        {msg ? (
          <Alert tone={msg.ok ? "ok" : "danger"} title={msg.ok ? "Đã lưu" : "Chưa lưu"}>
            {msg.text}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
