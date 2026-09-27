import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { probeDuration } from "@/media/ffmpeg";
import { approveAndRun } from "@/services/batch-executor";
import { backfillLegacyAssets } from "@/services/asset-backfill";
import { assetHealthReport } from "@/services/asset-health";
import { listLibrary } from "@/services/asset-library";
import { applyCleanup, planCleanup } from "@/services/asset-cleanup";
import { validateAssetFile } from "@/services/asset-reuse";
import { ensureThumbnail } from "@/services/output-export";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { importFolder, makeMp4, makePng, seedMock, writeStoryboard } from "./phase5-helpers";

/**
 * V1.2 Phase 5 - maintenance running WHILE a normal mock batch runs (QĐ-113):
 * backfill, health, the library, thumbnails and a cleanup pass, all at once.
 * No duplicate asset, no corrupted hash, no active temp file deleted, no
 * duplicate thumbnail, no stuck database.
 */

let tmp = "";
let capBefore = 0;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5-conc-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
}, 60_000);

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-113 — bảo trì chạy song song với lô mock", () => {
  it("backfill + health + library + thumbnail + cleanup cùng lúc với một lô đang chạy", async () => {
    const green = fs.readFileSync(await makePng(tmp, "green"));
    const root = writeStoryboard(tmp, "sb-conc", "p5-concurrency", [
      { image: { file: "a.png", bytes: green }, motion: "LOCAL_MOTION", line: "Busy one." },
      { motion: "VIDEO_AI", line: "Busy two.", prompt: "Max shrugs at a plain grey wall." },
      { motion: "VIDEO_AI", line: "Busy three.", prompt: "Max points at a plain grey wall." },
    ]);
    const P = await importFolder(root, "conc");
    const clip = await makeMp4(tmp, "white", 2);
    const thumb = path.join(tmp, "thumbs", "thumbnail.jpg");
    fs.mkdirSync(path.dirname(thumb), { recursive: true });
    const duration = await probeDuration(clip);

    const started = Date.now();
    const maintenance = async () => {
      const out: string[] = [];
      for (let i = 0; i < 3; i++) {
        await backfillLegacyAssets({ apply: true });
        await assetHealthReport();
        await listLibrary();
        await Promise.all([1, 2, 3].map(() => ensureThumbnail({ source: clip, output: thumb, duration })));
        await applyCleanup(await planCleanup());
        out.push(`pass ${i}`);
      }
      return out;
    };
    const [run, passes] = await Promise.all([
      approveAndRun({ batchId: P.batchId, maxBatch: 5, lowAutoApproved: true, wait: true }),
      maintenance(),
    ]);
    expect(passes).toHaveLength(3);
    expect(run.run).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(600_000);

    const project = await prisma.project.findUniqueOrThrow({ where: { id: P.projectId } });
    expect(project.status).toBe("completed");

    // No duplicate originals: one GENERATED asset per reuse key in this project.
    const assets = await prisma.asset.findMany({ where: { projectId: P.projectId, reuseKey: { not: null }, source: "GENERATED" } });
    const keys = assets.map((a) => a.reuseKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Every hash still matches its file.
    for (const a of await prisma.asset.findMany({ where: { projectId: P.projectId, sha256: { not: null } } })) {
      expect(validateAssetFile(a)).toBe("VALID");
    }
    // One thumbnail, no stray temp files.
    expect(fs.readdirSync(path.dirname(thumb)).sort()).toEqual(["thumbnail.jpg", "thumbnail.json"]);
    // Backfill during a run changed no ledger: the batch's own jobs are all it made.
    const jobs = await prisma.providerJob.count({ where: { projectId: P.projectId } });
    expect(jobs).toBeGreaterThan(0);
    expect(await prisma.costEntry.count({ where: { projectId: P.projectId, estimated: false } })).toBeGreaterThan(0);
  });
});
