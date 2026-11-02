/**
 * 장유중앙교회 재정청구 — Google Apps Script 백엔드
 *
 * 설치: 구글 시트 → 확장 프로그램 → Apps Script 에 이 파일 전체를 붙여넣고,
 *       서비스(+)에서 "Drive API"(v3)를 추가한 뒤, 시트 메뉴 [💰 재정청구 → ① 초기 설정]을 실행하세요.
 *       자세한 순서는 README.md 를 참고하세요.
 */

const CFG = {
  SHEET_CLAIMS: '청구서',
  SHEET_ITEMS: '청구내역',
  SHEET_SETTINGS: '설정',
  SHEET_LOG: '처리기록',
  FOLDER_NAME: '재정청구_영수증',
  TEMP_FOLDER_NAME: '_임시(인식중)',
  STATUSES: ['접수', '검토중', '승인', '지급완료', '반려'],
  MAX_ITEMS: 30,
  MAX_AMOUNT: 100000000, // 1억 원 이상은 오입력으로 간주
};

const CLAIM_HEADERS = [
  '청구번호', '접수일시', '청구자', '부서', '연락처', '은행', '계좌번호', '예금주',
  '건수', '총금액', '청구사유/메모', '상태', '처리일', '처리자', '재정부 메모', '청구서 보기', '영수증 폴더', '보기토큰',
];
const ITEM_HEADERS = [
  '청구번호', '순번', '사용일', '사용처', '계정과목', '내용', '금액', '증빙', '영수증 없는 사유',
  '영수증', '자동인식 금액', '금액 수정여부', '영수증파일ID',
];
const LOG_HEADERS = ['처리일시', '청구번호', '이전 상태', '변경 상태', '처리자', '메모'];

const DEFAULT_DEPTS = ['교육부', '선교부', '찬양부', '봉사부', '친교부', '관리부', '청년부', '여전도회', '남선교회', '기타'];
const DEFAULT_ACCOUNTS = ['교육비', '선교비', '행사비', '식대·다과', '교통·차량비', '비품·소모품', '인쇄·홍보비', '경조비', '시설관리비', '기타'];

/* ───────────────────────── 시트 메뉴 ───────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('💰 재정청구')
    .addItem('① 초기 설정 (처음 한 번)', 'setup')
    .addItem('접근 코드 변경 (교인용)', 'changeAccessCode')
    .addItem('관리자 코드 변경 (재정부용)', 'changeAdminCode')
    .addItem('웹앱 주소 확인', 'showWebAppUrl')
    .addToUi();
}

function setup() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());

  // 1) 시트 준비
  const claims = ensureSheet_(ss, CFG.SHEET_CLAIMS, CLAIM_HEADERS);
  ensureSheet_(ss, CFG.SHEET_ITEMS, ITEM_HEADERS);
  ensureSettingsSheet_(ss);
  ensureSheet_(ss, CFG.SHEET_LOG, LOG_HEADERS);

  claims.hideColumns(CLAIM_HEADERS.indexOf('보기토큰') + 1);
  const statusRule = SpreadsheetApp.newDataValidation().requireValueInList(CFG.STATUSES, true).build();
  claims.getRange(2, CLAIM_HEADERS.indexOf('상태') + 1, claims.getMaxRows() - 1, 1).setDataValidation(statusRule);
  claims.getRange(2, CLAIM_HEADERS.indexOf('총금액') + 1, claims.getMaxRows() - 1, 1).setNumberFormat('#,##0"원"');
  const items = ss.getSheetByName(CFG.SHEET_ITEMS);
  items.getRange(2, ITEM_HEADERS.indexOf('금액') + 1, items.getMaxRows() - 1, 2).setNumberFormat('#,##0');
  items.hideColumns(ITEM_HEADERS.indexOf('영수증파일ID') + 1);

  // 2) 영수증 보관 폴더 (시트와 같은 폴더 안에 생성)
  getRootFolder_();
  getTempFolder_();

  // 3) 접근 코드
  if (!props.getProperty('ACCESS_CODE')) {
    const res = ui.prompt('접근 코드 설정',
      '앱에서 청구할 때 입력할 "교회 접근 코드"를 정해 주세요.\n(예: 숫자 4~6자리. 교인들에게만 알려 주세요)',
      ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK || !res.getResponseText().trim()) {
      ui.alert('접근 코드가 설정되지 않았습니다. 메뉴 [접근 코드 변경]에서 다시 설정해 주세요.');
    } else {
      props.setProperty('ACCESS_CODE', res.getResponseText().trim());
    }
  }

  // 3-2) 재정부 관리자 코드 (교인용 코드와 반드시 다르게)
  if (!props.getProperty('ADMIN_CODE')) {
    const res = ui.prompt('재정부 관리자 코드 설정',
      '재정부 관리 앱에 들어갈 때 쓸 "관리자 코드"를 정해 주세요.\n(교인용 접근 코드와 다르게, 8자 이상 권장. 재정부원에게만 알려 주세요)',
      ui.ButtonSet.OK_CANCEL);
    const v = res.getSelectedButton() === ui.Button.OK ? res.getResponseText().trim() : '';
    if (v && v !== props.getProperty('ACCESS_CODE')) props.setProperty('ADMIN_CODE', v);
    else ui.alert('관리자 코드가 설정되지 않았습니다. (비어 있거나 교인용 코드와 같음)\n메뉴 [관리자 코드 변경]에서 다시 설정해 주세요.');
  }

  // 4) OCR(Drive API) 사용 가능 여부 확인
  let ocrOk = true;
  try { Drive.Files; } catch (e) { ocrOk = false; }

  ui.alert('초기 설정 완료',
    '✅ 시트와 영수증 폴더가 준비되었습니다.\n\n' +
    (ocrOk ? '' : '⚠️ Drive API 서비스가 추가되지 않았습니다. 편집기 왼쪽 [서비스 +] → Drive API 를 추가해 주세요.\n\n') +
    '다음 단계: 편집기 오른쪽 위 [배포 → 새 배포 → 웹 앱]\n' +
    '  · 실행 계정: 나\n  · 액세스 권한: 모든 사용자\n' +
    '으로 배포한 뒤, 나온 웹 앱 URL을 앱 설정(config.js)에 넣어 주세요.',
    ui.ButtonSet.OK);
}

function changeAccessCode() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('접근 코드 변경', '새 접근 코드를 입력하세요.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() === ui.Button.OK && res.getResponseText().trim()) {
    PropertiesService.getScriptProperties().setProperty('ACCESS_CODE', res.getResponseText().trim());
    ui.alert('접근 코드가 변경되었습니다. 교인들에게 새 코드를 알려 주세요.');
  }
}

function changeAdminCode() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const res = ui.prompt('관리자 코드 변경', '새 재정부 관리자 코드를 입력하세요. (8자 이상 권장)', ui.ButtonSet.OK_CANCEL);
  const v = res.getSelectedButton() === ui.Button.OK ? res.getResponseText().trim() : '';
  if (!v) return;
  if (v === props.getProperty('ACCESS_CODE')) { ui.alert('교인용 접근 코드와 다른 코드를 정해 주세요.'); return; }
  props.setProperty('ADMIN_CODE', v);
  ui.alert('관리자 코드가 변경되었습니다. 재정부원들의 앱에서 새 코드로 다시 로그인해 주세요.');
}

function showWebAppUrl() {
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(url
    ? '현재 웹 앱 주소:\n\n' + url
    : '아직 웹 앱으로 배포되지 않았습니다. [배포 → 새 배포 → 웹 앱]을 진행해 주세요.');
}

/* ───────────────────────── 웹 요청 처리 ───────────────────────── */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.view) return renderClaimView_(p.view, p.t);
  return json_({ ok: true, app: 'church-finance-claim', message: '재정청구 서버가 정상 작동 중입니다.' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (/^admin/.test(String(body.action || ''))) return handleAdmin_(body);
    const code = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE');
    if (!code) return json_({ ok: false, error: '서버 초기 설정이 완료되지 않았습니다. (재정부 문의)' });
    if (String(body.code || '').trim() !== code) return json_({ ok: false, error: '접근 코드가 올바르지 않습니다.', authError: true });

    switch (body.action) {
      case 'ping': return json_({ ok: true });
      case 'config': return json_(Object.assign({ ok: true }, getAppConfig_()));
      case 'ocr': return json_(Object.assign({ ok: true }, handleOcr_(body)));
      case 'submit': return json_(Object.assign({ ok: true }, handleSubmit_(body)));
      case 'status': return json_({ ok: true, statuses: handleStatus_(body.claimNos || []) });
      default: return json_({ ok: false, error: '알 수 없는 요청입니다.' });
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────────────────────── 설정 ───────────────────────── */

function getAppConfig_() {
  const sh = getSS_().getSheetByName(CFG.SHEET_SETTINGS);
  const values = sh.getDataRange().getValues();
  const depts = [], accounts = [], kv = {};
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0]).trim()) depts.push(String(values[r][0]).trim());
    if (String(values[r][1]).trim()) accounts.push(String(values[r][1]).trim());
    if (String(values[r][3]).trim()) kv[String(values[r][3]).trim()] = String(values[r][4]).trim();
  }
  return {
    churchName: kv['교회이름'] || '',
    departments: depts.length ? depts : DEFAULT_DEPTS,
    accounts: accounts.length ? accounts : DEFAULT_ACCOUNTS,
    notifyEmail: kv['알림이메일'] || '',
  };
}

/* ───────────────────────── 영수증 인식 (OCR) ───────────────────────── */

function handleOcr_(body) {
  if (!body.image) throw new Error('이미지가 없습니다.');
  const blob = dataUrlToBlob_(body.image, 'receipt_' + Date.now() + '.jpg');
  const file = getTempFolder_().createFile(blob);

  let text = '', parsed = { amount: 0, candidates: [], date: '', store: '' }, ocrError = '';
  try {
    text = ocrBlob_(blob);
    parsed = parseReceipt_(text);
  } catch (err) {
    ocrError = '자동 인식에 실패했습니다. 금액을 직접 입력해 주세요.';
    console.warn('OCR 실패: ' + (err && err.message || err));
  }
  return { fileId: file.getId(), amount: parsed.amount, candidates: parsed.candidates,
           date: parsed.date, store: parsed.store, ocrError: ocrError };
}

/** 구글 드라이브의 OCR(이미지 → 구글 문서 변환)으로 글자를 읽어 옵니다. */
function ocrBlob_(blob) {
  let docId = null;
  try {
    if (typeof Drive.Files.create === 'function') { // Drive API v3
      const f = Drive.Files.create({ name: 'ocr_tmp_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
        blob, { ocrLanguage: 'ko', fields: 'id' });
      docId = f.id;
    } else { // Drive API v2
      const f = Drive.Files.insert({ title: 'ocr_tmp_' + Date.now(), mimeType: blob.getContentType() },
        blob, { ocr: true, ocrLanguage: 'ko' });
      docId = f.id;
    }
    return DocumentApp.openById(docId).getBody().getText();
  } finally {
    if (docId) {
      try { Drive.Files.remove(docId); } catch (e) {
        try { DriveApp.getFileById(docId).setTrashed(true); } catch (e2) {}
      }
    }
  }
}

/** OCR 결과 글자에서 합계 금액·날짜·상호를 찾아냅니다. */
function parseReceipt_(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const squash = s => s.replace(/\s+/g, '');

  // 우선순위가 높은 키워드부터
  const tiers = [
    ['총결제금액', '결제금액', '받을금액', '청구금액', '승인금액', '결제요청금액', '카드결제', '신용카드', '합계금액', '총합계', '총금액', '총액'],
    ['합계', '판매금액', '판매합계', '금액합계', '실결제', '현금', 'TOTAL', 'Total', '합 계'],
  ];
  const exclude = /(부가세|부가가치세|과세|면세|공급가|세액|VAT|vat|거스름|잔돈|할인|포인트|잔액|받은금액|적립|마일리지|봉사료|단가|수량)/;
  const noisy = /(TEL|Tel|tel|전화|사업자|등록번호|카드번호|승인번호|가맹점번호|대표|주소|No\.|NO\.|\d{2,4}-\d{3,4}-\d{4})/;

  const amountsIn = s => {
    const out = [];
    const re = /(\d{1,3}(?:[,.]\d{3})+|\d{3,9})\s*원?/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const before = s.charAt(m.index - 1), after = s.charAt(m.index + m[1].length);
      if (before === '-' || after === '-' || after === ':' || before === ':') continue; // 날짜·시각·번호 제외
      const v = parseInt(m[1].replace(/[,.]/g, ''), 10);
      if (v >= 100 && v < CFG.MAX_AMOUNT) out.push(v);
    }
    return out;
  };

  let amount = 0;
  const all = [];
  for (const words of tiers) {
    const hits = [];
    lines.forEach((line, i) => {
      if (exclude.test(squash(line))) return;
      let m = null;
      for (const w of words) {
        m = line.match(new RegExp(squash(w).split('').join('\\s*')));
        if (m) break;
      }
      if (!m) return;
      let found = amountsIn(line.slice(m.index + m[0].length));
      if (!found.length && lines[i + 1] && !exclude.test(squash(lines[i + 1]))) found = amountsIn(lines[i + 1]);
      hits.push(...found);
    });
    all.push(...hits);
    if (hits.length && !amount) amount = Math.max(...hits);
  }

  // 키워드로 못 찾으면: 쉼표가 들어간 금액 중 가장 큰 값
  if (!amount) {
    const fallback = [];
    lines.forEach(line => {
      if (noisy.test(line)) return;
      const re = /\d{1,3}(?:,\d{3})+/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        const v = parseInt(m[0].replace(/,/g, ''), 10);
        if (v >= 100 && v < CFG.MAX_AMOUNT) fallback.push(v);
      }
    });
    all.push(...fallback);
    if (fallback.length) amount = Math.max(...fallback);
  }

  const candidates = [...new Set([amount].concat(all.sort((a, b) => b - a)))].filter(Boolean).slice(0, 5);
  return { amount: amount, candidates: candidates, date: findDate_(lines), store: findStore_(lines) };
}

function findDate_(lines) {
  const text = lines.join('\n');
  const now = new Date();
  const res = [
    /(20\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/g,
    /(?:^|[^\d])(2\d)[.\-\/](\d{1,2})[.\-\/](\d{1,2})(?!\d)/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(text)) !== null) {
      let y = parseInt(m[1], 10); if (y < 100) y += 2000;
      const mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const dt = new Date(y, mo - 1, d);
      const diffDays = (now - dt) / 86400000;
      if (diffDays < -1 || diffDays > 730) continue;
      return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }
  }
  return '';
}

function findStore_(lines) {
  for (const line of lines) {
    const m = line.match(/(?:상\s*호|가맹점\s*명?|매\s*장\s*명|업\s*체\s*명)\s*[:：]?\s*(.+)/);
    if (m && m[1].trim().length >= 2) return m[1].replace(/\s{2,}.*/, '').trim().slice(0, 30);
  }
  const skip = /(영수증|영 수 증|매출전표|전표|고객용|카드|승인|신용|현금|주문|번호|TEL|전화|사업자|주소|대표|\d{3,})/i;
  for (const line of lines.slice(0, 6)) {
    if (/[가-힣]{2,}/.test(line) && line.length <= 30 && !skip.test(line)) return line.trim();
  }
  return '';
}

/* ───────────────────────── 청구 접수 ───────────────────────── */

function handleSubmit_(body) {
  const c = body.claimant || {};
  const name = clean_(c.name, 30), dept = clean_(c.dept, 30);
  if (!name) throw new Error('청구자 이름을 입력해 주세요.');
  if (!dept) throw new Error('부서를 선택해 주세요.');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new Error('청구 항목이 없습니다.');
  if (items.length > CFG.MAX_ITEMS) throw new Error('한 번에 ' + CFG.MAX_ITEMS + '건까지 청구할 수 있습니다.');

  items.forEach((it, i) => {
    it.amount = Math.round(Number(String(it.amount).replace(/[^\d]/g, '')));
    if (!it.amount || it.amount <= 0 || it.amount >= CFG.MAX_AMOUNT) throw new Error((i + 1) + '번째 항목의 금액을 확인해 주세요.');
    if (!it.fileId && !it.image && !clean_(it.reason, 200)) throw new Error((i + 1) + '번째 항목: 영수증이 없으면 사유를 적어 주세요.');
  });
  const total = items.reduce((s, it) => s + it.amount, 0);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const tz = Session.getScriptTimeZone() || 'Asia/Seoul';
    const now = new Date();
    const ym = Utilities.formatDate(now, tz, 'yyyyMM');
    const props = PropertiesService.getScriptProperties();
    const seq = Number(props.getProperty('SEQ_' + ym) || 0) + 1;
    props.setProperty('SEQ_' + ym, String(seq));
    const claimNo = ym + '-' + String(seq).padStart(3, '0');
    const token = Utilities.getUuid().replace(/-/g, '').slice(0, 16);

    // 영수증 폴더: 재정청구_영수증 / 2026-11 / 202611-001_홍길동
    const monthFolder = getOrCreateSubfolder_(getRootFolder_(), Utilities.formatDate(now, tz, 'yyyy-MM'));
    const claimFolder = monthFolder.createFolder(claimNo + '_' + name);
    const tempId = getTempFolder_().getId();

    const itemRows = items.map((it, i) => {
      let file = null;
      const fileName = claimNo + '_' + String(i + 1).padStart(2, '0') + '_' + it.amount + '원.jpg';
      if (it.fileId) {
        file = DriveApp.getFileById(String(it.fileId));
        if (!isInFolder_(file, tempId)) throw new Error('영수증 파일을 확인할 수 없습니다. 다시 촬영해 주세요.');
        file.moveTo(claimFolder);
        file.setName(fileName);
      } else if (it.image) {
        file = claimFolder.createFile(dataUrlToBlob_(it.image, fileName));
      }
      const ocrAmount = Number(it.ocrAmount) || '';
      return [
        claimNo, i + 1, clean_(it.date, 10), clean_(it.store, 50), clean_(it.account, 30), clean_(it.desc, 200),
        it.amount, file ? '영수증' : '영수증 없음', file ? '' : clean_(it.reason, 200),
        file ? '=HYPERLINK("' + file.getUrl() + '","영수증 보기")' : '',
        ocrAmount, ocrAmount === '' ? '' : (ocrAmount === it.amount ? '' : '수정함'),
        file ? file.getId() : '',
      ];
    });

    const viewUrl = (ScriptApp.getService().getUrl() || '') + '?view=' + encodeURIComponent(claimNo) + '&t=' + token;
    const ss = getSS_();
    const rowObj = {
      '청구번호': claimNo, '접수일시': now, '청구자': name, '부서': dept, '연락처': text_(c.phone, 20),
      '은행': clean_(c.bank, 20), '계좌번호': text_(c.account, 40), '예금주': clean_(c.holder, 20),
      '건수': items.length, '총금액': total, '청구사유/메모': clean_(body.memo, 500), '상태': '접수',
      '청구서 보기': '=HYPERLINK("' + viewUrl + '","청구서 보기")',
      '영수증 폴더': '=HYPERLINK("' + claimFolder.getUrl() + '","폴더 열기")', '보기토큰': token,
    };
    ss.getSheetByName(CFG.SHEET_CLAIMS).appendRow(CLAIM_HEADERS.map(h => rowObj[h] === undefined ? '' : rowObj[h]));
    const itemSheet = ss.getSheetByName(CFG.SHEET_ITEMS);
    itemSheet.getRange(itemSheet.getLastRow() + 1, 1, itemRows.length, ITEM_HEADERS.length).setValues(itemRows);

    notify_(claimNo, name, dept, items.length, total, viewUrl);
    return { claimNo: claimNo, total: total, count: items.length };
  } finally {
    lock.releaseLock();
  }
}

function notify_(claimNo, name, dept, count, total, viewUrl) {
  const to = getAppConfig_().notifyEmail;
  if (!to) return;
  try {
    MailApp.sendEmail({
      to: to,
      subject: '[재정청구] ' + claimNo + ' ' + name + '(' + dept + ') ' + total.toLocaleString('ko-KR') + '원',
      htmlBody: '<p>새 재정 청구가 접수되었습니다.</p><ul>' +
        '<li>청구번호: ' + claimNo + '</li><li>청구자: ' + escape_(name) + ' (' + escape_(dept) + ')</li>' +
        '<li>건수: ' + count + '건</li><li>총금액: <b>' + total.toLocaleString('ko-KR') + '원</b></li></ul>' +
        '<p><a href="' + viewUrl + '">청구서 보기</a></p>',
    });
  } catch (e) { console.warn('메일 발송 실패: ' + e); }
}

function handleStatus_(claimNos) {
  const want = new Set(claimNos.map(String).slice(0, 100));
  const sh = getSS_().getSheetByName(CFG.SHEET_CLAIMS);
  const values = sh.getDataRange().getValues();
  const iNo = 0, iStatus = CLAIM_HEADERS.indexOf('상태'), iNote = CLAIM_HEADERS.indexOf('재정부 메모');
  const out = {};
  for (let r = 1; r < values.length; r++) {
    const no = String(values[r][iNo]);
    if (want.has(no)) out[no] = { status: values[r][iStatus] || '접수', note: String(values[r][iNote] || '') };
  }
  return out;
}


/* ───────────────────────── 재정부 관리 앱 API ───────────────────────── */

function handleAdmin_(body) {
  const props = PropertiesService.getScriptProperties();
  const adminCode = props.getProperty('ADMIN_CODE');
  if (!adminCode) return json_({ ok: false, error: '관리자 코드가 아직 설정되지 않았습니다. 시트 메뉴 [💰 재정청구 → 관리자 코드 변경]에서 설정해 주세요.' });

  // 무차별 대입 방지: 10분 동안 20번 이상 틀리면 잠시 잠금
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('ADMIN_FAILS') || 0);
  if (fails >= 20) return json_({ ok: false, error: '로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도해 주세요.' });
  if (String(body.adminCode || '').trim() !== adminCode) {
    cache.put('ADMIN_FAILS', String(fails + 1), 600);
    return json_({ ok: false, error: '관리자 코드가 올바르지 않습니다.', authError: true });
  }

  switch (body.action) {
    case 'adminPing': return json_({ ok: true, churchName: getAppConfig_().churchName });
    case 'adminList': return json_(Object.assign({ ok: true }, adminList_()));
    case 'adminDetail': return json_(Object.assign({ ok: true }, adminDetail_(String(body.claimNo || ''))));
    case 'adminReceipt': return json_(Object.assign({ ok: true }, adminReceipt_(String(body.fileId || ''))));
    case 'adminUpdate': return json_(Object.assign({ ok: true }, adminUpdate_(body)));
    default: return json_({ ok: false, error: '알 수 없는 요청입니다.' });
  }
}

function fmt_(v, pattern) {
  return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Seoul', pattern) : String(v == null ? '' : v);
}

function claimObj_(row) {
  const H = k => row[CLAIM_HEADERS.indexOf(k)];
  return {
    no: String(H('청구번호')), at: fmt_(H('접수일시'), 'yyyy-MM-dd HH:mm'),
    name: String(H('청구자')), dept: String(H('부서')), phone: String(H('연락처')),
    bank: String(H('은행')), account: String(H('계좌번호')), holder: String(H('예금주')),
    count: Number(H('건수')) || 0, total: Number(H('총금액')) || 0, memo: String(H('청구사유/메모')),
    status: String(H('상태') || '접수'), doneAt: fmt_(H('처리일'), 'yyyy-MM-dd HH:mm'),
    by: String(H('처리자')), note: String(H('재정부 메모')),
  };
}

function adminList_() {
  const ss = getSS_();
  const cv = ss.getSheetByName(CFG.SHEET_CLAIMS).getDataRange().getValues();
  const claims = [];
  for (let r = 1; r < cv.length; r++) if (cv[r][0]) claims.push(claimObj_(cv[r]));
  const iv = ss.getSheetByName(CFG.SHEET_ITEMS).getDataRange().getValues();
  const I = k => ITEM_HEADERS.indexOf(k);
  const items = [];
  for (let r = 1; r < iv.length; r++) {
    if (iv[r][0]) items.push([String(iv[r][0]), String(iv[r][I('계정과목')] || '미분류'), Number(iv[r][I('금액')]) || 0]);
  }
  const cfg = getAppConfig_();
  return { claims: claims.reverse(), items: items, statuses: CFG.STATUSES, churchName: cfg.churchName };
}

function adminDetail_(claimNo) {
  const ss = getSS_();
  const sh = ss.getSheetByName(CFG.SHEET_CLAIMS);
  const cv = sh.getDataRange().getValues();
  const r = cv.findIndex((row, i) => i > 0 && String(row[0]) === claimNo);
  if (r < 0) throw new Error('청구서를 찾을 수 없습니다.');
  const claim = claimObj_(cv[r]);
  const token = String(cv[r][CLAIM_HEADERS.indexOf('보기토큰')]);
  claim.viewUrl = (ScriptApp.getService().getUrl() || '') + '?view=' + encodeURIComponent(claimNo) + '&t=' + token;
  const folderF = sh.getRange(r + 1, CLAIM_HEADERS.indexOf('영수증 폴더') + 1).getFormula();
  const fm = folderF.match(/HYPERLINK\("([^"]+)"/);
  claim.folderUrl = fm ? fm[1] : '';

  const iv = ss.getSheetByName(CFG.SHEET_ITEMS).getDataRange().getValues();
  const I = k => ITEM_HEADERS.indexOf(k);
  claim.items = iv.filter((row, i) => i > 0 && String(row[0]) === claimNo).map(row => ({
    seq: Number(row[I('순번')]), date: fmt_(row[I('사용일')], 'yyyy-MM-dd'), store: String(row[I('사용처')]),
    account: String(row[I('계정과목')]), desc: String(row[I('내용')]), amount: Number(row[I('금액')]) || 0,
    proof: String(row[I('증빙')]), reason: String(row[I('영수증 없는 사유')]),
    ocrAmount: Number(row[I('자동인식 금액')]) || 0, edited: String(row[I('금액 수정여부')]) === '수정함',
    fileId: String(row[I('영수증파일ID')] || ''),
  }));
  return { claim: claim };
}

function adminReceipt_(fileId) {
  if (!/^[\w-]{10,}$/.test(fileId)) throw new Error('잘못된 요청입니다.');
  // 청구내역에 등록된 영수증만 열람 허용
  const iv = getSS_().getSheetByName(CFG.SHEET_ITEMS).getDataRange().getValues();
  const col = ITEM_HEADERS.indexOf('영수증파일ID');
  if (!iv.some((row, i) => i > 0 && String(row[col]) === fileId)) throw new Error('영수증을 찾을 수 없습니다.');
  const blob = DriveApp.getFileById(fileId).getBlob();
  return { image: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function adminUpdate_(body) {
  const status = String(body.status || '');
  if (CFG.STATUSES.indexOf(status) < 0) throw new Error('알 수 없는 상태입니다.');
  const by = clean_(body.by, 20);
  if (!by) throw new Error('처리자 이름을 설정해 주세요. (⚙ 설정)');
  const note = body.note == null ? null : clean_(body.note, 300);
  if (status === '반려' && !note) throw new Error('반려 사유를 적어 주세요.');
  const want = new Set((body.claimNos || []).map(String));
  if (!want.size) throw new Error('선택된 청구가 없습니다.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSS_();
    const sh = ss.getSheetByName(CFG.SHEET_CLAIMS);
    const cv = sh.getDataRange().getValues();
    const C = k => CLAIM_HEADERS.indexOf(k) + 1;
    const now = new Date();
    const logs = [], updated = [];
    for (let r = 1; r < cv.length; r++) {
      const no = String(cv[r][0]);
      if (!want.has(no)) continue;
      const from = String(cv[r][C('상태') - 1] || '접수');
      sh.getRange(r + 1, C('상태')).setValue(status);
      sh.getRange(r + 1, C('처리일')).setValue(status === '접수' ? '' : now);
      sh.getRange(r + 1, C('처리자')).setValue(by);
      if (note !== null) sh.getRange(r + 1, C('재정부 메모')).setValue(note);
      logs.push([now, no, from, status, by, note || '']);
      updated.push(no);
    }
    if (logs.length) {
      const log = ss.getSheetByName(CFG.SHEET_LOG) || ensureSheet_(ss, CFG.SHEET_LOG, LOG_HEADERS);
      log.getRange(log.getLastRow() + 1, 1, logs.length, LOG_HEADERS.length).setValues(logs);
    }
    SpreadsheetApp.flush();
    const fresh = sh.getDataRange().getValues();
    return { claims: fresh.filter((row, i) => i > 0 && want.has(String(row[0]))).map(claimObj_), updated: updated.length };
  } finally {
    lock.releaseLock();
  }
}

/* ───────────────────────── 인쇄용 청구서 화면 ───────────────────────── */

function renderClaimView_(claimNo, token) {
  const ss = getSS_();
  const cv = ss.getSheetByName(CFG.SHEET_CLAIMS).getDataRange().getValues();
  const iTok = CLAIM_HEADERS.indexOf('보기토큰');
  const row = cv.find((r, i) => i > 0 && String(r[0]) === String(claimNo));
  if (!row || !token || String(row[iTok]) !== String(token)) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:24px">청구서를 찾을 수 없습니다.</p>');
  }
  const H = k => row[CLAIM_HEADERS.indexOf(k)];
  const tz = Session.getScriptTimeZone() || 'Asia/Seoul';
  const items = ss.getSheetByName(CFG.SHEET_ITEMS).getDataRange().getValues().filter((r, i) => i > 0 && String(r[0]) === String(claimNo));
  const itemFormulas = ss.getSheetByName(CFG.SHEET_ITEMS).getDataRange().getFormulas();
  const itemValues = ss.getSheetByName(CFG.SHEET_ITEMS).getDataRange().getValues();

  const won = n => Number(n || 0).toLocaleString('ko-KR');
  const fmtDate = v => v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : escape_(v);

  let rowsHtml = '', imgsHtml = '';
  items.forEach(r => {
    rowsHtml += '<tr><td>' + r[1] + '</td><td>' + fmtDate(r[2]) + '</td><td>' + escape_(r[3]) + '</td><td>' + escape_(r[4]) +
      '</td><td>' + escape_(r[5]) + (r[8] ? '<br><small>※ 영수증 없음: ' + escape_(r[8]) + '</small>' : '') +
      '</td><td class="n">' + won(r[6]) + '</td></tr>';
  });
  // 영수증 이미지 (시트의 HYPERLINK 수식에서 파일 ID 추출)
  itemValues.forEach((r, i) => {
    if (i === 0 || String(r[0]) !== String(claimNo)) return;
    const f = itemFormulas[i][ITEM_HEADERS.indexOf('영수증')] || '';
    const m = f.match(/\/d\/([\w-]+)/);
    const fid = String(r[ITEM_HEADERS.indexOf('영수증파일ID')] || '') || (m ? m[1] : '');
    if (!fid) return;
    try {
      const blob = DriveApp.getFileById(fid).getBlob();
      imgsHtml += '<figure><figcaption>' + r[1] + '번 영수증 · ' + won(r[6]) + '원</figcaption><img src="data:' +
        blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) + '"></figure>';
    } catch (e) {}
  });

  const church = escape_(getAppConfig_().churchName || '');
  const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>청구서 ' + escape_(claimNo) + '</title><style>' +
    'body{font-family:"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#222;margin:0;padding:24px;background:#fff}' +
    'h1{text-align:center;letter-spacing:.5em;margin:0 0 4px}.sub{text-align:center;color:#666;margin:0 0 20px}' +
    'table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px}th,td{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top}' +
    'th{background:#f2f2f2;white-space:nowrap}.n{text-align:right;white-space:nowrap}.total td{font-weight:700;background:#fafafa}' +
    '.sign{display:flex;justify-content:flex-end;gap:0;margin:8px 0 24px}.sign div{border:1px solid #999;width:80px;text-align:center;font-size:13px}' +
    '.sign div span{display:block;border-bottom:1px solid #999;padding:4px;background:#f2f2f2}.sign div i{display:block;height:48px}' +
    'figure{margin:0 0 16px;page-break-inside:avoid}figure img{max-width:100%;max-height:900px;border:1px solid #ddd}figcaption{font-size:13px;color:#555;margin-bottom:4px}' +
    '.btn{position:fixed;right:16px;bottom:16px;padding:12px 18px;border:0;border-radius:10px;background:#2f5d50;color:#fff;font-size:15px}' +
    '@media print{.btn{display:none}body{padding:0}.imgs{page-break-before:always}}</style></head><body>' +
    '<h1>지출청구서</h1><p class="sub">' + church + ' 재정부</p>' +
    '<div class="sign"><div><span>담당</span><i></i></div><div><span>회계</span><i></i></div><div><span>재정부장</span><i></i></div><div><span>담임목사</span><i></i></div></div>' +
    '<table><tr><th>청구번호</th><td>' + escape_(claimNo) + '</td><th>접수일시</th><td>' +
    (H('접수일시') instanceof Date ? Utilities.formatDate(H('접수일시'), tz, 'yyyy-MM-dd HH:mm') : '') + '</td></tr>' +
    '<tr><th>청구자</th><td>' + escape_(H('청구자')) + '</td><th>부서</th><td>' + escape_(H('부서')) + '</td></tr>' +
    '<tr><th>연락처</th><td>' + escape_(H('연락처')) + '</td><th>상태</th><td>' + escape_(H('상태')) + '</td></tr>' +
    '<tr><th>입금계좌</th><td colspan="3">' + escape_(H('은행')) + ' ' + escape_(H('계좌번호')) + ' (예금주: ' + escape_(H('예금주')) + ')</td></tr>' +
    '<tr><th>청구사유</th><td colspan="3">' + escape_(H('청구사유/메모')) + '</td></tr></table>' +
    '<table><tr><th>No</th><th>사용일</th><th>사용처</th><th>계정과목</th><th>내용</th><th class="n">금액(원)</th></tr>' + rowsHtml +
    '<tr class="total"><td colspan="5">합계 (' + H('건수') + '건)</td><td class="n">' + won(H('총금액')) + '</td></tr></table>' +
    '<div class="imgs">' + imgsHtml + '</div><button class="btn" onclick="window.print()">🖨 인쇄 / PDF 저장</button></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('청구서 ' + claimNo)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ───────────────────────── 도우미 함수 ───────────────────────── */

function getSS_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#2f5d50').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  return sh;
}

function ensureSettingsSheet_(ss) {
  let sh = ss.getSheetByName(CFG.SHEET_SETTINGS);
  if (sh) return sh;
  sh = ss.insertSheet(CFG.SHEET_SETTINGS);
  sh.getRange(1, 1, 1, 5).setValues([['부서', '계정과목', '', '설정항목', '값']])
    .setFontWeight('bold').setBackground('#2f5d50').setFontColor('#ffffff');
  const n = Math.max(DEFAULT_DEPTS.length, DEFAULT_ACCOUNTS.length);
  const rows = [];
  for (let i = 0; i < n; i++) rows.push([DEFAULT_DEPTS[i] || '', DEFAULT_ACCOUNTS[i] || '']);
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
  sh.getRange(2, 4, 2, 2).setValues([['교회이름', '장유중앙교회'], ['알림이메일', '']]);
  sh.getRange(5, 4).setValue('※ 부서·계정과목은 자유롭게 추가/삭제하세요. 알림이메일을 적으면 청구가 들어올 때 메일이 갑니다.')
    .setFontColor('#777777');
  sh.setFrozenRows(1);
  return sh;
}

function getRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  let parent = DriveApp.getRootFolder();
  try {
    const parents = DriveApp.getFileById(getSS_().getId()).getParents();
    if (parents.hasNext()) parent = parents.next();
  } catch (e) {}
  const folder = parent.createFolder(CFG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getTempFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('TEMP_FOLDER_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const folder = getOrCreateSubfolder_(getRootFolder_(), CFG.TEMP_FOLDER_NAME);
  props.setProperty('TEMP_FOLDER_ID', folder.getId());
  return folder;
}

function getOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function isInFolder_(file, folderId) {
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) return true;
  return false;
}

function dataUrlToBlob_(dataUrl, name) {
  const m = String(dataUrl).match(/^data:([\w\/+.-]+);base64,(.+)$/);
  if (!m) throw new Error('이미지 형식이 올바르지 않습니다.');
  if (!/^image\//.test(m[1])) throw new Error('이미지 파일만 올릴 수 있습니다.');
  return Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name);
}

function clean_(v, max) {
  // 시트 수식 주입 방지: = + - @ 로 시작하는 값 앞에 ' 를 붙입니다.
  let s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 100);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

/** 전화번호·계좌번호처럼 앞자리 0이 사라지면 안 되는 값은 텍스트로 저장합니다. */
function text_(v, max) {
  const s = clean_(v, max);
  return s && s.charAt(0) !== "'" ? "'" + s : s;
}

function escape_(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 30일이 지난 임시(인식만 하고 제출하지 않은) 영수증을 정리합니다. 트리거로 주 1회 실행을 권장합니다. */
function cleanupTempFiles() {
  const limit = Date.now() - 30 * 86400000;
  const files = getTempFolder_().getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getDateCreated().getTime() < limit) f.setTrashed(true);
  }
}
