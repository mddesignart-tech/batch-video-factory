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
  // The attributes an image model drifts on. Stored as separate fields rather
  // than one paragraph so each becomes its own labelled clause in the prompt,
  // which leaves far less room for reinterpretation.
  hair: string;
  facialFeatures: string;
  outfit: string;
  bodyProportions: string;
  accessories: string;
  colorPalette: string;
  // ---- voice: editable per character in the UI, never hard-coded in code ----
  voiceProvider: string;
  voiceModel: string;
  voiceId: string;
  /// Delivery direction. This is what makes a TTS voice act rather than read,
  /// and the comedy in these videos lives entirely in the delivery.
  voiceInstructions: string;
  voiceSpeed: number;
  voiceGender: "male" | "female";
  voiceAccent: "US" | "UK";
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
    hair: "short messy dark brown hair, slightly spiky at the front",
    facialFeatures:
      "round face, large round expressive eyes, small nose, wide eager smile, light warm skin",
    outfit:
      "bright yellow hoodie with a single white chest stripe, blue jeans, white sneakers",
    bodyProportions:
      "slightly oversized head, short and stocky, noticeably shorter than Leo",
    accessories: "",
    colorPalette: "bright yellow, denim blue, white",
    voiceProvider: "openai",
    voiceModel: "gpt-4o-mini-tts",
    // Echo is the clearest of the male voices, which matters more than timbre
    // for an audience learning the language.
    voiceId: "echo",
    voiceInstructions:
      "Speak like an energetic, slightly confused young man. " +
      "Sound surprised, playful and comedic. " +
      "Keep the delivery natural, expressive and very clear for English learners.",
    voiceSpeed: 1,
    voiceGender: "male",
    voiceAccent: "US",
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
    hair: "neat short black hair with a clean side part",
    facialFeatures:
      "oval face, calm narrow eyes behind round glasses, medium brown skin, small knowing smile",
    outfit:
      "teal button-up shirt with rolled sleeves, dark grey trousers, brown leather shoes",
    bodyProportions: "slim, upright posture, clearly taller than Max",
    accessories: "round thin-rimmed glasses",
    colorPalette: "teal, dark grey, brown",
    voiceProvider: "openai",
    voiceModel: "gpt-4o-mini-tts",
    // Ballad is steadier and lower than Echo, so Leo cannot be mistaken for Max
    // on audio alone - the two of them share most scenes.
    voiceId: "ballad",
    // Brisker than the first pass. The original delivery was clear but read
    // slow and instructional, which is the wrong register for a Short: Leo is
    // a friend making a point, not a narrator reading a lesson.
    voiceInstructions:
      "Speak calmly and clearly with a mildly amused tone. " +
      "Keep the delivery conversational and slightly brisk, " +
      "as if explaining something obvious to a funny friend. " +
      "Clear enough for English learners, but do not sound slow or instructional.",
    voiceSpeed: 1,
    voiceGender: "male",
    voiceAccent: "US",
    seed: 220033,
    notes: "Luôn đeo kính tròn và mặc áo sơ mi xanh teal.",
  },
  {
    name: "Mia",
    description:
      "Nhân vật phụ. Người ngoài cuộc chứng kiến tình huống và phản ứng, thường không có thoại.",
    personality:
      "Observant, easily amused, reacts with her whole face. Usually watches rather than speaks.",
    visualPrompt:
      "Mia: young adult female cartoon character, shoulder-length curly auburn hair, " +
      "large green eyes, fair skin with freckles, coral red t-shirt under a denim jacket, " +
      "dark green skirt, yellow trainers, small and lively, expressive eyebrows",
    negativePrompt:
      "realistic human photo, extra fingers, deformed hands, straight hair, changing hair colour, " +
      "scary features, text artifacts, watermark, blurry face",
    hair: "shoulder-length curly auburn hair",
    facialFeatures:
      "heart-shaped face, large green eyes, freckles across the nose, quick amused smile",
    outfit: "coral red t-shirt, open denim jacket, dark green skirt, yellow trainers",
    bodyProportions: "petite, shortest of the three, light build",
    accessories: "",
    colorPalette: "coral red, denim blue, dark green, auburn",
    voiceProvider: "openai",
    voiceModel: "gpt-4o-mini-tts",
    voiceId: "coral",
    // "Dry humour" rather than "sarcastic": the first wording pushed the model
    // towards a theatrical read, and the joke lands better underplayed.
    voiceInstructions:
      "Speak with a bright, playful tone with a hint of dry humor. " +
      "Friendly, natural and expressive. " +
      "Avoid sounding theatrical or overly sarcastic. " +
      "Keep the English clear and conversational.",
    voiceSpeed: 1,
    voiceGender: "female",
    voiceAccent: "US",
    seed: 330044,
    notes:
      "Thường chỉ đứng phản ứng, không có thoại - đúng trường hợp mà danh sách nhân vật cũ hay bỏ sót.",
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
  /** Image models only: accepts the input_fidelity hint on /images/edits. */
  supportsInputFidelity?: boolean;
  /** ISO date a human last checked price and availability against the vendor. */
  lastVerifiedAt?: string;
  supportsAudio?: boolean;
  /** Voice models that take a free-text delivery direction. */
  supportsVoiceInstructions?: boolean;
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
    displayName: "OpenAI GPT-4o mini",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0.00015,
    priceOutput: 0.0006,
    qualityRating: 8,
    speedRating: 9,
    consistencyRating: 8,
    notes:
      "Re, du tot cho kich ban ngan. DOI CHIEU LAI gia tai openai.com/api/pricing truoc khi bat.",
  },
  {
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "OpenAI GPT-4o",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0.0025,
    priceOutput: 0.01,
    qualityRating: 9,
    speedRating: 7,
    consistencyRating: 9,
    notes: "Chat luong cao hon, dat hon. DOI CHIEU LAI gia truoc khi bat.",
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
    modelId: "openai/gpt-oss-120b",
    displayName: "Groq gpt-oss-120b (nhap gia truoc khi bat)",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0,
    priceOutput: 0,
    qualityRating: 8,
    speedRating: 9,
    consistencyRating: 8,
    notes:
      "Tuong thich OpenAI API, context 131k. Ten model do API /v1/models cua Groq tra ve - " +
      "Groq doi ten model kha thuong xuyen, hay doi chieu lai neu gap loi 404.",
  },
  {
    provider: "groq",
    modelId: "openai/gpt-oss-20b",
    displayName: "Groq gpt-oss-20b (nhanh hon, re hon)",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0,
    priceOutput: 0,
    qualityRating: 7,
    speedRating: 10,
    consistencyRating: 7,
    notes: "Nho hon, nhanh hon. Du de kiem chung tich hop.",
  },
  {
    provider: "groq",
    modelId: "qwen/qwen3.8-27b",
    displayName: "Groq Qwen3.8 27B",
    type: "text",
    enabled: false,
    priceUnit: "per_1k_tokens",
    price: 0,
    priceOutput: 0,
    qualityRating: 7,
    speedRating: 9,
    consistencyRating: 7,
    notes: "Lua chon thay the. Nhap gia thuc te truoc khi bat.",
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
  // The Images API bills output tokens, and a different number of them per
  // quality tier, so one API model becomes several registry rows: `price` is
  // the per-image estimate the spend cap is checked against before the call,
  // and `priceOutput` ($ per 1M output tokens) turns the reply's own token
  // count into the exact cost afterwards. The ":low" style suffix is stripped
  // before the request; see splitModelTier.
  //
  // Prices verified against developers.openai.com/api/docs/pricing on
  // 2026-09-13. Re-check them there before enabling - they are the operator's
  // data to maintain, not constants in code.
  {
    provider: "openai",
    modelId: "gpt-image-2:low",
    displayName: "GPT Image 2 — tiết kiệm",
    type: "image",
    enabled: false,
    priceUnit: "per_image",
    price: 0.013,
    priceOutput: 30,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supports1080p: true,
    qualityRating: 7,
    speedRating: 9,
    consistencyRating: 8,
    notes: "Tang re nhat cua model moi nhat. Uoc tinh ~$0.013/anh 1024x1536.",
  },
  {
    provider: "openai",
    modelId: "gpt-image-2:medium",
    displayName: "GPT Image 2 — cân bằng",
    type: "image",
    enabled: false,
    priceUnit: "per_image",
    price: 0.048,
    priceOutput: 30,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supports1080p: true,
    qualityRating: 9,
    speedRating: 7,
    consistencyRating: 9,
    notes:
      "Mac dinh cho che do BALANCED. Moi hon va re hon gpt-image-1 ($30 so voi $40 moi 1M token ra).",
  },
  {
    provider: "openai",
    modelId: "gpt-image-2:high",
    displayName: "GPT Image 2 — chất lượng cao",
    type: "image",
    enabled: false,
    priceUnit: "per_image",
    price: 0.187,
    priceOutput: 30,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supports1080p: true,
    qualityRating: 10,
    speedRating: 5,
    consistencyRating: 10,
    notes: "Dat gap ~4 lan muc medium. Chi dung khi that su can.",
  },
  {
    provider: "openai",
    modelId: "gpt-image-1-mini:medium",
    displayName: "GPT Image 1 mini — rẻ nhất",
    type: "image",
    enabled: false,
    priceUnit: "per_image",
    price: 0.013,
    priceOutput: 8,
    supportsReferenceImage: true,
    supports1080p: true,
    qualityRating: 5,
    speedRating: 10,
    consistencyRating: 6,
    notes: "Re nhat ($8 moi 1M token ra). Dung de thu nghiem, chat luong thap hon.",
  },
  {
    provider: "openai",
    modelId: "gpt-image-1:medium",
    displayName: "GPT Image 1 — cân bằng (đời cũ)",
    type: "image",
    enabled: false,
    priceUnit: "per_image",
    price: 0.063,
    priceOutput: 40,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supports1080p: true,
    qualityRating: 8,
    speedRating: 7,
    consistencyRating: 9,
    supportsInputFidelity: true,
    notes:
      "Doi truoc, dat hon gpt-image-2. Bu lai: chap nhan input_fidelity=high nen giu khuon mat nhan vat chac hon.",
  },
  // Sora, priced per second AND per resolution, so each resolution is its own
  // registry row - the ":720x1280" suffix is stripped before the API call.
  // Prices verified against developers.openai.com/api/docs/pricing 2026-09-13.
  //
  // maxDuration is NOT verified: the docs did not state the allowed values
  // clearly, so the API is left as the authority. A rejected duration is a
  // free 400, not a wasted generation.
  {
    provider: "openai",
    modelId: "sora-2:720x1280",
    displayName: "Sora 2 — dọc 720x1280",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0.1,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    maxDuration: 12,
    qualityRating: 8,
    speedRating: 7,
    consistencyRating: 8,
    lastVerifiedAt: "2026-09-13",
    notes:
      "Khung doc 9:16 dung chuan. Anh keyframe PHAI dung 720x1280 - he thong tu cat truoc khi gui.",
  },
  {
    provider: "openai",
    modelId: "sora-2-pro:720x1280",
    displayName: "Sora 2 Pro — dọc 720x1280",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0.3,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    maxDuration: 12,
    qualityRating: 9,
    speedRating: 5,
    consistencyRating: 9,
    lastVerifiedAt: "2026-09-13",
    notes: "Dat gap 3 lan sora-2 o cung do phan giai.",
  },
  {
    provider: "openai",
    modelId: "sora-2-pro:1080x1920",
    displayName: "Sora 2 Pro — dọc 1080x1920",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0.7,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supports1080p: true,
    maxDuration: 12,
    qualityRating: 10,
    speedRating: 4,
    consistencyRating: 9,
    lastVerifiedAt: "2026-09-13",
    notes:
      "Dung do phan giai cuoi cua video, khong phai cat lai. Dat nhat: $0.70/giay.",
  },
  // ---- Google Veo 3.1, via the Gemini API ----
  // Prices verified against ai.google.dev/gemini-api/docs/pricing 2026-09-13.
  //
  // UNVERIFIED and important: the docs say 1080p AND reference-image runs are
  // forced to 8 seconds. If a single first-frame image counts as a reference
  // image, every keyframe clip costs double the per-second figure below. The
  // adapter assumes it does and estimates 8s, which errs toward over-quoting.
  {
    provider: "google",
    modelId: "veo-3.1-lite-generate-preview:720x1280",
    displayName: "Veo 3.1 Lite — dọc 720p",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0.05,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    maxDuration: 8,
    qualityRating: 7,
    speedRating: 8,
    consistencyRating: 7,
    lastVerifiedAt: "2026-09-13",
    notes:
      "Re nhat trong cac model video that. 9:16 goc. Co the bi ep 8 giay khi dung anh keyframe.",
  },
  {
    provider: "google",
    modelId: "veo-3.1-fast-generate-preview:720x1280",
    displayName: "Veo 3.1 Fast — dọc 720p",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0.1,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    maxDuration: 8,
    qualityRating: 8,
    speedRating: 8,
    consistencyRating: 8,
    lastVerifiedAt: "2026-09-13",
    notes: "Cung gia moi giay voi Sora-2 nhung co the bi ep 8 giay.",
  },
  {
    provider: "google",
    modelId: "veo-3.1-generate-preview:1080x1920",
    displayName: "Veo 3.1 Standard — dọc 1080p",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0.4,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supports1080p: true,
    maxDuration: 8,
    qualityRating: 10,
    speedRating: 5,
    consistencyRating: 9,
    lastVerifiedAt: "2026-09-13",
    notes:
      "1080p goc, khong phai phong to. Bat buoc 8 giay nen mot canh ton $3.20.",
  },

  // ---- Runway, gen4_turbo ----
  // 5 credits/second at $0.01/credit = $0.05/second, verified against
  // docs.dev.runwayml.com/guides/pricing 2026-09-13.
  //
  // UNVERIFIED: Runway sells 5- and 10-second clips. A 4-second scene is
  // therefore billed as 5, which the adapter reflects in its estimate.
  {
    provider: "runway",
    modelId: "gen4_turbo:720x1280",
    displayName: "Runway Gen-4 Turbo — dọc 720x1280",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0.05,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    maxDuration: 10,
    qualityRating: 8,
    speedRating: 9,
    consistencyRating: 8,
    lastVerifiedAt: "2026-09-13",
    notes:
      "Chi co image-to-video, bat buoc phai co keyframe. Thoi luong chi 5s hoac 10s.",
  },
  // ---- OpenAI, gpt-4o-mini-tts ----
  // $0.60 per 1M input characters = $0.0006 per 1k characters, from OpenAI's
  // pricing page 2026-09-14. Cheap enough that a whole video's speech costs
  // less than one second of Sora, which is why voice is the safe thing to
  // finish while video is still being argued with.
  //
  // Chosen over tts-1 for `instructions`: the older models read a line, this
  // one acts it, and the comedy here is entirely in the delivery.
  {
    provider: "openai",
    modelId: "gpt-4o-mini-tts",
    displayName: "OpenAI GPT-4o mini TTS",
    type: "voice",
    enabled: false,
    priceUnit: "per_1k_chars",
    price: 0.0006,
    supportsAudio: true,
    supportsVoiceInstructions: true,
    qualityRating: 8,
    speedRating: 9,
    consistencyRating: 9,
    lastVerifiedAt: "2026-09-14",
    notes:
      "Nhan instructions de dieu khien cach dien. 10 giong co san. Tra ve wav/mp3/opus/aac/flac.",
  },
  // ---- Runway, gen4.5 ----
  // 12 credits/second at $0.01/credit = $0.12/second, from Runway's pricing
  // page 2026-09-14. Nearly 2.5x gen4_turbo, which is the whole question this
  // model exists to answer: gen4_turbo is cheap and refuses busy scenes, so a
  // dearer model is only worth it if it actually handles them.
  //
  // Unlike gen4_turbo this one bills BY THE SECOND across 2-10 seconds - no
  // 5-second minimum - so a 6-second scene costs 6 seconds, not 10.
  {
    provider: "runway",
    modelId: "gen4.5:720x1280",
    displayName: "Runway Gen-4.5 — dọc 720x1280",
    type: "video",
    enabled: false,
    priceUnit: "per_second",
    price: 0.12,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    maxDuration: 10,
    // Ratings are PLACEHOLDERS until a real clip is scored. gen4_turbo earned
    // its 8s from measured output; this model has none yet, so it is seeded at
    // the same numbers rather than flattered with better ones.
    qualityRating: 8,
    speedRating: 7,
    consistencyRating: 8,
    lastVerifiedAt: "2026-09-14",
    notes:
      "Image-to-video. Tinh tien theo giay, 2-10s, KHONG co muc toi thieu 5s nhu gen4_turbo.",
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
