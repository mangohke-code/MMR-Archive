  let allStageData = [];
  let currentChapter = null;
  let currentMode = 'normal';
  let allChapImgData = [];
  let stageIconImgData = {};

  const revealedChapters = new Set();

  function loadStageData() {
    onAppDataReady(() => {
      stageIconImgData = APP_DATA.iconImg || {};
      allChapImgData = APP_DATA.chapImg || [];
      initStage(APP_DATA.stage);
    });
  }

  function initStage(data) {
    if (!data || data.length === 0) return;
    allStageData = data;
    renderChapterGrid(data);
  }

  function renderChapterGrid(data) {
    const chapters = getChapterList();

    const makeCard = (ch) => {
      const chapImg = allChapImgData.find(c => String(c['챕터']) === String(ch));
      const imgUrl = chapImg ? chapImg['이미지'] : '';
      const chapName = chapImg ? chapImg['명칭'] : '';
      return `
        <div class="chapter-card" onclick="selectChapter(${JSON.stringify(ch)})">
          <div class="chapter-img">
            <img src="${imgUrl}" alt="챕터 ${ch}" onerror="this.style.display='none'">
            <div class="chapter-label">CHAPTER.${ch}<br>${chapName}</div>
          </div>
        </div>
      `;
    };

    const zeroChapters = chapters.filter(ch => String(ch) === '0');
    const restChapters = chapters.filter(ch => String(ch) !== '0');

    document.getElementById('chapter-grid-zero').innerHTML = zeroChapters.map(makeCard).join('');
    document.getElementById('chapter-grid').innerHTML = restChapters.map(makeCard).join('');
  }

  function selectChapter(chapter, direction = null) {
    currentChapter = chapter;

    // 챕터 그리드 숨기고 상세 표시
    const grid = document.getElementById('chapter-grid');
    const gridZero = document.getElementById('chapter-grid-zero');
    const detail = document.getElementById('stage-detail');
    grid.classList.add('hidden');
    gridZero.classList.add('hidden');
    detail.classList.remove('hidden');
    detail.classList.add('fade-in');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    document.getElementById('stage-chapter-title').textContent = `챕터 ${chapter}`;
    renderChapterNav(direction);
    renderStageTable();
  }

  function getChapterList() {
    return [...new Set(allStageData.map(s => s['챕터']))].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (na === 0 && nb !== 0) return -1;
      if (nb === 0 && na !== 0) return 1;
      return na - nb;
    });
  }

  function renderChapterNav(direction = null) {
    const chapters = getChapterList();
    const idx = chapters.findIndex(ch => String(ch) === String(currentChapter));

    const prevCh = idx > 0 ? chapters[idx - 1] : null;
    const nextCh = idx < chapters.length - 1 ? chapters[idx + 1] : null;

    const makeNavContent = (ch, isComingSoon = false) => {
      if (isComingSoon) return `<div class="chapter-label" style="transform:translate(-50%,-50%) rotate(-8deg);">Coming Soon...</div>`;
      if (ch === null || ch === undefined) return '';
      const chapImg = allChapImgData.find(c => String(c['챕터']) === String(ch));
      const imgUrl = chapImg ? chapImg['이미지'] : '';
      const chapName = chapImg ? chapImg['명칭'] : '';
      return `
        ${imgUrl ? `<img src="${imgUrl}" alt="챕터 ${ch}">` : ''}
        <div class="chapter-label">CHAPTER.${ch}<br>${chapName}</div>
      `;
    };

    const nav = document.getElementById('chapter-nav');

    // 방향에 따라 애니메이션 클래스 적용
    nav.classList.remove('animate-left', 'animate-right');
    if (direction === 1)  {
      void nav.offsetWidth; // reflow
      nav.classList.add('animate-right');
    } else if (direction === -1) {
      void nav.offsetWidth;
      nav.classList.add('animate-left');
    }

    const prevEl = document.getElementById('chapter-nav-prev');
    const currEl = document.getElementById('chapter-nav-current');
    const nextEl = document.getElementById('chapter-nav-next');

    const isLast = idx === chapters.length - 1;

    prevEl.innerHTML = makeNavContent(prevCh);
    currEl.innerHTML = makeNavContent(currentChapter);
    nextEl.innerHTML = isLast ? makeNavContent(null, true) : makeNavContent(nextCh);

    prevEl.style.visibility = prevCh !== null ? 'visible' : 'hidden';
    nextEl.style.visibility = 'visible';
  }

  function navigateChapter(direction) {
    const chapters = getChapterList();
    const idx = chapters.findIndex(ch => String(ch) === String(currentChapter));
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= chapters.length) return;
    selectChapter(chapters[newIdx], direction);
  }

  function renderStageTable() {
    const data = allStageData.filter(s => {
      if (String(s['챕터']) !== String(currentChapter)) return false;
      const bp = currentMode === 'normal' ? s['노말전투력'] : s['하드전투력'];
      return bp !== null && bp !== undefined && bp !== '';
    });
    const tbody = document.getElementById('stage-table-body');

    tbody.innerHTML = data.map(s => {
      const bp = currentMode === 'normal' ? s['노말전투력'] : s['하드전투력'];
      const boss = currentMode === 'normal' ? s['노말보스'] : s['하드보스'];
      const code = currentMode === 'normal' ? s['노말약점'] : s['하드약점'];
      const type = currentMode === 'normal' ? s['노말유형'] : s['하드유형'];
      const isEX = String(s['스테이지'] ?? '').includes('EX');
      return `
        <tr${isEX ? ' class="stage-row-ex"' : ''}>
          <td>${String(s['스테이지'] ?? '-')}</td>
          <td>${String(bp ?? '-')}</td>
          <td class="blurable-cell">${String(boss ?? '-')}</td>
          <td style="text-align:center;">${
            (() => {
              const val = String(code ?? '');
              if (!val) return '-';
              const iconUrl = stageIconImgData['우월코드'] && stageIconImgData['우월코드'][val]
                ? stageIconImgData['우월코드'][val] : null;
              return iconUrl
                ? `<img src="${iconUrl}" alt="${val}" class="stage-code-icon" title="${val}">`
                : val;
            })()
          }</td>
          <td>${String(s['스토리'] ?? '-')}</td>
          <td class="blurable-cell">${String(type ?? '-')}</td>
          <td>${String(s['특이사항'] ?? '-')}</td>
        </tr>
      `;
    }).join('');

    applyStageBlur();
  }

  function applyStageBlur() {
    const key = `${currentChapter}_${currentMode}`;
    const isRevealed = revealedChapters.has(key);

    const existing = document.getElementById('stage-spoiler-overlay');
    if (existing) existing.remove();

    if (isRevealed) {
      document.querySelectorAll('.blurable-cell').forEach(el => el.classList.remove('spoiler-blur'));
      return;
    }

    document.querySelectorAll('.blurable-cell').forEach(el => el.classList.add('spoiler-blur'));

    // 보스 열(3번째 th) 위치 기준으로 버튼 배치
    const bossHeader = document.querySelector('#stage-table th:nth-child(3)');
    if (!bossHeader) return;

    const tableWrap = document.getElementById('stage-table-wrap');
    tableWrap.style.position = 'relative';

    const thRect = bossHeader.getBoundingClientRect();
    const wrapRect = tableWrap.getBoundingClientRect();
    const leftOffset = thRect.left - wrapRect.left + thRect.width / 2;

    const overlay = document.createElement('button');
    overlay.id = 'stage-spoiler-overlay';
    overlay.className = 'spoiler-reveal-btn';
    overlay.style.position = 'absolute';
    overlay.style.top = '50%';
    overlay.style.left = leftOffset + 'px';
    overlay.style.transform = 'translate(-50%, -50%)';
    overlay.style.zIndex = '10';
    overlay.textContent = '스포일러 해제';
    overlay.addEventListener('click', () => {
      revealedChapters.add(key);
      applyStageBlur();
    });

    tableWrap.appendChild(overlay);
  }

  // 뒤로가기
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('stage-back-btn').addEventListener('click', () => {
      const grid = document.getElementById('chapter-grid');
      const gridZero = document.getElementById('chapter-grid-zero');
      const detail = document.getElementById('stage-detail');
      detail.classList.add('hidden');
      grid.classList.remove('hidden');
      gridZero.classList.remove('hidden');
      grid.classList.add('fade-in');
      gridZero.classList.add('fade-in');
      currentChapter = null;
    });

    // 노말/하드 전환
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = btn.dataset.mode;
        renderStageTable();
      });
    });

    loadStageData();
  });
