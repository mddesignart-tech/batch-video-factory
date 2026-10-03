import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { sceneCharacters } from "@/domain/scene-characters";
import { parseJson, formatUSD } from "@/lib/utils";
import {
  VI_PROJECT_STATUS,
  VI_QUALITY_MODE,
  type ProjectStatus,
  type QualityMode,
} from "@/domain/enums";
import type { ScriptScore } from "@/domain/script";
import { previewProjectCost } from "@/services/project-service";
import { Storyboard } from "./storyboard";
import { ProjectActions } from "./project-actions";
import { ImportImagesCard } from "./import-images-card";
import { OutputCard } from "./output-card";
import { existingOutputFor } from "@/services/output-export";
import { CostPreview } from "./cost-preview";
import { pacingSummary } from "@/domain/scene-timing";
import { videoBudget } from "@/services/video-budget";
import { budgetProblem } from "@/domain/budget-message";
import { isNeedsSelection, splitNeedsSelection } from "@/domain/video-selection";
import { BudgetProblemBox, VideoBudgetCard } from "@/components/video-budget";
import { projectFormat } from "@/services/output-profile";
import { VideoFormatCard } from "./video-format-card";
import { ScriptReviewCard } from "./script-review-card";
import { ReferencePanel } from "./reference-panel";
import { VideoOutputCard } from "./video-output-card";
import { controlsOf } from "@/domain/output-controls";
import { listProjectReferences, referenceProblems, sceneReferenceIds } from "@/services/reference-assets";
import { contentSummary } from "@/services/content-service";
import { audienceOf, languageOf } from "@/domain/content-options";
import { spokenLines } from "@/domain/scene-subtitles";
import type { ScriptDoc } from "@/domain/script";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<
  ProjectStatus,
  "ok" | "info" | "warn" | "danger" | "neutral"
> = {
  draft: "neutral",
  script_ready: "info",
  media_generating: "warn",
  media_ready: "info",
  rendering: "warn",
  completed: "ok",
  failed: "danger",
  needs_review: "warn",
  budget_exhausted: "warn",
  cancelled: "neutral",
};

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      idiom: true,
      stylePreset: true,
      scenes: { orderBy: { sceneNumber: "asc" } },
    },
  });
  if (!project) notFound();

  const [videoModels, imageModels, allCharacters, jobs] = await Promise.all([
    prisma.modelRegistry.findMany({
      where: { type: "video", enabled: true },
      orderBy: [{ provider: "asc" }, { price: "asc" }],
    }),
    prisma.modelRegistry.findMany({
      where: { type: "image" },
      orderBy: [{ enabled: "desc" }, { price: "asc" }],
    }),
    prisma.character.findMany({ select: { id: true, name: true } }),
    prisma.job.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  // The estimate depends on live model data, so it is computed per request
  // rather than cached: a price edit must show up immediately.
  let preview = null;
  let previewError: string | null = null;
  try {
    preview = project.scenes.length > 0 ? await previewProjectCost(id) : null;
  } catch (err) {
    previewError = err instanceof Error ? err.message : String(err);
  }

  const score = parseJson<ScriptScore | null>(project.scriptScoreJson, null);
  const budget = await videoBudget(id);
  const format = await projectFormat(id);
  const projectBudgetProblem = budgetProblem(project.errorMessage);
  // Multi-content project: the script preview + DUYỆT KỊCH BẢN. A legacy idiom
  // project (contentType NULL) shows exactly what it always did.
  const content = project.contentType ? contentSummary(project) : null;
  const scriptDoc = content ? parseJson<ScriptDoc | null>(project.scriptJson, null) : null;
  // Tài sản tham chiếu (QĐ-124): read only here, $0.
  const [references, refProblems] = await Promise.all([listProjectReferences(id), referenceProblems(id)]);
  const musicAsset = project.backgroundMusicAssetId
    ? await prisma.asset.findUnique({ where: { id: project.backgroundMusicAssetId } })
    : null;
  const referenceTitle =
    {
      STORY: "Nhân vật & đồ vật",
      TOY_WORLD: "Đồ chơi tham chiếu",
      ANIMAL_FACT: "Con vật / mascot tham chiếu",
      PRODUCT_REVIEW: "Sản phẩm tham chiếu",
      ADVERTISEMENT: "Sản phẩm tham chiếu",
    }[project.contentType ?? ""] ?? "Tài sản tham chiếu";

  return (
    <>
      <Link
        href="/projects"
        className="mb-3 inline-flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Quay lại danh sách dự án
      </Link>

      <PageHeader
        title={project.idiom.phrase}
        description={project.title}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONE[project.status as ProjectStatus]}>
              {VI_PROJECT_STATUS[project.status as ProjectStatus]}
            </Badge>
            <Badge tone="brand">
              {VI_QUALITY_MODE[project.qualityMode as QualityMode]}
            </Badge>
          </div>
        }
      />

      {project.errorMessage && isNeedsSelection(project.errorMessage) ? (
        <div className="mb-4">
          <Alert tone="warn" title="Có cảnh cần chọn model Video AI">
            {splitNeedsSelection(project.errorMessage).summary} Mở cảnh đó trong Storyboard để chọn model, dùng LOCAL
            MOTION hoặc bỏ qua Video AI.
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-ink-500">Xem chi tiết kỹ thuật</summary>
              <p className="mt-1 whitespace-pre-wrap break-words font-mono text-ink-500">
                {splitNeedsSelection(project.errorMessage).detail}
              </p>
            </details>
          </Alert>
        </div>
      ) : project.errorMessage && projectBudgetProblem ? (
        <div className="mb-4">
          <BudgetProblemBox problem={projectBudgetProblem} projectId={project.id} videoLimit={budget.videoLimit} />
        </div>
      ) : project.errorMessage ? (
        <div className="mb-4">
          <Alert tone="danger" title="Dự án gặp lỗi">
            {project.errorMessage}
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <ProjectActions
            projectId={project.id}
            status={project.status}
            finalVideoPath={project.finalVideoPath}
            subtitlePath={project.subtitlePath}
            maxBudget={project.maxBudget}
            qualityMode={project.qualityMode}
            routerStrategy={project.routerStrategy}
            targetDuration={project.targetDuration}
            title={project.title}
          />

          {content && scriptDoc && project.scenes.length > 0 ? (
            <ScriptReviewCard
              projectId={project.id}
              title={project.title}
              hook={scriptDoc.hook}
              templateName={content.templateName}
              formatLabel={content.formatLabel}
              languageLabel={languageOf(content.language).label}
              audienceLabel={audienceOf(content.audience).label}
              durationSeconds={project.targetDuration}
              approved={content.approved}
              needsFactReview={scriptDoc.needsFactReview === true}
              aiFacts={(scriptDoc.facts ?? []).filter((f) => f.origin === "AI_GENERATED").map((f) => f.text)}
              canRewrite={["draft", "script_ready", "needs_review", "failed"].includes(project.status)}
              scenes={project.scenes
                .filter((s) => !s.skipped)
                .map((s) => {
                  const doc = scriptDoc.scenes.find((d) => d.sceneNumber === s.sceneNumber);
                  return {
                    sceneNumber: s.sceneNumber,
                    beatLabel: doc?.beatLabel ?? "",
                    duration: s.duration,
                    speech: spokenLines(s)
                      .map((l) => (l.speaker && l.speaker !== "Narrator" ? `${l.speaker}: ${l.text}` : l.text))
                      .join("\n"),
                    subtitle: s.subtitle,
                    visual: s.visualDescription,
                    usesOwnPhoto: s.imageSource === "IMPORTED",
                    motion: s.motionMode,
                    soundEffect: s.soundEffect,
                  };
                })}
            />
          ) : null}

          {project.scenes.length === 0 ? (
            <Alert tone="info" title="Dự án chưa có kịch bản">
              Bấm &ldquo;Tạo lại kịch bản&rdquo; ở trên để sinh kịch bản mẫu.
            </Alert>
          ) : null}

          {project.status === "completed" && project.finalVideoPath ? (
            (() => {
              const found = existingOutputFor(project);
              return (
                <OutputCard
                  projectId={project.id}
                  actualCost={project.actualCost}
                  pacing={(() => {
                    const live = project.scenes.filter((sc) => !sc.skipped);
                    if (live.length === 0 || live.some((sc) => sc.finalDuration === null)) return null;
                    return pacingSummary(
                      live.reduce((n, sc) => n + sc.duration, 0),
                      live.reduce((n, sc) => n + (sc.finalDuration ?? sc.duration), 0),
                    );
                  })()}
                  output={
                    found
                      ? {
                          dir: found.dir,
                          relative: found.relative,
                          duration: found.metadata?.duration ?? null,
                          resolution: found.metadata ? `${found.metadata.width}x${found.metadata.height}` : null,
                          aspectRatio: found.metadata?.aspectRatio ?? null,
                        }
                      : null
                  }
                />
              );
            })()
          ) : null}

          {project.scenes.length > 0 ? (
            <VideoOutputCard
              projectId={project.id}
              initial={controlsOf(project)}
              music={musicAsset ? { filename: musicAsset.originalFilename ?? "music", durationSec: musicAsset.durationSec } : null}
              frame={{ width: format.profile.width, height: format.profile.height }}
            />
          ) : null}

          {project.scenes.length > 0 ? (
            <ReferencePanel
              projectId={project.id}
              title={referenceTitle}
              references={references.map((r) => ({
                id: r.id,
                type: r.type,
                name: r.name,
                priority: r.priority,
                enabled: r.enabled,
                useThroughout: r.useThroughout,
                version: r.version,
                source: r.source,
                images: r.images,
              }))}
              scenes={project.scenes
                .filter((s) => !s.skipped)
                .map((s) => ({
                  id: s.id,
                  sceneNumber: s.sceneNumber,
                  referenceIds: sceneReferenceIds(s),
                  characters: sceneCharacters(s).present,
                  withoutReferences: s.referenceOverride === "NO_REFERENCES_CONFIRMED",
                  referenceProblem:
                    s.errorMessage && /REFERENCE_LIMIT/.test(s.errorMessage)
                      ? "Model này không hỗ trợ đủ tài sản tham chiếu của cảnh."
                      : (refProblems.find((p) => p.sceneNumber === s.sceneNumber)?.message ?? null),
                }))}
            />
          ) : null}

          {project.scenes.length > 0 ? (
            <ImportImagesCard
              projectId={project.id}
              scenes={project.scenes
                .filter((s) => !s.skipped)
                .map((s) => ({ sceneNumber: s.sceneNumber, hasImage: Boolean(s.imagePath) }))}
            />
          ) : null}

          {project.scenes.length === 0 ? null : (
            <Storyboard
              projectId={project.id}
              videoLimit={budget.videoLimit}
              frame={{ width: format.profile.width, height: format.profile.height }}
              frameFit={format.profile.fit}
              idiomPhrase={project.idiom.phrase}
              scenes={project.scenes.map((scene) => ({
                id: scene.id,
                sceneNumber: scene.sceneNumber,
                duration: scene.duration,
                visualDescription: scene.visualDescription,
                dialogue: scene.dialogue,
                narration: scene.narration,
                subtitle: scene.subtitle,
                camera: scene.camera,
                characterAction: scene.characterAction,
                soundEffect: scene.soundEffect,
                imagePrompt: scene.imagePrompt,
                videoPrompt: scene.videoPrompt,
                complexity: scene.complexity,
                spendPriority: scene.spendPriority,
                routingMode: scene.routingMode,
                videoProvider: scene.videoProvider,
                videoModel: scene.videoModel,
                videoModelPinned: scene.videoModelPinned,
                imageProvider: scene.imageProvider,
                imageModel: scene.imageModel,
                voiceModel: scene.voiceModel,
                estimatedCost: scene.estimatedCost,
                actualCost: scene.actualCost,
                imagePath: scene.imagePath,
                imageSource: scene.imageSource,
                motionMode: scene.motionMode,
                videoPath: scene.videoPath,
                audioPath: scene.audioPath,
                qualityScore: scene.qualityScore,
                status: scene.status,
                approved: scene.approved,
                skipped: scene.skipped,
                charactersPresent: sceneCharacters(scene).present,
                speakingCharacters: sceneCharacters(scene).speaking,
                primaryCharacters: sceneCharacters(scene).primary,
                errorMessage: scene.errorMessage,
              }))}
              routingByScene={Object.fromEntries(
                (preview?.current.scenes ?? []).map((plan) => [
                  plan.sceneNumber,
                  {
                    image: plan.image
                      ? `${plan.image.provider}/${plan.image.modelId}`
                      : null,
                    video: plan.video
                      ? `${plan.video.provider}/${plan.video.modelId}`
                      : null,
                    voice: plan.voice
                      ? `${plan.voice.provider}/${plan.voice.modelId}`
                      : null,
                    reason: plan.video?.reason ?? plan.image?.reason ?? "",
                    estimatedCost: plan.estimatedCost,
                    error: plan.error ?? null,
                    // Only the "no model may run this" stops; an approved-plan
                    // change (APPROVED_*) is re-planned on the batch page.
                    needsSelection:
                      plan.needsProvider && !plan.needsProvider.startsWith("APPROVED_") ? plan.needsProvider : null,
                    // "Tạo lại" always buys a new asset: the routed price, or
                    // what the reused one would have cost.
                    imageRegenCost: plan.image?.estimatedCost || plan.saved.image || null,
                    videoRegenCost:
                      plan.motionSource === "LOCAL_MOTION" ? 0 : plan.video?.estimatedCost || plan.saved.video || null,
                  },
                ]),
              )}
              videoModels={videoModels.map((m) => ({
                provider: m.provider,
                modelId: m.modelId,
                displayName: m.displayName,
                price: m.price,
                priceUnit: m.priceUnit,
              }))}
              imageModels={imageModels.map((m) => ({
                provider: m.provider,
                modelId: m.modelId,
                displayName: m.displayName,
                price: m.price,
                enabled: m.enabled,
              }))}
              allCharacters={allCharacters}
              qualityMode={project.qualityMode}
            />
          )}
        </div>

        <div className="space-y-4">
          <VideoFormatCard format={format} />

          <VideoBudgetCard budget={budget} />

          {previewError ? (
            <Alert tone="warn" title="Không tính được chi phí">
              {previewError}
            </Alert>
          ) : preview ? (
            <CostPreview preview={preview} currentMode={project.qualityMode} />
          ) : null}

          {score ? (
            <Card>
              <CardHeader>
                <CardTitle>Điểm kịch bản</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 text-xs">
                <ScoreRow label="Hook (3 giây đầu)" value={score.hook} />
                <ScoreRow label="Độ hài hước" value={score.humor} />
                <ScoreRow label="Độ rõ ràng" value={score.clarity} />
                <ScoreRow
                  label="Giá trị học tiếng Anh"
                  value={score.learningValue}
                />
                <ScoreRow
                  label="Khả thi về hình ảnh"
                  value={score.visualFeasibility}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Job gần đây</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-xs">
              {jobs.length === 0 ? (
                <p className="text-ink-500">Chưa có job nào.</p>
              ) : (
                jobs.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate text-ink-400">{job.type}</span>
                    <Badge
                      tone={
                        job.status === "completed"
                          ? "ok"
                          : job.status === "failed"
                            ? "danger"
                            : job.status === "processing"
                              ? "info"
                              : "neutral"
                      }
                    >
                      {job.status}
                    </Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Thông tin dự án</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-xs text-ink-400">
              {content ? (
                <InfoRow label="Loại video" value={`${content.templateName} · ${content.formatLabel}`} />
              ) : (
                <>
                  <InfoRow label="Nghĩa thật" value={project.idiom.meaning} />
                  <InfoRow label="Ví dụ" value={project.idiom.exampleSentence} />
                </>
              )}
              <InfoRow
                label="Phong cách"
                value={project.stylePreset?.name ?? "Mặc định"}
              />
              <InfoRow
                label="Tỉ lệ khung hình"
                value={`${format.outputAspect} (${format.profile.width}x${format.profile.height}, ${format.profile.fps}fps)`}
              />
              <InfoRow
                label="Ngân sách tối đa"
                value={formatUSD(project.maxBudget)}
              />
              <InfoRow
                label="Chi phí thực tế"
                value={formatUSD(project.actualCost)}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function ScoreRow({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 8 ? "text-ok-500" : value >= 7 ? "text-ink-200" : "text-warn-500";
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-400">{label}</span>
      <span className={`font-semibold tabular-nums ${tone}`}>{value}/10</span>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-ink-500">{label}</span>
      <span className="text-ink-300">{value}</span>
    </div>
  );
}
