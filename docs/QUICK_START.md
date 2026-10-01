# Bắt đầu nhanh — Batch Video Factory V1.2

10 bước từ storyboard tới MP4 sẵn đăng. Giải thích đầy đủ: [HUONG_DAN_SU_DUNG.md](HUONG_DAN_SU_DUNG.md).

> Không bước nào tốn tiền cho tới bước 8. Bước 8 chỉ tiêu **tối đa** số tiền bạn gõ.

1. **Mở app.** PowerShell trong thư mục dự án → `npm start` (lần đầu / sau khi cập nhật:
   `npm run build` trước) → mở **http://localhost:3000/workspace**.
2. **Vào Nhập.** Bấm **TẠO LÔ VIDEO** (hoặc menu **Nhập Storyboard**).
3. **Đưa storyboard vào.** Kéo thả thư mục (hoặc nhiều thư mục / `.zip` / file `.json` `.csv` +
   ảnh) vào khung "Kéo thả vào đây", hoặc gõ đường dẫn thư mục vào ô đường dẫn.
4. **Kiểm tra cảnh.** Bấm **KIỂM TRA**. Sửa mọi dòng **đỏ** (lỗi). Đọc dòng **vàng** (nhắc nhở),
   nhất là `image_will_be_generated` (cảnh sẽ tạo ảnh bằng AI — tốn tiền) và
   `character_needs_reference`.
5. **Dự toán.** Bấm **DỰ TOÁN & TẠO LÔ** ($0) → mở lô vừa tạo (Làm việc hằng ngày → Lịch sử lô).
6. **Kiểm tra chi phí.** Khối **Kiểm tra & dự toán**: ẢNH AI CẦN TẠO, CLIP VIDEO AI, GIỌNG CẦN TẠO,
   CHI PHÍ CẦN, ĐỀ XUẤT DUYỆT, HẠN MỨC TOÀN CỤC CÒN. Đọc lý do của video **BỊ CHẶN**.
   Bấm **CHẠY VIDEO $0 TRƯỚC** nếu có — chạy ngay, không tốn tiền.
7. **Nhập trần.** Khung **DUYỆT & CHẠY**: gõ **Chi tối đa ($)** (≤ ĐỀ XUẤT DUYỆT) → **KIỂM TRA VỚI
   SỐ NÀY** → không còn dòng đỏ → tick **Tôi đồng ý chi tối đa …**.
8. **DUYỆT & CHẠY.** Bấm **DUYỆT & CHẠY — MAX $X**.
9. **Theo dõi Queue.** Thẻ video đổi trạng thái (ĐANG TẠO → ĐANG RENDER → HOÀN THÀNH); khối
   **Hàng đợi** cuối trang. Video **CẦN XỬ LÝ** → **TIẾP TỤC**.
10. **Mở Output.** Thẻ **HOÀN THÀNH · SẴN SÀNG ĐĂNG** → **MỞ THƯ MỤC**:
    `data/output/<lô>/<video>/final.mp4` + `thumbnail.jpg` + `metadata.json` + `description.txt`
    (+ `subtitles.srt` khi có lời). Đăng tay.

---

## Nếu bạn đã chuẩn bị ảnh từng scene trước

Đây là cách rẻ nhất: **tool giữ ảnh của bạn, tiền Image API = $0.**

1. Mỗi video một thư mục:

   ```
   video-01/
     storyboard.json
     images/scene-01.png  scene-02.png  …
   ```

2. Trong `storyboard.json`, **mỗi cảnh phải có `image_file`** trỏ tới ảnh (đường dẫn tương đối):

   ```json
   { "scene_number": 1, "duration": 3,
     "visual_description": "Linh cầm ly nước trong bếp.",
     "dialogue": "Linh: \"Nước sạch mỗi ngày.\"", "subtitle": "Nước sạch mỗi ngày.",
     "image_file": "images/scene-01.png",
     "motion_mode": "LOCAL_MOTION" }
   ```

3. Ghi `"motion_mode": "LOCAL_MOTION"` cho cảnh tĩnh ($0, xử lý tại máy) và `"VIDEO_AI"` chỉ cho
   vài cảnh cần chuyển động thật. Cảnh VIDEO_AI nên ghim model: `"video_provider": "runway",
   "video_model": "h3_max:768x1280"`, và đặt `"max_cost"` cho cảnh.
4. Sau **KIỂM TRA**, không được có nhắc nhở `image_will_be_generated`. Sau **DỰ TOÁN**, ô
   **ẢNH AI CẦN TẠO** phải là **0** và **ẢNH NHẬP** bằng số cảnh.

Nếu ô ẢNH AI CẦN TẠO khác 0: có cảnh thiếu `image_file` hoặc đường dẫn sai — sửa trước khi duyệt.

Ảnh nhận: `.png` `.jpg` `.jpeg` `.webp` (≤ 40 MB). Ảnh không phải 9:16 không bị kéo méo.

## An toàn chi phí, tóm tắt

- `AI_MOCK_MODE=true` trong `.env` → không request trả phí nào rời máy; số tiền trên màn hình là
  **giá giả lập**.
- Tiền chỉ đi ra ở bước 8, tối đa bằng số bạn gõ, và không vượt **hạn mức toàn cục** (chỉ bạn đổi,
  ở Cài đặt).
- Asset đã có và hợp lệ được **dùng lại**, không mua lại — kể cả khi TIẾP TỤC.
