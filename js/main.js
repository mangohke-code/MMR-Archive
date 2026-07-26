  function loadMainData() {
    onAppDataReady(() => {
      renderMainData(APP_DATA.main);
      renderPickupList(APP_DATA.pickup);
    });
  }

  function renderMainData(data) {
    const updateDate = data.update['업데이트 날짜'];
    document.getElementById('update-date').textContent = updateDate ? formatUpdateDate(updateDate) : '-';

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

  function renderPickupList(data) {
    const now = new Date();
    const activePickups = data.filter(p => {
      const start = new Date(p['시작일']);
      const end = new Date(p['종료일']);
      return start <= now && now <= end;
    });

    const nikkeImgMap = {};
    (APP_DATA.nikkeImg || []).forEach(n => {
      if (n['이름']) nikkeImgMap[n['이름']] = n['이미지'];
    });

    const container = document.getElementById('pickup-list');
    if (activePickups.length === 0) {
      container.innerHTML = '<p>진행중인 픽업이 없습니다.</p>';
      return;
    }

    const newPickups  = activePickups.filter(p => !p['복각']);
    const rerunPickups = activePickups.filter(p => p['복각']);

    const renderNewCard = p => {
      const imgUrl = p['픽업 배너'] || nikkeImgMap[p['니케']] || '';
      return `
        <div class="pickup-card">
          ${imgUrl ? `<img src="${imgUrl}" alt="${p['니케']}" class="pickup-img">` : ''}
          <div class="pickup-card-info">
            <div class="pickup-name">${p['니케']}</div>
            <div class="pickup-date">
              <span class="badge-pickup-type new">신규</span>
              ${formatPickupDateMain(p['시작일'])} ~ ${formatPickupDateMain(p['종료일'])}
            </div>
          </div>
        </div>
      `;
    };

    const renderRerunCard = p => {
      const imgUrl = p['픽업 배너'] || nikkeImgMap[p['니케']] || '';
      return `
        <div class="pickup-card rerun">
          ${imgUrl ? `<img src="${imgUrl}" alt="${p['니케']}" class="pickup-img-rerun">` : ''}
          <div class="pickup-card-info">
            <div class="pickup-name">${p['니케']}</div>
            <div class="pickup-date">
              <span class="badge-pickup-type rerun">복각</span>
              ${formatPickupDateMain(p['시작일'])} ~ ${formatPickupDateMain(p['종료일'])}
            </div>
          </div>
        </div>
      `;
    };

    container.innerHTML = `
      ${newPickups.length > 0 ? `<div class="pickup-row">${newPickups.map(renderNewCard).join('')}</div>` : ''}
      ${rerunPickups.length > 0 ? `<div class="pickup-row">${rerunPickups.map(renderRerunCard).join('')}</div>` : ''}
    `;
  }

  function formatPickupDateMain(date) {
    if (!date) return '-';
    const d = new Date(date);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatDate(date) {
    if (!date) return '-';
    const d = new Date(date);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function formatUpdateDate(date) {
    if (!date) return '-';
    const d = new Date(date);
    return `최종 수정일: ${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
  }

  document.addEventListener('DOMContentLoaded', loadMainData);
