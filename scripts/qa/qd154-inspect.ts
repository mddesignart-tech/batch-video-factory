/**
 * QĐ-154: read-only look at what stands between a scene and a Runway clip.
 * Prints no key, sends no provider request, writes nothing. $0.
 *
 *   npx tsx scripts/qa/qd154-inspect.ts [projectId]
 */
async function main(): Promise<void> {
  const projectId = process.argv[2] ?? "38a6caf7-0279-4f73-b5f6-9d4344d6a6e0";
  const { prisma } = await import("../../src/lib/prisma");
  const { spendStatus } = await import("../../src/services/spend-guard");
  const { providerSpendBreakdown } = await import("../../src/services/provider-budget");
  const { videoBudget } = await import("../../src/services/video-budget");
  const { videoModelChoices } = await import("../../src/services/generation");

  const s = await spendStatus();
  console.log("APP CAP", { cap: s.cap, spent: s.spent, remaining: s.remaining });
  console.log("RUNWAY CONFIRMED", s.confirmedProviders.filter((k) => k.startsWith("runway/")));
  const wallets = await providerSpendBreakdown();
  console.log("RUNWAY WALLET", JSON.stringify(wallets.find((w) => w.provider === "runway")));
  console.log("PROJECT VIDEO BUDGET", JSON.stringify(await videoBudget(projectId)));
  const scenes = await prisma.scene.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { sceneNumber: "asc" },
    select: { id: true, sceneNumber: true, motionSource: true, videoProvider: true, videoModel: true, videoModelPinned: true, imagePath: true, duration: true, status: true },
  });
  for (const sc of scenes) {
    console.log("SCENE", JSON.stringify({ ...sc, imagePath: Boolean(sc.imagePath) }));
    if (sc.videoModelPinned) {
      const { choices } = await videoModelChoices(sc.id);
      for (const c of choices.filter((c) => c.provider === "runway")) {
        console.log("  choice", c.model, { selectable: c.selectable, cost: c.estimatedCost, why: c.unavailableReason });
      }
    }
  }
  await prisma.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
