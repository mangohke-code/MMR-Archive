// ===== 유니크 코스튬 스킬 컷신 (사용자 요청, 2026-10-12) =====
// 코스튬 뷰어 왼쪽 판 맨 위의 [기본 L2D | 스킬 컷신] 으로 둘을 오간다. 둘은 완전히 나뉘어 있어서
// 기본 L2D 상태에는 L2D 조작(모델 · 동작 · 표정 · 파츠)만, 스킬 컷신 상태에는 아래 컷신 조작만 보인다.
// 스킬 컷신으로 넘어가면 idle 반복부터 보여 준다.
//   전체 재생  : 로비 라이브 월페이퍼 순서 그대로 - 컷신 → 검은 화면 → idle 반복
//   스킬컷 재생: 컷신만 한 번, 끝나면 바로 idle 반복으로 넘어간다
//   idle 반복  : 전체 재생의 반복 구간만
// 재생 버튼은 누를 때마다 처음부터 다시 튼다(켜고 끄는 단추가 아니다).
//
// 데이터: l2d/skillcut/<코드>/play.json (tools/build_skillcut.py 가 추출 세션의 _skillcut_playback.json 에서 만든다).
// 인게임 라이브 월페이퍼는 Spine 오브젝트 여러 개 · 배경 그림 · 검은 판을 원근 카메라 하나로 비춘다.
// 오브젝트마다 카메라와의 거리가 달라서 skel 좌표로 본 화면 범위(중심 cx·cy, 세로 반높이 hh)가 저마다 다르고,
// 15개는 그 범위가 시간에 따라 움직인다(30fps 표본). 그래서 Spine 플레이어(뼈대 하나 · 화면 하나)를 쓰지 않고
// 캔버스 하나에 오브젝트마다 카메라를 바꿔 가며 직접 그린다. 가로 범위는 기기 화면비라 데이터에 없어서
// PC 1:1(인게임 카메라) · 휴대폰 9:16 둘 중에 고른다.
//
// 재생은 AnimationState 를 쓰지 않고 바깥 타임라인 시각 하나(T)로 모든 포즈 · 위치 · 색을 정한다.
// 점프 마커로 idle 구간을 되감고, 진행바로 아무 시각이나 골라도 어긋나지 않는다.
// 못 그리는 것: 파티클 · 셰이더로 움직이는 화면 전환(그림 · 값이 데이터에 없다).

const SKILLCUT_BASE = 'l2d/skillcut/';
const SKILLCUT_ASPECTS = { ingame: 1, phone: 9 / 16 };

const CostumeSkillcut = (() => {
  let index = null;         // 컷신이 있는 코드 목록(index.json)
  let code = null;          // 지금 코스튬 코드(컷신이 있을 때만)
  let data = null;          // 그 코드의 play.json
  let mode = null;          // 'full' | 'idle' | 'cut' | null(꺼짐)
  let screen = L2D_MOBILE_MQ.matches ? 'phone' : 'ingame';
  let T = 0, paused = false, lastNow = 0, raf = 0, loadSeq = 0;
  let layer, box, msg, resizeObs;
  let gl = null;            // { canvas, ctx, renderer, assets, ready, skels: [], tex: {} }
  const playCache = {};

  const el = id => document.getElementById(id);

  // ---- 시간 ----
  // 모드마다 시각의 범위. 진행바 · 처음부터 버튼은 이 범위를 쓴다.
  function range() {
    if (!data) return [0, 1];
    if (mode === 'idle' && data.jump) return [data.jump.to, data.jump.at];
    if (mode === 'cut') return [0, data.cutEnd];
    return [0, data.jump ? data.jump.at : data.length];
  }

  // 진행바(setupL2dBar)가 보는 "플레이어" - 바깥 타임라인 시각을 트랙 시간처럼 보여 준다
  const adapter = {
    get paused() { return paused; },
    play() { paused = false; },
    pause() { paused = true; },
    animationState: {
      tracks: [{
        animation: { get duration() { const [a, b] = range(); return b - a; } },
        get trackTime() { return T - range()[0]; },
        set trackTime(v) { const [a, b] = range(); T = Math.max(a, Math.min(b - 1e-4, a + v)); },
      }],
    },
  };

  function advance(dt) {
    if (paused || !data) return;
    T += dt;
    if (mode === 'cut') {
      // 컷신이 끝나면 바로 idle 반복으로(검은 화면 없이)
      if (T >= data.cutEnd) {
        if (data.jump) { mode = 'idle'; T = data.jump.to; syncButtons(); } else { T = data.cutEnd - 1e-4; paused = true; }
      }
    } else if (data.jump && T >= data.jump.at) {
      T = data.jump.to + (T - data.jump.at);
    } else if (!data.jump && T >= data.length) {
      T = data.length - 1e-4; paused = true;
    }
  }

  const activeAt = (iv, t) => iv.some(([a, b]) => t >= a && t < b);

  // [t, 값...] 줄들에서 시각 t 의 값. 기록은 30fps 표본이거나 "바뀔 때만" 이라,
  // 바로 다음 표본(한 프레임 거리)이면 선형으로 잇고, 멀면 앞 값을 그대로 둔다.
  function sample(rows, t) {
    if (rows.length === 1 || t <= rows[0][0]) return rows[0];
    let lo = 0, hi = rows.length - 1;
    if (t >= rows[hi][0]) return rows[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][0] <= t) lo = m; else hi = m; }
    const a = rows[lo], b = rows[hi], gap = b[0] - a[0];
    if (gap > 0.05) return a;
    const k = (t - a[0]) / gap;
    return a.map((v, i) => (i === 0 ? t : v + (b[i] - v) * k));
  }

  function frameAt(sp, t) {
    const f = sp.frame;
    if (!f.samples) return f;
    const s = sample(f.samples, t);
    return { cx: s[1], cy: s[2], hh: s[3] };
  }

  // 그 오브젝트의 포즈를 시각 t 로 맞춘다. 재생 구간 밖이면 가까운 구간의 처음/끝을 붙든다.
  function poseSpine(o, t) {
    const plays = o.sp.plays;
    let p = null;
    for (const q of plays) if (t >= q.vs && t < q.ve) p = q;
    let tt = t;
    if (!p) {
      const before = plays.filter(q => q.vs <= t);
      p = before.length ? before[before.length - 1] : plays[0];
      tt = Math.min(Math.max(t, p.vs), p.ve);
    }
    const sk = o.skeleton;
    sk.setToSetupPose();
    const anim = o.anims[p.anim] || (o.anims[p.anim] = sk.data.findAnimation(p.anim));
    if (anim) {
      let at = p.clipIn + (tt - p.start) * p.ts;
      at = p.loop ? (anim.duration ? ((at % anim.duration) + anim.duration) % anim.duration : 0)
        : Math.max(0, Math.min(at, anim.duration));
      anim.apply(sk, at, at, p.loop, null, 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    }
    sk.updateWorldTransform();
  }

  // ---- 그리기 ----
  function draw() {
    const g = gl;
    const W = box.clientWidth, H = box.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(W * dpr)), ch = Math.max(1, Math.round(H * dpr));
    if (g.canvas.width !== cw || g.canvas.height !== ch) { g.canvas.width = cw; g.canvas.height = ch; }
    const c = g.ctx.gl;
    c.viewport(0, 0, cw, ch);
    c.clearColor(0, 0, 0, 1);
    c.clear(c.COLOR_BUFFER_BIT);

    const a = SKILLCUT_ASPECTS[screen];
    const items = [];
    g.skels.forEach((o, i) => {
      if (activeAt(o.sp.active, T)) items.push({ o, layer: o.sp.layer, order: o.sp.order, z: o.sp.z, i });
    });
    data.elements.forEach((e, i) => {
      if (!activeAt(e.active, T) || !g.tex[e.tex]) return;
      const col = sample(e.color, T);
      if (col[4] <= 0.002) return;
      // 같은 레이어 · 순서면 Spine 보다 뒤(배경 판들이 여기에 걸린다)
      items.push({ e, col, layer: e.layer, order: e.order, z: Infinity, i: 1000 + i });
    });
    // 유니티 규칙: 정렬 레이어 → 정렬 순서 → 같으면 카메라에서 먼 것부터
    items.sort((p, q) => p.layer - q.layer || p.order - q.order || q.z - p.z || p.i - q.i);

    const r = g.renderer, cam = r.camera;
    for (const it of items) {
      if (it.o) {
        poseSpine(it.o, T);
        const f = frameAt(it.o.sp, T);
        cam.setViewport(2 * f.hh * a, 2 * f.hh);
        cam.position.set(f.cx, f.cy, 0);
        cam.zoom = 1;
        r.begin();
        r.drawSkeleton(it.o.skeleton, true);
        r.end();
      } else {
        // 요소 화면 사각형: y 는 -1~1 이 화면 아래~위, x 도 같은 단위
        const rc = sample(it.e.rect, T);
        cam.setViewport(2 * a, 2);
        cam.position.set(0, 0, 0);
        cam.zoom = 1;
        r.begin();
        r.batcher.setBlendMode(spine.BlendMode.Normal, false);
        r.drawTexture(g.tex[it.e.tex], rc[1], rc[3], rc[2] - rc[1], rc[4] - rc[3],
          new spine.Color(it.col[1], it.col[2], it.col[3], it.col[4]));
        r.end();
      }
    }
  }

  function loop() {
    raf = 0;
    if (!mode || !gl) return;
    const now = performance.now();
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    if (!gl.ready) {
      if (gl.assets.isLoadingComplete()) setupSkeletons();
      else if (gl.assets.hasErrors()) { showMsg('컷신 파일을 불러오지 못했습니다.'); return; }
    }
    if (gl.ready) {
      advance(dt);
      try { draw(); } catch (err) { console.error('[스킬 컷신]', err); showMsg('컷신을 그리지 못했습니다.'); return; }
    }
    raf = requestAnimationFrame(loop);
  }

  function setupSkeletons() {
    const g = gl, base = SKILLCUT_BASE + code + '/';
    const datas = {};
    for (const f of usedFiles()) {
      const atlas = g.assets.require(base + f + '.atlas');
      const bin = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas));
      datas[f] = bin.readSkeletonData(g.assets.require(base + f + '.skel'));
    }
    g.skels = data.spines.map(sp => ({ sp, skeleton: new spine.Skeleton(datas[sp.file]), anims: {} }));
    data.elements.forEach(e => { g.tex[e.tex] = g.assets.require(base + e.tex); });
    g.ready = true;
    showMsg('');
  }

  const usedFiles = () => [...new Set(data.spines.map(s => s.file))];

  function createGL() {
    const canvas = document.createElement('canvas');
    canvas.className = 'skillcut-canvas';
    box.prepend(canvas);
    const ctx = new spine.ManagedWebGLRenderingContext(canvas, { alpha: false, premultipliedAlpha: true, antialias: true });
    const renderer = new spine.SceneRenderer(canvas, ctx, true);
    const assets = new spine.AssetManager(ctx);
    const base = SKILLCUT_BASE + code + '/';
    for (const f of usedFiles()) {
      assets.loadBinary(base + f + '.skel');
      assets.loadTextureAtlas(base + f + '.atlas');
    }
    [...new Set(data.elements.map(e => e.tex))].forEach(t => assets.loadTexture(base + t));
    gl = { canvas, ctx, renderer, assets, ready: false, skels: [], tex: {} };
  }

  function disposeGL() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!gl) return;
    const g = gl;
    gl = null;
    try { g.assets.dispose(); } catch (e) { /* 이미 정리됨 */ }
    try { g.renderer.dispose(); } catch (e) { /* 이미 정리됨 */ }
    // GPU 메모리를 바로 돌려준다(코스튬을 오가면 컨텍스트가 쌓인다)
    try { const lose = g.ctx.gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) { /* 지원 안 함 */ }
    g.canvas.remove();
  }

  // ---- 화면 ----
  function ensureDom() {
    if (layer) return;
    layer = el('costume-skillcut-layer');
    box = layer.querySelector('.skillcut-box');
    msg = layer.querySelector('.skillcut-msg');
    // 그림 칸에서 쓰는 끌기 · 휠 확대는 숨어 있는 L2D 모델을 움직인다. 컷신 위에서는 막는다.
    ['wheel', 'mousedown', 'touchstart', 'pointerdown', 'dblclick'].forEach(type =>
      layer.addEventListener(type, e => e.stopPropagation(), { passive: true }));
    resizeObs = new ResizeObserver(fitBox);
    resizeObs.observe(layer);
  }

  function showMsg(text) {
    if (!msg) return;
    msg.textContent = text;
    msg.classList.toggle('hidden', !text);
  }

  // 그림 칸 안에 화면비를 지킨 상자를 가운데 놓는다. 아래 진행바 자리는 비워 둔다.
  function fitBox() {
    if (!layer || layer.classList.contains('hidden')) return;
    const bar = el('costume-bar');
    layer.style.bottom = (bar ? bar.offsetHeight : 0) + 'px';
    const W = layer.clientWidth, H = layer.clientHeight, a = SKILLCUT_ASPECTS[screen];
    const h = Math.max(0, Math.min(H - 16, (W - 16) / a));
    box.style.width = Math.round(h * a) + 'px';
    box.style.height = Math.round(h) + 'px';
  }

  // 판 맨 위 전환 줄과 고른 쪽 조작만 보이게 한다(기본 L2D 상태에는 L2D 조작만, 컷신 상태에는 컷신 조작만)
  function syncButtons() {
    const on = !!mode;
    document.querySelectorAll('#costume-view-switch [data-sc-view]').forEach(b =>
      b.classList.toggle('active', (b.dataset.scView === 'skillcut') === on));
    const l2d = el('costume-l2d-controls'), sc = el('costume-skillcut-controls');
    if (l2d) l2d.classList.toggle('hidden', on);
    if (sc) sc.classList.toggle('hidden', !on);
    const wrap = el('costume-spine-wrap');
    if (wrap) wrap.classList.toggle('is-skillcut', on);
    document.querySelectorAll('#costume-skillcut-controls [data-sc-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.scMode === mode));
    document.querySelectorAll('#costume-skillcut-controls [data-sc-screen]').forEach(b =>
      b.classList.toggle('active', b.dataset.scScreen === screen));
  }

  // 모델 쪽 L2D 를 감추고 멈춘다(컷신이 그 자리를 덮는다)
  function setModelHidden(hidden) {
    const wrap = el('costume-spine-player');
    if (wrap) wrap.style.visibility = hidden ? 'hidden' : '';
    // activeSpinePlayers: costume.js 의 지금 떠 있는 모델 플레이어들(본체 + 추가 파츠)
    if (typeof activeSpinePlayers !== 'undefined') {
      activeSpinePlayers.forEach(p => { try { hidden ? p.pause() : p.play(); } catch (e) { /* 정리 중 */ } });
    }
  }

  async function loadPlay(c) {
    if (!playCache[c]) {
      playCache[c] = fetch(SKILLCUT_BASE + c + '/play.json').then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      });
      playCache[c].catch(() => { delete playCache[c]; });
    }
    return playCache[c];
  }

  async function start(m) {
    if (!code) return;
    ensureDom();
    const seq = ++loadSeq;
    mode = m;
    paused = false;
    lastNow = 0;
    layer.classList.remove('hidden');
    setModelHidden(true);
    fitBox();
    syncButtons();
    if (!data || data.code !== code) {
      disposeGL();
      showMsg('불러오는 중…');
      try { data = await loadPlay(code); } catch (e) { if (seq === loadSeq) showMsg('컷신 정보를 불러오지 못했습니다.'); return; }
      if (seq !== loadSeq || !mode) return;   // 그사이 끄거나 다른 버튼을 눌렀다
    }
    T = m === 'idle' && data.jump ? data.jump.to : 0;
    if (!gl) { showMsg('불러오는 중…'); createGL(); }
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function stop() {
    loadSeq++;
    if (!mode) return;
    mode = null;
    if (layer) layer.classList.add('hidden');
    disposeGL();
    showMsg('');
    setModelHidden(false);
    syncButtons();
  }

  // 컷신 조작 버튼은 index.html 에 고정으로 있다. 한 번만 연결한다.
  let wired = false;
  function wireControls() {
    if (wired) return;
    const sc = el('costume-skillcut-controls');
    if (!sc) return;
    wired = true;
    sc.querySelectorAll('[data-sc-mode]').forEach(b => b.addEventListener('click', () => start(b.dataset.scMode)));
    sc.querySelectorAll('[data-sc-screen]').forEach(b => b.addEventListener('click', () => {
      screen = b.dataset.scScreen;
      syncButtons();
      fitBox();
    }));
  }

  // 전환 줄: 컷신이 있는 코스튬만 보인다. 스킬 컷신으로 넘어가면 idle 반복부터 보여 준다.
  function renderPanel() {
    const sw = el('costume-view-switch');
    if (!sw) return;
    if (!code) { sw.innerHTML = ''; sw.classList.add('hidden'); syncButtons(); return; }
    sw.classList.remove('hidden');
    sw.innerHTML = `
      <button type="button" class="anim-btn" data-sc-view="l2d">기본 L2D</button>
      <button type="button" class="anim-btn" data-sc-view="skillcut">스킬 컷신</button>`;
    sw.querySelector('[data-sc-view="l2d"]').addEventListener('click', () => stop());
    sw.querySelector('[data-sc-view="skillcut"]').addEventListener('click', () => { if (!mode) start('idle'); });
    syncButtons();
  }

  // 코스튬을 고를 때마다 부른다. 컷신이 있는 코스튬만 버튼이 보인다.
  function show(costume) {
    stop();
    wireControls();
    const c = costume && costume['코드'];
    if (!index) {
      // 목록을 처음 한 번 받아 온다. 받는 동안 고른 코스튬이 바뀌었으면 마지막 것으로 다시 그린다.
      code = null;
      renderPanel();
      fetch(SKILLCUT_BASE + 'index.json').then(r => (r.ok ? r.json() : []))
        .catch(() => [])
        .then(list => {
          index = new Set(list);
          const cur = typeof currentCostume !== 'undefined' && currentCostume ? currentCostume['코드'] : c;
          code = cur && index.has(cur) ? cur : null;
          renderPanel();
        });
      return;
    }
    code = c && index.has(c) ? c : null;
    if (data && data.code !== code) data = null;
    renderPanel();
  }

  // 점검용: 시각 t 로 멈추고 한 장 그려 이미지로 돌려준다(그린 직후라 캔버스를 읽을 수 있다)
  function snapshot(t) {
    if (!gl || !gl.ready) return null;
    paused = true;
    T = t;
    draw();
    return gl.canvas.toDataURL('image/jpeg', 0.8);
  }

  return {
    show,
    stop,
    isActive: () => !!mode,
    isReady: () => !!(gl && gl.ready),
    adapter,
    snapshot,
  };
})();
