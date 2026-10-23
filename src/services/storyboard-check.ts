import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";

/**
 * KIỂM TRA KỊCH BẢN (QĐ-152) - checks a storyboard before a render. Local,
 * read-only, $0.
 *
 *   ERROR    structure that would make a render fail or show the wrong thing
 *            (missing media / file, broken asset link, render pointing nowhere);
 *   WARNING  structure that is probably a mistake (an asset of another project
 *            not marked as reused, numbering, a deleted scene still live...);
 *   INFO     hints only. The CONTENT hint compares WORDS (subtitle / dialogue /
 *            title) - it does not look at pictures and never claims to. Ads,
 *            comedy and stories change subject on purpose: nothing is ever
 *            deleted because of it.
 */

export type CheckLevel = "ERROR" | "WARNING" | "INFO";
export interface CheckIssue {
  level: CheckLevel;
  code: string;
  sceneId?: string;
  sceneNumber?: number;
  message: string;
}

const STOP = new Set(
  "và là của có cho các một những này đó được với trong không thì mà để khi như từ ra vào đã sẽ bạn mình tôi chúng ta nó họ rất cũng lại nhé nha ạ à ơi gì sao nào đây kia thế vậy hơn nhất hay hoặc nhưng nếu vì bởi nên chỉ còn mới đang thật đi làm lên xuống the a an and or of to in on for is are be this that with it you we they your our".split(" "),
);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFC")
      .split(/[^\p{L}\p{N}&]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

export async function checkStoryboard(projectId: string): Promise<{ issues: CheckIssue[]; checkedScenes: number }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { scenes: { orderBy: { sceneNumber: "asc" }, include: { dialogueLines: true } }, idiom: { select: { phrase: true } } },
  });
  if (!project) return { issues: [{ level: "ERROR", code: "PROJECT_MISSING", message: "Không tìm thấy dự án." }], checkedScenes: 0 };
  const issues: CheckIssue[] = [];
  const add = (i: CheckIssue) => issues.push(i);
  const live = project.scenes.filter((s) => !s.deletedAt);
  const active = live.filter((s) => !s.skipped);

  // ---- structure -------------------------------------------------------
  project.scenes
    .filter((s) => s.deletedAt && !s.skipped)
    .forEach((s) => add({ level: "ERROR", code: "DELETED_BUT_ACTIVE", sceneId: s.id, message: `Một cảnh trong Thùng rác vẫn được tính vào video (thiếu cờ bỏ qua).` }));
  live.forEach((s, i) => {
    if (s.sceneNumber !== i + 1) add({ level: "WARNING", code: "NUMBERING", sceneId: s.id, sceneNumber: s.sceneNumber, message: `Thứ tự cảnh bất thường: cảnh ở vị trí ${i + 1} mang số ${s.sceneNumber}.` });
  });
  const assetIds = [...new Set(active.flatMap((s) => [s.imageAssetId, s.videoAssetId]).filter((x): x is string => Boolean(x)))];
  const assets = new Map((await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, projectId: true, filePath: true, deletedAt: true } })).map((a) => [a.id, a]));
  for (const s of active) {
    const n = s.sceneNumber;
    if (!s.imagePath && !s.videoPath) add({ level: "ERROR", code: "NO_MEDIA", sceneId: s.id, sceneNumber: n, message: `Cảnh ${n} chưa có ảnh hoặc video nguồn.` });
    for (const [label, p] of [["Ảnh", s.imagePath], ["Video", s.videoPath]] as const) {
      if (p && !fs.existsSync(toAbsolute(p))) add({ level: "ERROR", code: "FILE_MISSING", sceneId: s.id, sceneNumber: n, message: `Cảnh ${n}: ${label.toLowerCase()} nguồn không còn trên đĩa (${p}).` });
    }
    for (const [label, id] of [["ảnh", s.imageAssetId], ["video", s.videoAssetId]] as const) {
      if (!id) continue;
      const a = assets.get(id);
      if (!a) add({ level: "ERROR", code: "ASSET_INVALID", sceneId: s.id, sceneNumber: n, message: `Cảnh ${n}: asset ${label} không tồn tại (${id.slice(0, 8)}…).` });
      else if (a.projectId !== projectId) {
        const reused = s.imageSource === "IMPORTED" || s.videoSource === "IMPORTED" || s.imageSource === "REUSED";
        add({
          level: reused ? "INFO" : "WARNING",
          code: "ASSET_OTHER_PROJECT",
          sceneId: s.id,
          sceneNumber: n,
          message: reused
            ? `Cảnh ${n}: dùng lại ${label} của dự án khác (tái dùng hợp lệ, $0).`
            : `Cảnh ${n}: ${label} thuộc một dự án khác nhưng không được đánh dấu là tái dùng - kiểm tra có gắn nhầm không.`,
        });
      }
    }
    for (const l of s.dialogueLines) {
      if (l.status === "completed" && l.outputPath && !fs.existsSync(toAbsolute(l.outputPath))) {
        add({ level: "ERROR", code: "VOICE_FILE_MISSING", sceneId: s.id, sceneNumber: n, message: `Cảnh ${n}, câu ${l.lineNumber}: file giọng không còn trên đĩa.` });
      }
    }
    if ((s.dialogue.trim() || s.narration.trim()) && s.dialogueLines.length === 0 && !s.audioPath) {
      add({ level: "WARNING", code: "NO_VOICE_LINES", sceneId: s.id, sceneNumber: n, message: `Cảnh ${n} có lời thoại nhưng chưa có câu giọng nào - phụ đề/giọng của cảnh sẽ trống.` });
    }
  }
  if (project.finalVideoPath && !fs.existsSync(toAbsolute(project.finalVideoPath))) {
    add({ level: "ERROR", code: "FINAL_MISSING", message: `Video đã xuất được ghi nhận nhưng file không còn (${project.finalVideoPath}).` });
  }
  const jobs = await prisma.job.findMany({ where: { projectId, status: { in: ["queued", "processing"] }, sceneId: { not: null } }, select: { sceneId: true, type: true } });
  const liveIds = new Set(live.map((s) => s.id));
  jobs.filter((j) => j.sceneId && !liveIds.has(j.sceneId)).forEach((j) => add({ level: "ERROR", code: "JOB_ORPHAN", message: `Một việc ${j.type} đang chờ cho cảnh không còn trong storyboard.` }));
  const planned = active.reduce((n, s) => n + (s.finalDuration ?? s.duration), 0);
  if (project.targetDuration > 0 && active.length > 0 && Math.abs(planned - project.targetDuration) / project.targetDuration > 0.35) {
    add({ level: "INFO", code: "DURATION", message: `Tổng thời lượng cảnh ~${planned.toFixed(1)}s khác thời lượng mục tiêu ${project.targetDuration}s.` });
  }
  if (project.finalVideoPath && project.status !== "completed") {
    add({ level: "INFO", code: "STORYBOARD_CHANGED", message: "Storyboard/thiết lập đã thay đổi sau lần render gần nhất. Hãy render lại để cập nhật video." });
  }

  // ---- content (words only) --------------------------------------------
  if (active.length >= 3) {
    // Speaker labels ("Narrator: ...") are on every scene: they would make any scene look on-topic.
    const unlabel = (t: string) => t.replace(/(^|\n)\s*[^:\n]{1,30}:\s+/g, "$1");
    const sceneWords = active.map((s) => words(`${s.subtitle} ${unlabel(s.dialogue)} ${unlabel(s.narration)}`));
    const theme = words(`${project.title} ${project.idiom?.phrase ?? ""}`);
    active.forEach((s, i) => {
      const own = sceneWords[i]!;
      if (own.size < 4) return;
      const rest = new Set<string>([...theme]);
      sceneWords.forEach((w, j) => j !== i && w.forEach((x) => rest.add(x)));
      const shared = [...own].filter((w) => rest.has(w)).length;
      // No content word in common with the title or any other scene (or almost none in a long scene).
      // A ratio alone flagged on-topic scenes that share one key name ("Clark") among many words.
      if (shared === 0 || (own.size >= 25 && shared / own.size < 0.04)) {
        add({
          level: "INFO",
          code: "TOPIC_DRIFT",
          sceneId: s.id,
          sceneNumber: s.sceneNumber,
          message: `Cảnh ${s.sceneNumber} có nội dung chữ khác biệt đáng kể so với chủ đề chính (chỉ so sánh chữ, chưa xem hình). Có thể cố ý (quảng cáo, hài, chuyển cảnh) - hãy xem lại.`,
        });
      }
    });
  }
  const order: Record<CheckLevel, number> = { ERROR: 0, WARNING: 1, INFO: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level] || (a.sceneNumber ?? 0) - (b.sceneNumber ?? 0));
  return { issues, checkedScenes: active.length };
}
