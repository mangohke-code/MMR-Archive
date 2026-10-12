// ===== 유니크 코스튬 스킬 컷신 (사용자 요청, 2026-10-12) =====
// 코스튬 뷰어 왼쪽 판 맨 위의 [기본 L2D | 스킬 컷신] 으로 둘을 오간다. 둘은 완전히 나뉘어 있어서
// 기본 L2D 상태에는 L2D 조작(모델 · 동작 · 표정 · 파츠)만, 스킬 컷신 상태에는 아래 컷신 조작만 보인다.
// 스킬 컷신으로 넘어가면 idle 반복부터 보여 준다.
//   전체 재생  : 로비 라이브 월페이퍼 순서 그대로 - 컷신 → 검은 화면 → idle 반복(끝나면 idle 반복 버튼으로 넘어간다)
//   스킬컷 재생: 컷신만 한 번, 끝나면 바로 idle 반복으로 넘어간다
//   idle 반복  : 전체 재생의 반복 구간만
// 재생 버튼은 누를 때마다 처음부터 다시 튼다(켜고 끄는 단추가 아니다).
//
// 데이터: l2d/<코드>/skillcut/play.json (tools/build_skillcut.py 가 추출 세션의 _skillcut_playback.json 에서 만든다).
// 인게임 라이브 월페이퍼는 Spine 오브젝트 여러 개 · 배경 그림 · 검은 판을 원근 카메라 하나로 비춘다.
// 오브젝트마다 카메라와의 거리가 달라서 skel 좌표로 본 화면 범위(중심 cx·cy, 세로 반높이 hh)가 저마다 다르고,
// 15개는 그 범위가 시간에 따라 움직인다(30fps 표본). 그래서 Spine 플레이어(뼈대 하나 · 화면 하나)를 쓰지 않고
// 캔버스 하나에 오브젝트마다 카메라를 바꿔 가며 직접 그린다. 가로 범위는 기기 화면비라 데이터에 없어서
// PC 는 1:1(인게임 카메라), 휴대폰 화면(L2D_MOBILE_MQ)에서는 저절로 9:16 으로 그린다.
//
// 재생은 AnimationState 를 쓰지 않고 바깥 타임라인 시각 하나(T)로 모든 포즈 · 위치 · 색을 정한다.
// 점프 마커로 idle 구간을 되감고, 진행바로 아무 시각이나 골라도 어긋나지 않는다.
// 배경 그림 · 검은 판 · 파티클(요소)은 추출 세션이 엔진에서 30fps 로 뽑은 화면 꼭짓점 · UV · 색을 그대로 그린다.
// 요소는 메인 텍스처(배율 · 오프셋) × 마스크만 쓰는 작은 셰이더로 그린다(가산 / 알파 블렌드).
// 못 그리는 것: Mesh · Stretch 모드 파티클, 디졸브 · 왜곡 같은 셰이더 효과, 셰이더로 움직이는 화면 전환.

const SKILLCUT_INDEX = 'l2d/skillcut.json';
const skillcutBase = c => 'l2d/' + c + '/skillcut/';
// 화면비(가로/세로): 휴대폰 화면이면 9:16, 아니면 인게임 카메라 1:1. 그릴 때마다 지금 화면 기준으로 정한다.
const skillcutAspect = () => (L2D_MOBILE_MQ.matches ? 9 / 16 : 1);

const CostumeSkillcut = (() => {
  let index = null;         // 컷신이 있는 코드 목록(index.json)
  let code = null;          // 지금 코스튬 코드(컷신이 있을 때만)
  let data = null;          // 그 코드의 play.json
  let mode = null;          // 'full' | 'idle' | 'cut' | null(꺼짐)
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
      // 전체 재생도 반복 구간에 들어서면 idle 반복으로 넘어간다
      T = data.jump.to + (T - data.jump.at);
      if (mode === 'full') { mode = 'idle'; syncButtons(); }
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

  // "바뀐 시각만" 적힌 줄에서 시각 t 의 값(사이는 앞 값 그대로). 파티클은 입자 수가 바뀌어 잇지 않는다.
  function hold(rows, t) {
    if (t < rows[0][0]) return null;
    let lo = 0, hi = rows.length - 1;
    if (t >= rows[hi][0]) return rows[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][0] <= t) lo = m; else hi = m; }
    return rows[lo];
  }

  // play.json 을 처음 받았을 때 한 번: 판 꼭짓점 줄을 sample() 이 읽는 [t, x0,y0, ...] 꼴로 편다
  function prepare(d) {
    if (d.prepared) return d;
    d.elements.forEach(e => { if (e.kind === 'q') e.rows = e.q.map(([t, xy]) => [t, ...xy]); });
    d.prepared = true;
    return d;
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

    const a = skillcutAspect();
    const items = [];
    g.skels.forEach((o, i) => {
      if (activeAt(o.sp.active, T)) items.push({ o, layer: o.sp.layer, order: o.sp.order, z: o.sp.z, i });
    });
    data.elements.forEach((e, i) => {
      if (!activeAt(e.active, T) || !g.tex[e.tex]) return;
      // 같은 레이어 · 순서면 Spine 보다 뒤(배경 판들이 여기에 걸린다)
      items.push({ e, layer: e.layer, order: e.order, z: Infinity, i: 1000 + i });
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
        drawElement(it.e, a);
      }
    }
  }

  // ---- 요소(판 · 파티클) ----
  // 화면 단위 꼭짓점(y -1~1 이 아래~위, x 는 -a~a)을 그대로 받아 그린다.
  // 색 = 메인 텍스처(uv × 배율 + 오프셋, 넘치면 되풀이) × 꼭짓점 색, 마스크가 있으면 그 r·a 를 알파에 곱한다.
  // 출력은 미리 곱한 알파라 알파 블렌드는 (1, 1-a), 가산은 (1, 1).
  const FX_VS = [
    'attribute vec2 aPos; attribute vec2 aUv; attribute vec4 aCol;',
    'uniform float uAspect;',
    'varying vec2 vUv; varying vec4 vCol;',
    'void main() { vUv = aUv; vCol = aCol; gl_Position = vec4(aPos.x / uAspect, aPos.y, 0.0, 1.0); }',
  ].join('\n');
  const FX_FS = [
    'precision mediump float;',
    'uniform sampler2D uTex; uniform sampler2D uMask;',
    'uniform vec4 uSt; uniform vec4 uMaskSt; uniform float uTile; uniform float uUseMask;',
    'varying vec2 vUv; varying vec4 vCol;',
    // 엔진 v 는 아래가 0, 텍스처는 위가 0
    'vec2 tc(vec2 uv, vec4 st, float tile) { vec2 p = uv * st.xy + st.zw; if (tile > 0.5) p = fract(p); return vec2(p.x, 1.0 - p.y); }',
    'void main() {',
    '  vec4 c = texture2D(uTex, tc(vUv, uSt, uTile)) * vCol;',
    '  if (uUseMask > 0.5) { vec4 m = texture2D(uMask, tc(vUv, uMaskSt, 1.0)); c.a *= m.r * m.a; }',
    '  gl_FragColor = vec4(c.rgb * c.a, c.a);',
    '}',
  ].join('\n');
  const ST_ONE = [1, 1, 0, 0];
  const FX_MAX_VERTS = 65536;          // Uint16 인덱스 한도. 넘치면 중간에 한 번 그리고 비운다.
  const FX_MAX_IDX = FX_MAX_VERTS * 3;

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
    const loc = n => c.getAttribLocation(prog, n), uni = n => c.getUniformLocation(prog, n);
    return {
      prog, vbo: c.createBuffer(), ibo: c.createBuffer(),
      verts: new Float32Array(FX_MAX_VERTS * 8), idx: new Uint16Array(FX_MAX_IDX), nv: 0, ni: 0,
      aPos: loc('aPos'), aUv: loc('aUv'), aCol: loc('aCol'),
      uAspect: uni('uAspect'), uTex: uni('uTex'), uMask: uni('uMask'), uSt: uni('uSt'), uMaskSt: uni('uMaskSt'),
      uTile: uni('uTile'), uUseMask: uni('uUseMask'),
    };
  }

  // 모아 둔 삼각형을 그린다(그리기 상태는 drawElement 가 맞춰 둔다)
  function flushFx(fx, c) {
    if (fx.ni) {
      c.bindBuffer(c.ARRAY_BUFFER, fx.vbo);
      c.bufferData(c.ARRAY_BUFFER, fx.verts.subarray(0, fx.nv * 8), c.STREAM_DRAW);
      c.vertexAttribPointer(fx.aPos, 2, c.FLOAT, false, 32, 0);
      c.vertexAttribPointer(fx.aUv, 2, c.FLOAT, false, 32, 8);
      c.vertexAttribPointer(fx.aCol, 4, c.FLOAT, false, 32, 16);
      c.bindBuffer(c.ELEMENT_ARRAY_BUFFER, fx.ibo);
      c.bufferData(c.ELEMENT_ARRAY_BUFFER, fx.idx.subarray(0, fx.ni), c.STREAM_DRAW);
      c.drawElements(c.TRIANGLES, fx.ni, c.UNSIGNED_SHORT, 0);
    }
    fx.nv = 0;
    fx.ni = 0;
  }

  // 꼭짓점 nv 개 · 인덱스 ni 개 자리를 비워 두고 첫 꼭짓점 번호를 돌려준다. 한 덩어리가 한도보다 크면 -1.
  function reserve(fx, c, nv, ni) {
    if (nv > FX_MAX_VERTS || ni > FX_MAX_IDX) return -1;
    if (fx.nv + nv > FX_MAX_VERTS || fx.ni + ni > FX_MAX_IDX) flushFx(fx, c);
    return fx.nv;
  }

  // 꼭짓점 하나: x, y, u, v, r, g, b, a
  function putVert(fx, x, y, u, w, r, g, b, al) {
    const v = fx.verts, o = fx.nv * 8;
    v[o] = x; v[o + 1] = y; v[o + 2] = u; v[o + 3] = w; v[o + 4] = r; v[o + 5] = g; v[o + 6] = b; v[o + 7] = al;
    fx.nv++;
  }

  function putQuadIdx(fx, b) {
    fx.idx.set([b, b + 1, b + 2, b, b + 2, b + 3], fx.ni);
    fx.ni += 6;
  }

  // 메시 삼각형: 빠진 꼭짓점(근평면 뒤)이 낀 삼각형은 뺀다
  function putTris(fx, tri, b, missing) {
    const idx = fx.idx;
    for (let k = 0; k + 2 < tri.length; k += 3) {
      if (missing && (missing.has(tri[k]) || missing.has(tri[k + 1]) || missing.has(tri[k + 2]))) continue;
      idx[fx.ni++] = b + tri[k];
      idx[fx.ni++] = b + tri[k + 1];
      idx[fx.ni++] = b + tri[k + 2];
    }
  }

  // 판: 꼭짓점 순서 왼위 · 오른위 · 오른아래 · 왼아래, uv 는 그 순서로 (0,1) (1,1) (1,0) (0,0)
  const QUAD_UV = [0, 1, 1, 1, 1, 0, 0, 0];
  function fillQuad(e, fx, c) {
    const col = sample(e.color, T);
    if (col[4] <= 0.002) return;
    const q = sample(e.rows, T);
    const b = reserve(fx, c, 4, 6);
    for (let k = 0; k < 4; k++) putVert(fx, q[1 + k * 2], q[2 + k * 2], QUAD_UV[k * 2], QUAD_UV[k * 2 + 1], col[1], col[2], col[3], col[4]);
    putQuadIdx(fx, b);
  }

  // Mesh 입자 하나: 기준 uv(배율 · 오프셋 uvt) · 삼각형 + 꼭짓점 xy(xyAt(i) → [x, y] 또는 null)
  function fillMeshParticle(fx, c, mesh, col, uvt, xyAt) {
    const n = mesh.uv.length / 2;
    if (col[3] <= 0.5) return;
    const b = reserve(fx, c, n, mesh.tri.length);
    if (b < 0) return;
    const r = col[0] / 255, g = col[1] / 255, bl = col[2] / 255, al = col[3] / 255;
    const [su, ou, sv, ov] = uvt || [1, 0, 1, 0];
    let missing = null;
    for (let i = 0; i < n; i++) {
      const xy = xyAt(i);
      if (!xy) (missing || (missing = new Set())).add(i);
      putVert(fx, xy ? xy[0] : 0, xy ? xy[1] : 0, mesh.uv[i * 2] * su + ou, mesh.uv[i * 2 + 1] * sv + ov, r, g, bl, al);
    }
    putTris(fx, mesh.tri, b, missing);
  }

  // 파티클: 사각형(입자마다 꼭짓점 xy 8, uv 8, rgba(0~255) 4) + 메시 입자(m: 아핀, x: 화면 xy) + 그대로 적은 삼각형(v · i)
  function fillParticles(e, fx, c) {
    const row = hold(e.p, T);
    if (!row) return;
    const p = row[1];
    for (let s = 0; s + 20 <= p.length; s += 20) {
      const al = p[s + 19] / 255;
      if (al <= 0.002) continue;
      const r = p[s + 16] / 255, g = p[s + 17] / 255, b = p[s + 18] / 255;
      const base = reserve(fx, c, 4, 6);
      for (let k = 0; k < 4; k++) putVert(fx, p[s + k * 2], p[s + k * 2 + 1], p[s + 8 + k * 2], p[s + 9 + k * 2], r, g, b, al);
      putQuadIdx(fx, base);
    }
    const ex = row[2];
    if (!ex) return;
    const mesh = e.mesh;
    if (ex.m && mesh && mesh.ref) {
      const ref = mesh.ref;
      for (const m of ex.m) {
        const miss = m[11] ? new Set(m[11]) : null;
        fillMeshParticle(fx, c, mesh, [m[6], m[7], m[8], m[9]], m[10] || null, i => {
          if (miss && miss.has(i)) return null;
          const x = ref[i * 2], y = ref[i * 2 + 1];
          return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
        });
      }
    }
    if (ex.x && mesh) {
      for (const m of ex.x) {
        fillMeshParticle(fx, c, mesh, [m[0], m[1], m[2], m[3]], m[4] || null, i => {
          const x = m[5 + i * 2], y = m[6 + i * 2];
          return x === null || y === null ? null : [x / 1000, y / 1000];
        });
      }
    }
    if (ex.v && ex.i) {
      const v = ex.v, nv = v.length / 8;
      const b = reserve(fx, c, nv, ex.i.length);
      if (b >= 0) {
        for (let k = 0; k < nv; k++) {
          const o = k * 8;
          putVert(fx, v[o], v[o + 1], v[o + 2], v[o + 3], v[o + 4] / 255, v[o + 5] / 255, v[o + 6] / 255, v[o + 7] / 255);
        }
        putTris(fx, ex.i, b, null);
      }
    }
  }

  function drawElement(e, aspect) {
    const g = gl, fx = g.fx, c = g.ctx.gl;
    c.useProgram(fx.prog);
    c.enable(c.BLEND);
    if (e.add) c.blendFunc(c.ONE, c.ONE); else c.blendFunc(c.ONE, c.ONE_MINUS_SRC_ALPHA);
    c.uniform1f(fx.uAspect, aspect);
    c.uniform4fv(fx.uSt, e.st || ST_ONE);
    c.uniform1f(fx.uTile, e.st ? 1 : 0);
    g.tex[e.tex].bind(0);
    c.uniform1i(fx.uTex, 0);
    const mask = e.mask && g.tex[e.mask];
    c.uniform1f(fx.uUseMask, mask ? 1 : 0);
    if (mask) {
      mask.bind(1);
      c.uniform1i(fx.uMask, 1);
      c.uniform4fv(fx.uMaskSt, e.maskSt || ST_ONE);
      c.activeTexture(c.TEXTURE0);
    } else {
      c.uniform1i(fx.uMask, 0);
    }
    c.enableVertexAttribArray(fx.aPos);
    c.enableVertexAttribArray(fx.aUv);
    c.enableVertexAttribArray(fx.aCol);
    fx.nv = 0;
    fx.ni = 0;
    if (e.kind === 'p') fillParticles(e, fx, c); else fillQuad(e, fx, c);
    flushFx(fx, c);
    c.disableVertexAttribArray(fx.aPos);
    c.disableVertexAttribArray(fx.aUv);
    c.disableVertexAttribArray(fx.aCol);
    c.bindBuffer(c.ARRAY_BUFFER, null);
    c.bindBuffer(c.ELEMENT_ARRAY_BUFFER, null);
    c.disable(c.BLEND);
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
    elementTextures().forEach(t => { g.tex[t] = g.assets.require(base + t); });
    g.fx = createFx(g.ctx.gl);
    g.ready = true;
    showMsg('');
  }

  const usedFiles = () => [...new Set(data.spines.map(s => s.file))];
  const elementTextures = () => [...new Set(data.elements.flatMap(e => (e.mask ? [e.tex, e.mask] : [e.tex])))];

  function createGL() {
    const canvas = document.createElement('canvas');
    canvas.className = 'skillcut-canvas';
    box.prepend(canvas);
    const ctx = new spine.ManagedWebGLRenderingContext(canvas, { alpha: false, premultipliedAlpha: true, antialias: true });
    const renderer = new spine.SceneRenderer(canvas, ctx, true);
    const assets = new spine.AssetManager(ctx);
    const base = skillcutBase(code);
    for (const f of usedFiles()) {
      assets.loadBinary(base + f + '.skel');
      assets.loadTextureAtlas(base + f + '.atlas');
    }
    elementTextures().forEach(t => assets.loadTexture(base + t));
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
      playCache[c] = fetch(skillcutBase(c) + 'play.json').then(r => {
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
      try { data = prepare(await loadPlay(code)); } catch (e) { if (seq === loadSeq) showMsg('컷신 정보를 불러오지 못했습니다.'); return; }
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
