# Ví dụ: một video quảng cáo 12 cảnh, làm trong một buổi sáng

Ví dụ minh hoạ — **không** chạy API nào để viết tài liệu này. Giá Video AI lấy từ lần chạy thật đã
ghi sổ (`runway/h3_max:768x1280`, clip 5 giây = 40 credit = **$0,40**); mọi con số khác hãy đọc ở
khối **Kiểm tra & dự toán** của chính bạn — đó mới là nguồn đúng.

## Bài toán

Quảng cáo dọc 9:16 (~35 giây) cho "Máy lọc nước mini", một nhân vật xuyên suốt (**Linh**), có lời
thoại tiếng Việt, có phụ đề, xuất YouTube Shorts.

Bạn đã vẽ sẵn **12 ảnh cảnh** bằng công cụ khác (GPT, Gemini, Photoshop…), cùng một Linh.

## Chia cảnh

| Cảnh | Nội dung | Chuyển động | Vì sao |
|---|---|---|---|
| 1 | Linh rót nước, nước trào sóng sánh (hook) | **VIDEO_AI** | 3 giây đầu giữ người xem; cần chuyển động thật |
| 2 | Cận cảnh ly nước đục | LOCAL_MOTION | Ảnh tĩnh + đẩy máy là đủ |
| 3 | Linh nhăn mặt | LOCAL_MOTION | Phản ứng, một người |
| 4 | Hộp máy lọc trên bàn | LOCAL_MOTION | Sản phẩm tĩnh |
| 5 | Linh lắp máy vào vòi | **VIDEO_AI** | Hành động tay — ảnh tĩnh trông như trình chiếu |
| 6 | Nước trong chảy ra | LOCAL_MOTION | Ảnh đẹp là đủ |
| 7 | Linh uống, mỉm cười | LOCAL_MOTION | Một người, cảm xúc |
| 8 | Bảng 3 lợi ích (chữ) | LOCAL_MOTION | Thẻ chữ |
| 9 | Linh tưới cây bằng nước lọc | LOCAL_MOTION | Minh hoạ |
| 10 | Linh xoay máy, đèn báo sáng (punchline) | **VIDEO_AI** | Khoảnh khắc người xem nhớ |
| 11 | Giá + ưu đãi (chữ) | LOCAL_MOTION | Thẻ chữ |
| 12 | Logo + kêu gọi mua | LOCAL_MOTION | Cảnh chốt |

→ **9 cảnh LOCAL_MOTION ($0 API)**, **3 cảnh VIDEO_AI**.

## Thư mục

```
quang-cao-may-loc/
  storyboard.json
  characters/linh.png          ảnh tham chiếu nhân vật
  images/scene-01.png … scene-12.png
```

## storyboard.json (rút gọn — cảnh 3–9, 11 giống mẫu cảnh 2)

```json
{
  "video_id": "quang-cao-may-loc",
  "video_title": "Máy lọc nước mini — nước sạch trong 10 giây",
  "max_cost": 1.40,
  "characters": [
    {
      "character_id": "linh",
      "character_name": "Linh",
      "character_reference_image": "characters/linh.png",
      "character_hair": "tóc đen ngang vai",
      "character_outfit": "áo len màu kem"
    }
  ],
  "scenes": [
    {
      "scene_number": 1, "duration": 4, "character_id": "linh",
      "visual_description": "Linh rót nước vào ly trong bếp sáng, nước sóng sánh.",
      "character_action": "Linh nghiêng bình, nước chảy vào ly.",
      "camera": "Locked static medium shot, no camera movement.",
      "dialogue": "Linh: \"Nước nhà bạn có thật sự sạch?\"",
      "subtitle": "Nước nhà bạn có thật sự sạch?",
      "image_file": "images/scene-01.png",
      "motion_mode": "VIDEO_AI",
      "video_provider": "runway", "video_model": "h3_max:768x1280",
      "max_cost": 0.45,
      "priority": "HIGH"
    },
    {
      "scene_number": 2, "duration": 2, "character_id": "linh",
      "visual_description": "Cận cảnh ly nước hơi đục trên bàn.",
      "camera": "Locked static close-up.",
      "subtitle": "",
      "image_file": "images/scene-02.png",
      "motion_mode": "LOCAL_MOTION",
      "priority": "LOW"
    },
    {
      "scene_number": 5, "duration": 4, "character_id": "linh",
      "visual_description": "Linh lắp máy lọc nhỏ vào vòi nước.",
      "character_action": "Hai tay Linh vặn khớp nối cho chặt.",
      "camera": "Locked static medium shot, no camera movement.",
      "dialogue": "Linh: \"Lắp trong mười giây, không cần thợ.\"",
      "subtitle": "Lắp trong 10 giây, không cần thợ.",
      "image_file": "images/scene-05.png",
      "motion_mode": "VIDEO_AI",
      "video_provider": "runway", "video_model": "h3_max:768x1280",
      "max_cost": 0.45,
      "priority": "HIGH"
    },
    {
      "scene_number": 10, "duration": 4, "character_id": "linh",
      "visual_description": "Linh xoay máy lọc, đèn báo xanh bật sáng.",
      "character_action": "Linh xoay nhẹ, đèn sáng, Linh nháy mắt.",
      "camera": "Locked static medium shot, no camera movement.",
      "dialogue": "Linh: \"Đèn xanh là nước sạch.\"",
      "subtitle": "Đèn xanh là nước sạch.",
      "image_file": "images/scene-10.png",
      "motion_mode": "VIDEO_AI",
      "video_provider": "runway", "video_model": "h3_max:768x1280",
      "max_cost": 0.45,
      "priority": "HIGH"
    },
    {
      "scene_number": 12, "duration": 3, "character_id": "linh",
      "visual_description": "Logo máy lọc và dòng chữ Mua ngay.",
      "dialogue": "Linh: \"Mua ngay hôm nay.\"",
      "subtitle": "Mua ngay hôm nay.",
      "image_file": "images/scene-12.png",
      "motion_mode": "LOCAL_MOTION",
      "priority": "LOW"
    }
  ]
}
```

Model `runway/h3_max:768x1280` phải được **cho phép** ở trang **Nhà cung cấp AI** trước, nếu không
3 cảnh VIDEO_AI sẽ báo "Chưa xác nhận giá…" và video bị chặn (không mất tiền).

## Các bước trong app

1. **TẠO LÔ VIDEO** → kéo thư mục `quang-cao-may-loc/` → **KIỂM TRA**.
   Mong đợi: 0 lỗi; **không** có `image_will_be_generated`; tóm tắt "12 cảnh · ảnh có sẵn 12, sẽ
   tạo 0 · LOCAL_MOTION 9 · VIDEO_AI 3".
2. **DỰ TOÁN & TẠO LÔ** → mở lô.
3. **Kiểm tra & dự toán**: ẢNH NHẬP 12 · ẢNH AI CẦN TẠO **0** · CẢNH LOCAL 9 · CLIP VIDEO AI 3 ·
   GIỌNG CẦN TẠO = số cảnh có lời.
4. **Preset**: YouTube Shorts (1080x1920 · 30 fps · phụ đề in + SRT).
5. **DUYỆT & CHẠY**: gõ đúng ĐỀ XUẤT DUYỆT → KIỂM TRA VỚI SỐ NÀY (mong đợi POST ảnh/video/giọng
   = 0 / 3 / số câu thoại) → tick → bấm.
6. Theo dõi: 9 cảnh LOCAL xong gần như ngay (tại máy); 3 clip chờ Runway; giọng; render.
7. **HOÀN THÀNH · SẴN SÀNG ĐĂNG** → CHI TIẾT → sửa tiêu đề/hashtags → **LƯU METADATA** → **MỞ THƯ
   MỤC** → đăng tay.

## Tool tiết kiệm tiền ở đâu

| Khoản | Nếu làm "tất cả bằng AI" | Ví dụ này |
|---|---|---|
| Ảnh 12 cảnh | 12 request Image AI | **0** — ảnh nhập, $0 |
| Chuyển động | 12 clip × $0,40 = **$4,80** | 3 clip × $0,40 = **$1,20**; 9 cảnh LOCAL = $0 |
| Giọng | theo số câu | như nhau (rất nhỏ so với clip) |
| Phụ đề, render, thumbnail, metadata | — | tại máy, $0 |

- **Chạy lại / TIẾP TỤC**: clip, giọng, ảnh đã có không mua lại.
- **Sửa phụ đề** sau khi xong: chỉ render lại tại máy, $0.
- **Làm phiên bản TikTok**: đổi preset → RENDER LẠI, $0.
- **Video thứ hai cùng câu thoại / cùng clip**: giọng và clip trùng được **dùng lại** (Thư viện
  asset ghi "tiết kiệm nhờ dùng lại").
- `max_cost` 0,45 mỗi cảnh VIDEO_AI và 1,40 cho cả video: một cảnh đắt bất thường bị chặn riêng thay
  vì ăn tiền của cả video.
