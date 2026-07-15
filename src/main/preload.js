'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  updateState: (patch) => ipcRenderer.invoke('state:update', patch),
  updateScoped: (target, patch) => ipcRenderer.invoke('state:updateScoped', { target, patch }),
  resetState: () => ipcRenderer.invoke('state:reset'),

  addAccount: (payload) => ipcRenderer.invoke('account:add', payload),
  setCreds: (payload) => ipcRenderer.invoke('account:setCreds', payload),
  setProxy: (payload) => ipcRenderer.invoke('account:setProxy', payload),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),
  loadAccountFile: () => ipcRenderer.invoke('account:loadFile'),
  loginAccount: (id) => ipcRenderer.invoke('account:login', id),
  checkAccount: (id) => ipcRenderer.invoke('account:check', id),

  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  pickMedia: () => ipcRenderer.invoke('dialog:pickMedia'),
  pickImageFolder: (target) => ipcRenderer.invoke('dialog:pickImageFolder', target),
  loadBodiesFolder: (existing) => ipcRenderer.invoke('content:loadBodiesFolder', { existing }),
  loadSubstitution: () => ipcRenderer.invoke('file:loadSubstitution'),
  loadTextList: () => ipcRenderer.invoke('file:loadTextList'),

  gptTest: (cfg) => ipcRenderer.invoke('gpt:test', cfg),
  generateDraft: (payload) => ipcRenderer.invoke('ai:generateDraft', payload),
  selectDraft: (payload) => ipcRenderer.invoke('ai:selectDraft', payload),
  adbDevices: () => ipcRenderer.invoke('network:adbDevices'),
  resetMobileData: () => ipcRenderer.invoke('network:resetMobileData'),
  workStart: (params) => ipcRenderer.invoke('work:start', params),
  workStop: () => ipcRenderer.invoke('work:stop'),
  postNow: (job) => ipcRenderer.invoke('post:now', job),

  onWorkEvent: (cb) => ipcRenderer.on('work:event', (_e, data) => cb(data)),
});
