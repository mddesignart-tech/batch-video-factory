"use client";

import { Field, Input } from "@/components/ui";
import { ActionButton, ActionForm, Disclosure } from "@/components/action-ui";
import {
  clearProviderKey,
  saveProviderKey,
  setProviderPriority,
  toggleProvider,
} from "@/app/actions/config";

/**
 * Key entry never shows a stored secret back. The field is always empty on
 * load; the only thing the page can display is the mask the server computed.
 */
export function ProviderCard({
  id,
  name,
  enabled,
  hasStoredKey,
  canStoreKeys,
  priority,
  fallbackPriority,
}: {
  id: string;
  name: string;
  enabled: boolean;
  hasStoredKey: boolean;
  canStoreKeys: boolean;
  priority: number;
  fallbackPriority: number;
}) {
  return (
    <div className="space-y-3 border-t border-ink-800 pt-3">
      <div className="flex flex-wrap gap-2">
        <ActionButton
          size="sm"
          variant={enabled ? "outline" : "primary"}
          action={() => toggleProvider(id, !enabled)}
          disabled={name === "mock"}
        >
          {enabled ? "Tắt" : "Bật"}
        </ActionButton>
        {hasStoredKey ? (
          <ActionButton
            size="sm"
            variant="danger"
            action={() => clearProviderKey(id)}
            confirm="Xoá API key đã lưu?"
          >
            Xoá API key
          </ActionButton>
        ) : null}
      </div>

      {name !== "mock" ? (
        <Disclosure label="Cấu hình">
          <div className="space-y-4">
            {canStoreKeys ? (
              <ActionForm
                action={(formData) => saveProviderKey(id, formData)}
                submitLabel="Lưu API key"
                resetOnSuccess
              >
                <Field
                  label="API key"
                  hint="Được mã hoá AES-256-GCM trước khi lưu. Giao diện chỉ hiển thị 4 ký tự cuối."
                >
                  <Input
                    name="apiKey"
                    type="password"
                    autoComplete="off"
                    placeholder="Dán API key vào đây"
                  />
                </Field>
              </ActionForm>
            ) : null}

            <ActionForm
              action={(formData) => setProviderPriority(id, formData)}
              submitLabel="Lưu thứ tự ưu tiên"
            >
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Ưu tiên chính"
                  hint="Số nhỏ hơn được chọn trước."
                >
                  <Input
                    name="priority"
                    type="number"
                    min={1}
                    max={999}
                    defaultValue={priority}
                  />
                </Field>
                <Field
                  label="Ưu tiên dự phòng"
                  hint="Thứ tự khi nhà cung cấp chính thất bại."
                >
                  <Input
                    name="fallbackPriority"
                    type="number"
                    min={1}
                    max={999}
                    defaultValue={fallbackPriority}
                  />
                </Field>
              </div>
            </ActionForm>
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}
