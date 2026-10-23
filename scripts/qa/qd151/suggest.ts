/**
 * QĐ-151 AUTO CAMERA SUGGESTION - prototype (not used by the app).
 *
 * It does NOT replace the Camera Director (src/domain/camera-director.ts),
 * which already reads the scene (kind, references, style, continuity). It maps
 * the Director's decision onto V2's parameters and adds two place rules the
 * brief asks for. Same input -> same output; every result carries its reason.
 *
 *   npx tsx scripts/qa/qd151/suggest.ts     (runs the self-checks)
 */

import type { V2Easing, V2Intensity, V2Move } from "./motion-v2";

export interface SuggestInput {
  /** The Director's move / speed / preset (or what a person chose). */
  move: string;
  speed: "VERY_SLOW" | "SLOW" | "MEDIUM" | "FAST";
  preset?: string | null;
  /** A CRITICAL product / character / animal is in frame (Director's references). */
  critical?: "PRODUCT" | "CHARACTER" | "ANIMAL" | null;
  /** A person / face is the subject (Director kind DIALOGUE / REACTION / EMOTIONAL...). */
  person?: boolean;
  /** Scene text, to recognise the place (no vision API). */
  text?: string;
}

export interface Suggestion {
  move: V2Move;
  intensity: V2Intensity;
  easing: V2Easing;
  /** Future engine when it exists (QĐ-151 only prototypes LOCAL_MOTION_V2). */
  engine: "LOCAL_MOTION_V2" | "DEPTH_MOTION_CANDIDATE";
  reasons: string[];
}

const MOVE_MAP: Record<string, V2Move> = {
  SLOW_ZOOM_IN: "ZOOM_IN", SLOW_ZOOM_OUT: "ZOOM_OUT", PUSH_IN: "DOLLY_IN", DOLLY_IN: "DOLLY_IN",
  PULL_BACK: "DOLLY_OUT", DOLLY_OUT: "DOLLY_OUT", PAN_LEFT: "PAN_LEFT", PAN_RIGHT: "PAN_RIGHT",
  TRUCK_LEFT: "PAN_LEFT", TRUCK_RIGHT: "PAN_RIGHT", TRACK_LEFT: "PAN_LEFT", TRACK_RIGHT: "PAN_RIGHT",
  TILT_UP: "TILT_UP", PAN_UP: "TILT_UP", TILT_DOWN: "TILT_DOWN", PAN_DOWN: "TILT_DOWN",
  PARALLAX: "DIAGONAL", GIMBAL: "SUBTLE_CINEMATIC", HANDHELD_SOFT: "SUBTLE_CINEMATIC", STATIC: "SUBTLE_CINEMATIC", AUTO: "ZOOM_IN",
};
const SPEED_INTENSITY: Record<SuggestInput["speed"], V2Intensity> = { VERY_SLOW: "SUBTLE", SLOW: "NORMAL", MEDIUM: "NORMAL", FAST: "DYNAMIC" };
const PLACES: { re: RegExp; kind: "STREET" | "NATURE" | "KITCHEN" }[] = [
  { re: /\b(street|road|city|alley|traffic)\b|đường phố|phố|con đường|thành phố/i, kind: "STREET" },
  { re: /\b(forest|park|garden|mountain|lake|beach|nature|tree)\b|rừng|công viên|vườn|núi|hồ|biển|thiên nhiên/i, kind: "NATURE" },
  { re: /\b(kitchen|cook|table|counter)\b|bếp|nấu|bàn ăn/i, kind: "KITCHEN" },
];

export function suggestV2(input: SuggestInput): Suggestion {
  const reasons: string[] = [];
  let move = MOVE_MAP[input.move] ?? "ZOOM_IN";
  if (!MOVE_MAP[input.move]) reasons.push(`${input.move} không làm được trên ảnh tĩnh → ZOOM_IN`);
  let intensity = SPEED_INTENSITY[input.speed];
  let easing: V2Easing = "SMOOTHERSTEP";
  let engine: Suggestion["engine"] = "LOCAL_MOTION_V2";
  if (input.preset === "CINEMATIC") {
    intensity = "CINEMATIC";
    reasons.push("preset Điện ảnh → CINEMATIC (dừng mềm hơn)");
  }
  const place = PLACES.find((p) => p.re.test(input.text ?? ""))?.kind;
  if (place === "STREET" && !input.critical && (move === "ZOOM_IN" || move === "SUBTLE_CINEMATIC")) {
    move = "DOLLY_IN";
    reasons.push("đường phố → dolly tiến nhẹ");
  }
  if (place === "NATURE" && !input.critical && !input.person) {
    engine = "DEPTH_MOTION_CANDIDATE";
    reasons.push("thiên nhiên không có chủ thể bắt buộc → ứng viên Depth Motion (khi có)");
  }
  if (place === "KITCHEN" && move === "SUBTLE_CINEMATIC") {
    move = "ZOOM_IN";
    reasons.push("gian bếp → zoom chậm vào khu vực chính");
  }
  // Safety rules beat style: faces and critical subjects stay whole and steady.
  if (input.person || input.critical === "CHARACTER" || input.critical === "ANIMAL") {
    if (intensity === "DYNAMIC") intensity = "NORMAL";
    if (move === "DIAGONAL") move = "DOLLY_IN";
    reasons.push("có nhân vật → tối đa NORMAL, không chéo (giữ khuôn mặt ổn định, không cắt đầu/tay)");
  }
  if (input.critical === "PRODUCT") {
    intensity = intensity === "DYNAMIC" || intensity === "CINEMATIC" ? "NORMAL" : intensity;
    if (move === "DIAGONAL" || move === "PAN_LEFT" || move === "PAN_RIGHT") move = "ZOOM_IN";
    easing = "SMOOTHERSTEP";
    reasons.push("sản phẩm bắt buộc → zoom chậm, không lia (chữ/logo luôn rõ, không méo)");
  }
  if (reasons.length === 0) reasons.push("theo quyết định của Camera Director");
  return { move, intensity, easing, engine, reasons };
}

// ------------------------------------------------------------------ self-check ---
if (process.argv[1]?.endsWith("suggest.ts")) {
  const cases: [string, SuggestInput, Partial<Suggestion>][] = [
    ["sản phẩm bắt buộc, Director chọn PAN nhanh", { move: "PAN_RIGHT", speed: "FAST", critical: "PRODUCT", text: "giới thiệu bình giữ nhiệt" }, { move: "ZOOM_IN", intensity: "NORMAL" }],
    ["nhân vật, preset Hài nhanh FAST", { move: "PARALLAX", speed: "FAST", person: true }, { move: "DOLLY_IN", intensity: "NORMAL" }],
    ["đường phố, zoom chậm", { move: "SLOW_ZOOM_IN", speed: "SLOW", text: "Một buổi sáng trên đường phố Hà Nội" }, { move: "DOLLY_IN", engine: "LOCAL_MOTION_V2" }],
    ["rừng không có nhân vật", { move: "TILT_UP", speed: "VERY_SLOW", text: "Khu rừng mờ sương" }, { move: "TILT_UP", intensity: "SUBTLE", engine: "DEPTH_MOTION_CANDIDATE" }],
    ["công viên có nhân vật", { move: "PUSH_IN", speed: "SLOW", person: true, text: "hai người trong công viên" }, { engine: "LOCAL_MOTION_V2", intensity: "NORMAL" }],
    ["gian bếp, gimbal", { move: "GIMBAL", speed: "SLOW", text: "căn bếp buổi sáng" }, { move: "ZOOM_IN" }],
    ["điện ảnh", { move: "DOLLY_IN", speed: "SLOW", preset: "CINEMATIC" }, { intensity: "CINEMATIC" }],
    ["orbit (không làm được)", { move: "ORBIT", speed: "SLOW" }, { move: "ZOOM_IN" }],
  ];
  let fail = 0;
  for (const [name, input, want] of cases) {
    const got = suggestV2(input);
    const ok = Object.entries(want).every(([k, v]) => (got as unknown as Record<string, unknown>)[k] === v);
    if (!ok) fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${got.move} · ${got.intensity} · ${got.easing} · ${got.engine} — ${got.reasons.join("; ")}`);
  }
  console.log(fail ? `${fail} FAIL` : `${cases.length}/${cases.length} PASS`);
  process.exitCode = fail ? 1 : 0;
}
