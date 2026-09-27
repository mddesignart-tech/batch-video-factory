import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { fileSha256 } from "./asset-content";
import { listLibrary } from "./asset-library";

/**
 * ASSET HEALTH CHECK (V1.2 Phase 5, QĐ-113) - `npm run assets:health`.
 *
 * READ-ONLY. It reads the database and hashes local files; it never writes a
 * row, never moves or deletes a file, never calls a provider. Repairs, if ever
 * wanted, are a separate explicit command - not this one.
 */

export interface HealthIssue {
  check: string;
  severity: "ERROR" | "WARN" | "INFO";
  message: string;
  assetId?: string;
  sceneId?: string;
  projectId?: string;
}

export interface HealthReport {
  assets: number;
  healthy: number;
  missing: number;
  invalid: number;
  legacyUnverified: number;
  orphanCandidates: number;
  counts: Record<string, number>;
  issues: HealthIssue[];
}

const norm = (p: string | null | undefined) => (p ?? "").split("\\").join("/");

function onDisk(rel: string | null | undefined): boolean {
  if (!rel) return false;
  try {
    return fs.existsSync(toAbsolute(rel));
  } catch {
    return false;
  }
}

export async function assetHealthReport(): Promise<HealthReport> {
  const issues: HealthIssue[] = [];
  const add = (i: HealthIssue) => issues.push(i);
  const assets = await prisma.asset.findMany({ orderBy: { createdAt: "asc" } });
  const assetIds = new Set(assets.map((a) => a.id));

  let missing = 0;
  let invalid = 0;
  // Reported once, as missing - not again as "no metadata".
  const gone = new Set<string>();
  for (const a of assets) {
    let abs: string;
    try {
      abs = toAbsolute(a.filePath);
    } catch {
      invalid++;
      add({ check: "bad_path", severity: "ERROR", message: `Đường dẫn ngoài data/: ${a.filePath}`, assetId: a.id });
      continue;
    }
    if (!fs.existsSync(abs)) {
      missing++;
      gone.add(a.id);
      add({ check: "missing_file", severity: "ERROR", message: `Có bản ghi nhưng thiếu file (${a.kind})`, assetId: a.id, projectId: a.projectId });
      continue;
    }
    const size = fs.statSync(abs).size;
    if (size === 0) {
      invalid++;
      add({ check: "empty_file", severity: "ERROR", message: "File rỗng", assetId: a.id });
      continue;
    }
    if (a.sha256) {
      let sha = "";
      try {
        sha = fileSha256(abs);
      } catch {
        sha = "";
      }
      if (sha !== a.sha256) {
        invalid++;
        add({ check: "hash_mismatch", severity: "ERROR", message: "Nội dung file khác SHA-256 đã ghi", assetId: a.id });
        continue;
      }
    }
    if (a.validity === "INVALID") {
      invalid++;
      add({ check: "corrupt_media", severity: "ERROR", message: "Đã được đánh dấu INVALID (media hỏng / không đọc được)", assetId: a.id });
      continue;
    }
    if (a.validity === "MISSING_LOCAL_FILE") {
      // The path exists but a newer asset wrote different bytes under it: the
      // content this row describes is gone (found by backfill).
      missing++;
      add({ check: "missing_file", severity: "ERROR", message: `Nội dung của asset đã bị file mới cùng tên ghi đè (${a.kind})`, assetId: a.id, projectId: a.projectId });
      continue;
    }
    const isImage = a.kind === "image";
    const isMedia = a.kind === "video" || a.kind === "audio" || a.kind === "final";
    if (a.sha256 && ((isImage && a.width === null) || (isMedia && a.durationSec === null))) {
      add({ check: "media_metadata", severity: "WARN", message: "Thiếu kích thước/độ dài đã đo", assetId: a.id });
    }
    if (a.status !== "completed") {
      add({ check: "inconsistent_status", severity: "WARN", message: `Trạng thái asset "${a.status}"`, assetId: a.id });
    }
  }

  // Content: one SHA stored under several paths (not hard links) is duplicate storage.
  const bySha = new Map<string, Set<string>>();
  for (const a of assets) {
    if (!a.sha256) continue;
    const s = bySha.get(a.sha256) ?? new Set<string>();
    s.add(norm(a.filePath));
    bySha.set(a.sha256, s);
  }
  for (const [sha, paths] of bySha) {
    if (paths.size < 2) continue;
    const inodes = new Set(
      [...paths].map((p) => {
        try {
          const st = fs.statSync(toAbsolute(p));
          return `${st.dev}:${st.ino}`;
        } catch {
          return p;
        }
      }),
    );
    if (inodes.size > 1) {
      add({ check: "duplicate_sha", severity: "INFO", message: `SHA ${sha.slice(0, 10)}… có ${inodes.size} bản sao vật lý (${paths.size} đường dẫn)` });
    }
  }

  // Keys: many REUSED rows per key is normal; two paid originals is not.
  const byKey = new Map<string, number>();
  for (const a of assets) {
    if (!a.reuseKey || a.source === "REUSED" || a.status !== "completed") continue;
    byKey.set(a.reuseKey, (byKey.get(a.reuseKey) ?? 0) + 1);
  }
  for (const [key, n] of byKey) {
    if (n > 1) add({ check: "duplicate_reuse_key", severity: "WARN", message: `${n} asset GỐC hoàn tất cùng reuse key ${key.slice(0, 28)}…` });
  }

  for (const a of assets) {
    if (a.reusedFromAssetId && !assetIds.has(a.reusedFromAssetId)) {
      add({
        check: "reuse_source_gone",
        severity: "INFO",
        message: "Asset gốc của bản dùng lại đã bị xoá (dự án gốc bị xoá); bản dùng lại vẫn có file riêng",
        assetId: a.id,
      });
    }
    if (a.legacyState === "LEGACY_UNVERIFIED") {
      add({ check: "legacy_unverified", severity: "INFO", message: "Asset cũ thiếu bằng chứng đầu vào — chỉ dùng cho cảnh của nó", assetId: a.id });
    }
    if (!a.sha256 && a.validity !== "MISSING_LOCAL_FILE" && !gone.has(a.id)) {
      add({ check: "legacy_no_metadata", severity: "WARN", message: "Chưa có SHA-256 — chạy assets:backfill", assetId: a.id });
    }
  }

  // Scenes and projects pointing at things that are not there.
  const scenes = await prisma.scene.findMany({
    select: { id: true, projectId: true, sceneNumber: true, imageAssetId: true, imagePath: true, videoPath: true, status: true, skipped: true },
  });
  const sceneIds = new Set(scenes.map((s) => s.id));
  for (const s of scenes) {
    if (s.imageAssetId && !assetIds.has(s.imageAssetId)) {
      add({ check: "dangling_scene_asset", severity: "ERROR", message: `Cảnh ${s.sceneNumber} trỏ tới asset không tồn tại`, sceneId: s.id, projectId: s.projectId });
    }
    for (const [field, p] of [["ảnh", s.imagePath], ["clip", s.videoPath]] as const) {
      if (p && !onDisk(p)) {
        add({ check: "scene_file_missing", severity: s.skipped ? "INFO" : "ERROR", message: `Cảnh ${s.sceneNumber}: thiếu file ${field}`, sceneId: s.id, projectId: s.projectId });
      }
    }
    if (s.status === "completed" && !s.skipped && !s.imagePath && !s.videoPath) {
      add({ check: "inconsistent_status", severity: "WARN", message: `Cảnh ${s.sceneNumber} "completed" nhưng không có media`, sceneId: s.id, projectId: s.projectId });
    }
  }
  const projects = await prisma.project.findMany({ select: { id: true, title: true, status: true, finalVideoPath: true } });
  const projectIds = new Set(projects.map((p) => p.id));
  for (const p of projects) {
    if (p.status === "completed" && (!p.finalVideoPath || !onDisk(p.finalVideoPath))) {
      add({ check: "final_missing", severity: "WARN", message: `"${p.title}" hoàn tất nhưng thiếu MP4 cuối (render lại tại máy, $0)`, projectId: p.id });
    }
  }
  const jobs = await prisma.providerJob.findMany({ select: { id: true, projectId: true, sceneId: true } });
  for (const j of jobs) {
    if ((j.projectId && !projectIds.has(j.projectId)) || (j.sceneId && !sceneIds.has(j.sceneId))) {
      add({ check: "dangling_provider_job", severity: "INFO", message: `ProviderJob ${j.id.slice(0, 8)} trỏ tới dự án/cảnh đã xoá (giữ nguyên làm bằng chứng)` });
    }
  }

  const { summary } = await listLibrary();
  const counts: Record<string, number> = {};
  for (const i of issues) counts[i.check] = (counts[i.check] ?? 0) + 1;
  counts.orphan_candidate = summary.orphanCandidates;
  return {
    assets: assets.length,
    healthy: summary.healthy,
    missing,
    invalid,
    legacyUnverified: summary.legacyUnverified,
    orphanCandidates: summary.orphanCandidates,
    counts,
    issues,
  };
}
