import { notFound } from "next/navigation";
import { batchProgress } from "@/services/batch-runner";
import { BatchProgressView } from "./batch-progress-view";
import { VideoResumePanel } from "./video-resume-panel";

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

  return (
    <div className="space-y-4">
      <BatchProgressView initial={progress} />
      {/* Per-video resume (QĐ-110): one plan, one button per video. */}
      <VideoResumePanel batchId={progress.batch.id} />
    </div>
  );
}
