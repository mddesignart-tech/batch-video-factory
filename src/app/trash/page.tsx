import { PageHeader } from "@/components/ui";
import { listTrash } from "@/services/trash-service";
import { TrashView } from "./trash-view";

export const dynamic = "force-dynamic";

/** THÙNG RÁC (QĐ-152): deleted projects, scenes and exported videos - restore or delete for good. */
export default async function TrashPage() {
  const data = await listTrash();
  return (
    <>
      <PageHeader title="Thùng rác" description="Dự án, cảnh và video đã xoá. Khôi phục bất cứ lúc nào; chỉ Xoá vĩnh viễn mới xoá file - và chỉ file không còn được dùng." />
      <TrashView data={data} />
    </>
  );
}
