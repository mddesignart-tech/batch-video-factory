/**
 * How much movement does this scene actually ask for?
 *
 * ## Why this exists, and what it is not
 *
 * `runway/h3_max:768x1280` holds a LOW_AUTO grant on the strength of seven
 * scored paid samples. Six of them are 8.69 or better, which reads like a
 * licence to route any LOW scene to it. Look at what those six CONTAINED and
 * the licence narrows sharply:
 *
 *   canh 1  cúi đầu, mở to mắt                      9.10 / 9.09
 *   canh 3  chớp mắt, nghiêng đầu rất nhẹ           8.69
 *   canh 4  lắc đầu một cái, lui nửa bước           8.91
 *   canh 5  giữ nguyên tư thế (A/B prompt)          9.20
 *   canh 6  một cú đưa tay rồi hạ, một cái gật      8.92
 *
 * Blinks. A nod. One hand raised and lowered. Half a step backwards. The
 * measured per-frame change agrees: `scdet` means of 0.00047 to 0.0023, which
 * is a photograph that breathes. NOBODY HAS EVER PAID THIS MODEL TO DRAW
 * SOMEBODY RUNNING, and a gate that reads "LOW complexity" as permission would
 * be extrapolating from evidence that does not exist.
 *
 * So this is a MOTION FLOOR in the sense of a ceiling on ambition: the router
 * may reach for h3_max only where the scene asks for the size of movement the
 * samples actually covered. It is not a quality judgement about the model, and
 * it is not a claim that h3_max would fail at a run - only that no one knows,
 * and $0.40 is the wrong price for finding out by accident.
 *
 * ## It never blocks a person
 *
 * A manual pin short-circuits routing before any of this is consulted, exactly
 * as with the other low-auto conditions. An operator who wants to buy a running
 * shot from h3_max may; the router may not decide that on its own.
 *
 * ## Where the words come from
 *
 * `Scene.characterAction` first - the field a storyboard author fills in to say
 * what moves - then `visualDescription` as a fallback, because an imported
 * storyboard sometimes carries the action inside the description. Dialogue is
 * deliberately ignored: "I'm going to run for it" is a line, not a movement.
 *
 * See QĐ-074.
 */

export const MOTION_SCALES = ["SUBTLE", "MODERATE", "VIGOROUS"] as const;
export type MotionScale = (typeof MOTION_SCALES)[number];

/**
 * Whole-body, fast or travelling movement.
 *
 * Word-boundary anchored throughout, for the reason `camera-intent` learned the
 * hard way: without `\b`, "run" matches "running joke" and "fall" matches
 * "fallen leaves on a table". Each pattern is a VERB the subject performs.
 */
const VIGOROUS_PATTERNS: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /\bruns?\b|\brunning\b|\bsprints?\b|\bdashes\b|\bbolts?\b/i, name: "chạy" },
  { re: /\bjumps?\b|\bjumping\b|\bleaps?\b|\bhops?\b|\bdives?\b|\bdiving\b/i, name: "nhảy" },
  {
    re: /\bfights?\b|\bfighting\b|\bpunch(?:es|ing)?\b|\bkicks?\b|\bkicking\b|\bwrestl\w*\b/i,
    name: "đánh nhau",
  },
  { re: /\bspins?\b|\bspinning\b|\bwhirls?\b|\btwirls?\b|\bwhips? around\b/i, name: "quay người" },
  { re: /\bdances?\b|\bdancing\b/i, name: "nhảy múa" },
  { re: /\bfalls?\b|\bfalling\b|\btrips?\b|\bstumbles?\b|\btumbles?\b|\bcollapses?\b/i, name: "ngã" },
  { re: /\bthrows?\b|\bthrowing\b|\bhurls?\b|\btosses\b|\bflings?\b/i, name: "ném" },
  { re: /\bswings?\b|\bswinging\b|\bclimbs?\b|\bclimbing\b|\bcrawls?\b/i, name: "leo/đu" },
  { re: /\bchases?\b|\bchasing\b|\bflees\b|\bfleeing\b/i, name: "rượt đuổi" },
  { re: /\bswims?\b|\bswimming\b|\bflies\b|\bflying\b/i, name: "bơi/bay" },
];

/** Movement that travels or reorganises the body, without being violent. */
const MODERATE_PATTERNS: ReadonlyArray<{ re: RegExp; name: string }> = [
  // "Paces" only in the pacing-about sense. A bare "pace" is a UNIT of
  // distance - "one short pace back" is the 8.91 sample, not a walk - so that
  // reading is left to the diminishers below rather than matched as a verb.
  {
    re: /\bwalks?\b|\bwalking\b|\bstrides?\b|\bpaces? (?:across|around|up and down|the)\b/i,
    name: "đi",
  },
  { re: /\bsits? down\b|\bsitting down\b|\bstands? up\b|\bstanding up\b|\bgets? up\b/i, name: "đứng lên/ngồi xuống" },
  { re: /\bturns? (?:around|away|to face)\b|\bspins? to\b/i, name: "xoay người" },
  { re: /\bbends? (?:down|over)\b|\bcrouches\b|\bkneels?\b|\bsquats?\b/i, name: "cúi/quỳ" },
  { re: /\breaches? (?:out|for|across)\b|\bstretches? out\b|\bgrabs?\b|\bpicks? up\b/i, name: "với/cầm lấy" },
  { re: /\bopens? the\b|\bcloses? the\b|\bpushes?\b|\bpulls?\b|\blifts?\b|\bcarries\b/i, name: "đẩy/kéo/nâng" },
  { re: /\bpoints? (?:at|to|towards)\b|\bwaves? (?:at|to|goodbye)\b/i, name: "chỉ/vẫy" },
  { re: /\bsteps? (?:forward|back|aside|towards|into|onto|out)\b/i, name: "bước" },
];

/**
 * Two or more people doing something TO each other.
 *
 * Separate from scale because it is a different risk: h3_max has exactly one
 * two-character sample, and in it the two characters take turns rather than
 * touch. Choreography between people is unmeasured on this model.
 */
const INTERACTION_PATTERNS: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /\bhugs?\b|\bhugging\b|\bembraces?\b/i, name: "ôm" },
  { re: /\bshakes? hands\b|\bhandshake\b|\bhigh[- ]fives?\b|\bfist bump\b/i, name: "bắt tay" },
  { re: /\bhands? (?:over|him|her|them)\b|\bpasses? (?:the|it|him|her)\b|\bgives? (?:him|her|them)\b/i, name: "trao đồ" },
  { re: /\bpushes? (?:him|her|them)\b|\bpulls? (?:him|her|them)\b|\bgrabs? (?:him|her|them)\b/i, name: "xô/kéo nhau" },
  { re: /\bkiss(?:es|ing)?\b|\bpats? (?:him|her|them)\b|\btaps? (?:him|her|them)\b/i, name: "chạm nhau" },
  { re: /\bdance together\b|\bcarry (?:him|her|them)\b|\bcatch(?:es)? (?:him|her|them)\b/i, name: "phối hợp" },
];

/**
 * Explicitly tiny movement.
 *
 * Only consulted to explain a SUBTLE verdict; the absence of anything larger is
 * what actually produces it. A scene that says nothing about movement at all is
 * SUBTLE, because a still with no stated action is the smallest thing there is.
 */
const SUBTLE_PATTERNS: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /\bblinks?\b|\bblinking\b/i, name: "chớp mắt" },
  { re: /\bbreathes?\b|\bbreathing\b|\binhales?\b|\bexhales?\b/i, name: "thở" },
  { re: /\bnods?\b|\bnodding\b|\bshakes? (?:his|her|their) head\b/i, name: "gật/lắc đầu" },
  { re: /\btilts? (?:his|her|their) head\b|\bcocks? (?:his|her|their) head\b/i, name: "nghiêng đầu" },
  { re: /\bsmiles?\b|\bfrowns?\b|\bwinces?\b|\braises? (?:an )?eyebrows?\b|\bgrins?\b/i, name: "biểu cảm" },
  { re: /\bholds? still\b|\bstays? (?:still|where)\b|\bstands? (?:still|there)\b|\bholds? the pose\b/i, name: "đứng yên" },
  { re: /\bshifts? (?:his|her|their) weight\b|\bsways? (?:slightly|gently)\b/i, name: "đổi chân" },
  { re: /\bglances?\b|\blooks? (?:up|down|ahead|at)\b|\bstares?\b/i, name: "nhìn" },
];

/** Adverbs that shrink a verb: "steps back slightly" is not a walk. */
const DIMINISHERS =
  /\b(?:slightly|a little|barely|gently|softly|minutely|a fraction|very slightly|half a step|one small step|a single step|one step|one short pace|a short pace|half a pace)\b/i;

export interface MotionScaleInput {
  /** `Scene.characterAction` - what the author said moves. */
  characterAction?: string | null;
  /** Fallback when the action field is empty. */
  visualDescription?: string | null;
  /** How many people are in the shot, for the interaction rule. */
  characterCount?: number;
}

export interface MotionScaleVerdict {
  scale: MotionScale;
  /** Patterns that fired, by name, for the report and the refusal message. */
  matched: string[];
  /** Two or more people doing something to each other. */
  multiCharacterInteraction: boolean;
  /** Why, in the operator's language. */
  reason: string;
  /** True when nothing in the scene said anything about movement. */
  defaulted: boolean;
}

export function classifyMotionScale(input: MotionScaleInput): MotionScaleVerdict {
  const action = (input.characterAction ?? "").trim();
  const source = action || (input.visualDescription ?? "").trim();

  const interaction =
    (input.characterCount ?? 1) >= 2
      ? INTERACTION_PATTERNS.filter((p) => p.re.test(source)).map((p) => p.name)
      : [];

  if (source === "") {
    return {
      scale: "SUBTLE",
      matched: [],
      multiCharacterInteraction: false,
      reason: "cảnh không mô tả chuyển động nào — coi như chỉ có chuyển động rất nhỏ",
      defaulted: true,
    };
  }

  const vigorous = VIGOROUS_PATTERNS.filter((p) => p.re.test(source)).map((p) => p.name);
  if (vigorous.length > 0) {
    return {
      scale: "VIGOROUS",
      matched: vigorous,
      multiCharacterInteraction: interaction.length > 0,
      reason: `chuyển động mạnh toàn thân: ${vigorous.join(", ")} — "${source}"`,
      defaulted: false,
    };
  }

  const moderate = MODERATE_PATTERNS.filter((p) => p.re.test(source)).map((p) => p.name);
  if (moderate.length > 0) {
    // A diminished verb is the case the evidence DOES cover: scene 4 scored
    // 8.91 on "lui nửa bước". Shrinking words are read as shrinking the
    // movement, but only for the moderate band - "runs slightly" is still a run.
    if (DIMINISHERS.test(source)) {
      return {
        scale: "SUBTLE",
        matched: moderate,
        multiCharacterInteraction: interaction.length > 0,
        reason:
          `có động tác ${moderate.join(", ")} nhưng được mô tả là rất nhỏ — ` +
          `đúng cỡ mẫu "lui nửa bước" đã đo (8,91/10): "${source}"`,
        defaulted: false,
      };
    }
    return {
      scale: "MODERATE",
      matched: moderate,
      multiCharacterInteraction: interaction.length > 0,
      reason: `chuyển động di chuyển/đổi tư thế: ${moderate.join(", ")} — "${source}"`,
      defaulted: false,
    };
  }

  const subtle = SUBTLE_PATTERNS.filter((p) => p.re.test(source)).map((p) => p.name);
  return {
    scale: "SUBTLE",
    matched: subtle,
    multiCharacterInteraction: interaction.length > 0,
    reason:
      subtle.length > 0
        ? `chỉ chuyển động rất nhỏ: ${subtle.join(", ")} — "${source}"`
        : `không thấy động tác lớn nào trong mô tả: "${source}"`,
    defaulted: false,
  };
}
