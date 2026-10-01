# Batch Video Factory V1.2.0 — Daily Production Release

**Ngày:** 2026-10-01 · **Tag:** `batch-video-factory-v1.2.0` · v1.0.0 và v1.1.0 không đổi

Biến storyboard (thường kèm ảnh vẽ sẵn) thành nhiều video dọc 9:16 sẵn đăng, mỗi ngày, không cần dòng
lệnh. Ảnh có sẵn = $0 Image API; cảnh tĩnh chuyển động tại máy = $0; chỉ cảnh thật sự cần mới trả tiền
Video AI; không đồng nào ra khỏi máy nếu bạn chưa gõ số tiền và bấm DUYỆT & CHẠY.

Bắt đầu: [docs/QUICK_START.md](docs/QUICK_START.md) · Hướng dẫn đầy đủ:
[docs/HUONG_DAN_SU_DUNG.md](docs/HUONG_DAN_SU_DUNG.md) · Kiểm tra tay:
[docs/MANUAL_QA_V1.2.md](docs/MANUAL_QA_V1.2.md) · Ví dụ:
[examples/DAILY_WORKFLOW_EXAMPLE.md](examples/DAILY_WORKFLOW_EXAMPLE.md)

## Có gì

- **Import Storyboard** — JSON / CSV / ZIP / thư mục / nhiều thư mục, kéo thả hoặc gõ đường dẫn;
  KIỂM TRA báo lỗi và nhắc nhở theo từng video, từng cảnh; DỰ TOÁN & TẠO LÔ không chi đồng nào.
  Ảnh nhập là asset `IMPORTED`, không bao giờ bị tạo lại.
- **Batch nhiều video** — một lô, nhiều video, mỗi video một trạng thái; hàng đợi chạy video $0 →
  LOCAL → ảnh/giọng trả phí → Video AI.
- **LOCAL_MOTION + Video AI hybrid** — cảnh tĩnh chuyển động bằng FFmpeg tại máy ($0); `VIDEO_AI` chỉ
  cho cảnh cần; ghim model theo cảnh; router chỉ tự chọn `runway/h3_max:768x1280` cho cảnh LOW khi
  bạn đồng ý LOW_AUTO.
- **Character consistency** — ảnh tham chiếu + Character Bible 11 trường; nhân vật không có cả ảnh
  lẫn mô tả thì video đó bị chặn với lý do rõ (không mua "người lạ"), video khác vẫn chạy.
- **Voice-aware timing** — độ dài cảnh theo độ dài giọng thật (`AUTO` / `MINIMUM` / `LOCKED`); giọng
  không bao giờ bị cắt.
- **Hierarchical spend limits** — cảnh → video → lô → toàn cục; giữ chỗ tiền trước mỗi request; hai
  lô không thể cùng tiêu phần còn lại; mã lý do `SCENE_/VIDEO_/BATCH_/GLOBAL_LIMIT_EXCEEDED`.
- **Resume / recovery** — TIẾP TỤC / TIẾP TỤC TẤT CẢ chỉ làm phần còn thiếu; khởi động lại giữa chừng
  → INTERRUPTED, không tự gửi gì; model đã duyệt được giữ nguyên khi resume.
- **Asset reuse** — khoá theo nội dung + tham số; nhập lại cùng storyboard = 0 request
  ảnh/clip/giọng; đổi một thứ thì chỉ phần phụ thuộc bị làm lại.
- **Asset library** — `/assets`: tình trạng HEALTHY / MISSING / INVALID / LEGACY_UNVERIFIED /
  ORPHAN_CANDIDATE, ai đang dùng, chi phí gốc có đối chiếu sổ; `assets:health` (chỉ đọc),
  `assets:cleanup --dry-run`; không có nút xoá.
- **Daily-use workspace** — `/workspace`: HÔM NAY, hàng đợi, lịch sử + tìm kiếm; trang lô 8 bước,
  thẻ/bảng video, trạng thái tiếng Việt, PARTIAL / STRICT, CHẠY VIDEO $0 TRƯỚC, DUYỆT (THÊM) & CHẠY,
  chống bấm đúp.
- **Publish-ready output** — `data/output/<lô>/<video>/`: `final.mp4`, `thumbnail.jpg`,
  `subtitles.srt` (khi có lời), `metadata.json`, `storyboard.json`, `captions.txt`,
  `description.txt`; preset Shorts / TikTok / Reels / ngang / tuỳ chỉnh (đổi preset = render lại tại
  máy, $0); thumbnail chọn cảnh hoặc tải lên; cảnh báo vùng an toàn; READY TO PUBLISH;
  `batch-report.csv/json`.
- **Cost safeguards** — `AI_MOCK_MODE` là công tắc an toàn; hạn mức toàn cục chỉ người dùng đổi;
  không nút nào tự tiêu tiền; QA trả phí mặc định tắt; idempotency key chống POST trùng; sổ chi phí
  thật theo hoá đơn, mock và ước tính tách riêng.

## Kiểm chứng

- Final QA (QĐ-115): luồng UI đầy đủ trên bản sao dữ liệu (mock) — nhập 6 video / 31 cảnh, dự toán,
  chạy $0, duyệt thêm, STRICT, tắt app giữa lúc render rồi khôi phục, TIẾP TỤC TẤT CẢ, output.
- Bộ test: **83/83 file · 1441/1441 test**, một process. Lint, typecheck, build, quét secret: PASS.
- 100 video / 500 cảnh: dự toán ~6 s, dựng trang lô ~2 s.
- **Phát hành V1.2 không tốn đồng API nào**: 0 POST trả phí, sổ chi production không đổi
  ($8,413060 / hạn mức $8,50).

## Giới hạn đã biết

- **P2** — Khi lô đang chạy và trang lô mở, SQLite đôi khi báo `Socket timeout` (~1 lần mỗi lượt sau
  bản sửa của Final QA). Lô vẫn chạy xong; video lỗi bấm TIẾP TỤC. Nếu gặp thường xuyên: thêm
  `?socket_timeout=60` vào `DATABASE_URL` trong `.env` (tuỳ chọn, người dùng tự sửa). Chuyển SQLite
  sang WAL chưa làm — cần quyết định riêng (sao lưu phải chép cả file `-wal`).
- **P3** — Trang Tổng quan `/` bị tràn ngang trên màn hình hẹp (~390 px).
- **P3** — "dùng lại tiết kiệm" trên thẻ video (tính cả ảnh nhập) khác "Giá trị dùng lại" ở tổng kết
  lô (chỉ asset REUSED).
- **P3** — Trang `/queue` (cũ) hiện APPROVED cho video chưa được duyệt thêm và COMPLETED cho video có
  giọng hỏng; trang làm việc `/workspace` hiện đúng.
- **P3** — Trang chi tiết asset hiện kích thước đã ghi lúc tạo, không phải kích thước thật trên đĩa
  của file INVALID.
- Kéo thả thư mục / ZIP, chọn nhiều JSON, COPY PATH và bấm chuột thật chưa được kiểm bằng trình duyệt
  tự động — xem [docs/MANUAL_QA_V1.2.md](docs/MANUAL_QA_V1.2.md).
- Clip Video AI chưa chạy qua UI trong Final QA (hạn mức còn $0,086940 < một clip); đường đó có test
  tự động với provider mock.
- Dữ liệu production: 2 file giọng INVALID (78 byte) của video "Break the ice (5 ảnh nhập sẵn)" cần tạo
  lại giọng (trả phí) — chưa làm; 101 file tạm (68,9 MB) có thể dọn bằng `assets:cleanup --apply` khi
  bạn đồng ý.
- Không làm: intro/outro, watermark, AI viết metadata, tự đăng lên YouTube/TikTok, huỷ một request
  Video AI đã gửi (nhà cung cấp không hỗ trợ).
- OpenAI không có API đọc số dư miễn phí — app dùng số khai báo.
