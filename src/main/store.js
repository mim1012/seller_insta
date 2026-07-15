'use strict';
/**
 * store.js — 설정/계정/발행큐 로컬 영속화 (userData/data.json)
 * 민감정보(비밀번호/토큰)는 평문 저장하지 않는다(safeStorage 암호문 pwEnc만).
 *
 * 설정 구조: 전역 기본(content/image/registration/work) + 계정별 오버라이드(accountSettings[id]).
 * 발행 시 effectiveSettings(accountId) = deepMerge(기본, 계정 오버라이드).
 */
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

let FILE = null;
let state = defaultState();

function defaultGroups() {
  return {
    content: { tags: [], locations: [], bodies: [] },
    image: {
      photoSource: 'saved',   // saved|color|download (저장/색상/자동 다운로드 사진)
      resize: 'random',       // random|740|650|550|480|original
      filter: false,          // 흑백/흐림/가우시안 랜덤
      border: { enabled: false, width: 1, pad: 24 },
      text1: { enabled: false, text: '', size: 40, outline: false },
      text2: { enabled: false, text: '', size: 40, shadow: false },
      textList: [],           // 글자 리스트(여러 문구)
      textListMode: 'off',    // off|order|random
    },
    registration: {
      ratio: '1:1',           // 1:1|4:5|16:9|original
      addLocation: false, altText: '', hideLikes: false, disableComments: false,
      shareThreads: false,    // Threads 자동 공유
      substitution: [],       // [{ from, to }]  문구 치환(to에 | 있으면 랜덤)
    },
    work: {
      perAccountCount: 1, delayMin: 3, delayMax: 8,
      imageMode: 'random',
      tagCountMin: 0, tagCountMax: 0,
      bodyMode: 'random', tagMode: 'random', locMode: 'random',
    },
    imagePaths: [],
  };
}

function defaultState() {
  const g = defaultGroups();
  return {
    accounts: [],            // { id, label, igId, pwEnc, sessionStatus }
    content: g.content,
    image: g.image,
    registration: g.registration,
    gpt: {
      enabled: false, apiKey: '', model: 'gpt-4o-mini',
      imageModel: 'gpt-image-1', videoModel: 'sora-2',
      prompt: '비슷한 느낌으로 자연스럽게 다시 써줘',
    },
    work: g.work,
    imagePaths: g.imagePaths,
    network: {
      tether: { enabled: false, adbSerial: '', waitSeconds: 8, beforeEachAccount: false },
    },
    accountSettings: {},     // { [accountId]: { content?, image?, registration?, work?, imagePaths? } }
    queue: [],
  };
}

function encryptSecret(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(String(value)).toString('base64');
}

function decryptSecret(value) {
  try {
    return value && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(value, 'base64'))
      : '';
  } catch (_) {
    return '';
  }
}

function hydrateSecrets(nextState) {
  const gpt = nextState.gpt || {};
  if (!gpt.apiKey && gpt.apiKeyEnc) gpt.apiKey = decryptSecret(gpt.apiKeyEnc);
  nextState.gpt = gpt;
  return nextState;
}

function serializeState() {
  const out = JSON.parse(JSON.stringify(state));
  if (out.gpt && out.gpt.apiKey) {
    const encrypted = encryptSecret(out.gpt.apiKey);
    if (encrypted) {
      out.gpt.apiKeyEnc = encrypted;
      delete out.gpt.apiKey;
    }
  }
  return out;
}

function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over;
  const out = Object.assign({}, base);
  if (typeof over === 'object') for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function init(userDataPath) {
  FILE = path.join(userDataPath, 'data.json');
  try {
    if (fs.existsSync(FILE)) state = hydrateSecrets(deepMerge(defaultState(), JSON.parse(fs.readFileSync(FILE, 'utf-8'))));
  } catch (e) { state = defaultState(); }
  return getState();
}

function persist() { if (FILE) fs.writeFileSync(FILE, JSON.stringify(serializeState(), null, 2), 'utf-8'); }
function getState() { return JSON.parse(JSON.stringify(state)); }
function update(patch) { state = Object.assign({}, state, patch); persist(); return getState(); }
function reset() { state = defaultState(); persist(); return getState(); }

/** 계정별 오버라이드 일부 갱신 (target='global'이면 전역 기본 갱신) */
function updateScoped(target, patch) {
  if (!target || target === 'global') {
    state = Object.assign({}, state, patch);
  } else {
    state.accountSettings[target] = Object.assign({}, state.accountSettings[target] || {}, patch);
  }
  persist();
  return getState();
}

/** 발행에 쓸 계정별 유효 설정(기본 + 오버라이드 병합) */
function effectiveSettings(accountId) {
  const base = {
    content: state.content, image: state.image, registration: state.registration,
    work: state.work, imagePaths: state.imagePaths, gpt: state.gpt,
  };
  const ov = state.accountSettings[accountId] || {};
  return {
    content: deepMerge(base.content, ov.content),
    image: deepMerge(base.image, ov.image),
    registration: deepMerge(base.registration, ov.registration),
    work: deepMerge(base.work, ov.work),
    imagePaths: ov.imagePaths || base.imagePaths,
    gpt: base.gpt,
  };
}

function genId() { return 'id_' + Math.floor(performance.now() * 1000).toString(36) + '_' + (state.accounts.length + state.queue.length); }

function addAccount(payload) {
  const p = typeof payload === 'string' ? { label: payload } : (payload || {});
  const acc = {
    id: genId(),
    label: p.label || p.igId || ('계정' + (state.accounts.length + 1)),
    igId: p.igId || '', pwEnc: p.pwEnc || '', proxy: p.proxy || '', sessionStatus: 'unknown',
  };
  state.accounts.push(acc); persist(); return acc;
}
function getAccount(id) { return state.accounts.find((a) => a.id === id) || null; }
function setCredentials(id, igId, pwEnc) {
  const a = getAccount(id);
  if (a) { a.igId = igId; if (pwEnc != null) a.pwEnc = pwEnc; persist(); }
  return a;
}
function setProxy(id, proxy) {
  const a = getAccount(id);
  if (a) { a.proxy = String(proxy || '').trim(); persist(); }
  return a;
}
function removeAccount(id) {
  state.accounts = state.accounts.filter((a) => a.id !== id);
  delete state.accountSettings[id];
  persist(); return getState();
}
function setAccountStatus(id, sessionStatus) { const a = getAccount(id); if (a) { a.sessionStatus = sessionStatus; persist(); } return a; }

module.exports = {
  init, getState, update, updateScoped, effectiveSettings, reset, persist,
  addAccount, removeAccount, setAccountStatus, getAccount, setCredentials, setProxy, genId, defaultGroups,
};
