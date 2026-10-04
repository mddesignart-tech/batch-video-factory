import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { projectContent } from "@/domain/content-legacy";
import { toneOf } from "@/domain/content-options";
import {
  creativeStyleKey,
  parseCreativeStyle,
  storedCreativeJson,
  type StoredCreativeStyle,
} from "@/domain/creative-style";

/**
 * PHONG CÁCH SÁNG TẠO on an existing project (QĐ-127). Saving a style only
 * stores the choice: it never rewrites the script, never touches a scene and
 * never buys anything. A new script comes only from VIẾT LẠI KỊCH BẢN (one text
 * call, free in Mock Mode), and media only after DUYỆT KỊCH BẢN + preflight.
 */

/** Statuses in which VIẾT LẠI KỊCH BẢN is allowed (nothing has been bought yet). */
export const REWRITABLE_STATUSES = ["draft", "script_ready", "needs_review", "failed"] as const;

export interface SaveCreativeResult {
  changed: boolean;
  /** The project already has pictures, clips or voice - they are kept as they are. */
  mediaExists: boolean;
  canRewrite: boolean;
  message: string;
}

export async function saveCreativeStyle(projectId: string, input: Partial<StoredCreativeStyle> | null): Promise<SaveCreativeResult> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { scenes: { select: { imagePath: true, videoPath: true, audioPath: true } } },
  });
  const json = storedCreativeJson(input);
  const before = projectContent(project).creative;
  const nextTone = parseCreativeStyle(json)?.tone;
  const after = projectContent({ ...project, creativeStyleJson: json, tone: nextTone ?? project.tone }).creative;
  const changed = json !== project.creativeStyleJson || creativeStyleKey(before) !== creativeStyleKey(after);

  const mediaExists = project.scenes.some((s) => s.imagePath || s.videoPath || s.audioPath);
  const canRewrite = (REWRITABLE_STATUSES as readonly string[]).includes(project.status);
  if (changed) {
    await prisma.project.update({
      where: { id: projectId },
      // The tone column stays meaningful for older readers.
      data: { creativeStyleJson: json, ...(nextTone ? { tone: toneOf(nextTone).id } : {}) },
    });
    await logger.info({ event: "creative.style_saved", projectId, message: "Đã lưu phong cách sáng tạo. Chưa viết lại kịch bản, chưa tạo media nào ($0)." });
    // QĐ-128: the camera follows the style - AUTO scene plans only (a person's camera stays).
    if (project.scriptJson) {
      const { planProjectScenes } = await import("./scene-plan-service");
      await planProjectScenes(projectId, { onlyPlanned: true });
    }
  }

  const message = !changed
    ? "Phong cách không đổi."
    : mediaExists
      ? canRewrite
        ? "Bạn đã thay đổi phong cách kịch bản. Media cũ vẫn được giữ. Bấm VIẾT LẠI KỊCH BẢN để áp dụng; nếu duyệt kịch bản mới, các cảnh bị thay đổi sẽ cần cập nhật media."
        : "Bạn đã thay đổi phong cách kịch bản. Media cũ vẫn được giữ, không tạo lại gì. Dự án đã bắt đầu tạo media nên không viết lại cả kịch bản - hãy sửa từng cảnh ở Storyboard."
      : "Đã lưu phong cách. Bấm VIẾT LẠI KỊCH BẢN để áp dụng (chỉ viết lại chữ, chưa tạo ảnh/giọng/video).";
  return { changed, mediaExists, canRewrite, message };
}
