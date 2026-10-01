# Hướng dẫn sử dụng — Batch Video Factory V1.2

Tài liệu cho người **không cần biết lập trình**. Mọi tên nút, tên trang trong tài liệu này
là đúng chữ trên màn hình của bản V1.2.

> **Ba điều quan trọng nhất**
>
> 1. **Ảnh cảnh bạn đã có sẵn thì tool KHÔNG tạo lại** — tiền Image API = $0.
> 2. **Không có nút nào tự tiêu tiền.** Tiền chỉ đi ra sau khi bạn gõ số tiền và bấm
>    DUYỆT & CHẠY (hoặc DUYỆT THÊM & CHẠY), và không bao giờ vượt hạn mức toàn cục.
> 3. **LOCAL_MOTION chạy tại máy = $0 API.** Chỉ cảnh VIDEO_AI mới tốn tiền Video AI.

Bắt đầu nhanh trong 10 bước: [QUICK_START.md](QUICK_START.md).
Ví dụ một ngày làm việc thật: [../examples/DAILY_WORKFLOW_EXAMPLE.md](../examples/DAILY_WORKFLOW_EXAMPLE.md).

---

## Mục lục

**A. Làm quen** — 1 · 2 · 3 · 4
**B. Đưa nội dung vào** — 5 · 6 · 7 · 8 · 9 · 10
**C. Chuyển động** — 11 · 12 · 13 · 14 · 15
**D. Tiền** — 16 · 17 · 18 · 19 · 20 · 21 · 22 · 23
**E. Chạy và theo dõi** — 24 · 25 · 26 · 27 · 28 · 29 · 30 · 31 · 32
**F. Asset** — 33 · 34 · 35
**G. Thành phẩm** — 36 · 37 · 38 · 39 · 40 · 41 · 42 · 43
**H. Quản trị** — 44 · 45 · 46 · 47 · 48 · 49 · 50
**I. Quy trình** — 51 · 52 · 53 · 54

---

## A. Làm quen

### 1. Batch Video Factory dùng để làm gì

Biến **storyboard** (danh sách cảnh: mô tả, lời thoại, ảnh) thành **video dọc 9:16 sẵn để đăng**
lên YouTube Shorts / TikTok / Instagram Reels. Tool làm: giọng đọc, phụ đề, chuyển động,
render MP4, thumbnail, metadata. Làm được **nhiều video một lần** (một "lô").

Tool chạy trên máy của bạn (Windows). Dữ liệu nằm trong thư mục `data/` của dự án.

Tool **không** tự đăng video lên mạng xã hội — bạn đăng tay từ thư mục output.

### 2. Cách khởi động chương trình

Mở PowerShell trong thư mục dự án (`F:\Tool Video Youtube`), gõ:

```powershell
npm run build      # chỉ cần làm lại sau khi cập nhật mã nguồn
npm start
```

Mở trình duyệt: **http://localhost:3000/workspace**

Muốn tắt: bấm `Ctrl + C` trong cửa sổ PowerShell đó. **Đừng tắt khi lô đang chạy** (xem mục 49).

Dòng trạng thái trên cùng mỗi trang cho biết: Trực tuyến · **Chế độ mock — không tốn phí API**
(nếu đang bật mock) · FFmpeg sẵn sàng · số job trong hàng đợi.

Lỗi khi khởi động: chạy `npm run doctor` — lệnh này kiểm tra Node, FFmpeg, `.env`, cơ sở dữ liệu
và nói cần sửa gì. Cài máy mới từ đầu: [WINDOWS_SETUP.md](WINDOWS_SETUP.md).

### 3. Dashboard

Có hai trang tổng quan:

| Trang (menu trái) | Dùng để |
|---|---|
| **Làm việc hằng ngày** (`/workspace`) | Trang chính hằng ngày. Khối **HÔM NAY**: video hoàn thành, video lỗi, đang chờ/chạy, lô tạo hôm nay, **chi API hôm nay** (chỉ tiền thật, không gồm mock), chi phí trung bình/video, **tiết kiệm nhờ dùng lại**, **hạn mức toàn cục còn**, **số dư Runway**. Dưới đó: **Hàng đợi** và **Lịch sử lô** (tìm theo tên lô/tên video, gõ không dấu cũng được, lọc theo ngày và trạng thái). Nút **TẠO LÔ VIDEO** ở góc phải. |
| **Tổng quan** (`/`) | Ảnh chụp chung: video hôm nay, Runway credit, ngân sách còn, lô gần đây, chi phí tháng, dung lượng media. |

### 4. Tạo một video mới

Có hai đường:

- **Đường hằng ngày (khuyên dùng): nhập storyboard** — bạn đã có kịch bản và (thường) đã có
  ảnh. Xem mục 5–9. Đây là đường tài liệu này tập trung vào.
- **Đường thành ngữ (cũ, V1)**: menu **Thành ngữ** → chọn thành ngữ → **Dự án video** → tool
  viết kịch bản → bạn sửa → ước tính → **TẠO MEDIA**. Dùng khi chưa có storyboard.

---

## B. Đưa nội dung vào

### 5. Import Storyboard

Menu **Nhập Storyboard** (hoặc nút **TẠO LÔ VIDEO** trên trang Làm việc hằng ngày).

1. Đưa nội dung vào bằng một trong các cách:
   - **Kéo thả** vào khung "Kéo thả vào đây": thư mục storyboard, nhiều thư mục, file
     `.json`/`.csv` + ảnh, hoặc `.zip`.
   - Nút **TẢI LÊN THƯ MỤC STORYBOARD** (chọn cả thư mục).
   - Nút **Chọn file (.json/.csv + ảnh, hoặc .zip)**.
   - Hoặc gõ **đường dẫn** thư mục / file `.zip` / file `.json`/`.csv` trên máy vào ô
     "…hoặc đường dẫn thư mục" (ví dụ `F:\storyboards\batch-01`).
2. (Tuỳ chọn) **Tên lô**, **Trần chi MỖI VIDEO ($)** (mặc định 1,50), **Trần chi CẢ LÔ ($)**
   (mặc định 5,00).
3. Bấm **KIỂM TRA**: tool đọc file, báo **lỗi** (đỏ, phải sửa) và **nhắc nhở** (vàng, nên đọc),
   và tóm tắt từng video: số cảnh, số ảnh có sẵn / sẽ tạo, số cảnh LOCAL_MOTION / VIDEO_AI / AUTO.
4. Bấm **DỰ TOÁN & TẠO LÔ**: tạo lô ở trạng thái **Chưa duyệt** (quyền chi DRAFT) — **chưa tiêu
   được một đồng**. Mở trang lô ở **Làm việc hằng ngày → Lịch sử lô** (bấm tên lô).

Tick **Nhập phần chạy được — bỏ qua video còn lỗi** nếu muốn nhập các video tốt và bỏ video
lỗi (tool nêu tên từng video bị bỏ).

Hai nút KIỂM TRA và DỰ TOÁN & TẠO LÔ **không gọi API tính phí nào**.

### 6. Import từng scene

Khi chỉ muốn sửa một hai cảnh của video đã có: menu **Dự án video** → mở dự án → chọn cảnh →
khối **Ảnh cảnh** → **Chọn ảnh / Thay ảnh**. Ảnh cũ được giữ trong lịch sử (có nút **Dùng ảnh
này** để quay lại).

Thay ảnh của cảnh VIDEO_AI làm clip cũ hết khớp → cảnh đó sẽ cần clip mới (có tính phí, dự
toán báo rõ trước).

### 7. Import cả folder

Một thư mục = một video; thư mục cha chứa nhiều thư mục con = nhiều video trong một lô:

```
lo-hom-nay/
  video-01/
    storyboard.json
    images/scene-01.png … scene-05.png
  video-02/
    storyboard.json
    images/…
```

Trong `storyboard.json`, `image_file` ghi đường dẫn tương đối, ví dụ `"images/scene-01.png"`.
Kéo cả `lo-hom-nay/` vào trang Nhập (hoặc gõ đường dẫn của nó). Đường dẫn có dấu tiếng Việt và
khoảng trắng dùng được bình thường.

### 8. Import JSON / CSV / ZIP

**JSON** — một file `storyboard.json` cho mỗi video:

```json
{
  "video_id": "quang-cao-01",
  "video_title": "Máy lọc nước mini",
  "max_cost": 0.60,
  "characters": [{ "character_id": "linh", "character_name": "Linh",
                   "character_reference_image": "characters/linh.png" }],
  "scenes": [
    {
      "scene_number": 1,
      "duration": 3,
      "character_id": "linh",
      "visual_description": "Linh cầm ly nước trong bếp sáng.",
      "character_action": "Linh mỉm cười, nâng ly lên.",
      "camera": "Locked static medium shot, no camera movement.",
      "dialogue": "Linh: \"Nước sạch mỗi ngày.\"",
      "subtitle": "Nước sạch mỗi ngày.",
      "image_file": "images/scene-01.png",
      "motion_mode": "LOCAL_MOTION",
      "priority": "LOW"
    }
  ]
}
```

Một file JSON cũng có thể chứa nhiều video: `{ "videos": [ {…}, {…} ] }`.

**Các trường của một cảnh**

| Trường | Bắt buộc | Ý nghĩa |
|---|---|---|
| `scene_number` | có | Số cảnh, không trùng |
| `duration` | có | Giây (kế hoạch; xem mục 36 về nhịp theo giọng) |
| `visual_description` hoặc `character_action` | ít nhất một | Mô tả khung hình / hành động |
| `camera` | không | Cách quay |
| `dialogue` / `narration` / `subtitle` | không | Lời thoại → giọng + phụ đề. Trống = cảnh câm |
| `image_file` | không | Ảnh của cảnh, đường dẫn **tương đối** trong thư mục storyboard. Có = **không gọi Image API** |
| `image_fit` | không | `auto` (mặc định) · `cover` · `contain` |
| `motion_mode` | không | `AUTO` (mặc định) · `LOCAL_MOTION` · `VIDEO_AI` |
| `video_provider` + `video_model` | không | Ghim model Video AI cho cảnh (ghim luôn thắng router) |
| `priority` | không | `LOW` · `NORMAL` · `HIGH` |
| `max_cost` | không | Trần chi của riêng cảnh (USD) |
| `duration_mode` | không | `AUTO` · `MINIMUM` · `LOCKED`, kèm `min_duration` / `max_duration` |
| `character_id` | không | Nhân vật của cảnh (khai trong `characters`) |

`max_cost` đặt ở cấp video = trần chi của video đó.

**CSV** — một dòng mỗi cảnh, nhiều video trong một file bằng cột `video_id`:

```csv
video_id,video_title,scene_number,duration,visual_description,character_action,camera,dialogue,subtitle,image_file,image_fit,motion_mode,priority
quang-cao-01,Máy lọc nước mini,1,3,"Linh cầm ly nước.","Linh mỉm cười.","Locked static medium shot.","Linh: ""Nước sạch.""","Nước sạch.",images/scene-01.png,auto,LOCAL_MOTION,LOW
```

**ZIP** — nén cả thư mục (cấu trúc như mục 7) thành `.zip` rồi kéo vào. Đường dẫn tuyệt đối, ổ
đĩa và `..` bên trong ZIP đều bị từ chối.

Chi tiết đầy đủ định dạng: [IMPORT_STORYBOARD.md](IMPORT_STORYBOARD.md).

### 9. Dùng ảnh scene đã tạo sẵn

Đây là cách làm **tiết kiệm nhất** và là quy trình chính của V1.2:

```
ẢNH / SCENE ĐÃ TẠO SẴN  (GPT, Gemini, Ideogram, Photoshop…)
   ↓  Nhập (image_file trong storyboard)
Tool GIỮ NGUYÊN ảnh của bạn  →  Image API = $0
   ↓
Mỗi cảnh: LOCAL_MOTION ($0, tại máy)  hoặc  VIDEO_AI (tính phí, dựng từ chính ảnh của bạn)
   ↓
KIỂM TRA & DỰ TOÁN  →  bạn xem tiền  →  bạn gõ số tiền và DUYỆT & CHẠY
   ↓
Giọng (TTS)  →  phụ đề  →  render MP4 tại máy  →  Output
```

- Nếu đã có ảnh cảnh tốt thì **không cần tạo ảnh lại**. Cảnh có `image_file` hợp lệ **không bao
  giờ** gọi Image API — không lúc chạy, không lúc resume, không lúc thử lại. Dự toán ghi
  "ẢNH NHẬP" và "ẢNH AI CẦN TẠO 0".
- Ảnh nhận: `.png` `.jpg` `.jpeg` `.webp`, tối đa 40 MB/ảnh. Ảnh được kiểm đuôi, nội dung thật và
  giải mã thử; ảnh hỏng bị báo đích danh cảnh và file.
- Ảnh không phải 9:16 **không bị kéo méo**: với `image_fit: auto`, ảnh lệch nhiều được đặt nguyên
  vẹn giữa khung trên nền mờ của chính nó (làm tại máy, không gọi API).
- Ảnh được **chép vào** `data/projects/…` — xoá file gốc sau khi nhập không ảnh hưởng.
- Cảnh **không** có `image_file` → ảnh sẽ được **tạo** bằng Image AI (tính phí) — trang Nhập
  nhắc "image_will_be_generated" cho từng cảnh như vậy.

### 10. Character Reference / Character Bible

Để một nhân vật trông **giống nhau ở mọi cảnh**, tool cần ít nhất một trong hai thứ:

- **Ảnh tham chiếu**: tải ở menu **Nhân vật**, hoặc ghi `character_reference_image` trong khối
  `characters` của storyboard.
- **Hồ sơ nhân vật (Character Bible)**: các trường mô tả cố định — giới tính thể hiện, tuổi, màu
  da, tóc, khuôn mặt, đặc điểm nhận dạng, trang phục, dáng người, phụ kiện, bảng màu, điều cấm.
  Sửa ở menu **Nhân vật**, hoặc ghi trong storyboard (`character_hair`, `character_outfit`,
  `character_face`, …).

Tool làm gì:

- Nhân vật chưa có ảnh **và** chưa có một chữ mô tả nào → trang Nhập nhắc
  `character_needs_reference`, và video đó **BỊ CHẶN** ở dự toán với lý do "Không thể vẽ nhất
  quán: <tên> — chưa có ảnh tham chiếu VÀ chưa có một chữ nào mô tả ngoại hình". Các video khác
  trong lô vẫn chạy được (V1.2 Final QA đã sửa lỗi trước đây làm hỏng cả lô).
- Tool **không tự tạo ảnh nhân vật** và không tự đổi người giữa các cảnh.
- Nhân vật đã có trong menu Nhân vật **không bị storyboard ghi đè**.
- Nếu **mọi cảnh đã có ảnh nhập**, tool không vẽ nhân vật nữa — nhất quán là do ảnh của bạn.

---

## C. Chuyển động

### 11. LOCAL_MOTION là gì

Cảnh dùng **ảnh tĩnh + chuyển động máy quay nhẹ** (đẩy vào chậm, v.v.) làm bằng FFmpeg **ngay
trên máy bạn**. Chi phí API = **$0**, không phụ thuộc nhà cung cấp, không thể "hỏng phía nhà cung
cấp". Hợp với: cảnh giải thích, cảnh phản ứng, cảnh chốt, thẻ chữ, cảnh sản phẩm tĩnh.

LOCAL_MOTION **bắt buộc có ảnh** (ảnh nhập hoặc ảnh tạo).

### 12. VIDEO_AI là gì

Cảnh được gửi tới một model **Video AI** (ví dụ `runway/h3_max:768x1280`) để tạo clip có chuyển
động thật, **dựng từ chính ảnh của cảnh**. Tính phí theo giây. Hợp với: hành động, nhiều nhân vật
cùng cử động, cảnh "hook" ở đầu.

### 13. Tool tự chọn LOCAL_MOTION / VIDEO_AI thế nào

- `motion_mode: LOCAL_MOTION` hoặc `VIDEO_AI` trong storyboard = **mệnh lệnh**, tool làm đúng thế.
- `motion_mode: AUTO` (hoặc bỏ trống) = tool quyết định theo **chế độ video** (Cài đặt → "Chế độ
  video mặc định") và **priority** của cảnh:

| Chế độ | Cảnh `priority: HIGH` | Cảnh `LOW` | Cảnh khác |
|---|---|---|---|
| Tiết kiệm | LOCAL_MOTION | LOCAL_MOTION | LOCAL_MOTION |
| **Cân bằng** (mặc định) | VIDEO_AI | LOCAL_MOTION | VIDEO_AI nếu có chuyển động đáng kể, LOCAL nếu cảnh đơn giản |
| Chất lượng | VIDEO_AI | LOCAL nếu cảnh đơn giản | VIDEO_AI |

  Ngoại lệ ở mọi chế độ: cảnh hành động phức tạp có từ 2 nhân vật → VIDEO_AI.
- Còn **model** Video AI nào: nếu cảnh ghim `video_provider` + `video_model` thì dùng đúng model
  đó. Không ghim thì router chỉ được **tự chọn** `runway/h3_max:768x1280` cho cảnh `priority: LOW`
  động tác nhỏ có ảnh, và chỉ khi bạn tick đồng ý LOW_AUTO lúc duyệt. Trường hợp khác không có
  model → video BỊ CHẶN với lý do rõ, không có gì được mua.
- Model trả phí phải được **cho phép** ở trang **Nhà cung cấp AI** (nút **CHO PHÉP GỌI API THẬT**
  của model). Chưa cho phép → dự toán báo "Chưa xác nhận giá cho …".

Ngân sách **không** đổi quyết định chuyển động: thiếu tiền thì tool báo "Thiếu $X", không âm thầm
hạ cảnh xuống LOCAL.

### 14. Khi nào nên dùng Video AI

- Cảnh đầu (3 giây đầu) cần giữ người xem.
- Cảnh có hành động / nhiều nhân vật cử động.
- Cảnh "punchline" mà ảnh tĩnh nhìn như trình chiếu.

### 15. Khi nào nên giữ LOCAL_MOTION để tiết kiệm

- Cảnh giải thích, cảnh có chữ, cảnh sản phẩm, cảnh chốt / kêu gọi hành động.
- Cảnh chỉ có một người đứng nói.
- Khi ngân sách thấp: ghi `motion_mode: LOCAL_MOTION` cho mọi cảnh trừ 2–4 cảnh quan trọng nhất.

Quy tắc ngón tay: **video 10–16 cảnh thường chỉ cần 2–4 cảnh VIDEO_AI**.

---

## D. Tiền

### 16. Preflight là gì

Bước **kiểm tra & dự toán** trước khi chạy, **miễn phí**, làm lại bao nhiêu lần cũng được. Nó
trả lời: video nào chạy được, video nào bị chặn và vì sao, cần mua gì, mỗi thứ bao nhiêu tiền, cái
gì dùng lại được miễn phí. Trên trang lô là khối **Kiểm tra & dự toán**.

### 17. Cách đọc dự toán

Khối **Kiểm tra & dự toán** trên trang lô:

| Ô | Nghĩa |
|---|---|
| TỔNG VIDEO · SẴN SÀNG · BỊ CHẶN · ĐÃ XONG | Đếm video theo tình trạng |
| DÙNG LẠI | Asset đã có, dùng lại **$0** |
| ẢNH NHẬP | Ảnh bạn đưa vào — **$0** |
| CẢNH LOCAL | Cảnh LOCAL_MOTION — **$0** |
| ẢNH AI CẦN TẠO · CLIP VIDEO AI · GIỌNG CẦN TẠO | Những thứ **sẽ mua** |
| RENDER TẠI MÁY | Video chỉ cần render ($0) |
| VIDEO $0 | Video không cần mua gì |
| CHI PHÍ CẦN | Tổng tiền phải mua cho phần sẵn sàng |
| QA TRẢ PHÍ (TUỲ CHỌN) | Chấm chất lượng bằng AI — **mặc định tắt**, không cộng vào tổng |
| DỰ PHÒNG THỬ LẠI | Khoản dự phòng nếu một request phải thử lại |
| ĐỀ XUẤT DUYỆT | Số nên gõ khi duyệt |
| HẠN MỨC TOÀN CỤC CÒN | Phần còn lại của hạn mức toàn ứng dụng |
| TRẦN LÔ ĐÃ DUYỆT | Đã duyệt bao nhiêu cho lô này |

Không đủ tiền → khung vàng **"Thiếu $X để chạy toàn bộ lô"** kèm các lựa chọn (chạy video $0
trước, chạy phần vừa ngân sách, tự sửa cảnh, tăng hạn mức). Tool **không** tự chọn thay bạn.

Mỗi thẻ video còn ghi "Dự toán thêm $X", "dùng lại tiết kiệm $Y", model Video AI và giọng sẽ dùng.

**Ở Mock Mode**, các con số là **giá giả lập** — không phải tiền thật. Ô kiểm tra duyệt ghi rõ
"MOCK — không tốn tiền thật".

### 18. Global Spend Limit

**Hạn mức toàn cục**: trần của **toàn bộ ứng dụng**, cộng mọi lô, mọi nhà cung cấp. Không lô nào
vượt được. Chỉ **bạn** đổi được, ở **Cài đặt** → ô "Hạn mức mới (USD)" → **Lưu hạn mức…** →
**XÁC NHẬN**. Nâng hạn mức **không** chạy lô nào. Hạn mức không thể đặt thấp hơn số đã chi.

### 19. Batch Limit

**Trần lô**: số tiền **bạn gõ** khi DUYỆT & CHẠY. Lô không tiêu quá số này. Muốn thêm → DUYỆT
THÊM & CHẠY với số tiền mới (trần tăng **đúng** số bạn gõ).

### 20. Video Limit

**Trần mỗi video**: `max_cost` của video trong storyboard, hoặc "Trần chi MỖI VIDEO" lúc nhập,
hoặc mặc định trong Cài đặt ("DEFAULT MAX COST / VIDEO"). Video vượt trần → **riêng video đó** BỊ
CHẶN với lý do `VIDEO_LIMIT_EXCEEDED`; các video khác vẫn chạy.

### 21. Scene Limit

**Trần mỗi cảnh**: `max_cost` của cảnh, hoặc mặc định cho cảnh VIDEO_AI trong Cài đặt ("DEFAULT
MAX COST / VIDEO AI SCENE", để trống = không giới hạn). Cảnh vượt → `SCENE_LIMIT_EXCEEDED`, tool
**không đổi model, không tạo clip**.

Một request trả phí phải qua **đủ bốn lớp**: cảnh → video → lô → toàn cục. Tiền được **giữ chỗ**
trước mỗi request; hai lô chạy cùng lúc không thể cùng tiêu phần còn lại.

### 22. Duyệt chi phí

Trên trang lô, khung **DUYỆT & CHẠY** (lô chưa duyệt) hoặc **DUYỆT THÊM & CHẠY** (lô đã duyệt
một phần):

1. Chọn phạm vi: **Tất cả video sẵn sàng** / **Video chưa được duyệt**, hoặc **Video đã chọn**
   (tick ô vuông trên thẻ video).
2. Gõ **Chi tối đa ($)**.
3. Bấm **KIỂM TRA VỚI SỐ NÀY**: tool báo "N video sẽ chạy · dự toán $X · POST ảnh/video/giọng
   a/b/c", model video sẽ dùng, và từng điều kiện chưa đạt (đỏ). Không video nào vừa số tiền →
   báo "Không video nào vừa số tiền này" và khoá nút.
4. Tick **Tôi đồng ý chi tối đa $X cho N video này** (và ô LOW_AUTO nếu có).

### 23. DUYỆT & CHẠY

Bấm **DUYỆT & CHẠY — MAX $X** (hoặc **DUYỆT THÊM & CHẠY — MAX $X**). Đây là **bước duy nhất**
tiêu tiền. Bấm hai lần không duyệt hai lần (lần thứ hai bị từ chối "đang duyệt lô này").

**CHẠY VIDEO $0 TRƯỚC (N)**: chạy ngay các video không cần mua gì, với trần **$0** — không request
trả phí nào đi qua được, kể cả khi có lỗi. Không hỏi xác nhận vì không tốn tiền.

---

## E. Chạy và theo dõi

### 24. Queue

Thứ tự chạy trong lô: **video $0 → video LOCAL → video có ảnh/giọng trả phí → video có Video AI**.
Trong một video: ảnh → clip → giọng từng cảnh, render sau cùng.

Xem ở: khối **Hàng đợi** cuối trang lô (video, trạng thái, bước hiện tại, cảnh, thời gian, trần
duyệt, chi thật), khối Hàng đợi trên **Làm việc hằng ngày**, và menu **Hàng đợi** (mọi lô).

Số video chạy song song đặt ở Cài đặt (**MAX CONCURRENT VIDEOS**, mặc định 1). **Khuyên giữ 1**.

### 25. Theo dõi tiến trình nhiều video

Trang lô tự làm mới mỗi 3 giây khi có video đang chạy. Mỗi thẻ video có **trạng thái** và dòng
"▶ bước hiện tại". Đổi **Thẻ / Bảng**, lọc theo trạng thái, hoặc "Chỉ video $0 chưa xong".

| Trạng thái | Nghĩa |
|---|---|
| NHÁP | Mới tạo |
| CẦN KIỂM TRA | Chưa dự toán được — đọc lý do |
| SẴN SÀNG | Chạy được |
| ĐANG CHỜ | Chưa nằm trong phần đã duyệt, hoặc đang xếp hàng |
| ĐANG TẠO | Đang tạo ảnh/clip/giọng |
| ĐANG RENDER | Đang ghép MP4 |
| HOÀN THÀNH | Có MP4; nhãn **SẴN SÀNG ĐĂNG** khi qua kiểm tra xuất (mục 41) |
| CẦN XỬ LÝ | Có việc bạn phải làm (bị gián đoạn, giọng hỏng, …) |
| BỊ CHẶN | Không chạy được cho tới khi sửa lý do |

### 26. PARTIAL mode

Chế độ lô **PARTIAL — video lỗi không chặn video khác** (mặc định): video lỗi / bị chặn đứng lại,
video khác vẫn chạy. Lô kết thúc **Hoàn thành (có video lỗi)** nếu có video xong và có video lỗi.

### 27. STRICT mode

**STRICT — có video bị chặn thì không bắt đầu**: nếu lô có bất kỳ video BỊ CHẶN nào, tool từ chối
duyệt/chạy (`STRICT_MODE_BLOCKED: N video bị chặn — sửa, hoặc đổi lô sang PARTIAL`). Dùng khi bạn
muốn cả lô đủ bộ hoặc không gì cả. Không đổi chế độ được khi lô đã duyệt hoặc đang chạy.

### 28. Video BLOCKED

Video **BỊ CHẶN** không chạy và không tốn đồng nào. Lý do hiện ngay trên thẻ, ví dụ:

- `VIDEO_LIMIT_EXCEEDED` / `SCENE_LIMIT_EXCEEDED` — vượt trần (mục 20, 21).
- "Không thể vẽ nhất quán: …" — nhân vật thiếu tham chiếu (mục 10).
- "Chưa xác nhận giá cho …" — model chưa được cho phép (mục 13).
- `INVALID_VOICE_ASSET` — file giọng hỏng (mục 29).

Sửa lý do (sửa storyboard rồi nhập lại, thêm ảnh nhân vật, cho phép model…) rồi dự toán lại.

### 29. NEEDS_ATTENTION (CẦN XỬ LÝ)

Video cần bạn quyết định. Hay gặp:

- **Bị gián đoạn** (mục 30) — bấm TIẾP TỤC.
- **Giọng hỏng**: file giọng < 1 KB hoặc bị đánh dấu INVALID → "Cần tạo lại giọng — có thể phát
  sinh chi phí". Tool **không tự gọi TTS**; RENDER LẠI bị từ chối để tránh video câm. Nút tạo lại
  ghi rõ **TẠO LẠI — CÓ THỂ PHÁT SINH CHI PHÍ** và luôn hỏi duyệt giá.

Video đã HOÀN THÀNH mà sau đó phát hiện vấn đề vẫn giữ MP4, nhưng hiện CẦN XỬ LÝ.

### 30. INTERRUPTED

Nếu ứng dụng bị tắt (hay máy khởi động lại) khi video đang tạo/render, lần mở sau tool tự đánh
dấu video đó **INTERRUPTED → CẦN XỬ LÝ** và **không gửi request nào**. Mọi thứ đã làm xong (ảnh,
clip, giọng) vẫn còn. Video đã xong vẫn là HOÀN THÀNH; video bị chặn vẫn bị chặn.

Request trả phí đang gửi dở lúc tắt máy (nếu có) được giữ ở trạng thái **cần kiểm tra**, không tự
gửi lại.

### 31. Cách TIẾP TỤC

- **TIẾP TỤC** trên thẻ video (một video), hoặc **TIẾP TỤC TẤT CẢ** trên khối dự toán.
- Tool lập kế hoạch từng video và tóm tắt: "N video $0 · M cần thêm $X · K bị chặn".
- Phần **$0** chạy ngay. Phần **trả phí** luôn hỏi đúng số tiền trước.
- Nút trên thẻ ghi rõ: **THỬ LẠI BƯỚC MIỄN PHÍ** (không mua gì) hoặc **TẠO LẠI — CÓ THỂ PHÁT SINH
  CHI PHÍ**.

### 32. Resume không mua lại asset đã có

TIẾP TỤC chỉ làm **phần còn thiếu**: ảnh, clip, giọng đã có và còn hợp lệ được dùng lại, không
POST lại, không giữ chỗ tiền lần hai. Video chỉ thiếu MP4 → render lại tại máy, $0. Mỗi request
có khoá chống trùng, nên bấm TIẾP TỤC nhiều lần cũng không mua hai lần.

---

## F. Asset

### 33. Asset Reuse

Mọi ảnh/clip/giọng đã tạo được nhận diện bằng **nội dung** (hash) và **tham số** tạo ra nó. Lần sau
cần đúng thứ đó (cùng prompt, model, ảnh gốc, lời thoại, giọng…) → **dùng lại, $0**, không đi qua
cổng chi tiền. Nhập lại cùng storyboard → 0 request ảnh/clip/giọng.

Đổi một thứ thì chỉ phần phụ thuộc bị làm lại: đổi lời thoại → chỉ giọng cảnh đó; đổi phụ đề →
không gì phải mua; đổi ảnh cảnh VIDEO_AI → clip cảnh đó.

Phạm vi dùng lại ở Cài đặt → **Phạm vi tái sử dụng**: GLOBAL (mọi dự án, mặc định) · PROJECT ·
SCENE.

### 34. Thư viện Assets

Menu **Thư viện asset**: danh sách mọi ảnh/clip/giọng/MP4 với loại, nguồn (GENERATED / IMPORTED /
REUSED / LOCAL), tình trạng, provider/model, kích thước, ai đang dùng. Mở một asset để xem chi tiết,
chi phí gốc (có đối chiếu sổ chi) và chuỗi phụ thuộc. Đầu trang: **API COST SAVED** (tiền không phải
chi nhờ dùng lại) và **STORAGE DEDUPLICATED** (dung lượng tiết kiệm) — hai con số khác nhau.

Không có nút xoá asset. Asset đang được dùng không thể xoá.

### 35. Missing / Invalid / Legacy / Orphan

| Tình trạng | Nghĩa | Tool làm gì |
|---|---|---|
| HEALTHY | File còn, đúng nội dung | Dùng lại được |
| MISSING | File mất (hoặc bị file khác cùng tên ghi đè) | Không dùng lại giả; khi chạy sẽ tạo lại (có thể tốn phí, dự toán báo) |
| INVALID | File hỏng / đổi nội dung | **Không dùng lại** |
| LEGACY_UNVERIFIED | Asset cũ thiếu bằng chứng tham số | Chỉ dùng trong chính cảnh đó, không dùng xuyên dự án |
| ORPHAN_CANDIDATE | Không ai tham chiếu | Chỉ báo cáo, **không xoá** |

Kiểm tra bằng lệnh (chỉ đọc): `npm run assets:health`.
Dọn file tạm (xem trước, không xoá): `npm run assets:cleanup -- --dry-run`. Chỉ thêm `--apply`
khi bạn đã đọc danh sách và muốn xoá các file **SAFE** (file tạm quá hạn).

---

## G. Thành phẩm

### 36. Voice

Lời trong `dialogue` / `narration` được đọc bằng Voice AI (TTS, tính phí; ở Mock Mode là giọng giả
lập). Giọng theo nhân vật nói. Giọng đã tạo được **dùng lại** nếu lời và cài đặt giọng không đổi.

**Nhịp theo giọng**: độ dài cảnh được chỉnh theo độ dài giọng thật (`duration_mode`):
`AUTO` (giọng + khoảng đệm), `MINIMUM` (không ngắn hơn kế hoạch), `LOCKED` (giữ kế hoạch, chỉ nâng
lên nếu giọng dài hơn — giọng không bao giờ bị cắt). Việc này cắt/ghép tại máy, không tốn request.

### 37. Subtitle

Phụ đề lấy từ `subtitle` (hoặc lời thoại). Theo preset: **in lên video**, **file SRT**, cả hai,
hoặc không. File `subtitles.srt` chỉ có khi video **có lời** (video câm không có SRT rỗng). SRT là
UTF-8, tiếng Việt có dấu đúng.

Trang chi tiết video có **Vùng an toàn**: cảnh báo nếu dòng phụ đề dài chạm vùng nút của Shorts/
TikTok/Reels. Chỉ cảnh báo, không tự sửa.

### 38. Render MP4

Ghép tại máy bằng FFmpeg: H.264 + AAC. Preset (chọn ở trang lô, khối **Preset đầu ra**):

| Preset | Khung |
|---|---|
| YouTube Shorts (mặc định) | 1080x1920 · 30 fps |
| TikTok | 1080x1920 · 30 fps |
| Instagram Reels | 1080x1920 · 30 fps |
| YouTube ngang 16:9 | 1920x1080 · 30 fps |
| Tuỳ chỉnh | Cài đặt → Preset tuỳ chỉnh |

Đổi preset chỉ **render lại tại máy ($0)** — không tạo lại ảnh/clip/giọng. Video đã xong: bấm
**RENDER LẠI**. Render với cùng đầu vào không chạy lại vô ích.

### 39. Thumbnail

`thumbnail.jpg` mặc định là một khung hình từ MP4. Trang chi tiết video cho phép **chọn ảnh của một
cảnh** (cắt tại máy) hoặc **Tải ảnh riêng** (PNG/JPG/WEBP). Không gọi Image API. Áp dụng khi xuất
lại. Thumbnail không bị vẽ lại nếu nguồn không đổi.

### 40. metadata.json

Mỗi video có `metadata.json`: tiêu đề, mô tả, tags, hashtags, thời lượng, độ phân giải, fps, ngôn
ngữ, tỉ lệ khung, cảnh, file phụ đề, file thumbnail, **chi phí API thật** của video, số asset dùng
lại, nhà cung cấp, mã lô/video. **Không bao giờ chứa API key.**

Tiêu đề/mô tả/tags/hashtags: sửa ở trang chi tiết video (**LƯU METADATA**); để trống thì dùng **Mẫu
mô tả** trong Cài đặt (`{{title}}`, `{{summary}}`, `{{hashtags}}`, `{{tags}}`, `{{batch}}`,
`{{date}}`). Tool **không** dùng AI để viết metadata.

### 41. Output

```
data/output/<tên-lô>/<tên-video>/
  final.mp4          video để đăng
  thumbnail.jpg
  subtitles.srt      khi video có lời và preset xuất SRT
  metadata.json
  storyboard.json
  captions.txt       lời thoại, mỗi câu một dòng
  description.txt    mô tả để dán khi đăng
data/output/<tên-lô>/batch-report.csv | .json    (khi bấm XUẤT BÁO CÁO)
```

Tên thư mục không dấu, bỏ emoji/ký tự cấm, tối đa 60 ký tự; trùng tên → thêm `-2`. Tên được gán
**một lần** — đổi tiêu đề video sau đó không dời thư mục. Video cũ (trước V1.2) giữ thư mục cũ
`data/output/<tiêu đề>-<mã>/`.

**SẴN SÀNG ĐĂNG / READY TO PUBLISH** (trang chi tiết video) chỉ bật khi: có `final.mp4`, ffprobe
đọc được, thời lượng > 0, có âm thanh khi video có lời, không có đoạn đen bất thường, đủ SRT/
thumbnail/metadata theo preset, đường dẫn hợp lệ.

Tổng kết lô (cuối trang lô): số video theo nhóm, tổng thời lượng, chi API thật, cảnh LOCAL, clip
Video AI; nút **MỞ THƯ MỤC LÔ**, **XUẤT BÁO CÁO (CSV + JSON)**, **COPY DANH SÁCH VIDEO**.

### 42. MỞ THƯ MỤC

Nút **MỞ THƯ MỤC** trên thẻ video hoàn thành mở thư mục output của video đó trong Windows
Explorer, và hiện dòng "Đã mở <đường dẫn>". **MỞ THƯ MỤC LÔ** mở thư mục của cả lô.

### 43. COPY PATH

**COPY PATH** chép đường dẫn thư mục output vào clipboard. Nếu trình duyệt không cho chép (cửa sổ
không được focus, quyền clipboard bị chặn), nút đổi thành **"LỖI — chép tay đường dẫn"** và hiện
đường dẫn để bạn tự chọn và chép. Tương tự: **COPY TITLE**, **COPY DESCRIPTION** (trang chi tiết).

---

## H. Quản trị

### 44. Dashboard chi phí

Menu **Chi phí**: chi API thật hôm nay / tuần / tháng / toàn bộ, chi phí ước tính, chi phí mock
(tách riêng, luôn là giả lập), hạn mức còn lại, chi phí theo giai đoạn (ảnh, video, giọng, text),
theo nhà cung cấp, theo model. **Chỉ tiền thật** được cộng vào "chi API thật"; mock và ước tính
không bao giờ bị cộng vào.

Trên trang lô, "Chi thật" của mỗi video là tiền **thật** đã ghi sổ — không phải số duyệt.

### 45. Xem số dư Runway

Thẻ **RUNWAY CREDIT** trên **Tổng quan** và **SỐ DƯ RUNWAY** trên **Làm việc hằng ngày**. Số hiện
thường là **CACHE** (đọc lần trước, có ghi giờ). Nút **REFRESH BALANCE** đọc lại số dư thật từ
Runway — một lệnh đọc **miễn phí**, không tạo gì. Quy đổi của app: 100 credit = $1.

OpenAI không có cách đọc số dư miễn phí; app dùng số bạn khai báo.

### 46. Settings

Menu **Cài đặt**:

- **Hạn mức toàn cục** (mục 18).
- **Mặc định cho dự án mới**: chế độ tạo, thời lượng mục tiêu, ngân sách tối đa.
- **Trần chi mặc định (nâng cao)**: DEFAULT MAX COST / VIDEO, DEFAULT MAX COST / VIDEO AI SCENE.
- **Phạm vi tái sử dụng** (mục 33).
- **Chấm chất lượng bằng AI TRẢ PHÍ** — mặc định **TẮT**.
- **Hàng đợi công việc**: số job song song, số lần thử lại tối đa.
- **Render**: in phụ đề lên video.
- **Dọn dẹp media**: số ngày giữ file tạm / file của job thất bại.
- **Sản xuất hằng ngày**: preset đầu ra mặc định, chế độ lô mặc định (PARTIAL/STRICT), MAX
  CONCURRENT VIDEOS (1–4), MAX CONCURRENT LOCAL RENDERS (1–2), MAX CONCURRENT PAID REQUESTS (1–2),
  mẫu mô tả → **LƯU CÀI ĐẶT HẰNG NGÀY**. **Preset tuỳ chỉnh** → **LƯU PRESET**.
- **Môi trường** (chỉ xem): chế độ mock, thư mục dữ liệu, FFmpeg.

Không sửa được trên giao diện (phải sửa file `.env` rồi khởi động lại): `AI_MOCK_MODE`, API key,
`SECRET_ENCRYPTION_KEY`, `DATA_DIR`. API key cũng có thể nhập ở trang **Nhà cung cấp AI** nếu đã
đặt `SECRET_ENCRYPTION_KEY`.

### 47. Cách đặt hạn mức an toàn

- Đặt **hạn mức toàn cục** chỉ cao hơn số đã chi một khoản bạn **chấp nhận mất** trong tuần.
- Khi duyệt lô, gõ **đúng ĐỀ XUẤT DUYỆT** hoặc thấp hơn, không gõ số tròn lớn "cho chắc".
- Đặt `max_cost` cho mỗi video trong storyboard (ví dụ 0,60) và để Cài đặt có DEFAULT MAX COST /
  VIDEO AI SCENE (ví dụ 0,45) để một cảnh không thể ăn hết tiền của video.
- Luôn bấm **CHẠY VIDEO $0 TRƯỚC** trước, rồi mới duyệt phần trả phí.
- Giữ MAX CONCURRENT PAID REQUESTS = 1.

### 48. Xử lý lỗi phổ biến

| Bạn thấy | Làm gì |
|---|---|
| Trang Nhập báo lỗi đỏ | Đọc mã lỗi + vị trí (video, cảnh), sửa file, KIỂM TRA lại |
| "Thiếu $X để chạy toàn bộ lô" | Chạy video $0 trước; chạy phần vừa ngân sách; đổi cảnh sang LOCAL_MOTION; hoặc tự nâng hạn mức |
| Video BỊ CHẶN | Đọc lý do trên thẻ (mục 28) |
| "Không thể vẽ nhất quán: …" | Thêm ảnh tham chiếu hoặc hồ sơ cho nhân vật đó (menu Nhân vật), dự toán lại |
| "Chưa xác nhận giá cho …" | Trang Nhà cung cấp AI → CHO PHÉP GỌI API THẬT cho model đó (chỉ khi bạn muốn trả tiền cho nó) |
| CẦN XỬ LÝ sau khi tắt máy | TIẾP TỤC (mục 31) |
| "Cần tạo lại giọng — có thể phát sinh chi phí" | Giọng hỏng; tạo lại là việc trả phí — chỉ làm khi bạn đồng ý |
| COPY PATH báo lỗi | Chép tay đường dẫn hiện bên cạnh |
| Log có "Socket timeout" (SQLite bận) | Lô vẫn chạy tiếp; video nào lỗi thì bấm TIẾP TỤC. Nếu gặp thường xuyên, xem mục dưới |
| App không khởi động | `npm run doctor` |

**SQLite "Socket timeout" trên Windows.** Khi lô đang chạy và trang lô mở, cơ sở dữ liệu có thể bận
một lúc; một truy vấn chờ quá lâu sẽ báo "Socket timeout". V1.2 đã bỏ phần lớn nguyên nhân (trang lô
không còn ghi vào DB mỗi lần tự làm mới). Nếu bạn **vẫn gặp thường xuyên**, có thể cho truy vấn chờ
lâu hơn bằng cách thêm `?socket_timeout=60` vào cuối dòng `DATABASE_URL` trong file `.env`, ví dụ:

```
DATABASE_URL="file:../data/app.db?socket_timeout=60"
```

rồi khởi động lại app. Đây là thay đổi **tuỳ chọn**, bạn tự sửa trong `.env` của mình (file này chứa
API key — **không bao giờ** commit hay gửi cho ai). Bộ test tự động của dự án đã dùng đúng cài đặt
này.

Thêm: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

### 49. Không được làm gì khi batch đang chạy

- **Không tắt** cửa sổ PowerShell / không tắt máy. (Nếu lỡ: mục 30 — không mất gì đã xong.)
- **Không** di chuyển, đổi tên, xoá thư mục `data/` hay file trong `data/projects/`.
- **Không** mở `final.mp4` đang được ghi trong trình phát (Windows khoá file; tool sẽ báo lỗi
  nêu tên file).
- **Không** chạy `npm run backup`, `assets:cleanup --apply` hay sửa `.env`.
- **Không** đổi hạn mức toàn cục cho "nhanh" — lô đang chạy vẫn kiểm lại hạn mức trước mỗi request.
- Muốn dừng: nút **DỪNG LÔ** ở đầu trang lô (chỉ hiện khi lô đang chạy). Video chưa bắt đầu dừng
  sạch; request đã gửi vẫn được theo dõi tới kết quả (không hoàn tiền giả).

### 50. Backup / recovery cơ bản

1. **Tắt app** (`Ctrl + C`).
2. `npm run backup` → tạo `backups\<ngày-giờ>\` gồm `data/` + cấu hình + `RESTORE.txt`.
3. Khôi phục: làm theo `RESTORE.txt` trong bản sao lưu (chép `data/` trở lại khi app đã tắt).

Sao lưu trước: khi cập nhật phiên bản, trước khi chạy lệnh dọn dẹp `--apply`, mỗi tuần.
Chi tiết: [BACKUP.md](BACKUP.md).

---

## I. Quy trình

### 51. Quy trình làm video hàng loạt hằng ngày

1. Chuẩn bị thư mục storyboard + ảnh cho mỗi video (mục 7, 9).
2. `npm start` → mở **Làm việc hằng ngày**.
3. **TẠO LÔ VIDEO** → kéo thư mục → **KIỂM TRA** → sửa lỗi đỏ → **DỰ TOÁN & TẠO LÔ**.
4. Mở lô. Chọn **Preset đầu ra** và **Chế độ lô**.
5. Đọc **Kiểm tra & dự toán** và lý do của video BỊ CHẶN.
6. **CHẠY VIDEO $0 TRƯỚC**.
7. **DUYỆT & CHẠY** phần trả phí: gõ số tiền → KIỂM TRA VỚI SỐ NÀY → tick đồng ý → bấm.
8. Theo dõi thẻ video / Hàng đợi.
9. Video CẦN XỬ LÝ → **TIẾP TỤC**.
10. Mở **CHI TIẾT** từng video: metadata, thumbnail, vùng an toàn, **READY TO PUBLISH**.
11. **MỞ THƯ MỤC** → đăng tay `final.mp4` + `description.txt`.
12. Cuối ngày: **XUẤT BÁO CÁO (CSV + JSON)**.

### 52. Quy trình tối ưu chi phí

1. **Ảnh có sẵn cho mọi cảnh** → Image API $0.
2. **LOCAL_MOTION mặc định**, VIDEO_AI chỉ cho 2–4 cảnh quan trọng mỗi video.
3. **Ghim** model Video AI đã biết giá (`video_provider` + `video_model`), đặt `max_cost` cho cảnh
   VIDEO_AI.
4. Câu thoại gọn — giọng tính theo độ dài; subtitle sửa thoải mái (không tốn tiền).
5. Giữ **Chấm chất lượng AI trả phí** TẮT.
6. Nhập lại / sửa nhỏ storyboard thay vì tạo lô mới từ đầu → asset cũ được **dùng lại**.
7. Chạy **video $0 trước**; duyệt đúng **ĐỀ XUẤT DUYỆT**.
8. Cuối ngày xem **Chi phí** và **tiết kiệm nhờ dùng lại**.

### 53. Checklist trước khi bấm DUYỆT & CHẠY

- [ ] Dòng trên cùng: đúng chế độ bạn muốn (mock hay thật).
- [ ] ẢNH AI CẦN TẠO = 0 nếu bạn đã có ảnh cho mọi cảnh.
- [ ] Số CLIP VIDEO AI đúng như bạn định.
- [ ] Đọc lý do mọi video BỊ CHẶN.
- [ ] Đã chạy CHẠY VIDEO $0 TRƯỚC.
- [ ] KIỂM TRA VỚI SỐ NÀY: không còn dòng đỏ; số POST ảnh/video/giọng hợp lý.
- [ ] Model video hiển thị đúng model bạn đã chọn.
- [ ] Số tiền gõ ≤ ĐỀ XUẤT DUYỆT và ≤ HẠN MỨC TOÀN CỤC CÒN.
- [ ] Không có lô khác đang chạy mà bạn không theo dõi.

### 54. Checklist sau khi video hoàn thành

- [ ] Thẻ ghi **HOÀN THÀNH** + **SẴN SÀNG ĐĂNG**.
- [ ] CHI TIẾT → READY TO PUBLISH: mọi dòng ✓.
- [ ] **PHÁT VIDEO**: xem hết một lượt — hình, tiếng, phụ đề khớp.
- [ ] Cảnh báo **Vùng an toàn**: phụ đề không bị nút che.
- [ ] Thumbnail đúng ý (đổi nếu cần → xuất lại).
- [ ] Tiêu đề / mô tả / hashtags → **LƯU METADATA**.
- [ ] **MỞ THƯ MỤC**: có `final.mp4`, `thumbnail.jpg`, `metadata.json`, `description.txt`
      (và `subtitles.srt` nếu video có lời).
- [ ] "Chi thật" của video đúng mức bạn chờ đợi.
- [ ] Đăng tay lên nền tảng.
