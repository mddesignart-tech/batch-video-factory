/**
 * Fitting a video prompt into a vendor's character budget.
 *
 * Runway caps `promptText` at 1000 characters and answers a longer one with a
 * 400. That 400 is free, but it is still a paid-path failure discovered at the
 * worst moment, so the limit belongs somewhere the preflight can see it.
 *
 * The rule that makes this safe to automate: the MOVEMENT description is the
 * thing being generated and benchmarked, so it is never touched. Only the
 * trailing style-and-constraint boilerplate is rewritten, and the caller is
 * told exactly what changed. Silently trimming a prompt from the end would
 * quietly cut the motion and make two vendors incomparable.
 */

/** Runway's documented ceiling for `promptText`, confirmed by a live 400. */
export const RUNWAY_MAX_PROMPT_CHARS = 1000;

/**
 * The constraint block, compressed, for vendors with a tight prompt budget.
 *
 * Phrased positively on purpose. Runway's guidance is that negated phrasing
 * ("no camera pan", "avoid morphing") can cue the very thing it names, since
 * gen4_turbo has no negative-prompt channel to put it in. So this is not only
 * shorter than the long form, it is better suited to this vendor - which is
 * what makes rewriting it a syntax conversion rather than a weakening.
 */
export const COMPACT_CONSTRAINTS =
  "Static locked camera. Keep both characters exactly as in the source image: " +
  "same faces, hair, clothing, body proportions and relative height. " +
  "Natural expressive animation with clearly visible gestures. " +
  "No added characters, objects or text.";

/** Paragraph that carries the motion. Everything after it is boilerplate. */
const MOVEMENT_PREFIX = "Movement:";

export class PromptTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptTooLongError";
  }
}

export interface FittedPrompt {
  text: string;
  /** True when the boilerplate was swapped for the compact form. */
  changed: boolean;
  originalChars: number;
  finalChars: number;
  /**
   * UTF-8 bytes of the final text.
   *
   * Reported alongside the character count because the two differ the moment a
   * prompt contains anything outside ASCII, and a vendor limit may be stated in
   * either. Runway's is in characters - its own error said so - but recording
   * both means the next vendor's limit needs no guesswork.
   */
  finalBytes: number;
  /** Human-readable note for the log and the job record. */
  note: string;
}

/**
 * Fit a prompt to `limit`, preserving the scene setup and the movement verbatim.
 *
 * Throws rather than truncating when the parts that must be preserved do not
 * themselves fit: a prompt cut mid-sentence is a different prompt, and paying
 * for a benchmark of it would prove nothing.
 */
export function fitVideoPrompt(prompt: string, limit: number): FittedPrompt {
  const originalChars = prompt.length;
  if (originalChars <= limit) {
    return {
      text: prompt,
      changed: false,
      originalChars,
      finalChars: originalChars,
      finalBytes: utf8Bytes(prompt),
      note: `${originalChars} ký tự, trong giới hạn ${limit}`,
    };
  }

  const paragraphs = prompt.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const movementAt = paragraphs.findIndex((p) => p.startsWith(MOVEMENT_PREFIX));

  // Keep the setup and the movement; everything after the movement is the
  // style boilerplate this function is allowed to rewrite.
  const preserved =
    movementAt >= 0 ? paragraphs.slice(0, movementAt + 1) : paragraphs.slice(0, 1);

  const rebuilt = [...preserved, COMPACT_CONSTRAINTS].join("\n\n");
  if (rebuilt.length > limit) {
    throw new PromptTooLongError(
      `Prompt ${originalChars} ký tự vượt giới hạn ${limit} của nhà cung cấp, ` +
        `và phần bắt buộc giữ nguyên (bối cảnh + chuyển động) đã chiếm ` +
        `${rebuilt.length} ký tự. Không cắt ngang câu — hãy rút ngắn phần ` +
        `"Movement:" trong kịch bản rồi chạy lại.`,
    );
  }

  return {
    text: rebuilt,
    changed: true,
    originalChars,
    finalChars: rebuilt.length,
    finalBytes: utf8Bytes(rebuilt),
    note:
      `rút gọn ${originalChars} -> ${rebuilt.length} ký tự cho giới hạn ${limit}: ` +
      `giữ nguyên bối cảnh + "Movement:", thay khối ràng buộc bằng bản ngắn`,
  };
}

/**
 * UTF-8 byte length, without pulling in Node's Buffer.
 *
 * TextEncoder works in every runtime this code might end up in, and the count
 * is the same one a server sees on the wire.
 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
