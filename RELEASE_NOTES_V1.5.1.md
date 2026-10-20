# Batch Video Factory v1.5.1

Bản sửa lỗi sau v1.5.0. Không có tính năng mới, không migration.

## Có gì trong bản này

- **QĐ-141 — đủ N mục + chi phí khớp sổ chi.** "3 mẹo / 5 bước / Top 7" cho ra đúng N cảnh mục. Thiếu mục thì
  viết lại 1 lần, còn thiếu thì chặn ở bước duyệt kịch bản. `Scene.actualCost` và chi phí dự án đọc từ sổ chi.
- **Thông báo đúng cảnh.** Dòng thông báo ở storyboard gắn với cảnh đã bấm nút. Đổi cảnh không còn hiện thông báo
  của cảnh khác (ví dụ "Cảnh 5 dùng ảnh nhập" khi đang mở cảnh 1). Khối "Ảnh cảnh" làm mới theo từng cảnh.

## Đã kiểm tra

- REAL API VALIDATION 2026-10-20 PASS: đủ Mẹo 1/2/3, chi phí cảnh/dự án = sổ chi, render lại không cộng tiền.
  Chi thật $0,125924.
- Full suite 125/125 file · 1875/1875 PASS (ở `5396422`). Bản sửa thông báo: test liên quan 44/44 PASS,
  lint, typecheck, build, secret scan PASS. Không gọi API trả phí.

## Đã biết, chưa sửa

- Thời lượng đặt 12 s nhưng video thật 28,08 s khi lời đọc dài hơn — nằm trong backlog.
