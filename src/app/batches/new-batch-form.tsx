"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from "@/components/ui";
import { ActionForm } from "@/components/action-ui";
import { createBatch } from "@/app/actions/config";
import { formatUSD } from "@/lib/utils";
import { QUALITY_MODES, VI_QUALITY_MODE, type QualityMode } from "@/domain/enums";

const AMOUNT_SHORTCUTS = [5, 10, 20, 50];

export function NewBatchForm({
  presets,
  categories,
  difficulties,
  costPerVideo,
  availableIdioms,
}: {
  presets: { id: string; name: string }[];
  categories: string[];
  difficulties: string[];
  costPerVideo: Record<QualityMode, number>;
  availableIdioms: number;
}) {
  const [amount, setAmount] = useState(10);
  const [mode, setMode] = useState<QualityMode>("BALANCED");
  const [budget, setBudget] = useState(40);

  const unitCost = costPerVideo[mode] ?? 0;
  const projected = unitCost * amount;
  const overBudget = projected > budget;
  const notEnoughIdioms = amount > availableIdioms;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lô mới</CardTitle>
      </CardHeader>
      <CardContent>
        <ActionForm action={createBatch} submitLabel="Tạo lô" resetOnSuccess>
          <div className="grid gap-3 lg:grid-cols-3">
            <Field label="Tên lô">
              <Input
                name="name"
                placeholder="Funny Idioms Batch #001"
                defaultValue="Funny Idioms Batch #001"
                required
              />
            </Field>

            <Field
              label="Số lượng video"
              hint={`${availableIdioms} thành ngữ khả dụng trong thư viện`}
            >
              <div className="flex gap-1.5">
                {AMOUNT_SHORTCUTS.map((n) => (
                  <Button
                    key={n}
                    type="button"
                    size="sm"
                    variant={amount === n ? "primary" : "outline"}
                    onClick={() => setAmount(n)}
                  >
                    {n}
                  </Button>
                ))}
                <Input
                  name="amount"
                  type="number"
                  min={1}
                  max={200}
                  value={amount}
                  onChange={(e) => setAmount(Number(e.currentTarget.value) || 1)}
                  className="w-20"
                />
              </div>
            </Field>

            <Field label="Chế độ tạo">
              <Select
                name="qualityMode"
                value={mode}
                onChange={(e) => setMode(e.currentTarget.value as QualityMode)}
              >
                {QUALITY_MODES.map((m) => (
                  <option key={m} value={m}>
                    {VI_QUALITY_MODE[m]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Chủ đề (tuỳ chọn)">
              <Select name="category" defaultValue="">
                <option value="">Mọi chủ đề</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Độ khó (tuỳ chọn)">
              <Select name="difficulty" defaultValue="">
                <option value="">Mọi độ khó</option>
                {difficulties.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Phong cách">
              <Select name="stylePresetId" defaultValue={presets[0]?.id ?? ""}>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Thời lượng mục tiêu (giây)">
              <Input
                name="targetDuration"
                type="number"
                min={15}
                max={60}
                defaultValue={25}
              />
            </Field>

            <Field
              label="Ngân sách tối đa cho cả lô (USD)"
              hint="Ngân sách được chia đều cho từng dự án trong lô."
            >
              <Input
                name="maxBudget"
                type="number"
                min={0}
                step="1"
                value={budget}
                onChange={(e) => setBudget(Number(e.currentTarget.value) || 0)}
              />
            </Field>

            <Field
              label="Số job chạy song song"
              hint="Giữ ở mức thấp để tránh gọi nhiều API tính phí cùng lúc."
            >
              <Input
                name="concurrency"
                type="number"
                min={1}
                max={8}
                defaultValue={2}
              />
            </Field>
          </div>

          <div className="mt-4 space-y-2">
            <div className="rounded-lg border border-ink-800 bg-ink-850 px-4 py-3 text-xs">
              <div className="flex justify-between">
                <span className="text-ink-400">
                  Chi phí ước tính / video ({VI_QUALITY_MODE[mode]})
                </span>
                <span className="tabular-nums text-ink-200">
                  {formatUSD(unitCost)}
                </span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-ink-400">
                  Tổng ước tính cho {amount} video
                </span>
                <span
                  className={`font-semibold tabular-nums ${
                    overBudget ? "text-danger-500" : "text-brand-400"
                  }`}
                >
                  {formatUSD(projected)}
                </span>
              </div>
            </div>

            {overBudget ? (
              <Alert tone="danger" title="Vượt ngân sách của lô">
                Ước tính {formatUSD(projected)} vượt ngân sách{" "}
                {formatUSD(budget)}. Hãy giảm số lượng video, đổi sang chế độ rẻ
                hơn, hoặc tăng ngân sách.
              </Alert>
            ) : null}

            {notEnoughIdioms ? (
              <Alert tone="warn" title="Không đủ thành ngữ">
                Bạn yêu cầu {amount} video nhưng chỉ còn {availableIdioms} thành
                ngữ chưa dùng. Lô sẽ tạo tối đa {availableIdioms} video.
              </Alert>
            ) : null}
          </div>
        </ActionForm>
      </CardContent>
    </Card>
  );
}
