"use client";

import { ActionForm } from "@/components/action-ui";
import { Badge, Field, Input, Label } from "@/components/ui";
import { saveCharacterSheet } from "@/app/actions/characters";

/**
 * The detailed appearance fields.
 *
 * Split out from the main editor because these are the attributes an image
 * model drifts on. Each one is pasted into every prompt as its own labelled
 * clause, which gives the model far less room to reinterpret than one long
 * paragraph does.
 */

export interface SheetFields {
  hair: string;
  facialFeatures: string;
  outfit: string;
  bodyProportions: string;
  accessories: string;
  colorPalette: string;
}

export function CharacterSheetForm({
  characterId,
  version,
  sheet,
}: {
  characterId: string;
  version: number;
  sheet: SheetFields;
}) {
  return (
    <ActionForm
      action={(formData) => saveCharacterSheet(characterId, formData)}
      submitLabel="Lưu mô tả chi tiết"
      submitVariant="secondary"
      className="rounded-lg border border-ink-800 p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <Label>Mô tả chi tiết (chống trôi hình)</Label>
        <Badge tone="neutral">phiên bản v{version}</Badge>
      </div>

      <p className="mb-3 text-[11px] text-ink-400">
        Viết bằng tiếng Anh, ngắn gọn và cụ thể. Mỗi mục được chèn vào prompt như
        một câu riêng, kèm yêu cầu <em>không được thay đổi</em>. Để trống mục nào
        thì mục đó không được nhắc tới — an toàn hơn là ghi mơ hồ.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tóc" hint="Màu, độ dài, kiểu">
          <Input
            name="hair"
            defaultValue={sheet.hair}
            placeholder="short messy dark brown hair"
          />
        </Field>
        <Field label="Khuôn mặt" hint="Dáng mặt, mắt, biểu cảm thường trực">
          <Input
            name="facialFeatures"
            defaultValue={sheet.facialFeatures}
            placeholder="round face, large expressive eyes"
          />
        </Field>
        <Field label="Trang phục" hint="Bộ đồ mặc định">
          <Input
            name="outfit"
            defaultValue={sheet.outfit}
            placeholder="bright yellow hoodie, blue jeans"
          />
        </Field>
        <Field label="Tỷ lệ cơ thể" hint="Chiều cao so với nhân vật khác, dáng người">
          <Input
            name="bodyProportions"
            defaultValue={sheet.bodyProportions}
            placeholder="slightly shorter than Leo, oversized head"
          />
        </Field>
        <Field label="Phụ kiện">
          <Input
            name="accessories"
            defaultValue={sheet.accessories}
            placeholder="round glasses"
          />
        </Field>
        <Field label="Màu chủ đạo" hint="Khoá bảng màu để cảnh khác không đổi màu">
          <Input
            name="colorPalette"
            defaultValue={sheet.colorPalette}
            placeholder="yellow, blue, white"
          />
        </Field>
      </div>

      <p className="mt-3 text-[11px] text-ink-400">
        Sửa các mục này sẽ tăng số phiên bản nhân vật. Ảnh chuẩn đã duyệt{" "}
        <strong>không</strong> bị thay tự động — bạn tự quyết định có tạo ảnh mới
        hay không.
      </p>
    </ActionForm>
  );
}
