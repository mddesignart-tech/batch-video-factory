"use client";

import { FriendlyReason } from "@/components/friendly-reason";
import { useState } from "react";
import Link from "next/link";
import { setSceneDurationMode } from "@/app/actions/storyboard-import";
import { DURATION_MODES } from "@/domain/scene-timing";
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

type SceneLine = ImportVideoPreview["scenes"][number];
type Kind = "image" | "video" | "voice";

/**
 * One asset of one scene, in the words the operator decides on (QĐ-112):
 *   IMPORTED     a person supplied it - $0
 *   REUSE        already exists (this scene, or an identical asset elsewhere) - $0
 *   LOCAL        FFmpeg makes it - $0, and not a saving
 *   WILL CREATE  this run pays for it: model + price shown
 *   MISSING      its file is gone - never reused blind
 *   INVALID      its bytes no longer match - never reused blind
 */
function AssetCell({ s, kind }: { s: SceneLine; kind: Kind }) {
  const plan = s.plan[kind];
  const from = s.reuseFrom[kind];
  const invalid = kind === "voice" ? null : s.invalid[kind];
  const problem =
    invalid === "MISSING_LOCAL_FILE" ? (
      <Badge tone="danger">MISSING</Badge>
    ) : invalid === "INVALID" ? (
      <Badge tone="danger">INVALID</Badge>
    ) : null;
  if (kind === "image" && s.imageSource === "MISSING") return <Badge tone="danger">MISSING</Badge>;
  if (kind === "video" && s.motionSource === "LOCAL_MOTION") return <Badge tone="ok">LOCAL</Badge>;
  if (from === "IMPORTED") {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <Badge tone="ok">IMPORTED</Badge>
        <span className="text-[10px] text-ok-500">Ảnh nhập sẵn — $0</span>
      </span>
    );
  }
  if (plan === "REUSE" || from) {
    return (
      <span className="inline-flex flex-col gap-0.5" title={from === "CACHE" ? "Asset giống hệt đã có ở cảnh / dự án khác" : "Cảnh này đã có"}>
        <Badge tone="ok">REUSE</Badge>
        <span className="text-[10px] text-ok-500">
          Đã có — không phát sinh chi phí{from === "CACHE" ? " (dùng chung)" : ""}
        </span>
      </span>
    );
  }
  if (plan === "BUY") {
    const model = kind === "video" ? s.videoModel : s.models[kind];
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className="inline-flex flex-wrap gap-1">
          {problem}
          <Badge tone="warn">WILL CREATE</Badge>
        </span>
        <span className="max-w-[9rem] break-all font-mono text-[10px] text-ink-400">
          {model ?? "?"} · {formatUSD(s.costs[kind], 6)}
        </span>
      </span>
    );
  }
  return problem ?? <span className="text-ink-500">—</span>;
}

/** Per video: each cost stage split into REUSE / IMPORTED / LOCAL_FREE / WILL_CREATE, with cost and saving. */
function StageTable({ video }: { video: ImportVideoPreview }) {
  const rows: { stage: string; reuse: number; imported: number; local: number; create: number; cost: number; saved: number }[] = [];
  const count = (pred: (s: SceneLine) => boolean) => video.scenes.filter(pred).length;
  rows.push({ stage: "TEXT", reuse: 0, imported: 0, local: 0, create: 0, cost: video.breakdown.text, saved: 0 });
  rows.push({
    stage: "IMAGE",
    reuse: count((s) => s.reuseFrom.image === "EXISTING" || s.reuseFrom.image === "CACHE"),
    imported: count((s) => s.reuseFrom.image === "IMPORTED"),
    local: 0,
    create: count((s) => s.plan.image === "BUY"),
    cost: video.breakdown.image,
    saved: video.savings.image,
  });
  rows.push({
    stage: "VIDEO",
    reuse: count((s) => s.reuseFrom.video !== null),
    imported: 0,
    local: count((s) => s.motionSource === "LOCAL_MOTION"),
    create: count((s) => s.plan.video === "BUY"),
    cost: video.breakdown.video,
    saved: video.savings.video,
  });
  rows.push({
    stage: "VOICE",
    reuse: count((s) => s.reuseFrom.voice !== null),
    imported: 0,
    local: 0,
    create: count((s) => s.plan.voice === "BUY"),
    cost: video.breakdown.voice,
    saved: video.savings.voice,
  });
  rows.push({ stage: "RENDER (FFmpeg)", reuse: 0, imported: 0, local: video.scenes.length, create: 0, cost: 0, saved: 0 });
  rows.push({ stage: "CHẤM CHẤT LƯỢNG (tuỳ chọn)", reuse: 0, imported: 0, local: 0, create: 0, cost: video.breakdown.quality, saved: 0 });
  rows.push({ stage: "RETRY RESERVE", reuse: 0, imported: 0, local: 0, create: 0, cost: video.breakdown.retries, saved: 0 });
  return (
    <Table>
      <thead>
        <tr>
          <Th>Hạng mục</Th>
          <Th>REUSE</Th>
          <Th>IMPORTED</Th>
          <Th>LOCAL_FREE</Th>
          <Th>WILL_CREATE</Th>
          <Th>Chi phí</Th>
          <Th>Tiết kiệm</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.stage}>
            <Td className="font-mono text-[11px]">{r.stage}</Td>
            <Td>{r.reuse || "—"}</Td>
            <Td>{r.imported || "—"}</Td>
            <Td>{r.local || "—"}</Td>
            <Td>{r.create || "—"}</Td>
            <Td className="font-mono text-[11px]">{formatUSD(r.cost, 6)}</Td>
            <Td className="font-mono text-[11px] text-ok-500">{r.saved > 0 ? `-${formatUSD(r.saved, 6)}` : "—"}</Td>
          </tr>
        ))}
        <tr>
          <Td className="font-mono text-[11px] font-semibold">TỔNG</Td>
          <Td colSpan={4} className="text-[11px] text-ink-500">
            Chi phí tăng thêm = tổng dự toán; tiết kiệm chỉ tính asset thật sự không mua lại.
          </Td>
          <Td className="font-mono text-[11px] font-semibold">{formatUSD(video.estimatedCost, 6)}</Td>
          <Td className="font-mono text-[11px] font-semibold text-ok-500">
            {video.savings.total > 0 ? `-${formatUSD(video.savings.total, 6)}` : "—"}
          </Td>
        </tr>
      </tbody>
    </Table>
  );
}

function readinessTone(readiness: string): "ok" | "warn" | "danger" {
  if (readiness === "READY") return "ok";
  if (readiness === "NEEDS_CHARACTER_REFERENCE") return "danger";
  return "warn";
}

function readinessLabel(readiness: string): string {
  return readiness === "NEEDS_CHARACTER_REFERENCE" ? "NEEDS_REFERENCE" : readiness;
}

/** AUTO / MINIMUM / LOCKED for one scene. Writes the instruction only - nothing is bought. */
function DurationModeSelect({
  sceneId,
  mode,
  onUpdate,
}: {
  sceneId: string | null;
  mode: string;
  onUpdate?: (p: ImportPreflight) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!sceneId) return <span>{mode}</span>;
  return (
    <span className="inline-flex flex-col">
      <select
        aria-label="Chế độ thời lượng"
        className="rounded border border-ink-700 bg-ink-900 px-1 py-0.5 text-[11px]"
        value={mode}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          setError(null);
          try {
            const r = await setSceneDurationMode(sceneId, e.target.value);
            if (r.ok && r.preflight) onUpdate?.(r.preflight);
            else if (!r.ok) setError(r.message);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {DURATION_MODES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      {error ? <span className="text-[10px] text-danger-500">{error}</span> : null}
    </span>
  );
}

function TimingCell({ s, onUpdate }: { s: ImportVideoPreview["scenes"][number]; onUpdate?: (p: ImportPreflight) => void }) {
  const t = s.timing;
  return (
    <div className="space-y-0.5 text-[11px] leading-tight">
      <div>
        Dự kiến {t.planned.toFixed(1)}s · Lời{" "}
        {t.voice === null ? "—" : `${t.voice.toFixed(1)}s${t.voiceEstimated ? " (ước tính)" : ""}`}
      </div>
      <div className={t.blocked ? "text-danger-500" : t.final < t.planned - 0.05 ? "text-ok-500" : ""}>
        <strong>Cuối {t.final.toFixed(1)}s</strong>
      </div>
      <div className="flex items-center gap-1">
        <DurationModeSelect sceneId={s.sceneId} mode={t.mode} onUpdate={onUpdate} />
        <span className="font-mono text-[10px] text-ink-500" title="timingReason">
          {t.reason}
        </span>
      </div>
    </div>
  );
}

function VideoBlock({ video, onUpdate }: { video: ImportVideoPreview; onUpdate?: (p: ImportPreflight) => void }) {
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
          <span className="ml-1 text-xs text-ink-500">/ giới hạn video {formatUSD(video.videoLimit)}</span>
          {video.spend.status === "BLOCKED" ? (
            <span className="ml-1 font-mono text-[10px] text-danger-500">{video.spend.reasonCode}</span>
          ) : null}
          {video.uncappedCost > video.estimatedCost ? (
            <span className="ml-1 text-warn-500">
              (thật ra {formatUSD(video.uncappedCost)})
            </span>
          ) : null}
        </span>
      </div>

      {video.pacing ? (
        <p className="text-xs text-ok-500">
          {video.pacing} (theo lời thoại; lời chưa tạo thì là ước tính — con số thật tính lại lúc render, $0)
        </p>
      ) : null}

      {video.blockedReason ? <FriendlyReason tone="danger" reason={video.blockedReason} /> : null}

      {video.duplicateOf.length > 0 ? (
        <Alert tone="warn">
          Đây là <strong>một bản nhập MỚI</strong> của storyboard đã từng nhập (
          {video.duplicateOf.map((d) => d.title).join(", ")}) — nội dung giống hệt, dấu vân
          tay <code className="font-mono text-[11px]">{video.importFingerprint}</code>. Đây là
          một video riêng (render và output riêng), nhưng asset <strong>giống hệt</strong> đã
          có — ảnh, clip Video AI, giọng cùng đầu vào — được dùng lại ở $0 và hiện là REUSE
          bên dưới. Chỉ phần thật sự khác mới là WILL CREATE.
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
            <Th>Nhịp (lời thoại)</Th>
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
                  <img
                    src={`/api/media/${s.imagePath}`}
                    alt={s.imageFilename ?? `Cảnh ${s.sceneNumber}`}
                    className="h-12 w-7 rounded object-cover"
                  />
                ) : (
                  <span className="text-[11px] text-ink-500">—</span>
                )}
                {s.imageFilename ? (
                  <span className="mt-0.5 block max-w-[7rem] truncate font-mono text-[10px] text-ink-400" title={s.imageFilename}>
                    {s.imageFilename}
                  </span>
                ) : null}
              </Td>
              <Td>{s.duration}</Td>
              <Td>
                <TimingCell s={s} onUpdate={onUpdate} />
              </Td>
              <Td className="text-xs">{s.characters.join(", ") || "—"}</Td>
              <Td className="max-w-[10rem] truncate text-xs">{s.camera || "—"}</Td>
              <Td>
                <Badge tone={s.motionSource === "LOCAL_MOTION" ? "ok" : "info"}>
                  {s.motionSource === "LOCAL_MOTION" ? "LOCAL_FREE" : "VIDEO_AI"}
                </Badge>
                {/* G7: the motion part by part - only the subject's Video AI movement is paid. */}
                <ul className="mt-1 space-y-0.5 text-[10px] leading-tight">
                  {(s.motionParts ?? []).map((p) => (
                    <li key={p.part} className={p.cost > 0 ? "text-warn-500" : "text-ink-400"} title={p.how}>
                      {p.label}: {p.cost > 0 ? `Video AI ~${formatUSD(p.cost)}` : "tại máy $0"}
                    </li>
                  ))}
                </ul>
              </Td>
              <Td>
                <Badge tone={IMAGE_SOURCE_TONE[s.imageSource]}>{s.imageSource}</Badge>
              </Td>
              <Td>
                <AssetCell s={s} kind="image" />
              </Td>
              <Td>
                <AssetCell s={s} kind="video" />
              </Td>
              <Td>
                <AssetCell s={s} kind="voice" />
              </Td>
              <Td className="font-mono text-[11px]">{s.videoModel ?? "—"}</Td>
              <Td>
                {formatUSD(s.estimatedCost)}
                {s.spendLimit !== null ? (
                  <span className="block text-[10px] text-ink-500">giới hạn cảnh {formatUSD(s.spendLimit)}</span>
                ) : null}
                {s.spend.status === "BLOCKED" ? (
                  <span className="block font-mono text-[10px] text-danger-500">{s.spend.reasonCode}</span>
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <StageTable video={video} />

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

/**
 * X - Y = Z, exactly: what the runnable videos would cost if every asset were
 * bought new, what reuse and imported pictures keep in the wallet, and what
 * this run really adds. Only assets that will really not be bought count as
 * saved - LOCAL_MOTION is free compute, not a saving.
 */
export function SavingsSummary({ preflight }: { preflight: Pick<ImportPreflight, "savings" | "ifCreatedNew" | "estimatedTotal"> }) {
  const sv = preflight.savings;
  return (
    <div className="rounded-lg border border-ok-500/40 bg-ok-500/5 p-3">
      <h4 className="mb-2 text-sm font-medium">Tái sử dụng — tiết kiệm</h4>
      <div className="grid gap-1 font-mono text-xs md:grid-cols-3">
        <div>
          TỔNG DỰ TOÁN NẾU TẠO MỚI: <strong>{formatUSD(preflight.ifCreatedNew, 6)}</strong>
        </div>
        <div className="text-ok-500">
          TÁI SỬ DỤNG / IMPORTED TIẾT KIỆM: <strong>-{formatUSD(sv.total, 6)}</strong>
        </div>
        <div>
          CHI PHÍ TĂNG THÊM THỰC TẾ: <strong>{formatUSD(preflight.estimatedTotal, 6)}</strong>
        </div>
        <div className="text-ink-400">ảnh -{formatUSD(sv.image, 6)}</div>
        <div className="text-ink-400">clip -{formatUSD(sv.video, 6)}</div>
        <div className="text-ink-400">giọng -{formatUSD(sv.voice, 6)}</div>
      </div>
    </div>
  );
}

/**
 * QĐ-113: the money that adds up. REQUIRED = what this run creates and pays for;
 * RECOMMENDED = REQUIRED + paid QA (only when switched on) + retry reserve.
 * Reused / imported values are what those assets cost before - not spent now.
 */
export function ReconciliationSummary({ preflight }: { preflight: Pick<ImportPreflight, "reconciliation"> }) {
  const r = preflight.reconciliation;
  const line = (label: string, value: string, tone = "") => (
    <div className={`flex justify-between gap-3 ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
  return (
    <div className="rounded-lg border border-ink-800 p-3">
      <h4 className="mb-2 text-sm font-medium">Đối soát chi phí</h4>
      <div className="grid gap-x-6 gap-y-1 font-mono text-xs md:grid-cols-2">
        {line("NEW GENERATION COST (tạo mới, phải trả)", formatUSD(r.newGeneration, 6))}
        {line("REUSED VALUE (dùng lại, $0 lần này)", formatUSD(r.reusedValue, 6), "text-ok-500")}
        {line("IMPORTED VALUE (ảnh nhập, $0)", formatUSD(r.importedValue, 6), "text-ok-500")}
        {line("LOCAL FREE (FFmpeg tại máy)", `${r.localFreeScenes} cảnh · $0`, "text-ink-400")}
        {line("CHUYỂN ĐỘNG TẠI MÁY (camera / nền / ambient / ghép lớp)", `${r.localMotionParts ?? 0} phần · $0`, "text-ok-500")}
        {line("CHUYỂN ĐỘNG VIDEO AI (chủ thể, trả phí — đã nằm trong tạo mới)", `${r.paidMotion?.parts ?? 0} phần · ${formatUSD(r.paidMotion?.cost ?? 0, 6)}`)}
        {line(
          `OPTIONAL QA (AI trả phí ${r.paidQaEnabled ? "ĐANG BẬT" : "TẮT"})`,
          r.paidQaEnabled ? formatUSD(r.enabledQa, 6) : `${formatUSD(r.optionalQa, 6)} — không cộng`,
          "text-ink-400",
        )}
        {line("RETRY RESERVE", formatUSD(r.retryReserve, 6))}
        {line("REQUIRED TOTAL", formatUSD(r.requiredTotal, 6))}
        {line("RECOMMENDED AUTHORIZATION", formatUSD(r.recommendedAuthorization, 6))}
      </div>
      <p className={`mt-2 text-[11px] ${r.reconciles ? "text-ink-500" : "text-danger-500"}`}>
        RECOMMENDED = REQUIRED + QA đã bật + RETRY RESERVE.{" "}
        {r.reconciles ? "Khớp với dự toán." : "KHÔNG khớp với dự toán — hãy báo lỗi này."} Giá trị dùng lại /
        nhập không cộng vào tổng.
      </p>
    </div>
  );
}

export function PreflightPanel({
  preflight,
  batchId,
  onUpdate,
}: {
  preflight: ImportPreflight;
  batchId: string | null;
  /** Receives a fresh preflight after a per-scene timing edit. */
  onUpdate?: (p: ImportPreflight) => void;
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
          <VideoBlock key={v.projectId} video={v} onUpdate={onUpdate} />
        ))}

        {/* ---- what reuse keeps in the wallet (QĐ-112) ---- */}
        <SavingsSummary preflight={preflight} />
        <ReconciliationSummary preflight={preflight} />

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
