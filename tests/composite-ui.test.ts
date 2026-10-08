import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DATA_ROOT, toAbsolute } from "@/lib/paths";
import { profileFromPlatform } from "@/domain/platform-profile";
import { inferLayers, locationOf } from "@/domain/scene-layers";
import { parseScenePlan } from "@/domain/scene-plan";
import { buildSceneNormalizeArgs, STILL_MATTE, stillOnMatte } from "@/media/render";
import { pngHasAlpha } from "@/media/cutout";
import { ffmpeg } from "@/media/ffmpeg";
import { createContentProject } from "@/services/content-service";
import { storeImportedImage } from "@/services/imported-image";
import { createReference, setSceneReferences } from "@/services/reference-assets";
import { applySuggestedPlan, compositeOption, enableComposite, renderInputsFor, resetSceneCameraAuto, restoreCutouts, setSceneLayout } from "@/services/scene-plan-service";
import { sceneCameraViews } from "@/services/scene-camera-view";
import { makePng, seedMock } from "./phase5-helpers";

/**
 * QĐ-131 G9 - what the UI check found (mock, local, $0):
 *  - a location picture named in Vietnamese plans its background + ambient;
 *  - switching the composite on re-plans what stands behind the subjects;
 *  - DÙNG GỢI Ý / Đặt lại tự động keep the cut-outs (no empty background);
 *  - VỊ TRÍ TRONG KHUNG: size, standing line, horizon - a product stands on it;
 *  - the Character Bible cast can be cut out for a conversation;
 *  - a transparent still renders on a light matte, not black.
 */

let tmp = "";
const jobs = () => prisma.providerJob.count();
const scenesOf = (projectId: string) => prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
const planOf = async (id: string) => parseScenePlan((await prisma.scene.findUniqueOrThrow({ where: { id } })).scenePlanJson)!;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "composite-ui-"));
  await seedMock();
}, 300_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A subject on a plain light backdrop, away from every edge (cuts cleanly). */
async function plainSubject(file: string, colour: string): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0xE6E6E6:s=600x1000,drawbox=x=220:y=140:w=160:h=760:color=${colour}@1:t=fill`, "-frames:v", "1", file]);
  return file;
}

async function transparentProduct(): Promise<string> {
  const cut = path.join(tmp, `cut-${randomUUID()}.png`);
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red@0.0:s=300x500,format=rgba,drawbox=x=80:y=60:w=140:h=380:color=silver@1:t=fill", "-frames:v", "1", cut]);
  return cut;
}

async function kitchenReview(productFile?: string) {
  const p = await createContentProject({ contentType: "PRODUCT_REVIEW", sourceType: "PROMPT", idea: "QA131 bình giữ nhiệt", subjectName: "Bình QA", durationSeconds: 12, outputProfile: profileFromPlatform("TIKTOK") });
  const env = await storeImportedImage({ projectId: p.id, sceneId: null, bytes: fs.readFileSync(await makePng(tmp, "beige", "720x1280")), originalFilename: "bep.png" });
  const prod = await storeImportedImage({ projectId: p.id, sceneId: null, bytes: fs.readFileSync(productFile ?? (await transparentProduct())), originalFilename: "binh.png" });
  // Added AFTER the script, as a person does on the project page.
  const envRef = await createReference({ projectId: p.id, type: "ENVIRONMENT", name: "Gian bếp", isPrimary: false, useThroughout: false, assetIds: [env.asset.id] });
  const prodRef = await createReference({ projectId: p.id, type: "PRODUCT", name: "Bình QA", isPrimary: true, useThroughout: false, assetIds: [prod.asset.id] });
  const [s1] = await scenesOf(p.id);
  await setSceneReferences(s1!.id, [envRef.id, prodRef.id]);
  return { p, sceneId: s1!.id };
}

describe("G9 - bối cảnh tiếng Việt (thuần)", () => {
  it("tên ảnh bối cảnh tiếng Việt → lớp nền + ambient của nơi đó", () => {
    const park = inferLayers({ visualDescription: "", characterAction: "", references: [{ id: "e", type: "ENVIRONMENT", name: "Công viên", critical: false }], ambientAvailable: ["leaves", "birds"] });
    expect(park.find((l) => l.layerType === "BACKGROUND")?.label).toBe("Công viên");
    expect(park.filter((l) => l.layerType === "AMBIENT").map((l) => l.id).sort()).toEqual(["amb-birds", "amb-leaves"]);
    const kitchen = inferLayers({ visualDescription: "", characterAction: "", references: [{ id: "e", type: "ENVIRONMENT", name: "Gian bếp", critical: false }] });
    expect(kitchen.some((l) => l.id === "amb-steam")).toBe(true);
    expect(locationOf("Hai bạn đi dạo trên đường phố buổi sáng")).toBe("Đường phố");
    expect(locationOf("bảo vệ môi trường")).toBeNull();
    expect(locationOf("A boy in the kitchen")).toBe("Gian bếp");
  });
});

describe("G9 - ghép lớp từ giao diện (DB, mock, $0)", () => {
  it("bật ghép lớp: lớp nền + ambient được lập lại theo ảnh bối cảnh vừa thêm; không job nào", async () => {
    const { sceneId } = await kitchenReview();
    const before = await jobs();
    expect((await compositeOption(sceneId)).available).toBe(true);
    await enableComposite(sceneId);
    const plan = await planOf(sceneId);
    expect(plan.route).toBe("COMPOSITE");
    expect(plan.layers.find((l) => l.layerType === "BACKGROUND")?.label).toBe("Gian bếp");
    expect(plan.layers.some((l) => l.id === "amb-steam")).toBe(true);
    expect(await jobs()).toBe(before);
  }, 300_000);

  it("DÙNG GỢI Ý / Đặt lại tự động giữ chủ thể tách nền (không còn cảnh nền trống)", async () => {
    const { sceneId } = await kitchenReview();
    await enableComposite(sceneId);
    await setSceneLayout(sceneId, { horizonY: 0.45 });
    await applySuggestedPlan(sceneId);
    let scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
    expect(renderInputsFor(scene).layers?.foregrounds?.length).toBe(1);
    expect(renderInputsFor(scene).layers?.horizonY).toBe(0.45);
    await resetSceneCameraAuto(sceneId);
    scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
    expect(parseScenePlan(scene.scenePlanJson)?.route).toBe("COMPOSITE");
    expect(renderInputsFor(scene).layers?.foregrounds?.length).toBe(1);
  }, 300_000);

  it("VỊ TRÍ TRONG KHUNG: cỡ / chỗ đứng / chân trời; sản phẩm tự đứng trên chân trời; null = tự động", async () => {
    const { p, sceneId } = await kitchenReview();
    await enableComposite(sceneId);
    const fgId = (await planOf(sceneId)).layers.find((l) => l.layerType === "FOREGROUND")!.id;

    await setSceneLayout(sceneId, { horizonY: 0.43 });
    let fg = renderInputsFor(await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } })).layers!.foregrounds![0]!;
    expect(fg.floorY).toBe(0.43); // the counter top

    await setSceneLayout(sceneId, { subjects: [{ id: fgId, scale: 0.45, floorY: 0.5 }] });
    fg = renderInputsFor(await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } })).layers!.foregrounds![0]!;
    expect(fg).toMatchObject({ scale: 0.45, floorY: 0.5 });

    const view = (await sceneCameraViews(p.id, new Map()))[sceneId]!;
    expect(view.placement).toMatchObject({ horizonY: 0.43, subjects: [{ id: fgId, scale: 0.45, floorY: 0.5 }] });

    await setSceneLayout(sceneId, { subjects: [{ id: fgId, scale: null, floorY: null }], horizonY: null });
    fg = renderInputsFor(await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } })).layers!.foregrounds![0]!;
    expect(fg.scale).toBe(0.6);
    expect(fg.floorY).toBeUndefined();
    await expect(setSceneLayout((await scenesOf(p.id))[1]!.id, { horizonY: 0.5 })).rejects.toThrow(/ghép lớp/);
  }, 300_000);

  it("mất file tách nền (dọn cache / chép máy khác) → tách lại từ ảnh tham chiếu trước khi render; không tách lại được → báo rõ", async () => {
    // A product photographed on a plain backdrop: its cut-out lives in the cache.
    const { sceneId } = await kitchenReview(await plainSubject(path.join(tmp, `plain-${randomUUID()}.png`), "0xB0703A"));
    await enableComposite(sceneId);
    const fg = (await planOf(sceneId)).layers.find((l) => l.layerType === "FOREGROUND" && l.assetPath)!;
    expect(fg.assetPath).toMatch(/cutouts/);
    fs.rmSync(toAbsolute(fg.assetPath!), { force: true });
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
    expect(renderInputsFor(scene).layers?.foregrounds ?? []).toHaveLength(0); // what used to render: an empty location
    const r = await restoreCutouts(scene.projectId);
    expect(r).toMatchObject({ restored: 1, missing: [] });
    expect(renderInputsFor(await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } })).layers?.foregrounds).toHaveLength(1);

    // A subject with no reference to cut from again is reported, not dropped.
    const plan = await planOf(sceneId);
    const orphan = plan.layers.map((l) => (l.layerType === "FOREGROUND" ? { ...l, entityId: undefined, referenceAssetIds: [], assetPath: "cache/cutouts/missing.png" } : l));
    await prisma.scene.update({ where: { id: sceneId }, data: { scenePlanJson: JSON.stringify({ ...plan, layers: orphan }) } });
    expect((await restoreCutouts(scene.projectId)).missing).toEqual([`Cảnh ${scene.sceneNumber}: ${fg.label}`]);
  }, 300_000);

  it("cảnh hội thoại: nhân vật trong trang Nhân vật được tách nền làm chủ thể", async () => {
    const p = await createContentProject({ contentType: "STORY", sourceType: "PROMPT", idea: "QA131 two friends talk on the street", durationSeconds: 12, outputProfile: profileFromPlatform("TIKTOK") });
    const names = [`Leo${randomUUID().slice(0, 6)}`, `Mia${randomUUID().slice(0, 6)}`];
    for (const [i, name] of names.entries()) {
      const rel = `characters/qa131-${name}.png`;
      await plainSubject(path.join(DATA_ROOT, rel), i ? "0x2E7D32" : "0x1565C0");
      const c = await prisma.character.create({ data: { name, description: "", personality: "", visualPrompt: `${name} cartoon` } });
      await prisma.characterReference.create({ data: { characterId: c.id, filePath: rel, source: "upload", isPrimary: true, approved: true, characterVersion: c.version } });
    }
    const env = await storeImportedImage({ projectId: p.id, sceneId: null, bytes: fs.readFileSync(await makePng(tmp, "gray", "720x1280")), originalFilename: "pho.png" });
    const envRef = await createReference({ projectId: p.id, type: "ENVIRONMENT", name: "Đường phố", isPrimary: false, useThroughout: true, assetIds: [env.asset.id] });
    const [s1] = await scenesOf(p.id);
    await prisma.scene.update({ where: { id: s1!.id }, data: { charactersPresentJson: JSON.stringify(names), speakingCharactersJson: JSON.stringify(names), imagePath: null } });
    await setSceneReferences(s1!.id, [envRef.id]);
    const option = await compositeOption(s1!.id);
    expect(option.available).toBe(true);
    expect(option.subject).toBe(names.join(" + "));
    await enableComposite(s1!.id);
    const plan = await planOf(s1!.id);
    expect(plan.layers.filter((l) => l.layerType === "FOREGROUND" && l.assetPath).map((l) => l.label)).toEqual(names);
    expect(plan.layers.some((l) => l.id === "amb-traffic")).toBe(true);
  }, 300_000);
});

describe("G9 - ảnh tĩnh trong suốt", () => {
  it("nhập ảnh PNG trong suốt (con vật / sticker) → bản working nền sáng, không nền đen, không bản phóng mờ", async () => {
    const p = await createContentProject({ contentType: "ANIMAL_FACT", sourceType: "PROMPT", idea: "QA131 chim", durationSeconds: 12, outputProfile: profileFromPlatform("TIKTOK") });
    const wide = path.join(tmp, `wide-${randomUUID()}.png`);
    await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red@0.0:s=800x500,format=rgba,drawbox=x=300:y=100:w=200:h=300:color=0x2060C0@1:t=fill", "-frames:v", "1", wide]);
    const stored = await storeImportedImage({ projectId: p.id, sceneId: null, bytes: fs.readFileSync(wide), originalFilename: "chim.png" });
    expect(stored.framing).toBe("contain_blur");
    const raw = path.join(tmp, "import-corner.rgb");
    await ffmpeg(["-v", "error", "-y", "-i", toAbsolute(stored.imagePath), "-vf", "crop=4:4:2:2", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
    expect([...fs.readFileSync(raw).subarray(0, 3)].every((v) => v > 200)).toBe(true);
  }, 120_000);

  it("PNG trong suốt được đặt lên nền sáng (cache theo nội dung) rồi dựng như ảnh thường - không còn nền đen", async () => {
    const png = await transparentProduct();
    const flat = await stillOnMatte(png);
    expect(await stillOnMatte(png)).toBe(flat); // cached
    expect(pngHasAlpha(flat)).toBe(false);
    const target = { width: 360, height: 640, fps: 30 };
    const out = path.join(tmp, "matte.mp4");
    await ffmpeg(buildSceneNormalizeArgs({ videoInput: flat, audioInput: null, duration: 1, target, output: out, camera: { move: "STATIC", speed: "SLOW" } }));
    const raw = path.join(tmp, "corner.rgb");
    await ffmpeg(["-v", "error", "-y", "-i", out, "-vf", "crop=4:4:2:2", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
    const px = fs.readFileSync(raw);
    expect(px[0]).toBeGreaterThan(200); // the empty corner is the light matte, not black
    expect(STILL_MATTE).toMatch(/^0x[0-9A-F]{6}$/);
  }, 120_000);
});
