# Hướng dẫn Audio Mixer (QĐ-150)

Audio Mixer chỉnh **âm thanh** của video: nhạc nền, giọng đọc, tự giảm nhạc khi có lời, fade.
Mọi thao tác ở đây chạy **tại máy, $0 API**. Không thao tác nào tạo lại giọng, ảnh hay video.

> **Ba điều cần nhớ**
>
> 1. **Nhạc nền chạy liền từ đầu đến cuối video.** Ở chỗ chuyển cảnh, nhạc không bị khởi động lại và không bật lên.
> 2. **Chỉnh âm thanh sau khi xuất video không cần render lại hình.** Bấm **REMIX AUDIO**, app tạo một file video mới, file cũ vẫn giữ nguyên.
> 3. **Chỉ GIỌNG MỚI mới có thể tốn tiền.** Đổi giọng hoặc tốc độ thì app luôn báo giá và hỏi trước. Âm lượng, nghe thử, Remix đều $0.

Mở: **Dự án video → (chọn video) → Video output → mục NHẠC NỀN**.

---

## 1. Chọn Audio Preset

Ô **Audio preset** có 5 preset hệ thống:

| Preset | Dùng cho | Nhạc | Tự giảm nhạc khi có lời |
|---|---|---|---|
| **Review AI** | Thuyết minh, review công cụ AI (đã nghe duyệt) | 100% | −6 dB |
| **Video hài hước** | Nhịp nhanh, hiệu ứng rõ | 115% | −5 dB, giảm/hồi nhanh |
| **Kể chuyện** | Giọng ấm, nhạc cảm xúc, chuyển rất mềm | 90% | −8 dB, giảm/hồi chậm |
| **Review sản phẩm** | Giới thiệu sản phẩm, nhạc không lấn lời | 85% | −8 dB |
| **Video không lời** | Video chỉ có nhạc và hiệu ứng | 140% | tắt |

- Chọn preset là **chép các giá trị vào video này**. Sửa hay xoá preset sau đó không làm đổi video đã dùng nó.
- Video tạo **mới** tự nhận preset mặc định (**Review AI**). Đổi preset mặc định ở **Cài đặt → Âm thanh → Audio Mixer**. Chọn "Không" thì video mới dùng bộ trộn cũ.
- Video **cũ** không tự đổi. Video cũ hiện dòng "đang dùng bộ trộn cũ"; chọn preset rồi bấm **Bật Audio Mixer** để chuyển sang Mixer.

## 2. Điều chỉnh âm lượng nhạc và giọng

- **Âm lượng nhạc nền (0–200%)**: kéo thanh trượt hoặc gõ số vào ô %. Bấm **Về 100%** để trả về mức chuẩn.
  - 100% là mức nhạc đã được nghe duyệt. Bài nhạc nào cũng được đo và đưa về cùng độ to này trước khi nhân %.
  - 110% ≈ +0,8 dB, 150% ≈ +3,5 dB, 200% = +6 dB.
- **Âm lượng giọng đọc (0–200%)**: chỉ đổi độ to của file giọng đã có. Không tạo giọng mới, không đổi tốc độ, cao độ hay thời điểm.
- **Tự động giảm nhạc khi có lời thoại (Auto Ducking)**: bật/tắt, mức giảm 0–24 dB.
  - **Attack**: nhạc bắt đầu giảm trước câu nói bao lâu.
  - **Release**: nhạc hồi lại sau câu nói bao lâu.
  - Khoảng nghỉ ngắn hơn Attack + Release thì nhạc giữ ở mức đã giảm, nên không bị nhấp nhô ở chỗ chuyển cảnh.
- **Fade in nhạc / Fade out nhạc** (giây): chỉ ở đầu và cuối video, chỉ áp cho nhạc. Giọng không bao giờ bị fade.
- Muốn dùng lại bộ thông số: bấm **Lưu preset**, đặt tên, rồi bấm **Lưu thành preset mới**. Preset của bạn xoá được ngay trong Mixer hoặc ở Cài đặt; preset hệ thống không xoá được.
- **Khôi phục mặc định** đưa các thông số về đúng preset đang chọn.

## 3. Nghe thử

Các nút **Đoạn có lời · Đoạn không lời · Đoạn chuyển cảnh** phát một đoạn khoảng 8 giây, trộn theo đúng thông số đang thấy trên màn hình (kể cả khi chưa lưu).

- Nghe thử chỉ trộn âm thanh, không render hình.
- Cần có ít nhất một lần xuất video sau khi cập nhật QĐ-150. Nếu chưa có, bấm **RENDER LẠI** một lần.

## 4. Render video

Bấm **RENDER LẠI · $0 API** (cuối thẻ Video output). App render tại máy, dùng lại ảnh, giọng và clip đã có.
Mỗi lần render, app tự lưu các track âm thanh nguồn kèm theo video, để sau này Remix được.

## 5. Remix Audio (chỉnh sau khi đã xuất)

1. Chỉnh nhạc, giọng, ducking hoặc fade như mục 2, có thể nghe thử trước.
2. Bấm **REMIX AUDIO · $0 API**.
3. App trộn lại âm thanh từ các track nguồn, **giữ nguyên hình** (không encode lại), rồi xuất một file video **mới**. File cũ vẫn còn trong thư mục `final`.

Không bấm được REMIX? App sẽ ghi lý do:
- **"không còn track nguồn riêng"**: video được xuất trước khi có Audio Mixer. MP4 đã trộn sẵn thì không tách lại chính xác được. Bấm **RENDER LẠI** một lần ($0); từ bản đó trở đi Remix được.
- **"Chưa có video đã xuất"**: render video trước.

## 6. Áp dụng cho nhiều video (Batch)

Mở trang lô: **Tạo hàng loạt → (chọn lô) → thẻ Âm thanh lô**.

- Dòng **Hiện tại** cho biết các video trong lô đang dùng preset nào, ví dụ "Kể chuyện × 1 · Video hài hước × 1".
- Chọn preset rồi bấm **Áp dụng cho toàn bộ N video**. Sau đó từng video vẫn chỉnh riêng được trong trang video của nó.
- **BATCH REMIX AUDIO · $0 API**: mỗi video đã xuất được remix theo thiết lập của chính video đó. Các video được xử lý lần lượt, theo giới hạn "render tại máy cùng lúc" trong Cài đặt. Video chưa xuất hoặc không có track nguồn bị bỏ qua, kèm lý do.

---

Chi tiết kỹ thuật (cách tính 100%, đường cong ducking, file nguồn của Remix): `.ai/DECISIONS.md`, mục QĐ-149 và QĐ-150.
