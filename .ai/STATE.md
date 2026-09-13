# Trạng thái dự án

**Cập nhật:** 2026-09-13
**Cột mốc hiện tại:** Milestone 1 — **HOÀN TẤT VÀ ĐÃ KIỂM CHỨNG**

Tài liệu này ghi tình trạng **thực tế**. Tính năng chỉ được đánh dấu hoạt động
khi đã chạy thật và được kiểm chứng, không phải khi đã viết xong mã.

---

## Tình trạng build

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Lint | `npm run lint` | ✅ 0 lỗi |
| Kiểu dữ liệu | `npm run typecheck` | ✅ 0 lỗi (TS strict, không dùng `any`) |
| Kiểm thử | `npm run test` | ✅ 177 test / 6 tệp, tất cả đạt |
| Build production | `npm run build` | ✅ 16 route biên dịch thành công |
| Chạy thật | `npm start` | ✅ Đã kiểm tra thủ công trên Windows 11 |

Môi trường đã kiểm chứng: Windows 11 Pro 26200, Node v24.14.1,
FFmpeg 6.1.1 (bản đi kèm ffmpeg-static, có libass + libx264).

---

## Đã hoàn thành và kiểm chứng

### Nền tảng
- [x] Next.js 15 + React 19 + TypeScript strict
- [x] Tailwind CSS v4, giao diện dark, các thành phần kiểu shadcn tự viết
- [x] SQLite + Prisma, `data/app.db`
- [x] Lược đồ viết sẵn để chuyển sang PostgreSQL (không enum, không Json, không blob)
- [x] Chạy được trên Windows, không cần Docker, không cần WSL
- [x] Đường dẫn có dấu cách (`F:\Tool Video Youtube`) hoạt động bình thường

### Nội dung
- [x] Thư viện thành ngữ: **137 thành ngữ** đã nạp (yêu cầu tối thiểu 100)
- [x] Thêm / sửa / xoá / tìm / lọc
- [x] Nhập hàng loạt CSV và JSON, có chống trùng lặp
- [x] Thành ngữ có nghĩa đen bạo lực đã được viết lại thành gag hoạt hình vô hại
- [x] 2 nhân vật (Max, Leo) với bản mô tả ngoại hình cố định
- [x] 6 phong cách hình ảnh, mặc định 3D Cartoon
- [x] 16 mô hình trong bảng đăng ký, 6 chỗ nhà cung cấp

### AI Router
- [x] Định tuyến **theo từng cảnh** — đã kiểm chứng: 3 tầng mô hình khác nhau
      trong cùng một video
- [x] Bốn chế độ: Tiết kiệm, Cân bằng (mặc định), Chất lượng cao, Tự chọn
- [x] Năm chiến lược: AUTO, CHEAPEST, BEST_VALUE, BEST_QUALITY, MANUAL
- [x] Ngưỡng chất lượng theo độ phức tạp và ưu tiên chi tiêu
- [x] Phân loại độ phức tạp LOW / MEDIUM / HIGH từ nội dung cảnh
- [x] Ưu tiên chi tiêu: 3 giây đầu và punchline được ưu tiên
- [x] Lọc theo năng lực (thời lượng, image-to-video, tham chiếu nhân vật, 1080p)
- [x] Hạ cấp mô hình khi chạm trần ngân sách
- [x] Chuỗi dự phòng theo thứ tự ưu tiên
- [x] Ghim mô hình thủ công cho từng cảnh

### Kiểm soát chi phí
- [x] Giá nằm hoàn toàn trong `ModelRegistry`, không viết cứng ở đâu
- [x] Ước tính hiển thị cả ba chế độ cạnh nhau, chia theo giai đoạn
- [x] Phần dự phòng tạo lại được cộng vào ước tính
- [x] NGÂN SÁCH TỐI ĐA chặn cứng — đã kiểm chứng là không job nào được đưa vào
      hàng đợi và không khoản chi phí nào được ghi khi vượt ngân sách
- [x] Tối ưu ngân sách theo lô (không chọn mô hình rẻ nhất cho tất cả)
- [x] Sổ chi phí, tổng được tính lại từ các dòng
- [x] Bảng chi phí theo Hôm nay / Tuần / Tháng / Toàn bộ
- [x] Chống tính phí hai lần qua khoá idempotency và bảng `ProviderJob`

### Quy trình
- [x] Sinh kịch bản (mock), trả JSON đúng lược đồ Zod
- [x] Sửa JSON hỏng: bỏ code fence, bỏ lời dẫn, bỏ dấu phẩy thừa, chuẩn hoá nháy
- [x] Chấm điểm kịch bản, viết lại **một lần** khi trục quan trọng dưới 7
- [x] Chống trùng ý tưởng qua `ConceptHistory` — đã kiểm chứng: dự án thứ hai
      trên cùng thành ngữ chọn góc hài khác
- [x] Storyboard 3 khung: danh sách cảnh / xem trước / cài đặt cảnh
- [x] Sửa mọi trường của cảnh, duyệt cảnh, bỏ qua cảnh
- [x] Tạo lại riêng ảnh / video / giọng đọc cho từng cảnh
- [x] Tạo ảnh keyframe (mock) — PNG thật
- [x] Tạo video từng cảnh (mock) — MP4 H.264 thật
- [x] Tạo giọng đọc (mock) — WAV 16-bit thật
- [x] Chấm điểm chất lượng và tạo lại khi dưới ngưỡng
- [x] Phụ đề SRT + ASS, chữ lớn, tô màu cụm thành ngữ
- [x] Ghép và render bằng FFmpeg — **đã kiểm chứng: MP4 1080x1920, H.264,
      30fps, 25.1 giây, 2.35 MB, phụ đề đã ghi lên hình**
- [x] Cảnh bị bỏ qua không xuất hiện trong bản render

### Hàng đợi
- [x] Hàng đợi trên SQLite, không cần Redis
- [x] Giành job bằng UPDATE có điều kiện (không job nào bị xử lý hai lần)
- [x] Số job song song cấu hình được, mặc định 2
- [x] Thử lại tối đa 3 lần, giãn cách 10s / 30s / 90s
- [x] Tự đưa job dở về hàng đợi sau khi khởi động lại
- [x] Job render tự hoãn khi chờ cảnh, và báo lỗi ngay nếu cảnh đã hỏng

### Tạo hàng loạt
- [x] Tạo lô với số lượng, bộ lọc, chế độ, ngân sách, số job song song
- [x] Phím tắt số lượng 5 / 10 / 20 / 50 / tuỳ chọn
- [x] Ngân sách lô chia đều cho từng dự án
- [x] Mở rộng lô chạy trong hàng đợi, không chặn request

### Vận hành
- [x] Chế độ mock là cổng chặn cứng ở tầng registry
- [x] Phát hiện trực tuyến / ngoại tuyến, thông báo tiếng Việt đúng như đặc tả
- [x] Mọi tính năng cục bộ chạy được khi mất mạng
- [x] Trạng thái nhà cung cấp suy ra từ cấu hình, không ping liên tục
- [x] API key mã hoá AES-256-GCM, giao diện chỉ thấy mặt nạ `****F92A`
- [x] Nhật ký có cấu trúc, che khoá bí mật trước khi ghi
- [x] Mọi đường dẫn qua `lib/paths.ts`, chống thoát thư mục
- [x] Mẫu prompt trong `prompts/*.txt`, sửa được, có thể ghi đè từ cơ sở dữ liệu
- [x] Dọn dẹp media với `--dry-run`; video hoàn chỉnh không bao giờ tự xoá
- [x] Sao lưu bằng `npm run backup`, kèm tệp hướng dẫn khôi phục
- [x] `npm run doctor` kiểm tra môi trường

---

## Chưa làm

### Milestone 2 — nhà cung cấp thật (chưa bắt đầu)
- [ ] Text AI thật
- [ ] Image AI thật
- [ ] Video AI thật (Runway)
- [ ] Voice AI thật (ElevenLabs / OpenAI)

**Chưa có nhà cung cấp trả phí nào được nối hay kiểm thử.** Chọn một trong số đó
sẽ ném lỗi rõ ràng thay vì âm thầm chạy mock.

### Milestone 3
- [ ] Nhiều nhà cung cấp video, định tuyến thật giữa chúng
- [ ] Theo dõi tỉ lệ thành công thực tế của từng mô hình theo thời gian

### Milestone 4
- [ ] Nhất quán nhân vật nâng cao (ảnh tham chiếu, khoá seed)
- [ ] Hiệu ứng phụ đề động
- [ ] Thư viện SFX và nhạc nền
- [ ] Nâng phân giải (interface đã có, chưa có bản hiện thực thật)
- [ ] Tải lên YouTube tự động, lên lịch, phân tích hiệu quả

### Tính năng phụ chưa có giao diện
- [ ] Sinh metadata YouTube đã có ở tầng provider nhưng **chưa có nút trong giao
      diện** và chưa được lưu vào dự án
- [ ] Chỉnh sửa mẫu prompt từ trang quản trị (tầng dữ liệu đã xong, giao diện
      chưa có)
- [ ] Ảnh tham chiếu nhân vật: cột đã có trong cơ sở dữ liệu, chưa có chỗ tải lên
- [ ] Nhạc nền: hàm render đã hỗ trợ, chưa có chỗ chọn tệp trong giao diện

---

## Lỗi đã biết

Không có lỗi nào đang mở.

Các vấn đề đã phát hiện trong quá trình làm và **đã sửa**:

| Vấn đề | Cách sửa |
|---|---|
| `slugify` làm mất chữ "đ" tiếng Việt | NFD không tách "đ"; thêm ánh xạ riêng |
| Bộ che khoá bí mật bỏ sót khoá nhiều đoạn | Cho phép `-` và `_` trong thân khoá |
| Chiến lược CHEAPEST vẫn bị ngưỡng chất lượng ép lên mô hình đắt | Ngưỡng chỉ áp dụng khi strategy = AUTO |
| Kế hoạch có cảnh không định tuyến được vẫn báo "trong ngân sách" | `withinBudget` yêu cầu không còn lỗi định tuyến |
| Chi phí chấm điểm chất lượng ghi theo ước tính, lệch với các giai đoạn khác | Ghi theo chi phí nhà cung cấp báo về |
| Thanh trạng thái luôn báo "worker đang tắt" | Trạng thái worker chuyển sang `globalThis` (Next tách bundle instrumentation) |
| `window.confirm` chặn toàn bộ renderer | Thay bằng xác nhận nội tuyến, hiển thị được cả ngân sách |
| `zoompan` ở 1080x1920 chậm đến mức chiếm hết thời gian chạy mock | Đổi sang scale + crop di động |
| Thẻ hình mock tràn ra ngoài khung | Tự co chữ cho vừa, neo khối chú thích từ đáy |
| Dọn thư mục test trong `setupFiles` gây EPERM trên Windows | Chuyển sang `globalSetup`, chạy một lần |

---

## Tình trạng lược đồ

Ổn định. 15 bảng. Đã đồng bộ với cơ sở dữ liệu qua `prisma db push`.

Chưa tạo tệp migration — đang dùng `db push` cho giai đoạn phát triển. Trước khi
phát hành cho người khác dùng, nên chuyển sang `prisma migrate`.

---

## Việc nên làm tiếp theo

Xem [NEXT_TASKS.md](NEXT_TASKS.md).

Việc được khuyến nghị: **nối một nhà cung cấp Text AI thật** (xem
[../docs/PROVIDERS.md](../docs/PROVIDERS.md)). Đây là nhà cung cấp rẻ nhất và ít
rủi ro nhất để kiểm chứng toàn bộ đường đi của tầng provider thật.
