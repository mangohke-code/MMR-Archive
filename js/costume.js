  let allCostumeData = [];
  let allNikkeImgData = [];
  let currentCostume = null;
  let spinePlayer = null;
  let costumePanZoom = null;
  let showRerunCostume = true;

  function loadCostumeData() {
    onAppDataReady(() => {
      allNikkeImgData = APP_DATA.nikkeImg || [];
      initCostume(APP_DATA.costume);
    });
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

  function initCostume(data) {
    if (!data || data.length === 0) return;
    allCostumeData = data;
    renderCostumeSelector(data);

    const toggle = document.getElementById('costume-rerun-toggle');
    toggle.classList.toggle('active', showRerunCostume);
    toggle.addEventListener('click', () => {
      showRerunCostume = !showRerunCostume;
      toggle.classList.toggle('active', showRerunCostume);
      renderCostumeSelector(allCostumeData);
    });

    // 탭이 display:none일 때는 폭을 잴 수 없으므로, 탭이 열릴 때/창 크기 변경 시 재계산
    const tabBtn = document.querySelector('[data-tab="costume"]');
    if (tabBtn) tabBtn.addEventListener('click', () => requestAnimationFrame(updateCostumeScrollBtns));
    window.addEventListener('resize', updateCostumeScrollBtns);
  }

  // 연도별 스크롤 영역이 실제로 넘칠 때만 좌우 화살표를 보여준다.
  function updateCostumeScrollBtns() {
    document.querySelectorAll('.costume-portrait-row').forEach(row => {
      const wrap = row.querySelector('.costume-portrait-scroll-wrap');
      if (!wrap) return;
      const needsScroll = wrap.scrollWidth > wrap.clientWidth + 1;
      row.querySelectorAll('.costume-scroll-btn').forEach(btn => {
        btn.classList.toggle('hidden', !needsScroll);
      });
    });
  }

  function renderCostumeSelector(data) {
    const now = new Date();

    // 원본 코스튬 목록 (시작일 기준 연도별)
    const originals = data.filter(c => c['시작일']);
    // 복각 항목 생성: 복각 시작일이 있는 코스튬에서 복각 항목을 별도로 만듦
    const reruns = showRerunCostume
      ? data
          .filter(c => c['복각 시작일'])
          .map(c => ({ ...c, _isRerun: true }))
      : [];

    // 원본 + 복각 합산 후 연도별 그룹핑
    const all = [...originals.map(c => ({ ...c, _isRerun: false })), ...reruns];

    const byYear = {};
    all.forEach(c => {
      const dateStr = c._isRerun ? c['복각 시작일'] : c['시작일'];
      const year = new Date(dateStr).getFullYear();
      if (!byYear[year]) byYear[year] = [];
      byYear[year].push(c);
    });

    // 연도 내부 오래된순 정렬
    Object.values(byYear).forEach(arr =>
      arr.sort((a, b) => {
        const da = new Date(a._isRerun ? a['복각 시작일'] : a['시작일']);
        const db = new Date(b._isRerun ? b['복각 시작일'] : b['시작일']);
        return da - db;
      })
    );
    const yearOrder = Object.keys(byYear).sort((a, b) => b - a);

    const container = document.getElementById('costume-selector-inner');
    container.innerHTML = yearOrder.map(year => `
      <div class="costume-year-section">
        <div class="costume-year-divider">
          <span class="costume-year-label">${year}</span>
          <div class="costume-year-line"></div>
        </div>
        <div class="costume-portrait-row">
          <button class="costume-scroll-btn" onclick="scrollCostumeRow(this, -1)">◀</button>
          <div class="costume-portrait-scroll-wrap">
          <div class="costume-portrait-list">
            ${byYear[year].map(c => {
              const nikkeImg = allNikkeImgData.find(n => n['이름'] === c['니케']);
              const costumeImgUrl = getCostumeThumbUrl(nikkeImg, c['코스튬명']);
              const origIdx = allCostumeData.indexOf(
                allCostumeData.find(o => o['니케'] === c['니케'] && o['코스튬명'] === c['코스튬명'])
              );

              const startDate = c._isRerun ? c['복각 시작일'] : c['시작일'];
              const endDate   = c._isRerun ? c['복각 종료일'] : c['종료일'];
              const isActive  = new Date(startDate) <= now && now <= new Date(endDate);
              const dateLabel = formatPortraitDate(startDate, endDate);

              const itemClass = [
                'costume-portrait-item',
                c._isRerun ? 'is-rerun' : '',
                isActive && c._isRerun ? 'is-rerun-active' : '',
              ].filter(Boolean).join(' ');

              return `
              <div class="${itemClass}" data-idx="${origIdx}" data-is-rerun="${c._isRerun}"
                   onclick="selectCostume(allCostumeData[${origIdx}], ${c._isRerun})">
                <div class="costume-portrait-img">
                  ${costumeImgUrl ? `<img src="${costumeImgUrl}" alt="${c['니케']}">` : c['니케']}
                  <div class="costume-portrait-date">${dateLabel}</div>
                </div>
                <div class="costume-portrait-name">${c['니케']}</div>
                ${c._isRerun ? `<div class="costume-rerun-badge">복각</div>` : ''}
                ${isActive && !c._isRerun ? `<div class="costume-active-badge">픽업 중</div>` : ''}
                ${isActive &&  c._isRerun ? `<div class="costume-active-badge">복각 중</div>` : ''}
              </div>
              `;
            }).join('')}
          </div>
          </div>
          <button class="costume-scroll-btn" onclick="scrollCostumeRow(this, 1)">▶</button>
        </div>
      </div>
    `).join('');

    requestAnimationFrame(updateCostumeScrollBtns);
  }

  function scrollCostumeRow(btn, direction) {
    const wrap = btn.parentElement.querySelector('.costume-portrait-scroll-wrap');
    if (!wrap) return;
    wrap.scrollTo({ left: direction < 0 ? 0 : wrap.scrollWidth, behavior: 'smooth' });
  }

  function selectCostume(costume, isRerun = false) {
    currentCostume = costume;

    document.getElementById('costume-top').classList.remove('hidden');
    document.querySelectorAll('.costume-portrait-item').forEach(el => {
      const sameIdx = Number(el.dataset.idx) === allCostumeData.indexOf(costume);
      const sameRerun = el.dataset.isRerun === String(isRerun);
      el.classList.toggle('active', sameIdx && sameRerun);
    });

    // 정보 업데이트
    document.getElementById('costume-nikke-name').textContent = costume['니케'];
    document.getElementById('costume-name').textContent = costume['코스튬명'];
    document.getElementById('costume-date').innerHTML =
      formatCostumeDate(costume['시작일'], costume['종료일']) +
      formatRemainingDays(costume['시작일'], costume['종료일']);
    document.getElementById('costume-ticket-name').textContent = costume['티켓'];

    const freeTicketWrap = document.getElementById('costume-free-ticket-wrap');
    const freeTicketImg  = document.getElementById('costume-free-ticket-img');
    const paidTicketImg  = document.getElementById('costume-paid-ticket-img');
    freeTicketImg.src = costume['무료티켓'] || '';
    freeTicketImg.dataset.tooltip = costume['티켓 설명'] || '';
    freeTicketWrap.style.display = costume['무료티켓'] ? 'block' : 'none';
    paidTicketImg.src = costume['유료티켓'] || '';
    paidTicketImg.dataset.tooltip = costume['티켓 설명'] || '';
    paidTicketImg.style.display = costume['유료티켓'] ? 'block' : 'none';

    // 복각 기간 표시 (원본/복각 어느 초상화를 클릭했든 복각 기간이 있으면 항상 표시)
    const rerunWrap = document.getElementById('costume-rerun-wrap');
    const rerunDate = document.getElementById('costume-rerun-date');
    if (costume['복각 시작일'] && costume['복각 종료일']) {
      rerunWrap.classList.remove('hidden');
      rerunDate.innerHTML =
        formatCostumeDate(costume['복각 시작일'], costume['복각 종료일']) +
        formatRemainingDays(costume['복각 시작일'], costume['복각 종료일']) +
        formatRerunGap(costume['시작일'], costume['복각 시작일']);
    } else {
      rerunWrap.classList.add('hidden');
    }

    // 스파인 플레이어 로드
    loadSpinePlayer(costume['skel'], costume['atlas']);
  }

  function loadSpinePlayer(skelUrl, atlasUrl) {
    const wrap = document.getElementById('costume-spine-player');
    wrap.innerHTML = '';

    const partsToggle = document.getElementById('costume-parts-toggle');
    if (partsToggle) { partsToggle.innerHTML = ''; partsToggle.classList.add('hidden'); }

    if (costumePanZoom) { costumePanZoom.destroy(); costumePanZoom = null; }

    if (!skelUrl || !atlasUrl) {
      return;
    }

    if (spinePlayer) {
      spinePlayer.dispose();
      spinePlayer = null;
    }

    const playerDiv = document.createElement('div');
    playerDiv.id = 'spine-player-inner';
    playerDiv.style.width = '100%';
    playerDiv.style.height = '100%';
    wrap.appendChild(playerDiv);

    spinePlayer = new spine.SpinePlayer('spine-player-inner', {
      skelUrl: skelUrl,
      atlasUrl: atlasUrl,
      animation: 'idle',
      backgroundColor: '#00000000',
      showControls: false,
      success: function(player) {
        const data = player.skeleton.data;
        const vp = { x: data.x, y: data.y, width: data.width, height: data.height };
        player.dispose();
        wrap.innerHTML = '';

        const wrapEl = document.getElementById('costume-spine-wrap');
        const wrapHeight = wrapEl.clientHeight;
        const wrapWidth = wrapEl.clientWidth;
        const ratio = vp.width / vp.height;
        const playerHeight = wrapHeight;
        const playerWidth = Math.round(playerHeight * ratio);
        const finalWidth = Math.min(playerWidth, wrapWidth);
        const finalHeight = Math.round(finalWidth / ratio);

        const playerDiv2 = document.createElement('div');
        playerDiv2.id = 'spine-player-inner';
        playerDiv2.style.width = wrapWidth + 'px';
        playerDiv2.style.height = wrapHeight + 'px';
        wrap.appendChild(playerDiv2);

        spinePlayer = new spine.SpinePlayer('spine-player-inner', {
          skelUrl: skelUrl,
          atlasUrl: atlasUrl,
          animation: 'idle',
          backgroundColor: '#00000000',
          showControls: false,
          preserveDrawingBuffer: false,
          antialias: true,
          viewport: {
            animationViewport: false,
            transitionTime: 0,
            x: -(vp.width / 2),
            y: vp.y,
            width: vp.width,
            height: vp.height,
            padLeft: '15%',
            padRight: '15%',
            padTop: '5%',
            padBottom: '5%',
          },
          success: function(player2) {
            const skeleton = player2.skeleton;
            // 파츠 온오프 기능은 임시로 뺌 (원인 파악 전까지) — 원본과 완전히 동일한 방식으로 복귀
            skeleton.setSkinByName('default');
            skeleton.data.skins.forEach(skin => {
              if (skin.name !== 'default') skeleton.skin.addSkin(skin);
            });
            skeleton.setToSetupPose();
            skeleton.updateWorldTransform();

            const partsToggleEl = document.getElementById('costume-parts-toggle');
            if (partsToggleEl) { partsToggleEl.innerHTML = ''; partsToggleEl.classList.add('hidden'); }

            costumePanZoom = setupSpinePanZoom(playerDiv2, wrapEl);

            player2.animationState.data.defaultMix = 0;

            player2.canvas.addEventListener('click', () => {
              try {
                player2.setAnimation('action', false);
                player2.animationState.addListener({
                  complete: () => {
                    try {
                      player2.setAnimation('idle', true);
                    } catch (err) {
                      console.error('[코스튬 L2D] idle 애니메이션 복귀 실패:', err);
                    }
                    player2.animationState.clearListeners();
                  }
                });
              } catch (err) {
                console.error('[코스튬 L2D] action 애니메이션 재생 실패:', err);
              }
            });
          }
        });
      }
    });
  }

  // 날짜 포맷
  function formatPortraitDate(start, end) {
    if (!start || !end) return '';
    const s = new Date(start);
    const e = new Date(end);
    const fmt = d => `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
    return `${fmt(s)}~${fmt(e)}`;
  }

  function formatCostumeDate(start, end) {
    if (!start || !end) return '-';
    const s = new Date(start);
    const e = new Date(end);
    const days = Math.round((e - s) / (1000 * 60 * 60 * 24));

    const fmtFull = d =>
      `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ` +
      `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

    return `${fmtFull(s)} ~<br>${fmtFull(e)}<span class="costume-date-days">(${days}일간)</span>`;
  }

  // 현재 진행중인 기간이면 종료까지 남은 일수를 D-n 배지로 표시
  function formatRemainingDays(start, end) {
    if (!start || !end) return '';
    const now = new Date();
    const s = new Date(start);
    const e = new Date(end);
    if (now < s || now > e) return '';
    const remain = Math.ceil((e - now) / (1000 * 60 * 60 * 24));
    return `<span class="costume-remaining-badge">D-${Math.max(remain, 0)}</span>`;
  }

  // 최초 픽업 시작일 기준 며칠 만에 복각했는지 표시
  function formatRerunGap(origStart, rerunStart) {
    if (!origStart || !rerunStart) return '';
    const gap = Math.round((new Date(rerunStart) - new Date(origStart)) / (1000 * 60 * 60 * 24));
    if (gap < 0) return '';
    return `<span class="costume-date-days">(최초 픽업 후 ${gap}일 만에 복각)</span>`;
  }

  function waitForSpine(callback) {
    if (typeof spine !== 'undefined') {
      callback();
    } else {
      setTimeout(() => waitForSpine(callback), 100);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    waitForSpine(loadCostumeData);
  });
