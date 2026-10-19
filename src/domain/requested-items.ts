/**
 * REQUESTED ITEMS - "3 mẹo", "5 bước", "Top 7", "6 sai lầm", "5 steps".
 *
 * When the person's own request names a count of things, the video owes them
 * that many things. The planner used to derive the number of item scenes from
 * the running time alone, so "3 mẹo" in 12 s became hook + ONE tip + recap,
 * and the recap merely named the other two. This reads the count from the
 * request, and checks a written script actually covers every item.
 *
 * Generic: a number (digits or a VI/EN number word) followed by a list noun, or
 * "Top N". Units of time, age or money are never a list ("30 giây", "5 năm").
 *
 * Pure: no database, no provider.
 */

export const MIN_REQUESTED_ITEMS = 2;
export const MAX_REQUESTED_ITEMS = 20;

export interface RequestedItems {
  count: number;
  /** The noun as the person wrote it ("mẹo", "steps"), or "" for "Top N". */
  noun: string;
}

const NUMBER_WORDS: Record<string, number> = {
  hai: 2, ba: 3, bốn: 4, năm: 5, sáu: 6, bảy: 7, tám: 8, chín: 9, mười: 10,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

/** Nouns that name the members of a list. Longest first so "lợi ích" beats "lợi". */
const LIST_NOUNS = [
  // Vietnamese
  "bí quyết", "lợi ích", "sai lầm", "lý do", "lí do", "thói quen", "ý tưởng", "công cụ", "tính năng", "ứng dụng",
  "sự thật", "dấu hiệu", "nguyên tắc", "quy tắc", "câu hỏi", "kỹ năng", "kĩ năng", "gợi ý", "chiến lược", "ví dụ",
  "lưu ý", "điều cần biết", "cách", "mẹo", "bước", "điều", "điểm", "món", "loại", "mục", "lỗi", "thủ thuật",
  // English
  "tips", "tip", "steps", "step", "benefits", "benefit", "mistakes", "mistake", "ways", "way", "reasons", "reason",
  "things", "thing", "tricks", "trick", "habits", "habit", "ideas", "idea", "tools", "tool", "features", "feature",
  "apps", "facts", "fact", "signs", "rules", "rule", "questions", "secrets", "hacks", "hack", "strategies",
  "examples", "lessons", "lesson", "items", "errors", "myths", "points",
].sort((a, b) => b.length - a.length);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOUN = `(${LIST_NOUNS.map(escape).join("|")})`;
// Letters incl. Vietnamese diacritics: a noun must end at a word boundary.
const AFTER = "(?![\\p{L}\\p{N}])";
const BEFORE = "(?<![\\p{L}\\p{N}])";
/** "5 năm làm việc", "30 giây", "10 tuổi": a measure, never a list. */
const UNITS = [
  "giây", "phút", "giờ", "ngày", "tuần", "tháng", "năm", "tuổi", "lần", "người", "nghìn", "triệu", "tỷ", "đồng",
  "seconds", "second", "minutes", "minute", "hours", "hour", "days", "day", "weeks", "week", "months", "month",
  "years", "year", "times", "people", "percent",
];
const UNIT = `(?:${UNITS.join("|")})${AFTER}`;
/** "3 mẹo", "5 simple steps", "7 điều nhỏ" - a digit may have up to two words between. */
const DIGIT_NOUN = new RegExp(`${BEFORE}(\\d{1,2})\\s+(?!${UNIT})(?:[\\p{L}-]+\\s+){0,2}?${NOUN}${AFTER}`, "iu");
/**
 * "ba mẹo", "five steps" - a number WORD only directly before its noun: "ba"
 * is also "dad" and "năm" also "year", so "ba mẹ có cách…" is not three ways.
 */
const WORD_NOUN = new RegExp(`${BEFORE}(${Object.keys(NUMBER_WORDS).join("|")})\\s+${NOUN}${AFTER}`, "iu");
/** "Top 7", "top-10". */
const TOP_N = new RegExp(`${BEFORE}top[\\s-]*(\\d{1,2})${AFTER}`, "iu");

function toNumber(token: string): number {
  const n = Number(token);
  return Number.isFinite(n) ? n : (NUMBER_WORDS[token.toLowerCase()] ?? NaN);
}

/** The count the request asks for, or null when it names none. */
export function requestedItemsOf(text: string | null | undefined): RequestedItems | null {
  const source = (text ?? "").normalize("NFC");
  if (!source.trim()) return null;
  const candidates: { at: number; items: RequestedItems }[] = [];
  const top = TOP_N.exec(source);
  if (top) candidates.push({ at: top.index, items: { count: toNumber(top[1]!), noun: "" } });
  for (const pattern of [DIGIT_NOUN, WORD_NOUN]) {
    const counted = pattern.exec(source);
    if (counted) candidates.push({ at: counted.index, items: { count: toNumber(counted[1]!), noun: counted[2]!.toLowerCase() } });
  }
  const first = candidates
    .filter((c) => Number.isInteger(c.items.count) && c.items.count >= MIN_REQUESTED_ITEMS && c.items.count <= MAX_REQUESTED_ITEMS)
    .sort((a, b) => a.at - b.at)[0];
  return first?.items ?? null;
}

// ------------------------------------------------------------- coverage ---

/** Beats that open or close a video: they may name the items, never carry one. */
export const FRAME_ROLES = new Set(["hook", "recap", "cta", "contact", "ending", "conclusion", "verdict", "for-who"]);
/** Creative beats (QĐ-127) add style, not content. */
export const CREATIVE_ROLES = new Set(["reaction", "escalation", "gag", "payoff", "moment", "climax", "punchline"]);

/** The fewest words a scene needs to say something about its item. */
export const MIN_ITEM_WORDS = 4;

export interface CoverageScene {
  sceneNumber: number;
  /** The beat the scene was written for; absent for a scene the person added. */
  sceneRole?: string | null;
  narration?: string | null;
  dialogue?: string | null;
  subtitle?: string | null;
}

export interface ItemCoverage {
  requested: number;
  /** Item scenes that carry real content. */
  covered: number;
  /** Item numbers (1-based) with no scene at all. */
  missing: number[];
  /** Scenes whose item is only a name, not a point. */
  thin: number[];
  ok: boolean;
}

function spoken(s: CoverageScene): string {
  const text = [s.narration, s.dialogue].filter(Boolean).join(" ").trim();
  return text || (s.subtitle ?? "").trim();
}

const words = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * Does the script carry every requested item in a scene of its own?
 *
 * `itemRole` is the beat the planner repeated for the items (tip, step, item…).
 * Without one, any scene that is neither the opening/closing frame nor a
 * creative beat counts. A scene the person added by hand (no role) counts as an
 * item scene, so editing the storyboard is a real way to fix a gap.
 */
export function checkItemCoverage(scenes: CoverageScene[], requested: number, itemRole: string | null): ItemCoverage {
  const itemScenes = scenes
    .filter((s) => {
      const role = (s.sceneRole ?? "").toLowerCase();
      if (!role) return true;
      if (itemRole) return role === itemRole;
      return !FRAME_ROLES.has(role) && !CREATIVE_ROLES.has(role);
    })
    .sort((a, b) => a.sceneNumber - b.sceneNumber);
  const seen = new Set<string>();
  const thin: number[] = [];
  let covered = 0;
  for (const s of itemScenes) {
    const text = spoken(s);
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (words(text) < MIN_ITEM_WORDS || seen.has(key)) {
      thin.push(s.sceneNumber);
      continue;
    }
    seen.add(key);
    covered++;
  }
  const missing = Array.from({ length: Math.max(0, requested - covered) }, (_, i) => covered + i + 1);
  return { requested, covered, missing, thin, ok: covered >= requested };
}

/** Plain Vietnamese for the person: which items are missing. */
export function itemCoverageMessage(c: ItemCoverage, items: RequestedItems): string {
  const noun = items.noun || "mục";
  const parts = [`Yêu cầu có ${c.requested} ${noun} nhưng kịch bản chỉ triển khai rõ ${c.covered}.`];
  if (c.missing.length) parts.push(`Còn thiếu ${noun} số ${c.missing.join(", ")}.`);
  if (c.thin.length) parts.push(`Cảnh ${c.thin.join(", ")} chỉ nhắc tên / trùng lời, chưa có nội dung.`);
  parts.push("Hãy VIẾT LẠI KỊCH BẢN hoặc thêm / sửa cảnh trong Storyboard trước khi DUYỆT KỊCH BẢN.");
  return parts.join(" ");
}

/** The writer's instruction for a counted request. */
export function itemCountRule(items: RequestedItems, itemLabel: string | null): string {
  const noun = items.noun || "items";
  const where = itemLabel ? `the ${items.count} scenes labelled "${itemLabel} 1".."${itemLabel} ${items.count}"` : `${items.count} separate body scenes`;
  return [
    `REQUESTED COUNT: the request asks for exactly ${items.count} ${noun}.`,
    `- Cover all ${items.count}, one per scene, in ${where}, in order.`,
    "- Each one gets real content: what it is AND why or how (a concrete point), never just its name.",
    "- The hook and the recap may name them, but never replace them; do not merge two into one scene.",
  ].join("\n");
}
