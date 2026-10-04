import { ScriptSchema, type ScriptDoc, type SceneDoc } from "@/domain/script";
import type { ContentScriptRequest } from "@/providers/types";
import { buildImagePrompt, buildVideoPrompt } from "./mock-text-provider";

/**
 * Mock writer for every multi-content template.
 *
 * A template engine, not a language model - but it fills the SAME planned beats
 * a real model gets, in the requested language, and obeys the same rules a real
 * model is told: pasted text is used in order and never replaced, product facts
 * are only stated when the person (or the source) gave them, and nothing claims
 * a first-hand experience. That is what lets the storyboard, voice, subtitle,
 * router and render stages be exercised for any content type at $0.
 */

type Lang = "vi" | "en";

/** Vietnamese is recognisable by its tone marks; anything else reads as English. */
export function detectLanguage(text: string): Lang {
  return /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i.test(text) ? "vi" : "en";
}

/** Split pasted text into sentences, keeping paragraph starts marked. */
export function sourceSentences(text: string): { text: string; paragraphStart: boolean }[] {
  const out: { text: string; paragraphStart: boolean }[] = [];
  for (const para of text.split(/\n\s*\n|\r\n\s*\r\n/)) {
    const sentences = para
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?。！？])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    sentences.forEach((s, i) => out.push({ text: s, paragraphStart: i === 0 }));
  }
  return out;
}

/**
 * Choose which source sentences fit the running time, WITHOUT reordering and
 * without dropping a paragraph's opening sentence (where its main point is).
 */
export function keySentences(text: string, maxChars: number): string[] {
  const all = sourceSentences(text);
  if (all.length === 0) return [];
  const keep = new Set<number>();
  let used = 0;
  // Every paragraph's first sentence first - the main points.
  all.forEach((s, i) => {
    if (s.paragraphStart) {
      keep.add(i);
      used += s.text.length;
    }
  });
  // Then the rest, in order, while the narration still fits.
  all.forEach((s, i) => {
    if (keep.has(i)) return;
    if (used + s.text.length <= maxChars) {
      keep.add(i);
      used += s.text.length;
    }
  });
  return all.filter((_, i) => keep.has(i)).map((s) => s.text);
}

/** Spread items over n buckets in order, each bucket at least one when possible. */
function spread<T>(items: T[], n: number): T[][] {
  const buckets: T[][] = Array.from({ length: n }, () => []);
  if (n === 0) return buckets;
  items.forEach((item, i) => buckets[Math.min(n - 1, Math.floor((i * n) / items.length))]!.push(item));
  return buckets;
}

function topicOf(req: ContentScriptRequest): string {
  const raw = (req.subjectName || req.idea || sourceSentences(req.sourceText)[0]?.text || req.templateName).replace(/\s+/g, " ").trim();
  // "Làm video 30 giây giới thiệu X" -> "X"
  const stripped = raw
    .replace(/^(làm|tạo)\s+(một\s+)?video\s+(\d+\s*(giây|s)\s*)?(về|giới thiệu|giải thích|nói về)?\s*/i, "")
    .replace(/^(make|create)\s+an?\s+(\d+[- ]?second\s+)?video\s+(about|on|explaining)?\s*/i, "")
    .replace(/[.!?。]+$/, "");
  const topic = stripped.length > 0 ? stripped : raw;
  return topic.length > 90 ? `${topic.slice(0, 89)}…` : topic;
}

const SFX: Record<string, string> = {
  hook: "whoosh",
  feature: "ding",
  reason: "ding",
  pro: "soft chime",
  con: "soft thud",
  cta: "pop",
  reveal: "whoosh",
  explore: "engine",
  challenge: "soft impact",
  solve: "ding",
  fact: "soft chime",
  animal: "animal sound",
  ending: "soft chime",
  word: "pop",
  // QĐ-127 creative beats.
  reaction: "pop",
  escalation: "whoosh",
  gag: "boing",
  payoff: "ding",
  punchline: "record scratch",
  moment: "soft piano",
  climax: "soft impact",
};

interface Line {
  narration: string;
  dialogue: string;
  visual: string;
}

const T = {
  vi: {
    hook: (t: string) => `Bạn đã biết về ${t} chưa? Xem ngay nhé!`,
    point: (n: number, t: string) => `Điểm ${n}: một điều đáng chú ý về ${t}.`,
    factLine: (f: string) => `Theo thông tin được cung cấp, ${lowerFirst(f)}`,
    generalProduct: (t: string) => `${t} hướng tới nhu cầu sử dụng hằng ngày.`,
    forWho: (t: string) => `${t} phù hợp với những ai đang tìm một lựa chọn như vậy.`,
    cons: "Hãy cân nhắc nhu cầu của bạn và kiểm tra thông tin chi tiết trước khi chọn.",
    cta: (c: string) => c || "Xem thêm thông tin ở phần mô tả nhé!",
    recap: (t: string) => `Tóm lại: đó là những điều đáng nhớ về ${t}.`,
    ending: (t: string) => `Và đó là câu chuyện về ${t}. Hẹn gặp lại!`,
    story: (n: number, t: string) => `Rồi điều thú vị thứ ${n} xảy ra trong hành trình ${t}.`,
    funnyHook: (t: string) => `Khoan đã… ${t}?! Không thể tin nổi luôn á!`,
    wittyHook: (t: string) => `Bạn nghĩ mình đã biết hết về ${t}? Thử xem nào!`,
    proHook: (t: string) => `${t}: những điều quan trọng bạn nên biết.`,
    mysteryHook: (t: string) => `Có một bí mật về ${t} mà ít ai để ý…`,
    warmHook: (t: string) => `Có một câu chuyện nhỏ về ${t}, rất dễ thương.`,
    reaction: (lvl: number) => (lvl >= 5 ? "KHÔNG THỂ NÀO! Ai mà ngờ được chứ?!" : lvl >= 4 ? "Ôi trời ơi! Thật luôn hả?!" : "Ồ! Cái này hay đấy!"),
    escalation: (t: string) => `Và mọi chuyện càng lúc càng to hơn… ${t} khiến cả nhà ngã ngửa!`,
    gag: () => "Và rồi… đúng là không ai ngờ tới cảnh này!",
    payoff: (t: string, funny: boolean) => (funny ? `Bài học hôm nay: đừng bao giờ coi thường ${t}! 😂` : `Đó chính là điều đáng nhớ nhất về ${t}.`),
    moment: (t: string) => `Và đúng lúc ấy, một khoảnh khắc ấm áp khiến ai cũng lặng đi vì ${t}.`,
    climax: (t: string) => `Mọi thứ căng như dây đàn… rồi sự thật về ${t} lộ ra.`,
    touchingEnding: (t: string) => `Và từ hôm đó, ${t} mãi là một kỷ niệm thật ấm áp.`,
    proPoint: (n: number, t: string) => `Điểm ${n}: thông tin đáng chú ý về ${t}.`,
    playfulPoint: (n: number, t: string) => `Điểm ${n} nè: ${t} còn có điều này thú vị lắm!`,
  },
  en: {
    hook: (t: string) => `Ever wondered about ${t}? Let's see!`,
    point: (n: number, t: string) => `Point ${n}: something worth knowing about ${t}.`,
    factLine: (f: string) => `According to the product information, ${lowerFirst(f)}`,
    generalProduct: (t: string) => `${t} is aimed at everyday use.`,
    forWho: (t: string) => `${t} suits anyone looking for this kind of option.`,
    cons: "Check the details against your own needs before choosing.",
    cta: (c: string) => c || "More information in the description!",
    recap: (t: string) => `So that's what to remember about ${t}.`,
    ending: (t: string) => `And that's the story of ${t}. See you next time!`,
    story: (n: number, t: string) => `Then something new happens on the ${t} adventure, part ${n}.`,
    funnyHook: (t: string) => `Wait… ${t}?! You will NOT believe this!`,
    wittyHook: (t: string) => `Think you know everything about ${t}? Let's check!`,
    proHook: (t: string) => `${t}: the key things you should know.`,
    mysteryHook: (t: string) => `There is a secret about ${t} that most people miss…`,
    warmHook: (t: string) => `Here is a small, sweet story about ${t}.`,
    reaction: (lvl: number) => (lvl >= 5 ? "NO WAY! Nobody saw that coming!" : lvl >= 4 ? "Oh my gosh! Seriously?!" : "Oh! Now that's nice!"),
    escalation: (t: string) => `And it gets bigger and bigger… ${t} leaves everyone speechless!`,
    gag: () => "And then… nobody expected THIS!",
    payoff: (t: string, funny: boolean) => (funny ? `Lesson of the day: never underestimate ${t}! 😂` : `That's the one thing to remember about ${t}.`),
    moment: (t: string) => `And right then, a warm moment about ${t} makes everyone go quiet.`,
    climax: (t: string) => `The tension rises… and then the truth about ${t} comes out.`,
    touchingEnding: (t: string) => `And from that day on, ${t} became a warm memory.`,
    proPoint: (n: number, t: string) => `Point ${n}: a notable detail about ${t}.`,
    playfulPoint: (n: number, t: string) => `Point ${n}: ${t} has another fun surprise!`,
  },
};

function lowerFirst(s: string): string {
  const t = s.trim().replace(/[.!?]+$/, "");
  return `${t.charAt(0).toLowerCase()}${t.slice(1)}.`;
}

export function writeMockContentScript(req: ContentScriptRequest): ScriptDoc {
  const lang: Lang =
    req.language === "en" ? "en" : req.language === "vi" || req.language === "vi-en" ? "vi" : detectLanguage(`${req.idea} ${req.sourceText}`);
  const t = T[lang];
  const topic = topicOf(req);
  const beats = req.beats;
  const speakingNames = req.characters.map((c) => c.name);
  // QĐ-127: the creative style. Absent (old callers) = the neutral wording as before.
  const style = req.creative;
  const comedy = style?.comedyLevel ?? 0;
  const formal = style ? ["PROFESSIONAL", "PREMIUM", "DOCUMENTARY"].includes(style.tone) : false;
  const playful = style ? comedy >= 2 || ["PLAYFUL", "FUN", "FRIENDLY"].includes(style.tone) : false;
  const hookLine = (topic: string): string => {
    if (!style) return t.hook(topic);
    if (comedy >= 4) return t.funnyHook(topic);
    if (comedy >= 2) return t.wittyHook(topic);
    if (style.emotionStyle === "SUSPENSE" || style.tone === "MYSTERIOUS") return t.mysteryHook(topic);
    if (style.emotionStyle === "TOUCHING" || style.emotionStyle === "WARM" || style.tone === "EMOTIONAL") return t.warmHook(topic);
    if (formal) return t.proHook(topic);
    return t.hook(topic);
  };
  const pointLine = (n: number, topic: string) => (formal ? t.proPoint(n, topic) : playful ? t.playfulPoint(n, topic) : t.point(n, topic));

  // Which beats carry pasted text: everything except the hook and closing beats.
  const closing = new Set(["cta", "contact", "recap", "ending", "for-who", "verdict", "conclusion"]);
  // Creative beats (QĐ-127) carry style, never pasted text or facts - so the
  // source is never lost to a reaction or a punchline.
  const creativeOnly = new Set(["reaction", "escalation", "gag", "payoff", "moment", "climax"]);
  const bodyIdx = beats.map((b, i) => (b.role === "hook" || closing.has(b.role) || creativeOnly.has(b.role) ? -1 : i)).filter((i) => i >= 0);
  const charsBudget = Math.max(60, Math.round(req.durationSeconds * 14));
  const sourceChunks = req.sourceText.trim()
    ? spread(keySentences(req.sourceText, charsBudget), Math.max(1, bodyIdx.length))
    : [];

  // Stated facts only (never AI_GENERATED as a spec), spread over feature-like beats.
  const stated = req.facts.filter((f) => f.origin !== "AI_GENERATED").map((f) => f.text);
  const factBeats = beats
    .map((b, i) => (["what", "feature", "reason", "pro", "item", "offer", "compare", "detail", "step", "solution"].includes(b.role) ? i : -1))
    .filter((i) => i >= 0);
  const factChunks = spread(stated, Math.max(1, factBeats.length));

  const assets = req.userAssets;
  let assetTurn = 0;
  let pointNo = 0;

  const scenes: SceneDoc[] = beats.map((beat, i) => {
    let line: Line;
    const fromSource = bodyIdx.indexOf(i) >= 0 ? (sourceChunks[bodyIdx.indexOf(i)] ?? []) : [];
    const fromFacts = factBeats.indexOf(i) >= 0 ? (factChunks[factBeats.indexOf(i)] ?? []) : [];

    if (beat.role === "hook") {
      line = {
        narration: hookLine(topic),
        dialogue: "",
        visual: comedy >= 3 ? `Exaggerated comic opening about ${topic}: wide eyes, snap zoom` : `Eye-catching opening shot about ${topic}, bold and clear`,
      };
    } else if (beat.role === "reaction") {
      // Wording and expression only: never a new claim about the subject.
      line = { narration: t.reaction(comedy), dialogue: "", visual: `Big funny reaction close-up about ${topic}; ${topic} itself shown exactly as before` };
    } else if (beat.role === "escalation") {
      line = { narration: t.escalation(topic), dialogue: "", visual: `The situation with ${topic} escalates - bigger, sillier, harmless cartoon chaos` };
    } else if (beat.role === "gag") {
      line = { narration: t.gag(), dialogue: "", visual: `Visual gag: an unexpected, silly picture involving ${topic}` };
    } else if (beat.role === "payoff" || (beat.role === "punchline" && style)) {
      line = { narration: t.payoff(topic, comedy >= 2 && !req.factual), dialogue: "", visual: `Punchline beat: freeze-frame reaction with ${topic}` };
    } else if (beat.role === "moment") {
      line = { narration: t.moment(topic), dialogue: "", visual: `Soft, warm close-up: the emotional moment of ${topic}` };
    } else if (beat.role === "climax") {
      line = { narration: t.climax(topic), dialogue: "", visual: `Tense, dramatic shot: the turning point of ${topic}` };
    } else if (fromSource.length > 0) {
      line = { narration: fromSource.join(" "), dialogue: "", visual: `Illustration of: ${fromSource[0]!.slice(0, 120)}` };
    } else if (fromFacts.length > 0) {
      line = { narration: fromFacts.map(t.factLine).join(" "), dialogue: "", visual: `Clean shot highlighting: ${fromFacts[0]!.slice(0, 120)}` };
    } else if (beat.role === "cta" || beat.role === "contact") {
      line = { narration: t.cta(req.cta), dialogue: "", visual: `Closing card for ${topic} with space for text` };
    } else if (beat.role === "recap" || beat.role === "conclusion" || beat.role === "verdict") {
      line = { narration: t.recap(topic), dialogue: "", visual: `Summary card about ${topic}` };
    } else if (beat.role === "ending" || beat.role === "sleep" || beat.role === "cliffhanger") {
      const touching = style?.emotionStyle === "TOUCHING" || style?.emotionStyle === "WARM";
      line = { narration: touching ? t.touchingEnding(topic) : t.ending(topic), dialogue: "", visual: `Warm closing scene of ${topic}` };
    } else if (beat.role === "for-who") {
      line = { narration: t.forWho(topic), dialogue: "", visual: `People who would enjoy ${topic}` };
    } else if (beat.role === "con" || beat.role === "limits" || beat.role === "pros-cons") {
      line = { narration: t.cons, dialogue: "", visual: `Balanced pros and cons card for ${topic}` };
    } else if (req.contentType === "PRODUCT_REVIEW" && beat.role === "what") {
      line = { narration: t.generalProduct(topic), dialogue: "", visual: `Clean product shot of ${topic}` };
    } else if (["story", "event", "explore", "journey", "struggle", "twist"].includes(beat.role)) {
      pointNo += 1;
      line = { narration: t.story(pointNo, topic), dialogue: "", visual: `${beat.label} scene: ${topic}, clear action` };
    } else {
      pointNo += 1;
      line = { narration: pointLine(pointNo, topic), dialogue: "", visual: `${beat.label}: ${topic}` };
    }

    // Who speaks. Narration is read by the voice-only narrator; DIALOGUE /
    // MIXED hand lines to the cast as "Name: line" (QĐ-122 parses them).
    let speaking: string[] = [];
    let present: string[] = [];
    let dialogue = "";
    let narration = line.narration;
    const cast = speakingNames.slice(0, 2);
    const useDialogue =
      cast.length > 0 &&
      (req.voiceMode === "DIALOGUE" || (req.voiceMode === "MIXED" && (beat.role === "hook" || beat.role === "dialogue")));
    if (req.voiceMode === "NO_VOICE") {
      narration = "";
    } else if (useDialogue) {
      const speaker = cast[i % cast.length]!;
      dialogue = `${speaker}: ${line.narration}`;
      narration = "";
      speaking = [speaker];
      present = [speaker];
    } else {
      speaking = [req.narrator];
    }
    const storyLike = ["STORY", "TOY_WORLD", "ENGLISH_CONVERSATION", "ENGLISH_MINI_STORY"].includes(req.contentType);
    if (storyLike && cast.length > 0 && present.length === 0) present = [cast[0]!];

    // The person's own pictures go to the beats that prefer them, in turn.
    const assetIds = beat.prefersUserAsset && assets.length > 0 ? [assets[assetTurn++ % assets.length]!.id] : [];
    const visual = assetIds.length > 0 ? `The user's own photo (${assets.find((a) => a.id === assetIds[0])?.label ?? "photo"}) shown as-is` : line.visual;
    const gagBeat = ["reaction", "escalation", "gag", "payoff", "punchline"].includes(beat.role);
    const camera = comedy >= 3 && gagBeat ? "snap zoom to a reaction close-up, quick cut" : beat.motion === "LOCAL_MOTION" ? "slow push-in" : "gentle tracking shot";
    const action = beat.motion === "LOCAL_MOTION" ? "subtle movement" : "natural motion";
    const drawn = req.characters.filter((c) => present.includes(c.name));

    return {
      sceneNumber: i + 1,
      duration: beat.durationSeconds,
      visualDescription: visual,
      dialogue,
      narration,
      subtitle: dialogue ? line.narration : narration || line.narration,
      camera,
      characterAction: action,
      soundEffect: SFX[beat.role] ?? "",
      imagePrompt: buildImagePrompt(visual, req.stylePrompt, drawn),
      videoPrompt: buildVideoPrompt(visual, req.stylePrompt, camera, action),
      complexity: "LOW",
      spendPriority: "NORMAL",
      charactersPresent: present,
      speakingCharacters: speaking,
      primaryCharacters: present.slice(0, 1),
      characters: present,
      sceneRole: beat.role,
      beatLabel: beat.label,
      motionHint: assetIds.length > 0 ? "LOCAL_MOTION" : beat.motion,
      assetIds,
      // Reference intent: what is used throughout, plus what this scene names.
      referenceIds: (req.references ?? [])
        .filter((r) => r.useThroughout || `${line.narration} ${visual}`.toLowerCase().includes(r.name.toLowerCase()))
        .map((r) => r.id),
    } as SceneDoc;
  });

  const aiFacts = req.factual && stated.length === 0 && req.sourceText.trim().length === 0;
  const doc = {
    idiom: topic,
    title: topic.length > 70 ? `${topic.slice(0, 69)}…` : topic,
    hook: scenes[0]?.narration || scenes[0]?.subtitle || topic,
    meaning: req.idea || req.sourceText.slice(0, 200),
    exampleSentence: "",
    durationTarget: req.durationSeconds,
    scenes,
    closingCTA: req.cta,
    angleKey: `${req.templateId}`,
    contentType: req.contentType,
    templateId: req.templateId,
    templateVersion: req.templateVersion,
    language: req.language,
    facts: [
      ...req.facts,
      ...(aiFacts ? [{ text: `Nội dung về "${topic}" do AI viết - cần kiểm tra trước khi đăng.`, origin: "AI_GENERATED" as const }] : []),
    ],
    needsFactReview: aiFacts,
  };
  return ScriptSchema.parse(doc);
}
