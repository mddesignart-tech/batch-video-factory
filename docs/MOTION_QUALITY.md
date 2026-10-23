# Hướng dẫn Motion Quality — chất lượng chuyển động camera (QĐ-151)

Motion Quality chọn **cách render chuyển động camera trên ảnh tĩnh** (LOCAL_MOTION). **Kiểu camera không đổi**: lia, zoom, tilt, dolly… vẫn do Camera Director hoặc bạn chọn cho từng cảnh. Motion Quality chỉ quyết định camera đó được vẽ mượt đến đâu.
Mọi lựa chọn đều render **tại máy, $0 API**.

Mở: **Dự án video → (chọn video) → Video output → mục CHUYỂN ĐỘNG CAMERA → "Chất lượng chuyển động"**.

| Lựa chọn | Khi nào dùng | Đo được (benchmark QĐ-151, 1080×1920) |
|---|---|---|
| **Legacy** — tương thích cũ | Giữ y nguyên video đã làm trước QĐ-151 | Camera lệch nhịp ~35% tốc độ; render ~12 s cho mỗi cảnh 7 s |
| **Smooth V2** — mượt và nhanh | **Khuyên dùng**, kể cả sản xuất hàng loạt | Lệch nhịp ~6%; render ~9 s cho mỗi cảnh 7 s |
| **High Quality V2** — ưu tiên độ nét | Video cần chi tiết mảnh nét nhất | Lệch nhịp ~6%, nét hơn; render ~27 s cho mỗi cảnh 7 s (**lâu hơn đáng kể**) |

## Cách dùng
1. Chọn **Smooth V2** (hoặc High Quality V2) trong ô "Chất lượng chuyển động".
2. Bấm **RENDER LẠI · $0 API**. Ảnh, giọng, nhạc và phụ đề được dùng lại; chỉ phần hình chuyển động được render lại.
3. Muốn quay về như cũ thì chọn **Legacy** rồi render lại.

## Những điều cần biết
- **Video cũ không tự đổi.** Mọi video tạo trước QĐ-151 đọc ra Legacy và không bị render lại ngầm.
- **Video MỚI** bắt đầu với lựa chọn trong **Cài đặt → Âm thanh → Chuyển động camera (QĐ-151)**. Mặc định là Smooth V2; có thể chọn Legacy. High Quality V2 không bao giờ là mặc định và không tự áp cho cả lô.
- **Phạm vi áp dụng:** cảnh ảnh tĩnh có camera plan. Các cảnh sau vẫn dùng Legacy, và nhật ký ghi rõ lý do:
  - cảnh nhiều lớp (cut-out ghép nền);
  - cảnh chưa có camera plan (dự án rất cũ);
  - cảnh dùng clip video (VIDEO_AI / clip bạn tải lên) — không có camera tại máy.
- **Nếu V2 không render được một cảnh**, cảnh đó tự render bằng Legacy để video không bao giờ hỏng. Nhật ký ghi `render.motion_fallback` kèm lý do; không có thay đổi âm thầm nào.
- **Không ảnh hưởng:** âm thanh (Audio Mixer, preset, Remix Audio), giọng, phụ đề, thời lượng cảnh, chuyển cảnh, xuất TikTok/Shorts/Reels.
- **WHIP_PAN và CRASH_ZOOM:** đây là hiệu ứng cố ý giật mạnh rồi đứng lại, nên V2 cho kết quả giống Legacy.

Chi tiết kỹ thuật: `docs/QD151_MOTION_RESEARCH.md`.
