import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

/**
 * This file gets a database of its own.
 *
 * `backfillLegacyAssets` scans EVERY asset row (SHA-256 + ffprobe per file), and
 * it runs three times here. On the suite's shared database that is every asset
 * every earlier test file left behind: late in a full run the scan outgrew the
 * hook's 120 s, while the file alone took 5 s. With its own empty schema the
 * scan sees only the rows built below, whatever ran first. Test-only: the
 * service still reads `@/lib/prisma`, it is simply handed this client.
 */
vi.mock("@/lib/prisma", async () => {
  const { execFileSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { PrismaClient } = await import("@prisma/client");
  const { ROOT, TEST_DATA } = await import("./test-env");
  const db = nodePath.join(TEST_DATA, `asset-backfill-${process.pid}.db`);
  nodeFs.rmSync(db, { force: true });
  const url = `file:${nodePath.relative(nodePath.join(ROOT, "prisma"), db).split(nodePath.sep).join("/")}?socket_timeout=60`;
  execFileSync(
    process.execPath,
    [createRequire(import.meta.url).resolve("prisma/build/index.js"), "db", "push", "--skip-generate", "--accept-data-loss"],
    { cwd: ROOT, stdio: "pipe", env: { ...process.env, DATABASE_URL: url } },
  );
  return { prisma: new PrismaClient({ datasources: { db: { url } } }) };
});
import { projectSubdir, toRelative } from "@/lib/paths";
import { backfillLegacyAssets } from "@/services/asset-backfill";
import { fileSha256 } from "@/services/asset-content";
import { voiceReuseKey } from "@/services/asset-keys";
import { findReusableAsset, reusableKeys } from "@/services/asset-reuse";
import { bareProject, ledgerSnapshot, makeMp4, makePng, makeWav } from "./phase5-helpers";

/**
 * V1.2 Phase 5 - legacy backfill (QĐ-113), cases A-J of the brief.
 * Rows are built by hand in the pre-Phase-4 shape: no reuse key, no hash.
 */

let tmp = "";
let projectId = "";
const ids: Record<string, string> = {};

function place(src: string, sub: "images" | "videos" | "audio", name: string): string {
  const dir = projectSubdir(projectId, sub);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  fs.copyFileSync(src, dest);
  return toRelative(dest);
}

async function legacyAsset(key: string, data: { kind: string; provider: string; model: string; filePath: string; prompt?: string; sceneId?: string; bytes?: number; createdAt?: Date }) {
  const a = await prisma.asset.create({
    data: {
      projectId,
      sceneId: data.sceneId ?? null,
      kind: data.kind,
      provider: data.provider,
      model: data.model,
      prompt: data.prompt ?? "",
      filePath: data.filePath,
      bytes: data.bytes ?? 0,
      actualCost: 0.01,
      status: "completed",
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
  ids[key] = a.id;
  return a;
}

const rowOf = (r: Awaited<ReturnType<typeof backfillLegacyAssets>>, key: string) => r.rows.find((x) => x.assetId === ids[key])!;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5-backfill-"));
  const project = await bareProject("Legacy backfill");
  projectId = project.id;
  const scene = await prisma.scene.create({ data: { projectId, sceneNumber: 1, duration: 3 } });

  const red = await makePng(tmp, "red", "64x64");
  const blue = await makePng(tmp, "blue", "64x64");
  const tone = await makeWav(tmp, 440);
  const tone2 = await makeWav(tmp, 660);
  const clip = await makeMp4(tmp, "green");

  // A: a real-provider voice line whose DialogueLine recorded every key input.
  const audioPath = place(tone, "audio", "s1-l1-max.wav");
  await prisma.dialogueLine.create({
    data: {
      sceneId: scene.id,
      lineNumber: 1,
      text: "Break a leg!",
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voiceId: "ash",
      instructions: "Warm.",
      speed: 1,
      outputPath: audioPath,
      status: "completed",
    },
  });
  await legacyAsset("audioOk", { kind: "audio", provider: "openai", model: "gpt-4o-mini-tts", filePath: audioPath, prompt: "Break a leg!", sceneId: scene.id });

  // An OLDER row for the same file name, whose bytes were overwritten since.
  await legacyAsset("audioOverwritten", {
    kind: "audio", provider: "openai", model: "gpt-4o-mini-tts", filePath: audioPath, prompt: "Break a leg!", sceneId: scene.id,
    bytes: 999_999, createdAt: new Date(Date.now() - 60_000),
  });

  // B: a picture - references / character versions were never recorded.
  await legacyAsset("image", { kind: "image", provider: "openai", model: "gpt-image-1", filePath: place(red, "images", "legacy-red.png"), sceneId: scene.id });
  await legacyAsset("video", { kind: "video", provider: "runway", model: "gen4_turbo", filePath: place(clip, "videos", "legacy.mp4"), sceneId: scene.id });

  // G: gone from disk.
  await legacyAsset("missing", { kind: "image", provider: "openai", model: "gpt-image-1", filePath: `projects/${projectId}/images/never-there.png` });

  // H: bytes that are not media at all.
  const junk = path.join(tmp, "junk.mp4");
  fs.writeFileSync(junk, Buffer.from("this is not an mp4 file at all"));
  await legacyAsset("corrupt", { kind: "video", provider: "runway", model: "gen4_turbo", filePath: place(junk, "videos", "corrupt.mp4") });

  // I: same bytes, two names.  J: same name, different bytes (another folder).
  await legacyAsset("twinA", { kind: "image", provider: "openai", model: "gpt-image-1", filePath: place(blue, "images", "twin-a.png") });
  await legacyAsset("twinB", { kind: "image", provider: "openai", model: "gpt-image-1", filePath: place(blue, "images", "twin-b.png") });
  const otherDir = path.join(projectSubdir(projectId, "images"), "other");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.copyFileSync(tone2, path.join(otherDir, "same-name.wav"));
  fs.copyFileSync(tone, path.join(projectSubdir(projectId, "audio"), "same-name.wav"));
  await legacyAsset("nameA", { kind: "audio", provider: "mock", model: "mock-voice-std", filePath: toRelative(path.join(otherDir, "same-name.wav")) });
  await legacyAsset("nameB", { kind: "audio", provider: "mock", model: "mock-voice-std", filePath: toRelative(path.join(projectSubdir(projectId, "audio"), "same-name.wav")) });
}, 120_000);

afterAll(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  // The private database file is left for the run folder's own teardown.
  await prisma.$disconnect();
});

describe("QĐ-113 — backfill asset cũ", () => {
  let first: Awaited<ReturnType<typeof backfillLegacyAssets>>;
  let ledgerBefore: Awaited<ReturnType<typeof ledgerSnapshot>>;
  let assetCountBefore = 0;

  beforeAll(async () => {
    ledgerBefore = await ledgerSnapshot();
    assetCountBefore = await prisma.asset.count();
    const dry = await backfillLegacyAssets({ apply: false });
    // Only this file's rows - no other test file's assets reach the scan.
    expect(dry.scanned).toBe(Object.keys(ids).length);
    expect(rowOf(dry, "audioOk").action).toBe("UPDATED");
    // A dry run writes nothing.
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: ids.audioOk } })).sha256).toBeNull();
    first = await backfillLegacyAssets({ apply: true });
  }, 120_000);

  it("A: asset cũ đủ bằng chứng → dựng lại reuse key (audio v2) từ DialogueLine", async () => {
    const a = await prisma.asset.findUniqueOrThrow({ where: { id: ids.audioOk } });
    const expected = voiceReuseKey({ provider: "openai", model: "gpt-4o-mini-tts", text: "Break a leg!", voiceId: "ash", instructions: "Warm.", speed: 1 });
    expect(a.reuseKey).toBe(expected);
    expect(a.reuseKey).toMatch(/^reuse:v2:audio:/);
    expect(a.legacyState).toBe("LEGACY_BACKFILLED");
    expect(a.sha256).toBe(fileSha256(path.join(projectSubdir(projectId, "audio"), "s1-l1-max.wav")));
    expect(a.durationSec).toBeGreaterThan(0.9);
    expect(a.mimeType).toBe("audio/wav");
    expect(rowOf(first, "audioOk").keyed).toBe("BACKFILLED");
    // Now findable by that key - the evidence is complete.
    const found = await findReusableAsset({ reuseKey: expected, projectId, sceneId: a.sceneId });
    expect(found.status).toBe("REUSE");
  });

  it("B: thiếu bằng chứng prompt/tham chiếu → LEGACY_UNVERIFIED, không bịa khoá, không suy provider/model", async () => {
    for (const k of ["image", "video"]) {
      const a = await prisma.asset.findUniqueOrThrow({ where: { id: ids[k] } });
      expect(a.legacyState).toBe("LEGACY_UNVERIFIED");
      expect(a.reuseKey).toBeNull();
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.validity).toBe("VALID");
    }
    const img = await prisma.asset.findUniqueOrThrow({ where: { id: ids.image } });
    expect(img.provider).toBe("openai"); // as recorded - unchanged
    expect(img.width).toBe(64);
    // LEGACY_UNVERIFIED has no key: no key lookup can ever return it.
    expect((await reusableKeys([img.sha256!])).size).toBe(0);
  });

  it("C: chạy lần 2 → 0 thay đổi", async () => {
    const second = await backfillLegacyAssets({ apply: true });
    expect(second.updated).toBe(0);
    expect(second.backfilled).toBe(0);
    expect(second.rows.filter((r) => Object.values(ids).includes(r.assetId)).every((r) => r.action === "UNCHANGED")).toBe(true);
  });

  it("D + E + F: sổ chi, ProviderJob, reservation không đổi; số asset không tăng", async () => {
    expect(await ledgerSnapshot()).toEqual(ledgerBefore);
    expect(await prisma.asset.count()).toBe(assetCountBefore);
  });

  it("G: file cũ đã mất → MISSING_LOCAL_FILE", async () => {
    const a = await prisma.asset.findUniqueOrThrow({ where: { id: ids.missing } });
    expect(a.validity).toBe("MISSING_LOCAL_FILE");
    expect(a.legacyState).toBe("LEGACY_UNVERIFIED");
  });

  it("G': dòng cũ cùng tên file đã bị ghi đè → MISSING, không nhận byte của asset mới", async () => {
    const a = await prisma.asset.findUniqueOrThrow({ where: { id: ids.audioOverwritten } });
    expect(a.validity).toBe("MISSING_LOCAL_FILE");
    expect(a.sha256).toBeNull();
    expect(a.reuseKey).toBeNull();
  });

  it("H: media hỏng → INVALID", async () => {
    const a = await prisma.asset.findUniqueOrThrow({ where: { id: ids.corrupt } });
    expect(a.validity).toBe("INVALID");
    expect(rowOf(first, "corrupt").reason).toMatch(/hỏng/);
  });

  it("I: cùng SHA khác tên file → nhận ra là cùng nội dung", async () => {
    const [a, b] = await Promise.all([
      prisma.asset.findUniqueOrThrow({ where: { id: ids.twinA } }),
      prisma.asset.findUniqueOrThrow({ where: { id: ids.twinB } }),
    ]);
    expect(a.sha256).toBe(b.sha256);
    expect(first.contentDuplicateGroups).toBeGreaterThanOrEqual(1);
  });

  it("J: cùng tên file khác SHA → KHÔNG gộp", async () => {
    const [a, b] = await Promise.all([
      prisma.asset.findUniqueOrThrow({ where: { id: ids.nameA } }),
      prisma.asset.findUniqueOrThrow({ where: { id: ids.nameB } }),
    ]);
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.id).not.toBe(b.id);
    expect(first.sameNameDifferentContent).toBeGreaterThanOrEqual(1);
    // A MOCK voice line's key depends on a scene length never recorded.
    expect(a.legacyState).toBe("LEGACY_UNVERIFIED");
  });
});
