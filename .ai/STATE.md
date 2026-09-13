# Trạng thái dự án

**Cập nhật:** 2026-09-13
**Cột mốc hiện tại:** Milestone 2 — **Bước 1 (Text AI thật): ĐÃ NGHIỆM THU QUA GIAO DIỆN**

Tài liệu này ghi tình trạng **thực tế**. Tính năng chỉ được đánh dấu hoạt động
khi đã chạy thật và được kiểm chứng, không phải khi đã viết xong mã.

---

## Tình trạng build

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Lint | `npm run lint` | ✅ 0 lỗi |
| Kiểu dữ liệu | `npm run typecheck` | ✅ 0 lỗi (TS strict, không dùng `any`) |
| Kiểm thử | `npm run test` | ✅ **224 test / 8 tệp, tất cả đạt** |
| Build production | `npm run build` | ✅ 16 route biên dịch thành công |
| Chạy thật | `npm start` | ✅ Đã kiểm tra thủ công trên Windows 11 |

Môi trường đã kiểm chứng: Windows 11 Pro 26200, Node v24.14.1,
FFmpeg 6.1.1 (bản đi kèm ffmpeg-static, có libass + libx264).

---

## ⚠️ CHI PHÍ API THẬT

**Đã chi: $0,014745** (14 request tới Groq trong toàn bộ quá trình kiểm thử).

Hạn mức: **$0,50**. Còn lại: **$0,485**.

Con số này là **tiền thật theo bảng giá trả phí của Groq**. Nếu tài khoản đang ở
gói miễn phí thì Groq không thực sự trừ tiền — nhưng ứng dụng vẫn tính và ghi
nhận theo giá, vì đó là cách duy nhất để ước tính và hạn mức có ý nghĩa.

Image AI, Video AI, Voice AI **vẫn hoàn toàn là mock, chi phí $0,00**.

`.env` đang ở `AI_MOCK_MODE=true` — chế độ an toàn. Đặt `false` để dùng
Text AI thật.

---

## Nghiệm thu qua giao diện (2026-09-13)

Ba dự án được tạo **hoàn toàn qua UI** như người dùng thật, với
`AI_MOCK_MODE=false`:

| Thành ngữ | Cảnh | Thời lượng | Chi phí thật |
|---|---|---|---|
| Break a leg | 5 | 27,0s | $0,0023 |
| Spill the beans | 6 | 27,0s | $0,0058 |
| Piece of cake | 6 | 23,0s | $0,0019 |

Luồng đã đi qua: UI → chọn idiom → tạo project → AIRouter → TextProvider thật →
script → kiểm tra JSON → storyboard → chấm điểm → sổ chi phí → dashboard.

Image/Video/Voice giữ nguyên mock trong suốt quá trình.

### Các mục an toàn đã kiểm chứng

| Mục | Kết quả |
|---|---|
| Router KHÔNG âm thầm dùng mock khi ở chế độ thật | ĐẠT — cả 3 dự án đều ghi `provider=groq` |
| Provider thật lỗi → UI báo rõ provider/model/lý do | ĐẠT — *"Không tìm thấy model... provider=groq, code=model_not_found"* |
| Không giả vờ thành công bằng mock | ĐẠT — lỗi được ném ra, không có fallback ngầm |
| API key không xuất hiện trong log | ĐẠT — quét 59 dòng LogEntry + 34 ProviderJob, không có key, không có chuỗi `gsk_` |
| Không tạo request trả phí trùng lặp | ĐẠT — 34 khoá idempotency đều duy nhất |
| Dashboard phân biệt 3 loại chi phí | ĐẠT — API thật / ước tính / mock hiển thị riêng |
| Kịch bản 4–6 cảnh, không bị cắt | ĐẠT — 5/6/6 cảnh, mọi cảnh 2–6 giây |
| Lấy danh sách model từ provider thật | ĐẠT — liệt kê 7 model Groq, cảnh báo model lỗi thời |
| Tổng chi phí ≤ $0,50 | ĐẠT — $0,014745 |

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

**1. Máy chủ giả lập chạy cục bộ** (`tests/text-provider.test.ts`, 35 test,
chi phí $0.00): dạng request, đọc token, key nằm đúng header, 429 → thử lại,
401 → **chỉ gọi 1 lần**, 500 liên tục → dừng đúng 3 lần, phản hồi bị cắt, phản
hồi rỗng, tính tiền theo token, JSON bọc code fence / có lời dẫn, mọi nhánh của
hạn mức chi tiêu, và lịch sử chi phí không bị xoá theo dự án.

**2. Gọi API thật tới Groq** (`npm run compare:text`) — nhà cung cấp
`groq`, model `openai/gpt-oss-120b`:

| Tiêu chí | Mock | Groq thật |
|---|---|---|
| JSON đúng schema | ĐẠT | **ĐẠT** |
| Số cảnh (cần 4–6) | 6 | **6** |
| Tổng thời lượng (cần 20–35s) | 26,9s | **27,0s** |
| Mỗi cảnh 2–6 giây | ĐẠT | **ĐẠT** |
| Đủ prompt ảnh | ĐẠT | **ĐẠT** |
| Đủ prompt video | ĐẠT | **ĐẠT** |
| Có giải thích nghĩa | ĐẠT | **ĐẠT** |
| Có câu ví dụ | ĐẠT | **ĐẠT** |
| TB từ/phụ đề (nên ≤ 12) | 6,2 | **6,8** |
| Điểm tự chấm | 7/9/9/9/7 | **8/7/9/9/8** |
| Token | – | 1647 vào / 3447 ra |
| Chi phí thật | $0,000000 | **$0,002832** |

**3. Workflow thật đầy đủ** (`npm run workflow:test`) — Text AI thật, media
vẫn mock: thành ngữ → dự án → kịch bản → kiểm tra JSON → lưu SQLite →
storyboard → chấm điểm → định tuyến media → ước tính 3 chế độ.

Router chọn đúng `groq/openai/gpt-oss-120b` (rẻ hơn mock 10 lần nên thắng về
giá trị). Nhánh **viết lại kịch bản một lần** đã thực sự kích hoạt trong một lần
chạy: 4 request (script, score, script-rewrite, score-rewrite), tổng $0,0049,
mọi request đều được ghi token + thời gian + chi phí vào bảng `ProviderJob`.

**4. Giao diện** đã kiểm tra thủ công: cổng xác nhận hiện đủ 8 chỉ số và 3 cảnh
báo đúng; bấm xác nhận khi model chưa có giá thì **bị từ chối**.

### Chất lượng nội dung: Mock so với Groq thật

Cả hai đều qua toàn bộ kiểm tra cấu trúc. Khác biệt về nội dung:

- **Groq thật** viết tiếng Anh tự nhiên hơn và bám sát thành ngữ hơn. Ví dụ với
  "Piece of cake": *"Max brings a cake to the exam!"* → *"Leo shows the paper is
  easy, not edible."* Đây là trò đùa hình ảnh thật, quốc tế, hiểu được không cần
  âm thanh.
- **Mock** dùng khuôn mẫu cố định nên lời thoại lặp lại giữa các thành ngữ.
- Giải thích nghĩa của Groq chính xác: *"Piece of cake means something is very
  easy."*
- Groq tự đặt thời lượng cảnh và độ phức tạp hợp lý, đủ prompt ảnh/video cho các
  bước sau.

Kết luận: **Text AI thật cho chất lượng dùng được cho sản xuất.** Mock vẫn hữu
ích để thử quy trình miễn phí.

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

### Đã phát hiện khi NGHIỆM THU QUA UI

| Vấn đề | Cách xử lý |
|---|---|
| **Chi phí làm tròn 4 chữ số** nên khoản $0,000045 bị ghi thành $0 — cộng dồn nhiều lần gọi nhỏ sẽ sai lệch | Sổ chi phí và hạn mức chuyển sang 6 chữ số |
| **Lỗi "phản hồi rỗng" không mang theo chi phí** — cùng loại lỗ hổng với truncation: đã bị tính tiền nhưng sổ không ghi | Dựng `ChatResult` trước khi kiểm tra nội dung, mọi lỗi sau đó đều đính `usage` |
| **Text AI thật trả về cảnh 7 giây** — vượt giới hạn 6s mà mỗi lần tạo video AI chịu được. Mock tự giới hạn, provider thật thì không | Cắt về 2–6 giây trong `withDerivedRouting`, kèm test |
| Lấy danh sách model lại đòi model phải đang bật — không thể khám phá model trước khi bật nó | `buildTextConfig` nhận cờ `requireEnabled` |

### Đã phát hiện khi CHẠY THẬT (những lỗi mà test giả lập không bắt được)

| Vấn đề | Cách xử lý |
|---|---|
| **Danh sách biến môi trường viết cứng** khiến provider mới luôn bị coi là "thiếu API key" → router bỏ qua Groq và âm thầm chọn mock dù key đã có | `hasEnvKey()` giờ đọc `apiKeyEnvVar` từ bảng provider, fallback `TÊN_API_KEY` |
| **Xoá dự án làm mất lịch sử chi phí thật** (`CostEntry` cascade theo `Project`) → hạn mức được "hoàn lại" sai, có thể tiêu vượt bằng cách xoá dự án cũ | Đổi quan hệ sang `onDelete: SetNull`; thêm test chống tái diễn |
| **Chi phí bị mất khi request thất bại sau khi đã bị tính tiền** (phản hồi bị cắt, JSON không đọc được) | `ProviderError` mang theo `usage`; sổ ghi nhận cả lần thất bại, ghi rõ "thất bại nhưng vẫn bị tính phí" |
| Giới hạn 2500 token output làm kịch bản 6 cảnh bị cắt giữa chừng | Đo thực tế rồi nâng lên 6000; cơ chế phát hiện cắt đã báo đúng lỗi |
| `provider:enable` chỉ bật model, quên bật cả provider → router vẫn không thấy | Bật cả `ProviderConfig` |
| Tên model `llama-3.3-70b-versatile` đã bị Groq gỡ bỏ | Lấy danh sách thật từ `/v1/models`, cập nhật seed thành `openai/gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b` |
| Script so sánh gọi provider trực tiếp, **bỏ qua hạn mức và không ghi sổ** | Bắt nó đi qua `assertCanSpend` + `recordCost` như ứng dụng |

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

**Milestone 2 bước 1 đã nghiệm thu xong.** Không tự động chuyển sang bước 2
(Image AI) — chờ người dùng xác nhận.

Cấu hình hiện tại:

```
Provider : groq (bật, đã xác nhận)
Model    : openai/gpt-oss-120b
Giá      : $0.00015 / 1k token vào, $0.00075 / 1k token ra
Hạn mức  : $0.50, đã chi $0.014745, còn $0.485255
.env     : AI_MOCK_MODE=true  ← chế độ an toàn
```

Để dùng Text AI thật: đặt `AI_MOCK_MODE=false` trong `.env` rồi khởi động
lại. Để quay về miễn phí: đặt lại `true`.

> Giá đang dùng là theo bảng giá Groq tại thời điểm cấu hình. Hãy đối chiếu lại
> tại https://groq.com/pricing nếu con số ước tính trông không đúng.
>
> Trước khi thêm model mới, bấm **"Hỏi nhà cung cấp"** trong trang Nhà cung cấp
> AI để lấy tên model đang thực sự khả dụng — Groq đã gỡ một model mà chúng ta
> seed sẵn, và đó là nguyên nhân lỗi 404 ở lần chạy thật đầu tiên.
