import { z } from "zod";

/**
 * Title / description / tags / hashtags for posting (V1.2 Phase 6, QĐ-114).
 *
 * Only data that already exists or that a person typed: the storyboard title,
 * the idiom's meaning (the "summary"), and what the person entered on the
 * video. No AI writes metadata in Phase 6. Templates use {{name}} placeholders;
 * an unknown placeholder is left visible rather than silently dropped.
 */

export const socialMetaSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  tags: z.array(z.string().max(100)).max(60).optional(),
  hashtags: z.array(z.string().max(100)).max(30).optional(),
});
export type SocialMetaInput = z.infer<typeof socialMetaSchema>;

export interface SocialMeta {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
}

export interface SocialTemplates {
  title: string;
  description: string;
}

export const DEFAULT_SOCIAL_TEMPLATES: SocialTemplates = {
  title: "{{title}}",
  description: "{{summary}}\n\n{{hashtags}}",
};

/** "#AI tools", "ai-tools", "  #x " -> "#AItools", "#aitools", "#x"; empty dropped; de-duplicated. */
export function normalizeHashtags(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const body = raw
      .trim()
      .replace(/^#+/, "")
      .replace(/[\s#,;]+/g, "")
      .replace(/[^\p{L}\p{N}_]/gu, "");
    if (body.length === 0) continue;
    const tag = `#${body}`;
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

export function normalizeTags(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const tag = raw.trim().replace(/^#+/, "").replace(/\s+/g, " ");
    if (tag.length === 0) continue;
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

/** "a, b; c\n d" -> ["a","b","c","d"] */
export function splitList(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : whole,
  );
}

/**
 * The metadata a video is exported with: what the person typed wins field by
 * field; anything left empty comes from the templates over the known facts.
 */
export function buildSocialMeta(opts: {
  title: string;
  summary: string;
  input: SocialMetaInput | null;
  templates: SocialTemplates;
  batchName?: string;
  date?: string;
}): SocialMeta {
  const hashtags = normalizeHashtags(opts.input?.hashtags ?? []);
  const tags = normalizeTags(opts.input?.tags ?? []);
  const vars: Record<string, string> = {
    title: opts.title,
    summary: opts.summary,
    hashtags: hashtags.join(" "),
    tags: tags.join(", "),
    batch: opts.batchName ?? "",
    date: opts.date ?? "",
  };
  const title = (opts.input?.title?.trim() || renderTemplate(opts.templates.title, vars)).trim();
  const description = (opts.input?.description?.trim() || renderTemplate(opts.templates.description, vars)).trim();
  return { title, description, tags, hashtags };
}
