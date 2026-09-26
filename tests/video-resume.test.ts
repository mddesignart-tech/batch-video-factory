import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun, runBatch } from "@/services/batch-executor";
import { isVideoRunning, tryLockVideo, unlockVideo } from "@/services/run-registry";
import { acknowledgeRecovery, jobPossiblyBilled } from "@/services/paid-recovery";
import {
  buildBatchResumePlans,
  buildVideoResumePlan,
  continueAllEligible,
  continueVideo,
} from "@/services/video-resume";

/**
 * Per-video resume / recovery (V1.2 Phase 3, QĐ-110), on mock providers - $0.
 * Test matrix A-T of the spec. Rows for NEEDS_RECOVERY use a non-mock provider
 * name only as DATA: they are classified and refused, never sent.
 */

let tmp = "";
let PNG: Buffer;

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

interface Spec {
  id: string;
  title: string;
  scenes: { spoken: boolean; motion?: string }[];
}

async function importBatch(name: string, videos: Spec[]): Promise<{ batchId: string; ids: Record<string, string> }> {
  const root = path.join(tmp, name);
  for (const v of videos) {
    const dir = path.join(root, v.id);
    fs.mkdirSync(dir, { recursive: true });
    const scenes = v.scenes.map((s, i) => {
      fs.writeFileSync(path.join(dir, `s${i + 1}.png`), PNG);
      return {
        scene_number: i + 1,
        duration: 3,
        visual_description: `Max against a plain wall, shot ${i + 1}.`,
        character_action: "Max holds still.",
        camera: "Locked static medium shot, no camera movement.",
        dialogue: s.spoken ? `Max: "Line ${i + 1} of ${v.id}."` : "",
        subtitle: s.spoken ? `Line ${i + 1}.` : "",
        image_file: `s${i + 1}.png`,
        motion_mode: s.motion ?? "LOCAL_MOTION",
        priority: s.motion === "VIDEO_AI" ? "HIGH" : "LOW",
      };
    });
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({ video_id: `${name}-${v.id}`, video_title: v.title, characters: [{ character_id: "max", character_name: "Max" }], scenes }),
    );
  }
  const validated = await validateImport(scanImportSource(root));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, { batchName: name, maxCostPerVideo: 5, maxCostForBatch: 50 });
  const ids: Record<string, string> = {};
  for (const p of created.projects) ids[p.title] = p.projectId;
  return { batchId: created.batchId, ids };
}

async function setRemaining(remaining: number): Promise<void> {
  const held = (await prisma.costReservation.aggregate({ where: { status: "RESERVED" }, _sum: { estimatedCost: true } }))._sum.estimatedCost ?? 0;
  await setSpendCap(Math.round(((await spendStatus()).spent + held + remaining) * 1e6) / 1e6);
}

async function ledger(projectId: string) {
  return {
    jobs: await prisma.providerJob.count({ where: { projectId } }),
    image: await prisma.providerJob.count({ where: { projectId, kind: "image" } }),
    video: await prisma.providerJob.count({ where: { projectId, kind: "video" } }),
    voice: await prisma.providerJob.count({ where: { projectId, kind: "audio" } }),
    costs: await prisma.costEntry.count({ where: { projectId } }),
    reservations: await prisma.costReservation.count({ where: { projectId } }),
    retries: (await prisma.scene.aggregate({ where: { projectId }, _sum: { retryCount: true } }))._sum.retryCount ?? 0,
    renders: await prisma.job.count({ where: { projectId, type: "render_final" } }),
  };
}

/** Make one scene look like its voice was never produced (no job, no file). */
async function dropVoice(projectId: string, sceneNumber: number): Promise<void> {
  const scene = await prisma.scene.findFirstOrThrow({ where: { projectId, sceneNumber }, include: { dialogueLines: true } });
  const keys = (await prisma.providerJob.findMany({ where: { sceneId: scene.id, kind: "audio" } })).map((j) => j.idempotencyKey);
  await prisma.costReservation.deleteMany({ where: { idempotencyKey: { in: keys } } });
  await prisma.providerJob.deleteMany({ where: { sceneId: scene.id, kind: "audio" } });
  await prisma.dialogueLine.updateMany({ where: { sceneId: scene.id }, data: { status: "pending", outputPath: "" } });
  await prisma.scene.update({ where: { id: scene.id }, data: { audioPath: null, status: "image_ready" } });
  await prisma.project.update({ where: { id: projectId }, data: { status: "failed" } });
}

/** A paid request of another provider that is unsettled - data only, never sent. */
async function unsettledJob(projectId: string, sceneNumber: number, shape: "failed-charged" | "in-flight" | "failed-released", batchId: string) {
  const scene = await prisma.scene.findFirstOrThrow({ where: { projectId, sceneNumber } });
  await prisma.scene.update({ where: { id: scene.id }, data: { videoPath: null } });
  const key = `synthetic-${randomUUID()}`;
  const job = await prisma.providerJob.create({
    data: {
      provider: "runway",
      model: "h3_max:768x1280",
      kind: "video",
      idempotencyKey: key,
      status: shape === "in-flight" ? "processing" : "failed",
      externalId: shape === "failed-released" ? null : `task-${randomUUID().slice(0, 8)}`,
      projectId,
      sceneId: scene.id,
      error: shape === "in-flight" ? null : "poll timeout",
      estimatedCost: 0.4,
    },
  });
  await prisma.costReservation.create({
    data: {
      batchId,
      projectId,
      sceneId: scene.id,
      idempotencyKey: key,
      kind: "video",
      provider: "runway",
      model: "h3_max:768x1280",
      status: shape === "failed-charged" ? "COMMITTED" : shape === "failed-released" ? "RELEASED" : "RESERVED",
      estimatedCost: 0.4,
      actualCost: shape === "failed-charged" ? 0.4 : 0,
    },
  });
  await prisma.project.update({ where: { id: projectId }, data: { status: "failed" } });
  return job;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video-resume-"));
  const file = path.join(tmp, "k.png");
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=1080x1920", "-frames:v", "1", file]);
  PNG = fs.readFileSync(file);
  await setSpendCap(50);
  await seedMock();
}, 120_000);

afterAll(async () => {
  // Synthetic unsettled rows are data only; settle them so no other file sees money "in flight".
  await prisma.costReservation.updateMany({ where: { idempotencyKey: { startsWith: "synthetic-" }, status: "RESERVED" }, data: { status: "RELEASED" } });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("mỗi video tự tiếp tục — không chạm video khác", () => {
  let batchId = "";
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    await setRemaining(20);
    ({ batchId, ids } = await importBatch("vr-main", [
      { id: "a", title: "A", scenes: [{ spoken: true }, { spoken: true }] },
      { id: "b", title: "B", scenes: [{ spoken: true }, { spoken: true, motion: "VIDEO_AI" }] },
      { id: "c", title: "C", scenes: [{ spoken: true }, { spoken: true }, { spoken: true }] },
    ]));
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    for (const t of ["A", "B", "C"]) expect((await prisma.project.findUniqueOrThrow({ where: { id: ids[t]! } })).status).toBe("completed");
  }, 300_000);

  it("A + R. video COMPLETED, output đủ: TIẾP TỤC = no-op 'Video đã hoàn thành.', mọi delta 0", async () => {
    const before = await ledger(ids.A!);
    const plan = await buildVideoResumePlan(ids.A!);
    expect(plan.currentStatus).toBe("COMPLETED");
    expect(plan.nextStep).toBe("NONE");
    expect(plan.nextAction).toBe("KIỂM TRA LẠI");
    expect(plan.estimatedIncrementalCost).toBe(0);
    expect(plan.paidRequestsRequired.total).toBe(0);
    const r = await continueVideo(ids.A!, { wait: true });
    expect(r.status).toBe("NOOP");
    expect(r.message).toBe("Video đã hoàn thành.");
    expect(await ledger(ids.A!)).toEqual(before);
    // R. The whole finished batch: nothing to do, nothing sent.
    const all = await continueAllEligible(batchId, { wait: true });
    expect(all.status).toBe("NOTHING_TO_DO");
    expect(await ledger(ids.A!)).toEqual(before);
  });

  it("B + F + T. final.mp4 mất, mọi media còn: chỉ render TẠI MÁY (LOCAL_MOTION dựng lại), $0, 0 POST", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: ids.C! } });
    fs.rmSync(toAbsolute(project.finalVideoPath!));
    const before = await ledger(ids.C!);
    const plan = await buildVideoResumePlan(ids.C!);
    expect(plan.nextStep).toBe("RENDER_ONLY");
    expect(plan.paidRequestsRequired.total).toBe(0);
    expect(plan.estimatedIncrementalCost).toBe(0);
    expect(plan.localWorkRequired).toContain("render");
    expect(plan.localWorkRequired.some((w) => w.startsWith("local_motion:"))).toBe(true);
    const r = await continueVideo(ids.C!, { wait: true });
    expect(r.status).toBe("COMPLETED");
    const after = await prisma.project.findUniqueOrThrow({ where: { id: ids.C! } });
    expect(fs.existsSync(toAbsolute(after.finalVideoPath!))).toBe(true);
    const l = await ledger(ids.C!);
    expect({ ...l, renders: 0 }).toEqual({ ...before, renders: 0 });
    expect(l.renders).toBe(before.renders + 1);
  });

  it("C + E + N + O. thiếu 1 giọng ở cảnh 2: chỉ đúng 1 job giọng, 0 ảnh (ảnh nhập), cảnh 1/3 không bị chạm", async () => {
    await dropVoice(ids.C!, 2);
    const before = await ledger(ids.C!);
    const plan = await buildVideoResumePlan(ids.C!);
    expect(plan.currentStatus).toBe("FAILED");
    expect(plan.paidRequestsRequired).toEqual({ image: 0, video: 0, voice: 1, total: 1 });
    // O. Incremental only: one voice, not the video's historical total.
    const historical = (await prisma.costReservation.aggregate({ where: { projectId: ids.C!, status: "COMMITTED" }, _sum: { estimatedCost: true } }))._sum.estimatedCost ?? 0;
    expect(plan.estimatedIncrementalCost!).toBeGreaterThan(0);
    expect(plan.estimatedIncrementalCost!).toBeLessThan(historical);
    const confirm = await continueVideo(ids.C!);
    expect(confirm.status).toBe("NEEDS_CONFIRMATION");
    expect(await ledger(ids.C!)).toEqual(before); // asking sends nothing
    const scene1 = await prisma.dialogueLine.findMany({ where: { scene: { projectId: ids.C!, sceneNumber: { in: [1, 3] } } } });
    const untouched = (await prisma.scene.findMany({ where: { projectId: ids.C!, sceneNumber: { in: [1, 3] } }, select: { id: true } })).map((x) => x.id);
    const jobsOnUntouched = await prisma.providerJob.count({ where: { sceneId: { in: untouched } } });
    const r = await continueVideo(ids.C!, { confirmPaid: true, wait: true });
    expect(r.status).toBe("COMPLETED");
    const l = await ledger(ids.C!);
    expect(l.voice).toBe(before.voice + 1);
    expect(l.image).toBe(before.image);
    expect(l.video).toBe(before.video);
    expect(l.retries).toBe(before.retries);
    const after1 = await prisma.dialogueLine.findMany({ where: { scene: { projectId: ids.C!, sceneNumber: { in: [1, 3] } } } });
    // Not regenerated: same rows, same files, no new job on scenes 1 and 3. (Resume
    // still re-writes bookkeeping columns on finished rows - a known V1.1 item.)
    expect(after1.map((x) => [x.id, x.outputPath, x.status])).toEqual(scene1.map((x) => [x.id, x.outputPath, x.status]));
    expect(await prisma.providerJob.count({ where: { sceneId: { in: untouched } } })).toBe(jobsOnUntouched);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: ids.C! } })).status).toBe("completed");
  });

  it("G. ProviderJob giọng đã completed nhưng dòng thoại cũ ghi pending (UI cũ): dùng lại kết quả, không POST", async () => {
    const scene = await prisma.scene.findFirstOrThrow({ where: { projectId: ids.A!, sceneNumber: 1 } });
    await prisma.dialogueLine.updateMany({ where: { sceneId: scene.id }, data: { status: "pending" } });
    await prisma.project.update({ where: { id: ids.A! }, data: { status: "failed" } });
    const before = await ledger(ids.A!);
    await continueVideo(ids.A!, { confirmPaid: true, wait: true });
    const l = await ledger(ids.A!);
    expect(l.jobs).toBe(before.jobs);
    expect(l.reservations).toBe(before.reservations);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: ids.A! } })).status).toBe("completed");
  });

  it("D + P + Q. clip Video AI mất: chỉ 1 job video; trần video không đủ -> BLOCKED trước POST; hạ hạn mức sau preflight -> chặn", async () => {
    const scene = await prisma.scene.findFirstOrThrow({ where: { projectId: ids.B!, sceneNumber: 2 } });
    const keys = (await prisma.providerJob.findMany({ where: { sceneId: scene.id, kind: "video" } })).map((j) => j.idempotencyKey);
    await prisma.costReservation.deleteMany({ where: { idempotencyKey: { in: keys } } });
    await prisma.providerJob.deleteMany({ where: { sceneId: scene.id, kind: "video" } });
    await prisma.scene.update({ where: { id: scene.id }, data: { videoPath: null, status: "image_ready" } });
    await prisma.project.update({ where: { id: ids.B! }, data: { status: "failed" } });
    const before = await ledger(ids.B!);
    const plan = await buildVideoResumePlan(ids.B!);
    expect(plan.paidRequestsRequired).toEqual({ image: 0, video: 1, voice: 0, total: 1 });
    const clip = plan.estimatedIncrementalCost!;
    expect(clip).toBeGreaterThan(0);

    // P. Video cap below ANY clip (in mock mode the router may fit a cheaper mock
    // model into a tight cap - production has one auto-routable video model):
    // refused BEFORE any request.
    const spentOnB = plan.budget.videoLimit - plan.budget.videoRemaining;
    await prisma.project.update({ where: { id: ids.B! }, data: { maxBudget: spentOnB + 0.000001 } });
    const capped = await continueVideo(ids.B!, { confirmPaid: true, wait: true });
    expect(capped.status).toBe("BLOCKED");
    expect(capped.verdict?.reasonCode).toBe("VIDEO_LIMIT_EXCEEDED");
    expect(await ledger(ids.B!)).toEqual(before);
    await prisma.project.update({ where: { id: ids.B! }, data: { maxBudget: 5 } });

    // Q. Plan shown, then the global limit drops before the confirm: stopped before POST.
    const shown = await continueVideo(ids.B!);
    expect(shown.status).toBe("NEEDS_CONFIRMATION");
    await setRemaining(0.000001);
    const late = await continueVideo(ids.B!, { confirmPaid: true, wait: true });
    expect(late.status).toBe("BLOCKED");
    expect(late.verdict?.reasonCode).toBe("GLOBAL_LIMIT_EXCEEDED");
    expect(await ledger(ids.B!)).toEqual(before);
    await setRemaining(20);

    // D. Money is there: exactly one video job, nothing else.
    const r = await continueVideo(ids.B!, { confirmPaid: true, wait: true });
    expect(r.status).toBe("COMPLETED");
    const l = await ledger(ids.B!);
    expect(l.video).toBe(before.video + 1);
    expect(l.image).toBe(before.image);
    expect(l.voice).toBe(before.voice);
  });

  it("J. bấm TIẾP TỤC hai lần liền: đúng MỘT lần chạy, lần kia ALREADY_RUNNING", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: ids.A! } });
    fs.rmSync(toAbsolute(project.finalVideoPath!));
    const before = await ledger(ids.A!);
    const [one, two] = await Promise.all([continueVideo(ids.A!, { wait: true }), continueVideo(ids.A!, { wait: true })]);
    expect([one.status, two.status].sort()).toEqual(["ALREADY_RUNNING", "COMPLETED"]);
    const l = await ledger(ids.A!);
    expect(l.renders).toBe(before.renders + 1);
    expect(l.jobs).toBe(before.jobs);
    expect(isVideoRunning(ids.A!)).toBe(false);
  });

  it("K + L. khoá theo video: cùng video -> một người thắng; hai video khác nhau chạy độc lập", async () => {
    expect(tryLockVideo(ids.A!, "worker-1")).toBe(true);
    expect(tryLockVideo(ids.A!, "worker-2")).toBe(false);
    // A batch run meets the held video and leaves it alone.
    const summary = await runBatch(batchId, { resume: true, onlyProjectIds: [ids.A!] });
    expect(summary.outcomes[0]!.stopped).toMatch(/^ALREADY_RUNNING/);
    expect((await continueVideo(ids.A!)).status).toBe("ALREADY_RUNNING");
    // ...while another video of the same batch is free to run.
    for (const t of ["B", "C"]) fs.rmSync(toAbsolute((await prisma.project.findUniqueOrThrow({ where: { id: ids[t]! } })).finalVideoPath!));
    const [b, c] = await Promise.all([continueVideo(ids.B!, { wait: true }), continueVideo(ids.C!, { wait: true })]);
    expect([b.status, c.status]).toEqual(["COMPLETED", "COMPLETED"]);
    unlockVideo(ids.A!, "worker-1");
    expect(isVideoRunning(ids.A!)).toBe(false);
  });
});

describe("NEEDS_RECOVERY — không bao giờ tự mua lần hai", () => {
  let batchId = "";
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    await setRemaining(20);
    ({ batchId, ids } = await importBatch("vr-rec", [
      { id: "x", title: "X", scenes: [{ spoken: false }, { spoken: false, motion: "VIDEO_AI" }] },
      { id: "y", title: "Y", scenes: [{ spoken: false }, { spoken: false, motion: "VIDEO_AI" }] },
      { id: "z", title: "Z", scenes: [{ spoken: false }, { spoken: false, motion: "VIDEO_AI" }] },
    ]));
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
  }, 300_000);

  it("I. thất bại sau khi có thể đã gửi (reservation COMMITTED): NEEDS_RECOVERY, TIẾP TỤC từ chối, 0 request", async () => {
    const job = await unsettledJob(ids.X!, 2, "failed-charged", batchId);
    expect(await jobPossiblyBilled(job)).toBe(true);
    const plan = await buildVideoResumePlan(ids.X!);
    expect(plan.currentStatus).toBe("NEEDS_RECOVERY");
    expect(plan.nextStep).toBe("RECOVER");
    expect(plan.nextAction).toBe("KIỂM TRA");
    expect(plan.estimatedIncrementalCost).toBeNull();
    expect(plan.blockedReason).toContain("Yêu cầu trước có thể đã phát sinh chi phí. Cần kiểm tra trước khi gửi lại.");
    const before = await ledger(ids.X!);
    const r = await continueVideo(ids.X!, { confirmPaid: true, wait: true });
    expect(r.status).toBe("NEEDS_RECOVERY");
    expect(await ledger(ids.X!)).toEqual(before);
    // A person checked the vendor: the old request is archived (money still counted),
    // and the video is back to an ordinary FAILED step whose next buy is a NEW one.
    await acknowledgeRecovery(job.id, "test");
    const archived = await prisma.providerJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(archived.idempotencyKey).toMatch(/#reviewed-/);
    expect((await prisma.costReservation.findFirstOrThrow({ where: { idempotencyKey: archived.idempotencyKey } })).status).toBe("COMMITTED");
    expect((await buildVideoResumePlan(ids.X!)).currentStatus).not.toBe("NEEDS_RECOVERY");
  });

  it("I'. yêu cầu đã được nhận, đang chờ, không ai theo dõi: NEEDS_RECOVERY (IN_FLIGHT)", async () => {
    await unsettledJob(ids.Y!, 2, "in-flight", batchId);
    const plan = await buildVideoResumePlan(ids.Y!);
    expect(plan.currentStatus).toBe("NEEDS_RECOVERY");
    expect(plan.recovery[0]!.reason).toBe("IN_FLIGHT");
  });

  it("H. thất bại TRƯỚC khi gửi (reservation RELEASED): không phải recovery; thử lại được theo chính sách", async () => {
    const job = await unsettledJob(ids.Z!, 2, "failed-released", batchId);
    expect(await jobPossiblyBilled(job)).toBe(false);
    const plan = await buildVideoResumePlan(ids.Z!);
    expect(plan.currentStatus).not.toBe("NEEDS_RECOVERY");
    expect(plan.nextStep).toBe("GENERATE");
    expect(plan.safeToContinue).toBe(true);
  });

  it("H'. thử lại một bước đã RELEASED phải giữ chỗ tiền MỚI (trước đây coi là $0 và bỏ qua mọi trần)", async () => {
    const scene = await prisma.scene.findFirstOrThrow({ where: { projectId: ids.Z!, sceneNumber: 2 } });
    const mockJob = await prisma.providerJob.findFirstOrThrow({ where: { sceneId: scene.id, kind: "video", provider: "mock" } });
    await prisma.providerJob.update({ where: { id: mockJob.id }, data: { status: "failed" } });
    await prisma.costReservation.update({ where: { idempotencyKey: mockJob.idempotencyKey }, data: { status: "RELEASED", actualCost: 0 } });
    // Cleared: the synthetic runway row from H is data only; remove it so the mock step is the one retried.
    await prisma.costReservation.deleteMany({ where: { projectId: ids.Z!, idempotencyKey: { startsWith: "synthetic-" } } });
    await prisma.providerJob.deleteMany({ where: { projectId: ids.Z!, idempotencyKey: { startsWith: "synthetic-" } } });
    const r = await continueVideo(ids.Z!, { confirmPaid: true, wait: true });
    expect(r.status).toBe("COMPLETED");
    const reservation = await prisma.costReservation.findUniqueOrThrow({ where: { idempotencyKey: mockJob.idempotencyKey } });
    expect(reservation.status).toBe("COMMITTED");
    expect(reservation.estimatedCost).toBeGreaterThan(0);
  });
});

describe("M + S. lỗi riêng một video; TIẾP TỤC TẤT CẢ chỉ lấy video đủ điều kiện", () => {
  it("B hỏng không làm A đổi trạng thái hay C dừng; Continue All bỏ qua COMPLETED / BLOCKED / NEEDS_RECOVERY", async () => {
    await setRemaining(20);
    const { batchId, ids } = await importBatch("vr-all", [
      { id: "a", title: "A", scenes: [{ spoken: true }] },
      { id: "b", title: "B", scenes: [{ spoken: true }] },
      { id: "c", title: "C", scenes: [{ spoken: true }] },
      { id: "d", title: "D", scenes: [{ spoken: false }, { spoken: false, motion: "VIDEO_AI" }] },
      { id: "e", title: "E", scenes: [{ spoken: true }] },
    ]);
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: true, wait: true });

    // A done. B: its imported picture is gone -> it stops (never buys a replacement).
    // C: missing one voice. D: NEEDS_RECOVERY. E: final render missing.
    const b = await prisma.scene.findFirstOrThrow({ where: { projectId: ids.B! } });
    fs.rmSync(toAbsolute(b.imagePath!));
    await prisma.project.update({ where: { id: ids.B! }, data: { status: "failed" } });
    await dropVoice(ids.C!, 1);
    await unsettledJob(ids.D!, 2, "failed-charged", batchId);
    fs.rmSync(toAbsolute((await prisma.project.findUniqueOrThrow({ where: { id: ids.E! } })).finalVideoPath!));

    const plans = Object.fromEntries((await buildBatchResumePlans(batchId)).map((p) => [p.title, p]));
    expect(plans.A!.nextStep).toBe("NONE");
    expect(plans.C!.nextStep).toBe("GENERATE");
    expect(plans.D!.nextStep).toBe("RECOVER");
    expect(plans.E!.nextStep).toBe("RENDER_ONLY");

    const aBefore = await prisma.project.findUniqueOrThrow({ where: { id: ids.A! } });
    const aJobs = await prisma.providerJob.count({ where: { projectId: ids.A! } });
    const aRenders = await prisma.job.count({ where: { projectId: ids.A!, type: "render_final" } });
    const preview = await continueAllEligible(batchId);
    expect(preview.status).toBe("NEEDS_CONFIRMATION");
    const titles = preview.runnable.map((p) => p.title).sort();
    expect(titles).not.toContain("A");
    expect(titles).not.toContain("D");
    expect(titles).toEqual(expect.arrayContaining(["C", "E"]));
    // Authorisation = the runnable videos' INCREMENTAL cost; E (render only) adds $0.
    expect(preview.authorizationAmount).toBeCloseTo(plans.C!.estimatedIncrementalCost! + (titles.includes("B") ? plans.B!.estimatedIncrementalCost! : 0), 6);

    const done = await continueAllEligible(batchId, { confirmPaid: true, wait: true });
    expect(done.status).toBe("COMPLETED");
    const status = async (t: string) => (await prisma.project.findUniqueOrThrow({ where: { id: ids[t]! } })).status;
    expect(await status("C")).toBe("completed");
    expect(await status("E")).toBe("completed");
    expect(await status("B")).not.toBe("completed"); // its own failure, its own row
    const aAfter = await prisma.project.findUniqueOrThrow({ where: { id: ids.A! } });
    // (The preflight refreshes every video's forecast column, so updatedAt moves; nothing else may.)
    expect([aAfter.status, aAfter.finalVideoPath]).toEqual([aBefore.status, aBefore.finalVideoPath]);
    expect(await prisma.providerJob.count({ where: { projectId: ids.A! } })).toBe(aJobs);
    expect(await prisma.job.count({ where: { projectId: ids.A!, type: "render_final" } })).toBe(aRenders);
    expect(await prisma.providerJob.count({ where: { projectId: ids.D!, provider: "runway" } })).toBe(1); // the data row, never re-sent
  });
});
