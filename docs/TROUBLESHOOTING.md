# Xử lý sự cố

Trước tiên, luôn chạy:

```powershell
npm run doctor
```

Lệnh này kiểm tra Node, FFmpeg, `.env`, mẫu prompt và cơ sở dữ liệu, rồi nói rõ
từng vấn đề cần sửa thế nào.

---

## Cài đặt

### `npm install` báo `ECONNRESET`

Lỗi mạng tạm thời, thường xảy ra khi tải gói FFmpeg (khá nặng). Chạy lại:

```powershell
npm install --fetch-retries=8 --fetch-timeout=600000
```

### `npm install` báo `EPERM ... rmdir`

Có tiến trình đang giữ tệp trong `node_modules`. Đóng trình soạn thảo và mọi cửa
sổ đang chạy `npm run dev`, rồi thử lại.

---

## FFmpeg

### "Không tìm thấy FFmpeg"

Thứ tự tìm kiếm: `FFMPEG_PATH` → `PATH` hệ thống → bản đi kèm trong
`node_modules/ffmpeg-static`.

```powershell
npm install          # tải lại bản đi kèm
# hoặc cài riêng:
winget install Gyan.FFmpeg
```

Nếu đã cài riêng, mở **PowerShell mới** rồi kiểm tra `ffmpeg -version`.

### Phụ đề không hiện trên video

Bản FFmpeg đang dùng thiếu libass. Kiểm tra:

```powershell
npm run doctor
```

Dòng "Bộ lọc subtitles (libass)" sẽ báo. Ứng dụng vẫn xuất tệp `.srt` riêng, chỉ
là không ghi được lên hình. Cài bản FFmpeg đầy đủ để khắc phục.

### Render rất chậm

Bình thường: mã hoá H.264 ở 1080x1920 tốn CPU. Một video 25 giây mất khoảng
30–90 giây tuỳ máy.

Nếu chậm bất thường, kiểm tra số job song song trong trang Cài đặt — chạy nhiều
tiến trình FFmpeg cùng lúc khiến tất cả cùng chậm.

---

## Cơ sở dữ liệu

### "Không kết nối được SQLite"

```powershell
npm run db:push
```

Kiểm tra `DATABASE_URL` trong `.env`. Mặc định là `file:../data/app.db`, tính từ
thư mục `prisma/`.

### Thư viện thành ngữ trống

```powershell
npm run seed
```

### Giá mô hình bị về 0 sau khi cập nhật

`npm run seed` cố ý **không** ghi đè giá của nhà cung cấp thật, vì đó là dữ liệu
của bạn. Chỉ các mô hình `mock-*` được đặt lại về giá mô phỏng của ứng dụng.

Nếu giá thật bị mất, nhập lại trong trang Mô hình AI.

---

## Hàng đợi

### Job kẹt ở trạng thái "Đang xử lý"

Ứng dụng bị tắt giữa chừng. Khởi động lại — worker tự đưa các job dở về hàng đợi
khi khởi động.

### Thanh trạng thái báo "worker đang tắt"

Kiểm tra `JOB_WORKER_ENABLED` trong `.env` (phải là `true` hoặc để trống), rồi
khởi động lại.

### Không có gì xảy ra sau khi bấm TẠO MEDIA

Mở trang **Nhật ký**. Nếu job ở trạng thái `failed`, cột lỗi sẽ nói vì sao. Các
nguyên nhân thường gặp:

- Ước tính vượt ngân sách tối đa (ứng dụng sẽ báo ngay, không đưa job vào hàng đợi)
- Không có mô hình nào được bật cho loại đó → trang Mô hình AI
- Đã tắt chế độ mock nhưng nhà cung cấp thật chưa được tích hợp

---

## Tạo nội dung

### "Không có mô hình video nào đáp ứng yêu cầu của cảnh này"

Router đã loại hết mô hình. Thường vì:

- thời lượng cảnh vượt `maxDuration` của mọi mô hình đang bật,
- cảnh có 2 nhân vật nhưng không mô hình nào hỗ trợ tham chiếu nhân vật,
- mọi mô hình phù hợp đều đang tắt.

Sửa trong trang Mô hình AI, hoặc rút ngắn cảnh trong storyboard.

### "Chi phí ước tính ... vượt ngân sách tối đa"

Đúng như thiết kế. Chọn một trong các cách ứng dụng gợi ý: đổi chế độ, ghim mô
hình rẻ hơn cho cảnh đơn giản, rút ngắn video, hoặc tăng ngân sách.

### Kịch bản trùng ý tưởng cũ

Ứng dụng đã tự chặn: nó theo dõi góc hài đã dùng cho từng thành ngữ và sinh lại
nếu trùng. Nếu vẫn muốn ép, xoá dòng tương ứng trong bảng `ConceptHistory` bằng
`npx prisma studio`.

### Nhân vật đổi ngoại hình giữa các cảnh

Ở chế độ mock thì không xảy ra. Với nhà cung cấp thật: kiểm tra trang Nhân vật —
`visualPrompt` phải chi tiết và cố định, và mô hình được chọn phải bật
`supportsCharacterReference`. Chế độ Tiết kiệm bỏ qua ảnh keyframe cho cảnh đơn
giản, và keyframe chính là công cụ giữ nhất quán mạnh nhất.

---

## Giao diện

### Trang trắng sau khi sửa mã

```powershell
Remove-Item -Recurse -Force .next
npm run dev
```

### Video không phát trong trình duyệt

Kiểm tra tệp có tồn tại: trang Media sẽ hiện nếu có. Nếu tệp có mà không phát
được, mở nó bằng một trình phát ngoài để xác định lỗi nằm ở tệp hay ở trình
duyệt.

---

## Dữ liệu

### Lỡ xoá một dự án

Không có thùng rác. Khôi phục từ bản sao lưu — xem [BACKUP.md](BACKUP.md).

Thư mục media của dự án đã xoá sẽ được `npm run cleanup` dọn đi, nên nếu muốn
cứu tệp, hãy chép chúng ra trước khi chạy lệnh dọn dẹp.

### Ổ đĩa đầy

```powershell
npm run cleanup -- --dry-run
npm run cleanup
```

Phần nặng nhất là `data/projects/*/videos/` và `*/temp/`. Video hoàn chỉnh không
bao giờ bị tự động xoá; nếu muốn dọn cả chúng, đặt `CLEANUP_FINAL_DAYS` trong
`.env` — nhưng hãy sao lưu trước.
