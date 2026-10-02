import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import { renderProject } from "@/media/render";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import { sceneSubtitleText, splitByText, usesAuthorSubtitle } from "@/domain/scene-subtitles";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { generateSceneVoice } from "@/services/generation";
import { captionsFromSrt } from "@/services/output-export";

/**
 * Multi-speaker dialogue: parser -> per-line voice -> subtitles -> render
 * (QĐ-122). Mock providers and local FFmpeg only: $0, no paid POST.
 */

let tmp = "";
let capBefore = 0;
let seq = 0;
const tag = randomUUID().slice(0, 6);

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
      update: { enabled: true, reliability: "OK", price: model.price },
    });
  }
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({ where: { slug: preset.slug }, create: { ...preset, aspectRatio: "9:16" }, update: {} });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({ where: { name: character.name }, create: { ...character, voiceProvider: "mock", enabled: true }, update: {} });
  }
}

const cols = (speaking: string[]) => ({
  charactersPresentJson: JSON.stringify(speaking),
  speakingCharactersJson: JSON.stringify(speaking),
  primaryCharactersJson: JSON.stringify(speaking.slice(-1)),
});

/** One storyboard video; each scene: dialogue + the author's subtitle field as the script wrote it. */
async function importVideo(scenes: { dialogue: string; subtitle: string; cast: string[] }[]): Promise<{ batchId: string; projectId: string }> {
  seq += 1;
  const dir = path.join(tmp, `sb-${seq}`, "v");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "k.png");
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=1080x1920", "-frames:v", "1", file]);
  const rows = scenes.map((s, i) => ({
    scene_number: i + 1,
    duration: 3,
    visual_description: `Two friends talk, shot ${i + 1}.`,
    character_action: "They talk.",
    camera: "Static medium shot.",
    dialogue: s.dialogue,
    subtitle: s.subtitle,
    image_file: "k.png",
    motion_mode: "LOCAL_MOTION",
    priority: "NORMAL",
    characters_present: s.cast,
    speaking_characters: s.cast,
  }));
  const cast = [...new Set(scenes.flatMap((s) => s.cast))];
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({
      video_id: `ms-${tag}-${seq}`,
      video_title: `ms-${seq}`,
      characters: cast.map((c) => ({ character_id: c.toLowerCase(), character_name: c })),
      scenes: rows,
    }),
  );
  const validated = await validateImport(scanImportSource(path.join(tmp, `sb-${seq}`)));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, { batchName: `ms-${tag}-${seq}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
  return { batchId: created.batchId, projectId: created.projects[0]!.projectId };
}

const srtTexts = (projectId: string) =>
  prisma.project.findUniqueOrThrow({ where: { id: projectId } }).then((p) => captionsFromSrt(fs.readFileSync(toAbsolute(p.subtitlePath!), "utf8")).split(/\r?\n/));
const voicePurchases = () => prisma.costEntry.count({ where: { category: "voice" } });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multi-speaker-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
}, 120_000);

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-122 — parser: danh sách câu theo thứ tự (thuần)", () => {
  const p = (d: string, speaking: string[]) => parseDialogueLines(d, "", speaking).map(({ speaker, text }) => ({ speaker, text }));

  it("1 / 2 / 3 người, cùng dòng hoặc xuống dòng, có / không ngoặc kép, dấu câu, it's / don't", () => {
    expect(p(`Max: "So easy!"`, ["Max"])).toEqual([{ speaker: "Max", text: "So easy!" }]);
    expect(p(`Max: "So easy!" Leo: "No, Max, it's an idiom."`, ["Max", "Leo"])).toEqual([
      { speaker: "Max", text: "So easy!" },
      { speaker: "Leo", text: "No, Max, it's an idiom." },
    ]);
    expect(p(`Max: So easy!\nLeo: No, Max, it's an idiom.\nMia: Don't worry... it's fine?`, ["Max", "Leo", "Mia"])).toEqual([
      { speaker: "Max", text: "So easy!" },
      { speaker: "Leo", text: "No, Max, it's an idiom." },
      { speaker: "Mia", text: "Don't worry... it's fine?" },
    ]);
  });

  it("phụ đề lấy từ chính danh sách câu của giọng: đủ người, đúng thứ tự, không lấy người nói cuối / nhân vật trọng tâm", () => {
    const scene = { dialogue: `Max: "So easy!" Leo: "No, Max, it's an idiom."`, narration: "", subtitle: "Leo: No, Max, it's an idiom.", ...cols(["Max", "Leo"]) };
    expect(sceneSubtitleText(scene)).toBe("Max: So easy!\nLeo: No, Max, it's an idiom.");
    // One line: the author's readable subtitle still stands in.
    expect(sceneSubtitleText({ ...scene, dialogue: `Max: "So easy!"`, subtitle: "So easy!", ...cols(["Max"]) })).toBe("So easy!");
    expect(usesAuthorSubtitle(2, "Leo: x")).toBe(false);
    expect(usesAuthorSubtitle(1, "x")).toBe(true);
    const split = splitByText(["So easy!", "No, Max, it's an idiom."], 0, 3);
    expect(split.map((s) => s.text)).toEqual(["So easy!", "No, Max, it's an idiom."]);
    expect(split[0]!.startSec).toBe(0);
    expect(split[1]!.endSec).toBeCloseTo(3, 9);
  });
});

describe("QĐ-122 — giọng → phụ đề → render (mock, $0)", () => {
  it("Max + Leo: đủ 2 giọng đúng thứ tự và đúng giọng; phụ đề có cả 2 câu, câu đầu không mất; render lại / TIẾP TỤC không gọi TTS", async () => {
    const v = await importVideo([
      { dialogue: `Max: "So easy ${tag}!" Leo: "No, Max, it's an idiom ${tag}."`, subtitle: `Leo: No, Max, it's an idiom ${tag}.`, cast: ["Max", "Leo"] },
      { dialogue: `Max: "Break a leg ${tag}!"\nLeo: "What? Why?"\nMia: "It means good luck, it's fine."`, subtitle: "It means good luck.", cast: ["Max", "Leo", "Mia"] },
      { dialogue: `Max: "Only me ${tag}."`, subtitle: "Only me.", cast: ["Max"] },
    ]);
    await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
    expect(project.status).toBe("completed");

    // Voice: one file per line, in order, in each speaker's own voice.
    const scenes = await prisma.scene.findMany({ where: { projectId: v.projectId }, orderBy: { sceneNumber: "asc" }, include: { dialogueLines: { orderBy: { lineNumber: "asc" }, include: { character: true } } } });
    const chars = Object.fromEntries((await prisma.character.findMany()).map((c) => [c.name, c.voiceId]));
    expect(scenes[0]!.dialogueLines.map((l) => [l.character?.name, l.text])).toEqual([
      ["Max", `So easy ${tag}!`],
      ["Leo", `No, Max, it's an idiom ${tag}.`],
    ]);
    expect(scenes[1]!.dialogueLines.map((l) => l.character?.name)).toEqual(["Max", "Leo", "Mia"]);
    for (const s of scenes) for (const l of s.dialogueLines) {
      expect(l.voiceId).toBe(chars[l.character!.name]);
      expect(l.status).toBe("completed");
    }

    // Subtitles: every line, in order; the author's one-line field only for the one-line scene.
    const cues = await srtTexts(v.projectId);
    expect(cues).toEqual([
      `So easy ${tag}!`,
      `No, Max, it's an idiom ${tag}.`,
      `Break a leg ${tag}!`,
      "What? Why?",
      "It means good luck, it's fine.",
      "Only me.",
    ]);
    expect(cues).not.toContain(`Leo: No, Max, it's an idiom ${tag}.`);

    // Render again / TIẾP TỤC: no TTS.
    const before = await voicePurchases();
    fs.rmSync(toAbsolute(project.finalVideoPath!));
    expect((await continueVideo(v.projectId, { wait: true })).status).toBe("COMPLETED");
    for (const s of scenes) await generateSceneVoice(s.id);
    expect(await voicePurchases()).toBe(before);
    expect(await srtTexts(v.projectId)).toEqual(cues);

    // Edit ONE line: only that line's voice is re-made.
    await prisma.scene.update({ where: { id: scenes[0]!.id }, data: { dialogue: `Max: "So easy ${tag}!" Leo: "No, Max, it's just an idiom ${tag}."` } });
    await generateSceneVoice(scenes[0]!.id);
    await generateSceneVoice(scenes[1]!.id);
    expect((await voicePurchases()) - before).toBe(1);
  }, 600_000);

  it("cảnh nhiều người chưa có giọng (hoặc dự án kiểu cũ): phụ đề vẫn đủ từng câu theo thứ tự, không chỉ câu cuối", async () => {
    const image = path.join(tmp, "still.png");
    await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=1080x1920", "-frames:v", "1", image]);
    const result = await renderProject({
      projectId: `render-${tag}`,
      target: { width: 540, height: 960, fps: 24 },
      burnSubtitles: false,
      scenes: [
        { sceneNumber: 1, duration: 2, subtitle: "Leo: No, Max, it's an idiom.", videoPath: null, audioPath: null, imagePath: image, spokenLines: ["So easy!", "No, Max, it's an idiom."] },
        { sceneNumber: 2, duration: 1, subtitle: "Bye.", videoPath: null, audioPath: null, imagePath: image, spokenLines: ["Bye."] },
      ],
    });
    const cues = captionsFromSrt(fs.readFileSync(result.subtitlePathSrt, "utf8")).split(/\r?\n/);
    expect(cues).toEqual(["So easy!", "No, Max, it's an idiom.", "Bye."]);
  }, 300_000);
});
