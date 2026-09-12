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
    wireFramesDrawers();
    wireFramesSearch();
    wireFramesBgm();
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

    // 오른쪽 서랍에도 같은 목록을 세로로 깔아 둔다(뷰어를 보면서 바로 고를 수 있게)
    const drawerList = document.getElementById('f3d-drawer-selector');
    if (drawerList) drawerList.innerHTML = sorted.map(framesItemHtml).join('');

    applyFramesFilter();

    // 다시 그리면 고른 표시가 지워지니 되살린다(정렬만 바꿨을 때 선택이 풀리면 안 된다)
    if (currentFrame) {
      document.querySelectorAll('.frames-item').forEach(el => {
        el.classList.toggle('active', allFramesData[el.dataset.idx] === currentFrame);
      });
    }
  }

  // 보스 이름 · 시즌으로 걸러 낸다. 두 검색창(바둑판 홈 / 오른쪽 서랍)이 같이 움직인다.
  let framesQuery = '';

  function applyFramesFilter() {
    const q = framesQuery.trim().toLowerCase();
    document.querySelectorAll('#f3d-home .frames-item, #f3d-drawer-selector .frames-item').forEach(el => {
      const name = (el.querySelector('.frames-item-boss') || {}).textContent || '';
      const season = (el.querySelector('.frames-item-season') || {}).textContent || '';
      const hit = !q || (name + ' ' + season).toLowerCase().includes(q);
      el.classList.toggle('is-filtered-out', !hit);
    });
    // 속성별 정렬에서는 통째로 비는 열이 생긴다. 그 열도 같이 감춘다.
    document.querySelectorAll('#f3d-home .frames-attr-col').forEach(col => {
      const any = col.querySelector('.frames-item:not(.is-filtered-out)');
      col.classList.toggle('is-filtered-out', !any);
    });
  }

  function wireFramesSearch() {
    ['frames-search', 'frames-search-drawer'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        framesQuery = el.value;
        // 다른 쪽 검색창도 같은 값으로 맞춘다
        ['frames-search', 'frames-search-drawer'].forEach(other => {
          const o = document.getElementById(other);
          if (o && o !== el) o.value = framesQuery;
        });
        applyFramesFilter();
      });
    });
  }

  function toggleFramesAttrSort() {
    framesSortByAttr = !framesSortByAttr;
    document.getElementById('frames-sort-btn').classList.toggle('active', framesSortByAttr);
    renderFramesSelector(allFramesData);
  }

  // 보스 목록과 상세 정보는 평소에 접어 두고 오른쪽 세로 버튼으로 연다.
  // 둘 다 열면 3D 구역이 너무 좁아져서 한 번에 하나만 열리게 한다.
  function wireFramesDrawers() {
    const drawer = document.getElementById('f3d-drawer');
    const panes = {
      'frames-drawer-list': 'f3d-drawer-list',
      'frames-drawer-info': 'f3d-drawer-info',
      'frames-drawer-tiers': 'f3d-drawer-tiers',
      'frames-drawer-bgm': 'f3d-drawer-bgm',
    };
    // 기본은 전부 접힘 — 3D 가 화면을 최대한 넓게 쓴다
    let openId = null;

    function render() {
      Object.entries(panes).forEach(([btnId, paneId]) => {
        const on = btnId === openId;
        const btn = document.getElementById(btnId);
        const pane = document.getElementById(paneId);
        if (btn) btn.setAttribute('aria-expanded', String(on));
        if (pane) pane.classList.toggle('hidden', !on);
      });
      if (drawer) drawer.classList.toggle('hidden', !openId);
      // 서랍을 접으면 재생 중이던 BGM 도 멈춘다 — 화면에서 사라졌는데 소리만 남는다.
      if (openId !== 'frames-drawer-bgm') stopFramesBgm();
    }

    Object.keys(panes).forEach(btnId => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        openId = openId === btnId ? null : btnId;
        render();
      });
    });

    const sideBtn = document.getElementById('f3d-side-toggle');
    if (sideBtn) {
      sideBtn.addEventListener('click', () => {
        const app = document.getElementById('f3d-app');
        const on = app.classList.toggle('side-collapsed');
        sideBtn.setAttribute('aria-expanded', String(!on));
        sideBtn.title = on ? '조작판 펼치기' : '조작판 접기';
      });
    }

    const backBtn = document.getElementById('f3d-back-home');
    if (backBtn) backBtn.addEventListener('click', collapseFrame);

    render();
  }

  // 세로 목록은 오른쪽(모델+테두리) 높이에 맞춰 늘어나는데, 테두리가 적은 보스는 그
  // 높이가 화면 중간에서 끝나 버린다. 최소한 화면 아래까지는 닿게 해서 한 번에 보이는
  // 보스 수를 늘린다. 창 크기가 바뀌면 다시 잰다.
  // 새 배치에서는 서랍이 제 높이를 알아서 채운다. 호출부가 여럿이라 빈 함수로 남긴다.
  function syncFramesSelectorHeight() {}

  window.addEventListener('resize', syncFramesSelectorHeight);

  // 상세를 접고 목록을 원래(가로) 배치로 되돌린다
  function showFramesHome(on) {
    const home = document.getElementById('f3d-home');
    const app = document.getElementById('f3d-app');
    if (home) home.classList.toggle('hidden', !on);
    if (app) app.classList.toggle('hidden', on);
  }

  function collapseFrame() {
    currentFrame = null;
    clearFramesSpine();
    showFramesHome(true);
    
    
    
    // 테두리는 상세 바깥에 있어서 같이 안 지워졌다. 접었는데 방금 본 보스의 테두리만
    // 남아 있으면 무엇에 딸린 건지 알 수 없다.
    document.getElementById('frames-tiers').innerHTML = '';
    renderFramesBgm(null);
    document.querySelectorAll('.frames-item').forEach(el => el.classList.remove('active'));
  }

  function selectFrame(item) {
    // 이미 펼쳐진 보스를 다시 누르면 접는다
    if (currentFrame === item) { collapseFrame(); return; }
    currentFrame = item;
    showFramesHome(false);

    
    // 상세가 열리면 보스 목록을 왼쪽 세로 열로 바꾼다(CSS 가 처리)

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
    renderFramesBgm(item);
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
    const tiersBtn = document.getElementById('frames-tiers-toggle');
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

    // 프레임은 오른쪽 서랍이 담당한다.
  }

  // ===== 전용 BGM =====
  // 표에는 유튜브 주소나 mp3 주소를 넣는다. 페이즈별로 여러 곡이면 [{제목, 링크}] 배열로
  // 넣을 수 있게 해서, 곡이 늘어도 열을 새로 만들지 않아도 되게 한다.
  function bgmEntries(item) {
    const raw = item && item['BGM'];
    if (!raw) return [];

    // 표에 적는 방법은 어느 쪽이든 된다.
    //   주소 하나        https://youtu.be/...
    //   여러 곡          줄바꿈으로 한 줄에 하나
    //   제목을 붙일 때   1페이즈 | https://youtu.be/...
    //   JSON 으로도      [{"제목":"1페이즈","링크":"..."}]
    let list;
    if (Array.isArray(raw)) {
      list = raw;
    } else if (typeof raw === 'string') {
      const text = raw.trim();
      if (text.startsWith('[')) {
        try { list = JSON.parse(text); } catch (err) { list = null; }
      }
      if (!Array.isArray(list)) list = text.split(NEWLINE_RE);
    } else {
      list = [raw];
    }

    return list.map(v => {
      if (v && typeof v === 'object') {
        return { title: v['제목'] || v.title || '', url: v['링크'] || v.url || v['주소'] || '' };
      }
      const text = String(v || '').trim();
      const bar = text.indexOf('|');
      return bar >= 0
        ? { title: text.slice(0, bar).trim(), url: text.slice(bar + 1).trim() }
        : { title: '', url: text };
    }).filter(e => e.url);
  }

  const YOUTUBE_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/;

  function youtubeId(url) {
    const m = String(url).match(YOUTUBE_RE);
    return m ? m[1] : null;
  }

  // ?t=90 / &start=90 / ?t=1m30s 로 적어둔 시작 지점을 초로 바꾼다
  function youtubeStart(url) {
    const m = String(url).match(/[?&](?:t|start)=([0-9hms]+)/i);
    if (!m) return 0;
    const v = m[1];
    if (/^\d+$/.test(v)) return +v;
    const hms = v.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
    return (+(hms[1] || 0)) * 3600 + (+(hms[2] || 0)) * 60 + (+(hms[3] || 0));
  }

  function renderFramesBgm(item) {
    const box = document.getElementById('frames-bgm');
    if (!box) return;
    const list = bgmEntries(item);

    if (!list.length) {
      box.innerHTML = '<div class="frames-bgm-empty">등록된 BGM이 없습니다.</div>';
      return;
    }

    box.innerHTML = list.map((e, i) => {
      const title = escapeHtml(e.title || (list.length > 1 ? `트랙 ${i + 1}` : (item['보스'] || '전용 BGM')));
      const url = escapeHtml(e.url);
      const id = youtubeId(e.url);

      // 유튜브는 서랍을 열자마자 통째로 불러오면 느리다. 표지만 먼저 보여주고
      // 누를 때 iframe 을 끼운다. 표지 그림도 서랍이 접혀 있는 동안은 안 받아오게 둔다.
      if (id) {
        return `<div class="frames-bgm-item">
          <div class="frames-bgm-title">${title}</div>
          <div class="frames-bgm-yt" data-yt="${id}" data-start="${youtubeStart(e.url)}"
               role="button" tabindex="0" aria-label="${title} 재생">
            <img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="" loading="lazy">
            <span class="frames-bgm-play"><i class="fas fa-play"></i></span>
          </div>
          <a class="frames-bgm-link" href="${url}" target="_blank" rel="noopener">유튜브에서 열기</a>
        </div>`;
      }

      return `<div class="frames-bgm-item">
        <div class="frames-bgm-title">${title}</div>
        <audio class="frames-bgm-audio" controls preload="none" src="${url}"></audio>
      </div>`;
    }).join('');
  }

  // 재생 중이던 BGM 을 멈춘다. iframe 을 걷어내면 소리도 같이 끊긴다 —
  // 표지로 되돌려 두면 다시 누르면 그만이다.
  function stopFramesBgm() {
    const box = document.getElementById('frames-bgm');
    if (!box || !box.querySelector('iframe')) return;
    renderFramesBgm(currentFrame);
  }

  // 다른 탭으로 나가면 멈춘다. 안 보이는 곳에서 소리만 계속 나면 어디서 나는지
  // 찾을 수가 없다. 보스를 바꾸거나 목록으로 돌아갈 때는 목록을 다시 그리면서
  // iframe 이 같이 걷히므로 따로 안 건다.
  document.addEventListener('mmr:tab-change', ev => {
    if (!ev.detail || ev.detail.tab !== 'frames') stopFramesBgm();
  });

  // 표지를 누르면 그 자리에서 유튜브로 바꾼다. 목록을 다시 그려도 살아있도록 위임으로 건다.
  function wireFramesBgm() {
    const box = document.getElementById('frames-bgm');
    if (!box) return;
    const open = (cover) => {
      const id = cover.dataset.yt;
      if (!id) return;
      const start = +cover.dataset.start || 0;
      const frame = document.createElement('iframe');
      frame.className = 'frames-bgm-frame';
      frame.src = `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`
        + (start ? `&start=${start}` : '');
      frame.title = cover.getAttribute('aria-label') || 'BGM';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture';
      frame.allowFullscreen = true;
      cover.replaceWith(frame);
    };
    box.addEventListener('click', ev => {
      const cover = ev.target.closest('.frames-bgm-yt');
      if (cover) open(cover);
    });
    box.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const cover = ev.target.closest('.frames-bgm-yt');
      if (!cover) return;
      ev.preventDefault();
      open(cover);
    });
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
    const modelBox = document.getElementById('frames-model-toggle');
    if (modelBox) { modelBox.innerHTML = ''; modelBox.classList.add('hidden'); }
  }

  // "model" 열은 한 줄에 하나씩 "이름,주소" 또는 "주소"만 적는다.
  //
  // 보스에 따라 3D 모델이 여러 파일로 나뉜다 — 애니힐리오는 1페이즈/2페이즈/구체가
  // 각각 별도 glb 로 나온다(한 파일 = 한 페이즈). 이름을 안 적으면 파일명에서 뽑아 쓴다.
  function parseBossModels(raw) {
    if (!raw) return [];
    return String(raw).split(NEWLINE_RE)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const i = line.indexOf(',');
        if (i > 0 && !/^https?:\/\//i.test(line.slice(0, i).trim())) {
          return { name: line.slice(0, i).trim(), url: line.slice(i + 1).trim() };
        }
        // 이름이 없으면 파일명에서 보스 코드를 뗀 부분을 쓴다
        const file = decodeURIComponent(line.split('/').pop() || '').replace(/\.glb$/i, '');
        return { name: file.replace(/^[a-z]{2,4}\d{3}_?/i, '') || file, url: line };
      })
      .filter(m => m.url);
  }

  // 페이즈 번호 순으로 세운다 — DB 에 어떤 순서로 적혀 있든 1페이즈가 먼저 오게.
  // 번호가 없는 항목(구체 등)은 뒤로 보낸다.
  function sortBossModels(models) {
    const num = m => {
      const hit = String(m.name).match(/(\d+)\s*페이즈/) || String(m.url).match(/_(\d+)phase/i);
      return hit ? Number(hit[1]) : 99;
    };
    return models.slice().sort((a, b) => num(a) - num(b));
  }

  // 조작 패널의 각 그룹은 안에 버튼이 있을 때만 보인다.
  function syncCtlGroups() {
    document.querySelectorAll('#frames-controls .frames-ctl-group').forEach(g => {
      const box = g.querySelector('div:last-child');
      g.classList.toggle('is-empty', !box || box.classList.contains('hidden') || !box.children.length);
    });
  }
  window.syncFramesCtlGroups = syncCtlGroups;

  function renderBossModelPicker(models, onPick) {
    const box = document.getElementById('frames-model-toggle');
    if (!box) return;
    if (models.length < 2) {
      box.innerHTML = '';
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = models.map((m, i) =>
      `<button type="button" class="filter-chip frames-model-btn${i === 0 ? ' active' : ''}" data-i="${i}">${escapeHtml(m.name)}</button>`
    ).join('');
    box.querySelectorAll('.frames-model-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        box.querySelectorAll('.frames-model-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onPick(models[+btn.dataset.i]);
      });
    });
  }

  function loadFramesSpine(item) {
    clearFramesSpine();

    const wrap = document.getElementById('frames-spine-player');
    const models = sortBossModels(parseBossModels(item['model']));
    const modelUrl = models.length ? models[0].url : null;
    const skelUrl = item['skel'];
    const atlasUrl = item['atlas'];

    // 3D 모델(glb)이 있으면 우선 사용 — Spine L2D보다 커버리지가 넓다
    if (modelUrl && window.loadFramesModel3D) {
      // 내용이 없는 조작 그룹은 라벨만 남아 허전해 보인다. 자식이 비면 통째로 감춘다.
      requestAnimationFrame(syncCtlGroups);
      renderBossModelPicker(models, m => {
        // 칩 이름을 같이 넘긴다 — 같은 파일을 페이즈별 항목으로 나눠 등록한 보스가
        // 있어서(베히모스 2/3페이즈), 뷰어가 어느 페이즈로 볼지 이 이름으로 정한다.
        window.loadFramesModel3D(wrap, m.url, {
          modelLabel: m.name,
          onError: err => console.error('[보스 3D] 로드 실패:', err),
        });
      });
      window.loadFramesModel3D(wrap, modelUrl, {
        modelLabel: models.length ? models[0].name : '',
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
