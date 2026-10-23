"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Loader2, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Table, Td, Th } from "@/components/ui";
import { duplicateProjectAction, trashProjectsAction } from "@/app/actions/trash";
import type { ActionResult } from "@/components/action-ui";

export interface ProjectRow {
  id: string;
  phrase: string;
  title: string;
  status: string;
  statusLabel: string;
  statusTone: "neutral" | "brand" | "ok" | "warn" | "danger" | "info";
  mode: string;
  scenes: number;
  videos: number;
  bytes: number;
  estimated: string;
  actual: string;
  budget: string;
  createdAt: string;
  updatedAt: string;
}

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

/**
 * QĐ-152: the project list with selection. Deleting moves to the trash
 * (restorable) and always asks first, naming how many projects it affects -
 * there is no one-click "delete everything".
 */
export function ProjectList({ rows }: { rows: ProjectRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const chosen = rows.filter((r) => confirm?.includes(r.id));
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setMsg(r);
      setConfirm(null);
      if (r.ok) setSelected(new Set());
      router.refresh();
    });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-4 py-2 text-xs">
        <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(rows.map((r) => r.id)))}>
          Chọn tất cả
        </Button>
        <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
          Bỏ chọn
        </Button>
        <Button size="sm" variant="danger" disabled={selected.size === 0 || pending} onClick={() => setConfirm([...selected])}>
          <Trash2 className="h-3 w-3" /> Chuyển {selected.size} dự án vào Thùng rác
        </Button>
        <Link href="/trash" className="text-accent-500 underline">
          Mở Thùng rác
        </Link>
      </div>
      {confirm ? (
        <div className="space-y-2 border-b border-warn-500/40 bg-warn-500/10 px-4 py-3 text-xs">
          <p className="font-semibold text-ink-100">
            Chuyển {chosen.length} dự án vào Thùng rác? Dự án bị ẩn khỏi danh sách, việc đang chờ bị huỷ, dự án đang chạy sẽ không bị xoá. File chưa bị xoá - có thể khôi phục.
          </p>
          <ul className="max-h-48 overflow-y-auto">
            {chosen.map((r) => (
              <li key={r.id} className="text-ink-300">
                • {r.title} — {r.scenes} cảnh · {r.videos} video đã render · ~{mb(r.bytes)} · cập nhật {r.updatedAt}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => trashProjectsAction(confirm))}>
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Xác nhận chuyển {chosen.length} dự án
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              Huỷ
            </Button>
          </div>
        </div>
      ) : null}
      {msg ? (
        <div className="px-4 py-2">
          <Alert tone={msg.ok ? "ok" : "danger"} title={msg.message} />
        </div>
      ) : null}
      <Table>
        <thead>
          <tr>
            <Th className="w-8" />
            <Th>Thành ngữ / nguồn</Th>
            <Th>Tiêu đề</Th>
            <Th>Trạng thái</Th>
            <Th>Chế độ</Th>
            <Th className="text-right">Cảnh</Th>
            <Th className="text-right">Video</Th>
            <Th className="text-right">Dung lượng</Th>
            <Th className="text-right">Ước tính</Th>
            <Th className="text-right">Thực tế</Th>
            <Th>Tạo lúc</Th>
            <Th>Thao tác</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className={`hover:bg-ink-850 ${selected.has(p.id) ? "bg-brand-500/5" : ""}`}>
              <Td>
                <input type="checkbox" aria-label={`Chọn ${p.title}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
              </Td>
              <Td className="font-medium">
                <Link href={`/projects/${p.id}`} className="text-ink-100 hover:text-brand-400">
                  {p.phrase}
                </Link>
              </Td>
              <Td className="max-w-64 text-xs text-ink-400">{p.title}</Td>
              <Td>
                <Badge tone={p.statusTone}>{p.statusLabel}</Badge>
              </Td>
              <Td className="text-xs text-ink-400">{p.mode}</Td>
              <Td className="text-right tabular-nums text-ink-300">{p.scenes}</Td>
              <Td className="text-right tabular-nums text-ink-300">{p.videos}</Td>
              <Td className="text-right tabular-nums text-ink-400">{mb(p.bytes)}</Td>
              <Td className="text-right tabular-nums text-ink-300">{p.estimated}</Td>
              <Td className="text-right tabular-nums text-ink-100">{p.actual}</Td>
              <Td className="text-xs text-ink-500">{p.createdAt}</Td>
              <Td>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={pending} title="Nhân bản dự án ($0, không gọi AI, không render)" onClick={() => run(() => duplicateProjectAction(p.id))}>
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} title="Xoá dự án (vào Thùng rác)" onClick={() => setConfirm([p.id])}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
