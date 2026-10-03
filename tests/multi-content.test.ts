import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { profileFromPlatform } from "@/domain/platform-profile";
import { spokenLines } from "@/domain/scene-subtitles";
import { sceneCharacters } from "@/domain/scene-characters";
import { detectLanguage } from "@/providers/mock/mock-content-writer";
import {
  approveContentScript,
  createContentProject,
  generateContentProjectScript,
  type CreateContentProjectInput,
} from "@/services/content-service";
import { createProjectForIdiom, generateProjectScript, startMediaGeneration } from "@/services/project-service";
import { approveAndRun } from "@/services/batch-executor";
import { preflightImportedBatch } from "@/services/import-preflight";
import { setOutputProfile } from "@/services/output-profile";
import { continueVideo } from "@/services/video-resume";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { makePng, seedMock } from "./phase5-helpers";

/**
 * Multi-content engine (Phases B-F): any template, from a prompt, pasted text
 * or the person's own pictures, becomes ordinary Scene rows - and nothing but
 * the (mock, $0) text call happens until DUYỆT KỊCH BẢN.
 */

let tmp = "";
let capBefore = 0;
const png: Buffer[] = [];

const paidMedia = async () => ({
  image: await prisma.providerJob.count({ where: { kind: "image" } }),
  video: await prisma.providerJob.count({ where: { kind: "video" } }),
  voice: await prisma.providerJob.count({ where: { kind: "voice" } }),
  ledger: await prisma.costEntry.count({ where: { category: { in: ["image", "video", "voice"] } } }),
});

async function make(input: Partial<CreateContentProjectInput> & { contentType: string }) {
  const project = await createContentProject({
    sourceType: "PROMPT",
    outputProfile: profileFromPlatform("TIKTOK"),
    ...input,
  });
  const scenes = await prisma.scene.findMany({ where: { projectId: project.id }, orderBy: { sceneNumber: "asc" } });
  const script = JSON.parse(project.scriptJson!) as { scenes: { sceneRole?: string }[]; facts?: { origin: string }[]; needsFactReview?: boolean; language?: string };
  return { project, scenes, script, roles: script.scenes.map((s) => s.sceneRole) };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multi-content-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  for (const colour of ["red", "green", "blue"]) png.push(fs.readFileSync(await makePng(tmp, colour, "1200x1200")));
});

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("PROMPT → storyboard", () => {
  it("“Làm video 30 giây giải thích ChatGPT cho cửa hàng nhỏ” → storyboard hợp lệ, chưa tạo media", async () => {
    const before = await paidMedia();
    const { project, scenes, script } = await make({
      contentType: "AI_REVIEW",
      idea: "Làm video 30 giây giải thích ChatGPT cho cửa hàng nhỏ",
      durationSeconds: 30,
      language: "vi",
    });
    expect(project.contentType).toBe("AI_REVIEW");
    expect(project.templateVersion).toBe("ai-review-v1");
    expect(project.status).toBe("script_ready");
    expect(project.scriptApprovedAt).toBeNull();
    expect(scenes.length).toBeGreaterThanOrEqual(5);
    expect(scenes.length).toBeLessThanOrEqual(7);
    for (const s of scenes) {
      expect(s.visualDescription.length).toBeGreaterThan(0);
      expect(s.imagePrompt.length).toBeGreaterThan(0);
      expect(s.videoPrompt.length).toBeGreaterThan(0);
      expect(s.narration.length).toBeGreaterThan(0);
      expect(s.duration).toBeGreaterThanOrEqual(2);
      expect(s.duration).toBeLessThanOrEqual(6);
      // The narrator speaks, and is never drawn.
      const cast = sceneCharacters(s);
      expect(cast.speaking).toEqual(["Narrator"]);
      expect(cast.present).toEqual([]);
      expect(spokenLines(s)).toHaveLength(1);
    }
    expect(detectLanguage(scenes.map((s) => s.narration).join(" "))).toBe("vi");
    expect(script.language).toBe("vi");
    // AI-written facts about a real tool are flagged for a person to check.
    expect(script.needsFactReview).toBe(true);
    expect(await paidMedia()).toEqual(before);
    // The only call was the mock text call, recorded like any other.
    const text = await prisma.providerJob.findMany({ where: { projectId: project.id } });
    expect(text.map((j) => `${j.kind}/${j.provider}`)).toEqual(["text/mock"]);
  });

  it("AI REVIEW: đúng cấu trúc hook → làm gì → tính năng → demo → hạn chế → phù hợp với ai", async () => {
    const { roles } = await make({ contentType: "AI_REVIEW", idea: "Canva Magic Write", durationSeconds: 45 });
    expect(roles[0]).toBe("hook");
    expect(roles[1]).toBe("what");
    expect(roles).toContain("feature");
    expect(roles.indexOf("demo")).toBeGreaterThan(roles.indexOf("feature"));
    expect(roles.indexOf("limits")).toBeGreaterThan(roles.indexOf("demo"));
    expect(roles.indexOf("for-who")).toBeGreaterThan(roles.indexOf("limits"));
  });

  it("CUSTOM không ép cấu trúc thành ngữ", async () => {
    const { roles, scenes, project } = await make({ contentType: "CUSTOM", idea: "Làm video 45 giây về cách pha cà phê phin", durationSeconds: 45 });
    for (const idiomBeat of ["literal", "punchline", "meaning", "example"]) expect(roles).not.toContain(idiomBeat);
    expect(scenes.map((s) => s.narration).join(" ")).not.toMatch(/idiom|thành ngữ/i);
    expect(project.title).not.toMatch(/Funny Idiom/);
  });

  it("TOY: các cảnh câu chuyện + gợi ý âm thanh; ANIMALS: cấu trúc sự thật", async () => {
    const toy = await make({ contentType: "TOY_WORLD", idea: "Xe tải đồ chơi khám phá công trường", durationSeconds: 30 });
    expect(toy.roles).toEqual(expect.arrayContaining(["hook", "explore", "challenge", "solve", "ending"]));
    expect(toy.scenes.some((s) => s.soundEffect.length > 0)).toBe(true);
    expect(toy.project.audience).toBe("KIDS");
    const animals = await make({ contentType: "ANIMAL_FACT", idea: "5 sự thật về chim cánh cụt", durationSeconds: 30 });
    expect(animals.roles[0]).toBe("hook");
    expect(animals.roles.filter((r) => r === "fact").length).toBeGreaterThanOrEqual(3);
    const story = await make({ contentType: "STORY", formatId: "lesson", idea: "Chú thỏ học cách chia sẻ", durationSeconds: 30 });
    expect(story.roles).toEqual(expect.arrayContaining(["intro", "event", "lesson"]));
    const know = await make({ contentType: "KNOWLEDGE", idea: "Vì sao bầu trời màu xanh?", durationSeconds: 45 });
    expect(know.roles).toEqual(expect.arrayContaining(["hook", "question", "explain", "example", "conclusion"]));
    const ad = await make({ contentType: "ADVERTISEMENT", idea: "In bạt giá tốt", cta: "Gọi 0900 000 000", durationSeconds: 15 });
    expect(ad.scenes.map((s) => s.narration).join(" ")).not.toMatch(/\d{3,}.*\d{3,}/); // no invented phone numbers in body
  });

  it("URL: kiến trúc có, nhưng chưa đọc link tự động → báo rõ, không tạo dự án nửa vời", async () => {
    const count = await prisma.project.count();
    await expect(
      createContentProject({ contentType: "PRODUCT_REVIEW", sourceType: "URL", sourceUrl: "https://example.com/p" }),
    ).rejects.toMatchObject({ code: "URL_SOURCE_NOT_AVAILABLE" });
    expect(await prisma.project.count()).toBe(count);
  });
});

describe("TEXT → script (giữ nội dung nguồn)", () => {
  it("dán đoạn văn → kịch bản giữ câu chính của từng đoạn, đúng thứ tự", async () => {
    const text = [
      "Cửa hàng nhỏ có thể dùng ChatGPT để viết mô tả sản phẩm nhanh hơn. Việc này tiết kiệm nhiều giờ mỗi tuần.",
      "Công cụ cũng giúp trả lời tin nhắn khách hàng lịch sự và nhất quán. Chủ cửa hàng vẫn nên kiểm tra lại câu trả lời.",
      "Cuối cùng, ChatGPT gợi ý ý tưởng khuyến mãi theo mùa. Bạn chọn ý tưởng phù hợp với cửa hàng mình.",
    ].join("\n\n");
    const { scenes, project } = await make({ contentType: "KNOWLEDGE", sourceType: "TEXT", sourceText: text, durationSeconds: 45 });
    expect(project.sourceText).toBe(text);
    const spoken = scenes.map((s) => s.narration).join(" ");
    const mains = [
      "Cửa hàng nhỏ có thể dùng ChatGPT để viết mô tả sản phẩm nhanh hơn.",
      "Công cụ cũng giúp trả lời tin nhắn khách hàng lịch sự và nhất quán.",
      "Cuối cùng, ChatGPT gợi ý ý tưởng khuyến mãi theo mùa.",
    ];
    for (const m of mains) expect(spoken).toContain(m);
    expect(spoken.indexOf(mains[0]!)).toBeLessThan(spoken.indexOf(mains[1]!));
    expect(spoken.indexOf(mains[1]!)).toBeLessThan(spoken.indexOf(mains[2]!));
  });
});

describe("PRODUCT REVIEW + ảnh thật", () => {
  it("tên + mô tả + 3 ảnh → review, ưu tiên ảnh thật (IMPORTED + LOCAL_MOTION), không bịa trải nghiệm, $0 ảnh", async () => {
    const before = await paidMedia();
    const { project, scenes, script } = await make({
      contentType: "PRODUCT_REVIEW",
      sourceType: "ASSETS",
      subjectName: "Bình giữ nhiệt Mind 500ml",
      idea: "Bình giữ nhiệt inox cho dân văn phòng",
      facts: [{ text: "Dung tích 500ml" }, { text: "Giữ nóng 12 giờ theo nhà sản xuất" }, { text: "Nắp chống tràn" }],
      uploads: png.map((bytes, i) => ({ bytes, filename: `san-pham-${i + 1}.png` })),
      durationSeconds: 30,
    });
    const withPhoto = scenes.filter((s) => s.imageSource === "IMPORTED");
    expect(withPhoto.length).toBeGreaterThanOrEqual(3);
    for (const s of withPhoto) {
      expect(s.motionMode).toBe("LOCAL_MOTION");
      expect(s.imagePath && fs.existsSync(toAbsolute(s.imagePath))).toBe(true);
    }
    // All three uploads are used, and all are in the Asset Library as IMPORTED, $0.
    const uploads = await prisma.asset.findMany({ where: { projectId: project.id, source: "IMPORTED", sceneId: null } });
    expect(uploads).toHaveLength(3);
    expect(uploads.every((a) => a.actualCost === 0)).toBe(true);
    const spoken = scenes.map((s) => `${s.narration} ${s.dialogue}`).join(" ");
    expect(spoken).not.toMatch(/tôi đã dùng|mình đã dùng|I have used|I tested/i);
    expect(spoken).toMatch(/500ml/);
    expect(spoken).toMatch(/12 giờ/);
    expect(script.facts?.every((f) => f.origin !== "AI_GENERATED")).toBe(true);
    expect(script.needsFactReview).toBe(false);
    expect(await paidMedia()).toEqual(before);
  });

  it("chỉ sau DUYỆT KỊCH BẢN mới đi tiếp; chạy mock end-to-end; đổi kiểu phụ đề → 0 request trả phí", async () => {
    const { project } = await make({
      contentType: "PRODUCT_REVIEW",
      formatId: "quick",
      sourceType: "ASSETS",
      subjectName: "Đèn bàn LED",
      facts: [{ text: "Có 3 mức sáng" }],
      uploads: [{ bytes: png[0]!, filename: "den.png" }],
      durationSeconds: 15,
    });
    await expect(startMediaGeneration(project.id)).rejects.toThrow(/SCRIPT_NOT_APPROVED/);
    await approveContentScript(project.id);
    const started = await startMediaGeneration(project.id);
    expect(started.needsApproval).toBe(true);
    await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
    const done = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(done.status).toBe("completed");
    expect(fs.existsSync(toAbsolute(done.finalVideoPath!))).toBe(true);
    // The product photo was shown, never redrawn.
    const scenes = await prisma.scene.findMany({ where: { projectId: project.id } });
    const imported = scenes.filter((s) => s.imageSource === "IMPORTED").map((s) => s.id);
    expect(imported.length).toBeGreaterThan(0);
    expect(await prisma.providerJob.count({ where: { kind: "image", sceneId: { in: imported } } })).toBe(0);

    const before = await paidMedia();
    await setOutputProfile(project.id, { ...profileFromPlatform("TIKTOK"), subtitleBottomPct: 20 });
    const pre = await preflightImportedBatch(started.batchId!);
    expect(pre.counts.imagePosts + pre.counts.videoPosts + pre.counts.voicePosts).toBe(0);
    expect((await continueVideo(project.id, { wait: true })).status).toBe("COMPLETED");
    expect(await paidMedia()).toEqual(before);
    // A script already in production is not rewritten behind the person's back.
    await expect(generateContentProjectScript(project.id)).rejects.toMatchObject({ code: "MEDIA_STARTED" });
  });
});

describe("LANGUAGE · AUDIENCE · PLATFORM · MULTI-SPEAKER", () => {
  it("Tiếng Việt và English", async () => {
    const vi = await make({ contentType: "KNOWLEDGE", idea: "Vì sao lá cây màu xanh", language: "vi" });
    const en = await make({ contentType: "KNOWLEDGE", idea: "Why leaves are green", language: "en" });
    expect(vi.project.language).toBe("vi");
    expect(en.project.language).toBe("en");
    expect(detectLanguage(vi.scenes.map((s) => s.narration).join(" "))).toBe("vi");
    expect(detectLanguage(en.scenes.map((s) => s.narration).join(" "))).toBe("en");
  });

  it("trẻ em: ít cảnh hơn / cảnh dài hơn người lớn với cùng thời lượng", async () => {
    const kids = await make({ contentType: "KNOWLEDGE", idea: "Cầu vồng", audience: "KIDS", durationSeconds: 60 });
    const adults = await make({ contentType: "KNOWLEDGE", idea: "Cầu vồng", audience: "ADULTS", durationSeconds: 60 });
    expect(kids.scenes.length).toBeLessThan(adults.scenes.length);
    expect(kids.project.audience).toBe("KIDS");
  });

  it("9:16 và 16:9 theo nền tảng", async () => {
    const tall = await make({ contentType: "CUSTOM", idea: "Một ngày ở Đà Lạt", outputProfile: profileFromPlatform("TIKTOK") });
    const wide = await make({ contentType: "CUSTOM", idea: "Một ngày ở Đà Lạt", outputProfile: profileFromPlatform("YOUTUBE_LANDSCAPE") });
    expect(tall.project.aspectRatio).toBe("9:16");
    expect(wide.project.aspectRatio).toBe("16:9");
  });

  it("hội thoại nhiều nhân vật: câu có thứ tự, giọng đúng người nói, phụ đề cùng nguồn", async () => {
    const { scenes } = await make({ contentType: "ENGLISH_CONVERSATION", idea: "Ordering coffee", voiceMode: "DIALOGUE", language: "en", durationSeconds: 30 });
    const speakers = new Set<string>();
    for (const s of scenes) {
      const lines = spokenLines(s);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        speakers.add(l.speaker);
        expect(sceneCharacters(s).present).toContain(l.speaker);
      }
    }
    expect(speakers.size).toBeGreaterThanOrEqual(2);
    expect(speakers.has("Narrator")).toBe(false);
  });

  it("không lồng tiếng: không câu nào để mua giọng, phụ đề vẫn có", async () => {
    const { scenes } = await make({ contentType: "CUSTOM", idea: "Timelapse hoàng hôn", voiceMode: "NO_VOICE" });
    for (const s of scenes) {
      expect(spokenLines(s)).toEqual([]);
      expect(s.subtitle.length).toBeGreaterThan(0);
    }
  });
});

describe("LEGACY", () => {
  it("dự án thành ngữ cũ vẫn dùng bộ viết cũ, không có cột nội dung mới, không cần duyệt", async () => {
    const tag = randomUUID().slice(0, 6);
    const idiom = await prisma.idiom.create({
      data: { phrase: `Break a leg ${tag}`, slug: `bal-${tag}`, meaning: "good luck", literalMeaning: "leg", exampleSentence: "Break a leg tonight!", category: "test" },
    });
    expect(idiom.contentType).toBe("ENGLISH_IDIOM");
    const project = await createProjectForIdiom({ idiomId: idiom.id, qualityMode: "ECONOMY", autoGenerateScript: false });
    const script = await generateProjectScript(project.id);
    expect(script.idiom).toBe(idiom.phrase);
    expect(script.scenes.length).toBeGreaterThanOrEqual(5);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.contentType).toBeNull();
    expect(after.title).toBe(script.title);
    // Media is not held behind DUYỆT KỊCH BẢN for a legacy project.
    const started = await startMediaGeneration(project.id);
    expect(started.errors.join(" ")).not.toMatch(/SCRIPT_NOT_APPROVED/);
    await expect(generateContentProjectScript(project.id)).rejects.toMatchObject({ code: "LEGACY_PROJECT" });
  });
});
