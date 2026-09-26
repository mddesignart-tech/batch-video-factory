import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";
import { renderProject, DEFAULT_TARGET } from "@/media/render";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { setSpendCap } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun, renderProjectNow, resumeRun } from "@/services/batch-executor";
import { TimingBlockedError } from "@/domain/scene-timing";

/**
 * Voice-aware timing on REAL renders, $0 (mock voice, local FFmpeg).
 *
 * examples/storyboard-voice-timing: five scenes all PLANNED at 5s, voices of
 * ~1.9 / 3.5 / 2.3 / none / 3.9 seconds. Cases E-H, J, K, L of the spec, and the
 * figures of the QA report (planned vs final, longest silence, audio vs video
 * end), all measured on the MP4 with FFmpeg.
 */

const FIXTURE = path.join(process.cwd(), "examples", "storyboard-voice-timing");
let tmp = "";
let batchId = "";
let projectId = "";

async function ledger() {
  return {
    jobs: await prisma.providerJob.count({ where: { projectId } }),
    image: await prisma.providerJob.count({ where: { projectId, kind: "image" } }),
    video: await prisma.providerJob.count({ where: { projectId, kind: "video" } }),
    voice: await prisma.providerJob.count({ where: { projectId, kind: "audio" } }),
    costs: await prisma.costEntry.count({ where: { projectId } }),
    cost: (await prisma.costEntry.aggregate({ where: { projectId }, _sum: { amount: true } }))._sum.amount ?? 0,
    retries: (await prisma.scene.aggregate({ where: { projectId }, _sum: { retryCount: true } }))._sum.retryCount ?? 0,
    reserved: await prisma.costReservation.count({ where: { batchId, status: "RESERVED" } }),
  };
}

/** Silent stretches of the finished mix: [start, end] in seconds. */
async function silences(file: string, minSec = 0.3): Promise<[number, number][]> {
  const { stderr } = await ffmpeg(
    ["-hide_banner", "-i", file, "-af", `silencedetect=n=-40dB:d=${minSec}`, "-f", "null", "-"],
    { keepAllOutput: true },
  );
  const out: [number, number][] = [];
  let start: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start: ([\d.]+)/.exec(line);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (s) start = Number(s[1]);
    if (e && start !== null) {
      out.push([start, Number(e[1])]);
      start = null;
    }
  }
  if (start !== null) out.push([start, await probeDuration(file)]);
  return out;
}

async function blackStretches(file: string): Promise<string[]> {
  const { stderr } = await ffmpeg(
    ["-hide_banner", "-i", file, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-an", "-f", "null", "-"],
    { keepAllOutput: true },
  );
  return stderr.split(/\r?\n/).filter((l) => l.includes("black_start"));
}

function parseSrt(text: string): { start: number; end: number; text: string }[] {
  const t = (s: string) => {
    const [h, m, rest] = s.split(":");
    const [sec, ms] = rest!.split(",");
    return Number(h) * 3600 + Number(m) * 60 + Number(sec) + Number(ms) / 1000;
  };
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const [a, b] = lines[1]!.split(" --> ");
      return { start: t(a!), end: t(b!), text: lines.slice(2).join(" ") };
    });
}

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
      update: { enabled: true },
    });
  }
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({ where: { slug: preset.slug }, create: { ...preset, aspectRatio: "9:16" }, update: {} });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: { ...character, voiceProvider: "mock", enabled: true },
      update: {},
    });
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-timing-"));
  await setSpendCap(20);
  await seedMock();
  const validated = await validateImport(scanImportSource(FIXTURE));
  const created = await materialiseImport(validated, { batchName: "QA voice timing", maxCostPerVideo: 0.7, maxCostForBatch: 1 });
  batchId = created.batchId;
  projectId = created.projects[0]!.projectId;
  await approveAndRun({ batchId, maxBatch: 1, lowAutoApproved: false, wait: true });
}, 300_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QA video: 5 cảnh dự kiến 5s, lời khác nhau", () => {
  it("COMPLETED, 0 ảnh, 0 video, 4 giọng (cảnh 4 không lời), không reservation treo", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("completed");
    const l = await ledger();
    expect(l.image).toBe(0);
    expect(l.video).toBe(0);
    expect(l.voice).toBe(4);
    expect(l.reserved).toBe(0);
  });

  it("mỗi cảnh lưu dự kiến / lời đo được / cuối / lý do; dự kiến KHÔNG bị ghi đè", async () => {
    const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
    expect(scenes.map((s) => s.duration)).toEqual([5, 5, 5, 5, 5]);
    expect(scenes.map((s) => s.durationMode)).toEqual(["AUTO", "AUTO", "AUTO", "AUTO", "AUTO"]);
    expect(scenes.map((s) => s.timingReason)).toEqual(["VOICE_PADDED", "VOICE_PADDED", "VOICE_PADDED", "NO_VOICE_PLANNED", "VOICE_PADDED"]);
    expect(scenes[3]!.voiceDurationActual).toBeNull();
    expect(scenes[3]!.finalDuration).toBe(5);
    for (const s of [scenes[0]!, scenes[1]!, scenes[2]!, scenes[4]!]) {
      expect(s.voiceDurationActual).toBeGreaterThan(1);
      expect(s.finalDuration).toBeCloseTo(s.voiceDurationActual! + 0.5, 2);
    }
  });

  it("MP4 thật: tổng giảm rõ, khớp tổng cuối; không đoạn đen; audio không kết thúc sau video", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const mp4 = toAbsolute(project.finalVideoPath!);
    const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
    const planned = scenes.reduce((n, s) => n + s.duration, 0);
    const final = scenes.reduce((n, s) => n + s.finalDuration!, 0);
    const measured = await probeDuration(mp4);
    expect(planned).toBe(25);
    expect(final).toBeLessThan(planned - 5);
    expect(measured).toBeCloseTo(final, 1);
    expect(await blackStretches(mp4)).toEqual([]);

    // L. Silence: the only long gap is the scene that has no voice at all;
    // between voiced scenes the gap is the padding (0.35 after + 0.15 before).
    const gaps = await silences(mp4);
    let offset = 0;
    const bounds = scenes.map((s) => {
      const b = { n: s.sceneNumber, start: offset, end: offset + s.finalDuration! };
      offset += s.finalDuration!;
      return b;
    });
    const silent = bounds[3]!;
    for (const [a, b] of gaps) {
      const coversSilentScene = a <= silent.start + 0.6 && b >= silent.end - 0.6;
      if (!coversSilentScene) expect(b - a).toBeLessThan(0.8);
    }
    const longest = Math.max(...gaps.map(([a, b]) => b - a));
    const voicedGaps = gaps.filter(([a, b]) => !(a <= silent.start + 0.6 && b >= silent.end - 0.6)).map(([a, b]) => b - a);
    // The QA report reads these figures from the test output.
    console.log(
      "QA-TIMING " +
        JSON.stringify({
          planned,
          final: Math.round(final * 1000) / 1000,
          measured,
          longestSilence: Math.round(longest * 1000) / 1000,
          longestGapBetweenVoicedScenes: Math.round(Math.max(0, ...voicedGaps) * 1000) / 1000,
          audioEnd: Math.round(gaps[gaps.length - 1]![0] * 1000) / 1000,
          videoEnd: measured,
          scenes: scenes.map((s) => [s.sceneNumber, s.duration, s.voiceDurationActual, s.finalDuration, s.timingReason]),
        }),
    );
    expect(longest).toBeLessThanOrEqual(5 + 0.35 + 0.15 + 0.2);
    // Speech ends inside the video, one padding before the end.
    const lastGap = gaps[gaps.length - 1]!;
    expect(lastGap[1]).toBeCloseTo(measured, 1);
    expect(measured - lastGap[0]).toBeLessThan(0.6);
  });

  it("K. phụ đề theo nhịp cuối: mỗi câu nằm trong đúng cảnh, không chồng nhau, không vượt video", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const cues = parseSrt(fs.readFileSync(toAbsolute(project.subtitlePath!), "utf8"));
    const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
    const voiced = scenes.filter((s) => s.voiceDurationActual !== null);
    expect(cues).toHaveLength(voiced.length);
    let offset = 0;
    const starts: Record<number, number> = {};
    for (const s of scenes) {
      starts[s.sceneNumber] = offset;
      offset += s.finalDuration!;
    }
    voiced.forEach((s, i) => {
      const cue = cues[i]!;
      const start = starts[s.sceneNumber]!;
      expect(cue.text).toBe(s.subtitle);
      expect(cue.start).toBeGreaterThanOrEqual(start + 0.1);
      expect(cue.end).toBeLessThanOrEqual(start + s.finalDuration! + 1e-6);
      if (i > 0) expect(cue.start).toBeGreaterThan(cues[i - 1]!.end);
    });
  });
});

describe("J / H — không mua lại gì vì nhịp", () => {
  it("J. resume video đã xong: mọi delta = 0, không render lại", async () => {
    const before = await ledger();
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const mtime = fs.statSync(toAbsolute(project.finalVideoPath!)).mtimeMs;
    const renders = await prisma.job.count({ where: { projectId, type: "render_final" } });
    await resumeRun({ batchId, wait: true });
    expect(await ledger()).toEqual(before);
    expect(fs.statSync(toAbsolute(project.finalVideoPath!)).mtimeMs).toBe(mtime);
    expect(await prisma.job.count({ where: { projectId, type: "render_final" } })).toBe(renders);
  });

  it("H. đổi chế độ cảnh LOCAL_MOTION -> chỉ render lại tại máy; giọng giữ nguyên file; $0", async () => {
    const before = await ledger();
    const scene1 = await prisma.scene.findFirstOrThrow({ where: { projectId, sceneNumber: 1 }, include: { dialogueLines: true } });
    const voiceFiles = scene1.dialogueLines.map((l) => [l.outputPath, fs.statSync(toAbsolute(l.outputPath)).mtimeMs]);
    await prisma.scene.update({ where: { id: scene1.id }, data: { durationMode: "MINIMUM" } });
    await renderProjectNow(projectId);
    const after = await prisma.scene.findUniqueOrThrow({ where: { id: scene1.id }, include: { dialogueLines: true } });
    expect(after.finalDuration).toBe(5);
    expect(after.timingReason).toBe("MINIMUM_PLANNED");
    expect(after.dialogueLines.map((l) => [l.outputPath, fs.statSync(toAbsolute(l.outputPath)).mtimeMs])).toEqual(voiceFiles);
    expect(await ledger()).toEqual(before);
    await prisma.scene.update({ where: { id: scene1.id }, data: { durationMode: "AUTO" } });
  });
});

describe("E / F / G — clip VIDEO_AI đã mua, render thật", () => {
  let clip = "";
  const wav = (name: string, sec: number) => path.join(tmp, `${name}-${sec}.wav`);

  beforeAll(async () => {
    clip = path.join(tmp, "clip-5s.mp4");
    await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=teal:s=768x1280:r=30:d=5", "-pix_fmt", "yuv420p", clip]);
    for (const sec of [2.5, 5.1, 6.5]) {
      await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=330:sample_rate=24000:duration=${sec}`, wav("voice", sec)]);
    }
  }, 120_000);

  const scene = (voiceSec: number) => ({
    sceneNumber: 1,
    duration: 5,
    subtitle: "clip",
    videoPath: clip,
    audioPath: null,
    imagePath: null,
    motionSource: "AI_VIDEO",
    dialogueLines: [{ lineNumber: 1, speaker: "Max", text: "clip", audioPath: wav("voice", voiceSec), durationSec: voiceSec }],
  });

  it("E. clip 5s, cần 3s -> cắt TẠI MÁY, video 3s, clip gốc còn nguyên", async () => {
    const jobs = await prisma.providerJob.count();
    const r = await renderProject({ projectId: randomUUID(), target: DEFAULT_TARGET, burnSubtitles: false, scenes: [scene(2.5)] });
    expect(r.sceneTimings[0]!.timingReason).toBe("CLIP_TRIMMED_LOCAL");
    expect(await probeDuration(r.videoPath)).toBeCloseTo(3.0, 1);
    expect(await probeDuration(clip)).toBeCloseTo(5, 1);
    expect(await prisma.providerJob.count()).toBe(jobs);
  });

  it("F. clip 5s, lời cần ~5.35-5.6s -> giữ khung cuối <= 1s, lời đủ", async () => {
    const r = await renderProject({ projectId: randomUUID(), target: DEFAULT_TARGET, burnSubtitles: false, scenes: [scene(5.1)] });
    const t = r.sceneTimings[0]!;
    expect(t.timingReason).toBe("CLIP_FREEZE_EXTENDED");
    expect(t.freezeSec).toBeLessThanOrEqual(1);
    expect(await probeDuration(r.videoPath)).toBeCloseTo(t.finalDuration, 1);
    expect(t.finalDuration).toBeGreaterThanOrEqual(5.1 + t.leadInSec);
  });

  it("G. clip 5s, lời 6.5s -> BLOCKED trước khi đụng file, không request nào", async () => {
    const jobs = await prisma.providerJob.count();
    const id = randomUUID();
    await expect(
      renderProject({ projectId: id, target: DEFAULT_TARGET, burnSubtitles: false, scenes: [scene(6.5)] }),
    ).rejects.toBeInstanceOf(TimingBlockedError);
    await expect(
      renderProject({ projectId: id, target: DEFAULT_TARGET, burnSubtitles: false, scenes: [scene(6.5)] }),
    ).rejects.toThrow(/MEDIA_REGEN_REQUIRED/);
    expect(await prisma.providerJob.count()).toBe(jobs);
    const finalDir = path.join(process.env.DATA_DIR!, "projects", id, "final");
    expect(fs.existsSync(finalDir) ? fs.readdirSync(finalDir) : []).toEqual([]);
  });
});
