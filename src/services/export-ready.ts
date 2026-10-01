import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { isInsideData } from "@/lib/paths";
import { ffmpeg, ffprobe } from "@/media/ffmpeg";

/**
 * EXPORT READY (V1.2 Phase 6, QĐ-114): may this export folder be posted?
 *
 * Local only - ffprobe and one FFmpeg decode. A video is READY TO PUBLISH when
 * every REQUIRED check passes; warnings are shown but do not block.
 *
 *   final.mp4    exists, non-empty, ffprobe reads it, duration > 0, has video
 *   audio        an audio stream when the video has voice
 *   black        no black stretch at the very start, and not mostly black
 *                (blackdetect d=0.5 pix_th=0.10 - the rule the timing tests use);
 *                other black stretches are a warning (a black scene can be art)
 *   subtitles    subtitles.srt when the preset exports one
 *   thumbnail    thumbnail.jpg when the preset makes one
 *   metadata     metadata.json when the preset writes one (and it parses)
 *   paths        folder inside data/, path length Windows can open
 */

export interface ExportCheck {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

export interface ExportReadyResult {
  ready: boolean;
  checkedAt: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  checks: ExportCheck[];
}

/** Windows MAX_PATH is 260 with the terminating NUL; leave room for a copy "(1)". */
const WINDOWS_PATH_LIMIT = 250;

async function probe(file: string): Promise<{ duration: number; width: number; height: number; fps: number; hasAudio: boolean } | null> {
  try {
    const { stdout } = await ffprobe([
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", file,
    ]);
    const data = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>;
    };
    const video = data.streams?.find((s) => s.codec_type === "video");
    if (!video) return null;
    const [num, den] = (video.r_frame_rate ?? "0/1").split("/").map(Number);
    return {
      duration: Number(data.format?.duration ?? 0),
      width: video.width ?? 0,
      height: video.height ?? 0,
      fps: den ? Math.round(((num ?? 0) / den) * 100) / 100 : 0,
      hasAudio: Boolean(data.streams?.some((s) => s.codec_type === "audio")),
    };
  } catch {
    return null;
  }
}

async function blackStretches(file: string): Promise<Array<{ start: number; end: number }>> {
  const { stderr } = await ffmpeg(
    ["-hide_banner", "-i", file, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-an", "-f", "null", "-"],
    { keepAllOutput: true },
  );
  const out: Array<{ start: number; end: number }> = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /black_start:([\d.]+)\s+black_end:([\d.]+)/.exec(line);
    if (m) out.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  return out;
}

export async function checkExportFolder(opts: {
  dir: string;
  expectAudio: boolean;
  expectSrt: boolean;
  expectThumbnail: boolean;
  expectMetadata: boolean;
}): Promise<ExportReadyResult> {
  const checks: ExportCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string, required = true) =>
    checks.push({ id, label, ok, required, detail });

  const mp4 = path.join(opts.dir, "final.mp4");
  const exists = fs.existsSync(mp4) && fs.statSync(mp4).size > 0;
  add("mp4", "Có final.mp4", exists, exists ? `${fs.statSync(mp4).size} byte` : "Không thấy final.mp4 (hoặc rỗng)");
  const info = exists ? await probe(mp4) : null;
  add("playable", "ffprobe đọc được", info !== null, info ? `${info.width}x${info.height} · ${info.fps} fps` : "ffprobe không đọc được luồng video");
  add("duration", "Thời lượng > 0", (info?.duration ?? 0) > 0, info ? `${info.duration.toFixed(3)}s` : "—");
  if (opts.expectAudio) {
    add("audio", "Có âm thanh", info?.hasAudio === true, info?.hasAudio ? "có luồng audio" : "video có lời nhưng không có luồng audio");
  }
  if (info && info.duration > 0) {
    const black = await blackStretches(mp4).catch(() => []);
    const blackTotal = black.reduce((n, b) => n + (b.end - b.start), 0);
    const atStart = black.some((b) => b.start < 0.05 && b.end - b.start >= 0.5);
    const mostly = blackTotal > info.duration * 0.5;
    add(
      "black",
      "Không có đoạn đen bất thường",
      !atStart && !mostly,
      black.length === 0
        ? "không có đoạn đen ≥ 0,5s"
        : `${black.length} đoạn đen, tổng ${blackTotal.toFixed(2)}s` + (atStart ? " — có đoạn đen ngay đầu video" : "") + (mostly ? " — quá nửa video là đen" : ""),
    );
    if (black.length > 0 && !atStart && !mostly) {
      add("black-note", "Đoạn tối (cảnh báo)", false, `${black.length} đoạn tối trong video — kiểm tra bằng mắt nếu không chủ ý`, false);
    }
  }
  if (opts.expectSrt) {
    const srt = path.join(opts.dir, "subtitles.srt");
    const ok = fs.existsSync(srt) && fs.statSync(srt).size > 0;
    add("srt", "Có subtitles.srt", ok, ok ? "có" : "preset yêu cầu SRT nhưng không có file");
  }
  if (opts.expectThumbnail) {
    const jpg = path.join(opts.dir, "thumbnail.jpg");
    const ok = fs.existsSync(jpg) && fs.statSync(jpg).size > 0;
    add("thumbnail", "Có thumbnail.jpg", ok, ok ? "có" : "thiếu thumbnail");
  }
  if (opts.expectMetadata) {
    const meta = path.join(opts.dir, "metadata.json");
    let ok = false;
    try {
      JSON.parse(fs.readFileSync(meta, "utf8"));
      ok = true;
    } catch {
      ok = false;
    }
    add("metadata", "Có metadata.json hợp lệ", ok, ok ? "có" : "thiếu hoặc không đọc được metadata.json");
  }
  const longest = Math.max(
    ...["final.mp4", "subtitles.srt", "thumbnail.jpg", "metadata.json", "description.txt"].map((f) => path.join(opts.dir, f).length),
  );
  add(
    "paths",
    "Đường dẫn hợp lệ",
    isInsideData(opts.dir) && longest <= WINDOWS_PATH_LIMIT,
    `${longest} ký tự${isInsideData(opts.dir) ? "" : " — nằm ngoài thư mục data"}`,
  );

  return {
    ready: checks.every((c) => c.ok || !c.required),
    checkedAt: new Date().toISOString(),
    durationSec: info ? Math.round(info.duration * 1000) / 1000 : null,
    width: info?.width ?? null,
    height: info?.height ?? null,
    fps: info?.fps ?? null,
    hasAudio: info?.hasAudio ?? false,
    checks,
  };
}

/** Does this project's video carry speech (and so needs an audio stream)? */
export async function projectHasVoice(projectId: string): Promise<boolean> {
  const lines = await prisma.dialogueLine.count({ where: { scene: { projectId, skipped: false }, status: "completed" } });
  if (lines > 0) return true;
  const legacy = await prisma.scene.count({ where: { projectId, skipped: false, audioPath: { not: null } } });
  return legacy > 0;
}
