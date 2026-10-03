"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Plus, Wand2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import {
  addReferenceAction,
  addReferencePicturesAction,
  autoAssignReferencesAction,
  continueWithoutReferencesAction,
  setSceneReferencesAction,
  updateReferenceAction,
} from "@/app/actions/references";
import { REFERENCE_TYPES, VI_REFERENCE_PRIORITY, VI_REFERENCE_TYPE, type ReferencePriority, type ReferenceType } from "@/domain/reference";

export interface PanelReference {
  id: string;
  type: ReferenceType;
  name: string;
  priority: ReferencePriority;
  enabled: boolean;
  useThroughout: boolean;
  version: number;
  source: "REFERENCE" | "CHARACTER_BIBLE";
  images: { assetId: string; path: string; filename: string; primary: boolean; exists: boolean }[];
}

export interface PanelScene {
  id: string;
  sceneNumber: number;
  referenceIds: string[];
  characters: string[];
  withoutReferences: boolean;
  referenceProblem: string | null;
}

const media = (p: string) => `/api/media/${p.split(/[\\/]/).map(encodeURIComponent).join("/")}`;

/**
 * "Tài sản tham chiếu": what must look the same in every scene - characters
 * (from the Character Bible, edited on the Characters page), products, props,
 * toys, animals, logos, a style. A person uploads, names, picks a kind. Every
 * button here is $0; pictures are made only after preflight + approval.
 */
export function ReferencePanel({ projectId, references, scenes, title }: { projectId: string; references: PanelReference[]; scenes: PanelScene[]; title: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<ReferenceType>("PRODUCT");
  const own = references.filter((r) => r.source === "REFERENCE");

  const act = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.message });
      router.refresh();
    });

  return (
    <Card id="tham-chieu">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <div className="flex gap-2">
            {own.length > 0 ? (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => autoAssignReferencesAction(projectId))}>
                <Wand2 className="h-3.5 w-3.5" /> Tự động gợi ý theo cảnh
              </Button>
            ) : null}
            <Button size="sm" variant="primary" onClick={() => setAdding(!adding)}>
              <Plus className="h-3.5 w-3.5" /> THÊM THAM CHIẾU
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-ink-500">
          Ảnh tham chiếu giúp nhân vật, sản phẩm, đồ chơi, con vật… giữ đúng hình dáng ở mọi cảnh. Tải ảnh, đặt tên, chọn loại
          là xong. Không tốn phí.
        </p>

        {adding ? (
          <form
            className="grid gap-2 rounded-lg border border-ink-700 p-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              act(async () => {
                const r = await addReferenceAction(projectId, data);
                if (r.ok) setAdding(false);
                return r;
              });
            }}
          >
            <Field label="Loại">
              <Select name="type" value={type} onChange={(e) => setType(e.currentTarget.value as ReferenceType)}>
                {REFERENCE_TYPES.filter((t) => t !== "CHARACTER").map((t) => (
                  <option key={t} value={t}>
                    {VI_REFERENCE_TYPE[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tên" hint="Ví dụ: Máy xay mini ABC, Xe tải vàng của Ben, Mèo Mun">
              <Input name="name" required />
            </Field>
            <Field label="Ảnh (nhiều góc của CÙNG một thứ)">
              <Input name="files" type="file" accept="image/png,image/jpeg,image/webp" multiple required />
            </Field>
            <Field label="Mô tả ngắn (không bắt buộc)">
              <Input name="description" placeholder="Màu, chất liệu, chi tiết cần giữ…" />
            </Field>
            <label className="flex items-center gap-2 text-xs text-ink-300">
              <input type="checkbox" name="useThroughout" defaultChecked={type === "PRODUCT"} key={type} />
              Dùng xuyên suốt video
            </label>
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={pending}>
                {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Lưu tham chiếu
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Huỷ
              </Button>
            </div>
          </form>
        ) : null}

        {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}

        {REFERENCE_TYPES.map((t) => {
          const list = references.filter((r) => r.type === t);
          if (list.length === 0) return null;
          return (
            <div key={t}>
              <p className="mb-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">{VI_REFERENCE_TYPE[t]}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {list.map((r) => (
                  <div key={r.id} className="rounded-lg border border-ink-800 p-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-ink-100">{r.name}</span>
                      {r.source === "CHARACTER_BIBLE" ? <Badge>Từ trang Nhân vật</Badge> : <Badge tone="brand">{VI_REFERENCE_PRIORITY[r.priority]}</Badge>}
                      {r.useThroughout ? <Badge tone="info">Xuyên suốt</Badge> : null}
                      {!r.enabled ? <Badge tone="danger">Đang tắt</Badge> : null}
                      {r.version > 1 && r.source === "REFERENCE" ? <Badge>v{r.version}</Badge> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.images.length === 0 ? <span className="text-xs text-ink-500">Chưa có ảnh</span> : null}
                      {r.images.map((img) => (
                        <button
                          key={img.assetId}
                          type="button"
                          title={img.primary ? "Ảnh chính" : r.source === "REFERENCE" ? "Đặt làm ảnh chính" : img.filename}
                          disabled={pending || img.primary || r.source !== "REFERENCE"}
                          onClick={() => act(() => updateReferenceAction(projectId, r.id, { primaryAssetId: img.assetId }))}
                          className={`relative h-14 w-14 overflow-hidden rounded border ${img.primary ? "border-brand-500" : "border-ink-700"}`}
                        >
                          {img.exists ? (
                            <img src={media(img.path)} alt={img.filename} className="h-full w-full object-cover" />
                          ) : (
                            <span className="text-[9px] text-danger-500">MẤT FILE</span>
                          )}
                        </button>
                      ))}
                    </div>
                    {r.source === "REFERENCE" ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <label className="cursor-pointer text-accent-500 hover:underline">
                          + Thêm ảnh
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                              const data = new FormData();
                              for (const f of Array.from(e.currentTarget.files ?? [])) data.append("files", f);
                              act(() => addReferencePicturesAction(projectId, r.id, data));
                            }}
                          />
                        </label>
                        <label className="flex items-center gap-1 text-ink-300">
                          <input
                            type="checkbox"
                            checked={r.useThroughout}
                            disabled={pending}
                            onChange={(e) => act(() => updateReferenceAction(projectId, r.id, { useThroughout: e.currentTarget.checked }))}
                          />
                          Xuyên suốt video
                        </label>
                        <label className="flex items-center gap-1 text-ink-300">
                          <input
                            type="checkbox"
                            checked={r.enabled}
                            disabled={pending}
                            onChange={(e) => act(() => updateReferenceAction(projectId, r.id, { enabled: e.currentTarget.checked }))}
                          />
                          Đang dùng
                        </label>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {own.length > 0 && scenes.length > 0 ? (
          <div>
            <p className="mb-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">Tham chiếu trong từng cảnh</p>
            <div className="space-y-1">
              {scenes.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-ink-800 px-2 py-1 text-xs">
                  <span className="w-14 font-semibold text-ink-200">Cảnh {s.sceneNumber}</span>
                  {s.characters.map((c) => (
                    <span key={c} className="text-ink-400">✓ {c}</span>
                  ))}
                  {own.map((r) => (
                    <label key={r.id} className="flex items-center gap-1 text-ink-200">
                      <input
                        type="checkbox"
                        checked={s.referenceIds.includes(r.id)}
                        disabled={pending || !r.enabled}
                        onChange={(e) => {
                          const next = e.currentTarget.checked ? [...s.referenceIds, r.id] : s.referenceIds.filter((x) => x !== r.id);
                          act(() => setSceneReferencesAction(projectId, s.id, next));
                        }}
                      />
                      {r.name}
                    </label>
                  ))}
                  {s.referenceProblem ? (
                    <span className="flex flex-wrap items-center gap-2 text-warn-500">
                      {s.referenceProblem}
                      <a href="#storyboard" className="underline">CHỌN MODEL KHÁC</a>
                      <button type="button" className="underline" onClick={() => act(() => continueWithoutReferencesAction(projectId, s.id, true))}>
                        TIẾP TỤC KHÔNG DÙNG THAM CHIẾU
                      </button>
                    </span>
                  ) : null}
                  {s.withoutReferences ? (
                    <button type="button" className="text-warn-500 underline" onClick={() => act(() => continueWithoutReferencesAction(projectId, s.id, false))}>
                      Đang tạo không dùng tham chiếu - bật lại
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-ink-500">
              Chuyển động nội bộ (Local Motion) cho một cảnh: chọn trong Storyboard → Chuyển động → LOCAL_MOTION ($0).
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
