import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parseJson } from "@/lib/utils";
import { checkSourceUrl } from "@/domain/url-safety";
import { fetchPage, UrlFetchError, type UrlTransport } from "./url-fetch";
import { contentHashOf, extractHtml, extractPlainText, ExtractError, THIN_CONTENT_CHARS, type ProductFacts } from "./url-extract";
import { MAX_SOURCE_CHARS } from "./content-source";

/**
 * URL SOURCE (QĐ-138): a web page as the source of a video's script.
 *
 *   ĐỌC NỘI DUNG   fetch + extract -> a PREVIEW. Nothing is stored, no AI is
 *                  called, $0. The person reads it, edits it, accepts it.
 *   CHẤP NHẬN      the accepted text is the SNAPSHOT: Project.sourceText, with
 *                  the page's metadata in contentBriefJson.urlSource. From here
 *                  on the script writer, a rewrite, resume and render read the
 *                  snapshot - nothing opens the link again.
 *   ĐỌC LẠI TỪ WEB only when the person presses it: a new preview, and the
 *                  snapshot is replaced only when they accept it (confirmed
 *                  when a script was already written from the old one). It
 *                  never rewrites the script and never touches media.
 */

export interface UrlSourceMeta {
  url: string;
  finalUrl: string;
  domain: string;
  pageTitle: string;
  description: string;
  siteName: string;
  language: string;
  contentType: string;
  extractedAt: string;
  extractionMethod: string;
  contentLength: number;
  contentHash: string;
  kind: string;
  author: string;
  publishedAt: string;
  /** og:image as a link only; nothing is downloaded. */
  imageUrl: string;
  truncated: boolean;
  /** The page showed a price: current-page data that may change. */
  hasPrice: boolean;
}

/** What is stored with an accepted snapshot. */
export interface StoredUrlSource extends UrlSourceMeta {
  approvedAt: string;
  /** The person changed the extracted text before accepting it. */
  edited: boolean;
  snapshotHash: string;
}

export interface UrlSourcePreview {
  meta: UrlSourceMeta;
  text: string;
  product: ProductFacts | null;
  warnings: string[];
}

const s = (max: number) => z.string().max(max).default("");
/** The metadata comes back from the browser with the accepted text: checked, never trusted. */
export const UrlSourceMetaSchema = z.object({
  url: z.string().min(1).max(2000),
  finalUrl: z.string().max(2000).default(""),
  domain: s(300),
  pageTitle: s(500),
  description: s(2000),
  siteName: s(300),
  language: s(20),
  contentType: s(60),
  extractedAt: s(40),
  extractionMethod: s(60),
  contentLength: z.number().int().min(0).max(1_000_000).default(0),
  contentHash: s(64),
  kind: s(20),
  author: s(300),
  publishedAt: s(60),
  imageUrl: s(2000),
  truncated: z.boolean().default(false),
  hasPrice: z.boolean().default(false),
});

export class UrlSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UrlSourceError";
  }
}

function warningsFor(text: string, meta: UrlSourceMeta): string[] {
  const w: string[] = [];
  if (text.length < THIN_CONTENT_CHARS) {
    w.push(`Chỉ trích được ${text.length} ký tự - khá ít. Hãy kiểm tra và bổ sung nội dung trước khi chấp nhận.`);
  }
  if (meta.truncated) {
    w.push(`Trang dài: đã lấy khoảng ${meta.contentLength.toLocaleString("vi-VN")} ký tự đầu (ưu tiên tiêu đề, mô tả, thông số và phần nội dung chính).`);
  }
  if (meta.hasPrice) w.push("Giá là dữ liệu trên trang tại thời điểm đọc và có thể thay đổi.");
  if (meta.finalUrl && meta.finalUrl !== meta.url) w.push(`Trang đã chuyển hướng tới ${meta.finalUrl}.`);
  return w;
}

/** ĐỌC NỘI DUNG: fetch and extract one page. $0, nothing stored. */
export async function readUrlSource(rawUrl: string, opts: { transport?: UrlTransport; timeoutMs?: number } = {}): Promise<UrlSourcePreview> {
  const page = await fetchPage(rawUrl, opts);
  const extracted = page.contentType === "text/plain" ? extractPlainText(page.body) : extractHtml(page.body, page.finalUrl);
  const meta: UrlSourceMeta = {
    url: page.url,
    finalUrl: page.finalUrl,
    domain: new URL(page.finalUrl).hostname.replace(/^www\./, ""),
    pageTitle: extracted.title,
    description: extracted.description,
    siteName: extracted.siteName,
    language: extracted.language,
    contentType: page.contentType,
    extractedAt: new Date().toISOString(),
    extractionMethod: extracted.method,
    contentLength: extracted.contentLength,
    contentHash: extracted.contentHash,
    kind: extracted.kind,
    author: extracted.author,
    publishedAt: extracted.publishedAt,
    imageUrl: extracted.imageUrl,
    truncated: extracted.truncated,
    hasPrice: Boolean(extracted.product?.price),
  };
  await logger.info({
    event: "url_source.read",
    message: `Đọc ${meta.domain}: ${meta.contentLength} ký tự (${meta.extractionMethod}, ${meta.kind}). $0 - không gọi AI.`,
  });
  return { meta, text: extracted.text, product: extracted.product, warnings: warningsFor(extracted.text, meta) };
}

/** Friendly text for any failure of a read - never a stack trace. */
export function urlSourceErrorMessage(err: unknown): { code: string; message: string } {
  if (err instanceof UrlFetchError || err instanceof ExtractError || err instanceof UrlSourceError) {
    return { code: err.code, message: err.message };
  }
  return { code: "UNKNOWN", message: "Không đọc được trang này. Hãy thử lại, hoặc sao chép nội dung và dùng nguồn \"Dán nội dung\"." };
}

/** Check what the browser sent back with an accepted text. */
export function acceptedSnapshot(text: string, rawMeta: unknown): { text: string; stored: StoredUrlSource } {
  const parsed = UrlSourceMetaSchema.safeParse(rawMeta);
  if (!parsed.success) throw new UrlSourceError("BAD_META", "Thông tin trang không hợp lệ - hãy bấm ĐỌC NỘI DUNG lại.");
  const checked = checkSourceUrl(parsed.data.url);
  if (!checked.ok) throw new UrlSourceError(checked.code, checked.message);
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) throw new UrlSourceError("EMPTY_SNAPSHOT", "Nội dung trích đang trống - hãy đọc lại trang hoặc dán nội dung.");
  if (clean.length > MAX_SOURCE_CHARS) {
    throw new UrlSourceError("SOURCE_TOO_LONG", `Nội dung quá dài (${clean.length.toLocaleString("vi-VN")} ký tự). Tối đa ${MAX_SOURCE_CHARS.toLocaleString("vi-VN")} ký tự.`);
  }
  const snapshotHash = contentHashOf(clean);
  return {
    text: clean,
    stored: {
      ...parsed.data,
      url: checked.url.href,
      approvedAt: new Date().toISOString(),
      edited: snapshotHash !== parsed.data.contentHash,
      snapshotHash,
    },
  };
}

export function storedUrlSourceOf(project: { contentBriefJson: string | null }): StoredUrlSource | null {
  const brief = parseJson<{ urlSource?: StoredUrlSource }>(project.contentBriefJson, {});
  return brief.urlSource && typeof brief.urlSource.url === "string" ? brief.urlSource : null;
}

/**
 * The writer's rule for a URL source: the snapshot is SOURCE MATERIAL - the
 * only place facts may come from. Creative style changes the telling, never
 * the facts; a price is the page's at reading time.
 */
export function urlSourceRule(src: StoredUrlSource | null, sourceUrl: string | null): string {
  const where = src?.finalUrl || src?.url || sourceUrl || "a web page";
  const when = src?.extractedAt ? src.extractedAt.slice(0, 10) : "";
  return [
    `SOURCE MATERIAL: the SOURCE TEXT above was extracted from the web page ${where}${when ? ` on ${when}` : ""} and accepted by the person.`,
    "- It is the ONLY source of facts about the subject: names, features, specifications, numbers, prices, dates, quotes and claims must come from it (or from the facts list).",
    "- Do not add a feature, spec, number, award, comparison or claim the page does not state. When something is missing, use careful wording (\"theo trang giới thiệu\", \"according to the page\") or leave it out.",
    "- A price is the page's price when it was read and may change: say so, or leave it out.",
    "- The creative style changes HOW it is told (tone, jokes, pace), never WHAT is true.",
    "- Write in the script language; keep names and figures exactly as on the page.",
  ].join("\n");
}

// ------------------------------------------------------ project re-fetch ---

export interface RefetchResult {
  preview: UrlSourcePreview;
  /** The page's extracted text differs from the one stored with the snapshot. */
  changed: boolean;
  scriptExists: boolean;
  mediaExists: boolean;
}

async function urlProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { scenes: { select: { imagePath: true, videoPath: true, audioPath: true } } },
  });
  if (!project) throw new UrlSourceError("NOT_FOUND", "Không tìm thấy dự án.");
  if (project.contentSourceType !== "URL") throw new UrlSourceError("NOT_URL_SOURCE", "Dự án này không lấy nội dung từ đường link.");
  return project;
}

/** ĐỌC LẠI TỪ WEB: a new preview only. Stores nothing, writes no script, makes no media. */
export async function refetchProjectUrlSource(projectId: string, opts: { transport?: UrlTransport } = {}): Promise<RefetchResult> {
  const project = await urlProject(projectId);
  const stored = storedUrlSourceOf(project);
  const url = stored?.url ?? project.sourceUrl;
  if (!url) throw new UrlSourceError("NO_URL", "Dự án không lưu đường link nào để đọc lại.");
  const preview = await readUrlSource(url, opts);
  return {
    preview,
    changed: preview.meta.contentHash !== (stored?.contentHash ?? ""),
    scriptExists: Boolean(project.scriptJson),
    mediaExists: project.scenes.some((sc) => sc.imagePath || sc.videoPath || sc.audioPath),
  };
}

export type ApplySnapshotResult =
  | { status: "NEEDS_CONFIRMATION"; message: string }
  | { status: "UPDATED"; message: string; mediaExists: boolean };

/**
 * Replace the snapshot with a newly accepted text. SOURCE ONLY: the script,
 * the scenes and every picture / clip / voice stay exactly as they are.
 */
export async function applyProjectUrlSource(
  projectId: string,
  input: { text: string; meta: unknown; confirmReplace?: boolean },
): Promise<ApplySnapshotResult> {
  const project = await urlProject(projectId);
  const { text, stored } = acceptedSnapshot(input.text, input.meta);
  const mediaExists = project.scenes.some((sc) => sc.imagePath || sc.videoPath || sc.audioPath);
  if (project.scriptJson && !input.confirmReplace) {
    return {
      status: "NEEDS_CONFIRMATION",
      message:
        "Kịch bản hiện tại được viết từ nội dung cũ. Thay nguồn chỉ cập nhật nội dung nguồn - kịch bản, ảnh, clip và giọng giữ nguyên." +
        " Xác nhận để thay?",
    };
  }
  const brief = parseJson<Record<string, unknown>>(project.contentBriefJson, {});
  await prisma.project.update({
    where: { id: projectId },
    data: { sourceText: text, sourceUrl: stored.url, contentBriefJson: JSON.stringify({ ...brief, urlSource: stored }) },
  });
  await logger.info({
    event: "url_source.snapshot_replaced",
    projectId,
    message: `Thay nội dung nguồn từ ${stored.domain} (${text.length} ký tự). Không viết lại kịch bản, không tạo media ($0).`,
  });
  return {
    status: "UPDATED",
    mediaExists,
    message:
      "Đã cập nhật nội dung nguồn. Kịch bản và media giữ nguyên." +
      (project.scriptJson ? " Muốn áp dụng nội dung mới: bấm VIẾT LẠI KỊCH BẢN (chỉ viết lại chữ)." : "") +
      (mediaExists ? " Lưu ý: media hiện có được làm theo kịch bản cũ." : ""),
  };
}
