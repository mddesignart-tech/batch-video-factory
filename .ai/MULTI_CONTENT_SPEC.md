Tiếp tục phát triển Batch Video Factory từ codebase hiện tại.

Mục tiêu nâng cấp lớn tiếp theo:

BIẾN TOOL TỪ “FUNNY IDIOMS VIDEO FACTORY”
THÀNH
“BATCH VIDEO FACTORY – MULTI-CONTENT VIDEO ENGINE”

Tool phải có thể làm nhiều loại video khác nhau mà KHÔNG phải viết lại pipeline cho từng chủ đề.

Các tính năng V1.2 hiện tại đang ổn phải được giữ nguyên:

* Storyboard
* Scene pipeline
* Character consistency
* Image AI
* Video AI
* LOCAL_MOTION
* Voice / Voice Preview / Voice Reuse
* Subtitle
* Asset Library
* Resume
* Cost protection
* Platform presets
* Final render
* Reuse / idempotency
* Queue
* Preflight
* Smooth/consistency hiện có

KHÔNG refactor lớn nếu không cần.
KHÔNG phá project cũ.
KHÔNG gọi API thật trong quá trình phát triển/test.
KHÔNG tự mua Image / Video / Voice.
Không hard-code tool vào một chủ đề cụ thể.

Trước khi sửa:

1. đọc kiến trúc hiện tại
2. xác định phần nào đang hard-code “Thành ngữ”
3. xác định phần nào có thể giữ nguyên
4. đề xuất migration tối thiểu
5. sau đó mới triển khai.

---

# 1. KIẾN TRÚC MỤC TIÊU

Pipeline chung phải trở thành:

CONTENT SOURCE
↓
CONTENT TEMPLATE
↓
SCRIPT ENGINE
↓
SCENE PLANNER
↓
STORYBOARD
↓
ASSET GENERATION
↓
VOICE
↓
MOTION / VIDEO AI
↓
SUBTITLE
↓
SMOOTH PASS
↓
FINAL RENDER

Các chủ đề khác nhau chỉ thay:

* template
* prompt
* tone
* scene structure
* audience rules

Không được viết một pipeline riêng cho:

* Thành ngữ
* Review sản phẩm
* Động vật
* Đồ chơi
* Review AI
  ...

---

# 2. GIAO DIỆN TẠO VIDEO MỚI

Thay vùng hiện tại đang tập trung vào “Thành ngữ” bằng giao diện dễ hiểu:

## BƯỚC 1

“Bạn muốn làm loại video nào?”

Các card lớn:

📚 Học tiếng Anh
🛍 Review sản phẩm
🤖 Review công cụ AI
🧸 Thế giới đồ chơi
🐾 Động vật
📖 Kể chuyện
💡 Kiến thức
📢 Quảng cáo
🎬 Tự do / Custom

“Thành ngữ” trở thành một template bên trong:
HỌC TIẾNG ANH → THÀNH NGỮ

Không xóa dữ liệu thành ngữ cũ.

---

# 3. NGUỒN NỘI DUNG

Sau khi chọn loại video:

“Bạn muốn bắt đầu từ đâu?”

Các lựa chọn:

## A. NHẬP Ý TƯỞNG / PROMPT

Ô lớn:

“Bạn muốn video nói về điều gì?”

Ví dụ:

“Làm video 30 giây giới thiệu 5 lợi ích của ChatGPT dành cho cửa hàng nhỏ.”

AI:

* hiểu chủ đề
* viết script
* chia scene
* tạo dialogue/narration
* tạo mô tả hình ảnh
* image prompt
* video prompt
* subtitle

---

## B. DÁN VĂN BẢN

Cho phép dán:

* bài viết
* caption
* tài liệu
* nội dung Facebook
* bài blog
* nội dung sản phẩm
* script dài

AI xử lý:

TEXT
→ hiểu nội dung
→ lấy ý chính
→ rút gọn theo thời lượng
→ chia scene
→ tạo storyboard.

Phải cố gắng giữ đúng nội dung nguồn.

Không tự bịa thông tin quan trọng.

---

## C. DÁN URL

Thiết kế kiến trúc cho phép URL source.

Nếu hiện tại chưa có web extraction service:

* tạo abstraction/content-source interface
* có thể để URL là feature gated nếu cần

Không scrape trái phép.
Không phụ thuộc cứng vào một website cụ thể.

Sau này URL có thể dùng cho:

* sản phẩm
* bài viết
* landing page
* AI tool
* tài liệu public.

---

## D. TẢI ẢNH / VIDEO

Người dùng có thể upload:

* ảnh sản phẩm
* ảnh nhân vật
* B-roll
* clip thật
* logo

Các file phải vào Asset Library.

AI ưu tiên reuse asset thật.

Không regenerate ảnh nếu asset thật phù hợp.

---

## E. NHẬP STORYBOARD

Giữ nguyên tính năng hiện tại:

* JSON
* CSV
* folder
* ZIP
  nếu đã có.

---

# 4. CONTENT TEMPLATE ENGINE

Tạo một abstraction kiểu:

ContentTemplate

Không hard-code logic template vào UI.

Mỗi template có ít nhất:

id
name
category
description
defaultDuration
defaultAudience
defaultLanguage
scriptStructure
tone
sceneRules
visualRules
voiceRules
ctaRules
safetyRules

Có thể dùng JSON/config/database tùy kiến trúc hiện tại.

Mục tiêu:
sau này thêm một loại video mới bằng template,
không phải sửa pipeline chính.

---

# 5. TEMPLATE: HỌC TIẾNG ANH

Bao gồm:

* Thành ngữ
* Từ vựng
* Hội thoại
* Grammar tip
* Pronunciation tip
* Common mistakes
* Mini story bằng tiếng Anh

Ví dụ Thành ngữ:

HOOK
↓
literal situation
↓
mistake/funny moment
↓
real meaning
↓
example
↓
recap

Giữ nguyên thư viện 133 thành ngữ hiện tại nếu có.

---

# 6. TEMPLATE: REVIEW SẢN PHẨM

Đây là template quan trọng.

Cho phép đầu vào:

* prompt
* mô tả sản phẩm
* ảnh sản phẩm
* URL
* thông số
* ưu/nhược điểm do người dùng nhập.

Các format review:

1. Review nhanh
2. 3 lý do nên cân nhắc
3. Problem → Solution
4. Hướng dẫn sử dụng
5. Ưu / Nhược điểm
6. So sánh
7. Top sản phẩm
8. Video affiliate
9. Product showcase

Cấu trúc mặc định ví dụ:

HOOK
↓
SẢN PHẨM LÀ GÌ
↓
2–3 ĐIỂM NỔI BẬT
↓
CÁCH DÙNG / MINH HỌA
↓
ƯU / NHƯỢC
↓
PHÙ HỢP VỚI AI
↓
CTA

Không được giả vờ người dùng đã trải nghiệm sản phẩm nếu không có dữ liệu.

Không viết:
“Tôi đã dùng 2 tuần...”
nếu người dùng không cung cấp trải nghiệm đó.

Thay bằng:
“Điểm đáng chú ý...”
“Theo thông tin sản phẩm...”
“Sản phẩm hướng tới...”

---

# 7. TEMPLATE: REVIEW AI

Phù hợp kênh review AI.

Cấu trúc gợi ý:

HOOK
↓
AI này làm gì
↓
3 tính năng đáng chú ý
↓
demo/use case
↓
ưu điểm
↓
hạn chế
↓
phù hợp với ai
↓
CTA

Cho phép:

* prompt
* URL
* text
* screenshot
* asset do user cung cấp.

---

# 8. TEMPLATE: THẾ GIỚI ĐỒ CHƠI

Cho phép tạo:

* câu chuyện đồ chơi
* xe cộ
* robot
* động vật đồ chơi
* công trường
* tàu hỏa
* máy bay
* mô hình
* mini adventure

Ví dụ:

“Xe tải đồ chơi khám phá công trường.”

Tool tạo:

* nhân vật
* cảnh
* hành động
* voice
* sound effect suggestion
* visual prompt.

Ưu tiên hình ảnh vui, rõ, dễ theo dõi.

---

# 9. TEMPLATE: ĐỘNG VẬT

Các dạng:

* Animal facts
* Fun facts
* Mini documentary
* Animal story
* Guess the animal
* Top 5
* So sánh động vật
* Video trẻ em

Không được gán hành vi/sự thật sinh học sai nếu content source không hỗ trợ.

Nếu dùng AI-generated factual content:
đánh dấu internally là generated content cần review.

---

# 10. TEMPLATE: KỂ CHUYỆN

Có:

* truyện ngắn
* câu chuyện giáo dục
* mini adventure
* funny story
* emotional story
* bedtime style
* serialized story

Có:
Character Bible
scene continuity
location continuity
costume continuity
visual style consistency.

---

# 11. TEMPLATE: KIẾN THỨC

Dùng cho:

* khoa học
* lịch sử
* công nghệ
* Photoshop
* AI
* mẹo vặt
* giáo dục
* giải thích khái niệm.

Cấu trúc:

HOOK
↓
VẤN ĐỀ / CÂU HỎI
↓
GIẢI THÍCH
↓
VÍ DỤ
↓
KẾT LUẬN

---

# 12. TEMPLATE: QUẢNG CÁO

Các dạng:

* giới thiệu dịch vụ
* sản phẩm
* menu
* in ấn
* sự kiện
* sale
* local business

Cho phép:
logo
brand colors
product images
CTA
phone
website
Zalo/contact text.

Không ép mọi project phải có CTA.

---

# 13. CUSTOM MODE

Rất quan trọng.

Cho phép người dùng:

“Tự do / Custom”

Người dùng chỉ cần nhập:

“Làm video 45 giây về…”

Tool không ép theo template Thành ngữ.

Có thể chọn:

* Narration
* Dialogue
* Mixed
* No voice

---

# 14. NGÔN NGỮ

Tách Language khỏi Content Type.

Các lựa chọn ban đầu:

* Tiếng Việt
* English
* Việt + Anh
* Tự động theo nội dung

Kiến trúc phải cho phép thêm:

* 中文
* 日本語
* 한국어
* các ngôn ngữ khác

sau này mà không sửa pipeline.

Language phải ảnh hưởng:

* script
* dialogue
* narration
* subtitle
* TTS voice
* punctuation
* text overlays

Không hard-code English vì module Thành ngữ cũ.

---

# 15. SONG NGỮ

Nếu chọn Việt + Anh:

Cho phép mode:

A.
English voice
Vietnamese subtitle

B.
Vietnamese explanation
English example

C.
English + Vietnamese alternating

D.
Bilingual subtitle

Không bắt buộc triển khai toàn bộ mode phức tạp ngay nếu kiến trúc chưa hỗ trợ.

Nhưng data model phải không khóa đường phát triển.

---

# 16. ĐỐI TƯỢNG NGƯỜI XEM

Thêm:

“Video dành cho ai?”

* Trẻ nhỏ
* Thiếu nhi
* Học sinh
* Người mới bắt đầu
* Người lớn
* Chuyên môn
* Chung

Template dùng audience để điều chỉnh:

* độ dài câu
* từ vựng
* tốc độ
* mức giải thích
* visual density
* scene duration.

Không dùng audience để thay đổi nội dung theo cách không an toàn.

---

# 17. TONE / PHONG CÁCH NỘI DUNG

Simple Mode:

* Vui vẻ
* Tự nhiên
* Chuyên nghiệp
* Năng động
* Nhẹ nhàng
* Giáo dục
* Kịch tính
* Tự động

Không bắt người dùng viết prompt phong cách.

---

# 18. VISUAL STYLE

Giữ dropdown hiện tại nếu đã có:

* 3D Cartoon
* Realistic
* Cinematic
* Product
* Infographic
* Illustration
* Minimal
* Auto

Content Template chỉ đề xuất default.

Người dùng vẫn có quyền đổi.

---

# 19. THỜI LƯỢNG

Người dùng chỉ cần chọn:

15 giây
30 giây
45 giây
60 giây
Tùy chỉnh

Script Engine tự quyết định số scene hợp lý.

Không cố ép 6 scene cho mọi video.

Ví dụ:

15s → khoảng 3–4 scene
30s → khoảng 5–7 scene
60s → khoảng 8–12 scene

Nhưng đây chỉ là heuristic, không hard-code tuyệt đối.

---

# 20. NỀN TẢNG

Reuse Platform Preset vừa xây:

* TikTok
* YouTube Shorts
* Instagram Reels
* Facebook Reels
* YouTube ngang
* Square
* Feed portrait
* Custom

Người dùng không cần nhập resolution thủ công.

---

# 21. SIMPLE CREATION FLOW

Mục tiêu:

Người không rành kỹ thuật có thể tạo project chỉ trong 4 bước.

### BƯỚC 1

Bạn muốn làm video gì?

[ Review sản phẩm ]

### BƯỚC 2

Bạn muốn bắt đầu từ đâu?

[ Nhập ý tưởng ]
[ Dán nội dung ]
[ Tải ảnh ]
[ URL ]

### BƯỚC 3

Thiết lập cơ bản

Ngôn ngữ: Tiếng Việt
Thời lượng: 30 giây
Nền tảng: TikTok
Phong cách: Tự động

### BƯỚC 4

[ TẠO KỊCH BẢN ]

Không tạo media trả phí ở bước này.

---

# 22. SCRIPT PREVIEW

Sau “Tạo kịch bản”:

Cho người dùng xem trước:

* Title
* Hook
* Scene list
* Dialogue/narration
* subtitle
* visual descriptions

Cho sửa trực tiếp.

Có nút:

DUYỆT KỊCH BẢN

Chỉ sau khi duyệt mới tới bước Media.

---

# 23. SCRIPT → STORYBOARD

Tất cả Content Template phải convert về cùng một Storyboard Schema.

Ví dụ:

project
scenes[]

scene:

* id
* order
* duration
* speakers[]
* dialogueLines[]
* narration
* subtitleLines[]
* visualDescription
* imagePrompt
* videoPrompt
* motion
* camera
* characters[]
* assets[]
* voicePlan
* generationPlan

Không tạo schema riêng cho Review Product.

---

# 24. MULTI-SPEAKER

Reuse QD-122.

Nếu template tạo nhiều nhân vật:

* dialogueLines phải ordered
* voice theo đúng speaker
* subtitle dùng cùng source
* không mất câu
* voice reuse theo line.

---

# 25. REVIEW PRODUCT + REAL ASSET

Nếu người dùng upload ảnh thật:

Ưu tiên:
REAL PRODUCT IMAGE
→ local motion
→ crop/zoom/pan
→ overlays
→ B-roll
→ chỉ dùng Image AI nếu thực sự cần.

Không tạo lại sản phẩm bằng AI nếu có ảnh thật phù hợp trừ khi user yêu cầu.

Điều này giúp sản phẩm không bị sai hình.

---

# 26. HYBRID VIDEO STRATEGY

Không dùng Video AI cho mọi scene.

Router nên phân loại:

LOCAL_MOTION
hoặc
VIDEO_AI

Ví dụ review sản phẩm:

Ảnh sản phẩm thật
→ LOCAL_MOTION

Lifestyle/action scene
→ VIDEO_AI nếu cần.

Text/feature scene
→ LOCAL_MOTION.

Mục tiêu:

* tự nhiên hơn
* rẻ hơn
* nhanh hơn
* ít lỗi consistency.

---

# 27. SMOOTH PRODUCTION PASS

Kiểm tra phần Smooth/Consistency hiện tại.

Nếu đã có thì REUSE, không xây lại.

Mục tiêu final video:

* không khoảng chết dài
* scene timing theo voice
* trim clip thông minh
* pan/zoom mềm
* transition ngắn hợp lý
* normalize FPS
* normalize resolution
* normalize audio
* voice fade nhẹ
* music ducking nếu music có
* subtitle đúng timing
* không kéo méo source
* không encode nhiều lần không cần thiết.

Không dùng frame interpolation đại trà.

Chỉ dùng nếu source thực sự cần.

---

# 28. SOUND EFFECT

Cho phép scene có optional:

soundEffectHint

Ví dụ:
door click
whoosh
ding
animal sound
engine
soft impact

Không bắt buộc phải có SFX API trong phiên này.

Chỉ chuẩn bị data model/hook nếu chưa có.

---

# 29. BACKGROUND MUSIC

Nếu hệ thống đã có:
reuse.

Nếu chưa:
không cần tích hợp paid music provider.

Chỉ thiết kế hook:
backgroundMusicAssetId

Music phải:

* duck dưới voice
* không overpower narration.

---

# 30. CONTENT LIBRARY

Không biến thư viện “Thành ngữ” hiện tại thành thư viện duy nhất.

Thiết kế:

CONTENT LIBRARY

Category:

* English
* Product
* AI
* Toys
* Animals
* Stories
* Knowledge
* Ads
* Custom

Thành ngữ trở thành một collection.

---

# 31. HOME / NAVIGATION

Tên sidebar “Thành ngữ” có thể giữ để truy cập thư viện thành ngữ.

Nhưng trang tạo video chính không được bắt buộc Thành ngữ.

Có thể đổi CTA chính thành:

“TẠO VIDEO”

hoặc:

“VIDEO MỚI”

Không cần rebrand toàn bộ app trong phiên đầu nếu ảnh hưởng lớn.

---

# 32. COST SAFETY

Tạo kịch bản:
có thể dùng Text AI nếu production mode nhưng phải tuân theo cơ chế cost/preflight hiện có.

Trong development:
MOCK ONLY.

Không tạo:
Image
Video
Voice

cho đến khi user duyệt storyboard/media plan.

Preflight phải hiển thị:

Text
Image
Voice
Video AI
Reuse
Local Motion

---

# 33. NO DUPLICATE PAID CALL

Giữ nguyên nguyên tắc:

* script reuse nếu input không đổi nếu hệ thống đã hỗ trợ
* image reuse
* voice reuse
* video reuse
* resume
* render again

Không được vì đổi:
title
platform
subtitle style
thumbnail

mà tự regenerate voice/image/video không liên quan.

---

# 34. URL / PRODUCT DATA SAFETY

Không được coi dữ liệu AI suy đoán là specification thật.

Phân biệt:

SOURCE FACT
USER PROVIDED
AI GENERATED

Review sản phẩm phải tránh bịa:

* giá
* công suất
* pin
* kích thước
* warranty
* feature
  nếu không có nguồn.

---

# 35. LEGACY PROJECTS

Các project cũ như:

Break a leg
Piece of Cake
All ears
...

phải mở bình thường.

Có thể map:

contentType = ENGLISH_IDIOM

nếu field mới trống.

Không migration phá dữ liệu.

Không regenerate asset.

---

# 36. DATA MODEL

Thiết kế tối thiểu, tránh tạo quá nhiều bảng nếu không cần.

Có thể cần:

contentType
contentTemplateId
contentSourceType
sourceText
sourceUrl
language
audience
tone

Nếu có output profile/platformPreset rồi thì reuse.

Không duplicate dữ liệu đã tồn tại.

---

# 37. TEMPLATE REGISTRY

Nên có một registry duy nhất.

Ví dụ conceptually:

ENGLISH_IDIOM
ENGLISH_VOCAB
PRODUCT_REVIEW
AI_REVIEW
TOY_WORLD
ANIMAL_FACT
STORY
KNOWLEDGE
ADVERTISEMENT
CUSTOM

Template Registry dùng cho:

* UI
* script generation
* defaults
* validation

Không rải string khắp code.

---

# 38. PROMPT VERSIONING

Prompt của từng template nên có version.

Ví dụ:

product-review-v1
animal-facts-v1

để sau này cải thiện prompt mà không ảnh hưởng project cũ.

Không bắt buộc database phức tạp.

Có thể registry/config versioned.

---

# 39. KHÔNG LÀM QUÁ NHIỀU TỰ ĐỘNG

AI được đề xuất.

User được quyền:

* sửa script
* sửa dialogue
* sửa visual prompt
* đổi scene
* bỏ scene
* thêm scene
* thay asset
* đổi voice
* chọn Local Motion
* chọn Video AI.

Không khóa user vào output của AI.

---

# 40. TEST CASES

Phải có regression test tối thiểu:

### Legacy

* project Thành ngữ cũ mở được
* render/reuse không đổi

### Prompt

Prompt:
“Làm video 30 giây giải thích ChatGPT cho cửa hàng nhỏ”
→ tạo storyboard hợp lệ.

### Text

Dán đoạn văn
→ tạo script
→ không mất nội dung chính.

### Product Review

Input:
tên + description + 3 ảnh
→ script review
→ ưu tiên ảnh thật.

### AI Review

→ đúng structure.

### Toy

→ story scenes.

### Animals

→ facts/story structure.

### Custom

→ không ép template Thành ngữ.

### Language

Vietnamese
English

### Audience

Kids
Adults

### Platform

9:16
16:9

### Multi-speaker

→ voice/subtitle sync.

### Cost

script preview không tự gọi image/video/voice.

### Reuse

đổi subtitle style
→ 0 paid media calls.

### Legacy migration

→ existing data safe.

---

# 41. UI TEST

Người không rành kỹ thuật phải làm được:

Mở tool
→ Tạo video
→ Review sản phẩm
→ Upload ảnh
→ nhập mô tả
→ chọn TikTok
→ chọn 30 giây
→ Tạo kịch bản
→ xem storyboard.

Không cần biết:
JSON
resolution
model ID
provider
codec
aspect ratio
routing
FFmpeg.

---

# 42. DEVELOPMENT PHASES

Không làm tất cả trong một commit khổng lồ.

Chia thành phase.

## PHASE A

Content architecture + template registry + legacy mapping.

## PHASE B

New Create Video UX + Prompt/Text input.

## PHASE C

Core templates:

* English Idiom
* Product Review
* AI Review
* Custom

## PHASE D

Additional templates:

* Toys
* Animals
* Stories
* Knowledge
* Advertising

## PHASE E

Audience + Language + Tone.

## PHASE F

Asset-aware Product Review.

## PHASE G

Final integration + tests.

Sau mỗi phase:

* test liên quan
* lint
* typecheck
* build

Không chạy nhiều vitest process song song.

Không commit nếu phase đang đỏ.

---

# 43. API SAFETY TRONG PHIÊN PHÁT TRIỂN

MOCK MODE ONLY.

PAID TEXT POST = 0
PAID IMAGE POST = 0
PAID VIDEO POST = 0
PAID VOICE POST = 0

Không dùng API key thật.
Không tự thay spend limit.

---

# 44. FULL TEST

Sau khi toàn bộ các phase hoàn tất và test liên quan đều xanh:

chạy full test suite MỘT LẦN.

Không chạy full suite sau mỗi phase nếu mất nhiều thời gian.

Sau đó:
lint
typecheck
production build
secret scan

---

# 45. MIGRATION

Nếu cần migration DB:

1. không áp DB thật ngay trong lúc phát triển
2. test với test DB trước
3. báo rõ migration
4. backup data/app.db
5. chỉ migration production DB khi toàn bộ test liên quan PASS.

Không sửa DB production thủ công.

---

# 46. BÁO CÁO TRƯỚC KHI CODE

Trước tiên báo:

CURRENT HARD-CODED IDIOM AREAS:
CURRENT GENERIC PIPELINE:
LEGACY RISKS:
NEW DATA FIELDS NEEDED:
MIGRATION NEEDED:
PHASE PLAN:

Sau đó bắt đầu triển khai.

Không hỏi lại những thông tin đã có thể suy ra từ code.

---

# 47. BÁO CÁO CUỐI

Báo:

MULTI-CONTENT ENGINE:
CONTENT TEMPLATE REGISTRY:
PROMPT INPUT:
TEXT INPUT:
URL SOURCE:
ASSET INPUT:
ENGLISH:
PRODUCT REVIEW:
AI REVIEW:
TOY WORLD:
ANIMALS:
STORY:
KNOWLEDGE:
ADVERTISEMENT:
CUSTOM:
LANGUAGE:
AUDIENCE:
TONE:
PLATFORM PRESETS:
MULTI-SPEAKER:
VOICE REUSE:
ASSET REUSE:
HYBRID ROUTING:
SMOOTH PASS:
LEGACY PROJECTS:
PAID API POST:
MIGRATION:
TESTS:
LINT:
TYPECHECK:
BUILD:
SECRET SCAN:
FILES CHANGED:
BLOCKERS:

Cuối cùng trả lời 5 câu:

1. Người dùng có còn bị bắt buộc chọn Thành ngữ không?
2. Có thể nhập một prompt bất kỳ để tạo video không?
3. Có thể dán văn bản để AI biến thành storyboard không?
4. Có thể làm Review sản phẩm bằng ảnh thật mà không tạo lại sản phẩm bằng AI không?
5. Sau này thêm một chủ đề mới có cần sửa pipeline chính hay chỉ cần thêm Content Template?

Mục tiêu cuối:

Người không rành kỹ thuật chỉ cần:

CHỌN LOẠI VIDEO
→ NHẬP Ý TƯỞNG / NỘI DUNG
→ CHỌN NGÔN NGỮ
→ CHỌN THỜI LƯỢNG
→ CHỌN NỀN TẢNG
→ TẠO KỊCH BẢN
→ DUYỆT
→ TẠO VIDEO

Các chi tiết kỹ thuật như model, provider, routing, resolution, FFmpeg, reuse, idempotency, spend guards phải được tool xử lý phía sau.


---

# PHỤ LỤC: EXTENSIBLE AI VIDEO PROVIDER SYSTEM

Bổ sung một yêu cầu kiến trúc quan trọng cho Multi-Content Video Engine:

# EXTENSIBLE AI VIDEO PROVIDER SYSTEM

Batch Video Factory không được phụ thuộc cứng vào Runway/OpenAI hoặc một nhà cung cấp Video AI duy nhất.

Mục tiêu:
Sau này người dùng có thể thêm/chuyển nhà cung cấp hoặc model Video AI mới mà không phải sửa pipeline Storyboard / Scene / Render.

## 1. PROVIDER ADAPTER

Chuẩn hóa interface VideoProvider.

Pipeline gửi một request chung, ví dụ:

* prompt
* negativePrompt nếu hỗ trợ
* inputImage / referenceImage
* duration
* aspectRatio
* width/height
* fps nếu provider hỗ trợ
* quality
* character/reference assets

Adapter của từng provider chịu trách nhiệm:

* convert request
* submit job
* poll status
* cancel nếu hỗ trợ
* download result
* normalize errors
* report cost/credits.

Không để provider-specific API logic rải trong scene workflow.

## 2. VIDEO PROVIDER REGISTRY

Có registry cho provider/model.

Model profile tối thiểu:

providerId
modelId
displayName
enabled
routingMode

capabilities:

* textToVideo
* imageToVideo
* referenceImage
* characterReference
* supportedAspectRatios
* supportedDurations
* resolutions

cost profile:

* estimatedCost
* credits
* billingUnit

routing metadata:

* AUTO_OK
* PIN_ONLY
* DEPRECATED
* DISABLED

quality metadata:

* motionQuality
* characterConsistency
* productFidelity
* speed
* costEfficiency

Nếu hiện tại registry đã có thì mở rộng, không tạo hệ thống thứ hai.

## 3. ADD MODEL WITHOUT CORE PIPELINE CHANGE

Sau này thêm một model/provider mới chỉ nên cần:

* provider adapter nếu API mới hoàn toàn
* model registry/config
* capability mapping
* pricing
* benchmark

Không sửa:
Storyboard
Voice
Subtitle
Smooth Pass
Final Render.

## 4. UI

Trong:

Nhà cung cấp AI
→ Video AI

Cho người dùng xem:

Provider
Model
Trạng thái
Khả năng
Tỷ lệ hỗ trợ
Giá dự kiến
Routing
Benchmark

Cho phép:

* Enable/Disable
* chọn Default
* PIN_ONLY
* AUTO_OK chỉ sau khi benchmark đạt.

Không cho người dùng bình thường phải cấu hình kỹ thuật này trong workflow hằng ngày.

Đặt phần này trong Advanced/Admin.

## 5. API KEY

API key:

* không lưu plaintext trong frontend
* mask khi hiển thị
* server-side only
* không ghi vào logs
* không commit Git.

## 6. TEST CONNECTION

Có chức năng:

“Kiểm tra kết nối”

Chỉ kiểm tra:

* authentication
* provider availability
* model availability nếu API hỗ trợ.

Không tạo video trả phí.

## 7. MODEL DISCOVERY

Nếu provider hỗ trợ API liệt kê model:
cho phép:
“Hỏi nhà cung cấp”

Nhưng model mới phát hiện:
mặc định PIN_ONLY / DISABLED,
không AUTO route ngay.

Người dùng phải duyệt hoặc benchmark trước.

## 8. BENCHMARK

Giữ/cải thiện benchmark engine hiện tại.

Có thể đánh giá model theo:

* people/action
* product
* cartoon
* animals
* camera motion
* character consistency
* prompt following
* cost
* speed.

Router dùng benchmark + capability + budget để chọn.

Không chỉ chọn model rẻ nhất.

## 9. FALLBACK

Nếu provider lỗi:
không tự chuyển sang provider trả phí khác nếu chưa được người dùng cho phép.

Có thể:
AUTO fallback only giữa những model đã được AUTO_OK và nằm trong budget policy.

Nếu không:
VIDEO_MODEL_NEEDS_SELECTION.

## 10. DEPRECATION

Nếu provider ngừng model:

* đánh dấu DEPRECATED
* project cũ vẫn mở được
* video asset cũ vẫn reuse
* không tự regenerate
* tạo mới yêu cầu model thay thế.

## 11. LOCAL MOTION

LOCAL_MOTION luôn là một route độc lập, không phụ thuộc external provider.

Nếu scene không cần generative video:
ưu tiên Local Motion để:

* giảm chi phí
* tăng tốc
* giữ fidelity sản phẩm.

## 12. FUTURE PROVIDERS

Kiến trúc phải cho phép thêm các provider tương lai mà không hard-code tên cụ thể.

Không cần tích hợp tất cả provider trong phiên này.

Chỉ cần chứng minh kiến trúc bằng provider hiện có.

## 13. TEST

Test:

* add model registry
* disable model
* deprecated model
* unsupported aspect ratio
* provider unavailable
* PIN_ONLY không auto-call
* AUTO_OK routing
* fallback safety
* Local Motion fallback
* legacy project
* 0 duplicate paid calls

Không gọi API thật.

Cuối report thêm:

VIDEO PROVIDER ABSTRACTION:
MODEL REGISTRY:
ADD MODEL WITHOUT PIPELINE CHANGE:
PROVIDER CAPABILITIES:
PRICING PROFILE:
BENCHMARK ROUTING:
MANUAL PIN:
AUTO ROUTING:
DEPRECATION:
API KEY SAFETY:
PAID API POST:
