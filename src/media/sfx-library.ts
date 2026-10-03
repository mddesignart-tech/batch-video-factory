import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT, ensureDir } from "@/lib/paths";
import { ffmpeg } from "./ffmpeg";

/**
 * Local sound effects (QĐ-125). The scripts carry a hint per scene ("whoosh",
 * "ding", "soft impact"…), and there has never been an effects provider: these
 * are synthesised once by FFmpeg from tones and filtered noise and cached under
 * data/sfx. $0, offline, deterministic. A hint with no recipe (an animal call,
 * a real-world sound) is skipped rather than faked.
 */

interface Recipe {
  id: string;
  /** Words in a hint that pick this recipe (lower case, accents ignored). */
  words: string[];
  /** lavfi source + filters. */
  graph: string;
}

const RECIPES: Recipe[] = [
  { id: "whoosh", words: ["whoosh", "swoosh", "swish", "vut"], graph: "anoisesrc=d=0.6:c=pink:a=0.5,bandpass=f=1400:w=1000,afade=t=in:d=0.25,afade=t=out:st=0.3:d=0.3" },
  { id: "ding", words: ["ding", "bell", "chuong"], graph: "sine=f=1320:d=0.8,afade=t=out:st=0.05:d=0.75,volume=0.6" },
  { id: "chime", words: ["chime", "sparkle", "twinkle"], graph: "sine=f=990:d=0.9,afade=t=out:st=0.05:d=0.85,volume=0.55" },
  { id: "pop", words: ["pop", "bubble", "click"], graph: "sine=f=620:d=0.12,afade=t=out:st=0.02:d=0.1,volume=0.8" },
  { id: "impact", words: ["impact", "thud", "boom", "bump", "drop"], graph: "sine=f=85:d=0.45,afade=t=out:st=0.02:d=0.43,volume=1.3" },
  { id: "engine", words: ["engine", "motor", "truck", "car", "rumble"], graph: "anoisesrc=d=1.2:c=brown:a=0.5,lowpass=f=260,afade=t=in:d=0.2,afade=t=out:st=0.9:d=0.3" },
];

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").toLowerCase();
}

/** Which synthesised effect a scene hint asks for; null = none we can make honestly. */
export function sfxRecipeFor(hint: string): string | null {
  const words = normalize(hint);
  if (!words.trim()) return null;
  const recipe = RECIPES.find((r) => r.words.some((w) => new RegExp(`\\b${w}\\b`).test(words)));
  return recipe?.id ?? null;
}

/** The cached file for a hint, made once on first use. Null when no recipe matches. */
export async function sfxFileFor(hint: string): Promise<string | null> {
  const id = sfxRecipeFor(hint);
  if (!id) return null;
  const recipe = RECIPES.find((r) => r.id === id)!;
  const dir = ensureDir(path.join(DATA_ROOT, "sfx"));
  const file = path.join(dir, `${id}.wav`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", recipe.graph, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", file]);
  return file;
}
