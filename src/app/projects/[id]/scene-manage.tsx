"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ListChecks, Loader2, Trash2, Undo2 } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { ActionButton, type ActionResult } from "@/components/action-ui";
import { checkStoryboardAction, deleteSceneAction, duplicateSceneAction, restoreSceneAction } from "@/app/actions/trash";
import type { CheckIssue } from "@/services/storyboard-check";

/**
 * QĐ-152 scene management inside the Storyboard: delete (to the trash, with
 * undo), duplicate, and KIỂM TRA KỊCH BẢN. Nothing here regenerates media or
 * renders: $0.
 */

const DELETE_CONFIRM =
  "Bạn muốn xóa cảnh này khỏi Storyboard? Cảnh sẽ được đưa vào Thùng rác, các cảnh còn lại giữ nguyên, video đã render không tự động thay đổi, và có thể khôi phục.";

/** Delete / duplicate buttons for the selected scene. */
export function SceneManageButtons({
  sceneId,
  sceneNumber,
  onDeleted,
  onDone,
  onSelect,
}: {
  sceneId: string;
  sceneNumber: number;
  onDeleted: (info: { sceneId: string; sceneNumber: number }) => void;
  onDone: (r: ActionResult) => void;
  onSelect: (sceneId: string) => void;
}) {
  return (
    <>
      <ActionButton
        size="sm"
        variant="ghost"
        action={async () => {
          const r = await duplicateSceneAction(sceneId);
          if (r.ok && r.sceneId) onSelect(r.sceneId);
          return r;
        }}
        onDone={onDone}
      >
        <Copy className="h-3 w-3" />
        Nhân bản cảnh
      </ActionButton>
      <ActionButton
        size="sm"
        variant="ghost"
        confirm={DELETE_CONFIRM}
        action={async () => {
          const r = await deleteSceneAction(sceneId);
          if (r.ok) onDeleted({ sceneId, sceneNumber });
          return r;
        }}
        onDone={onDone}
      >
        <Trash2 className="h-3 w-3" />
        Xóa cảnh
      </ActionButton>
    </>
  );
}

/** "Hoàn tác" right after a delete. */
export function UndoDeleteBar({ last, onClose }: { last: { sceneId: string; sceneNumber: number } | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (!last) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 bg-warn-500/10 px-3 py-2 text-xs">
      <span className="text-ink-200">{msg ?? `Đã chuyển cảnh ${last.sceneNumber} vào Thùng rác. Storyboard đã thay đổi - hãy render lại để cập nhật video.`}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await restoreSceneAction(last.sceneId);
            setMsg(r.message);
            router.refresh();
            if (r.ok) setTimeout(onClose, 2500);
          })
        }
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />} Hoàn tác
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose}>
        Đóng
      </Button>
    </div>
  );
}

const LEVEL: Record<CheckIssue["level"], { label: string; tone: "danger" | "warn" | "neutral" }> = {
  ERROR: { label: "Lỗi cấu trúc", tone: "danger" },
  WARNING: { label: "Cảnh báo", tone: "warn" },
  INFO: { label: "Tham khảo", tone: "neutral" },
};

/** KIỂM TRA KỊCH BẢN: structure errors, warnings, and word-only content hints. */
export function StoryboardCheck({ projectId, onSelect }: { projectId: string; onSelect: (sceneId: string) => void }) {
  const [pending, start] = useTransition();
  const [issues, setIssues] = useState<CheckIssue[] | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const keyOf = (i: CheckIssue) => `${i.code}:${i.sceneId ?? ""}:${i.message}`;
  const shown = (issues ?? []).filter((i) => !dismissed.has(keyOf(i)));
  return (
    <div className="border-b border-ink-800 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await checkStoryboardAction(projectId);
              setIssues(r.issues ?? []);
              setSummary(r.message);
              setDismissed(new Set());
            })
          }
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListChecks className="h-3 w-3" />} KIỂM TRA KỊCH BẢN
        </Button>
        {summary ? <span className="text-xs text-ink-400">{summary}</span> : null}
      </div>
      {issues ? (
        shown.length === 0 ? (
          <p className="mt-2 text-xs text-ok-500">Không còn vấn đề nào cần xem.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {shown.map((i) => (
              <li key={keyOf(i)} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={LEVEL[i.level].tone}>{LEVEL[i.level].label}</Badge>
                <span className="text-ink-200">{i.message}</span>
                {i.sceneId && i.sceneNumber && i.sceneNumber > 0 ? (
                  <Button size="sm" variant="ghost" onClick={() => onSelect(i.sceneId!)}>
                    Xem cảnh
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setDismissed((d) => new Set([...d, keyOf(i)]))}>
                  Bỏ qua cảnh báo
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {issues ? <p className="mt-1 text-[10px] text-ink-500">Phần nội dung chỉ so sánh chữ (lời thoại, phụ đề, tiêu đề), chưa xem hình ảnh. Không cảnh nào bị xoá tự động.</p> : null}
    </div>
  );
}
