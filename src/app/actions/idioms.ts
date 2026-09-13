"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  DIFFICULTIES,
  IDIOM_CATEGORIES,
  IDIOM_STATUSES,
  REGIONS,
} from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { parseCSV } from "@/lib/csv";

/**
 * Idiom library CRUD plus bulk import.
 *
 * Every action returns a plain result object rather than throwing, because these
 * are called straight from forms and the message goes on screen in Vietnamese.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Populated by import: rows rejected and why. */
  details?: string[];
}

const IdiomInput = z.object({
  phrase: z.string().min(2, "Thành ngữ quá ngắn").max(120),
  meaning: z.string().min(2, "Cần nhập nghĩa thật"),
  literalMeaning: z.string().min(2, "Cần mô tả cách hiểu theo nghĩa đen"),
  exampleSentence: z.string().min(2, "Cần một câu ví dụ"),
  category: z.enum(IDIOM_CATEGORIES),
  difficulty: z.enum(DIFFICULTIES),
  region: z.enum(REGIONS),
  notes: z.string().default(""),
  status: z.enum(IDIOM_STATUSES).default("unused"),
});

function readForm(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") out[key] = value.trim();
  }
  return out;
}

export async function createIdiom(formData: FormData): Promise<ActionResult> {
  const parsed = IdiomInput.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }

  const slug = slugify(parsed.data.phrase);
  const existing = await prisma.idiom.findUnique({ where: { slug } });
  if (existing) {
    return {
      ok: false,
      message: `Thành ngữ "${parsed.data.phrase}" đã tồn tại trong thư viện.`,
    };
  }

  await prisma.idiom.create({ data: { ...parsed.data, slug } });
  revalidatePath("/idioms");
  return { ok: true, message: `Đã thêm "${parsed.data.phrase}".` };
}

export async function updateIdiom(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = IdiomInput.partial().safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }
  await prisma.idiom.update({ where: { id }, data: parsed.data });
  revalidatePath("/idioms");
  return { ok: true, message: "Đã cập nhật thành ngữ." };
}

export async function deleteIdiom(id: string): Promise<ActionResult> {
  const projects = await prisma.project.count({ where: { idiomId: id } });
  if (projects > 0) {
    return {
      ok: false,
      message: `Không thể xoá: đang có ${projects} dự án dùng thành ngữ này. Hãy lưu trữ thay vì xoá.`,
    };
  }
  await prisma.idiom.delete({ where: { id } });
  revalidatePath("/idioms");
  return { ok: true, message: "Đã xoá thành ngữ." };
}

export async function setIdiomStatus(
  id: string,
  status: string,
): Promise<ActionResult> {
  const parsed = z.enum(IDIOM_STATUSES).safeParse(status);
  if (!parsed.success) return { ok: false, message: "Trạng thái không hợp lệ." };
  await prisma.idiom.update({ where: { id }, data: { status: parsed.data } });
  revalidatePath("/idioms");
  return { ok: true, message: "Đã đổi trạng thái." };
}

// ------------------------------------------------------------ bulk import ---

const ImportRow = IdiomInput.partial({
  category: true,
  difficulty: true,
  region: true,
  notes: true,
  status: true,
});

export async function importIdioms(formData: FormData): Promise<ActionResult> {
  const raw = String(formData.get("payload") ?? "").trim();
  const format = String(formData.get("format") ?? "csv");
  if (raw.length === 0) {
    return { ok: false, message: "Chưa có dữ liệu để nhập." };
  }

  let records: Record<string, unknown>[];
  try {
    if (format === "json") {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return { ok: false, message: "JSON phải là một mảng các thành ngữ." };
      }
      records = parsed as Record<string, unknown>[];
    } else {
      records = parseCSV(raw);
    }
  } catch (err) {
    return {
      ok: false,
      message: `Không đọc được dữ liệu: ${
        err instanceof Error ? err.message : "định dạng sai"
      }`,
    };
  }

  let created = 0;
  let duplicates = 0;
  const errors: string[] = [];

  // Duplicate detection runs against both the database and the incoming batch,
  // so a file that repeats a phrase internally does not create two rows.
  const seen = new Set<string>();

  for (const [index, record] of records.entries()) {
    const parsed = ImportRow.safeParse(record);
    if (!parsed.success) {
      errors.push(
        `Dòng ${index + 1}: ${parsed.error.issues[0]?.message ?? "dữ liệu sai"}`,
      );
      continue;
    }
    const phrase = parsed.data.phrase;
    if (!phrase) {
      errors.push(`Dòng ${index + 1}: thiếu cột phrase`);
      continue;
    }
    const slug = slugify(phrase);
    if (seen.has(slug)) {
      duplicates++;
      continue;
    }
    seen.add(slug);

    const exists = await prisma.idiom.findUnique({ where: { slug } });
    if (exists) {
      duplicates++;
      continue;
    }

    await prisma.idiom.create({
      data: {
        phrase,
        slug,
        meaning: parsed.data.meaning ?? "",
        literalMeaning: parsed.data.literalMeaning ?? "",
        exampleSentence: parsed.data.exampleSentence ?? "",
        category: parsed.data.category ?? "Funny Expressions",
        difficulty: parsed.data.difficulty ?? "Beginner",
        region: parsed.data.region ?? "General",
        notes: parsed.data.notes ?? "",
        status: parsed.data.status ?? "unused",
      },
    });
    created++;
  }

  await logger.info({
    event: "idioms.imported",
    message: `Nhập ${created} thành ngữ, bỏ qua ${duplicates} trùng, ${errors.length} lỗi.`,
  });
  revalidatePath("/idioms");

  return {
    ok: created > 0,
    message: `Đã nhập ${created} thành ngữ. Bỏ qua ${duplicates} trùng lặp${
      errors.length > 0 ? `, ${errors.length} dòng lỗi` : ""
    }.`,
    details: errors.slice(0, 12),
  };
}
