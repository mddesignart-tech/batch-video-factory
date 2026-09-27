import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";

/** Shared fixtures for the V1.2 Phase 5 suites (QĐ-113). Mock providers only. */

export async function seedMock(): Promise<void> {
  for (const provider of SEED_PROVIDERS.filter((p) => p.name === "mock")) {
    await prisma.providerConfig.upsert({
      where: { name: provider.name },
      create: { ...provider, types: JSON.stringify(provider.types), status: "connected" },
      update: { enabled: true, status: "connected" },
    });
  }
  for (const model of SEED_MODELS.filter((m) => m.provider === "mock")) {
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: model.provider, modelId: model.modelId } },
      create: model,
      update: { enabled: true, reliability: "OK", price: model.price },
    });
  }
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({ where: { slug: preset.slug }, create: { ...preset, aspectRatio: "9:16" }, update: {} });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: { ...character, voiceProvider: "mock", enabled: true },
      update: {},
    });
  }
}

export async function makePng(dir: string, colour: string, size = "1080x1920"): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${colour}-${randomUUID()}.png`);
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=${size}`, "-frames:v", "1", file]);
  return file;
}

export async function makeWav(dir: string, freq = 440, seconds = 1): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `tone-${freq}-${randomUUID()}.wav`);
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, file]);
  return file;
}

export async function makeMp4(dir: string, colour: string, seconds = 1, size = "270x480"): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${colour}-${randomUUID()}.mp4`);
  await ffmpeg([
    "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=${size}:d=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  return file;
}

export interface SceneSpec {
  image?: { file: string; bytes: Buffer };
  motion: "LOCAL_MOTION" | "VIDEO_AI";
  line: string;
  prompt?: string;
}

/** A one-video storyboard folder; the same arguments always produce the same storyboard. */
export function writeStoryboard(tmp: string, folder: string, videoId: string, scenes: SceneSpec[]): string {
  const dir = path.join(tmp, folder, "v");
  fs.mkdirSync(dir, { recursive: true });
  const rows = scenes.map((s, i) => {
    if (s.image) fs.writeFileSync(path.join(dir, s.image.file), s.image.bytes);
    return {
      scene_number: i + 1,
      duration: 3,
      visual_description: s.prompt ?? `Max stands against a plain wall, shot ${i + 1}.`,
      character_action: "Max holds still.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: `Max: "${s.line}"`,
      subtitle: s.line,
      ...(s.image ? { image_file: s.image.file } : {}),
      motion_mode: s.motion,
      priority: "NORMAL",
    };
  });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: videoId, video_title: videoId, characters: [{ character_id: "max", character_name: "Max" }], scenes: rows }),
  );
  return path.join(tmp, folder);
}

let seq = 0;
export async function importFolder(root: string, label = "p5") {
  seq += 1;
  const validated = await validateImport(scanImportSource(root));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, {
    batchName: `${label}-${seq}-${randomUUID().slice(0, 6)}`,
    maxCostPerVideo: 5,
    maxCostForBatch: 50,
  });
  return { batchId: created.batchId, projectId: created.projects[0]!.projectId, created };
}

/** A snapshot of everything money-related, to prove a step changed none of it. */
export async function ledgerSnapshot() {
  const [costEntries, providerJobs, reservations] = await Promise.all([
    prisma.costEntry.findMany({ orderBy: { id: "asc" } }),
    prisma.providerJob.findMany({ orderBy: { id: "asc" } }),
    prisma.costReservation.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { costEntries, providerJobs, reservations };
}

/** A bare project (no pipeline) for rows built by hand - "legacy" shapes. */
export async function bareProject(title: string) {
  const slug = `p5-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`;
  const idiom = await prisma.idiom.create({
    data: {
      phrase: slug,
      slug,
      meaning: "Phase 5 fixture",
      literalMeaning: "Phase 5 fixture",
      exampleSentence: "Phase 5 fixture.",
      category: "Funny Expressions",
      difficulty: "Beginner",
      region: "General",
      status: "unused",
    },
  });
  return prisma.project.create({
    data: { idiomId: idiom.id, title, status: "script_ready", qualityMode: "BALANCED", targetDuration: 20 },
  });
}
