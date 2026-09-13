import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { MODEL_TYPES } from "@/domain/enums";
import { qualityIndex } from "@/services/pricing";
import { ModelRow, NewModelButton } from "./model-forms";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  text: "Kịch bản",
  image: "Ảnh",
  video: "Video",
  voice: "Giọng đọc",
  upscale: "Nâng phân giải",
  quality: "Đánh giá",
};

export default async function ModelsPage() {
  const models = await prisma.modelRegistry.findMany({
    orderBy: [{ type: "asc" }, { provider: "asc" }, { price: "asc" }],
  });

  const providers = await prisma.providerConfig.findMany({
    select: { name: true, displayName: true },
    orderBy: { priority: "asc" },
  });

  return (
    <>
      <PageHeader
        title="Mô hình AI"
        description="Bảng giá và năng lực của từng mô hình. AI Router chỉ đọc giá từ đây."
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Giá là dữ liệu, không phải mã nguồn</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-400">
          Không có giá nhà cung cấp nào được viết cứng trong ứng dụng. Khi một
          nhà cung cấp đổi bảng giá, bạn chỉ cần sửa ở đây và mọi ước tính chi
          phí sẽ cập nhật ngay. Các mô hình thật được seed với giá $0 và trạng
          thái tắt — hãy nhập giá thực tế trước khi bật, nếu không phần ước tính
          sẽ báo sai.
        </CardContent>
      </Card>

      <div className="mb-4">
        <NewModelButton
          providers={providers.map((p) => ({
            name: p.name,
            displayName: p.displayName,
          }))}
        />
      </div>

      {MODEL_TYPES.map((type) => {
        const rows = models.filter((m) => m.type === type);
        if (rows.length === 0) return null;
        return (
          <Card key={type} className="mb-4">
            <CardHeader>
              <CardTitle>
                {TYPE_LABEL[type]} ({rows.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <thead>
                  <tr>
                    <Th>Mô hình</Th>
                    <Th>Nhà cung cấp</Th>
                    <Th className="text-right">Giá vào</Th>
                    <Th className="text-right">Giá ra</Th>
                    <Th>Đơn vị</Th>
                    <Th className="text-right">Chất lượng</Th>
                    <Th className="text-right">Nhất quán</Th>
                    <Th className="text-right">Tốc độ</Th>
                    <Th className="text-right">Chỉ số tổng</Th>
                    <Th>Năng lực</Th>
                    <Th>Trạng thái</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((model) => (
                    <tr key={model.id} className="hover:bg-ink-850">
                      <Td className="font-medium text-ink-100">
                        {model.displayName}
                        <p className="font-mono text-[10px] font-normal text-ink-500">
                          {model.modelId}
                        </p>
                      </Td>
                      <Td className="text-xs text-ink-400">{model.provider}</Td>
                      <Td className="text-right tabular-nums text-ink-200">
                        ${model.price}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-400">
                        {model.type === "text" ? `$${model.priceOutput}` : "-"}
                      </Td>
                      <Td className="text-[11px] text-ink-500">
                        {model.priceUnit}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-300">
                        {model.qualityRating}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-300">
                        {model.consistencyRating}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-300">
                        {model.speedRating}
                      </Td>
                      <Td className="text-right tabular-nums text-brand-400">
                        {qualityIndex(model).toFixed(1)}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {model.supportsTextToVideo ? (
                            <Badge>T2V</Badge>
                          ) : null}
                          {model.supportsImageToVideo ? (
                            <Badge>I2V</Badge>
                          ) : null}
                          {model.supportsCharacterReference ? (
                            <Badge tone="info">Char ref</Badge>
                          ) : model.supportsReferenceImage ? (
                            <Badge>Ref img</Badge>
                          ) : null}
                          {model.supports1080p ? <Badge>1080p</Badge> : null}
                          {model.maxDuration > 0 ? (
                            <Badge>max {model.maxDuration}s</Badge>
                          ) : null}
                        </div>
                      </Td>
                      <Td>
                        <Badge tone={model.enabled ? "ok" : "neutral"}>
                          {model.enabled ? "Bật" : "Tắt"}
                        </Badge>
                      </Td>
                      <Td>
                        <ModelRow
                          model={{
                            id: model.id,
                            provider: model.provider,
                            modelId: model.modelId,
                            displayName: model.displayName,
                            type: model.type,
                            price: model.price,
                            priceOutput: model.priceOutput,
                            priceUnit: model.priceUnit,
                            enabled: model.enabled,
                            maxDuration: model.maxDuration,
                            qualityRating: model.qualityRating,
                            speedRating: model.speedRating,
                            consistencyRating: model.consistencyRating,
                            notes: model.notes,
                            supportsTextToVideo: model.supportsTextToVideo,
                            supportsImageToVideo: model.supportsImageToVideo,
                            supportsReferenceImage: model.supportsReferenceImage,
                            supportsCharacterReference:
                              model.supportsCharacterReference,
                            supports1080p: model.supports1080p,
                            supportsUpscale: model.supportsUpscale,
                          }}
                          providers={providers.map((p) => ({
                            name: p.name,
                            displayName: p.displayName,
                          }))}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
