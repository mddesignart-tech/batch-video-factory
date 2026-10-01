"use server";

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { errorMessage } from "@/lib/utils";
import { isInsideData } from "@/lib/paths";
import { prisma } from "@/lib/prisma";
import { getSettings, saveSettings, CONCURRENCY_LIMITS } from "@/lib/settings";
import { validateCustomPreset, BUILT_IN_PRESETS } from "@/domain/output-preset";
import { splitList } from "@/domain/social-metadata";
import { buildWorkspace, type Workspace } from "@/services/daily-workspace";
import { queueView, type QueueRow } from "@/services/daily-history";
import { preflightForApproval, type ApprovalPreflight } from "@/services/batch-executor";
import {
  exportVideos,
  renameBatch,
  rerenderVideo,
  runSelectedVideos,
  runZeroCostVideos,
  saveSocialMeta,
  setBatchMode,
  setBatchPreset,
  setThumbnailChoice,
  storeThumbnailUpload,
  videoDetail,
  type VideoDetail,
} from "@/services/daily-actions";
import { buildBatchSummary, videoListText, writeExportReport, type BatchSummary } from "@/services/export-report";
import { ensureBatchSlug, OUTPUT_ROOT } from "@/services/output-layout";
import { tryLockAction, unlockAction } from "@/services/run-registry";
import type { ActionResult } from "./idioms";

/**
 * The daily workspace's buttons (V1.2 Phase 6, QĐ-114). Thin: every one calls
 * a service the tests call too. No action here reaches a provider by itself -
 * runs go through the production executor and its gates.
 */

function refresh(batchId?: string) {
  revalidatePath("/workspace");
  if (batchId) {
    revalidatePath(`/workspace/${batchId}`);
    revalidatePath(`/batches/${batchId}`);
  }
}

export async function workspaceData(batchId: string): Promise<{ ok: boolean; message: string; workspace?: Workspace }> {
  try {
    const workspace = await buildWorkspace(batchId);
    if (!workspace) return { ok: false, message: "Không tìm thấy lô." };
    return { ok: true, message: "", workspace };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function queueData(): Promise<QueueRow[]> {
  return queueView();
}

export async function renameBatchAction(batchId: string, name: string): Promise<ActionResult> {
  try {
    await renameBatch(batchId, name);
    refresh(batchId);
    return { ok: true, message: "Đã đổi tên lô. Thư mục output giữ nguyên." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function setBatchModeAction(batchId: string, mode: "PARTIAL" | "STRICT"): Promise<ActionResult> {
  try {
    await setBatchMode(batchId, mode);
    refresh(batchId);
    return { ok: true, message: mode === "STRICT" ? "STRICT: lô chỉ chạy khi không video nào bị chặn." : "PARTIAL: video lỗi không chặn video khác." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function setBatchPresetAction(batchId: string, presetId: string): Promise<ActionResult> {
  try {
    await setBatchPreset(batchId, presetId);
    refresh(batchId);
    return {
      ok: true,
      message: "Đã đổi preset. Chỉ ảnh hưởng render/xuất — video đã xong cần RENDER LẠI (tại máy, $0); không tạo lại ảnh/clip/giọng.",
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** KIỂM TRA & DỰ TOÁN for the selected videos (or all). Spends nothing. */
export async function preflightSelectedAction(
  batchId: string,
  projectIds: string[] | null,
  maxBatch?: number,
): Promise<ActionResult & { preflight?: ApprovalPreflight }> {
  try {
    const auth = await prisma.batchAuthorization.findUnique({ where: { batchId }, select: { status: true } });
    const preflight = await preflightForApproval(batchId, {
      maxBatch,
      resume: auth !== null && auth.status !== "DRAFT",
      onlyProjectIds: projectIds ?? undefined,
    });
    return { ok: preflight.ready, message: preflight.ready ? "Dự toán đạt. Chưa gọi API nào." : "Còn điểm chưa đạt — xem danh sách.", preflight };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function runSelectedAction(input: {
  batchId: string;
  projectIds: string[];
  maxBatch?: number;
  maxPerVideo?: number;
  lowAutoApproved?: boolean;
  expectedVideoModels?: string[];
  confirmPaid?: boolean;
  expectedFingerprint?: string;
  /** The person ticked "tôi đồng ý chi tối đa $X" (only when an amount is approved). */
  confirmed?: boolean;
}): Promise<ActionResult & { needsConfirmation?: boolean; fingerprint?: string; amount?: number }> {
  try {
    if (input.maxBatch !== undefined && input.maxBatch > 0 && !input.confirmed) {
      return { ok: false, message: "Chưa xác nhận hạn mức chi. Không chạy." };
    }
    const r = await runSelectedVideos(input);
    refresh(input.batchId);
    if (r.continued?.status === "NEEDS_CONFIRMATION") {
      return {
        ok: false,
        needsConfirmation: true,
        fingerprint: r.continued.fingerprint,
        amount: r.continued.authorizationAmount,
        message: r.continued.message,
      };
    }
    return { ok: r.path !== "CONTINUED" || r.continued?.status !== "BLOCKED", message: r.message };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function runZeroCostAction(batchId: string): Promise<ActionResult> {
  try {
    const r = await runZeroCostVideos(batchId);
    refresh(batchId);
    return { ok: true, message: r.videos.length > 0 ? r.message : "Không có video $0 nào cần chạy." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function rerenderAction(projectId: string): Promise<ActionResult> {
  try {
    const r = await rerenderVideo(projectId);
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { batchId: true } });
    refresh(p?.batchId ?? undefined);
    return { ok: true, message: `Đã render lại tại máy ($0): ${r.dir}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function exportSelectedAction(batchId: string, projectIds: string[]): Promise<ActionResult> {
  const key = `export:${batchId}`;
  if (!tryLockAction(key)) return { ok: false, message: "Đang xuất — không bấm hai lần." };
  try {
    const r = await exportVideos(projectIds);
    refresh(batchId);
    const done = r.filter((x) => x.ok).length;
    const failed = r.filter((x) => !x.ok);
    return {
      ok: failed.length === 0,
      message: `Đã xuất ${done}/${r.length} video.` + (failed.length > 0 ? ` Chưa xuất: ${failed.map((f) => f.message).join("; ")}` : ""),
    };
  } finally {
    unlockAction(key);
  }
}

export async function videoDetailAction(projectId: string): Promise<{ ok: boolean; message: string; detail?: VideoDetail }> {
  try {
    return { ok: true, message: "", detail: await videoDetail(projectId) };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function saveSocialMetaAction(input: {
  projectId: string;
  title: string;
  description: string;
  tags: string;
  hashtags: string;
}): Promise<ActionResult> {
  try {
    await saveSocialMeta(input.projectId, {
      title: input.title,
      description: input.description,
      tags: splitList(input.tags),
      // A hashtag has no spaces: every word is its own tag.
      hashtags: splitList(input.hashtags.replace(/\s+/g, ",")),
    });
    return { ok: true, message: "Đã lưu metadata. Bấm XUẤT LẠI để ghi vào metadata.json / description.txt." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function setThumbnailAction(projectId: string, mode: "DEFAULT" | "SCENE", sceneNumber?: number): Promise<ActionResult> {
  try {
    await setThumbnailChoice(projectId, mode === "SCENE" ? { mode, sceneNumber } : { mode: "DEFAULT" });
    return { ok: true, message: "Đã chọn thumbnail. Bấm XUẤT LẠI để tạo lại (tại máy, $0)." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function uploadThumbnailAction(formData: FormData): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const file = formData.get("file");
    if (!projectId || !(file instanceof File)) return { ok: false, message: "Thiếu ảnh." };
    await storeThumbnailUpload(projectId, Buffer.from(await file.arrayBuffer()));
    return { ok: true, message: "Đã lưu ảnh thumbnail riêng. Bấm XUẤT LẠI để áp dụng (tại máy, $0)." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function exportReportAction(batchId: string): Promise<ActionResult & { csv?: string; json?: string; list?: string; summary?: BatchSummary }> {
  try {
    const r = await writeExportReport(batchId);
    return { ok: true, message: `Đã ghi báo cáo: ${r.csv}`, csv: r.csv, json: r.json, list: videoListText(r.summary), summary: r.summary };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function batchSummaryAction(batchId: string): Promise<{ ok: boolean; message: string; summary?: BatchSummary; list?: string }> {
  try {
    const summary = await buildBatchSummary(batchId);
    return { ok: true, message: "", summary, list: videoListText(summary) };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * MỞ THƯ MỤC LÔ. The folder is resolved from the database and confined to the
 * data root; explorer.exe is detached so a window left open never blocks the
 * page, and a failure to open is reported, never thrown at the batch.
 */
export async function openBatchFolderAction(batchId: string): Promise<ActionResult> {
  try {
    const dir = path.join(OUTPUT_ROOT, await ensureBatchSlug(batchId));
    if (!isInsideData(dir)) return { ok: false, message: "Thư mục nằm ngoài data/." };
    fs.mkdirSync(dir, { recursive: true });
    return openFolder(dir);
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

function openFolder(folder: string): ActionResult {
  const [command, args] =
    process.platform === "win32"
      ? ["explorer.exe", [folder]]
      : process.platform === "darwin"
        ? ["open", [folder]]
        : ["xdg-open", [folder]];
  try {
    const child = spawn(command, args as string[], { detached: true, stdio: "ignore", shell: false });
    child.on("error", () => undefined);
    child.unref();
    return { ok: true, message: `Đã mở ${folder}` };
  } catch (err) {
    return { ok: false, message: `Không mở được thư mục (${errorMessage(err)}). Đường dẫn: ${folder}` };
  }
}

// ------------------------------------------------------------ settings ---

export async function saveDailySettingsAction(input: {
  defaultOutputPresetId: string;
  defaultBatchMode: "PARTIAL" | "STRICT";
  maxConcurrentVideos: number;
  maxConcurrentLocalRenders: number;
  maxConcurrentPaidRequests: number;
  socialTitleTemplate: string;
  socialDescriptionTemplate: string;
}): Promise<ActionResult> {
  try {
    const settings = await getSettings();
    const known = [...BUILT_IN_PRESETS, ...settings.customPresets].some((p) => p.id === input.defaultOutputPresetId);
    if (!known) return { ok: false, message: `Không có preset "${input.defaultOutputPresetId}".` };
    const within = (v: number, k: keyof typeof CONCURRENCY_LIMITS) =>
      Number.isInteger(v) && v >= CONCURRENCY_LIMITS[k].min && v <= CONCURRENCY_LIMITS[k].max;
    if (!within(input.maxConcurrentVideos, "maxConcurrentVideos")) return { ok: false, message: "MAX CONCURRENT VIDEOS phải từ 1 đến 4." };
    if (!within(input.maxConcurrentLocalRenders, "maxConcurrentLocalRenders")) return { ok: false, message: "MAX CONCURRENT LOCAL RENDERS phải từ 1 đến 2." };
    if (!within(input.maxConcurrentPaidRequests, "maxConcurrentPaidRequests")) return { ok: false, message: "MAX CONCURRENT PAID REQUESTS phải từ 1 đến 2." };
    await saveSettings({
      defaultOutputPresetId: input.defaultOutputPresetId,
      defaultBatchMode: input.defaultBatchMode,
      maxConcurrentVideos: input.maxConcurrentVideos,
      maxConcurrentLocalRenders: input.maxConcurrentLocalRenders,
      maxConcurrentPaidRequests: input.maxConcurrentPaidRequests,
      socialTemplates: { title: input.socialTitleTemplate, description: input.socialDescriptionTemplate },
    });
    revalidatePath("/settings");
    return { ok: true, message: "Đã lưu cài đặt sản xuất hằng ngày." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function saveCustomPresetAction(input: unknown): Promise<ActionResult> {
  try {
    const v = validateCustomPreset(input);
    if (!v.ok) return { ok: false, message: v.message };
    const settings = await getSettings();
    const others = settings.customPresets.filter((p) => p.id !== v.preset.id);
    await saveSettings({ customPresets: [...others, v.preset] });
    revalidatePath("/settings");
    return { ok: true, message: `Đã lưu preset "${v.preset.name}".` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function deleteCustomPresetAction(id: string): Promise<ActionResult> {
  try {
    const settings = await getSettings();
    const inUse = await prisma.batch.count({ where: { outputPresetId: id } });
    if (inUse > 0) return { ok: false, message: `Preset đang được ${inUse} lô dùng — đổi preset của các lô đó trước.` };
    if (settings.defaultOutputPresetId === id) return { ok: false, message: "Đây là preset mặc định — chọn mặc định khác trước." };
    await saveSettings({ customPresets: settings.customPresets.filter((p) => p.id !== id) });
    revalidatePath("/settings");
    return { ok: true, message: "Đã xoá preset." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
