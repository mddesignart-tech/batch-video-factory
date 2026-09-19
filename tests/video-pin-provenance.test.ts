import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { slugify } from "@/lib/utils";
import { SEED_CHARACTERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { generateSceneVideo, isOperatorVideoPin } from "@/services/generation";
import { deriveSceneVideoFacts } from "@/services/low-auto-facts";

/**
 * WHO chose the video model - a person, or the router?
 *
 * `Scene.videoProvider` and `Scene.videoModel` answered both questions with one
 * pair of columns. Before a run they carried an operator's pin; after a run
 * `generateSceneVideo` wrote back the model it had actually used. Nothing
 * distinguished the two readings, so from the second run onwards every scene
 * that had ever bought a clip looked pinned - and a pin short-circuits routing.
 *
 * Three rules were switched off by that, all of them about money:
 *
 *   1. `lowAutoRouteBlock` stopped re-checking the conditions the LOW_AUTO
 *      grant was given under.
 *   2. `lowAutoRouted` came back false, so batch authorisation gate 2b - "this
 *      approval covers the clips it named, not clips the router picks later" -
 *      had nothing to fire on.
 *   3. `effectiveMotionSource` saw an instruction where there was none, so the
 *      "free wins" rule stopped applying to precisely the scenes that had
 *      already cost money.
 *
 * `videoModelPinned` is now the only column that says a person chose. These
 * tests are the ones that fail if the two meanings are ever merged again.
 *
 * Mock mode, throwaway database, no network, no money. See QĐ-069.
 */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let projectId = "";

/** A keyframe that is a real file, because `hasKeyframe` stats the disk. */
function writeKeyframe(relativeDir: string): string {
  const relative = path.posix.join(relativeDir, "keyframe.png");
  const absolute = toAbsolute(relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, PNG_1X1);
  return relative;
}

beforeAll(async () => {
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({
      where: { slug: preset.slug },
      create: { ...preset, aspectRatio: "9:16" },
      update: {},
    });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: { ...character, voiceProvider: "mock", enabled: true },
      update: {},
    });
  }

  const phrase = "Pin provenance";
  const idiom = await prisma.idiom.upsert({
    where: { slug: slugify(phrase) },
    create: {
      phrase,
      slug: slugify(phrase),
      meaning: "Who chose the model",
      literalMeaning: "A pin and a record look the same until they disagree.",
      exampleSentence: `${phrase} matters when money moves.`,
      category: "Funny Expressions",
      difficulty: "Beginner",
      region: "General",
      status: "unused",
    },
    update: {},
  });

  const project = await prisma.project.create({
    data: {
      idiomId: idiom.id,
      title: "Pin provenance",
      status: "script_ready",
      qualityMode: "ECONOMY",
      targetDuration: 20,
    },
  });
  projectId = project.id;
});

/**
 * A LOW scene at LOW priority: `decideMotion` answers LOCAL_MOTION for it, so
 * whether it stays on AI_VIDEO is decided purely by whether a pin is believed.
 */
async function sceneWherePlanSaysFree(over: {
  sceneNumber: number;
  videoProvider?: string | null;
  videoModel?: string | null;
  videoModelPinned?: boolean;
  motionSource?: string;
  motionMode?: string;
}) {
  return prisma.scene.create({
    data: {
      projectId,
      sceneNumber: over.sceneNumber,
      duration: 5,
      visualDescription: "Max stands against a plain wall.",
      characterAction: "Max blinks once.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: 'Max: "One line."',
      subtitle: "One line.",
      videoPrompt:
        "Max stands against a plain wall. Movement: Max blinks once. " +
        "Camera: Locked static medium shot, no camera movement.",
      complexity: "LOW",
      spendPriority: "LOW",
      charactersPresentJson: JSON.stringify(["Max"]),
      speakingCharactersJson: JSON.stringify(["Max"]),
      primaryCharactersJson: JSON.stringify(["Max"]),
      motionSource: over.motionSource ?? "AI_VIDEO",
      motionMode: over.motionMode ?? "AUTO",
      imageSource: "IMPORTED",
      imagePath: writeKeyframe(`projects/${projectId}/images`),
      videoProvider: over.videoProvider ?? null,
      videoModel: over.videoModel ?? null,
      videoModelPinned: over.videoModelPinned ?? false,
      status: "image_ready",
    },
  });
}

// ------------------------------------------------- the rule, without a DB ---

describe("isOperatorVideoPin: a pin is something somebody did", () => {
  it("cặp provider/model do router ghi lại KHÔNG phải ghim tay", () => {
    expect(
      isOperatorVideoPin({
        videoModelPinned: false,
        videoProvider: "runway",
        videoModel: "h3_max:768x1280",
      }),
    ).toBe(false);
  });

  it("có cờ VÀ có đủ cặp thì mới là ghim tay", () => {
    expect(
      isOperatorVideoPin({
        videoModelPinned: true,
        videoProvider: "runway",
        videoModel: "h3_max:768x1280",
      }),
    ).toBe(true);
  });

  // A provider with no model does not name the thing being bought, so it cannot
  // be an instruction to buy it - the flag alone must not be enough.
  it("cờ bật nhưng thiếu nửa cặp thì KHÔNG phải ghim tay", () => {
    expect(
      isOperatorVideoPin({
        videoModelPinned: true,
        videoProvider: "runway",
        videoModel: null,
      }),
    ).toBe(false);
    expect(
      isOperatorVideoPin({
        videoModelPinned: true,
        videoProvider: null,
        videoModel: "h3_max:768x1280",
      }),
    ).toBe(false);
  });

  // The marker the LOCAL_MOTION branch writes is a record of FFmpeg having done
  // the work. It is not a request to route anything to a vendor called ffmpeg.
  it("dấu ffmpeg/local-motion KHÔNG phải ghim tay", () => {
    expect(
      isOperatorVideoPin({
        videoModelPinned: false,
        videoProvider: "ffmpeg",
        videoModel: "local-motion",
      }),
    ).toBe(false);
  });
});

// --------------------------------------------------- the rule, on real rows ---

describe("miễn phí vẫn thắng sau khi cảnh đã từng mua clip", () => {
  it("ghi lại của router KHÔNG giữ cảnh ở AI_VIDEO", async () => {
    const scene = await sceneWherePlanSaysFree({
      sceneNumber: 1,
      // Exactly what `generateSceneVideo` writes back after a successful clip.
      videoProvider: "mock",
      videoModel: "mock-video-std",
      videoModelPinned: false,
    });

    const derived = deriveSceneVideoFacts(scene, {
      qualityMode: "ECONOMY",
      stage: "VIDEO",
    });
    expect(derived.motion.source).toBe("LOCAL_MOTION");
    expect(derived.facts.motionSource).toBe("LOCAL_MOTION");

    // And the pipeline acts on it: no clip, no vendor, no ProviderJob.
    const before = await prisma.providerJob.count();
    const clip = await generateSceneVideo(scene.id);
    expect(clip).toBeNull();
    expect(await prisma.providerJob.count()).toBe(before);
  });

  it("ghim tay thật vẫn giữ cảnh ở AI_VIDEO", async () => {
    const scene = await sceneWherePlanSaysFree({
      sceneNumber: 2,
      videoProvider: "mock",
      videoModel: "mock-video-std",
      videoModelPinned: true,
    });
    const derived = deriveSceneVideoFacts(scene, {
      qualityMode: "ECONOMY",
      stage: "VIDEO",
    });
    expect(derived.motion.source).toBe("AI_VIDEO");
    expect(derived.motion.diverged).toBe(true);
  });
});

describe("ghim tay không bị bước LOCAL_MOTION xoá mất", () => {
  // `effectiveMotionSource` refuses to move a LOCAL_MOTION plan to AI_VIDEO no
  // matter who asks, so a pinned scene CAN land in the free branch. Writing the
  // ffmpeg marker over the pin there would destroy the operator's choice with
  // nothing left to recover it from.
  it("cảnh đã ghim mà rơi vào nhánh LOCAL_MOTION vẫn giữ nguyên model đã ghim", async () => {
    const scene = await sceneWherePlanSaysFree({
      sceneNumber: 3,
      motionSource: "LOCAL_MOTION",
      videoProvider: "mock",
      videoModel: "mock-video-std",
      videoModelPinned: true,
    });

    const clip = await generateSceneVideo(scene.id);
    expect(clip).toBeNull();

    const after = await prisma.scene.findUniqueOrThrow({ where: { id: scene.id } });
    expect(after.videoProvider).toBe("mock");
    expect(after.videoModel).toBe("mock-video-std");
    expect(after.videoModelPinned).toBe(true);
    expect(after.videoPath).toBeNull();
    expect(after.status).toBe("video_ready");
  });

  it("cảnh KHÔNG ghim thì vẫn ghi dấu ffmpeg/local-motion như cũ", async () => {
    const scene = await sceneWherePlanSaysFree({
      sceneNumber: 4,
      motionSource: "LOCAL_MOTION",
    });

    expect(await generateSceneVideo(scene.id)).toBeNull();

    const after = await prisma.scene.findUniqueOrThrow({ where: { id: scene.id } });
    expect(after.videoProvider).toBe("ffmpeg");
    expect(after.videoModel).toBe("local-motion");
    expect(after.videoModelPinned).toBe(false);
  });
});

describe("motionMode = VIDEO_AI là chỉ định riêng, không cần ghim model", () => {
  it("giữ AI_VIDEO dù không có model nào được nêu tên", async () => {
    const scene = await sceneWherePlanSaysFree({
      sceneNumber: 5,
      motionMode: "VIDEO_AI",
    });
    const derived = deriveSceneVideoFacts(scene, {
      qualityMode: "ECONOMY",
      stage: "VIDEO",
    });
    expect(derived.motion.source).toBe("AI_VIDEO");
    // ...and it is still not a MODEL pin: the router must choose one, under the
    // gate, rather than short-circuiting to something already written down.
    expect(isOperatorVideoPin(scene)).toBe(false);
  });
});
