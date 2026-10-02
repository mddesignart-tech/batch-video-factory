import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { round } from "@/lib/utils";
import { planSceneVoice, type SceneVoicePlan } from "./generation";

/**
 * "NGHE THỬ GIỌNG" / "Tạo giọng" for ONE scene (voice preview, QĐ-117).
 *
 * The preview IS the production voice: it runs the same generateSceneVoice the
 * batch runs, so the audio is saved as the scene's Asset under its reuse key,
 * and DUYỆT & CHẠY, TIẾP TỤC and render later find it and buy nothing.
 *
 *   all lines DONE / REUSE   -> runs at $0, no TTS POST
 *   any line to buy          -> NEEDS_CONFIRMATION with the cost, no POST
 *   confirmed, same plan     -> exactly the POSTs shown
 *   a lost paid file         -> shown as MISSING_LOCAL_FILE; bought again only
 *                               on this explicit confirmation
 *
 * A second press while the first runs answers ALREADY_RUNNING (per-scene lock,
 * taken before the first await), and the per-reuse-key creation lock inside
 * generateSceneVoice still guards any other caller of the same line.
 */

export type SceneVoiceStatus = "DONE" | "NEEDS_CONFIRMATION" | "BLOCKED" | "ALREADY_RUNNING" | "FAILED";

export interface SceneVoiceResult {
  status: SceneVoiceStatus;
  message: string;
  plan: SceneVoicePlan | null;
  /** TTS ProviderJobs this call created (0 for a reuse). */
  postsMade: number;
}

const running = new Set<string>();

export async function sceneVoiceStatus(sceneId: string): Promise<SceneVoicePlan> {
  return planSceneVoice(sceneId);
}

export async function makeSceneVoice(
  sceneId: string,
  opts: { confirmPaid?: boolean; expectedCost?: number } = {},
): Promise<SceneVoiceResult> {
  if (running.has(sceneId)) {
    return { status: "ALREADY_RUNNING", message: "Giọng của cảnh này đang được tạo - không gửi request thứ hai.", plan: null, postsMade: 0 };
  }
  running.add(sceneId);
  try {
    const plan = await planSceneVoice(sceneId);
    if (plan.lines.length === 0) {
      return { status: "BLOCKED", message: "Cảnh này không có lời thoại / lời dẫn để đọc.", plan, postsMade: 0 };
    }
    const stuck = plan.lines.filter((l) => l.state === "BLOCKED" || l.state === "NEEDS_RECOVERY" || l.state === "INVALID");
    if (stuck.length > 0) {
      return {
        status: "BLOCKED",
        message: stuck.map((l) => `Câu ${l.lineNumber}: ${l.state}${l.message ? ` - ${l.message}` : ""}`).join(" · ") + " KHÔNG gửi request.",
        plan,
        postsMade: 0,
      };
    }
    const money = (n: number) => `$${n.toFixed(6)}${plan.mockMode ? " (giá giả lập Mock Mode)" : ""}`;
    if (plan.expectedPosts > 0) {
      if (!opts.confirmPaid) {
        return {
          status: "NEEDS_CONFIRMATION",
          message: `Cần tạo ${plan.expectedPosts} câu giọng mới, dự toán ${money(plan.incrementalCost)}. Cần xác nhận trước khi gửi.`,
          plan,
          postsMade: 0,
        };
      }
      if (opts.expectedCost !== undefined && Math.abs(round(opts.expectedCost) - plan.incrementalCost) > 1e-9) {
        return {
          status: "BLOCKED",
          message: "PLAN_CHANGED: chi phí giọng đã đổi từ lúc bạn xem. KHÔNG gửi request - hãy xem lại rồi xác nhận.",
          plan,
          postsMade: 0,
        };
      }
    }

    const before = await prisma.providerJob.count({ where: { sceneId, kind: "audio" } });
    try {
      const { executeSceneAsset } = await import("./batch-executor");
      await executeSceneAsset(sceneId, "voice", { allowRebuyMissingVoice: opts.confirmPaid === true && plan.expectedPosts > 0 });
    } catch (err) {
      return { status: "FAILED", message: err instanceof Error ? err.message : String(err), plan, postsMade: 0 };
    }
    const postsMade = (await prisma.providerJob.count({ where: { sceneId, kind: "audio" } })) - before;
    const after = await planSceneVoice(sceneId);
    await logger.info({
      event: "voice.scene_made",
      sceneId,
      message: `Giọng cảnh ${after.sceneNumber}: ${postsMade} TTS POST, ${after.lines.length} câu sẵn sàng.`,
    });
    return {
      status: "DONE",
      message:
        postsMade === 0
          ? "Giọng không đổi - dùng lại file đã có, 0 TTS POST, $0."
          : `Đã tạo ${postsMade} câu giọng mới (${money(plan.incrementalCost)}). Lần chạy sau sẽ dùng lại, $0.`,
      plan: after,
      postsMade,
    };
  } finally {
    running.delete(sceneId);
  }
}
