import { PageHeader } from "@/components/ui";
import { mindStatusAction, mindTakesAction } from "@/app/actions/mind-voice";
import { MindVoiceStudio } from "./mind-voice-studio";

export const dynamic = "force-dynamic";

export default async function MindVoicePage() {
  const [status, takes] = await Promise.all([mindStatusAction(), mindTakesAction()]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Mind Voice Studio"
        description="Tạo giọng AI ngay trên máy này - tiếng Việt (VieNeu-TTS) và tiếng Anh (Supertonic 3). Không cần Internet khi đã cài model, $0, không gọi API trả phí."
      />
      <MindVoiceStudio initialStatus={status} initialTakes={takes} />
    </div>
  );
}
