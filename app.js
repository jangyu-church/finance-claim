/* 장유중앙교회 재정청구 — 앱 화면 동작 */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const CONF = window.APP_CONFIG || {};
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('fc_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('fc_' + k, JSON.stringify(v)); } catch {} },
  };
  const DEFAULTS = {
    departments: ['교육부', '선교부', '찬양부', '봉사부', '친교부', '관리부', '청년부', '여전도회', '남선교회', '기타'],
    accounts: ['교육비', '선교비', '행사비', '식대·다과', '교통·차량비', '비품·소모품', '인쇄·홍보비', '경조비', '시설관리비', '기타'],
  };

  const won = n => (Number(n) || 0).toLocaleString('ko-KR') + '원';
  const digits = s => String(s || '').replace(/[^\d]/g, '');
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ───────── 서버 통신 ───────── */
  const apiUrl = () => (LS.get('api', '') || CONF.API_URL || '').trim();
  const accessCode = () => (LS.get('code', '') || '').trim();

  async function api(action, payload = {}) {
    const url = apiUrl();
    if (!url) throw new Error('서버 주소가 설정되지 않았습니다. 재정부에 문의해 주세요.');
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 사전요청(CORS preflight) 없이 보내기 위함
        body: JSON.stringify({ action, code: accessCode(), ...payload }),
        redirect: 'follow',
      });
    } catch {
      throw new Error('인터넷 연결을 확인해 주세요.');
    }
    let data;
    try { data = await res.json(); } catch { throw new Error('서버 응답을 읽을 수 없습니다. (웹 앱 배포 설정 확인)'); }
    if (!data.ok) {
      const err = new Error(data.error || '요청에 실패했습니다.');
      err.authError = !!data.authError;
      throw err;
    }
    return data;
  }

  /* ───────── 화면 전환 ───────── */
  function go(view) {
    if (view === 'claim' && !accessCode()) { openSettings('먼저 교회 접근 코드를 입력해 주세요.'); return; }
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    document.body.dataset.view = view;
    window.scrollTo(0, 0);
    if (view === 'home') renderHistory();
    if (view === 'claim' && !state.items.length) fillClaimant();
    if (location.hash.slice(1) !== view) history.pushState(null, '', '#' + view);
  }
  window.addEventListener('popstate', () => {
    const v = location.hash.slice(1) || 'home';
    $$('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + (v === 'done' ? 'home' : v)));
    document.body.dataset.view = v;
    if (v === 'home') renderHistory();
  });
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-go]');
    if (t) { e.preventDefault(); go(t.dataset.go); }
  });

  /* ───────── 토스트 / 로딩 ───────── */
  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function busy(on, msg) {
    $('#overlayMsg').textContent = msg || '처리 중…';
    $('#overlay').classList.toggle('show', !!on);
  }

  /* ───────── 설정 / 앱 구성 ───────── */
  let appConfig = LS.get('config', DEFAULTS);

  function applyConfig() {
    const name = appConfig.churchName || CONF.CHURCH_NAME || '';
    $('#churchName').textContent = name;
    const sel = $('#fDept'), cur = sel.value;
    sel.innerHTML = '<option value="">선택</option>' + (appConfig.departments || DEFAULTS.departments).map(d => `<option>${esc(d)}</option>`).join('');
    if (cur) sel.value = cur;
  }
  async function refreshConfig() {
    if (!apiUrl() || !accessCode()) return;
    try {
      const c = await api('config');
      appConfig = { churchName: c.churchName, departments: c.departments, accounts: c.accounts };
      LS.set('config', appConfig);
      applyConfig();
      $$('.iAccount').forEach(s => fillAccounts(s, s.value));
    } catch (e) {
      if (e.authError) { LS.set('code', ''); openSettings('접근 코드가 바뀌었습니다. 새 코드를 입력해 주세요.'); }
    }
  }

  function openSettings(msg) {
    $('#sCode').value = accessCode();
    $('#sApi').value = LS.get('api', '');
    $('#advanced').open = !CONF.API_URL && !LS.get('api', '');
    $('#sMsg').textContent = msg || '';
    $('#sMsg').className = 'msg';
    $('#dlgSettings').showModal();
  }
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#btnSaveSettings').addEventListener('click', async e => {
    e.preventDefault();
    const code = $('#sCode').value.trim(), api_ = $('#sApi').value.trim();
    if (api_ && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(api_)) {
      $('#sMsg').textContent = '웹 앱 주소는 https://script.google.com/macros/s/…/exec 형식이어야 합니다.';
      $('#sMsg').className = 'msg err'; return;
    }
    if (!code) { $('#sMsg').textContent = '접근 코드를 입력해 주세요.'; $('#sMsg').className = 'msg err'; return; }
    LS.set('code', code); LS.set('api', api_);
    $('#sMsg').textContent = '연결 확인 중…'; $('#sMsg').className = 'msg';
    try {
      await api('ping');
      await refreshConfig();
      $('#dlgSettings').close();
      toast('연결되었습니다 ✓');
    } catch (err) {
      $('#sMsg').textContent = err.message; $('#sMsg').className = 'msg err';
    }
  });

  /* ───────── 바탕화면 설치 (common.js) ───────── */
  FC.setupInstall(toast);
  FC.registerSW();

  /* ───────── 청구자 정보 ───────── */
  const claimantFields = { name: '#fName', dept: '#fDept', phone: '#fPhone', bank: '#fBank', account: '#fAccount', holder: '#fHolder' };
  function fillClaimant() {
    const saved = LS.get('claimant', {});
    Object.entries(claimantFields).forEach(([k, sel]) => { if (saved[k] && !$(sel).value) $(sel).value = saved[k]; });
  }
  function readClaimant() {
    const o = {};
    Object.entries(claimantFields).forEach(([k, sel]) => { o[k] = $(sel).value.trim(); });
    if (!o.holder) o.holder = o.name;
    return o;
  }

  /* ───────── 청구 항목 ───────── */
  const state = { items: [], seq: 0, queue: Promise.resolve() };

  function fillAccounts(sel, value) {
    sel.innerHTML = '<option value="">선택</option>' + (appConfig.accounts || DEFAULTS.accounts).map(a => `<option>${esc(a)}</option>`).join('');
    if (value) sel.value = value;
  }

  function addItem(kind, imageData, thumb) {
    const item = { id: ++state.seq, kind, image: imageData || null, thumb: thumb || null, fileId: null,
                   status: kind === 'photo' ? 'pending' : 'manual', amount: 0, ocrAmount: 0, candidates: [],
                   date: kind === 'manual' ? today() : '', store: '', account: '', desc: '', reason: '' };
    state.items.push(item);

    const el = $('#tplItem').content.firstElementChild.cloneNode(true);
    el.dataset.id = item.id;
    item.el = el;
    if (kind === 'photo') {
      $('.thumb img', el).src = thumb;
      $('.thumb', el).addEventListener('click', () => showImage(item));
      $('.reason', el).remove();
    } else {
      $('.thumb', el).classList.add('none');
      $('.thumb', el).innerHTML = '<span>영수증<br>없음</span>';
    }
    fillAccounts($('.iAccount', el), LS.get('lastAccount', ''));
    item.account = $('.iAccount', el).value;
    $('.iDate', el).value = item.date;
    $('.iDate', el).max = today();

    const amt = $('.iAmount', el);
    amt.addEventListener('input', () => {
      const v = digits(amt.value).slice(0, 9);
      item.amount = Number(v) || 0;
      amt.value = v ? Number(v).toLocaleString('ko-KR') : '';
      markChips(item); updateTotal();
    });
    const bind = (cls, key) => $(cls, el)?.addEventListener('input', e => { item[key] = e.target.value; if (key === 'account') LS.set('lastAccount', item.account); });
    bind('.iDate', 'date'); bind('.iStore', 'store'); bind('.iDesc', 'desc'); bind('.iReason', 'reason');
    $('.iAccount', el).addEventListener('change', e => { item.account = e.target.value; LS.set('lastAccount', item.account); });
    $('.del', el).addEventListener('click', () => removeItem(item));

    $('#items').appendChild(el);
    renumber(); setBadge(item); updateTotal();
    if (kind === 'manual') { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => amt.focus(), 300); }
    return item;
  }

  function removeItem(item) {
    if ((item.amount || item.status === 'pending') && !confirm('이 항목을 삭제할까요?')) return;
    state.items = state.items.filter(i => i !== item);
    item.removed = true;
    item.el.remove();
    renumber(); updateTotal();
  }

  function renumber() {
    state.items.forEach((it, i) => { $('.item-no', it.el).textContent = (i + 1) + '번 ' + (it.kind === 'photo' ? '영수증' : '직접 입력'); });
    $('#itemsEmpty').hidden = state.items.length > 0;
    $('#itemCount').textContent = state.items.length ? state.items.length + '건' : '';
  }

  function setBadge(item) {
    const b = $('.badge', item.el);
    const map = {
      pending: ['대기 중', 'wait'], reading: ['금액 인식 중…', 'wait spin'], done: ['자동 인식 ✓', 'ok'],
      check: ['금액을 확인해 주세요', 'warn'], offline: ['인식 실패 · 직접 입력', 'warn'], manual: ['직접 입력', 'plain'],
    };
    const [txt, cls] = map[item.status] || ['', ''];
    b.textContent = txt; b.className = 'badge ' + cls;
    item.el.classList.toggle('loading', item.status === 'reading' || item.status === 'pending');
  }

  function markChips(item) {
    $$('.chip', item.el).forEach(c => c.classList.toggle('on', Number(c.dataset.v) === item.amount));
  }
  function renderChips(item) {
    const box = $('.chips', item.el);
    const list = (item.candidates || []).filter(v => v > 0);
    if (list.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = '<span class="muted small">인식된 금액:</span>' +
      list.map(v => `<button type="button" class="chip" data-v="${v}">${v.toLocaleString('ko-KR')}</button>`).join('');
    $$('.chip', box).forEach(c => c.addEventListener('click', () => {
      item.amount = Number(c.dataset.v);
      $('.iAmount', item.el).value = item.amount.toLocaleString('ko-KR');
      markChips(item); updateTotal();
    }));
    markChips(item);
  }

  function updateTotal() {
    const total = state.items.reduce((s, i) => s + (i.amount || 0), 0);
    $('#totalAmount').textContent = won(total);
    $('#totalCount').textContent = `총 ${state.items.length}건`;
    return total;
  }

  /* ───────── 사진 처리 & 자동 인식 ───────── */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 열 수 없습니다.')); };
      img.src = url;
    });
  }
  function toJpeg(img, max, quality) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  async function handleFiles(files) {
    const list = [...files].filter(f => /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    if (!list.length) return;
    if (state.items.length + list.length > 30) { toast('한 번에 30건까지 청구할 수 있어요.'); return; }
    for (const f of list) {
      try {
        const img = await loadImage(f);
        const data = toJpeg(img, 2000, 0.82);
        const thumb = toJpeg(img, 240, 0.7);
        const item = addItem('photo', data, thumb);
        item.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        state.queue = state.queue.then(() => recognize(item));
      } catch (e) { toast(e.message); }
    }
  }

  async function recognize(item) {
    if (item.removed) return;
    item.status = 'reading'; setBadge(item);
    try {
      const r = await api('ocr', { image: item.image });
      if (item.removed) return;
      item.fileId = r.fileId;
      item.ocrAmount = r.amount || 0;
      item.candidates = r.candidates || [];
      if (!item.amount && r.amount) { item.amount = r.amount; $('.iAmount', item.el).value = r.amount.toLocaleString('ko-KR'); }
      if (r.date && !item.date) { item.date = r.date; $('.iDate', item.el).value = r.date; }
      if (r.store && !item.store) { item.store = r.store; $('.iStore', item.el).value = r.store; }
      item.status = r.amount ? 'done' : 'check';
      renderChips(item);
      if (!r.amount) $('.iAmount', item.el).focus({ preventScroll: true });
    } catch (e) {
      if (item.removed) return;
      item.status = 'offline';
      if (e.authError) openSettings(e.message); else toast(e.message);
    }
    if (!item.date) { item.date = today(); $('.iDate', item.el).value = item.date; }
    setBadge(item); updateTotal();
  }

  function showImage(item) {
    const w = window.open('', '_blank');
    if (w) { w.document.write(`<title>영수증</title><body style="margin:0;background:#111"><img src="${item.image}" style="width:100%"></body>`); w.document.close(); }
  }

  $('#btnCamera').addEventListener('click', () => $('#inCamera').click());
  $('#btnGallery').addEventListener('click', () => $('#inGallery').click());
  $('#btnManual').addEventListener('click', () => addItem('manual'));
  ['#inCamera', '#inGallery'].forEach(s => $(s).addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; }));

  /* ───────── 제출 ───────── */
  function validate() {
    const c = readClaimant();
    if (!c.name) return ['이름을 입력해 주세요.', '#fName'];
    if (!c.dept) return ['부서를 선택해 주세요.', '#fDept'];
    if (!state.items.length) return ['청구 항목을 추가해 주세요.', '#btnCamera'];
    for (const [i, it] of state.items.entries()) {
      if (!it.amount) return [`${i + 1}번 항목의 금액을 입력해 주세요.`, it.el.querySelector('.iAmount')];
      if (it.kind === 'manual' && !it.reason.trim()) return [`${i + 1}번 항목: 영수증이 없는 사유를 적어 주세요.`, it.el.querySelector('.iReason')];
    }
    if (!c.bank || !c.account) return ['입금받을 은행과 계좌번호를 입력해 주세요.', c.bank ? '#fAccount' : '#fBank'];
    return null;
  }

  $('#btnSubmit').addEventListener('click', async () => {
    const bad = validate();
    if (bad) {
      toast(bad[0]);
      const el = typeof bad[1] === 'string' ? $(bad[1]) : bad[1];
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => el.focus?.({ preventScroll: true }), 350); }
      return;
    }
    if (state.items.some(i => i.status === 'reading' || i.status === 'pending')) {
      busy(true, '영수증 인식을 마무리하는 중…');
      await state.queue;
      busy(false);
    }
    const c = readClaimant(), total = updateTotal();
    $('#confirmBody').innerHTML = `
      <table class="sum">
        <tr><th>청구자</th><td>${esc(c.name)} · ${esc(c.dept)}</td></tr>
        <tr><th>입금계좌</th><td>${esc(c.bank)} ${esc(c.account)}<br><small>예금주 ${esc(c.holder)}</small></td></tr>
      </table>
      <ul class="sum-items">${state.items.map((it, i) => `<li><span>${i + 1}. ${esc(it.store || it.desc || (it.kind === 'photo' ? '영수증' : '직접 입력'))}</span><b>${won(it.amount)}</b></li>`).join('')}</ul>
      <p class="sum-total"><span>합계 ${state.items.length}건</span><b>${won(total)}</b></p>`;
    $('#dlgConfirm').returnValue = '';
    $('#dlgConfirm').showModal();
  });

  $('#dlgConfirm').addEventListener('close', async () => {
    if ($('#dlgConfirm').returnValue !== 'ok') return;
    const c = readClaimant();
    if ($('#fRemember').checked) LS.set('claimant', { ...c, holder: $('#fHolder').value.trim() });
    else LS.set('claimant', {});
    busy(true, '청구서를 접수하는 중…');
    try {
      const r = await api('submit', {
        claimant: c,
        memo: $('#fMemo').value.trim(),
        items: state.items.map(it => ({
          amount: it.amount, ocrAmount: it.ocrAmount || '', date: it.date, store: it.store, account: it.account,
          desc: it.desc, reason: it.reason,
          fileId: it.fileId || null,
          image: !it.fileId && it.kind === 'photo' ? it.image : null, // 인식 단계에서 업로드 실패한 사진은 이때 함께 전송
        })),
      });
      const hist = LS.get('history', []);
      hist.unshift({ no: r.claimNo, total: r.total, count: r.count, date: today(), status: '접수', note: '' });
      LS.set('history', hist.slice(0, 50));
      resetClaim();
      $('#doneNo').textContent = r.claimNo;
      $('#doneTotal').textContent = `${r.count}건 · ${won(r.total)}`;
      go('done');
    } catch (e) {
      if (e.authError) openSettings(e.message); else alert('접수하지 못했습니다.\n\n' + e.message);
    } finally { busy(false); }
  });

  function resetClaim() {
    state.items.forEach(i => { i.removed = true; i.el.remove(); });
    state.items = [];
    $('#fMemo').value = '';
    renumber(); updateTotal();
  }

  window.addEventListener('beforeunload', e => {
    if (state.items.length && document.body.dataset.view === 'claim') { e.preventDefault(); e.returnValue = ''; }
  });

  /* ───────── 내 청구 내역 ───────── */
  const statusCls = { '접수': 'wait', '검토중': 'wait', '승인': 'ok', '지급완료': 'ok', '반려': 'warn' };
  function renderHistory() {
    const hist = LS.get('history', []);
    $('#historyList').innerHTML = hist.length
      ? hist.map(h => `<li><div><b>${esc(h.no)}</b><small>${esc(h.date)} · ${h.count}건</small>${h.note ? `<small class="note">${esc(h.note)}</small>` : ''}</div>
          <div class="r"><b>${won(h.total)}</b><span class="badge ${statusCls[h.status] || 'plain'}">${esc(h.status)}</span></div></li>`).join('')
      : '<li class="empty">아직 청구한 내역이 없습니다.</li>';
  }
  $('#btnRefreshStatus').addEventListener('click', async () => {
    const hist = LS.get('history', []);
    if (!hist.length) return;
    try {
      const r = await api('status', { claimNos: hist.map(h => h.no) });
      hist.forEach(h => { if (r.statuses[h.no]) { h.status = r.statuses[h.no].status; h.note = r.statuses[h.no].note; } });
      LS.set('history', hist); renderHistory(); toast('최신 상태로 바꿨습니다.');
    } catch (e) { toast(e.message); }
  });

  /* ───────── 시작 ───────── */
  applyConfig();
  renderHistory();
  renumber(); updateTotal();
  const start = location.hash.slice(1);
  document.body.dataset.view = 'home';
  if (start === 'claim' && accessCode()) go('claim'); else history.replaceState(null, '', '#home');
  if (!apiUrl() || !accessCode()) setTimeout(() => openSettings(apiUrl() ? '처음 오셨군요! 재정부에서 받은 접근 코드를 입력해 주세요.' : ''), 400);
  else refreshConfig();
})();
