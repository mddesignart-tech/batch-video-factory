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
import { CostPreview } from "./cost-preview";

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

      {project.errorMessage ? (
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

          {project.scenes.length === 0 ? (
            <Alert tone="info" title="Dự án chưa có kịch bản">
              Bấm &ldquo;Tạo lại kịch bản&rdquo; ở trên để sinh kịch bản mẫu.
            </Alert>
          ) : (
            <Storyboard
              projectId={project.id}
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
                imageProvider: scene.imageProvider,
                imageModel: scene.imageModel,
                voiceModel: scene.voiceModel,
                estimatedCost: scene.estimatedCost,
                actualCost: scene.actualCost,
                imagePath: scene.imagePath,
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
              <InfoRow label="Nghĩa thật" value={project.idiom.meaning} />
              <InfoRow label="Ví dụ" value={project.idiom.exampleSentence} />
              <InfoRow
                label="Phong cách"
                value={project.stylePreset?.name ?? "Mặc định"}
              />
              <InfoRow
                label="Tỉ lệ khung hình"
                value={`${project.aspectRatio} (1080x1920, 30fps)`}
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
