import type { LoudnessStats } from "./audio-normalize";
import { VOICE_TARGET_LUFS, VOICE_TARGET_TRUE_PEAK } from "./audio-normalize";

/**
 * Reading a finished mix and saying what is wrong with it.
 *
 * These checks exist because the failures they catch are all silent. A clipped
 * mix, a voice buried under a bed, speech running past the end of the picture -
 * none of them throw, and all of them ship unless something measures the file
 * and objects.
 *
 * Every warning names a fix. A measurement that only reports a number leaves
 * the operator to work out what to do about it, and "integrated loudness is
 * -24.3 LUFS" is not an instruction.
 */

export type MixWarningKind =
  | "clipping"
  | "voice_too_quiet"
  | "voice_too_loud"
  | "music_over_voice"
  | "audio_longer_than_scene"
  | "scene_timing"
  | "empty_audio";

export type MixSeverity = "error" | "warning" | "info";

export interface MixWarning {
  kind: MixWarningKind;
  severity: MixSeverity;
  /** What is wrong, in the operator's language. */
  message: string;
  /** What to do about it. */
  suggestion: string;
}

export interface MixMetrics {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
  durationSec: number;
}

export interface MixCheckInput {
  mix: LoudnessStats;
  durationSec: number;
  /** The dialogue track before music and effects, when there is one to compare. */
  dialogue?: LoudnessStats;
  /** How long the visuals run. Speech beyond this has nowhere to be seen. */
  sceneDurationSec?: number;
}

/** Louder than this and the voice is competing with the mix, not leading it. */
const VOICE_TOLERANCE_LU = 2.5;

/**
 * How far the mix may sit above the dialogue alone.
 *
 * Music and effects add energy, so some rise is expected and healthy. More than
 * this means the bed is no longer underneath the voice - the single failure
 * this whole layer exists to prevent.
 */
const MAX_MIX_LIFT_LU = 2;

export function toMetrics(stats: LoudnessStats, durationSec: number): MixMetrics {
  return {
    integratedLufs: stats.integratedLufs,
    truePeakDb: stats.truePeakDb,
    lra: stats.lra,
    durationSec,
  };
}

export function checkMix(input: MixCheckInput): MixWarning[] {
  const warnings: MixWarning[] = [];
  const { mix, dialogue, durationSec, sceneDurationSec } = input;

  if (durationSec <= 0) {
    warnings.push({
      kind: "empty_audio",
      severity: "error",
      message: "Bản trộn không có âm thanh nào.",
      suggestion: "Kiểm tra xem cảnh có câu thoại nào đã tạo giọng thành công chưa.",
    });
    return warnings;
  }

  // Clipping. Measured as TRUE peak, not sample peak: a file can sit at -0.1
  // dBFS and still clip once a lossy encoder reconstructs it.
  if (mix.truePeakDb > 0) {
    warnings.push({
      kind: "clipping",
      severity: "error",
      message: `Đỉnh thật ${mix.truePeakDb.toFixed(2)} dBTP - âm thanh BỊ VỠ.`,
      suggestion:
        "Giảm Music Gain hoặc SFX Gain, rồi render lại. Không tăng âm lượng tổng.",
    });
  } else if (mix.truePeakDb > VOICE_TARGET_TRUE_PEAK + 0.5) {
    warnings.push({
      kind: "clipping",
      severity: "warning",
      message:
        `Đỉnh thật ${mix.truePeakDb.toFixed(2)} dBTP, cao hơn mức an toàn ` +
        `${VOICE_TARGET_TRUE_PEAK} dBTP.`,
      suggestion:
        "Còn đủ chỗ lúc này, nhưng khi nén sang AAC có thể vượt 0 và vỡ tiếng. " +
        "Giảm nhẹ Music Gain.",
    });
  }

  const offTarget = mix.integratedLufs - VOICE_TARGET_LUFS;
  if (offTarget < -VOICE_TOLERANCE_LU) {
    warnings.push({
      kind: "voice_too_quiet",
      severity: "warning",
      message:
        `Bản trộn ${mix.integratedLufs.toFixed(1)} LUFS, nhỏ hơn mục tiêu ` +
        `${VOICE_TARGET_LUFS} LUFS khoảng ${Math.abs(offTarget).toFixed(1)} LU.`,
      suggestion:
        "Người xem sẽ phải vặn to, rồi bị quảng cáo sau đó làm giật mình. " +
        "Kiểm tra xem các câu thoại đã qua bước chuẩn hoá chưa.",
    });
  } else if (offTarget > VOICE_TOLERANCE_LU) {
    warnings.push({
      kind: "voice_too_loud",
      severity: "warning",
      message:
        `Bản trộn ${mix.integratedLufs.toFixed(1)} LUFS, to hơn mục tiêu ` +
        `${VOICE_TARGET_LUFS} LUFS khoảng ${offTarget.toFixed(1)} LU.`,
      suggestion:
        "YouTube sẽ tự hạ xuống, và phần bị hạ là toàn bộ chứ không riêng nhạc. " +
        "Giảm Music Gain và SFX Gain.",
    });
  }

  // The check that matters most: did adding music and effects bury the voice?
  if (dialogue) {
    const lift = mix.integratedLufs - dialogue.integratedLufs;
    if (lift > MAX_MIX_LIFT_LU) {
      warnings.push({
        kind: "music_over_voice",
        severity: "error",
        message:
          `Sau khi thêm nhạc/SFX, bản trộn to hơn phần thoại ${lift.toFixed(1)} LU. ` +
          "Nhạc đang lấn lời chứ không còn nằm dưới.",
        suggestion:
          "Tăng Duck Amount, hoặc giảm Music Gain. Lời thoại phải là tín hiệu chính.",
      });
    }
  }

  // Speech that runs past the picture. Never solved by cutting the speech.
  if (sceneDurationSec !== undefined && durationSec > sceneDurationSec + 0.05) {
    const over = durationSec - sceneDurationSec;
    warnings.push({
      kind: "audio_longer_than_scene",
      severity: "warning",
      message:
        `Âm thanh dài hơn thời lượng cảnh ${over.toFixed(2)}s ` +
        `(${durationSec.toFixed(2)}s so với ${sceneDurationSec.toFixed(2)}s).`,
      suggestion:
        "Chọn một trong bốn cách, KHÔNG cắt lời thoại: " +
        "(1) kéo dài cảnh cho khớp âm thanh; " +
        "(2) giảm khoảng nghỉ giữa các câu; " +
        "(3) tăng nhẹ tốc độ đọc của nhân vật; " +
        "(4) viết lại lời thoại ngắn hơn. " +
        "Hệ thống không tự kéo giãn/nén thời gian vì sẽ làm méo giọng.",
    });
  }

  return warnings;
}

/** True when nothing found is bad enough to block a render. */
export function mixIsAcceptable(warnings: MixWarning[]): boolean {
  return !warnings.some((w) => w.severity === "error");
}

/** One-line summary for a log or a status row. */
export function summariseMix(metrics: MixMetrics, warnings: MixWarning[]): string {
  const head =
    `${metrics.integratedLufs.toFixed(1)} LUFS, ` +
    `${metrics.truePeakDb.toFixed(2)} dBTP, ` +
    `LRA ${metrics.lra.toFixed(1)}, ` +
    `${metrics.durationSec.toFixed(2)}s`;
  if (warnings.length === 0) return `${head} - đạt`;
  const errors = warnings.filter((w) => w.severity === "error").length;
  return `${head} - ${warnings.length} cảnh báo${errors > 0 ? `, ${errors} lỗi` : ""}`;
}
