# Chế độ ngoại tuyến

Ứng dụng là **local-first**. Mất mạng không được làm hỏng việc chỉnh sửa, duyệt
nội dung hay render.

---

## Chạy được khi không có Internet

- Mở ứng dụng
- Bảng điều khiển
- Quản lý thành ngữ (thêm, sửa, xoá, tìm, nhập CSV/JSON)
- Quản lý nhân vật
- Quản lý phong cách
- Quản lý dự án
- Sửa kịch bản
- Sửa storyboard
- Duyệt media đã có
- Xem video đã render
- Lịch sử chi phí
- Nhật ký
- Xử lý bằng FFmpeg
- Tạo phụ đề
- Trộn âm thanh
- Xuất MP4
- **Toàn bộ chế độ mock**

Tất cả những thứ trên chỉ chạm vào SQLite, đĩa cục bộ và FFmpeg.

---

## Cần Internet

Chỉ những lệnh gọi ra bên ngoài:

- Text AI thật
- Image AI thật
- Video AI thật
- Voice AI thật
- Đánh giá chất lượng bằng AI thật
- Kiểm tra trạng thái nhà cung cấp

---

## Hành vi khi mất mạng

Không sập. Không màn hình lỗi. Không stack trace.

Thanh trạng thái chuyển sang "Ngoại tuyến" và hiện:

> Không có kết nối Internet. Bạn vẫn có thể chỉnh sửa dự án, quản lý nội dung và
> render các media đã có.

Các nút gọi AI thật bị vô hiệu hoá một cách êm ái. Mọi thứ khác hoạt động bình
thường.

---

## Ở chế độ mock luôn là "trực tuyến"

Khi `AI_MOCK_MODE=true`, `getConnectivity()` trả về `ONLINE` mà không hề thăm dò
mạng.

Điều này đúng về mặt logic: ở chế độ mock không có gì cần tới mạng, nên không có
lý do gì để vô hiệu hoá bất kỳ nút nào. Nó cũng có nghĩa là **toàn bộ quy trình
Milestone 1 chạy được khi rút dây mạng** — một cách kiểm chứng tốt rằng không có
lệnh gọi ra ngoài nào lẩn khuất đâu đó.

---

## Cách phát hiện

`src/services/connectivity.ts`

- Một yêu cầu HTTP ngắn tới hai điểm đầu cuối phổ biến, timeout 3 giây.
- Kết quả được nhớ trong 30 giây.
- Ở chế độ mock thì bỏ qua hoàn toàn.

Cố tình rẻ. Đây là công cụ cục bộ, không phải hệ thống giám sát: thăm dò liên
tục chỉ tốn pin và tạo nhiễu.

---

## Tự thử

1. Tắt Wi-Fi.
2. Mở http://localhost:3000
3. Thêm một thành ngữ, sửa một dự án, mở storyboard, bấm "Render lại MP4".
4. Mọi thứ vẫn chạy.
