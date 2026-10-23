import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetEnvCache } from "@/lib/env";
import { ffmpeg } from "@/media/ffmpeg";
import { ensureProjectDirs, projectSubdir, toRelative } from "@/lib/paths";
import { SEED_MODELS, SEED_PROVIDERS } from "@/data/seed-config";
import { PROVIDER_BUDGET_SETTING, setProviderBudget } from "@/services/provider-budget";
import { confirmedProviders, SPEND_CAP_SETTING, SPEND_CONFIRM_SETTING } from "@/services/spend-guard";
import { peekCreateToken, revokeCreateToken } from "@/services/create-token";
import { chooseVideoModel, makeSceneVideo, useLocalMotion } from "@/services/scene-video";
import { generateSceneVideo } from "@/services/generation";

/**
 * QĐ-154, end to end, the way it failed: a scene pinned to
 * runway/h3_max:480x854 (NOT on the long-term list), price confirmed in the
 * Storyboard. Real-mode gates, a fake Runway behind `fetch` - no network, no
 * real key, no money. Every request the app makes is counted.
 */

const MODEL = "h3_max:480x854";
const KEYS = [SPEND_CAP_SETTING, SPEND_CONFIRM_SETTING, PROVIDER_BUDGET_SETTING];
let saved: { key: string; valueJson: string }[] = [];
let tmp = "";
let clip: Buffer = Buffer.alloc(0);
const env = { mock: process.env.AI_MOCK_MODE, key: process.env.RUNWAY_API_KEY, secret: process.env.RUNWAYML_API_SECRET };
const originalFetch = globalThis.fetch;
let creates = 0;
let createStatus = 200;
let unknown: string[] = [];
const created: { projectIds: string[]; idiomIds: string[] } = { projectIds: [], idiomIds: [] };

function fakeRunway(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("generate_204") || url.includes("cdn-cgi/trace")) return new Response(null, { status: 204 });
    if (url.endsWith("/image_to_video") && init?.method === "POST") {
      creates += 1;
      if (createStatus !== 200) return json({ error: "Invalid API key" }, createStatus);
      return json({ id: `task-${creates}` });
    }
    if (/\/tasks\/task-\d+$/.test(url)) return json({ id: url.split("/").pop(), status: "SUCCEEDED", progress: 1, output: ["https://cdn.example.invalid/out.mp4"], cost: { credits: 25 } });
    if (url === "https://cdn.example.invalid/out.mp4") return new Response(new Uint8Array(clip), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(clip.length) } });
    if (url.endsWith("/organization")) return json({ creditBalance: 245 });
    unknown.push(url);
    throw new Error(`fake Runway: unexpected request ${url}`);
  }) as typeof fetch;
}

async function scene(): Promise<string> {
  const idiom = await prisma.idiom.create({ data: { phrase: "QĐ-154", slug: `qd154-${Date.now()}-${Math.random()}`, meaning: "m", literalMeaning: "l", exampleSentence: "e", category: "qa" } });
  const project = await prisma.project.create({ data: { idiomId: idiom.id, title: "QĐ-154 Runway", status: "media_ready", language: "vi", targetDuration: 5 } });
  created.idiomIds.push(idiom.id);
  created.projectIds.push(project.id);
  ensureProjectDirs(project.id);
  const img = path.join(projectSubdir(project.id, "images"), "k.png");
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=480x854", "-frames:v", "1", img]);
  const s = await prisma.scene.create({
    data: { projectId: project.id, sceneNumber: 1, duration: 5, subtitle: "Chim bay.", dialogue: "", imagePath: toRelative(img), status: "image_ready", motionSource: "AI_VIDEO", motionMode: "VIDEO_AI", videoPrompt: "A bird flies over a calm lake, locked camera." },
  });
  return s.id;
}

const videoJobs = (sceneId: string) => prisma.providerJob.count({ where: { sceneId, kind: "video" } });
const costs = (sceneId: string) => prisma.costEntry.count({ where: { sceneId } });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qd154-"));
  const out = path.join(tmp, "out.mp4");
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=480x854:r=24:d=5", "-pix_fmt", "yuv420p", "-c:v", "libx264", out]);
  clip = fs.readFileSync(out);
  saved = await prisma.setting.findMany({ where: { key: { in: KEYS } }, select: { key: true, valueJson: true } });
  const provider = SEED_PROVIDERS.find((p) => p.name === "runway")!;
  await prisma.providerConfig.upsert({
    where: { name: "runway" },
    create: { ...provider, types: JSON.stringify(provider.types), enabled: true, status: "connected" },
    update: { enabled: true, status: "connected" },
  });
  const seed = SEED_MODELS.find((m) => m.provider === "runway" && m.modelId === MODEL)!;
  await prisma.modelRegistry.upsert({ where: { provider_modelId: { provider: "runway", modelId: MODEL } }, create: { ...seed, enabled: true }, update: { enabled: true } });
  process.env.AI_MOCK_MODE = "false";
  process.env.RUNWAY_API_KEY = "test-key-not-real";
  delete process.env.RUNWAYML_API_SECRET;
  resetEnvCache();
  globalThis.fetch = fakeRunway();
}, 120_000);

beforeEach(async () => {
  creates = 0;
  createStatus = 200;
  unknown = [];
  await revokeCreateToken();
  await prisma.setting.upsert({ where: { key: SPEND_CONFIRM_SETTING }, create: { key: SPEND_CONFIRM_SETTING, valueJson: JSON.stringify(["runway/h3_max:768x1280"]) }, update: { valueJson: JSON.stringify(["runway/h3_max:768x1280"]) } });
  const spent = (await prisma.costEntry.aggregate({ _sum: { amount: true }, where: { estimated: false } }))._sum.amount ?? 0;
  const cap = JSON.stringify(Math.round((spent + 5) * 1e6) / 1e6);
  await prisma.setting.upsert({ where: { key: SPEND_CAP_SETTING }, create: { key: SPEND_CAP_SETTING, valueJson: cap }, update: { valueJson: cap } });
  await setProviderBudget({ provider: "runway", available: 245, unit: "credits", usdPerUnit: 0.01, source: "DECLARED" });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  // The fake clips were booked as real spend: take them out, so suites that
  // assert "no real money" or the app-wide remainder are not disturbed.
  const projectId = { in: created.projectIds };
  await prisma.costEntry.deleteMany({ where: { projectId } });
  await prisma.costReservation.deleteMany({ where: { projectId } }).catch(() => undefined);
  await prisma.providerJob.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.idiom.deleteMany({ where: { id: { in: created.idiomIds } } });
  await revokeCreateToken();
  await prisma.setting.deleteMany({ where: { key: { in: KEYS } } });
  for (const s of saved) await prisma.setting.create({ data: s });
  for (const [k, v] of [["AI_MOCK_MODE", env.mock], ["RUNWAY_API_KEY", env.key], ["RUNWAYML_API_SECRET", env.secret]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-154 — Storyboard: xác nhận giá rồi tạo video Runway (giả lập, $0)", () => {
  it("chưa xác nhận → 0 POST; xác nhận đúng giá → đúng 1 POST, clip về, ghi sổ đúng; danh sách cho phép không đổi", async () => {
    const sceneId = await scene();
    const choice = await chooseVideoModel(sceneId, "runway", MODEL);
    expect(choice.estimatedCost).toBeCloseTo(0.25, 6);

    // A regenerate job without any confirmation: blocked at the gate, nothing sent.
    await expect(generateSceneVideo(sceneId)).rejects.toThrow(/Chưa được phép gọi API thật/);
    expect(creates).toBe(0);

    const ask = await makeSceneVideo(sceneId);
    expect(ask.status).toBe("NEEDS_CONFIRMATION");
    expect(ask.message).toMatch(/chỉ cho phép đúng 1 clip/);
    expect(creates).toBe(0);

    const done = await makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: ask.choice!.estimatedCost! });
    expect(unknown).toEqual([]);
    expect(done.status).toBe("DONE");
    expect(creates).toBe(1);
    expect(await videoJobs(sceneId)).toBe(1);
    const entry = await prisma.costEntry.findFirstOrThrow({ where: { sceneId } });
    expect(entry).toMatchObject({ provider: "runway", model: MODEL, estimated: false });
    expect(entry.amount).toBeCloseTo(0.25, 6);
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } })).videoPath).toBeTruthy();
    // The one-time consent did not turn into a standing permission, and the permit is spent.
    expect(await confirmedProviders()).toEqual(["runway/h3_max:768x1280"]);
    expect(await peekCreateToken()).toBeNull();

    // Pressing again: the clip exists - no second paid request.
    await makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: ask.choice!.estimatedCost! });
    expect(creates).toBe(1);
  });

  it("API key sai (401) → báo lỗi key, không ghi chi phí; permit đã dùng nên không tự gửi lại", async () => {
    const sceneId = await scene();
    await chooseVideoModel(sceneId, "runway", MODEL);
    createStatus = 401;
    const r = await makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: 0.25 });
    expect(r.status).toBe("FAILED");
    expect(r.message).toMatch(/key|401|xác thực/i);
    expect(creates).toBe(1);
    expect(await costs(sceneId)).toBe(0);
    expect(await peekCreateToken()).toBeNull();
    await expect(generateSceneVideo(sceneId)).rejects.toThrow();
    expect(creates).toBe(1);
  });

  it("hạn mức tổng không đủ → NEEDS_BUDGET / chặn, 0 POST", async () => {
    const sceneId = await scene();
    await chooseVideoModel(sceneId, "runway", MODEL);
    const spent = (await prisma.costEntry.aggregate({ _sum: { amount: true }, where: { estimated: false } }))._sum.amount ?? 0;
    const cap = JSON.stringify(Math.round((spent + 0.1) * 1e6) / 1e6);
    await prisma.setting.update({ where: { key: SPEND_CAP_SETTING }, data: { valueJson: cap } });
    const r = await makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: 0.25 });
    expect(["NEEDS_BUDGET", "FAILED"]).toContain(r.status);
    expect(r.message).toMatch(/hạn mức|ngân sách/i);
    expect(creates).toBe(0);
  });

  it("LOCAL MOTION → không gọi Runway", async () => {
    const sceneId = await scene();
    await chooseVideoModel(sceneId, "runway", MODEL);
    await useLocalMotion(sceneId);
    const r = await makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: 0.25 });
    expect(r.status).not.toBe("DONE");
    expect(creates).toBe(0);
  });
});
