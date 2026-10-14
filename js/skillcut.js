// ===== 유니크 코스튬 스킬 컷신 (사용자 요청, 2026-10-12) =====
// 코스튬 뷰어 왼쪽 판 맨 위의 [기본 L2D | 스킬 컷신] 으로 둘을 오간다. 둘은 완전히 나뉘어 있어서
// 기본 L2D 상태에는 L2D 조작(모델 · 동작 · 표정 · 파츠)만, 스킬 컷신 상태에는 아래 컷신 조작만 보인다.
// 스킬 컷신으로 넘어가면 idle 반복부터 보여 준다.
//   전체 재생  : 로비 라이브 월페이퍼 순서 그대로 - 컷신 → 검은 화면 → idle 반복(끝나면 idle 반복 버튼으로 넘어간다)
//   스킬컷 재생: 컷신만 한 번, 끝나면 바로 idle 반복으로 넘어간다
//   idle 반복  : 전체 재생의 반복 구간만
// 재생 버튼은 누를 때마다 처음부터 다시 튼다(켜고 끄는 단추가 아니다).
//
// 데이터: l2d/<코드>/skillcut/play.json.gz (tools/build_skillcut.py 가 추출 세션의 _skillcut_playback.json 에서 만든다).
// 인게임 라이브 월페이퍼는 Spine 오브젝트 여러 개 · 배경 그림 · 검은 판을 원근 카메라 하나로 비춘다.
// 오브젝트마다 카메라와의 거리가 달라서 skel 좌표로 본 화면 범위(중심 cx·cy, 세로 반높이 hh)가 저마다 다르고,
// 15개는 그 범위가 시간에 따라 움직인다(30fps 표본). 그래서 Spine 플레이어(뼈대 하나 · 화면 하나)를 쓰지 않고
// 캔버스 하나에 오브젝트마다 카메라를 바꿔 가며 직접 그린다. 가로 범위는 기기 화면비라 데이터에 없어서
// PC 는 1:1(인게임 카메라), 휴대폰 화면(L2D_MOBILE_MQ)에서는 저절로 9:16 으로 그린다.
//
// 재생은 AnimationState 를 쓰지 않고 바깥 타임라인 시각 하나(T)로 모든 포즈 · 위치 · 색을 정한다.
// 점프 마커로 idle 구간을 되감고, 진행바로 아무 시각이나 골라도 어긋나지 않는다.
// 배경 그림 · 검은 판 · 파티클(요소)은 추출 세션이 엔진에서 GPU 로 읽은 정점 셰이더 입력을 30fps 로 그대로 쓰고,
// 게임 셰이더 7종을 디스어셈블한 계산 그대로 그린다(아래 FX_FS). 안개는 비율 1(사용자 결정), 후처리는 넣지 않는다.

// 컷신 데이터 판(빌드할 때마다 올린다). play.json · 목록 · 요소 그림 주소에 붙여서, 새 JS 가 캐시된 옛 데이터를 읽지 않게 한다.
const SKILLCUT_DATA_VER = '?d=13';
const SKILLCUT_INDEX = 'l2d/skillcut.json' + SKILLCUT_DATA_VER;
const skillcutBase = c => 'l2d/' + c + '/skillcut/';
// 요소 텍스처 공용 폴더(코스튬끼리 같은 그림을 같이 써서 한 벌만 둔다)
const SKILLCUT_EL = 'l2d/skillcut-el/';

// 재생 데이터는 미리 gzip 으로 압축해 저장한다(저장 용량 약 1/4, 받는 양은 같음). 받은 바이트가 gzip(1f 8b)이면 풀고,
// 서버가 이미 풀어서 보냈으면 그대로 읽는다.
async function fetchGzJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 압축 풀기를 지원하지 않습니다');
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(ds).text());
  }
  return JSON.parse(new TextDecoder().decode(buf));
}
// 화면비(가로/세로): 휴대폰 화면이면 9:16, 아니면 인게임 카메라 1:1. 그릴 때마다 지금 화면 기준으로 정한다.
const skillcutAspect = () => (L2D_MOBILE_MQ.matches ? 9 / 16 : 1);

const CostumeSkillcut = (() => {
  let index = null;         // 컷신이 있는 코드 목록(index.json)
  let code = null;          // 지금 코스튬 코드(컷신이 있을 때만)
  let data = null;          // 그 코드의 play.json
  let mode = null;          // 'full' | 'idle' | 'cut' | null(꺼짐)
  let T = 0, paused = false, lastNow = 0, raf = 0, loadSeq = 0, lap = 0;
  // 셰이더 흐름 시간(_TimeParameters.x): 게임은 앱을 켠 뒤 계속 흐르는 시간이라 되감기와 상관없이 이어진다.
  // 위상은 데이터로 알 수 없어 재생을 시작한 시각에서 출발해 재생하는 동안 계속 흐르게 한다(되감아도 돌아가지 않는다).
  let flowT = 0;
  let forceSize = null;       // 점검용 render() 가 정한 캔버스 크기(px)
  let drawFilter = null;      // 점검용 render() 가 고른 드로우만 그린다(ref → true/false)
  // 확대 · 이동(사용자 요청, 2026-10-13). zoom 1 = 기본 화면(이보다 작게는 못 줄인다), pan = 화면 가운데가 가리키는 곳(NDC -1~1)
  const ZOOM_MAX = 6;
  let zoom = 1, panX = 0, panY = 0;
  let layer, box, msg, resizeObs;
  let gl = null;            // { canvas, ctx, renderer, assets, ready, skels: [], tex: {} }
  const playCache = {};
  // 빛 효과(가산 블렌드 셰이더로 그리는 요소) 표시 - 고른 쪽을 기억한다(사용자 요청, 2026-10-13)
  const LIGHT_KEY = 'mmr-skillcut-light';
  const LIGHT_SHADERS = new Set(['add', 'uvadd', 'fresnel']);
  let showLight = (() => { try { return localStorage.getItem(LIGHT_KEY) !== '0'; } catch (e) { return true; } })();
  // 화면 덮개: 게임 정렬 레이어 ScreenFx(값 4)에 있는 요소(34개 모두 시작 · 전환 페이드 fx_blend_(plane_)white · fx_white_transition 과 끝 암전 black_bg. 이름과 달리 색은 코스튬마다 검정 · 회색 등). 기본 켬
  const COVER_KEY = 'mmr-skillcut-cover';
  let showCover = (() => { try { return localStorage.getItem(COVER_KEY) !== '0'; } catch (e) { return true; } })();
  // 캐릭터만: 요소(이펙트)를 전부 숨기고 Spine 만 그린다. 기본 끔
  const CHAR_KEY = 'mmr-skillcut-charonly';
  let charOnly = (() => { try { return localStorage.getItem(CHAR_KEY) === '1'; } catch (e) { return false; } })();

  const el = id => document.getElementById(id);

  // ---- 시간 ----
  // 모드마다 시각의 범위. 진행바 · 처음부터 버튼은 이 범위를 쓴다.
  // 게임(30fps)은 점프 마커 시각의 프레임을 그린 다음 프레임을 정확히 jump.to 로 그린다. 그래서 한 바퀴는 jump.at 다음 한 프레임까지다.
  const FRAME = 1 / 30;
  const loopEnd = () => data.jump.at + FRAME;
  function range() {
    if (!data) return [0, 1];
    if (mode === 'idle' && data.jump) return [data.jump.to, loopEnd()];
    if (mode === 'cut') return [0, data.cutEnd];
    return [0, data.jump ? loopEnd() : data.length];
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
    flowT += dt;
    if (mode === 'cut') {
      // 컷신이 끝나면 바로 idle 반복으로(검은 화면 없이)
      if (T >= data.cutEnd) {
        if (data.jump) { mode = 'idle'; lap = 0; T = data.jump.to; syncButtons(); } else { T = data.cutEnd - 1e-4; paused = true; }
      }
    } else if (data.jump && T >= loopEnd()) {
      // 전체 재생도 반복 구간에 들어서면 idle 반복으로 넘어간다
      T = data.jump.to + (T - loopEnd());
      // 반복 구간은 되감을 때마다 다음 바퀴. 전체 재생에서 넘어오면 첫 바퀴.
      // 바퀴별 데이터(laps.json)를 아직 못 받았으면 첫 바퀴에 머문다(받는 순간 바퀴가 갑자기 바뀌지 않게)
      if (mode === 'full') { mode = 'idle'; lap = 0; syncButtons(); } else if (!data.lapsFile || data.lapsLoaded) nextLap();
    } else if (!data.jump && T >= data.length) {
      T = data.length - 1e-4; paused = true;
    }
  }

  // 켜짐 구간. 시각은 소수 셋째 자리로 적혀 있어 경계에 0.5ms 여유를 둔다(반복 시작 jump.to 가 4.666667 이면 4.667 구간도 켜짐)
  const activeAt = (iv, t) => iv.some(([a, b]) => t >= a - 5e-4 && t < b);

  // 반복 구간 데이터: idle 반복(점프로 되감은 뒤)이면 추출 세션이 되감기 3바퀴 뒤에 기록한 한 바퀴를 쓴다.
  // 자동 재생 파티클이 되감기와 상관없이 이어져서 반복할 때 이펙트가 끊기지 않는다. 처음 재생은 원래 데이터.
  const looped = () => mode === 'idle' && !!(data && ((data.orderLoop && data.orderLoop.length) || data.orderLoops));
  // 지금 바퀴(되감을 때마다 하나씩). 바퀴별 데이터(laps.json)를 받기 전에는 첫 바퀴
  const lapIndex = () => (data.laps > 1 && (!data.lapsFile || data.lapsLoaded) ? Math.min(lap, data.laps - 1) : 0);
  // 다음 바퀴. 마지막 바퀴 뒤에는 cycleFrom(주기가 시작되는 바퀴, 없으면 0)으로 돌아간다
  function nextLap() {
    lap = lap + 1 < (data.laps || 1) ? lap + 1 : (data.cycleFrom || 0);
  }
  const pick = (laps, one, li) => (laps ? laps[li] || laps[0] : one);
  // "바뀐 시각만" 줄에서 시각 t 의 값. 반복 구간은 첫 줄이 jump.to 보다 조금 늦게 적혀 있어(반올림) 그 앞은 첫 줄로 본다
  const holdIn = (rows, t, loop) => (loop && rows.length && t < rows[0][0] ? rows[0] : hold(rows, t));

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

  // "바뀐 시각만" 적힌 줄에서 시각 t 의 값(사이는 앞 값 그대로). 파티클은 입자 수가 바뀌어 잇지 않는다.
  // 시각은 소수 셋째 자리로 반올림돼 있어(0.2667 → 0.267) 그 프레임을 0.5ms 일찍부터 잡는다
  function hold(rows, t) {
    t += 5e-4;
    if (!rows || !rows.length || t < rows[0][0]) return null;
    let lo = 0, hi = rows.length - 1;
    if (t >= rows[hi][0]) return rows[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][0] <= t) lo = m; else hi = m; }
    return rows[lo];
  }

  // play.json 을 처음 받았을 때 한 번: 판 꼭짓점 줄을 sample() 이 읽는 [t, x0,y0, ...] 꼴로 편다
  // 묶음 [개수, v1..vk, 개수, ...] 를 꼭짓점마다 펼친다(바이트 색은 /255)
  function unrun(r, k, n, scale) {
    const out = new Float32Array(n * k);
    let o = 0;
    for (let i = 0; i < r.length; i += k + 1) {
      for (let c = 0; c < r[i]; c++) for (let j = 0; j < k; j++) out[o++] = r[i + 1 + j] * scale;
    }
    return out;
  }

  // play.json 을 처음 받았을 때 한 번: 프레임마다 빠진 채널(앞 프레임과 같은 값)을 앞 프레임 배열로 채우고 묶음을 펼친다.
  // 같은 배열을 함께 쓰므로 메모리는 바뀐 채널만큼만 는다.
  // 프레임 줄을 꼭짓점 배열로 편다. 빠진 채널(앞 프레임과 같은 값)은 앞 프레임 배열을 함께 쓴다.
  function buildRows(src) {
    let prev = null;
    return (src || []).map(([t, fd]) => {
      if (!fd) { prev = null; return [t, null]; }
      const n = fd.n, keep = prev && prev.n === n;
      const fr = {
        n,
        P: fd.p ? new Float32Array(fd.p) : keep ? prev.P : null,
        C: fd.c ? unrun(fd.c, 4, n, 1 / 255) : keep ? prev.C : null,
        U: fd.u ? new Float32Array(fd.u) : keep ? prev.U : null,
        A: fd.a ? unrun(fd.a, 4, n, 1) : keep ? prev.A : null,
        B: fd.b ? unrun(fd.b, 1, n, 1) : keep ? prev.B : null,
        N: fd.nr ? new Float32Array(fd.nr) : keep ? prev.N : null,
        I: fd.i ? new Uint32Array(fd.i) : keep ? prev.I : null,
      };
      prev = fr;
      return [t, fr];
    });
  }

  // play.json 을 처음 받았을 때 한 번: 처음 재생 · 반복 구간(바퀴별이면 첫 바퀴만, 나머지는 laps.json) 프레임을 편다
  function prepare(d) {
    if (d.prepared) return d;
    d.elements.forEach(e => e.draws.forEach(dr => {
      dr.rows = buildRows(dr.f);
      dr.lrows = dr.fl ? buildRows(dr.fl) : [];
      dr.lapRows = dr.fls ? dr.fls.map(buildRows) : null;
    }));
    d.prepared = true;
    return d;
  }

  // 반복 구간 2바퀴째부터(laps.json)를 재생을 시작한 뒤 받는다. 받기 전에는 첫 바퀴만 되풀이한다.
  function loadLaps(d) {
    if (!d.lapsFile || d.lapsLoading) return;
    d.lapsLoading = true;
    fetchGzJson(skillcutBase(d.code) + 'laps.json.gz' + SKILLCUT_DATA_VER).then(rest => {
      Object.entries(rest).forEach(([ei, draws]) => Object.entries(draws).forEach(([di, laps]) => {
        const dr = d.elements[+ei].draws[+di];
        laps.forEach((l, k) => { dr.lapRows[k + 1] = buildRows(l); });
      }));
      d.lapsLoaded = true;
    }).catch(() => { d.lapsLoading = false; });
  }

  function frameAt(sp, t) {
    const f = sp.frame;
    if (!f.samples) return f;
    const s = sample(f.samples, t);
    return { cx: s[1], cy: s[2], hh: s[3] };
  }

  // 그 오브젝트의 포즈를 시각 t 로 맞춘다.
  // 엔진이 프레임마다 실제로 쓴 애니메이션 시각(an: [t, 이름, 적용 시각, 루프])이 있으면 그것을 따른다.
  // 기록 프레임에서는 값 그대로(키 경계에서 어느 쪽 포즈인지까지 엔진과 같다), 프레임 사이는 지난 시간만큼 잇는다.
  function poseSpine(o, t, L, li) {
    const rows = L ? pick(o.sp.anls, o.sp.anl, li) : o.sp.an;
    const r = rows && rows.length ? holdIn(rows, t, L) : null;
    if (r) {
      const sk = o.skeleton;
      sk.setToSetupPose();
      const anim = r[1] && (o.anims[r[1]] || (o.anims[r[1]] = sk.data.findAnimation(r[1])));
      if (anim) {
        const dt = t - r[0];
        // 기록값은 엔진 float32 를 9자리로 적은 것이라 Math.fround 로 원래 값을 되살린다(키 시각도 float32 라 경계 판정이 같아진다. c321_01 0.533초)
        const at = dt > 1e-3 ? r[2] + dt : Math.fround(r[2]);
        anim.apply(sk, at, at, !!r[3], null, 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
      }
      sk.updateWorldTransform();
      return;
    }
    // 예전 데이터: 타임라인 클립으로 계산. 재생 구간 밖이면 가까운 구간의 처음/끝을 붙든다
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
    const W = forceSize ? forceSize[0] : box.clientWidth, H = forceSize ? forceSize[1] : box.clientHeight;
    const dpr = forceSize ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(W * dpr)), ch = Math.max(1, Math.round(H * dpr));
    if (g.canvas.width !== cw || g.canvas.height !== ch) { g.canvas.width = cw; g.canvas.height = ch; }
    const c = g.ctx.gl;
    // 게임(PC · HD 화질)은 HDR 켬: 중간 버퍼가 B10G11R11 부동소수라 드로우마다 0~1 로 잘리지 않고, 마지막에 8비트 화면으로 복사된다
    // (URP 12 MakeRenderTextureGraphicsFormat, 후처리 · 톤매핑 없음). 같은 형식 R11F_G11F_B10F 에 그린 뒤 캔버스로 옮긴다
    const hdr = useHdr ? hdrTarget(g, cw, ch) : null;
    c.bindFramebuffer(c.FRAMEBUFFER, hdr ? hdr.fb : null);
    c.viewport(0, 0, cw, ch);
    c.clearColor(0, 0, 0, 1);
    c.depthMask(true);
    c.clearDepth(1);
    c.clear(c.COLOR_BUFFER_BIT | c.DEPTH_BUFFER_BIT);

    const a = forceSize ? forceSize[0] / forceSize[1] : skillcutAspect();   // 점검용 render 는 요청한 크기의 비율
    // 엔진이 실제로 실행한 드로우 순서(추출 세션이 GPU 원자 카운터로 기록). 불투명 패스(blend_3d)가 먼저, 그다음 투명 패스.
    const L = looped();
    const li = L ? lapIndex() : 0;
    const row = L ? holdIn(pick(data.orderLoops, data.orderLoop, li) || [], T, true) : hold(data.order, T);
    const r = g.renderer, cam = r.camera;
    for (const ref of (row ? row[1] : [])) {
      if (drawFilter && !drawFilter(ref)) continue;
      if (ref[0] === 1) {
        const o = g.skels[ref[1]];
        if (!o || !activeAt(L ? pick(o.sp.activeLoops, o.sp.activeLoop, li) || [] : o.sp.active, T)) continue;
        poseSpine(o, T, L, li);
        // Spine 셰이더(Skeleton Alpha Dither): ZWrite Off · ZTest LessEqual. 뼈대가 월드 z 한 평면이라 그 깊이로 검사한다
        c.enable(c.DEPTH_TEST);
        c.depthFunc(c.LEQUAL);
        c.depthMask(false);
        const mrows = L ? pick(o.sp.mwls, o.sp.mwl, li) : o.sp.mw;
        const mr = mrows && mrows.length && holdIn(mrows, T, L);
        if (mr) {
          // 플레이 모드 월드 행렬: 스켈레톤 (x, y) → 월드 (a·x + b·y + tx, c·x + d·y + ty, z), 화면 = 월드.xy / (z · tanHalfFov).
          // 뼈대가 한 평면이라 원근 나눗셈이 상수 → 아핀 행렬 하나로 요소 정점 셰이더와 같은 투영 · 확대 · 이동이 된다
          const [, ma, mb, tx, mc, md, ty, mz] = mr;
          const kx = zoom / (mz * data.tanHalfFov * a), ky = zoom / (mz * data.tanHalfFov);
          const v = cam.projectionView.values;
          v.fill(0);
          v[0] = kx * ma; v[4] = kx * mb; v[12] = kx * tx - panX * zoom;
          v[1] = ky * mc; v[5] = ky * md; v[13] = ky * ty - panY * zoom;
          v[14] = 2 * depthOf(mz) - 1; v[15] = 1;
          cam.update = NO_UPDATE;
        } else {
          delete cam.update;                       // 원래 OrthoCamera.update(프로토타입)
          const f = frameAt(o.sp, T);
          cam.setViewport(2 * f.hh * a / zoom, 2 * f.hh / zoom);
          cam.position.set(f.cx + panX * f.hh * a, f.cy + panY * f.hh, 0);
          cam.zoom = 1;
          const zrows = L ? pick(o.sp.zwls, o.sp.zwl, li) : o.sp.zw;
          const zr = zrows && zrows.length && holdIn(zrows, T, L);
          const dz = depthOf(zr ? zr[1] : o.sp.z);
          c.depthRange(dz, dz);
        }
        r.begin();
        r.drawSkeleton(o.skeleton, true);
        r.end();
        c.depthRange(0, 1);
        c.disable(c.DEPTH_TEST);
      } else {
        const e = data.elements[ref[1]], dr = e && e.draws[ref[2]];
        if (!dr || !activeAt(L ? pick(e.activeLoops, e.activeLoop, li) || [] : e.active, T)) continue;
        if (charOnly) continue;
        if (!showCover && e.layer === 4) continue;
        if (!showLight && LIGHT_SHADERS.has(dr.m.sh)) continue;
        const fr = L ? holdIn(pick(dr.lapRows, dr.lrows, li) || [], T, true) : hold(dr.rows, T);
        if (fr && fr[1]) drawElement({ e, dr, fr: fr[1] }, a);
      }
    }
    if (hdr) blitHdr(g, hdr, cw, ch);
  }

  // HDR 중간 버퍼(R11F_G11F_B10F 색 + 24비트 깊이). WebGL2 + EXT_color_buffer_float 가 없으면 null → 8비트로 바로 그린다
  function hdrTarget(g, w, h) {
    const c = g.ctx.gl;
    if (g.hdr === false) return null;
    if (!g.hdr) {
      const ok = typeof WebGL2RenderingContext !== 'undefined' && c instanceof WebGL2RenderingContext && c.getExtension('EXT_color_buffer_float');
      if (!ok) { g.hdr = false; return null; }
      const vs = 'attribute vec2 aP; varying vec2 vT; void main() { vT = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }';
      const fs = 'precision highp float; uniform sampler2D tS; varying vec2 vT; void main() { gl_FragColor = vec4(texture2D(tS, vT).rgb, 1.0); }';
      const prog = c.createProgram();
      [[c.VERTEX_SHADER, vs], [c.FRAGMENT_SHADER, fs]].forEach(([t, src]) => {
        const s = c.createShader(t); c.shaderSource(s, src); c.compileShader(s); c.attachShader(prog, s);
      });
      c.linkProgram(prog);
      const buf = c.createBuffer();
      c.bindBuffer(c.ARRAY_BUFFER, buf);
      c.bufferData(c.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), c.STATIC_DRAW);
      g.hdr = { prog, buf, aP: c.getAttribLocation(prog, 'aP'), tS: c.getUniformLocation(prog, 'tS'), w: 0, h: 0 };
    }
    const t = g.hdr;
    if (t.w !== w || t.h !== h) {
      if (t.fb) { c.deleteFramebuffer(t.fb); c.deleteTexture(t.tex); c.deleteRenderbuffer(t.depth); }
      t.tex = c.createTexture();
      c.bindTexture(c.TEXTURE_2D, t.tex);
      c.texStorage2D(c.TEXTURE_2D, 1, c.R11F_G11F_B10F, w, h);
      c.texParameteri(c.TEXTURE_2D, c.TEXTURE_MIN_FILTER, c.NEAREST);
      c.texParameteri(c.TEXTURE_2D, c.TEXTURE_MAG_FILTER, c.NEAREST);
      c.texParameteri(c.TEXTURE_2D, c.TEXTURE_WRAP_S, c.CLAMP_TO_EDGE);
      c.texParameteri(c.TEXTURE_2D, c.TEXTURE_WRAP_T, c.CLAMP_TO_EDGE);
      t.depth = c.createRenderbuffer();
      c.bindRenderbuffer(c.RENDERBUFFER, t.depth);
      c.renderbufferStorage(c.RENDERBUFFER, c.DEPTH_COMPONENT24, w, h);
      t.fb = c.createFramebuffer();
      c.bindFramebuffer(c.FRAMEBUFFER, t.fb);
      c.framebufferTexture2D(c.FRAMEBUFFER, c.COLOR_ATTACHMENT0, c.TEXTURE_2D, t.tex, 0);
      c.framebufferRenderbuffer(c.FRAMEBUFFER, c.DEPTH_ATTACHMENT, c.RENDERBUFFER, t.depth);
      const done = c.checkFramebufferStatus(c.FRAMEBUFFER) === c.FRAMEBUFFER_COMPLETE;
      c.bindFramebuffer(c.FRAMEBUFFER, null);
      c.bindTexture(c.TEXTURE_2D, null);
      if (!done) { g.hdr = false; return null; }
      t.w = w; t.h = h;
    }
    return t;
  }

  // HDR 버퍼 → 캔버스(8비트). Graphics.Blit 처럼 그대로 복사(1 넘는 값은 여기서 잘린다)
  function blitHdr(g, t, w, h) {
    const c = g.ctx.gl;
    c.bindFramebuffer(c.FRAMEBUFFER, null);
    c.viewport(0, 0, w, h);
    c.disable(c.BLEND); c.disable(c.DEPTH_TEST); c.disable(c.CULL_FACE); c.depthMask(true);
    c.useProgram(t.prog);
    c.activeTexture(c.TEXTURE0);
    c.bindTexture(c.TEXTURE_2D, t.tex);
    c.uniform1i(t.tS, 0);
    c.bindBuffer(c.ARRAY_BUFFER, t.buf);
    c.enableVertexAttribArray(t.aP);
    c.vertexAttribPointer(t.aP, 2, c.FLOAT, false, 0, 0);
    c.drawArrays(c.TRIANGLES, 0, 3);
    c.disableVertexAttribArray(t.aP);
    c.bindTexture(c.TEXTURE_2D, null);
  }

  const NO_UPDATE = () => {};
  let useHdr = true;
  let dbgMode = 0;          // 점검용: 셰이더 중간값을 색으로(1 = 왜곡 뒤 UV, 2 = 노이즈 · 디졸브 · 알파, 3 = 텍스처 알파 · 최종 알파)        // 점검용 render({ hdr: false }) 로 8비트(게임 SD · HDR 꺼짐) 화면도 볼 수 있다

  // 월드 z(카메라 앞 거리) → 깊이 버퍼 값(0~1). 요소 정점 셰이더와 같은 투영
  function depthOf(z) {
    const n = data.near, f = data.far;
    const ndc = ((f + n) / (f - n) * z - 2 * f * n / (f - n)) / z;
    return Math.min(1, Math.max(0, ndc * 0.5 + 0.5));
  }

  // ---- 요소(스프라이트 · 메시 · 파티클) ----
  // 꼭짓점은 추출 세션이 GPU 에서 직접 읽은 정점 셰이더 입력(월드 좌표 · COLOR · TEXCOORD0~2 · 법선)과 삼각형 그대로다.
  // 카메라가 원점 · 회전 없음 · +z 를 보므로 투영은 x / (z · tanHalfFov) 이고, w = z 로 넘겨 원근 보간 · 근평면 자르기를 GPU 와 같게 한다.
  // 프래그먼트는 게임 셰이더(_skillcut_shaders 디스어셈블)를 명령어 순서대로 옮겼다. 셰이더별 블렌드 · 깊이 · 컬은 FX_STATE.
  //   add      NK_fx_add_all                      blend      NK_fx_blend_all(_FOGOFF_ON)
  //   blendfog NK_fx_blend_all(안개 변형)           uvadd      NK_fx_uv_add
  //   uvblend  NK_fx_uv_blend                     b3d        NK_fx_blend_3d(불투명)
  //   fresnel  NK_fx_fresnel                      sprite     Sprites/Default
  // 안개: 전역값을 게임 코드가 넣어 데이터로 정할 수 없어 안개 비율 1(안개 없음)로 둔다(사용자 결정 2026-10-13).
  // _TimeParameters.x(게임 시작 후 시간)는 위상을 데이터로 알 수 없어, 재생 시작부터 멈추지 않고 흐르는 시간(flowT)을 쓴다.
  const FX_VS = [
    'attribute vec3 aPos; attribute vec2 aUv; attribute vec4 aCol; attribute vec4 aT1; attribute float aT2; attribute vec3 aNrm;',
    'uniform float uTan; uniform float uAspect; uniform vec2 uDepth; uniform vec3 uView;',
    'varying vec2 vUv; varying vec4 vCol; varying vec4 vT1; varying float vT2; varying vec3 vW; varying vec3 vN;',
    'void main() {',
    '  vUv = aUv; vCol = aCol; vT1 = aT1; vT2 = aT2; vW = aPos;',
    '  float l = dot(aNrm, aNrm); vN = l > 0.0 ? aNrm * inversesqrt(l) : aNrm;',
    // 확대 · 이동: 화면 좌표(NDC)를 (NDC − pan) × zoom 으로. w = z 라 X 쪽에서 pan × w 를 뺀다
    '  gl_Position = vec4((aPos.x / (uTan * uAspect) - uView.y * aPos.z) * uView.x, (aPos.y / uTan - uView.z * aPos.z) * uView.x, aPos.z * uDepth.x + uDepth.y, aPos.z);',
    '}',
  ].join('\n');
  const FX_FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform sampler2D tMain; uniform sampler2D tMask; uniform sampler2D tDis; uniform sampler2D tNoise; uniform sampler2D tUvm;',
    'uniform vec4 stMain; uniform vec4 stMask; uniform vec4 stDis; uniform vec4 stNoise; uniform vec4 stUvm;',
    // 텍스처마다 셰이더 안에서 wrap 을 흉내 낼지(WebGL1 에서 2의 거듭제곱이 아닌 Repeat · Mirror 텍스처만): (켜짐, wrapU, wrapV)
    'uniform vec3 emMain; uniform vec3 emMask; uniform vec3 emDis; uniform vec3 emNoise; uniform vec3 emUvm;',
    'uniform float uMode; uniform float uAT; uniform float uTime; uniform float uDbg;',
    'uniform vec4 uColor; uniform vec4 uOv; uniform vec4 uLc; uniform vec4 uGc; uniform vec4 uRc;',
    'uniform float uRot; uniform float uNoise; uniform float uCut; uniform float uBloom; uniform float uOvo; uniform float uFogBloom;',
    'uniform float uLo; uniform float uPower; uniform float uGlow;',
    'uniform float cdO; uniform float cdI; uniform float cdD; uniform float cdT;',
    'varying vec2 vUv; varying vec4 vCol; varying vec4 vT1; varying float vT2; varying vec3 vW; varying vec3 vN;',
    'float wrap1(float x, float m) {',
    '  if (m < 0.5) return fract(x);',
    '  if (m < 1.5) return clamp(x, 0.0, 1.0);',
    '  if (m < 2.5) { float r = mod(x, 2.0); return r <= 1.0 ? r : 2.0 - r; }',
    '  return clamp(abs(x), 0.0, 1.0);',
    '}',
    // 엔진 uv 는 v 가 아래에서 0, 웹 텍스처는 위에서 0
    'vec4 smp(sampler2D s, vec2 uv, vec3 em) {',
    '  if (em.x > 0.5) uv = vec2(wrap1(uv.x, em.y), wrap1(uv.y, em.z));',
    '  return texture2D(s, vec2(uv.x, 1.0 - uv.y));',
    '}',
    // D3D saturate: NaN 은 0
    'float sat(float x) { return x >= 0.0 ? min(x, 1.0) : 0.0; }',
    // 오버레이(셰이더 그대로): r3 <= 0.5 이면 2·r3·ov, 아니면 1 − 2(1 − r3)(1 − ov)
    'vec3 overlay(vec3 r3, vec3 ov) {',
    '  vec3 hi = -(( -r3 + 1.0) * 2.0) * (-ov + 1.0) + 1.0;',
    '  vec3 lo = r3 * ov * 2.0;',
    '  return vec3(r3.x <= 0.5 ? lo.x : hi.x, r3.y <= 0.5 ? lo.y : hi.y, r3.z <= 0.5 ? lo.z : hi.z);',
    '}',
    'void main() {',
    '  if (uMode > 6.5) {',
    // Sprites/Default: 색 = COLOR × _Color × _RendererColor(정점), 출력은 미리 곱한 알파
    '    vec4 c = smp(tMain, vUv, emMain) * (vCol * uColor * uRc);',
    '    gl_FragColor = vec4(c.w * c.xyz, c.w);',
    '    return;',
    '  }',
    '  if (uMode > 5.5) {',
    // NK_fx_fresnel: 법선 · 시선(카메라 − 월드, 카메라는 원점)
    '    vec3 n = normalize(vN);',
    '    vec3 v = normalize(-vW);',
    '    float f = sat(dot(n, v));',
    '    f = -f + 1.001;',
    '    f = exp2(log2(f) * max(uGlow, 0.0));',
    '    gl_FragColor = vec4(f * vCol.xyz * uGc.xyz * (uBloom * 1.1), 1.0);',
    '    return;',
    '  }',
    '  if (uMode > 4.5) {',
    // NK_fx_blend_3d (_UVRotation 을 라디안 그대로 쓴다)
    '    vec3 k = vec3(cos(uRot), sin(uRot), sin(uRot)) * vec3(0.5, -0.5, 0.5) + 0.5;',
    '    k = k * 2.0 - 1.0;',
    '    vec2 r1 = vUv * stMain.xy + stMain.zw - 0.5;',
    '    vec2 m = vec2(dot(r1, k.xz), dot(r1.yx, k.xy)) + 0.5;',
    '    vec4 t = smp(tMain, m, emMain);',
    '    vec4 tint = vCol * uColor;',
    '    vec4 r3 = t * tint;',
    '    vec3 o = uPower * (overlay(r3.xyz, uOv.xyz) - r3.xyz) + r3.xyz;',
    '    gl_FragColor = vec4(o * (uBloom * 1.1), r3.w);',
    '    return;',
    '  }',
    '  if (uMode > 3.5) {',
    // NK_fx_uv_blend
    '    vec4 c = smp(tMain, vUv * stMain.xy + uTime * stMain.zw, emMain);',
    '    c = c * smp(tUvm, vUv * stUvm.xy + uTime * stUvm.zw, emUvm);',
    '    c = c * smp(tMask, vUv * stMask.xy + stMask.zw, emMask);',
    '    vec4 r2 = vCol * uColor;',
    '    vec4 r3 = c * r2;',
    '    vec3 o = max(r3.xyz, uLc.xyz);',
    '    o = -c.xyz * r2.xyz + o;',
    '    o = uLo * o + r3.xyz;',
    '    gl_FragColor = vec4(o * (uBloom * 1.1), r3.w);',
    '    return;',
    '  }',
    '  if (uMode > 2.5) {',
    // NK_fx_uv_add
    '    vec4 c = smp(tMain, vUv * stMain.xy + uTime * stMain.zw, emMain);',
    '    c = c * smp(tUvm, vUv * stUvm.xy + uTime * stUvm.zw, emUvm);',
    '    c = c * smp(tMask, vUv * stMask.xy + stMask.zw, emMask);',
    '    c = c * (vCol * uColor);',
    '    vec3 r2 = c.w * c.xyz;',
    '    vec3 o = uOvo * (overlay(r2, uOv.xyz) - r2) + r2;',
    '    gl_FragColor = vec4(o * uBloom, 1.0);',
    '    return;',
    '  }',
    // NK_fx_add_all(0) / NK_fx_blend_all(1 = _FOGOFF_ON, 2 = 안개 변형: 끝에 _Fog_BloomIntensity)
    '  float dis = smp(tDis, vUv * stDis.xy + stDis.zw, emDis).x;',
    '  float y1 = vT1.w + 1.0; float z1 = vT1.z + 1.0;',
    '  vec3 r1 = vT1.xyw * vec3(cdO, cdO, cdD);',
    '  float x = dis - (r1.z * y1 - vT1.w);',
    // 1/r1.z 를 곱한 뒤 saturate. r1.z 가 0 이면 +inf 라서 x>0 → 1, x=0 → NaN → 0, x<0 → 0
    '  x = r1.z == 0.0 ? (x > 0.0 ? 1.0 : 0.0) : sat((1.0 / r1.z) * x);',
    '  float a = z1 * (x * x * (x * -2.0 + 3.0));',
    '  a = a * smp(tMask, vUv * stMask.xy + stMask.zw, emMask).x;',
    '  a = a * vCol.w * uColor.w;',
    '  vec2 uvR = vUv * stMain.xy + r1.xy - 0.5;',
    '  float ang = uRot * 0.017453;',
    '  vec3 k = vec3(cos(ang), sin(ang), sin(ang)) * vec3(0.5, -0.5, 0.5) + 0.5;',
    '  k = k * 2.0 - 1.0;',
    '  vec2 m = vec2(dot(uvR, k.xz), dot(uvR.yx, k.xy)) + 0.5;',
    '  float n = smp(tNoise, vUv * stNoise.xy + uTime * stNoise.zw, emNoise).x;',
    '  m = (cdT * vT2 + uNoise) * (n - m) + m;',
    '  m = stMain.zw * uTime + m;',
    '  vec4 c = smp(tMain, m, emMain);',
    '  float al = sat(a * c.w);',
    // 점검용 중간값 출력(render({ dbg }))
    '  if (uDbg > 0.5) { gl_FragColor = uDbg < 1.5 ? vec4(fract(m), 0.0, 1.0) : uDbg < 2.5 ? vec4(n, dis, sat(a), 1.0) : uDbg < 3.5 ? vec4(c.w, al, 0.0, 1.0) : uDbg < 4.5 ? vec4(fract(vUv * stNoise.xy + uTime * stNoise.zw), 0.0, 1.0) : vec4(stNoise.x / 10.0, stNoise.y / 10.0, uTime / 10.0, 1.0); return; }',
    '  if (uAT > 0.5 && al - uCut < 0.0) discard;',
    '  vec3 rgb = uMode < 0.5 ? vT1.zzz * cdI + c.xyz : c.xyz * cdI + c.xyz;',
    '  vec3 tint = uMode < 0.5 ? vCol.xyz * uColor.xyz : z1 * vCol.xyz * uColor.xyz;',
    '  vec3 r3 = rgb * tint;',
    '  vec3 o = uOvo * (overlay(r3, uOv.xyz) - r3) + r3;',
    '  o = o * (uBloom * 1.1);',
    '  if (uMode > 1.5) o = o * uFogBloom;',
    '  gl_FragColor = vec4(o, al);',
    '}',
  ].join('\n');
  const FX_MODE = { add: 0, blend: 1, blendfog: 2, uvadd: 3, uvblend: 4, b3d: 5, fresnel: 6, sprite: 7 };
  // 셰이더 패스 상태(디스어셈블의 Blend · ZWrite · Cull). [색 src, 색 dst, 알파 src, 알파 dst]
  const FX_STATE = {
    add: { blend: ['SRC_ALPHA', 'ONE', 'ONE', 'ONE'] },
    blend: { blend: ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'] },
    blendfog: { blend: ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'] },
    uvadd: { blend: ['SRC_ALPHA', 'ONE', 'ONE', 'ONE'] },
    uvblend: { blend: ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'] },
    b3d: { blend: ['ONE', 'ZERO', 'ONE', 'ZERO'], zwrite: true, ztest: 4 },
    fresnel: { blend: ['SRC_ALPHA', 'ONE', 'ONE', 'ONE'], cullBack: true, ztest: 4 },
    sprite: { blend: ['ONE', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'], ztest: 4 },
  };
  // UnityEngine.Rendering.CompareFunction → GL
  const ZFUNC = [null, 'ALWAYS', 'NEVER', 'LESS', 'EQUAL', 'LEQUAL', 'GREATER', 'NOTEQUAL', 'GEQUAL', 'ALWAYS'];
  const zfuncOf = v => ZFUNC[(v | 0) + 1] || 'LEQUAL';
  const TEX_UNITS = [['main', 'tMain', 'stMain', 'emMain'], ['mask', 'tMask', 'stMask', 'emMask'],
    ['dis', 'tDis', 'stDis', 'emDis'], ['noise', 'tNoise', 'stNoise', 'emNoise'], ['uvm', 'tUvm', 'stUvm', 'emUvm']];
  const ATTRS = [['aPos', 3, 'P'], ['aUv', 2, 'U'], ['aCol', 4, 'C'], ['aT1', 4, 'A'], ['aT2', 1, 'B'], ['aNrm', 3, 'N']];

  function createFx(c) {
    const sh = (type, src) => {
      const s = c.createShader(type);
      c.shaderSource(s, src);
      c.compileShader(s);
      if (!c.getShaderParameter(s, c.COMPILE_STATUS)) throw new Error(c.getShaderInfoLog(s));
      return s;
    };
    const prog = c.createProgram();
    c.attachShader(prog, sh(c.VERTEX_SHADER, FX_VS));
    c.attachShader(prog, sh(c.FRAGMENT_SHADER, FX_FS));
    c.linkProgram(prog);
    if (!c.getProgramParameter(prog, c.LINK_STATUS)) throw new Error(c.getProgramInfoLog(prog));
    const u = {};
    ['uTan', 'uAspect', 'uDepth', 'uView', 'uMode', 'uAT', 'uTime', 'uColor', 'uOv', 'uLc', 'uGc', 'uRc', 'uRot', 'uNoise',
      'uCut', 'uBloom', 'uOvo', 'uFogBloom', 'uLo', 'uPower', 'uGlow', 'cdO', 'cdI', 'cdD', 'cdT', 'uDbg']
      .concat(...TEX_UNITS.map(t => t.slice(1))).forEach(n => { u[n] = c.getUniformLocation(prog, n); });
    const white = c.createTexture();
    c.bindTexture(c.TEXTURE_2D, white);
    c.texImage2D(c.TEXTURE_2D, 0, c.RGBA, 1, 1, 0, c.RGBA, c.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    c.bindTexture(c.TEXTURE_2D, null);
    const attr = {};
    ATTRS.forEach(([n]) => { attr[n] = c.getAttribLocation(prog, n); });
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && c instanceof WebGL2RenderingContext;
    return {
      prog, u, attr, white, isGL2, vbo: {}, ibo: c.createBuffer(),
      uint32: isGL2 || !!c.getExtension('OES_element_index_uint'),
    };
  }

  // 요소 텍스처 설정: 텍스처마다 wrap(Repeat · Clamp · Mirror) · filter(Point · Bilinear), 밉맵 없음.
  // WebGL1 에서 2의 거듭제곱이 아닌 텍스처는 Repeat · Mirror 를 못 걸어 셰이더에서 흉내 낸다(em 값).
  function setupTexture(fx, c, glTex, w) {
    const img = glTex.getImage();
    const pot = v => (v & (v - 1)) === 0;
    const canWrap = fx.isGL2 || (pot(img.width) && pot(img.height));
    const wrapGL = m => (!canWrap || m === 1 || m === 3 ? c.CLAMP_TO_EDGE : m === 2 ? c.MIRRORED_REPEAT : c.REPEAT);
    c.bindTexture(c.TEXTURE_2D, glTex.texture);
    c.texParameteri(c.TEXTURE_2D, c.TEXTURE_WRAP_S, wrapGL(w[0]));
    c.texParameteri(c.TEXTURE_2D, c.TEXTURE_WRAP_T, wrapGL(w[1]));
    const f = w[2] === 0 ? c.NEAREST : c.LINEAR;
    c.texParameteri(c.TEXTURE_2D, c.TEXTURE_MIN_FILTER, f);
    c.texParameteri(c.TEXTURE_2D, c.TEXTURE_MAG_FILTER, f);
    c.bindTexture(c.TEXTURE_2D, null);
    // MirrorOnce 는 GL 에 없어 늘 셰이더로
    glTex.em = (!canWrap && (w[0] !== 1 || w[1] !== 1)) || w[0] === 3 || w[1] === 3 ? [1, w[0], w[1]] : [0, 0, 0];
  }

  // 그 시각의 propertyBlock(타임라인이 움직이는 머티리얼 속성)
  const pbAt = e => {
    const L = looped(), rows = L ? pick(e.pbls, e.pbl, lapIndex()) : e.pb;
    return rows ? (holdIn(rows, T, L) || [0, null])[1] : null;
  };

  function drawElement(it, aspect) {
    const g = gl, fx = g.fx, c = g.ctx.gl, u = fx.u, m = it.dr.m, fr = it.fr;
    if (!fr.I || !fr.I.length) return;
    if (!fx.uint32 && fr.n > 65535) return;
    const st = FX_STATE[m.sh];
    const pb = pbAt(it.e);
    c.useProgram(fx.prog);
    c.enable(c.BLEND);
    c.blendEquation(c.FUNC_ADD);
    c.blendFuncSeparate(c[st.blend[0]], c[st.blend[1]], c[st.blend[2]], c[st.blend[3]]);
    c.enable(c.DEPTH_TEST);
    c.depthFunc(c[zfuncOf(m.f.ztest !== undefined ? m.f.ztest : (st.ztest || 4))]);
    c.depthMask(!!st.zwrite);
    // Cull Back: 엔진(D3D)은 화면에서 시계 방향 삼각형이 앞면. GPU 캡처로도 확인(c017_01 1.6초 유리 조각: 시계 방향 149개 중 140개가 카메라를 향함)
    if (st.cullBack) { c.enable(c.CULL_FACE); c.cullFace(c.BACK); c.frontFace(c.CW); } else c.disable(c.CULL_FACE);
    if (dbgMode) { c.disable(c.BLEND); c.depthFunc(c.LESS); c.depthMask(true); }   // 점검용: 가장 가까운 면만
    const n = data.near, f = data.far;
    c.uniform1f(u.uTan, data.tanHalfFov);
    c.uniform1f(u.uAspect, aspect);
    c.uniform2f(u.uDepth, (f + n) / (f - n), -2 * f * n / (f - n));
    c.uniform3f(u.uView, zoom, panX, panY);
    c.uniform1f(u.uMode, FX_MODE[m.sh]);
    c.uniform1f(u.uAT, m.at ? 1 : 0);
    c.uniform1f(u.uTime, flowT);
    c.uniform1f(u.uDbg, dbgMode);
    const fl = m.f, col = m.c;
    const bloom = pb && pb.bloom !== undefined ? pb.bloom : fl.bloom === undefined ? 1 : fl.bloom;
    c.uniform4fv(u.uColor, (pb && pb.color) || col.color || [1, 1, 1, 1]);
    c.uniform4fv(u.uOv, col.ov || [1, 1, 1, 1]);
    c.uniform4fv(u.uLc, col.lc || [1, 1, 1, 1]);
    c.uniform4fv(u.uGc, col.gc || [1, 1, 1, 1]);
    c.uniform4fv(u.uRc, col.rc || [1, 1, 1, 1]);
    c.uniform1f(u.uRot, fl.rot || 0);
    c.uniform1f(u.uNoise, fl.noise || 0);
    c.uniform1f(u.uCut, fl.cut || 0);
    c.uniform1f(u.uBloom, bloom);
    c.uniform1f(u.uOvo, fl.ovo || 0);
    c.uniform1f(u.uFogBloom, fl.fogBloom === undefined ? 1 : fl.fogBloom);
    c.uniform1f(u.uLo, fl.lo || 0);
    c.uniform1f(u.uPower, fl.power || 0);
    c.uniform1f(u.uGlow, fl.glow === undefined ? 1 : fl.glow);
    c.uniform1f(u.cdO, fl.cdO || 0);
    c.uniform1f(u.cdI, fl.cdI || 0);
    c.uniform1f(u.cdD, fl.cdD || 0);
    c.uniform1f(u.cdT, fl.cdT || 0);
    TEX_UNITS.forEach(([key, tu, stu, emu], unit) => {
      const t = m.tex[key];
      const file = pb && pb.tex && pb.tex[key] !== undefined ? pb.tex[key] : t ? t[0] : null;
      const glTex = file && g.tex[file];
      c.activeTexture(c.TEXTURE0 + unit);
      c.bindTexture(c.TEXTURE_2D, glTex ? glTex.texture : fx.white);
      c.uniform1i(u[tu], unit);
      c.uniform4fv(u[stu], (pb && pb.st && pb.st[key]) || (t ? t.slice(1, 5) : [1, 1, 0, 0]));
      c.uniform3fv(u[emu], glTex ? glTex.em : [0, 0, 0]);
    });
    c.activeTexture(c.TEXTURE0);
    ATTRS.forEach(([name, size, key]) => {
      const loc = fx.attr[name];
      if (loc < 0) return;
      const arr = fr[key];
      if (!arr) { c.disableVertexAttribArray(loc); c.vertexAttrib4f(loc, 0, 0, 0, 0); return; }
      let buf = fx.vbo[name];
      if (!buf) buf = fx.vbo[name] = c.createBuffer();
      c.bindBuffer(c.ARRAY_BUFFER, buf);
      c.bufferData(c.ARRAY_BUFFER, arr, c.STREAM_DRAW);
      c.enableVertexAttribArray(loc);
      c.vertexAttribPointer(loc, size, c.FLOAT, false, 0, 0);
    });
    c.bindBuffer(c.ELEMENT_ARRAY_BUFFER, fx.ibo);
    if (fx.uint32) {
      c.bufferData(c.ELEMENT_ARRAY_BUFFER, fr.I, c.STREAM_DRAW);
      c.drawElements(c.TRIANGLES, fr.I.length, c.UNSIGNED_INT, 0);
    } else {
      c.bufferData(c.ELEMENT_ARRAY_BUFFER, new Uint16Array(fr.I), c.STREAM_DRAW);
      c.drawElements(c.TRIANGLES, fr.I.length, c.UNSIGNED_SHORT, 0);
    }
    ATTRS.forEach(([name]) => { if (fx.attr[name] >= 0) c.disableVertexAttribArray(fx.attr[name]); });
    c.bindBuffer(c.ARRAY_BUFFER, null);
    c.bindBuffer(c.ELEMENT_ARRAY_BUFFER, null);
    c.disable(c.BLEND);
    c.disable(c.DEPTH_TEST);
    c.disable(c.CULL_FACE);
    c.depthMask(true);
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
    const g = gl, base = skillcutBase(code);
    const datas = {};
    for (const f of usedFiles()) {
      const atlas = g.assets.require(base + f + '.atlas');
      const bin = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas));
      datas[f] = bin.readSkeletonData(g.assets.require(base + f + '.skel'));
    }
    g.skels = data.spines.map(sp => ({ sp, skeleton: new spine.Skeleton(datas[sp.file]), anims: {} }));
    g.fx = createFx(g.ctx.gl);
    elementTextures().forEach(([t, w]) => {
      g.tex[t] = g.assets.require(SKILLCUT_EL + t + SKILLCUT_DATA_VER);
      setupTexture(g.fx, g.ctx.gl, g.tex[t], w);
    });
    g.ready = true;
    showMsg('');
  }

  const usedFiles = () => [...new Set(data.spines.map(s => s.file))];
  // 요소 텍스처 [파일, [wrapU, wrapV, filter]] - 머티리얼 칸과 propertyBlock(스프라이트 그림)에서
  function elementTextures() {
    const map = new Map();
    data.elements.forEach(e => {
      e.draws.forEach(d => Object.values(d.m.tex).forEach(t => { if (t[0]) map.set(t[0], t.slice(5, 8)); }));
      (e.pb || []).forEach(([, v]) => v && v.tex && Object.values(v.tex).forEach(f => {
        if (f && !map.has(f)) map.set(f, [1, 1, 1]);
      }));
    });
    return [...map];
  }

  function createGL() {
    const canvas = document.createElement('canvas');
    canvas.className = 'skillcut-canvas';
    box.prepend(canvas);
    const ctx = new spine.ManagedWebGLRenderingContext(canvas, { alpha: false, premultipliedAlpha: true, antialias: false, depth: true });
    const renderer = new spine.SceneRenderer(canvas, ctx, true);
    const assets = new spine.AssetManager(ctx);
    const base = skillcutBase(code);
    for (const f of usedFiles()) {
      assets.loadBinary(base + f + '.skel');
      assets.loadTextureAtlas(base + f + '.atlas');
    }
    elementTextures().forEach(([t]) => assets.loadTexture(SKILLCUT_EL + t + SKILLCUT_DATA_VER));
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
    wireZoom();
    resizeObs = new ResizeObserver(fitBox);
    resizeObs.observe(layer);
  }

  // ---- 확대 · 이동 ----
  // 휠 / 두 손가락으로 확대(가리킨 곳을 붙든 채), 확대한 상태에서 끌어서 이동, 더블클릭(더블탭)으로 처음 크기.
  // 기본 화면보다 작게는 줄이지 않고, 이동은 기본 화면 밖으로 나가지 않게 막는다.
  function clampView() {
    zoom = Math.min(ZOOM_MAX, Math.max(1, zoom));
    const m = 1 - 1 / zoom;
    panX = Math.min(m, Math.max(-m, panX));
    panY = Math.min(m, Math.max(-m, panY));
    if (box) box.classList.toggle('is-zoomed', zoom > 1.001);
    if (paused && gl && gl.ready) draw();     // 멈춘 상태에서도 바로 보인다
  }

  function resetView() {
    zoom = 1; panX = 0; panY = 0;
    clampView();
  }

  // 상자 안 화면 좌표(px) → NDC
  function ndcAt(clientX, clientY) {
    const r = box.getBoundingClientRect();
    return [((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2];
  }

  // (cx, cy) NDC 지점을 붙든 채 배율을 z 로
  function zoomAt(z, cx, cy) {
    const qx = cx / zoom + panX, qy = cy / zoom + panY;
    zoom = Math.min(ZOOM_MAX, Math.max(1, z));
    panX = qx - cx / zoom;
    panY = qy - cy / zoom;
    clampView();
  }

  function wireZoom() {
    box.style.touchAction = 'none';
    box.addEventListener('wheel', e => {
      e.preventDefault();
      const [cx, cy] = ndcAt(e.clientX, e.clientY);
      zoomAt(zoom * Math.exp(-e.deltaY * 0.0015), cx, cy);
    }, { passive: false });
    box.addEventListener('dblclick', e => { e.preventDefault(); resetView(); });
    const pts = new Map();
    let pinch = null, lastTap = 0;
    box.addEventListener('pointerdown', e => {
      box.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: zoom };
      }
      if (e.pointerType === 'touch' && pts.size === 1) {
        const now = performance.now();
        if (now - lastTap < 300) resetView();
        lastTap = now;
      }
    });
    box.addEventListener('pointermove', e => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const cur = [e.clientX, e.clientY];
      pts.set(e.pointerId, cur);
      if (pts.size >= 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const [cx, cy] = ndcAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        zoomAt(pinch.z * d / Math.max(1, pinch.d), cx, cy);
        return;
      }
      if (zoom <= 1.001) return;
      const r = box.getBoundingClientRect();
      panX -= ((cur[0] - prev[0]) / r.width) * 2 / zoom;
      panY += ((cur[1] - prev[1]) / r.height) * 2 / zoom;
      clampView();
    });
    const up = e => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
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
    const W = layer.clientWidth, H = layer.clientHeight, a = skillcutAspect();
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
    // 캐릭터만 켜면 빛 효과 · 화면 덮개는 의미가 없어 흐리게(누르면 캐릭터만이 풀린다)
    [['data-sc-light', showLight], ['data-sc-cover', showCover], ['data-sc-char', charOnly]].forEach(([attr, on]) =>
      document.querySelectorAll(`#costume-skillcut-controls [${attr}]`).forEach(b => {
        b.classList.toggle('active', on);
        b.classList.toggle('is-muted', charOnly && attr !== 'data-sc-char');
        b.setAttribute('aria-pressed', String(on));
      }));
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
      playCache[c] = fetchGzJson(skillcutBase(c) + 'play.json.gz' + SKILLCUT_DATA_VER);
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
      try { data = prepare(await loadPlay(code)); } catch (e) { if (seq === loadSeq) showMsg('컷신 정보를 불러오지 못했습니다.'); return; }
      if (seq !== loadSeq || !mode) return;   // 그사이 끄거나 다른 버튼을 눌렀다
    }
    T = m === 'idle' && data.jump ? data.jump.to : 0;
    flowT = T;
    resetView();
    lap = 0;
    loadLaps(data);
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
    const save = (key, on) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) { /* 저장 안 됨 */ } };
    const toggled = () => {
      syncButtons();
      if (paused && gl && gl.ready) draw();   // 멈춘 상태에서도 바로 바뀐 모습을 보여 준다
    };
    // 빛 효과 · 화면 덮개를 누르면 캐릭터만 보기는 풀린다(효과를 보려는 뜻이므로)
    const leaveCharOnly = () => { if (charOnly) { charOnly = false; save(CHAR_KEY, false); } };
    sc.querySelectorAll('[data-sc-light]').forEach(b => b.addEventListener('click', () => {
      if (charOnly) leaveCharOnly(); else { showLight = !showLight; save(LIGHT_KEY, showLight); }
      toggled();
    }));
    sc.querySelectorAll('[data-sc-cover]').forEach(b => b.addEventListener('click', () => {
      if (charOnly) leaveCharOnly(); else { showCover = !showCover; save(COVER_KEY, showCover); }
      toggled();
    }));
    sc.querySelectorAll('[data-sc-char]').forEach(b => b.addEventListener('click', () => {
      charOnly = !charOnly;
      save(CHAR_KEY, charOnly);
      toggled();
    }));
    // 휴대폰 화면 기준을 넘나들면(창 크기 · 회전) 화면비도 따라 바꾼다
    L2D_MOBILE_MQ.addEventListener('change', fitBox);
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
      fetch(SKILLCUT_INDEX).then(r => (r.ok ? r.json() : []))
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
    flowT = t;
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
    // 점검용: 지금 시각 · 모드 · 반복 바퀴
    state: () => ({ T, mode, lap, lapIndex: data ? lapIndex() : 0, lapsLoaded: !!(data && data.lapsLoaded) }),
    // 점검용(엔진 기준 화면과 비교): 처음 재생(lap null) 또는 반복 바퀴 lap 의 시각 t 를, 셰이더 시간 shaderTime 으로,
    // size×size(px) 에 그려 PNG 로 돌려준다
    render({ t, lap: lp = null, shaderTime = t, size = 720, filter = null, hdr = true, dbg = 0 }) {
      if (!gl || !gl.ready) return null;
      const keep = { mode, lap, T, flowT, paused };
      mode = lp === null ? 'full' : 'idle';
      lap = lp === null ? 0 : lp;
      T = t;
      flowT = shaderTime;
      forceSize = [size, size];
      drawFilter = filter;
      useHdr = hdr;
      dbgMode = dbg;
      try {
        draw();
        return gl.canvas.toDataURL('image/png');
      } finally {
        forceSize = null;
        drawFilter = null;
        useHdr = true;
        dbgMode = 0;
        ({ mode, lap, T, flowT, paused } = keep);
      }
    },
    // 점검용: 요소 한 드로우의 그 시각 정점 줄(엔진 기록과 대조)
    rowAt({ t, el, draw = 0 }) {
      const dr = data && data.elements[el] && data.elements[el].draws[draw];
      const fr = dr && hold(dr.rows, t);
      return fr && fr[1] ? { t: fr[0], n: fr[1].n, P: Array.from(fr[1].P || []), U: Array.from(fr[1].U || []), A: Array.from(fr[1].A || []),
        B: Array.from(fr[1].B || []), C: Array.from(fr[1].C || []), I: Array.from(fr[1].I || []) } : null;
    },
    // 점검용: 그 시각에 그려지는 드로우 목록([0, 요소, 드로우] / [1, Spine]과 이름)
    drawList({ t, lap: lp = null }) {
      const keep = { mode, lap, T };
      mode = lp === null ? 'full' : 'idle'; lap = lp === null ? 0 : lp; T = t;
      try {
        const L = looped(), li = L ? lapIndex() : 0;
        const row = L ? holdIn(pick(data.orderLoops, data.orderLoop, li) || [], T, true) : hold(data.order, T);
        return (row ? row[1] : []).map(ref => [ref, ref[0] === 1 ? 'spine:' + data.spines[ref[1]].name
          : data.elements[ref[1]].name + '#' + ref[2] + ' ' + data.elements[ref[1]].draws[ref[2]].m.sh]);
      } finally { ({ mode, lap, T } = keep); }
    },
    // 점검용: 재생과 똑같이 dt 만큼 진행(되감기 · 바퀴 넘김 포함)한 뒤 한 장 그려 돌려준다
    step(dt) {
      if (!gl || !gl.ready) return null;
      paused = false;
      advance(dt);
      paused = true;
      draw();
      return gl.canvas.toDataURL('image/jpeg', 0.8);
    },
  };
})();
