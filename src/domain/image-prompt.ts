/**
 * Contradiction guard for IMAGE prompts.
 *
 * The video path has had one of these since the camera work was measured:
 * `findPromptContradictions` refuses a prompt that both forbids and requests
 * the same move, because a model handed both instructions picks one at random
 * and the run becomes a coin toss nobody can reproduce. The image path never
 * had an equivalent, and scene 4 of the first real batch is the bill for that.
 *
 * Two different contradictions reached gpt-image-2 in one prompt:
 *
 *   "moves one short pace backwards ALONG THE BOARD"   needs the board drawn
 *   "Plain pale sky behind him, NOTHING ELSE IN FRAME" forbids drawing it
 *
 *   scene:  "His eyes stay wide"                       the beat of the shot
 *   sheet:  "wide eager smile", "always wide-eyed and eager"
 *
 * The model resolved both the way a model does: it dropped the diving board and
 * drew a smiling boy, so the beat where Max backs out of the jump came back as
 * a cheerful portrait on an empty background. Nothing failed, nothing was
 * logged, and the clip that animated it scored 10/10 for faithfulness to a
 * keyframe that was already wrong.
 *
 * ## What this module does and does not do
 *
 * It reads the material that goes into an image prompt, finds pairs of
 * instructions that cannot both be drawn, and resolves each pair by dropping
 * the weaker side - never by inventing new content, and never at random.
 *
 * ## The priority order, and one thing it is easy to get backwards
 *
 * IDENTITY > CONTINUITY > ACTION > COMPOSITION > DECORATIVE
 *
 * Applied naively to scene 4, "identity beats everything" would keep the
 * character sheet's smile and the bug would survive its own fix. It does not,
 * because a character sheet's EXPRESSION was never identity. The prompt itself
 * says so: the locked attributes are hair, face shape, age, skin tone, height,
 * proportions, outfit and accessories, and the sentence after them reads "Only
 * pose, expression and camera angle may differ". A sheet that says "wide eager
 * smile" is stating a default mood, which is DECORATIVE - and the scene's own
 * "his eyes stay wide" is the ACTION of that shot. Action outranks decoration,
 * so the smile goes and the structure stays untouched.
 *
 * ## Determinism
 *
 * Every rule is a fixed regex applied in a fixed order, and every edit is a
 * removal or a substitution at a matched span. The same inputs always produce
 * the same prompt, byte for byte, which they must: the prompt is hashed into
 * the idempotency key that stops the pipeline paying for one image twice.
 */

/** Which kind of instruction a clause is, for deciding which side loses. */
export type ConstraintLayer =
  | "IDENTITY"
  | "CONTINUITY"
  | "ACTION"
  | "COMPOSITION"
  | "DECORATIVE";

export const LAYER_RANK: Record<ConstraintLayer, number> = {
  IDENTITY: 0,
  CONTINUITY: 1,
  ACTION: 2,
  COMPOSITION: 3,
  DECORATIVE: 4,
};

export type ImageContradictionKind =
  | "action_vs_empty_frame"
  | "action_vs_static"
  | "expression_vs_sheet"
  | "framing_conflict"
  | "camera_move_in_still"
  | "object_present_and_absent"
  | "outfit_vs_locked_identity"
  // --- added QĐ-075, after an audit found the guard silent on all three ---
  /** Standing and sitting in one description. Nobody can draw both. */
  | "posture_conflict"
  /** A crowd, beside a claim that the frame is empty. */
  | "crowd_vs_empty_frame"
  /** A garment the locked outfit does not contain, not merely recoloured. */
  | "garment_vs_locked_identity";

export interface ImageContradiction {
  kind: ImageContradictionKind;
  /** The instruction that survived. */
  kept: string;
  /** The instruction that was dropped or rewritten. */
  dropped: string;
  keptLayer: ConstraintLayer;
  droppedLayer: ConstraintLayer;
  /** Which character this concerns, when it concerns one. */
  character?: string;
  /**
   * False when the conflict was reported but the text was left alone.
   *
   * Some contradictions cannot be edited out without mangling a sentence, and a
   * guard that silently produces broken English is worse than one that says it
   * could not help. The caller logs these loudly instead.
   */
  resolved: boolean;
  /** For the operator, in the language they read logs in. */
  message: string;
}

export interface ImagePromptCharacter {
  name: string;
  canonical: string;
}

export interface ImagePromptSource {
  /** Scene action text: `visualDescription` plus `characterAction`. */
  sceneDescription: string;
  /** The scene's camera line, which is the authority on framing. */
  camera: string;
  characters: ImagePromptCharacter[];
}

export interface ResolvedImagePrompt extends ImagePromptSource {
  /**
   * Fixed sentence appended when a sheet expression was dropped.
   *
   * Removing the words is not enough on its own: the reference IMAGE still
   * shows the character's default face, and that pull is what produced the
   * smiling Max. This line is the only lever left that does not cost money.
   */
  expressionOverride: string | null;
  contradictions: ImageContradiction[];
  changed: boolean;
}

export const EXPRESSION_OVERRIDE_LINE =
  "Expression and gaze for this shot come from the scene description above, " +
  "not from the character description or the reference image.";

// ------------------------------------------------------------- lexicons ---
//
// Kept as data rather than inline literals so a rule can be read, argued with
// and extended without touching the matching code.

/** Words that make a clause a passing mood rather than a permanent feature. */
const EXPRESSION_GROUPS: Array<[string, RegExp]> = [
  ["SMILE", /\b(smiles?|smiling|grins?|grinning|smirks?|beaming|laughs?|laughing|cheerful|happy|delighted)\b/],
  ["WIDE_EYES", /\b(wide[- ]eyed|eyes? (?:go |stay |stays |grow )?wide|widen(?:s|ing)?|eyes? widen)\b/],
  ["EAGER", /\b(eager|excited|enthusiastic|keen)\b/],
  ["FEAR", /\b(scared|afraid|terrified|nervous|anxious|uneasy|worried|winces?|gulps?|panicked)\b/],
  ["SAD", /\b(sad|crying|cries|tears|sobbing|frowns?|frowning|downcast|glum)\b/],
  ["ANGRY", /\b(angry|furious|glares?|glaring|scowls?|scowling|cross)\b/],
  ["CALM", /\b(calm|neutral|relaxed|composed|serene|impassive)\b/],
  ["EYES_SHUT", /\b(eyes closed|squints?|squinting|blinks?|winks?)\b/],
  // Added QĐ-075. "Deadly serious" had no group at all, so a scene that asked
  // for it agreed with a sheet that said "wide eager smile" - two faces, no
  // complaint. Kept apart from CALM: composed and stern are different faces.
  [
    "SERIOUS",
    /\b(serious|stern|grave|solemn|deadpan|straight[- ]faced|unsmiling|poker[- ]faced)\b/,
  ],
];

/**
 * Clauses in a character sheet that describe a MOOD, not a feature.
 *
 * Anchored to the whole clause on purpose. "large round expressive eyes" is the
 * shape of the eyes and must survive; "wide eager smile" is what the face is
 * doing this second and must not outrank the scene.
 */
const TRANSIENT_CLAUSE_PATTERNS: RegExp[] = [
  /^(?:always |usually |permanently |constantly )?(?:wide|bright)[- ]eyed(?: and \w+)?$/,
  /^(?:a |an )?(?:wide |big |broad |small |slight |gentle |warm |toothy )*(?:eager |cheerful |happy |friendly |nervous |sad )*(?:smile|grin|smirk|frown|scowl|pout)$/,
  /^(?:always |constantly |usually )?(?:smiling|grinning|frowning|beaming|laughing|scowling|pouting|winking)$/,
  /^(?:neutral|cheerful|happy|sad|angry|worried|nervous|surprised|excited|eager|calm) (?:expression|look|face|mood)$/,
  /^mouth (?:open|closed|agape)$/,
  /^eyes (?:closed|shut|narrowed|squinting|wide open)$/,
  /^(?:eager|cheerful|excited|delighted|nervous|worried)$/,
];

/** A still image cannot pan. These are requests, not prohibitions. */
const CAMERA_MOVE_RE =
  /\b(?<!no )(?<!not )(?:slowly |smoothly |quickly )?(pans?|zooms?(?: in| out)?|push(?:es)?[- ]in|pulls?[- ]back|tilts?(?: up| down)?|orbits?|tracks? (?:left|right|with)|dollies|reframes?)\b/gi;

const LOCKED_FRAMING_RE = /\b(locked|static|fixed|tripod|still)\b/i;

/** Shot sizes, bucketed. Two buckets in one shot cannot both be true. */
const SHOT_BUCKETS: Array<[string, RegExp]> = [
  ["CLOSE", /\b(?:extreme )?close[- ]?ups?\b|\bhead and shoulders\b|\btight on\b/gi],
  ["MEDIUM", /\bmedium (?:shot|close[- ]?up)\b|\bwaist[- ]up\b/gi],
  ["WIDE", /\b(?:full[- ]body|full[- ]length|wide shot|long shot|establishing shot)\b/gi],
];

/**
 * Postures, bucketed. One body cannot be in two of them.
 *
 * Deliberately narrow verbs. "Stands out", "stands for" and "standing by" are
 * not postures, so the patterns require the bare verb or an explicit posture
 * noun - a guard that fires on "his reputation stands" is one that gets muted.
 */
const POSTURE_BUCKETS: Array<[string, RegExp]> = [
  ["STANDING", /\b(?:stands?|standing)\b(?!\s+(?:out|for|by|to reason))|\bon (?:his|her|their) feet\b|\bupright\b/gi],
  ["SITTING", /\b(?:sits?|sitting|seated|perched)\b(?!\s+(?:out|through))/gi],
  ["LYING", /\b(?:lies? down|lying down|lies? on|sprawled|flat on (?:his|her|their) back)\b/gi],
  ["KNEELING", /\b(?:kneels?|kneeling|crouch(?:es|ing)?|squats?|squatting)\b/gi],
];

/** People in the background, as a group. */
const CROWD_RE =
  /\b(?:a |the )?(?:cheering |applauding |waiting |large |small |busy )?(?:crowds?|audiences?|throngs?|onlookers?|bystanders?|spectators?|queues?|a (?:group|row) of people|(?:several|many|dozens of|lots of) (?:people|children|kids|adults))\b/gi;

const CENTERED_RE = /\b(?:centred|centered|dead cent(?:re|er)|middle of (?:the )?frame)\b/gi;
const EDGE_RE =
  /\b(?:far (?:left|right) edge|edge of (?:the )?frame|extreme (?:left|right)|hard against the (?:left|right))\b/gi;

const EMPTY_FRAME_RE =
  /(?:,\s*)?\b(?:and\s+)?nothing else (?:is )?(?:in frame|visible|around (?:him|her|them))\b|\bempty frame\b|\bno other objects?(?: in frame)?\b/gi;

const STATIC_CLAIM_RE =
  /(?:,\s*)?\b(?:completely static|perfectly still|motionless|frozen in place|no movement(?: at all)?)\b/gi;

const MOTION_VERB_RE =
  /\b(moves?|steps?|walks?|runs?|jumps?|turns?|shakes?|waves?|reach(?:es)?|leans?|lifts?|raises?|throws?|spins?|climbs?|kicks?|pushes|pulls?|eases?|shuffles?|backs?)\b/i;

/**
 * An object the action needs in frame.
 *
 * Nouns that are not objects - sky, air, background - are excluded: "against a
 * plain pale sky" does not mean anything has to be drawn, so pairing it with
 * "nothing else in frame" would be a false alarm, and a guard that cries wolf
 * on correct prompts is one that gets switched off.
 */
const NON_OBJECT_NOUNS = new Set([
  "sky", "air", "camera", "background", "frame", "screen", "distance",
  "horizon", "left", "right", "side", "front", "back", "viewer", "ground",
  "floor", "light", "shot", "scene", "moment", "time", "way", "place",
]);

const OBJECT_PHRASE_RE =
  /\b(?:along|onto|off|across|around|behind|under|over|upon|against|beside|towards?|from|on)\s+(?:the|a|an)\s+([a-z][a-z-]{2,20}(?:\s+[a-z][a-z-]{2,20})?)\b/gi;

/**
 * Garments the rules below can reason about.
 *
 * Widened in QĐ-075: an audit put "Max wears a red raincoat and green wellies"
 * against a locked yellow hoodie and the guard said nothing, because neither
 * word was in this list. A lexicon is only as good as its coverage, and the
 * missing entries were all ordinary clothes.
 */
const GARMENT_WORDS =
  "hoodie|hoody|jacket|coat|raincoat|overcoat|blazer|cardigan|sweater|jumper|" +
  "shirt|t-shirt|tshirt|blouse|vest|jeans|trousers|pants|shorts|skirt|dress|" +
  "overalls|dungarees|uniform|pyjamas|apron|sneakers|trainers|shoes|boots|" +
  "wellies|wellingtons|sandals|slippers|hat|cap|beanie|helmet|scarf|gloves|" +
  "mittens|tie|backpack";

/**
 * A garment with the colour word directly in front of it.
 *
 * The colour is at most an intensity plus ONE word on purpose. A greedy
 * two-word capture swallows the determiner - "his red hoodie" comes back as
 * colour "his red", which matches no colour in the table and quietly disables
 * the whole rule.
 */
function garmentRe(which: string): RegExp {
  return new RegExp(
    `\\b(?:(bright|dark|light|pale|deep)\\s+)?([a-z]+)\\s+(${which})\\b`,
    "gi",
  );
}

const ABSENT_RE: RegExp[] = [
  /\bthe ([a-z][a-z-]{2,20}) (?:is|are|has|have) (?:gone|vanished|disappeared|been removed)\b/gi,
  /\bwithout (?:the |a |an |any )?([a-z][a-z-]{2,20})\b/gi,
  /\bno (?:more )?([a-z][a-z-]{2,20}) (?:in sight|anywhere|left)\b/gi,
];

// ------------------------------------------------------------- helpers ---

function normalise(text: string): string {
  // Collapse the whitespace a removal leaves behind, and the punctuation that
  // ends up doubled when a clause is cut out of the middle of a sentence.
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;!?])/g, "$1")
    .replace(/([.,;])\1+/g, "$1")
    .replace(/,\s*\./g, ".")
    .replace(/\.\s*,/g, ".")
    .replace(/\(\s*\)/g, "")
    .trim();
}

/**
 * Spans where an expression word is being FORBIDDEN rather than requested.
 *
 * "does not smile at all" contains "smile", so a lexicon that only looks for
 * words reads a prohibition as a request - and then agrees with a character
 * sheet that says "wide eager smile", which is the exact opposite of what the
 * scene asked for. Found and removed before grouping. See QĐ-075.
 */
const NEGATED_SPAN_RE =
  /\b(?:does\s+not|doesn'?t|do\s+not|don'?t|never|without|no|not|nor|refuses?\s+to|stops?\s+)\s+(?:\w+\s+){0,2}?(?:smiles?|smiling|grins?|grinning|laughs?|laughing|frowns?|frowning|scowls?|scowling|winks?|blinks?|cries|crying)\b/gi;

/** Groups a piece of text belongs to, in lexicon order. */
function groupsIn(text: string): string[] {
  // A forbidden expression is not a requested one. Stripped first, so
  // "does not smile" contributes nothing rather than contributing SMILE.
  const t = text.toLowerCase().replace(NEGATED_SPAN_RE, " ");
  const out: string[] = [];
  for (const [name, re] of EXPRESSION_GROUPS) {
    if (re.test(t)) out.push(name);
  }
  return out;
}

function isTransientClause(clause: string): boolean {
  const c = clause.trim().toLowerCase().replace(/\.$/, "");
  return TRANSIENT_CLAUSE_PATTERNS.some((re) => re.test(c));
}

/** Every distinct match of a global regex, in order of appearance. */
function matchesOf(text: string, re: RegExp): string[] {
  const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const out: string[] = [];
  for (const m of text.matchAll(copy)) out.push(m[0]);
  return out;
}

function firstBucket(text: string): { bucket: string; phrase: string } | null {
  let best: { bucket: string; phrase: string; index: number } | null = null;
  for (const [bucket, re] of SHOT_BUCKETS) {
    const copy = new RegExp(re.source, re.flags);
    const m = copy.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { bucket, phrase: m[0], index: m.index };
    }
  }
  return best ? { bucket: best.bucket, phrase: best.phrase } : null;
}

function allBuckets(text: string): { bucket: string; phrase: string; index: number }[] {
  const out: { bucket: string; phrase: string; index: number }[] = [];
  for (const [bucket, re] of SHOT_BUCKETS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (m.index !== undefined) out.push({ bucket, phrase: m[0], index: m.index });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Postures found, in the order they were written. */
function allPostures(text: string): { bucket: string; phrase: string; index: number }[] {
  const out: { bucket: string; phrase: string; index: number }[] = [];
  for (const [bucket, re] of POSTURE_BUCKETS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (m.index !== undefined) out.push({ bucket, phrase: m[0], index: m.index });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Remove one span of text and tidy what the removal leaves behind. */
function removePhrase(text: string, phrase: string): string {
  const at = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (at < 0) return text;
  return normalise(text.slice(0, at) + text.slice(at + phrase.length));
}

// ------------------------------------------------------------- the rules ---

/**
 * Read every instruction that will reach the image model, and resolve the pairs
 * that cannot both be drawn.
 */
export function resolveImagePrompt(src: ImagePromptSource): ResolvedImagePrompt {
  const contradictions: ImageContradiction[] = [];
  let scene = src.sceneDescription;
  let camera = src.camera;

  // --- A1. an action that needs an object, beside a claim the frame is empty
  const emptyClaims = matchesOf(scene, EMPTY_FRAME_RE);
  if (emptyClaims.length > 0) {
    const objects: string[] = [];
    for (const m of scene.matchAll(new RegExp(OBJECT_PHRASE_RE.source, "gi"))) {
      const noun = (m[1] ?? "").toLowerCase().trim();
      const head = noun.split(/\s+/).pop() ?? noun;
      if (noun.length > 0 && !NON_OBJECT_NOUNS.has(noun) && !NON_OBJECT_NOUNS.has(head)) {
        objects.push(noun);
      }
    }
    if (objects.length > 0 && MOTION_VERB_RE.test(scene)) {
      for (const claim of emptyClaims) {
        scene = removePhrase(scene, claim);
        contradictions.push({
          kind: "action_vs_empty_frame",
          kept: `hành động cần "${objects[0]}" trong khung`,
          dropped: claim.trim(),
          keptLayer: "ACTION",
          droppedLayer: "COMPOSITION",
          resolved: true,
          message:
            `Hành động nhắc tới "${objects[0]}" nên vật đó PHẢI có trong khung, ` +
            `nhưng cảnh lại ghi "${claim.trim()}". Giữ hành động, bỏ câu khung trống.`,
        });
      }
    }
  }

  // --- A2. a claim that nothing moves, beside something moving
  const staticClaims = matchesOf(scene, STATIC_CLAIM_RE);
  if (staticClaims.length > 0 && MOTION_VERB_RE.test(scene)) {
    const verb = MOTION_VERB_RE.exec(scene)?.[0] ?? "hành động";
    for (const claim of staticClaims) {
      scene = removePhrase(scene, claim);
      contradictions.push({
        kind: "action_vs_static",
        kept: `hành động "${verb}"`,
        dropped: claim.trim(),
        keptLayer: "ACTION",
        droppedLayer: "COMPOSITION",
        resolved: true,
        message:
          `Cảnh vừa mô tả "${verb}" vừa ghi "${claim.trim()}". Ảnh tĩnh vẽ được ` +
          `một tư thế giữa chừng, không vẽ được "đứng yên tuyệt đối". Giữ hành động.`,
      });
    }
  }

  // --- D2. an object that is both present and gone
  for (const re of ABSENT_RE) {
    for (const m of scene.matchAll(new RegExp(re.source, re.flags))) {
      const noun = (m[1] ?? "").toLowerCase();
      if (noun.length === 0 || NON_OBJECT_NOUNS.has(noun)) continue;
      const present = new RegExp(
        `\\b(?:on|onto|along|with|holding|carrying|inside|in)\\s+(?:the|a|an|his|her|their)\\s+${noun}\\b`,
        "i",
      );
      const hit = present.exec(scene);
      if (!hit) continue;
      // Only a clean prepositional phrase can be lifted out without wrecking
      // the sentence. Anything else is reported and left alone.
      const removable = /^(?:on|onto|along|with|inside|in)\s/i.test(hit[0]);
      if (removable) scene = removePhrase(scene, ` ${hit[0]}`);
      contradictions.push({
        kind: "object_present_and_absent",
        kept: m[0].trim(),
        dropped: hit[0].trim(),
        keptLayer: "CONTINUITY",
        droppedLayer: "ACTION",
        resolved: removable,
        message:
          `"${noun}" vừa được nói là đã biến mất ("${m[0].trim()}") vừa được nhắc ` +
          `như đang có ("${hit[0].trim()}").` +
          (removable
            ? " Giữ câu liền mạch (CONTINUITY), bỏ cụm nhắc lại."
            : " KHÔNG tự sửa được mà không làm hỏng câu — hãy sửa kịch bản."),
      });
    }
  }

  // --- B2. one body, two postures
  //
  // NOT auto-resolved. Removing "while sitting on the bench" leaves a sentence
  // that reads correctly and means something the author did not write, and the
  // guard has no way to tell which half was the mistake. Reported loudly so a
  // person fixes the sentence. See QĐ-075.
  const postures = allPostures(scene);
  if (postures.length > 1 && postures.some((p) => p.bucket !== postures[0]!.bucket)) {
    const second = postures.find((p) => p.bucket !== postures[0]!.bucket)!;
    contradictions.push({
      kind: "posture_conflict",
      kept: postures[0]!.phrase,
      dropped: second.phrase,
      keptLayer: "ACTION",
      droppedLayer: "ACTION",
      resolved: false,
      message:
        `Cảnh mô tả hai tư thế cùng lúc: "${postures[0]!.phrase}" ` +
        `(${postures[0]!.bucket}) và "${second.phrase}" (${second.bucket}). ` +
        `Một người không thể vừa ${postures[0]!.bucket} vừa ${second.bucket}; ` +
        `KHÔNG tự sửa vì không đoán được vế nào là ý bạn — hãy sửa câu mô tả cảnh.`,
    });
  }

  // --- B3. a crowd, beside a claim that the frame is empty
  //
  // The mirror of the rule QĐ-064 paid for, with people instead of props. The
  // crowd is staging; "nothing else in frame" is boilerplate, and boilerplate
  // loses to what the scene is actually about.
  const crowds = matchesOf(scene, CROWD_RE);
  if (crowds.length > 0) {
    const emptyClaims = matchesOf(scene, EMPTY_FRAME_RE);
    for (const claim of emptyClaims) {
      scene = removePhrase(scene, claim);
      contradictions.push({
        kind: "crowd_vs_empty_frame",
        kept: `đám đông trong khung ("${crowds[0]}")`,
        dropped: claim.trim(),
        keptLayer: "ACTION",
        droppedLayer: "DECORATIVE",
        resolved: true,
        message:
          `Cảnh có "${crowds[0]}" nhưng lại ghi "${claim.trim()}". Hai thứ không thể ` +
          `cùng đúng; giữ đám đông (đó là nội dung cảnh) và bỏ câu nói khung trống.`,
      });
    }
  }

  // --- C1. two different shot sizes asked for at once
  const sceneShot = firstBucket(scene);
  const cameraShot = firstBucket(camera);
  if (sceneShot && cameraShot && sceneShot.bucket !== cameraShot.bucket) {
    // The camera line exists to state framing; the scene mentioning a shot size
    // is the description straying into the camera's job.
    scene = removePhrase(scene, sceneShot.phrase);
    contradictions.push({
      kind: "framing_conflict",
      kept: cameraShot.phrase,
      dropped: sceneShot.phrase,
      keptLayer: "COMPOSITION",
      droppedLayer: "DECORATIVE",
      resolved: true,
      message:
        `Khung hình đòi hai cỡ cảnh khác nhau: camera "${cameraShot.phrase}" và ` +
        `mô tả "${sceneShot.phrase}". Giữ theo camera.`,
    });
  }
  const cameraBuckets = allBuckets(camera);
  if (cameraBuckets.length > 1 && cameraBuckets[0]!.bucket !== cameraBuckets[1]!.bucket) {
    const loser = cameraBuckets[1]!;
    camera = removePhrase(camera, loser.phrase);
    contradictions.push({
      kind: "framing_conflict",
      kept: cameraBuckets[0]!.phrase,
      dropped: loser.phrase,
      keptLayer: "COMPOSITION",
      droppedLayer: "DECORATIVE",
      resolved: true,
      message:
        `Camera tự ghi hai cỡ cảnh: "${cameraBuckets[0]!.phrase}" và "${loser.phrase}". ` +
        `Giữ cái đứng trước.`,
    });
  }

  // --- C2. centred and at the edge at the same time
  for (const field of ["camera", "scene"] as const) {
    const text = field === "camera" ? camera : scene;
    const centred = matchesOf(text, CENTERED_RE);
    const edge = matchesOf(text, EDGE_RE);
    if (centred.length > 0 && edge.length > 0) {
      const loser = edge[0]!;
      const next = removePhrase(text, loser);
      if (field === "camera") camera = next;
      else scene = next;
      contradictions.push({
        kind: "framing_conflict",
        kept: centred[0]!,
        dropped: loser,
        keptLayer: "COMPOSITION",
        droppedLayer: "DECORATIVE",
        resolved: true,
        message:
          `Vừa "${centred[0]}" vừa "${loser}" trong cùng một khung. Giữ vế đứng trước.`,
      });
    }
  }

  // --- C3. a camera move asked of a still image
  for (const field of ["camera", "scene"] as const) {
    const text = field === "camera" ? camera : scene;
    const moves = matchesOf(text, CAMERA_MOVE_RE);
    if (moves.length === 0) continue;
    const locked = LOCKED_FRAMING_RE.test(text) || LOCKED_FRAMING_RE.test(camera);
    let next = text;
    for (const move of moves) next = removePhrase(next, move);
    if (field === "camera") camera = next;
    else scene = next;
    contradictions.push({
      kind: "camera_move_in_still",
      kept: locked ? "khung khoá" : "khung tĩnh của ảnh",
      dropped: moves.join(", "),
      keptLayer: "COMPOSITION",
      droppedLayer: "DECORATIVE",
      resolved: true,
      message:
        `Yêu cầu máy quay di chuyển ("${moves.join(", ")}") trong một ẢNH TĨNH` +
        (locked ? ", trong khi khung đã được khoá" : "") +
        `. Ảnh không pan/zoom được; bỏ phần di chuyển, giữ nguyên cỡ cảnh.`,
    });
  }

  // --- B. the character sheet's mood against the scene's expression
  const sceneGroups = groupsIn(scene);
  const characters = src.characters.map((c) => ({ ...c }));
  let expressionDropped = false;
  if (sceneGroups.length > 0) {
    for (const character of characters) {
      const clauses = character.canonical.split(/,\s*/);
      const keep: string[] = [];
      for (const clause of clauses) {
        if (!isTransientClause(clause)) {
          keep.push(clause);
          continue;
        }
        const clauseGroups = groupsIn(clause);
        // Agreeing with the scene is not a contradiction. A sheet that says
        // "wide-eyed" beside a scene that says "eyes stay wide" is saying the
        // same thing twice, and rewriting that would be editing a correct
        // prompt for no reason.
        if (clauseGroups.some((g) => sceneGroups.includes(g))) {
          keep.push(clause);
          continue;
        }
        expressionDropped = true;
        contradictions.push({
          kind: "expression_vs_sheet",
          kept: `biểu cảm của cảnh (${sceneGroups.join(", ")})`,
          dropped: clause.trim(),
          keptLayer: "ACTION",
          droppedLayer: "DECORATIVE",
          character: character.name,
          resolved: true,
          message:
            `Bảng nhân vật ${character.name} ghi "${clause.trim()}" trong khi cảnh ` +
            `yêu cầu ${sceneGroups.join(", ")}. Biểu cảm KHÔNG thuộc nhóm thuộc tính ` +
            `bị khoá, nên cảnh thắng: bỏ cụm này khỏi mô tả nhân vật.`,
        });
      }
      character.canonical = keep.join(", ");
    }
  }

  // --- D1. a garment colour the scene changed behind identity's back
  for (const character of characters) {
    const outfit = /(?:^|\.\s*)outfit:\s*([^.]+)/i.exec(character.canonical)?.[1] ?? "";
    for (const m of outfit.matchAll(garmentRe(GARMENT_WORDS))) {
      const colour = [m[1], m[2]].filter(Boolean).join(" ").trim().toLowerCase();
      const garment = (m[3] ?? "").toLowerCase();
      if (!isColourWord(colour)) continue;
      for (const s of scene.matchAll(garmentRe(garment))) {
        const sceneColour = [s[1], s[2]].filter(Boolean).join(" ").trim().toLowerCase();
        // Only a colour word disagreeing counts. "his hoodie" names no colour
        // and contradicts nothing.
        if (sceneColour.length === 0) continue;
        if (colour.includes(sceneColour) || sceneColour.includes(colour)) continue;
        if (!isColourWord(sceneColour)) continue;
        scene = scene.replace(s[0]!, `${colour} ${garment}`);
        contradictions.push({
          kind: "outfit_vs_locked_identity",
          kept: `${colour} ${garment}`,
          dropped: s[0]!.trim(),
          keptLayer: "IDENTITY",
          droppedLayer: "ACTION",
          character: character.name,
          resolved: true,
          message:
            `Cảnh ghi "${s[0]!.trim()}" nhưng trang phục khoá của ${character.name} là ` +
            `"${colour} ${garment}". Trang phục nằm trong nhóm thuộc tính bị khoá, ` +
            `nên sửa mô tả cảnh về đúng màu khoá.`,
        });
      }
    }
  }

  // --- D2. a garment the locked outfit does not contain at all
  //
  // D1 above catches a RECOLOURED garment - "red hoodie" against a locked
  // yellow one - and says nothing about a different garment entirely. An audit
  // found "Max wears a red raincoat" beside a locked "yellow hoodie, blue
  // jeans" passing in silence, which is the same failure wearing a different
  // coat. See QĐ-075.
  //
  // NOT auto-resolved. Rewriting "a red raincoat" into "bright yellow hoodie,
  // blue jeans" mid-sentence produces English nobody wrote, and the system
  // genuinely cannot tell a deliberate costume change from a mistake. Said out
  // loud instead, so the person who knows decides.
  for (const character of characters) {
    const outfit = (
      /(?:^|\.\s*)outfit:\s*([^.]+)/i.exec(character.canonical)?.[1] ?? ""
    ).toLowerCase();
    if (outfit.trim().length === 0) continue;

    const lockedGarments = new Set(
      [...outfit.matchAll(garmentRe(GARMENT_WORDS))].map((m) => (m[3] ?? "").toLowerCase()),
    );
    if (lockedGarments.size === 0) continue;

    for (const s of scene.matchAll(garmentRe(GARMENT_WORDS))) {
      const worn = (s[3] ?? "").toLowerCase();
      if (worn.length === 0 || lockedGarments.has(worn)) continue;
      contradictions.push({
        kind: "garment_vs_locked_identity",
        kept: `trang phục khoá: ${outfit.trim()}`,
        dropped: s[0]!.trim(),
        keptLayer: "IDENTITY",
        droppedLayer: "ACTION",
        character: character.name,
        resolved: false,
        message:
          `Cảnh cho ${character.name} mặc "${s[0]!.trim()}" nhưng trang phục KHOÁ của ` +
          `nhân vật này là "${outfit.trim()}" — không có món đó. Trang phục nằm trong ` +
          `nhóm thuộc tính bị khoá. KHÔNG tự sửa: hệ thống không phân biệt được một ` +
          `lần thay đồ có chủ ý với một lỗi. Hãy sửa cảnh, hoặc cập nhật hồ sơ nhân vật.`,
      });
    }
  }

  scene = normalise(scene);
  camera = normalise(camera);

  return {
    sceneDescription: scene,
    camera,
    characters,
    expressionOverride: expressionDropped ? EXPRESSION_OVERRIDE_LINE : null,
    contradictions,
    changed:
      scene !== normalise(src.sceneDescription) ||
      camera !== normalise(src.camera) ||
      expressionDropped ||
      characters.some((c, i) => c.canonical !== src.characters[i]?.canonical),
  };
}

const COLOUR_WORDS = new Set([
  "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown",
  "black", "white", "grey", "gray", "beige", "cream", "navy", "teal",
  "turquoise", "maroon", "gold", "silver", "tan", "khaki", "olive", "crimson",
  "scarlet", "lime", "indigo", "violet", "magenta", "mustard",
]);

function isColourWord(text: string): boolean {
  const last = text.split(/\s+/).pop() ?? text;
  return COLOUR_WORDS.has(last);
}

/**
 * Report only, for a caller that wants to know without rewriting anything.
 *
 * The storyboard UI uses this to warn an operator about a scene before a single
 * image is bought, which is the cheapest moment to fix a script.
 */
export function findImageContradictions(src: ImagePromptSource): ImageContradiction[] {
  return resolveImagePrompt(src).contradictions;
}
