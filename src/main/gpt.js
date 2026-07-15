'use strict';
/**
 * gpt.js — OpenAI 기반 캡션/이미지/영상 생성
 * 용도: 본인 브랜드 게시물 캡션을 다양하게 생성. 사용자가 본인 API 키 입력.
 * (탐지회피용 무한 스피닝이 아니라, 콘텐츠 다양화 목적)
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const fal = require('./providers/fal');

// 미디어(이미지/영상) 프로바이더: 'openai'(기본) | 'fal'(가성비 게이트웨이)
function mediaProvider(cfg) { return (cfg && cfg.provider) || 'openai'; }

// 마케팅듀오 기능표의 지원 모델 목록(버전1~3)
const SUPPORTED_MODELS = [
  'gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo',
  'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini',
  'gpt-4.1-nano', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
];

const CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const VIDEO_ENDPOINT = 'https://api.openai.com/v1/videos';

function requireKey(cfg) {
  const apiKey = cfg && cfg.apiKey;
  if (!apiKey) throw new Error('GPT API 키가 없습니다');
  return apiKey;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function tsName(prefix, ext) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
}

async function readError(res) {
  const t = await res.text().catch(() => '');
  return `${res.status}: ${t.slice(0, 300)}`;
}

/**
 * @param {object} cfg { apiKey, model, prompt }
 * @param {string} baseText 원본/참고 본문(있으면 리라이트, 없으면 신규 생성)
 * @returns {Promise<string>} 생성된 캡션
 */
async function generateCaption(cfg, baseText = '') {
  const { apiKey, model = 'gpt-4o-mini', prompt = '비슷한 느낌으로 자연스럽게 다시 써줘' } = cfg || {};
  requireKey(cfg);
  if (!SUPPORTED_MODELS.includes(model)) throw new Error('지원하지 않는 모델: ' + model);

  const sys = '너는 인스타그램 브랜드 게시물 캡션 작가다. 한국어로 자연스럽고 간결하게 작성한다. 해시태그는 본문에 넣지 말고 캡션 텍스트만 출력한다.';
  const user = baseText
    ? `${prompt}\n\n[원본]\n${baseText}`
    : `${prompt}`;

  const res = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.9,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI 오류 ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('빈 응답');
  return text.trim();
}

/**
 * 텍스트 프롬프트로 이미지 생성 후 로컬 파일로 저장한다.
 * @param {object} cfg { apiKey, imageModel?, imageSize?, imageQuality? }
 * @param {object} payload { prompt, outDir }
 */
async function generateImage(cfg, payload = {}) {
  if (mediaProvider(cfg) === 'fal') return fal.generateImage(cfg, payload);
  const apiKey = requireKey(cfg);
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new Error('이미지 프롬프트가 없습니다');
  const outDir = payload.outDir;
  if (!outDir) throw new Error('이미지 저장 폴더가 없습니다');
  ensureDir(outDir);

  const res = await fetch(IMAGE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: cfg.imageModel || 'gpt-image-1',
      prompt,
      size: payload.size || cfg.imageSize || '1024x1024',
      quality: payload.quality || cfg.imageQuality || 'auto',
      output_format: 'png',
    }),
  });

  if (!res.ok) throw new Error('OpenAI 이미지 생성 오류 ' + await readError(res));
  const data = await res.json();
  const item = data.data && data.data[0];
  if (!item || !item.b64_json) throw new Error('이미지 생성 응답이 비어 있습니다');

  const outPath = path.join(outDir, tsName('ai_image', 'png'));
  fs.writeFileSync(outPath, Buffer.from(item.b64_json, 'base64'));
  return {
    type: 'image',
    source: 'ai',
    path: outPath,
    previewUrl: pathToFileURL(outPath).href,
    prompt,
    revisedPrompt: item.revised_prompt || '',
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, apiKey, options = {}) {
  const res = await fetch(url, Object.assign({}, options, {
    headers: Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, options.headers || {}),
  }));
  if (!res.ok) throw new Error('OpenAI 영상 생성 오류 ' + await readError(res));
  return res.json();
}

/**
 * 영상 생성은 비동기 작업이므로 생성 job을 만들고 완료까지 polling한 뒤 mp4로 저장한다.
 */
async function generateVideo(cfg, payload = {}) {
  if (mediaProvider(cfg) === 'fal') return fal.generateVideo(cfg, payload);
  const apiKey = requireKey(cfg);
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new Error('영상 프롬프트가 없습니다');
  const outDir = payload.outDir;
  if (!outDir) throw new Error('영상 저장 폴더가 없습니다');
  ensureDir(outDir);

  let job = await requestJson(VIDEO_ENDPOINT, apiKey, {
    method: 'POST',
    body: JSON.stringify({
      model: cfg.videoModel || 'sora-2',
      prompt,
      seconds: String(payload.seconds || cfg.videoSeconds || '4'),
      size: payload.size || cfg.videoSize || '720x1280',
    }),
  });

  const deadline = Date.now() + Math.max(60000, Number(payload.timeoutMs || 10 * 60 * 1000));
  while (job.status !== 'completed' && job.status !== 'failed' && Date.now() < deadline) {
    await sleep(5000);
    job = await requestJson(`${VIDEO_ENDPOINT}/${job.id}`, apiKey);
  }
  if (job.status !== 'completed') {
    const msg = job.error && job.error.message ? job.error.message : '완료되지 않음';
    throw new Error('영상 생성 실패: ' + msg);
  }

  const content = await fetch(`${VIDEO_ENDPOINT}/${job.id}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!content.ok) throw new Error('OpenAI 영상 다운로드 오류 ' + await readError(content));

  const outPath = path.join(outDir, tsName('ai_video', 'mp4'));
  fs.writeFileSync(outPath, Buffer.from(await content.arrayBuffer()));
  return {
    type: 'video',
    source: 'ai',
    path: outPath,
    previewUrl: pathToFileURL(outPath).href,
    prompt,
    videoId: job.id,
  };
}

async function generateDraft(cfg, payload = {}) {
  const out = { caption: '', asset: null };
  // 캡션은 텍스트 LLM(OpenAI) 담당. OpenAI 키가 없으면(예: fal 키만 보유) 캡션은 건너뛰고 미디어만 생성.
  if ((payload.captionPrompt || payload.baseText) && cfg && cfg.apiKey) {
    out.caption = await generateCaption(Object.assign({}, cfg, {
      prompt: payload.captionPrompt || cfg.prompt,
    }), payload.baseText || '');
  }
  if (payload.mediaType === 'video' || payload.mediaType === 'reel') {
    out.asset = await generateVideo(cfg, Object.assign({}, payload, { prompt: payload.videoPrompt || payload.imagePrompt }));
    out.asset.type = payload.mediaType;
  } else if (payload.imagePrompt) {
    out.asset = await generateImage(cfg, Object.assign({}, payload, { prompt: payload.imagePrompt }));
  }
  return out;
}

/** API 키/모델 유효성 간단 점검 */
async function testKey(cfg) {
  try {
    const c = await generateCaption(Object.assign({}, cfg, { prompt: '한 단어로 "확인"이라고만 답해줘' }), '');
    return { ok: true, message: '연결 성공: ' + c.slice(0, 30) };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}

/** fal.ai 게이트웨이 키 유효성 점검 */
function testFalKey(cfg) { return fal.testKey(cfg); }

/**
 * 텍스트 프롬프트로 이미지 N장을 생성한다(배치). SNS용으로 여러 후보를 뽑아 일부만 고르는 용도.
 * @returns {Promise<{assets: object[], errors: string[]}>}
 */
async function generateImages(cfg, payload = {}) {
  const count = Math.max(1, Math.min(Number(payload.count || 1), 10)); // 안전 상한 10장
  const assets = [];
  const errors = [];
  for (let i = 0; i < count; i++) {
    try {
      assets.push(await generateImage(cfg, payload));
    } catch (e) {
      errors.push(`${i + 1}번째 실패: ${String(e.message || e)}`);
    }
  }
  return { assets, errors };
}

module.exports = {
  generateCaption, generateImage, generateImages, generateVideo, generateDraft,
  testKey, testFalKey, SUPPORTED_MODELS,
  FAL_DEFAULT_IMAGE_MODEL: fal.DEFAULT_IMAGE_MODEL,
  FAL_DEFAULT_VIDEO_MODEL: fal.DEFAULT_VIDEO_MODEL,
};
