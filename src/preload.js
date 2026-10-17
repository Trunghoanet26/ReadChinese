const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('api', {
  // config & data
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  getLangs: () => ipcRenderer.invoke('langs:get'),
  aiPresets: () => ipcRenderer.invoke('ai:presets'),
  aiNewId: () => ipcRenderer.invoke('ai:newId'),
  aiTest: (provider) => ipcRenderer.invoke('ai:test', provider),
  captureBackend: () => ipcRenderer.invoke('capture:backend'),

  // actions
  translate: (text) => ipcRenderer.send('translate', text),
  startCapture: () => ipcRenderer.send('capture:start'),
  hide: () => ipcRenderer.send('win:hide'),
  pin: (v) => ipcRenderer.send('win:pin', v),
  fit: (h) => ipcRenderer.send('win:fit', h),
  copy: (t) => ipcRenderer.send('clipboard:write', t),
  ttsEdge: (opts) => ipcRenderer.invoke('tts:edge', opts),

  // events from the main process
  onOcrStart: on('ocr:start'),
  onOcrResult: on('ocr:result'),
  onOcrError: on('ocr:error'),
  onOcrStatus: on('ocr:status'),
  onInputSet: on('input:set'),
  onTrStart: on('tr:start'),
  onTrDelta: on('tr:delta'),
  onTrDone: on('tr:done'),

  // capture overlay window
  onCaptureImage: on('capture:image'),
  captureDone: (rect) => ipcRenderer.invoke('capture:done', rect),
  captureReady: () => ipcRenderer.send('capture:ready'),
  onCaptureReset: on('capture:reset'),
});
