# Trạng thái dự án

**Cập nhật:** 2026-09-18
**Cột mốc hiện tại:** **Batch Video Factory V1 đã chạy hết một lô bằng API
trả phí và xuất ra MP4.** Milestone 2 xong trước đó (Text + Image + Video + Voice
đã chạy thật).

Lô `a690a290` "Cold feet": duyệt 2026-09-17 với trần $1,24, dừng giữa chừng ở
cảnh 1, chạy tiếp và hoàn tất 2026-09-18 với **$1,047095** thật — 6 cảnh, 1080x1920.
`CREATE_ATTEMPT_TOKEN = 0` suốt cả lần chạy: quyền chi lô là cơ chế cấp phép,
không phải token. Xem QĐ-062.

Sau đó siết nhịp cảnh 5 và render lại **bằng FFmpeg, $0**: video **26,000s**,
`final_0de14438.mp4`. Hai clip h3_max đã được chấm và ghi `VideoBenchmark`
(9,09 và 8,91 / 10) — hai mẫu **sản xuất thật** đầu tiên của model này. Xem
QĐ-063 và QĐ-064.

Tài liệu này ghi tình trạng **thực tế**. Tính năng chỉ được đánh dấu hoạt động
khi đã chạy thật và được kiểm chứng, không phải khi đã viết xong mã.

---

## Tiền và quyền chi tiêu

```
Hạn mức tổng : $8,00   đã chi $6,401015   còn $1,598985
CREATE_ATTEMPT_TOKEN : 0
```

**Sổ đã được sửa 2026-09-15.** Lô đầu tiên chạy thật từng ghi `actualSpend`
$0,291160; trong đó $0,25 là **tiền chưa bao giờ bị thu**. Runway trả
`cost: { credits: 0 }` cho clip hỏng và số dư đứng yên 831 → 831, nhưng code đọc
số 0 bằng truthy check nên coi như "không rõ" rồi giữ nguyên ước tính. Con số
đúng là **$0,041160** (một ảnh gpt-image-2). Xem QĐ-032…QĐ-035.

Ví **tách riêng từng nhà cung cấp, không bao giờ cộng chung**:

| Ví | Đã chi | Số gọi | Số dư |
|---|---|---|---|
| openai | $2,282161 | 56 | $6,00 — **khai báo**, API key không đọc được số dư |
| runway | $4,090000 | 9 | **591 credit = $5,91** — LIVE, đọc 2026-09-18 |
| groq | $0,028854 | 24 | external, nhà cung cấp tự quản |

Sổ runway khớp tuyệt đối với hãng: $4,09 = 409 credit, 1000 − 409 = **591**.
Setting trước đó ghi 975 credit — lệch $3,04 và đã được sửa bằng số đọc live.
Mặc định của ví runway giờ là **0**, không phải một con số chép lại: trước khi
hỏi hãng, câu trả lời trung thực là "không biết". Xem QĐ-054.

Có **hai** cơ chế cấp phép, và mỗi request trả phí phải có đúng một trong hai:

- **Ngoài lô** (benchmark, test tay, debug): `CREATE_ATTEMPT_TOKEN`. Một lần
  xác nhận = **đúng một** lần POST create. Token bị tiêu ngay khi POST rời máy,
  bất kể thành công, 400, timeout hay lỗi provider.
- **Trong một lô đã duyệt**: `BATCH_SPEND_AUTHORIZATION`. Một lần duyệt, một
  trần chi, và mỗi request đều bị kiểm tra + giữ chỗ tiền trước khi gửi.

`needsCreatePermit()` trả `false` đúng khi cơ chế thứ hai được áp dụng, nên
không có đường nào chi được mà không qua một trong hai. Xem mục **Batch Video
Factory V1** bên dưới.

---

## Kế toán thất bại — sửa 2026-09-15

Ba giá trị mà nhà cung cấp **đã nói** nhưng hệ thống **đã vứt đi**:

| Runway trả về | Trước | Sau |
|---|---|---|
| `failureCode: INTERNAL.BAD_OUTPUT.CODE01` | gộp vào `error`, rồi bị thay bằng `"generation_failed"` | trường riêng, đi tới `ProviderJob.failureCode` |
| `failure: "An unexpected error occurred."` | là thứ duy nhất còn lại | vẫn giữ, nhưng chỉ để người đọc |
| `cost: { credits: 0 }` | không bao giờ được đọc | `billedUnits = 0` → trả lại toàn bộ tiền giữ chỗ |

Hệ quả dây chuyền của việc mất `failureCode`: `marksProviderUnsuitable()` tìm
chuỗi `BAD_OUTPUT`, và chuỗi đó chưa từng tới được nơi nó được đọc. Luật "đừng
gửi lại cảnh này cho model đã từ chối nó" **đã tồn tại trong code từ lâu và chưa
chạy lần nào**.

Hai bảng mới:

- `ModelFailureEvidence` — mỗi thất bại đã trả tiền, khoá theo
  `(model, fingerprint)` với fingerprint = model + kind + prompt + keyframe +
  duration. Chặn gửi lại **trước** khi giữ chỗ và trước khi POST.
- `ModelRegistry.reliability` — `OK | DEGRADED | UNSUITABLE`, trục thứ ba tách
  khỏi `enabled` và `lifecycle`. Đếm **số cảnh khác nhau**, không đếm số lần.

Công cụ:

```bash
npx tsx scripts/audit-ledger.ts                                # chỉ đọc
npx tsx scripts/repair-failure-accounting.ts --apply --verify  # GET, miễn phí
```

Script **từ chối sửa sổ nếu không có nguồn** (đọc trực tiếp từ nhà cung cấp,
hoặc một dòng `VideoBenchmark` ghi tại thời điểm chạy).

---

## h3_max benchmark — 2026-09-15, 1 clip, $0,40

Task `b6fddf11-900b-43f2-9cca-df366f80c6f0`. Credit **831 → 791** = 40 credit.
Sổ ghi $0,400000; nhà cung cấp trừ $0,400000. **Khớp tuyệt đối, không lệch.**

Cùng cảnh, cùng keyframe mà `gen4_turbo` đã hỏng hai lần với
`INTERNAL.BAD_OUTPUT.CODE01`. `h3_max` **chạy được ngay lần đầu**.

| Tiêu chí | Điểm |
|---|---|
| Character Identity | 10 |
| Clothing Consistency | 10 |
| Stays in Frame | 10 |
| Face Drift | 9 |
| Hands / Body | 9 |
| Composition | 9 |
| Artifacts | 9 |
| Keyframe Adherence | 9 |
| Motion | 8 |
| Camera Stability | 8 |
| **Trung bình** | **9,1** |

Kỹ thuật: **768×1280 (đúng 9:16)**, h264, 24fps, 124 frame, 5,17s, 3,26 MB.
Có luồng AAC (audio gốc luôn bật) — pipeline map `[1:a]` là file giọng đọc nên
audio này bị bỏ đúng cách, không tốn thêm và không cần sửa.

Trừ điểm ở Motion/Camera: prompt yêu cầu *"static locked camera"* và chỉ nghiêng
**đầu**, nhưng model cho cả thân trên cúi về trước và có dịch khung rất nhẹ.

Trạng thái: `BENCHMARK_VERIFIED` **và vẫn `PIN_ONLY`**. Một mẫu không đủ để
auto-route.

### Mẫu 2 và 3 — 2026-09-15, $0,80

| | Mẫu 1 | Mẫu 2 | Mẫu 3 |
|---|---|---|---|
| Cảnh | Cold feet #1 | Spill beans #5 | Spill beans #6 |
| Nhân vật | 1 | 1 | **2** |
| Task | `b6fddf11` | `d45c9a40` | `c744478e` |
| Identity | 10 | **5** | 9 |
| Motion | 8 | **3** | 9 |
| Camera | 8 | **1** | 9 |
| Composition | 9 | **3** | 9 |
| Artifacts | 9 | 8 | 8 |
| **Tổng** | **9,1** | **4,3** | **8,9** |

**Mẫu 2 hỏng camera.** Prompt ghi *"Static camera. No camera movement."* nhưng
model đẩy từ toàn thân sang cận mặt trong **1,3 giây** và giữ nguyên đến hết —
mất hẳn bàn tay đang chỉ, tức trọng tâm của cảnh. Đo khách quan: PSNR frame đầu
vs cuối = **8,4 dB**, so với 15,2 và 16,2 của hai mẫu kia.

### Mẫu 4 — A/B chỉ đổi prompt, cùng cảnh 5 ($0,40)

Task `3a314183`. Camera **1 → 10**, Overall **4,3 → 9,2**. PSNR đầu↔cuối
**8,38 → 39,69 dB**. Không zoom, không reframe, không crop, frame cuối trùng
frame đầu, cái gật đầu vẫn xảy ra.

**Kết luận: PROMPT-SENSITIVE**, không phải bất ổn cố hữu. Xem QĐ-044.

Ngưỡng tính trên 3 mẫu có guardrail camera (bỏ mẫu 2): Identity 9,33 · Motion
8,00 · Artifacts 8,67 · Camera 9,00 · Composition 9,33 — **ĐẠT toàn bộ**.
Tính trên cả 4 mẫu thì KHÔNG đạt.

**Vẫn giữ `PIN_ONLY`.** Điều kiện tiên quyết trước khi bàn LOW_AUTO: chuẩn hoá
**17/23 cảnh** đang có prompt thiếu chữ `locked`.

**Kết luận ngưỡng (3 mẫu đầu): KHÔNG ĐẠT.** Camera 6,00 (cần ≥8), Composition 7,00 (cần ≥8),
Motion 6,67 (cần ≥7). Giữ `PIN_ONLY`.

**Về giả thuyết lỗi do prompt:** mẫu 3 dùng bộ guardrail mới có câu *"no large
zoom"*; mẫu 1 và 2 thì không. Nhưng mẫu 1 **vẫn giữ được camera (8)** dù thiếu
câu đó. Vậy prompt không giải thích hết — **cùng một loại prompt cho hai kết quả
1 và 8**, và đó đúng là định nghĩa của thiếu ổn định.

---

---

## Benchmark video đã trả tiền

Lưu trong bảng `VideoBenchmark`, seed lại được bằng
`npx tsx scripts/record-benchmarks.ts`.

| Model | Cảnh | Độ khó | Kết quả | Tiền |
|---|---|---|---|---|
| gen4_turbo | 4 | MEDIUM | hỏng `BAD_OUTPUT.CODE01` (2 lần) | $0 |
| gen4_turbo | 5 | LOW | đạt — identity 10, camera 10, motion 4 | $0,25 |
| gen4.5 | 3 | HIGH | đạt — composition **3**, Max rời khung ở 5,9s | $0,72 |
| gen4.5 | 3 | HIGH | đạt — composition **9**, camera 7, artifacts 7 | $0,72 |
| sora-2 | 3 | HIGH | **hỏng HTTP 400** `input_reference`, không tạo job | $0 |
| **h3_max** | **1** | **LOW** | **đạt ngay lần đầu — TB 9,1; identity 10, camera 8** | **$0,40** |

`h3_max` chạy trên **đúng cảnh và đúng keyframe** mà `gen4_turbo` đã hỏng hai
lần. Đó là lý do phép so sánh này có nghĩa: cùng input, khác model.

**Lưu ý về sora-2:** bảng chỉ ghi một lần hỏng, nhưng `ProviderJob` cho thấy nó
đã tạo thành công **2 clip** ngày 13/09 ($0,40 mỗi clip) mà **chưa ai chấm điểm**.
Nên mọi so sánh chất lượng với sora-2 đang dựa trên bằng chứng thiếu — không
được kết luận nó kém hơn chỉ vì cột điểm trống.

Hai lần gen4.5 là A/B có kiểm soát, **chỉ đổi prompt**: cho phép push-in →
composition 3; khoá camera → composition 9. Bài học: phần lớn hiện tượng trôi
camera là do prompt, phần còn lại là bản tính của model.

Lần Sora hỏng là **lỗi của ta, không phải Sora từ chối cảnh**. Cùng đoạn code đã
chạy đạt 2 lần ngày 13/09 với **4 giây** + keyframe, không có commit nào sửa nó
từ đó. Khác biệt duy nhất: `seconds` 4 → 6. Giả thuyết là 6 không nằm trong tập
độ dài hợp lệ — **chưa chứng minh được nếu không POST thêm lần nữa**.

---

## ⚠️ Sora-2 NGỪNG DÙNG — 2026-09-15

**OpenAI tắt Sora API ngày 2026-09-24.** Đồng thời, Sora chỉ nhận **4 / 8 / 12
giây**, không nhận gì khác.

Điều đó giải thích dứt điểm lần hỏng HTTP 400: bảng benchmark từng ghi *"giả
thuyết là 6 không nằm trong tập độ dài hợp lệ — chưa chứng minh được nếu không
POST thêm lần nữa"*. Đọc như vậy là đúng, và đây là xác nhận — không tốn đồng nào.

**Nhưng nó cũng phơi ra một lỗi nặng hơn trong bộ ước tính.** `billedVideoSeconds`
không có nhánh nào cho `openai`, nên rơi vào `default: return requestedSeconds`.
Hệ quả: ta báo giá $0,30 cho 3 giây, $0,50 cho 5 giây, $0,60 cho 6 giây — **ba
mức giá cho ba request mà API sẽ từ chối.** Toàn bộ cost preview video của Sora
là số học trên những độ dài không gửi được.

Giá đúng sau khi sửa:

| Xin | Gửi được | Giá |
|---|---|---|
| 3s | 4s (phải đổi) | $0,40 |
| 4s | 4s | $0,40 |
| 5s | 8s (phải đổi) | $0,80 |
| 6s | 8s (phải đổi) | $0,80 |
| 8s | 8s | $0,80 |

**Không tự ý làm tròn.** `planDuration()` trả `DURATION_TRANSFORM_REQUIRED` kèm
độ dài gần nhất; đổi hay không là **quyết định về nội dung**, không phải chuyện
làm tròn ở tầng dưới cùng. Cost preview vẫn tính theo độ dài **sẽ thật sự gửi**.

Adapter Sora **giữ nguyên** để đọc job cũ và lịch sử benchmark.

---

## Guardrail camera — chuẩn hoá 2026-09-15

Một bộ dùng chung trong code, áp ở **bước cuối trước khi gửi**
(`generateSceneVideo`), không sửa dữ liệu prompt.

```bash
npx tsx scripts/audit-camera-prompts.ts            # xem trước, miễn phí
npx tsx scripts/audit-camera-prompts.ts --verbose  # kèm lý do phân loại
```

| | |
|---|---|
| Tổng cảnh | 23 |
| `LOCKED_CAMERA` | 20 |
| `DIRECTED_CAMERA` | 3 |
| Chưa phân loại | 0 |
| Mâu thuẫn | 0 |
| Vượt giới hạn ký tự | 0 |
| Thiếu khoá camera | **17 → 0** |

3 cảnh DIRECTED giữ nguyên chuyển động kịch bản yêu cầu: `738805f7` (follow),
`d9c9b991` (đổi khung), `5fd45846` (pan). Chúng **không** bị gắn "No pan"/"No
zoom" — cấm thứ kịch bản vừa yêu cầu là bắt model tự chọn, đúng cái bất ổn cần
dập.

Phân loại đọc `Scene.camera` (trường ý đồ camera của kịch bản), khớp theo động
từ chuyển động và cấu trúc đổi khung — không dò chữ "camera".

---

## Danh mục model Runway — kiểm tra live 2026-09-15

**`GET /models` KHÔNG TỒN TẠI** (404). Nguồn live duy nhất là `GET /organization`,
trả về `tier.models{}` — tên model + rate limit, và `creditBalance`.

```bash
npx tsx scripts/catalog-runway.ts            # đọc live + đối chiếu registry
npx tsx scripts/catalog-runway.ts --apply    # đóng dấu existence=LIVE
npx tsx scripts/catalog-runway.ts --offline  # cache, có nhãn rõ ràng
```

Tài khoản có **61 model**. Số dư **831 credit** ($8,31). Đã xác nhận có:
`wan3`, `wan3_prime`, `h3_max`, `hailuo3`, `veo3.1_fast`, `veo3.1`, `veo3`,
`gen4.5`, `gen4_turbo`, `gen3a_turbo`.

### Nguồn gốc từng loại dữ liệu — không được gộp

| Dữ kiện | Nguồn | Vì sao |
|---|---|---|
| model có tồn tại không | **LIVE** | `/organization` liệt kê |
| rate limit | **LIVE** | cùng response |
| giá | **MANUAL** | Runway không có endpoint giá |
| độ phân giải, độ dài, tỉ lệ, audio | **MANUAL** | không có endpoint capability |

Giá MANUAL đối chiếu chéo được: `gen4_turbo` 5 credit/s = $0,05 và `gen4.5`
12 credit/s = $0,12 — **khớp đúng hai dòng ta đã thực trả tiền**. Đó là lý do
duy nhất để tin phần còn lại của bảng.

### Ứng viên đã thêm — tất cả PIN_ONLY

| modelId | $/giây | credit/s | Ghi chú capability (MANUAL) |
|---|---|---|---|
| `h3_max:480x854` | 0,05 | 5 | 5–15s, tỉ lệ theo ảnh đầu vào, audio luôn bật |
| `h3_max:768x1280` | 0,08 | 8 | như trên, nét hơn |
| `wan3:480x854` | 0,05 | 5 | 2–30s, audio gốc. **Mặc định vendor là `auto_1080p` = 20 credit/s** |
| `wan3:720x1280` | 0,10 | 10 | như trên |
| `veo3.1_fast:720x1280` | 0,10 | 10 | 10 credit/s không audio, 15 có audio |

---

## Vòng đời model — cột mới trên `ModelRegistry`

| Trạng thái | Router tự chọn? |
|---|---|
| `ACTIVE` | có |
| `PIN_ONLY` | không — chỉ chọn tay |
| `DEPRECATED` | không |
| `DISABLED` | không |

Kèm `deprecationDate`, `shutdownDate`, `replacementNote`.

Tách khỏi cờ `enabled` (chỉ nói "hàng này có bật không") và tách khỏi
`NEEDS_EXPLICIT_PIN` trong `domain/video-suitability` (ghi **bằng chứng
benchmark** nói gì). Cột này ghi **người vận hành** nói gì. Router từ chối nếu
**một trong hai** phản đối — Sora-2 là ví dụ: bằng chứng tốt, nhưng sắp bị tắt.

Lifecycle được **ghi đè lại mỗi lần seed**, không chỉ lúc tạo — tin một model bị
khai tử là tin ứng dụng phải đẩy được xuống máy đã cài từ tháng trước.

---

## Định tuyến video — Batch V1 (tạm chốt 2026-09-15)

| Độ khó | Hiện tại |
|---|---|
| Không cần chuyển động tạo sinh | **LOCAL_MOTION** — dùng tối đa |
| LOW | `runway/gen4_turbo` — có bằng chứng tốt |
| MEDIUM | **NEEDS_PROVIDER** nếu không LOCAL_MOTION được |
| HIGH | **NEEDS_PROVIDER** |

`gen4.5` = PIN_ONLY. `sora-2` = DEPRECATED. **Không được vì muốn chạy xong lô mà
tự chọn model chưa duyệt.**

**Hệ quả đo được:** không kịch bản nào đang có trên máy chạy được tự động — cả
ba đều chứa cảnh HIGH. Xem `npx tsx scripts/find-cheapest-candidates.ts`.

`runway/gen4.5` ở trạng thái **pin-only**: còn trong registry, chọn tay được,
router tự động không bao giờ chọn. Xem `NEEDS_EXPLICIT_PIN` trong
`src/domain/video-suitability.ts`. Gỡ một dòng khỏi bảng đó chính là hành động
đưa model lên production — chỉ làm khi có một lần chạy đạt ngưỡng, và lần chạy
đó phải nằm trong bảng benchmark.

`findContradictions()` trong `src/services/benchmark-evidence.ts` sẽ báo động nếu
luật định tuyến mâu thuẫn với một clip đã trả tiền. Nó **chỉ** tính thất bại nói
lên điều gì đó về model (`BAD_OUTPUT`, từ chối nội dung). Một lỗi 400/429/5xx hay
timeout là lỗi phía ta hoặc lỗi nhất thời, không phải bản án cho model.

---

## Batch Video Factory V1

Một nút tạo nhiều video, nhưng **tiền không ra ở nút đó**. Quy trình hai bước:

```
A. PHÂN TÍCH & DỰ TOÁN   miễn phí, chỉ đọc, lặp lại bao nhiêu lần cũng được
B. DUYỆT & CHẠY BATCH    một lần duyệt, một trần chi, rồi chạy tự động hết
```

Sau khi duyệt, lô chạy không hỏi lại từng cảnh: script → ảnh → video → giọng →
phụ đề → trộn → render → MP4.

### Ba lớp ngân sách

| Lớp | Ở đâu | Ý nghĩa |
|---|---|---|
| Hạn mức toàn ứng dụng | `spend-guard.ts` | $8,00. Batch không vượt qua được. |
| Hạn mức / video | `BatchAuthorization.maxCostPerVideo` | mặc định $2,50. Video vượt → `OVER_VIDEO_BUDGET`, dừng **riêng nó**. |
| Hạn mức / lô | `BatchAuthorization.authorizedMaxSpend` | người dùng tự nhập. Chạm trần → `BUDGET_EXHAUSTED`. |

### BATCH_SPEND_AUTHORIZATION — không phải CREATE_ATTEMPT_TOKEN

`CREATE_ATTEMPT_TOKEN` nghĩa là "một lần xác nhận = đúng một POST create". Đúng
cho benchmark, **không dùng được cho batch**: 10 video sẽ cần 50 lần bấm, và một
người bấm qua 50 hộp thoại thì đã ngừng đọc chúng — cái đó trông giống sự đồng ý
nhưng không phải.

Nên batch có công cụ **riêng**, không phải bản nới lỏng của công cụ cũ. Token
giữ nguyên, vẫn quản benchmark / test tay / debug. Một cảnh nằm trong lô đã
duyệt thì dùng authorization; cảnh ở ngoài vẫn cần token. **Không đường nào chi
được mà không có một trong hai.**

### Reserve / Commit — vì sao cần

Năm job chạy song song, lô còn $0,60. Mỗi job đọc sổ, thấy $0,60, thấy $0,40 của
mình vừa đủ, và gửi đi. **Cả năm lần kiểm tra đều đúng** — chúng chỉ cùng đúng
về một khoản $0,60, và lô tiêu $2,00.

Không lần kiểm tra nào đọc "đã chi" sửa được chuyện này, vì lúc kiểm tra thì
tiền chưa chi. Nên tiền được **giữ chỗ trước, gửi request sau**: bảng
`CostReservation` khoá theo `idempotencyKey` (unique), đúng bằng key của
`ProviderJob`. Đó cũng là thứ khiến resume / refresh / restart không mua lại:
cùng một key thì tìm thấy chỗ đã giữ, không mở chỗ mới.

Quyết toán có hai ngả và khác nhau quan trọng:

- `commit` — nhà cung cấp đã tính phí. Số giữ chỗ được thay bằng hoá đơn thật.
- `release` — request **chưa rời máy**. Trả tiền lại cho lô.

Nếu không chắc, **giữ nguyên** (commit theo ước tính, đánh dấu `possiblyBilled`).
Trả lại ngân sách cho một request đã bị tính phí là cách lô tiêu vượt trong khi
mọi con số trên màn hình vẫn khớp.

### LOCAL_MOTION — không phải cảnh nào cũng cần Video AI

Router có thêm một lựa chọn bằng vai với việc chọn model: `LOCAL_MOTION` — dùng
ảnh keyframe + scale/crop/push-in bằng FFmpeg. **$0, và không thể hỏng ở phía
nhà cung cấp.** Bộ render đã làm sẵn việc này cho ảnh tĩnh từ Milestone 1.

| Chế độ | Khi nào gọi Video AI |
|---|---|
| Tiết kiệm | chỉ cảnh HIGH có ≥2 nhân vật |
| Cân bằng | cảnh `spendPriority=HIGH` (hook/punchline) và mọi cảnh không phải LOW priority |
| Chất lượng | mọi cảnh trừ cảnh LOW + LOW |

**Một hiệu chỉnh quan trọng, đo chứ không đoán:** luật đầu tiên viết theo
`complexity === "LOW"`. Chạy thử trên kịch bản thật cho thấy **không cảnh nào
từng là LOW** — hai nhân vật trong khung đã đủ vượt ngưỡng MEDIUM. Luật đó trông
đúng khi đọc và sẽ kích hoạt gần như không bao giờ. Tín hiệu thật sự phân biệt
được là `spendPriority = LOW`, thứ mà bộ phân loại gán cho cảnh "giải thích" và
"ví dụ". Xem `src/domain/local-motion.ts`.

**Cái bẫy đã xử lý:** chế độ Tiết kiệm vốn bỏ qua keyframe cho cảnh đơn giản — mà
đó đúng là những cảnh được đẩy sang LOCAL_MOTION. Hai luật đều đúng khi đứng
riêng, ghép lại thì cảnh không có ảnh **và** không có clip, và bộ render lặng lẽ
bỏ cảnh đó khỏi video. `keyframeRequired()` khiến ảnh thành bắt buộc khi chuyển
động đến từ ảnh tĩnh.

### Cái đã bị gỡ bỏ

`createBatch` cũ nhận form rồi **lập tức** xếp `batch_expand`, sinh kịch bản và
chi tiền media trong một bước. Đó chính là hình dạng "bấm nút là tiền ra" mà
Batch V1 sinh ra để thay thế, nên nó bị **xoá** chứ không đánh dấu deprecated —
để lại thì đường chi tiền không cần duyệt vẫn còn đó.

### Đường nào đi qua cổng lô, đường nào không

Đã nối: **text (kịch bản), image, video, voice** — tất cả đều giữ chỗ tiền trước
khi gửi request.

**Chưa nối: chấm điểm chất lượng** (`evaluateScene`). Hiện không rò tiền vì
`getQualityProvider` chỉ trả về mock; mọi provider khác đều ném
`notImplemented`. Nhưng nếu sau này thêm một quality model thật thì **phải nối
vào cổng lô trước**, nếu không nó sẽ chi ngoài trần đã duyệt. Đường này cũng
chưa có `assertCanSpend` — lỗ hổng có từ trước, không phải do Batch V1.

`character-master.ts` (tạo ảnh chuẩn cho nhân vật) cố ý đứng ngoài: đó là thao
tác quản trị riêng, không nằm trong luồng lô.

### ⚠️ Dự toán từng là giá MOCK — đã sửa 2026-09-15

`availableProviderNames()` trả về `["mock"]` bất cứ khi nào `AI_MOCK_MODE=true`,
và bộ ước tính chỉ định tuyến tới các provider trong danh sách đó. Nghĩa là **mọi
con số "Tổng chi phí dự kiến" mà trang lô từng hiển thị đều được tính từ GIÁ GIẢ
LẬP** rồi trình bày như dự báo tiền thật.

Giá mock không hề gần giá thật, và sai theo **cả hai chiều**:

| Loại | Giá mock | Giá thật | Lệch |
|---|---|---|---|
| voice | $0,015 / 1k ký tự | $0,0006 (`gpt-4o-mini-tts`) | **cao gấp 25 lần** |
| image | $0,020 / ảnh | $0,048 (`gpt-image-2:medium`) | thấp hơn một nửa |
| video | $0,045 / giây | $0,100 (`sora-2`) | thấp hơn một nửa |

**Cách sửa:** ba loại chi phí giờ là kiểu dữ liệu, không phải chú thích —
`MOCK`, `PRODUCTION_ESTIMATE`, `ACTUAL` trong `src/domain/cost-basis.ts`. Mỗi bản
kế hoạch tính **hai lần**: một theo provider chạy được ngay (mock), một theo
provider thật ở giá niêm yết (`productionProviderNames()` — bỏ qua Mock Mode).
Giao diện hiển thị cả hai, có nhãn. **Hạn mức đề xuất luôn lấy từ con số THẬT.**

### Dự toán thật 1 video, chế độ Tiết kiệm

Đo bằng `npx tsx scripts/production-estimate.ts` — chỉ đọc, không gọi API:

| Thành ngữ | Cảnh | Local | Video AI | Image | Video | TOTAL |
|---|---|---|---|---|---|---|
| Spill the beans | 6 | **3** | 3 | $0,288 | $1,400 | **$1,7017** |
| Piece of cake | 6 | 1 | 5 | $0,288 | $1,900 | **$2,2054** |
| Break a leg | 5 | 1 | 4 | $0,240 | $2,100 | **$2,3586** |

**Bài học quan trọng: LOCAL_MOTION tiết kiệm ít hơn nhiều so với kịch bản mẫu.**
Bảng nghiệm thu trước ghi "Tiết kiệm = 4 local + 2 AI, $1,03/video". Con số đó
sai hai lần: nó dùng **kịch bản mẫu** (hiền hơn kịch bản thật) và **giá mock**.
Kịch bản thật gần như toàn cảnh HIGH có 2 nhân vật, mà `needsGenerativeMotion`
buộc những cảnh đó dùng Video AI **bất kể chế độ**. Dải thật là **$1,70–$2,36**.

**Hệ quả định tuyến:** `runway/gen4_turbo` bị loại khỏi mọi cảnh HIGH
(`MAX_COMPLEXITY = LOW`), `gen4.5` vẫn pin-only, nên chế độ Tiết kiệm **không
dùng được tier rẻ** trên kịch bản thật — tất cả rơi vào `sora-2` ở $0,10/giây.

**Rủi ro cần biết trước khi chạy thật:** một số cảnh tính tiền **6 giây**, mà 6
giây đúng là độ dài đã trả về HTTP 400 với `sora-2`. Chỉ 4 giây là đã chứng minh.

### Ứng viên chạy thật đầu tiên — đã chuẩn bị 2026-09-15

**"Cold feet"**, project `f2b68443`, lô `11af6ba6`, quyền chi **DRAFT**.

6 cảnh, **HIGH = 0, MEDIUM = 0** — không cảnh nào cần Sora hay gen4.5. Hai cảnh
dùng `runway/gen4_turbo` (cảnh 1 hook, cảnh 4 punchline), bốn cảnh LOCAL_MOTION.

```
TEXT $0,0010 · IMAGE $0,2880 · VIDEO $0,5000 · VOICE $0,0001 · RENDER $0
TOTAL $0,8128   ·   đề xuất trần $0,90
```

Preflight Runway (chỉ GET, miễn phí): API xác nhận `gen4_turbo` có thật trong
danh sách live, số dư **831 credit (~$8,31)**, 720x1280 hợp lệ, 5 giây hợp lệ,
$0,25/cảnh. Mục duy nhất chưa đạt là **"cảnh chưa có keyframe"** — đúng và
không thể khác, vì gen4_turbo là image-to-video và ảnh chỉ có sau bước Image.

### Ba lỗi phát hiện khi dựng ứng viên này

**1. Bộ ước tính làm tròn 4 chữ số nên chi phí voice biến mất.** Một lời thoại
37 ký tự ở $0,0006/1k tốn $0,0000222 → làm tròn thành $0,0000. Cả video báo
voice = $0,00 trong khi số thật là $0,000135. **Đúng lớp lỗi dự án đã sửa một
lần cho sổ chi phí** (chuyển sang 6 chữ số) — nhưng bỏ sót bộ ước tính.

**2. Bộ ước tính báo lỗi khi thiếu model chấm điểm, còn lúc chạy thật thì bỏ qua
êm.** `evaluateScene` bắt `RoutingError` và trả null; bộ ước tính thì đánh cả
cảnh là lỗi. Registry không có quality model thật → mọi cảnh ưu tiên cao báo lỗi
và cả video đọc ra là không chạy được, **cho một bước mà lúc chạy sẽ bị bỏ qua
lặng lẽ**. Một dự toán từ chối việc mà bộ sinh sẵn sàng làm thì tệ hơn không có
dự toán: nó giấu mất một video vốn không sao cả.

**3. Lô sẽ vứt kịch bản soạn tay.** `handleBatchExpand` sinh kịch bản mới cho
idiom chưa có project trong lô. Đã gắn project vào lô trước. Kèm theo phát hiện
nút duyệt chi chỉ tồn tại trong form `/batches`, nên lô chuẩn bị sẵn **không
duyệt được trên UI** — đã thêm `ApprovePanel` vào trang chi tiết.

### Nghiệm thu bằng mock — 2026-09-15

Chạy `tests/batch-acceptance.test.ts`: **26/26 đạt**, một lô 3 video đi trọn
đường từ dự toán tới MP4, kèm các tình huống cố ý phá:

| Kịch bản | Kết quả |
|---|---|
| Dự toán 3 video, không ghi một dòng sổ nào | đạt |
| Chặn mọi request khi quyền chi còn DRAFT | đạt |
| Một cảnh cố ý hỏng → thử lại → xong | đạt |
| Dừng lô → không gửi request mới | đạt |
| Job đã gửi đi vẫn được theo dõi, không giả vờ huỷ | đạt |
| Chạy tiếp → giữ nguyên trần và số đã chi | đạt |
| Mô phỏng khởi động lại → không mua lại gì | đạt |
| Ví Runway cạn → chặn, dù trần lô và hạn mức tổng còn | đạt |
| Hai request song song tranh cùng khoản cuối | đúng 1 qua, 1 bị chặn |
| Cảnh LOCAL_MOTION → $0, không ProviderJob, không giữ chỗ | đạt |
| Mọi dòng sổ đều ghi `provider=mock`, tiền thật = $0 | đạt |

Ngoài ra đã chạy thật trên giao diện (DB riêng `data/.uidemo`, không đụng dữ
liệu production): dự toán → duyệt $1,09 → lô chạy → 2 video xuất MP4.

### Hai lỗi nghiệm thu tìm ra và đã sửa

**1. Dự án kẹt ở `draft` không có kịch bản là ngõ cụt vĩnh viễn.** Trong lần
chạy UI, một SQLite socket timeout làm hỏng kịch bản của video thứ ba. Dòng dự
án vẫn còn, ở trạng thái `draft`, không có cảnh nào. Lỗi đó là nhất thời — nhưng
hậu quả thì vĩnh viễn: `startMediaGeneration` từ chối vì "chưa có kịch bản", nên
cả *chạy tiếp* lẫn nút *Thử lại* đều bó tay. Đã sửa ở hai chỗ: `handleBatchExpand`
và `retryVideo` đều tự viết lại kịch bản khi gặp dự án `draft` rỗng.

**2. Hai test nghiệm thu hỏng vì mốc thời gian, không phải vì code.** Một bước
rút cạn cả lô — 18 job mock cộng ba lần render FFmpeg thật — và vượt mốc 300
giây mặc định. Ban đầu tôi quy cho việc chạy song song bộ test và lô UI; chạy
riêng vẫn hỏng y hệt, nên giả thuyết đó sai. Đã nâng mốc cho bước đó và thu hẹp
bước "khởi động lại" để nó không render lại toàn bộ lần nữa.

### Chưa làm trong V1

- Chưa chạy lô nào với API thật. Chỉ mock.
- Bảng dự toán dùng **kịch bản mẫu 6 cảnh** cho video chưa có kịch bản, và có
  ghi nhãn. Hạn mức/video được kiểm tra **lại** theo kịch bản thật trước khi
  video đó chi tiền video — dự toán sai làm kế hoạch sai, không làm việc chi sai.
- Chưa có nút thử lại **từng cảnh** trên giao diện (service `retryScene` đã có).
- Trang `/batches/[id]` **không tự làm mới**, và điều hướng tới cùng URL thì
  trình duyệt không tải lại — phải F5 hoặc đổi URL mới thấy tiến trình mới. Đây
  là điểm khó chịu thật khi ngồi xem một lô dài.
- Mỗi lần mở lại trang `/batches` rồi bấm dự toán sẽ tạo một dòng lô PLANNED mới.
  Trong cùng một phiên thì bấm lại nhiều lần chỉ cập nhật một dòng, nhưng qua
  lần tải trang mới thì không. Các dòng thừa là DRAFT, không chi được gì.
- **Chấm điểm chất lượng chưa nối vào cổng lô.** Hiện không rò tiền vì
  `getQualityProvider` chỉ trả mock, nhưng phải nối trước khi thêm quality model
  thật.
- Cơ chế nối tiếp việc giữ chỗ tiền chỉ bảo đảm **trong một tiến trình**. Ứng
  dụng vốn được thiết kế chạy một tiến trình (worker giả định nó là duy nhất),
  nhưng nếu sau này chạy hai bản cùng trỏ vào một file SQLite thì phải đổi sang
  transaction có khoá ghi thật.

---

## Tình trạng build

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Lint | `npm run lint` | ✅ 0 lỗi |
| Kiểu dữ liệu | `npm run typecheck` | ✅ 0 lỗi (TS strict, không dùng `any`) |
| Kiểm thử | `npm run test` | ✅ **636 test / 26 tệp, tất cả đạt** |
| Build production | `npm run build` | ✅ 16 route biên dịch thành công |
| Chạy thật | `npm start` | ✅ Đã kiểm tra thủ công trên Windows 11 |

Môi trường đã kiểm chứng: Windows 11 Pro 26200, Node v24.14.1,
FFmpeg 6.1.1 (bản đi kèm ffmpeg-static, có libass + libx264).

---

## ⚠️ CHI PHÍ API THẬT

**Đã chi: $3,712760** / hạn mức **$8,00** — còn **$4,287240**. Đây là con số
duy nhất đúng; xem bảng ví từng nhà cung cấp ở đầu tài liệu.

| Loại | Số lần | Chi phí thật |
|---|---|---|
| Image AI (OpenAI `gpt-image-2:medium`) | 29 ảnh | $1,193640 |
| Video AI (OpenAI `sora-2:720x1280`) | 2 clip × 4s | $0,800000 |
| Video AI (Runway `gen4_turbo` + `gen4.5`) | 3 clip | $1,690000 |
| Voice AI (OpenAI `gpt-4o-mini-tts`) | đã chạy thật | trong ví openai |
| Text AI (Groq `openai/gpt-oss-120b`) | 24 lần | $0,028854 |

Đây là **tiền thật**. Kiểm tra lại bất cứ lúc nào bằng `spendStatus()` và
`providerSpendBreakdown()` — con số trong tài liệu sẽ cũ đi, sổ chi phí thì không.

`.env` đang ở `AI_MOCK_MODE=true` — chế độ an toàn.

> Bản trước của mục này ghi hạn mức **$3,00** và nói Voice AI còn mock. Cả hai
> đều đã sai từ lâu: hạn mức được nâng lên $8,00 và Voice AI đã chạy thật. Ghi
> lại ở đây vì một con số cũ trong tài liệu trạng thái không vô hại — nó là thứ
> phiên làm việc sau sẽ tin.

---

## Nghiệm thu qua giao diện (2026-09-13)

Ba dự án được tạo **hoàn toàn qua UI** như người dùng thật, với
`AI_MOCK_MODE=false`:

| Thành ngữ | Cảnh | Thời lượng | Chi phí thật |
|---|---|---|---|
| Break a leg | 5 | 27,0s | $0,0023 |
| Spill the beans | 6 | 27,0s | $0,0058 |
| Piece of cake | 6 | 23,0s | $0,0019 |

Luồng đã đi qua: UI → chọn idiom → tạo project → AIRouter → TextProvider thật →
script → kiểm tra JSON → storyboard → chấm điểm → sổ chi phí → dashboard.

Image/Video/Voice giữ nguyên mock trong suốt quá trình.

### Các mục an toàn đã kiểm chứng

| Mục | Kết quả |
|---|---|
| Router KHÔNG âm thầm dùng mock khi ở chế độ thật | ĐẠT — cả 3 dự án đều ghi `provider=groq` |
| Provider thật lỗi → UI báo rõ provider/model/lý do | ĐẠT — *"Không tìm thấy model... provider=groq, code=model_not_found"* |
| Không giả vờ thành công bằng mock | ĐẠT — lỗi được ném ra, không có fallback ngầm |
| API key không xuất hiện trong log | ĐẠT — quét 59 dòng LogEntry + 34 ProviderJob, không có key, không có chuỗi `gsk_` |
| Không tạo request trả phí trùng lặp | ĐẠT — 34 khoá idempotency đều duy nhất |
| Dashboard phân biệt 3 loại chi phí | ĐẠT — API thật / ước tính / mock hiển thị riêng |
| Kịch bản 4–6 cảnh, không bị cắt | ĐẠT — 5/6/6 cảnh, mọi cảnh 2–6 giây |
| Lấy danh sách model từ provider thật | ĐẠT — liệt kê 7 model Groq, cảnh báo model lỗi thời |
| Tổng chi phí ≤ $0,50 | ĐẠT — $0,014745 |

---

## Milestone 1 — hoàn tất và đã kiểm chứng

Toàn bộ quy trình chạy được ở chế độ mock, xuất ra MP4 1080x1920 thật.

- [x] Next.js 15 + React 19 + TypeScript strict, chạy trên Windows, không Docker
- [x] SQLite + Prisma, lược đồ sẵn sàng chuyển sang PostgreSQL
- [x] 137 thành ngữ, 2 nhân vật, 6 phong cách, 21 model, 9 nhà cung cấp
- [x] Giao diện tiếng Việt 12 trang
- [x] AI Router định tuyến **theo từng cảnh**, 4 chế độ, 5 chiến lược
- [x] Ước tính chi phí 3 chế độ, NGÂN SÁCH TỐI ĐA chặn cứng
- [x] Tối ưu ngân sách theo lô
- [x] Job Queue trên SQLite, thử lại 10s/30s/90s
- [x] Chống tính phí hai lần bằng khoá idempotency
- [x] Storyboard 3 khung, sửa/duyệt/bỏ qua cảnh
- [x] Phụ đề SRT + ASS, ghi lên hình
- [x] FFmpeg render — **đã kiểm chứng: MP4 1080x1920, H.264, 30fps, 25.1 giây**
- [x] Chế độ ngoại tuyến, dọn dẹp, sao lưu, doctor

Chi tiết đầy đủ xem lịch sử Git (commit `docs: add README, docs/ and .ai state tracking`).

---

## Milestone 2 bước 1 — Text AI thật

### Đã viết xong

- [x] `OpenAICompatibleTextProvider` — nói chuẩn Chat Completions, nên một lớp
      dùng được cho OpenAI, DeepSeek, Groq, OpenRouter, Together, Google
      (endpoint tương thích), và Ollama / LM Studio chạy cục bộ
- [x] Cắm vào `registry.ts` — điểm cắm duy nhất, Mock Mode vẫn là cổng chặn cứng
- [x] **Xoá hard-code provider khỏi business logic**: `project-service.ts` từng
      ghim cứng `"mock"/"mock-text-1"`, giờ chọn qua AI Router từ `ModelRegistry`
- [x] `ModelRegistry.priceOutput` — text API tính giá input/output khác nhau
- [x] `ProviderJob.inputTokens / outputTokens / durationMs`
- [x] **Hạn mức chi tiêu cứng** (`spend-guard.ts`): mặc định **$0.50**, kiểm tra
      trước MỌI request trả phí, cộng dồn toàn ứng dụng
- [x] **Cổng xác nhận** theo từng cặp provider/model: hiển thị provider, model,
      giá input, giá output, ước tính/kịch bản, đã chi, hạn mức, còn lại — rồi
      mới cho bấm xác nhận
- [x] Từ chối bật model chưa nhập giá (trừ model chạy cục bộ, vốn thật sự free)
- [x] Phân loại lỗi: 401/403/400/404/402 **không** thử lại; 429/5xx có thử lại,
      tôn trọng header `Retry-After`; tối đa 3 lần, không lặp vô hạn
- [x] Ghi nhận mỗi request: provider, model, token vào/ra, ước tính, chi phí
      thật, thời gian, trạng thái, lỗi
- [x] API key chỉ nằm trong header `Authorization`, không vào log/body/URL
- [x] Sửa JSON hỏng dùng lại `parseScript` + `repairJson` của Milestone 1
- [x] `npm run compare:text` — so sánh Mock vs Real trên cùng một thành ngữ

### Đã kiểm chứng bằng cách nào

**1. Máy chủ giả lập chạy cục bộ** (`tests/text-provider.test.ts`, 35 test,
chi phí $0.00): dạng request, đọc token, key nằm đúng header, 429 → thử lại,
401 → **chỉ gọi 1 lần**, 500 liên tục → dừng đúng 3 lần, phản hồi bị cắt, phản
hồi rỗng, tính tiền theo token, JSON bọc code fence / có lời dẫn, mọi nhánh của
hạn mức chi tiêu, và lịch sử chi phí không bị xoá theo dự án.

**2. Gọi API thật tới Groq** (`npm run compare:text`) — nhà cung cấp
`groq`, model `openai/gpt-oss-120b`:

| Tiêu chí | Mock | Groq thật |
|---|---|---|
| JSON đúng schema | ĐẠT | **ĐẠT** |
| Số cảnh (cần 4–6) | 6 | **6** |
| Tổng thời lượng (cần 20–35s) | 26,9s | **27,0s** |
| Mỗi cảnh 2–6 giây | ĐẠT | **ĐẠT** |
| Đủ prompt ảnh | ĐẠT | **ĐẠT** |
| Đủ prompt video | ĐẠT | **ĐẠT** |
| Có giải thích nghĩa | ĐẠT | **ĐẠT** |
| Có câu ví dụ | ĐẠT | **ĐẠT** |
| TB từ/phụ đề (nên ≤ 12) | 6,2 | **6,8** |
| Điểm tự chấm | 7/9/9/9/7 | **8/7/9/9/8** |
| Token | – | 1647 vào / 3447 ra |
| Chi phí thật | $0,000000 | **$0,002832** |

**3. Workflow thật đầy đủ** (`npm run workflow:test`) — Text AI thật, media
vẫn mock: thành ngữ → dự án → kịch bản → kiểm tra JSON → lưu SQLite →
storyboard → chấm điểm → định tuyến media → ước tính 3 chế độ.

Router chọn đúng `groq/openai/gpt-oss-120b` (rẻ hơn mock 10 lần nên thắng về
giá trị). Nhánh **viết lại kịch bản một lần** đã thực sự kích hoạt trong một lần
chạy: 4 request (script, score, script-rewrite, score-rewrite), tổng $0,0049,
mọi request đều được ghi token + thời gian + chi phí vào bảng `ProviderJob`.

**4. Giao diện** đã kiểm tra thủ công: cổng xác nhận hiện đủ 8 chỉ số và 3 cảnh
báo đúng; bấm xác nhận khi model chưa có giá thì **bị từ chối**.

### Chất lượng nội dung: Mock so với Groq thật

Cả hai đều qua toàn bộ kiểm tra cấu trúc. Khác biệt về nội dung:

- **Groq thật** viết tiếng Anh tự nhiên hơn và bám sát thành ngữ hơn. Ví dụ với
  "Piece of cake": *"Max brings a cake to the exam!"* → *"Leo shows the paper is
  easy, not edible."* Đây là trò đùa hình ảnh thật, quốc tế, hiểu được không cần
  âm thanh.
- **Mock** dùng khuôn mẫu cố định nên lời thoại lặp lại giữa các thành ngữ.
- Giải thích nghĩa của Groq chính xác: *"Piece of cake means something is very
  easy."*
- Groq tự đặt thời lượng cảnh và độ phức tạp hợp lý, đủ prompt ảnh/video cho các
  bước sau.

Kết luận: **Text AI thật cho chất lượng dùng được cho sản xuất.** Mock vẫn hữu
ích để thử quy trình miễn phí.

## Milestone 2 bước 2 — Image AI thật

**Đã chạy thật với OpenAI và kiểm chứng bằng mắt.**

### Đang dùng

```
Provider : openai
Model    : gpt-image-2 (tầng medium)
Giá      : ước tính $0,048/ảnh — thực tế đo được $0,041160/ảnh
Kích thước: 1024x1536 (khổ dọc gần 9:16 nhất mà API chấp nhận)
```

Giá thực tế **tính từ số token API báo về** ($30 / 1M token đầu ra), không phải
con số đoán. Giá ước tính chỉ dùng để kiểm tra hạn mức *trước* khi gọi — bắt
buộc phải có, vì lúc đó chưa biết số token.

### Vì sao chọn gpt-image-2

Danh sách model lấy trực tiếp từ OpenAI cho thấy `gpt-image-1` mà bản seed ghi
sẵn đã là đời cũ. `gpt-image-2` vừa mới hơn vừa **rẻ hơn** ($30 so với $40 mỗi
1M token đầu ra). Đây đúng là lý do phải hỏi nhà cung cấp thay vì tin danh sách
cũ.

### Character Reference System

Bảng `CharacterReference` thay cho mảng JSON: mỗi ảnh một dòng, nên duyệt/đổi/xoá
từng ảnh được, và "ảnh chuẩn nào đang dùng" thành dữ liệu truy vấn được.

Nhân vật có thêm `hair`, `facialFeatures`, `outfit`, `bodyProportions`,
`accessories`, `colorPalette`, `version`. Mỗi trường vào prompt thành một mệnh đề
riêng có nhãn — model ít chỗ diễn giải lại hơn hẳn một đoạn văn dài.

`buildScenePrompt` xếp: hành động cảnh trước → mô tả nhân vật → **câu khoá thuộc
tính cuối cùng**, nơi model đọc gần nhất và tuân thủ mạnh nhất.

Ảnh cảnh gọi `/images/edits` kèm ảnh chuẩn đã duyệt. Đó là cách duy nhất cho model
biết nhân vật *đã* trông như thế nào, thay vì vẽ lại từ chữ mỗi lần.

### Quy tắc quan trọng nhất

**Ảnh chuẩn đã duyệt không bao giờ bị thay tự động.** Mọi lần tạo mới chỉ sinh
ứng viên `approved=false, isPrimary=false`. Có test riêng canh điều này.

### Kết quả chạy thật

```
2 ảnh chuẩn (Max, Leo) + 9 ảnh cảnh từ 3 thành ngữ = 11 ảnh
Max  : 9/9 cảnh đều nhận ảnh tham chiếu
Leo  : 4/4 cảnh đều nhận ảnh tham chiếu
Tổng : $0,452760
```

Kiểm tra bằng mắt qua 3 cảnh "Break a leg" và chéo sang "Piece of cake": tóc,
khuôn mặt, hoodie vàng sọc trắng, quần jeans lật gấu, giày trắng của Max giữ
nguyên; kính tròn, áo teal xắn tay, quần xám, giày nâu của Leo giữ nguyên;
chênh lệch chiều cao Max–Leo cũng giữ đúng.

---

## Character Presence — sửa sau khi phát hiện ở bước Image AI

**Vấn đề:** sự có mặt của nhân vật được suy ra từ việc ai có thoại. Nhân vật
đứng im phản ứng trong khung hình không có lời nào, nên **không được gửi ảnh
tham chiếu** và bị AI vẽ tự do.

**Cách sửa:** tách một danh sách thành ba, lưu riêng trong `Scene`:

| Trường | Trả lời câu hỏi | Dùng cho |
|---|---|---|
| `charactersPresentJson` | ai **được nhìn thấy** | tạo ảnh |
| `speakingCharactersJson` | ai **có thoại** | tạo giọng |
| `primaryCharactersJson` | cảnh **nói về ai** | thứ tự ưu tiên ảnh tham chiếu |

Suy diễn chỉ đi một chiều: ai nói thì chắc chắn có mặt. **Không bao giờ ngược
lại** — đó chính là suy diễn gây ra lỗi.

Thứ tự ưu tiên khi nhà cung cấp giới hạn số ảnh tham chiếu: trọng tâm → người
nói → còn lại. Nhân vật bị cắt khỏi danh sách ảnh **vẫn giữ nguyên hồ sơ chữ
trong prompt**.

**Tự sửa trước khi gọi API:** nếu mô tả cảnh nhắc tên một nhân vật không có
trong `charactersPresent`, hệ thống bổ sung và ghi cảnh báo. Không âm thầm tạo
ảnh với dữ liệu mâu thuẫn.

**Kiểm chứng thật:** cảnh có Max + Leo + Mia, chỉ Max nói — cả ba đều được gửi
ảnh tham chiếu và vẽ đúng mẫu. Mia im lặng vẫn đúng hình.

### Khung hình và vùng cắt

Ảnh là 1024x1536 (2:3), video là 1080x1920 (9:16). Ảnh **rộng hơn** khung video,
nên bộ render phóng to phủ kín rồi cắt **hai bên trái/phải** khoảng 8% mỗi bên;
toàn bộ chiều cao được giữ. Trực giác thường đoán ngược lại.

Prompt yêu cầu giữ nhân vật trong 84% chiều ngang ở giữa. Storyboard có lớp phủ
hiển thị đúng vùng bị cắt.

---

## Chế độ chất lượng ảnh — chốt V1

**Mọi chế độ đều chỉ tự vẽ MỘT ảnh.** Không chế độ nào âm thầm trả tiền cho ảnh
thứ hai.

| Chế độ | Hành vi |
|---|---|
| ECONOMY | 1 ảnh, model tiết kiệm, không tự vẽ lại |
| BALANCED | 1 ảnh, model tốt/giá hợp lý, tự vẽ lại tối đa 1 lần khi ảnh hỏng rõ |
| QUALITY | 1 ảnh bằng model chất lượng cao. Người dùng bấm **"Tạo phương án khác"** để có ứng viên thứ 2 và tự chọn |
| CUSTOM | người dùng tự chọn provider/model |

Ước tính chi phí **chỉ đếm ảnh hệ thống tự vẽ**. Ảnh người dùng chủ động tạo
thêm là quyết định riêng của họ, không đưa vào dự báo — dự báo thừa sẽ làm hạn
mức còn lại trông nhỏ hơn thực tế.

Ảnh cũ không bị mất: mọi ảnh từng tạo đều còn trong bảng `Asset`, hiển thị thành
dải ứng viên để chọn lại, miễn phí.

---

## Vùng cắt 9:16 — đo bằng số liệu

`npm run crop:check` giải mã ảnh bằng ffmpeg và đo phần nội dung rơi vào dải bị
cắt, tách riêng ba dải: mặt/đầu, tay/đạo cụ, chân/bàn.

Phát hiện: cảnh **1–2 nhân vật nằm gọn** trong vùng an toàn; cảnh **3 nhân vật
dàn ngang hết khung** và mất chi tiết hai bên. Đã thêm chỉ dẫn gom nhóm cho cảnh
từ 3 nhân vật trở lên — đo lại cho thấy nội dung thu từ 0–100% về 4–96%.

Lưu ý khi đọc kết quả: phép đo đếm **mọi** nội dung, kể cả mép tóc và mũi giày,
nên nó là bộ lọc thận trọng chứ không phải số lỗi.

---

## Milestone 2 bước 3 — Video AI

### Sora-2 đã kiểm chứng bằng 2 clip thật

| | Test #1 | Test #2 |
|---|---|---|
| Character Identity | 10 | 7 |
| Motion | 3 | 8 |
| Artifacts | 8 | 7 |
| Camera | 10 | 10 |
| Composition | 6 | 9 |
| Humor readability | 3 | 8 |

**Kết luận:** identity và motion **đánh đổi trực tiếp** — prompt cho cử động
nhiều thì model biến dạng nhiều hơn. Camera tĩnh tuyệt đối ở cả hai lần.
$0,40 cho 4 giây → **$2,40 cho một video 6 cảnh**, đắt hơn toàn bộ ảnh và text
cộng lại.

**Chưa chốt Sora-2 làm mặc định cho BALANCED.**

### Ba adapter video đã viết, chưa gọi API

| Provider | Model | Giá 4s | Key | Đã chạy thật |
|---|---|---|---|---|
| openai | `sora-2:720x1280` | $0,40 | ✅ | ✅ 2 clip |
| runway | `gen4_turbo:720x1280` | **$0,25** | ❌ | chưa |
| google | `veo-3.1-lite...:720x1280` | $0,40 | ❌ | chưa |

Hai ràng buộc về giá mà adapter đã tính sẵn, đừng tính lại bằng tay:

- **Runway chỉ bán clip 5 hoặc 10 giây.** Cảnh 4 giây bị tính tiền 5 giây.
- **Veo bị ép 8 giây** khi có ảnh keyframe hoặc dùng 1080p. Chưa kiểm chứng
  được ảnh keyframe đầu tiên có tính là "reference image" hay không — adapter
  giả định là CÓ, nên báo giá cao hơn thực tế thay vì thấp hơn hoá đơn.

Xem bảng đầy đủ: `npm run video:benchmark`

---

## Chưa làm (các bước sau)

### Milestone 2 bước 2-4 — ĐÃ XONG
- [x] Image AI thật — OpenAI `gpt-image-2`
- [x] Video AI thật — Runway `gen4_turbo`, `gen4.5`; OpenAI `sora-2`
- [x] Voice AI thật — OpenAI `gpt-4o-mini-tts`

**Chỉ còn Upscale là mock.** Image, Video, Voice đều đã chạy thật và đã ghi chi
phí vào sổ.

### Milestone 3-4
- [ ] Nhiều nhà cung cấp video, định tuyến thật
- [ ] Đo `historicalSuccessRate` thật theo thời gian
- [ ] Nhất quán nhân vật nâng cao, phụ đề động, SFX, nhạc nền
- [ ] Nâng phân giải thật, YouTube API, lên lịch, phân tích

### Có backend nhưng chưa có nút trên giao diện
- [ ] Sinh metadata YouTube
- [ ] Sửa mẫu prompt từ trang quản trị
- [ ] Tải ảnh tham chiếu nhân vật
- [ ] Chọn nhạc nền cho dự án

---

## Lỗi đã biết

Không có lỗi nào đang mở.

### Đã phát hiện và sửa trong Milestone 1

| Vấn đề | Cách sửa |
|---|---|
| `slugify` làm mất chữ "đ" tiếng Việt | NFD không tách "đ"; thêm ánh xạ riêng |
| Bộ che khoá bí mật bỏ sót khoá nhiều đoạn | Cho phép `-` và `_` trong thân khoá |
| Chiến lược CHEAPEST vẫn bị ngưỡng chất lượng ép lên model đắt | Ngưỡng chỉ áp dụng khi strategy = AUTO |
| Kế hoạch có cảnh không định tuyến được vẫn báo "trong ngân sách" | `withinBudget` yêu cầu không còn lỗi định tuyến |
| Chi phí chấm điểm chất lượng ghi theo ước tính | Ghi theo chi phí nhà cung cấp báo về |
| Thanh trạng thái luôn báo "worker đang tắt" | Trạng thái worker chuyển sang `globalThis` |
| `window.confirm` chặn toàn bộ renderer | Thay bằng xác nhận nội tuyến |
| `zoompan` ở 1080x1920 quá chậm | Đổi sang scale + crop di động |
| Thẻ hình mock tràn khung | Tự co chữ, neo khối chú thích từ đáy |
| Dọn thư mục test trong `setupFiles` gây EPERM | Chuyển sang `globalSetup` |

### Đã phát hiện và sửa trong Milestone 2 bước 1

| Vấn đề | Cách sửa |
|---|---|
| `project-service.ts` **hard-code** `"mock"/"mock-text-1"` — vi phạm nguyên tắc không ghim provider vào business logic | Thêm `selectTextModel()` dùng AI Router đọc từ `ModelRegistry` |
| `ModelRegistry` chỉ có 1 trường giá, không tính đúng được chi phí text (input và output khác giá) | Thêm cột `priceOutput` + ô nhập trong giao diện |
| `TextProvider` không báo cáo token đã dùng, nên không thể ghi chi phí thật | Đổi interface: mọi lệnh gọi text trả kèm `ProviderUsage` |
| `.gitignore` có `data/` nên nuốt luôn `src/data/` là mã nguồn | Neo về gốc repo: `/data/` |
| Dùng `require()` để tránh circular import | Không cần — `script-service` đã được import tĩnh sẵn |

### Đã phát hiện khi NGHIỆM THU QUA UI

| Vấn đề | Cách xử lý |
|---|---|
| **Chi phí làm tròn 4 chữ số** nên khoản $0,000045 bị ghi thành $0 — cộng dồn nhiều lần gọi nhỏ sẽ sai lệch | Sổ chi phí và hạn mức chuyển sang 6 chữ số |
| **Lỗi "phản hồi rỗng" không mang theo chi phí** — cùng loại lỗ hổng với truncation: đã bị tính tiền nhưng sổ không ghi | Dựng `ChatResult` trước khi kiểm tra nội dung, mọi lỗi sau đó đều đính `usage` |
| **Text AI thật trả về cảnh 7 giây** — vượt giới hạn 6s mà mỗi lần tạo video AI chịu được. Mock tự giới hạn, provider thật thì không | Cắt về 2–6 giây trong `withDerivedRouting`, kèm test |
| Lấy danh sách model lại đòi model phải đang bật — không thể khám phá model trước khi bật nó | `buildTextConfig` nhận cờ `requireEnabled` |

### Đã phát hiện khi CHẠY THẬT (những lỗi mà test giả lập không bắt được)

| Vấn đề | Cách xử lý |
|---|---|
| **Danh sách biến môi trường viết cứng** khiến provider mới luôn bị coi là "thiếu API key" → router bỏ qua Groq và âm thầm chọn mock dù key đã có | `hasEnvKey()` giờ đọc `apiKeyEnvVar` từ bảng provider, fallback `TÊN_API_KEY` |
| **Xoá dự án làm mất lịch sử chi phí thật** (`CostEntry` cascade theo `Project`) → hạn mức được "hoàn lại" sai, có thể tiêu vượt bằng cách xoá dự án cũ | Đổi quan hệ sang `onDelete: SetNull`; thêm test chống tái diễn |
| **Chi phí bị mất khi request thất bại sau khi đã bị tính tiền** (phản hồi bị cắt, JSON không đọc được) | `ProviderError` mang theo `usage`; sổ ghi nhận cả lần thất bại, ghi rõ "thất bại nhưng vẫn bị tính phí" |
| Giới hạn 2500 token output làm kịch bản 6 cảnh bị cắt giữa chừng | Đo thực tế rồi nâng lên 6000; cơ chế phát hiện cắt đã báo đúng lỗi |
| `provider:enable` chỉ bật model, quên bật cả provider → router vẫn không thấy | Bật cả `ProviderConfig` |
| Tên model `llama-3.3-70b-versatile` đã bị Groq gỡ bỏ | Lấy danh sách thật từ `/v1/models`, cập nhật seed thành `openai/gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b` |
| Script so sánh gọi provider trực tiếp, **bỏ qua hạn mức và không ghi sổ** | Bắt nó đi qua `assertCanSpend` + `recordCost` như ứng dụng |

---

## Tình trạng lược đồ

Ổn định. 15 bảng. Đã đồng bộ qua `prisma db push`.

Thay đổi trong Milestone 2 bước 1:
- `ModelRegistry.priceOutput` (Float, mặc định 0)
- `ProviderJob.inputTokens`, `outputTokens`, `durationMs` (Int?, cho phép null)

Chưa tạo tệp migration — vẫn dùng `db push`. Nên chuyển sang `prisma migrate`
trước khi phát hành cho người khác dùng.

---

## Việc nên làm tiếp theo

Xem [NEXT_TASKS.md](NEXT_TASKS.md).

**Milestone 2 bước 1 đã nghiệm thu xong.** Không tự động chuyển sang bước 2
(Image AI) — chờ người dùng xác nhận.

Cấu hình hiện tại:

```
Provider : groq (bật, đã xác nhận)
Model    : openai/gpt-oss-120b
Giá      : $0.00015 / 1k token vào, $0.00075 / 1k token ra
Hạn mức  : $0.50, đã chi $0.014745, còn $0.485255
.env     : AI_MOCK_MODE=true  ← chế độ an toàn
```

Để dùng Text AI thật: đặt `AI_MOCK_MODE=false` trong `.env` rồi khởi động
lại. Để quay về miễn phí: đặt lại `true`.

> Giá đang dùng là theo bảng giá Groq tại thời điểm cấu hình. Hãy đối chiếu lại
> tại https://groq.com/pricing nếu con số ước tính trông không đúng.
>
> Trước khi thêm model mới, bấm **"Hỏi nhà cung cấp"** trong trang Nhà cung cấp
> AI để lấy tên model đang thực sự khả dụng — Groq đã gỡ một model mà chúng ta
> seed sẵn, và đó là nguyên nhân lỗi 404 ở lần chạy thật đầu tiên.

---

## LOW_AUTO cho h3_max — ĐÃ BẬT — 2026-09-16

`runway/h3_max:768x1280` đã chuyển **`LOW_AUTO_CANDIDATE` → `LOW_AUTO`** sau khi
người dùng đồng ý. Đúng **một trường trên 37 model** thay đổi; **0/23 cảnh** bị
đổi; cả **6 ghim tay giữ nguyên**; `ProviderJob` 102→102, `CostReservation` 3→3,
`CostEntry` 120→120.

Quyền này **chưa đổi lấy quyết định nào**: router tự chọn **0 cảnh**. Cả 3 cảnh
LOW còn muốn clip trả phí đều đang ghim tay, và ghim tay thì short-circuit phần
chấm điểm. Quyền chỉ có tác dụng với **cảnh mới hoặc cảnh không ghim tay**.

### Vì sao không thể chỉ đổi một cờ

Trước đây "bật LOW_AUTO" chỉ có đúng một cách: đổi `lifecycle` thành `ACTIVE`.
Dry-run trên registry giả lập `ACTIVE` cho kết quả **6 cảnh MEDIUM/HIGH — tất cả
3 nhân vật, tất cả không keyframe — rơi vào h3_max**. Không có gì chặn, vì
`MAX_COMPLEXITY` chưa có dòng nào cho model này và cổng 11 điều kiện thì
**production chưa từng gọi**.

### Bốn ổ khoá độc lập, hiện đã có đủ

| Lớp | Ở đâu | Chặn gì |
|---|---|---|
| Vòng đời | `domain/enums` → `isAutoRoutable(lifecycle, {complexity})` | `LOW_AUTO` chỉ đúng khi `complexity === "LOW"`; không biết độ khó thì `false` |
| Cổng cảnh | `domain/low-auto` → `lowAutoRouteBlock()` | keyframe thật, ≤2 nhân vật, camera khoá, không vật nhỏ dày đặc, prompt sạch, 3 loại ngân sách |
| Trần cứng | `domain/video-suitability` → `MAX_COMPLEXITY` / `MAX_CHARACTERS` | MEDIUM/HIGH và >2 nhân vật, **kể cả ghim tay** |
| Quyền chi | `services/batch-authorization` → `lowAutoApproved` | quyền chi cũ không trả được cho clip router tự chọn |

Cổng giờ **thật sự được gọi**: `lowAutoRouteBlock()` nằm trong bộ lọc ứng viên
của `routeScene()`, cạnh `autoRouteBlock()` và `requiresExplicitPin()`.

### Dry-run sau khi sửa: 12/12 ĐẠT

```
MEDIUM -> h3_max                0 cảnh
HIGH -> h3_max                  0 cảnh
>2 nhân vật -> h3_max           0 cảnh
thiếu keyframe -> h3_max        0 cảnh
LOCAL_MOTION -> trả phí         0 cảnh
DIRECTED_CAMERA -> h3_max       0 cảnh
mâu thuẫn benchmark             0
phát sinh mới (E)               $0,000000
```

**Kết luận: SAFE TO ENABLE — nhưng quyền hiện chưa có tác dụng gì.** Cả 2 cảnh
chạy `h3_max` đều do **ghim tay**, router tự chọn **0 cảnh**. 4 cảnh LOW còn lại
là LOCAL_MOTION, 1 cảnh thiếu keyframe. Cấp quyền hôm nay không đổi lấy một
quyết định nào.

### Bốn cảnh `motionSource` bất đồng

`5c698155`, `0cc1d8cf` → thành **LOCAL_MOTION** (miễn phí thắng).
`4dd22035`, `8453fa52` → giữ **AI_VIDEO** vì đã **ghim tay** h3_max.

Không sửa DB. Bất đồng được log `scene.motion_source_diverged` mức WARN. Xem
QĐ-052.

### Còn treo, cố ý

- **`8453fa52`** (Spill the beans #6, MEDIUM, ghim h3_max) **bị từ chối** vì trần
  độ khó. Hệ quả đã lường trước của QĐ-051 — cần gỡ ghim hoặc hạ phân loại cảnh,
  không phải nới trần.
- **`d9c9b991`** (Spill the beans #3) ghim `gen4.5` đang `PIN_ONLY`, $0,72. Ghim
  tay vẫn tới được, đúng thiết kế. Chưa đụng.
- Ba dự án **Break a leg / Piece of cake / Spill the beans** đều là cảnh HIGH với
  3 nhân vật. Không cảnh nào route được, và đó là **trạng thái đúng**: kể từ
  QĐ-028 không còn provider nào được duyệt cho MEDIUM/HIGH (Sora DEPRECATED,
  gen4.5 PIN_ONLY, gen4_turbo DEGRADED), và LOW_AUTO cố ý không mở rộng sang đó.

---

## Lô cũ `11af6ba6` — ĐÃ ĐÓNG 2026-09-17

Trạng thái trước đó ghi "KHÔNG đóng, đang có dependency thật". Điều đó đúng ở
thời điểm viết và **đã hết đúng**: lô dừng hẳn từ 2026-09-15, job dẫn đầu đã
`failed`, và cái gọi là dependency hoá ra là **6 job `queued` đang lên nòng** chứ
không phải một lô đang chạy.

```
quyền chi  APPROVED  -> CANCELLED
lô         RUNNING   -> CANCELLED
job        6 queued  -> 6 cancelled
```

**Vì sao phải đóng, chứ không chỉ để đó.** `claimNext` lấy job theo `priority`
tăng dần và **không lọc theo lô**. Sáu job đó (priority 102–106 và 500) sẽ đi
**trước** bất cứ lô mới nào, trên một lô không ai theo dõi, gồm một cảnh ghim
`gen4_turbo` đang `DEGRADED` và không có keyframe. Ước tính nếu chúng chạy:
~5 ảnh × $0,041 + 1 clip $0,25 ≈ **$0,456**, vừa đủ vét sạch $0,458840 còn lại.

**Cái gì KHÔNG bị đụng** — kiểm bằng cách đọc lại DB sau khi ghi, không phải bằng
lời script tự khai:

```
job queued/processing còn : 0            ĐẠT
quyền chi                 : CANCELLED    ĐẠT
đang giữ chỗ              : $0,000000    ĐẠT
actualSpend giữ nguyên    : $0,441160    ĐẠT
sổ chi thật giữ nguyên    : 120 dòng $5,353920   ĐẠT
reservation đã chốt còn   : 3 (bằng chứng, không xoá)
```

Không hoàn tiền giả. Tiền đã rời đi, và bản ghi vẫn nói đúng như vậy. Xem QĐ-061.

---

## Lô nghiệm thu `a690a290` — CHỜ DUYỆT, chưa chi một đồng

Dự án `f2b68443` "Cold feet" được soạn lại bằng
`scripts/prepare-first-real-video.ts --make-batch`. `persistScript` xoá và tạo
lại toàn bộ cảnh, nên **mọi ghim tay và mọi đường dẫn media cũ biến mất** — kể cả
ghim `gen4_turbo` ở cảnh 4 từng là một quả mìn.

```
6 cảnh · 26 giây · TOÀN BỘ LOW · 1 nhân vật · camera khoá · không ghim tay nào
```

| | |
|---|---|
| LOCAL_MOTION ($0) | 4 cảnh — #2 #3 #5 #6 |
| AI_VIDEO qua LOW_AUTO | 2 cảnh — #1 #4, `runway/h3_max:768x1280`, $0,40/cảnh |
| quyền chi | **DRAFT** — chưa cấp phép chi gì |

Dự toán thật **$1,121800**, đề xuất trần **$1,24**.

**Số này từng sai, và sai theo hướng nguy hiểm nhất.** Trước QĐ-060 bộ dự toán
không truyền dữ kiện cảnh cho cổng LOW_AUTO, cổng fail-closed, và bảng ghi
`VIDEO $0,000000` với hai cảnh `NEEDS_PROVIDER` — tổng **$0,297800**. Đường chạy
thật vẫn sẽ mua hai clip $0,80. Trần duyệt thấp hơn hoá đơn là cách duy nhất chỗ
này gây hại thật.

### Route thật của 23 cảnh hiện có

| | |
|---|---|
| **auto h3_max** (router tự chọn) | **2** — `26de7d41` #1, `bf8bf64d` #4, sau khi có keyframe |
| manual h3_max (ghim tay) | 1 — `4dd22035` Spill the beans #5 |
| LOCAL_MOTION ($0) | 6 |
| model trả phí khác (ghim tay) | 1 — `d9c9b991` gen4.5 |
| bị chặn, không route được | 13 |

Hai cảnh auto **hiện vẫn hiện `CHẶN(needs_keyframe)`** trong `lowauto:dryrun`, và
đó là câu trả lời đúng: dry-run hỏi ở giai đoạn `VIDEO` — "nếu gọi video **ngay
bây giờ**" — mà bây giờ chưa cảnh nào có ảnh. Bộ dự toán hỏi ở giai đoạn kế
hoạch, biết rằng kế hoạch **bao gồm** bước tạo ảnh, nên nó định giá $0,80. Hai
câu hỏi khác nhau, hai câu trả lời đúng.

`scripts/prove-low-auto.ts` chứng minh phần còn lại: cùng cảnh đó, với keyframe
đã có, router tự chọn `runway/h3_max` $0,40 `lowAutoRouted=true`, và 9/9 negative
control vẫn chặn đúng lớp đúng lý do.

### Công cụ

```bash
npm run lowauto:dryrun     # mô phỏng, chỉ 1 GET miễn phí
npm run lowauto:prove      # chứng minh + 9 negative control, $0
npm run runway:balance     # đọc lại số dư live
npm run batch:close-stale  # thử khô; cần --apply mới ghi
```
