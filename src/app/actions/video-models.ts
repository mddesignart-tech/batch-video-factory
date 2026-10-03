"use server";

import { revalidatePath } from "next/cache";
import { ROUTING_MODES, type RoutingMode } from "@/domain/video-model-profile";
import { errorMessage } from "@/lib/utils";
import {
  saveVideoCapabilityProfile,
  setDefaultVideoModel,
  setVideoRoutingMode,
  testVideoProviderConnection,
  type ConnectionCheck,
} from "@/services/video-model-admin";
import type { ActionResult } from "./idioms";

/** Video AI (Nâng cao). Registry writes and free reads only - never a video. */

export async function setVideoRoutingModeAction(id: string, mode: string): Promise<ActionResult> {
  if (!(ROUTING_MODES as readonly string[]).includes(mode)) return { ok: false, message: "Chế độ không hợp lệ." };
  try {
    await setVideoRoutingMode(id, mode as RoutingMode);
    revalidatePath("/models");
    return { ok: true, message: "Đã đổi chế độ định tuyến." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function setDefaultVideoModelAction(id: string): Promise<ActionResult> {
  try {
    await setDefaultVideoModel(id);
    revalidatePath("/models");
    return { ok: true, message: "Đã đặt làm model mặc định (được gợi ý đầu tiên khi cần chọn)." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function saveVideoProfileAction(id: string, json: string): Promise<ActionResult> {
  try {
    await saveVideoCapabilityProfile(id, JSON.parse(json));
    revalidatePath("/models");
    return { ok: true, message: "Đã lưu hồ sơ khả năng." };
  } catch (err) {
    return { ok: false, message: err instanceof SyntaxError ? "JSON không hợp lệ." : errorMessage(err) };
  }
}

export async function testVideoConnectionAction(provider: string): Promise<ConnectionCheck> {
  return testVideoProviderConnection(provider);
}
