"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { ActionFeedback, type ActionResult } from "@/components/action-ui";
import { analyseBatch, approveBatch } from "@/app/actions/batches";
import type { BatchPlan } from "@/services/batch-planner";
import { formatUSD } from "@/lib/utils";
import { VI_COST_BASIS, VI_COST_BASIS_SHORT } from "@/domain/cost-basis";
import {
  VI_MOTION_SOURCE,
  VI_QUALITY_MODE,
  VI_VIDEO_PLAN_STATUS,
  type QualityMode,
  type VideoPlanStatus,
} from "@/domain/enums";

/**
 * The two-step batch form.
 *
 * Step A is free and can be repeated. Step B is the only control on this page
 * that can cause a charge, and it is deliberately not reachable until a plan
 * exists and has been rendered on screen: the approve button and the numbers it
 * is approving are never separated by a page load.
 *
 * CUSTOM is absent from the mode list on purpose. It means "pick a model per
 * scene by hand", which cannot be answered once for a whole batch - and offering
 * it here would silently behave as BALANCED.
 */

const BATCH_MODES: QualityMode[] = ["ECONOMY", "BALANCED", "QUALITY"];
const AMOUNT_SHORTCUTS = [1, 2, 3, 5, 10];

const STATUS_TONE: Record<VideoPlanStatus, "ok" | "warn" | "danger"> = {
  OK: "ok",
  OVER_VIDEO_BUDGET: "danger",
  NEEDS_PROVIDER: "warn",
};

export function BatchPlanForm({
  presets,
  categories,
  difficulties,
  availableIdioms,
  defaultMaxCostPerVideo,
}: {
  presets: { id: string; name: string }[];
  categories: string[];
  difficulties: string[];
  availableIdioms: number;
  defaultMaxCostPerVideo: number;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(3);
  const [mode, setMode] = useState<QualityMode>("BALANCED");
  const [maxPerVideo, setMaxPerVideo] = useState(defaultMaxCostPerVideo);

  const [planning, setPlanning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [ceiling, setCeiling] = useState<number>(0);

  const runPlan = async (formData: FormData) => {
    setPlanning(true);
    setPlan(null);
    try {
      // Re-plan into the row we already made rather than leaving a trail of
      // abandoned drafts behind every adjustment.
      if (batchId) formData.set("batchId", batchId);
      const res = await analyseBatch(formData);
      setResult(res);
      if (res.ok && res.plan && res.batchId) {
        setPlan(res.plan);
        setBatchId(res.batchId);
        setCeiling(res.plan.suggestedAuthorizedMaxSpend);
      }
    } finally {
      setPlanning(false);
    }
  };

  const runApprove = async () => {
    if (!batchId) return;
    setApproving(true);
    try {
      const res = await approveBatch(batchId, ceiling);
      setResult(res);
      if (res.ok) router.push(`/batches/${batchId}`);
    } finally {
      setApproving(false);
    }
  };

  const notEnoughIdioms = amount > availableIdioms;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>1. Lập kế hoạch (miễn phí)</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void runPlan(new FormData(event.currentTarget));
            }}
          >
            <div className="grid gap-3 lg:grid-cols-3">
              <Field label="Tên lô">
                <Input
                  name="name"
                  defaultValue="Batch Video Factory #001"
                  required
                />
              </Field>

              <Field
                label="Số lượng video"
                hint={`${availableIdioms} thành ngữ chưa dùng trong thư viện`}
              >
                <div className="flex gap-1.5">
                  {AMOUNT_SHORTCUTS.map((n) => (
                    <Button
                      key={n}
                      type="button"
                      size="sm"
                      variant={amount === n ? "primary" : "outline"}
                      onClick={() => setAmount(n)}
                    >
                      {n}
                    </Button>
                  ))}
                  <Input
                    name="amount"
                    type="number"
                    min={1}
                    max={200}
                    value={amount}
                    onChange={(e) => setAmount(Number(e.currentTarget.value) || 1)}
                    className="w-20"
                  />
                </div>
              </Field>

              <Field label="Chế độ">
                <Select
                  name="qualityMode"
                  value={mode}
                  onChange={(e) => setMode(e.currentTarget.value as QualityMode)}
                >
                  {BATCH_MODES.map((m) => (
                    <option key={m} value={m}>
                      {VI_QUALITY_MODE[m]}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Hạn mức tối đa / video (USD)"
                hint="Video nào dự toán vượt mức này sẽ bị đánh dấu OVER_VIDEO_BUDGET và KHÔNG tự chạy."
              >
                <Input
                  name="maxCostPerVideo"
                  type="number"
                  min={0}
                  step="0.1"
                  value={maxPerVideo}
                  onChange={(e) =>
                    setMaxPerVideo(Number(e.currentTarget.value) || 0)
                  }
                />
              </Field>

              <Field label="Chủ đề (tuỳ chọn)">
                <Select name="category" defaultValue="">
                  <option value="">Mọi chủ đề</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Độ khó (tuỳ chọn)">
                <Select name="difficulty" defaultValue="">
                  <option value="">Mọi độ khó</option>
                  {difficulties.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Phong cách">
                <Select name="stylePresetId" defaultValue={presets[0]?.id ?? ""}>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Thời lượng mục tiêu (giây)">
                <Input
                  name="targetDuration"
                  type="number"
                  min={15}
                  max={60}
                  defaultValue={25}
                />
              </Field>

              <Field
                label="Số job chạy song song"
                hint="Giữ thấp để không gọi nhiều API tính phí cùng lúc."
              >
                <Input
                  name="concurrency"
                  type="number"
                  min={1}
                  max={8}
                  defaultValue={2}
                />
              </Field>
            </div>

            {notEnoughIdioms ? (
              <Alert tone="warn" title="Không đủ thành ngữ" className="mt-3">
                Bạn yêu cầu {amount} video nhưng chỉ còn {availableIdioms} thành
                ngữ chưa dùng. Lô sẽ chỉ chạy {availableIdioms} video.
              </Alert>
            ) : null}

            <div className="mt-4">
              <Button type="submit" variant="primary" disabled={planning}>
                {planning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                PHÂN TÍCH &amp; DỰ TOÁN
              </Button>
              <span className="ml-3 text-xs text-ink-500">
                Bước này chỉ đọc dữ liệu, không gọi API nào có tính phí.
              </span>
            </div>
          </form>

          {result ? (
            <div className="mt-3">
              <ActionFeedback result={result} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {plan ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Bảng dự toán ({plan.videos.length} video)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <thead>
                  <tr>
                    <Th>Video</Th>
                    <Th className="text-right">Cảnh</Th>
                    <Th className="text-right">Cảnh local ($0)</Th>
                    <Th className="text-right">Cảnh Video AI</Th>
                    <Th>Nhà cung cấp</Th>
                    <Th className="text-right">Dự toán</Th>
                    <Th>Trạng thái</Th>
                  </tr>
                </thead>
                <tbody>
                  {plan.videos.map((video) => (
                    <tr key={video.idiomId} className="align-top">
                      <Td className="font-medium text-ink-100">
                        {video.phrase}
                        <span className="mt-0.5 block text-[11px] font-normal text-ink-500">
                          {video.basis === "real-script"
                            ? "theo kịch bản thật"
                            : "theo kịch bản mẫu — chưa có kịch bản thật"}
                        </span>
                      </Td>
                      <Td className="text-right tabular-nums text-ink-300">
                        {video.sceneCount}
                      </Td>
                      <Td className="text-right tabular-nums text-ok-500">
                        {video.localMotionScenes}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-100">
                        {video.aiVideoScenes}
                      </Td>
                      <Td className="text-xs text-ink-400">
                        {video.providers.length > 0
                          ? video.providers.join(", ")
                          : "— (mock)"}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-100">
                        {formatUSD(video.estimatedCost, 4)}
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONE[video.status]}>
                          {VI_VIDEO_PLAN_STATUS[video.status]}
                        </Badge>
                        {video.warnings.length > 0 ? (
                          <ul className="mt-1 max-w-sm list-inside list-disc space-y-0.5 text-[11px] text-ink-500">
                            {video.warnings.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Chi tiết cảnh — nguồn chuyển động</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              {plan.videos.slice(0, 3).map((video) => (
                <div key={video.idiomId}>
                  <p className="font-medium text-ink-200">{video.phrase}</p>
                  <ul className="mt-1 space-y-0.5 text-ink-500">
                    {video.scenes.map((scene) => (
                      <li key={scene.sceneNumber}>
                        Cảnh {scene.sceneNumber} ({scene.complexity}) —{" "}
                        <span
                          className={
                            scene.motionSource === "LOCAL_MOTION"
                              ? "text-ok-500"
                              : "text-accent-500"
                          }
                        >
                          {VI_MOTION_SOURCE[scene.motionSource]}
                        </span>
                        {scene.videoModel ? ` · ${scene.videoModel}` : ""} ·{" "}
                        {formatUSD(scene.estimatedCost, 4)} — {scene.motionReason}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {plan.videos.length > 3 ? (
                <p className="text-ink-600">
                  … và {plan.videos.length - 3} video nữa có cấu trúc tương tự.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Duyệt chi (đây là bước tiêu tiền)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/*
                Two costings, never blended.

                `runtime` is what will actually run - in Mock Mode that is mock
                prices, which are SIMULATED and are not close to real ones. For
                a long time this panel printed exactly that figure under the
                label "Tổng chi phí dự kiến", which made a made-up number look
                like a forecast of real spending.
              */}
              {plan.production ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-brand-500/40 bg-brand-500/5 px-4 py-3">
                    <p className="text-[11px] font-medium tracking-wide text-brand-400 uppercase">
                      Dự toán CHẠY THẬT — dùng số này để duyệt
                    </p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums text-brand-400">
                      {formatUSD(plan.production.estimatedTotal, 4)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      giá niêm yết của {plan.production.providerScope.join(", ") || "nhà cung cấp thật"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-ink-800 bg-ink-850 px-4 py-3">
                    <p className="text-[11px] font-medium tracking-wide text-ink-500 uppercase">
                      {VI_COST_BASIS_SHORT[plan.runtime.costBasis]} — chỉ để thử logic
                    </p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-400">
                      {formatUSD(plan.runtime.estimatedTotal, 4)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-600">
                      {plan.runtime.costBasis === "MOCK"
                        ? "giá giả lập, KHÔNG phải tiền"
                        : "chi phí khi chạy ngay bây giờ"}
                    </p>
                  </div>
                </div>
              ) : (
                <Alert tone="warn" title="Không có dự toán chạy thật">
                  Chưa có nhà cung cấp thật nào được cấu hình, nên không thể dự
                  toán chi phí thật. Con số bên dưới là{" "}
                  <strong>{VI_COST_BASIS[plan.runtime.costBasis]}</strong>.
                </Alert>
              )}

              <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <SummaryRow label="Số video sẽ chạy" value={String(plan.runnableCount)} />
                <SummaryRow
                  label="Hạn mức / video"
                  value={formatUSD(plan.maxCostPerVideo)}
                />
                <SummaryRow label="Chế độ" value={VI_QUALITY_MODE[plan.qualityMode]} />
                <SummaryRow
                  label="Nhà cung cấp sẽ tính tiền"
                  value={
                    plan.production?.providerScope.join(", ") ||
                    plan.providerScope.join(", ") ||
                    "— (mock, $0)"
                  }
                />
                <SummaryRow
                  label="Hạn mức tổng còn lại"
                  value={formatUSD(plan.globalCap.remaining, 4)}
                />
                <SummaryRow
                  label="Cảnh dùng FFmpeg ($0)"
                  value={String(
                    (plan.production ?? plan.runtime).videos.reduce(
                      (n, v) => n + v.localMotionScenes,
                      0,
                    ),
                  )}
                />
                <SummaryRow
                  label="Cảnh gọi Video AI"
                  value={String(
                    (plan.production ?? plan.runtime).videos.reduce(
                      (n, v) => n + v.aiVideoScenes,
                      0,
                    ),
                  )}
                />
                <SummaryRow
                  label="Cảnh thiếu provider được duyệt"
                  value={String(plan.production?.needsProvider.length ?? 0)}
                />
              </div>

              <div className="rounded-lg border border-ink-800 bg-ink-850 p-4">
                <div className="mb-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <p className="text-[11px] text-ink-500">Estimated</p>
                    <p className="font-semibold tabular-nums text-ink-100">
                      {formatUSD(plan.recommendation.estimated, 4)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-ink-500">
                      Recommended maximum (+
                      {(plan.recommendation.safetyMarginPct * 100).toFixed(0)}% dự phòng)
                    </p>
                    <p className="font-semibold tabular-nums text-brand-400">
                      {formatUSD(plan.recommendation.recommended, 4)}
                      {plan.recommendation.clampedByGlobalCap ? (
                        <span className="ml-2 text-[11px] font-normal text-warn-500">
                          (đã hạ theo hạn mức tổng)
                        </span>
                      ) : null}
                    </p>
                  </div>
                </div>
                <Field
                  label="MAXIMUM AUTHORIZED SPEND cho cả lô (USD)"
                  hint="Số này do bạn nhập, không phải hệ thống tự duyệt. Lô tuyệt đối không chi vượt. Mỗi request đều được kiểm tra trước khi gửi."
                >
                  <Input
                    type="number"
                    min={0}
                    step="0.1"
                    value={ceiling}
                    onChange={(e) => setCeiling(Number(e.currentTarget.value) || 0)}
                    className="max-w-xs"
                  />
                </Field>
              </div>

              {plan.warnings.length > 0 ? (
                <Alert tone="warn" title="Cần đọc trước khi duyệt">
                  <ul className="list-inside list-disc space-y-0.5 text-xs">
                    {plan.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              {ceiling > plan.globalCap.remaining ? (
                <Alert tone="danger" title="Vượt hạn mức toàn ứng dụng">
                  Hạn mức tổng chỉ còn {formatUSD(plan.globalCap.remaining, 4)}.
                  Không duyệt được số lớn hơn.
                </Alert>
              ) : null}

              <Button
                variant="primary"
                disabled={
                  approving ||
                  ceiling <= 0 ||
                  ceiling > plan.globalCap.remaining ||
                  plan.runnableCount === 0
                }
                onClick={() => void runApprove()}
              >
                {approving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                DUYỆT &amp; CHẠY BATCH
              </Button>
              <p className="text-xs text-ink-500">
                Sau khi duyệt, lô chạy tự động: kịch bản → ảnh → video → giọng →
                phụ đề → trộn → render → MP4. Hệ thống sẽ KHÔNG hỏi lại từng cảnh.
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-850 px-3 py-2">
      <p className="text-[11px] text-ink-500">{label}</p>
      <p className="mt-0.5 font-semibold tabular-nums text-ink-100">{value}</p>
    </div>
  );
}
