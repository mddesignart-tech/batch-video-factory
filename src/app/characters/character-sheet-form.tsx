"use client";

import { ActionForm } from "@/components/action-ui";
import { Alert, Badge, Field, Input, Label, Textarea } from "@/components/ui";
import { saveCharacterSheet } from "@/app/actions/characters";

/**
 * The Character Bible, as a form.
 *
 * Split out from the main editor because these are the attributes an image
 * model drifts on. Each one is pasted into every prompt as its own labelled
 * clause, which gives the model far less room to reinterpret than one long
 * paragraph does.
 *
 * ## The distinction this form has to make visible
 *
 * A filled field becomes a LOCK - the prompt names it and says it must not
 * change. An empty one is handed to the reference image instead. Until QĐ-072
 * the prompt claimed to lock apparent age and skin tone whether or not anybody
 * had said what they were, which pinned whatever the model improvised on the
 * first frame and dressed it up as a rule.
 *
 * So the form shows, per field, which of the two it currently is. That is the
 * only honest way to ask somebody to fill a box in: by showing what filling it
 * does, and what leaving it empty does.
 *
 * ## Nothing here is required
 *
 * `approximateAge` and `skinTone` least of all. They are frequently unknown,
 * and a form that refuses to save without them teaches people to type something
 * plausible - which is then pasted into every prompt for that character
 * forever, indistinguishable from a fact. "unknown" is a valid answer and means
 * the same as blank, minus the nagging.
 */

export interface SheetFields {
  hair: string;
  facialFeatures: string;
  outfit: string;
  bodyProportions: string;
  accessories: string;
  colorPalette: string;
  presentation: string;
  approximateAge: string;
  skinTone: string;
  distinguishingFeatures: string;
  negativeIdentity: string;
}

/**
 * Mirrors `isStated` in the service, for the badge only.
 *
 * Deliberately a copy rather than an import: this file is a client component
 * and the service reaches Prisma. The authority is the server - what it decides
 * is what reaches the model - and this is a hint, redrawn from the saved row on
 * every reload.
 */
const NOT_SPECIFIED = new Set([
  "unknown",
  "not_specified",
  "not specified",
  "unspecified",
  "n/a",
  "na",
  "none",
  "-",
  "chưa rõ",
  "không rõ",
  "không xác định",
  "chưa xác định",
]);

function stated(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && !NOT_SPECIFIED.has(v.toLowerCase());
}

/** A field that becomes part of the lock clause once it has a value. */
function LockBadge({ value }: { value: string }) {
  return stated(value) ? (
    <Badge tone="ok">ĐANG KHOÁ</Badge>
  ) : (
    <Badge tone="warn">chưa khoá</Badge>
  );
}

/** A field that shapes the prompt but is never named in the lock clause. */
function MetaBadge() {
  return <Badge tone="neutral">mô tả thêm</Badge>;
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
  const unlocked = [
    ["tuổi", sheet.approximateAge],
    ["tông da", sheet.skinTone],
    ["tóc", sheet.hair],
    ["khuôn mặt", sheet.facialFeatures],
    ["đặc điểm nhận dạng", sheet.distinguishingFeatures],
    ["trang phục", sheet.outfit],
    ["dáng người", sheet.bodyProportions],
    ["phụ kiện", sheet.accessories],
  ]
    .filter(([, v]) => !stated(v as string))
    .map(([label]) => label as string);

  return (
    <ActionForm
      action={(formData) => saveCharacterSheet(characterId, formData)}
      submitLabel="Lưu hồ sơ nhân vật"
      submitVariant="secondary"
      className="rounded-lg border border-ink-800 p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <Label>Hồ sơ nhận dạng (chống trôi hình)</Label>
        <Badge tone="neutral">phiên bản v{version}</Badge>
      </div>

      <p className="mb-3 text-[11px] text-ink-400">
        Viết bằng tiếng Anh, ngắn gọn và cụ thể. Mục nào <strong>có giá trị</strong>{" "}
        sẽ được nêu tên trong câu khoá của mọi prompt kèm yêu cầu{" "}
        <em>không được thay đổi</em>. Mục để trống thì{" "}
        <strong>không khoá</strong> — prompt giao thuộc tính đó cho ảnh tham chiếu,
        thay vì tuyên bố khoá một giá trị không ai biết.
      </p>

      {unlocked.length > 0 ? (
        <Alert tone="warn" className="mb-3">
          Hiện <strong>không khoá</strong>: {unlocked.join(", ")}. Không sao cả —
          ảnh tham chiếu đang gánh phần này. Điền vào thì mới thành khoá thật.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Giới tính / thể hiện"
          hint="Không bắt buộc. Không nằm trong câu khoá — chỉ định hình mô tả."
        >
          <div className="mb-1">
            <MetaBadge />
          </div>
          <Input
            name="presentation"
            defaultValue={sheet.presentation}
            placeholder="boy / girl / androgynous"
          />
        </Field>

        <Field
          label="Tuổi ước chừng"
          hint="KHÔNG bắt buộc. Trống hoặc 'unknown' = không khoá thuộc tính này."
        >
          <div className="mb-1">
            <LockBadge value={sheet.approximateAge} />
          </div>
          <Input
            name="approximateAge"
            defaultValue={sheet.approximateAge}
            placeholder="around eight — hoặc để trống"
          />
        </Field>

        <Field
          label="Tông da"
          hint="KHÔNG bắt buộc. Trống hoặc 'unknown' = không khoá thuộc tính này."
        >
          <div className="mb-1">
            <LockBadge value={sheet.skinTone} />
          </div>
          <Input
            name="skinTone"
            defaultValue={sheet.skinTone}
            placeholder="light warm beige — hoặc để trống"
          />
        </Field>

        <Field label="Tóc" hint="Màu, độ dài, kiểu">
          <div className="mb-1">
            <LockBadge value={sheet.hair} />
          </div>
          <Input
            name="hair"
            defaultValue={sheet.hair}
            placeholder="short messy dark brown hair"
          />
        </Field>

        <Field label="Khuôn mặt" hint="Dáng mặt, mắt, biểu cảm thường trực">
          <div className="mb-1">
            <LockBadge value={sheet.facialFeatures} />
          </div>
          <Input
            name="facialFeatures"
            defaultValue={sheet.facialFeatures}
            placeholder="round face, large expressive eyes"
          />
        </Field>

        <Field
          label="Đặc điểm nhận dạng"
          hint="Sẹo, tàn nhang, răng khểnh — thứ KHÔNG tháo ra được, khác với phụ kiện."
        >
          <div className="mb-1">
            <LockBadge value={sheet.distinguishingFeatures} />
          </div>
          <Input
            name="distinguishingFeatures"
            defaultValue={sheet.distinguishingFeatures}
            placeholder="a small scar above the left eyebrow"
          />
        </Field>

        <Field label="Trang phục" hint="Bộ đồ mặc định">
          <div className="mb-1">
            <LockBadge value={sheet.outfit} />
          </div>
          <Input
            name="outfit"
            defaultValue={sheet.outfit}
            placeholder="bright yellow hoodie, blue jeans"
          />
        </Field>

        <Field label="Tỷ lệ cơ thể" hint="Chiều cao so với nhân vật khác, dáng người">
          <div className="mb-1">
            <LockBadge value={sheet.bodyProportions} />
          </div>
          <Input
            name="bodyProportions"
            defaultValue={sheet.bodyProportions}
            placeholder="slightly shorter than Leo, oversized head"
          />
        </Field>

        <Field label="Phụ kiện" hint="Thứ có thể tháo ra — kính, mũ, khăn.">
          <div className="mb-1">
            <LockBadge value={sheet.accessories} />
          </div>
          <Input
            name="accessories"
            defaultValue={sheet.accessories}
            placeholder="round glasses"
          />
        </Field>

        <Field label="Màu chủ đạo" hint="Định hình bảng màu. Không nằm trong câu khoá.">
          <div className="mb-1">
            <MetaBadge />
          </div>
          <Input
            name="colorPalette"
            defaultValue={sheet.colorPalette}
            placeholder="yellow, blue, white"
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field
          label="Ràng buộc phủ định về NHẬN DẠNG"
          hint="Tách riêng khỏi negative chung, và đứng TRƯỚC nó trong prompt — nhà cung cấp nào cắt bớt thì cắt vào văn mẫu, không cắt vào luật nhận dạng."
        >
          <div className="mb-1">
            <MetaBadge />
          </div>
          <Textarea
            name="negativeIdentity"
            rows={2}
            defaultValue={sheet.negativeIdentity}
            placeholder="never add glasses, never remove the scar"
          />
        </Field>
      </div>

      <p className="mt-3 text-[11px] text-ink-400">
        Phiên bản chỉ tăng khi <strong>ngoại hình</strong> thật sự đổi — sửa ghi
        chú hay seed thì không. Ảnh tham chiếu đã duyệt{" "}
        <strong>không bao giờ</strong> bị thay tự động, và lưu ở đây{" "}
        <strong>không tạo ảnh mới</strong>: tạo ảnh là một lần chi tiền, phải bấm
        riêng ở phần Ảnh tham chiếu bên dưới.
      </p>
    </ActionForm>
  );
}
