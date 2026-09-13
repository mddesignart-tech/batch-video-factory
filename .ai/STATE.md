# Trạng thái dự án

**Cập nhật:** 2026-09-13
**Cột mốc hiện tại:** Milestone 2 — **Bước 1 (Text AI thật): CODE XONG, CHƯA CHẠY THẬT**

Tài liệu này ghi tình trạng **thực tế**. Tính năng chỉ được đánh dấu hoạt động
khi đã chạy thật và được kiểm chứng, không phải khi đã viết xong mã.

---

## Tình trạng build

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Lint | `npm run lint` | ✅ 0 lỗi |
| Kiểu dữ liệu | `npm run typecheck` | ✅ 0 lỗi (TS strict, không dùng `any`) |
| Kiểm thử | `npm run test` | ✅ **219 test / 8 tệp, tất cả đạt** |
| Build production | `npm run build` | ✅ 16 route biên dịch thành công |
| Chạy thật | `npm start` | ✅ Đã kiểm tra thủ công trên Windows 11 |

Môi trường đã kiểm chứng: Windows 11 Pro 26200, Node v24.14.1,
FFmpeg 6.1.1 (bản đi kèm ffmpeg-static, có libass + libx264).

---

## ⚠️ ĐIỀU QUAN TRỌNG NHẤT

**Chưa có một đồng nào được chi cho API AI.** Tổng chi phí API thật: **$0.00**.

Text AI thật đã được **viết xong và kiểm thử bằng máy chủ giả lập**, nhưng
**chưa từng gọi một nhà cung cấp thật nào**, vì chưa có API key nào được cấu
hình. Xem mục "Chưa làm".

---

## Milestone 1 — hoàn tất và đã kiểm chứng

Toàn bộ quy trình chạy được ở chế độ mock, xuất ra MP4 1080x1920 thật.

- [x] Next.js 15 + React 19 + TypeScript strict, chạy trên Windows, không Docker
- [x] SQLite + Prisma, lược đồ sẵn sàng chuyển sang PostgreSQL
- [x] 137 thành ngữ, 2 nhân vật, 6 phong cách, 21 model, 9 nhà cung cấp
- [x] Giao diện tiếng Việt 12 trang
- [x] AI Router định tuyến **theo từng cảnh**, 4 chế độ, 5 chiến lược
- [x] Ước tính chi phí 3 chế độ, NGÂN SÁCH TỐI ĐA chặn cứng
- [x] Tối ưu ngân sách theo lô
- [x] Job Queue trên SQLite, thử lại 10s/30s/90s
- [x] Chống tính phí hai lần bằng khoá idempotency
- [x] Storyboard 3 khung, sửa/duyệt/bỏ qua cảnh
- [x] Phụ đề SRT + ASS, ghi lên hình
- [x] FFmpeg render — **đã kiểm chứng: MP4 1080x1920, H.264, 30fps, 25.1 giây**
- [x] Chế độ ngoại tuyến, dọn dẹp, sao lưu, doctor

Chi tiết đầy đủ xem lịch sử Git (commit `docs: add README, docs/ and .ai state tracking`).

---

## Milestone 2 bước 1 — Text AI thật

### Đã viết xong

- [x] `OpenAICompatibleTextProvider` — nói chuẩn Chat Completions, nên một lớp
      dùng được cho OpenAI, DeepSeek, Groq, OpenRouter, Together, Google
      (endpoint tương thích), và Ollama / LM Studio chạy cục bộ
- [x] Cắm vào `registry.ts` — điểm cắm duy nhất, Mock Mode vẫn là cổng chặn cứng
- [x] **Xoá hard-code provider khỏi business logic**: `project-service.ts` từng
      ghim cứng `"mock"/"mock-text-1"`, giờ chọn qua AI Router từ `ModelRegistry`
- [x] `ModelRegistry.priceOutput` — text API tính giá input/output khác nhau
- [x] `ProviderJob.inputTokens / outputTokens / durationMs`
- [x] **Hạn mức chi tiêu cứng** (`spend-guard.ts`): mặc định **$0.50**, kiểm tra
      trước MỌI request trả phí, cộng dồn toàn ứng dụng
- [x] **Cổng xác nhận** theo từng cặp provider/model: hiển thị provider, model,
      giá input, giá output, ước tính/kịch bản, đã chi, hạn mức, còn lại — rồi
      mới cho bấm xác nhận
- [x] Từ chối bật model chưa nhập giá (trừ model chạy cục bộ, vốn thật sự free)
- [x] Phân loại lỗi: 401/403/400/404/402 **không** thử lại; 429/5xx có thử lại,
      tôn trọng header `Retry-After`; tối đa 3 lần, không lặp vô hạn
- [x] Ghi nhận mỗi request: provider, model, token vào/ra, ước tính, chi phí
      thật, thời gian, trạng thái, lỗi
- [x] API key chỉ nằm trong header `Authorization`, không vào log/body/URL
- [x] Sửa JSON hỏng dùng lại `parseScript` + `repairJson` của Milestone 1
- [x] `npm run compare:text` — so sánh Mock vs Real trên cùng một thành ngữ

### Đã kiểm chứng bằng cách nào

**Máy chủ giả lập OpenAI API chạy cục bộ trong test** (`tests/text-provider.test.ts`,
34 test). Nó kiểm chứng toàn bộ đường đi HTTP với chi phí **$0.00**:

- gửi đúng dạng request, đọc đúng token
- API key nằm trong header, không lọt vào body
- 429 → thử lại rồi thành công
- 401 → **chỉ gọi 1 lần**, không thử lại
- 500 liên tục → dừng đúng sau 3 lần
- phản hồi bị cắt (`finish_reason: length`) → báo lỗi rõ
- phản hồi rỗng → báo lỗi
- tính tiền theo token nhà cung cấp báo về (1000 vào + 1000 ra = $0.04 với giá thử)
- không có token → chi phí $0, không bịa
- JSON bọc code fence / có lời dẫn → sửa được
- JSON hỏng hẳn → báo lỗi rõ, không crash
- hạn mức: chặn khi chưa xác nhận, chặn khi vượt, cho qua khi hợp lệ
- xác nhận có phạm vi theo từng model, không lan sang model khác
- chi phí mock và chi phí ước tính **không** tính vào hạn mức

**Giao diện đã kiểm tra thủ công trên trình duyệt**: cổng xác nhận hiển thị đủ
8 chỉ số, 3 cảnh báo đúng (giá 0, model đang tắt, Mock Mode đang bật), và khi
bấm xác nhận thì **từ chối** với lý do "Chưa nhập giá cho model này".

### CHƯA làm — chưa gọi API thật lần nào

- [ ] **Chưa có API key nào được cấu hình** → không thể chạy bước 10 và 11 trong
      yêu cầu (test workflow thật, so sánh Mock vs Real với dữ liệu thật)
- [ ] Chưa xác minh nhà cung cấp thật nào hoạt động đúng như tài liệu
- [ ] Chưa đo được chất lượng tiếng Anh / độ hài hước của model thật
- [ ] Chưa xác minh `response_format: json_object` hoạt động với từng nhà cung cấp

Công cụ `npm run compare:text` đã sẵn sàng; chỉ cần cắm key vào là chạy được.

---

## Chưa làm (các bước sau)

### Milestone 2 bước 2-4
- [ ] Image AI thật
- [ ] Video AI thật (Runway)
- [ ] Voice AI thật (ElevenLabs / OpenAI)

**Image, Video, Voice, Upscale vẫn hoàn toàn là mock.**

### Milestone 3-4
- [ ] Nhiều nhà cung cấp video, định tuyến thật
- [ ] Đo `historicalSuccessRate` thật theo thời gian
- [ ] Nhất quán nhân vật nâng cao, phụ đề động, SFX, nhạc nền
- [ ] Nâng phân giải thật, YouTube API, lên lịch, phân tích

### Có backend nhưng chưa có nút trên giao diện
- [ ] Sinh metadata YouTube
- [ ] Sửa mẫu prompt từ trang quản trị
- [ ] Tải ảnh tham chiếu nhân vật
- [ ] Chọn nhạc nền cho dự án

---

## Lỗi đã biết

Không có lỗi nào đang mở.

### Đã phát hiện và sửa trong Milestone 1

| Vấn đề | Cách sửa |
|---|---|
| `slugify` làm mất chữ "đ" tiếng Việt | NFD không tách "đ"; thêm ánh xạ riêng |
| Bộ che khoá bí mật bỏ sót khoá nhiều đoạn | Cho phép `-` và `_` trong thân khoá |
| Chiến lược CHEAPEST vẫn bị ngưỡng chất lượng ép lên model đắt | Ngưỡng chỉ áp dụng khi strategy = AUTO |
| Kế hoạch có cảnh không định tuyến được vẫn báo "trong ngân sách" | `withinBudget` yêu cầu không còn lỗi định tuyến |
| Chi phí chấm điểm chất lượng ghi theo ước tính | Ghi theo chi phí nhà cung cấp báo về |
| Thanh trạng thái luôn báo "worker đang tắt" | Trạng thái worker chuyển sang `globalThis` |
| `window.confirm` chặn toàn bộ renderer | Thay bằng xác nhận nội tuyến |
| `zoompan` ở 1080x1920 quá chậm | Đổi sang scale + crop di động |
| Thẻ hình mock tràn khung | Tự co chữ, neo khối chú thích từ đáy |
| Dọn thư mục test trong `setupFiles` gây EPERM | Chuyển sang `globalSetup` |

### Đã phát hiện và sửa trong Milestone 2 bước 1

| Vấn đề | Cách sửa |
|---|---|
| `project-service.ts` **hard-code** `"mock"/"mock-text-1"` — vi phạm nguyên tắc không ghim provider vào business logic | Thêm `selectTextModel()` dùng AI Router đọc từ `ModelRegistry` |
| `ModelRegistry` chỉ có 1 trường giá, không tính đúng được chi phí text (input và output khác giá) | Thêm cột `priceOutput` + ô nhập trong giao diện |
| `TextProvider` không báo cáo token đã dùng, nên không thể ghi chi phí thật | Đổi interface: mọi lệnh gọi text trả kèm `ProviderUsage` |
| `.gitignore` có `data/` nên nuốt luôn `src/data/` là mã nguồn | Neo về gốc repo: `/data/` |
| Dùng `require()` để tránh circular import | Không cần — `script-service` đã được import tĩnh sẵn |

---

## Tình trạng lược đồ

Ổn định. 15 bảng. Đã đồng bộ qua `prisma db push`.

Thay đổi trong Milestone 2 bước 1:
- `ModelRegistry.priceOutput` (Float, mặc định 0)
- `ProviderJob.inputTokens`, `outputTokens`, `durationMs` (Int?, cho phép null)

Chưa tạo tệp migration — vẫn dùng `db push`. Nên chuyển sang `prisma migrate`
trước khi phát hành cho người khác dùng.

---

## Việc nên làm tiếp theo

Xem [NEXT_TASKS.md](NEXT_TASKS.md).

**Việc chặn hiện tại: cần một API key.** Ba lựa chọn, xếp theo chi phí:

1. **Ollama chạy cục bộ — $0.00.** Cài từ https://ollama.com, chạy
   `ollama pull llama3.1`, bật model `ollama/llama3.1` trong trang Mô hình AI.
   Kiểm chứng được toàn bộ đường đi thật mà không tốn đồng nào.
2. **Groq / DeepSeek** — rất rẻ, tương thích OpenAI API.
3. **OpenAI `gpt-4o-mini`** — chất lượng tốt, vẫn rẻ.

Với lựa chọn nào cũng phải: nhập giá thật trong trang Mô hình AI → bật model →
bấm xác nhận trong trang Nhà cung cấp AI → đặt `AI_MOCK_MODE=false` → chạy
`npm run compare:text`.
