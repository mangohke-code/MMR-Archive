"""유니크 코스튬 스킬 컷신을 사이트용으로 묶는다 (사용자 요청, 2026-10-12).

입력 (추출 세션이 만든 것, 리소스/코스튬/):
    _skillcut_playback.json          코드별 재생 데이터(바깥 타임라인 30fps, Spine 런타임 · BoneFollower 적용)
    _skillcut_particles/<코드>.json   Spine 이 아닌 렌더러(스프라이트 · 메시 · 파티클)마다 GPU 가 실제로 받은 꼭짓점 입력
                                     (gpu: 월드 좌표 · COLOR · TEXCOORD0~2 · 삼각형), 머티리얼, propertyBlock
    _skillcut_textures.json          텍스처 설정(wrap · filter)과 머티리얼 텍스처 칸 상태(있음 / null / 없음)
    _skillcut_shaders/               게임 셰이더 디스어셈블(js/skillcut.js FX_FS 가 이것을 옮긴 것)
    <skel 이름>/                     .skel · .atlas · .png
    _skillcut_elements/<코드>/        요소 텍스처 PNG

출력 (저장소):
    l2d/<코드>/skillcut/play.json    js/skillcut.js 가 읽는 재생 데이터
    l2d/<코드>/skillcut/*.skel · *.atlas · *.webp   텍스처는 무손실 WebP(원본 픽셀 그대로), atlas 의 페이지 이름도 고친다
    l2d/<코드>/skillcut/el/*.webp     요소 텍스처(무손실 WebP)
    l2d/skillcut.json                컷신이 있는 코드 목록

요소 (play.json elements[]):
    { name, layer, order, active, draws: [{ m: 머티리얼, f: 프레임들 }], pb: propertyBlock 변화 }
    draws 는 렌더러의 머티리얼 칸마다 하나(입자 렌더러는 칸0 = 입자, 칸1 = 트레일). 머티리얼이 null 인 칸은 엔진이 안 그려 뺀다.
    f = [[t, 0 | {n, p, c, u, a, b, nr, i}]] "바뀐 시각만"(그 사이는 앞 값). 0 = 그리는 것 없음.
        p  = 월드 xyz × n (카메라가 원점 · 회전 없음 · +z 라 카메라 공간. 화면 = x / (z · tanHalfFov))
        c  = COLOR 바이트 r,g,b,a — 같은 값이 이어지는 꼭짓점은 [개수, r, g, b, a] 로 묶는다
        u  = TEXCOORD0.xy × n
        a  = TEXCOORD1.xyzw (같은 값 묶음, c 와 같은 방식) / b = TEXCOORD2.x (같은 값 묶음) - add · blend 셰이더만
        nr = 월드 법선(fresnel 만), i = 삼각형(GPU 가 그린 순서)
        p · c · u · a · b · nr · i 가 빠져 있으면 앞 프레임 값 그대로(꼭짓점 수가 같을 때만 빠진다)
    값은 추출 파일(소수 넷째 자리)을 그대로 옮긴다.
    m = { sh, at, tex: {칸: [파일 또는 null, sx, sy, ox, oy, wrapU, wrapV, filter]}, f: {실수 속성}, c: {색 속성}, q: 렌더 큐 }
        sh: add(NK_fx_add_all) · blend(NK_fx_blend_all _FOGOFF_ON) · blendfog(NK_fx_blend_all 안개 변형) ·
            uvadd(NK_fx_uv_add) · uvblend(NK_fx_uv_blend) · b3d(NK_fx_blend_3d) · fresnel(NK_fx_fresnel) · sprite(Sprites/Default)
        텍스처 칸이 없거나 null 이면 셰이더 기본 텍스처(이 셰이더들은 모두 white). _ST 는 칸이 있으면 그 값, 없으면 (1,1,0,0).
    pb = [[t, {color, st: {칸: [sx,sy,ox,oy]}, bloom, tex: {칸: 파일}} 또는 null]] 타임라인이 움직이는 머티리얼 속성.

안개: 전역값(_Global_Fog_Effect_*)을 게임 코드가 넣어 데이터로 정할 수 없어, 사용자 결정(2026-10-13)으로 안개 비율 1(안개 없음)로 그린다.
후처리: 사용자 결정(2026-10-13)으로 넣지 않는다.

사용법:
    python tools/build_skillcut.py [코드 ...]           # 확인만
    python tools/build_skillcut.py --write [코드 ...]   # 저장소에 쓴다
"""

import io
import json
import os
import shutil
import sys
from collections import Counter

from PIL import Image

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
SRC = os.path.join(os.path.dirname(WEB), '리소스', '코스튬')
L2D = os.path.join(WEB, 'l2d')
WRITE = '--write' in sys.argv

OVERLAY_LAYER = 570438649   # 스프라이트 전용 정렬 레이어(값 4) - Spine(레이어 0)보다 나중에 그린다
WEBP = dict(lossless=True, method=6, exact=True)

r3 = lambda v: round(float(v), 3)
r4 = lambda v: round(float(v), 4)
r1 = lambda v: round(float(v), 1)

# 셰이더 이름 → 사이트 셰이더 이름(js/skillcut.js FX_MODE 와 짝)
SHADERS = {
    'NK/Unlit/FX/NK_fx_add_all': 'add',
    'NK/Unlit/FX/NK_fx_blend_all': 'blend',
    'NK/Unlit/FX/NK_fx_uv_add': 'uvadd',
    'NK/Unlit/FX/NK_fx_uv_blend': 'uvblend',
    'NK/Unlit/FX/NK_fx_blend_3d': 'b3d',
    'NK/Unlit/FX/NK_fx_fresnel': 'fresnel',
    'Sprites/Default': 'sprite',
}
TEX_PROPS = {'_MainTex': 'main', '_MaskTex': 'mask', '_DissolveTex': 'dis', '_NoiseTex': 'noise', '_UVMaskTex': 'uvm'}
FLOAT_PROPS = {
    '_UVRotation': 'rot', '_NoiseAmount': 'noise', '_CutOut': 'cut', '_BloomIntensity': 'bloom',
    '_OverlayOpacity': 'ovo', '_CustomData_Offset': 'cdO', '_CustomData_Intensity': 'cdI',
    '_CustomData_Dissolve': 'cdD', '_CustomData_Distortion': 'cdT', '_Fog_BloomIntensity': 'fogBloom',
    '_LightenOpacity': 'lo', '_Power': 'power', '_GlowPower': 'glow', '_ZTest': 'ztest',
}
COLOR_PROPS = {'_Color': 'color', '_OverlayColor': 'ov', '_LightenColor': 'lc', '_GlowColor': 'gc',
               '_RendererColor': 'rc'}
SHADER_QUEUE = {'b3d': 2450}   # 셰이더 태그 Queue(AlphaTest = 2450). 나머지는 Transparent = 3000
WRAP = {'Repeat': 0, 'Clamp': 1, 'Mirror': 2, 'MirrorOnce': 3}
FILTER = {'Point': 0, 'Bilinear': 1, 'Trilinear': 1}


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


def runs(vals, k, conv):
    """k 개씩 끊은 값을 같은 값끼리 묶는다: [개수, v1..vk, 개수, ...]"""
    out = []
    prev, cnt = None, 0
    for i in range(0, len(vals), k):
        cur = [conv(v) for v in vals[i:i + k]]
        if cur == prev:
            cnt += 1
            continue
        if prev is not None:
            out += [cnt] + prev
        prev, cnt = cur, 1
    if prev is not None:
        out += [cnt] + prev
    return out


def frame_data(s, sh, prev):
    """GPU 드로우 한 칸 → 사이트 형식. prev(앞 프레임 원값)와 같은 채널은 뺀다. 반환 (사이트 값, 이번 원값)"""
    n = s.get('n') or 0
    if not n:
        return 0, None
    t0 = s['t0']
    cur = {
        'p': [r4(v) for v in s['pos']],
        'c': runs(s['col'], 4, lambda v: int(round(v * 255))),
        'u': [r4(v) for i, v in enumerate(t0) if i % 4 < 2],
        'i': list(s['idx']),
    }
    if sh in ('add', 'blend', 'blendfog'):
        cur['a'] = runs(s['t1'], 4, r4)
        cur['b'] = runs(s['t2'][0::4], 1, r4)
    if sh == 'fresnel':
        cur['nr'] = [r4(v) for v in s['nrm']]
    out = {'n': n}
    same = prev is not None and prev['n'] == n
    for k, v in cur.items():
        if not (same and prev.get(k) == v):
            out[k] = v
    cur['n'] = n
    return out, cur


def build_code(it, report, texinfo):
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

    pdata = json.load(io.open(os.path.join(SRC, it['particlesFile']), encoding='utf-8'))
    edir = os.path.join(SRC, '_skillcut_elements', code)
    texenv = texinfo['materials'].get(code, {})
    textures = texinfo['textures']
    converted = set()
    skipped = Counter()

    def tex_file(name):
        """텍스처 이름 → 사이트 파일(el/<이름>.webp). 없으면 None"""
        if not name:
            return None
        src = os.path.join(edir, name + '.png')
        if not os.path.exists(src):
            return None
        wname = name + '.webp'
        if wname not in converted:
            converted.add(wname)
            a, b = to_webp(src, os.path.join(folder, 'el', wname))
            report['png'] += a
            report['webp'] += b
        return 'el/' + wname

    def tex_entry(name, st):
        ti = textures.get(name) or {}
        f = tex_file(name)
        if name and not f:
            raise SystemExit(f'{code}: 텍스처 {name} PNG 없음')
        return [f] + [r4(v) for v in st] + [WRAP.get(ti.get('wrapU'), 0), WRAP.get(ti.get('wrapV'), 0),
                                           FILTER.get(ti.get('filter'), 1)]

    def material_of(mat):
        name = mat.get('shaderName')
        sh = SHADERS.get(name)
        if not sh:
            return None, f'셰이더 {name}'
        kw = set(mat.get('keywords') or [])
        if sh == 'blend' and '_FOGOFF_ON' not in kw:
            sh = 'blendfog'
        # 텍스처 칸: _skillcut_textures.json 의 칸 상태(texture / null / missing-ref)
        envs = (texenv.get(mat.get('name')) or {}).get('texEnvs')
        if envs is None:
            raise SystemExit(f'{code}: 머티리얼 {mat.get("name")} 텍스처 칸 정보 없음')
        tex = {}
        for te in envs:
            key = TEX_PROPS.get(te['prop'])
            if not key:
                continue
            tname = te['texture'] if te['state'] == 'texture' else None
            tex[key] = tex_entry(tname, te['scale'] + te['offset'])
        fl = mat.get('floats') or {}
        co = mat.get('colors') or {}
        m = {'sh': sh, 'tex': tex,
             'f': {k: r4(fl[p]) for p, k in FLOAT_PROPS.items() if p in fl},
             'c': {k: [r4(co[p][c]) for c in 'rgba'] for p, k in COLOR_PROPS.items() if p in co},
             'q': mat.get('renderQueue') if (mat.get('renderQueue') or -1) >= 0 else SHADER_QUEUE.get(sh, 3000)}
        if '_ALPHATEST_ON' in kw and sh in ('add', 'blend', 'blendfog'):
            m['at'] = 1
        return m, None

    def sprite_material():
        sd = texinfo['spritesWithoutBundleMaterial']
        if sd.get('shader') != 'Sprites/Default':
            raise SystemExit(f'{code}: 머티리얼 없는 스프라이트 셰이더가 Sprites/Default 가 아니다')
        return {'sh': 'sprite', 'tex': {}, 'f': {}, 'c': {}, 'q': 3000}

    def pb_rows(e):
        rows = []
        for t, v in e.get('propertyBlock') or []:
            if not v or v.get('_onlyOtherEntries'):
                ent = None
            else:
                ent = {}
                for k, val in v.items():
                    if k == '_Color':
                        ent['color'] = [r4(x) for x in val]
                    elif k == '_BloomIntensity':
                        ent['bloom'] = r4(val)
                    elif k.endswith('_ST') and TEX_PROPS.get(k[:-3]):
                        ent.setdefault('st', {})[TEX_PROPS[k[:-3]]] = [r4(x) for x in val]
                    elif TEX_PROPS.get(k) and isinstance(val, dict):
                        f = tex_file(val.get('texture'))
                        if val.get('texture') and not f:
                            raise SystemExit(f'{code}: propertyBlock 텍스처 {val.get("texture")} PNG 없음')
                        ent.setdefault('tex', {})[TEX_PROPS[k]] = f
                ent = ent or None
            if rows and rows[-1][1] == ent:
                continue
            rows.append([r3(t), ent])
        return rows if any(r[1] for r in rows) else []

    elements = []
    for e in pdata['elements']:
        name = e['path'].rsplit('/', 1)[-1]
        act = [[r3(a), r3(length if b is None else b)] for a, b in (e.get('activeIntervals') or [])]
        gpu = e.get('gpu') or []
        if not act or not gpu:
            skipped['켜지는 구간 · 그림 없음'] += 1
            continue
        mats = {m.get('slot', 0): m for m in e.get('materials') or []}
        slots = e.get('materialSlots') or [None]
        draws = []
        for k, slot_name in enumerate(slots):
            if e['type'] == 'SpriteRenderer' and not mats:
                m = sprite_material()
            elif slot_name is None or k not in mats:
                continue              # 빈 칸은 엔진이 안 그린다
            else:
                m, why = material_of(mats[k])
                if not m:
                    skipped[why] += 1
                    continue
            frames, prev = [], None
            for t, ds in gpu:
                s = ds[k] if k < len(ds) else None
                fd, cur = frame_data(s or {}, m['sh'], prev)
                prev = cur
                if frames and fd == 0 and frames[-1][1] == 0:
                    continue
                frames.append([r3(t), fd])
            if any(f[1] for f in frames):
                draws.append({'m': m, 'f': frames})
        if not draws:
            skipped['그리는 칸 없음'] += 1
            continue
        el = {'name': name, 'layer': 4 if e.get('sortingLayerID') == OVERLAY_LAYER else 0,
              'order': e.get('sortingOrder') or 0, 'active': act, 'draws': draws}
        if e.get('sortingFudge'):
            el['fudge'] = r3(e['sortingFudge'])
        pb = pb_rows(e)
        if pb:
            el['pb'] = pb
        elements.append(el)

    jump = tl['jump'][0] if tl.get('jump') else None
    # 스킬컷 끝 = 검은 판이 켜지는 시각(없으면 컷신 오브젝트들이 꺼지는 시각)
    black = [e for e in pdata['elements'] if e['path'].endswith('/black_bg') and e.get('activeIntervals')]
    if black:
        cut_end = black[0]['activeIntervals'][0][0]
    else:
        cut_end = min(s['active'][0][1] for s in spines if s['active'][0][0] < 0.5)
    play = {
        'code': code,
        'length': length,
        'jump': {'at': r3(jump['at']), 'to': r3(jump['to'])} if jump else None,
        'cutEnd': r3(cut_end),
        'tanHalfFov': pdata['camera']['tanHalfFov'],
        'near': pdata['camera'].get('near', 0.1),
        'far': pdata['camera'].get('far', 800),
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
    shs = Counter(d['m']['sh'] for x in elements for d in x['draws'])
    print(f'{code}: Spine {len(spines)} · 요소 {len(elements)} ({", ".join(f"{k} {v}" for k, v in shs.items())})'
          f' · play.json {len(text) / 1e6:.2f}MB'
          + (' · 뺀 것 ' + ', '.join(f'{k}×{v}' for k, v in skipped.items()) if skipped else ''))


def main():
    data = json.load(io.open(os.path.join(SRC, '_skillcut_playback.json'), encoding='utf-8'))
    texinfo = json.load(io.open(os.path.join(SRC, '_skillcut_textures.json'), encoding='utf-8'))
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    report = {'png': 0, 'webp': 0, 'json': 0, 'codes': []}
    for it in sorted(data['items'], key=lambda x: x['code']):
        if only and it['code'] not in only:
            continue
        build_code(it, report, texinfo)
    if WRITE and not only:
        with io.open(os.path.join(L2D, 'skillcut.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(sorted(report['codes']), f)
    print(f'\n{len(report["codes"])}개 · 그림 PNG {report["png"] / 1e6:.1f}MB → WebP {report["webp"] / 1e6:.1f}MB'
          f' · play.json 합계 {report["json"] / 1e6:.1f}MB'
          + ('' if WRITE else '  (확인만 - --write 로 쓴다)'))


if __name__ == '__main__':
    main()
