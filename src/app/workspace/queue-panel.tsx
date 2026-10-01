"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from "@/components/ui";
import { formatDuration, formatUSD } from "@/lib/utils";
import { queueData } from "@/app/actions/workspace";
import type { QueueRow } from "@/services/daily-history";

const TONE: Record<QueueRow["state"], "warn" | "info" | "ok" | "danger" | "neutral" | "brand"> = {
  "ĐANG TẠO": "warn",
  "ĐANG RENDER": "warn",
  "ĐANG CHỜ": "brand",
  "HOÀN THÀNH": "ok",
  "CẦN XỬ LÝ": "danger",
  "BỊ CHẶN": "neutral",
};

/**
 * The live queue (V1.2 Phase 6, QĐ-114). Polls the server every 3 s while
 * anything runs or waits and every 15 s otherwise; every row is read from the
 * database, so a refresh or a second tab shows the same thing. No progress is
 * invented: scenes done / total are the rows the pipeline wrote.
 */
export function QueuePanel({ batchId }: { batchId?: string }) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const all = await queueData();
      setRows(batchId ? all.filter((r) => r.batchId === batchId) : all);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
    }
  }, [batchId]);

  const busy = rows?.some((r) => r.state === "ĐANG TẠO" || r.state === "ĐANG RENDER" || r.state === "ĐANG CHỜ") ?? false;
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), busy ? 3000 : 15000);
    return () => clearInterval(t);
  }, [busy, load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hàng đợi {busy ? <span className="ml-2 text-[11px] font-normal text-ink-500">tự cập nhật mỗi 3s</span> : null}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {error ? <p className="px-4 py-2 text-xs text-warn-500">Không đọc được hàng đợi: {error} (số liệu cũ vẫn hiện)</p> : null}
        {rows === null ? (
          <p className="px-4 py-3 text-xs text-ink-500">Đang đọc…</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-3 text-xs text-ink-500">Không có video nào đang chạy hay đang chờ.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="text-right">#</Th>
                <Th>Video</Th>
                <Th>Trạng thái</Th>
                <Th>Bước hiện tại</Th>
                <Th className="text-right">Cảnh</Th>
                <Th className="text-right">Thời gian</Th>
                <Th className="text-right">Trần duyệt</Th>
                <Th className="text-right">Chi thật</Th>
                <Th className="text-right">Tạo lại</Th>
                <Th>Nhà cung cấp</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((r) => (
                <tr key={r.projectId}>
                  <Td className="text-right tabular-nums text-ink-500">{r.position ?? "—"}</Td>
                  <Td>
                    <Link href={r.batchId ? `/workspace/${r.batchId}` : "#"} className="text-ink-100 hover:text-brand-400">
                      {r.title}
                    </Link>
                    {!batchId ? <p className="text-[11px] text-ink-500">{r.batchName}</p> : null}
                  </Td>
                  <Td>
                    <Badge tone={TONE[r.state]}>{r.state}</Badge>
                  </Td>
                  <Td className="text-xs text-ink-300">{r.currentStep ?? "—"}</Td>
                  <Td className="text-right tabular-nums">
                    {r.scenesDone}/{r.scenesTotal}
                  </Td>
                  <Td className="text-right tabular-nums text-ink-400">{r.elapsedSec === null ? "—" : formatDuration(r.elapsedSec)}</Td>
                  <Td className="text-right tabular-nums text-ink-400">{formatUSD(r.authorizedCost, 2)}</Td>
                  <Td className="text-right tabular-nums">{formatUSD(r.actualCost, 4)}</Td>
                  <Td className="text-right tabular-nums">{r.retries}</Td>
                  <Td className="text-[11px] text-ink-400">{r.provider ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="px-4 py-2 text-[11px] text-ink-500">
          Huỷ: nút DỪNG ở trang lô — video chưa gửi yêu cầu dừng sạch; yêu cầu trả phí đã gửi vẫn được theo dõi tới kết quả (không có hoàn tiền giả).
        </p>
      </CardContent>
    </Card>
  );
}
