  const SURVEY_STORAGE_KEY = 'nikke_unreleased_survey';
  const AFFILIATION_ORDER = ['엘리시온', '미실리스', '테트라', '필그림', '소속 불명', '중앙 정부', '중국 서버'];

  let surveyState = {
    main:    new Set(),
    anniv:   new Set(),
    newyear: new Set(),
    side:    new Set(),
  };

  let surveyItems = {
    main:    [],
    anniv:   [],
    newyear: [],
    side:    [],
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

  function classifySurveyItems() {
    const unreleasedData = APP_DATA.unreleased || [];
    const pickupData     = APP_DATA.pickup     || [];

    const pickupEventOrder = [];
    const pickupOrderMap   = {};
    pickupData.forEach(p => {
      if (p['이벤트'] && !pickupOrderMap[p['이벤트']]) {
        pickupOrderMap[p['이벤트']] = pickupEventOrder.length;
        pickupEventOrder.push(p['이벤트']);
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

    const mainSet     = new Set();
    const annivList   = [];
    const newyearList = [];
    const sideList    = [];

    appearValues.forEach(val => {
      if (!val || val.includes('만우절')) return;
      if (val.includes('챕터')) { mainSet.add(val); return; }

      const season = pickupEventSeasonMap[val];
      if (season !== undefined) {
        if (String(season).includes('주년')) { annivList.push(val); return; }
        if (String(season).includes('신년')) { newyearList.push(val); return; }
        return;
      }
      sideList.push(val);
    });

    surveyItems.main = [...mainSet]
      .map(label => ({ label, num: parseInt(label) }))
      .sort((a, b) => a.num - b.num);

    const pickupOrderMapFinal = {};
    pickupEventOrder.forEach((name, idx) => { pickupOrderMapFinal[name] = idx; });

    surveyItems.anniv   = annivList
      .sort((a, b) => (pickupOrderMapFinal[a] ?? 9999) - (pickupOrderMapFinal[b] ?? 9999))
      .map(label => ({ label }));
    surveyItems.newyear = newyearList
      .sort((a, b) => (pickupOrderMapFinal[a] ?? 9999) - (pickupOrderMapFinal[b] ?? 9999))
      .map(label => ({ label }));
    surveyItems.side = sideList.map(label => ({ label }));
  }

  function renderSurvey() {
    renderChapterBar();
    ['anniv', 'newyear', 'side'].forEach(sec => {
      const container = document.getElementById(`survey-chips-${sec}`);
      container.innerHTML = '';
      surveyItems[sec].forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'survey-chip' + (surveyState[sec].has(item.label) ? ' active' : '');
        btn.dataset.section = sec;
        btn.dataset.value   = item.label;
        btn.textContent     = item.label;
        btn.addEventListener('click', onSurveyChipClick);
        container.appendChild(btn);
      });
      const section = document.getElementById(`survey-section-${sec}`);
      if (surveyItems[sec].length === 0) section.classList.add('hidden');
    });
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

  function onSurveyChipClick(e) {
    const btn = e.currentTarget;
    const sec = btn.dataset.section;
    const val = btn.dataset.value;
    if (surveyState[sec].has(val)) surveyState[sec].delete(val);
    else surveyState[sec].add(val);
    syncSurveyChips(sec);
    saveSurveyStorage();
  }

  function syncSurveyChips(sec) {
    document.querySelectorAll(`#survey-chips-${sec} .survey-chip`).forEach(btn => {
      btn.classList.toggle('active', surveyState[sec].has(btn.dataset.value));
    });
  }

  function initSurveyEvents() {
    document.querySelectorAll('.survey-all-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const sec    = btn.dataset.section;
        const action = btn.dataset.action;
        if (sec === 'main') {
          if (action === 'all') surveyItems.main.forEach(i => surveyState.main.add(i.label));
          else surveyState.main.clear();
          syncChapterBar();
        } else {
          if (action === 'all') surveyItems[sec].forEach(i => surveyState[sec].add(i.label));
          else surveyState[sec].clear();
          syncSurveyChips(sec);
        }
        saveSurveyStorage();
      });
    });

    document.getElementById('survey-global-all').addEventListener('click', () => {
      surveyItems.main.forEach(i => surveyState.main.add(i.label));
      ['anniv', 'newyear', 'side'].forEach(sec => {
        surveyItems[sec].forEach(i => surveyState[sec].add(i.label));
        syncSurveyChips(sec);
      });
      syncChapterBar();
      saveSurveyStorage();
    });

    document.getElementById('survey-global-none').addEventListener('click', () => {
      surveyState.main.clear();
      ['anniv', 'newyear', 'side'].forEach(sec => {
        surveyState[sec].clear();
        syncSurveyChips(sec);
      });
      syncChapterBar();
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
    // 만우절은 항상 표시
    if (val.includes('만우절')) return true;
    if (val.includes('챕터')) return surveyState.main.has(val);
    const season = pickupEventSeasonMap[val];
    if (season !== undefined) {
      if (String(season).includes('주년')) return surveyState.anniv.has(val);
      if (String(season).includes('신년')) return surveyState.newyear.has(val);
      // 픽업기록에 있지만 주년/신년 아님 → 설문 대상 아님, 항상 표시
      return true;
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

            const nameStrike = status === '이름빗금' || status === '전체빗금';

            return `
              <div class="unreleased-card" data-row-idx="${rowIdx}" onclick="selectUnreleasedCard(${rowIdx})">
                <div class="unreleased-card-name ${nameStrike ? 'strikethrough' : ''}">${name || '???'}</div>
                ${isUnappeared ? `<span class="unreleased-card-badge unappeared">미등장</span>` : ''}
                ${appear ? `<div class="unreleased-card-appear">${appear}</div>` : ''}
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
              const combined = new spine.Skin('combined');
              const defaultSkin = skeleton.data.findSkin('default');
              if (defaultSkin) combined.addSkin(defaultSkin);
              partSkins.forEach(skin => {
                if (enabledParts.has(skin.name)) combined.addSkin(skin);
              });
              skeleton.setSkin(combined);
              skeleton.setToSetupPose();
              skeleton.updateWorldTransform();
            };
            rebuildSkin();
            renderPartsToggle('unreleased-parts-toggle', partSkins, enabledParts, rebuildSkin);

            unreleasedPanZoom = setupSpinePanZoom(player2, player2.canvas);

            player2.animationState.data.defaultMix = 0;
            player2.canvas.addEventListener('click', () => {
              try {
                player2.setAnimation('action', false);
                if (unreleasedPanZoom) unreleasedPanZoom();
                player2.animationState.addListener({
                  complete: () => {
                    try {
                      player2.setAnimation('idle', true);
                      if (unreleasedPanZoom) unreleasedPanZoom();
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
    const data = {
      main:    [...surveyState.main],
      anniv:   [...surveyState.anniv],
      newyear: [...surveyState.newyear],
      side:    [...surveyState.side],
    };
    try { localStorage.setItem(SURVEY_STORAGE_KEY, JSON.stringify(data)); } catch(e) {}
  }

  function loadSurveyStorage() {
    try {
      const raw = localStorage.getItem(SURVEY_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      ['main', 'anniv', 'newyear', 'side'].forEach(sec => {
        const validLabels = new Set(surveyItems[sec].map(i => i.label));
        (data[sec] || []).forEach(v => {
          if (validLabels.has(v)) surveyState[sec].add(v);
        });
      });
    } catch(e) {}
  }

  document.addEventListener('DOMContentLoaded', loadUnreleasedData);
