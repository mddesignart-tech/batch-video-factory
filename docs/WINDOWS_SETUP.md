# Cài đặt trên Windows

Hướng dẫn này giả định một máy Windows 10/11 chưa cài gì. Không cần Docker,
không cần WSL, không cần máy chủ cơ sở dữ liệu.

---

## 1. Cài Node.js

Tải **Node.js 20 LTS** trở lên: https://nodejs.org

Kiểm tra trong PowerShell:

```powershell
node -v    # v20.x hoặc mới hơn
npm -v
```

---

## 2. Lấy mã nguồn và cài thư viện

```powershell
cd "F:\Tool Video Youtube"
npm install
```

Lệnh này cũng tải sẵn một bản FFmpeg dùng được (gói `ffmpeg-static`), nên bạn
**không bắt buộc** phải cài FFmpeg riêng.

> Nếu `npm install` báo lỗi mạng (`ECONNRESET`), chạy lại. Gói FFmpeg khá nặng
> nên lần tải đầu có thể đứt giữa chừng.

---

## 3. FFmpeg

Ứng dụng tìm FFmpeg theo thứ tự:

1. biến `FFMPEG_PATH` trong `.env`
2. FFmpeg trong `PATH` của hệ thống
3. bản đi kèm trong `node_modules/ffmpeg-static`

Bản đi kèm đã đủ dùng. Nếu vẫn muốn cài riêng (bản mới hơn, có tăng tốc phần
cứng):

```powershell
winget install Gyan.FFmpeg
```

Rồi mở PowerShell **mới** và kiểm tra:

```powershell
ffmpeg -version
```

Hoặc trỏ thẳng trong `.env`:

```
FFMPEG_PATH="C:\\ffmpeg\\bin\\ffmpeg.exe"
FFPROBE_PATH="C:\\ffmpeg\\bin\\ffprobe.exe"
```

### Đường dẫn có dấu cách

Thư mục như `F:\Tool Video Youtube` hoạt động bình thường. Ứng dụng truyền tham
số cho FFmpeg dưới dạng mảng và sinh tiến trình với `shell: false`, nên không có
chuỗi lệnh nào cần đặt dấu ngoặc kép và cũng không có chỗ để chèn lệnh lạ.

---

## 4. Tệp cấu hình `.env`

```powershell
copy .env.example .env
```

Các giá trị quan trọng:

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | Mặc định `file:../data/app.db`. Đường dẫn tính từ thư mục `prisma/`. |
| `AI_MOCK_MODE` | `true` = không bao giờ gọi API tính phí. Giữ nguyên khi đang thử nghiệm. |
| `SECRET_ENCRYPTION_KEY` | Cần có nếu muốn lưu API key từ giao diện. |
| `JOB_CONCURRENCY` | Số job chạy song song. Giữ ở 1–2. |

Tạo khoá mã hoá:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Dán kết quả vào `SECRET_ENCRYPTION_KEY=`.

> **Không bao giờ commit tệp `.env`.** Nó đã nằm trong `.gitignore`.

---

## 5. Tạo cơ sở dữ liệu và nạp dữ liệu mẫu

```powershell
npm run setup
```

Lệnh này chạy `prisma generate`, `prisma db push` và `npm run seed`. Sau khi
xong bạn có:

- 137 thành ngữ tiếng Anh thông dụng
- 2 nhân vật (Max và Leo)
- 6 phong cách hình ảnh
- 16 mô hình AI trong bảng đăng ký
- 6 chỗ cho nhà cung cấp

`npm run seed` an toàn khi chạy lại: nó chỉ thêm những gì còn thiếu và **không**
đụng vào dự án hay chi phí của bạn.

---

## 6. Chạy ứng dụng

Chế độ phát triển:

```powershell
npm run dev
```

Bản production cục bộ (nhanh hơn):

```powershell
npm run build
npm start
```

Mở http://localhost:3000

Đổi cổng: `npm run dev -- -p 3005`

---

## 7. Kiểm tra nhanh

```powershell
npm run doctor
```

Lệnh này kiểm tra Node, quyền ghi thư mục `data/`, `.env`, mẫu prompt, FFmpeg
(kèm bộ lọc `subtitles` dùng để ghi phụ đề lên video) và cơ sở dữ liệu, rồi nói
rõ từng vấn đề cần sửa thế nào.

---

## Dữ liệu nằm ở đâu

```
F:\Tool Video Youtube\
├── data\
│   ├── app.db                    ← cơ sở dữ liệu SQLite
│   ├── characters\               ← ảnh tham chiếu nhân vật
│   ├── music\  sfx\              ← nhạc nền và hiệu ứng (tuỳ chọn)
│   └── projects\<id>\
│       ├── script\  images\  videos\  audio\
│       ├── subtitles\            ← .srt và .ass
│       ├── final\                ← MP4 hoàn chỉnh
│       └── temp\                 ← tệp trung gian, tự dọn sau 3 ngày
└── backups\                      ← do npm run backup tạo ra
```

Cơ sở dữ liệu **chỉ lưu metadata và đường dẫn**. Không có video hay ảnh nào nằm
trong SQLite, nên tệp `app.db` luôn nhỏ và sao lưu nhanh.

---

## Sao lưu

```powershell
# Dừng ứng dụng trước (Ctrl+C), rồi:
npm run backup
```

Chi tiết: [BACKUP.md](BACKUP.md)

---

## Chạy bản production như một dịch vụ

Không bắt buộc cho V1. Nếu muốn ứng dụng tự chạy khi mở máy, cách đơn giản nhất
là một tệp `.bat` đặt trong thư mục Startup:

```bat
@echo off
cd /d "F:\Tool Video Youtube"
call npm start
```

Nhấn `Win+R`, gõ `shell:startup`, rồi đặt tệp `.bat` vào đó.

---

## Xử lý sự cố

Xem [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
