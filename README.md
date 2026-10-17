# ReadChinese

A lightweight screen translator for Chinese learners on Windows:
capture any area of the screen → **RapidOCR** recognizes the Chinese text → **pinyin is shown above every character**
([pinyin-pro](https://github.com/zh-lx/pinyin-pro), context-aware readings) → translated side by side by
**Google Translate** and any number of **AI models** (DeepSeek, OpenAI, Claude, Gemini, OpenRouter, Ollama, …),
with streaming output and read-aloud.

Built with Electron 33. OCR runs in a small Python process.

## Requirements
- **Python 3.9–3.12** on PATH. RapidOCR is **installed automatically** on first run, or manually:
  `pip install -r python/requirements.txt`
- At least one translator: Google (free, no key) and/or an AI provider API key.

## Run from source

### Option A — with Node.js 18+ (for development)
```bat
npm install
npm start          :: run the app
npm run dist       :: build dist\ReadChinese-<version>-portable.exe
```

### Option B — without Node.js
Double-click **`build-portable.bat`**. It downloads the Electron runtime from GitHub (~110 MB, first time only) and the
native screen-capture module from npm (~1 MB), copies the source in, and creates
`build\ReadChinese\ReadChinese.exe` plus a Desktop shortcut. Re-run it after changing the code.

## Hotkeys (configurable in Settings)
| Key | Action |
|---|---|
| `Alt+Q` | Capture a screen area → OCR → pinyin → translate |
| `Alt+E` | Translate the clipboard text |
| `Alt+W` | Show the window |
| `Ctrl+Enter` | Re-translate after editing the text |
| `Esc` | Close settings / stop reading / hide the window / cancel capture |
| `F12` / `Ctrl+Shift+I` | DevTools (debugging) |

## Features
- **Pinyin above each character** using `<ruby>`. Characters with several readings have a dotted underline —
  **click one to cycle its readings** if the automatic choice is wrong. Tone marks `nǐ hǎo` or numbers `ni3 hao3`, A−/A+ font size.
- **Edit** OCR mistakes (✎) with live pinyin, copy the Chinese text (⧉) or the pinyin (拼).
- **Translators can be switched on/off independently** in Settings:
  - **Google Translate** – free endpoints with automatic rotation; optional official Cloud Translation API key.
  - **AI translation** – add as many providers as you like; every enabled provider gets its own result card.
    Each provider has a *type*, *Base URL*, *API key* and *model*; press **Test** to verify the key and load the model list.

    | Preset | Type | Base URL |
    |---|---|---|
    | DeepSeek | OpenAI-compatible | `https://api.deepseek.com` |
    | OpenAI | OpenAI-compatible | `https://api.openai.com/v1` |
    | Claude | Anthropic | `https://api.anthropic.com` |
    | Gemini | OpenAI-compatible | `https://generativelanguage.googleapis.com/v1beta/openai` |
    | OpenRouter | OpenAI-compatible | `https://openrouter.ai/api/v1` |
    | Ollama (local) | OpenAI-compatible | `http://localhost:11434/v1` (no key needed) |
    | Custom | either | any compatible endpoint |
- **Read aloud**: select part of the text to read only that part.
  - *Windows – offline*: installed Chinese system voices; the word being spoken is highlighted.
    To add one: Windows Settings → Time & language → Language & region → add 中文(中华人民共和国) with *Text-to-speech*.
  - *Edge TTS*: natural neural voices via the Python package `edge-tts` (installed automatically). Needs Internet for new
    text; audio is cached in `%APPDATA%\ReadChinese\tts-cache`.
- **Compact window** that grows and shrinks with its content, hides when you click elsewhere, and can be pinned.
- **Fast capture**: [node-screenshots](https://github.com/nashaofu/node-screenshots) (Rust, GDI) captures on a worker
  thread, so the UI never blocks; falls back to Electron's `desktopCapturer` if the native module is missing.
- **Light OCR**: RapidOCR runs at below-normal priority with 2 CPU threads by default (Settings → General).
  Dark backgrounds are inverted and a small border is added before recognition; lines are re-ordered in reading
  order and separate chat messages become separate lines.

## Project layout
```
src/main.js              main process: hotkeys, capture, OCR process, Google/AI translation, TTS, config
src/preload.js           safe IPC bridge for the windows
src/index.html, renderer.js, style.css   translator window + settings
src/capture.html         area-selection overlay
src/vendor/pinyin-pro.js pinyin-pro v3.29.5 (MIT), prebuilt IIFE bundle (global `pinyinPro`)
python/ocr_server.py     RapidOCR over stdin/stdout, one JSON object per line
scripts/build-portable.ps1  build without Node.js
```

### OCR protocol (for debugging)
Electron runs `python -u python/ocr_server.py`, writes `{"id":1,"path":"C:/…/shot.png"}` per line and reads
`{"id":1,"ok":true,"lines":[{"text":"…","score":0.98,"box":[[x,y],…]}]}`.
Test it alone: `echo {"id":1,"path":"image.png"} | python python/ocr_server.py`.

### Configuration
Stored in `%APPDATA%\ReadChinese\config.json` (API keys are stored there in plain text — do not share this file).
Advanced keys: `ocrThreads`, `captureBackend` (`"auto"` or `"electron"`).

## Troubleshooting
- **Cannot start Python** → Settings → General → set the full path to `python.exe`.
- **RapidOCR could not be installed** → `python -m pip install rapidocr_onnxruntime`
  (Python ≥ 3.13: `pip install rapidocr onnxruntime`; both packages are supported).
- **Google 429** → the free service is rate-limiting your IP. Wait a few minutes, disable VPN/proxy, or add an official
  Google Cloud Translation API key.
- **AI 401 / 404** → wrong API key or model name; press **Test** next to the provider and pick a model from the list.
- **Edge TTS 403** → the app updates `edge-tts` automatically and retries; if it still fails, sync the PC clock
  (Settings → Time → Sync now) or turn off VPN/proxy. Meanwhile the Windows voice is used if installed.
- **Capture feels slow** → check the last line of Settings → General shows `native (node-screenshots)`;
  if it says `Electron`, re-run `build-portable.bat`. Lower *OCR CPU threads* on 4-core machines.

## Third-party licenses
pinyin-pro © zh-lx — MIT (`src/vendor/pinyin-pro.LICENSE`) · RapidOCR — Apache-2.0 ·
node-screenshots — Apache-2.0 · Electron — MIT · edge-tts (installed separately via pip, see its own license).
