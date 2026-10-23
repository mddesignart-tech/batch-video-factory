# scripts/qa — kiểm thử thủ công và nghiệm thu

Các script ở đây không chạy trong `npm test`. Bạn tự chạy khi cần kiểm tra bằng dữ liệu thật hoặc bằng tai.
**Không script nào gọi API có phí khi chạy mặc định.** Script duy nhất có thể tốn tiền là `voice-ab-real.ts`, và chỉ khi thêm `--real`.

| Script | Dùng để | Chạy | Chi phí |
|---|---|---|---|
| `aivietlab-real-test.ts` | Dựng lại video thử AIVietLab (Thục Đoan, 6 ảnh dùng lại, nhạc Digital Clouds) bằng renderer production | `npx tsx scripts/qa/aivietlab-real-test.ts` | $0 · cần Mind Voice local (`127.0.0.1:8011`) nếu thiếu file giọng; mỗi lần chạy xuất thêm một `final_*.mp4` mới |
| `aivietlab-audio-fix.ts` | QĐ-149: trộn lại âm thanh một video AIVietLab đã xuất (hình stream copy) | `MUSIC_DB=-6.2 OUT_SUFFIX=_ten_moi npx tsx scripts/qa/aivietlab-audio-fix.ts <video.mp4>` | $0 · không ghi đè file đã có |
| `qd150-mixer-validate.ts` | QĐ-150: trộn video AIVietLab bằng Audio Mixer theo một preset để so với bản đã duyệt | `npx tsx scripts/qa/qd150-mixer-validate.ts [REVIEW_AI\|FUNNY\|STORY\|PRODUCT\|NO_VOICE]` · `BED_ONLY=<file.wav>` để xuất riêng track nhạc | $0 · không ghi đè |
| `qd150-preset-previews.ts` | QĐ-150: tạo MP3 nghe thử 5 preset, kèm số đo (LUFS, ducking, peak) và trang `nghe-thu-preset.html` | `npx tsx scripts/qa/qd150-preset-previews.ts [giây bắt đầu] [giây kết thúc]` | $0 · ghi vào `data/projects/aivietlab-test-2026-10-22/audio-previews/` |
| `qd150-ui-seed.ts` | QĐ-150: dữ liệu thử cho UI trên DB và thư mục dữ liệu **riêng** (từ chối chạy với `data/app.db`) | `DATA_DIR=<thư mục> DATABASE_URL=file:<db mới> npx tsx scripts/qa/qd150-ui-seed.ts` (trước đó chạy `prisma migrate deploy` cho DB mới) | $0 |
| `qd150-uat-real.ts` | QĐ-150: tạo lô "QĐ-150 NGHIỆM THU" (2 video, ngân sách $0) trong **app thật** từ giọng, ảnh, nhạc AIVietLab có sẵn | `UAT_REAL=1 npx tsx scripts/qa/qd150-uat-real.ts` — sao lưu `data/app.db` trước khi chạy | $0 · cần file của `aivietlab-real-test.ts` |
| `qd151/` | QĐ-151: nghiên cứu chuyển động camera. Prototype renderer V2 (`motion-v2.ts`), benchmark (`bench.ts`, `compat.ts`), đo chuyển động (`motion_probe.py`), trang so sánh (`report.ts`), gợi ý camera (`suggest.ts`). Chi tiết: `docs/QD151_MOTION_RESEARCH.md` mục 12 | `npx tsx scripts/qa/qd151/bench.ts` → `compat.ts` → `report.ts` | $0 · chỉ ghi vào `data/benchmarks/qd151/` |
| `qd151-uat-real.ts` | QĐ-151: tạo lô "QĐ-151 NGHIỆM THU" (3 video cùng 7 cảnh: A Legacy 9:16, B Smooth V2 9:16, C Smooth V2 16:9; có cảnh PNG trong suốt; ngân sách $0) trong **app thật** từ file có sẵn; render bằng RENDER LẠI trong app | `UAT_REAL=1 npx tsx scripts/qa/qd151-uat-real.ts` — sao lưu `data/app.db` trước | $0 |
| `qd151/uat-timing.ts` | QĐ-151: đo thời gian render camera tuần tự Legacy / Smooth V2 / HQ V2 trên các cảnh thật của một project (không cache), rồi đo độ giật bằng `motion_probe.py` | `npx tsx scripts/qa/qd151/uat-timing.ts <projectId>` | $0 · chỉ ghi vào `data/benchmarks/qd151/uat-timing/` |
| `voice-ab-real.ts` | QĐ-142: A/B 6 giọng OpenAI trên cùng một câu | Mặc định là dry-run: in ước tính, **không gọi API**. Chạy thật: `npx tsx scripts/qa/voice-ab-real.ts --real --limit 0.01` | Chỉ khi `--real`: qua giới hạn chi, `assertCanSpend`, ghi sổ chi |

Hướng dẫn dùng Audio Mixer cho người dùng: [docs/AUDIO_MIXER.md](../../docs/AUDIO_MIXER.md).
