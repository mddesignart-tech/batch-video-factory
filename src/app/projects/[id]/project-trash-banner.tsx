"use client";

import { RotateCcw } from "lucide-react";
import { Alert } from "@/components/ui";
import { ActionButton } from "@/components/action-ui";
import { restoreProjectAction } from "@/app/actions/trash";

/** QĐ-152: a project opened from a link while it is in the trash. */
export function ProjectTrashBanner({ projectId, deletedAt }: { projectId: string; deletedAt: string }) {
  return (
    <Alert tone="warn" title={`Dự án này đang ở Thùng rác (từ ${new Date(deletedAt).toLocaleString("vi-VN")}).`}>
      <p className="mb-2 text-xs">Dự án bị ẩn khỏi các danh sách và không chạy việc nào. File vẫn còn nguyên.</p>
      <ActionButton size="sm" variant="primary" action={() => restoreProjectAction(projectId)}>
        <RotateCcw className="h-3 w-3" /> Khôi phục dự án
      </ActionButton>
    </Alert>
  );
}
