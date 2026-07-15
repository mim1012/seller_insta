'use strict';
/**
 * open-session.js — 저장된 로그인 세션으로 인스타를 열어둔다(확인용).
 * 게시/저장 동작 없음. 프로필로 이동해 방금 올린 게시물을 직접 확인.
 * 실행: node tools/open-session.js
 */
const { chromium } = require('playwright');

const SESSION = 'C:\\Users\\PC_1M\\AppData\\Roaming\\insta-auto-poster\\sessions\\id_7v3ex_3';

(async () => {
  const context = await chromium.launchPersistentContext(SESSION, {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const profile = page.locator('a[href^="/"][role="link"] img[alt*="프로필"], a:has(img[alt*="프로필 사진"])').first();
  await profile.click().catch(() => {});
  console.log('로그인 세션 브라우저를 열었습니다. 프로필에서 게시물을 확인하세요.');
  console.log('브라우저는 자동으로 닫지 않습니다. 직접 닫으세요.');
  // 자동 종료하지 않음: 사용자가 직접 닫을 때까지 유지
  await new Promise(() => {});
})().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
