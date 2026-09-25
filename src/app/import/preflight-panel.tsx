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
        {video.status === "NEEDS_CHARACTER_REFERENCE" ? <Badge tone="danger">NEEDS_REFERENCE</Badge> : null}
        <span className="font-medium">{video.title}</span>
        <span className="text-xs text-muted-foreground">
          {video.sceneCount} cảnh · {duration.toFixed(1)}s · {video.aspectRatio} · ảnh có sẵn{" "}
          {video.counts.imageReuse} / thiếu{" "}
          {video.counts.imageBuy} · LOCAL {video.localMotionCount} · VIDEO_AI {video.videoAiCount} ·{" "}
          model {[...new Set(video.scenes.map((s) => s.videoModel).filter(Boolean))].join(", ") || "—"} ·{" "}
          {video.characters.length} nhân vật (
          {video.characters.filter((c) => c.referenceCount > 0).length} có ảnh,{" "}
          {video.characters.filter((c) => c.referenceCount === 0).length} thiếu ảnh)
        </span>
        <span className="ml-auto font-medium">
          {formatUSD(video.estimatedCost)}
          {video.uncappedCost > video.estimatedCost ? (
            <span className="ml-1 text-warn-500">
              (thật ra {formatUSD(video.uncappedCost)})
            </span>
          ) : null}
        </span>
      </div>

      {video.blockedReason ? <Alert tone="danger">{video.blockedReason}</Alert> : null}

      {video.duplicateOf.length > 0 ? (
        <Alert tone="warn">
          Đây là <strong>một bản nhập MỚI</strong> của storyboard đã từng nhập (
          {video.duplicateOf.map((d) => d.title).join(", ")}) — nội dung giống hệt, dấu vân
          tay <code className="font-mono text-[11px]">{video.importFingerprint}</code>. Hệ
          thống <strong>không</strong> giả vờ dùng lại video cũ: đây là một video riêng, sẽ
          tốn tiền riêng. Nhân vật và ảnh tham chiếu thì vẫn dùng chung, không nhân đôi.
        </Alert>
      ) : null}

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
            <Th>Ảnh cảnh</Th>
            <Th>Giây</Th>
            <Th>Nhân vật</Th>
            <Th>Camera</Th>
            <Th>Chuyển động</Th>
            <Th>Nguồn ảnh</Th>
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
              <Td>
                {s.imagePath ? (
                  // Thumbnail of the picture this scene will use. Served from
                  // data/ by the media route; nothing is generated to show it.
                  <img src={`/api/media/${s.imagePath}`} alt="" className="h-12 w-7 rounded object-cover" />
                ) : (
                  <span className="text-[11px] text-ink-500">—</span>
                )}
              </Td>
              <Td>{s.duration}</Td>
              <Td className="text-xs">{s.characters.join(", ") || "—"}</Td>
              <Td className="max-w-[10rem] truncate text-xs">{s.camera || "—"}</Td>
              <Td>
                <Badge tone={s.motionSource === "LOCAL_MOTION" ? "ok" : "info"}>
                  {s.motionSource === "LOCAL_MOTION" ? "LOCAL_FREE" : "VIDEO_AI"}
                </Badge>
              </Td>
              <Td>
                <Badge tone={IMAGE_SOURCE_TONE[s.imageSource]}>{s.imageSource}</Badge>
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

/** IMPORTED = REUSE = $0 Image API. Only WILL_CREATE costs an image POST. */
const IMAGE_SOURCE_TONE: Record<
  "IMPORTED" | "REUSED" | "WILL_CREATE" | "NONE" | "MISSING",
  "ok" | "info" | "warn" | "neutral" | "danger"
> = {
  IMPORTED: "ok",
  REUSED: "ok",
  WILL_CREATE: "warn",
  NONE: "neutral",
  MISSING: "danger",
};

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

        {/* ---- images first: the purchase an import exists to avoid ---- */}
        <div className="rounded-lg border border-ink-800 p-3">
          <h4 className="mb-2 text-sm font-medium">Ảnh — nhập sẵn thì không gọi Image API</h4>
          <div className="grid gap-1 font-mono text-xs md:grid-cols-2">
            <div>TOTAL SCENES: {preflight.totalScenes}</div>
            <div>
              IMAGES: <strong className="text-ok-500">{c.imageReuse} REUSE</strong> (
              {c.imageImported} IMPORTED) · <strong>{c.imageBuy} CREATE</strong>
            </div>
            <div>
              IMAGE API POST: <strong>{c.imagePosts}</strong>
            </div>
            <div>
              IMAGE API COST:{" "}
              <strong>
                {formatUSD(preflight.videos.reduce((n, v) => n + v.breakdown.image, 0))}
              </strong>
            </div>
            <div>VOICE API POST: {c.voicePosts}</div>
            <div>VIDEO API POST: {c.videoPosts}</div>
            <div>LOCAL_MOTION: {preflight.totalLocalMotion}</div>
            <div>VIDEO_AI: {preflight.totalVideoAi}</div>
            <div className="md:col-span-2">
              ESTIMATED TOTAL COST: <strong>{formatUSD(preflight.estimatedTotal)}</strong>
            </div>
          </div>
        </div>

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
              Nếu mọi video đều chạy:{" "}
              <strong>{formatUSD(preflight.estimatedTotalUncapped)}</strong>
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
              Model trả phí — đã xác nhận giá chưa
            </h5>
            <div className="grid gap-1 text-xs md:grid-cols-2">
              {preflight.paidModels.length === 0 ? (
                <div className="text-ink-500">Không có model trả phí nào.</div>
              ) : (
                preflight.paidModels.map((m) => (
                  <div key={m.key}>
                    <span className="font-mono">{m.key}</span>{" "}
                    <Badge tone={m.confirmed ? "ok" : "danger"}>
                      {m.confirmed ? "ĐÃ XÁC NHẬN" : "CHƯA XÁC NHẬN"}
                    </Badge>
                  </div>
                ))
              )}
            </div>
            {preflight.paidModels.some((m) => !m.confirmed) ? (
              <Alert tone="danger" className="mt-2">
                Quyền chi của lô trả lời <em>&ldquo;được tiêu bao nhiêu&rdquo;</em>; danh
                sách xác nhận trả lời <em>&ldquo;đã nhìn giá model này và đồng ý
                chưa&rdquo;</em>. Thiếu vế thứ hai thì request trả phí ĐẦU TIÊN bị từ chối
                giữa chừng — đúng như lô <code className="font-mono">a690a290</code> đã dừng.
                Mở trang <strong>Nhà cung cấp AI</strong> để xác nhận.
              </Alert>
            ) : null}
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
