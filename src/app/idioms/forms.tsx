"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import { ActionButton, ActionForm, Disclosure } from "@/components/action-ui";
import {
  createIdiom,
  deleteIdiom,
  importIdioms,
  setIdiomStatus,
} from "@/app/actions/idioms";
import {
  DIFFICULTIES,
  IDIOM_CATEGORIES,
  IDIOM_STATUSES,
  REGIONS,
} from "@/domain/enums";

const CSV_TEMPLATE =
  "phrase,meaning,literalMeaning,exampleSentence,category,difficulty,region\n" +
  '"Break the ice","Start a conversation with new people","He arrives carrying an ice block and a tiny hammer","He told a joke to break the ice",Relationships,Beginner,General';

export function IdiomForms() {
  return (
    <div className="flex flex-wrap gap-2">
      <Disclosure label="+ Thêm thành ngữ">
        <Card>
          <CardHeader>
            <CardTitle>Thêm thành ngữ mới</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm
              action={createIdiom}
              submitLabel="Thêm thành ngữ"
              resetOnSuccess
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Thành ngữ (tiếng Anh)">
                  <Input name="phrase" placeholder="Break a leg" required />
                </Field>
                <Field label="Câu ví dụ">
                  <Input
                    name="exampleSentence"
                    placeholder="Break a leg on your interview!"
                    required
                  />
                </Field>
                <Field label="Nghĩa thật">
                  <Input name="meaning" placeholder="Good luck" required />
                </Field>
                <Field
                  label="Hiểu theo nghĩa đen (mô tả gag hoạt hình vô hại)"
                  hint="Viết dưới dạng trò đùa hoạt hình nhẹ nhàng, không bạo lực."
                >
                  <Input
                    name="literalMeaning"
                    placeholder="Anh ta quấn chân bằng băng gạc khổng lồ vì tưởng phải gãy chân thật"
                    required
                  />
                </Field>
                <Field label="Chủ đề">
                  <Select name="category" defaultValue="Funny Expressions">
                    {IDIOM_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Độ khó">
                  <Select name="difficulty" defaultValue="Beginner">
                    {DIFFICULTIES.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Vùng">
                  <Select name="region" defaultValue="General">
                    {REGIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Ghi chú">
                  <Input name="notes" placeholder="Tuỳ chọn" />
                </Field>
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      </Disclosure>

      <Disclosure label="Nhập hàng loạt (CSV / JSON)">
        <ImportPanel />
      </Disclosure>
    </div>
  );
}

function ImportPanel() {
  const [format, setFormat] = useState<"csv" | "json">("csv");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nhập hàng loạt</CardTitle>
      </CardHeader>
      <CardContent>
        <ActionForm action={importIdioms} submitLabel="Nhập dữ liệu">
          <div className="space-y-3">
            <Field label="Định dạng">
              <Select
                name="format"
                value={format}
                onChange={(e) =>
                  setFormat(e.currentTarget.value as "csv" | "json")
                }
              >
                <option value="csv">CSV (có dòng tiêu đề)</option>
                <option value="json">JSON (mảng đối tượng)</option>
              </Select>
            </Field>
            <Field
              label="Dữ liệu"
              hint="Các thành ngữ đã có trong thư viện sẽ tự động bị bỏ qua (chống trùng lặp)."
            >
              <Textarea
                name="payload"
                rows={8}
                className="font-mono text-xs"
                placeholder={
                  format === "csv"
                    ? CSV_TEMPLATE
                    : '[{"phrase":"Break the ice","meaning":"Start a conversation","literalMeaning":"...","exampleSentence":"..."}]'
                }
              />
            </Field>
          </div>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

export function IdiomRowActions({
  id,
  phrase,
  status,
}: {
  id: string;
  phrase: string;
  status: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <select
        defaultValue={status}
        onChange={(e) => void setIdiomStatus(id, e.currentTarget.value)}
        className="h-7 rounded-md border border-ink-700 bg-ink-850 px-1 text-[11px] text-ink-300"
        aria-label={`Trạng thái của ${phrase}`}
      >
        {IDIOM_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <ActionButton
        size="sm"
        variant="ghost"
        action={() => deleteIdiom(id)}
        confirm={`Xoá thành ngữ "${phrase}"?`}
        aria-label={`Xoá ${phrase}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </ActionButton>
    </div>
  );
}
