import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import { profileFromPlatform } from "@/domain/platform-profile";
import { MISSING_CLIP_MESSAGE } from "@/domain/user-clip";
import { approveContentScript, createContentProject } from "@/services/content-service";
import { previewProjectCost, startMediaGeneration } from "@/services/project-service";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { generateSceneVideo } from "@/services/generation";
import { sceneInteraction } from "@/services/scene-plan-service";
import { deriveSceneVideoFacts } from "@/services/low-auto-facts";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { assignClipAction, deleteClipAction, unassignClipAction, updateClipSettingsAction, uploadClipForScene } from "@/app/actions/scene-clips";
import { projectClips } from "@/services/uploaded-clip";
import { seedMock } from "./phase5-helpers";

/**
 * UPLOADED VIDEO CLIP through the real pipeline (mock providers, $0): the
 * person's clip is reused, never routed, never bought, never replaced by Video
 * AI - on the first run, on a re-render and on a resume. A lost file stops the
 * scene; it never buys a clip.
 */

let tmp = "";
let capBefore = 0;
let projectId = "";
let sceneIds: string[] = [];
const clips: Record<string, string> = {};

const jobs = (where: Record<string, unknown> = {}) => prisma.providerJob.count({ where: { projectId, ...where } });
const scene = (i: number) => prisma.scene.findUniqueOrThrow({ where: { id: sceneIds[i]! } });
const fileOf = (p: string) => new File([fs.readFileSync(p)], path.basename(p));

async function upload(i: number, file: string) {
  const form = new FormData();
  form.set("sceneId", sceneIds[i]!);
  form.set("file", fileOf(file));
  return uploadClipForScene(form);
}

async function rgbAt(file: string, atSec: number): Promise<[number, number, number]> {
  const raw = path.join(tmp, `px-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg(["-y", "-v", "error", "-ss", String(atSec), "-i", file, "-frames:v", "1", "-vf", "crop=iw:ih*0.6:0:0,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  const b = fs.readFileSync(raw);
  return [b[0]!, b[1]!, b[2]!];
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "user-clip-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  const make = async (name: string, colour: string, extra: string[] = []) => {
    clips[name] = path.join(tmp, name);
    await ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=720x1280:r=30:d=8`, "-f", "lavfi", "-i", "sine=frequency=300:duration=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", ...extra, clips[name]]);
  };
  await make("pour.mp4", "magenta");
  await make("pour-v2.mov", "yellow", ["-f", "mov"]);

  const project = await createContentProject({
    contentType: "TOY_WORLD",
    sourceType: "PROMPT",
    idea: "Cô gái rót nước cho bạn",
    durationSeconds: 30,
    voiceMode: "NARRATION",
    outputProfile: profileFromPlatform("TIKTOK"),
  });
  projectId = project.id;
  const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
  expect(scenes.length).toBeGreaterThanOrEqual(3);
  sceneIds = scenes.map((x) => x.id);
  const words = ["Bầu trời xanh trong", "Cô gái cầm bình và rót nước vào ly", "Cô gái cầm bình và rót nước vào ly lần nữa"];
  for (const [i, x] of scenes.entries()) {
    const text = words[i] ?? "Bầu trời xanh trong";
    await prisma.scene.update({
      where: { id: x.id },
      data: { visualDescription: text, characterAction: text, narration: text, dialogue: "", subtitle: text, imagePrompt: text, referenceIdsJson: "[]", motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" },
    });
  }
  // Scene 3: the same interaction, no clip, an explicit Video AI instruction (S: the AI path stays as it was).
  await prisma.scene.update({ where: { id: sceneIds[2]! }, data: { motionMode: "VIDEO_AI", motionSource: "AI_VIDEO" } });
}, 180_000);

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("UPLOADED VIDEO CLIP - pipeline (mock, $0)", () => {
  it("upload + gán vào cảnh: asset IMPORTED trong thư mục dự án, khung đầu làm keyframe; tải lại cùng file → dùng lại (không trùng)", async () => {
    // Scene 2 even asks for Video AI by hand: the clip still wins.
    await prisma.scene.update({ where: { id: sceneIds[1]! }, data: { motionMode: "VIDEO_AI", motionSource: "AI_VIDEO" } });
    const r = await upload(1, clips["pour.mp4"]!);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Video của bạn.*\$0/);
    const s2 = await scene(1);
    expect(s2).toMatchObject({ videoSource: "UPLOADED", imageSource: "IMPORTED", clipAudio: "OFF" });
    expect(s2.videoPath).toMatch(/^projects[\\/].*[\\/]videos[\\/]upload-.*\.mp4$/); // relative, inside the project
    expect(fs.existsSync(toAbsolute(s2.videoPath!))).toBe(true);
    expect(fs.existsSync(toAbsolute(s2.imagePath!))).toBe(true);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: s2.videoAssetId! } });
    expect(asset).toMatchObject({ kind: "video", source: "IMPORTED", provider: "upload", actualCost: 0 });

    const again = await upload(1, clips["pour.mp4"]!);
    expect(again.message).toMatch(/đã có trong dự án/);
    expect((await projectClips(projectId)).length).toBe(1);
  });

  it("E. cảnh “cầm bình / rót nước” + clip đúng tương tác → USER VIDEO được ưu tiên hơn Video AI; không có clip → vẫn đề xuất như cũ", async () => {
    const s2 = await scene(1);
    const withClip = await sceneInteraction(s2, []);
    expect(withClip).toMatchObject({ interaction: "COMPLEX_INTERACTION", route: "USER_VIDEO", autoPaid: false });
    const without = await sceneInteraction(await scene(2), []);
    expect(without.interaction).toBe("COMPLEX_INTERACTION");
    expect(without.route).not.toBe("USER_VIDEO");
    const facts = deriveSceneVideoFacts(s2, { qualityMode: "QUALITY" });
    expect(facts.motion.source).toBe("LOCAL_MOTION"); // pinned VIDEO_AI or not
    expect(facts.motion.reason).toMatch(/Video của bạn/);
    const preview = await previewProjectCost(projectId);
    const plan = preview.current.scenes.find((p) => p.sceneNumber === 2)!;
    expect(plan).toMatchObject({ mediaSource: "USER_VIDEO", video: null, image: null });
    // Only the scene's voice (and optional QA) is priced - no picture, no clip.
    expect(plan.estimatedCost).toBeCloseTo((plan.voice?.estimatedCost ?? 0) + (plan.quality?.estimatedCost ?? 0), 4);
  });

  it("D + F. chạy thật (mock): render dùng clip của cảnh 2; VIDEO AI / IMAGE POST cho cảnh đó = 0; cảnh Video AI khác vẫn chạy như cũ (S)", async () => {
    await approveContentScript(projectId);
    const started = await startMediaGeneration(projectId);
    await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { scenes: { orderBy: { sceneNumber: "asc" } } } });
    expect(project.status).toBe("completed");
    expect(await jobs({ sceneId: sceneIds[1]!, kind: "video" })).toBe(0);
    expect(await jobs({ sceneId: sceneIds[1]!, kind: "image" })).toBe(0);
    // S: the scene that asked for Video AI (no clip) bought its (mock) clip as before.
    expect(await jobs({ sceneId: sceneIds[2]!, kind: "video" })).toBeGreaterThan(0);
    const s2 = project.scenes[1]!;
    expect(s2.videoSource).toBe("UPLOADED");
    // The final MP4 shows the magenta clip during scene 2.
    const start = project.scenes[0]!.finalDuration ?? project.scenes[0]!.duration;
    const [r, g, b] = await rgbAt(toAbsolute(project.finalVideoPath!), start + 0.6);
    expect(r).toBeGreaterThan(150);
    expect(b).toBeGreaterThan(150);
    expect(g).toBeLessThan(90);
  }, 600_000);

  it("H + I. render lại / resume → dùng lại clip, 0 request", async () => {
    const before = await jobs();
    const s2 = await scene(1);
    expect(await generateSceneVideo(sceneIds[1]!)).toBe(toAbsolute(s2.videoPath!));
    await prisma.project.update({ where: { id: projectId }, data: { status: "failed" } });
    await continueVideo(projectId, { wait: true });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe("completed");
    expect(await jobs()).toBe(before);
    expect((await scene(1)).videoPath).toBe(s2.videoPath);
  }, 600_000);

  it("G. thay clip / chỉnh trim / bật âm thanh → chỉ render lại tại máy: VOICE / IMAGE / VIDEO POST = 0, lời và phụ đề giữ nguyên", async () => {
    const before = { all: await jobs(), voice: await jobs({ kind: "voice" }), image: await jobs({ kind: "image" }) };
    const lines = await prisma.dialogueLine.findMany({ where: { sceneId: sceneIds[1]! }, orderBy: { lineNumber: "asc" } });
    const s2 = await scene(1);
    const r = await upload(1, clips["pour-v2.mov"]!);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Render lại MP4/);
    expect((await updateClipSettingsAction(sceneIds[1]!, { startSec: 1, endSec: 5, audio: "ON", shortMode: "LOOP" })).ok).toBe(true);
    const after = await scene(1);
    expect(after.videoPath).not.toBe(s2.videoPath);
    expect(after).toMatchObject({ subtitle: s2.subtitle, narration: s2.narration, clipStartSec: 1, clipEndSec: 5, clipAudio: "ON", clipShortMode: "LOOP" });
    expect(await prisma.dialogueLine.findMany({ where: { sceneId: sceneIds[1]! }, orderBy: { lineNumber: "asc" } })).toEqual(lines);
    await prisma.project.update({ where: { id: projectId }, data: { status: "failed" } });
    await continueVideo(projectId, { wait: true });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { scenes: { orderBy: { sceneNumber: "asc" } } } });
    expect(project.status).toBe("completed");
    expect(await jobs()).toBe(before.all);
    expect(await jobs({ kind: "voice" })).toBe(before.voice);
    expect(await jobs({ kind: "image" })).toBe(before.image);
    const start = project.scenes[0]!.finalDuration ?? project.scenes[0]!.duration;
    const [r2, g2, b2] = await rgbAt(toAbsolute(project.finalVideoPath!), start + 0.6);
    expect(r2).toBeGreaterThan(150); // yellow now
    expect(g2).toBeGreaterThan(150);
    expect(b2).toBeLessThan(90);
    // Reuse across scenes: the first clip is still in the project and can go on scene 1.
    const first = (await projectClips(projectId)).find((c) => c.asset.originalFilename === "pour.mp4")!;
    expect((await assignClipAction(sceneIds[0]!, first.asset.id)).ok).toBe(true);
    expect((await projectClips(projectId)).find((c) => c.asset.id === first.asset.id)!.usedBy).toEqual([1]);
  }, 600_000);

  it("J. file clip bị mất → báo “Không tìm thấy video nguồn.”, KHÔNG tự gọi Video AI; tải lại đúng file → chạy tiếp", async () => {
    const s2 = await scene(1);
    const abs = toAbsolute(s2.videoPath!);
    const moved = `${abs}.moved`;
    fs.renameSync(abs, moved);
    const before = await jobs();
    await expect(generateSceneVideo(sceneIds[1]!)).rejects.toThrow(MISSING_CLIP_MESSAGE);
    const preview = await previewProjectCost(projectId);
    expect(preview.current.scenes.find((p) => p.sceneNumber === 2)).toMatchObject({ video: null, mediaSource: "USER_VIDEO" });
    await prisma.project.update({ where: { id: projectId }, data: { status: "failed" } });
    await continueVideo(projectId, { wait: true }).catch(() => undefined);
    expect(await jobs()).toBe(before); // nothing bought in its place
    expect((await scene(1)).videoSource).toBe("UPLOADED");
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).not.toBe("completed");

    // "Chọn lại file": the same bytes put the file back.
    fs.copyFileSync(moved, path.join(tmp, "restored.mov"));
    fs.rmSync(moved);
    const r = await upload(1, path.join(tmp, "restored.mov"));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(abs)).toBe(true);
    expect(await generateSceneVideo(sceneIds[1]!)).toBe(abs);
    expect(await jobs()).toBe(before);
  }, 600_000);

  it("xoá clip đang dùng → cảnh báo trước (đang dùng ở X scene); bỏ gán giữ clip trong dự án", async () => {
    const used = (await projectClips(projectId)).find((c) => c.usedBy.includes(1))!;
    const ask = await deleteClipAction(projectId, used.asset.id);
    expect(ask).toMatchObject({ ok: false, confirm: true });
    expect(ask.message).toMatch(/đang được sử dụng ở 1 scene/);
    expect(await prisma.asset.count({ where: { id: used.asset.id } })).toBe(1);
    expect((await unassignClipAction(sceneIds[0]!)).ok).toBe(true);
    expect((await scene(0)).videoSource).toBe("GENERATED");
    expect(await prisma.asset.count({ where: { id: used.asset.id } })).toBe(1);
    const yes = await deleteClipAction(projectId, used.asset.id);
    expect(yes.ok).toBe(true);
  });
});
