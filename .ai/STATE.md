# Trạng thái dự án

**Cập nhật:** 2026-09-14
**Cột mốc hiện tại:** Milestone 2 xong (Text + Image + Video + Voice đã chạy
thật). **Kế tiếp: Batch Video Factory V1 — đang chờ người dùng chốt phạm vi.**

Tài liệu này ghi tình trạng **thực tế**. Tính năng chỉ được đánh dấu hoạt động
khi đã chạy thật và được kiểm chứng, không phải khi đã viết xong mã.

---

## Tiền và quyền chi tiêu

```
Hạn mức tổng : $8,00   đã chi $3,712760   còn $4,287240
CREATE_ATTEMPT_TOKEN : 0
```

Ví **tách riêng từng nhà cung cấp, không bao giờ cộng chung**:

| Ví | Đã chi | Số gọi | Số dư |
|---|---|---|---|
| openai | $1,993906 | 42 | $6,00 — **khai báo**, không phải live |
| runway | $1,690000 | 3 | 831 credit — live, đọc từ `GET /organization` |
| groq | $0,028854 | 24 | external, nhà cung cấp tự quản |

Một lần người dùng xác nhận = **đúng một** lần POST create. Token bị tiêu ngay
khi POST rời máy, bất kể thành công, 400, timeout hay lỗi provider.

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

Hai lần gen4.5 là A/B có kiểm soát, **chỉ đổi prompt**: cho phép push-in →
composition 3; khoá camera → composition 9. Bài học: phần lớn hiện tượng trôi
camera là do prompt, phần còn lại là bản tính của model.

Lần Sora hỏng là **lỗi của ta, không phải Sora từ chối cảnh**. Cùng đoạn code đã
chạy đạt 2 lần ngày 13/09 với **4 giây** + keyframe, không có commit nào sửa nó
từ đó. Khác biệt duy nhất: `seconds` 4 → 6. Giả thuyết là 6 không nằm trong tập
độ dài hợp lệ — **chưa chứng minh được nếu không POST thêm lần nữa**.

---

## Định tuyến video — CHƯA CHỐT PRODUCTION

| Độ khó | Hiện tại |
|---|---|
| LOW | `runway/gen4_turbo` — có bằng chứng tốt |
| MEDIUM | **chưa chốt** |
| HIGH | **chưa chốt** |

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

**Đã chi: $2,022494** / hạn mức **$3,00** — còn **$0,977506**.

| Loại | Số lần | Chi phí thật |
|---|---|---|
| Image AI (OpenAI `gpt-image-2:medium`) | 29 ảnh | $1,193640 |
| **Video AI (OpenAI `sora-2:720x1280`)** | **2 clip × 4s** | **$0,800000** |
| Text AI (Groq `openai/gpt-oss-120b`) | 24 lần | $0,028854 |

Đây là **tiền thật**. Voice AI vẫn hoàn toàn mock, $0,00.

`.env` đang ở `AI_MOCK_MODE=true` — chế độ an toàn.

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

### Milestone 2 bước 2-4
- [ ] Image AI thật
- [ ] Video AI thật (Runway)
- [ ] Voice AI thật (ElevenLabs / OpenAI)

**Image, Video, Voice, Upscale vẫn hoàn toàn là mock.**

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
