"use client";

import { useState } from "react";
import { Ban, Check, Image as ImageIcon, Mic, Video } from "lucide-react";
import { ImageReview, type ImageModelChoice } from "./image-review";
import { SceneImagePanel } from "./scene-image-panel";
import { SceneVoicePanel } from "./scene-voice-panel";
import { VideoSelectionPanel } from "./video-selection-panel";
import { isNeedsSelection, needsSelectionMessage } from "@/domain/video-selection";
import { aspectOf, effectiveFit, type FitMode } from "@/domain/platform-profile";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import { usesAuthorSubtitle } from "@/domain/scene-subtitles";
import { budgetProblem } from "@/domain/budget-message";
import { BudgetProblemBox } from "@/components/video-budget";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import { ActionButton, ActionForm, type ActionResult } from "@/components/action-ui";
import {
  approveScene,
  regenerateSceneAsset,
  skipScene,
  updateScene,
} from "@/app/actions/projects";
import { formatUSD } from "@/lib/utils";
import {
  COMPLEXITIES,
  ROUTER_STRATEGIES,
  VI_COMPLEXITY,
  VI_ROUTER_STRATEGY,
  type Complexity,
} from "@/domain/enums";

/**
 * Storyboard editor.
 *
 * Three panes, as specified: scene list on the left, preview in the centre,
 * scene settings on the right. The centre pane shows the routing decision for
 * the selected scene, because per-scene model choice is the feature that makes
 * the cost numbers on this page mean anything.
 */

export interface SceneView {
  id: string;
  sceneNumber: number;
  duration: number;
  visualDescription: string;
  dialogue: string;
  narration: string;
  subtitle: string;
  camera: string;
  characterAction: string;
  soundEffect: string;
  imagePrompt: string;
  videoPrompt: string;
  complexity: string;
  spendPriority: string;
  routingMode: string;
  videoProvider: string | null;
  videoModel: string | null;
  /** A person pinned the video model (QĐ-069). */
  videoModelPinned?: boolean;
  imageProvider: string | null;
  imageModel: string | null;
  voiceModel: string | null;
  estimatedCost: number;
  actualCost: number;
  imagePath: string | null;
  /** GENERATED or IMPORTED. IMPORTED = REUSE = $0 Image API. */
  imageSource: string;
  /** The person's motion instruction: AUTO, LOCAL_MOTION or VIDEO_AI. */
  motionMode: string;
  videoPath: string | null;
  audioPath: string | null;
  qualityScore: number | null;
  status: string;
  approved: boolean;
  skipped: boolean;
  /** Everyone visible in frame - the list that drives image generation. */
  charactersPresent: string[];
  /** Only those with a line. Drives voice, not images. */
  speakingCharacters: string[];
  /** The focus of the shot. First in line for a reference image. */
  primaryCharacters: string[];
  errorMessage: string | null;
}

export type { ImageModelChoice };

export interface RoutingView {
  image: string | null;
  video: string | null;
  voice: string | null;
  reason: string;
  estimatedCost: number;
  error: string | null;
  /** Estimated price of "Tạo lại ảnh" / "Tạo lại video" (0 = local, null = unknown). */
  imageRegenCost?: number | null;
  videoRegenCost?: number | null;
  /** The plan's "no model may run this scene" text (QĐ-120), shown friendly. */
  needsSelection?: string | null;
}

interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
  price: number;
  priceUnit: string;
}

const COMPLEXITY_TONE: Record<string, "neutral" | "info" | "warn"> = {
  LOW: "neutral",
  MEDIUM: "info",
  HIGH: "warn",
};

const PRIORITY_LABEL: Record<string, string> = {
  HIGH: "Ưu tiên cao",
  NORMAL: "Bình thường",
  LOW: "Ưu tiên thấp",
};

export function Storyboard({
  projectId,
  videoLimit,
  frame,
  frameFit,
  idiomPhrase,
  scenes,
  routingByScene,
  videoModels,
  imageModels,
  allCharacters,
  qualityMode,
}: {
  projectId: string;
  /** The video's own budget (NGÂN SÁCH VIDEO), for the "Tăng ngân sách video" button. */
  videoLimit: number | null;
  /** The output frame (QĐ-121): the preview is drawn in this shape. */
  frame?: { width: number; height: number };
  /** The profile's fit mode, so the preview frames pictures like the render. */
  frameFit?: FitMode;
  idiomPhrase: string;
  scenes: SceneView[];
  routingByScene: Record<number, RoutingView>;
  videoModels: ModelOption[];
  imageModels: ImageModelChoice[];
  allCharacters: { id: string; name: string }[];
  /** Project quality mode, which decides whether alternatives are offered. */
  qualityMode: string;
}) {
  const [selectedId, setSelectedId] = useState(scenes[0]?.id ?? "");
  const [result, setResult] = useState<ActionResult | null>(null);

  const selected = scenes.find((s) => s.id === selectedId) ?? scenes[0];
  if (!selected) return null;

  const routing = routingByScene[selected.sceneNumber];
  // Subtitles come from the voice's own ordered lines (QĐ-122): with two or
  // more speakers every line shows, not the one line the stored field holds.
  const voiceLines = parseDialogueLines(selected.dialogue, selected.narration, selected.speakingCharacters);
  const subtitleText = usesAuthorSubtitle(voiceLines.length, selected.subtitle)
    ? selected.subtitle
    : voiceLines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join(" / ");
  // The preview is the final video's shape: vertical, landscape or square.
  const frameCss = `${frame?.width ?? 1080} / ${frame?.height ?? 1920}`;
  // A scene no video model may run automatically: a choice, shown as one (QĐ-120).
  const selectionMessage = isNeedsSelection(selected.errorMessage)
    ? selected.errorMessage
    : routing?.needsSelection && !selected.videoPath
      ? needsSelectionMessage({ sceneNumber: selected.sceneNumber, complexity: selected.complexity, diagnostics: routing.needsSelection })
      : null;
  const totalDuration = scenes
    .filter((s) => !s.skipped)
    .reduce((sum, s) => sum + s.duration, 0);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Storyboard</CardTitle>
        <span className="text-xs text-ink-500">
          {scenes.filter((s) => !s.skipped).length} cảnh ·{" "}
          {totalDuration.toFixed(1)}s tổng thời lượng
        </span>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid lg:grid-cols-[220px_1fr_320px]">
          {/* LEFT: scene list */}
          <div className="border-ink-800 lg:border-r">
            <div className="max-h-[720px] overflow-y-auto p-2">
              {scenes.map((scene) => {
                const active = scene.id === selected.id;
                return (
                  <button
                    key={scene.id}
                    onClick={() => setSelectedId(scene.id)}
                    className={`mb-1.5 w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      active
                        ? "border-brand-500/50 bg-brand-500/10"
                        : "border-ink-800 bg-ink-850 hover:border-ink-700"
                    } ${scene.skipped ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-ink-100">
                        Cảnh {scene.sceneNumber}
                      </span>
                      <span className="text-[11px] text-ink-500">
                        {scene.duration.toFixed(1)}s
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-400">
                      {scene.subtitle || scene.visualDescription}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <Badge tone={COMPLEXITY_TONE[scene.complexity] ?? "neutral"}>
                        {VI_COMPLEXITY[scene.complexity as Complexity] ??
                          scene.complexity}
                      </Badge>
                      {scene.spendPriority === "HIGH" ? (
                        <Badge tone="brand">Ưu tiên</Badge>
                      ) : null}
                      {scene.skipped ? <Badge tone="danger">Bỏ qua</Badge> : null}
                      <Badge
                        tone={
                          scene.imageSource === "IMPORTED" && scene.imagePath
                            ? "ok"
                            : scene.imagePath
                              ? "info"
                              : "warn"
                        }
                      >
                        {scene.imageSource === "IMPORTED" && scene.imagePath
                          ? "Ảnh nhập"
                          : scene.imagePath
                            ? "Ảnh AI"
                            : "Chưa có ảnh"}
                      </Badge>
                      {scene.motionMode !== "AUTO" ? (
                        <Badge tone={scene.motionMode === "VIDEO_AI" ? "brand" : "neutral"}>
                          {scene.motionMode === "VIDEO_AI" ? "VIDEO_AI" : "LOCAL"}
                        </Badge>
                      ) : null}
                      {scene.approved ? <Badge tone="ok">Đã duyệt</Badge> : null}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 text-ink-600">
                      <ImageIcon
                        className={`h-3 w-3 ${scene.imagePath ? "text-ok-500" : ""}`}
                      />
                      <Video
                        className={`h-3 w-3 ${scene.videoPath ? "text-ok-500" : ""}`}
                      />
                      <Mic
                        className={`h-3 w-3 ${scene.audioPath ? "text-ok-500" : ""}`}
                      />
                      <span className="ml-auto text-[10px] tabular-nums text-ink-500">
                        {formatUSD(scene.estimatedCost)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* CENTER: preview */}
          <div className="border-ink-800 p-4 lg:border-r">
            <div className="mx-auto w-full max-w-[280px]">
              <div className="relative overflow-hidden rounded-xl border border-ink-700 bg-black">
                {selected.videoPath ? (
                  <video
                    key={selected.videoPath}
                    src={`/api/media/${selected.videoPath}`}
                    controls
                    playsInline
                    style={{ aspectRatio: frameCss }}
                    className="w-full object-cover"
                  />
                ) : selected.imagePath ? (
                  <FramedImage
                    key={selected.imagePath}
                    src={`/api/media/${selected.imagePath}`}
                    alt={`Cảnh ${selected.sceneNumber}`}
                    frame={frame ?? { width: 1080, height: 1920 }}
                    fit={frameFit ?? "AUTO"}
                  />
                ) : (
                  <div style={{ aspectRatio: frameCss }}
                    className="flex w-full flex-col items-center justify-center gap-2 text-center text-xs text-ink-600">
                    <Video className="h-8 w-8" />
                    <span>Chưa có media cho cảnh này</span>
                    <span className="text-[10px]">
                      Bấm TẠO MEDIA ở trên để sinh
                    </span>
                  </div>
                )}
              </div>

              {selected.audioPath ? (
                <audio
                  key={selected.audioPath}
                  src={`/api/media/${selected.audioPath}`}
                  controls
                  className="mt-2 w-full"
                />
              ) : null}
            </div>

            <div className="mt-4 space-y-2 text-xs">
              <PreviewRow label="Lời thoại" value={selected.dialogue} />
              <PreviewRow label="Phụ đề" value={subtitleText} />
              <PreviewRow label="Hình ảnh" value={selected.visualDescription} />
              <PreviewRow label="Hành động" value={selected.characterAction} />
              <PreviewRow label="Máy quay" value={selected.camera} />
              <PreviewRow label="Âm thanh" value={selected.soundEffect} />
              <PreviewRow
                label="Trong khung hình"
                value={selected.charactersPresent.join(", ") || "-"}
              />
              <PreviewRow
                label="Có thoại"
                value={selected.speakingCharacters.join(", ") || "không ai"}
              />
              <PreviewRow
                label="Trọng tâm"
                value={selected.primaryCharacters.join(", ") || "-"}
              />
            </div>

            {routing ? (
              <div className="mt-4 rounded-lg border border-ink-800 bg-ink-850 p-3">
                <p className="mb-2 text-xs font-semibold text-ink-200">
                  AI Router đề xuất cho cảnh này
                </p>
                <div className="space-y-1 text-[11px]">
                  <RoutingRow label="Ảnh" value={routing.image} />
                  <RoutingRow label="Video" value={routing.video} />
                  <RoutingRow label="Giọng" value={routing.voice} />
                  <div className="flex justify-between pt-1">
                    <span className="text-ink-500">Ước tính</span>
                    <span className="tabular-nums text-brand-400">
                      {formatUSD(routing.estimatedCost)}
                    </span>
                  </div>
                </div>
                {routing.reason ? (
                  <p className="mt-2 border-t border-ink-800 pt-2 text-[11px] text-ink-500">
                    Lý do: {routing.reason}
                  </p>
                ) : null}
                {routing.needsSelection ? (
                  <p className="mt-2 text-[11px] text-warn-500">
                    Video AI: cần chọn thủ công (xem khung bên dưới).
                  </p>
                ) : routing.error ? (
                  <p className="mt-2 text-[11px] text-danger-500">
                    {routing.error}
                  </p>
                ) : null}
              </div>
            ) : null}

            {selectionMessage || (selected.videoModelPinned && !selected.videoPath && selected.motionMode === "VIDEO_AI") ? (
              <VideoSelectionPanel
                sceneId={selected.id}
                sceneNumber={selected.sceneNumber}
                complexity={selected.complexity}
                projectId={projectId}
                videoLimit={videoLimit}
                rawMessage={selectionMessage}
                pinned={selected.videoModelPinned && selected.videoProvider && selected.videoModel ? `${selected.videoProvider}/${selected.videoModel}` : null}
              />
            ) : null}

            {selectionMessage ? null : selected.errorMessage && budgetProblem(selected.errorMessage) ? (
              <div className="mt-3">
                <BudgetProblemBox problem={budgetProblem(selected.errorMessage)!} projectId={projectId} videoLimit={videoLimit} />
              </div>
            ) : selected.errorMessage ? (
              <div className="mt-3 rounded-lg border border-danger-500/30 bg-danger-500/10 p-3 text-xs text-danger-500">
                {selected.errorMessage}
              </div>
            ) : null}

            <ImageReview
              sceneId={selected.id}
              sceneNumber={selected.sceneNumber}
              imagePath={selected.imagePath}
              imageProvider={selected.imageProvider}
              imageModel={selected.imageModel}
              approved={selected.approved}
              models={imageModels}
              characters={allCharacters.filter((c) =>
                selected.charactersPresent.includes(c.name),
              )}
              allowsAlternative={
                qualityMode === "QUALITY" || qualityMode === "CUSTOM"
              }
            />
          </div>

          {/* RIGHT: scene settings */}
          <div className="p-4">
            <SceneImagePanel
              sceneId={selected.id}
              sceneNumber={selected.sceneNumber}
              imageSource={selected.imageSource}
              hasImage={Boolean(selected.imagePath)}
              motionMode={selected.motionMode}
              hasClip={Boolean(selected.videoPath)}
              onDone={setResult}
            />
            <SceneVoicePanel
              sceneId={selected.id}
              dialogueKey={JSON.stringify([selected.dialogue, selected.narration])}
              projectId={projectId}
              videoLimit={videoLimit}
            />
            <div className="mb-3 flex flex-wrap gap-1.5">
              <ActionButton
                size="sm"
                variant="outline"
                action={() => regenerateSceneAsset(selected.id, "image")}
                confirm={`Tạo lại ảnh cảnh ${selected.sceneNumber}: tạo ảnh MỚI, ${costText(routing?.imageRegenCost)}. Tiếp tục?`}
                onDone={setResult}
              >
                <ImageIcon className="h-3 w-3" />
                Tạo lại ảnh · {costText(routing?.imageRegenCost, true)}
              </ActionButton>
              <ActionButton
                size="sm"
                variant="outline"
                action={() => regenerateSceneAsset(selected.id, "video")}
                confirm={`Tạo lại video cảnh ${selected.sceneNumber}: tạo clip MỚI, ${costText(routing?.videoRegenCost)}. Tiếp tục?`}
                onDone={setResult}
              >
                <Video className="h-3 w-3" />
                Tạo lại video · {costText(routing?.videoRegenCost, true)}
              </ActionButton>
              <ActionButton
                size="sm"
                variant={selected.approved ? "primary" : "secondary"}
                action={() => approveScene(selected.id, !selected.approved)}
                onDone={setResult}
              >
                <Check className="h-3 w-3" />
                {selected.approved ? "Bỏ duyệt" : "Duyệt cảnh"}
              </ActionButton>
              <ActionButton
                size="sm"
                variant={selected.skipped ? "secondary" : "ghost"}
                action={() => skipScene(selected.id, !selected.skipped)}
                onDone={setResult}
              >
                <Ban className="h-3 w-3" />
                {selected.skipped ? "Khôi phục" : "Bỏ qua cảnh"}
              </ActionButton>
            </div>

            {result ? (
              <p
                className={`mb-3 text-[11px] ${
                  result.ok ? "text-ok-500" : "text-danger-500"
                }`}
              >
                {result.message}
              </p>
            ) : null}

            <ActionForm
              key={selected.id}
              action={(formData) => updateScene(selected.id, formData)}
              submitLabel="Lưu cảnh"
              submitVariant="primary"
            >
              <div className="space-y-3">
                <Field label="Lời thoại">
                  <Textarea
                    name="dialogue"
                    rows={2}
                    defaultValue={selected.dialogue}
                  />
                </Field>
                <Field label="Lời dẫn">
                  <Textarea
                    name="narration"
                    rows={2}
                    defaultValue={selected.narration}
                  />
                </Field>
                <Field label="Phụ đề">
                  <Textarea
                    name="subtitle"
                    rows={2}
                    defaultValue={selected.subtitle}
                  />
                </Field>
                <Field label="Mô tả hình ảnh">
                  <Textarea
                    name="visualDescription"
                    rows={3}
                    defaultValue={selected.visualDescription}
                  />
                </Field>
                <Field label="Prompt ảnh">
                  <Textarea
                    name="imagePrompt"
                    rows={3}
                    className="font-mono text-[11px]"
                    defaultValue={selected.imagePrompt}
                  />
                </Field>
                <Field label="Prompt video">
                  <Textarea
                    name="videoPrompt"
                    rows={3}
                    className="font-mono text-[11px]"
                    defaultValue={selected.videoPrompt}
                  />
                </Field>

                <div className="grid grid-cols-2 gap-2">
                  <Field label="Thời lượng (giây)">
                    <Input
                      name="duration"
                      type="number"
                      min={1}
                      max={12}
                      step="0.5"
                      defaultValue={selected.duration}
                    />
                  </Field>
                  <Field label="Độ phức tạp">
                    <Select name="complexity" defaultValue={selected.complexity}>
                      {COMPLEXITIES.map((c) => (
                        <option key={c} value={c}>
                          {VI_COMPLEXITY[c]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Máy quay">
                    <Input name="camera" defaultValue={selected.camera} />
                  </Field>
                  <Field
                    label="Chuyển động"
                    hint="LOCAL_MOTION: FFmpeg tại máy, $0. VIDEO_AI: 1 clip Video AI từ ảnh cảnh (tính phí)."
                  >
                    <Select name="motionMode" defaultValue={selected.motionMode}>
                      <option value="AUTO">Tự chọn</option>
                      <option value="LOCAL_MOTION">LOCAL_MOTION</option>
                      <option value="VIDEO_AI">VIDEO_AI</option>
                    </Select>
                  </Field>
                  <Field label="Hiệu ứng âm thanh">
                    <Input
                      name="soundEffect"
                      defaultValue={selected.soundEffect}
                    />
                  </Field>
                </div>

                <div className="rounded-lg border border-ink-800 bg-ink-850 p-3">
                  <p className="mb-2 text-[11px] font-semibold text-ink-300">
                    Cách chọn mô hình cho cảnh này
                  </p>
                  <div className="space-y-2">
                    <Field label="Chế độ chọn">
                      <Select
                        name="routingMode"
                        defaultValue={selected.routingMode}
                      >
                        {ROUTER_STRATEGIES.map((s) => (
                          <option key={s} value={s}>
                            {VI_ROUTER_STRATEGY[s]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="Ghim mô hình video (tuỳ chọn)"
                      hint="Để trống để AI Router tự chọn theo độ phức tạp và ngân sách."
                    >
                      <Select
                        name="videoModel"
                        defaultValue={selected.videoModel ?? ""}
                        onChange={(e) => {
                          const form = e.currentTarget.form;
                          const providerInput = form?.elements.namedItem(
                            "videoProvider",
                          ) as HTMLInputElement | null;
                          if (providerInput) {
                            const option = videoModels.find(
                              (m) => m.modelId === e.currentTarget.value,
                            );
                            providerInput.value = option?.provider ?? "";
                          }
                        }}
                      >
                        <option value="">Tự động (AI Router)</option>
                        {videoModels.map((m) => (
                          <option key={`${m.provider}/${m.modelId}`} value={m.modelId}>
                            {m.displayName} — ${m.price}/{m.priceUnit}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <input
                      type="hidden"
                      name="videoProvider"
                      defaultValue={selected.videoProvider ?? ""}
                    />
                  </div>
                </div>

                <div className="space-y-1 rounded-lg border border-ink-800 bg-ink-850 p-3 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-ink-500">Ưu tiên chi tiêu</span>
                    <span className="text-ink-300">
                      {PRIORITY_LABEL[selected.spendPriority] ??
                        selected.spendPriority}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Chi phí ước tính</span>
                    <span className="tabular-nums text-ink-300">
                      {formatUSD(selected.estimatedCost)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Chi phí thực tế</span>
                    <span className="tabular-nums text-ink-300">
                      {formatUSD(selected.actualCost)}
                    </span>
                  </div>
                  {selected.qualityScore !== null ? (
                    <div className="flex justify-between">
                      <span className="text-ink-500">Điểm chất lượng</span>
                      <span className="tabular-nums text-ink-300">
                        {selected.qualityScore.toFixed(1)}/10
                      </span>
                    </div>
                  ) : null}
                  <div className="flex justify-between">
                    <span className="text-ink-500">Trạng thái</span>
                    <span className={selected.status === "needs_selection" ? "text-warn-500" : "text-ink-300"}>
                      {selected.status === "needs_selection" ? "VIDEO MODEL NEEDS_SELECTION" : selected.status}
                    </span>
                  </div>
                </div>
              </div>
            </ActionForm>

            <p className="mt-4 text-[11px] text-ink-600">
              Dự án: {projectId.slice(0, 8)} · Thành ngữ: {idiomPhrase}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The picture as the final video will frame it (QĐ-121), decided by the same
 * rule as the renderer (effectiveFit):
 *   fill  - the whole picture, with the part the crop removes shaded, so a
 *           sliced-off hand is seen before the video is rendered
 *   show-all - the whole picture inside the frame, the rest filled
 */
function FramedImage({
  src,
  alt,
  frame,
  fit,
}: {
  src: string;
  alt: string;
  frame: { width: number; height: number };
  fit: FitMode;
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const mode = effectiveFit(fit, natural, frame);
  if (mode === "CONTAIN") {
    return (
      <div className="relative flex w-full items-center justify-center bg-ink-900" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
        <img src={src} alt={alt} className="max-h-full max-w-full object-contain" onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} />
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-ink-300">
          hiện toàn bộ ảnh trong khung {aspectOf(frame.width, frame.height)}
        </span>
      </div>
    );
  }
  const imgRatio = natural ? natural.width / natural.height : 2 / 3;
  const frameRatio = frame.width / frame.height;
  // The share of the picture the crop removes, on each side.
  const wider = imgRatio > frameRatio;
  const cut = `${((1 - (wider ? frameRatio / imgRatio : imgRatio / frameRatio)) / 2) * 100}%`;
  return (
    <div className="relative">
      <img
        src={src}
        alt={alt}
        className="w-full object-contain"
        style={{ aspectRatio: natural ? `${natural.width} / ${natural.height}` : "2 / 3" }}
        onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
      />
      <div className="pointer-events-none absolute inset-0">
        {wider ? (
          <>
            <div className="absolute inset-y-0 left-0 bg-black/55" style={{ width: cut }} />
            <div className="absolute inset-y-0 right-0 bg-black/55" style={{ width: cut }} />
            <div className="absolute inset-y-0 border-x border-dashed border-brand-400/70" style={{ left: cut, right: cut }} />
          </>
        ) : (
          <>
            <div className="absolute inset-x-0 top-0 bg-black/55" style={{ height: cut }} />
            <div className="absolute inset-x-0 bottom-0 bg-black/55" style={{ height: cut }} />
            <div className="absolute inset-x-0 border-y border-dashed border-brand-400/70" style={{ top: cut, bottom: cut }} />
          </>
        )}
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-ink-300">
          vùng giữ lại trong khung {aspectOf(frame.width, frame.height)}
        </span>
      </div>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-ink-500">{label}</span>
      <span className="text-ink-300">{value}</span>
    </div>
  );
}

function RoutingRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-ink-500">{label}</span>
      <span className="truncate text-ink-300">{value ?? "bỏ qua"}</span>
    </div>
  );
}

/** "~$0.04" on a paid button; "$0 tại máy" for local work; unknown says so. */
function costText(cost: number | null | undefined, short = false): string {
  if (cost === 0) return short ? "$0 tại máy" : "làm tại máy, $0";
  if (cost === null || cost === undefined) return short ? "~? (xem dự toán)" : "chi phí xem ở bảng dự toán";
  const v = `~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
  return short ? v : `ước tính ${v}`;
}
