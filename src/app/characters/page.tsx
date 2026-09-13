import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { CharacterEditor, NewCharacterButton } from "./character-forms";
import { CharacterReferences } from "./character-references";
import { CharacterSheetForm } from "./character-sheet-form";

export const dynamic = "force-dynamic";

export default async function CharactersPage() {
  const [characters, imageModels] = await Promise.all([
    prisma.character.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        references: { orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }] },
      },
    }),
    prisma.modelRegistry.findMany({
      where: { type: "image" },
      orderBy: [{ enabled: "desc" }, { price: "asc" }],
    }),
  ]);

  const modelOptions = imageModels.map((m) => ({
    provider: m.provider,
    modelId: m.modelId,
    displayName: m.displayName,
    price: m.price,
    enabled: m.enabled,
  }));
  const mockMode = isMockMode();

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

      <div className="grid gap-4 xl:grid-cols-2">
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
            <CardContent className="space-y-5">
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

              <CharacterSheetForm
                characterId={character.id}
                version={character.version}
                sheet={{
                  hair: character.hair,
                  facialFeatures: character.facialFeatures,
                  outfit: character.outfit,
                  bodyProportions: character.bodyProportions,
                  accessories: character.accessories,
                  colorPalette: character.colorPalette,
                }}
              />

              <CharacterReferences
                characterId={character.id}
                characterName={character.name}
                characterVersion={character.version}
                mockMode={mockMode}
                models={modelOptions}
                references={character.references.map((r) => ({
                  id: r.id,
                  filePath: r.filePath,
                  source: r.source,
                  isPrimary: r.isPrimary,
                  approved: r.approved,
                  provider: r.provider,
                  model: r.model,
                  prompt: r.prompt,
                  characterVersion: r.characterVersion,
                  bytes: r.bytes,
                  notes: r.notes,
                  createdAt: r.createdAt.toLocaleString("vi-VN"),
                }))}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
