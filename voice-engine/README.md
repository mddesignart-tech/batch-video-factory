# Mind Voice — giọng AI chạy tại máy (QĐ-145)

Dịch vụ TTS cục bộ của Batch Video Factory. Không cần CIT Voice Studio, không gọi API trả phí, $0.

```
BATCH VIDEO FACTORY (Next.js)  ──HTTP 127.0.0.1:8011──►  MIND VOICE (Python, venv riêng)
                                                          ├─ VieNeu-TTS v3 Turbo  (tiếng Việt, 48 kHz)
                                                          └─ Supertonic 3         (tiếng Anh, 44,1 kHz)
```

## Cài đặt (một lần)

1. Chạy `voice-engine\setup_voice_engine.bat`. Script tạo `voice-engine\.venv` (Python 3.11, **không đụng Python hệ
   thống**) và cài SDK chính thức ghim phiên bản (`requirements.txt`, ~0,8 GB). Không tải model.
2. Chạy `START_TOOL.bat` như thường lệ. Có `.venv` → Mind Voice tự khởi động (cửa sổ thu nhỏ "Mind Voice").
3. Mở **Mind Voice Studio → Quản lý model**, xem dung lượng + giấy phép, bấm **Cài**:
   - VieNeu-TTS v3 Turbo fp32 (CPU, mặc định): 520 MB · int8 (nhẹ): 211 MB
   - Supertonic 3 (CPU): 401 MB

Model chỉ tải khi người dùng bấm Cài, từ repo chính thức trên Hugging Face, ghim theo commit, kiểm checksum từng tệp
(SHA-256 cho tệp LFS, git SHA-1 cho tệp nhỏ). Sai checksum → không cài, không để lại bản dở.

| Engine | Nguồn | Commit |
|---|---|---|
| VieNeu-TTS v3 Turbo | `pnnbao-ump/VieNeu-TTS-v3-Turbo` | `61b85e3d` |
| MOSS Audio Tokenizer (codec của VieNeu) | `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX` | `ceff0d07` |
| Supertonic 3 | `supertone-oss-archive/supertonic-3` | `aafc6e32` |

## API (chỉ localhost)

| Method | Path | Ý nghĩa |
|---|---|---|
| GET | `/health` | phiên bản, phần cứng, trạng thái engine |
| GET | `/models[?remote=1]` | Quản lý model (remote=1 hỏi Hub dung lượng tải, không tải) |
| POST | `/models/install` | `{engine, variant?}` cài model (chỉ khi người dùng bấm) |
| POST | `/models/verify` | `{engine}` kiểm lại checksum |
| GET | `/voices[?engine=]` | giọng thật từ SDK / model đã cài |
| POST | `/tts` | `{engine, voice, text, language?, speed?}` → `audio/wav` |

An toàn: chỉ bind `127.0.0.1`; Host khác localhost → 403; POST phải là `application/json` (415) nên trang web lạ không
gọi được. Không micro, không nhân bản giọng (cloning để giai đoạn sau).

## Khả năng thật (đã kiểm 2026-10-22 trên máy này)

- VieNeu: 25 giọng (vùng miền Bắc/Trung/Nam + phong cách lấy từ SDK, không tự đoán), 48 kHz, CPU fp32 ~0,75× thời
  gian thực trên i5-9400F. Thẻ cảm xúc: `[cười]` `[thở dài]` `[hắng giọng]`. **Không có thẻ ngắt nghỉ**: thẻ lạ như
  `[nghỉ 500ms]` bị ĐỌC THÀNH CHỮ → ngắt nghỉ dùng xuống dòng. Không có tốc độ gốc → app co giãn bằng ffmpeg `atempo`.
- Supertonic 3: 10 giọng M1–M5 / F1–F5, 44,1 kHz, tốc độ gốc 0,7–2,0. Thẻ `<laugh>` `<sigh>` `<breath>`.
  Repo chính thức đã **archive** (2026-09-09): không còn cập nhật.
- GPU: phát hiện NVIDIA; bản GPU cần PyTorch CUDA (~3 GB) — chưa làm, MVP chạy CPU.

## Giấy phép

- VieNeu-TTS (code + model): Apache-2.0 — © Phạm Nguyễn Ngọc Bảo. MOSS Audio Tokenizer: Apache-2.0 — © OpenMOSS.
- Supertonic 3: code MIT; **model OpenRAIL-M** — © Supertone Inc. Người dùng phải tuân thủ các giới hạn sử dụng trong
  `LICENSE` của model (được tải kèm vào `voice-engine\models\supertonic\cpu\LICENSE`). Ứng dụng hiển thị giấy phép trước
  khi cài và lưu attribution trong metadata mỗi file audio.
- Batch Video Factory **không đóng gói, không phân phối lại** model; mỗi máy tự tải từ nguồn chính thức.

## Kiểm tra

```
voice-engine\.venv\Scripts\python.exe -m unittest discover -s voice-engine\tests -t voice-engine   (không cần model)
npx vitest run tests/mind-voice.test.ts                                                           (mock server)
set MIND_VOICE_REAL=1 && npx vitest run tests/mind-voice-real.test.ts                              (Mind Voice thật)
```
