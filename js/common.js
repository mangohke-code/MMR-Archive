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
  frames: null,
};
// 로드 완료 후 실행할 콜백 목록
const _onReadyCallbacks = [];

function onAppDataReady(fn) {
  if (APP_DATA.ready) {
    fn();
  } else {
    _onReadyCallbacks.push(fn);
  }
}

// pushHistory=false는 popstate(뒤로/앞으로가기)에 반응해서 탭만 바꿀 때 쓴다 —
// 안 그러면 뒤로가기로 전환한 탭이 다시 history에 쌓여서 무한히 앞으로 못 가는 상태가 된다.
function switchTab(tabName, pushHistory = true) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');

  if (pushHistory) {
    history.pushState({ tab: tabName }, '');
  }
}

// 브라우저 뒤로가기/앞으로가기 키로 탭 이동이 되도록 지원
window.addEventListener('popstate', e => {
  const tabName = (e.state && e.state.tab) || 'main';
  switchTab(tabName, false);
});

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

// L2D 파츠(스킨) on/off 토글 UI — costume.js/unreleased.js 공용
// skins: default를 제외한 spine.Skin 배열, enabledSet: 현재 켜져있는 스킨 이름 Set
function renderPartsToggle(containerId, skins, enabledSet, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!skins.length) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = skins.map(skin => `
    <div class="toggle-switch-wrap part-toggle-item${enabledSet.has(skin.name) ? ' active' : ''}" data-skin="${skin.name}">
      <div class="toggle-switch"></div>
      <span class="toggle-label">${skin.label || skin.name}</span>
    </div>
  `).join('');

  container.querySelectorAll('.part-toggle-item').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.skin;
      const isActive = el.classList.toggle('active');
      if (isActive) enabledSet.add(name); else enabledSet.delete(name);
      onChange();
    });
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

  const onMouseDown = e => {
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
    if (e.target.closest && e.target.closest('.spine-reset-btn')) return;
    if (justDragged) {
      e.stopPropagation();
      e.preventDefault();
      justDragged = false;
    }
  };

  const onWheel = e => {
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
    '이름1': r['이름1'], '소속1': r['소속1'], '스쿼드1': r['스쿼드1'], '상태1': r['상태1'], '등장1': r['등장1'], 'skel1': r['skel1'], 'atlas1': r['atlas1'], '이미지1': r['이미지1'],
    '이름2': r['이름2'], '소속2': r['소속2'], '스쿼드2': r['스쿼드2'], '상태2': r['상태2'], '등장2': r['등장2'], 'skel2': r['skel2'], 'atlas2': r['atlas2'], '이미지2': r['이미지2'],
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
    '오버스펙': r['오버스펙'],
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

function buildFramesData(rows) {
  return rows.map(r => ({
    '시즌': r['시즌'],
    '시작일': r['시작일'],
    '종료일': r['종료일'],
    '보스': r['보스'],
    '속성': r['속성'],
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
  }));
}

// Supabase(PostgREST)는 한 번에 최대 1000행까지만 반환하므로, 그 이상인 테이블(스테이지 정보 등)을
// 위해 다 받을 때까지 range()로 이어붙인다.
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
    fetchAll('스테이지_정보'),
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

  // 역대 테두리는 별도 테이블이라 다른 테이블들과 묶어서 Promise.all로 처리하지 않는다 —
  // 이 테이블에 문제(권한/데이터 없음 등)가 생겨도 나머지 탭이 전부 먹통이 되면 안 되므로,
  // 실패해도 여기서만 조용히 빈 배열로 처리하고 넘어간다.
  try {
    const framesRows = await fetchAll('역대_테두리', '시즌');
    APP_DATA.frames = buildFramesData(framesRows);
  } catch (err) {
    console.error('[역대 테두리] 데이터 로드 실패:', err);
    APP_DATA.frames = [];
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
