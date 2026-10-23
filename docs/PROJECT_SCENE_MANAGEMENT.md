# Quản lý dự án, cảnh và Thùng rác (QĐ-152)

Mọi thao tác xoá ở đây đều **đưa vào Thùng rác trước** và có thể khôi phục. Chỉ khi bấm **Xoá vĩnh viễn** trong Thùng rác thì file mới bị xoá, và chỉ xoá những file đã chứng minh không còn được dùng ở đâu.
Không thao tác nào gọi AI, tạo lại ảnh/giọng/video hay tự render: **$0**.

---

## 1. Xoá cảnh
**Dự án video → (chọn dự án) → Storyboard → chọn cảnh → Xóa cảnh → Xác nhận.**
- Cảnh vào Thùng rác. Các cảnh còn lại giữ nguyên nội dung và được đánh số lại 1…N.
- Thời lượng dự kiến tự tính lại. Lần render sau sẽ không còn lời thoại và phụ đề của cảnh đó.
- Video đã render **không bị thay đổi hay ghi đè, và không tự render lại**. Trang hiện thông báo "Storyboard đã thay đổi. Hãy render lại để cập nhật video."; video cũ vẫn xem được trong thẻ *Các bản video đã xuất*.
- Không xoá được khi dự án đang có việc chạy hoặc đang chờ (đang render, tạo media…). Hãy đợi xong.

## 2. Khôi phục cảnh
- **Ngay sau khi xoá:** bấm **Hoàn tác** trên thanh vàng ở đầu Storyboard.
- **Sau đó:** mở **Thùng rác → Cảnh**, nhập **vị trí** muốn đặt lại (mặc định là chỗ cũ), rồi bấm **Khôi phục**. Nếu storyboard đã ngắn hơn, cảnh được đặt ở cuối.
- Cảnh vốn đang "Bỏ qua" từ trước khi xoá thì sau khi khôi phục vẫn ở trạng thái bỏ qua.

## 3. Nhân bản cảnh
**Storyboard → chọn cảnh → Nhân bản cảnh.**
- Bản sao đứng ngay sau cảnh gốc và có mã cảnh riêng.
- Bản sao giữ nguyên lời thoại, phụ đề, ảnh, giọng, camera và thiết lập.
- File ảnh/giọng dùng chung, không tạo lại. Khi bạn tạo lại ảnh/giọng cho một cảnh, app luôn ghi ra **file mới**, nên sửa bản sao không bao giờ làm đổi cảnh gốc.

## 4. Xoá và khôi phục video đã xuất
**Trang dự án → thẻ *Các bản video đã xuất & dung lượng*.**
- Thẻ liệt kê mọi bản video: tên, ngày render, dung lượng, nhãn *Đang dùng*, *Remix Audio*, *Mất file*. Có nút **Xem**.
- **Xóa video** đưa bản đó vào Thùng rác.
  - Dự án, các cảnh, ảnh, giọng, âm thanh nguồn và các bản video khác giữ nguyên.
  - Nếu bản bị xoá đang dùng, bản mới nhất còn lại sẽ thành video của dự án. Nếu không còn bản nào, dự án chuyển về "chưa có video".
- **Khôi phục** ngay trong thẻ (mục *Trong Thùng rác*) hoặc từ trang Thùng rác.
- Không xoá được khi đang có Remix Audio hoặc render cho dự án đó.

## 5. Xoá dự án
- **Một dự án:** nút thùng rác ở dòng dự án trong **Dự án video**, hoặc **Xoá dự án** trong phần cài đặt của trang dự án.
- **Nhiều dự án:** tick các ô ở đầu dòng (có **Chọn tất cả / Bỏ chọn**), rồi bấm **Chuyển N dự án vào Thùng rác**.
- Bảng xác nhận liệt kê từng dự án: số cảnh, số video đã render, dung lượng ước tính, lần cập nhật cuối. Không có nút nào xoá tất cả chỉ bằng một lần bấm.
- Dự án bị ẩn khỏi mọi danh sách và các việc đang chờ bị huỷ. Dự án **đang chạy** sẽ không bị xoá. File chưa bị xoá.
- Mở lại link của dự án đã xoá sẽ thấy thông báo kèm nút **Khôi phục dự án**.

## 6. Thùng rác
Menu trái → **Thùng rác**.
- **Lọc:** Tất cả / Dự án / Cảnh / Video output.
- **Khôi phục** đưa mục về như cũ.
- **Xoá vĩnh viễn** hiển thị rõ dữ liệu sẽ mất; phải gõ **XOA** để xác nhận.
  - Chỉ xoá file nằm trong thư mục của chính mục đó, và chỉ khi không bản ghi nào khác (dự án khác, cảnh nhân bản, video Remix khác…) còn dùng.
  - File dùng chung được giữ lại và được báo trong kết quả.
- **Không có lịch tự động xoá.**

## 7. Nhân bản dự án
**Dự án video → nút nhân bản ở dòng dự án**, hoặc **Nhân bản dự án** trong trang dự án.
- Tạo "*tên dự án* - Bản sao" với mã dự án và mã cảnh mới.
- **Giữ:** các cảnh đang có, lời thoại, ảnh, clip, giọng, camera, Audio Mixer/preset, phụ đề, Motion Quality, cấu hình render.
- **Không chép:** lịch sử render, các bản video đã xuất, job, chi phí, cảnh trong Thùng rác. Bản sao không thuộc lô nào.
- File trong thư mục dự án gốc được **chép sang thư mục của bản sao**. Nhờ vậy sửa hay xoá bất kỳ bên nào cũng không làm hỏng bên kia. File dùng chung bên ngoài (ví dụ nhạc trong thư viện) vẫn dùng chung và không bao giờ bị xoá theo dự án.
- Không gọi AI, không render. Muốn có video thì bấm RENDER LẠI ($0).

## 8. Dung lượng và dọn file tạm
Thẻ *Các bản video đã xuất & dung lượng* → mục **Dung lượng dự án**:
- Dung lượng theo loại: ảnh nguồn, video nguồn, âm thanh nguồn, track Remix Audio, video output, file tạm.
- Phần **dùng chung với dự án khác** (không thu hồi được khi xoá) và phần **dùng thêm từ thư viện chung** được tách riêng, không cộng trùng.
- **DỌN FILE TẠM** chỉ xoá thư mục `temp` và file `.tmp` / `.part` không còn được dùng.
  - **Không xoá:** ảnh nguồn, file giọng, track Remix Audio, video nguồn, video output, file dùng chung.
  - Không chạy khi dự án đang có việc.

## 9. Kiểm tra kịch bản
**Storyboard → KIỂM TRA KỊCH BẢN.** Kết quả chia 3 mức:
- **Lỗi cấu trúc:** cảnh thiếu ảnh/video, file nguồn hoặc file giọng không còn, asset không tồn tại, video đã xuất mất file, việc đang chờ cho cảnh đã xoá.
- **Cảnh báo:** ảnh/video thuộc dự án khác mà không phải tái dùng hợp lệ, thứ tự cảnh bất thường, có lời thoại nhưng chưa có câu giọng.
- **Tham khảo:** thời lượng lệch nhiều so với mục tiêu; storyboard đã đổi sau lần render; cảnh có **nội dung chữ** khác hẳn chủ đề.
  - Phần nội dung chỉ so sánh chữ (lời thoại, phụ đề, tiêu đề), **chưa xem hình**.
  - Video quảng cáo, hài hay kể chuyện có thể cố ý đổi chủ đề, nên không cảnh nào bị xoá tự động. Bạn chọn **Xem cảnh** hoặc **Bỏ qua cảnh báo**.

## 10. Dữ liệu được giữ lại
- Mọi thứ trong Thùng rác giữ nguyên file cho đến khi bạn xoá vĩnh viễn.
- Xoá vĩnh viễn không bao giờ xoá file ngoài thư mục của mục bị xoá, không đi theo symlink, và không xoá file còn được bất kỳ bản ghi nào nhắc tới.
  - Riêng nhật ký, lịch sử request và sổ chi chỉ là lịch sử nên không được tính là "đang dùng"; bản thân chúng không bị xoá.
- Sổ chi phí (CostEntry) và nhật ký không bao giờ bị xoá theo dự án.

Chi tiết kỹ thuật: `.ai/DECISIONS.md`, mục QĐ-152.
