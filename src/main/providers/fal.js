'use strict';
/**
 * fal.js — fal.ai 통합 게이트웨이 프로바이더 (이미지/영상)
 *
 * 단일 FAL_KEY 하나로 Nano Banana(Gemini 2.5 Flash Image)·Seedream V4·FLUX·Kling·Wan 등을 호출한다.
 * OpenAI gpt-image-1 / Sora-2 대비 이미지 3~8배, 영상 5~8배 저렴한 가성비 대안.
 * 연동 방식: fal 큐 REST API(https://queue.fal.run)를 fetch로 직접 호출 — 별도 SDK 의존성 불필요.
 *   1) POST https://queue.fal.run/{model} (Authorization: Key <FAL_KEY>) → { request_id, status_url, response_url }
 *   2) GET status_url 폴링 → status === 'COMPLETED'
 *   3) GET response_url → 결과 JSON(이미지 { images:[{url}] } / 영상 { video:{url} })
 *
 * 라이선스: fal.ai 호스티드 경유 생성물은 상업 이용 가능(FLUX dev 가중치 자체는 비상업이나 게이트웨이 출력물은 허용).
 * 참고: https://fal.ai/pricing · https://fal.ai/docs/documentation/setting-up/authentication
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const QUEUE_BASE = 'https://queue.fal.run';

// 추천 기본 모델. 상세페이지/마케팅 특화 우선(2026-07 fal 1차 페이지 검증).
const DEFAULT_IMAGE_MODEL = 'fal-ai/bytedance/seedream/v4/text-to-image';       // Seedream V4: 커머스/제품 이미지 특화 ($0.03/장)
const DEFAULT_IMAGE_EDIT_MODEL = 'fal-ai/gemini-25-flash-image/edit';           // Nano Banana edit: 제품사진 배경교체(아이덴티티 보존) ($0.039)
const DEFAULT_VIDEO_MODEL = 'fal-ai/bytedance/seedance/v1/pro/image-to-video';  // Seedance Pro: 제품 사진 애니메이션/마케팅 영상 특화 ($0.62/5s 1080p)
const DEFAULT_VIDEO_T2V_MODEL = 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video'; // 텍스트만 있을 때: Kling ($0.35/5s)

function requireKey(cfg) {
  const key = cfg && (cfg.falKey || cfg.apiKey);
  if (!key) throw new Error('fal.ai API 키(FAL_KEY)가 없습니다');
  return key;
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function tsName(prefix, ext) { return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
/** 로컬 이미지 파일 → data URI (fal image_url 입력용). 제품 사진 i2i/i2v에 사용. */
function fileToDataUri(filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('입력 제품 이미지 파일 없음: ' + filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'image/png';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

async function readError(res) {
  const t = await res.text().catch(() => '');
  return `${res.status}: ${t.slice(0, 300)}`;
}

/** "1024x1536" → { width, height }. 파싱 실패 시 null */
function parseSize(size) {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size || '').trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** W:H 근사 → 인스타 규격 aspect_ratio 문자열("1:1"|"4:5"|"9:16"|"16:9") */
function toAspectRatio(size) {
  const s = parseSize(size);
  if (!s) return '1:1';
  const r = s.width / s.height;
  if (r > 1.4) return '16:9';
  if (r < 0.7) return '9:16';
  if (r < 0.9) return '4:5';
  return '1:1';
}

/** 모델별 이미지 input 조립(스키마 차이 흡수). imageUrl 있으면 i2i(배경교체). cfg.falInput으로 override 가능. */
function buildImageInput(model, prompt, size, cfg, imageUrl) {
  const base = { prompt, num_images: 1 };
  const dims = parseSize(size);
  if (/seedream|flux|sdxl|stable-diffusion|recraft|ideogram/i.test(model)) {
    if (dims) base.image_size = dims;              // {width,height} 허용 계열
  } else {
    base.aspect_ratio = toAspectRatio(size);        // nano-banana/gemini/imagen 계열
  }
  if (imageUrl) {
    // edit/i2i 엔드포인트는 image_url(단수) 또는 image_urls(복수)를 받음 — 둘 다 실어 호환성 확보
    base.image_url = imageUrl;
    base.image_urls = [imageUrl];
  }
  return Object.assign(base, (cfg && cfg.falInput) || {});
}

/** 모델별 영상 input 조립. imageUrl 있으면 i2v(제품 사진 애니메이션). */
function buildVideoInput(model, prompt, size, seconds, cfg, imageUrl) {
  const base = {
    prompt,
    aspect_ratio: toAspectRatio(size),
    duration: String(seconds || 5),                 // Kling/Seedance: "5"|"10"
  };
  if (imageUrl) base.image_url = imageUrl;
  return Object.assign(base, (cfg && cfg.falVideoInput) || {});
}

async function submit(model, input, key) {
  const res = await fetch(`${QUEUE_BASE}/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('fal 제출 오류 ' + await readError(res));
  return res.json(); // { request_id, status_url, response_url, ... }
}

async function poll(job, key, { timeoutMs, intervalMs }) {
  const statusUrl = job.status_url;
  const deadline = Date.now() + Math.max(30000, Number(timeoutMs || 5 * 60 * 1000));
  let status = job.status || 'IN_QUEUE';
  while (status !== 'COMPLETED' && Date.now() < deadline) {
    await sleep(intervalMs || 3000);
    const res = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` } });
    if (!res.ok) throw new Error('fal 상태 조회 오류 ' + await readError(res));
    const data = await res.json();
    status = data.status;
    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error('fal 작업 실패: ' + JSON.stringify(data).slice(0, 200));
    }
  }
  if (status !== 'COMPLETED') throw new Error('fal 작업 시간 초과');
  const res = await fetch(job.response_url, { headers: { Authorization: `Key ${key}` } });
  if (!res.ok) throw new Error('fal 결과 조회 오류 ' + await readError(res));
  return res.json();
}

async function downloadTo(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('fal 파일 다운로드 오류 ' + await readError(res));
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

/** 결과 JSON에서 첫 이미지 URL 추출(모델별 응답 형태 흡수) */
function firstImageUrl(data) {
  if (data.images && data.images[0]) return data.images[0].url || data.images[0];
  if (data.image && (data.image.url || typeof data.image === 'string')) return data.image.url || data.image;
  return null;
}
function firstVideoUrl(data) {
  if (data.video && (data.video.url || typeof data.video === 'string')) return data.video.url || data.video;
  if (data.videos && data.videos[0]) return data.videos[0].url || data.videos[0];
  return null;
}

async function generateImage(cfg, payload = {}) {
  const key = requireKey(cfg);
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new Error('이미지 프롬프트가 없습니다');
  const outDir = payload.outDir;
  if (!outDir) throw new Error('이미지 저장 폴더가 없습니다');
  ensureDir(outDir);

  // 제품 사진이 있으면 i2i(배경교체) 모델로, 없으면 t2i 모델로.
  const imageUrl = payload.inputImagePath ? fileToDataUri(payload.inputImagePath) : null;
  const model = payload.model
    || (imageUrl ? (cfg.falImageEditModel || DEFAULT_IMAGE_EDIT_MODEL) : (cfg.falImageModel || DEFAULT_IMAGE_MODEL));
  const input = buildImageInput(model, prompt, payload.size || cfg.imageSize, cfg, imageUrl);
  const job = await submit(model, input, key);
  const data = await poll(job, key, { timeoutMs: payload.timeoutMs });

  const url = firstImageUrl(data);
  if (!url) throw new Error('fal 이미지 응답이 비어 있습니다: ' + JSON.stringify(data).slice(0, 200));
  const outPath = path.join(outDir, tsName('ai_image', 'png'));
  await downloadTo(url, outPath);
  return {
    type: 'image', source: 'fal', model, path: outPath,
    previewUrl: pathToFileURL(outPath).href, prompt,
  };
}

async function generateVideo(cfg, payload = {}) {
  const key = requireKey(cfg);
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new Error('영상 프롬프트가 없습니다');
  const outDir = payload.outDir;
  if (!outDir) throw new Error('영상 저장 폴더가 없습니다');
  ensureDir(outDir);

  // 제품 사진이 있으면 i2v(마케팅 특화·Seedance), 없으면 t2v(Kling).
  const imageUrl = payload.inputImagePath ? fileToDataUri(payload.inputImagePath) : null;
  const model = payload.model
    || (imageUrl ? (cfg.falVideoModel || DEFAULT_VIDEO_MODEL) : (cfg.falVideoT2vModel || DEFAULT_VIDEO_T2V_MODEL));
  const input = buildVideoInput(model, prompt, payload.size || cfg.videoSize, payload.seconds || cfg.videoSeconds, cfg, imageUrl);
  const job = await submit(model, input, key);
  const data = await poll(job, key, { timeoutMs: payload.timeoutMs || 10 * 60 * 1000, intervalMs: 5000 });

  const url = firstVideoUrl(data);
  if (!url) throw new Error('fal 영상 응답이 비어 있습니다: ' + JSON.stringify(data).slice(0, 200));
  const outPath = path.join(outDir, tsName('ai_video', 'mp4'));
  await downloadTo(url, outPath);
  return {
    type: 'video', source: 'fal', model, path: outPath,
    previewUrl: pathToFileURL(outPath).href, prompt,
  };
}

/** 키 유효성 간단 점검: 가장 싼 모델로 1x1 검증 대신, 잘못된 키면 401을 빠르게 받도록 status만 확인 */
async function testKey(cfg) {
  try {
    const key = requireKey(cfg);
    // 실제 생성은 과금되므로, 잘못된 키 판별용으로 존재하지 않는 request 상태 조회를 시도해 401 vs 404 구분
    const res = await fetch(`${QUEUE_BASE}/fal-ai/nano-banana/requests/health-check-probe/status`, {
      headers: { Authorization: `Key ${key}` },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'fal 키 인증 실패(401/403)' };
    return { ok: true, message: 'fal 키 형식 확인됨(실제 생성 시 과금)' };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}

module.exports = {
  generateImage, generateVideo, testKey,
  DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_EDIT_MODEL, DEFAULT_VIDEO_MODEL, DEFAULT_VIDEO_T2V_MODEL,
};
