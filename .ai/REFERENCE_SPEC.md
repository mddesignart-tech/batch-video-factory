Tiếp tục trên Batch Video Factory hiện tại sau khi Multi-Content Engine đã hoàn tất.

Mục tiêu phiên này:

MỞ RỘNG HỆ THAM CHIẾU HIỆN TẠI TỪ “CHARACTER REFERENCE”
THÀNH
“UNIVERSAL REFERENCE ASSET SYSTEM”

để có thể dùng ảnh tham chiếu cho:

* Nhân vật
* Sản phẩm
* Đồ vật / đạo cụ
* Đồ chơi
* Động vật / creature
* Logo / bao bì
* Phong cách hình ảnh

và dùng được cho tất cả content type:

* Thành ngữ
* Review sản phẩm
* Review AI
* Đồ chơi
* Động vật
* Kể chuyện
* Kiến thức
* Quảng cáo
* Custom

KHÔNG viết một hệ riêng cho từng template.
KHÔNG phá Character Bible hiện tại.
KHÔNG gọi API thật trong phiên phát triển/test.

---

# 1. KIỂM TRA HIỆN TRẠNG

Trước khi sửa, hãy kiểm tra:

* Character Bible hiện lưu reference image thế nào
* Scene liên kết nhân vật bằng field nào
* image generation hiện gửi reference ra sao
* Video AI có hỗ trợ input/reference image ra sao
* Asset Library hiện có type/category nào
* Product Review hiện dùng ảnh upload thế nào
* Router hiện biết capability reference image của model tới đâu

Báo trước:

CURRENT CHARACTER REFERENCE:
CURRENT PRODUCT ASSET FLOW:
CURRENT VIDEO REFERENCE SUPPORT:
CURRENT IMAGE REFERENCE SUPPORT:
FIELDS THAT CAN BE REUSED:
MIGRATION NEEDED:
LEGACY RISK:

Sau đó mới code.

---

# 2. UNIVERSAL REFERENCE ASSET

Tạo abstraction chung:

ReferenceAsset

Các loại ban đầu:

CHARACTER
PRODUCT
OBJECT
TOY
ANIMAL
LOGO
STYLE

Nếu data model hiện tại có thể mở rộng từ Asset mà không cần bảng mới thì ưu tiên reuse.

Không tạo hệ asset thứ hai nếu Asset Library đã đủ khả năng.

---

# 3. REFERENCE ASSET DATA

Reference cần có ít nhất:

id
projectId nếu project-scoped
assetId
referenceType
name
description
isPrimary
priority
enabled

Optional metadata:

characterId
productId
objectId
tags
notes

Không hard-code field riêng cho từng template nếu không cần.

---

# 4. NHÂN VẬT

Giữ Character Bible hiện tại.

Nhân vật vẫn có thể có:

* ảnh chính
* nhiều ảnh góc khác nhau
* mô tả ngoại hình
* quần áo
* chiều cao tương đối
* màu sắc
* phụ kiện
* prompt consistency

Không migration phá Character hiện tại.

Character Reference phải map vào Universal Reference System mà không mất tính năng cũ.

---

# 5. SẢN PHẨM

Cho phép project có Product Reference.

Ví dụ:

Tên:
Máy xay mini ABC

Ảnh:

* mặt trước
* mặt bên
* hộp
* chi tiết nút
* ảnh sử dụng

Tool phải hiểu đây là CÙNG MỘT sản phẩm.

Trong scene review:
ưu tiên giữ:

* hình dáng
* màu
* logo
* nhãn
* chi tiết chính

Không tự thay sản phẩm bằng một vật thể AI khác nếu có ảnh thật.

---

# 6. OBJECT / TOY REFERENCE

Cho phép reference cho:

* xe đồ chơi
* robot
* mô hình
* công cụ
* nội thất
* phụ kiện
* đạo cụ

Ví dụ:

“Xe tải vàng của Ben”

Các scene sau phải reuse cùng reference thay vì mỗi cảnh tạo một xe khác.

---

# 7. ANIMAL / CREATURE REFERENCE

Cho phép:

* thú cưng thật
* nhân vật động vật
* creature AI
* mascot

Nếu cùng một con vật xuất hiện xuyên video:
phải giữ đặc điểm nhận dạng nhất quán.

Không bắt buộc creature phải dùng Character table nếu Character table chỉ phù hợp người.

---

# 8. STYLE REFERENCE

Cho phép project có optional Style Reference:

* ảnh mẫu phong cách
* color palette
* visual mood
* lighting reference

Style Reference khác với Character/Product.

Không gửi style image vào provider nếu provider không hỗ trợ.

Có thể dùng nó để:

* bổ sung prompt
* giữ visual consistency
* hướng dẫn Image AI

---

# 9. PROJECT REFERENCE PANEL

Trong trang Project thêm khu vực:

“Tài sản tham chiếu”

Hiển thị card:

NHÂN VẬT
SẢN PHẨM
ĐỒ VẬT
ĐỘNG VẬT
LOGO
PHONG CÁCH

Có nút:

* THÊM THAM CHIẾU

Người không kỹ thuật chỉ cần:

* tải ảnh
* đặt tên
* chọn loại

Không bắt nhập JSON / ID / model config.

---

# 10. SCENE REFERENCE ASSIGNMENT

Mỗi scene phải biết nó dùng reference nào.

UI đơn giản:

“Tham chiếu trong cảnh này”

Ví dụ:

✓ Leo
✓ Max
✓ Máy xay mini ABC

Cho phép:

* tự động gợi ý
* thêm/bỏ thủ công

Scene Planner có thể tự gắn reference dựa trên script.

Người dùng vẫn có quyền sửa.

---

# 11. SCRIPT ENGINE

Script/Scene Planner phải có thể trả về reference intent.

Ví dụ:

scene 1:
characters: [Leo]
products: [MixerABC]

scene 2:
products: [MixerABC]

scene 3:
characters: [Leo]
products: [MixerABC]

Không parse product name bằng string ngẫu nhiên ở nhiều chỗ.

Ưu tiên dùng ID/reference link sau khi entity đã được xác định.

---

# 12. IMAGE GENERATION

Khi tạo ảnh:

Nếu scene có Character/Product/Object Reference:

Image generation request phải biết các reference tương ứng.

Nếu provider hỗ trợ reference image:
→ gửi reference theo capability.

Nếu provider không hỗ trợ:
→ dùng description + approved visual descriptors + source asset strategy.

Không được silently bỏ reference nếu reference là critical.

Nếu không hỗ trợ:
hiển thị cảnh báo thân thiện:

“Model ảnh này không hỗ trợ ảnh tham chiếu trực tiếp. Tool sẽ dùng mô tả nhất quán thay thế.”

---

# 13. VIDEO AI

Video AI phải hỗ trợ nhiều chiến lược:

A. IMAGE-TO-VIDEO
Nếu đã có keyframe/reference image phù hợp:
→ ưu tiên dùng ảnh đó làm input.

B. DIRECT REFERENCE
Nếu model hỗ trợ character/product reference:
→ gửi reference theo adapter.

C. LOCAL MOTION
Nếu sản phẩm/đối tượng cần fidelity cao:
→ dùng ảnh thật + Local Motion.

D. TEXT-TO-VIDEO
Chỉ dùng khi không có reference quan trọng hoặc người dùng cho phép.

---

# 14. PRODUCT FIDELITY RULE

Review sản phẩm phải ưu tiên:

REAL PRODUCT ASSET
↓
LOCAL MOTION / IMAGE-TO-VIDEO
↓
VIDEO AI

Không nên dùng text-to-video để “vẽ lại” sản phẩm thật nếu đã có ảnh thật.

Nếu Video AI có nguy cơ làm sai logo/form:
ưu tiên Local Motion.

---

# 15. PROVIDER CAPABILITY

Mở rộng provider/model capability nếu cần:

supportsImageToVideo
supportsReferenceImage
supportsMultipleReferences
supportsCharacterReference
supportsProductReference
maxReferenceImages

Không assume mọi model hỗ trợ giống nhau.

Router phải biết capability trước khi chọn model.

---

# 16. MANUAL MODEL

Nếu user chọn model thủ công:

KHÔNG bắt buộc benchmark.

Chỉ cần:

* model enabled
* provider available
* capability phù hợp
* user xác nhận giá

Benchmark chỉ là điều kiện cho AUTO ROUTING.

Model mới chưa benchmark:
→ vẫn được MANUAL_OK / PIN_ONLY.

---

# 17. MULTIPLE REFERENCES

Một scene có thể có nhiều reference:

Leo
Max
Product A
Logo

Không gửi vượt giới hạn provider.

Nếu provider giới hạn số ảnh reference:
tool phải ưu tiên theo thứ tự:

1. primary product/character
2. secondary character
3. object
4. logo/style

Không bỏ âm thầm.

Nếu vượt limit:
hiển thị:
“Model này chỉ hỗ trợ N ảnh tham chiếu.”

---

# 18. REFERENCE PRIORITY

Cho phép internal priority:

CRITICAL
IMPORTANT
OPTIONAL

Ví dụ review sản phẩm:

Product = CRITICAL
Presenter = IMPORTANT
Style = OPTIONAL

Nếu model không đáp ứng CRITICAL reference:
không auto-route vào model đó.

---

# 19. REFERENCE REUSE

Reference Asset là asset đã có.

Không gọi API chỉ để “tạo lại reference”.

Nếu reference file còn tồn tại:
reuse = $0.

Changing:
subtitle
platform
duration
scene order

không được tự regenerate reference.

---

# 20. CHANGE REFERENCE

Nếu user thay ảnh tham chiếu:

Chỉ các scene phụ thuộc reference đó mới cần invalidation.

Không invalidate toàn project nếu không cần.

Ví dụ:
đổi ảnh Product A
→ scene có Product A có thể cần regenerate image/video
→ voice không đổi
→ subtitle không đổi.

Phải preflight trước paid regeneration.

---

# 21. REFERENCE VERSIONING

Nếu hợp lý, reference nên có version/revision nhẹ.

Ví dụ:
Product A v1
Product A v2

Không cần hệ version phức tạp.

Mục tiêu:
biết scene asset được tạo dựa trên reference nào để reuse/invalidate đúng.

---

# 22. LOGO / BRAND

Logo nên được giữ như asset thật.

Không gửi logo vào generative model nếu không cần.

Nếu render overlay local được:
ưu tiên local overlay để tránh AI làm sai logo/text.

---

# 23. PRODUCT REVIEW UX

Trong Review sản phẩm:

Sau khi user upload ảnh:
tool tự tạo Product Reference.

UI:

Sản phẩm tham chiếu:
[ảnh 1] [ảnh 2] [ảnh 3]

Tên sản phẩm:
[...]

Dùng sản phẩm này xuyên suốt video:
✓

Default ON.

---

# 24. STORY / TOY / ANIMAL UX

Kể chuyện:
“Nhân vật & đồ vật”

Đồ chơi:
“Đồ chơi tham chiếu”

Động vật:
“Con vật / mascot tham chiếu”

Không cần expose thuật ngữ ReferenceAsset cho người dùng bình thường.

---

# 25. AUTO ASSIGNMENT

Scene Planner được phép tự assign reference.

Ví dụ script có “Máy xay mini ABC”
→ gắn Product ABC.

Nhưng assignment phải deterministic và xem được trên UI.

Không được gửi ảnh reference sai scene.

---

# 26. REFERENCE VALIDATION

Trước paid generation:

Preflight kiểm tra:

* asset tồn tại
* file tồn tại
* loại reference
* provider capability
* số reference
* aspect/orientation nếu cần

Nếu file mất:
REFERENCE_MISSING_LOCAL_FILE

Không tự mua/generate lại.

---

# 27. COST

Reference system tự nó không được phát sinh API cost.

Upload:
$0

Assign:
$0

Reuse:
$0

Local Motion:
$0 API

Chỉ Image/Video generation thật mới tính tiền.

---

# 28. FAILURE / FALLBACK

Nếu model không hỗ trợ reference:

Không crash.

Hiển thị:

“Model này không hỗ trợ đủ tài sản tham chiếu của cảnh.”

Lựa chọn:

[ CHỌN MODEL KHÁC ]
[ DÙNG LOCAL MOTION ]
[ TIẾP TỤC KHÔNG DÙNG THAM CHIẾU ]

Lựa chọn cuối chỉ được dùng nếu user xác nhận.

Nếu reference CRITICAL:
không AUTO bỏ reference.

---

# 29. LEGACY SUPPORT

Project Thành ngữ cũ:
Character Bible hoạt động như trước.

Không bắt migration asset cũ nếu không cần.

Legacy Character Reference phải được nhận dạng đúng.

---

# 30. TEST

Viết test tối thiểu:

### Character

Character reference cũ vẫn chạy.

### Product

3 ảnh cùng sản phẩm → cùng Product Reference.

### Scene assignment

Scene dùng đúng product/character.

### Image AI

Reference được truyền khi provider hỗ trợ.

### Video AI

Image-to-video dùng đúng keyframe.

### Unsupported model

→ friendly warning
→ 0 paid POST.

### Multiple references

→ respect provider limit.

### Product fidelity

→ real product asset ưu tiên Local Motion.

### Change reference

→ chỉ invalidate scene phụ thuộc.

### Voice

→ không invalidate.

### Subtitle

→ không invalidate.

### Legacy

→ project cũ mở bình thường.

### Cost

→ upload/assign/reference reuse = $0.

### Duplicate

→ không duplicate paid request.

---

# 31. DEVELOPMENT SAFETY

Mock mode only.

PAID TEXT POST = 0
PAID IMAGE POST = 0
PAID VIDEO POST = 0
PAID VOICE POST = 0

Không tự tăng budget.

Không gọi provider thật.

---

# 32. MIGRATION

Nếu cần migration:

* test DB trước
* không apply production DB ngay
* báo migration
* backup data/app.db
* chỉ migrate thật sau tests PASS.

---

# 33. QUALITY

Sau sửa:

* tests liên quan
* lint
* typecheck
* build
* secret scan

Không chạy nhiều test process song song.

Full suite chỉ chạy một lần sau khi toàn bộ phần reference hoàn tất.

---

# 34. UI MỤC TIÊU

Người không rành kỹ thuật phải làm được:

Review sản phẩm
→ Upload 3 ảnh sản phẩm
→ tool tự hiểu đây là sản phẩm tham chiếu
→ tạo script
→ scene tự gắn sản phẩm
→ tạo video

Không cần biết:
reference ID
provider capability
image-to-video
routing
asset hash
model parameter.

---

# 35. BÁO CÁO CUỐI

Báo:

UNIVERSAL REFERENCE SYSTEM:
CHARACTER REFERENCE:
PRODUCT REFERENCE:
OBJECT REFERENCE:
TOY REFERENCE:
ANIMAL REFERENCE:
LOGO REFERENCE:
STYLE REFERENCE:
SCENE ASSIGNMENT:
IMAGE REFERENCE:
VIDEO REFERENCE:
IMAGE-TO-VIDEO:
LOCAL MOTION FALLBACK:
MULTI-REFERENCE:
REFERENCE PRIORITY:
PRODUCT FIDELITY:
MANUAL MODEL WITHOUT BENCHMARK:
AUTO ROUTING SAFETY:
REFERENCE REUSE:
REFERENCE INVALIDATION:
LEGACY CHARACTER SUPPORT:
PAID API POST:
MIGRATION:
TESTS:
LINT:
TYPECHECK:
BUILD:
SECRET SCAN:
FILES CHANGED:
BLOCKERS:

Cuối cùng trả lời rõ:

1. Review sản phẩm có thể giữ đúng cùng một sản phẩm xuyên nhiều cảnh không?
2. Nhân vật có thể giữ Character Reference như trước không?
3. Đồ chơi/động vật/đồ vật có thể dùng ảnh tham chiếu riêng không?
4. Model không benchmark có được chọn thủ công không?
5. Model không hỗ trợ reference có bị tool tự bỏ reference âm thầm không?
6. Upload/assign/reuse reference có phát sinh API cost không?

Không commit/push nếu tests liên quan, lint, typecheck hoặc build đang FAIL.
