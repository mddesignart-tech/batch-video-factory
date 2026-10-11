# Batch Video Factory V1.3.0 — Multi-Content & Scene Motion

**Ngày:** 2026-10-11 · **Tag:** `batch-video-factory-v1.3.0` · v1.0.0, v1.1.0 và v1.2.0 không đổi

## Highlights

- Không chỉ video thành ngữ: một engine cho nhiều loại nội dung (review sản phẩm, động vật, câu chuyện, kiến thức,
  quảng cáo…), có duyệt kịch bản trước khi tạo media.
- Tham chiếu dùng chung (nhân vật, sản phẩm, đồ vật, động vật, logo, bối cảnh) giữ một chủ thể nhất quán qua nhiều cảnh.
- Cảnh tĩnh có ngôn ngữ camera theo nội dung, chuyển cảnh mượt, và ghép nhiều lớp (chủ thể / nền / ambient) tại máy, $0.
- Không đồng API nào bị tiêu khi phát triển và kiểm thử V1.3: 0 POST trả phí.

## New features

- **Multi-Content Engine** — các mẫu Idiom / Product Review / AI / Custom / Toys / Animals / Story / Knowledge / Ads;
  nguồn từ prompt hoặc văn bản; chọn đối tượng, ngôn ngữ, giọng điệu. Trang TẠO VIDEO 4 bước, xem trước kịch bản,
  DUYỆT KỊCH BẢN.
- **Universal Reference Assets** — tham chiếu theo cảnh hoặc xuyên suốt video. Đổi ảnh tham chiếu chỉ làm lại các cảnh
  phụ thuộc; giọng và phụ đề giữ nguyên.
- **Creative Style Engine** — preset, tone, mức hài 0–5, nhịp, punchline, cảm xúc; dùng chung cho mọi loại nội dung.
- **Subtitle / Voice / Audio controls** — bật/tắt, cỡ, vị trí phụ đề; nhạc nền, SFX tổng hợp tại máy, âm lượng; giọng
  thuyết minh. Nghe thử giọng; giọng đã tạo được dùng lại, không mua TTS lần hai.
- **Định dạng nền tảng** — preset Shorts / TikTok / Reels / ngang theo từng project.
- **AI Camera Director** — cỡ cảnh, góc, chuyển động, tốc độ, lấy nét cho từng cảnh, kèm lý do; panel "Camera & lớp cảnh"
  để sửa tay (bản sửa tay không bị ghi đè).
- **Multi-Layer Scene Composer** — lớp foreground / midground / background / ambient; tách nền chủ thể tại máy (ảnh trên
  nền phẳng); 1–3 chủ thể; parallax theo độ sâu; ambient theo dải trời / chân trời / mặt đất; khối VỊ TRÍ TRONG KHUNG.
- **Hybrid local / Video AI routing** — preflight tách phần chuyển động $0 tại máy và phần Video AI trả phí.
- **Định tuyến theo tương tác vật lý** — cảnh có tương tác (cầm, chạm sản phẩm…) ưu tiên clip gốc, rồi ảnh nguyên cảnh;
  Video AI chỉ khi đã duyệt và vẫn giữ tham chiếu bắt buộc; nếu không thì hỏi người dùng (có lựa chọn "Bỏ tương tác").

## Quality / Motion improvements

- Camera tại máy mượt: chuyển động trên mọi khung hình, không đứng ở cuối cảnh, không bậc thang.
- Chuyển cảnh xfade giữ nguyên đồng hồ: phụ đề và giọng không lệch; cùng nhân vật → cắt thẳng, không chồng hai khuôn mặt.
- Continuity: cùng hướng lia, hạn chế hiệu ứng mạnh, người nói giữ bên màn hình; cảnh cùng nhân vật + cùng bối cảnh sau
  cảnh đẩy máy thì kéo máy ra từ đúng khung trước đó (không giật khi cắt).
- Loop ambient chuẩn 30 fps, khớp tốc độ render.
- Chủ thể đứng vững trong cảnh: cỡ theo loại, bóng tiếp xúc, nền mờ theo cỡ cảnh.
- Phụ đề đồng nhất cỡ chữ toàn video.
- Phụ đề cảnh nhiều người nói lấy đúng từng câu của giọng.

## Safety / Cost protections

- Không có model Video AI tự chọn được → cảnh CẦN CHỌN (chọn model / chuyển động tại máy / bỏ qua), không âm thầm chi.
- Tạo Video AI cần xác nhận giá; mỗi xác nhận = đúng một lần tạo.
- File giọng bị mất → báo rõ, không tự mua lại.
- Duyệt chi ở trạng thái nháp không còn bị đọc thành trần $0.
- Thẻ NGÂN SÁCH VIDEO, lỗi ngân sách bằng lời dễ hiểu, nhãn giá trên nút trả phí.
- Chỉnh phụ đề, âm thanh, camera, lớp cảnh = render lại tại máy, $0.
- Router production không đổi: chỉ `runway/h3_max:768x1280` được tự chọn cho cảnh LOW (LOW_AUTO).

## Compatibility

- Project và lô cũ render như V1.2: cảnh không có scene plan dùng đường render V1; prompt thành ngữ ở chế độ "Tự động"
  giữ nguyên từng byte.
- 6 migration mới (output profile, multi-content, reference assets, output controls, creative style, scene plan): chỉ thêm
  cột/bảng. Sao lưu `data/app.db` trước khi chạy `prisma migrate deploy`.
- Loop ambient tạo bằng `npm run ambient:generate` (file đã có giữ nguyên; `-- --force` để tạo lại ở 30 fps).

## Kiểm chứng

- Bộ test: **113/113 file · 1715/1715 test PASS** (một process). Lint, typecheck, build: PASS.
- Kiểm tra trên giao diện thật với bản sao dữ liệu (mock) và xem video mẫu bằng mắt.
- 0 POST trả phí trong toàn bộ V1.3.

## Known limitations

- **Local multi-layer không thay thế Video AI cho tương tác vật lý phức tạp** (cầm, rót, ôm, chạm). Những cảnh đó cần
  clip gốc hoặc Video AI đã kiểm chứng; tool sẽ hỏi thay vì tự làm.
- **Ambient production cần loop asset chất lượng thật.** Xe, người đi bộ, chim, lá hiện là hình minh hoạ tự sinh; muốn
  thật cần đặt loop alpha thật (.webm VP9 / .mov, 30 fps) vào `data/ambient/`.
- **Một số model Video AI chưa đủ capability/tham chiếu để AUTO route an toàn.** Chúng chỉ chạy khi người dùng chọn và
  xác nhận giá.
- Tách nền tại máy cần ảnh chủ thể trên nền phẳng; chủ thể trắng trên nền trắng có thể bị loang.
- Logo tham chiếu chưa được đặt lên video xuất (overlay).
- Text AI thật cho các mẫu nội dung mới mới chạy ở Mock Mode, chưa chạy bằng provider thật.
- Bộ test đầy đủ chậm (~2,4 giờ); một test lô trong `pipeline.e2e` đôi khi chạm timeout trên SQLite chung.
