import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { probeDuration } from "@/media/ffmpeg";
import { fileSha256 } from "@/services/asset-content";
import { ensureThumbnail, thumbnailKey } from "@/services/output-export";
import { makeMp4 } from "./phase5-helpers";

/**
 * V1.2 Phase 5 - thumbnails are keyed by the SOURCE's content and drawn locally
 * with FFmpeg; an unchanged, intact thumbnail is never drawn again (QĐ-113).
 */

let tmp = "";
let red = "";
let blue = "";
let out = "";
let jobsBefore = 0;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5-thumb-"));
  red = await makeMp4(tmp, "red", 2);
  blue = await makeMp4(tmp, "blue", 2);
  out = path.join(tmp, "out", "thumbnail.jpg");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  jobsBefore = await prisma.providerJob.count();
}, 60_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const draw = async (source: string) => ensureThumbnail({ source, output: out, duration: await probeDuration(source) });

describe("QĐ-113 — tái dùng thumbnail", () => {
  it("khoá gồm hash nội dung nguồn + vị trí khung + bộ lọc + phiên bản", () => {
    const k = thumbnailKey("a".repeat(64), 1);
    expect(k).toMatch(/^thumb:t1:a{64}:1\.000:scale=540:-2$/);
    expect(thumbnailKey("b".repeat(64), 1)).not.toBe(k);
  });

  it("A: cùng nguồn + cùng cài đặt → không vẽ lại (file không đổi)", async () => {
    expect((await draw(red)).reused).toBe(false);
    const sha = fileSha256(out);
    const mtime = fs.statSync(out).mtimeMs;
    const again = await draw(red);
    expect(again.reused).toBe(true);
    expect(fs.statSync(out).mtimeMs).toBe(mtime);
    expect(fileSha256(out)).toBe(sha);
  });

  it("B: nguồn đổi → vẽ lại tại máy", async () => {
    const before = fileSha256(out);
    expect((await draw(blue)).reused).toBe(false);
    expect(fileSha256(out)).not.toBe(before);
  });

  it("C: thumbnail mất → vẽ lại tại máy", async () => {
    fs.rmSync(out);
    expect((await draw(blue)).reused).toBe(false);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("D: thumbnail hỏng → vẽ lại tại máy", async () => {
    fs.writeFileSync(out, Buffer.from("not a jpeg"));
    expect((await draw(blue)).reused).toBe(false);
    expect(fs.statSync(out).size).toBeGreaterThan(100);
    expect((await draw(blue)).reused).toBe(true);
  });

  it("vẽ song song cùng một thumbnail không để lại file tạm; API POST = 0", async () => {
    fs.rmSync(out);
    await Promise.all([draw(red), draw(red), draw(red)]);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readdirSync(path.dirname(out)).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect((await draw(red)).reused).toBe(true);
    expect(await prisma.providerJob.count()).toBe(jobsBefore);
  });
});
