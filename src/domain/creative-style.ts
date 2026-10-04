/**
 * CREATIVE STYLE ENGINE (QĐ-127) - one set of creative choices shared by every
 * content template: tone, how funny, which kind of humour, pacing, punchline,
 * emotion and energy.
 *
 * A template never gets its own style system. It only states its defaults
 * (`ContentTemplate.creative`) and which fields a person sees in Simple Mode.
 * The engine turns the chosen style into three things, all pure:
 *
 *   1. a STRUCTURE change - beats added / dropped / reworded before planning
 *      (reaction, escalation, payoff, emotional moment...);
 *   2. a PACE - how long a scene stays up, so a fast video has more beats;
 *   3. a PROMPT block the writer must follow.
 *
 * Priority, always: FACTUALITY > REFERENCE CONSISTENCY > CREATIVE STYLE. Humour
 * changes HOW something is said, never WHAT is true.
 *
 * Pure: no database, no provider.
 */

import { z } from "zod";

export const CREATIVE_STYLE_VERSION = "creative-v1";

// ---------------------------------------------------------------- options ---

export const COMEDY_LEVELS = [
  { level: 0, label: "Không hài", hint: "no jokes at all: clear, straight delivery" },
  { level: 1, label: "Vui nhẹ", hint: "light warmth, at most a small friendly smile; no gags" },
  { level: 2, label: "Dí dỏm", hint: "witty wording and one light humorous moment" },
  { level: 3, label: "Hài rõ", hint: "clearly funny: a real gag and a reaction" },
  { level: 4, label: "Hài mạnh", hint: "strong comedy: gags that escalate, big reactions, a punchline" },
  { level: 5, label: "Cường điệu / Viral", hint: "over-the-top, exaggerated, meme-like comedy with fast gags and a big payoff" },
] as const;

export const COMEDY_STYLES = [
  { id: "LITERAL", label: "Hiểu sai nghĩa đen", hint: "literal misunderstanding of words" },
  { id: "REACTION", label: "Phản ứng biểu cảm", hint: "big facial / body reactions" },
  { id: "ESCALATION", label: "Cường điệu dần", hint: "the situation escalates step by step" },
  { id: "DIALOGUE", label: "Hài đối thoại", hint: "funny back-and-forth lines" },
  { id: "VISUAL_GAG", label: "Gag hình ảnh", hint: "a visual gag the picture alone makes funny" },
  { id: "SURPRISE", label: "Punchline bất ngờ", hint: "an unexpected twist at the end" },
  { id: "CUTE", label: "Dễ thương / gia đình", hint: "cute, gentle, family-friendly humour" },
  { id: "MEME", label: "Meme nhanh", hint: "meme-style fast cuts and captions" },
  { id: "DEADPAN", label: "Tỉnh bơ", hint: "deadpan, understated delivery" },
  { id: "SITUATIONAL", label: "Hài tình huống", hint: "comedy from an everyday situation" },
] as const;
export type ComedyStyleId = (typeof COMEDY_STYLES)[number]["id"];

export const PACING_STYLES = [
  { id: "AUTO", label: "Tự động", sceneFactor: 1, hint: "" },
  { id: "SLOW", label: "Chậm", sceneFactor: 1.3, hint: "slow: calm sentences, longer shots, give each idea room" },
  { id: "MEDIUM", label: "Vừa", sceneFactor: 1, hint: "medium: balanced sentence length and cuts" },
  { id: "FAST", label: "Nhanh", sceneFactor: 0.8, hint: "fast: short punchy sentences, quick cuts, quick reveals, short reactions" },
  { id: "VERY_FAST", label: "Rất nhanh", sceneFactor: 0.65, hint: "very fast: very short lines, rapid cuts every 2 seconds, instant reveals" },
] as const;
export type PacingId = (typeof PACING_STYLES)[number]["id"];

export const PUNCHLINE_MODES = [
  { id: "NONE", label: "Không cần" },
  { id: "AUTO", label: "Tự động" },
  { id: "PREFERRED", label: "Nên có" },
  { id: "REQUIRED", label: "Bắt buộc" },
] as const;
export type PunchlineMode = (typeof PUNCHLINE_MODES)[number]["id"];

export const EMOTION_STYLES = [
  { id: "AUTO", label: "Tự động", hint: "" },
  { id: "JOYFUL", label: "Vui vẻ", hint: "joyful and upbeat" },
  { id: "CURIOUS", label: "Tò mò", hint: "curious: questions, discovery, 'did you know'" },
  { id: "EXCITED", label: "Phấn khích", hint: "excited and enthusiastic" },
  { id: "WARM", label: "Ấm áp", hint: "warm and kind" },
  { id: "TOUCHING", label: "Cảm động", hint: "touching: a heartfelt moment and a moving ending" },
  { id: "SUSPENSE", label: "Hồi hộp", hint: "suspense: tension builds before the reveal" },
  { id: "SURPRISE", label: "Bất ngờ", hint: "surprise: set an expectation, then flip it" },
  { id: "CALM", label: "Bình tĩnh", hint: "calm and soothing" },
  { id: "TRUST", label: "Tin cậy", hint: "trustworthy: measured, credible, no hype" },
] as const;
export type EmotionId = (typeof EMOTION_STYLES)[number]["id"];

export const ENERGY_LABELS: Record<number, string> = { 1: "Rất nhẹ", 2: "Nhẹ", 3: "Vừa", 4: "Cao", 5: "Rất năng lượng" };

// ---------------------------------------------------------------- presets ---

export interface CreativeFields {
  tone: string;
  comedyLevel: number;
  comedyStyles: ComedyStyleId[];
  pacingStyle: PacingId;
  punchlineMode: PunchlineMode;
  emotionStyle: EmotionId;
  energyLevel: number;
}

export const CREATIVE_PRESETS = [
  { id: "AUTO", label: "Tự động (theo loại video)", fields: {} },
  { id: "NATURAL", label: "Tự nhiên", fields: { tone: "NATURAL", comedyLevel: 1, pacingStyle: "MEDIUM", punchlineMode: "AUTO", energyLevel: 2 } },
  { id: "PROFESSIONAL", label: "Chuyên nghiệp", fields: { tone: "PROFESSIONAL", comedyLevel: 0, comedyStyles: [], pacingStyle: "MEDIUM", punchlineMode: "NONE", emotionStyle: "TRUST", energyLevel: 2 } },
  { id: "LIGHT_FUN", label: "Hài nhẹ", fields: { tone: "FRIENDLY", comedyLevel: 2, comedyStyles: ["SITUATIONAL"], pacingStyle: "MEDIUM", punchlineMode: "PREFERRED", emotionStyle: "JOYFUL", energyLevel: 3 } },
  { id: "TIKTOK_FUNNY", label: "Hài TikTok", fields: { tone: "FUN", comedyLevel: 4, comedyStyles: ["REACTION", "ESCALATION", "SURPRISE"], pacingStyle: "FAST", punchlineMode: "REQUIRED", emotionStyle: "SURPRISE", energyLevel: 5 } },
  { id: "CUTE", label: "Dễ thương", fields: { tone: "PLAYFUL", comedyLevel: 2, comedyStyles: ["CUTE"], pacingStyle: "MEDIUM", punchlineMode: "AUTO", emotionStyle: "WARM", energyLevel: 3 } },
  { id: "ENERGETIC", label: "Năng động", fields: { tone: "ENERGETIC", comedyLevel: 1, pacingStyle: "FAST", punchlineMode: "AUTO", emotionStyle: "EXCITED", energyLevel: 4 } },
  { id: "EDUCATIONAL", label: "Giáo dục", fields: { tone: "EDUCATIONAL", comedyLevel: 1, pacingStyle: "MEDIUM", punchlineMode: "NONE", emotionStyle: "CURIOUS", energyLevel: 2 } },
  { id: "DRAMATIC", label: "Kịch tính", fields: { tone: "DRAMATIC", comedyLevel: 0, comedyStyles: [], pacingStyle: "MEDIUM", punchlineMode: "PREFERRED", emotionStyle: "SUSPENSE", energyLevel: 4 } },
  { id: "EMOTIONAL", label: "Cảm xúc", fields: { tone: "EMOTIONAL", comedyLevel: 0, comedyStyles: [], pacingStyle: "SLOW", punchlineMode: "NONE", emotionStyle: "TOUCHING", energyLevel: 2 } },
  { id: "MYSTERY", label: "Bí ẩn", fields: { tone: "MYSTERIOUS", comedyLevel: 0, comedyStyles: [], pacingStyle: "MEDIUM", punchlineMode: "PREFERRED", emotionStyle: "SUSPENSE", energyLevel: 3 } },
  { id: "PREMIUM", label: "Sang trọng", fields: { tone: "PREMIUM", comedyLevel: 0, comedyStyles: [], pacingStyle: "SLOW", punchlineMode: "NONE", emotionStyle: "TRUST", energyLevel: 2 } },
  { id: "DOCUMENTARY", label: "Documentary", fields: { tone: "DOCUMENTARY", comedyLevel: 0, comedyStyles: [], pacingStyle: "MEDIUM", punchlineMode: "NONE", emotionStyle: "CURIOUS", energyLevel: 2 } },
  { id: "VIRAL_FAST", label: "Viral nhanh", fields: { tone: "ENERGETIC", comedyLevel: 3, comedyStyles: ["MEME", "SURPRISE"], pacingStyle: "VERY_FAST", punchlineMode: "PREFERRED", emotionStyle: "EXCITED", energyLevel: 5 } },
  { id: "CUSTOM", label: "Tùy chỉnh", fields: {} },
] as const satisfies readonly { id: string; label: string; fields: Partial<CreativeFields> }[];
export type CreativePresetId = (typeof CREATIVE_PRESETS)[number]["id"];

// ----------------------------------------------------------------- stored ---

const PRESET_IDS = CREATIVE_PRESETS.map((p) => p.id) as [CreativePresetId, ...CreativePresetId[]];

/** What is stored in `Project.creativeStyleJson`. Absent field = the preset's / template's default. */
export const CreativeStyleSchema = z.object({
  version: z.string().default(CREATIVE_STYLE_VERSION),
  preset: z.enum(PRESET_IDS).default("AUTO"),
  tone: z.string().max(40).optional(),
  comedyLevel: z.number().int().min(0).max(5).optional(),
  comedyStyles: z.array(z.enum(COMEDY_STYLES.map((c) => c.id) as [ComedyStyleId, ...ComedyStyleId[]])).max(6).optional(),
  pacingStyle: z.enum(PACING_STYLES.map((p) => p.id) as [PacingId, ...PacingId[]]).optional(),
  punchlineMode: z.enum(PUNCHLINE_MODES.map((p) => p.id) as [PunchlineMode, ...PunchlineMode[]]).optional(),
  emotionStyle: z.enum(EMOTION_STYLES.map((e) => e.id) as [EmotionId, ...EmotionId[]]).optional(),
  energyLevel: z.number().int().min(1).max(5).optional(),
});
export type StoredCreativeStyle = z.infer<typeof CreativeStyleSchema>;

export function parseCreativeStyle(json: string | null | undefined): StoredCreativeStyle | null {
  if (!json) return null;
  try {
    const parsed = CreativeStyleSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- template ---

/** What a template says about creative style. */
export interface TemplateCreative {
  /** Its defaults when the person leaves everything on "Tự động". */
  defaults: CreativeFields;
  /** Fields shown in Simple Mode for this template (the rest under Nâng cao). */
  simpleFields: readonly (keyof CreativeFields | "preset")[];
  /** Highest comedy that still makes sense (Knowledge allows 5 but wording-only). */
  maxComedy?: number;
  /**
   * Gag beats (literal mistake, escalation, visual gag) may be added. False for
   * factual templates: humour there is wording, hook and reactions only.
   */
  storyGags: boolean;
  /** A story-like template whose arc follows the emotion (moment, climax). */
  storyArc?: boolean;
}

export interface EffectiveCreativeStyle extends CreativeFields {
  preset: CreativePresetId;
  /** Nothing was ever chosen: the template's defaults, as before this engine. */
  inferred: boolean;
}

/**
 * The style a project actually uses: template defaults, then the preset, then
 * whatever the person changed by hand. AUTO values resolve to the template's.
 */
export function resolveCreativeStyle(
  creative: TemplateCreative,
  stored: StoredCreativeStyle | null,
  toneColumn?: string | null,
): EffectiveCreativeStyle {
  const base = creative.defaults;
  const preset = CREATIVE_PRESETS.find((p) => p.id === (stored?.preset ?? "AUTO")) ?? CREATIVE_PRESETS[0];
  const fromPreset = preset.fields as Partial<CreativeFields>;
  const pick = <K extends keyof CreativeFields>(key: K): CreativeFields[K] =>
    (stored?.[key] as CreativeFields[K] | undefined) ?? fromPreset[key] ?? base[key];
  let tone = stored?.tone ?? fromPreset.tone ?? (toneColumn && toneColumn !== "AUTO" ? toneColumn : base.tone);
  if (tone === "AUTO") tone = base.tone;
  const pacing = pick("pacingStyle");
  const emotion = pick("emotionStyle");
  const punchline = pick("punchlineMode");
  return {
    preset: preset.id,
    tone,
    comedyLevel: Math.min(creative.maxComedy ?? 5, pick("comedyLevel")),
    comedyStyles: [...pick("comedyStyles")],
    pacingStyle: pacing === "AUTO" ? (base.pacingStyle === "AUTO" ? "MEDIUM" : base.pacingStyle) : pacing,
    punchlineMode: punchline,
    emotionStyle: emotion === "AUTO" ? base.emotionStyle : emotion,
    energyLevel: pick("energyLevel"),
    inferred: stored === null,
  };
}

/** Is a punchline / payoff beat wanted? AUTO = when the video is funny enough. */
export function wantsPunchline(style: Pick<CreativeFields, "punchlineMode" | "comedyLevel">): boolean {
  if (style.punchlineMode === "REQUIRED" || style.punchlineMode === "PREFERRED") return true;
  if (style.punchlineMode === "NONE") return false;
  return style.comedyLevel >= 3;
}

/** × the audience's seconds per scene. Fast = more, shorter scenes. */
export function paceFactor(style: Pick<CreativeFields, "pacingStyle">): number {
  return PACING_STYLES.find((p) => p.id === style.pacingStyle)?.sceneFactor ?? 1;
}

// -------------------------------------------------------------- structure ---

/** Minimal beat shape (content-templates' BeatSpec); kept local so this file has no import cycle. */
export interface StyledBeat {
  role: string;
  label: string;
  purpose: string;
  weight: number;
  motion: "LOCAL_MOTION" | "VIDEO_AI" | "AUTO";
  optional?: boolean;
  repeatable?: boolean;
  prefersUserAsset?: boolean;
  pinned?: boolean;
}

/** Roles that are jokes. Comedy 0 removes them (or rewords the ones a format cannot lose). */
const GAG_ROLES = new Set(["literal", "escalation", "punchline", "twist", "reaction", "gag", "payoff"]);
/** Beats that close a video; a payoff / gag / emotional moment goes right before them. */
const CLOSING_ROLES = new Set(["cta", "contact", "recap", "ending", "conclusion", "verdict", "sleep", "cliffhanger", "lesson", "closing", "words"]);

function hookPurpose(s: EffectiveCreativeStyle, factual: boolean): string {
  if (s.comedyLevel >= 4) return "a loud, funny, surprising hook in the first 2 seconds (exaggerated reaction or absurd claim about the situation, not about facts)";
  if (s.comedyLevel >= 2) return "a witty hook in the first 2 seconds - a playful question or surprise";
  if (s.emotionStyle === "SUSPENSE" || s.tone === "MYSTERIOUS") return "a mysterious question that makes the viewer need the answer";
  if (s.emotionStyle === "TOUCHING" || s.tone === "EMOTIONAL") return "a quiet, heartfelt opening line";
  if (s.tone === "PROFESSIONAL" || s.tone === "PREMIUM" || factual) return "a clear, credible hook that states why this matters";
  return "grab attention in the first 2 seconds with a question, surprise or bold claim";
}

/**
 * The template's beats reshaped by the style. Pure and deterministic: the same
 * style gives the same structure, so tests and the preview can rely on it.
 */
export function applyCreativeStructure<T extends StyledBeat>(beats: readonly T[], s: EffectiveCreativeStyle, creative: TemplateCreative, factual: boolean): T[] {
  let out: T[] = beats.map((b) => (b.role === "hook" ? { ...b, purpose: hookPurpose(s, factual) } : { ...b }));
  const make = (role: string, label: string, purpose: string, weight: number, motion: StyledBeat["motion"]): T =>
    ({ role, label, purpose, weight, motion, pinned: true }) as T;
  const insertBeforeClosing = (beat: T) => {
    let at = out.length;
    while (at > 1 && CLOSING_ROLES.has(out[at - 1]!.role)) at -= 1;
    out.splice(at, 0, beat);
  };
  const insertAfterFirstBody = (beat: T) => {
    const firstBody = out.findIndex((b) => b.role !== "hook");
    out.splice(firstBody < 0 ? out.length : firstBody + 1, 0, beat);
  };
  const has = (role: string) => out.some((b) => b.role === role);

  // --- comedy 0: no jokes. Optional gags go; required ones are reworded.
  if (s.comedyLevel === 0) {
    const kept = out.filter((b) => !(GAG_ROLES.has(b.role) && b.optional));
    out = kept.map((b) =>
      GAG_ROLES.has(b.role) ? { ...b, label: b.label, purpose: `${b.purpose} - played straight, no joke` } : b,
    );
  }

  // --- story arc by emotion (non-factual story-like templates).
  if (creative.storyArc && s.comedyLevel <= 1 && (s.emotionStyle === "TOUCHING" || s.emotionStyle === "WARM") && !has("moment")) {
    insertBeforeClosing(make("moment", "Khoảnh khắc cảm xúc", "the heartfelt emotional moment the story builds to", 0.2, "VIDEO_AI"));
  }
  if (creative.storyArc && s.comedyLevel <= 1 && s.emotionStyle === "SUSPENSE" && !has("climax")) {
    insertBeforeClosing(make("climax", "Cao trào", "tension peaks, then the reveal", 0.2, "VIDEO_AI"));
  }

  // --- comedy 3+: a reaction beat; 4+: an escalation when the template allows gags.
  if (s.comedyLevel >= 3 && !has("reaction")) {
    insertAfterFirstBody(
      make(
        "reaction",
        "Phản ứng",
        factual
          ? "a funny, exaggerated REACTION to what was just shown - wording and expression only, no new claim"
          : "a big comic reaction to what just happened",
        0.12,
        "AUTO",
      ),
    );
  }
  if (s.comedyLevel >= 4 && creative.storyGags && !has("escalation")) {
    const after = out.findIndex((b) => b.role === "reaction");
    out.splice(after + 1, 0, make("escalation", "Cường điệu", "the situation escalates - bigger, sillier, still safe", 0.16, "VIDEO_AI"));
  }
  if (s.comedyLevel >= 3 && creative.storyGags && s.comedyStyles.includes("VISUAL_GAG") && !has("gag")) {
    insertBeforeClosing(make("gag", "Gag hình ảnh", "a visual gag: the picture alone is the joke", 0.12, "VIDEO_AI"));
  }

  // --- punchline / payoff.
  const punch = out.findIndex((b) => b.role === "punchline" || b.role === "payoff");
  if (wantsPunchline(s)) {
    if (punch < 0) {
      insertBeforeClosing(
        make(
          "payoff",
          s.comedyLevel >= 2 ? "Punchline" : "Kết đắt",
          factual
            ? "a clear, memorable payoff line at the end, built ONLY on what was already said (no new fact)"
            : s.comedyLevel >= 2
              ? "the punchline: a clear funny payoff that lands the joke"
              : "a strong, memorable payoff line",
          0.14,
          "AUTO",
        ),
      );
    } else if (s.punchlineMode === "REQUIRED") {
      out[punch] = { ...out[punch]!, optional: false };
    }
  } else if (s.punchlineMode === "NONE" && punch >= 0 && out.length > 2) {
    out.splice(punch, 1);
  }
  // Required: the payoff is at (or right before) the end - never mid-video.
  if (s.punchlineMode === "REQUIRED") {
    const at = out.findIndex((b) => b.role === "punchline" || b.role === "payoff");
    if (at >= 0) {
      const [beat] = out.splice(at, 1);
      insertBeforeClosing({ ...beat!, optional: false });
    }
  }

  // CTA wording follows the tone, never its content.
  out = out.map((b) => (b.role === "cta" ? { ...b, purpose: `${b.purpose}; in a ${toneWord(s.tone)} voice, never invent contact details or urgency` } : b));
  return out;
}

function toneWord(tone: string): string {
  return TONE_HINTS[tone]?.word ?? "natural";
}

/** Prompt wording of each tone id (content-options TONES ids). */
export const TONE_HINTS: Record<string, { word: string; hint: string }> = {
  NATURAL: { word: "natural", hint: "natural and conversational, everyday words" },
  PROFESSIONAL: { word: "professional", hint: "professional, precise, trustworthy; no slang" },
  FRIENDLY: { word: "friendly", hint: "friendly and warm, talks to the viewer like a friend" },
  EDUCATIONAL: { word: "educational", hint: "clear teacher: one idea at a time, examples" },
  PLAYFUL: { word: "playful", hint: "playful and light, cheeky wording" },
  FUN: { word: "funny", hint: "funny: jokes, comic timing, exaggeration in delivery" },
  DRAMATIC: { word: "dramatic", hint: "dramatic: strong contrasts, pauses, big reveals" },
  EMOTIONAL: { word: "emotional", hint: "emotional and heartfelt" },
  MYSTERIOUS: { word: "mysterious", hint: "mysterious: questions, hints, slow reveal" },
  PREMIUM: { word: "premium", hint: "premium and elegant: few words, refined, calm confidence" },
  DOCUMENTARY: { word: "documentary", hint: "documentary narrator: observational, factual, calm" },
  ENERGETIC: { word: "energetic", hint: "energetic and upbeat, punchy" },
  GENTLE: { word: "calm", hint: "calm, gentle and soothing" },
};

// ----------------------------------------------------------------- prompt ---

/**
 * The block the writer is given. Every field is an instruction the script has
 * to show - never metadata only.
 */
export function creativeStylePrompt(s: EffectiveCreativeStyle, opts: { factual: boolean; storyGags: boolean }): string {
  const comedy = COMEDY_LEVELS[s.comedyLevel] ?? COMEDY_LEVELS[0];
  const pacing = PACING_STYLES.find((p) => p.id === s.pacingStyle) ?? PACING_STYLES[2];
  const emotion = EMOTION_STYLES.find((e) => e.id === s.emotionStyle);
  const styles = s.comedyLevel === 0 ? [] : COMEDY_STYLES.filter((c) => s.comedyStyles.includes(c.id));
  const punchline =
    s.punchlineMode === "REQUIRED"
      ? "REQUIRED - the last (or second-to-last, before a CTA) scene MUST land a clear payoff / punchline. A script without one is wrong."
      : wantsPunchline(s)
        ? "preferred - end on a clear payoff line."
        : s.punchlineMode === "NONE"
          ? "none - end plainly, no punchline."
          : "only if it fits naturally.";
  const lines = [
    `CREATIVE STYLE (${CREATIVE_STYLE_VERSION}) - follow it in wording, structure, hook, reactions, ending and CTA:`,
    `- Tone: ${TONE_HINTS[s.tone]?.hint ?? s.tone}`,
    `- Comedy level: ${s.comedyLevel}/5 - ${comedy.hint}`,
    styles.length ? `- Comedy styles: ${styles.map((c) => `${c.hint}`).join("; ")}` : "",
    `- Pacing: ${pacing.hint || "medium"}`,
    `- Punchline: ${punchline}`,
    emotion?.hint ? `- Emotion: ${emotion.hint} - shape the narration, the reactions and the ending around it` : "",
    `- Energy: ${s.energyLevel}/5 (${ENERGY_LABELS[s.energyLevel] ?? ""})`,
    s.comedyLevel >= 3 ? "- Visual direction: reaction close-ups, snap zooms, faster cuts; put a short sound-effect hint (pop, whoosh, ding, record scratch, soft impact) on gag and punchline scenes." : "",
    "- PRIORITY: factual correctness > reference consistency (products, characters, animals look exactly as given) > creative style.",
    opts.factual
      ? "- This is FACTUAL content: humour may change only HOW things are said (hook, wording, reactions, camera, captions). Never invent or bend a feature, price, specification, statistic, experience, pro/con, behaviour or date to be funny."
      : "",
    !opts.storyGags && s.comedyLevel >= 3 ? "- No made-up gag situations involving the subject: keep the subject exactly as it is; jokes live in reactions and wording." : "",
  ];
  return lines.filter(Boolean).join("\n");
}

// ------------------------------------------------------- English idiom (v2) ---

/** What each idiom beat must do (the real writer's structure lines). */
const IDIOM_ROLE_TEXT: Record<string, string> = {
  hook: "HOOK - stop the scroll",
  literal: "LITERAL MISUNDERSTANDING - the character takes the idiom literally",
  gag: "VISUAL GAG - one absurd, harmless picture of the literal reading",
  escalation: "ESCALATION - it gets bigger and sillier",
  punchline: "FUNNY MOMENT - the gag pays off",
  reaction: "BIG REACTION - a comic reaction close-up",
  meaning: "REAL MEANING - explained in very simple English",
  example: "EXAMPLE SENTENCE - the idiom used naturally",
  usage: "ANOTHER EXAMPLE - a second everyday situation where you would say it",
  recap: "RECAP - one short line the viewer remembers",
  payoff: "FINAL PAYOFF / PUNCHLINE - a clear funny line that closes the video",
};

/** Comfortable seconds per scene for each pacing (a scene can carry 2-6 s). */
const IDIOM_SCENE_SECONDS: Record<string, number> = { SLOW: 6, MEDIUM: 5, FAST: 4, VERY_FAST: 3 };

/**
 * The idiom video's beats for a chosen style and length - ONE source for both
 * the real writer's prompt (idiom-v2) and the mock writer, so they cannot
 * disagree. Comedy 0-1 explains without gags; 4+ adds a visual gag, a reaction
 * and a final payoff. The video is always long enough for its running time
 * (no scene can exceed 6 s): neutral beats (another example, a recap) fill it.
 */
export function idiomPlan(s: EffectiveCreativeStyle, targetDuration: number): string[] {
  let roles: string[];
  if (s.comedyLevel <= 1) roles = s.comedyLevel === 1 ? ["hook", "literal", "meaning", "example"] : ["hook", "meaning", "example"];
  else if (s.comedyLevel <= 3) roles = ["hook", "literal", "escalation", "punchline", "meaning", "example"];
  else roles = ["hook", "literal", "gag", "escalation", "reaction", "meaning", "example", "payoff"];
  if (s.punchlineMode === "NONE") roles = roles.filter((r) => r !== "punchline" && r !== "payoff");
  if (s.punchlineMode === "REQUIRED" && !roles.includes("payoff")) roles = [...roles.filter((r) => r !== "punchline"), "payoff"];

  const per = IDIOM_SCENE_SECONDS[s.pacingStyle] ?? 5;
  const want = Math.min(12, Math.max(Math.ceil(targetDuration / 6), Math.round(targetDuration / per)));
  // The payoff stays last; fillers go before it.
  const tail = roles.at(-1) === "payoff" ? roles.pop()! : null;
  if (roles.length + (tail ? 1 : 0) < want && !roles.includes("recap")) roles.push("recap");
  while (roles.length + (tail ? 1 : 0) < want) {
    const at = roles.lastIndexOf("usage") >= 0 ? roles.lastIndexOf("usage") : roles.lastIndexOf("example");
    roles.splice(at + 1, 0, "usage");
  }
  if (tail) roles.push(tail);
  return roles;
}

/** The STRUCTURE block of the idiom-v2 prompt: exactly these scenes, in this order. */
export function idiomStructureHint(s: EffectiveCreativeStyle, targetDuration: number): string {
  const roles = idiomPlan(s, targetDuration);
  return [
    `STRUCTURE - exactly ${roles.length} scenes, in this order (about ${Math.round(targetDuration / roles.length)} s each):`,
    ...roles.map((r, i) => `  ${i + 1}. ${IDIOM_ROLE_TEXT[r] ?? r}`),
  ].join("\n");
}

/** Who the idiom writer is, and its one humour rule, for this style. */
export function idiomWriterVoice(s: EffectiveCreativeStyle): { writerRole: string; comedyRule: string } {
  if (s.comedyLevel <= 1)
    return {
      writerRole:
        "You are a clear, friendly English teacher writing short vertical videos that explain English idioms. This video is NOT a comedy sketch: no gags, no slapstick, no joke title.",
      comedyRule:
        "No gags, slapstick or comic sound effects. Show the meaning calmly and clearly; visuals illustrate, they do not joke. Title, hook and closing line are clear and plain.",
    };
  return {
    writerRole: "You are a comedy writer for short vertical videos that teach English idioms.",
    comedyRule: "The comedy must be VISUAL. A viewer with the sound off should still laugh.",
  };
}

// ------------------------------------------------------------------ badges ---

export function creativeBadges(s: EffectiveCreativeStyle): { label: string; value: string }[] {
  const preset = CREATIVE_PRESETS.find((p) => p.id === s.preset);
  return [
    { label: "Phong cách", value: s.preset === "AUTO" ? "Tự động" : (preset?.label ?? s.preset) },
    { label: "Hài", value: `${s.comedyLevel}/5` },
    { label: "Nhịp", value: PACING_STYLES.find((p) => p.id === s.pacingStyle)?.label ?? s.pacingStyle },
    { label: "Punchline", value: PUNCHLINE_MODES.find((p) => p.id === s.punchlineMode)?.label ?? s.punchlineMode },
    { label: "Cảm xúc", value: EMOTION_STYLES.find((e) => e.id === s.emotionStyle)?.label ?? s.emotionStyle },
  ];
}

/** Canonical JSON of a stored style (for comparing "did the style change?"). */
export function creativeStyleKey(s: EffectiveCreativeStyle): string {
  const { inferred: _inferred, ...rest } = s;
  void _inferred;
  return JSON.stringify(rest);
}

/**
 * What to store for a choice made in the UI. Null = nothing chosen (preset
 * AUTO and no field changed): the project keeps inferring from its template,
 * and an English idiom keeps its original writer byte for byte.
 */
export function storedCreativeJson(input: Partial<StoredCreativeStyle> | null | undefined): string | null {
  if (!input) return null;
  const parsed = CreativeStyleSchema.safeParse(input);
  if (!parsed.success) return null;
  const s = parsed.data;
  const explicit = (["tone", "comedyLevel", "comedyStyles", "pacingStyle", "punchlineMode", "emotionStyle", "energyLevel"] as const).some(
    (k) => s[k] !== undefined,
  );
  if (s.preset === "AUTO" && !explicit) return null;
  return JSON.stringify(s);
}

/** The idiom writer's prompt version when a creative style was chosen (null column = "idiom-v1"). */
export const IDIOM_CREATIVE_PROMPT_VERSION = "idiom-v2";
