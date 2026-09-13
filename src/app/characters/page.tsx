import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { CharacterEditor, NewCharacterButton } from "./character-forms";

export const dynamic = "force-dynamic";

export default async function CharactersPage() {
  const characters = await prisma.character.findMany({
    orderBy: { createdAt: "asc" },
  });

  return (
    <>
      <PageHeader
        title="Nhân vật"
        description="Nhân vật gốc dùng lại trong mọi video. Mô tả ngoại hình ở đây được chèn vào mọi prompt ảnh và video để giữ nhân vật nhất quán."
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Vì sao phần này quan trọng</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-400">
          AI tạo hình mỗi cảnh một cách độc lập, nên nếu không có bản mô tả cố
          định thì nhân vật sẽ đổi tóc, đổi áo, đổi khuôn mặt giữa các cảnh và
          video trông như bị lỗi. Mô tả ngoại hình (visual prompt), prompt phủ
          định và seed bên dưới được tái sử dụng nguyên văn cho mọi cảnh — đừng
          viết lại chúng cho từng cảnh.
        </CardContent>
      </Card>

      <div className="mb-4">
        <NewCharacterButton />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {characters.map((character) => (
          <Card key={character.id}>
            <CardHeader className="flex items-center justify-between">
              <div>
                <CardTitle>{character.name}</CardTitle>
                <p className="mt-0.5 text-xs text-ink-400">
                  {character.description}
                </p>
              </div>
              <Badge tone={character.enabled ? "ok" : "neutral"}>
                {character.enabled ? "Đang bật" : "Đã tắt"}
              </Badge>
            </CardHeader>
            <CardContent>
              <CharacterEditor
                character={{
                  id: character.id,
                  name: character.name,
                  description: character.description,
                  personality: character.personality,
                  visualPrompt: character.visualPrompt,
                  negativePrompt: character.negativePrompt,
                  voiceId: character.voiceId,
                  notes: character.notes,
                  enabled: character.enabled,
                  seed: character.seed,
                }}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
