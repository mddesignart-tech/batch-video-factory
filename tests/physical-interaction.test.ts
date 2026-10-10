import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { profileFromPlatform } from "@/domain/platform-profile";
import { classifyInteraction, keepsCriticalReferences, routeInteraction, type ReferenceCaps } from "@/domain/physical-interaction";
import { parseScenePlan } from "@/domain/scene-plan";
import { createContentProject } from "@/services/content-service";
import { storeImportedImage } from "@/services/imported-image";
import { createReference, setSceneReferences } from "@/services/reference-assets";
import { sceneCameraViews } from "@/services/scene-camera-view";
import { dropInteraction, planProjectScenes } from "@/services/scene-plan-service";
import { makePng, seedMock } from "./phase5-helpers";

/**
 * QĐ-131 G11 - PHYSICAL-INTERACTION AWARE ROUTING. Separate local layers only
 * where the subjects do not touch; a hand on a product, a pour, a handshake or
 * a bird picking something up goes to an asset that shows it or to an approved
 * Video AI model that keeps the CRITICAL references. Never a paid call from here.
 */

const kind = (text: string) => classifyInteraction(text).kind;
const PRODUCT_MODEL: ReferenceCaps = { referenceImage: true, productReference: true, characterReference: true, directReference: true, maxReferenceImages: 3 };
const PLAIN_MODEL: ReferenceCaps = { referenceImage: true };

describe("G11 - phân loại tương tác (thuần)", () => {
  it("A. presenter đứng cạnh / chỉ tay về bình giữ nhiệt → LOCAL_OK", () => {
    expect(kind("Presenter đứng cạnh bình giữ nhiệt")).toBe("LOCAL_OK");
    expect(kind("Presenter chỉ tay về bình giữ nhiệt trên bàn bếp, đánh giá sản phẩm")).toBe("LOCAL_OK");
    expect(kind("The presenter stands beside the travel pot that keeps drinks hot")).toBe("LOCAL_OK");
    expect(routeInteraction({ text: "Presenter đứng cạnh bình giữ nhiệt", critical: ["PRODUCT"], models: [], paidApproved: false })).toMatchObject({
      interaction: "LOCAL_OK",
      route: "LOCAL_LAYERS",
      notice: null,
    });
  });

  it("B. presenter cầm bình giữ nhiệt → COMPLEX_INTERACTION", () => {
    expect(kind("Presenter cầm bình giữ nhiệt")).toBe("COMPLEX_INTERACTION");
    expect(kind("The presenter is holding the thermos")).toBe("COMPLEX_INTERACTION");
  });

  it("C. cô gái mở nắp và rót nước → COMPLEX_INTERACTION (mở nắp + rót)", () => {
    const v = classifyInteraction("Cô gái mở nắp và rót nước");
    expect(v.kind).toBe("COMPLEX_INTERACTION");
    expect(v.cues).toEqual(expect.arrayContaining(["mở / đóng nắp", "rót / uống"]));
    expect(kind("She opens the lid and pours tea")).toBe("COMPLEX_INTERACTION");
  });

  it("D. 2 nhân vật nói chuyện → LOCAL_OK; E. 2 nhân vật bắt tay → COMPLEX_INTERACTION", () => {
    expect(kind("2 nhân vật nói chuyện trên vỉa hè")).toBe("LOCAL_OK");
    expect(kind("Leo and Mia talk on the street")).toBe("LOCAL_OK");
    expect(kind("2 nhân vật bắt tay")).toBe("COMPLEX_INTERACTION");
    expect(kind("Leo and Mia shake hands")).toBe("COMPLEX_INTERACTION");
  });

  it("F. chim bay trước công viên → LOCAL_OK; G. chim nhặt cành cây bằng mỏ → COMPLEX trừ khi có asset gốc", () => {
    expect(kind("Chim bay trước công viên")).toBe("LOCAL_OK");
    expect(kind("A bird flies over the park")).toBe("LOCAL_OK");
    const twig = { text: "Chim nhặt cành cây bằng mỏ", critical: [], models: [], paidApproved: false };
    expect(routeInteraction(twig)).toMatchObject({ interaction: "COMPLEX_INTERACTION", route: "ASK_USER", autoPaid: false });
    expect(routeInteraction({ ...twig, nativeClip: true })).toMatchObject({ route: "NATIVE_CLIP", autoPaid: false });
    expect(routeInteraction({ ...twig, scenePicture: true })).toMatchObject({ route: "SCENE_PICTURE", autoPaid: false });
  });

  it("những từ dễ nhầm không bị coi là tương tác", () => {
    expect(kind("Bình đựng đồ uống giữ nhiệt 12 giờ")).toBe("LOCAL_OK");
    expect(kind("The pot holds heat for hours")).toBe("LOCAL_OK");
    expect(kind("Mở đầu video, presenter mỉm cười")).toBe("LOCAL_OK");
  });
});

describe("G11 - ưu tiên tham chiếu + không tự trả phí (thuần)", () => {
  it("H. Product Reference CRITICAL + model không hỗ trợ tham chiếu → không AUTO sang trả phí, dù đã duyệt", () => {
    expect(keepsCriticalReferences(PLAIN_MODEL, ["PRODUCT"])).toBe(false);
    expect(keepsCriticalReferences({ ...PRODUCT_MODEL, directReference: undefined }, ["PRODUCT"])).toBe(false); // never assumed
    expect(keepsCriticalReferences(PRODUCT_MODEL, ["PRODUCT"])).toBe(true);
    const r = routeInteraction({ text: "Presenter cầm bình giữ nhiệt", critical: ["PRODUCT"], models: [PLAIN_MODEL], paidApproved: true });
    expect(r).toMatchObject({ interaction: "COMPLEX_INTERACTION", route: "ASK_USER", autoPaid: false });
    expect(r.choices.find((c) => c.id === "VIDEO_AI")).toMatchObject({ available: false, note: expect.stringMatching(/tham chiếu/) });
    // With a model that keeps the product AND the approval: Video AI.
    expect(routeInteraction({ text: "Presenter cầm bình giữ nhiệt", critical: ["PRODUCT"], models: [PLAIN_MODEL, PRODUCT_MODEL], paidApproved: true })).toMatchObject({
      route: "VIDEO_AI",
      autoPaid: true,
    });
  });

  it("I. chưa duyệt Video AI → không bao giờ tự sang trả phí; 4 lựa chọn thân thiện", () => {
    const r = routeInteraction({ text: "Cô gái mở nắp và rót nước", critical: ["PRODUCT"], models: [PRODUCT_MODEL], paidApproved: false });
    expect(r).toMatchObject({ route: "ASK_USER", autoPaid: false });
    expect(r.notice).toBe("Cảnh này có tương tác vật lý giữa các chủ thể. Local Motion có thể trông như các lớp ảnh tách rời.");
    expect(r.hint).toMatch(/cầm, mở, rót, uống/);
    expect(r.choices.map((c) => c.label)).toEqual(["Dùng cảnh đơn giản hơn", "Giữ các chủ thể tách rời bằng Local Motion", "Chọn Video AI", "Bỏ tương tác"]);
    expect(r.choices.find((c) => c.id === "VIDEO_AI")?.note).toMatch(/duyệt/);
    // Nothing technical in what a person reads.
    expect(`${r.notice} ${r.hint} ${r.choices.map((c) => `${c.label} ${c.note ?? ""}`).join(" ")}`).not.toMatch(/ffmpeg|overlay|alpha|cutout|layer|plate/i);
  });
});

describe("G11 - Scene Editor (DB, mock, $0)", () => {
  let tmp = "";
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "interaction-"));
    await seedMock();
  }, 300_000);
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("I. cảnh cầm bình + Product CRITICAL, Video AI chưa duyệt → báo + lựa chọn; Bỏ tương tác tắt báo; paid POST = 0", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const p = await createContentProject({ contentType: "PRODUCT_REVIEW", sourceType: "PROMPT", idea: "G11 bình giữ nhiệt", subjectName: "Bình G11", durationSeconds: 12, outputProfile: profileFromPlatform("TIKTOK") });
    const prod = await storeImportedImage({ projectId: p.id, sceneId: null, bytes: fs.readFileSync(await makePng(tmp, "silver", "300x500")), originalFilename: "binh.png" });
    const ref = await createReference({ projectId: p.id, type: "PRODUCT", name: "Bình G11", priority: "CRITICAL", isPrimary: true, useThroughout: false, assetIds: [prod.asset.id] });
    const [s1, s2] = await prisma.scene.findMany({ where: { projectId: p.id }, orderBy: { sceneNumber: "asc" } });
    await setSceneReferences(s1!.id, [ref.id]);
    await prisma.scene.update({ where: { id: s1!.id }, data: { visualDescription: "Presenter in a kitchen", characterAction: "Presenter cầm bình giữ nhiệt và mở nắp", motionSource: "LOCAL_MOTION", imagePath: null, videoPath: null } });
    await prisma.scene.update({ where: { id: s2!.id }, data: { visualDescription: "Presenter đứng cạnh bình giữ nhiệt", characterAction: "Presenter chỉ tay về sản phẩm" } });
    const before = { jobs: await prisma.providerJob.count(), costs: await prisma.costEntry.count() };

    await planProjectScenes(p.id);
    expect(parseScenePlan((await prisma.scene.findUniqueOrThrow({ where: { id: s1!.id } })).scenePlanJson)?.interaction).toBe("COMPLEX_INTERACTION");
    expect(parseScenePlan((await prisma.scene.findUniqueOrThrow({ where: { id: s2!.id } })).scenePlanJson)?.interaction).toBe("LOCAL_OK");

    let views = await sceneCameraViews(p.id, new Map());
    expect(views[s1!.id]!.interaction?.notice).toMatch(/tương tác vật lý/);
    expect(views[s1!.id]!.interaction?.choices.map((c) => c.id)).toEqual(["SIMPLER_SCENE", "KEEP_SEPARATE", "VIDEO_AI", "DROP_INTERACTION"]);
    expect(views[s2!.id]!.interaction).toBeNull();

    await dropInteraction(s1!.id);
    await planProjectScenes(p.id); // a re-plan keeps the person's choice
    views = await sceneCameraViews(p.id, new Map());
    expect(views[s1!.id]!.interaction).toBeNull();
    expect(views[s1!.id]!.notes).not.toContain("interaction-off");

    // Nothing was bought or sent anywhere.
    const s1After = await prisma.scene.findUniqueOrThrow({ where: { id: s1!.id } });
    expect(s1After.motionSource).toBe("LOCAL_MOTION");
    expect(await prisma.providerJob.count()).toBe(before.jobs);
    expect(await prisma.costEntry.count()).toBe(before.costs);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  }, 300_000);
});
