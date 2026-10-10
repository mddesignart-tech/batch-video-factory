/**
 * PHYSICAL-INTERACTION AWARE ROUTING (QĐ-131 G11).
 *
 * Local multi-layer compositing stands each subject on the background as its
 * own cut-out. That reads well when the subjects do NOT touch: a presenter
 * beside (or pointing at) a product, two people talking, a bird flying past a
 * park, a product on a table. It cannot fake a hand around a bottle, a lid
 * coming off, water being poured, a handshake or a bird picking a twig up -
 * the layers look pasted on. Those scenes go to an asset that already shows
 * the interaction, or to a Video AI model that keeps the references - and
 * never to a paid model without approval, never at the cost of a CRITICAL
 * reference.
 *
 * Deterministic and local: words in the scene's description, nothing else.
 * Pure: no database, no provider.
 */

export type InteractionKind = "LOCAL_OK" | "COMPLEX_INTERACTION";

/** Vietnamese words are matched as whole words (letters on neither side). */
const vi = (body: string) => new RegExp(`(?<!\\p{L})(?:${body})(?!\\p{L})`, "iu");
const W = "(?:\\s+\\p{L}+){0,4}";

/** Hands / mouths / bodies in contact with an object or with each other. */
const COMPLEX_CUES: { cue: string; match: RegExp }[] = [
  // Hand - object.
  { cue: "cầm / hold", match: vi("cầm|nắm lấy|giơ lên|xách|bưng|cầm lấy") },
  { cue: "cầm / hold", match: /\b(holding|holds? (?:up )?(?:the|a|an|his|her|their|it)\b(?! (?:heat|temperature|warmth))|grabs?|grabbing|grips?|gripping|carr(?:y|ies|ying))\b/i },
  { cue: "mở / đóng nắp", match: vi(`(?:mở|vặn|tháo|đóng|đậy)(?:\\s+(?:nắp|hộp|bình|chai|lon|túi|gói|cửa|lọ|hũ))`) },
  { cue: "mở / đóng nắp", match: /\b(open(?:s|ing)?|clos(?:e|es|ing)|unscrew(?:s|ing)?|twist(?:s|ing)? (?:off|open))(?: up)? (?:the |a |its |his |her )?(?:lid|cap|box|bottle|jar|can|door|pot)\b/i },
  { cue: "rót / uống", match: vi("rót|đổ nước|(?<!đồ\\s)uống|nhấp một ngụm|húp") },
  { cue: "rót / uống", match: /\b(pour(?:s|ing)?|drink(?:s|ing)? (?:from|the|some|water|tea|coffee|it)|sips?|sipping)\b/i },
  { cue: "đưa / nhận", match: vi(`(?:đưa|trao|chuyền|tặng)${W}\\s+cho|nhận lấy`) },
  { cue: "đưa / nhận", match: /\b(hand(?:s|ing)? (?:\w+ ){0,3}(?:to|over)|pass(?:es|ing)? (?:\w+ ){0,3}to|gives? (?:\w+ ){0,3}to)\b/i },
  { cue: "nhặt / đặt", match: vi(`nhặt|lượm|nhấc|(?:đặt|để)${W}\\s+(?:xuống|lên)`) },
  { cue: "nhặt / đặt", match: /\b(pick(?:s|ing)? (?:\w+ ){0,3}up|lift(?:s|ing)?|put(?:s|ting)? (?:\w+ ){0,3}down|set(?:s|ting)? (?:\w+ ){0,3}down|places? (?:\w+ ){0,3}on)\b/i },
  // Person - person.
  { cue: "chạm nhau", match: vi("bắt tay|ôm|ôm nhau|ôm chầm|nắm tay|đánh nhau|đấm|đá nhau|vật nhau|chạm vào|chạm nhau|chạm tay|hôn|bế|cõng|kéo tay|đẩy nhau|vỗ vai") },
  { cue: "chạm nhau", match: /\b(shak(?:e|es|ing) hands|handshake|hug(?:s|ging)?|embrac(?:e|es|ing)|fight(?:s|ing)?|punch(?:es|ing)?|kiss(?:es|ing)?|touch(?:es|ing)? (?:the|each|his|her|their|it)|pats? (?:\w+ )?on the)\b/i },
  // Animal - object / person.
  { cue: "động vật chạm vật", match: vi("bằng mỏ|mổ|ngậm|tha mồi|tha cành|cắn|gặm|vồ|cào|liếm|dụi") },
  { cue: "động vật chạm vật", match: /\b(in (?:its|his|her) (?:beak|mouth|claws|paws)|peck(?:s|ing)?|bit(?:e|es|ing)|chew(?:s|ing)?|pounc(?:e|es|ing)|lick(?:s|ing)?)\b/i },
  // Who is in front of whom changes over time.
  { cue: "che khuất", match: vi("che khuất|che lấp|đi ngang qua trước|lướt qua trước|nấp sau|núp sau|chui qua") },
  { cue: "che khuất", match: /\b(walks? (?:in front of|behind)|passes? (?:in front of|behind)|hides? behind|occlud\w*)\b/i },
];

export interface InteractionVerdict {
  kind: InteractionKind;
  /** Which kinds of contact were found (for the log; never shown as a technique). */
  cues: string[];
}

/** Does this scene's action need subjects to touch / hand things over / occlude each other? */
export function classifyInteraction(text: string): InteractionVerdict {
  const cues = [...new Set(COMPLEX_CUES.filter((c) => c.match.test(text)).map((c) => c.cue))];
  return { kind: cues.length ? "COMPLEX_INTERACTION" : "LOCAL_OK", cues };
}

/** What a video model PROMISES about references (VideoModelProfile fields). Absent = not promised. */
export interface ReferenceCaps {
  referenceImage?: boolean;
  characterReference?: boolean;
  productReference?: boolean;
  /** The adapter sends reference pictures besides the keyframe. */
  directReference?: boolean;
  maxReferenceImages?: number;
}

/**
 * Can this model show the scene's CRITICAL references as they are? A product
 * needs a model that promises product reference, a character one that
 * promises character reference, and in both cases the pictures must actually
 * reach the model (direct reference). Never assumed.
 */
export function keepsCriticalReferences(caps: ReferenceCaps, critical: string[]): boolean {
  if (critical.length === 0) return true;
  if (caps.directReference !== true) return false;
  if (caps.maxReferenceImages !== undefined && caps.maxReferenceImages < critical.length) return false;
  return critical.every((type) =>
    type === "PRODUCT" ? caps.productReference === true : type === "CHARACTER" ? caps.characterReference === true : caps.referenceImage === true,
  );
}

export type InteractionRouteKind = "LOCAL_LAYERS" | "NATIVE_CLIP" | "SCENE_PICTURE" | "VIDEO_AI" | "ASK_USER";
export type InteractionChoice = "SIMPLER_SCENE" | "KEEP_SEPARATE" | "VIDEO_AI" | "DROP_INTERACTION";

export const VI_INTERACTION_CHOICE: Record<InteractionChoice, string> = {
  SIMPLER_SCENE: "Dùng cảnh đơn giản hơn",
  KEEP_SEPARATE: "Giữ các chủ thể tách rời bằng Local Motion",
  VIDEO_AI: "Chọn Video AI",
  DROP_INTERACTION: "Bỏ tương tác",
};

export const INTERACTION_NOTICE = "Cảnh này có tương tác vật lý giữa các chủ thể. Local Motion có thể trông như các lớp ảnh tách rời.";
export const INTERACTION_HINT = "Video AI phù hợp hơn cho cảnh cầm, mở, rót, uống hoặc tương tác tay–sản phẩm.";

export interface InteractionRouteInput {
  /** The scene's visual description + character action. */
  text: string;
  /** The person chose "Bỏ tương tác" for this scene. */
  dropped?: boolean;
  /** The scene already has its own clip (it shows the interaction as filmed / generated). */
  nativeClip?: boolean;
  /** The scene already has one picture of the whole scene (the interaction pre-composed in it). */
  scenePicture?: boolean;
  /** Types of the scene's CRITICAL references ("PRODUCT", "CHARACTER"...). */
  critical: string[];
  /** The Video AI models this scene may use (the pinned one, or every enabled one). */
  models: ReferenceCaps[];
  /** Paid Video AI for this scene was approved by a person. */
  paidApproved: boolean;
}

export interface InteractionRoute {
  interaction: InteractionKind;
  route: InteractionRouteKind;
  /** May the router send this scene to a paid model on its own? Only after approval, only when references hold. */
  autoPaid: boolean;
  reason: string;
  /** Shown in the Scene Editor when the scene has a physical interaction. */
  notice: string | null;
  hint: string | null;
  choices: { id: InteractionChoice; label: string; available: boolean; note?: string }[];
}

/**
 * Where a scene's movement should come from, given its interaction. LOCAL_OK
 * keeps the local layers. A COMPLEX_INTERACTION is never faked with separate
 * layers by default; in order:
 *   1. the scene's own clip;
 *   2. the scene's own picture (one pre-composed image);
 *   3. Video AI - only when already approved AND a model keeps every CRITICAL reference;
 *   4. otherwise the person chooses. Nothing here calls a provider.
 */
export function routeInteraction(input: InteractionRouteInput): InteractionRoute {
  const verdict = input.dropped ? { kind: "LOCAL_OK" as const, cues: [] } : classifyInteraction(input.text);
  const fitting = input.models.some((m) => keepsCriticalReferences(m, input.critical));
  const videoNote = !fitting
    ? input.critical.length
      ? "Chưa có model Video AI giữ đúng tham chiếu quan trọng của cảnh."
      : "Chưa có model Video AI phù hợp."
    : input.paidApproved
      ? undefined
      : "Cần bạn duyệt chi phí trước khi tạo.";
  const choices: InteractionRoute["choices"] = (Object.keys(VI_INTERACTION_CHOICE) as InteractionChoice[]).map((id) => ({
    id,
    label: VI_INTERACTION_CHOICE[id],
    available: id === "VIDEO_AI" ? fitting : true,
    ...(id === "VIDEO_AI" && videoNote ? { note: videoNote } : {}),
  }));

  if (verdict.kind === "LOCAL_OK") {
    return { interaction: "LOCAL_OK", route: "LOCAL_LAYERS", autoPaid: false, reason: "Các chủ thể không chạm nhau: ghép lớp tại máy phù hợp.", notice: null, hint: null, choices: [] };
  }
  const base = { interaction: "COMPLEX_INTERACTION" as const, notice: INTERACTION_NOTICE, hint: INTERACTION_HINT, choices };
  if (input.nativeClip) {
    return { ...base, route: "NATIVE_CLIP", autoPaid: false, reason: "Cảnh đã có clip riêng thể hiện tương tác: dùng clip đó." };
  }
  if (input.scenePicture) {
    return { ...base, route: "SCENE_PICTURE", autoPaid: false, reason: "Cảnh đã có ảnh nguyên cảnh thể hiện tương tác: dùng ảnh đó thay vì ghép lớp." };
  }
  if (input.paidApproved && fitting) {
    return { ...base, route: "VIDEO_AI", autoPaid: true, reason: "Video AI đã được duyệt và có model giữ đúng tham chiếu." };
  }
  return {
    ...base,
    route: "ASK_USER",
    autoPaid: false,
    reason:
      input.critical.length && !fitting
        ? "Không model Video AI nào giữ đúng tham chiếu quan trọng: không tự chuyển, không hy sinh tham chiếu."
        : "Video AI chưa được duyệt: không tự gọi, chờ bạn chọn.",
  };
}
