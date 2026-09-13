import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetEnvCache } from "@/lib/env";
import { SceneSchema, ScriptSchema } from "@/domain/script";
import {
  referencePriority,
  sceneCharacterColumns,
  sceneCharacters,
} from "@/domain/scene-characters";
import {
  buildSceneImageRequest,
  mentionsCharacter,
  repairSceneCharacters,
  trimUnusedCharacters,
} from "@/services/generation";
import { uploadCharacterReference, approveCharacterReference } from "@/services/character-master";
import { SAFE_AREA_INSTRUCTION } from "@/services/character-service";

/**
 * Character presence versus character speech.
 *
 * The bug this guards: presence used to be inferred from who had a line, so a
 * character standing silently in frame was drawn with no reference image and
 * came out looking like someone else. Every test here exists to keep the two
 * concepts apart.
 *
 * Verified entirely from the request payload - no image is generated and
 * nothing is billed.
 */

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const NAMES = ["PMax", "PLeo", "PMia"] as const;

async function makeCharacter(name: string, extra: Record<string, string>) {
  return prisma.character.upsert({
    where: { name },
    update: {},
    create: {
      name,
      description: `${name} test`,
      personality: "test",
      visualPrompt: `${name}: cartoon character`,
      negativePrompt: "realistic photo",
      ...extra,
    },
  });
}

/** A scene row shaped like the database one, without touching the database. */
function scene(lists: {
  present: string[];
  speaking: string[];
  primary: string[];
  visualDescription?: string;
  imagePrompt?: string;
  characterAction?: string;
}) {
  return {
    imagePrompt: lists.imagePrompt ?? "a funny moment",
    visualDescription: lists.visualDescription ?? "a funny moment",
    camera: "medium shot",
    characterAction: lists.characterAction ?? "",
    ...sceneCharacterColumns({
      present: lists.present,
      speaking: lists.speaking,
      primary: lists.primary,
    }),
  };
}

beforeAll(async () => {
  process.env.AI_MOCK_MODE = "true";
  resetEnvCache();

  await makeCharacter("PMax", { hair: "messy brown hair", outfit: "yellow hoodie" });
  await makeCharacter("PLeo", { hair: "neat black hair", accessories: "round glasses" });
  await makeCharacter("PMia", { hair: "curly auburn hair", outfit: "denim jacket" });

  // Give all three an approved master so reference routing has something to
  // route. Uploads are trusted on arrival but still need promoting to primary.
  for (const name of NAMES) {
    const character = await prisma.character.findUniqueOrThrow({ where: { name } });
    const existing = await prisma.characterReference.findFirst({
      where: { characterId: character.id, isPrimary: true },
    });
    if (existing) continue;
    const { referenceId } = await uploadCharacterReference({
      characterId: character.id,
      fileName: `${name}.png`,
      bytes: TINY_PNG,
    });
    await approveCharacterReference(referenceId);
  }
});

// ------------------------------------------------------------ the schema ---

describe("ba danh sách nhân vật trong kịch bản", () => {
  it("giữ riêng người xuất hiện và người có thoại", () => {
    const parsed = SceneSchema.parse({
      sceneNumber: 1,
      duration: 4,
      visualDescription: "Max panics while Leo watches",
      dialogue: 'Max: "I cannot do that!"',
      charactersPresent: ["Max", "Leo"],
      speakingCharacters: ["Max"],
      primaryCharacters: ["Max"],
    });

    expect(parsed.charactersPresent).toEqual(["Max", "Leo"]);
    expect(parsed.speakingCharacters).toEqual(["Max"]);
    // Leo không nói nhưng vẫn có mặt - đây chính là trường hợp trước đây bị bỏ.
    expect(parsed.speakingCharacters).not.toContain("Leo");
    expect(parsed.charactersPresent).toContain("Leo");
  });

  it("người có thoại luôn được coi là có mặt, kể cả khi model quên", () => {
    const parsed = SceneSchema.parse({
      sceneNumber: 1,
      duration: 4,
      visualDescription: "x",
      dialogue: 'Leo: "hi"',
      charactersPresent: ["Max"],
      speakingCharacters: ["Leo"],
    });
    // Suy diễn chỉ đi một chiều: nói thì chắc chắn có mặt.
    expect(parsed.charactersPresent).toContain("Leo");
  });

  it("KHÔNG suy ngược: có mặt không biến thành có thoại", () => {
    const parsed = SceneSchema.parse({
      sceneNumber: 1,
      duration: 4,
      visualDescription: "x",
      dialogue: "",
      charactersPresent: ["Max", "Leo"],
    });
    expect(parsed.charactersPresent).toEqual(["Max", "Leo"]);
    // Cảnh câm: không ai nói, dù hai người đều trong khung hình.
    expect(parsed.speakingCharacters).toEqual([]);
  });

  it("đọc được kịch bản kiểu cũ chỉ có một danh sách", () => {
    const parsed = SceneSchema.parse({
      sceneNumber: 1,
      duration: 4,
      visualDescription: "x",
      dialogue: 'Max: "hi"',
      characters: ["Max", "Leo"],
    });
    // Không được vỡ khi model trả về định dạng cũ.
    expect(parsed.charactersPresent).toEqual(["Max", "Leo"]);
    expect(parsed.primaryCharacters.length).toBeGreaterThan(0);
  });

  it("loại tên trùng và tên rỗng", () => {
    const parsed = SceneSchema.parse({
      sceneNumber: 1,
      duration: 4,
      visualDescription: "x",
      charactersPresent: ["Max", "max", "  ", "Leo"],
    });
    expect(parsed.charactersPresent).toEqual(["Max", "Leo"]);
  });

  it("mock provider sinh đủ ba danh sách và tách đúng người nói", async () => {
    const { MockTextProvider } = await import("@/providers/mock/mock-text-provider");
    const { script } = await new MockTextProvider().generateScript({
      idiom: "Break a leg",
      meaning: "good luck",
      literalMeaning: "snap a bone",
      exampleSentence: "Break a leg tonight!",
      targetDuration: 27,
      stylePrompt: "3D cartoon",
      characters: [
        { name: "Max", personality: "naive", visualPrompt: "a" },
        { name: "Leo", personality: "calm", visualPrompt: "b" },
      ],
      avoidAngles: [],
      model: "mock-text-1",
      systemPrompt: "test",
    });

    expect(ScriptSchema.safeParse(script).success).toBe(true);

    const hook = script.scenes[0]!;
    // Cảnh mở đầu: Leo tung câu thành ngữ, Max phản ứng - hai người trong
    // khung hình nhưng chỉ một người nói.
    expect(hook.charactersPresent.length).toBe(2);
    expect(hook.speakingCharacters.length).toBeLessThan(
      hook.charactersPresent.length,
    );

    for (const s of script.scenes) {
      for (const name of s.speakingCharacters) {
        expect(s.charactersPresent).toContain(name);
      }
      for (const name of s.primaryCharacters) {
        expect(s.charactersPresent).toContain(name);
      }
    }
  });
});

// ------------------------------------------------------- reading them back ---

describe("đọc danh sách nhân vật từ cơ sở dữ liệu", () => {
  it("vá lại khi dòng dữ liệu thiếu người nói trong danh sách có mặt", () => {
    const lists = sceneCharacters({
      charactersPresentJson: JSON.stringify(["Max"]),
      speakingCharactersJson: JSON.stringify(["Leo"]),
      primaryCharactersJson: JSON.stringify([]),
    });
    expect(lists.present).toEqual(["Max", "Leo"]);
    expect(lists.speaking).toEqual(["Leo"]);
  });

  it("chịu được JSON hỏng mà không làm sập luồng tạo ảnh", () => {
    const lists = sceneCharacters({
      charactersPresentJson: "khong-phai-json",
      speakingCharactersJson: "[]",
      primaryCharactersJson: "[]",
    });
    expect(lists.present).toEqual([]);
  });

  it("thứ tự ưu tiên: trọng tâm trước, rồi người nói, rồi còn lại", () => {
    const order = referencePriority({
      present: ["Mia", "Leo", "Max"],
      speaking: ["Leo"],
      primary: ["Max"],
    });
    expect(order).toEqual(["Max", "Leo", "Mia"]);
  });
});

// ----------------------------------------------------------- validation ---

describe("kiểm tra trước khi gọi API", () => {
  it("nhận diện tên nhân vật theo từ trọn vẹn", () => {
    expect(mentionsCharacter("PMax folds his arms", "PMax")).toBe(true);
    expect(mentionsCharacter("the maximum value", "Max")).toBe(false);
    expect(mentionsCharacter("an amiable person", "Mia")).toBe(false);
    expect(mentionsCharacter("Leo, arms folded, watches.", "Leo")).toBe(true);
  });

  it("bổ sung nhân vật được mô tả trong cảnh nhưng thiếu trong danh sách", async () => {
    const { lists, repaired } = await repairSceneCharacters(
      { present: ["PMax"], speaking: ["PMax"], primary: ["PMax"] },
      "PMax panics while PLeo folds his arms and watches.",
    );
    expect(repaired).toEqual(["PLeo"]);
    expect(lists.present).toContain("PLeo");
  });

  it("bỏ nhân vật được liệt kê nhưng không hề được dàn cảnh", () => {
    // Model từng nhét nhân vật thứ ba vào cảnh mà mô tả không nhắc tới, khiến
    // họ bị vẽ im lặng ở rìa khung: tốn một ảnh tham chiếu và đẩy nhân vật
    // chính về phía mép bị cắt.
    const { lists, trimmed } = trimUnusedCharacters(
      { present: ["PMax", "PLeo", "PMia"], speaking: ["PMax"], primary: ["PMax"] },
      "PMax tips the jar while PLeo points at it.",
    );
    expect(trimmed).toEqual(["PMia"]);
    expect(lists.present).toEqual(["PMax", "PLeo"]);
  });

  it("KHÔNG bỏ nhân vật có thoại hoặc là trọng tâm dù mô tả không nhắc tên", () => {
    const { trimmed } = trimUnusedCharacters(
      { present: ["PMax", "PLeo"], speaking: ["PLeo"], primary: ["PMax"] },
      "a jar tips over",
    );
    expect(trimmed).toEqual([]);
  });

  it("KHÔNG cắt ai khi mô tả cảnh không nêu tên nhân vật nào", () => {
    // "beans everywhere" không nói gì về dàn nhân vật. Cắt theo nó sẽ dựng lại
    // đúng lỗi cũ theo chiều ngược: nhân vật im lặng biến mất khỏi khung hình.
    const { lists, trimmed } = trimUnusedCharacters(
      { present: ["PMax", "PLeo"], speaking: [], primary: [] },
      "beans everywhere",
    );
    expect(trimmed).toEqual([]);
    expect(lists.present).toEqual(["PMax", "PLeo"]);
  });

  it("không gửi ảnh tham chiếu cho nhân vật đã bị cắt", async () => {
    const shot = await buildSceneImageRequest(
      scene({
        present: ["PMax", "PLeo", "PMia"],
        speaking: ["PMax"],
        primary: ["PMax"],
        visualDescription: "PMax tips the jar while PLeo points at it.",
        imagePrompt: "",
        characterAction: "",
      }),
      null,
    );
    expect(shot.trimmedCharacters).toEqual(["PMia"]);
    expect(shot.referencedCharacters).not.toContain("PMia");
    expect(shot.prompt).not.toContain("PMia:");
  });

  it("không bổ sung gì khi danh sách đã đúng", async () => {
    const { repaired } = await repairSceneCharacters(
      { present: ["PMax", "PLeo"], speaking: ["PMax"], primary: ["PMax"] },
      "PMax panics while PLeo watches.",
    );
    expect(repaired).toEqual([]);
  });
});

// ------------------------------------------------------ reference routing ---

describe("định tuyến ảnh tham chiếu", () => {
  it("chỉ MAX: một hồ sơ, một ảnh tham chiếu", async () => {
    const shot = await buildSceneImageRequest(
      scene({ present: ["PMax"], speaking: ["PMax"], primary: ["PMax"] }),
      null,
    );
    expect(shot.characters.map((c) => c.name)).toEqual(["PMax"]);
    expect(shot.referenceImages).toHaveLength(1);
    expect(shot.referencedCharacters).toEqual(["PMax"]);
  });

  it("MAX và LEO nhưng chỉ MAX nói: LEO VẪN được gửi ảnh tham chiếu", async () => {
    const shot = await buildSceneImageRequest(
      scene({ present: ["PMax", "PLeo"], speaking: ["PMax"], primary: ["PMax"] }),
      null,
    );
    // Đây là hồi quy quan trọng nhất của cả tệp này.
    expect(shot.referencedCharacters).toContain("PLeo");
    expect(shot.referenceImages).toHaveLength(2);
    expect(shot.prompt).toContain("PLeo:");
    expect(shot.prompt).toContain("neat black hair");
  });

  it("MAX và LEO cùng nói: cả hai đều có hồ sơ và ảnh", async () => {
    const shot = await buildSceneImageRequest(
      scene({
        present: ["PMax", "PLeo"],
        speaking: ["PMax", "PLeo"],
        primary: ["PMax", "PLeo"],
      }),
      null,
    );
    expect(shot.referencedCharacters.sort()).toEqual(["PLeo", "PMax"]);
  });

  it("MAX, LEO và MIA: cả ba đều vào prompt và đều có ảnh", async () => {
    const shot = await buildSceneImageRequest(
      scene({
        present: ["PMax", "PLeo", "PMia"],
        speaking: ["PMax"],
        primary: ["PMax"],
      }),
      null,
    );
    expect(shot.characters).toHaveLength(3);
    expect(shot.referenceImages).toHaveLength(3);
    for (const name of NAMES) {
      expect(shot.prompt).toContain(`${name}:`);
    }
  });

  it("khi nhà cung cấp giới hạn số ảnh, giữ trọng tâm rồi mới tới người nói", async () => {
    const shot = await buildSceneImageRequest(
      scene({
        present: ["PMia", "PLeo", "PMax"],
        speaking: ["PLeo"],
        primary: ["PMax"],
      }),
      null,
      2,
    );
    expect(shot.referencedCharacters).toEqual(["PMax", "PLeo"]);
    expect(shot.droppedByLimit).toEqual(["PMia"]);
    // Bị cắt ảnh không có nghĩa là bị bỏ khỏi prompt: hồ sơ chữ vẫn còn.
    expect(shot.prompt).toContain("PMia:");
    expect(shot.prompt).toContain("curly auburn hair");
  });

  it("tự sửa rồi vẫn gửi ảnh cho nhân vật bị kịch bản bỏ sót", async () => {
    const shot = await buildSceneImageRequest(
      scene({
        present: ["PMax"],
        speaking: ["PMax"],
        primary: ["PMax"],
        visualDescription: "PMax waves while PMia giggles behind him.",
      }),
      null,
    );
    expect(shot.repairedCharacters).toEqual(["PMia"]);
    expect(shot.referencedCharacters).toContain("PMia");
  });

  it("nhân vật chưa có ảnh chuẩn vẫn vào prompt và được báo là thiếu", async () => {
    const nameless = await makeCharacter("PNoRef", { hair: "blond hair" });
    const shot = await buildSceneImageRequest(
      scene({
        present: ["PMax", nameless.name],
        speaking: ["PMax"],
        primary: ["PMax"],
      }),
      null,
    );
    expect(shot.unreferencedCharacters).toContain("PNoRef");
    expect(shot.prompt).toContain("PNoRef:");
    expect(shot.referencedCharacters).not.toContain("PNoRef");
  });

  it("nội dung cảnh LUÔN vào prompt, không bị boilerplate của model lấn át", async () => {
    // Model thật điền imagePrompt bằng boilerplate phong cách, không bao giờ
    // rỗng và không chứa hành động. Ưu tiên nó khiến cảnh biến mất khỏi prompt.
    const shot = await buildSceneImageRequest(
      scene({
        present: ["PMax"],
        speaking: ["PMax"],
        primary: ["PMax"],
        visualDescription: "PMax holds an enormous jar of beans",
        imagePrompt:
          "3D cartoon style, clean simple background. Characters: PMax as defined.",
        characterAction: "PMax lifts the jar high",
      }),
      null,
    );
    expect(shot.prompt).toContain("enormous jar of beans");
    expect(shot.prompt).toContain("lifts the jar high");
    // Boilerplate bị bỏ: phong cách và hồ sơ nhân vật đã do pipeline cung cấp.
    expect(shot.prompt).not.toContain("Characters: PMax as defined");
  });

  it("dùng imagePrompt làm phương án dự phòng khi cảnh không có mô tả", async () => {
    const shot = await buildSceneImageRequest(
      scene({
        present: ["PMax"],
        speaking: [],
        primary: ["PMax"],
        visualDescription: "",
        imagePrompt: "a quiet empty classroom",
        characterAction: "",
      }),
      null,
    );
    expect(shot.prompt).toContain("a quiet empty classroom");
  });

  it("chỉ dẫn gom nhóm áp dụng từ HAI nhân vật trở lên", async () => {
    // Ban đầu chỉ áp dụng từ ba. Cảnh hai nhân vật rồi cũng dàn ra hai mép và
    // bàn tay Max bị cắt mất trong video thật.
    const two = await buildSceneImageRequest(
      scene({ present: ["PMax", "PLeo"], speaking: ["PMax"], primary: ["PMax"] }),
      null,
    );
    expect(two.prompt).toContain("tight group near the centre");

    const solo = await buildSceneImageRequest(
      scene({ present: ["PMax"], speaking: ["PMax"], primary: ["PMax"] }),
      null,
    );
    // Bảo model gom một nhân vật với không ai là câu thừa.
    expect(solo.prompt).not.toContain("tight group near the centre");
  });

  it("vùng an toàn nêu đích danh tay và cử chỉ vươn ra", async () => {
    const shot = await buildSceneImageRequest(
      scene({ present: ["PMax"], speaking: [], primary: ["PMax"] }),
      null,
    );
    // "Giữ mọi thứ bên trong" chung chung là chưa đủ: cử chỉ vươn xa hơn thân
    // người tạo ra nó, nên phải gọi tên.
    expect(shot.prompt).toContain("outstretched arms");
    expect(shot.prompt).toContain("open palms");
  });

  it("prompt luôn kèm hướng dẫn vùng an toàn cho khung 9:16", async () => {
    const shot = await buildSceneImageRequest(
      scene({ present: ["PMax"], speaking: [], primary: ["PMax"] }),
      null,
    );
    expect(shot.prompt).toContain(SAFE_AREA_INSTRUCTION);
    // Ảnh 2:3 rộng hơn 9:16 nên bị cắt hai bên, không phải trên dưới.
    expect(shot.prompt).toContain("left and right edges");
  });
});
