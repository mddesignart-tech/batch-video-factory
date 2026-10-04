/**
 * AI CAMERA DIRECTOR (QĐ-128) - reads a scene the way a director would and
 * picks shot size, angle, movement, speed and focus from the Camera Grammar.
 *
 * It is deliberately a RULE BOOK, not a dice roll:
 *
 *   1. what KIND of moment is this? (dialogue, reaction, product, animal,
 *      emotional beat, establishing, ending, action, explanation)
 *   2. the classic shot for that moment (two-shot for a conversation,
 *      close-up for a reaction, product close-up, wide for a location...)
 *   3. the CREATIVE STYLE and the CAMERA PRESET shape it (comedy may crash
 *      zoom on a reaction; professional and documentary never do)
 *   4. REFERENCES win over flair: a CRITICAL product / animal is never
 *      whip-panned, crash-zoomed or orbited
 *   5. a CONTINUITY pass over the whole video: consistent pan direction,
 *      speakers keep their side of the screen, effects are rationed, and
 *      three identical shots in a row get a little variety.
 *
 * Same input, same plan - always. The `reason` is for the person (and debug),
 * never for a provider. Pure: no database, no provider.
 */

import { z } from "zod";
import {
  CameraPlanSchema,
  EFFECT_MOVES,
  localSupport,
  type CameraAngle,
  type CameraMove,
  type CameraPlan,
  type CameraSpeed,
  type FocusStyle,
  type ShotSize,
} from "./camera-grammar";
import { classifyMotionScale } from "./motion-scale";

// ---------------------------------------------------------------- presets ---

export const CAMERA_PRESETS = [
  { id: "AUTO", label: "Tự động" },
  { id: "NATURAL", label: "Tự nhiên" },
  { id: "STATIC", label: "Tĩnh" },
  { id: "GENTLE", label: "Nhẹ nhàng" },
  { id: "LIVELY", label: "Sinh động" },
  { id: "CINEMATIC", label: "Điện ảnh" },
  { id: "FAST_COMEDY", label: "Hài nhanh" },
  { id: "DOCUMENTARY", label: "Documentary" },
  { id: "PRODUCT_REVIEW", label: "Review sản phẩm" },
] as const;
export type CameraPresetId = (typeof CAMERA_PRESETS)[number]["id"];
export const CameraPresetSchema = z.enum(CAMERA_PRESETS.map((p) => p.id) as [CameraPresetId, ...CameraPresetId[]]);

// ---------------------------------------------------------------- inputs ---

export interface SceneSemantics {
  sceneNumber: number;
  /** Template beat role (hook, reaction, payoff, feature, ending...). */
  sceneRole?: string | null;
  dialogue?: string;
  narration?: string;
  visualDescription?: string;
  characterAction?: string;
  charactersPresent?: string[];
  speakingCharacters?: string[];
  /** References in this scene. */
  references?: { type: string; name: string; critical: boolean }[];
  duration: number;
}

export interface DirectorContext {
  contentType?: string | null;
  comedyLevel: number;
  tone: string;
  emotion: string;
  pacing: string;
  creativePreset: string;
  cameraPreset: CameraPresetId;
  /** Output frame, for framing that suits 9:16 vs 16:9. */
  width: number;
  height: number;
}

export type SceneKind =
  | "DIALOGUE"
  | "REACTION"
  | "PUNCHLINE"
  | "PRODUCT"
  | "PRODUCT_HANDLING"
  | "ANIMAL"
  | "EMOTIONAL"
  | "ESTABLISHING"
  | "ENDING"
  | "ACTION"
  | "EXPLAIN"
  | "SUBJECT";

const has = (text: string, re: RegExp) => re.test(text);
const ROLE_ENDING = /^(ending|cta|recap|conclusion|closing|verdict|sleep|contact|for-who|words)$/;
const ROLE_EXPLAIN = /^(meaning|explain|rule|word|fact|tip|step|question|example|usage|practice|how|mistake|key-phrase|what|offer|item)$/;
const LOCATION = /\b(street|city|town|road|park|forest|jungle|beach|kitchen|classroom|office|cafe|café|shop|store|room|bedroom|garden|farm|sky|mountain|lake|river|construction site|market|playground|school)\b/i;
const REACT = /\b(react|reaction|shock|shocked|surprised|stares?|gasps?|facepalm|jaw drops?|eyes? wide|laughs?|freezes)\b/i;
const HANDLE = /\b(holds?|holding|pours?|pouring|opens?|opening|presses?|uses?|using|unbox\w*|twists?|pick(?:s|ing)? up|demonstrat\w*)\b/i;

/** What kind of moment this is. Order matters: the most specific answer wins. */
export function sceneKind(s: SceneSemantics, ctx: Pick<DirectorContext, "contentType" | "comedyLevel" | "emotion">): SceneKind {
  const role = (s.sceneRole ?? "").toLowerCase();
  const words = `${s.visualDescription ?? ""} ${s.characterAction ?? ""}`;
  const speakers = new Set((s.speakingCharacters ?? []).filter((n) => n && n !== "Narrator"));
  const present = (s.charactersPresent ?? []).length;
  const product = (s.references ?? []).some((r) => r.type === "PRODUCT") || ((ctx.contentType === "PRODUCT_REVIEW" || ctx.contentType === "ADVERTISEMENT") && /feature|what|reveal|detail|pro|item|offer|reason|showcase/.test(role));
  const animal = (s.references ?? []).some((r) => r.type === "ANIMAL") || ctx.contentType === "ANIMAL_FACT";

  if (role === "payoff" || role === "punchline") return "PUNCHLINE";
  if (role === "reaction" || (ctx.comedyLevel >= 2 && has(words, REACT))) return "REACTION";
  if (ROLE_ENDING.test(role)) return "ENDING";
  if (role === "moment" || (ctx.comedyLevel <= 1 && (ctx.emotion === "TOUCHING" || ctx.emotion === "WARM") && role === "climax")) return "EMOTIONAL";
  if (product) return has(words, HANDLE) ? "PRODUCT_HANDLING" : "PRODUCT";
  if (classifyMotionScale({ characterAction: s.characterAction, visualDescription: s.visualDescription }).scale === "VIGOROUS") return "ACTION";
  if (speakers.size >= 2 || (present >= 2 && (s.dialogue ?? "").trim().length > 0)) return "DIALOGUE";
  if (animal) return "ANIMAL";
  if ((role === "hook" || role === "intro" || role === "habitat" || role === "establish") && present === 0 && has(words, LOCATION)) return "ESTABLISHING";
  if (present === 0 && has(words, LOCATION) && !ROLE_EXPLAIN.test(role)) return "ESTABLISHING";
  if (ROLE_EXPLAIN.test(role)) return "EXPLAIN";
  return "SUBJECT";
}

const VI_KIND: Record<SceneKind, string> = {
  DIALOGUE: "Cảnh đối thoại",
  REACTION: "Cảnh phản ứng",
  PUNCHLINE: "Cảnh punchline",
  PRODUCT: "Cảnh giới thiệu sản phẩm",
  PRODUCT_HANDLING: "Cảnh thao tác sản phẩm",
  ANIMAL: "Cảnh động vật",
  EMOTIONAL: "Cảnh cảm xúc",
  ESTABLISHING: "Cảnh giới thiệu địa điểm",
  ENDING: "Cảnh kết",
  ACTION: "Cảnh hành động",
  EXPLAIN: "Cảnh giải thích",
  SUBJECT: "Cảnh một chủ thể",
};

// ----------------------------------------------------------- base grammar ---

interface Draft {
  shotSize: ShotSize;
  cameraAngle: CameraAngle;
  cameraMovement: CameraMove;
  cameraSpeed: CameraSpeed;
  focusStyle: FocusStyle;
  why: string;
}

function baseShot(kind: SceneKind, s: SceneSemantics, ctx: DirectorContext): Draft {
  const portrait = ctx.height > ctx.width;
  switch (kind) {
    case "DIALOGUE":
      return { shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN", cameraSpeed: "VERY_SLOW", focusStyle: "SHALLOW_FOCUS", why: "giữ cả hai nhân vật trong khung (two-shot), đẩy máy rất nhẹ để tăng gần gũi" };
    case "REACTION":
      return { shotSize: "CLOSE_UP", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN", cameraSpeed: "MEDIUM", focusStyle: "SHALLOW_FOCUS", why: "cận mặt để thấy rõ biểu cảm phản ứng" };
    case "PUNCHLINE":
      return { shotSize: "CLOSE_UP", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN", cameraSpeed: "MEDIUM", focusStyle: "SHALLOW_FOCUS", why: "punchline cần cận phản ứng để câu đùa 'chạm'" };
    case "PRODUCT":
      return { shotSize: "CLOSE_UP", cameraAngle: "THREE_QUARTER", cameraMovement: "PAN_RIGHT", cameraSpeed: "VERY_SLOW", focusStyle: "SHALLOW_FOCUS", why: "cận sản phẩm, lia rất chậm, giữ sản phẩm ổn định và rõ nét" };
    case "PRODUCT_HANDLING":
      return { shotSize: "MEDIUM_CLOSE_UP", cameraAngle: "THREE_QUARTER", cameraMovement: "TRACK_RIGHT", cameraSpeed: "VERY_SLOW", focusStyle: "SHALLOW_FOCUS", why: "bán cận góc 3/4 để thấy tay thao tác và sản phẩm, bám nhẹ" };
    case "ANIMAL":
      return { shotSize: "MEDIUM_WIDE", cameraAngle: "EYE_LEVEL", cameraMovement: "TRACK_RIGHT", cameraSpeed: "SLOW", focusStyle: "DEEP_FOCUS", why: "trung rộng để thấy con vật trong môi trường, bám chậm, rõ cả nền" };
    case "EMOTIONAL":
      return { shotSize: "CLOSE_UP", cameraAngle: "EYE_LEVEL", cameraMovement: "DOLLY_IN", cameraSpeed: "VERY_SLOW", focusStyle: "SHALLOW_FOCUS", why: "cận và tiến máy rất chậm để dồn cảm xúc" };
    case "ESTABLISHING":
      return portrait
        ? { shotSize: "WIDE", cameraAngle: "EYE_LEVEL", cameraMovement: "TILT_DOWN", cameraSpeed: "SLOW", focusStyle: "DEEP_FOCUS", why: "giới thiệu địa điểm; khung dọc nên chúc máy từ trên xuống thay vì lia ngang" }
        : { shotSize: "ESTABLISHING", cameraAngle: "EYE_LEVEL", cameraMovement: "PAN_RIGHT", cameraSpeed: "SLOW", focusStyle: "DEEP_FOCUS", why: "toàn cảnh giới thiệu địa điểm, lia chậm" };
    case "ENDING":
      return { shotSize: "MEDIUM_WIDE", cameraAngle: "EYE_LEVEL", cameraMovement: "PULL_BACK", cameraSpeed: "SLOW", focusStyle: "DEEP_FOCUS", why: "cảnh kết: kéo máy ra chậm để khép lại video" };
    case "ACTION":
      return { shotSize: "MEDIUM_WIDE", cameraAngle: "EYE_LEVEL", cameraMovement: "TRACK_RIGHT", cameraSpeed: "MEDIUM", focusStyle: "DEEP_FOCUS", why: "cảnh hành động: bám theo chủ thể, không rung mạnh" };
    case "EXPLAIN":
      return { shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "SLOW_ZOOM_IN", cameraSpeed: "VERY_SLOW", focusStyle: "AUTO", why: "cảnh giải thích: khung ổn định, zoom rất nhẹ để không đứng hình" };
    default:
      return { shotSize: (s.charactersPresent ?? []).length ? "MEDIUM_CLOSE_UP" : "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN", cameraSpeed: "SLOW", focusStyle: "SHALLOW_FOCUS", why: "một chủ thể: bán cận, đẩy máy nhẹ" };
  }
}

/** The preset a project effectively uses: AUTO follows the creative style. */
export function effectiveCameraPreset(ctx: Pick<DirectorContext, "cameraPreset" | "comedyLevel" | "tone" | "creativePreset" | "contentType" | "emotion" | "pacing">): CameraPresetId {
  if (ctx.cameraPreset !== "AUTO") return ctx.cameraPreset;
  if (ctx.tone === "DOCUMENTARY" || ctx.creativePreset === "DOCUMENTARY") return "DOCUMENTARY";
  if (ctx.comedyLevel >= 4 || ctx.creativePreset === "TIKTOK_FUNNY" || ctx.creativePreset === "VIRAL_FAST") return "FAST_COMEDY";
  if (ctx.contentType === "PRODUCT_REVIEW" || ctx.contentType === "ADVERTISEMENT") return "PRODUCT_REVIEW";
  if (ctx.tone === "PROFESSIONAL" || ctx.tone === "PREMIUM") return "CINEMATIC";
  if (ctx.emotion === "TOUCHING" || ctx.tone === "EMOTIONAL" || ctx.tone === "DRAMATIC") return "CINEMATIC";
  if (ctx.tone === "PLAYFUL" || ctx.creativePreset === "CUTE" || ctx.tone === "GENTLE") return "GENTLE";
  if (ctx.tone === "ENERGETIC" || ctx.pacing === "FAST" || ctx.pacing === "VERY_FAST") return "LIVELY";
  return "NATURAL";
}

/** Professional / documentary / premium never get attention-grabbing effects. */
function effectsAllowed(ctx: DirectorContext, preset: CameraPresetId): boolean {
  if (["PROFESSIONAL", "PREMIUM", "DOCUMENTARY"].includes(ctx.tone)) return false;
  if (["PROFESSIONAL", "DOCUMENTARY", "PREMIUM", "EMOTIONAL"].includes(ctx.creativePreset)) return false;
  return preset === "FAST_COMEDY" || ctx.comedyLevel >= 3;
}

function styled(d: Draft, kind: SceneKind, ctx: DirectorContext, preset: CameraPresetId): Draft {
  const out = { ...d };
  const effects = effectsAllowed(ctx, preset);
  switch (preset) {
    case "STATIC":
      out.cameraMovement = "STATIC";
      out.why += "; preset Tĩnh: máy đứng yên";
      break;
    case "GENTLE":
      out.cameraSpeed = "VERY_SLOW";
      if (out.cameraMovement === "TRACK_RIGHT" || out.cameraMovement === "TRACK_LEFT") out.cameraMovement = "PAN_RIGHT";
      if (kind === "DIALOGUE" || kind === "SUBJECT") out.shotSize = "MEDIUM_CLOSE_UP";
      out.why += "; nhẹ nhàng: chuyển động mềm, chậm";
      break;
    case "CINEMATIC":
      if (out.cameraMovement === "SLOW_ZOOM_IN" || out.cameraMovement === "PUSH_IN") out.cameraMovement = "DOLLY_IN";
      if (out.cameraMovement === "PULL_BACK") out.cameraMovement = "DOLLY_OUT";
      if (out.cameraSpeed === "MEDIUM") out.cameraSpeed = "SLOW";
      if (out.focusStyle === "AUTO") out.focusStyle = "SHALLOW_FOCUS";
      out.why += "; điện ảnh: dolly chậm, xoá phông";
      break;
    case "LIVELY":
      if (out.cameraSpeed === "VERY_SLOW") out.cameraSpeed = "SLOW";
      if (kind === "ACTION") out.cameraMovement = "HANDHELD_SOFT";
      out.why += "; sinh động: nhịp máy nhanh hơn một chút";
      break;
    case "DOCUMENTARY":
      if (kind === "REACTION" || kind === "PUNCHLINE") {
        out.shotSize = "MEDIUM";
        out.cameraMovement = "STATIC";
      }
      if (kind === "SUBJECT" || kind === "ANIMAL" || kind === "ACTION") {
        out.shotSize = kind === "SUBJECT" ? "MEDIUM" : "WIDE";
        out.cameraMovement = kind === "SUBJECT" ? "HANDHELD_SOFT" : "TRACK_RIGHT";
      }
      out.cameraSpeed = out.cameraSpeed === "MEDIUM" ? "SLOW" : out.cameraSpeed;
      out.focusStyle = "DEEP_FOCUS";
      out.why += "; documentary: rộng/trung, bám nhẹ, không hiệu ứng meme";
      break;
    case "PRODUCT_REVIEW":
      if (kind === "SUBJECT" || kind === "DIALOGUE") {
        out.shotSize = "MEDIUM";
        out.cameraMovement = "PUSH_IN";
        out.cameraSpeed = "VERY_SLOW";
        out.why += "; review: khung presenter trung cảnh, ổn định";
      }
      break;
    case "FAST_COMEDY":
      if (kind === "REACTION" || kind === "PUNCHLINE") {
        out.cameraMovement = effects ? "CRASH_ZOOM" : "PUSH_IN";
        out.cameraSpeed = "FAST";
        out.why += effects ? "; hài nhanh: zoom gắt vào phản ứng" : "";
      } else if (out.cameraSpeed === "VERY_SLOW" || out.cameraSpeed === "SLOW") {
        out.cameraSpeed = "MEDIUM";
      }
      break;
    default:
      if ((kind === "REACTION" || kind === "PUNCHLINE") && effects && ctx.comedyLevel >= 4) {
        out.cameraMovement = "CRASH_ZOOM";
        out.cameraSpeed = "FAST";
        out.why += "; hài cao: zoom gắt có kiểm soát";
      }
  }
  if (!effects && EFFECT_MOVES.includes(out.cameraMovement)) out.cameraMovement = "PUSH_IN";
  return out;
}

/** Reference priority beats camera flair: a critical product / animal is never thrown around. */
function referenceSafe(d: Draft, s: SceneSemantics): Draft {
  const critical = (s.references ?? []).find((r) => r.critical && (r.type === "PRODUCT" || r.type === "ANIMAL" || r.type === "CHARACTER" || r.type === "TOY"));
  if (!critical) return d;
  const out = { ...d };
  const risky: CameraMove[] = ["CRASH_ZOOM", "WHIP_PAN", "ORBIT_LEFT", "ORBIT_RIGHT", "ARC", "HANDHELD_SOFT"];
  if (critical.type === "PRODUCT" && risky.includes(out.cameraMovement)) {
    out.cameraMovement = "PUSH_IN";
    out.why += `; giữ đúng ${critical.name} (tham chiếu bắt buộc) nên không dùng hiệu ứng mạnh`;
  }
  if (critical.type === "PRODUCT" && out.cameraSpeed === "FAST") out.cameraSpeed = "SLOW";
  return out;
}

/** Very short scenes cannot carry a slow lateral move; keep it simple. */
function fitsDuration(d: Draft, s: SceneSemantics): Draft {
  if (s.duration >= 2.5) return d;
  const lateral: CameraMove[] = ["PAN_LEFT", "PAN_RIGHT", "TRACK_LEFT", "TRACK_RIGHT", "TRUCK_LEFT", "TRUCK_RIGHT", "TILT_UP", "TILT_DOWN"];
  if (!lateral.includes(d.cameraMovement)) return d;
  return { ...d, cameraMovement: "PUSH_IN", why: `${d.why}; cảnh ngắn nên đẩy máy thay vì lia` };
}

function subjectOf(kind: SceneKind, s: SceneSemantics): string {
  const critical = (s.references ?? []).find((r) => r.critical);
  if ((kind === "PRODUCT" || kind === "PRODUCT_HANDLING") && critical) return critical.name;
  const speakers = (s.speakingCharacters ?? []).filter((n) => n && n !== "Narrator");
  if (kind === "DIALOGUE") return (s.charactersPresent ?? []).slice(0, 3).join(" + ");
  if (kind === "REACTION" || kind === "PUNCHLINE") {
    const listener = (s.charactersPresent ?? []).find((n) => !speakers.includes(n));
    return listener ?? speakers[0] ?? (s.charactersPresent ?? [])[0] ?? "";
  }
  return critical?.name ?? speakers[0] ?? (s.charactersPresent ?? [])[0] ?? "";
}

/** One scene, before the continuity pass. */
export function directScene(s: SceneSemantics, ctx: DirectorContext): { plan: CameraPlan; kind: SceneKind } {
  const kind = sceneKind(s, ctx);
  const preset = effectiveCameraPreset(ctx);
  const d = fitsDuration(referenceSafe(styled(baseShot(kind, s, ctx), kind, ctx, preset), s), s);
  const plan = CameraPlanSchema.parse({
    shotSize: d.shotSize,
    cameraAngle: d.cameraAngle,
    cameraMovement: d.cameraMovement,
    cameraSpeed: d.cameraSpeed,
    focusStyle: d.focusStyle,
    subjectFocus: subjectOf(kind, s),
    reason: `${VI_KIND[kind]}: ${d.why}.`,
  });
  return { plan, kind };
}

// ------------------------------------------------------------- continuity ---

const LEFTWARD: CameraMove[] = ["PAN_LEFT", "TRACK_LEFT", "TRUCK_LEFT", "ORBIT_LEFT"];
const RIGHTWARD: CameraMove[] = ["PAN_RIGHT", "TRACK_RIGHT", "TRUCK_RIGHT", "ORBIT_RIGHT"];
const MIRROR: Partial<Record<CameraMove, CameraMove>> = {
  PAN_LEFT: "PAN_RIGHT",
  PAN_RIGHT: "PAN_LEFT",
  TRACK_LEFT: "TRACK_RIGHT",
  TRACK_RIGHT: "TRACK_LEFT",
  TRUCK_LEFT: "TRUCK_RIGHT",
  TRUCK_RIGHT: "TRUCK_LEFT",
  ORBIT_LEFT: "ORBIT_RIGHT",
  ORBIT_RIGHT: "ORBIT_LEFT",
};

/**
 * The whole video at once: VARIETY + CONTINUITY.
 *  - lateral moves keep one screen direction (no left, right, left for nothing);
 *  - attention effects (crash zoom / whip) at most one in any three scenes;
 *  - three identical shots in a row: the third gets a gentle variation;
 *  - speakers keep their side of the frame through a conversation.
 */
export function continuityPass(scenes: { semantics: SceneSemantics; plan: CameraPlan; kind: SceneKind }[]): CameraPlan[] {
  const out = scenes.map((x) => ({ ...x.plan }));
  let direction: "L" | "R" | null = null;
  let lastEffect = -99;
  let sides: { left: string[]; right: string[]; pair: string } | null = null;

  for (let i = 0; i < out.length; i += 1) {
    const p = out[i]!;
    const kind = scenes[i]!.kind;

    // Screen direction of lateral camera moves.
    const dirNow = LEFTWARD.includes(p.cameraMovement) ? "L" : RIGHTWARD.includes(p.cameraMovement) ? "R" : null;
    if (dirNow) {
      if (direction && dirNow !== direction && MIRROR[p.cameraMovement]) {
        p.cameraMovement = MIRROR[p.cameraMovement]!;
        p.reason += " Giữ cùng hướng chuyển động với cảnh trước.";
      }
      direction = direction ?? dirNow;
    }

    // Effects rationed.
    if (EFFECT_MOVES.includes(p.cameraMovement)) {
      if (i - lastEffect < 3) {
        p.cameraMovement = "PUSH_IN";
        p.reason += " Không lặp hiệu ứng mạnh liên tiếp.";
      } else lastEffect = i;
    }

    // Variety: three identical shots in a row.
    const a = out[i - 1];
    const b = out[i - 2];
    if (a && b && same(a, p) && same(b, p)) {
      p.cameraMovement = p.cameraMovement === "PUSH_IN" ? "SLOW_ZOOM_OUT" : "PUSH_IN";
      p.reason += " Đổi nhẹ để không lặp ba cảnh giống hệt nhau.";
    }

    // Conversation sides (180° heuristic).
    if (kind === "DIALOGUE" || kind === "REACTION" || kind === "PUNCHLINE") {
      const names = orderedNames(scenes[i]!.semantics);
      if (names.length >= 2) {
        const pair = [...names].sort().join("|");
        if (!sides || sides.pair !== pair) sides = { left: [names[0]!], right: names.slice(1, 3), pair };
        p.screenLeft = sides.left;
        p.screenRight = sides.right;
      }
    } else if (kind === "ESTABLISHING" || kind === "ENDING") {
      sides = null;
    }

    // Transition suggestion (stored; the renderer joins with a cut).
    p.transitionIn = i === 0 ? "NONE" : kind === "EMOTIONAL" || (kind === "ENDING" && scenes[i - 1]?.kind === "EMOTIONAL") ? "CROSSFADE" : "CUT";
  }
  return out;
}

function same(a: CameraPlan, b: CameraPlan): boolean {
  return a.shotSize === b.shotSize && a.cameraMovement === b.cameraMovement && a.cameraAngle === b.cameraAngle;
}

/** Speaking order first, then whoever else is present. */
function orderedNames(s: SceneSemantics): string[] {
  const speakers = (s.speakingCharacters ?? []).filter((n) => n && n !== "Narrator");
  const rest = (s.charactersPresent ?? []).filter((n) => !speakers.includes(n));
  return [...new Set([...speakers, ...rest])];
}

/** Direct every scene of a video, then run the continuity pass. */
export function directVideo(scenes: SceneSemantics[], ctx: DirectorContext): { plan: CameraPlan; kind: SceneKind; needsVideoAi: boolean }[] {
  const drafts = scenes.map((s) => ({ semantics: s, ...directScene(s, ctx) }));
  const final = continuityPass(drafts);
  return final.map((plan, i) => ({
    plan,
    kind: drafts[i]!.kind,
    needsVideoAi: localSupport(plan.cameraMovement) === "NONE" || plan.focusStyle === "RACK_FOCUS",
  }));
}
