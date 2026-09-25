# Batch Video Factory — V1.0.0

**Ngày phát hành:** 2026-09-25 · **Tag:** `batch-video-factory-v1.0.0` · **BATCH VIDEO FACTORY V1 = RELEASED + GITHUB RELEASE PUBLISHED**

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

Ứng dụng chạy trên máy (local-first) để sản xuất video ngắn 9:16 (YouTube Shorts /
TikTok / Reels) theo lô, từ một storyboard có sẵn hoặc từ một thành ngữ, với chi
phí API được kiểm soát tới từng request.

## Nghiệm thu bằng tiền thật

Lô `4d18d1a9`, 2 video, chạy thật 2026-09-25:

| Video | Cảnh | LOCAL_MOTION / VIDEO_AI | MP4 | Chi thật |
|---|---|---|---|---|
| Bite the bullet | 5 | 4 / 1 (`runway/h3_max`) | 21,000s · 1080x1920 · 30fps · h264 + aac | $0,605900 |
| All ears | 5 | 5 / 0 | 20,000s · 1080x1920 · 30fps · h264 + aac | $0,205889 |
| **Lô** | 10 | 9 / 1 | | **$0,811789** (dự toán $0,906600, trần $1,00) |

21 POST trả phí (10 ảnh, 1 clip, 10 giọng) · 0 retry · 0 ProviderJob trùng ·
reservation treo $0 · Runway 551 → 511 credit (khớp 40 credit của 1 clip 5s).

Chạy lại chính lô đó: **ProviderJob +0, chi thật +$0, POST +0**. Giả lập video A
xong / video B hỏng rồi resume: A không đổi (dự án, MP4, 11 ProviderJob), chỉ B
được render lại bằng FFmpeg, $0.

## Final QA — PASS (2026-09-25, $0)

UI thật + hai MP4 mở trực tiếp: đúng cảnh, cắt cảnh sạch, 0 khung đen, audio có,
giọng không bị cắt, subtitle khớp, clip Runway đúng cảnh 3, 21s / 20s. Xem MP4 /
MỞ OUTPUT / Mở dự án đều chạy. Sửa thêm một lỗi: trần/video của lô nhập không tới
được quyền chi mà gateway đọc (QĐ-089).

## Chức năng V1

- **Nhập storyboard** JSON / CSV / thư mục / ZIP → kiểm tra (mã lỗi + số dòng) →
  dự toán giá thật từng video + cả lô → duyệt → chỉ tạo phần còn thiếu.
- **Tạo từ thành ngữ** (luồng V1 gốc): kịch bản AI → cảnh → ảnh → motion → giọng → render.
- **Lô nhiều video**: một video hỏng chỉ dừng video đó; video khác chạy tiếp.
- **Render MP4** bằng FFmpeg tại máy: 1080x1920, giọng, nhạc nền, phụ đề (.srt + burn-in tuỳ chọn).
- **Trang giao diện**: Dự án video · Tạo hàng loạt (batch queue) · Nhập Storyboard ·
  Nhân vật · Chi phí · Nhà cung cấp AI · Mô hình AI · Cài đặt · Nhật ký.

## Nhà cung cấp đang hỗ trợ

| Loại | Model | Trạng thái |
|---|---|---|
| Ảnh | `openai/gpt-image-2:medium` | ACTIVE |
| Video AI | `runway/h3_max:768x1280` | **LOW_AUTO** — router chỉ tự chọn cho cảnh LOW, động tác SUBTLE |
| Video AI | `runway/gen4.5`, `wan3`, `veo3.1_fast`, `h3_max:480x854` | PIN_ONLY — chỉ khi ghim tay |
| Video AI | `runway/gen4_turbo` | ACTIVE nhưng DEGRADED — không tự chọn |
| Video AI | `openai/sora-2*` | DEPRECATED (nhà cung cấp tắt 2026-09-24) |
| Giọng | `openai/gpt-4o-mini-tts` | ACTIVE |
| Kịch bản | `groq/openai/gpt-oss-120b` | ACTIVE |

Trang **Mô hình AI** hiện nhãn vòng đời (ACTIVE / LOW_AUTO / PIN_ONLY / DEPRECATED /
DISABLED) và độ tin cậy (DEGRADED) cho từng model.

## Định dạng Import Storyboard

Mỗi video là một `storyboard.json` (hoặc một dòng mỗi cảnh trong CSV), ảnh đi kèm
đặt cạnh file. Ví dụ đầy đủ: `examples/batch-real-2/`, `examples/storyboard-import/`.

```json
{
  "video_id": "all-ears",
  "video_title": "All ears",
  "characters": [{ "character_id": "max", "character_name": "Max" }],
  "scenes": [{
    "scene_number": 1, "duration": 4,
    "visual_description": "...", "character_action": "...",
    "camera": "Locked static medium shot, no camera movement.",
    "dialogue": "Max: \"Go on, tell me the gossip.\"", "subtitle": "...",
    "image_file": "scene-01.png",
    "motion_mode": "LOCAL_MOTION",
    "priority": "LOW",
    "character_id": "max"
  }]
}
```

Cột CSV: `video_id, video_title, scene_number, duration, visual_description,
character_action, camera, dialogue, subtitle, image_file, motion_mode,
video_provider, video_model, priority`.

- `motion_mode`: `AUTO` | `LOCAL_MOTION` | `VIDEO_AI`. `VIDEO_AI` là chỉ thị, không bị hạ cấp âm thầm.
- `image_file` có mặt → ảnh được dùng lại, **không gọi Image API**.
- `video_provider` + `video_model` → ghim tay; ghim luôn thắng router.

## Character Bible

Mỗi nhân vật có ảnh tham chiếu chuẩn và 11 trường mô tả. Trường có giá trị bị
**khoá** trong prompt ("must not change"); trường trống giao cho ảnh tham chiếu.
Biểu cảm không phải identity: cảnh thắng bảng nhân vật. Nhân vật **không có ảnh
và không có mô tả** bị chặn trước khi duyệt tiền (`NEEDS_CHARACTER_REFERENCE`).

## LOCAL_MOTION

Cảnh không cần Video AI được làm chuyển động từ keyframe bằng FFmpeg tại máy —
**$0 tiền Video API**, không thể hỏng ở nhà cung cấp. `decideMotion` chạy trước
và là phán quyết cuối.

## Định tuyến Video AI

Ghim tay > chỉ thị storyboard > router. Router **không bao giờ** tự chọn model
DEPRECATED, DISABLED, PIN_ONLY hay DEGRADED. `LOW_AUTO` cần cả ba: lifecycle
LOW_AUTO, cảnh đủ điều kiện (LOW, SUBTLE, có keyframe), và **người duyệt lô đồng
ý riêng** cho router tự chọn.

## Kiểm soát ngân sách

Bốn lớp độc lập, cái nào chạm trước thì dừng:

1. **Hạn mức toàn cục** (Cài đặt) — hiện $8,00.
2. **Ví từng nhà cung cấp** — không cộng chung.
3. **MAX BATCH** — `BATCH_SPEND_AUTHORIZATION` do người duyệt đặt; giữ chỗ
   (reserve) trước mỗi request, quyết toán theo chi phí thật.
4. **MAX PER VIDEO** — video vượt trần bị dừng riêng, không kéo cả lô.

Thêm: danh sách **xác nhận giá** theo cặp provider/model; `AI_MOCK_MODE=true` là
công tắc an toàn chỉ sửa được trong `.env`.

## Resume / idempotency

- Mỗi request trả phí có một `idempotencyKey`; job đã xong → trả lại file, $0.
- Ảnh đã mua được dùng lại theo **file + ProviderJob completed**, không theo chuỗi
  prompt (prompt đổi không làm mua lại).
- Dự toán dùng **đúng điều kiện đó**, nên preflight của lô đã chạy báo REUSE.
- Resume không duyệt lại quyền chi; quyền chi đã đóng thì mọi POST bị chặn, chỉ REUSE chạy được.
- Một lần REUSE không ghi thêm dòng sổ cái hay Asset nào.

## Known limitations

- Trang lô dùng tập trạng thái hiện có (PLANNED / QUEUED / RUNNING / NEEDS_REVIEW /
  BUDGET_EXHAUSTED / COMPLETED / FAILED / CANCELLED); không đổi tên sang
  DRAFT / READY / BLOCKED trong V1.
- Lô thật đầu tiên được chạy bằng `scripts/run-real-multi-batch.ts` (một lần POST
  cho mỗi asset, không retry). Nút DUYỆT & CHẠY trên UI đi qua hàng đợi job; ở chế
  độ thật không có model quality nào, nên bước chấm điểm tự bỏ qua và không mua lại.
- Resume ghi lại các cột đường dẫn media trên cảnh đã xong (đổi `updatedAt`),
  không tạo media, job hay chi phí mới.
- Nhịp cảnh: giọng ngắn hơn cảnh 0,7–2,4s, nên có khoảng lặng giữa các câu (thẩm mỹ, không phải lỗi pipeline).
- `veo3.1_fast`, `wan3`, `h3_max:480x854` chưa benchmark — chỉ dùng khi ghim tay.
- MAX PER VIDEO / MAX BATCH đặt theo từng lô, chưa có ô sửa mặc định trong Cài đặt.
- Màu nền có thể nhảy giữa các cảnh dù storyboard ghi "same plain background" (Image AI, thẩm mỹ).
- Tên hiển thị của `h3_max:768x1280` trong DB vẫn ghi "(chưa benchmark)".
- Bản ghi quyền chi của lô `4d18d1a9` ghi trần/video $2,50 — đúng trần gateway đã áp lúc chạy (QĐ-089).

## Cách chạy

```
npm install
cp .env.example .env          # điền key; AI_MOCK_MODE=true để chạy thử miễn phí
npm run setup                 # prisma generate + db push + seed
npm run dev                   # http://localhost:3000
npm run smoke                 # import -> preflight -> chạy -> resume -> output, bằng mock, $0
```

Preflight giá thật cho một lô nhập (chỉ đọc, không chi):

```
AI_MOCK_MODE=false npx tsx scripts/run-real-multi-batch.ts --batch <id>
```

## Thư mục output

`data/projects/<projectId>/final/final_<id>.mp4`, phụ đề ở
`data/projects/<projectId>/subtitles/subtitles.srt`, báo cáo lô ở
`data/reports/batch-report-<batchId>.json`. Nút **MỞ OUTPUT** trên trang lô mở đúng
thư mục này.
