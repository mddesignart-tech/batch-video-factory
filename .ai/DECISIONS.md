# Quyết định kiến trúc

Ghi lại **vì sao**, để lần sau không phải tranh luận lại.

---

## QĐ-001 · SQLite thay vì PostgreSQL

**Bối cảnh:** V1 là ứng dụng một người dùng chạy cục bộ trên Windows.

**Quyết định:** SQLite qua Prisma, tệp `data/app.db`.

**Vì sao:** Miễn phí, không cần cài server, sao lưu bằng cách chép một tệp, chạy
được khi mất mạng. PostgreSQL sẽ thêm một dịch vụ phải cài và phải chạy mà không
giải quyết vấn đề nào đang có.

**Cách giữ đường lui:** Lược đồ tránh mọi thứ chỉ có ở SQLite hoặc chỉ có ở
Postgres — không dùng khối `enum` của Prisma, không dùng kiểu `Json`, không lưu
dữ liệu nhị phân. Chuyển sang Postgres là đổi `provider` trong datasource và
chạy migrate. Không có mã ứng dụng nào phải sửa.

---

## QĐ-002 · Hàng đợi trong cơ sở dữ liệu, không dùng Redis

**Quyết định:** Bảng `Job` và worker chạy trong cùng tiến trình.

**Vì sao:** Đặc tả nói rõ không dùng Redis cho V1. Job phải sống sót qua việc
khởi động lại, nên hàng đợi trong bộ nhớ không đủ. Một bảng dữ liệu vừa đủ dùng
vừa dễ soi khi có sự cố — chỉ cần mở trang Nhật ký.

**Đánh đổi:** Worker dùng cơ chế poll (mỗi 2.5 giây khi rảnh) thay vì được đánh
thức. Với một người dùng thì độ trễ đó không đáng kể.

**Chi tiết:** SQLite không có `SELECT ... FOR UPDATE`, nên việc giành job dùng
`UPDATE ... WHERE status = 'queued'` rồi kiểm tra số hàng bị ảnh hưởng.

---

## QĐ-003 · Server Actions thay vì một tầng REST đầy đủ

**Quyết định:** Server Components để đọc, Server Actions để ghi. Chỉ hai route
handler: `/api/status` và `/api/media/*`.

**Vì sao:** Ứng dụng chỉ có một client — chính giao diện của nó. Viết 40 endpoint
REST rồi phải giữ đồng bộ kiểu dữ liệu ở hai đầu là công sức thuần tuý, không
đổi lấy gì.

**Vì sao vẫn giữ hai route:** `/api/status` được giao diện tự hỏi định kỳ (8
giây một lần) nên phải là endpoint thật. `/api/media/*` cần hỗ trợ HTTP Range để
thẻ `video` tua được.

---

## QĐ-004 · Tự viết các thành phần giao diện thay vì dùng CLI của shadcn/ui

**Quyết định:** Viết tay khoảng một tá thành phần theo đúng quy ước của
shadcn/ui trong `src/components/ui/index.tsx`.

**Vì sao:** Ứng dụng chỉ cần chừng đó thành phần. Chạy CLI sinh mã sẽ kéo theo
nhiều gói Radix cho một công cụ nội bộ một người dùng, và thêm một bước sinh mã
vào quy trình. API và quy ước class giữ nguyên, nên thay bằng shadcn/ui thật sau
này chỉ là việc cơ học.

---

## QĐ-005 · Chế độ mock tạo ra tệp thật

**Quyết định:** Ảnh mock là PNG thật (mã hoá bằng TypeScript thuần), video mock
là MP4 thật do FFmpeg tạo, giọng đọc mock là WAV 16-bit thật.

**Vì sao:** Giá trị của chế độ mock nằm ở chỗ nó đi qua **đúng** những đoạn mã
mà nhà cung cấp thật sẽ đi qua: tải về, ghi đĩa, dò thông tin, ghép, render. Tệp
rỗng sẽ bỏ qua toàn bộ phần đó và để lỗi lộ ra vào đúng lúc bắt đầu tốn tiền.

**Vì sao tự viết bộ mã hoá PNG:** Dùng thư viện canvas sẽ cần build native trên
Windows. Ứng dụng chỉ cần tô nền, vẽ hình chữ nhật và chữ bitmap — khoảng 200
dòng, không phụ thuộc gì.

---

## QĐ-006 · Mô hình mock có giá mô phỏng, không phải 0 đô

**Quyết định:** Các mô hình `mock-*` mang giá khác 0 trong bảng đăng ký.

**Vì sao:** Nếu mọi thứ đều 0 đô thì router không có tín hiệu chi phí, nên nó sẽ
luôn chọn mô hình chất lượng cao nhất, và toàn bộ phần ước tính, kiểm tra ngân
sách, tối ưu lô sẽ không thể thử nghiệm được. Đặc tả yêu cầu người dùng phải
"thấy chi phí ước tính" và "đặt ngân sách tối đa" trong bài kiểm tra nghiệm thu
— cả hai đều vô nghĩa nếu mọi con số là 0.00.

**Vì sao vẫn trung thực:** Giá mô phỏng chỉ ảnh hưởng tới **ước tính**. Nhà cung
cấp mock báo chi phí thực tế là 0, nên sổ chi phí và bảng điều khiển hiển thị
đúng sự thật: không đồng nào được tiêu.

---

## QĐ-007 · Ngưỡng chất lượng chỉ áp dụng khi chiến lược là AUTO

**Bối cảnh:** Một test cho thấy chọn `CHEAPEST` mà vẫn nhận mô hình đắt nhất, vì
ngưỡng chất lượng của chế độ đã loại hết các lựa chọn rẻ.

**Quyết định:** Ngưỡng chỉ áp dụng khi `strategy === "AUTO"`.

**Vì sao:** Ngưỡng là cách một *chế độ* tự quyết định rằng cảnh này xứng đáng mô
hình tốt hơn. Khi người dùng nêu rõ chiến lược, họ đang ghi đè chính phán đoán
đó. Yêu cầu "rẻ nhất" mà nhận về mô hình cao cấp là lỗi, không phải cơ chế bảo
vệ.

---

## QĐ-008 · Trạng thái nhà cung cấp suy ra, không ping

**Quyết định:** Trạng thái tính từ cấu hình (đã bật chưa, có key chưa, đã tích
hợp chưa, có mạng không), không gọi API của nhà cung cấp.

**Vì sao:** Gọi API chỉ để hiển thị một chấm xanh sẽ tốn tiền và tốn hạn mức.
Đặc tả cũng nói rõ không nên ping API liên tục một cách không cần thiết. Kiểm
tra kết nối thật chỉ chạy khi người dùng chủ động yêu cầu.

---

## QĐ-009 · Chế độ mock là cổng chặn ở tầng registry

**Quyết định:** `getVideoProvider()` và các hàm tương tự trả về bản mock khi
`AI_MOCK_MODE=true`, **bất kể** router hay người dùng chọn gì.

**Vì sao:** Đặt cổng chặn ở một chỗ duy nhất, thấp nhất trong ngăn xếp, biến
"không thể vô tình tiêu tiền" thành tính chất của hệ thống chứ không phải một
thói quen phải nhớ. Nếu mỗi nơi gọi tự kiểm tra cờ, sớm muộn sẽ có một nơi quên.

**Hệ quả:** Cờ này chỉ đọc từ `.env`, không sửa được trong giao diện. Công tắc
an toàn chi phí không nên bật tắt được bằng một cú nhấp chuột trong trình duyệt.

---

## QĐ-010 · Khoá idempotency gồm bộ đếm tạo lại của cảnh

**Quyết định:**
`sha256(sceneId | loại | nhà cung cấp | mô hình | hash(prompt) | retryCount)`

**Vì sao:** Một lần thử lại do lỗi tạm thời phải **nối lại** vào job đang chạy
bên phía nhà cung cấp, không được mua thêm cái nữa. Nhưng khi người dùng chủ
động bấm "Tạo lại video", đó là một lần tạo mới hợp lệ. Đưa `retryCount` vào
khoá phân biệt được hai trường hợp mà không cần thêm cờ nào.

---

## QĐ-011 · Render ba lượt thay vì một filter_complex

**Quyết định:** Chuẩn hoá từng cảnh, ghép bằng concat demuxer, rồi hoàn thiện.

**Vì sao:** Khi mọi clip đã giống hệt nhau về thông số mã hoá, bước ghép chỉ là
sao chép luồng: nhanh hơn nhiều và gần như không thể hỏng. Một `filter_complex`
khổng lồ với 6 đầu vào thì chậm hơn và dễ gãy vì một clip có kích thước lạ hoặc
thiếu luồng âm thanh.

---

## QĐ-012 · Ghi phụ đề bằng cách đổi thư mục làm việc

**Quyết định:** Chép tệp `.ass` vào `temp/` và chạy FFmpeg với `cwd` đặt vào đó,
gọi tệp bằng tên trần.

**Vì sao:** Bộ lọc `subtitles=` có cú pháp thoát ký tự riêng, trong đó ký tự ổ
đĩa Windows là nhập nhằng và phải thoát hai lớp. Đổi thư mục làm việc loại bỏ
hẳn nhóm lỗi này thay vì cố viết cho đúng.

---

## QĐ-013 · Xác nhận nội tuyến thay vì hộp thoại của trình duyệt

**Bối cảnh:** Nút TẠO MEDIA là thao tác duy nhất có thể tốn tiền, nên cần xác
nhận.

**Quyết định:** Xác nhận hiển thị ngay trong trang, không dùng `window.confirm`.

**Vì sao:** Hộp thoại gốc không hiển thị được con số ước tính, không viết được
bằng giọng văn tiếng Việt của ứng dụng, và chặn toàn bộ renderer khi đang mở —
khiến giao diện không thể điều khiển bằng công cụ kiểm thử tự động.

---

## QĐ-014 · Trạng thái worker đặt trên globalThis

**Bối cảnh:** Thanh trạng thái luôn báo worker đang tắt dù worker đang chạy.

**Nguyên nhân:** Next đóng gói `instrumentation.ts` (nơi khởi động worker) tách
rời khỏi các route handler (nơi báo cáo trạng thái), nên mỗi bên có một bản sao
riêng của module.

**Quyết định:** Trạng thái worker lưu trên `globalThis`, cùng cách đã dùng cho
PrismaClient.

---

## QĐ-015 · Nghĩa đen bạo lực được viết lại ngay trong dữ liệu gốc

**Quyết định:** Trường `literalMeaning` của mỗi thành ngữ được viết sẵn dưới
dạng **gag hoạt hình vô hại**, không phải mô tả nghĩa đen thật.

Ví dụ, "Break a leg" ghi là *"Anh ta tưởng phải tự làm gãy chân mình nên quấn
chân bằng một cuộn băng gạc hoạt hình khổng lồ trước buổi diễn"*, chứ không phải
"ai đó làm gãy chân".

**Vì sao:** Trường này được chèn thẳng vào prompt tạo ảnh và video. Viết an toàn
ngay từ dữ liệu gốc khiến mọi prompt phía sau kế thừa sự an toàn đó, thay vì phụ
thuộc vào việc mô hình có tự kiềm chế hay không.
