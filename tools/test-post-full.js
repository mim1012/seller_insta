'use strict';
/**
 * test-post-full.js — 풀옵션 E2E: 이미지처리 + 위치 + 고급옵션 켜고 실제 게시 1건
 * ※ 실제 게시됩니다(테스트 후 삭제 가능).
 * 실행: node tools/test-post-full.js
 */
const path = require('path');
const poster = require('../src/main/poster');
const image = require('../src/main/image');

const USER_DATA = 'C:\\Users\\PC_1M\\AppData\\Roaming\\insta-auto-poster';
const ACCOUNT_ID = 'id_7v3ex_3';
const SRC = path.join(__dirname, '..', 'frame_8.jpg');
const OUT = path.join(__dirname, '..', '_test_out');

(async () => {
  console.log('=== 풀옵션 게시 테스트 ===');

  // 1) 이미지 처리: 1:1 크롭 + 글자 오버레이 + 테두리 + 740px
  const imgSettings = {
    resize: '740', filter: false,
    border: { enabled: true, width: 1, pad: 24 },
    text1: { enabled: true, text: '자동 게시 테스트', size: 40, outline: true },
    text2: { enabled: false },
  };
  const regSettings = { ratio: '1:1' };
  console.log('  이미지 처리...');
  const processed = await image.processImage(SRC, OUT, imgSettings, regSettings);
  console.log('  처리됨:', processed);

  // 2) 게시 (위치 + 고급옵션)
  const r = await poster.publishPost(
    USER_DATA,
    {
      accountId: ACCOUNT_ID,
      imagePath: processed,
      caption: '풀옵션 자동 게시 테스트 ✅\n\n#테스트 #자동화',
      options: {
        addLocation: true, locationQuery: '서울',
        altText: '자동 생성 테스트 이미지',
        hideLikes: true, disableComments: true,
      },
    },
    (stage) => console.log('  진행:', stage),
  );
  console.log('=== 결과:', JSON.stringify(r), '===');
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
