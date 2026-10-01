import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";

/**
 * Voice files that exist but hold no usable audio (V1.2 Phase 6, QĐ-114).
 *
 * A dialogue line marked completed whose file is a bare header (the two 78-byte
 * WAVs the Phase 5 backfill found) would be REUSED by every plan - "the voice
 * exists" - and rendered as silence. Replacing it is a paid TTS request, so it
 * is never done automatically: the video is held as NEEDS_ATTENTION
 * (INVALID_VOICE_ASSET) and the person decides.
 *
 *   INVALID  the library marked the file INVALID, or it is under 1 KB
 *            (a WAV header is 44 bytes; one second of the quietest mono
 *            24 kHz speech is ~48 KB)
 *
 * A MISSING file is not this case: the plan already shows it as a voice to buy.
 */
export const MIN_VOICE_BYTES = 1024;

export interface InvalidVoiceLine {
  projectId: string;
  sceneNumber: number;
  lineNumber: number;
  path: string;
  bytes: number;
  reason: "LIBRARY_INVALID" | "TOO_SMALL";
}

export async function invalidVoiceLines(projectIds: string[]): Promise<Map<string, InvalidVoiceLine[]>> {
  const out = new Map<string, InvalidVoiceLine[]>();
  if (projectIds.length === 0) return out;
  const lines = await prisma.dialogueLine.findMany({
    where: { status: "completed", outputPath: { not: "" }, scene: { projectId: { in: projectIds }, skipped: false } },
    select: { lineNumber: true, outputPath: true, scene: { select: { projectId: true, sceneNumber: true } } },
  });
  if (lines.length === 0) return out;
  const flagged = await prisma.asset.findMany({
    where: { validity: "INVALID", filePath: { in: [...new Set(lines.map((l) => l.outputPath))] } },
    select: { filePath: true },
  });
  const libraryInvalid = new Set(flagged.map((a) => a.filePath));
  for (const l of lines) {
    const abs = toAbsolute(l.outputPath);
    if (!fs.existsSync(abs)) continue;
    const bytes = fs.statSync(abs).size;
    const reason = libraryInvalid.has(l.outputPath) ? "LIBRARY_INVALID" : bytes < MIN_VOICE_BYTES ? "TOO_SMALL" : null;
    if (!reason) continue;
    const list = out.get(l.scene.projectId) ?? [];
    list.push({ projectId: l.scene.projectId, sceneNumber: l.scene.sceneNumber, lineNumber: l.lineNumber, path: l.outputPath, bytes, reason });
    out.set(l.scene.projectId, list);
  }
  return out;
}

export function invalidVoiceMessage(lines: InvalidVoiceLine[]): string {
  const scenes = [...new Set(lines.map((l) => l.sceneNumber))].sort((a, b) => a - b);
  return (
    `INVALID_VOICE_ASSET: ${lines.length} file giọng hỏng (cảnh ${scenes.join(", ")}; ` +
    `${lines.map((l) => `${l.bytes} byte`).join(", ")}). Cần tạo lại giọng — có thể phát sinh chi phí. ` +
    `Không tự gọi TTS.`
  );
}
