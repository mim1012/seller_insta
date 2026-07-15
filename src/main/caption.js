'use strict';
/**
 * caption.js — 최종 캡션 조합
 *  - 본문 리스트 선택(순서/랜덤)
 *  - 문구 치환(substitution: from→to, to에 | 있으면 랜덤) + {A|B} 스핀택스 + {키} 변수
 *  - 태그 N개 삽입(최소~최대 랜덤)
 *  - 위치 선택(순서/랜덤)
 */

let cursor = { body: 0, tag: 0, loc: 0 };
function resetCursor() { cursor = { body: 0, tag: 0, loc: 0 }; }

function pick(list, mode, key) {
  if (!list || !list.length) return null;
  if (mode === 'random') return list[Math.floor(Math.random() * list.length)];
  const i = cursor[key] % list.length; cursor[key] = (cursor[key] + 1) % list.length; return list[i];
}

/** {A|B|C} 스핀택스 → 랜덤 */
function applySpintax(text) {
  return String(text).replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => { const o = g.split('|'); return o[Math.floor(Math.random() * o.length)]; });
}
/** {키} → map[키] */
function applyVars(text, map = {}) { return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m)); }

/** 문구 치환: [{from,to}] — from 모든 등장을 to(| 랜덤)로 교체 */
function applySubstitution(text, pairs) {
  let out = String(text);
  for (const p of (pairs || [])) {
    if (!p || !p.from) continue;
    const opts = String(p.to == null ? '' : p.to).split('|');
    out = out.split(p.from).join(opts[Math.floor(Math.random() * opts.length)]);
  }
  return out;
}

function randInt(min, max) {
  const a = Math.max(0, Number(min) || 0), b = Math.max(a, Number(max) || a);
  return a + Math.floor(Math.random() * (b - a + 1));
}

/**
 * @param {object} content { tags[], locations[], bodies[] }
 * @param {object} opt { bodyMode, tagMode, locMode, tagCountMin, tagCountMax, substitution, vars, gptText }
 * @returns {{caption, location}}
 */
function buildCaption(content, opt = {}) {
  const {
    bodyMode = 'random', tagMode = 'random', locMode = 'random',
    tagCountMin = 0, tagCountMax = 0, substitution = [], vars = {}, gptText = null,
  } = opt;

  let body = gptText != null ? gptText : (pick(content.bodies, bodyMode, 'body') || '');
  body = applyVars(applySpintax(applySubstitution(body, substitution)), vars);

  const tagCount = randInt(tagCountMin, tagCountMax);
  let tags = [];
  for (let i = 0; i < tagCount; i++) {
    const t = pick(content.tags, tagMode, 'tag');
    if (t) tags.push(t.startsWith('#') ? t : '#' + t);
  }
  tags = Array.from(new Set(tags));

  const caption = tags.length ? `${body}\n\n${tags.join(' ')}` : body;
  const location = pick(content.locations, locMode, 'loc');
  return { caption, location };
}

module.exports = { buildCaption, applySpintax, applyVars, applySubstitution, resetCursor };
