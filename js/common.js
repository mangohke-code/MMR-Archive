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

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');
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
      <span class="toggle-label">${skin.name}</span>
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
// player.currentViewport(x/y/width/height)를 직접 조작해 실시간으로 반영한다. spine-player는
// setAnimation()을 호출할 때마다 currentViewport를 player.config.viewport 값으로 다시 만들어버리는데,
// player.config는 생성자에 넘긴 설정 객체를 그대로 참조(clone 아님)하고 있어서, config.viewport의
// x/y/width/height도 같이 갱신해두면 setAnimation이 몇 번을 호출되든(액션 애니메이션 재생 등) 팬/줌
// 상태가 자동으로 유지된다 — 따로 reapply()를 호출해줄 필요가 없어짐(호출해도 무해하니 유지).
function setupSpinePanZoom(player, canvasEl) {
  const base = {
    x: player.currentViewport.x,
    y: player.currentViewport.y,
    width: player.currentViewport.width,
    height: player.currentViewport.height,
  };
  const state = { dx: 0, dy: 0, scale: 1 };
  const MIN_SCALE = 0.2, MAX_SCALE = 6;

  function reapply() {
    // width/height가 0 이하이거나 NaN이 되면 카메라 투영이 깨져서 화면이 사라지므로 방어적으로 clamp
    let w = base.width * state.scale;
    let h = base.height * state.scale;
    if (!(w > 0)) w = base.width;
    if (!(h > 0)) h = base.height;
    const baseCenterX = base.x + base.width / 2;
    const baseCenterY = base.y + base.height / 2;
    const x = baseCenterX - w / 2 + state.dx;
    const y = baseCenterY - h / 2 + state.dy;

    const vp = player.currentViewport;
    vp.width = w;
    vp.height = h;
    vp.x = x;
    vp.y = y;

    const cfgVp = player.config && player.config.viewport;
    if (cfgVp) {
      cfgVp.x = x;
      cfgVp.y = y;
      cfgVp.width = w;
      cfgVp.height = h;
    }
  }

  let dragging = false, dragMoved = false, justDragged = false;
  let dragStartX = 0, dragStartY = 0, dragStartDx = 0, dragStartDy = 0;

  const onMouseDown = e => {
    e.preventDefault(); // 네이티브 드래그/텍스트 선택 방지
    dragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartDx = state.dx;
    dragStartDy = state.dy;
  };

  const onMouseMove = e => {
    if (!dragging) return;
    const dxScreen = e.clientX - dragStartX;
    const dyScreen = e.clientY - dragStartY;
    if (!dragMoved && (Math.abs(dxScreen) > 3 || Math.abs(dyScreen) > 3)) dragMoved = true;
    if (!dragMoved) return;
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const worldPerPixelX = (base.width * state.scale) / rect.width;
    const worldPerPixelY = (base.height * state.scale) / rect.height;
    state.dx = dragStartDx - dxScreen * worldPerPixelX;
    state.dy = dragStartDy + dyScreen * worldPerPixelY;
    reapply();
  };

  const onMouseUp = () => {
    dragging = false;
    if (dragMoved) justDragged = true;
  };

  // 드래그 직후 발생하는 click은 (기존의) 캐릭터 액션 애니메이션 트리거로 넘어가지 않도록 차단
  // — capture 단계라 costume.js/unreleased.js의 click 리스너(bubble 단계)보다 먼저 실행됨
  const onClickCapture = e => {
    if (justDragged) {
      e.stopImmediatePropagation();
      e.preventDefault();
      justDragged = false;
    }
  };

  const onWheel = e => {
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const mouseXRatio = (e.clientX - rect.left) / rect.width;
    const mouseYRatio = (e.clientY - rect.top) / rect.height;
    const vp = player.currentViewport;
    const worldX = vp.x + mouseXRatio * vp.width;
    const worldY = vp.y + (1 - mouseYRatio) * vp.height;

    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor));
    const actualFactor = newScale / state.scale;
    state.scale = newScale;

    const baseCenterX = base.x + base.width / 2;
    const baseCenterY = base.y + base.height / 2;
    const oldCenterX = baseCenterX + state.dx;
    const oldCenterY = baseCenterY + state.dy;
    state.dx = worldX + (oldCenterX - worldX) * actualFactor - baseCenterX;
    state.dy = worldY + (oldCenterY - worldY) * actualFactor - baseCenterY;

    reapply();
  };

  canvasEl.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvasEl.addEventListener('click', onClickCapture, true);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });

  reapply.destroy = () => {
    canvasEl.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    canvasEl.removeEventListener('click', onClickCapture, true);
    canvasEl.removeEventListener('wheel', onWheel);
  };

  return reapply;
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
    '이름1': r['이름1'], '소속1': r['소속1'], '스쿼드1': r['스쿼드1'], '상태1': r['상태1'], '등장1': r['등장1'], 'skel1': r['skel1'], 'atlas1': r['atlas1'],
    '이름2': r['이름2'], '소속2': r['소속2'], '스쿼드2': r['스쿼드2'], '상태2': r['상태2'], '등장2': r['등장2'], 'skel2': r['skel2'], 'atlas2': r['atlas2'],
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
