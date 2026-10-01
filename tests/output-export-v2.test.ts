import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute, toRelative } from "@/lib/paths";
import { setSpendCap } from "@/services/spend-guard";
import { runZeroCostVideos, rerenderVideo, saveSocialMeta, setBatchPreset, setThumbnailChoice, storeThumbnailUpload, videoDetail } from "@/services/daily-actions";
import { exportProjectOutput, exportReadyOf, missingOutputFiles, type OutputMetadata } from "@/services/output-export";
import { ensureOutputDir, legacyOutputDirFor, OUTPUT_ROOT } from "@/services/output-layout";
import { buildVideoResumePlan } from "@/services/video-resume";
import { preflightImportedBatch } from "@/services/import-preflight";
import { importBatch, makePng, moneyCounts, seedMock, writeBatchFolder } from "./phase6-helpers";

/**
 * V1.2 Phase 6 (QĐ-114): the export folder a person posts from.
 * data/output/<batch-slug>/<video-slug>/ - Windows-safe names, no overwrite,
 * metadata without secrets, presets that only re-render locally, subtitles,
 * thumbnails, EXPORT READY, and the legacy folder still honoured. Mock, $0.
 */

let tmp = "";
let batchId = "";
let ids: Record<string, string> = {};
const TITLES = {
  vn: "5 công cụ AI hữu ích",
  emoji: "🔥 Mẹo hay 😎",
  special: 'Hỏi: "Tại sao?" <A/B> | 50% * giảm',
  long: "Một tiêu đề cực kỳ dài để kiểm tra việc cắt tên thư mục trên Windows mà không làm hỏng đường dẫn đầu ra của video này",
  dup: "5 công cụ AI hữu ích",
};

beforeAll(async () => {
  await seedMock();
  await setSpendCap(100);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p6-out-"));
  const images: Record<string, Buffer> = {};
  for (const c of ["red", "blue", "green", "yellow", "purple"]) {
    images[`${c}.png`] = fs.readFileSync(await makePng(path.join(tmp, "src"), c, "270x480"));
  }
  ({ batchId, ids } = await importBatch(
    writeBatchFolder(
      path.join(tmp, "Thư mục có dấu cách"),
      [
        { id: "vn", title: TITLES.vn, scenes: [{ image: "red.png", duration: 1 }, { image: "blue.png", duration: 1 }] },
        { id: "emoji", title: TITLES.emoji, scenes: [{ image: "green.png", duration: 1 }] },
        { id: "special", title: TITLES.special, scenes: [{ image: "yellow.png", duration: 1 }] },
        { id: "long", title: TITLES.long, scenes: [{ image: "purple.png", duration: 1 }] },
        { id: "dup", title: TITLES.dup, scenes: [{ image: "blue.png", duration: 1 }] },
      ],
      images,
    ),
    { name: "Lô Xuất / Thử: 2026-09-28" },
  ));
  await preflightImportedBatch(batchId);
  await runZeroCostVideos(batchId, { wait: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function projectOf(key: string) {
  return prisma.project.findUniqueOrThrow({ where: { id: ids[key]! } });
}

describe("output-path / video-slug", () => {
  it("data/output/<batch-slug>/<video-slug>/ — tiếng Việt, emoji, ký tự đặc biệt, tên dài, trùng tên", async () => {
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.slug).toMatch(/^lo-xuat-thu-2026-09-28(-\d+)?$/);
    const slugs = Object.fromEntries(
      await Promise.all(Object.keys(ids).map(async (k) => [k, (await projectOf(k)).outputSlug] as const)),
    );
    expect(slugs.vn).toBe("5-cong-cu-ai-huu-ich");
    expect(slugs.dup).toBe("5-cong-cu-ai-huu-ich-2");
    expect(slugs.emoji).toBe("meo-hay");
    expect(slugs.special).toBe("hoi-tai-sao-a-b-50-giam");
    expect(slugs.long!.length).toBeLessThanOrEqual(60);
    expect(slugs.long!.startsWith("mot-tieu-de-cuc-ky-dai")).toBe(true);
    // Every folder is distinct (no overwrite), inside data/output, and a path Windows can open.
    const dirs = new Set<string>();
    for (const k of Object.keys(ids)) {
      const p = await projectOf(k);
      const dir = toAbsolute(p.outputDir!);
      expect(dir.startsWith(path.join(OUTPUT_ROOT, batch.slug!))).toBe(true);
      expect(/[<>:"|?*]/.test(path.basename(dir))).toBe(false);
      expect(path.join(dir, "description.txt").length).toBeLessThan(250);
      dirs.add(dir);
      expect(fs.existsSync(path.join(dir, "final.mp4"))).toBe(true);
    }
    expect(dirs.size).toBe(5);
  });

  it("slug ổn định: đổi tên video không đổi thư mục; xuất lại vẫn cùng chỗ", async () => {
    const before = await projectOf("vn");
    await prisma.project.update({ where: { id: before.id }, data: { title: "Tên mới hoàn toàn" } });
    const dir = await exportProjectOutput(before.id);
    expect(toRelative(dir)).toBe(before.outputDir);
    await prisma.project.update({ where: { id: before.id }, data: { title: TITLES.vn } });
    await exportProjectOutput(before.id);
  });
});

describe("metadata.json / storyboard.json / text files", () => {
  it("đủ trường; không có key/token; chi phí thật $0 (mock không tính)", async () => {
    const p = await projectOf("vn");
    const dir = toAbsolute(p.outputDir!);
    const raw = fs.readFileSync(path.join(dir, "metadata.json"), "utf8");
    const m = JSON.parse(raw) as OutputMetadata;
    expect(m.schemaVersion).toBe(2);
    expect(m.title).toBe(TITLES.vn);
    expect(m.resolution).toBe("1080x1920");
    expect(m.fps).toBe(30);
    expect(m.aspectRatio).toBe("9:16");
    expect(m.language).toBe(p.language);
    expect(m.duration).toBeGreaterThan(0);
    expect(m.storyboardId).toBe("vn");
    expect(m.batchId).toBe(batchId);
    expect(m.scenes.length).toBe(2);
    expect(m.subtitleFile).toBeNull(); // silent video: no subtitles to export
    expect(m.thumbnailFile).toBe("thumbnail.jpg");
    expect(m.totalActualCost).toBe(0);
    expect(m.reusedAssetCount).toBeGreaterThanOrEqual(2);
    expect(m.preset.id).toBe("youtube-shorts");
    expect(m.providers).toContain("import/user-supplied-images");
    expect(raw).not.toMatch(/sk-|api[_-]?key|secret|token|Bearer/i);
    const sb = JSON.parse(fs.readFileSync(path.join(dir, "storyboard.json"), "utf8"));
    expect(sb.storyboardId).toBe("vn");
    expect(sb.scenes.length).toBe(2);
    expect(fs.existsSync(path.join(dir, "description.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "captions.txt"))).toBe(true);
  });

  it("metadata người nhập được ghi vào metadata.json + description.txt khi xuất lại", async () => {
    const p = await projectOf("emoji");
    await saveSocialMeta(p.id, { title: "Mẹo hay mỗi ngày", description: "Mô tả của tôi", tags: ["mẹo", "Mẹo", "ai"], hashtags: ["shorts", "#AI tools"] });
    const dir = await exportProjectOutput(p.id);
    const m = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")) as OutputMetadata;
    expect(m.title).toBe("Mẹo hay mỗi ngày");
    expect(m.description).toBe("Mô tả của tôi");
    expect(m.tags).toEqual(["mẹo", "ai"]);
    expect(m.hashtags).toEqual(["#shorts", "#AItools"]);
    expect(fs.readFileSync(path.join(dir, "description.txt"), "utf8")).toContain("Mô tả của tôi");
  });
});

describe("export ready", () => {
  it("READY TO PUBLISH: mp4 đọc được, thời lượng > 0, thumbnail, metadata, đường dẫn hợp lệ", async () => {
    const p = await projectOf("special");
    const ready = exportReadyOf(p.exportReadyJson)!;
    expect(ready.ready).toBe(true);
    for (const id of ["mp4", "playable", "duration", "thumbnail", "metadata", "paths"]) {
      expect(ready.checks.find((c) => c.id === id)?.ok).toBe(true);
    }
    expect(ready.width).toBe(1080);
    expect(ready.height).toBe(1920);
    expect(missingOutputFiles(p)).toEqual([]);
  });
});

describe("preset / subtitle / thumbnail — chỉ render/xuất tại máy", () => {
  it("preset SRT-only: RENDER LẠI tại máy (không phụ đề in), 0 job; preset NONE: không còn subtitles.srt", async () => {
    // The default render burns subtitles (Settings), so SRT-only is a real change of recipe.
    const { saveSettings: save } = await import("@/lib/settings");
    await save({ burnSubtitles: true });
    // A spoken video, so there are subtitles to route.
    const withVoice = await importBatch(
      writeBatchFolder(path.join(tmp, "voice"), [{ id: "talk", title: "Có lời", scenes: [{ image: "red.png", duration: 1, line: "Hi there." }] }], {
        "red.png": fs.readFileSync(await makePng(path.join(tmp, "src2"), "red", "270x480")),
      }),
    );
    await preflightImportedBatch(withVoice.batchId);
    const { approveAndRun } = await import("@/services/batch-executor");
    await approveAndRun({ batchId: withVoice.batchId, maxBatch: 1, lowAutoApproved: false, wait: true });
    const pid = withVoice.ids.talk!;
    const first = await prisma.project.findUniqueOrThrow({ where: { id: pid } });
    expect(fs.existsSync(path.join(toAbsolute(first.outputDir!), "subtitles.srt"))).toBe(true);

    const custom = { id: "srt-only", name: "SRT only", platform: "CUSTOM" as const, width: 1080, height: 1920, fps: 30, videoCodec: "h264" as const, quality: "STANDARD" as const, audioCodec: "aac" as const, audioBitrateKbps: 192, subtitleMode: "SRT" as const, thumbnail: true, metadata: true, textFiles: true };
    const none = { ...custom, id: "no-subs", name: "No subs", subtitleMode: "NONE" as const };
    const { saveSettings, getSettings } = await import("@/lib/settings");
    const keep = (await getSettings()).customPresets;
    const burnBefore = (await getSettings()).burnSubtitles;
    await saveSettings({ customPresets: [...keep, custom, none] });
    try {
      const before = await moneyCounts();
      await setBatchPreset(withVoice.batchId, "srt-only");
      await rerenderVideo(pid);
      const after = await prisma.project.findUniqueOrThrow({ where: { id: pid } });
      expect(after.finalVideoPath).not.toBe(first.finalVideoPath); // recipe changed -> local re-render
      expect(after.renderRecipe).not.toBe(first.renderRecipe);
      const dir = toAbsolute(after.outputDir!);
      expect(fs.existsSync(path.join(dir, "subtitles.srt"))).toBe(true);
      const recipeFields = JSON.parse(JSON.stringify({ burn: after.renderRecipe }));
      expect(recipeFields.burn).toMatch(/^recipe:/);
      expect(await moneyCounts()).toEqual(before);

      await setBatchPreset(withVoice.batchId, "no-subs");
      await rerenderVideo(pid);
      const noSubs = await prisma.project.findUniqueOrThrow({ where: { id: pid } });
      expect(fs.existsSync(path.join(toAbsolute(noSubs.outputDir!), "subtitles.srt"))).toBe(false);
      const m = JSON.parse(fs.readFileSync(path.join(toAbsolute(noSubs.outputDir!), "metadata.json"), "utf8")) as OutputMetadata;
      expect(m.subtitleFile).toBeNull();
      expect(missingOutputFiles(noSubs)).toEqual([]);
      // Resume on it: nothing to do, nothing bought.
      expect((await buildVideoResumePlan(pid)).nextStep).toBe("NONE");
      expect(await moneyCounts()).toEqual(before);
      await setBatchPreset(withVoice.batchId, "");
    } finally {
      await saveSettings({ customPresets: keep, burnSubtitles: burnBefore });
    }
  });

  it("thumbnail: chọn cảnh (cắt tại máy) và ảnh tải lên; không gọi Image API", async () => {
    const p = await projectOf("vn");
    const before = await moneyCounts();
    await setThumbnailChoice(p.id, { mode: "SCENE", sceneNumber: 2 });
    let dir = await exportProjectOutput(p.id);
    const side = JSON.parse(fs.readFileSync(path.join(dir, "thumbnail.json"), "utf8")) as { key: string };
    expect(side.key).toContain("force_original_aspect_ratio=increase,crop=540:960");
    const upload = fs.readFileSync(await makePng(path.join(tmp, "up"), "white", "400x400"));
    const rel = await storeThumbnailUpload(p.id, upload);
    expect(fs.existsSync(toAbsolute(rel))).toBe(true);
    dir = await exportProjectOutput(p.id);
    expect(fs.statSync(path.join(dir, "thumbnail.jpg")).size).toBeGreaterThan(0);
    await expect(storeThumbnailUpload(p.id, Buffer.from("not an image at all"))).rejects.toThrow(/PNG, JPG/);
    await setThumbnailChoice(p.id, { mode: "DEFAULT" });
    expect(await moneyCounts()).toEqual(before);
  });

  it("chi tiết video: vùng an toàn Shorts + kiểm tra sẵn sàng + danh sách file", async () => {
    const d = await videoDetail(ids.vn!);
    expect(d.safeArea.platform).toBe("YOUTUBE_SHORTS");
    expect(d.safeArea.zones).not.toBeNull();
    expect(d.exportReady?.ready).toBe(true);
    expect(d.output?.files).toEqual(expect.arrayContaining(["final.mp4", "metadata.json", "thumbnail.jpg", "storyboard.json"]));
    expect(d.output?.files.some((f) => f.startsWith("."))).toBe(false);
  });
});

describe("tương thích thư mục cũ", () => {
  it("video đã xuất ở data/output/<title>-<id8>/ trước Phase 6: dùng lại đúng chỗ, không di chuyển", async () => {
    const p = await projectOf("long");
    const legacy = legacyOutputDirFor(p);
    fs.mkdirSync(legacy, { recursive: true });
    fs.copyFileSync(toAbsolute(p.finalVideoPath!), path.join(legacy, "final.mp4"));
    await prisma.project.update({ where: { id: p.id }, data: { outputDir: null } });
    const dir = await ensureOutputDir(p.id);
    expect(dir).toBe(legacy);
    expect((await projectOf("long")).outputDir).toBe(toRelative(legacy));
    const exported = await exportProjectOutput(p.id);
    expect(exported).toBe(legacy);
    expect(fs.existsSync(path.join(legacy, "metadata.json"))).toBe(true);
  });
});
