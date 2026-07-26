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
      themeToggle.textContent = isDark ? '☀️' : '🌙';
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
