"use client";

import { Fragment, useState } from "react";
import { Badge, Table, Td, Th } from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import { REASON_LABEL, type BatchSpendPlan } from "@/domain/spend-limits";
import type { ImportPreflight } from "@/services/import-preflight";

/**
 * Who runs, who is blocked, and why - per video, then per scene on click
 * (QĐ-108). Every figure is INCREMENTAL: an asset already bought shows $0.
 * Nothing on this table is estimated by the browser; it is the server's plan.
 */
export function SpendPlanTable({ plan, preflight }: { plan: BatchSpendPlan; preflight: ImportPreflight | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map((preflight?.videos ?? []).map((v) => [v.projectId, v]));
  const run = plan.runnable;
  const blocked = plan.blocked;

  return (
    <div className="space-y-2">
      <div className="grid gap-1 text-xs md:grid-cols-2">
        <div className="rounded-md border border-ok-500/40 bg-ok-500/10 px-2 py-1">
          <strong>ĐƯỢC CHẠY:</strong> {run.length > 0 ? run.map((v) => v.title).join(" + ") : "không video nào"} ={" "}
          <strong>{formatUSD(plan.authorizationAmount)}</strong>
        </div>
        <div className={`rounded-md border px-2 py-1 ${blocked.length > 0 ? "border-danger-500/40 bg-danger-500/10" : "border-ink-800"}`}>
          <strong>BỊ CHẶN:</strong>{" "}
          {blocked.length > 0
            ? blocked.map((v) => `${v.title} ${formatUSD(v.incrementalCost)} (${REASON_LABEL[v.verdict.reasonCode]})`).join(" · ")
            : "không"}
        </div>
      </div>

      <Table>
        <thead>
          <tr>
            <Th>Video</Th>
            <Th>Cảnh</Th>
            <Th>Ảnh</Th>
            <Th>Video AI</Th>
            <Th>Giọng</Th>
            <Th>Render</Th>
            <Th>Dự toán (tăng thêm)</Th>
            <Th>Giới hạn</Th>
            <Th>Trạng thái</Th>
          </tr>
        </thead>
        <tbody>
          {plan.videos.map((v) => {
            const row = byId.get(v.id);
            const status = v.runnable ? "PASS" : "BLOCKED";
            return (
              <Fragment key={v.id}>
                <tr className="cursor-pointer hover:bg-ink-900" onClick={() => setOpen(open === v.id ? null : v.id)}>
                  <Td className="font-medium">
                    {open === v.id ? "▾" : "▸"} {v.title}
                  </Td>
                  <Td>{row?.sceneCount ?? v.scenes.length}</Td>
                  <Td>{formatUSD(row?.breakdown.image ?? 0)}</Td>
                  <Td>{formatUSD(row?.breakdown.video ?? 0)}</Td>
                  <Td>{formatUSD(row?.breakdown.voice ?? 0)}</Td>
                  <Td>{formatUSD(row?.breakdown.render ?? 0)}</Td>
                  <Td>{formatUSD(v.incrementalCost)}</Td>
                  <Td>{v.videoLimit === null ? "—" : formatUSD(v.videoLimit)}</Td>
                  <Td>
                    <Badge tone={status === "PASS" ? "ok" : "danger"}>{status}</Badge>
                    {!v.runnable ? (
                      <div className="mt-0.5 max-w-xs text-[11px] text-danger-500">
                        <span className="font-mono">{v.verdict.reasonCode}</span> — {v.verdict.message}
                      </div>
                    ) : null}
                  </Td>
                </tr>
                {open === v.id ? (
                  <tr>
                    <Td colSpan={9}>
                      <Table>
                        <thead>
                          <tr>
                            <Th>Cảnh</Th>
                            <Th>Chế độ</Th>
                            <Th>Provider</Th>
                            <Th>Trạng thái asset</Th>
                            <Th>Dự toán</Th>
                            <Th>Giới hạn cảnh</Th>
                            <Th>Trạng thái</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {v.scenes.map((s) => {
                            const line = row?.scenes.find((x) => x.sceneNumber === s.sceneNumber);
                            return (
                              <tr key={s.sceneNumber}>
                                <Td>{s.sceneNumber}</Td>
                                <Td>{line?.motionSource === "LOCAL_MOTION" ? "LOCAL_MOTION" : "VIDEO_AI"}</Td>
                                <Td className="font-mono text-[11px]">{line?.videoModel ?? "—"}</Td>
                                <Td className="text-[11px]">
                                  ảnh {line?.plan.image ?? "—"} · clip {line?.plan.video ?? "—"} · giọng {line?.plan.voice ?? "—"}
                                </Td>
                                <Td>{formatUSD(s.incrementalCost)}</Td>
                                <Td>{s.limit === null ? "—" : formatUSD(s.limit)}</Td>
                                <Td>
                                  <Badge tone={s.verdict.status === "PASS" ? "ok" : "danger"}>{s.verdict.status}</Badge>
                                  {s.verdict.status !== "PASS" ? (
                                    <span className="ml-1 font-mono text-[10px] text-danger-500">{s.verdict.reasonCode}</span>
                                  ) : null}
                                </Td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </Table>
                    </Td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
