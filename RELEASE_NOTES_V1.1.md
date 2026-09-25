# Batch Video Factory v1.1.0 — Production Storyboard Pipeline

**Ngày:** 2026-09-25 · **Tag:** `batch-video-factory-v1.1.0` · v1.0.0 không đổi

Bạn vẽ trước ảnh storyboard ở bất cứ đâu (GPT, Gemini, Ideogram, Photoshop…), đưa vào,
tool dựng video: giọng, phụ đề, chuyển động, MP4. **Ảnh nhập sẵn = dùng lại = $0 tiền
Image API.** Hướng dẫn: [`docs/IMPORT_STORYBOARD.md`](docs/IMPORT_STORYBOARD.md).

## Lô storyboard thật đầu tiên — PASSED

| | |
|---|---|
| Lô | `62e9322b` — "Break the ice", 5 cảnh, 5 ảnh nhập sẵn |
| Chi thật | **$0,400067** / trần duyệt $0,46 (dự toán $0,412100) |
| Image API | **0 POST** — 5 ảnh IMPORTED, dùng lại |
| Video API | 1 POST — `runway/h3_max:768x1280`, 5s, 40 credit (511 → 471) |
| Voice API | 5 POST — `openai/gpt-4o-mini-tts` |
| LOCAL_MOTION | 4 cảnh, FFmpeg tại máy, $0 |
| Retry / job trùng / POST lỗi | 0 / 0 / 0 · reservation treo $0 |
| MP4 | 22,000s · 1080x1920 · 30fps · h264 + aac · không đoạn đen |

## Có gì

- **Import Storyboard / Batch From Scenes** — ba cách: từng cảnh, nhiều ảnh ghép theo tên
  file (có bảng xem trước), hoặc storyboard JSON/CSV + ảnh (đường dẫn, hoặc tải thư mục /
  file / ZIP từ trình duyệt). Nhiều video một lần.
- **Ảnh nhập không tốn tiền Image API** — lúc chạy, lúc resume, lúc retry. Mỗi ảnh là một
  Asset `IMPORTED` (tên gốc, loại thật, kích thước, sha256), kiểm đuôi + magic bytes + giải
  mã thật; ảnh lệch 9:16 được đặt nguyên vẹn trên nền mờ, không kéo méo.
- **Character Bible / nhất quán nhân vật** — ảnh tham chiếu chuẩn + 11 trường khoá diện mạo.
- **LOW_AUTO** — router chỉ tự chọn `runway/h3_max:768x1280` cho cảnh LOW, động tác nhỏ, có
  keyframe, và khi người duyệt đồng ý riêng. Ghim tay luôn thắng.
- **LOCAL_MOTION** qua FFmpeg tại máy — $0 Video API.
- **Trần chi mỗi video và mỗi lô**, hạn mức toàn cục, ví riêng từng nhà cung cấp, giữ chỗ
  trước mỗi request. Trần/video của lô nhập nay tới đúng cổng chi tiền (trước là $2,50 mặc định).
- **Resume idempotent** — asset đã xong không bị mua lại; thay ảnh nhập làm clip cũ hết
  khớp (và UI báo trước); keyframe mất thì bước video dừng trước khi giữ chỗ tiền.
- **Chống ProviderJob trùng**, **sổ chi phí thật** theo hoá đơn nhà cung cấp.
- **Render MP4 cuối** bằng FFmpeg tại máy.

## Giới hạn đã biết

- Chưa có kéo-thả file (dùng nút chọn file / thư mục).
- Thay ảnh của cảnh VIDEO_AI cần clip mới (có tính phí, dự toán báo rõ); video cuối cần
  "Render lại MP4".
- Lô thật vẫn chạy bằng `scripts/run-real-multi-batch.ts`; chạy thật qua nút UI để sau.
- Hạn mức tổng còn $0,067 sau lô này.
