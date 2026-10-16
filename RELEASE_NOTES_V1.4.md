# Batch Video Factory V1.4.0 — Uploaded Clips & Logo Overlay

**Ngày:** 2026-10-16 · **Tag:** `batch-video-factory-v1.4.0` · v1.0.0 → v1.3.0 không đổi

## Highlights

- Dùng clip video của chính bạn làm hình cho cảnh — REUSE, $0 chi phí Video AI.
- Logo thương hiệu (LOGO Reference) được đặt thật lên video thành phẩm, tại máy, $0.
- Video cắt thẳng không còn lặp khung hình đầu.
- "Lưu cảnh" và DỰ TOÁN LẠI an toàn hơn về định tuyến và giá.
- Không đồng API nào bị tiêu khi phát triển và kiểm thử V1.4: 0 POST trả phí.

## New features

- **Uploaded Video Clip Input (QĐ-132)** — tải clip .mp4 / .mov / .webm / .m4v làm hình của một cảnh.
  - Clip được REUSE thay cho Video AI: cảnh có clip không bao giờ tự mua Video AI thay thế.
  - Trim (điểm bắt đầu / kết thúc). Âm thanh gốc của clip mặc định TẮT; khi bật thì trộn dưới giọng thuyết minh và tự
    giảm khi có lời (ducking).
  - Clip ngắn hơn cảnh: giữ khung cuối / lặp / làm chậm; chế độ tự động giữ khung cuối tối đa 1 giây, dài hơn thì hỏi.
  - Khung hình COVER / CONTAIN theo tỉ lệ khung của project; clip 24–60 fps được chuẩn hoá về 30 fps.
- **Logo Reference → overlay trên video cuối (QĐ-134)** — chỉ dùng tham chiếu loại LOGO; 6 vị trí đặt sẵn (4 góc,
  giữa trên, giữa dưới); cỡ 8 / 12 / 18 % cạnh ngắn hoặc tuỳ chỉnh; độ mờ, lề, thời điểm hiện / ẩn. Khung 9:16 tránh vùng
  an toàn của nền tảng; nếu đè lên phụ đề thì cảnh báo và đề xuất vị trí khác. Mặc định TẮT — project cũ không đổi.

## Fixes

- **Frame timing / duplicate first frame (QĐ-133)** — bước encode cuối từng lặp khung đầu một lần sau mỗi cú cắt thẳng
  (+1 khung, có từ V1). Đã sửa: căn lại thời gian ở bước cuối (recipe r2).
- **Scene Save routing safety (QĐ-135)** — "Lưu cảnh" chỉ lưu ghim model khi người dùng thật sự chọn, không còn ghim
  model đang hiển thị; chế độ chuyển động tại máy (LOCAL_MOTION) thắng ghim cũ, kể cả với cảnh đã bị ghim sai trước đó.
- **Project re-estimate (QĐ-135)** — DỰ TOÁN LẠI cho lô dự án / lô nhập tính giá từ chính các cảnh của lô, không còn
  định giá nhầm theo một danh sách thành ngữ khác.
- **Reference Assignment Safety** — gán tham chiếu tự động chỉ thêm, không bao giờ bớt / thay danh sách người dùng đã
  chỉnh tay; hỏi xác nhận trước khi một thay đổi làm ảnh / clip đã mua (GENERATED) trở thành cũ.

## Test infrastructure

- `tests/asset-backfill.test.ts` chạy trên database riêng, không còn phụ thuộc dữ liệu của các file test chạy trước
  (trước đó bị hết giờ ở cuối full suite). Code production không đổi.

## Compatibility

- 1 migration mới `20261012000000_uploaded_video_clip`: chỉ thêm cột. Sao lưu `data/app.db` trước khi chạy
  `prisma migrate deploy`.
- Logo overlay lưu trong cấu hình output của project, không cần migration.
- Project và lô cũ render như V1.3, trừ việc không còn khung đầu bị lặp.

## Kiểm chứng

- Bộ test: **119/119 file · 1786/1786 test PASS** (một process, Mock Mode). Lint, typecheck, build, secret scan: PASS.
- Smoke test trên giao diện thật (dữ liệu nháp, mock) cho clip tải lên, logo, "Lưu cảnh" và DỰ TOÁN LẠI: ĐẠT.
- 0 POST trả phí trong toàn bộ V1.4.

## Known limitations

- **Clip tải lên hiện chủ yếu dùng làm toàn bộ hình của cảnh.** Dùng clip như một lớp trong Multi-Layer vẫn ở backlog.
- **Chưa có smart crop theo mặt / sản phẩm** — khung COVER / CONTAIN là cố định, chưa tracking.
- **Tương tác vật lý phức tạp** (cầm, rót, ôm, chạm) vẫn cần clip tải lên / clip gốc hoặc Video AI phù hợp đã kiểm chứng.
- **Ambient production cần loop asset chất lượng thật** — loop hiện có là hình minh hoạ tự sinh.
- **Một số model Video AI chưa đủ capability tham chiếu trực tiếp** để AUTO route an toàn; chỉ chạy khi người dùng chọn
  và xác nhận giá.
- **Chưa có trích nội dung từ URL** làm nguồn kịch bản.
- **Creative Style chưa có trong luồng lô thành ngữ (batch idiom)** — chỉ ở luồng TẠO VIDEO / project.
- Logo: chưa có kéo-thả vị trí tự do, SVG, logo động, xem trước realtime.
- Bộ test đầy đủ vẫn chậm (~2,6 giờ một process).
