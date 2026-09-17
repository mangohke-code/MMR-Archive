// 전역 데이터 캐시 (구조는 예전 Apps Script 버전과 동일하게 유지 — 탭별 렌더 로직은 그대로 재사용)
const APP_DATA = {
  ready: false,
  main: null,
  pickup: null,
  costume: null,
  souvenir: null,
  stage: null,
  unreleased: null,
  nikkeImg: null,
  iconImg: null,
  chapImg: null,
  soloraid: null,
};
// 기간이 지나면 다시 안 나오는 한정 니케. 카드에 '한정' 배지를 붙일지 정하는 데 쓴다.
// 메인 페이지와 픽업 기록이 같은 기준으로 봐야 해서 여기 한 군데에 둔다 - 예전에는
// main.js 와 pickup.js 에 따로 복사돼 있어서 시즌이 늘 때 한쪽만 고쳐질 수 있었다.
// (두 파일 다 최상위 스크립트라 같은 이름을 각자 const 로 선언하면 아예 안 돈다.)
const LIMITED_SEASONS = ['콜라보', '여름', '할로윈', '크리스마스'];

// 로드 완료 후 실행할 콜백 목록
const _onReadyCallbacks = [];

function onAppDataReady(fn) {
  if (APP_DATA.ready) {
    fn();
  } else {
    _onReadyCallbacks.push(fn);
  }
}

// 새로고침해도 보던 탭이 그대로 남도록 주소에 탭 이름을 적는다. 깃허브 페이지는
// 서버 쪽 라우팅을 못 하므로 경로(/stage)가 아니라 # 뒤에 붙인다. 경로로 적으면
// 새로고침이 404 가 난다. 메인은 # 없이 깔끔하게 둔다.
function tabUrl(tabName) {
  return tabName === 'main' ? location.pathname + location.search : '#' + tabName;
}
// 주소의 # 가 실제로 있는 탭을 가리킬 때만 그 이름을 돌려준다.
function tabFromHash() {
  const name = String(location.hash || '').replace(/^#/, '');
  if (!/^[a-z0-9_-]+$/i.test(name)) return null;
  return document.querySelector('.tab-btn[data-tab="' + name + '"]') ? name : null;
}

// 탭 이동은 방문 기록을 쌓지 않는다(주소의 # 만 갈아 끼운다).
//
// 예전에는 탭마다 기록을 쌓아서, 메인->픽업->유니크 로 옮긴 뒤 뒤로 가기를 누르면
// 유니크->픽업->메인 으로 탭이 되돌아갔다. 보던 탭 안에서 뒤로 가려던 사람에게는
// 갑자기 다른 탭으로 튀는 셈이라 어리둥절하다. 이제 기록은 탭 "안"에서 연 것
// (보스 상세, 코스튬 상세, 미실장 상세)만 쌓는다. 그래서 뒤로 가기는 늘 지금
// 보고 있는 탭 안에서만 움직인다.
//
// pushHistory 는 이름을 남겨 둔다 - 부르는 곳이 여럿이고, false 면 주소도 안 건드린다.
function switchTab(tabName, pushHistory = true) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');

  // 솔로 레이드는 3D 뷰어가 화면을 꽉 채우는 전용 배치를 쓴다. 헤더/푸터를 접고
  // 탭 바만 얇게 남긴다. 다른 탭으로 나가면 원래 배치로 돌아온다.
  document.body.classList.toggle('app-mode', tabName === 'soloraid');
  // 메인을 뺀 나머지 탭도 탭 바를 얇게 쓴다(내용 볼 자리를 더 준다)
  document.body.classList.toggle('compact-nav', tabName !== 'main');

  // 제목 구역이 접히는 탭에서는 테마 버튼을 탭 바 오른쪽 끝으로 옮긴다.
  // 숨기는 게 아니라 버튼을 통째로 옴겨야 헤더를 접어도 살아있다.
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    const host = tabName === 'main'
      ? document.querySelector('header')
      : document.getElementById('tab-nav');
    if (host && themeBtn.parentElement !== host) host.appendChild(themeBtn);
    themeBtn.classList.toggle('in-nav', tabName !== 'main');
  }

  if (pushHistory) {
    // 탭 안에서 열어 둔 단계(mmrStep)는 그대로 들고 간다. 안 그러면 보스를 열어
    // 둔 채 다른 탭에 갔다 오면 그 기록이 지워져서 뒤로 가기가 목록이 아니라
    // 사이트 밖으로 나가 버린다.
    const prev = history.state || {};
    history.replaceState({ ...prev, tab: tabName }, '', tabUrl(tabName));
  }

  // 탭이 바뀐 것을 알린다. 솔로 레이드의 전용 BGM 처럼, 안 보이는 곳에서 계속
  // 돌면 안 되는 것들이 이걸 듣고 멈춘다.
  document.dispatchEvent(new CustomEvent('mmr:tab-change', { detail: { tab: tabName } }));
}

// 브라우저 뒤로가기/앞으로가기 키로 탭 이동이 되도록 지원
window.addEventListener('popstate', e => {
  // 주소창에서 # 만 직접 고친 경우에는 state 가 없으므로 # 를 대신 본다.
  const tabName = (e.state && e.state.tab) || tabFromHash() || 'main';
  switchTab(tabName, false);
});

// ===== 탭 안에서만 도는 뒤로가기 =====
//
// 탭 안에서 뭔가를 열 때(보스 상세·코스튬 상세·미실장 상세) 기록을 하나 쌓아 두고,
// 뒤로 가기로 그 기록이 빠지면 닫는다. 탭 이동은 기록을 안 쌓으므로 뒤로 가기가
// 탭을 넘나들지 않는다.
//
// key 는 상태를 알아보는 이름이다. 같은 단계를 두 번 쌓지 않도록, 지금 항목이 이미
// 그 단계면 아무것도 안 한다.
function pushInTabState(key) {
  try {
    if (history.state && history.state.mmrStep === key) return false;
    history.pushState({ tab: tabFromHash() || 'main', mmrStep: key }, '', location.href);
    return true;
  } catch (e) { return false; }
}

// 열려 있던 단계를 우리 쪽에서 닫을 때(닫기 단추). 쌓아 둔 기록이 지금 항목이면
// 그것만 물린다. 탭을 오간 뒤라도 탭 이동은 기록을 안 쌓으므로 엉뚱한 데로 안 간다.
function popInTabState(key) {
  try {
    if (history.state && history.state.mmrStep === key) { history.back(); return true; }
  } catch (e) {}
  return false;
}

function onError(err) {
  console.error('데이터 로드 실패:', err);
}

// 전체 페이지 공통: 이미지 드래그/우클릭(컨텍스트 메뉴) 방지
document.addEventListener('dragstart', e => {
  if (e.target.tagName === 'IMG') e.preventDefault();
});
document.addEventListener('contextmenu', e => {
  if (e.target.tagName === 'IMG') e.preventDefault();
});

// 전체 페이지 공통: 마우스를 따라다니는 툴팁 (data-tooltip 속성이 있는 요소에 호버 시 표시)
(function () {
  const tooltip = document.getElementById('hover-tooltip');
  if (!tooltip) return;
  let currentTarget = null;

  document.addEventListener('mouseover', e => {
    const target = e.target.closest('[data-tooltip]');
    if (target && target.closest('[data-tooltip-off]')) return;
    // 툴팁을 끈 구역(보스 서랍 목록처럼 촘촘한 곳)에서는 안 띄운다.
    if (target && target.closest('[data-tooltip-off]')) return;
    if (!target || !target.dataset.tooltip) return;
    currentTarget = target;
    tooltip.textContent = target.dataset.tooltip;
    tooltip.classList.remove('hidden');
  });

  document.addEventListener('mousemove', e => {
    if (!currentTarget) return;
    tooltip.style.left = e.clientX + 'px';
    tooltip.style.top = e.clientY + 'px';
  });

  document.addEventListener('mouseout', e => {
    const target = e.target.closest('[data-tooltip]');
    if (!target) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    currentTarget = null;
    tooltip.classList.add('hidden');
  });
})();

// 그 스켈레톤에 실제로 들어 있는 것 중에서 대기용 애니메이션을 고른다.
//
// 여태 'idle' 을 못 박아 썼는데, 코스튬 몇 개는 _action.skel 이라 action 하나만 들어 있다
// (나유타 무위 · 목단 화중지왕 · 리틀 머메이드 어비스 플라워). 없는 이름을 SpinePlayer 설정에
// 넘기면 "Animation does not exist in skeleton" 예외가 나면서 뷰어가 통째로 안 뜬다.
function pickSpineAnimation(skeletonData) {
  if (!skeletonData || !skeletonData.animations || !skeletonData.animations.length) return undefined;
  const names = skeletonData.animations.map(a => a.name);
  return names.includes('idle') ? 'idle' : names[0];
}

// L2D 파츠(스킨) on/off 토글 UI — costume.js/unreleased.js 공용
// skins: default를 제외한 spine.Skin 배열, enabledSet: 현재 켜져있는 스킨 이름 Set
// opts.style 이 'button' 이면 스위치 줄 대신 버튼 칩으로 그린다. 항목이 한둘뿐인
// 곳(코스튬 추가 파츠)은 줄 하나씩 차지하는 스위치보다 칩이 자리를 덜 먹는다.
function renderPartsToggle(containerId, skins, enabledSet, onChange, opts) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!skins.length) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  // 3D 뷰어에는 이름이 겹치는 메쉬가 있는 보스가 있어서(앨트루이아 helm_01~09 등)
  // 이름 대신 partKey 로 구분한다. Spine 쪽 호출부는 partKey 가 없으니 이름으로 떨어진다.
  const keyOf = skin => skin.partKey || skin.name;
  const asButton = !!(opts && opts.style === 'button');

  container.classList.remove('hidden');
  container.classList.toggle('is-button-style', asButton);
  container.innerHTML = skins.map(skin => asButton
    ? `<button type="button" class="anim-btn part-toggle-item${enabledSet.has(keyOf(skin)) ? ' active' : ''}" data-skin="${keyOf(skin)}">${skin.label || skin.name}</button>`
    : `<div class="toggle-switch-wrap part-toggle-item${enabledSet.has(keyOf(skin)) ? ' active' : ''}" data-skin="${keyOf(skin)}">
      <div class="toggle-switch"></div>
      <span class="toggle-label">${skin.label || skin.name}</span>
    </div>`
  ).join('');

  container.querySelectorAll('.part-toggle-item').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.skin;
      const isActive = el.classList.toggle('active');
      if (isActive) enabledSet.add(name); else enabledSet.delete(name);
      onChange();
    });
  });
}

// L2D 뷰어(유니크 코스튬·미실장)의 왼쪽 조작판 접기. 솔로 레이드 뷰어와 같은 감각으로
// 손잡이 하나만 남기고 판을 접는다. 판이 그림 칸의 형제라서 접으면 그림이 그만큼 넓어진다.
function setupL2dSideToggle(wrapId, toggleId) {
  const wrap = document.getElementById(wrapId);
  const btn = document.getElementById(toggleId);
  if (!wrap || !btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const closed = wrap.classList.toggle('is-side-closed');
    btn.setAttribute('aria-expanded', String(!closed));
    btn.title = closed ? '조작판 펴기' : '조작판 접기';
  });
}

// 이름이 칸을 넘칠 때만 좌우로 스크롤되는 애니메이션 적용 (픽업 기록 탭의 니케 카드/
// 몰아보기 니케 이름). CSS keyframe만으로는 실제 텍스트 폭을 알 수 없어서 정해진
// 거리만큼 무조건 움직이게 되는데, 그러면 칸이 넉넉해서 필요 없을 때도 움직이거나,
// 칸이 좁아서 실제로 넘치는 양보다 덜 움직여서(이름이 끝까지 안 보임) 문제가 생긴다.
// wrap(overflow:hidden)과 그 안의 name 요소 실제 폭 차이를 재서, 넘치는 경우에만
// 그 넘치는 만큼을 --scroll-distance로 넣고 애니메이션 클래스를 붙인다.
// 읽기(scrollWidth/clientWidth)와 쓰기(style)를 분리해서 레이아웃 스래싱을 피한다.
function syncNameScrollAnimations(root, wrapSelector, nameSelector) {
  const wraps = root.querySelectorAll(wrapSelector);
  const toAnimate = [];
  wraps.forEach(wrap => {
    const nameEl = wrap.querySelector(nameSelector);
    if (!nameEl) return;
    nameEl.classList.remove('is-scrolling');
    nameEl.style.removeProperty('--scroll-distance');
    const overflow = nameEl.scrollWidth - wrap.clientWidth;
    if (overflow > 1) toAnimate.push({ nameEl, overflow });
  });
  toAnimate.forEach(({ nameEl, overflow }) => {
    nameEl.style.setProperty('--scroll-distance', `-${overflow}px`);
    nameEl.classList.add('is-scrolling');
  });
}

// L2D 캔버스 드래그 이동(팬) + 휠 확대/축소 — spine-player 라이브러리 자체엔 이 기능이 없어서 직접 구현.
// 이전 버전은 spine 내부 camera/currentViewport를 직접 조작했는데, 상호작용 시 캐릭터가 사라지는
// 문제가 있었고 원인을 확정 짓지 못했다. 같은 니케 L2D 에셋을 쓰는 다른 사이트(Nikke-db.github.io)의
// 공개 소스를 참고해보니, 그쪽은 spine 내부를 전혀 건드리지 않고 **spine이 렌더링되는 바깥 div를
// 순수 CSS로 옮기고 크기만 조절**하는 방식이었다 — spine-player는 매 프레임 자기 canvas의
// clientWidth/clientHeight를 읽어서 알아서 다시 그리기 때문에, 바깥 컨테이너만 크게/작게 하거나
// 위치를 옮기면 알아서 그 크기·위치에 맞게 다시 렌더링된다. spine 내부 상태를 전혀 건드리지 않으므로
// 훨씬 안전하다. container는 wrapEl(overflow:hidden, position:relative) 안에서 position:absolute로
// 움직이고 커진다.
function setupSpinePanZoom(container, wrapEl) {
  container.style.position = 'absolute';
  container.style.left = '0px';
  container.style.top = '0px';

  const baseWidth = container.offsetWidth;
  const baseHeight = container.offsetHeight;
  const MIN_SCALE = 0.3, MAX_SCALE = 5;

  let scale = 1, offsetX = 0, offsetY = 0;

  // 캐릭터가 화면 밖으로 완전히 나가버리지 않도록, 너무 멀리 옮기면 벽에 막힌 느낌으로 멈추게 함
  function clampOffsets(w, h) {
    const wrapW = wrapEl.clientWidth;
    const wrapH = wrapEl.clientHeight;
    const minX = Math.min(0, wrapW - w);
    const maxX = Math.max(0, wrapW - w);
    offsetX = Math.max(minX, Math.min(maxX, offsetX));
    const minY = Math.min(0, wrapH - h);
    const maxY = Math.max(0, wrapH - h);
    offsetY = Math.max(minY, Math.min(maxY, offsetY));
  }

  function apply() {
    const w = baseWidth * scale;
    const h = baseHeight * scale;
    clampOffsets(w, h);
    container.style.width = w + 'px';
    container.style.height = h + 'px';
    container.style.left = offsetX + 'px';
    container.style.top = offsetY + 'px';
  }

  let dragging = false, dragMoved = false;
  let dragStartX = 0, dragStartY = 0, startOffsetX = 0, startOffsetY = 0;

  // 조작판은 그림 칸과 같은 상자 안에 들어 있다. 판 위에서 끌거나 굴린 것을
  // 그림 옮기기로 받으면 버튼을 누르다가 캐릭터가 따라 움직인다.
  const fromPanel = e =>
    !!(e.target && e.target.closest && e.target.closest('.l2d-side, .l2d-side-toggle'));

  const onMouseDown = e => {
    if (fromPanel(e)) return;
    e.preventDefault();
    dragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    startOffsetX = offsetX;
    startOffsetY = offsetY;
  };

  const onMouseMove = e => {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (!dragMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dragMoved = true;
    if (!dragMoved) return;
    offsetX = startOffsetX + dx;
    offsetY = startOffsetY + dy;
    apply();
  };

  let justDragged = false;
  const onMouseUp = () => {
    dragging = false;
    if (dragMoved) justDragged = true;
  };

  // 드래그 직후 발생하는 click은 캐릭터의 액션 애니메이션 재생으로 넘어가지 않도록 차단
  // — capture 단계라 canvas까지 이벤트가 내려가기 전에 먼저 실행됨
  const onClickCapture = e => {
    if (fromPanel(e)) return;
    if (e.target.closest && e.target.closest('.spine-reset-btn')) return;
    if (justDragged) {
      e.stopPropagation();
      e.preventDefault();
      justDragged = false;
    }
  };

  const onWheel = e => {
    if (fromPanel(e)) return;   // 판 안에서는 목록을 굴려야 한다
    e.preventDefault();
    const rect = wrapEl.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    const actualFactor = newScale / scale;

    // 커서 아래 지점이 확대/축소 후에도 같은 화면 위치에 남도록 offset 보정
    offsetX = mouseX - (mouseX - offsetX) * actualFactor;
    offsetY = mouseY - (mouseY - offsetY) * actualFactor;
    scale = newScale;

    apply();
  };

  wrapEl.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  wrapEl.addEventListener('click', onClickCapture, true);
  wrapEl.addEventListener('wheel', onWheel, { passive: false });

  const api = () => {};
  api.destroy = () => {
    wrapEl.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    wrapEl.removeEventListener('click', onClickCapture, true);
    wrapEl.removeEventListener('wheel', onWheel);
    container.style.position = '';
    container.style.left = '';
    container.style.top = '';
    container.style.width = '';
    container.style.height = '';
  };
  api.reset = () => {
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    apply();
  };
  return api;
}

// ===== Supabase 데이터 조회 → 예전 APP_DATA 모양으로 조립 =====
// (테이블/컬럼 이름이 전부 한글이라 r['컬럼명'] 형태로 접근)

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function buildMainData(configRows, eventRows, pickupData) {
  const updateLog = configRows
    .map(r => ({ date: r['날짜'], note: r['업데이트_내역'] }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const eventSeasonMap = {};
  pickupData.forEach(p => {
    if (p['이벤트'] && !eventSeasonMap[p['이벤트']]) eventSeasonMap[p['이벤트']] = p['시즌'];
  });

  return {
    updateLog: updateLog.slice(0, 5),
    events: eventRows.map(e => ({
      '이벤트명': e['이벤트명'],
      '시작일': e['시작일'],
      '종료일': e['종료일'],
      '이미지': e['이미지'],
      '신규복각': e['신규복각'],
      '시즌': eventSeasonMap[e['이벤트명']] || '',
    })),
  };
}

// 오버스펙: 기업마다 존재하는, 같은 기업의 다른 니케보다 성능이 훨씬 우월한 니케.
// 별도 열 없이 픽업 데이터의 '기업' 값 자체에 "엘리시온(오)"처럼 접미사를 붙여서
// 표시한다 - 매칭/아이콘 조회 등 "검증"에는 이 값을 그대로 쓰고, 화면에 문구를
// 보여줄 때만 getBaseCompany()로 접미사를 뗀다. IMG_아이콘 테이블에도 같은 접미사가
// 붙은 전용 아이콘("엘리시온(오)")을 별도로 등록해서 쓴다.
const OVERSPEC_SUFFIX = '(오)';

function getBaseCompany(company) {
  if (!company) return company;
  return company.endsWith(OVERSPEC_SUFFIX) ? company.slice(0, -OVERSPEC_SUFFIX.length) : company;
}

// 콜라보 픽업 판별: 기업 소속이 '어브노말'인 니케는 전부 콜라보 출신이다.
// (콜라보 니케만 어브노말에 들어가므로 별도 열 없이 이 조건 하나로 판단한다)
const COLLAB_COMPANY = '어브노말';

function isCollabCompany(company) {
  return getBaseCompany(company) === COLLAB_COMPANY;
}

function buildPickupData(rows) {
  const seenNames = new Set();
  const list = rows.map(r => {
    const obj = {
      '시즌': r['시즌'], '이벤트': r['이벤트'], '시작일': r['시작일'], '종료일': r['종료일'],
      '니케': r['니케'], '기업': r['기업'], '유형': r['유형'], '버스트': r['버스트'],
      '우월코드': r['우월코드'], '총기': r['총기'], '픽업 배너': r['픽업_배너'],
    };
    // 복각 판별: 이름이 이미 나온 적 있고, 기업/유형/버스트/우월코드/총기가 전부 비어있으면 복각으로 취급 (원본 시트 F~J열 규칙과 동일)
    const infoEmpty = !r['기업'] && !r['유형'] && !r['버스트'] && !r['우월코드'] && !r['총기'];
    const isDuplicate = seenNames.has(r['니케']);
    obj['복각'] = isDuplicate && infoEmpty;
    seenNames.add(r['니케']);
    return obj;
  });

  // 복각 니케에 최초 등장 행의 정보(픽업 배너 포함) 채우기 — 여러 탭이 공유하는 데이터라 여기서 한 번만 처리
  const firstAppearance = {};
  list.forEach(p => {
    if (!p['복각'] && !firstAppearance[p['니케']]) firstAppearance[p['니케']] = p;
  });
  list.forEach(p => {
    if (p['복각'] && firstAppearance[p['니케']]) {
      ['기업', '유형', '버스트', '우월코드', '총기', '픽업 배너'].forEach(attr => {
        if (!p[attr]) p[attr] = firstAppearance[p['니케']][attr];
      });
    }
  });

  return list;
}

// IMG_Nikke의 코스튬1/코스튬2 중 코스튬명이 일치하는 쪽의 썸네일 이미지를 찾는다.
// 일치하는 게 없으면(신규 코스튬이 아직 IMG_Nikke에 반영 안 된 경우 등) 코스튬1 이미지로 대체한다.
function getCostumeThumbUrl(nikkeImg, costumeName) {
  if (!nikkeImg) return '';
  for (const n of [1, 2]) {
    if (nikkeImg[`코스튬${n}`] === costumeName) {
      return nikkeImg[`코스튬${n} 이미지`] ?? nikkeImg[`코스튬${n}이미지`] ?? '';
    }
  }
  return nikkeImg['코스튬1 이미지'] ?? nikkeImg['코스튬1이미지'] ?? '';
}

// "추가_파츠" 컬럼: 파츠가 하나의 skel/atlas가 아니라 여러 파일로 나뉜 코스튬을 위한 것.
// 한 줄에 파츠 하나씩, 형식은 "skel주소,atlas주소" (기본 텍스처보다 앞에 그려짐) 또는
// "뒤,skel주소,atlas주소" (기본 텍스처보다 뒤에 그려짐). 앞/뒤 표시를 생략하면 앞으로 취급한다.
// "바리에이션" 컬럼: 한 줄에 하나씩 "이름,skel주소,atlas주소".
// 이름을 안 적으면 순서대로 번호를 붙인다.
function parseCostumeVariations(raw) {
  if (!raw) return [];
  return String(raw).split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      const cols = line.split(',').map(s => (s || '').trim());
      if (cols.length >= 3) return { name: cols[0], skel: cols[1], atlas: cols[2] };
      return { name: `모델 ${i + 2}`, skel: cols[0], atlas: cols[1] };
    })
    .filter(v => v.skel && v.atlas);
}

function parseCostumeExtraParts(raw) {
  if (!raw) return [];
  return raw.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const cols = line.split(',').map(s => (s || '').trim());
      let order = '앞';
      let skel, atlas;
      if (cols.length >= 3 && (cols[0] === '뒤' || cols[0] === '앞')) {
        order = cols[0];
        skel = cols[1];
        atlas = cols[2];
      } else {
        skel = cols[0];
        atlas = cols[1];
      }
      return { skel, atlas, order };
    })
    .filter(p => p.skel && p.atlas);
}

function buildCostumeData(rows) {
  return rows.map(r => ({
    '니케': r['니케'],
    '코스튬명': r['코스튬명'],
    '시작일': r['시작일'],
    '종료일': r['종료일'],
    '복각 시작일': r['복각_시작일'],
    '복각 종료일': r['복각_종료일'],
    '티켓': r['티켓'],
    '티켓 설명': r['티켓_설명'],
    '무료티켓': r['무료티켓'],
    '유료티켓': r['유료티켓'],
    'skel': r['skel'],
    'atlas': r['atlas'],
    '추가 파츠': parseCostumeExtraParts(r['추가_파츠']),
    // 같은 코스튬의 다른 모델(목단 화중지왕의 c281_98 처럼). 파츠처럼 겹쳐 그리는 게
    // 아니라 기본 모델을 통째로 바꿔 끼운다.
    '바리에이션': parseCostumeVariations(r['바리에이션']),
    '픽업 배너': r['픽업_배너'],
  }));
}

function buildSouvenirData(rows) {
  return rows.filter(r => r['이름']).map(r => ({
    '이름': r['이름'],
    '이벤트': r['이벤트'],
    '시즌': r['시즌'],
    '이미지': r['이미지'],
    '획득 방법': r['획득_방법'],
    '설명': r['설명'],
    '스포일러': r['스포일러'],
  }));
}

function buildStageData(rows) {
  return rows.map(r => ({
    '챕터': r['챕터'],
    '스테이지': r['스테이지'],
    '노말전투력': r['노말전투력'],
    '노말보스': r['노말보스'],
    '노말약점': r['노말약점'],
    '노말유형': r['노말유형'],
    '하드전투력': r['하드전투력'],
    '하드보스': r['하드보스'],
    '하드약점': r['하드약점'],
    '하드유형': r['하드유형'],
    '스토리': r['스토리'],
    '특이사항': r['특이사항'],
  }));
}

function buildUnreleasedData(rows) {
  return rows.filter(r => r['이름1'] || r['이름2']).map(r => ({
    '이름1': r['이름1'], '소속1': r['소속1'], '스쿼드1': r['스쿼드1'], '등장1': r['등장1'], 'skel1': r['skel1'], 'atlas1': r['atlas1'], '이미지1': r['이미지1'],
    '이름2': r['이름2'], '소속2': r['소속2'], '스쿼드2': r['스쿼드2'], '등장2': r['등장2'], 'skel2': r['skel2'], 'atlas2': r['atlas2'], '이미지2': r['이미지2'],
  }));
}

function buildNikkeImgData(rows) {
  return rows.map(r => ({
    '이름': r['이름'],
    '이미지': r['이미지'],
    '코스튬1': r['코스튬1'],
    '코스튬1 이미지': r['코스튬1_이미지'],
    '코스튬2': r['코스튬2'],
    '코스튬2 이미지': r['코스튬2_이미지'],
  }));
}

function buildIconImgData(rows) {
  const result = {};
  rows.forEach(r => {
    const category = r['카테고리'];
    if (!result[category]) result[category] = {};
    result[category][r['키']] = r['이미지'];
  });
  return result;
}

function buildChapImgData(rows) {
  return rows.map(r => ({ '챕터': r['챕터'], '이미지': r['이미지'], '명칭': r['명칭'] }));
}

// 한국시간으로 찍어 준다.
//
// 기간을 날짜만이 아니라 시간까지 저장하면서(timestamptz) 보는 사람의 시간대가 그대로
// 반영된다. 그냥 두면 종료 05:00(KST)이 다른 나라에서는 전날로 보인다. 게임 일정은 한국
// 기준이므로 어디서 보든 한국시간으로 고정해서 보여준다.
function formatKst(value, opts) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const date = `${parts.year}.${parts.month}.${parts.day}`;
  if (!(opts && opts.withTime)) return date;
  // 자정을 24시로 찍는 브라우저가 있어 00 으로 맞춘다
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${date} ${hour}:${parts.minute}`;
}

// 값에 시간이 들어 있는지(날짜만인지) 본다. SQL 로 timestamptz 로 바꾸기 전후 모두
// 자연스럽게 나오도록, 날짜만이면 시간을 안 붙인다.
function hasTimePart(value) {
  return typeof value === 'string' && value.includes('T');
}

// ===== 남은 기간 =====
//
// 예전에는 (목표 - 지금) 을 24시간으로 나눠 올림했다. 그러면 오늘 끝나는 픽업이
// 반나절 남았을 때 0.3 일 -> 올림 1 이 되어 D-1 로 나온다. 오늘 끝나는데 하루
// 남은 것처럼 보이는 것이다.
//
// 그래서 "한국시간 자정을 몇 번 넘겨야 그날이 되는가" 로 센다. 오늘이면 0,
// 내일이면 1 이다. 게임 일정이 한국 기준이라 보는 사람의 시간대와 무관하게
// 같은 값이 나와야 한다.
function kstDayNumber(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return NaN;
  // en-CA 는 YYYY-MM-DD 로 찍어 준다
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return Math.round(Date.parse(ymd + 'T00:00:00Z') / 86400000);
}

function kstDaysUntil(target, now = new Date()) {
  const diff = kstDayNumber(target) - kstDayNumber(now);
  return Number.isNaN(diff) ? 0 : diff;
}

// 시:분까지 들어 있는 값에만 쓴다. 날짜만 있는 값은 그날 몇 시에 끝나는지를
// 알 수 없어서 시간 단위로 말하면 틀린 수가 나온다.
function hoursUntil(target, now = new Date()) {
  const ms = new Date(target) - now;
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60)));
}

// 시간까지 같이 적어 줄 구간. 하루보다 멀면 "733시간" 처럼 읽어도 와닿지 않는
// 수가 되므로 D-n 만 적는다. 곧 바뀌는 것만 시간으로 말해 주면 된다.
//
// 경계는 "남은 시간이 24시간 안쪽인가" 하나로 본다. 내일 05시에 끝나는 것을
// 오늘 04시에 보면 25시간이 남아 D-1, 오늘 06시에 보면 23시간이라 시간으로 적힌다.
const HOUR_DETAIL_LIMIT = 24;

// 배지에 넣을 문구. kind 는 'start' 또는 'end'.
// 시간 정보가 있는 값(이벤트·코스튬·솔로 레이드)은 몇 시간 남았는지도 같이 적는다.
function remainingText(target, kind, now = new Date()) {
  const label = kind === 'start' ? '시작' : '종료';
  const days = kstDaysUntil(target, now);
  if (hasTimePart(target)) {
    const h = hoursUntil(target, now);
    if (days <= 0) return `${label}까지 ${h}시간`;
    if (h <= HOUR_DETAIL_LIMIT) return `${label}까지 D-${days} · ${h}시간`;
    return `${label}까지 D-${days}`;
  }
  return days <= 0 ? `오늘 ${label}` : `${label}까지 D-${days}`;
}

// 픽업 기록 탭 카드처럼 자리가 좁아 D-n 만 적는 곳에서 쓴다.
function remainingShort(target, now = new Date()) {
  const days = kstDaysUntil(target, now);
  if (days > 0) return `D-${days}`;
  return hasTimePart(target) ? `${hoursUntil(target, now)}시간` : 'D-DAY';
}

// 표에 줄만 미리 만들어 둔 보스(시즌이나 이름이 아직 빈 행)는 화면에 올리지 않는다.
// 시즌과 이름이 둘 다 채워진 뒤부터 목록에 나온다.
function soloRaidRowReady(r) {
  const filled = v => v !== null && v !== undefined && String(v).trim() !== '';
  return filled(r['시즌']) && filled(r['보스']);
}

function buildSoloRaidData(rows) {
  return rows.filter(soloRaidRowReady).map(r => ({
    '시즌': r['시즌'],
    '시작일': r['시작일'],
    '종료일': r['종료일'],
    // 점검·버그로 중간에 멈춘 구간. 몇 번을 멈췄든 열을 늘리지 않도록 배열 하나로 받는다.
    // 열이 아직 없는(SQL 실행 전) 상태에서도 화면이 깨지지 않게 빈 배열로 둔다.
    '중단 기간': Array.isArray(r['중단_기간']) ? r['중단_기간'] : [],
    '보스': r['보스'],
    // 표에 "속성"으로 적어온 값은 사실 그 보스의 약점 속성이다. 열 이름을 약점_속성 으로
    // 바꾸는 중이라 새 이름을 먼저 보고 없으면 옛 이름을 쓴다.
    '약점 속성': r['약점_속성'] ?? r['속성'],
    '보스 이미지': r['보스_이미지'],
    'atlas': r['atlas'],
    'skel': r['skel'],
    'model': r['model'],
    '테두리1': r['테두리1'],
    '테두리1 이미지': r['테두리1_이미지'],
    '테두리1 설명': r['테두리1_설명'],
    '테두리2': r['테두리2'],
    '테두리2 이미지': r['테두리2_이미지'],
    '테두리2 설명': r['테두리2_설명'],
    '테두리3': r['테두리3'],
    '테두리3 이미지': r['테두리3_이미지'],
    '테두리3 설명': r['테두리3_설명'],
    // 보스 전용 BGM. 유튜브 주소나 mp3 주소 하나를 그대로 넣어도 되고,
    // 페이즈별로 여러 곳이면 [{"제목":"1페이즈","링크":"..."}] 꼴로 넣는다.
    // 열이 아직 없어도 화면이 깨지지 않게 null 로 둔다.
    'BGM': r['BGM'] ?? r['bgm'] ?? null,
  }));
}

// ===== 방문 기록 =====
// 방문자 수를 세기 위해 브라우저 세션당 한 줄만 남긴다. 개인정보는 담지 않는다 —
// 무작위 세션 키와 유입 도메인뿐이고, 세션 키는 탭을 닫으면 사라진다.
// 실패해도 사이트 동작에는 영향이 없어야 하므로 전부 조용히 넘긴다.
const VISIT_SESSION_KEY = 'mmr_visit_session';

const OWNER_KEY = 'nikke-owner';

function logVisit() {
  try {
    // 로컬 개발 중에는 기록하지 않는다
    if (['localhost', '127.0.0.1', ''].includes(location.hostname)) return;
    // 이미 이 세션에서 기록했으면 다시 보내지 않는다 (새로고침·탭 이동 시 중복 방지)
    if (sessionStorage.getItem(VISIT_SESSION_KEY)) return;

    const 세션 = (crypto.randomUUID && crypto.randomUUID())
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let 유입 = null;
    try {
      const ref = document.referrer;
      // 도메인만 남긴다. 우리 사이트 안에서의 이동은 유입이 아니므로 제외.
      if (ref) {
        const host = new URL(ref).hostname;
        if (host && host !== location.hostname) 유입 = host;
      }
    } catch (e) { /* 잘못된 referrer 는 무시 */ }

    // IP 없이 지역/언어를 가늠하기 위한 값. 브라우저가 알려주는 설정일 뿐이라
    // 개인을 식별하지 않는다. 못 읽으면 그냥 비워 둔다.
    // 내가 들어온 기록은 따로 표시한다. 통계를 볼 때 내 방문이 섞이면 숫자가 흐려진다.
    // 주소에 ?me=1 을 한 번 붙여 들어오면 이 브라우저에 표시가 남고, ?me=0 이면 지운다.
    // 개인을 식별하는 값이 아니라 "이 브라우저는 주인 것" 이라는 표시일 뿐이다.
    try {
      const flag = new URLSearchParams(location.search).get('me');
      if (flag === '1') localStorage.setItem(OWNER_KEY, '1');
      else if (flag === '0') localStorage.removeItem(OWNER_KEY);
    } catch (e) { /* 무시 */ }
    let 본인 = false;
    try { 본인 = localStorage.getItem(OWNER_KEY) === '1'; } catch (e) { /* 무시 */ }

    let 시간대 = null, 언어 = null;
    try { 시간대 = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { /* 무시 */ }
    try { 언어 = navigator.language || null; } catch (e) { /* 무시 */ }

    // 응답을 기다리지 않는다 — 화면 표시를 막지 않도록.
    // 세션 표시는 기록에 성공했을 때만 남긴다. 먼저 표시해 두면 한 번 실패했을 때
    // 그 세션은 새로고침해도 영영 다시 시도하지 않아 통째로 누락된다.
    supabaseClient.from('방문_기록').insert({ 세션, 유입, 시간대, 언어, 본인 }).then(
      res => {
        if (res && res.error) return;
        try { sessionStorage.setItem(VISIT_SESSION_KEY, 세션); } catch (e) { /* 저장 실패는 무시 */ }
      },
      () => {}
    );
  } catch (e) { /* 방문 기록 실패가 사이트를 막아서는 안 된다 */ }
}

// Supabase(PostgREST)는 한 번에 최대 1000행까지만 반환하므로, 그 이상인 테이블(스테이지 정보 등)을
// 위해 다 받을 때까지 range()로 이어붙인다.
// orderColumn 은 1000행을 넘겨 여러 쪽으로 받아야 하는 표에서는 반드시 줘야 한다.
// 정렬이 없으면 각 쪽이 어떤 순서로 올지 정해져 있지 않아서, 쪽 경계에서 행이
// 겹치거나 빠질 수 있다.
async function fetchAll(tableName, orderColumn) {
  const pageSize = 1000;
  let allRows = [];
  let from = 0;
  while (true) {
    let query = supabaseClient.from(tableName).select('*').range(from, from + pageSize - 1);
    if (orderColumn) query = query.order(orderColumn, { ascending: true });
    const res = await query;
    if (res.error) throw res.error;
    allRows = allRows.concat(res.data);
    if (res.data.length < pageSize) break;
    from += pageSize;
  }
  return allRows;
}

async function loadAllData() {
  const [
    pickupRows, costumeRows, souvenirRows, stageRows,
    unreleasedRows, nikkeImgRows, iconRows, chapRows,
    configRows, eventRows,
  ] = await Promise.all([
    fetchAll('픽업_기록', '시작일'),
    fetchAll('유니크_코스튬'),
    fetchAll('기념품'),
    // 번호 순으로 받아야 한다. 스테이지 표는 화면에서 따로 정렬하지 않고 받은
    // 순서대로 그리는데, 정렬을 안 주면 순서가 보장되지 않는다(EX스테이지가
    // 26번 뒤가 아니라 맨 끝에 붙어 있었다). 게다가 이 표는 1,884행이라
    // range() 로 두 쪽에 나눠 받는데, 정렬 없는 페이징은 행이 겹치거나 빠질 수도
    // 있다 -- 순서를 정해줘야 쪽 나누기가 안전해진다.
    fetchAll('스테이지_정보', '번호'),
    fetchAll('미실장_캐릭터'),
    fetchAll('IMG_니케'),
    fetchAll('IMG_아이콘'),
    fetchAll('IMG_챕터'),
    fetchAll('메인_업데이트'),
    fetchAll('메인_이벤트', '시작일'),
  ]);

  const pickup = buildPickupData(pickupRows);
  APP_DATA.main = buildMainData(configRows, eventRows, pickup);
  APP_DATA.pickup = pickup;
  APP_DATA.costume = buildCostumeData(costumeRows);
  APP_DATA.souvenir = buildSouvenirData(souvenirRows);
  APP_DATA.stage = buildStageData(stageRows);
  APP_DATA.unreleased = buildUnreleasedData(unreleasedRows);
  APP_DATA.nikkeImg = buildNikkeImgData(nikkeImgRows);
  APP_DATA.iconImg = buildIconImgData(iconRows);
  APP_DATA.chapImg = buildChapImgData(chapRows);

  // 솔로 레이드는 별도 테이블이라 다른 테이블들과 묶어서 Promise.all로 처리하지 않는다 —
  // 이 테이블에 문제(권한/데이터 없음 등)가 생겨도 나머지 탭이 전부 먹통이 되면 안 되므로,
  // 실패해도 여기서만 조용히 빈 배열로 처리하고 넘어간다.
  // 표 이름을 역대_테두리 → 솔로_레이드 로 바꾸는 중이라 둘 다 시도한다. 이름 변경 SQL 을
  // 언제 실행하든 화면이 깨지지 않게 하려는 것이고, 변경이 끝나면 옛 이름은 지워도 된다.
  APP_DATA.soloraid = [];
  for (const table of ['솔로_레이드', '역대_테두리']) {
    try {
      APP_DATA.soloraid = buildSoloRaidData(await fetchAll(table, '시즌'));
      break;
    } catch (err) {
      console.warn(`[솔로 레이드] ${table} 읽기 실패:`, err.message || err);
    }
  }

  APP_DATA.ready = true;

  _onReadyCallbacks.forEach(fn => fn());
  _onReadyCallbacks.length = 0;
}

document.addEventListener('DOMContentLoaded', function () {
  // 탭 버튼 이벤트
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      switchTab(this.dataset.tab);
    });
  });

  // 새로고침·북마크로 들어온 경우 주소에 적힌 탭을 되살린다. 여기서 history 를
  // 밀면 뒤로가기가 한 번 헛돌므로 replaceState 로 현재 항목에 덮어쓴다.
  const startTab = tabFromHash() || 'main';
  if (startTab !== 'main') switchTab(startTab, false);
  history.replaceState({ tab: startTab }, '', tabUrl(startTab));

  // 테마 토글 (기본 라이트, 다크는 선택 시 localStorage에 저장)
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    const updateThemeIcon = () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      themeToggle.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
    };
    updateThemeIcon();
    themeToggle.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('nikke-theme', 'light');
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('nikke-theme', 'dark');
      }
      updateThemeIcon();
    });
  }

  logVisit();

  // 로딩 소요 시간 표시
  const loadStart = performance.now();
  const timerEl = document.getElementById('loading-timer');
  const loadTimerInterval = setInterval(() => {
    if (timerEl) timerEl.textContent = `${((performance.now() - loadStart) / 1000).toFixed(1)}초`;
  }, 100);

  loadAllData()
    .then(() => {
      clearInterval(loadTimerInterval);
      const totalSec = ((performance.now() - loadStart) / 1000).toFixed(1);
      console.log(`[로딩] 전체 ${totalSec}초`);
      if (timerEl) timerEl.textContent = `${totalSec}초`;

      const overlay = document.getElementById('loading-overlay');
      overlay.classList.add('hidden');
      setTimeout(() => overlay.style.display = 'none', 400);
    })
    .catch(onError);
});
