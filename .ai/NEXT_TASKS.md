# Việc tiếp theo

**Cập nhật:** 2026-09-17

---

## ✅ XONG 2026-09-18: lô `a690a290` đã chạy hết và có MP4

```
Lô        a690a290-bb28-4dbd-9903-0d8018bb0db1   COMPLETED
Dự án     f2b68443 "Cold feet" — 6 cảnh, 26,09 giây
Quyền chi COMPLETED, trần $1,24, đã chi $1,047095, chưa dùng $0,192905
MP4       data/projects/f2b68443-.../final/final_a0fb91ff.mp4
          1080x1920, 30 fps, h264 + aac 48 kHz mono, 7,48 MB
```

| Hạng mục | Thật | Ghi chú |
|---|---|---|
| IMAGE | $0,205800 | 5 ảnh mới. Ảnh cảnh 1 **dùng lại**, $0 |
| VIDEO | $0,800000 | 2 × `h3_max:768x1280`, task `d4f779ed…` và `ced4ec15…` |
| VOICE | $0,000135 | 6 cảnh |
| RENDER | $0 | FFmpeg tại máy |

Credit Runway **671 → 591**, chênh 80 = 2 clip × 40, khớp tuyệt đối với $0,80
trong sổ. Giữ chỗ treo: **0**. `retryCount` cả 6 cảnh vẫn **0**.

**Vì sao nó từng dừng:** `runway/h3_max:768x1280` không nằm trong
`spend.confirmedProviders`. Quyền chi lô trả lời "được tiêu bao nhiêu", danh sách
xác nhận trả lời "cặp model này đã được nhìn giá và đồng ý chưa" — lô qua ổ khoá
thứ nhất rồi chết ở ổ thứ hai. Xem QĐ-062.

**Cách chạy tiếp một lô dừng giữa chừng** (mặc định là thử khô, $0):

```
npx tsx scripts/resume-batch.ts --batch <id>
AI_MOCK_MODE=false npx tsx scripts/resume-batch.ts --batch <id> --apply --confirm-real-spend
```

Nó tự bật xác nhận provider trong `try` và **thu hồi trong `finally`**, bám lại
đúng job cũ (không tăng `retryCount`), bỏ bước `evaluateScene` (quality model
mock có thể bắt mua lại $0,44), và hỏi lại cổng LOW_AUTO **sau** khi có keyframe.

### Đã xong 2026-09-18 (đợt 2, $0)

- [x] **Chấm 2 clip h3_max** và ghi `VideoBenchmark`. Cảnh 1 **9,09/10**, cảnh 4
      **8,91/10** trên 11 tiêu chí. Đây là hai mẫu **sản xuất thật** đầu tiên —
      khác hẳn các mẫu trước, vốn được mua có chủ đích trên cảnh đã từng làm hỏng
      model khác. **Không** đổi lifecycle/routing của h3_max: 2 mẫu không đủ.
      `npx tsx scripts/record-batch-benchmarks.ts`
- [x] **Sửa nhịp cảnh 5**: thoại 4,0939s → **3,9500s**, cảnh trở lại đúng 4,00s,
      video 26,09s → **26,000s**. Chỉ cắt khoảng lặng (đuôi 0,0704→0,03; nhịp
      ngắt đầu 0,3009→0,1974), **không cắt chữ, không đổi tốc độ giọng**. File
      TTS gốc giữ nguyên trên đĩa. `npx tsx scripts/tighten-scene-pacing.ts`
- [x] **Render lại cục bộ** bằng `scripts/rerender-project.ts` (bấm lại đúng job
      `render_final` cũ, chỉ FFmpeg). MP4 mới: `final_0de14438.mp4`.

### Lỗi production còn mở (không tốn tiền để sửa, nhưng phải sửa trước lô sau)

- [ ] **Prompt ảnh không có bộ dò mâu thuẫn như prompt video.** Cảnh 4 minh hoạ
      hai kiểu mâu thuẫn cùng lúc:
      1. *kịch bản tự mâu thuẫn*: "moves one short pace backwards **along the
         board**" đứng cạnh "**nothing else in frame**" → ảnh ra không có cầu
         nhảy, mất liền mạch với cảnh 1–3;
      2. *bảng nhân vật đè cảm xúc của cảnh*: cảnh ghi "His eyes stay wide"
         nhưng bảng nhân vật lặp "always wide-eyed and eager" + "wide eager
         smile" → ảnh ra **Max đang cười**, sai hẳn nhịp truyện.
      `findPromptContradictions` hiện chỉ soi **videoPrompt**. Cần một bộ tương
      đương cho `buildSceneImageRequest`.
      **Đây không phải lỗi của h3_max** — clip bám keyframe rất sát (10/10);
      nó chỉ trung thành với một tấm ảnh đã sai từ trước.

---

## Đã xong 2026-09-17

- **LOW_AUTO cho `h3_max:768x1280`** — đã bật, đã chứng minh trên dòng
  production. Router tự chọn được **2 cảnh** (lô nghiệm thu #1 và #4); 9/9
  negative control vẫn chặn đúng lớp. Xem QĐ-059.
- **Một dẫn xuất, bốn nơi gọi** (QĐ-060). `deriveSceneVideoFacts` thay ba bản
  chép tay. Bắt được hai lỗi thật:
  - dry-run kiểm keyframe trên **đĩa**, production chỉ đọc **cột** → một ảnh bị
    xoá sẽ khiến production mua clip image-to-video không có ảnh;
  - bộ dự toán không truyền dữ kiện cảnh → báo `VIDEO $0,00` cho một video sẽ
    thật sự tốn **$0,80**. Trần duyệt thấp hơn hoá đơn.
- **Lô cũ `11af6ba6` đã đóng** (QĐ-061). 6 job `queued` đã lên nòng ≈ $0,456 bị
  huỷ, quyền chi thu hồi. Sổ chi thật, reservation đã chốt và log **giữ nguyên**.
- **Số dư Runway** đọc LIVE: 671 credit. Khớp tuyệt đối với sổ nội bộ
  ($3,29 = 329 credit; 1000 − 329 = 671).

---

## Đã xong: h3_max `PIN_ONLY -> LOW_AUTO` (đã bật 2026-09-16, chứng minh 2026-09-17)

Guardrail camera đã chuẩn hoá xong (QĐ-045). 17/23 cảnh thiếu khoá → **0/23**.
Không sửa tay prompt nào: bộ guardrail nằm trong code và áp ở bước cuối trước
khi gửi.

**Bằng chứng ủng hộ** (QĐ-046): độ lệch chuẩn **2,07 → 0,12** khi chỉ tính mẫu
có prompt khoá camera. Cả 3 mẫu đó đều ≥8,9.

**Lý do vẫn nên thận trọng:** 3 mẫu là ít, và cả 3 đều là cảnh **1–2 nhân vật,
nền phẳng**. Chưa có mẫu nào ở cảnh 3 nhân vật — mà 8/23 cảnh của dự án là HIGH
với 3 nhân vật.

**Đã bật.** Giới hạn vẫn nguyên: chỉ LOW, tối đa 2 nhân vật, camera khoá, phải
có keyframe thật trên đĩa. Cảnh 3 nhân vật vẫn **chưa từng được đo** và vẫn nằm
ngoài quyền — lý do thận trọng ở trên không mất đi khi quyền được cấp, nó trở
thành đường viền của quyền đó.

---

## Đã xong: h3_max 4 mẫu — PROMPT-SENSITIVE

A/B mẫu 4 chứng minh vấn đề camera là **do prompt**, không phải bất ổn cố hữu:
cùng cảnh 5, cùng keyframe, chỉ đổi prompt → Camera **1 → 10**, Overall
**4,3 → 9,2**.

### Việc PHẢI làm trước khi bàn LOW_AUTO — miễn phí

**Chuẩn hoá 17/23 cảnh đang có `videoPrompt` thiếu chữ `locked`.** Phần lớn dài
12–118 ký tự, tức mô tả thô chưa từng qua bộ dựng guardrail. Mỗi cảnh như vậy là
một lần lặp lại đúng thất bại của mẫu 2. Không tốn một đồng nào.

Lưu ý khi soạn: `fitVideoPrompt` **thay cả khối ràng buộc** khi prompt vượt 1000
ký tự — guardrail camera sẽ bị xoá âm thầm. Giữ dưới 1000 và kiểm `changed=false`.

### Sau đó

1. Chấm điểm 2 clip sora-2 ngày 13/09 — đã trả tiền, chưa ai chấm. **$0**.
2. Nếu muốn chắc hơn: 1–2 mẫu h3_max nữa trên cảnh đã chuẩn hoá prompt.
3. Quyết định `PIN_ONLY -> LOW_AUTO` là của người dùng.

---

## Đã xong: h3_max 3 mẫu đầu

Điểm: **9,1 / 4,3 / 8,9**. Mẫu 2 hỏng camera (zoom toàn thân → cận mặt dù prompt
cấm). Camera TB 6,00 (cần ≥8), Composition 7,00 (cần ≥8), Motion 6,67 (cần ≥7).

**LOW candidate: KHÔNG.** Chưa đổi router. Quyết định
`PIN_ONLY -> LOW_AUTO` là của người dùng.

### Việc rẻ nhất nên làm tiếp — CHỜ DUYỆT

1. **Chạy lại đúng cảnh 5 với bộ guardrail mới** ($0,40). Prompt hiện tại của
   cảnh 5 là định dạng CŨ, thiếu câu *"no large zoom"* mà mẫu 3 có. Đây là phép
   A/B **chỉ đổi prompt** — đúng kiểu đã từng giải thích được hiện tượng trôi
   camera của gen4.5. Nếu camera lên ≥8, vấn đề là prompt chứ không phải model,
   và việc cần làm là chuẩn hoá prompt cho mọi cảnh chứ không phải bỏ model.
2. **Chấm điểm 2 clip sora-2 ngày 13/09** — đã trả tiền, chưa ai chấm.
   **Không tốn thêm đồng nào.**
3. Chỉ sau khi camera ổn định qua ≥4 mẫu mới bàn tới LOW auto-routing.

---

## Đã xong: benchmark `h3_max:768x1280` mẫu đầu — 1 clip, $0,40

Task `b6fddf11-900b-43f2-9cca-df366f80c6f0`. Credit 831 → 791. Đạt ngay lần đầu,
điểm trung bình **9,1/10** trên đúng cảnh `gen4_turbo` đã hỏng hai lần.

`h3_max:768x1280` = `BENCHMARK_VERIFIED` **và vẫn `PIN_ONLY`**. Router **không**
tự chọn nó. Đổi routing production là quyết định của người dùng, và một mẫu thì
chưa đủ.

### Việc tiếp theo — CHỜ DUYỆT, chưa làm gì

1. **Thêm 2–3 clip `h3_max` nữa** trên cảnh khác nhau trước khi tính chuyện
   auto-route. Một mẫu chứng minh đường ống thông, không chứng minh model ổn
   định. Mỗi clip 5 giây = $0,40.
2. **Thử `h3_max:480x854`** ($0,25/clip) xem 480p có đủ dùng cho cảnh LOW không.
   Rẻ bằng đúng `gen4_turbo`.
3. **Chấm điểm 2 clip sora-2 đã trả tiền ngày 13/09** — chúng chưa từng được
   chấm, nên bảng so sánh đang thiếu bằng chứng mà ta **đã trả tiền để có**.
   Việc này **không tốn thêm đồng nào**.
4. `wan3` vẫn chưa thử. Nhớ cái bẫy `auto_1080p` = 20 credit/s.

---

## Đã xong trước đó: chuẩn bị registry

Đề xuất **đúng một** model thay `gen4_turbo` cho cảnh LOW: **`h3_max:768x1280`**
(MiniMax H3 Max, 768p). Một clip test 5 giây = **40 credit = $0,40**.

**CHƯA CHẠY.** Chờ bạn duyệt.

### Còn một việc PHẢI làm trước khi benchmark

Adapter Runway hiện **luôn** gửi `ratio` + `duration` kiểu Gen-4:

```ts
body: { model, promptImage, promptText, ratio: toRunwayRatio(size), duration: nearestDuration(...) }
```

Nhưng `h3_max` **không có tham số `ratio`** — nó nhận `resolution` (`480p`/`768p`)
và lấy tỉ lệ khung hình **theo ảnh đầu vào**. Gửi body hiện tại sẽ là request sai
định dạng → HTTP 400. Một request 400 không bị tính tiền, nhưng **nó vẫn là một
lần create**, và dự án này đã chốt là không chấp nhận điều đó.

Vậy thứ tự đúng là: **(1)** sửa adapter để tạo body theo từng model → **(2)** bạn
duyệt → **(3)** chạy 1 clip. Không đảo thứ tự.

`wan3` còn một bẫy riêng: mặc định của vendor là `auto_1080p` = **20 credit/s**,
tức một clip 5 giây thành **$1,00 thay vì $0,25** nếu adapter quên gửi
`resolution` tường minh.

---

## ⛔ ĐANG CHỜ: quyết định cho cảnh LOW sau khi gen4_turbo bị hạ cấp

Lô thật đầu tiên đã chạy. Clip hỏng, **không mất tiền** (Runway xác nhận
`credits: 0`), và sổ đã được sửa về $0,041160. Kế toán thất bại đã vá triệt để —
xem QĐ-032…QĐ-035.

`runway/gen4_turbo:720x1280` hiện là **DEGRADED**: `INTERNAL.BAD_OUTPUT.CODE01`
trên **2 cảnh khác nhau**, 1 lần thành công. Router sẽ không tự chọn nó nữa.

**Chưa chọn hướng thay thế — chờ người dùng.** Ba lựa chọn, không cái nào miễn
phí hoàn toàn:

1. **Đổi mô tả/keyframe rồi thử lại gen4_turbo.** Fingerprint đổi → không bị
   chặn. Rẻ nhất ($0,25/clip) nhưng chưa biết có qua không.
2. **Ghim tay `runway/gen4.5`** — 2/2 thành công, nhưng $0,12/giây, tức **2,4
   lần** đắt hơn, và đang là `PIN_ONLY`.
3. **Đẩy cảnh đó về LOCAL_MOTION** — $0, nhưng là ảnh tĩnh có chuyển động giả.

Không có ứng viên nào vừa ACTIVE, vừa đáng tin, vừa rẻ. `sora-2` đã DEPRECATED
(nhà cung cấp tắt 2026-09-24) nên không phải đường thoát.

**Việc nhỏ chưa làm:** trang `/models` không hiển thị `lifecycle` lẫn
`reliability`. Một model bị hạ cấp hiện chỉ thấy được qua log và
`scripts/audit-ledger.ts`.

---

## Đã xong: chạy lô thật đầu tiên

**Batch Video Factory V1 đã xây xong và đã NGHIỆM THU ở chế độ mock (26/26).**
Chưa từng chạy với API trả phí.

Đã chạy thật một lô 3 video trên giao diện với DB riêng (`data/.uidemo`), mock
toàn bộ: dự toán → duyệt $1,09 → chạy → xuất MP4. Xem bảng nghiệm thu trong
[STATE.md](STATE.md).

`CREATE_ATTEMPT_TOKEN = 0`. Chưa lô nào được duyệt chi. `.env` vẫn
`AI_MOCK_MODE=true`.

Việc kế tiếp là **chạy một lô thật nhỏ**, và đó là quyết định của người dùng,
không phải mặc định. Ngân sách còn **$4,287240**.

## ✅ ĐÃ CHUẨN BỊ XONG 1 VIDEO TEST — chờ bạn duyệt hạn mức

**Idiom: "Cold feet"** · project `f2b68443` · lô `11af6ba6` · quyền chi **DRAFT**
(chưa được phép chi gì).

Kịch bản **soạn tay** (không gọi Text AI), rồi để `withDerivedRouting` tự chấm:

| Cảnh | Giây | Độ khó | Ưu tiên | Điểm | Nguồn |
|---|---|---|---|---|---|
| 1 | 5 | LOW | HIGH | 1,0 | **Runway gen4_turbo** — $0,25 |
| 2 | 4 | LOW | LOW | 0,0 | LOCAL_MOTION |
| 3 | 4 | LOW | LOW | 0,0 | LOCAL_MOTION |
| 4 | 5 | LOW | HIGH | 1,5 | **Runway gen4_turbo** — $0,25 |
| 5 | 4 | LOW | LOW | 0,0 | LOCAL_MOTION |
| 6 | 4 | LOW | LOW | 0,0 | LOCAL_MOTION |

**HIGH = 0, MEDIUM = 0, LOW = 6.** Không cảnh nào cần Sora hay gen4.5.

```
TEXT     $0,001000
IMAGE    $0,288000   (6 ảnh × $0,048)
VIDEO    $0,500000   (2 cảnh × $0,25)
VOICE    $0,000100
RENDER   $0,000000
─────────────────────
TOTAL    $0,812800
Đề xuất trần duyệt: $0,90  (+10%)
```

Mở `/batches/11af6ba6-08dc-4368-812e-f3ba0828e117` để duyệt trên UI.

Lô đã được gắn sẵn project, nên `handleBatchExpand` sẽ **nhận kịch bản này**
thay vì sinh lại bằng Text AI.

Chạy lại bất cứ lúc nào, miễn phí:
```
npx tsx scripts/prepare-first-real-video.ts            # dry run
npx tsx scripts/production-estimate.ts --idiom "Cold feet" --mode BALANCED
npx tsx scripts/preflight-runway.ts --idiom "Cold feet" --scene 1 --limit 0.30
```

Nhắc lại ràng buộc đã chốt: **không benchmark thêm model hay provider nào nữa.**

---

## Cách chạy một lô (giao diện)

```
/batches
  → điền tên, số video, chế độ, hạn mức/video
  → PHÂN TÍCH & DỰ TOÁN        ← miễn phí, không gọi API nào
  → đọc bảng: từng video, số cảnh local vs cảnh Video AI, nhà cung cấp, dự toán
  → nhập MAXIMUM AUTHORIZED SPEND
  → DUYỆT & CHẠY BATCH         ← đây là bước tiêu tiền
/batches/<id>
  → tiến trình, đã chi / đang giữ chỗ / đã duyệt
  → DỪNG BATCH, CHẠY TIẾP, DỰ TOÁN LẠI
```

Bước A ghi ra bảng `Batch.planJson` và một `BatchAuthorization` ở trạng thái
`DRAFT`. **DRAFT không cho phép chi gì cả** — cổng trong
`services/batch-authorization.ts` từ chối mọi thứ không phải `APPROVED`.

---

## Việc đã xong, không cần làm lại

- Benchmark Runway gen4_turbo và gen4.5 — xong, lưu trong `VideoBenchmark`.
- Benchmark Sora-2 cảnh 3 — đã thử, hỏng 400, **không chạy lại** (người dùng đã
  dừng mọi benchmark).
- Preflight Sora (`scripts/preflight-sora.ts`) — chỉ GET, chạy lại miễn phí.
- Pipeline âm thanh, loudness, ducking, subtitle timing — production ready.
- **Batch Video Factory V1** — kế hoạch, duyệt chi, giữ chỗ tiền, hàng đợi,
  retry/resume, cancel, LOCAL_MOTION, giao diện. Xem [STATE.md](STATE.md).

---

## Việc nhỏ còn lại của Batch V1

- [ ] Nút thử lại **từng cảnh** trên giao diện. Service `retryScene()` đã có và
      đã kiểm thử, chỉ thiếu nút.
- [x] ~~Trang `/batches/[id]` không tự làm mới.~~ **Đã sửa:** trang tự poll
      `/api/batches/<id>/progress` mỗi 2,5 giây, cập nhật tại chỗ không tải lại
      trang, và **tự dừng poll** khi lô vào trạng thái kết thúc. Mất kết nối rồi
      quay lại thì đọc lại từ DB, không cần biết đã bỏ lỡ gì.
- [ ] Bảng dự toán mới hiện chi tiết cảnh cho **3 video đầu**. Nhiều hơn thì chỉ
      đếm, không liệt kê.
- [ ] Mỗi lần tải lại trang rồi bấm dự toán tạo thêm một dòng lô PLANNED. Vô hại
      (DRAFT không chi được gì) nhưng làm rối danh sách.
- [ ] **Nối `evaluateScene` vào cổng lô** trước khi thêm bất kỳ quality model
      thật nào. Hiện chỉ có mock nên chưa rò tiền.

---

## Nếu sau này quay lại chuyện Sora 6 giây

Đừng POST để thử. Trước hết đọc lại `src/providers/openai/openai-video-client.ts`
quanh chỗ `input_reference`, và so với hai job 4 giây đã đạt (`GET /videos` liệt
kê miễn phí). Chỉ POST khi người dùng cấp token mới.

---

## Lệnh cần nhớ

```
npm run video:benchmark                       # bảng giá mọi provider, miễn phí
npm run project:status -- --idiom "Spill the beans"
npm run video:test -- --scene 4 --dry-run     # kiểm tra, không gọi API
npx tsx scripts/preflight-sora.ts --scene 3   # chỉ GET, miễn phí
npx tsx scripts/routing-preview.ts            # định tuyến + chi phí, miễn phí
npx tsx scripts/production-estimate.ts --idiom "X" --mode ECONOMY
                                              # dự toán GIÁ THẬT 1 video, miễn phí
npx tsx scripts/find-cheapest-candidates.ts --mode ECONOMY --top 3
                                              # xếp hạng ứng viên chạy thật, miễn phí
npm run crop:check                            # đo vùng cắt 9:16
npm run verify                                # lint + typecheck + test + build
```

### Ngân sách

Đã chi **$3,712760** / **$8,00** — còn **$4,287240**. Ví từng nhà cung cấp tách
riêng, xem [STATE.md](STATE.md). Con số này sẽ cũ đi; kiểm tra lại bằng
`spendStatus()` và `providerSpendBreakdown()`.

---

## Việc nhỏ, không phụ thuộc nhà cung cấp

- [ ] Nút sinh metadata YouTube (provider đã có hàm, chỉ thiếu nút và chỗ lưu)
- [ ] Trang sửa mẫu prompt (`src/lib/prompts.ts` đã hỗ trợ ghi đè từ DB)
- [ ] Tải ảnh tham chiếu nhân vật (cột `referenceImages` đã có)
- [ ] Chọn nhạc nền cho dự án (hàm render đã hỗ trợ trộn nhạc)
- [ ] Trang cài đặt dọn dẹp (hiện chỉ chạy bằng dòng lệnh)

---

## Việc kỹ thuật

- [ ] Ghi nhận `historicalSuccessRate` thật từ kết quả chạy (router đã dùng
      trường này, chỉ chưa có ai cập nhật nó)
- [ ] Chuyển từ `prisma db push` sang `prisma migrate` trước khi phát hành.
      Batch V1 vừa thêm hai bảng (`BatchAuthorization`, `CostReservation`) và
      ba cột, tất cả bằng `db push` — nợ này đang lớn dần.
- [ ] Cân nhắc nút "kiểm tra kết nối" gọi endpoint liệt kê model của nhà cung cấp

---

## Không làm bây giờ

Redis, Docker bắt buộc, microservice, tải lên YouTube tự động, phân tích hiệu
quả video.
