"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Input } from "@/components/ui";
import type { ActionResult } from "@/components/action-ui";
import {
  purgeOutputAction,
  purgeProjectAction,
  purgeSceneAction,
  restoreOutputAction,
  restoreProjectAction,
  restoreSceneAction,
} from "@/app/actions/trash";
import type { TrashView as Data } from "@/services/trash-service";

type Filter = "ALL" | "PROJECT" | "SCENE" | "OUTPUT";
const when = (iso: string) => new Date(iso).toLocaleString("vi-VN");
const mb = (n: number | null) => (n === null ? "" : ` · ${(n / 1e6).toFixed(1)} MB`);

/**
 * THÙNG RÁC (QĐ-152): projects, scenes and exported videos that were deleted.
 * Restore puts them back; "Xoá vĩnh viễn" asks again, says what is lost, and
 * removes only files nothing else uses. Nothing is ever deleted on a schedule.
 */
export function TrashView({ data }: { data: Data }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [purging, setPurging] = useState<{ kind: Filter; id: string; label: string; loses: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [positions, setPositions] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setMsg(r);
      setPurging(null);
      setTyped("");
      router.refresh();
    });
  const show = (k: Filter) => filter === "ALL" || filter === k;
  const empty = data.projects.length + data.scenes.length + data.outputs.length === 0;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["ALL", `Tất cả (${data.projects.length + data.scenes.length + data.outputs.length})`],
            ["PROJECT", `Dự án (${data.projects.length})`],
            ["SCENE", `Cảnh (${data.scenes.length})`],
            ["OUTPUT", `Video output (${data.outputs.length})`],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <Button key={k} size="sm" variant={filter === k ? "primary" : "outline"} onClick={() => setFilter(k)}>
            {label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-ink-500">Không có lịch tự động xoá. Mục trong Thùng rác giữ nguyên file trên đĩa cho đến khi bạn bấm Xoá vĩnh viễn.</p>
      {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.message} /> : null}
      {purging ? (
        <div className="space-y-2 rounded-lg border border-danger-500/50 bg-danger-500/10 p-3 text-xs">
          <p className="font-semibold text-ink-100">Xoá vĩnh viễn: {purging.label}</p>
          <p className="text-ink-300">{purging.loses}</p>
          <p className="text-ink-400">Chỉ xoá file nằm trong thư mục của mục này và không còn được dự án/video nào khác dùng. File dùng chung được giữ lại. Không thể hoàn tác.</p>
          <label className="flex flex-wrap items-center gap-2 text-ink-300">
            Gõ <b>XOA</b> để xác nhận:
            <Input className="w-24" value={typed} onChange={(e) => setTyped(e.currentTarget.value)} />
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={pending || typed.trim().toUpperCase() !== "XOA"}
              onClick={() =>
                run(() =>
                  purging.kind === "PROJECT" ? purgeProjectAction(purging.id) : purging.kind === "SCENE" ? purgeSceneAction(purging.id) : purgeOutputAction(purging.id),
                )
              }
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Xoá vĩnh viễn
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPurging(null)}>
              Huỷ
            </Button>
          </div>
        </div>
      ) : null}
      {empty ? <p className="text-ink-400">Thùng rác trống.</p> : null}

      {show("PROJECT") && data.projects.length > 0 ? (
        <section className="space-y-1">
          <h2 className="text-xs font-semibold tracking-wide text-ink-400 uppercase">Dự án</h2>
          {data.projects.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded border border-ink-800 px-3 py-2 text-xs">
              <Badge tone="neutral">Dự án</Badge>
              <Link href={`/projects/${p.id}`} className="font-medium text-ink-100 hover:text-brand-400">
                {p.title}
              </Link>
              <span className="text-ink-500">
                {p.scenes} cảnh · {p.outputs} video · xoá lúc {when(p.deletedAt)}
              </span>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => restoreProjectAction(p.id))}>
                <RotateCcw className="h-3 w-3" /> Khôi phục
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setPurging({ kind: "PROJECT", id: p.id, label: p.title, loses: `Mất: dự án, ${p.scenes} cảnh, lời thoại, ${p.outputs} video đã xuất, ảnh/giọng/clip riêng của dự án và thư mục output của nó.` })}
              >
                Xoá vĩnh viễn
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      {show("SCENE") && data.scenes.length > 0 ? (
        <section className="space-y-1">
          <h2 className="text-xs font-semibold tracking-wide text-ink-400 uppercase">Cảnh</h2>
          {data.scenes.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 rounded border border-ink-800 px-3 py-2 text-xs">
              <Badge tone="neutral">Cảnh{s.fromNumber ? ` ${s.fromNumber}` : ""}</Badge>
              <Link href={`/projects/${s.projectId}`} className="text-ink-300 hover:text-brand-400">
                {s.projectTitle}
              </Link>
              <span className="max-w-96 truncate text-ink-400">“{s.subtitle}”</span>
              <span className="text-ink-500">xoá lúc {when(s.deletedAt)}</span>
              <label className="flex items-center gap-1 text-ink-400">
                vị trí
                <Input
                  className="w-14"
                  inputMode="numeric"
                  value={positions[s.id] ?? String(s.fromNumber ?? "")}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setPositions((x) => ({ ...x, [s.id]: v }));
                  }}
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  const n = Number(positions[s.id] ?? s.fromNumber ?? "");
                  run(() => restoreSceneAction(s.id, Number.isFinite(n) && n > 0 ? n : undefined));
                }}
              >
                <RotateCcw className="h-3 w-3" /> Khôi phục
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPurging({ kind: "SCENE", id: s.id, label: `cảnh “${s.subtitle.slice(0, 60)}”`, loses: "Mất: cảnh, lời thoại và ảnh/giọng/clip chỉ cảnh này dùng." })}>
                Xoá vĩnh viễn
              </Button>
            </div>
          ))}
          <p className="text-[11px] text-ink-500">Vị trí khôi phục mặc định là chỗ cũ; nếu storyboard đã ngắn hơn, cảnh được đặt ở cuối.</p>
        </section>
      ) : null}

      {show("OUTPUT") && data.outputs.length > 0 ? (
        <section className="space-y-1">
          <h2 className="text-xs font-semibold tracking-wide text-ink-400 uppercase">Video output</h2>
          {data.outputs.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-2 rounded border border-ink-800 px-3 py-2 text-xs">
              <Badge tone="neutral">Video</Badge>
              <span className="font-mono text-ink-200">{o.name}</span>
              <Link href={`/projects/${o.projectId}`} className="text-ink-300 hover:text-brand-400">
                {o.projectTitle}
              </Link>
              <span className="text-ink-500">
                xoá lúc {when(o.deletedAt)}
                {mb(o.bytes)}
              </span>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => restoreOutputAction(o.id))}>
                <RotateCcw className="h-3 w-3" /> Khôi phục
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPurging({ kind: "OUTPUT", id: o.id, label: o.name, loses: "Mất: file video này và track Remix Audio chỉ video này dùng. Dự án và các video khác giữ nguyên." })}>
                Xoá vĩnh viễn
              </Button>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
