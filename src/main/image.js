'use strict';
/**
 * image.js — sharp 기반 이미지 처리 파이프라인
 * 사진소스(저장/색상/자동다운로드) → 비율 크롭 → 리사이즈 → 필터 → 테두리 → 글자(1·2/리스트) 오버레이
 */
const path = require('path');
const fs = require('fs');

let sharp;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

const RATIOS = { '1:1': [1, 1], '4:5': [4, 5], '16:9': [16, 9] };
const RESIZE_PX = { '740': 740, '650': 650, '550': 550, '480': 480 };

let textCursor = 0; // 글자 리스트 순서 사용 커서
function resetTextCursor() { textCursor = 0; }

function pickResizeWidth(resize) {
  if (resize === 'original') return null;
  if (resize === 'random') { const o = [740, 650, 550, 480]; return o[Math.floor(Math.random() * o.length)]; }
  return RESIZE_PX[resize] || null;
}

function pickListText(list, mode) {
  if (!list || !list.length || mode === 'off') return null;
  if (mode === 'random') return list[Math.floor(Math.random() * list.length)];
  const t = list[textCursor % list.length]; textCursor = (textCursor + 1) % list.length; return t;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** SVG 글자 오버레이 레이어 */
function textSvg(width, height, items) {
  const texts = items.filter((t) => t && t.text).map((t, i) => {
    const y = height * (0.45 + i * 0.15);
    const stroke = t.outline ? 'stroke="#000" stroke-width="2" paint-order="stroke"' : '';
    const shadow = t.shadow ? 'filter="url(#sh)"' : '';
    const size = Number(t.size || 40) * 2;
    return `<text x="50%" y="${y}" text-anchor="middle" font-size="${size}" fill="#fff" ${stroke} ${shadow} font-family="Malgun Gothic, sans-serif" font-weight="bold">${escapeXml(t.text)}</text>`;
  }).join('');
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
       <defs><filter id="sh"><feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="#000"/></filter></defs>
       ${texts}</svg>`);
}

function randColor() {
  const h = Math.floor(Math.random() * 360);
  const c = 0.5, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = 0.4;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** 사진소스에 따라 베이스 sharp 인스턴스 생성 */
async function baseImage(srcPath, image) {
  const src = image.photoSource || 'saved';
  if (src === 'color') {
    return sharp({ create: { width: 1080, height: 1080, channels: 3, background: randColor() } });
  }
  if (src === 'download') {
    const res = await fetch('https://picsum.photos/1080/1080');
    if (!res.ok) throw new Error('자동 다운로드 실패 ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return sharp(buf, { failOn: 'none' });
  }
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error('이미지 파일 없음: ' + srcPath);
  return sharp(srcPath, { failOn: 'none' });
}

/**
 * @returns {Promise<string>} 처리된 파일 경로
 */
async function processImage(srcPath, outDir, image = {}, registration = {}) {
  if (!sharp) throw new Error('sharp 미설치: npm install 필요');
  fs.mkdirSync(outDir, { recursive: true });

  let img = await baseImage(srcPath, image);
  let meta = await img.metadata();
  if (!meta.width) { img = sharp(await img.png().toBuffer()); meta = await img.metadata(); }

  // 1) 비율 크롭
  const r = RATIOS[registration.ratio];
  if (r) {
    const target = r[0] / r[1], cur = meta.width / meta.height;
    let w = meta.width, h = meta.height;
    if (cur > target) w = Math.round(meta.height * target); else h = Math.round(meta.width / target);
    img = img.extract({ left: Math.round((meta.width - w) / 2), top: Math.round((meta.height - h) / 2), width: w, height: h });
  }

  // 2) 리사이즈
  const width = pickResizeWidth(image.resize || 'random');
  if (width) img = img.resize({ width });

  // 3) 필터
  if (image.filter && image.photoSource !== 'color') img = Math.random() < 0.5 ? img.grayscale() : img.blur(1.4);

  // 4) 테두리
  if (image.border && image.border.enabled) {
    const pad = Number(image.border.pad || 20);
    img = img.extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' });
  }

  // 5) 글자 오버레이 (글자 리스트 사용 시 글자1 텍스트 대체)
  const buf = await img.jpeg({ quality: 92 }).toBuffer();
  const m2 = await sharp(buf).metadata();
  const listText = pickListText(image.textList, image.textListMode || 'off');
  const items = [];
  const t1 = image.text1 || {};
  if (listText || t1.enabled) items.push({ text: listText || t1.text, size: t1.size, outline: t1.outline });
  const t2 = image.text2 || {};
  if (t2.enabled && t2.text) items.push({ text: t2.text, size: t2.size, shadow: t2.shadow });

  let finalBuf = buf;
  if (items.some((it) => it.text)) {
    finalBuf = await sharp(buf).composite([{ input: textSvg(m2.width, m2.height, items), top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
  }

  const outPath = path.join(outDir, `proc_${m2.width}x${m2.height}_${Math.floor(performance.now())}.jpg`);
  fs.writeFileSync(outPath, finalBuf);
  return outPath;
}

module.exports = { processImage, pickResizeWidth, resetTextCursor };
