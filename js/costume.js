  let allCostumeData = [];
  let allNikkeImgData = [];
  let currentCostume = null;
  let spinePlayer = null;
  let activeSpinePlayers = []; // 기본 스켈레톤 + 추가 파츠 스켈레톤 전부 (정리용)
  let costumePanZoom = null;
  let showRerunCostume = true;

  function loadCostumeData() {
    onAppDataReady(() => {
      allNikkeImgData = APP_DATA.nikkeImg || [];
      initCostume(APP_DATA.costume);
    });
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
                <div class="costume-portrait-date">${dateLabel}</div>
                <div class="costume-portrait-img">
                  ${costumeImgUrl ? `<img src="${costumeImgUrl}" alt="${c['니케']}">` : c['니케']}
                </div>
                <div class="costume-portrait-name">${c['니케']}</div>
                ${c._isRerun && !isActive ? `<div class="costume-rerun-badge">복각</div>` : ''}
                ${isActive ? `<div class="costume-active-badge">${c._isRerun ? '복각 중' : '픽업 중'}</div>` : ''}
                ${formatRemainingDays(startDate, endDate, 'is-on-portrait')}
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

  // 메인 페이지의 "진행중인 코스튬 픽업" 카드 클릭 시 유니크 코스튬 탭의 해당 코스튬 위치로 이동.
  function jumpToCostume(nikkeName, costumeName, isRerun) {
    switchTab('costume');

    const costume = allCostumeData.find(c => c['니케'] === nikkeName && c['코스튬명'] === costumeName);
    if (!costume) return;

    // 복각 항목은 "복각 표시" 토글이 꺼져 있으면 선택기에 렌더링되지 않으므로 켜준다
    if (isRerun && !showRerunCostume) {
      showRerunCostume = true;
      const toggle = document.getElementById('costume-rerun-toggle');
      if (toggle) toggle.classList.add('active');
      renderCostumeSelector(allCostumeData);
    }

    selectCostume(costume, isRerun, false);

    const active = document.querySelector('.costume-portrait-item.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }

  // allowToggleClose: 초상화를 직접 클릭했을 때만 "이미 펼쳐진 걸 다시 클릭하면 접기"가
  // 동작해야 한다. 메인 페이지에서 점프해 들어올 때(jumpToCostume)는 이미 펼쳐져 있어도
  // 그대로 보여줘야 하므로 false로 호출한다.
  function selectCostume(costume, isRerun = false, allowToggleClose = true) {
    const idx = allCostumeData.indexOf(costume);
    const alreadyActive = [...document.querySelectorAll('.costume-portrait-item.active')].some(el =>
      Number(el.dataset.idx) === idx && el.dataset.isRerun === String(isRerun)
    );

    // 이미 펼쳐진 항목을 다시 클릭하면 L2D 표시를 접는다(토글)
    if (allowToggleClose && alreadyActive) {
      document.querySelectorAll('.costume-portrait-item').forEach(el => el.classList.remove('active'));
      document.getElementById('costume-top').classList.add('hidden');
      currentCostume = null;
      clearCostumeSpinePlayer();
      return;
    }

    currentCostume = costume;

    document.getElementById('costume-top').classList.remove('hidden');
    document.querySelectorAll('.costume-portrait-item').forEach(el => {
      const sameIdx = Number(el.dataset.idx) === idx;
      const sameRerun = el.dataset.isRerun === String(isRerun);
      el.classList.toggle('active', sameIdx && sameRerun);
    });

    // 정보 업데이트
    document.getElementById('costume-nikke-name').textContent = costume['니케'];
    document.getElementById('costume-name').textContent = costume['코스튬명'];
    // D-day 배지는 기간 문구(와 복각의 "N일 만에 복각" 부연) 다음 줄에 놓는다
    document.getElementById('costume-date').innerHTML =
      formatCostumeDate(costume['시작일'], costume['종료일']) +
      formatRemainingDays(costume['시작일'], costume['종료일'], 'is-own-line');
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
        formatRerunGap(costume['시작일'], costume['복각 시작일']) +
        formatRemainingDays(costume['복각 시작일'], costume['복각 종료일'], 'is-own-line');
    } else {
      rerunWrap.classList.add('hidden');
    }

    // 스파인 플레이어 로드
    loadSpinePlayer(costume);
  }

  // 스켈레톤 하나를 로드하지 않고 바운딩 박스(x/y/width/height)만 알아내기 위한 프로브.
  // 화면에는 안 보이며, 알아낸 뒤 바로 정리한다.
  function probeSkeletonBounds(stageDiv, probeKey, skelUrl, atlasUrl, callback) {
    const probeDiv = document.createElement('div');
    probeDiv.id = 'spine-layer-probe-' + probeKey;
    probeDiv.style.cssText = 'position:absolute; inset:0; width:100%; height:100%;';
    stageDiv.appendChild(probeDiv);

    new spine.SpinePlayer(probeDiv.id, {
      skelUrl: skelUrl,
      atlasUrl: atlasUrl,
      backgroundColor: '#00000000',
      showControls: false,
      success: function(probePlayer) {
        const data = probePlayer.skeleton.data;
        callback({ x: data.x, y: data.y, width: data.width, height: data.height });
        probePlayer.dispose();
        probeDiv.remove();
      }
    });
  }

  // 기본 스켈레톤 하나만 있을 때 쓰는 뷰포트: 가로는 로컬 x=0을 중심으로, 세로는 실제
  // 바닥(y) 기준으로 잡는다 — 기존에 검증된 방식 그대로라 추가 파츠가 없는 코스튬은
  // 동작이 전혀 바뀌지 않는다.
  function computeSoloViewportConfig(vp) {
    return {
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
    };
  }

  // 추가 파츠가 있을 때 쓰는 뷰포트: 기본 스켈레톤 하나만 기준으로 프레임을 잡으면 그보다
  // 넓게 그려지는 파츠(장식/소품)의 테두리가 잘리므로, 모든 레이어의 바운딩 박스를 합쳐서
  // (합집합) 전부 들어오는 하나의 공통 뷰포트를 만든다.
  function computeUnionViewportConfig(boundsList) {
    const left = Math.min(...boundsList.map(b => b.x));
    const right = Math.max(...boundsList.map(b => b.x + b.width));
    const bottom = Math.min(...boundsList.map(b => b.y));
    const top = Math.max(...boundsList.map(b => b.y + b.height));
    return {
      animationViewport: false,
      transitionTime: 0,
      x: left,
      y: bottom,
      width: right - left,
      height: top - bottom,
      padLeft: '15%',
      padRight: '15%',
      padTop: '5%',
      padBottom: '5%',
    };
  }

  // 스켈레톤 하나를 넘겨받은 뷰포트로 실제 로드해서 stageDiv 안에 100%x100% 절대 위치
  // 레이어로 쌓는다. 같은 stageDiv에 여러 레이어를 겹치면(추가 파츠) stageDiv 하나만
  // 팬/줌 대상으로 삼아도 레이어 전체가 함께 움직인다.
  // knownAnimation: 해당 스켈레톤에 반드시 존재한다고 알고 있는 애니메이션 이름(기본 스켈레톤의
  // 'idle' 등). 없으면(추가 파츠처럼 어떤 애니메이션이 있는지 모르는 경우) null을 넘기면
  // 로드 후 실제 존재하는 애니메이션 중에서 안전하게 골라 재생한다 — 없는 이름을 config에
  // 직접 넘기면 라이브러리 내부에서 예외가 나서 블랙박스 에러 화면이 뜨기 때문.
  // ===== 코스튬 L2D 애니메이션 =====
  //
  // 니케 코스튬 스켈레톤의 애니메이션은 크게 셋으로 나뉜다.
  //  - 동작: idle / idle_02 / idle_alt / action. 몸이 계속 움직이는 대기·특수 동작.
  //  - 표정: angry / delight / sad / shy / smile / surprise / no / special / expression_0.
  //    전부 idle 과 같은 길이(5.33초)의 전신 애니메이션이라, 얼굴만 바꾼 idle 변형이다.
  //    그래서 겹쳐 트는 게 아니라 하나만 골라서 idle 대신 튼다.
  //  - talk_*: 0.03초짜리 입모양 한 컷. 혼자 틀면 정지 화면이라 목록에서 뺀다.
  //
  // 코스튬 고유 연출(팬텀 세인트 시프의 떨어지는 지폐·반짝임 파티클, 뒤에 뜨는 요정)은
  // expression_0 에만 붙어 있다. idle 에서는 해당 슬롯의 attachment 가 아예 없고,
  // 추가 파츠(요정) 스켈레톤은 idle 에서 ps_* 슬롯을 전부 null 로 꺼버린다.
  // 목록에서 아예 빼는 것들.
  //  - bg_idle: 배경 파츠 전용이라 사람이 고를 일이 없다.
  //  - expression_0 계열: 코스튬 연출용인데 화면이 멈춘 것처럼 보인다.
  //  - talk_*: 0.03초짜리 입모양 한 컷이라 혼자 틀면 정지 화면이 된다.
  const COSTUME_HIDDEN_ANIM_RE = /^(bg_idle|expression_\d+|talk)/;

  // 동작은 idle 계열과 action 계열뿐이고, 나머지는 전부 표정으로 본다.
  // 표정 이름을 목록으로 못 박아 두면(angry/delight/sad/...) 코스튬마다 think, worry,
  // pain, cry, sleep, rage 처럼 처음 보는 이름이 나올 때마다 동작 쪽으로 새어 나간다.
  // 실제로 36개 스켈레톤을 훑어보니 그런 이름이 여럿 있었다.
  const COSTUME_MOTION_RE = /^(idle|action)(_|$)/;

  const COSTUME_DEFAULT_ANIM = 'idle';

  // 지금 모든 레이어가 함께 재생 중인 애니메이션. 추가 파츠 레이어는 본체보다 늦게
  // 준비될 수 있어서, 준비되는 시점에 이 값을 보고 같은 동작으로 맞춘다 — 본체는 표정을
  // 짓는데 뒤의 요정만 딴 동작을 하고 있으면 안 되니까.
  let costumeCurrentAnim = COSTUME_DEFAULT_ANIM;

  function playAnimOn(player, name) {
    try {
      if (!player || !player.skeleton || !name) return false;
      if (!player.skeleton.data.findAnimation(name)) return false;
      player.setAnimation(name, true);
      player.play();
      return true;
    } catch (err) {
      console.error('[코스튬 L2D] 애니메이션 적용 실패:', name, err);
      return false;
    }
  }

  // 레이어가 이 이름을 못 가지고 있으면 기본 동작으로라도 움직이게 한다(정지 화면 방지)
  function syncLayerAnimation(player) {
    if (playAnimOn(player, costumeCurrentAnim)) return;
    if (playAnimOn(player, COSTUME_DEFAULT_ANIM)) return;
    try {
      const first = player.skeleton.data.animations[0];
      if (first) playAnimOn(player, first.name);
      else player.play();
    } catch (err) {}
  }

  function applyCostumeAnimation(name) {
    costumeCurrentAnim = name;
    activeSpinePlayers.forEach(p => syncLayerAnimation(p));
    markCostumeAnimActive(name);
  }

  function classifyCostumeAnimations(skeletonData) {
    const names = skeletonData.animations.map(a => a.name).filter(n => !COSTUME_HIDDEN_ANIM_RE.test(n));
    return {
      motions: names.filter(n => COSTUME_MOTION_RE.test(n)),
      expressions: names.filter(n => !COSTUME_MOTION_RE.test(n)),
    };
  }

  // 표정은 대부분 기본형과 _02 변형이 짝을 이룬다. 둘을 좌우 두 열로 붙여 놓으면
  // 같은 표정의 변형이라는 게 한눈에 보인다. _02 가 없는 표정은 오른쪽 칸을 비운다.
  function pairExpressionsByVariant(names) {
    const rows = [];
    const rowByBase = new Map();
    names.forEach(name => {
      const m = name.match(/^(.*)_02$/);
      const base = m ? m[1] : name;
      let row = rowByBase.get(base);
      if (!row) { row = { base: null, variant: null }; rowByBase.set(base, row); rows.push(row); }
      if (m) row.variant = name; else row.base = name;
    });
    // 기본형 없이 _02 만 있는 경우엔 그것을 왼쪽 칸에 둔다(빈 줄이 생기지 않게)
    rows.forEach(r => { if (!r.base && r.variant) { r.base = r.variant; r.variant = null; } });
    return rows;
  }

  // 동작 버튼 줄(모델 아래) + 표정 버튼 줄(모델 위, 새로고침 버튼 아래).
  // 표정은 하나만 고를 수 있고, "기본"을 누르면 고른 동작으로 돌아간다.
  function renderCostumeAnimControls(skeletonData) {
    const { motions, expressions } = classifyCostumeAnimations(skeletonData);

    const motionBox = document.getElementById('costume-anim-toggle');
    if (motionBox) {
      if (motions.length <= 1) {
        motionBox.innerHTML = '';
        motionBox.classList.add('hidden');
      } else {
        motionBox.classList.remove('hidden');
        motionBox.innerHTML = motions.map(n =>
          `<button class="anim-btn" data-anim="${n}">${n}</button>`).join('');
        motionBox.querySelectorAll('.anim-btn').forEach(btn => {
          btn.addEventListener('click', () => applyCostumeAnimation(btn.dataset.anim));
        });
      }
    }

    const exprBox = document.getElementById('costume-expression');
    if (exprBox) {
      if (!expressions.length) {
        exprBox.innerHTML = '';
        exprBox.classList.add('hidden');
      } else {
        const base = motions.includes(COSTUME_DEFAULT_ANIM) ? COSTUME_DEFAULT_ANIM : (motions[0] || COSTUME_DEFAULT_ANIM);
        const cell = n => n
          ? `<button class="anim-btn expr-btn" data-anim="${n}">${n}</button>`
          : `<span class="expr-empty"></span>`;
        exprBox.classList.remove('hidden');
        exprBox.innerHTML = `<div class="expr-title">표정</div>`
          + `<button class="anim-btn expr-btn expr-base" data-anim="${base}">기본</button>`
          + `<div class="expr-grid">`
          + pairExpressionsByVariant(expressions).map(r => cell(r.base) + cell(r.variant)).join('')
          + `</div>`;
        exprBox.querySelectorAll('.expr-btn').forEach(btn => {
          btn.addEventListener('click', () => applyCostumeAnimation(btn.dataset.anim));
        });
      }
    }
  }

  function markCostumeAnimActive(name) {
    document.querySelectorAll('#costume-anim-toggle .anim-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.anim === name);
    });
    // 표정 줄은 "기본" 버튼도 같은 data-anim 을 쓰므로 첫 일치만 켠다
    let marked = false;
    document.querySelectorAll('#costume-expression .expr-btn').forEach(b => {
      const hit = !marked && b.dataset.anim === name;
      b.classList.toggle('active', hit);
      if (hit) marked = true;
    });
  }

  function createSpineLayer(stageDiv, layerKey, skelUrl, atlasUrl, knownAnimation, viewportConfig, onReady) {
    const layerDiv = document.createElement('div');
    layerDiv.id = 'spine-layer-' + layerKey;
    layerDiv.style.cssText = 'position:absolute; inset:0; width:100%; height:100%;';
    stageDiv.appendChild(layerDiv);

    new spine.SpinePlayer(layerDiv.id, {
      skelUrl: skelUrl,
      atlasUrl: atlasUrl,
      animation: knownAnimation || undefined,
      backgroundColor: '#00000000',
      showControls: false,
      preserveDrawingBuffer: false,
      antialias: true,
      viewport: viewportConfig,
      success: function(realPlayer) {
        if (!knownAnimation) {
          // 본체가 지금 재생 중인 동작에 맞춘다. 같은 이름이 없으면 idle, 그것도 없으면
          // 첫 애니메이션으로 내려간다.
          syncLayerAnimation(realPlayer);
          // 애니메이션이 하나도 없거나 재생에 실패해도 렌더 루프 자체는 계속 돌아야
          // 캔버스 크기 계산/그리기가 멈추지 않는다 — 애니메이션 없이 정지 포즈만
          // 보여줘야 하는 파츠(장식/소품)도 있을 수 있으므로 항상 play()를 호출해둔다.
          try { realPlayer.play(); } catch (err) {}
        }
        activeSpinePlayers.push(realPlayer);
        onReady(realPlayer, layerDiv);
      }
    });

    return layerDiv;
  }

  function clearCostumeSpinePlayer() {
    const wrap = document.getElementById('costume-spine-player');
    if (wrap) wrap.innerHTML = '';

    const partsToggle = document.getElementById('costume-parts-toggle');
    if (partsToggle) { partsToggle.innerHTML = ''; partsToggle.classList.add('hidden'); }

    const extraPartsToggle = document.getElementById('costume-extra-parts-toggle');
    if (extraPartsToggle) { extraPartsToggle.innerHTML = ''; extraPartsToggle.classList.add('hidden'); }

    const animToggle = document.getElementById('costume-anim-toggle');
    if (animToggle) { animToggle.innerHTML = ''; animToggle.classList.add('hidden'); }

    const exprBox = document.getElementById('costume-expression');
    if (exprBox) { exprBox.innerHTML = ''; exprBox.classList.add('hidden'); }

    // 다른 코스튬으로 넘어가면 표정 선택은 풀고 기본 동작부터 다시 시작한다
    costumeCurrentAnim = COSTUME_DEFAULT_ANIM;

    if (costumePanZoom) { costumePanZoom.destroy(); costumePanZoom = null; }

    activeSpinePlayers.forEach(p => { try { p.dispose(); } catch (err) {} });
    activeSpinePlayers = [];
    spinePlayer = null;
  }

  function loadSpinePlayer(costume) {
    const skelUrl = costume['skel'];
    const atlasUrl = costume['atlas'];
    const extraParts = costume['추가 파츠'] || [];

    clearCostumeSpinePlayer();

    if (!skelUrl || !atlasUrl) {
      return;
    }

    const wrap = document.getElementById('costume-spine-player');
    const wrapEl = document.getElementById('costume-spine-wrap');
    const wrapHeight = wrapEl.clientHeight;
    const wrapWidth = wrapEl.clientWidth;

    // 여러 스켈레톤 레이어(기본 + 추가 파츠)를 담을 무대. 팬/줌은 이 div 하나에만 적용한다.
    const stageDiv = document.createElement('div');
    stageDiv.id = 'costume-spine-stage';
    stageDiv.style.width = wrapWidth + 'px';
    stageDiv.style.height = wrapHeight + 'px';
    stageDiv.style.position = 'relative';
    wrap.appendChild(stageDiv);

    // 원래 입력 순서(_idx)를 기억해둬야 앞/뒤로 나뉘어도 "추가 파츠 1", "추가 파츠 2" 같은
    // 토글 라벨이 입력한 순서와 일치한다.
    const extraPartsIndexed = extraParts.map((p, i) => ({ ...p, _idx: i }));
    const behindParts = extraPartsIndexed.filter(p => p.order === '뒤');
    const frontParts = extraPartsIndexed.filter(p => p.order !== '뒤');
    const extraLayerDivs = new Array(extraParts.length).fill(null);

    // 기본 스켈레톤 + 추가 파츠 전부를 먼저 프로브해서(크기 파악용, 화면에는 안 보임)
    // 바운딩 박스를 모으고, 그걸로 계산한 뷰포트 하나를 모든 레이어에 동일하게 적용한다.
    const probeTargets = [
      { key: 'main', skel: skelUrl, atlas: atlasUrl },
      ...extraParts.map((part, i) => ({ key: 'extra-' + i, skel: part.skel, atlas: part.atlas })),
    ];
    const boundsByKey = {};
    let probesRemaining = probeTargets.length;

    probeTargets.forEach(target => {
      probeSkeletonBounds(stageDiv, target.key, target.skel, target.atlas, vp => {
        boundsByKey[target.key] = vp;
        probesRemaining--;
        if (probesRemaining === 0) proceedWithViewport();
      });
    });

    function proceedWithViewport() {
      const viewportConfig = extraParts.length === 0
        ? computeSoloViewportConfig(boundsByKey['main'])
        : computeUnionViewportConfig(Object.values(boundsByKey));

      // 뒤로 가야 하는 파츠는 기본 스켈레톤보다 먼저 만들어서(DOM 순서상 더 아래에 쌓이도록)
      // 기본 스켈레톤 뒤에 깔리게 하고, 앞으로 가야 하는 파츠는 그 다음에 만들어서 위에 쌓이게 한다.
      // 클릭 상호작용은 기본 스켈레톤에만 있으므로 파츠 레이어는 마우스 이벤트를 그냥
      // 통과시킨다(pointer-events:none) — 기본 캐릭터 클릭/드래그를 가리지 않도록.
      behindParts.forEach(part => {
        const layerDiv = createSpineLayer(stageDiv, 'behind-' + part._idx, part.skel, part.atlas, null, viewportConfig, (player, ld) => {
          ld.style.pointerEvents = 'none';
        });
        extraLayerDivs[part._idx] = layerDiv;
      });

      createSpineLayer(stageDiv, 'main', skelUrl, atlasUrl, 'idle', viewportConfig, (player2, layerDiv) => {
        spinePlayer = player2;

        renderCostumeAnimControls(player2.skeleton.data);
        applyCostumeAnimation(costumeCurrentAnim);

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
        renderPartsToggle('costume-parts-toggle', partSkins, enabledParts, rebuildSkin);

        costumePanZoom = setupSpinePanZoom(stageDiv, wrapEl);

        const resetBtn = document.getElementById('costume-spine-reset');
        if (resetBtn) {
          resetBtn.onmousedown = e => e.stopPropagation();
          resetBtn.onclick = e => {
            e.stopPropagation();
            costumePanZoom.reset();
            try {
              player2.animationState.clearListeners();
              applyCostumeAnimation(costumeCurrentAnim);
            } catch (err) {
              console.error('[코스튬 L2D] 초기화 실패:', err);
            }
          };
        }

        player2.animationState.data.defaultMix = 0;

        player2.canvas.addEventListener('click', () => {
          try {
            // 클릭하면 특수 동작을 한 번 보여주고 원래 보던 동작으로 돌아온다.
            // 뒤의 추가 파츠도 같이 움직여야 해서 모든 레이어에 건다.
            activeSpinePlayers.forEach(p => {
              try {
                if (p.skeleton && p.skeleton.data.findAnimation('action')) {
                  p.setAnimation('action', false);
                  p.play();
                }
              } catch (err) {}
            });
            player2.animationState.addListener({
              complete: () => {
                applyCostumeAnimation(costumeCurrentAnim);
                player2.animationState.clearListeners();
              }
            });
          } catch (err) {
            console.error('[코스튬 L2D] action 애니메이션 재생 실패:', err);
          }
        });
      });

      frontParts.forEach(part => {
        const layerDiv = createSpineLayer(stageDiv, 'front-' + part._idx, part.skel, part.atlas, null, viewportConfig, (player, ld) => {
          ld.style.pointerEvents = 'none';
        });
        extraLayerDivs[part._idx] = layerDiv;
      });

      // 추가 파츠 on/off 토글: 각 파츠가 완전히 독립된 스켈레톤이라, 기본 스켈레톤처럼
      // 스킨을 다시 합칠 필요 없이 레이어 div를 통째로 보이기/숨기기만 하면 된다.
      const extraPartLabels = extraParts.map((p, i) => ({ name: `추가 파츠 ${i + 1}` }));
      const enabledExtraParts = new Set(extraPartLabels.map(p => p.name)); // 기본값: 전부 켜짐
      renderPartsToggle('costume-extra-parts-toggle', extraPartLabels, enabledExtraParts, () => {
        extraLayerDivs.forEach((layerDiv, i) => {
          if (!layerDiv) return;
          layerDiv.style.display = enabledExtraParts.has(extraPartLabels[i].name) ? '' : 'none';
        });
      });
    }
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

  // 남은 일수를 D-n 배지로 표시. 진행중이면 종료까지, 아직 시작 전이면 시작까지 —
  // 세는 기준이 다르므로 메인 페이지와 같이 문구와 색을 구분한다. 이미 끝났으면 표시 안 함.
  // (코스튬 기간은 시:분까지 들어있으므로 픽업과 달리 자정으로 밀지 않고 그대로 계산한다)
  function formatRemainingDays(start, end, variantClass = '') {
    if (!start || !end) return '';
    const now = new Date();
    const s = new Date(start);
    const e = new Date(end);
    const cls = extra => ['costume-remaining-badge', variantClass, extra].filter(Boolean).join(' ');
    const days = target => Math.max(Math.ceil((target - now) / (1000 * 60 * 60 * 24)), 0);
    if (now < s) return `<span class="${cls('is-upcoming')}">시작까지 D-${days(s)}</span>`;
    if (now > e) return '';
    return `<span class="${cls()}">종료까지 D-${days(e)}</span>`;
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
