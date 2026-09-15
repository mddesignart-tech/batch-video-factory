# Funny Idioms Video Factory

Công cụ chạy trên máy cá nhân (Windows) để sản xuất video ngắn hài hước dạy
thành ngữ tiếng Anh cho **YouTube Shorts / TikTok / Facebook Reels**.

Mỗi video lấy một thành ngữ, hiểu nó theo nghĩa đen thành một trò đùa hình ảnh,
đẩy trò đùa lên cao trào, rồi giải thích nghĩa thật bằng tiếng Anh đơn giản.

- **Giao diện quản trị:** tiếng Việt
- **Nội dung video:** tiếng Anh đơn giản
- **Đầu ra:** MP4 1080x1920, 9:16, 30fps, H.264 + AAC

---

## Nguyên tắc sản phẩm

Tối ưu **chất lượng trên mỗi đô la**, không phải "mô hình rẻ nhất" và cũng không
phải "mô hình đắt nhất".

Cụ thể: AI Router chọn mô hình **cho từng cảnh riêng biệt**. Một video có thể
dùng mô hình rẻ cho cảnh giải thích tĩnh và mô hình mạnh cho 3 giây đầu và cho
cảnh punchline — vì đó là hai chỗ người xem thực sự nhận ra sự khác biệt.

Chế độ mặc định: **Cân bằng (BALANCED)**.

---

## Bắt đầu nhanh (Windows)

```powershell
npm install
copy .env.example .env
npm run setup      # tạo bảng + nạp 137 thành ngữ, nhân vật, phong cách, mô hình
npm run dev
```

Mở http://localhost:3000

Nếu có gì không chạy: `npm run doctor` sẽ kiểm tra Node, FFmpeg, .env, cơ sở dữ
liệu và nói rõ cần sửa gì.

Hướng dẫn chi tiết: [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md)

---

## Chế độ mock (mặc định)

`AI_MOCK_MODE=true` trong `.env` là **công tắc an toàn chi phí**.

Khi bật:

- không có kết nối mạng nào tới nhà cung cấp trả phí,
- toàn bộ quy trình vẫn chạy đầy đủ: kịch bản → storyboard → ảnh → video →
  giọng đọc → phụ đề → FFmpeg → MP4,
- media là tệp thật (PNG/MP4/WAV), không phải tệp rỗng,
- chi phí thực tế ghi nhận là **$0.00**.

Các mô hình `mock-*` có **giá mô phỏng** (không phải $0) để phần ước tính chi
phí, kiểm tra ngân sách và tối ưu lô có thể thử nghiệm được. Giá đó chỉ ảnh
hưởng tới *ước tính*; sổ chi phí thực tế vẫn là $0.

---

## Quy trình

```
Thành ngữ
   ↓
Dự án  →  Kịch bản (miễn phí, có chấm điểm + chống trùng lặp)
   ↓
Người dùng xem lại và chỉnh sửa storyboard
   ↓
Ước tính chi phí cho cả 3 chế độ  →  kiểm tra NGÂN SÁCH TỐI ĐA
   ↓
Bấm "TẠO MEDIA"   ← đây là bước duy nhất có thể tốn tiền
   ↓
Ảnh keyframe → Video từng cảnh → Giọng đọc → Chấm điểm chất lượng
   ↓
Phụ đề (SRT + ASS)  →  FFmpeg ghép + ghi phụ đề  →  MP4
```

Việc tạo kịch bản **không bao giờ** tự động kéo theo việc tiêu tiền. Đó là hai
thao tác riêng biệt, và thao tác thứ hai bị chặn nếu vượt ngân sách.

### Batch Video Factory — nhiều video trong một lần duyệt

Trang `/batches` làm việc trên cùng nguyên tắc đó, chỉ mở rộng cho nhiều video:

```
A. PHÂN TÍCH & DỰ TOÁN   miễn phí, chỉ đọc, làm lại bao nhiêu lần cũng được
       ↓  bảng: từng video, số cảnh, cảnh nào dùng Video AI, nhà cung cấp, dự toán
B. DUYỆT & CHẠY BATCH    nhập MAXIMUM AUTHORIZED SPEND rồi bấm  ← bước tiêu tiền
       ↓
   chạy tự động hết lô, KHÔNG hỏi lại từng cảnh
```

Ba lớp hạn mức cùng có hiệu lực, và một request phải qua cả ba:

| Lớp | Ý nghĩa |
|---|---|
| Hạn mức toàn ứng dụng | trần của cả công cụ. Lô không vượt qua được. |
| Hạn mức / video | video nào vượt sẽ dừng **riêng nó**, lô vẫn chạy tiếp |
| Hạn mức / lô | người dùng tự nhập khi duyệt. Chạm trần thì lô dừng. |

Lô dừng khi: hết hạn mức, nhà cung cấp hết số dư, có cảnh cần provider chưa được
duyệt, lỗi không tự phục hồi được, hoặc người dùng bấm **DỪNG BATCH**.

**Không phải cảnh nào cũng gọi Video AI.** Cảnh giải thích và cảnh chốt dùng ảnh
keyframe + chuyển động FFmpeg tại máy — $0 và không thể hỏng ở phía nhà cung cấp.
Chỉ cảnh thật sự cần chuyển động tạo sinh mới trả tiền. Xem
`src/domain/local-motion.ts`.

---

## Lệnh

| Lệnh | Việc |
|---|---|
| `npm run dev` | Chạy ở chế độ phát triển |
| `npm run build` / `npm start` | Bản production cục bộ |
| `npm run setup` | Tạo bảng + nạp dữ liệu mẫu |
| `npm run seed` | Nạp lại danh mục (an toàn, không ghi đè dự án) |
| `npm run doctor` | Kiểm tra môi trường |
| `npm run backup` | Sao lưu `data/` sang `backups/` |
| `npm run cleanup` | Dọn tệp tạm (thêm `--dry-run` để xem trước) |
| `npm run provider:enable` | Bật + cho phép một Text AI thật |
| `npm run compare:text` | So sánh kịch bản Mock và Text AI thật |
| `npm run verify` | lint + typecheck + test + build |

---

## Kiến trúc

```
Next.js 15 (App Router, TypeScript strict) — một tiến trình cục bộ
  │
  ├─ src/domain/      Zod schema + kiểu enum
  ├─ src/lib/         prisma, env, paths, crypto, logger, settings, prompts
  ├─ src/providers/   text | image | video | voice | upscale | quality
  │                   → interface + bản mock (bản thật thêm ở Milestone 2)
  ├─ src/services/    AIRouter, CostEstimator, Budget, Script, Generation
  ├─ src/jobs/        hàng đợi trên SQLite + worker trong tiến trình
  ├─ src/media/       FFmpeg, phụ đề, PNG encoder
  └─ src/app/         giao diện tiếng Việt + route API

data/app.db          SQLite — chỉ metadata và đường dẫn
data/projects/<id>/  media thật trên đĩa
prompts/*.txt        mẫu prompt, sửa được không cần đụng mã nguồn
```

Không có Redis, Docker, hay dịch vụ ngoài nào. Xem
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Tài liệu

| Tệp | Nội dung |
|---|---|
| [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) | Cài đặt từ đầu trên Windows |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Cấu trúc và quyết định thiết kế |
| [docs/DATABASE.md](docs/DATABASE.md) | Lược đồ SQLite, đường di cư sang Postgres |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Cách thêm một nhà cung cấp AI thật |
| [docs/AI_ROUTER.md](docs/AI_ROUTER.md) | Cách chọn mô hình cho từng cảnh |
| [docs/VIDEO_PIPELINE.md](docs/VIDEO_PIPELINE.md) | Từ kịch bản đến MP4 |
| [docs/COST_CONTROL.md](docs/COST_CONTROL.md) | Ngân sách, ước tính, chống tính phí hai lần, kế toán khi gọi API thất bại |
| [docs/OFFLINE_MODE.md](docs/OFFLINE_MODE.md) | Những gì chạy được khi mất mạng |
| [docs/BACKUP.md](docs/BACKUP.md) | Sao lưu và khôi phục |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Lỗi thường gặp |
| [.ai/STATE.md](.ai/STATE.md) | Tình trạng thực tế của từng tính năng |

---

## Tình trạng

**Cập nhật: 2026-09-15.**

**Milestone 1 hoàn tất và đã kiểm chứng.** Toàn bộ quy trình chạy được ở chế độ
mock, xuất ra MP4 1080x1920 thật.

**Milestone 2 hoàn tất.** Text AI (Groq), Image AI (OpenAI `gpt-image-2`),
Video AI (Runway `gen4_turbo`/`gen4.5`, OpenAI `sora-2`) và Voice AI (OpenAI
`gpt-4o-mini-tts`) đều đã chạy thật và đã ghi chi phí vào sổ. Chỉ còn Upscale là
mock.

**Batch Video Factory V1: xây xong, mới chỉ chạy ở chế độ mock.** Kế hoạch, duyệt
chi, giữ chỗ tiền, hàng đợi, retry/resume, cancel và LOCAL_MOTION đều đã có test.
Chưa lô nào được duyệt chi thật.

**Tổng chi phí API thật tính đến giờ: $3,712760 trên hạn mức $8,00.**

Con số trên sẽ cũ đi. Kiểm tra lại bằng `spendStatus()` và
`providerSpendBreakdown()` — sổ chi phí mới là nguồn đúng, không phải tài liệu.

Chi tiết trong [.ai/STATE.md](.ai/STATE.md).
