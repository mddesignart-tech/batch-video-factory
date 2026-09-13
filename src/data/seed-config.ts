/**
 * Seed configuration: characters, style presets, model registry and provider
 * slots.
 *
 * The prices below are *placeholders for mock mode*, not quoted vendor rates.
 * Real prices are entered by the operator in the "Mô hình AI" admin page before
 * a provider is switched on. Nothing in the application reads a price from
 * anywhere except the ModelRegistry table.
 */

export interface SeedCharacter {
  name: string;
  description: string;
  personality: string;
  visualPrompt: string;
  negativePrompt: string;
  voiceId: string;
  seed: number;
  notes: string;
}

export const SEED_CHARACTERS: SeedCharacter[] = [
  {
    name: "Max",
    description:
      "Nhân vật chính. Luôn hiểu thành ngữ theo nghĩa đen và gây ra tình huống hài hước.",
    personality:
      "Naive, enthusiastic, very expressive. Takes every idiom literally and commits to it completely.",
    // The canonical character sheet. This exact string is pasted into every
    // image and video prompt for Max, which is what keeps him on-model.
    visualPrompt:
      "Max: young adult male cartoon character, short messy dark brown hair, large round expressive eyes, " +
      "light warm skin, bright yellow hoodie with a white stripe, blue jeans, white sneakers, " +
      "slightly oversized head proportions, friendly rounded shapes, always wide-eyed and eager",
    negativePrompt:
      "realistic human photo, extra fingers, deformed hands, changing hair colour, changing outfit, " +
      "scary features, text artifacts, watermark, blurry face",
    voiceId: "mock-male-us",
    seed: 110022,
    notes:
      "Giữ nguyên áo hoodie vàng và tóc nâu trong mọi cảnh để đảm bảo tính nhất quán.",
  },
  {
    name: "Leo",
    description:
      "Người bạn thông minh hơn. Giải thích nghĩa thật của thành ngữ và phản ứng với Max.",
    personality:
      "Calm, patient, a bit sarcastic. The straight man who explains what the idiom actually means.",
    visualPrompt:
      "Leo: young adult male cartoon character, neat black hair with a side part, round glasses, " +
      "medium brown skin, teal button-up shirt with rolled sleeves, dark grey trousers, brown shoes, " +
      "calm confident posture, slightly taller than Max, warm friendly smile",
    negativePrompt:
      "realistic human photo, extra fingers, deformed hands, missing glasses, changing shirt colour, " +
      "scary features, text artifacts, watermark, blurry face",
    voiceId: "mock-male-uk",
    seed: 220033,
    notes: "Luôn đeo kính tròn và mặc áo sơ mi xanh teal.",
  },
];

export interface SeedStylePreset {
  name: string;
  slug: string;
  positivePrompt: string;
  negativePrompt: string;
  lightingStyle: string;
  cameraLanguage: string;
  visualTone: string;
  isDefault: boolean;
}

/**
 * Style language is deliberately generic. No studio names, no "in the style of"
 * a copyrighted franchise - just describable visual properties.
 */
export const SEED_STYLE_PRESETS: SeedStylePreset[] = [
  {
    name: "3D Cartoon",
    slug: "3d-cartoon",
    positivePrompt:
      "3D animated cartoon style, smooth rounded shapes, soft subsurface shading, " +
      "bright saturated colours, clean simple backgrounds, appealing family-friendly character design",
    negativePrompt:
      "photorealistic, horror, gore, text, watermark, extra limbs, deformed hands, dark grim palette",
    lightingStyle: "Soft three-point lighting with a warm key and gentle rim light",
    cameraLanguage: "Simple, readable framing; push-ins for reactions; no complex camera rigs",
    visualTone: "Cheerful, playful, exaggerated, family friendly",
    isDefault: true,
  },
  {
    name: "Stylized Animation",
    slug: "stylized-animation",
    positivePrompt:
      "stylised 2.5D animation, bold clean outlines, flat colour blocking with subtle gradients, " +
      "graphic shapes, expressive silhouettes, uncluttered background",
    negativePrompt:
      "photorealistic, gore, text, watermark, muddy colours, cluttered background, deformed anatomy",
    lightingStyle: "Flat graphic lighting with one strong accent colour",
    cameraLanguage: "Snappy cuts, held poses, quick whip pans",
    visualTone: "Energetic, graphic, modern",
    isDefault: false,
  },
  {
    name: "Clay 3D",
    slug: "clay-3d",
    positivePrompt:
      "claymation style, handmade plasticine texture, visible fingerprints, chunky rounded forms, " +
      "tabletop miniature set, soft matte surfaces",
    negativePrompt:
      "photorealistic humans, gore, text, watermark, glossy plastic, thin fragile shapes",
    lightingStyle: "Warm practical lights, soft shadows, shallow depth of field",
    cameraLanguage: "Locked-off shots with small handheld drift, macro close-ups",
    visualTone: "Charming, tactile, homemade",
    isDefault: false,
  },
  {
    name: "Comic",
    slug: "comic",
    positivePrompt:
      "comic book illustration style, bold ink outlines, halftone dot shading, " +
      "dynamic action poses, speech-bubble friendly negative space",
    negativePrompt:
      "photorealistic, gore, watermark, muddy ink, unreadable panels, deformed hands",
    lightingStyle: "High contrast cel shading with hard shadow shapes",
    cameraLanguage: "Dramatic angles, dutch tilts, strong foreground framing",
    visualTone: "Punchy, bold, high energy",
    isDefault: false,
  },
  {
    name: "Semi Realistic",
    slug: "semi-realistic",
    positivePrompt:
      "semi-realistic stylised 3D render, believable proportions with slightly exaggerated features, " +
      "detailed fabric and hair, cinematic depth of field, natural colour palette",
    negativePrompt:
      "photoreal human likeness of a real person, gore, text, watermark, uncanny distorted faces",
    lightingStyle: "Cinematic key light with soft fill and practical background lights",
    cameraLanguage: "Slow dollies, shallow focus, tasteful handheld",
    visualTone: "Warm, grounded, gently comedic",
    isDefault: false,
  },
  {
    name: "Simple Cartoon",
    slug: "simple-cartoon",
    positivePrompt:
      "very simple 2D cartoon, thick clean lines, minimal flat colours, few details, " +
      "large readable shapes, plain pastel background",
    negativePrompt:
      "photorealistic, gore, text, watermark, busy detail, tiny elements, complex background",
    lightingStyle: "No rendered lighting, flat colour fills only",
    cameraLanguage: "Static shots and simple horizontal pans",
    visualTone: "Minimal, clear, instantly readable on a small phone screen",
    isDefault: false,
  },
];

export interface SeedModel {
  provider: string;
  modelId: string;
  displayName: string;
  type: "text" | "image" | "video" | "voice" | "upscale" | "quality";
  enabled: boolean;
  priceUnit: "per_second" | "per_image" | "per_1k_chars" | "per_1k_tokens" | "per_job";
  price: number;
  /** Text models only: output tokens are billed at a different rate. */
  priceOutput?: number;
  supportsTextToVideo?: boolean;
  supportsImageToVideo?: boolean;
  supportsReferenceImage?: boolean;
  supportsCharacterReference?: boolean;
  supportsAudio?: boolean;
  supports1080p?: boolean;
  supportsUpscale?: boolean;
  maxDuration?: number;
  qualityRating: number;
  speedRating: number;
  consistencyRating: number;
  notes: string;
}

/**
 * Model registry seed.
 *
 * The `mock-*` family is what actually runs in Milestone 1. It carries three
 * tiers per media type at **simulated** prices - deliberately not $0.
 *
 * Why simulate a price for a provider that charges nothing: with every model at
 * zero the router has no cost signal at all, so it would always pick the highest
 * quality option, and the cost preview, MAX BUDGET check and batch optimiser
 * would all be untestable. Simulated prices make the whole economic layer
 * exercisable before a single real key is added. They affect *estimates* only -
 * mock providers report an actual cost of $0, so the cost ledger and the
 * dashboard truthfully show that nothing was spent.
 *
 * The real-vendor rows are seeded **disabled with price 0** so the registry UI
 * has something to configure, but they can never be selected by the router until
 * an operator enables them and enters that vendor's real price. Shipping a
 * guessed vendor price would be worse than shipping none.
 */
export const SEED_MODELS: SeedModel[] = [
  // ---- mock family: three tiers so routing decisions are actually visible ---
  {
    provider: "mock",
    modelId: "mock-text-1",
    displayName: "Mock Text (kịch bản)",
    type: "text",
    enabled: true,
    priceUnit: "per_1k_tokens",
    price: 0.0015,
    qualityRating: 7,
    speedRating: 9,
    consistencyRating: 7,
    notes: "Bộ sinh kịch bản mẫu, không gọi API.",
  },
  {
    provider: "mock",
    modelId: "mock-image-fast",
    displayName: "Mock Image Fast (rẻ)",
    type: "image",
    enabled: true,
    priceUnit: "per_image",
    price: 0.004,
    supportsReferenceImage: true,
    supports1080p: true,
    qualityRating: 5,
    speedRating: 9,
    consistencyRating: 5,
    notes: "Tầng rẻ, dùng cho cảnh đơn giản.",
  },
  {
    provider: "mock",
    modelId: "mock-image-pro",
    displayName: "Mock Image Pro (chất lượng)",
    type: "image",
    enabled: true,
    priceUnit: "per_image",
    price: 0.02,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supports1080p: true,
    qualityRating: 9,
    speedRating: 6,
    consistencyRating: 9,
    notes: "Tầng cao, giữ nhân vật nhất quán tốt hơn.",
  },
  {
    provider: "mock",
    modelId: "mock-video-lite",
    displayName: "Mock Video Lite (rẻ)",
    type: "video",
    enabled: true,
    priceUnit: "per_second",
    price: 0.012,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supports1080p: true,
    maxDuration: 6,
    qualityRating: 4,
    speedRating: 9,
    consistencyRating: 4,
    notes: "Tầng rẻ nhất. Phù hợp cảnh tĩnh, giải thích.",
  },
  {
    provider: "mock",
    modelId: "mock-video-std",
    displayName: "Mock Video Standard (cân bằng)",
    type: "video",
    enabled: true,
    priceUnit: "per_second",
    price: 0.045,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supports1080p: true,
    maxDuration: 8,
    qualityRating: 7,
    speedRating: 7,
    consistencyRating: 7,
    notes: "Tầng mặc định cho chế độ Cân bằng.",
  },
  {
    provider: "mock",
    modelId: "mock-video-pro",
    displayName: "Mock Video Pro (chất lượng cao)",
    type: "video",
    enabled: true,
    priceUnit: "per_second",
    price: 0.13,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supportsAudio: true,
    supports1080p: true,
    maxDuration: 10,
    qualityRating: 10,
    speedRating: 4,
    consistencyRating: 10,
    notes: "Tầng cao nhất. Dùng cho hook và punchline.",
  },
  {
    provider: "mock",
    modelId: "mock-voice-std",
    displayName: "Mock Voice Standard",
    type: "voice",
    enabled: true,
    priceUnit: "per_1k_chars",
    price: 0.015,
    supportsAudio: true,
    qualityRating: 6,
    speedRating: 9,
    consistencyRating: 8,
    notes: "Giọng đọc mẫu tổng hợp cục bộ.",
  },
  {
    provider: "mock",
    modelId: "mock-voice-pro",
    displayName: "Mock Voice Pro",
    type: "voice",
    enabled: true,
    priceUnit: "per_1k_chars",
    price: 0.05,
    supportsAudio: true,
    qualityRating: 9,
    speedRating: 7,
    consistencyRating: 9,
    notes: "Giọng đọc mẫu chất lượng cao hơn.",
  },
  {
    provider: "mock",
    modelId: "mock-quality-1",
    displayName: "Mock Quality Evaluator",
    type: "quality",
    enabled: true,
    priceUnit: "per_job",
    price: 0.002,
    qualityRating: 7,
    speedRating: 9,
    consistencyRating: 7,
    notes: "Chấm điểm cảnh sau khi tạo.",
  },
  {
    provider: "mock",
    modelId: "mock-upscale-1",
    displayName: "Mock Upscaler",
    type: "upscale",
    enabled: true,
    priceUnit: "per_job",
    price: 0.01,
    supportsUpscale: true,
    qualityRating: 6,
    speedRating: 8,
    consistencyRating: 8,
    notes: "Nâng cấp độ phân giải (mock).",
  },

  // ---- real vendors: disabled, price 0 until the operator fills them in ----
  {
    provider: "openai",
    modelId: "gpt-4o-mini",
    displayName: "OpenAI GPT-4o mini (nhap gia truoc khi bat)",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0,
    priceOutput: 0,
    qualityRating: 8,
    speedRating: 9,
    consistencyRating: 8,
    notes:
      "Re, du tot cho kich ban ngan. Nhap gia input/output thuc te tu bang gia OpenAI truoc khi bat.",
  },
  {
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "OpenAI GPT-4o (nhap gia truoc khi bat)",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0,
    priceOutput: 0,
    qualityRating: 9,
    speedRating: 7,
    consistencyRating: 9,
    notes: "Chat luong cao hon, dat hon. Nhap gia thuc te truoc khi bat.",
  },
  {
    provider: "deepseek",
    modelId: "deepseek-chat",
    displayName: "DeepSeek Chat (nhap gia truoc khi bat)",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0,
    priceOutput: 0,
    qualityRating: 8,
    speedRating: 8,
    consistencyRating: 7,
    notes: "Tuong thich OpenAI API. Nhap gia thuc te truoc khi bat.",
  },
  {
    provider: "groq",
    modelId: "llama-3.3-70b-versatile",
    displayName: "Groq Llama 3.3 70B (nhap gia truoc khi bat)",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0,
    priceOutput: 0,
    qualityRating: 7,
    speedRating: 10,
    consistencyRating: 7,
    notes: "Rat nhanh, tuong thich OpenAI API. Nhap gia thuc te truoc khi bat.",
  },
  {
    provider: "ollama",
    modelId: "llama3.1",
    displayName: "Ollama llama3.1 (chay cuc bo, MIEN PHI)",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0,
    priceOutput: 0,
    qualityRating: 6,
    speedRating: 5,
    consistencyRating: 6,
    notes:
      "Chay tren may qua Ollama (http://localhost:11434). Khong can API key, chi phi luon 0 USD. Cach re nhat de thu Text AI that.",
  },
  {
    provider: "openai",
    modelId: "gpt-image",
    displayName: "OpenAI Image (chưa cấu hình)",
    type: "image",
    enabled: false,
    priceUnit: "per_image",
    price: 0,
    supportsReferenceImage: true,
    supports1080p: true,
    qualityRating: 8,
    speedRating: 7,
    consistencyRating: 7,
    notes: "Milestone 2. Nhập giá thực tế trước khi bật.",
  },
  {
    provider: "google",
    modelId: "veo-video",
    displayName: "Google Veo (chưa cấu hình)",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supportsAudio: true,
    supports1080p: true,
    maxDuration: 8,
    qualityRating: 9,
    speedRating: 6,
    consistencyRating: 8,
    notes: "Milestone 3. Nhập giá thực tế trước khi bật.",
  },
  {
    provider: "runway",
    modelId: "runway-video",
    displayName: "Runway (chưa cấu hình)",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supports1080p: true,
    maxDuration: 10,
    qualityRating: 8,
    speedRating: 7,
    consistencyRating: 7,
    notes: "Milestone 2. Nhập giá thực tế trước khi bật.",
  },
  {
    provider: "kling",
    modelId: "kling-video",
    displayName: "Kling (chưa cấu hình)",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supports1080p: true,
    maxDuration: 10,
    qualityRating: 7,
    speedRating: 6,
    consistencyRating: 7,
    notes: "Milestone 3. Nhập giá thực tế trước khi bật.",
  },
  {
    provider: "elevenlabs",
    modelId: "eleven-voice",
    displayName: "ElevenLabs Voice (chưa cấu hình)",
    type: "voice",
    enabled: false,
    priceUnit: "per_1k_chars",
    price: 0,
    supportsAudio: true,
    qualityRating: 10,
    speedRating: 8,
    consistencyRating: 9,
    notes: "Milestone 2. Nhập giá thực tế trước khi bật.",
  },
];

export interface SeedProvider {
  name: string;
  displayName: string;
  types: string[];
  enabled: boolean;
  apiKeyEnvVar: string;
  priority: number;
  fallbackPriority: number;
  notes: string;
}

export const SEED_PROVIDERS: SeedProvider[] = [
  {
    name: "mock",
    displayName: "Mock (chế độ thử nghiệm)",
    types: ["text", "image", "video", "voice", "upscale", "quality"],
    enabled: true,
    apiKeyEnvVar: "",
    priority: 1,
    fallbackPriority: 1,
    notes: "Không tốn phí. Dùng cho toàn bộ Milestone 1.",
  },
  {
    name: "openai",
    displayName: "OpenAI",
    types: ["text"],
    enabled: false,
    apiKeyEnvVar: "OPENAI_API_KEY",
    priority: 10,
    fallbackPriority: 10,
    notes:
      "Text AI da tich hop (Milestone 2 buoc 1). Image/Voice chua tich hop.",
  },
  {
    name: "deepseek",
    displayName: "DeepSeek",
    types: ["text"],
    enabled: false,
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    priority: 12,
    fallbackPriority: 12,
    notes: "Tuong thich OpenAI API. Text AI da tich hop.",
  },
  {
    name: "groq",
    displayName: "Groq",
    types: ["text"],
    enabled: false,
    apiKeyEnvVar: "GROQ_API_KEY",
    priority: 14,
    fallbackPriority: 14,
    notes: "Tuong thich OpenAI API, toc do rat cao. Text AI da tich hop.",
  },
  {
    name: "ollama",
    displayName: "Ollama (chay cuc bo, mien phi)",
    types: ["text"],
    enabled: false,
    apiKeyEnvVar: "",
    priority: 16,
    fallbackPriority: 16,
    notes:
      "Chay model tren chinh may nay. Khong can API key, chi phi luon 0 USD. " +
      "Cai dat: https://ollama.com roi chay 'ollama pull llama3.1'.",
  },
  {
    name: "google",
    displayName: "Google AI / Veo",
    types: ["text", "image", "video"],
    enabled: false,
    apiKeyEnvVar: "GOOGLE_AI_API_KEY",
    priority: 20,
    fallbackPriority: 20,
    notes: "Chưa tích hợp (Milestone 3).",
  },
  {
    name: "runway",
    displayName: "Runway",
    types: ["video"],
    enabled: false,
    apiKeyEnvVar: "RUNWAY_API_KEY",
    priority: 30,
    fallbackPriority: 30,
    notes: "Chưa tích hợp (Milestone 2).",
  },
  {
    name: "kling",
    displayName: "Kling",
    types: ["video"],
    enabled: false,
    apiKeyEnvVar: "KLING_API_KEY",
    priority: 40,
    fallbackPriority: 40,
    notes: "Chưa tích hợp (Milestone 3).",
  },
  {
    name: "elevenlabs",
    displayName: "ElevenLabs",
    types: ["voice"],
    enabled: false,
    apiKeyEnvVar: "ELEVENLABS_API_KEY",
    priority: 50,
    fallbackPriority: 50,
    notes: "Chưa tích hợp (Milestone 2).",
  },
];
