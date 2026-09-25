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

---

## QĐ-016 · Batch dùng một cơ chế cấp phép RIÊNG, không nới lỏng token cũ

**Bối cảnh:** `CREATE_ATTEMPT_TOKEN` nghĩa là "một lần xác nhận = đúng một lần
POST create". Đúng cho benchmark. Không dùng được cho batch.

**Quyết định:** Tạo `BATCH_SPEND_AUTHORIZATION` như một công cụ riêng. Token giữ
nguyên, vẫn quản benchmark / test tay / debug. Một cảnh trong lô đã duyệt dùng
authorization; cảnh ngoài lô vẫn cần token. `needsCreatePermit()` trả về `false`
đúng khi authorization được áp dụng, nên không đường nào chi được mà không có
một trong hai.

**Vì sao không nới token:** 10 video sẽ cần khoảng 50 lần bấm xác nhận. Một
người bấm qua 50 hộp thoại thì đã ngừng đọc chúng — cơ chế đó **tệ hơn là không
có**, vì nó trông giống sự đồng ý mà không phải.

---

## QĐ-017 · Giữ chỗ tiền trước khi gửi request

**Bối cảnh:** Năm job song song, lô còn $0,60. Mỗi job đọc sổ, thấy đủ cho $0,40
của mình, và gửi. Cả năm lần kiểm tra **đều đúng** — chúng chỉ cùng đúng về một
khoản $0,60. Lô tiêu $2,00.

**Quyết định:** Bảng `CostReservation`. Tiền được giữ chỗ **trước** khi request
rời máy, và lần kiểm tra sau nhìn thấy chỗ đã giữ.

**Vì sao không sửa bằng cách đọc kỹ hơn:** không lần kiểm tra nào đọc "đã chi"
sửa được, vì lúc kiểm tra thì tiền chưa chi. Vấn đề không nằm ở việc đọc.

**Khoá theo `idempotencyKey`, unique** — đúng bằng key của `ProviderJob`. Đó là
thứ khiến resume, refresh và restart tìm thấy chỗ đã giữ thay vì mở chỗ mới.

**Quyết toán nghiêng về phía "đã bị tính phí":** chỉ trả tiền lại cho lô khi
chắc chắn request chưa rời máy. Không chắc thì giữ nguyên và đánh dấu
`possiblyBilled`. Nghiêng sai hướng này làm lô mất một ít dư địa; nghiêng hướng
kia làm lô tiêu vượt trong khi mọi con số trên màn hình vẫn khớp.

---

## QĐ-018 · LOCAL_MOTION là một kết quả định tuyến, không phải phương án dự phòng

**Quyết định:** Router có thêm lựa chọn `LOCAL_MOTION` — ảnh keyframe +
scale/crop/push-in bằng FFmpeg, $0. Nó được quyết định từ tính chất của cảnh,
**trước** khi ngân sách được hỏi tới.

**Vì sao không để nó là fallback khi hết tiền:** một cảnh cần chuyển động tạo
sinh thì cần nó bất kể còn tiền hay không. Trộn hai câu hỏi lại sẽ để một lô gần
cạn tiền âm thầm định nghĩa lại thế nào là video đạt.

**Con số làm nó đáng làm:** 6 clip Sora = $2,40, đắt hơn toàn bộ ảnh và kịch bản
cộng lại, và phần lớn số đó mua chuyển động không ai yêu cầu.

---

## QĐ-019 · Luật LOCAL_MOTION hiệu chỉnh theo `spendPriority`, không theo `complexity`

**Bối cảnh:** Luật đầu tiên viết là "cảnh `complexity = LOW` thì dùng ảnh tĩnh".
Đọc thì hợp lý.

**Đo thì không.** Kịch bản 6 cảnh từ bộ sinh thật trả về
MEDIUM/MEDIUM/HIGH/HIGH/MEDIUM/MEDIUM — **không cảnh nào là LOW**, vì chỉ cần
hai nhân vật trong khung đã đủ vượt ngưỡng MEDIUM. Luật đó sẽ kích hoạt gần như
không bao giờ, trong khi mọi unit test của nó vẫn xanh.

**Quyết định:** Ở chế độ Cân bằng, tín hiệu là `spendPriority = LOW` — thứ mà bộ
phân loại gán cho vai "meaning" và "example", tức cảnh giải thích và cảnh chốt.
Đó đúng là hai nhịp tĩnh mỗi video.

**Bài học ghi lại:** một luật định tuyến chỉ đúng khi đã đối chiếu với phân phối
đầu ra thật của bộ phân loại, không phải với hình dung về nó.

---

## QĐ-020 · Cảnh LOCAL_MOTION thì ảnh keyframe thành BẮT BUỘC

**Bối cảnh:** Chế độ Tiết kiệm vốn bỏ qua keyframe cho cảnh đơn giản một nhân
vật. Đó đúng là nhóm cảnh được đẩy sang LOCAL_MOTION.

**Hậu quả nếu để nguyên:** cảnh không có clip **và** không có ảnh. Bộ render lọc
theo `videoPath || imagePath`, nên nó **lặng lẽ bỏ cảnh đó** khỏi video hoàn
chỉnh — một cảnh biến mất, không lỗi ở đâu cả.

**Quyết định:** `keyframeRequired()` trong `domain/local-motion.ts`. Khi chuyển
động đến từ ảnh tĩnh, ảnh thôi là tuỳ chọn. `generateSceneVideo` cũng ném lỗi rõ
ràng nếu gặp cảnh LOCAL_MOTION mà không có ảnh, thay vì trả về im lặng.

---

## QĐ-021 · Xoá `createBatch` cũ thay vì đánh dấu deprecated

**Bối cảnh:** `createBatch` nhận form rồi **lập tức** xếp `batch_expand`, sinh
kịch bản và bắt đầu chi tiền media trong một bước.

**Quyết định:** Xoá hẳn, cùng với `NewBatchForm`.

**Vì sao không giữ lại:** đó chính là hình dạng "bấm nút là tiền ra" mà Batch V1
sinh ra để thay thế. Để lại thì đường chi tiền không cần duyệt vẫn còn đó, và
một đường như vậy sẽ được dùng lại.

---

## QĐ-022 · Dự án `draft` không có kịch bản phải được tự sửa, không phải bỏ mặc

**Bối cảnh:** Trong lần nghiệm thu trên giao diện, một SQLite socket timeout làm
hỏng bước viết kịch bản của video thứ ba. Dòng dự án vẫn được tạo trước đó, nên
nó nằm lại ở trạng thái `draft` với **không cảnh nào**.

**Vì sao đó là ngõ cụt:** `startMediaGeneration` từ chối một dự án chưa có kịch
bản — đúng. Nhưng nghĩa là *chạy tiếp lô* cũng bó tay, và nút *Thử lại* trên
đúng dòng đó cũng trả về "chưa có kịch bản". Lỗi gốc là **nhất thời**; tình
trạng kẹt thì **vĩnh viễn**. Hai video kia hoàn thành, video thứ ba không đường
nào cứu ngoài sửa tay.

**Quyết định:** `handleBatchExpand` và `retryVideo` đều kiểm tra dự án `draft`
không có `scriptJson`, và **viết lại kịch bản** trước khi tiếp tục.

**Bài học ghi lại:** một nhánh lỗi được xử lý gọn gàng (bắt, ghi log, đi tiếp)
vẫn có thể để lại trạng thái mà không cơ chế phục hồi nào chạm tới được. Câu hỏi
phải hỏi không phải "đã bắt lỗi chưa" mà "sau khi bắt, cái còn lại có tự thoát
ra được không".

---

## QĐ-023 · Nghiệm thu dùng hai tier model MOCK, không dùng tên nhà cung cấp thật

**Bối cảnh:** Cần chứng minh router chọn được giữa một tier rẻ và một tier đắt.
Cách hiển nhiên là đăng ký `runway` và `openai` rồi để Mock Mode trả về adapter
mock.

**Vì sao không làm vậy:** nó sẽ ghi vào sổ chi phí những dòng
`provider=runway, calls=1` cho một cuộc gọi Runway chưa bao giờ nhận — một nhà
cung cấp giả với số lần gọi giả, nằm đúng trong bảng mà
`providerSpendBreakdown()` đọc ra.

**Quyết định:** hai tier là hai dòng model dưới provider `mock`, đặt giá bằng
giá thật ($0,05/giây và $0,10/giây). Router vẫn phải chọn giữa chúng — đó mới là
hành vi cần kiểm tra — còn mọi dòng sổ vẫn ghi `mock`, đúng sự thật. Việc tách
ví giữa các nhà cung cấp **thật** được kiểm ở tầng cổng, nơi kiểm được mà không
ghi gì cả.

---

## QĐ-024 · Ba loại chi phí là KIỂU DỮ LIỆU, không phải chú thích

**Bối cảnh:** `availableProviderNames()` trả `["mock"]` khi `AI_MOCK_MODE=true`,
và bộ ước tính chỉ định tuyến tới danh sách đó. Nên **mọi** con số "Tổng chi phí
dự kiến" mà trang lô từng hiển thị đều tính từ giá mock, rồi trình bày như dự
báo tiền thật.

**Vì sao không chỉ thêm một dòng chữ "(mock)":** giá mock sai theo cả hai chiều
— voice cao gấp 25 lần giá OpenAI, image và video thấp hơn một nửa. Một con số
sai không cứu được bằng nhãn; người đọc vẫn sẽ neo vào con số.

**Quyết định:** `CostBasis = MOCK | PRODUCTION_ESTIMATE | ACTUAL` trong
`domain/cost-basis.ts`. `ProjectEstimate` mang theo nó, và nó được **suy ra từ
provider đã chọn** chứ không phải do người gọi truyền vào — một cờ phải nhớ đặt
là một cờ sẽ có ngày bị đặt sai, và đặt sai đúng cờ này là cách giá giả lập lọt
lên màn hình duyệt chi.

Mỗi kế hoạch tính **hai lần**: `runtime` (chạy được ngay) và `production` (giá
thật, qua `productionProviderNames()` — cố tình bỏ qua Mock Mode). **Hạn mức đề
xuất luôn lấy từ `production`.**

---

## QĐ-025 · "$0,40" là con số bịa, và bài học rút ra

**Chuyện đã xảy ra:** bảng nghiệm thu ghi Tiết kiệm ≈ $1,03/video. Hai mục bên
dưới, phần kết luận lại đề xuất "chạy 1 video với trần khoảng $0,40". Hai con số
không thể cùng đúng, và người dùng là người phát hiện.

**$0,40 từ đâu ra:** không từ đâu cả. Nó không được suy ra từ phép tính nào, chưa
bao giờ vào code hay tài liệu, và gần như chắc chắn là do lẫn với giá thật của
Sora — **$0,40 cho một clip 4 giây** — rồi bị tôi dùng nhầm thành giá cho cả một
video.

**Cả $1,03 cũng sai**, chỉ là sai kín đáo hơn: nó dùng kịch bản mẫu (hiền hơn
kịch bản thật) và giá mock. Dải thật đo được là **$1,70–$2,36**.

**Cách phòng:** `recommendAuthorization()` suy ra trần đề xuất **từ chính con số
dự toán production**, và có test khẳng định `recommendation.estimated` bằng
`production.estimatedTotal` chứ không bằng con số mock. Một đề xuất không thể
trôi khỏi phép tính sinh ra nó nữa.

**Bài học:** một con số trong phần kết luận phải truy được về một phép tính
trong phần thân. Nếu không truy được thì nó là phát biểu, không phải kết quả.

---

## QĐ-026 · Trang tiến trình tự poll và tự dừng

**Quyết định:** `/batches/[id]` render lần đầu ở server (đúng ngay, không
spinner), rồi client poll `/api/batches/<id>/progress` mỗi 2,5 giây và **dừng
hẳn** khi lô vào `COMPLETED | FAILED | CANCELLED | BUDGET_EXHAUSTED`.

**Vì sao không reload cả trang:** reload làm mất vị trí cuộn và nháy toàn bộ bố
cục vài giây một lần — tệ hơn cái F5 mà nó thay thế.

**Vì sao `NEEDS_REVIEW` không phải trạng thái kết thúc:** người dùng còn có thể
bấm thử lại một video từ đó, nên số liệu vẫn còn thay đổi được.

**Reconnect không cần xử lý riêng:** mọi phản hồi đều dựng từ DB, nên một tab
đóng mười phút chỉ cần hỏi một lần là đúng lại — không cần biết nó đã bỏ lỡ gì.

---

## QĐ-027 · Độ dài hợp lệ là NĂNG LỰC của provider, không phải phép làm tròn

**Bối cảnh:** `billedVideoSeconds` không có nhánh cho `openai`, nên rơi vào
`default: return requestedSeconds`. Ta báo giá 3s/5s/6s cho Sora — ba request mà
API từ chối. Sora chỉ nhận 4/8/12 giây.

**Quyết định:** `allowedDurationsFor()` và `planDuration()` trong
`domain/video-duration.ts`. Mọi ước tính đi qua
`độ dài yêu cầu → năng lực provider → độ dài sẽ gửi → giá`.

**Không tự ý đổi độ dài.** `planDuration` trả `DURATION_TRANSFORM_REQUIRED` kèm
gợi ý, và dừng ở đó. Bóp một cảnh 6 giây xuống 4 giây để vừa API là **thay đổi
nội dung video**, và làm việc đó ở tầng thấp nhất — tầng ít có tư cách phán xét
nhất — là sai.

**Nhưng giá thì vẫn tính theo độ dài sẽ gửi.** $0,80 cho clip 8 giây, không phải
$0,60 cho clip 6 giây không tồn tại. Cost preview phải trung thực về request có
thật, kể cả khi request đó chưa được phê duyệt.

**Phân biệt PADDED và DURATION_TRANSFORM_REQUIRED bằng bằng chứng, không bằng
cảm tính:** Runway gen4_turbo tính 4 giây thành 5 — request **được chấp nhận**,
chỉ bị tính dư, và có clip thật $0,25 chứng minh. Sora ở 6 giây **bị từ chối**,
có HTTP 400 chứng minh.

---

## QĐ-028 · Sora-2 = DEPRECATED, không xoá adapter

**Bối cảnh:** OpenAI tắt Sora API ngày 2026-09-24.

**Quyết định:** `lifecycle = DEPRECATED`, `shutdownDate = 2026-09-24`. Router
không bao giờ tự chọn. Adapter **giữ nguyên** — vẫn cần để đọc job cũ và lịch sử
benchmark, và một model bị khai tử không làm dữ liệu cũ biến mất.

**Chọn tay vẫn tới được.** Deprecate là chặn **router** chọn, không chặn **người**
chọn. Xoá hẳn đường đó sẽ biến một quyết định có ý thức thành chuyện bất khả thi.

**Hệ quả phải chấp nhận:** MEDIUM và HIGH giờ không có provider nào được duyệt,
nên **không kịch bản nào đang có chạy được tự động**. Đó là câu trả lời đúng.
Câu trả lời sai là để router "tạm" dùng Sora cho xong việc.

---

## QĐ-029 · Kịch bản test soạn tay, nhưng độ phức tạp do CLASSIFIER chấm

**Bối cảnh:** cần một kịch bản không có cảnh HIGH để chạy thật, mà bước này
không được gọi API trả phí — nên không dùng được Text AI.

**Quyết định:** viết tay kịch bản trong `scripts/prepare-first-real-video.ts`,
rồi chạy `withDerivedRouting()` lên nó. Độ phức tạp và mức ưu tiên chi tiêu
**bị tính lại từ chính văn bản cảnh**, đúng như với kịch bản do model viết.

**Ranh giới không được vượt:** viết cảnh cho đơn giản là hợp lệ — một nhân vật,
một đạo cụ lớn, nền trơn, chuyển động nhỏ và rõ. **Cắt bớt mô tả để ép điểm
xuống thì không.** Nếu một cảnh ra MEDIUM, cách xử lý đúng là **viết lại cảnh**,
không phải sửa nhãn. Một độ phức tạp do người khai sẽ định tuyến tiền thật dựa
trên con số chưa ai kiểm.

Kết quả đo: LOW 6, MEDIUM 0, HIGH 0. Hai cảnh có tín hiệu thật (biểu cảm khuôn
mặt 1,0; vật thể che khuất 1,5) và vẫn dưới ngưỡng MEDIUM là 4,0.

---

## QĐ-030 · Cảnh Runway viết đúng 5 giây, không phải 4

Runway chỉ bán clip 5 hoặc 10 giây. Một cảnh 4 giây bị **gửi đi là 5 và tính
tiền là 5**, rồi bộ render cắt bỏ một giây hoạt hình đã trả tiền.

Viết thẳng cảnh ở 5 giây mua lại giây đó **miễn phí**, và xoá luôn một dòng cảnh
báo `DURATION_TRANSFORM_REQUIRED` không mang lại gì.

Năm chứ không phải sáu: bộ phân loại cộng một điểm cho cảnh **dài hơn** 5 giây,
và cảnh này phải giữ LOW.

---

## QĐ-031 · Lô phải NHẬN kịch bản đã soạn, không sinh lại

`handleBatchExpand` viết kịch bản mới cho idiom nào chưa có project trong lô —
nghĩa là nó sẽ vứt kịch bản soạn tay và thay bằng thứ Text AI sinh ra.

**Quyết định:** gắn project vào lô **trước**, để expansion rơi vào nhánh "đã có
project" và nhận kịch bản này.

**Kèm theo, một khoảng trống UI phải bịt:** nút duyệt chi trước đây chỉ nằm
trong form lập kế hoạch ở `/batches`. Một lô chuẩn bị bằng script hiện ra ở
`/batches/[id]` với quyền chi DRAFT và **không có cách nào duyệt** — buộc người
dùng phải chạy script rời để tiêu tiền, đúng con đường mà cổng batch sinh ra để
đóng lại. Đã thêm `ApprovePanel` vào trang chi tiết.

---

## QĐ-032 · Mã lỗi của nhà cung cấp là dữ liệu, không phải câu chữ

Runway trả về hai thứ khác nhau cho một task hỏng:

```json
{ "status": "FAILED",
  "failure": "An unexpected error occurred.",
  "failureCode": "INTERNAL.BAD_OUTPUT.CODE01" }
```

Adapter gộp cả hai vào một trường `error`, rồi `runProviderJob` ném lỗi với mã
tự chế `"generation_failed"`. Hậu quả: `marksProviderUnsuitable` tìm chuỗi
`BAD_OUTPUT` nhưng chuỗi đó **không bao giờ sống sót tới nơi nó được đọc**. Luật
"đừng gửi lại cảnh này cho model đã từ chối nó" tồn tại trong code và chưa từng
chạy một lần nào trong đời.

**Quyết định:** `failureCode` là một trường riêng, đi thẳng từ HTTP response qua
`JobStatus` → `ProviderError.code` → `ProviderJob.failureCode`. `error` vẫn là
câu chữ cho người đọc. Hai đối tượng đọc khác nhau thì là hai trường khác nhau.

---

## QĐ-033 · Số 0 do nhà cung cấp báo là câu trả lời, không phải sự im lặng

Cùng response đó còn có `cost: { credits: 0 }` — bằng chứng rằng lần gọi hỏng
**không bị tính tiền**. Số dư Runway trước và sau lần chạy thật: 831 → 831.

Code đọc nó bằng truthy check, nên `0` biến thành "không rõ", và phần settlement
rơi về giả định an toàn: "request đã rời máy thì coi như đã bị tính phí". Kết
quả là $0,25 đứng trong sổ cho một clip chưa bao giờ bị thu tiền.

**Quyết định:**

- `billedUnits: number | null` — `null` là *không báo*, `0` là *báo rằng miễn
  phí*. So sánh luôn bằng `=== 0`, không bao giờ bằng `!value`.
- FAILED + `billedUnits === 0` → `release(key, { billed: false })`, trả lại
  **toàn bộ** tiền giữ chỗ.
- `correctSettlement()` cho phép sửa một dòng đã COMMITTED, nhưng **bắt buộc có
  lý do** và được ghi log. `release()` vẫn từ chối động vào dòng đã chốt.

Đoán sai kiểu này tốn của người dùng phần hạn mức họ không tiêu. Đoán sai kiểu
ngược lại tốn tiền thật. Nhưng khi nhà cung cấp đã **nói rõ**, không còn gì để
đoán cả.

---

## QĐ-034 · Thất bại đã trả tiền là bằng chứng, ghi lại theo dấu vân tay input

Một lần gọi hỏng là thông tin đã mua rồi. Trước đây nó bị vứt đi, nên lần sau
lại mua tiếp.

**Hai luật, hai phạm vi khác nhau — đây là phần dễ nhầm:**

| | Phạm vi | Ý nghĩa |
|---|---|---|
| Luật INPUT | `(model, fingerprint)` | *Đúng request này* vào *đúng model này* đã hỏng. Không gửi lại. |
| Luật MODEL | `model` | Model này hỏng trên **nhiều cảnh khác nhau**. Router thôi tự chọn. |

`fingerprint` = hash của model + kind + prompt + keyframe + duration. Đổi bất kỳ
thứ nào trong số đó là một câu hỏi khác, và được phép hỏi — luật cấm **lặp lại
một thất bại**, không cấm dùng lại model.

Luật MODEL đếm **số cảnh khác nhau**, không đếm số dòng: một cảnh hỏng bốn lần
nói về *cảnh đó*; hai cảnh khác nhau cùng hỏng mới nói về *model*. Ngưỡng:
2 cảnh → DEGRADED, 3 → UNSUITABLE.

Chỉ ghi lỗi **thuộc về model** (dùng chung `failureIsAboutTheModel` với phần
benchmark). HTTP 400 là lỗi của ta, 429 là hàng đợi, 5xx là nhà cung cấp gặp
ngày xấu — không cái nào là lời chứng chống lại model.

---

## QĐ-035 · Độ tin cậy là trục thứ ba, tách khỏi `enabled` và `lifecycle`

Ba câu hỏi khác nhau, ba cột khác nhau:

- `enabled` — dòng này có bật không
- `lifecycle` — **nhà cung cấp và người vận hành** nói gì (DEPRECATED, PIN_ONLY)
- `reliability` — **các lần chạy trả tiền của chính ta** cho kết quả gì

Chúng có thể mâu thuẫn, và đó là chuyện bình thường: Sora-2 benchmark tốt nhưng
sắp bị khai tử; gen4_turbo đang ACTIVE, đã từng chạy thành công, mà vẫn là model
vừa trả `BAD_OUTPUT` trên hai cảnh khác nhau.

DEGRADED/UNSUITABLE **chặn định tuyến tự động** nhưng **không tắt model** — ghim
tay vẫn tới được. Đó chính là điều kiện cần để benchmark lại; một model bị hạ
cấp mà không thể ghim tay thì sẽ bị hạ cấp vĩnh viễn.

---

## QĐ-036 · Runway KHÔNG có `GET /models` — nguồn live duy nhất là `/organization`

Đã dò thật, ngày 2026-09-15:

```
GET /organization        200   tier.models{}, creditBalance, rate limit
GET /models              404   Cannot GET /v1/models
GET /organization/usage  404
GET /pricing             404
GET /capabilities        404
```

Nghĩa là **chỉ hai thứ có thể là LIVE**: model nào tồn tại trong tài khoản, và
rate limit của nó. Giá, độ phân giải, độ dài hợp lệ, tỉ lệ khung hình, có audio
hay không — **không endpoint nào phục vụ**. Chúng là dữ liệu thủ công đọc từ tài
liệu công khai.

**Quyết định:** tách nguồn gốc theo từng loại dữ kiện, không gộp một cờ:

| Cột | Ý nghĩa |
|---|---|
| `existenceSource` | `LIVE` khi `/organization` vừa xác nhận; `CACHE`; `MANUAL` |
| `pricingSource` | gần như luôn `MANUAL` — không có endpoint giá |
| `capabilitySource` | gần như luôn `MANUAL` |
| `sourceNote` | URL/endpoint của dữ kiện MANUAL |

Bảng `ProviderCatalogSnapshot` lưu nguyên văn response kèm `fetchedAt`. Không có
hàm nào trả về danh sách model mà **không** kèm nhãn nguồn và tuổi dữ liệu —
bởi vì ngay khi có một hàm như vậy, sẽ có người coi bản lưu một tháng trước là
bằng chứng tài khoản hôm nay còn model đó.

`applyCatalogToRegistry()` **từ chối** ghi khi nguồn là CACHE.

---

## QĐ-037 · `?? "ACTIVE"` trong seed là đường hồi sinh model đã chết

Nhánh `update` của seed ghi `lifecycle: model.lifecycle ?? "ACTIVE"`. Một dòng
seed **không nói gì** về vòng đời sẽ ghi đè `DEPRECATED` đang lưu thành `ACTIVE`.
Một lệnh `npm run seed` là đủ để trả model đã ngừng dùng về lại auto-routing.

Gốc rễ: `??` biến **"không có ý kiến"** thành **"chắc chắn còn tốt"**. Hai điều
đó không giống nhau, và chỗ này là nơi khác biệt tốn tiền.

**Quyết định:**

- Nhánh `update` chỉ ghi `lifecycle`/`shutdownDate`/`deprecationDate` khi seed
  **thực sự có ý kiến**. Im lặng để nguyên dòng đang lưu.
- Nhánh `create` vẫn mặc định `ACTIVE` — dòng mới không có gì để ghi đè.
- Seed **không bao giờ** đụng `reliability`: nó kiếm được từ các lần chạy trả
  tiền của chính ta, seed file không có tư cách phát biểu.
- `existenceSource` cũng không do seed ghi — chỉ lệnh gọi live mới xác nhận được.

---

## QĐ-038 · Ngày tắt thắng nhãn vòng đời

`autoRouteBlock()` là một hàm duy nhất mọi nơi dùng chung, và nó nghiêm hơn
chuỗi `lifecycle` đang lưu:

1. `shutdownDate` đã qua → **chặn**, bất kể nhãn ghi gì
2. `lifecycle !== ACTIVE` → chặn
3. `reliability !== OK` → chặn

Thứ tự có chủ ý. Nhãn chỉ mới bằng lần cuối có người sửa nó; **ngày là sự thật**.
Một dòng còn ghi ACTIVE chỉ vì chưa ai cập nhật sau thông báo của nhà cung cấp là
một dòng sai, và tin nó thì phải trả tiền cho một lần gọi hỏng mới biết.

---

## QĐ-039 · Model mới vào registry ở trạng thái PIN_ONLY, không phải ACTIVE

Đã xác nhận qua `/organization` rằng tài khoản có `wan3`, `wan3_prime`, `h3_max`,
`hailuo3`, `veo3.1_fast`, `gen4.5`. Đã thêm 5 dòng ứng viên.

**Tất cả đều `PIN_ONLY`.** Chưa model nào tạo ra một khung hình nào cho ta. Một
model rẻ trên giấy và chưa được kiểm chứng trong thực tế **không được** trở thành
lựa chọn mặc định của router chỉ vì nó rẻ nhất — đó chính là cách `gen4_turbo`
trở thành mặc định và rồi hỏng hai lần.

Lên `ACTIVE` là thứ **benchmark kiếm được**, không phải thứ **giá thắng được**.

---

## QĐ-040 · Một endpoint, nhiều schema — body phải dựng theo từng model

`/image_to_video` của Runway là **một** endpoint phục vụ model của nhiều hãng, và
chúng **không** dùng chung schema request. Adapter cũ gửi đúng một hình dạng
Gen-4 cho tất cả: `ratio` + `duration`, luôn luôn.

Nguyên văn tài liệu (đọc 2026-09-15):

> "MiniMax H3 Max supports `resolution` of `480p` or `768p`. Durations are 5–15
> seconds. **There is no `ratio` parameter.**"

Và model anh em `hailuo3` viết `768P` (hoa) **và có** `ratio`. Hai model MiniMax,
hai schema, lệch đúng một chữ cái.

**Quyết định:** một bảng `SIZE_STYLE`, không phải một câu `if`.

| Kiểu | Model | Gửi gì |
|---|---|---|
| `RATIO` | gen4_turbo, gen4.5, gen3a_turbo | `ratio: "720:1280"` |
| `RESOLUTION` | h3_max, wan3 | `resolution: "768p"`, **không có** `ratio` |

`toRunwayResolution()` lấy **cạnh ngắn** làm bậc (clip dọc 768×1280 là 768p,
không phải 1280p) và làm tròn **xuống** khi bậc không tồn tại — không bao giờ
lên. `wan3` là lý do: mặc định của nó là `auto_1080p` = 20 credit/s, gấp **bốn
lần** mức 480p.

Test khẳng định **chính các byte gửi đi**, không phải ý định. Vì một create bị
từ chối vẫn là một create, và dự án này chỉ cho phép đúng một POST mỗi lần duyệt
— sai schema không tốn một lần thử lại, nó tốn cả lượt.

---

## QĐ-041 · `RUNWAY_UNSUITABLE` chỉ buộc tội họ model đã gây ra nó

Cờ này ra đời khi "runway" và "gen4_turbo" là một. Điều đó đã hết đúng: Runway
bán lại model của MiniMax (`h3_max`, `hailuo3`), Alibaba (`wan3`) và Google
(`veo3.1*`) qua **cùng** endpoint. "Runway thất bại với cảnh này" không còn là
mệnh đề về bất cứ thứ gì — nó gọi tên một **cửa hàng**, không phải một model.

**Quyết định:** cờ chỉ chặn họ Gen-4. Một model MiniMax chưa từng thấy cảnh này
thì không thể đã từ chối nó.

Đây **không** phải nới lỏng an toàn thật. Khoá chính xác vẫn là
`ModelFailureEvidence` theo `(model, fingerprint)`, và nó vẫn chặn cứng đúng
request đó vào đúng model đó.

---

## QĐ-042 · "Có trong danh mục" ≠ "gọi được qua API" ≠ "đã benchmark"

Ba mệnh đề khác nhau, trước đây bị gộp vào chữ "LIVE" — và "live" bị đọc thành
"đã xác minh qua `GET /models`", một endpoint **trả 404**.

Cột `verification`, chỉ **tiến**, không lùi:

| Trạng thái | Nghĩa |
|---|---|
| `UNVERIFIED` | chưa có gì xác nhận |
| `CATALOG_LISTED` | tài khoản có liệt kê. **Chỉ vậy thôi.** |
| `API_CREATE_VERIFIED` | đã gửi create, được chấp nhận, có task id |
| `BENCHMARK_VERIFIED` | đã ra clip và có người chấm điểm |

Khoảng cách giữa hai dòng đầu là chỗ tốn tiền: danh mục liệt kê `h3_max` không
nói gì về việc adapter của ta dựng nổi một request hợp lệ cho nó.

Đồng thời đổi tên nguồn gốc theo **endpoint đã trả lời**, không theo mức độ tự
tin: `ACCOUNT_LISTING`, `ACCOUNT_LISTING_CACHED`, `MANUAL_DOCS`.

Và ba trục vẫn tách rời: `h3_max` hiện là `BENCHMARK_VERIFIED` **và** vẫn
`PIN_ONLY`. Một clip chứng minh đường ống thông, không chứng minh model nên làm
mặc định. `gen4_turbo` đã thành mặc định với đúng chừng đó bằng chứng, rồi hỏng
hai lần.

---

## QĐ-043 · `h3_max` chưa đủ ổn định cho LOW auto-routing — 3 mẫu, 1 hỏng camera

Ba mẫu, cả ba đều được API chấp nhận và trả về clip. Nhưng "API đạt" không phải
"dùng được":

| | Mẫu 1 | Mẫu 2 | Mẫu 3 | TB | Ngưỡng |
|---|---|---|---|---|---|
| Identity | 10 | 5 | 9 | 8,00 | ≥8 ✅ |
| Motion | 8 | 3 | 9 | 6,67 | ≥7 ❌ |
| Artifacts | 9 | 8 | 8 | 8,33 | ≥8 ✅ |
| Camera | 8 | **1** | 9 | 6,00 | ≥8 ❌ |
| Composition | 9 | 3 | 9 | 7,00 | ≥8 ❌ |

Mẫu 2: prompt ghi *"Static camera. No camera movement."*, model đẩy từ toàn thân
sang cận mặt trong 1,3 giây. PSNR đầu-cuối **8,4 dB** so với 15,2 và 16,2.

**Quyết định:** giữ `PIN_ONLY`. Không auto-route.

**Điểm quan trọng về phương pháp:** đừng đọc trung bình 7,4 rồi kết luận "gần
đạt". Phân bố mới là thứ đáng sợ: **9,1 / 4,3 / 8,9**. Đó không phải một model
trung bình khá — đó là một model *thỉnh thoảng hỏng nặng*. Với một dây chuyền
tự động, hỏng nặng một lần trong ba là hỏng cả video, và không ai ngồi xem để
bắt nó.

`gen4_turbo` cũng đạt ở mẫu đầu rồi hỏng hai lần sau. Đây là **cùng một hình
dạng dữ liệu**.

---

## QĐ-044 · `h3_max` là PROMPT-SENSITIVE, không phải bất ổn cố hữu

A/B đúng nghĩa: **cùng cảnh 5, cùng keyframe, cùng model/resolution/duration,
chỉ đổi prompt.**

| | Prompt cũ | Guardrail mới | Chênh |
|---|---|---|---|
| Camera | **1** | **10** | **+9** |
| Composition | 3 | 10 | +7 |
| Identity | 5 | 9 | +4 |
| Motion | 3 | 7 | +4 |
| Artifacts | 8 | 9 | +1 |
| **Overall** | **4,3** | **9,2** | **+4,9** |
| PSNR đầu↔cuối | 8,38 dB | **39,69 dB** | +31,3 |

**Kết luận: A — PROMPT-SENSITIVE.** `h3_max` dùng tốt ở LOW **nếu** chuẩn hoá
prompt camera.

### Tương quan đáng chú ý — giả thuyết, chưa phải kết luận

Trên cả 4 mẫu, **mọi prompt chứa chữ `locked` đều giữ được camera**:

| Mẫu | Câu về camera | `locked` | Camera |
|---|---|---|---|
| 1 | "Static **locked** camera." | có | 8 |
| 2 | "Static camera. No camera movement." | **không** | **1** |
| 3 | "Camera remains **locked** and stable…" | có | 9 |
| 4 | "**Locked** tripod camera. No zoom…" | có | 10 |

n=4, tương quan hoàn hảo nhưng mẫu quá nhỏ để gọi là nhân quả. Dù vậy nó **rẻ để
hành động**: cả hai đường dựng prompt của dự án (`VIDEO_GUARDRAILS` và
`COMPACT_CONSTRAINTS`) đều đã có chữ `locked`. Cảnh 5 thất bại vì dùng prompt
**cũ, viết tay**, chưa qua bộ dựng.

**Audit: 17/23 cảnh đang có `videoPrompt` không chứa `locked`**, phần lớn dài
12–118 ký tự — tức mô tả thô chưa từng qua bộ dựng guardrail. Đó là 17 quả mìn
cho bất kỳ lần chạy production nào.

### Cái bẫy suýt làm hỏng phép thử

`fitVideoPrompt` **thay toàn bộ khối ràng buộc** bằng bản rút gọn khi prompt vượt
1000 ký tự. Nếu prompt guardrail dài quá, chính đoạn camera đang được kiểm tra
sẽ bị xoá và phép đo trở thành vô nghĩa — mà không có lỗi nào báo ra. Prompt mới
được giữ ở **913 ký tự** và đã xác nhận `changed=false` **trước** khi POST.

### Ngưỡng

| | 4 mẫu | 3 mẫu có `locked` |
|---|---|---|
| Identity | 8,25 ✅ | 9,33 ✅ |
| Motion | 6,75 ❌ | 8,00 ✅ |
| Artifacts | 8,50 ✅ | 8,67 ✅ |
| Camera | 7,00 ❌ | 9,00 ✅ |
| Composition | 7,75 ❌ | 9,33 ✅ |
| | **KHÔNG ĐẠT** | **ĐẠT** |

Vẫn giữ `PIN_ONLY`. Chuyển `PIN_ONLY -> LOW_AUTO` là quyết định của người dùng,
và điều kiện đi kèm phải là **chuẩn hoá 17 prompt kia trước**.

---

## QĐ-045 · Guardrail camera dùng chung, hai chế độ, áp ở bước cuối

17/23 cảnh đang mang prompt **không có khoá camera** — tức 17 lần lặp lại đúng
clip đã chấm 1/10 về camera, đang chờ xảy ra. Sửa tay 17 chỗ là chữa triệu
chứng; lần thứ 18 vẫn sẽ tới từ một cảnh mới.

**Quyết định:** một bộ guardrail dùng chung trong code, áp **ngay trước khi gửi**
(`generateSceneVideo`), không phải sửa dữ liệu.

### Hai chế độ, và lý do không được khoá mù

| Chế độ | Khi nào | Guardrail |
|---|---|---|
| `LOCKED_CAMERA` | kịch bản chỉ tả cỡ cảnh, hoặc ghi rõ đứng yên | khoá camera + identity + framing + motion + **final frame** |
| `DIRECTED_CAMERA` | kịch bản yêu cầu pan/zoom/follow/đổi khung | "chỉ thực hiện chuyển động đã mô tả" + identity + framing + motion |

`DIRECTED` **không** nhận câu "No pan"/"No zoom" và **không** nhận luật
final-frame — một cú pan theo chủ ý được phép kết thúc ở khung khác. Cấm nó
chính là bắt model chọn giữa hai mệnh lệnh, mà "để model tự chọn" đúng là sự
bất ổn mà bộ guardrail này sinh ra để dập.

### Tín hiệu phân loại là cấu trúc, không phải dò chữ

Đọc `Scene.camera` — trường ý đồ camera do bộ sinh kịch bản ghi — và khớp theo
**động từ chuyển động** cùng **cấu trúc đổi khung** (`", then close on"`), chứ
không phải sự có mặt của chữ "camera". "Wide shot centered on desk" có chữ
camera-ngữ nhưng không di chuyển gì.

Ranh giới từ (`\b`) là bắt buộc: một cảnh thật của dự án là *"close on Max's
**panicked** face"* — thiếu `\b` thì nó bị đọc thành một cú **pan** và mất khoá
camera.

### Ba cái bẫy đã gặp khi xây

1. **Khoá camera phải nhận chữ `locked`, không phải `static`.** Clip chấm 1/10
   ghi *"Static camera. No camera movement."* rồi vẫn push-in. Mọi clip giữ được
   camera đều chứa chữ `locked`. Nên `"Static camera"` **không** được tính là đã
   khoá.
2. **Bộ dò mâu thuẫn tự báo động nhầm.** Chính câu guardrail *"No push-in."*
   chứa chuỗi "push-in" nên bị đọc thành một **yêu cầu** push-in — mọi prompt
   đúng đều bị báo là tự mâu thuẫn. Một cái chuông kêu cả khi không có cháy là
   cái chuông không ai nghe nữa. Đã thêm lookbehind phủ định.
3. **Idempotence là chuyện tiền, không phải chuyện gọn gàng.** Prompt nằm trong
   khoá idempotency; nếu mỗi lần chạy lại guardrail bị nối thêm, mỗi lần thử lại
   sẽ thành một **lần mua mới**. Có test khẳng định chạy hai lần cho kết quả
   giống hệt.

### Kết quả audit (miễn phí)

23 cảnh · 20 LOCKED · 3 DIRECTED · 0 chưa phân loại · 0 mâu thuẫn · 0 vượt giới
hạn · **17/23 thiếu khoá → 0/23**.

---

## QĐ-046 · Bằng chứng: bất ổn của h3_max là do prompt, đo bằng độ phân tán

| | 4 mẫu | 3 mẫu có `locked` |
|---|---|---|
| Điểm | 9,1 / **4,3** / 8,9 / 9,2 | 9,1 / 8,9 / 9,2 |
| Trung bình | 7,87 | **9,07** |
| **Độ lệch chuẩn** | **2,07** | **0,12** |
| Biên độ | 4,9 | **0,3** |

Độ lệch chuẩn giảm **17 lần**. Camera theo từng mẫu: 8 (locked) · **1 (không
locked)** · 9 (locked) · 10 (locked).

Đây mới là con số đáng đọc, không phải trung bình. Trung bình 7,87 gợi ý "model
khá"; phân tán 2,07 nói đúng bản chất: *"model thỉnh thoảng hỏng nặng"*. Và khi
biến prompt được kiểm soát, nó biến mất.

**Vẫn giữ `PIN_ONLY`.** Chuyển sang `LOW_AUTO` là quyết định của người dùng.

---

## QĐ-047 · `LOW_AUTO_CANDIDATE` — đề cử, không phải công tắc

Thêm một giá trị vòng đời mới, và điều quan trọng nhất về nó là thứ nó **không**
làm: `isAutoRoutable("LOW_AUTO_CANDIDATE")` trả **false**.

Đây là bản ghi rằng bằng chứng đã đủ để **xem xét**, tách khỏi việc công tắc đã
được gạt. Một trạng thái tự động định tuyến ngay khi được ghi sẽ làm cho chính
cuộc rà soát mà nó sinh ra trở nên bất khả thi.

`autoRouteBlock()` trả lý do riêng: *"ứng viên LOW_AUTO — đã đủ bằng chứng nhưng
CHƯA được bật"*, để người đọc log phân biệt được với một model bị chặn vì hỏng.

---

## QĐ-048 · Cổng LOW_AUTO hẹp có chủ đích, và LOCAL_MOTION luôn thắng

### Thứ tự là bản chất, không phải chi tiết

`decideMotion` chạy **trước**, và phán quyết LOCAL_MOTION của nó là **cuối
cùng**. Một cảnh làm được miễn phí thì vẫn làm miễn phí, kể cả khi nó vượt qua
mọi điều kiện trả phí.

LOW_AUTO sinh ra để **chặn clip trả phí đi nhầm model**, không phải để **tìm
thêm thứ để mua**. Một hệ thống âm thầm biến việc miễn phí thành việc tính tiền
là cách dễ nhất để mất ngân sách mà không ai từng ra một quyết định nào.

### Mười điều kiện, và vì sao hẹp

| Điều kiện | Lý do |
|---|---|
| `complexity = LOW` | ba mẫu tốt đều là LOW |
| có keyframe **thật trên đĩa** | mọi mẫu tốt đều là image-to-video; text-to-video chưa từng được đo |
| ≤ 2 nhân vật | lấy từ `COMFORTABLE_CAST` của module crowding |
| `LOCKED_CAMERA` | cả ba mẫu tốt đều khoá camera |
| không vật thể nhỏ dày đặc | đúng tín hiệu đã làm hỏng hai clip trả phí |
| model không DEGRADED/DEPRECATED | |
| prompt đã qua guardrail | |
| không mâu thuẫn prompt | |
| đủ hạn mức chung | |
| đủ ví nhà cung cấp | `null` ≠ `0` — xem dưới |

Trung bình 9,07 **không** phải giấy phép định tuyến mọi thứ mang nhãn LOW. Cả ba
mẫu tốt đều là **1–2 nhân vật, nền phẳng, camera khoá**. Cổng này mô tả đúng
hình dạng đó và không rộng hơn một chút nào.

### Hai chi tiết dễ làm sai

**`remainingUsd = null` không phải là hết tiền.** Nó nghĩa là nhà cung cấp tự
quản quota và ta không giữ ví cho họ. Coi null như 0 sẽ chặn vĩnh viễn mọi nhà
cung cấp tự tính tiền.

**Liệt kê mọi lý do chặn, không dừng ở cái đầu tiên.** Sửa một điều kiện rồi mới
gặp điều kiện tiếp theo là trải nghiệm tệ hơn hẳn việc được báo cả ba cùng lúc.

### Không đủ điều kiện thì đi đâu

`LOCAL_MOTION` nếu cảnh làm được tại máy → `NEEDS_KEYFRAME` nếu thiếu ảnh →
`NEEDS_PROVIDER` cho mọi lý do khác.

**Tuyệt đối không sang một model trả phí khác.** `gen4_turbo` DEGRADED sau hai
lần BAD_OUTPUT, `gen4.5` PIN_ONLY, Sora DEPRECATED — mỗi cái có một lý do đã
được viết xuống. Âm thầm chọn một trong số đó để cứu một cảnh là huỷ cả ba quyết
định cùng lúc, lặng lẽ, đúng lúc không ai nhìn.

---

## QĐ-049 — `LOW_AUTO` là một vòng đời riêng, không phải `ACTIVE`

**2026-09-16.**

Cách dễ nhất để "bật LOW_AUTO" là đổi `lifecycle` sang `ACTIVE`, và nó sai.

Không có gì trong registry giới hạn một model `ACTIVE` theo độ khó. Trần duy
nhất là `MAX_COMPLEXITY` trong `domain/video-suitability`, và bảng đó lúc ấy chỉ
có một dòng cho `gen4_turbo`. Nên cùng một thao tác cho phép `h3_max` nhận cảnh
LOW một nhân vật camera khoá **cũng** cho nó nhận cảnh HIGH ba nhân vật mà nó
chưa từng được đo.

Dry-run trên registry giả lập `ACTIVE` cho thấy chính xác điều đó: **6 cảnh
MEDIUM/HIGH, tất cả 3 nhân vật, tất cả không có keyframe**, rơi vào `h3_max`.

Vậy quyền phải tự mang theo giới hạn của nó, nếu không nó không còn là cái quyền
mà người duyệt đã đọc:

```
ACTIVE              router tự chọn, mọi độ khó
PIN_ONLY            chỉ chọn tay
LOW_AUTO_CANDIDATE  đã có bằng chứng, CHƯA được cấp
LOW_AUTO            router tự chọn CHỈ cho cảnh LOW
DEPRECATED/DISABLED không bao giờ
```

`isAutoRoutable()` vì thế nhận thêm tham số cảnh. Nó trả lời được cho `ACTIVE` và
`PIN_ONLY` chỉ bằng lifecycle, vì đó là thuộc tính của model. Nó **không** trả
lời được cho `LOW_AUTO`, vì đó là thuộc tính của **cặp** model–cảnh.

Không biết độ khó thì trả `false`. Một quyền có điều kiện mà điều kiện chưa ai
kiểm thì chưa được thoả mãn. `null`/`undefined`/`""` vẫn đọc là `ACTIVE` (cột có
default `ACTIVE`, giá trị trống chỉ đến từ fixture) và **không bao giờ** đọc
thành `LOW_AUTO` — suy ra quyền hẹp nhất hệ thống từ một trường bị bỏ trống là
cách trao nó cho mọi object quên set.

---

## QĐ-050 — Cổng `lowAutoEligibility` từng tồn tại mà không ai gọi

**2026-09-16.**

`lowAutoEligibility()` có 11 điều kiện, 17 test, và **không được production gọi
lần nào**. `grep` toàn bộ `src/`: chỉ xuất hiện trong chính nó, trong script
dry-run, và trong file test của nó. `routeScene()` — nơi thật sự tiêu tiền — có
đúng một cần gạt là `isAutoRoutable`, và cần gạt đó chỉ biết nói `ACTIVE`.

Nghĩa là mọi điều kiện trong cổng, xét ở production, **chỉ là trang trí**.

Điều này đáng ghi lại vì nó không giống một bug. Code đúng, test xanh, tài liệu
mô tả hành vi đúng. Thứ thiếu là một lời gọi. 824 test xanh trong khi dry-run
hỏng 7/10 chính là hình dạng của lỗi này: test chứng minh hàm chặn đúng *khi
được gọi*; không có gì chứng minh nó *được* gọi.

Đã sửa: `lowAutoRouteBlock()` đứng cạnh `autoRouteBlock()` và
`requiresExplicitPin()` trong bộ lọc của router — ba phản đối, cùng một hình
dạng `string | null`, cùng một danh sách.

**Fail closed.** Router gọi `routeScene` cho video mà không kèm dữ liệu cảnh thì
ứng viên `LOW_AUTO` bị từ chối, không phải được cho qua. Dữ liệu vắng mặt không
phải dữ liệu thuận lợi.

---

## QĐ-051 — Trần độ khó là ổ khoá thứ ba, độc lập

**2026-09-16.**

`"runway/h3_max": "LOW"` vào `MAX_COMPLEXITY`, và `"runway/h3_max": 2` vào
`MAX_CHARACTERS`.

Không phải vì lifecycle và cổng chưa đủ, mà vì cả hai **có thể sai**. Ba ổ khoá
độc lập trên cùng một cánh cửa: một bug ở bất kỳ ổ nào vẫn để cảnh MEDIUM không
với tới được model này.

Nó ràng buộc **cả ghim tay**, theo đúng hợp đồng sẵn có của bảng này (trạng thái
mềm hơn, không ràng buộc ghim tay, là `NEEDS_EXPLICIT_PIN`). "Chưa từng đo" không
phải một sở thích mà người dùng gõ tên model để bác bỏ được.

Hệ quả cụ thể và đã lường trước: cảnh 6 "Spill the beans" (MEDIUM, 2 nhân vật)
đang ghim `h3_max` và **giờ bị từ chối rõ ràng** thay vì bị tính tiền lặng lẽ.

---

## QĐ-052 — Khi `motionSource` lưu và `decideMotion` bất đồng: **miễn phí thắng**

**2026-09-16.**

Bốn cảnh lưu `AI_VIDEO` trong khi luật hiện tại nói `LOCAL_MOTION`. Pipeline đọc
trường đã lưu nên vẫn mua clip cho cả bốn.

Cả hai nguồn đều chính đáng, không cái nào là "sự thật":

- **lưu** — thứ người duyệt đã nhìn và đã duyệt. Pipeline đọc nó có chủ đích, để
  một lần sửa registry giữa lúc duyệt và lúc chạy không làm tiền dịch chuyển.
- **tươi** — `decideMotion` nói gì về cảnh **hiện tại**, sau phân loại lại.

"Mới nhất thắng" cho phép một lần phân loại lại **bắt đầu** tiêu tiền. "Lưu
thắng" cứ trả tiền cho quyết định mà luật đã đảo ngược. Nên luật theo **hướng**
chứ không theo thời gian:

```
MIỄN PHÍ THẮNG     một bên nói LOCAL_MOTION là xong
TRẢ PHÍ CẦN CẢ HAI AI_VIDEO chỉ khi hai bên đồng thuận
```

Đi từ trả phí sang miễn phí không cần ai duyệt: tiền không tiêu thì không làm ai
bất ngờ. Chiều ngược lại bị từ chối.

**Ngoại lệ: ghim tay.** Người đã nêu tên *cả provider lẫn model* là đã quyết định
mua một clip. Đó là một mệnh lệnh, không phải một mặc định để classifier bác bỏ.
Bỏ qua nó là đúng kiểu âm thầm đè quyết định, chỉ theo chiều ngược lại.

**Không sửa DB hàng loạt.** Bất đồng được log ở mức WARN
(`scene.motion_source_diverged`) trước khi sinh bất cứ thứ gì. Cập nhật hàng loạt
sẽ xoá đúng bằng chứng cho thấy hai nguồn từng bất đồng — thứ duy nhất cho phép
ai đó biết vì sao.

---

## QĐ-053 — Keyframe: thiếu ở đâu mới là lỗi

**2026-09-16.**

`h3_max` là image-to-video. Nhưng "chưa có keyframe" mang hai nghĩa khác hẳn
nhau tuỳ chỗ hỏi:

- **PLANNING** (trước bước tạo ảnh) — chưa có file là **bình thường**. Từ chối ở
  đây là kết án mọi dự án đúng lúc mọi dự án đều giống nhau.
- **VIDEO** (trước khi gọi Video AI) — chưa có file là **lỗi thật**. Đây là chỗ
  tiền dịch chuyển, và "lát nữa sẽ có" không phải một file.

Hai mã riêng: `keyframe_pending` và `needs_keyframe`. Cả hai đều chặn; chúng khác
nhau ở chỗ người vận hành nên làm gì. Báo "cảnh này không bao giờ chạy được" khi
câu trả lời đúng là "hãy tạo ảnh trước" sẽ khiến ai đó đi viết lại một cảnh vốn
không sai.

`pendingOnly` chỉ đúng khi keyframe là lý do **duy nhất** — có lý do thứ hai
nghĩa là cảnh có vấn đề thật và cái keyframe đang chờ không phải câu chuyện
chính. Thiếu `stage` thì hiểu là `VIDEO`: mặc định nghiêm hơn.

---

## QĐ-054 — Số dư `LIVE`, `CACHE`, `DECLARED` — và mặc định là 0

**2026-09-16.**

Setting ghi Runway có **975 credit**. `GET /organization` trả **671**. Lệch
**$3,04**, và mọi câu hỏi ngân sách trong app đều được trả lời bằng số 975 vì
không có gì ghi lại rằng đó chỉ là một *lời khai*.

Sổ nội bộ thì đúng: `CostEntry` runway $3,29 = 329 credit, và 1000 − 329 = 671.
Chỉ riêng con số ví là cũ.

Ba nguồn gốc, ghi lại chứ không suy diễn:

| | nghĩa |
|---|---|
| `LIVE` | vừa đọc từ hãng, kèm `checkedAt`. Là nguồn có thẩm quyền. |
| `CACHE` | bản sao của lần đọc LIVE gần nhất, **phải hiện kèm tuổi**. |
| `DECLARED` | người gõ vào. Mọi số của OpenAI đều thế — API key không đọc được số dư. |

`LIVE` **thoái hoá thành `CACHE` khi đọc ra khỏi SQLite**. Một dòng đã lưu chỉ
có thể là *bản sao* của một lần đọc, không bao giờ là chính lần đọc đó: tới lúc
đọc ngược ra, thời gian đã trôi và hãng có thể đã trừ tiền. Chỉ
`refreshRunwayBalance()` đúc ra `LIVE`.

**Default của ví Runway đổi từ 975 xuống 0.** Trước khi hỏi hãng, câu trả lời
trung thực là "không biết", chứ không phải một con số chép lại từ phiên làm việc
đã kết thúc. 0 sẽ chặn mọi việc trả phí cho tới khi đọc live thành công — đó là
chế độ hỏng có chủ đích: từ chối chi vì chưa biết số dư thì cứu được, chi dựa
trên số dư sai thì không.

Chỉ ghi khi **đọc thành công**. Một số cũ không bao giờ được đè lên một số mới
hơn — đó chính là cách 975 sống lâu hơn sự thật 304 credit.

Luật quy đổi ghi thành hằng số có tên: `USD_PER_RUNWAY_CREDIT = 0.01`, tức **100
credit = $1**. Nó là một **giả định**, không phải phép toán, và đã được đối chiếu
với một hoá đơn thật (clip cảnh 5: 25 credit cho 5 giây, hiện $0,25).

---

## QĐ-055 — Quyền chi cũ không tự động bao gồm một cơ chế mới

**2026-09-16.**

Lô `11af6ba6` được duyệt 2026-09-15: trần $0,90, dự toán một video đã nêu tên,
đã chi $0,441160, vẫn `APPROVED`, **còn $0,458840**, và dự án "Cold feet" vẫn trỏ
vào nó. Vừa đủ cho một clip `h3_max` $0,40.

Bật LOW_AUTO sau đó sẽ để router chọn một clip mà lúc duyệt không ai nhìn thấy,
rồi trả bằng phần thừa đó. **Người duyệt đã đồng ý một số tiền, không đồng ý một
cơ chế.**

Cột `lowAutoApproved` mặc định `false`. Mọi quyền chi ký trước khi LOW_AUTO tồn
tại giữ mặc định đó và **không bao giờ** trả được cho clip do router tự chọn, dù
còn bao nhiêu tiền.

Duyệt lại cũng **mất** quyền đó nếu không nhắc lại: `lowAutoApproved:
opts.lowAutoApproved === true`, không phải `?? auth.lowAutoApproved`. Duyệt lại
là một quyết định mới; mang quyền cũ đi theo sẽ biến một lần "có" thành vĩnh
viễn.

Nhân tiện: kiểm tra `wrong_batch` ở bước 2 **không thể nào kích hoạt** — `auth`
vừa được tìm *bằng* `input.batchId`. Giữ lại vì nó miễn phí và sẽ bắt được lỗi
nếu có ai đổi cách tra cứu. Nhưng nó **không** bảo vệ trước một quyền cũ trên
*cùng* một lô — đó là việc của bước 2b.

---

## QĐ-056 — Ghim tay đè được **nhãn**, không đè được **ngày**

**2026-09-16.**

Ghim tay bác bỏ **phán đoán** của router — model nào đáng tiền nhất cho cảnh này
— và không bác bỏ gì khác. Nhưng "không bác bỏ gì khác" hoá ra cần vạch ranh
giới cho chính xác, vì lần đầu tôi vạch sai và làm hỏng hai test đã có.

Lần sửa đầu chặn luôn mọi `DEPRECATED`. Nó mâu thuẫn trực tiếp với **QĐ-028**:

> *Chọn tay vẫn tới được. Deprecate là chặn **router** chọn, không chặn **người**
> chọn. Xoá hẳn đường đó sẽ biến một quyết định có ý thức thành chuyện bất khả
> thi.*

Ranh giới đúng đã có sẵn trong **QĐ-038**: *"Nhãn chỉ mới bằng lần cuối có người
sửa nó; **ngày là sự thật**."*

| | ghim tay | vì sao |
|---|---|---|
| `shutdownDate` đã qua | **chặn** | model đã tắt thật. Request bị mua rồi mới bị từ chối. |
| `DISABLED` | **chặn** | người vận hành đã tắt nó ở đây. Bật lại rồi hẵng dùng. |
| `enabled = false`, provider offline | chặn (sẵn có) | `isCapable` bắt từ trước, chưa tới nhánh này |
| `DEPRECATED`, ngày còn ở tương lai | **cho qua, kèm cảnh báo** | hôm nay nó vẫn chạy. QĐ-028. |
| `reliability = DEGRADED` | **cho qua** | QĐ-035: model bị hạ cấp mà không ghim tay được thì bị hạ cấp vĩnh viễn |

Yêu cầu là *"không được **tự động** bypass"* và *"trả cảnh báo rõ"*. Hai điều đó
được thoả bằng cách **nói ra**, không phải bằng cách từ chối: cảnh báo đi trong
`decision.reason` — nơi người vận hành thật sự đọc — kèm ngày tắt và
`replacementNote`.

Bài học lặp lại của dự án này: `isCapable` chưa bao giờ nhìn `lifecycle`. Mỗi lần
thêm một trục mới (`lifecycle`, rồi `reliability`, giờ là `LOW_AUTO`), câu hỏi
phải hỏi là *"đường ghim tay có đi vòng qua trục này không?"* — và mặc định câu
trả lời là **có**, cho tới khi kiểm tra.

---

## QĐ-057 — Hai cơ sở chi phí, không bao giờ so với nhau

**2026-09-16.**

Báo cáo trước so `$4,73` với `$2,646080` rồi kết luận "vượt hạn mức". **Sai cơ
sở.** $4,73 là tổng chi phí video của cả bốn dự án, gồm cả những clip đã ghim tay
từ trước và không liên quan gì tới LOW_AUTO. $2,646080 là tiền còn lại.

Công thức đúng:

```
additionalRequired = estimatedNewSpend - alreadyCommittedForThisRun
so additionalRequired với remainingGlobalBudget
```

Dry-run giờ in rời từng số kèm cơ sở của nó (A…I), và chỉ mang **E = phát sinh
mới** ra so với **C = hạn mức còn lại**. So D với C là trả lời một câu hỏi không
ai hỏi, và đọc lên thì giống một phán quyết về cái quyền trong khi nó là phán
quyết về cái dự án.

---

## QĐ-058 — Lời từ chối phải nói về đúng model bị chặn

**2026-09-16.**

Negative control A hỏi: *"cảnh MEDIUM thì h3_max có bị chặn không?"* Nó **bị
chặn**, nhưng thông điệp trả về là:

> *Cảnh này chỉ còn ứng viên chưa được chốt: openai/sora-2:720x1280
> (DEPRECATED), … openai/sora-2:720x1280: đã bị đánh dấu NGỪNG DÙNG (nhà cung
> cấp tắt ngày 2026-09-24).*

`h3_max` **không hề có tên trong đó**. Người vận hành hỏi vì sao h3_max không
chạy được trả lời bằng ngày tắt của Sora — một model không ai nhắc tới, bị chặn
vì một lý do không liên quan.

Hai lỗi riêng biệt, cùng một hình dạng:

**1. `pinOnly[0]` phát biểu thay cho cả danh sách.** Code lấy phần tử đầu tiên —
tức là dòng nào registry trả về trước — rồi mô tả **chỉ mình nó**. Một lý do cho
một danh sách ứng viên là thiếu đúng bằng số ứng viên còn lại. Giờ **mỗi model có
câu của riêng nó**.

**2. Model bị `MAX_COMPLEXITY` loại thì biến mất hoàn toàn.** `isCapable` loại nó
từ trước, nên nó không bao giờ tới được `pinOnly`. Trần cứng làm đúng việc của
mình **trong im lặng**, rồi thông điệp đi nói chuyện khác. Giờ những model bị
`checkSuitability` loại được liệt kê riêng kèm lý do đo được.

**3. Nhánh `no_capable_models` cũng vậy.** *"Không có mô hình nào đáp ứng yêu
cầu"* mô tả một tập hợp bằng sự rỗng của nó. `explainIncapable()` đã tồn tại sẵn
cho đúng việc này và **không được gọi ở đây**. Giờ nó được gọi, và chỉ cho model
đúng `type` — một route video không có việc gì phải giải thích vì sao các model
giọng đọc không đủ điều kiện.

**Vì sao đáng ghi:** một lỗi báo **sai tên model** tệ hơn một lỗi mơ hồ. Mơ hồ
thì người ta đi tìm; sai tên thì người ta đi sửa một thứ vốn không hỏng. Và nó
chỉ lộ ra vì negative control kiểm **nội dung lý do**, không chỉ kiểm "có bị chặn
không" — cả 9 ca đều trả về cùng một `RoutingError.code`, nên mã lỗi tự nó không
chứng minh được gì.

**Ghi chú về thứ tự bốn ổ khoá**, phát hiện khi viết control:

| Ca | Ổ khoá bắn trước |
|---|---|
| A. complexity MEDIUM | **trần cứng** `MAX_COMPLEXITY` (trước cả cổng) |
| E. LOW_AUTO_CANDIDATE | **`autoRouteBlock`** (trước cả cổng) |
| B, C, D, G, H | **cổng** `lowAutoRouteBlock` |
| F1, F2 | **`autoRouteBlock`** |

Kỳ vọng ban đầu của tôi cho A và E ghi là "cổng chặn" — sai, và test sẽ xanh
trong khi mô tả một nhánh code chưa từng chạy. Ổ khoá ngoài luôn bắn trước; đó là
thiết kế, nhưng phải viết đúng thì control mới có nghĩa.

---

## QĐ-059 — Bật LOW_AUTO cho h3_max, và cách chứng minh chỉ đúng một thứ đổi

**2026-09-16.** Người dùng đồng ý bật sau khi đọc dry-run 12/12 và 9/9 negative
control.

```
runway/h3_max:768x1280   LOW_AUTO_CANDIDATE -> LOW_AUTO
```

Chạy bằng `npm run lowauto:grant -- --apply`, tức đúng cơ chế đã xây, không phải
một câu `UPDATE` viết tay. Script tự từ chối nếu model không ở trạng thái ứng
viên, không `BENCHMARK_VERIFIED`, hoặc `reliability` khác `OK` — ba thứ mà bước
duyệt lẽ ra phải xác lập.

### Chụp ảnh trước/sau, không tin lời script

Script nói nó đổi một trường. Điều đó **không** chứng minh nó chỉ đổi một trường.
Nên trước khi chạy, toàn bộ 37 model và 23 cảnh được ghi ra JSON, và sau khi chạy
được so từng trường:

```
model bị đổi : 1 / 37   (chỉ runway/h3_max:768x1280, chỉ trường lifecycle)
scene bị đổi : 0 / 23
ProviderJob  : 102 -> 102
Reservation  : 3 -> 3
CostEntry    : 120 -> 120
ghim tay     : 6/6 giữ nguyên
```

Cách làm này đáng giữ cho mọi thay đổi registry về sau. Một script ghi DB và tự
báo cáo thứ nó ghi là một nguồn duy nhất tự xác nhận chính mình; ảnh chụp
trước/sau là nguồn thứ hai, và nó rẻ.

### Quyền đã bật nhưng đang ngủ, và đó là chuyện bình thường

Router tự chọn **0 cảnh**. Cả ba cảnh LOW còn muốn clip trả phí đều đang ghim
tay, mà ghim tay thì short-circuit phần chấm điểm — theo đúng thiết kế.

Đây **không** phải dấu hiệu bật hỏng. Nó là điều dry-run đã báo trước bằng
`E = $0,000000`, và là lý do việc bật lần này không làm dịch chuyển một đồng nào.
Quyền sẽ có tác dụng với **cảnh mới**, hoặc khi người dùng chủ động gỡ một ghim
tay. Không gỡ hộ: ghim tay là một mệnh lệnh, và gỡ nó để cho quyền mới có việc
làm là đúng kiểu tự ý đổi quyết định của người khác.

### Ba lớp vẫn chặn, kiểm lại sau khi bật chứ không trước

9/9 negative control chạy lại với `lifecycle = LOW_AUTO` **thật trong DB**, không
phải giả lập trong bộ nhớ. Mỗi ca vẫn bị chặn đúng lớp và đúng lý do. Kiểm trước
khi bật chứng minh mô phỏng đúng; kiểm sau khi bật chứng minh **production** đúng,
và chỉ cái thứ hai mới là thứ đang chạy.

---

## QĐ-060 — Một dẫn xuất, ba nơi gọi: dry-run không được trả lời khác production

Cổng LOW_AUTO nhận một túi dữ kiện về cảnh. Túi đó đang được **dựng tay ở ba
nơi**: đường chạy thật trong `services/generation.ts`, mô phỏng trong
`scripts/dry-run-low-auto.ts`, và bản chứng minh trong `scripts/prove-low-auto.ts`.

Ba bản chép tay của cùng một dẫn xuất không phải chuyện gọn gàng. Nó là cách để
**bản mô phỏng và thứ nó mô phỏng bất đồng về tiền**, âm thầm, trong khi cả hai
vẫn xanh test của riêng mình.

### Chúng đã bất đồng thật

| | `hasKeyframe` trả lời bằng gì |
|---|---|
| dry-run | `fs.existsSync(toAbsolute(imagePath))` — **nhìn vào đĩa** |
| production | `Boolean(scene.imagePath)` — **chỉ đọc cột** |

Một cảnh mà cột còn ghi tên ảnh nhưng file đã bị xoá: báo cáo nói **không đủ điều
kiện**, đường chạy thật nói **đủ**. Và đường chạy thật là đường tiêu tiền. Nó sẽ
POST một request image-to-video **không có ảnh** — đúng loại lỗi mà hãng tính
tiền trước rồi mới trả về hỏng.

Câu trả lời đúng là của dry-run. `h3_max` là image-to-video; **một cái tên file
không phải một tấm ảnh**.

### Cách sửa: `services/low-auto-facts.ts`

`deriveSceneVideoFacts(scene, opts)` — một hàm, ba nơi gọi. Nó trả về cả prompt
đã qua guardrail, để thứ mà cổng xét và thứ nằm trong request body là **cùng một
chuỗi**; dựng prompt hai lần là cách `promptGuarded = true` mô tả một prompt khác
với prompt thực sự rời khỏi máy.

Cái mà mỗi nơi gọi **vẫn tự cung cấp** là nửa thuộc về *môi trường* — ví từng
hãng và trần mỗi video. Chúng đọc từ chỗ khác, vào lúc khác, và nhét chúng vào
một hàm thuần sẽ là nhét một lần đọc database vào chỗ không nên có.

### Nơi gọi thứ tư, và nó đang nói dối về giá

Bộ dự toán (`cost-estimator` → `batch-planner`, `production-estimate`) **không hề
truyền dữ kiện cảnh**. Cổng fail-closed nên nó từ chối `h3_max` với lý do "không
nhận được dữ liệu cảnh", rồi bảng dự toán ghi:

```
VIDEO : $0.000000      canh 1, canh 4: NEEDS_PROVIDER
TOTAL : $0.297800
```

Trong khi đường chạy thật sẽ mua **hai clip h3_max, $0,80**. Tổng thật:
**$1,121800** — gấp 3,8 lần.

Đây là hỏng hóc tệ nhất trong nhóm này, vì con số đó chính là con số hiện trên
nút DUYỆT. **Trần duyệt thấp hơn hoá đơn** là cách duy nhất tệp này gây hại thật.

Nên bộ dự toán giờ nhận `lowAutoFacts` và thay **đúng một** giá trị:

```ts
hasKeyframe: scene.lowAutoFacts.hasKeyframe || wantsKeyframe
```

Dự toán chạy **trước** bước tạo ảnh, nên trên đĩa chưa cảnh nào có ảnh. Nhưng kế
hoạch đang được định giá **bao gồm** việc tạo keyframe đó, nên tới lúc gọi video
thì file có thật. Định giá đúng cuộc gọi sẽ thực sự xảy ra là câu trả lời trung
thực; trả lời `false` là dự báo $0 cho một video chắc chắn sẽ mua.

Nó là **dự báo, không bao giờ là giấy phép**. `stage` vẫn là `VIDEO`, không điều
kiện nào được nới, và `generateSceneVideo` vẫn dẫn xuất lại tất cả từ đĩa vào
đúng lúc tiêu tiền. Kế hoạch nói $0,40 mà pipeline không thấy ảnh thì pipeline từ
chối ở đó — nó chưa hứa gì cả.

### Bài kiểm tra mới

`tests/low-auto-facts.test.ts` giữ đúng điều này: cùng một input, ba nơi gọi
`routeScene` phải ra cùng provider, cùng model, cùng giá, cùng cờ `lowAutoRouted`;
và keyframe bị xoá phải bị từ chối ở **cả hai** phía, chứ không phải một.

---

## QĐ-061 — Đóng một lô dừng giữa chừng, mà không viết lại nó đã tiêu gì

Lô `11af6ba6` được duyệt 2026-09-15 với trần $0,90, tiêu $0,441160 rồi dừng. Thứ
nó để lại **không nằm im**:

```
6 job status=queued  (5 × generate_scene_media + 1 × render_final)
quyền chi APPROVED, còn $0,458840, scope ["groq","openai","runway"]
```

`claimNext` lấy job theo `priority` tăng dần, **không lọc theo lô**. Lần tới có
worker chạy — vì bất kỳ lý do gì, kể cả một lô khác hoàn toàn — sáu job đó đi
trước, trên một lô không ai theo dõi, trong đó có một cảnh ghim `gen4_turbo`
đang `DEGRADED` và **không có keyframe**.

Ước tính nếu chúng chạy: ~5 ảnh × $0,041 + 1 clip $0,25 ≈ **$0,456** — vừa đủ
vét sạch phần dư.

### Ranh giới

Huỷ việc **chưa xảy ra** là dọn sổ. Sửa bản ghi việc **đã xảy ra** là làm giả, và
hai thứ đó chỉ cách nhau một câu `deleteMany` cẩu thả.

| | |
|---|---|
| `CostEntry` | không đụng. $5,353920 vẫn là $5,353920 |
| `CostReservation` | không đụng. 2 COMMITTED + 1 RELEASED là **bằng chứng** — trong đó có dòng ghi Runway xác nhận không thu tiền clip hỏng |
| `LogEntry` | không đụng, và lần chạy này **ghi thêm** |
| `BatchAuthorization` | chỉ đổi `status`, qua `closeAuthorization`. `actualSpend` giữ nguyên, **không bịa hoàn tiền** |
| `Job` | `queued` → `cancelled`. Huỷ, **không xoá** |

### Điều kiện duy nhất có thể chặn việc này

Giữ chỗ **chưa chốt**. Một `RESERVED` nghĩa là có request còn đang bay, và đóng
quyền chi lúc đó sẽ bỏ rơi nó. Kiểm trước khi làm: **0**. Cả ba giữ chỗ đều đã
COMMITTED hoặc RELEASED, tức là đã thành lịch sử chứ không phải phụ thuộc.

`scripts/close-stale-batch.ts` mặc định là **thử khô**, và đọc lại DB sau khi ghi
để tự kiểm 5 điều thay vì tự báo cáo thứ mình vừa làm.


---

## QĐ-062 — Chạy tiếp một lô là câu hỏi khác với chạy một lô

Lô `a690a290` được duyệt 2026-09-17 22:27, mua đúng một tấm ảnh $0,041160 rồi
chết ở cảnh 1. Nguyên nhân **không** nằm trong lô: `runway/h3_max:768x1280`
không có trong `spend.confirmedProviders`, vì mỗi lần benchmark ngày 15/09 đều
xác nhận rồi thu hồi. Hai ổ khoá, và lô chỉ mở được ổ thứ nhất.

```
BATCH_SPEND_AUTHORIZATION  "được tiêu bao nhiêu"   -> đã qua, log batch.gate_passed
spend.confirmedProviders   "cặp model này đã được  -> CHẶN, ProviderNotConfirmedError
                            nhìn giá và đồng ý chưa"
```

### Vì sao không dùng `run-first-real-batch.ts`

Nó **bắt đầu** một lô. Chĩa vào một lô đã chạy dở thì làm ba việc sai:

| | |
|---|---|
| tạo `batch_expand` thứ hai | thay vì bám lại job đã có |
| chỉ vét job `queued` | đúng cái job `failed` — lý do của cả lần resume — không bao giờ được lấy |
| chặn khi cảnh có model trên row | lần đầu thì đó chỉ có thể là ghim tay; **sau** `startMediaForBatchVideo` thì đó là **plan đã duyệt viết xuống**, và chặn nó nghĩa là không lô nào resume được |

`scripts/resume-batch.ts` giữ nguyên cổng: mọi request trả phí vẫn qua
`runProviderJob`, cùng `idempotencyKey`, cùng quyền chi lô, cùng giữ chỗ trước
khi gửi, cùng chốt theo giá thật. Script **không** tự ghi bảng sổ nào.

### Hai thứ nó cố tình bỏ ra

**1. `evaluateScene`.** `handleSceneMedia` kết thúc bằng chấm điểm chất lượng, và
điểm dưới ngưỡng sẽ `retryCount++` rồi xếp lại cảnh. Tăng `retryCount` **đổi
idempotencyKey**, nên job xếp lại **mua lại cả ảnh lẫn clip** — $0,44 trên dự án
này — theo lời một quality model **mock**. Đây là lỗ rò tiền thật, không phải giả
thuyết. Luật của lần chạy này là một POST trả phí một lần, nên chuỗi cảnh được
chạy từng bước và bỏ hẳn bước chấm điểm.

**2. Job sinh ra giữa chừng.** Chỉ những job row **đã tồn tại lúc bắt đầu** được
chạy. Một job mới xuất hiện trong lúc chạy — đúng hình dạng của một quality retry
— bị bỏ lại chứ không được vét. Lần chạy này: **0 job mới**.

### Hỏi lại LOW_AUTO sau keyframe

Plan đóng băng đi vào `routeFor` như một **ghim**, và ghim thì được tôn trọng
**không qua cổng LOW_AUTO**. Đúng với ghim do người gõ, sai hoàn toàn với ghim
vốn là câu trả lời cũ của chính cái máy. Nên cổng được hỏi lại sau bước tạo ảnh
và trước khi POST clip, với `ignoreManualPin: true` — nếu để `manualPinElsewhere`
đúng như thực tế thì cổng sẽ từ chối trả lời chính câu hỏi của nó.

Kết quả: cảnh 1 `DAT` ngay từ dry-run (đã có keyframe từ hôm trước), cảnh 4
`CHUA DAT (needs_keyframe)` ở dry-run và `DAT` sau khi ảnh được tạo. Đó là hai
câu trả lời đúng cho hai thời điểm khác nhau, không phải một cái bất đồng.

### Bằng chứng idempotency, tính trước khi tiêu

Khoá của ảnh cảnh 1 được **tính lại từ prompt thật**, không phải đọc từ DB rồi
tin: `4f831cf3b899`, trùng `ProviderJob` completed `openai-image-8665db7a…`, file
còn trên đĩa. `runProviderJob` trả file đó về **trước** cổng ngân sách, giữ chỗ
và vendor. Chạy thật xác nhận: `provider.job.reused`, ảnh cảnh 1 **không** bị mua
lại, `retryCount` cả 6 cảnh vẫn **0**.

### Số liệu đối chiếu

```
credit Runway  671 -> 591   chênh 80 = 2 clip × 40   khớp $0,80 trong sổ
lô             $1,047095 / trần $1,24   chưa dùng $0,192905
giữ chỗ treo   0
POST trả phí   13 (5 ảnh + 2 clip + 6 voice); ảnh cảnh 1 KHÔNG nằm trong đó
```

Xác nhận `h3_max` được bật **tạm thời** trong `try` và thu hồi trong `finally`,
vì hệ thống chỉ có danh sách xác nhận **toàn cục**. Sau lần chạy, danh sách trở
lại đúng 6 mục như trước.

---

## QĐ-063 — Nhịp sai thì sửa khoảng lặng, không sửa lời

Cảnh 5 có thoại 4,0939s trong một cảnh 4,00s. `buildSceneTimeline` kéo dài cảnh
cho khớp — quyết định đúng, vì phương án còn lại là cắt mất chữ — nhưng nó đẩy
mọi mốc phía sau đi 0,09s: phụ đề cảnh 5 kết thúc ở 22,034 trong khi cảnh 6 lẽ
ra bắt đầu ở 22,000, và cảnh 6 vào trễ.

**Chỗ có thể lấy lại thời gian mà không ai nghe ra:** khoảng lặng của chính bản
TTS.

```
0,860 -> 1,161   0,3009s   nhịp ngắt sau "Cold feet"
2,482 -> 2,724   0,2420s   nhịp ngắt giữa câu
3,897 -> 3,964   0,0671s   khe trước "it."
4,023 -> 4,094   0,0704s   đuôi chết
```

`scripts/tighten-scene-pacing.ts` cắt **đuôi trước, rồi nhịp dài nhất**: đuôi
0,0704 → 0,03 và nhịp đầu 0,3009 → 0,1974. Kết quả 3,9500s.

### Ba ràng buộc nằm trong code, không phải trong lời hứa

1. **Mọi mép cắt rơi vào giữa một khoảng lặng `silencedetect` tìm được.** Không
   một mẫu tiếng nói nào bị bỏ, và không có bộ lọc nào co giãn thời gian — giọng
   nghe y hệt, chỉ bớt không khí.
2. **Sàn cứng:** nhịp giữa câu ≥ 0,15s, đuôi ≥ 0,03s, đầu ≥ 0,05s. Hết sàn mà
   vẫn chưa đủ thì script **DỪNG** và nói còn thiếu bao nhiêu, thay vì bào phẳng
   các nhịp hoặc động vào chữ. Viết lại lời thoại là việc của người vận hành.
3. **File TTS gốc không bị ghi đè.** Bản cắt là file mới; hàng `DialogueLine`
   trỏ sang nó. Muốn quay lại chỉ cần trỏ ngược — tài sản đã trả tiền vẫn còn.

### Đo lại sau khi render

```
video        26,09s -> 26,000s        (782 -> 780 frame)
cắt cảnh     5,03 / 9,03 / 13,03 / 18,03  (trễ 1 frame, đúng mốc 5/9/13/18)
phụ đề C5    18,000 -> 21,890         (trước: 18,000 -> 22,034, đè lên cảnh 6)
phụ đề C6    22,000 -> 24,431         (trước: 22,094, vào trễ)
nhịp còn lại 0,197 / 0,242 / 0,067    đúng như kế hoạch, trong bản trộn cuối
tiếng nói    kết thúc 21,92, cách cảnh 6 một khoảng 0,15s
cảnh báo mix KHÔNG còn audio_longer_than_scene
```

Cảnh 5 và 6 dùng cùng một bố cục nền phẳng nên `scene>0,3` không bắt được mối
nối ở 22s. Đó là tính chất của kịch bản, không phải render thiếu cảnh — mốc phụ
đề và thời lượng tổng đã chứng minh cảnh 6 nằm đúng chỗ.

---

## QĐ-064 — Prompt ảnh không có bộ dò mâu thuẫn, và cảnh 4 là hoá đơn

Hai clip h3_max của lô thật được chấm từ 5 khung hình mỗi clip cộng hai phép đo
không phụ thuộc mắt người: `scene_score` từng khung (ngân sách chuyển động, và
bằng chứng không có cut) và **độ lệch nền ở ba dải biên** giữa khung đầu và
khung cuối — nơi nhân vật không bao giờ đi tới, nên lệch ở đó là máy quay dịch.

```
cảnh 1  9,09/10   camera 10  motion 7   keyframeAdherence 8   promptAdherence 9
cảnh 4  8,91/10   camera 10  motion 8   keyframeAdherence 10  promptAdherence 6
```

Camera **10/10 cả hai clip**: biên trái/phải 1,13–1,85 YAVG, đúng mức nhiễu nền.
Guardrail camera đã làm được việc của nó trên dòng sản xuất thật.

**Điểm 6 của cảnh 4 không phải lỗi của h3_max.** Keyframe gửi vào là một Max
**đang cười** trên nền trống. Clip bám sát tấm ảnh đó — đúng nhiệm vụ của
image-to-video, nên `keyframeAdherence` 10 và `promptAdherence` 6 cùng đúng một
lúc. Chỗ hỏng nằm ở **bước tạo ảnh**, và có hai nguyên nhân khác nhau:

| | |
|---|---|
| kịch bản tự mâu thuẫn | "backwards **along the board**" cạnh "**nothing else in frame**" → ảnh bỏ cầu nhảy |
| bảng nhân vật đè cảnh | cảnh ghi "eyes stay wide"; bảng nhân vật lặp "always wide-eyed and eager" + "wide eager smile" → ảnh ra mặt cười |

`findPromptContradictions` chỉ soi `videoPrompt`. `buildSceneImageRequest` ghép
mô tả cảnh với bảng nhân vật rồi gửi đi mà **không ai đọc lại** — dù đây đúng là
lớp lỗi mà guardrail video sinh ra để chặn. Chưa sửa ở bước này vì sửa xong phải
tạo lại ảnh, tức trả tiền; ghi lại thành việc phải làm trước lô sau.

**Không đổi lifecycle/routing của h3_max.** Hai mẫu sản xuất là dữ liệu thật và
là lần đầu có dữ liệu loại đó, nhưng hai mẫu không đủ để đổi một luật định
tuyến, và đó là quyết định của người vận hành chứ không phải của một script.

---

## QĐ-065 — Prompt ảnh cũng phải có bộ dò mâu thuẫn, và "identity" không bao gồm biểu cảm

Vá lỗi QĐ-064. Đường video đã có `findPromptContradictions` từ hồi đo camera:
một prompt vừa cấm vừa xin cùng một cú máy thì model tự chọn, và lần chạy thành
một phép tung đồng xu không ai lặp lại được. Đường ảnh **không có gì tương
đương** — cảnh 4 của lô thật là hoá đơn cho chỗ trống đó.

### Cái bẫy nằm ngay trong thứ tự ưu tiên

Thứ tự đã chốt: `IDENTITY > CONTINUITY > ACTION > COMPOSITION > DECORATIVE`.

Áp máy móc vào cảnh 4 thì **bảng nhân vật thắng**, nụ cười ở lại, và bản vá sống
sót qua chính nó. Nó không được phép thắng, vì **biểu cảm chưa bao giờ là
identity**. Chính prompt nói thế: nhóm khoá gồm tóc, hình mặt, tuổi, da, chiều
cao, tỉ lệ, trang phục, phụ kiện — rồi câu ngay sau đó ghi *"Only pose,
expression and camera angle may differ"*. Một bảng ghi "wide eager smile" là
đang nêu **tâm trạng mặc định**, tức `DECORATIVE`; còn "his eyes stay wide" của
cảnh là `ACTION` của đúng khung hình đó. Action thắng decoration: bỏ nụ cười,
giữ nguyên cấu trúc khuôn mặt.

### Bảy luật, tất cả đều là bỏ bớt hoặc thay thế tại chỗ khớp

| Luật | Giữ | Bỏ |
|---|---|---|
| `action_vs_empty_frame` | hành động cần vật thể | "nothing else in frame" |
| `action_vs_static` | hành động | "completely static" |
| `expression_vs_sheet` | biểu cảm của cảnh | cụm tâm trạng trong bảng nhân vật |
| `framing_conflict` | camera (nơi có thẩm quyền về khung) | cỡ cảnh do mô tả tự thêm |
| `camera_move_in_still` | cỡ cảnh | pan/zoom/push-in — ảnh tĩnh không làm được |
| `object_present_and_absent` | câu liền mạch | cụm nhắc lại vật đã biến mất |
| `outfit_vs_locked_identity` | màu khoá của trang phục | màu cảnh tự đổi |

### Ba thứ giữ cho bộ guard không tự trở thành lỗi

1. **Đồng ý không phải mâu thuẫn.** Bảng ghi "always wide-eyed and eager" cạnh
   cảnh ghi "eyes stay wide" là nói cùng một điều hai lần — **giữ nguyên**. Chỉ
   cụm nào không giao nhóm nào với cảnh mới bị bỏ. Một bộ báo động kêu cả khi
   đầu vào đúng là bộ báo động sẽ bị tắt.
2. **Không sửa được thì nói là không sửa được.** `resolved: false` cho trường
   hợp không nhấc được cụm ra mà không làm hỏng câu; log kêu to hơn chứ không
   đẻ ra tiếng Anh què.
3. **Tất định từng byte.** Regex cố định, thứ tự cố định, chỉ xoá/thay tại span
   đã khớp. Bắt buộc, vì prompt bị băm vào `idempotencyKey`.

### Xoá chữ thôi chưa đủ

Ảnh tham chiếu **vẫn đang cười**. Khi một cụm biểu cảm bị bỏ, prompt được thêm
đúng một câu cố định ngay sau khối khoá: biểu cảm lấy từ mô tả cảnh, không lấy
từ bảng nhân vật hay ảnh tham chiếu. Đây là đòn bẩy duy nhất còn lại mà không
tốn tiền.

### Hệ quả phải nói ra: khoá ảnh của 3 cảnh đã đổi

Prompt đổi thì `idempotencyKey` đổi. Cảnh **1, 4, 5** có mâu thuẫn thật nên
prompt đổi và khoá ảnh **không còn khớp** ảnh đã mua; cảnh **2, 3, 6** sạch nên
khoá **trùng nguyên**. Không có gì tự chạy lại (lô `COMPLETED`, job `completed`),
nhưng nếu ai đó tạo lại media cho cảnh 1/4/5 thì đó sẽ là ảnh mua mới. Đúng chứ
không phải lỗi — prompt cũ sai — nhưng phải biết trước khi bấm.

**Chưa tạo lại ảnh cảnh 4 trong bước này.** Bản vá là code; xem nó ra ảnh thế
nào là một lần chi tiền, và đó là quyết định của người dùng.

---

## QĐ-066 — Import Storyboard V1: input thứ hai, **một** engine

V1 bắt đầu từ một ý tưởng và trả tiền cho text model nghĩ ra phân cảnh. Đúng
hình dạng khi **ý tưởng** là đầu vào. Sai hoàn toàn khi phân cảnh **đã có sẵn** —
viết tay, xuất từ bảng tính, hoặc storyboard nơi khác đã vẽ sẵn keyframe. Đẩy
chúng qua V1 nghĩa là trả tiền viết lại thứ đã viết, rồi trả tiền vẽ lại thứ đã
vẽ.

### Quy tắc kiến trúc, chỉ một câu

Module import **chỉ sinh ra ROW**. Mọi thứ sau "đã có cảnh trong DB" là code V1
đang dùng: `previewProjectCost` để dự toán, `BatchAuthorization` để duyệt,
`batch_expand` để khởi động từng video, `generate_scene_media` để chạy, spend
guard + reservation cho tiền, `resume-batch.ts` để chạy tiếp. Trong
`storyboard-import.ts` **không có đường nào chạm tới provider**.

Điều đó đạt được nhờ một mẹo nhỏ mà quan trọng: dự án nhập được tạo với
`status: "script_ready"` và `scriptJson` đã có sẵn. `handleBatchExpand` tìm thấy
dự án đã tồn tại, thấy nó ở `script_ready`, và gọi thẳng
`startMediaForBatchVideo` — **không sửa một dòng nào** của batch_expand.

### Hai cột mới, và vì sao không thể suy ra thay vì lưu

| Cột | Vì sao |
|---|---|
| `Scene.imageSource` | `generateSceneImage` không phân biệt được "ảnh người ta đưa" với "chỗ trống sắp lấp". Cơ chế chống trả tiền hai lần cũng bó tay: nó khoá theo `ProviderJob`, mà ảnh nhập sẵn **không có** ProviderJob nào. Thiếu cột này, lần chạy đầu của một storyboard sẽ **mua ảnh cho mọi cảnh vốn đã có ảnh**. |
| `Scene.motionMode` | `motionSource` là **quyết định**, và planner ghi đè nó mỗi lần lập lại kế hoạch. Một **chỉ thị** mà re-plan xoá được thì không phải chỉ thị. |

### `VIDEO_AI` là chỉ thị, không phải sở thích

QĐ-052 nói "miễn phí thắng": stored AI_VIDEO + fresh LOCAL_MOTION → LOCAL_MOTION,
**trừ khi** có ghim tay. Người gõ `motion_mode=VIDEO_AI` trong storyboard đang ra
đúng cái quyết định mà một ghim tay thể hiện, chỉ khác cách viết. Nên
`deriveSceneVideoFacts` — **một chỗ dẫn xuất duy nhất**, theo QĐ-060 — coi
`motionMode === "VIDEO_AI"` là pinned. Không có nó, luật "miễn phí thắng" sẽ âm
thầm hạ cấp đúng cảnh người dùng bảo phải mua.

### ZIP: từ chối là tính năng chính, không phải giải nén

`src/lib/zip.ts` tự viết thay vì thêm dependency, vì thứ khó không phải giải nén
mà là **từ chối**: một archive là input không tin được, và lỗi kinh điển là mục
tên `../../../.ssh/authorized_keys` mà bộ giải nén tận tình ghi ra đúng chỗ đó.
Ở đây tên được kiểm **khi đọc central directory**, trước khi chạm vào byte nào,
nên caller không thể quên. Nó cũng không ghi ra đĩa: trả về entry trong bộ nhớ,
service quyết định giữ gì.

Chặn: `..`, đường dẫn tuyệt đối, ổ đĩa, UNC, NUL, mục mã hoá, phương thức nén lạ,
ZIP64, quá 5000 mục, entry giải nén quá 64 MB (zip bomb), file quá 512 MB.

### Một lỗi bộ test bắt được trước khi nó ra đời

Bản đầu của `preflightImportedBatch` xếp `NEEDS_PROVIDER` **trước**
`OVER_VIDEO_BUDGET`. `planBatch` đã ghi sẵn lời cảnh báo cho đúng chỗ này: khi
trần/video là thứ router hết, **mọi** "không model nào hợp cảnh này" phía sau chỉ
là **triệu chứng**. Báo thành NEEDS_PROVIDER là đẩy người vận hành vào trang Mô
hình AI sửa một thứ không hỏng. Đã đảo lại đúng thứ tự của planner.

### Không có nút "nhập rồi chạy"

Lô nhập ra đời ở `PLANNED` + quyền chi `DRAFT` — **không chi được gì**. Duyệt một
con số là hành động riêng, trên trang lô, qua đúng cổng lô V1 đi. Một nút gộp
hai bước lại chính là thứ biến một lỗi gõ trong bảng tính thành hoá đơn.

### Phụ lục QĐ-066 — hàng Idiom rỗng là quả mìn trong bảng dùng chung

Bản đầu ghi `meaning`, `literalMeaning`, `exampleSentence` **rỗng** cho idiom do
import tạo, với lập luận: video nhập không bao giờ cần script nên không ai đọc
mấy ô đó. Sai, và bộ e2e bắt được — nhưng **không phải** ở file test của import:

```
✓ tests/storyboard-import.test.ts  (39 tests)      ← xanh khi chạy riêng
× pipeline.e2e > expands an APPROVED batch ...     ← hỏng ở file KHÁC
    → expected null to be truthy
× pipeline.e2e > does not create a second project ...
    → "meaning" String must contain at least 1 character(s)
      "exampleSentence" String must contain at least 1 character(s)
```

Thư viện idiom là **của dùng chung**. `selectIdioms` lọc theo
`status ∈ {unused, planned}`, nhưng bất kỳ đường nào khác cũng có thể chạm vào
một hàng — và `ScriptSchema` đòi `meaning`/`exampleSentence` không rỗng. Một
hàng có ô bắt buộc để trống **không hỏng lúc nhập**; nó hỏng lâu sau đó, trong
một lô V1 chẳng liên quan gì tới import, với thông báo lỗi chẳng chỉ về đâu cả.

**Luật rút ra:** hàng mà module này ghi phải là hàng phần còn lại của ứng dụng
dùng được. Text nay được **dẫn xuất từ storyboard**, không bịa: `meaning` từ
tiêu đề, `exampleSentence` từ câu thoại đầu tiên đã bỏ nhãn người nói. Và
`status: "imported"` — cố ý **không** phải `unused`/`planned`, vì một storyboard
đã nhập không phải gợi ý để làm video mới, **nó chính là video đó**.

Hai test mới giữ chỗ này: idiom nhập phải có đủ ba ô không rỗng, và không được
xuất hiện trong danh sách bộ chọn của V1.

---

## QĐ-067 — Chạy end-to-end mock của Import V1, và bốn lỗ nó lộ ra

Lần chạy đầu tiên của cả chuỗi nhập → render, bằng mock, trên **DB và thư mục
data riêng** (`scripts/import-e2e-mock.ts`). Riêng biệt là điều kiện, không phải
sự cẩn thận: một dòng chi phí mock ghi vào sổ thật sẽ nằm ngay cạnh tiền thật và
trông y hệt. DB đó được dựng bằng `prisma migrate deploy` chứ không phải
`db push` — cách duy nhất để biết migration trong repo có thực sự dựng đúng
schema mà code cần hay không.

Kết quả: **MP4 thật** 26,000s · 1080x1920 · 30fps · h264+aac, 2 clip Video AI,
4 cảnh LOCAL_MOTION, 6 keyframe nhập sẵn, 0 ProviderJob ảnh.

Bốn lỗ, không cái nào lộ ra ở test đơn lẻ:

### 1. Dự toán vẫn tính tiền ảnh cho cảnh ĐÃ CÓ ảnh

`$0,056` cho sáu tấm ảnh sẽ không bao giờ được mua. Đây là **đúng khoản tiết
kiệm** mà nhập storyboard sinh ra để có, và nó vô hình trong con số duy nhất
người dùng đọc trước khi ký. `PlannedSceneInput.hasSuppliedKeyframe` nay tắt
`wantsKeyframe`, và dự toán về $0,000000.

### 2. Cảnh VIDEO_AI có thể đi tới provider với prompt rỗng

`videoPrompt` nay **dựng sẵn lúc nhập**, tất định, từ chính các trường người
dùng viết: `<mô tả>. Movement: <hành động>. Camera: <camera>.` Không nhờ Text AI
— trả tiền để viết lại thứ đã viết là vô nghĩa. Và nếu một cảnh VIDEO_AI vẫn
không có gì để chuyển động thì **chặn ngay khi nhập**: tới lúc dựng request thì
lô đã được duyệt và tiền đã được hứa.

### 3. Lời dẫn bị nuốt im lặng

`parseDialogueLines` chỉ đọc narration khi cảnh có người nói — *"narration has
no speaker, and the first speaking character reads it only because someone has
to"*. Import đặt `speakingCharactersJson = []` khi không có dialogue, nên cảnh 3
(chỉ có lời dẫn) **render ra câm**. Danh sách rỗng không có nghĩa "đọc vô danh",
nó có nghĩa lời dẫn biến mất.

### 4. Sửa một cảnh hỏng xong, video vẫn treo mãi ở `rendering`

`handleRenderFinal` từ chối thẳng khi một cảnh đã bỏ cuộc — chờ một cảnh không
bao giờ có media là chờ vĩnh viễn — nên nó đốt hết lượt và kết thúc `failed`.
Sửa cảnh sau đó để lại video **thiếu đúng một job**, không có gì trong hàng đợi
để nhận ra: dự án nằm ở `rendering` mãi mãi, và triệu chứng duy nhất là một MP4
không bao giờ xuất hiện. `retryScene` nay xếp lại luôn bước render đã hỏng —
người bấm thử lại một cảnh là đang cố **hoàn thành video**.

### Nhân vật: không xây lại cái đã có

App đã có sẵn cả bộ máy nhất quán nhân vật: canonical sheet,
`LOCKED_ATTRIBUTES`, ảnh master đã duyệt, câu "giữ X giống hệt ảnh tham chiếu".
Import **không dựng lại gì cả** — nó chỉ điền `charactersPresentJson` để bộ máy
đó khớp bánh răng, và tạo `Character` khi tên là mới. Nhân vật đã tồn tại thì
**dùng lại, không ghi đè**: để một bản nhập viết lại mô tả canonical của "Max"
là âm thầm vẽ lại anh ta trong mọi video cũ được tạo lại sau này.

`character_id` khai ở cấp video, cảnh tham chiếu lại. Cảnh tự khai id mà video
không khai ở trên = **khai ngầm**, không phải lỗi; điều duy nhất thực sự quan
trọng là cùng một id thì cùng một người và cùng một ảnh tham chiếu.

### Sửa cảnh trước khi duyệt

Sửa được đủ những gì một dòng storyboard mang: chữ, thời lượng, motion mode,
ghim, ưu tiên. Hai thứ **tự dẫn xuất lại** thay vì hỏi: `videoPrompt` (từ mô tả
+ hành động + camera) và ai nói (từ việc có chữ hay không). Bản dự toán cũ bị
**huỷ** — con số người dùng ký phải là con số họ vừa nhìn, không phải con số UI
lặng lẽ tính lại sau lưng. Cảnh đã có ProviderJob thì khoá: công việc đã làm và,
trong một lần chạy thật, đã trả tiền.

### Migration

`prisma/migrations/20260918000000_init` dựng toàn bộ schema từ rỗng, gồm cả
`Scene.motionMode` và `Scene.imageSource`. Kiểm bằng cách chạy thật:
DB trống → `migrate deploy` → seed → nhập → chạy hết pipeline → có MP4.

---

## QĐ-068 — Lần nhập storyboard chạy thật đầu tiên, và hai lỗi tiền nong nó lộ ra

6 cảnh, 5 LOCAL_MOTION + 1 VIDEO_AI ghim `runway/h3_max:768x1280`, cả 6 keyframe
nhập sẵn. Trần $0,50. Thực chi **$0,400122**. Credit Runway **591 → 551** (đúng
40). MP4 25,000s · 1080x1920 · 30fps · h264+aac.

### Lỗi 1 — dự toán và hoá đơn bất đồng, đúng hướng tốn tiền

Preflight báo cảnh 3 là `LOCAL_MOTION $0,00`. Đường chạy thật sẽ mua clip
**$0,40**. Nếu không bắt được, người dùng sẽ duyệt một cái trần dựng trên $0,00
cho một video tốn $0,41.

`estimateProject` tự gọi `decideMotion` — hàm chỉ đọc **độ khó và mức ưu tiên**.
Nó không biết gì về `motionSource` đã lưu, cũng không biết gì về một **chỉ thị**
(ghim tay, hay `motion_mode: VIDEO_AI` trong storyboard). Trong khi
`deriveSceneVideoFacts` đã tính sẵn câu trả lời **mà pipeline sẽ hành động
theo** — nó đã đi qua `effectiveMotionSource`.

Đây đúng là lớp lỗi QĐ-060 đã đóng cho dữ kiện LOW_AUTO, còn sót lại **đúng một
chỗ vẫn tự dẫn xuất thay vì được cho biết**. Nay bộ dự toán dùng
`scene.lowAutoFacts.motionSource` khi có.

### Lỗi 2 — chạy lại một dự án đã tiêu gần hết ngân sách thì hỏng

Sau khi lô xong, chạy lại cảnh 3 ném `over_budget`: ngân sách dự án còn $0,10,
không đủ cho một clip $0,40. Nhưng cảnh đó **không cần mua gì cả** — clip đã trả
tiền, vẫn nằm trên đĩa.

`runProviderJob` có nhánh dùng lại, nhưng nó chạy **sau** router, và router từ
chối vì ngân sách. Thứ tự đó đúng cho một lần mua và sai cho một lần chạy lại:
một dự án gần cạn ngân sách chính là dự án **bắt buộc** phải được dùng lại thứ
nó đã mua. Hệ quả nếu để nguyên: resume làm dự án đứng hình ở `rendering` trong
khi chẳng còn gì để mua.

`generateSceneVideo` nay kiểm trước khi định tuyến: khoá tính **từ chính hàng
Scene** — model đã dùng, prompt như sẽ gửi bây giờ, thời lượng, `retryCount`.
Một lần retry có chủ đích (tăng `retryCount`) sinh khoá khác, không khớp, và đi
mua clip mới đúng như ý định.

### Một cổng của chính tôi hỏi sai câu

Cổng preflight hỏi "LOW_AUTO có tự chọn model này không" bằng
`ignoreManualPin: true` — và bị từ chối với `local_motion`. Đúng, nhưng lạc đề:
bỏ ghim ra thì cảnh này quay về LOCAL_MOTION, và cổng trả lời "ở đây không có gì
để mua". Luật motion của LOW_AUTO tồn tại để chặn **router** tự tìm thêm thứ để
mua; clip này được mua vì **người vận hành ra lệnh**. Câu hỏi đúng là: gạt việc
có một cái ghim sang bên, cảnh này có đạt **mọi điều kiện** h3_max đòi hỏi
không — LOW, một nhân vật, camera khoá, keyframe có thật, prompt đã qua
guardrail, không mâu thuẫn, nằm trong cả ba loại hạn mức.

### Bằng chứng

```
image POST 0 · video POST 1 · voice POST 6 · retry 0 · fallback 0
task h3_max        dd0a31dd-0dd0-44c0-a730-7836858af4aa
giu cho            7 COMMITTED, treo $0,000000
chay lai 6 canh    ProviderJob 7 -> 7, DELTA $0,000000
xac nhan h3_max    bat trong try, thu hoi trong finally — danh sach ve nguyen 6 muc
```

---

## QĐ-069 — Một cái ghim là việc **người** làm; cột model không nói được điều đó

`Scene.videoProvider` / `Scene.videoModel` mang **hai nghĩa cùng lúc**: trước khi
chạy là chỉ định của người vận hành, sau khi chạy là bản ghi
`generateSceneVideo` viết lại về model đã dùng. Không có gì phân biệt hai nghĩa
đó, nên **từ lần chạy thứ hai trở đi, mọi cảnh từng mua clip đều trông như đã
được ghim tay** — và ghim tay thì short-circuit toàn bộ định tuyến.

Đây chính là cái bẫy mà chú thích của `motionMode` đã viết ra từ trước, đọc
ngược lại: *một quyết định mà lần sau đọc lại thành mệnh lệnh thì không còn là
quyết định*.

### Ba hệ quả, không cái nào nhìn thấy được lúc xảy ra

| Ở đâu | Điều bị tắt |
|---|---|
| `routeScene` nhánh ghim | `lowAutoRouteBlock()` **không chạy** — các điều kiện mà quyền LOW_AUTO được cấp kèm theo thôi được kiểm lại |
| `assertBatchAuthorized` cổng 2b | `lowAutoRouted` trả về `false`, nên một quyền chi ghi rõ "chỉ các clip đã nêu tên" **trả tiền được cho clip router tự chọn** |
| `effectiveMotionSource` | thấy có "chỉ định", nên luật **miễn phí thắng** ngừng áp dụng đúng vào những cảnh **đã tốn tiền** |

Cái thứ ba là nặng nhất và ngược đời nhất: cảnh càng đắt thì càng khó quay về
$0.

### Lỗ thứ tư, cùng gốc: `routingMode` là một cờ cho ba quyết định

`regenerateSceneImageNow` ghim một model **ẢNH** bằng cách đặt
`routingMode = "MANUAL"` — cờ dùng chung cho cả ảnh, video và giọng. Ghim ảnh vì
thế cũng nói với router **video** rằng đã có người chọn model của nó.

### Lỗ thứ năm: phương án dự phòng mang cờ của người khác

`withFallback` nhân bản quyết định bằng `...decision`, nên một lần rơi xuống
model LOW_AUTO **thừa hưởng `lowAutoRouted: false`** của lựa chọn đầu vốn không
phải LOW_AUTO. Cổng 2b không có gì để bắn. Mỗi ứng viên nay tự mang câu trả lời
của chính nó (`RouteCandidate.lowAuto`).

### Cách sửa

Cột mới `Scene.videoModelPinned`, đúng một nguồn sự thật cho câu "có người chọn
không". Backfill dựng lại từ bằng chứng đã có trong hàng, **không bịa và không
mất cái ghim nào**:

```
routingMode = 'MANUAL'    -> ghim (4 cảnh Spill the beans)
motionMode  = 'VIDEO_AI'  -> ghim (cảnh 3 của lô nhập)
còn lại                   -> ghi lại của router, false
```

Kết quả trên DB thật: **5 ghim / 16 hàng có videoModel**. Hai cảnh `h3_max` của
lô `a690a290` — đúng hai cảnh router tự chọn — ở lại `false`, và đó là sự thật
về cách chúng được quyết định. Sổ chi không đổi: `CostEntry` 150 dòng
$6,801137, `ProviderJob` 123, `CostReservation` 24.

Kèm theo: `motionResolutionFor` (bước ẢNH) **thôi tự dẫn xuất** và gọi thẳng
`deriveSceneVideoFacts`. Nó là bản chép tay **thứ tư** mà QĐ-060 bỏ sót, và nó
sai thêm một thứ nữa — nó không biết `motionMode` là gì, nên một cảnh nhập ghi
`VIDEO_AI` là AI_VIDEO với bước video và LOCAL_MOTION với bước ảnh, **trong cùng
một lần chạy**.

Và nhánh LOCAL_MOTION thôi ghi đè `ffmpeg/local-motion` lên một cảnh đã ghim:
`effectiveMotionSource` vẫn đưa cảnh đã ghim vào nhánh miễn phí khi kế hoạch đã
duyệt là LOCAL_MOTION, và ghi dấu lên đó sẽ **xoá mất model người dùng chọn** mà
không còn đường khôi phục.

---

## QĐ-070 — Character Bible: cho mệnh đề khoá một giá trị để mà khoá

`LOCKED_ATTRIBUTES` nói với mọi prompt ảnh rằng **"apparent age"** và
**"skin tone"** không được đổi — từ ngày hệ thống nhân vật ra đời. Hàng
`Character` **chưa bao giờ có cột nào để nói hai thứ đó LÀ GÌ**.

Khoá một giá trị không ai phát biểu nghĩa là khoá đúng cái mà model đã ngẫu hứng
ở khung hình đầu tiên nó vẽ — mỗi dự án một kiểu. Với Max/Leo/Mia nó **vô tình**
chạy được, vì `visualPrompt` viết tay có sẵn "young adult male"; với một nhân
vật nhập từ storyboard, `visualPrompt` chỉ là
`"<tên>, consistent character design across every scene"`, và không còn gì cả.

Năm cột mới: `presentation`, `approximateAge`, `skinTone`,
`distinguishingFeatures`, `negativeIdentity`.

- `distinguishingFeatures` **tách khỏi** `accessories`: một cái kính có thể tháo
  ra giữa hai cảnh, một cái sẹo thì không — model bỏ mất cái thứ hai là đã vẽ
  người khác.
- `negativeIdentity` **tách khỏi** `negativePrompt`: gộp lại thì một luật nhận
  dạng ("đừng thêm kính") phải tranh chỗ với văn mẫu vệ sinh ảnh ("blurry, extra
  limbs"), và văn mẫu luôn thắng vì nó dài hơn. Nay identity đi **trước** trong
  danh sách, để nhà cung cấp nào cắt bớt thì cắt vào văn mẫu.

**Không một hàng nào đổi chuỗi canonical.** Tất cả mặc định `""`, và
`buildCanonicalDescription` bỏ qua trường rỗng — quan trọng vì chuỗi đó được
**băm vào khoá idempotency của ảnh master**. Một byte lệch là mua lại toàn bộ
ảnh nhân vật. Có test khoá đúng chuỗi cũ, từng byte.

### `promptIdentityBlock` là **dẫn xuất**, không lưu

Lưu nó ra một cột thứ hai tạo ra một bản sao có thể bất đồng với chính các cột
sinh ra nó — và bản sao mới là cái tới tay model.

### NEEDS_CHARACTER_REFERENCE, và hệ thống **không** tự vẽ

`characterReadiness()`: `NEEDS_CHARACTER_REFERENCE` → `NEEDS_IDENTITY_FIELDS` →
`READY`. Thiếu ảnh được báo **trước**, vì đó là thứ người vận hành phải **đưa
vào** chứ không gõ ra được. Import phát `character_needs_reference` mức **cảnh
báo**, và câu cảnh báo **nói thẳng rằng hệ thống sẽ không tự tạo ảnh** — không
nói thì người ta ngồi đợi một tấm ảnh không bao giờ tới.

Storyboard nay khai báo được cả Bible (11 trường, vài cách viết tên cột). Những
gì file **không nói thì để trống**: một giá trị bịa ra ở đây sẽ được dán vào mọi
prompt của nhân vật đó mãi mãi, và không ai biết nó là bịa. Nhân vật **đã tồn
tại thì không bị ghi đè** — import viết lại Max là redraw Max trong mọi video cũ
được dựng lại sau đó.

### Lỗi thật: "âm thầm tạo nhân vật mới ở từng cảnh"

`getCharacterSheetsByName` **bỏ qua** cái tên nó không tìm thấy. Đúng cho một
bản báo cáo, sai hoàn toàn ngay trước khi mua ảnh: tên biến mất khỏi danh sách,
prompt được dựng **không có khối nhận dạng nào** cho người đó, và model tự bịa
ra một người — bịa mới trong **từng cảnh**. Mọi bước đều báo thành công.

`requireCharacterSheetsByName` ném `UnknownCharacterError` và **nêu đích danh**
tên thiếu. Đường ảnh dùng bản này.

---

## QĐ-071 — "Cần tạo" khác "dùng lại", và bản dự toán phải nói được cả hai

`generateSceneVideo` kiểm khoá idempotency **trước** router (QĐ-068), nên chạy
lại một dự án đã xong thì trả về clip cũ, $0. Bộ dự toán không biết điều đó, nên
**báo giá lại clip đã mua**.

Phóng đại là hướng an toàn cho một cái **trần**, và là câu trả lời sai cho câu
hỏi đang được hỏi — *"lần chạy này tốn tôi bao nhiêu"*. Nó cũng làm khoản tiết
kiệm **tàng hình**: cả lý do để nhập storyboard kèm sẵn asset là không trả tiền
hai lần, mà bản xem trước lại không nói được.

### Ba trạng thái, không phải hai

`BUY` / `REUSE` / `NONE`. Một cảnh LOCAL_MOTION tốn $0 tiền video và **không dùng
lại gì cả** — chưa bao giờ có gì để mua cho nó. Gộp hai thứ lại thì bản xem
trước sẽ khoe "6 clip dùng lại" cho một lô chưa từng gọi model video.

`hasExistingVideo` và `hasExistingVoice` đều kiểm **trên đĩa**, không tin cột:
một cột trỏ tới tệp đã bị xoá không phải là một asset, và coi nó là asset sẽ báo
$0 cho một clip thật sự sẽ được mua — đúng hướng mà một bản dự toán không bao
giờ được sai. Giọng phải đủ **MỌI** dòng thoại: hai dòng mà mới có một tệp thì
vẫn phải mua dòng còn lại.

### Những gì bản xem trước còn thiếu, nay có

- **dòng RENDER = $0**, nói ra. Không thấy dòng render thì không phân biệt được
  "miễn phí" với "quên mất", và khác biệt đó quan trọng khi con số sắp được ký
  là một cái trần.
- **safetyMargin** tách khỏi `suggestedAuthorizedMaxSpend`. Người duyệt có
  quyền biết bao nhiêu là dự toán và bao nhiêu là phần đệm — hai thứ khác nhau
  để đồng ý.
- **providerWallets**, liệt kê **từng nhà cung cấp, không cộng chung**.
  `remainingUsd: null` nghĩa là "không giữ ví cho hãng này", phải hiện là
  *không rõ* chứ không phải $0,00.
- **counts**: image/video/voice, mua bao nhiêu và dùng lại bao nhiêu.

Và `buildPlannedScenes` thôi truyền cặp provider/model như một cái ghim: nó
truyền ghim **chỉ khi** `videoModelPinned` (QĐ-069). Bản dự toán phải hỏi đúng
câu mà pipeline sẽ hỏi.

---

## QĐ-072 — Khoá một thuộc tính không ai khai là một cái khoá GIẢ

`LOCKED_ATTRIBUTES` được dán nguyên văn vào **mọi** prompt ảnh, trong đó có
**"apparent age"** và **"skin tone"** — cho những nhân vật mà hàng dữ liệu không
nói gì về cả hai.

Câu đó không có gì để mà nghĩa. Model tự chọn một độ tuổi, rồi **chính câu lệnh
kia đi bảo vệ cái nó vừa chọn**. Mỗi lần chạy một kiểu, và mỗi kiểu đều được nói
bằng giọng của một quy tắc.

QĐ-070 làm nửa việc đúng (thêm cột để khai), nhưng lại bắt khai: `approximateAge`
và `skinTone` nằm trong danh sách **bắt buộc**, nên Max/Leo/Mia — ba nhân vật
viết tay đầy đủ nhất trong dự án — đều đọc ra `NEEDS_IDENTITY_FIELDS`. Một cái
form từ chối lưu khi thiếu tuổi chỉ dạy người ta **gõ đại một con số**, và con số
đó sẽ nằm trong mọi prompt của nhân vật đó mãi mãi, **không ai phân biệt được
với một sự thật**.

### Ba trạng thái, và định nghĩa lại cho đúng

```
NEEDS_CHARACTER_REFERENCE  không có ảnh tham chiếu nào
NEEDS_IDENTITY_FIELDS      có ảnh, nhưng KHÔNG một chữ nào mô tả ngoại hình
READY                      có ảnh + ít nhất một nét mô tả
```

`READY` **không có nghĩa là đầy đủ**. Nhân vật có ảnh và mới điền mỗi "tóc" vẫn
chạy ra sản phẩm nhất quán; phần còn thiếu đi vào `warnings` — lời khuyên, không
phải cái chặn. Yêu cầu một bộ hồ sơ đầy đủ trước khi cho nhập là đánh đổi sai:
nó chặn công việc vốn sẽ ra kết quả tốt, và đẩy người bị chặn sang chỗ bịa số.

`"unknown"` / `"not_specified"` / `"chưa rõ"` được nhận là **đã nhìn vào ô đó
rồi**, khác với để trống — nhưng **giống nhau ở chỗ không khoá**, và **không bao
giờ** lọt vào prompt: `apparent age: unknown` còn tệ hơn im lặng, vì đó là một
từ để model diễn giải.

### Mệnh đề khoá dựng từ cái có thật, mỗi nhân vật một dòng

Một dòng cho mỗi người, chứ không hợp nhất cả dàn: gộp lại thì "signature outfit
and its colours" sẽ đứng trước mặt một nhân vật chưa khai trang phục — đúng cái
khoá giả cũ, dựng lại ở cấp nhóm. Những gì không khoá được thì **giao cho ảnh**:

```
Keep RefMax identical to the reference: hair colour and hairstyle, face shape
and facial features, signature outfit and its colours, body proportions must not change.
Keep RefLeo identical to the reference: hair colour and hairstyle, accessories must not change.
Only pose, expression and camera angle may differ.
Every other aspect of their appearance must match the reference image exactly,
whether or not it is described above.
```

Câu cuối chỉ xuất hiện khi **có ảnh thật**. Không ảnh, không khai gì, thì không
nói gì — chứ không tuyên bố một cái khoá lên khoảng trống.

### Một nhân vật là một người, dù viết hoa kiểu gì

SQLite so chuỗi bằng collation BINARY, nên `findUnique({ name: "max" })` **trượt**
một hàng đang lưu `"Max"`, và người gọi vui vẻ tạo **người thứ hai**. Hai hàng,
hai khuôn mặt, một nhân vật dưới mắt người xem. `findCharacterByName` và
`getCharacterSheetsByName` nay gấp chữ hoa/thường; hai cách viết trong cùng một
cảnh chỉ ra **một** sheet, để giới hạn số ảnh tham chiếu của nhà cung cấp không
bị tiêu một suất cho bản sao.

### Ảnh tham chiếu trùng: cùng nội dung là cùng một ảnh

Nhập lại một storyboard là cách bình thường để sửa một lỗi gõ. Trước đây mỗi lần
nhập lại chép thêm một bản y hệt và ghi thêm một hàng `CharacterReference`. Khoá
theo **nội dung** (`sha256Bytes`), không theo tên tệp — tên tệp trong một cái ZIP
không phải là một danh tính.

### Fingerprint: phiên bản đi theo NGOẠI HÌNH, không theo giấy tờ

`identityFingerprint` băm đúng các trường ngoại hình. Sửa `notes`, `description`,
`seed` hay negative chung **không** tăng `version` — tăng version cho một lần sửa
chính tả là cách một ảnh chuẩn đã duyệt bắt đầu đọc ra là cũ.

### Và cái giá của việc đổi prompt: ảnh phải có đường DÙNG LẠI

Đổi mệnh đề khoá làm đổi chuỗi prompt, mà khoá idempotency của ảnh **băm chính
chuỗi đó**. Nghĩa là mọi cảnh đã xong bỗng trông như **chưa mua** — và lần resume
kế tiếp sẽ trả tiền lần thứ hai. QĐ-065 cũng từng đổi prompt và cũng có đúng lỗ
này; không ai để ý vì chưa ai resume sau đó.

Sửa không phải bằng một cái hash khôn hơn. Sửa bằng cách **người gọi nói rõ mình
đang làm gì**: `generateSceneImage(id)` là resume → dùng lại; `{ force: true }`
là người bấm "tạo lại ảnh" → được mua. Điều kiện dùng lại là **tệp có thật trên
đĩa + một ProviderJob ảnh đã hoàn tất** — chứ không phải chuỗi prompt, thứ sẽ đổi
mỗi lần guardrail tốt lên.

---

## QĐ-073 — Một lô là chỗ duyệt tiền MỘT LẦN, không phải một đơn vị công việc

Một thư mục ba storyboard là **ba việc** tình cờ được duyệt chung. Hệ thống lại
cư xử như thể nó là một: chỉ cần video thứ ba có một dòng sai là **cả lần nhập bị
từ chối**. Người dùng sửa dòng đó rồi nhập lại tất cả — và nhập lại chính là lúc
nhân vật trùng và ảnh tham chiếu trùng được sinh ra.

```
materialiseImport(..., { allowPartial: true })
  -> nhập các video sạch
  -> BỎ QUA video còn lỗi, và trả về `skipped[]` có TÊN + LÝ DO từng video
```

Mặc định vẫn **tắt**: không có gì được tự ý nhập ít hơn thứ người dùng đưa cho.
Và một lỗi thuộc về **nguồn** (ZIP hỏng, thư mục không đọc được) thì vẫn chặn cả
lô — không có tập con nào của lần nhập đó sống sót được.

### Mỗi video một vòng đời của riêng nó

```
IMPORTED · BLOCKED · READY · APPROVED · RUNNING · COMPLETED · FAILED
```

Dẫn xuất, không thêm cột: từ `Project.status`, quyền chi của lô, và phán quyết
dự toán — theo đúng thứ tự đó. Một video đã render xong thì **đã xong**, bất kể
bây giờ dự toán nói gì; một video đã hỏng thì cần đọc cái hỏng của nó chứ không
phải bản dự toán. Một video BLOCKED không làm hai video kia đọc không được.

### Màn hình `/import` nói hết trước khi ai duyệt tiền

Từ vựng trạng thái được giữ **phân biệt**, không gộp:

| | |
|---|---|
| `REUSE` | đã có, đã trả tiền rồi. $0, và là **tiết kiệm thật** |
| `LOCAL_FREE` | FFmpeg làm. $0, và **không phải tiết kiệm** — chưa bao giờ có gì để mua |
| `WILL_CREATE` | lần chạy này trả tiền |
| `READY` / `BLOCKED` | video chạy được / không, có nêu lý do |
| `NEEDS_REFERENCE` | nhân vật chưa có ảnh — mọi cảnh vẽ người đó đều là đoán lại |

Gộp `REUSE` với `LOCAL_FREE` thành một chữ "miễn phí" là phép đơn giản hoá hấp
dẫn, và là một lời nói dối về việc khoản tiết kiệm đến từ đâu.

Trang này **không gọi API nào**. Điều đó quan trọng hơn vẻ ngoài của nó: ngay khi
việc xem một bản kế hoạch bắt đầu tốn tiền, người ta sẽ thôi xem.

### Sửa hồ sơ nhân vật ngay trên trang nhập

Luồng mà nó tồn tại để phục vụ: nhập ba storyboard, thấy một nhân vật chưa có
ảnh, và phải sửa **trước khi** duyệt tiền. Bắt người ta sang trang khác, tìm nhân
vật, quay lại, dự toán lại — là cách bước kiểm tra đó bị bỏ qua.

Nhưng **không tạo gì**: đường duy nhất để một ảnh tham chiếu vào đây là **tải
lên**. Tạo ảnh chuẩn cho nhân vật là tiêu tiền, và đó là một quyết định phải được
bấm có chủ ý ở trang Nhân vật, không phải tác dụng phụ của việc dọn dẹp một lần
nhập. Đổi tên nhân vật thì **kéo theo các cảnh** trong cùng lô, nếu không thì cảnh
vẫn gọi một cái tên không còn ai mang và bước tạo ảnh sẽ từ chối tất cả.

### Dry-run chạy trên DB riêng

`scripts/import-batch-dryrun.ts` đi hết IMPORT → VALIDATE → CHARACTER RESOLVE →
ROUTING → COST PREVIEW rồi **dừng**. Nó dựng DB riêng từ migration, vì `Character`
**không thuộc về** cái lô đầu tiên nhắc tới nó: xoá lô đi vẫn để lại "BatchBo" nằm
trong bảng nhân vật thật mãi mãi. Một lần chạy khô mà làm bẩn bảng thật thì không
phải chạy khô. (Lần chạy đầu tiên của chính script này đã để lại 3 nhân vật + 2
dự án rác trong DB thật; đã dọn bằng tay, đối chiếu không có ProviderJob và không
có CostEntry nào dính vào.)

---

## QĐ-074 — Sàn chuyển động: h3_max chỉ được TỰ CHỌN cho cỡ động tác đã đo

Bảy mẫu đã chấm, sáu mẫu ≥ 8,69. Đọc như một giấy phép cho mọi cảnh LOW. Nhìn
vào **nội dung** sáu mẫu đó thì giấy phép hẹp lại rất nhanh:

```
canh 1  cúi đầu, mở to mắt                    9,10 / 9,09
canh 3  chớp mắt, nghiêng đầu rất nhẹ         8,69
canh 4  lắc đầu một cái, lui nửa bước         8,91
canh 5  giữ nguyên tư thế (A/B prompt)        9,20
canh 6  một cú đưa tay rồi hạ, một cái gật    8,92
```

Chớp mắt. Gật đầu. Một cú đưa tay. Nửa bước chân. `scdet` trung bình 0,00047 →
0,0023 — một tấm ảnh biết thở. **Chưa ai từng trả tiền cho model này vẽ người
đang chạy**, và đọc "độ khó LOW" thành "được phép thử" là suy diễn từ bằng chứng
không tồn tại, giá $0,40 một lần đoán.

`classifyMotionScale` xếp cảnh vào `SUBTLE / MODERATE / VIGOROUS` từ chính chữ
tác giả viết (`characterAction`, fallback `visualDescription`; **không** đọc lời
thoại — "tôi sẽ chạy" là một câu nói, không phải một động tác). Cổng LOW_AUTO
chỉ nhận `SUBTLE`, và **không biết thì chặn**: một điều kiện chưa ai đánh giá là
một điều kiện chưa được thoả.

Thêm `multiCharacterInteraction`: mẫu hai nhân vật duy nhất có Leo và Mia **lần
lượt** nói và gật, không chạm nhau. Phối hợp giữa người với người chưa được đo.

### Đây không phải phán xét về model

Ghim tay vẫn tới thẳng model, short-circuit trước toàn bộ phần này — như mọi
điều kiện LOW_AUTO khác. Không ai nói h3_max sẽ vẽ hỏng một cú chạy; chỉ là
**không ai biết**, và router không phải người nên bỏ $0,40 ra để biết.

### Đối chiếu trên toàn bộ 29 cảnh thật

```
SUBTLE 21 · MODERATE 3 · VIGOROUS 5
cả BA clip h3_max đã mua đều SUBTLE:
  Cold feet nhập #3  "blinks once and tilts his head very slightly"
  Cold feet lô   #1  "lowers his chin slowly, eyes widening"
  Cold feet lô   #4  "shakes his head once, then eases one short pace back"
```

Sàn này **không mâu thuẫn với bất kỳ lần mua nào đã xảy ra** — nó được hiệu
chỉnh theo chính các mẫu đó, chứ không phải đặt ra từ cảm tính. Cảnh MODERATE
duy nhất đang trỏ h3_max (`Spill the beans #5`) là **ghim tay**, không bị ảnh
hưởng.

`scripts/prove-low-auto.ts` nay có 13 negative control (thêm I1/I2/I3 cho cỡ
chuyển động và J cho tương tác), và bản thân script đã **thôi tự viết dữ kiện**
— nó lấy `motionScale` từ `deriveSceneVideoFacts` như mọi caller khác.

---

## QĐ-075 — Audit QĐ-065: bộ dò mâu thuẫn im lặng ở bốn dạng

QĐ-065 gắn bộ dò mâu thuẫn vào đường ẢNH sau khi cảnh 4 của lô thật đầu tiên trả
về một bức chân dung tươi cười trên nền trống. Nó đã chạy trên mọi ảnh từ đó, và
**chưa ai đọc kết quả của nó** trên văn phong storyboard viết tay.

`scripts/audit-image-guard.ts` đẩy tám dạng mâu thuẫn có tên qua bộ dò. **Bốn
dạng im lặng.** Im lặng từ một cái guard không phân biệt được với "không có gì
sai" — đó chính xác là cách cảnh 4 được mua.

### 1. Phủ định bị đọc thành yêu cầu

`"does not smile at all"` **chứa** chữ "smile", nên một từ điển chỉ tra từ đọc
một lời **cấm** thành một lời **xin** — rồi đồng ý với bảng nhân vật ghi "wide
eager smile", tức là đúng ngược lại điều cảnh yêu cầu. `NEGATED_SPAN_RE` cắt các
đoạn bị phủ định trước khi phân nhóm.

### 2. "serious" không thuộc nhóm biểu cảm nào

Không có nhóm thì không có mâu thuẫn. Thêm nhóm `SERIOUS`, tách khỏi `CALM`:
điềm tĩnh và nghiêm nghị là hai khuôn mặt khác nhau.

### 3. Không có luật nào cho TƯ THẾ

"stands ... while sitting" đi thẳng tới model. Thêm `posture_conflict`
(STANDING / SITTING / LYING / KNEELING). **Không tự sửa**: xoá vế nào cũng để
lại một câu đọc trôi chảy và mang nghĩa không ai viết, và guard không đoán được
vế nào là lỗi. Báo to, để người sửa câu.

### 4. Đám đông đứng cạnh "nothing else in frame"

Chính là thất bại QĐ-064, thay đạo cụ bằng người. Thêm `crowd_vs_empty_frame`:
giữ đám đông (đó là **nội dung** cảnh), bỏ câu văn mẫu.

### 5. Trang phục KHÁC HẲN, không chỉ đổi màu

Luật cũ bắt "red hoodie" chọi "yellow hoodie" — cùng món, khác màu. Nó **không**
thấy "red raincoat" chọi bộ khoá "yellow hoodie, blue jeans", vì cả "raincoat"
lẫn "wellies" đều không có trong từ điển trang phục. Thêm
`garment_vs_locked_identity` và mở rộng từ điển. **Không tự sửa**: viết lại "a
red raincoat" thành "bright yellow hoodie, blue jeans" giữa câu tạo ra thứ tiếng
Anh không ai viết, và hệ thống thật sự không phân biệt được một lần thay đồ có
chủ ý với một lỗi.

### Kết quả

8/8 dạng bắt được. Trên **29 cảnh thật**: 11 cảnh có phát hiện, **tất cả đều tự
xử lý được**, 0 cảnh treo — và **ba luật mới không kêu oan lần nào**, đúng như
mong đợi với văn phong của dự án này. **QĐ-065 đóng.**

---

## QĐ-076 — Một cái tên và một chỗ trống thì không vẽ được, ở bất kỳ giá nào

Nhân vật **không có ảnh tham chiếu VÀ không một chữ nào** mô tả ngoại hình là
một cái tên và một chỗ trống. Vẽ họ là mua một người lạ; vẽ họ ở cảnh sau là mua
một người lạ **khác**. Đó chính là thất bại mà cả hệ thống nhân vật sinh ra để
chặn, đến bằng một con đường trông như thành công.

Khác hẳn với "chưa có ảnh tham chiếu", vốn hoàn toàn bình thường: một hồ sơ viết
đầy đủ mà chưa có ảnh chuẩn chính là cách ảnh chuẩn được tạo ra. **Phải trống cả
hai vế** thì mới từ chối.

- `generateSceneImage` ném `GenerationError` **không thử lại**, nêu đích danh
  nhân vật.
- `preflightImportedBatch` đánh video đó `BLOCKED` với **status
  `NEEDS_CHARACTER_REFERENCE`** — người vận hành biết **trước khi duyệt tiền**,
  chứ không phải sau khi job ảnh đầu tiên hỏng.

### Tiền của video BỊ CHẶN không được nằm trong số sắp duyệt

Ban đầu tôi để `lifecycle` quyết định nhãn còn `status` quyết định tiền, nên một
video bị chặn vì nhân vật **vẫn được tính vào `estimatedTotal`**. Trần đề xuất
khi đó được dựng trên công việc sẽ không chạy. Một quyết định, hai kết quả:
`status` mới chi phối cả hai.

```
trước: du toan chay duoc $0,520800   de xuat tran $0,50   (gồm cả video bị chặn)
sau  : du toan chay duoc $0,246100   de xuat tran $0,28   ke ca video bi chan $0,520800
```

### Lỗi đã khai là KHÔNG thử lại thì đừng đốt lượt thử

`failJob` đếm số lần thử và **chưa bao giờ đọc** cờ `retryable` mà cả
`GenerationError` lẫn `ProviderError` đều mang. Nên một lỗi 401, một request sai
định dạng, hay một cảnh có nhân vật rỗng đều đốt sạch ngân sách thử lại để chứng
minh lại đúng một điều. Miễn phí ở các ca từ chối **trước** khi POST; **không**
miễn phí ở nơi nhà cung cấp đã nhìn thấy request — mỗi lần thử là một lần nữa nó
nhìn thấy.

Đọc theo **cấu trúc** chứ không theo tên lớp, để một lỗi đi qua ranh giới và mất
prototype vẫn giữ được nghĩa.

### Ba video, ba trạng thái, một lần khởi động lại

`tests/multi-video-resume.test.ts` — A xong, B dở, C bị chặn:

```
A  0 job mới, 0 hàng đổi, vẫn completed
B  chạy tiếp; ảnh cảnh 1 DÙNG LẠI (1 image job, không phải 2); cảnh 2 mới mua
C  hỏng riêng nó, nêu tên ResumeGhost, 0 ProviderJob
   -> A và B không bị dừng
retryCount  tất cả vẫn 0     ProviderJob  không trùng khoá
reservation không trùng      reserved = 0 (không treo đồng nào)
sau khi thêm ảnh cho C: CHỈ C chạy tiếp, A/B đứng yên tuyệt đối
```

---

## QĐ-077 — Nhập lại là một bản nhập MỚI, và phải nói thẳng ra như vậy

Nhập lại không phải ca hiếm; đó là cách bình thường để sửa một lỗi gõ. Nên câu
hỏi không phải "có xảy ra không" mà là "tốn gì", và câu trả lời phải là: không
tốn thứ gì không đáng.

**Dùng chung**: `Character` là một **con người**, và con người thì dùng chung qua
mọi lần nhập có nhắc tên. Ảnh tham chiếu của họ cũng vậy. Hai thứ này **không
bao giờ** được nhân đôi (QĐ-072 đã khoá theo tên gấp hoa-thường và theo nội dung
ảnh).

**Không dùng chung**: `Project` là một **việc**, và lần nhập thứ hai là một việc
thứ hai — thường mang theo bản sửa, vốn là lý do người ta nhập lại. Nó có dự án
riêng, cảnh riêng, lô riêng.

Thứ khiến điều đó **trung thực thay vì khó hiểu** là `Project.importFingerprint`:
băm nội dung storyboard (cast + cảnh, đã sắp xếp), **không** băm thư mục hay
thời điểm. Nhờ vậy:

- cùng byte → cùng vân tay → trang `/import` nói rõ *"đây là một bản nhập MỚI
  của storyboard đã từng nhập … hệ thống KHÔNG giả vờ dùng lại video cũ: đây là
  một video riêng, sẽ tốn tiền riêng"*;
- file đã sửa → vân tay khác → không bị nhầm thành bản trùng.

Và điều phải đúng bằng mọi giá: **nhập không tạo `ProviderJob` hay
`CostReservation` nào**, quyền chi cả hai lô đều `DRAFT`, trần đã duyệt = 0. Có
test khẳng định trực tiếp thay vì tin lời.

---

## QĐ-078 — Quyền chi trả lời "bao nhiêu", xác nhận trả lời "model này thì sao"

Lô `a690a290` qua được ổ khoá thứ nhất và **chết ở ổ thứ hai**, giữa chừng, sau
clip đầu tiên: `runway/h3_max:768x1280` không nằm trong `spend.confirmedProviders`
(QĐ-062). Từ đó tới nay **không có gì kiểm điều này ở lúc lập kế hoạch** — bản dự
toán vẫn báo OK cho tới đúng lúc request trả phí đầu tiên bị từ chối.

Preflight nay gom mọi cặp `provider/model` mà lô **sẽ thật sự trả tiền**, đối
chiếu với danh sách xác nhận, và đánh video đó `BLOCKED` với status mới
`NEEDS_PROVIDER_CONFIRMATION`. Hệ quả kèm theo, nhờ QĐ-076: **tiền của video bị
chặn ra khỏi `estimatedTotal`**, nên trần đề xuất không còn được dựng trên công
việc sẽ không chạy.

`mock` được miễn, và đó không phải lỗ hổng: `assertCanSpend` thoát sớm ở chế độ
mock vì một lệnh gọi mock không tốn gì. Đòi xác nhận cho nó sẽ chặn mọi bài test
mà chẳng bảo vệ đồng nào.

Luật được tách thành `paidModelsFor` — thuần, xuất ra ngoài — và test ở đó thay
vì qua cả đường ống, vì cổng này **chỉ có nghĩa khi tắt mock**, và một bài test
cần provider thật để chứng minh một luật an toàn là một bài test sẽ bị bỏ qua.

---

## QĐ-079 — Đừng tính tiền viết một kịch bản đã viết rồi

Storyboard nhập vào mang theo cảnh đã soạn. Dự án được tạo thẳng ở
`script_ready` và **không bao giờ có lệnh gọi model text nào**. Bộ dự toán vẫn
tính tiền cho một lần viết kịch bản — đúng cái sai QĐ-067 đã sửa cho keyframe có
sẵn: **định giá công việc đường ống sẽ không làm**, và giấu mất khoản tiết kiệm
vốn là lý do người ta nhập storyboard.

`EstimateInput.hasScript` tắt cả ba lệnh gọi (viết, tự chấm, metadata).
`previewProjectCost` truyền vào từ chính hàng dự án: `scriptJson` có nội dung
nghĩa là kịch bản đã tồn tại, bất kể nó tới từ bản nhập hay từ một lần chạy
trước.

Không chỉ là con số đẹp hơn. Ngân sách được **đi dần theo từng cảnh**, bắt đầu
từ tiền text — nên khoản text ma còn **ăn mất chỗ của cảnh cuối**. Trong lần
preflight thật, cảnh 5 của *Bite the bullet* mất ảnh vì lý do đó.

---

## QĐ-080 — Preflight sản xuất: giá thật, DB riêng, và không có nút nào để tiêu

`scripts/production-preflight.ts` trả lời đúng một câu — *"lô này có được duyệt
không, và bao nhiêu"* — bằng giá thật, registry thật, ví thật, rồi **dừng**. Cố ý
không có cờ nào khiến nó tiêu tiền.

### Chạy trên DB riêng, nhưng chép SỰ THẬT sang

Nhập tạo ra hàng: dự án, cảnh, và `Character` — vốn không thuộc về cái lô đầu
tiên nhắc tới chúng. Một bản preflight làm bẩn bảng production để trả lời một
câu hỏi về tiền thì không phải preflight.

Nhưng một DB sạch cũng **không trả lời đúng được**. Nên bốn thứ được chép sang
nguyên vẹn, vì câu trả lời phụ thuộc vào chúng:

| Chép sang | Vì sao |
|---|---|
| `ModelRegistry` | giá, vòng đời và độ tin cậy — cả ba đều đổi câu trả lời |
| `ProviderConfig` | quyết định **khả dụng**. Thiếu nó, mọi nhà cung cấp đọc ra "chưa sẵn sàng" và router từ chối mọi cảnh — trông y hệt một lỗi định tuyến, mà không phải |
| `Character` + ảnh | chép **nguyên id**: id là thứ ảnh tham chiếu trỏ tới, và nhân vật có ảnh thuộc về hàng khác là nhân vật không có ảnh |
| `StylePreset` | được dán vào mọi prompt ảnh, nên preset khác là đang định giá một bức ảnh khác |

Hạn mức thì **không** chép thẳng: phần "đã chi" nằm ở `CostEntry` không chép
sang, nên DB riêng sẽ đọc ra "chưa tiêu gì" và hứa một khoảng trống không có
thật. Thay vào đó cap được hạ xuống đúng **phần còn lại thật**
($8,00 − $6,801137 = $1,198863), khiến mọi phép kiểm ngân sách ở đây chặt đúng
bằng lần chạy thật.

### `AI_MOCK_MODE=false` nghĩa là gì và KHÔNG nghĩa là gì

Nghĩa là dùng giá thật trong registry và `costBasis` đọc ra `PRODUCTION_ESTIMATE`
thay vì `MOCK`. **Không** nghĩa là mua gì: mọi lệnh gọi ở đây đều là đọc, và lô
được để lại `PLANNED` + quyền chi `DRAFT`, vốn không cho tiêu một đồng. GET miễn
phí — số dư Runway — được phép và được ghi rõ là GET.

Bảy phép kiểm cuối cùng chứng minh điều đó thay vì tuyên bố nó:
`ProviderJob = 0`, `CostReservation = 0`, chi thật = 0, quyền chi DRAFT, trần đã
duyệt = 0, lô PLANNED, `CREATE_ATTEMPT_TOKEN` = null.

---

## QĐ-081 — Một con số bị cắt cụt im lặng còn tệ hơn không có con số

Bộ dự toán **đi dần theo ngân sách, cảnh này qua cảnh khác**. Cảnh nào không còn
chỗ thì không được định giá — và tổng in ra là **phần LỌT VÀO trần**, chứ không
phải chi phí của video. Nó đọc y hệt một cái tổng.

Tôi tự vấp đúng cái đó trong lần preflight thật: *Bite the bullet* báo
**$0,609900**, và cảnh 5 lặng lẽ mất ảnh vì ngân sách hết ở cảnh 4. Con số thật
là **$0,659300**. Chênh $0,0494 — vừa đủ để chọn sai mức trần cần nâng.

Video nào bị cắt cụt thì được định giá **lần thứ hai** với trần gỡ ra, và cả hai
con số đều hiện:

```
TONG VIDEO NAY   $0.609900 (phan LOT vao tran) — that ra $0.659300
BI CHAN VI       ... thật ra tốn $0,659300, vượt trần $0,60 một khoản $0,059300
```

Điều kiện kích hoạt là **BỊ CẮT CỤT**, không phải nhãn trạng thái. Bản sửa đầu
tiên của tôi kiểm `status === "OVER_VIDEO_BUDGET"`, và *Bite the bullet* lại
được gán nhãn `NEEDS_PROVIDER_CONFIRMATION` — cắt cụt y như cũ, mà kiểm theo
nhãn thì vẫn báo con số ngắn. Cắt cụt xảy ra khi ngân sách cạn, bất kể video đó
cuối cùng được gọi tên là gì.

Lần định giá thứ hai là tính toán thuần, không gọi nhà cung cấp nào, và chỉ chạy
cho video **đã biết là bị chặn**.

### Một test cũ từng xanh nhờ một khoản tiền ma

`estimatedTotalIncludingBlocked > estimatedTotal` từng đúng chỉ vì video bị chặn
vẫn mang khoản **text ma** mà QĐ-079 vừa bỏ đi. Bỏ khoản đó xong, một video bị
chặn vì ngân sách đóng góp gần **$0** — vì có gì được định tuyến đâu. Bài test
không sai về ý; nó khẳng định một bất biến mà chỗ dựa là một con số lẽ ra không
nên tồn tại. Nay nó khẳng định `uncappedCost`, tức là thứ nó vẫn luôn muốn nói.

---

## QĐ-082 — Một con số lấy từ hoá đơn khác một con số chép từ trang giá

`runway/h3_max:768x1280` vẫn ghi **$0,08/giây** như cũ. Thứ thay đổi không phải
con số, mà là **lời khai về nguồn gốc** của nó: `pricingSource` nói `MANUAL_DOCS`
— ai đó gõ lại từ trang giá Runway — trong khi dự án đã trả tiền **7 task thật**
và cả bảy đều nói đúng một điều.

```
b6fddf11 · d45c9a40 · c744478e · 3a314183 · d4f779ed · ced4ec15 · dd0a31dd
mỗi task 5 giây = 40 credit, 7/7 không lệch một lần nào, 15→19/09
```

Nên `pricingSource` thành `OBSERVED_CHARGE`, kèm `pricingCheckedAt`,
`lastVerifiedAt` và `sourceNote` trỏ thẳng vào bảng `VideoBenchmark`. Trường này
không bị enum ràng buộc, nên thêm một giá trị **trung thực hơn** không phá gì.

### Điều buộc phải nói thật

Thứ **quan sát được** là khoản trừ **credit**. Đồng đô la thì dựa vào giá công bố
$0,01/credit — Runway **không có endpoint nào báo con số đó**, nên riêng tỷ lệ
quy đổi ấy vẫn là `MANUAL_DOCS`, và `sourceNote` ghi rõ như vậy thay vì để người
đọc tưởng đô la là thứ đã nhìn thấy trên hoá đơn.

### Ba trục không được đụng tới

`verification`, `lifecycle`, `reliability` trả lời ba câu hỏi khác nhau, và
**không câu nào là "cái này giá bao nhiêu"**. Script đọc trước, ghi, rồi đọc lại
và khẳng định cả ba đứng yên — `BENCHMARK_VERIFIED` / `LOW_AUTO` / `OK` — thay vì
hứa suông. Nếu giá quan sát **lệch** với giá đang lưu, script **dừng**: một con số
lệch là một câu hỏi, không phải một lỗi gõ để tự sửa.

### Nguồn gốc và chữ ký là hai việc

`pricingSource` nói giá **ở đâu ra**. `spend.confirmedProviders` nói **người**
đã đồng ý trả. Gộp chúng lại nghĩa là cải thiện một trích dẫn thì lặng lẽ cấp
quyền tiêu tiền — đúng thứ thiết kế hai ổ khoá sinh ra để chặn. Nên script ghi
hai chỗ, bằng hai lệnh, và chỉ chạy lệnh thứ hai vì **bạn đã nói ra**.

Đây là ổ khoá đã làm lô `a690a290` chết giữa chừng (QĐ-062), và là thứ QĐ-078
kéo lên tận lúc lập kế hoạch. Nay nó mở — hợp lệ.

---

## QĐ-083 — Mục tiêu mềm là thứ người ta nói ra, không phải số sót lại từ lần trước

Preflight có ba ngưỡng: trần mỗi video, trần cả lô, và một **mục tiêu** $0,90 từ
đợt trước. Đợt này bạn đặt lại hai trần ($0,70 / $1,00) và **không nhắc tới mục
tiêu** — nhưng `--target` vẫn mặc định $0,90, nên lô $0,906600 mà bạn vừa cho
phép bị báo HỎNG vì lệch $0,0066.

Một lô **được duyệt** mà bị đánh trượt trông y hệt một lần vượt ngân sách thật,
và đó là kiểu cảnh báo dạy người ta bỏ qua cảnh báo. Nay `--target` **chỉ được
kiểm khi bạn truyền vào**; không truyền thì không có mục tiêu nào để trượt.

Hai trần cứng **không** đổi: vẫn kiểm mọi lần, và đã chứng minh bằng một lần
chạy ngược — `--max-batch 0,50` cho ra NOT READY, và quan trọng hơn, dự toán
vẫn báo **$0,906600** chứ không tự co xuống cho vừa $0,50. Đúng thứ QĐ-081 sửa.


## QĐ-084 — Dự toán hỏi đúng câu mà bước tạo ảnh hỏi

Chạy lại lô thật `4d18d1a9` sau khi nó đã xong: preflight báo **10 ảnh
WILL_CREATE, $0,48**, trong khi `generateSceneImage` sẽ dùng lại cả 10 (nó dùng
lại theo **file + ProviderJob ảnh completed** từ QĐ-072). Hai nơi trả lời cùng một
câu hỏi bằng hai luật khác nhau. Hướng sai là hướng "an toàn" cho một cái trần,
nhưng nó làm cổng resume **từ chối** một lần chạy không thể tiêu đồng nào
($0,4944 > $0,387 còn lại), và preflight nói WILL_CREATE cho thứ đã sở hữu.

Nay `buildPlannedScenes` đặt `hasExistingImage` bằng **đúng** vị từ đó, và bộ dự
toán coi nó như ảnh nhập sẵn: $0, REUSE. Test ở cả hai tầng (hàm thuần + DB).

## QĐ-085 — Dùng lại không phải là mua, nên không ghi sổ

`runProviderJob` trả về một asset $0 khi khoá idempotency đã xong, rồi
`saveAsset` ghi thêm một hàng `Asset` và một dòng `CostEntry` $0 — mỗi câu thoại,
mỗi lần resume. Tổng tiền không đổi, nhưng sổ cái lớn lên theo mỗi lần chạy **không
tốn gì** (10 dòng cho một lần chạy lại lô 2 video), và "CostEntry delta" không còn
đo được "có mua gì không". Nay kết quả reuse mang `meta.reused` và `saveAsset` bỏ
qua. Giao dịch gốc vẫn giữ nguyên hàng của nó.

## QĐ-086 — Script chạy lô viết trạng thái bằng luật của runner, không tự đặt tên

`run-real-multi-batch.ts` từng ghi `PARTIAL` vào `Batch.status` — không có trong
`BATCH_STATUSES`, trang lô sẽ hiện một trạng thái lạ — và để lô ở PLANNED, dự án ở
`script_ready` suốt lúc đang tiêu tiền. Nay: lô RUNNING khi bắt đầu, video
`media_generating` → `failed` (nếu dừng), chốt cuối bằng `settleBatchIfDone` (cùng
luật với hàng đợi: hỏng một phần = NEEDS_REVIEW).

Thêm `--resume`: **không bao giờ** duyệt lại quyền chi; video đã xong chỉ được đi
qua để chứng minh REUSE, không đổi trạng thái, không render lại; quyền chi đã đóng
thì mọi POST bị chặn ở gateway (reuse được kiểm **trước** cổng).

## QĐ-087 — Nhãn trạng thái không được đổi theo lịch

`autoRouteBlock` có nhánh "ngày tắt đã qua" đứng trước nhánh DEPRECATED, và câu của
nó không có chữ NGỪNG DÙNG. Từ 2026-09-24 (ngày Sora tắt) cùng một lời từ chối đổi
câu và mất nhãn — 2 test đỏ chỉ vì đồng hồ. Model vẫn bị chặn đúng; nay câu giữ
nhãn khi lifecycle là DEPRECATED.

## QĐ-088 — V1.0.0 đóng băng phạm vi

V1 phát hành với đúng những gì đã chạy thật. Mọi thứ sau đây là V1.1/V2 và **không**
được kéo ngược vào V1: đổi tên trạng thái lô sang DRAFT/READY/BLOCKED, ô sửa MAX
PER VIDEO/MAX BATCH mặc định, benchmark model PIN_ONLY, provider mới, chạy lô thật
qua hàng đợi thay vì script.

## QĐ-089 — Trần/video của lô nhập phải tới được cái gateway đọc

Final QA trên trang lô thật: ô "Hạn mức / video" hiện **$2,50** cho lô được duyệt
$0,70. `materialiseImport` tạo quyền chi DRAFT chỉ với `status`/`authorizedMaxSpend`/
`estimatedCost`, nên `maxCostPerVideo` lấy mặc định schema ($2,50) — và đó là con số
`assertBatchAuthorized` so sánh. Preflight chỉ cập nhật `estimatedCost`. Phạm vi nhà cung
cấp rỗng (nghĩa là không giới hạn) và dự toán từng dự án $0.

Nay lúc nhập ghi đúng trần/video + số video; preflight cập nhật trần/video, phạm vi
nhà cung cấp (đúng danh sách người vận hành nhìn thấy) và dự toán từng dự án. Lô đã
chạy không bị sửa hồi tố: bản ghi của nó nói đúng điều gateway đã áp lúc đó.

## QĐ-090 — Phát hành V1 lên `main` của remote, giữ `master` ở máy

Repo `mddesignart-tech/batch-video-factory` (public) rỗng lúc push, branch mặc định
`main`. Code ở máy nằm trên `master`. Đẩy `master:main` thay vì đổi tên branch ở máy:
không đổi branch, không force, không viết lại lịch sử — một repo rỗng nhận lịch sử
70 commit nguyên vẹn. `master` ở máy track `origin/main`.

Trước khi đẩy lên một repo **public**, đã quét **toàn bộ lịch sử** (không chỉ cây
hiện tại): không `.env`, DB, media lớn hay chuỗi giống API key nào — chỉ vài chuỗi giả
dạng `sk-live-…` trong test về che key (đã thay bằng placeholder rõ ràng, QĐ-091).

Tag `batch-video-factory-v1.0.0` trỏ `e5c8b73`. Tài liệu viết sau khi push nằm ở
commit sau đó và **không** kéo tag theo: tag đã công khai thì không di chuyển.

## QĐ-091 — Dữ liệu giả trong test không được trông giống key thật

Repo nay public. Test về mã hoá/che key dùng các chuỗi dạng `sk-live-…` — giả, nhưng
đúng hình dạng key của một nhà cung cấp, nên bộ quét secret và người đọc đều không
phân biệt được. Đã thay bằng `fake-api-key-for-test-only`; riêng test "che key nằm
trong chuỗi" kiểm việc nhận diện **theo hình dạng**, nên dùng
`api_FAKE_TEST_ONLY_NOT_A_KEY` — khớp luật che của logger, không khớp định dạng của
hãng nào. Regex `/sk-live|Bearer /` trong `pipeline.e2e` là bộ dò rò rỉ, giữ nguyên.

Các chuỗi giả cũ còn trong lịch sử Git; không viết lại lịch sử để xoá chúng vì chúng
chưa bao giờ là secret. Commit housekeeping sau V1 — tag V1 không di chuyển.

## QĐ-092 — Branch ở máy đổi thành `main`; GitHub Release gắn vào tag có sẵn

`master` ở máy đổi tên thành `main` và track `origin/main`, sau khi kiểm working tree
sạch và `master` chỉ đi TRƯỚC `origin/main` (1/0), không đi sau. Đổi tên branch không
đụng lịch sử. Từ nay `git push` / `git pull` trơn, không cần `master:main`.

GitHub Release "Batch Video Factory V1.0.0" tạo qua giao diện web bằng phiên đã
đăng nhập của người dùng (máy không có `gh`, và không lấy token từ credential
manager). Trang báo "Existing tag", nên release gắn vào tag đã public — tag object
`e4d1be1` -> `e5c8b73` đọc lại sau khi publish, không đổi.

Quét lần cuối: key thật trong `.env` không xuất hiện trong mã nguồn lẫn lịch sử.
Các fixture `sk-test-not-a-real-key` / `gsk-test-…` cũng đổi sang
`fake-api-key-for-test-only` cho nhất quán với QĐ-091.

## QĐ-093 — Ảnh nhập là một Asset IMPORTED, không phải một đường dẫn

Ảnh người dùng đưa vào trước đây chỉ là một file chép vào `images/` với
`Scene.imageSource = IMPORTED`: không biết tên gốc, kích thước, loại thật, và thay ảnh
thì mất dấu ảnh cũ. Nay mỗi ảnh nhập là một dòng `Asset` (`source: IMPORTED`, tên gốc,
mime đọc từ BYTE, rộng/cao, sha256, `actualCost 0`) và `Scene.imageAssetId` trỏ tới ảnh
đang dùng. `Scene.imageSource` vẫn là nguồn sự thật của "cảnh này có phải ảnh nhập" —
không có bảng hay cột trùng vai trò. Cùng một ảnh nhập hai lần trong một dự án: một
file vật lý, hai Asset (mỗi lần dùng là một dòng).

**IMPORTED IMAGE = REUSE = $0 IMAGE API COST.** Module `imported-image.ts` không có
đường import nào dẫn tới provider; `sniffImageType` được tách ra `lib/image-sniff.ts`
vì `character-master.ts` kéo theo registry Image AI.

## QĐ-094 — Ảnh khác tỉ lệ: bản làm việc nền mờ, không sửa render

Mọi nơi dùng keyframe (render, `prepareKeyframe` của Runway/Sora/Veo) đều "phủ khung rồi
cắt giữa". Với ảnh 16:9 điều đó cắt mất ~2/3 bề ngang — kể cả nhân vật. Thay vì sửa
bốn chỗ, lúc nhập tạo một BẢN LÀM VIỆC đúng kích thước khung: ảnh nguyên vẹn trên nền
là chính nó làm mờ (FFmpeg tại máy). `scene.imagePath` trỏ bản làm việc, nên mọi thứ
phía sau không đổi một dòng. Gần 9:16 (≤12%) dùng nguyên; `image_fit` cover/contain để
người dùng quyết. Không bao giờ kéo giãn; bản gốc không bị ghi đè.

## QĐ-095 — Khoá clip mang ảnh nhập, nhưng chỉ khi có ảnh nhập

Khoá idempotency của clip gồm model, prompt, thời lượng, `retryCount` — KHÔNG có ảnh.
Thay ảnh nhập của một cảnh VIDEO_AI sẽ làm bước video trả lại clip cũ dựng từ ảnh cũ.
`videoKeyVariant(scene)` thêm `|img:<imageAssetId>` khi và chỉ khi cột đó có giá trị:
mọi cảnh V1 (null) giữ nguyên khoá cũ, nên không clip V1 nào bị mua lại vì thay đổi này.
Thay ảnh còn bỏ `videoPath` của clip cũ — và UI hỏi xác nhận, nói rõ clip mới sẽ tốn tiền.

## QĐ-096 — "Tạo lại ảnh" không có hiệu lực trên ảnh nhập

Nút cũ tăng `retryCount` rồi xếp job ảnh. Trên cảnh ảnh nhập, job ảnh trả lại đúng ảnh
nhập ($0) — nhưng `retryCount` tăng đã đổi khoá CLIP, nên lần chạy sau MUA LẠI clip vô
ích. Nay bị từ chối với hướng dẫn: muốn ảnh AI thì "Bỏ ảnh nhập" trước (dự toán sẽ báo
WILL_CREATE). Không có đường nào thay ảnh người dùng đưa bằng ảnh AI mà họ không yêu cầu.

## QĐ-097 — Ghép ảnh theo tên file: hiện trước, không đoán

Mode B nhận nhiều ảnh cho một dự án có sẵn và ghép theo số cảnh trong TÊN FILE
(`scene-01`, `01`, `s1`, `cảnh-2`…). Tên không có số → UNMAPPED; hai file một cảnh →
CONFLICT và không dùng file nào; cảnh không tồn tại → NO_SUCH_SCENE. Bảng File → Cảnh
hiện trước; server tính lại mapping bằng CÙNG hàm thuần khi xác nhận, nên client không
thể tự chỉ định file nào vào cảnh nào. Cảnh đã có ảnh chỉ bị thay khi tick xác nhận.
Tải storyboard từ trình duyệt đi vào thư mục staging rồi qua ĐÚNG bộ quét cũ — không có
importer thứ hai.

## QĐ-098 — Keyframe đã khai báo mà mất file: bước video DỪNG trước router

Test mới "ảnh nhập của cảnh VIDEO_AI bị xoá" cho thấy bước ảnh dừng đúng nhưng
`generateSceneVideo` vẫn đi tiếp: với model không cần ảnh nó tạo clip text-to-video của
thứ khác; với Runway thì adapter mới từ chối — SAU khi tiền đã được giữ chỗ. Nay cảnh có
`imagePath` mà file không còn thì dừng ngay đầu bước video, không định tuyến, không giữ
chỗ, không POST, lỗi không thử lại. Cảnh không khai báo keyframe (text-to-video hợp lệ)
không bị ảnh hưởng.

`run-real-multi-batch.ts` nhận `--source --name --expect-videos/-scenes/-local/-video-ai
--max-per-video --max-batch --approved-estimate`; mặc định giữ nguyên lô V1.
