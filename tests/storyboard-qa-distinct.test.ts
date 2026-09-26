import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { setSpendCap, totalRealSpend } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun, preflightForApproval, resumeRun } from "@/services/batch-executor";
import { missingOutputFiles, outputDirFor, exportProjectOutput } from "@/services/output-export";
import { mockOnlyProjectIds, todayDashboard } from "@/services/dashboard";

/**
 * Final QA for Import Storyboard, $0 (mock providers, local FFmpeg).
 *
 * examples/storyboard-qa-distinct has five keyframes that differ in every byte
 * and in colour (red, blue, yellow, purple, black) with uneven durations. The
 * test follows each picture from file -> Asset -> Scene -> the frame that
 * plays in the final MP4, so order is proven from the video itself, not from
 * the database.
 */

const FIXTURE = path.join(process.cwd(), "examples", "storyboard-qa-distinct");
const EXPECTED = [
  { n: 1, name: "red", rgb: [211, 47, 47] },
  { n: 2, name: "blue", rgb: [21, 101, 192] },
  { n: 3, name: "yellow", rgb: [251, 192, 45] },
  { n: 4, name: "purple", rgb: [106, 27, 154] },
  { n: 5, name: "black", rgb: [0, 0, 0] },
] as const;

let tmp = "";
let batchId = "";
let projectId = "";

const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

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

/** Average colour of the whole frame at time t, as RGB. */
async function frameColour(file: string, t: number): Promise<[number, number, number]> {
  const out = path.join(tmp, `frame-${t}.rgb`);
  await ffmpeg([
    "-v", "error", "-y", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1",
    "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", out,
  ]);
  const b = fs.readFileSync(out);
  return [b[0]!, b[1]!, b[2]!];
}

function nearest(rgb: [number, number, number]): string {
  let best = "";
  let bestD = Infinity;
  for (const e of EXPECTED) {
    const d = (rgb[0] - e.rgb[0]) ** 2 + (rgb[1] - e.rgb[1]) ** 2 + (rgb[2] - e.rgb[2]) ** 2;
    if (d < bestD) [best, bestD] = [e.name, d];
  }
  return best;
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

/** A copy of the fixture with one change, for the failure cases. */
function variant(name: string, mutate: (sb: { scenes: Record<string, unknown>[] }) => void, extra: Record<string, Buffer> = {}): string {
  const src = path.join(FIXTURE, "video-001");
  const dir = path.join(tmp, name, "video-001");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(src)) if (f.endsWith(".png")) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  for (const [f, bytes] of Object.entries(extra)) fs.writeFileSync(path.join(dir, f), bytes);
  const sb = JSON.parse(fs.readFileSync(path.join(src, "storyboard.json"), "utf8"));
  sb.video_id = `qa-${name}`;
  mutate(sb);
  fs.writeFileSync(path.join(dir, "storyboard.json"), JSON.stringify(sb));
  return path.join(tmp, name);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qa-distinct-"));
  await setSpendCap(20);
  await seedMock();
  const validated = await validateImport(scanImportSource(FIXTURE));
  expect(validated.videos).toHaveLength(1);
  const created = await materialiseImport(validated, { batchName: "QA distinct", maxCostPerVideo: 0.7, maxCostForBatch: 1 });
  batchId = created.batchId;
  projectId = created.projects[0]!.projectId;
}, 180_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("1. năm ảnh khác nhau thật sự: file -> Asset -> Scene", () => {
  it("5 file, 5 SHA256 khác nhau", () => {
    const hashes = EXPECTED.map((e) => sha(path.join(FIXTURE, "video-001", `scene-0${e.n}.png`)));
    expect(new Set(hashes).size).toBe(5);
  });

  it("cảnh n dùng đúng ảnh n: không đảo, không trùng, không mất, asset đúng cảnh", async () => {
    const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
    expect(scenes.map((s) => s.sceneNumber)).toEqual([1, 2, 3, 4, 5]);
    const assetIds = new Set<string>();
    for (const s of scenes) {
      const source = path.join(FIXTURE, "video-001", `scene-0${s.sceneNumber}.png`);
      expect(s.imageSource).toBe("IMPORTED");
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: s.imageAssetId! } });
      expect(asset.source).toBe("IMPORTED");
      expect(asset.sceneId).toBe(s.id);
      expect(asset.originalFilename).toBe(`scene-0${s.sceneNumber}.png`);
      expect(asset.sha256).toBe(sha(source));
      // The picture the scene will actually use, on disk, is that same file.
      expect(sha(toAbsolute(s.imagePath!))).toBe(sha(source));
      assetIds.add(asset.id);
    }
    expect(assetIds.size).toBe(5);
  });
});

describe("2. ảnh nhập = REUSE, 0 Image API", () => {
  it("preflight: IMPORTED/REUSE 5, WILL_CREATE 0, Image POST dự kiến 0, tiền ảnh $0", async () => {
    const jobs0 = await prisma.providerJob.count();
    const pre = await preflightForApproval(batchId);
    expect(await prisma.providerJob.count()).toBe(jobs0);
    const video = pre.preflight!.videos[0]!;
    expect(video.scenes.map((s) => s.imageSource)).toEqual(["IMPORTED", "IMPORTED", "IMPORTED", "IMPORTED", "IMPORTED"]);
    // The table names the file each scene got, in scene order.
    expect(video.scenes.map((s) => s.imageFilename)).toEqual(EXPECTED.map((e) => `scene-0${e.n}.png`));
    expect(video.counts.imagePosts).toBe(0);
    expect(video.breakdown.image).toBe(0);
    expect(pre.imagePosts).toBe(0);
    expect(pre.videoPosts).toBe(0);
    expect(pre.ready).toBe(true);
  });

  it("chạy (mock): 0 job ảnh, 0 job video, COMPLETED", async () => {
    const realBefore = await totalRealSpend();
    const dashBefore = (await todayDashboard()).apiSpend;
    await approveAndRun({ batchId, maxBatch: 1, lowAutoApproved: false, wait: true });
    const l = await ledger();
    expect(l.image).toBe(0);
    expect(l.video).toBe(0);
    expect(l.voice).toBe(5);
    expect(l.reserved).toBe(0);
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("completed");
    // Mock work never moves the real-money figure.
    expect(await totalRealSpend()).toBe(realBefore);
    // ...and the dashboard counts real money only, and keeps a mock-made
    // video out of the production count and average.
    const day = await todayDashboard();
    expect(day.apiSpend).toBe(dashBefore);
    expect(await mockOnlyProjectIds([projectId])).toEqual(new Set([projectId]));
    expect(day.videosCompletedMock).toBeGreaterThanOrEqual(1);
  });
});

describe("3. thứ tự cảnh đọc từ MP4 thật", () => {
  it("khung giữa mỗi cảnh (theo thời lượng cuối đã render) đúng màu 1 -> 2 -> 3 -> 4 -> 5", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const mp4 = toAbsolute(project.finalVideoPath!);
    const scenes = await prisma.scene.findMany({ where: { projectId, skipped: false }, orderBy: { sceneNumber: "asc" } });
    const total = scenes.reduce((n, s) => n + (s.finalDuration ?? s.duration), 0);
    expect(await probeDuration(mp4)).toBeCloseTo(total, 1);
    let start = 0;
    const seen: string[] = [];
    for (const s of scenes) {
      seen.push(nearest(await frameColour(mp4, start + (s.finalDuration ?? s.duration) / 2)));
      start += s.finalDuration ?? s.duration;
    }
    expect(seen).toEqual(EXPECTED.map((e) => e.name));
  });

  it("output: final.mp4, thumbnail.jpg, subtitles.srt, metadata.json đều có", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(missingOutputFiles(project)).toEqual([]);
    const dir = outputDirFor(project);
    const srt = fs.readFileSync(path.join(dir, "subtitles.srt"), "utf8");
    expect(srt.indexOf("Scene 1.")).toBeLessThan(srt.indexOf("Scene 5."));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
    expect(meta.sceneCount).toBe(5);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
  });
});

describe("6. TIẾP TỤC / KIỂM TRA LẠI trên video COMPLETED", () => {
  it("final còn hợp lệ: +0 job, +0 CostEntry, +0 POST, retry không tăng, không render lại", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const mp4 = toAbsolute(project.finalVideoPath!);
    const before = await ledger();
    const hash = sha(mp4);
    const mtime = fs.statSync(mp4).mtimeMs;
    const renders = await prisma.job.count({ where: { projectId, type: "render_final" } });
    await resumeRun({ batchId, wait: true });
    expect(await ledger()).toEqual(before);
    expect(sha(mp4)).toBe(hash);
    expect(fs.statSync(mp4).mtimeMs).toBe(mtime);
    expect(await prisma.job.count({ where: { projectId, type: "render_final" } })).toBe(renders);
  });
});

describe("9. lỗi miễn phí — dừng đúng tầng, không job ma", () => {
  it("subtitles.srt trong output bị xoá -> resume xuất lại tại máy, $0, không render lại", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const before = await ledger();
    const renders = await prisma.job.count({ where: { projectId, type: "render_final" } });
    fs.rmSync(path.join(outputDirFor(project), "subtitles.srt"));
    expect(missingOutputFiles(project)).toEqual(["subtitles.srt"]);
    await resumeRun({ batchId, wait: true });
    expect(missingOutputFiles(project)).toEqual([]);
    expect(await ledger()).toEqual(before);
    expect(await prisma.job.count({ where: { projectId, type: "render_final" } })).toBe(renders);
  });

  it("final.mp4 trong output bị xoá -> resume xuất lại, $0", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const before = await ledger();
    fs.rmSync(path.join(outputDirFor(project), "final.mp4"));
    await resumeRun({ batchId, wait: true });
    expect(missingOutputFiles(project)).toEqual([]);
    expect(await ledger()).toEqual(before);
  });

  it("MP4 cuối của dự án bị xoá -> resume render lại TẠI MÁY từ media có sẵn, không gọi provider", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const before = await ledger();
    fs.rmSync(toAbsolute(project.finalVideoPath!));
    await resumeRun({ batchId, wait: true });
    const after = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(after.status).toBe("completed");
    expect(fs.existsSync(toAbsolute(after.finalVideoPath!))).toBe(true);
    expect(await ledger()).toEqual(before);
  });

  it("file phụ đề của dự án bị xoá -> render lại tại máy, phụ đề có lại, $0", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const before = await ledger();
    fs.rmSync(toAbsolute(project.subtitlePath!));
    await resumeRun({ batchId, wait: true });
    const after = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(fs.existsSync(toAbsolute(after.subtitlePath!))).toBe(true);
    expect(await ledger()).toEqual(before);
  });

  it("thư mục output không ghi được -> lỗi rõ ràng, video vẫn COMPLETED, không job nào", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const dir = outputDirFor(project);
    const before = await ledger();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, "chặn: một FILE nằm đúng chỗ thư mục output");
    try {
      await expect(exportProjectOutput(projectId)).rejects.toThrow();
      await resumeRun({ batchId, wait: true });
      const log = await prisma.logEntry.findFirst({
        where: { event: "output.export_failed", projectId },
        orderBy: { createdAt: "desc" },
      });
      expect(log?.message).toContain("Không xuất được thư mục output");
      expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe("completed");
      expect(await ledger()).toEqual(before);
    } finally {
      fs.rmSync(dir, { force: true });
    }
    await resumeRun({ batchId, wait: true });
    expect(missingOutputFiles(project)).toEqual([]);
  });

  it("thiếu duration -> cảnh báo rõ, dùng 4s; thiếu motion_mode -> AUTO (router quyết)", async () => {
    const scanned = scanImportSource(
      variant("defaults", (sb) => {
        delete sb.scenes[1]!.duration;
        delete sb.scenes[2]!.motion_mode;
      }),
    );
    const v = await validateImport(scanned);
    const issues = [...scanned.issues, ...v.issues].map((i) => i.code);
    expect(issues).toContain("duration_defaulted");
    const scenes = v.videos[0]!.scenes;
    expect(scenes[1]!.scene.duration).toBe(4);
    expect(scenes[2]!.scene.motionMode).toBe("AUTO");
  });

  it("hai cảnh cùng tên file / cùng nội dung ảnh -> hợp lệ, mỗi cảnh một Asset, không lẫn cảnh", async () => {
    const one = fs.readFileSync(path.join(FIXTURE, "video-001", "scene-01.png"));
    const scanned = scanImportSource(
      variant(
        "dups",
        (sb) => {
          sb.scenes[1]!.image_file = "scene-01.png"; // same file name as scene 1
          sb.scenes[2]!.image_file = "copy-of-1.png"; // different name, same bytes
        },
        { "copy-of-1.png": one },
      ),
    );
    const v = await validateImport(scanned);
    expect(v.issues.filter((i) => i.level === "error")).toEqual([]);
    const created = await materialiseImport(v, { batchName: "QA dups", maxCostPerVideo: 0.7, maxCostForBatch: 1 });
    const scenes = await prisma.scene.findMany({ where: { projectId: created.projects[0]!.projectId }, orderBy: { sceneNumber: "asc" } });
    const assets = await prisma.asset.findMany({ where: { id: { in: scenes.map((s) => s.imageAssetId!) } } });
    expect(new Set(assets.map((a) => a.id)).size).toBe(5);
    const bySceneId = Object.fromEntries(assets.map((a) => [a.sceneId, a]));
    const s1 = sha(path.join(FIXTURE, "video-001", "scene-01.png"));
    expect(scenes.slice(0, 3).map((s) => bySceneId[s.id]!.sha256)).toEqual([s1, s1, s1]);
    expect(scenes[3]!.imageSource).toBe("IMPORTED");
    expect(bySceneId[scenes[3]!.id]!.sha256).toBe(sha(path.join(FIXTURE, "video-001", "scene-04.png")));
    expect(await prisma.providerJob.count({ where: { projectId: created.projects[0]!.projectId } })).toBe(0);
  });

  it("JSON sai cấu trúc / ảnh thiếu / ảnh hỏng -> lỗi đích danh, không tạo lô", async () => {
    const batches = await prisma.batch.count();
    const bad = scanImportSource(variant("schema", (sb) => { (sb as { scenes: unknown }).scenes = "x"; }));
    expect(bad.issues.map((i) => i.code)).toContain("json_schema_invalid");

    const missing = await validateImport(scanImportSource(variant("missing", (sb) => { sb.scenes[3]!.image_file = "khong-co.png"; })));
    expect(missing.issues.some((i) => i.level === "error" && i.message.includes("khong-co.png"))).toBe(true);

    const broken = await validateImport(
      scanImportSource(variant("broken", () => undefined, { "scene-02.png": Buffer.from("<html>not a png</html>") })),
    );
    expect(broken.issues.some((i) => i.level === "error")).toBe(true);
    expect(await prisma.batch.count()).toBe(batches);
  });

  it("VIDEO_AI không có keyframe nhập -> preflight nói rõ WILL_CREATE 1 ảnh (không âm thầm)", async () => {
    const v = await validateImport(
      scanImportSource(
        variant("vai", (sb) => {
          sb.scenes[0]!.motion_mode = "VIDEO_AI";
          sb.scenes[0]!.priority = "HIGH";
          delete sb.scenes[0]!.image_file;
        }),
      ),
    );
    const created = await materialiseImport(v, { batchName: "QA vai", maxCostPerVideo: 5, maxCostForBatch: 5 });
    const pre = await preflightForApproval(created.batchId);
    const video = pre.preflight!.videos[0]!;
    expect(video.scenes[0]!.imageSource).toBe("WILL_CREATE");
    expect(video.scenes.slice(1).every((s) => s.imageSource === "IMPORTED")).toBe(true);
    expect(pre.imagePosts).toBe(1);
    expect(await prisma.providerJob.count({ where: { projectId: created.projects[0]!.projectId } })).toBe(0);
  });
});
