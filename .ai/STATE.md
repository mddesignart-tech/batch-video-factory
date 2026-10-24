# Trạng thái dự án

**Cập nhật:** 2026-10-23 (**QĐ-156 TTS NGẮT CÂU — NGHIỆM THU ĐẠT** — pause guard VieNeu + xuống dòng đơn đọc liền; A/B `data/qa/qd156/ab/index.html`; giọng cũ không tự tạo lại; chưa push, $0). 2026-10-23 (**QĐ-154 RUNWAY XÁC NHẬN CHI — CHỜ NGHIỆM THU** — xác nhận giá ở Storyboard cho phép đúng 1 clip; trang Nhà cung cấp AI có nút cho model video; chưa push). 2026-10-23 (**QĐ-153 MIND VOICE TỰ KHỞI ĐỘNG — CHỜ NGHIỆM THU** — app bật Mind Voice khi khởi động / nút Khởi động, cổng độc quyền; chưa push). 2026-10-23 (**QĐ-152 QUẢN LÝ DỰ ÁN & CẢNH — XONG, CHỜ NGHIỆM THU** — Thùng rác soft delete cho cảnh / video output / dự án, khôi phục, xoá vĩnh viễn an toàn, nhân bản cảnh & dự án, KIỂM TRA KỊCH BẢN, dung lượng + dọn file tạm; migration 20261023000000 (chỉ thêm cột) đã áp production sau sao lưu; cảnh LOCK&LOCK = dữ liệu QA của QĐ-151, không lẫn dữ liệu; chưa push, $0). 2026-10-23 (**QĐ-151 LOCAL_MOTION V2 — ĐÃ TÍCH HỢP, CHỜ NGHIỆM THU** — Motion Quality LEGACY / SMOOTH_V2 / HQ_V2 trong Video output; project cũ = Legacy, project mới = Smooth V2 (Cài đặt); 27 kiểu camera + speaker lean qua V2 từ chính biểu thức production; cảnh nhiều lớp / chưa có plan / clip = Legacy; V2 lỗi → Legacy + log; lô nghiệm thu thật "QĐ-151 NGHIỆM THU": giật 42,5% → 10,4%, camera 92,2 s → 68,8 s, âm thanh A/B/C giống hệt MD5; chưa push, $0). 2026-10-23 (**QĐ-150 DONE + NGHIỆM THU ĐẠT** — Audio Mixer: nhạc một track liền, ducking theo timeline lời, 100% = mức đã nghe duyệt, 5 preset + preset tự tạo, nghe thử, REMIX AUDIO giữ nguyên hình, Batch Audio; project cũ không đổi; full suite 133/134 file (1 skipped) · 1980/1984 PASS, $0). 2026-10-23 (**QĐ-149 DONE** — nhạc nền giật ở chuyển cảnh: nguyên nhân = ducking sidechain 20 ms/350 ms hạ ~20 dB; bản nhạc +2 dB được người dùng duyệt). 2026-10-22 (**QĐ-148 DONE** — Thục Đoan giọng tiếng Việt ưu tiên #1, preset "Thục Đoan – Tự nhiên & Biểu cảm" đúng mẫu 02 20/20, baseline tham chiếu; không đổi giọng mặc định / project cũ; A/B QĐ-147 người dùng chấm A 12/20, B 13/20; full suite 132/133 file (1 skipped) · 1956/1960 PASS, $0). 2026-10-22 (**QĐ-147 DONE** — Dialogue Voice Director: cảm xúc riêng từng nhân vật bằng khả năng thật của engine, VieNeu giữ ?/! câu ngắn (`keep_punct`); mặc định tắt; mẫu A/B chờ người nghe chấm; full suite 132/133 file (1 skipped) · 1951/1955 PASS, $0). 2026-10-22 (**QĐ-146 DONE** — lưu 15 điểm người nghe, gợi ý giọng theo loại nội dung, emotion adapter theo khả năng thật: không gửi [thở dài]/<sigh>; full suite 131/132 file (1 skipped) · 1945/1949 PASS, $0). 2026-10-22 (**QĐ-145 MIND VOICE DONE** — TTS local độc lập VieNeu-TTS + Supertonic 3, không cần CIT; full suite 130/131 file (1 skipped = test thật có cờ) · 1928/1932 PASS; real local pipeline 4/4 PASS, $0). 2026-10-21 (**QĐ-144 DONE (Phase 1)** — CIT Voice Studio làm LOCAL TTS PROVIDER đa ngôn ngữ, $0, pin-only, không fallback sang trả phí; full suite 129/129 file · 1916/1916 PASS, mock, $0; real smoke chờ người dùng cài/mở CIT). 2026-10-21 (**QĐ-143 DONE** — TTS không còn đọc nhãn người nói "Narrator:"; chỉ bỏ nhãn khớp người nói / nhãn vai trò, "Lưu ý:" giữ nguyên; full suite 128/128 file · 1906/1906 PASS, mock, $0). 2026-10-21 (REAL VOICE A/B 6 giọng: $0,000744, sổ $11,327552/$15; file ở data/voice-ab/2026-10-21T06-59-50). 2026-10-20 (**QĐ-142 VOICE DIRECTOR DONE** — đạo diễn giọng theo phong cách + vai trò cảnh, 12 preset, 13 giọng OpenAI, chuẩn hoá lời đọc; full suite 127/127 file · 1896/1896 PASS, mock, $0; chưa chạy A/B giọng thật — chờ duyệt; xem mục đầu). 2026-10-20 (**V1.5.1 RELEASED** — tag `batch-video-factory-v1.5.1` → commit này + GitHub Release (Latest), ghi chú `RELEASE_NOTES_V1.5.1.md`; QĐ-141 + REAL API VALIDATION PASS + sửa dòng thông báo sai cảnh; xem mục đầu). 2026-10-19 (**QĐ-141 DONE** — đủ N mục theo yêu cầu + chi phí cảnh/dự án khớp sổ chi, sau REAL API SMOKE TEST đầu tiên PASS $0,125; xem mục đầu). 2026-10-19 (**V1.5.0 RELEASED** — tag `batch-video-factory-v1.5.0` → commit release-housekeeping này + GitHub Release, ghi chú `RELEASE_NOTES_V1.5.md`; gồm QĐ-136 → QĐ-140, full suite 124/124 file · 1861/1861 PASS ở `fea00f7`, UI smoke QĐ-140 PASS). 2026-10-19 (**QĐ-140 DONE** — dọn tồn đọng UAT P2/P3; xem mục đầu). 2026-10-17 (**QĐ-139 DONE** — lô thành ngữ duyệt chi theo kịch bản thật, sửa P1 của UAT; xem mục đầu). 2026-10-17 (**QĐ-138 DONE** — URL Content Extraction; xem mục đầu). 2026-10-17 (**QĐ-137 DONE** — DỪNG BATCH dừng thật + tên lô tăng dần + empty-state lô thành ngữ; xem mục đầu). 2026-10-17 (**QĐ-136 DONE** — Creative Style cho lô thành ngữ, main = origin/main sau `84be22f`; xem mục đầu). 2026-10-17 (full suite 41,4 phút thay vì 2 giờ 37 phút — xem mục đầu). 2026-10-16 (**V1.4.0 RELEASED** — tag `batch-video-factory-v1.4.0` → commit release-housekeeping này
+ GitHub Release, ghi chú `RELEASE_NOTES_V1.4.md`. Gồm QĐ-132 → QĐ-135, full suite 119/119 file · 1786/1786 PASS ở
`738f1f3`. Trước đó: V1.3.0 RELEASED — tag `batch-video-factory-v1.3.0` → `6524187`.)
**Cột mốc trước:** V1.2.0 RELEASED (2026-10-01, QĐ-116). Baseline sản xuất thật: v1.1.0 (bên dưới).

## QĐ-158 FINAL DATABASE SAFETY (2026-10-24, $0) — MIGRATION ĐÃ ÁP VÀO data/app.db (người dùng cho phép)

- Đã áp `20261024000000_character_voice_profiles` vào data/app.db (app thật tắt, DB = bản sao lưu ngay trước đó). Sau áp: 23 bảng dữ liệu không đổi, 21/120/4/118/280, sổ $12,478543, giọng 4 nhân vật giữ nguyên. App (cổng tạm 3102, Mock Mode, worker tắt): 17 dự án + characters/workspace/batches/trash 200, 3 cảnh báo giọng (Leo, Mia, Narrator). CHƯA PUSH.

- 18 câu bị chặn = 5 dự án kiểm thử bằng API THẬT (Spill the beans, Piece of Cake, Break a Leg, 2× "3 mẹo nhỏ…"); audio OpenAI (ballad / coral) của cả 18 câu CÒN trên đĩa. Nguyên nhân: Leo / Mia / Narrator đã bị đổi sang Mind Voice với tên giọng OpenAI sau khi audio được tạo.
- Render lại trên bản sao (`scripts/qa/qd158-rerender-check.ts`): "3 mẹo nhỏ giúp…" dùng đúng 5 file coral (hash không đổi), 0 TTS, 0 sổ chi; QĐ-150 Video A: 47,79 s, −16,1 LUFS, LRA 1,8 — giống hệt bản gốc.
- Bản sao lưu = data/app.db (24 bảng, nội dung giống hệt; sổ $12,478543). data/app.db không đổi từ 07:33.
- Mock voice ngoài Mock Mode = chưa có giọng thật (0e9654a).
- Full suite (0e9654a): 141 file + 2 bỏ qua có chủ đích; 2044/2049, 0 lỗi, 3283 s. Pause Guard Python 16/16.

## QĐ-158 HOÀN THIỆN (2026-10-24, $0) — CHỜ NGƯỜI DÙNG XÁC NHẬN ÁP MIGRATION VÀO data/app.db

- Commit local: `a7a2c6c` (tính năng) + `c207c84` (hoàn thiện) + commit tài liệu này. CHƯA PUSH, CHƯA RELEASE.
- **English — General** (`en`): Supertonic / OpenAI không công bố giọng vùng → không gắn nhãn US/UK. en-US / en-GB chỉ liệt kê giọng đã xác minh giọng vùng (hiện 0).
- **Ưu tiên giọng Narrator:** giọng dự án chọn (VIDEO OUTPUT) → giọng đã KHOÁ của Narrator → preset Voice Director (chỉ khi chưa khoá). Chỉ đổi tốc độ ở dự án không bỏ giọng khoá.
- **Liên kết nhân vật:** Storyboard vẫn theo tên (tên duy nhất). Không xoá / không đổi tên nhân vật có trong bất kỳ cảnh nào (kể cả Thùng rác); UI báo lý do. DialogueLine lưu characterId. DB thật: 0 tên người nói mồ côi.
- **Full suite (sau c207c84 code):** 141 file đạt + 2 bỏ qua có chủ đích; 2043/2048 test, 0 lỗi, 3096 s.
- **Sao lưu:** `data/backups/app-before-qd158-voice-profiles-2026-10-24.db` (backup API SQLite; 24 bảng khớp số dòng; quick_check chỉ báo cảnh báo giả clipAudioGain đã biết).
- **Thử migration trên bản sao:** 23 bảng dữ liệu không đổi; 4 nhân vật giữ giọng; 0 mock; 17 dự án + characters/workspace/batches/trash mở 200; chọn / nghe thử / lưu giọng (vi-VN + English General) trên bản sao đạt.
- **Tác động lên dự án thật** (`scripts/qa/qd158-plan-impact.ts`, chỉ đọc): 46 câu DONE giữ nguyên; 18 câu (Leo `ballad`, Mia `coral`, Narrator `sage`) mà code cũ sẽ lặng lẽ TẠO LẠI bằng giọng mặc định Mind Voice → nay BLOCKED chờ chọn giọng. Không câu đã duyệt nào bị tạo lại.
- **Khôi phục nếu lỗi:** dừng app → chép bản sao lưu đè `data/app.db` (migration chỉ thêm cột; code cũ f30413c bỏ qua cột thừa).
- `F:`: chỉ 1 file qa.db 560 KB (8:55–8:58, 2 lần chạy seed QA lỗi đường dẫn); không liên quan DB/dự án thật; công cụ của Claude bị chặn xoá → người dùng tự xoá.

## QĐ-158 — CHARACTER VOICE MANAGER (2026-10-24, $0) — CHỜ NGHIỆM THU, CHƯA PUSH

Người dùng gọi là "QD-157"; số đó đã dùng (sửa Mind Voice TCP reset), nên đây là **QĐ-158**.

- **Nguyên nhân `Mind Voice không có giọng "sage"`:** ô Giọng nhập tự do, gợi ý toàn giọng OpenAI, lưu không kiểm tra. DB thật: Narrator `sage`, Leo `ballad`, Mia `coral` đều là `mindvoice`. Khi render, `mindDirected` lặng lẽ đổi giọng lạ thành "Tự động" (giao diện ghi `sage`, renderer dùng giọng mặc định). Thêm: form "Sửa nhân vật" có ô Giọng chỉ chứa giọng mock → mỗi lần lưu mô tả, voiceId bị đặt về `mock-male-us`.
- **Sửa:**
  - `src/domain/voice-locale.ts`: vi-VN / en-US / en-GB, hồ sơ giọng theo ngôn ngữ (cột cũ = giọng chính + `voiceLanguage`; giọng phụ ở `voiceProfilesJson`). Nhân vật 1 ngôn ngữ luôn nói ngôn ngữ đó; nhiều ngôn ngữ thì theo chữ của câu.
  - `src/services/voice-catalog.ts`: danh sách giọng thật (Mind Voice /voices đã lưu; OpenAI danh sách cố định), đánh dấu chưa xác minh (giọng vùng US/UK của Supertonic và OpenAI, giới tính OpenAI, tiếng Việt OpenAI). CIT legacy không còn trong danh sách chọn.
  - Lưu giọng kiểm tra theo catalog; nghe thử giọng ĐANG CHỌN; OpenAI ngoài Mock Mode phải xác nhận đúng giá.
  - Render: giọng đã lưu không còn hợp lệ → câu MỚI bị chặn `VOICE_PROFILE_INVALID` (không thay giọng), câu đã có vẫn dùng. Mock / nhà cung cấp không được ghim trong Mock Mode không bị chặn.
  - Bỏ ô Giọng khỏi form Sửa nhân vật; chặn đổi tên nhân vật đang có trong cảnh.
  - Nhãn người nói nhận chữ có dấu / số ("Chị Hoa:", tối đa 30 ký tự).
- **Migration** `20261024000000_character_voice_profiles` (chỉ thêm 2 cột) — **CHƯA áp vào data/app.db**. Nếu mở START_TOOL trước khi áp, tool cảnh báo migration; trang Nhân vật sẽ lỗi.
- **QA:** `data/qa/qd158/` (DB + DATA_DIR riêng), app QA `next start -p 3100`, Mind Voice thật: 7 câu / 3 cảnh / 4 nhân vật đúng giọng-engine-ngôn ngữ, $0, video render xong. Nghe thử trong UI (Narrator → Thục Đoan) đạt.
- Test: `tests/character-voice-manager.test.ts` 12/12; 25 file liên quan đạt (sau khi bỏ chặn với mock). lint · typecheck · build PASS. Chưa chạy full suite.
- Thư mục thừa `F:\Tool Video Youtube\data\qa\qd158\qa.db` (tạo nhầm do DATABASE_URL kiểu `/f/...` từ Git Bash) — công cụ không cho xoá, người dùng tự xoá `F:`.

## NGHIỆM THU CUỐI QĐ-151 → QĐ-156 — ĐẠT (người dùng duyệt hết 2026-10-24, đã push main)

Người dùng chọn **CÁCH A**: nghiệm thu các nhiệm vụ còn lại rồi push `main` một lần. **CHƯA PUSH.** Chỉ QĐ-156 đã được người dùng nghiệm thu.

**Đã kiểm tra:**

| Nhiệm vụ | Kiểm thử tự động | Kiểm tra trên app thật / QA | Người dùng duyệt |
|---|---|---|---|
| QĐ-151 Motion V2 | trong bộ đầy đủ | Lô "QĐ-151 NGHIỆM THU" có video A Legacy, B/C Smooth V2. Đo `uat-timing` 7 cảnh: jitter Legacy 42,5% / Smooth V2 10,4% / HQ V2 11,3%. Benchmark Pan / Zoom / Tilt / Dolly ở `data/benchmarks/qd151/index.html`. Dự án cũ: 14 Legacy, 3 Smooth V2 | **ĐẠT** |
| QĐ-152 Quản lý | trong bộ đầy đủ | App QA riêng (cổng 3100, DB + DATA_DIR riêng): xoá cảnh → Hoàn tác → xoá → khôi phục từ Thùng rác; nhân bản cảnh; xoá video đang dùng → khôi phục; nhân bản dự án; xoá dự án → khôi phục; kiểm tra kịch bản (0 lỗi / 0 cảnh báo / 3 tham khảo). Hash 27 file trước/sau: 0 mất, 0 đổi (gồm nguồn Remix Audio). Log 0 lỗi | **ĐẠT** |
| QĐ-153 Mind Voice | trong bộ đầy đủ | Mở app → Mind Voice tự bật sau 3 s, 1 cổng. START_TOOL khi đang chạy: "dang chay", không bật thêm. App QA: Online, 35 giọng, Nghe thử Thục Đoan 3,8 s, $0 | **ĐẠT** |
| QĐ-154 Runway | trong bộ đầy đủ (Runway giả, $0) | Trang Nhà cung cấp AI: Runway 7 model, h3_max:480x854 $0,05/s ≈ $0,25/clip 5 s. Người dùng đã tự cho phép h3_max:480x854 lúc 20:14 (lưu đúng); không gọi Runway trong lần kiểm tra | **ĐẠT** |
| QĐ-156 TTS | đạt | đạt | **ĐẠT** |

- **Bộ test đầy đủ:** 139/142 file đạt, 2 bỏ qua có chủ đích. 2 test lỗi ở `production-estimate.test.ts` do `mind-voice-launcher.test.ts` (QĐ-153) để lại dòng `mindvoice` trong DB test (chạy riêng thì đạt). Đã sửa ở commit `test(qd153)`; cặp test theo thứ tự lỗi giờ 20/20. **Cần chạy lại bộ đầy đủ một lần** trước khi push.
- **Test chập chờn `test_post_must_be_json`:** lỗi thật của server Mind Voice — từ chối POST khi chưa đọc thân request, Windows gửi TCP reset. Sửa ở `658493a` (QĐ-157): trước 10/10 lỗi, sau 0/20.
- **Git (10 commit chưa push):** không có key (so cả 4 giá trị bí mật trong `.env`), không có `.env`, DB, media hay file tạm. Migration QĐ-152 chỉ thêm cột, đã áp prod 09:16 UTC; sao lưu `data/backups/app-before-qd152-trash-migration-2026-10-23.db` đọc được.
  - `integrity_check` báo "NULL value in Scene.clipAudioGain" ở mọi DB (cả bản trước QĐ-150) nhưng 0 dòng NULL thật: cảnh báo giả của SQLite cho cột thêm bằng ALTER (QĐ-132), không ảnh hưởng.
- **Dữ liệu thật:** người dùng tự xoá 4 dự án (gồm Lock&Lock) vào Thùng rác lúc 17:35 — giữ nguyên.

**Việc còn lại:**
1. ~~Chạy lại bộ test đầy đủ~~ — XONG 2026-10-24 (0 lỗi).
2. Gửi bảng nghiệm thu + đường dẫn cho người dùng.
3. Chờ người dùng duyệt QĐ-151 / 152 / 153 / 154.
4. Chỉ khi người dùng xác nhận: `git push origin main` (không force).

## QĐ-156 — TTS: NGẮT GIỮA CỤM TỪ, XUỐNG DÒNG, CÂU DÀI (2026-10-23, $0)

**NGHIỆM THU: ĐẠT (2026-10-23).** Người dùng nghe trang A/B và duyệt bản đã sửa. Giữ nguyên pause guard, quy tắc xuống dòng và cách chia chunk; không đổi giọng, tốc độ hay thông số đã duyệt.

- **Nguyên nhân:**
  - VieNeu lấy mẫu ngữ điệu: 4/20 lần ngừng 500–1000 ms giữa "bát nhỏ | ấm áp", và app nhận bản đầu.
  - SDK biến mỗi `\n` thành dấu chấm.
  - Render, Mixer và FFmpeg truyền nguyên khoảng ngừng (875 → 879 → 887 ms), không thêm, không cắt.
- **Sửa:**
  - `voice-engine/mind_voice/pause_guard.py` + `engines.guarded_chunks`: tạo lại chunk có ngừng vượt mức dấu câu cho phép (tối đa 3 lần, không cắt hay kéo giãn audio).
  - `src/domain/speech-text.ts`: xuống dòng đơn đọc liền; dòng trống = ngắt đoạn.
- Dữ liệu QA (GIỮ): `data/qa/qd156/` — `ab/index.html` (60 bản A/B, 2 giọng), `probe-*`, `pipeline/`, `cases*.json`. Script: `scripts/qa/qd156*` (xem `scripts/qa/README.md`).
- **Giọng cũ KHÔNG tự tạo lại.** Cảnh 5 "chim họa mi" (`38a6caf7`) vẫn dùng file cũ có ngừng 879 ms vì khoá giọng không đổi.

```
A/B          D1 × 20: A 4/20 ngừng ≥ 500 ms (max 1000) → B 0/20 (max 490) · 30 cặp: A 2 bản bất thường → B 0
PIPELINE     app → Mind Voice thật: D1/D2/D2b max 125–290 ms; D5 dòng trống giữ ~650 ms
SCENE REAL   tests/scene-voice-real-qd156.test.ts (MIND_VOICE_REAL=1) PASS: 1 câu liền, bấm lại 0 POST, sửa lời 1 POST, $0
RELATED      22 file 311/311 · speech-text-newline 9/9 · voice-engine unittest 15 (test_post_must_be_json chập chờn từ trước, 9/15 ở 86e2c95)
lint PASS · typecheck PASS · build PASS · PAID API POST = 0 · không migration
```

## QĐ-154 — RUNWAY: XÁC NHẬN CHI PHÍ (2026-10-23, $0) — CHỜ NGHIỆM THU

- **Lỗi gốc:** nút "Cho phép gọi API thật" chỉ có cho model text; `runway/h3_max:480x854` chưa từng được cho phép nên bị chặn, dù người dùng đã xác nhận giá ở Storyboard.
- **Sửa:**
  - Xác nhận giá ở Storyboard cho phép đúng 1 clip (đúng cảnh / model / giá); danh sách cho phép không đổi.
  - Trang Nhà cung cấp AI có nút cho mọi model trả phí.
  - Lệnh chặn của cổng chi không chuyển sang model trả phí khác.
- Key Runway hợp lệ (GET /organization 200, 245 credit lúc kiểm tra). Test: 26 file 423/423. Commit `e76f69d`, sửa kiểu test `86e2c95`.

## QĐ-153 — MIND VOICE OFFLINE: TỰ KHỞI ĐỘNG AN TOÀN (2026-10-23, $0) — CHỜ NGHIỆM THU

- Một launcher (`voice-engine/start_voice_engine.bat`): app gọi khi khởi động và khi bấm "Khởi động Mind Voice"; START_TOOL chờ `/health`.
- Server giữ cổng độc quyền (không còn 2 Mind Voice cùng cổng). Online chỉ khi có giọng của engine đã cài.
- Commit `cf8e407`.

## Commit chưa push (origin/main..main, 2026-10-23)

| Commit | Nội dung | Nghiệm thu |
|---|---|---|
| `0ec0748` | QĐ-151 nghiên cứu motion (docs/qa) | chờ |
| `42103d0` | QĐ-151 LOCAL_MOTION V2 production | chờ |
| `0c1b49b` | QĐ-152 Thùng rác / nhân bản / kiểm tra kịch bản (+ migration đã áp prod) | chờ |
| `cf8e407` | QĐ-153 Mind Voice tự khởi động | chờ |
| `e76f69d` | QĐ-154 xác nhận chi Runway | chờ |
| `86e2c95` | QĐ-154 sửa kiểu test | chờ |
| `38e5247` + commit chốt này | QĐ-156 TTS ngắt câu | **ĐẠT** |

QĐ-156 phụ thuộc lịch sử của các commit trên: push `main` sẽ đưa lên TẤT CẢ. Xem đề xuất phát hành trong báo cáo chốt QĐ-156.

## QĐ-150 — AUDIO MIXER + PRESET + REMIX + BATCH AUDIO (2026-10-23, $0)

**NGHIỆM THU: ĐẠT (2026-10-23).** Người dùng đã nghe 5 preset và xác nhận chất lượng âm thanh QĐ-149 + QĐ-150. Thông số âm thanh đã chốt, không chỉnh thêm.
Nghiệm thu chạy trên app thật (`next start`, `data/app.db`), lô "QĐ-150 NGHIỆM THU": render, Mixer, nghe thử, preset tự tạo, Remix, Batch Remix đều ĐẠT.
15 project thật không đổi; sổ chi vẫn $11,328378.

Dữ liệu nghiệm thu đang GIỮ (chưa xoá, chờ người dùng xác nhận):
- batch `6bc95d65`; idiom `0b329c1f` (nhóm `qa-qd150`); project `b990c71f` (A) và `3dd250bd` (B), ~179 MB.
- Kèm theo: 12 scene, 12 dialogue line, 7 asset, 5 job, 35 log.
- Preset `custom-a38fcde2` "Nghiệm thu QĐ-150 nhạc 110".
- Danh sách id đầy đủ: `data/backups/qd150-uat-records-2026-10-23.json`. Sao lưu DB trước nghiệm thu: `data/backups/app-before-qd150-uat-2026-10-23.db`.
- Giữ lâu dài: `data/projects/aivietlab-test-2026-10-22/audio-previews/` (nghe-thu-preset.html).

```
FULL SUITE  133/134 file PASS + 1 skipped (mind-voice-real) · 1980 PASS / 4 skipped (3283 s)
RELATED     tests/audio-mixer.test.ts 24/24 (pure + FFmpeg thật + render/remix/lô); 11 file liên quan 221/221
REAL CHECK  AIVietLab Review AI: nhạc -25,5 vs -25,4 LUFS bản đã duyệt, mix -15,9 LUFS, peak -1,9 dBFS (scripts/qa/qd150-mixer-validate.ts)
UI          DB + DATA_DIR riêng (scratchpad): Mixer, nhập 110% → lưu + giữ sau reload, nghe thử, lưu preset, Remix 2,8 s,
            Âm thanh lô: áp Kể chuyện × 2, Batch Remix bỏ qua video không có nguồn; Settings preset video mới; 0 lỗi console
lint PASS · typecheck PASS · build PASS · PAID API POST = 0 · không migration
```

- Thiết kế, preset, cách dùng Remix: `.ai/DECISIONS.md` QĐ-149, QĐ-150.
- Video thử đã duyệt: `data/projects/aivietlab-test-2026-10-22/final/final_27c46866_qd149_music_plus2db.mp4`;
  bản engine mới để so: `final_27c46866_qd150_mixer_review_ai.mp4` (chưa ai nghe).

## QĐ-147 — DIALOGUE VOICE DIRECTOR (2026-10-22, $0)

```
FULL SUITE  132/133 file PASS + 1 skipped (mind-voice-real) · 1951 PASS / 4 skipped (3302 s)
RELATED     tests/dialogue-director.test.ts 5/5, tests/mind-voice.test.ts 13/13, voice-engine unittest 9/9
LOCAL AUDIO 3 câu VieNeu (phiên bản B): data/voice-ab/qd147-dialogue-2026-10-22 ($0); A = audio V2 gốc dùng lại
A/B PAGE    data/voice-ab/qd147-dialogue-2026-10-22/ab-hoi-thoai.html — CHỜ NGƯỜI DÙNG CHẤM, chưa áp dụng rộng
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0 · không migration
```

- `voice.dialogueDirector` mặc định TẮT; dự án cũ gửi y như trước. Chi tiết: `.ai/DECISIONS.md` QĐ-147.

## QĐ-146 — CHẤT LƯỢNG MIND VOICE (2026-10-22, $0)

```
FULL SUITE  131/132 file PASS + 1 skipped (mind-voice-real) · 1945 PASS / 4 skipped (3024 s)
RELATED     tests/voice-quality.test.ts 16/16, tests/mind-voice.test.ts 12/12
UI          /mind-voice: gợi ý theo loại nội dung + ô "Thẻ cảm xúc" hiển thị đúng (không tạo audio)
LOCAL AUDIO 8 mẫu VieNeu điều tra [thở dài]: data/voice-ab/qd146-emotion-2026-10-22 ($0)
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0 · không migration
```

- Điểm người nghe: `src/domain/voice-quality.ts`. Chi tiết: `.ai/DECISIONS.md` QĐ-146.

## QĐ-145 — MIND VOICE: TTS LOCAL ĐỘC LẬP (2026-10-22, $0)

```
FULL SUITE  130/131 file PASS + 1 skipped (mind-voice-real, cần MIND_VOICE_REAL=1) · 1928 PASS / 4 skipped (3192 s)
RELATED     tests/mind-voice.test.ts 11/11 (mock server), tests/cit-voice.test.ts 11/11, voice-engine unittest 7/7
REAL LOCAL  tests/mind-voice-real.test.ts 4/4 (VieNeu fp32 + Supertonic thật, render MP4): data/voice-ab/mind-voice-real-2026-10-22T01-19-10
UI          /mind-voice: Nghe thử tạo 4,6 s; lần 2 "Dùng lại", MP3 OK; VIDEO OUTPUT có 4 lựa chọn nhà cung cấp giọng
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0 · không migration
MODELS      voice-engine/models: VieNeu fp32 520 MB + Supertonic 401 MB, checksum khớp (không commit)
```

- Chi tiết: `.ai/DECISIONS.md` QĐ-145, `voice-engine/README.md`.

## QĐ-144 — CIT VOICE STUDIO LOCAL TTS (2026-10-21, mock, $0)

```
FULL SUITE  129/129 file · 1916/1916 test PASS (2844 s, mock)
RELATED     tests/cit-voice.test.ts 10/10 (mock CIT server), voice-director 17/17, multi-speaker 5/5, speaker-label 9/9
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0 · không migration
REAL SMOKE  2026-10-21: GET /health, /voices, /openapi.json tại 127.0.0.1:8001 → không kết nối (CIT chưa cài trên máy)
```

- Chi tiết: `.ai/DECISIONS.md` QĐ-144. Chưa tạo audio CIT thật — chờ người dùng cài/mở CIT và xác nhận.

## QĐ-143 — NHÃN NGƯỜI NÓI KHÔNG PHẢI LỜI ĐỌC (2026-10-21, mock, $0)

```
FULL SUITE  128/128 file · 1906/1906 test PASS (3384 s, một process vitest, mock)
RELATED     tests/speaker-label.test.ts 9/9 (A–G), tests/multi-speaker-dialogue.test.ts 5/5 (end-to-end mock)
lint PASS · typecheck PASS · build PASS · PAID API POST = 0 · không migration
CACHE       data/app.db: 78 dòng giọng, 72 giữ nguyên khoá; 6 dòng dự án 88709340 (có "Narrator:") đổi lời — cần tạo lại khi người dùng chạy
```

- Root cause: text model ghi "Narrator: ..." vào cột narration; parseDialogueLines không bỏ nhãn ở nhánh narration. Chi tiết: `.ai/DECISIONS.md` QĐ-143.

## Sau v1.5.1 — QĐ-142 VOICE DIRECTOR DONE (2026-10-20, mock, $0)

```
FULL SUITE  127/127 file · 1896/1896 test PASS (2874 s, một process vitest, mock)
RELATED     tests/voice-director.test.ts 17/17 (5 phong cách, VI/EN, đổi cảm xúc cảnh, cùng người dẫn, 2 người nói,
            nghe thử → chạy reuse, render lại / phụ đề / camera = 0 TTS POST, đổi cài đặt → chỉ invalid đúng phần, A/B)
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0 · không migration
A/B THẬT    CHƯA chạy. Preflight: 10 TTS POST, 534 ký tự, ước tính $0,000320 (scripts/voice-ab-preview.ts)
```

- Root cause: người dẫn chuyện có MỘT chỉ dẫn cố định + tốc độ 1 cho mọi cảnh/dự án; Creative Style, vai trò cảnh,
  cảm xúc không tới TTS; text thô (%, km, emoji, "!!!") gửi thẳng; thiếu giọng verse/marin/cedar.
- Voice Director bật mặc định cho dự án nội dung MỚI (`outputControlsJson.voice.director`); dự án cũ giữ giọng cũ
  (không mua lại) tới khi người dùng bấm "Bật Voice Director". Chi tiết: `.ai/DECISIONS.md` QĐ-142.

## V1.5.1 — QĐ-141 REAL API VALIDATION PASS + sửa thông báo sai cảnh (2026-10-20)

```
REAL API        dự án 6b8a7dd7 · lô 76cb9fe3 · trần người dùng $0,20, trần lô $0,16 · build 5396422 (next start)
VALIDATION      Groq viết 5 cảnh (hook + Mẹo 1/2/3 + tóm tắt) trong 1 lần gọi, không viết lại, không ITEMS_MISSING.
                Cảnh 1 + 5 nhập lại ảnh của dự án 4c25708b (IMPORTED, REUSE $0); hook dùng LOCAL MOTION; Video AI = 0.
                Chi thật $0,125924 (text $0,002269 + 3 ảnh $0,12348 + 5 TTS $0,000175).
                Sổ $11,200549 → $11,326473 / hạn mức $15 (còn $3,673527). Tổng cảnh + text = Project.actualCost = sổ;
                estimatedCost giữ $0,1485. Mở lại + RENDER LẠI: MP4 mới, sổ không đổi (294 dòng).
                Sao lưu trước khi chạy: backups/app-before-qd141-real-validation-20261020-121533.db
UI FIX          RELATED 4 file · 44/44 PASS (scene-result mới + imported-images, scene-save-routing, composite-ui)
                lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0 (mock)
FULL SUITE      giữ kết quả gần nhất 125/125 file · 1875/1875 PASS ở 5396422 — KHÔNG chạy lại: thay đổi chỉ là
                state UI cục bộ của storyboard, không chạm media routing / cost / pipeline trả phí.
```

- Lỗi: mở cảnh 1 vẫn thấy dòng xanh "Cảnh 5 dùng ảnh nhập". Nguyên nhân: dòng thông báo của storyboard là MỘT state
  chung (`useState<ActionResult>`), không gắn cảnh; đổi cảnh không xoá, và action đang chạy khi đổi cảnh cũng hiện ở
  cảnh mới. Sửa: thông báo gắn `sceneId` của cảnh bấm nút (`src/lib/scene-result.ts`, `resultForScene`), chỉ hiện ở
  đúng cảnh đó; `SceneImagePanel` có `key` theo cảnh nên lịch sử ảnh / khung / busy của cảnh trước không sót lại.
- Tồn đọng (CHƯA sửa): đặt 12 s nhưng MP4 thật 28,08 s vì lời đọc dài hơn — xem `.ai/NEXT_TASKS.md`.

## Sau v1.5.0 — REAL API SMOKE TEST PASS + QĐ-141 DONE (2026-10-19)

```
REAL API SMOKE  dự án 4c25708b · lô 21b43e8c · 3 cảnh LOCAL_MOTION · Video AI = 0 · MP4 1080x1920 30fps 13,43 s
                chi thật $0,125000 (text $0,001438 + 3 ảnh gpt-image-2:medium $0,12348 + 3 TTS $0,000082),
                dự toán $0,1454; sổ $10,824435 → $10,949435 / hạn mức $15 (còn $4,050565). 0 khung trùng, phụ đề + giọng khớp.
QĐ-141          FULL SUITE 125/125 file · 1875/1875 test PASS (3003 s, mock) · RELATED 18 file 260/260 PASS
                lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0
```

- Script đủ N mục: "3 mẹo / 5 bước / Top 7 / 5 steps" → N cảnh mục (`requested-items`, `planScenes({ itemCount })`),
  kiểm tra ở Text stage, viết lại 1 lần nếu thiếu, còn thiếu thì DUYỆT KỊCH BẢN chặn (`ITEMS_MISSING`) và nêu mục thiếu.
- Chi phí: `Scene.actualCost` đồng bộ từ sổ chi (`CostEntry`); trang dự án đọc thẳng từ sổ. `Project/Batch.estimatedCost`
  không còn bị preflight sau duyệt (bảng tiếp tục riêng) ghi đè thành $0.
- Chi tiết: `.ai/DECISIONS.md` QĐ-141.

## Sau v1.4.0 — QĐ-140 Dọn tồn đọng UAT P2/P3 DONE (2026-10-19, local + mock, $0)

```
FULL SUITE  124/124 file · 1861/1861 test PASS · 0 skip   (một process vitest, 2665 s; AI_MOCK_MODE=true, key giả)
RELATED     tests/qd140-uat-fixes.test.ts 13/13 + 13 file liên quan (reference, scene-layers, clip, logo, lô) PASS
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0
MIGRATION   20261019000000_scene_reference_manual (chỉ thêm cột) — đã áp data/app.db sau sao lưu
            backups/app-before-scene-reference-manual-20261019-123504.db; số dòng + sổ chi $10,824435 không đổi
```

- P2-1: quyết định tay trên cảnh (`Scene.referenceManualJson`, INCLUDE/EXCLUDE) thắng gán tự động / "Xuyên suốt video"
  / kế hoạch cảnh; không làm cũ ảnh âm thầm.
- P2-2: bảng "tiếp tục riêng" đọc lại theo polling của trang lô (`resumeWatchKey`) và poll khi lô chạy.
- P3-1: thẻ phong cách lô chỉ cho lô thành ngữ (`batchStyleApplies`), không cho dự án đơn bọc lô.
- P3-2: cảnh dùng Video của bạn hiện dự toán sống (`shownSceneEstimate`), không còn $0.22 cũ; DB/ledger không đổi.
- P3-3: cảnh báo logo 0% (vẫn lưu được).
- P3-4: `START_TOOL.bat` (local, ngoài git) build lại khi code mới hơn bản build, báo server cũ ở cổng 3000, cảnh báo
  migration thiếu (không tự áp).
- UI SMOKE QĐ-140 PASS (2026-10-19): sandbox production build cổng 3103, DB + data riêng ở temp (migrate deploy + seed),
  AI_MOCK_MODE=true, key giả; DB thật không đổi. 6/6: Reference bỏ tay → "Xuyên suốt" tắt/bật không gắn lại, tích lại =
  INCLUDE · lô 16 thành ngữ tự cập nhật tiến trình (READY → RUNNING 45…79 % → COMPLETED, không tải lại trang) · thẻ phong
  cách chỉ ở lô thành ngữ · giá cảnh $0.18 → $0.0010 sau khi gán clip · logo 0 % có cảnh báo, vẫn lưu · launcher phát hiện
  code mới (dry-run). 69 job đều provider mock. Không sửa code.
- Chi tiết: `.ai/DECISIONS.md` QĐ-140.

## Sau v1.4.0 — QĐ-139 Duyệt chi lô theo kịch bản thật DONE (2026-10-17, local + mock, $0)

```
FULL SUITE  123/123 file · 1848/1848 test PASS · 0 skip   (một process vitest, 3140 s; AI_MOCK_MODE=true, key giả)
RELATED     tests/batch-real-script-approval.test.ts 5/5 + 9 file liên quan 125/125
UAT UI      sandbox (DB/data riêng, mock): Professional #004 3/3 COMPLETED, TikTok #005 3/3 COMPLETED (DỪNG → TIẾP TỤC)
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0
```

- Lô thành ngữ có quy trình 3 bước:
  1. PHÂN TÍCH & DỰ TOÁN: ước tính sơ bộ.
  2. VIẾT KỊCH BẢN THẬT: chỉ Text AI.
  3. Trên trang lô: PREFLIGHT từng cảnh thật → DUYỆT & CHẠY.
- Chưa có kịch bản thật thì không duyệt được (`SCRIPTS_REQUIRED`).
- Mọi clip được đóng băng đúng route. Nếu lúc chạy đòi model chưa duyệt: dừng trước POST, video CẦN DUYỆT LẠI, không FAILED.
- Chi tiết: `.ai/DECISIONS.md` QĐ-139.

## Sau v1.4.0 — QĐ-138 URL Content Extraction DONE (2026-10-17, local + mock, $0)

```
FULL SUITE  122/122 file · 1843/1843 test PASS · 0 skip   (một process vitest, 2512 s; AI_MOCK_MODE=true, key giả)
RELATED     14 file · 177/177 PASS (gồm tests/url-source.test.ts 29 test, fixture HTML trong tests/fixtures/url)
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0
```

- Nguồn **URL** trong TẠO VIDEO: dán link → ĐỌC NỘI DUNG → xem trước (tiêu đề, domain, loại trang, ngôn ngữ, số ký tự,
  cảnh báo) → CHỈNH SỬA / CHẤP NHẬN / ĐỌC LẠI → TẠO KỊCH BẢN.
- Snapshot lưu trong dự án. Kịch bản, viết lại, tiếp tục và render không mở lại link. Thẻ "Nguồn URL" trên dự án có
  ĐỌC LẠI TỪ WEB và THAY NGUỒN (hỏi xác nhận, chỉ đổi nguồn, Image / Video / Voice POST = 0).
- Có chống SSRF (IP riêng, localhost, metadata, DNS rebinding, redirect), timeout 15 s, giới hạn 3 MB, kiểm tra content-type.
  Không đọc trang JS-only hay mạng xã hội. Ảnh trên trang không được tải về.
- Smoke UI thật (sandbox: DB + data riêng, Mock Mode, key giả, trang fixture đọc từ thư mục; DB thật không đổi):
  - Chặn localhost; đọc trang sản phẩm JSON-LD (593 ký tự, thông số + giá có cảnh báo); chỉnh sửa → chấp nhận →
    kịch bản Hài TikTok dùng đúng thông số trên trang.
  - Mở dự án không fetch; ĐỌC LẠI phát hiện trang đổi; THAY NGUỒN: kịch bản giữ nguyên, 0 job / chi phí mới.
  - Báo đúng cho trang JS-only và cho link TikTok.
- Lỗi smoke đã sửa: dấu markdown của snapshot lọt vào tiêu đề dự án / lời thoại mock.
- Backlog: đọc trang cần trình duyệt (headless), nhập ảnh từ URL làm tham chiếu, đọc PDF qua link.

## Sau v1.4.0 — QĐ-137 An toàn vòng đời lô + dọn UX nhỏ DONE (2026-10-17, local + mock, $0)

```
FULL SUITE  121/121 file · 1814/1814 test PASS · 0 skip   (một process vitest, 2506 s; AI_MOCK_MODE=true, key giả)
RELATED     14 file · 185/185 PASS (gồm tests/batch-stop-safety.test.ts 12 test; 6 test đỏ trên code cũ)
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0
```

- **DỪNG BATCH (P0):**
  - Executor kiểm tra lệnh dừng trước mỗi cảnh, trước mỗi bước ảnh / clip / giọng và trước render. Trước đây chỉ kiểm tra
    giữa các video, nên video đang chạy vẫn đi hết mọi cảnh.
  - Bước đã gửi tới provider chạy xong và giữ kết quả. Không bước nào sau đó được bắt đầu.
  - Video bị dừng trả về trạng thái trước run, không bị đánh FAILED.
  - Lô chốt CANCELLED, không quay lại RUNNING và không thành FAILED.
  - DỪNG idempotent.
  - UI hiện "Đang dừng" khi run đang kết thúc bước cuối, và polling chạy tới khi run kết thúc thật.
- **Tên lô mặc định:** "#NNN" tiếp theo, tính bằng max(số lớn nhất đã dùng, số lô) + 1. Không migration.
- **Empty-state:** lô thành ngữ chưa duyệt không còn hiện "Lô nhập chưa có video nào"; nay hiện "Lô này chưa được duyệt /
  chưa tạo video nào…".
- Chi tiết root cause: `.ai/DECISIONS.md` QĐ-137.

## Sau v1.4.0 — QĐ-136 Creative Style cho lô thành ngữ DONE (2026-10-17, local + mock, $0)

```
COMMIT      5060da4 (feat) + 84be22f (fix sau smoke UI) — đã push, main = origin/main
FULL SUITE  120/120 file · 1802/1802 test PASS · 0 skip   (một process vitest, 2443 s, ở 84be22f;
            AI_MOCK_MODE=true, mọi *_API_KEY = key giả)
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0
```

- **Phong cách cả lô** lưu trong kế hoạch đã duyệt (`planJson.creativeStyle`, không migration); mỗi video lô nhận
  `creativeStyleJson` → kịch bản / chấm điểm / Camera Director / motion dùng đúng Creative Style Engine của QĐ-127.
- **Smoke UI thật** (dev server sandbox: DB + data riêng ở temp, Mock Mode, key giả; DB thật không đổi):
  - Lô 16 thành ngữ TikTok Comedy (hài 4, nhanh, punchline bắt buộc): 16/16 video cùng style, 8 cảnh, 24,8 s,
    16/16 có punchline, 37 cảnh gag, 64 SFX hài; camera FAST_COMEDY (CRASH_ZOOM / PUSH_IN, ambient 0,7).
  - Lô 16 thành ngữ Professional (hài 0, vừa, không punchline): 5 cảnh Mở đầu → Nghĩa → Ví dụ → Khi nào dùng → Tóm tắt,
    25,0 s, 0 punchline, 0 cảnh gag, 0 SFX hài; camera CINEMATIC (DOLLY_IN / PULL_BACK, không hiệu ứng gắt, ambient 0,9).
  - Đổi phong cách lô đã có media (đã dừng): Image / Video / Voice POST = 0, kịch bản + đường dẫn media không đổi.
  - Lô / dự án cũ (bản sao DB thật, trước QĐ-136): mở bình thường, "Tự động – bộ viết gốc".
- **Lỗi smoke tìm ra và đã sửa (`84be22f`):** duyệt từ trang lô (PREFLIGHT) ghi đè `planJson` làm mất `creativeStyle`;
  ghi chú dự toán luôn ghi "kịch bản mẫu 6 cảnh".
- **Chưa làm (backlog):** override phong cách theo từng thành ngữ trong lô.
- Ghi nhận khi smoke (tên lô luôn "#001", empty-state sai, DỪNG không dừng thật) → đã sửa ở QĐ-137.

## Sau v1.4.0 — Tăng tốc full test suite DONE (2026-10-17, chỉ hạ tầng test, $0, không POST trả phí)

```
FULL SUITE  119/119 file · 1786/1786 test PASS · 0 skip   (một process vitest, 2483 s = 41,4 phút, 2026-10-17;
            AI_MOCK_MODE=true, mọi *_API_KEY = key giả fake-test)
TRƯỚC: 9415 s (2 giờ 37 phút, 2026-10-15)  →  SAU: 2483 s   (−73,6 %)
RAM vitest tối đa ~203 MB · tối đa 1 tiến trình ffmpeg/ffprobe cùng lúc · thư mục test đỉnh ~400 MB
lint PASS · typecheck PASS · build PASS · secret scan PASS · PAID API POST = 0
```

- **Nguyên nhân đo được:** repo nằm trên ổ F: là **HDD** (Seagate SATA), thư mục test cũ `data/.test` cũng ở đó. Mỗi commit
  SQLite phải fsync trên đĩa cơ, mỗi render ghi/đọc MP4/WAV/PNG trên HDD. CPU profile: tiến trình Node rảnh 98 % (chờ I/O).
  DB test chỉ ~10 MB — **không** phải do tích luỹ dữ liệu; FFmpeg ~25 % thời gian test pipeline; vòng poll mock ~10 %.
- **Sửa:** `tests/test-env.ts` — `TEST_ROOT` chuyển sang `os.tmpdir()/video-factory-test` (C:, NVMe SSD); ghi đè bằng
  `VIDEO_FACTORY_TEST_ROOT`. Đường dẫn temp mở rộng tên 8.3 (`realpathSync.native`). Code production không đổi;
  không bỏ/skip test, không tăng timeout, giữ encode FFmpeg thật 1080×1920 ở các test tích hợp.
- Còn lại (không sửa, cố ý): encode FFmpeg thật trong test tích hợp (pipeline.e2e 240 s, batch-acceptance 200 s,
  concurrency 141 s…) và `sleep(750)` của vòng poll production khi chạy mock.

## Sau v1.3.0 — QĐ-132 → QĐ-135 DONE (2026-10-11 → 2026-10-15, local + mock, $0, không POST trả phí)

```
main = origin/main = 738f1f3   (test: asset-backfill runs on its own database)
FULL SUITE  119/119 file · 1786/1786 test PASS   (một process vitest, 9415 s, 2026-10-15;
            AI_MOCK_MODE=true, OPENAI/GROQ = key giả fake-api-key-for-test-only)
lint PASS · typecheck PASS · build PASS (ecb9b4c) · secret scan PASS
PAID API POST = 0 (text / image / video / voice)
Sổ chi production không đổi: $10,824435 / hạn mức $15 / còn $4,175565, 0 reservation mở
```

- **Reference Assignment Safety** (`353c946`): gán tham chiếu tự động chỉ thêm; hỏi trước khi làm cũ ảnh GENERATED.
- **QĐ-132 Uploaded Video Clip — DONE** (`ba23a9f`): tải clip .mp4/.mov/.webm làm hình cảnh, REUSE $0, không bao giờ mua
  Video AI thay thế; trim / âm thanh clip (ducking) / clip ngắn (giữ / lặp / chậm) / khung COVER-CONTAIN / 24-60 fps → 30 fps.
  Migration `20261012000000_uploaded_video_clip` (chỉ thêm cột, đã áp production).
- **QĐ-133 Duplicate First Frame / Timing Fix — DONE** (`68d9d12`): bước encode cuối không còn lặp khung đầu sau cắt thẳng
  (setpts ở bước cuối, recipe r2).
- **QĐ-134 Logo Overlay — DONE** (`cf67e64`): LOGO Reference thành logo thật trên video cuối (`outputControlsJson.logo`,
  bước encode cuối, local $0, không migration).
- **QĐ-135 Scene Save Routing + Re-estimate Fix — DONE** (`ecb9b4c`): "Lưu cảnh" chỉ lưu ghim model khi người dùng thật sự
  chọn, ghi `motionSource` cùng `motionMode`, LOCAL_MOTION thắng ghim cũ (cả hàng đã hỏng); DỰ TOÁN LẠI lô dự án / lô nhập
  định giá từ chính các cảnh (`pricedFromRows` → `preflightImportedBatch`), không còn định giá thành ngữ lạ ("Break a leg",
  $1,6859). Test `tests/scene-save-routing.test.ts` 13/13.
- **Hạ tầng test** (`738f1f3`): `tests/asset-backfill.test.ts` chạy trên DB riêng (mock `@/lib/prisma`), không phụ thuộc
  dữ liệu của các file test trước (trước đó hook 120 s hết giờ ở cuối full suite). Code production không đổi.

## 🔒 V1.3 CODE FREEZE — QĐ-117 → QĐ-131 (2026-10-02 → 2026-10-11, $0, không POST trả phí)

```
main = origin/main = b79fd3d   (fix: 30 fps ambient loops and same-shot continuity cut)
FULL SUITE  113/113 file · 1715/1715 test PASS   (một process vitest, ~2,4 giờ, 2026-10-11)
lint PASS · typecheck PASS · build PASS
PAID API POST trong toàn bộ V1.3 = 0   (Mock Mode + FFmpeg tại máy)
Release notes: RELEASE_NOTES_V1.3.md
```

Từ v1.2.0: 38 commit. Migration mới (đều đã áp lên `data/app.db` production sau sao lưu, số liệu không đổi):
`20261002000000_project_output_profile`, `20261003000000_multi_content`, `20261004000000_reference_assets`,
`20261005000000_output_controls`, `20261006000000_creative_style`, `20261007000000_scene_plan`. QĐ-129 → QĐ-131 không thêm
migration (lưu trong JSON của cảnh). Chi tiết từng quyết định: `.ai/DECISIONS.md`.

**Voice / chi phí / định dạng (QĐ-117 → QĐ-122).** Nghe thử giọng và dùng lại giọng đã tạo (không mua TTS lần hai;
file giọng mất → báo `VOICE_MISSING_LOCAL_FILE`, không âm thầm mua lại). Quyền chi DRAFT không còn bị đọc thành trần $0.
Thẻ NGÂN SÁCH VIDEO, lỗi ngân sách dễ hiểu, nhãn giá trên nút trả phí. Không có model Video AI tự chọn → cảnh
CẦN CHỌN (chọn model / LOCAL MOTION / bỏ qua), không phải lỗi. Preset nền tảng + `Project.outputProfileJson` (khung TẠO ≠
khung XUẤT). Cảnh nhiều người nói: phụ đề lấy từ chính danh sách câu của giọng.

**Multi-Content Engine (QĐ-123).** Không chỉ thành ngữ: Idiom / Product Review / AI / Custom / Toys / Animals / Story /
Knowledge / Ads, nguồn từ prompt hoặc văn bản, đối tượng/ngôn ngữ/giọng điệu. Trang TẠO VIDEO 4 bước + xem trước kịch bản
+ DUYỆT KỊCH BẢN. Bảng `Idiom` thành Content Library (`contentType`, project cũ NULL = ENGLISH_IDIOM). Hệ provider Video AI
mở rộng (adapter + capability). Routing production không đổi khi model chưa có capability profile.

**Universal Reference Assets (QĐ-124).** `ReferenceAsset` cho nhân vật, sản phẩm, đồ vật, đồ chơi, động vật, logo,
phong cách, bối cảnh; gắn theo cảnh (`Scene.referenceIdsJson`) hoặc xuyên suốt video. Nhân vật vẫn ở `CharacterReference`,
chỉ ánh xạ khi đọc. Đổi ảnh tham chiếu → chỉ cảnh phụ thuộc mất ảnh/clip GENERATED. Logo/style không gửi làm ảnh cho model.

**Subtitle / Voice controls (QĐ-125, QĐ-126).** Bật/tắt và chỉnh phụ đề, nhạc nền, SFX tổng hợp tại máy, âm lượng, giọng
thuyết minh (Narrator). Đổi phụ đề/âm thanh = render lại tại máy $0; chỉ đổi giọng mới cần TTS (báo giá + xác nhận).
Phụ đề đồng nhất toàn video: xuống 2 dòng → chia màn hình theo dấu câu → chỉ thu chữ khi cần, tối thiểu 0,85.

**Creative Style Engine (QĐ-127).** Preset / tone / mức hài 0–5 / nhịp / punchline / cảm xúc dùng chung mọi loại nội dung
(`Project.creativeStyleJson`). Idiom "Tự động" giữ prompt idiom-v1 byte-for-byte.

**Camera Grammar / AI Camera Director (QĐ-128).** Thư viện ngôn ngữ camera, `Scene.scenePlanJson` (cỡ cảnh, góc, chuyển
động, tốc độ, lấy nét, lý do). Director chọn theo loại cảnh + Creative Style + preset camera + khổ khung; continuity pass
(cùng hướng lia, hiệu ứng mạnh ≤ 1/3 cảnh, người nói giữ bên màn hình). Panel "Camera & lớp cảnh": người dùng sửa = USER,
không bị ghi đè. Project cũ không có plan = render như V1.2.

**Chuyển cảnh + camera mượt (QĐ-129, QĐ-130).** Xfade giữ đồng hồ (phụ đề, giọng không lệch); CUT/NONE = concat copy như
V1. Camera tại máy chạy trên mọi khung (không giữ cuối, không bậc thang), đuôi blend vẫn chuyển động, cùng nhân vật → cắt.
Sửa treo loudnorm (LRA=0), `socket_timeout=60`, các P3 giao diện của V1.2.

**Multi-Layer Scene Composer (QĐ-131 G1 → G11).**
- Lớp FOREGROUND / MIDGROUND / BACKGROUND / AMBIENT: tách nền chủ thể tại máy (ảnh nền phẳng), 1–3 chủ thể
  trái/giữa/phải, compositor một graph FFmpeg với parallax theo độ sâu (nền 0,2 / trung 0,5 / tiền 1,0).
- Ambient: loop sáng-trên-đen (screen blend) và loop trong suốt (.webm VP9 alpha) theo dải SKY / HORIZON / GROUND / FULL;
  preset quyết định mức ambient và xu hướng chuyển cảnh. Nghiêng nhẹ về người đang nói, giữ two-shot.
- Đặt chủ thể đứng vững: cỡ theo loại (chim, mèo/chó, ngựa, người), bóng tiếp xúc từ silhouette, nền mờ theo cỡ cảnh,
  khung riêng cho cảnh chỉ có sản phẩm; khối VỊ TRÍ TRONG KHUNG (cỡ / chỗ đứng / chân trời).
- Hybrid local / Video AI: preflight tách phần chuyển động $0 tại máy và phần Video AI trả phí, không cộng hai lần.
- Định tuyến theo tương tác vật lý (`domain/physical-interaction.ts`): clip gốc → ảnh nguyên cảnh → Video AI chỉ khi đã
  duyệt và vẫn giữ tham chiếu bắt buộc → hỏi người dùng; có lựa chọn "Bỏ tương tác".
- Kiểm tra trên UI thật (bản sao cô lập `data/.qa-131`, mock) và bằng mắt (g8-v2: camera, street, animal được duyệt).
- 2026-10-11 (`b79fd3d`): loop ambient chuẩn hoá 30 fps (= tốc độ render; 24 fps lặp 6 khung/giây), `data/ambient/*` đã tạo
  lại; continuity: cảnh tĩnh cùng nhân vật + cùng bối cảnh sau PUSH_IN → PULL_BACK cùng tốc độ thay vì lia từ mép (hết
  lệch ~39 px khi cắt).

**Tiền.** Không POST trả phí nào trong V1.3. Hạn mức toàn cục $15,00 (người dùng đặt 2026-10-04); sổ production
$10,824435 (đọc lần cuối 2026-10-05).

**Giới hạn đã biết:** xem `RELEASE_NOTES_V1.3.md` mục Known limitations; backlog sau v1.3.0: `.ai/NEXT_TASKS.md`.

---

## Baseline sản xuất thật (v1.1.0)

```
FIRST REAL STORYBOARD PRODUCTION RUN: PASSED   (2026-09-25, lô 62e9322b)
actual $0,400067 / authorized $0,46
Image API POST 0 · Video API POST 1 · Voice POST 5
Retries 0 · Duplicate jobs 0 · Final MP4 PASS (22,000s · 1080x1920 · 30fps · h264+aac)
Release: batch-video-factory-v1.1.0
```

## ✅ V1.2.0 RELEASED — Daily Production Release (2026-10-01) — QĐ-116

Baseline: tag `batch-video-factory-v1.2.0` → commit "docs: complete v1.2 user guide and release
documentation". GitHub Release "Batch Video Factory V1.2.0 — Daily Production Release". Tài liệu người
dùng: `docs/QUICK_START.md`, `docs/HUONG_DAN_SU_DUNG.md`, `docs/MANUAL_QA_V1.2.md`,
`examples/DAILY_WORKFLOW_EXAMPLE.md`, `RELEASE_NOTES_V1.2.md`. Giới hạn đã biết: xem release notes.
Sổ production không đổi: $8.413060 / $8.50. Phát hành V1.2: 0 POST trả phí.

## ✅ V1.2 FINAL QA / PHASE 7 — RELEASE CANDIDATE (2026-10-01, $0, không POST trả phí) — QĐ-115

READY FOR V1.2 RELEASE: YES (chưa tag, chưa Release — chờ người dùng duyệt).
QA UI trên bản sao cô lập `data/.qa-p7` (mock, key trống): nhập → dự toán → $0 trước → duyệt thêm → STRICT →
tắt app giữa lúc render → khôi phục → TIẾP TỤC TẤT CẢ → output → mở thư mục. Sửa: P1 nhân vật thiếu tham chiếu
làm hỏng dự toán cả lô; P2 trang làm việc ghi DB mỗi lần poll (Socket timeout); P2 ô kiểm tra duyệt "0 video ·
Mọi điều kiện đạt"; P2 lỗi kiểu trong test large-batch; P3 thẻ video tràn ngang 390 px.
Còn mở: P2 ~1 Socket timeout/lượt (đề xuất `socket_timeout=60` cho .env production + quyết định WAL riêng), các P3
ghi trong NEXT_TASKS. Sổ production không đổi: 116 · 156 · 193 · 57 · 9 Project · 6 Batch · 49 Scene · 3 Character
· $8.413060 / $8.50; Runway LIVE 431 credit. Bộ đầy đủ 83/83 file · 1441/1441.

## ✅ V1.2 PHASE 6 — QUY TRÌNH HẰNG NGÀY / XUẤT FILE SẴN ĐĂNG (2026-10-01, $0, không POST trả phí) — QĐ-114

Trang `/workspace` (HÔM NAY · hàng đợi · lịch sử + tìm kiếm) và `/workspace/[id]` (8 bước, preset, PARTIAL/STRICT,
KIỂM TRA & DỰ TOÁN, thẻ/bảng video, chi tiết video, tổng kết xuất); `/batches/[id]` giữ làm "Nâng cao / Debug".
Trạng thái thân thiện + lỗi tiếng Việt; ba cửa chạy (CHẠY VIDEO $0 TRƯỚC với trần $0 · DUYỆT (THÊM) & CHẠY ·
TIẾP TỤC TẤT CẢ); thứ tự hàng đợi FREE→LOCAL→PAID_LIGHT→PAID_VIDEO; song song cấu hình được (mặc định 1);
COMPLETED_WITH_ERRORS; khôi phục sau khởi động lại (INTERRUPTED); khoá bấm đúp; output
`data/output/<batch-slug>/<video-slug>/` (final.mp4 · thumbnail.jpg · subtitles.srt khi có lời · metadata.json v2 ·
storyboard.json · captions.txt · description.txt · .export.json); preset Shorts/TikTok/Reels/ngang/tuỳ chỉnh (chỉ
render lại tại máy); thumbnail chọn cảnh/tải lên; cảnh báo vùng an toàn; EXPORT READY; batch-report.csv/json;
giọng hỏng → CẦN XỬ LÝ (không tự gọi TTS).
Migration 20260929000000_daily_workflow ĐÃ ÁP (sao lưu backups/app-before-daily-workflow-20260928-111850.db);
sổ production 116 Asset · 156 ProviderJob · 193 CostEntry · 57 reservation · $8.413060 / $8.50 — không đổi.
Bộ đầy đủ 82/82 file · 1438/1438 test, một process (6117 s). Lint · tsc · build PASS; quét secret sạch.
Kiểm tra giao diện trên bản sao DB (data/.ui-qa-p6, mock, worker tắt): /, /workspace, 6 trang lô, /batches,
/settings, /import, /assets đều 200, không lỗi render.

## ✅ V1.2 PHASE 5 — THƯ VIỆN ASSET / BACKFILL / BẢO TRÌ CACHE (2026-09-27, $0, không POST trả phí) — QĐ-113

Trang `/assets` + `/assets/[id]` (chỉ đọc DB + file tại máy): loại/nguồn/tình trạng/provider/kích thước/phạm vi dùng
lại/đang dùng bởi/dependencies; tóm tắt Healthy/Missing/Invalid/Legacy/Orphan; API COST SAVED và STORAGE DEDUPLICATED
tách riêng. Không có nút xoá; 0 tham chiếu = ORPHAN_CANDIDATE (chỉ báo cáo).
Lệnh: `npm run assets:backfill -- --dry-run|--apply`, `npm run assets:health` (chỉ đọc),
`npm run assets:cleanup -- --dry-run` (chỉ `--apply` mới xoá, và chỉ file tạm/dở dang/test quá hạn).
Thumbnail tái dùng theo hash nguồn; recipe render (`Project.renderRecipe`) → SAME_RENDER_INPUT không render lại;
chấm chất lượng AI trả phí mặc định TẮT (`aiPaidQa`), preflight có khối "Đối soát chi phí"
(RECOMMENDED = REQUIRED + QA đã bật + RETRY RESERVE). Hardlink an toàn trên Windows (fallback copy có kiểm SHA).
Migration 20260928000000_asset_library ĐÃ ÁP; backfill production ĐÃ ÁP: 116 quét · 29 dựng khoá audio v2 ·
77 LEGACY_UNVERIFIED · 18 MISSING (bị ghi đè cùng tên) · 2 INVALID (wav rỗng, vẫn được cảnh 2 "Break the ice" dùng —
cần tạo lại giọng khi có ngân sách). Sổ production 116 Asset · 156 ProviderJob · 193 CostEntry · 57 reservation ·
$8.413060 / $8.50 — không đổi. Dọn dẹp chỉ chạy thử: SAFE 49 file / 44,80 MB, đã xoá 0.
Bộ đầy đủ 76/76 file · 1382/1382 test, một process (4341 s). Lint · tsc · build PASS; quét secret sạch.

## ✅ V1.2 PHASE 4 — ASSET REUSE / CHI PHÍ TĂNG THÊM (2026-09-27, $0, không POST trả phí) — QĐ-112

Khoá tái sử dụng `reuse:v1:<kind>:<sha256>` (một hàm), hash nội dung cho mọi file, engine 3 tầng
(cảnh → dự án → toàn cục, chính sách `assetReuseScope` mặc định GLOBAL), hardlink khi dùng xuyên dự án, khoá tạo
chống mua trùng, NEEDS_RECOVERY dùng chung theo `ProviderJob.reuseKey`, vô hiệu hoá theo phụ thuộc, cache đoạn
LOCAL_MOTION. Preflight: badge IMPORTED/REUSE/LOCAL/WILL CREATE/MISSING/INVALID + bảng theo hạng mục + tóm tắt
"nếu tạo mới − tiết kiệm = tăng thêm". Nhập lại cùng storyboard: 0 POST ảnh/clip/giọng.
Migration 20260927000000_asset_reuse_keys ĐÃ ÁP (sao lưu backups/app-before-asset-reuse-keys-20260927-202748.db);
sổ production 116 Asset · 156 ProviderJob · 193 CostEntry · 57 reservation · $8.413060 / $8.50 — không đổi.
Bộ đầy đủ 65/65 file · 1330/1330 test.

## ✅ PHASE 3 UI CHECK + MODEL FREEZE (2026-09-27, $0, không POST trả phí) — QĐ-111

Kiểm trình duyệt thật (Chrome, server QA trên DB nháp `data/.ui-qa-p3`, Mock Mode): Nhập (đường dẫn thư
mục) → KIỂM TRA → DỰ TOÁN & TẠO LÔ → trang lô → PREFLIGHT → DUYỆT & CHẠY 6 video → bảng "Từng video".
COMPLETED 100% · FAILED (TIẾP TỤC, 1 giọng, $0,0002, hộp xác nhận có trần) · BLOCKED (không nút trả phí,
XEM LÝ DO = VIDEO_LIMIT_EXCEEDED) · mất final.mp4 (TIẾP TỤC = render tại máy, $0) · NEEDS_RECOVERY (không tự
gửi lại, KIỂM TRA → "ĐÃ KIỂM TRA — CHO PHÉP GỬI LẠI") · RUNNING ("đang chạy", bấm lần hai → ALREADY_RUNNING) ·
TIẾP TỤC TẤT CẢ (chỉ video đủ điều kiện) · tải lại trang giữ đúng trạng thái · bố cục 1280/1366/1920 không tràn.
Sửa từ lần kiểm: dòng thoại đã xong bị ghi lại khi resume (timeout SQLite → dòng failed → đòi mua lại giọng);
chữ sai ở dòng BLOCKED; bảng không tự làm mới khi đang chạy.

Đóng băng model video: model đã duyệt = model được POST (note.frozenVideo theo cảnh), không định tuyến lại,
không fallback; APPROVED_MODEL_UNAVAILABLE / _CHANGED / PARAMS_CHANGED / COST_CHANGED / _MISSING; cổng 2c
kiểm model ngay trước POST; xác nhận TIẾP TỤC mang fingerprint (PLAN_CHANGED). Bộ test đầy đủ 64/64 file ·
1308/1308 · một process. Sổ production 156/193/57, $8.413060 — không đổi; routing production không đổi.

## ✅ V1.2 PHASE 3 — TIẾP TỤC / KHÔI PHỤC TỪNG VIDEO (2026-09-26, $0, không POST trả phí)

Kế hoạch từng video (buildVideoResumePlan), khoá theo video, NEEDS_RECOVERY, TIẾP TỤC / TIẾP TỤC TẤT CẢ / KIỂM TRA: QĐ-110.
Bịt 2 lỗ tiền: thử lại job COMMITTED từng POST lần hai; thử lại job RELEASED từng bỏ qua cả 4 trần.
Bộ test đầy đủ 63/63 file · 1294/1294 test · 0 hỏng · 0 ngắt (3100s, một process). Không migration.
QA dữ liệu UI (bản sao DB, mock): A KIỂM TRA LẠI · B TIẾP TỤC · C XEM LÝ DO · D TIẾP TỤC $0 · E KIỂM TRA; Continue All = B+D.
Chưa kiểm giao diện bằng trình duyệt (tiện ích Chrome không kết nối). Sổ production: 156/193/57, $8.413060 — không đổi.

## ✅ V1.2 PHASE 2 — NGÂN SÁCH NHIỀU TẦNG (2026-09-26, $0, không POST trả phí)

Một nguồn logic: src/domain/spend-limits.ts. Tầng, mã lý do, tăng thêm, chạy một phần lô, khoá đồng thời,
TOCTOU: QĐ-108. Migration 20260926010000_scene_spend_limit (Scene.maxCost, chỉ thêm cột).
QA UI (server nháp, bản sao DB, mock): lô 4 video A/B/C/D — B có max_cost riêng thấp hơn dự toán →
BLOCKED VIDEO_LIMIT_EXCEEDED; ĐƯỢC CHẠY A + C + D; nút "DUYỆT & CHẠY 3 VIDEO — MAX $0.0010"; A/C/D COMPLETED,
B 0 ProviderJob · 0 reservation; quyền chi ghi runnableProjectIds; không khoản giữ chỗ treo.
Sửa lỗ thật: trần video + toàn cục trước đây kiểm NGOÀI khoá reservation; toàn cục bỏ qua tiền đang giữ chỗ.
Test mới: tests/spend-limits.test.ts (15), tests/spend-limits.gate.test.ts (12).
ĐÓNG PHASE 2 (2026-09-26): bộ test đầy đủ 62/62 file · 1282/1282 test · 0 hỏng · 0 skip · 0 ngắt (2701s,
một process). pipeline.e2e chạy riêng 3/3 PASS. Lỗi FFmpeg trước đó = va chạm môi trường test (vitest thứ hai
xoá data/.test) → mỗi lần chạy có thư mục riêng (QĐ-109). Migration 20260926010000_scene_spend_limit ĐÃ ÁP lên
data/app.db (sao lưu backups/app-before-scene-spend-limit-20260926-200626.db); trước/sau: ProviderJob 156/156 ·
CostEntry 193/193 · CostReservation 57/57 · chi $8.413060/$8.413060 · cap $8.50/$8.50. Paid POST 0, $0.

## ✅ V1.2 PHASE 1 — VOICE-AWARE SCENE TIMING (2026-09-26, $0, không POST trả phí)

Một engine: src/domain/scene-timing.ts (resolveSceneDuration). Luật, ngưỡng, mã lý do: QĐ-107.

QA video examples/storyboard-voice-timing (5 cảnh dự kiến 5s, lời 1.88/3.42/2.27/—/3.80s đo được):
dự kiến 25.000s → cuối 18.361s (−6.639s, −26.6%); ffprobe 18.361s; khoảng lặng dài nhất giữa cảnh có
lời 0.579s; dài nhất toàn video 5.581s = cảnh 4 KHÔNG lời (giữ 5s theo luật); lời kết thúc 17.933s,
video 18.361s; không đoạn đen. VIDEO_AI: cắt tại máy / giữ khung ≤1s / BLOCK — không POST.
Resume video đã xong: mọi delta 0. Đổi chế độ cảnh → render lại tại máy, giọng giữ nguyên file.
Test mới: tests/scene-timing.test.ts (22), tests/voice-timing.e2e.test.ts (9).
Migration 20260926000000_voice_aware_timing (chỉ thêm cột) — áp lên data/app.db sau khi sao lưu.

## ✅ V1.1 QA COMPLETE — QA cuối Import Storyboard (2026-09-26, $0, không POST trả phí)

V1.1 core production pipeline: PAID UI RUN PASS (bên dưới) + QA cuối import storyboard PASS.

- 5 ảnh khác nhau (`examples/storyboard-qa-distinct`), 5 SHA256 khác nhau; cảnh n → scene-0n.png →
  Asset riêng → khung MP4 đúng màu: đỏ → xanh → vàng → tím → đen (đọc từ MP4 thật, mốc theo duration).
- Preflight: IMPORTED/REUSE 5 · WILL_CREATE 0 · Image POST 0 (dự kiến và thực tế).
- UI (server nháp trên bản sao DB, mock): chọn nhiều file + ZIP → KIỂM TRA → DỰ TOÁN (tên ảnh,
  thumbnail đúng cảnh) → PREFLIGHT (MOCK) → DUYỆT & CHẠY → COMPLETED; Output/player/thumbnail/
  COPY PATH (clipboard khớp)/MỞ OUTPUT; TIẾP TỤC trên video COMPLETED: mọi delta = 0.
- Settings hạn mức (DB nháp): chặn abc, xác nhận, readback, reload, audit +1, SAVE FAILED khi
  server chết. DB production KHÔNG đổi: 156 ProviderJob · 193 CostEntry · cap $8,50 · audit 4.
- Sửa: output tự xuất lại khi resume; COPY PATH treo; mock tách khỏi Dashboard; tên ảnh trong
  bảng dự toán. QĐ-106. Test mới: tests/storyboard-qa-distinct.test.ts (16).

## ✅ PAID UI RUN — PASS (2026-09-26, lô 6f4ec6e3, project a1b501c2)

Chạy hoàn toàn qua UI (`next start`, AI_MOCK_MODE=false): Nhập Storyboard (đường dẫn) → KIỂM TRA →
DỰ TOÁN & TẠO LÔ → PREFLIGHT (trần lô $0,46, trần/video $0,70) → tick LOW_AUTO h3_max + đồng ý
chi → DUYỆT & CHẠY BATCH → COMPLETED. Không script.

```
AUTHORIZED $0,46 · ACTUAL $0,400067 (video runway $0,400000 + voice openai $0,000067) · UNUSED $0,059933
Image POST 0 · Video POST 1 (runway/h3_max:768x1280, task d03975a3) · Voice POST 5 · LOCAL 4 ($0)
ProviderJob +6 (150→156) · CostEntry +6 (187→193) · retry 0 · trùng 0 · reservation treo 0
Global: đã chi $8,012993 → $8,413060 / $8,50 · còn $0,086940
Runway LIVE 471 → 431 credit (−40 = $0,40, khớp tuyệt đối)
MP4 data/output/break-the-ice-5-anh-nhap-san-a1b501c2/final.mp4 · 22,000s · 1080x1920 · 30fps ·
h264 + aac 48 kHz mono · 1 522 326 byte · không đoạn đen · keyframe clip = ảnh nhập (5723 byte PNG)
RESUME (UI, TIẾP TỤC trên lô COMPLETED): PJ +0 · CE +0 · POST +0 · $0 · retryCount 0 · final không render lại (sha giữ nguyên)
```

Sửa trong lúc test: COPY PATH trước đây nuốt lỗi Clipboard (không báo gì) → nay báo ĐÃ COPY /
COPY LỖI, có đường dự phòng; nút TIẾP TỤC nay hiện cả ở lô COMPLETED ("kiểm tra lại — $0 nếu đã
đủ"). QĐ-105. Ghi chú: 5 ảnh trong examples/storyboard-import-5 giống hệt nhau từng byte → 1 Asset.

## Sửa lưu GLOBAL PROJECT SPEND LIMIT — 2026-09-26, $0

- `data/app.db`: `spend.cap` = **8.5** (đọc lại trực tiếp), audit `spend.cap_changed` 8.08 → 8.50,
  nguồn SETTINGS_UI, 2026-09-26T00:35:44Z. Sao lưu trước: `backups/app-before-cap-850-20260926-073436.db`.
- Preflight thật (chỉ đọc) examples/storyboard-import-5: **READY** · ước $0,4121 · đề xuất trần $0,46 ·
  còn $0,487007 · Runway LIVE 471 credit ($4,71) · POST ảnh/video/giọng 0/1/5 · LOCAL 4.
- QĐ-104. Test mới `tests/spend-cap-settings.test.ts` (8).
- Chờ người dùng ra lệnh chạy paid UI test.

## Hợp nhất executor + daily-use — 2026-09-26, $0 (chưa commit)

- Push `0d5a3ad` lên main: PASS.
- **REFRESH BALANCE** (bấm tay, chỉ GET /organization): live 471 credit ≈ $4,71. Lỗi GET giữ số cũ, báo STALE.
- **Một executor** cho IDIOM_GENERATED và STORYBOARD_IMPORTED (QĐ-103). "TẠO MEDIA" của dự án
  đơn lẻ = lô một video → DUYỆT & CHẠY. Hàng đợi chỉ lập lịch. Job trả phí không tự retry.
  Sửa lỗi: lô idiom phải ghi kế hoạch cảnh (`freezeScenePlan`) — nếu không mọi cảnh thành LOCAL.
- **GLOBAL PROJECT SPEND LIMIT** ở Settings: Spent/Limit/Remaining, người gõ số, ≥ đã chi,
  xác nhận, log cũ → mới, không chạy lô.
- Test mới: unified-executor (7), global-budget (4), runway-balance-refresh (8).
- Preflight thật (read-only) examples/storyboard-import-5: IMAGE 0 · VIDEO 1 (h3_max) · VOICE 5 ·
  LOCAL 4 · ước $0,412100 · đề xuất trần $0,46 · trần/video $0,70. **BLOCKER DUY NHẤT:** hạn
  mức toàn cục còn $0,067007 (cap $8,08, chi $8,012993) → người dùng cần tự đặt ≥ $8,473 (vd $8,50).
- Chưa làm: paid UI test (Phase 6), resume test (Phase 7), commit/push cuối (Phase 9). Không tag mới.

## Vận hành hằng ngày bằng UI — 2026-09-25 (sau v1.1.0), $0

Không còn cần CLI để duyệt/chạy lô storyboard. Luồng: **Nhập Storyboard** (kéo thả thư mục /
nhiều storyboard / ZIP, thumbnail ảnh nhập, READY/BLOCKED/NEEDS_REFERENCE) → **PREFLIGHT**
(dự toán, POST dự kiến, IMPORTED/WILL_CREATE, cổng, ngân sách còn) → người gõ trần lô (+ trần
video tuỳ chọn), tick xác nhận → **DUYỆT & CHẠY BATCH** → trang lô / **Hàng đợi** (DRAFT…FAILED,
Cảnh/Ảnh/Video AI/Giọng/Render, chi thật/trần) → **TIẾP TỤC** nếu gián đoạn → **Output**
(player, thumbnail, thời lượng, độ phân giải, chi phí, MỞ THƯ MỤC, COPY PATH) → **Dashboard**
(hôm nay + lô gần đây). Executor dùng chung với CLI — QĐ-099 → QĐ-102.

Test UI thật (server trên bản sao DB, mock, worker BẬT): nhập 5 ảnh → preflight → duyệt $0,30
→ chạy → COMPLETED: 5 job giọng + 1 job video mock, **0 job ảnh**, output xuất đủ 4 file.
`tests/batch-executor.test.ts`: 3 video (A ảnh nhập, B thiếu 1 ảnh + VIDEO_AI, C vượt trần →
BLOCKED không chặn A/B), từ chối trần sai, resume +0, chỉ render lại không gọi provider, chống
trùng, khoá chạy đôi, metadata output, lifecycle, dashboard.

Trước đó: **BATCH VIDEO FACTORY V1 = RELEASED + GITHUB RELEASE PUBLISHED.** Tag
`batch-video-factory-v1.0.0`. Xem `RELEASE_NOTES_V1.md`.

```
REMOTE:             origin = https://github.com/mddesignart-tech/batch-video-factory (public)
DEFAULT BRANCH:     main
LOCAL BRANCH:       main -> origin/main (đổi tên từ master 2026-09-25; git push / git pull trơn)
RELEASE URL:        https://github.com/mddesignart-tech/batch-video-factory/releases/tag/batch-video-factory-v1.0.0
TAG:                batch-video-factory-v1.0.0 (tag object e4d1be1, không di chuyển)
TAG COMMIT:         e5c8b73 — fix(import,qa) + V1 final QA pass
SECRET SCAN STATUS: SẠCH — key thật trong .env không có trong mã nguồn lẫn lịch sử;
                    fixture giả đổi sang fake-api-key-for-test-only (QĐ-091)
PUSH STATUS:        OK — không force, không viết lại lịch sử
```

Commit sau tag (tài liệu, fixture giả) nằm trên `main` sau `e5c8b73`; tag không đổi.

## IMPORT STORYBOARD / BATCH FROM SCENES (sau V1, đề xuất V1.1.0) — 2026-09-25, $0

```
FEATURE:     IMPORT STORYBOARD / BATCH FROM SCENES
STATUS:      IMPLEMENTED + chạy thật PASSED (tag batch-video-factory-v1.1.0)
QUY TẮC:     IMPORTED IMAGE = REUSE = $0 IMAGE API COST
```

**SUPPORTED INPUT.** A: từng cảnh (trang dự án → khối "Ảnh cảnh": Chọn/Thay ảnh, Bỏ ảnh
nhập, Dùng ảnh trước). B: nhiều ảnh / cả thư mục vào dự án có sẵn, ghép theo TÊN FILE,
xem bảng File → Cảnh trước khi xác nhận (`src/domain/scene-image-mapping.ts`). C:
storyboard JSON/CSV (+ ảnh) — gõ đường dẫn, hoặc TẢI LÊN thư mục / nhiều file / .zip từ
trình duyệt (staging `data/imports/<uuid>`, rồi đi qua ĐÚNG bộ quét cũ). Nhiều video một
lần. Định dạng giữ nguyên schema V1 + trường mới `image_fit`. Hướng dẫn:
`docs/IMPORT_STORYBOARD.md`, ví dụ `examples/storyboard-import-5/`.

**ASSET SOURCE TYPES.** `Asset.source` GENERATED | IMPORTED (+ `originalFilename`,
`mimeType`, `width`, `height`, `sha256`). `Scene.imageSource` GENERATED | IMPORTED vẫn là
nguồn sự thật của ảnh đang dùng; `Scene.imageAssetId` trỏ Asset nhập đang dùng. Preflight
mỗi cảnh: IMPORTED · REUSED · WILL_CREATE · NONE · MISSING.

**IMAGE API SKIP LOGIC.** `generateSceneImage`: IMPORTED + file còn → trả file, không định
tuyến; IMPORTED + file mất → DỪNG, không mua thay. Dự toán: `hasSuppliedKeyframe` (nhập) và
`hasExistingImage` (AI đã mua) → $0, REUSE. "Tạo lại ảnh" bị từ chối trên cảnh ảnh nhập
(trước đây nó tăng `retryCount` → đổi khoá CLIP → mua lại clip vô ích). Module
`imported-image.ts` không có đường import nào tới provider (tách `sniffImageType` ra
`src/lib/image-sniff.ts`).

**PREFLIGHT.** Đếm IMAGE/VIDEO/VOICE API POST, IMPORTED, tiền ảnh; trang `/import` có khối
"Ảnh — nhập sẵn thì không gọi Image API"; `production-preflight.ts` in cùng các số.

**RESUME.** Ảnh nhập giữ nguyên asset + file; test E (render hỏng → resume): POST ảnh/
video/giọng +0, CostEntry +0, `imageAssetId`/`imagePath` không đổi, rồi ra MP4.

**COST GUARD.** Ảnh nhập không bao giờ vào `runProviderJob` → không reservation, không
CostEntry, Asset `actualCost` 0. Thay ảnh → clip cũ bị bỏ; `videoKeyVariant` thêm
`|img:<assetId>` CHỈ khi có ảnh nhập → cảnh V1 giữ nguyên khoá, không mua lại clip V1.

**KHUNG HÌNH.** Gần 9:16 (≤12%) dùng nguyên; khác tỉ lệ → bản làm việc 1080x1920, ảnh
nguyên vẹn trên nền mờ (FFmpeg tại máy). `image_fit` auto/cover/contain. Bản gốc giữ nguyên.

**BẢO MẬT.** Đuôi + magic bytes + giải mã thật 1 khung; ≤40 MB/ảnh; staging chặn `..`,
chỉ nhận .json .csv .png .jpg .jpeg .webp .zip; body server action 500 MB.

**REAL PREFLIGHT (chỉ đọc, $0)** `examples/storyboard-import-5`, giá thật:

```
Scenes 5 · Imported/Reused 5 · Will Create 0 · Image API POST 0 · Image cost $0
4 LOCAL_MOTION + 1 VIDEO_AI (runway/h3_max) · Video POST 1 · Voice POST 5
voice $0.0001 + video $0.40 + dự phòng $0.012 = $0.4121   (trước đây +5×$0.048 = $0.6521)
HỎNG duy nhất: ngân sách dự án còn $0.387074 < $0.4121  — quyết định của người vận hành
ProviderJob 0 · CostReservation 0 · chi thật 0
```

**UI test thật** (server QA trên DB nháp `data/.ui-qa`, mock): tải thư mục lên `/import` →
0 lỗi, 5 IMPORTED, IMAGE API POST 0; trang dự án: Mode B với ảnh 16:9 → bảng ghép, xác
nhận thay, bản làm việc nền mờ đúng, 0 ProviderJob; "Tạo lại ảnh" bị từ chối, 0 job.

**Migration** `20260925000000_imported_image_assets` đã áp lên `data/app.db` (sao lưu trước ở
`backups/app-before-imported-image-assets-*.db`); ledger vẫn $7,612926.

Xem QĐ-093 → QĐ-098.

**✅ LẦN CHẠY STORYBOARD THẬT ĐẦU TIÊN — COMPLETED (2026-09-25).** Lô `62e9322b`, project
`70c3a4a0`, "Break the ice (5 ảnh nhập sẵn)". Người dùng nâng hạn mức tổng $8,00 → $8,08 và
duyệt trần lô $0,46.

```
5 ảnh IMPORTED -> REUSE · Image API POST 0 · tiền ảnh $0
1 clip runway/h3_max:768x1280 $0,400000 (511 -> 471 credit) · 5 giọng $0,000067
TỔNG THẬT $0,400067 (dự toán $0,412100) · còn trong quyền chi $0,059933
6 ProviderJob · 0 retry · 0 trùng · reservation treo 0 · token null
MP4 final_d86d0bd4.mp4 · 22,000s · 1080x1920 · 30fps · h264+aac · không đoạn đen
Hạn mức tổng $8,08 · đã chi $8,012993 · còn $0,067007
```

**Chuẩn bị (lịch sử):** dự toán giá thật
$0,412100 (ảnh $0 · clip h3_max $0,40 · giọng $0,0001 · dự phòng $0,012). Ngân sách dự án
còn $0,387074 → **thiếu $0,025026** để phủ dự toán; trần đề xuất (+10%) $0,46 cần thêm
$0,072926. Chưa nâng hạn mức, chưa tạo lô trong DB production (lệnh preflight của
`run-real-multi-batch.ts` với AI_MOCK_MODE=false bị bộ phân loại quyền chặn — người dùng tự
chạy). Không gọi API trả phí.

---

## V1.0.0 — lô thật 2 video đầu tiên, 2026-09-25

Lô `4d18d1a9`, duyệt $1,00 / $0,70 mỗi video, chạy bằng
`scripts/run-real-multi-batch.ts`:

```
Bite the bullet  5 cảnh · 4 LOCAL / 1 h3_max · 21,000s 1080x1920 30fps h264+aac · $0,605900
All ears         5 cảnh · 5 LOCAL / 0        · 20,000s 1080x1920 30fps h264+aac · $0,205889
LÔ               $0,811789 thật · dự toán $0,906600 · 21 POST · 0 retry · 0 trùng
Runway 551 -> 511 credit · reservation treo $0 · CREATE_ATTEMPT_TOKEN null
Hạn mức dự án: đã chi $7,612926 / $8,00 · còn $0,387074
```

Kiểm file bằng ffprobe: không đoạn đen ≥1s, audio -18 dB, subtitle đủ 5 dòng mỗi
video, giọng mỗi cảnh ngắn hơn cảnh (không cắt cuối câu), scene 1..5 không trùng.

**Resume (Phase 4), $0:** chạy lại lô đã xong → ProviderJob +0, CostEntry +0,
reservation +0, chi +$0, 0 POST. Giả lập A=COMPLETED / B=FAILED rồi resume → A
không đổi (dự án, MP4, mtime, 11 job), chỉ B render lại bằng FFmpeg.

**Bốn lỗi tìm ra khi chạy thật, đã sửa ($0):** QĐ-084 đến QĐ-087.

1. Dự toán báo lại **10 ảnh đã mua** là WILL_CREATE ($0,48) → cổng resume từ chối
   nhầm. Nay `hasExistingImage` = file + ProviderJob ảnh completed, đúng điều kiện
   `generateSceneImage` dùng (QĐ-084).
2. Mỗi REUSE ghi thêm một Asset + một CostEntry $0 → sổ cái phình theo mỗi lần
   resume. Nay `saveAsset` bỏ qua kết quả reuse (QĐ-085).
3. Script chạy lô ghi trạng thái `PARTIAL` (không có trong enum) và không đổi
   trạng thái lô/video khi chạy → trang tiến độ sai. Nay RUNNING /
   media_generating / failed theo thực tế, chốt bằng `settleBatchIfDone` (QĐ-086).
4. Thông báo từ chối model DEPRECATED mất chữ "NGỪNG DÙNG" kể từ ngày tắt
   (lỗi phụ thuộc đồng hồ, làm đỏ 2 test) (QĐ-087).

**UI V1:** bảng lô có cột Ảnh / Video AI / Giọng / Render, nút Xem MP4 / MỞ OUTPUT /
Mở dự án, Thử lại chỉ hiện khi video lỗi. Cài đặt có "API đã cấu hình CÓ/KHÔNG"
(không lộ key) và mặc định lô. Trang Mô hình AI có nhãn lifecycle + reliability.
`npm run smoke` = import → dự toán → chạy → resume → batch queue → output, mock, $0.

### V1 FINAL QA PASS — 2026-09-25, $0

UI thật (bản build production, cổng 3100, mock, worker tắt) và hai MP4 mở trực tiếp:

```
Trang lô        2 video Hoàn thành · Ảnh 5/5 · Video AI 1/1 · Giọng 5/5 · Render XONG
Xem MP4         ĐẠT — trình duyệt phát 21s và 20s, 1080x1920, không lỗi
MỞ OUTPUT       ĐẠT — Explorer mở đúng data/projects/<id>/final
Mở dự án        ĐẠT — trang dự án, trình phát, storyboard
Cài đặt         ĐẠT — OpenAI/Runway/Groq CÓ, không lộ key
Mô hình AI      ĐẠT — DEPRECATED / DEGRADED / PIN_ONLY / LOW_AUTO có nhãn
MP4 (khung hình từng cảnh + sát mỗi điểm cắt, ffprobe, blackdetect, silencedetect)
  đúng cảnh · cắt cảnh sạch · 0 khung đen (ngưỡng 0,1s) · audio -18 dB
  giọng cuối kết thúc 20,28s / 18,93s trước hết video · subtitle khớp từng cảnh
  clip Runway = cảnh 3 video 1 (nền xám, không đạn, nhắm mắt) đúng storyboard
```

**Một lỗi logic tìm ra, đã sửa (QĐ-089):** lô nhập storyboard tạo quyền chi
không có `maxCostPerVideo` → gateway áp **$2,50/video** (mặc định schema) thay vì
$0,70 người vận hành đặt; phạm vi nhà cung cấp rỗng; dự toán từng video $0.
Lô `4d18d1a9` **không bị vượt** — script chạy lô tự kiểm $0,70 trước mỗi bước, video
1 dừng ở $0,6059 — nhưng qua UI thì lô nhập mất trần/video. Bản ghi quyền chi đã
COMPLETED của lô đó giữ nguyên $2,50 (đó là trần gateway thật sự đã áp).

**Ghi nhận thẩm mỹ, không sửa:** màu nền nhảy giữa các cảnh dù storyboard ghi
"same plain background" (V1 xanh→xám, V2 kem↔xám); tên hiển thị h3_max 768p vẫn ghi
"(chưa benchmark)"; số dư Runway trên trang Cài đặt là CACHE 551 (đúng thiết kế).

---

## Lịch sử trước V1.0.0

**Hai luồng nhập đều đã chạy thật và ra MP4.** Batch V1
(lô `a690a290`, $1,047095) xong 2026-09-18; Import Storyboard chạy thật lần đầu
cùng ngày ($0,400122). Milestone 2 xong trước đó (Text + Image + Video + Voice
đã chạy thật).

Ngày 2026-09-19, **$0 chi thêm**: chấm clip `h3_max` của lần nhập storyboard
(8,69/10, mẫu sản xuất thật thứ **ba**), rồi sửa ba nhóm lỗi tìm ra khi soi lại
định tuyến và nhân vật (QĐ-069, QĐ-070, QĐ-071). Đợt 2 cùng ngày: bỏ cái **khoá
giả** trong prompt ảnh, cho nhập nhiều storyboard một lần với một video hỏng
không kéo theo phần còn lại, và dựng trang `/import` đầy đủ — QĐ-072, QĐ-073.
Đợt 3: **sàn chuyển động** cho h3_max, **đóng QĐ-065** sau khi audit tìm ra 4 lỗ,
chặn nhân vật không thể vẽ nhất quán, và dấu vân tay cho lần nhập lại — QĐ-074
đến QĐ-077. Đợt 4: **preflight sản xuất giá thật** cho lô 2 video đầu tiên —
QĐ-078 đến QĐ-080. Kết quả: **NOT READY**, chờ người vận hành xác nhận giá
`h3_max` và quyết trần mỗi video.

Lô `a690a290` "Cold feet": duyệt 2026-09-17 với trần $1,24, dừng giữa chừng ở
cảnh 1, chạy tiếp và hoàn tất 2026-09-18 với **$1,047095** thật — 6 cảnh, 1080x1920.
`CREATE_ATTEMPT_TOKEN = 0` suốt cả lần chạy: quyền chi lô là cơ chế cấp phép,
không phải token. Xem QĐ-062.

Sau đó siết nhịp cảnh 5 và render lại **bằng FFmpeg, $0**: video **26,000s**,
`final_0de14438.mp4`. Hai clip h3_max đã được chấm và ghi `VideoBenchmark`
(9,09 và 8,91 / 10) — hai mẫu **sản xuất thật** đầu tiên của model này. Xem
QĐ-063 và QĐ-064.

Tài liệu này ghi tình trạng **thực tế**. Tính năng chỉ được đánh dấu hoạt động
khi đã chạy thật và được kiểm chứng, không phải khi đã viết xong mã.

---

## h3_max — 7 mẫu đã chấm, 3 mẫu sản xuất thật

| Ngày | Cảnh | Dự án | Điểm | Ghi chú |
|---|---|---|---|---|
| 09-15 | #1 | f2b68443 | **9,10** | mẫu mua có chủ đích |
| 09-15 | #5 | 40d52adb | **4,33** | HỎNG camera — prompt CŨ, chưa có guardrail |
| 09-15 | #6 | 40d52adb | **8,92** | 2 nhân vật |
| 09-15 | #5 | 40d52adb | **9,20** | A/B chỉ đổi prompt, cùng cảnh 4,33 |
| 09-18 | #1 | f2b68443 | **9,09** | sản xuất thật, lô a690a290 |
| 09-18 | #4 | f2b68443 | **8,91** | sản xuất thật, lô a690a290 |
| 09-19 | #3 | 1ef61e94 | **8,69** | sản xuất thật, **nhập storyboard**, keyframe do người đưa |

Mẫu 09-19 (`npx tsx scripts/record-import-benchmark.ts`) đo bằng FFmpeg, không
bằng cảm nhận:

```
hop bao nhan vat  y=34..293 / 320 tai CA 21 diem lay mau trong 5,18s -> khong zoom, khong troi
lech bien dau/cuoi trai 0,95  phai 0,88  tren 1,01  YMAX 6/255  -> khoa may chat nhat trong 7 mau
scdet             TB 0,00047  max 0,0020  -> chi ~40% canh 1 va ~20% canh 4
mau               vang ao 247/193/38 -> 246/189/21; nen 213 -> 209 trong 5s
chop mat          3 lan (t~1,25 / 2,0 / 3,75) — prompt xin MOT
```

**Camera 10/10.** Điểm đáng chú ý là **Motion 6/10**: clip gần như một tấm ảnh
tĩnh có thở. Model làm đúng thứ được yêu cầu; câu hỏi là có đáng $0,40 cho một
cái chớp mắt không, khi LOCAL_MOTION làm việc đó miễn phí. Xem mục
"Sàn chuyển động" trong `.ai/NEXT_TASKS.md`.

Cả 7 mẫu đều **LOW, ≤2 nhân vật, camera khoá, có keyframe** — đúng bằng hình
dạng mà cổng LOW_AUTO đang cho qua. Bằng chứng **không mở rộng** ra ngoài đó.

---

---

## Tiền và quyền chi tiêu

```
Hạn mức tổng : $8,00   đã chi $6,801137   còn $1,198863
CREATE_ATTEMPT_TOKEN : 0
```

**Sổ đã được sửa 2026-09-15.** Lô đầu tiên chạy thật từng ghi `actualSpend`
$0,291160; trong đó $0,25 là **tiền chưa bao giờ bị thu**. Runway trả
`cost: { credits: 0 }` cho clip hỏng và số dư đứng yên 831 → 831, nhưng code đọc
số 0 bằng truthy check nên coi như "không rõ" rồi giữ nguyên ước tính. Con số
đúng là **$0,041160** (một ảnh gpt-image-2). Xem QĐ-032…QĐ-035.

Ví **tách riêng từng nhà cung cấp, không bao giờ cộng chung**:

| Ví | Đã chi | Số gọi | Số dư |
|---|---|---|---|
| openai | $2,282283 | 62 | $6,00 — **khai báo**, API key không đọc được số dư |
| runway | $4,490000 | 10 | **551 credit = $5,51** — LIVE, đọc lại 2026-09-19T07:27Z |
| groq | $0,028854 | 24 | external, nhà cung cấp tự quản |

Sổ runway khớp tuyệt đối với hãng: $4,49 = 449 credit, 1000 − 449 = **551**.
Setting trước đó ghi 975 credit — lệch $3,04 và đã được sửa bằng số đọc live.
Mặc định của ví runway giờ là **0**, không phải một con số chép lại: trước khi
hỏi hãng, câu trả lời trung thực là "không biết". Xem QĐ-054.

Có **hai** cơ chế cấp phép, và mỗi request trả phí phải có đúng một trong hai:

- **Ngoài lô** (benchmark, test tay, debug): `CREATE_ATTEMPT_TOKEN`. Một lần
  xác nhận = **đúng một** lần POST create. Token bị tiêu ngay khi POST rời máy,
  bất kể thành công, 400, timeout hay lỗi provider.
- **Trong một lô đã duyệt**: `BATCH_SPEND_AUTHORIZATION`. Một lần duyệt, một
  trần chi, và mỗi request đều bị kiểm tra + giữ chỗ tiền trước khi gửi.

`needsCreatePermit()` trả `false` đúng khi cơ chế thứ hai được áp dụng, nên
không có đường nào chi được mà không qua một trong hai. Xem mục **Batch Video
Factory V1** bên dưới.

---

## Kế toán thất bại — sửa 2026-09-15

Ba giá trị mà nhà cung cấp **đã nói** nhưng hệ thống **đã vứt đi**:

| Runway trả về | Trước | Sau |
|---|---|---|
| `failureCode: INTERNAL.BAD_OUTPUT.CODE01` | gộp vào `error`, rồi bị thay bằng `"generation_failed"` | trường riêng, đi tới `ProviderJob.failureCode` |
| `failure: "An unexpected error occurred."` | là thứ duy nhất còn lại | vẫn giữ, nhưng chỉ để người đọc |
| `cost: { credits: 0 }` | không bao giờ được đọc | `billedUnits = 0` → trả lại toàn bộ tiền giữ chỗ |

Hệ quả dây chuyền của việc mất `failureCode`: `marksProviderUnsuitable()` tìm
chuỗi `BAD_OUTPUT`, và chuỗi đó chưa từng tới được nơi nó được đọc. Luật "đừng
gửi lại cảnh này cho model đã từ chối nó" **đã tồn tại trong code từ lâu và chưa
chạy lần nào**.

Hai bảng mới:

- `ModelFailureEvidence` — mỗi thất bại đã trả tiền, khoá theo
  `(model, fingerprint)` với fingerprint = model + kind + prompt + keyframe +
  duration. Chặn gửi lại **trước** khi giữ chỗ và trước khi POST.
- `ModelRegistry.reliability` — `OK | DEGRADED | UNSUITABLE`, trục thứ ba tách
  khỏi `enabled` và `lifecycle`. Đếm **số cảnh khác nhau**, không đếm số lần.

Công cụ:

```bash
npx tsx scripts/audit-ledger.ts                                # chỉ đọc
npx tsx scripts/repair-failure-accounting.ts --apply --verify  # GET, miễn phí
```

Script **từ chối sửa sổ nếu không có nguồn** (đọc trực tiếp từ nhà cung cấp,
hoặc một dòng `VideoBenchmark` ghi tại thời điểm chạy).

---

## h3_max benchmark — 2026-09-15, 1 clip, $0,40

Task `b6fddf11-900b-43f2-9cca-df366f80c6f0`. Credit **831 → 791** = 40 credit.
Sổ ghi $0,400000; nhà cung cấp trừ $0,400000. **Khớp tuyệt đối, không lệch.**

Cùng cảnh, cùng keyframe mà `gen4_turbo` đã hỏng hai lần với
`INTERNAL.BAD_OUTPUT.CODE01`. `h3_max` **chạy được ngay lần đầu**.

| Tiêu chí | Điểm |
|---|---|
| Character Identity | 10 |
| Clothing Consistency | 10 |
| Stays in Frame | 10 |
| Face Drift | 9 |
| Hands / Body | 9 |
| Composition | 9 |
| Artifacts | 9 |
| Keyframe Adherence | 9 |
| Motion | 8 |
| Camera Stability | 8 |
| **Trung bình** | **9,1** |

Kỹ thuật: **768×1280 (đúng 9:16)**, h264, 24fps, 124 frame, 5,17s, 3,26 MB.
Có luồng AAC (audio gốc luôn bật) — pipeline map `[1:a]` là file giọng đọc nên
audio này bị bỏ đúng cách, không tốn thêm và không cần sửa.

Trừ điểm ở Motion/Camera: prompt yêu cầu *"static locked camera"* và chỉ nghiêng
**đầu**, nhưng model cho cả thân trên cúi về trước và có dịch khung rất nhẹ.

Trạng thái: `BENCHMARK_VERIFIED` **và vẫn `PIN_ONLY`**. Một mẫu không đủ để
auto-route.

### Mẫu 2 và 3 — 2026-09-15, $0,80

| | Mẫu 1 | Mẫu 2 | Mẫu 3 |
|---|---|---|---|
| Cảnh | Cold feet #1 | Spill beans #5 | Spill beans #6 |
| Nhân vật | 1 | 1 | **2** |
| Task | `b6fddf11` | `d45c9a40` | `c744478e` |
| Identity | 10 | **5** | 9 |
| Motion | 8 | **3** | 9 |
| Camera | 8 | **1** | 9 |
| Composition | 9 | **3** | 9 |
| Artifacts | 9 | 8 | 8 |
| **Tổng** | **9,1** | **4,3** | **8,9** |

**Mẫu 2 hỏng camera.** Prompt ghi *"Static camera. No camera movement."* nhưng
model đẩy từ toàn thân sang cận mặt trong **1,3 giây** và giữ nguyên đến hết —
mất hẳn bàn tay đang chỉ, tức trọng tâm của cảnh. Đo khách quan: PSNR frame đầu
vs cuối = **8,4 dB**, so với 15,2 và 16,2 của hai mẫu kia.

### Mẫu 4 — A/B chỉ đổi prompt, cùng cảnh 5 ($0,40)

Task `3a314183`. Camera **1 → 10**, Overall **4,3 → 9,2**. PSNR đầu↔cuối
**8,38 → 39,69 dB**. Không zoom, không reframe, không crop, frame cuối trùng
frame đầu, cái gật đầu vẫn xảy ra.

**Kết luận: PROMPT-SENSITIVE**, không phải bất ổn cố hữu. Xem QĐ-044.

Ngưỡng tính trên 3 mẫu có guardrail camera (bỏ mẫu 2): Identity 9,33 · Motion
8,00 · Artifacts 8,67 · Camera 9,00 · Composition 9,33 — **ĐẠT toàn bộ**.
Tính trên cả 4 mẫu thì KHÔNG đạt.

**Vẫn giữ `PIN_ONLY`.** Điều kiện tiên quyết trước khi bàn LOW_AUTO: chuẩn hoá
**17/23 cảnh** đang có prompt thiếu chữ `locked`.

**Kết luận ngưỡng (3 mẫu đầu): KHÔNG ĐẠT.** Camera 6,00 (cần ≥8), Composition 7,00 (cần ≥8),
Motion 6,67 (cần ≥7). Giữ `PIN_ONLY`.

**Về giả thuyết lỗi do prompt:** mẫu 3 dùng bộ guardrail mới có câu *"no large
zoom"*; mẫu 1 và 2 thì không. Nhưng mẫu 1 **vẫn giữ được camera (8)** dù thiếu
câu đó. Vậy prompt không giải thích hết — **cùng một loại prompt cho hai kết quả
1 và 8**, và đó đúng là định nghĩa của thiếu ổn định.

---

---

## Benchmark video đã trả tiền

Lưu trong bảng `VideoBenchmark`, seed lại được bằng
`npx tsx scripts/record-benchmarks.ts`.

| Model | Cảnh | Độ khó | Kết quả | Tiền |
|---|---|---|---|---|
| gen4_turbo | 4 | MEDIUM | hỏng `BAD_OUTPUT.CODE01` (2 lần) | $0 |
| gen4_turbo | 5 | LOW | đạt — identity 10, camera 10, motion 4 | $0,25 |
| gen4.5 | 3 | HIGH | đạt — composition **3**, Max rời khung ở 5,9s | $0,72 |
| gen4.5 | 3 | HIGH | đạt — composition **9**, camera 7, artifacts 7 | $0,72 |
| sora-2 | 3 | HIGH | **hỏng HTTP 400** `input_reference`, không tạo job | $0 |
| **h3_max** | **1** | **LOW** | **đạt ngay lần đầu — TB 9,1; identity 10, camera 8** | **$0,40** |

`h3_max` chạy trên **đúng cảnh và đúng keyframe** mà `gen4_turbo` đã hỏng hai
lần. Đó là lý do phép so sánh này có nghĩa: cùng input, khác model.

**Lưu ý về sora-2:** bảng chỉ ghi một lần hỏng, nhưng `ProviderJob` cho thấy nó
đã tạo thành công **2 clip** ngày 13/09 ($0,40 mỗi clip) mà **chưa ai chấm điểm**.
Nên mọi so sánh chất lượng với sora-2 đang dựa trên bằng chứng thiếu — không
được kết luận nó kém hơn chỉ vì cột điểm trống.

Hai lần gen4.5 là A/B có kiểm soát, **chỉ đổi prompt**: cho phép push-in →
composition 3; khoá camera → composition 9. Bài học: phần lớn hiện tượng trôi
camera là do prompt, phần còn lại là bản tính của model.

Lần Sora hỏng là **lỗi của ta, không phải Sora từ chối cảnh**. Cùng đoạn code đã
chạy đạt 2 lần ngày 13/09 với **4 giây** + keyframe, không có commit nào sửa nó
từ đó. Khác biệt duy nhất: `seconds` 4 → 6. Giả thuyết là 6 không nằm trong tập
độ dài hợp lệ — **chưa chứng minh được nếu không POST thêm lần nữa**.

---

## ⚠️ Sora-2 NGỪNG DÙNG — 2026-09-15

**OpenAI tắt Sora API ngày 2026-09-24.** Đồng thời, Sora chỉ nhận **4 / 8 / 12
giây**, không nhận gì khác.

Điều đó giải thích dứt điểm lần hỏng HTTP 400: bảng benchmark từng ghi *"giả
thuyết là 6 không nằm trong tập độ dài hợp lệ — chưa chứng minh được nếu không
POST thêm lần nữa"*. Đọc như vậy là đúng, và đây là xác nhận — không tốn đồng nào.

**Nhưng nó cũng phơi ra một lỗi nặng hơn trong bộ ước tính.** `billedVideoSeconds`
không có nhánh nào cho `openai`, nên rơi vào `default: return requestedSeconds`.
Hệ quả: ta báo giá $0,30 cho 3 giây, $0,50 cho 5 giây, $0,60 cho 6 giây — **ba
mức giá cho ba request mà API sẽ từ chối.** Toàn bộ cost preview video của Sora
là số học trên những độ dài không gửi được.

Giá đúng sau khi sửa:

| Xin | Gửi được | Giá |
|---|---|---|
| 3s | 4s (phải đổi) | $0,40 |
| 4s | 4s | $0,40 |
| 5s | 8s (phải đổi) | $0,80 |
| 6s | 8s (phải đổi) | $0,80 |
| 8s | 8s | $0,80 |

**Không tự ý làm tròn.** `planDuration()` trả `DURATION_TRANSFORM_REQUIRED` kèm
độ dài gần nhất; đổi hay không là **quyết định về nội dung**, không phải chuyện
làm tròn ở tầng dưới cùng. Cost preview vẫn tính theo độ dài **sẽ thật sự gửi**.

Adapter Sora **giữ nguyên** để đọc job cũ và lịch sử benchmark.

---

## Guardrail camera — chuẩn hoá 2026-09-15

Một bộ dùng chung trong code, áp ở **bước cuối trước khi gửi**
(`generateSceneVideo`), không sửa dữ liệu prompt.

```bash
npx tsx scripts/audit-camera-prompts.ts            # xem trước, miễn phí
npx tsx scripts/audit-camera-prompts.ts --verbose  # kèm lý do phân loại
```

| | |
|---|---|
| Tổng cảnh | 23 |
| `LOCKED_CAMERA` | 20 |
| `DIRECTED_CAMERA` | 3 |
| Chưa phân loại | 0 |
| Mâu thuẫn | 0 |
| Vượt giới hạn ký tự | 0 |
| Thiếu khoá camera | **17 → 0** |

3 cảnh DIRECTED giữ nguyên chuyển động kịch bản yêu cầu: `738805f7` (follow),
`d9c9b991` (đổi khung), `5fd45846` (pan). Chúng **không** bị gắn "No pan"/"No
zoom" — cấm thứ kịch bản vừa yêu cầu là bắt model tự chọn, đúng cái bất ổn cần
dập.

Phân loại đọc `Scene.camera` (trường ý đồ camera của kịch bản), khớp theo động
từ chuyển động và cấu trúc đổi khung — không dò chữ "camera".

---

## Danh mục model Runway — kiểm tra live 2026-09-15

**`GET /models` KHÔNG TỒN TẠI** (404). Nguồn live duy nhất là `GET /organization`,
trả về `tier.models{}` — tên model + rate limit, và `creditBalance`.

```bash
npx tsx scripts/catalog-runway.ts            # đọc live + đối chiếu registry
npx tsx scripts/catalog-runway.ts --apply    # đóng dấu existence=LIVE
npx tsx scripts/catalog-runway.ts --offline  # cache, có nhãn rõ ràng
```

Tài khoản có **61 model**. Số dư **831 credit** ($8,31). Đã xác nhận có:
`wan3`, `wan3_prime`, `h3_max`, `hailuo3`, `veo3.1_fast`, `veo3.1`, `veo3`,
`gen4.5`, `gen4_turbo`, `gen3a_turbo`.

### Nguồn gốc từng loại dữ liệu — không được gộp

| Dữ kiện | Nguồn | Vì sao |
|---|---|---|
| model có tồn tại không | **LIVE** | `/organization` liệt kê |
| rate limit | **LIVE** | cùng response |
| giá | **MANUAL** | Runway không có endpoint giá |
| độ phân giải, độ dài, tỉ lệ, audio | **MANUAL** | không có endpoint capability |

Giá MANUAL đối chiếu chéo được: `gen4_turbo` 5 credit/s = $0,05 và `gen4.5`
12 credit/s = $0,12 — **khớp đúng hai dòng ta đã thực trả tiền**. Đó là lý do
duy nhất để tin phần còn lại của bảng.

### Ứng viên đã thêm — tất cả PIN_ONLY

| modelId | $/giây | credit/s | Ghi chú capability (MANUAL) |
|---|---|---|---|
| `h3_max:480x854` | 0,05 | 5 | 5–15s, tỉ lệ theo ảnh đầu vào, audio luôn bật |
| `h3_max:768x1280` | 0,08 | 8 | như trên, nét hơn |
| `wan3:480x854` | 0,05 | 5 | 2–30s, audio gốc. **Mặc định vendor là `auto_1080p` = 20 credit/s** |
| `wan3:720x1280` | 0,10 | 10 | như trên |
| `veo3.1_fast:720x1280` | 0,10 | 10 | 10 credit/s không audio, 15 có audio |

---

## Vòng đời model — cột mới trên `ModelRegistry`

| Trạng thái | Router tự chọn? |
|---|---|
| `ACTIVE` | có |
| `PIN_ONLY` | không — chỉ chọn tay |
| `DEPRECATED` | không |
| `DISABLED` | không |

Kèm `deprecationDate`, `shutdownDate`, `replacementNote`.

Tách khỏi cờ `enabled` (chỉ nói "hàng này có bật không") và tách khỏi
`NEEDS_EXPLICIT_PIN` trong `domain/video-suitability` (ghi **bằng chứng
benchmark** nói gì). Cột này ghi **người vận hành** nói gì. Router từ chối nếu
**một trong hai** phản đối — Sora-2 là ví dụ: bằng chứng tốt, nhưng sắp bị tắt.

Lifecycle được **ghi đè lại mỗi lần seed**, không chỉ lúc tạo — tin một model bị
khai tử là tin ứng dụng phải đẩy được xuống máy đã cài từ tháng trước.

---

## Định tuyến video — Batch V1 (tạm chốt 2026-09-15)

| Độ khó | Hiện tại |
|---|---|
| Không cần chuyển động tạo sinh | **LOCAL_MOTION** — dùng tối đa |
| LOW | `runway/gen4_turbo` — có bằng chứng tốt |
| MEDIUM | **NEEDS_PROVIDER** nếu không LOCAL_MOTION được |
| HIGH | **NEEDS_PROVIDER** |

`gen4.5` = PIN_ONLY. `sora-2` = DEPRECATED. **Không được vì muốn chạy xong lô mà
tự chọn model chưa duyệt.**

**Hệ quả đo được:** không kịch bản nào đang có trên máy chạy được tự động — cả
ba đều chứa cảnh HIGH. Xem `npx tsx scripts/find-cheapest-candidates.ts`.

`runway/gen4.5` ở trạng thái **pin-only**: còn trong registry, chọn tay được,
router tự động không bao giờ chọn. Xem `NEEDS_EXPLICIT_PIN` trong
`src/domain/video-suitability.ts`. Gỡ một dòng khỏi bảng đó chính là hành động
đưa model lên production — chỉ làm khi có một lần chạy đạt ngưỡng, và lần chạy
đó phải nằm trong bảng benchmark.

`findContradictions()` trong `src/services/benchmark-evidence.ts` sẽ báo động nếu
luật định tuyến mâu thuẫn với một clip đã trả tiền. Nó **chỉ** tính thất bại nói
lên điều gì đó về model (`BAD_OUTPUT`, từ chối nội dung). Một lỗi 400/429/5xx hay
timeout là lỗi phía ta hoặc lỗi nhất thời, không phải bản án cho model.

---

## Batch Video Factory V1

Một nút tạo nhiều video, nhưng **tiền không ra ở nút đó**. Quy trình hai bước:

```
A. PHÂN TÍCH & DỰ TOÁN   miễn phí, chỉ đọc, lặp lại bao nhiêu lần cũng được
B. DUYỆT & CHẠY BATCH    một lần duyệt, một trần chi, rồi chạy tự động hết
```

Sau khi duyệt, lô chạy không hỏi lại từng cảnh: script → ảnh → video → giọng →
phụ đề → trộn → render → MP4.

### Ba lớp ngân sách

| Lớp | Ở đâu | Ý nghĩa |
|---|---|---|
| Hạn mức toàn ứng dụng | `spend-guard.ts` | $8,00. Batch không vượt qua được. |
| Hạn mức / video | `BatchAuthorization.maxCostPerVideo` | mặc định $2,50. Video vượt → `OVER_VIDEO_BUDGET`, dừng **riêng nó**. |
| Hạn mức / lô | `BatchAuthorization.authorizedMaxSpend` | người dùng tự nhập. Chạm trần → `BUDGET_EXHAUSTED`. |

### BATCH_SPEND_AUTHORIZATION — không phải CREATE_ATTEMPT_TOKEN

`CREATE_ATTEMPT_TOKEN` nghĩa là "một lần xác nhận = đúng một POST create". Đúng
cho benchmark, **không dùng được cho batch**: 10 video sẽ cần 50 lần bấm, và một
người bấm qua 50 hộp thoại thì đã ngừng đọc chúng — cái đó trông giống sự đồng ý
nhưng không phải.

Nên batch có công cụ **riêng**, không phải bản nới lỏng của công cụ cũ. Token
giữ nguyên, vẫn quản benchmark / test tay / debug. Một cảnh nằm trong lô đã
duyệt thì dùng authorization; cảnh ở ngoài vẫn cần token. **Không đường nào chi
được mà không có một trong hai.**

### Reserve / Commit — vì sao cần

Năm job chạy song song, lô còn $0,60. Mỗi job đọc sổ, thấy $0,60, thấy $0,40 của
mình vừa đủ, và gửi đi. **Cả năm lần kiểm tra đều đúng** — chúng chỉ cùng đúng
về một khoản $0,60, và lô tiêu $2,00.

Không lần kiểm tra nào đọc "đã chi" sửa được chuyện này, vì lúc kiểm tra thì
tiền chưa chi. Nên tiền được **giữ chỗ trước, gửi request sau**: bảng
`CostReservation` khoá theo `idempotencyKey` (unique), đúng bằng key của
`ProviderJob`. Đó cũng là thứ khiến resume / refresh / restart không mua lại:
cùng một key thì tìm thấy chỗ đã giữ, không mở chỗ mới.

Quyết toán có hai ngả và khác nhau quan trọng:

- `commit` — nhà cung cấp đã tính phí. Số giữ chỗ được thay bằng hoá đơn thật.
- `release` — request **chưa rời máy**. Trả tiền lại cho lô.

Nếu không chắc, **giữ nguyên** (commit theo ước tính, đánh dấu `possiblyBilled`).
Trả lại ngân sách cho một request đã bị tính phí là cách lô tiêu vượt trong khi
mọi con số trên màn hình vẫn khớp.

### LOCAL_MOTION — không phải cảnh nào cũng cần Video AI

Router có thêm một lựa chọn bằng vai với việc chọn model: `LOCAL_MOTION` — dùng
ảnh keyframe + scale/crop/push-in bằng FFmpeg. **$0, và không thể hỏng ở phía
nhà cung cấp.** Bộ render đã làm sẵn việc này cho ảnh tĩnh từ Milestone 1.

| Chế độ | Khi nào gọi Video AI |
|---|---|
| Tiết kiệm | chỉ cảnh HIGH có ≥2 nhân vật |
| Cân bằng | cảnh `spendPriority=HIGH` (hook/punchline) và mọi cảnh không phải LOW priority |
| Chất lượng | mọi cảnh trừ cảnh LOW + LOW |

**Một hiệu chỉnh quan trọng, đo chứ không đoán:** luật đầu tiên viết theo
`complexity === "LOW"`. Chạy thử trên kịch bản thật cho thấy **không cảnh nào
từng là LOW** — hai nhân vật trong khung đã đủ vượt ngưỡng MEDIUM. Luật đó trông
đúng khi đọc và sẽ kích hoạt gần như không bao giờ. Tín hiệu thật sự phân biệt
được là `spendPriority = LOW`, thứ mà bộ phân loại gán cho cảnh "giải thích" và
"ví dụ". Xem `src/domain/local-motion.ts`.

**Cái bẫy đã xử lý:** chế độ Tiết kiệm vốn bỏ qua keyframe cho cảnh đơn giản — mà
đó đúng là những cảnh được đẩy sang LOCAL_MOTION. Hai luật đều đúng khi đứng
riêng, ghép lại thì cảnh không có ảnh **và** không có clip, và bộ render lặng lẽ
bỏ cảnh đó khỏi video. `keyframeRequired()` khiến ảnh thành bắt buộc khi chuyển
động đến từ ảnh tĩnh.

### Cái đã bị gỡ bỏ

`createBatch` cũ nhận form rồi **lập tức** xếp `batch_expand`, sinh kịch bản và
chi tiền media trong một bước. Đó chính là hình dạng "bấm nút là tiền ra" mà
Batch V1 sinh ra để thay thế, nên nó bị **xoá** chứ không đánh dấu deprecated —
để lại thì đường chi tiền không cần duyệt vẫn còn đó.

### Đường nào đi qua cổng lô, đường nào không

Đã nối: **text (kịch bản), image, video, voice** — tất cả đều giữ chỗ tiền trước
khi gửi request.

**Chưa nối: chấm điểm chất lượng** (`evaluateScene`). Hiện không rò tiền vì
`getQualityProvider` chỉ trả về mock; mọi provider khác đều ném
`notImplemented`. Nhưng nếu sau này thêm một quality model thật thì **phải nối
vào cổng lô trước**, nếu không nó sẽ chi ngoài trần đã duyệt. Đường này cũng
chưa có `assertCanSpend` — lỗ hổng có từ trước, không phải do Batch V1.

`character-master.ts` (tạo ảnh chuẩn cho nhân vật) cố ý đứng ngoài: đó là thao
tác quản trị riêng, không nằm trong luồng lô.

### ⚠️ Dự toán từng là giá MOCK — đã sửa 2026-09-15

`availableProviderNames()` trả về `["mock"]` bất cứ khi nào `AI_MOCK_MODE=true`,
và bộ ước tính chỉ định tuyến tới các provider trong danh sách đó. Nghĩa là **mọi
con số "Tổng chi phí dự kiến" mà trang lô từng hiển thị đều được tính từ GIÁ GIẢ
LẬP** rồi trình bày như dự báo tiền thật.

Giá mock không hề gần giá thật, và sai theo **cả hai chiều**:

| Loại | Giá mock | Giá thật | Lệch |
|---|---|---|---|
| voice | $0,015 / 1k ký tự | $0,0006 (`gpt-4o-mini-tts`) | **cao gấp 25 lần** |
| image | $0,020 / ảnh | $0,048 (`gpt-image-2:medium`) | thấp hơn một nửa |
| video | $0,045 / giây | $0,100 (`sora-2`) | thấp hơn một nửa |

**Cách sửa:** ba loại chi phí giờ là kiểu dữ liệu, không phải chú thích —
`MOCK`, `PRODUCTION_ESTIMATE`, `ACTUAL` trong `src/domain/cost-basis.ts`. Mỗi bản
kế hoạch tính **hai lần**: một theo provider chạy được ngay (mock), một theo
provider thật ở giá niêm yết (`productionProviderNames()` — bỏ qua Mock Mode).
Giao diện hiển thị cả hai, có nhãn. **Hạn mức đề xuất luôn lấy từ con số THẬT.**

### Dự toán thật 1 video, chế độ Tiết kiệm

Đo bằng `npx tsx scripts/production-estimate.ts` — chỉ đọc, không gọi API:

| Thành ngữ | Cảnh | Local | Video AI | Image | Video | TOTAL |
|---|---|---|---|---|---|---|
| Spill the beans | 6 | **3** | 3 | $0,288 | $1,400 | **$1,7017** |
| Piece of cake | 6 | 1 | 5 | $0,288 | $1,900 | **$2,2054** |
| Break a leg | 5 | 1 | 4 | $0,240 | $2,100 | **$2,3586** |

**Bài học quan trọng: LOCAL_MOTION tiết kiệm ít hơn nhiều so với kịch bản mẫu.**
Bảng nghiệm thu trước ghi "Tiết kiệm = 4 local + 2 AI, $1,03/video". Con số đó
sai hai lần: nó dùng **kịch bản mẫu** (hiền hơn kịch bản thật) và **giá mock**.
Kịch bản thật gần như toàn cảnh HIGH có 2 nhân vật, mà `needsGenerativeMotion`
buộc những cảnh đó dùng Video AI **bất kể chế độ**. Dải thật là **$1,70–$2,36**.

**Hệ quả định tuyến:** `runway/gen4_turbo` bị loại khỏi mọi cảnh HIGH
(`MAX_COMPLEXITY = LOW`), `gen4.5` vẫn pin-only, nên chế độ Tiết kiệm **không
dùng được tier rẻ** trên kịch bản thật — tất cả rơi vào `sora-2` ở $0,10/giây.

**Rủi ro cần biết trước khi chạy thật:** một số cảnh tính tiền **6 giây**, mà 6
giây đúng là độ dài đã trả về HTTP 400 với `sora-2`. Chỉ 4 giây là đã chứng minh.

### Ứng viên chạy thật đầu tiên — đã chuẩn bị 2026-09-15

**"Cold feet"**, project `f2b68443`, lô `11af6ba6`, quyền chi **DRAFT**.

6 cảnh, **HIGH = 0, MEDIUM = 0** — không cảnh nào cần Sora hay gen4.5. Hai cảnh
dùng `runway/gen4_turbo` (cảnh 1 hook, cảnh 4 punchline), bốn cảnh LOCAL_MOTION.

```
TEXT $0,0010 · IMAGE $0,2880 · VIDEO $0,5000 · VOICE $0,0001 · RENDER $0
TOTAL $0,8128   ·   đề xuất trần $0,90
```

Preflight Runway (chỉ GET, miễn phí): API xác nhận `gen4_turbo` có thật trong
danh sách live, số dư **831 credit (~$8,31)**, 720x1280 hợp lệ, 5 giây hợp lệ,
$0,25/cảnh. Mục duy nhất chưa đạt là **"cảnh chưa có keyframe"** — đúng và
không thể khác, vì gen4_turbo là image-to-video và ảnh chỉ có sau bước Image.

### Ba lỗi phát hiện khi dựng ứng viên này

**1. Bộ ước tính làm tròn 4 chữ số nên chi phí voice biến mất.** Một lời thoại
37 ký tự ở $0,0006/1k tốn $0,0000222 → làm tròn thành $0,0000. Cả video báo
voice = $0,00 trong khi số thật là $0,000135. **Đúng lớp lỗi dự án đã sửa một
lần cho sổ chi phí** (chuyển sang 6 chữ số) — nhưng bỏ sót bộ ước tính.

**2. Bộ ước tính báo lỗi khi thiếu model chấm điểm, còn lúc chạy thật thì bỏ qua
êm.** `evaluateScene` bắt `RoutingError` và trả null; bộ ước tính thì đánh cả
cảnh là lỗi. Registry không có quality model thật → mọi cảnh ưu tiên cao báo lỗi
và cả video đọc ra là không chạy được, **cho một bước mà lúc chạy sẽ bị bỏ qua
lặng lẽ**. Một dự toán từ chối việc mà bộ sinh sẵn sàng làm thì tệ hơn không có
dự toán: nó giấu mất một video vốn không sao cả.

**3. Lô sẽ vứt kịch bản soạn tay.** `handleBatchExpand` sinh kịch bản mới cho
idiom chưa có project trong lô. Đã gắn project vào lô trước. Kèm theo phát hiện
nút duyệt chi chỉ tồn tại trong form `/batches`, nên lô chuẩn bị sẵn **không
duyệt được trên UI** — đã thêm `ApprovePanel` vào trang chi tiết.

### Nghiệm thu bằng mock — 2026-09-15

Chạy `tests/batch-acceptance.test.ts`: **26/26 đạt**, một lô 3 video đi trọn
đường từ dự toán tới MP4, kèm các tình huống cố ý phá:

| Kịch bản | Kết quả |
|---|---|
| Dự toán 3 video, không ghi một dòng sổ nào | đạt |
| Chặn mọi request khi quyền chi còn DRAFT | đạt |
| Một cảnh cố ý hỏng → thử lại → xong | đạt |
| Dừng lô → không gửi request mới | đạt |
| Job đã gửi đi vẫn được theo dõi, không giả vờ huỷ | đạt |
| Chạy tiếp → giữ nguyên trần và số đã chi | đạt |
| Mô phỏng khởi động lại → không mua lại gì | đạt |
| Ví Runway cạn → chặn, dù trần lô và hạn mức tổng còn | đạt |
| Hai request song song tranh cùng khoản cuối | đúng 1 qua, 1 bị chặn |
| Cảnh LOCAL_MOTION → $0, không ProviderJob, không giữ chỗ | đạt |
| Mọi dòng sổ đều ghi `provider=mock`, tiền thật = $0 | đạt |

Ngoài ra đã chạy thật trên giao diện (DB riêng `data/.uidemo`, không đụng dữ
liệu production): dự toán → duyệt $1,09 → lô chạy → 2 video xuất MP4.

### Hai lỗi nghiệm thu tìm ra và đã sửa

**1. Dự án kẹt ở `draft` không có kịch bản là ngõ cụt vĩnh viễn.** Trong lần
chạy UI, một SQLite socket timeout làm hỏng kịch bản của video thứ ba. Dòng dự
án vẫn còn, ở trạng thái `draft`, không có cảnh nào. Lỗi đó là nhất thời — nhưng
hậu quả thì vĩnh viễn: `startMediaGeneration` từ chối vì "chưa có kịch bản", nên
cả *chạy tiếp* lẫn nút *Thử lại* đều bó tay. Đã sửa ở hai chỗ: `handleBatchExpand`
và `retryVideo` đều tự viết lại kịch bản khi gặp dự án `draft` rỗng.

**2. Hai test nghiệm thu hỏng vì mốc thời gian, không phải vì code.** Một bước
rút cạn cả lô — 18 job mock cộng ba lần render FFmpeg thật — và vượt mốc 300
giây mặc định. Ban đầu tôi quy cho việc chạy song song bộ test và lô UI; chạy
riêng vẫn hỏng y hệt, nên giả thuyết đó sai. Đã nâng mốc cho bước đó và thu hẹp
bước "khởi động lại" để nó không render lại toàn bộ lần nữa.

### Chưa làm trong V1

- Chưa chạy lô nào với API thật. Chỉ mock.
- Bảng dự toán dùng **kịch bản mẫu 6 cảnh** cho video chưa có kịch bản, và có
  ghi nhãn. Hạn mức/video được kiểm tra **lại** theo kịch bản thật trước khi
  video đó chi tiền video — dự toán sai làm kế hoạch sai, không làm việc chi sai.
- Chưa có nút thử lại **từng cảnh** trên giao diện (service `retryScene` đã có).
- Trang `/batches/[id]` **không tự làm mới**, và điều hướng tới cùng URL thì
  trình duyệt không tải lại — phải F5 hoặc đổi URL mới thấy tiến trình mới. Đây
  là điểm khó chịu thật khi ngồi xem một lô dài.
- Mỗi lần mở lại trang `/batches` rồi bấm dự toán sẽ tạo một dòng lô PLANNED mới.
  Trong cùng một phiên thì bấm lại nhiều lần chỉ cập nhật một dòng, nhưng qua
  lần tải trang mới thì không. Các dòng thừa là DRAFT, không chi được gì.
- **Chấm điểm chất lượng chưa nối vào cổng lô.** Hiện không rò tiền vì
  `getQualityProvider` chỉ trả mock, nhưng phải nối trước khi thêm quality model
  thật.
- Cơ chế nối tiếp việc giữ chỗ tiền chỉ bảo đảm **trong một tiến trình**. Ứng
  dụng vốn được thiết kế chạy một tiến trình (worker giả định nó là duy nhất),
  nhưng nếu sau này chạy hai bản cùng trỏ vào một file SQLite thì phải đổi sang
  transaction có khoá ghi thật.

---

## Tình trạng build

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Lint | `npm run lint` | ✅ 0 lỗi |
| Kiểu dữ liệu | `npm run typecheck` | ✅ 0 lỗi (TS strict, không dùng `any`) |
| Kiểm thử | `npm run test` | ✅ **636 test / 26 tệp, tất cả đạt** |
| Build production | `npm run build` | ✅ 16 route biên dịch thành công |
| Chạy thật | `npm start` | ✅ Đã kiểm tra thủ công trên Windows 11 |

Môi trường đã kiểm chứng: Windows 11 Pro 26200, Node v24.14.1,
FFmpeg 6.1.1 (bản đi kèm ffmpeg-static, có libass + libx264).

---

## ⚠️ CHI PHÍ API THẬT

**Đã chi: $3,712760** / hạn mức **$8,00** — còn **$4,287240**. Đây là con số
duy nhất đúng; xem bảng ví từng nhà cung cấp ở đầu tài liệu.

| Loại | Số lần | Chi phí thật |
|---|---|---|
| Image AI (OpenAI `gpt-image-2:medium`) | 29 ảnh | $1,193640 |
| Video AI (OpenAI `sora-2:720x1280`) | 2 clip × 4s | $0,800000 |
| Video AI (Runway `gen4_turbo` + `gen4.5`) | 3 clip | $1,690000 |
| Voice AI (OpenAI `gpt-4o-mini-tts`) | đã chạy thật | trong ví openai |
| Text AI (Groq `openai/gpt-oss-120b`) | 24 lần | $0,028854 |

Đây là **tiền thật**. Kiểm tra lại bất cứ lúc nào bằng `spendStatus()` và
`providerSpendBreakdown()` — con số trong tài liệu sẽ cũ đi, sổ chi phí thì không.

`.env` đang ở `AI_MOCK_MODE=true` — chế độ an toàn.

> Bản trước của mục này ghi hạn mức **$3,00** và nói Voice AI còn mock. Cả hai
> đều đã sai từ lâu: hạn mức được nâng lên $8,00 và Voice AI đã chạy thật. Ghi
> lại ở đây vì một con số cũ trong tài liệu trạng thái không vô hại — nó là thứ
> phiên làm việc sau sẽ tin.

---

## Nghiệm thu qua giao diện (2026-09-13)

Ba dự án được tạo **hoàn toàn qua UI** như người dùng thật, với
`AI_MOCK_MODE=false`:

| Thành ngữ | Cảnh | Thời lượng | Chi phí thật |
|---|---|---|---|
| Break a leg | 5 | 27,0s | $0,0023 |
| Spill the beans | 6 | 27,0s | $0,0058 |
| Piece of cake | 6 | 23,0s | $0,0019 |

Luồng đã đi qua: UI → chọn idiom → tạo project → AIRouter → TextProvider thật →
script → kiểm tra JSON → storyboard → chấm điểm → sổ chi phí → dashboard.

Image/Video/Voice giữ nguyên mock trong suốt quá trình.

### Các mục an toàn đã kiểm chứng

| Mục | Kết quả |
|---|---|
| Router KHÔNG âm thầm dùng mock khi ở chế độ thật | ĐẠT — cả 3 dự án đều ghi `provider=groq` |
| Provider thật lỗi → UI báo rõ provider/model/lý do | ĐẠT — *"Không tìm thấy model... provider=groq, code=model_not_found"* |
| Không giả vờ thành công bằng mock | ĐẠT — lỗi được ném ra, không có fallback ngầm |
| API key không xuất hiện trong log | ĐẠT — quét 59 dòng LogEntry + 34 ProviderJob, không có key, không có chuỗi `gsk_` |
| Không tạo request trả phí trùng lặp | ĐẠT — 34 khoá idempotency đều duy nhất |
| Dashboard phân biệt 3 loại chi phí | ĐẠT — API thật / ước tính / mock hiển thị riêng |
| Kịch bản 4–6 cảnh, không bị cắt | ĐẠT — 5/6/6 cảnh, mọi cảnh 2–6 giây |
| Lấy danh sách model từ provider thật | ĐẠT — liệt kê 7 model Groq, cảnh báo model lỗi thời |
| Tổng chi phí ≤ $0,50 | ĐẠT — $0,014745 |

---

## Milestone 1 — hoàn tất và đã kiểm chứng

Toàn bộ quy trình chạy được ở chế độ mock, xuất ra MP4 1080x1920 thật.

- [x] Next.js 15 + React 19 + TypeScript strict, chạy trên Windows, không Docker
- [x] SQLite + Prisma, lược đồ sẵn sàng chuyển sang PostgreSQL
- [x] 137 thành ngữ, 2 nhân vật, 6 phong cách, 21 model, 9 nhà cung cấp
- [x] Giao diện tiếng Việt 12 trang
- [x] AI Router định tuyến **theo từng cảnh**, 4 chế độ, 5 chiến lược
- [x] Ước tính chi phí 3 chế độ, NGÂN SÁCH TỐI ĐA chặn cứng
- [x] Tối ưu ngân sách theo lô
- [x] Job Queue trên SQLite, thử lại 10s/30s/90s
- [x] Chống tính phí hai lần bằng khoá idempotency
- [x] Storyboard 3 khung, sửa/duyệt/bỏ qua cảnh
- [x] Phụ đề SRT + ASS, ghi lên hình
- [x] FFmpeg render — **đã kiểm chứng: MP4 1080x1920, H.264, 30fps, 25.1 giây**
- [x] Chế độ ngoại tuyến, dọn dẹp, sao lưu, doctor

Chi tiết đầy đủ xem lịch sử Git (commit `docs: add README, docs/ and .ai state tracking`).

---

## Milestone 2 bước 1 — Text AI thật

### Đã viết xong

- [x] `OpenAICompatibleTextProvider` — nói chuẩn Chat Completions, nên một lớp
      dùng được cho OpenAI, DeepSeek, Groq, OpenRouter, Together, Google
      (endpoint tương thích), và Ollama / LM Studio chạy cục bộ
- [x] Cắm vào `registry.ts` — điểm cắm duy nhất, Mock Mode vẫn là cổng chặn cứng
- [x] **Xoá hard-code provider khỏi business logic**: `project-service.ts` từng
      ghim cứng `"mock"/"mock-text-1"`, giờ chọn qua AI Router từ `ModelRegistry`
- [x] `ModelRegistry.priceOutput` — text API tính giá input/output khác nhau
- [x] `ProviderJob.inputTokens / outputTokens / durationMs`
- [x] **Hạn mức chi tiêu cứng** (`spend-guard.ts`): mặc định **$0.50**, kiểm tra
      trước MỌI request trả phí, cộng dồn toàn ứng dụng
- [x] **Cổng xác nhận** theo từng cặp provider/model: hiển thị provider, model,
      giá input, giá output, ước tính/kịch bản, đã chi, hạn mức, còn lại — rồi
      mới cho bấm xác nhận
- [x] Từ chối bật model chưa nhập giá (trừ model chạy cục bộ, vốn thật sự free)
- [x] Phân loại lỗi: 401/403/400/404/402 **không** thử lại; 429/5xx có thử lại,
      tôn trọng header `Retry-After`; tối đa 3 lần, không lặp vô hạn
- [x] Ghi nhận mỗi request: provider, model, token vào/ra, ước tính, chi phí
      thật, thời gian, trạng thái, lỗi
- [x] API key chỉ nằm trong header `Authorization`, không vào log/body/URL
- [x] Sửa JSON hỏng dùng lại `parseScript` + `repairJson` của Milestone 1
- [x] `npm run compare:text` — so sánh Mock vs Real trên cùng một thành ngữ

### Đã kiểm chứng bằng cách nào

**1. Máy chủ giả lập chạy cục bộ** (`tests/text-provider.test.ts`, 35 test,
chi phí $0.00): dạng request, đọc token, key nằm đúng header, 429 → thử lại,
401 → **chỉ gọi 1 lần**, 500 liên tục → dừng đúng 3 lần, phản hồi bị cắt, phản
hồi rỗng, tính tiền theo token, JSON bọc code fence / có lời dẫn, mọi nhánh của
hạn mức chi tiêu, và lịch sử chi phí không bị xoá theo dự án.

**2. Gọi API thật tới Groq** (`npm run compare:text`) — nhà cung cấp
`groq`, model `openai/gpt-oss-120b`:

| Tiêu chí | Mock | Groq thật |
|---|---|---|
| JSON đúng schema | ĐẠT | **ĐẠT** |
| Số cảnh (cần 4–6) | 6 | **6** |
| Tổng thời lượng (cần 20–35s) | 26,9s | **27,0s** |
| Mỗi cảnh 2–6 giây | ĐẠT | **ĐẠT** |
| Đủ prompt ảnh | ĐẠT | **ĐẠT** |
| Đủ prompt video | ĐẠT | **ĐẠT** |
| Có giải thích nghĩa | ĐẠT | **ĐẠT** |
| Có câu ví dụ | ĐẠT | **ĐẠT** |
| TB từ/phụ đề (nên ≤ 12) | 6,2 | **6,8** |
| Điểm tự chấm | 7/9/9/9/7 | **8/7/9/9/8** |
| Token | – | 1647 vào / 3447 ra |
| Chi phí thật | $0,000000 | **$0,002832** |

**3. Workflow thật đầy đủ** (`npm run workflow:test`) — Text AI thật, media
vẫn mock: thành ngữ → dự án → kịch bản → kiểm tra JSON → lưu SQLite →
storyboard → chấm điểm → định tuyến media → ước tính 3 chế độ.

Router chọn đúng `groq/openai/gpt-oss-120b` (rẻ hơn mock 10 lần nên thắng về
giá trị). Nhánh **viết lại kịch bản một lần** đã thực sự kích hoạt trong một lần
chạy: 4 request (script, score, script-rewrite, score-rewrite), tổng $0,0049,
mọi request đều được ghi token + thời gian + chi phí vào bảng `ProviderJob`.

**4. Giao diện** đã kiểm tra thủ công: cổng xác nhận hiện đủ 8 chỉ số và 3 cảnh
báo đúng; bấm xác nhận khi model chưa có giá thì **bị từ chối**.

### Chất lượng nội dung: Mock so với Groq thật

Cả hai đều qua toàn bộ kiểm tra cấu trúc. Khác biệt về nội dung:

- **Groq thật** viết tiếng Anh tự nhiên hơn và bám sát thành ngữ hơn. Ví dụ với
  "Piece of cake": *"Max brings a cake to the exam!"* → *"Leo shows the paper is
  easy, not edible."* Đây là trò đùa hình ảnh thật, quốc tế, hiểu được không cần
  âm thanh.
- **Mock** dùng khuôn mẫu cố định nên lời thoại lặp lại giữa các thành ngữ.
- Giải thích nghĩa của Groq chính xác: *"Piece of cake means something is very
  easy."*
- Groq tự đặt thời lượng cảnh và độ phức tạp hợp lý, đủ prompt ảnh/video cho các
  bước sau.

Kết luận: **Text AI thật cho chất lượng dùng được cho sản xuất.** Mock vẫn hữu
ích để thử quy trình miễn phí.

## Milestone 2 bước 2 — Image AI thật

**Đã chạy thật với OpenAI và kiểm chứng bằng mắt.**

### Đang dùng

```
Provider : openai
Model    : gpt-image-2 (tầng medium)
Giá      : ước tính $0,048/ảnh — thực tế đo được $0,041160/ảnh
Kích thước: 1024x1536 (khổ dọc gần 9:16 nhất mà API chấp nhận)
```

Giá thực tế **tính từ số token API báo về** ($30 / 1M token đầu ra), không phải
con số đoán. Giá ước tính chỉ dùng để kiểm tra hạn mức *trước* khi gọi — bắt
buộc phải có, vì lúc đó chưa biết số token.

### Vì sao chọn gpt-image-2

Danh sách model lấy trực tiếp từ OpenAI cho thấy `gpt-image-1` mà bản seed ghi
sẵn đã là đời cũ. `gpt-image-2` vừa mới hơn vừa **rẻ hơn** ($30 so với $40 mỗi
1M token đầu ra). Đây đúng là lý do phải hỏi nhà cung cấp thay vì tin danh sách
cũ.

### Character Reference System

Bảng `CharacterReference` thay cho mảng JSON: mỗi ảnh một dòng, nên duyệt/đổi/xoá
từng ảnh được, và "ảnh chuẩn nào đang dùng" thành dữ liệu truy vấn được.

Nhân vật có thêm `hair`, `facialFeatures`, `outfit`, `bodyProportions`,
`accessories`, `colorPalette`, `version`. Mỗi trường vào prompt thành một mệnh đề
riêng có nhãn — model ít chỗ diễn giải lại hơn hẳn một đoạn văn dài.

`buildScenePrompt` xếp: hành động cảnh trước → mô tả nhân vật → **câu khoá thuộc
tính cuối cùng**, nơi model đọc gần nhất và tuân thủ mạnh nhất.

Ảnh cảnh gọi `/images/edits` kèm ảnh chuẩn đã duyệt. Đó là cách duy nhất cho model
biết nhân vật *đã* trông như thế nào, thay vì vẽ lại từ chữ mỗi lần.

### Quy tắc quan trọng nhất

**Ảnh chuẩn đã duyệt không bao giờ bị thay tự động.** Mọi lần tạo mới chỉ sinh
ứng viên `approved=false, isPrimary=false`. Có test riêng canh điều này.

### Kết quả chạy thật

```
2 ảnh chuẩn (Max, Leo) + 9 ảnh cảnh từ 3 thành ngữ = 11 ảnh
Max  : 9/9 cảnh đều nhận ảnh tham chiếu
Leo  : 4/4 cảnh đều nhận ảnh tham chiếu
Tổng : $0,452760
```

Kiểm tra bằng mắt qua 3 cảnh "Break a leg" và chéo sang "Piece of cake": tóc,
khuôn mặt, hoodie vàng sọc trắng, quần jeans lật gấu, giày trắng của Max giữ
nguyên; kính tròn, áo teal xắn tay, quần xám, giày nâu của Leo giữ nguyên;
chênh lệch chiều cao Max–Leo cũng giữ đúng.

---

## Character Presence — sửa sau khi phát hiện ở bước Image AI

**Vấn đề:** sự có mặt của nhân vật được suy ra từ việc ai có thoại. Nhân vật
đứng im phản ứng trong khung hình không có lời nào, nên **không được gửi ảnh
tham chiếu** và bị AI vẽ tự do.

**Cách sửa:** tách một danh sách thành ba, lưu riêng trong `Scene`:

| Trường | Trả lời câu hỏi | Dùng cho |
|---|---|---|
| `charactersPresentJson` | ai **được nhìn thấy** | tạo ảnh |
| `speakingCharactersJson` | ai **có thoại** | tạo giọng |
| `primaryCharactersJson` | cảnh **nói về ai** | thứ tự ưu tiên ảnh tham chiếu |

Suy diễn chỉ đi một chiều: ai nói thì chắc chắn có mặt. **Không bao giờ ngược
lại** — đó chính là suy diễn gây ra lỗi.

Thứ tự ưu tiên khi nhà cung cấp giới hạn số ảnh tham chiếu: trọng tâm → người
nói → còn lại. Nhân vật bị cắt khỏi danh sách ảnh **vẫn giữ nguyên hồ sơ chữ
trong prompt**.

**Tự sửa trước khi gọi API:** nếu mô tả cảnh nhắc tên một nhân vật không có
trong `charactersPresent`, hệ thống bổ sung và ghi cảnh báo. Không âm thầm tạo
ảnh với dữ liệu mâu thuẫn.

**Kiểm chứng thật:** cảnh có Max + Leo + Mia, chỉ Max nói — cả ba đều được gửi
ảnh tham chiếu và vẽ đúng mẫu. Mia im lặng vẫn đúng hình.

### Khung hình và vùng cắt

Ảnh là 1024x1536 (2:3), video là 1080x1920 (9:16). Ảnh **rộng hơn** khung video,
nên bộ render phóng to phủ kín rồi cắt **hai bên trái/phải** khoảng 8% mỗi bên;
toàn bộ chiều cao được giữ. Trực giác thường đoán ngược lại.

Prompt yêu cầu giữ nhân vật trong 84% chiều ngang ở giữa. Storyboard có lớp phủ
hiển thị đúng vùng bị cắt.

---

## Chế độ chất lượng ảnh — chốt V1

**Mọi chế độ đều chỉ tự vẽ MỘT ảnh.** Không chế độ nào âm thầm trả tiền cho ảnh
thứ hai.

| Chế độ | Hành vi |
|---|---|
| ECONOMY | 1 ảnh, model tiết kiệm, không tự vẽ lại |
| BALANCED | 1 ảnh, model tốt/giá hợp lý, tự vẽ lại tối đa 1 lần khi ảnh hỏng rõ |
| QUALITY | 1 ảnh bằng model chất lượng cao. Người dùng bấm **"Tạo phương án khác"** để có ứng viên thứ 2 và tự chọn |
| CUSTOM | người dùng tự chọn provider/model |

Ước tính chi phí **chỉ đếm ảnh hệ thống tự vẽ**. Ảnh người dùng chủ động tạo
thêm là quyết định riêng của họ, không đưa vào dự báo — dự báo thừa sẽ làm hạn
mức còn lại trông nhỏ hơn thực tế.

Ảnh cũ không bị mất: mọi ảnh từng tạo đều còn trong bảng `Asset`, hiển thị thành
dải ứng viên để chọn lại, miễn phí.

---

## Vùng cắt 9:16 — đo bằng số liệu

`npm run crop:check` giải mã ảnh bằng ffmpeg và đo phần nội dung rơi vào dải bị
cắt, tách riêng ba dải: mặt/đầu, tay/đạo cụ, chân/bàn.

Phát hiện: cảnh **1–2 nhân vật nằm gọn** trong vùng an toàn; cảnh **3 nhân vật
dàn ngang hết khung** và mất chi tiết hai bên. Đã thêm chỉ dẫn gom nhóm cho cảnh
từ 3 nhân vật trở lên — đo lại cho thấy nội dung thu từ 0–100% về 4–96%.

Lưu ý khi đọc kết quả: phép đo đếm **mọi** nội dung, kể cả mép tóc và mũi giày,
nên nó là bộ lọc thận trọng chứ không phải số lỗi.

---

## Milestone 2 bước 3 — Video AI

### Sora-2 đã kiểm chứng bằng 2 clip thật

| | Test #1 | Test #2 |
|---|---|---|
| Character Identity | 10 | 7 |
| Motion | 3 | 8 |
| Artifacts | 8 | 7 |
| Camera | 10 | 10 |
| Composition | 6 | 9 |
| Humor readability | 3 | 8 |

**Kết luận:** identity và motion **đánh đổi trực tiếp** — prompt cho cử động
nhiều thì model biến dạng nhiều hơn. Camera tĩnh tuyệt đối ở cả hai lần.
$0,40 cho 4 giây → **$2,40 cho một video 6 cảnh**, đắt hơn toàn bộ ảnh và text
cộng lại.

**Chưa chốt Sora-2 làm mặc định cho BALANCED.**

### Ba adapter video đã viết, chưa gọi API

| Provider | Model | Giá 4s | Key | Đã chạy thật |
|---|---|---|---|---|
| openai | `sora-2:720x1280` | $0,40 | ✅ | ✅ 2 clip |
| runway | `gen4_turbo:720x1280` | **$0,25** | ❌ | chưa |
| google | `veo-3.1-lite...:720x1280` | $0,40 | ❌ | chưa |

Hai ràng buộc về giá mà adapter đã tính sẵn, đừng tính lại bằng tay:

- **Runway chỉ bán clip 5 hoặc 10 giây.** Cảnh 4 giây bị tính tiền 5 giây.
- **Veo bị ép 8 giây** khi có ảnh keyframe hoặc dùng 1080p. Chưa kiểm chứng
  được ảnh keyframe đầu tiên có tính là "reference image" hay không — adapter
  giả định là CÓ, nên báo giá cao hơn thực tế thay vì thấp hơn hoá đơn.

Xem bảng đầy đủ: `npm run video:benchmark`

---

## Chưa làm (các bước sau)

### Milestone 2 bước 2-4 — ĐÃ XONG
- [x] Image AI thật — OpenAI `gpt-image-2`
- [x] Video AI thật — Runway `gen4_turbo`, `gen4.5`; OpenAI `sora-2`
- [x] Voice AI thật — OpenAI `gpt-4o-mini-tts`

**Chỉ còn Upscale là mock.** Image, Video, Voice đều đã chạy thật và đã ghi chi
phí vào sổ.

### Milestone 3-4
- [ ] Nhiều nhà cung cấp video, định tuyến thật
- [ ] Đo `historicalSuccessRate` thật theo thời gian
- [ ] Nhất quán nhân vật nâng cao, phụ đề động, SFX, nhạc nền
- [ ] Nâng phân giải thật, YouTube API, lên lịch, phân tích

### Có backend nhưng chưa có nút trên giao diện
- [ ] Sinh metadata YouTube
- [ ] Sửa mẫu prompt từ trang quản trị
- [ ] Tải ảnh tham chiếu nhân vật
- [ ] Chọn nhạc nền cho dự án

---

## Lỗi đã biết

Không có lỗi nào đang mở.

### Đã phát hiện và sửa trong Milestone 1

| Vấn đề | Cách sửa |
|---|---|
| `slugify` làm mất chữ "đ" tiếng Việt | NFD không tách "đ"; thêm ánh xạ riêng |
| Bộ che khoá bí mật bỏ sót khoá nhiều đoạn | Cho phép `-` và `_` trong thân khoá |
| Chiến lược CHEAPEST vẫn bị ngưỡng chất lượng ép lên model đắt | Ngưỡng chỉ áp dụng khi strategy = AUTO |
| Kế hoạch có cảnh không định tuyến được vẫn báo "trong ngân sách" | `withinBudget` yêu cầu không còn lỗi định tuyến |
| Chi phí chấm điểm chất lượng ghi theo ước tính | Ghi theo chi phí nhà cung cấp báo về |
| Thanh trạng thái luôn báo "worker đang tắt" | Trạng thái worker chuyển sang `globalThis` |
| `window.confirm` chặn toàn bộ renderer | Thay bằng xác nhận nội tuyến |
| `zoompan` ở 1080x1920 quá chậm | Đổi sang scale + crop di động |
| Thẻ hình mock tràn khung | Tự co chữ, neo khối chú thích từ đáy |
| Dọn thư mục test trong `setupFiles` gây EPERM | Chuyển sang `globalSetup` |

### Đã phát hiện và sửa trong Milestone 2 bước 1

| Vấn đề | Cách sửa |
|---|---|
| `project-service.ts` **hard-code** `"mock"/"mock-text-1"` — vi phạm nguyên tắc không ghim provider vào business logic | Thêm `selectTextModel()` dùng AI Router đọc từ `ModelRegistry` |
| `ModelRegistry` chỉ có 1 trường giá, không tính đúng được chi phí text (input và output khác giá) | Thêm cột `priceOutput` + ô nhập trong giao diện |
| `TextProvider` không báo cáo token đã dùng, nên không thể ghi chi phí thật | Đổi interface: mọi lệnh gọi text trả kèm `ProviderUsage` |
| `.gitignore` có `data/` nên nuốt luôn `src/data/` là mã nguồn | Neo về gốc repo: `/data/` |
| Dùng `require()` để tránh circular import | Không cần — `script-service` đã được import tĩnh sẵn |

### Đã phát hiện khi NGHIỆM THU QUA UI

| Vấn đề | Cách xử lý |
|---|---|
| **Chi phí làm tròn 4 chữ số** nên khoản $0,000045 bị ghi thành $0 — cộng dồn nhiều lần gọi nhỏ sẽ sai lệch | Sổ chi phí và hạn mức chuyển sang 6 chữ số |
| **Lỗi "phản hồi rỗng" không mang theo chi phí** — cùng loại lỗ hổng với truncation: đã bị tính tiền nhưng sổ không ghi | Dựng `ChatResult` trước khi kiểm tra nội dung, mọi lỗi sau đó đều đính `usage` |
| **Text AI thật trả về cảnh 7 giây** — vượt giới hạn 6s mà mỗi lần tạo video AI chịu được. Mock tự giới hạn, provider thật thì không | Cắt về 2–6 giây trong `withDerivedRouting`, kèm test |
| Lấy danh sách model lại đòi model phải đang bật — không thể khám phá model trước khi bật nó | `buildTextConfig` nhận cờ `requireEnabled` |

### Đã phát hiện khi CHẠY THẬT (những lỗi mà test giả lập không bắt được)

| Vấn đề | Cách xử lý |
|---|---|
| **Danh sách biến môi trường viết cứng** khiến provider mới luôn bị coi là "thiếu API key" → router bỏ qua Groq và âm thầm chọn mock dù key đã có | `hasEnvKey()` giờ đọc `apiKeyEnvVar` từ bảng provider, fallback `TÊN_API_KEY` |
| **Xoá dự án làm mất lịch sử chi phí thật** (`CostEntry` cascade theo `Project`) → hạn mức được "hoàn lại" sai, có thể tiêu vượt bằng cách xoá dự án cũ | Đổi quan hệ sang `onDelete: SetNull`; thêm test chống tái diễn |
| **Chi phí bị mất khi request thất bại sau khi đã bị tính tiền** (phản hồi bị cắt, JSON không đọc được) | `ProviderError` mang theo `usage`; sổ ghi nhận cả lần thất bại, ghi rõ "thất bại nhưng vẫn bị tính phí" |
| Giới hạn 2500 token output làm kịch bản 6 cảnh bị cắt giữa chừng | Đo thực tế rồi nâng lên 6000; cơ chế phát hiện cắt đã báo đúng lỗi |
| `provider:enable` chỉ bật model, quên bật cả provider → router vẫn không thấy | Bật cả `ProviderConfig` |
| Tên model `llama-3.3-70b-versatile` đã bị Groq gỡ bỏ | Lấy danh sách thật từ `/v1/models`, cập nhật seed thành `openai/gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b` |
| Script so sánh gọi provider trực tiếp, **bỏ qua hạn mức và không ghi sổ** | Bắt nó đi qua `assertCanSpend` + `recordCost` như ứng dụng |

---

## Tình trạng lược đồ

Ổn định. 15 bảng. Đã đồng bộ qua `prisma db push`.

Thay đổi trong Milestone 2 bước 1:
- `ModelRegistry.priceOutput` (Float, mặc định 0)
- `ProviderJob.inputTokens`, `outputTokens`, `durationMs` (Int?, cho phép null)

Chưa tạo tệp migration — vẫn dùng `db push`. Nên chuyển sang `prisma migrate`
trước khi phát hành cho người khác dùng.

---

## Việc nên làm tiếp theo

Xem [NEXT_TASKS.md](NEXT_TASKS.md).

**Milestone 2 bước 1 đã nghiệm thu xong.** Không tự động chuyển sang bước 2
(Image AI) — chờ người dùng xác nhận.

Cấu hình hiện tại:

```
Provider : groq (bật, đã xác nhận)
Model    : openai/gpt-oss-120b
Giá      : $0.00015 / 1k token vào, $0.00075 / 1k token ra
Hạn mức  : $0.50, đã chi $0.014745, còn $0.485255
.env     : AI_MOCK_MODE=true  ← chế độ an toàn
```

Để dùng Text AI thật: đặt `AI_MOCK_MODE=false` trong `.env` rồi khởi động
lại. Để quay về miễn phí: đặt lại `true`.

> Giá đang dùng là theo bảng giá Groq tại thời điểm cấu hình. Hãy đối chiếu lại
> tại https://groq.com/pricing nếu con số ước tính trông không đúng.
>
> Trước khi thêm model mới, bấm **"Hỏi nhà cung cấp"** trong trang Nhà cung cấp
> AI để lấy tên model đang thực sự khả dụng — Groq đã gỡ một model mà chúng ta
> seed sẵn, và đó là nguyên nhân lỗi 404 ở lần chạy thật đầu tiên.

---

## LOW_AUTO cho h3_max — ĐÃ BẬT — 2026-09-16

`runway/h3_max:768x1280` đã chuyển **`LOW_AUTO_CANDIDATE` → `LOW_AUTO`** sau khi
người dùng đồng ý. Đúng **một trường trên 37 model** thay đổi; **0/23 cảnh** bị
đổi; cả **6 ghim tay giữ nguyên**; `ProviderJob` 102→102, `CostReservation` 3→3,
`CostEntry` 120→120.

Quyền này **chưa đổi lấy quyết định nào**: router tự chọn **0 cảnh**. Cả 3 cảnh
LOW còn muốn clip trả phí đều đang ghim tay, và ghim tay thì short-circuit phần
chấm điểm. Quyền chỉ có tác dụng với **cảnh mới hoặc cảnh không ghim tay**.

### Vì sao không thể chỉ đổi một cờ

Trước đây "bật LOW_AUTO" chỉ có đúng một cách: đổi `lifecycle` thành `ACTIVE`.
Dry-run trên registry giả lập `ACTIVE` cho kết quả **6 cảnh MEDIUM/HIGH — tất cả
3 nhân vật, tất cả không keyframe — rơi vào h3_max**. Không có gì chặn, vì
`MAX_COMPLEXITY` chưa có dòng nào cho model này và cổng 11 điều kiện thì
**production chưa từng gọi**.

### Bốn ổ khoá độc lập, hiện đã có đủ

| Lớp | Ở đâu | Chặn gì |
|---|---|---|
| Vòng đời | `domain/enums` → `isAutoRoutable(lifecycle, {complexity})` | `LOW_AUTO` chỉ đúng khi `complexity === "LOW"`; không biết độ khó thì `false` |
| Cổng cảnh | `domain/low-auto` → `lowAutoRouteBlock()` | keyframe thật, ≤2 nhân vật, camera khoá, không vật nhỏ dày đặc, prompt sạch, 3 loại ngân sách |
| Trần cứng | `domain/video-suitability` → `MAX_COMPLEXITY` / `MAX_CHARACTERS` | MEDIUM/HIGH và >2 nhân vật, **kể cả ghim tay** |
| Quyền chi | `services/batch-authorization` → `lowAutoApproved` | quyền chi cũ không trả được cho clip router tự chọn |

Cổng giờ **thật sự được gọi**: `lowAutoRouteBlock()` nằm trong bộ lọc ứng viên
của `routeScene()`, cạnh `autoRouteBlock()` và `requiresExplicitPin()`.

### Dry-run sau khi sửa: 12/12 ĐẠT

```
MEDIUM -> h3_max                0 cảnh
HIGH -> h3_max                  0 cảnh
>2 nhân vật -> h3_max           0 cảnh
thiếu keyframe -> h3_max        0 cảnh
LOCAL_MOTION -> trả phí         0 cảnh
DIRECTED_CAMERA -> h3_max       0 cảnh
mâu thuẫn benchmark             0
phát sinh mới (E)               $0,000000
```

**Kết luận: SAFE TO ENABLE — nhưng quyền hiện chưa có tác dụng gì.** Cả 2 cảnh
chạy `h3_max` đều do **ghim tay**, router tự chọn **0 cảnh**. 4 cảnh LOW còn lại
là LOCAL_MOTION, 1 cảnh thiếu keyframe. Cấp quyền hôm nay không đổi lấy một
quyết định nào.

### Bốn cảnh `motionSource` bất đồng

`5c698155`, `0cc1d8cf` → thành **LOCAL_MOTION** (miễn phí thắng).
`4dd22035`, `8453fa52` → giữ **AI_VIDEO** vì đã **ghim tay** h3_max.

Không sửa DB. Bất đồng được log `scene.motion_source_diverged` mức WARN. Xem
QĐ-052.

### Còn treo, cố ý

- **`8453fa52`** (Spill the beans #6, MEDIUM, ghim h3_max) **bị từ chối** vì trần
  độ khó. Hệ quả đã lường trước của QĐ-051 — cần gỡ ghim hoặc hạ phân loại cảnh,
  không phải nới trần.
- **`d9c9b991`** (Spill the beans #3) ghim `gen4.5` đang `PIN_ONLY`, $0,72. Ghim
  tay vẫn tới được, đúng thiết kế. Chưa đụng.
- Ba dự án **Break a leg / Piece of cake / Spill the beans** đều là cảnh HIGH với
  3 nhân vật. Không cảnh nào route được, và đó là **trạng thái đúng**: kể từ
  QĐ-028 không còn provider nào được duyệt cho MEDIUM/HIGH (Sora DEPRECATED,
  gen4.5 PIN_ONLY, gen4_turbo DEGRADED), và LOW_AUTO cố ý không mở rộng sang đó.

---

## Lô cũ `11af6ba6` — ĐÃ ĐÓNG 2026-09-17

Trạng thái trước đó ghi "KHÔNG đóng, đang có dependency thật". Điều đó đúng ở
thời điểm viết và **đã hết đúng**: lô dừng hẳn từ 2026-09-15, job dẫn đầu đã
`failed`, và cái gọi là dependency hoá ra là **6 job `queued` đang lên nòng** chứ
không phải một lô đang chạy.

```
quyền chi  APPROVED  -> CANCELLED
lô         RUNNING   -> CANCELLED
job        6 queued  -> 6 cancelled
```

**Vì sao phải đóng, chứ không chỉ để đó.** `claimNext` lấy job theo `priority`
tăng dần và **không lọc theo lô**. Sáu job đó (priority 102–106 và 500) sẽ đi
**trước** bất cứ lô mới nào, trên một lô không ai theo dõi, gồm một cảnh ghim
`gen4_turbo` đang `DEGRADED` và không có keyframe. Ước tính nếu chúng chạy:
~5 ảnh × $0,041 + 1 clip $0,25 ≈ **$0,456**, vừa đủ vét sạch $0,458840 còn lại.

**Cái gì KHÔNG bị đụng** — kiểm bằng cách đọc lại DB sau khi ghi, không phải bằng
lời script tự khai:

```
job queued/processing còn : 0            ĐẠT
quyền chi                 : CANCELLED    ĐẠT
đang giữ chỗ              : $0,000000    ĐẠT
actualSpend giữ nguyên    : $0,441160    ĐẠT
sổ chi thật giữ nguyên    : 120 dòng $5,353920   ĐẠT
reservation đã chốt còn   : 3 (bằng chứng, không xoá)
```

Không hoàn tiền giả. Tiền đã rời đi, và bản ghi vẫn nói đúng như vậy. Xem QĐ-061.

---

## Lô nghiệm thu `a690a290` — CHỜ DUYỆT, chưa chi một đồng

Dự án `f2b68443` "Cold feet" được soạn lại bằng
`scripts/prepare-first-real-video.ts --make-batch`. `persistScript` xoá và tạo
lại toàn bộ cảnh, nên **mọi ghim tay và mọi đường dẫn media cũ biến mất** — kể cả
ghim `gen4_turbo` ở cảnh 4 từng là một quả mìn.

```
6 cảnh · 26 giây · TOÀN BỘ LOW · 1 nhân vật · camera khoá · không ghim tay nào
```

| | |
|---|---|
| LOCAL_MOTION ($0) | 4 cảnh — #2 #3 #5 #6 |
| AI_VIDEO qua LOW_AUTO | 2 cảnh — #1 #4, `runway/h3_max:768x1280`, $0,40/cảnh |
| quyền chi | **DRAFT** — chưa cấp phép chi gì |

Dự toán thật **$1,121800**, đề xuất trần **$1,24**.

**Số này từng sai, và sai theo hướng nguy hiểm nhất.** Trước QĐ-060 bộ dự toán
không truyền dữ kiện cảnh cho cổng LOW_AUTO, cổng fail-closed, và bảng ghi
`VIDEO $0,000000` với hai cảnh `NEEDS_PROVIDER` — tổng **$0,297800**. Đường chạy
thật vẫn sẽ mua hai clip $0,80. Trần duyệt thấp hơn hoá đơn là cách duy nhất chỗ
này gây hại thật.

### Route thật của 23 cảnh hiện có

| | |
|---|---|
| **auto h3_max** (router tự chọn) | **2** — `26de7d41` #1, `bf8bf64d` #4, sau khi có keyframe |
| manual h3_max (ghim tay) | 1 — `4dd22035` Spill the beans #5 |
| LOCAL_MOTION ($0) | 6 |
| model trả phí khác (ghim tay) | 1 — `d9c9b991` gen4.5 |
| bị chặn, không route được | 13 |

Hai cảnh auto **hiện vẫn hiện `CHẶN(needs_keyframe)`** trong `lowauto:dryrun`, và
đó là câu trả lời đúng: dry-run hỏi ở giai đoạn `VIDEO` — "nếu gọi video **ngay
bây giờ**" — mà bây giờ chưa cảnh nào có ảnh. Bộ dự toán hỏi ở giai đoạn kế
hoạch, biết rằng kế hoạch **bao gồm** bước tạo ảnh, nên nó định giá $0,80. Hai
câu hỏi khác nhau, hai câu trả lời đúng.

`scripts/prove-low-auto.ts` chứng minh phần còn lại: cùng cảnh đó, với keyframe
đã có, router tự chọn `runway/h3_max` $0,40 `lowAutoRouted=true`, và 9/9 negative
control vẫn chặn đúng lớp đúng lý do.

### Công cụ

```bash
npm run lowauto:dryrun     # mô phỏng, chỉ 1 GET miễn phí
npm run lowauto:prove      # chứng minh + 9 negative control, $0
npm run runway:balance     # đọc lại số dư live
npm run batch:close-stale  # thử khô; cần --apply mới ghi
```

---

## Ghim tay tách khỏi bản ghi của router — 2026-09-19, $0

`Scene.videoModelPinned` là cột mới, và là **nguồn sự thật duy nhất** cho câu
"có người chọn model này không". Trước đó `videoProvider`/`videoModel` mang cả
hai nghĩa — chỉ định trước khi chạy, bản ghi sau khi chạy — nên **từ lần chạy
thứ hai, mọi cảnh từng mua clip đều trông như đã ghim tay**, và ghim tay thì bỏ
qua toàn bộ định tuyến. Xem QĐ-069.

Ba thứ bị tắt vì điều đó, tất cả đều về tiền:

| Bị tắt | Nghĩa là |
|---|---|
| `lowAutoRouteBlock()` | điều kiện của quyền LOW_AUTO thôi được kiểm lại từ lần chạy thứ hai |
| `assertBatchAuthorized` cổng 2b | quyền chi "chỉ clip đã nêu tên" trả được tiền cho clip router tự chọn |
| luật *miễn phí thắng* | ngừng áp dụng đúng vào những cảnh **đã tốn tiền** |

Backfill dựng lại từ bằng chứng có sẵn trong hàng — `routingMode = MANUAL` hoặc
`motionMode = VIDEO_AI`:

```
5 ghim / 16 hàng có videoModel
  PIN  d9c9b991 gen4.5     PIN  5fd45846 gen4_turbo
  PIN  4dd22035 h3_max     PIN  8453fa52 h3_max     (4 cảnh Spill the beans)
  PIN  25ca9c6e h3_max                              (cảnh 3 lô nhập)
       26de7d41 h3_max          bf8bf64d h3_max     (router tự chọn — KHÔNG ghim)
sổ chi giữ nguyên: CostEntry 150 dòng $6,801137 · ProviderJob 123 · Reservation 24
```

Kèm theo, cùng gốc:

- `motionResolutionFor` (bước ẢNH) thôi tự dẫn xuất, gọi `deriveSceneVideoFacts`.
  Nó là bản chép tay **thứ tư** QĐ-060 bỏ sót, và nó không biết `motionMode` —
  nên một cảnh nhập `VIDEO_AI` là AI_VIDEO với bước video và LOCAL_MOTION với
  bước ảnh, **trong cùng một lần chạy**.
- `RouteCandidate.lowAuto`: mỗi phương án dự phòng mang cờ của **chính nó**.
  `withFallback` nhân bản bằng `...decision`, nên rơi xuống một model LOW_AUTO
  thừa hưởng `lowAutoRouted: false` và cổng 2b không có gì để bắn.
- Nhánh LOCAL_MOTION thôi ghi đè `ffmpeg/local-motion` lên một cảnh **đã ghim**.

### LOW_AUTO — soát lại toàn bộ, sau khi sửa

| Nguyên tắc | Trạng thái |
|---|---|
| LOCAL_MOTION miễn phí không tự sang trả phí | ĐẠT — `local_motion` là điều kiện thứ hai của cổng, và `effectiveMotionSource` từ chối hướng đắt |
| ghim tay luôn thắng auto-route | ĐẠT — short-circuit, `lowAutoRouted: false`; và **nay chỉ ghim thật mới tính** |
| LOW_AUTO chỉ cho LOW | ĐẠT — `isAutoRoutable` + `not_low`; không biết độ khó thì `false` |
| không dùng khi thiếu keyframe | ĐẠT — `needs_keyframe` ở giai đoạn VIDEO, kiểm **trên đĩa** |
| không vượt số nhân vật đã đo | ĐẠT — `too_many_characters` (≤2) + trần cứng `MAX_CHARACTERS` kể cả ghim tay |
| DIRECTED_CAMERA không bị ép LOCKED | ĐẠT — bộ guardrail riêng, **không** có FINAL_FRAME/SCALE; cổng chỉ **không auto-route** nó |
| không fallback sang DEGRADED/DEPRECATED | ĐẠT — `fallbacks` lấy từ danh sách **đã lọc**; `lowAutoFallback` không bao giờ trỏ sang model trả phí khác |
| không paid POST khi chưa cấp phép | ĐẠT — đúng một trong hai cơ chế, và cổng 2b **nay thật sự bắn được** |

---

## Character Bible — 2026-09-19, $0

`LOCKED_ATTRIBUTES` đã nói với mọi prompt ảnh rằng **apparent age** và
**skin tone** không được đổi, từ ngày hệ thống nhân vật ra đời — mà hàng
`Character` **chưa từng có cột nào để nói hai thứ đó là gì**. Khoá một giá trị
không ai phát biểu là khoá đúng cái model ngẫu hứng ở khung đầu tiên. Xem QĐ-070.

Năm cột mới, tất cả mặc định `""`: `presentation`, `approximateAge`, `skinTone`,
`distinguishingFeatures`, `negativeIdentity`. **Không hàng nào đổi chuỗi
canonical** — trường rỗng bị bỏ qua, và chuỗi đó được băm vào khoá idempotency
của ảnh master, nên một byte lệch là mua lại toàn bộ ảnh nhân vật. Có test khoá
đúng chuỗi cũ từng byte.

> **Phần này đã bị QĐ-072 sửa lại cùng ngày.** Việc **bắt khai** tuổi và tông da
> là sai, và tệ hơn: hai thứ đó vẫn nằm trong mệnh đề khoá của mọi prompt dù
> không có giá trị nào đứng sau. Trạng thái hiện hành của Max/Leo/Mia là
> **READY** — xem mục *"Character Bible: khoá cái có thật"* bên dưới.

Chỗ trống vẫn chỉ là chỗ trống và **không tự điền** — một giá trị bịa ra ở đây sẽ
nằm trong mọi prompt của nhân vật đó mãi mãi và không ai biết nó là bịa.

- `characterReadiness()` → `NEEDS_CHARACTER_REFERENCE` / `NEEDS_IDENTITY_FIELDS`
  / `READY`. Thiếu ảnh báo **trước**, vì đó là thứ phải **đưa vào** chứ không gõ
  ra được.
- Import phát `character_needs_reference` (cảnh báo) và câu cảnh báo **nói thẳng
  là hệ thống sẽ không tự tạo ảnh**. Không có đường nào từ import tới Image API.
- Storyboard khai báo được cả Bible (11 trường, vài cách viết tên cột). Nhân vật
  **đã tồn tại thì không bị ghi đè**.
- `requireCharacterSheetsByName` — tên lạ nay **ném lỗi có nêu tên**. Trước đó
  `getCharacterSheetsByName` im lặng bỏ qua, prompt được dựng **không có khối
  nhận dạng nào** cho người đó, và model bịa ra một người **mới trong từng
  cảnh**. Mọi bước đều báo thành công.

---

## Dự toán: "cần tạo" tách khỏi "dùng lại" — 2026-09-19, $0

Ba trạng thái cho mỗi asset: `BUY` / `REUSE` / `NONE`. Một cảnh LOCAL_MOTION tốn
$0 tiền video và **không dùng lại gì** — gộp hai thứ lại thì bản xem trước khoe
"6 clip dùng lại" cho một lô chưa từng gọi model video. Xem QĐ-071.

`hasExistingVideo` / `hasExistingVoice` kiểm **trên đĩa**, không tin cột. Giọng
phải đủ **MỌI** dòng thoại mới tính là dùng lại.

Bản xem trước nhập storyboard nay có đủ: số video · số cảnh/video · LOCAL_MOTION
· VIDEO_AI · image BUY/REUSE · video BUY/REUSE · voice BUY/REUSE · chi phí
text/image/video/voice/quality/retries/**render ($0, nói ra)** · tổng mỗi video ·
tổng lô · **safetyMargin tách riêng** · trần đã duyệt · hạn mức tổng còn lại ·
**ví từng nhà cung cấp, không cộng chung** (`null` = *không rõ*, không phải
$0,00) · `costBasis`.

---

---

## Character Bible: khoá cái có thật — 2026-09-19 (đợt 2), $0

QĐ-070 thêm cột để khai tuổi và tông da, rồi **bắt khai** — nên Max/Leo/Mia, ba
nhân vật viết tay đầy đủ nhất dự án, đọc ra `NEEDS_IDENTITY_FIELDS`. Sai hai lần:
bắt khai một thứ thường không ai biết, và **vẫn dán "apparent age / skin tone"
vào mệnh đề khoá của mọi prompt** dù không có giá trị nào đứng sau. Xem QĐ-072.

```
Max   READY   1 ảnh · khoá: tóc, mặt, trang phục, dáng · không khoá: tuổi, tông da, đặc điểm
Leo   READY   1 ảnh · khoá: tóc, mặt, trang phục, dáng, phụ kiện · không khoá: tuổi, tông da, đặc điểm
Mia   READY   1 ảnh · khoá: tóc, mặt, trang phục, dáng · không khoá: tuổi, tông da, phụ kiện
```

- Ba trạng thái định nghĩa lại: `NEEDS_CHARACTER_REFERENCE` (không ảnh) →
  `NEEDS_IDENTITY_FIELDS` (có ảnh, **không một chữ** mô tả) → `READY` (có ảnh +
  ít nhất một nét). **READY không có nghĩa là đầy đủ**; phần thiếu là
  `warnings`, không phải cái chặn.
- `"unknown"` / `"not_specified"` / `"chưa rõ"` = đã nhìn vào ô đó, **vẫn không
  khoá**, và **không bao giờ** lọt vào prompt.
- Mệnh đề khoá dựng **mỗi nhân vật một dòng**, chỉ nêu thuộc tính đã khai. Cái
  không khai thì giao cho ảnh: *"Every other aspect … must match the reference
  image exactly"* — và câu đó chỉ xuất hiện khi **có ảnh thật**.
- `findCharacterByName` / `getCharacterSheetsByName` gấp hoa-thường. SQLite so
  BINARY, nên `"max"` từng trượt `"Max"` và người gọi tạo **người thứ hai**.
- Ảnh tham chiếu trùng khoá theo **nội dung** (`sha256Bytes`), không theo tên tệp.
- `identityFingerprint` — version đi theo **ngoại hình**, không theo `notes`,
  `seed` hay negative chung.

### Ảnh đã mua rồi thì resume KHÔNG mua lại

Đổi mệnh đề khoá làm đổi chuỗi prompt, mà khoá idempotency của ảnh **băm chính
chuỗi đó** — nên mọi cảnh đã xong bỗng trông như chưa mua. QĐ-065 cũng từng đổi
prompt và cũng có đúng lỗ này; chưa ai resume sau đó nên chưa ai thấy.

```
generateSceneImage(id)                 -> RESUME: dùng lại
generateSceneImage(id, { force: true }) -> TẠO LẠI có chủ ý: được mua
```

Điều kiện dùng lại là **tệp có thật + một ProviderJob ảnh đã hoàn tất**, không
phải chuỗi prompt. 4 test hồi quy trong `tests/image-reuse.test.ts`.

---

## Nhập nhiều storyboard một lần — 2026-09-19 (đợt 2), $0

Một lô là chỗ **duyệt tiền một lần**, không phải một đơn vị công việc. Trước đây
một dòng sai ở video thứ ba từ chối cả lần nhập. Xem QĐ-073.

```
materialiseImport(..., { allowPartial: true })
  -> nhập video sạch, BỎ QUA video lỗi, trả `skipped[]` có TÊN + LÝ DO
```

Mặc định **tắt**. Lỗi thuộc về **nguồn** (ZIP hỏng) vẫn chặn cả lô.

Mỗi video có vòng đời riêng, **dẫn xuất chứ không thêm cột**, từ `Project.status`
→ quyền chi → phán quyết dự toán:
`IMPORTED · BLOCKED · READY · APPROVED · RUNNING · COMPLETED · FAILED`.

### Dry-run 3 storyboard — `npm run import:dryrun`

Chạy trên **DB riêng dựng từ migration**, vì `Character` không thuộc về lô đầu
tiên nhắc tới nó. Fixture: `examples/batch-import-3/` (một video cố tình hỏng).

```
IMPORT -> VALIDATE -> CHARACTER RESOLVE -> ROUTING -> COST PREVIEW -> READY/BLOCKED

video doc duoc 3 · loi 1 · canh bao 5
BO QUA  Broken on purpose: khong co model video "runway/khong-co-model-nay"
READY   Cold feet    4 canh / 17,0s · LOCAL 3 / AI 1 · anh 0 tao 4 dung lai · $0,246100
READY   Two of them  6 canh / 25,0s · LOCAL 5 / AI 1 · anh 3 tao 3 dung lai · $0,274700
BatchBo   READY                     1 anh 4 canh
BatchBo2  READY                     1 anh 4 canh
BatchMi   NEEDS_CHARACTER_REFERENCE 0 anh 2 canh  thieu: hair, face, outfit, body
anh/clip/giong can tao 3 / 2 / 10 · dung lai 7 / 0 / 0 · tong $0,520800

DAT  da chi khong doi · ProviderJob khong doi · quyen chi DRAFT
DAT  tran da duyet = 0 · lo PLANNED · CREATE_ATTEMPT_TOKEN = 0
```

### Trang `/import` nói hết trước khi duyệt tiền, và không gọi API nào

Từ vựng giữ **phân biệt**: `REUSE` (đã trả tiền — tiết kiệm thật) ≠ `LOCAL_FREE`
($0 nhưng **chưa bao giờ** có gì để mua) ≠ `WILL_CREATE`. Kèm: tóm tắt từng video
(tên · số cảnh · thời lượng · 9:16 · số nhân vật có/thiếu ảnh), bảng từng cảnh
(nhân vật · camera · motion · keyframe · ảnh/clip/giọng BUY-REUSE-NONE · model ·
giá), và khối tiền đầy đủ gồm **dòng RENDER $0 nói ra**, biên an toàn tách riêng,
và **ví từng nhà cung cấp không cộng chung** (`null` hiện là *không rõ*).

Sửa hồ sơ nhân vật ngay tại chỗ: tải ảnh lên, đặt ảnh chính, sửa tên (kéo theo
các cảnh), 11 trường Bible — **không ép tuổi/tông da**, và **không có đường nào
tới Image API**.

---

---

## Sàn chuyển động cho h3_max — 2026-09-19 (đợt 3), $0

`runway/h3_max:768x1280` giữ nguyên `LOW_AUTO`, nhưng router nay **chỉ được tự
chọn** nó cho đúng cỡ động tác đã có bằng chứng. Xem QĐ-074.

```
ĐƯỢC (SUBTLE)   chớp mắt · gật/lắc đầu · nghiêng đầu · biểu cảm · thở ·
                đứng yên · đổi chân · nhìn · nửa bước ("one short pace")
BỊ CHẶN         chạy · nhảy · đánh nhau · quay người mạnh · nhảy múa · ngã ·
   (VIGOROUS)   ném · leo/đu · rượt đuổi · bơi/bay
BỊ CHẶN         đi · đứng lên/ngồi xuống · xoay người · cúi/quỳ · với/cầm ·
   (MODERATE)   đẩy/kéo/nâng · chỉ/vẫy · bước
BỊ CHẶN         hai nhân vật CHẠM nhau: ôm, bắt tay, trao đồ, xô/kéo
KHÔNG BIẾT      cũng CHẶN — điều kiện chưa ai đánh giá là chưa được thoả
```

Đối chiếu trên **29 cảnh thật**: SUBTLE 21 · MODERATE 3 · VIGOROUS 5. **Cả ba
clip h3_max đã mua đều SUBTLE** — sàn này được hiệu chỉnh theo chính các mẫu đó,
không mâu thuẫn với bất kỳ lần mua nào đã xảy ra. Cảnh MODERATE duy nhất đang
trỏ h3_max là **ghim tay**, không bị ảnh hưởng (ghim luôn short-circuit).

`npm run lowauto:prove` nay có **13 negative control** và vẫn `SAFE TO ENABLE`.

---

## QĐ-065 đã ĐÓNG — audit tìm ra 4 lỗ, đã vá — 2026-09-19 (đợt 3), $0

Bộ dò mâu thuẫn prompt ảnh chạy trên mọi ảnh từ QĐ-065, và **chưa ai đọc kết quả
của nó** trên văn phong storyboard viết tay. `npx tsx scripts/audit-image-guard.ts`
đẩy 8 dạng mâu thuẫn có tên qua bộ dò — **4 dạng im lặng**. Xem QĐ-075.

| Lỗ | Nguyên nhân | Đã vá |
|---|---|---|
| "does not smile" đọc thành "smile" | từ điển chỉ tra từ, không thấy phủ định | `NEGATED_SPAN_RE` cắt đoạn bị phủ định trước khi phân nhóm |
| "serious" vô hình | không thuộc nhóm biểu cảm nào | thêm nhóm `SERIOUS`, tách khỏi `CALM` |
| đứng + ngồi cùng lúc | không có luật nào cho tư thế | `posture_conflict`, **không tự sửa**, báo to |
| đám đông + "nothing else in frame" | luật cũ chỉ soi đạo cụ | `crowd_vs_empty_frame`, giữ đám đông |
| "red raincoat" vs bộ khoá | từ điển trang phục thiếu từ; luật cũ chỉ bắt đổi MÀU | `garment_vs_locked_identity` + mở rộng từ điển |

```
8/8 dạng bắt được
29 cảnh thật: 11 cảnh có phát hiện · TẤT CẢ tự xử lý được · 0 cảnh treo
3 luật mới: 0 lần kêu oan trên văn phong dự án này
```

---

## Không vẽ được ở bất kỳ giá nào — 2026-09-19 (đợt 3), $0

Nhân vật **không có ảnh tham chiếu VÀ không một chữ nào** mô tả ngoại hình là một
cái tên và một chỗ trống. Vẽ họ là mua một người lạ; cảnh sau là một người lạ
khác. **Phải trống cả hai vế** mới từ chối — hồ sơ viết đầy đủ mà chưa có ảnh
chuẩn là hoàn toàn bình thường. Xem QĐ-076.

- `generateSceneImage` ném lỗi **không thử lại**, nêu đích danh nhân vật.
- Preflight đánh video đó `BLOCKED`, status mới `NEEDS_CHARACTER_REFERENCE` —
  biết **trước khi duyệt tiền**.
- **Tiền của video bị chặn ra khỏi số sắp duyệt**: một quyết định (`status`) chi
  phối cả nhãn lẫn tiền.

```
trước: du toan chay duoc $0,520800  de xuat tran $0,50  (gồm cả video bị chặn)
sau  : du toan chay duoc $0,246100  de xuat tran $0,28  ke ca bi chan $0,520800
```

### `failJob` thôi đốt lượt thử cho lỗi đã khai là không thử lại

Nó đếm số lần thử và **chưa bao giờ đọc** cờ `retryable` mà cả `GenerationError`
lẫn `ProviderError` đều mang. Một lỗi 401 hay một request sai định dạng đốt sạch
ngân sách thử lại để chứng minh lại đúng một điều — miễn phí ở ca từ chối trước
POST, **không** miễn phí ở nơi nhà cung cấp đã nhìn thấy request.

### Ba video, ba trạng thái, một lần khởi động lại

```
A  COMPLETED  0 job mới · 0 hàng đổi · vẫn completed
B  dở dang    chạy tiếp · ảnh cảnh 1 DÙNG LẠI (1 image job) · cảnh 2 mới mua
C  BỊ CHẶN    hỏng riêng nó · 0 ProviderJob · KHÔNG dừng A/B
retryCount tất cả 0 · ProviderJob không trùng khoá · reservation không trùng
reserved = 0 (không treo đồng nào)
sau khi thêm ảnh cho C: CHỈ C chạy tiếp, A/B đứng yên tuyệt đối
```

---

## Nhập lại: một bản nhập MỚI, nói thẳng ra — 2026-09-19 (đợt 3), $0

`Project.importFingerprint` — băm **nội dung** storyboard (cast + cảnh, đã sắp
xếp), không băm thư mục hay thời điểm. Xem QĐ-077.

- **Dùng chung**: `Character` và ảnh tham chiếu của họ. Không bao giờ nhân đôi.
- **Không dùng chung**: `Project`. Lần nhập thứ hai là một việc thứ hai — thường
  mang bản sửa, vốn là lý do người ta nhập lại.
- Trang `/import` nói rõ: *"đây là một bản nhập MỚI … hệ thống KHÔNG giả vờ dùng
  lại video cũ: đây là một video riêng, sẽ tốn tiền riêng."*
- Cùng byte → cùng vân tay. File đã sửa → vân tay khác.
- **Nhập không tạo `ProviderJob` hay `CostReservation` nào**; quyền chi cả hai lô
  `DRAFT`, trần đã duyệt = 0. Có test khẳng định trực tiếp.

---

## Trang Nhân vật: đủ 11 trường, và nói rõ trường nào đang KHOÁ

Form `/characters` nay có cả 5 cột QĐ-070 (`presentation`, `approximateAge`,
`skinTone`, `distinguishingFeatures`, `negativeIdentity`). Mỗi ô mang một nhãn:

```
ĐANG KHOÁ    có giá trị -> prompt nêu đích danh, kèm "must not change"
chưa khoá    để trống   -> prompt giao thuộc tính đó cho ẢNH tham chiếu
mô tả thêm   không bao giờ nằm trong câu khoá (presentation, bảng màu, negativeIdentity)
```

Không ép tuổi/tông da. `applySheetEdit` là **một luật dùng chung** cho cả trang
Nhân vật lẫn ô sửa nhanh trên trang Nhập — trước đó mỗi nơi một bản, tức là hai
cơ hội để bất đồng về lúc nào tăng phiên bản.

Max/Leo/Mia: **READY**, mỗi người 1 ảnh chuẩn đã duyệt.

---

---

## Preflight sản xuất, giá THẬT — 2026-09-19 (đợt 4), $0

`npm run preflight:production` — lần đầu tiên định giá một lô nhiều video bằng
**giá thật**, registry thật, ví thật, nhân vật thật. Không POST, không chi.
Xem QĐ-080.

```
READY    All ears          5 cảnh · 5 LOCAL_MOTION · 0 clip · $0,247300
BLOCKED  Bite the bullet   5 cảnh · 4 LOCAL_MOTION · 1 clip · $0,659300
                           BLOCKED vì runway/h3_max:768x1280 CHƯA XÁC NHẬN GIÁ

TEXT $0 · IMAGE $0,432000 · VIDEO $0,400000 · VOICE $0,000200 · RENDER $0
RETRY (dự phòng ~3%) $0,027100
TỔNG nếu cả hai chạy  $0,906600      chỉ video chạy được  $0,247300
  (video 1 in ra $0,609900 = phần lọt vào trần; thật ra $0,659300 — QĐ-081)
ngân sách dự án còn   $1,198863      ví runway 551 credit = $5,51 (LIVE)
```

Fixture: `examples/batch-real-2/` — hai storyboard sạch, nhân vật **Max**
(READY, 1 ảnh chuẩn đã duyệt), không kèm keyframe nên 9 ảnh phải mua mới. Ảnh
là khoản lớn nhất: **48% tổng chi**.

### Bốn thứ lần chạy này tự tìm ra

**1. Preflight chưa bao giờ kiểm danh sách xác nhận (QĐ-078).** Lô `a690a290`
qua ổ khoá thứ nhất và chết ở ổ thứ hai giữa chừng; từ đó tới nay **không có gì
kiểm ở lúc lập kế hoạch**. Nay có status `NEEDS_PROVIDER_CONFIRMATION`, và nhờ
QĐ-076, tiền của video bị chặn **ra khỏi** trần đề xuất.

**2. Dự toán tính tiền viết kịch bản cho storyboard đã có sẵn (QĐ-079).** Đúng
cái sai QĐ-067 đã sửa cho keyframe. Tệ hơn con số: ngân sách đi dần theo từng
cảnh **bắt đầu từ tiền text**, nên khoản text ma ăn mất chỗ của cảnh cuối —
cảnh 5 của *Bite the bullet* mất ảnh vì lý do đó.

**3. Một con số bị cắt cụt im lặng (QĐ-081).** Bộ dự toán đi dần theo ngân sách
cảnh này qua cảnh khác, nên video vượt trần in ra **phần lọt vào trần** chứ không
phải chi phí. *Bite the bullet* báo $0,609900; thật ra **$0,659300**. Nay in cả
hai, và điều kiện kích hoạt là **bị cắt cụt** chứ không phải nhãn trạng thái —
bản sửa đầu của tôi kiểm theo nhãn và vẫn báo con số ngắn.

**4. Một DB sạch không trả lời đúng được.** Phải chép sang `ModelRegistry`
(giá/vòng đời/tin cậy), `ProviderConfig` (**khả dụng** — thiếu nó mọi nhà cung
cấp đọc ra "chưa sẵn sàng" và router từ chối mọi cảnh, trông y hệt lỗi định
tuyến), `Character` + ảnh **nguyên id**, và `StylePreset`. Hạn mức thì hạ xuống
đúng phần còn lại thật, vì phần "đã chi" nằm ở `CostEntry` không chép sang.

### Hai việc chỉ người vận hành làm được

| | |
|---|---|
| Xác nhận giá `runway/h3_max:768x1280` | trang Nhà cung cấp AI. **Không tự cấp.** |
| Trần/video $0,60 → $0,70 | video 1 giá thật $0,659300. Không tự cắt cảnh. |

---

## Preflight sản xuất, đợt 5 — **READY**, chờ bạn duyệt tiền, $0 chi thêm

Hai việc "chỉ người vận hành làm được" ở trên **đã được bạn quyết**. Kết quả chạy
lại `npm run preflight:production -- --max-per-video 0.70 --max-batch 1.00`:

```
READY    Bite the bullet   5 cảnh · 4 LOCAL_MOTION · 1 clip h3_max · $0,659300
READY    All ears          5 cảnh · 5 LOCAL_MOTION · 0 clip      · $0,247300

TEXT $0 · IMAGE $0,480000 · VIDEO $0,400000 · VOICE $0,000200 · RENDER $0
RETRY (dự phòng) $0,026400        TỔNG $0,906600
trần đề xuất $1,000000 · dự án còn $1,198863 · runway 551 credit = $5,51 (LIVE)
```

**0 mục HỎNG.** Không video nào BLOCKED, không thiếu xác nhận, không thiếu ảnh
chuẩn, không trùng reservation. Sau lô này dự án còn khoảng **$0,29**.

### Giá h3_max nay là giá **quan sát**, không phải giá chép lại

`pricingSource` = `OBSERVED_CHARGE`, dựa trên **7 task Runway đã trả tiền**
(5 giây = 40 credit, 7/7 không lệch). `verification` vẫn `BENCHMARK_VERIFIED`,
`lifecycle` vẫn `LOW_AUTO`, `reliability` vẫn `OK` — đọc lại từ DB để chứng minh.
Riêng tỷ lệ $0,01/credit vẫn là `MANUAL_DOCS` vì Runway không có endpoint báo giá.
`runway/h3_max:768x1280` đã vào `spend.confirmedProviders`. Xem QĐ-082.

### Con số $0,4800 tiền ảnh là **bằng chứng** lỗi cắt cụt đã hết

Đợt 4 báo IMAGE `$0,432000` — **9 ảnh**, vì cảnh 5 của *Bite the bullet* bị trần
nuốt mất. Nay `$0,480000` — **10 ảnh**, đúng số cảnh. Tổng vẫn `$0,906600` vì
đợt 4 đã cộng đúng phần chưa cắt vào "tổng nếu cả hai chạy"; thứ từng sai là con
số **hiển thị cho từng video**, và nay nó khớp với việc sẽ thật sự chạy.

Chạy ngược để chứng minh trần vẫn siết: `--max-batch 0,50` → NOT READY, và dự
toán vẫn báo **$0,906600**, không tự co xuống cho vừa. `--max-per-video 0,50` →
video 1 **BLOCKED** vì router từ chối cảnh 3 chứ **không** lặng lẽ đổi sang model
rẻ hơn. Xem QĐ-081, QĐ-083.

**Chưa chi một đồng nào:** `ProviderJob = 0`, `CostReservation = 0`,
`CREATE_ATTEMPT_TOKEN = null`, quyền chi `DRAFT`, lô `PLANNED`. Ledger production
đứng yên **$6,801137 / $8,00**.

---
