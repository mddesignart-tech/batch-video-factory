import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, PageHeader, Table, Td, Th } from "@/components/ui";
import { displayPath, getAssetDetail, shortHash, type AssetLink } from "@/services/asset-library";
import { formatBytes, formatDateVi, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[11rem_1fr] gap-2 border-b border-ink-800 py-1.5 text-xs">
      <span className="text-ink-500">{label}</span>
      <span className="break-all text-ink-200">{children}</span>
    </div>
  );
}

const BASIS_LABEL: Record<AssetLink["basis"], string> = {
  RECORDED: "ghi lại khi tạo",
  REUSE: "dùng lại",
  STRUCTURE: "suy từ cấu trúc cảnh",
};

function Links({ title, links, empty }: { title: string; links: AssetLink[]; empty: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {links.length === 0 ? (
          <p className="text-xs text-ink-500">{empty}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Asset</Th>
                <Th>Loại</Th>
                <Th>Dự án / cảnh</Th>
                <Th>Quan hệ</Th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={`${l.assetId}-${l.note}`}>
                  <Td>
                    <Link href={`/assets/${l.assetId}`} className="font-mono text-[11px] text-accent-500 hover:underline">
                      {l.assetId.slice(0, 8)}
                    </Link>
                  </Td>
                  <Td className="text-[11px]">{l.kind}</Td>
                  <Td className="text-[11px]">
                    {l.projectTitle ?? "?"}
                    {l.sceneNumber !== null ? ` · cảnh ${l.sceneNumber}` : ""}
                  </Td>
                  <Td className="text-[11px] text-ink-400">
                    {l.note} <span className="text-ink-600">({BASIS_LABEL[l.basis]})</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getAssetDetail(id);
  if (!detail) notFound();
  const { row } = detail;
  const src = `/api/media/${row.filePath}`;

  return (
    <>
      <PageHeader
        title={`Asset ${row.id.slice(0, 8)}`}
        description={`${row.type} · ${row.source} · ${row.projectTitle ?? "?"}${row.sceneNumber !== null ? ` · cảnh ${row.sceneNumber}` : ""}`}
        actions={
          <Link href="/assets" className="text-xs text-accent-500 hover:underline">
            ← Thư viện asset
          </Link>
        }
      />

      {row.referenceCount > 0 ? (
        <Alert tone="info" className="mb-4">
          Asset đang được sử dụng bởi {row.referenceCount} scene/video/project. Không thể xoá cứng khi còn tham chiếu.
        </Alert>
      ) : (
        <Alert tone="warn" className="mb-4">
          ORPHAN_CANDIDATE: không còn gì tham chiếu tới asset này. Chỉ báo cáo — không tự xoá (asset có thể đã trả tiền).
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <Card>
          <CardContent className="pt-4">
            {row.health === "MISSING" ? (
              <div className="flex aspect-[9/16] items-center justify-center rounded bg-ink-900 text-xs text-danger-500">
                File không còn trên đĩa
              </div>
            ) : row.type === "IMAGE" ? (
              <img src={src} alt="" className="w-full rounded" />
            ) : row.type === "AUDIO" ? (
              <audio src={src} controls className="w-full" />
            ) : (
              <video src={src} controls preload="metadata" className="w-full rounded bg-black" />
            )}
            <div className="mt-3 flex flex-wrap gap-1">
              <Badge tone={row.health === "HEALTHY" ? "ok" : row.health === "MISSING" || row.health === "INVALID" ? "danger" : "warn"}>
                {row.health}
              </Badge>
              {row.orphan ? <Badge tone="info">ORPHAN_CANDIDATE</Badge> : null}
              {row.legacyState && row.legacyState !== row.health ? <Badge tone="warn">{row.legacyState}</Badge> : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Thông tin</CardTitle>
          </CardHeader>
          <CardContent>
            <Row label="SHA-256">
              <span className="font-mono" title={row.sha256 ?? ""}>
                {shortHash(row.sha256)}
              </span>
            </Row>
            <Row label="Reuse key">
              <span className="font-mono" title={row.reuseKey ?? ""}>
                {shortHash(row.reuseKey)}
              </span>
            </Row>
            <Row label="Phạm vi dùng lại">{row.reuseScope}</Row>
            <Row label="Toàn vẹn">{row.validity}</Row>
            <Row label="Trạng thái">{row.status}</Row>
            <Row label="Provider / model">{row.provider ? `${row.provider} / ${row.model}` : "— (ảnh nhập / không có)"}</Row>
            <Row label="Kích thước">
              {row.width && row.height ? `${row.width}×${row.height}` : "—"}
              {row.durationSec ? ` · ${row.durationSec.toFixed(3)}s` : ""} · {formatBytes(row.bytes)} · {row.mimeType ?? "?"}
            </Row>
            <Row label="Chi phí gốc">
              {detail.originalCost
                ? `${formatUSD(detail.originalCost.amount, 6)} — ${detail.originalCost.evidence}${
                    detail.originalCost.costEntryId ? ` (${detail.originalCost.costEntryId.slice(0, 8)})` : ""
                  }`
                : "không có bằng chứng sổ chi"}
            </Row>
            <Row label="Chi phí dùng lại bây giờ">{formatUSD(detail.incrementalReuseCost, 6)} (incremental)</Row>
            <Row label="Phiên bản nhân vật">{detail.characterVersions.length ? detail.characterVersions.join(", ") : "—"}</Row>
            <Row label="Bản gốc (nếu là bản dùng lại)">
              {row.reusedFromAssetId ? (
                <Link href={`/assets/${row.reusedFromAssetId}`} className="font-mono text-accent-500 hover:underline">
                  {row.reusedFromAssetId.slice(0, 8)}
                </Link>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Tên file gốc">{row.originalFilename ?? "—"}</Row>
            <Row label="Đường dẫn">{displayPath(row.filePath)}</Row>
            <Row label="Tạo lúc / dùng gần nhất">
              {formatDateVi(row.createdAt)} / {formatDateVi(row.lastUsedAt)}
            </Row>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Đang được dùng bởi ({row.referenceCount})</CardTitle>
        </CardHeader>
        <CardContent>
          {row.references.length === 0 ? (
            <p className="text-xs text-ink-500">Không có tham chiếu nào.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {row.references.map((r, i) => (
                <li key={i}>
                  <Badge>{r.kind}</Badge>{" "}
                  {r.projectId ? (
                    <Link href={`/projects/${r.projectId}`} className="text-accent-500 hover:underline">
                      {r.label}
                    </Link>
                  ) : (
                    r.label
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Links title="Dựng từ (dependencies)" links={detail.dependencies} empty="Không có đầu vào được ghi lại." />
        <Links title="Asset phụ thuộc (dependents)" links={detail.dependents} empty="Không asset nào dựng từ asset này." />
      </div>
    </>
  );
}
