import { notFound } from "next/navigation";
import { batchProgress, storedPlan } from "@/services/batch-runner";
import { batchStyleApplies } from "@/services/batch-sources";
import { templateOf } from "@/domain/content-templates";
import { creativeBadges, creativeSummary, resolveCreativeStyle } from "@/domain/creative-style";
import { BatchCreativeCard } from "./batch-creative-card";
import { BatchProgressView } from "./batch-progress-view";
import { BatchAudioCard } from "./batch-audio-card";
import { prisma } from "@/lib/prisma";
import { controlsOf } from "@/domain/output-controls";

export const dynamic = "force-dynamic";

/**
 * Server shell for the batch progress page.
 *
 * The first paint is rendered on the server so the page is correct immediately
 * with no spinner and no flash of empty tables; from there the client component
 * keeps it current by polling. That split is also what makes a reconnect work -
 * whatever state the browser comes back in, the server hands it the truth once
 * and polling takes over.
 *
 * The approval figures are read here rather than polled: a plan is frozen once
 * written, so re-fetching it every 2.5 seconds would be asking a question whose
 * answer cannot change.
 */
export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const progress = await batchProgress(id);
  if (!progress) notFound();
  // PHONG CÁCH (QĐ-136): idiom batches only - an imported storyboard keeps its
  // own script, and a project wrapped into a batch of one (TẠO MEDIA) keeps the
  // style chosen on its own page (QĐ-140).
  const plan = progress.importBatch || !(await batchStyleApplies(id)) ? null : storedPlan(progress.batch);
  const idiomCreative = templateOf("ENGLISH_IDIOM").creative;
  const style = plan?.creativeStyle ?? null;
  const effective = resolveCreativeStyle(idiomCreative, style);
  // ÂM THANH LÔ (QĐ-150): each video's own Audio Mixer preset.
  const audioVideos = (
    await prisma.project.findMany({
      where: { batchId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, contentType: true, outputControlsJson: true, finalVideoPath: true },
    })
  ).map((p) => {
    const mixer = controlsOf(p).audio.mixer;
    return { projectId: p.id, title: p.title, presetId: mixer ? mixer.presetId : undefined, hasFinal: Boolean(p.finalVideoPath) };
  });

  return (
    <div className="space-y-4">
      <BatchProgressView
        initial={progress}
        middle={plan ? (
        <BatchCreativeCard
          batchId={progress.batch.id}
          creative={idiomCreative}
          initial={style}
          videos={progress.videos.length}
          badges={style ? creativeBadges(effective) : [{ label: "Phong cách", value: "Tự động" }]}
          summary={
            style
              ? `Kế hoạch lô: ${creativeSummary(effective)}.`
              : "Kế hoạch lô: Tự động - bộ viết kịch bản thành ngữ gốc (lô cũ / chưa chọn phong cách)."
          }
        />
        ) : null}
      />
      <BatchAudioCard batchId={progress.batch.id} videos={audioVideos} />
    </div>
  );
}
