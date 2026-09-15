/**
 * Does this scene's script actually ask the camera to move?
 *
 * Worth being precise about, because getting it wrong is expensive in both
 * directions. A scene that should have been locked and was not produced the
 * worst clip this project has paid for: h3_max pushed from a full-body wide
 * shot to a headshot in 1.3 seconds, cropping out the pointing hand the scene
 * was about, and scored 1/10 on camera. The identical scene with a camera-lock
 * guardrail scored 10/10 - same model, same keyframe, only the prompt differed.
 *
 * But blanket-locking every scene is its own bug. A script that says "then pan
 * to Leo" is asking for a pan on purpose, and appending "No pan" to it would
 * contradict the direction and leave the model to pick a winner.
 *
 * WHERE THE SIGNAL COMES FROM
 * ---------------------------
 * `Scene.camera` - the script generator's own camera direction, e.g.
 * "Medium shot of Leo." or "Close-up on Max, then pan to Leo." That is a
 * structural field written when the scene was authored, which makes it a far
 * better source than scanning the finished prompt for the word "camera": the
 * prompt is a rendering of the intent, and the intent is what we want.
 *
 * The matching is on MOVEMENT VERBS and on framing-CHANGE constructions
 * ("then close on", "then cut to"), not on the presence of camera vocabulary.
 * "Wide shot centered on desk" names a camera and moves nothing.
 */

export const CAMERA_MODES = ["LOCKED_CAMERA", "DIRECTED_CAMERA"] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

/**
 * Camera moves a director asks for on purpose.
 *
 * Word-boundary anchored. Without \b, "pan" matches "panicked" - and one of
 * this project's real scenes is literally "close on Max's panicked face",
 * which would have been misread as a pan and had its lock removed.
 */
const MOVEMENT_PATTERNS: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /\bpans?\b|\bpanning\b/i, name: "pan" },
  { re: /\btilts?\b|\btilting\b/i, name: "tilt" },
  { re: /\bzooms?\b|\bzooming\b/i, name: "zoom" },
  { re: /\bpush[- ]?in\b|\bpushes in\b/i, name: "push-in" },
  { re: /\bpull[- ]?back\b|\bpulls back\b|\bpull[- ]?out\b/i, name: "pull-back" },
  { re: /\bdolly\b|\bdollies\b/i, name: "dolly" },
  { re: /\btrucks?\b|\btracking shot\b|\btracks? (?:with|along)\b/i, name: "tracking" },
  { re: /\bfollow(?:s|ing)\b/i, name: "follow" },
  { re: /\borbits?\b|\borbiting\b/i, name: "orbit" },
  { re: /\bcranes?\b|\bcraning\b/i, name: "crane" },
  { re: /\bhandheld\b|\bshaky cam\b/i, name: "handheld" },
  { re: /\breframes?\b|\breframing\b/i, name: "reframe" },
  { re: /\bwhip\b/i, name: "whip" },
];

/**
 * "A, then B" - the framing changes partway through, which is a camera move
 * even when no movement verb appears. "Wide shot of whole room, then close on
 * Max's face" is a push-in described without the word.
 */
const FRAMING_CHANGE = /,\s*then\b|\bthen\s+(?:cut|close|widen|move|go)\b/i;

/** Phrases that state the camera is pinned, so nothing else needs reading. */
const EXPLICIT_LOCK = /\block(?:ed)?\b|\bstatic\b|\bfixed\b|\btripod\b/i;

export interface CameraIntent {
  mode: CameraMode;
  /** Movement names found, for the report and for the prompt composer. */
  movements: string[];
  /** Why this mode was chosen, in the operator's language. */
  reason: string;
  /**
   * True when nothing in the script said anything either way.
   *
   * Reported rather than hidden: defaulting to LOCKED is the right call for
   * this project's material, but "we defaulted" and "the script asked for it"
   * are different facts and an audit should be able to tell them apart.
   */
  defaulted: boolean;
}

export interface CameraIntentInput {
  /** `Scene.camera` - the script's own camera direction. */
  camera?: string | null;
  /** Fallback only, when `camera` is empty. */
  visualDescription?: string | null;
}

/**
 * Classify one scene.
 *
 * Order matters. An explicit lock wins outright: "Locked static shot" is a
 * decision already made, and a movement word appearing later in the same
 * sentence ("locked, no pan") is a prohibition, not a request.
 */
export function classifyCameraIntent(input: CameraIntentInput): CameraIntent {
  const direction = (input.camera ?? "").trim();
  const source = direction || (input.visualDescription ?? "").trim();

  if (source === "") {
    return {
      mode: "LOCKED_CAMERA",
      movements: [],
      reason: "kịch bản không ghi ý đồ camera — mặc định khoá máy",
      defaulted: true,
    };
  }

  if (EXPLICIT_LOCK.test(source)) {
    return {
      mode: "LOCKED_CAMERA",
      movements: [],
      reason: `kịch bản ghi rõ máy đứng yên: "${source}"`,
      defaulted: false,
    };
  }

  const movements = MOVEMENT_PATTERNS.filter((p) => p.re.test(source)).map((p) => p.name);
  if (movements.length > 0) {
    return {
      mode: "DIRECTED_CAMERA",
      movements,
      reason: `kịch bản yêu cầu ${movements.join(", ")}: "${source}"`,
      defaulted: false,
    };
  }

  if (FRAMING_CHANGE.test(source)) {
    return {
      mode: "DIRECTED_CAMERA",
      movements: ["framing change"],
      reason: `kịch bản đổi khung giữa cảnh: "${source}"`,
      defaulted: false,
    };
  }

  // A shot SIZE with no movement. "Medium shot of Leo" tells the camera where
  // to stand, not where to go - so it stays there.
  return {
    mode: "LOCKED_CAMERA",
    movements: [],
    reason: `chỉ mô tả cỡ cảnh, không có chuyển động: "${source}"`,
    defaulted: false,
  };
}
