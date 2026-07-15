'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const store = require('./store');
const poster = require('./poster');
const image = require('./image');
const runner = require('./runner');
const gpt = require('./gpt');
const network = require('./network');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1040, height: 720,
    title: '인스타그램 자동 업로드 프로그램',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

// 비번 암호화(safeStorage)
function encryptPw(pw) { return (pw && safeStorage.isEncryptionAvailable()) ? safeStorage.encryptString(pw).toString('base64') : ''; }
function decryptPw(enc) { try { return enc ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : ''; } catch (_) { return ''; } }
function readLines(file) { return fs.readFileSync(file, 'utf-8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); }
function isImageFile(file) { return ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(file || '').toLowerCase()); }
function mediaFilters() { return [{ name: 'Media', extensions: ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov'] }]; }
function parseAccountLine(line) {
  const parts = line.includes('\t') || line.includes(',')
    ? line.split(/[\t,]/).map((x) => x.trim())
    : line.split(/ +/).map((x) => x.trim());
  if (parts.length > 1) return { igId: parts[0] || '', pw: parts[1] || '', proxy: parts.slice(2).join('').trim() };
  const colon = line.split(':');
  if (colon.length >= 2) return { igId: colon[0] || '', pw: colon[1] || '', proxy: colon.slice(2).join(':').trim() };
  return { igId: line.trim(), pw: '', proxy: '' };
}

// ---- 상태/설정 ----
ipcMain.handle('state:get', () => store.getState());
ipcMain.handle('state:update', (_e, patch) => store.update(patch));
ipcMain.handle('state:updateScoped', (_e, { target, patch }) => store.updateScoped(target, patch));
ipcMain.handle('state:reset', () => store.reset());

// ---- 계정 ----
ipcMain.handle('account:add', (_e, p) => {
  const o = typeof p === 'string' ? { label: p } : (p || {});
  return store.addAccount({ label: o.label, igId: o.igId, pwEnc: encryptPw(o.pw), proxy: o.proxy });
});
ipcMain.handle('account:setCreds', (_e, { id, igId, pw }) => store.setCredentials(id, igId, pw != null ? encryptPw(pw) : null));
ipcMain.handle('account:setProxy', (_e, { id, proxy }) => store.setProxy(id, proxy));
ipcMain.handle('account:remove', (_e, id) => store.removeAccount(id));

// 계정 파일 일괄 등록: 각 줄 "id:pw[:proxy]" | "id,pw,proxy" | "id pw proxy"
ipcMain.handle('account:loadFile', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt', 'csv'] }] });
  if (r.canceled) return { state: store.getState(), added: 0 };
  let added = 0;
  for (const line of readLines(r.filePaths[0])) {
    const p = parseAccountLine(line);
    if (!p.igId) continue;
    store.addAccount({ igId: p.igId, label: p.igId, pwEnc: encryptPw(p.pw || ''), proxy: p.proxy });
    added++;
  }
  return { state: store.getState(), added };
});

ipcMain.handle('account:login', async (_e, id) => {
  try {
    const acc = store.getAccount(id);
    const res = await poster.openLogin(app.getPath('userData'), id, { igId: acc && acc.igId, igPw: acc ? decryptPw(acc.pwEnc) : '', proxy: acc && acc.proxy });
    store.setAccountStatus(id, res.loggedIn ? 'loggedIn' : 'pending');
    return { ok: res.ok, loggedIn: res.loggedIn, message: res.message };
  } catch (err) { return { ok: false, loggedIn: false, message: String(err && err.message || err) }; }
});
ipcMain.handle('account:check', async (_e, id) => {
  const acc = store.getAccount(id);
  const res = await poster.checkSession(app.getPath('userData'), id, { proxy: acc && acc.proxy });
  store.setAccountStatus(id, res.loggedIn ? 'loggedIn' : 'expired');
  return res;
});

ipcMain.handle('network:adbDevices', () => network.listDevices());
ipcMain.handle('network:resetMobileData', async () => {
  const s = store.getState();
  return network.resetMobileData(s.network && s.network.tether);
});

// ---- 파일/폴더 로드 ----
ipcMain.handle('dialog:pickImage', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:pickMedia', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: mediaFilters() });
  if (r.canceled) return null;
  const filePath = r.filePaths[0];
  return { path: filePath, previewUrl: pathToFileURL(filePath).href, type: isImageFile(filePath) ? 'image' : 'video' };
});
// 이미지 폴더 → 스코프(전역/계정)별 imagePaths 저장
ipcMain.handle('dialog:pickImageFolder', async (_e, target) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled) return [];
  const exts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov']);
  const files = fs.readdirSync(r.filePaths[0]).filter((f) => exts.has(path.extname(f).toLowerCase())).map((f) => path.join(r.filePaths[0], f));
  store.updateScoped(target, { imagePaths: files });
  return files;
});
// 본문 폴더 → 각 .txt 파일 내용을 하나의 본문으로 추가
ipcMain.handle('content:loadBodiesFolder', async (_e, { existing }) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled) return null;
  const bodies = (existing || []).slice();
  for (const f of fs.readdirSync(r.filePaths[0]).filter((x) => x.toLowerCase().endsWith('.txt'))) {
    const txt = fs.readFileSync(path.join(r.filePaths[0], f), 'utf-8').trim();
    if (txt) bodies.push(txt);
  }
  return bodies;
});
// 치환 파일: 각 줄 "from=to" (to에 | 있으면 랜덤)
ipcMain.handle('file:loadSubstitution', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt', 'csv'] }] });
  if (r.canceled) return null;
  return readLines(r.filePaths[0]).map((l) => { const i = l.indexOf('='); return i < 0 ? null : { from: l.slice(0, i).trim(), to: l.slice(i + 1).trim() }; }).filter(Boolean);
});
// 글자 리스트 파일: 각 줄이 하나의 문구
ipcMain.handle('file:loadTextList', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt'] }] });
  if (r.canceled) return null;
  return readLines(r.filePaths[0]);
});

// ---- GPT ----
ipcMain.handle('gpt:test', (_e, cfg) => gpt.testKey(cfg));
ipcMain.handle('gpt:testFal', (_e, cfg) => gpt.testFalKey(cfg));
ipcMain.handle('ai:generateDraft', async (_e, payload) => {
  const s = store.getState();
  const cfg = Object.assign({}, s.gpt, payload && payload.gpt);
  const outDir = path.join(app.getPath('userData'), 'generated');
  return gpt.generateDraft(cfg, Object.assign({}, payload, { outDir }));
});
// 배치 이미지 생성: 텍스트로 N장을 뽑아 후보 목록 반환(일부만 선택해 업로드 목록에 추가)
ipcMain.handle('ai:generateImages', async (_e, payload) => {
  const s = store.getState();
  const cfg = Object.assign({}, s.gpt, payload && payload.gpt);
  const outDir = path.join(app.getPath('userData'), 'generated');
  return gpt.generateImages(cfg, Object.assign({}, payload, { outDir }));
});
// 선택한 후보들(복수)을 스코프별 업로드 목록(imagePaths)에 추가
ipcMain.handle('ai:selectDrafts', (_e, { target, assets }) => {
  const paths = (assets || []).map((a) => a && a.path).filter(Boolean);
  if (!paths.length) return store.getState();
  const s = store.getState();
  const current = target && target !== 'global'
    ? (((s.accountSettings || {})[target] || {}).imagePaths || s.imagePaths || [])
    : (s.imagePaths || []);
  const next = current.slice();
  for (const p of paths) if (!next.includes(p)) next.push(p);
  return store.updateScoped(target || 'global', { imagePaths: next });
});
ipcMain.handle('ai:selectDraft', (_e, { target, asset }) => {
  if (!asset || !asset.path) return store.getState();
  const s = store.getState();
  const current = target && target !== 'global'
    ? (((s.accountSettings || {})[target] || {}).imagePaths || s.imagePaths || [])
    : (s.imagePaths || []);
  const next = current.includes(asset.path) ? current : current.concat(asset.path);
  return store.updateScoped(target || 'global', { imagePaths: next });
});

// ---- 작업 ----
ipcMain.handle('work:start', async (_e, params) => {
  if (runner.isRunning()) return { ok: false, message: '이미 작업 중' };
  try {
    const summary = await runner.run(app.getPath('userData'), params, (evt) => send('work:event', evt));
    return { ok: true, summary };
  } catch (err) { return { ok: false, message: String(err && err.message || err) }; }
});
ipcMain.handle('work:stop', () => { runner.stop(); return { ok: true }; });

// 단일 발행 테스트(전역 설정 기준)
ipcMain.handle('post:now', async (_e, job) => {
  try {
    const s = store.getState();
    send('work:event', { account: job.accountId, stage: '이미지 처리', label: '단일' });
    if (s.network && s.network.tether && s.network.tether.enabled) {
      send('work:event', { account: job.accountId, stage: '모바일 데이터 재연결', label: '단일' });
      await network.resetMobileData(s.network.tether);
    }
    const mediaPath = job.mediaPath || job.imagePath;
    const processed = isImageFile(mediaPath)
      ? await image.processImage(mediaPath, path.join(app.getPath('userData'), 'processed'), s.image, s.registration)
      : mediaPath;
    const acc = store.getAccount(job.accountId);
    const r = await poster.publishPost(app.getPath('userData'), Object.assign({}, job, { mediaPath: processed, imagePath: processed, proxy: acc && acc.proxy }),
      (stage) => send('work:event', { account: job.accountId, stage, label: '단일' }));
    return r;
  } catch (err) { return { ok: false, message: String(err && err.message || err) }; }
});
