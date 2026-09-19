# Việc tiếp theo

**Cập nhật:** 2026-09-19

---

## ⏸ CHỜ BẠN QUYẾT — không làm gì cho tới khi có trả lời

### 1. Sàn chuyển động: h3_max có đáng $0,40 cho một cái chớp mắt không?

Clip `h3_max` của lần nhập storyboard đo được `scdet` trung bình **0,00047**,
lớn nhất **0,0020** — chỉ ~40% cảnh 1 và ~20% cảnh 4 của lô trước. Nội dung thật
sự chuyển động trong 5,18 giây là: ba cái chớp mắt và một cái nghiêng đầu vài
pixel. Camera 10/10, nhận dạng 10/10, và gần như không có gì nhúc nhích.

Đề xuất: thêm một **sàn chuyển động** vào cổng LOW_AUTO — nếu thứ cảnh yêu cầu
chỉ là chớp mắt / nghiêng đầu / đứng yên thì câu trả lời đúng là LOCAL_MOTION và
$0,40 không nên rời đi. Đây là một **luật định tuyến mới**, không phải sửa lỗi,
nên chưa làm.

Cần bạn chốt: ngưỡng lấy từ đâu (từ chữ trong `characterAction`, hay đo clip sau
khi mua rồi ghi lại để lần sau biết), và nó **chặn** hay chỉ **cảnh báo**.

### 2. Vòng đời `h3_max` — đề xuất GIỮ NGUYÊN `LOW_AUTO`

7 mẫu đã chấm, 3 trong đó là sản xuất thật (9,09 · 8,91 · 8,69). Mẫu hỏng duy
nhất (4,33) là **prompt cũ chưa có guardrail**, và A/B trên đúng cảnh đó với
guardrail cho 9,20 — lỗi thuộc về prompt, và bộ guardrail đó nay nằm trong code.

Nhưng **cả 7 mẫu đều LOW, ≤2 nhân vật, camera khoá, có keyframe**. Đó đúng bằng
hình dạng cổng đang cho qua. Kết luận: **B — PASS_WITH_GUARDRAIL**, tức là đúng
cấu hình hiện tại. Không nới, không rút. Chưa đụng gì tới registry.

### 3. Ba nhân vật hiện có thiếu `approximateAge` và `skinTone`

Max/Leo/Mia đều `NEEDS_IDENTITY_FIELDS`. Chúng vẫn ra ảnh đúng vì `visualPrompt`
viết tay đã có "young adult male/female" — nhưng mệnh đề khoá đang khoá một giá
trị chưa ai phát biểu. **Không tự điền**: một giá trị bịa ra sẽ nằm trong mọi
prompt của nhân vật đó mãi mãi. Vào trang Nhân vật điền hai ô, hoặc bảo tôi điền
theo đúng chữ bạn đọc được trong ảnh master.

### 4. Ảnh cảnh 1, 4, 5 của `f2b68443` đã lệch khoá vì QĐ-065 đổi prompt

Ảnh cũ vẫn trên đĩa và vẫn đang nằm trong MP4. Chỉ khi tạo lại media cho ba cảnh
đó thì mới là ảnh mua mới (~$0,0412/ảnh). Muốn thấy bản vá ra ảnh thế nào thì
phải tạo lại cảnh 4 — **một lần chi tiền**.

---

## Blocker còn lại của IMPORT STORYBOARD / BATCH FROM SCENES

### Đã đóng 2026-09-19

- [x] **Character consistency** (QĐ-070). Bible 11 trường, readiness ba mức,
      `NEEDS_CHARACTER_REFERENCE`, storyboard khai báo được hồ sơ, nhân vật cũ
      không bị ghi đè, tên lạ **ném lỗi** thay vì bị bỏ qua im lặng.
- [x] **Ghim tay tách khỏi bản ghi router** (QĐ-069) — ảnh hưởng cả hai luồng.
- [x] **Dự toán nói được "dùng lại"** (QĐ-071), kèm dòng render, safety margin
      tách riêng, và ví từng nhà cung cấp.

### Còn lại

- [ ] **Chưa có UI cho 5 trường Bible mới.** Cột đã có, importer đã ghi, prompt
      đã đọc — trang Nhân vật chưa có ô để gõ. Việc này miễn phí.
- [ ] **Bản xem trước chưa hiển thị `counts` / `providerWallets` / `safetyMargin`
      trên trang `/import`.** Dữ liệu đã có trong `preflightImportedBatch`, chỗ
      còn thiếu là phần render. Cũng miễn phí.
- [ ] **Guard mâu thuẫn prompt ảnh (QĐ-065) vẫn chưa ai đọc kết quả trên văn
      phong storyboard nhập tay.** Nó có chạy; chưa có người nhìn.
- [ ] **Nhiều video một lượt vẫn chưa chạy thật.** Lần chạy thật vừa rồi là
      **một** video. ZIP, thư mục nhiều video, hỏng một video không đổ cả lô —
      tất cả đã có test mock, chưa có lần chạy trả tiền nào.

---

## Kiến trúc Batch From Storyboards — soát 2026-09-19

| Yêu cầu | Trạng thái |
|---|---|
| một thư mục nhiều video | CÓ — `groupByStoryboard`, thư mục sâu nhất chứa tệp là chủ của ảnh |
| storyboard JSON hoặc CSV | CÓ, cùng bộ mã lỗi + số dòng |
| mỗi video một thư mục asset riêng | CÓ |
| import ZIP | CÓ, entry không an toàn bị từ chối khi vẫn còn là một cái tên |
| mỗi cảnh chọn LOCAL_MOTION / VIDEO_AI | CÓ — `motion_mode`, và VIDEO_AI là **chỉ thị** |
| cảnh có media sẵn thì dùng lại | CÓ — ảnh từ QĐ-067; clip/giọng từ QĐ-071 |
| cảnh thiếu media mới tạo | CÓ |
| resume idempotent | CÓ — khoá tính từ hàng Scene, retry có chủ đích sinh khoá khác |
| không mua lại image/video/voice đã có | CÓ, và **nay bản dự toán cũng nói đúng như vậy** |
| một video lỗi không hỏng cả lô | CÓ — `OVER_VIDEO_BUDGET` / `NEEDS_PROVIDER` chặn riêng từng video |

Đường ống mong muốn, đối chiếu:

```
IMPORT -> VALIDATE -> CHARACTER RESOLVE -> SCENE ROUTING -> COST PREVIEW
       -> USER APPROVAL -> IMAGE/KEYFRAME -> VIDEO/LOCAL_MOTION -> VOICE
       -> SUBTITLE -> FFMPEG RENDER -> FINAL MP4
```

Tất cả các bước đều có và đã chạy end-to-end (mock 2026-09-18, thật 1 video
2026-09-18). **CHARACTER RESOLVE** trước đây là bước yếu nhất — chỉ có cái tên —
và đó là cái QĐ-070 vừa đóng.

---

## 🆕 MODULE MỚI: Import Storyboard / Batch From Scenes V1 (2026-09-18)

Luồng sản xuất **thứ hai**, không thay luồng V1. Xem QĐ-066.

```
V1:      Ý TƯỞNG → SCRIPT(AI) → CẢNH → ẢNH(AI) → MOTION → VOICE → RENDER
V2/nhập: STORYBOARD + ẢNH CÓ SẴN → VALIDATE → DỰ TOÁN → DUYỆT
         → CHỈ TẠO PHẦN CÒN THIẾU → MOTION → VOICE → RENDER
```

**Đã có:** đọc JSON/CSV/thư mục/ZIP · 7 nhóm validate có mã lỗi + số dòng ·
chép ảnh có sẵn thành keyframe (`imageSource=IMPORTED`, **không gọi Image AI**) ·
`motion_mode` AUTO/LOCAL_MOTION/VIDEO_AI · ghim provider/model ·
preflight dự toán từng video + cả lô · trang `/import` · `batch-report.json` ·
39 test.

**Đã chạy thật 2026-09-18**: 1 video, $0,400122, MP4 25,000s. Xem QĐ-068 và
mục "Blocker còn lại" ở đầu tài liệu.

### Cách dùng (miễn phí, chưa chi gì)

```
npx tsx scripts/import-storyboard.ts --source examples/storyboard-import
npx tsx scripts/import-storyboard.ts --source batch.zip --apply   --name "Lô nhập 1" --max-per-video 1.50 --max-batch 4.00
```

Lô sinh ra ở `PLANNED` + quyền chi `DRAFT`. Duyệt tiền vẫn ở `/batches/<id>`.

### Đã chạy END-TO-END BẰNG MOCK 2026-09-18 — xem QĐ-067

```
npx tsx scripts/import-e2e-mock.ts      # DB + data rieng, $0, 40/40 dieu kien DAT
```

Chuỗi đầy đủ: migrate deploy → seed → import → validate → project + scenes →
dự toán → duyệt (giá mock) → media → LOCAL_MOTION → VIDEO_AI mock → voice →
subtitle → FFmpeg → **MP4 thật** → batch report.

MP4: **26,000s · 1080x1920 · 30fps · h264 + aac 48kHz mono**, 2 clip Video AI,
4 cảnh LOCAL_MOTION, 6 keyframe nhập sẵn, **0 ProviderJob ảnh**.

- [x] **videoPrompt** dựng sẵn tất định lúc nhập; VIDEO_AI không có gì chuyển
      động thì **chặn ngay khi nhập**.
- [x] **Nhân vật**: `character_id` / `character_name` /
      `character_reference_image` ở cấp video, cảnh tham chiếu lại. Tạo
      `Character` + `CharacterReference` (primary+approved khi chưa có). Nhân
      vật đã tồn tại thì **dùng lại, không ghi đè**.
- [x] **Sửa cảnh trên UI**: đủ 11 trường, tự dẫn xuất lại videoPrompt + người
      nói, **huỷ bản dự toán cũ**, khoá cảnh đã có ProviderJob.
- [x] **Migration** `20260918000000_init` — dựng schema từ DB rỗng, đã chạy thật.
- [x] **Dự toán ảnh có sẵn = $0** (trước đó vẫn tính tiền — QĐ-067 mục 1).
- [x] **Lời dẫn không còn bị nuốt** (QĐ-067 mục 3).
- [x] **Retry cảnh hỏng làm sống lại bước render** (QĐ-067 mục 4).

### Blocker của bản mock này — đã đóng

- [x] **Chạy với provider thật** — 2026-09-18, 1 video, $0,400122. QĐ-068.
- [x] **Bảng nhân vật nhập là tối thiểu** — đóng bằng Character Bible, QĐ-070.
      `visualPrompt` mặc định vẫn là `"<tên>, consistent character design..."`,
      nhưng nay có 11 trường riêng để khoá diện mạo, storyboard khai báo được
      chúng, và cái còn trống được **báo ra** (`character_identity_thin`) thay vì
      im lặng.

Danh sách blocker **hiện hành** nằm ở đầu tài liệu.

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

### Đã vá 2026-09-18 (đợt 3, $0) — QĐ-065

- [x] **Prompt ảnh đã có bộ dò mâu thuẫn** (`src/domain/image-prompt.ts`), 7 luật,
      24 test. Cảnh 4 dùng làm fixture hồi quy. Bỏ "nothing else in frame" (giữ
      cầu nhảy) và bỏ "wide eager smile" khỏi bảng nhân vật (giữ "eyes stay
      wide"), thêm một câu cố định nói biểu cảm lấy từ cảnh chứ không từ ảnh
      tham chiếu. Thuộc tính khoá không bị đụng tới.
- [ ] **Khoá ảnh cảnh 1, 4, 5 đã đổi** vì prompt đổi. Ảnh cũ vẫn trên đĩa và vẫn
      đang dùng trong MP4; chỉ khi nào tạo lại media cho ba cảnh đó thì mới là
      ảnh mua mới (~$0,0412/ảnh). Cảnh 2, 3, 6 khoá trùng nguyên.
- [ ] Muốn thấy bản vá ra ảnh thế nào thì phải tạo lại ảnh cảnh 4 — **một lần
      chi tiền**, chờ bạn quyết.

<details>
<summary>Lỗi gốc đã vá (giữ lại để tra cứu)</summary>

- **Prompt ảnh không có bộ dò mâu thuẫn như prompt video.** Cảnh 4 minh hoạ
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

</details>

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
