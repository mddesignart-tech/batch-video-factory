import fs from "node:fs";
import path from "node:path";
import type { Project, Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { projectSubdir, toAbsolute, toRelative, uuidFilename } from "@/lib/paths";
import {
  controlsOf,
  mergeControls,
  platformSafeArea,
  subtitleLayout,
  voiceChanged,
  type OutputControls,
} from "@/domain/output-controls";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";
import type { RenderRequest } from "@/media/render";
import { buildASS } from "@/media/subtitles";
import { sfxFileFor } from "@/media/sfx-library";

/**
 * VIDEO OUTPUT (QĐ-125). Subtitles, narration / music / effect levels: saved
 * on the project and applied by the LOCAL render only - changing any of them
 * re-renders on this machine and sends no request of any kind. The narrator
 * voice is the one setting that changes audio itself; it goes through the
 * existing voice preview / price / confirm path (QĐ-117), never silently.
 */

export async function projectControls(projectId: string): Promise<OutputControls> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  return controlsOf(project);
}

export interface SaveControlsResult {
  controls: OutputControls;
  /** A new local render is needed ($0). */
  rerenderNeeded: boolean;
  /** The narrator voice changed: new speech has to be made (priced, confirmed). */
  voiceChanged: boolean;
}

export async function saveProjectControls(projectId: string, patch: Parameters<typeof mergeControls>[1]): Promise<SaveControlsResult> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const before = controlsOf(project);
  const controls = mergeControls(before, patch);
  const changed = JSON.stringify(before) !== JSON.stringify(controls);
  if (!changed) return { controls, rerenderNeeded: false, voiceChanged: false };
  await prisma.project.update({
    where: { id: projectId },
    data: {
      outputControlsJson: JSON.stringify(controls),
      // A finished video re-renders locally on the next TIẾP TỤC / RENDER LẠI.
      ...(project.status === "completed" ? { status: "media_ready" } : {}),
    },
  });
  await logger.info({
    event: "output.controls_saved",
    projectId,
    message: voiceChanged(before, controls)
      ? "Đã đổi giọng thuyết minh - cần tạo giọng mới (xem giá và xác nhận trước)."
      : "Đã lưu thiết lập VIDEO OUTPUT - chỉ render lại tại máy, không gọi API ($0).",
  });
  return { controls, rerenderNeeded: true, voiceChanged: voiceChanged(before, controls) };
}

/** The narrator voice override for a project, or null when it uses the Narrator character's own. */
export async function narratorOverride(projectId: string | null | undefined) {
  if (!projectId) return null;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { contentType: true, outputControlsJson: true } });
  if (!project?.outputControlsJson) return null;
  const v = controlsOf(project).voice;
  return v.voiceId || v.speed !== null || v.instructions !== null || v.provider ? v : null;
}

// ------------------------------------------------------------------ music ---

/** Store the person's music file for this project ($0) and use it as the bed. */
export async function setBackgroundMusic(projectId: string, bytes: Buffer, filename: string): Promise<{ assetId: string; durationSec: number }> {
  const ext = path.extname(filename).toLowerCase();
  if (![".mp3", ".wav", ".m4a", ".aac", ".ogg"].includes(ext)) throw new Error("Nhạc nền phải là file MP3, WAV, M4A, AAC hoặc OGG.");
  const file = path.join(projectSubdir(projectId, "audio"), `music-${uuidFilename(ext)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const durationSec = await probeDuration(file).catch(() => 0);
  if (!(durationSec > 0)) {
    fs.rmSync(file, { force: true });
    throw new Error("Không đọc được file nhạc này.");
  }
  const asset = await prisma.asset.create({
    data: {
      projectId,
      kind: "audio",
      provider: "import",
      model: "music",
      source: "IMPORTED",
      status: "completed",
      filePath: toRelative(file),
      bytes: bytes.length,
      originalFilename: path.basename(filename),
      durationSec,
    },
  });
  await prisma.project.update({ where: { id: projectId }, data: { backgroundMusicAssetId: asset.id } });
  return { assetId: asset.id, durationSec };
}

export async function clearBackgroundMusic(projectId: string): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { backgroundMusicAssetId: null } });
}

async function musicPathOf(project: Pick<Project, "backgroundMusicAssetId">): Promise<string | null> {
  if (!project.backgroundMusicAssetId) return null;
  const a = await prisma.asset.findUnique({ where: { id: project.backgroundMusicAssetId } });
  if (!a) return null;
  const abs = toAbsolute(a.filePath);
  return fs.existsSync(abs) ? abs : null;
}

// ----------------------------------------------------------------- render ---

/**
 * Put the project's VIDEO OUTPUT controls on a render request. Local only.
 * Every field it sets is part of the render recipe, so a change re-renders
 * and an unchanged project keeps SAME_RENDER_INPUT.
 */
export async function applyOutputControls(
  project: Project,
  scenes: Pick<Scene, "sceneNumber" | "soundEffect">[],
  request: RenderRequest,
): Promise<void> {
  const c = controlsOf(project);
  request.burnSubtitles = request.burnSubtitles && c.subtitles.enabled;
  request.subtitleLayout = subtitleLayout(c.subtitles, request.target.width, request.target.height, request.subtitleBottomPct ?? null);
  request.mixSettings = {
    ...(request.mixSettings ?? {}),
    musicGain: c.audio.musicVolume,
    duckDb: c.audio.duckMusic ? (request.mixSettings?.duckDb ?? 12) || 12 : 0,
    sfxGain: c.audio.sfxVolume,
  };
  if (c.audio.musicEnabled) {
    const music = await musicPathOf(project);
    if (music) request.musicPath = music;
  }
  if (c.audio.sfxEnabled && c.audio.sfxVolume > 0) {
    const placed: { sceneNumber: number; path: string }[] = [];
    for (const s of scenes) {
      const file = s.soundEffect ? await sfxFileFor(s.soundEffect) : null;
      if (file) placed.push({ sceneNumber: s.sceneNumber, path: file });
    }
    if (placed.length) request.sceneSfx = placed;
  }
  const a = c.audio;
  if (a.narrationVolume !== 1 || a.normalizeNarration || a.fades) {
    request.voiceMix = { gain: a.narrationVolume, normalize: a.normalizeNarration, fadeSec: a.fades ? 0.3 : 0 };
  }
}

// ---------------------------------------------------------------- preview ---

/**
 * A single still frame at the project's output size with a sample caption
 * burned in at the chosen size / place / style - so positioning can be judged
 * without rendering the video. Local FFmpeg, $0. Returns a data-relative path.
 */
export async function subtitlePreviewFrame(
  projectId: string,
  opts: { controls?: Parameters<typeof mergeControls>[1]; sampleText?: string } = {},
): Promise<{ path: string; width: number; height: number }> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } } },
  });
  const { renderSettingsFrom } = await import("./output-layout");
  const { getSettings } = await import("@/lib/settings");
  const output = renderSettingsFrom(project, null, await getSettings());
  const { width, height } = output.render.target;
  const c = opts.controls ? mergeControls(controlsOf(project), opts.controls) : controlsOf(project);
  const scene = project.scenes.find((s) => s.imagePath && fs.existsSync(toAbsolute(s.imagePath)));
  const text = opts.sampleText?.trim() || project.scenes.map((s) => s.subtitle).find((t) => t.trim().length > 0) || "Phụ đề mẫu hiển thị ở đây";

  const dir = projectSubdir(projectId, "temp");
  fs.mkdirSync(dir, { recursive: true });
  const assFile = path.join(dir, "preview.ass");
  const layout = subtitleLayout(c.subtitles, width, height, output.render.subtitleBottomPct ?? null);
  fs.writeFileSync(
    assFile,
    c.subtitles.enabled ? buildASS([{ startSeconds: 0, endSeconds: 5, text }], { width, height, layout }) : buildASS([], { width, height, layout }),
    "utf8",
  );
  const out = path.join(dir, `preview-${Date.now()}.png`);
  const safe = platformSafeArea(width, height);
  const guide = c.subtitles.advanced.showSafeArea
    ? `,drawbox=x=${Math.round(safe.left * width)}:y=${Math.round(safe.top * height)}:w=${Math.round((1 - safe.left - safe.right) * width)}:h=${Math.round((1 - safe.top - safe.bottom) * height)}:color=yellow@0.6:t=4`
    : "";
  const fitFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  const input = scene ? ["-i", toAbsolute(scene.imagePath!)] : ["-f", "lavfi", "-i", `color=c=0x3a3f4b:s=${width}x${height}`];
  // The filter runs inside the renders folder so the .ass path needs no escaping.
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", ...input, "-vf", `${fitFilter}${guide},subtitles=preview.ass`, "-frames:v", "1", path.basename(out)], { cwd: dir });
  // Keep only the latest few previews.
  for (const old of fs.readdirSync(dir).filter((f) => f.startsWith("preview-") && f.endsWith(".png")).sort().slice(0, -3)) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
  return { path: toRelative(out), width, height };
}
