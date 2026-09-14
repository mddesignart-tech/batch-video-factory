# Việc tiếp theo

**Cập nhật:** 2026-09-14

---

## ⛔ VIỆC ĐẦU TIÊN KHI MỞ LẠI: trả lời ba câu hỏi phạm vi

Người dùng đã chốt mục tiêu kế tiếp: **Batch Video Factory V1** — một nút bấm
tạo nhiều video hoàn chỉnh hàng loạt. Kèm theo hai ràng buộc:

- **Không benchmark thêm model hay provider nào nữa.**
- Không tự chạy request trả phí. `CREATE_ATTEMPT_TOKEN = 0`.

Chưa viết code được vì ba câu hỏi sau quyết định kiến trúc, và người dùng phải
là người trả lời:

1. **Nút đó chạy tới đâu?**
   - (a) script → ảnh → video → voice → render, tự động toàn bộ
   - (b) tự động tới trước bước video, dừng chờ duyệt rồi mới chi tiền video
   - (c) chỉ batch các bước **miễn phí** (render, mix, subtitle) trên project đã
     có sẵn media
2. **Hạn mức cho một lần bấm nút là bao nhiêu?**
3. **Mô hình cấp phép chi tiêu cho batch trông như thế nào?**

Vì sao câu 3 không bỏ qua được: `CREATE_ATTEMPT_TOKEN` hiện tại được thiết kế
cho **đúng một** request. Batch cần một mô hình khác hẳn. Và ngân sách còn
$4,287240 trong khi một video 6 cảnh tốn khoảng $1,50–2,40 — tức chỉ đủ **tối đa
2 video**, nên một nút chạy tự do có thể tiêu sạch hạn mức trong một lần bấm.

---

## Việc đã xong, không cần làm lại

- Benchmark Runway gen4_turbo và gen4.5 — xong, lưu trong `VideoBenchmark`.
- Benchmark Sora-2 cảnh 3 — đã thử, hỏng 400, **không chạy lại** (người dùng đã
  dừng mọi benchmark).
- Preflight Sora (`scripts/preflight-sora.ts`) — chỉ GET, chạy lại miễn phí bất
  cứ lúc nào.
- Pipeline âm thanh, loudness, ducking, subtitle timing — production ready.

---

## Nếu sau này quay lại chuyện Sora 6 giây

Đừng POST để thử. Trước hết đọc lại `src/providers/openai/openai-video-client.ts`
quanh chỗ `input_reference`, và so với hai job 4 giây đã đạt
(`GET /videos` liệt kê miễn phí). Chỉ POST khi người dùng cấp token mới.

---

## Lệnh cần nhớ


```
npm run video:benchmark                       # bảng giá mọi provider, miễn phí
npm run project:status -- --idiom "Spill the beans"
npm run video:test -- --scene 4 --dry-run     # kiểm tra, không gọi API
npx tsx scripts/preflight-sora.ts --scene 3   # chỉ GET, miễn phí
npx tsx scripts/routing-preview.ts            # định tuyến + chi phí, miễn phí
npm run crop:check                            # đo vùng cắt 9:16
```

### Ngân sách

Đã chi **$3,712760** / **$8,00** — còn **$4,287240**. Ví từng nhà cung cấp tách
riêng, xem [STATE.md](STATE.md). Mọi script đều có cờ `--limit` chặn thật trước
khi gọi API, và không script nào gọi được create khi
`CREATE_ATTEMPT_TOKEN = 0`.

---

## ✅ Đã xong: Image AI thật (Milestone 2 bước 2)

OpenAI `gpt-image-2` (tầng medium), $0,452760 cho 11 ảnh. Character Reference
hoạt động: mọi cảnh đều nhận ảnh chuẩn của nhân vật có mặt trong cảnh đó.

**Dừng tại đây theo yêu cầu.** Chưa bắt đầu Video AI hay Voice AI.

---

## ✅ Đã xong: Text AI thật (Milestone 2 bước 1)

Nhà cung cấp `groq`, model `openai/gpt-oss-120b`. Đã chạy thật, đã kiểm chứng,
đã ghi nhận chi phí. Chi tiết trong [STATE.md](STATE.md).

Cấu hình hiện tại:

```
Provider : groq (bật, đã xác nhận)
Model    : openai/gpt-oss-120b
Giá      : $0.00015 vào / $0.00075 ra (mỗi 1k token)
Hạn mức  : $0.50, đã chi ~$0.0067
.env     : AI_MOCK_MODE=true  ← vẫn ở chế độ mock cho an toàn
```

Bật Text AI thật: đặt `AI_MOCK_MODE=false` trong `.env`, khởi động lại.

---

## 2. Image AI thật ← bước tiếp theo, CHỜ XÁC NHẬN

Ảnh keyframe. Đây là công cụ giữ nhất quán nhân vật mạnh nhất, nên đáng làm
trước Video AI.

- [ ] Viết `ImageProvider` cho OpenAI Image hoặc Google
- [ ] Truyền ảnh tham chiếu nhân vật khi model hỗ trợ
- [ ] Kiểm tra nhân vật có giữ nguyên ngoại hình giữa các cảnh không
- [ ] Nhập giá thật, đặt đúng cờ năng lực
- [ ] Nâng hạn mức chi tiêu nếu cần (ảnh đắt hơn text đáng kể)

Ước chừng chi phí thử nghiệm: **$1–3**.

Lưu ý rút ra từ bước 1: đừng tin danh sách model trong tài liệu nhà cung cấp —
hãy gọi endpoint liệt kê model của họ trước, vì tên model thay đổi thường xuyên
(`llama-3.3-70b-versatile` đã bị Groq gỡ trong lúc làm bước này).

---

## 3. Video AI thật (Runway)

Đắt nhất, làm sau cùng trong nhóm hình ảnh.

- [ ] `VideoProvider` cho Runway
- [ ] Mô hình bất đồng bộ: create → poll → download
- [ ] **Kiểm chứng chống tính phí hai lần cho thật**: cố tình giết tiến trình
      giữa lúc đang tạo, khởi động lại, xác nhận lần thử lại **nối lại** job cũ
      thay vì mua cái mới
- [ ] Thử với ngân sách nhỏ trước

Ước chừng: **$3–10**.

---

## 4. Voice AI thật

- [ ] `VoiceProvider` cho ElevenLabs hoặc OpenAI
- [ ] Gán giọng cố định cho từng nhân vật
- [ ] Kiểm tra thời lượng giọng khớp thời lượng cảnh; lệch thì chỉnh tốc độ đọc
      thay vì cắt cụt

Ước chừng: **dưới $1**.

---

## Việc nhỏ, không phụ thuộc nhà cung cấp

- [ ] Nút sinh metadata YouTube (provider đã có hàm, chỉ thiếu nút và chỗ lưu)
- [ ] Trang sửa mẫu prompt (`src/lib/prompts.ts` đã hỗ trợ ghi đè từ DB)
- [ ] Tải ảnh tham chiếu nhân vật (cột `referenceImages` đã có)
- [ ] Chọn nhạc nền cho dự án (hàm render đã hỗ trợ trộn nhạc)
- [ ] Trang cài đặt dọn dẹp (hiện chỉ chạy bằng dòng lệnh)

---

## Việc kỹ thuật

- [ ] Ghi nhận `historicalSuccessRate` thật từ kết quả chạy (router đã dùng
      trường này, chỉ chưa có ai cập nhật nó)
- [ ] Chuyển từ `prisma db push` sang `prisma migrate` trước khi phát hành
- [ ] Cân nhắc thêm nút "kiểm tra kết nối" gọi endpoint liệt kê model của nhà
      cung cấp — rẻ, và bắt được đúng loại lỗi tên model đã gặp ở bước 1

---

## Không làm bây giờ

Redis, Docker bắt buộc, microservice, tải lên YouTube tự động, phân tích hiệu
quả video.
