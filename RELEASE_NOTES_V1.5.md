# Batch Video Factory V1.5.0 — Batch Style, URL Source & Safer Batches

**Ngày:** 2026-10-19 · **Tag:** `batch-video-factory-v1.5.0` · v1.0.0 → v1.4.0 không đổi

## Highlights

- Lô thành ngữ có **phong cách sáng tạo cho cả lô** (Creative Style Engine).
- Lấy **nội dung từ URL** làm nguồn kịch bản, có xem trước và chống SSRF.
- **DỪNG BATCH dừng thật**, và lô thành ngữ được **duyệt chi theo kịch bản thật**, không theo kịch bản mẫu.
- Dọn hết các lỗi UAT P2/P3: quyết định tay về Reference luôn thắng, bảng tiếp tục riêng tự cập nhật, giá cảnh đúng
  sau khi gán clip, cảnh báo logo 0 %.
- Full suite chạy trong ~41–45 phút (trước ~2,6 giờ).
- Không đồng API nào bị tiêu khi phát triển và kiểm thử V1.5: 0 POST trả phí.

## Phạm vi so với v1.4.0

Các tính năng **Uploaded Video Clip Input (QĐ-132)**, **Logo Final Overlay (QĐ-134)**, **Reference Assignment Safety**
và **sửa lặp khung đầu / Frame Timing (QĐ-133)** đã phát hành trong **v1.4.0** — xem `RELEASE_NOTES_V1.4.md`. V1.5
không phát hành lại chúng; V1.5 chỉ bổ sung các sửa ở QĐ-140 ghi bên dưới cho ba phần đó.

## New features

- **Batch Creative Style (QĐ-136)** — chọn MỘT phong cách cho cả lô thành ngữ (preset, mức hài, nhịp, punchline, camera…).
  - Phong cách được lưu trong kế hoạch đã duyệt; mọi video của lô được viết bằng cùng engine với luồng TẠO VIDEO.
  - Kịch bản, chấm điểm, Camera Director và motion đều theo phong cách của lô.
  - Đổi phong cách khi đã có media chỉ lưu lại, không gọi Image / Video / Voice.
  - Lô cũ (kế hoạch chưa có phong cách) chạy như trước.
- **URL Content Extraction (QĐ-138)** — nguồn URL trong TẠO VIDEO.
  - Quy trình: dán link → ĐỌC NỘI DUNG → xem trước (tiêu đề, domain, loại trang, ngôn ngữ, số ký tự, cảnh báo) →
    CHỈNH SỬA / CHẤP NHẬN / ĐỌC LẠI → TẠO KỊCH BẢN.
  - Nội dung được lưu thành snapshot trong dự án: viết lại, tiếp tục và render không mở lại link.
  - Thẻ "Nguồn URL" có ĐỌC LẠI TỪ WEB và THAY NGUỒN; cả hai chỉ đổi nguồn.
  - Chống SSRF (IP riêng, localhost, metadata, DNS rebinding, redirect); timeout 15 s; giới hạn 3 MB; kiểm tra
    content-type. Trích được bài viết và trang sản phẩm (JSON-LD).

## Fixes

- **Batch Stop / Resume safety (QĐ-137)**
  - DỪNG BATCH được kiểm tra trước mỗi cảnh, trước mỗi bước ảnh / clip / giọng và trước render. Trước đây chỉ kiểm tra
    giữa các video.
  - Bước đã gửi tới provider thì chạy xong và giữ kết quả. Video bị dừng không bị đánh FAILED; lô chốt CANCELLED,
    không kẹt RUNNING. DỪNG idempotent.
  - Tên lô mặc định tự tăng ("#NNN" tiếp theo). Lô thành ngữ chưa duyệt hiện đúng thông báo khi chưa có video.
- **Real-storyboard preflight / model consistency (QĐ-139)** — lô thành ngữ trước đây được duyệt theo kịch bản MẪU. Kịch
  bản thật cần nhiều cảnh AI hơn và model khác, nên cả lô FAILED với `APPROVED_MODEL_MISSING` và dự toán thấp ~6×.
  Nay quy trình có ba bước:
  1. PHÂN TÍCH & DỰ TOÁN (ước tính sơ bộ, không dùng để duyệt).
  2. VIẾT KỊCH BẢN THẬT (chỉ Text AI).
  3. PREFLIGHT từng cảnh thật → DUYỆT & CHẠY.
  - Chưa có kịch bản thật thì không duyệt được (`SCRIPTS_REQUIRED`).
  - Mọi clip được đóng băng đúng route đã định giá. Nếu lúc chạy lại đòi một model chưa duyệt: dừng trước POST, video về
    CẦN DUYỆT LẠI thay vì FAILED.
- **QĐ-140 — dọn tồn đọng UAT P2/P3**
  - **Reference "Xuyên suốt video":** Reference người dùng đã tự bỏ khỏi một cảnh không còn bị gắn lại khi bật "Xuyên
    suốt video" hay TỰ GẮN. Kế hoạch cảnh cũng tôn trọng việc bỏ tay này.
    - Quyết định tay được lưu theo từng cảnh (INCLUDE / EXCLUDE); tích lại bằng tay thì thành INCLUDE.
    - Không làm cũ / tạo lại media âm thầm.
    - Giao diện hiện "(đã bỏ tay)".
  - **Bảng "tiếp tục riêng"** tự đọc lại theo tiến trình lô và poll khi lô đang chạy; không cần F5.
  - **Thẻ phong cách lô** chỉ hiện cho lô thành ngữ, không hiện ở dự án đơn được bọc thành lô 1 video.
  - **Giá cảnh sau khi gán clip:** cảnh dùng "Video của bạn" hiện dự toán sống, không còn giá Video AI cũ (vd. $0.22).
    Chỉ sửa phần hiển thị; cost ledger không đổi.
  - **Logo độ rõ 0 %:** cảnh báo "Logo đang hoàn toàn trong suốt và sẽ không nhìn thấy trong video."; vẫn lưu được.

## Test infrastructure

- **Tăng tốc full suite** — mỗi lần chạy test dùng thư mục riêng trong thư mục temp của hệ điều hành (SSD) thay cho
  `data/.test` (HDD): 9415 s → ~2500 s. Lần chạy cuối: 2665 s. Không đổi code production.

## Compatibility

- 1 migration mới: `20261019000000_scene_reference_manual`. Chỉ thêm cột `Scene.referenceManualJson`, mặc định `{}`,
  nghĩa là chưa có quyết định tay nào: hành vi giống v1.4.
  - Sao lưu `data/app.db` trước khi chạy `npx prisma migrate deploy`.
  - DB production của dự án đã được áp sau sao lưu; số liệu không đổi.
- Phong cách lô lưu trong kế hoạch của lô; nguồn URL lưu trong dự án. Hai phần này không cần migration.
- `START_TOOL.bat` là launcher local, cố ý để ngoài git. Bản local nay tự build lại khi code mới hơn bản build, báo
  server cũ ở cổng 3000, và cảnh báo khi DB thiếu migration (không tự áp).

## Kiểm chứng

- Bộ test: **124/124 file · 1861/1861 test PASS** (một process, Mock Mode, key giả). Lint, typecheck, build, secret
  scan: PASS.
- Smoke UI thật cho QĐ-140 (sandbox: DB + data riêng, production build, Mock Mode, key giả; DB thật không đổi): đạt cả 6
  mục — Reference bỏ tay / INCLUDE, lô 16 video tự cập nhật tiến trình, thẻ phong cách đúng ngữ cảnh, giá cảnh sau
  khi gán clip, cảnh báo logo 0 %, launcher phát hiện code mới.
- Smoke UI QĐ-136 (lô 16 thành ngữ TikTok Comedy / Professional), QĐ-138 (đọc trang fixture) và QĐ-139 (Professional
  #004, TikTok #005): ĐẠT.
- 0 POST trả phí trong toàn bộ V1.5.

## Known limitations

- **Clip tải lên chỉ dùng làm toàn bộ hình của cảnh.** Dùng clip như một lớp trong Multi-Layer, smart crop theo mặt /
  sản phẩm, và liên kết clip với tham chiếu vẫn ở backlog.
- **URL:** chưa đọc được trang chỉ hiển thị bằng JavaScript hay mạng xã hội (cần headless browser). Chưa tải ảnh sản phẩm
  từ URL làm tham chiếu (chỉ lưu link og:image). Chưa đọc PDF qua link.
- **Phong cách lô là một phong cách cho cả lô** — chưa có override theo từng thành ngữ (đổi từng video ở trang dự án).
- **Tương tác vật lý phức tạp** (cầm, rót, ôm, chạm) vẫn cần clip tải lên / clip gốc, hoặc Video AI phù hợp đã kiểm chứng.
- **Ambient production cần loop asset chất lượng thật** — loop hiện có là hình minh hoạ tự sinh.
- **Một số model Video AI chưa đủ capability tham chiếu trực tiếp** để AUTO route an toàn; chỉ chạy khi người dùng chọn
  và xác nhận giá.
- **Logo:** chưa có kéo-thả vị trí tự do, SVG, logo động, xem trước realtime.
- **Portable / LAN packaging** vẫn TẠM DỪNG; chưa có code.
- **V1.5 chưa được chạy với API thật** — toàn bộ kiểm chứng ở Mock Mode. Lần chạy thật cần người dùng duyệt chi.
