# Nhập storyboard có sẵn ảnh (Import Storyboard / Batch From Scenes)

> **ẢNH NHẬP SẴN = DÙNG LẠI = $0 TIỀN IMAGE API.**
> Cảnh nào đã có ảnh bạn đưa vào thì tool **không bao giờ** gọi Image API cho cảnh đó —
> không lúc chạy, không lúc resume, không lúc retry — và dự toán ghi rõ `IMPORTED`.

Bạn vẽ trước toàn bộ ảnh storyboard bằng GPT / Gemini / Ideogram / Photoshop / công cụ
khác, rồi đưa vào đây để dựng video: tool chỉ còn làm giọng, phụ đề, chuyển động
(LOCAL_MOTION miễn phí hoặc VIDEO_AI trả phí) và render MP4.

## Ba cách đưa ảnh vào

| Cách | Ở đâu | Dùng khi |
|---|---|---|
| **A. Từng cảnh** | Trang dự án → chọn cảnh → khối **Ảnh cảnh** → **Chọn ảnh / Thay ảnh** | Sửa một hai cảnh |
| **B. Nhiều ảnh một lần** | Trang dự án → **Nhập ảnh storyboard** → **NHẬP ẢNH** hoặc **Chọn cả thư mục** | Dự án đã có cảnh, bạn có sẵn bộ ảnh |
| **C. Storyboard JSON/CSV + ảnh** | Trang **Nhập Storyboard** → **TẢI LÊN THƯ MỤC STORYBOARD** (hoặc chọn file / .zip, hoặc gõ đường dẫn) | Tạo video mới từ đầu, một hay nhiều video |

### Cách B — ghép ảnh vào cảnh theo tên file

Tên file phải nêu số cảnh. Nhận: `scene-01.png`, `scene_1.jpg`, `Scene 001.webp`,
`s01.png`, `shot-3.png`, `frame_07.jpg`, `cảnh-2.png`, `01.png`, `003-dentist.png`.

Trước khi gắn, tool hiện bảng **File → Cảnh** để bạn xem:

- `IMPORTED` — sẽ gắn vào cảnh đó.
- `CONFLICT` — hai file cùng trỏ một cảnh: **không dùng file nào** cho cảnh đó.
- `NO_SUCH_SCENE` — dự án không có cảnh số đó.
- `UNMAPPED` — tên không nêu số cảnh (vd. `holiday.png`): đổi tên hoặc dùng cách A.
- `NOT_AN_IMAGE` — không phải .png/.jpg/.jpeg/.webp.
- Cảnh đã có ảnh chỉ bị thay khi bạn tick **Thay ảnh hiện có**.

Số file khác số cảnh → tool báo rõ, chỉ gắn file ghép được, cảnh còn lại giữ nguyên.

## Quy trình

1. Tạo dự án (hoặc dùng cách C để tạo luôn).
2. Nhập storyboard / ảnh.
3. Xem bảng ghép File → Cảnh, sửa chỗ báo lỗi.
4. Chọn **Chuyển động** từng cảnh: `LOCAL_MOTION` (FFmpeg tại máy, $0) hoặc `VIDEO_AI`
   (một clip Video AI dựng **từ chính ảnh nhập**, có tính phí).
5. Chạy dự toán (**DỰ TOÁN & TẠO LÔ** trên trang Nhập, hoặc khối chi phí trên trang dự án).
6. Kiểm tra khối **Ảnh**:

   ```
   TOTAL SCENES: 5
   IMAGES: 5 REUSE (5 IMPORTED) · 0 CREATE
   IMAGE API POST: 0
   IMAGE API COST: $0.00
   VOICE API POST: 5
   VIDEO API POST: 1
   LOCAL_MOTION: 4 · VIDEO_AI: 1
   ```

7. Duyệt tiền ở trang lô, render.

## Định dạng JSON (một file `storyboard.json` cho mỗi video)

Đây là **cùng định dạng** Import Storyboard V1 đã dùng — không có schema thứ hai.

```json
{
  "video_id": "break-the-ice",
  "video_title": "Break the ice",
  "characters": [{ "character_id": "max", "character_name": "Max" }],
  "scenes": [
    {
      "scene_number": 1,
      "duration": 5,
      "visual_description": "Max alone against a plain light grey background.",
      "character_action": "Max closes his eyes for a moment, then gives one small nod.",
      "camera": "Locked static medium shot, no camera movement.",
      "dialogue": "Max: \"Right. I will just say hello.\"",
      "subtitle": "Right. I will just say hello.",
      "image_file": "scene-01.png",
      "image_fit": "auto",
      "motion_mode": "VIDEO_AI",
      "priority": "HIGH"
    }
  ]
}
```

Ví dụ đầy đủ 5 cảnh, 5 ảnh nhập, 4 LOCAL_MOTION + 1 VIDEO_AI:
`examples/storyboard-import-5/`.

| Trường | Bắt buộc | Ý nghĩa |
|---|---|---|
| `scene_number` | có | Số cảnh, không trùng |
| `duration` | có | Giây |
| `visual_description` | có | Mô tả khung hình (chỉ là metadata khi đã có ảnh) |
| `image_file` | không | Ảnh của cảnh, đường dẫn **tương đối** tới file JSON. Có → `IMPORTED`, không gọi Image API. Không có → ảnh sẽ được **tạo** (tính phí, dự toán báo `WILL_CREATE`) |
| `image_fit` | không | `auto` (mặc định) · `cover` · `contain` — xem mục Khung hình |
| `motion_mode` | không | `AUTO` · `LOCAL_MOTION` · `VIDEO_AI` |
| `dialogue` / `subtitle` / `narration` | không | Lời thoại → giọng + phụ đề |
| `video_provider` + `video_model` | không | Ghim model video (ghim luôn thắng router) |
| `priority` | không | `LOW` · `NORMAL` · `HIGH` |

`image_prompt` không cần: ảnh đã có thì tool không vẽ lại.

## Định dạng CSV

Một dòng mỗi cảnh; nhiều video trong một file bằng cột `video_id`:

```csv
video_id,video_title,scene_number,duration,visual_description,character_action,camera,dialogue,subtitle,image_file,image_fit,motion_mode,priority
break-the-ice,Break the ice,1,5,"Max alone on grey.","Max nods once.","Locked static medium shot.","Max: ""Hello.""","Hello.",scene-01.png,auto,VIDEO_AI,HIGH
break-the-ice,Break the ice,2,4,"Max from the shoulders up.","Max holds still.","Locked static medium shot.","Max: ""...""","...",scene-02.png,auto,LOCAL_MOTION,LOW
```

## Nhiều video một lần

```
batch/
  video-01/
    storyboard.json
    scene-01.png … scene-05.png
  video-02/
    storyboard.json
    scene-01.png …
```

Tải cả thư mục `batch/` lên, hoặc nén thành `.zip`. Một video lỗi chỉ dừng video đó.

## Khung hình — không kéo méo

Video là dọc 1080x1920. Ảnh gần 9:16 (lệch ≤ 12%) được dùng nguyên. Ảnh khác tỉ lệ
(16:9, 1:1, 4:3…) với `image_fit: auto` được đặt **nguyên vẹn** giữa khung trên nền là
chính ảnh đó làm mờ — không cắt mất nhân vật, không kéo giãn. `cover` cắt cho đầy khung;
`contain` luôn giữ nguyên. Việc này làm bằng FFmpeg tại máy, **không** gọi Image API.
File gốc giữ nguyên; tool dùng một bản làm việc.

## Ảnh được nhận

`.png` `.jpg` `.jpeg` `.webp`, tối đa 40 MB mỗi ảnh. Mỗi ảnh được kiểm 3 lớp: đuôi file,
nội dung thật (magic bytes — một `.png` chứa HTML bị từ chối) và **giải mã thật một
khung** (file bị cắt cụt bị từ chối). Lỗi báo đích danh cảnh và file.

Ảnh được **chép vào** `data/projects/<id>/images/` — xoá file gốc trên Desktop sau khi
nhập không ảnh hưởng dự án. Cùng một ảnh nhập hai lần chỉ lưu một bản.

## Thay / bỏ / dùng lại ảnh

- **Thay ảnh**: hỏi xác nhận. Ảnh cũ vẫn giữ trong lịch sử (**Dùng ảnh này** để quay lại).
  Clip Video AI dựng từ ảnh cũ bị bỏ — cảnh VIDEO_AI sẽ cần clip mới (dự toán báo rõ).
- **Bỏ ảnh nhập**: lần chạy sau cảnh đó sẽ **tạo** ảnh bằng AI (tính phí, dự toán báo
  `WILL_CREATE`).
- **Tạo lại ảnh** bị từ chối trên cảnh có ảnh nhập — phải bỏ ảnh nhập trước. Không có
  đường nào thay ảnh bạn đưa bằng ảnh AI mà bạn không yêu cầu.

## Resume / retry

Render hỏng, giọng hỏng, clip hỏng → chạy lại: ảnh nhập giữ nguyên (cùng file, cùng
asset), **0 POST Image API, $0 tiền ảnh**.
