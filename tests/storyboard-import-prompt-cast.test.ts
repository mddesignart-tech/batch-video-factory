import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { deriveVideoPrompt, parseStoryboardJson, type ImportIssue } from "@/domain/storyboard";
import {
  materialiseImport,
  scanImportSource,
  validateImport,
} from "@/services/storyboard-import";
import { preflightImportedBatch } from "@/services/import-preflight";

/**
 * The second round of Import Storyboard V1: the three holes the first
 * end-to-end mock run found.
 *
 *   - a scene going to a video model with no prompt to send it
 *   - six scenes of one character that the pipeline had no way to recognise
 *     as the same person
 *   - an estimate that charged for keyframes the storyboard had already
 *     supplied, which is the one saving importing a storyboard exists for
 */

const CTX = { sourceFile: "storyboard.json", fallbackVideoId: "vid", fallbackVideoTitle: "Vid" };

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SCENE = (n: number, over: Record<string, unknown> = {}) => ({
  scene_number: n,
  duration: 4,
  visual_description: `Nhan vat lam viec ${n} tren nen phang.`,
  character_action: "Nhan vat gat dau mot cai.",
  camera: "Locked static medium shot, no camera movement.",
  dialogue: `Nhan vat: "Cau ${n}."`,
  subtitle: `Cau ${n}.`,
  motion_mode: "LOCAL_MOTION",
  priority: "LOW",
  ...over,
});

function codes(issues: ImportIssue[]): string[] {
  return issues.map((i) => i.code);
}

let tmp: string;

/** A priced mock registry, so an estimate has something to bite on. */
async function seedPricedModels(): Promise<void> {
  const rows = [
    { modelId: "pc-text", type: "text", priceUnit: "per_1k_tokens", price: 0.001, priceOutput: 0.002 },
    { modelId: "pc-image", type: "image", priceUnit: "per_image", price: 0.02 },
    { modelId: "pc-video", type: "video", priceUnit: "per_second", price: 0.05 },
    { modelId: "pc-voice", type: "voice", priceUnit: "per_1k_chars", price: 0.01 },
    { modelId: "pc-quality", type: "quality", priceUnit: "per_job", price: 0.004 },
  ];
  for (const row of rows) {
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: "mock", modelId: row.modelId } },
      create: {
        provider: "mock",
        modelId: row.modelId,
        displayName: row.modelId,
        type: row.type,
        enabled: true,
        priceUnit: row.priceUnit,
        price: row.price,
        priceOutput: row.priceOutput ?? 0,
        supportsTextToVideo: true,
        supportsImageToVideo: true,
        supportsReferenceImage: true,
        supportsCharacterReference: true,
        supports1080p: true,
        maxDuration: 30,
        qualityRating: 6,
        speedRating: 6,
        consistencyRating: 6,
        lifecycle: "ACTIVE",
      },
      update: { enabled: true, price: row.price, lifecycle: "ACTIVE" },
    });
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-v2-"));
  await seedPricedModels();
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeVideo(
  name: string,
  storyboard: unknown,
  files: Record<string, Buffer> = {},
): string {
  const root = path.join(tmp, name);
  const dir = path.join(root, "v");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "storyboard.json"), JSON.stringify(storyboard));
  for (const [file, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), data);
  }
  return root;
}

// ------------------------------------------------------------ videoPrompt ---

describe("videoPrompt dựng sẵn, không nhờ Text AI", () => {
  it("ghép mô tả + hành động + camera theo thứ tự cố định", () => {
    const prompt = deriveVideoPrompt({
      visualDescription: "Mia sits in a waiting room",
      characterAction: "Mia swallows once",
      camera: "Locked static medium shot",
    });
    expect(prompt).toBe(
      "Mia sits in a waiting room. Movement: Mia swallows once. Camera: Locked static medium shot.",
    );
  });

  it("tất định: cùng đầu vào ra cùng một chuỗi, vì nó bị băm vào khoá idempotency", () => {
    const input = {
      visualDescription: "A on B",
      characterAction: "A moves",
      camera: "Locked shot",
    };
    expect(deriveVideoPrompt(input)).toBe(deriveVideoPrompt({ ...input }));
  });

  it("thiếu phần nào thì bỏ phần đó, không để lại nhãn rỗng", () => {
    expect(deriveVideoPrompt({ visualDescription: "Chỉ có cảnh", characterAction: "", camera: "" })).toBe(
      "Chỉ có cảnh.",
    );
    expect(
      deriveVideoPrompt({ visualDescription: "", characterAction: "", camera: "Locked shot" }),
    ).toBe("Camera: Locked shot.");
  });

  it("mọi cảnh nhập vào đều có videoPrompt", () => {
    const out = parseStoryboardJson(
      JSON.stringify({ video_id: "p", scenes: [1, 2, 3].map((n) => SCENE(n)) }),
      CTX,
    );
    expect(out.videos[0]!.scenes.every((s) => s.videoPrompt.length > 0)).toBe(true);
  });

  it("người dùng tự ghi video_prompt thì tôn trọng, không ghi đè", () => {
    const out = parseStoryboardJson(
      JSON.stringify({ video_id: "p", scenes: [SCENE(1, { video_prompt: "Prompt tay." })] }),
      CTX,
    );
    expect(out.videos[0]!.scenes[0]!.videoPrompt).toBe("Prompt tay.");
  });

  it("VIDEO_AI chỉ có camera, không có gì chuyển động → CHẶN khi nhập, không đợi tới provider", () => {
    const out = parseStoryboardJson(
      JSON.stringify({
        video_id: "p",
        scenes: [
          {
            scene_number: 1,
            duration: 5,
            visual_description: "   ",
            character_action: "   ",
            camera: "Locked static medium shot.",
            motion_mode: "VIDEO_AI",
          },
        ],
      }),
      CTX,
    );
    expect(out.videos).toHaveLength(0);
    expect(out.issues.some((i) => i.level === "error")).toBe(true);
  });

  it("videoPrompt được ghi vào DB, không để cảnh VIDEO_AI đi với prompt rỗng", async () => {
    const root = writeVideo(
      "prompt-db",
      {
        video_id: "prompt-db",
        scenes: [
          SCENE(1, { motion_mode: "VIDEO_AI", duration: 5, priority: "HIGH", image_file: "k.png" }),
        ],
      },
      { "k.png": PNG_1X1 },
    );
    const created = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "prompt-db",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scene = await prisma.scene.findFirstOrThrow({
      where: { projectId: created.projects[0]!.projectId },
    });
    expect(scene.videoPrompt.length).toBeGreaterThan(0);
    expect(scene.videoPrompt).toContain("Movement:");
    expect(scene.videoPrompt).toContain("Camera:");
  });
});

// -------------------------------------------------------------- nhân vật ---

describe("nhân vật xuyên suốt", () => {
  it("khai báo ở cấp video, cảnh tham chiếu bằng character_id", () => {
    const out = parseStoryboardJson(
      JSON.stringify({
        video_id: "cast",
        characters: [{ character_id: "mia", character_name: "Mia" }],
        scenes: [1, 2].map((n) => SCENE(n, { character_id: "mia" })),
      }),
      CTX,
    );
    expect(out.videos[0]!.characters).toHaveLength(1);
    expect(out.videos[0]!.characters[0]!.name).toBe("Mia");
    expect(out.videos[0]!.scenes.every((s) => s.characterId === "mia")).toBe(true);
  });

  it("cùng character_id gán hai tên khác nhau là LỖI", () => {
    const out = parseStoryboardJson(
      JSON.stringify({
        video_id: "cast",
        characters: [
          { character_id: "mia", character_name: "Mia" },
          { character_id: "mia", character_name: "Maya" },
        ],
        scenes: [SCENE(1, { character_id: "mia" })],
      }),
      CTX,
    );
    expect(codes(out.issues)).toContain("character_id_conflict");
  });

  it("cảnh tự khai nhân vật mà video không khai ở trên: coi là khai ngầm, không phải lỗi", async () => {
    const root = writeVideo("cast-implicit", {
      video_id: "ci",
      scenes: [1, 2].map((n) => SCENE(n, { character_id: "solo", character_name: "Solo-import-test" })),
    });
    const validated = await validateImport(scanImportSource(root));
    expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
    const video = validated.videos[0]!;
    expect(video.characters.map((c) => c.name)).toEqual(["Solo-import-test"]);

    // Điều duy nhất thực sự quan trọng: hai cảnh là CÙNG một người.
    const created = await materialiseImport(validated, {
      batchName: "cast-implicit",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scenes = await prisma.scene.findMany({
      where: { projectId: created.projects[0]!.projectId },
    });
    expect(scenes).toHaveLength(2);
    for (const scene of scenes) {
      expect(JSON.parse(scene.charactersPresentJson)).toEqual(["Solo-import-test"]);
    }
    expect(await prisma.character.count({ where: { name: "Solo-import-test" } })).toBe(1);
  });

  it("thiếu ảnh tham chiếu nhân vật là LỖI, có nói tên nhân vật", async () => {
    const root = writeVideo("cast-missing-ref", {
      video_id: "cmr",
      characters: [
        { character_id: "z", character_name: "Zed", character_reference_image: "zed.png" },
      ],
      scenes: [SCENE(1, { character_id: "z" })],
    });
    const validated = await validateImport(scanImportSource(root));
    const miss = validated.issues.find((i) => i.code === "character_reference_missing");
    expect(miss).toBeDefined();
    expect(miss!.message).toContain("Zed");
  });

  it("6 cảnh cùng nhân vật: MỘT Character row, mọi cảnh cùng danh sách", async () => {
    const root = writeVideo(
      "cast-six",
      {
        video_id: "cast-six",
        characters: [
          { character_id: "nova", character_name: "Nova", character_reference_image: "ref.png" },
        ],
        scenes: [1, 2, 3, 4, 5, 6].map((n) => SCENE(n, { character_id: "nova" })),
      },
      { "ref.png": PNG_1X1 },
    );
    const created = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "cast-six",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scenes = await prisma.scene.findMany({
      where: { projectId: created.projects[0]!.projectId },
    });
    expect(scenes).toHaveLength(6);
    for (const scene of scenes) {
      expect(JSON.parse(scene.charactersPresentJson)).toEqual(["Nova"]);
      expect(JSON.parse(scene.primaryCharactersJson)).toEqual(["Nova"]);
    }
    expect(await prisma.character.count({ where: { name: "Nova" } })).toBe(1);

    const character = await prisma.character.findFirstOrThrow({ where: { name: "Nova" } });
    const refs = await prisma.characterReference.findMany({
      where: { characterId: character.id },
    });
    expect(refs.some((r) => r.isPrimary && r.approved)).toBe(true);
  });

  it("nhân vật đã có sẵn thì DÙNG LẠI, không ghi đè mô tả canonical", async () => {
    const existing = await prisma.character.create({
      data: {
        name: "Kai-import-test",
        description: "co san",
        personality: "vui",
        visualPrompt: "MO TA GOC KHONG DUOC DOI",
      },
    });
    const root = writeVideo("cast-existing", {
      video_id: "ce",
      characters: [{ character_id: "kai", character_name: "Kai-import-test" }],
      scenes: [SCENE(1, { character_id: "kai" })],
    });
    await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "cast-existing",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const after = await prisma.character.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.visualPrompt).toBe("MO TA GOC KHONG DUOC DOI");
    expect(await prisma.character.count({ where: { name: "Kai-import-test" } })).toBe(1);
  });

  it("lời dẫn cũng là lời nói: cảnh chỉ có narration vẫn có người đọc", async () => {
    const root = writeVideo("narration", {
      video_id: "nar",
      characters: [{ character_id: "v", character_name: "Vera-import-test" }],
      scenes: [
        SCENE(1, { character_id: "v", dialogue: "", narration: "Chi co loi dan o day." }),
        SCENE(2, { character_id: "v", dialogue: "", narration: "" }),
      ],
    });
    const created = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "narration",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scenes = await prisma.scene.findMany({
      where: { projectId: created.projects[0]!.projectId },
      orderBy: { sceneNumber: "asc" },
    });
    // `parseDialogueLines` chỉ đọc narration khi có người nói. Danh sách rỗng
    // không phải "đọc vô danh" — nó là lời dẫn bị bỏ im lặng.
    expect(JSON.parse(scenes[0]!.speakingCharactersJson)).toEqual(["Vera-import-test"]);
    expect(JSON.parse(scenes[1]!.speakingCharactersJson)).toEqual([]);
  });
});

// --------------------------------------------------- ảnh có sẵn giá bằng 0 ---

describe("ảnh storyboard mang theo phải được định giá bằng 0", () => {
  it("có ảnh → IMAGE $0; không ảnh → IMAGE > $0", async () => {
    const withImages = writeVideo(
      "price-zero",
      { video_id: "pz", scenes: [1, 2, 3].map((n) => SCENE(n, { image_file: "k.png" })) },
      { "k.png": PNG_1X1 },
    );
    const a = await materialiseImport(await validateImport(scanImportSource(withImages)), {
      batchName: "price-zero",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const pricedA = await preflightImportedBatch(a.batchId);
    expect(pricedA.videos[0]!.breakdown.image).toBe(0);

    // Cùng storyboard, bỏ ảnh đi. Nếu con số này cũng bằng 0 thì phép đo ở trên
    // không chứng minh được gì.
    const without = writeVideo("price-nonzero", {
      video_id: "pn",
      scenes: [1, 2, 3].map((n) => SCENE(n)),
    });
    const b = await materialiseImport(await validateImport(scanImportSource(without)), {
      batchName: "price-nonzero",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const pricedB = await preflightImportedBatch(b.batchId);
    expect(pricedB.videos[0]!.breakdown.image).toBeGreaterThan(0);
    expect(pricedB.videos[0]!.estimatedCost).toBeGreaterThan(
      pricedA.videos[0]!.estimatedCost,
    );
  });
});
