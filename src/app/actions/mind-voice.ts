"use server";

import { revalidatePath } from "next/cache";
import { errorMessage } from "@/lib/utils";
import { isMindEngine, parseMindModels, type MindHealth, type MindModelStatus, type MindVoice } from "@/domain/mind-voice";
import { mindInstall, mindModels, mindVerify } from "@/providers/mindvoice/mind-voice-client";
import { mindBaseUrl, refreshMindCatalog } from "@/services/mind-voice-catalog";
import { setTakeSaved, speakInStudio, studioTakes, takeAsMp3, type StudioRequest, type StudioTake } from "@/services/mind-voice-studio";

/**
 * MIND VOICE STUDIO actions (QĐ-145). Everything here talks to the LOCAL
 * service only: status, install (only when the person clicks), speak. $0.
 */

export interface MindStatus {
  online: boolean;
  baseUrl: string;
  message: string;
  health: MindHealth | null;
  voices: MindVoice[];
  models: MindModelStatus[];
}

export async function mindStatusAction(opts: { remoteSizes?: boolean } = {}): Promise<MindStatus> {
  const catalog = await refreshMindCatalog();
  let models: MindModelStatus[] = [];
  if (catalog.online) {
    try {
      models = parseMindModels(await mindModels(catalog.baseUrl, opts.remoteSizes ?? false));
    } catch {
      models = [];
    }
  }
  return {
    online: catalog.online,
    baseUrl: catalog.baseUrl,
    message: catalog.online ? `Đang chạy · ${catalog.voices.length} giọng` : (catalog.error ?? "Mind Voice chưa chạy."),
    health: catalog.health,
    voices: catalog.voices,
    models,
  };
}

/** Starts a model download the person asked for (size and licence shown first). */
export async function mindInstallAction(engine: string, variant: string | null): Promise<{ ok: boolean; message: string }> {
  if (!isMindEngine(engine)) return { ok: false, message: "Engine không hợp lệ." };
  try {
    await mindInstall(await mindBaseUrl(), engine, variant);
    return { ok: true, message: "Đang tải model từ nguồn chính thức và kiểm tra checksum…" };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function mindVerifyAction(engine: string): Promise<{ ok: boolean; message: string }> {
  if (!isMindEngine(engine)) return { ok: false, message: "Engine không hợp lệ." };
  try {
    const r = await mindVerify(await mindBaseUrl(), engine);
    return { ok: r.ok, message: r.message };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function mindSpeakAction(req: StudioRequest): Promise<{ ok: boolean; message: string; take?: StudioTake; reused?: boolean }> {
  try {
    const r = await speakInStudio(req);
    if (!r.ok) return { ok: false, message: r.message };
    revalidatePath("/mind-voice");
    return {
      ok: true,
      message: r.reused ? "Dùng lại bản đã có (cùng nội dung, giọng, cài đặt) - không tạo lại, $0." : `Đã tạo giọng ${r.take.durationSec.toFixed(1)} s - chạy tại máy, $0.`,
      take: r.take,
      reused: r.reused,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function mindTakesAction(): Promise<StudioTake[]> {
  return studioTakes();
}

export async function mindSaveTakeAction(id: string, saved: boolean): Promise<{ ok: boolean; message: string }> {
  const take = setTakeSaved(id, saved);
  revalidatePath("/mind-voice");
  return take ? { ok: true, message: saved ? "Đã lưu vào thư viện giọng." : "Đã bỏ khỏi thư viện giọng." } : { ok: false, message: "Không tìm thấy bản ghi." };
}

export async function mindMp3Action(id: string): Promise<{ ok: boolean; message: string; mp3?: string }> {
  try {
    const take = await takeAsMp3(id);
    return take?.mp3 ? { ok: true, message: "Đã tạo MP3.", mp3: take.mp3 } : { ok: false, message: "Không tìm thấy tệp WAV." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
