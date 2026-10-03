Tiếp tục Batch Video Factory hiện tại.

Có vấn đề UX thực tế ở video output:
phụ đề đang quá lớn và che gần toàn bộ sản phẩm/nhân vật.

Mục tiêu:
Thêm SIMPLE SUBTITLE + AUDIO + VOICE CONTROLS để người không rành kỹ thuật vẫn chỉnh video dễ dàng.

KHÔNG gọi API thật trong phiên phát triển/test.
KHÔNG regenerate Image/Video/Voice chỉ vì thay đổi style/volume/subtitle.

# 1. SUBTITLE ON/OFF

Trong Project / Render settings thêm:

PHỤ ĐỀ
[ BẬT / TẮT ]

Nếu TẮT:

* final render không burn subtitle
* subtitle data vẫn giữ nguyên
* bật lại không phải generate lại.

# 2. SUBTITLE SIZE

Cho phép:

Nhỏ
Vừa — mặc định
Lớn
Tùy chỉnh

Có slider kích thước chữ.

Không hard-code một font size cho mọi resolution.

Font size phải scale theo output profile:
9:16
16:9
1:1
4:5

Default phải đủ đọc nhưng KHÔNG che chủ thể.

# 3. AUTO FIT

Thêm:
“Tự động vừa khung” — mặc định ON.

Nếu câu dài:

* tự xuống dòng
* giảm nhẹ font nếu cần
* giới hạn 2 dòng mặc định
* không tràn ra ngoài canvas
* không che gần hết màn hình như hiện tại.

Không cho text chiếm quá nhiều chiều cao video.

# 4. SUBTITLE POSITION

Cho người dùng chọn:

TRÊN
GIỮA
DƯỚI — mặc định

Thêm slider:

“Dịch phụ đề lên / xuống”

Nhưng phải giữ trong safe area của platform.

TikTok/Shorts/Reels:
không để subtitle sát đáy hoặc vùng UI bên phải.

# 5. SUBTITLE STYLE

Preset đơn giản:

A. Trắng + viền đen — mặc định
B. Chữ trắng + nền tối
C. Tối giản
D. Nổi bật

Advanced:

* font
* font weight
* text color
* outline thickness
* shadow
* background opacity
* line spacing
* max width

Không bắt user bình thường phải chỉnh Advanced.

# 6. PRODUCT / CHARACTER SAFE AREA

Nếu scene có:

* Product Reference
* Character Reference
* face/focal point

subtitle không nên mặc định đè lên chủ thể chính.

Nếu hệ thống hiện có focal point/crop metadata thì reuse.
Không xây AI vision mới chỉ cho việc này nếu chưa cần.

# 7. VOICE SELECT

Trong project thêm mục:

GIỌNG THUYẾT MINH

Hiển thị:

* Provider
* Voice
* Model
* Language

Simple UI:
[ Chọn giọng ]
[ ▶ Nghe thử ]

Cho phép:

* voice
* speaking speed
* style/instructions nếu model hỗ trợ

# 8. VOICE PREVIEW / REUSE

Giữ nguyên QD-117:

Nghe thử voice
→ lưu asset
→ khi render dùng lại
→ không gọi TTS lần hai nếu text + voice settings không đổi.

Thay:
subtitle style
subtitle position
font size
music
SFX
volume

=> TTS POST = 0.

# 9. NARRATION VOLUME

Thêm:

Âm lượng lời đọc
0–200%

Default: 100%

Thay volume:
→ local processing
→ không regenerate TTS.

Có optional:
“Chuẩn hóa âm lượng lời đọc”

để các scene không scene to scene nhỏ khác nhau.

# 10. BACKGROUND MUSIC

Nếu project có music asset:

NHẠC NỀN
[ BẬT / TẮT ]

Âm lượng:
0–100%

Default khoảng thấp hơn narration.

Có:
“Tự giảm nhạc khi có lời”
Default ON.

Ducking phải làm local bằng FFmpeg.

Không cần paid music provider.

# 11. SOUND EFFECTS

SFX:
[ BẬT / TẮT ]

Volume:
0–100%

Cho phép tắt toàn bộ whoosh / ding / soft impact nếu user không muốn.

Thay SFX setting:
→ local render only
→ $0 API.

# 12. AUDIO MIX

Final audio pipeline:

VOICE
+
BACKGROUND MUSIC
+
SFX
↓
normalize/mix
↓
duck music dưới voice
↓
small fade in/out
↓
final audio

Không để music lấn voice.

# 13. RENDER AGAIN

Nếu chỉ thay:

* subtitle on/off
* subtitle size
* subtitle position
* subtitle style
* narration volume
* music volume
* SFX volume
* ducking

Expected:

TEXT API POST = 0
IMAGE API POST = 0
VIDEO API POST = 0
VOICE API POST = 0

Chỉ render local lại.

# 14. UI

Trong trang Project thêm một card dễ hiểu:

VIDEO OUTPUT

PHỤ ĐỀ
Bật
Kích thước: Vừa
Vị trí: Dưới
Kiểu: Trắng + viền đen

GIỌNG ĐỌC
Echo
Tốc độ: 1.0x
Âm lượng: 100%
[ Nghe thử ]

NHẠC NỀN
Bật
Âm lượng: 15%
Tự hạ nhạc khi có lời: Bật

HIỆU ỨNG ÂM THANH
Bật
Âm lượng: 40%

[ XEM TRƯỚC ]
[ RENDER LẠI ]

Advanced Settings collapse phía dưới.

# 15. VIDEO PREVIEW

Nếu có thể thực hiện nhẹ:
cho preview nhanh subtitle positioning trên khung hình mà không cần render full video.

Ít nhất phải có frame preview:

* đúng aspect ratio
* subtitle đúng size
* đúng position
* safe area visible nếu Advanced bật.

# 16. DEFAULT CHO VIDEO 9:16

Default phải ưu tiên:

* subtitle dưới nhưng trên vùng UI nền tảng
* tối đa 2 dòng
* không chiếm phần lớn màn hình
* không che sản phẩm/nhân vật chính
* white text + black outline
* auto-fit ON.

# 17. LEGACY PROJECT

Project cũ chưa có subtitle/audio settings:
dùng default mới an toàn.

Không migration phá project cũ.
Không regenerate media.

# 18. TEST

Test:

* subtitle OFF → render không subtitle
* subtitle ON → subtitle trở lại
* size small/medium/large
* vertical position
* long sentence auto-wrap
* max 2 lines
* 9:16 safe area
* 16:9 safe area
* change subtitle → 0 TTS POST
* change volume → 0 TTS POST
* voice preview reuse
* narration volume local only
* music ducking
* SFX mute
* render again uses existing assets
* legacy project
* no paid API calls.

# 19. SAFETY

Mock/local only.

PAID TEXT POST = 0
PAID IMAGE POST = 0
PAID VIDEO POST = 0
PAID VOICE POST = 0

# 20. REPORT

SUBTITLE TOGGLE:
SUBTITLE SIZE:
SUBTITLE POSITION:
SUBTITLE AUTO FIT:
SUBTITLE SAFE AREA:
SUBTITLE PREVIEW:
VOICE SELECT:
VOICE PREVIEW:
VOICE REUSE:
VOICE SPEED:
NARRATION VOLUME:
BACKGROUND MUSIC:
MUSIC DUCKING:
SFX CONTROLS:
LOCAL RERENDER:
PAID API POST:
TESTS:
LINT:
TYPECHECK:
BUILD:
SECRET SCAN:
FILES CHANGED:
BLOCKERS:

Cuối cùng trả lời:

1. Có thể tắt hoàn toàn phụ đề không?
2. Có thể chỉnh kích thước và vị trí phụ đề không?
3. Có thể đổi voice và nghe thử trước không?
4. Có thể chỉnh tốc độ/âm lượng narration không?
5. Có thể chỉnh nhạc nền và SFX riêng không?
6. Chỉnh các mục trên có gọi lại API trả phí không?

Không commit/push nếu tests liên quan, lint, typecheck hoặc build đang FAIL.
