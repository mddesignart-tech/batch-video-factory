import fs from "node:fs";
import path from "node:path";
import type { Asset } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { contentInfo, type ContentInfo } from "./asset-content";
import { voiceReuseKey } from "./asset-keys";

/**
 * LEGACY ASSET BACKFILL (V1.2 Phase 5, QĐ-113).
 *
 * Assets made before reuse keys existed (Phase 4) get what can be MEASURED -
 * SHA-256, size, MIME, width/height, duration - and a reuse key ONLY when the
 * inputs that made them are on record. A key is never invented:
 *
 *   audio   the DialogueLine that produced the file recorded, at generation
 *           time, the spoken text, provider, model, voice, instructions and
 *           speed - everything the (real) voice key is made of. Same file path,
 *           same text, same provider/model -> LEGACY_BACKFILLED with that key.
 *           (A MOCK line's key also includes the scene length it was made for,
 *           which is not recorded -> unverified.)
 *   image   the reference images' content and character versions sent were
 *           never recorded -> LEGACY_UNVERIFIED.
 *   video   the keyframe's content hash was never recorded -> LEGACY_UNVERIFIED.
 *   final   the render inputs were never recorded -> LEGACY_UNVERIFIED.
 *
 * LEGACY_UNVERIFIED: the asset stays exactly where it is and its own scene keeps
 * using it; it has no key, so the reuse engine can never hand it to another
 * scene "because the file looks the same". Provider/model are shown as the row
 * recorded them - nothing is inferred.
 *
 * Validity: missing file -> MISSING_LOCAL_FILE; bytes that no longer match the
 * recorded hash, or media ffprobe cannot read -> INVALID.
 *
 * Safety: updates Asset metadata columns only. Never creates or deletes a row,
 * never touches CostEntry, ProviderJob, reservations, spend or scene routing.
 * Idempotent: a second run over unchanged files changes nothing.
 */

export type LegacyState = "LEGACY_BACKFILLED" | "LEGACY_UNVERIFIED";

export interface BackfillRowResult {
  assetId: string;
  kind: string;
  action: "UNCHANGED" | "UPDATED";
  legacyState: string | null;
  validity: string;
  keyed: "EXISTING" | "BACKFILLED" | "REKEYED" | "NONE";
  reason: string;
}

export interface BackfillReport {
  scanned: number;
  updated: number;
  unchanged: number;
  backfilled: number;
  rekeyed: number;
  legacyUnverified: number;
  missing: number;
  invalid: number;
  /** Same bytes stored under different names: recognised as ONE content. */
  contentDuplicateGroups: number;
  /** Same file name, different bytes: NOT merged. */
  sameNameDifferentContent: number;
  rows: BackfillRowResult[];
}

const norm = (p: string) => p.split("\\").join("/");

type Patch = Partial<
  Pick<Asset, "sha256" | "bytes" | "mimeType" | "width" | "height" | "durationSec" | "validity" | "reuseKey" | "legacyState">
>;

function diff(a: Asset, want: Patch): Patch {
  const out: Patch = {};
  for (const [k, v] of Object.entries(want) as [keyof Patch, unknown][]) {
    if (v === undefined) continue;
    const cur = a[k] as unknown;
    const same = typeof v === "number" && typeof cur === "number" ? Math.abs(v - cur) < 1e-6 : cur === v;
    if (!same) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Evidence for an audio key: the DialogueLine that wrote this very file. */
async function audioKeyFromEvidence(a: Asset): Promise<{ key: string | null; reason: string }> {
  if (a.provider === "mock") {
    return { key: null, reason: "giọng mock phụ thuộc độ dài cảnh lúc tạo, không được ghi lại" };
  }
  const lines = await prisma.dialogueLine.findMany({ where: { sceneId: a.sceneId ?? "__none__" } });
  const line = lines.find((l) => l.outputPath && norm(l.outputPath) === norm(a.filePath));
  if (!line) return { key: null, reason: "không có dòng thoại nào ghi lại file này" };
  if (line.status !== "completed") return { key: null, reason: "dòng thoại chưa hoàn tất" };
  if (line.text !== a.prompt) return { key: null, reason: "lời thoại hiện tại khác lời đã đọc trong file" };
  if (line.provider !== a.provider || line.model !== a.model) {
    return { key: null, reason: "provider/model của dòng thoại khác asset" };
  }
  if (!line.voiceId) return { key: null, reason: "không ghi lại voice" };
  return {
    key: voiceReuseKey({
      provider: line.provider,
      model: line.model,
      text: line.text,
      voiceId: line.voiceId,
      instructions: line.instructions,
      speed: line.speed,
    }),
    reason: "dựng lại từ DialogueLine (text, voice, instructions, speed, provider, model đã ghi khi tạo)",
  };
}

const UNPROVABLE: Record<string, string> = {
  image: "không ghi lại nội dung ảnh tham chiếu / phiên bản nhân vật đã gửi",
  video: "không ghi lại nội dung keyframe đã gửi",
  final: "không ghi lại đầu vào render",
};

export async function backfillLegacyAssets(opts: { apply: boolean; probe?: (abs: string) => Promise<ContentInfo> }): Promise<BackfillReport> {
  const probe = opts.probe ?? contentInfo;
  const assets = await prisma.asset.findMany({ orderBy: { createdAt: "asc" } });

  // Rows of one project that share one path (a line re-generated into the same
  // file name). Only the NEWEST can claim the bytes now on disk.
  const newestForPath = new Map<string, Asset>();
  for (const a of assets) {
    if (a.source === "REUSED") continue;
    const k = `${a.kind}|${norm(a.filePath)}`;
    const prev = newestForPath.get(k);
    if (!prev || prev.createdAt <= a.createdAt) newestForPath.set(k, a);
  }

  const report: BackfillReport = {
    scanned: assets.length,
    updated: 0,
    unchanged: 0,
    backfilled: 0,
    rekeyed: 0,
    legacyUnverified: 0,
    missing: 0,
    invalid: 0,
    contentDuplicateGroups: 0,
    sameNameDifferentContent: 0,
    rows: [],
  };
  const measured = new Map<string, ContentInfo | null>();

  for (const a of assets) {
    const want: Patch = {};
    let reason = "";
    let keyed: BackfillRowResult["keyed"] = a.reuseKey ? "EXISTING" : "NONE";
    // Pre-key rows (nothing recorded about their inputs), rows an earlier run
    // already classified, and Phase-4 audio keys of the old (v1) shape.
    const legacy =
      a.source === "GENERATED" &&
      ((!a.reuseKey && (a.inputsJson === "{}" || a.inputsJson === "")) ||
        a.legacyState !== null ||
        (a.reuseKey?.startsWith("reuse:v1:audio:") ?? false));
    const newest = a.source === "REUSED" || newestForPath.get(`${a.kind}|${norm(a.filePath)}`)?.id === a.id;

    let abs: string | null = null;
    try {
      abs = toAbsolute(a.filePath);
    } catch {
      abs = null;
    }
    if (!abs || !fs.existsSync(abs)) {
      want.validity = "MISSING_LOCAL_FILE";
      reason = "file không còn trên đĩa";
    } else {
      let info = measured.get(abs);
      if (info === undefined) {
        info = await probe(abs).catch(() => null);
        measured.set(abs, info);
      }
      if (!info) {
        want.validity = "INVALID";
        reason = "không đọc được file";
      } else if (a.sha256 && a.sha256 !== info.sha256) {
        want.validity = "INVALID";
        reason = "nội dung file khác SHA-256 đã ghi";
      } else if (!newest && !a.sha256) {
        // An older row whose file name was reused for newer bytes: whatever it
        // described is no longer provably on disk. Not merged, not keyed.
        if (a.bytes > 0 && a.bytes !== info.bytes) {
          want.validity = "MISSING_LOCAL_FILE";
          reason = "file đã bị ghi đè bởi asset mới hơn cùng tên";
        } else {
          reason = "cùng tên file với asset mới hơn; không chứng minh được nội dung";
        }
      } else if (!info.probeOk) {
        want.validity = "INVALID";
        reason = "media hỏng (ffprobe không đọc được kích thước/độ dài)";
        want.sha256 = a.sha256 ?? info.sha256;
      } else {
        want.sha256 = info.sha256;
        want.bytes = info.bytes;
        want.mimeType = info.mimeType;
        want.width = info.width;
        want.height = info.height;
        want.durationSec = info.durationSec;
        want.validity = "VALID";
      }
    }

    const fileOk = want.validity === "VALID";
    if (legacy) {
      if (a.kind === "audio" && fileOk && (!a.reuseKey || a.reuseKey.startsWith("reuse:v1:audio:"))) {
        const ev = await audioKeyFromEvidence(a);
        if (ev.key) {
          if (ev.key !== a.reuseKey) {
            want.reuseKey = ev.key;
            keyed = a.reuseKey ? "REKEYED" : "BACKFILLED";
          } else keyed = "EXISTING";
          want.legacyState = "LEGACY_BACKFILLED";
          reason = ev.reason;
        } else if (!a.reuseKey) {
          want.legacyState = "LEGACY_UNVERIFIED";
          reason = reason || ev.reason;
        }
      } else if (!a.reuseKey) {
        want.legacyState = "LEGACY_UNVERIFIED";
        reason = reason || UNPROVABLE[a.kind] || "thiếu bằng chứng đầu vào lúc tạo";
      }
    }
    // An earlier run's LEGACY_BACKFILLED key stays as it is.
    if (a.legacyState === "LEGACY_BACKFILLED" && keyed === "NONE") keyed = "EXISTING";

    const patch = diff(a, want);
    const changed = Object.keys(patch).length > 0;
    if (changed && opts.apply) {
      // Guarded by the key it was read with, so a row keyed by a generation
      // running at the same moment is never overwritten by this scan.
      await prisma.asset.updateMany({
        where: { id: a.id, reuseKey: a.reuseKey },
        data: { ...patch, validatedAt: new Date() },
      });
    }
    const final = { ...a, ...patch };
    if (keyed === "BACKFILLED") report.backfilled++;
    if (keyed === "REKEYED") report.rekeyed++;
    if (final.legacyState === "LEGACY_UNVERIFIED") report.legacyUnverified++;
    if (final.validity === "MISSING_LOCAL_FILE") report.missing++;
    if (final.validity === "INVALID") report.invalid++;
    if (changed) report.updated++;
    else report.unchanged++;
    report.rows.push({
      assetId: a.id,
      kind: a.kind,
      action: changed ? "UPDATED" : "UNCHANGED",
      legacyState: final.legacyState,
      validity: final.validity,
      keyed,
      reason,
    });
  }

  // Content identity is the hash, never the name.
  const bySha = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  for (const a of assets) {
    const sha = measured.get((() => { try { return toAbsolute(a.filePath); } catch { return ""; } })())?.sha256 ?? a.sha256;
    if (!sha) continue;
    const files = bySha.get(sha) ?? new Set<string>();
    files.add(norm(a.filePath));
    bySha.set(sha, files);
    const name = path.basename(a.originalFilename ?? a.filePath).toLowerCase();
    const shas = byName.get(name) ?? new Set<string>();
    shas.add(sha);
    byName.set(name, shas);
  }
  report.contentDuplicateGroups = [...bySha.values()].filter((s) => s.size > 1).length;
  report.sameNameDifferentContent = [...byName.values()].filter((s) => s.size > 1).length;
  return report;
}
