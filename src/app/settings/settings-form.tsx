"use client";

import { Field, Input, Select } from "@/components/ui";
import { ActionForm } from "@/components/action-ui";
import { updateSettings } from "@/app/actions/config";
import { QUALITY_MODES, VI_QUALITY_MODE } from "@/domain/enums";
import type { AppSettings } from "@/lib/settings";

export function SettingsForm({ settings }: { settings: AppSettings }) {
  return (
    <ActionForm action={updateSettings} submitLabel="Lưu cài đặt">
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-300 uppercase">
            Mặc định cho dự án mới
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Chế độ tạo">
              <Select
                name="defaultQualityMode"
                defaultValue={settings.defaultQualityMode}
              >
                {QUALITY_MODES.map((m) => (
                  <option key={m} value={m}>
                    {VI_QUALITY_MODE[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Thời lượng mục tiêu (giây)">
              <Input
                name="defaultTargetDuration"
                type="number"
                min={15}
                max={60}
                defaultValue={settings.defaultTargetDuration}
              />
            </Field>
            <Field label="Ngân sách tối đa (USD)">
              <Input
                name="defaultMaxBudget"
                type="number"
                min={0}
                step="0.5"
                defaultValue={settings.defaultMaxBudget}
              />
            </Field>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-300 uppercase">
            Hàng đợi công việc
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Số job chạy song song"
              hint="Giữ ở mức 1-2. Đây là cái chặn việc vô tình gọi hàng loạt API tính phí cùng lúc."
            >
              <Input
                name="jobConcurrency"
                type="number"
                min={1}
                max={8}
                defaultValue={settings.jobConcurrency}
              />
            </Field>
            <Field
              label="Số lần thử lại tối đa"
              hint="Giãn cách giữa các lần thử: 10 giây, 30 giây, 90 giây."
            >
              <Input
                name="maxRetries"
                type="number"
                min={1}
                max={10}
                defaultValue={settings.maxRetries}
              />
            </Field>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-300 uppercase">
            Render
          </h3>
          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input
              type="checkbox"
              name="burnSubtitles"
              defaultChecked={settings.burnSubtitles}
              className="h-3.5 w-3.5"
            />
            Ghi phụ đề trực tiếp lên video (khuyến nghị cho Shorts/TikTok)
          </label>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-300 uppercase">
            Dọn dẹp media
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Xoá tệp tạm sau (ngày)">
              <Input
                name="cleanupTempDays"
                type="number"
                min={1}
                max={365}
                defaultValue={settings.cleanupTempDays}
              />
            </Field>
            <Field label="Xoá tệp của job thất bại sau (ngày)">
              <Input
                name="cleanupFailedDays"
                type="number"
                min={1}
                max={365}
                defaultValue={settings.cleanupFailedDays}
              />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-ink-500">
            Video hoàn chỉnh được giữ vĩnh viễn và không bao giờ bị tự động xoá.
            Chạy dọn dẹp bằng lệnh <code className="text-ink-300">npm run cleanup</code>.
          </p>
        </section>
      </div>
    </ActionForm>
  );
}
