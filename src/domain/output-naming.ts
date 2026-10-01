/**
 * Names a person sees on disk and on screen (V1.2 Phase 6, QĐ-114).
 *
 * Pure: no database, no filesystem. The services decide which names are
 * already taken and pass them in, so every rule here can be checked on its own.
 *
 *   batch folder   data/output/<batch-slug>/
 *   video folder   data/output/<batch-slug>/<video-slug>/
 *
 * A slug is ASCII, lower-case, hyphen-separated and safe on Windows: no
 * reserved device name (CON, NUL, COM1 ...), no trailing dot or space, no
 * character Explorer refuses. Vietnamese is transliterated ("Cà phê đá" ->
 * "ca-phe-da"), emoji and symbols are dropped, and a title that leaves nothing
 * behind becomes "video". Internal ids never appear in a new-layout name.
 */

/** Unicode combining marks, stripped after NFD so "cà phê" -> "ca-phe". */
const DIACRITICS = /[̀-ͯ]/g;
const DSTROKE = /[đĐ]/g;

/** Windows device names: a folder called "con" cannot be created. */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Longest slug. data/output/<60>/<60>/subtitles.srt stays far under Windows'
 * 260-character MAX_PATH even from a deep project folder.
 */
export const MAX_SLUG_LENGTH = 60;

export function safeSlug(input: string, fallback = "video", maxLength = MAX_SLUG_LENGTH): string {
  let slug = input
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .replace(DSTROKE, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > maxLength) {
    // Cut at a word boundary when one is close, so "a-very-long-tit" does not
    // read like a typo.
    const cut = slug.slice(0, maxLength);
    const lastDash = cut.lastIndexOf("-");
    slug = (lastDash >= maxLength * 0.6 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
  }
  if (slug.length === 0) slug = fallback;
  if (WINDOWS_RESERVED.has(slug)) slug = `${slug}-${fallback}`;
  return slug;
}

/**
 * A slug not in `taken`: "title", then "title-2", "title-3" ... The suffix is
 * short and the base is trimmed so the result never exceeds the length limit.
 */
export function uniqueSlug(base: string, taken: Iterable<string>, maxLength = MAX_SLUG_LENGTH): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, maxLength - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`Không tìm được tên thư mục trống cho "${base}".`);
}

/** YYYY-MM-DD in local time - what a person means by "today". */
export function localDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * A batch name a person would have typed: the shared theme of the titles (or
 * the single title) and the date. Never a UUID.
 *
 *   ["5 AI tools", "AI tools for students"]  -> "AI Tools - 2026-09-28"
 *   ["Break the ice"]                       -> "Break the ice - 2026-09-28"
 *   ["Cold feet", "Piece of cake", ...]     -> "Cold feet + 2 video - 2026-09-28"
 */
export function suggestBatchName(titles: string[], now = new Date(), theme?: string | null): string {
  const date = localDate(now);
  const clean = titles.map((t) => t.trim()).filter((t) => t.length > 0);
  if (theme && theme.trim().length > 0) return `${theme.trim()} - ${date}`;
  if (clean.length === 0) return `Lô video - ${date}`;
  if (clean.length === 1) return `${clean[0]!.slice(0, 60)} - ${date}`;
  const common = commonTheme(clean);
  if (common) return `${common} - ${date}`;
  return `${clean[0]!.slice(0, 40)} + ${clean.length - 1} video - ${date}`;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "of", "for", "and", "to", "in", "on", "with", "is", "are", "your", "you",
  "va", "cua", "cho", "voi", "la", "mot", "nhung", "cac", "trong", "de",
]);

/** The longest run of meaningful words every title shares, title-cased; null if none. */
function commonTheme(titles: string[]): string | null {
  const words = (t: string) =>
    t
      .normalize("NFD")
      .replace(DIACRITICS, "")
      .replace(DSTROKE, "d")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0 && !/^\d+$/.test(w));
  const lists = titles.map(words);
  const first = lists[0] ?? [];
  let best: string[] = [];
  for (let i = 0; i < first.length; i += 1) {
    for (let j = i + 1; j <= first.length; j += 1) {
      const run = first.slice(i, j);
      if (run.length <= best.length) continue;
      if (run.every((w) => STOP_WORDS.has(w))) continue;
      const needle = ` ${run.join(" ")} `;
      if (lists.every((l) => ` ${l.join(" ")} `.includes(needle))) best = run;
    }
  }
  const meaningful = best.filter((w) => !STOP_WORDS.has(w));
  if (meaningful.length === 0) return null;
  return best.map((w) => (w.length <= 2 && w !== "ai" ? w : w === "ai" ? "AI" : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}
