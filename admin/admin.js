/* 장유중앙교회 재정부 관리 앱 */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const CONF = window.APP_CONFIG || {};
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('fa_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('fa_' + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem('fa_' + k); } catch {} },
  };
  const won = n => (Number(n) || 0).toLocaleString('ko-KR') + '원';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ym = d => d.slice(0, 7);
  const thisMonth = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };

  const STATUS_CLS = { '접수': 'wait', '검토중': 'wait', '승인': 'ok', '지급완료': 'paid', '반려': 'warn' };
  const TABS = {
    wait: c => c.status === '접수' || c.status === '검토중',
    approved: c => c.status === '승인',
    paid: c => c.status === '지급완료',
    rejected: c => c.status === '반려',
    all: () => true,
  };

  const state = {
    claims: [], items: [], loadedAt: 0,
    tab: 'wait', query: '', selecting: false, selected: new Set(),
    month: thisMonth(), current: null, receipts: new Map(),
  };

  /* ───────── 서버 통신 ───────── */
  const apiUrl = () => (LS.get('api', '') || CONF.API_URL || '').trim();
  const adminCode = () => LS.get('code', '');
  const by = () => LS.get('by', '');

  async function api(action, payload = {}) {
    if (!apiUrl()) throw new Error('서버 주소가 설정되지 않았습니다.');
    let res;
    try {
      res = await fetch(apiUrl(), {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, adminCode: adminCode(), ...payload }),
      });
    } catch { throw new Error('인터넷 연결을 확인해 주세요.'); }
    let data;
    try { data = await res.json(); } catch { throw new Error('서버 응답을 읽을 수 없습니다. (웹 앱을 새 버전으로 배포했는지 확인)'); }
    if (!data.ok) {
      const err = new Error(data.error || '요청에 실패했습니다.');
      if (data.authError) { LS.del('code'); openSettings(err.message); }
      throw err;
    }
    return data;
  }

  /* ───────── 공통 UI ───────── */
  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function busy(on, msg) { $('#overlayMsg').textContent = msg || '처리 중…'; $('#overlay').classList.toggle('show', !!on); }

  function go(view, push = true) {
    if (view !== 'list') exitSelect();
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    $$('#bottomnav button').forEach(b => b.classList.toggle('on', b.dataset.go === view));
    document.body.dataset.view = view;
    window.scrollTo(0, 0);
    if (view === 'stats') renderStats();
    if (view === 'list') renderList();
    if (push && location.hash.slice(1) !== view) history.pushState(null, '', '#' + view);
  }
  window.addEventListener('popstate', () => go(location.hash.slice(1) === 'stats' ? 'stats' : 'list', false));
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-go]');
    if (t) { e.preventDefault(); go(t.dataset.go); }
  });

  /* ───────── 로그인 / 설정 ───────── */
  function openSettings(msg) {
    $('#sCode').value = adminCode();
    $('#sBy').value = by();
    $('#sApi').value = LS.get('api', '');
    $('#advanced').open = !CONF.API_URL && !LS.get('api', '');
    $('#sMsg').textContent = msg || ''; $('#sMsg').className = msg ? 'msg err' : 'msg';
    $('#btnLogout').hidden = !adminCode();
    if (!$('#dlgSettings').open) $('#dlgSettings').showModal();
  }
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#dlgSettings').addEventListener('cancel', e => { if (!adminCode()) e.preventDefault(); });
  $('#btnLogout').addEventListener('click', () => {
    LS.del('code'); state.claims = []; state.items = []; renderList();
    $('#sCode').value = ''; $('#btnLogout').hidden = true;
    $('#sMsg').textContent = '로그아웃되었습니다.'; $('#sMsg').className = 'msg';
  });
  $('#btnSaveSettings').addEventListener('click', async e => {
    e.preventDefault();
    const code = $('#sCode').value.trim(), name = $('#sBy').value.trim(), api_ = $('#sApi').value.trim();
    const fail = m => { $('#sMsg').textContent = m; $('#sMsg').className = 'msg err'; };
    if (api_ && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(api_)) return fail('웹 앱 주소 형식을 확인해 주세요. (…/exec)');
    if (!code) return fail('관리자 코드를 입력해 주세요.');
    if (!name) return fail('처리자 이름을 입력해 주세요.');
    LS.set('code', code); LS.set('by', name); LS.set('api', api_);
    $('#sMsg').textContent = '확인 중…'; $('#sMsg').className = 'msg';
    try {
      await api('adminPing');
      $('#dlgSettings').close();
      toast(name + '님, 환영합니다');
      load();
    } catch (err) { fail(err.message); }
  });

  /* ───────── 데이터 불러오기 ───────── */
  async function load(silent) {
    if (!adminCode()) return;
    if (!silent) $('#btnReload').classList.add('spin');
    try {
      const r = await api('adminList');
      state.claims = r.claims; state.items = r.items; state.loadedAt = Date.now();
      if (r.churchName) $('#churchName').textContent = r.churchName;
      renderList();
      if (document.body.dataset.view === 'stats') renderStats();
    } catch (e) { if (!silent) toast(e.message); }
    finally { $('#btnReload').classList.remove('spin'); }
  }
  $('#btnReload').addEventListener('click', () => {
    load();
    if (document.body.dataset.view === 'detail' && state.current) openDetail(state.current.no, false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 60000) load(true);
  });

  /* ───────── 목록 ───────── */
  const sum = arr => arr.reduce((s, c) => s + c.total, 0);
  function renderTiles() {
    const wait = state.claims.filter(TABS.wait), appr = state.claims.filter(TABS.approved);
    const paid = state.claims.filter(c => c.status === '지급완료' && ym(c.doneAt) === thisMonth());
    $('#tWaitN').textContent = wait.length + '건'; $('#tWaitS').textContent = won(sum(wait));
    $('#tApprN').textContent = appr.length + '건'; $('#tApprS').textContent = won(sum(appr));
    $('#tPaidN').textContent = paid.length + '건'; $('#tPaidS').textContent = won(sum(paid));
    $('#cWait').textContent = wait.length || ''; $('#cAppr').textContent = appr.length || '';
  }

  function filtered() {
    const q = state.query.trim().toLowerCase();
    return state.claims.filter(TABS[state.tab]).filter(c => !q ||
      [c.no, c.name, c.dept, c.memo, c.holder].join(' ').toLowerCase().includes(q));
  }

  function renderList() {
    renderTiles();
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
    const list = filtered();
    const seen = new Set(LS.get('seen', []));
    $('#listInfo').textContent = adminCode() ? `${list.length}건 · ${won(sum(list))}` : '';
    $('#btnSelect').hidden = !(state.tab === 'wait' || state.tab === 'approved') || !list.length;
    $('#btnSelect').textContent = state.selecting ? '선택 취소' : '여러 건 선택';
    if (!adminCode()) { $('#claimList').innerHTML = '<li class="empty">로그인해 주세요.</li>'; return; }
    $('#claimList').innerHTML = list.length ? list.map(c => `
      <li class="claim ${state.selected.has(c.no) ? 'sel' : ''}" data-no="${esc(c.no)}">
        ${state.selecting ? `<span class="cbox">${state.selected.has(c.no) ? '✓' : ''}</span>` : ''}
        <div class="c-main">
          <b>${esc(c.name)} <small>${esc(c.dept)}</small>${c.status === '접수' && !seen.has(c.no) ? '<i class="new">NEW</i>' : ''}</b>
          <small>${esc(c.no)} · ${esc(c.at.slice(5, 16))} · ${c.count}건</small>
          ${c.memo ? `<small class="memo">${esc(c.memo)}</small>` : ''}
        </div>
        <div class="c-side"><b>${won(c.total)}</b><span class="badge ${STATUS_CLS[c.status] || 'plain'}">${esc(c.status)}</span></div>
      </li>`).join('')
      : `<li class="empty">${state.tab === 'wait' ? '처리할 청구가 없습니다 🙌' : '해당하는 청구가 없습니다.'}</li>`;
    renderBulk();
  }

  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    state.tab = b.dataset.tab; exitSelect(); renderList();
  });
  $$('.tiles .tile[data-tab]').forEach(t => t.addEventListener('click', () => { state.tab = t.dataset.tab; exitSelect(); go('list'); }));
  $('#search').addEventListener('input', e => { state.query = e.target.value; renderList(); });
  $('#claimList').addEventListener('click', e => {
    const li = e.target.closest('.claim'); if (!li) return;
    const no = li.dataset.no;
    if (state.selecting) {
      state.selected.has(no) ? state.selected.delete(no) : state.selected.add(no);
      renderList();
    } else openDetail(no);
  });

  /* ───────── 여러 건 한꺼번에 처리 ───────── */
  function exitSelect() { state.selecting = false; state.selected.clear(); $('#bulkbar').hidden = true; }
  $('#btnSelect').addEventListener('click', () => {
    if (state.selecting) exitSelect(); else state.selecting = true;
    renderList();
  });
  $('#btnBulkCancel').addEventListener('click', () => { exitSelect(); renderList(); });
  function renderBulk() {
    $('#bulkbar').hidden = !state.selecting;
    if (!state.selecting) return;
    const picked = state.claims.filter(c => state.selected.has(c.no));
    $('#bulkN').textContent = picked.length + '건 선택';
    $('#bulkS').textContent = won(sum(picked));
    $('#btnBulkDo').textContent = state.tab === 'approved' ? '일괄 지급완료' : '일괄 승인';
    $('#btnBulkDo').disabled = !picked.length;
  }
  $('#btnBulkDo').addEventListener('click', () => {
    const nos = [...state.selected];
    if (!nos.length) return;
    const status = state.tab === 'approved' ? '지급완료' : '승인';
    const total = sum(state.claims.filter(c => state.selected.has(c.no)));
    askAction(status, nos, `${nos.length}건 · ${won(total)}`);
  });

  /* ───────── 상세 ───────── */
  async function openDetail(no, push = true) {
    const base = state.claims.find(c => c.no === no);
    const seen = new Set(LS.get('seen', [])); seen.add(no); LS.set('seen', [...seen].slice(-500));
    state.current = base ? { ...base, items: null } : { no, items: null };
    renderDetail();
    go('detail', push);
    try {
      const r = await api('adminDetail', { claimNo: no });
      if (state.current?.no !== no) return;
      state.current = r.claim;
      renderDetail();
      loadReceipts(r.claim);
    } catch (e) { toast(e.message); }
  }

  function renderDetail() {
    const c = state.current;
    if (!c) return;
    const items = c.items;
    const edited = (items || []).filter(i => i.edited).length;
    const noProof = (items || []).filter(i => !i.fileId).length;
    $('#detailBody').innerHTML = `
      <div class="card d-head">
        <span class="badge ${STATUS_CLS[c.status] || 'plain'}">${esc(c.status || '')}</span>
        <h2>${esc(c.name || '')} <small>${esc(c.dept || '')}</small></h2>
        <p class="d-total">${won(c.total)}</p>
        <p class="muted small">${esc(c.no)} · 접수 ${esc(c.at || '')} · ${c.count || 0}건</p>
        ${edited || noProof ? `<div class="flags">
          ${edited ? `<span class="badge warn">금액 수정 ${edited}건</span>` : ''}
          ${noProof ? `<span class="badge warn">영수증 없음 ${noProof}건</span>` : ''}</div>` : ''}
      </div>

      <div class="card">
        <h2>입금 정보</h2>
        <div class="acct">
          <div><b>${esc(c.bank || '-')} ${esc(c.account || '')}</b><small>예금주 ${esc(c.holder || '-')}</small></div>
          ${c.account ? `<button class="btn" id="btnCopy">계좌 복사</button>` : ''}
        </div>
        ${c.phone ? `<p class="small"><a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">📞 ${esc(c.phone)}</a></p>` : ''}
        ${c.memo ? `<p class="d-memo">“${esc(c.memo)}”</p>` : ''}
      </div>

      <div class="card">
        <div class="card-head"><h2>청구 항목</h2><span class="muted small">${items ? items.length + '건' : ''}</span></div>
        ${items ? items.map(i => `
          <div class="d-item">
            <div class="d-thumb ${i.fileId ? '' : 'none'}" data-file="${esc(i.fileId)}">${i.fileId ? '<span class="spin-sm"></span>' : '영수증<br>없음'}</div>
            <div class="d-info">
              <b>${i.seq}. ${esc(i.store || i.desc || '(사용처 미기재)')}</b>
              <small>${esc([i.date, i.account, i.store && i.desc ? i.desc : ''].filter(Boolean).join(' · '))}</small>
              ${i.edited ? `<small class="warn-t">자동인식 ${won(i.ocrAmount)} → ${won(i.amount)}로 수정됨</small>` : ''}
              ${!i.fileId ? `<small class="warn-t">사유: ${esc(i.reason || '-')}</small>` : ''}
            </div>
            <b class="d-amt">${won(i.amount)}</b>
          </div>`).join('') + `<div class="d-sum"><span>합계</span><b>${won(c.total)}</b></div>`
        : '<p class="empty"><span class="spin-sm"></span> 불러오는 중…</p>'}
      </div>

      ${c.by || c.note ? `<div class="card"><h2>처리 기록</h2>
        <p class="small">${esc(c.status)} · ${esc(c.doneAt || '')} · ${esc(c.by || '')}</p>
        ${c.note ? `<p class="d-memo">${esc(c.note)}</p>` : ''}</div>` : ''}

      ${c.viewUrl ? `<div class="links">
        <a class="btn" href="${esc(c.viewUrl)}" target="_blank" rel="noopener">🖨 청구서 인쇄</a>
        ${c.folderUrl ? `<a class="btn" href="${esc(c.folderUrl)}" target="_blank" rel="noopener">📁 영수증 폴더</a>` : ''}
      </div>` : ''}`;

    $('#btnCopy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(c.account.replace(/[^\d]/g, '')); toast('계좌번호를 복사했습니다'); }
      catch { toast(c.account); }
    });
    $$('.d-thumb[data-file]', $('#detailBody')).forEach(el => {
      const id = el.dataset.file;
      if (id && state.receipts.has(id)) showThumb(el, state.receipts.get(id));
    });
    renderActions();
  }

  async function loadReceipts(c) {
    for (const it of c.items || []) {
      if (!it.fileId || state.receipts.has(it.fileId)) continue;
      try {
        const r = await api('adminReceipt', { fileId: it.fileId });
        state.receipts.set(it.fileId, r.image);
        if (state.receipts.size > 60) state.receipts.delete(state.receipts.keys().next().value);
      } catch { continue; }
      if (state.current?.no !== c.no) return;
      const el = $(`.d-thumb[data-file="${CSS.escape(it.fileId)}"]`);
      if (el) showThumb(el, state.receipts.get(it.fileId));
    }
  }
  function showThumb(el, src) {
    el.innerHTML = `<img src="${src}" alt="영수증">`;
    el.onclick = () => { $('#viewer img').src = src; $('#viewer').hidden = false; };
  }
  $('#viewer').addEventListener('click', e => { if (e.target.tagName !== 'IMG' || e.target.closest('.viewer-close')) $('#viewer').hidden = true; });

  /* ───────── 상태 변경 ───────── */
  const ACTIONS = {
    '접수': [['검토중', '검토 시작', ''], ['반려', '반려', 'danger'], ['승인', '승인', 'primary']],
    '검토중': [['반려', '반려', 'danger'], ['승인', '승인', 'primary']],
    '승인': [['검토중', '승인 취소', ''], ['지급완료', '지급완료', 'primary']],
    '지급완료': [['승인', '지급 취소', '']],
    '반려': [['접수', '다시 접수', '']],
  };
  function renderActions() {
    const c = state.current;
    const acts = (c && c.items && ACTIONS[c.status]) || [];
    $('#actionbar').innerHTML = acts.map(([to, label, cls]) => `<button class="btn ${cls}" data-to="${to}">${label}</button>`).join('');
    $('#actionbar').hidden = !acts.length;
    $$('#actionbar button').forEach(b => b.addEventListener('click', () => askAction(b.dataset.to, [c.no], `${c.name} · ${won(c.total)}`)));
  }

  let pending = null;
  function askAction(status, nos, desc) {
    pending = { status, nos };
    const titles = { '승인': '승인할까요?', '지급완료': '지급완료로 처리할까요?', '반려': '반려할까요?', '검토중': '검토중으로 바꿀까요?', '접수': '다시 접수 상태로 돌릴까요?' };
    $('#actTitle').textContent = titles[status];
    $('#actDesc').textContent = desc;
    $('#actNote').value = '';
    $('#actNote').placeholder = status === '반려' ? '반려 사유 (청구자에게 보입니다)' : status === '지급완료' ? '예) 11/3 농협 이체 완료 (선택)' : '메모 (선택, 청구자에게 보입니다)';
    $('#actNoteReq').innerHTML = status === '반려' ? '<em>* 필수</em>' : '';
    $('#actMsg').textContent = '';
    $('#actOk').className = 'btn ' + (status === '반려' ? 'danger' : 'primary');
    $('#actOk').textContent = { '반려': '반려하기', '지급완료': '지급완료', '승인': '승인하기' }[status] || '확인';
    $('#dlgAction').showModal();
  }
  $('#actOk').addEventListener('click', async e => {
    e.preventDefault();
    if (!pending) return;
    const note = $('#actNote').value.trim();
    if (pending.status === '반려' && !note) { $('#actMsg').textContent = '반려 사유를 적어 주세요.'; return; }
    if (!by()) { $('#dlgAction').close(); openSettings('처리자 이름을 먼저 설정해 주세요.'); return; }
    const { status, nos } = pending;
    $('#dlgAction').close();
    busy(true, '처리 중…');
    try {
      const r = await api('adminUpdate', { claimNos: nos, status, note: note || null, by: by() });
      r.claims.forEach(u => {
        const i = state.claims.findIndex(c => c.no === u.no);
        if (i >= 0) state.claims[i] = u;
        if (state.current?.no === u.no) Object.assign(state.current, u);
      });
      toast(`${r.updated}건을 ‘${status}’(으)로 처리했습니다`);
      exitSelect();
      if (document.body.dataset.view === 'detail') renderDetail(); else renderList();
    } catch (err) { alert('처리하지 못했습니다.\n\n' + err.message); }
    finally { busy(false); pending = null; }
  });

  /* ───────── 월별 통계 ───────── */
  function shiftMonth(n) {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    state.month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    renderStats();
  }
  $('#mPrev').addEventListener('click', () => shiftMonth(-1));
  $('#mNext').addEventListener('click', () => shiftMonth(1));

  function bars(el, map) {
    const rows = Object.entries(map).sort((a, b) => b[1] - a[1]);
    const max = rows.length ? rows[0][1] : 0;
    el.innerHTML = rows.length ? rows.map(([k, v]) => `
      <div class="bar"><span class="b-label">${esc(k)}</span>
        <span class="b-track"><i style="width:${max ? Math.max(2, v / max * 100) : 0}%"></i></span>
        <b>${won(v)}</b></div>`).join('') : '<p class="empty">이 달의 청구가 없습니다.</p>';
  }

  function renderStats() {
    const [y, m] = state.month.split('-');
    $('#mLabel').textContent = `${y}년 ${Number(m)}월`;
    $('#mNext').disabled = state.month >= thisMonth();
    const inMonth = state.claims.filter(c => ym(c.at) === state.month);
    const valid = inMonth.filter(c => c.status !== '반려');
    const paid = inMonth.filter(c => c.status === '지급완료');
    const open = inMonth.filter(c => c.status !== '지급완료');
    $('#sTotalN').textContent = valid.length + '건'; $('#sTotalS').textContent = won(sum(valid));
    $('#sPaidN').textContent = paid.length + '건'; $('#sPaidS').textContent = won(sum(paid));
    $('#sOpenN').textContent = open.length + '건'; $('#sOpenS').textContent = won(sum(open));

    const dept = {};
    valid.forEach(c => { dept[c.dept || '미지정'] = (dept[c.dept || '미지정'] || 0) + c.total; });
    bars($('#byDept'), dept);

    const validNos = new Set(valid.map(c => c.no));
    const acc = {};
    state.items.forEach(([no, account, amount]) => { if (validNos.has(no)) acc[account] = (acc[account] || 0) + amount; });
    bars($('#byAccount'), acc);
  }

  /* ───────── 시작 ───────── */
  FC.setupInstall(toast);
  FC.registerSW('../sw.js');
  document.body.dataset.view = 'list';
  history.replaceState(null, '', '#list');
  renderList();
  if (!adminCode() || !by() || !apiUrl()) setTimeout(() => openSettings(), 300);
  else load();
})();
