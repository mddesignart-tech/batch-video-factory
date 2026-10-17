import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { checkParsedUrl, checkSourceUrl, isPublicAddress } from "@/domain/url-safety";

/**
 * Read ONE public web page, safely (QĐ-138). $0: no AI, no paid API.
 *
 *   link -> checks (domain/url-safety) -> GET -> redirect? check the new link
 *        -> status -> content type -> body (size-capped, decompressed, decoded)
 *
 * What keeps it from becoming an SSRF hole or a hang:
 *   - every hop's URL is checked, and the socket itself only connects to an
 *     address that passed `isPublicAddress` (the lookup below), so a public
 *     name that resolves inward - or re-resolves inward later - is refused;
 *   - at most MAX_REDIRECTS hops, one deadline for the whole read;
 *   - the body stops at MAX_BYTES, before and after decompression;
 *   - only text/html, application/xhtml+xml and text/plain are read.
 *
 * Nothing here retries, and nothing pretends: every failure is a code and a
 * sentence a person can act on.
 */

export const URL_FETCH_LIMITS = {
  timeoutMs: 15_000,
  maxBytes: 3 * 1024 * 1024,
  maxRedirects: 5,
};

export type UrlFetchErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "CREDENTIALS_IN_URL"
  | "UNSUPPORTED_PORT"
  | "PRIVATE_ADDRESS"
  | "SOCIAL_UNSUPPORTED"
  | "UNSAFE_REDIRECT"
  | "TOO_MANY_REDIRECTS"
  | "TIMEOUT"
  | "DNS_ERROR"
  | "NETWORK_ERROR"
  | "TLS_ERROR"
  | "BLOCKED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "SERVER_ERROR"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "TOO_LARGE"
  | "NO_READABLE_CONTENT"
  | "NEEDS_BROWSER";

export class UrlFetchError extends Error {
  constructor(
    readonly code: UrlFetchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UrlFetchError";
  }
}

export interface UrlResponse {
  status: number;
  /** Lower-case names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  /** Stop reading and free the connection (redirects, refusals). */
  close(): void;
}

/** One GET, no redirect following. The production one opens a socket; tests do not. */
export interface UrlTransport {
  name: string;
  request(url: URL, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<UrlResponse>;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: "text/html" | "text/plain";
  /** The decoded text of the page. */
  body: string;
  bytes: number;
  redirects: string[];
}

const REQUEST_HEADERS = {
  // Honest about what it is: a reader of one page, not a browser in disguise.
  "user-agent": "Mozilla/5.0 (compatible; VideoFactoryReader/1.0; reads one page the user pasted)",
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
  "accept-language": "vi,en;q=0.8",
  "accept-encoding": "gzip, deflate, br",
};

// ------------------------------------------------------------ transport ---

type LookupAddress = { address: string; family: number };
type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * The socket's own DNS lookup: EVERY address the name has must be public, and
 * the connection goes to one of those exact addresses. Checking the name first
 * and letting the socket resolve again would leave a rebinding window.
 */
export function makeSafeLookup(resolve: Resolver = systemResolver) {
  return (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
  ): void => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }));
          return;
        }
        if (addresses.some((a) => !isPublicAddress(a.address))) {
          callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "URL_PRIVATE_ADDRESS" }));
          return;
        }
        if (typeof options === "object" && options?.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err),
    );
  };
}

export function nodeTransport(resolve: Resolver = systemResolver): UrlTransport {
  const lookup = makeSafeLookup(resolve);
  return {
    name: "node",
    request: (url, init) =>
      new Promise<UrlResponse>((ok, fail) => {
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(url, {
          method: "GET",
          headers: init.headers,
          signal: init.signal,
          // Fresh connection, our lookup: no pooled socket to an address we did not vet.
          agent: false,
          lookup: lookup as never,
        });
        req.on("response", (res) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
          }
          ok({ status: res.statusCode ?? 0, headers, body: res, close: () => res.destroy() });
        });
        req.on("error", fail);
        req.end();
      }),
  };
}

let override: UrlTransport | null = null;

/**
 * The transport the app reads pages with. Tests install their own (no socket)
 * through `setUrlTransport`. A development smoke run may point
 * URL_FETCH_FIXTURE_DIR at a folder of pages - never in production, and it is
 * still a folder, not a door to localhost: the URL checks run unchanged.
 */
export async function activeUrlTransport(): Promise<UrlTransport> {
  if (override) return override;
  const dir = process.env.URL_FETCH_FIXTURE_DIR;
  if (dir && process.env.NODE_ENV !== "production") {
    const { fixtureTransport } = await import("./url-fixture-transport");
    return fixtureTransport(dir);
  }
  return nodeTransport();
}

export function setUrlTransport(transport: UrlTransport | null): void {
  override = transport;
}

// ----------------------------------------------------------------- read ---

function friendlyNetworkError(err: unknown, aborted: boolean): UrlFetchError {
  if (err instanceof UrlFetchError) return err;
  const code = (err as NodeJS.ErrnoException)?.code ?? "";
  const name = (err as Error)?.name ?? "";
  if (aborted || name === "AbortError" || code === "ABORT_ERR") {
    return new UrlFetchError("TIMEOUT", `Website phản hồi quá chậm (quá ${URL_FETCH_LIMITS.timeoutMs / 1000} giây). Hãy thử lại sau.`);
  }
  if (code === "URL_PRIVATE_ADDRESS") {
    return new UrlFetchError("PRIVATE_ADDRESS", "Tên miền này trỏ tới địa chỉ nội bộ - tool chỉ đọc trang web công khai.");
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL" || code === "ENODATA") {
    return new UrlFetchError("DNS_ERROR", "Không tìm thấy tên miền này. Hãy kiểm tra lại link hoặc kết nối mạng.");
  }
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(code)) {
    return new UrlFetchError("TLS_ERROR", "Chứng chỉ bảo mật (HTTPS) của trang không hợp lệ - tool không đọc trang này.");
  }
  return new UrlFetchError("NETWORK_ERROR", "Không kết nối được tới website. Hãy kiểm tra mạng rồi thử lại.");
}

function statusError(status: number): UrlFetchError {
  if (status === 401 || status === 403) {
    return new UrlFetchError("BLOCKED", `Website từ chối cho tool đọc (HTTP ${status}) - trang có thể chặn bot hoặc cần đăng nhập.`, status);
  }
  if (status === 404 || status === 410) return new UrlFetchError("NOT_FOUND", `Không tìm thấy trang (HTTP ${status}). Hãy kiểm tra lại link.`, status);
  if (status === 429) return new UrlFetchError("RATE_LIMITED", "Website đang giới hạn truy cập (HTTP 429). Hãy thử lại sau ít phút.", status);
  if (status >= 500) return new UrlFetchError("SERVER_ERROR", `Website đang gặp lỗi (HTTP ${status}). Hãy thử lại sau.`, status);
  return new UrlFetchError("HTTP_ERROR", `Website trả lỗi HTTP ${status}.`, status);
}

const READABLE_TYPES: Record<string, FetchedPage["contentType"]> = {
  "text/html": "text/html",
  "application/xhtml+xml": "text/html",
  "text/plain": "text/plain",
};

function unsupportedType(mime: string): UrlFetchError {
  const what = mime.includes("pdf")
    ? "tệp PDF"
    : mime.startsWith("image/")
      ? "ảnh"
      : mime.startsWith("video/") || mime.startsWith("audio/")
        ? "video / âm thanh"
        : mime.includes("zip") || mime.includes("octet-stream")
          ? "tệp tải về"
          : `"${mime}"`;
  return new UrlFetchError("UNSUPPORTED_CONTENT_TYPE", `Link này là ${what}, không phải trang web có chữ. Tool chỉ đọc trang HTML / văn bản.`);
}

function tooLarge(): UrlFetchError {
  return new UrlFetchError("TOO_LARGE", `Trang quá lớn (hơn ${URL_FETCH_LIMITS.maxBytes / 1024 / 1024} MB) - tool dừng đọc để an toàn.`);
}

function charsetOf(contentType: string, head: Buffer): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const sniff = head.subarray(0, 4096).toString("latin1");
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1] ?? "utf-8";
}

function decode(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decompress(raw: Buffer, encoding: string): Buffer {
  const enc = encoding.trim().toLowerCase();
  const opts = { maxOutputLength: URL_FETCH_LIMITS.maxBytes };
  try {
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(raw, opts);
    if (enc === "deflate") return zlib.inflateSync(raw, opts);
    if (enc === "br") return zlib.brotliDecompressSync(raw, opts);
  } catch (err) {
    if (err instanceof RangeError || (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
    throw new UrlFetchError("NETWORK_ERROR", "Nội dung trang bị lỗi khi giải nén.");
  }
  return raw;
}

/** No content-type header: read it only when it plainly starts like HTML. */
function sniffHtml(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || (head.startsWith("<") && head.includes("<body"));
}

/**
 * GET a public page. Follows at most MAX_REDIRECTS redirects, each checked as
 * a new link. Throws UrlFetchError, never a raw network error.
 */
export async function fetchPage(
  rawUrl: string,
  opts: { transport?: UrlTransport; /** Tests shorten the wait; the app uses the limit. */ timeoutMs?: number } = {},
): Promise<FetchedPage> {
  const first = checkSourceUrl(rawUrl);
  if (!first.ok) throw new UrlFetchError(first.code, first.message);
  const transport = opts.transport ?? (await activeUrlTransport());

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? URL_FETCH_LIMITS.timeoutMs);

  const redirects: string[] = [];
  let current = first.url;
  try {
    for (let hop = 0; ; hop += 1) {
      let res: UrlResponse;
      try {
        res = await transport.request(current, { signal: controller.signal, headers: { ...REQUEST_HEADERS } });
      } catch (err) {
        throw friendlyNetworkError(err, timedOut);
      }

      if (res.status >= 300 && res.status < 400) {
        res.close();
        const location = res.headers.location;
        if (!location) throw new UrlFetchError("HTTP_ERROR", `Website chuyển hướng (HTTP ${res.status}) nhưng không nói tới đâu.`, res.status);
        if (hop + 1 > URL_FETCH_LIMITS.maxRedirects) {
          throw new UrlFetchError("TOO_MANY_REDIRECTS", `Website chuyển hướng quá nhiều lần (hơn ${URL_FETCH_LIMITS.maxRedirects}).`);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new UrlFetchError("UNSAFE_REDIRECT", "Website chuyển hướng tới một link không hợp lệ.");
        }
        const checked = checkParsedUrl(next);
        if (!checked.ok) {
          throw new UrlFetchError(
            checked.code === "SOCIAL_UNSUPPORTED" ? "SOCIAL_UNSUPPORTED" : "UNSAFE_REDIRECT",
            checked.code === "SOCIAL_UNSUPPORTED" ? checked.message : `Website chuyển hướng tới một link không an toàn: ${checked.message}`,
          );
        }
        redirects.push(checked.url.href);
        current = checked.url;
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        res.close();
        throw statusError(res.status);
      }

      const contentType = res.headers["content-type"] ?? "";
      const mime = contentType.split(";")[0]!.trim().toLowerCase();
      const kind = READABLE_TYPES[mime];
      if (mime && !kind) {
        res.close();
        throw unsupportedType(mime);
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > URL_FETCH_LIMITS.maxBytes) {
        res.close();
        throw tooLarge();
      }

      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of res.body) {
          // One deadline for the whole read: a page that trickles in slowly
          // is cut off exactly like one that never answers.
          if (timedOut) {
            res.close();
            throw friendlyNetworkError(new Error("timeout"), true);
          }
          total += chunk.byteLength;
          if (total > URL_FETCH_LIMITS.maxBytes) {
            res.close();
            throw tooLarge();
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (err) {
        if (err instanceof UrlFetchError) throw err;
        throw friendlyNetworkError(err, timedOut);
      }
      const bytes = decompress(Buffer.concat(chunks), res.headers["content-encoding"] ?? "");
      const finalKind = kind ?? (sniffHtml(bytes) ? "text/html" : null);
      if (!finalKind) throw unsupportedType("không rõ loại");

      return {
        url: first.url.href,
        finalUrl: current.href,
        status: res.status,
        contentType: finalKind,
        body: decode(bytes, charsetOf(contentType, bytes)),
        bytes: bytes.byteLength,
        redirects,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
