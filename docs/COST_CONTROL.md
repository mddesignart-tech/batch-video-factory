# Kiểm soát chi phí

Bốn cơ chế độc lập, xếp chồng lên nhau.

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

## 4. Chống tính phí hai lần

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
