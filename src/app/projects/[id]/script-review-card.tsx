"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { approveScriptAction, rewriteContentScriptAction } from "@/app/actions/content";

export interface ScriptReviewScene {
  sceneNumber: number;
  beatLabel: string;
  duration: number;
  speech: string;
  subtitle: string;
  visual: string;
  usesOwnPhoto: boolean;
  motion: string;
  soundEffect: string;
}

/**
 * SCRIPT PREVIEW for a multi-content project: title, hook, every scene's words,
 * subtitle and picture - and DUYỆT KỊCH BẢN. Each scene is edited in the
 * Storyboard below (words, visual prompt, add / skip a scene, own picture,
 * Local Motion or Video AI). Nothing here buys anything.
 */
export function ScriptReviewCard(props: {
  projectId: string;
  title: string;
  hook: string;
  templateName: string;
  formatLabel: string;
  languageLabel: string;
  audienceLabel: string;
  durationSeconds: number;
  approved: boolean;
  needsFactReview: boolean;
  aiFacts: string[];
  canRewrite: boolean;
  scenes: ScriptReviewScene[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      setMessage({ ok: r.ok, text: r.message });
      router.refresh();
    });

  return (
    <Card id="kich-ban">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Kịch bản</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="brand">{props.templateName}</Badge>
            <Badge>{props.formatLabel}</Badge>
            <Badge>{props.languageLabel}</Badge>
            <Badge>{props.audienceLabel}</Badge>
            <Badge>{props.durationSeconds} giây</Badge>
            {props.approved ? <Badge tone="ok">Đã duyệt</Badge> : <Badge tone="warn">Chờ duyệt</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-base font-semibold text-ink-100">{props.title}</p>
          <p className="text-sm text-ink-300">Hook: {props.hook}</p>
        </div>

        {props.needsFactReview ? (
          <Alert tone="warn" title="Có thông tin do AI tự viết - hãy kiểm tra trước khi đăng">
            {props.aiFacts.length > 0 ? props.aiFacts.join(" · ") : "Các con số, thông số, sự thật trong kịch bản chưa có nguồn."}
          </Alert>
        ) : null}

        <ol className="space-y-2">
          {props.scenes.map((s) => (
            <li key={s.sceneNumber} className="rounded-lg border border-ink-800 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <span className="font-semibold text-ink-200">Cảnh {s.sceneNumber}</span>
                <span>{s.beatLabel}</span>
                <span>· {s.duration}s</span>
                {s.usesOwnPhoto ? <Badge tone="ok">Ảnh của bạn · $0</Badge> : null}
                <Badge tone={s.motion === "LOCAL_MOTION" ? "ok" : "neutral"}>
                  {s.motion === "LOCAL_MOTION" ? "Chuyển động nội bộ · $0" : "Tự động chọn chuyển động"}
                </Badge>
                {s.soundEffect ? <span>· 🔊 {s.soundEffect}</span> : null}
              </div>
              {s.speech ? <p className="mt-1 whitespace-pre-wrap text-sm text-ink-100">{s.speech}</p> : null}
              {s.subtitle && s.subtitle !== s.speech ? <p className="text-xs text-ink-400">Phụ đề: {s.subtitle}</p> : null}
              <p className="mt-0.5 text-xs text-ink-500">Hình: {s.visual}</p>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-2">
          {!props.approved ? (
            <Button variant="primary" disabled={pending} onClick={() => run(() => approveScriptAction(props.projectId))}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              DUYỆT KỊCH BẢN
            </Button>
          ) : null}
          {props.canRewrite ? (
            <Button variant="outline" disabled={pending} onClick={() => run(() => rewriteContentScriptAction(props.projectId))}>
              <RefreshCw className="h-3.5 w-3.5" />
              Viết lại kịch bản
            </Button>
          ) : null}
          <p className="text-xs text-ink-500">
            {props.approved
              ? "Đã duyệt. Bấm TẠO MEDIA ở trên để xem chi phí trước khi chạy."
              : "Sửa lời thoại, hình ảnh, thêm/bỏ cảnh ở Storyboard bên dưới. Chưa tạo ảnh, giọng hay video nào."}
          </p>
        </div>
        {message ? <Alert tone={message.ok ? "ok" : "danger"} title={message.text} /> : null}
      </CardContent>
    </Card>
  );
}
