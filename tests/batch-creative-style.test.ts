import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import { templateOf } from "@/domain/content-templates";
import { projectContent } from "@/domain/content-legacy";
import { effectiveCameraPreset, presetMotion } from "@/domain/camera-director";
import {
  IDIOM_CREATIVE_PROMPT_VERSION,
  creativeSummary,
  idiomPlan,
  idiomV2PromptValues,
  resolveCreativeStyle,
  type EffectiveCreativeStyle,
  type StoredCreativeStyle,
} from "@/domain/creative-style";
import { scriptNeedsRewrite, type ScriptDoc } from "@/domain/script";
import { readPromptFile, renderTemplate } from "@/lib/prompts";
import { MockTextProvider } from "@/providers/mock/mock-text-provider";
import { approveAuthorization, createAuthorization } from "@/services/batch-authorization";
import { planBatch, referenceProfileFor, REFERENCE_SCENE_PROFILE } from "@/services/batch-planner";
import { savePlan, storedPlan } from "@/services/batch-runner";
import { materializeIdiomVideos } from "@/services/batch-sources";
import { applyBatchCreativeStyle } from "@/services/creative-style";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { seedMock } from "./phase5-helpers";

/**
 * CREATIVE STYLE ENGINE → BATCH IDIOM FLOW (QĐ-136). A batch picks ONE style
 * for all its videos and every video is written by the single-video engine
 * (idiomPlan / idiom-v2). Mock only: no paid request of any kind.
 */

const IDIOM = templateOf("ENGLISH_IDIOM").creative;
const eff = (s: Partial<StoredCreativeStyle>): EffectiveCreativeStyle =>
  resolveCreativeStyle(IDIOM, { version: "creative-v1", preset: "AUTO", ...s } as StoredCreativeStyle);

const TIKTOK: Partial<StoredCreativeStyle> = { preset: "TIKTOK_FUNNY", comedyLevel: 4, pacingStyle: "FAST", punchlineMode: "REQUIRED" };
const PRO: Partial<StoredCreativeStyle> = { preset: "PROFESSIONAL", comedyLevel: 0, pacingStyle: "MEDIUM", punchlineMode: "NONE" };
const A = eff(TIKTOK);
const B = eff(PRO);
const GAG_ROLES = ["literal", "gag", "escalation", "punchline", "reaction", "payoff"];
const COMIC_SFX = ["record scratch", "comic boing", "boing", "rimshot", "cartoon gulp", "pop"];

const bird = {
  idiom: "A little bird told me",
  meaning: "Someone told me a secret",
  literalMeaning: "A tiny cartoon bird whispers into his ear",
  exampleSentence: "A little bird told me it is your birthday.",
  targetDuration: 25,
  stylePrompt: "",
  characters: [],
  avoidAngles: [],
  model: "mock",
  systemPrompt: "",
};
const roles = (doc: ScriptDoc) => doc.scenes.map((s) => s.sceneRole ?? "");
const total = (doc: ScriptDoc) => doc.scenes.reduce((n, s) => n + s.duration, 0);

// ------------------------------------------------------------------ pure ---

describe("K. cùng thành ngữ, hai phong cách: cấu trúc khác thật", () => {
  it("TikTok Comedy vs Professional (mock 'A little bird told me')", async () => {
    const a = (await new MockTextProvider().generateScript({ ...bird, creative: A })).script;
    const b = (await new MockTextProvider().generateScript({ ...bird, creative: B })).script;
    expect(roles(a)).toEqual(["hook", "literal", "gag", "escalation", "reaction", "meaning", "example", "payoff"]);
    expect(roles(b)).toEqual(["hook", "meaning", "example", "usage", "recap"]);
    // B: no gag beat, no comic sound, no punchline, plain hook.
    expect(roles(b).filter((r) => GAG_ROLES.includes(r))).toEqual([]);
    for (const s of b.scenes) expect(COMIC_SFX).not.toContain(s.soundEffect);
    expect(b.scenes[0]!.subtitle).not.toBe(a.scenes[0]!.subtitle);
    expect(a.scenes[0]!.soundEffect).toBe("record scratch");
    expect(b.punchline).toBe("");
    // A ends on the punchline.
    expect(roles(a).at(-1)).toBe("payoff");
    // Both are about as long as asked (no 3 x 6 s = 18 s).
    expect(total(a)).toBeGreaterThanOrEqual(24);
    expect(total(a)).toBeLessThanOrEqual(26);
    expect(total(b)).toBeGreaterThanOrEqual(24);
    expect(total(b)).toBeLessThanOrEqual(26);
  });

  it("prompt idiom-v2: Professional không còn vai 'comedy writer' / nhãn GAG; TikTok bắt buộc punchline", () => {
    const render = (s: EffectiveCreativeStyle) =>
      renderTemplate(readPromptFile("script-creative"), { ...bird, characters: "- Max", avoidAngles: "(none yet)", ...idiomV2PromptValues(s, 25) });
    const pb = render(B);
    const pa = render(A);
    expect(pb).not.toMatch(/\{\{\w+\}\}/);
    expect(pb).not.toMatch(/comedy writer/);
    expect(pb).not.toMatch(/LITERAL VISUAL GAG/);
    expect(pb).toMatch(/Exactly 5 scenes/);
    expect(pb).toMatch(/Punchline: none/);
    expect(pa).toMatch(/You are a comedy writer/);
    expect(pa).toMatch(/Punchline: REQUIRED/);
    expect(pa).toMatch(/FINAL PAYOFF/);
    // The hooks the two writers are asked for differ.
    const hook = (p: string) => p.split("\n").find((l) => /^\s+1\. /.test(l));
    expect(hook(pa)).toBeDefined();
    expect(creativeSummary(A)).toBe("Hài TikTok · Hài 4/5 · Nhịp nhanh · Punchline: bắt buộc");
  });
});

describe("C/D/E. hài 0, punchline bắt buộc, thời lượng", () => {
  it("C: hài 0 không bị chấm 'humor >= 7' và không có cảnh hài", () => {
    const low = { hook: 8, humor: 2, clarity: 9, learningValue: 9, visualFeasibility: 8, notes: "" };
    expect(scriptNeedsRewrite(low, B.comedyLevel)).toBe(false);
    expect(scriptNeedsRewrite(low, A.comedyLevel)).toBe(true);
    for (const d of [15, 25, 40, 60]) expect(idiomPlan(B, d).filter((r) => GAG_ROLES.includes(r))).toEqual([]);
  });

  it("D: hài 4 + REQUIRED luôn kết bằng punchline; NONE không có", () => {
    for (const d of [15, 25, 45]) expect(idiomPlan(A, d).at(-1)).toBe("payoff");
    expect(idiomPlan({ ...A, punchlineMode: "NONE" }, 25)).not.toContain("payoff");
    // REQUIRED at comedy 0 is a plain closing line, not a joke.
    const plain = eff({ comedyLevel: 0, punchlineMode: "REQUIRED" });
    expect(idiomPlan(plain, 25).at(-1)).toBe("payoff");
    expect(idiomV2PromptValues(plain, 25).structure).toMatch(/STRONG CLOSING LINE/);
    expect(idiomV2PromptValues(plain, 25).structure).not.toMatch(/FINAL PAYOFF \/ PUNCHLINE/);
  });

  it("E: 25 s và 45 s - kế hoạch đủ gần mục tiêu ở mọi nhịp", () => {
    for (const pacingStyle of ["SLOW", "MEDIUM", "FAST", "VERY_FAST"] as const) {
      for (const d of [25, 45]) {
        for (const s of [A, B]) {
          const n = idiomPlan({ ...s, pacingStyle }, d).length;
          expect(n * 6).toBeGreaterThanOrEqual(d);
          expect(n * 2).toBeLessThanOrEqual(d);
        }
      }
    }
    // Pacing changes the scene count for real.
    expect(idiomPlan({ ...B, pacingStyle: "VERY_FAST" }, 45).length).toBeGreaterThan(idiomPlan({ ...B, pacingStyle: "SLOW" }, 45).length);
  });

  it("Hài nhẹ: một hiểu nhầm nhẹ → nghĩa → ví dụ → kết nhẹ (không cường điệu)", async () => {
    const light = eff({ preset: "LIGHT_FUN" });
    expect(idiomPlan(light, 25).slice(0, 4)).toEqual(["hook", "literal", "meaning", "example"]);
    expect(idiomPlan(light, 25).at(-1)).toBe("payoff");
    expect(idiomPlan(light, 25)).not.toContain("escalation");
    expect(idiomV2PromptValues(light, 25).structure).toMatch(/SOFT PAYOFF/);
    const doc = (await new MockTextProvider().generateScript({ ...bird, creative: light })).script;
    expect(doc.scenes.at(-1)!.dialogue).not.toMatch(/did NOT need/);
  });

  it("Giáo dục (hài 1): nghĩa từng chữ nói bình thản, không âm thanh hài", async () => {
    const edu = eff({ preset: "EDUCATIONAL" });
    const doc = (await new MockTextProvider().generateScript({ ...bird, creative: edu })).script;
    expect(roles(doc)).not.toEqual(expect.arrayContaining(["gag", "escalation", "reaction", "punchline"]));
    const literal = doc.scenes.find((s) => s.sceneRole === "literal")!;
    expect(literal.subtitle).toMatch(/Word for word/);
    expect(literal.dialogue).not.toMatch(/do THAT/);
    for (const s of doc.scenes) expect(COMIC_SFX).not.toContain(s.soundEffect);
  });

  it("an toàn ngôn ngữ: cảnh 'khi nào dùng' nói đúng nghĩa của CHÍNH thành ngữ đó", async () => {
    const leg = { ...bird, idiom: "Break a leg", meaning: "Good luck", literalMeaning: "a cartoon leg", exampleSentence: "Break a leg on your interview!", targetDuration: 40 };
    const doc = (await new MockTextProvider().generateScript({ ...leg, creative: B })).script;
    const usage = doc.scenes.filter((s) => s.sceneRole === "usage");
    expect(usage.length).toBeGreaterThanOrEqual(2);
    expect(usage[0]!.dialogue).toContain("Good luck");
    expect(usage[0]!.dialogue).not.toMatch(/who told you/);
    // A second "when to use it" scene never repeats the first.
    expect(usage[1]!.dialogue).not.toBe(usage[0]!.dialogue);
  });
});

describe("dự toán lô theo phong cách", () => {
  it("không phong cách = profile 6 cảnh cũ y nguyên; có phong cách = số cảnh của idiomPlan", () => {
    expect(referenceProfileFor(null, 25)).toEqual(REFERENCE_SCENE_PROFILE);
    const a = referenceProfileFor(TIKTOK as StoredCreativeStyle, 25);
    const b = referenceProfileFor(PRO as StoredCreativeStyle, 25);
    expect(a).toHaveLength(8);
    expect(b).toHaveLength(5);
    expect(a.reduce((n, s) => n + s.duration, 0)).toBeCloseTo(25, 0);
    expect(b.reduce((n, s) => n + s.duration, 0)).toBeCloseTo(25, 0);
    expect(b.every((s) => s.complexity === "LOW")).toBe(true);
    expect(a.some((s) => s.complexity === "HIGH")).toBe(true);
  });
});

// ------------------------------------------------------------------ batch ---

describe("BATCH với phong cách (DB, mock)", () => {
  let capBefore = 0;
  const tag = Math.random().toString(36).slice(2, 7);
  const PHRASES = ["Hit the books", "Spill the beans", "Under the weather", "Piece of cake", "Cost an arm and a leg"];
  let idiomIds: string[] = [];

  const paid = async () => ({
    jobs: await prisma.providerJob.count({ where: { kind: { in: ["image", "video", "voice"] } } }),
    ledger: await prisma.costEntry.count({ where: { category: { in: ["image", "video", "voice"] } } }),
    paidText: await prisma.costEntry.count({ where: { category: "text", amount: { gt: 0 } } }),
  });

  async function runBatch(name: string, creativeStyle: StoredCreativeStyle | null, ids = idiomIds) {
    const batch = await prisma.batch.create({
      data: { name, amount: ids.length, qualityMode: "BALANCED", targetDuration: 25, maxCostPerVideo: 5, maxBudget: 0, status: "PLANNED" },
    });
    const plan = await planBatch(
      { idiomIds: ids, amount: ids.length, qualityMode: "BALANCED", targetDuration: 25, maxCostPerVideo: 5, creativeStyle },
      batch.id,
    );
    await savePlan(batch.id, plan);
    await createAuthorization({
      batchId: batch.id,
      estimatedCost: plan.estimatedTotal,
      maxCostPerVideo: 5,
      providerScope: plan.providerScope,
      videoCount: plan.runnableCount,
      qualityMode: "BALANCED",
    });
    return { batch, plan };
  }
  const approveAndWrite = async (batchId: string) => {
    await approveAuthorization({ batchId, authorizedMaxSpend: 20 });
    return materializeIdiomVideos(batchId);
  };
  const projectsOf = (batchId: string) =>
    prisma.project.findMany({ where: { batchId }, orderBy: { createdAt: "asc" }, include: { scenes: { orderBy: { sceneNumber: "asc" } } } });
  const docOf = (p: { scriptJson: string | null }) => JSON.parse(p.scriptJson!) as ScriptDoc;

  beforeAll(async () => {
    await seedMock();
    const s = await spendStatus();
    capBefore = s.cap;
    await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
    idiomIds = [];
    for (const phrase of PHRASES) {
      const slug = slugify(`${phrase}-${tag}`);
      const idiom = await prisma.idiom.create({
        data: { phrase: `${phrase} ${tag}`, slug, meaning: `the meaning of ${phrase}`, literalMeaning: `${phrase}, taken word for word`, exampleSentence: `I said "${phrase}" today.`, category: "test-qd136" },
      });
      idiomIds.push(idiom.id);
    }
  });
  afterAll(async () => {
    await setSpendCap(capBefore);
  });

  let tiktokBatch = "";
  let proBatch = "";

  it("A/J: lô 5 thành ngữ TikTok Comedy - mọi video cùng một phong cách, cấu trúc hài", async () => {
    const before = await paid();
    const { batch, plan } = await runBatch(`QĐ-136 TikTok ${tag}`, TIKTOK as StoredCreativeStyle);
    tiktokBatch = batch.id;
    expect(storedPlan(await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } }))!.creativeStyle).toMatchObject(TIKTOK);
    // The estimate prices the style's 8 scenes, not a 6-scene profile.
    for (const v of plan.videos) expect(v.sceneCount).toBe(8);

    const r = await approveAndWrite(batch.id);
    expect(r.created).toBe(5);
    const projects = await projectsOf(batch.id);
    expect(projects).toHaveLength(5);
    for (const p of projects) {
      expect(p.creativeStyleJson).not.toBeNull();
      expect(p.templateVersion).toBe(IDIOM_CREATIVE_PROMPT_VERSION);
      const doc = docOf(p);
      expect(doc.creativeStyle).toMatchObject({ preset: "TIKTOK_FUNNY", comedyLevel: 4, punchlineMode: "REQUIRED" });
      expect(roles(doc)).toEqual(idiomPlan(A, 25));
      expect(roles(doc).at(-1)).toBe("payoff");
      expect(p.scenes.reduce((n, s) => n + s.duration, 0)).toBeGreaterThanOrEqual(24);
    }
    // One style for all: no Professional / comedy mix.
    expect(new Set(projects.map((p) => p.creativeStyleJson)).size).toBe(1);
    expect(await paid()).toEqual(before);
  });

  it("B: lô Chuyên nghiệp hài 0 - không gag, không punchline, không âm thanh hài", async () => {
    const before = await paid();
    const ids = [];
    for (const phrase of ["Once in a blue moon", "Break the ice", "On the fence", "Call it a day", "Hit the sack"]) {
      ids.push((await prisma.idiom.create({ data: { phrase: `${phrase} ${tag}`, slug: slugify(`${phrase}-${tag}`), meaning: `the meaning of ${phrase}`, literalMeaning: `${phrase} literally`, exampleSentence: `We say "${phrase}".`, category: "test-qd136" } })).id);
    }
    const { batch, plan } = await runBatch(`QĐ-136 Pro ${tag}`, PRO as StoredCreativeStyle, ids);
    proBatch = batch.id;
    for (const v of plan.videos) expect(v.sceneCount).toBe(5);
    await approveAndWrite(batch.id);
    const projects = await projectsOf(batch.id);
    expect(projects).toHaveLength(5);
    for (const p of projects) {
      const doc = docOf(p);
      expect(doc.creativeStyle).toMatchObject({ preset: "PROFESSIONAL", comedyLevel: 0, punchlineMode: "NONE" });
      expect(roles(doc).filter((r) => GAG_ROLES.includes(r))).toEqual([]);
      expect(doc.title).not.toMatch(/Literally|😂/);
      expect(doc.punchline).toBe("");
      for (const s of p.scenes) expect(COMIC_SFX).not.toContain(s.soundEffect);
      // The rewrite gate sees comedy 0 - humour is never a reason to rewrite.
      expect(projectContent(p).creative.comedyLevel).toBe(0);
    }
    expect(await paid()).toEqual(before);
  });

  it("G/H: Camera Director + motion nhận phong cách của lô", async () => {
    const [tik] = await projectsOf(tiktokBatch);
    const [pro] = await projectsOf(proBatch);
    const ctx = (p: NonNullable<typeof tik>) => {
      const c = projectContent(p).creative;
      return { cameraPreset: c.cameraPreset, comedyLevel: c.comedyLevel, tone: c.tone, creativePreset: c.preset, contentType: null, emotion: c.emotionStyle, pacing: c.pacingStyle };
    };
    expect(effectiveCameraPreset(ctx(tik!))).toBe("FAST_COMEDY");
    expect(effectiveCameraPreset(ctx(pro!))).not.toBe("FAST_COMEDY");
    expect(presetMotion(ctx(tik!)).transitions).toBe("DYNAMIC");
    expect(presetMotion(ctx(pro!)).transitions).not.toBe("DYNAMIC");

    // The stored scene plans really differ: fast camera / dynamic cuts only in the comedy batch.
    const plans = (p: NonNullable<typeof tik>) => p.scenes.map((s) => JSON.parse(s.scenePlanJson ?? "null") as { camera: { cameraSpeed: string; transitionIn: string }; route: string } | null);
    const tp = plans(tik!);
    const pp = plans(pro!);
    expect(tp.every(Boolean)).toBe(true);
    expect(pp.every(Boolean)).toBe(true);
    expect(pp.some((x) => x!.camera.cameraSpeed === "FAST")).toBe(false);
    expect(pp.some((x) => ["WHIP", "ZOOM"].includes(x!.camera.transitionIn))).toBe(false);
    expect(tp.some((x) => x!.camera.cameraSpeed === "FAST" || ["WHIP", "ZOOM"].includes(x!.camera.transitionIn))).toBe(true);
    // An energetic style never asks for Video AI by itself (local motion first).
    expect(tp.some((x) => x!.route === "VIDEO_AI")).toBe(false);
  });

  it("F: đổi phong cách cả lô khi đã có media - chỉ lưu, Image/Video/Voice POST = 0", async () => {
    const projects = await projectsOf(tiktokBatch);
    const scene = projects[0]!.scenes[0]!;
    await prisma.scene.update({ where: { id: scene.id }, data: { imagePath: "projects/x/images/kept.png", audioPath: "projects/x/audio/kept.wav" } });
    const scripts = projects.map((p) => p.scriptJson);
    const before = await paid();
    const r = await applyBatchCreativeStyle(tiktokBatch, PRO);
    expect(r.changed).toBe(5);
    expect(r.withMedia).toBe(1);
    expect(r.planUpdated).toBe(false); // approved plan stays frozen
    expect(r.message).toMatch(/Media cũ vẫn được giữ/);
    const after = await projectsOf(tiktokBatch);
    expect(after.map((p) => p.scriptJson)).toEqual(scripts);
    expect(after.every((p) => JSON.parse(p.creativeStyleJson!).preset === "PROFESSIONAL")).toBe(true);
    const kept = await prisma.scene.findUniqueOrThrow({ where: { id: scene.id } });
    expect(kept.imagePath).toBe("projects/x/images/kept.png");
    expect(kept.audioPath).toBe("projects/x/audio/kept.wav");
    expect(await paid()).toEqual(before);
  });

  it("L: chạy lại / tiếp tục - không tạo dự án hay job trả phí trùng", async () => {
    const before = await paid();
    const jobs = await prisma.providerJob.count();
    const r = await materializeIdiomVideos(tiktokBatch);
    expect(r.created).toBe(0);
    expect(await prisma.project.count({ where: { batchId: tiktokBatch } })).toBe(5);
    expect(await prisma.providerJob.count()).toBe(jobs);
    expect(await paid()).toEqual(before);
  });

  it("I: lô cũ (kế hoạch không có creativeStyle) - chạy như trước, bộ viết gốc", async () => {
    const idiom = await prisma.idiom.create({
      data: { phrase: `Legacy idiom ${tag}`, slug: slugify(`legacy-${tag}`), meaning: "an old meaning", literalMeaning: "old literal", exampleSentence: "Old example.", category: "test-qd136" },
    });
    const { batch } = await runBatch(`QĐ-136 legacy ${tag}`, null, [idiom.id]);
    // A plan saved before this field existed.
    const row = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    const raw = JSON.parse(row.planJson) as Record<string, unknown>;
    delete raw.creativeStyle;
    await prisma.batch.update({ where: { id: batch.id }, data: { planJson: JSON.stringify(raw) } });
    expect(storedPlan(await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } }))!.creativeStyle).toBeUndefined();

    await approveAndWrite(batch.id);
    const [p] = await projectsOf(batch.id);
    expect(p!.creativeStyleJson).toBeNull();
    expect(p!.templateVersion).toBeNull();
    expect(docOf(p!).creativeStyle).toBeUndefined();
    expect(p!.scenes.length).toBeLessThanOrEqual(6);
    expect(projectContent(p!).creative.inferred).toBe(true);
  });
});
