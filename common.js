/* 교인용 앱과 재정부 앱이 함께 쓰는 기능: 바탕화면 설치, 오프라인 저장 */
window.FC = (() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const ua = navigator.userAgent;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isKakao = /KAKAOTALK/i.test(ua);
  const isInApp = isKakao || /NAVER\(inapp|Instagram|FBAN|FBAV|Line\//i.test(ua);
  const isSamsung = /SamsungBrowser/i.test(ua);

  /** 필요한 요소: #installCard, #btnInstall, #dlgInstall, #installGuide */
  function setupInstall(toast) {
    let deferredPrompt = null;
    const card = $('#installCard');
    const update = () => { if (card) card.hidden = isStandalone(); };
    update();

    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; update(); });
    window.addEventListener('appinstalled', () => { deferredPrompt = null; update(); toast && toast('바탕화면에 설치되었습니다 🎉'); });

    $('#btnInstall').addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        deferredPrompt = null;
        if (outcome === 'accepted' && toast) toast('설치 중입니다…');
        return;
      }
      let html;
      if (isInApp) {
        const ext = isKakao && !isIOS
          ? `<p><a class="btn primary block" href="kakaotalk://web/openExternal?url=${encodeURIComponent(location.href)}">크롬으로 열기</a></p>` : '';
        html = `<p>카카오톡·네이버 등 <b>앱 안의 브라우저</b>에서는 설치할 수 없어요.</p>
          <ol><li>오른쪽 아래(또는 위) <b>⋮ / 공유</b> 메뉴를 누르고</li>
          <li><b>${isIOS ? 'Safari로 열기' : '다른 브라우저로 열기(크롬)'}</b>를 선택한 뒤</li>
          <li>다시 <b>📲 설치</b> 버튼을 눌러 주세요.</li></ol>${ext}`;
      } else if (isIOS) {
        html = `<ol class="steps">
          <li>화면 아래(또는 위)의 <b>공유 버튼</b> <span class="kbd">⬆︎</span> 을 누르세요.</li>
          <li>목록을 내려 <b>‘홈 화면에 추가’</b> <span class="kbd">＋</span> 를 누르세요.</li>
          <li>오른쪽 위 <b>‘추가’</b>를 누르면 바탕화면에 아이콘이 생깁니다.</li></ol>
          <p class="muted small">※ 아이폰은 반드시 <b>Safari</b>에서 열어야 합니다.</p>`;
      } else if (isSamsung) {
        html = `<ol class="steps"><li>아래쪽 <b>메뉴 ≡</b> 를 누르세요.</li>
          <li><b>‘현재 페이지 추가’ → ‘홈 화면’</b>을 선택하세요.</li></ol>`;
      } else {
        html = `<ol class="steps"><li>크롬 오른쪽 위 <b>⋮ 메뉴</b>를 누르세요.</li>
          <li><b>‘홈 화면에 추가’</b> 또는 <b>‘앱 설치’</b>를 선택하세요.</li></ol>
          <p class="muted small">※ 메뉴가 보이지 않으면 잠시 후 다시 눌러 주세요.</p>`;
      }
      $('#installGuide').innerHTML = html;
      $('#dlgInstall').showModal();
    });
  }

  /** 서비스 워커(sw.js)는 저장소 맨 위 폴더에 있습니다. */
  function registerSW(path = 'sw.js') {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => navigator.serviceWorker.register(path).catch(() => {}));
  }

  return { setupInstall, registerSW, isStandalone };
})();
