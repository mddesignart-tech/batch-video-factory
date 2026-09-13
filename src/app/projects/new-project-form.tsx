"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
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
import { createProject } from "@/app/actions/projects";
import {
  QUALITY_MODES,
  ROUTER_STRATEGIES,
  VI_QUALITY_MODE,
  VI_ROUTER_STRATEGY,
} from "@/domain/enums";

interface IdiomOption {
  id: string;
  phrase: string;
  meaning: string;
  category: string;
}

/**
 * Creating a project generates the script immediately (free) but never starts
 * media generation - that is a separate, budget-checked press on the project
 * page. The copy below says so, because it is the difference between a $0
 * click and a paid one.
 */
export function NewProjectForm({
  idioms,
  presets,
  preselectedIdiomId,
}: {
  idioms: IdiomOption[];
  presets: { id: string; name: string; isDefault: boolean }[];
  preselectedIdiomId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? idioms.filter((i) =>
        `${i.phrase} ${i.meaning}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      )
    : idioms;

  const defaultPreset = presets.find((p) => p.isDefault) ?? presets[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tạo dự án mới</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            setError(null);
            startTransition(async () => {
              const result = await createProject(formData);
              if (result.ok && result.projectId) {
                router.push(`/projects/${result.projectId}`);
              } else {
                setError(result.message);
              }
            });
          }}
        >
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Field
                label="Thành ngữ"
                hint={`${filtered.length} thành ngữ khả dụng (chưa dùng hoặc đã lên kế hoạch)`}
              >
                <Input
                  placeholder="Gõ để lọc, ví dụ: break a leg"
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                  className="mb-2"
                />
                <Select
                  name="idiomId"
                  required
                  defaultValue={preselectedIdiomId ?? ""}
                  size={1}
                >
                  <option value="">-- Chọn thành ngữ --</option>
                  {filtered.slice(0, 200).map((idiom) => (
                    <option key={idiom.id} value={idiom.id}>
                      {idiom.phrase} — {idiom.meaning}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Chế độ tạo">
              <Select name="qualityMode" defaultValue="BALANCED">
                {QUALITY_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {VI_QUALITY_MODE[mode]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Chiến lược chọn mô hình">
              <Select name="routerStrategy" defaultValue="AUTO">
                {ROUTER_STRATEGIES.map((s) => (
                  <option key={s} value={s}>
                    {VI_ROUTER_STRATEGY[s]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Phong cách hình ảnh">
              <Select name="stylePresetId" defaultValue={defaultPreset?.id ?? ""}>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                    {preset.isDefault ? " (mặc định)" : ""}
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
              label="Ngân sách tối đa (USD)"
              hint="Nếu chi phí ước tính vượt mức này, quá trình tạo media sẽ không bắt đầu."
            >
              <Input
                name="maxBudget"
                type="number"
                min={0}
                step="0.5"
                defaultValue={10}
              />
            </Field>
          </div>

          <input type="hidden" name="generateScript" value="true" />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Tạo dự án + kịch bản
            </Button>
            <p className="text-xs text-ink-500">
              Bước này chỉ tạo kịch bản và chưa tốn phí. Việc tạo media là một
              bước riêng có kiểm tra ngân sách.
            </p>
          </div>

          {error ? (
            <div className="mt-3">
              <Alert tone="danger" title={error} />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
