'use strict';
/**
 * poster.js — Playwright 기반 인스타그램 게시 자동화 엔진
 *
 * 정책: 본인 소유 계정에 본인 콘텐츠 게시 용도.
 *  - 비밀번호 저장 안 함: 최초 1회 사용자가 직접 로그인 → 세션(쿠키) 영속화 후 재사용.
 *
 * 주의: instagram.com 웹 UI 셀렉터는 자주 바뀐다. 로직은 role/텍스트 기반으로
 *       방어적으로 작성했고, 깨질 경우 SELECTORS 상수만 조정하면 된다.
 */

const path = require('path');
const fs = require('fs');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  chromium = null; // 의존성 미설치 시 main에서 안내
}

const IG_URL = 'https://www.instagram.com/';

function proxyOption(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let u;
  try { u = new URL(normalized); }
  catch (_) { throw new Error('프록시 형식 오류: host:port 또는 scheme://host:port'); }
  const server = `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  const opt = { server };
  if (u.username) opt.username = decodeURIComponent(u.username);
  if (u.password) opt.password = decodeURIComponent(u.password);
  return opt;
}

function launchOptions({ headless, proxy } = {}) {
  const opts = {
    headless: !!headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  };
  const parsed = proxyOption(proxy);
  if (parsed) opts.proxy = parsed;
  return opts;
}

// UI 변동에 대비한 후보 셀렉터(한/영 동시 대응)
const SELECTORS = {
  // 로그인 완료 판정: 홈 피드의 "만들기/Create" 버튼이 보이면 로그인된 상태
  loggedInProbe: [
    'svg[aria-label="새로운 게시물"]',
    'svg[aria-label="New post"]',
    'svg[aria-label="홈"]',
    'svg[aria-label="Home"]',
  ],
  createButton: [
    'svg[aria-label="새로운 게시물"]',
    'svg[aria-label="New post"]',
  ],
  // 로그인 폼 (instagram.com/accounts/login 실제 DOM 기준)
  loginUser: 'input[name="email"], input[name="username"]',
  loginPass: 'input[name="pass"], input[name="password"]',
  loginSubmit: 'input[type="submit"], button[type="submit"], div[role="button"]:has-text("로그인")',
  // 새 게시물 다이얼로그
  fileInput: 'input[type="file"]',
  // 다이얼로그 범위로 한정(배경 피드의 동일 텍스트 버튼 오클릭 방지)
  nextButton: ['div[role="dialog"] div[role="button"]:has-text("다음")', 'div[role="dialog"] div[role="button"]:has-text("Next")'],
  shareButton: ['div[role="dialog"] div[role="button"]:has-text("공유하기")', 'div[role="dialog"] div[role="button"]:has-text("Share")'],
  captionBox: ['div[role="textbox"][aria-label="문구를 입력하세요..."]', 'div[role="textbox"][aria-label="Write a caption..."]', 'div[contenteditable="true"][aria-label*="문구"]', 'div[role="dialog"] div[contenteditable="true"]'],
  advancedToggle: ['div[role="dialog"] div[role="button"]:has-text("고급 설정")', 'div[role="dialog"] div[role="button"]:has-text("Advanced settings")'],
  accessibilityToggle: ['div[role="dialog"] div[role="button"]:has-text("접근성")', 'div[role="dialog"] div[role="button"]:has-text("Accessibility")'],
  locationInput: ['input[name="creation-location-input"]', 'input[placeholder="위치 추가"]', 'input[placeholder="Add location"]'],
  altInput: ['div[role="dialog"] input[placeholder*="대체 텍스트"]', 'div[role="dialog"] input[placeholder*="alt text"]'],
  // 좋아요숨김/댓글끄기: 익명 체크박스 → 행 텍스트로 클릭(클릭 시 토글)
  hideLikesText: '이 게시물의 좋아요 수 및 조회수 숨기기',
  disableCommentsText: '댓글 기능 해제',
  shareThreadsText: 'Threads에 자동으로 공유',
};

function sessionDir(userDataPath, accountId) {
  return path.join(userDataPath, 'sessions', String(accountId));
}

/** 여러 후보 셀렉터 중 먼저 보이는 것을 클릭 */
async function clickFirst(page, candidates, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click().catch(() => {});
        return true;
      }
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function anyVisible(page, candidates, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of candidates) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * 계정 세션으로 로그인 창을 띄운다. 이미 세션이 있으면 바로 로그인 상태가 된다.
 * headless=false 로 띄워서 사용자가 직접 로그인/2FA/체크포인트를 해결할 수 있게 함.
 * @returns {Promise<{ok:boolean, loggedIn:boolean, message:string}>}
 */
async function openLogin(userDataPath, accountId, { onClose, igId, igPw, proxy } = {}) {
  if (!chromium) return { ok: false, loggedIn: false, message: 'playwright 미설치: npm install 필요' };
  const dir = sessionDir(userDataPath, accountId);
  fs.mkdirSync(dir, { recursive: true });

  const context = await chromium.launchPersistentContext(dir, launchOptions({ headless: false, proxy }));
  if (onClose) context.on('close', () => onClose());
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(IG_URL, { waitUntil: 'domcontentloaded' });

  let loggedIn = await anyVisible(page, SELECTORS.loggedInProbe, 4000);

  // 세션이 없고 자격증명이 있으면 로그인 폼 자동입력
  if (!loggedIn && igId && igPw) {
    // 로그인 폼이 뜰 때까지 대기(루트로 들어온 경우 /accounts/login 로 이동)
    let user = page.locator(SELECTORS.loginUser).first();
    if (!(await user.isVisible().catch(() => false))) {
      await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2500);
      user = page.locator(SELECTORS.loginUser).first();
    }
    if (await user.isVisible().catch(() => false)) {
      await user.click().catch(() => {});
      await user.fill(igId).catch(() => {});
      const pass = page.locator(SELECTORS.loginPass).first();
      await pass.click().catch(() => {});
      await pass.fill(igPw).catch(() => {});
      await page.waitForTimeout(600); // 제출 버튼 활성화 대기
      await page.locator(SELECTORS.loginSubmit).first().click().catch(() => {});
      await pass.press('Enter').catch(() => {}); // 폴백
      // 로그인 처리/체크포인트/2FA 대기(최대 25초). 챌린지면 사용자가 직접 해결.
      loggedIn = await anyVisible(page, SELECTORS.loggedInProbe, 25000);
    }
  }

  const message = loggedIn ? '로그인 성공(세션 저장됨)'
    : (igId && igPw) ? '자동입력 시도함 — 2FA/체크포인트가 있으면 브라우저에서 직접 완료하세요'
    : '브라우저에서 직접 로그인하세요(완료되면 자동 저장)';
  return { ok: true, loggedIn, message, _context: context };
}

/** 현재 세션이 로그인 상태인지 헤드리스로 확인 */
async function checkSession(userDataPath, accountId, { proxy } = {}) {
  if (!chromium) return { loggedIn: false, message: 'playwright 미설치' };
  const dir = sessionDir(userDataPath, accountId);
  if (!fs.existsSync(dir)) return { loggedIn: false, message: '세션 없음' };
  const context = await chromium.launchPersistentContext(dir, launchOptions({ headless: true, proxy }));
  try {
    const page = await context.newPage();
    await page.goto(IG_URL, { waitUntil: 'domcontentloaded' });
    const loggedIn = await anyVisible(page, SELECTORS.loggedInProbe, 5000);
    return { loggedIn, message: loggedIn ? '로그인 유효' : '재로그인 필요' };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * 게시물 1건 발행.
 * @param {object} job { accountId, mediaPath|imagePath, caption, options }
 * @param {(stage:string)=>void} onProgress
 */
async function publishPost(userDataPath, job, onProgress = () => {}) {
  if (!chromium) throw new Error('playwright 미설치: `npm install` 후 `npx playwright install chromium`');
  const { accountId, caption = '', options = {}, proxy = '' } = job;
  const mediaPath = job.mediaPath || job.imagePath;
  if (!fs.existsSync(mediaPath)) throw new Error('미디어 파일 없음: ' + mediaPath);

  const dir = sessionDir(userDataPath, accountId);
  const context = await chromium.launchPersistentContext(dir, launchOptions({ headless: false, proxy }));

  try {
    const page = context.pages()[0] || (await context.newPage());
    onProgress('홈 이동');
    await page.goto(IG_URL, { waitUntil: 'domcontentloaded' });

    if (!(await anyVisible(page, SELECTORS.loggedInProbe, 6000))) {
      throw new Error('로그인 세션 없음 — 먼저 계정 로그인을 완료하세요');
    }

    onProgress('새 게시물 열기');
    if (!(await clickFirst(page, SELECTORS.createButton, 8000))) {
      throw new Error('새 게시물 버튼을 찾지 못함(셀렉터 변경 가능)');
    }

    onProgress('미디어 업로드');
    const fileInput = page.locator(SELECTORS.fileInput).first();
    await fileInput.waitFor({ state: 'attached', timeout: 8000 });
    await fileInput.setInputFiles(mediaPath);

    // 자르기 → 다음, 필터 → 다음 (보통 '다음' 2회)
    onProgress('편집 단계 통과');
    await clickFirst(page, SELECTORS.nextButton, 8000);
    await page.waitForTimeout(800);
    await clickFirst(page, SELECTORS.nextButton, 8000);
    await page.waitForTimeout(800);

    onProgress('캡션 입력');
    for (const sel of SELECTORS.captionBox) {
      const box = page.locator(sel).first();
      if (await box.isVisible().catch(() => false)) {
        await box.click();
        await box.fill(caption).catch(async () => { await page.keyboard.type(caption); });
        break;
      }
    }

    // 위치 추가 (실패해도 게시는 계속)
    if (options.addLocation && options.locationQuery) {
      onProgress('위치 추가');
      try { await applyLocation(page, options.locationQuery); }
      catch (e) { onProgress('위치 건너뜀: ' + (e.message || e)); }
    }

    // alt 텍스트 + 좋아요숨김 + 댓글끄기 + Threads (실패해도 게시는 계속)
    if (options.altText || options.hideLikes || options.disableComments || options.shareThreads) {
      onProgress('고급 설정');
      try { await applyAdvanced(page, options); }
      catch (e) { onProgress('고급설정 건너뜀: ' + (e.message || e)); }
    }

    onProgress('공유');
    if (!(await clickFirst(page, SELECTORS.shareButton, 8000))) {
      throw new Error('공유 버튼을 찾지 못함(셀렉터 변경 가능)');
    }

    await page.waitForTimeout(4000);
    onProgress('완료');
    return { ok: true, message: '게시 완료' };
  } finally {
    await context.close().catch(() => {});
  }
}

/** 위치 입력: 위치 칸에 타이핑 후 첫 제안 선택 */
async function applyLocation(page, query) {
  for (const sel of SELECTORS.locationInput) {
    const inp = page.locator(sel).first();
    if (await inp.isVisible().catch(() => false)) {
      // click()은 오버레이 div가 가로채므로 fill()로 직접 포커스+입력
      await inp.fill(query).catch(() => {});
      await page.waitForTimeout(2000);
      // 제안: role=option 우선, 없으면 쿼리 포함 버튼. 가로채임 대비 force 클릭.
      const opt = page.locator('div[role="dialog"] [role="option"], div[role="dialog"] [role="button"]', { hasText: query }).first();
      if (await opt.isVisible().catch(() => false)) await opt.click({ force: true }).catch(() => {});
      return true;
    }
  }
  return false;
}

/**
 * 고급 옵션 적용.
 *  - alt 텍스트: '접근성' 아코디언을 펼친 뒤 입력
 *  - 좋아요 숨김/댓글 끄기: '고급 설정' 아코디언을 펼친 뒤 행 텍스트 클릭(클릭=토글, 기본 off→on)
 */
async function applyAdvanced(page, options) {
  if (options.altText) {
    await clickFirst(page, SELECTORS.accessibilityToggle, 4000);
    await page.waitForTimeout(500);
    for (const sel of SELECTORS.altInput) {
      const inp = page.locator(sel).first();
      if (await inp.isVisible().catch(() => false)) { await inp.fill(options.altText).catch(() => {}); break; }
    }
  }
  if (options.hideLikes || options.disableComments || options.shareThreads) {
    await clickFirst(page, SELECTORS.advancedToggle, 4000);
    await page.waitForTimeout(600);
    if (options.hideLikes) await clickRowByText(page, SELECTORS.hideLikesText);
    if (options.disableComments) await clickRowByText(page, SELECTORS.disableCommentsText);
    if (options.shareThreads) await clickRowByText(page, SELECTORS.shareThreadsText);
  }
}

/** 다이얼로그 내 특정 텍스트(토글 행)를 클릭 → 체크박스 토글 */
async function clickRowByText(page, text) {
  const el = page.locator('div[role="dialog"]').getByText(text, { exact: false }).first();
  if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); return true; }
  return false;
}

module.exports = { openLogin, checkSession, publishPost, sessionDir, SELECTORS, proxyOption };
