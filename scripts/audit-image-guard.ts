import { prisma } from "@/lib/prisma";
import { findImageContradictions, resolveImagePrompt } from "@/domain/image-prompt";
import { buildCanonicalDescription, lockedAttributesFor } from "@/services/character-service";
import { sceneCharacters } from "@/domain/scene-characters";

/**
 * Does the image-prompt guard actually catch the contradictions it is for?
 *
 * QĐ-065 added a contradiction detector to the IMAGE path after scene 4 of the
 * first real batch came back as a cheerful portrait on an empty background -
 * two contradictions in one prompt, both sent as written, the model picking a
 * winner. The guard has run on every image since and NOBODY HAS READ ITS OUTPUT
 * on hand-written storyboard prose, which is a different register from what a
 * text model writes.
 *
 * So this does two things, and neither of them costs anything:
 *
 *   1. REAL DATA. Every scene in the database, composed exactly as
 *      `buildSceneImageRequest` composes it, with each character's real sheet.
 *      Whatever the guard says is reported - including saying nothing.
 *   2. NAMED SHAPES. One probe per contradiction the operator asked about, so
 *      a silent guard can be told apart from a guard with nothing to find.
 *
 * A probe that finds nothing is the interesting result: it means the guard has
 * a hole, and the hole is named rather than discovered later by an image.
 *
 *   npx tsx scripts/audit-image-guard.ts
 */

interface Probe {
  id: string;
  label: string;
  expect: string;
  sceneDescription: string;
  camera?: string;
  characters?: { name: string; canonical: string }[];
}

/**
 * One probe per contradiction shape the operator named.
 *
 * Written in the register a person actually types into a storyboard, not in the
 * register a text model writes - that difference is the whole reason this audit
 * exists.
 */
const PROBES: Probe[] = [
  {
    id: "smile-vs-serious",
    label: "smile (bảng nhân vật) vs serious (cảnh)",
    expect: "expression_vs_sheet",
    sceneDescription: "Max looks deadly serious and does not smile at all.",
    // Clause-shaped, as a real sheet is: `buildCanonicalDescription` emits
    // comma-separated clauses and the transient-clause test is anchored to a
    // whole clause.
    characters: [
      { name: "Max", canonical: "a boy, wide eager smile, outfit: yellow hoodie" },
    ],
  },
  {
    id: "eyes-closed-vs-wide",
    label: "eyes closed (cảnh) vs wide eyes (bảng nhân vật)",
    expect: "expression_vs_sheet",
    sceneDescription: "Max keeps his eyes closed the whole time.",
    characters: [{ name: "Max", canonical: "a boy, always wide-eyed and eager" }],
  },
  {
    id: "standing-vs-sitting",
    label: "standing vs sitting trong cùng một cảnh",
    expect: "posture_conflict",
    sceneDescription: "Max stands at the end of the board while sitting on the bench.",
  },
  {
    id: "camera-locked-vs-pan",
    label: "camera khoá vs camera pan",
    expect: "camera_move_in_still",
    sceneDescription: "Max waits by the door.",
    camera: "Locked static medium shot, then pan to the window.",
  },
  {
    id: "empty-vs-crowd",
    label: "nền trống vs đám đông",
    expect: "crowd_vs_empty_frame",
    sceneDescription:
      "Max stands in front of a cheering crowd, and nothing else is in frame.",
  },
  {
    id: "outfit-a-vs-b",
    label: "trang phục A (cảnh) vs trang phục B (khoá nhận dạng)",
    expect: "garment_vs_locked_identity",
    sceneDescription: "Max wears a red raincoat and green wellies.",
    characters: [
      { name: "Max", canonical: "a boy. outfit: bright yellow hoodie, blue jeans" },
    ],
  },
  {
    id: "action-vs-empty",
    label: "hành động cần đạo cụ vs 'nothing else in frame' (ca gốc của QĐ-065)",
    expect: "action_vs_empty_frame",
    sceneDescription:
      "Max moves one short pace backwards along the diving board, and nothing else is in frame.",
  },
  {
    id: "action-vs-static",
    label: "đứng im tuyệt đối vs có động tác",
    expect: "action_vs_static",
    sceneDescription: "Max is completely static, then he raises one hand.",
  },
];

let holes = 0;

function runProbe(p: Probe): void {
  const found = findImageContradictions({
    sceneDescription: p.sceneDescription,
    camera: p.camera ?? "",
    characters: p.characters ?? [],
  });
  const kinds = found.map((c) => c.kind);
  const hit = kinds.includes(p.expect as (typeof kinds)[number]);
  if (!hit) holes += 1;
  console.log(
    `  ${hit ? "BAT DUOC" : "LO HONG "}  ${p.id.padEnd(22)} muon: ${p.expect.padEnd(26)} ` +
      `thay: ${kinds.length > 0 ? kinds.join(", ") : "(khong thay gi)"}`,
  );
  for (const c of found) {
    console.log(`              ${c.kind}: giu "${c.kept}" bo "${c.dropped}"`);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(92));
  console.log("  AUDIT BO DO MAU THUAN PROMPT ANH (QĐ-065) — chi doc, khong tao anh nao");
  console.log("=".repeat(92));

  console.log("\n--- 1. TAM DANG MAU THUAN NGUOI DUNG NEU TEN ---");
  for (const p of PROBES) runProbe(p);

  console.log("\n--- 2. TOAN BO CANH THAT TRONG DB ---");
  const scenes = await prisma.scene.findMany({
    include: { project: { select: { title: true } } },
    orderBy: [{ projectId: "asc" }, { sceneNumber: "asc" }],
  });

  let withFindings = 0;
  let unresolved = 0;
  for (const scene of scenes) {
    const names = sceneCharacters(scene).present;
    const rows = await prisma.character.findMany({ where: { name: { in: names } } });
    const characters = rows.map((r) => ({
      name: r.name,
      canonical: buildCanonicalDescription(r),
    }));

    // Composed exactly as `buildSceneImageRequest` does it: the scene's own
    // staging text, not the model-written `imagePrompt`.
    const action = [scene.visualDescription, scene.characterAction]
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .join(" ");

    const resolved = resolveImagePrompt({
      sceneDescription: action.length > 0 ? action : scene.imagePrompt,
      camera: scene.camera,
      characters,
    });

    if (resolved.contradictions.length === 0) continue;
    withFindings += 1;
    console.log(
      `\n  ${scene.project.title.slice(0, 28).padEnd(28)} #${scene.sceneNumber}  ` +
        `(${characters.map((c) => c.name).join(", ") || "khong co nhan vat"})`,
    );
    for (const c of resolved.contradictions) {
      if (!c.resolved) unresolved += 1;
      console.log(
        `    ${c.resolved ? "DA XU LY" : "CHUA XU LY"}  ${c.kind}` +
          `  giu "${c.kept}"  bo "${c.dropped}"`,
      );
      console.log(`      ${c.message}`);
    }
  }

  console.log(`\n  Canh co phat hien : ${withFindings}/${scenes.length}`);
  console.log(`  Chua tu xu ly duoc: ${unresolved}`);

  console.log("\n--- 3. KHOA NHAN DANG DANG AP DUNG CHO TUNG NHAN VAT ---");
  const characters = await prisma.character.findMany({ orderBy: { name: "asc" } });
  for (const c of characters) {
    const locked = lockedAttributesFor(c);
    console.log(
      `  ${c.name.padEnd(8)} khoa ${locked.length}: ${locked.join(", ") || "(khong khoa gi)"}`,
    );
    if (c.negativeIdentity.trim().length > 0) {
      console.log(`           negativeIdentity: ${c.negativeIdentity}`);
    }
  }

  console.log(
    `\n${holes === 0 ? "KHONG CON LO HONG" : `CON ${holes} LO HONG`} trong ${PROBES.length} dang mau thuan.`,
  );
  if (holes > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
