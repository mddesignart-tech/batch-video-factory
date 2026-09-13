# Cơ sở dữ liệu

SQLite qua Prisma. Tệp: `data/app.db`.

---

## Nguyên tắc

**SQLite chỉ lưu metadata và đường dẫn.** Không có ảnh, video hay âm thanh nào
nằm trong cơ sở dữ liệu. Media ở trên đĩa, trong `data/projects/<id>/`, và bảng
chỉ giữ đường dẫn tương đối như `projects/abc/videos/xyz.mp4`.

Hệ quả:

- `app.db` luôn nhỏ (vài trăm KB), sao lưu tức thì,
- có thể chép cả thư mục `data/` sang máy khác và mọi đường dẫn vẫn đúng,
- không bao giờ gặp giới hạn kích thước hàng của SQLite.

---

## Các bảng

### Nội dung

| Bảng | Vai trò |
|---|---|
| `Idiom` | Thư viện thành ngữ. `slug` là duy nhất → chống trùng lặp. |
| `Character` | Nhân vật tái sử dụng. `visualPrompt` là bản mô tả chuẩn. |
| `StylePreset` | Bộ prompt phong cách hình ảnh. |

### Đăng ký

| Bảng | Vai trò |
|---|---|
| `ModelRegistry` | Giá và năng lực từng mô hình. Nguồn giá **duy nhất**. |
| `ProviderConfig` | Bật/tắt, API key đã mã hoá, thứ tự ưu tiên và dự phòng. |

### Dự án

| Bảng | Vai trò |
|---|---|
| `Project` | Một video. Giữ `scriptJson` đã kiểm tra, ngân sách, đường dẫn MP4. |
| `Scene` | Một cảnh. Prompt, độ phức tạp, mô hình đã chọn, đường dẫn media. |
| `Asset` | Mọi tệp đã tạo, kèm nhà cung cấp/mô hình đã tạo ra nó. |

### Công việc

| Bảng | Vai trò |
|---|---|
| `Batch` | Định nghĩa một lô. |
| `Job` | Hàng đợi. Trạng thái, số lần thử, thời điểm chạy tiếp theo. |
| `ProviderJob` | **Mọi** yêu cầu gửi tới nhà cung cấp, khoá theo idempotency. |

`ProviderJob` là bảng giữ cho việc thử lại không biến thành lần tính phí thứ
hai. Xem [COST_CONTROL.md](COST_CONTROL.md).

### Chi phí và nhật ký

| Bảng | Vai trò |
|---|---|
| `CostEntry` | Sổ cái. Tổng được tính lại từ đây, không cộng dồn tại chỗ. |
| `LogEntry` | Nhật ký có cấu trúc. Khoá bí mật bị che trước khi ghi. |
| `ConceptHistory` | Góc hài đã dùng cho từng thành ngữ → chống trùng ý tưởng. |
| `Setting` | Cài đặt ứng dụng và bản ghi đè mẫu prompt. |

---

## Chuyển sang PostgreSQL sau này

Lược đồ được viết để việc này là đổi cấu hình, không phải viết lại mã.

Ba quy ước làm nên điều đó:

**1. Không dùng khối `enum` của Prisma.** SQLite không hỗ trợ. Các cột kiểu enum
là `String`, và được kiểm tra trong TypeScript qua `src/domain/enums.ts` cùng
Zod. Tầng ứng dụng đã là nơi thực thi ràng buộc, nên cột native enum không thêm
được gì.

**2. Không dùng kiểu `Json`.** SQLite không hỗ trợ. JSON nằm trong cột `String`
có hậu tố `Json` và được phân tích qua Zod ngay tại biên.

**3. Không lưu dữ liệu nhị phân.** Media ở trên đĩa.

### Các bước chuyển

```prisma
datasource db {
  provider = "postgresql"   // đổi từ "sqlite"
  url      = env("DATABASE_URL")
}
```

```powershell
$env:DATABASE_URL="postgresql://user:pass@host:5432/idioms"
npx prisma migrate dev --name init
npm run seed
```

Chép thư mục `data/projects/` sang máy mới. Đường dẫn trong cơ sở dữ liệu là
tương đối nên vẫn khớp.

Tuỳ chọn sau khi chuyển: thay các cột `String` kiểu enum bằng native enum, và
đổi các cột `*Json` sang `Json`. Cả hai đều là thay đổi lược đồ thuần tuý; không
có mã ứng dụng nào cần sửa vì mọi thứ vẫn đi qua Zod.

---

## Các lệnh thường dùng

```powershell
npm run db:push        # đồng bộ lược đồ (phát triển)
npm run db:generate    # sinh lại Prisma Client sau khi sửa lược đồ
npm run seed           # nạp lại danh mục, an toàn khi chạy lại
npx prisma studio      # trình duyệt dữ liệu trực quan
```

`npm run seed` chạy nhiều lần được. Nó thêm phần còn thiếu, cập nhật năng lực và
điểm số của mô hình, nhưng **không** đụng tới dự án, chi phí hay giá mà bạn đã
nhập cho nhà cung cấp thật.

---

## Ghi chú về đồng thời

SQLite chỉ cho một người ghi tại một thời điểm. Ứng dụng này là một tiến trình,
một người dùng, và số job song song mặc định là 2, nên thực tế không bao giờ
tranh chấp.

Hàng đợi "giành" job bằng một câu `UPDATE` có điều kiện thay vì đọc-rồi-ghi, vì
SQLite không có `SELECT ... FOR UPDATE`:

```ts
const claimed = await prisma.job.updateMany({
  where: { id: candidate.id, status: "queued" },   // chỉ thắng nếu vẫn đang chờ
  data:  { status: "processing", attempts: { increment: 1 } },
});
if (claimed.count === 1) { /* job này là của ta */ }
```

---

## Sao lưu

Dừng ứng dụng rồi chép cả thư mục `data/`. Xem [BACKUP.md](BACKUP.md).
