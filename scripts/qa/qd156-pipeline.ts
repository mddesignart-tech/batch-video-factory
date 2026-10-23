import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-156 integration: the app's own voice path, on the running Mind Voice -
 * prepareSpeechText -> MindVoiceProvider.createVoice (HTTP, 1.05x stretch) ->
 * normalizeVoiceClip. Writes only into data/qa/qd156/pipeline. No database,
 * no project, $0.
 *
 *   npx tsx scripts/qa/qd156-pipeline.ts
 */
const CASES: { id: string; text: string; runs: number }[] = [
  { id: "D1", text: "Những lớp vật liệu tạo thành một chiếc bát nhỏ ấm áp.", runs: 4 },
  { id: "D2", text: "Những lớp vật liệu tạo thành một chiếc bát nhỏ\nấm áp.", runs: 2 },
  { id: "D2b", text: "Những lớp vật liệu tạo thành một\nchiếc bát nhỏ ấm áp.", runs: 2 },
  { id: "D5", text: "Chú chim nhỏ bắt đầu tìm vật liệu.\n\nNó nhặt những cành cây khô.\n\nSau đó, nó dùng các sợi cỏ mềm để tạo thành một chiếc tổ ấm áp.", runs: 1 },
];

async function main(): Promise<void> {
  const { prepareSpeechText } = await import("../../src/domain/speech-text");
  const { MindVoiceProvider } = await import("../../src/providers/mindvoice/mind-voice-provider");
  const { normalizeVoiceClip } = await import("../../src/media/audio-normalize");
  const { ffmpeg } = await import("../../src/media/ffmpeg");
  const out = path.resolve("data/qa/qd156/pipeline");
  fs.mkdirSync(out, { recursive: true });
  const provider = new MindVoiceProvider({ baseUrl: "http://127.0.0.1:8011" });
  const rows = [];
  for (const c of CASES) {
    for (let run = 1; run <= c.runs; run++) {
      const text = prepareSpeechText(c.text, "vi");
      const raw = path.join(out, `${c.id}_r${run}_raw.wav`);
      const fin = path.join(out, `${c.id}_r${run}.wav`);
      for (const f of [raw, fin]) fs.rmSync(f, { force: true });
      await provider.createVoice({ projectId: "qa-qd156", sceneId: "qa", model: "mind-local", text, voiceId: "Thục Đoan", accent: "US", gender: "female", speed: 1.05, targetDuration: 0, outputPath: raw, language: "vi" });
      await normalizeVoiceClip(raw, fin);
      // Pauses inside the speech, measured on the finished file.
      const { stderr: err } = await ffmpeg(["-hide_banner", "-i", fin, "-af", "silencedetect=n=-40dB:d=0.12", "-f", "null", "-"], { keepAllOutput: true });
      const ends = [...err.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map((m) => ({ end: Number(m[1]), ms: Math.round(Number(m[2]) * 1000) }));
      rows.push({ id: c.id, run, sentToEngine: text, pauses: ends, maxMs: Math.max(0, ...ends.map((e) => e.ms)) });
      console.log(JSON.stringify(rows.at(-1)));
    }
  }
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(rows, null, 1));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
