# Việc tiếp theo

Xếp theo thứ tự khuyến nghị.

---

## 1. Nối Text AI thật ← nên làm trước

Rẻ nhất, ít rủi ro nhất, và kiểm chứng toàn bộ đường đi của tầng provider thật.

- [ ] Viết `src/providers/openai/openai-text-provider.ts` theo interface
      `TextProvider`
- [ ] Gửi `req.systemPrompt` (đã được render sẵn từ `prompts/script.txt`)
- [ ] Đăng ký trong `src/providers/registry.ts` và thêm vào
      `IMPLEMENTED_PROVIDERS`
- [ ] Nhập giá thật trong trang Mô hình AI
- [ ] Đặt `AI_MOCK_MODE=false`, tạo **một** dự án với ngân sách $1
- [ ] Đối chiếu chi phí thực tế với ước tính trong trang Chi phí
- [ ] Chỉ khi chạy thật thành công mới cập nhật `.ai/STATE.md`

Cần chú ý: `parseScript()` đã xử lý sẵn các kiểu JSON hỏng thường gặp. Nếu mô
hình vẫn trả về thứ không đọc được, hãy thêm trường hợp vào `repairJson()` kèm
một test, đừng nới lỏng lược đồ Zod.

---

## 2. Nối Image AI thật

- [ ] `ImageProvider` cho OpenAI Image hoặc Google
- [ ] Truyền ảnh tham chiếu nhân vật khi mô hình hỗ trợ
- [ ] Kiểm tra tính nhất quán nhân vật giữa các cảnh trong cùng một video
- [ ] Nhập giá thật, đặt cờ năng lực cho đúng

---

## 3. Nối Video AI thật (Runway)

- [ ] `VideoProvider` cho Runway
- [ ] Xử lý mô hình bất đồng bộ: create then poll then download
- [ ] Xác nhận `ProviderJob` thực sự ngăn được việc trả tiền hai lần: cố tình
      giết tiến trình giữa lúc đang tạo, khởi động lại, và kiểm tra rằng lần
      thử lại **nối lại** job cũ thay vì mua cái mới
- [ ] Kiểm thử với ngân sách nhỏ trước

---

## 4. Nối Voice AI thật

- [ ] `VoiceProvider` cho ElevenLabs hoặc OpenAI
- [ ] Gán giọng cố định cho từng nhân vật
- [ ] Kiểm tra thời lượng giọng đọc khớp với thời lượng cảnh; nếu lệch, điều
      chỉnh tốc độ đọc thay vì cắt cụt

---

## Việc nhỏ, không phụ thuộc nhà cung cấp

- [ ] Nút sinh metadata YouTube trong trang dự án (tầng provider đã có hàm, chỉ
      thiếu nút và chỗ lưu vào `youtubeMetaJson`)
- [ ] Trang sửa mẫu prompt (`src/lib/prompts.ts` đã hỗ trợ ghi đè từ DB)
- [ ] Tải ảnh tham chiếu nhân vật (cột `referenceImages` đã có)
- [ ] Chọn nhạc nền cho dự án (hàm render đã hỗ trợ trộn nhạc)
- [ ] Trang cài đặt dọn dẹp (hiện chỉ chạy bằng dòng lệnh)

---

## Việc kỹ thuật

- [ ] Ghi nhận `historicalSuccessRate` thật từ kết quả chạy (hiện luôn là 1;
      router đã dùng trường này, chỉ chưa có ai cập nhật nó)
- [ ] Chuyển từ `prisma db push` sang `prisma migrate` trước khi phát hành
- [ ] Cân nhắc tách worker ra tiến trình riêng nếu sau này chạy trên VPS

---

## Không làm bây giờ

Redis, Docker bắt buộc, microservice, tải lên YouTube tự động, phân tích hiệu
quả video. Chưa có cái nào giải quyết vấn đề đang tồn tại, và mỗi cái đều thêm
một thứ có thể hỏng.
