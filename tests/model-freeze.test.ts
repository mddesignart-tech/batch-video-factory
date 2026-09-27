import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun, runBatch } from "@/services/batch-executor";
import { assertBatchAuthorized, BatchAuthorizationError, resumeAuthorization } from "@/services/batch-authorization";
import { frozenChoicesForBatch, replanVideoModels, type FrozenVideoChoice } from "@/services/frozen-video";
import { buildVideoResumePlan, continueVideo } from "@/services/video-resume";

/**
 * QĐ-111 - the video model an approval covers is the model the POST uses.
 * Mock providers only ($0). Each case checks what was actually CREATED
 * (ProviderJob rows), not what a plan says.
 */

let tmp = "";
let PNG: Buffer;
let seq = 0;
let capBefore = 0;

async function seedMock(): Promise<void> {
  for (const provider of SEED_PROVIDERS.filter((p) => p.name === "mock")) {
    await prisma.providerConfig.upsert({
      where: { name: provider.name },
      create: { ...provider, types: JSON.stringify(provider.types), status: "connected" },
      update: { enabled: true, status: "connected" },
    });
  }
  for (const model of SEED_MODELS.filter((m) => m.provider === "mock")) {
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: model.provider, modelId: model.modelId } },
      create: model,
      update: { enabled: true },
    });
  }
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({ where: { slug: preset.slug }, create: { ...preset, aspectRatio: "9:16" }, update: {} });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: { ...character, voiceProvider: "mock", enabled: true },
      update: {},
    });
  }
}

/** One video: scene 1 LOCAL_MOTION, scene 2 VIDEO_AI (a paid clip). */
async function importOne(opts: { pin?: string } = {}): Promise<{ batchId: string; projectId: string; clipSceneId: string }> {
  seq += 1;
  const name = `mf-${seq}`;
  const dir = path.join(tmp, name, "v");
  fs.mkdirSync(dir, { recursive: true });
  const scenes = [1, 2].map((n) => {
    fs.writeFileSync(path.join(dir, `s${n}.png`), PNG);
    return {
      scene_number: n,
      duration: 3,
      visual_description: `Max against a plain wall, shot ${n}.`,
      character_action: "Max holds still.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: `Max: "Line ${n}."`,
      subtitle: `Line ${n}.`,
      image_file: `s${n}.png`,
      motion_mode: n === 2 ? "VIDEO_AI" : "LOCAL_MOTION",
      priority: n === 2 ? "HIGH" : "LOW",
    };
  });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: name, video_title: name, characters: [{ character_id: "max", character_name: "Max" }], scenes }),
  );
  const validated = await validateImport(scanImportSource(path.join(tmp, name)));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, { batchName: name, maxCostPerVideo: 5, maxCostForBatch: 50 });
  const projectId = created.projects[0]!.projectId;
  const clip = await prisma.scene.findFirstOrThrow({ where: { projectId, sceneNumber: 2 } });
  if (opts.pin) {
    await prisma.scene.update({
      where: { id: clip.id },
      data: { videoProvider: "mock", videoModel: opts.pin, videoModelPinned: true },
    });
  }
  return { batchId: created.batchId, projectId, clipSceneId: clip.id };
}

async function frozenOf(batchId: string, sceneId: string): Promise<FrozenVideoChoice> {
  const map = await frozenChoicesForBatch(batchId);
  expect(map).not.toBeNull();
  expect(map![sceneId]).toBeDefined();
  return map![sceneId]!;
}

async function videoJobs(projectId: string) {
  return prisma.providerJob.findMany({ where: { projectId, kind: "video" }, orderBy: { createdAt: "asc" } });
}

async function counts(projectId: string) {
  return {
    jobs: await prisma.providerJob.count({ where: { projectId } }),
    video: await prisma.providerJob.count({ where: { projectId, kind: "video" } }),
    costs: await prisma.costEntry.count({ where: { projectId } }),
    reservations: await prisma.costReservation.count({ where: { projectId } }),
  };
}

/** The clip was never bought (as far as this video knows): it must be bought again. */
async function dropClip(projectId: string, sceneId: string): Promise<void> {
  const keys = (await prisma.providerJob.findMany({ where: { sceneId, kind: "video" } })).map((j) => j.idempotencyKey);
  await prisma.costReservation.deleteMany({ where: { idempotencyKey: { in: keys } } });
  await prisma.providerJob.deleteMany({ where: { sceneId, kind: "video" } });
  // Never bought = no Asset row either; otherwise the reuse engine (QĐ-112) re-attaches it at $0.
  await prisma.asset.deleteMany({ where: { sceneId, kind: "video" } });
  await prisma.scene.update({ where: { id: sceneId }, data: { videoPath: null, status: "image_ready" } });
  await prisma.project.update({ where: { id: projectId }, data: { status: "failed" } });
}

async function setModel(modelId: string, data: { enabled?: boolean; reliability?: string; price?: number }): Promise<void> {
  await prisma.modelRegistry.update({ where: { provider_modelId: { provider: "mock", modelId } }, data });
}

async function restoreMockModels(): Promise<void> {
  for (const m of SEED_MODELS.filter((x) => x.provider === "mock" && x.type === "video")) {
    await setModel(m.modelId, { enabled: true, reliability: "OK", price: m.price });
  }
  await prisma.modelRegistry.updateMany({ where: { provider: "mock", modelId: "mock-video-cheap" }, data: { enabled: false } });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model-freeze-"));
  const file = path.join(tmp, "k.png");
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=1080x1920", "-frames:v", "1", file]);
  PNG = fs.readFileSync(file);
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 30) * 1e6) / 1e6);
}, 120_000);

afterAll(async () => {
  await restoreMockModels();
  // Leave the shared test database's global cap as this file found it.
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-111 — model đã duyệt là model được POST", () => {
  let batchId = "";
  let projectId = "";
  let clipSceneId = "";
  let approved: FrozenVideoChoice;

  beforeAll(async () => {
    ({ batchId, projectId, clipSceneId } = await importOne());
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    approved = await frozenOf(batchId, clipSceneId);
  }, 300_000);

  afterAll(restoreMockModels);

  it("1. approved model → execution dùng đúng model đó", async () => {
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe("completed");
    expect(approved.pinned).toBe(false);
    expect(approved.durationSeconds).toBe(3);
    const jobs = await videoJobs(projectId);
    expect(jobs).toHaveLength(1);
    expect(`${jobs[0]!.provider}/${jobs[0]!.model}`).toBe(`${approved.provider}/${approved.model}`);
  });

  it("8. video COMPLETED → không định tuyến lại, kể cả khi model đã duyệt nay bị tắt", async () => {
    await setModel(approved.model, { enabled: false });
    try {
      const before = await counts(projectId);
      const plan = await buildVideoResumePlan(projectId);
      expect(plan.nextStep).toBe("NONE");
      expect(plan.videoChoices).toEqual([]);
      expect((await continueVideo(projectId, { wait: true })).status).toBe("NOOP");
      expect(await counts(projectId)).toEqual(before);
    } finally {
      await restoreMockModels();
    }
  });

  it("10. render-only (final.mp4 mất) → $0, không cần router: model video tắt hết vẫn render lại tại máy", async () => {
    await prisma.modelRegistry.updateMany({ where: { provider: "mock", type: "video" }, data: { enabled: false } });
    try {
      const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      fs.rmSync(toAbsolute(p.finalVideoPath!));
      const before = await counts(projectId);
      const linesBefore = await prisma.dialogueLine.findMany({
        where: { scene: { projectId } },
        orderBy: { id: "asc" },
        select: { id: true, status: true, outputPath: true, updatedAt: true },
      });
      expect(linesBefore.length).toBeGreaterThan(0);
      const plan = await buildVideoResumePlan(projectId);
      expect(plan.nextStep).toBe("RENDER_ONLY");
      expect(plan.estimatedIncrementalCost).toBe(0);
      expect(plan.videoChoices).toEqual([]);
      const r = await continueVideo(projectId, { wait: true });
      expect(r.status).toBe("COMPLETED");
      expect(await counts(projectId)).toEqual(before);
      // A finished line is handed back untouched - not re-written, not re-levelled
      // (the browser check saw such a write time out and mark a paid line failed).
      const linesAfter = await prisma.dialogueLine.findMany({
        where: { scene: { projectId } },
        orderBy: { id: "asc" },
        select: { id: true, status: true, outputPath: true, updatedAt: true },
      });
      expect(linesAfter).toEqual(linesBefore);
      const after = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      expect(after.status).toBe("completed");
      expect(fs.existsSync(toAbsolute(after.finalVideoPath!))).toBe(true);
    } finally {
      await restoreMockModels();
    }
  });

  it("3. router nay có model B rẻ hơn → resume vẫn mua đúng model đã duyệt, không tự đổi", async () => {
    const row = await prisma.modelRegistry.findUniqueOrThrow({
      where: { provider_modelId: { provider: approved.provider, modelId: approved.model } },
    });
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = row;
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: "mock", modelId: "mock-video-cheap" } },
      create: { ...copy, modelId: "mock-video-cheap", displayName: "Mock Video Cheap", price: row.price / 10, enabled: true },
      update: { ...copy, modelId: "mock-video-cheap", price: row.price / 10, enabled: true },
    });
    await dropClip(projectId, clipSceneId);
    const before = await counts(projectId);

    const plan = await buildVideoResumePlan(projectId);
    expect(plan.nextStep).toBe("GENERATE");
    expect(plan.videoChoices).toHaveLength(1);
    expect(plan.videoChoices[0]).toMatchObject({ provider: approved.provider, model: approved.model, frozen: true });

    // Proof the router WOULD pick B today: a replanned copy of the plan names it.
    const asked = await continueVideo(projectId);
    expect(asked.status).toBe("NEEDS_CONFIRMATION");
    expect(asked.message).toContain(`${approved.provider}/${approved.model}`);
    expect(asked.message).not.toContain("mock-video-cheap");

    const r = await continueVideo(projectId, { confirmPaid: true, expectedFingerprint: plan.fingerprint, wait: true });
    expect(r.status).toBe("COMPLETED");
    const jobs = await videoJobs(projectId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.model).toBe(approved.model);
    expect((await counts(projectId)).video).toBe(before.video + 1);
    // And the freeze itself did not move.
    expect(await frozenOf(batchId, clipSceneId)).toEqual(approved);
  });

  it("3b. chỉ khi LẬP LẠI KẾ HOẠCH, router mới được chọn lại (và phải xác nhận lại mới chốt)", async () => {
    await dropClip(projectId, clipSceneId);
    expect(await replanVideoModels(projectId)).toBe(1);
    const plan = await buildVideoResumePlan(projectId);
    expect(plan.videoChoices[0]).toMatchObject({ model: "mock-video-cheap", frozen: false });
    const before = await counts(projectId);
    const asked = await continueVideo(projectId);
    expect(asked.status).toBe("NEEDS_CONFIRMATION");
    expect(asked.message).toContain("MỚI — xác nhận này sẽ chốt model");
    expect(await counts(projectId)).toEqual(before);
    expect((await frozenChoicesForBatch(batchId))![clipSceneId]).toBeUndefined();
    // Put the original freeze back for the next cases (cheap model off again).
    await restoreMockModels();
    const again = await buildVideoResumePlan(projectId);
    const r = await continueVideo(projectId, { confirmPaid: true, expectedFingerprint: again.fingerprint, wait: true });
    expect(r.status).toBe("COMPLETED");
    approved = await frozenOf(batchId, clipSceneId);
    expect((await videoJobs(projectId)).at(-1)!.model).toBe(approved.model);
  });

  it("4. model đã duyệt bị TẮT → DỪNG trước POST (APPROVED_MODEL_UNAVAILABLE), không fallback", async () => {
    await dropClip(projectId, clipSceneId);
    await setModel(approved.model, { enabled: false });
    try {
      const before = await counts(projectId);
      const plan = await buildVideoResumePlan(projectId);
      expect(plan.nextStep).toBe("BLOCKED");
      expect(plan.blockedReason).toContain("APPROVED_MODEL_UNAVAILABLE");
      const r = await continueVideo(projectId, { confirmPaid: true, wait: true });
      expect(r.status).toBe("BLOCKED");
      expect(await counts(projectId)).toEqual(before);
      // The executor path too (a batch resume that bypasses the plan): stops at
      // the scene, sends nothing, buys no other model.
      const run = await runBatch(batchId, { resume: true, onlyProjectIds: [projectId] });
      const outcome = run.outcomes.find((o) => o.projectId === projectId)!;
      expect(outcome.rendered).toBe(false);
      expect(await counts(projectId)).toMatchObject({ video: before.video });
    } finally {
      await restoreMockModels();
    }
  });

  it("5a. model LOW_AUTO/router đã chốt bị DEGRADED → DỪNG, không chuyển sang model khác", async () => {
    await setModel(approved.model, { reliability: "DEGRADED" });
    try {
      const before = await counts(projectId);
      const plan = await buildVideoResumePlan(projectId);
      expect(plan.nextStep).toBe("BLOCKED");
      expect(plan.blockedReason).toContain("APPROVED_MODEL_UNAVAILABLE");
      await runBatch(batchId, { resume: true, onlyProjectIds: [projectId] });
      expect((await counts(projectId)).video).toBe(before.video);
      expect((await prisma.scene.findUniqueOrThrow({ where: { id: clipSceneId } })).errorMessage ?? "").toContain(
        "APPROVED_MODEL_UNAVAILABLE",
      );
    } finally {
      await restoreMockModels();
    }
  });

  it("6a. thời lượng đổi sau khi duyệt → APPROVED_PARAMS_CHANGED, 0 POST", async () => {
    await prisma.scene.update({ where: { id: clipSceneId }, data: { duration: 4 } });
    try {
      const before = await counts(projectId);
      const plan = await buildVideoResumePlan(projectId);
      expect(plan.nextStep).toBe("BLOCKED");
      expect(plan.blockedReason).toContain("APPROVED_PARAMS_CHANGED");
      await runBatch(batchId, { resume: true, onlyProjectIds: [projectId] });
      expect((await counts(projectId)).video).toBe(before.video);
      expect((await prisma.scene.findUniqueOrThrow({ where: { id: clipSceneId } })).errorMessage ?? "").toContain(
        "APPROVED_PARAMS_CHANGED",
      );
    } finally {
      await prisma.scene.update({ where: { id: clipSceneId }, data: { duration: 3 } });
    }
  });

  it("6b. giá model đã duyệt TĂNG sau khi duyệt → xác nhận cũ bị từ chối (PLAN_CHANGED) và cổng sinh dừng (APPROVED_COST_CHANGED)", async () => {
    const plan = await buildVideoResumePlan(projectId);
    expect(plan.nextStep).toBe("GENERATE");
    const row = await prisma.modelRegistry.findUniqueOrThrow({
      where: { provider_modelId: { provider: approved.provider, modelId: approved.model } },
    });
    await setModel(approved.model, { price: row.price * 3 });
    try {
      const before = await counts(projectId);
      const stale = await continueVideo(projectId, { confirmPaid: true, expectedFingerprint: plan.fingerprint, wait: true });
      expect(stale.status).toBe("BLOCKED");
      expect(stale.message).toContain("PLAN_CHANGED");
      expect(await counts(projectId)).toEqual(before);
      await runBatch(batchId, { resume: true, onlyProjectIds: [projectId] });
      expect((await counts(projectId)).video).toBe(before.video);
      expect((await prisma.scene.findUniqueOrThrow({ where: { id: clipSceneId } })).errorMessage ?? "").toContain(
        "APPROVED_COST_CHANGED",
      );
    } finally {
      await restoreMockModels();
    }
  });

  it("6c. cổng chi tiền (ngay trước POST) từ chối model khác model đã duyệt", async () => {
    await resumeAuthorization(batchId);
    const other = SEED_MODELS.find((m) => m.provider === "mock" && m.type === "video" && m.modelId !== approved.model)!;
    await expect(
      assertBatchAuthorized({
        batchId,
        projectId,
        sceneId: clipSceneId,
        kind: "video",
        provider: "mock",
        model: other.modelId,
        estimatedCost: 0.001,
        idempotencyKey: `mf-gate-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: "model_not_approved" });
    await expect(
      assertBatchAuthorized({
        batchId,
        projectId,
        sceneId: clipSceneId,
        kind: "video",
        provider: "mock",
        model: other.modelId,
        estimatedCost: 0.001,
        idempotencyKey: `mf-gate-${Date.now()}-2`,
      }),
    ).rejects.toBeInstanceOf(BatchAuthorizationError);
    expect(await prisma.costReservation.count({ where: { idempotencyKey: { startsWith: "mf-gate-" } } })).toBe(0);
  });

  it("7. bấm TIẾP TỤC hai lần → vẫn chỉ MỘT lần thực thi, một clip", async () => {
    const plan = await buildVideoResumePlan(projectId);
    expect(plan.nextStep).toBe("GENERATE");
    const before = await counts(projectId);
    const [a, b] = await Promise.all([
      continueVideo(projectId, { confirmPaid: true, expectedFingerprint: plan.fingerprint, wait: true }),
      continueVideo(projectId, { confirmPaid: true, expectedFingerprint: plan.fingerprint, wait: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["ALREADY_RUNNING", "COMPLETED"]);
    expect((await counts(projectId)).video).toBe(before.video + 1);
    expect((await videoJobs(projectId)).at(-1)!.model).toBe(approved.model);
  });
});

describe("QĐ-111 — ghim tay được giữ đúng qua resume", () => {
  it("2. manual pin → duyệt → resume vẫn đúng model ghim, không bị ghi đè", async () => {
    const { batchId, projectId, clipSceneId } = await importOne({ pin: "mock-video-pro" });
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: false, wait: true });
    const frozen = await frozenOf(batchId, clipSceneId);
    expect(frozen).toMatchObject({ provider: "mock", model: "mock-video-pro", pinned: true, lowAuto: false });
    expect((await videoJobs(projectId)).map((j) => j.model)).toEqual(["mock-video-pro"]);

    await dropClip(projectId, clipSceneId);
    // 5b. A PIN on a DEGRADED model still goes through as pinned (QĐ-035) - and
    // is never swapped for another model.
    await setModel("mock-video-pro", { reliability: "DEGRADED" });
    try {
      const plan = await buildVideoResumePlan(projectId);
      expect(plan.videoChoices[0]).toMatchObject({ model: "mock-video-pro", frozen: true });
      const r = await continueVideo(projectId, { confirmPaid: true, expectedFingerprint: plan.fingerprint, wait: true });
      expect(r.status).toBe("COMPLETED");
    } finally {
      await restoreMockModels();
    }
    expect((await videoJobs(projectId)).map((j) => j.model)).toEqual(["mock-video-pro"]);
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: clipSceneId } });
    expect(scene).toMatchObject({ videoModelPinned: true, videoProvider: "mock", videoModel: "mock-video-pro" });

    // A pin CHANGED after approval is a different purchase: stop, re-approve.
    await dropClip(projectId, clipSceneId);
    await prisma.scene.update({ where: { id: clipSceneId }, data: { videoModel: "mock-video-std" } });
    const before = await counts(projectId);
    const plan = await buildVideoResumePlan(projectId);
    expect(plan.nextStep).toBe("BLOCKED");
    expect(plan.blockedReason).toContain("APPROVED_MODEL_CHANGED");
    await runBatch(batchId, { resume: true, onlyProjectIds: [projectId] });
    expect((await counts(projectId)).video).toBe(before.video);
  }, 300_000);

  it("6d. DUYỆT với danh sách model khác cái đã xem ở preflight → từ chối, không duyệt", async () => {
    const { batchId } = await importOne({ pin: "mock-video-std" });
    await expect(
      approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: false, expectedVideoModels: ["mock/mock-video-lite"], wait: true }),
    ).rejects.toThrow(/APPROVED_MODEL_CHANGED/);
    expect((await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } })).status).toBe("DRAFT");
  });
});

describe("QĐ-111 — resume chỉ tại máy không cần provider/model trả phí", () => {
  it("9. video toàn LOCAL_MOTION, thiếu final → render lại, không model video nào cần bật, $0", async () => {
    seq += 1;
    const name = `mf-local-${seq}`;
    const dir = path.join(tmp, name, "v");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s1.png"), PNG);
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({
        video_id: name,
        video_title: name,
        characters: [{ character_id: "max", character_name: "Max" }],
        scenes: [
          {
            scene_number: 1,
            duration: 3,
            visual_description: "Max against a plain wall.",
            character_action: "Max holds still.",
            camera: "Locked static medium shot, no camera movement.",
            dialogue: "",
            subtitle: "",
            image_file: "s1.png",
            motion_mode: "LOCAL_MOTION",
            priority: "LOW",
          },
        ],
      }),
    );
    const validated = await validateImport(scanImportSource(path.join(tmp, name)));
    const created = await materialiseImport(validated, { batchName: name, maxCostPerVideo: 5, maxCostForBatch: 50 });
    const { batchId } = created;
    const projectId = created.projects[0]!.projectId;
    await approveAndRun({ batchId, maxBatch: 1, lowAutoApproved: false, wait: true });
    expect((await frozenChoicesForBatch(batchId)) ?? {}).toEqual({});

    await prisma.modelRegistry.updateMany({ where: { provider: "mock", type: "video" }, data: { enabled: false } });
    try {
      const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      fs.rmSync(toAbsolute(p.finalVideoPath!));
      const before = await counts(projectId);
      const plan = await buildVideoResumePlan(projectId);
      expect(plan.nextStep).toBe("RENDER_ONLY");
      expect(plan.paidRequestsRequired.total).toBe(0);
      expect(plan.videoChoices).toEqual([]);
      expect((await continueVideo(projectId, { wait: true })).status).toBe("COMPLETED");
      expect(await counts(projectId)).toEqual(before);
    } finally {
      await restoreMockModels();
    }
  }, 300_000);
});
