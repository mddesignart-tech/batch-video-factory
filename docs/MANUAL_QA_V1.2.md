# Kiểm tra tay V1.2 trên Chrome

Làm trên **Mock Mode** (`AI_MOCK_MODE=true`) để không tốn tiền. Tốt nhất dùng một bản sao dữ liệu
(xem cuối trang). Điền ✓ / ✗ vào cột "Bạn".

Cột "Tự động" là kết quả của Final QA (2026-10-01, QĐ-115) bằng trình duyệt tự động:
**ĐÃ KIỂM** = đã chạy thật qua giao diện; **CHƯA** = tự động hoá không làm được, cần bạn kiểm.

| # | Bước | Kết quả mong đợi | Tự động | Bạn |
|---|---|---|---|---|
| 1 | **Nhập Storyboard** → **kéo cả folder** storyboard (có thư mục con `video-01/`, `video-02/`) vào khung "Kéo thả vào đây" | Danh sách file hiện ra; KIỂM TRA bấm được | CHƯA (chỉ kiểm cách gõ đường dẫn) | |
| 2 | **Kéo file .zip** của cùng thư mục | Như bước 1; đường dẫn `..`/tuyệt đối trong ZIP bị từ chối | CHƯA | |
| 3 | **Chọn file (.json/.csv + ảnh, hoặc .zip)** → chọn **nhiều file JSON** cùng lúc (+ ảnh) | Mỗi JSON thành một video | CHƯA | |
| 4 | Bấm **KIỂM TRA** → xem **từng video / từng cảnh** | Mỗi video: số cảnh, ảnh có sẵn / sẽ tạo, LOCAL_MOTION / VIDEO_AI / AUTO; lỗi đỏ nêu video + cảnh; nhắc nhở vàng (ví dụ `image_will_be_generated`) | ĐÃ KIỂM (qua ô đường dẫn) | |
| 5 | **DỰ TOÁN & TẠO LÔ** → mở lô → khối **Kiểm tra & dự toán** | Số SẴN SÀNG / BỊ CHẶN đúng; video bị chặn có lý do riêng; video khác không bị ảnh hưởng | ĐÃ KIỂM | |
| 6 | Khung **DUYỆT & CHẠY**: **nhập trần** (ví dụ 0,01) → **KIỂM TRA VỚI SỐ NÀY** | "N video sẽ chạy · dự toán $X · POST ảnh/video/giọng …" + "MOCK — không tốn tiền thật"; số quá nhỏ → "Không video nào vừa số tiền này", nút bị khoá | ĐÃ KIỂM | |
| 7 | Tick đồng ý → bấm **DUYỆT & CHẠY** (hoặc DUYỆT THÊM & CHẠY) **bằng chuột**, bấm nhanh 2 lần | "Đã duyệt … và bắt đầu N video"; chỉ duyệt **một** lần | ĐÃ KIỂM bằng JavaScript; **CHƯA** bằng chuột thật | |
| 8 | Xem **Queue** (khối Hàng đợi cuối trang lô, menu Hàng đợi) | Video đổi trạng thái ĐANG TẠO → ĐANG RENDER → HOÀN THÀNH; trang tự làm mới | ĐÃ KIỂM | |
| 9 | Đang chạy thì **tắt app** (Ctrl+C) → `npm start` lại → mở lô | Video dang dở: CẦN XỬ LÝ (INTERRUPTED); log "không gửi yêu cầu nào"; video xong vẫn xong | ĐÃ KIỂM | |
| 10 | **TIẾP TỤC** video bị gián đoạn (hoặc TIẾP TỤC TẤT CẢ) **bằng chuột** | Phần $0 chạy ngay; phần trả phí hỏi giá; không tạo job trùng | ĐÃ KIỂM bằng JavaScript; **CHƯA** bằng chuột thật | |
| 11 | **Mở Output**: thẻ HOÀN THÀNH → **CHI TIẾT** | READY TO PUBLISH đủ ✓; metadata, thumbnail, vùng an toàn hiện đúng | ĐÃ KIỂM | |
| 12 | **COPY PATH** rồi dán (Ctrl+V) vào Notepad | Dán ra đúng đường dẫn `…\data\output\<lô>\<video>`; nếu clipboard bị chặn → nút ghi "LỖI — chép tay đường dẫn" và hiện đường dẫn | **CHƯA** (trình duyệt tự động chặn clipboard) | |
| 13 | **MỞ THƯ MỤC** | Windows Explorer mở đúng thư mục video; có `final.mp4`, `thumbnail.jpg`, `metadata.json`, `description.txt` (+ `subtitles.srt` nếu có lời) | ĐÃ KIỂM | |
| 14 | **PHÁT VIDEO** | MP4 phát được, có tiếng khi có lời, phụ đề tiếng Việt đúng dấu | Đã kiểm file bằng ffprobe; **CHƯA** xem bằng mắt | |
| 15 | Kiểm tra **Dashboard**: Làm việc hằng ngày + Tổng quan | Khối HÔM NAY có số; Lịch sử lô tìm được bằng chữ không dấu; số dư Runway hiện (CACHE) | ĐÃ KIỂM | |
| 16 | Kiểm tra **Settings** (chỉ xem, không lưu) | Hạn mức toàn cục, trần mặc định, phạm vi tái sử dụng, Sản xuất hằng ngày, Môi trường (mock) đều hiện | ĐÃ KIỂM (chỉ xem) | |

## Chạy kiểm tra trên bản sao (khuyên dùng)

Để không đụng dữ liệu thật, chạy app trỏ vào một bản sao:

```powershell
# một lần: chép dữ liệu
New-Item -ItemType Directory -Force data\.qa-manual | Out-Null
Copy-Item data\app.db data\.qa-manual\
Copy-Item data\projects, data\output, data\characters data\.qa-manual\ -Recurse

# chạy app trên bản sao, mock bật
$env:DATA_DIR = "$PWD\data\.qa-manual"
$env:DATABASE_URL = "file:../data/.qa-manual/app.db"
$env:AI_MOCK_MODE = "true"
npm start
```

Xong thì đóng PowerShell đó (biến môi trường mất theo) và có thể xoá `data\.qa-manual`.
