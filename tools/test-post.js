'use strict';
/**
 * test-post.js — 저장된 세션으로 실제 게시 1건 E2E 테스트
 * ※ 실제로 인스타에 게시됩니다(테스트 후 삭제 가능).
 * 실행: node tools/test-post.js
 */
const path = require('path');
const poster = require('../src/main/poster');

const USER_DATA = 'C:\\Users\\PC_1M\\AppData\\Roaming\\insta-auto-poster';
const ACCOUNT_ID = 'id_7v3ex_3';
const IMG = path.join(__dirname, '..', 'frame_8.jpg');

(async () => {
  console.log('=== 실제 게시 테스트 시작 ===');
  const r = await poster.publishPost(
    USER_DATA,
    { accountId: ACCOUNT_ID, imagePath: IMG, caption: '자동 게시 테스트입니다 ✅\n\n#테스트', options: {} },
    (stage) => console.log('  진행:', stage),
  );
  console.log('=== 결과:', JSON.stringify(r), '===');
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
