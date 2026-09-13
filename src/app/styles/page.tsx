import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { NewPresetButton, PresetEditor } from "./preset-forms";

export const dynamic = "force-dynamic";

export default async function StylesPage() {
  const presets = await prisma.stylePreset.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });

  return (
    <>
      <PageHeader
        title="Phong cách"
        description="Bộ prompt hình ảnh dùng chung cho toàn bộ video của một dự án."
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Nguyên tắc mô tả phong cách</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-400">
          Chỉ dùng ngôn ngữ hình ảnh chung (hình khối, ánh sáng, chất liệu, bảng
          màu). Không đặt tên hãng phim, thương hiệu hay nhân vật có bản quyền
          trong prompt — vừa tránh rủi ro pháp lý, vừa cho kết quả ổn định hơn
          giữa các nhà cung cấp AI khác nhau.
        </CardContent>
      </Card>

      <div className="mb-4">
        <NewPresetButton />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {presets.map((preset) => (
          <Card key={preset.id}>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>{preset.name}</CardTitle>
              {preset.isDefault ? (
                <Badge tone="brand">Mặc định</Badge>
              ) : null}
            </CardHeader>
            <CardContent>
              <PresetEditor
                preset={{
                  id: preset.id,
                  name: preset.name,
                  positivePrompt: preset.positivePrompt,
                  negativePrompt: preset.negativePrompt,
                  lightingStyle: preset.lightingStyle,
                  cameraLanguage: preset.cameraLanguage,
                  visualTone: preset.visualTone,
                  aspectRatio: preset.aspectRatio,
                  isDefault: preset.isDefault,
                }}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
