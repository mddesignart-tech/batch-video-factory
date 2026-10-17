import { createHash } from "node:crypto";

/**
 * From a page's HTML to the text a script can be written from (QĐ-138).
 *
 * Deterministic and local: a small HTML parser, a readability-lite choice of
 * the main block, schema.org JSON-LD for products and articles, then cleanup.
 * No AI, no browser, no network - and it never "fixes" a fact: every line of
 * the result is text that was on the page, in the page's own language.
 *
 *   drop      script, style, nav, footer, aside, menus, cookie / consent
 *             banners, ads, share / related / comment blocks, hidden content
 *   keep      title, description, headings, paragraphs, list items, spec
 *             tables, product facts (JSON-LD), author / date of an article
 *   cap       MAX_EXTRACT_CHARS: title, description and product facts first,
 *             then the main body in page order, cut at a block boundary
 */

export const MAX_EXTRACT_CHARS = 12_000;
/** Below this the preview warns that little was found. */
export const THIN_CONTENT_CHARS = 600;
/** Below this (and no product facts) there is nothing to write a script from. */
const MIN_USEFUL_CHARS = 150;

export type PageKind = "ARTICLE" | "PRODUCT" | "PAGE";

export interface ProductFacts {
  name: string;
  description: string;
  brand: string;
  /** "Giá trên trang" - current-page data, may change. Empty when the page shows none. */
  price: string;
  availability: string;
  specs: { name: string; value: string }[];
  features: string[];
}

export interface ExtractedPage {
  kind: PageKind;
  title: string;
  description: string;
  siteName: string;
  /** "vi", "en", another BCP-47 primary tag, or "" when unknown. */
  language: string;
  author: string;
  publishedAt: string;
  /** og:image as a link only - never downloaded here. */
  imageUrl: string;
  product: ProductFacts | null;
  /** The cleaned, capped text: what the preview shows and the writer reads. */
  text: string;
  contentLength: number;
  truncated: boolean;
  /** "jsonld+readability", "readability", "plain-text"… */
  method: string;
  contentHash: string;
}

export class ExtractError extends Error {
  constructor(
    readonly code: "NO_READABLE_CONTENT" | "NEEDS_BROWSER",
    message: string,
  ) {
    super(message);
    this.name = "ExtractError";
  }
}

// =============================================================== parser ===

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: El | null;
}
type Node = El | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp", "iframe"]);
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
const AUTO_CLOSE: Record<string, string[]> = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"],
};

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢",
  times: "×", divide: "÷", deg: "°", plusmn: "±", micro: "µ", middot: "·", bull: "•", sup2: "²", sup3: "³", frac12: "½",
  frac14: "¼", frac34: "¾", shy: "", zwj: "", zwnj: "", lrm: "", rlm: "", thinsp: " ", ensp: " ", emsp: " ", prime: "′",
  Prime: "″", larr: "←", rarr: "→", uarr: "↑", darr: "↓", check: "✓",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? m;
  });
}

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export function parseHtml(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  let i = 0;
  let text = "";
  const flush = () => {
    if (text) cur.children.push(decodeEntities(text));
    text = "";
  };
  const open = (tag: string) => {
    if (cur.tag === "p" && CLOSES_P.has(tag)) cur = cur.parent ?? root;
    if (AUTO_CLOSE[tag]?.includes(cur.tag)) cur = cur.parent ?? root;
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(html);
    if (!m) {
      text += "<";
      i += 1;
      continue;
    }
    flush();
    i = TAG_RE.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (closing) {
      // Close up to the nearest matching open element; a stray close is ignored.
      let e: El | null = cur;
      while (e && e.tag !== tag) e = e.parent;
      if (e && e !== root) cur = e.parent ?? root;
      continue;
    }
    open(tag);
    const el: El = { tag, attrs: parseAttrs(m[3] ?? ""), children: [], parent: cur };
    cur.children.push(el);
    if (RAW.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(i);
      const found = close.exec(rest);
      const inner = found ? rest.slice(0, found.index) : rest;
      if (inner) el.children.push(tag === "script" || tag === "style" ? inner : decodeEntities(inner));
      i += found ? found.index + found[0].length : rest.length;
      continue;
    }
    if (!VOID.has(tag) && m[4] !== "/") cur = el;
  }
  flush();
  return root;
}

function* walk(el: El): Generator<El> {
  for (const c of el.children) {
    if (typeof c === "string") continue;
    yield c;
    yield* walk(c);
  }
}

function rawText(el: El): string {
  return el.children.map((c) => (typeof c === "string" ? c : rawText(c))).join("");
}

// ============================================================== cleanup ===

const SPACE = /[\s  -   　]+/g;
const INVISIBLE = /[​-‍⁠﻿­]/g;

export function normalizeLine(s: string): string {
  return s.replace(INVISIBLE, "").replace(SPACE, " ").trim();
}

/** Short chrome lines that survive any markup: menus, share bars, cookie buttons. */
const BOILERPLATE =
  /^(share( this)?|chia sẻ|tweet|pin it|in bài|print|read more|đọc thêm|xem thêm|xem tiếp|advertisement|quảng cáo|sponsored|tài trợ|skip to (main )?content|bỏ qua nội dung|menu|trang chủ|home|đăng nhập|đăng ký|login|log in|sign in|sign up|subscribe|đăng ký nhận tin|accept( all)?( cookies)?|chấp nhận( tất cả)?|cookie settings|cài đặt cookie|back to top|lên đầu trang|previous|next|bài trước|bài sau|tags?:?|từ khóa:?|bình luận|comments?|facebook|twitter|zalo|copy link|sao chép link)[\s:.!»›>-]*$/i;

function isBoilerplate(line: string): boolean {
  const t = line.replace(/^[-#\s]+/, "");
  if (!/[\p{L}\p{N}]/u.test(t)) return true; // only symbols / punctuation
  return t.length <= 40 && BOILERPLATE.test(t);
}

/** Whitespace, duplicate lines, boilerplate and blank runs - nothing reworded. */
export function cleanupText(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (isBoilerplate(line)) continue;
    const key = line.replace(/^[-#\s]+/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

// ============================================================ structure ===

const DROP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "iframe", "canvas", "object", "embed", "button", "input", "select",
  "textarea", "option", "nav", "footer", "aside", "dialog", "menu", "head", "title", "link", "meta", "video", "audio", "map",
]);
const DROP_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog", "menu", "menubar", "toolbar"]);
const STRONG_NOISE = /(^|[\s_-])(cookies?|consent|gdpr|adsbygoogle|advert\w*|ads?|ad-?slot|sponsor\w*|popup|modal|newsletter|paywall|sr-only|visually-hidden|screen-reader\w*)($|[\s_-])/i;
const WEAK_NOISE = /(^|[\s_-])(share|sharing|social|related|comments?|sidebar|breadcrumbs?|menu|navbar|nav|footer|header|widget|recommend\w*|tags?|pagination|toolbar|subscribe|signup|login|promo\w*|author-box|byline-share)($|[\s_-])/i;
const PROTECTED = new Set(["#root", "html", "body", "main", "article"]);

function textLen(el: El): number {
  return normalizeLine(rawText(el)).length;
}

function linkDensity(el: El): number {
  const total = textLen(el);
  if (total === 0) return 0;
  let links = 0;
  for (const e of walk(el)) if (e.tag === "a") links += normalizeLine(rawText(e)).length;
  return links / total;
}

function containsMain(el: El): boolean {
  for (const e of walk(el)) if (e.tag === "article" || e.tag === "main" || e.attrs.role === "main") return true;
  return false;
}

function isHidden(el: El): boolean {
  if ("hidden" in el.attrs) return true;
  if (el.attrs["aria-hidden"] === "true") return true;
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.attrs.style ?? "");
}

/** Remove everything a reader would not call content. Mutates the tree. */
function stripNoise(root: El): void {
  const visit = (el: El) => {
    el.children = el.children.filter((c) => {
      if (typeof c === "string") return true;
      if (DROP_TAGS.has(c.tag) || isHidden(c) || DROP_ROLES.has(c.attrs.role ?? "")) return false;
      if (c.tag === "header" && !c.parent?.tag.match(/^(article|main)$/) && [...walk(c)].some((e) => e.tag === "nav")) return false;
      if (!PROTECTED.has(c.tag) && !containsMain(c)) {
        const label = `${c.attrs.class ?? ""} ${c.attrs.id ?? ""}`;
        if (STRONG_NOISE.test(label)) return false;
        const holdsTitle = [...walk(c)].some((e) => e.tag === "h1");
        if (WEAK_NOISE.test(label) && !holdsTitle && (linkDensity(c) > 0.4 || textLen(c) < 250)) return false;
      }
      visit(c);
      return true;
    });
  };
  visit(root);
}

const SCORED = new Set(["p", "pre", "blockquote", "li", "td", "dd"]);

/** The element holding the main text: article / main first, then readability-lite. */
function chooseRoot(body: El): { root: El; how: string } {
  const pick = (els: El[]) => els.sort((a, b) => textLen(b) - textLen(a))[0];
  const all = [...walk(body)];
  const articleBody = pick(all.filter((e) => e.attrs.itemprop === "articleBody"));
  if (articleBody && textLen(articleBody) >= 200) return { root: articleBody, how: "articleBody" };
  const article = pick(all.filter((e) => e.tag === "article"));
  if (article && textLen(article) >= 300) return { root: article, how: "article" };
  const main = pick(all.filter((e) => e.tag === "main" || e.attrs.role === "main"));
  if (main && textLen(main) >= 300) return { root: main, how: "main" };

  const scores = new Map<El, number>();
  for (const e of all) {
    if (!SCORED.has(e.tag)) continue;
    const len = textLen(e);
    if (len < 25 || linkDensity(e) > 0.5) continue;
    const parent = e.parent;
    if (parent) scores.set(parent, (scores.get(parent) ?? 0) + len);
    const grand = parent?.parent;
    if (grand) scores.set(grand, (scores.get(grand) ?? 0) + len / 2);
  }
  let best: El | null = null;
  let bestScore = 0;
  for (const [el, score] of scores) {
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best && bestScore >= 200 ? { root: best, how: "readability" } : { root: body, how: "body" };
}

type Block = { type: "heading"; level: number; text: string } | { type: "para"; text: string } | { type: "item"; text: string };

const BLOCK_TAGS = new Set([
  "address", "article", "blockquote", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "ol", "p", "pre", "section", "summary", "table", "tbody", "thead",
  "tfoot", "tr", "td", "th", "ul",
]);

function inlineText(el: El): string {
  const parts: string[] = [];
  const go = (n: Node) => {
    if (typeof n === "string") {
      parts.push(n);
      return;
    }
    if (n.tag === "br") {
      parts.push("\n");
      return;
    }
    if (n.tag === "img") {
      return;
    }
    for (const c of n.children) go(c);
    if (BLOCK_TAGS.has(n.tag)) parts.push(" ");
  };
  for (const c of el.children) go(c);
  return parts
    .join("")
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean)
    .join("\n");
}

function hasBlockChild(el: El): boolean {
  return el.children.some((c) => typeof c !== "string" && BLOCK_TAGS.has(c.tag));
}

function isMenuList(el: El): boolean {
  const items = el.children.filter((c): c is El => typeof c !== "string" && c.tag === "li");
  if (items.length < 3) return false;
  const avg = items.reduce((n, li) => n + textLen(li), 0) / items.length;
  return linkDensity(el) > 0.8 && avg < 40;
}

function tableBlocks(table: El): Block[] {
  const out: Block[] = [];
  for (const tr of walk(table)) {
    if (tr.tag !== "tr") continue;
    const cells = tr.children
      .filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th"))
      .map((c) => normalizeLine(inlineText(c).replace(/\n/g, " ")))
      .filter(Boolean);
    if (cells.length === 0) continue;
    // A two-column row is a spec: "Dung tích: 500 ml".
    out.push({ type: "item", text: cells.length === 2 ? `${cells[0]!.replace(/:$/, "")}: ${cells[1]}` : cells.join(" | ") });
  }
  return out;
}

function collectBlocks(el: El, out: Block[]): void {
  for (const c of el.children) {
    if (typeof c === "string") {
      const t = normalizeLine(c);
      if (t.length > 0 && hasBlockChild(el)) out.push({ type: "para", text: t });
      continue;
    }
    const tag = c.tag;
    if (/^h[1-6]$/.test(tag)) {
      const t = normalizeLine(inlineText(c).replace(/\n/g, " "));
      if (t) out.push({ type: "heading", level: Number(tag[1]), text: t });
    } else if (tag === "p" || tag === "blockquote" || tag === "pre" || tag === "figcaption" || tag === "address" || tag === "summary") {
      if (hasBlockChild(c) && tag !== "p") collectBlocks(c, out);
      else {
        const t = inlineText(c);
        if (t) out.push({ type: "para", text: t });
      }
    } else if (tag === "ul" || tag === "ol") {
      if (isMenuList(c)) continue;
      for (const li of c.children) {
        if (typeof li === "string" || li.tag !== "li") continue;
        const own: El = { ...li, children: li.children.filter((x) => typeof x === "string" || (x.tag !== "ul" && x.tag !== "ol")) };
        const t = normalizeLine(inlineText(own).replace(/\n/g, " "));
        if (t) out.push({ type: "item", text: t });
        const nested = li.children.filter((x): x is El => typeof x !== "string" && (x.tag === "ul" || x.tag === "ol"));
        for (const n of nested) collectBlocks({ ...li, children: [n] }, out);
      }
    } else if (tag === "table") {
      if (linkDensity(c) < 0.6) out.push(...tableBlocks(c));
    } else if (tag === "dl") {
      let term = "";
      for (const d of c.children) {
        if (typeof d === "string") continue;
        const t = normalizeLine(inlineText(d).replace(/\n/g, " "));
        if (d.tag === "dt") term = t;
        else if (d.tag === "dd" && t) {
          out.push({ type: "item", text: term ? `${term.replace(/:$/, "")}: ${t}` : t });
          term = "";
        }
      }
    } else if (hasBlockChild(c)) {
      collectBlocks(c, out);
    } else {
      const t = inlineText(c);
      if (t && (BLOCK_TAGS.has(tag) || hasBlockChild(el))) out.push({ type: "para", text: t });
      else if (t) out.push({ type: "para", text: t });
    }
  }
}

// ================================================================ meta ===

interface PageMeta {
  title: string;
  ogTitle: string;
  description: string;
  siteName: string;
  lang: string;
  ogType: string;
  image: string;
  author: string;
  published: string;
  price: string;
  currency: string;
  jsonld: Record<string, unknown>[];
}

function readMeta(doc: El): PageMeta {
  const meta: PageMeta = {
    title: "", ogTitle: "", description: "", siteName: "", lang: "", ogType: "", image: "", author: "", published: "", price: "",
    currency: "", jsonld: [],
  };
  let ogDescription = "";
  for (const e of walk(doc)) {
    if (e.tag === "html" && e.attrs.lang) meta.lang = e.attrs.lang;
    if (e.tag === "title" && !meta.title) meta.title = normalizeLine(rawText(e));
    if (e.tag === "meta") {
      const key = (e.attrs.property ?? e.attrs.name ?? e.attrs.itemprop ?? "").toLowerCase();
      const value = normalizeLine(e.attrs.content ?? "");
      if (!value) continue;
      if (key === "description" && !meta.description) meta.description = value;
      else if (key === "og:description") ogDescription = value;
      else if (key === "og:title" || key === "twitter:title") meta.ogTitle ||= value;
      else if (key === "og:site_name") meta.siteName = value;
      else if (key === "og:type") meta.ogType = value.toLowerCase();
      else if (key === "og:image" || key === "og:image:url") meta.image ||= value;
      else if (key === "author" || key === "article:author") meta.author ||= value;
      else if (key === "article:published_time" || key === "datepublished") meta.published ||= value;
      else if (key === "product:price:amount" || key === "og:price:amount") meta.price ||= value;
      else if (key === "product:price:currency" || key === "og:price:currency") meta.currency ||= value;
      else if (key === "og:locale" && !meta.lang) meta.lang = value;
    }
    if (e.tag === "script" && /ld\+json/i.test(e.attrs.type ?? "")) {
      const raw = rawText(e).replace(/^\s*(<!--|\/\/<!\[CDATA\[)/, "").replace(/(-->|\/\/\]\]>)\s*$/, "");
      try {
        const parsed = JSON.parse(raw) as unknown;
        const queue: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        while (queue.length) {
          const n = queue.shift();
          if (!n || typeof n !== "object") continue;
          const obj = n as Record<string, unknown>;
          if (Array.isArray(obj["@graph"])) queue.push(...(obj["@graph"] as unknown[]));
          meta.jsonld.push(obj);
        }
      } catch {
        // A broken JSON-LD block is simply not used.
      }
    }
  }
  meta.description ||= ogDescription;
  return meta;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
}

function str(v: unknown): string {
  if (typeof v === "string") return normalizeLine(decodeEntities(v));
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("name" in o) return str(o.name);
    if ("value" in o) return [str(o.value), str(o.unitText ?? o.unitCode)].filter(Boolean).join(" ");
  }
  return "";
}

const SCHEMA_AVAILABILITY: Record<string, { vi: string; en: string }> = {
  instock: { vi: "Còn hàng", en: "In stock" },
  outofstock: { vi: "Hết hàng", en: "Out of stock" },
  preorder: { vi: "Đặt trước", en: "Pre-order" },
  discontinued: { vi: "Ngừng kinh doanh", en: "Discontinued" },
  limitedavailability: { vi: "Số lượng có hạn", en: "Limited availability" },
};

function productFromJsonLd(nodes: Record<string, unknown>[], lang: "vi" | "en"): ProductFacts | null {
  const p = nodes.find((n) => typesOf(n).some((t) => t === "product" || t === "productgroup" || t === "individualproduct"));
  if (!p) return null;
  const specs: { name: string; value: string }[] = [];
  const add = (name: string, value: unknown) => {
    const v = str(value);
    if (v) specs.push({ name, value: v });
  };
  const L = lang === "vi"
    ? { sku: "Mã", model: "Model", color: "Màu", material: "Chất liệu", size: "Kích thước", weight: "Khối lượng", width: "Rộng", height: "Cao", depth: "Sâu", gtin: "GTIN" }
    : { sku: "SKU", model: "Model", color: "Color", material: "Material", size: "Size", weight: "Weight", width: "Width", height: "Height", depth: "Depth", gtin: "GTIN" };
  add(L.model, p.model);
  add(L.sku, p.sku);
  add(L.gtin, p.gtin13 ?? p.gtin ?? p.gtin12 ?? p.gtin8);
  add(L.color, p.color);
  add(L.material, p.material);
  add(L.size, p.size);
  add(L.weight, p.weight);
  add(L.width, p.width);
  add(L.height, p.height);
  add(L.depth, p.depth);
  const props = Array.isArray(p.additionalProperty) ? p.additionalProperty : p.additionalProperty ? [p.additionalProperty] : [];
  for (const prop of props as Record<string, unknown>[]) {
    const name = str(prop?.name);
    const value = [str(prop?.value), str(prop?.unitText)].filter(Boolean).join(" ");
    if (name && value) specs.push({ name, value });
  }
  const offersRaw = p.offers;
  const offer = (Array.isArray(offersRaw) ? offersRaw[0] : offersRaw) as Record<string, unknown> | undefined;
  const amount = str(offer?.price ?? offer?.lowPrice);
  const currency = str(offer?.priceCurrency);
  const availKey = str(offer?.availability).split("/").pop()?.toLowerCase() ?? "";
  const features = (Array.isArray(p.featureList) ? p.featureList : []).map(str).filter(Boolean);
  return {
    name: str(p.name),
    description: str(p.description),
    brand: str(p.brand),
    price: amount ? `${amount}${currency ? ` ${currency}` : ""}` : "",
    availability: SCHEMA_AVAILABILITY[availKey]?.[lang] ?? "",
    specs,
    features,
  };
}

function articleFromJsonLd(nodes: Record<string, unknown>[]): { headline: string; author: string; date: string; description: string } | null {
  const a = nodes.find((n) => typesOf(n).some((t) => /article|blogposting|reportage|techarticle|newsarticle/.test(t)));
  if (!a) return null;
  return { headline: str(a.headline ?? a.name), author: str(a.author), date: str(a.datePublished), description: str(a.description) };
}

// ============================================================ language ===

const VI_CHARS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi;

export function detectLanguage(declared: string, text: string): string {
  const primary = declared.toLowerCase().split(/[-_]/)[0] ?? "";
  if (/^[a-z]{2,3}$/.test(primary)) return primary;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < 20) return "";
  const vi = (text.match(VI_CHARS) ?? []).length;
  if (vi / letters > 0.02) return "vi";
  const ascii = (text.match(/[a-z]/gi) ?? []).length;
  return ascii / letters > 0.9 ? "en" : "";
}

// =============================================================== output ===

function labels(lang: string) {
  return lang === "vi"
    ? { product: "Sản phẩm", brand: "Thương hiệu", price: "Giá trên trang lúc đọc (có thể thay đổi)", stock: "Tình trạng", specs: "Thông số", features: "Tính năng", desc: "Mô tả", by: "Tác giả", date: "Ngày đăng" }
    : { product: "Product", brand: "Brand", price: "Price on the page when read (may change)", stock: "Availability", specs: "Specifications", features: "Features", desc: "Description", by: "Author", date: "Published" };
}

function jsHeavy(doc: El, html: string): boolean {
  let scripts = 0;
  for (const e of walk(doc)) {
    if (e.tag === "script") scripts += 1;
    const id = (e.attrs.id ?? "").toLowerCase();
    if (["root", "app", "__next", "__nuxt", "svelte"].includes(id) && textLen(e) < 50) return true;
    if ("ng-app" in e.attrs || "data-reactroot" in e.attrs) return true;
  }
  return scripts >= 5 || /enable javascript|bật javascript|requires javascript|cần javascript/i.test(html);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Assemble lines up to the cap: header first, then body blocks in order. */
function assemble(head: string[], blocks: Block[]): { text: string; truncated: boolean } {
  const lines = [...head];
  let truncated = false;
  let size = cleanupText(lines.join("\n")).length;
  for (const b of blocks) {
    const line = b.type === "heading" ? `${b.level <= 2 ? "##" : "###"} ${b.text}` : b.type === "item" ? `- ${b.text}` : b.text;
    const extra = line.length + (b.type === "heading" ? 2 : 1);
    if (size + extra > MAX_EXTRACT_CHARS) {
      truncated = true;
      break;
    }
    if (b.type === "heading") lines.push("");
    lines.push(line);
    size += extra;
  }
  return { text: cleanupText(lines.join("\n")), truncated };
}

/** Extract an HTML page. Throws ExtractError when there is nothing to read. */
export function extractHtml(html: string, pageUrl: string): ExtractedPage {
  const doc = parseHtml(html);
  const meta = readMeta(doc);
  const heavy = jsHeavy(doc, html);
  const body = [...walk(doc)].find((e) => e.tag === "body") ?? doc;
  stripNoise(body);
  const { root, how } = chooseRoot(body);
  const blocks: Block[] = [];
  collectBlocks(root, blocks);

  const bodyText = blocks.map((b) => b.text).join("\n");
  const lang = detectLanguage(meta.lang, `${meta.title} ${meta.description} ${bodyText}`);
  const L = labels(lang);
  const product = productFromJsonLd(meta.jsonld, lang === "vi" ? "vi" : "en");
  const article = articleFromJsonLd(meta.jsonld);
  if (product && !product.price && meta.price) product.price = `${meta.price}${meta.currency ? ` ${meta.currency}` : ""}`;
  const kind: PageKind = product || meta.ogType === "product" || meta.ogType === "og:product" ? "PRODUCT" : article || meta.ogType === "article" || how === "article" || how === "articleBody" ? "ARTICLE" : "PAGE";

  // The h1 is usually the cleanest title; the <title> often carries " | Site".
  const h1 = blocks.find((b) => b.type === "heading" && b.level === 1)?.text ?? "";
  const title = normalizeLine(article?.headline || product?.name || h1 || meta.ogTitle || meta.title || "");
  const description = normalizeLine(meta.description || article?.description || product?.description || "");
  const author = normalizeLine(article?.author || meta.author || "");
  const publishedAt = normalizeLine(article?.date || meta.published || "");

  const head: string[] = [];
  if (title) head.push(`# ${title}`);
  if (author) head.push(`${L.by}: ${author}`);
  if (publishedAt) head.push(`${L.date}: ${publishedAt.slice(0, 10)}`);
  const bodyStart = blocks.slice(0, 6).map((b) => b.text.toLowerCase()).join(" ");
  if (description && !bodyStart.includes(description.toLowerCase().slice(0, 60))) head.push("", description);
  const productHasFacts = Boolean(product && (product.specs.length || product.features.length || product.price || product.description || product.brand));
  if (product) {
    head.push("", `## ${L.product}: ${product.name || title}`);
    if (product.brand) head.push(`- ${L.brand}: ${product.brand}`);
    if (product.price) head.push(`- ${L.price}: ${product.price}`);
    if (product.availability) head.push(`- ${L.stock}: ${product.availability}`);
    if (product.description && product.description !== description) head.push(`- ${L.desc}: ${product.description}`);
    if (product.features.length) head.push("", `## ${L.features}`, ...product.features.map((f) => `- ${f}`));
    if (product.specs.length) head.push("", `## ${L.specs}`, ...product.specs.map((s) => `- ${s.name}: ${s.value}`));
  }
  // The page's h1 is already the title line.
  const bodyBlocks = blocks.filter((b) => !(b.type === "heading" && b.level === 1 && b.text === title));
  const useful = bodyBlocks.map((b) => b.text).join("\n").length;
  if (useful < MIN_USEFUL_CHARS && !productHasFacts) {
    if (heavy) {
      throw new ExtractError("NEEDS_BROWSER", "Trang này cần trình duyệt để tải nội dung và hiện chưa hỗ trợ trực tiếp. Hãy mở trang, sao chép nội dung và dùng nguồn \"Dán nội dung\".");
    }
    if (description.length < 80) {
      throw new ExtractError("NO_READABLE_CONTENT", "Trang không có nội dung chữ đọc được (có thể chỉ có ảnh, video hoặc form). Hãy dùng nguồn \"Dán nội dung\".");
    }
  }

  const { text, truncated } = assemble(head, bodyBlocks);
  let image = "";
  try {
    image = meta.image ? new URL(meta.image, pageUrl).href : "";
  } catch {
    image = "";
  }
  return {
    kind,
    title,
    description,
    siteName: meta.siteName,
    language: lang,
    author,
    publishedAt,
    imageUrl: image,
    product,
    text,
    contentLength: text.length,
    truncated,
    method: `${meta.jsonld.length ? "jsonld+" : ""}${how}`,
    contentHash: sha256(text),
  };
}

/** A text/plain page: cleanup only. */
export function extractPlainText(body: string): ExtractedPage {
  const cleaned = cleanupText(body);
  const capped = cleaned.length > MAX_EXTRACT_CHARS ? cleaned.slice(0, cleaned.lastIndexOf("\n", MAX_EXTRACT_CHARS) > 0 ? cleaned.lastIndexOf("\n", MAX_EXTRACT_CHARS) : MAX_EXTRACT_CHARS) : cleaned;
  if (capped.length < MIN_USEFUL_CHARS) {
    throw new ExtractError("NO_READABLE_CONTENT", "Trang gần như không có chữ để dùng làm nội dung.");
  }
  const first = capped.split("\n")[0] ?? "";
  return {
    kind: "PAGE",
    title: first.length <= 120 ? first : "",
    description: "",
    siteName: "",
    language: detectLanguage("", capped),
    author: "",
    publishedAt: "",
    imageUrl: "",
    product: null,
    text: capped,
    contentLength: capped.length,
    truncated: capped.length < cleaned.length,
    method: "plain-text",
    contentHash: sha256(capped),
  };
}

export function contentHashOf(text: string): string {
  return sha256(text);
}
