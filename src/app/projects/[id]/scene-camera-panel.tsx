"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Camera, Layers, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { Alert, Badge, Button, Field, Select } from "@/components/ui";
import {
  CAMERA_ANGLES,
  CAMERA_EASINGS,
  CAMERA_MOVES,
  CAMERA_SPEEDS,
  FOCUS_STYLES,
  SHOT_SIZES,
  SIMPLE_ANGLES,
  SIMPLE_MOVES,
  TRANSITIONS,
  VI_CAMERA_ANGLE,
  VI_CAMERA_EASING,
  VI_TRANSITION,
  VI_CAMERA_MOVE,
  VI_CAMERA_SPEED,
  VI_FOCUS,
  VI_SHOT_SIZE,
  type CameraPlan,
} from "@/domain/camera-grammar";
import {
  applySuggestedCameraAction,
  dropInteractionAction,
  enableCompositeAction,
  reduceCameraMotionAction,
  resetSceneCameraAction,
  setSceneAmbientAction,
  setSceneCameraAction,
  setSceneLayoutAction,
  useLocalCameraAction,
} from "@/app/actions/scene-camera";

/** Everything the panel shows for one scene, computed on the server. No technical schema. */
export interface SceneCameraView {
  sceneId: string;
  /** "AUTO" | "USER" | "LEGACY" (a scene from before scene plans) */
  source: "AUTO" | "USER" | "LEGACY";
  summary: string;
  reason: string;
  camera: Pick<CameraPlan, "shotSize" | "cameraAngle" | "cameraMovement" | "cameraSpeed" | "focusStyle" | "transitionIn" | "cameraEasing">;
  /** The first scene has nothing before it, so no transition in. */
  first: boolean;
  layers: { type: string; label: string; motion: string; enabled: boolean }[];
  suggestion: { summary: string; reason: string; differs: boolean };
  route: string;
  cost: { label: string; how: string; cost: number }[];
  /** The camera asks for something the scene's Video AI model does not promise. */
  warning: string | null;
  hasAmbient: boolean;
  ambientOn: boolean;
  composite: { available: boolean; reason: string; active: boolean };
  /** A composited scene: each cut-out's size / standing line and the location's horizon (null = automatic). */
  placement: {
    subjects: { id: string; label: string; entityType: string; scale: number | null; floorY: number | null }[];
    horizonY: number | null;
  } | null;
  notes: string[];
  /** G11: the subjects touch / hand things over - separate layers may look pasted on. */
  interaction: {
    notice: string;
    hint: string;
    choices: { id: "SIMPLER_SCENE" | "KEEP_SEPARATE" | "VIDEO_AI" | "DROP_INTERACTION"; label: string; available: boolean; note?: string }[];
  } | null;
}

/** Size of a cut-out within its layout box (1 = a standing person). "" = automatic. */
const SIZES: [string, string][] = [
  ["", "Tự động"],
  ["0.3", "Rất nhỏ"],
  ["0.45", "Nhỏ"],
  ["0.6", "Vừa"],
  ["0.8", "Lớn"],
  ["1", "Cỡ người đứng"],
];
const share = (v: number | null) => (v === null ? "" : String(Number(v.toFixed(2))));
const shareOf = (v: string): number | null => (v === "" ? null : Number(v));
/** Lines every 5 % of the frame height, as option values. */
const lines = (from: number, to: number) =>
  Array.from({ length: Math.round((to - from) / 0.05) + 1 }, (_, i) => String(Number((from + i * 0.05).toFixed(2))));

const usd = (n: number) => (n > 0 ? `~$${n.toFixed(2)}` : "$0");

export function SceneCameraPanel({ view }: { view: SceneCameraView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState(view.camera);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) setEditing(false);
      router.refresh();
    });

  const shots = SHOT_SIZES;
  const angles = advanced ? CAMERA_ANGLES : SIMPLE_ANGLES;
  const moves = (advanced ? CAMERA_MOVES : SIMPLE_MOVES).filter((m) => m !== "AUTO");

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-ink-800 p-3 text-xs">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
          <Layers className="h-3.5 w-3.5" /> Camera & lớp cảnh
        </p>
        <Badge tone={view.source === "USER" ? "warn" : view.source === "LEGACY" ? "neutral" : "brand"}>
          {view.source === "USER" ? "Bạn đã chỉnh" : view.source === "LEGACY" ? "Như trước" : "Camera tự động"}
        </Badge>
      </div>

      <ul className="space-y-0.5">
        {view.layers.map((l, i) => (
          <li key={i} className={l.enabled ? "text-ink-200" : "text-ink-600 line-through"}>
            <span className="text-ink-500">{l.type}:</span> {l.label}
            {l.motion ? <span className="text-ink-500"> · {l.motion}</span> : null}
          </li>
        ))}
        <li className="text-ink-200">
          <span className="text-ink-500">Camera:</span> {view.summary}
        </li>
        {!view.first && view.source !== "LEGACY" ? (
          <li className="text-ink-200">
            <span className="text-ink-500">Chuyển cảnh vào:</span> {VI_TRANSITION[view.camera.transitionIn]}
          </li>
        ) : null}
      </ul>
      {view.hasAmbient ? (
        <label className="flex items-center gap-2 text-ink-300">
          <input type="checkbox" checked={view.ambientOn} disabled={pending} onChange={(e) => run(() => setSceneAmbientAction(view.sceneId, e.currentTarget.checked))} />
          Chuyển động nền nhẹ (có thể tắt)
        </label>
      ) : null}
      {view.notes.length ? <p className="text-[11px] text-ink-500">{view.notes.join(" ")}</p> : null}

      <div className="rounded border border-ink-800 bg-ink-900/40 p-2">
        <p className="flex items-center gap-1 font-semibold text-ink-200">
          <Sparkles className="h-3 w-3" /> CAMERA ĐỀ XUẤT
        </p>
        <p className="text-ink-200">{view.suggestion.summary}</p>
        <p className="text-ink-500">Lý do: {view.suggestion.reason}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {view.source !== "AUTO" || view.suggestion.differs ? (
            <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => applySuggestedCameraAction(view.sceneId))}>
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} DÙNG GỢI Ý
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setEditing((v) => !v)}>
            <Camera className="h-3 w-3" /> ĐỔI CAMERA
          </Button>
          {view.source === "USER" ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => resetSceneCameraAction(view.sceneId))}>
              <RotateCcw className="h-3 w-3" /> Đặt lại tự động
            </Button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Cỡ cảnh">
            <Select value={draft.shotSize} onChange={(e) => setDraft({ ...draft, shotSize: e.currentTarget.value as CameraPlan["shotSize"] })}>
              {shots.map((s) => (
                <option key={s} value={s}>
                  {VI_SHOT_SIZE[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Góc máy">
            <Select value={draft.cameraAngle} onChange={(e) => setDraft({ ...draft, cameraAngle: e.currentTarget.value as CameraPlan["cameraAngle"] })}>
              {[...new Set([...angles, draft.cameraAngle])].map((s) => (
                <option key={s} value={s}>
                  {VI_CAMERA_ANGLE[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Chuyển động">
            <Select value={draft.cameraMovement} onChange={(e) => setDraft({ ...draft, cameraMovement: e.currentTarget.value as CameraPlan["cameraMovement"] })}>
              {[...new Set([...moves, draft.cameraMovement])].map((s) => (
                <option key={s} value={s}>
                  {VI_CAMERA_MOVE[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Focus">
            <Select value={draft.focusStyle} onChange={(e) => setDraft({ ...draft, focusStyle: e.currentTarget.value as CameraPlan["focusStyle"] })}>
              {FOCUS_STYLES.map((s) => (
                <option key={s} value={s}>
                  {VI_FOCUS[s]}
                </option>
              ))}
            </Select>
          </Field>
          {!view.first ? (
            <Field label="Chuyển cảnh vào">
              <Select value={draft.transitionIn} onChange={(e) => setDraft({ ...draft, transitionIn: e.currentTarget.value as CameraPlan["transitionIn"] })}>
                {TRANSITIONS.filter((t) => t !== "NONE" || draft.transitionIn === "NONE").map((t) => (
                  <option key={t} value={t}>
                    {VI_TRANSITION[t]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {advanced ? (
            <Field label="Gia tốc chuyển động">
              <Select value={draft.cameraEasing} onChange={(e) => setDraft({ ...draft, cameraEasing: e.currentTarget.value as CameraPlan["cameraEasing"] })}>
                {CAMERA_EASINGS.map((s) => (
                  <option key={s} value={s}>
                    {VI_CAMERA_EASING[s]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {advanced ? (
            <Field label="Tốc độ máy">
              <Select value={draft.cameraSpeed} onChange={(e) => setDraft({ ...draft, cameraSpeed: e.currentTarget.value as CameraPlan["cameraSpeed"] })}>
                {CAMERA_SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {VI_CAMERA_SPEED[s]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => setSceneCameraAction(view.sceneId, draft))}>
              Lưu camera · $0
            </Button>
            <label className="flex items-center gap-1.5 text-ink-400">
              <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.currentTarget.checked)} /> Nâng cao (dolly, truck, orbit, crane...)
            </label>
          </div>
          <p className="text-[11px] text-ink-500 sm:col-span-2">Focus chỉ áp dụng cho ảnh/Video AI; chuyển động tại máy không giả lập focus.</p>
        </div>
      ) : null}

      {view.warning ? (
        <Alert tone="warn" title={view.warning}>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => useLocalCameraAction(view.sceneId))}>
              DÙNG CAMERA LOCAL
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => reduceCameraMotionAction(view.sceneId))}>
              GIẢM CHUYỂN ĐỘNG
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setEditing(true)}>
              ĐỔI CAMERA
            </Button>
            <a href="#video-ai" className="self-center text-ink-300 underline">
              CHỌN MODEL KHÁC
            </a>
          </div>
        </Alert>
      ) : null}

      <div className="space-y-0.5">
        <p className="text-ink-500">Chi phí chuyển động ({view.route}):</p>
        {view.cost.map((c, i) => (
          <p key={i} className="flex justify-between gap-2">
            <span>
              {c.label}: <span className="text-ink-400">{c.how}</span>
            </span>
            <span className={c.cost > 0 ? "text-warn-300" : "text-ok-300"}>{usd(c.cost)}</span>
          </p>
        ))}
      </div>

      {view.interaction ? (
        <Alert tone="warn" title={view.interaction.notice}>
          <p className="text-ink-400">{view.interaction.hint}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {view.interaction.choices.map((c) =>
              c.id === "VIDEO_AI" ? (
                <a key={c.id} href="#video-ai" title={c.note} className={`self-center underline ${c.available ? "text-ink-300" : "text-ink-600"}`}>
                  {c.label.toUpperCase()}
                  {c.note ? ` · ${c.note}` : ""}
                </a>
              ) : (
                <Button
                  key={c.id}
                  size="sm"
                  variant="outline"
                  disabled={pending || (c.id === "KEEP_SEPARATE" && !view.composite.available && !view.composite.active)}
                  onClick={() =>
                    run(() =>
                      c.id === "SIMPLER_SCENE"
                        ? useLocalCameraAction(view.sceneId)
                        : c.id === "KEEP_SEPARATE"
                          ? enableCompositeAction(view.sceneId)
                          : dropInteractionAction(view.sceneId),
                    )
                  }
                >
                  {c.label.toUpperCase()}
                </Button>
              ),
            )}
          </div>
        </Alert>
      ) : null}

      {view.composite.active ? (
        <p className="text-ok-300">Ghép lớp tại máy đang bật · $0.</p>
      ) : view.composite.available ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => enableCompositeAction(view.sceneId))}>
          GHÉP LỚP TẠI MÁY · $0
        </Button>
      ) : view.composite.reason ? (
        <p className="text-ink-500">Ghép lớp tại máy: {view.composite.reason}</p>
      ) : null}
      {view.composite.active && view.placement ? (
        <div className="space-y-1.5 rounded border border-ink-800 p-2">
          <p className="font-semibold text-ink-200">VỊ TRÍ TRONG KHUNG · $0</p>
          {view.placement.subjects.map((sub) => (
            <div key={sub.id} className="grid gap-1.5 sm:grid-cols-2">
              <Field label={`Cỡ: ${sub.label}`}>
                <Select
                  value={share(sub.scale)}
                  disabled={pending}
                  onChange={(e) => run(() => setSceneLayoutAction(view.sceneId, { subjects: [{ id: sub.id, scale: shareOf(e.currentTarget.value) }] }))}
                >
                  {SIZES.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Chỗ đứng (đáy chủ thể)" hint="Sản phẩm trên bàn: chọn ngang mặt bàn trong ảnh.">
                <Select
                  value={share(sub.floorY)}
                  disabled={pending}
                  onChange={(e) => run(() => setSceneLayoutAction(view.sceneId, { subjects: [{ id: sub.id, floorY: shareOf(e.currentTarget.value) }] }))}
                >
                  <option value="">Tự động</option>
                  {lines(0.4, 0.95).map((v) => (
                    <option key={v} value={v}>
                      {Math.round(Number(v) * 100)}% chiều cao khung
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ))}
          <Field label="Đường chân trời của bối cảnh" hint="Xe, người đi đường ở xa chạy trên đường này.">
            <Select
              value={share(view.placement.horizonY)}
              disabled={pending}
              onChange={(e) => run(() => setSceneLayoutAction(view.sceneId, { horizonY: shareOf(e.currentTarget.value) }))}
            >
              <option value="">Tự động</option>
              {lines(0.35, 0.75).map((v) => (
                <option key={v} value={v}>
                  {Math.round(Number(v) * 100)}% từ trên xuống
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-[11px] text-ink-500">Chỉ đổi cách ghép tại máy: bấm RENDER LẠI · $0 API để xem.</p>
        </div>
      ) : null}
      {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}
    </div>
  );
}
