"""유니크 코스튬 스킬 컷신을 사이트용으로 묶는다 (사용자 요청, 2026-10-12).

입력 (추출 세션이 만든 것, 리소스/코스튬/):
    _skillcut_playback.json          코드별 재생 데이터(바깥 타임라인 30fps, Spine 런타임 · BoneFollower 적용)
    _skillcut_particles/<코드>.json   Spine 이 아닌 요소(스프라이트 · 메시 · 파티클)의 시간별 꼭짓점 · 색 · 머티리얼
    <skel 이름>/                     .skel · .atlas · .png
    _skillcut_elements/<코드>/        요소 텍스처 PNG

출력 (저장소):
    l2d/<코드>/skillcut/play.json    js/skillcut.js 가 읽는 재생 데이터(필요한 값만)
    l2d/<코드>/skillcut/*.skel · *.atlas · *.webp   텍스처는 WebP(q90, 알파 무손실)로 바꾸고 atlas 의 페이지 이름도 고친다
    l2d/<코드>/skillcut/el/*.webp     요소 텍스처
    l2d/skillcut.json                컷신이 있는 코드 목록

WebP 는 c016_01 로 PNG 와 렌더 결과를 비교해 정했다(q90: 평균 차이 2/255, 3배 확대에서도 구분 안 됨, 용량 -74%).

요소 (play.json elements[]):
    kind 'q'  스프라이트 · 메시 판: q = [[t, 꼭짓점 8개]] (왼위 · 오른위 · 오른아래 · 왼아래, 화면 단위), color = [[t, r,g,b,a]]
    kind 'p'  파티클: p = [[t, 사각형들] 또는 [t, 사각형들, {m, v, i}]]
              사각형 = 입자마다 꼭짓점 xy 8 · uv 8 · rgba(0~255) 4 (Billboard · Stretch)
              m = Mesh 입자마다 [a,b,c, d,e,f, r,g,b,a, uv변환 (, 근평면 뒤 꼭짓점 번호들)]: 요소의 mesh.ref(기준 xy)를
                  x' = a·x + b·y + c, y' = d·x + e·y + f 로 옮긴 것. mesh.uv · mesh.tri 는 요소에 한 번만.
                  uv변환 = 0(기준 uv 그대로) 또는 [su, ou, sv, ov]: u' = su·u + ou, v' = sv·v + ov (텍스처 시트 칸 · 뒤집기)
              x = 아핀으로 안 맞는 Mesh 입자마다 [r,g,b,a, uv변환, x0,y0, x1,y1, ...] (화면 xy 를 1000 배 정수로, 근평면 뒤는 null)
              v · i = 그대로 적은 삼각형: 꼭짓점 [x, y, u, v, r, g, b, a] 씩 + 인덱스 (기준 모양이 없는 Mesh 입자 ·
                  근평면에서 자른 Billboard)
              uv 는 엔진 값 그대로(v 는 아래가 0), 메인 텍스처 st(배율 · 오프셋)는 그릴 때 곱한다.
    둘 다 "바뀐 시각만" 적혀 있어서, 그 사이는 앞 값을 그대로 쓴다.
    add 1 = 가산 블렌드. 셰이더로 정한다(가산 셰이더 / 알파 셰이더). 다른 셰이더는 머티리얼 이름의 add · blend 로.
    mask = 마스크 텍스처(_MaskTex)와 st.

못 그리는 것은 뺀다:
    - 자유 늘이기(freeformStretching) Stretch 파티클, 엔진 값으로 조립되지 않은 Mesh 입자, SkinnedMeshRenderer
    - 디졸브 · 노이즈 왜곡 · UV 흐름 같은 셰이더 효과(셰이더 코드가 없다) - 메인 텍스처와 마스크만 쓴다
    - 덮개 정렬 레이어의 판 중 색 변화 기록이 없는 것: 셰이더 값으로 움직이는 화면 전환이라
      색만으로 그리면 화면을 통째로 덮어 버린다(검은 판 black_bg 는 알파 변화가 기록돼 있어 그린다).

사용법:
    python tools/build_skillcut.py           # 확인만
    python tools/build_skillcut.py --write   # 저장소에 쓴다
"""

import io
import json
import os
import shutil
import sys
from collections import Counter, defaultdict

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
SRC = os.path.join(os.path.dirname(WEB), '리소스', '코스튬')
L2D = os.path.join(WEB, 'l2d')
WRITE = '--write' in sys.argv

OVERLAY_LAYER = 570438649   # 스프라이트 전용 정렬 레이어(값 4) - Spine(레이어 0)보다 나중에 그린다
WEBP = dict(quality=90, method=6, alpha_quality=100, exact=True)
# 셰이더(번들 pathID) → 블렌드. 머티리얼 이름 접미사(_add / _blend)와 1:1 로 맞는 두 셰이더.
SHADER_ADD = 2609380419410529261
SHADER_ALPHA = 4540921370150519042
NEAR = 0.1
AFFINE_TOL = 0.004   # Mesh 입자를 아핀 변환으로 적어도 되는 최대 오차(화면 단위, 세로 반높이 1 기준)

r3 = lambda v: round(float(v), 3)
r4 = lambda v: round(float(v), 4)
r1 = lambda v: round(float(v), 1)


def to_webp(src, dst):
    im = Image.open(src)
    im = im.convert('RGBA')
    buf = io.BytesIO()
    im.save(buf, 'WEBP', **WEBP)
    if WRITE:
        with open(dst, 'wb') as f:
            f.write(buf.getvalue())
    return os.path.getsize(src), len(buf.getvalue())


def convert_set(res, folder, report):
    """skel · atlas · 페이지 그림 한 벌. 반환: 사이트 쪽 파일 이름(확장자 뺀 것)"""
    stem = os.path.splitext(res['skel'])[0]
    sdir = os.path.join(SRC, stem)
    atlas = io.open(os.path.join(sdir, res['atlas']), encoding='utf-8').read()
    for png in res['png']:
        webp = os.path.splitext(png)[0] + '.webp'
        lines = atlas.split('\n')
        hit = [i for i, l in enumerate(lines) if l.strip() == png]
        if not hit:
            raise SystemExit(f'{stem}: atlas 에 페이지 {png} 가 없다')
        for i in hit:
            lines[i] = webp
        atlas = '\n'.join(lines)
        a, b = to_webp(os.path.join(sdir, png), os.path.join(folder, webp))
        report['png'] += a
        report['webp'] += b
    if WRITE:
        shutil.copyfile(os.path.join(sdir, res['skel']), os.path.join(folder, stem + '.skel'))
        with io.open(os.path.join(folder, stem + '.atlas'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(atlas)
    return stem


def frame_of(sp):
    f = sp.get('frame') or {}
    if f.get('static'):
        v = f['value']
        return {'cx': r1(v['centerX_px']), 'cy': r1(v['centerY_px']), 'hh': r1(v['halfHeight_px'])}
    samples = f.get('samples') or []
    # [t, cx, cy, hh] - 30fps 연속 표본이라 사이는 선형으로 잇는다
    return {'samples': [[r3(s['t']), r1(s['centerX_px']), r1(s['centerY_px']), r1(s['halfHeight_px'])] for s in samples]}


def is_add(mat):
    sid = (mat.get('shader') or {}).get('pathID')
    if sid == SHADER_ADD:
        return True
    if sid == SHADER_ALPHA:
        return False
    return (mat.get('blend') or {}).get('nameHint') == 'add' or '_add' in mat.get('name', '')


def st_of(tx):
    st = [r4(tx['scale']['x']), r4(tx['scale']['y']), r4(tx['offset']['x']), r4(tx['offset']['y'])]
    return None if st == [1, 1, 0, 0] else st


def mat_tex(mat, prop):
    for tx in mat.get('textures') or []:
        if tx['prop'] == prop and tx.get('file'):
            return tx
    return None


def vert8(x, y, u, v, rgba):
    return [r3(x), r3(y), r4(u), r4(v)] + [int(c) for c in rgba]


def clip_near(q, tan):
    """3D 회전 Billboard 가 근평면에 걸치면 카메라 공간 꼭짓점(20~31번째 값)으로 근평면에서 잘라 투영한다.
    반환: (꼭짓점 [x,y,u,v,r,g,b,a]..., 삼각형 인덱스) - 다 잘려 나가면 None"""
    pts = [(q[20 + 3 * k], q[21 + 3 * k], q[22 + 3 * k], q[8 + 2 * k], q[9 + 2 * k]) for k in range(4)]
    out = []
    for i, a in enumerate(pts):
        b = pts[(i + 1) % 4]
        if a[2] >= NEAR:
            out.append(a)
        if (a[2] >= NEAR) != (b[2] >= NEAR):
            k = (NEAR - a[2]) / (b[2] - a[2])
            out.append(tuple(a[j] + (b[j] - a[j]) * k for j in range(5)))
    if len(out) < 3:
        return None
    verts = []
    for x, y, z, u, v in out:
        verts += vert8(x / (z * tan), y / (z * tan), u, v, q[16:20])
    return verts, [i for k in range(1, len(out) - 1) for i in (0, k, k + 1)]


def mesh_template(e):
    """Mesh 모드 요소의 기준 모양: 첫 입자의 꼭짓점 uv · 삼각형과, 빠진 꼭짓점이 없는 첫 입자의 화면 xy.
    입자마다 화면 xy 가 이 기준 xy 의 2D 아핀 변환이면 변환값 6개만 적는다(멀리 있는 메시 · 화면 축 회전).
    아니면 화면 xy 만 적는다. uv 는 입자마다 기준 uv 의 배율 · 오프셋(텍스처 시트 칸 · 뒤집기)이어야 한다."""
    parts = [q for _, s in e.get('samples') or [] for q in (s.get('p') or []) if isinstance(q, list)]
    if not parts:
        return None
    n = len(parts[0]) // 8
    if any(len(q) // 8 != n for q in parts):
        return None
    base = next((q for q in parts if all(v is not None for v in q[2::8] + q[3::8])), None)
    if base is None:
        return None
    ref = next((q for q in parts if all(v is not None for v in q[0::8] + q[1::8])), None)
    return {
        'n': n,
        'u': np.array(base[2::8], float), 'v': np.array(base[3::8], float),
        'uv': [r4(v) for pair in zip(base[2::8], base[3::8]) for v in pair],
        'tri': e.get('meshTriangles') or [],
        'ref': None if ref is None else np.array([ref[0::8], ref[1::8]], float).T,
    }


def fit_axis(a, b):
    """b = s·a + o 인 (s, o). 안 맞으면 None"""
    if np.ptp(a) < 1e-6:
        return (1.0, float(b[0] - a[0])) if np.ptp(b) < 1e-3 else None
    sol = np.polyfit(a, b, 1)
    return (float(sol[0]), float(sol[1])) if np.abs(np.polyval(sol, a) - b).max() <= 1e-3 else None


def mesh_common(q, tpl):
    """입자의 색(꼭짓점마다 같아야 한다)과 uv 변환([su, ou, sv, ov], 기준 그대로면 0). 안 맞으면 None"""
    n = tpl['n']
    col = {tuple(q[i * 8 + 4:i * 8 + 8]) for i in range(n)}
    if len(col) != 1:
        return None
    u, v = q[2::8], q[3::8]
    if any(x is None for x in u + v):
        return None
    fu, fv = fit_axis(tpl['u'], np.array(u, float)), fit_axis(tpl['v'], np.array(v, float))
    if not fu or not fv:
        return None
    uvt = [r4(fu[0]), r4(fu[1]), r4(fv[0]), r4(fv[1])]
    return [int(c) for c in col.pop()] + [0 if uvt == [1, 0, 1, 0] else uvt]


def mesh_affine(q, tpl, common):
    """입자 하나를 기준 모양의 아핀 변환으로: [a,b,c, d,e,f, r,g,b,a, uv변환 (, 근평면 뒤 꼭짓점 번호들)]. 안 맞으면 None"""
    n = tpl['n']
    if tpl['ref'] is None:
        return None
    xy = np.array([[np.nan if v is None else v for v in q[0::8]], [np.nan if v is None else v for v in q[1::8]]], float).T
    ok = ~np.isnan(xy[:, 0]) & ~np.isnan(xy[:, 1])
    if ok.sum() < 3:
        return None
    X = np.c_[tpl['ref'], np.ones(n)]
    sol = np.linalg.lstsq(X[ok], xy[ok], rcond=None)[0]
    if np.abs(X[ok] @ sol - xy[ok]).max() > AFFINE_TOL:
        return None
    out = [r4(v) for v in sol.T.reshape(-1)] + common
    if not ok.all():
        out.append([int(i) for i in np.nonzero(~ok)[0]])
    return out


def mesh_xy(q, tpl, common):
    """기준 모양을 쓰는 Mesh 입자를 화면 xy 로: [r,g,b,a, uv변환, x0,y0, x1,y1, ...] (xy 는 1000 배 정수, 근평면 뒤는 null)"""
    out = list(common)
    for i in range(tpl['n']):
        x, y = q[i * 8], q[i * 8 + 1]
        out += [None, None] if x is None or y is None else [round(x * 1000), round(y * 1000)]
    return out


def particle_samples(e, tan, skipped):
    """[t, 사각형들] 또는 [t, 사각형들, {m: 아핀 메시 입자들, x: xy 메시 입자들, v: 꼭짓점들, i: 삼각형}]
    사각형 = 입자마다 xy 8 · uv 8 · rgba 4 (Billboard · Stretch).
    v · i = 그대로 적은 삼각형(기준 모양이 없는 Mesh 입자, 근평면에서 자른 Billboard), 꼭짓점은 [x,y,u,v,r,g,b,a] 씩.
    반환: (줄들, 메시 기준 모양 또는 None)"""
    out = []
    mode = e.get('renderMode')
    tris = e.get('meshTriangles') or []
    tpl = mesh_template(e) if mode == 'Mesh' else None
    for t, s in e.get('samples') or []:
        quads, verts, idx, aff, rxy = [], [], [], [], []

        def add_mesh(vs, ix):
            base = len(verts) // 8
            verts.extend(vs)
            idx.extend(i + base for i in ix)

        for q in s.get('p') or []:
            if isinstance(q, dict):
                skipped['조립 안 된 입자'] += 1
                continue
            if mode == 'Mesh':
                common = mesh_common(q, tpl) if tpl else None
                if common:
                    a = mesh_affine(q, tpl, common)
                    if a:
                        aff.append(a)
                    else:
                        rxy.append(mesh_xy(q, tpl, common))
                    continue
                n = len(q) // 8
                ok = [all(v is not None for v in q[i * 8:i * 8 + 4]) for i in range(n)]
                ix = [tris[j + k] for j in range(0, len(tris), 3) for k in range(3)
                      if all(ok[tris[j + m]] for m in range(3))]
                if not ix:
                    continue
                vs = []
                for i in range(n):
                    a = q[i * 8:i * 8 + 8]
                    vs += vert8(a[0] or 0, a[1] or 0, a[2] or 0, a[3] or 0, a[4:8])
                add_mesh(vs, ix)
            elif len(q) > 20 and any(q[20 + 3 * k + 2] <= NEAR for k in range(4)):
                c = clip_near(q, tan)
                if c:
                    add_mesh(*c)
            elif any(v is None for v in q[:20]):
                # 카메라 공간 값 없이 꼭짓점(근평면 뒤 Stretch)이나 uv 가 비어 있는 입자
                skipped['값 빠진 입자'] += 1
            else:
                # Billboard: 왼위 · 오른위 · 오른아래 · 왼아래 / Stretch: 머리+ · 머리- · 꼬리- · 꼬리+ (둘 다 한 바퀴 도는 순서)
                quads += [r3(v) for v in q[:8]] + [r4(v) for v in q[8:16]] + [int(v) for v in q[16:20]]
        extra = {}
        if aff:
            extra['m'] = aff
        if rxy:
            extra['x'] = rxy
        if idx:
            extra.update(v=verts, i=idx)
        out.append([r3(t), quads, extra] if extra else [r3(t), quads])
    mesh = None
    if tpl and any(len(r) > 2 and ('m' in r[2] or 'x' in r[2]) for r in out):
        mesh = {'uv': tpl['uv'], 'tri': tpl['tri']}
        if tpl['ref'] is not None:
            mesh['ref'] = [r4(v) for v in tpl['ref'].reshape(-1)]
    return out, mesh


def build_code(it, report):
    code = it['code']
    folder = os.path.join(L2D, code, 'skillcut')
    if WRITE:
        os.makedirs(os.path.join(folder, 'el'), exist_ok=True)

    # 파일 세트(같은 skel 을 여러 오브젝트가 쓴다)
    files = {}
    for res in it['resourceFiles']:
        stem = os.path.splitext(res['skel'])[0]
        if stem not in files:
            files[stem] = convert_set(res, folder, report)

    tl = it['timeline']
    length = r3(tl['duration'])

    spines = []
    for sp in it['spines']:
        plays = sp.get('plays') or []
        act = sp.get('activeIntervals') or []
        if not plays or not act or not sp.get('files'):
            continue
        do = sp['drawOrder']
        spines.append({
            'file': os.path.splitext(sp['files']['skel'])[0],
            'name': sp['path'].rsplit('/', 1)[-1],
            'layer': do.get('sortingLayerValue') or 0,
            'order': do.get('sortingOrder') or 0,
            'z': r3(max(do.get('worldZ') or [0])),
            'active': [[r3(a), r3(length if b is None else b)] for a, b in act],
            'plays': [{
                'anim': p['animation'], 'loop': bool(p['loop']),
                'start': r3(p['outerStart']), 'vs': r3(p['outerVisibleStart']), 've': r3(p['outerVisibleEnd']),
                'clipIn': r3(p.get('clipIn') or 0), 'ts': p.get('timeScale') or 1,
            } for p in sorted(plays, key=lambda p: p['outerVisibleStart'])],
            'frame': frame_of(sp),
        })

    # 요소: 파티클 파일이 기준. 스프라이트 그림 파일 이름만 재생 파일에서 가져온다(경로로 찾는다)
    pdata = json.load(io.open(os.path.join(SRC, it['particlesFile']), encoding='utf-8'))
    tan = pdata['camera']['tanHalfFov']
    by_path = defaultdict(list)
    for o in it['otherElements']:
        by_path[o['path']].append(o)

    elements = []
    skipped = Counter()
    edir = os.path.join(SRC, '_skillcut_elements', code)
    converted = set()

    def tex_file(fname):
        if not fname or not os.path.exists(os.path.join(edir, fname)):
            return None
        wname = os.path.splitext(fname)[0] + '.webp'
        if wname not in converted:
            converted.add(wname)
            a, b = to_webp(os.path.join(edir, fname), os.path.join(folder, 'el', wname))
            report['png'] += a
            report['webp'] += b
        return 'el/' + wname

    for e in pdata['elements']:
        name = e['path'].rsplit('/', 1)[-1]
        typ = e['type']
        act = [[r3(a), r3(length if b is None else b)] for a, b in (e.get('activeIntervals') or [])]
        if not act:
            skipped['켜지는 구간 없음'] += 1
            continue
        mat = (e.get('materials') or [None])[0] or {}
        overlay = e.get('sortingLayerID') == OVERLAY_LAYER
        el = {'name': name, 'layer': 4 if overlay else 0, 'order': e.get('sortingOrder') or 0, 'active': act}

        if typ == 'ParticleSystemRenderer':
            if e.get('renderMode') not in ('Billboard', 'Stretch', 'Mesh') or e.get('freeformStretching'):
                skipped[f'파티클 {e.get("renderMode")} 모드' + (' 자유 늘이기' if e.get('freeformStretching') else '')] += 1
                continue
            main = mat_tex(mat, '_MainTex')
            tex = tex_file(main['file']) if main else None
            if not tex:
                skipped['파티클 그림 없음'] += 1
                continue
            rows, mesh = particle_samples(e, tan, skipped)
            el.update(kind='p', tex=tex, p=rows)
            if mesh:
                el['mesh'] = mesh
            if not any(s[1] or len(s) > 2 for s in el['p']):
                skipped['파티클 입자 없음'] += 1
                continue
            st = st_of(main)
        elif typ in ('SpriteRenderer', 'MeshRenderer'):
            quads = e.get('screenQuadChanges') or []
            if not quads:
                skipped['판 위치 없음'] += 1
                continue
            colors = e.get('colorChanges') or []
            if overlay and name != 'black_bg' and len(colors) <= 1:
                skipped[f'셰이더 전환 {name}'] += 1
                continue
            if typ == 'SpriteRenderer':
                src = (by_path.get(e['path']) or [{}])[0]
                main = None
                tex = tex_file(src.get('spriteFile'))
            else:
                main = mat_tex(mat, '_MainTex')
                tex = tex_file(main['file']) if main else None
            if not tex:
                skipped[f'{name}(그림 없음)'] += 1
                continue
            el.update(kind='q', tex=tex,
                      q=[[r3(t), [r3(v) for v in xy]] for t, xy in quads],
                      color=[[r3(t)] + [r3(v) for v in c] for t, c in colors] or [[0, 1, 1, 1, 1]])
            st = st_of(main) if main else None
        else:
            skipped[typ] += 1
            continue

        if st:
            el['st'] = st
        if mat and is_add(mat):
            el['add'] = 1
        mk = mat_tex(mat, '_MaskTex') if mat else None
        if mk:
            mt = tex_file(mk['file'])
            if mt:
                el['mask'] = mt
                if st_of(mk):
                    el['maskSt'] = st_of(mk)
        elements.append(el)

    jump = tl['jump'][0] if tl.get('jump') else None
    # 스킬컷 끝 = 검은 판이 켜지는 시각(없으면 컷신 오브젝트들이 꺼지는 시각)
    black = [e for e in it['otherElements'] if e['path'].endswith('/black_bg') and e.get('activeIntervals')]
    if black:
        cut_end = black[0]['activeIntervals'][0][0]
    else:
        cut_end = min(s['active'][0][1] for s in spines if s['active'][0][0] < 0.5)
    play = {
        'code': code,
        'length': length,
        'jump': {'at': r3(jump['at']), 'to': r3(jump['to'])} if jump else None,
        'cutEnd': r3(cut_end),
        'files': sorted(files.values()),
        'spines': spines,
        'elements': elements,
    }
    text = json.dumps(play, ensure_ascii=False, separators=(',', ':'))
    if WRITE:
        with io.open(os.path.join(folder, 'play.json'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
    report['codes'].append(code)
    report['json'] += len(text)
    kinds = Counter(x['kind'] for x in elements)
    print(f'{code}: Spine {len(spines)} · 판 {kinds["q"]} · 파티클 {kinds["p"]} · play.json {len(text) / 1e6:.2f}MB'
          + (' · 뺀 것 ' + ', '.join(f'{k}×{v}' for k, v in skipped.items()) if skipped else ''))


def main():
    data = json.load(io.open(os.path.join(SRC, '_skillcut_playback.json'), encoding='utf-8'))
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    report = {'png': 0, 'webp': 0, 'json': 0, 'codes': []}
    for it in sorted(data['items'], key=lambda x: x['code']):
        if only and it['code'] not in only:
            continue
        build_code(it, report)
    if WRITE and not only:
        with io.open(os.path.join(L2D, 'skillcut.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(sorted(report['codes']), f)
    print(f'\n{len(report["codes"])}개 · 그림 PNG {report["png"] / 1e6:.1f}MB → WebP {report["webp"] / 1e6:.1f}MB'
          f' · play.json 합계 {report["json"] / 1e6:.1f}MB'
          + ('' if WRITE else '  (확인만 - --write 로 쓴다)'))


if __name__ == '__main__':
    main()
