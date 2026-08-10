  let allSouvenirData = [];
  let currentSouvenir = null;
  let souvenirActiveSeason = null;

  function loadSouvenirData() {
    onAppDataReady(() => {
      initSouvenir(APP_DATA.souvenir);
    });
  }

  function initSouvenir(data) {
    if (!data || data.length === 0) return;
    allSouvenirData = data;
    buildSouvenirSeasonTabs(data);
    selectSouvenirSeason('__all__');
  }

  function buildSouvenirSeasonTabs(data) {
    const seasons = [...new Set(data.map(d => d['시즌']).filter(Boolean))]
      .sort((a, b) => souvenirSeasonRank(a) - souvenirSeasonRank(b));
    const container = document.getElementById('souvenir-season-tabs');
    container.innerHTML = `<button class="souvenir-season-tab" data-season="__all__">전체</button>`
      + seasons.map(s => `<button class="souvenir-season-tab" data-season="${s}">${s}</button>`).join('');
    container.querySelectorAll('.souvenir-season-tab').forEach(btn => {
      btn.addEventListener('click', () => selectSouvenirSeason(btn.dataset.season));
    });
  }

  function selectSouvenirSeason(season) {
    souvenirActiveSeason = season;
    document.querySelectorAll('.souvenir-season-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.season === season);
    });
    renderSouvenirStrip();
  }

  // 덜 중요한 시즌부터: 밸런타인·만우절·여름·크리스마스·콜라보레이션 → 신년·주년·기념일 케이크.
  // 여기 없는 시즌(향후 새로 생기는 값)은 목록 맨 뒤로 밀린다.
  const SOUVENIR_SEASON_ORDER = ['밸런타인', '만우절', '여름', '크리스마스', '콜라보레이션', '신년', '주년', '기념일 케이크'];

  function souvenirSeasonRank(season) {
    const idx = SOUVENIR_SEASON_ORDER.indexOf(season);
    return idx === -1 ? SOUVENIR_SEASON_ORDER.length : idx;
  }

  // ===== 이벤트 시점 =====
  // 기념품 목록은 시즌 안에서 이벤트 그룹을 시간순으로 늘어놓는다. 표에 적는 순서를 사람이
  // 매번 맞춰줄 필요가 없도록, 이벤트마다 "시점"을 다른 표에서 끌어와 그 값 하나로만 정렬한다.
  let souvenirEventTimes = null;

  function buildSouvenirEventTimes() {
    const times = {};
    const put = (name, value) => {
      if (!name || !value) return;
      const t = new Date(value).getTime();
      if (!Number.isNaN(t) && (times[name] === undefined || t < times[name])) times[name] = t;
    };
    // 1) 픽업 기록 / 메인 이벤트 표에 같은 이름의 이벤트가 있으면 그 시작일을 그대로 쓴다
    (APP_DATA.pickup || []).forEach(p => put(p['이벤트'], p['시작일']));
    ((APP_DATA.main || {}).events || []).forEach(e => put(e['이벤트명'], e['시작일']));

    // 2) 기념일 케이크("1주년", "1000일" …)는 어느 표에도 날짜가 없다. 서비스 시작일에서
    //    경과일을 더해 같은 시간축에 올린다 — 주년과 일수가 섞여 있어도(1000일은 2.5주년과
    //    3주년 사이다) 제자리를 찾고, 새 케이크가 늘어도 손댈 필요가 없다.
    const starts = (APP_DATA.pickup || [])
      .map(p => new Date(p['시작일']).getTime())
      .filter(t => !Number.isNaN(t));
    if (starts.length > 0) {
      const serviceStart = Math.min(...starts);
      const DAY = 24 * 60 * 60 * 1000;
      new Set(allSouvenirData.map(d => d['이벤트']).filter(Boolean)).forEach(name => {
        if (times[name] !== undefined) return;
        const 주년 = String(name).match(/^(\d+(?:\.\d+)?)\s*주년$/);
        if (주년) { times[name] = serviceStart + Number(주년[1]) * 365.25 * DAY; return; }
        const 일 = String(name).match(/^(\d+)\s*일$/);
        if (일) times[name] = serviceStart + Number(일[1]) * DAY;
      });
    }
    return times;
  }

  // 시점을 못 구한 이벤트(어느 표에도 없고 이름으로도 알 수 없는 것)는 맨 뒤로 보낸다.
  function souvenirEventTime(event) {
    if (!souvenirEventTimes) souvenirEventTimes = buildSouvenirEventTimes();
    const t = souvenirEventTimes[event];
    return t === undefined ? Infinity : t;
  }

  function compareSouvenirEvents([a], [b]) {
    const ta = souvenirEventTime(a), tb = souvenirEventTime(b);
    if (ta === tb) return 0;
    if (ta === Infinity) return 1;
    if (tb === Infinity) return -1;
    return ta - tb;
  }

  function renderSouvenirStrip() {
    const data = souvenirActiveSeason === '__all__'
      ? allSouvenirData
      : allSouvenirData.filter(d => d['시즌'] === souvenirActiveSeason);
    const strip = document.getElementById('souvenir-item-strip');

    // 이벤트별 그룹핑
    const byEvent = {};
    data.forEach(item => {
      const event = item['이벤트'] || '기타';
      if (!byEvent[event]) byEvent[event] = [];
      byEvent[event].push(item);
    });

    // 이벤트 그룹을 다시 시즌별로 묶어서 행(row)으로 구분 — 미실장 캐릭터 탭의 소속별
    // 구분과 같은 느낌
    const bySeason = {};
    Object.entries(byEvent).forEach(([event, items]) => {
      const season = items[0]['시즌'] || '기타';
      if (!bySeason[season]) bySeason[season] = [];
      bySeason[season].push([event, items]);
    });
    Object.values(bySeason).forEach(groups => groups.sort(compareSouvenirEvents));

    const sortedSeasons = Object.keys(bySeason).sort((a, b) => souvenirSeasonRank(a) - souvenirSeasonRank(b));

    strip.innerHTML = sortedSeasons.map(season => `
      <div class="souvenir-season-group">
        <div class="souvenir-season-group-title">${season}</div>
        <div class="souvenir-season-group-body">
          ${bySeason[season].map(([event, items]) => `
            <div class="souvenir-event-group">
              <div class="souvenir-event-label">${event}</div>
              <div class="souvenir-event-items">
                ${items.map(item => `
                  <div class="souvenir-strip-item"
                       data-idx="${allSouvenirData.indexOf(item)}"
                       onclick="selectSouvenirItem(allSouvenirData[${allSouvenirData.indexOf(item)}])">
                    <div class="souvenir-strip-img">
                      ${item['이미지'] ? `<img src="${item['이미지']}" alt="${item['이름']}">` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    // 첫 번째 아이템 자동 선택
    if (!currentSouvenir || !data.includes(currentSouvenir)) {
      if (data.length > 0) selectSouvenirItem(data[0]);
    } else {
      // 현재 선택 유지하면서 active 표시만 갱신
      document.querySelectorAll('.souvenir-strip-item').forEach(el => {
        el.classList.toggle('active', allSouvenirData[el.dataset.idx] === currentSouvenir);
      });
    }
  }

  const revealedSouvenirs = new Set();

  function selectSouvenirItem(item) {
    currentSouvenir = item;

    document.querySelectorAll('.souvenir-strip-item').forEach(el => {
      el.classList.toggle('active', allSouvenirData[el.dataset.idx] === item);
    });

    const img = document.getElementById('souvenir-detail-img');
    img.src = item['이미지'] || '';
    img.style.display = item['이미지'] ? 'block' : 'none';

    document.getElementById('souvenir-detail-name').textContent = item['이름'] || '';
    document.getElementById('souvenir-detail-event-name').textContent = item['이벤트'] || '';
    document.getElementById('souvenir-detail-season').textContent = item['시즌'] ? ` · ${item['시즌']}` : '';
    document.getElementById('souvenir-detail-method').textContent = item['획득 방법'] || '-';

    const rawDesc = item['설명'] || '-';
    const isSpoiler = item['스포일러'] === 'O';
    const desc = rawDesc.replace(/\n/g, '<br>');
    const descEl = document.getElementById('souvenir-detail-desc');
    const descWrap = document.getElementById('souvenir-detail-desc-wrap');
    descEl.innerHTML = desc;

    // 기존 오버레이 버튼 제거
    const existing = document.getElementById('souvenir-spoiler-overlay');
    if (existing) existing.remove();

    if (isSpoiler && !revealedSouvenirs.has(item)) {
      descEl.classList.add('spoiler-blur');
      descWrap.style.position = 'relative';

      const overlay = document.createElement('button');
      overlay.id = 'souvenir-spoiler-overlay';
      overlay.className = 'spoiler-reveal-btn';
      overlay.textContent = '스포일러 해제';
      overlay.addEventListener('click', () => {
        revealedSouvenirs.add(item);
        descEl.classList.remove('spoiler-blur');
        overlay.remove();
      });
      descWrap.appendChild(overlay);
    } else {
      descEl.classList.remove('spoiler-blur');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadSouvenirData();
  });
