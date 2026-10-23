"use server";

import { revalidatePath } from "next/cache";
import { errorMessage } from "@/lib/utils";
import {
  cleanProjectTemp,
  deleteOutput,
  deleteScene,
  duplicateProject,
  duplicateScene,
  listOutputs,
  projectStorage,
  purgeOutput,
  purgeProject,
  purgeScene,
  restoreOutput,
  restoreProject,
  restoreScene,
  trashProjects,
  type OutputView,
  type PurgeReport,
  type StorageView,
} from "@/services/trash-service";
import { checkStoryboard, type CheckIssue } from "@/services/storyboard-check";
import type { ActionResult } from "./idioms";

/**
 * QĐ-152 project & scene management. Soft delete first (Thùng rác), restore
 * any time, permanent delete only from the trash and only for files proven
 * unused. No action here calls an AI provider or renders anything.
 */

const fail = (err: unknown): ActionResult => ({ ok: false, message: errorMessage(err) });
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const purgeText = (r: PurgeReport) =>
  `xoá ${r.deletedFiles} file (${mb(r.freedBytes)})` +
  (r.keptShared.length ? `, giữ ${r.keptShared.length} file còn được dùng ở nơi khác` : "") +
  (r.failed.length ? `, ${r.failed.length} file không xoá được (đã ghi nhật ký)` : "");

function touch(projectId?: string) {
  if (projectId) revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  revalidatePath("/trash");
}

// ---- scenes ----------------------------------------------------------------

export async function deleteSceneAction(sceneId: string): Promise<ActionResult & { sceneId?: string }> {
  try {
    const r = await deleteScene(sceneId);
    touch(r.projectId);
    return { ok: true, sceneId, message: `Đã chuyển cảnh ${r.sceneNumber} vào Thùng rác. Video đã render không đổi - hãy render lại để cập nhật.` };
  } catch (err) {
    return fail(err);
  }
}

export async function restoreSceneAction(sceneId: string, position?: number): Promise<ActionResult> {
  try {
    const r = await restoreScene(sceneId, position);
    touch(r.projectId);
    return { ok: true, message: `Đã khôi phục cảnh vào vị trí ${r.sceneNumber}.` };
  } catch (err) {
    return fail(err);
  }
}

export async function duplicateSceneAction(sceneId: string): Promise<ActionResult & { sceneId?: string }> {
  try {
    const r = await duplicateScene(sceneId);
    touch(r.projectId);
    return { ok: true, sceneId: r.sceneId, message: `Đã nhân bản thành cảnh ${r.sceneNumber} (dùng lại ảnh, giọng, camera có sẵn - $0).` };
  } catch (err) {
    return fail(err);
  }
}

export async function purgeSceneAction(sceneId: string): Promise<ActionResult> {
  try {
    const r = await purgeScene(sceneId);
    touch();
    return { ok: true, message: `Đã xoá vĩnh viễn cảnh: ${purgeText(r)}.` };
  } catch (err) {
    return fail(err);
  }
}

export async function checkStoryboardAction(projectId: string): Promise<{ ok: boolean; message: string; issues?: CheckIssue[] }> {
  try {
    const r = await checkStoryboard(projectId);
    const n = (l: string) => r.issues.filter((i) => i.level === l).length;
    return { ok: true, issues: r.issues, message: `Đã kiểm tra ${r.checkedScenes} cảnh: ${n("ERROR")} lỗi cấu trúc, ${n("WARNING")} cảnh báo, ${n("INFO")} thông tin.` };
  } catch (err) {
    return fail(err);
  }
}

// ---- video outputs --------------------------------------------------------

export async function listOutputsAction(projectId: string): Promise<OutputView[]> {
  return listOutputs(projectId);
}

export async function deleteOutputAction(assetId: string): Promise<ActionResult> {
  try {
    const r = await deleteOutput(assetId);
    touch(r.projectId);
    return { ok: true, message: r.newCurrent ? "Đã chuyển video vào Thùng rác. Bản mới nhất còn lại được dùng làm video của dự án." : "Đã chuyển video vào Thùng rác. Dự án hiện chưa có video - render lại khi cần." };
  } catch (err) {
    return fail(err);
  }
}

export async function restoreOutputAction(assetId: string): Promise<ActionResult> {
  try {
    const r = await restoreOutput(assetId);
    touch(r.projectId);
    return { ok: true, message: "Đã khôi phục video." };
  } catch (err) {
    return fail(err);
  }
}

export async function purgeOutputAction(assetId: string): Promise<ActionResult> {
  try {
    const r = await purgeOutput(assetId);
    touch();
    return { ok: true, message: `Đã xoá vĩnh viễn video: ${purgeText(r)}.` };
  } catch (err) {
    return fail(err);
  }
}

// ---- projects ---------------------------------------------------------------

export async function trashProjectsAction(ids: string[]): Promise<ActionResult> {
  try {
    if (ids.length === 0) return { ok: false, message: "Chưa chọn dự án nào." };
    const r = await trashProjects(ids);
    touch();
    const ok = r.filter((x) => x.ok).length;
    const notOk = r.filter((x) => !x.ok);
    return { ok: ok > 0, message: `Đã chuyển ${ok}/${r.length} dự án vào Thùng rác.${notOk.length ? ` Chưa xoá: ${notOk.map((x) => `${x.title} (${x.message})`).join("; ")}` : ""}` };
  } catch (err) {
    return fail(err);
  }
}

export async function restoreProjectAction(id: string): Promise<ActionResult> {
  try {
    await restoreProject(id);
    touch(id);
    return { ok: true, message: "Đã khôi phục dự án." };
  } catch (err) {
    return fail(err);
  }
}

export async function purgeProjectAction(id: string): Promise<ActionResult> {
  try {
    const r = await purgeProject(id);
    touch();
    return { ok: true, message: `Đã xoá vĩnh viễn "${r.title}": ${purgeText(r)}.` };
  } catch (err) {
    return fail(err);
  }
}

export async function duplicateProjectAction(id: string): Promise<ActionResult & { id?: string }> {
  try {
    const r = await duplicateProject(id);
    touch();
    return { ok: true, id: r.id, message: `Đã tạo "${r.title}" (chép ${r.filesCopied} file, ${mb(r.bytesCopied)}). Không gọi AI, không render - $0.` };
  } catch (err) {
    return fail(err);
  }
}

// ---- storage ----------------------------------------------------------------

export async function projectStorageAction(id: string): Promise<StorageView | null> {
  try {
    return await projectStorage(id);
  } catch {
    return null;
  }
}

export async function cleanTempAction(id: string): Promise<ActionResult> {
  try {
    const r = await cleanProjectTemp(id);
    touch(id);
    return { ok: true, message: `Dọn file tạm: ${purgeText(r)}.` };
  } catch (err) {
    return fail(err);
  }
}
