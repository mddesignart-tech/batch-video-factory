import { Alert, Card, CardContent, CardHeader, CardTitle, PageHeader } from "@/components/ui";
import { ImportForm } from "./import-form";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * The second input path: scenes that already exist.
 *
 * V1 starts from an idea and pays a text model to invent the scenes. This
 * starts from the scenes themselves - written by hand, exported from a
 * spreadsheet, storyboarded elsewhere with the keyframes already drawn - and
 * pays for none of that again. Everything after the import is the same engine.
 */

export default async function ImportPage() {
  const settings = await getSettings();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Nhập Storyboard"
        description="Nhập phân cảnh đã soạn sẵn (CSV/JSON, kèm ảnh nếu có) thành một lô video."
      />

      <ImportForm defaultMaxCostPerVideo={settings.defaultMaxCostPerVideo} />

      <Card>
        <CardHeader>
          <CardTitle>Định dạng</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Mỗi storyboard là một video. Cột tối thiểu:{" "}
            <code className="font-mono text-xs">scene_number</code>, cộng với{" "}
            <code className="font-mono text-xs">visual_description</code> hoặc{" "}
            <code className="font-mono text-xs">character_action</code>. Các cột khác đều
            không bắt buộc.
          </p>
          <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
{`/batch-import/
    video-001/
        storyboard.json
        scene-01.png
        scene-02.png
    video-003/
        storyboard.csv
        images/01.png`}
          </pre>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Có sẵn narration/dialogue/visual_description</strong> → không gọi Text AI.
            </li>
            <li>
              <strong>Có image_file hợp lệ</strong> → không gọi Image AI, dùng luôn ảnh đó làm
              keyframe.
            </li>
            <li>
              <strong>motion_mode=LOCAL_MOTION</strong> → không gọi Video AI, FFmpeg tại máy,
              chi phí video $0.
            </li>
            <li>
              <strong>motion_mode=VIDEO_AI</strong> → bắt buộc qua Video AI; ghim model nếu có
              ghi, nếu không thì router chọn.
            </li>
            <li>
              <strong>motion_mode=AUTO</strong> → router quyết định theo đúng luật hiện hành
              (độ khó, LOW_AUTO, lifecycle, benchmark, ngân sách, ghim tay).
            </li>
          </ul>
          <Alert tone="info">
            Đường dẫn ảnh phải là đường dẫn tương đối nằm trong thư mục storyboard. Đường dẫn
            tuyệt đối, ổ đĩa và <code className="font-mono text-xs">..</code> đều bị từ chối —
            với cả thư mục lẫn file ZIP.
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
