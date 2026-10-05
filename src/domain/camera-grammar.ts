/**
 * CAMERA GRAMMAR LIBRARY (QĐ-128) - one standard vocabulary for every camera
 * decision: shot size, angle, movement, focus. Pure: no database, no provider.
 *
 * Nobody - the AI Camera Director, a person, a template - writes camera
 * direction as free text any more. A plan is four ids from these lists, and
 * the words a provider sees are generated HERE, always the same for the same
 * plan. That keeps prompts consistent and keeps two things that are easy to
 * confuse apart:
 *
 *   ZOOM   changes framing only (the lens). The camera does not move, so the
 *          perspective does not change. A still picture can do it perfectly.
 *   DOLLY  / PUSH / PULL: the camera itself travels. Foreground and background
 *          shift against each other. A still can only APPROXIMATE it.
 *
 * `localSupport` states honestly what the local FFmpeg renderer can do with a
 * single picture: EXACT (indistinguishable), APPROX (a convincing stand-in),
 * or NONE (needs real 3-D motion - Video AI, or a fallback).
 */

import { z } from "zod";

// --------------------------------------------------------------- shot size ---

export const SHOT_SIZES = ["MACRO", "EXTREME_CLOSE_UP", "CLOSE_UP", "MEDIUM_CLOSE_UP", "MEDIUM", "MEDIUM_WIDE", "FULL_SHOT", "WIDE", "ESTABLISHING"] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];

export const VI_SHOT_SIZE: Record<ShotSize, string> = {
  MACRO: "Siêu cận (macro)",
  EXTREME_CLOSE_UP: "Siêu cận",
  CLOSE_UP: "Cận",
  MEDIUM_CLOSE_UP: "Bán cận",
  MEDIUM: "Trung",
  MEDIUM_WIDE: "Trung rộng",
  FULL_SHOT: "Toàn thân",
  WIDE: "Rộng",
  ESTABLISHING: "Toàn cảnh",
};

const SHOT_PHRASE: Record<ShotSize, string> = {
  MACRO: "Macro shot",
  EXTREME_CLOSE_UP: "Extreme close-up",
  CLOSE_UP: "Close-up",
  MEDIUM_CLOSE_UP: "Medium close-up",
  MEDIUM: "Medium shot",
  MEDIUM_WIDE: "Medium wide shot",
  FULL_SHOT: "Full shot",
  WIDE: "Wide shot",
  ESTABLISHING: "Establishing wide shot",
};

/** 0 = tightest, 8 = widest. Used for continuity ("do not jump three sizes for no reason"). */
export function shotRank(s: ShotSize): number {
  return SHOT_SIZES.indexOf(s);
}

// ------------------------------------------------------------------- angle ---

export const CAMERA_ANGLES = ["EYE_LEVEL", "HIGH_ANGLE", "LOW_ANGLE", "BIRD_EYE", "WORM_EYE", "OVER_SHOULDER", "POV", "THREE_QUARTER", "TOP_DOWN"] as const;
export type CameraAngle = (typeof CAMERA_ANGLES)[number];

export const VI_CAMERA_ANGLE: Record<CameraAngle, string> = {
  EYE_LEVEL: "Ngang tầm mắt",
  HIGH_ANGLE: "Góc cao",
  LOW_ANGLE: "Góc thấp",
  BIRD_EYE: "Mắt chim",
  WORM_EYE: "Từ dưới lên",
  OVER_SHOULDER: "Qua vai",
  POV: "Góc nhìn nhân vật",
  THREE_QUARTER: "Góc 3/4",
  TOP_DOWN: "Từ trên xuống",
};

/** Angles shown in Simple Mode; the rest are under Nâng cao. */
export const SIMPLE_ANGLES: readonly CameraAngle[] = ["EYE_LEVEL", "HIGH_ANGLE", "LOW_ANGLE", "THREE_QUARTER"];

const ANGLE_PHRASE: Record<CameraAngle, string> = {
  EYE_LEVEL: "eye level",
  HIGH_ANGLE: "high angle",
  LOW_ANGLE: "low angle",
  BIRD_EYE: "bird's-eye view",
  WORM_EYE: "worm's-eye view",
  OVER_SHOULDER: "over-the-shoulder",
  POV: "point-of-view shot",
  THREE_QUARTER: "three-quarter angle",
  TOP_DOWN: "top-down view",
};

// ---------------------------------------------------------------- movement ---

export const CAMERA_MOVES = [
  "STATIC",
  "SLOW_ZOOM_IN",
  "SLOW_ZOOM_OUT",
  "PAN_LEFT",
  "PAN_RIGHT",
  "PAN_UP",
  "PAN_DOWN",
  "TILT_UP",
  "TILT_DOWN",
  "PUSH_IN",
  "PULL_BACK",
  "DOLLY_IN",
  "DOLLY_OUT",
  "TRACK_LEFT",
  "TRACK_RIGHT",
  "TRUCK_LEFT",
  "TRUCK_RIGHT",
  "ORBIT_LEFT",
  "ORBIT_RIGHT",
  "ARC",
  "CRANE_UP",
  "CRANE_DOWN",
  "PARALLAX",
  "HANDHELD_SOFT",
  "GIMBAL",
  "WHIP_PAN",
  "CRASH_ZOOM",
  "AUTO",
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const VI_CAMERA_MOVE: Record<CameraMove, string> = {
  STATIC: "Đứng yên",
  SLOW_ZOOM_IN: "Zoom vào chậm",
  SLOW_ZOOM_OUT: "Zoom ra chậm",
  PAN_LEFT: "Lia trái",
  PAN_RIGHT: "Lia phải",
  PAN_UP: "Lia lên",
  PAN_DOWN: "Lia xuống",
  TILT_UP: "Ngửa máy lên",
  TILT_DOWN: "Chúc máy xuống",
  PUSH_IN: "Đẩy máy vào",
  PULL_BACK: "Kéo máy ra",
  DOLLY_IN: "Dolly vào",
  DOLLY_OUT: "Dolly ra",
  TRACK_LEFT: "Bám theo sang trái",
  TRACK_RIGHT: "Bám theo sang phải",
  TRUCK_LEFT: "Trượt ngang trái",
  TRUCK_RIGHT: "Trượt ngang phải",
  ORBIT_LEFT: "Xoay quanh trái",
  ORBIT_RIGHT: "Xoay quanh phải",
  ARC: "Vòng cung",
  CRANE_UP: "Cẩu lên",
  CRANE_DOWN: "Cẩu xuống",
  PARALLAX: "Parallax (chiều sâu)",
  HANDHELD_SOFT: "Cầm tay nhẹ",
  GIMBAL: "Gimbal mượt",
  WHIP_PAN: "Lia nhanh (whip)",
  CRASH_ZOOM: "Zoom gắt",
  AUTO: "Tự động",
};

/** Moves offered in Simple Mode ("ĐỔI CAMERA"); everything else is Nâng cao. */
export const SIMPLE_MOVES: readonly CameraMove[] = ["STATIC", "SLOW_ZOOM_IN", "SLOW_ZOOM_OUT", "PAN_LEFT", "PAN_RIGHT", "PUSH_IN", "PULL_BACK", "HANDHELD_SOFT"];

/**
 * The exact words a provider gets. Zoom is said as a LENS move with the camera
 * still; dolly / push / pull as the CAMERA moving. Never mixed.
 */
const MOVE_PHRASE: Record<Exclude<CameraMove, "AUTO">, string> = {
  STATIC: "Static locked camera, no camera movement",
  SLOW_ZOOM_IN: "Slow lens zoom in (camera stays in place)",
  SLOW_ZOOM_OUT: "Slow lens zoom out (camera stays in place)",
  PAN_LEFT: "Slow pan left (camera rotates on the spot)",
  PAN_RIGHT: "Slow pan right (camera rotates on the spot)",
  PAN_UP: "Slow pan up",
  PAN_DOWN: "Slow pan down",
  TILT_UP: "Slow tilt up",
  TILT_DOWN: "Slow tilt down",
  PUSH_IN: "Gentle push in (camera moves forward toward the subject)",
  PULL_BACK: "Gentle pull back (camera moves backward away from the subject)",
  DOLLY_IN: "Dolly in (camera travels forward, perspective shifts)",
  DOLLY_OUT: "Dolly out (camera travels backward, perspective shifts)",
  TRACK_LEFT: "Tracking shot moving left alongside the subject",
  TRACK_RIGHT: "Tracking shot moving right alongside the subject",
  TRUCK_LEFT: "Camera trucks left (slides sideways)",
  TRUCK_RIGHT: "Camera trucks right (slides sideways)",
  ORBIT_LEFT: "Camera orbits left around the subject",
  ORBIT_RIGHT: "Camera orbits right around the subject",
  ARC: "Camera arcs around the subject",
  CRANE_UP: "Crane up (camera rises)",
  CRANE_DOWN: "Crane down (camera lowers)",
  PARALLAX: "Subtle parallax: foreground and background move at different speeds",
  HANDHELD_SOFT: "Soft handheld feel, very slight natural sway",
  GIMBAL: "Smooth gimbal movement",
  WHIP_PAN: "Quick whip pan",
  CRASH_ZOOM: "Fast crash zoom in",
};

/** What the local renderer can do with one picture. */
export type LocalSupport = "EXACT" | "APPROX" | "NONE";
const LOCAL_SUPPORT: Record<Exclude<CameraMove, "AUTO">, LocalSupport> = {
  STATIC: "EXACT",
  SLOW_ZOOM_IN: "EXACT",
  SLOW_ZOOM_OUT: "EXACT",
  PAN_LEFT: "EXACT",
  PAN_RIGHT: "EXACT",
  PAN_UP: "EXACT",
  PAN_DOWN: "EXACT",
  TILT_UP: "EXACT",
  TILT_DOWN: "EXACT",
  PUSH_IN: "APPROX",
  PULL_BACK: "APPROX",
  DOLLY_IN: "APPROX",
  DOLLY_OUT: "APPROX",
  TRACK_LEFT: "APPROX",
  TRACK_RIGHT: "APPROX",
  TRUCK_LEFT: "APPROX",
  TRUCK_RIGHT: "APPROX",
  PARALLAX: "APPROX",
  HANDHELD_SOFT: "APPROX",
  GIMBAL: "APPROX",
  WHIP_PAN: "APPROX",
  CRASH_ZOOM: "EXACT",
  ORBIT_LEFT: "NONE",
  ORBIT_RIGHT: "NONE",
  ARC: "NONE",
  CRANE_UP: "NONE",
  CRANE_DOWN: "NONE",
};

export function localSupport(move: CameraMove): LocalSupport {
  return move === "AUTO" ? "EXACT" : LOCAL_SUPPORT[move];
}

/** The local stand-in for a move a still cannot really do (orbit, crane...). */
export function localFallbackMove(move: CameraMove): CameraMove {
  switch (move) {
    case "ORBIT_LEFT":
    case "ARC":
      return "TRUCK_LEFT";
    case "ORBIT_RIGHT":
      return "TRUCK_RIGHT";
    case "CRANE_UP":
      return "TILT_UP";
    case "CRANE_DOWN":
      return "TILT_DOWN";
    case "AUTO":
      return "SLOW_ZOOM_IN";
    default:
      return move;
  }
}

/** Moves that are attention-grabbing effects; professional / documentary never get them. */
export const EFFECT_MOVES: readonly CameraMove[] = ["WHIP_PAN", "CRASH_ZOOM"];

// ------------------------------------------------------------------- focus ---

export const FOCUS_STYLES = ["DEEP_FOCUS", "SHALLOW_FOCUS", "RACK_FOCUS", "SOFT_FOCUS", "AUTO"] as const;
export type FocusStyle = (typeof FOCUS_STYLES)[number];

export const VI_FOCUS: Record<FocusStyle, string> = {
  DEEP_FOCUS: "Rõ toàn cảnh",
  SHALLOW_FOCUS: "Focus chủ thể (xoá phông)",
  RACK_FOCUS: "Chuyển focus",
  SOFT_FOCUS: "Focus mềm",
  AUTO: "Tự động",
};

const FOCUS_PHRASE: Record<Exclude<FocusStyle, "AUTO">, string> = {
  DEEP_FOCUS: "deep focus, background sharp",
  SHALLOW_FOCUS: "shallow depth of field, subject in sharp focus, softly blurred background",
  RACK_FOCUS: "rack focus from foreground to the subject",
  SOFT_FOCUS: "soft focus, gentle glow",
};

/**
 * Focus is a PICTURE property. The local renderer has no depth data, so it
 * never fakes a rack focus: focus goes into the Image / Video prompt only.
 */
export const LOCAL_RENDERS_FOCUS = false;

// ------------------------------------------------------------------- speed ---

export const CAMERA_SPEEDS = ["VERY_SLOW", "SLOW", "MEDIUM", "FAST"] as const;
export type CameraSpeed = (typeof CAMERA_SPEEDS)[number];
export const VI_CAMERA_SPEED: Record<CameraSpeed, string> = { VERY_SLOW: "Rất chậm", SLOW: "Chậm", MEDIUM: "Vừa", FAST: "Nhanh" };

// ------------------------------------------------------------- transitions ---

/** How this scene is joined to the one before it. CUT/NONE = hard cut; the rest render as an xfade (media/transitions.ts). */
export const TRANSITIONS = ["CUT", "CROSSFADE", "WHIP", "ZOOM", "MATCH", "NONE"] as const;
export type Transition = (typeof TRANSITIONS)[number];
export const VI_TRANSITION: Record<Transition, string> = {
  CUT: "Cắt thẳng",
  CROSSFADE: "Hoà tan (crossfade)",
  WHIP: "Lia nhanh (whip)",
  ZOOM: "Zoom chuyển",
  MATCH: "Match cut (hoà nhanh)",
  NONE: "Không",
};

// -------------------------------------------------------------------- plan ---

export const CameraPlanSchema = z.object({
  shotSize: z.enum(SHOT_SIZES),
  cameraAngle: z.enum(CAMERA_ANGLES),
  cameraMovement: z.enum(CAMERA_MOVES),
  cameraSpeed: z.enum(CAMERA_SPEEDS).default("SLOW"),
  focusStyle: z.enum(FOCUS_STYLES).default("AUTO"),
  /** Who / what the shot is about ("Leo", "Bình giữ nhiệt Mind"). */
  subjectFocus: z.string().max(120).default(""),
  /** UI / debug only. Never sent to a provider. */
  reason: z.string().max(400).default(""),
  transitionIn: z.enum(TRANSITIONS).default("CUT"),
  /** Who stands where in a conversation (screen direction is kept between shots). */
  screenLeft: z.array(z.string().max(60)).max(4).optional(),
  screenRight: z.array(z.string().max(60)).max(4).optional(),
});
export type CameraPlan = z.infer<typeof CameraPlanSchema>;

/**
 * The plan in provider words: "Medium shot, eye level, shallow depth of field,
 * subject in sharp focus... Gentle push in (camera moves forward...)."
 * The `reason` is never part of it.
 */
export function cameraPromptPhrase(plan: CameraPlan): string {
  const move = plan.cameraMovement === "AUTO" ? "SLOW_ZOOM_IN" : plan.cameraMovement;
  const framing = [SHOT_PHRASE[plan.shotSize], ANGLE_PHRASE[plan.cameraAngle]];
  if (plan.focusStyle !== "AUTO") framing.push(FOCUS_PHRASE[plan.focusStyle]);
  const subject = plan.subjectFocus ? ` on ${plan.subjectFocus}` : "";
  const speed = plan.cameraSpeed === "FAST" ? ", quick" : plan.cameraSpeed === "VERY_SLOW" ? ", very slow" : "";
  const sides =
    plan.screenLeft?.length && plan.screenRight?.length
      ? ` ${plan.screenLeft.join(" and ")} on the left, ${plan.screenRight.join(" and ")} on the right.`
      : "";
  return `${framing.join(", ")}${subject}. ${MOVE_PHRASE[move]}${move === "STATIC" ? "" : speed}.${sides}`;
}

/** Short Vietnamese summary for the scene editor ("Trung · Ngang tầm mắt · Đẩy máy vào"). */
export function cameraSummaryVi(plan: CameraPlan): string {
  const parts = [VI_SHOT_SIZE[plan.shotSize], VI_CAMERA_ANGLE[plan.cameraAngle], VI_CAMERA_MOVE[plan.cameraMovement]];
  if (plan.focusStyle !== "AUTO") parts.push(VI_FOCUS[plan.focusStyle]);
  return parts.join(" · ");
}
