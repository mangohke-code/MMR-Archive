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
    fillPenaltyChapters();
  }

  // ===== 전투력 패널티 계산 (사용자 요청, 2026-11-11) =====
  // 결손(%) = 100 - 100 x 내 전투력 / 기준 전투력. 니케 전원의 스탯(공격 · 체력 · 방어)이 아래 표의 % 만큼 준다.
  // 표는 게임 로컬 데이터에 없어서 커뮤니티 실측값(Prydwen "Stage penalty", 2024-02-14 갱신, 원출처 nikke.gg)을 쓴다.
  // 결손 0.01% 부터 0.1% 간격(0.01, 0.11, ... 49.91) 500칸. 결손 이하인 가장 큰 칸을 고른다.
  // 기준 전투력은 CampaignStageTable.standard_battle_power, 45% 미만 입장 제한은
  // ConfigGameTable.MinCombatPowerStageNotEnterDefaultStageRatio = 45 (키 이름 기준 해석) - 추출 프로그램 세션 확인.
  const STAGE_PENALTY = [
    5,5.51,6.01,6.51,7.01,7.5,7.99,8.48,8.95,9.43,9.9,10.37,10.83,11.29,11.74,12.19,12.64,13.08,13.52,13.95,14.38,14.81,15.23,15.65,16.06,
    16.47,16.87,17.27,17.66,18.06,18.44,18.83,19.21,19.58,19.95,20.32,20.68,21.04,21.39,21.74,22.08,22.42,22.76,23.09,23.42,23.75,24.07,24.38,24.69,25,
    25.3,25.6,25.9,26.19,26.47,26.76,27.03,27.31,27.58,27.84,28.1,28.36,28.61,28.86,29.1,29.34,29.58,29.81,30.04,30.26,30.48,30.7,30.91,31.11,31.31,
    31.51,31.71,31.9,32.08,32.26,32.44,32.61,32.78,32.94,33.1,33.26,33.41,33.56,33.7,33.84,33.98,34.11,34.23,34.36,34.47,34.59,34.7,34.8,34.9,35,
    35.14,35.28,35.41,35.55,35.69,35.83,35.96,36.1,36.24,36.38,36.51,36.65,36.79,36.93,37.06,37.2,37.34,37.48,37.61,37.75,37.89,38.03,38.16,38.3,38.44,
    38.58,38.71,38.85,38.99,39.13,39.26,39.4,39.54,39.68,39.81,39.95,40.09,40.23,40.36,40.5,40.64,40.78,40.91,41.05,41.19,41.33,41.46,41.6,41.74,41.88,
    42.01,42.15,42.29,42.43,42.56,42.7,42.84,43,43.1,43.2,43.3,43.4,43.5,43.6,43.7,43.8,43.9,44,44.1,44.2,44.3,44.4,44.5,44.6,44.7,
    44.8,44.9,45,45.1,45.2,45.3,45.4,45.5,45.6,45.7,45.8,45.9,46,46.1,46.2,46.3,46.4,46.5,46.6,46.7,46.8,46.9,47,47.1,47.2,
    47.3,47.4,47.5,47.6,47.7,47.8,47.9,48,48.1,48.2,48.3,48.4,48.5,48.6,48.7,48.8,48.9,49,49.1,49.2,49.3,49.4,49.5,49.6,49.7,
    49.8,49.9,50,50.1,50.2,50.3,50.4,50.5,50.6,50.7,50.8,50.9,51,51.1,51.2,51.3,51.4,51.5,51.6,51.7,51.8,51.9,52,52.1,52.2,
    52.3,52.4,52.5,52.6,52.7,52.8,52.9,53,53.1,53.2,53.3,53.4,53.5,53.6,53.7,53.8,53.9,54,54.1,54.2,54.3,54.4,54.5,54.6,54.7,
    54.8,54.9,55,55.1,55.2,55.3,55.4,55.5,55.6,55.7,55.8,55.9,56,56.1,56.2,56.3,56.4,56.5,56.6,56.7,56.8,56.9,57,57.1,57.2,
    57.3,57.4,57.5,57.6,57.7,57.8,57.9,58,58.1,58.2,58.3,58.4,58.5,58.6,58.7,58.8,58.9,59,59.1,59.2,59.3,59.4,59.5,59.6,59.7,
    59.8,59.9,60,60.1,60.2,60.3,60.4,60.5,60.6,60.7,60.8,60.9,61,61.1,61.2,61.3,61.4,61.5,61.6,61.7,61.8,61.9,62,62.1,62.2,
    62.3,62.4,62.5,62.6,62.7,62.8,62.9,63,63.1,63.2,63.3,63.4,63.5,63.6,63.7,63.8,63.9,64,64.1,64.2,64.3,64.4,64.5,64.6,64.7,
    64.8,64.9,65,65.1,65.2,65.3,65.4,65.5,65.6,65.7,65.8,65.9,66,66.1,66.2,66.3,66.4,66.5,66.6,66.7,66.8,66.9,67,67.1,67.2,
    67.3,67.4,67.5,67.6,67.7,67.8,67.9,68,68.1,68.2,68.3,68.4,68.5,68.6,68.7,68.8,68.9,69,69.1,69.2,69.3,69.4,69.5,69.6,69.7,
    69.8,69.9,70,70.1,70.2,70.3,70.4,70.5,70.6,70.7,70.8,70.9,71,71.1,71.2,71.3,71.4,71.5,71.6,71.7,71.8,71.9,72,72.1,72.2,
    72.3,72.4,72.5,72.6,72.7,72.8,72.9,73,73.1,73.2,73.3,73.4,73.5,73.6,73.7,73.8,73.9,74,74.1,74.2,74.3,74.4,74.5,74.6,74.7,
    74.8,74.9,75,75.1,75.2,75.3,75.4,75.5,75.6,75.7,75.8,75.9,76,76.1,76.2,76.3,76.4,76.5,76.6,76.7,76.8,76.9,77,77.1,90
  ];
  const STAGE_ENTRY_MIN_RATIO = 0.45;

  // 결손(%) → 스탯 감소(%). 기준 이상이면 0.
  function stagePenaltyOf(deficit) {
    if (!(deficit >= 0.01)) return 0;
    const k = Math.min(STAGE_PENALTY.length - 1, Math.floor((deficit - 0.01) / 0.1 + 1e-9));
    return STAGE_PENALTY[k];
  }

  const PENALTY_KEY = 'mmr-stage-penalty';
  let penaltyMode = 'normal';

  const parseCp = v => {
    const n = Number(String(v || '').replace(/[^\d]/g, ''));
    return n > 0 ? n : 0;
  };
  const fmtCp = n => (n ? n.toLocaleString('ko-KR') : '');
  const cpOfStage = (s, mode) => parseCp(/^\d+$/.test(String(s[mode === 'normal' ? '노말전투력' : '하드전투력'] ?? '').trim())
    ? s[mode === 'normal' ? '노말전투력' : '하드전투력'] : '');

  // 챕터 · 스테이지 고르기: 기준 전투력이 숫자로 적힌 스테이지만(레벨 고정 EX 등은 뺀다)
  function fillPenaltyChapters() {
    const chSel = document.getElementById('spn-chapter');
    if (!chSel) return;
    const chapters = [...new Set(allStageData.filter(s => cpOfStage(s, penaltyMode)).map(s => String(s['챕터'])))]
      .sort(compareChapter);
    const keep = chSel.value;
    chSel.innerHTML = '<option value="">챕터</option>'
      + chapters.map(ch => `<option value="${ch}">${String(ch).padStart(2, '0')}</option>`).join('');
    if (chapters.includes(keep)) chSel.value = keep;
    fillPenaltyStages();
  }

  function fillPenaltyStages() {
    const ch = document.getElementById('spn-chapter').value;
    const stSel = document.getElementById('spn-stage');
    const keep = stSel.value;
    const list = ch ? allStageData.filter(s => String(s['챕터']) === ch && cpOfStage(s, penaltyMode)) : [];
    stSel.innerHTML = '<option value="">스테이지</option>'
      + list.map(s => `<option value="${s['스테이지']}">${ch}-${s['스테이지']}</option>`).join('');
    stSel.disabled = !list.length;
    if (list.some(s => String(s['스테이지']) === keep)) stSel.value = keep;
  }

  // 고른 스테이지의 기준 전투력을 기준 칸에 넣는다(직접 고쳐 쓸 수도 있다)
  function applyPenaltyStage() {
    const ch = document.getElementById('spn-chapter').value;
    const st = document.getElementById('spn-stage').value;
    const s = allStageData.find(x => String(x['챕터']) === ch && String(x['스테이지']) === st);
    if (s) document.getElementById('spn-req').value = fmtCp(cpOfStage(s, penaltyMode));
    renderPenalty();
  }

  function renderPenalty() {
    const my = parseCp(document.getElementById('spn-my').value);
    const req = parseCp(document.getElementById('spn-req').value);
    const out = document.getElementById('spn-result');
    try { localStorage.setItem(PENALTY_KEY, JSON.stringify({ my, mode: penaltyMode })); } catch (e) {}
    if (!my || !req) { out.innerHTML = ''; out.dataset.level = ''; return; }
    const deficit = Math.max(0, 100 - 100 * my / req);
    const penalty = stagePenaltyOf(deficit);
    const blocked = my < req * STAGE_ENTRY_MIN_RATIO;
    const level = blocked ? 'block' : penalty >= 50 ? 'high' : penalty > 0 ? 'mid' : 'none';
    out.dataset.level = level;
    out.innerHTML =
      `<div class="spn-stat"><span>부족</span><b>${deficit > 0 ? deficit.toFixed(2) + '%' : '없음'}</b></div>`
      + `<div class="spn-stat is-main"><span>스탯 감소</span><b>${penalty ? Number(penalty.toFixed(2)) + '%' : '없음'}</b></div>`
      + `<div class="spn-stat"><span>입장 제한</span><b>${fmtCp(Math.ceil(req * STAGE_ENTRY_MIN_RATIO))} 미만</b></div>`
      + (blocked ? `<div class="spn-flag">입장 불가</div>` : '');
  }

  function setupStagePenalty() {
    const my = document.getElementById('spn-my');
    const req = document.getElementById('spn-req');
    if (!my || !req) return;
    try {
      const saved = JSON.parse(localStorage.getItem(PENALTY_KEY) || 'null');
      if (saved) {
        if (saved.my) my.value = fmtCp(saved.my);
        if (saved.mode === 'hard') penaltyMode = 'hard';
      }
    } catch (e) {}
    // 숫자만 받고 세 자리마다 쉼표. 커서는 오른쪽 끝에서 같은 자리를 지킨다.
    [my, req].forEach(inp => inp.addEventListener('input', () => {
      const fromEnd = inp.value.length - (inp.selectionEnd ?? inp.value.length);
      inp.value = fmtCp(parseCp(inp.value));
      const pos = Math.max(0, inp.value.length - fromEnd);
      try { inp.setSelectionRange(pos, pos); } catch (e) {}
      renderPenalty();
    }));
    document.querySelectorAll('#spn-mode .mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === penaltyMode);
      btn.addEventListener('click', () => {
        penaltyMode = btn.dataset.mode;
        document.querySelectorAll('#spn-mode .mode-btn').forEach(b => b.classList.toggle('active', b === btn));
        fillPenaltyChapters();
        applyPenaltyStage();
      });
    });
    document.getElementById('spn-chapter').addEventListener('change', () => { fillPenaltyStages(); applyPenaltyStage(); });
    document.getElementById('spn-stage').addEventListener('change', applyPenaltyStage);
    renderPenalty();
  }

  // 챕터 이름표: 작은 CHAPTER · 큰 번호 · 금색 줄 · 이름 (2026-10-26, 사선 띠 대신 그림 아래쪽 번짐 위에)
  function chapterLabelHtml(ch, chapName) {
    const no = String(ch).padStart(2, '0');
    return `<div class="chapter-label is-l1"><span class="cl-ch">CHAPTER</span><span class="cl-no">${no}</span>`
      + `<span class="cl-name">${chapName || ''}</span></div>`;
  }

  // 스테이지 정보가 있는 가장 최근 챕터(맨 위에 크게 둔다)
  function latestOpenChapter(chapters) {
    const open = chapters.filter(ch => String(ch) !== '0' && hasStageData(ch));
    return open.length ? open[open.length - 1] : null;
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
            ${chapterLabelHtml(ch, chapName)}
          </div>
        </div>
      `;
    };

    // 맨 위: 프롤로그(챕터 0)와 가장 최근 챕터를 크게 나란히. 아래 그리드에는 챕터 0 만 빼고 전부(최근 챕터도 같이 - 사용자 요청, 2026-10-26)
    const latest = latestOpenChapter(chapters);
    const zeroChapters = chapters.filter(ch => String(ch) === '0');
    const restChapters = chapters.filter(ch => String(ch) !== '0');
    const feature = (ch, en, ko) => `
      <div class="chapter-feature">
        <div class="chapter-feature-cap"><b>${en}</b><span>${ko}</span></div>
        ${makeCard(ch)}
      </div>`;

    // 맨 뒤에 예고 카드 한 장. 다음 챕터 자리를 비워 두는 표시라 누르지는 않는다.
    const comingSoon = `
      <div class="chapter-card is-locked is-soon">
        <div class="chapter-img">
          <div class="chapter-label">COMING SOON</div>
        </div>
      </div>
    `;

    document.getElementById('chapter-grid-zero').innerHTML =
      zeroChapters.map(ch => feature(ch, 'PROLOGUE', '이야기의 시작')).join('')
      + (latest !== null ? feature(latest, 'LATEST', '가장 최근 챕터') : '');
    document.getElementById('chapter-grid').innerHTML = restChapters.map(makeCard).join('') + comingSoon;
  }

  function selectChapter(chapter, direction = null) {
    currentChapter = chapter;

    // 챕터 그리드 숨기고 상세 표시
    const grid = document.getElementById('chapter-grid');
    const gridZero = document.getElementById('chapter-grid-zero');
    const detail = document.getElementById('stage-detail');
    grid.classList.add('hidden');
    gridZero.classList.add('hidden');
    document.getElementById('stage-penalty').classList.add('hidden');
    detail.classList.remove('hidden');
    detail.classList.add('fade-in');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const chapImg = allChapImgData.find(c => String(c['챕터']) === String(chapter));
    document.getElementById('stage-chapter-title').innerHTML =
      `<b class="sct-no">${String(chapter).padStart(2, '0')}</b>`
      + `<span class="sct-text"><span class="sct-en">CHAPTER</span><span class="sct-name">${(chapImg && chapImg['명칭']) || ''}</span></span>`;
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
        ${chapterLabelHtml(ch, chapName)}
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
    const meta = document.getElementById('stage-chapter-meta');
    if (meta) {
      const ex = data.filter(s => String(s['스테이지'] ?? '').includes('EX')).length;
      meta.innerHTML = `<em>스테이지 <b>${data.length - ex}</b></em>` + (ex ? `<em class="is-ex">EX <b>${ex}</b></em>` : '');
    }

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
              // 약점 코드가 둘인 스테이지가 있다(22·23·25챕터 EX). 쉼표로 나눠 적으면
              // 아이콘을 나란히 놓는다 — 전에는 둘을 합쳐 그린 그림을 따로 넣었다.
              const val = String(code ?? '').trim();
              if (!val) return '-';
              const table = stageIconImgData['우월코드'] || {};
              const parts = val.split(',').map(v => v.trim()).filter(Boolean);
              if (!parts.length) return '-';
              return parts.map(one => table[one]
                ? `<img src="${table[one]}" alt="${one}" class="stage-code-icon" title="${one}">`
                : one).join('');
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

    // 폰에서는 표를 카드처럼 펼쳐 두어(CSS) 떠 있는 단추가 계속 카드 글자를 가렸다(사용자 지적, 2026-10-11).
    // 단추를 띄우지 않고 카드들 위에 안내 줄로 붙박아 둔다.
    if (window.matchMedia('(max-width: 640px)').matches) {
      const tableWrap = document.getElementById('stage-table-wrap');
      const bar = document.createElement('div');
      bar.id = 'stage-spoiler-overlay';
      bar.className = 'stage-spoiler-bar';
      bar.innerHTML = '<span>보스 · 유형은 스포일러라 가려 두었어요</span>'
        + '<button type="button" class="spoiler-reveal-btn">스포일러 해제</button>';
      bar.querySelector('button').addEventListener('click', () => {
        revealedChapters.add(key);
        applyStageBlur();
      });
      tableWrap.parentNode.insertBefore(bar, tableWrap);
      return;
    }

    // 보스 열(3번째 th) 위치 기준으로 버튼 배치
    const bossHeader = document.querySelector('#stage-table th:nth-child(3)');
    if (!bossHeader) return;

    const tableWrap = document.getElementById('stage-table-wrap');
    tableWrap.style.position = 'relative';

    const thRect = bossHeader.getBoundingClientRect();
    const wrapRect = tableWrap.getBoundingClientRect();
    let leftOffset = thRect.left - wrapRect.left + tableWrap.scrollLeft + thRect.width / 2;
    // 폰처럼 표가 칸보다 넓어 옆으로 밀리는 화면에서는 보스 열 가운데가 칸 밖(오른쪽)이라 단추가
    // 안 보였다(사용자 지적, 2026-10-09). 그때는 보이는 폭 가운데에 두고 옆으로 밀어도 따라오게 한다.
    const overflowing = tableWrap.scrollWidth > tableWrap.clientWidth + 1;
    // 폰에서는 표 머리줄이 숨어(줄을 카드처럼 편다) 보스 열 위치를 못 잰다 - 그때도 가운데에 둔다
    if (overflowing || !thRect.width) leftOffset = tableWrap.scrollLeft + tableWrap.clientWidth / 2;

    const overlay = document.createElement('button');
    overlay.id = 'stage-spoiler-overlay';
    overlay.className = 'spoiler-reveal-btn';
    overlay.style.position = 'absolute';
    overlay.style.top = '50%';
    overlay.style.left = leftOffset + 'px';
    // 가운데 맞춤(-50%, -50%)은 .spoiler-reveal-btn 의 translate 속성이 한다.
    // 여기서 transform 으로 또 옮기면 두 번 밀려 왼쪽 위로 치우친다.
    overlay.style.zIndex = '10';
    overlay.textContent = '스포일러 해제';
    overlay.addEventListener('click', () => {
      revealedChapters.add(key);
      applyStageBlur();
    });

    tableWrap.appendChild(overlay);

    if (overflowing) {
      const followX = () => {
        if (!overlay.isConnected) { tableWrap.removeEventListener('scroll', followX); return; }
        overlay.style.left = (tableWrap.scrollLeft + tableWrap.clientWidth / 2) + 'px';
      };
      tableWrap.addEventListener('scroll', followX, { passive: true });
    }

    // 표가 길면 단추가 한가운데에 박혀 있어서, 아래쪽을 보고 있을 때는 화면 밖에
    // 있다. 스크롤을 따라 화면 세로 한가운데에 머물게 한다.
    //
    // 다만 표 전체가 아니라 "실제로 가려진 칸이 있는 구간" 안에서만 움직인다.
    // 앞쪽 스테이지는 안 가려져 있는데 거기까지 단추가 따라오면, 가릴 것도 없는
    // 자리에 해제 단추가 떠 있는 꼴이 된다.
    //
    // 구간은 표 기준 좌표라 스크롤해도 안 변한다. 한 번만 재고 창 크기가 바뀔
    // 때만 다시 잰다.
    let blurTop = 0, blurBottom = 0;
    const measureBlurRange = () => {
      const cells = tableWrap.querySelectorAll('.blurable-cell.spoiler-blur');
      const wr = tableWrap.getBoundingClientRect();
      if (!cells.length) { blurTop = 0; blurBottom = wr.height; return; }
      let lo = Infinity, hi = -Infinity;
      cells.forEach(c => {
        const r = c.getBoundingClientRect();
        lo = Math.min(lo, r.top - wr.top);
        hi = Math.max(hi, r.bottom - wr.top);
      });
      blurTop = lo;
      blurBottom = hi;
    };

    const followScroll = () => {
      if (!overlay.isConnected) {
        window.removeEventListener('scroll', followScroll);
        window.removeEventListener('resize', onResize);
        return;
      }
      const r = tableWrap.getBoundingClientRect();
      // 단추가 구간 밖으로 삐져나오지 않게 제 높이의 절반만큼 여유를 둔다
      const half = overlay.offsetHeight / 2 + 8;
      let top = window.innerHeight / 2 - r.top;
      const lo = blurTop + half;
      const hi = blurBottom - half;
      top = (hi < lo) ? (blurTop + blurBottom) / 2 : Math.max(lo, Math.min(hi, top));
      overlay.style.top = top + 'px';
    };

    const onResize = () => { measureBlurRange(); followScroll(); };
    measureBlurRange();
    followScroll();
    window.addEventListener('scroll', followScroll, { passive: true });
    window.addEventListener('resize', onResize);
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
      document.getElementById('stage-penalty').classList.remove('hidden');
      grid.classList.add('fade-in');
      gridZero.classList.add('fade-in');
      currentChapter = null;
    });

    // 노말/하드 전환 (패널티 계산 구역에도 같은 모양 단추가 있어서 상세 머리 줄 것만)
    document.querySelectorAll('#stage-mode-btns .mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#stage-mode-btns .mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = btn.dataset.mode;
        applyModeTheme();
        renderStageTable();
      });
    });

    setupStagePenalty();
    loadStageData();
  });
