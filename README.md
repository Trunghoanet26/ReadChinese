# ReadChinese

App dịch kiểu [Pot](https://github.com/pot-app/pot-desktop) dành cho người học tiếng Trung:
chụp vùng màn hình → **RapidOCR** nhận dạng chữ Hán → hiển thị **pinyin trên đầu từng chữ** ([pinyin-pro](https://github.com/zh-lx/pinyin-pro), chọn âm theo ngữ cảnh) → dịch song song bằng **Google** và **DeepSeek** (streaming), ngôn ngữ đích chọn trong cài đặt.

Nền tảng: Windows (Electron 33). Phần OCR chạy bằng Python.

## Yêu cầu
- **Python 3.9–3.12** (đã thêm vào PATH). RapidOCR sẽ được app **tự cài bằng pip** ở lần chạy đầu, hoặc cài tay:
  `pip install -r python/requirements.txt`
- **DeepSeek API key** (platform.deepseek.com) — nhập trong ⚙ hoặc đặt biến môi trường `DEEPSEEK_API_KEY`.
  Base URL mặc định `https://api.deepseek.com` (định dạng OpenAI), model mặc định `deepseek-flash`.
  Bấm **Kiểm tra** trong ⚙ để thử key và tự lấy danh sách model. Dùng được cả dịch vụ tương thích OpenAI khác
  (ví dụ OpenRouter) bằng cách đổi Base URL + model.

## Chạy từ source

### Cách A — có Node.js 18+ (khuyên dùng khi phát triển)
```bat
npm install
npm start          :: chạy app
npm run dist       :: đóng gói ra dist\ReadChinese-<version>-portable.exe
```

### Cách B — không cần Node.js
Bấm đúp **`build-portable.bat`**. Script tải Electron từ GitHub (~110MB, chỉ lần đầu), ghép source vào và tạo
`build\ReadChinese\ReadChinese.exe` + shortcut ngoài Desktop. Sửa code xong chạy lại script là có bản mới.

## Phím tắt (đổi trong ⚙)
| Phím | Chức năng |
|---|---|
| `Alt+Q` | Chụp vùng màn hình → OCR → pinyin → dịch |
| `Alt+E` | Dịch nội dung clipboard |
| `Alt+W` | Mở cửa sổ dịch |
| `Ctrl+Enter` | Dịch lại sau khi sửa văn bản |
| `Esc` | Ẩn cửa sổ / huỷ chụp |
| `F12` / `Ctrl+Shift+I` | Mở DevTools (debug giao diện) |

## Tính năng
- Pinyin hiển thị bằng `<ruby>` trên từng chữ; chữ **đa âm** có pinyin gạch chân chấm — **bấm vào chữ** để đổi cách đọc.
- Cửa sổ **tự ẩn khi bấm ra ngoài** như Pot; bấm nút ghim (chuyển màu đỏ) để giữ cửa sổ luôn hiện.
- ✎ sửa văn bản OCR sai (pinyin cập nhật khi gõ), `拼` copy pinyin, `⧉` copy chữ Hán; đổi `nǐ hǎo` ↔ `ni3 hao3`; A−/A+ cỡ chữ.
- Nối các dòng OCR thành đoạn (chữ Hán bị xuống dòng giữa từ được nối liền).
- OCR chạy trong tiến trình Python thường trú → model chỉ tải 1 lần.
- Tiền xử lý ảnh trước khi OCR: tự đảo màu khi nền tối (dark mode), phóng to vùng nhỏ (tới 2.5×), thêm viền để
  chữ sát mép không bị mất; ngưỡng nhận dạng nới lỏng (`text_score 0.3`, `box_thresh 0.3`).
- Sắp xếp theo thứ tự đọc: gom các khung cùng hàng rồi xếp trái → phải; khoảng trống lớn giữa hai dòng
  (vd. hai tin nhắn chat) được tách thành dòng mới.
- **Đọc to chữ Hán** (nút loa, hoặc bôi đen một đoạn rồi bấm loa để chỉ đọc đoạn đó; `Esc` để dừng):
  - **Windows – offline**: dùng giọng tiếng Trung cài sẵn của Windows (Huihui, Kangkang, Yaoyao…), chữ đang đọc được tô sáng.
    Nếu chưa có: *Settings → Time & language → Language & region → Add a language → 中文(中华人民共和国)* và tick *Text-to-speech*.
  - **Edge TTS**: giọng tự nhiên (Xiaoxiao, Yunxi…) qua gói Python `edge-tts` (app tự cài). Cần mạng cho câu mới;
    câu đã đọc được lưu cache ở `%APPDATA%\ReadChinese\tts-cache` nên đọc lại không cần mạng.
  - Tuỳ chọn tốc độ đọc và tự đọc sau khi OCR.
- Ngôn ngữ đích riêng cho Google và DeepSeek (mặc định: Google → English, DeepSeek → Tiếng Việt).

## Cấu trúc
```
src/main.js            tiến trình chính: phím tắt, chụp màn hình, OCR, gọi API dịch, cấu hình
src/preload.js         cầu nối IPC an toàn cho giao diện
src/index.html, renderer.js, style.css   cửa sổ dịch
src/capture.html       lớp phủ chọn vùng
src/vendor/pinyin-pro.js   pinyin-pro v3.29.5 (MIT) build sẵn dạng IIFE (global `pinyinPro`)
python/ocr_server.py   RapidOCR qua stdin/stdout, mỗi dòng 1 JSON
scripts/build-portable.ps1  đóng gói không cần Node.js
```

### Giao thức OCR (để debug)
Electron chạy `python -u python/ocr_server.py`, gửi mỗi dòng `{"id":1,"path":"C:/.../shot.png"}`
và nhận `{"id":1,"ok":true,"lines":[{"text":"…","score":0.98,"box":[[x,y],…]}]}`.
Có thể test riêng: `echo {"id":1,"path":"anh.png"} | python python/ocr_server.py`.

### Cấu hình
Lưu ở `%APPDATA%\ReadChinese\config.json` (tự lấy từ bản PotPinyin cũ nếu có).

## Lỗi thường gặp
- **Không chạy được Python** → ⚙ nhập đường dẫn đầy đủ tới `python.exe`.
- **Không tự cài được RapidOCR** → `python -m pip install rapidocr_onnxruntime` (Python ≥ 3.13: `pip install rapidocr onnxruntime`, app nhận cả 2 gói).
- **Google lỗi 429** → endpoint miễn phí bị Google giới hạn theo IP. App đã gọi qua mạng Chromium với User-Agent trình duyệt
  và tự xoay vòng 4 endpoint (endpoint bị 429 nghỉ 10 phút). Nếu vẫn bị: tắt VPN/proxy, đổi mạng, hoặc nhập
  **Google Cloud Translation API key** trong ⚙ (miễn phí 500.000 ký tự/tháng, cần tài khoản Google Cloud có bật billing).
- **Màn hình nháy/giật khi Alt+Q** → app đã: tắt bộ chụp Windows Graphics Capture; tạo sẵn lớp phủ và chỉ hiện khi ảnh đã vẽ xong;
  dùng JPEG cho lớp phủ; vẽ vùng chọn bằng `clip-path` theo khung hình; ẩn lớp phủ ngay khi nhả chuột; chạy OCR ở độ ưu tiên thấp
  và giới hạn 4 luồng CPU (`ocrThreads` trong config.json). Nếu vẫn giật hãy mở issue kèm cấu hình máy.
- **Edge TTS lỗi 403** → bản `edge-tts` cũ bị Microsoft từ chối; app tự chạy `pip install -U edge-tts` rồi thử lại (cần ≥ 7.2.7).
  Nếu vẫn 403: đồng bộ lại giờ hệ thống (Settings → Time → Sync now), tắt VPN/proxy, hoặc dùng bộ đọc Windows offline.
  Khi Edge lỗi mà máy có giọng tiếng Trung của Windows, app tự đọc tạm bằng giọng Windows.

## Giấy phép thư viện
pinyin-pro © zh-lx — MIT (`src/vendor/pinyin-pro.LICENSE`). RapidOCR — Apache-2.0. Electron — MIT.
