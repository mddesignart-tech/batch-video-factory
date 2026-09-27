import fs from "node:fs";
import type { Asset } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { parseJson, round } from "@/lib/utils";

/**
 * THE ASSET LIBRARY (V1.2 Phase 5, QĐ-113): every stored asset, where it is
 * used, what it was made from, and whether it is still what it claims to be.
 *
 * Reads the database and the local disk only - never a provider API. Nothing
 * here writes, deletes or re-hashes: the list uses the validity recorded by the
 * last backfill/health scan plus a cheap "is the file there" check, so opening
 * the page stays fast however many assets there are.
 *
 * Reference = something that USES the stored file right now: a scene's picture /
 * clip / audio, a dialogue line, a project's final MP4, a character sheet image.
 * An asset nobody uses is an ORPHAN_CANDIDATE - reported, never deleted here.
 */

export type AssetType = "IMAGE" | "VIDEO" | "AUDIO" | "LOCAL";
export type AssetSourceLabel = "IMPORTED" | "GENERATED" | "REUSED" | "LOCAL";
export type AssetHealth = "HEALTHY" | "MISSING" | "INVALID" | "LEGACY_UNVERIFIED" | "ORPHAN_CANDIDATE";

export type ReferenceKind =
  | "SCENE_IMAGE"
  | "SCENE_VIDEO"
  | "SCENE_AUDIO"
  | "DIALOGUE_LINE"
  | "PROJECT_FINAL"
  | "CHARACTER_REFERENCE";

export interface AssetReference {
  kind: ReferenceKind;
  projectId: string | null;
  projectTitle: string | null;
  sceneId: string | null;
  sceneNumber: number | null;
  /** Human label, Vietnamese. */
  label: string;
}

export interface LibraryRow {
  id: string;
  type: AssetType;
  kind: string;
  source: AssetSourceLabel;
  status: string;
  provider: string | null;
  model: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  bytes: number;
  mimeType: string | null;
  sha256: string | null;
  reuseKey: string | null;
  /** Where a reuse key lets this asset be matched: GLOBAL / PROJECT / SCENE (policy), or NONE. */
  reuseScope: "KEYED" | "CONTENT_ONLY" | "SCENE_ONLY" | "NONE";
  legacyState: string | null;
  validity: string;
  health: AssetHealth;
  orphan: boolean;
  legacy: boolean;
  references: AssetReference[];
  referenceCount: number;
  projectId: string;
  projectTitle: string | null;
  sceneId: string | null;
  sceneNumber: number | null;
  createdAt: Date;
  lastUsedAt: Date;
  filePath: string;
  originalFilename: string | null;
  reusedFromAssetId: string | null;
  actualCost: number;
}

export function assetType(kind: string, provider: string): AssetType {
  if (kind === "final" || provider === "ffmpeg") return "LOCAL";
  if (kind === "video") return "VIDEO";
  if (kind === "audio") return "AUDIO";
  return "IMAGE";
}

export function assetSource(a: Pick<Asset, "source" | "provider" | "kind">): AssetSourceLabel {
  if (a.source === "IMPORTED") return "IMPORTED";
  if (a.source === "REUSED") return "REUSED";
  if (a.kind === "final" || a.provider === "ffmpeg") return "LOCAL";
  return "GENERATED";
}

const norm = (p: string | null | undefined): string => (p ?? "").split("\\").join("/").trim();

interface Index {
  assets: Asset[];
  byPath: Map<string, AssetReference[]>;
  byImageAssetId: Map<string, AssetReference[]>;
  projectTitle: Map<string, string>;
  projectUpdated: Map<string, Date>;
  sceneNumber: Map<string, number>;
  /**
   * Path -> the NEWEST non-reuse row stored under it. When a line is made again
   * under the same file name, the bytes on disk (and so the scene's use of
   * them) belong to the newest row; older rows describe content that is gone.
   */
  pathOwner: Map<string, string>;
}

async function loadIndex(where: { assetIds?: string[] } = {}): Promise<Index> {
  const [assets, scenes, lines, projects, refs] = await Promise.all([
    prisma.asset.findMany({
      where: where.assetIds ? { id: { in: where.assetIds } } : undefined,
      orderBy: { createdAt: "desc" },
    }),
    prisma.scene.findMany({
      select: {
        id: true, projectId: true, sceneNumber: true, imagePath: true, videoPath: true,
        audioPath: true, imageAssetId: true, skipped: true,
      },
    }),
    prisma.dialogueLine.findMany({
      select: { sceneId: true, lineNumber: true, outputPath: true, status: true },
    }),
    prisma.project.findMany({ select: { id: true, title: true, finalVideoPath: true, updatedAt: true } }),
    prisma.characterReference.findMany({
      select: { filePath: true, characterVersion: true, character: { select: { name: true } } },
    }),
  ]);
  const projectTitle = new Map(projects.map((p) => [p.id, p.title]));
  const projectUpdated = new Map(projects.map((p) => [p.id, p.updatedAt]));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const sceneNumber = new Map(scenes.map((s) => [s.id, s.sceneNumber]));
  const byPath = new Map<string, AssetReference[]>();
  const push = (p: string | null | undefined, ref: AssetReference) => {
    const k = norm(p);
    if (!k) return;
    const list = byPath.get(k) ?? [];
    list.push(ref);
    byPath.set(k, list);
  };
  const sceneRef = (s: (typeof scenes)[number], kind: ReferenceKind, what: string): AssetReference => ({
    kind,
    projectId: s.projectId,
    projectTitle: projectTitle.get(s.projectId) ?? null,
    sceneId: s.id,
    sceneNumber: s.sceneNumber,
    label: `${projectTitle.get(s.projectId) ?? "?"} · cảnh ${s.sceneNumber} · ${what}${s.skipped ? " (cảnh bị bỏ qua)" : ""}`,
  });
  const byImageAssetId = new Map<string, AssetReference[]>();
  for (const s of scenes) {
    push(s.imagePath, sceneRef(s, "SCENE_IMAGE", "ảnh"));
    push(s.videoPath, sceneRef(s, "SCENE_VIDEO", "clip"));
    push(s.audioPath, sceneRef(s, "SCENE_AUDIO", "audio"));
    // An imported picture's scene may show a framed working copy; the scene
    // still uses the imported original through imageAssetId.
    if (s.imageAssetId && norm(s.imagePath) !== "") {
      const list = byImageAssetId.get(s.imageAssetId) ?? [];
      list.push(sceneRef(s, "SCENE_IMAGE", "ảnh nhập (bản gốc)"));
      byImageAssetId.set(s.imageAssetId, list);
    }
  }
  for (const l of lines) {
    const s = sceneById.get(l.sceneId);
    if (!s || !l.outputPath) continue;
    push(l.outputPath, { ...sceneRef(s, "DIALOGUE_LINE", `lời thoại ${l.lineNumber}`), kind: "DIALOGUE_LINE" });
  }
  for (const p of projects) {
    push(p.finalVideoPath, {
      kind: "PROJECT_FINAL",
      projectId: p.id,
      projectTitle: p.title,
      sceneId: null,
      sceneNumber: null,
      label: `${p.title} · MP4 cuối`,
    });
  }
  for (const r of refs) {
    push(r.filePath, {
      kind: "CHARACTER_REFERENCE",
      projectId: null,
      projectTitle: null,
      sceneId: null,
      sceneNumber: null,
      label: `Nhân vật ${r.character.name} · ảnh tham chiếu v${r.characterVersion}`,
    });
  }
  const pathOwner = new Map<string, string>();
  const ownerDate = new Map<string, Date>();
  for (const a of assets) {
    if (a.source === "REUSED") continue;
    const k = norm(a.filePath);
    const prev = ownerDate.get(k);
    if (!prev || prev <= a.createdAt) {
      pathOwner.set(k, a.id);
      ownerDate.set(k, a.createdAt);
    }
  }
  return { assets, byPath, byImageAssetId, projectTitle, projectUpdated, sceneNumber, pathOwner };
}

function referencesOf(a: Asset, idx: Index): AssetReference[] {
  const out: AssetReference[] = [];
  const seen = new Set<string>();
  // A reuse row shares its source's file on purpose; any other row only owns the
  // path's uses when it is the newest row stored under that path.
  const ownsPath = a.source === "REUSED" || idx.pathOwner.get(norm(a.filePath)) === a.id;
  const viaPath = ownsPath ? (idx.byPath.get(norm(a.filePath)) ?? []) : [];
  for (const r of [...viaPath, ...(idx.byImageAssetId.get(a.id) ?? [])]) {
    // A scene may reach one file twice (its path AND imageAssetId) - count it once.
    const k = `${r.kind === "DIALOGUE_LINE" ? r.label : r.kind}|${r.sceneId ?? r.label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Is the file there? Cheap: existence + size when the size is known. No hashing. */
function quickValidity(a: Asset): string {
  let abs: string;
  try {
    abs = toAbsolute(a.filePath);
  } catch {
    return "INVALID";
  }
  if (!fs.existsSync(abs)) return "MISSING_LOCAL_FILE";
  if (a.validity !== "VALID") return a.validity;
  try {
    const size = fs.statSync(abs).size;
    if (size === 0) return "INVALID";
    if (a.sha256 && a.bytes > 0 && size !== a.bytes) return "INVALID";
  } catch {
    return "MISSING_LOCAL_FILE";
  }
  return "VALID";
}

export function healthOf(validity: string, legacy: boolean, orphan: boolean): AssetHealth {
  if (validity === "MISSING_LOCAL_FILE") return "MISSING";
  if (validity === "INVALID") return "INVALID";
  if (legacy) return "LEGACY_UNVERIFIED";
  if (orphan) return "ORPHAN_CANDIDATE";
  return "HEALTHY";
}

function reuseScopeOf(a: Asset): LibraryRow["reuseScope"] {
  if (a.reuseKey) return "KEYED";
  if (a.source === "IMPORTED" && a.sha256) return "CONTENT_ONLY";
  if (a.legacyState === "LEGACY_UNVERIFIED") return "SCENE_ONLY";
  return "NONE";
}

function toRow(a: Asset, idx: Index, reuseChildren: Map<string, Date>): LibraryRow {
  const references = referencesOf(a, idx);
  const validity = quickValidity(a);
  const legacy = a.legacyState === "LEGACY_UNVERIFIED";
  const orphan = references.length === 0;
  const touched = [a.createdAt, reuseChildren.get(a.id), ...references.map((r) => (r.projectId ? idx.projectUpdated.get(r.projectId) : undefined))]
    .filter((d): d is Date => d instanceof Date);
  const imported = a.source === "IMPORTED";
  return {
    id: a.id,
    type: assetType(a.kind, a.provider),
    kind: a.kind,
    source: assetSource(a),
    status: a.status,
    provider: imported ? null : a.provider || null,
    model: imported ? null : a.model || null,
    width: a.width,
    height: a.height,
    durationSec: a.durationSec,
    bytes: a.bytes,
    mimeType: a.mimeType,
    sha256: a.sha256,
    reuseKey: a.reuseKey,
    reuseScope: reuseScopeOf(a),
    legacyState: a.legacyState,
    validity,
    health: healthOf(validity, legacy, orphan),
    orphan,
    legacy,
    references,
    referenceCount: references.length,
    projectId: a.projectId,
    projectTitle: idx.projectTitle.get(a.projectId) ?? null,
    sceneId: a.sceneId,
    sceneNumber: a.sceneId ? (idx.sceneNumber.get(a.sceneId) ?? null) : null,
    createdAt: a.createdAt,
    lastUsedAt: new Date(Math.max(...touched.map((d) => d.getTime()))),
    filePath: a.filePath,
    originalFilename: a.originalFilename,
    reusedFromAssetId: a.reusedFromAssetId,
    actualCost: a.actualCost,
  };
}

async function reuseChildDates(): Promise<Map<string, Date>> {
  const rows = await prisma.asset.findMany({
    where: { reusedFromAssetId: { not: null } },
    select: { reusedFromAssetId: true, createdAt: true },
  });
  const out = new Map<string, Date>();
  for (const r of rows) {
    const prev = out.get(r.reusedFromAssetId!);
    if (!prev || prev < r.createdAt) out.set(r.reusedFromAssetId!, r.createdAt);
  }
  return out;
}

// ------------------------------------------------------------ public API ---

export interface LibraryFilter {
  q?: string;
  type?: AssetType | "";
  source?: AssetSourceLabel | "";
  provider?: string;
  projectId?: string;
  status?: string;
  reuseScope?: LibraryRow["reuseScope"] | "";
  /** MISSING / INVALID / LEGACY / ORPHAN / HEALTHY */
  health?: string;
}

export interface LibrarySummary {
  assets: number;
  healthy: number;
  missing: number;
  invalid: number;
  legacyUnverified: number;
  orphanCandidates: number;
  /** Money reuse did not spend: the original price of every asset a REUSED row points at. */
  apiCostSaved: number;
  /** Bytes not stored twice: REUSED rows sharing the source's file or hard-linked to it. */
  storageDeduplicatedBytes: number;
  /** Reuses of $0 things (imported / local) - saved work, not dollars. */
  zeroCostReuses: number;
}

export function matchesFilter(r: LibraryRow, f: LibraryFilter): boolean {
  if (f.type && r.type !== f.type) return false;
  if (f.source && r.source !== f.source) return false;
  if (f.provider && (r.provider ?? "") !== f.provider) return false;
  if (f.projectId && r.projectId !== f.projectId && !r.references.some((x) => x.projectId === f.projectId)) return false;
  if (f.status && r.status !== f.status) return false;
  if (f.reuseScope && r.reuseScope !== f.reuseScope) return false;
  if (f.health) {
    const h = f.health.toUpperCase();
    if (h === "MISSING" && r.health !== "MISSING") return false;
    if (h === "INVALID" && r.health !== "INVALID") return false;
    if (h === "LEGACY" && !r.legacy) return false;
    if (h === "ORPHAN" && !r.orphan) return false;
    if (h === "HEALTHY" && r.health !== "HEALTHY") return false;
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [r.id, r.sha256, r.reuseKey, r.originalFilename, r.filePath, r.projectTitle, r.model, r.provider]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export async function listLibrary(filter: LibraryFilter = {}): Promise<{ rows: LibraryRow[]; summary: LibrarySummary }> {
  const idx = await loadIndex();
  const children = await reuseChildDates();
  const all = idx.assets.map((a) => toRow(a, idx, children));
  return { rows: all.filter((r) => matchesFilter(r, filter)), summary: summarize(all, idx.assets) };
}

function inodeOf(rel: string): string | null {
  try {
    const st = fs.statSync(toAbsolute(rel));
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

export function summarize(rows: LibraryRow[], assets: Asset[]): LibrarySummary {
  const byId = new Map(assets.map((a) => [a.id, a]));
  let apiCostSaved = 0;
  let dedup = 0;
  let zeroCost = 0;
  for (const a of assets) {
    if (a.source !== "REUSED" || !a.reusedFromAssetId) continue;
    const src = byId.get(a.reusedFromAssetId);
    const price = src?.actualCost ?? 0;
    if (price > 0) apiCostSaved += price;
    else zeroCost += 1;
    if (src) {
      const same = norm(src.filePath) === norm(a.filePath);
      const ino = !same ? inodeOf(a.filePath) : null;
      if (same || (ino !== null && ino === inodeOf(src.filePath))) dedup += a.bytes || src.bytes;
    }
  }
  return {
    assets: rows.length,
    healthy: rows.filter((r) => r.health === "HEALTHY").length,
    missing: rows.filter((r) => r.health === "MISSING").length,
    invalid: rows.filter((r) => r.health === "INVALID").length,
    legacyUnverified: rows.filter((r) => r.legacy).length,
    orphanCandidates: rows.filter((r) => r.orphan).length,
    apiCostSaved: round(apiCostSaved, 6),
    storageDeduplicatedBytes: dedup,
    zeroCostReuses: zeroCost,
  };
}

/** Everything that uses this asset's file right now. */
export async function getAssetReferences(assetId: string): Promise<AssetReference[]> {
  const idx = await loadIndex();
  const a = idx.assets.find((x) => x.id === assetId);
  return a ? referencesOf(a, idx) : [];
}

export interface AssetLink {
  assetId: string;
  kind: string;
  projectId: string;
  projectTitle: string | null;
  sceneNumber: number | null;
  /** RECORDED = written down when it was made; REUSE = a reuse row; STRUCTURE = same scene, by how the pipeline works. */
  basis: "RECORDED" | "REUSE" | "STRUCTURE";
  note: string;
}

interface Inputs {
  keyframe?: string;
  references?: string[];
  media?: string[];
}

function inputsOf(a: Asset): Inputs {
  return parseJson<Inputs>(a.inputsJson, {});
}

const describe = (a: Asset, idx: Index, basis: AssetLink["basis"], note: string): AssetLink => ({
  assetId: a.id,
  kind: a.kind,
  projectId: a.projectId,
  projectTitle: idx.projectTitle.get(a.projectId) ?? null,
  sceneNumber: a.sceneId ? (idx.sceneNumber.get(a.sceneId) ?? null) : null,
  basis,
  note,
});

/**
 * Assets built FROM this one: clips whose keyframe was this picture, finals that
 * rendered this media, pictures drawn from this reference, and REUSED rows
 * pointing at it. By content hash where it was recorded; for a legacy clip, the
 * picture of the same scene (how image-to-video works), marked STRUCTURE.
 */
export async function getAssetDependents(assetId: string): Promise<AssetLink[]> {
  const idx = await loadIndex();
  const a = idx.assets.find((x) => x.id === assetId);
  if (!a) return [];
  const out: AssetLink[] = [];
  for (const b of idx.assets) {
    if (b.id === a.id) continue;
    if (b.reusedFromAssetId === a.id) {
      out.push(describe(b, idx, "REUSE", "dùng lại asset này ($0)"));
      continue;
    }
    if (!a.sha256) continue;
    const inp = inputsOf(b);
    if (inp.keyframe === a.sha256) out.push(describe(b, idx, "RECORDED", "clip dựng từ ảnh này"));
    else if (inp.references?.includes(a.sha256)) out.push(describe(b, idx, "RECORDED", "ảnh vẽ theo tham chiếu này"));
    else if (inp.media?.includes(a.sha256)) out.push(describe(b, idx, "RECORDED", "MP4 cuối dùng media này"));
  }
  if (a.kind === "image" && a.sceneId) {
    for (const b of idx.assets) {
      if (b.kind === "video" && b.sceneId === a.sceneId && !inputsOf(b).keyframe && !out.some((o) => o.assetId === b.id)) {
        out.push(describe(b, idx, "STRUCTURE", "clip cùng cảnh (asset cũ, không ghi keyframe)"));
      }
    }
  }
  return out;
}

/** What this asset was built from - the reverse of getAssetDependents. */
export async function getAssetDependencies(assetId: string): Promise<AssetLink[]> {
  const idx = await loadIndex();
  const a = idx.assets.find((x) => x.id === assetId);
  if (!a) return [];
  const out: AssetLink[] = [];
  const inp = inputsOf(a);
  const wanted = new Set([inp.keyframe, ...(inp.references ?? []), ...(inp.media ?? [])].filter(Boolean) as string[]);
  // One content can have several rows (reuses, re-imports, an older row under the
  // same name). Name the one that OWNS those bytes: an original (not a reuse),
  // VALID, the current owner of its path; the oldest such row on a tie.
  const rank = (b: Asset) =>
    (b.source === "REUSED" ? 4 : 0) +
    (b.validity === "VALID" ? 0 : 2) +
    (idx.pathOwner.get(norm(b.filePath)) === b.id ? 0 : 1);
  const bySha = new Map<string, Asset>();
  for (const b of [...idx.assets].reverse()) {
    if (!b.sha256) continue;
    const cur = bySha.get(b.sha256);
    if (!cur || rank(b) < rank(cur)) bySha.set(b.sha256, b);
  }
  for (const sha of wanted) {
    const b = bySha.get(sha);
    if (b && b.id !== a.id) out.push(describe(b, idx, "RECORDED", sha === inp.keyframe ? "keyframe" : "đầu vào"));
  }
  if (a.reusedFromAssetId) {
    const src = idx.assets.find((x) => x.id === a.reusedFromAssetId);
    if (src) out.push(describe(src, idx, "REUSE", "bản gốc được dùng lại"));
  }
  if (a.kind === "video" && !inp.keyframe && a.sceneId) {
    for (const b of idx.assets) {
      if (b.kind === "image" && b.sceneId === a.sceneId) out.push(describe(b, idx, "STRUCTURE", "ảnh cùng cảnh (asset cũ)"));
    }
  }
  return out;
}

export interface AssetDetail {
  row: LibraryRow;
  dependents: AssetLink[];
  dependencies: AssetLink[];
  /** Original price with its ledger line when one matches; null without evidence. */
  originalCost: { amount: number; costEntryId: string | null; evidence: string } | null;
  /** A reuse of this asset now costs $0 - always. */
  incrementalReuseCost: 0;
  characterVersions: string[];
  inputs: Record<string, unknown>;
}

const LEDGER_CATEGORY: Record<string, string[]> = {
  image: ["image"],
  video: ["video"],
  audio: ["voice", "audio"],
};

export async function getAssetDetail(assetId: string): Promise<AssetDetail | null> {
  const idx = await loadIndex();
  const a = idx.assets.find((x) => x.id === assetId);
  if (!a) return null;
  const row = toRow(a, idx, await reuseChildDates());

  // The price is what the asset row recorded when it was bought; it is shown
  // with the ledger line it matches, or as "no ledger evidence" - never guessed.
  let originalCost: AssetDetail["originalCost"] = null;
  const origin = a.source === "REUSED" && a.reusedFromAssetId
    ? (idx.assets.find((x) => x.id === a.reusedFromAssetId) ?? null)
    : a;
  if (origin && origin.source === "GENERATED" && origin.actualCost > 0) {
    const entry = await prisma.costEntry.findFirst({
      where: {
        estimated: false,
        projectId: origin.projectId,
        sceneId: origin.sceneId,
        provider: origin.provider,
        model: origin.model,
        category: { in: LEDGER_CATEGORY[origin.kind] ?? [origin.kind] },
        amount: { gte: origin.actualCost - 1e-9, lte: origin.actualCost + 1e-9 },
      },
      orderBy: { createdAt: "asc" },
    });
    originalCost = {
      amount: origin.actualCost,
      costEntryId: entry?.id ?? null,
      evidence: entry ? "khớp một dòng sổ chi (CostEntry)" : "ghi trên asset; không tìm thấy dòng sổ chi khớp",
    };
  } else if (origin && (origin.source === "IMPORTED" || origin.kind === "final")) {
    originalCost = { amount: 0, costEntryId: null, evidence: origin.source === "IMPORTED" ? "ảnh nhập — $0" : "FFmpeg tại máy — $0" };
  }

  // Recorded at creation for pictures made since QĐ-113 ("Max@2"); older rows have none.
  const characterVersions = parseJson<{ characters?: string[] }>(a.inputsJson, {}).characters ?? [];

  return {
    row,
    dependents: await getAssetDependents(assetId),
    dependencies: await getAssetDependencies(assetId),
    originalCost,
    incrementalReuseCost: 0,
    characterVersions,
    inputs: parseJson<Record<string, unknown>>(a.inputsJson, {}),
  };
}

/** A key or hash, shortened for display: first 10 + last 6. */
export function shortHash(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

/** Library-relative path for display: never an absolute path of this machine. */
export function displayPath(rel: string): string {
  return `data/${norm(rel)}`;
}
