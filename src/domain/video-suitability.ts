import type { Complexity } from "./enums";
import { splitModelSize } from "./video-duration";

/**
 * Which video model may be trusted with which kind of scene.
 *
 * This encodes benchmark evidence, not preference. Every rule below is written
 * because a real clip was paid for and looked at. The full records live in the
 * VideoBenchmark table (services/benchmark-evidence); the summary:
 *
 *   Sora-2, "Spill the beans" scene 4, two attempts
 *     identity 10 / motion 3, then identity 7 / motion 8, camera 10 both times.
 *     Never failed. $0.40 for 4 seconds.
 *
 *   Runway gen4_turbo, same scene 4, two attempts
 *     FAILED both times with INTERNAL.BAD_OUTPUT.CODE01, 0 credits.
 *
 *   Runway gen4_turbo, scene 5 (one character, plain background)
 *     SUCCEEDED. Identity 10, camera 10, artifacts 7, motion 4. $0.25 for 5s.
 *
 *   Runway gen4.5, scene 3 (three characters, HIGH, a floor of beans), twice
 *     SUCCEEDED both times, $0.72 for 6s each. Run 1, with a prompt that
 *     allowed a slow push-in, scored composition 3 - the model pushed in until
 *     a character left the frame. Run 2, with the camera locked seven different
 *     ways, scored composition 9 but camera 7 and artifacts 7. Capable of work
 *     gen4_turbo refuses; not yet dependable enough to hand a scene to
 *     unattended.
 *
 * The pattern that reading gives: gen4_turbo holds a character well and costs
 * little, but obeys a prompt loosely and refuses outright on busy scenes;
 * gen4.5 handles the busy scene but creeps the camera even when told not to,
 * at 2.9x the price. That makes the choice per-scene, not per-video.
 *
 * Nothing here is permanent. These are the rules the evidence supports TODAY,
 * and `findContradictions` in services/benchmark-evidence exists to shout if a
 * later edit here starts disagreeing with a run that was paid for.
 */

/** Marker written on a scene that a provider has already refused. */
export const RUNWAY_UNSUITABLE = "RUNWAY_UNSUITABLE";

/**
 * Runway's OWN models - the ones the RUNWAY_UNSUITABLE flag actually indicts.
 *
 * The flag was written when "runway" and "gen4_turbo" meant the same thing, so
 * it was recorded against the provider. That has stopped being true: Runway's
 * /image_to_video now resells MiniMax (`h3_max`, `hailuo3`), Alibaba (`wan3`)
 * and Google (`veo3.1*`) models through the same endpoint. "Runway failed this
 * scene" is no longer a statement about anything - it names a shopfront, not a
 * model.
 *
 * So the flag blocks the family that earned it and nothing else. A MiniMax
 * model has never seen this scene and cannot have refused it.
 *
 * This is deliberately NOT a loosening of the real safety rule. The precise
 * block is `ModelFailureEvidence`, keyed on (model, fingerprint), and it still
 * stops the exact request that failed from going back to the exact model that
 * failed it. This flag is the blunt instrument; it should be blunt about the
 * right thing.
 */
const RUNWAY_FIRST_PARTY = /^(gen\d|gen4_aleph|aleph)/i;

export function flagAppliesToModel(model: string | undefined): boolean {
  if (!model) return true; // No model named: assume the worst, stay strict.
  return RUNWAY_FIRST_PARTY.test(model);
}

export interface SuitabilityInput {
  provider: string;
  /**
   * Registry model id, e.g. "gen4_turbo:720x1280".
   *
   * Required in practice for Runway. The limits below were measured on
   * gen4_turbo, and applying them to gen4.5 - a different model that has never
   * been tested - would be exactly the "inventing a limit for something
   * untested" mistake this file warns about two paragraphs up. Omitting it
   * falls back to provider-wide rules, which is right for a provider whose
   * models genuinely behave alike.
   */
  model?: string;
  complexity: Complexity;
  characterCount: number;
  /** Markers already recorded against this scene. */
  sceneFlags?: string[];
}

export interface SuitabilityVerdict {
  allowed: boolean;
  /** Why, in the operator's language. Empty when allowed with no caveat. */
  reason: string;
}

/**
 * Complexity ceilings per provider.
 *
 * A provider absent from this table has no ceiling - it is trusted with any
 * scene until evidence says otherwise. Inventing a limit for an untested
 * provider would be guessing, and a guess that blocks a model is as wrong as a
 * guess that picks one.
 */
const MAX_COMPLEXITY: Record<string, Complexity> = {
  // Keyed by "provider/apiModel". gen4_turbo failed scene 4 twice and passed
  // scene 5; that is a fact about gen4_turbo and about nothing else.
  "runway/gen4_turbo": "LOW",

  // h3_max has SEVEN scored paid samples as of 2026-09-19, three of them from
  // ordinary production runs. Every one was scored LOW, and the largest cast
  // among them is still two. Nothing has been measured above that, so
  // nothing above that is permitted - and this table is where the limit belongs
  // rather than in the lifecycle, because it must survive being wrong about the
  // lifecycle. The LOW_AUTO grant, the low-auto gate and this ceiling are three
  // independent locks on the same door; a bug in any one of them still leaves a
  // MEDIUM scene unable to reach this model.
  //
  // It binds a MANUAL PIN too, which is the existing contract for this table
  // (see `requiresExplicitPin` for the softer state that does not). That is
  // deliberate here: "we have never measured this" is not a preference an
  // operator can overrule by typing the model's name, and scene 6 of Spill the
  // beans is currently pinned to h3_max while scoring MEDIUM - it will now be
  // refused loudly rather than billed quietly.
  "runway/h3_max": "LOW",
};

/** How many characters a provider has actually been shown to handle. */
const MAX_CHARACTERS: Record<string, number> = {
  // Two characters standing together is the case gen4_turbo failed twice.
  "runway/gen4_turbo": 2,

  // Across all seven h3_max samples the casts were one or two characters - six
  // solo, one pair. Two is therefore the largest cast with evidence behind it,
  // and adding production samples has not moved it: the three-character scenes
  // this project is full of have none. Stated here as well as in the low-auto
  // gate on purpose: the gate governs AUTOMATIC routing, and a limit that only
  // existed there would still let a hand-typed pin send a cast of three to a
  // model that has never drawn three of anything.
  "runway/h3_max": 2,
};

/**
 * Models that have PROVEN they can do the work but are not yet cleared to be
 * chosen automatically.
 *
 * This is a third state, and it is needed because the two obvious ones are both
 * wrong for gen4.5 right now. Blocking it in MAX_COMPLEXITY would contradict two
 * paid runs that succeeded on the hardest scene in the project - and
 * `findContradictions` would rightly report it. Leaving it unmarked would let
 * automatic routing spend $0.72 a scene on a model that still drifts the camera
 * enough to clip an arm out of frame at 4.5s with the lock prompt in force.
 *
 * So: stays in the registry, stays pinnable by hand for the next benchmark,
 * and the router will not reach for it on its own.
 *
 * Removing an entry here is the act of promoting a model to production. It
 * should happen because a run cleared the bar, and the run should be in the
 * benchmark table when it does.
 */
const NEEDS_EXPLICIT_PIN: Record<string, string> = {
  "runway/gen4.5":
    "Gen-4.5 làm được cảnh HIGH (2/2 lần đạt, $0,72 mỗi lần 6s) nhưng vẫn " +
    "trôi khung: lần 2 đã khoá camera bằng bảy cách mà tới giây 4.5 vẫn siết " +
    "vào cắt mất tay Leo (camera 7, artifacts 7, đều dưới ngưỡng 8). Đang là " +
    "ỨNG VIÊN cho cảnh HIGH, chưa phải mặc định production - chọn tay nếu muốn dùng.",
};

/**
 * Why the router must not pick this model by itself, or null if it may.
 *
 * Separate from `checkSuitability` on purpose: an unsuitable model cannot do
 * the scene at all, so a manual pin should fail too. A model that merely needs
 * a pin CAN do the scene, and the whole point is that a person may still ask
 * for it.
 */
export function requiresExplicitPin(provider: string, model?: string): string | null {
  for (const key of ruleKeys(provider, model)) {
    const reason = NEEDS_EXPLICIT_PIN[key];
    if (reason !== undefined) return reason;
  }
  return null;
}

/**
 * The key a rule is looked up under: the exact model first, the bare provider
 * as a fallback.
 *
 * Model first because that is the level evidence is actually gathered at. A
 * provider-wide entry still works for a vendor whose models behave alike, but
 * nothing should inherit a limit just for sharing a company.
 */
function ruleKeys(provider: string, model?: string): string[] {
  const apiModel = model ? splitModelSize(model).apiModel : "";
  return apiModel ? [`${provider}/${apiModel}`, provider] : [provider];
}

function lookup<T>(table: Record<string, T>, provider: string, model?: string): T | undefined {
  for (const key of ruleKeys(provider, model)) {
    if (key in table) return table[key];
  }
  return undefined;
}

const RANK: Record<Complexity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function checkSuitability(input: SuitabilityInput): SuitabilityVerdict {
  const { provider, complexity, characterCount, sceneFlags = [] } = input;

  // A scene this provider has already refused. Retrying the same input is how
  // a benchmark turns into a bill for nothing: the two scene-4 attempts were
  // byte-identical and failed identically.
  if (
    provider === "runway" &&
    sceneFlags.includes(RUNWAY_UNSUITABLE) &&
    flagAppliesToModel(input.model)
  ) {
    return {
      allowed: false,
      reason:
        "Model Gen-4 của Runway đã thất bại với chính cảnh này " +
        "(INTERNAL.BAD_OUTPUT). Gửi lại y hệt sẽ hỏng y hệt - hãy đổi model " +
        "hoặc sửa cảnh.",
    };
  }

  const ceiling = lookup(MAX_COMPLEXITY, provider, input.model);
  if (ceiling && RANK[complexity] > RANK[ceiling]) {
    return {
      allowed: false,
      reason:
        `Cảnh ${complexity} vượt mức ${ceiling} mà ${input.model ?? provider} ` +
        `đã được kiểm chứng. Benchmark: model này hỏng ở cảnh phức tạp, ` +
        `đạt ở cảnh đơn giản.`,
    };
  }

  const maxChars = lookup(MAX_CHARACTERS, provider, input.model);
  if (maxChars !== undefined && characterCount > maxChars) {
    return {
      allowed: false,
      reason:
        `Cảnh có ${characterCount} nhân vật, nhiều hơn mức ${maxChars} mà ` +
        `${input.model ?? provider} đã chứng minh xử lý được.`,
    };
  }

  return { allowed: true, reason: "" };
}

/**
 * Does this failure mean "never send this scene here again"?
 *
 * Only a vendor-side output failure counts. A 400 is our mistake and is worth
 * fixing and retrying; a rate limit or a 500 is transient. `BAD_OUTPUT` is the
 * model saying it could not make something acceptable from this input, and that
 * will not change on a retry.
 */
export function marksProviderUnsuitable(
  provider: string,
  errorCode: string | null | undefined,
): string | null {
  if (provider !== "runway") return null;
  if (!errorCode) return null;
  return errorCode.toUpperCase().includes("BAD_OUTPUT") ? RUNWAY_UNSUITABLE : null;
}

/**
 * Does this failure say anything about the MODEL, or only about our request?
 *
 * The distinction decides whether a failed run is evidence. `BAD_OUTPUT` is the
 * model saying it could not make something acceptable from this input - that is
 * a fact about the model, and a rule may be built on it. A 400 is our own
 * malformed request, a 429 is a queue, a 5xx is the vendor having a bad
 * afternoon and a timeout is simply an unknown. None of those tell us whether
 * the model could have done the scene.
 *
 * Getting this wrong in the permissive direction turns every bug we write into
 * a permanent verdict against a model. Getting it wrong in the other direction
 * makes the evidence check cry wolf, and an alarm that cries wolf is one nobody
 * reads - which is how the alarm stops working at all.
 */
export function failureIsAboutTheModel(errorCode: string | null | undefined): boolean {
  if (!errorCode) return false;
  const code = errorCode.toUpperCase();
  if (code.includes("BAD_OUTPUT")) return true;
  // A vendor refusing the CONTENT is also about the model's own limits, not
  // about whether our JSON was shaped right.
  if (code.includes("CONTENT_POLICY") || code.includes("MODERATION")) return true;
  return false;
}

/** Add a marker without duplicating one already present. */
export function withFlag(flags: string[], flag: string): string[] {
  return flags.includes(flag) ? flags : [...flags, flag];
}
