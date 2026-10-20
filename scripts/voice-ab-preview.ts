/**
 * QĐ-142 VOICE A/B - PREFLIGHT ONLY. Prints the TTS requests for the same
 * Vietnamese script, A (voice before QĐ-142) and B (Voice Director), and what a
 * real listening test would cost. Makes NO network call and writes nothing.
 *
 *   npx tsx scripts/voice-ab-preview.ts [PRESET_ID]   (vd FEMALE_NATURAL = marin, MALE_WARM = cedar)
 */
import { prisma } from "../src/lib/prisma";
import { AB_SAMPLE_SCRIPT, buildVoiceAB } from "../src/domain/voice-ab";

async function main() {
  const model = await prisma.modelRegistry.findUnique({ where: { provider_modelId: { provider: "openai", modelId: "gpt-4o-mini-tts" } } });
  const narrator = await prisma.character.findUnique({ where: { name: "Narrator" } });
  const legacyVoiceId = narrator?.voiceId ?? "coral";
  const rows = buildVoiceAB({
    legacyVoiceId,
    style: { preset: "TIKTOK_FUNNY", tone: "FUN", comedyLevel: 4, emotionStyle: "SURPRISE", pacingStyle: "FAST", punchlineMode: "REQUIRED" },
    contentType: "KNOWLEDGE",
    presetId: process.argv[2],
  });

  for (const [i, r] of rows.entries()) {
    console.log(`\n=== Cảnh ${i + 1} (${r.role}) ===`);
    console.log(`A  voice=${r.A.voiceId} speed=${r.A.speed}\n   text: ${r.A.text}\n   instructions: ${r.A.instructions}`);
    console.log(`B  voice=${r.B.voiceId} speed=${r.B.speed}\n   text: ${r.B.text}\n   instructions:\n     ${r.B.instructions.split("\n").join("\n     ")}`);
    for (const w of r.warnings) console.log(`   ! ${w}`);
  }

  const chars = rows.reduce((n, r) => n + r.A.text.length + r.B.text.length, 0);
  const price = model?.price ?? 0;
  console.log("\n=== PREFLIGHT (KHÔNG GỌI API) ===");
  console.log(`Model: openai/gpt-4o-mini-tts · giá registry $${price}/1k ký tự · enabled=${model?.enabled ?? false}`);
  console.log(`TTS POST nếu chạy thật: ${rows.length * 2} (${AB_SAMPLE_SCRIPT.length} câu × A/B) · ${chars} ký tự`);
  console.log(`Chi phí ước tính: $${((chars / 1000) * price).toFixed(6)} (ước tính, CHƯA chi)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
