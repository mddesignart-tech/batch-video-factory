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
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import {
  importedScenes,
  reestimateImportBatch,
  updateImportedScene,
  type ImportedSceneRow,
} from "@/app/actions/storyboard-import";
import type { ImportPreflight } from "@/services/import-preflight";

/**
 * Editing an imported scene, before a single cent is committed.
 *
 * The estimate on screen goes STALE the moment a row is saved, and this says so
 * rather than quietly recalculating: the number an operator approves has to be
 * one they looked at after the last change, not one the UI refreshed behind
 * them. So re-estimating is a button, and approving lives on the batch page,
 * one deliberate click further away.
 *
 * A scene that already has a provider request behind it is shown locked. Its
 * work has been done and, in a real run, paid for; rewriting its prompt would
 * orphan that and leave the bill.
 */
export function SceneEditor({
  batchId,
  onEstimated,
}: {
  batchId: string;
  onEstimated: (preflight: ImportPreflight) => void;
}) {
  const [videos, setVideos] = useState<
    { projectId: string; title: string; scenes: ImportedSceneRow[] }[]
  >([]);
  const [editing, setEditing] = useState<ImportedSceneRow | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  useEffect(() => {
    void importedScenes(batchId).then(setVideos);
  }, [batchId]);

  async function save() {
    if (!editing) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await updateImportedScene({
        sceneId: editing.sceneId,
        duration: Number(editing.duration),
        narration: editing.narration,
        dialogue: editing.dialogue,
        visualDescription: editing.visualDescription,
        characterAction: editing.characterAction,
        camera: editing.camera,
        subtitle: editing.subtitle,
        motionMode: editing.motionMode as "AUTO" | "LOCAL_MOTION" | "VIDEO_AI",
        videoProvider: editing.videoProvider,
        videoModel: editing.videoModel,
        priority: editing.priority as "LOW" | "NORMAL" | "HIGH",
      });
      setMessage({ tone: result.ok ? "ok" : "danger", text: result.message });
      if (result.ok) {
        setStale(true);
        setEditing(null);
        setVideos(await importedScenes(batchId));
      }
    } finally {
      setBusy(false);
    }
  }

  async function estimate() {
    setBusy(true);
    try {
      const result = await reestimateImportBatch(batchId);
      setMessage({ tone: result.ok ? "ok" : "danger", text: result.message });
      if (result.ok && result.preflight) {
        setStale(false);
        onEstimated(result.preflight);
      }
    } finally {
      setBusy(false);
    }
  }

  if (videos.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sửa cảnh trước khi duyệt</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {stale ? (
          <Alert tone="warn">
            Bạn vừa sửa cảnh nên <strong>bản dự toán cũ đã bị huỷ</strong>. Phải DỰ TOÁN LẠI
            trước khi duyệt — con số bạn ký phải là con số bạn vừa nhìn.
          </Alert>
        ) : null}
        {message ? (
          <Alert tone={message.tone === "ok" ? "ok" : "danger"}>{message.text}</Alert>
        ) : null}

        {videos.map((video) => (
          <div key={video.projectId} className="space-y-2">
            <div className="font-medium">{video.title}</div>
            <Table>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Giây</Th>
                  <Th>Chuyển động</Th>
                  <Th>Ưu tiên</Th>
                  <Th>Keyframe</Th>
                  <Th>Mô tả</Th>
                  <Th>{""}</Th>
                </tr>
              </thead>
              <tbody>
                {video.scenes.map((scene) => (
                  <tr key={scene.sceneId}>
                    <Td>{scene.sceneNumber}</Td>
                    <Td>{scene.duration}</Td>
                    <Td>{scene.motionMode}</Td>
                    <Td>{scene.priority}</Td>
                    <Td>
                      <Badge tone={scene.keyframe === "có sẵn" ? "ok" : "warn"}>
                        {scene.keyframe}
                      </Badge>
                    </Td>
                    <Td className="max-w-sm truncate text-xs">{scene.visualDescription}</Td>
                    <Td>
                      {scene.locked ? (
                        <Badge tone="neutral">đã chạy</Badge>
                      ) : (
                        <Button variant="ghost" onClick={() => setEditing(scene)}>
                          Sửa
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ))}

        {editing ? (
          <div className="space-y-3 rounded-md border border-border p-4">
            <div className="font-medium">Cảnh {editing.sceneNumber}</div>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Thời lượng (giây)">
                <Input
                  type="number"
                  step="0.5"
                  value={editing.duration}
                  onChange={(e) => setEditing({ ...editing, duration: Number(e.target.value) })}
                />
              </Field>
              <Field label="Chuyển động">
                <Select
                  value={editing.motionMode}
                  onChange={(e) => setEditing({ ...editing, motionMode: e.target.value })}
                >
                  <option value="AUTO">AUTO</option>
                  <option value="LOCAL_MOTION">LOCAL_MOTION</option>
                  <option value="VIDEO_AI">VIDEO_AI</option>
                </Select>
              </Field>
              <Field label="Ưu tiên chi">
                <Select
                  value={editing.priority}
                  onChange={(e) => setEditing({ ...editing, priority: e.target.value })}
                >
                  <option value="LOW">LOW</option>
                  <option value="NORMAL">NORMAL</option>
                  <option value="HIGH">HIGH</option>
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Mô tả hình ảnh">
                <Input
                  value={editing.visualDescription}
                  onChange={(e) => setEditing({ ...editing, visualDescription: e.target.value })}
                />
              </Field>
              <Field label="Hành động nhân vật">
                <Input
                  value={editing.characterAction}
                  onChange={(e) => setEditing({ ...editing, characterAction: e.target.value })}
                />
              </Field>
              <Field label="Camera">
                <Input
                  value={editing.camera}
                  onChange={(e) => setEditing({ ...editing, camera: e.target.value })}
                />
              </Field>
              <Field label="Phụ đề">
                <Input
                  value={editing.subtitle}
                  onChange={(e) => setEditing({ ...editing, subtitle: e.target.value })}
                />
              </Field>
              <Field label="Lời thoại">
                <Input
                  value={editing.dialogue}
                  onChange={(e) => setEditing({ ...editing, dialogue: e.target.value })}
                />
              </Field>
              <Field label="Lời dẫn">
                <Input
                  value={editing.narration}
                  onChange={(e) => setEditing({ ...editing, narration: e.target.value })}
                />
              </Field>
              <Field label="Ghim provider" hint="để trống = router tự chọn">
                <Input
                  value={editing.videoProvider ?? ""}
                  onChange={(e) => setEditing({ ...editing, videoProvider: e.target.value })}
                />
              </Field>
              <Field label="Ghim model">
                <Input
                  value={editing.videoModel ?? ""}
                  onChange={(e) => setEditing({ ...editing, videoModel: e.target.value })}
                />
              </Field>
            </div>
            <div className="rounded bg-muted p-2 text-xs">
              <strong>videoPrompt</strong> (tự dựng lại từ mô tả + hành động + camera sau khi
              lưu): {editing.videoPrompt || "(chưa có)"}
            </div>
            <div className="flex gap-2">
              <Button onClick={save} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                LƯU
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                Huỷ
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={estimate} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            DỰ TOÁN LẠI
          </Button>
          <span className="text-xs text-muted-foreground">
            Sửa cảnh và dự toán lại đều không gọi API nào.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
