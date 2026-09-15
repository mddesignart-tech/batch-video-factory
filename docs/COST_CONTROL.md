# Kiểm soát chi phí

Sáu cơ chế độc lập, xếp chồng lên nhau. Một yêu cầu trả phí phải qua **tất cả**.

---

## 1. Chế độ mock — công tắc chính

`AI_MOCK_MODE=true` trong `.env`.

Khi bật, `src/providers/registry.ts` trả về bản mock cho **mọi** khe cắm, bất kể
router hay người dùng chọn nhà cung cấp nào. Không phải một tuỳ chọn ưu tiên —
đó là một cổng chặn cứng. Không có lệnh gọi mạng nào tới nhà cung cấp trả phí có
thể xảy ra khi cờ này còn bật.

Cờ chỉ đọc từ `.env`, **không** sửa được trong giao diện. Đó là chủ ý: công tắc
an toàn chi phí không nên bật/tắt được bằng một cú nhấp chuột trong trình duyệt.

---

## 2. Phê duyệt thủ công trước khi tiêu tiền

Tạo dự án và sinh kịch bản là miễn phí và tự động. Tạo media là một nút bấm
riêng.

```
Tạo kịch bản  →  người dùng xem lại  →  ước tính chi phí  →  bấm "TẠO MEDIA"
    miễn phí                              miễn phí            ← chỗ duy nhất tốn tiền
```

Không có đường nào trong mã nguồn đi thẳng từ sinh kịch bản sang tạo media mà
không qua `startMediaGeneration()`, và hàm đó kiểm tra ngân sách trước.

Ngoại lệ duy nhất là chế độ tạo hàng loạt, nơi người dùng đã phê duyệt ngân sách
cho cả lô ngay khi tạo lô.

---

## 3. NGÂN SÁCH TỐI ĐA

Mỗi dự án và mỗi lô có một mức trần.

Trước khi tạo media, ứng dụng định tuyến **mọi** cảnh, cộng lại, cộng thêm phần
dự phòng cho việc tạo lại, rồi so với mức trần. Nếu vượt:

- quá trình **không bắt đầu**,
- không job nào được đưa vào hàng đợi,
- người dùng nhận thông báo kèm các cách xử lý cụ thể:

> Chi phí ước tính $14.50 vượt ngân sách tối đa $10.00 (vượt $4.50). Quá trình
> tạo media sẽ không bắt đầu.
>
> - Chuyển sang chế độ Tiết kiệm hoặc Cân bằng
> - Chọn mô hình rẻ hơn cho các cảnh đơn giản
> - Giảm số lượng video trong lô
> - Giảm thời lượng mục tiêu của video
> - Tăng ngân sách tối đa lên ít nhất $14.50

Ngân sách còn là một trần **động** trong lúc chạy: router thấy ngân sách còn lại
giảm dần qua từng cảnh và hạ cấp mô hình thay vì tiêu quá.

---

## 4. HẠN MỨC CHI TIÊU TOÀN ỨNG DỤNG

Khác với NGÂN SÁCH TỐI ĐA của từng dự án: ngân sách dự án giới hạn **một video**,
hạn mức này giới hạn **toàn bộ số tiền ứng dụng từng được phép tiêu**, cộng dồn
mọi dự án, mọi lô và mọi lần thử lại.

Mặc định **0,50 USD**. Sửa trong trang Cài đặt.

Được kiểm tra ngay trước **mọi** request trả phí, và đếm **chi phí thật đã ghi
nhận**, không phải ước tính. Chi phí của nhà cung cấp mock và các dòng đánh dấu
"ước tính" đều không tính vào đây.

```
Đã chi 0,4500 + yêu cầu này 0,1000 = 0,5500 > hạn mức 0,5000  ->  CHẶN
```

## 5. Cổng xác nhận theo từng model

Trước khi một cặp provider/model được phép gọi API thật lần đầu, người dùng phải
nhìn thấy và bấm xác nhận:

| Hiển thị | Ví dụ |
|---|---|
| Nhà cung cấp | openai |
| Model | gpt-4o-mini |
| Giá input | 0,00015 USD / 1k token |
| Giá output | 0,0006 USD / 1k token |
| Ước tính / kịch bản | tối đa 0,0018 USD |
| Đã chi thật | 0,0000 USD |
| Hạn mức | 0,5000 USD |
| Còn lại | 0,5000 USD |

Xác nhận có **phạm vi theo từng model**: cho phép một model text rẻ không hề lan
sang một model video đắt.

Ứng dụng cũng **từ chối bật model chưa nhập giá** (trừ model chạy cục bộ, vốn
thật sự miễn phí) — vì một model giá 0 khiến mọi ước tính và mọi kiểm tra ngân
sách âm thầm cho ra 0.

## 6. Chống tính phí hai lần

Đây là cơ chế tinh tế nhất và quan trọng nhất.

Mỗi lệnh gọi nhà cung cấp có một **khoá idempotency** tất định:

```
sha256(sceneId | loại | nhà cung cấp | mô hình | hash(prompt) | lần tạo)
```

Trước khi bắt đầu bất kỳ việc tạo nào, `runProviderJob()` tra bảng `ProviderJob`
theo khoá này:

| Tình trạng tìm thấy | Hành động |
|---|---|
| `completed` và tệp còn trên đĩa | Dùng lại tệp. Không gọi, không tính phí. |
| `pending` / `processing` | **Bám theo job cũ** và tiếp tục hỏi trạng thái. |
| `failed`, hoặc không có | Gửi yêu cầu mới. |

Trường "lần tạo" là bộ đếm `retryCount` của cảnh:

- một lần thử lại do lỗi tạm thời (timeout, rate limit) dùng **cùng** khoá, nên
  nó nối lại vào job đang chạy bên phía nhà cung cấp thay vì mua thêm một cái
  nữa;
- khi người dùng bấm "Tạo lại video", bộ đếm tăng lên, và đó là một lần tạo mới
  hợp lệ.

Chuyển sang nhà cung cấp dự phòng cũng đi qua cùng cơ chế, nên việc dự phòng chỉ
xảy ra sau khi biết chắc job đầu tiên đã chết.

---

## 7. Quyền chi cho một lô — `BATCH_SPEND_AUTHORIZATION`

`CREATE_ATTEMPT_TOKEN` (mục 2) nghĩa là "một lần xác nhận = đúng một lần POST
create". Đúng cho benchmark. **Không dùng được cho batch**: 10 video sẽ cần
khoảng 50 lần bấm, và một người bấm qua 50 hộp thoại thì đã ngừng đọc chúng — cơ
chế đó tệ hơn là không có, vì nó trông giống sự đồng ý mà không phải.

Nên batch có công cụ riêng. Token giữ nguyên, vẫn quản benchmark / test tay /
debug. Một cảnh nằm trong lô đã duyệt dùng authorization; cảnh ngoài lô vẫn cần
token. `needsCreatePermit()` trả `false` đúng khi authorization được áp dụng, nên
**không đường nào chi được mà không có một trong hai**.

### Sáu câu hỏi trước mỗi request trả phí

`assertBatchAuthorized()` hỏi theo thứ tự rẻ-trước, và request chỉ đi khi cả sáu
đều "có":

1. Có quyền chi không, và còn ở trạng thái `APPROVED` không?
2. Request có thuộc đúng lô được duyệt không?
3. Có làm vượt trần của lô không?
4. Có làm vượt trần của **video này** không?
5. Nhà cung cấp có nằm trong phạm vi đã duyệt không?
6. Hạn mức toàn ứng dụng và **ví riêng của nhà cung cấp đó** còn đủ không?

Câu 5 tồn tại vì bản dự toán được duyệt có nêu tên nhà cung cấp. Duyệt một kế
hoạch dùng Runway không phải là duyệt việc trả tiền cho OpenAI.

---

## 8. Giữ chỗ tiền — `CostReservation`

Vấn đề chỉ xuất hiện khi chạy song song, tức đúng lúc không ai ngồi nhìn.

Năm job cùng chạy, lô còn $0,60. Mỗi job đọc sổ, thấy $0,60, thấy $0,40 của mình
vừa đủ, và gửi. **Cả năm lần kiểm tra đều đúng.** Chúng chỉ cùng đúng về một
khoản $0,60, và lô tiêu $2,00.

Không lần kiểm tra nào đọc "đã chi" sửa được chuyện này, vì lúc kiểm tra thì
tiền chưa chi. Nên tiền được **giữ chỗ trước, gửi request sau**, và lần kiểm tra
kế tiếp nhìn thấy chỗ đã giữ.

```
Lô còn $1,00
Job A ước tính $0,60  →  giữ chỗ $0,60, available còn $0,40
Job B ước tính $0,60  →  BỊ CHẶN, không gửi request
Job A xong, hoá đơn thật $0,55  →  commit $0,55, available còn $0,45
```

`CostReservation.idempotencyKey` là **unique** và đúng bằng khoá của
`ProviderJob`. Đó là thứ khiến refresh trình duyệt, khởi động lại ứng dụng và
resume lô đều tìm thấy chỗ đã giữ thay vì mở chỗ mới.

### Quyết toán nghiêng về phía "đã bị tính phí"

| Tình huống | Xử lý |
|---|---|
| Thành công | `commit` theo hoá đơn thật |
| Hỏng **trước khi** request rời máy | `release` — trả tiền lại cho lô |
| Hỏng **sau khi** request đã gửi | `commit` theo ước tính, đánh dấu `possiblyBilled` |

Nghiêng sai hướng này làm lô mất một ít dư địa. Nghiêng hướng kia làm lô tiêu
vượt trong khi mọi con số trên màn hình vẫn khớp — đó mới là hỏng.

---

## 9. Ba lớp hạn mức của một lô

| Lớp | Ở đâu | Chạm trần thì sao |
|---|---|---|
| Toàn ứng dụng | `spend-guard.ts` | request bị chặn, lô không vượt qua được |
| Một video | `BatchAuthorization.maxCostPerVideo` | **chỉ video đó** dừng, đánh dấu `OVER_VIDEO_BUDGET` |
| Một lô | `BatchAuthorization.authorizedMaxSpend` | lô dừng, `BUDGET_EXHAUSTED` |

Hạn mức/video được kiểm tra **hai lần**: một lần trên bản dự toán (dùng kịch bản
mẫu khi video chưa có kịch bản), và một lần nữa theo **kịch bản thật** ngay trước
khi video đó bắt đầu chi tiền media. Dự toán sai làm kế hoạch sai; nó không làm
việc chi sai.

---

## 10. Cảnh không gọi Video AI thì không tốn gì

Không phải cảnh nào cũng cần model tạo sinh. Cảnh giải thích và cảnh chốt được
định tuyến sang `LOCAL_MOTION`: ảnh keyframe + scale/crop/push-in bằng FFmpeg tại
máy. **$0, và không thể hỏng ở phía nhà cung cấp.**

Đây là khoản tiết kiệm lớn nhất trong toàn bộ pipeline: 6 clip Sora là $2,40,
đắt hơn toàn bộ ảnh và kịch bản cộng lại, và phần lớn số đó mua chuyển động không
ai yêu cầu.

Quyết định này được **ghi lại trên từng cảnh** (`Scene.motionSource`) tại thời
điểm lập kế hoạch, không tính lại lúc chạy — nếu tính lại, một thay đổi trong
bảng model giữa lúc duyệt và lúc chạy sẽ âm thầm biến một cảnh miễn phí thành
cảnh trả phí.

Xem `src/domain/local-motion.ts`.

---

## Ước tính

Ước tính hiển thị **cả ba chế độ tự động** cạnh nhau, vì nguyên tắc sản phẩm là
"chất lượng trên mỗi đô la" và người vận hành chỉ quyết định được điều đó nếu
thấy hai phương án kia đáng giá bao nhiêu.

```
Tiết kiệm        $0.61
Cân bằng         $2.02   ← đang dùng
Chất lượng cao   $3.64

Kịch bản (Text AI)      $0.01
Ảnh keyframe            $0.10
Video                   $1.83
Giọng đọc               $0.0042
Nâng phân giải          $0.00
Đánh giá chất lượng     $0.0060
Dự phòng tạo lại        $0.06
─────────────────────────────
Tổng cộng               $2.02
```

Phần **dự phòng tạo lại** được cộng vào có chủ đích. Báo giá không tính phần này
là cách một video "$3" biến thành $5 và phá huỷ niềm tin vào con số. Mức dự
phòng theo chế độ: Tiết kiệm 5%, Cân bằng 20%, Chất lượng cao 45%, điều chỉnh
theo tỉ lệ thành công đo được của các mô hình được chọn.

---

## Sổ chi phí

Mọi khoản đều thành một dòng trong bảng `CostEntry`: giai đoạn, nhà cung cấp,
mô hình, số tiền, có phải lần tạo lại hay không, ước tính hay thực tế.

Tổng của dự án và lô được **tính lại từ các dòng đó**, không phải cộng dồn tại
chỗ. Nhờ vậy một lần sập giữa chừng không thể để lại con số tổng mâu thuẫn với
lịch sử của chính nó.

Trang Chi phí hiển thị theo Hôm nay / Tuần này / Tháng này / Toàn bộ, chia theo
giai đoạn và theo mô hình.

---

## Giá mô phỏng ở chế độ mock

Các mô hình `mock-*` có giá khác 0 — đây là chủ ý.

Nếu mọi thứ đều $0 thì router không có tín hiệu chi phí nào, nên nó sẽ luôn chọn
mô hình chất lượng cao nhất, và toàn bộ phần ước tính, kiểm tra ngân sách, tối
ưu lô sẽ không thể thử nghiệm được.

Giá mô phỏng chỉ ảnh hưởng tới **ước tính**. Nhà cung cấp mock báo chi phí thực
tế là $0, nên sổ chi phí và bảng điều khiển hiển thị đúng sự thật: không có đồng
nào được tiêu.

---

## Giá là dữ liệu, không phải mã nguồn

Không có giá nhà cung cấp nào được viết cứng ở bất kỳ đâu trong mã nguồn. Tất cả
đến từ bảng `ModelRegistry`, sửa được trong trang "Mô hình AI".

Các mô hình của nhà cung cấp thật được nạp sẵn với giá **0 và ở trạng thái tắt**.
Bật một mô hình chưa có giá sẽ bị từ chối:

> Hãy nhập giá thực tế của mô hình này trước khi bật, nếu không phần ước tính
> chi phí sẽ sai.

Nạp sẵn một mức giá đoán mò còn tệ hơn là không nạp gì.

---

## Giới hạn số job song song

Mặc định 2, chỉnh trong trang Cài đặt. Đây là cái chặn vật lý ngăn một lô 50
video bắn 50 lệnh gọi API tính phí cùng lúc. Nên giữ ở mức thấp.

---

## Khi một lần gọi trả phí thất bại

Câu hỏi duy nhất cần trả lời: **có bị tính tiền không?** Hệ thống xếp câu trả lời
theo ba mức, và chỉ mức đầu là *biết*:

| Nhà cung cấp nói | `billedUnits` | Xử lý |
|---|---|---|
| `cost: { credits: 0 }` | `0` | **Trả lại toàn bộ** tiền giữ chỗ. Không đoán. |
| `cost: { credits: 25 }` | `25` | Chốt theo số thật. |
| không nói gì | `null` | Request đã rời máy → giữ nguyên ước tính, đánh dấu `possiblyBilled`. |

Điểm chết người: `0` và `null` **không giống nhau**, và một phép `if (!value)`
sẽ trộn hai cái làm một. Đúng lỗi đó đã giữ $0,25 trong sổ cho một clip mà số dư
Runway chứng minh là chưa bao giờ bị thu tiền (831 credits trước và sau).

### Sửa một dòng sổ đã chốt

`release()` **từ chối** động vào dòng đã COMMITTED — tiền đã tuyên là đã tiêu thì
không được tự huỷ vì code chạy lại hai lần. Khi bằng chứng mới xuất hiện, dùng:

```ts
correctSettlement(key, { actualCost: 0, reason: "credits=0, nguồn: runway GET /tasks/..." })
```

Bắt buộc có `reason`, được ghi log, và `possiblyBilled` bị xoá — vì một lần sửa
sổ chỉ xảy ra khi câu trả lời đã thôi là phỏng đoán.

### Kiểm tra và sửa sổ

```bash
npx tsx scripts/audit-ledger.ts                                  # chỉ đọc
npx tsx scripts/repair-failure-accounting.ts                     # thử khô
npx tsx scripts/repair-failure-accounting.ts --apply --verify    # hỏi lại nhà cung cấp rồi ghi
```

`--verify` gọi `GET /tasks/{id}` — **miễn phí**, Runway không tính tiền việc hỏi
trạng thái. Script **không thể** POST một lệnh sinh video.

Nó **từ chối sửa sổ nếu không có nguồn**: hoặc đọc trực tiếp từ nhà cung cấp,
hoặc một dòng `VideoBenchmark` ghi tại thời điểm chạy. Một sổ có thể sửa bằng lời
khẳng định thì không còn là sổ.

## Không mua lại một thất bại

Mỗi lần hỏng được ghi vào `ModelFailureEvidence` theo `(model, fingerprint)`, với
`fingerprint` = hash của model + kind + prompt + keyframe + duration.

- Gửi lại **đúng** request đó vào **đúng** model đó → bị chặn **trước** khi giữ
  chỗ và trước khi POST. Không tốn gì.
- Sửa prompt, đổi keyframe, đổi độ dài → là câu hỏi khác, được phép hỏi.
- Model hỏng trên **2 cảnh khác nhau** → `DEGRADED`; **3 cảnh** → `UNSUITABLE`.
  Router thôi tự chọn, nhưng ghim tay vẫn dùng được để benchmark lại.

Chỉ lỗi **thuộc về model** mới được tính. HTTP 400 là lỗi của ta.

---

## Model registry: ba trục, ba nguồn

Một model có được router **tự chọn** hay không phụ thuộc ba câu hỏi độc lập:

| Trục | Ai trả lời | Cột |
|---|---|---|
| Dòng này có bật không | người vận hành | `enabled` |
| Nhà cung cấp còn phục vụ không | vendor + ta | `lifecycle`, `shutdownDate` |
| Các lần ta trả tiền chạy ra sao | chính ta | `reliability` |

`autoRouteBlock()` là nơi duy nhất tổng hợp cả ba, và nó xét **ngày tắt trước
nhãn vòng đời**: nhãn chỉ mới bằng lần cuối có người sửa, còn ngày là sự thật.

### Nguồn gốc dữ liệu — không được gộp

Runway **không có** endpoint giá hay capability. `GET /models` trả 404. Nguồn
live duy nhất là `GET /organization`, và nó chỉ nói được hai điều: model nào tồn
tại, rate limit bao nhiêu.

Vì thế mỗi loại dữ kiện mang nguồn riêng: `existenceSource`, `pricingSource`,
`capabilitySource`, kèm `sourceNote`. Giá nằm cùng một dòng database với dữ liệu
live **không làm nó thành dữ liệu live**.

```bash
npx tsx scripts/catalog-runway.ts           # đọc live, đối chiếu registry
npx tsx scripts/catalog-runway.ts --apply   # đóng dấu existence=LIVE
npx tsx scripts/catalog-runway.ts --offline # cache, luôn có nhãn CACHE + tuổi
```

`applyCatalogToRegistry()` từ chối ghi khi nguồn là CACHE — một bản lưu hôm qua
không được biến thành lời khẳng định ở thì hiện tại.
