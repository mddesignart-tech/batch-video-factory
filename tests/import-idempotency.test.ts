import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  materialiseImport,
  scanImportSource,
  validateImport,
} from "@/services/storyboard-import";

/**
 * Importing the same storyboard twice.
 *
 * Re-importing is not an edge case; it is the ordinary way an operator fixes a
 * typo. So the question is not whether it happens but what it costs, and the
 * answer has to be: nothing it should not.
 *
 * ## What is shared, and what is not
 *
 * A CHARACTER is a person, and a person is shared across every import that
 * names them. So is their reference image. Those must never duplicate.
 *
 * A PROJECT is a piece of work, and the second import is a second piece of
 * work - possibly with the scene text corrected, which is the whole reason for
 * doing it. So it gets its own project, its own scenes, and its own batch. That
 * is deliberate, and the thing that makes it honest rather than confusing is
 * the IMPORT FINGERPRINT: a hash of the storyboard's content, recorded on the
 * project, so two imports of identical bytes can be told apart from two imports
 * of a corrected file - and neither is dressed up as a reuse it is not.
 *
 * ## What must never duplicate, at any cost
 *
 * A ProviderJob or a CostReservation, because those are money. Import creates
 * neither; this asserts that directly rather than trusting the claim.
 *
 * See QĐ-077.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let tmp = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "import-idem-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSource(name: string, over: Record<string, unknown> = {}): string {
  const dir = path.join(tmp, name, "video-1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({
      video_id: "idem-1",
      video_title: "Idempotency probe",
      characters: [
        {
          character_id: "idem",
          character_name: "IdemBo",
          character_reference_image: "ref.png",
          character_hair: "short brown hair",
          character_face: "round face",
          character_outfit: "green coat",
          character_body: "small and round",
        },
      ],
      scenes: [1, 2].map((n) => ({
        scene_number: n,
        duration: 4,
        visual_description: `IdemBo stands against a plain wall, beat ${n}.`,
        character_action: "IdemBo blinks once.",
        camera: "Locked static medium shot, no camera movement.",
        dialogue: `IdemBo: "Line ${n}."`,
        subtitle: `Line ${n}.`,
        motion_mode: "LOCAL_MOTION",
        priority: "LOW",
        image_file: "k.png",
        character_id: "idem",
        character_name: "IdemBo",
        ...over,
      })),
    }),
  );
  fs.writeFileSync(path.join(dir, "k.png"), PNG);
  fs.writeFileSync(path.join(dir, "ref.png"), PNG);
  return path.join(tmp, name);
}

async function importOnce(source: string, batchName: string) {
  const validated = await validateImport(scanImportSource(source));
  return materialiseImport(validated, {
    batchName,
    maxCostPerVideo: 5,
    maxCostForBatch: 20,
    allowPartial: true,
  });
}

describe("nhập cùng một storyboard hai lần", () => {
  it("lần hai KHÔNG tạo nhân vật thứ hai", async () => {
    const source = writeSource("first");
    await importOnce(source, "idem-1");
    const afterFirst = await prisma.character.count({ where: { name: "IdemBo" } });
    expect(afterFirst).toBe(1);

    await importOnce(source, "idem-2");
    expect(await prisma.character.count({ where: { name: "IdemBo" } })).toBe(1);
  });

  it("lần hai KHÔNG tạo ảnh tham chiếu thứ hai, và ảnh chính không đổi", async () => {
    const row = await prisma.character.findUniqueOrThrow({ where: { name: "IdemBo" } });
    const refs = await prisma.characterReference.findMany({
      where: { characterId: row.id },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.isPrimary).toBe(true);
    expect(refs[0]!.approved).toBe(true);
  });

  it("KHÔNG tạo ProviderJob hay CostReservation nào — nhập không tiêu tiền", async () => {
    const projects = await prisma.project.findMany({ where: { title: "Idempotency probe" } });
    const ids = projects.map((p) => p.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    expect(await prisma.providerJob.count({ where: { projectId: { in: ids } } })).toBe(0);
    const batchIds = projects
      .map((p) => p.batchId)
      .filter((b): b is string => b !== null);
    expect(
      await prisma.costReservation.count({ where: { batchId: { in: batchIds } } }),
    ).toBe(0);
    expect(await prisma.costEntry.count({ where: { projectId: { in: ids } } })).toBe(0);
  });

  it("quyền chi của cả hai lô vẫn DRAFT, trần đã duyệt = 0", async () => {
    const projects = await prisma.project.findMany({ where: { title: "Idempotency probe" } });
    const batchIds = [...new Set(projects.map((p) => p.batchId).filter(Boolean))] as string[];
    for (const batchId of batchIds) {
      const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
      expect(auth.status).toBe("DRAFT");
      expect(auth.authorizedMaxSpend).toBe(0);
    }
  });

  // The design decision, asserted rather than assumed: a second import IS a
  // second project, and it says so.
  it("lần hai TẠO dự án mới — và mang dấu vân tay để phân biệt, không giả vờ dùng lại", async () => {
    const projects = await prisma.project.findMany({
      where: { title: "Idempotency probe" },
      orderBy: { createdAt: "asc" },
    });
    expect(projects.length).toBeGreaterThanOrEqual(2);
    expect(projects[0]!.id).not.toBe(projects[1]!.id);

    // Identical bytes in, identical fingerprint out.
    expect(projects[0]!.importFingerprint).toBeTruthy();
    expect(projects[1]!.importFingerprint).toBe(projects[0]!.importFingerprint);

    // Each keeps its own scenes; the second import did not touch the first's.
    for (const project of projects.slice(0, 2)) {
      expect(await prisma.scene.count({ where: { projectId: project.id } })).toBe(2);
    }
  });

  it("sửa nội dung storyboard -> dấu vân tay ĐỔI, nên phân biệt được bản đã sửa", async () => {
    const edited = writeSource("edited", { duration: 5 });
    const created = await importOnce(edited, "idem-3");
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: created.projects[0]!.projectId },
    });
    const first = await prisma.project.findFirstOrThrow({
      where: { title: "Idempotency probe" },
      orderBy: { createdAt: "asc" },
    });
    expect(project.importFingerprint).not.toBe(first.importFingerprint);

    // ...and still exactly one IdemBo, with exactly one reference.
    const row = await prisma.character.findUniqueOrThrow({ where: { name: "IdemBo" } });
    expect(await prisma.characterReference.count({ where: { characterId: row.id } })).toBe(1);
  });
});
