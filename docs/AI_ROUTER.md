# AI Router

`src/services/ai-router.ts`

Router quyết định mô hình nào tạo ra **từng cảnh**. Đây là thành phần biến
nguyên tắc "chất lượng trên mỗi đô la" thành hành vi cụ thể.

---

## Vì sao định tuyến theo từng cảnh

Một video 25 giây gồm khoảng 6 cảnh, và chúng không hề giống nhau về độ khó:

| Cảnh | Nội dung | Độ phức tạp | Người xem có nhận ra khác biệt? |
|---|---|---|---|
| 1 | Mặt sốc, cận cảnh | MEDIUM | **Có** — 3 giây đầu quyết định giữ chân |
| 2 | Một nhân vật, bong bóng suy nghĩ | MEDIUM | Ít |
| 3 | Hai nhân vật, đạo cụ, slapstick | HIGH | Có |
| 4 | Punchline, hai nhân vật phản ứng | HIGH | **Có** — đây là cảnh được chia sẻ |
| 5 | Thẻ chữ giải thích nghĩa | LOW | Không |
| 6 | Câu ví dụ, hai nhân vật cười | LOW | Không |

Trả cùng một giá cho cảnh 5 và cảnh 4 là lãng phí. Trả giá rẻ cho cảnh 1 là mất
người xem. Router xử lý đúng chỗ đó.

---

## Đầu vào

```ts
{
  type,                  // image | video | voice | quality
  qualityMode,           // ECONOMY | BALANCED | QUALITY | CUSTOM
  strategy,              // AUTO | CHEAPEST | BEST_VALUE | BEST_QUALITY | MANUAL
  complexity,            // LOW | MEDIUM | HIGH
  spendPriority,         // LOW | NORMAL | HIGH
  durationSeconds,
  characterCount,
  consistencyRequired,
  needs1080p,
  needsReferenceImage,
  budgetRemaining,       // ngân sách còn lại của dự án
  usage,                 // giây / ảnh / ký tự / job
  availableProviders,    // đã lọc theo key + trạng thái
  manualProvider, manualModel
}
```

---

## Cách chọn

### 1. Lọc theo năng lực

Loại bỏ mô hình không làm được việc: tắt, sai loại, nhà cung cấp không khả dụng,
thời lượng vượt `maxDuration`, thiếu image-to-video khi cần keyframe, thiếu
`supports1080p`, hoặc thiếu hỗ trợ tham chiếu nhân vật khi cảnh có từ 2 nhân vật
phải giữ đúng ngoại hình.

Nếu không còn mô hình nào → ném `RoutingError`, kèm lý do bằng tiếng Việt.

### 2. Ngưỡng chất lượng (chỉ khi strategy = AUTO)

```
ngưỡng = mức nền của chế độ
       + (HIGH: +1.5 | MEDIUM: +0.75 | LOW: 0)      ← độ phức tạp
       + (HIGH: +1.5 | LOW: -0.75)                   ← ưu tiên chi tiêu

Mức nền:  ECONOMY 3 · BALANCED 5 · QUALITY 7 · CUSTOM 5
Trần:     ECONOMY bị chặn ở 5.5 — không bao giờ bị cảnh phức tạp kéo lên tầng cao
```

Đây là chỗ "dùng AI rẻ khi khác biệt không đáng kể" được viết thành công thức.

Khi người dùng **chọn rõ** một chiến lược (không phải AUTO), ngưỡng này không áp
dụng: chọn CHEAPEST mà vẫn nhận mô hình đắt nhất là lỗi, không phải tính năng.

### 3. Xếp hạng

```
chỉ số chất lượng = (chất lượng×0.5 + nhất quán×0.35 + tốc độ×0.15)
                    × tỉ lệ thành công thực tế

chỉ số giá trị    = chỉ số chất lượng / chi phí
```

Tính nhất quán được đánh trọng số cao vì với thể loại này, nhân vật đổi mặt giữa
các cảnh làm hỏng video bất kể từng khung hình đẹp đến đâu.

Tỉ lệ thành công là số liệu ứng dụng tự đo: mô hình hay hỏng thì thực tế tệ hơn
điểm số của nó, vì mỗi lần hỏng là một lần trả tiền lại.

| Chiến lược | Sắp xếp theo |
|---|---|
| `CHEAPEST` | giá thấp nhất |
| `BEST_QUALITY` | chỉ số chất lượng cao nhất |
| `BEST_VALUE` | chỉ số giá trị cao nhất |
| `AUTO` | theo chế độ: ECONOMY→CHEAPEST, BALANCED→BEST_VALUE, QUALITY→BEST_QUALITY |
| `MANUAL` | dùng mô hình được ghim (vẫn phải hợp lệ và vừa ngân sách) |

### 4. Trần ngân sách

Nếu lựa chọn tốt nhất vượt ngân sách còn lại, router **hạ cấp** xuống mô hình
đắt nhất còn vừa túi và đánh dấu `downgraded: true`. Nếu ngay cả mô hình rẻ nhất
cũng không vừa, nó ném lỗi thay vì âm thầm tiêu quá.

Ngân sách giảm dần khi duyệt qua các cảnh, nên cảnh cuối thực sự thấy ít tiền
hơn — đúng như khi chạy thật.

### 5. Dự phòng

Các mô hình còn lại, đã lọc theo ngân sách, được trả về trong `fallbacks` theo
đúng thứ tự để thử khi mô hình chính hỏng.

---

## Ưu tiên chi tiêu

Tách riêng khỏi độ phức tạp, và có chủ đích.

Một cảnh có thể rất đơn giản về mặt hình ảnh nhưng vẫn đáng dùng mô hình tốt vì
nó là 3 giây đầu (quyết định đường cong giữ chân) hoặc là punchline (quyết định
lượt chia sẻ). Ngược lại, một cảnh thiết lập bối cảnh rườm rà mà không ai xem
lại lần hai là chỗ để tiết kiệm.

```
HIGH   → 3 giây đầu · punchline · cảnh chốt đáng nhớ
NORMAL → các nhịp nội dung thông thường
LOW    → thẻ giải thích tĩnh · câu ví dụ · chuyển cảnh đơn giản
```

---

## Ví dụ (chế độ Cân bằng, giá mock)

```
Cảnh 1  MEDIUM  ưu tiên CAO    → mock-video-pro   $0.16   3 giây đầu
Cảnh 2  MEDIUM  bình thường    → mock-video-std   $0.27
Cảnh 3  HIGH    bình thường    → mock-video-std   $0.27
Cảnh 4  HIGH    ưu tiên CAO    → mock-video-pro   $0.67   punchline
Cảnh 5  LOW     ưu tiên thấp   → mock-video-lite  $0.05
Cảnh 6  LOW     ưu tiên thấp   → mock-video-lite  $0.04
```

Ba tầng mô hình khác nhau trong cùng một video. Đó chính là tính năng.

---

## Giải thích cho người dùng

Mỗi quyết định kèm một câu tiếng Việt hiển thị trong trình chỉnh sửa storyboard:

> *cảnh quan trọng (hook/punchline) nên ưu tiên chất lượng; chọn giá trị tốt
> nhất với ngưỡng chất lượng 8.0/10 (mô hình đạt 9.1)*

Người vận hành luôn thấy được **vì sao** một cảnh tốn nhiều hơn cảnh khác, và có
thể ghim mô hình khác nếu không đồng ý.

---

## Tối ưu ngân sách theo lô

`src/services/budget.ts`

Câu trả lời ngây thơ cho "50 video, $40" là chạy tất cả ở chế độ Tiết kiệm rồi
trả lại tiền thừa. Như thế là lãng phí ngân sách.

Thay vào đó:

1. Đặt mọi video ở chế độ Cân bằng.
2. Nếu không đủ tiền, hạ dần xuống Tiết kiệm.
3. Nếu còn dư, nâng từng video lên Chất lượng cao cho tới khi hết tiền.

Kết quả luôn nằm trong ngân sách, và nếu ngân sách không đủ cho số lượng yêu cầu
thì nó nói thẳng ra bao nhiêu video là khả thi.
