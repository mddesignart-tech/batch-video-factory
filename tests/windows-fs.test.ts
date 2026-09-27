import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DATA_ROOT, projectSubdir, toRelative } from "@/lib/paths";
import { linkOrCopyVerified } from "@/lib/safe-link";
import { fileSha256 } from "@/services/asset-content";
import { attachReusedAsset } from "@/services/asset-reuse";
import { bareProject, makePng } from "./phase5-helpers";

/**
 * V1.2 Phase 5 - Windows file system behaviour of reuse links (QĐ-113):
 * hard link, safe fallbacks, Unicode / Vietnamese / space paths, a file held by
 * another process. A fallback must never leave a row pointing at nothing.
 */

let tmp = "";
let src = "";
let sha = "";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(DATA_ROOT, "p5-winfs-"));
  src = await makePng(tmp, "red", "16x16");
  sha = fileSha256(src);
}, 60_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const err = (code: string) => Object.assign(new Error(code), { code });

describe("QĐ-113 — Windows filesystem", () => {
  it("NTFS hard link thành công (cùng ổ): một bộ byte, hai tên", async () => {
    const dest = path.join(tmp, "linked.png");
    expect((await linkOrCopyVerified(src, dest)).method).toBe("hardlink");
    expect(fs.statSync(dest).ino).toBe(fs.statSync(src).ino);
    expect(fileSha256(dest)).toBe(sha);
  });

  it("hard link bị từ chối (EPERM / FAT) → sao chép an toàn, đã kiểm hash", async () => {
    const dest = path.join(tmp, "copied.png");
    const r = await linkOrCopyVerified(src, dest, { link: () => { throw err("EPERM"); } });
    expect(r.method).toBe("copy");
    expect(fileSha256(dest)).toBe(sha);
  });

  it("khác ổ đĩa (EXDEV) → sao chép; và thật sự khác ổ khi thư mục tạm của hệ thống nằm ổ khác", async () => {
    const dest = path.join(tmp, "xvol.png");
    expect((await linkOrCopyVerified(src, dest, { link: () => { throw err("EXDEV"); } })).method).toBe("copy");
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "p5-xvol-"));
    try {
      const realDest = path.join(other, "x.png");
      const r = await linkOrCopyVerified(src, realDest);
      const sameVolume = path.parse(os.tmpdir()).root.toLowerCase() === path.parse(src).root.toLowerCase();
      expect(r.method).toBe(sameVolume ? "hardlink" : "copy");
      expect(fileSha256(realDest)).toBe(sha);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("đường dẫn Unicode / tiếng Việt / có dấu cách", async () => {
    const dir = path.join(tmp, "Thư mục ảnh — cảnh 1 ✓");
    fs.mkdirSync(dir, { recursive: true });
    const viSrc = path.join(dir, "ảnh gốc số 1.png");
    fs.copyFileSync(src, viSrc);
    const dest = path.join(dir, "bản dùng lại (Max) 🎬.png");
    expect((await linkOrCopyVerified(viSrc, dest)).method).toBe("hardlink");
    expect(fileSha256(dest)).toBe(sha);
  });

  it("file đang bị tiến trình khác giữ (EBUSY) → thử lại rồi thành công", async () => {
    const dest = path.join(tmp, "busy.png");
    let calls = 0;
    const r = await linkOrCopyVerified(src, dest, {
      link: () => { throw err("EPERM"); },
      copy: (a, b) => {
        calls += 1;
        if (calls < 3) throw err("EBUSY");
        fs.copyFileSync(a, b);
      },
      retryDelayMs: 5,
    });
    expect(r.method).toBe("copy");
    expect(calls).toBe(3);
  });

  it("vẫn bị khoá mãi / bản sao sai byte → lỗi, không để lại file dở", async () => {
    const dest = path.join(tmp, "locked.png");
    await expect(
      linkOrCopyVerified(src, dest, { link: () => { throw err("EPERM"); }, copy: () => { throw err("EBUSY"); }, retries: 2, retryDelayMs: 1 }),
    ).rejects.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
    const bad = path.join(tmp, "bad.png");
    await expect(
      linkOrCopyVerified(src, bad, { link: () => { throw err("EPERM"); }, copy: (_a, b) => fs.writeFileSync(b, "wrong"), retries: 0 }),
    ).rejects.toThrow();
    expect(fs.existsSync(bad)).toBe(false);
  });

  it("antivirus/file watcher trễ: file đích biến mất ngay sau link → sao chép lại, không ghi DB trỏ vào file không tồn tại", async () => {
    const dest = path.join(tmp, "watcher.png");
    const r = await linkOrCopyVerified(src, dest, {
      link: (a, b) => {
        fs.linkSync(a, b);
        fs.rmSync(b); // quarantined right after it appeared
      },
    });
    expect(r.method).toBe("copy");
    expect(fileSha256(dest)).toBe(sha);
  });

  it("attachReusedAsset: nguồn sai byte → ném lỗi TRƯỚC khi ghi DB; không có dòng nào trỏ vào file không tồn tại", async () => {
    const a = await bareProject("WinFS A");
    const b = await bareProject("WinFS B");
    const sceneB = await prisma.scene.create({ data: { projectId: b.id, sceneNumber: 1, duration: 3 } });
    const dir = projectSubdir(a.id, "images");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "src.png");
    fs.copyFileSync(src, file);
    const source = await prisma.asset.create({
      data: {
        projectId: a.id, kind: "image", provider: "mock", model: "mock-image-fast", status: "completed",
        filePath: toRelative(file), sha256: "0".repeat(64), reuseKey: `reuse:v1:image:${"7".repeat(64)}`, bytes: fs.statSync(file).size,
      },
    });
    await expect(attachReusedAsset({ source, projectId: b.id, sceneId: sceneB.id, scope: "GLOBAL" })).rejects.toThrow();
    expect(await prisma.asset.count({ where: { projectId: b.id } })).toBe(0);
    const bImages = projectSubdir(b.id, "images");
    expect(fs.existsSync(bImages) ? fs.readdirSync(bImages) : []).toEqual([]);
  });
});
