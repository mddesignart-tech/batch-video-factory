import type { CameraIntent, CameraMode } from "./camera-intent";

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

// ------------------------------------------------------- guardrail blocks ---
//
// One shared set, appended as the LAST step before a prompt goes to a video
// model. They exist because of a measured failure: the same scene, same
// keyframe and same model scored camera 1/10 without a lock and 10/10 with one.
//
// Split by concern rather than written as one paragraph, so a DIRECTED_CAMERA
// scene can take the identity, framing and final-frame rules while skipping the
// movement prohibitions that would contradict its own direction.

/** Only for LOCKED_CAMERA. Contradicts a script that asked for a move. */
export const CAMERA_LOCK_GUARDRAIL =
  "Locked tripod camera. No zoom. No push-in. No pull-back. No pan. No tilt. " +
  "No orbit. No reframing. Keep the exact opening composition for the entire shot.";

/**
 * For DIRECTED_CAMERA. Says what must NOT happen without forbidding the move
 * the script asked for.
 *
 * The distinction is the whole reason there are two modes: "do not invent
 * camera movement beyond what is described" permits the scripted pan and bans
 * everything else, where "No pan" would simply fight the direction and leave
 * the model to decide which instruction wins.
 */
export const CAMERA_DIRECTED_GUARDRAIL =
  "Perform only the camera movement described above. Do not invent any " +
  "additional camera movement, and keep the movement smooth and minimal.";

/** Both modes: the subject stays whole and inside the frame. */
export const FRAMING_GUARDRAIL =
  "Keep all required characters completely inside the frame at all times. " +
  "Do not crop heads, hands, arms, legs, or feet.";

/** Both modes. */
export const IDENTITY_GUARDRAIL =
  "Preserve exactly the same face, hair, clothing, body proportions, colors, " +
  "and accessories as the reference image. No morphing. No identity drift.";

/** Both modes. */
export const MOTION_GUARDRAIL =
  "Only perform the explicitly requested character action. Do not invent " +
  "unnecessary body movement.";

/** LOCKED_CAMERA only: a directed shot is allowed to end somewhere else. */
export const FINAL_FRAME_GUARDRAIL =
  "The final frame must preserve the same framing, character scale, camera " +
  "position, and overall composition as the opening frame.";

/** LOCKED_CAMERA only. */
export const SCALE_GUARDRAIL =
  "Preserve the same character scale and camera position from the first frame " +
  "to the final frame.";

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

// ------------------------------------------------ applying the guardrails ---

/**
 * Sentences already present in a prompt that make a guardrail redundant.
 *
 * Matched on MEANING, not on exact text. A legacy prompt saying "Static camera.
 * No camera movement." already locks the camera; appending the full lock block
 * on top would produce "Static camera. No camera movement. Locked tripod
 * camera. No zoom..." - longer, no clearer, and closer to the vendor's 1000
 * character ceiling for nothing.
 *
 * Note what is deliberately NOT here: "Static camera" alone does NOT count as
 * satisfying the lock. That exact phrasing is the one that failed - the clip
 * that scored 1/10 said "Static camera. No camera movement." and pushed in
 * anyway. Every prompt that held the camera contained the word "locked". So a
 * prompt has to say "locked" (or tripod/fixed) before this code believes it.
 */
const ALREADY_SATISFIED: Record<string, RegExp> = {
  [CAMERA_LOCK_GUARDRAIL]: /\block(?:ed)?\s+(?:tripod\s+)?camera\b|\bcamera\s+(?:remains|is)\s+locked\b|\bstatic\s+locked\b|\blocked\s+(?:static|and stable)\b/i,
  [CAMERA_DIRECTED_GUARDRAIL]: /\bonly the camera movement described\b|\bdo not invent any additional camera movement\b/i,
  [FRAMING_GUARDRAIL]: /\bcompletely inside the frame\b|\bdo not crop\b/i,
  [IDENTITY_GUARDRAIL]: /\bpreserve exactly the same face\b/i,
  [MOTION_GUARDRAIL]: /\bonly perform the explicitly requested\b/i,
  [FINAL_FRAME_GUARDRAIL]: /\bfinal frame must preserve\b/i,
  [SCALE_GUARDRAIL]: /\bsame character scale and camera position\b/i,
};

export interface GuardedPrompt {
  text: string;
  mode: CameraMode;
  /** Guardrail blocks actually appended, in order. */
  added: string[];
  /** Blocks skipped because the prompt already said the same thing. */
  skipped: string[];
  chars: number;
  bytes: number;
  /** True when the vendor limit forced a block to be left off. */
  truncated: boolean;
  note: string;
}

/**
 * Append the camera/composition guardrails a prompt is missing. The LAST step
 * before a prompt is sent.
 *
 * Ordered on purpose - action first, constraints after - because a model reads
 * the opening as the subject and the tail as rules. Putting the rules first
 * buries the thing being generated:
 *
 *   1. the scene's own text (action, characters)   <- untouched
 *   2. camera intent
 *   3. identity
 *   4. framing / composition
 *   5. final frame
 *
 * Budget-aware: blocks are added while they fit and the first one that would
 * overflow stops the loop. Ordering therefore doubles as priority - the camera
 * rule is the one that has actually been measured to matter, so it goes first
 * and is the last thing to be dropped.
 */
export function applyCameraGuardrails(
  prompt: string,
  intent: CameraIntent,
  limit = RUNWAY_MAX_PROMPT_CHARS,
): GuardedPrompt {
  const blocks =
    intent.mode === "LOCKED_CAMERA"
      ? [
          CAMERA_LOCK_GUARDRAIL,
          IDENTITY_GUARDRAIL,
          FRAMING_GUARDRAIL,
          MOTION_GUARDRAIL,
          FINAL_FRAME_GUARDRAIL,
        ]
      : [
          // No FINAL_FRAME and no SCALE rule: a directed shot is allowed to end
          // on a different framing - that is what "then pan to Leo" means.
          CAMERA_DIRECTED_GUARDRAIL,
          IDENTITY_GUARDRAIL,
          FRAMING_GUARDRAIL,
          MOTION_GUARDRAIL,
        ];

  const base = prompt.trim();
  const added: string[] = [];
  const skipped: string[] = [];
  let text = base;
  let truncated = false;

  for (const block of blocks) {
    const satisfied = ALREADY_SATISFIED[block];
    if (satisfied && satisfied.test(text)) {
      skipped.push(block);
      continue;
    }
    const candidate = text === "" ? block : `${text}\n\n${block}`;
    if (candidate.length > limit) {
      truncated = true;
      break;
    }
    text = candidate;
    added.push(block);
  }

  return {
    text,
    mode: intent.mode,
    added,
    skipped,
    chars: text.length,
    bytes: utf8Bytes(text),
    truncated,
    note:
      `${intent.mode}: thêm ${added.length}, bỏ qua ${skipped.length} (đã có), ` +
      `${text.length}/${limit} ký tự${truncated ? " — HẾT CHỖ, thiếu guardrail" : ""}`,
  };
}

/**
 * Contradictions a prompt must never contain.
 *
 * A prompt that both forbids and requests the same move is worse than one that
 * does neither: the model picks, and it picks differently each run. This is the
 * check that stops the guardrail system from creating the very instability it
 * was built to remove.
 */
export function findPromptContradictions(text: string): string[] {
  const out: string[] = [];
  const t = text.toLowerCase();
  // The "asks for it" side must not fire on the PROHIBITION itself.
  //
  // `No push-in.` contains the string "push-in", so a naive request pattern
  // reads the guardrail as a request and reports every correctly locked prompt
  // as self-contradictory. An alarm that goes off on correct input is one
  // nobody reads, which is how the alarm stops working at all.
  const pairs: Array<[RegExp, RegExp, string]> = [
    [/\bno pan\b/, /(?<!\bno )(?<!\bnot )\b(?:slowly |smoothly )?pans?\s+(?:to|toward|across|left|right)\b/, "vừa cấm pan vừa yêu cầu pan"],
    [/\bno zoom\b/, /(?<!\bno )(?<!\bnot )\bzooms?\s+(?:in|out)\b/, "vừa cấm zoom vừa yêu cầu zoom"],
    [/\bno tilt\b/, /(?<!\bno )(?<!\bnot )\btilts?\s+(?:up|down)\b/, "vừa cấm tilt vừa yêu cầu tilt"],
    [/\bno push-in\b/, /(?<!\bno )(?<!\bnot )\bpush(?:es)?[- ]in\b/, "vừa cấm push-in vừa yêu cầu push-in"],
    [/\bno reframing\b/, /(?<!\bno )(?<!\bnot )\breframes?\b/, "vừa cấm reframe vừa yêu cầu reframe"],
    [/\bno orbit\b/, /(?<!\bno )(?<!\bnot )\borbits?\s+(?:around|the)\b/, "vừa cấm orbit vừa yêu cầu orbit"],
  ];
  for (const [ban, ask, msg] of pairs) {
    if (ban.test(t) && ask.test(t)) out.push(msg);
  }
  // The same block appended twice - the dedupe failing in the other direction.
  for (const [name, re] of [
    ["khoá camera", /locked tripod camera/g],
    ["identity", /preserve exactly the same face/g],
    ["final frame", /final frame must preserve/g],
  ] as Array<[string, RegExp]>) {
    const n = (t.match(re) ?? []).length;
    if (n > 1) out.push(`guardrail ${name} bị lặp ${n} lần`);
  }
  return out;
}
