# QĐ-151 — Smart Motion Engine V2: nghiên cứu, benchmark và kế hoạch LOCAL_MOTION V2

**Trạng thái: NGHIÊN CỨU / BENCHMARK** (2026-10-23). **Chưa tích hợp vào production.**
- Không đổi `src/`, renderer production, dữ liệu project thật, QĐ-149/150.
- Không gọi API, $0.
- Người dùng ưu tiên **V2 1×** để phát triển tiếp, nhưng chưa duyệt chất lượng hình ảnh.

**Trang so sánh video:** `data/benchmarks/qd151/index.html`, bấm đúp để mở.

Ký hiệu độ tin cậy:
- **[ĐO]**: số đo bằng công cụ.
- **[MẮT]**: nhận xét bằng mắt.
- **[CHƯA KIỂM]**: mới dừng ở mức nghiên cứu.

---

## 1. Kiến trúc LOCAL_MOTION hiện tại (đọc từ mã nguồn)

| Thành phần | File | Việc làm |
|---|---|---|
| Chọn chuyển động | `src/domain/camera-director.ts`, `camera-grammar.ts`, `scene-plan.ts` | Camera Director dùng luật: loại cảnh, tham chiếu bắt buộc, preset, continuity → move, speed, easing |
| Render 1 cảnh ảnh tĩnh | `src/media/render.ts` `buildSceneNormalizeArgs` + `src/media/camera-motion.ts` `cameraZoompan` | Cover-crop 1080×1920 → phóng ×3 (5760, Lanczos) → RGB `gbrp` → `zoompan` (`d=frames+1`) → `fps=30` → `tpad` → x264 veryfast CRF 20 |
| Cảnh chưa có camera plan (V1) | cùng hàm | `zoompan=z='min(zoom+step,1.10)'` không phóng to trước; `x`, `y` mặc định 0 nên zoom bám góc trên-trái |
| Cảnh nhiều lớp | `camera-motion.ts` (2 lần gọi `cameraZoompan`, có `gbrap`) | Nền + cut-out PNG, parallax 2D |
| Chuyển cảnh | `src/media/transitions.ts` | `xfade` giữ đồng hồ (QĐ-129); CUT dùng concat |
| Ghép + xuất | `render.ts` `buildFinalWithMixArgs` | Burn phụ đề, logo, `-r 30`, AAC 48 kHz |

## 2. Nguyên nhân gây giật

### Đã xác nhận

1. **`zoompan` làm tròn vị trí và kích thước khung cắt về số nguyên.** [ĐO + mã nguồn]
   - Trong FFmpeg 6.1 `vf_zoompan.c`, `w`, `h`, `x`, `y` đều là biến `int`, nên phần thập phân bị cắt.
   - Vị trí và kích thước bị làm tròn độc lập nhau, nên tâm khung lắc tới 1 pixel nguồn (1/3 px đầu ra sau khi phóng ×3).
   - Camera production rất chậm (0,08–0,63 px/khung), nên sai số này ngang hoặc lớn hơn chuyển động.
   - Đo được độ lệch so với đường mượt **17–50% tốc độ**, trung bình **34,9%** (12 clip).
2. **Khung đứng yên ở đầu/cuối cảnh tilt/pan production.** [ĐO trên đầu ra filter, chưa qua encoder] TILT_UP có cặp khung 2→3 và 208→209 giống hệt nhau (MAD = 0), trong khi các khung khác thay đổi ~0,93. PAN_LEFT, TRUCK, ORBIT, ARC cũng có 1 khung đứng yên (bảng tương thích, mục 7).
3. **Chuỗi V1 (cảnh không có camera plan):** giật 33–36% [ĐO], zoom bám góc trên-trái.

### Đã kiểm, KHÔNG phải nguyên nhân
- FPS và timestamp: video production thật (1433 khung) đúng 30 fps CFR, pts đều 33,333 ms, 0 khung trùng [ĐO].
- Ghép cảnh: không thấy lệch VFR/CFR.
- Lỗi do trình phát: đã loại trừ, vì lỗi đo được ở đầu ra filter.

### Còn nghi ngờ, chưa đo riêng
- Burn phụ đề làm thay đổi khung hình, có thể bị cảm nhận nhầm là giật.
- Crossfade 0,2 s giữa hai chuyển động ngược chiều.

## 3. Mã nguồn mở đã nghiên cứu (chưa tải, chưa cài; theo yêu cầu người dùng)

| Dự án | Giấy phép | Nội dung | Máy này | Trạng thái |
|---|---|---|---|---|
| **FFmpeg** (đang dùng) | LGPL/GPL (bản đóng gói sẵn) | `perspective`: toạ độ thực, `eval=frame`, nội suy cubic, giữ alpha (đã thử) | Có | **Nền của V2** |
| RIFE ncnn Vulkan | MIT | Nội suy khung bằng GPU; zip Windows 431,5 MB | GTX 1660 SUPER có Vulkan | [CHƯA KIỂM], giữ trong nghiên cứu |
| DepthFlow | **AGPL-3.0**; model Depth Anything v2 (bản lớn hơn Small là CC BY-NC 4.0) | Parallax 3D từ depth map | Cần PyTorch + model | [CHƯA KIỂM]. Không dùng mã AGPL trong sản phẩm khi chưa đánh giá nghĩa vụ giấy phép |
| Revideo | MIT | Timeline/easing TypeScript, render qua Chromium headless | Cần npm + Chromium | [CHƯA KIỂM]; kỹ thuật easing đã làm được bằng FFmpeg |
| gl-transitions | MIT (2 shader BSD) | Chuyển cảnh GLSL | Cần runtime GL / FFmpeg build riêng | Chưa cần; `xfade` sẵn có đủ dùng |

**Máy:** i5-9400F 6 nhân · RAM 31,9 GB · GTX 1660 SUPER 6 GB · ổ F trống 538 GB · FFmpeg 6.1.1. **Không thêm dependency nào.**

## 4. Prototype V2 (`scripts/qa/qd151/motion-v2.ts`)
- Khung nhìn mô tả bằng toạ độ thực đã chuẩn hoá, không làm tròn. Render bằng `perspective` (`interpolation=cubic`, `eval=frame`).
  - 1×: thẳng ở 1080×1920.
  - 2×: render ở 2160×3840 rồi thu nhỏ Lanczos.
- **Biến `on`/`in` của `perspective` đếm từ 1** [ĐO], nên phải dùng `(on-1)`. Đây là lỗi tìm thấy và đã sửa trong prototype.
- `fromProductionZoompan()`: lấy **đúng biểu thức `zoompan` production sinh ra** và đổi sang đơn vị chuẩn hoá (`iw`, `ih` → 1, `zoom` → `ld(2)`, `on` → `(on-1)`), có kẹp khung trong ảnh giống `av_clipd` của zoompan. Nhờ vậy chỉ có **một định nghĩa đường đi cho cả hai renderer**.
- Easing thêm: LINEAR, SINE, SMOOTHSTEP, SMOOTHERSTEP. 10 đường đi. 4 mức cường độ cố định:

  | Mức | Zoom | Lia | Tốc độ cuối |
  |---|---|---|---|
  | SUBTLE | 5% | 5% | 0,30 |
  | NORMAL | 8% | 8% | 0,30 |
  | DYNAMIC | 14% | 12% | 0,40 |
  | CINEMATIC | 10% | 7% | 0,15 |

- `suggest.ts`: ánh xạ quyết định của Camera Director sang V2, thêm luật bối cảnh và luật an toàn. Tự kiểm 8/8 PASS.

## 5. Kết quả benchmark cuối cùng

**Bộ ảnh** (ảnh AI đã mua, 1024×1536):
- S1 hành lang (chiều sâu phối cảnh; dữ liệu không có ảnh đường phố thật).
- S2 công viên (2 nhân vật, cây).
- S3 sản phẩm "LOCK&LOCK" (chữ, khuôn mặt).

**Cấu hình:** 1080×1920 · 30 fps · 7 s · x264 veryfast CRF 20 cho mọi phương án. 66 clip + 28 cặp tương thích.

| Phương án | Clip | Giật TB [ĐO] | Khung đứng yên [ĐO] | Render / 7 s [ĐO] | MB TB |
|---|---|---|---|---|---|
| A — LEGACY (production) | 12 | **34,9%** | 2 (cuối tilt) | 12,3 s | 1,08 |
| **V2 1×** | 12 | **6,2%** | 1* | **8,8 s** | ~1,2 |
| V2 2× | 12 | 6,3% | 1* | 27,1 s | 1,18 |
| V2 Easing (SMOOTHERSTEP, 2×) | 12 | 7,4% | 6* | 26,7 s | 1,26 |
| Chuỗi V1 (chưa có plan) | 3 | 34,4% | 0 | 1,9 s | 1,59 |
| Đối chứng đứng yên | 1 | 0 px | (đứng yên thật) | 2,5 s | 0,36 |

\* Khung "đứng yên" của V2 nằm ở đầu/cuối nơi easing chậm lại; đầu ra filter (chưa qua encoder) chuyển động đều tới khung cuối.

- **Tổng quãng zoom như nhau:** A 7,09%, V2 7,07% [ĐO].
- **Độ nét khung cuối** (variance Laplacian, 1 khung) [ĐO]: A 123 · V2 1× 149 · V2 2× 169.
- **Tài nguyên** (1 lần đo) [ĐO]: A ~1,4 nhân CPU, RAM 430 MB; V2 2× ~3,3 nhân, RAM 525 MB; V2 1× nhanh hơn A (CPU riêng chưa đo).
- **Méo hình** [MẮT]: không thấy. Khuôn mặt, kính, chữ "LOCK&LOCK / MY FAVORITE COLOR THERMO BOTTLE" đọc rõ ở cả 4 phương án (dải phóng to 2× trên trang).

## 6. Đánh giá V2 1×

**Điểm mạnh:**
- Giật 34,9% → 6,2% [ĐO].
- Nhanh hơn production khoảng 28% (8,8 s so với 12,3 s) [ĐO].
- Không khựng đầu/cuối như tilt/pan production [ĐO].
- Nét hơn production một chút [ĐO, 1 khung].
- Dùng FFmpeg sẵn có, không dependency mới, $0.
- Giữ nguyên đường đi production (một nguồn biểu thức), nên Camera Director, preset và speaker lean không đổi.

**Hạn chế:**
- Chất lượng hình ảnh chưa được người dùng duyệt [MẮT].
- Benchmark mới có 3 ảnh dọc 1024×1536, chưa đại diện cho mọi trường hợp: ảnh 16:9, ảnh nhỏ, ảnh nhiều chữ nhỏ, cảnh nhiều lớp.
- 1× không siêu mẫu: chi tiết rất mảnh có thể răng cưa nhẹ hơn 2× [MẮT, cần xem dải phóng to].
- Không tạo chiều sâu 3D (vẫn là camera 2D trên ảnh phẳng).
- WHIP_PAN và CRASH_ZOOM không cải thiện (cố ý bật mạnh rồi giữ khung).
- CPU 1× chưa đo riêng; chưa thử 4K.

## 7. Tương thích từng kiểu camera (`scripts/qa/qd151/compat.ts`, 540×960, 4 s) [ĐO]

| Kiểu camera production | Cách render trên ảnh tĩnh | V2 | Giật A → V2 | Đứng yên A / V2 |
|---|---|---|---|---|
| SLOW_ZOOM_IN / OUT, AUTO | chính nó | OK | 14,3 → 4,3% / 11,6 → 4,9% | 0 / 0 |
| PAN_LEFT / RIGHT | chính nó | OK | 22,1 → 7,2% / 21,8 → 6,6% | 1 / 0 · 0 / 0 |
| PAN_UP / DOWN, TILT_UP / DOWN | chính nó | OK | ~29,8 → 11–13% | 0 / 0 |
| PUSH_IN, PULL_BACK, DOLLY_IN / OUT | xấp xỉ | OK | 19,8 → 6,5% / 16,8 → 7,2% | 0 / 0 |
| TRACK_LEFT / RIGHT, TRUCK_LEFT / RIGHT | xấp xỉ | OK | 18–24 → 5–7% | TRUCK_LEFT 1 / 0 |
| ORBIT_LEFT / RIGHT, ARC | fallback có sẵn → TRUCK | OK | 22 → 7% | 1 / 0 |
| CRANE_UP / DOWN | fallback có sẵn → TILT | OK | 29,8 → 11–13% | 0 / 0 |
| PARALLAX, HANDHELD_SOFT, GIMBAL | xấp xỉ | OK | 23 → 5,4% · 19,4 → 4,6% · 19,4 → 7,3% | GIMBAL 1 / 2 (rất chậm) |
| Nghiêng theo người nói (speaker lean) | cộng vào move | OK | 35,2 → 9,9% | 0 / 0 |
| WHIP_PAN, CRASH_ZOOM | hiệu ứng nhanh rồi giữ | OK, **không cải thiện** | ~85% / ~77% (ý đồ thiết kế) | 108 / 108 (cố ý giữ khung) |
| STATIC | không có camera | Giữ nguyên | — | — |

Tốc độ và quãng đường của V2 khớp production (sai khác ≤ 0,02 px/khung). V2 ở 540p nhanh hơn ~2,6 lần.

## 8. Khi nào phải dùng fallback (LOCAL_MOTION cũ)

1. **Project cũ / cảnh đã render:** luôn giữ renderer cũ, trừ khi người dùng tự chọn Motion Quality khác.
2. **Cảnh nhiều lớp (cut-out PNG, `gbrap`):** `perspective` giữ alpha [ĐO, ảnh thử], nhưng chưa benchmark parallax nhiều lớp. Giai đoạn đầu dùng renderer cũ.
3. **Clip video** (VIDEO_AI hoặc clip người dùng tải lên): không có camera local; không đổi.
4. **Chuỗi V1** (cảnh chưa có camera plan): giữ nguyên cho đến bước 3 của kế hoạch.
5. **Biểu thức không đọc được**, hoặc FFmpeg báo lỗi khi dùng V2: tự động render lại bằng renderer cũ và ghi log. Không bao giờ để cảnh hỏng.
6. **WHIP_PAN / CRASH_ZOOM:** V2 chạy được nhưng không lợi gì; có thể giữ renderer cũ.

## 9. Kế hoạch tích hợp an toàn (CHỈ thực hiện sau khi người dùng duyệt video)

**Motion Quality** (tuỳ chọn theo project, lưu trong cấu hình camera / video output):

| Giá trị | Renderer | Dùng khi |
|---|---|---|
| `LEGACY` | `zoompan` hiện tại | Mặc định của mọi project cũ; fallback |
| `SMOOTH_V2` | `perspective` 1× | **Đề xuất mặc định cho project MỚI**, chỉ bật sau khi duyệt và test hồi quy |
| `HQ_V2` | `perspective` 2× | Bản xuất chất lượng cao; chậm khoảng 3 lần |

**Các bước:**
1. Thêm `cameraPerspective()` trong `src/media/camera-motion.ts`, dùng chung `cameraZoompan` để sinh biểu thức (như `fromProductionZoompan`), nên đường đi không bị nhân đôi.
   - `buildSceneNormalizeArgs` chọn renderer theo Motion Quality.
   - Ảnh vào bằng `-loop 1 -framerate fps -t dur` + `-frames:v N`; bỏ `zoompan`/`fps`/`tpad` cho nhánh V2.
2. **Render recipe và segment cache:** thêm `motionQuality` vào recipe chỉ khi khác `LEGACY`. Project cũ giữ nguyên recipe, không bị render lại ngầm.
3. **Fallback tự động** theo mục 8; log ghi rõ renderer đã dùng.
4. **UI:** một ô chọn "Chất lượng chuyển động" trong thẻ camera/Video output (Legacy / Mượt V2 / Chất lượng cao V2), ghi rõ "$0, render tại máy".
5. **Không đụng:** Audio Mixer QĐ-150, giọng, phụ đề, Import Storyboard, batch executor, chuyển cảnh `xfade`.
6. Sau đó mới tính: chuỗi V1 → V2 (zoom vào tâm); cảnh nhiều lớp → V2; cường độ và easing V2 vào Camera Director.

## 10. Kế hoạch kiểm thử trước khi tích hợp

**Đo tự động** (mỗi bài: `motion_probe.py` + ffprobe):
- Không có khung đứng yên bất thường ở giữa cảnh.
- Không giật quá ngưỡng (đề xuất ≤ 12% cho chuyển động mượt).
- CFR 30, đủ số khung, thời lượng khớp timeline.

| # | Bài kiểm | Kiểm tra gì |
|---|---|---|
| 1 | Video 1 cảnh | Khung đầu/cuối không đứng yên; thời lượng đúng |
| 2 | Video nhiều cảnh (cut + crossfade) | Chuyển động liên tục qua `xfade`; đồng hồ timeline không lệch |
| 3 | 9:16 | Như benchmark |
| 4 | 16:9 (và 1:1) | Kẹp khung, không lộ viền đen, đúng tỷ lệ |
| 5 | Video có chữ (sản phẩm, poster) | Chữ không rung, không méo (dải phóng to 2×) |
| 6 | Chân dung / khuôn mặt | Không cắt đầu/tay, không méo |
| 7 | Sản phẩm (tham chiếu bắt buộc) | Giữ giới hạn zoom `critical` |
| 8 | Video có âm thanh (Audio Mixer QĐ-150) | Tiếng không đổi (so MD5 bản mix), đồng bộ hình–tiếng |
| 9 | Video có phụ đề burn | Vị trí và cỡ không đổi; đo giật trên vùng không có chữ |
| 10 | Batch nhiều video | Thời gian render, `maxConcurrentLocalRenders`, không lỗi; job retry dùng đúng renderer |
| 11 | Ảnh nhỏ (< 1080 px), ảnh 16:9 đặt vào 9:16, ảnh PNG có alpha | Fallback đúng, không treo |
| 12 | Mọi kiểu camera | Lặp lại `compat.ts` ở 1080×1920 |
| 13 | Hồi quy | Toàn bộ test suite (~55 phút, chạy 1 lần), build, lint; project cũ giữ nguyên recipe, không render lại ngầm |
| 14 | Người dùng | Xem video thật từ 1 lô thử, chấm bằng mắt |

## 11. Chi phí
$0 API. Mọi thứ chạy bằng FFmpeg CPU tại máy. Không tải, không cài thêm.

## 12. Script nghiên cứu (`scripts/qa/qd151/`)
Không gọi API; chỉ đọc ảnh project; chỉ ghi vào `data/benchmarks/qd151/`.

| Script | Việc làm |
|---|---|
| `motion-v2.ts` | Prototype renderer V2 + `fromProductionZoompan` |
| `bench.ts` | 66 clip + video 4 khung + dải phóng to + `results.json`. `--only-probe` chỉ render clip còn thiếu |
| `compat.ts` | Mọi kiểu camera: production vs V2 → `compat.json` |
| `motion_probe.py` | Đo chuyển động (numpy + FFmpeg; chạy bằng `python -I`) |
| `report.ts` | Tạo `index.html` |
| `suggest.ts` | Gợi ý camera V2 + tự kiểm |

Chạy lại: `npx tsx scripts/qa/qd151/bench.ts` (khoảng 40 phút) → `npx tsx scripts/qa/qd151/compat.ts` → `npx tsx scripts/qa/qd151/report.ts`.
