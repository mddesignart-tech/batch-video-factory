import type { FactOrigin } from "@/domain/content-options";

/**
 * CONTENT SOURCE - where a video's content comes from, behind one interface.
 *
 * PROMPT, TEXT and ASSETS are resolved locally and cost nothing. URL is part of
 * the architecture but GATED: no web extraction service exists yet, so a URL is
 * stored on the project and the person is asked to paste the page's text. A
 * future extractor (an official API, a readability service, a public document
 * fetcher) is one more resolver here - nothing else changes. Nothing scrapes a
 * site, and no resolver names a website.
 */

export interface ContentSourceInput {
  idea?: string;
  sourceText?: string;
  sourceUrl?: string;
  /** Facts the person typed (product specs, contact details...). */
  facts?: { text: string; origin?: FactOrigin }[];
  uploadCount?: number;
}

export interface ResolvedContent {
  idea: string;
  sourceText: string;
  sourceUrl: string | null;
  facts: { text: string; origin: FactOrigin }[];
}

export class ContentSourceError extends Error {
  constructor(
    readonly code: "EMPTY_SOURCE" | "URL_SOURCE_NOT_AVAILABLE" | "SOURCE_TOO_LONG" | "UNKNOWN_SOURCE",
    message: string,
  ) {
    super(message);
    this.name = "ContentSourceError";
  }
}

export interface ContentSourceResolver {
  id: string;
  /** False = shown as "sắp có" and refused here, never half-working. */
  available: boolean;
  resolve(input: ContentSourceInput): Promise<ResolvedContent>;
}

/** Pasted text longer than this is cut by the writer anyway; refuse rather than pay to send it. */
export const MAX_SOURCE_CHARS = 20_000;

function base(input: ContentSourceInput): ResolvedContent {
  return {
    idea: (input.idea ?? "").trim(),
    sourceText: (input.sourceText ?? "").trim(),
    sourceUrl: input.sourceUrl?.trim() || null,
    facts: (input.facts ?? [])
      .map((f) => ({ text: f.text.trim(), origin: f.origin ?? ("USER_PROVIDED" as const) }))
      .filter((f) => f.text.length > 0),
  };
}

function requireSomething(r: ResolvedContent, uploads: number): ResolvedContent {
  if (!r.idea && !r.sourceText && r.facts.length === 0 && uploads === 0) {
    throw new ContentSourceError("EMPTY_SOURCE", "Hãy nhập ý tưởng, dán nội dung hoặc tải ảnh lên trước khi tạo kịch bản.");
  }
  if (r.sourceText.length > MAX_SOURCE_CHARS) {
    throw new ContentSourceError(
      "SOURCE_TOO_LONG",
      `Nội dung dán quá dài (${r.sourceText.length.toLocaleString("vi-VN")} ký tự). Tối đa ${MAX_SOURCE_CHARS.toLocaleString("vi-VN")} ký tự - hãy rút gọn bớt.`,
    );
  }
  return r;
}

const RESOLVERS: Record<string, ContentSourceResolver> = {
  PROMPT: { id: "PROMPT", available: true, resolve: async (i) => requireSomething(base(i), i.uploadCount ?? 0) },
  TEXT: {
    id: "TEXT",
    available: true,
    resolve: async (i) => {
      const r = base(i);
      if (!r.sourceText && !r.idea) {
        throw new ContentSourceError("EMPTY_SOURCE", "Hãy dán nội dung (bài viết, caption, mô tả sản phẩm…) vào ô.");
      }
      return requireSomething(r, i.uploadCount ?? 0);
    },
  },
  ASSETS: {
    id: "ASSETS",
    available: true,
    resolve: async (i) => {
      if ((i.uploadCount ?? 0) === 0) {
        throw new ContentSourceError("EMPTY_SOURCE", "Hãy chọn ít nhất một ảnh để tải lên.");
      }
      return requireSomething(base(i), i.uploadCount ?? 0);
    },
  },
  URL: {
    id: "URL",
    available: false,
    resolve: async (i) => {
      const r = base(i);
      // The URL is kept; its TEXT has to come from the person for now.
      if (r.sourceText || r.idea) return requireSomething(r, i.uploadCount ?? 0);
      throw new ContentSourceError(
        "URL_SOURCE_NOT_AVAILABLE",
        "Tool chưa tự đọc nội dung từ đường link. Hãy mở trang, sao chép phần nội dung cần dùng và dán vào ô “Dán nội dung”.",
      );
    },
  },
};

export function contentSourceResolver(sourceType: string): ContentSourceResolver {
  const r = RESOLVERS[sourceType];
  if (!r) throw new ContentSourceError("UNKNOWN_SOURCE", `Nguồn nội dung không hợp lệ: ${sourceType}`);
  return r;
}

export async function resolveContentSource(sourceType: string, input: ContentSourceInput): Promise<ResolvedContent> {
  return contentSourceResolver(sourceType).resolve(input);
}
