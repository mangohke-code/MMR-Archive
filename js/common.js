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

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function buildMainData(configRows, eventRows, thumbRows, pickupData) {
  const update = {};
  configRows.forEach(r => { update[r.key] = r.value; });

  const eventSeasonMap = {};
  pickupData.forEach(p => {
    if (p['이벤트'] && !eventSeasonMap[p['이벤트']]) eventSeasonMap[p['이벤트']] = p['시즌'];
  });

  return {
    update: update,
    events: eventRows.map(e => ({
      '이벤트명': e.name,
      '시작일': e.start_at,
      '종료일': e.end_at,
      '이미지': e.image_url,
      '신규복각': e.kind,
      '시즌': eventSeasonMap[e.name] || '',
    })),
    pickupImgs: thumbRows.map(t => ({ '이름': t.nikke_name, '이미지': t.image_url })),
  };
}

function buildPickupData(rows) {
  const seenNames = new Set();
  return rows.map(r => {
    const obj = {
      '시즌': r.season, '이벤트': r.event, '시작일': r.start_at, '종료일': r.end_at,
      '니케': r.nikke_name, '기업': r.company, '유형': r.type, '버스트': r.burst,
      '우월코드': r.code, '총기': r.weapon, '픽업 배너': r.banner,
    };
    // 복각 판별: 이름이 이미 나온 적 있고, 기업/유형/버스트/우월코드/총기가 전부 비어있으면 복각으로 취급 (원본 시트 F~J열 규칙과 동일)
    const infoEmpty = !r.company && !r.type && !r.burst && !r.code && !r.weapon;
    const isDuplicate = seenNames.has(r.nikke_name);
    obj['복각'] = isDuplicate && infoEmpty;
    seenNames.add(r.nikke_name);
    return obj;
  });
}

function buildCostumeData(rows) {
  return rows.map(r => ({
    '니케': r.nikke_name,
    '코스튬명': r.costume_name,
    '시작일': r.start_at,
    '종료일': r.end_at,
    '복각 시작일': r.rerun_start_at,
    '복각 종료일': r.rerun_end_at,
    '티켓': r.ticket_name,
    '무료티켓': r.free_ticket_url,
    '유료티켓': r.paid_ticket_url,
    'skel': r.skel_url,
    'atlas': r.atlas_url,
  }));
}

function buildSouvenirData(rows) {
  return rows.filter(r => r.name).map(r => ({
    '이름': r.name,
    '이벤트': r.event,
    '시즌': r.season,
    '이미지': r.image_url,
    '획득 방법': r.method,
    '설명': r.description,
  }));
}

function buildStageData(rows) {
  return rows.map(r => ({
    '챕터': r.chapter,
    '스테이지': r.stage,
    '노말전투력': r.normal_power,
    '노말보스': r.normal_boss,
    '노말약점': r.normal_code,
    '노말유형': r.normal_type,
    '하드전투력': r.hard_power,
    '하드보스': r.hard_boss,
    '하드약점': r.hard_code,
    '하드유형': r.hard_type,
    '스토리': r.story,
    '특이사항': r.notes,
  }));
}

function buildUnreleasedData(rows) {
  return rows.filter(r => r.name1 || r.name2).map(r => ({
    '이름1': r.name1, '소속1': r.affiliation1, '스쿼드1': r.squad1, '상태1': r.status1, '등장1': r.appearance1, 'skel1': r.skel1, 'atlas1': r.atlas1,
    '이름2': r.name2, '소속2': r.affiliation2, '스쿼드2': r.squad2, '상태2': r.status2, '등장2': r.appearance2, 'skel2': r.skel2, 'atlas2': r.atlas2,
  }));
}

function buildNikkeImgData(rows) {
  return rows.map(r => ({
    '이름': r.nikke_name,
    '이미지': r.portrait_url,
    '코스튬1': r.costume1_name,
    '코스튬1 이미지': r.costume1_image_url,
    '코스튬2': r.costume2_name,
    '코스튬2 이미지': r.costume2_image_url,
  }));
}

function buildIconImgData(rows) {
  const result = {};
  rows.forEach(r => {
    if (!result[r.category]) result[r.category] = {};
    result[r.category][r.key] = r.image_url;
  });
  return result;
}

function buildChapImgData(rows) {
  return rows.map(r => ({ '챕터': r.chapter, '이미지': r.image_url, '명칭': r.name }));
}

async function loadAllData() {
  const [
    pickupRes, costumeRes, souvenirRes, stageRes,
    unreleasedRes, nikkeImgRes, iconRes, chapRes,
    configRes, eventRes, thumbRes,
  ] = await Promise.all([
    supabaseClient.from('pickups').select('*').order('start_at', { ascending: true }),
    supabaseClient.from('costumes').select('*'),
    supabaseClient.from('souvenirs').select('*'),
    supabaseClient.from('stages').select('*'),
    supabaseClient.from('unreleased_characters').select('*'),
    supabaseClient.from('nikke_images').select('*'),
    supabaseClient.from('icons').select('*'),
    supabaseClient.from('chapter_images').select('*'),
    supabaseClient.from('site_config').select('*'),
    supabaseClient.from('events').select('*').order('start_at', { ascending: true }),
    supabaseClient.from('pickup_thumbnails').select('*'),
  ]);

  [pickupRes, costumeRes, souvenirRes, stageRes, unreleasedRes, nikkeImgRes, iconRes, chapRes, configRes, eventRes, thumbRes]
    .forEach(res => { if (res.error) throw res.error; });

  const pickup = buildPickupData(pickupRes.data);
  APP_DATA.main = buildMainData(configRes.data, eventRes.data, thumbRes.data, pickup);
  APP_DATA.pickup = pickup;
  APP_DATA.costume = buildCostumeData(costumeRes.data);
  APP_DATA.souvenir = buildSouvenirData(souvenirRes.data);
  APP_DATA.stage = buildStageData(stageRes.data);
  APP_DATA.unreleased = buildUnreleasedData(unreleasedRes.data);
  APP_DATA.nikkeImg = buildNikkeImgData(nikkeImgRes.data);
  APP_DATA.iconImg = buildIconImgData(iconRes.data);
  APP_DATA.chapImg = buildChapImgData(chapRes.data);
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
