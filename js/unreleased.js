  const SURVEY_STORAGE_KEY = 'nikke_unreleased_survey';
  const AFFILIATION_ORDER = ['엘리시온', '미실리스', '테트라', '필그림', '소속 불명', '중앙 정부', '중국 서버'];

  // 픽업 기록의 "시즌" 값 중 화면에 먼저 보여주고 싶은 순서(픽업 탭 필터와 동일한 감각).
  // 여기 없는 시즌값(향후 새로 추가되는 것)은 이 목록 뒤에 알파벳/가나다 순으로 붙는다.
  const SEASON_ORDER_HINT = ['일반', '메이드', '바니걸', '여름', '크리스마스', '신년', '콜라보'];

  let surveyState = {
    main: new Set(),
    side: new Set(),
    dynamic: {}, // 시즌값(또는 '주년'/'만우절') 별로 동적으로 생기는 Set
  };

  let surveyItems = {
    main: [],
    side: [],
    dynamic: {}, // 시즌값(또는 '주년'/'만우절') 별로 동적으로 생기는 [{label}, ...]
  };

  let pickupEventSeasonMap = {};

  // ===== 설문 =====

  function loadUnreleasedData() {
    onAppDataReady(() => {
      buildPickupEventSeasonMap();
      classifySurveyItems();
      loadSurveyStorage();
      renderSurvey();
      initSurveyEvents();
    });
  }

  function buildPickupEventSeasonMap() {
    const pickupData = APP_DATA.pickup || [];
    pickupData.forEach(p => {
      if (p['이벤트'] && !pickupEventSeasonMap[p['이벤트']]) {
        pickupEventSeasonMap[p['이벤트']] = p['시즌'];
      }
    });
  }

  // 시즌값을 설문 카테고리 키로 정규화 — "1주년"/"2주년"/"2.5주년" 등은 전부 "주년" 하나로 묶는다.
  function surveyCategoryKey(season) {
    if (String(season).includes('주년')) return '주년';
    return String(season);
  }

  function surveyCategoryLabel(key) {
    if (key === '만우절') return '만우절';
    return `${key} 이벤트`;
  }

  function classifySurveyItems() {
    const unreleasedData = APP_DATA.unreleased || [];
    const pickupData     = APP_DATA.pickup     || [];

    const pickupOrderMap = {};
    pickupData.forEach(p => {
      if (p['이벤트'] && !(p['이벤트'] in pickupOrderMap)) {
        pickupOrderMap[p['이벤트']] = Object.keys(pickupOrderMap).length;
      }
    });

    const appearKeys = Object.keys(unreleasedData[0] || {})
      .filter(k => /^등장\d+$/.test(k))
      .sort((a, b) => parseInt(a.replace('등장','')) - parseInt(b.replace('등장','')));

    const seen = new Set();
    const appearValues = [];
    unreleasedData.forEach(row => {
      appearKeys.forEach(key => {
        const val = String(row[key] || '').trim();
        if (val && !seen.has(val)) {
          seen.add(val);
          appearValues.push(val);
        }
      });
    });

    const mainSet = new Set();
    const dynamicLists = {};
    const sideList = [];

    appearValues.forEach(val => {
      if (!val) return;
      if (val.includes('챕터')) { mainSet.add(val); return; }

      // 픽업 기록에 있는 이벤트면 그 시즌값(일반/콜라보/여름/크리스마스/신년/주년 등)을
      // 전부 그대로 카테고리로 만든다 — 특정 시즌만 하드코딩해서 걸러내지 않는다.
      const season = pickupEventSeasonMap[val];
      if (season !== undefined) {
        const key = surveyCategoryKey(season);
        (dynamicLists[key] ??= []).push(val);
        return;
      }

      // 픽업 기록엔 없지만 만우절 이벤트인 경우 별도 카테고리로 표기
      if (val.includes('만우절')) {
        (dynamicLists['만우절'] ??= []).push(val);
        return;
      }

      sideList.push(val);
    });

    surveyItems.main = [...mainSet]
      .map(label => ({ label, num: parseInt(label) }))
      .sort((a, b) => a.num - b.num);

    surveyItems.dynamic = {};
    Object.entries(dynamicLists).forEach(([key, list]) => {
      surveyItems.dynamic[key] = list
        .sort((a, b) => (pickupOrderMap[a] ?? 9999) - (pickupOrderMap[b] ?? 9999))
        .map(label => ({ label }));
      if (!surveyState.dynamic[key]) surveyState.dynamic[key] = new Set();
    });

    surveyItems.side = sideList.map(label => ({ label }));
  }

  // 동적 카테고리들을 화면에 보여줄 순서: SEASON_ORDER_HINT에 있는 건 그 순서대로,
  // 없는 건(향후 새로 생기는 시즌값) 가나다순으로 그 뒤에, 주년/만우절은 맨 뒤에.
  function orderedDynamicKeys() {
    const keys = Object.keys(surveyItems.dynamic).filter(k => surveyItems.dynamic[k].length > 0);
    const known = SEASON_ORDER_HINT.filter(k => keys.includes(k));
    const rest = keys
      .filter(k => !SEASON_ORDER_HINT.includes(k) && k !== '주년' && k !== '만우절')
      .sort((a, b) => a.localeCompare(b, 'ko'));
    const tail = ['주년', '만우절'].filter(k => keys.includes(k));
    return [...known, ...rest, ...tail];
  }

  function renderSurvey() {
    renderChapterBar();
    renderDynamicSurveySections();
  }

  function renderDynamicSurveySections() {
    const container = document.getElementById('survey-right');
    container.innerHTML = '';

    orderedDynamicKeys().forEach(key => {
      container.appendChild(buildSurveySectionEl(surveyCategoryLabel(key), surveyItems.dynamic[key], surveyState.dynamic[key]));
    });

    if (surveyItems.side.length > 0) {
      container.appendChild(buildSurveySectionEl('사이드 스토리', surveyItems.side, surveyState.side));
    }
  }

  function buildSurveySectionEl(label, items, stateSet) {
    const section = document.createElement('div');
    section.className = 'survey-section';
    section.innerHTML = `
      <div class="survey-section-header">
        <span class="survey-section-title">${label}</span>
        <div class="survey-section-btns">
          <button class="survey-all-btn" data-action="all">전체선택</button>
          <button class="survey-all-btn" data-action="none">전체취소</button>
        </div>
      </div>
      <div class="survey-chips"></div>
    `;

    const chipsWrap = section.querySelector('.survey-chips');
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'survey-chip' + (stateSet.has(item.label) ? ' active' : '');
      btn.dataset.value = item.label;
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        if (stateSet.has(item.label)) stateSet.delete(item.label);
        else stateSet.add(item.label);
        btn.classList.toggle('active', stateSet.has(item.label));
        saveSurveyStorage();
      });
      chipsWrap.appendChild(btn);
    });

    section.querySelectorAll('.survey-all-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'all') items.forEach(i => stateSet.add(i.label));
        else stateSet.clear();
        chipsWrap.querySelectorAll('.survey-chip').forEach(chip => {
          chip.classList.toggle('active', stateSet.has(chip.dataset.value));
        });
        saveSurveyStorage();
      });
    });

    return section;
  }

  function renderChapterBar() {
    const bar = document.getElementById('survey-chapter-bar');
    const items = [...surveyItems.main].reverse();
    bar.innerHTML = '';
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'chapter-bar-item';
      div.dataset.value = item.label;
      div.innerHTML = `<div class="chapter-bar-fill"><span class="chapter-bar-label">CHAPTER ${item.num}</span></div>`;
      div.addEventListener('click', () => onChapterBarClick(item));
      bar.appendChild(div);
    });
    syncChapterBar();
  }

  function syncChapterBar() {
    const bar = document.getElementById('survey-chapter-bar');
    if (!bar) return;
    const selectedNums = surveyItems.main
      .filter(i => surveyState.main.has(i.label))
      .map(i => i.num);
    const maxSelected = selectedNums.length > 0 ? Math.max(...selectedNums) : -1;
    bar.querySelectorAll('.chapter-bar-item').forEach(el => {
      const num = parseInt(el.dataset.value);
      el.classList.remove('active', 'active-top');
      if (num < maxSelected)        el.classList.add('active');
      else if (num === maxSelected) el.classList.add('active-top');
    });
  }

  function onChapterBarClick(item) {
    const isChecked = surveyState.main.has(item.label);
    if (!isChecked) {
      surveyItems.main.forEach(i => { if (i.num <= item.num) surveyState.main.add(i.label); });
    } else {
      surveyItems.main.forEach(i => { if (i.num >= item.num) surveyState.main.delete(i.label); });
    }
    syncChapterBar();
    saveSurveyStorage();
  }

  function initSurveyEvents() {
    // 메인 스토리(챕터) 섹션만 정적 HTML이라 여기서 따로 바인딩한다 — 나머지 동적 섹션들은
    // buildSurveySectionEl에서 생성 시점에 각자 바인딩됨
    document.querySelectorAll('#survey-section-main .survey-all-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'all') surveyItems.main.forEach(i => surveyState.main.add(i.label));
        else surveyState.main.clear();
        syncChapterBar();
        saveSurveyStorage();
      });
    });

    document.getElementById('survey-global-all').addEventListener('click', () => {
      surveyItems.main.forEach(i => surveyState.main.add(i.label));
      Object.entries(surveyItems.dynamic).forEach(([key, items]) => {
        items.forEach(i => surveyState.dynamic[key].add(i.label));
      });
      surveyItems.side.forEach(i => surveyState.side.add(i.label));
      syncChapterBar();
      renderDynamicSurveySections();
      saveSurveyStorage();
    });

    document.getElementById('survey-global-none').addEventListener('click', () => {
      surveyState.main.clear();
      Object.values(surveyState.dynamic).forEach(set => set.clear());
      surveyState.side.clear();
      syncChapterBar();
      renderDynamicSurveySections();
      saveSurveyStorage();
    });

    document.getElementById('survey-confirm-btn').addEventListener('click', () => {
      document.getElementById('unreleased-survey').classList.add('hidden');
      document.getElementById('unreleased-main').classList.remove('hidden');
      renderUnreleasedMain();
    });

    document.getElementById('unreleased-survey-btn').addEventListener('click', () => {
      document.getElementById('unreleased-main').classList.add('hidden');
      document.getElementById('unreleased-survey').classList.remove('hidden');
    });
  }

  // ===== 표시 가능 여부 판별 =====

  function isVisible(val) {
    if (!val) return false;
    val = String(val).trim();
    if (!val) return false;
    if (val.includes('챕터')) return surveyState.main.has(val);

    const season = pickupEventSeasonMap[val];
    if (season !== undefined) {
      const key = surveyCategoryKey(season);
      return surveyState.dynamic[key] ? surveyState.dynamic[key].has(val) : false;
    }

    // 만우절(픽업 기록에 없는 경우) — 별도 카테고리로 설문 대상에 포함
    if (val.includes('만우절')) {
      return surveyState.dynamic['만우절'] ? surveyState.dynamic['만우절'].has(val) : false;
    }

    // 사이드 스토리
    return surveyState.side.has(val);
  }

  function getVisibleVersionCount(row) {
    const appear1 = String(row['등장1'] || '').trim();
    if (!appear1) return 0; // 미등장 캐릭터

    const keys = Object.keys(row)
      .filter(k => /^등장\d+$/.test(k))
      .sort((a, b) => parseInt(a.replace('등장','')) - parseInt(b.replace('등장','')));

    let visibleVer = 0;
    for (let i = 0; i < keys.length; i++) {
      const val = String(row[keys[i]] || '').trim();
      if (!val) break;
      if (isVisible(val)) visibleVer = i + 1;
      else break;
    }
    return visibleVer;
  }

  // ===== 캐릭터 목록 렌더링 =====

  function renderUnreleasedMain() {
    const data = APP_DATA.unreleased || [];
    const container = document.getElementById('unreleased-content');

    // 상세 패널 초기화
    document.getElementById('unreleased-detail').classList.add('hidden');

    const affiliationMap = {};

    data.forEach((row, rowIdx) => {
      const affil   = String(row['소속1'] || '소속 불명').trim();
      const squad   = String(row['스쿼드1'] || '').trim();
      const appear1 = String(row['등장1'] || '').trim();
      const isUnappeared = !appear1;
      const ver = getVisibleVersionCount(row);

      if (!isUnappeared && ver < 1) return;

      if (!affiliationMap[affil]) affiliationMap[affil] = {};
      const squadKey = squad || `__solo__${row['이름1']}`;
      if (!affiliationMap[affil][squadKey]) affiliationMap[affil][squadKey] = [];
      affiliationMap[affil][squadKey].push({ row, ver, isUnappeared, rowIdx });
    });

    const affiliationOrder = [...AFFILIATION_ORDER];
    Object.keys(affiliationMap).forEach(a => {
      if (!affiliationOrder.includes(a)) affiliationOrder.push(a);
    });

    container.innerHTML = affiliationOrder
      .filter(affil => affiliationMap[affil])
      .map(affil => {
        const squadMap = affiliationMap[affil];
        const isChinaServer = affil === '중국 서버';

        const squadsHtml = Object.entries(squadMap).map(([squadKey, members]) => {
          const isSolo    = squadKey.startsWith('__solo__');
          const squadName = isSolo ? '' : squadKey;

          members.sort((a, b) => {
            const aVal = String(a.row['등장1'] || '').trim();
            const bVal = String(b.row['등장1'] || '').trim();
            if (!aVal && !bVal) return 0;
            if (!aVal) return 1;
            if (!bVal) return -1;
            return 0;
          });

          const membersHtml = members.map(({ row, ver, isUnappeared, rowIdx }) => {
            const dispSuffix = (ver >= 2) ? String(ver) : '1';
            const name   = String(row[`이름${dispSuffix}`] || row['이름1'] || '').trim();
            const status = String(row[`상태${dispSuffix}`] || '').trim();
            const appear = String(row[`등장${dispSuffix}`] || '').trim();
            const imgUrl = String(row[`이미지${dispSuffix}`] || row['이미지1'] || '').trim();

            const nameStrike = status === '이름빗금' || status === '전체빗금';

            return `
              <div class="unreleased-card" data-row-idx="${rowIdx}" onclick="selectUnreleasedCard(${rowIdx})">
                ${imgUrl ? `<div class="unreleased-card-portrait"><img src="${imgUrl}" alt="${name}"></div>` : ''}
                <div class="unreleased-card-info">
                  <div class="unreleased-card-name ${nameStrike ? 'strikethrough' : ''}">${name || '???'}</div>
                  ${isUnappeared ? `<span class="unreleased-card-badge unappeared">미등장</span>` : ''}
                  ${appear ? `<div class="unreleased-card-appear">${appear}</div>` : ''}
                </div>
              </div>
            `;
          }).join('');

          return `
            <div class="unreleased-squad-group">
              ${squadName ? `<div class="unreleased-squad-title">${squadName}</div>` : ''}
              <div class="unreleased-squad-members">${membersHtml}</div>
            </div>
          `;
        }).join('');

        return `
          <div class="unreleased-affil-group ${isChinaServer ? 'china-server' : ''}">
            <div class="unreleased-affil-title">${affil}</div>
            <div class="unreleased-affil-body">${squadsHtml}</div>
          </div>
        `;
      }).join('');
  }

  // ===== 상세 패널 =====

  let currentSpineList = [];
  let currentSpineIdx  = 0;
  let unreleasedSpinePlayer = null;
  let unreleasedPanZoom = null;

  function selectUnreleasedCard(rowIdx) {
    const row = (APP_DATA.unreleased || [])[rowIdx];
    if (!row) return;

    // 이미 펼쳐진 항목을 다시 클릭하면 L2D 표시를 접는다(토글)
    const alreadyActive = document.querySelector(`.unreleased-card[data-row-idx="${rowIdx}"]`)?.classList.contains('active');
    if (alreadyActive) {
      document.querySelectorAll('.unreleased-card').forEach(el => el.classList.remove('active'));
      document.getElementById('unreleased-detail').classList.add('hidden');
      clearSpinePlayer();
      return;
    }

    // active 표시: data-row-idx 기준
    document.querySelectorAll('.unreleased-card').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.rowIdx) === rowIdx);
    });

    const appear1      = String(row['등장1'] || '').trim();
    const isUnappeared = !appear1;
    const ver          = getVisibleVersionCount(row);

    const keys = Object.keys(row)
      .filter(k => /^등장\d+$/.test(k))
      .sort((a, b) => parseInt(a.replace('등장','')) - parseInt(b.replace('등장','')));

    const versions = [];
    if (isUnappeared) {
      versions.push({
        num:    1,
        appear: '',
        name:   String(row['이름1']   || '').trim(),
        affil:  String(row['소속1']   || '').trim(),
        squad:  String(row['스쿼드1'] || '').trim(),
        status: String(row['상태1']   || '').trim(),
        skel:   String(row['skel1']   || '').trim(),
        atlas:  String(row['atlas1']  || '').trim(),
      });
    } else {
      for (let i = 0; i < keys.length; i++) {
        const n      = i + 1;
        const appear = String(row[`등장${n}`] || '').trim();
        if (!appear) break;
        if (!isVisible(appear)) break;
        versions.push({
          num:    n,
          appear: appear,
          name:   String(row[`이름${n}`]   || '').trim(),
          affil:  String(row[`소속${n}`]   || '').trim(),
          squad:  String(row[`스쿼드${n}`] || '').trim(),
          status: String(row[`상태${n}`]   || '').trim(),
          skel:   String(row[`skel${n}`]   || '').trim(),
          atlas:  String(row[`atlas${n}`]  || '').trim(),
        });
      }
    }

    // 스파인 목록 (skel/atlas 있는 버전만)
    currentSpineList = versions.filter(v => v.skel && v.atlas);
    currentSpineIdx  = currentSpineList.length > 0 ? currentSpineList.length - 1 : 0;

    renderDetailPanel(versions);

    document.getElementById('unreleased-detail').classList.remove('hidden');
    document.getElementById('unreleased-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderDetailPanel(versions) {
    // 이름
    const nameEl = document.getElementById('unreleased-detail-name');
    const nameChain = [];
    versions.forEach((v, i) => {
      if (i === 0 || v.name !== versions[i-1].name) nameChain.push(v);
    });
    nameEl.innerHTML = nameChain.map(v => {
      const strike = v.status === '이름빗금' || v.status === '전체빗금';
      return `<span class="${strike ? 'strikethrough' : ''}">${v.name || '???'}</span>`;
    }).join(' <span class="detail-arrow">→</span> ');

    // 소속
    const affilEl = document.getElementById('unreleased-detail-affil');
    const affilChain = [];
    versions.forEach((v, i) => {
      if (i === 0 || v.affil !== versions[i-1].affil) affilChain.push(v.affil);
    });
    affilEl.innerHTML = affilChain.filter(Boolean)
      .join(' <span class="detail-arrow">→</span> ');

    // 스쿼드
    const squadEl = document.getElementById('unreleased-detail-squad');
    const squadChain = [];
    versions.forEach((v, i) => {
      if (i === 0 || v.squad !== versions[i-1].squad) squadChain.push(v);
    });
    squadEl.innerHTML = squadChain.filter(v => v.squad).map(v => {
      const strike = v.status === '스쿼드빗금' || v.status === '전체빗금';
      return `<span class="${strike ? 'strikethrough' : ''}">${v.squad}</span>`;
    }).join(' <span class="detail-arrow">→</span> ');

    // 등장 시점 — 클릭으로 스파인 전환
    const appearsEl = document.getElementById('unreleased-detail-appears');
    appearsEl.innerHTML = versions.map((v, i) => {
      const hasSpine = !!(v.skel && v.atlas);
      const spineIdx = currentSpineList.findIndex(s => s.appear === v.appear && s.skel === v.skel);
      return `
        <div class="detail-appear-item ${hasSpine ? 'has-spine' : ''}"
             data-spine-idx="${spineIdx}"
             onclick="${hasSpine ? `selectSpineByAppear(${spineIdx})` : ''}">
          <span class="detail-appear-num">등장${v.num}</span>
          <span class="detail-appear-val">${v.appear || '미등장'}</span>
          ${hasSpine ? '<span class="detail-appear-spine-icon">▶</span>' : ''}
        </div>
      `;
    }).join('');

    // 스파인 로드 (최신 버전)
    if (currentSpineList.length > 0) {
      const { skel, atlas } = currentSpineList[currentSpineIdx];
      loadUnreleasedSpine(skel, atlas);
    } else {
      clearSpinePlayer();
    }

    syncAppearHighlight();
  }

  function selectSpineByAppear(spineIdx) {
    if (spineIdx < 0 || spineIdx >= currentSpineList.length) return;
    currentSpineIdx = spineIdx;
    const { skel, atlas } = currentSpineList[currentSpineIdx];
    loadUnreleasedSpine(skel, atlas);
    syncAppearHighlight();
  }

  function syncAppearHighlight() {
    const activeAppear = currentSpineList[currentSpineIdx]?.appear || '';
    const activeSkel   = currentSpineList[currentSpineIdx]?.skel   || '';
    document.querySelectorAll('.detail-appear-item').forEach(el => {
      const valEl = el.querySelector('.detail-appear-val');
      const val   = valEl ? valEl.textContent.trim() : '';
      const idx   = Number(el.dataset.spineIdx);
      el.classList.toggle('active', idx === currentSpineIdx && el.classList.contains('has-spine'));
    });
  }

  function clearSpinePlayer() {
    if (unreleasedSpinePlayer) {
      unreleasedSpinePlayer.dispose();
      unreleasedSpinePlayer = null;
    }
    if (unreleasedPanZoom) { unreleasedPanZoom.destroy(); unreleasedPanZoom = null; }
    document.getElementById('unreleased-spine-player').innerHTML = '';
    const toggle = document.getElementById('unreleased-parts-toggle');
    if (toggle) { toggle.innerHTML = ''; toggle.classList.add('hidden'); }
  }

  function loadUnreleasedSpine(skelUrl, atlasUrl) {
    const wrap = document.getElementById('unreleased-spine-player');
    wrap.innerHTML = '';
    if (unreleasedSpinePlayer) {
      unreleasedSpinePlayer.dispose();
      unreleasedSpinePlayer = null;
    }
    if (unreleasedPanZoom) { unreleasedPanZoom.destroy(); unreleasedPanZoom = null; }
    if (!skelUrl || !atlasUrl) return;

    const playerDiv = document.createElement('div');
    playerDiv.id = 'unreleased-spine-inner';
    playerDiv.style.width  = '100%';
    playerDiv.style.height = '100%';
    wrap.appendChild(playerDiv);

    unreleasedSpinePlayer = new spine.SpinePlayer('unreleased-spine-inner', {
      skelUrl:   skelUrl,
      atlasUrl:  atlasUrl,
      animation: 'idle',
      backgroundColor: '#00000000',
      showControls: false,
      success: function(player) {
        const data = player.skeleton.data;
        const vp = { x: data.x, y: data.y, width: data.width, height: data.height };
        player.dispose();
        wrap.innerHTML = '';

        const wrapEl = document.getElementById('unreleased-spine-wrap');
        const wrapW  = wrapEl.clientWidth;
        const wrapH  = wrapEl.clientHeight;

        const playerDiv2 = document.createElement('div');
        playerDiv2.id = 'unreleased-spine-inner';
        playerDiv2.style.width  = wrapW + 'px';
        playerDiv2.style.height = wrapH + 'px';
        wrap.appendChild(playerDiv2);

        unreleasedSpinePlayer = new spine.SpinePlayer('unreleased-spine-inner', {
          skelUrl:   skelUrl,
          atlasUrl:  atlasUrl,
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
            width:  vp.width,
            height: vp.height,
            padLeft:   '15%',
            padRight:  '15%',
            padTop:    '5%',
            padBottom: '5%',
          },
          success: function(player2) {
            const skeleton = player2.skeleton;
            const partSkins = skeleton.data.skins.filter(skin => skin.name !== 'default');
            const enabledParts = new Set(partSkins.map(s => s.name)); // 기본값: 전부 켜짐 (기존 동작과 동일)

            const rebuildSkin = () => {
              // 주의: skeleton.setSkinByName('default') 이후 skeleton.skin.addSkin(...)을 쓰면
              // skeletonData의 실제 'default' 스킨 객체를 그대로 참조해서 "영구적으로" 오염시킨다
              // (addSkin은 대상 스킨 자체를 mutate함). 그러면 나중에 파츠를 꺼도 이미 오염된
              // defaultSkin에서 복사해오기 때문에 꺼지지 않는 버그가 생김 — 그래서 매번 새
              // Skin 객체를 만들어 복사만 해오고, 원본 defaultSkin은 절대 mutate하지 않는다.
              const combined = new spine.Skin('combined');
              const defaultSkin = skeleton.data.findSkin('default');
              if (defaultSkin) combined.addSkin(defaultSkin);
              partSkins.forEach(skin => {
                if (enabledParts.has(skin.name)) combined.addSkin(skin);
              });
              skeleton.setSkin(combined);
              skeleton.setToSetupPose();
              // 스킨을 새로 짠 뒤 setToSetupPose만으로는 일부 슬롯이 "설정 자세"가 아니라
              // 현재 재생 중인 애니메이션 프레임이 지정한 attachment를 그대로 들고 있어서 안 바뀔 수
              // 있음 — 현재 애니메이션 프레임을 새 스킨 기준으로 즉시 다시 적용해서 확실히 반영
              if (player2.animationState) player2.animationState.apply(skeleton);
              skeleton.updateWorldTransform();
            };
            rebuildSkin();
            renderPartsToggle('unreleased-parts-toggle', partSkins, enabledParts, rebuildSkin);

            unreleasedPanZoom = setupSpinePanZoom(playerDiv2, wrapEl);

            const resetBtn = document.getElementById('unreleased-spine-reset');
            if (resetBtn) {
              resetBtn.onmousedown = e => e.stopPropagation();
              resetBtn.onclick = e => {
                e.stopPropagation();
                unreleasedPanZoom.reset();
                try {
                  player2.animationState.clearListeners();
                  player2.setAnimation('idle', true);
                } catch (err) {
                  console.error('[미실장 L2D] 초기화 실패:', err);
                }
              };
            }

            player2.animationState.data.defaultMix = 0;
            player2.canvas.addEventListener('click', () => {
              try {
                player2.setAnimation('action', false);
                player2.animationState.addListener({
                  complete: () => {
                    try {
                      player2.setAnimation('idle', true);
                    } catch (err) {
                      console.error('[미실장 L2D] idle 애니메이션 복귀 실패:', err);
                    }
                    player2.animationState.clearListeners();
                  }
                });
              } catch (err) {
                console.error('[미실장 L2D] action 애니메이션 재생 실패:', err);
              }
            });
          }
        });
      }
    });
  }

  // ===== localStorage =====

  function saveSurveyStorage() {
    const dynamicData = {};
    Object.entries(surveyState.dynamic).forEach(([key, set]) => {
      dynamicData[key] = [...set];
    });
    const data = {
      main: [...surveyState.main],
      side: [...surveyState.side],
      dynamic: dynamicData,
    };
    try { localStorage.setItem(SURVEY_STORAGE_KEY, JSON.stringify(data)); } catch(e) {}
  }

  function loadSurveyStorage() {
    try {
      const raw = localStorage.getItem(SURVEY_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);

      const validMain = new Set(surveyItems.main.map(i => i.label));
      (data.main || []).forEach(v => { if (validMain.has(v)) surveyState.main.add(v); });

      const validSide = new Set(surveyItems.side.map(i => i.label));
      (data.side || []).forEach(v => { if (validSide.has(v)) surveyState.side.add(v); });

      // 예전 버전(anniv/newyear 고정 키) 저장값과의 호환은 신경쓰지 않는다 — 유효하지 않은
      // 라벨은 아래에서 자연히 걸러진다.
      Object.entries(data.dynamic || {}).forEach(([key, values]) => {
        const items = surveyItems.dynamic[key];
        if (!items) return; // 지금 데이터엔 더 이상 없는 카테고리
        const validSet = new Set(items.map(i => i.label));
        if (!surveyState.dynamic[key]) surveyState.dynamic[key] = new Set();
        values.forEach(v => { if (validSet.has(v)) surveyState.dynamic[key].add(v); });
      });
    } catch(e) {}
  }

  document.addEventListener('DOMContentLoaded', loadUnreleasedData);
