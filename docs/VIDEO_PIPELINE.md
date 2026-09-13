# Quy trình dựng video

Từ một thành ngữ đến một tệp MP4 sẵn sàng đăng.

---

## Định dạng đầu ra

| Thuộc tính | Giá trị |
|---|---|
| Độ phân giải | 1080 x 1920 |
| Tỉ lệ | 9:16 |
| Tốc độ khung | 30 fps |
| Video | H.264 (libx264), profile high, yuv420p |
| Âm thanh | AAC 192 kbps, 48 kHz, stereo |
| Vùng chứa | MP4 với `+faststart` |

`+faststart` đưa moov atom lên đầu tệp để video bắt đầu phát trước khi tải xong
— đúng thứ mọi nền tảng video ngắn mong đợi khi tải lên.

Các tỉ lệ khác (1:1, 4:5, 16:9) được hỗ trợ qua phong cách, nhưng 9:16 là mặc
định vì đây là công cụ làm Shorts.

---

## Cấu trúc kịch bản

```
0–3 giây     HOOK                   ưu tiên chi tiêu CAO
3–12 giây    Hiểu theo nghĩa đen
12–18 giây   Đẩy cao trào + punchline   ưu tiên chi tiêu CAO
18–24 giây   Giải thích nghĩa thật
24–30 giây   Câu ví dụ + câu chốt
```

Mặc định 25 giây, thường ra 4–6 cảnh. Thời lượng không bị ép cứng — kịch bản
được phép thở.

Mỗi cảnh dài **2–6 giây**, vì mỗi cảnh là một lần tạo video AI riêng. Tạo một
clip AI dài 30 giây thì vừa đắt, vừa dễ hỏng, vừa không sửa lại được từng phần.

---

## Ba lượt FFmpeg

Cố tình chia làm ba lượt thay vì một `filter_complex` khổng lồ.

### Lượt 1 — chuẩn hoá từng cảnh

Mỗi clip được đưa về cùng một bộ thông số mã hoá:

```
scale=1080:1920:force_original_aspect_ratio=increase,
crop=1080:1920,
fps=30,
tpad=stop_mode=clone:stop_duration=10,
setsar=1,
format=yuv420p
```

- `scale` + `crop` lấp đầy khung dọc, không viền đen.
- `tpad` giữ khung hình cuối nếu clip ngắn hơn thời lượng cảnh.
- `-t <duration>` cắt cứng về đúng thời lượng đã viết trong kịch bản, nên giọng
  đọc và phụ đề không bao giờ lệch.
- Giọng đọc đi qua `apad`; cảnh không có lời thì dùng `anullsrc`.

Ảnh tĩnh (khi một cảnh chỉ có keyframe) được `zoompan` để không bị đứng hình.

### Lượt 2 — ghép

Dùng concat demuxer với `-c copy`. Vì lượt 1 đã làm mọi clip giống hệt nhau về
thông số, bước ghép chỉ là sao chép luồng: rất nhanh và gần như không thể hỏng.

Danh sách ghép dùng tên tệp trần và FFmpeg chạy với `cwd` đặt vào thư mục
`temp/`, nên đường dẫn Windows có dấu cách không cần thoát ký tự.

### Lượt 3 — hoàn thiện

```
[0:v]subtitles=subs.ass[v];
[1:a]volume=0.18[m];[0:a][m]amix=inputs=2:duration=first[a]
```

Ghi phụ đề lên hình và trộn nhạc nền (nếu có) ở mức nhỏ dưới giọng đọc.

Tệp `.ass` được **chép vào `temp/` và gọi bằng tên trần**. Bộ lọc `subtitles=`
của FFmpeg dùng `:` làm ký tự phân tách riêng, nên `C:\...` phải thoát hai lớp
và rất dễ sai. Đổi thư mục làm việc loại bỏ hẳn nhóm lỗi đó.

Nếu bản FFmpeg đang dùng không có libass, hệ thống bỏ qua bước ghi phụ đề lên
hình và vẫn xuất tệp `.srt` riêng — giảm cấp êm thay vì hỏng.

---

## Phụ đề

Xuất ra cả hai định dạng:

- `subtitles.srt` — để tải lên nền tảng
- `subtitles.ass` — để ghi lên hình, có kiểu chữ

Kiểu chữ ASS được đặt cho điện thoại:

| Thuộc tính | Giá trị | Lý do |
|---|---|---|
| Cỡ chữ | 7.8% chiều cao khung | Đọc được trên màn hình nhỏ |
| Đậm | có | Tương phản |
| Viền | 9% cỡ chữ, đen | Đọc được trên mọi nền |
| Căn | dưới, giữa | |
| Lề dưới | 20% chiều cao | Tránh thanh giao diện của nền tảng |
| Số dòng tối đa | 3 | Quá 3 dòng là không kịp đọc |
| Ký tự mỗi dòng | 26 | |

Cụm thành ngữ được tô màu hổ phách ngay trong câu:

```
"BREAK A LEG"?!
 ^^^^^^^^^^^ màu hổ phách, phần còn lại trắng
```

Văn bản phụ đề được thoát trước khi ghi vào tệp ASS, nên một dấu ngoặc nhọn
trong lời thoại không thể trở thành mã điều khiển ASS.

---

## Cảnh bị bỏ qua

Bấm "Bỏ qua cảnh" sẽ loại cảnh đó khỏi cả việc tạo media lẫn bản render cuối.
Thời lượng và mốc thời gian phụ đề được tính lại tự động.

Nếu một cảnh tạo media thất bại hoàn toàn, bước render **báo lỗi ngay** thay vì
chờ vô ích, kèm hướng xử lý:

> Không thể render: 2 cảnh (3, 4) tạo media thất bại. Hãy tạo lại các cảnh đó
> hoặc bấm "Bỏ qua cảnh" rồi render lại.

---

## Chế độ mock tạo ra gì

| Loại | Cách tạo | Kết quả |
|---|---|---|
| Ảnh | Bộ mã hoá PNG thuần TypeScript | PNG thật, đọc được |
| Video | FFmpeg: ảnh tĩnh + pan bằng crop | MP4 H.264 thật |
| Giọng đọc | Tổng hợp WAV 16-bit bằng TypeScript | WAV thật, đúng độ dài |

Đều là tệp thật, không phải tệp rỗng. Nhờ vậy chế độ mock đi qua đúng những đoạn
mã mà nhà cung cấp thật sẽ đi qua.

Thẻ hình mock in sẵn số cảnh, độ phức tạp và **mô hình đã được chọn** ngay trên
khung hình, nên khi xem lại một lượt chạy mock bạn thấy ngay quyết định định
tuyến mà không cần mở cơ sở dữ liệu.

Chuyển động dùng `scale` rồi `crop` di động, không dùng `zoompan`: `zoompan`
dựng lại ảnh ở độ phân giải phóng to trên từng khung hình, ở 1080x1920 nó chậm
đến mức chiếm gần hết thời gian của cả lượt chạy.

---

## Vị trí tệp

```
data/projects/<project-id>/
├── script/        bản sao kịch bản
├── images/        ảnh keyframe
├── videos/        clip từng cảnh
├── audio/         giọng đọc
├── subtitles/     subtitles.srt, subtitles.ass
├── final/         MP4 hoàn chỉnh  ← không bao giờ tự động xoá
└── temp/          tệp trung gian  ← dọn sau 3 ngày
```

Tên tệp là UUID. Tên do nhà cung cấp bên ngoài trả về không bao giờ được tin
dùng.
