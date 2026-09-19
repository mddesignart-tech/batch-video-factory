"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Textarea,
} from "@/components/ui";
import {
  importedCharacters,
  setImportedCharacterPrimary,
  updateImportedCharacter,
  uploadImportedCharacterReference,
  type ImportCharacterRow,
} from "@/app/actions/storyboard-import";

/**
 * Fix a character's identity without leaving the import screen.
 *
 * The flow this exists for: an operator imports three storyboards, sees that a
 * character has no reference image, and has to fix it BEFORE approving money -
 * because every scene drawing that character is otherwise a fresh guess. Making
 * them navigate to another page, find the character, come back and re-price is
 * how that check gets skipped.
 *
 * ## What it will not do
 *
 * Generate anything. The only way a reference image gets here is an upload.
 * Making a character's master costs money and is a decision to take
 * deliberately, not a side effect of tidying up an import.
 *
 * ## What it will not demand
 *
 * Age and skin tone. They are frequently unknown, and a form that refuses to
 * save without them teaches people to type something plausible - which then
 * gets pasted into every prompt for that character forever, indistinguishable
 * from a fact. Left blank they are simply not locked, and the panel says so.
 */
export function CharacterEditor({
  batchId,
  onChanged,
}: {
  batchId: string;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<ImportCharacterRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(
    null,
  );

  async function reload() {
    setRows(await importedCharacters(batchId));
  }

  // Keyed on the batch: a different batch is a different cast. `reload` is
  // recreated every render, so listing it here would refetch on every keystroke.
  useEffect(() => {
    void reload();
  }, [batchId]);

  if (!rows) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nhân vật</CardTitle>
        </CardHeader>
        <CardContent>
          <Loader2 className="h-4 w-4 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nhân vật trong lô ({rows.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {message ? (
          <Alert tone={message.tone === "ok" ? "ok" : "danger"}>{message.text}</Alert>
        ) : null}

        <Alert tone="info">
          Tuổi và tông da <strong>không bắt buộc</strong>. Bỏ trống (hoặc ghi
          &ldquo;unknown&rdquo;) thì hệ thống sẽ <strong>không khoá</strong> thuộc tính đó —
          nó giao cho ảnh tham chiếu, thay vì tuyên bố khoá một giá trị không ai biết.
        </Alert>

        {rows.map((row) => (
          <div key={row.name} className="rounded-lg border border-ink-800 p-3">
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-2 text-left"
              onClick={() => setOpen(open === row.name ? null : row.name)}
            >
              <span className="font-medium">{row.name}</span>
              <Badge
                tone={
                  row.readiness === "READY"
                    ? "ok"
                    : row.readiness === "NEEDS_CHARACTER_REFERENCE"
                      ? "danger"
                      : "warn"
                }
              >
                {row.readiness === "NEEDS_CHARACTER_REFERENCE"
                  ? "NEEDS_REFERENCE"
                  : row.readiness}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {row.referenceCount} ảnh tham chiếu
              </span>
              {row.lockedAttributes.length > 0 ? (
                <span className="text-xs text-ok-500">
                  khoá: {row.lockedAttributes.length}
                </span>
              ) : null}
              {row.unlockedAttributes.length > 0 ? (
                <span className="text-xs text-warn-500">
                  không khoá: {row.unlockedAttributes.join(", ")}
                </span>
              ) : null}
            </button>

            {open === row.name ? (
              <div className="mt-3 space-y-3">
                {row.warnings.map((w) => (
                  <Alert key={w} tone="warn">
                    {w}
                  </Alert>
                ))}

                {row.characterId === null ? (
                  <Alert tone="danger">
                    Chưa có nhân vật nào tên này trong bảng Nhân vật. Hãy sửa tên trong cảnh,
                    hoặc tạo nhân vật ở trang Nhân vật trước.
                  </Alert>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {row.references.map((r) => (
                        <div
                          key={r.id}
                          className="flex flex-col items-center gap-1 rounded-md border border-ink-800 p-2"
                        >
                          {/* Segment-encoded, as every other media URL in the
                              app is: a Windows path separator or a space in a
                              filename otherwise produces a broken image. */}
                          <img
                            src={`/api/media/${r.filePath
                              .split(/[\/]/)
                              .map(encodeURIComponent)
                              .join("/")}`}
                            alt={row.name}
                            className="h-24 w-16 rounded object-cover"
                          />
                          {r.isPrimary ? (
                            <Badge tone="ok">ảnh chính</Badge>
                          ) : (
                            <Button
                              variant="ghost"
                              className="text-[11px]"
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true);
                                const res = await setImportedCharacterPrimary(r.id, batchId);
                                setMessage({
                                  tone: res.ok ? "ok" : "danger",
                                  text: res.message,
                                });
                                await reload();
                                onChanged?.();
                                setBusy(false);
                              }}
                            >
                              Đặt làm ảnh chính
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>

                    <form
                      action={async (fd: FormData) => {
                        setBusy(true);
                        fd.set("characterId", row.characterId!);
                        fd.set("batchId", batchId);
                        const res = await uploadImportedCharacterReference(fd);
                        setMessage({ tone: res.ok ? "ok" : "danger", text: res.message });
                        await reload();
                        onChanged?.();
                        setBusy(false);
                      }}
                      className="flex items-end gap-2"
                    >
                      <Field label="Tải ảnh tham chiếu lên">
                        <Input type="file" name="file" accept="image/*" />
                      </Field>
                      <Button type="submit" disabled={busy}>
                        Tải lên
                      </Button>
                    </form>

                    <CharacterFields
                      row={row}
                      batchId={batchId}
                      busy={busy}
                      onSaved={async (text, ok) => {
                        setMessage({ tone: ok ? "ok" : "danger", text });
                        await reload();
                        onChanged?.();
                      }}
                      setBusy={setBusy}
                    />
                  </>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CharacterFields({
  row,
  batchId,
  busy,
  onSaved,
  setBusy,
}: {
  row: ImportCharacterRow;
  batchId: string;
  busy: boolean;
  onSaved: (message: string, ok: boolean) => Promise<void>;
  setBusy: (b: boolean) => void;
}) {
  const [draft, setDraft] = useState(row);
  useEffect(() => setDraft(row), [row]);

  const set = (key: keyof ImportCharacterRow) => (value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Tên">
          <Input value={draft.name} onChange={(e) => set("name")(e.target.value)} />
        </Field>
        <Field label="Giới tính / thể hiện" hint="Để trống nếu storyboard không nói.">
          <Input
            value={draft.presentation}
            onChange={(e) => set("presentation")(e.target.value)}
          />
        </Field>
        <Field
          label="Tuổi ước chừng"
          hint="KHÔNG bắt buộc. Trống hoặc 'unknown' = không khoá thuộc tính này."
        >
          <Input
            value={draft.approximateAge}
            onChange={(e) => set("approximateAge")(e.target.value)}
            placeholder="ví dụ: around eight — hoặc để trống"
          />
        </Field>
        <Field
          label="Tông da"
          hint="KHÔNG bắt buộc. Trống hoặc 'unknown' = không khoá thuộc tính này."
        >
          <Input
            value={draft.skinTone}
            onChange={(e) => set("skinTone")(e.target.value)}
            placeholder="ví dụ: light warm beige — hoặc để trống"
          />
        </Field>
        <Field label="Tóc">
          <Input value={draft.hair} onChange={(e) => set("hair")(e.target.value)} />
        </Field>
        <Field label="Khuôn mặt">
          <Input
            value={draft.facialFeatures}
            onChange={(e) => set("facialFeatures")(e.target.value)}
          />
        </Field>
        <Field label="Trang phục">
          <Input value={draft.outfit} onChange={(e) => set("outfit")(e.target.value)} />
        </Field>
        <Field label="Dáng người">
          <Input
            value={draft.bodyProportions}
            onChange={(e) => set("bodyProportions")(e.target.value)}
          />
        </Field>
        <Field
          label="Đặc điểm nhận dạng"
          hint="Sẹo, tàn nhang, răng khểnh — thứ không tháo ra được, khác với phụ kiện."
        >
          <Input
            value={draft.distinguishingFeatures}
            onChange={(e) => set("distinguishingFeatures")(e.target.value)}
          />
        </Field>
        <Field label="Phụ kiện">
          <Input
            value={draft.accessories}
            onChange={(e) => set("accessories")(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Bảng màu">
        <Input
          value={draft.colorPalette}
          onChange={(e) => set("colorPalette")(e.target.value)}
        />
      </Field>

      <Field
        label="Ràng buộc phủ định về nhận dạng"
        hint="Ví dụ: never add glasses, never remove the scar. Tách riêng khỏi negative chung."
      >
        <Textarea
          rows={2}
          value={draft.negativeIdentity}
          onChange={(e) => set("negativeIdentity")(e.target.value)}
        />
      </Field>

      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await updateImportedCharacter({
            characterId: draft.characterId!,
            batchId,
            name: draft.name,
            presentation: draft.presentation,
            approximateAge: draft.approximateAge,
            skinTone: draft.skinTone,
            hair: draft.hair,
            facialFeatures: draft.facialFeatures,
            distinguishingFeatures: draft.distinguishingFeatures,
            outfit: draft.outfit,
            bodyProportions: draft.bodyProportions,
            accessories: draft.accessories,
            colorPalette: draft.colorPalette,
            negativeIdentity: draft.negativeIdentity,
          });
          await onSaved(res.message, res.ok);
          setBusy(false);
        }}
      >
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Lưu hồ sơ nhân vật
      </Button>
    </div>
  );
}
