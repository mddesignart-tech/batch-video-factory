"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { errorMessage } from "@/lib/utils";
import { isNarrator, sceneCharacters } from "@/domain/scene-characters";
import { languageOf } from "@/domain/content-options";
import type { OutputControls } from "@/domain/output-controls";
import { getVoiceProvider } from "@/providers/registry";
import {
  clearBackgroundMusic,
  projectControls,
  saveProjectControls,
  setBackgroundMusic,
  subtitlePreviewFrame,
} from "@/services/output-controls";
import { requeueRender } from "@/services/project-service";
import { makeSceneVoice, sceneVoiceStatus, type SceneVoiceResult } from "@/services/scene-voice";
import { voiceSettingsFor } from "@/services/generation";
import type { ActionResult } from "./idioms";

/**
 * VIDEO OUTPUT card (QĐ-125). Everything but the voice is local-render only:
 * $0, no request of any kind. The voice preview goes through the QĐ-117 path
 * (reuse first; a new line only with the person's confirmation of its price).
 */

type Patch = { subtitles?: Partial<OutputControls["subtitles"]>; audio?: Partial<OutputControls["audio"]>; voice?: Partial<OutputControls["voice"]> };

export async function saveOutputControlsAction(projectId: string, patch: Patch): Promise<ActionResult & { voiceChanged?: boolean }> {
  try {
    const r = await saveProjectControls(projectId, patch as never);
    revalidatePath(`/projects/${projectId}`);
    return {
      ok: true,
      voiceChanged: r.voiceChanged,
      message: r.voiceChanged
        ? "Đã đổi giọng. Bấm Nghe thử để xem giá và tạo giọng mới - chưa có request nào được gửi."
        : r.rerenderNeeded
          ? "Đã lưu. Bấm RENDER LẠI để áp dụng - chỉ xử lý tại máy, $0."
          : "Không có gì thay đổi.",
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function previewSubtitleAction(projectId: string, patch?: Patch): Promise<{ ok: boolean; message: string; path?: string; width?: number; height?: number }> {
  try {
    const r = await subtitlePreviewFrame(projectId, { controls: patch as never });
    return { ok: true, message: "", ...r };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function uploadMusicAction(projectId: string, formData: FormData): Promise<ActionResult> {
  const file = formData.get("music");
  if (!file || typeof file === "string" || file.size === 0) return { ok: false, message: "Hãy chọn một file nhạc." };
  if (file.size > 50 * 1024 * 1024) return { ok: false, message: "File nhạc lớn hơn 50 MB." };
  try {
    const r = await setBackgroundMusic(projectId, Buffer.from(await file.arrayBuffer()), file.name);
    await saveProjectControls(projectId, { audio: { musicEnabled: true } });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `Đã thêm nhạc nền (${Math.round(r.durationSec)} giây). Chi phí $0.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function clearMusicAction(projectId: string): Promise<ActionResult> {
  await clearBackgroundMusic(projectId);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Đã bỏ nhạc nền." };
}

export async function rerenderAction(projectId: string): Promise<ActionResult> {
  try {
    await requeueRender(projectId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: "Đang render lại tại máy · $0 API (không gọi Text, Image, Video, Voice API)." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export interface NarratorInfo {
  sceneId: string | null;
  provider: string;
  model: string;
  voiceId: string;
  speed: number;
  instructions: string;
  language: string;
  voices: { id: string; label: string }[];
}

/** GIỌNG THUYẾT MINH as it stands now (read-only, no request). */
export async function narratorInfoAction(projectId: string): Promise<{ ok: boolean; message: string; info?: NarratorInfo }> {
  try {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { scenes: { orderBy: { sceneNumber: "asc" } } } });
    const narrated = project.scenes.find((s) => !s.skipped && sceneCharacters(s).speaking.some(isNarrator) && s.narration.trim());
    const settings = await voiceSettingsFor("Narrator", projectId);
    const own = (await projectControls(projectId)).voice;
    const narrator = await prisma.character.findUnique({ where: { name: "Narrator" } });
    const provider = own.provider ?? narrator?.voiceProvider ?? "mock";
    const model = own.model ?? narrator?.voiceModel ?? "mock-voice-std";
    let voices: { id: string; label: string }[] = [];
    try {
      voices = (await (await getVoiceProvider(provider, model)).listVoices()).map((v) => ({ id: v.id, label: v.label }));
    } catch {
      voices = [];
    }
    return {
      ok: true,
      message: "",
      info: {
        sceneId: narrated?.id ?? null,
        provider,
        model,
        voiceId: settings.voiceId,
        speed: settings.speed,
        instructions: settings.instructions,
        language: languageOf(project.language).label,
        voices,
      },
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * ▶ NGHE THỬ: the first narrated scene's voice. Reused at $0 when text + voice
 * settings are unchanged (QĐ-117); otherwise the price is returned first and a
 * request is sent only with `confirmPaid` and that exact price.
 */
export async function previewNarratorAction(
  projectId: string,
  opts: { confirmPaid?: boolean; expectedCost?: number } = {},
): Promise<SceneVoiceResult & { audioPath?: string | null }> {
  const info = await narratorInfoAction(projectId);
  const sceneId = info.info?.sceneId;
  if (!sceneId) return { status: "BLOCKED", message: "Dự án không có cảnh nào do người dẫn chuyện đọc.", plan: null, postsMade: 0 };
  const plan = await sceneVoiceStatus(sceneId);
  if (plan.expectedPosts > 0 && !opts.confirmPaid) {
    return { status: "NEEDS_CONFIRMATION", message: `Cần tạo ${plan.expectedPosts} câu giọng mới.`, plan, postsMade: 0 };
  }
  const r = await makeSceneVoice(sceneId, opts);
  const line = await prisma.dialogueLine.findFirst({ where: { sceneId, status: "completed" }, orderBy: { lineNumber: "asc" } });
  revalidatePath(`/projects/${projectId}`);
  return { ...r, audioPath: line?.outputPath ?? null };
}
