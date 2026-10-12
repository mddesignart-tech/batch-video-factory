"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { errorMessage } from "@/lib/utils";
import { CLIP_MAX_BYTES, asClipFrame, asClipShortMode } from "@/domain/user-clip";
import {
  assignClipToScene,
  deleteUploadedClip,
  storeUploadedClip,
  unassignClip,
  updateClipSettings,
  uploadClipToScene,
  type ClipSettingsChange,
} from "@/services/uploaded-clip";
import type { ActionResult } from "./idioms";

/**
 * UPLOADED VIDEO CLIP - a person's own clip as a scene's visual.
 *
 * None of these can reach a provider: files are checked locally (ffprobe),
 * stored in the project, and attached. USER VIDEO = REUSE = $0. Changing the
 * clip, its trim or its sound is a LOCAL re-render only - voice, dialogue and
 * subtitles are never regenerated for it.
 */

/** `confirm`: nothing was changed yet - the clip is in use; ask, then call again with confirm. */
export type ClipActionResult = ActionResult & { confirm?: boolean };

const RERENDER = " Video cuối đang dùng hình cũ — bấm Render lại MP4 (tại máy, $0).";

async function fileFrom(formData: FormData): Promise<{ name: string; bytes: Buffer } | string> {
  const entry = formData.get("file");
  if (!entry || typeof entry === "string" || entry.size === 0) return "Chưa chọn video.";
  if (entry.size > CLIP_MAX_BYTES) return `Video "${entry.name}" lớn hơn ${CLIP_MAX_BYTES / 1024 / 1024} MB.`;
  return { name: entry.name, bytes: Buffer.from(await entry.arrayBuffer()) };
}

function describe(info: { durationSec: number; width: number; height: number; fps: number }): string {
  return `${info.durationSec.toFixed(2)} giây, ${info.width}×${info.height}, ${info.fps} fps`;
}

/** Upload a clip and make it this scene's visual (also "Chọn lại file" for a missing one). */
export async function uploadClipForScene(formData: FormData): Promise<ActionResult> {
  try {
    const sceneId = String(formData.get("sceneId") ?? "");
    const file = await fileFrom(formData);
    if (typeof file === "string") return { ok: false, message: file };
    const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!scene) return { ok: false, message: "Không tìm thấy cảnh." };
    const r = await uploadClipToScene({ sceneId, bytes: file.bytes, originalFilename: file.name });
    revalidatePath(`/projects/${scene.projectId}`);
    return {
      ok: true,
      message:
        `Cảnh ${scene.sceneNumber} dùng Video của bạn "${file.name}" (${describe(r.stored.info)}).` +
        (r.stored.deduplicated ? " Clip này đã có trong dự án — dùng lại, không lưu bản thứ hai." : "") +
        ` Không gọi Video AI / Image AI — $0. Lời thoại và phụ đề giữ nguyên.` +
        (r.needsRerender ? RERENDER : ""),
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Upload a clip into the project library only (no scene). */
export async function uploadProjectClip(projectId: string, formData: FormData): Promise<ActionResult> {
  try {
    const file = await fileFrom(formData);
    if (typeof file === "string") return { ok: false, message: file };
    const r = await storeUploadedClip({ projectId, bytes: file.bytes, originalFilename: file.name });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `Đã tải "${file.name}" (${describe(r.info)}) vào dự án.${r.deduplicated ? " Đã có sẵn — dùng lại." : ""} $0.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Use a clip already in the project for this scene ("Chọn asset khác", reuse across scenes). */
export async function assignClipAction(sceneId: string, assetId: string): Promise<ActionResult> {
  try {
    const r = await assignClipToScene(sceneId, assetId);
    revalidatePath(`/projects/${r.scene.projectId}`);
    return { ok: true, message: `Cảnh ${r.scene.sceneNumber} dùng Video của bạn — $0, không gọi API.${r.needsRerender ? RERENDER : ""}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** "Bỏ gán" / back to a picture. The clip stays in the project. */
export async function unassignClipAction(sceneId: string): Promise<ActionResult> {
  try {
    const scene = await unassignClip(sceneId);
    revalidatePath(`/projects/${scene.projectId}`);
    return { ok: true, message: `Cảnh ${scene.sceneNumber} không dùng clip nữa (clip vẫn nằm trong dự án). Không gọi API.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function updateClipSettingsAction(sceneId: string, change: ClipSettingsChange): Promise<ActionResult> {
  try {
    const clean: ClipSettingsChange = {
      ...(change.startSec !== undefined ? { startSec: change.startSec } : {}),
      ...(change.endSec !== undefined ? { endSec: change.endSec } : {}),
      ...(change.audio === "ON" || change.audio === "OFF" ? { audio: change.audio } : {}),
      ...(change.audioGain !== undefined ? { audioGain: Number(change.audioGain) } : {}),
      ...(change.shortMode ? { shortMode: asClipShortMode(change.shortMode) } : {}),
      ...(change.frame ? { frame: asClipFrame(change.frame) } : {}),
    };
    const scene = await updateClipSettings(sceneId, clean);
    revalidatePath(`/projects/${scene.projectId}`);
    return { ok: true, message: "Đã lưu. Chỉ render lại tại máy ($0) — giọng và phụ đề giữ nguyên." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Remove a clip from the project. In use: asks first ("Video này đang được sử dụng ở X scene"). */
export async function deleteClipAction(projectId: string, assetId: string, opts: { confirm?: boolean } = {}): Promise<ClipActionResult> {
  try {
    const r = await deleteUploadedClip(assetId, { confirm: opts.confirm === true });
    if (r.needsConfirmation) {
      return {
        ok: false,
        confirm: true,
        message: `Video này đang được sử dụng ở ${r.usedBy.length} scene (cảnh ${r.usedBy.join(", ")}). Xoá thì các cảnh đó quay về ảnh. Chưa xoá gì.`,
      };
    }
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `Đã xoá clip khỏi dự án${r.usedBy.length ? ` (đã gỡ khỏi cảnh ${r.usedBy.join(", ")})` : ""}.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** A missing clip, and the person chooses Local Motion over the scene's picture ($0). */
export async function clipToLocalMotionAction(sceneId: string): Promise<ActionResult> {
  try {
    const { useLocalMotion } = await import("@/services/scene-video");
    await useLocalMotion(sceneId);
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
    revalidatePath(`/projects/${scene.projectId}`);
    return { ok: true, message: `Cảnh ${scene.sceneNumber} dùng Local Motion trên ảnh của cảnh — $0, không gọi Video AI.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * A missing clip, and the person CHOOSES Video AI for the scene instead. This
 * only records the choice (motion = VIDEO_AI): the price shows in PREFLIGHT and
 * nothing is bought until a run is approved.
 */
export async function clipToVideoAiAction(sceneId: string): Promise<ActionResult> {
  try {
    const scene = await unassignClip(sceneId);
    await prisma.scene.update({ where: { id: sceneId }, data: { motionMode: "VIDEO_AI", motionSource: "AI_VIDEO", status: scene.imagePath ? "image_ready" : "pending", errorMessage: null } });
    revalidatePath(`/projects/${scene.projectId}`);
    return { ok: true, message: `Cảnh ${scene.sceneNumber} sẽ dùng Video AI. Chưa gửi request: xem giá ở PREFLIGHT và duyệt trước khi tạo.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
