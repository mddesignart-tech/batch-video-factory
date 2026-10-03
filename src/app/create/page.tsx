import { PageHeader } from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { CreateVideoWizard } from "./create-video-wizard";

export const dynamic = "force-dynamic";

/** TẠO VIDEO - any kind of video, not only idioms (multi-content engine). */
export default async function CreateVideoPage() {
  const presets = await prisma.stylePreset.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } });
  return (
    <>
      <PageHeader
        title="Tạo video"
        description="Chọn loại video → nhập ý tưởng hoặc nội dung → chọn ngôn ngữ, thời lượng, nền tảng → tạo kịch bản → duyệt → tạo video."
      />
      <CreateVideoWizard presets={presets} />
    </>
  );
}
