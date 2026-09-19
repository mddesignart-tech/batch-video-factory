"use client";

import Link from "next/link";
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import type {
  AssetPlan,
  ImportPreflight,
  ImportVideoLifecycle,
  ImportVideoPreview,
} from "@/services/import-preflight";

/**
 * Everything an operator needs to see BEFORE any money is approved.
 *
 * All of it is read from the preflight, which is itself all reads - no provider
 * is contacted to draw this screen. That matters more than it sounds: the
 * moment a preview needs a paid call to be accurate, looking at a plan starts
 * costing money, and people stop looking.
 *
 * ## The vocabulary, and why each word is distinct
 *
 *   REUSE         already owned and already paid for. $0, and a saving.
 *   LOCAL_FREE    FFmpeg animates the keyframe. $0, and NOT a saving - there
 *                 was never anything to buy.
 *   WILL_CREATE   this run pays for it.
 *   READY         priced, nothing in the way, waiting for approval.
 *   BLOCKED       will not run, with the reason named.
 *   NEEDS_REFERENCE  a character has no reference image, so every scene that
 *                 draws them is a fresh guess.
 *
 * Collapsing REUSE and LOCAL_FREE into one "free" badge was the tempting
 * simplification and would have been a lie about where the savings come from.
 */

const LIFECYCLE_TONE: Record<
  ImportVideoLifecycle,
  "ok" | "warn" | "danger" | "info" | "brand" | "neutral"
> = {
  IMPORTED: "neutral",
  BLOCKED: "danger",
  READY: "ok",
  APPROVED: "brand",
  RUNNING: "info",
  COMPLETED: "ok",
  FAILED: "danger",
};

const PLAN_LABEL: Record<AssetPlan, string> = {
  BUY: "WILL_CREATE",
  REUSE: "REUSE",
  NONE: "—",
};

const PLAN_TONE: Record<AssetPlan, "ok" | "warn" | "neutral"> = {
  BUY: "warn",
  REUSE: "ok",
  NONE: "neutral",
};

function PlanBadge({ plan, freeLabel }: { plan: AssetPlan; freeLabel?: string }) {
  if (plan === "NONE" && freeLabel) {
    return <Badge tone="ok">{freeLabel}</Badge>;
  }
  if (plan === "NONE") return <span className="text-ink-500">—</span>;
  return <Badge tone={PLAN_TONE[plan]}>{PLAN_LABEL[plan]}</Badge>;
}

function readinessTone(readiness: string): "ok" | "warn" | "danger" {
  if (readiness === "READY") return "ok";
  if (readiness === "NEEDS_CHARACTER_REFERENCE") return "danger";
  return "warn";
}

function readinessLabel(readiness: string): string {
  return readiness === "NEEDS_CHARACTER_REFERENCE" ? "NEEDS_REFERENCE" : readiness;
}

function VideoBlock({ video }: { video: ImportVideoPreview }) {
  const duration = video.scenes.reduce((n, s) => n + s.duration, 0);

  return (
    <div className="space-y-3 rounded-lg border border-ink-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={LIFECYCLE_TONE[video.lifecycle]}>{video.lifecycle}</Badge>
        <span className="font-medium">{video.title}</span>
        <span className="text-xs text-muted-foreground">
          {video.sceneCount} cảnh · {duration.toFixed(1)}s · 9:16 ·{" "}
          {video.characters.length} nhân vật (
          {video.characters.filter((c) => c.referenceCount > 0).length} có ảnh,{" "}
          {video.characters.filter((c) => c.referenceCount === 0).length} thiếu ảnh)
        </span>
        <span className="ml-auto font-medium">{formatUSD(video.estimatedCost)}</span>
      </div>

      {video.blockedReason ? <Alert tone="danger">{video.blockedReason}</Alert> : null}

      {video.characters.length > 0 ? (
        <div className="flex flex-wrap gap-2 text-xs">
          {video.characters.map((c) => (
            <span
              key={c.name}
              className="inline-flex items-center gap-1 rounded-md border border-ink-800 px-2 py-1"
            >
              <strong>{c.name}</strong>
              <span className="text-ink-500">{c.sceneCount} cảnh</span>
              <Badge tone={readinessTone(c.readiness)}>{readinessLabel(c.readiness)}</Badge>
              <span className="text-ink-500">{c.referenceCount} ảnh</span>
            </span>
          ))}
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>#</Th>
            <Th>Giây</Th>
            <Th>Nhân vật</Th>
            <Th>Camera</Th>
            <Th>Chuyển động</Th>
            <Th>Keyframe</Th>
            <Th>Ảnh</Th>
            <Th>Clip</Th>
            <Th>Giọng</Th>
            <Th>Model</Th>
            <Th>Dự toán</Th>
          </tr>
        </thead>
        <tbody>
          {video.scenes.map((s) => (
            <tr key={s.sceneNumber}>
              <Td>{s.sceneNumber}</Td>
              <Td>{s.duration}</Td>
              <Td className="text-xs">{s.characters.join(", ") || "—"}</Td>
              <Td className="max-w-[10rem] truncate text-xs">{s.camera || "—"}</Td>
              <Td>
                <Badge tone={s.motionSource === "LOCAL_MOTION" ? "ok" : "info"}>
                  {s.motionSource === "LOCAL_MOTION" ? "LOCAL_FREE" : "VIDEO_AI"}
                </Badge>
              </Td>
              <Td>
                <Badge tone={s.keyframe === "supplied" ? "ok" : "warn"}>
                  {s.keyframe === "supplied" ? "existing" : "required"}
                </Badge>
              </Td>
              <Td>
                <PlanBadge plan={s.plan.image} />
              </Td>
              <Td>
                <PlanBadge
                  plan={s.plan.video}
                  freeLabel={s.motionSource === "LOCAL_MOTION" ? "LOCAL_FREE" : undefined}
                />
              </Td>
              <Td>
                <PlanBadge plan={s.plan.voice} />
              </Td>
              <Td className="font-mono text-[11px]">{s.videoModel ?? "—"}</Td>
              <Td>{formatUSD(s.estimatedCost)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="grid gap-1 text-xs text-muted-foreground md:grid-cols-3">
        <div>Text {formatUSD(video.breakdown.text)}</div>
        <div>Image {formatUSD(video.breakdown.image)}</div>
        <div>Video {formatUSD(video.breakdown.video)}</div>
        <div>Voice {formatUSD(video.breakdown.voice)}</div>
        <div>Render {formatUSD(video.breakdown.render)} (FFmpeg tại máy)</div>
        <div>Chấm chất lượng {formatUSD(video.breakdown.quality)}</div>
      </div>

      {video.warnings.map((w) => (
        <Alert key={w} tone="warn">
          {w}
        </Alert>
      ))}
    </div>
  );
}

export function PreflightPanel({
  preflight,
  batchId,
}: {
  preflight: ImportPreflight;
  batchId: string | null;
}) {
  const c = preflight.counts;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dự toán lô nhập — chưa cấp phép chi gì</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-2 text-xs">
          {(Object.keys(preflight.lifecycleCounts) as ImportVideoLifecycle[])
            .filter((state) => preflight.lifecycleCounts[state] > 0)
            .map((state) => (
              <Badge key={state} tone={LIFECYCLE_TONE[state]}>
                {state} {preflight.lifecycleCounts[state]}
              </Badge>
            ))}
        </div>

        {preflight.videos.map((v) => (
          <VideoBlock key={v.projectId} video={v} />
        ))}

        {/* ---- what this run will buy, and what it already has ---- */}
        <div className="rounded-lg border border-ink-800 p-3">
          <h4 className="mb-2 text-sm font-medium">Tài sản</h4>
          <div className="grid gap-1 text-sm md:grid-cols-3">
            <div>
              Ảnh: <strong>{c.imageBuy}</strong> cần tạo · {c.imageReuse} dùng lại
            </div>
            <div>
              Clip: <strong>{c.videoBuy}</strong> cần tạo · {c.videoReuse} dùng lại
            </div>
            <div>
              Giọng: <strong>{c.voiceBuy}</strong> cần tạo · {c.voiceReuse} dùng lại
            </div>
            <div>Cảnh LOCAL_MOTION: {preflight.totalLocalMotion}</div>
            <div>Cảnh VIDEO_AI: {preflight.totalVideoAi}</div>
            <div>Tổng cảnh: {preflight.totalScenes}</div>
          </div>
        </div>

        {/* ---- money, with the estimate and the ceiling kept apart ---- */}
        <div className="rounded-lg border border-ink-800 p-3">
          <h4 className="mb-2 text-sm font-medium">Tiền</h4>
          <div className="grid gap-1 text-sm md:grid-cols-2">
            <div>
              Dự toán chạy được: <strong>{formatUSD(preflight.estimatedTotal)}</strong>
            </div>
            <div>
              Kể cả video bị chặn: {formatUSD(preflight.estimatedTotalIncludingBlocked)}
            </div>
            <div>
              Biên an toàn: {formatUSD(preflight.safetyMargin)} (
              {preflight.safetyMarginPercent.toFixed(0)}%)
            </div>
            <div>
              Đề xuất trần duyệt:{" "}
              <strong>{formatUSD(preflight.suggestedAuthorizedMaxSpend)}</strong>
            </div>
            <div>Trần mỗi video: {formatUSD(preflight.maxCostPerVideo)}</div>
            <div>Trần cả lô: {formatUSD(preflight.maxCostForBatch)}</div>
            <div>
              Hạn mức tổng còn lại: <strong>{formatUSD(preflight.globalRemaining)}</strong>
            </div>
            <div>Cơ sở giá: {preflight.costBasis}</div>
          </div>

          <div className="mt-3">
            <h5 className="mb-1 text-xs font-medium text-muted-foreground">
              Ví từng nhà cung cấp — không cộng chung
            </h5>
            <div className="grid gap-1 text-xs md:grid-cols-2">
              {preflight.providerWallets.map((w) => (
                <div key={w.provider}>
                  <span className="font-mono">{w.provider}</span>: đã chi{" "}
                  {formatUSD(w.spentUsd)} · còn{" "}
                  {w.remainingUsd === null ? (
                    <span className="text-ink-500">không rõ (hãng tự quản)</span>
                  ) : (
                    <strong>{formatUSD(w.remainingUsd)}</strong>
                  )}{" "}
                  <Badge tone={w.live ? "ok" : "neutral"}>
                    {w.live ? "đọc được LIVE" : "tự khai"}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </div>

        {preflight.warnings.map((w) => (
          <Alert key={w} tone="warn">
            {w}
          </Alert>
        ))}

        {batchId ? (
          <Alert tone="info">
            Lô đã tạo nhưng <strong>chưa được cấp phép chi</strong>. Màn hình này không gọi
            API nào.{" "}
            <Link className="underline" href={`/batches/${batchId}`}>
              Mở trang lô để xem lại và DUYỆT
            </Link>
            .
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
