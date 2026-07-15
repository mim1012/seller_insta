'use strict';
/**
 * runner.js — 다계정 순차 발행 오케스트레이터 (계정별 유효설정 사용)
 *  각 계정은 store.effectiveSettings(accId) (전역 기본 + 계정 오버라이드)로 발행.
 *  계정마다 다른 내용/이미지/등록설정/수량/딜레이 가능.
 */
const path = require('path');
const image = require('./image');
const poster = require('./poster');
const captionMod = require('./caption');
const gpt = require('./gpt');
const store = require('./store');
const network = require('./network');

let stopFlag = false;
let running = false;
function stop() { stopFlag = true; }
function isRunning() { return running; }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randDelay(min, max) {
  const a = Number(min) || 0, b = Number(max) || a, lo = Math.min(a, b), hi = Math.max(a, b);
  return Math.round((lo + Math.random() * (hi - lo)) * 1000);
}
function pickImage(paths, mode, idx) {
  if (!paths || !paths.length) return null;
  if (mode === 'random') return paths[Math.floor(Math.random() * paths.length)];
  return paths[idx % paths.length];
}
function isImageFile(file) { return ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(file || '').toLowerCase()); }

/**
 * @param {string} userDataPath
 * @param {object} params { accountIds[] }
 * @param {(evt)=>void} onEvent
 */
async function run(userDataPath, params, onEvent = () => {}) {
  if (running) throw new Error('이미 작업 중');
  running = true; stopFlag = false;
  captionMod.resetCursor(); image.resetTextCursor();

  const { accountIds = [] } = params;
  const outDir = path.join(userDataPath, 'processed');
  const results = [];

  try {
    for (let ai = 0; ai < accountIds.length; ai++) {
      if (stopFlag) break;
      const accId = accountIds[ai];
      const acc = store.getAccount(accId);
      const globalState = store.getState();
      const tether = globalState.network && globalState.network.tether;
      if (tether && tether.enabled && tether.beforeEachAccount) {
        onEvent({ account: accId, stage: '모바일 데이터 재연결', label: accId });
        await network.resetMobileData(tether);
      }
      const s = store.effectiveSettings(accId);          // 계정별 병합 설정
      const w = s.work;
      const count = Math.max(1, Number(w.perAccountCount) || 1);

      for (let n = 0; n < count; n++) {
        if (stopFlag) break;
        const label = `${accId} (${n + 1}/${count})`;
        try {
          onEvent({ account: accId, stage: '캡션 생성', label });
          let gptText = null;
          if (s.gpt && s.gpt.enabled && s.gpt.apiKey) {
            const base = (s.content.bodies || [])[0] || '';
            gptText = await gpt.generateCaption(s.gpt, base);
          }
          const { caption: cap, location } = captionMod.buildCaption(s.content, {
            bodyMode: w.bodyMode, tagMode: w.tagMode, locMode: w.locMode,
            tagCountMin: w.tagCountMin, tagCountMax: w.tagCountMax,
            substitution: s.registration.substitution, gptText,
          });

          onEvent({ account: accId, stage: '미디어 준비', label });
          const needSrc = (s.image.photoSource || 'saved') === 'saved';
          const src = needSrc ? pickImage(s.imagePaths, w.imageMode, n) : null;
          if (needSrc && !src) throw new Error('미디어가 없습니다(폴더 불러오기 또는 AI 생성 선택 필요)');
          const processed = !src || isImageFile(src)
            ? await image.processImage(src, outDir, s.image, s.registration)
            : src;

          const opts = {
            addLocation: !!(s.registration.addLocation && location),
            locationQuery: location || '',
            altText: s.registration.altText || '',
            hideLikes: !!s.registration.hideLikes,
            disableComments: !!s.registration.disableComments,
            shareThreads: !!s.registration.shareThreads,
          };
          await poster.publishPost(userDataPath, { accountId: accId, mediaPath: processed, imagePath: processed, caption: cap, options: opts, proxy: acc && acc.proxy },
            (stage) => onEvent({ account: accId, stage, label }));

          results.push({ account: accId, n, ok: true });
          onEvent({ account: accId, stage: '✅ 완료', label, ok: true });
        } catch (err) {
          results.push({ account: accId, n, ok: false, error: String(err.message || err) });
          onEvent({ account: accId, stage: '❌ 실패: ' + (err.message || err), label, ok: false });
        }

        const isLast = (ai === accountIds.length - 1) && (n === count - 1);
        if (!isLast && !stopFlag) {
          const ms = randDelay(w.delayMin, w.delayMax);
          onEvent({ account: accId, stage: `대기 ${Math.round(ms / 1000)}초`, label });
          await sleep(ms);
        }
      }
    }
  } finally { running = false; }

  const ok = results.filter((r) => r.ok).length;
  return { total: results.length, ok, fail: results.length - ok, stopped: stopFlag, results };
}

module.exports = { run, stop, isRunning };
