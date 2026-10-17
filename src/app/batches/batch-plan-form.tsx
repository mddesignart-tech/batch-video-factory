"use client";

import { useMemo, useState } from "react";
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
import { analyseBatch, writeBatchScripts } from "@/app/actions/batches";
import type { BatchPlan } from "@/services/batch-planner";
import { formatUSD } from "@/lib/utils";
import { CreativeStylePicker } from "@/components/creative-style-picker";
import { templateOf } from "@/domain/content-templates";
import {
  creativeSummary,
  idiomPlan,
  idiomRoleLabel,
  resolveCreativeStyle,
  storedCreativeJson,
  type StoredCreativeStyle,
  type TemplateCreative,
} from "@/domain/creative-style";
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

/**
 * PHONG CÁCH for the whole batch (QĐ-136): the single-video Creative Style
 * Engine, same picker. Simple: preset, hài, nhịp, punchline; cảm xúc, kiểu hài
 * and năng lượng sit under Nâng cao.
 */
const BATCH_CREATIVE: TemplateCreative = {
  ...templateOf("ENGLISH_IDIOM").creative,
  simpleFields: ["preset", "comedyLevel", "pacingStyle", "punchlineMode"],
};
const AMOUNT_SHORTCUTS = [1, 2, 3, 5, 10];

const STATUS_TONE: Record<VideoPlanStatus, "ok" | "warn" | "danger"> = {
  OK: "ok",
  OVER_VIDEO_BUDGET: "danger",
  OVER_SCENE_BUDGET: "danger",
  NEEDS_PROVIDER: "warn",
  NEEDS_CHARACTER_REFERENCE: "danger",
  NEEDS_PROVIDER_CONFIRMATION: "danger",
};

export function BatchPlanForm({
  presets,
  categories,
  difficulties,
  availableIdioms,
  defaultMaxCostPerVideo,
  defaultName,
}: {
  presets: { id: string; name: string }[];
  categories: string[];
  difficulties: string[];
  availableIdioms: number;
  defaultMaxCostPerVideo: number;
  /** "Batch Video Factory #00N", the next free number (QĐ-137). */
  defaultName: string;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(3);
  const [mode, setMode] = useState<QualityMode>("BALANCED");
  const [maxPerVideo, setMaxPerVideo] = useState(defaultMaxCostPerVideo);
  const [duration, setDuration] = useState(25);
  const [creative, setCreative] = useState<Partial<StoredCreativeStyle>>({ preset: "AUTO" });
  // What the writer will be asked for - the same idiomPlan the writer uses.
  const preview = useMemo(() => {
    const json = storedCreativeJson(creative);
    if (!json) return null;
    const effective = resolveCreativeStyle(BATCH_CREATIVE, JSON.parse(json) as StoredCreativeStyle);
    const roles = idiomPlan(effective, duration);
    return {
      summary: creativeSummary(effective),
      roles: roles.map((r) => idiomRoleLabel(r, effective.comedyLevel)),
      perScene: Math.round((duration / roles.length) * 10) / 10,
    };
  }, [creative, duration]);

  const [planning, setPlanning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);

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
      }
    } finally {
      setPlanning(false);
    }
  };

  // QĐ-139: the real scripts come first; money is approved on the batch page,
  // priced from them. The sample-script figures above are only a rough guide.
  const runWriteScripts = async () => {
    if (!batchId) return;
    setApproving(true);
    try {
      const res = await writeBatchScripts(batchId);
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
                  defaultValue={defaultName}
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

              <Field label="Phong cách hình ảnh">
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
                  value={duration}
                  onChange={(e) => setDuration(Number(e.currentTarget.value) || 25)}
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

            <div className="mt-4 rounded-lg border border-ink-800 p-3">
              <p className="mb-2 text-sm font-semibold text-ink-200">PHONG CÁCH (áp cho cả lô)</p>
              <CreativeStylePicker creative={BATCH_CREATIVE} onChange={setCreative} />
              <p className="mt-2 text-xs text-ink-400">
                {preview ? (
                  <>
                    <span className="font-medium text-ink-200">{preview.summary}</span> · mỗi video{" "}
                    {preview.roles.length} cảnh × ~{preview.perScene}s: {preview.roles.join(" → ")}
                  </>
                ) : (
                  "Tự động: giữ bộ viết kịch bản thành ngữ gốc (như các lô trước)."
                )}
              </p>
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
              <CardTitle>2. Viết kịch bản thật (chỉ Text AI — chưa mua ảnh / clip / giọng)</CardTitle>
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
                      Ước tính sơ bộ CHẠY THẬT — theo kịch bản mẫu, KHÔNG dùng để duyệt
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

              {plan.warnings.length > 0 ? (
                <Alert tone="warn" title="Cần đọc trước khi viết kịch bản">
                  <ul className="list-inside list-disc space-y-0.5 text-xs">
                    {plan.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              <Alert tone="info" title="Chi phí chỉ được duyệt theo kịch bản thật">
                Các con số ở trên tính theo kịch bản MẪU. Bước này chỉ viết kịch bản thật cho{" "}
                {plan.runnableCount} video (Text AI, ước tính{" "}
                {formatUSD(
                  (plan.production ?? plan.runtime).videos
                    .filter((v) => v.status === "OK")
                    .reduce((n, v) => n + v.breakdown.text, 0),
                  4,
                )}
                ) — không mua ảnh, clip hay giọng. Sau đó trang lô chạy PREFLIGHT trên từng cảnh thật
                (Local / Ảnh AI / Video AI / Giọng và model cụ thể), bạn xem một con số dự toán và tự nhập
                trần chi rồi mới DUYỆT &amp; CHẠY.
              </Alert>

              <Button
                variant="primary"
                disabled={approving || plan.runnableCount === 0}
                onClick={() => void runWriteScripts()}
              >
                {approving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                VIẾT KỊCH BẢN THẬT
              </Button>
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
