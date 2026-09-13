# Kiến trúc

## Hình dạng tổng thể

Một tiến trình Node duy nhất trên máy Windows. Không có dịch vụ ngoài, không có
hàng đợi ngoài, không có cơ sở dữ liệu đám mây.

```
MÁY WINDOWS
│
├── Next.js 15 (App Router)
│   ├── Server Components  → đọc dữ liệu
│   ├── Server Actions     → mọi thao tác ghi
│   └── Route Handlers     → /api/status, /api/media/*
│
├── SQLite + Prisma  → data/app.db   (chỉ metadata và đường dẫn)
│
├── Media cục bộ     → data/projects/<id>/...
│
├── FFmpeg           → ghép, ghi phụ đề, xuất MP4
│
├── Worker hàng đợi  → trong cùng tiến trình, concurrency 1-2
│
└── API AI bên ngoài (chỉ khi online và đã tắt mock)
```

## Thư mục

```
src/
├── domain/       Kiểu và Zod schema. Không phụ thuộc gì khác.
│   ├── enums.ts      union chuỗi + nhãn tiếng Việt
│   └── script.ts     hợp đồng ScriptJson, điểm chất lượng
│
├── lib/          Hạ tầng dùng chung
│   ├── prisma.ts     một PrismaClient cho cả tiến trình
│   ├── env.ts        đọc biến môi trường qua Zod
│   ├── paths.ts      MỌI đường dẫn đi qua đây (chống path traversal)
│   ├── crypto.ts     AES-256-GCM cho API key
│   ├── logger.ts     ghi log có cấu trúc + che khoá bí mật
│   ├── prompts.ts    nạp mẫu prompt (DB override → tệp)
│   ├── settings.ts   cài đặt lưu trong DB
│   ├── csv.ts        đọc CSV cho nhập hàng loạt
│   └── utils.ts      định dạng, hash, slug
│
├── providers/    Lớp trừu tượng nhà cung cấp
│   ├── types.ts      TextProvider, ImageProvider, VideoProvider, ...
│   ├── registry.ts   NƠI DUY NHẤT ánh xạ tên → bản hiện thực
│   └── mock/         bản mock (bản duy nhất hoạt động ở Milestone 1)
│
├── services/     Logic nghiệp vụ
│   ├── ai-router.ts       chọn mô hình cho từng cảnh
│   ├── pricing.ts         phép tính giá và chỉ số giá trị
│   ├── complexity.ts      phân loại độ phức tạp + ưu tiên chi tiêu
│   ├── cost-estimator.ts  ước tính và lập kế hoạch từng cảnh
│   ├── budget.ts          chặn theo NGÂN SÁCH TỐI ĐA, tối ưu lô
│   ├── script-service.ts  sinh, sửa JSON hỏng, chống trùng lặp
│   ├── generation.ts      gọi nhà cung cấp (idempotent, có dự phòng)
│   ├── project-service.ts vòng đời dự án
│   ├── cost-tracker.ts    sổ chi phí
│   ├── provider-health.ts trạng thái nhà cung cấp
│   └── connectivity.ts    ONLINE / OFFLINE
│
├── jobs/         Hàng đợi trên SQLite
│   ├── queue.ts      thêm / nhận / hoàn tất / thất bại / hoãn
│   ├── handlers.ts   một hàm cho mỗi loại job
│   └── worker.ts     vòng lặp, giới hạn số job song song
│
├── media/        FFmpeg và hình ảnh
│   ├── ffmpeg.ts     tìm binary, sinh tiến trình, dò khả năng
│   ├── render.ts     dựng tham số (hàm thuần) + render 3 lượt
│   ├── subtitles.ts  SRT + ASS
│   └── png.ts        bộ mã hoá PNG thuần TypeScript
│
└── app/          Giao diện tiếng Việt + API
```

---

## Những quyết định đáng giải thích

### SQLite, không phải PostgreSQL

Đây là ứng dụng một người dùng chạy cục bộ. SQLite miễn phí, không cần cài
server, và sao lưu bằng cách chép một tệp.

Lược đồ được viết để chuyển sang Postgres sau này mà không phải sửa mã ứng dụng:
không dùng khối `enum` của Prisma, không dùng kiểu `Json` (SQLite không hỗ trợ),
không lưu dữ liệu nhị phân. Chi tiết trong [DATABASE.md](DATABASE.md).

### Server Actions, không phải một tầng REST đầy đủ

Mỗi trang là một Server Component đọc thẳng từ Prisma; mọi thao tác ghi là một
Server Action. Như vậy không cần viết và giữ đồng bộ 40 endpoint chỉ để chính
giao diện của mình gọi. Chỉ hai route handler tồn tại vì thực sự cần:
`/api/status` (giao diện tự hỏi mỗi 8 giây) và `/api/media/*` (phát tệp media có
hỗ trợ Range để tua video).

### Hàng đợi trong cơ sở dữ liệu, không phải Redis

Job nằm trong bảng `Job`. Worker chạy trong cùng tiến trình, "giành" job bằng
một câu `UPDATE` có điều kiện (SQLite không có `SELECT ... FOR UPDATE`). Job
sống sót qua việc khởi động lại; hàng đợi trong bộ nhớ thì không.

Số job song song cố tình để thấp (mặc định 2). Đó chính là cái chặn một lô 50
video bắn 50 lệnh gọi API tính phí cùng lúc.

### Nhà cung cấp ẩn sau interface

Không có tệp nào ngoài `src/providers/**` biết tên nhà cung cấp nào đang chạy.
`registry.ts` là nơi duy nhất ánh xạ tên → lớp hiện thực, và ở chế độ mock nó
trả về bản mock **bất kể** router hay người dùng chọn gì. Đó là lý do "không thể
vô tình tiêu tiền" là một tính chất của hệ thống chứ không phải một thói quen.

Yêu cầu một nhà cung cấp chưa tích hợp sẽ ném lỗi rõ ràng, chứ không âm thầm
chạy mock rồi giả vờ là nó hoạt động.

### Giá nằm trong cơ sở dữ liệu

Không có giá nhà cung cấp nào được viết cứng ở bất kỳ đâu. Mọi con số đến từ
bảng `ModelRegistry`, sửa được trong trang "Mô hình AI". Nhà cung cấp đổi bảng
giá = sửa dữ liệu, không phải phát hành phiên bản mới.

### Mock tạo ra tệp thật

Ảnh mock là PNG thật (mã hoá bằng TypeScript thuần, không cần thư viện native),
video mock là MP4 thật do FFmpeg tạo, giọng đọc mock là WAV 16-bit thật. Nhờ vậy
chế độ mock đi qua đúng những đoạn mã mà nhà cung cấp thật sẽ đi qua: tải về,
ghi đĩa, dò thông tin, ghép, render. Khi nối API thật ở Milestone 2, thứ duy
nhất thay đổi là nguồn của các byte.

### Ghi phụ đề bằng cách đổi thư mục làm việc

Bộ lọc `subtitles=` của FFmpeg dùng `:` làm ký tự phân tách riêng, nên một đường
dẫn Windows như `C:\...` phải thoát hai lớp và rất dễ sai. Thay vì chống lại
cú pháp đó, lượt render cuối chạy với `cwd` đặt vào thư mục chứa tệp và gọi tệp
bằng tên trần. Cách này loại bỏ hẳn một nhóm lỗi.

### Mọi đường dẫn đi qua `lib/paths.ts`

Tên tệp do nhà cung cấp bên ngoài trả về được coi là dữ liệu thù địch. Ứng dụng
tự đặt tên tệp bằng UUID, chỉ giữ phần mở rộng và chỉ khi nó nằm trong danh sách
cho phép. `toAbsolute()` từ chối mọi đường dẫn thoát khỏi thư mục `data/`, nên
route phát media không thể bị lừa đọc tệp hệ thống.

---

## Luồng dữ liệu của một dự án

```
1. Người dùng chọn thành ngữ, chế độ, ngân sách
       ↓
2. createProjectForIdiom()        → tạo bản ghi Project + thư mục
       ↓
3. generateProjectScript()
       ├─ nạp prompts/script.txt và điền dữ liệu
       ├─ TextProvider.generateScript()
       ├─ parseScript()           → Zod; nếu hỏng thì sửa rồi thử lại
       ├─ checkDuplicate()        → trùng góc hài? sinh lại
       ├─ scoreScript()           → trục quan trọng < 7? viết lại MỘT lần
       ├─ withDerivedRouting()    → tự tính độ phức tạp + ưu tiên chi tiêu
       └─ persistScript()         → ghi các bản ghi Scene
       ↓
4. previewProjectCost()           → định tuyến mọi cảnh cho cả 3 chế độ
       ↓                             (chưa gọi nhà cung cấp, chưa tốn gì)
5. Người dùng xem lại, sửa cảnh, ghim mô hình nếu muốn
       ↓
6. startMediaGeneration()
       ├─ checkBudget()           → vượt ngân sách thì DỪNG tại đây
       ├─ lưu kế hoạch định tuyến vào từng Scene
       └─ đưa 1 job mỗi cảnh + 1 job render vào hàng đợi
       ↓
7. Worker xử lý từng cảnh
       ├─ generateSceneImage()    → ảnh keyframe (bỏ qua ở chế độ Tiết kiệm
       │                            cho cảnh đơn giản)
       ├─ generateSceneVideo()    → clip 2-6 giây
       ├─ generateSceneVoice()    → giọng đọc
       └─ evaluateScene()         → dưới ngưỡng thì tăng retryCount và làm lại
       ↓
8. Job render_final
       ├─ chờ mọi cảnh có media (hoặc báo lỗi ngay nếu có cảnh đã hỏng)
       ├─ chuẩn hoá từng cảnh về cùng thông số mã hoá
       ├─ ghép bằng concat demuxer (sao chép luồng, rất nhanh)
       ├─ ghi phụ đề + trộn nhạc nền
       └─ xuất MP4 và cập nhật dự án + thành ngữ
```

---

## Những gì cố tình KHÔNG có trong V1

Redis, Kafka, microservice, Kubernetes, hàng đợi phân tán, Docker bắt buộc,
cơ sở dữ liệu đám mây, tải lên YouTube tự động.

Đây là ứng dụng cục bộ cho một người dùng. Mỗi thành phần trên đều thêm một thứ
có thể hỏng mà không giải quyết vấn đề nào đang tồn tại.
