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
    const seasons = [...new Set(data.map(d => d['시즌']).filter(Boolean))];
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

    strip.innerHTML = Object.entries(byEvent).map(([event, items]) => `
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
    const isCake = item['이름'] && item['이름'].includes('케이크');
    const desc = rawDesc.replace(/\n/g, '<br>');
    const descEl = document.getElementById('souvenir-detail-desc');
    const descWrap = document.getElementById('souvenir-detail-desc-wrap');
    descEl.innerHTML = desc;

    // 기존 오버레이 버튼 제거
    const existing = document.getElementById('souvenir-spoiler-overlay');
    if (existing) existing.remove();

    if (isCake && !revealedSouvenirs.has(item)) {
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
