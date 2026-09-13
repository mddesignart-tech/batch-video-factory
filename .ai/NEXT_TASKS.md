# Việc tiếp theo

Xếp theo thứ tự khuyến nghị.

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
