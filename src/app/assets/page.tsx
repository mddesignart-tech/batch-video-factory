import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { listLibrary, type AssetHealth, type LibraryFilter, type LibraryRow } from "@/services/asset-library";
import { prisma } from "@/lib/prisma";
import { formatBytes, formatDateVi, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Asset library (V1.2 Phase 5, QĐ-113). Reads the database and local files only
 * - no provider API. No delete button: this phase detects and reports.
 */

const HEALTH_TONE: Record<AssetHealth, "ok" | "danger" | "warn" | "info" | "neutral"> = {
  HEALTHY: "ok",
  MISSING: "danger",
  INVALID: "danger",
  LEGACY_UNVERIFIED: "warn",
  ORPHAN_CANDIDATE: "info",
};

const SCOPE_LABEL: Record<LibraryRow["reuseScope"], string> = {
  KEYED: "theo khoá",
  CONTENT_ONLY: "theo nội dung",
  SCENE_ONLY: "chỉ cảnh của nó",
  NONE: "—",
};

type Params = Record<string, string | undefined>;

function Preview({ row }: { row: LibraryRow }) {
  if (row.health === "MISSING") {
    return <div className="flex h-16 w-12 items-center justify-center rounded bg-ink-900 text-[10px] text-danger-500">thiếu</div>;
  }
  if (row.type === "IMAGE") {
    return <img src={`/api/media/${row.filePath}`} alt="" loading="lazy" className="h-16 w-12 rounded object-cover" />;
  }
  const label = row.type === "AUDIO" ? "♪" : row.type === "VIDEO" ? "▶" : "MP4";
  return <div className="flex h-16 w-12 items-center justify-center rounded bg-ink-900 text-xs text-ink-300">{label}</div>;
}

function FilterLink({ params, name, value, label }: { params: Params; name: string; value: string; label: string }) {
  const next = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  const active = (params[name] ?? "") === value;
  if (active || !value) next.delete(name);
  if (value && !active) next.set(name, value);
  return (
    <Link
      href={`/assets${next.toString() ? `?${next}` : ""}`}
      className={`rounded-md px-2 py-0.5 text-[11px] ${active ? "bg-ink-700 text-ink-100" : "text-ink-400 hover:bg-ink-800"}`}
    >
      {label}
    </Link>
  );
}

export default async function AssetsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filter: LibraryFilter = {
    q: params.q?.trim() || undefined,
    type: (params.type as LibraryFilter["type"]) || undefined,
    source: (params.source as LibraryFilter["source"]) || undefined,
    provider: params.provider || undefined,
    projectId: params.project || undefined,
    status: params.status || undefined,
    reuseScope: (params.scope as LibraryFilter["reuseScope"]) || undefined,
    health: params.health || undefined,
  };
  const [{ rows, summary }, projects, providers] = await Promise.all([
    listLibrary(filter),
    prisma.project.findMany({ select: { id: true, title: true }, orderBy: { createdAt: "desc" } }),
    prisma.asset.findMany({ distinct: ["provider"], select: { provider: true } }),
  ]);

  return (
    <>
      <PageHeader
        title="Thư viện asset"
        description="Mọi ảnh, clip, giọng đọc và MP4 đã có — đang được dùng ở đâu và còn nguyên vẹn không. Chỉ đọc cơ sở dữ liệu và file tại máy; không gọi API."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Assets" value={summary.assets} />
        <Stat label="Healthy" value={summary.healthy} tone="ok" />
        <Stat label="Missing" value={summary.missing} tone={summary.missing ? "danger" : "neutral"} />
        <Stat label="Invalid" value={summary.invalid} tone={summary.invalid ? "danger" : "neutral"} />
        <Stat label="Legacy unverified" value={summary.legacyUnverified} tone="warn" />
        <Stat label="Orphan candidates" value={summary.orphanCandidates} tone="info" hint="không tự xoá" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="API cost saved" value={formatUSD(summary.apiCostSaved, 6)} tone="ok" hint="giá gốc của asset được dùng lại" />
        <Stat label="Storage deduplicated" value={formatBytes(summary.storageDeduplicatedBytes)} hint="dùng chung file / hard link" />
        <Stat label="Dùng lại asset $0" value={summary.zeroCostReuses} hint="ảnh nhập / local — tiết kiệm công, không phải tiền" />
      </div>

      <Card className="mt-6">
        <CardHeader className="space-y-2">
          <CardTitle>Tìm và lọc</CardTitle>
          <form className="flex flex-wrap items-center gap-2" action="/assets">
            <input
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Tìm theo id, SHA, reuse key, tên file, dự án, model…"
              className="w-80 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs"
            />
            <select name="project" defaultValue={params.project ?? ""} className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs">
              <option value="">Mọi dự án</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <select name="provider" defaultValue={params.provider ?? ""} className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs">
              <option value="">Mọi provider</option>
              {providers.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.provider}
                </option>
              ))}
            </select>
            {["type", "source", "health", "scope", "status"].map((k) =>
              params[k] ? <input key={k} type="hidden" name={k} value={params[k]} /> : null,
            )}
            <button className="rounded-md bg-ink-700 px-3 py-1 text-xs text-ink-100">Lọc</button>
            <Link href="/assets" className="text-xs text-ink-400 hover:underline">
              Xoá bộ lọc
            </Link>
          </form>
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-500">
            Loại:
            {["IMAGE", "VIDEO", "AUDIO", "LOCAL"].map((v) => (
              <FilterLink key={v} params={params} name="type" value={v} label={v} />
            ))}
            <span className="ml-3">Nguồn:</span>
            {["GENERATED", "IMPORTED", "REUSED", "LOCAL"].map((v) => (
              <FilterLink key={v} params={params} name="source" value={v} label={v} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-500">
            Tình trạng:
            {[
              ["HEALTHY", "healthy"],
              ["MISSING", "missing"],
              ["INVALID", "invalid"],
              ["LEGACY", "legacy unverified"],
              ["ORPHAN", "orphan candidate"],
            ].map(([v, l]) => (
              <FilterLink key={v} params={params} name="health" value={v!} label={l!} />
            ))}
            <span className="ml-3">Phạm vi dùng lại:</span>
            {(["KEYED", "CONTENT_ONLY", "SCENE_ONLY", "NONE"] as const).map((v) => (
              <FilterLink key={v} params={params} name="scope" value={v} label={SCOPE_LABEL[v]} />
            ))}
            <span className="ml-3">Trạng thái:</span>
            {["completed", "failed"].map((v) => (
              <FilterLink key={v} params={params} name="status" value={v} label={v} />
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-ink-500">
            {rows.length} / {summary.assets} asset
          </p>
          {rows.length === 0 ? (
            <EmptyState title="Không có asset nào khớp bộ lọc" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Xem</Th>
                  <Th>Loại / nguồn</Th>
                  <Th>Tình trạng</Th>
                  <Th>Provider / model</Th>
                  <Th>Kích thước</Th>
                  <Th>Dùng lại</Th>
                  <Th>Đang dùng bởi</Th>
                  <Th>Tạo / dùng gần nhất</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <Link href={`/assets/${r.id}`}>
                        <Preview row={r} />
                      </Link>
                    </Td>
                    <Td>
                      <Link href={`/assets/${r.id}`} className="font-mono text-[11px] text-accent-500 hover:underline">
                        {r.id.slice(0, 8)}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge>{r.type}</Badge>
                        <Badge tone={r.source === "IMPORTED" ? "info" : r.source === "REUSED" ? "ok" : "neutral"}>{r.source}</Badge>
                      </div>
                      {r.originalFilename ? <p className="mt-0.5 max-w-[10rem] truncate text-[10px] text-ink-500">{r.originalFilename}</p> : null}
                    </Td>
                    <Td>
                      <Badge tone={HEALTH_TONE[r.health]}>{r.health}</Badge>
                      {r.orphan && r.health !== "ORPHAN_CANDIDATE" ? (
                        <div className="mt-1">
                          <Badge tone="info">ORPHAN_CANDIDATE</Badge>
                        </div>
                      ) : null}
                      <p className="mt-0.5 text-[10px] text-ink-500">{r.status}</p>
                    </Td>
                    <Td className="max-w-[12rem] break-all font-mono text-[10px] text-ink-400">
                      {r.provider ? `${r.provider}/${r.model}` : "—"}
                    </Td>
                    <Td className="text-[11px] text-ink-400">
                      {r.width && r.height ? `${r.width}×${r.height}` : "—"}
                      {r.durationSec ? ` · ${r.durationSec.toFixed(2)}s` : ""}
                      <div>{formatBytes(r.bytes)}</div>
                    </Td>
                    <Td className="text-[11px] text-ink-400">{SCOPE_LABEL[r.reuseScope]}</Td>
                    <Td className="max-w-[16rem] text-[11px]">
                      <strong>{r.referenceCount}</strong>
                      {r.references.slice(0, 2).map((ref, i) => (
                        <p key={i} className="truncate text-[10px] text-ink-500">
                          {ref.label}
                        </p>
                      ))}
                      {r.references.length > 2 ? <p className="text-[10px] text-ink-600">+{r.references.length - 2} nữa</p> : null}
                    </Td>
                    <Td className="text-[10px] text-ink-500">
                      {formatDateVi(r.createdAt)}
                      <br />
                      {formatDateVi(r.lastUsedAt)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
