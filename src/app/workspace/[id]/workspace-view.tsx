"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Table, Td, Th } from "@/components/ui";
import { formatDuration, formatUSD } from "@/lib/utils";
import { FRIENDLY_STATUSES, FRIENDLY_TONE, VI_WORKFLOW_STEP, WORKFLOW_STEPS, type FriendlyStatus } from "@/domain/friendly-status";
import { VI_SUBTITLE_MODE } from "@/domain/output-preset";
import type { Workspace, WorkspaceVideo } from "@/services/daily-workspace";
import {
  batchSummaryAction,
  exportReportAction,
  exportSelectedAction,
  openBatchFolderAction,
  renameBatchAction,
  setBatchModeAction,
  setBatchPresetAction,
  workspaceData,
} from "@/app/actions/workspace";
import { stopBatch } from "@/app/actions/batches";
import { CopyTextButton } from "@/components/copy-path-button";
import { QueuePanel } from "../queue-panel";
import { ApprovePanel } from "./approve-panel";
import { ProblemLine, VideoActions, VideoCard } from "./video-card";
import { VideoDetailPanel } from "./video-detail";

const CARDS_PER_PAGE = 24;
const ROWS_PER_PAGE = 50;

type SortKey = "order" | "title" | "scenes" | "duration" | "cost" | "status";

/**
 * One batch, the way a person runs it every day (V1.2 Phase 6, QĐ-114).
 * Everything shown is read from the server (buildWorkspace); while anything
 * runs the page asks again every 3 s, and a reload or a restart shows the same
 * state because nothing critical lives only in this component.
 */
export function WorkspaceView({ initial }: { initial: Workspace }) {
  const [ws, setWs] = useState<Workspace>(initial);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"card" | "table">(initial.videos.length > CARDS_PER_PAGE ? "table" : "card");
  const [filter, setFilter] = useState<FriendlyStatus | "ALL" | "ZERO">("ALL");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "order", dir: 1 });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [name, setName] = useState(initial.batch.name);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof batchSummaryAction>> | null>(null);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await workspaceData(initial.batch.id);
      if (r.ok && r.workspace) {
        setWs(r.workspace);
        setError(null);
      } else setError(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
    }
  }, [initial.batch.id]);

  const active = ws.batch.running || ws.videos.some((v) => v.lifecycle === "RUNNING" || v.lifecycle === "RENDERING");
  // After any button, follow the server for a while even if the first read came
  // before the run took its lock (a TIẾP TỤC answers before the video starts).
  const [followUntil, setFollowUntil] = useState(0);
  const follow = useCallback(() => {
    setFollowUntil(Date.now() + 120_000);
    void reload();
  }, [reload]);
  useEffect(() => {
    const t = setInterval(() => {
      if (active || Date.now() < followUntil) void reload();
    }, 3000);
    return () => clearInterval(t);
  }, [active, followUntil, reload]);

  const completed = ws.videos.filter((v) => v.lifecycle === "COMPLETED").length;
  useEffect(() => {
    if (completed === 0) return;
    void batchSummaryAction(ws.batch.id).then(setSummary);
  }, [completed, ws.batch.id]);

  const shown = useMemo(() => {
    let list = ws.videos.map((v, i) => ({ v, i }));
    if (filter === "ZERO") list = list.filter(({ v }) => v.zeroCost && v.lifecycle !== "COMPLETED");
    else if (filter !== "ALL") list = list.filter(({ v }) => v.status === filter);
    const val = ({ v, i }: { v: WorkspaceVideo; i: number }): string | number => {
      switch (sort.key) {
        case "title":
          return v.title.toLowerCase();
        case "scenes":
          return v.sceneCount;
        case "duration":
          return v.durationSec;
        case "cost":
          return v.lifecycle === "COMPLETED" ? v.actualCost : v.estimatedCost;
        case "status":
          return FRIENDLY_STATUSES.indexOf(v.status);
        default:
          return v.queueOrder ?? 1e6 + i;
      }
    };
    return [...list].sort((a, b) => (val(a) < val(b) ? -sort.dir : val(a) > val(b) ? sort.dir : a.i - b.i)).map((x) => x.v);
  }, [ws.videos, filter, sort]);

  const perPage = view === "card" ? CARDS_PER_PAGE : ROWS_PER_PAGE;
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  const current = Math.min(page, pages - 1);
  const visible = shown.slice(current * perPage, current * perPage + perPage);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectedIds = [...selected].filter((id) => ws.videos.some((v) => v.projectId === id && v.lifecycle !== "BLOCKED"));

  async function act(key: string, fn: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(key);
    try {
      const r = await fn();
      setMessage({ ok: r.ok, text: r.message });
      follow();
    } finally {
      setBusy(null);
    }
  }

  const approved = ws.authorization !== null && ws.authorization.status !== "DRAFT";
  const stepIndex = WORKFLOW_STEPS.indexOf(ws.step);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 w-80 text-lg font-semibold" aria-label="Tên lô" />
            {name.trim() !== ws.batch.name ? (
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void act("name", () => renameBatchAction(ws.batch.id, name))}>
                LƯU TÊN
              </Button>
            ) : null}
            <Badge tone={ws.batch.status === "COMPLETED" ? "ok" : ws.batch.status === "FAILED" ? "danger" : active ? "warn" : "neutral"}>
              {active ? "Đang chạy" : ws.batch.statusLabel}
            </Badge>
          </div>
          <p className="text-xs text-ink-500">
            {ws.videos.length} video · thư mục output: data/output/{ws.batch.slug ?? "(tạo khi xuất video đầu tiên)"}
            {active ? " · tự cập nhật mỗi 3s" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("folder", () => openBatchFolderAction(ws.batch.id))}>
            MỞ THƯ MỤC LÔ
          </Button>
          {active && approved ? (
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null}
              onClick={() => void act("stop", () => stopBatch(ws.batch.id))}
              title="Video chưa gửi yêu cầu dừng sạch; yêu cầu trả phí đã gửi vẫn được theo dõi tới kết quả."
            >
              DỪNG LÔ
            </Button>
          ) : null}
          <Link href={`/batches/${ws.batch.id}`} className="text-xs text-ink-400 hover:text-brand-400">
            Nâng cao / Debug →
          </Link>
        </div>
      </div>

      <ol className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {WORKFLOW_STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5">
            <span
              className={`rounded-md border px-2 py-1 font-medium ${
                i < stepIndex
                  ? "border-ok-500/40 text-ok-500"
                  : i === stepIndex
                    ? "border-brand-500 bg-brand-500/15 text-brand-400"
                    : "border-ink-700 text-ink-500"
              }`}
            >
              {i + 1}. {VI_WORKFLOW_STEP[s]}
            </span>
            {i < WORKFLOW_STEPS.length - 1 ? <span className="text-ink-600">→</span> : null}
          </li>
        ))}
      </ol>

      {error ? (
        <Alert tone="warn" title="Không đọc được trạng thái mới nhất">
          {error}. Số liệu bên dưới là lần đọc gần nhất.
        </Alert>
      ) : null}

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 py-3 text-xs">
          <label className="text-ink-400">
            Preset đầu ra
            <select
              value={ws.batch.presetId}
              disabled={busy !== null || active}
              onChange={(e) => void act("preset", () => setBatchPresetAction(ws.batch.id, e.target.value))}
              className="mt-1 block h-9 rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100"
            >
              <option value="">Mặc định trong Cài đặt ({ws.preset.name})</option>
              {ws.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.width}x{p.height} {p.fps}fps
                </option>
              ))}
            </select>
          </label>
          <p className="max-w-sm text-ink-500">
            {ws.preset.width}x{ws.preset.height} · {ws.preset.fps}fps · H.264/AAC · {VI_SUBTITLE_MODE[ws.preset.subtitleMode]}
            {ws.preset.thumbnail ? " · thumbnail" : ""}
            {ws.preset.metadata ? " · metadata" : ""}. Chỉ ảnh hưởng render/xuất — không tạo lại ảnh/clip/giọng.
          </p>
          <label className="text-ink-400">
            Chế độ lô
            <select
              value={ws.batch.mode}
              disabled={busy !== null || approved || active}
              onChange={(e) => void act("mode", () => setBatchModeAction(ws.batch.id, e.target.value as "PARTIAL" | "STRICT"))}
              className="mt-1 block h-9 rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100"
              title={approved ? "Lô đã được duyệt — không đổi chế độ giữa chừng" : ""}
            >
              <option value="PARTIAL">PARTIAL — video lỗi không chặn video khác</option>
              <option value="STRICT">STRICT — có video bị chặn thì không bắt đầu</option>
            </select>
          </label>
        </CardContent>
      </Card>

      <ApprovePanel ws={ws} selectedIds={selectedIds} onChanged={follow} />

      <Card>
        <CardHeader>
          <CardTitle>Video trong lô ({shown.length}/{ws.videos.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="inline-flex overflow-hidden rounded-md border border-ink-700">
              <button type="button" className={`px-3 py-1 ${view === "card" ? "bg-ink-700 text-ink-100" : "text-ink-400"}`} onClick={() => { setView("card"); setPage(0); }}>
                Thẻ
              </button>
              <button type="button" className={`px-3 py-1 ${view === "table" ? "bg-ink-700 text-ink-100" : "text-ink-400"}`} onClick={() => { setView("table"); setPage(0); }}>
                Bảng
              </button>
            </div>
            <select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value as typeof filter);
                setPage(0);
              }}
              className="h-8 rounded-md border border-ink-700 bg-ink-900 px-2 text-ink-100"
              aria-label="Lọc trạng thái"
            >
              <option value="ALL">Tất cả trạng thái</option>
              <option value="ZERO">Chỉ video $0 chưa xong</option>
              {FRIENDLY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s} ({ws.videos.filter((v) => v.status === s).length})
                </option>
              ))}
            </select>
            <span className="text-ink-600">|</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set(ws.videos.filter((v) => v.status === "SẴN SÀNG").map((v) => v.projectId)))}
            >
              Chọn tất cả SẴN SÀNG
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Bỏ chọn tất cả
            </Button>
            <span className="text-ink-400">Đã chọn {selectedIds.length}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || selectedIds.length === 0}
              onClick={() =>
                void act("export", () =>
                  exportSelectedAction(
                    ws.batch.id,
                    selectedIds.filter((id) => ws.videos.find((v) => v.projectId === id)?.lifecycle === "COMPLETED"),
                  ),
                )
              }
            >
              {busy === "export" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              XUẤT VIDEO ĐÃ CHỌN
            </Button>
            <span className="text-[11px] text-ink-500">Chạy / kiểm tra / tiếp tục video đã chọn: dùng khung “Kiểm tra &amp; dự toán” ở trên.</span>
          </div>

          {view === "card" ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((v) => (
                <VideoCard
                  key={v.projectId}
                  v={v}
                  hasApproval={approved}
                  selected={selected.has(v.projectId)}
                  onToggle={() => toggle(v.projectId)}
                  onChanged={follow}
                  onDetail={() => setDetailFor(v.projectId)}
                />
              ))}
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>
                    <input
                      type="checkbox"
                      aria-label="Chọn cả trang"
                      checked={visible.length > 0 && visible.every((v) => selected.has(v.projectId) || v.lifecycle === "BLOCKED")}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          for (const v of visible) {
                            if (v.lifecycle === "BLOCKED") continue;
                            if (e.target.checked) n.add(v.projectId);
                            else n.delete(v.projectId);
                          }
                          return n;
                        })
                      }
                    />
                  </Th>
                  <SortTh k="title" sort={sort} setSort={setSort}>Video</SortTh>
                  <SortTh k="scenes" sort={sort} setSort={setSort} right>Cảnh</SortTh>
                  <SortTh k="duration" sort={sort} setSort={setSort} right>Thời lượng</SortTh>
                  <Th className="text-right">Ảnh (tạo)</Th>
                  <Th className="text-right">Video AI</Th>
                  <Th className="text-right">Giọng</Th>
                  <Th className="text-right">Dùng lại</Th>
                  <SortTh k="cost" sort={sort} setSort={setSort} right>Chi phí</SortTh>
                  <SortTh k="status" sort={sort} setSort={setSort}>Trạng thái</SortTh>
                  <Th>Thao tác</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((v) => (
                  <tr key={v.projectId} className="align-top">
                    <Td>
                      <input type="checkbox" checked={selected.has(v.projectId)} disabled={v.lifecycle === "BLOCKED"} onChange={() => toggle(v.projectId)} aria-label={`Chọn ${v.title}`} />
                    </Td>
                    <Td className="max-w-[16rem]">
                      <p className="truncate font-medium text-ink-100" title={v.title}>
                        {v.title}
                      </p>
                      {v.currentStep ? <p className="text-[11px] text-accent-500">▶ {v.currentStep}</p> : null}
                      <ProblemLine v={v} />
                    </Td>
                    <Td className="text-right tabular-nums">{v.sceneCount}</Td>
                    <Td className="text-right tabular-nums">{v.durationSec > 0 ? formatDuration(v.durationSec) : "—"}</Td>
                    <Td className="text-right tabular-nums">
                      {v.counts.images} ({v.counts.imagesToCreate})
                    </Td>
                    <Td className="text-right tabular-nums">{v.counts.videoAi}</Td>
                    <Td className="text-right tabular-nums">{v.counts.voices}</Td>
                    <Td className="text-right tabular-nums text-ok-500">{v.reuseSaving > 0 ? formatUSD(v.reuseSaving, 4) : "—"}</Td>
                    <Td className="text-right tabular-nums">{formatUSD(v.lifecycle === "COMPLETED" ? v.actualCost : v.estimatedCost, 4)}</Td>
                    <Td>
                      <Badge tone={FRIENDLY_TONE[v.status]}>{v.status}</Badge>
                      {v.exportReady ? <Badge tone="ok" className="ml-1">ĐĂNG ĐƯỢC</Badge> : null}
                    </Td>
                    <Td>
                      <VideoActions v={v} compact onChanged={follow} onDetail={() => setDetailFor(v.projectId)} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {pages > 1 ? (
            <div className="flex items-center gap-2 text-xs">
              <Button size="sm" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
                ← Trước
              </Button>
              <span className="text-ink-400">
                Trang {current + 1}/{pages}
              </span>
              <Button size="sm" variant="ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                Sau →
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {summary?.summary && completed > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Tổng kết xuất</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-ink-200">
              {summary.summary.videos} video · <span className="text-ok-500">{summary.summary.completed} HOÀN THÀNH</span> ·{" "}
              <span className="text-danger-500">{summary.summary.needsAttention} CẦN XỬ LÝ</span> ·{" "}
              <span className="text-warn-500">{summary.summary.blocked} BỊ CHẶN</span>
              {summary.summary.pending > 0 ? ` · ${summary.summary.pending} chưa chạy` : ""}
            </p>
            <p className="text-xs text-ink-400">
              Tổng thời lượng {formatDuration(summary.summary.totalDurationSec)} · Chi API thật {formatUSD(summary.summary.apiSpent, 4)} · Giá trị dùng lại{" "}
              {formatUSD(summary.summary.reusedValue, 4)} · Cảnh LOCAL {summary.summary.localScenes} · Clip Video AI {summary.summary.videoAiClips}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("folder", () => openBatchFolderAction(ws.batch.id))}>
                MỞ THƯ MỤC LÔ
              </Button>
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act("report", () => exportReportAction(ws.batch.id))}>
                {busy === "report" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                XUẤT BÁO CÁO (CSV + JSON)
              </Button>
              {summary.list ? <CopyTextButton text={summary.list} label="COPY DANH SÁCH VIDEO" /> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {message ? <Alert tone={message.ok ? "ok" : "danger"}>{message.text}</Alert> : null}

      <QueuePanel batchId={ws.batch.id} />

      {detailFor ? <VideoDetailPanel projectId={detailFor} batchId={ws.batch.id} onClose={() => { setDetailFor(null); void reload(); }} /> : null}
    </div>
  );
}

function SortTh({
  k,
  sort,
  setSort,
  right,
  children,
}: {
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  setSort: (s: { key: SortKey; dir: 1 | -1 }) => void;
  right?: boolean;
  children: React.ReactNode;
}) {
  const on = sort.key === k;
  return (
    <Th className={right ? "text-right" : undefined}>
      <button type="button" className="hover:text-brand-400" onClick={() => setSort({ key: k, dir: on && sort.dir === 1 ? -1 : 1 })}>
        {children}
        {on ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </Th>
  );
}
