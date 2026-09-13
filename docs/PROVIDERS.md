# Nhà cung cấp AI

## Tình trạng hiện tại

| Nhà cung cấp | Loại | Tình trạng |
|---|---|---|
| `mock` | text, image, video, voice, upscale, quality | **Hoạt động, đã kiểm chứng đầy đủ.** |
| `openai` | text | Code xong, **chưa chạy thật** (chưa có API key) |
| `deepseek` | text | Code xong, chưa chạy thật |
| `groq` | text | Code xong, chưa chạy thật |
| `ollama` | text | Code xong, chưa chạy thật. **Chạy cục bộ, miễn phí.** |
| `lmstudio` | text | Code xong, chưa chạy thật. Chạy cục bộ, miễn phí. |
| `openrouter`, `together` | text | Code xong, chưa chạy thật |
| `google` | video (Veo) | Chưa tích hợp (Milestone 3) |
| `runway` | video | Chưa tích hợp (Milestone 2 bước 3) |
| `kling` | video | Chưa tích hợp (Milestone 3) |
| `elevenlabs` | voice | Chưa tích hợp (Milestone 2 bước 4) |

> **"Code xong, chưa chạy thật"** nghĩa là: lớp tích hợp đã viết và đã kiểm thử
> bằng máy chủ giả lập chạy cục bộ, nhưng **chưa từng gọi một nhà cung cấp thật
> nào**, vì chưa có API key nào được cấu hình. Không được coi là đã hoạt động
> cho tới khi chạy thật thành công.

## Cách nhanh nhất để thử Text AI thật: Groq

Groq có gói miễn phí, tương thích OpenAI API, và không phải tải GB nào.

### 1. Lấy API key

Đăng ký tại https://console.groq.com (không cần thẻ tín dụng), vào mục
**API Keys** và tạo một key mới.

### 2. Tự dán key vào `.env`

Mở tệp `.env` ở thư mục gốc dự án và điền:

```
GROQ_API_KEY=gsk_...key_cua_ban...
```

> **Tự tay dán key, đừng gửi cho ai.** Key không bao giờ được ghi vào log, không
> lọt vào gói JavaScript của trình duyệt, và chỉ xuất hiện trong header
> `Authorization` của request.

### 3. Nhập giá và bật model

Tra bảng giá hiện hành tại https://groq.com/pricing, đổi sang đơn vị **USD cho
1000 token**, rồi chạy:

```powershell
npm run provider:enable -- --provider groq --model llama-3.3-70b-versatile `
  --price-in <gia_input> --price-out <gia_output>
```

Hoặc nhập trong trang **Mô hình AI** rồi xác nhận ở trang **Nhà cung cấp AI**.

> **Về gói miễn phí của Groq:** nếu tài khoản đang ở gói miễn phí thì Groq
> **không trừ tiền thật**. Nhưng ứng dụng vẫn cần một mức giá để ước tính chi phí
> và để hạn mức chi tiêu có ý nghĩa. Vì vậy con số "đã chi" hiển thị trong ứng
> dụng là **giá trị đã tiêu thụ quy đổi theo bảng giá trả phí**, không phải hoá
> đơn thật. Nếu sau này tài khoản chuyển sang trả phí, lớp bảo vệ đã sẵn sàng và
> con số trở thành tiền thật.

### 4. Chuyển sang chế độ thật và so sánh

```powershell
# Sửa .env: AI_MOCK_MODE=false, rồi khởi động lại ứng dụng
npm run compare:text -- --provider groq --model llama-3.3-70b-versatile
```

### Quay lại chế độ mock

Đặt lại `AI_MOCK_MODE=true` trong `.env` và khởi động lại. Toàn bộ ứng dụng lập
tức quay về dùng mock.

---

## Cách rẻ nhất để thử Text AI thật: Ollama

Ollama chạy model ngay trên máy này. Không cần API key, chi phí luôn **0 USD**,
và nó đi qua đúng đường đi HTTP mà nhà cung cấp trả phí sẽ đi qua — nên nó kiểm
chứng được tích hợp mà không tốn đồng nào.

### Cài đặt

```powershell
winget install Ollama.Ollama
# hoặc tải trình cài từ https://ollama.com
```

Mở PowerShell **mới** sau khi cài, rồi tải model:

```powershell
ollama pull llama3.1
```

Model nặng khoảng 4,7 GB nên lần tải đầu khá lâu. Máy cần tối thiểu 8 GB RAM.

Model nhẹ hơn nếu máy yếu (chất lượng kém hơn, nhưng vẫn kiểm chứng được tích
hợp): `ollama pull llama3.2` (2 GB) hoặc `ollama pull qwen2.5:3b` (1,9 GB).
Nhớ thêm model tương ứng vào trang Mô hình AI.

### Bật trong ứng dụng

Cách nhanh (dòng lệnh):

```powershell
npm run provider:enable -- --provider ollama --model llama3.1
```

Hoặc qua giao diện:

1. Trang **Mô hình AI** → bật `ollama/llama3.1`
   (model chạy cục bộ được phép bật dù giá = 0, vì thật sự miễn phí)
2. Trang **Nhà cung cấp AI** → Ollama → chọn `llama3.1` → bấm xác nhận

### Chuyển sang chế độ thật

Sửa `.env`:

```
AI_MOCK_MODE=false
```

Khởi động lại ứng dụng, rồi so sánh Mock và Real:

```powershell
npm run compare:text -- --provider ollama --model llama3.1
```

### Quay lại chế độ mock

Đặt lại `AI_MOCK_MODE=true` trong `.env` và khởi động lại. Toàn bộ ứng dụng
lập tức quay về dùng mock, không cần sửa gì khác.

### Lưu ý về chất lượng

Model chạy cục bộ 8B tham số **yếu hơn đáng kể** so với model thương mại. Dùng nó
để kiểm chứng rằng tích hợp hoạt động — request, token, JSON, retry, ghi chi phí
— chứ không phải để đánh giá chất lượng nội dung cuối cùng. Nếu kịch bản nó viết
không hay bằng mock, đó là chuyện bình thường và không có nghĩa là tích hợp sai.

Các nhà cung cấp chưa tích hợp đã có chỗ trong bảng đăng ký để giao diện có thứ
để cấu hình, nhưng chọn một trong số đó sẽ ném lỗi rõ ràng:

> Nhà cung cấp "runway" (video) chưa được tích hợp trong phiên bản này. Bật
> AI_MOCK_MODE=true hoặc chọn nhà cung cấp khác.

Đây là chủ ý. Im lặng chạy mock rồi báo cáo như thể nhà cung cấp thật đang hoạt
động sẽ là nói dối về tình trạng hệ thống.

---

## Các interface

`src/providers/types.ts`

```ts
interface VideoProvider {
  getName(): string;
  checkStatus(): Promise<ProviderStatus>;
  estimateCost(req: VideoRequest): Promise<CostEstimate>;
  createVideo(req: VideoRequest): Promise<ProviderJob>;
  getJobStatus(externalId: string): Promise<JobStatus>;
  downloadResult(externalId: string): Promise<GeneratedAsset>;
  cancelJob?(externalId: string): Promise<void>;
}
```

Các interface `Text`, `Image`, `Voice`, `Upscale`, `Quality` theo cùng hình
dạng. Mô hình là **bất đồng bộ**: tạo → hỏi trạng thái → tải về. Ngay cả nhà
cung cấp trả kết quả tức thì cũng phải theo hình dạng này, để tầng gọi không cần
biết cái nào là cái nào.

**Không tệp nào ngoài `src/providers/**` được biết tên nhà cung cấp nào đang
chạy.** Giao diện và services chỉ nói chuyện qua các interface này.

---

## Thêm một nhà cung cấp thật

### 1. Viết bản hiện thực

`src/providers/runway/runway-video-provider.ts`

```ts
export class RunwayVideoProvider implements VideoProvider {
  getName() { return "runway"; }

  async checkStatus(): Promise<ProviderStatus> {
    // KHÔNG được gọi API tính phí ở đây.
    if (!process.env.RUNWAY_API_KEY) return "missing_key";
    return "connected";
  }

  async estimateCost(req: VideoRequest): Promise<CostEstimate> {
    // Đọc giá từ ModelRegistry, không viết cứng.
  }

  async createVideo(req: VideoRequest): Promise<ProviderJob> {
    // Gửi yêu cầu, trả về externalId của nhà cung cấp.
    // externalId này được lưu lại và là thứ giúp không trả tiền hai lần.
  }

  async getJobStatus(externalId: string): Promise<JobStatus> { /* ... */ }

  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    // Tải về và ghi vào req.outputPath.
    // KHÔNG BAO GIỜ dùng tên tệp do nhà cung cấp trả về —
    // tên tệp do ta tự đặt, qua lib/paths.ts.
  }
}
```

### 2. Đăng ký

`src/providers/registry.ts`:

```ts
export function getVideoProvider(name: string): VideoProvider {
  if (isMockMode() || name === "mock") return mockVideo;
  if (name === "runway") return runwayVideo;     // ← thêm dòng này
  return notImplemented(name, "video");
}

export const IMPLEMENTED_PROVIDERS = new Set(["mock", "runway"]);
```

### 3. Nhập giá thật

Vào trang **Mô hình AI**, mở mô hình Runway, nhập đúng giá theo bảng giá của
nhà cung cấp, đặt năng lực (`maxDuration`, image-to-video, tham chiếu nhân vật,
1080p), rồi bật.

Ứng dụng từ chối bật một mô hình của nhà cung cấp thật khi giá vẫn là 0.

### 4. Nhập API key

Hai cách:

- **Biến môi trường** (đơn giản nhất): thêm `RUNWAY_API_KEY=...` vào `.env`.
- **Giao diện**: trang Nhà cung cấp AI → Cấu hình → dán key. Key được mã hoá
  AES-256-GCM trước khi lưu, và giao diện chỉ hiển thị mặt nạ `****F92A`. Không
  có endpoint nào giải mã ngược về trình duyệt.

Cách thứ hai cần `SECRET_ENCRYPTION_KEY` trong `.env`.

### 5. Tắt chế độ mock và kiểm thử

```
AI_MOCK_MODE=false
```

Tạo **một** dự án với ngân sách nhỏ, ví dụ $1. Xem từng cảnh. Kiểm tra trang Chi
phí xem con số thực tế có khớp với ước tính không.

Chỉ khi đã chạy thật thành công mới được nói rằng nhà cung cấp đó hoạt động.

---

## Trạng thái nhà cung cấp

Trạng thái được **suy ra từ cấu hình**, không phải từ việc ping liên tục. Gọi
API của nhà cung cấp chỉ để hiển thị một chấm xanh là tốn tiền và tốn hạn mức mà
không đem lại gì.

| Trạng thái | Nghĩa |
|---|---|
| `connected` | Đã bật, đã tích hợp, có key, đang online |
| `missing_key` | Đã bật nhưng không tìm thấy API key |
| `unavailable` | Chưa tích hợp, hoặc mất kết nối Internet |
| `rate_limited` | Bị nhà cung cấp giới hạn; router tự chuyển sang dự phòng |
| `disabled` | Người dùng đã tắt |

---

## Chuỗi dự phòng

Router trả về các lựa chọn thay thế cùng với mô hình chính. Khi mô hình chính
hỏng, `withFallback()` thử lần lượt theo thứ tự `fallbackPriority`.

Chỉ lỗi **có thể thử lại** mới kích hoạt dự phòng. Lỗi không thể thử lại (nhà
cung cấp chưa tích hợp, yêu cầu sai định dạng) dừng ngay, thay vì đốt qua tất cả
nhà cung cấp với cùng một đầu vào hỏng.

Trước khi dự phòng, hệ thống luôn kiểm tra `ProviderJob` để chắc chắn job cũ đã
chết thật — chứ không phải đang chạy dở. Đây là điều ngăn việc trả tiền hai lần.

---

## An toàn

- API key không bao giờ đi vào gói JavaScript của trình duyệt. `src/lib/env.ts`
  chỉ được import từ phía máy chủ.
- Nhật ký che mọi thứ trông giống khoá trước khi ghi (`src/lib/logger.ts`).
- Tên tệp do nhà cung cấp trả về bị coi là dữ liệu thù địch: ứng dụng tự đặt tên
  bằng UUID và chỉ giữ phần mở rộng nếu nó nằm trong danh sách cho phép.
- Mọi đường dẫn ghi ra đĩa đều đi qua `lib/paths.ts`, nơi từ chối bất cứ thứ gì
  thoát khỏi thư mục `data/`.
