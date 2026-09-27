import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { approveAndRun } from "@/services/batch-executor";
import { previewProjectCost } from "@/services/project-service";
import { buildVideoResumePlan, continueVideo } from "@/services/video-resume";
import { backfillLegacyAssets } from "@/services/asset-backfill";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { importFolder, makePng, seedMock, writeStoryboard } from "./phase5-helpers";

/**
 * V1.2 Phase 5 - a project made BEFORE Phase 4 / V1.2 (QĐ-113): its assets have
 * no reuse key, no hash, no recipe. It must still open, render and resume, never
 * buy its assets again, and need no manual migration.
 */

let tmp = "";
let capBefore = 0;
let P = { batchId: "", projectId: "" };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5-legacy-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  const blue = fs.readFileSync(await makePng(tmp, "blue"));
  const root = writeStoryboard(tmp, "sb-legacy", "p5-legacy-project", [
    { image: { file: "a.png", bytes: blue }, motion: "LOCAL_MOTION", line: "Legacy one." },
    { motion: "VIDEO_AI", line: "Legacy two.", prompt: "Max nods at a plain beige wall." },
  ]);
  P = await importFolder(root, "legacy");
  await approveAndRun({ batchId: P.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
  // Turn it into a pre-Phase-4 project: what those rows looked like.
  await prisma.asset.updateMany({
    where: { projectId: P.projectId },
    data: { reuseKey: null, sha256: null, durationSec: null, inputsJson: "{}", legacyState: null, validatedAt: null },
  });
  await prisma.providerJob.updateMany({ where: { projectId: P.projectId }, data: { reuseKey: null } });
  const p = await prisma.project.update({ where: { id: P.projectId }, data: { renderRecipe: null } });
  fs.rmSync(toAbsolute(p.finalVideoPath!)); // and its MP4 went missing
}, 900_000);

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-113 — dự án cũ vẫn dùng được", () => {
  it("mở được (dự toán + kế hoạch tiếp tục), không đòi request trả phí nào", async () => {
    const preview = await previewProjectCost(P.projectId);
    expect(preview.current).toBeTruthy();
    const plan = await buildVideoResumePlan(P.projectId);
    expect(plan.paidRequestsRequired.total).toBe(0);
    expect(plan.nextStep).toBe("RENDER_ONLY");
  });

  it("tiếp tục = render tại máy, không mua lại asset, không cần migration tay", async () => {
    const jobs = await prisma.providerJob.count();
    const costs = await prisma.costEntry.count();
    const r = await continueVideo(P.projectId, { wait: true });
    expect(r.status).toBe("COMPLETED");
    const p = await prisma.project.findUniqueOrThrow({ where: { id: P.projectId } });
    expect(p.status).toBe("completed");
    expect(fs.existsSync(toAbsolute(p.finalVideoPath!))).toBe(true);
    expect(p.renderRecipe).toMatch(/^recipe:r1:/);
    expect(await prisma.providerJob.count()).toBe(jobs);
    expect(await prisma.costEntry.count()).toBe(costs);
  });

  it("backfill sau đó vẫn không làm dự án đòi mua lại; lần tiếp theo là NOOP", async () => {
    await backfillLegacyAssets({ apply: true });
    const rows = await prisma.asset.findMany({ where: { projectId: P.projectId, kind: { in: ["image", "video"] }, source: "GENERATED" } });
    // Each legacy row is either LEGACY_UNVERIFIED (no key, own scene only) or was
    // keyed again by Phase 4's idempotency adoption while resuming - the same
    // recorded request, so evidence-backed. Never a key invented from nothing.
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) {
      if (a.reuseKey === null) expect(a.legacyState).toBe("LEGACY_UNVERIFIED");
      else expect(await prisma.providerJob.count({ where: { projectId: P.projectId, kind: a.kind, status: "completed" } })).toBeGreaterThan(0);
    }
    const plan = await buildVideoResumePlan(P.projectId);
    expect(plan.paidRequestsRequired.total).toBe(0);
    expect(plan.nextStep).toBe("NONE");
    expect((await continueVideo(P.projectId, { wait: true })).status).toBe("NOOP");
  });
});
