# Sao lưu và khôi phục

Cố tình giữ đơn giản. Toàn bộ trạng thái nằm trong một thư mục.

---

## Cần sao lưu những gì

```
data/
├── app.db          ← cơ sở dữ liệu SQLite (nhỏ, vài trăm KB)
├── characters/     ← ảnh tham chiếu nhân vật
├── music/  sfx/    ← nhạc nền và hiệu ứng
└── projects/       ← toàn bộ media đã tạo (phần nặng nhất)

.env                ← cấu hình và API key (KHÔNG bao giờ commit)
```

Chỉ vậy. Không có trạng thái nào nằm ngoài các tệp này.

---

## Cách nhanh

```powershell
# 1. DỪNG ứng dụng (Ctrl+C ở cửa sổ đang chạy npm run dev / npm start)
# 2.
npm run backup
```

Tạo ra `backups\20260913-104500\` gồm:

```
data/            ← bản sao đầy đủ
config/          ← .env, package.json, prisma/schema.prisma
RESTORE.txt      ← hướng dẫn khôi phục
```

Lệnh này cảnh báo nếu phát hiện `app.db-wal` khác rỗng, vì đó là dấu hiệu ứng
dụng vẫn đang chạy và bản sao có thể không nhất quán.

---

## Cách thủ công

Dừng ứng dụng, rồi:

```powershell
xcopy /E /I /Y "F:\Tool Video Youtube\data" "D:\Backup\idioms-20260913\data"
copy "F:\Tool Video Youtube\.env" "D:\Backup\idioms-20260913\.env"
```

Chép thư mục `data/` khi ứng dụng đã dừng là một bản sao lưu hoàn toàn hợp lệ.

---

## Khôi phục

```powershell
# 1. Dừng ứng dụng
# 2. Đổi tên thư mục hiện tại (đừng xoá ngay)
ren "F:\Tool Video Youtube\data" "data-old"

# 3. Chép bản sao lưu về
xcopy /E /I "D:\Backup\idioms-20260913\data" "F:\Tool Video Youtube\data"

# 4. Chép .env nếu cần
copy "D:\Backup\idioms-20260913\.env" "F:\Tool Video Youtube\.env"

# 5. Đồng bộ lược đồ (không mất dữ liệu)
npm run db:push

# 6. Chạy lại
npm start
```

Giữ `data-old` cho tới khi chắc chắn bản khôi phục hoạt động.

---

## Vì sao chép tệp là đủ

Đường dẫn media lưu trong cơ sở dữ liệu là **tương đối** so với thư mục `data/`
(ví dụ `projects/abc/final/video.mp4`), không phải đường dẫn tuyệt đối. Nghĩa là
có thể chép thư mục `data/` sang máy khác, thậm chí ổ đĩa khác, và mọi liên kết
vẫn đúng.

Cơ sở dữ liệu không chứa video hay ảnh, nên `app.db` luôn nhỏ. Phần nặng là
`data/projects/`, và đó chỉ là các tệp thường.

---

## Nên sao lưu bao lâu một lần

Không có lịch bắt buộc. Thời điểm đáng sao lưu:

- Sau khi nhập một lô thành ngữ lớn
- Sau khi tinh chỉnh xong nhân vật và phong cách
- Trước khi nâng cấp phiên bản
- Trước khi chuyển sang nhà cung cấp AI thật

Nếu chỉ muốn giữ nội dung mà không cần media đã render, chép riêng `data/app.db`
là đủ — mọi thành ngữ, nhân vật, phong cách, giá mô hình và lịch sử chi phí đều
nằm trong đó.

---

## Dọn dẹp trước khi sao lưu

```powershell
npm run cleanup -- --dry-run    # xem sẽ xoá gì
npm run cleanup                 # xoá thật
```

Xoá tệp tạm cũ hơn 3 ngày và tệp của job thất bại cũ hơn 7 ngày. **Không bao giờ
tự xoá video hoàn chỉnh.**
