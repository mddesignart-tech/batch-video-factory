import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DATA_ROOT, projectSubdir, toRelative } from "@/lib/paths";
import { applyCleanup, planCleanup } from "@/services/asset-cleanup";
import { getAssetDetail } from "@/services/asset-library";
import * as library from "@/services/asset-library";
import { bareProject, makeMp4, makePng } from "./phase5-helpers";

/**
 * V1.2 Phase 5 - safe delete & cleanup policy (QĐ-113).
 * Nothing that was paid for, imported, rendered or is referenced is ever SAFE;
 * only expired temp / interrupted / abandoned-test files are. Dry run deletes 0.
 */

let tmp = "";
let projectId = "";
let busyProjectId = "";
const OLD = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
const files: Record<string, string> = {};
let assetId = "";

function put(dir: string, name: string, src: string | Buffer, old = true): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (typeof src === "string") fs.copyFileSync(src, file);
  else fs.writeFileSync(file, src);
  if (old) fs.utimesSync(file, OLD, OLD);
  return file;
}

const entry = async (file: string) => {
  const rel = path.relative(DATA_ROOT, file).split(path.sep).join("/");
  return (await planCleanup()).entries.find((e) => e.path === rel)!;
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5-delete-"));
  projectId = (await bareProject("Delete safety")).id;
  busyProjectId = (await bareProject("Delete safety busy")).id;
  const png = await makePng(tmp, "white", "16x16");
  const mp4 = await makeMp4(tmp, "black");
  const scene = await prisma.scene.create({ data: { projectId, sceneNumber: 1, duration: 3 } });

  files.imported = put(projectSubdir(projectId, "images"), "import-x.png", png);
  files.clip = put(projectSubdir(projectId, "videos"), "bought.mp4", mp4);
  files.final = put(projectSubdir(projectId, "final"), "final_x.mp4", mp4);
  files.orphanMedia = put(projectSubdir(projectId, "images"), "superseded.png", png);
  files.tempOld = put(projectSubdir(projectId, "temp"), "seg-old.mp4", mp4);
  files.tempNew = put(projectSubdir(projectId, "temp"), "seg-new.mp4", mp4, false);
  files.partial = put(projectSubdir(projectId, "videos"), "clip.mp4.tmp-123.mp4", Buffer.from("partial"));
  files.busyTemp = put(projectSubdir(busyProjectId, "temp"), "in-use.mp4", mp4);

  await prisma.scene.update({ where: { id: scene.id }, data: { imagePath: toRelative(files.imported), videoPath: toRelative(files.clip) } });
  await prisma.project.update({ where: { id: projectId }, data: { finalVideoPath: toRelative(files.final) } });
  assetId = (
    await prisma.asset.create({
      data: {
        projectId, sceneId: scene.id, kind: "image", provider: "import", model: "upload", source: "IMPORTED",
        filePath: toRelative(files.imported), status: "completed",
      },
    })
  ).id;
  await prisma.job.create({ data: { type: "render_final", projectId: busyProjectId, status: "processing", payloadJson: "{}" } });
}, 60_000);

afterAll(async () => {
  await prisma.job.deleteMany({ where: { projectId: busyProjectId } });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-113 — chính sách xoá an toàn", () => {
  it("không có hàm/nút xoá cứng asset; asset đang dùng báo số tham chiếu", async () => {
    expect(Object.keys(library).filter((k) => /delete|remove|purge/i.test(k))).toEqual([]);
    const d = (await getAssetDetail(assetId))!;
    expect(d.row.referenceCount).toBeGreaterThan(0);
    expect(d.row.orphan).toBe(false);
  });

  it("ảnh nhập, clip đã mua, MP4 cuối (kể cả đã 30 ngày) → PROTECTED", async () => {
    for (const k of ["imported", "clip", "final"]) {
      const e = await entry(files[k]!);
      expect(e.action).toBe("PROTECTED");
    }
  });

  it("media không còn ai dùng → ORPHAN_CANDIDATE (giữ lại), không phải SAFE", async () => {
    expect((await entry(files.orphanMedia!)).action).toBe("ORPHAN_CANDIDATE");
  });

  it("file tạm hết hạn / file dở dang cũ → SAFE; file tạm mới hoặc của dự án đang chạy → PROTECTED", async () => {
    expect((await entry(files.tempOld!)).action).toBe("SAFE");
    expect((await entry(files.partial!)).action).toBe("SAFE");
    expect((await entry(files.tempNew!)).action).toBe("PROTECTED");
    expect((await entry(files.busyTemp!)).action).toBe("PROTECTED");
  });

  it("chạy thử không xoá gì; --apply chỉ xoá file SAFE", async () => {
    const plan = await planCleanup();
    expect(plan.bytesReclaimable).toBe(plan.safe.reduce((n, e) => n + e.bytes, 0));
    for (const f of Object.values(files)) expect(fs.existsSync(f)).toBe(true); // planning deleted nothing

    const done = await applyCleanup(plan);
    expect(done.deleted).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(files.tempOld!)).toBe(false);
    expect(fs.existsSync(files.partial!)).toBe(false);
    for (const k of ["imported", "clip", "final", "orphanMedia", "tempNew", "busyTemp"]) {
      expect(fs.existsSync(files[k]!)).toBe(true);
    }
  });
});
