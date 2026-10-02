/**
 * Technical reason -> a sentence a person can act on (V1.2 Phase 6, QĐ-114).
 *
 * The engine writes messages that start with a reason code ("VIDEO_LIMIT_EXCEEDED:
 * ...", "BLOCKED: ...", "render: ..."). The daily screens show the Vietnamese
 * headline and what to do; the original text stays available as `detail` in an
 * expandable section - never thrown away, because it is what a bug report needs.
 */

export interface FriendlyError {
  code: string;
  title: string;
  /** What the person can do next. */
  action: string;
  /** Whether fixing it can cost money. */
  mayCost: boolean;
  /** The original, technical text. */
  detail: string;
}

const CATALOG: Record<string, { title: string; action: string; mayCost?: boolean }> = {
  VIDEO_LIMIT_EXCEEDED: { title: "Ngân sách video hiện không đủ", action: "Bấm \"Tăng ngân sách video\" ở trang dự án, hoặc sửa cảnh cho rẻ hơn." },
  VIDEO_BUDGET_UNSET: { title: "Video chưa có ngân sách", action: "Đặt \"Ngân sách video\" ở trang dự án trước khi tạo nội dung trả phí." },
  BATCH_LIMIT_EXCEEDED: { title: "Vượt giới hạn chi phí của lô", action: "Duyệt lô với trần cao hơn, hoặc chạy trước các video vừa ngân sách." },
  GLOBAL_LIMIT_EXCEEDED: { title: "Vượt hạn mức chi toàn ứng dụng", action: "Chạy các video $0 trước, hoặc tự tăng hạn mức trong Cài đặt." },
  SCENE_LIMIT_EXCEEDED: { title: "Một cảnh vượt giới hạn chi phí cảnh", action: "Sửa cảnh (vd. chuyển sang LOCAL_MOTION) hoặc tăng trần cảnh." },
  PROVIDER_NOT_CONFIRMED: { title: "Nhà cung cấp chưa được xác nhận giá", action: "Xem giá và xác nhận nhà cung cấp ở bước duyệt." },
  MODEL_NOT_CONFIRMED: { title: "Model chưa được xác nhận giá", action: "Xem giá và xác nhận model ở bước duyệt." },
  PAID_ASSET_REQUIRES_APPROVAL: { title: "Cần duyệt chi trước khi tạo", action: "Bấm KIỂM TRA & DỰ TOÁN rồi duyệt.", mayCost: true },
  PAID_ASSET_NEEDS_RECOVERY: { title: "Cần kiểm tra trạng thái yêu cầu trước đó", action: "Bấm KIỂM TRA ở video — không gửi lại tự động." },
  NEEDS_RECOVERY: { title: "Cần kiểm tra trạng thái yêu cầu trước đó", action: "Bấm KIỂM TRA ở video — không gửi lại tự động." },
  NOT_RUNNABLE: { title: "Video chưa chạy được", action: "Xem chi tiết bên dưới." },
  MISSING_LOCAL_FILE: { title: "Thiếu file nguồn", action: "Đặt lại file ảnh/clip vào đúng chỗ rồi KIỂM TRA LẠI." },
  INVALID_VOICE_ASSET: { title: "Cần tạo lại giọng — có thể phát sinh chi phí", action: "File giọng bị hỏng. Tạo lại giọng là việc trả phí, cần bạn duyệt riêng.", mayCost: true },
  APPROVED_MODEL_UNAVAILABLE: { title: "Model đã duyệt hiện không khả dụng", action: "LẬP LẠI KẾ HOẠCH MODEL rồi duyệt lại — không tự đổi model." },
  APPROVED_MODEL_CHANGED: { title: "Model đã đổi so với lúc duyệt", action: "Chạy lại KIỂM TRA & DỰ TOÁN rồi duyệt lại." },
  APPROVED_MODEL_PARAMS_CHANGED: { title: "Thông số model đã đổi so với lúc duyệt", action: "Chạy lại KIỂM TRA & DỰ TOÁN rồi duyệt lại." },
  APPROVED_MODEL_COST_CHANGED: { title: "Giá model đã đổi so với lúc duyệt", action: "Chạy lại KIỂM TRA & DỰ TOÁN rồi duyệt lại." },
  APPROVED_MODEL_MISSING: { title: "Không còn thấy model đã duyệt", action: "LẬP LẠI KẾ HOẠCH MODEL rồi duyệt lại." },
  PLAN_CHANGED: { title: "Kế hoạch đã đổi từ lúc bạn xem", action: "Xem lại chi phí rồi xác nhận lần nữa." },
  ALREADY_RUNNING: { title: "Video đang chạy", action: "Chờ lần chạy hiện tại xong — không mở lần chạy thứ hai." },
  INTERRUPTED: { title: "Bị gián đoạn (ứng dụng khởi động lại)", action: "Bấm TIẾP TỤC — phần đã có được dùng lại, không tự gửi yêu cầu trả phí." },
  STRICT_MODE_BLOCKED: { title: "Chế độ STRICT: lô có video bị chặn", action: "Sửa video bị chặn, hoặc đổi lô sang PARTIAL." },
  CANCELLED: { title: "Đã dừng theo yêu cầu", action: "Bấm TIẾP TỤC khi muốn chạy tiếp." },
  RENDER_FAILED: { title: "Render tại máy thất bại", action: "Bấm TIẾP TỤC để render lại ($0). Nếu lặp lại, xem chi tiết." },
  NEEDS_CHARACTER_REFERENCE: { title: "Nhân vật chưa có ảnh tham chiếu / mô tả", action: "Thêm ảnh tham chiếu hoặc mô tả nhân vật." },
  OVER_VIDEO_BUDGET: { title: "Ngân sách video hiện không đủ", action: "Bấm \"Tăng ngân sách video\" ở trang dự án, hoặc sửa cảnh cho rẻ hơn." },
  OVER_SCENE_BUDGET: { title: "Một cảnh vượt giới hạn chi phí cảnh", action: "Sửa cảnh hoặc tăng trần cảnh." },
  NEEDS_PROVIDER_CONFIRMATION: { title: "Nhà cung cấp chưa được xác nhận giá", action: "Xác nhận nhà cung cấp ở bước duyệt." },
  NEEDS_EXPLICIT_PIN: { title: "Cảnh cần chọn model video", action: "Ghim model cho cảnh trong trình sửa cảnh." },
  VIDEO_MODEL_NEEDS_SELECTION: {
    title: "Cảnh cần chọn model Video AI",
    action: "Mở Storyboard: chọn model video (xem giá rồi xác nhận), dùng LOCAL MOTION ($0) hoặc bỏ qua Video AI.",
  },
};

const CODE_AT_START = /^\s*(?:BLOCKED:\s*)?([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b\s*:?/;

/** Map an engine message to what a person reads. Unknown text is kept, not guessed. */
export function friendlyError(message: string | null | undefined): FriendlyError | null {
  if (!message || message.trim().length === 0) return null;
  const detail = message.trim();
  const match = CODE_AT_START.exec(detail);
  let code = match?.[1] ?? "";
  if (!code) {
    // Codes that appear inside the sentence rather than at its start.
    for (const known of Object.keys(CATALOG)) {
      if (detail.includes(known)) {
        code = known;
        break;
      }
    }
  }
  if (!code && /^render:/i.test(detail)) code = "RENDER_FAILED";
  // Executor headroom sentences (QĐ-119): "video đã chi $X > trần $Y", "lô đã chi ...".
  if (!code && /video đã chi \$?[0-9.]+ > trần/.test(detail)) code = "VIDEO_LIMIT_EXCEEDED";
  if (!code && /lô đã chi \$?[0-9.]+ > trần/.test(detail)) code = "BATCH_LIMIT_EXCEEDED";
  if (!code && /hạn mức toàn cục đã hết/.test(detail)) code = "GLOBAL_LIMIT_EXCEEDED";
  if (!code && /Không thấy|không tồn tại|missing/i.test(detail) && /file|ảnh|clip/i.test(detail)) code = "MISSING_LOCAL_FILE";
  const entry = CATALOG[code];
  if (!entry) {
    return { code: code || "UNKNOWN", title: detail.replace(/^BLOCKED:\s*/, "").slice(0, 140), action: "Xem chi tiết kỹ thuật.", mayCost: false, detail };
  }
  return { code, title: entry.title, action: entry.action, mayCost: entry.mayCost === true, detail };
}
