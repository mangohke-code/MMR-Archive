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
    document.getElementById('frames-date').textContent = formatFramesDate(item['시작일'], item['종료일']);
    renderFramesPause(item);
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

  function formatFramesDate(start, end) {
    if (!start || !end) return '-';
    const withTime = hasTimePart(start) || hasTimePart(end);
    return `${formatKst(start, { withTime })} ~ ${formatKst(end, { withTime })}`;
  }

  // 중간에 멈춘 구간. 없으면 줄 자체를 숨긴다 — 대부분의 시즌은 멈춘 적이 없다.
  function renderFramesPause(item) {
    const row = document.getElementById('frames-pause-row');
    const box = document.getElementById('frames-pause');
    if (!row || !box) return;

    const list = (item['중단 기간'] || []).filter(p => p && p['시작']);
    if (!list.length) { row.classList.add('hidden'); box.innerHTML = ''; return; }

    row.classList.remove('hidden');
    box.innerHTML = list.map(p => {
      const start = formatKst(p['시작'], { withTime: true });
      const end = p['종료'] ? formatKst(p['종료'], { withTime: true }) : '';
      return `<div class="frames-pause-item">${start}${end ? ` ~ ${end}` : ' ~ (미복구)'}</div>`;
    }).join('');
  }

  function renderFrameTiers(item) {
    const container = document.getElementById('frames-tiers');
    const tiers = [1, 2, 3]
      .map(n => ({ name: item[`테두리${n}`], img: item[`테두리${n} 이미지`] }))
      .filter(t => t.name);

    container.innerHTML = tiers.map(t => `
      <div class="frames-tier-card">
        <div class="frames-tier-img">
          ${t.img ? `<img src="${t.img}" alt="${t.name}">` : ''}
        </div>
        <div class="frames-tier-name">${t.name}</div>
      </div>
    `).join('');
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

    framesSpinePlayer = new spine.SpinePlayer('frames-spine-inner', {
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
                  player2.setAnimation('idle', true);
                } catch (err) {
                  console.error('[역대 테두리 L2D] 초기화 실패:', err);
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
                      console.error('[역대 테두리 L2D] idle 애니메이션 복귀 실패:', err);
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
