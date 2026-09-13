import type { Complexity, SpendPriority } from "@/domain/enums";

/**
 * Scene complexity classification.
 *
 * This is the input that lets the router spend differently per scene. A static
 * "here is what the idiom means" card and a two-character slapstick collision
 * are not the same generation problem, and paying the same rate for both is
 * exactly the waste this app exists to avoid.
 */

export interface ComplexitySignals {
  characterCount: number;
  bodyMovement: boolean;
  cameraMotion: boolean;
  handInteraction: boolean;
  objectInteraction: boolean;
  facialExpressionImportant: boolean;
  environmentComplex: boolean;
  motionComplex: boolean;
  durationSeconds: number;
}

export interface ComplexityResult {
  complexity: Complexity;
  score: number;
  signals: ComplexitySignals;
  reasons: string[];
}

const WEIGHTS = {
  secondCharacter: 3,
  extraCharacter: 2,
  bodyMovement: 1.5,
  cameraMotion: 1,
  handInteraction: 2,
  objectInteraction: 1.5,
  facialExpression: 1,
  environment: 1.5,
  motion: 2,
  longShot: 1,
} as const;

const MEDIUM_AT = 4;
const HIGH_AT = 7.5;

const BODY_MOVEMENT = /\b(run|runs|running|jump|jumps|walk|walks|dance|trip|fall|falls|struggl|chase|spin|bow|collapse)\w*/i;
const CAMERA_MOTION = /\b(pan|zoom|push[- ]in|dolly|tracking|whip|orbit|handheld|tilt)\w*/i;
const HAND_INTERACTION = /\b(hand|hands|grab|grabs|hold|holding|carry|carries|point|points|thumbs up|facepalm|take|takes|pass|catch)\w*/i;
const OBJECT_INTERACTION = /\b(box|prop|helmet|whiteboard|mallet|phone|book|cake|bag|chair|table|card|sign|object|beans|jar)\w*/i;
const FACIAL = /\b(reaction|close[- ]up|expression|shock|surprised|grin|smile|frown|eyes wide|stare)\w*/i;
const ENVIRONMENT = /\b(crowd|street|classroom|office|kitchen|stage|park|market|background full|busy|city)\w*/i;
const MOTION_COMPLEX = /\b(slapstick|chaos|collapse|explode|tumbl|pile|wobbl|crash|flying|scatter)\w*/i;

export interface SceneLike {
  duration: number;
  visualDescription?: string;
  characterAction?: string;
  camera?: string;
  dialogue?: string;
  characters?: string[];
}

export function extractSignals(scene: SceneLike): ComplexitySignals {
  const text = [
    scene.visualDescription ?? "",
    scene.characterAction ?? "",
    scene.camera ?? "",
    scene.dialogue ?? "",
  ].join(" ");

  return {
    characterCount: Math.max(1, scene.characters?.length ?? 1),
    bodyMovement: BODY_MOVEMENT.test(text),
    cameraMotion: CAMERA_MOTION.test(text),
    handInteraction: HAND_INTERACTION.test(text),
    objectInteraction: OBJECT_INTERACTION.test(text),
    facialExpressionImportant: FACIAL.test(text),
    environmentComplex: ENVIRONMENT.test(text),
    motionComplex: MOTION_COMPLEX.test(text),
    durationSeconds: scene.duration,
  };
}

export function scoreSignals(s: ComplexitySignals): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  if (s.characterCount >= 2) {
    score += WEIGHTS.secondCharacter;
    reasons.push("Có từ 2 nhân vật trở lên");
  }
  if (s.characterCount > 2) {
    score += WEIGHTS.extraCharacter * (s.characterCount - 2);
    reasons.push(`${s.characterCount} nhân vật trong khung hình`);
  }
  if (s.motionComplex) {
    score += WEIGHTS.motion;
    reasons.push("Chuyển động phức tạp / slapstick");
  }
  if (s.handInteraction) {
    score += WEIGHTS.handInteraction;
    reasons.push("Tương tác bằng tay (AI thường lỗi ở đây)");
  }
  if (s.bodyMovement) {
    score += WEIGHTS.bodyMovement;
    reasons.push("Nhân vật di chuyển toàn thân");
  }
  if (s.objectInteraction) {
    score += WEIGHTS.objectInteraction;
    reasons.push("Tương tác với đạo cụ");
  }
  if (s.environmentComplex) {
    score += WEIGHTS.environment;
    reasons.push("Bối cảnh nhiều chi tiết");
  }
  if (s.cameraMotion) {
    score += WEIGHTS.cameraMotion;
    reasons.push("Máy quay chuyển động");
  }
  if (s.facialExpressionImportant) {
    score += WEIGHTS.facialExpression;
    reasons.push("Biểu cảm khuôn mặt quan trọng");
  }
  if (s.durationSeconds > 5) {
    score += WEIGHTS.longShot;
    reasons.push("Cảnh dài hơn 5 giây");
  }

  return { score: Math.round(score * 10) / 10, reasons };
}

export function classifyScene(scene: SceneLike): ComplexityResult {
  const signals = extractSignals(scene);
  const { score, reasons } = scoreSignals(signals);
  const complexity: Complexity =
    score >= HIGH_AT ? "HIGH" : score >= MEDIUM_AT ? "MEDIUM" : "LOW";
  return { complexity, score, signals, reasons };
}

/**
 * Spend priority - separate from complexity on purpose.
 *
 * A scene can be visually simple yet still deserve the better model because it
 * is the first three seconds (which decide the retention curve) or the punchline
 * (which decides the share). Conversely a busy establishing shot nobody looks at
 * twice is a place to save.
 */
export function assignSpendPriority(opts: {
  sceneNumber: number;
  totalScenes: number;
  startSeconds: number;
  complexity: Complexity;
  role?: string;
}): { priority: SpendPriority; reason: string } {
  const { sceneNumber, totalScenes, startSeconds, complexity, role } = opts;

  if (startSeconds < 3 || sceneNumber === 1) {
    return { priority: "HIGH", reason: "3 giây đầu quyết định tỉ lệ giữ chân" };
  }
  if (role === "punchline") {
    return { priority: "HIGH", reason: "Cao trào của video" };
  }
  // The last beat before the outro is usually the payoff shot.
  if (totalScenes >= 4 && sceneNumber === totalScenes - 1 && complexity !== "LOW") {
    return { priority: "HIGH", reason: "Cảnh chốt đáng nhớ" };
  }
  if (role === "meaning" || role === "example") {
    return { priority: "LOW", reason: "Cảnh giải thích tĩnh, không cần model mạnh" };
  }
  if (complexity === "LOW") {
    return { priority: "LOW", reason: "Cảnh đơn giản" };
  }
  return { priority: "NORMAL", reason: "Cảnh nội dung tiêu chuẩn" };
}
