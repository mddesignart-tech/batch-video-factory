import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DATA_ROOT, ensureProjectDirs, projectSubdir, toAbsolute, toRelative } from "@/lib/paths";
import {
  cleanProjectTemp,
  deleteOutput,
  deleteScene,
  duplicateProject,
  duplicateScene,
  listTrash,
  projectStorage,
  purgeOutput,
  purgeProject,
  purgeScene,
  restoreOutput,
  restoreProject,
  restoreScene,
  trashProjects,
  TrashBlockedError,
} from "@/services/trash-service";
import { checkStoryboard } from "@/services/storyboard-check";
import { ffmpeg, ffmpegAvailable, probeDuration } from "@/media/ffmpeg";
import { runJob } from "@/jobs/handlers";

/**
 * QĐ-152 project & scene management on the TEST database and TEST data folder
 * (tests/test-env.ts) - never the real data. Files are tiny placeholders.
 */

const TAG = `qd152-${Date.now()}`;
const created: string[] = [];
let idiomId = "";

/** Writes a file and returns its DATA-RELATIVE path ("projects/<id>/..."), as the app stores paths. */
function writeFile(p: string, content = "x"): string {
  const abs = toAbsolute(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return toRelative(abs).replace(/\\/g, "/");
}

/** A project with `n` scenes, each with its own picture and one voice line; plus one final video. */
async function makeProject(n: number, opts: { title?: string; texts?: string[] } = {}) {
  const p = await prisma.project.create({ data: { idiomId, title: opts.title ?? `${TAG} project`, status: "completed" } });
  created.push(p.id);
  ensureProjectDirs(p.id);
  for (let i = 1; i <= n; i += 1) {
    const img = writeFile(path.join(projectSubdir(p.id, "images"), `s${i}.png`), `img${i}`);
    const voice = writeFile(path.join(projectSubdir(p.id, "audio"), `line-${i}.wav`), `voice${i}`);
    const text = opts.texts?.[i - 1] ?? `Câu số ${i} về trí tuệ nhân tạo Claude`;
    await prisma.scene.create({
      data: {
        projectId: p.id,
        sceneNumber: i,
        subtitle: text,
        dialogue: `Narrator: ${text}`,
        imagePath: img,
        status: "completed",
        dialogueLines: { create: { lineNumber: 1, text, outputPath: voice, status: "completed", durationSec: 1 } },
      },
    });
  }
  const final = writeFile(path.join(projectSubdir(p.id, "final"), "final_a.mp4"), "video-a");
  await prisma.asset.create({ data: { projectId: p.id, kind: "final", provider: "ffmpeg", model: "libx264", status: "completed", filePath: final } });
  await prisma.project.update({ where: { id: p.id }, data: { finalVideoPath: final, renderRecipe: "r" } });
  return p.id;
}

const live = (projectId: string) => prisma.scene.findMany({ where: { projectId, deletedAt: null }, orderBy: { sceneNumber: "asc" } });

beforeAll(async () => {
  idiomId = (await prisma.idiom.create({ data: { phrase: `${TAG} idiom`, slug: `${TAG}-idiom`, meaning: "m", literalMeaning: "l", exampleSentence: "e", category: "test-qd152" } })).id;
});

afterAll(async () => {
  await prisma.job.deleteMany({ where: { projectId: { in: created } } });
  for (const id of created) {
    await prisma.project.deleteMany({ where: { id } });
    fs.rmSync(path.join(DATA_ROOT, "projects", id), { recursive: true, force: true });
  }
  await prisma.idiom.deleteMany({ where: { id: idiomId } });
});

describe("QĐ-152 scenes: delete (trash), restore, duplicate", () => {
  it("delete first / middle / last keeps the rest 1..N, in order, and marks the video stale", async () => {
    const id = await makeProject(5);
    const before = await live(id);
    await deleteScene(before[0]!.id); // first
    await deleteScene(before[2]!.id); // middle (was 3)
    await deleteScene(before[4]!.id); // last
    const now = await live(id);
    expect(now.map((s) => s.sceneNumber)).toEqual([1, 2]);
    expect(now.map((s) => s.id)).toEqual([before[1]!.id, before[3]!.id]);
    const trashed = await prisma.scene.findMany({ where: { projectId: id, deletedAt: { not: null } } });
    expect(trashed).toHaveLength(3);
    expect(trashed.every((s) => s.skipped && s.sceneNumber < 0)).toBe(true);
    const p = await prisma.project.findUniqueOrThrow({ where: { id } });
    expect(p.status).toBe("media_ready"); // "Storyboard đã thay đổi"
    expect(p.finalVideoPath).not.toBeNull(); // the old video is kept, not overwritten
    // Files are kept for the restore.
    expect(trashed.every((s) => fs.existsSync(toAbsolute(s.imagePath!)))).toBe(true);
  });

  it("restore goes back to its old place; past the end it goes last; a scene skipped before stays skipped", async () => {
    const id = await makeProject(4);
    const s = await live(id);
    await prisma.scene.update({ where: { id: s[1]!.id }, data: { skipped: true } });
    await deleteScene(s[1]!.id);
    await deleteScene(s[3]!.id);
    await restoreScene(s[1]!.id);
    let now = await live(id);
    expect(now.map((x) => x.id)).toEqual([s[0]!.id, s[1]!.id, s[2]!.id]);
    expect(now[1]!.skipped).toBe(true);
    await restoreScene(s[3]!.id, 99);
    now = await live(id);
    expect(now.map((x) => x.id)).toEqual([s[0]!.id, s[1]!.id, s[2]!.id, s[3]!.id]);
    expect(now.map((x) => x.sceneNumber)).toEqual([1, 2, 3, 4]);
    expect(now[3]!.skipped).toBe(false);
    await expect(restoreScene(s[3]!.id)).rejects.toThrow(/không ở trong Thùng rác/);
  });

  it("duplicate: its own id right after the original, same picture / words / voice file; editing the copy leaves the original", async () => {
    const id = await makeProject(3);
    const s = await live(id);
    const r = await duplicateScene(s[1]!.id);
    const now = await live(id);
    expect(now.map((x) => x.sceneNumber)).toEqual([1, 2, 3, 4]);
    expect(now[2]!.id).toBe(r.sceneId);
    expect(now[2]!.imagePath).toBe(s[1]!.imagePath);
    expect(now[2]!.subtitle).toBe(s[1]!.subtitle);
    const lines = await prisma.dialogueLine.findMany({ where: { sceneId: { in: [s[1]!.id, r.sceneId] } } });
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.id)).size).toBe(2);
    expect(new Set(lines.map((l) => l.outputPath)).size).toBe(1);
    await prisma.scene.update({ where: { id: r.sceneId }, data: { subtitle: "đã sửa bản sao" } });
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: s[1]!.id } })).subtitle).toBe(s[1]!.subtitle);
  });

  it("blocked while work is running for the project; permanent delete keeps a picture the duplicate still uses", async () => {
    const id = await makeProject(2);
    const s = await live(id);
    const job = await prisma.job.create({ data: { type: "render_final", projectId: id, status: "processing" } });
    await expect(deleteScene(s[0]!.id)).rejects.toBeInstanceOf(TrashBlockedError);
    await prisma.job.update({ where: { id: job.id }, data: { status: "completed" } });
    const dup = await duplicateScene(s[0]!.id);
    await deleteScene(s[0]!.id);
    const report = await purgeScene(s[0]!.id);
    expect(fs.existsSync(toAbsolute(s[0]!.imagePath!))).toBe(true); // the copy still shows it
    expect(report.keptShared.map((f) => f.replace(/\\/g, "/"))).toContain(s[0]!.imagePath);
    expect(await prisma.scene.findUnique({ where: { id: dup.sceneId } })).not.toBeNull();
    // Scene 2's own picture is not touched either.
    expect(fs.existsSync(toAbsolute(s[1]!.imagePath!))).toBe(true);
  });
});

describe("QĐ-152 video outputs", () => {
  it("delete the current one -> the newest kept one takes over; delete all -> no video; restore; purge removes only that file and its own remix sources", async () => {
    const id = await makeProject(1);
    const b = writeFile(path.join(projectSubdir(id, "final"), "final_b.mp4"), "video-b");
    const assetB = await prisma.asset.create({ data: { projectId: id, kind: "final", provider: "ffmpeg", model: "remix-audio", status: "completed", filePath: b, createdAt: new Date(Date.now() + 1000) } });
    await prisma.project.update({ where: { id }, data: { finalVideoPath: b } });
    // Remix sources: B's manifest names A's dialogue stem.
    const stemA = writeFile(path.join(projectSubdir(id, "audio"), "renders", "final_a", "dialogue.wav"), "stem");
    writeFile(path.join(projectSubdir(id, "audio"), "renders", "final_a", "manifest.json"), JSON.stringify({ dialogue: stemA }));
    writeFile(path.join(projectSubdir(id, "audio"), "renders", "final_b", "manifest.json"), JSON.stringify({ dialogue: stemA }));
    const assetA = await prisma.asset.findFirstOrThrow({ where: { projectId: id, kind: "final", filePath: { endsWith: "final_a.mp4" } } });

    const r1 = await deleteOutput(assetB.id);
    expect(r1.newCurrent).toMatch(/final_a\.mp4$/);
    let p = await prisma.project.findUniqueOrThrow({ where: { id } });
    expect(p.renderRecipe).toBeNull();
    await deleteOutput(assetA.id);
    p = await prisma.project.findUniqueOrThrow({ where: { id } });
    expect(p.finalVideoPath).toBeNull();
    expect(p.status).toBe("media_ready");
    expect((await prisma.scene.count({ where: { projectId: id } }))).toBe(1); // the project is intact
    await restoreOutput(assetB.id);
    expect((await prisma.project.findUniqueOrThrow({ where: { id } })).finalVideoPath).toBe(b);
    // Purge A: its MP4 goes; its dialogue stem stays because B's manifest names it.
    const report = await purgeOutput(assetA.id);
    expect(fs.existsSync(toAbsolute(assetA.filePath))).toBe(false);
    expect(fs.existsSync(toAbsolute(stemA))).toBe(true);
    expect(report.keptShared.map((f) => f.replace(/\\/g, "/"))).toContain(stemA);
    expect(fs.existsSync(toAbsolute(b))).toBe(true);
  });

  it("refused while a remix is queued", async () => {
    const id = await makeProject(1);
    const a = await prisma.asset.findFirstOrThrow({ where: { projectId: id, kind: "final" } });
    await prisma.job.create({ data: { type: "remix_audio", projectId: id, status: "queued" } });
    await expect(deleteOutput(a.id)).rejects.toThrow(/remix_audio/);
  });
});

describe("QĐ-152 projects: trash, restore, duplicate, permanent delete", () => {
  it("trash hides from lists (not from a direct link), cancels waiting jobs, refuses running ones; restore", async () => {
    const a = await makeProject(1, { title: `${TAG} A` });
    const b = await makeProject(1, { title: `${TAG} B` });
    const c = await makeProject(1, { title: `${TAG} C` });
    await prisma.job.create({ data: { type: "render_final", projectId: a, status: "queued" } });
    await prisma.job.create({ data: { type: "render_final", projectId: c, status: "processing" } });
    const r = await trashProjects([a, b, c]);
    expect(r.map((x) => x.ok)).toEqual([true, true, false]);
    const listed = await prisma.project.findMany({ where: { id: { in: [a, b, c] } }, select: { id: true } });
    expect(listed.map((x) => x.id)).toEqual([c]);
    expect(await prisma.project.count({ where: { id: { in: [a, b] } } })).toBe(0);
    expect(await prisma.project.findUnique({ where: { id: a } })).not.toBeNull();
    expect((await prisma.job.findFirstOrThrow({ where: { projectId: a } })).status).toBe("cancelled");
    expect((await listTrash()).projects.map((x) => x.id)).toEqual(expect.arrayContaining([a, b]));
    await restoreProject(b);
    expect(await prisma.project.count({ where: { id: b } })).toBe(1);
    await prisma.job.updateMany({ where: { projectId: c }, data: { status: "completed" } });
  });

  it("duplicate: own ids, files copied into its own folder, no render history; editing / purging the copy never touches the original", async () => {
    const src = await makeProject(3, { title: `${TAG} gốc` });
    // A shared library file (outside every project folder) and a deleted scene.
    const shared = writeFile(path.join("music", `${TAG}-shared.mp3`), "music");
    const music = await prisma.asset.create({ data: { projectId: src, kind: "audio", provider: "import", model: "music", source: "IMPORTED", status: "completed", filePath: shared } });
    await prisma.project.update({ where: { id: src }, data: { backgroundMusicAssetId: music.id, outputControlsJson: JSON.stringify({ motion: { quality: "SMOOTH_V2" } }) } });
    const s0 = await live(src);
    await deleteScene(s0[2]!.id);
    await prisma.job.create({ data: { type: "render_final", projectId: src, status: "completed" } });

    const copy = await duplicateProject(src);
    created.push(copy.id);
    const cp = await prisma.project.findUniqueOrThrow({ where: { id: copy.id }, include: { scenes: { include: { dialogueLines: true } }, assets: true } });
    expect(cp.title).toBe(`${TAG} gốc - Bản sao`);
    expect(cp.finalVideoPath).toBeNull();
    expect(cp.batchId).toBeNull();
    expect(cp.outputControlsJson).toContain("SMOOTH_V2");
    expect(cp.scenes.map((s) => s.sceneNumber).sort()).toEqual([1, 2]); // live scenes only
    expect(cp.scenes.every((s) => s.imagePath!.startsWith(`projects/${copy.id}/`))).toBe(true);
    expect(cp.scenes.every((s) => fs.existsSync(toAbsolute(s.imagePath!)))).toBe(true);
    expect(cp.scenes.flatMap((s) => s.dialogueLines).every((l) => l.outputPath.startsWith(`projects/${copy.id}/`))).toBe(true);
    expect(cp.assets.some((a) => a.kind === "final")).toBe(false);
    const cpMusic = cp.assets.find((a) => a.kind === "audio")!;
    expect(cp.backgroundMusicAssetId).toBe(cpMusic.id);
    expect(cpMusic.filePath).toBe(shared); // a shared library file stays shared
    expect(await prisma.job.count({ where: { projectId: copy.id } })).toBe(0);

    // Edit the copy: the original is unchanged.
    await prisma.scene.update({ where: { id: cp.scenes[0]!.id }, data: { subtitle: "sửa ở bản sao" } });
    expect((await live(src))[0]!.subtitle).toBe(s0[0]!.subtitle);
    // Purge the copy: the original's files and the shared music remain.
    await trashProjects([copy.id]);
    const report = await purgeProject(copy.id);
    expect(report.deletedFiles).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(DATA_ROOT, "projects", copy.id))).toBe(false);
    expect(fs.existsSync(toAbsolute(shared))).toBe(true);
    expect((await live(src)).every((s) => fs.existsSync(toAbsolute(s.imagePath!)))).toBe(true);
    expect(await prisma.project.findUnique({ where: { id: src } })).not.toBeNull();
  });

  it("permanent delete: only from the trash, keeps a file another project still names, never follows a path outside", async () => {
    const a = await makeProject(2, { title: `${TAG} purge` });
    const other = await makeProject(1, { title: `${TAG} other` });
    const sa = await live(a);
    // Another project reuses A's first picture by path.
    await prisma.scene.updateMany({ where: { projectId: other }, data: { imagePath: sa[0]!.imagePath } });
    await expect(purgeProject(a)).rejects.toThrow(/Thùng rác/);
    await trashProjects([a]);
    const report = await purgeProject(a);
    expect(await prisma.project.findUnique({ where: { id: a } })).toBeNull();
    expect(await prisma.scene.count({ where: { projectId: a } })).toBe(0);
    expect(fs.existsSync(toAbsolute(sa[0]!.imagePath!))).toBe(true); // still used by `other`
    expect(fs.existsSync(toAbsolute(sa[1]!.imagePath!))).toBe(false);
    expect(report.keptShared.map((f) => f.replace(/\\/g, "/"))).toContain(sa[0]!.imagePath);
    expect(report.failed).toEqual([]);
  });
});

describe("QĐ-152 storage, temp cleanup, storyboard check", () => {
  it("storage by kind; DỌN FILE TẠM removes temp / .part files only, never a named or source file", async () => {
    const id = await makeProject(2);
    const t1 = writeFile(path.join(projectSubdir(id, "temp"), "norm_001.mp4"), "temp-video");
    const kept = writeFile(path.join(projectSubdir(id, "temp"), "still-used.png"), "used");
    await prisma.scene.updateMany({ where: { projectId: id, sceneNumber: 2 }, data: { videoPath: kept } });
    const part = writeFile(path.join(projectSubdir(id, "images"), "x.png.part"), "partial");
    const st = await projectStorage(id);
    expect(st.ownBytes).toBeGreaterThan(0);
    expect(st.categories.map((c) => c.key)).toEqual(expect.arrayContaining(["images", "audio", "final", "temp"]));
    const r = await cleanProjectTemp(id);
    expect(fs.existsSync(toAbsolute(t1))).toBe(false);
    expect(fs.existsSync(toAbsolute(part))).toBe(false);
    expect(fs.existsSync(toAbsolute(kept))).toBe(true);
    expect(r.keptShared.map((f) => f.replace(/\\/g, "/"))).toContain(kept);
    expect((await live(id)).every((s) => fs.existsSync(toAbsolute(s.imagePath!)))).toBe(true);
  });

  it("check: missing file = structure error; an off-topic scene = word-only hint; deleted scenes are not checked", async () => {
    const id = await makeProject(5, {
      title: `${TAG} Review AI Claude AIVietLab`,
      texts: [
        "Trợ lý AI Claude tự làm việc trên máy tính",
        "Claude mở trình duyệt và làm bảng tính giúp bạn",
        "AIVietLab chấm Claude tám phẩy ba trên mười",
        "Chiếc bình giữ nhiệt inox vàng đồng giữ nóng suốt ngày dài",
        "Bạn sẽ giao việc gì cho AI Claude đầu tiên",
      ],
    });
    const s = await live(id);
    fs.rmSync(toAbsolute(s[1]!.imagePath!));
    let r = await checkStoryboard(id);
    expect(r.issues.some((i) => i.level === "ERROR" && i.code === "FILE_MISSING" && i.sceneNumber === 2)).toBe(true);
    const drift = r.issues.find((i) => i.code === "TOPIC_DRIFT");
    expect(drift?.sceneNumber).toBe(4);
    expect(drift?.level).toBe("INFO");
    expect(drift?.message).toMatch(/chỉ so sánh chữ/);
    await deleteScene(s[3]!.id);
    r = await checkStoryboard(id);
    expect(r.issues.some((i) => i.code === "TOPIC_DRIFT")).toBe(false);
    expect(r.checkedScenes).toBe(4);
    expect(r.issues.some((i) => i.code === "STORYBOARD_CHANGED")).toBe(true);
  });
});

describe("QĐ-152 safety of file removal", () => {
  it("a path naming another project folder is never touched by this project's purge", async () => {
    const a = await makeProject(1, { title: `${TAG} safe-a` });
    const b = await makeProject(1, { title: `${TAG} safe-b` });
    const bScene = (await live(b))[0]!;
    // A's row names B's picture: purging A must not delete B's file.
    await prisma.scene.updateMany({ where: { projectId: a }, data: { videoPath: bScene.imagePath } });
    await trashProjects([a]);
    await purgeProject(a);
    expect(fs.existsSync(toAbsolute(bScene.imagePath!))).toBe(true);
    expect(toRelative(toAbsolute(bScene.imagePath!)).replace(/\\/g, "/")).toBe(bScene.imagePath);
  });
});

describe.skipIf(!ffmpegAvailable())("QĐ-152 render after a delete (real FFmpeg, $0)", () => {
  it("the next render leaves the deleted scene out: shorter video, its words gone from the subtitles", async () => {
    const p = await prisma.project.create({ data: { idiomId, title: `${TAG} render`, status: "media_ready" } });
    created.push(p.id);
    ensureProjectDirs(p.id);
    for (let i = 1; i <= 3; i += 1) {
      const img = toAbsolute(path.join(projectSubdir(p.id, "images"), `s${i}.png`));
      await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=360x640:d=1", "-frames:v", "1", img]);
      const wav = toAbsolute(path.join(projectSubdir(p.id, "audio"), `l${i}.wav`));
      await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${300 + i * 50}:duration=1.5`, "-af", "volume=0.3", "-ar", "24000", "-ac", "1", wav]);
      await prisma.scene.create({
        data: {
          projectId: p.id, sceneNumber: i, duration: 2, subtitle: `Câu riêng ${i} ZXQ${i}`, dialogue: `Narrator: Câu riêng ${i} ZXQ${i}`,
          motionSource: "LOCAL_MOTION", imagePath: toRelative(img), status: "completed",
          dialogueLines: { create: { lineNumber: 1, text: `Câu riêng ${i} ZXQ${i}`, outputPath: toRelative(wav), status: "completed", durationSec: 1.5 } },
        },
      });
    }
    const render = async () => {
      const job = await prisma.job.create({ data: { type: "render_final", projectId: p.id, status: "processing" } });
      await runJob(job);
      await prisma.job.update({ where: { id: job.id }, data: { status: "completed" } });
      const pr = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
      return { video: toAbsolute(pr.finalVideoPath!), srt: fs.readFileSync(toAbsolute(pr.subtitlePath!), "utf8") };
    };
    const full = await render();
    expect(full.srt).toContain("ZXQ2");
    const second = (await live(p.id))[1]!;
    await deleteScene(second.id);
    const after = await render();
    expect(after.video).not.toBe(full.video); // a NEW file - the old one is not overwritten
    expect(fs.existsSync(full.video)).toBe(true);
    expect(after.srt).not.toContain("ZXQ2");
    expect(after.srt).toContain("ZXQ1");
    expect(after.srt).toContain("ZXQ3");
    expect(await probeDuration(after.video)).toBeLessThan((await probeDuration(full.video)) - 1);
  });
});
