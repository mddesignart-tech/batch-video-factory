import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { projectSubdir, toRelative } from "@/lib/paths";
import { fileSha256 } from "@/services/asset-content";
import {
  getAssetDependencies,
  getAssetDependents,
  getAssetDetail,
  getAssetReferences,
  listLibrary,
} from "@/services/asset-library";
import { bareProject, makeMp4, makePng, makeWav } from "./phase5-helpers";

/**
 * V1.2 Phase 5 - asset library, reference graph, detail (QĐ-113).
 * Reads DB + local files only; no provider involved.
 */

let tmp = "";
let projectA = "";
let projectB = "";
const ids: Record<string, string> = {};

function place(projectId: string, src: string, sub: "images" | "videos" | "audio" | "final", name: string): string {
  const dir = projectSubdir(projectId, sub);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  fs.copyFileSync(src, dest);
  return toRelative(dest);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5-library-"));
  projectA = (await bareProject("Library A")).id;
  projectB = (await bareProject("Library B")).id;
  const img = await makePng(tmp, "orange", "64x64");
  const clip = await makeMp4(tmp, "purple");
  const tone = await makeWav(tmp, 330);

  const sceneA1 = await prisma.scene.create({ data: { projectId: projectA, sceneNumber: 1, duration: 3 } });
  const imagePath = place(projectA, img, "images", "master.png");
  const videoPath = place(projectA, clip, "videos", "clip.mp4");
  const audioPath = place(projectA, tone, "audio", "s1-l1.wav");
  const finalPath = place(projectA, clip, "final", "final.mp4");
  await prisma.scene.update({ where: { id: sceneA1.id }, data: { imagePath, videoPath } });
  await prisma.dialogueLine.create({ data: { sceneId: sceneA1.id, lineNumber: 1, text: "Hi.", outputPath: audioPath, status: "completed" } });
  await prisma.project.update({ where: { id: projectA }, data: { finalVideoPath: finalPath } });

  const imgSha = fileSha256(path.join(projectSubdir(projectA, "images"), "master.png"));
  const clipSha = fileSha256(path.join(projectSubdir(projectA, "videos"), "clip.mp4"));

  const image = await prisma.asset.create({
    data: {
      projectId: projectA, sceneId: sceneA1.id, kind: "image", provider: "openai", model: "gpt-image-1",
      filePath: imagePath, sha256: imgSha, bytes: fs.statSync(img).size, width: 64, height: 64,
      reuseKey: `reuse:v1:image:${"1".repeat(64)}`, actualCost: 0.042, status: "completed",
      inputsJson: JSON.stringify({ references: [], characters: ["Max@2"] }),
    },
  });
  ids.image = image.id;
  await prisma.costEntry.create({
    data: { projectId: projectA, sceneId: sceneA1.id, category: "image", provider: "openai", model: "gpt-image-1", amount: 0.042 },
  });
  ids.video = (
    await prisma.asset.create({
      data: {
        projectId: projectA, sceneId: sceneA1.id, kind: "video", provider: "runway", model: "gen4_turbo",
        filePath: videoPath, sha256: clipSha, bytes: fs.statSync(clip).size, durationSec: 1, width: 270, height: 480,
        reuseKey: `reuse:v1:video:${"2".repeat(64)}`, actualCost: 0.25, status: "completed",
        inputsJson: JSON.stringify({ keyframe: imgSha }),
      },
    })
  ).id;
  ids.audio = (
    await prisma.asset.create({
      data: { projectId: projectA, sceneId: sceneA1.id, kind: "audio", provider: "mock", model: "mock-voice-std", filePath: audioPath, status: "completed" },
    })
  ).id;
  ids.final = (
    await prisma.asset.create({
      data: {
        projectId: projectA, kind: "final", provider: "ffmpeg", model: "libx264", filePath: finalPath, status: "completed",
        inputsJson: JSON.stringify({ media: [imgSha, clipSha] }),
      },
    })
  ).id;
  // Project B reuses the picture: a hard link in its own folder, a REUSED row.
  const sceneB1 = await prisma.scene.create({ data: { projectId: projectB, sceneNumber: 1, duration: 3 } });
  const linked = path.join(projectSubdir(projectB, "images"), `reuse-${randomUUID()}.png`);
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.linkSync(path.join(projectSubdir(projectA, "images"), "master.png"), linked);
  await prisma.scene.update({ where: { id: sceneB1.id }, data: { imagePath: toRelative(linked) } });
  ids.reused = (
    await prisma.asset.create({
      data: {
        projectId: projectB, sceneId: sceneB1.id, kind: "image", provider: "openai", model: "gpt-image-1", source: "REUSED",
        filePath: toRelative(linked), sha256: imgSha, bytes: image.bytes, reuseKey: image.reuseKey, reusedFromAssetId: image.id,
        status: "completed",
      },
    })
  ).id;
  // Nobody uses this one.
  ids.orphan = (
    await prisma.asset.create({
      data: {
        projectId: projectA, kind: "image", provider: "openai", model: "gpt-image-1",
        filePath: place(projectA, img, "images", "superseded.png"), sha256: imgSha, status: "completed", actualCost: 0.042,
      },
    })
  ).id;
  ids.legacy = (
    await prisma.asset.create({
      data: {
        projectId: projectA, sceneId: sceneA1.id, kind: "image", provider: "openai", model: "gpt-image-1",
        filePath: imagePath, sha256: imgSha, status: "completed", legacyState: "LEGACY_UNVERIFIED",
        // An OLDER row stored under the same file name as the current picture.
        createdAt: new Date(Date.now() - 60_000),
      },
    })
  ).id;
  ids.missing = (
    await prisma.asset.create({
      data: { projectId: projectA, kind: "video", provider: "runway", model: "gen4_turbo", filePath: `projects/${projectA}/videos/gone.mp4`, status: "completed" },
    })
  ).id;
}, 120_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-113 — thư viện asset + đồ thị tham chiếu", () => {
  it("getAssetReferences: ảnh được cảnh dùng, clip, lời thoại và MP4 cuối đều có tham chiếu", async () => {
    expect((await getAssetReferences(ids.image!)).map((r) => r.kind)).toContain("SCENE_IMAGE");
    expect((await getAssetReferences(ids.video!)).map((r) => r.kind)).toEqual(["SCENE_VIDEO"]);
    expect((await getAssetReferences(ids.audio!)).map((r) => r.kind)).toEqual(["DIALOGUE_LINE"]);
    expect((await getAssetReferences(ids.final!)).map((r) => r.kind)).toEqual(["PROJECT_FINAL"]);
    expect(await getAssetReferences(ids.orphan!)).toEqual([]);
  });

  it("dependents / dependencies: ảnh master → clip → MP4 cuối, và bản dùng lại ở dự án B", async () => {
    const dependents = await getAssetDependents(ids.image!);
    expect(dependents.find((d) => d.assetId === ids.video)?.basis).toBe("RECORDED");
    expect(dependents.find((d) => d.assetId === ids.final)?.note).toMatch(/MP4/);
    expect(dependents.find((d) => d.assetId === ids.reused)?.basis).toBe("REUSE");
    const deps = await getAssetDependencies(ids.video!);
    expect(deps.map((d) => d.assetId)).toContain(ids.image);
    expect((await getAssetDependencies(ids.reused!)).map((d) => d.assetId)).toEqual([ids.image]);
  });

  it("list + filter + health summary", async () => {
    const { rows, summary } = await listLibrary({ projectId: projectA });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids.image!)!.health).toBe("HEALTHY");
    expect(byId.get(ids.orphan!)!.health).toBe("ORPHAN_CANDIDATE");
    expect(byId.get(ids.legacy!)!.health).toBe("LEGACY_UNVERIFIED");
    // The scene uses the bytes of the NEWEST row under that path, not the older one.
    expect(byId.get(ids.legacy!)!.referenceCount).toBe(0);
    expect(byId.get(ids.image!)!.referenceCount).toBeGreaterThan(0);
    expect(byId.get(ids.missing!)!.health).toBe("MISSING");
    expect(byId.get(ids.final!)!.type).toBe("LOCAL");
    expect(byId.get(ids.final!)!.source).toBe("LOCAL");
    expect(summary.missing).toBeGreaterThanOrEqual(1);
    expect(summary.orphanCandidates).toBeGreaterThanOrEqual(1);

    const only = async (f: Parameters<typeof listLibrary>[0]) => (await listLibrary({ projectId: projectA, ...f })).rows.map((r) => r.id);
    expect(await only({ type: "VIDEO" })).toEqual(expect.arrayContaining([ids.video, ids.missing]));
    expect(await only({ type: "VIDEO" })).not.toContain(ids.image);
    expect(await only({ health: "MISSING" })).toEqual([ids.missing]);
    expect(await only({ health: "ORPHAN" })).toContain(ids.orphan);
    expect(await only({ health: "LEGACY" })).toEqual([ids.legacy]);
    expect(await only({ provider: "runway" })).toEqual(expect.arrayContaining([ids.video, ids.missing]));
    expect(await only({ source: "REUSED" })).toEqual([]); // the reuse lives in B
    expect((await listLibrary({ source: "REUSED", projectId: projectB })).rows.map((r) => r.id)).toEqual([ids.reused]);
    expect(await only({ q: ids.video!.slice(0, 8) })).toEqual([ids.video]);
    expect(await only({ reuseScope: "KEYED" })).toEqual(expect.arrayContaining([ids.image, ids.video]));
  });

  it("tiết kiệm API và dung lượng là HAI con số khác nhau", async () => {
    const { summary } = await listLibrary();
    // The reused picture's original price, and its bytes (hard link: stored once).
    expect(summary.apiCostSaved).toBeGreaterThanOrEqual(0.042);
    expect(summary.storageDeduplicatedBytes).toBeGreaterThan(0);
  });

  it("detail: chi phí gốc có bằng chứng sổ chi, dùng lại = $0, phiên bản nhân vật, không lộ đường dẫn tuyệt đối", async () => {
    const d = (await getAssetDetail(ids.image!))!;
    expect(d.originalCost?.amount).toBe(0.042);
    expect(d.originalCost?.costEntryId).not.toBeNull();
    expect(d.incrementalReuseCost).toBe(0);
    expect(d.characterVersions).toEqual(["Max@2"]);
    expect(d.row.filePath.startsWith("projects/")).toBe(true);
    const reused = (await getAssetDetail(ids.reused!))!;
    expect(reused.originalCost?.amount).toBe(0.042); // the ORIGINAL purchase, not a new one
    // Recorded price with no matching ledger line: shown as such, never guessed.
    const orphan = (await getAssetDetail(ids.orphan!))!;
    expect(orphan.originalCost?.evidence).toMatch(/không tìm thấy dòng sổ chi/);
    expect(orphan.row.referenceCount).toBe(0);
  });
});
