import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { projectDir, toAbsolute } from "@/lib/paths";
import { cancelProjectJobs } from "@/jobs/queue";
import { approveAndRun, renderProjectNow } from "@/services/batch-executor";
import { fileSha256 } from "@/services/asset-content";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { listLibrary } from "@/services/asset-library";
import { applyCleanup, planCleanup } from "@/services/asset-cleanup";
import { importFolder, makePng, seedMock, writeStoryboard } from "./phase5-helpers";

/**
 * V1.2 Phase 5 - cross-project reuse safety and delete safety (QĐ-113).
 *
 * A makes/imports the assets, B reuses them (GLOBAL). Deleting A - even its
 * whole folder - leaves B renderable with the same bytes and no new POST.
 * Deleting B then leaves its files as ORPHAN_CANDIDATE: reported, never removed.
 */

let tmp = "";
let capBefore = 0;
let scopeBefore: string | undefined;
let A = { batchId: "", projectId: "" };
let B = { batchId: "", projectId: "" };
let bHashes: Map<string, string>;

const deleteProject = async (id: string) => {
  // What the "Xoá dự án" action does (src/app/actions/projects.ts).
  await cancelProjectJobs(id);
  await prisma.project.delete({ where: { id } });
};

beforeAll(async () => {
  scopeBefore = process.env.ASSET_REUSE_SCOPE;
  process.env.ASSET_REUSE_SCOPE = "GLOBAL";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5-cross-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  const red = fs.readFileSync(await makePng(tmp, "red"));
  const root = writeStoryboard(tmp, "sb-cross", "p5-cross-reuse", [
    { image: { file: "a.png", bytes: red }, motion: "LOCAL_MOTION", line: "Cross one." },
    { motion: "VIDEO_AI", line: "Cross two.", prompt: "Max waves at a plain teal wall." },
  ]);
  A = await importFolder(root, "cross-A");
  await approveAndRun({ batchId: A.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
  expect((await prisma.project.findUniqueOrThrow({ where: { id: A.projectId } })).status).toBe("completed");
  B = await importFolder(root, "cross-B");
  await approveAndRun({ batchId: B.batchId, maxBatch: 0.01, lowAutoApproved: true, wait: true });
  expect((await prisma.project.findUniqueOrThrow({ where: { id: B.projectId } })).status).toBe("completed");
}, 900_000);

afterAll(async () => {
  process.env.ASSET_REUSE_SCOPE = scopeBefore;
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-113 — reuse xuyên dự án an toàn khi xoá", () => {
  it("B dùng lại asset của A: file riêng trong thư mục B (hard link), không trỏ vào thư mục A", async () => {
    const bJobs = await prisma.providerJob.count({ where: { projectId: B.projectId } });
    expect(bJobs).toBe(0);
    const bAssets = await prisma.asset.findMany({ where: { projectId: B.projectId, kind: { in: ["image", "video", "audio"] } } });
    expect(bAssets.length).toBeGreaterThan(0);
    const aDir = projectDir(A.projectId).split(path.sep).join("/");
    bHashes = new Map();
    for (const a of bAssets) {
      expect(a.filePath.startsWith(`projects/${B.projectId}/`)).toBe(true);
      expect(toAbsolute(a.filePath).split(path.sep).join("/").startsWith(aDir)).toBe(false);
      bHashes.set(a.id, fileSha256(toAbsolute(a.filePath)));
    }
    const reused = bAssets.filter((a) => a.source === "REUSED");
    expect(reused.length).toBeGreaterThan(0);
    // NTFS hard link: one set of bytes, two names.
    expect(reused.some((a) => fs.statSync(toAbsolute(a.filePath)).nlink >= 2)).toBe(true);
  });

  it("SAME_RENDER_INPUT: render lại B khi không có gì đổi → không render, không tạo asset final mới", async () => {
    const before = await prisma.project.findUniqueOrThrow({ where: { id: B.projectId } });
    expect(before.renderRecipe).toMatch(/^recipe:r1:/);
    const finals = await prisma.asset.count({ where: { projectId: B.projectId, kind: "final" } });
    const mtime = fs.statSync(toAbsolute(before.finalVideoPath!)).mtimeMs;
    await renderProjectNow(B.projectId);
    expect(await prisma.asset.count({ where: { projectId: B.projectId, kind: "final" } })).toBe(finals);
    expect(fs.statSync(toAbsolute(before.finalVideoPath!)).mtimeMs).toBe(mtime);
    const log = await prisma.logEntry.findFirst({ where: { projectId: B.projectId, event: "render.same_input" } });
    expect(log).not.toBeNull();
  });

  it("xoá dự án A (cả thư mục) → B vẫn render được, hash không đổi, không POST mới", async () => {
    const jobsBefore = await prisma.providerJob.count();
    const costBefore = await prisma.costEntry.count();
    const aFolder = projectDir(A.projectId);
    await deleteProject(A.projectId);
    fs.rmSync(aFolder, { recursive: true, force: true }); // worst case: the files go too

    for (const [id, sha] of bHashes) {
      const a = await prisma.asset.findUniqueOrThrow({ where: { id } });
      expect(fs.existsSync(toAbsolute(a.filePath))).toBe(true);
      expect(fileSha256(toAbsolute(a.filePath))).toBe(sha);
    }
    // The final MP4 goes missing too -> rendered again, locally, $0.
    const b = await prisma.project.findUniqueOrThrow({ where: { id: B.projectId } });
    fs.rmSync(toAbsolute(b.finalVideoPath!));
    await renderProjectNow(B.projectId);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: B.projectId } });
    expect(after.status).toBe("completed");
    expect(fs.existsSync(toAbsolute(after.finalVideoPath!))).toBe(true);
    expect(await prisma.providerJob.count()).toBe(jobsBefore);
    expect(await prisma.costEntry.count()).toBe(costBefore);
    // The library still sees B's assets as used and healthy.
    const { rows } = await listLibrary({ projectId: B.projectId });
    expect(rows.filter((r) => r.type !== "LOCAL").every((r) => r.referenceCount > 0 && r.health === "HEALTHY")).toBe(true);
  });

  it("xoá tiếp B → file còn lại là ORPHAN_CANDIDATE, KHÔNG bị tự xoá cứng", async () => {
    const bFolder = projectDir(B.projectId);
    const files = fs.readdirSync(path.join(bFolder, "images"));
    await deleteProject(B.projectId);
    const plan = await planCleanup();
    const mine = plan.entries.filter((e) => e.path.startsWith(`projects/${B.projectId}/`));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((e) => e.action === "SAFE" && e.category !== "TEMP")).toBe(false);
    expect(mine.filter((e) => /\.(png|mp4|wav)$/.test(e.path)).every((e) => e.action === "ORPHAN_CANDIDATE")).toBe(true);
    await applyCleanup(plan);
    expect(fs.readdirSync(path.join(bFolder, "images"))).toEqual(files);
  });
});
