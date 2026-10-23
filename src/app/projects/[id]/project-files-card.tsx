"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HardDrive, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { ActionButton, type ActionResult } from "@/components/action-ui";
import { cleanTempAction, deleteOutputAction, listOutputsAction, projectStorageAction, restoreOutputAction } from "@/app/actions/trash";
import type { OutputView, StorageView } from "@/services/trash-service";

const media = (p: string) => `/api/media/${p.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
const mb = (n: number | null) => (n === null ? "-" : `${(n / 1e6).toFixed(1)} MB`);

/**
 * QĐ-152: every video this project exported (play, delete to the trash,
 * restore) and its disk use, with DỌN FILE TẠM. Deleting a video never touches
 * the project, its scenes, sources or the other videos.
 */
export function ProjectFilesCard({ projectId, storyboardChanged }: { projectId: string; storyboardChanged: boolean }) {
  const router = useRouter();
  const [outputs, setOutputs] = useState<OutputView[] | null>(null);
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const reload = () => {
    void listOutputsAction(projectId).then(setOutputs);
    void projectStorageAction(projectId).then(setStorage);
  };
  useEffect(reload, [projectId]);
  const done = (r: ActionResult) => {
    setMsg(r);
    reload();
  };

  const live = (outputs ?? []).filter((o) => !o.deletedAt);
  const trashed = (outputs ?? []).filter((o) => o.deletedAt);
  return (
    <Card id="ban-video">
      <CardHeader>
        <CardTitle>Các bản video đã xuất &amp; dung lượng</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {storyboardChanged ? (
          <Alert tone="warn" title="Storyboard đã thay đổi. Hãy render lại để cập nhật video.">
            Video bên dưới là bản render trước - chưa phản ánh thay đổi mới. Không có gì bị ghi đè hay tự render lại.
          </Alert>
        ) : null}
        {outputs === null ? (
          <p className="text-xs text-ink-500">Đang tải…</p>
        ) : live.length === 0 ? (
          <p className="text-xs text-ink-500">Chưa có video nào đã xuất (hoặc tất cả đang ở Thùng rác).</p>
        ) : (
          <ul className="space-y-1.5">
            {live.map((o) => (
              <li key={o.assetId} className="flex flex-wrap items-center gap-2 rounded border border-ink-800 px-2 py-1.5 text-xs">
                <span className="font-mono text-ink-200">{o.name}</span>
                {o.current ? <Badge tone="ok">Đang dùng</Badge> : null}
                {o.kind === "remix-audio" ? <Badge tone="info">Remix Audio</Badge> : null}
                {!o.exists ? <Badge tone="danger">Mất file</Badge> : null}
                <span className="text-ink-500">{new Date(o.createdAt).toLocaleString("vi-VN")} · {mb(o.bytes)}</span>
                {o.exists ? (
                  <Button size="sm" variant="ghost" onClick={() => setPlaying(playing === o.file ? null : o.file)}>
                    {playing === o.file ? "Ẩn" : "Xem"}
                  </Button>
                ) : null}
                <ActionButton
                  size="sm"
                  variant="ghost"
                  confirm={`Chuyển ${o.name} vào Thùng rác? Dự án, các cảnh, ảnh, giọng, âm thanh nguồn và các bản video khác giữ nguyên. Có thể khôi phục.`}
                  action={() => deleteOutputAction(o.assetId)}
                  onDone={done}
                >
                  <Trash2 className="h-3 w-3" /> Xóa video
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
        {playing ? <video src={media(playing)} controls className="max-h-[480px] rounded border border-ink-700" /> : null}
        {trashed.length > 0 ? (
          <div className="space-y-1">
            <p className="text-[11px] text-ink-500">Trong Thùng rác (file vẫn còn trên đĩa):</p>
            {trashed.map((o) => (
              <div key={o.assetId} className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                <span className="font-mono line-through">{o.name}</span>
                <span>{mb(o.bytes)}</span>
                <ActionButton size="sm" variant="ghost" action={() => restoreOutputAction(o.assetId)} onDone={done}>
                  <RotateCcw className="h-3 w-3" /> Khôi phục
                </ActionButton>
              </div>
            ))}
          </div>
        ) : null}

        <div className="space-y-1 border-t border-ink-800 pt-3">
          <p className="flex items-center gap-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
            <HardDrive className="h-3 w-3" /> Dung lượng dự án
          </p>
          {storage ? (
            <>
              <ul className="grid gap-x-4 text-xs text-ink-300 sm:grid-cols-2">
                {storage.categories.map((c) => (
                  <li key={c.key} className="flex justify-between gap-2">
                    <span>{c.label} ({c.files})</span>
                    <span>{mb(c.bytes)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink-400">
                Tổng trong thư mục dự án: <b>{mb(storage.ownBytes)}</b>
                {storage.sharedBytes > 0 ? ` · trong đó ${mb(storage.sharedBytes)} dùng chung với dự án khác (không thu hồi khi xoá)` : ""}
                {storage.borrowedBytes > 0 ? ` · dùng thêm ${mb(storage.borrowedBytes)} file dùng chung bên ngoài (không tính là của dự án)` : ""}
                {storage.outputCopiesBytes > 0 ? ` · bản xuất trong thư mục output ${mb(storage.outputCopiesBytes)}` : ""}
              </p>
            </>
          ) : (
            <p className="text-xs text-ink-500">Đang tính…</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await cleanTempAction(projectId);
                  done(r);
                  router.refresh();
                })
              }
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} DỌN FILE TẠM
            </Button>
            <span className="text-[11px] text-ink-500">Chỉ xoá thư mục temp và file .tmp/.part không còn được dùng. Không xoá ảnh, giọng, track Remix, video nguồn, video output.</span>
          </div>
        </div>
        {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.message} /> : null}
      </CardContent>
    </Card>
  );
}
