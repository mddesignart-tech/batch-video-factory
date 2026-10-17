import { isIP } from "node:net";

/**
 * URL SOURCE - which links the tool may read (QĐ-138).
 *
 * A pasted link is untrusted input that makes THIS machine open a connection.
 * Left alone that is an SSRF hole: "http://127.0.0.1:3000/api/…", the router's
 * admin page, a cloud metadata endpoint. So a link is read only when it is a
 * plain public http(s) web page:
 *
 *   - scheme http / https, default ports, no user:password@;
 *   - the host is not localhost, not an internal name, not a private / loopback
 *     / link-local / metadata / reserved address - checked here for literal IPs
 *     and again for EVERY address the name resolves to, at connect time
 *     (services/url-fetch.ts), so DNS cannot point a public name inward;
 *   - every redirect is a new link and goes through all of this again.
 *
 * There is no exception for localhost anywhere in this file. Tests and the
 * smoke run reach their fixtures through a transport that never opens a socket.
 */

export type UrlRejectCode =
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "CREDENTIALS_IN_URL"
  | "UNSUPPORTED_PORT"
  | "PRIVATE_ADDRESS"
  | "SOCIAL_UNSUPPORTED";

export type UrlCheck = { ok: true; url: URL } | { ok: false; code: UrlRejectCode; message: string };

export const MAX_URL_LENGTH = 2000;

const reject = (code: UrlRejectCode, message: string): UrlCheck => ({ ok: false, code, message });

/** Internal names: never a public website. */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "kubernetes",
  "kubernetes.default",
]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
  ".localdomain",
  ".in-addr.arpa",
  ".ip6.arpa",
];

/**
 * Social / video platforms: their pages need a login or a browser and are not
 * read in this phase (QĐ-138 §20). Said plainly instead of half-reading them.
 */
const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "fb.watch",
  "messenger.com",
  "instagram.com",
  "threads.net",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "pinterest.com",
  "zalo.me",
];

export function socialPlatformOf(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return SOCIAL_HOSTS.find((s) => h === s || h.endsWith(`.${s}`)) ?? null;
}

// ------------------------------------------------------------ addresses ---

function v4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? n : null;
}

function isPublicV4(ip: string): boolean {
  const o = v4Octets(ip);
  if (!o) return false;
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF / TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expand an IPv6 address to its 8 groups, or null when it is not one. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const o = v4Octets(dotted[1]!);
    if (!o) return null;
    s = `${s.slice(0, dotted.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...tail].some((g) => Number.isNaN(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
}

function isPublicV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return false;
  const embeddedV4 = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped / -compatible / NAT64: judged by the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPublicV4(embeddedV4());
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicV4(embeddedV4());
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4: could wrap anything
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  return true;
}

/** Is this IP literal an address on the public internet? Non-IPs are false. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").split("%")[0]!);
  if (kind === 4) return isPublicV4(ip);
  if (kind === 6) return isPublicV6(ip);
  return false;
}

// ----------------------------------------------------------------- URLs ---

/**
 * Parse and check a link the person pasted. A bare "example.com/page" is read
 * as https. The fragment is dropped (never sent anyway). Returns the
 * normalised URL or a friendly reason.
 */
export function checkSourceUrl(raw: string): UrlCheck {
  const text = (raw ?? "").trim();
  if (!text) return reject("INVALID_URL", "Hãy dán một đường link.");
  if (text.length > MAX_URL_LENGTH) return reject("INVALID_URL", "Đường link quá dài.");

  // "javascript:…", "file:…", "data:…" have a scheme; "example.com:8080/x" and
  // "localhost:3000" are a host and a port (dotted, or digits after the colon).
  const m = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(text);
  const scheme = m?.[1]?.toLowerCase();
  const hasScheme = Boolean(m) && !scheme!.includes(".") && !/^\d+(\/|$)/.test(m![2]!);
  if (hasScheme && scheme !== "http" && scheme !== "https") {
    return reject("UNSUPPORTED_SCHEME", `Chỉ đọc được link http:// hoặc https:// (link này là "${scheme}:").`);
  }
  if (/[\s<>"`]/.test(text)) return reject("INVALID_URL", "Đường link có ký tự không hợp lệ (khoảng trắng, dấu ngoặc…).");
  let url: URL;
  try {
    url = new URL(hasScheme ? text : `https://${text.replace(/^\/+/, "")}`);
  } catch {
    return reject("INVALID_URL", "Đường link không hợp lệ.");
  }
  return checkParsedUrl(url);
}

/** The same checks for a URL already parsed - every redirect goes through here. */
export function checkParsedUrl(input: URL): UrlCheck {
  const url = new URL(input.href);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return reject("UNSUPPORTED_SCHEME", `Chỉ đọc được link http:// hoặc https:// (không đọc "${url.protocol}").`);
  }
  if (url.username || url.password) {
    return reject("CREDENTIALS_IN_URL", "Link chứa tên đăng nhập / mật khẩu - tool không đọc loại link này.");
  }
  if (url.port !== "") {
    return reject("UNSUPPORTED_PORT", "Chỉ đọc trang web thông thường (cổng 80 / 443). Link này dùng cổng khác.");
  }
  // WHATWG parsing has already turned 2130706433, 0x7f.1, 017700000001… into
  // dotted form, so the literal check below sees what a socket would.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return reject("INVALID_URL", "Đường link thiếu tên miền.");
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (!isPublicAddress(bare)) {
      return reject("PRIVATE_ADDRESS", "Link trỏ tới địa chỉ nội bộ / máy này - tool chỉ đọc trang web công khai.");
    }
  } else {
    if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      return reject("PRIVATE_ADDRESS", "Link trỏ tới mạng nội bộ / máy này - tool chỉ đọc trang web công khai.");
    }
    // A single-label name ("router", "intranet") only means something inside a network.
    if (!host.includes(".")) {
      return reject("PRIVATE_ADDRESS", "Tên miền không đầy đủ (mạng nội bộ?) - tool chỉ đọc trang web công khai.");
    }
    const social = socialPlatformOf(host);
    if (social) {
      return reject(
        "SOCIAL_UNSUPPORTED",
        `Link mạng xã hội / video (${social}) chưa được hỗ trợ: các trang này cần đăng nhập hoặc trình duyệt. Hãy sao chép nội dung và dùng nguồn "Dán nội dung".`,
      );
    }
  }
  url.hash = "";
  return { ok: true, url };
}
