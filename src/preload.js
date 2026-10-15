const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getLangs: () => ipcRenderer.invoke('langs:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  translate: (text) => ipcRenderer.send('translate', text),
  startCapture: () => ipcRenderer.send('capture:start'),
  hide: () => ipcRenderer.send('win:hide'),
  pin: (v) => ipcRenderer.send('win:pin', v),
  copy: (t) => ipcRenderer.send('clipboard:write', t),
  ttsEdge: (opts) => ipcRenderer.invoke('tts:edge', opts),
  deepseekTest: (opts) => ipcRenderer.invoke('deepseek:test', opts),

  onOcrStart: on('ocr:start'),
  onOcrResult: on('ocr:result'),
  onOcrError: on('ocr:error'),
  onOcrStatus: on('ocr:status'),
  onInputSet: on('input:set'),
  onTrStart: on('tr:start'),
  onGoogle: on('tr:google'),
  onDeepseekDelta: on('tr:deepseek:delta'),
  onDeepseekDone: on('tr:deepseek:done'),

  // cửa sổ chụp vùng
  onCaptureImage: on('capture:image'),
  captureDone: (rect) => ipcRenderer.invoke('capture:done', rect),
  captureReady: () => ipcRenderer.send('capture:ready'),
  onCaptureReset: on('capture:reset'),
});
