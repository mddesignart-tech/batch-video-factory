import Link from "next/link";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { formatDateVi, formatUSD } from "@/lib/utils";
import { DIFFICULTIES, IDIOM_CATEGORIES } from "@/domain/enums";
import { estimateAllModes } from "@/services/cost-estimator";
import { planBatchBudget } from "@/services/budget";
import { availableProviderNames } from "@/services/provider-health";
import { NewBatchForm } from "./new-batch-form";

export const dynamic = "force-dynamic";

/**
 * A representative 6-scene video, used to price a batch before any of its
 * projects exist. Mirrors what the mock script generator actually produces.
 */
const REFERENCE_SCENES = [
  { n: 1, d: 3, c: "MEDIUM" as const, p: "HIGH" as const, chars: 1, text: "Break a leg!" },
  { n: 2, d: 5.5, c: "MEDIUM" as const, p: "NORMAL" as const, chars: 1, text: "Wait, you want me to do THAT?" },
  { n: 3, d: 5.5, c: "HIGH" as const, p: "NORMAL" as const, chars: 2, text: "I am VERY prepared." },
  { n: 4, d: 5, c: "HIGH" as const, p: "HIGH" as const, chars: 2, text: "That is NOT what I meant." },
  { n: 5, d: 3.5, c: "LOW" as const, p: "LOW" as const, chars: 2, text: "It just means good luck." },
  { n: 6, d: 3, c: "LOW" as const, p: "LOW" as const, chars: 2, text: "Break a leg on your interview!" },
];

export default async function BatchesPage() {
  const [batches, presets, models, availableProviders, unusedCount] =
    await Promise.all([
      prisma.batch.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { _count: { select: { projects: true } } },
      }),
      prisma.stylePreset.findMany({ orderBy: { name: "asc" } }),
      prisma.modelRegistry.findMany({ where: { enabled: true } }),
      availableProviderNames(),
      prisma.idiom.count({ where: { status: { in: ["unused", "planned"] } } }),
    ]);

  const perVideo = estimateAllModes({
    scenes: REFERENCE_SCENES.map((s) => ({
      sceneNumber: s.n,
      duration: s.d,
      complexity: s.c,
      spendPriority: s.p,
      characterCount: s.chars,
      speechText: s.text,
    })),
    models,
    strategy: "AUTO",
    // Priced per-video in isolation, so the per-video budget must not clamp it.
    maxBudget: 1000,
    availableProviders,
    needs1080p: true,
  });

  const costPerVideo = {
    ECONOMY: perVideo.ECONOMY.breakdown.total,
    BALANCED: perVideo.BALANCED.breakdown.total,
    QUALITY: perVideo.QUALITY.breakdown.total,
    CUSTOM: perVideo.BALANCED.breakdown.total,
  };

  const samplePlan = planBatchBudget({
    videoCount: 50,
    totalBudget: 40,
    costPerVideo,
  });

  return (
    <>
      <PageHeader
        title="Tạo hàng loạt"
        description="Tạo nhiều video cùng lúc từ thư viện thành ngữ, trong một ngân sách chung."
      />

      <NewBatchForm
        presets={presets.map((p) => ({ id: p.id, name: p.name }))}
        categories={[...IDIOM_CATEGORIES]}
        difficulties={[...DIFFICULTIES]}
        costPerVideo={costPerVideo}
        availableIdioms={unusedCount}
      />

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Ví dụ tối ưu ngân sách lô</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-400">
          <p>
            Với <strong className="text-ink-200">50 video</strong> và ngân sách{" "}
            <strong className="text-ink-200">$40</strong>, AI Router không chọn
            mô hình rẻ nhất cho tất cả. Nó bắt đầu ở chế độ Cân bằng cho mọi
            video, rồi dùng phần ngân sách còn dư để nâng cấp từng video lên
            Chất lượng cao:
          </p>
          <p className="mt-2 text-ink-200">{samplePlan.message}</p>
          <p className="mt-1 text-ink-500">
            Chi phí/video: Tiết kiệm {formatUSD(costPerVideo.ECONOMY)} · Cân bằng{" "}
            {formatUSD(costPerVideo.BALANCED)} · Chất lượng cao{" "}
            {formatUSD(costPerVideo.QUALITY)}
            {costPerVideo.BALANCED === 0
              ? " (đang ở chế độ mock nên mọi mô hình đều $0)"
              : ""}
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Các lô đã tạo ({batches.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {batches.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="Chưa có lô nào"
                description="Tạo lô đầu tiên ở trên. Mỗi lô sẽ tự sinh dự án, kịch bản và media cho từng thành ngữ."
              />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Tên lô</Th>
                  <Th>Trạng thái</Th>
                  <Th className="text-right">Yêu cầu</Th>
                  <Th className="text-right">Đã tạo</Th>
                  <Th>Chế độ</Th>
                  <Th className="text-right">Ngân sách</Th>
                  <Th className="text-right">Thực tế</Th>
                  <Th>Tạo lúc</Th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id} className="hover:bg-ink-850">
                    <Td className="font-medium text-ink-100">{batch.name}</Td>
                    <Td>
                      <Badge
                        tone={
                          batch.status === "completed"
                            ? "ok"
                            : batch.status === "failed"
                              ? "danger"
                              : batch.status === "processing"
                                ? "info"
                                : "neutral"
                        }
                      >
                        {batch.status}
                      </Badge>
                    </Td>
                    <Td className="text-right tabular-nums text-ink-300">
                      {batch.amount}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-100">
                      <Link
                        href={`/projects`}
                        className="hover:text-brand-400"
                      >
                        {batch._count.projects}
                      </Link>
                    </Td>
                    <Td className="text-xs text-ink-400">{batch.qualityMode}</Td>
                    <Td className="text-right tabular-nums text-ink-300">
                      {formatUSD(batch.maxBudget)}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-100">
                      {formatUSD(batch.actualCost)}
                    </Td>
                    <Td className="text-xs text-ink-500">
                      {formatDateVi(batch.createdAt)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
