import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { profileFromPlatform } from "@/domain/platform-profile";
import { controlsOf } from "@/domain/output-controls";
import { isNarrator, sceneCharacters } from "@/domain/scene-characters";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import { prepareSpeechText, speechLanguageOf } from "@/domain/speech-text";
import {
  autoPresetFor,
  directVoice,
  NATURAL_MAX_SPEED,
  sceneVoiceRole,
  VOICE_CATALOG,
  VOICE_PRESETS,
  voiceStyleFor,
  type DirectInput,
} from "@/domain/voice-director";
import { AB_SAMPLE_SCRIPT, buildVoiceAB, LEGACY_NARRATOR_INSTRUCTIONS } from "@/domain/voice-ab";
import { voiceReuseKey } from "@/services/asset-keys";
import { approveContentScript, createContentProject } from "@/services/content-service";
import { startMediaGeneration } from "@/services/project-service";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { saveProjectControls } from "@/services/output-controls";
import { makeSceneVoice, sceneVoiceStatus } from "@/services/scene-voice";
import { voiceSettingsFor } from "@/services/generation";
import { voiceDirectorFor } from "@/services/voice-direction";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { seedMock } from "./phase5-helpers";

/**
 * QĐ-142 VOICE DIRECTOR: one narrator identity per video, a different reading
 * per scene and per style, natural text, and not one extra TTS request when
 * only a subtitle, the camera or a render changes. Mock, $0.
 */

const STYLES = {
  PROFESSIONAL: { preset: "PROFESSIONAL", tone: "PROFESSIONAL", comedyLevel: 0, emotionStyle: "TRUST", pacingStyle: "MEDIUM", punchlineMode: "NONE" },
  TIKTOK: { preset: "TIKTOK_FUNNY", tone: "FUN", comedyLevel: 4, emotionStyle: "SURPRISE", pacingStyle: "FAST", punchlineMode: "REQUIRED" },
  REVIEW: { preset: "AUTO", tone: "FRIENDLY", comedyLevel: 1, emotionStyle: "TRUST", pacingStyle: "MEDIUM", punchlineMode: "AUTO" },
  STORY: { preset: "AUTO", tone: "WARM", comedyLevel: 1, emotionStyle: "WARM", pacingStyle: "MEDIUM", punchlineMode: "AUTO" },
  DOCUMENTARY: { preset: "DOCUMENTARY", tone: "DOCUMENTARY", comedyLevel: 0, emotionStyle: "CURIOUS", pacingStyle: "MEDIUM", punchlineMode: "NONE" },
} as const;

const TYPE: Record<keyof typeof STYLES, string> = {
  PROFESSIONAL: "KNOWLEDGE",
  TIKTOK: "CUSTOM",
  REVIEW: "PRODUCT_REVIEW",
  STORY: "STORY",
  DOCUMENTARY: "ANIMAL_FACT",
};

function input(styleKey: keyof typeof STYLES, over: Partial<DirectInput> = {}): DirectInput {
  const style = STYLES[styleKey];
  const preset = autoPresetFor(voiceStyleFor(style, TYPE[styleKey]), "female");
  return {
    identity: { voiceId: preset.voiceId, base: preset.base, speed: null, presetSpeed: preset.defaultSpeed, presetLabel: preset.label },
    style,
    contentType: TYPE[styleKey],
    sceneRole: "explain",
    sceneIndex: 1,
    sceneCount: 5,
    sceneDuration: 6,
    sceneSpeechChars: 60,
    language: "vi",
    emotion: "AUTO",
    speedMode: "AUTO",
    custom: null,
    narrator: true,
    charsPerSecond: 15,
    ...over,
  };
}

describe("VOICE CATALOG + PRESETS (pure)", () => {
  it("13 giọng OpenAI, có marin và cedar; 12 preset (6 nam, 6 nữ), mỗi preset map tới giọng có thật", () => {
    expect(VOICE_CATALOG.map((v) => v.id).sort()).toEqual(
      ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"].sort(),
    );
    expect(VOICE_PRESETS).toHaveLength(12);
    expect(VOICE_PRESETS.filter((p) => p.group === "NAM")).toHaveLength(6);
    expect(VOICE_PRESETS.filter((p) => p.group === "NỮ")).toHaveLength(6);
    for (const p of VOICE_PRESETS) {
      expect(VOICE_CATALOG.some((v) => v.id === p.voiceId)).toBe(true);
      expect(p.defaultSpeed).toBeGreaterThanOrEqual(0.9);
      expect(p.defaultSpeed).toBeLessThanOrEqual(1.1);
      expect(p.base.length).toBeGreaterThan(20);
    }
    expect(VOICE_PRESETS.some((p) => p.voiceId === "marin")).toBe(true);
    expect(VOICE_PRESETS.some((p) => p.voiceId === "cedar")).toBe(true);
  });
});

describe("VOICE DIRECTOR theo phong cách (pure)", () => {
  it("Professional / TikTok Comedy / Product Review / Storytelling / Documentary: mỗi kiểu đọc khác nhau", () => {
    const out = Object.fromEntries((Object.keys(STYLES) as (keyof typeof STYLES)[]).map((k) => [k, directVoice(input(k))]));
    expect(out.PROFESSIONAL!.styleId).toBe("PROFESSIONAL");
    expect(out.TIKTOK!.styleId).toBe("COMEDY");
    expect(out.REVIEW!.styleId).toBe("PRODUCT_REVIEW");
    expect(out.STORY!.styleId).toBe("STORYTELLING");
    expect(out.DOCUMENTARY!.styleId).toBe("DOCUMENTARY");
    expect(new Set(Object.values(out).map((d) => d.instructions)).size).toBe(5);

    expect(out.TIKTOK!.instructions).toMatch(/comic timing/i);
    expect(out.TIKTOK!.instructions).toMatch(/never shouting/i);
    expect(out.REVIEW!.instructions).toMatch(/Never a hard-sell TV advert/);
    expect(out.DOCUMENTARY!.instructions).toMatch(/lean on the key words/);
    expect(out.PROFESSIONAL!.instructions).toMatch(/little exaggeration/);
    // Comedy reads quicker than documentary; nothing past the natural limit.
    expect(out.TIKTOK!.speed).toBeGreaterThan(out.DOCUMENTARY!.speed);
    for (const d of Object.values(out)) expect(d.speed).toBeLessThanOrEqual(NATURAL_MAX_SPEED);
  });

  it("tiếng Việt và tiếng Anh: chỉ dẫn ngôn ngữ đúng, tên tiếng Anh đọc kiểu tiếng Anh", () => {
    const vi = directVoice(input("PROFESSIONAL"));
    const en = directVoice(input("PROFESSIONAL", { language: "en" }));
    expect(vi.instructions).toMatch(/Vietnamese with correct tones/);
    expect(vi.instructions).toMatch(/English words, brand and model names/);
    expect(en.instructions).toMatch(/fluent English/);
    expect(en.instructions).not.toMatch(/Vietnamese/);
    expect(speechLanguageOf("vi-en", "Hôm nay học từ mới")).toBe("vi");
    expect(speechLanguageOf("vi-en", "Break a leg")).toBe("en");
  });

  it("đổi cảm xúc cảnh: danh tính giọng giữ nguyên, chỉ phần cảm xúc / tốc độ đổi", () => {
    const normal = directVoice(input("STORY", { emotion: "NEUTRAL" }));
    const touching = directVoice(input("STORY", { emotion: "TOUCHING" }));
    expect(touching.instructions).not.toBe(normal.instructions);
    expect(touching.instructions.split("\n")[0]).toBe(normal.instructions.split("\n")[0]);
    expect(touching.speed).toBeLessThan(normal.speed);
  });

  it("cùng người dẫn: mọi cảnh cùng giọng + cùng dòng danh tính; hook / punchline / CTA đọc khác nhau", () => {
    const roles = ["hook", "explain", "punchline", "cta"];
    const all = roles.map((r, i) => directVoice(input("TIKTOK", { sceneRole: r, sceneIndex: i, sceneCount: roles.length })));
    expect(new Set(all.map((d) => d.instructions.split("\n")[0])).size).toBe(1);
    expect(new Set(all.map((d) => d.instructions)).size).toBe(roles.length);
    expect(all.map((d) => d.role)).toEqual(["HOOK", "EXPLAIN", "PUNCHLINE", "CTA"]);
    expect(all[2]!.instructions).toMatch(/short natural pause just before the final phrase/);
    expect(sceneVoiceRole(null, 0, 4)).toBe("HOOK");
    expect(sceneVoiceRole(null, 3, 4)).toBe("CLOSING");
  });

  it("tốc độ: Chậm < Vừa < Nhanh; tốc độ chính xác thắng; lời quá dài → cảnh báo, không ép quá 1.15x", () => {
    const at = (speedMode: DirectInput["speedMode"]) => directVoice(input("PROFESSIONAL", { speedMode })).speed;
    expect(at("SLOW")).toBeLessThan(at("MEDIUM"));
    expect(at("MEDIUM")).toBeLessThan(at("FAST"));
    const exact = input("PROFESSIONAL");
    expect(directVoice({ ...exact, identity: { ...exact.identity, speed: 1.3 } }).speed).toBe(1.3);

    const long = directVoice(input("PROFESSIONAL", { sceneSpeechChars: 400, sceneDuration: 6 }));
    expect(long.speed).toBeLessThanOrEqual(NATURAL_MAX_SPEED);
    expect(long.warnings[0]).toMatch(/^NARRATION_TOO_LONG/);
    // A little too long: AUTO speeds up a touch instead of warning.
    const snug = directVoice(input("PROFESSIONAL", { sceneSpeechChars: 98, sceneDuration: 6 }));
    expect(snug.speed).toBeGreaterThan(1);
    expect(snug.warnings).toEqual([]);
  });
});

describe("NATURAL SPEECH PREPROCESSING (pure)", () => {
  it("đơn vị, %, tiền, viết tắt, emoji, hashtag: đọc được thành lời; số và tên model giữ nguyên", () => {
    expect(prepareSpeechText("Pin 5000mAh, nặng 1,2kg, giảm 30% 🔥 #review", "vi")).toBe("Pin 5000mAh, nặng 1,2 ki-lô-gam, giảm 30 phần trăm review");
    expect(prepareSpeechText("Đi 10km/h, VD: iPhone 15 Pro vs Galaxy S24 v.v.", "vi")).toBe(
      "Đi 10 ki-lô-mét một giờ, Ví dụ: iPhone 15 Pro so với Galaxy S24 vân vân",
    );
    expect(prepareSpeechText("It costs $20, e.g. a 50% discount!!!", "en")).toBe("It costs 20 dollars, for example a 50 percent discount!");
  });

  it("dấu câu: một '...' mỗi câu, không '!!!', có khoảng trắng sau dấu, gạch ngang thành dấu phẩy", () => {
    expect(prepareSpeechText("Chờ đã... rồi... bùm!!", "vi")).toBe("Chờ đã... rồi, bùm!");
    expect(prepareSpeechText("Xin chào ,bạn khỏe không ??", "vi")).toBe("Xin chào, bạn khỏe không?");
    expect(prepareSpeechText("Mẹo 1 - uống nước", "vi")).toBe("Mẹo 1, uống nước");
    // Never adds an ellipsis or changes words.
    expect(prepareSpeechText("Hôm nay trời đẹp. Mình đi dạo.", "vi")).toBe("Hôm nay trời đẹp. Mình đi dạo.");
  });

  it("khoá giọng: lời đã chuẩn hoá nằm trong khoá; không có thì khoá cũ y nguyên", () => {
    const base = { provider: "openai", model: "gpt-4o-mini-tts", text: "Giảm 30%", voiceId: "marin", instructions: "x", speed: 1 };
    expect(voiceReuseKey({ ...base, spokenText: undefined })).toBe(voiceReuseKey(base));
    expect(voiceReuseKey({ ...base, spokenText: "Giảm 30 phần trăm" })).not.toBe(voiceReuseKey(base));
    for (const changed of [{ voiceId: "cedar" }, { instructions: "y" }, { speed: 1.05 }, { model: "tts-1" }]) {
      expect(voiceReuseKey({ ...base, ...changed })).not.toBe(voiceReuseKey(base));
    }
  });
});

describe("A/B cùng một kịch bản tiếng Việt (pure, 0 request)", () => {
  it("A: một chỉ dẫn, tốc độ 1 cho mọi cảnh; B: cùng giọng, mỗi cảnh một cách đọc, lời đã chuẩn hoá", () => {
    const ab = buildVoiceAB({ legacyVoiceId: "coral", style: STYLES.TIKTOK, contentType: "KNOWLEDGE" });
    expect(ab).toHaveLength(AB_SAMPLE_SCRIPT.length);
    expect(new Set(ab.map((r) => r.A.instructions))).toEqual(new Set([LEGACY_NARRATOR_INSTRUCTIONS]));
    expect(ab.every((r) => r.A.speed === 1 && r.A.voiceId === "coral")).toBe(true);
    expect(new Set(ab.map((r) => r.B.voiceId)).size).toBe(1);
    expect(new Set(ab.map((r) => r.B.instructions)).size).toBeGreaterThan(2);
    expect(ab.every((r) => r.B.instructions !== r.A.instructions)).toBe(true);
    expect(ab[1]!.B.text).toBe("Mẹo 1, uống một ly nước ngay khi thức dậy, khoảng 250ml.");
    expect(ab[2]!.B.text).toBe("Mẹo 2: đừng đợi khát mới uống... lúc đó cơ thể đã thiếu nước rồi!");
    expect(ab.every((r) => r.B.speed <= NATURAL_MAX_SPEED)).toBe(true);
  });
});

describe("VOICE DIRECTOR trong pipeline (DB, mock, $0)", () => {
  let projectId = "";
  let capBefore = 0;
  const ttsPosts = () => prisma.providerJob.count({ where: { projectId, kind: "audio" } });
  const voiceLedger = () => prisma.costEntry.count({ where: { category: "voice" } });
  const narratedScenes = async () =>
    (await prisma.scene.findMany({ where: { projectId, skipped: false }, orderBy: { sceneNumber: "asc" } })).filter(
      (s) => sceneCharacters(s).speaking.some(isNarrator) && s.narration.trim(),
    );
  const postsPerScene = async () => {
    const out: number[] = [];
    for (const s of await narratedScenes()) out.push((await sceneVoiceStatus(s.id)).expectedPosts);
    return out;
  };
  let previewPosts = 0;

  beforeAll(async () => {
    await seedMock();
    const s = await spendStatus();
    capBefore = s.cap;
    await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
    const p = await createContentProject({
      contentType: "KNOWLEDGE",
      sourceType: "PROMPT",
      idea: "3 mẹo uống nước đúng cách mỗi ngày",
      durationSeconds: 15,
      language: "vi",
      creativeStyle: { preset: "TIKTOK_FUNNY" },
      outputProfile: profileFromPlatform("TIKTOK"),
    });
    projectId = p.id;
    await approveContentScript(projectId);
    // ▶ NGHE THỬ the first narrated scene BEFORE the run.
    const first = (await narratedScenes())[0]!;
    const ask = await makeSceneVoice(first.id);
    expect(ask.status).toBe("NEEDS_CONFIRMATION");
    const made = await makeSceneVoice(first.id, { confirmPaid: true, expectedCost: ask.plan!.incrementalCost });
    expect(made.status).toBe("DONE");
    previewPosts = await ttsPosts();
    const started = await startMediaGeneration(projectId);
    await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
  }, 900_000);

  afterAll(async () => {
    if (capBefore > 0) await setSpendCap(capBefore);
  });

  it("dự án mới bật Voice Director; mọi câu dẫn cùng một giọng, mỗi cảnh một chỉ dẫn riêng", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("completed");
    expect(controlsOf(project).voice.director).toBe(true);
    const rows = await prisma.dialogueLine.findMany({ where: { scene: { projectId } }, include: { character: true } });
    const narrator = rows.filter((r) => r.character?.name === "Narrator" || isNarrator(r.character?.name ?? ""));
    expect(narrator.length).toBeGreaterThan(2);
    expect(new Set(narrator.map((r) => r.voiceId)).size).toBe(1);
    expect(new Set(narrator.map((r) => r.instructions.split("\n")[0])).size).toBe(1);
    expect(new Set(narrator.map((r) => r.instructions)).size).toBeGreaterThan(1);
    expect(narrator[0]!.instructions).toMatch(/Vietnamese/);
    expect(narrator[0]!.instructions).toMatch(/comic timing/i);
  });

  it("nghe thử → chạy: cảnh đã nghe thử không gọi TTS lại", async () => {
    const first = (await narratedScenes())[0]!;
    const jobs = await prisma.providerJob.count({ where: { sceneId: first.id, kind: "audio" } });
    expect(jobs).toBe(previewPosts);
    expect(await ttsPosts()).toBe((await prisma.dialogueLine.count({ where: { scene: { projectId } } })));
  });

  it("render lại + đổi phụ đề + đổi camera: 0 TTS POST", async () => {
    const before = await voiceLedger();
    const posts = await ttsPosts();
    await saveProjectControls(projectId, { subtitles: { size: "LARGE", position: "TOP" } });
    const scenes = await narratedScenes();
    await prisma.scene.update({ where: { id: scenes[1]!.id }, data: { camera: "slow push-in, low angle", subtitle: "Phụ đề mới hoàn toàn" } });
    expect(await postsPerScene()).toEqual(scenes.map(() => 0));
    expect((await continueVideo(projectId, { wait: true })).status).toBe("COMPLETED");
    expect(await ttsPosts()).toBe(posts);
    expect(await voiceLedger()).toBe(before);
  }, 300_000);

  it("đổi cảm xúc MỘT cảnh: chỉ cảnh đó cần giọng mới; trả lại như cũ → dùng lại, 0 POST", async () => {
    const scenes = await narratedScenes();
    const target = scenes[1]!;
    const { setSceneVoiceEmotionAction } = await import("@/app/actions/output-controls");
    await setSceneVoiceEmotionAction(target.id, "TOUCHING");
    const after = await postsPerScene();
    expect(after[1]).toBeGreaterThan(0);
    expect(after.filter((n, i) => i !== 1).every((n) => n === 0)).toBe(true);
    await setSceneVoiceEmotionAction(target.id, null);
    expect(await postsPerScene()).toEqual(scenes.map(() => 0));
  });

  it("đổi preset giọng: mọi câu dẫn cần giọng mới (đúng phạm vi); trả lại → 0 POST", async () => {
    await saveProjectControls(projectId, { voice: { preset: "MALE_DOCUMENTARY" } });
    expect((await postsPerScene()).every((n) => n > 0)).toBe(true);
    const r = await makeSceneVoice((await narratedScenes())[0]!.id);
    expect(r.status).toBe("NEEDS_CONFIRMATION");
    expect(r.postsMade).toBe(0);
    await saveProjectControls(projectId, { voice: { preset: "AUTO" } });
    expect((await postsPerScene()).every((n) => n === 0)).toBe(true);
  });

  it("tắt Voice Director = cách đọc cũ (khác khoá); bật lại → dùng lại giọng đã có", async () => {
    await saveProjectControls(projectId, { voice: { director: false } });
    const first = (await narratedScenes())[0]!;
    const line = parseDialogueLines(first.dialogue, first.narration, sceneCharacters(first).speaking)[0]!;
    const base = await voiceSettingsFor(line.speaker, projectId);
    const legacy = (await voiceDirectorFor(first))(line, base);
    expect(legacy).toEqual(base);
    expect(legacy.spokenText).toBeUndefined();
    expect((await postsPerScene()).every((n) => n > 0)).toBe(true);
    await saveProjectControls(projectId, { voice: { director: true } });
    expect((await postsPerScene()).every((n) => n === 0)).toBe(true);
  });

  it("hai người nói: mỗi nhân vật giữ giọng riêng ở mọi cảnh, có chỉ dẫn cảnh", async () => {
    const scenes = await narratedScenes();
    const twoA = scenes[1]!;
    const twoB = scenes[2]!;
    for (const s of [twoA, twoB]) {
      await prisma.scene.update({
        where: { id: s.id },
        data: {
          dialogue: `Max: Uống nước lúc nào cũng được mà!\nLeo: Không hẳn, uống từ từ mới tốt.`,
          narration: "",
          speakingCharactersJson: JSON.stringify(["Max", "Leo"]),
          charactersPresentJson: JSON.stringify(["Max", "Leo"]),
        },
      });
    }
    const voiceOf = async (sceneId: string) => {
      const s = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
      const direct = await voiceDirectorFor(s);
      const lines = parseDialogueLines(s.dialogue, s.narration, sceneCharacters(s).speaking);
      return Promise.all(lines.map(async (l) => ({ speaker: l.speaker, ...direct(l, await voiceSettingsFor(l.speaker, projectId)) })));
    };
    const a = await voiceOf(twoA.id);
    const b = await voiceOf(twoB.id);
    expect(a.map((l) => l.speaker)).toEqual(["Max", "Leo"]);
    const max = await prisma.character.findUniqueOrThrow({ where: { name: "Max" } });
    const leo = await prisma.character.findUniqueOrThrow({ where: { name: "Leo" } });
    expect(a[0]!.voiceId).toBe(max.voiceId);
    expect(a[1]!.voiceId).toBe(leo.voiceId);
    expect(a[0]!.voiceId).not.toBe(a[1]!.voiceId);
    expect(b.map((l) => l.voiceId)).toEqual(a.map((l) => l.voiceId));
    expect(a[0]!.instructions).toContain(max.voiceInstructions.split(".")[0]!);
    expect(a[0]!.instructions).toMatch(/Scene:/);
    // The plan prices exactly the two new lines of each changed scene.
    expect((await sceneVoiceStatus(twoA.id)).expectedPosts).toBe(2);
  });
});
