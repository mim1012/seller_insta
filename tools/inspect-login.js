'use strict';
/**
 * inspect-login.js — instagram.com 로그인 페이지 DOM 인벤토리 덤프
 * 목적: 실제 input/button 셀렉터를 확인해 poster.js SELECTORS 교정.
 * 실행: node tools/inspect-login.js   (CDP 포트 9222로도 열어둠)
 */
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

(async () => {
  const dir = path.join(os.tmpdir(), 'ig-inspect-profile');
  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--remote-debugging-port=9222'],
  });
  const page = context.pages()[0] || (await context.newPage());

  console.log('CDP: http://localhost:9222  (chrome://inspect 또는 Playwright connectOverCDP)');
  console.log('-> /accounts/login/ 이동');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const dump = await page.evaluate(() => {
    const attrs = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder'),
      autocomplete: el.getAttribute('autocomplete'),
    });
    const inputs = Array.from(document.querySelectorAll('input')).map(attrs);
    const buttons = Array.from(document.querySelectorAll('button, div[role="button"]')).map((b) => ({
      tag: b.tagName.toLowerCase(),
      type: b.getAttribute('type'),
      role: b.getAttribute('role'),
      text: (b.textContent || '').trim().slice(0, 40),
    })).filter((b) => b.text);
    return { url: location.href, title: document.title, inputs, buttons };
  });

  console.log('\n===== URL =====\n' + dump.url + '  |  ' + dump.title);
  console.log('\n===== INPUTS (' + dump.inputs.length + ') =====');
  console.log(JSON.stringify(dump.inputs, null, 2));
  console.log('\n===== BUTTONS (' + dump.buttons.length + ') =====');
  console.log(JSON.stringify(dump.buttons.slice(0, 20), null, 2));

  console.log('\n브라우저는 60초간 열어둡니다. 직접 확인 후 닫아도 됩니다.');
  await page.waitForTimeout(60000);
  await context.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
