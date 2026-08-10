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
    const chapters = getDisplayChapterList();

    const makeCard = (ch) => {
      const chapImg = allChapImgData.find(c => String(c['챕터']) === String(ch));
      const imgUrl = chapImg ? chapImg['이미지'] : '';
      const chapName = chapImg ? chapImg['명칭'] : '';
      const locked = !hasStageData(ch);   // 스테이지 정보가 없으면 열 수 없다
      return `
        <div class="chapter-card ${locked ? 'is-locked' : ''}" data-chapter="${ch}">
          <div class="chapter-img">
            ${imgUrl ? `<img src="${imgUrl}" alt="챕터 ${ch}" onerror="this.style.display='none'">` : ''}
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
    applyModeTheme();
    renderChapterNav(direction);
    renderStageTable();
  }

  function compareChapter(a, b) {
    const na = Number(a), nb = Number(b);
    if (na === 0 && nb !== 0) return -1;
    if (nb === 0 && na !== 0) return 1;
    return na - nb;
  }

  // 스테이지 정보가 들어있는 챕터 — 실제로 열어볼 수 있는 챕터.
  // 상세 화면의 이전/다음 이동도 이 목록을 따라가므로 빈 챕터로 넘어가지 않는다.
  function getChapterList() {
    return [...new Set(allStageData.map(s => s['챕터']))].sort(compareChapter);
  }

  // 카드로 보여줄 챕터 — IMG_챕터에만 올라와 있고 스테이지 정보는 아직 없는 새 챕터도 넣는다.
  // 새 챕터가 나왔는데 스테이지를 아직 못 채웠어도 자리는 보이게 하려는 것.
  function getDisplayChapterList() {
    const list = new Set(allStageData.map(s => String(s['챕터'])));
    (allChapImgData || []).forEach(c => {
      const ch = c['챕터'];
      if (ch !== null && ch !== undefined && String(ch) !== '') list.add(String(ch));
    });
    return [...list].sort(compareChapter);
  }

  // 스테이지 정보가 있어야 눌러서 들어갈 수 있다
  function hasStageData(ch) {
    return allStageData.some(s => String(s['챕터']) === String(ch));
  }

  function renderChapterNav(direction = null) {
    // 옆칸에는 아직 스테이지가 없는 챕터도 보여준다(자물쇠 표시). 그래서 스테이지 기준이
    // 아니라 카드 그리드와 같은 전체 목록을 쓴다.
    const chapters = getDisplayChapterList();
    const idx = chapters.findIndex(ch => String(ch) === String(currentChapter));

    const prevCh = idx > 0 ? chapters[idx - 1] : null;
    const nextCh = idx < chapters.length - 1 ? chapters[idx + 1] : null;

    const makeNavContent = (ch, isComingSoon = false) => {
      if (isComingSoon) return `<div class="chapter-label" style="transform:translate(-50%,-50%) rotate(-8deg);">Coming Soon...</div>`;
      if (ch === null || ch === undefined) return '';
      const chapImg = allChapImgData.find(c => String(c['챕터']) === String(ch));
      const imgUrl = chapImg ? chapImg['이미지'] : '';
      const chapName = chapImg ? chapImg['명칭'] : '';
      const locked = !hasStageData(ch);
      return `
        ${imgUrl ? `<img src="${imgUrl}" alt="챕터 ${ch}">` : ''}
        <div class="chapter-label">CHAPTER.${ch}<br>${chapName}</div>
        ${locked ? `<div class="chapter-lock"><i class="fas fa-lock"></i></div>` : ''}
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

    // 잠긴 챕터 칸은 눌러도 반응하지 않는다 (커서/호버도 같이 죽인다)
    prevEl.classList.toggle('is-locked', prevCh !== null && !hasStageData(prevCh));
    nextEl.classList.toggle('is-locked', isLast || (nextCh !== null && !hasStageData(nextCh)));
  }

  function navigateChapter(direction) {
    const chapters = getDisplayChapterList();
    const idx = chapters.findIndex(ch => String(ch) === String(currentChapter));
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= chapters.length) return;
    const target = chapters[newIdx];
    if (!hasStageData(target)) return;   // 스테이지가 없는 챕터로는 넘어가지 않는다
    selectChapter(target, direction);
  }

  // 노말은 푸른 계열, 하드는 검붉은 계열. 상세 화면 전체에 표시를 걸어두고 색은 CSS 가 잡는다.
  function applyModeTheme() {
    const detail = document.getElementById('stage-detail');
    if (detail) detail.dataset.mode = currentMode;
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

    // 글자를 흐리게만 하면 글자 길이가 그대로 드러난다. 보스가 있는 줄만 덩어리가 길쭉해서
    // "여기가 보스 스테이지구나"가 다 보이고, 비어 있는 줄("-")은 점 하나로 보인다.
    // 그래서 흐림 대신, 값이 있든 없든 모든 줄을 똑같은 크기의 가림막으로 바꾼다.
    document.querySelectorAll('.blurable-cell').forEach(el => {
      // 가리고 나면 칸에서 원래 값을 읽을 수 없으므로 처음 한 번만 따로 보관한다
      if (el.dataset.real === undefined) el.dataset.real = el.textContent;
      if (isRevealed) {
        el.textContent = el.dataset.real;
        el.classList.remove('spoiler-blur');
      } else {
        el.innerHTML = '<span class="spoiler-mask"></span>';
        el.classList.add('spoiler-blur');
      }
    });

    if (isRevealed) return;

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
    // 챕터 카드 클릭 (이벤트 위임 — 렌더될 때마다 innerHTML로 새로 그려지므로 컨테이너에 한 번만 등록)
    const handleChapterCardClick = (e) => {
      const card = e.target.closest('.chapter-card');
      // 스테이지 정보가 아직 없는 챕터는 눌러도 아무 일이 없어야 한다
      if (card && !card.classList.contains('is-locked')) selectChapter(card.dataset.chapter);
    };
    document.getElementById('chapter-grid-zero').addEventListener('click', handleChapterCardClick);
    document.getElementById('chapter-grid').addEventListener('click', handleChapterCardClick);

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
        applyModeTheme();
        renderStageTable();
      });
    });

    loadStageData();
  });
