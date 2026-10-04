import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { profileFromPlatform } from "@/domain/platform-profile";
import { CONTENT_TEMPLATES, formatOf, templateOf, validateRegistry } from "@/domain/content-templates";
import { projectContent } from "@/domain/content-legacy";
import { planScenes } from "@/domain/scene-planner";
import {
  CREATIVE_PRESETS,
  IDIOM_CREATIVE_PROMPT_VERSION,
  applyCreativeStructure,
  creativeBadges,
  creativeStylePrompt,
  paceFactor,
  resolveCreativeStyle,
  storedCreativeJson,
  type EffectiveCreativeStyle,
  type StoredCreativeStyle,
} from "@/domain/creative-style";
import { writeMockContentScript } from "@/providers/mock/mock-content-writer";
import { MockTextProvider, idiomBeatsFor } from "@/providers/mock/mock-text-provider";
import { idiomPlan, idiomStructureHint, idiomWriterVoice } from "@/domain/creative-style";
import { scriptNeedsRewrite } from "@/domain/script";
import { readPromptFile, renderTemplate } from "@/lib/prompts";
import type { ContentScriptRequest } from "@/providers/types";
import { createContentProject, generateContentProjectScript } from "@/services/content-service";
import { createProjectForIdiom, generateProjectScript } from "@/services/project-service";
import { saveCreativeStyle } from "@/services/creative-style";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { seedMock } from "./phase5-helpers";

/**
 * CREATIVE STYLE ENGINE (QĐ-127): one style system for every template. The
 * style must CHANGE the script (structure, wording, pacing, punchline) - and
 * must never change a fact, never touch media, and never alter an old project.
 * Mock only: no paid request of any kind.
 */

const style = (contentType: string, s: Partial<StoredCreativeStyle> | null): EffectiveCreativeStyle =>
  resolveCreativeStyle(templateOf(contentType).creative, s ? ({ version: "creative-v1", preset: "AUTO", ...s } as StoredCreativeStyle) : null);

function plan(contentType: string, s: EffectiveCreativeStyle, durationSeconds = 30, formatId?: string) {
  const t = templateOf(contentType);
  const f = formatOf(t, formatId);
  const beats = applyCreativeStructure(f.beats, s, t.creative, t.factual);
  return planScenes({ format: { ...f, beats }, durationSeconds, audience: t.defaultAudience, paceFactor: paceFactor(s) });
}

function request(contentType: string, s: EffectiveCreativeStyle, extra: Partial<ContentScriptRequest> = {}, formatId?: string): ContentScriptRequest {
  const t = templateOf(contentType);
  const beats = plan(contentType, s, extra.durationSeconds ?? 30, formatId);
  return {
    contentType,
    templateId: `${contentType}:x`,
    templateVersion: t.promptVersion,
    templateName: t.name,
    language: "vi",
    audience: t.defaultAudience,
    tone: s.tone,
    voiceMode: "NARRATION",
    durationSeconds: 30,
    beats: beats.map((b) => ({ role: b.role, label: b.displayLabel, purpose: b.purpose, durationSeconds: b.durationSeconds, motion: b.motion, prefersUserAsset: b.prefersUserAsset === true })),
    idea: "chim cánh cụt",
    sourceText: "",
    facts: [],
    cta: "",
    userAssets: [],
    characters: [],
    narrator: "Narrator",
    stylePrompt: "",
    factual: t.factual,
    creative: s,
    model: "mock",
    systemPrompt: "",
    ...extra,
  };
}

const roles = (r: ContentScriptRequest) => r.beats.map((b) => b.role);

// ------------------------------------------------------------------ pure ---

describe("ENGINE (pure)", () => {
  it("mọi template dùng chung một engine, có defaultCreativeStyle hợp lệ; mặc định theo loại video", () => {
    expect(validateRegistry()).toEqual([]);
    for (const t of CONTENT_TEMPLATES) expect(t.creative.defaults.comedyLevel).toBeGreaterThanOrEqual(0);
    const c = (id: string) => templateOf(id).creative.defaults.comedyLevel;
    expect(c("ENGLISH_IDIOM")).toBe(3);
    expect(c("PRODUCT_REVIEW")).toBe(1);
    expect([1, 2]).toContain(c("AI_REVIEW"));
    expect(c("TOY_WORLD")).toBe(3);
    expect(c("ANIMAL_FACT")).toBe(2);
    expect([0, 1]).toContain(c("KNOWLEDGE"));
    expect(c("ADVERTISEMENT")).toBe(1);
    expect(c("CUSTOM")).toBe(0);
    // Custom shows every control in Simple Mode.
    expect(templateOf("CUSTOM").creative.simpleFields).toEqual(expect.arrayContaining(["tone", "comedyLevel", "pacingStyle", "punchlineMode", "emotionStyle", "energyLevel"]));
    // Factual templates never get made-up gag situations.
    for (const t of CONTENT_TEMPLATES.filter((x) => x.factual)) expect(t.creative.storyGags).toBe(false);
  });

  it("preset chỉ map về các field (Hài TikTok, Chuyên nghiệp, Documentary, Viral nhanh); Tự động = mặc định template", () => {
    expect(CREATIVE_PRESETS.map((p) => p.id)).toEqual(
      expect.arrayContaining(["NATURAL", "PROFESSIONAL", "LIGHT_FUN", "TIKTOK_FUNNY", "CUTE", "ENERGETIC", "EDUCATIONAL", "DRAMATIC", "EMOTIONAL", "MYSTERY", "PREMIUM", "DOCUMENTARY", "VIRAL_FAST", "CUSTOM"]),
    );
    expect(style("PRODUCT_REVIEW", { preset: "TIKTOK_FUNNY" })).toMatchObject({ tone: "FUN", comedyLevel: 4, pacingStyle: "FAST", punchlineMode: "REQUIRED", energyLevel: 5 });
    expect(style("PRODUCT_REVIEW", { preset: "PROFESSIONAL" })).toMatchObject({ tone: "PROFESSIONAL", comedyLevel: 0, punchlineMode: "NONE" });
    expect(style("ANIMAL_FACT", { preset: "DOCUMENTARY" })).toMatchObject({ tone: "DOCUMENTARY", comedyLevel: 0 });
    expect(style("TOY_WORLD", { preset: "VIRAL_FAST" })).toMatchObject({ pacingStyle: "VERY_FAST", comedyLevel: 3, energyLevel: 5 });
    // A field changed after picking a preset wins; the rest stays the preset's.
    expect(style("STORY", { preset: "TIKTOK_FUNNY", comedyLevel: 2 })).toMatchObject({ comedyLevel: 2, pacingStyle: "FAST" });
    const auto = style("ENGLISH_IDIOM", null);
    expect(auto).toMatchObject({ tone: "PLAYFUL", comedyLevel: 3, pacingStyle: "FAST", punchlineMode: "PREFERRED", inferred: true });
    expect(storedCreativeJson({ preset: "AUTO" })).toBeNull();
    expect(storedCreativeJson({ preset: "AUTO", comedyLevel: 4 })).not.toBeNull();
  });

  it("khối prompt dùng thật mọi field; nội dung factual luôn có luật 'không bịa sự thật'", () => {
    const s = style("PRODUCT_REVIEW", { preset: "TIKTOK_FUNNY", comedyStyles: ["REACTION", "ESCALATION"], emotionStyle: "SURPRISE" });
    const p = creativeStylePrompt(s, { factual: true, storyGags: false });
    expect(p).toMatch(/Comedy level: 4\/5/);
    expect(p).toMatch(/Pacing: fast/);
    expect(p).toMatch(/Punchline: REQUIRED/);
    expect(p).toMatch(/Emotion: surprise/);
    expect(p).toMatch(/Energy: 5\/5/);
    expect(p).toMatch(/big facial/);
    expect(p).toMatch(/factual correctness > reference consistency .*> creative style/);
    expect(p).toMatch(/Never invent or bend a feature, price, specification/);
    expect(creativeBadges(s).map((b) => `${b.label}: ${b.value}`)).toEqual(["Phong cách: Hài TikTok", "Hài: 4/5", "Nhịp: Nhanh", "Punchline: Bắt buộc", "Cảm xúc: Bất ngờ"]);
  });

  it("nhịp: Nhanh có nhiều cảnh ngắn hơn Chậm với cùng thời lượng", () => {
    const fast = plan("KNOWLEDGE", style("KNOWLEDGE", { pacingStyle: "FAST" }), 45);
    const slow = plan("KNOWLEDGE", style("KNOWLEDGE", { pacingStyle: "SLOW" }), 45);
    expect(fast.length).toBeGreaterThan(slow.length);
  });
});

describe("TEMPLATE BEHAVIOUR (pure, mock writer)", () => {
  it("TOY: Hài 5 → cấu trúc cường điệu (phản ứng, cường điệu, punchline) khác hẳn Hài 0", () => {
    const zero = request("TOY_WORLD", style("TOY_WORLD", { comedyLevel: 0, punchlineMode: "NONE" }));
    const five = request("TOY_WORLD", style("TOY_WORLD", { comedyLevel: 5, comedyStyles: ["VISUAL_GAG", "ESCALATION"], punchlineMode: "REQUIRED" }));
    expect(roles(zero)).not.toContain("reaction");
    expect(roles(zero)).not.toContain("payoff");
    expect(roles(five)).toEqual(expect.arrayContaining(["reaction", "escalation", "gag", "payoff"]));
    // The payoff closes the video (only the template's closing beat after it).
    const r5 = roles(five);
    expect(r5.indexOf("payoff")).toBeGreaterThan(r5.indexOf("escalation"));
    expect(r5.slice(r5.indexOf("payoff") + 1).every((r) => r === "ending")).toBe(true);
    const doc = writeMockContentScript(five);
    expect(doc.scenes[0]!.narration).not.toBe(writeMockContentScript(zero).scenes[0]!.narration);
    expect(doc.scenes.some((s) => s.soundEffect === "record scratch" || s.soundEffect === "ding" || s.soundEffect === "pop")).toBe(true);
  });

  it("PRODUCT REVIEW Hài 4: chỉ phản ứng + punchline, không gag bịa; mọi con số đều từ thông tin người dùng", () => {
    const facts = [
      { text: "Dung tích 500ml", origin: "USER_PROVIDED" as const },
      { text: "Giữ nóng 12 giờ", origin: "USER_PROVIDED" as const },
    ];
    const req = request("PRODUCT_REVIEW", style("PRODUCT_REVIEW", { preset: "TIKTOK_FUNNY", comedyLevel: 4 }), { facts, subjectName: "Bình giữ nhiệt Mind" });
    expect(roles(req)).toEqual(expect.arrayContaining(["reaction", "payoff"]));
    expect(roles(req)).not.toContain("escalation");
    expect(roles(req)).not.toContain("gag");
    const doc = writeMockContentScript(req);
    const text = doc.scenes.map((s) => `${s.narration} ${s.subtitle}`).join(" ");
    for (const f of facts) expect(text).toContain(f.text.slice(1));
    for (const n of text.replace(/Điểm \d+/g, "").match(/\d+/g) ?? []) expect(["500", "12"]).toContain(n);
    expect((doc.facts ?? []).filter((f) => f.origin === "AI_GENERATED")).toEqual([]);
    expect(doc.scenes.find((s) => s.sceneRole === "payoff")!.narration).not.toMatch(/😂/);
  });

  it("ANIMAL (factual) Hài 3: nội dung nguồn giữ nguyên, đủ câu, đúng thứ tự", () => {
    const sourceText = "Chim cánh cụt không bay được. Chúng bơi rất giỏi dưới nước lạnh.\n\nChim cánh cụt hoàng đế sống ở Nam Cực.";
    const req = request("ANIMAL_FACT", style("ANIMAL_FACT", { comedyLevel: 3 }), { sourceText });
    expect(roles(req)).toContain("reaction");
    const doc = writeMockContentScript(req);
    const said = doc.scenes.map((s) => s.narration).join(" ");
    for (const sentence of ["Chim cánh cụt không bay được.", "Chúng bơi rất giỏi dưới nước lạnh.", "Chim cánh cụt hoàng đế sống ở Nam Cực."]) expect(said).toContain(sentence);
    expect(said.indexOf("không bay được")).toBeLessThan(said.indexOf("Nam Cực"));
  });

  it("KNOWLEDGE Chuyên nghiệp vs Tinh nghịch: lời khác nhau, sự thật giống nhau", () => {
    const sourceText = "Ánh sáng xanh bị tán xạ mạnh hơn ánh sáng đỏ. Vì vậy bầu trời ban ngày có màu xanh.";
    const pro = writeMockContentScript(request("KNOWLEDGE", style("KNOWLEDGE", { preset: "PROFESSIONAL" }), { sourceText }));
    const fun = writeMockContentScript(request("KNOWLEDGE", style("KNOWLEDGE", { tone: "PLAYFUL", comedyLevel: 2 }), { sourceText }));
    expect(pro.scenes[0]!.narration).not.toBe(fun.scenes[0]!.narration);
    for (const doc of [pro, fun]) {
      const said = doc.scenes.map((s) => s.narration).join(" ");
      expect(said).toContain("Ánh sáng xanh bị tán xạ mạnh hơn ánh sáng đỏ.");
      expect(said).toContain("Vì vậy bầu trời ban ngày có màu xanh.");
    }
  });

  it("STORY Cảm xúc vs Hài: cấu trúc và lời khác nhau", () => {
    const emotional = request("STORY", style("STORY", { preset: "EMOTIONAL" }), {}, "short");
    const funny = request("STORY", style("STORY", { preset: "TIKTOK_FUNNY" }), {}, "short");
    expect(roles(emotional)).toContain("moment");
    expect(roles(emotional)).not.toContain("payoff");
    expect(roles(funny)).toEqual(expect.arrayContaining(["reaction", "escalation", "payoff"]));
    expect(roles(funny)).not.toContain("moment");
    const e = writeMockContentScript(emotional);
    const f = writeMockContentScript(funny);
    expect(e.scenes.at(-1)!.narration).not.toBe(f.scenes.at(-1)!.narration);
    expect(e.scenes[0]!.narration).not.toBe(f.scenes[0]!.narration);
  });

  it("CUSTOM: đủ điều khiển; punchline Bắt buộc → có punchline gần cuối; Không cần → không có", () => {
    const req = request("CUSTOM", style("CUSTOM", { tone: "FUN", comedyLevel: 3, punchlineMode: "REQUIRED", pacingStyle: "FAST", emotionStyle: "SURPRISE", energyLevel: 4 }));
    const r = roles(req);
    expect(r).toContain("payoff");
    expect(r.length - 1 - r.indexOf("payoff")).toBeLessThanOrEqual(1);
    expect(roles(request("CUSTOM", style("CUSTOM", { punchlineMode: "NONE", comedyLevel: 3 })))).not.toContain("payoff");
  });

  it("IDIOM (bộ viết cũ): Hài 0 vs Hài 4 → cấu trúc khác đáng kể; Hài 4 có gag, cường điệu, phản ứng, punchline", async () => {
    const zeroRoles = idiomBeatsFor(style("ENGLISH_IDIOM", { comedyLevel: 0, pacingStyle: "MEDIUM" }), 25).map((b) => b.role);
    const fourRoles = idiomBeatsFor(style("ENGLISH_IDIOM", { comedyLevel: 4, punchlineMode: "REQUIRED" })).map((b) => b.role);
    // Comedy 0 explains (no literal / gag / escalation / punchline) and still fills 25 s.
    expect(zeroRoles).toEqual(["hook", "meaning", "example", "usage", "recap"]);
    expect(fourRoles).toEqual(["hook", "literal", "gag", "escalation", "reaction", "meaning", "example", "payoff"]);
    const provider = new MockTextProvider();
    const base = {
      idiom: "a little bird told me",
      meaning: "someone told me a secret",
      literalMeaning: "a real bird talking",
      exampleSentence: "A little bird told me it is your birthday.",
      targetDuration: 25,
      stylePrompt: "",
      characters: [],
      avoidAngles: [],
      model: "mock",
      systemPrompt: "",
    };
    const plain = (await provider.generateScript(base)).script;
    const four = (await provider.generateScript({ ...base, creative: style("ENGLISH_IDIOM", { comedyLevel: 4, punchlineMode: "REQUIRED" }) })).script;
    expect(plain.scenes.length).toBeLessThanOrEqual(6);
    expect(four.scenes.length).toBe(8);
    expect(four.scenes.at(-1)!.subtitle).toMatch(/did NOT need/);
  });
});

// -------------------------------------------------------------- database ---

describe("PROJECT (DB, mock)", () => {
  let capBefore = 0;
  const paidMedia = async () => ({
    image: await prisma.providerJob.count({ where: { kind: "image" } }),
    video: await prisma.providerJob.count({ where: { kind: "video" } }),
    voice: await prisma.providerJob.count({ where: { kind: "voice" } }),
    ledger: await prisma.costEntry.count({ where: { category: { in: ["image", "video", "voice"] } } }),
    paidText: await prisma.costEntry.count({ where: { category: "text", amount: { gt: 0 } } }),
  });

  beforeAll(async () => {
    await seedMock();
    const s = await spendStatus();
    capBefore = s.cap;
    await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  }, 300_000);
  afterAll(async () => {
    if (capBefore > 0) await setSpendCap(capBefore);
  });

  it("chọn phong cách trước khi tạo kịch bản → lưu, prompt -v2, badge trên kịch bản", async () => {
    const p = await createContentProject({
      contentType: "TOY_WORLD",
      sourceType: "PROMPT",
      idea: "Xe tải đồ chơi khám phá công trường",
      durationSeconds: 30,
      outputProfile: profileFromPlatform("TIKTOK"),
      creativeStyle: { preset: "TIKTOK_FUNNY" },
    });
    expect(p.creativeStyleJson).toContain("TIKTOK_FUNNY");
    expect(p.templateVersion).toBe("toy-world-v2");
    const doc = JSON.parse(p.scriptJson!) as { creativeStyle: EffectiveCreativeStyle; scenes: { sceneRole: string }[] };
    expect(doc.creativeStyle).toMatchObject({ preset: "TIKTOK_FUNNY", comedyLevel: 4, punchlineMode: "REQUIRED" });
    expect(doc.scenes.map((s) => s.sceneRole)).toEqual(expect.arrayContaining(["reaction", "escalation", "payoff"]));
  }, 300_000);

  it("đổi Hài 2 → 4 rồi VIẾT LẠI: kịch bản đổi; 0 Image / Video / Voice POST, 0 Text trả phí", async () => {
    const p = await createContentProject({
      contentType: "STORY",
      sourceType: "PROMPT",
      idea: "Chú thỏ nhỏ học cách chia sẻ",
      durationSeconds: 30,
      outputProfile: profileFromPlatform("TIKTOK"),
      creativeStyle: { preset: "LIGHT_FUN", comedyLevel: 2 },
    });
    const before = await paidMedia();
    const oldRoles = (JSON.parse(p.scriptJson!) as { scenes: { sceneRole: string }[] }).scenes.map((s) => s.sceneRole);
    const saved = await saveCreativeStyle(p.id, { preset: "LIGHT_FUN", comedyLevel: 4 });
    expect(saved.changed).toBe(true);
    expect(saved.canRewrite).toBe(true);
    // Saving alone never rewrites.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).scriptJson).toBe(p.scriptJson);
    const script = await generateContentProjectScript(p.id);
    expect(script.scenes.map((s) => s.sceneRole)).not.toEqual(oldRoles);
    expect(script.scenes.map((s) => s.sceneRole)).toContain("escalation");
    const after = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.scriptApprovedAt).toBeNull();
    expect(await paidMedia()).toEqual(before);
  }, 300_000);

  it("project cũ (không creativeStyle): mở bình thường, suy ra từ template; idiom 'Tự động' = bộ viết cũ không đổi", async () => {
    const legacy = projectContent({ contentType: null, creativeStyleJson: null });
    expect(legacy.creative).toMatchObject({ inferred: true, comedyLevel: 3 });
    const tag = Math.random().toString(36).slice(2, 8);
    const idiom = await prisma.idiom.create({
      data: { phrase: `A little bird told me ${tag}`, slug: `albtm-${tag}`, meaning: "someone told me a secret", literalMeaning: "a real bird talking", exampleSentence: "A little bird told me it is your birthday.", category: "test" },
    });
    const auto = await createProjectForIdiom({ idiomId: idiom.id, qualityMode: "BALANCED", autoGenerateScript: true, creativeStyle: { preset: "AUTO" } });
    expect(auto.creativeStyleJson).toBeNull();
    expect(auto.templateVersion).toBeNull();
    expect((JSON.parse(auto.scriptJson!) as { creativeStyle?: unknown }).creativeStyle).toBeUndefined();

    const zero = await createProjectForIdiom({ idiomId: idiom.id, qualityMode: "BALANCED", autoGenerateScript: true, creativeStyle: { comedyLevel: 0 } });
    const four = await createProjectForIdiom({ idiomId: idiom.id, qualityMode: "BALANCED", autoGenerateScript: true, creativeStyle: { comedyLevel: 4, punchlineMode: "REQUIRED" } });
    expect(zero.templateVersion).toBe(IDIOM_CREATIVE_PROMPT_VERSION);
    const count = async (id: string) => prisma.scene.count({ where: { projectId: id } });
    expect(await count(zero.id)).toBe(idiomPlan(style("ENGLISH_IDIOM", { comedyLevel: 0 }), zero.targetDuration).length);
    expect(await count(four.id)).toBe(8);
    expect(await count(zero.id)).toBeLessThan(8);
    // Rewriting an idiom project with a changed style also stays text-only.
    const before = await paidMedia();
    await saveCreativeStyle(zero.id, { comedyLevel: 5 });
    await generateProjectScript(zero.id);
    expect(await count(zero.id)).toBe(8);
    expect(await paidMedia()).toEqual(before);
  }, 300_000);

  it("đã có media: đổi phong cách chỉ lưu, giữ media, không viết lại, không mua gì", async () => {
    const p = await createContentProject({
      contentType: "KNOWLEDGE",
      sourceType: "PROMPT",
      idea: "Vì sao bầu trời màu xanh?",
      durationSeconds: 15,
      outputProfile: profileFromPlatform("TIKTOK"),
    });
    const scene = await prisma.scene.findFirstOrThrow({ where: { projectId: p.id } });
    await prisma.scene.update({ where: { id: scene.id }, data: { imagePath: "projects/x/images/old.png" } });
    await prisma.project.update({ where: { id: p.id }, data: { status: "media_ready" } });
    const before = await paidMedia();
    const r = await saveCreativeStyle(p.id, { preset: "TIKTOK_FUNNY" });
    expect(r).toMatchObject({ changed: true, mediaExists: true, canRewrite: false });
    expect(r.message).toMatch(/Media cũ vẫn được giữ/);
    await expect(generateContentProjectScript(p.id)).rejects.toMatchObject({ code: "MEDIA_STARTED" });
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: scene.id } })).imagePath).toBe("projects/x/images/old.png");
    expect(await paidMedia()).toEqual(before);
  }, 300_000);
});

// ------------------------------------------- QĐ-127 UI test fixes (4 bugs) ---

describe("IDIOM CREATIVE FIXES (UI test A/B)", () => {
  const A = style("ENGLISH_IDIOM", { preset: "TIKTOK_FUNNY", comedyLevel: 4, pacingStyle: "FAST", punchlineMode: "REQUIRED" });
  const B = style("ENGLISH_IDIOM", { preset: "PROFESSIONAL", comedyLevel: 0, pacingStyle: "MEDIUM", punchlineMode: "NONE" });
  const base = {
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

  it("lỗi 1: bản Chuyên nghiệp (hài 0) có tiêu đề, hook, CTA và cảnh mở đầu trung tính - không hài", async () => {
    const b = (await new MockTextProvider().generateScript({ ...base, creative: B })).script;
    expect(b.title).not.toMatch(/Literally|😂/);
    expect(b.hook).not.toMatch(/did exactly that/);
    expect(b.closingCTA).not.toMatch(/funny/i);
    expect([b.setup, b.escalation, b.punchline]).toEqual(["", "", ""]);
    const first = b.scenes[0]!;
    expect(first.soundEffect).not.toBe("record scratch");
    expect(first.camera).not.toMatch(/surprised/);
    expect(first.subtitle).not.toMatch(/\?!/);
    for (const s of b.scenes) expect(["record scratch", "comic boing", "boing", "rimshot", "cartoon gulp"]).not.toContain(s.soundEffect);
    // Bản Hài TikTok giữ hook hài.
    const a = (await new MockTextProvider().generateScript({ ...base, creative: A })).script;
    expect(a.title).toMatch(/Literally/);
    expect(a.scenes[0]!.soundEffect).toBe("record scratch");
  });

  it("lỗi 2: idiom-v2 dùng prompt riêng - hài 0 KHÔNG còn 'comedy writer', cấu trúc hài cứng hay '4 to 6 scenes'", () => {
    const render = (s: typeof A) =>
      renderTemplate(readPromptFile("script-creative"), {
        ...base,
        characters: "- Max", avoidAngles: "(none yet)",
        ...idiomWriterVoice(s),
        creativeStyle: creativeStylePrompt(s, { factual: false, storyGags: true }),
        structure: idiomStructureHint(s, 25),
        sceneRange: `Exactly ${idiomPlan(s, 25).length}`,
      });
    const pb = render(B);
    expect(pb).not.toMatch(/\{\{\w+\}\}/);
    expect(pb).not.toMatch(/You are a comedy writer/);
    expect(pb).not.toMatch(/ESCALATION and PUNCHLINE/);
    expect(pb).not.toMatch(/4 to 6 scenes/);
    expect(pb).toMatch(/NOT a comedy sketch/);
    expect(pb).toMatch(/Exactly 5 scenes/);
    expect(pb).toMatch(/Comedy level: 0\/5/);
    const pa = render(A);
    expect(pa).toMatch(/You are a comedy writer/);
    expect(pa).toMatch(/Exactly 8 scenes/);
    expect(pa).toMatch(/FINAL PAYOFF/);
    // "Tự động" (idiom-v1) is untouched.
    expect(readPromptFile("script")).toMatch(/^You are a comedy writer/);
    expect(readPromptFile("script")).toMatch(/4 to 6 scenes/);
  });

  it("lỗi 3: hài 0-1 không bị viết lại vì điểm 'humor' thấp; hài khác vẫn giữ luật cũ", () => {
    const score = { hook: 8, humor: 3, clarity: 9, learningValue: 9, visualFeasibility: 8, notes: "" };
    expect(scriptNeedsRewrite(score)).toBe(true);
    expect(scriptNeedsRewrite(score, 4)).toBe(true);
    expect(scriptNeedsRewrite(score, 1)).toBe(false);
    expect(scriptNeedsRewrite(score, 0)).toBe(false);
    expect(scriptNeedsRewrite({ ...score, clarity: 5 }, 0)).toBe(true);
  });

  it("lỗi 4: bản Chuyên nghiệp đủ 25 giây (không còn 3 × 6 s = 18 s); nhịp đổi số cảnh", async () => {
    const b = (await new MockTextProvider().generateScript({ ...base, creative: B })).script;
    const total = b.scenes.reduce((n, s) => n + s.duration, 0);
    expect(total).toBeGreaterThanOrEqual(24);
    expect(total).toBeLessThanOrEqual(26);
    expect(b.scenes.map((s) => s.sceneRole ?? "")).toBeDefined();
    for (const d of [15, 25, 45, 60]) {
      const plan = idiomPlan(B, d);
      expect(plan.length * 6).toBeGreaterThanOrEqual(d);
      expect(plan).not.toEqual(expect.arrayContaining(["literal", "gag", "escalation", "punchline", "payoff", "reaction"]));
    }
    expect(idiomPlan({ ...B, pacingStyle: "SLOW" }, 30).length).toBeLessThan(idiomPlan({ ...B, pacingStyle: "FAST" }, 30).length);
    // A keeps its 8 beats and ends on the payoff.
    expect(idiomPlan(A, 25)).toEqual(["hook", "literal", "gag", "escalation", "reaction", "meaning", "example", "payoff"]);
  });
});
