import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { isInsideData, projectDir, toAbsolute } from "@/lib/paths";
import { existingOutputFor } from "@/services/output-export";

/**
 * The folder a project's output lives in, or null when there is none yet.
 *
 * Resolved from the database, never from a caller-supplied path, and refused
 * unless it lies inside the data root: the result is handed to the operating
 * system's file manager, so it must be a place this app wrote to.
 */
export async function resolveOutputFolder(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, finalVideoPath: true },
  });
  if (!project) return null;
  // The exported folder (final.mp4 + thumbnail + subtitles + metadata) is what
  // a person wants to open; the pipeline's own folder is the fallback.
  const exported = existingOutputFor(project);
  if (exported && isInsideData(exported.dir)) return exported.dir;
  const folder = project.finalVideoPath
    ? path.dirname(toAbsolute(project.finalVideoPath))
    : projectDir(project.id);
  return isInsideData(folder) && fs.existsSync(folder) ? folder : null;
}
