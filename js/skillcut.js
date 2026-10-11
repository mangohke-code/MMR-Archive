// ===== 유니크 코스튬 스킬 컷신 (사용자 요청, 2026-10-12) =====
// 코스튬 뷰어 왼쪽 판의 "스킬 컷신" 버튼으로 L2D 모델 대신 그 코스튬의 스킬 컷신을 튼다.
//   전체 재생  : 로비 라이브 월페이퍼 순서 그대로 - 컷신 → 검은 화면 → idle 반복
//   idle 반복  : 전체 재생의 반복 구간만
//   스킬컷 재생: 컷신만 한 번(끝나면 마지막 장면에서 멈춘다)
// 화면은 인게임 카메라 시야로 자른다. 컷신 파일에는 화면 틀이 없고(클리핑 없음), 게임은 카메라
// 시야만큼 보여 준다(추출 세션 조사, 리소스/코스튬/_skillcut_frames.json). 세로 범위는 데이터 값,
// 가로는 기기 화면비라 데이터에 없어서 PC 1:1 · 휴대폰 9:16 둘 중에 고른다.
//
// 재생은 Spine 의 AnimationState 를 쓰지 않고 바깥 타임라인 시각 하나(T)로 직접 포즈를 정한다.
// 인게임에서도 컷신과 idle 은 서로 다른 오브젝트라 화면 범위가 다르고, 점프 마커로 idle 구간을
// 되감는다 - 시각 하나로 계산해야 되감기 · 진행바 탐색이 어긋나지 않는다.

// 코스튬 코드별 데이터. 시각은 바깥 타임라인 기준 초, frame 은 skel 좌표(y 위쪽이 +)의 화면 중심과 세로 반높이.
const SKILLCUT_DATA = {
  // 라피 : 레드 후드 · 레드 플레이버. EventScene_c016_01_cutsceneTimeline
  c016_01: {
    files: { main: 'l2d/c016_01_skillcut/c016_01_skillcut' },
    length: 9.767,
    jump: { at: 9.733, to: 4.667 },           // JumpMarker → DestinationMarker
    cutEnd: 3.667,                            // 컷신 오브젝트가 꺼지는 시각
    clips: [
      // 컷신 오브젝트 안 타임라인이 0.1 초부터 skillcut_0 을 한 번 튼다(그 전은 첫 프레임)
      { file: 'main', anim: 'skillcut_0', start: 0, animStart: 0.1, end: 3.667, loop: false,
        frame: { cx: -20, cy: 755, hh: 762.1 } },
      // 다른 Spine 오브젝트(카메라와의 거리 · 위치가 달라 화면 범위도 다르다)
      { file: 'main', anim: 'idle', start: 4.083, animStart: 4.083, end: 9.767, loop: true,
        frame: { cx: -12, cy: 845, hh: 710.7 } },
    ],
    black: [[3.667, 4.667]],                  // 화면 전체를 덮는 black_bg
  },
};

const SKILLCUT_ASPECTS = { ingame: 1, phone: 9 / 16 };

const CostumeSkillcut = (() => {
  let data = null;          // 지금 코스튬의 SKILLCUT_DATA 항목
  let mode = null;          // 'full' | 'idle' | 'cut' | null(꺼짐)
  let screen = L2D_MOBILE_MQ.matches ? 'phone' : 'ingame';
  let T = 0, paused = false, lastNow = 0;
  let player = null, playerFile = null, loading = false;
  let layer, box, holder, black, resizeObs;

  const el = id => document.getElementById(id);

  // 모드마다 시각의 범위. 진행바 · 처음부터 버튼은 이 범위를 쓴다.
  function range() {
    if (mode === 'idle') return [data.jump.to, data.jump.at];
    if (mode === 'cut') return [0, data.cutEnd];
    return [0, data.jump ? data.jump.at : data.length];
  }

  // 진행바(setupL2dBar)가 보는 "플레이어" - 바깥 타임라인 시각을 트랙 시간처럼 보여 준다
  const adapter = {
    get paused() { return paused; },
    play() {
      // 스킬컷 재생이 끝나 멈췄으면 처음부터 다시
      if (mode === 'cut' && T >= data.cutEnd - 1e-4) T = 0;
      paused = false;
    },
    pause() { paused = true; },
    animationState: {
      tracks: [{
        animation: { get duration() { const [a, b] = range(); return b - a; } },
        get trackTime() { return T - range()[0]; },
        set trackTime(v) { const [a, b] = range(); T = Math.max(a, Math.min(b - 1e-4, a + v)); },
      }],
    },
  };

  function ensureDom() {
    if (layer) return;
    layer = el('costume-skillcut-layer');
    box = layer.querySelector('.skillcut-box');
    holder = layer.querySelector('.skillcut-player');
    black = layer.querySelector('.skillcut-black');
    // 그림 칸에서 쓰는 끌기 · 휠 확대는 숨어 있는 L2D 모델을 움직인다. 컷신 위에서는 막는다.
    ['wheel', 'mousedown', 'touchstart', 'pointerdown', 'dblclick'].forEach(type =>
      layer.addEventListener(type, e => e.stopPropagation(), { passive: true }));
    resizeObs = new ResizeObserver(fitBox);
    resizeObs.observe(layer);
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

  function frameViewport(f) {
    const a = SKILLCUT_ASPECTS[screen], hw = f.hh * a;
    return { x: f.cx - hw, y: f.cy - f.hh, width: hw * 2, height: f.hh * 2, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 };
  }

  // 시각 T 에 보이는 클립(겹치면 나중에 시작한 것)
  function clipAt(t) {
    let hit = null;
    for (const c of data.clips) if (t >= c.start && t < c.end) hit = c;
    return hit;
  }

  // 매 프레임 spine 플레이어가 부른다(그리기 직전)
  function onFrame(p, delta) {
    if (!mode || !data || p !== player) return;
    // 시간은 따로 잰다. 플레이어 자체가 멈춰도(다른 곳에서 pause) 컷신 시계는 우리 버튼만 따른다.
    const now = performance.now();
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    if (!paused) {
      T += dt;
      if (mode === 'cut') {
        if (T >= data.cutEnd) { T = data.cutEnd - 1e-4; paused = true; }
      } else if (data.jump && T >= data.jump.at) {
        T = data.jump.to + (T - data.jump.at);
      }
    }
    const c = clipAt(T);
    const sk = p.skeleton;
    sk.setToSetupPose();
    if (c) {
      const anim = sk.data.findAnimation(c.anim);
      if (anim) {
        let t = Math.max(0, T - c.animStart);
        t = c.loop ? (anim.duration ? t % anim.duration : 0) : Math.min(t, anim.duration);
        anim.apply(sk, t, t, c.loop, null, 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
      }
      const vp = frameViewport(c.frame);
      p.currentViewport = vp;
      p.previousViewport = null;
    }
    sk.updateWorldTransform();
    holder.style.visibility = c ? 'visible' : 'hidden';
    black.style.display = (data.black || []).some(([a, b]) => T >= a && T < b) ? 'block' : 'none';
  }

  function loadPlayer() {
    const file = data.clips[0].file;
    if (player && playerFile === data.files[file]) return;
    disposePlayer();
    loading = true;
    playerFile = data.files[file];
    holder.innerHTML = '<div id="costume-skillcut-canvas" style="position:absolute;inset:0"></div>';
    const vp = frameViewport(data.clips[0].frame);
    new spine.SpinePlayer('costume-skillcut-canvas', {
      skelUrl: playerFile + '.skel',
      atlasUrl: playerFile + '.atlas',
      backgroundColor: '#00000000',
      showControls: false,
      preserveDrawingBuffer: false,
      viewport: { ...vp, transitionTime: 0 },
      frame: onFrame,
      success: p => {
        loading = false;
        if (playerFile !== p.config.skelUrl.replace(/\.skel$/, '')) { disposeSpinePlayer(p); return; }
        player = p;
        try { p.animationState.clearTracks(); } catch (e) { /* 트랙이 없으면 그대로 */ }
        p.play();
      },
      error: () => { loading = false; },
    });
  }

  function disposePlayer() {
    if (player) { try { disposeSpinePlayer(player); } catch (e) { /* 이미 정리됨 */ } }
    player = null; playerFile = null;
    if (holder) holder.innerHTML = '';
  }

  function syncButtons() {
    document.querySelectorAll('#costume-skillcut [data-sc-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.scMode === mode));
    document.querySelectorAll('#costume-skillcut [data-sc-screen]').forEach(b =>
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

  function start(m) {
    if (!data) return;
    ensureDom();
    if (mode === m) { stop(); return; }   // 켜진 버튼을 다시 누르면 모델로 돌아간다
    mode = m;
    T = m === 'idle' ? data.jump.to : 0;
    paused = false;
    lastNow = 0;
    layer.classList.remove('hidden');
    setModelHidden(true);
    fitBox();
    loadPlayer();
    syncButtons();
  }

  function stop() {
    if (!mode) return;
    mode = null;
    if (layer) layer.classList.add('hidden');
    disposePlayer();
    setModelHidden(false);
    syncButtons();
  }

  // 코스튬을 고를 때마다 부른다. 컷신 데이터가 있는 코스튬만 버튼이 보인다.
  function show(costume) {
    stop();
    const code = costume && costume['코드'];
    data = (code && SKILLCUT_DATA[code]) || null;
    const panel = el('costume-skillcut');
    if (!panel) return;
    if (!data) { panel.innerHTML = ''; panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="skillcut-btns">
        <button type="button" class="anim-btn" data-sc-mode="full">전체 재생</button>
        <button type="button" class="anim-btn" data-sc-mode="idle">idle 반복</button>
        <button type="button" class="anim-btn" data-sc-mode="cut">스킬컷 재생</button>
      </div>
      <div class="skillcut-screen">
        <span>화면</span>
        <button type="button" class="anim-btn" data-sc-screen="ingame">인게임 카메라</button>
        <button type="button" class="anim-btn" data-sc-screen="phone">휴대폰</button>
      </div>`;
    panel.querySelectorAll('[data-sc-mode]').forEach(b => b.addEventListener('click', () => start(b.dataset.scMode)));
    panel.querySelectorAll('[data-sc-screen]').forEach(b => b.addEventListener('click', () => {
      screen = b.dataset.scScreen;
      syncButtons();
      fitBox();
    }));
    syncButtons();
  }

  return {
    show,
    stop,
    isActive: () => !!mode,
    adapter,
    get player() { return player; },   // 점검용
  };
})();
