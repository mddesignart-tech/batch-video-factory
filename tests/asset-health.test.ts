import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { projectSubdir, toRelative } from "@/lib/paths";
import { fileSha256 } from "@/services/asset-content";
import { assetHealthReport } from "@/services/asset-health";
import { bareProject, ledgerSnapshot, makePng } from "./phase5-helpers";

/** V1.2 Phase 5 - `assets:health` is READ-ONLY and finds each kind of problem (QĐ-113). */

let tmp = "";
let projectId = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5-health-"));
  projectId = (await bareProject("Health")).id;
  const dir = projectSubdir(projectId, "images");
  fs.mkdirSync(dir, { recursive: true });
  const src = await makePng(tmp, "yellow", "32x32");
  const good = path.join(dir, "good.png");
  const tampered = path.join(dir, "tampered.png");
  fs.copyFileSync(src, good);
  fs.copyFileSync(src, tampered);
  const sha = fileSha256(good);
  const key = `reuse:v1:image:${"9".repeat(64)}`;
  const mk = async (name: string, data: Record<string, unknown>) => {
    ids[name] = (
      await prisma.asset.create({
        data: { projectId, kind: "image", provider: "openai", model: "gpt-image-1", status: "completed", filePath: toRelative(good), ...data },
      })
    ).id;
  };
  await mk("dupKey1", { sha256: sha, reuseKey: key, width: 32, height: 32 });
  await mk("dupKey2", { sha256: sha, reuseKey: key, width: 32, height: 32 });
  await mk("missing", { filePath: `projects/${projectId}/images/nope.png` });
  await mk("tampered", { filePath: toRelative(tampered), sha256: sha });
  fs.appendFileSync(tampered, Buffer.from("changed"));
  await prisma.scene.create({ data: { projectId, sceneNumber: 1, duration: 3, imageAssetId: randomUUID(), imagePath: toRelative(good) } });
}, 60_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-113 — assets:health (chỉ đọc)", () => {
  it("phát hiện file thiếu, hash lệch, trùng SHA/khoá, cảnh trỏ asset không tồn tại, asset không tham chiếu", async () => {
    const assetsBefore = await prisma.asset.findMany({ orderBy: { id: "asc" } });
    const ledgerBefore = await ledgerSnapshot();
    const filesBefore = fs.readdirSync(projectSubdir(projectId, "images")).sort();

    const r = await assetHealthReport();
    const has = (check: string, assetId?: string) =>
      r.issues.some((i) => i.check === check && (assetId === undefined || i.assetId === assetId));
    expect(has("missing_file", ids.missing)).toBe(true);
    expect(has("hash_mismatch", ids.tampered)).toBe(true);
    expect(has("duplicate_reuse_key")).toBe(true);
    expect(has("dangling_scene_asset")).toBe(true);
    expect(has("legacy_no_metadata", ids.missing)).toBe(false); // missing is reported as missing, once
    expect(r.orphanCandidates).toBeGreaterThanOrEqual(1);
    expect(r.missing).toBeGreaterThanOrEqual(1);
    expect(r.invalid).toBeGreaterThanOrEqual(1);

    // READ-ONLY: not one row, ledger line or file changed.
    expect(await prisma.asset.findMany({ orderBy: { id: "asc" } })).toEqual(assetsBefore);
    expect(await ledgerSnapshot()).toEqual(ledgerBefore);
    expect(fs.readdirSync(projectSubdir(projectId, "images")).sort()).toEqual(filesBefore);
  });
});
