import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { batchProgress, storedPlan } from "@/services/batch-runner";
import { BatchProgressView } from "./batch-progress-view";
import type { ApprovalFigures } from "./approve-panel";

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

  // Only a DRAFT authorisation can be approved, so only then is the panel
  // assembled at all.
  let approval: ApprovalFigures | null = null;
  if (progress.authorization?.status === "DRAFT") {
    const batch = await prisma.batch.findUnique({ where: { id } });
    const plan = batch ? storedPlan(batch) : null;
    if (plan) {
      const forMoney = plan.production ?? plan.runtime;
      approval = {
        costBasis: forMoney.costBasis,
        estimated: plan.recommendation.estimated,
        recommended: plan.recommendation.recommended,
        safetyMarginPct: plan.recommendation.safetyMarginPct,
        clampedByGlobalCap: plan.recommendation.clampedByGlobalCap,
        globalRemaining: plan.globalCap.remaining,
        providerScope: forMoney.providerScope,
        videoCount: forMoney.runnableCount,
        maxCostPerVideo: plan.maxCostPerVideo,
        warnings: plan.warnings,
      };
    }
  }

  return <BatchProgressView initial={progress} approval={approval} />;
}
