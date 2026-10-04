"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CONTENT_TYPES } from "@/domain/content-templates";
import { DEFAULT_PLATFORM, PLATFORM_IDS, profileFromPlatform, validateProfile } from "@/domain/platform-profile";
import { MAX_DURATION_SECONDS, MIN_DURATION_SECONDS } from "@/domain/content-options";
import { errorMessage } from "@/lib/utils";
import {
  approveContentScript,
  createContentProject,
  generateContentProjectScript,
} from "@/services/content-service";
import { IMPORT_MAX_BYTES } from "@/services/imported-image";
import type { ActionResult } from "./idioms";
import { CreativeStyleSchema, type StoredCreativeStyle } from "@/domain/creative-style";
import { saveCreativeStyle } from "@/services/creative-style";
import { generateProjectScript } from "@/services/project-service";

/** The picker's hidden JSON field; anything unreadable = "Tự động". */
function parseCreativeField(raw: FormDataEntryValue | null): Partial<StoredCreativeStyle> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = CreativeStyleSchema.partial().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * TẠO VIDEO (multi-content engine). Free: writes the script (mock text in
 * development) and stores the person's pictures. No image, voice or clip is
 * bought here - that waits for DUYỆT KỊCH BẢN, then preflight + DUYỆT & CHẠY.
 */

const CreateContentInput = z.object({
  contentType: z.enum(CONTENT_TYPES),
  formatId: z.string().optional(),
  sourceType: z.enum(["PROMPT", "TEXT", "ASSETS", "URL"]),
  idea: z.string().max(4000).optional(),
  sourceText: z.string().optional(),
  sourceUrl: z.string().max(2000).optional(),
  subjectName: z.string().max(200).optional(),
  /** One fact per line, typed by the person (USER_PROVIDED). */
  factsText: z.string().max(5000).optional(),
  cta: z.string().max(300).optional(),
  referenceName: z.string().max(120).optional(),
  language: z.string().default("vi"),
  bilingualMode: z.string().optional(),
  audience: z.string().optional(),
  tone: z.string().optional(),
  voiceMode: z.string().optional(),
  durationSeconds: z.coerce.number().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS).default(30),
  stylePresetId: z.string().optional(),
  platform: z.enum(PLATFORM_IDS).default(DEFAULT_PLATFORM),
  customWidth: z.coerce.number().optional(),
  customHeight: z.coerce.number().optional(),
  customFps: z.coerce.number().optional(),
});

export async function createContentVideo(formData: FormData): Promise<ActionResult & { projectId?: string }> {
  const fields = Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string" && v !== ""));
  const parsed = CreateContentInput.safeParse(fields);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ." };
  }
  const d = parsed.data;
  const blank = (n: number | undefined) => (n === undefined || Number.isNaN(n) || n === 0 ? undefined : n);
  const checked = validateProfile(
    profileFromPlatform(d.platform, { width: blank(d.customWidth), height: blank(d.customHeight), fps: blank(d.customFps) }),
  );
  if (!checked.ok) return { ok: false, message: checked.message };

  const uploads: { bytes: Buffer; filename: string }[] = [];
  for (const entry of formData.getAll("uploads")) {
    if (typeof entry === "string" || entry.size === 0) continue;
    if (entry.size > IMPORT_MAX_BYTES) return { ok: false, message: `Ảnh "${entry.name}" lớn hơn 40 MB.` };
    uploads.push({ bytes: Buffer.from(await entry.arrayBuffer()), filename: entry.name });
  }

  try {
    const project = await createContentProject({
      contentType: d.contentType,
      formatId: d.formatId,
      sourceType: d.sourceType,
      idea: d.idea,
      sourceText: d.sourceText,
      sourceUrl: d.sourceUrl,
      subjectName: d.subjectName,
      facts: (d.factsText ?? "")
        .split(/\r?\n/)
        .map((t) => t.replace(/^[-•*]\s*/, "").trim())
        .filter(Boolean)
        .map((text) => ({ text, origin: "USER_PROVIDED" as const })),
      cta: d.cta,
      referenceName: d.referenceName,
      // An unchecked box sends nothing: OFF. A checked one sends "on".
      useReferenceThroughout: formData.get("useReferenceThroughout") === "on",
      language: d.language,
      bilingualMode: d.bilingualMode,
      audience: d.audience,
      tone: d.tone,
      voiceMode: d.voiceMode,
      creativeStyle: parseCreativeField(formData.get("creativeStyle")),
      durationSeconds: d.durationSeconds,
      stylePresetId: d.stylePresetId || undefined,
      outputProfile: checked.profile,
      uploads,
    });
    revalidatePath("/projects");
    return { ok: true, message: "Đã tạo kịch bản. Hãy xem và DUYỆT KỊCH BẢN.", projectId: project.id };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function approveScriptAction(projectId: string): Promise<ActionResult> {
  try {
    await approveContentScript(projectId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: "Đã duyệt kịch bản. Bước tiếp theo: TẠO MEDIA (xem chi phí trước khi chạy)." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function rewriteContentScriptAction(projectId: string): Promise<ActionResult> {
  try {
    const script = await generateContentProjectScript(projectId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `Đã viết lại kịch bản: ${script.scenes.length} cảnh. Hãy xem lại rồi duyệt.` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** PHONG CÁCH SÁNG TẠO: store the choice only - no script, no media ($0). */
export async function saveCreativeStyleAction(
  projectId: string,
  style: Partial<StoredCreativeStyle> | null,
): Promise<ActionResult & { canRewrite?: boolean }> {
  try {
    const parsed = style ? CreativeStyleSchema.partial().safeParse(style) : null;
    if (parsed && !parsed.success) return { ok: false, message: "Phong cách không hợp lệ." };
    const r = await saveCreativeStyle(projectId, parsed ? parsed.data : null);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: r.message, canRewrite: r.canRewrite };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * VIẾT LẠI KỊCH BẢN with the saved style - any project (content template or
 * idiom). One text call (free in Mock Mode); never an image, clip or voice.
 */
export async function rewriteWithStyleAction(projectId: string): Promise<ActionResult> {
  try {
    const script = await generateProjectScript(projectId);
    revalidatePath(`/projects/${projectId}`);
    return {
      ok: true,
      message: `Đã viết lại kịch bản theo phong cách mới: ${script.scenes.length} cảnh. Chưa tạo ảnh, giọng hay video - hãy xem lại rồi duyệt.`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
