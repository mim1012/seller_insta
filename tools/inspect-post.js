'use strict';
/**
 * inspect-post.js — 저장된 로그인 세션으로 '새 게시물' 플로우 DOM 덤프
 * 목적: 게시 단계별(새 게시물/파일/다음/캡션/위치/고급설정/공유) 셀렉터 확인.
 * ※ 실제 '공유'는 누르지 않음. 셀렉터 수집 후 종료.
 * 실행: node tools/inspect-post.js
 */
const { chromium } = require('playwright');
const path = require('path');

const SESSION = 'C:\\Users\\PC_1M\\AppData\\Roaming\\insta-auto-poster\\sessions\\id_7v3ex_3';
const TEST_IMG = path.join(__dirname, '..', 'frame_8.jpg');

async function dumpStage(page, label) {
  const d = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dialog = document.querySelector('div[role="dialog"]') || document;
    const q = (sel) => Array.from(dialog.querySelectorAll(sel)).filter(vis);

    const editables = q('[contenteditable="true"],[role="textbox"]').map((el) => ({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'), ce: el.getAttribute('contenteditable'),
    }));
    const inputs = q('input,textarea').map((el) => ({
      type: el.getAttribute('type'), name: el.getAttribute('name'),
      ariaLabel: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'),
    }));
    // 체크박스: 가장 가까운 의미있는 행 텍스트와 함께
    const checks = q('input[type="checkbox"]').map((cb) => {
      let n = cb, txt = '';
      for (let i = 0; i < 6 && n; i++) { n = n.parentElement; if (n && n.textContent && n.textContent.trim().length > 1) { txt = n.textContent.trim().slice(0, 45); break; } }
      return { rowText: txt };
    });
    // 다이얼로그 내 버튼만
    const btns = q('button,div[role="button"],[role="button"]')
      .map((b) => ({ tag: b.tagName.toLowerCase(), text: (b.textContent || '').trim().slice(0, 30) }))
      .filter((b) => b.text);
    return { editables, inputs, checks, btns: btns.slice(0, 20) };
  });
  console.log(`\n========== [${label}] ==========`);
  console.log('EDITABLES:', JSON.stringify(d.editables));
  console.log('INPUTS:', JSON.stringify(d.inputs));
  console.log('CHECKBOXES:', JSON.stringify(d.checks));
  console.log('DIALOG BUTTONS:', JSON.stringify(d.btns));
}

async function clickByText(page, texts) {
  for (const t of texts) {
    const loc = page.locator(`div[role="button"]:has-text("${t}"), button:has-text("${t}")`).first();
    if (await loc.isVisible().catch(() => false)) { await loc.click().catch(() => {}); return t; }
  }
  return null;
}

(async () => {
  const context = await chromium.launchPersistentContext(SESSION, {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--remote-debugging-port=9223'],
  });
  const page = context.pages()[0] || (await context.newPage());
  console.log('CDP: http://localhost:9223');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await dumpStage(page, '홈(로그인 확인)');

  // 1) 새 게시물 열기
  for (const sel of ['svg[aria-label="새로운 게시물"]', 'svg[aria-label="New post"]', 'a[href="#"]:has(svg)']) {
    const l = page.locator(sel).first();
    if (await l.isVisible().catch(() => false)) { await l.click().catch(() => {}); console.log('\n새게시물 클릭:', sel); break; }
  }
  await page.waitForTimeout(1500);
  await clickByText(page, ['게시물', 'Post']);
  await page.waitForTimeout(1500);
  await dumpStage(page, '새 게시물 다이얼로그(파일 업로드 전)');

  // 2) 파일 업로드
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count().catch(() => 0)) {
    await fileInput.setInputFiles(TEST_IMG).catch((e) => console.log('setFiles err', e.message));
    console.log('\n이미지 업로드:', TEST_IMG);
  } else {
    console.log('\n[!] file input 없음');
  }
  await page.waitForTimeout(2500);
  await dumpStage(page, '업로드 후(자르기 단계)');

  // 3) 다음 1
  console.log('\n다음(1):', await clickByText(page, ['다음', 'Next']));
  await page.waitForTimeout(2000);
  await dumpStage(page, '필터 단계');

  // 4) 다음 2
  console.log('\n다음(2):', await clickByText(page, ['다음', 'Next']));
  await page.waitForTimeout(2000);
  await dumpStage(page, '캡션 단계(위치/접근성/고급설정 확인)');

  // 5) 고급 설정 펼치기
  console.log('\n고급 설정:', await clickByText(page, ['고급 설정', 'Advanced settings']));
  await page.waitForTimeout(1500);
  await dumpStage(page, '고급 설정 펼친 후');

  console.log('\n[완료] 공유는 누르지 않음. 5초 후 종료.');
  await page.waitForTimeout(5000);
  await context.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
