import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { setSpendCap } from "@/services/spend-guard";
import { motionPartsOf, preflightImportedBatch, reconcileCosts, type ImportVideoPreview } from "@/services/import-preflight";
import { importBatch, makePng, seedMock, writeBatchFolder, type P6Video } from "./phase6-helpers";

/**
 * G7 — PREFLIGHT: the motion of each scene split into the parts made on this
 * machine ($0) and the subject motion bought from Video AI. Mock only, $0.
 */

const plan = (extra: object = {}) =>
  JSON.stringify({
    source: "AUTO",
    route: "LOCAL_MOTION",
    camera: { shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN" },
    layers: [
      { id: "fg", layerType: "FOREGROUND", zIndex: 40, label: "Leo", entityType: "CHARACTER", depth: 0.1 },
      { id: "bg", layerType: "BACKGROUND", zIndex: 10, label: "Đường phố", entityType: "ENVIRONMENT", depth: 0.9 },
      { id: "amb-traffic", layerType: "AMBIENT", zIndex: 15, label: "Xe chạy ngang", entityType: "VEHICLE", motionType: "AMBIENT_VIDEO", depth: 0.75 },
    ],
    ...extra,
  });

describe("G7 — các phần chuyển động của một cảnh", () => {
  it("cảnh tại máy: camera / chủ thể / nền / ambient đều $0", () => {
    const parts = motionPartsOf({ scenePlanJson: plan() }, "LOCAL_MOTION", 0);
    expect(parts.map((p) => p.part)).toEqual(["CAMERA", "SUBJECT", "BACKGROUND", "AMBIENT"]);
    expect(parts.every((p) => p.cost === 0)).toBe(true);
  });

  it("cảnh Video AI: CHỈ chuyển động chủ thể có giá; camera nằm trong clip ($0), nền + ambient vẫn $0", () => {
    const parts = motionPartsOf({ scenePlanJson: plan() }, "AI_VIDEO", 0.24);
    expect(parts.find((p) => p.part === "SUBJECT")).toMatchObject({ cost: 0.24, how: "Video AI" });
    expect(parts.filter((p) => p.cost > 0)).toHaveLength(1);
    expect(parts.find((p) => p.part === "CAMERA")!.how).toMatch(/Trong clip Video AI/);
  });

  it("cảnh cũ (chưa có kế hoạch): vẫn có dòng camera tại máy $0", () => {
    const parts = motionPartsOf({ scenePlanJson: null, camera: "slow push in" }, "LOCAL_MOTION", 0);
    expect(parts[0]).toMatchObject({ part: "CAMERA", cost: 0 });
  });

  it("đối soát: đếm phần tại máy và tiền Video AI; KHÔNG cộng thêm vào tổng tạo mới", () => {
    const scene = (motionParts: ReturnType<typeof motionPartsOf>) => ({ reuseFrom: { image: null, video: null, voice: null }, saved: { image: 0, video: 0, voice: 0 }, motionParts });
    const v = {
      breakdown: { required: 0.3, quality: 0, retries: 0, optionalQa: 0, total: 0.3 },
      estimatedCost: 0.3,
      localMotionCount: 1,
      scenes: [scene(motionPartsOf({ scenePlanJson: plan() }, "LOCAL_MOTION", 0)), scene(motionPartsOf({ scenePlanJson: plan() }, "AI_VIDEO", 0.24))],
    } as unknown as ImportVideoPreview;
    const r = reconcileCosts([v], false);
    expect(r.localMotionParts).toBe(7);
    expect(r.paidMotion).toEqual({ parts: 1, cost: 0.24 });
    expect(r.newGeneration).toBe(0.3);
  });
});

describe("G7 — preflight thật (mock DB)", () => {
  let tmp = "";
  const images: Record<string, Buffer> = {};

  beforeAll(async () => {
    await seedMock();
    // Headroom above whatever the shared test database already counts as spent.
    await setSpendCap(((await prisma.costEntry.aggregate({ where: { estimated: false }, _sum: { amount: true } }))._sum.amount ?? 0) + 50);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g7-"));
    for (const [i, c] of ["red", "blue", "green", "yellow", "purple"].entries()) images[`c${i}.png`] = fs.readFileSync(await makePng(path.join(tmp, "src"), c, "270x480"));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("lô nhập 1 cảnh Video AI + 4 cảnh tại máy: mỗi cảnh có danh sách phần; chỉ cảnh Video AI có phần trả phí", async () => {
    const video: P6Video = {
      id: "g7-mix",
      title: "G7 trộn local + Video AI",
      scenes: [
        { image: "c0.png", motion: "VIDEO_AI" as const, duration: 2, line: "A clip line." },
        ...[1, 2, 3, 4].map((i) => ({ image: `c${i}.png`, duration: 1, line: `Local line ${i}.` })),
      ],
    };
    const { batchId } = await importBatch(writeBatchFolder(path.join(tmp, "batch"), [video], images));
    const pre = await preflightImportedBatch(batchId, { persist: false });
    const scenes = pre.videos[0]!.scenes;
    for (const s of scenes) expect(s.motionParts.length).toBeGreaterThan(0);
    const paid = scenes.filter((s) => s.motionParts.some((p) => p.cost > 0));
    expect(paid).toHaveLength(1);
    expect(paid[0]!.motionSource).not.toBe("LOCAL_MOTION");
    for (const s of scenes.filter((x) => x.motionSource === "LOCAL_MOTION")) expect(s.motionParts.every((p) => p.cost === 0)).toBe(true);
    expect(pre.reconciliation.localMotionParts).toBeGreaterThanOrEqual(4);
  }, 180_000);
});
