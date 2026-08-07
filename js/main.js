  function loadMainData() {
    onAppDataReady(() => {
      renderMainData(APP_DATA.main);
      renderPickupList(APP_DATA.pickup);
      renderCostumePickupList(APP_DATA.costume);
    });
  }

  function renderMainData(data) {
    renderUpdateLog(data.updateLog || []);

    const now = new Date();
    const activeEvents = data.events.filter(e => {
      const start = new Date(e['시작일']);
      const end = new Date(e['종료일']);
      return start <= now && now <= end;
    });
    renderEventList(activeEvents);
  }

  function renderUpdateLog(log) {
    const container = document.getElementById('update-log-list');
    if (!container) return;
    if (log.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = log.map(item => `
      <div class="update-log-item">
        <span class="update-log-date">${formatLogDate(item.date)}</span>
        <span class="update-log-note">${item.note || ''}</span>
      </div>
    `).join('');
  }

  function formatLogDate(date) {
    if (!date) return '-';
    const d = new Date(date);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  function renderEventList(events) {
    const container = document.getElementById('event-list');
    if (events.length === 0) {
      container.innerHTML = '<p>진행중인 이벤트가 없습니다.</p>';
      return;
    }
    container.innerHTML = events.map(e => `
      <div class="event-card">
        <img src="${e['이미지']}" alt="${e['이벤트명']}" onerror="this.style.display='none'">
        <div class="event-info">
          <div class="event-name">${e['이벤트명']}</div>
          <div class="event-meta">
            ${e['신규복각'] ? `<span class="badge-pickup-type ${e['신규복각'] === '복각' ? 'rerun' : 'new'}">${e['신규복각']}</span>` : ''}
            ${e['시즌'] ? `<span class="badge badge-season">${e['시즌']}</span>` : ''}
            <span class="event-date">${formatDate(e['시작일'])} ~ ${formatDate(e['종료일'])}</span>
          </div>
        </div>
      </div>
    `).join('');
  }

  const LIMITED_SEASONS = ['콜라보', '여름', '크리스마스'];

  function renderPickupList(data) {
    const now = new Date();
    const activePickups = data.filter(p => {
      const start = new Date(p['시작일']);
      const end = new Date(p['종료일']);
      end.setHours(23, 59, 59, 999); // 종료일에 시간 정보가 없어도(날짜만 있어도) 그날 전체를 포함하도록
      return start <= now && now <= end;
    });
    const upcomingPickups = data
      .filter(p => new Date(p['시작일']) > now)
      .sort((a, b) => new Date(a['시작일']) - new Date(b['시작일']));

    const nikkeImgMap = {};
    (APP_DATA.nikkeImg || []).forEach(n => {
      if (n['이름']) nikkeImgMap[n['이름']] = n['이미지'];
    });

    const renderNewCard = p => {
      const imgUrl = p['픽업 배너'] || nikkeImgMap[p['니케']] || '';
      const isLimited = LIMITED_SEASONS.includes(p['시즌']);
      return `
        <div class="pickup-card" data-nikke="${p['니케']}">
          ${imgUrl ? `<img src="${imgUrl}" alt="${p['니케']}" class="pickup-img">` : ''}
          <div class="pickup-card-info">
            <div class="pickup-name">${p['니케']}</div>
            <div class="pickup-date">
              <span class="badge-pickup-type new">신규</span>
              ${isLimited ? `<span class="badge-pickup-type limited">한정</span>` : ''}
              ${formatPickupDateMain(p['시작일'])} ~ ${formatPickupDateMain(p['종료일'])}
              ${formatRemainingDaysMain(p['시작일'], p['종료일']) || formatUntilStartMain(p['시작일'])}
            </div>
          </div>
        </div>
      `;
    };

    const renderRerunCard = p => {
      const imgUrl = p['픽업 배너'] || nikkeImgMap[p['니케']] || '';
      const isLimited = LIMITED_SEASONS.includes(p['시즌']);
      const remaining = formatRemainingDaysMain(p['시작일'], p['종료일']) || formatUntilStartMain(p['시작일']);
      return `
        <div class="pickup-card rerun" data-nikke="${p['니케']}">
          <div class="pickup-top-badges">
            <span class="badge-pickup-type rerun">복각</span>
            ${isLimited ? `<span class="badge-pickup-type limited">한정</span>` : ''}
          </div>
          ${imgUrl ? `<img src="${imgUrl}" alt="${p['니케']}" class="pickup-img-rerun">` : ''}
          <div class="pickup-card-info">
            <div class="pickup-name">${p['니케']}</div>
            <div class="pickup-date">${formatPickupDateMain(p['시작일'])} ~ ${formatPickupDateMain(p['종료일'])}</div>
            ${remaining ? `<div class="pickup-remaining-line">${remaining}</div>` : ''}
          </div>
        </div>
      `;
    };

    function renderInto(containerId, list) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const newPickups = list.filter(p => !p['복각']);
      const rerunPickups = list.filter(p => p['복각']);
      container.innerHTML = `
        ${newPickups.length > 0 ? `<div class="pickup-row">${newPickups.map(renderNewCard).join('')}</div>` : ''}
        ${rerunPickups.length > 0 ? `<div class="pickup-row">${rerunPickups.map(renderRerunCard).join('')}</div>` : ''}
      `;
      container.onclick = e => {
        const card = e.target.closest('.pickup-card[data-nikke]');
        if (card) jumpToPickupNikke(card.dataset.nikke);
      };
    }

    const activeContainer = document.getElementById('pickup-list');
    if (activePickups.length === 0) {
      activeContainer.innerHTML = '<p>진행중인 픽업이 없습니다.</p>';
    } else {
      renderInto('pickup-list', activePickups);
    }

    const upcomingSection = document.getElementById('main-pickup-upcoming');
    if (upcomingSection) {
      if (upcomingPickups.length === 0) {
        upcomingSection.classList.add('hidden');
      } else {
        upcomingSection.classList.remove('hidden');
        renderInto('pickup-upcoming-list', upcomingPickups);
      }
    }
  }

  function renderCostumePickupList(data) {
    const now = new Date();

    // 코스튬은 픽업(니케)과 달리 원본/복각이 한 행(row)에 시작일·복각 시작일로 함께 들어있으므로
    // 각각 별도 항목으로 펼친 뒤 지금 활성 상태인 것만 남긴다 (코스튬 탭 선택기와 동일한 방식)
    const originals = data.map(c => ({ ...c, _isRerun: false }));
    const reruns = data
      .filter(c => c['복각 시작일'])
      .map(c => ({ ...c, _isRerun: true }));
    const all = [...originals, ...reruns];

    const activeCostumes = all.filter(c => {
      const startDate = c._isRerun ? c['복각 시작일'] : c['시작일'];
      const endDate = c._isRerun ? c['복각 종료일'] : c['종료일'];
      if (!startDate || !endDate) return false;
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      return start <= now && now <= end;
    });
    const upcomingCostumes = all
      .filter(c => {
        const startDate = c._isRerun ? c['복각 시작일'] : c['시작일'];
        if (!startDate) return false;
        return new Date(startDate) > now;
      })
      .sort((a, b) => {
        const startA = a._isRerun ? a['복각 시작일'] : a['시작일'];
        const startB = b._isRerun ? b['복각 시작일'] : b['시작일'];
        return new Date(startA) - new Date(startB);
      });

    const nikkeImgMap = {};
    (APP_DATA.nikkeImg || []).forEach(n => {
      if (n['이름']) nikkeImgMap[n['이름']] = n;
    });

    const renderCard = c => {
      const imgUrl = getCostumeThumbUrl(nikkeImgMap[c['니케']], c['코스튬명']);
      const startDate = c._isRerun ? c['복각 시작일'] : c['시작일'];
      const endDate = c._isRerun ? c['복각 종료일'] : c['종료일'];
      const remaining = formatRemainingDaysMain(startDate, endDate) || formatUntilStartMain(startDate);
      return `
        <div class="pickup-card ${c._isRerun ? 'rerun' : ''}" data-nikke="${c['니케']}" data-costume="${c['코스튬명']}" data-is-rerun="${c._isRerun}">
          <div class="pickup-top-badges">
            <span class="badge-pickup-type ${c._isRerun ? 'rerun' : 'new'}">${c._isRerun ? '복각' : '신규'}</span>
          </div>
          ${imgUrl ? `<img src="${imgUrl}" alt="${c['니케']}" class="${c._isRerun ? 'pickup-img-rerun' : 'pickup-img'}">` : ''}
          <div class="pickup-card-info">
            <div class="pickup-name">${c['니케']} · ${c['코스튬명']}</div>
            <div class="pickup-date">${formatPickupDateMain(startDate)} ~ ${formatPickupDateMain(endDate)}</div>
            ${remaining ? `<div class="pickup-remaining-line">${remaining}</div>` : ''}
          </div>
        </div>
      `;
    };

    function renderInto(containerId, list) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const newCostumes = list.filter(c => !c._isRerun);
      const rerunCostumes = list.filter(c => c._isRerun);
      container.innerHTML = `
        ${newCostumes.length > 0 ? `<div class="pickup-row">${newCostumes.map(renderCard).join('')}</div>` : ''}
        ${rerunCostumes.length > 0 ? `<div class="pickup-row">${rerunCostumes.map(renderCard).join('')}</div>` : ''}
      `;
      container.onclick = e => {
        const card = e.target.closest('.pickup-card[data-nikke]');
        if (!card) return;
        jumpToCostume(card.dataset.nikke, card.dataset.costume, card.dataset.isRerun === 'true');
      };
    }

    const activeContainer = document.getElementById('costume-pickup-list');
    if (activeContainer) {
      if (activeCostumes.length === 0) {
        activeContainer.innerHTML = '<p>진행중인 코스튬 픽업이 없습니다.</p>';
      } else {
        renderInto('costume-pickup-list', activeCostumes);
      }
    }

    const upcomingSection = document.getElementById('main-costume-pickup-upcoming');
    if (upcomingSection) {
      if (upcomingCostumes.length === 0) {
        upcomingSection.classList.add('hidden');
      } else {
        upcomingSection.classList.remove('hidden');
        renderInto('costume-pickup-upcoming-list', upcomingCostumes);
      }
    }
  }

  function formatPickupDateMain(date) {
    if (!date) return '-';
    const d = new Date(date);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  // 진행중인 픽업/코스튬 픽업 카드에 종료까지 남은 일수를 D-n 배지로 표시
  function formatRemainingDaysMain(start, end) {
    if (!start || !end) return '';
    const now = new Date();
    const s = new Date(start);
    const e = new Date(end);
    e.setHours(23, 59, 59, 999); // 종료일에 시간 정보가 없어도 그날 전체를 포함하도록
    if (now < s || now > e) return '';
    const remain = Math.ceil((e - now) / (1000 * 60 * 60 * 24));
    return `<span class="pickup-remaining-badge">종료까지 D-${Math.max(remain, 0)}</span>`;
  }

  // 진행 예정 픽업/코스튬 픽업 카드에 시작까지 남은 일수를 D-n 배지로 표시
  function formatUntilStartMain(start) {
    if (!start) return '';
    const now = new Date();
    const s = new Date(start);
    if (now >= s) return '';
    const remain = Math.ceil((s - now) / (1000 * 60 * 60 * 24));
    return `<span class="pickup-remaining-badge">시작까지 D-${Math.max(remain, 0)}</span>`;
  }

  function formatDate(date) {
    if (!date) return '-';
    const d = new Date(date);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  document.addEventListener('DOMContentLoaded', loadMainData);
