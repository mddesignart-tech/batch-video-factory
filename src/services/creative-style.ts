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

export interface BatchCreativeResult {
  /** Videos (projects) whose stored style actually changed. */
  changed: number;
  /** ...of which already have pictures, clips or voice - all kept as they are. */
  withMedia: number;
  /** Planned videos that have no project yet (they follow the batch plan). */
  notStarted: number;
  /** The plan's own style was updated too (batch not approved yet). */
  planUpdated: boolean;
  message: string;
}

/**
 * PHONG CÁCH for a whole batch (QĐ-136): the same `saveCreativeStyle` on every
 * video of the batch. Stores only - never rewrites a script, never touches a
 * scene, never buys an image, clip or voice line.
 *
 * The batch PLAN's style changes only while the batch is not approved: an
 * approved plan is what the operator agreed to (its scene count is priced), so
 * videos not written yet keep the approved style until the batch is stopped
 * and re-estimated.
 */
export async function applyBatchCreativeStyle(batchId: string, input: Partial<StoredCreativeStyle> | null): Promise<BatchCreativeResult> {
  const { storedPlan } = await import("./batch-runner");
  const batch = await prisma.batch.findUniqueOrThrow({
    where: { id: batchId },
    include: { authorization: true, projects: { where: { deletedAt: null }, select: { id: true, idiomId: true } } },
  });
  let changed = 0;
  let withMedia = 0;
  for (const project of batch.projects) {
    const r = await saveCreativeStyle(project.id, input);
    if (r.changed) changed++;
    if (r.changed && r.mediaExists) withMedia++;
  }

  const plan = storedPlan(batch);
  const written = new Set(batch.projects.map((p) => p.idiomId));
  const notStarted = (plan?.videos ?? []).filter((v) => v.idiomId && !written.has(v.idiomId)).length;
  const approved = batch.authorization !== null && batch.authorization.status !== "DRAFT";
  let planUpdated = false;
  if (plan && !approved && batch.status === "PLANNED") {
    plan.creativeStyle = parseCreativeStyle(storedCreativeJson(input));
    await prisma.batch.update({ where: { id: batchId }, data: { planJson: JSON.stringify(plan) } });
    planUpdated = true;
  }
  await logger.info({
    event: "creative.batch_style_saved",
    message: `Lô ${batch.name}: lưu phong cách cho ${changed} video (${withMedia} đã có media, giữ nguyên). $0, không viết lại, không tạo media.`,
  });

  const parts = [`Đã lưu phong cách cho ${changed}/${batch.projects.length} video. Chưa viết lại kịch bản, chưa tạo media nào ($0).`];
  if (withMedia > 0) parts.push(`Media cũ vẫn được giữ (${withMedia} video đã có ảnh/clip/giọng). Viết lại kịch bản từng video nếu muốn áp dụng.`);
  if (planUpdated) parts.push("Kế hoạch lô dùng phong cách mới - bấm DỰ TOÁN LẠI để cập nhật số cảnh và chi phí.");
  else if (notStarted > 0) parts.push(`${notStarted} video chưa viết kịch bản vẫn theo phong cách ĐÃ DUYỆT; dừng lô và dự toán lại nếu muốn đổi.`);
  return { changed, withMedia, notStarted, planUpdated, message: parts.join(" ") };
}
