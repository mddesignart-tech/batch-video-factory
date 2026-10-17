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
import { CreativeStyleSchema, creativeFromFormField, type StoredCreativeStyle } from "@/domain/creative-style";
import { saveCreativeStyle } from "@/services/creative-style";
import { generateProjectScript } from "@/services/project-service";
import {
  acceptedSnapshot,
  applyProjectUrlSource,
  readUrlSource,
  refetchProjectUrlSource,
  urlSourceErrorMessage,
  type RefetchResult,
  type StoredUrlSource,
  type UrlSourcePreview,
} from "@/services/url-source";

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
  /** QĐ-138: the page metadata of the accepted URL snapshot (JSON, re-checked). */
  urlSourceMeta: z.string().max(20_000).optional(),
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

  // URL: the text is the snapshot the person accepted; its metadata is
  // re-checked here, and the link is not opened again.
  let urlSource: StoredUrlSource | null = null;
  let sourceText = d.sourceText;
  if (d.sourceType === "URL" && d.urlSourceMeta) {
    try {
      const snap = acceptedSnapshot(d.sourceText ?? "", JSON.parse(d.urlSourceMeta));
      urlSource = snap.stored;
      sourceText = snap.text;
    } catch (err) {
      return { ok: false, message: urlSourceErrorMessage(err).message };
    }
  }

  try {
    const project = await createContentProject({
      contentType: d.contentType,
      formatId: d.formatId,
      sourceType: d.sourceType,
      idea: d.idea,
      sourceText,
      sourceUrl: urlSource?.url ?? d.sourceUrl,
      urlSource,
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
      creativeStyle: creativeFromFormField(formData.get("creativeStyle")),
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

// --------------------------------------------------------- URL source ---

/** ĐỌC NỘI DUNG: fetch + extract one page for the preview. $0, nothing stored, no AI. */
export async function readUrlSourceAction(url: string): Promise<ActionResult & { preview?: UrlSourcePreview; code?: string }> {
  try {
    const preview = await readUrlSource(String(url ?? ""));
    return { ok: true, message: `Đã đọc ${preview.meta.domain}: ${preview.meta.contentLength.toLocaleString("vi-VN")} ký tự.`, preview };
  } catch (err) {
    const e = urlSourceErrorMessage(err);
    return { ok: false, message: e.message, code: e.code };
  }
}

/** ĐỌC LẠI TỪ WEB on a project: a new preview only - nothing is replaced yet. */
export async function refetchProjectUrlAction(projectId: string): Promise<ActionResult & { result?: RefetchResult; code?: string }> {
  try {
    const result = await refetchProjectUrlSource(projectId);
    return {
      ok: true,
      message: result.changed ? "Nội dung trang đã thay đổi so với bản đã lưu. Xem lại rồi chọn THAY NGUỒN nếu muốn." : "Nội dung trang không đổi so với bản đã lưu.",
      result,
    };
  } catch (err) {
    const e = urlSourceErrorMessage(err);
    return { ok: false, message: e.message, code: e.code };
  }
}

/** THAY NGUỒN: replace the snapshot. Never rewrites the script, never makes media. */
export async function applyProjectUrlAction(
  projectId: string,
  text: string,
  meta: unknown,
  confirmReplace: boolean,
): Promise<ActionResult & { needsConfirmation?: boolean }> {
  try {
    const r = await applyProjectUrlSource(projectId, { text, meta, confirmReplace });
    if (r.status === "NEEDS_CONFIRMATION") return { ok: false, message: r.message, needsConfirmation: true };
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: r.message };
  } catch (err) {
    return { ok: false, message: urlSourceErrorMessage(err).message };
  }
}
