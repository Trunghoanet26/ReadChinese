/* global pinyinPro */
const $ = (id) => document.getElementById(id);
const els = {
  ruby: $('ruby'), input: $('input'), status: $('status'),
  google: $('outGoogle'), deepseek: $('outDeepseek'), tone: $('btnTone'), pin: $('btnPin'),
};

let cfg = {};
let text = '';
let items = [];        // kết quả pinyin-pro cho từng ký tự
let overrides = {};    // index -> pinyin người dùng chọn (chữ đa âm)
let currentJob = 0;

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------ pinyin
function toneOpt() { return { toneType: cfg.toneType === 'num' ? 'num' : 'symbol' }; }

function computePinyin() {
  if (typeof pinyinPro === 'undefined') {
    showStatus('Không tải được pinyin-pro — hãy chạy "npm install".', true);
    items = [];
    return;
  }
  // phân tích cả câu một lần để pinyin-pro chọn đúng âm theo ngữ cảnh (银行 / 行不行)
  items = text ? pinyinPro.pinyin(text, { type: 'all', ...toneOpt() }) : [];
}

function renderRuby() {
  const html = items.map((it, i) => {
    if (!it.isZh) return escapeHtml(it.origin).replace(/\n/g, '<br>');
    const py = overrides[i] ?? it.pinyin;
    const poly = it.polyphonic?.length > 1 ? ' poly' : '';
    return `<ruby data-i="${i}" class="${poly.trim()}">${escapeHtml(it.origin)}<rt>${escapeHtml(py)}</rt></ruby>`;
  }).join('');
  els.ruby.innerHTML = html;
}

function pinyinLine() {
  // pinyin cả câu, gộp theo từ, giữ dấu câu
  return items.map((it, i) => (it.isZh ? (overrides[i] ?? it.pinyin) + ' ' : it.origin))
    .join('').replace(/ +([，。！？、；：,.!?;:）)」』])/g, '$1').replace(/ +\n/g, '\n').trim();
}

function setText(t, { keepOverrides = false } = {}) {
  if (t !== text && typeof stopSpeaking === 'function' && tts.speaking) stopSpeaking();
  text = t;
  els.input.value = t;
  if (!keepOverrides) overrides = {};
  computePinyin();
  renderRuby();
}

// bấm 1 chữ đa âm → xoay vòng các cách đọc
els.ruby.addEventListener('click', (e) => {
  const r = e.target.closest('ruby');
  if (!r) return;
  const i = Number(r.dataset.i);
  const it = items[i];
  const all = it.polyphonic || [];
  if (all.length < 2) return;
  const cur = overrides[i] ?? it.pinyin;
  overrides[i] = all[(all.indexOf(cur) + 1) % all.length];
  renderRuby();
});

// ------------------------------------------------------------ UI helpers
function showStatus(msg, isErr = false) {
  els.status.hidden = !msg;
  els.status.textContent = msg || '';
  els.status.classList.toggle('err', isErr);
}
function setEditing(on) {
  els.input.hidden = !on;
  els.ruby.hidden = on;
  $('btnEdit').classList.toggle('on', on);
  if (on) { els.input.focus(); } else { setText(els.input.value.trim()); }
}
function translate() {
  if (!els.input.hidden) setEditing(false);
  if (text) window.api.translate(text);
}
function applyFont() { document.documentElement.style.setProperty('--fs', `${cfg.fontSize}px`); }
function applyTone() { els.tone.textContent = cfg.toneType === 'num' ? 'ni3 hao3' : 'nǐ hǎo'; }

// ------------------------------------------------------------ buttons
$('btnClose').onclick = () => window.api.hide();
$('btnOcr').onclick = () => window.api.startCapture();
$('btnEdit').onclick = () => setEditing(els.input.hidden);
$('btnTranslate').onclick = translate;
$('btnCopyText').onclick = () => window.api.copy(text);
$('btnCopyPinyin').onclick = () => window.api.copy(pinyinLine());
els.pin.onclick = () => {
  cfg.pinned = !cfg.pinned;
  els.pin.classList.toggle('on', cfg.pinned);
  els.pin.title = cfg.pinned ? 'Đang ghim — bấm để bỏ ghim' : 'Ghim (không tự ẩn khi bấm ra ngoài)';
  window.api.pin(cfg.pinned);
};
els.tone.onclick = async () => {
  cfg = await window.api.setConfig({ toneType: cfg.toneType === 'num' ? 'symbol' : 'num' });
  applyTone();
  overrides = {};
  setText(text);
};
const changeFont = async (d) => {
  cfg = await window.api.setConfig({ fontSize: Math.max(14, Math.min(48, cfg.fontSize + d)) });
  applyFont();
};
$('btnSmaller').onclick = () => changeFont(-2);
$('btnBigger').onclick = () => changeFont(2);
document.querySelectorAll('.copy').forEach((b) => {
  b.onclick = () => window.api.copy($(b.dataset.target).textContent);
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); translate(); }
});
// cập nhật pinyin trực tiếp khi gõ (chế độ sửa)
let typingTimer;
els.input.addEventListener('input', () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { text = els.input.value.trim(); overrides = {}; computePinyin(); renderRuby(); }, 250);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settings').hidden) $('settings').hidden = true;
  else if (e.key === 'Escape' && tts.speaking) stopSpeaking();
  else if (e.key === 'Escape') window.api.hide();
});


// ------------------------------------------------------------ đọc to (TTS)
const EDGE_VOICES = {
  'zh-CN-XiaoxiaoNeural': 'Xiaoxiao – nữ, phổ thông (khuyên dùng)',
  'zh-CN-XiaoyiNeural': 'Xiaoyi – nữ, phổ thông',
  'zh-CN-YunxiNeural': 'Yunxi – nam, phổ thông',
  'zh-CN-YunjianNeural': 'Yunjian – nam, phổ thông',
  'zh-CN-YunyangNeural': 'Yunyang – nam, giọng tin tức',
  'zh-CN-YunxiaNeural': 'Yunxia – nam trẻ',
  'zh-CN-liaoning-XiaobeiNeural': 'Xiaobei – nữ, giọng Đông Bắc',
  'zh-CN-shaanxi-XiaoniNeural': 'Xiaoni – nữ, giọng Thiểm Tây',
  'zh-TW-HsiaoChenNeural': 'HsiaoChen – nữ, Đài Loan',
  'zh-TW-YunJheNeural': 'YunJhe – nam, Đài Loan',
  'zh-HK-HiuMaanNeural': 'HiuMaan – nữ, Quảng Đông (HK)',
};
const tts = { speaking: false, audio: null, token: 0 };
const speakBtn = $('btnSpeak');

function zhVoices() {
  return speechSynthesis.getVoices().filter((v) => /^zh|^cmn|^yue/i.test(v.lang));
}

function clearReading() {
  els.ruby.querySelectorAll('ruby.reading').forEach((r) => r.classList.remove('reading'));
}

function setSpeaking(on) {
  tts.speaking = on;
  speakBtn.classList.toggle('on', on);
  speakBtn.title = on ? 'Dừng đọc' : 'Đọc (chọn một đoạn để chỉ đọc đoạn đó)';
  if (!on) clearReading();
}

function stopSpeaking() {
  tts.token++;
  speechSynthesis.cancel();
  if (tts.audio) { tts.audio.pause(); tts.audio = null; }
  setSpeaking(false);
}

// Lấy phần chữ Hán người dùng bôi đen trong vùng pinyin (nếu có), kèm vị trí ký tự bắt đầu
function selectedPart() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !els.ruby.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  const idx = [...els.ruby.querySelectorAll('ruby')]
    .filter((r) => range.intersectsNode(r)).map((r) => Number(r.dataset.i));
  if (!idx.length) return null;
  const from = idx[0], to = idx[idx.length - 1];
  return { text: items.slice(from, to + 1).map((it) => it.origin).join(''), startItem: from };
}

// vị trí ký tự (trong chuỗi đang đọc) → chỉ số item để tô sáng chữ đang đọc
function highlightRange(startItem, charIndex, charLength) {
  clearReading();
  let pos = 0;
  for (let i = startItem; i < items.length; i++) {
    const len = items[i].origin.length;
    if (pos + len > charIndex && pos < charIndex + Math.max(1, charLength)) {
      els.ruby.querySelector(`ruby[data-i="${i}"]`)?.classList.add('reading');
    }
    pos += len;
    if (pos >= charIndex + Math.max(1, charLength)) break;
  }
}

async function speak(textToRead, startItem = 0) {
  stopSpeaking();
  const token = tts.token;
  if (!textToRead.trim()) return;
  setSpeaking(true);
  const voices = zhVoices();
  const useWindows = cfg.ttsEngine !== 'edge' && voices.length > 0;

  if (useWindows) {
    const u = new SpeechSynthesisUtterance(textToRead);
    u.voice = voices.find((v) => v.name === cfg.ttsWinVoice) || voices.find((v) => /zh-CN/i.test(v.lang)) || voices[0];
    u.lang = u.voice.lang;
    u.rate = Number(cfg.ttsRate) || 1;
    u.onboundary = (e) => { if (token === tts.token) highlightRange(startItem, e.charIndex, e.charLength || 1); };
    u.onend = u.onerror = () => { if (token === tts.token) setSpeaking(false); };
    speechSynthesis.speak(u);
    return;
  }

  if (cfg.ttsEngine !== 'edge') showStatus('Máy chưa có giọng đọc tiếng Trung của Windows → dùng tạm Edge TTS (xem ⚙).');
  const r = await window.api.ttsEdge({ text: textToRead, voice: cfg.ttsEdgeVoice, rate: cfg.ttsRate });
  if (token !== tts.token) return; // đã bấm dừng / đọc câu khác
  if (!r.ok) {
    // Edge lỗi mà máy có giọng Windows → đọc tạm bằng giọng Windows
    if (voices.length) {
      showStatus(r.error + ' → Đọc tạm bằng giọng Windows.', true);
      setSpeaking(false);
      const saved = cfg.ttsEngine;
      cfg.ttsEngine = 'windows';
      speak(textToRead, startItem);
      cfg.ttsEngine = saved;
      return;
    }
    setSpeaking(false); showStatus(r.error, true); return;
  }
  tts.audio = new Audio(r.url);
  tts.audio.onended = tts.audio.onerror = () => { if (token === tts.token) { tts.audio = null; setSpeaking(false); } };
  tts.audio.play().catch(() => setSpeaking(false));
}

speakBtn.onclick = () => {
  if (tts.speaking) { stopSpeaking(); return; }
  const part = selectedPart();
  if (part) speak(part.text, part.startItem);
  else speak(text, 0);
};

function fillWinVoices() {
  const voices = zhVoices();
  const sel = $('sWinVoice');
  sel.innerHTML = voices.map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} (${v.lang})</option>`).join('');
  if (cfg.ttsWinVoice) sel.value = cfg.ttsWinVoice;
  $('winVoiceHint').textContent = voices.length ? ''
    : 'Chưa có giọng tiếng Trung. Vào Settings → Time & language → Language → thêm "中文(中华人民共和国)" và tick "Text-to-speech", rồi khởi động lại app.';
}
speechSynthesis.onvoiceschanged = () => { if (!$('settings').hidden) fillWinVoices(); };

// ------------------------------------------------------------ settings
const sFields = {
  sKey: 'deepseekKey', sBaseUrl: 'deepseekBaseUrl', sGoogleKey: 'googleApiKey', sModel: 'deepseekModel', sPython: 'pythonPath',
  sHkOcr: 'hotkeyOcr', sHkClip: 'hotkeyClipboard', sHkShow: 'hotkeyShow',
};
let LANGS = {};
const LANG_VI = {
  vi: 'Tiếng Việt', en: 'English', 'zh-CN': '中文 (简体)', 'zh-TW': '中文 (繁體)', ja: '日本語', ko: '한국어',
  th: 'ไทย', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', fr: 'Français', de: 'Deutsch', es: 'Español',
  pt: 'Português', it: 'Italiano', ru: 'Русский', ar: 'العربية', hi: 'हिन्दी',
};
const langName = (c) => LANG_VI[c] || LANGS[c] || c;
function applyLangLabels() {
  $('lblGoogle').textContent = langName(cfg.googleTarget || 'en');
  $('lblDeepseek').textContent = langName(cfg.deepseekTarget || 'vi');
}
function fillLangSelect(sel, value) {
  sel.innerHTML = Object.keys(LANGS).map((c) => `<option value="${c}">${langName(c)}</option>`).join('');
  sel.value = value;
}
$('btnSettings').onclick = () => {
  fillLangSelect($('sGoogleTarget'), cfg.googleTarget || 'en');
  fillLangSelect($('sDeepseekTarget'), cfg.deepseekTarget || 'vi');
  for (const [id, k] of Object.entries(sFields)) $(id).value = cfg[k] ?? '';
  $('sMerge').checked = !!cfg.mergeLines;
  $('dsTestMsg').textContent = '';
  $('sTtsEngine').value = cfg.ttsEngine || 'windows';
  fillWinVoices();
  $('sEdgeVoice').innerHTML = Object.entries(EDGE_VOICES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('sEdgeVoice').value = cfg.ttsEdgeVoice || 'zh-CN-XiaoxiaoNeural';
  $('sRate').value = cfg.ttsRate ?? 1;
  $('rateVal').textContent = `${Number($('sRate').value).toFixed(1)}×`;
  $('sAutoSpeak').checked = !!cfg.autoSpeak;
  toggleVoiceRows();
  $('settings').hidden = false;
};
function toggleVoiceRows() {
  const edge = $('sTtsEngine').value === 'edge';
  $('rowEdgeVoice').hidden = !edge;
  $('rowWinVoice').hidden = edge;
}
$('sTtsEngine').onchange = toggleVoiceRows;
$('sRate').oninput = () => { $('rateVal').textContent = `${Number($('sRate').value).toFixed(1)}×`; };
$('btnTestDs').onclick = async () => {
  const msg = $('dsTestMsg');
  msg.classList.remove('ok');
  msg.textContent = 'Đang kiểm tra…';
  const r = await window.api.deepseekTest({ baseUrl: $('sBaseUrl').value, key: $('sKey').value.trim() });
  if (!r.ok) { msg.textContent = r.error; return; }
  msg.classList.add('ok');
  msg.textContent = `Kết nối OK. Model khả dụng: ${r.models.join(', ') || '(không rõ)'}`;
  if (r.models.length) {
    $('dsModels').innerHTML = r.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
    if (!r.models.includes($('sModel').value.trim())) $('sModel').value = r.models[0];
  }
};
$('sCancel').onclick = () => { $('settings').hidden = true; };
$('sSave').onclick = async () => {
  const patch = {
    mergeLines: $('sMerge').checked,
    googleTarget: $('sGoogleTarget').value,
    deepseekTarget: $('sDeepseekTarget').value,
    ttsEngine: $('sTtsEngine').value,
    ttsWinVoice: $('sWinVoice').value || cfg.ttsWinVoice || '',
    ttsEdgeVoice: $('sEdgeVoice').value,
    ttsRate: Number($('sRate').value),
    autoSpeak: $('sAutoSpeak').checked,
  };
  const langChanged = patch.googleTarget !== cfg.googleTarget || patch.deepseekTarget !== cfg.deepseekTarget;
  for (const [id, k] of Object.entries(sFields)) patch[k] = $(id).value.trim();
  cfg = await window.api.setConfig(patch);
  $('settings').hidden = true;
  applyLangLabels();
  if (langChanged && text) window.api.translate(text); // dịch lại theo ngôn ngữ mới
};

// ------------------------------------------------------------ events từ main
window.api.onOcrStart(() => {
  showStatus('Đang nhận dạng chữ…');
  setEditing(false);
  setText('');
  els.google.textContent = ''; els.deepseek.textContent = '';
});
window.api.onOcrResult(({ text: t, autoSpeak }) => {
  showStatus(t ? '' : 'Không tìm thấy chữ trong vùng đã chọn.', !t);
  setText(t);
  if (t && autoSpeak) speak(t, 0);
});
window.api.onOcrError((msg) => showStatus('Lỗi OCR: ' + msg, true));
window.api.onOcrStatus((msg) => showStatus(msg));
window.api.onInputSet((t) => { showStatus(''); setText(t); });

window.api.onTrStart(({ id }) => {
  currentJob = id;
  for (const el of [els.google, els.deepseek]) {
    el.textContent = ''; el.classList.remove('err'); el.classList.add('loading');
  }
});
window.api.onGoogle(({ id, text: t, error }) => {
  if (id !== currentJob) return;
  els.google.classList.remove('loading');
  if (error) { els.google.classList.add('err'); els.google.textContent = error; } else els.google.textContent = t;
});
window.api.onDeepseekDelta(({ id, delta }) => {
  if (id === currentJob) els.deepseek.textContent += delta;
});
window.api.onDeepseekDone(({ id, error }) => {
  if (id !== currentJob) return;
  els.deepseek.classList.remove('loading');
  if (error) { els.deepseek.classList.add('err'); els.deepseek.textContent = error; }
});

// ------------------------------------------------------------ init
(async () => {
  cfg = await window.api.getConfig();
  LANGS = await window.api.getLangs();
  applyLangLabels();
  applyFont(); applyTone();
  els.pin.classList.toggle('on', !!cfg.pinned);
  els.pin.title = cfg.pinned ? 'Đang ghim — bấm để bỏ ghim' : 'Ghim (không tự ẩn khi bấm ra ngoài)';
})();
