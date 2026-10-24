import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-158 UI check seed - ONLY for an isolated DB + DATA_DIR (refuses data/app.db).
 * Mock Mode is forced on: nothing here can reach a paid API. Voices are made by
 * the Mind Voice running on this machine ($0).
 *
 *   Characters  Chị Hoa (người bán, vi-VN, Thục Đoan)
 *               John    (khách Mỹ, en-US, Supertonic M2 - giọng vùng chưa xác minh)
 *               Emma    (khách Anh, en-GB, Supertonic F1 - giọng vùng chưa xác minh)
 *               Dẫn Chuyện (người dẫn chuyện, vi-VN, Quang Sơn)
 *               Narrator kept as the real one is: mindvoice + "sage" (shows the warning)
 *   Project     "QĐ-158 NGHIỆM THU · Cửa hàng gốm" - 3 scenes, voiced and rendered
 *
 *   DATA_DIR=<isolated dir> DATABASE_URL=file:<db> npx tsx scripts/qa/qd158-ui-seed.ts
 *   (before: `npx prisma migrate deploy` and `npx tsx scripts/seed.ts` on that DB;
 *    Mind Voice running at 127.0.0.1:8011)
 */

const SCENES: { color: string; lines: [string, string][] }[] = [
  {
    color: "0x8a5a3c",
    lines: [["Dẫn Chuyện", "Sáng nay, cửa hàng gốm nhỏ đón hai vị khách nước ngoài."]],
  },
  {
    color: "0x3c6e8a",
    lines: [
      ["John", "Hi! How much is this blue vase?"],
      ["Chị Hoa", "Dạ, chiếc bình này giá năm trăm nghìn ạ."],
      ["John", "That's a great price. I'll take it!"],
    ],
  },
  {
    color: "0x5a8a3c",
    lines: [
      ["Emma", "Good morning! Could you wrap it as a gift, please?"],
      ["Chị Hoa", "Dạ được ạ, em gói ngay cho chị."],
      ["Dẫn Chuyện", "Và thế là hai vị khách ra về với món quà ưng ý."],
    ],
  },
];

const CAST = [
  { name: "Chị Hoa", description: "Người bán hàng Việt Nam (QA QĐ-158)", locale: "vi-VN", voiceId: "Thục Đoan" },
  { name: "John", description: "Khách hàng người Mỹ (QA QĐ-158)", locale: "en-US", voiceId: "M2" },
  { name: "Emma", description: "Khách hàng người Anh (QA QĐ-158)", locale: "en-GB", voiceId: "F1" },
  { name: "Dẫn Chuyện", description: "Người dẫn chuyện tiếng Việt (QA QĐ-158)", locale: "vi-VN", voiceId: "Quang Sơn" },
] as const;

async function main(): Promise<void> {
  if (!process.env.DATA_DIR || !process.env.DATABASE_URL || /data[\\/]app\.db/.test(process.env.DATABASE_URL)) {
    throw new Error("Chỉ chạy với DATA_DIR và DATABASE_URL riêng cho kiểm thử.");
  }
  process.env.AI_MOCK_MODE = "true";
  process.env.JOB_WORKER_ENABLED = "false";
  const { prisma } = await import("../../src/lib/prisma");
  const { ffmpeg } = await import("../../src/media/ffmpeg");
  const { ensureMindRegistry, refreshMindCatalog } = await import("../../src/services/mind-voice-catalog");
  const { voiceCatalogFor, checkVoiceChoice } = await import("../../src/services/voice-catalog");
  const { withProfile } = await import("../../src/domain/voice-locale");
  const { ensureNarrator } = await import("../../src/services/content-service");
  const { materialiseImport, scanImportSource, validateImport } = await import("../../src/services/storyboard-import");
  const { approveAndRun } = await import("../../src/services/batch-executor");

  await ensureMindRegistry();
  const mind = await refreshMindCatalog();
  if (!mind.online) throw new Error(`Mind Voice chưa chạy: ${mind.error}`);

  await ensureNarrator();
  // The real Narrator's state (2026-10-24): Mind Voice with an OpenAI voice name.
  await prisma.character.update({ where: { name: "Narrator" }, data: { voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "sage", voiceGender: "female", voiceAccent: "US" } });

  for (const c of CAST) {
    const row = await prisma.character.upsert({
      where: { name: c.name },
      create: {
        name: c.name,
        description: c.description,
        personality: "",
        visualPrompt: `${c.description}, photo-realistic person in a small pottery shop.`,
        hair: "short dark hair",
        outfit: "plain casual clothes",
        facialFeatures: "friendly face",
        enabled: true,
      },
      update: {},
    });
    const check = checkVoiceChoice(await voiceCatalogFor(c.locale), "mindvoice", "mind-local", c.voiceId);
    if (!check.ok) throw new Error(`${c.name}: ${check.message}`);
    await prisma.character.update({
      where: { id: row.id },
      data: withProfile(row, c.locale, { provider: "mindvoice", model: "mind-local", voiceId: c.voiceId, speed: 1, instructions: "", gender: check.voice.gender ?? "male" }, true),
    });
  }

  const root = path.join(process.env.DATA_DIR, "qd158-storyboard");
  const dir = path.join(root, "v");
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, s] of SCENES.entries()) {
    await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${s.color}:s=1080x1920`, "-frames:v", "1", path.join(dir, `s${i + 1}.png`)]);
  }
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({
      video_id: "qd158-shop",
      video_title: "QĐ-158 NGHIỆM THU · Cửa hàng gốm",
      characters: [{ character_id: "max", character_name: "Max" }],
      scenes: SCENES.map((s, i) => ({
        scene_number: i + 1,
        duration: 3 + s.lines.length * 3,
        visual_description: "A small pottery shop.",
        character_action: "Talks.",
        camera: "Static medium shot.",
        dialogue: 'Max: "x"',
        subtitle: "",
        image_file: `s${i + 1}.png`,
        motion_mode: "LOCAL_MOTION",
        priority: "NORMAL",
        characters_present: ["Max"],
        speaking_characters: ["Max"],
      })),
    }),
  );
  const validated = await validateImport(scanImportSource(root));
  const errors = validated.issues.filter((i) => i.level === "error");
  if (errors.length) throw new Error(JSON.stringify(errors));
  const made = await materialiseImport(validated, { batchName: "QĐ-158 NGHIỆM THU", maxCostPerVideo: 0.1, maxCostForBatch: 0.1 });
  const projectId = made.projects[0]!.projectId;
  await prisma.project.update({ where: { id: projectId }, data: { language: "vi" } });
  const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
  for (const [i, s] of scenes.entries()) {
    const lines = SCENES[i]!.lines;
    const speaking = [...new Set(lines.map(([who]) => who))];
    await prisma.scene.update({
      where: { id: s.id },
      data: {
        dialogue: lines.map(([who, text]) => `${who}: ${text}`).join("\n"),
        narration: "",
        subtitle: lines.map(([, text]) => text).join(" "),
        speakingCharactersJson: JSON.stringify(speaking),
        charactersPresentJson: JSON.stringify(speaking.filter((n) => n !== "Dẫn Chuyện")),
      },
    });
  }
  await approveAndRun({ batchId: made.batchId, maxBatch: 0.1, lowAutoApproved: true, wait: true });
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const lines = await prisma.dialogueLine.findMany({
    where: { scene: { projectId } },
    include: { scene: { select: { sceneNumber: true } }, character: { select: { name: true } } },
    orderBy: [{ scene: { sceneNumber: "asc" } }, { lineNumber: "asc" }],
  });
  const jobs = await prisma.providerJob.findMany({ where: { kind: "audio", sceneId: { in: scenes.map((s) => s.id) } }, orderBy: { createdAt: "asc" } });
  console.log(
    JSON.stringify(
      {
        projectId,
        batchId: made.batchId,
        status: project.status,
        finalVideoPath: project.finalVideoPath,
        lines: lines.map((l) => ({ scene: l.scene.sceneNumber, line: l.lineNumber, character: l.character?.name ?? null, provider: l.provider, voiceId: l.voiceId, text: l.text, durationSec: l.durationSec })),
        requests: jobs.map((j) => ({ provider: j.provider, model: j.model, sent: j.requestJson })),
        costEntries: await prisma.costEntry.count({ where: { amount: { gt: 0 }, provider: { not: "mock" } } }),
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
