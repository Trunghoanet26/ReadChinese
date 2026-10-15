const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer,
  clipboard, Tray, Menu, nativeImage, Notification, net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');

app.setName('ReadChinese');
// Tắt bộ chụp Windows Graphics Capture (gây viền vàng/nháy toàn màn hình khi chụp) → dùng DXGI/GDI
app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer,AllowWgcWindowCapturer');

// Ngôn ngữ đích: mã Google → tên tiếng Anh (dùng trong prompt DeepSeek)
const LANGS = {
  vi: 'Vietnamese', en: 'English', 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
  ja: 'Japanese', ko: 'Korean', th: 'Thai', id: 'Indonesian', ms: 'Malay', fr: 'French',
  de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian', ru: 'Russian', ar: 'Arabic', hi: 'Hindi',
};

// ---------------------------------------------------------------- config
const CONFIG_PATH = path.join(app.getPath('appData'), 'ReadChinese', 'config.json');
const OLD_CONFIGS = ['PotPinyin', 'pot-pinyin'].map((n) => path.join(app.getPath('appData'), n, 'config.json'));
const DEFAULTS = {
  deepseekKey: '',
  deepseekModel: 'deepseek-flash',
  deepseekBaseUrl: 'https://api.deepseek.com',
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  hotkeyOcr: 'Alt+Q',
  hotkeyClipboard: 'Alt+E',
  hotkeyShow: 'Alt+W',
  mergeLines: true,
  toneType: 'symbol', // symbol | num
  fontSize: 22,
  pinned: false, // false = tự ẩn khi bấm ra ngoài (giống Pot)
  googleTarget: 'en',
  googleApiKey: '', // tuỳ chọn: Cloud Translation API key chính thức
  ttsEngine: 'windows', // windows (offline, giọng có sẵn của Windows) | edge (Edge TTS online, có cache)
  ttsWinVoice: '',
  ttsEdgeVoice: 'zh-CN-XiaoxiaoNeural',
  ttsRate: 1.0,
  autoSpeak: false,
  ocrThreads: 4,
  deepseekTarget: 'vi',
};
let config = { ...DEFAULTS };
function loadConfig() {
  // lấy cấu hình cũ (bản PotPinyin) nếu chưa có cấu hình ReadChinese
  const file = [CONFIG_PATH, ...OLD_CONFIGS].find((f) => fs.existsSync(f));
  try { if (file) config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* hỏng → mặc định */ }
  delete config.alwaysOnTop;
  if (file && file !== CONFIG_PATH) saveConfig();
  if (!config.deepseekKey && process.env.DEEPSEEK_API_KEY) config.deepseekKey = process.env.DEEPSEEK_API_KEY;
}
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------- OCR (python subprocess)
let ocrProc = null;
let ocrReady = null;
let ocrSeq = 1;
const ocrPending = new Map();

function pythonDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'python') : path.join(__dirname, '..', 'python');
}

function startOcr() {
  if (ocrProc) return ocrReady;
  ocrReady = new Promise((resolve, reject) => {
    const script = path.join(pythonDir(), 'ocr_server.py');
    ocrProc = spawn(config.pythonPath, ['-u', script], {
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        // giới hạn số luồng ONNX để OCR không chiếm hết CPU (gây giật màn hình)
        OCR_THREADS: String(config.ocrThreads || 4),
        OMP_NUM_THREADS: String(config.ocrThreads || 4),
      },
      windowsHide: true,
    });
    try { os.setPriority(ocrProc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* bỏ qua */ }
    let stderrTail = '';
    ocrProc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    ocrProc.on('error', (err) => {
      ocrProc = null;
      reject(new Error(`Không chạy được Python ("${config.pythonPath}"): ${err.message}`));
    });
    ocrProc.on('exit', (code) => {
      const err = new Error(`OCR server thoát (code ${code}). ${stderrTail}`);
      for (const p of ocrPending.values()) p.reject(err);
      ocrPending.clear();
      ocrProc = null;
      reject(err);
    });
    readline.createInterface({ input: ocrProc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 0) {
        if (msg.ready) resolve();
        else reject(new Error(msg.error || 'OCR init lỗi'));
        return;
      }
      const p = ocrPending.get(msg.id);
      if (!p) return;
      ocrPending.delete(msg.id);
      msg.ok ? p.resolve(msg.lines) : p.reject(new Error(msg.error));
    });
  });
  ocrReady.catch(() => { ocrProc = null; ocrReady = null; });
  return ocrReady;
}

const runPip = async (args) => (await runPython(['-m', 'pip', 'install', '-U', ...args], { timeout: 600000 })).ok;

let installing = null;
async function ensureOcr() {
  try {
    await startOcr();
  } catch (err) {
    if (!/RapidOCR/.test(err.message)) throw err;
    // Chưa có RapidOCR → tự cài một lần bằng pip của Python đang dùng
    send('ocr:status', 'Lần đầu chạy: đang cài RapidOCR (1–3 phút)…');
    installing = installing || (async () => (await runPip(['rapidocr_onnxruntime']))
      || runPip(['rapidocr', 'onnxruntime']))();
    const ok = await installing;
    installing = null;
    if (!ok) throw new Error(`Không tự cài được RapidOCR. Mở CMD chạy: ${config.pythonPath} -m pip install rapidocr_onnxruntime`);
    send('ocr:status', 'Đã cài xong RapidOCR, đang nhận dạng…');
    await startOcr();
  }
}

async function ocrImage(file) {
  await ensureOcr();
  const id = ocrSeq++;
  return new Promise((resolve, reject) => {
    ocrPending.set(id, { resolve, reject });
    ocrProc.stdin.write(JSON.stringify({ id, path: file }) + '\n');
  });
}

const CJK_END = /[　-〿㐀-鿿豈-﫿＀-￯]$/;
const CJK_START = /^[　-〿㐀-鿿豈-﫿＀-￯]/;
// Sắp xếp kết quả OCR theo thứ tự đọc: gom các khung cùng hàng (chồng lấn theo chiều dọc),
// trong mỗi hàng xếp trái → phải. Tránh lỗi 1 dòng bị tách 2 khung rồi bị đảo thứ tự.
function boxInfo(l, i) {
  const pts = Array.isArray(l.box) ? l.box : null;
  if (!pts || !pts.length) return { l, top: i * 1000, bottom: i * 1000 + 1, left: 0 };
  const ys = pts.map((p) => p[1]), xs = pts.map((p) => p[0]);
  return { l, top: Math.min(...ys), bottom: Math.max(...ys), left: Math.min(...xs) };
}
function orderLines(lines) {
  const boxes = lines.map(boxInfo).filter((b) => b.l.text && b.l.text.trim()).sort((a, b) => a.top - b.top);
  const rows = [];
  for (const b of boxes) {
    const h = b.bottom - b.top;
    const row = rows.find((r) => {
      const overlap = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      return overlap > 0.5 * Math.min(h, r.bottom - r.top);
    });
    if (row) { row.items.push(b); row.top = Math.min(row.top, b.top); row.bottom = Math.max(row.bottom, b.bottom); }
    else rows.push({ top: b.top, bottom: b.bottom, items: [b] });
  }
  rows.sort((a, b) => a.top - b.top);
  return rows.map((r, i) => {
    // khoảng trống lớn so với dòng trước = đoạn/tin nhắn mới
    const prev = rows[i - 1];
    const lineH = r.bottom - r.top;
    const gapBefore = prev ? r.top - prev.bottom : 0;
    const text = r.items.sort((a, b) => a.left - b.left).map((b) => b.l.text.trim())
    .reduce((acc, t) => (!acc ? t : acc + (/[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(t) ? ' ' : '') + t), '');
    return { text, newPara: !!prev && gapBefore > 0.8 * lineH };
  });
}
function joinLines(lines) {
  const texts = orderLines(lines);
  if (!config.mergeLines) return texts.map((r) => r.text).join('\n');
  let out = '';
  for (const { text: t, newPara } of texts) {
    if (!out) out = t;
    else if (newPara || /[。！？!?…]$/.test(out)) out += '\n' + t; // hết câu / đoạn mới → xuống dòng
    else if (CJK_END.test(out) && CJK_START.test(t)) out += t; // chữ Hán bị xuống dòng giữa câu → nối liền
    else out += ' ' + t;
  }
  return out;
}

// ---------------------------------------------------------------- translation
// Google dịch: endpoint miễn phí hay trả 429 khi request "không giống trình duyệt".
// → gọi qua mạng của Chromium (net.fetch: TLS, proxy hệ thống giống Chrome) + User-Agent trình duyệt,
//   xoay vòng nhiều endpoint, endpoint nào bị 429 thì nghỉ 10 phút. Có API key chính thức thì dùng luôn.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/130.0.0.0 Safari/537.36';
const parseDj = (d) => (d.sentences || []).map((x) => x.trans || '').join('');
const parseT = (d) => (Array.isArray(d) ? d.map((x) => (Array.isArray(x) ? x[0] : x)).join('') : parseDj(d));
const GOOGLE_ENDPOINTS = [
  {
    name: 'translate.googleapis.com (gtx)',
    url: (tl, q) => `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&dj=1&ie=UTF-8&oe=UTF-8&q=${q}`,
    parse: parseDj,
  },
  {
    name: 'translate.google.com (gtx)',
    url: (tl, q) => `https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&hl=${tl}&dt=t&dj=1&ie=UTF-8&oe=UTF-8&q=${q}`,
    parse: parseDj,
  },
  {
    name: 'clients5.google.com (dict-chrome-ex)',
    url: (tl, q) => `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${tl}&q=${q}`,
    parse: parseT,
  },
  {
    name: 'translate.googleapis.com (t)',
    url: (tl, q) => `https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=${tl}&q=${q}`,
    parse: parseT,
  },
];
const googleCooldown = new Map(); // tên endpoint → thời điểm được thử lại
let googlePreferred = 0;          // endpoint chạy được gần nhất

async function googleOfficial(text, tl) {
  const res = await net.fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(config.googleApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, target: tl, format: 'text' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${data.error?.message || ''}`);
  return data.data.translations.map((t) => t.translatedText).join('\n');
}

async function googleTranslate(text, tl = 'en') {
  if (config.googleApiKey) return googleOfficial(text, tl);
  const q = encodeURIComponent(text);
  const n = GOOGLE_ENDPOINTS.length;
  const errors = [];
  for (let k = 0; k < n; k++) {
    const i = (googlePreferred + k) % n;
    const ep = GOOGLE_ENDPOINTS[i];
    if ((googleCooldown.get(ep.name) || 0) > Date.now()) { errors.push(`${ep.name}: đang tạm nghỉ`); continue; }
    try {
      const res = await net.fetch(ep.url(tl, q), {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        googleCooldown.set(ep.name, Date.now() + (res.status === 429 ? 10 * 60e3 : 60e3));
        errors.push(`${ep.name}: HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) { errors.push(`${ep.name}: HTTP ${res.status}`); continue; }
      const out = ep.parse(await res.json());
      if (!out) { errors.push(`${ep.name}: rỗng`); continue; }
      googlePreferred = i;
      googleCooldown.delete(ep.name);
      return out;
    } catch (err) {
      errors.push(`${ep.name}: ${err.name === 'TimeoutError' ? 'quá thời gian' : err.message}`);
    }
  }
  console.error('[google]', errors.join(' | '));
  const blocked = errors.some((e) => /HTTP 429|HTTP 403|tạm nghỉ/.test(e));
  throw new Error((blocked
    ? 'Google đang chặn tạm thời (429) trên mạng/IP này. Thử lại sau ít phút, tắt VPN/proxy, '
      + 'hoặc nhập Google API key (miễn phí 500k ký tự/tháng) trong ⚙.'
    : 'Không kết nối được Google dịch (kiểm tra mạng/proxy).') + '\n' + errors.join('\n'));
}

// Chuẩn hoá Base URL: bỏ "/" cuối và "/chat/completions" nếu người dùng dán cả đường dẫn đầy đủ
function deepseekBase(url = config.deepseekBaseUrl) {
  return (url || 'https://api.deepseek.com').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

// Kiểm tra key + lấy danh sách model (API kiểu OpenAI: GET /models)
ipcMain.handle('deepseek:test', async (_e, { baseUrl, key }) => {
  const base = deepseekBase(baseUrl);
  if (/\/anthropic$/.test(base)) return { ok: false, error: 'App dùng định dạng OpenAI → Base URL là https://api.deepseek.com (không phải /anthropic).' };
  if (!key) return { ok: false, error: 'Chưa nhập API key.' };
  try {
    const res = await fetch(base + '/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    const body = await res.text();
    if (res.status === 401) return { ok: false, error: 'API key không đúng (401).' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    const models = (JSON.parse(body).data || []).map((m) => m.id).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: `Không kết nối được ${base}: ${err.message}` };
  }
});

async function deepseekTranslate(text, onDelta, signal) {
  if (!config.deepseekKey) throw new Error('Chưa nhập DeepSeek API key (bấm ⚙ để cài đặt).');
  const res = await fetch(deepseekBase() + '/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deepseekKey}` },
    body: JSON.stringify({
      model: config.deepseekModel,
      stream: true,
      temperature: 1.3,
      messages: [
        {
          role: 'system',
          content: `You are a professional translator. Translate the user's text (usually Chinese) into natural, `
            + `context-appropriate ${LANGS[config.deepseekTarget] || config.deepseekTarget}. Keep line breaks. `
            + 'Output only the translation: no explanations, no pinyin, no quotes.',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401) throw new Error('DeepSeek: API key không đúng (401). Kiểm tra lại trong ⚙.');
    if (res.status === 402) throw new Error('DeepSeek: tài khoản hết số dư (402).');
    if (/model/i.test(body) && res.status === 400) throw new Error(`DeepSeek: model "${config.deepseekModel}" không hợp lệ – bấm "Kiểm tra" trong ⚙ để chọn model đúng. ${body}`);
    throw new Error(`DeepSeek HTTP ${res.status}: ${body}`);
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch { /* dòng keep-alive */ }
    }
  }
}

// ---------------------------------------------------------------- Edge TTS (python edge-tts, có cache)
const TTS_CACHE = path.join(app.getPath('appData'), 'ReadChinese', 'tts-cache');
const TTS_CACHE_MAX = 500;

function runPython(args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(config.pythonPath, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    const t = setTimeout(() => p.kill(), timeout);
    p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, err: e.message }); });
    p.on('exit', (code) => { clearTimeout(t); resolve({ ok: code === 0, err }); });
  });
}

let edgeTtsChecked = null;
let edgeTtsUpgraded = false;

function explainEdgeError(err = '') {
  if (/403|Invalid response status/.test(err)) {
    return 'Edge TTS bị Microsoft từ chối (403). Đã thử cập nhật edge-tts nhưng vẫn lỗi. Nguyên nhân thường gặp: '
      + 'đồng hồ máy tính lệch giờ (vào Settings → Time → "Sync now"), dùng VPN/proxy, hoặc IP bị giới hạn tạm thời. '
      + 'Tạm thời dùng bộ đọc "Windows – offline" trong ⚙.';
  }
  if (/getaddrinfo|ClientConnectorError|Cannot connect|timed? ?out/i.test(err)) {
    return 'Edge TTS cần Internet cho câu chưa có trong cache – không kết nối được máy chủ Microsoft.';
  }
  if (/No module named/.test(err)) return 'Chưa cài edge-tts: chạy "python -m pip install -U edge-tts".';
  const last = err.trim().split('\n').filter(Boolean).pop() || 'không rõ';
  return `Edge TTS lỗi: ${last.slice(0, 200)}`;
}
function ensureEdgeTts() {
  edgeTtsChecked = edgeTtsChecked || (async () => {
    if ((await runPython(['-c', 'import edge_tts'])).ok) return;
    send('ocr:status', 'Đang cài edge-tts (lần đầu)…');
    if (!(await runPython(['-m', 'pip', 'install', '-U', 'edge-tts'], { timeout: 300000 })).ok) {
      throw new Error(`Không cài được edge-tts. Chạy: ${config.pythonPath} -m pip install edge-tts`);
    }
    send('ocr:status', '');
  })();
  edgeTtsChecked.catch(() => { edgeTtsChecked = null; });
  return edgeTtsChecked;
}

function trimTtsCache() {
  fs.readdir(TTS_CACHE, (e, files) => {
    if (e || files.length <= TTS_CACHE_MAX) return;
    const list = files.map((f) => ({ f, t: fs.statSync(path.join(TTS_CACHE, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const { f } of list.slice(0, files.length - TTS_CACHE_MAX)) fs.rm(path.join(TTS_CACHE, f), () => {});
  });
}

async function edgeTts(text, voice, rate) {
  const pct = Math.round((Number(rate) || 1) * 100 - 100);
  const rateStr = `${pct >= 0 ? '+' : ''}${pct}%`;
  const key = crypto.createHash('sha1').update(`${voice}|${rateStr}|${text}`).digest('hex');
  const out = path.join(TTS_CACHE, `${key}.mp3`);
  if (!fs.existsSync(out)) {
    await ensureEdgeTts();
    await fs.promises.mkdir(TTS_CACHE, { recursive: true });
    const txt = path.join(os.tmpdir(), `readchinese_tts_${key}.txt`);
    await fs.promises.writeFile(txt, text, 'utf8');
    const tmpOut = `${out}.part`;
    const synth = () => runPython(['-m', 'edge_tts', '--voice', voice, `--rate=${rateStr}`, '--file', txt, '--write-media', tmpOut]);
    let r = await synth();
    // 403 = bản edge-tts cũ bị Microsoft từ chối → tự cập nhật (1 lần mỗi phiên) rồi thử lại
    if (!r.ok && /403|Invalid response status/.test(r.err) && !edgeTtsUpgraded) {
      edgeTtsUpgraded = true;
      send('ocr:status', 'Edge TTS bị từ chối (403) → đang cập nhật edge-tts…');
      await runPip(['edge-tts']);
      send('ocr:status', '');
      r = await synth();
    }
    fs.rm(txt, () => {});
    if (!r.ok || !fs.existsSync(tmpOut)) {
      fs.rm(tmpOut, () => {});
      throw new Error(explainEdgeError(r.err));
    }
    await fs.promises.rename(tmpOut, out);
    trimTtsCache();
  }
  const buf = await fs.promises.readFile(out);
  return `data:audio/mpeg;base64,${buf.toString('base64')}`;
}

ipcMain.handle('tts:edge', async (_e, { text, voice, rate }) => {
  try { return { ok: true, url: await edgeTts(text, voice || config.ttsEdgeVoice, rate ?? config.ttsRate) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---------------------------------------------------------------- windows
let mainWin = null;
let captureWin = null;
let tray = null;
let jobId = 0;
let dsAbort = null;

function createMainWindow() {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  mainWin = new BrowserWindow({
    width: 440, height: 640,
    x: Math.min(cursor.x + 10, workArea.x + workArea.width - 440),
    y: Math.max(workArea.y, Math.min(cursor.y, workArea.y + workArea.height - 640)),
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#1e1f24',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  // F12 / Ctrl+Shift+I: mở DevTools để debug
  mainWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWin.webContents.toggleDevTools();
    }
  });
  mainWin.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); } });
  // Giống Pot: chưa ghim thì bấm ra ngoài là tự ẩn
  mainWin.on('blur', () => {
    if (config.pinned || capturing || Date.now() - lastShown < 400) return;
    if (mainWin.webContents.isDevToolsOpened()) return;
    mainWin.hide();
  });
}

let lastShown = 0;
function showMain() {
  lastShown = Date.now();
  if (!mainWin) createMainWindow();
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const [w, h] = mainWin.getSize();
  if (!mainWin.isVisible()) {
    mainWin.setPosition(
      Math.round(Math.max(workArea.x, Math.min(cursor.x + 10, workArea.x + workArea.width - w))),
      Math.round(Math.max(workArea.y, Math.min(cursor.y + 10, workArea.y + workArea.height - h))),
    );
  }
  mainWin.show();
  mainWin.focus();
}

let capturing = false;
let captureShot = null;
let captureSf = 1;

function ensureCaptureWindow() {
  if (captureWin && !captureWin.isDestroyed()) return captureWin;
  captureWin = new BrowserWindow({
    x: 0, y: 0, width: 800, height: 600,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, enableLargerThanScreen: true,
    hasShadow: false, show: false, backgroundColor: '#000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  captureWin.setAlwaysOnTop(true, 'screen-saver');
  captureWin.loadFile(path.join(__dirname, 'capture.html'));
  captureWin.on('closed', () => { captureWin = null; capturing = false; });
  return captureWin;
}

function endCapture() {
  capturing = false;
  if (captureWin && !captureWin.isDestroyed()) {
    captureWin.hide();
    // xoá ảnh cũ sau khi cửa sổ đã ẩn để lần sau không hiện lại & giải phóng bộ nhớ
    setTimeout(() => captureWin?.webContents.send('capture:reset'), 50);
  }
}

async function startCapture() {
  if (capturing) return;
  capturing = true;
  try {
    // ẩn cửa sổ dịch (nếu không ghim) để nó không lọt vào ảnh chụp
    if (mainWin?.isVisible() && !config.pinned) {
      mainWin.hide();
      await new Promise((r) => setTimeout(r, 120));
    }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    captureSf = display.scaleFactor;
    const size = { width: Math.round(display.size.width * captureSf), height: Math.round(display.size.height * captureSf) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    captureShot = src.thumbnail;

    const win = ensureCaptureWindow();
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    win.setBounds(display.bounds);
    // renderer báo 'capture:ready' sau khi ảnh đã vẽ xong → mới hiện cửa sổ (tránh khung đen nháy)
    // JPEG mã hoá/giải mã nhanh hơn PNG nhiều lần → lớp phủ hiện nhanh hơn (ảnh gốc vẫn dùng cho OCR)
    win.webContents.send('capture:image', `data:image/jpeg;base64,${captureShot.toJPEG(92).toString('base64')}`);
  } catch (err) {
    capturing = false;
    console.error('[capture]', err);
  }
}

ipcMain.on('capture:ready', () => {
  if (!capturing || !captureWin) return;
  captureWin.show();
  captureWin.focus();
});

ipcMain.handle('capture:done', async (_e, rect) => {
  const shot = captureShot;
  const sf = captureSf;
  captureShot = null; // giải phóng ảnh toàn màn hình sớm
  endCapture();
  if (!shot || !rect || rect.width < 4 || rect.height < 4) return;
  // nhường 1 nhịp cho Windows ẩn lớp phủ trước khi làm việc nặng
  await new Promise((r) => setTimeout(r, 16));
  const crop = shot.crop({
    x: Math.round(rect.x * sf), y: Math.round(rect.y * sf),
    width: Math.round(rect.width * sf), height: Math.round(rect.height * sf),
  });
  const file = path.join(os.tmpdir(), `readchinese_${Date.now()}.png`);
  await fs.promises.writeFile(file, crop.toPNG());
  showMain();
  send('ocr:start');
  try {
    const lines = await ocrImage(file);
    const text = joinLines(lines);
    send('ocr:result', { text, lines, autoSpeak: !!config.autoSpeak });
    if (text) translateAll(text);
  } catch (err) {
    send('ocr:error', err.message);
  } finally {
    fs.rm(file, () => {});
  }
});

function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

function translateAll(text) {
  const id = ++jobId;
  if (dsAbort) dsAbort.abort();
  dsAbort = new AbortController();
  send('tr:start', { id });

  googleTranslate(text, config.googleTarget || 'en')
    .then((r) => send('tr:google', { id, text: r }))
    .catch((e) => send('tr:google', { id, error: e.message }));

  deepseekTranslate(text, (delta) => send('tr:deepseek:delta', { id, delta }), dsAbort.signal)
    .then(() => send('tr:deepseek:done', { id }))
    .catch((e) => { if (e.name !== 'AbortError') send('tr:deepseek:done', { id, error: e.message }); });
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const bad = [];
  const reg = (key, fn) => { if (key && !globalShortcut.register(key, fn)) bad.push(key); };
  reg(config.hotkeyOcr, () => startCapture().catch((e) => console.error(e)));
  reg(config.hotkeyShow, () => showMain());
  reg(config.hotkeyClipboard, () => {
    const text = clipboard.readText().trim();
    showMain();
    if (text) { send('input:set', text); translateAll(text); }
  });
  if (bad.length && Notification.isSupported()) {
    new Notification({ title: 'ReadChinese', body: `Không đăng ký được phím tắt: ${bad.join(', ')}` }).show();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('ReadChinese');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `OCR vùng màn hình (${config.hotkeyOcr})`, click: () => startCapture() },
    { label: `Mở cửa sổ dịch (${config.hotkeyShow})`, click: () => showMain() },
    { type: 'separator' },
    { label: 'Thoát', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMain());
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('config:get', () => config);
ipcMain.handle('langs:get', () => LANGS);
ipcMain.handle('config:set', (_e, patch) => {
  const hotkeysChanged = ['hotkeyOcr', 'hotkeyClipboard', 'hotkeyShow'].some((k) => k in patch && patch[k] !== config[k]);
  config = { ...config, ...patch };
  saveConfig();
  if (hotkeysChanged) registerHotkeys();
  if (patch.pythonPath && ocrProc) { ocrProc.kill(); ocrProc = null; ocrReady = null; }
  return config;
});
ipcMain.on('translate', (_e, text) => { if (text?.trim()) translateAll(text.trim()); });
ipcMain.on('capture:start', () => startCapture());
ipcMain.on('win:hide', () => mainWin?.hide());
ipcMain.on('win:pin', (_e, v) => { config.pinned = !!v; saveConfig(); });
ipcMain.on('clipboard:write', (_e, t) => clipboard.writeText(t));

// ---------------------------------------------------------------- app lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(() => {
    loadConfig();
    createMainWindow();
    createTray();
    registerHotkeys();
    ensureCaptureWindow(); // tạo sẵn cửa sổ chụp (ẩn) để Alt+Q hiện ngay
    // khởi động OCR trước (tự cài RapidOCR nếu thiếu) khi giao diện đã sẵn sàng
    mainWin.webContents.once('did-finish-load', () => ensureOcr().catch((e) => send('ocr:error', e.message)));
    showMain();
  });
  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ocrProc) ocrProc.kill(); });
}
