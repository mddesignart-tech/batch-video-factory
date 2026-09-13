import Link from "next/link";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import {
  DIFFICULTIES,
  IDIOM_CATEGORIES,
  IDIOM_STATUSES,
} from "@/domain/enums";
import { formatDateVi } from "@/lib/utils";
import { IdiomForms, IdiomRowActions } from "./forms";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  unused: "Chưa dùng",
  planned: "Đã lên kế hoạch",
  generated: "Đã tạo video",
  published: "Đã đăng",
  archived: "Lưu trữ",
};

const STATUS_TONE: Record<string, "neutral" | "info" | "ok" | "brand" | "warn"> = {
  unused: "neutral",
  planned: "info",
  generated: "brand",
  published: "ok",
  archived: "warn",
};

interface SearchParams {
  q?: string;
  category?: string;
  difficulty?: string;
  status?: string;
}

export default async function IdiomsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = params.q?.trim() ?? "";

  const where = {
    ...(q
      ? {
          OR: [
            { phrase: { contains: q } },
            { meaning: { contains: q } },
            { exampleSentence: { contains: q } },
          ],
        }
      : {}),
    ...(params.category ? { category: params.category } : {}),
    ...(params.difficulty ? { difficulty: params.difficulty } : {}),
    ...(params.status ? { status: params.status } : {}),
  };

  const [idioms, total, statusCounts] = await Promise.all([
    prisma.idiom.findMany({
      where,
      orderBy: [{ status: "asc" }, { phrase: "asc" }],
      take: 300,
    }),
    prisma.idiom.count(),
    prisma.idiom.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const countOf = (status: string) =>
    statusCounts.find((s) => s.status === status)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="Thành ngữ"
        description="Thư viện thành ngữ tiếng Anh dùng làm nguồn nội dung cho video."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Tổng số" value={total} />
        <Stat label="Chưa dùng" value={countOf("unused")} tone="brand" />
        <Stat label="Lên kế hoạch" value={countOf("planned")} tone="info" />
        <Stat label="Đã tạo video" value={countOf("generated")} />
        <Stat label="Đã đăng" value={countOf("published")} tone="ok" />
      </div>

      <div className="mt-6">
        <IdiomForms />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Tìm kiếm và lọc</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Input
              name="q"
              placeholder="Tìm theo thành ngữ hoặc nghĩa..."
              defaultValue={q}
            />
            <Select name="category" defaultValue={params.category ?? ""}>
              <option value="">Tất cả chủ đề</option>
              {IDIOM_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
            <Select name="difficulty" defaultValue={params.difficulty ?? ""}>
              <option value="">Mọi độ khó</option>
              {DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
            <Select name="status" defaultValue={params.status ?? ""}>
              <option value="">Mọi trạng thái</option>
              {IDIOM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
            <button
              type="submit"
              className="h-9 rounded-md bg-ink-700 px-4 text-sm hover:bg-ink-600"
            >
              Lọc
            </button>
          </form>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Danh sách ({idioms.length})</CardTitle>
          <span className="text-xs text-ink-500">
            Hiển thị tối đa 300 kết quả
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {idioms.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="Không tìm thấy thành ngữ nào"
                description="Thử đổi bộ lọc, hoặc nhập thêm thành ngữ bằng CSV/JSON ở trên."
              />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Thành ngữ</Th>
                  <Th>Nghĩa thật</Th>
                  <Th>Hiểu theo nghĩa đen (gag)</Th>
                  <Th>Chủ đề</Th>
                  <Th>Độ khó</Th>
                  <Th>Vùng</Th>
                  <Th>Trạng thái</Th>
                  <Th>Đã dùng</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {idioms.map((idiom) => (
                  <tr key={idiom.id} className="hover:bg-ink-850">
                    <Td className="font-medium text-ink-100">
                      {idiom.phrase}
                      <p className="text-[11px] font-normal text-ink-500">
                        {idiom.exampleSentence}
                      </p>
                    </Td>
                    <Td className="max-w-48 text-xs text-ink-300">
                      {idiom.meaning}
                    </Td>
                    <Td className="max-w-64 text-xs text-ink-400">
                      {idiom.literalMeaning}
                    </Td>
                    <Td className="text-xs text-ink-400">{idiom.category}</Td>
                    <Td className="text-xs text-ink-400">{idiom.difficulty}</Td>
                    <Td className="text-xs text-ink-400">{idiom.region}</Td>
                    <Td>
                      <Badge tone={STATUS_TONE[idiom.status] ?? "neutral"}>
                        {STATUS_LABEL[idiom.status] ?? idiom.status}
                      </Badge>
                    </Td>
                    <Td className="text-xs text-ink-500">
                      {idiom.timesUsed}x
                      {idiom.lastUsedAt ? (
                        <p>{formatDateVi(idiom.lastUsedAt)}</p>
                      ) : null}
                    </Td>
                    <Td>
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/projects?idiomId=${idiom.id}`}
                          className="rounded-md px-2 py-1 text-xs text-accent-500 hover:bg-ink-800"
                        >
                          Tạo video
                        </Link>
                        <IdiomRowActions
                          id={idiom.id}
                          phrase={idiom.phrase}
                          status={idiom.status}
                        />
                      </div>
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
