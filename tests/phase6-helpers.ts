import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";

/**
 * Shared fixtures for the V1.2 Phase 6 suites (QĐ-114). Mock providers only;
 * AI_MOCK_MODE is pinned on by tests/setup.ts.
 */

export { seedMock, makePng, makeWav, ledgerSnapshot } from "./phase5-helpers";

export interface P6Scene {
  /** File name of an imported keyframe in the storyboard folder, or none (image will be created). */
  image?: string;
  motion?: "LOCAL_MOTION" | "VIDEO_AI";
  /** Spoken line; empty = silent scene (no voice to make). */
  line?: string;
  duration?: number;
}

export interface P6Video {
  id: string;
  title: string;
  scenes: P6Scene[];
  maxCost?: number;
}

/**
 * One folder, one storyboard.json with a `videos` list, the given images copied
 * in. The same arguments always give the same storyboard content.
 */
export function writeBatchFolder(root: string, videos: P6Video[], images: Record<string, Buffer>): string {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, bytes] of Object.entries(images)) fs.writeFileSync(path.join(root, name), bytes);
  const doc = {
    videos: videos.map((v) => ({
      video_id: v.id,
      video_title: v.title,
      ...(v.maxCost !== undefined ? { max_cost: v.maxCost } : {}),
      characters: [{ character_id: "max", character_name: "Max" }],
      scenes: v.scenes.map((s, i) => ({
        scene_number: i + 1,
        duration: s.duration ?? 2,
        visual_description: `Max stands against a plain wall, shot ${i + 1} of ${v.id}.`,
        character_action: "Max holds still.",
        camera: "Locked static medium shot, no camera movement.",
        dialogue: s.line ? `Max: "${s.line}"` : "",
        subtitle: s.line ?? "",
        ...(s.image ? { image_file: s.image } : {}),
        motion_mode: s.motion ?? "LOCAL_MOTION",
        priority: "NORMAL",
      })),
    })),
  };
  fs.writeFileSync(path.join(root, "storyboard.json"), JSON.stringify(doc, null, 2));
  return root;
}

let seq = 0;
export async function importBatch(root: string, opts: { name?: string; maxCostPerVideo?: number; maxCostForBatch?: number } = {}) {
  seq += 1;
  const validated = await validateImport(scanImportSource(root));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, {
    batchName: opts.name ?? `p6-${seq}-${randomUUID().slice(0, 6)}`,
    maxCostPerVideo: opts.maxCostPerVideo ?? 5,
    maxCostForBatch: opts.maxCostForBatch ?? 50,
  });
  const ids = Object.fromEntries(created.projects.map((p) => [p.videoId, p.projectId]));
  return { batchId: created.batchId, created, ids };
}

/** Everything money-related that a $0 step must not change, as counts. */
export async function moneyCounts() {
  const [providerJobs, costEntries, reservations, paidJobs] = await Promise.all([
    prisma.providerJob.count(),
    prisma.costEntry.count(),
    prisma.costReservation.count(),
    prisma.providerJob.count({ where: { provider: { not: "mock" } } }),
  ]);
  return { providerJobs, costEntries, reservations, paidJobs };
}
