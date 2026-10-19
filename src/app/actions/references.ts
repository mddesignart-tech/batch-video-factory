"use server";

import { revalidatePath } from "next/cache";
import { isReferenceType } from "@/domain/reference";
import { errorMessage } from "@/lib/utils";
import { prisma } from "@/lib/prisma";
import { IMPORT_MAX_BYTES } from "@/services/imported-image";
import {
  autoAssignReferences,
  changeReference,
  confirmSceneWithoutReferences,
  createReference,
  heldMessage,
  setSceneReferences,
} from "@/services/reference-assets";
import { planProjectScenes } from "@/services/scene-plan-service";
import type { ActionResult } from "./idioms";

/** `confirm`: nothing was saved yet - the change would make a bought picture stale. Ask, then call again with `{ confirm: true }`. */
export type ReferenceActionResult = ActionResult & { confirm?: boolean };

/**
 * Tài sản tham chiếu (QĐ-124). Every action here is $0: files go into the Asset
 * Library and rows are written - no provider is ever called.
 */

/**
 * A reference changed what stands in or behind the scenes (a location picture
 * names the background and its ambient): AUTO scene plans are drawn again.
 * USER plans stay as they are. $0; a failure here never fails the action.
 */
async function replan(projectId: string): Promise<void> {
  try {
    await planProjectScenes(projectId, { onlyPlanned: true });
  } catch {
    // The reference itself is saved; the plans refresh on the next change.
  }
}

async function filesFrom(formData: FormData): Promise<{ bytes: Buffer; filename: string }[] | string> {
  const out: { bytes: Buffer; filename: string }[] = [];
  for (const entry of formData.getAll("files")) {
    if (typeof entry === "string" || entry.size === 0) continue;
    if (entry.size > IMPORT_MAX_BYTES) return `Ảnh "${entry.name}" lớn hơn 40 MB.`;
    out.push({ bytes: Buffer.from(await entry.arrayBuffer()), filename: entry.name });
  }
  return out;
}

export async function addReferenceAction(projectId: string, formData: FormData): Promise<ActionResult> {
  const type = String(formData.get("type") ?? "");
  if (!isReferenceType(type)) return { ok: false, message: "Hãy chọn loại tham chiếu." };
  const files = await filesFrom(formData);
  if (typeof files === "string") return { ok: false, message: files };
  try {
    const created = await createReference({
      projectId,
      type,
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      useThroughout: formData.get("useThroughout") === "on",
      uploads: files,
    });
    // Only the NEW reference is added where it fits; every existing list stays.
    const assigned = formData.get("assign") !== "off" ? await autoAssignReferences(projectId, { onlyRefIds: [created.id] }) : null;
    await replan(projectId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `Đã thêm tham chiếu và gắn vào các cảnh phù hợp. Chi phí $0.${assigned ? heldMessage(assigned.held) : ""}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function addReferencePicturesAction(projectId: string, refId: string, formData: FormData): Promise<ActionResult> {
  const files = await filesFrom(formData);
  if (typeof files === "string") return { ok: false, message: files };
  try {
    await changeReference(refId, { uploads: files });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `Đã thêm ${files.length} ảnh. Chi phí $0.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function updateReferenceAction(
  projectId: string,
  refId: string,
  change: { primaryAssetId?: string; enabled?: boolean; useThroughout?: boolean; name?: string; description?: string; priority?: "CRITICAL" | "IMPORTANT" | "OPTIONAL" },
  opts: { confirm?: boolean } = {},
): Promise<ReferenceActionResult> {
  try {
    const r = await changeReference(refId, { ...change, confirmInvalidate: opts.confirm === true });
    if (r.needsConfirmation) {
      return {
        ok: false,
        confirm: true,
        message: `Cảnh ${r.staleScenes!.join(", ")} đã có ảnh tạo sẵn với tham chiếu này. Đổi thì các ảnh đó không còn khớp: cảnh cần ảnh mới (trả phí - xem chi phí ở PREFLIGHT trước khi tạo). Chưa lưu gì.`,
      };
    }
    // "Xuyên suốt video" ON adds this reference where it is missing - except
    // where a person removed it by hand; OFF and "Đang dùng" never touch a
    // scene's list (a hand-made assignment stays).
    const assigned = change.useThroughout === true ? await autoAssignReferences(projectId, { onlyRefIds: [refId] }) : null;
    if (change.useThroughout !== undefined || change.enabled !== undefined) await replan(projectId);
    revalidatePath(`/projects/${projectId}`);
    const touched = [...r.invalidatedScenes, ...r.rephotographedScenes];
    return {
      ok: true,
      message:
        (touched.length
          ? `Đã cập nhật. Chỉ cảnh ${touched.join(", ")} cần ảnh mới - xem chi phí ở PREFLIGHT trước khi tạo. Giọng và phụ đề giữ nguyên.`
          : "Đã cập nhật. Không cảnh nào cần tạo lại.") + (assigned ? heldMessage(assigned.held) : ""),
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function setSceneReferencesAction(projectId: string, sceneId: string, ids: string[], opts: { confirm?: boolean } = {}): Promise<ReferenceActionResult> {
  try {
    const r = await setSceneReferences(sceneId, ids, { confirmInvalidate: opts.confirm === true, manual: true });
    if (r.needsConfirmation) {
      return {
        ok: false,
        confirm: true,
        message: `Cảnh ${r.sceneNumber} đã có ảnh tạo sẵn. Đổi tham chiếu thì ảnh đó không còn khớp: cảnh cần ảnh mới (trả phí - xem chi phí ở PREFLIGHT trước khi tạo). Chưa lưu gì.`,
      };
    }
    await replan(projectId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: r.invalidated ? "Đã đổi tham chiếu của cảnh - cảnh này cần ảnh mới (xem chi phí trước khi tạo)." : "Đã lưu." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function autoAssignReferencesAction(projectId: string): Promise<ActionResult> {
  try {
    const assigned = await autoAssignReferences(projectId);
    await replan(projectId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `Đã tự gắn tham chiếu cho các cảnh chưa có. Cảnh đã gắn tay giữ nguyên.${heldMessage(assigned.held)}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** "TIẾP TỤC KHÔNG DÙNG THAM CHIẾU" - only from a person's explicit confirmation. */
export async function continueWithoutReferencesAction(projectId: string, sceneId: string, confirmed: boolean): Promise<ActionResult> {
  try {
    const scene = await prisma.scene.findFirst({ where: { id: sceneId, projectId } });
    if (!scene) return { ok: false, message: "Không tìm thấy cảnh." };
    await confirmSceneWithoutReferences(sceneId, confirmed);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: confirmed ? "Cảnh này sẽ tạo ảnh không có ảnh tham chiếu bắt buộc." : "Cảnh này lại yêu cầu ảnh tham chiếu." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
