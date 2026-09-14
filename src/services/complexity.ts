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
  /**
   * Many small, near-identical objects the model must hold still while
   * animating: spilled beans, coins, confetti, marbles, falling leaves.
   *
   * This is the signal that was missing, and its absence cost real money.
   * Scene 4 of "Spill the beans" scored LOW at 3.5 - two characters, ordinary
   * gestures - and Runway refused it twice with INTERNAL.BAD_OUTPUT. The floor
   * was covered in hundreds of beans, and nothing in the scoring could see them.
   *
   * It is hard for a reason worth stating: every one of those objects has to
   * stay put frame to frame, and any that drifts reads as the whole floor
   * crawling.
   */
  repeatedSmallObjects: boolean;
  /** Objects or characters passing in front of one another. */
  occlusion: boolean;
  /** Things moving under their own physics: falling, rolling, scattering. */
  complexPhysics: boolean;
  /** Words inside the generated frame, which models render badly. */
  textInFrame: boolean;
  /** Roughly how many things move independently at once. */
  independentMovers: number;
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
  // Weighted heaviest of the new signals: it is the only one so far where a
  // provider refused outright rather than returning something imperfect.
  repeatedSmallObjects: 3,
  occlusion: 1.5,
  complexPhysics: 2,
  textInFrame: 1.5,
  // Per mover beyond the second. Two things moving is a scene; five is a crowd.
  extraMover: 1,
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

/**
 * Many small repeated things.
 *
 * Written as two halves - a QUANTITY word near a SMALL-OBJECT word - rather
 * than one long word list. Listing every possible object would mean adding
 * "lentils" the first time a script says lentils, and the rule has to survive
 * scripts nobody has written yet.
 */
const MANY_WORDS =
  "(?:many|lots of|hundreds|dozens|piles?|heaps?|covered (?:in|with)|full of|scattered|everywhere|countless|a sea of|strewn)";
const SMALL_OBJECT_WORDS =
  "(?:beans?|coins?|confetti|leaves|leaf|marbles?|pebbles?|sprinkles?|crumbs?|petals?|seeds?|grains?|rice|balls?|bubbles?|stars?|papers?|cards?|blocks?|candies|candy|sweets?|nuts?|buttons?|feathers?|snowflakes?|droplets?|dots?|pieces?|bits?|specks?|particles?|shreds?|flakes?)";
const REPEATED_SMALL_OBJECTS = new RegExp(
  // Note the DOUBLE backslash. Inside a template literal `\b` is the BACKSPACE
  // control character, not a regex word boundary - the first version of this
  // pattern began with an invisible control code and could never match. It
  // silently scored every bean-covered scene as having no beans, which is the
  // exact failure this signal was added to catch.
  `\\b(?:${MANY_WORDS}[^.]{0,24}${SMALL_OBJECT_WORDS}` +
    `|${SMALL_OBJECT_WORDS}[^.]{0,24}${MANY_WORDS})`,
  "i",
);

/** A dense field of repeated shapes, stated directly rather than by example. */
const DENSE_FIELD =
  /\b(?:dense|packed|cluttered|littered|crowded)[^.]{0,20}(?:floor|ground|table|background|frame|surface)|\b(?:repeating|repeated|identical)\s+(?:objects?|shapes?|patterns?|items?)/i;
const OCCLUSION =
  /\b(behind|in front of|blocks? the view|overlap\w*|obscur\w*|partially hidden|peek\w* out)/i;
const COMPLEX_PHYSICS =
  /\b(roll|rolls|rolling|bounce|bounces|falling|fall|spill|spills|spilling|pour|pours|splash|topple|slide|slides|fly|flies|drop|drops)\w*/i;
const TEXT_IN_FRAME =
  // `appear\\w*` rather than `appears`: the scripts say "text appears" in
  // one scene and "text appearing" in the next, and a pattern catching only
  // the first silently under-scores the second.
  /\b(text\s+appear\w*|caption|sign|signage|label|whiteboard|banner|written|words? on|title card)\w*/i;

export interface SceneLike {
  duration: number;
  visualDescription?: string;
  characterAction?: string;
  camera?: string;
  dialogue?: string;
  characters?: string[];
}

export function extractSignals(scene: SceneLike): ComplexitySignals {
  // Visual difficulty comes from what is SHOWN, never from what is SAID.
  //
  // Dialogue used to be folded in here and it quietly wrecked the scoring on
  // exactly the videos this app makes. Every line of an idiom video contains
  // the idiom, so "Spill the beans means tell a secret" put beans and spilling
  // into the visual score of a scene showing one man against a blank wall.
  // Scene 5 came out MEDIUM on a shot Runway had already animated successfully
  // - the classifier contradicting a paid, measured result.
  //
  // `dialogue` stays on the input type because callers pass whole scenes and
  // removing it would be a churn-inducing change for no gain; it simply is not
  // read for anything visual.
  const text = [
    scene.visualDescription ?? "",
    scene.characterAction ?? "",
    scene.camera ?? "",
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
    repeatedSmallObjects:
      REPEATED_SMALL_OBJECTS.test(text) || DENSE_FIELD.test(text),
    occlusion: OCCLUSION.test(text),
    complexPhysics: COMPLEX_PHYSICS.test(text),
    textInFrame: TEXT_IN_FRAME.test(text),
    independentMovers: countMovers(scene, text),
    durationSeconds: scene.duration,
  };
}

/**
 * How many things move on their own.
 *
 * Characters each count as one. A field of repeated small objects counts as ONE
 * more however many objects there are - they move as a mass, and counting the
 * beans individually would drown out every other signal in the score.
 */
function countMovers(scene: SceneLike, text: string): number {
  // `text` here is the VISUAL text only, for the reason given in extractSignals.
  let movers = Math.max(1, scene.characters?.length ?? 1);
  if (REPEATED_SMALL_OBJECTS.test(text) || DENSE_FIELD.test(text)) movers += 1;
  if (COMPLEX_PHYSICS.test(text)) movers += 1;
  return movers;
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

  // ---- signals added after the Runway failures ---------------------------
  if (s.repeatedSmallObjects) {
    score += WEIGHTS.repeatedSmallObjects;
    reasons.push(
      "Nhiều vật thể nhỏ lặp lại (đậu, xu, confetti...) — phải giữ yên từng vật khi animate",
    );
  }
  if (s.complexPhysics) {
    score += WEIGHTS.complexPhysics;
    reasons.push("Vật thể chuyển động theo vật lý (rơi, lăn, đổ)");
  }
  if (s.occlusion) {
    score += WEIGHTS.occlusion;
    reasons.push("Vật thể che khuất nhau");
  }
  if (s.textInFrame) {
    score += WEIGHTS.textInFrame;
    reasons.push("Có chữ trong khung hình (mô hình vẽ chữ rất kém)");
  }
  if (s.independentMovers > 2) {
    const extra = s.independentMovers - 2;
    score += WEIGHTS.extraMover * extra;
    reasons.push(`${s.independentMovers} nhóm chuyển động độc lập`);
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
