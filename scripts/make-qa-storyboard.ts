import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "@/media/ffmpeg";

/**
 * Build examples/storyboard-qa-distinct: five 1080x1920 keyframes that cannot
 * be mistaken for one another - a different background colour per scene and a
 * large "SCENE n" - so scene order can be checked by eye and by pixel colour
 * in the final MP4. Local FFmpeg only; no Image API, $0.
 *
 *   npx tsx scripts/make-qa-storyboard.ts
 *
 * Scene durations are deliberately uneven so a check that assumes a fixed
 * scene length fails.
 */

export const QA_SCENES = [
  { n: 1, bg: "0xD32F2F", fg: "white", colour: "red", duration: 4 },
  { n: 2, bg: "0x1565C0", fg: "white", colour: "blue", duration: 5 },
  { n: 3, bg: "0xFBC02D", fg: "black", colour: "yellow", duration: 3 },
  { n: 4, bg: "0x6A1B9A", fg: "white", colour: "purple", duration: 4 },
  { n: 5, bg: "0x000000", fg: "white", colour: "black", duration: 4 },
] as const;

const FONT = process.env.QA_FONT ?? "C:/Windows/Fonts/arialbd.ttf";
const OUT = path.join(process.cwd(), "examples", "storyboard-qa-distinct", "video-001");

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  // drawtext wants the drive colon escaped.
  const font = FONT.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\:");
  for (const s of QA_SCENES) {
    await ffmpeg([
      "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${s.bg}:s=1080x1920`,
      "-vf", `drawtext=fontfile='${font}':text='SCENE ${s.n}':fontsize=200:fontcolor=${s.fg}:x=(w-tw)/2:y=(h-th)/2`,
      "-frames:v", "1", path.join(OUT, `scene-0${s.n}.png`),
    ]);
  }
  const storyboard = {
    video_id: "qa-distinct-5",
    video_title: "QA thứ tự cảnh (5 ảnh khác nhau)",
    characters: [{ character_id: "max", character_name: "Max" }],
    scenes: QA_SCENES.map((s) => ({
      scene_number: s.n,
      duration: s.duration,
      visual_description: `A flat ${s.colour} card with the words SCENE ${s.n} in large letters.`,
      character_action: "Nothing moves.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: `Max: "Scene ${s.n}."`,
      subtitle: `Scene ${s.n}.`,
      image_file: `scene-0${s.n}.png`,
      motion_mode: "LOCAL_MOTION",
      priority: "LOW",
    })),
  };
  fs.writeFileSync(path.join(OUT, "storyboard.json"), JSON.stringify(storyboard, null, 2) + "\n");
  console.log(`Đã tạo ${QA_SCENES.length} ảnh + storyboard.json trong ${OUT}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/make-qa-storyboard.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
