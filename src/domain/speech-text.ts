/**
 * NATURAL SPEECH PREPROCESSING (QĐ-142) - the words a TTS voice is handed, made
 * easy to say. The subtitle and the stored script keep the original wording;
 * only the text SENT to the voice model changes, and it is part of the voice
 * reuse key, so a change here never silently reuses audio made from other words.
 *
 * Rules, in order of how much they help:
 *  - symbols a voice reads badly or aloud (emoji, markdown, hashtags, "&", "%")
 *    become words or disappear;
 *  - a unit or abbreviation right after a number is spelled out ("5 km");
 *  - punctuation is tidied so the pauses fall where a person would pause:
 *    one ellipsis at most per sentence, no "!!!", a space after every mark;
 *  - a dash between clauses becomes a comma (a short pause, not a word).
 *
 * Never: change a number, reorder words, add an ellipsis, or rewrite a product
 * or model name ("iPhone 15 Pro", "RTX 4090" stay as written - the voice is
 * told to say them the English way). Pure: no database, no provider.
 */

/** Bump when a rule changes: it is part of every Voice Director request. */
export const SPEECH_TEXT_VERSION = "speech-v1";

export type SpeechLanguage = "vi" | "en";

const VI_DIACRITICS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

/**
 * The language the TTS line is actually in. "vi-en" and "auto" decide by the
 * line itself: Vietnamese diacritics mean Vietnamese.
 */
export function speechLanguageOf(projectLanguage: string | null | undefined, text: string): SpeechLanguage {
  if (projectLanguage === "vi") return "vi";
  if (projectLanguage === "en") return "en";
  return VI_DIACRITICS.test(text) ? "vi" : "en";
}

const UNITS: Record<SpeechLanguage, Record<string, string>> = {
  vi: {
    km: "ki-lô-mét",
    kg: "ki-lô-gam",
    cm: "xăng-ti-mét",
    mm: "mi-li-mét",
    "km/h": "ki-lô-mét một giờ",
    "°C": "độ C",
    "%": "phần trăm",
    $: "đô la",
  },
  en: {
    km: "kilometers",
    kg: "kilograms",
    cm: "centimeters",
    mm: "millimeters",
    "km/h": "kilometers per hour",
    "°C": "degrees Celsius",
    "%": "percent",
    $: "dollars",
  },
};

const ABBREVIATIONS: Record<SpeechLanguage, [RegExp, string][]> = {
  vi: [
    [/\bv\.v\.?/gi, "vân vân"],
    [/\bVD\s*:/g, "Ví dụ:"],
    [/\bvd\s*:/g, "ví dụ:"],
    [/\bTP\.\s*(?=[A-ZĐ])/g, "Thành phố "],
    [/\bvs\.?(?=\s)/gi, "so với"],
    [/(\d)\s?k\b/g, "$1 nghìn"],
  ],
  en: [
    [/\be\.g\./gi, "for example"],
    [/\bi\.e\./gi, "that is"],
    [/\betc\./gi, "et cetera"],
    [/\bvs\.?(?=\s)/gi, "versus"],
  ],
};

// Pictographs and the joiners / variation selectors that glue them together.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

export function prepareSpeechText(text: string, language: SpeechLanguage): string {
  const units = UNITS[language];
  let s = text.replace(/\r\n?/g, "\n");

  // Symbols a voice either reads aloud or stumbles on.
  s = s.replace(EMOJI, "");
  s = s.replace(/https?:\/\/\S+/g, "");
  s = s.replace(/(^|\s)#(\p{L}[\p{L}\p{N}_]*)/gu, "$1$2");
  s = s.replace(/[*_~`]+/g, "");
  s = s.replace(/\s&\s/g, language === "vi" ? " và " : " and ");

  // Units and money right after a number.
  s = s.replace(/(\d)\s?km\/h\b/g, `$1 ${units["km/h"]}`);
  s = s.replace(/(\d)\s?°C/g, `$1 ${units["°C"]}`);
  s = s.replace(/(\d)\s?(km|kg|cm|mm)\b/g, (_m, n: string, u: string) => `${n} ${units[u]}`);
  s = s.replace(/(\d)\s?%/g, `$1 ${units["%"]}`);
  s = s.replace(/\$\s?(\d+(?:[.,]\d+)*)/g, `$1 ${units.$}`);
  for (const [pattern, word] of ABBREVIATIONS[language]) s = s.replace(pattern, word);

  // Pauses where a person pauses.
  s = s.replace(/\s+[–—-]\s+/g, ", ");
  s = s.replace(/…/g, "...");
  s = s.replace(/\.{4,}/g, "...");
  s = s.replace(/!{2,}/g, "!");
  s = s.replace(/\?{2,}/g, "?");
  s = s.replace(/([,;:!?])\1+/g, "$1");
  s = s.replace(/(^|[^.])\.\.(?!\.)/g, "$1.");
  s = s.replace(/\s+([,.;:!?])/g, "$1");
  s = s.replace(/([,;:!?])(?=\p{L})/gu, "$1 ");
  s = s.replace(/\.(?=\p{Lu})/gu, ". ");

  return s
    .split("\n")
    .map((l) => oneEllipsisPerSentence(l.replace(/[ \t ]+/g, " ").trim()))
    .filter((l) => l.length > 0)
    .join("\n");
}

/** A second "..." in the same sentence sounds acted; it becomes a comma. */
function oneEllipsisPerSentence(s: string): string {
  return s
    // A sentence ends at ". ! ?" - not at the dots of an ellipsis.
    .split(/(?<=(?:^|[^.])[.!?])\s+(?=\S)/)
    .map((sentence) => {
      let seen = false;
      return sentence.replace(/\.\.\.(?=.)/g, () => {
        if (seen) return ",";
        seen = true;
        return "...";
      });
    })
    .join(" ");
}
