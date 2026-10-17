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
const { pathToFileURL } = require('url');

app.setName('ReadChinese');
// Disable the Windows Graphics Capture backend of desktopCapturer (it can flash a yellow border /
// the whole screen). Only matters when the native capture module is unavailable.
app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer,AllowWgcWindowCapturer');

// Target languages: Google language code -> English name (used in AI prompts)
const LANGS = {
  vi: 'Vietnamese', en: 'English', 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
  ja: 'Japanese', ko: 'Korean', th: 'Thai', id: 'Indonesian', ms: 'Malay', fr: 'French',
  de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian', ru: 'Russian', ar: 'Arabic', hi: 'Hindi',
};

// AI provider presets. "openai" = OpenAI-compatible Chat Completions API, "anthropic" = Anthropic Messages API.
const AI_PRESETS = {
  deepseek: { name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  openai: { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
  anthropic: { name: 'Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '' },
  gemini: { name: 'Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '' },
  openrouter: { name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  ollama: { name: 'Ollama (local)', type: 'openai', baseUrl: 'http://localhost:11434/v1', model: '' },
  custom: { name: 'Custom', type: 'openai', baseUrl: '', model: '' },
};

// ---------------------------------------------------------------- config
const CONFIG_PATH = path.join(app.getPath('appData'), 'ReadChinese', 'config.json');
const DEFAULTS = {
  configVersion: 2,
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  hotkeyOcr: 'Alt+Q',
  hotkeyClipboard: 'Alt+E',
  hotkeyShow: 'Alt+W',
  mergeLines: true,
  toneType: 'symbol', // symbol | num
  fontSize: 22,
  pinned: false, // false = hide the window when clicking outside it
  googleEnabled: true,
  googleTarget: 'en',
  googleApiKey: '', // optional official Cloud Translation API key
  aiEnabled: true,
  aiTarget: 'vi',
  aiProviders: [],
  ttsEngine: 'windows', // windows (offline system voices) | edge (Edge TTS, online, cached)
  ttsWinVoice: '',
  ttsEdgeVoice: 'zh-CN-XiaoxiaoNeural',
  ttsRate: 1.0,
  autoSpeak: false,
  ocrThreads: 2,
  captureBackend: 'auto', // auto (native module if present, else Electron) | electron
};
let config = { ...DEFAULTS };

const newId = () => crypto.randomBytes(4).toString('hex');

function migrateConfig(c) {
  // v1 -> v2: single DeepSeek settings -> provider list; 4 OCR threads -> 2
  if (!Array.isArray(c.aiProviders) && (c.deepseekKey || c.deepseekModel || !c.configVersion)) {
    c.aiProviders = [{
      id: newId(),
      ...AI_PRESETS.deepseek,
      baseUrl: c.deepseekBaseUrl || AI_PRESETS.deepseek.baseUrl,
      apiKey: c.deepseekKey || process.env.DEEPSEEK_API_KEY || '',
      model: c.deepseekModel || AI_PRESETS.deepseek.model,
      enabled: true,
    }];
    if (c.deepseekTarget) c.aiTarget = c.deepseekTarget;
  }
  if ((c.configVersion || 1) < 2 && Number(c.ocrThreads) === 4) c.ocrThreads = 2;
  for (const k of ['deepseekKey', 'deepseekModel', 'deepseekBaseUrl', 'deepseekTarget', 'alwaysOnTop']) delete c[k];
  c.configVersion = 2;
  return c;
}

function loadConfig() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run or broken file */ }
  // migrate the raw file first (before defaults are merged in), then fill in any missing defaults
  config = { ...DEFAULTS, ...(raw ? migrateConfig(raw) : {}) };
  saveConfig();
}
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------- helpers
function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

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
const runPip = async (args) => (await runPython(['-m', 'pip', 'install', '-U', ...args], { timeout: 600000 })).ok;

// ---------------------------------------------------------------- OCR (persistent Python process)
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
    const threads = String(config.ocrThreads || 2);
    ocrProc = spawn(config.pythonPath, ['-u', path.join(pythonDir(), 'ocr_server.py')], {
      // limit ONNX threads so OCR does not saturate the CPU (which makes the whole desktop stutter)
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', OCR_THREADS: threads, OMP_NUM_THREADS: threads },
      windowsHide: true,
    });
    try { os.setPriority(ocrProc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignore */ }
    let stderrTail = '';
    ocrProc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    ocrProc.on('error', (err) => {
      ocrProc = null;
      reject(new Error(`Cannot start Python ("${config.pythonPath}"): ${err.message}`));
    });
    ocrProc.on('exit', (code) => {
      const err = new Error(`OCR process exited (code ${code}). ${stderrTail}`);
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
        else reject(new Error(msg.error || 'OCR init failed'));
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

function restartOcr() {
  if (ocrProc) ocrProc.kill();
  ocrProc = null;
  ocrReady = null;
}

let installing = null;
async function ensureOcr() {
  try {
    await startOcr();
  } catch (err) {
    if (!/RapidOCR/.test(err.message)) throw err;
    // RapidOCR missing -> install it once with the configured Python
    send('ocr:status', 'First run: installing RapidOCR (1–3 min)…');
    installing = installing || (async () => (await runPip(['rapidocr_onnxruntime'])) || runPip(['rapidocr', 'onnxruntime']))();
    const ok = await installing;
    installing = null;
    if (!ok) throw new Error(`Could not install RapidOCR. Run: ${config.pythonPath} -m pip install rapidocr_onnxruntime`);
    send('ocr:status', 'RapidOCR installed, recognizing…');
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

// ---- reading order: group boxes into rows (vertical overlap), sort each row left -> right
const CJK_END = /[　-〿㐀-鿿豈-﫿＀-￯]$/;
const CJK_START = /^[　-〿㐀-鿿豈-﫿＀-￯]/;
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
    const row = rows.find((r) => Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 0.5 * Math.min(h, r.bottom - r.top));
    if (row) { row.items.push(b); row.top = Math.min(row.top, b.top); row.bottom = Math.max(row.bottom, b.bottom); }
    else rows.push({ top: b.top, bottom: b.bottom, items: [b] });
  }
  rows.sort((a, b) => a.top - b.top);
  return rows.map((r, i) => {
    const prev = rows[i - 1];
    const gapBefore = prev ? r.top - prev.bottom : 0;
    const text = r.items.sort((a, b) => a.left - b.left).map((b) => b.l.text.trim())
      .reduce((acc, t) => (!acc ? t : acc + (/[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(t) ? ' ' : '') + t), '');
    // a large gap above the row = new paragraph / new chat message
    return { text, newPara: !!prev && gapBefore > 0.8 * (r.bottom - r.top) };
  });
}
function joinLines(lines) {
  const rows = orderLines(lines);
  if (!config.mergeLines) return rows.map((r) => r.text).join('\n');
  let out = '';
  for (const { text: t, newPara } of rows) {
    if (!out) out = t;
    else if (newPara || /[。！？!?…]$/.test(out)) out += '\n' + t; // end of sentence / new paragraph
    else if (CJK_END.test(out) && CJK_START.test(t)) out += t; // Chinese line wrapped mid-sentence -> join
    else out += ' ' + t;
  }
  return out;
}

// ---------------------------------------------------------------- Google Translate
// The free endpoints often answer 429 to requests that do not look like a browser, so we use Chromium's
// network stack (net.fetch) with a browser User-Agent and rotate through several endpoints; an endpoint
// that returns 429 is rested for 10 minutes. With an official API key we use the official API instead.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/130.0.0.0 Safari/537.36';
const parseDj = (d) => (d.sentences || []).map((x) => x.trans || '').join('');
const parseT = (d) => (Array.isArray(d) ? d.map((x) => (Array.isArray(x) ? x[0] : x)).join('') : parseDj(d));
const GOOGLE_ENDPOINTS = [
  { name: 'translate.googleapis.com (gtx)', parse: parseDj,
    url: (tl, q) => `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&dj=1&ie=UTF-8&oe=UTF-8&q=${q}` },
  { name: 'translate.google.com (gtx)', parse: parseDj,
    url: (tl, q) => `https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&hl=${tl}&dt=t&dj=1&ie=UTF-8&oe=UTF-8&q=${q}` },
  { name: 'clients5.google.com (dict-chrome-ex)', parse: parseT,
    url: (tl, q) => `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${tl}&q=${q}` },
  { name: 'translate.googleapis.com (t)', parse: parseT,
    url: (tl, q) => `https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=${tl}&q=${q}` },
];
const googleCooldown = new Map(); // endpoint name -> time it may be retried
let googlePreferred = 0;          // last endpoint that worked

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
    if ((googleCooldown.get(ep.name) || 0) > Date.now()) { errors.push(`${ep.name}: resting after 429`); continue; }
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
      if (!out) { errors.push(`${ep.name}: empty response`); continue; }
      googlePreferred = i;
      googleCooldown.delete(ep.name);
      return out;
    } catch (err) {
      errors.push(`${ep.name}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
    }
  }
  console.error('[google]', errors.join(' | '));
  const blocked = errors.some((e) => /HTTP 429|HTTP 403|resting/.test(e));
  throw new Error((blocked
    ? 'Google is temporarily rate-limiting this network/IP (429). Try again in a few minutes, turn off VPN/proxy, '
      + 'or add a Google Cloud API key in Settings.'
    : 'Cannot reach Google Translate (check your network/proxy).') + '\n' + errors.join('\n'));
}

// ---------------------------------------------------------------- AI translation (multiple providers)
function aiBase(p) {
  let b = (p.baseUrl || AI_PRESETS[p.type === 'anthropic' ? 'anthropic' : 'openai'].baseUrl).trim().replace(/\/+$/, '');
  if (p.type === 'anthropic') b = b.replace(/\/v1\/messages$/, '').replace(/\/messages$/, '').replace(/\/v1$/, '');
  else b = b.replace(/\/chat\/completions$/, '');
  return b;
}

function aiHeaders(p) {
  if (p.type === 'anthropic') {
    return { 'Content-Type': 'application/json', 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01' };
  }
  const h = { 'Content-Type': 'application/json' };
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  return h;
}

function systemPrompt() {
  return 'You are a professional translator. Translate the user\'s text (usually Chinese) into natural, '
    + `context-appropriate ${LANGS[config.aiTarget] || config.aiTarget}. Keep line breaks. `
    + 'Output only the translation: no explanations, no pinyin, no quotes.';
}

function aiHttpError(p, status, body) {
  const who = p.name || 'AI';
  if (status === 401 || status === 403) return new Error(`${who}: invalid API key (${status}). Check it in Settings.`);
  if (status === 402) return new Error(`${who}: insufficient account balance (402).`);
  if (status === 429) return new Error(`${who}: rate limited or out of quota (429).`);
  if (status === 404 || (status === 400 && /model/i.test(body))) {
    return new Error(`${who}: model "${p.model}" or endpoint not found (${status}). Use "Test" in Settings to pick a valid model. ${body}`);
  }
  return new Error(`${who} HTTP ${status}: ${body}`);
}

// Read a Server-Sent Events stream and call onEvent(jsonObject) for each "data:" line
async function readSse(res, onEvent) {
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
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; } // keep-alive / partial
      if (onEvent(obj) === false) return;
    }
  }
}

async function aiTranslate(p, text, onDelta, signal) {
  if (!p.model) throw new Error(`${p.name}: no model selected. Open Settings and press "Test" to load models.`);
  if (!p.apiKey && p.type === 'anthropic') throw new Error(`${p.name}: missing API key (Settings).`);
  const base = aiBase(p);
  if (p.type === 'anthropic') {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST', signal, headers: aiHeaders(p),
      body: JSON.stringify({
        model: p.model, max_tokens: 4096, stream: true, system: systemPrompt(),
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!res.ok) throw aiHttpError(p, res.status, (await res.text()).slice(0, 300));
    await readSse(res, (ev) => {
      if (ev.type === 'content_block_delta' && ev.delta?.text) onDelta(ev.delta.text);
      else if (ev.type === 'error') throw new Error(`${p.name}: ${ev.error?.message || 'stream error'}`);
      else if (ev.type === 'message_stop') return false;
      return true;
    });
    return;
  }
  // OpenAI-compatible
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', signal, headers: aiHeaders(p),
    body: JSON.stringify({
      model: p.model, stream: true,
      messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw aiHttpError(p, res.status, (await res.text()).slice(0, 300));
  await readSse(res, (ev) => {
    if (ev.error) throw new Error(`${p.name}: ${ev.error.message || JSON.stringify(ev.error)}`);
    const d = ev.choices?.[0]?.delta?.content;
    if (d) onDelta(d);
    return true;
  });
}

// Test a provider and list its models (GET /models for OpenAI-compatible, GET /v1/models for Anthropic)
ipcMain.handle('ai:test', async (_e, p) => {
  const base = aiBase(p);
  if (!base) return { ok: false, error: 'Enter a Base URL.' };
  if (!p.apiKey && p.type === 'anthropic') return { ok: false, error: 'Enter an API key.' };
  try {
    const url = p.type === 'anthropic' ? `${base}/v1/models?limit=100` : `${base}/models`;
    const res = await fetch(url, { headers: aiHeaders(p), signal: AbortSignal.timeout(10000) });
    const body = await res.text();
    if (res.status === 401 || res.status === 403) return { ok: false, error: `Invalid API key (${res.status}).` };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    const json = JSON.parse(body);
    const models = (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean)
      .map((m) => m.replace(/^models\//, '')).sort();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: `Cannot connect to ${base}: ${err.message}` };
  }
});
ipcMain.handle('ai:presets', () => AI_PRESETS);
ipcMain.handle('ai:newId', () => newId());

// ---------------------------------------------------------------- translate everything that is enabled
let jobId = 0;
let aborters = [];

function translateAll(text) {
  const id = ++jobId;
  aborters.forEach((a) => a.abort());
  aborters = [];
  const cards = [];
  if (config.googleEnabled) cards.push({ key: 'google', kind: 'google', name: 'Google', lang: config.googleTarget });
  const providers = config.aiEnabled ? config.aiProviders.filter((p) => p.enabled) : [];
  for (const p of providers) cards.push({ key: p.id, kind: 'ai', name: p.name, model: p.model, lang: config.aiTarget });
  send('tr:start', { id, cards });

  if (config.googleEnabled) {
    googleTranslate(text, config.googleTarget || 'en')
      .then((r) => send('tr:done', { id, key: 'google', text: r }))
      .catch((e) => send('tr:done', { id, key: 'google', error: e.message }));
  }
  for (const p of providers) {
    const ac = new AbortController();
    aborters.push(ac);
    aiTranslate(p, text, (delta) => send('tr:delta', { id, key: p.id, delta }), ac.signal)
      .then(() => send('tr:done', { id, key: p.id }))
      .catch((e) => { if (e.name !== 'AbortError') send('tr:done', { id, key: p.id, error: e.message }); });
  }
}

// ---------------------------------------------------------------- Edge TTS (python edge-tts, cached)
const TTS_CACHE = path.join(app.getPath('appData'), 'ReadChinese', 'tts-cache');
const TTS_CACHE_MAX = 500;
let edgeTtsChecked = null;
let edgeTtsUpgraded = false;

function explainEdgeError(err = '') {
  if (/403|Invalid response status/.test(err)) {
    return 'Edge TTS was rejected by Microsoft (403) even after updating edge-tts. Common causes: the PC clock '
      + 'is off (Settings → Time → "Sync now"), a VPN/proxy, or a temporary IP limit. Use the Windows voice meanwhile.';
  }
  if (/getaddrinfo|ClientConnectorError|Cannot connect|timed? ?out/i.test(err)) {
    return 'Edge TTS needs Internet for text that is not cached yet — cannot reach Microsoft.';
  }
  if (/No module named/.test(err)) return 'edge-tts is not installed: run "python -m pip install -U edge-tts".';
  const last = err.trim().split('\n').filter(Boolean).pop() || 'unknown error';
  return `Edge TTS error: ${last.slice(0, 200)}`;
}

function ensureEdgeTts() {
  edgeTtsChecked = edgeTtsChecked || (async () => {
    if ((await runPython(['-c', 'import edge_tts'])).ok) return;
    send('ocr:status', 'Installing edge-tts (first use)…');
    if (!(await runPip(['edge-tts']))) throw new Error(`Could not install edge-tts. Run: ${config.pythonPath} -m pip install edge-tts`);
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
    // 403 = outdated edge-tts rejected by Microsoft -> update once per session and retry
    if (!r.ok && /403|Invalid response status/.test(r.err) && !edgeTtsUpgraded) {
      edgeTtsUpgraded = true;
      send('ocr:status', 'Edge TTS rejected (403) → updating edge-tts…');
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

// ---------------------------------------------------------------- main window
const WIN_W = 440;
let mainWin = null;
let tray = null;
let lastShown = 0;

function createMainWindow() {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  mainWin = new BrowserWindow({
    width: WIN_W, height: 240, minHeight: 120,
    x: Math.min(cursor.x + 10, workArea.x + workArea.width - WIN_W),
    y: Math.max(workArea.y, Math.min(cursor.y, workArea.y + workArea.height - 240)),
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#1e1f24',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  // F12 / Ctrl+Shift+I: DevTools for debugging
  mainWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWin.webContents.toggleDevTools();
    }
  });
  mainWin.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); } });
  // not pinned -> hide when the user clicks somewhere else
  mainWin.on('blur', () => {
    if (config.pinned || capturing || Date.now() - lastShown < 400) return;
    if (mainWin.webContents.isDevToolsOpened()) return;
    mainWin.hide();
  });
}

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

// Auto-fit: the renderer reports its content height; keep the window inside the work area
ipcMain.on('win:fit', (_e, contentH) => {
  if (!mainWin || mainWin.isDestroyed()) return;
  const b = mainWin.getBounds();
  const { workArea } = screen.getDisplayMatching(b);
  const h = Math.round(Math.max(120, Math.min(contentH, workArea.height * 0.9)));
  if (Math.abs(h - b.height) < 2) return;
  const y = Math.max(workArea.y, Math.min(b.y, workArea.y + workArea.height - h));
  mainWin.setBounds({ x: b.x, y, width: b.width, height: h });
});

// ---------------------------------------------------------------- screen capture
let captureWin = null;
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
    // clear the old image after hiding so it never flashes next time, and free memory
    setTimeout(() => captureWin?.webContents.send('capture:reset'), 50);
  }
}

// Native capture: node-screenshots (Rust/xcap, GDI BitBlt) runs on a worker thread and never blocks
// the main process. Falls back to Electron's desktopCapturer when the module is not available.
let nativeShot;
function loadNativeShot() {
  if (nativeShot !== undefined) return nativeShot;
  nativeShot = null;
  if (config.captureBackend === 'electron') return null;
  const candidates = [
    () => require('node-screenshots'), // installed with npm
    () => require(path.join(__dirname, '..', 'native', 'node-screenshots.win32-x64-msvc.node')), // build-portable
  ];
  for (const load of candidates) {
    try {
      const mod = load();
      if (mod?.Monitor) { nativeShot = mod; break; }
    } catch { /* try the next one */ }
  }
  console.log('[capture] backend:', nativeShot ? 'native (node-screenshots)' : 'electron desktopCapturer');
  return nativeShot;
}

async function grabNative(display) {
  const ns = loadNativeShot();
  if (!ns) return null;
  // xcap works in physical pixels -> convert the display centre from DIP to screen pixels
  const center = { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 };
  const p = process.platform === 'win32' ? screen.dipToScreenPoint(center) : center;
  const mon = ns.Monitor.fromPoint(Math.round(p.x), Math.round(p.y))
    || ns.Monitor.all().find((m) => m.isPrimary()) || ns.Monitor.all()[0];
  const img = await mon.captureImage(); // Rust worker thread
  const jpeg = await img.toJpeg();      // encoding also off the main thread
  const file = path.join(os.tmpdir(), `readchinese_overlay_${Date.now()}.jpg`);
  await fs.promises.writeFile(file, jpeg);
  return { kind: 'native', img, overlayFile: file, overlayUrl: pathToFileURL(file).href };
}

async function grabElectron(display) {
  const size = { width: Math.round(display.size.width * captureSf), height: Math.round(display.size.height * captureSf) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  const img = src.thumbnail;
  return { kind: 'electron', img, overlayUrl: `data:image/jpeg;base64,${img.toJPEG(92).toString('base64')}` };
}

// crop the selection (physical pixels) -> PNG buffer
async function cropShot(shot, x, y, w, h) {
  if (shot.kind === 'native') {
    const W = shot.img.width, H = shot.img.height;
    x = Math.max(0, Math.min(x, W - 1)); y = Math.max(0, Math.min(y, H - 1));
    w = Math.max(1, Math.min(w, W - x)); h = Math.max(1, Math.min(h, H - y));
    return (await shot.img.crop(x, y, w, h)).toPng();
  }
  return shot.img.crop({ x, y, width: w, height: h }).toPNG();
}

function disposeShot(shot) {
  if (shot?.overlayFile) fs.rm(shot.overlayFile, () => {});
}

async function startCapture() {
  if (capturing) return;
  capturing = true;
  const t0 = Date.now();
  try {
    // hide the (unpinned) translator window so it is not in the screenshot
    if (mainWin?.isVisible() && !config.pinned) {
      mainWin.hide();
      await new Promise((r) => setTimeout(r, 100));
    }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    captureSf = display.scaleFactor;
    let shot = null;
    try { shot = await grabNative(display); } catch (err) {
      console.error('[capture] native failed, using Electron:', err.message);
      nativeShot = null;
    }
    if (!shot) shot = await grabElectron(display);
    disposeShot(captureShot);
    captureShot = shot;
    console.log(`[capture] ${shot.kind}: ${Date.now() - t0} ms`);

    const win = ensureCaptureWindow();
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    win.setBounds(display.bounds);
    // the overlay replies 'capture:ready' once the image is painted -> only then show it (no black flash)
    win.webContents.send('capture:image', shot.overlayUrl);
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
  captureShot = null; // release the full-screen image early
  endCapture();
  if (!shot || !rect || rect.width < 4 || rect.height < 4) { disposeShot(shot); return; }
  await new Promise((r) => setTimeout(r, 16)); // let Windows hide the overlay before heavy work
  const png = await cropShot(shot, Math.round(rect.x * sf), Math.round(rect.y * sf),
    Math.round(rect.width * sf), Math.round(rect.height * sf));
  disposeShot(shot);
  const file = path.join(os.tmpdir(), `readchinese_${Date.now()}.png`);
  await fs.promises.writeFile(file, png);
  showMain();
  send('ocr:start');
  try {
    const lines = await ocrImage(file);
    const text = joinLines(lines);
    send('ocr:result', { text, autoSpeak: !!config.autoSpeak });
    if (text) translateAll(text);
  } catch (err) {
    send('ocr:error', err.message);
  } finally {
    fs.rm(file, () => {});
  }
});

// ---------------------------------------------------------------- hotkeys & tray
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
    new Notification({ title: 'ReadChinese', body: `Could not register hotkey: ${bad.join(', ')}` }).show();
  }
}

function buildTrayMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: `Capture & translate (${config.hotkeyOcr})`, click: () => startCapture() },
    { label: `Open window (${config.hotkeyShow})`, click: () => showMain() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('ReadChinese');
  buildTrayMenu();
  tray.on('click', () => showMain());
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('config:get', () => config);
ipcMain.handle('langs:get', () => LANGS);
ipcMain.handle('capture:backend', () => (loadNativeShot() ? 'native (node-screenshots)' : 'Electron desktopCapturer (fallback)'));
ipcMain.handle('config:set', (_e, patch) => {
  const hotkeysChanged = ['hotkeyOcr', 'hotkeyClipboard', 'hotkeyShow'].some((k) => k in patch && patch[k] !== config[k]);
  const ocrChanged = ['pythonPath', 'ocrThreads'].some((k) => k in patch && patch[k] !== config[k]);
  config = { ...config, ...patch };
  saveConfig();
  if (hotkeysChanged) { registerHotkeys(); buildTrayMenu(); }
  if (ocrChanged) restartOcr();
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
    ensureCaptureWindow(); // pre-create the hidden overlay so the hotkey responds instantly
    // start OCR early (installs RapidOCR if missing) once the UI is ready
    mainWin.webContents.once('did-finish-load', () => ensureOcr().catch((e) => send('ocr:error', e.message)));
    showMain();
  });
  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ocrProc) ocrProc.kill(); });
}
