'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const MODELS = ['gpt-3.5-turbo','gpt-4','gpt-4-turbo','gpt-4o','gpt-4o-mini','gpt-4.1','gpt-4.1-mini','gpt-4.1-nano','gpt-5','gpt-5-mini','gpt-5-nano'];

let state = null;
let scope = 'global';
let selectedImage = null;
let aiDraft = null;
let lastAiPayload = null;

function setStatus(m) { $('#globalStatus').textContent = m; }
function logLine(m) { const el = $('#log'); el.textContent += m + '\n'; el.scrollTop = el.scrollHeight; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// deepMerge (계정별 오버라이드 병합 뷰)
function dm(base, over) {
  if (over == null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base == null) return over;
  const o = Object.assign({}, base);
  for (const k of Object.keys(over)) o[k] = dm(base[k], over[k]);
  return o;
}
function viewOf(sc) {
  const g = { content: state.content, image: state.image, registration: state.registration, work: state.work, imagePaths: state.imagePaths };
  if (sc === 'global') return JSON.parse(JSON.stringify(g));
  const ov = (state.accountSettings || {})[sc] || {};
  return {
    content: dm(g.content, ov.content), image: dm(g.image, ov.image),
    registration: dm(g.registration, ov.registration), work: dm(g.work, ov.work),
    imagePaths: ov.imagePaths || g.imagePaths,
  };
}
async function saveScoped(patch) { state = await window.api.updateScoped(scope, patch); }

// 탭
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $(`.panel[data-panel="${t.dataset.tab}"]`).classList.add('active');
}));

// ---- 렌더 ----
function renderScopeOptions() {
  const sel = $('#scope');
  const prev = scope;
  sel.innerHTML = '<option value="global">전체 기본</option>' +
    (state.accounts || []).map((a) => `<option value="${a.id}">${a.label} (${a.igId || '-'})</option>`).join('');
  sel.value = (state.accounts || []).some((a) => a.id === prev) || prev === 'global' ? prev : 'global';
  scope = sel.value;
}
function renderAccounts() {
  const body = $('#accBody'); body.innerHTML = '';
  (state.accounts || []).forEach((a) => {
    const pill = a.sessionStatus === 'loggedIn' ? '<span class="pill ok">로그인</span>'
      : a.sessionStatus === 'expired' ? '<span class="pill no">만료</span>' : '<span class="pill un">미확인</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" class="accSel" value="${a.id}"></td>
      <td>${esc(a.igId || '-')}</td><td>${esc(a.label)}</td>
      <td><input class="proxyEdit" data-proxy="${a.id}" value="${esc(a.proxy || '')}" placeholder="host:port" style="width:150px"/><button data-save-proxy="${a.id}">저장</button></td>
      <td>${pill}</td>
      <td class="prog" data-prog="${a.id}" style="font-size:11px;color:#555"></td>
      <td><button data-login="${a.id}">로그인</button><button data-check="${a.id}">세션</button><button data-del="${a.id}">삭제</button></td>`;
    body.appendChild(tr);
  });
}
function renderLists(v) {
  const map = { listTags: 'tags', listLoc: 'locations', listBody: 'bodies' };
  for (const [el, key] of Object.entries(map)) {
    $('#' + el).innerHTML = (v.content[key] || []).map((x, i) => `<div style="padding:2px 4px;border-bottom:1px solid #eee">${i + 1}. ${String(x).slice(0, 60)}</div>`).join('');
  }
  $('#subList').innerHTML = (v.registration.substitution || []).map((p) => `<div style="padding:2px 4px">${p.from} → ${p.to}</div>`).join('');
  $('#subInfo').textContent = (v.registration.substitution || []).length ? `${v.registration.substitution.length}개` : '';
}
function setRadio(name, val) { const el = $$(`input[name=${name}]`).find((x) => x.value === String(val)); if (el) el.checked = true; }
function mediaTypeOfPath(filePath) {
  return /\.(mp4|mov)$/i.test(String(filePath || '')) ? 'video' : 'image';
}
function renderAiDraft(draft) {
  aiDraft = draft || null;
  const media = $('#aiMediaPreview');
  const caption = draft && draft.caption ? draft.caption : '';
  $('#aiCaptionPreview').value = caption;
  media.innerHTML = '미리보기';
  if (draft && draft.asset && draft.asset.previewUrl) {
    if (draft.asset.type === 'video' || draft.asset.type === 'reel') {
      media.innerHTML = `<video controls src="${esc(draft.asset.previewUrl)}"></video>`;
    } else {
      media.innerHTML = `<img src="${esc(draft.asset.previewUrl)}" alt="AI generated preview"/>`;
    }
  }
  $('#aiInfo').textContent = draft && draft.asset ? draft.asset.path : '';
}

function loadUI() {
  const v = viewOf(scope), i = v.image, r = v.registration, w = v.work, g = state.gpt;
  setRadio('psrc', i.photoSource);
  $('#imageMode').value = w.imageMode;
  $('#t1').checked = i.text1.enabled; $('#t1text').value = i.text1.text || ''; $('#t1size').value = i.text1.size || 40; $('#t1outline').checked = i.text1.outline;
  $('#t2').checked = i.text2.enabled; $('#t2text').value = i.text2.text || ''; $('#t2size').value = i.text2.size || 40; $('#t2shadow').checked = i.text2.shadow;
  $('#tlMode').value = i.textListMode || 'off'; $('#tlInfo').textContent = (i.textList || []).length ? `${i.textList.length}개` : '';
  $('#flt').checked = i.filter; $('#brd').checked = i.border.enabled; $('#brdpad').value = i.border.pad || 24;
  setRadio('rs', i.resize);
  setRadio('ratio', r.ratio);
  $('#addLoc').checked = r.addLocation; $('#hideLikes').checked = r.hideLikes; $('#noComments').checked = r.disableComments; $('#threads').checked = r.shareThreads;
  $('#altText').value = r.altText || '';
  $('#tagMin').value = w.tagCountMin; $('#tagMax').value = w.tagCountMax;
  $('#cnt').value = w.perAccountCount; $('#dmin').value = w.delayMin; $('#dmax').value = w.delayMax;
  $('#bodyMode').value = w.bodyMode; $('#tagMode').value = w.tagMode; $('#locMode').value = w.locMode;
  $('#gptOn').checked = g.enabled; $('#gptKey').value = g.apiKey || ''; $('#gptModel').value = g.model || 'gpt-4o-mini'; $('#gptPrompt').value = g.prompt || '';
  $('#mediaProvider').value = g.provider || 'openai';
  $('#falKey').value = g.falKey || '';
  $('#falImageModel').value = g.falImageModel || 'fal-ai/bytedance/seedream/v4/text-to-image';
  $('#falImageEditModel').value = g.falImageEditModel || 'fal-ai/gemini-25-flash-image/edit';
  $('#falVideoModel').value = g.falVideoModel || 'fal-ai/bytedance/seedance/v1/pro/image-to-video';
  $('#falVideoT2vModel').value = g.falVideoT2vModel || 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video';
  $('#aiCount').value = g.aiImageCount || 4;
  toggleFalRows();
  $('#imgInfo').textContent = (v.imagePaths || []).length ? `미디어 묶음: ${v.imagePaths.length}개` : '';
  const tether = (state.network && state.network.tether) || {};
  $('#tetherOn').checked = !!tether.enabled;
  $('#tetherBeforeAcc').checked = !!tether.beforeEachAccount;
  $('#adbSerial').value = tether.adbSerial || '';
  $('#tetherWait').value = tether.waitSeconds || 8;
  renderLists(v);
  updateScopeIndicator();
  updatePreflight();
}

function updateScopeIndicator() {
  const bar = $('.scopebar'); const info = $('#scopeOverride');
  if (!bar) return;
  if (scope === 'global') { bar.style.background = '#e9eef5'; if (info) info.textContent = ''; return; }
  const ov = (state.accountSettings || {})[scope] || {};
  const names = { content: '내용', image: '이미지', registration: '등록', work: '작업', imagePaths: '이미지묶음' };
  const keys = Object.keys(ov).filter((k) => {
    const val = ov[k];
    return val && (Array.isArray(val) ? val.length : typeof val === 'object' ? Object.keys(val).length : true);
  });
  bar.style.background = '#fff7d6';
  if (info) info.textContent = keys.length ? `● 이 계정 전용 재정의: ${keys.map((k) => names[k] || k).join(', ')}` : '● 전체 기본과 동일(재정의 없음)';
}

function updatePreflight() {
  const box = $('#preflight'); if (!box || !state) return;
  const v = viewOf(scope);
  const accSel = selectedAccountIds().length;
  const src = ($$('input[name=psrc]').find((x) => x.checked) || {}).value || 'saved';
  const needImages = src === 'saved';
  const imgs = (v.imagePaths || []).length;
  const bodies = (v.content.bodies || []).length;
  const gptOn = !!(state.gpt && state.gpt.enabled);
  const badge = (ok, label) => `<span class="pf ${ok ? 'pf-ok' : 'pf-no'}">${ok ? '✓' : '!'} ${esc(label)}</span>`;
  const parts = [
    badge(accSel > 0, accSel > 0 ? `계정 ${accSel}개 선택` : '계정 미선택'),
    needImages
      ? badge(imgs > 0, imgs > 0 ? `이미지 ${imgs}개` : '이미지 없음(불러오기 필요)')
      : `<span class="pf pf-info">사진소스: ${esc(src === 'color' ? '색상' : '자동 다운로드')}</span>`,
    badge(bodies > 0 || gptOn, bodies > 0 ? `본문 ${bodies}개` : (gptOn ? '본문 GPT 생성' : '본문 없음')),
    `<span class="pf pf-info">GPT ${gptOn ? '켜짐' : '꺼짐'}</span>`,
  ];
  box.innerHTML = '<span class="lbl">발행 준비:</span> ' + parts.join(' ');
}

async function refresh() { state = await window.api.getState(); renderScopeOptions(); renderAccounts(); loadUI(); updatePreflight(); }

function collect() {
  const image = {
    photoSource: ($$('input[name=psrc]').find((x) => x.checked) || {}).value || 'saved',
    text1: { enabled: $('#t1').checked, text: $('#t1text').value, size: Number($('#t1size').value), outline: $('#t1outline').checked },
    text2: { enabled: $('#t2').checked, text: $('#t2text').value, size: Number($('#t2size').value), shadow: $('#t2shadow').checked },
    textListMode: $('#tlMode').value,
    filter: $('#flt').checked,
    border: { enabled: $('#brd').checked, width: 1, pad: Number($('#brdpad').value) },
    resize: ($$('input[name=rs]').find((x) => x.checked) || {}).value || 'random',
  };
  const registration = {
    ratio: ($$('input[name=ratio]').find((x) => x.checked) || {}).value || '1:1',
    addLocation: $('#addLoc').checked, hideLikes: $('#hideLikes').checked,
    disableComments: $('#noComments').checked, shareThreads: $('#threads').checked, altText: $('#altText').value,
  };
  const work = {
    perAccountCount: Number($('#cnt').value), delayMin: Number($('#dmin').value), delayMax: Number($('#dmax').value),
    imageMode: $('#imageMode').value, tagCountMin: Number($('#tagMin').value), tagCountMax: Number($('#tagMax').value),
    bodyMode: $('#bodyMode').value, tagMode: $('#tagMode').value, locMode: $('#locMode').value,
  };
  const network = {
    tether: {
      enabled: $('#tetherOn').checked,
      beforeEachAccount: $('#tetherBeforeAcc').checked,
      adbSerial: $('#adbSerial').value.trim(),
      waitSeconds: Math.max(1, Number($('#tetherWait').value) || 8),
    },
  };
  return Promise.all([
    saveScoped({ image, registration, work }),
    window.api.updateState({ network, gpt: Object.assign({}, state.gpt || {}, {
      enabled: $('#gptOn').checked, apiKey: $('#gptKey').value, model: $('#gptModel').value, prompt: $('#gptPrompt').value,
      provider: $('#mediaProvider').value, falKey: $('#falKey').value,
      falImageModel: $('#falImageModel').value, falImageEditModel: $('#falImageEditModel').value,
      falVideoModel: $('#falVideoModel').value, falVideoT2vModel: $('#falVideoT2vModel').value,
      aiImageCount: Number($('#aiCount').value) || 4,
    }) }),
  ]);
}
function selectedAccountIds() { return $$('.accSel').filter((c) => c.checked).map((c) => c.value); }

// ---- 이벤트 ----
$('#scope').addEventListener('change', (e) => { scope = e.target.value; loadUI(); setStatus('설정 대상: ' + e.target.selectedOptions[0].textContent); });
$('#btnSave').addEventListener('click', async () => { await collect(); await refresh(); setStatus('세팅 저장됨'); });
$('#btnReset').addEventListener('click', async () => {
  if (!confirm('전체 설정을 초기화합니다. 모든 계정별 설정과 목록이 사라지며 되돌릴 수 없습니다. 계속할까요?')) return;
  state = await window.api.resetState(); scope = 'global'; await refresh(); setStatus('전체 초기화됨');
});

$('#btnAddAcc').addEventListener('click', async () => {
  const igId = $('#accId').value.trim(); if (!igId) return setStatus('인스타 id를 입력하세요');
  await window.api.addAccount({ igId, pw: $('#accPw').value, proxy: $('#accProxy').value.trim(), label: $('#accLabel').value.trim() });
  $('#accId').value = $('#accPw').value = $('#accProxy').value = $('#accLabel').value = '';
  setStatus('계정 등록됨(비번 암호화). [로그인]으로 자동 로그인'); await refresh();
});
$('#btnLoadAcc').addEventListener('click', async () => { const r = await window.api.loadAccountFile(); await refresh(); setStatus(`계정 ${r.added || 0}개 추가됨`); });
$('#btnSelAll').addEventListener('click', () => { const all = $$('.accSel'); const on = all.some((c) => !c.checked); all.forEach((c) => (c.checked = on)); updatePreflight(); });
$('#accBody').addEventListener('change', (e) => { if (e.target.classList.contains('accSel')) updatePreflight(); });
$$('input[name=psrc]').forEach((r) => r.addEventListener('change', updatePreflight));

$('#accBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.login) { setStatus('로그인 브라우저 여는 중...'); const r = await window.api.loginAccount(b.dataset.login); setStatus(r.message); await refresh(); }
  if (b.dataset.check) { setStatus('세션 확인 중...'); const r = await window.api.checkAccount(b.dataset.check); setStatus(r.message); await refresh(); }
  if (b.dataset.saveProxy) {
    const input = $(`input[data-proxy="${b.dataset.saveProxy}"]`);
    await window.api.setProxy({ id: b.dataset.saveProxy, proxy: input ? input.value : '' });
    setStatus('프록시 저장됨'); await refresh();
  }
  if (b.dataset.del) {
    if (!confirm('이 계정을 삭제할까요? 저장된 세션·계정별 설정도 함께 제거됩니다.')) return;
    await window.api.removeAccount(b.dataset.del); await refresh();
  }
});

$('#btnAdbDevices').addEventListener('click', async () => {
  try {
    const r = await window.api.adbDevices();
    $('#tetherInfo').textContent = r.devices.length ? r.devices.map((d) => `${d.serial}(${d.status})`).join(', ') : '연결된 기기 없음';
  } catch (err) { $('#tetherInfo').textContent = 'ADB 확인 실패: ' + (err.message || err); }
});
$('#btnTetherNow').addEventListener('click', async () => {
  await collect();
  setStatus('모바일 데이터 재연결 중...');
  try {
    const r = await window.api.resetMobileData();
    setStatus(r.message || '모바일 데이터 재연결 완료');
  } catch (err) { setStatus('❌ ' + (err.message || err)); }
});

$$('button[data-add]').forEach((b) => b.addEventListener('click', async () => {
  const key = b.dataset.add; const input = { tags: '#inTag', locations: '#inLoc', bodies: '#inBody' }[key];
  const val = $(input).value.trim(); if (!val) return;
  const v = viewOf(scope); const arr = (v.content[key] || []).concat(val);
  await saveScoped({ content: Object.assign({}, v.content, { [key]: arr }) });
  $(input).value = ''; loadUI();
}));
$$('button[data-clear]').forEach((b) => b.addEventListener('click', async () => {
  const key = b.dataset.clear; const v = viewOf(scope);
  await saveScoped({ content: Object.assign({}, v.content, { [key]: [] }) }); loadUI();
}));
$('#btnBodyFolder').addEventListener('click', async () => {
  const v = viewOf(scope); const bodies = await window.api.loadBodiesFolder(v.content.bodies || []);
  if (bodies) { await saveScoped({ content: Object.assign({}, v.content, { bodies }) }); loadUI(); setStatus(`본문 ${bodies.length}개`); }
});

$('#btnPickFolder').addEventListener('click', async () => { const files = await window.api.pickImageFolder(scope); await refresh(); setStatus(`미디어 ${files.length}개`); });
$('#btnTextList').addEventListener('click', async () => {
  const list = await window.api.loadTextList(); if (!list) return;
  const v = viewOf(scope); await saveScoped({ image: Object.assign({}, v.image, { textList: list }) }); loadUI(); setStatus(`글자 리스트 ${list.length}개`);
});

$('#btnSubFile').addEventListener('click', async () => {
  const sub = await window.api.loadSubstitution(); if (!sub) return;
  const v = viewOf(scope); await saveScoped({ registration: Object.assign({}, v.registration, { substitution: sub }) }); loadUI(); setStatus(`치환 ${sub.length}개`);
});
$('#btnSubClear').addEventListener('click', async () => { const v = viewOf(scope); await saveScoped({ registration: Object.assign({}, v.registration, { substitution: [] }) }); loadUI(); });

$('#btnGptTest').addEventListener('click', async () => {
  setStatus('GPT 키 테스트...'); const r = await window.api.gptTest({ apiKey: $('#gptKey').value, model: $('#gptModel').value, prompt: '확인' });
  setStatus((r.ok ? '✅ ' : '❌ ') + r.message);
});

function toggleFalRows() {
  const isFal = $('#mediaProvider').value === 'fal';
  $('#falRow').style.display = isFal ? '' : 'none';
  $('#falModelRow').style.display = isFal ? '' : 'none';
  $('#falEditModelRow').style.display = isFal ? '' : 'none';
}
$('#mediaProvider').addEventListener('change', toggleFalRows);
$('#btnFalTest').addEventListener('click', async () => {
  setStatus('fal 키 테스트...');
  const r = await window.api.falTest({ falKey: $('#falKey').value });
  setStatus((r.ok ? '✅ ' : '❌ ') + r.message);
});

let aiProductPhoto = null; // 제품 사진 경로(있으면 i2i/i2v로 전환)

async function buildAiPayload() {
  await collect();
  const v = viewOf(scope);
  return {
    mediaType: $('#aiMediaType').value,
    captionPrompt: $('#aiCaptionPrompt').value.trim() || $('#gptPrompt').value.trim(),
    imagePrompt: $('#aiImagePrompt').value.trim(),
    videoPrompt: $('#aiImagePrompt').value.trim(),
    baseText: (v.content.bodies || [])[0] || '',
    size: $('#aiMediaType').value === 'image' ? $('#aiImageSize').value : '720x1280',
    seconds: $('#aiVideoSeconds').value,
    count: Math.max(1, Math.min(Number($('#aiCount').value) || 1, 10)),
    inputImagePath: aiProductPhoto || undefined,
  };
}

let aiGallery = []; // 생성된 후보 [{ asset, sel }]
function renderAiGallery() {
  const box = $('#aiGallery');
  box.innerHTML = '';
  aiGallery.forEach((it, idx) => {
    const div = document.createElement('div');
    div.className = 'galleryItem' + (it.sel ? ' sel' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = it.sel;
    cb.addEventListener('change', () => { it.sel = cb.checked; renderAiGallery(); });
    const img = document.createElement('img');
    img.src = it.asset.previewUrl; img.title = it.asset.model || '';
    img.addEventListener('click', () => { it.sel = !it.sel; renderAiGallery(); });
    div.appendChild(cb); div.appendChild(img);
    box.appendChild(div);
  });
  const selCount = aiGallery.filter((x) => x.sel).length;
  $('#aiGalleryInfo').textContent = aiGallery.length ? `후보 ${aiGallery.length}장 · 선택 ${selCount}장` : '';
}

$('#btnAiProductPhoto').addEventListener('click', async () => {
  const p = await window.api.pickImage();
  if (!p) return;
  aiProductPhoto = p;
  $('#aiProductInfo').textContent = '제품 사진 첨부됨 → 배경교체/영상 모드';
});

$('#btnAiBatch').addEventListener('click', async () => {
  try {
    const payload = await buildAiPayload();
    if (!payload.imagePrompt) return setStatus('이미지 프롬프트(텍스트)를 입력하세요');
    setStatus(`이미지 ${payload.count}장 생성 중...`);
    $('#aiInfo').textContent = '생성 중...';
    const r = await window.api.generateImages(payload);
    const assets = (r && r.assets) || [];
    aiGallery = assets.map((a) => ({ asset: a, sel: true }));
    renderAiGallery();
    const errN = (r && r.errors && r.errors.length) || 0;
    $('#aiInfo').textContent = `생성 완료: ${assets.length}장${errN ? ` (실패 ${errN})` : ''}`;
    setStatus(assets.length ? '후보 생성 완료. 체크한 것만 업로드 목록에 추가하세요' : '생성 실패: ' + ((r.errors || [])[0] || ''));
  } catch (err) { setStatus('❌ ' + (err.message || err)); $('#aiInfo').textContent = String(err.message || err); }
});

$('#btnAiSelectAll').addEventListener('click', () => { aiGallery.forEach((x) => { x.sel = true; }); renderAiGallery(); });
$('#btnAiSelectNone').addEventListener('click', () => { aiGallery.forEach((x) => { x.sel = false; }); renderAiGallery(); });
$('#btnAiAddSelected').addEventListener('click', async () => {
  const chosen = aiGallery.filter((x) => x.sel).map((x) => x.asset);
  if (!chosen.length) return setStatus('추가할 후보를 체크하세요');
  state = await window.api.selectDrafts({ target: scope, assets: chosen });
  await refresh();
  setStatus(`${chosen.length}장을 업로드 목록에 추가했습니다`);
});

$('#btnAiGenerate').addEventListener('click', async () => {
  try {
    lastAiPayload = await buildAiPayload();
    if (!lastAiPayload.captionPrompt && !lastAiPayload.imagePrompt) return setStatus('AI 글쓰기 또는 미디어 프롬프트를 입력하세요');
    setStatus('AI 생성 중...');
    $('#aiInfo').textContent = '생성 중...';
    const draft = await window.api.generateDraft(lastAiPayload);
    renderAiDraft(draft);
    setStatus('AI 생성 완료. 미리보기 확인 후 선택하세요');
  } catch (err) { setStatus('❌ ' + (err.message || err)); $('#aiInfo').textContent = String(err.message || err); }
});
$('#btnAiRegenerate').addEventListener('click', async () => {
  try {
    lastAiPayload = lastAiPayload || await buildAiPayload();
    setStatus('다시 생성 중...');
    $('#aiInfo').textContent = '다시 생성 중...';
    const draft = await window.api.generateDraft(lastAiPayload);
    renderAiDraft(draft);
    setStatus('재생성 완료');
  } catch (err) { setStatus('❌ ' + (err.message || err)); $('#aiInfo').textContent = String(err.message || err); }
});
$('#btnAttachMedia').addEventListener('click', async () => {
  const asset = await window.api.pickMedia();
  if (!asset) return;
  renderAiDraft({ caption: $('#aiCaptionPreview').value || $('#caption').value, asset });
  setStatus('로컬 미디어 첨부됨. 선택하면 업로드 목록에 추가됩니다');
});
$('#btnAiUse').addEventListener('click', async () => {
  if (!aiDraft || (!aiDraft.asset && !$('#aiCaptionPreview').value.trim())) return setStatus('선택할 AI 결과가 없습니다');
  const cap = $('#aiCaptionPreview').value.trim();
  if (cap) $('#caption').value = cap;
  if (aiDraft.asset && aiDraft.asset.path) {
    selectedImage = aiDraft.asset.path;
    state = await window.api.selectDraft({ target: scope, asset: aiDraft.asset });
    await refresh();
    setStatus(`${mediaTypeOfPath(selectedImage) === 'video' ? '영상' : '이미지'} 선택됨. 단일/배치 업로드에 사용됩니다`);
  } else {
    setStatus('글 선택됨');
  }
});

function updateAccountProgress(e) {
  if (!e || !e.account) return;
  const cell = $(`td[data-prog="${e.account}"]`);
  if (!cell) return;
  cell.textContent = String(e.stage || '');
  cell.style.color = e.ok === true ? '#137a13' : e.ok === false ? '#a11' : '#555';
  cell.style.fontWeight = (e.ok === true || e.ok === false) ? 'bold' : 'normal';
}
window.api.onWorkEvent((e) => { logLine(`[${e.label || ''}] ${e.stage}`); updateAccountProgress(e); });

$('#btnPostNow').addEventListener('click', async () => {
  await collect();
  const id = selectedAccountIds()[0]; if (!id) return setStatus('계정 1개를 체크하세요');
  let img = selectedImage;
  if (!img) {
    const picked = await window.api.pickMedia();
    if (!picked) return setStatus('미디어를 선택하세요');
    img = picked.path;
  }
  $('#log').textContent = ''; setStatus('발행 시작...');
  const v = viewOf(scope);
  const r = await window.api.postNow({ accountId: id, imagePath: img, caption: $('#caption').value, options: {
    addLocation: $('#addLoc').checked, locationQuery: (v.content.locations || [])[0] || '',
    altText: $('#altText').value, hideLikes: $('#hideLikes').checked, disableComments: $('#noComments').checked, shareThreads: $('#threads').checked,
  } });
  setStatus(r.ok ? '✅ ' + r.message : '❌ ' + r.message);
});

$('#btnStart').addEventListener('click', async () => {
  await collect();
  const accountIds = selectedAccountIds(); if (!accountIds.length) return setStatus('계정을 체크하세요(다중 가능)');
  $('#log').textContent = ''; setStatus('작업 시작...');
  const r = await window.api.workStart({ accountIds });
  if (r.ok) { const s = r.summary; setStatus(`완료: 성공 ${s.ok} / 실패 ${s.fail}${s.stopped ? ' (중단)' : ''}`); }
  else setStatus('❌ ' + r.message);
});
$('#btnStop').addEventListener('click', async () => { await window.api.workStop(); setStatus('정지 요청됨(현재 작업 후 중단)'); });

MODELS.forEach((m) => { const o = document.createElement('option'); o.value = o.textContent = m; $('#gptModel').appendChild(o); });

refresh();
