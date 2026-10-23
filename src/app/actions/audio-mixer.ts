"use server";

import { revalidatePath } from "next/cache";
import { errorMessage } from "@/lib/utils";
import type { OutputControls } from "@/domain/output-controls";
import { AudioPresetValuesSchema, PREVIEW_KINDS, type AudioPreset, type AudioPresetValues, type PreviewKind } from "@/domain/audio-mixer";
import {
  applyAudioPresetToBatch,
  applyAudioPresetToProject,
  audioPreview,
  deleteCustomAudioPreset,
  enqueueBatchRemix,
  enqueueRemix,
  listAudioPresets,
  remixAvailability,
  saveCustomAudioPreset,
  setNewProjectAudioPreset,
  type RemixAvailability,
} from "@/services/audio-mixer-service";
import type { ActionResult } from "./idioms";
import { getSettings, saveSettings } from "@/lib/settings";
import { NEW_PROJECT_MOTION_QUALITIES, type NewProjectMotionQuality } from "@/domain/motion-quality";

/**
 * AUDIO MIXER (QĐ-150). Every action here is local: presets are settings,
 * preview and remix are FFmpeg on this machine. None of them can send a TTS,
 * image, video or text request.
 */

export async function audioPresetsAction(): Promise<{ presets: AudioPreset[]; newProjectPresetId: string | null }> {
  return listAudioPresets();
}

export async function applyAudioPresetAction(projectId: string, presetId: string): Promise<ActionResult & { controls?: OutputControls }> {
  try {
    const controls = await applyAudioPresetToProject(projectId, presetId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, controls, message: "Đã áp preset âm thanh cho video này. Nghe thử hoặc Remix Audio / Render lại để áp vào video ($0 API)." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function saveAudioPresetAction(input: { id?: string | null; name: string; values: AudioPresetValues }): Promise<ActionResult & { id?: string }> {
  try {
    const values = AudioPresetValuesSchema.parse(input.values);
    const p = await saveCustomAudioPreset({ id: input.id ?? null, name: input.name, values });
    return { ok: true, id: p.id, message: `Đã lưu preset "${p.name}".` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function deleteAudioPresetAction(id: string): Promise<ActionResult> {
  try {
    await deleteCustomAudioPreset(id);
    return { ok: true, message: "Đã xoá preset. Các video đã dùng preset này giữ nguyên thiết lập của chúng." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function newProjectMotionQualityAction(): Promise<NewProjectMotionQuality> {
  return (await getSettings()).newProjectMotionQuality;
}

/** QĐ-151: Motion Quality a NEW project starts with. Existing projects never change. */
export async function setNewProjectMotionQualityAction(quality: NewProjectMotionQuality): Promise<ActionResult> {
  try {
    if (!(NEW_PROJECT_MOTION_QUALITIES as readonly string[]).includes(quality)) throw new Error("Lựa chọn không hợp lệ.");
    await saveSettings({ newProjectMotionQuality: quality });
    return { ok: true, message: `Video MỚI dùng ${quality === "SMOOTH_V2" ? "Smooth V2" : "Legacy"}. Video cũ không đổi.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function setNewProjectAudioPresetAction(id: string | null): Promise<ActionResult> {
  try {
    await setNewProjectAudioPreset(id);
    return { ok: true, message: id ? "Video MỚI sẽ bắt đầu với preset này. Video cũ không đổi." : "Video MỚI dùng bộ trộn cũ. Video cũ không đổi." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function audioPreviewAction(
  projectId: string,
  kind: PreviewKind,
  audio?: Partial<OutputControls["audio"]>,
): Promise<ActionResult & { path?: string; label?: string; startSec?: number; endSec?: number }> {
  try {
    if (!PREVIEW_KINDS.includes(kind)) throw new Error("Đoạn nghe thử không hợp lệ.");
    const r = await audioPreview(projectId, kind, audio ? { audio } : undefined);
    return { ok: true, ...r, message: `${r.label}: ${r.startSec.toFixed(1)}–${r.endSec.toFixed(1)} s · trộn tại máy, $0 API.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function remixAvailabilityAction(projectId: string): Promise<RemixAvailability> {
  try {
    return await remixAvailability(projectId);
  } catch (err) {
    return { ok: false, message: errorMessage(err), finalVideoPath: null };
  }
}

export async function remixAudioAction(projectId: string): Promise<ActionResult> {
  try {
    await enqueueRemix(projectId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: "Đã xếp hàng REMIX AUDIO: chỉ trộn lại âm thanh tại máy, giữ nguyên hình, xuất file video MỚI ($0 API)." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function applyAudioPresetToBatchAction(batchId: string, presetId: string): Promise<ActionResult> {
  try {
    const n = await applyAudioPresetToBatch(batchId, presetId);
    revalidatePath(`/batches/${batchId}`);
    return { ok: true, message: `Đã áp preset cho ${n} video của lô. Mỗi video vẫn chỉnh riêng được trong trang video.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function batchRemixAction(batchId: string): Promise<ActionResult> {
  try {
    const r = await enqueueBatchRemix(batchId);
    revalidatePath(`/batches/${batchId}`);
    const skipped = r.skipped.length ? ` Bỏ qua ${r.skipped.length}: ${r.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}.` : "";
    return { ok: r.queued > 0, message: `Đã xếp hàng REMIX AUDIO cho ${r.queued} video (chạy lần lượt theo giới hạn render tại máy, $0 API).${skipped}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
