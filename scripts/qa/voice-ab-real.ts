import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-142 REAL VOICE A/B - six Voice Director samples of ONE Vietnamese script,
 * so the voices can be compared fairly. TTS only: no image, no video, no render.
 *
 * Prints every request and the TOTAL ESTIMATE first, blocks on a hard limit,
 * goes through assertCanSpend and records each charge in the ledger.
 *
 *   npx tsx scripts/qa/voice-ab-real.ts              (dry-run, no API call)
 *   npx tsx scripts/qa/voice-ab-real.ts --real --limit 0.01
 */

const SCRIPT_TEXT =
  "Bạn có biết, chỉ cần uống một ly nước ngay sau khi thức dậy, cơ thể sẽ tỉnh táo hơn hẳn? " +
  "Thói quen nhỏ này không tốn tiền, cũng chẳng mất thêm thời gian. " +
  "Sáng mai thử ngay, rồi kể cho mình nghe cảm giác nhé!";

type Style = { preset: string; tone: string; comedyLevel: number; emotionStyle: string; pacingStyle: string; punchlineMode: string };

const SAMPLES: { key: string; slug: string; label: string; presetId: string; style: Style; contentType: string | null; emotion: string }[] = [
  { key: "VOICE_A", slug: "nam-am-ap", label: "Nam ấm áp", presetId: "MALE_WARM", contentType: null, emotion: "WARM",
    style: { preset: "NATURAL", tone: "NATURAL", comedyLevel: 1, emotionStyle: "WARM", pacingStyle: "MEDIUM", punchlineMode: "AUTO" } },
  { key: "VOICE_B", slug: "nam-review-cong-nghe", label: "Nam năng động / review công nghệ", presetId: "MALE_TECH", contentType: "PRODUCT_REVIEW", emotion: "EXCITED",
    style: { preset: "ENERGETIC", tone: "ENERGETIC", comedyLevel: 1, emotionStyle: "EXCITED", pacingStyle: "MEDIUM", punchlineMode: "AUTO" } },
  { key: "VOICE_C", slug: "nu-tu-nhien", label: "Nữ tự nhiên", presetId: "FEMALE_NATURAL", contentType: null, emotion: "WARM",
    style: { preset: "NATURAL", tone: "NATURAL", comedyLevel: 1, emotionStyle: "WARM", pacingStyle: "MEDIUM", punchlineMode: "AUTO" } },
  { key: "VOICE_D", slug: "nu-tre-trung", label: "Nữ trẻ trung", presetId: "FEMALE_YOUNG", contentType: null, emotion: "JOYFUL",
    style: { preset: "CUTE", tone: "PLAYFUL", comedyLevel: 2, emotionStyle: "WARM", pacingStyle: "MEDIUM", punchlineMode: "AUTO" } },
  { key: "VOICE_E", slug: "documentary", label: "Documentary", presetId: "MALE_DOCUMENTARY", contentType: null, emotion: "SERIOUS",
    style: { preset: "DOCUMENTARY", tone: "DOCUMENTARY", comedyLevel: 0, emotionStyle: "CURIOUS", pacingStyle: "MEDIUM", punchlineMode: "NONE" } },
  { key: "VOICE_F", slug: "tiktok-comedy", label: "TikTok Comedy", presetId: "MALE_FUNNY", contentType: null, emotion: "HUMOROUS",
    style: { preset: "TIKTOK_FUNNY", tone: "FUN", comedyLevel: 4, emotionStyle: "SURPRISE", pacingStyle: "FAST", punchlineMode: "REQUIRED" } },
];

const PROVIDER = "openai";
const MODEL = "gpt-4o-mini-tts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const real = process.argv.includes("--real");
  const limit = Number(arg("limit", "0.01"));

  process.env.AI_MOCK_MODE = real ? "false" : "true";
  const { resetEnvCache } = await import("../../src/lib/env");
  resetEnvCache();

  const { prisma } = await import("../../src/lib/prisma");
  const { directVoice, voicePresetOf, VOICE_STYLES } = await import("../../src/domain/voice-director");
  const { prepareSpeechText } = await import("../../src/domain/speech-text");
  const { parseDialogueLines } = await import("../../src/domain/dialogue-lines");
  const { getVoiceProvider } = await import("../../src/providers/registry");
  const { spendStatus, assertCanSpend } = await import("../../src/services/spend-guard");
  const { recordCost } = await import("../../src/services/cost-tracker");
  const { toAbsolute } = await import("../../src/lib/paths");
  const { probeDuration } = await import("../../src/media/ffmpeg");

  try {
    const model = await prisma.modelRegistry.findUnique({ where: { provider_modelId: { provider: PROVIDER, modelId: MODEL } } });
    if (!model) throw new Error(`${PROVIDER}/${MODEL} không có trong bảng Mô hình AI.`);
    // QĐ-143: the line goes through the SAME parser as the app, stored the way
    // the faulty project stored it ("Narrator: ..."), so the fix is what is heard.
    const parsed = parseDialogueLines("", `Narrator: ${SCRIPT_TEXT}`, ["Narrator"]);
    if (parsed.length !== 1 || parsed[0]!.speaker !== "Narrator") throw new Error("Parser không trả đúng một câu của Narrator.");
    const spoken = prepareSpeechText(parsed[0]!.text, "vi");
    const FORBIDDEN = ["Narrator:", "Speaker A:", "Speaker B:", "Host:", "Voice Over:", "VO:"];
    const leaked = FORBIDDEN.filter((f) => spoken.toLowerCase().includes(f.toLowerCase()));
    if (leaked.length > 0) throw new Error(`[DỪNG] spokenText còn nhãn người nói: ${leaked.join(", ")}. KHÔNG gọi API.`);
    if (spoken !== prepareSpeechText(SCRIPT_TEXT, "vi")) throw new Error("[DỪNG] spokenText khác đoạn gốc. KHÔNG gọi API.");

    const rows = SAMPLES.map((s) => {
      const preset = voicePresetOf(s.presetId)!;
      const d = directVoice({
        identity: { voiceId: preset.voiceId, base: preset.base, speed: null, presetSpeed: preset.defaultSpeed, presetLabel: preset.label },
        style: s.style as never,
        contentType: s.contentType,
        sceneRole: null,
        sceneIndex: 0,
        sceneCount: 1,
        sceneDuration: 0,
        sceneSpeechChars: spoken.length,
        language: "vi",
        emotion: s.emotion as never,
        speedMode: "AUTO",
        custom: null,
        narrator: true,
        charsPerSecond: 15,
      });
      const estimate = Math.round((spoken.length / 1000) * model.price * 1e6) / 1e6;
      return { ...s, preset, d, estimate };
    });

    const total = Math.round(rows.reduce((n, r) => n + r.estimate, 0) * 1e6) / 1e6;
    const before = await spendStatus();
    const confirmed = before.confirmedProviders.includes(`${PROVIDER}/${MODEL}`);

    console.log(`\n=== REAL VOICE A/B (QĐ-142) - ${real ? "THẬT" : "DRY-RUN"} ===`);
    console.log(`Đầu vào   : Narrator: ${SCRIPT_TEXT}`);
    console.log(`Kiểm tra  : spokenText KHÔNG chứa ${FORBIDDEN.join(" / ")} - OK`);
    console.log(`Lời đọc   : ${spoken}  (${spoken.length} ký tự, giống hệt cho cả 6 mẫu)`);
    for (const r of rows) {
      console.log(`\n--- ${r.key}: ${r.label} ---`);
      console.log(`provider=${PROVIDER} model=${MODEL} voice=${r.preset.voiceId} preset=${r.preset.id} (${r.preset.label})`);
      console.log(`style=${r.d.styleId} (${VOICE_STYLES[r.d.styleId].label}) emotion=${r.d.emotion} speed=${r.d.speed} role=${r.d.role}`);
      console.log(`instructions:\n  ${r.d.instructions.split("\n").join("\n  ")}`);
      console.log(`ước tính: $${r.estimate.toFixed(6)}`);
    }
    console.log(`\nTOTAL ESTIMATE: $${total.toFixed(6)}  (${rows.length} TTS POST × ${spoken.length} ký tự × $${model.price}/1k)`);
    console.log(`Hard limit    : $${limit.toFixed(2)} · sổ $${before.spent.toFixed(6)} / $${before.cap.toFixed(2)} · enabled=${model.enabled} · confirmed=${confirmed}`);

    if (total > limit) {
      console.log(`[DỪNG] Ước tính vượt hard limit. KHÔNG gọi API.`);
      process.exitCode = 1;
      return;
    }
    if (!real) {
      console.log("Dry-run: không gọi API.");
      return;
    }

    // --out <name> continues a run in its folder; --only C,D makes just those samples.
    const stamp = arg("out", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
    const only = arg("only", "").split(",").filter(Boolean).map((k) => `VOICE_${k.trim().toUpperCase()}`);
    const outDir = toAbsolute(path.join("voice-ab", stamp));
    fs.mkdirSync(outDir, { recursive: true });
    const provider = await getVoiceProvider(PROVIDER, MODEL);
    let spent = 0;
    let posts = 0;
    const manifest: string[] = [`Lời đọc (giống nhau cho mọi mẫu): ${spoken}`, ""];

    for (const r of rows.filter((x) => only.length === 0 || only.includes(x.key))) {
      const file = path.join(outDir, `${r.key}_${r.slug}_${r.preset.voiceId}.wav`);
      try {
        await assertCanSpend({ provider: PROVIDER, model: MODEL, estimatedCost: r.estimate });
        posts++;
        const job = await provider.createVoice({
          projectId: "voice-ab",
          sceneId: "voice-ab",
          model: MODEL,
          text: spoken,
          voiceId: r.preset.voiceId,
          instructions: r.d.instructions,
          accent: "US",
          gender: r.preset.group === "NỮ" ? "female" : "male",
          speed: r.d.speed,
          targetDuration: 10,
          outputPath: file,
        });
        const asset = await provider.downloadResult(job.externalId);
        await recordCost({ category: "voice", provider: PROVIDER, model: MODEL, amount: asset.actualCost, note: `voice-ab QĐ-142 ${r.key} ${r.preset.voiceId}` });
        spent += asset.actualCost;
        let seconds = 0;
        try {
          seconds = await probeDuration(asset.filePath);
        } catch {
          seconds = 0;
        }
        console.log(`${r.key}: OK ${path.basename(file)} · ${seconds.toFixed(2)} s · $${asset.actualCost.toFixed(6)}`);
        manifest.push(
          `${r.key} - ${r.label}`,
          `  file=${path.basename(file)} · ${seconds.toFixed(2)} s · $${asset.actualCost.toFixed(6)}`,
          `  provider=${PROVIDER} model=${MODEL} voice=${r.preset.voiceId} preset=${r.preset.id} emotion=${r.d.emotion} speed=${r.d.speed} style=${r.d.styleId}`,
          `  instructions: ${r.d.instructions.split("\n").join(" | ")}`,
          "",
        );
      } catch (err) {
        console.log(`${r.key}: THẤT BẠI - ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        break;
      }
    }

    fs.appendFileSync(path.join(outDir, "README.txt"), manifest.join("\n"), "utf8");
    const after = await spendStatus();
    console.log(`\nACTUAL_COST: $${spent.toFixed(6)} · PAID_API_POST: ${posts}`);
    console.log(`Sổ: $${before.spent.toFixed(6)} → $${after.spent.toFixed(6)} / $${after.cap.toFixed(2)}`);
    console.log(`Thư mục: ${outDir}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
