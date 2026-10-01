import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { setSpendCap } from "@/services/spend-guard";
import { runZeroCostVideos } from "@/services/daily-actions";
import { buildWorkspace } from "@/services/daily-workspace";
import { preflightImportedBatch } from "@/services/import-preflight";
import { importBatch, makePng, moneyCounts, seedMock } from "./phase6-helpers";

/**
 * V1.2 final QA (Phase 7) regressions, mock only.
 *
 * 1. One video naming a character with neither reference image nor description
 *    used to fail the WHOLE batch's estimate (the reuse-key pass composed its
 *    image request and the identity refusal escaped). Every card then read
 *    "0 cảnh · $0" and nothing could run. Now only that video is BLOCKED.
 * 2. The workspace view is polled every 3 s while videos run; its preflight
 *    wrote the plan, the DRAFT figures, each video's estimate and a log line on
 *    every poll, contending with the run for SQLite's single writer. The
 *    read-only preflight writes nothing.
 */

let tmp = "";
let batchId = "";
let ids: Record<string, string> = {};
const STRANGER = "Qastranger";

function scene(n: number, extra: Record<string, unknown>) {
  return {
    scene_number: n,
    duration: 1,
    character_action: "Stands still.",
    camera: "Locked static medium shot, no camera movement.",
    motion_mode: "LOCAL_MOTION",
    priority: "NORMAL",
    ...extra,
  };
}

beforeAll(async () => {
  await seedMock();
  await setSpendCap(100);
  await prisma.character.deleteMany({ where: { name: STRANGER } });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p7-qa-"));
  const root = path.join(tmp, "Lô QA – có dấu");
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(await makePng(path.join(tmp, "src"), "teal", "270x480"), path.join(root, "a.png"));
  const doc = {
    videos: [
      {
        video_id: "ok",
        video_title: "Video ổn",
        characters: [{ character_id: "max", character_name: "Max" }],
        scenes: [1, 2].map((n) => scene(n, { visual_description: `Max on a plain wall, shot ${n}.`, image_file: "a.png" })),
      },
      {
        video_id: "stranger",
        video_title: "Nhân vật lạ",
        characters: [{ character_id: "qs", character_name: STRANGER }],
        // No image: the keyframe would be generated, and the character has no sheet.
        scenes: [1, 2].map((n) => scene(n, { character_id: "qs", visual_description: `${STRANGER} on a plain wall, shot ${n}.` })),
      },
    ],
  };
  fs.writeFileSync(path.join(root, "storyboard.json"), JSON.stringify(doc, null, 2));
  ({ batchId, ids } = await importBatch(root));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("V1.2 final QA — nhân vật thiếu tham chiếu chỉ chặn đúng video đó", () => {
  it("dự toán cả lô vẫn chạy; video có nhân vật lạ BỊ CHẶN với lý do rõ; video kia SẴN SÀNG", async () => {
    const pre = await preflightImportedBatch(batchId);
    const of = (k: string) => pre.videos.find((v) => v.projectId === ids[k])!;
    expect(of("stranger").lifecycle).toBe("BLOCKED");
    expect(of("stranger").blockedReason).toContain(STRANGER);
    expect(of("ok").lifecycle).not.toBe("BLOCKED");
    expect(of("ok").scenes.length).toBe(2);
  });

  it("PARTIAL: chạy $0 hoàn tất video ổn, không gọi Image API cho nhân vật lạ", async () => {
    const before = await moneyCounts();
    await runZeroCostVideos(batchId, { wait: true });
    const ok = await prisma.project.findUniqueOrThrow({ where: { id: ids.ok! } });
    const stranger = await prisma.project.findUniqueOrThrow({ where: { id: ids.stranger! } });
    expect(ok.status).toBe("completed");
    expect(stranger.status).not.toBe("completed");
    expect(await moneyCounts()).toEqual(before);
  }, 600_000);
});

describe("V1.2 final QA — trang làm việc đọc mà không ghi", () => {
  it("preflight persist:false (và buildWorkspace) không ghi plan, DRAFT, dự toán video hay log", async () => {
    const snapshot = async () => ({
      batch: await prisma.batch.findUniqueOrThrow({ where: { id: batchId }, select: { planJson: true, estimatedCost: true, updatedAt: true } }),
      projects: await prisma.project.findMany({ where: { batchId }, select: { id: true, estimatedCost: true, updatedAt: true }, orderBy: { id: "asc" } }),
      logs: await prisma.logEntry.count(),
    });
    // Make the stored figures differ from what a fresh preflight would write.
    await prisma.batch.update({ where: { id: batchId }, data: { planJson: "{}", estimatedCost: 123 } });
    const before = await snapshot();
    const ro = await preflightImportedBatch(batchId, { persist: false });
    expect(ro.videos.length).toBe(2);
    const ws = await buildWorkspace(batchId);
    expect(ws?.videos.length).toBe(2);
    expect(await snapshot()).toEqual(before);
    // The default still persists (approval / run paths rely on it).
    await preflightImportedBatch(batchId);
    const after = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(after.planJson).not.toBe("{}");
  });
});
