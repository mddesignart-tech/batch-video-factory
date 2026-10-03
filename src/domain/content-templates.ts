/**
 * CONTENT TEMPLATE REGISTRY - the single place a kind of video is described.
 *
 * Every content type goes through the SAME pipeline:
 *
 *   source -> template -> script engine -> scene planner -> storyboard rows ->
 *   image / voice / motion / subtitle / smooth pass / final render
 *
 * A template only changes what the writer is told (structure, tone, rules) and
 * a few defaults. It never adds a stage. Adding a new kind of video = adding
 * one entry here (and, at most, a prompt text) - the pipeline is not touched.
 *
 * Prompt versioning: `promptVersion` is stored on the project that used it
 * (`Project.templateVersion`). Improving a template means adding "-v2"; a
 * project written with "-v1" keeps reading as "-v1".
 *
 * Pure: no database, no provider.
 */

import type { VoiceMode } from "./content-options";

export const CONTENT_CATEGORIES = [
  { id: "ENGLISH", label: "Học tiếng Anh", icon: "📚", hint: "Thành ngữ, từ vựng, hội thoại, ngữ pháp…" },
  { id: "PRODUCT", label: "Review sản phẩm", icon: "🛍", hint: "Giới thiệu, ưu nhược, hướng dẫn dùng, affiliate" },
  { id: "AI", label: "Review công cụ AI", icon: "🤖", hint: "AI này làm gì, tính năng, demo, hạn chế" },
  { id: "TOYS", label: "Thế giới đồ chơi", icon: "🧸", hint: "Xe cộ, robot, tàu hỏa, mini adventure" },
  { id: "ANIMALS", label: "Động vật", icon: "🐾", hint: "Sự thật thú vị, câu chuyện, đố vui" },
  { id: "STORY", label: "Kể chuyện", icon: "📖", hint: "Truyện ngắn, giáo dục, hài, cảm động" },
  { id: "KNOWLEDGE", label: "Kiến thức", icon: "💡", hint: "Khoa học, lịch sử, công nghệ, mẹo vặt" },
  { id: "ADS", label: "Quảng cáo", icon: "📢", hint: "Dịch vụ, sản phẩm, menu, sự kiện, sale" },
  { id: "CUSTOM", label: "Tự do / Custom", icon: "🎬", hint: "Nhập bất kỳ ý tưởng nào" },
] as const;
export type ContentCategory = (typeof CONTENT_CATEGORIES)[number]["id"];

export const CONTENT_TYPES = [
  "ENGLISH_IDIOM",
  "ENGLISH_VOCAB",
  "ENGLISH_CONVERSATION",
  "ENGLISH_GRAMMAR",
  "ENGLISH_PRONUNCIATION",
  "ENGLISH_MISTAKES",
  "ENGLISH_MINI_STORY",
  "PRODUCT_REVIEW",
  "AI_REVIEW",
  "TOY_WORLD",
  "ANIMAL_FACT",
  "STORY",
  "KNOWLEDGE",
  "ADVERTISEMENT",
  "CUSTOM",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** What a project with no contentType (made before this engine) is read as. */
export const LEGACY_CONTENT_TYPE: ContentType = "ENGLISH_IDIOM";

export function isContentType(value: unknown): value is ContentType {
  return typeof value === "string" && (CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * How a scene is best animated. A hint for the router, never a purchase:
 * LOCAL_MOTION is always $0 and always available; VIDEO_AI still goes through
 * preflight, the LOW_AUTO gate and the person's approval.
 */
export type MotionHint = "LOCAL_MOTION" | "VIDEO_AI" | "AUTO";

/** One beat of a template's structure. */
export interface BeatSpec {
  role: string;
  /** Shown in the script preview. */
  label: string;
  /** What the writer must achieve in this beat (sent to the text model). */
  purpose: string;
  /** Share of the running time; normalised by the planner. */
  weight: number;
  motion: MotionHint;
  /** Dropped first when the video is too short for every beat. */
  optional?: boolean;
  /** Repeated (feature 1, 2, 3…) when the video is long enough. */
  repeatable?: boolean;
  /** This beat should show the person's own uploaded asset if there is one. */
  prefersUserAsset?: boolean;
}

export interface TemplateFormat {
  id: string;
  label: string;
  beats: readonly BeatSpec[];
}

export interface ContentTemplate {
  id: ContentType;
  category: ContentCategory;
  name: string;
  description: string;
  /** Script engine. LEGACY_IDIOM = the original idiom writer, byte for byte. */
  engine: "LEGACY_IDIOM" | "CONTENT";
  /** Stored on the project; bump to "-v2" instead of editing a shipped version. */
  promptVersion: string;
  defaultDuration: number;
  defaultAudience: string;
  defaultLanguage: string;
  defaultTone: string;
  defaultVoiceMode: VoiceMode;
  /** StylePreset slug suggested by default. The person can always change it. */
  defaultStyleSlug: string;
  /** The first format is the default. */
  formats: readonly TemplateFormat[];
  /** How the writer should sound. */
  tone: string;
  sceneRules: readonly string[];
  visualRules: readonly string[];
  voiceRules: readonly string[];
  /** Empty = no call to action unless the person asks for one. */
  ctaRules: readonly string[];
  safetyRules: readonly string[];
  /**
   * Factual content an AI writer may get wrong (specs, biology, history).
   * Facts it adds on its own are marked AI_GENERATED and the script is flagged
   * for review before media is made.
   */
  factual: boolean;
  /** Pick of sources this template accepts, in the order the UI shows them. */
  sources: readonly ("PROMPT" | "TEXT" | "ASSETS" | "URL" | "IDIOM" | "STORYBOARD")[];
  /** Placeholder for the big idea box. */
  ideaPlaceholder: string;
}

// ------------------------------------------------------------------ beats ---

const B = (
  role: string,
  label: string,
  purpose: string,
  weight: number,
  motion: MotionHint,
  extra: Partial<BeatSpec> = {},
): BeatSpec => ({ role, label, purpose, weight, motion, ...extra });

const HOOK = (purpose = "grab attention in the first 2 seconds with a question, surprise or bold claim") =>
  B("hook", "Mở đầu (hook)", purpose, 0.14, "AUTO");
const CTA = B("cta", "Kêu gọi (CTA)", "a short, friendly call to action", 0.1, "LOCAL_MOTION", { optional: true });
const RECAP = B("recap", "Tóm tắt", "one-line recap the viewer remembers", 0.1, "LOCAL_MOTION", { optional: true });

const COMMON_SAFETY = [
  "Never invent prices, specifications, statistics, quotes, dates or medical/legal claims that are not in the source.",
  "No real person's likeness, no brand logos except ones the user supplied, no copyrighted characters.",
  "Family-safe content.",
];
const FIRST_PERSON_RULE =
  "Do not pretend to have personally used or tested anything unless the user said so. Use 'Theo thông tin sản phẩm…', 'Điểm đáng chú ý…', 'Sản phẩm hướng tới…' style phrasing instead.";

// -------------------------------------------------------------- templates ---

const ENGLISH_SOURCES = ["PROMPT", "TEXT", "IDIOM", "STORYBOARD"] as const;
const ENGLISH_BASE = {
  category: "ENGLISH" as const,
  engine: "CONTENT" as const,
  defaultDuration: 30,
  defaultAudience: "BEGINNER",
  defaultLanguage: "vi-en",
  defaultTone: "FUN",
  defaultVoiceMode: "MIXED" as const,
  defaultStyleSlug: "3d-cartoon",
  tone: "friendly teacher, fun, clear",
  visualRules: ["Show the situation literally and clearly; leave space for subtitles at the bottom."],
  voiceRules: ["English examples are spoken slowly and clearly; explanations follow the chosen language."],
  ctaRules: [] as string[],
  safetyRules: COMMON_SAFETY,
  factual: false,
  sources: ENGLISH_SOURCES,
};

export const CONTENT_TEMPLATES: readonly ContentTemplate[] = [
  {
    ...ENGLISH_BASE,
    id: "ENGLISH_IDIOM",
    name: "Thành ngữ tiếng Anh",
    description: "Hiểu nhầm nghĩa đen → tình huống hài → nghĩa thật → ví dụ. Dùng thư viện 133 thành ngữ.",
    engine: "LEGACY_IDIOM",
    promptVersion: "idiom-v1",
    defaultDuration: 25,
    defaultLanguage: "en",
    defaultVoiceMode: "DIALOGUE",
    formats: [
      {
        id: "funny-literal",
        label: "Hiểu nhầm nghĩa đen",
        beats: [
          HOOK(),
          B("literal", "Nghĩa đen", "act the idiom out literally", 0.18, "VIDEO_AI"),
          B("escalation", "Tình huống hài", "the mistake escalates", 0.18, "AUTO"),
          B("punchline", "Cao trào", "the funny moment", 0.16, "AUTO"),
          B("meaning", "Nghĩa thật", "explain the real meaning", 0.17, "LOCAL_MOTION"),
          B("example", "Ví dụ", "a natural example sentence", 0.17, "LOCAL_MOTION"),
        ],
      },
    ],
    sceneRules: ["HOOK → literal situation → funny mistake → real meaning → example → recap."],
    // The 133-idiom library and the original writer, unchanged.
    sources: ["IDIOM", "STORYBOARD"],
    ideaPlaceholder: "Ví dụ: “Break a leg” cho người mới học",
  },
  {
    ...ENGLISH_BASE,
    id: "ENGLISH_VOCAB",
    name: "Từ vựng",
    description: "Một nhóm từ theo chủ đề, mỗi từ một cảnh có hình minh hoạ và câu ví dụ.",
    promptVersion: "english-vocab-v1",
    formats: [
      {
        id: "word-list",
        label: "Danh sách từ theo chủ đề",
        beats: [
          HOOK("name the topic and promise how many words"),
          B("word", "Từ mới", "one word: show it, say it, meaning, short example", 0.22, "LOCAL_MOTION", { repeatable: true }),
          RECAP,
        ],
      },
    ],
    sceneRules: ["One word per scene. Word, pronunciation hint, meaning, example sentence."],
    ideaPlaceholder: "Ví dụ: 5 từ vựng về nhà bếp cho trẻ em",
  },
  {
    ...ENGLISH_BASE,
    id: "ENGLISH_CONVERSATION",
    name: "Hội thoại",
    description: "Hai nhân vật nói chuyện trong một tình huống đời thường, kèm giải thích câu quan trọng.",
    promptVersion: "english-conversation-v1",
    defaultVoiceMode: "DIALOGUE",
    formats: [
      {
        id: "dialogue",
        label: "Hội thoại tình huống",
        beats: [
          HOOK("set the everyday situation"),
          B("dialogue", "Hội thoại", "two characters exchange natural lines", 0.25, "AUTO", { repeatable: true }),
          B("key-phrase", "Câu quan trọng", "explain the most useful phrase", 0.18, "LOCAL_MOTION"),
          RECAP,
        ],
      },
    ],
    sceneRules: ["Lines are short and natural; each speaker is labelled 'Name: line'."],
    ideaPlaceholder: "Ví dụ: Gọi đồ uống ở quán cà phê",
  },
  {
    ...ENGLISH_BASE,
    id: "ENGLISH_GRAMMAR",
    name: "Mẹo ngữ pháp",
    description: "Một điểm ngữ pháp: lỗi hay gặp → quy tắc → ví dụ đúng.",
    promptVersion: "english-grammar-v1",
    defaultVoiceMode: "NARRATION",
    formats: [
      {
        id: "tip",
        label: "Mẹo nhanh",
        beats: [
          HOOK("show a common confusing sentence"),
          B("rule", "Quy tắc", "the rule in one simple sentence", 0.25, "LOCAL_MOTION"),
          B("example", "Ví dụ", "correct examples", 0.25, "LOCAL_MOTION", { repeatable: true }),
          RECAP,
        ],
      },
    ],
    sceneRules: ["Show text on screen; keep the rule short."],
    ideaPlaceholder: "Ví dụ: Khi nào dùng “much” và “many”",
  },
  {
    ...ENGLISH_BASE,
    id: "ENGLISH_PRONUNCIATION",
    name: "Mẹo phát âm",
    description: "Âm khó, cách đặt miệng, từ ví dụ, luyện theo.",
    promptVersion: "english-pronunciation-v1",
    defaultVoiceMode: "NARRATION",
    formats: [
      {
        id: "sound",
        label: "Một âm khó",
        beats: [
          HOOK("a word people often mispronounce"),
          B("how", "Cách phát âm", "how to make the sound", 0.25, "LOCAL_MOTION"),
          B("practice", "Luyện theo", "example words to repeat", 0.25, "LOCAL_MOTION", { repeatable: true }),
          RECAP,
        ],
      },
    ],
    sceneRules: ["Say example words slowly; leave a pause for the viewer to repeat."],
    ideaPlaceholder: "Ví dụ: Phân biệt âm /θ/ và /s/",
  },
  {
    ...ENGLISH_BASE,
    id: "ENGLISH_MISTAKES",
    name: "Lỗi thường gặp",
    description: "Câu sai người Việt hay nói → câu đúng → vì sao.",
    promptVersion: "english-mistakes-v1",
    defaultVoiceMode: "NARRATION",
    formats: [
      {
        id: "wrong-right",
        label: "Sai → Đúng",
        beats: [
          HOOK("a mistake almost everyone makes"),
          B("mistake", "Sai → Đúng", "wrong sentence, right sentence, one-line why", 0.25, "LOCAL_MOTION", { repeatable: true }),
          RECAP,
        ],
      },
    ],
    sceneRules: ["Clearly mark wrong vs right on screen."],
    ideaPlaceholder: "Ví dụ: 3 lỗi khi nói về tuổi tác",
  },
  {
    ...ENGLISH_BASE,
    id: "ENGLISH_MINI_STORY",
    name: "Truyện ngắn tiếng Anh",
    description: "Một câu chuyện rất ngắn bằng tiếng Anh đơn giản, có từ mới.",
    promptVersion: "english-mini-story-v1",
    defaultLanguage: "en",
    defaultVoiceMode: "NARRATION",
    formats: [
      {
        id: "story",
        label: "Truyện ngắn",
        beats: [
          HOOK("open the story with a character and a wish or problem"),
          B("story", "Diễn biến", "the story moves forward in simple English", 0.24, "AUTO", { repeatable: true }),
          B("ending", "Kết", "a warm ending", 0.15, "AUTO"),
          B("words", "Từ mới", "recap two new words from the story", 0.12, "LOCAL_MOTION", { optional: true }),
        ],
      },
    ],
    sceneRules: ["Simple past tense, short sentences."],
    ideaPlaceholder: "Ví dụ: Chú mèo muốn bay",
  },
  {
    id: "PRODUCT_REVIEW",
    category: "PRODUCT",
    name: "Review sản phẩm",
    description: "Giới thiệu sản phẩm dựa trên thông tin thật bạn cung cấp; ưu tiên ảnh thật của sản phẩm.",
    engine: "CONTENT",
    promptVersion: "product-review-v1",
    defaultDuration: 30,
    defaultAudience: "ADULTS",
    defaultLanguage: "vi",
    defaultTone: "NATURAL",
    defaultVoiceMode: "NARRATION",
    defaultStyleSlug: "semi-realistic",
    formats: [
      {
        id: "standard",
        label: "Review tiêu chuẩn",
        beats: [
          HOOK(),
          B("what", "Sản phẩm là gì", "what the product is, from the given information", 0.15, "LOCAL_MOTION", { prefersUserAsset: true }),
          B("feature", "Điểm nổi bật", "one stated feature and why it matters", 0.17, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }),
          B("usage", "Cách dùng / minh hoạ", "how it is used in real life", 0.15, "VIDEO_AI", { optional: true }),
          B("pros-cons", "Ưu / nhược", "balanced pros and limitations from the given information", 0.14, "LOCAL_MOTION", { optional: true }),
          B("for-who", "Phù hợp với ai", "who it suits", 0.12, "LOCAL_MOTION"),
          CTA,
        ],
      },
      { id: "quick", label: "Review nhanh", beats: [HOOK(), B("what", "Sản phẩm là gì", "what it is", 0.25, "LOCAL_MOTION", { prefersUserAsset: true }), B("feature", "Điểm nổi bật", "best stated feature", 0.3, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }), CTA] },
      { id: "three-reasons", label: "3 lý do nên cân nhắc", beats: [HOOK("promise three reasons"), B("reason", "Lý do", "one reason backed by the given information", 0.25, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }), CTA] },
      { id: "problem-solution", label: "Vấn đề → Giải pháp", beats: [HOOK("name a relatable problem"), B("problem", "Vấn đề", "show the everyday problem", 0.2, "VIDEO_AI"), B("solution", "Giải pháp", "how the product addresses it, from the given information", 0.25, "LOCAL_MOTION", { prefersUserAsset: true }), B("result", "Kết quả", "what changes", 0.2, "AUTO", { optional: true }), CTA] },
      { id: "how-to", label: "Hướng dẫn sử dụng", beats: [HOOK(), B("step", "Bước", "one usage step", 0.25, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }), B("tip", "Mẹo", "a practical tip", 0.15, "LOCAL_MOTION", { optional: true }), CTA] },
      { id: "pros-cons", label: "Ưu / nhược điểm", beats: [HOOK(), B("pro", "Ưu điểm", "one stated advantage", 0.2, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }), B("con", "Hạn chế", "one honest limitation", 0.2, "LOCAL_MOTION"), B("verdict", "Kết luận", "who should consider it", 0.15, "LOCAL_MOTION"), CTA] },
      { id: "compare", label: "So sánh", beats: [HOOK(), B("compare", "So sánh", "compare one aspect using only given information", 0.25, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }), B("verdict", "Kết luận", "which suits whom", 0.2, "LOCAL_MOTION"), CTA] },
      { id: "top-list", label: "Top sản phẩm", beats: [HOOK("promise a top list"), B("item", "Sản phẩm", "one product and its stated highlight", 0.22, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }), CTA] },
      { id: "affiliate", label: "Video affiliate", beats: [HOOK(), B("what", "Sản phẩm", "what it is", 0.2, "LOCAL_MOTION", { prefersUserAsset: true }), B("feature", "Điểm nổi bật", "stated feature", 0.22, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }), B("cta", "Kêu gọi", "where to find it (link in bio style), no fake urgency", 0.14, "LOCAL_MOTION")] },
      { id: "showcase", label: "Product showcase", beats: [B("reveal", "Ra mắt", "a clean reveal of the product", 0.25, "LOCAL_MOTION", { prefersUserAsset: true }), B("detail", "Chi tiết", "one visual detail", 0.25, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }), B("lifestyle", "Bối cảnh", "the product in a lifestyle setting", 0.2, "VIDEO_AI", { optional: true }), CTA] },
    ],
    tone: "honest, helpful, not pushy",
    sceneRules: ["Every claim about the product must come from the product information given; otherwise say it generally or leave it out."],
    visualRules: [
      "When a real product photo exists, SHOW THAT PHOTO (pan/zoom/crop) - never redraw the product with AI.",
      "Feature and text scenes use clean product shots with room for an on-screen caption.",
    ],
    voiceRules: ["One narrator, warm and clear."],
    ctaRules: ["CTA only if the user gave one, or a soft generic one ('Xem thêm thông tin ở mô tả')."],
    safetyRules: [...COMMON_SAFETY, FIRST_PERSON_RULE],
    factual: true,
    sources: ["PROMPT", "TEXT", "ASSETS", "URL"],
    ideaPlaceholder: "Tên sản phẩm + mô tả, thông số, ưu/nhược điểm bạn biết…",
  },
  {
    id: "AI_REVIEW",
    category: "AI",
    name: "Review công cụ AI",
    description: "AI này làm gì → 3 tính năng → demo → ưu / hạn chế → phù hợp với ai.",
    engine: "CONTENT",
    promptVersion: "ai-review-v1",
    defaultDuration: 45,
    defaultAudience: "ADULTS",
    defaultLanguage: "vi",
    defaultTone: "ENERGETIC",
    defaultVoiceMode: "NARRATION",
    defaultStyleSlug: "stylized-animation",
    formats: [
      {
        id: "standard",
        label: "Review tiêu chuẩn",
        beats: [
          HOOK(),
          B("what", "AI này làm gì", "what the tool does in one sentence", 0.14, "LOCAL_MOTION", { prefersUserAsset: true }),
          B("feature", "Tính năng đáng chú ý", "one notable feature", 0.15, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }),
          B("demo", "Demo / use case", "a concrete use case", 0.15, "LOCAL_MOTION", { prefersUserAsset: true }),
          B("pros", "Ưu điểm", "main strengths", 0.1, "LOCAL_MOTION", { optional: true }),
          B("limits", "Hạn chế", "honest limitations", 0.1, "LOCAL_MOTION"),
          B("for-who", "Phù hợp với ai", "who should try it", 0.1, "LOCAL_MOTION"),
          CTA,
        ],
      },
    ],
    tone: "curious, practical, honest",
    sceneRules: ["Screenshots the user gave are shown as-is (LOCAL_MOTION)."],
    visualRules: ["Clean UI-like visuals, readable text, no fake app screenshots of real brands."],
    voiceRules: ["One narrator."],
    ctaRules: [],
    safetyRules: [...COMMON_SAFETY, FIRST_PERSON_RULE, "Pricing and plan limits only from the source."],
    factual: true,
    sources: ["PROMPT", "TEXT", "ASSETS", "URL"],
    ideaPlaceholder: "Ví dụ: Giới thiệu 5 lợi ích của ChatGPT cho cửa hàng nhỏ",
  },
  {
    id: "TOY_WORLD",
    category: "TOYS",
    name: "Thế giới đồ chơi",
    description: "Câu chuyện vui với xe cộ, robot, tàu hỏa, mô hình đồ chơi.",
    engine: "CONTENT",
    promptVersion: "toy-world-v1",
    defaultDuration: 30,
    defaultAudience: "KIDS",
    defaultLanguage: "vi",
    defaultTone: "FUN",
    defaultVoiceMode: "NARRATION",
    defaultStyleSlug: "clay-3d",
    formats: [
      {
        id: "adventure",
        label: "Mini adventure",
        beats: [
          HOOK("introduce the toy hero and where it is going"),
          B("explore", "Khám phá", "the toy explores and meets something new", 0.22, "VIDEO_AI", { repeatable: true }),
          B("challenge", "Thử thách", "a small, safe problem", 0.18, "AUTO"),
          B("solve", "Giải quyết", "the toy solves it", 0.18, "AUTO"),
          B("ending", "Kết vui", "a happy ending", 0.12, "LOCAL_MOTION"),
        ],
      },
    ],
    tone: "playful, bright, simple",
    sceneRules: ["One clear action per scene; suggest a sound effect for each scene."],
    visualRules: ["Bright, clear toy-like visuals, large readable shapes, uncluttered backgrounds."],
    voiceRules: ["Cheerful narrator; optional toy voices."],
    ctaRules: [],
    safetyRules: [...COMMON_SAFETY, "No dangerous imitation (no fire, no traffic stunts)."],
    factual: false,
    sources: ["PROMPT", "TEXT", "ASSETS"],
    ideaPlaceholder: "Ví dụ: Xe tải đồ chơi khám phá công trường",
  },
  {
    id: "ANIMAL_FACT",
    category: "ANIMALS",
    name: "Động vật",
    description: "Sự thật thú vị, mini documentary, câu chuyện, đoán con vật, top 5.",
    engine: "CONTENT",
    promptVersion: "animal-facts-v1",
    defaultDuration: 30,
    defaultAudience: "GENERAL",
    defaultLanguage: "vi",
    defaultTone: "EDUCATIONAL",
    defaultVoiceMode: "NARRATION",
    defaultStyleSlug: "semi-realistic",
    formats: [
      { id: "facts", label: "Sự thật thú vị", beats: [HOOK(), B("fact", "Sự thật", "one well-established fact", 0.22, "VIDEO_AI", { repeatable: true }), RECAP] },
      { id: "documentary", label: "Mini documentary", beats: [HOOK(), B("habitat", "Môi trường sống", "where it lives", 0.2, "VIDEO_AI"), B("behaviour", "Tập tính", "a well-known behaviour", 0.22, "VIDEO_AI", { repeatable: true }), B("closing", "Kết", "a memorable closing line", 0.14, "LOCAL_MOTION")] },
      { id: "story", label: "Câu chuyện động vật", beats: [HOOK(), B("story", "Diễn biến", "the animal's story moves forward", 0.24, "VIDEO_AI", { repeatable: true }), B("ending", "Kết", "a gentle ending", 0.15, "AUTO")] },
      { id: "guess", label: "Đoán con vật", beats: [HOOK("ask the viewer to guess"), B("clue", "Gợi ý", "one clue", 0.2, "LOCAL_MOTION", { repeatable: true }), B("reveal", "Đáp án", "the reveal", 0.2, "VIDEO_AI")] },
      { id: "top5", label: "Top 5", beats: [HOOK("promise a top list"), B("item", "Hạng", "one animal and why", 0.18, "VIDEO_AI", { repeatable: true }), RECAP] },
      { id: "compare", label: "So sánh động vật", beats: [HOOK(), B("compare", "So sánh", "compare one trait", 0.24, "LOCAL_MOTION", { repeatable: true }), B("verdict", "Kết luận", "the fun conclusion", 0.15, "LOCAL_MOTION")] },
      { id: "kids", label: "Video trẻ em", beats: [HOOK(), B("animal", "Con vật", "name, sound, one simple fact", 0.22, "VIDEO_AI", { repeatable: true }), RECAP] },
    ],
    tone: "curious, warm, accurate",
    sceneRules: ["Only widely established facts; when unsure say it generally."],
    visualRules: ["Natural, accurate depiction of the animal and its habitat."],
    voiceRules: ["Narrator."],
    ctaRules: [],
    safetyRules: [...COMMON_SAFETY, "Never attribute behaviour or biology the source does not support; no feeding/handling advice."],
    factual: true,
    sources: ["PROMPT", "TEXT", "ASSETS"],
    ideaPlaceholder: "Ví dụ: 5 sự thật thú vị về chim cánh cụt",
  },
  {
    id: "STORY",
    category: "STORY",
    name: "Kể chuyện",
    description: "Truyện ngắn, giáo dục, phiêu lưu, hài, cảm động, ru ngủ, nhiều tập.",
    engine: "CONTENT",
    promptVersion: "story-v1",
    defaultDuration: 45,
    defaultAudience: "KIDS",
    defaultLanguage: "vi",
    defaultTone: "GENTLE",
    defaultVoiceMode: "MIXED",
    defaultStyleSlug: "3d-cartoon",
    formats: [
      { id: "short", label: "Truyện ngắn", beats: [B("intro", "Mở truyện", "introduce the hero and setting", 0.16, "AUTO"), B("event", "Diễn biến", "the story moves forward", 0.22, "VIDEO_AI", { repeatable: true }), B("climax", "Cao trào", "the turning point", 0.18, "VIDEO_AI"), B("ending", "Kết", "a satisfying ending", 0.14, "AUTO")] },
      { id: "lesson", label: "Câu chuyện giáo dục", beats: [B("intro", "Mở truyện", "hero and setting", 0.15, "AUTO"), B("event", "Diễn biến", "what happens", 0.22, "VIDEO_AI", { repeatable: true }), B("lesson", "Bài học", "the gentle lesson", 0.16, "LOCAL_MOTION")] },
      { id: "adventure", label: "Mini adventure", beats: [HOOK(), B("journey", "Hành trình", "the adventure continues", 0.24, "VIDEO_AI", { repeatable: true }), B("ending", "Kết", "return home", 0.15, "AUTO")] },
      { id: "funny", label: "Truyện hài", beats: [HOOK(), B("setup", "Tình huống", "set up the joke", 0.22, "AUTO"), B("twist", "Bất ngờ", "the funny twist", 0.22, "VIDEO_AI", { repeatable: true }), B("punchline", "Kết hài", "the punchline", 0.16, "AUTO")] },
      { id: "emotional", label: "Truyện cảm động", beats: [B("intro", "Mở truyện", "hero and wish", 0.18, "AUTO"), B("struggle", "Khó khăn", "a struggle", 0.22, "VIDEO_AI", { repeatable: true }), B("moment", "Khoảnh khắc", "the emotional moment", 0.2, "VIDEO_AI"), B("ending", "Kết", "a warm ending", 0.14, "LOCAL_MOTION")] },
      { id: "bedtime", label: "Truyện ru ngủ", beats: [B("intro", "Mở truyện", "a calm opening", 0.18, "LOCAL_MOTION"), B("event", "Diễn biến", "a slow, soothing event", 0.24, "LOCAL_MOTION", { repeatable: true }), B("sleep", "Kết", "everyone falls asleep", 0.16, "LOCAL_MOTION")] },
      { id: "serial", label: "Truyện nhiều tập", beats: [B("recap", "Tập trước", "a one-line recap", 0.1, "LOCAL_MOTION", { optional: true }), B("event", "Diễn biến", "this episode's events", 0.24, "VIDEO_AI", { repeatable: true }), B("cliffhanger", "Hẹn tập sau", "a gentle cliffhanger", 0.14, "AUTO")] },
    ],
    tone: "warm storyteller",
    sceneRules: [
      "Character Bible: every recurring character keeps the same look, outfit and colours in every scene.",
      "Keep locations, costumes and props continuous between scenes.",
    ],
    visualRules: ["One consistent visual style for the whole story."],
    voiceRules: ["Narrator carries the story; characters speak short lines 'Name: line'."],
    ctaRules: [],
    safetyRules: COMMON_SAFETY,
    factual: false,
    sources: ["PROMPT", "TEXT", "ASSETS"],
    ideaPlaceholder: "Ví dụ: Chú thỏ nhỏ học cách chia sẻ",
  },
  {
    id: "KNOWLEDGE",
    category: "KNOWLEDGE",
    name: "Kiến thức",
    description: "Khoa học, lịch sử, công nghệ, mẹo vặt, giải thích khái niệm.",
    engine: "CONTENT",
    promptVersion: "knowledge-v1",
    defaultDuration: 45,
    defaultAudience: "GENERAL",
    defaultLanguage: "vi",
    defaultTone: "EDUCATIONAL",
    defaultVoiceMode: "NARRATION",
    defaultStyleSlug: "stylized-animation",
    formats: [
      {
        id: "explain",
        label: "Giải thích",
        beats: [
          HOOK(),
          B("question", "Vấn đề / câu hỏi", "the question being answered", 0.14, "LOCAL_MOTION"),
          B("explain", "Giải thích", "one step of the explanation", 0.22, "LOCAL_MOTION", { repeatable: true }),
          B("example", "Ví dụ", "a concrete example", 0.16, "AUTO"),
          B("conclusion", "Kết luận", "the takeaway", 0.12, "LOCAL_MOTION"),
        ],
      },
      { id: "tips", label: "Mẹo vặt", beats: [HOOK(), B("tip", "Mẹo", "one practical tip", 0.24, "LOCAL_MOTION", { repeatable: true }), RECAP] },
    ],
    tone: "clear teacher",
    sceneRules: ["One idea per scene; diagrams and on-screen text are welcome."],
    visualRules: ["Infographic-friendly clean visuals."],
    voiceRules: ["Narrator."],
    ctaRules: [],
    safetyRules: [...COMMON_SAFETY, "Dates, numbers and names only from the source; otherwise keep it general."],
    factual: true,
    sources: ["PROMPT", "TEXT", "ASSETS", "URL"],
    ideaPlaceholder: "Ví dụ: Vì sao bầu trời màu xanh?",
  },
  {
    id: "ADVERTISEMENT",
    category: "ADS",
    name: "Quảng cáo",
    description: "Giới thiệu dịch vụ, sản phẩm, menu, in ấn, sự kiện, sale, cửa hàng địa phương.",
    engine: "CONTENT",
    promptVersion: "advertisement-v1",
    defaultDuration: 15,
    defaultAudience: "GENERAL",
    defaultLanguage: "vi",
    defaultTone: "ENERGETIC",
    defaultVoiceMode: "NARRATION",
    defaultStyleSlug: "semi-realistic",
    formats: [
      {
        id: "promo",
        label: "Quảng cáo ngắn",
        beats: [
          HOOK(),
          B("offer", "Ưu đãi / dịch vụ", "what is offered, from the given information", 0.25, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }),
          B("why", "Vì sao chọn", "one stated reason", 0.2, "LOCAL_MOTION", { optional: true, prefersUserAsset: true }),
          B("contact", "Liên hệ", "contact / CTA exactly as provided (phone, website, Zalo)", 0.15, "LOCAL_MOTION", { optional: true }),
        ],
      },
      { id: "menu", label: "Menu", beats: [HOOK(), B("item", "Món", "one menu item exactly as provided", 0.22, "LOCAL_MOTION", { repeatable: true, prefersUserAsset: true }), B("contact", "Liên hệ", "contact as provided", 0.15, "LOCAL_MOTION", { optional: true })] },
      { id: "event", label: "Sự kiện / Sale", beats: [HOOK(), B("what", "Sự kiện", "what, when, where - as provided", 0.3, "LOCAL_MOTION", { prefersUserAsset: true }), B("highlight", "Điểm nhấn", "one highlight", 0.25, "AUTO", { repeatable: true }), B("contact", "Liên hệ", "contact as provided", 0.15, "LOCAL_MOTION", { optional: true })] },
    ],
    tone: "upbeat, clear, local",
    sceneRules: ["Logo and brand colours from the user's assets; contact details copied exactly."],
    visualRules: ["Clean commercial look; leave space for text overlays and the logo."],
    voiceRules: ["Narrator."],
    ctaRules: ["CTA only when the user gave contact details or a call to action. Never invent phone numbers or links."],
    safetyRules: [...COMMON_SAFETY, "No fake urgency, no invented discounts or prices."],
    factual: true,
    sources: ["PROMPT", "TEXT", "ASSETS"],
    ideaPlaceholder: "Ví dụ: In ấn Mind Decor – in bạt, standee, giao nhanh trong ngày",
  },
  {
    id: "CUSTOM",
    category: "CUSTOM",
    name: "Tự do",
    description: "Bất kỳ ý tưởng nào. Không ép theo cấu trúc thành ngữ.",
    engine: "CONTENT",
    promptVersion: "custom-v1",
    defaultDuration: 30,
    defaultAudience: "GENERAL",
    defaultLanguage: "vi",
    defaultTone: "AUTO",
    defaultVoiceMode: "NARRATION",
    defaultStyleSlug: "3d-cartoon",
    formats: [
      {
        id: "free",
        label: "Tự do",
        beats: [
          HOOK(),
          B("body", "Nội dung", "the next point of the idea", 0.24, "AUTO", { repeatable: true }),
          B("ending", "Kết", "a clear ending", 0.14, "LOCAL_MOTION"),
        ],
      },
    ],
    tone: "follows the idea",
    sceneRules: ["Follow the user's idea; choose the structure that fits it best."],
    visualRules: ["One consistent visual style."],
    voiceRules: [],
    ctaRules: [],
    safetyRules: COMMON_SAFETY,
    factual: false,
    sources: ["PROMPT", "TEXT", "ASSETS"],
    ideaPlaceholder: "Ví dụ: Làm video 45 giây về…",
  },
];

export function templateOf(id: string | null | undefined): ContentTemplate {
  return CONTENT_TEMPLATES.find((t) => t.id === id) ?? CONTENT_TEMPLATES.find((t) => t.id === LEGACY_CONTENT_TYPE)!;
}

export function templatesInCategory(category: string): ContentTemplate[] {
  return CONTENT_TEMPLATES.filter((t) => t.category === category);
}

export function formatOf(template: ContentTemplate, formatId: string | null | undefined): TemplateFormat {
  return template.formats.find((f) => f.id === formatId) ?? template.formats[0]!;
}

/**
 * The stored template id: "<contentType>:<format>". The prompt version is
 * stored separately (`Project.templateVersion`).
 */
export function templateIdFor(template: ContentTemplate, format: TemplateFormat): string {
  return `${template.id}:${format.id}`;
}

export function parseTemplateId(value: string | null | undefined): { contentType: string | null; formatId: string | null } {
  if (!value) return { contentType: null, formatId: null };
  const [contentType, formatId] = value.split(":");
  return { contentType: contentType ?? null, formatId: formatId ?? null };
}

/** Internal consistency check, run by tests: catches a typo in a new template. */
export function validateRegistry(): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const t of CONTENT_TEMPLATES) {
    if (ids.has(t.id)) problems.push(`trùng id ${t.id}`);
    ids.add(t.id);
    if (!CONTENT_CATEGORIES.some((c) => c.id === t.category)) problems.push(`${t.id}: category lạ ${t.category}`);
    if (t.formats.length === 0) problems.push(`${t.id}: không có format`);
    if (!/-v\d+$/.test(t.promptVersion)) problems.push(`${t.id}: promptVersion phải kết thúc bằng -vN`);
    for (const f of t.formats) {
      if (f.beats.length === 0) problems.push(`${t.id}:${f.id}: không có beat`);
      if (f.beats.every((b) => b.optional)) problems.push(`${t.id}:${f.id}: mọi beat đều optional`);
    }
  }
  for (const id of CONTENT_TYPES) if (!ids.has(id)) problems.push(`thiếu template ${id}`);
  for (const c of CONTENT_CATEGORIES) {
    if (!CONTENT_TEMPLATES.some((t) => t.category === c.id)) problems.push(`category ${c.id} không có template`);
  }
  return problems;
}
