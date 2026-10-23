import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getSettings, saveSettings, type AppSettings } from "@/lib/settings";
import { projectSubdir, toAbsolute, toRelative } from "@/lib/paths";
import { controlsOf, mergeControls, type OutputControls } from "@/domain/output-controls";
import {
  allPresets,
  audioToPresetValues,
  AudioMixerSchema,
  CustomAudioPresetSchema,
  presetToAudioPatch,
  previewWindow,
  systemPreset,
  VI_PREVIEW_KIND,
  type AudioPreset,
  type AudioPresetValues,
  type CustomAudioPreset,
  type PreviewKind,
} from "@/domain/audio-mixer";
import {
  manifestDirFor,
  measureMusicLufs,
  readAudioManifest,
  renderMixerMix,
  writeAudioManifest,
  type AudioSourceManifest,
  type MixerMixInput,
} from "@/media/audio-mixer-render";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";
import { contentInfo } from "./asset-content";
import { audioMixerRequestOf, musicPathOf, saveProjectControls } from "./output-controls";

/**
 * AUDIO MIXER service (QĐ-150): presets, preview, REMIX AUDIO, batch audio.
 * Everything here is local FFmpeg: no TTS, image, video or text request of any
 * kind, ever - a remix mixes again from the SOURCE tracks kept beside a render
 * and stream-copies the picture.
 */

// ------------------------------------------------------------------ presets ---

export function presetsFrom(settings: Pick<AppSettings, "audioPresets">): AudioPreset[] {
  return allPresets(settings.audioPresets);
}

export async function listAudioPresets(): Promise<{ presets: AudioPreset[]; newProjectPresetId: string | null }> {
  const s = await getSettings();
  return { presets: presetsFrom(s), newProjectPresetId: s.newProjectAudioPresetId };
}

function findPreset(settings: Pick<AppSettings, "audioPresets">, id: string): AudioPreset | null {
  return presetsFrom(settings).find((p) => p.id === id) ?? null;
}

/** Create (no id) or edit (own id) a person's preset. A system preset is never written. */
export async function saveCustomAudioPreset(input: { id?: string | null; name: string; values: AudioPresetValues }): Promise<CustomAudioPreset> {
  if (input.id && systemPreset(input.id)) throw new Error("Preset hệ thống không sửa được - hãy lưu thành preset mới.");
  const s = await getSettings();
  const id = input.id || `custom-${randomUUID().slice(0, 8)}`;
  const preset = CustomAudioPresetSchema.parse({ id, name: input.name, values: input.values });
  const others = s.audioPresets.filter((p) => p.id !== id);
  if (others.some((p) => p.name.toLowerCase() === preset.name.toLowerCase())) throw new Error(`Đã có preset tên "${preset.name}".`);
  await saveSettings({ audioPresets: [...others, preset] });
  return preset;
}

/** Delete one of the person's presets. Projects that used it keep their copied values. */
export async function deleteCustomAudioPreset(id: string): Promise<void> {
  if (systemPreset(id)) throw new Error("Không xoá được preset hệ thống.");
  const s = await getSettings();
  if (!s.audioPresets.some((p) => p.id === id)) throw new Error("Không tìm thấy preset.");
  await saveSettings({
    audioPresets: s.audioPresets.filter((p) => p.id !== id),
    ...(s.newProjectAudioPresetId === id ? { newProjectAudioPresetId: null } : {}),
  });
}

export async function setNewProjectAudioPreset(id: string | null): Promise<void> {
  const s = await getSettings();
  if (id !== null && !findPreset(s, id)) throw new Error("Không tìm thấy preset.");
  await saveSettings({ newProjectAudioPresetId: id });
}

/**
 * The `audio` part of a NEW project's controls (QĐ-150), or null when Settings
 * says new projects keep the old mix. Only ever called at creation.
 */
export function newProjectAudio(settings: Pick<AppSettings, "audioPresets" | "newProjectAudioPresetId">): ReturnType<typeof presetToAudioPatch> | null {
  if (!settings.newProjectAudioPresetId) return null;
  const preset = findPreset(settings, settings.newProjectAudioPresetId);
  return preset ? presetToAudioPatch(preset) : null;
}

/** Stored controls JSON for a new project: `base` plus the default Audio Mixer preset. */
export function newProjectControlsJson(
  settings: Pick<AppSettings, "audioPresets" | "newProjectAudioPresetId">,
  base: Record<string, unknown> = {},
): string | null {
  const audio = newProjectAudio(settings);
  if (!audio) return Object.keys(base).length > 0 ? JSON.stringify(base) : null;
  return JSON.stringify({ ...base, audio: { ...((base.audio as object) ?? {}), ...audio } });
}

/** Copy a preset's values into one project (never linked: editing the preset later changes nothing here). */
export async function applyAudioPresetToProject(projectId: string, presetId: string): Promise<OutputControls> {
  const s = await getSettings();
  const preset = findPreset(s, presetId);
  if (!preset) throw new Error("Không tìm thấy preset.");
  const r = await saveProjectControls(projectId, { audio: presetToAudioPatch(preset) } as never);
  return r.controls;
}

export async function applyAudioPresetToBatch(batchId: string, presetId: string): Promise<number> {
  const s = await getSettings();
  const preset = findPreset(s, presetId);
  if (!preset) throw new Error("Không tìm thấy preset.");
  const projects = await prisma.project.findMany({ where: { batchId }, select: { id: true } });
  for (const p of projects) await saveProjectControls(p.id, { audio: presetToAudioPatch(preset) } as never);
  await logger.info({ event: "audio.preset_batch", message: `Áp preset âm thanh "${preset.name}" cho ${projects.length} video của lô (local, $0).` });
  return projects.length;
}

export function presetValuesOf(c: OutputControls): AudioPresetValues | null {
  return c.audio.mixer ? audioToPresetValues({ ...c.audio, mixer: c.audio.mixer }) : null;
}

// -------------------------------------------------------- sources / manifest ---

export const REMIX_NO_SOURCES =
  "Video này được xuất trước khi có Remix Audio nên không còn track nguồn riêng (giọng, nhạc, hiệu ứng) - MP4 đã trộn sẵn không tách lại chính xác được. " +
  "Cách xử lý: bấm RENDER LẠI một lần (tại máy, $0 API, dùng lại ảnh/giọng/clip đã có); từ bản đó trở đi có thể Remix Audio.";

async function sourcesOf(project: { id: string; finalVideoPath: string | null }): Promise<{ manifest: AudioSourceManifest; dir: string } | null> {
  if (!project.finalVideoPath) return null;
  const dir = manifestDirFor(projectSubdir(project.id, "audio"), path.basename(project.finalVideoPath));
  const manifest = readAudioManifest(dir);
  if (!manifest || !fs.existsSync(toAbsolute(manifest.dialogue))) return null;
  return { manifest, dir };
}

export interface RemixAvailability {
  ok: boolean;
  message: string;
  finalVideoPath: string | null;
}

export async function remixAvailability(projectId: string): Promise<RemixAvailability> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!project.finalVideoPath || !fs.existsSync(toAbsolute(project.finalVideoPath))) {
    return { ok: false, message: "Chưa có video đã xuất.", finalVideoPath: null };
  }
  if (!(await sourcesOf(project))) return { ok: false, message: REMIX_NO_SOURCES, finalVideoPath: project.finalVideoPath };
  return { ok: true, message: "Có track nguồn - Remix Audio được (tại máy, $0).", finalVideoPath: project.finalVideoPath };
}

/** The mix input for a project's CURRENT audio controls over a render's sources. */
async function mixInputFor(
  project: Parameters<typeof controlsOf>[0] & { backgroundMusicAssetId: string | null },
  c: OutputControls,
  manifest: AudioSourceManifest,
): Promise<MixerMixInput> {
  const mixer = audioMixerRequestOf(c.audio);
  if (!mixer) throw new Error("Hãy chọn một Audio Preset (bật Audio Mixer) trước.");
  const music = c.audio.musicEnabled ? await musicPathOf(project) : null;
  const sfx = c.audio.sfxEnabled
    ? manifest.sfx.map((e) => ({ path: toAbsolute(e.path), atSec: e.atSec })).filter((e) => fs.existsSync(e.path))
    : [];
  return {
    dialoguePath: toAbsolute(manifest.dialogue),
    totalSec: manifest.totalSec,
    regions: manifest.regions,
    musicPath: music,
    musicLufs: music ? await measureMusicLufs(music) : null,
    sfx,
    settings: {
      ...mixer,
      sfxGain: c.audio.sfxVolume,
      voice: { gain: c.audio.narrationVolume, normalize: c.audio.normalizeNarration },
    },
  };
}

// ------------------------------------------------------------------- preview ---

/**
 * A short MP3 of one moment of the video with the given (possibly unsaved)
 * audio settings. Local FFmpeg over the kept sources: no TTS, no image, no
 * video, no picture rendering. Returns a data-relative path.
 */
export async function audioPreview(
  projectId: string,
  kind: PreviewKind,
  patch?: Parameters<typeof mergeControls>[1],
): Promise<{ path: string; startSec: number; endSec: number; label: string }> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const src = await sourcesOf(project);
  if (!src) {
    throw new Error(
      project.finalVideoPath
        ? REMIX_NO_SOURCES
        : "Chưa có bản render nào để nghe thử - bấm RENDER LẠI một lần (tại máy, $0 API) rồi nghe thử.",
    );
  }
  const c = patch ? mergeControls(controlsOf(project), patch) : controlsOf(project);
  const window = previewWindow(kind, src.manifest);
  if (!window) throw new Error(`Video này không có ${VI_PREVIEW_KIND[kind].toLowerCase()}.`);
  const input = await mixInputFor(project, c, src.manifest);
  const dir = projectSubdir(projectId, "temp");
  const out = path.join(dir, `audio-preview-${kind.toLowerCase()}.mp3`);
  await renderMixerMix(input, out, { window, format: "mp3" });
  return { path: toRelative(out), ...window, label: VI_PREVIEW_KIND[kind] };
}

// --------------------------------------------------------------------- remix ---

export interface RemixResult {
  videoPath: string;
  previousVideoPath: string;
  durationSec: number;
}

/**
 * REMIX AUDIO: the project's current final MP4 with its sound mixed again from
 * the kept sources and the CURRENT audio controls. The picture is stream-copied
 * (not re-encoded); the result is a NEW file, the old one is left in place.
 */
export async function remixProjectAudio(projectId: string): Promise<RemixResult> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!project.finalVideoPath) throw new Error("Chưa có video đã xuất để remix.");
  const oldVideo = toAbsolute(project.finalVideoPath);
  if (!fs.existsSync(oldVideo)) throw new Error(`Không còn file video: ${project.finalVideoPath}`);
  const src = await sourcesOf(project);
  if (!src) throw new Error(REMIX_NO_SOURCES);

  const c = controlsOf(project);
  const input = await mixInputFor(project, c, src.manifest);
  const tempDir = projectSubdir(projectId, "temp");
  const finalDir = projectSubdir(projectId, "final");
  const audioDir = projectSubdir(projectId, "audio");
  const mixPath = path.join(tempDir, `remix-${randomUUID().slice(0, 8)}.wav`);
  const outName = `final_${randomUUID().slice(0, 8)}.mp4`;
  const outPath = path.join(finalDir, outName);
  try {
    await renderMixerMix(input, mixPath);
    const videoSec = await probeDuration(oldVideo);
    await ffmpeg(
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", oldVideo, "-i", mixPath,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", String(Math.round(videoSec * 1000) / 1000),
        "-movflags", "+faststart",
        outPath,
      ],
      { timeoutMs: 10 * 60 * 1000 },
    );
  } finally {
    fs.rmSync(mixPath, { force: true });
  }

  // The new MP4 gets its own manifest over the SAME sources, so it can be remixed again.
  writeAudioManifest(manifestDirFor(audioDir, outName), {
    ...src.manifest,
    finalName: outName,
    createdAt: new Date().toISOString(),
    music: input.musicPath ? toRelative(input.musicPath) : null,
    engine: "mixer",
    settings: { ...input.settings, remixOf: path.basename(oldVideo) },
  });

  const info = await contentInfo(outPath).catch(() => null);
  await prisma.asset.create({
    data: {
      projectId,
      kind: "final",
      provider: "ffmpeg",
      model: "remix-audio",
      status: "completed",
      filePath: toRelative(outPath),
      bytes: fs.statSync(outPath).size,
      sha256: info?.sha256 ?? null,
      mimeType: info?.mimeType ?? "video/mp4",
      width: info?.width ?? null,
      height: info?.height ?? null,
      durationSec: info?.durationSec ?? null,
      validatedAt: new Date(),
      inputsJson: JSON.stringify({ remixOf: project.finalVideoPath, audio: input.settings }),
    },
  });
  await prisma.project.update({
    where: { id: projectId },
    // The recipe described the OLD sound; cleared so a later RENDER LẠI can
    // never mistake this remix for an unchanged render.
    data: { finalVideoPath: toRelative(outPath), renderRecipe: null, status: "completed", errorMessage: null },
  });
  try {
    const { exportProjectOutput } = await import("./output-export");
    await exportProjectOutput(projectId);
  } catch (err) {
    await logger.warn({ event: "output.export_failed", projectId, message: `Không xuất được thư mục output: ${String(err)}` });
  }
  const durationSec = info?.durationSec ?? (await probeDuration(outPath).catch(() => 0));
  await logger.info({
    event: "audio.remixed",
    projectId,
    message: `REMIX AUDIO: ${path.basename(oldVideo)} → ${outName} (giữ nguyên hình, chỉ trộn lại âm thanh tại máy, $0 API).`,
  });
  return { videoPath: toRelative(outPath), previousVideoPath: project.finalVideoPath, durationSec };
}

/** Queue a remix (worker, local-render slot). Refuses up front when it cannot work. */
export async function enqueueRemix(projectId: string): Promise<void> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!controlsOf(project).audio.mixer) throw new Error("Hãy chọn một Audio Preset (bật Audio Mixer) trước khi Remix.");
  const a = await remixAvailability(projectId);
  if (!a.ok) throw new Error(a.message);
  const { enqueue } = await import("@/jobs/queue");
  await enqueue({ type: "remix_audio", projectId, priority: 500, maxAttempts: 1 });
}

/** BATCH REMIX: one remix job per video that has a final MP4 with sources; the rest are reported, not touched. */
export async function enqueueBatchRemix(batchId: string): Promise<{ queued: number; skipped: { title: string; reason: string }[] }> {
  const projects = await prisma.project.findMany({ where: { batchId }, orderBy: { createdAt: "asc" } });
  const { enqueue } = await import("@/jobs/queue");
  let queued = 0;
  const skipped: { title: string; reason: string }[] = [];
  for (const p of projects) {
    if (!controlsOf(p).audio.mixer) {
      skipped.push({ title: p.title, reason: "chưa bật Audio Mixer" });
      continue;
    }
    const a = await remixAvailability(p.id);
    if (!a.ok) {
      skipped.push({ title: p.title, reason: a.finalVideoPath ? "không còn track nguồn (cần render lại 1 lần)" : "chưa có video đã xuất" });
      continue;
    }
    await enqueue({ type: "remix_audio", projectId: p.id, batchId, priority: 500, maxAttempts: 1 });
    queued += 1;
  }
  return { queued, skipped };
}

/** Exposed for the preset form: the fields a mixer has, with their bounds applied. */
export function cleanMixer(raw: unknown) {
  return AudioMixerSchema.parse(raw);
}
