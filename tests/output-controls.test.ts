import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import {
  controlsOf,
  defaultControls,
  fitCaption,
  mergeControls,
  OutputControlsSchema,
  platformSafeArea,
  subtitleLayout,
} from "@/domain/output-controls";
import { profileFromPlatform } from "@/domain/platform-profile";
import { buildASS, buildSRT, fittedCues } from "@/media/subtitles";
import { buildFinalMixGraph } from "@/media/scene-audio";
import { sfxFileFor, sfxRecipeFor } from "@/media/sfx-library";
import type { RenderRequest } from "@/media/render";
import { approveContentScript, createContentProject } from "@/services/content-service";
import { startMediaGeneration } from "@/services/project-service";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import {
  applyOutputControls,
  saveProjectControls,
  setBackgroundMusic,
  subtitlePreviewFrame,
} from "@/services/output-controls";
import { makeSceneVoice, sceneVoiceStatus } from "@/services/scene-voice";
import { sceneCharacters, isNarrator } from "@/domain/scene-characters";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { makeWav, seedMock } from "./phase5-helpers";

/**
 * VIDEO OUTPUT controls (QĐ-125): smaller, fitted, safely placed subtitles;
 * narration / music / effect levels; narrator voice - and a re-render that
 * buys nothing.
 */

const base = OutputControlsSchema.parse({});
const LONG =
  "Đây là một câu phụ đề rất dài để kiểm tra việc tự động xuống dòng và chia màn hình khi lời thoại quá dài so với khung hình dọc của TikTok";

describe("SUBTITLE LAYOUT (pure)", () => {
  it("cỡ chữ Nhỏ < Vừa < Lớn, scale theo cạnh ngắn: 9:16, 16:9, 1:1, 4:5 đọc như nhau", () => {
    const at = (size: "SMALL" | "MEDIUM" | "LARGE", w: number, h: number) => subtitleLayout({ ...base.subtitles, size }, w, h).fontSize;
    expect(at("SMALL", 1080, 1920)).toBeLessThan(at("MEDIUM", 1080, 1920));
    expect(at("MEDIUM", 1080, 1920)).toBeLessThan(at("LARGE", 1080, 1920));
    for (const [w, h] of [[1920, 1080], [1080, 1080], [1080, 1350]] as const) {
      expect(at("MEDIUM", w, h)).toBe(at("MEDIUM", 1080, 1920));
    }
    // The old default was 7.8% of the height (150 px on 1920). The new one is far smaller.
    expect(at("MEDIUM", 1080, 1920)).toBeLessThan(Math.round(1920 * 0.078) * 0.6);
  });

  it("câu dài: tự xuống dòng, tối đa 2 dòng mỗi màn hình, không mất chữ, khối chữ ≤ 15% chiều cao", () => {
    const layout = subtitleLayout(base.subtitles, 1080, 1920);
    const fit = fitCaption(LONG, layout);
    expect(fit.screens.every((s) => s.length <= 2)).toBe(true);
    expect(fit.screens.flat().join(" ")).toBe(LONG);
    expect(fit.fontSize).toBeLessThanOrEqual(layout.fontSize);
    expect(fit.fontSize).toBeGreaterThanOrEqual(layout.minFontSize);
    for (const s of fit.screens) expect(s.length * fit.fontSize * 1.25).toBeLessThanOrEqual(1920 * 0.15);
    for (const line of fit.screens.flat()) expect(line.length * fit.fontSize * 0.55).toBeLessThanOrEqual(1080 - layout.marginL - layout.marginR + fit.fontSize);
    const cues = fittedCues([{ startSeconds: 0, endSeconds: 6, text: LONG }], layout);
    expect(cues.length).toBe(fit.screens.length);
    expect(cues[0]!.startSeconds).toBe(0);
    expect(cues.at(-1)!.endSeconds).toBe(6);
  });

  it("9:16: dưới nhưng trên vùng UI nền tảng, chừa cột nút bên phải; 16:9 có vùng an toàn riêng", () => {
    const v = subtitleLayout(base.subtitles, 1080, 1920);
    expect(v.marginV).toBeGreaterThanOrEqual(Math.round(1920 * 0.2));
    expect(v.marginR).toBeGreaterThanOrEqual(Math.round(1080 * 0.16));
    // Pulling it down never goes into the platform UI.
    expect(subtitleLayout({ ...base.subtitles, offsetPct: -20 }, 1080, 1920).marginV).toBe(Math.round(1920 * 0.2));
    // Pushing it up moves it.
    expect(subtitleLayout({ ...base.subtitles, offsetPct: 10 }, 1080, 1920).marginV).toBeGreaterThan(v.marginV);
    const w = subtitleLayout(base.subtitles, 1920, 1080);
    expect(w.marginV).toBe(Math.round(1080 * platformSafeArea(1920, 1080).bottom));
    expect(subtitleLayout({ ...base.subtitles, position: "TOP" }, 1080, 1920).alignment).toBe(8);
  });

  it("ASS/SRT theo bố cục: mỗi dòng phụ đề ≤ 2 dòng; kiểu 'nền tối' là hộp", () => {
    const layout = subtitleLayout(base.subtitles, 1080, 1920);
    const ass = buildASS([{ startSeconds: 0, endSeconds: 6, text: LONG }], { width: 1080, height: 1920, layout });
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events.length).toBeGreaterThan(1);
    for (const e of events) expect(e.split("\\N").length).toBeLessThanOrEqual(2);
    expect(ass).toMatch(/WrapStyle: 2/);
    const box = buildASS([{ startSeconds: 0, endSeconds: 2, text: "Xin chào" }], {
      width: 1080,
      height: 1920,
      layout: subtitleLayout({ ...base.subtitles, style: "BOX" }, 1080, 1920),
    });
    expect(box).toMatch(/,3,\d+,0,2,/); // BorderStyle 3 = opaque box
    expect(buildSRT([{ startSeconds: 0, endSeconds: 6, text: LONG }], layout).split("\n\n").filter(Boolean).length).toBe(events.length);
  });

  it("mặc định: dự án cũ giữ nguyên âm thanh (không SFX, không fade); dự án mới có SFX + fade", () => {
    expect(defaultControls({ contentType: null }).audio).toMatchObject({ sfxEnabled: false, fades: false, narrationVolume: 1 });
    expect(defaultControls({ contentType: "PRODUCT_REVIEW" }).audio).toMatchObject({ sfxEnabled: true, fades: true });
    expect(controlsOf({ contentType: null, outputControlsJson: "{broken" }).subtitles.size).toBe("MEDIUM");
    const merged = mergeControls(base, { subtitles: { size: "LARGE" }, audio: { narrationVolume: 1.5 } });
    expect(merged.subtitles.size).toBe("LARGE");
    expect(merged.audio.narrationVolume).toBe(1.5);
    expect(() => mergeControls(base, { audio: { narrationVolume: 3 } })).toThrow();
  });
});

describe("AUDIO (pure + local ffmpeg)", () => {
  it("không đặt gì: đồ thị trộn y hệt trước; âm lượng lời đọc/chuẩn hoá/fade chỉ là bộ lọc FFmpeg", () => {
    const legacy = buildFinalMixGraph({ dialoguePath: "d.wav" });
    expect(legacy.graph).toBe("[0:a]aresample=24000[a]");
    const louder = buildFinalMixGraph({ dialoguePath: "d.wav", voice: { gain: 1.5, normalize: true, fadeSec: 0.3, totalSec: 20 } });
    expect(louder.graph).toMatch(/volume=1\.5/);
    expect(louder.graph).toMatch(/loudnorm/);
    expect(louder.graph).toMatch(/afade=t=in/);
    expect(louder.graph).toMatch(/afade=t=out:st=19\.7/);
  });

  it("nhạc nền: hạ dưới lời (sidechain) hoặc không; SFX tắt = không có lớp SFX", () => {
    const ducked = buildFinalMixGraph({ dialoguePath: "d.wav", musicPath: "m.mp3", settings: { musicGain: 0.15, duckDb: 12 } });
    expect(ducked.graph).toMatch(/sidechaincompress/);
    expect(ducked.graph).toMatch(/volume=0\.15/);
    const withSfx = buildFinalMixGraph({ dialoguePath: "d.wav", sfx: [{ path: "s.wav", atSec: 1 }], settings: { sfxGain: 0.4 } });
    expect(withSfx.inputs).toHaveLength(2);
    expect(withSfx.graph).toMatch(/volume=0\.4/);
  });

  it("SFX tổng hợp tại máy, $0: whoosh/ding/pop; gợi ý không có công thức thì bỏ qua", async () => {
    expect(sfxRecipeFor("whoosh")).toBe("whoosh");
    expect(sfxRecipeFor("bright pop")).toBe("pop");
    expect(sfxRecipeFor("soft impact")).toBe("impact");
    expect(sfxRecipeFor("animal sound")).toBeNull();
    const file = await sfxFileFor("ding");
    expect(file && fs.statSync(file).size).toBeGreaterThan(1000);
  });
});

describe("PROJECT (DB, mock): đổi thiết lập → chỉ render lại tại máy", () => {
  let tmp = "";
  let capBefore = 0;
  let projectId = "";

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "out-ctl-"));
    await seedMock();
    const s = await spendStatus();
    capBefore = s.cap;
    await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
    const p = await createContentProject({
      contentType: "KNOWLEDGE",
      sourceType: "PROMPT",
      idea: "Vì sao bầu trời màu xanh vào ban ngày",
      durationSeconds: 15,
      outputProfile: profileFromPlatform("TIKTOK"),
    });
    projectId = p.id;
    await approveContentScript(projectId);
    const started = await startMediaGeneration(projectId);
    await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
  }, 900_000);

  afterAll(async () => {
    if (capBefore > 0) await setSpendCap(capBefore);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const paid = async () => ({
    jobs: await prisma.providerJob.count(),
    ledger: await prisma.costEntry.count(),
  });

  it("phụ đề TẮT → không burn, dữ liệu phụ đề giữ; BẬT lại → trở lại; 0 request", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { scenes: true } });
    expect(project.status).toBe("completed");
    const before = await paid();

    await saveProjectControls(projectId, { subtitles: { enabled: false } });
    const off = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const req = { burnSubtitles: true, target: { width: 1080, height: 1920, fps: 30 } } as unknown as RenderRequest;
    await applyOutputControls(off, project.scenes, req);
    expect(req.burnSubtitles).toBe(false);
    expect((await continueVideo(projectId, { wait: true })).status).toBe("COMPLETED");
    const offDone = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(offDone.subtitlePath && fs.existsSync(toAbsolute(offDone.subtitlePath))).toBeTruthy();

    await saveProjectControls(projectId, { subtitles: { enabled: true, size: "SMALL", position: "BOTTOM", offsetPct: 5, style: "BOX" } });
    const on = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const req2 = { burnSubtitles: true, target: { width: 1080, height: 1920, fps: 30 } } as unknown as RenderRequest;
    await applyOutputControls(on, project.scenes, req2);
    expect(req2.burnSubtitles).toBe(true);
    expect(req2.subtitleLayout?.borderStyle).toBe(3);
    expect((await continueVideo(projectId, { wait: true })).status).toBe("COMPLETED");
    expect(on.renderRecipe).not.toBe((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).renderRecipe);
    expect(await paid()).toEqual(before);
  });

  it("âm lượng lời đọc / nhạc nền / SFX: chỉ render tại máy, 0 TTS", async () => {
    const before = await paid();
    const music = fs.readFileSync(await makeWav(tmp, 220, 3));
    await setBackgroundMusic(projectId, music, "bed.wav");
    await saveProjectControls(projectId, { audio: { narrationVolume: 1.4, normalizeNarration: true, musicVolume: 0.2, duckMusic: true, sfxEnabled: false } });
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { scenes: true } });
    const req = { burnSubtitles: true, target: { width: 1080, height: 1920, fps: 30 }, mixSettings: {} } as unknown as RenderRequest;
    await applyOutputControls(p, p.scenes, req);
    expect(req.musicPath).toBeTruthy();
    expect(req.sceneSfx).toBeUndefined(); // SFX off
    expect(req.voiceMix).toMatchObject({ gain: 1.4, normalize: true });
    expect(req.mixSettings).toMatchObject({ musicGain: 0.2, duckDb: 12 });
    expect((await continueVideo(projectId, { wait: true })).status).toBe("COMPLETED");
    expect(await paid()).toEqual(before);
  });

  it("nghe thử giọng: lần 2 dùng lại ($0); đổi phụ đề/âm lượng không cần TTS; đổi giọng thì cần (và hỏi giá)", async () => {
    const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
    const narrated = scenes.find((s) => sceneCharacters(s).speaking.some(isNarrator))!;
    const again = await makeSceneVoice(narrated.id);
    expect(again.postsMade).toBe(0);
    await saveProjectControls(projectId, { subtitles: { size: "LARGE" }, audio: { narrationVolume: 0.8 } });
    expect((await sceneVoiceStatus(narrated.id)).expectedPosts).toBe(0);
    const r = await saveProjectControls(projectId, { voice: { voiceId: "mock-female-uk", speed: 1.2 } });
    expect(r.voiceChanged).toBe(true);
    const plan = await sceneVoiceStatus(narrated.id);
    expect(plan.expectedPosts).toBeGreaterThan(0);
    const refused = await makeSceneVoice(narrated.id);
    expect(refused.status).toBe("NEEDS_CONFIRMATION");
    expect(refused.postsMade).toBe(0);
  });

  it("xem trước khung hình: đúng kích thước nền tảng, $0", async () => {
    const before = await paid();
    const shot = await subtitlePreviewFrame(projectId, { controls: { subtitles: { advanced: { showSafeArea: true } } } });
    expect(shot).toMatchObject({ width: 1080, height: 1920 });
    expect(fs.existsSync(toAbsolute(shot.path))).toBe(true);
    expect(await paid()).toEqual(before);
  });

  it("dự án cũ (không thiết lập): mặc định an toàn, âm thanh như cũ", async () => {
    const legacy = await prisma.project.findFirst({ where: { contentType: null, outputControlsJson: null }, include: { scenes: true } });
    if (!legacy) return;
    const req = { burnSubtitles: true, target: { width: 1080, height: 1920, fps: 30 }, mixSettings: {} } as unknown as RenderRequest;
    await applyOutputControls(legacy, legacy.scenes, req);
    expect(req.burnSubtitles).toBe(true);
    expect(req.voiceMix).toBeUndefined();
    expect(req.sceneSfx).toBeUndefined();
    expect(req.subtitleLayout?.fontSize).toBe(subtitleLayout(base.subtitles, 1080, 1920).fontSize);
  });
});
