  let allFramesData = [];
  let currentFrame = null;
  let framesSpinePlayer = null;
  let framesPanZoom = null;

  function loadFramesData() {
    onAppDataReady(() => {
      initFrames(APP_DATA.frames || []);
    });
  }

  function initFrames(data) {
    allFramesData = data;

    if (!data || data.length === 0) {
      document.getElementById('frames-empty').classList.remove('hidden');
      return;
    }

    renderFramesSelector(data);
    // 처음에는 아무 보스도 펼치지 않는다. 목록만 넓게 보여주고 고를 때 펼친다.
    collapseFrame();
    document.getElementById('frames-sort-btn').addEventListener('click', toggleFramesAttrSort);
  }

  // 보스의 약점 속성 아이콘. 니케 쪽에서 쓰는 우월코드 아이콘을 그대로 재사용한다
  // (약점 속성이 곧 그 보스에 대한 우월코드라 같은 그림이면 된다).
  function weaknessIconHtml(item) {
    const code = item['약점 속성'];
    if (!code) return '';
    const url = (APP_DATA.iconImg && APP_DATA.iconImg['우월코드'] || {})[code];
    const inner = url
      ? `<img src="${url}" alt="${code}">`
      : `<span class="frames-item-weak-text">${code}</span>`;
    return `<div class="frames-item-weak code-${code}" data-tooltip="약점 ${code}">${inner}</div>`;
  }

  function framesItemHtml(item) {
    const idx = allFramesData.indexOf(item);
    const imgUrl = item['보스 이미지'];
    return `
      <div class="frames-item" data-idx="${idx}" onclick="selectFrame(allFramesData[${idx}])">
        <div class="frames-item-img">
          ${imgUrl ? `<img src="${imgUrl}" alt="${item['보스']}">` : item['보스']}
          ${weaknessIconHtml(item)}
        </div>
        <div class="frames-item-text">
          <div class="frames-item-season">시즌 ${item['시즌']}</div>
          <div class="frames-item-boss">${item['보스']}</div>
        </div>
      </div>
    `;
  }

  // 약점 속성별로 열을 나눠서 보여주는 모드. 순서는 사이트 다른 곳(우월코드 필터/몰아보기)
  // 에서 쓰는 순서와 맞춘다.
  const FRAMES_ATTR_ORDER = ['작열', '철갑', '풍압', '전격', '수냉'];
  let framesSortByAttr = false;

  function framesAttrColumnsHtml(sorted) {
    const byAttr = new Map(FRAMES_ATTR_ORDER.map(a => [a, []]));
    const etc = [];
    sorted.forEach(item => {
      const attr = item['약점 속성'];
      if (byAttr.has(attr)) byAttr.get(attr).push(item);
      else etc.push(item);
    });
    // 5속성 중 어디에도 안 들어가는 값이 있어도 목록에서 사라지지 않게 뒤에 붙인다
    if (etc.length) byAttr.set('기타', etc);

    return [...byAttr]
      .filter(([, items]) => items.length > 0)
      .map(([attr, items]) => {
        const url = (APP_DATA.iconImg && APP_DATA.iconImg['우월코드'] || {})[attr];
        return `
          <div class="frames-attr-col">
            <div class="frames-attr-col-head">
              ${url ? `<img src="${url}" alt="${attr}">` : ''}
              <span>${attr}</span><em>${items.length}</em>
            </div>
            <div class="frames-attr-col-body">${items.map(framesItemHtml).join('')}</div>
          </div>`;
      }).join('');
  }

  function renderFramesSelector(data) {
    const container = document.getElementById('frames-selector');

    // 최신 시즌부터 먼저 보여준다
    const sorted = [...data].sort((a, b) => Number(b['시즌']) - Number(a['시즌']));

    container.classList.toggle('is-attr-sorted', framesSortByAttr);
    container.innerHTML = framesSortByAttr
      ? framesAttrColumnsHtml(sorted)
      : sorted.map(framesItemHtml).join('');

    // 다시 그리면 고른 표시가 지워지니 되살린다(정렬만 바꿨을 때 선택이 풀리면 안 된다)
    if (currentFrame) {
      document.querySelectorAll('.frames-item').forEach(el => {
        el.classList.toggle('active', allFramesData[el.dataset.idx] === currentFrame);
      });
    }
  }

  function toggleFramesAttrSort() {
    framesSortByAttr = !framesSortByAttr;
    document.getElementById('frames-sort-btn').classList.toggle('active', framesSortByAttr);
    renderFramesSelector(allFramesData);
  }

  // 세로 목록은 오른쪽(모델+테두리) 높이에 맞춰 늘어나는데, 테두리가 적은 보스는 그
  // 높이가 화면 중간에서 끝나 버린다. 최소한 화면 아래까지는 닿게 해서 한 번에 보이는
  // 보스 수를 늘린다. 창 크기가 바뀌면 다시 잰다.
  function syncFramesSelectorHeight() {
    const col = document.getElementById('frames-selector-col');
    if (!col || !document.getElementById('frames-layout').classList.contains('is-detail-open')) return;
    col.style.minHeight = '';
    const docTop = col.getBoundingClientRect().top + window.scrollY;
    col.style.minHeight = Math.max(420, window.innerHeight - docTop - 16) + 'px';
  }

  window.addEventListener('resize', syncFramesSelectorHeight);

  // 상세를 접고 목록을 원래(가로) 배치로 되돌린다
  function collapseFrame() {
    currentFrame = null;
    clearFramesSpine();
    document.getElementById('frames-top').classList.add('hidden');
    document.getElementById('frames-selector-col').style.minHeight = '';
    document.getElementById('frames-layout').classList.remove('is-detail-open');
    // 테두리는 상세 바깥에 있어서 같이 안 지워졌다. 접었는데 방금 본 보스의 테두리만
    // 남아 있으면 무엇에 딸린 건지 알 수 없다.
    document.getElementById('frames-tiers').innerHTML = '';
    document.querySelectorAll('.frames-item').forEach(el => el.classList.remove('active'));
  }

  function selectFrame(item) {
    // 이미 펼쳐진 보스를 다시 누르면 접는다
    if (currentFrame === item) { collapseFrame(); return; }
    currentFrame = item;

    document.getElementById('frames-top').classList.remove('hidden');
    // 상세가 열리면 보스 목록을 왼쪽 세로 열로 바꾼다(CSS 가 처리)
    document.getElementById('frames-layout').classList.add('is-detail-open');
    document.querySelectorAll('.frames-item').forEach(el => {
      el.classList.toggle('active', allFramesData[el.dataset.idx] === item);
    });

    document.getElementById('frames-boss-name').textContent = item['보스'] || '';
    document.getElementById('frames-season-label').textContent = `시즌 ${item['시즌']}`;
    renderFramesPeriod(item);
    // 약점 속성: 아이콘이 있으면 아이콘과 이름을 같이 보여준다
    const attrEl = document.getElementById('frames-attr');
    const code = item['약점 속성'];
    const iconUrl = code ? (APP_DATA.iconImg && APP_DATA.iconImg['우월코드'] || {})[code] : null;
    attrEl.innerHTML = code
      ? `${iconUrl ? `<img src="${iconUrl}" alt="${code}" class="frames-attr-icon">` : ''}<span>${code}</span>`
      : '-';

    renderFrameTiers(item);
    syncFramesSelectorHeight();
    loadFramesSpine(item);
  }

  // 실제로 돌아간 구간만 뽑아낸다.
  //
  // 버그·점검으로 중간에 멈췄다 다시 연 시즌이 있어서, 시작~종료를 한 줄로 적으면 멈춰
  // 있던 날까지 진행한 것처럼 보인다. 중단 구간을 빼고 "시작~중단 / 재오픈~중단 /
  // 재오픈~종료" 로 끊어서 보여 준다.
  //
  // 중단 기록이 없으면 시작~종료 한 줄이 그대로 나온다(대부분의 시즌이 여기 해당).
  function framesRunSegments(item) {
    const start = item['시작일'];
    const end = item['종료일'];
    if (!start || !end) return [];

    const pauses = (item['중단 기간'] || [])
      .filter(p => p && p['시작'])
      .sort((a, b) => new Date(a['시작']) - new Date(b['시작']));

    const segments = [];
    let cursor = start;
    for (const p of pauses) {
      // paused: 이 구간이 자연스럽게 끝난 게 아니라 중단으로 끊겼다는 표시
      if (new Date(p['시작']) > new Date(cursor)) {
        segments.push({ from: cursor, to: p['시작'], paused: true });
      }
      // 재오픈 시각이 없으면 다시 안 열린 것이라 여기서 끝난다
      if (!p['종료']) return { segments, paused: true };
      cursor = p['종료'];
    }
    if (new Date(end) > new Date(cursor)) {
      segments.push({ from: cursor, to: end, paused: false });
    }
    return { segments, paused: pauses.length > 0 };
  }

  function renderFramesPeriod(item) {
    const box = document.getElementById('frames-date');
    if (!box) return;

    const { segments, paused } = framesRunSegments(item);
    if (!segments.length) { box.textContent = '-'; return; }

    const withTime = hasTimePart(item['시작일']) || hasTimePart(item['종료일']);
    box.innerHTML = segments.map((seg, i) => {
      // 중단된 적이 없는 시즌은 한 줄뿐이라 차수도 중단 표시도 붙이지 않는다
      const order = paused ? `<span class="frames-date-order">${i + 1}차</span>` : '';
      const mark = seg.paused ? `<span class="frames-date-pause">중단</span>` : '';
      return `<div class="frames-date-item">${order}`
        + `<span>${formatKst(seg.from, { withTime })} ~ ${formatKst(seg.to, { withTime })}</span>`
        + `${mark}</div>`;
    }).join('');
  }

  function renderFrameTiers(item) {
    const container = document.getElementById('frames-tiers');
    const tiers = [1, 2, 3]
      .map(n => ({
        name: item[`테두리${n}`],
        img: item[`테두리${n} 이미지`],
        desc: item[`테두리${n} 설명`],
      }))
      .filter(t => t.name);

    // 모델 아래 폭을 테두리 수만큼 똑같이 나눈다. 보통 셋이라 3등분이 되고, 설명이 길어도
    // 서로 겹치지 않게 각자 제 칸 안에서만 줄바꿈된다.
    container.style.setProperty('--tier-cols', Math.max(tiers.length, 1));

    container.innerHTML = tiers.map(t => `
      <div class="frames-tier-card">
        <div class="frames-tier-img">
          ${t.img ? `<img src="${t.img}" alt="${t.name}">` : ''}
        </div>
        <div class="frames-tier-name">${t.name}</div>
        ${t.desc ? `<div class="frames-tier-desc">${escapeHtml(t.desc).split(NEWLINE_RE).join('<br>')}</div>` : ''}
      </div>
    `).join('');
  }

  // 표에 적힌 줄바꿈(CRLF/LF)을 <br> 로 바꿀 때 쓴다
  const NEWLINE_RE = /\r\n|\r|\n/;

  // 설명은 사람이 표에 적어 넣는 값이라 그대로 innerHTML 에 넣지 않는다
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clearFramesSpine() {
    if (framesSpinePlayer) { framesSpinePlayer.dispose(); framesSpinePlayer = null; }
    if (framesPanZoom) { framesPanZoom.destroy(); framesPanZoom = null; }
    const wrap = document.getElementById('frames-spine-player');
    if (wrap && window.disposeFramesModel3D) window.disposeFramesModel3D(wrap);
    if (wrap) wrap.innerHTML = '';
    const toggle = document.getElementById('frames-parts-toggle');
    if (toggle) { toggle.innerHTML = ''; toggle.classList.add('hidden'); }
  }

  function loadFramesSpine(item) {
    clearFramesSpine();

    const wrap = document.getElementById('frames-spine-player');
    const modelUrl = item['model'];
    const skelUrl = item['skel'];
    const atlasUrl = item['atlas'];

    // 3D 모델(glb)이 있으면 우선 사용 — Spine L2D보다 커버리지가 넓다
    if (modelUrl && window.loadFramesModel3D) {
      window.loadFramesModel3D(wrap, modelUrl, {
        onError: () => {
          // 3D 로드 실패 시 L2D/이미지/이름 순으로 안전하게 대체
          wrap.innerHTML = '';
          if (skelUrl && atlasUrl) {
            loadFramesL2D(skelUrl, atlasUrl);
          } else if (item['보스 이미지']) {
            wrap.innerHTML = `<img src="${item['보스 이미지']}" alt="${item['보스']}">`;
          } else {
            wrap.textContent = item['보스'] || '';
          }
        },
      });
      return;
    }

    if (skelUrl && atlasUrl) {
      loadFramesL2D(skelUrl, atlasUrl);
      return;
    }

    // L2D가 없으면 보스 이미지로 대체, 그것도 없으면 이름만 표시
    if (item['보스 이미지']) {
      wrap.innerHTML = `<img src="${item['보스 이미지']}" alt="${item['보스']}">`;
    } else {
      wrap.textContent = item['보스'] || '';
    }
  }

  function loadFramesL2D(skelUrl, atlasUrl) {
    const wrap = document.getElementById('frames-spine-player');
    wrap.innerHTML = '';

    const playerDiv = document.createElement('div');
    playerDiv.id = 'frames-spine-inner';
    playerDiv.style.width = '100%';
    playerDiv.style.height = '100%';
    wrap.appendChild(playerDiv);

    // idle 이 없는 스켈레톤이 있어서 이름을 못 박지 않는다. 읽어 온 뒤 있는 것 중에서 고른다.
    framesSpinePlayer = new spine.SpinePlayer('frames-spine-inner', {
      skelUrl: skelUrl,
      atlasUrl: atlasUrl,
      backgroundColor: '#00000000',
      showControls: false,
      success: function(player) {
        const data = player.skeleton.data;
        const vp = { x: data.x, y: data.y, width: data.width, height: data.height };
        player.dispose();
        wrap.innerHTML = '';

        const wrapEl = document.getElementById('frames-spine-wrap');
        const wrapW = wrapEl.clientWidth;
        const wrapH = wrapEl.clientHeight;

        const playerDiv2 = document.createElement('div');
        playerDiv2.id = 'frames-spine-inner';
        playerDiv2.style.width = wrapW + 'px';
        playerDiv2.style.height = wrapH + 'px';
        wrap.appendChild(playerDiv2);

        framesSpinePlayer = new spine.SpinePlayer('frames-spine-inner', {
          skelUrl: skelUrl,
          atlasUrl: atlasUrl,
          animation: pickSpineAnimation(data),
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
            const partSkins = skeleton.data.skins.filter(skin => skin.name !== 'default');
            const enabledParts = new Set(partSkins.map(s => s.name));

            const rebuildSkin = () => {
              // 주의: 원본 defaultSkin을 mutate하면 파츠 껐다 켰다가 안 먹는 버그가 생기므로
              // 매번 새 Skin 객체에 복사만 해온다 (코스튬/미실장 탭과 동일한 이유)
              const combined = new spine.Skin('combined');
              const defaultSkin = skeleton.data.findSkin('default');
              if (defaultSkin) combined.addSkin(defaultSkin);
              partSkins.forEach(skin => {
                if (enabledParts.has(skin.name)) combined.addSkin(skin);
              });
              skeleton.setSkin(combined);
              skeleton.setToSetupPose();
              if (player2.animationState) player2.animationState.apply(skeleton);
              skeleton.updateWorldTransform();
            };
            rebuildSkin();
            renderPartsToggle('frames-parts-toggle', partSkins, enabledParts, rebuildSkin);

            framesPanZoom = setupSpinePanZoom(playerDiv2, wrapEl);

            const resetBtn = document.getElementById('frames-spine-reset');
            if (resetBtn) {
              resetBtn.onmousedown = e => e.stopPropagation();
              resetBtn.onclick = e => {
                e.stopPropagation();
                framesPanZoom.reset();
                try {
                  player2.animationState.clearListeners();
                  player2.setAnimation(pickSpineAnimation(player2.skeleton.data), true);
                } catch (err) {
                  console.error('[역대 테두리 L2D] 초기화 실패:', err);
                }
              };
            }

            player2.animationState.data.defaultMix = 0;

            player2.canvas.addEventListener('click', () => {
              try {
                if (!player2.skeleton.data.findAnimation('action')) return;
                player2.setAnimation('action', false);
                player2.animationState.addListener({
                  complete: () => {
                    try {
                      player2.setAnimation(pickSpineAnimation(player2.skeleton.data), true);
                    } catch (err) {
                      console.error('[역대 테두리 L2D] 대기 애니메이션 복귀 실패:', err);
                    }
                    player2.animationState.clearListeners();
                  }
                });
              } catch (err) {
                console.error('[역대 테두리 L2D] action 애니메이션 재생 실패:', err);
              }
            });
          }
        });
      }
    });
  }

  function waitForSpine(callback) {
    if (typeof spine !== 'undefined') {
      callback();
    } else {
      setTimeout(() => waitForSpine(callback), 100);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    waitForSpine(loadFramesData);
  });
