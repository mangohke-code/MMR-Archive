  let allPickupData = [];
  let pickupNikkeImgData = [];
  let iconImgData = {};
  let eventDateMap = {};
  
  let activeFilters = {
    year: new Set(),
    season: new Set(),
    company: new Set(),
    type: new Set(),
    code: new Set(),
    burst: new Set(),
    weapon: new Set()
  };
  
  const FILTER_ORDER = {
    season: ['일반', '메이드', '바니걸', '여름', '크리스마스', '신년', '__anniv__', '콜라보'],
    type:   ['화력형', '지원형', '방어형'],
    code:   ['작열', '철갑', '풍압', '전격', '수냉'],
    burst:  ['1', '2', '3', 'Λ'],
    weapon: ['AR', 'SMG', 'RL', 'SR', 'MG', 'SG'],
  };

  // 8. 아이콘을 표시할 필터 항목 (기업은 데이터에 따라 동적)
  const ICON_FILTER_KEYS = {
    'filter-company': '기업',
    'filter-type':    '유형',
    'filter-code':    '우월코드',
    'filter-burst':   '버스트',
    'filter-weapon':  '총기',
  };

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

  // 오버스펙 니케를 1명 이상 보유한 기업 집합(표시용 기준 이름)
  function getOverspecCompanies() {
    const companies = new Set();
    allPickupData.forEach(p => {
      if (p['기업'] && p['기업'].endsWith(OVERSPEC_SUFFIX)) companies.add(getBaseCompany(p['기업']));
    });
    return companies;
  }

  // 기업 필터가 이 픽업 항목에 매치되는지 판단. 일반 선택("엘리시온")은 오버스펙 여부와
  // 무관하게 그 기업 소속 전체(기업 값이 "엘리시온"이든 "엘리시온(오)"든)와 매치하고,
  // 오버스펙 선택("엘리시온(오)")은 기업 값이 정확히 그 접미사 붙은 값인 것만 매치한다.
  function companyFilterMatches(p) {
    if (activeFilters.company.size === 0) return true;
    const pCompany = p['기업'];
    if (!pCompany) return false;
    return [...activeFilters.company].some(v => {
      if (v.endsWith(OVERSPEC_SUFFIX)) return pCompany === v;
      return getBaseCompany(pCompany) === v;
    });
  }

  function loadPickupData() {
    onAppDataReady(() => {
      iconImgData = APP_DATA.iconImg || {};
      pickupNikkeImgData = APP_DATA.nikkeImg || [];

      // 이벤트명 → 기간 맵 (메인 페이지 시트 기준)
      eventDateMap = {};
      (APP_DATA.main.events || []).forEach(e => {
        if (e['이벤트명']) {
          eventDateMap[e['이벤트명']] = {
            start: e['시작일'],
            end: e['종료일']
          };
        }
      });

      initPickup(APP_DATA.pickup);
      initPickupToolbar();
      initYearNav();
      updateYearNav();
    });
  }

  function initPickup(data) {
    if (!data || data.length === 0) return;

    // 복각 니케의 원본 정보(기업/유형/버스트/우월코드/총기/픽업 배너)는
    // common.js의 buildPickupData()에서 이미 채워서 넘어옴 (여러 탭이 공유하는 데이터라 그쪽에서 한 번만 처리)

    allPickupData = data;
    buildPickupFilters(data);
    renderPickupTimeline();
  }

  function buildPickupFilters(data) {
    // 연도 버튼
    const years = [...new Set(data.map(p => new Date(p['시작일']).getFullYear()))].sort((a, b) => b - a);
    const yearContainer = document.getElementById('filter-year');
    yearContainer.innerHTML = '';
    years.forEach(y => {
      const btn = makeChip(String(y), 'year', String(y), false);
      yearContainer.appendChild(btn);
    });
    const allBtn = makeChip('전체', 'year', '__all__', false);
    yearContainer.insertBefore(allBtn, yearContainer.firstChild);
    syncChipActive(yearContainer, activeFilters['year']);

    // 버튼 필터 목록
    const filterMap = {
      'filter-season':  { key: '시즌',   id: 'season' },
      'filter-company': { key: '기업',   id: 'company' },
      'filter-type':    { key: '유형',   id: 'type' },
      'filter-code':    { key: '우월코드', id: 'code' },
      'filter-burst':   { key: '버스트', id: 'burst' },
      'filter-weapon':  { key: '총기',   id: 'weapon' },
    };

    Object.entries(filterMap).forEach(([elId, { key, id }]) => {
      const rawValues = [...new Set(data.map(p => p[key]).filter(Boolean))];

      // 주년 값들을 __anniv__로 치환
      const normalizedValues = rawValues.map(v => isAnniversary(v) ? '__anniv__' : v);
      const uniqueValues = [...new Set(normalizedValues)];

      let values;
      if (FILTER_ORDER[id]) {
        values = FILTER_ORDER[id].filter(v => uniqueValues.includes(v));
        uniqueValues.filter(v => !FILTER_ORDER[id].includes(v)).forEach(v => values.push(v));
      } else {
        values = uniqueValues;
      }

      // 기업 필터는 오버스펙 상태(2단계 클릭)가 필요해서 별도 로직으로 처리한다
      if (elId === 'filter-company') {
        buildCompanyFilterChips(values);
        return;
      }

      const container = document.getElementById(elId);
      container.innerHTML = '';
      const iconKey = ICON_FILTER_KEYS[elId];

      // 전체 버튼 먼저
      container.appendChild(makeChip('전체', id, '__all__', false));

      values.forEach(v => {
        const label = v === '__anniv__' ? '주년' : v;
        const iconUrl = iconKey && iconImgData[iconKey] && iconImgData[iconKey][v]
          ? iconImgData[iconKey][v] : null;
        // 버스트는 아이콘 있을 때 문구 생략
        const displayLabel = (id === 'burst' && iconUrl) ? '' : label;
        const btn = makeChip(displayLabel, id, v, false, iconUrl);
        container.appendChild(btn);
      });

      syncChipActive(container, activeFilters[id]);
    });

    // 초기화 버튼
    const resetBtn = document.getElementById('pickup-filter-reset');
    resetBtn.addEventListener('click', () => {
      Object.keys(activeFilters).forEach(k => activeFilters[k].clear());
      document.querySelectorAll('#pickup-filter-wrap .filter-chips').forEach(container => {
        if (container.id === 'filter-company') {
          syncCompanyChipVisuals();
          return;
        }
        const firstBtn = container.querySelector('.filter-chip');
        if (!firstBtn) return;
        syncChipActive(container, activeFilters[firstBtn.dataset.filter]);
      });
      renderCurrentView();
    });
  }

  function renderGroupNikkeItem(p) {
    const LIMITED_SEASONS = ['콜라보', '여름', '크리스마스'];
    const isLimited = LIMITED_SEASONS.includes(p['시즌']);
    const isRerun = p['복각'];

    const nikkeImg = pickupNikkeImgData.find(n => n['이름'] === p['니케']);
    const imgUrl = nikkeImg ? nikkeImg['이미지'] : '';

    const itemClass = ['group-nikke-item', isLimited ? 'is-limited' : '', isRerun ? 'is-rerun' : ''].filter(Boolean).join(' ');

    const badges = [
      isLimited ? `<span class="group-badge-limited">한정</span>` : '',
      isRerun   ? `<span class="group-badge-rerun">복각</span>`   : '',
    ].filter(Boolean).join('');

    return `
      <div class="${itemClass}">
        <div class="group-nikke-portrait">
          ${imgUrl ? `<img src="${imgUrl}" alt="${p['니케']}">` : ''}
        </div>
        <div class="group-nikke-info">
          <div class="group-nikke-name-wrap">
            <div class="group-nikke-name">${p['니케']}</div>
          </div>
          ${badges ? `<div class="group-nikke-badges">${badges}</div>` : ''}
        </div>
      </div>`;
  }

  function makeChip(label, filterId, value, active = false, iconUrl = null) {
    const btn = document.createElement('button');
    btn.className = 'filter-chip' + (filterId === 'code' ? ' filter-chip-code' : '') + (active ? ' active' : '');
    btn.dataset.filter = filterId;
    btn.dataset.value = value;

    let inner = '';
    if (iconUrl) inner += `<img src="${iconUrl}" alt="${label}">`;
    inner += label;
    btn.innerHTML = inner;

    btn.addEventListener('click', onFilterClick);
    return btn;
  }

  function onFilterClick(e) {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;
    const { filter, value } = btn.dataset;
    const set = activeFilters[filter];

    if (value === '__all__') {
      set.clear();
    } else if (set.has(value)) {
      set.delete(value);
    } else {
      set.add(value);
    }

    syncChipActive(btn.closest('.filter-chips'), set);
    renderCurrentView();
  }

  function syncChipActive(container, set) {
    container.querySelectorAll('.filter-chip').forEach(btn => {
      const v = btn.dataset.value;
      if (v === '__all__') {
        btn.classList.toggle('active', set.size === 0);
      } else {
        btn.classList.toggle('active', set.has(v));
      }
    });
  }

  // 기업 필터 칩: 클릭할 때마다 꺼짐 -> 일반 선택 -> 오버스펙 선택(그 기업에 오버스펙
  // 니케가 있을 때만) -> 꺼짐 순서로 순환한다. 일반 선택 상태에서는 활성 표시만 하고
  // 그 기업 전체가 필터에 걸리며(오버스펙 니케 포함), 오버스펙 선택 상태에서는 아이콘이
  // "(오)" 버전으로 바뀌고 그 기업의 오버스펙 니케만 필터에 걸린다.
  function buildCompanyFilterChips(values) {
    const container = document.getElementById('filter-company');
    container.innerHTML = '';

    // values에는 "엘리시온"과 "엘리시온(오)"가 서로 다른 원본 값으로 섞여 들어올 수
    // 있으므로, 칩은 기업당 하나만(괄호 뗀 이름 기준) 만든다 - 오버스펙은 같은 칩을
    // 한 번 더 눌러서 전환하는 상태지 별도 칩이 아니다.
    const baseCompanies = [...new Set(values.map(getBaseCompany))];

    const allBtn = document.createElement('button');
    allBtn.className = 'filter-chip';
    allBtn.dataset.company = '__all__';
    allBtn.textContent = '전체';
    allBtn.addEventListener('click', onCompanyFilterClick);
    container.appendChild(allBtn);

    baseCompanies.forEach(company => {
      const btn = document.createElement('button');
      btn.className = 'filter-chip';
      btn.dataset.company = company;

      const iconUrl = iconImgData['기업'] && iconImgData['기업'][company] ? iconImgData['기업'][company] : null;
      if (iconUrl) {
        const img = document.createElement('img');
        img.className = 'filter-chip-icon';
        img.alt = company;
        img.src = iconUrl;
        btn.appendChild(img);
      }
      btn.appendChild(document.createTextNode(company));
      btn.addEventListener('click', onCompanyFilterClick);
      container.appendChild(btn);
    });

    syncCompanyChipVisuals();
  }

  function onCompanyFilterClick(e) {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;
    const company = btn.dataset.company;
    const set = activeFilters.company;

    if (company === '__all__') {
      set.clear();
    } else {
      const normal = company;
      const overspec = company + OVERSPEC_SUFFIX;
      if (set.has(overspec)) {
        set.delete(overspec);
      } else if (set.has(normal)) {
        set.delete(normal);
        if (getOverspecCompanies().has(company)) set.add(overspec);
      } else {
        set.add(normal);
      }
    }

    syncCompanyChipVisuals();
    renderCurrentView();
  }

  function syncCompanyChipVisuals() {
    const container = document.getElementById('filter-company');
    if (!container) return;
    container.querySelectorAll('.filter-chip').forEach(btn => {
      const company = btn.dataset.company;
      if (company === '__all__') {
        btn.classList.toggle('active', activeFilters.company.size === 0);
        return;
      }
      const overspec = company + OVERSPEC_SUFFIX;
      const isOverspecState = activeFilters.company.has(overspec);
      const isNormalState = activeFilters.company.has(company);
      btn.classList.toggle('active', isNormalState || isOverspecState);
      btn.classList.toggle('overspec', isOverspecState);

      const img = btn.querySelector('img');
      if (img && iconImgData['기업']) {
        const iconUrl = isOverspecState
          ? (iconImgData['기업'][overspec] || iconImgData['기업'][company])
          : iconImgData['기업'][company];
        if (iconUrl) img.src = iconUrl;
      }
    });
  }

  function isAnniversary(v) {
    return /^\d+(\.\d+)?주년$/.test(String(v).trim());
  }

  function getFilteredData() {
    return allPickupData.filter(p => {
      if (!showRerun && p['복각']) return false;
      const year = String(new Date(p['시작일']).getFullYear());
      if (activeFilters.year.size > 0 && !activeFilters.year.has(year)) return false;

      // 시즌: 주년 버튼 처리
      if (activeFilters.season.size > 0) {
        const pSeason = p['시즌'];
        const seasonMatch = [...activeFilters.season].some(v => {
          if (v === '__anniv__') return isAnniversary(pSeason);
          return pSeason === v;
        });
        if (!seasonMatch) return false;
      }

      if (!companyFilterMatches(p)) return false;
      if (activeFilters.type.size > 0    && !activeFilters.type.has(p['유형']))    return false;
      if (activeFilters.code.size > 0    && !activeFilters.code.has(p['우월코드'])) return false;
      if (activeFilters.burst.size > 0   && !activeFilters.burst.has(p['버스트'])) return false;
      if (activeFilters.weapon.size > 0  && !activeFilters.weapon.has(p['총기']))  return false;
      return true;
    });
  }

  function renderPickupTimeline() {
    const data = getFilteredData();
    const timeline = document.getElementById('pickup-timeline');

    if (data.length === 0) {
      timeline.innerHTML = '<p style="color:#555;font-size:13px;">해당하는 픽업 기록이 없습니다.</p>';
      return;
    }

    const byYear = {};
    data.forEach(p => {
      const year = new Date(p['시작일']).getFullYear();
      if (!byYear[year]) byYear[year] = {};
      const eventKey = p['이벤트'];
      if (!byYear[year][eventKey]) {
        byYear[year][eventKey] = {
          season: p['시즌'],
          month: new Date(p['시작일']).getMonth() + 1,
          rangeStart: p['시작일'],
          rangeEnd: p['종료일'],
          nikkes: []
        };
      } else {
        if (new Date(p['시작일']) < new Date(byYear[year][eventKey].rangeStart))
          byYear[year][eventKey].rangeStart = p['시작일'];
        if (new Date(p['종료일']) > new Date(byYear[year][eventKey].rangeEnd))
          byYear[year][eventKey].rangeEnd = p['종료일'];
      }
      byYear[year][eventKey].nikkes.push(p);
    });

    const years = Object.keys(byYear).sort((a, b) => b - a);

    timeline.innerHTML = years.map(year => {
      const byMonth = {};
      Object.entries(byYear[year]).forEach(([eventName, eventData]) => {
        const m = eventData.month;
        if (!byMonth[m]) byMonth[m] = [];
        byMonth[m].push([eventName, eventData]);
      });

      return `
      <div class="timeline-year">
        <div class="year-divider">
          <span class="year-label">${year}</span>
          <div class="year-line"></div>
        </div>
        ${Object.keys(byMonth).sort((a, b) => b - a).map(month => `
          <div class="month-row">
            <div class="month-col">
              <div class="month-label">${month}월</div>
            </div>
            <div class="events-col">
              ${byMonth[month]
                .sort((a, b) => new Date(b[1].rangeStart) - new Date(a[1].rangeStart))
                .map(([eventName, eventData]) => renderEventLine(eventName, eventData))
                .join('')}
            </div>
          </div>
        `).join('')}
      </div>
      `;
    }).join('');
    syncNameScrollAnimations(timeline, '.nikke-name-wrap', '.nikke-name');
    requestAnimationFrame(() => setupYearObserver());
  }

  function renderEventLine(eventName, eventData) {
    const nikkes = [...eventData.nikkes]
      .sort((a, b) => (a['복각'] ? 1 : 0) - (b['복각'] ? 1 : 0));

    return `
      <div class="event-line">
        <div class="event-label-col">
          <div class="event-label-name">${eventName}</div>
          ${eventData.season ? `<div class="event-label-season">${eventData.season}</div>` : ''}
        </div>
        <div class="nikke-grid">
          ${nikkes.map(p => renderNikkeCard(p)).join('')}
        </div>
      </div>
    `;
  }

  function renderNikkeCard(p) {
    const LIMITED_SEASONS = ['콜라보', '여름', '크리스마스'];
    const isLimited = LIMITED_SEASONS.includes(p['시즌']);
    const isRerun = p['복각'];
    const isActive = isPickupPeriodActive(p['시작일'], p['종료일']);
    const isUpcoming = !isActive && isPickupUpcoming(p['시작일']);

    const nikkeImg = pickupNikkeImgData.find(n => n['이름'] === p['니케']);
    const imgUrl = nikkeImg ? nikkeImg['이미지'] : '';

    const cardClass = ['nikke-card', isLimited ? 'is-limited' : '', isRerun ? 'is-rerun' : ''].filter(Boolean).join(' ');

    const attrOrder = ['기업', '유형', '버스트', '총기', '우월코드'];
    const attrs = attrOrder.map(attr => {
      const val = p[attr];
      if (!val) return '';
      // 기업 값 자체가 오버스펙이면("엘리시온(오)") 이 값 그대로 아이콘을 먼저 찾고,
      // IMG_아이콘에 전용 아이콘이 아직 없으면 괄호를 뗀 일반 기업 아이콘으로 폴백한다.
      // 화면에 보여주는 문구(마우스오버 툴팁 포함)는 항상 괄호를 뗀 이름만 쓴다.
      const displayVal = attr === '기업' ? getBaseCompany(val) : val;
      const iconUrl = (iconImgData[attr] && iconImgData[attr][val])
        || (attr === '기업' && iconImgData[attr] && iconImgData[attr][displayVal])
        || null;
      if (!iconUrl) return '';
      const isCode = attr === '우월코드';
      const codeClass = isCode ? `code-chip code-${displayVal}` : '';
      return `
        <span class="nikke-attr-chip ${codeClass}" data-tooltip="${displayVal}">
          <img src="${iconUrl}" alt="${displayVal}">
        </span>
      `;
    }).join('');

    return `
      <div class="${cardClass}" data-nikke-name="${p['니케']}" data-start="${p['시작일']}">
        <div class="nikke-top-badges">
          ${isLimited ? `<span class="nikke-badge-limited">한정</span>` : ''}
          ${isRerun   ? `<span class="nikke-badge-rerun">복각</span>`   : ''}
        </div>
        <div class="nikke-card-top">
          <div class="nikke-img">
            ${imgUrl ? `<img src="${imgUrl}" alt="${p['니케']}">` : p['니케']}
          </div>
          <div class="nikke-attrs">${attrs}</div>
        </div>
        <div class="nikke-card-bottom">
          <div class="nikke-name-wrap"> 
            <div class="nikke-name">${p['니케']}</div>
          </div>
          <div class="nikke-date">
            ${formatPickupDate(p['시작일'])} ~ ${formatPickupDate(p['종료일'])}
            ${isActive ? `<span class="nikke-active-badge">픽업 중</span>` : ''}
            ${isActive ? formatRemainingDaysPickup(p['시작일'], p['종료일']) : ''}
            ${isUpcoming ? `<span class="nikke-upcoming-badge">픽업 예정</span>` : ''}
            ${isUpcoming ? formatDaysUntilStart(p['시작일']) : ''}
          </div>
        </div>
      </div>
    `;
  }

  function formatPickupDate(date) {
    if (!date) return '-';
    const d = new Date(date);
    return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  function isPickupPeriodActive(start, end) {
    if (!start || !end) return false;
    const now = new Date();
    const s = new Date(start);
    const e = new Date(end);
    e.setHours(23, 59, 59, 999); // 종료일에 시간 정보가 없어도 그날 전체를 포함하도록
    return now >= s && now <= e;
  }

  function isPickupUpcoming(start) {
    if (!start) return false;
    return new Date() < new Date(start);
  }

  // 픽업 예정인 니케 카드에 시작까지 남은 일수를 D-n 배지로 표시 — 종료까지 남은 기간
  // 배지(.pickup-remaining-badge)와 헷갈리지 않도록 다른 클래스(다른 색)를 쓴다
  function formatDaysUntilStart(start) {
    if (!isPickupUpcoming(start)) return '';
    const now = new Date();
    const s = new Date(start);
    const remain = Math.ceil((s - now) / (1000 * 60 * 60 * 24));
    return `<span class="pickup-upcoming-badge">D-${Math.max(remain, 0)}</span>`;
  }

  // 픽업중인 니케 카드에 종료까지 남은 일수를 D-n 배지로 표시
  function formatRemainingDaysPickup(start, end) {
    if (!isPickupPeriodActive(start, end)) return '';
    const now = new Date();
    const e = new Date(end);
    e.setHours(23, 59, 59, 999);
    const remain = Math.ceil((e - now) / (1000 * 60 * 60 * 24));
    return `<span class="pickup-remaining-badge">D-${Math.max(remain, 0)}</span>`;
  }

  // 메인 페이지의 "진행중인 픽업" 카드 클릭 시 픽업 기록 탭의 해당 니케 위치로 이동.
  // 같은 니케가 복각으로 여러 번 나왔을 수 있으므로, 그 중 가장 최근(시작일 기준) 카드로 이동한다.
  function jumpToPickupNikke(nikkeName) {
    switchTab('pickup');

    // 필터에 가려서 못 찾는 일이 없도록 필터 초기화
    Object.keys(activeFilters).forEach(k => activeFilters[k].clear());
    document.querySelectorAll('#pickup-filter-wrap .filter-chips').forEach(container => {
      if (container.id === 'filter-company') {
        syncCompanyChipVisuals();
        return;
      }
      const firstBtn = container.querySelector('.filter-chip');
      if (!firstBtn) return;
      syncChipActive(container, activeFilters[firstBtn.dataset.filter]);
    });

    // 타임라인 뷰로 전환
    if (currentView !== 'timeline') {
      currentView = 'timeline';
      document.querySelectorAll('.pickup-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'timeline'));
      document.getElementById('pickup-timeline').classList.remove('hidden');
      document.getElementById('pickup-group-view').classList.add('hidden');
      document.getElementById('pickup-group-selector').classList.add('hidden');
      syncGroupFilterVisibility(null);
    }

    // 복각 카드도 보이도록 토글 켜기
    if (!showRerun) {
      showRerun = true;
      document.getElementById('pickup-rerun-toggle').classList.add('active');
    }

    renderPickupTimeline();
    updateYearNav();

    const matches = [...document.querySelectorAll(`.nikke-card[data-nikke-name="${CSS.escape(nikkeName)}"]`)];
    if (matches.length === 0) return;
    matches.sort((a, b) => new Date(b.dataset.start) - new Date(a.dataset.start));
    const target = matches[0];
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('jump-highlight');
    setTimeout(() => target.classList.remove('jump-highlight'), 1200);
  }

  // ===== 툴바 이벤트 =====
  let currentView = 'timeline';
  let currentGroup = 'company';
  let showRerun = false;

  // 현재 보기 모드에 맞는 렌더 함수만 호출 - 필터/복각 토글 등 여러 곳에서
  // 공통으로 써서 뷰가 늘어나도(타임라인/몰아보기/달력) 분기를 한 곳에서만 관리한다
  function renderCurrentView() {
    if (currentView === 'timeline') {
      renderPickupTimeline();
    } else if (currentView === 'group') {
      renderPickupGroupView();
    } else if (currentView === 'calendar') {
      renderPickupCalendar();
    }
  }

  function initPickupToolbar() {
    // 보기 전환
    document.querySelectorAll('.pickup-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentView = btn.dataset.view;
        document.querySelectorAll('.pickup-view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.getElementById('pickup-timeline').classList.toggle('hidden', currentView !== 'timeline');
        document.getElementById('pickup-group-view').classList.toggle('hidden', currentView !== 'group');
        document.getElementById('pickup-calendar-view').classList.toggle('hidden', currentView !== 'calendar');
        document.getElementById('pickup-group-selector').classList.toggle('hidden', currentView !== 'group');

        if (currentView === 'group') {
          syncGroupFilterVisibility();
        } else {
          syncGroupFilterVisibility(null);
        }
        renderCurrentView();
        updateYearNav();
      });
    });

    // 몰아보기 기준 전환
    document.querySelectorAll('.pickup-group-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentGroup = btn.dataset.group;
        document.querySelectorAll('.pickup-group-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        syncGroupFilterVisibility();
        renderPickupGroupView();
      });
    });

    // 복각 토글
    const rerunToggle = document.getElementById('pickup-rerun-toggle');
    rerunToggle.addEventListener('click', () => {
      showRerun = !showRerun;
      rerunToggle.classList.toggle('active', showRerun);
      renderCurrentView();
    });

    initPickupCalendarNav();

    // 필터 토글
    const filterToggle = document.getElementById('pickup-filter-toggle');
    const filterWrap = document.getElementById('pickup-filter-wrap');
    filterToggle.addEventListener('click', () => {
      const isHidden = filterWrap.classList.toggle('hidden');
      filterToggle.textContent = (isHidden ? '▼' : '▲') + ' 필터';
    });
  }

  function syncGroupFilterVisibility(groupOverride) {
    const group = groupOverride !== undefined ? groupOverride : (currentView === 'group' ? currentGroup : null);
    const hideMap = {
      company: 'filter-company',
      type:    'filter-type',
      code:    'filter-code',
      burst:   'filter-burst',
      weapon:  'filter-weapon',
    };
    // 모든 필터 행 표시
    document.querySelectorAll('#pickup-filter-wrap .filter-row').forEach(row => {
      row.style.display = '';
    });
    if (!group) return;
    // 현재 몰아보기 기준에 해당하는 필터 행 숨기기
    const hideId = hideMap[group];
    if (!hideId) return;
    const targetChips = document.getElementById(hideId);
    if (!targetChips) return;
    targetChips.closest('.filter-row').style.display = 'none';
  }

  // ===== 몰아보기 =====
  const GROUP_CONFIGS = {
    company: { key: '기업',    order: null, dotColors: {} },
    type:    { key: '유형',    order: ['화력형','지원형','방어형'], dotColors: {} },
    code:    { key: '우월코드', order: ['작열','철갑','풍압','전격','수냉'], dotColors: {'작열':'#cc4433','철갑':'#3355cc','풍압':'#33aa55','전격':'#ccaa33','수냉':'#4488cc'} },
    burst:   { key: '버스트',  order: ['1','2','3','Λ'], dotColors: {} },
    weapon:  { key: '총기',    order: ['AR','SMG','RL','SR','MG','SG'], dotColors: {} },
  };

  function renderPickupGroupView() {
    const config = GROUP_CONFIGS[currentGroup];
    const groupKey = config.key;

    // 현재 몰아보기 기준 키 제외 필터 적용
    const data = allPickupData.filter(p => {
      if (!showRerun && p['복각']) return false;
      const year = String(new Date(p['시작일']).getFullYear());
      if (activeFilters.year.size > 0 && !activeFilters.year.has(year)) return false;
      if (activeFilters.season.size > 0) {
        const pSeason = p['시즌'];
        const seasonMatch = [...activeFilters.season].some(v => {
          if (v === '__anniv__') return isAnniversary(pSeason);
          return pSeason === v;
        });
        if (!seasonMatch) return false;
      }
      if (groupKey !== '기업'     && !companyFilterMatches(p))                                                   return false;
      if (groupKey !== '유형'     && activeFilters.type.size > 0    && !activeFilters.type.has(p['유형']))       return false;
      if (groupKey !== '우월코드'  && activeFilters.code.size > 0   && !activeFilters.code.has(p['우월코드']))   return false;
      if (groupKey !== '버스트'   && activeFilters.burst.size > 0   && !activeFilters.burst.has(p['버스트']))   return false;
      if (groupKey !== '총기'     && activeFilters.weapon.size > 0  && !activeFilters.weapon.has(p['총기']))    return false;
      return true;
    });

    // 열 목록: 필터 전 전체 데이터 기준으로 고정 (필터링해도 열 유지)
    // 기업은 오버스펙 값("엘리시온(오)")도 괄호를 뗀 같은 열로 합친다 - 별도 열이 아니다.
    let columns = config.order
      ? config.order.filter(v => allPickupData.some(p => p[groupKey] === v))
      : groupKey === '기업'
        ? [...new Set(allPickupData.map(p => p['기업']).filter(Boolean).map(getBaseCompany))]
        : [...new Set(allPickupData.map(p => p[groupKey]).filter(Boolean))];

    // 기간 키 (연도 분리)
    const periodKey = p => {
      const s = new Date(p['시작일']);
      const e = new Date(p['종료일']);
      const fmt = d => `${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
      return `${s.getFullYear()}||${fmt(s)}~${fmt(e)}`;
    };

    // 기간별 그룹핑 (최신순)
    const periodMap = {};
    data.forEach(p => {
      const pk = periodKey(p);
      if (!periodMap[pk]) periodMap[pk] = { start: new Date(p['시작일']), nikkes: [] };
      periodMap[pk].nikkes.push(p);
    });
    const periods = Object.entries(periodMap).sort((a, b) => b[1].start - a[1].start);

    // 열 너비 계산: 기간열 150px, 나머지 균등
    const colWidthStyle = `width: calc((100% - 150px) / ${columns.length});`;

    // 헤더 렌더링
    const isBurst = currentGroup === 'burst';
    const thead = document.querySelector('#pickup-group-thead tr');
    thead.innerHTML = `<th style="width:150px; min-width:150px; text-align:left;">기간</th>`
      + columns.map(col => {
        const dotColor = config.dotColors[col] || '#5555aa';
        const iconUrl = iconImgData[groupKey] && iconImgData[groupKey][col] ? iconImgData[groupKey][col] : null;
        const isCodeGroup = groupKey === '우월코드';
        return `<th style="${colWidthStyle}">
          ${iconUrl
            ? `<img src="${iconUrl}" alt="${col}" class="${isCodeGroup ? 'code-group-icon' : ''}" style="width:22px;height:22px;object-fit:contain;vertical-align:middle;margin-right:4px;">`
            : `<span class="group-col-dot" style="background:${dotColor};"></span>`}
          ${isBurst ? '' : col}
        </th>`;
      }).join('');

    document.getElementById('pickup-group-header-table').style.tableLayout = 'fixed';
    // 바디 렌더링
    const tbody = document.getElementById('pickup-group-tbody');
    tbody.innerHTML = periods.map(([pk, periodData], idx) => {
      const [year, dateRange] = pk.split('||');
      // 타임라인 뷰의 연도 구분선처럼, 바로 위 행과 연도가 바뀌는 지점에만 굵은 경계를
      // 넣어서 연도 구분이 눈에 띄게 한다 (맨 첫 행은 표 자체 헤더로 이미 구분되니 제외)
      const prevYear = idx > 0 ? periods[idx - 1][0].split('||')[0] : null;
      const isYearBoundary = idx > 0 && year !== prevYear;
      const cells = columns.map(col => {
        const match = periodData.nikkes.filter(p => groupKey === '기업' ? getBaseCompany(p[groupKey]) === col : p[groupKey] === col);
        if (match.length === 0) return `<td class="group-cell-empty" style="${colWidthStyle}">—</td>`;
        return `<td style="${colWidthStyle}">${match.map(p => renderGroupNikkeItem(p)).join('')}</td>`;
      });
      return `<tr class="${isYearBoundary ? 'year-boundary' : ''}">
        <td class="period-label-cell">
          <div class="period-year-label">${year}</div>
          <div class="period-date-label">${dateRange}</div>
        </td>
        ${cells.join('')}
      </tr>`;
    }).join('');
    syncNameScrollAnimations(tbody, '.group-nikke-name-wrap', '.group-nikke-name');
    if (currentView === 'group') {
      requestAnimationFrame(() => setupGroupYearObserver());
    }
  }

  // ===== 픽업 달력 =====
  // 보고 있는 달(항상 1일로 고정) - 기본은 오늘이 속한 달
  let calendarMonth = new Date();
  calendarMonth.setDate(1);

  function initPickupCalendarNav() {
    document.getElementById('pickup-calendar-prev').addEventListener('click', () => {
      calendarMonth.setMonth(calendarMonth.getMonth() - 1);
      renderPickupCalendar();
    });
    document.getElementById('pickup-calendar-next').addEventListener('click', () => {
      calendarMonth.setMonth(calendarMonth.getMonth() + 1);
      renderPickupCalendar();
    });
    document.getElementById('pickup-calendar-today').addEventListener('click', () => {
      calendarMonth = new Date();
      calendarMonth.setDate(1);
      renderPickupCalendar();
    });
  }

  // 날짜만 비교(시:분 무시) - 픽업 시작/종료일이 날짜만 있는 경우가 많아서
  // 시간 정보가 섞이면 하루 밀려 보이는 문제가 생긴다
  function stripTime(d) {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
  }

  function isDayWithinPickup(day, start, end) {
    if (!start || !end) return false;
    const d = stripTime(day);
    return d >= stripTime(start) && d <= stripTime(end);
  }

  function renderPickupCalendar() {
    const data = getFilteredData();

    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    document.getElementById('pickup-calendar-month-label').textContent = `${year}년 ${month + 1}월`;

    const firstOfMonth = new Date(year, month, 1);
    const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
    const today = stripTime(new Date());

    const grid = document.getElementById('pickup-calendar-grid');
    const cellsHtml = [];
    for (let i = 0; i < 42; i++) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + i);
      const inMonth = day.getMonth() === month;
      const dayPickups = data.filter(p => isDayWithinPickup(day, p['시작일'], p['종료일']));
      cellsHtml.push(renderCalendarCell(day, inMonth, dayPickups, stripTime(day).getTime() === today.getTime()));
    }
    grid.innerHTML = cellsHtml.join('');

    // 니케 칩 클릭 시 타임라인의 해당 카드로 이동
    grid.querySelectorAll('.calendar-nikke-chip[data-nikke]').forEach(chip => {
      chip.addEventListener('click', () => jumpToPickupNikke(chip.dataset.nikke));
    });
  }

  function renderCalendarCell(day, inMonth, pickups, isToday) {
    const dow = day.getDay();
    const dowClass = dow === 0 ? 'is-sun' : dow === 6 ? 'is-sat' : '';
    const cellClass = ['calendar-cell', inMonth ? '' : 'is-outside', isToday ? 'is-today' : ''].filter(Boolean).join(' ');

    const chips = pickups.map(p => {
      const nikkeImg = pickupNikkeImgData.find(n => n['이름'] === p['니케']);
      const imgUrl = nikkeImg ? nikkeImg['이미지'] : '';
      const chipClass = ['calendar-nikke-chip', p['복각'] ? 'is-rerun' : ''].filter(Boolean).join(' ');
      const tooltip = `${p['니케']}${p['복각'] ? ' (복각)' : ''}`;
      return `
        <div class="${chipClass}" data-nikke="${p['니케']}" data-tooltip="${tooltip}">
          ${imgUrl ? `<img src="${imgUrl}" alt="${p['니케']}">` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="${cellClass}">
        <div class="calendar-date-label ${dowClass}">${day.getDate()}</div>
        <div class="calendar-nikke-list">${chips}</div>
      </div>
    `;
  }

  // ===== 연도 네비게이터 =====
  let yearNavObserver = null;
  let yearSections = [];
  let currentNavYear = null;

  function initYearNav() {
    document.getElementById('year-nav-up').addEventListener('click', () => moveToYear(-1));
    document.getElementById('year-nav-down').addEventListener('click', () => moveToYear(1));

    // 탭이 display:none일 때 getBoundingClientRect가 0을 반환하므로
    // pickup 탭이 활성화될 때 위치를 다시 계산
    const tabBtn = document.querySelector('[data-tab="pickup"]');
    if (tabBtn) {
      tabBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0 });
        requestAnimationFrame(positionYearNav);
      });
    }
    window.addEventListener('resize', positionYearNav);

    // 창 크기가 바뀌면 카드/칸 폭도 바뀌어서 이름 스크롤 여부·거리도 다시 재야 한다
    let nameScrollResizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(nameScrollResizeTimer);
      nameScrollResizeTimer = setTimeout(() => {
        if (currentView === 'timeline') {
          syncNameScrollAnimations(document.getElementById('pickup-timeline'), '.nikke-name-wrap', '.nikke-name');
        } else {
          syncNameScrollAnimations(document.getElementById('pickup-group-tbody'), '.group-nikke-name-wrap', '.group-nikke-name');
        }
      }, 200);
    });
  }

  function positionYearNav() {
    const nav = document.getElementById('pickup-year-nav');
    const container = document.getElementById('pickup-container');
    const containerRect = container.getBoundingClientRect();
    nav.style.left = (containerRect.left - 101) + 'px';
  }

  function updateYearNav() {
    const nav = document.getElementById('pickup-year-nav');
    // 달력 뷰는 한 달씩만 보여줘서 스크롤 기반 연도 이동이 의미가 없다 - 숨긴다
    if (currentView === 'calendar') {
      nav.classList.add('hidden');
      return;
    }
    nav.classList.remove('hidden');
    positionYearNav();
    if (currentView === 'timeline') {
      setupYearObserver();
    } else {
      // 몰아보기는 렌더링 후 호출되도록 약간 지연
      requestAnimationFrame(() => setupGroupYearObserver());
    }
  }

  function setupYearObserver() {
    if (yearNavObserver) {
      window.removeEventListener('scroll', yearNavObserver);
      yearNavObserver = null;
    }

    yearSections = [...document.querySelectorAll('#pickup-timeline .timeline-year')];
    if (yearSections.length === 0) return;

    const onScroll = () => {
      const mid = window.innerHeight / 2;
      // 스크롤 위치 기준으로 현재 연도 결정
      // rect.top <= mid 조건이 하나도 없으면(맨 위) 첫 번째(최신) 연도로
      let current = yearSections[0];
      for (const el of yearSections) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= mid) current = el;
        else break;
      }
      // rect.top이 모두 양수(맨 위)면 첫 번째 섹션이 최신 연도이므로 그대로 사용
      const year = current.querySelector('.year-label')?.textContent;
      if (year !== currentNavYear) {
        currentNavYear = year;
        document.getElementById('pickup-year-display').textContent = currentNavYear || '-';
        updateYearNavBtns();
      }
    };

    yearNavObserver = onScroll;
    window.addEventListener('scroll', onScroll, { passive: true });

    // 초기값: 스크롤이 맨 위면 첫 번째(최신) 연도로 강제 설정
    if (window.scrollY === 0) {
      const firstYear = yearSections[0].querySelector('.year-label')?.textContent;
      currentNavYear = firstYear || '-';
      document.getElementById('pickup-year-display').textContent = currentNavYear;
      updateYearNavBtns();
    } else {
      onScroll();
    }
  }

  function setupGroupYearObserver() {
    if (yearNavObserver) {
      window.removeEventListener('scroll', yearNavObserver);
      yearNavObserver = null;
    }

    // period-label-cell의 year 라벨들을 수집
    yearSections = [...document.querySelectorAll('#pickup-group-tbody .period-label-cell')];
    if (yearSections.length === 0) return;

    const onScroll = () => {
      const mid = window.innerHeight / 2;
      let current = yearSections[0];
      for (const el of yearSections) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= mid) current = el;
        else break;
      }
      const year = current.querySelector('.period-year-label')?.textContent;
      if (year !== currentNavYear) {
        currentNavYear = year;
        document.getElementById('pickup-year-display').textContent = currentNavYear || '-';
        updateYearNavBtns();
      }
    };

    yearNavObserver = onScroll;
    window.addEventListener('scroll', onScroll, { passive: true });

    // 초기값: 첫 번째(최신) 연도로 강제 설정
    if (window.scrollY === 0) {
      const firstYear = yearSections[0].querySelector('.period-year-label')?.textContent;
      currentNavYear = firstYear || '-';
      document.getElementById('pickup-year-display').textContent = currentNavYear;
      updateYearNavBtns();
    } else {
      onScroll();
    }
  }

  function updateYearNavBtns() {
    const labelKey = currentView === 'timeline' ? '.year-label' : '.period-year-label';
    const years = yearSections.map(el => el.querySelector(labelKey)?.textContent);
    const uniqueYears = [...new Set(years)];
    const idx = uniqueYears.indexOf(currentNavYear);
    document.getElementById('year-nav-up').disabled   = idx <= 0;
    document.getElementById('year-nav-down').disabled = idx >= uniqueYears.length - 1;
  }

  function moveToYear(direction) {
    if (currentView === 'timeline') {
      const years = yearSections.map(el => el.querySelector('.year-label')?.textContent);
      const idx = years.indexOf(currentNavYear);
      const target = yearSections[idx + direction];
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      // 몰아보기: 같은 연도 중 direction에 따라 첫/다음 연도 행으로 이동
      const years = yearSections.map(el => el.querySelector('.period-year-label')?.textContent);
      // 현재 연도와 다른 연도 경계 찾기
      const currentIdx = years.indexOf(currentNavYear);
      if (direction === -1) {
        // 이전(위) = 현재 연도보다 앞에 있는 다른 연도의 첫 번째 행
        for (let i = currentIdx - 1; i >= 0; i--) {
          if (years[i] !== currentNavYear) {
            // 해당 연도의 첫 번째 행 찾기
            const targetYear = years[i];
            const firstIdx = years.indexOf(targetYear);
            yearSections[firstIdx].closest('tr').scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }
      } else {
        // 다음(아래) = 현재 연도보다 뒤에 있는 다른 연도의 첫 번째 행
        for (let i = currentIdx + 1; i < years.length; i++) {
          if (years[i] !== currentNavYear) {
            yearSections[i].closest('tr').scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }
      }
    }
  }

  document.addEventListener('DOMContentLoaded', loadPickupData);
