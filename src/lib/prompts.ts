import fs from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";

/**
 * Prompt templates.
 *
 * Prompts are the most-edited part of a system like this, so they live in
 * `prompts/*.txt` rather than scattered through the source. A prompt tweak is
 * then a text edit, not a code change and redeploy.
 *
 * Resolution order is DB override -> file on disk -> error. The DB layer is what
 * lets the admin UI edit prompts later without touching the filesystem, and it
 * means an operator's edit survives a `git pull` that changes the template.
 */

export const PROMPT_NAMES = [
  "concept",
  "script",
  "storyboard",
  "image",
  "video",
  "quality",
  "youtube",
] as const;

export type PromptName = (typeof PROMPT_NAMES)[number];

const PROMPTS_DIR = path.resolve(process.cwd(), "prompts");
const SETTING_PREFIX = "prompt.";

const fileCache = new Map<string, string>();

export function promptPath(name: PromptName): string {
  return path.join(PROMPTS_DIR, `${name}.txt`);
}

export function readPromptFile(name: PromptName): string {
  const cached = fileCache.get(name);
  if (cached !== undefined) return cached;
  const contents = fs.readFileSync(promptPath(name), "utf8");
  fileCache.set(name, contents);
  return contents;
}

export function clearPromptCache(): void {
  fileCache.clear();
}

/** The template an operator has saved in the admin UI, if any. */
export async function getPromptOverride(
  name: PromptName,
): Promise<string | null> {
  const row = await prisma.setting.findUnique({
    where: { key: `${SETTING_PREFIX}${name}` },
  });
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.valueJson);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function savePromptOverride(
  name: PromptName,
  template: string,
): Promise<void> {
  const key = `${SETTING_PREFIX}${name}`;
  const valueJson = JSON.stringify(template);
  await prisma.setting.upsert({
    where: { key },
    create: { key, valueJson },
    update: { valueJson },
  });
}

export async function resetPromptOverride(name: PromptName): Promise<void> {
  await prisma.setting
    .delete({ where: { key: `${SETTING_PREFIX}${name}` } })
    .catch(() => undefined);
}

export async function loadPrompt(name: PromptName): Promise<string> {
  return (await getPromptOverride(name)) ?? readPromptFile(name);
}

/**
 * Fill `{{placeholders}}`.
 *
 * A missing key is left as-is rather than replaced with "undefined": a visible
 * `{{characters}}` in a prompt is an obvious bug, whereas the string "undefined"
 * silently poisons the generation.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string | number | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = values[key];
    return value === undefined ? whole : String(value);
  });
}

export async function buildPrompt(
  name: PromptName,
  values: Record<string, string | number | undefined>,
): Promise<string> {
  return renderTemplate(await loadPrompt(name), values);
}

/** Placeholders a template expects, for validating an operator's edit. */
export function templatePlaceholders(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(/\{\{(\w+)\}\}/g), (m) => m[1]!))];
}
