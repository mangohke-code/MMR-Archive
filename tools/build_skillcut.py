"""유니크 코스튬 스킬 컷신을 사이트용으로 묶는다 (사용자 요청, 2026-10-12).

입력 (추출 세션이 만든 것, 리소스/코스튬/):
    _skillcut_playback.json          코드별 재생 데이터(라이브 월페이퍼 타임라인 30fps 표본)
    <skel 이름>/                     .skel · .atlas · .png
    _skillcut_elements/<코드>/        Spine 이 아닌 그림(배경 스프라이트 · 검은 판 등)

출력 (저장소):
    l2d/<코드>/skillcut/play.json    js/skillcut.js 가 읽는 재생 데이터(필요한 값만)
    l2d/<코드>/skillcut/*.skel · *.atlas · *.webp   텍스처는 WebP(q90, 알파 무손실)로 바꾸고 atlas 의 페이지 이름도 고친다
    l2d/<코드>/skillcut/el/*.webp     요소 그림
    l2d/skillcut.json                컷신이 있는 코드 목록

WebP 는 c016_01 로 PNG 와 렌더 결과를 비교해 정했다(q90: 평균 차이 2/255, 3배 확대에서도 구분 안 됨, 용량 -74%).

못 그리는 것은 뺀다:
    - 파티클(그림 파일 없음), SkinnedMeshRenderer(메시가 번들 밖)
    - 덮개 정렬 레이어의 'blend_plane' 처럼 색 변화 기록이 없는 판: 셰이더 값으로 움직이는 화면 전환이라
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
from collections import Counter

from PIL import Image

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
SRC = os.path.join(os.path.dirname(WEB), '리소스', '코스튬')
L2D = os.path.join(WEB, 'l2d')
WRITE = '--write' in sys.argv

OVERLAY_LAYER = 570438649   # 스프라이트 전용 정렬 레이어(값 4) - Spine(레이어 0)보다 나중에 그린다
WEBP = dict(quality=90, method=6, alpha_quality=100, exact=True)

r3 = lambda v: round(float(v), 3)
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


def element_texture(e):
    if e['type'] == 'SpriteRenderer':
        return e.get('spriteFile')
    files = e.get('textureFiles') or []
    return files[0] if files else None


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
            'active': [[r3(a), r3(b)] for a, b in act],
            'plays': [{
                'anim': p['animation'], 'loop': bool(p['loop']),
                'start': r3(p['outerStart']), 'vs': r3(p['outerVisibleStart']), 've': r3(p['outerVisibleEnd']),
                'clipIn': r3(p.get('clipIn') or 0), 'ts': p.get('timeScale') or 1,
            } for p in sorted(plays, key=lambda p: p['outerVisibleStart'])],
            'frame': frame_of(sp),
        })

    elements = []
    skipped = []
    edir = os.path.join(SRC, '_skillcut_elements', code)
    for e in it['otherElements']:
        name = e['path'].rsplit('/', 1)[-1]
        if e['type'] not in ('SpriteRenderer', 'MeshRenderer'):
            skipped.append(e['type'])
            continue
        act = e.get('activeIntervals') or []
        rects = e.get('screenRectChanges') or []
        tex = element_texture(e)
        if not act or not rects or not tex:
            skipped.append('구간·위치·그림 없음')
            continue
        colors = e.get('colorChanges') or []
        overlay = e.get('sortingLayerID') == OVERLAY_LAYER
        if overlay and name != 'black_bg' and len(colors) <= 1:
            skipped.append(f'셰이더 전환 {name}')
            continue
        if not os.path.exists(os.path.join(edir, tex)):
            skipped.append(f'{name}(그림 파일 {tex} 없음)')
            continue
        wname = os.path.splitext(tex)[0] + '.webp'
        if not os.path.exists(os.path.join(folder, 'el', wname)) or not WRITE:
            a, b = to_webp(os.path.join(edir, tex), os.path.join(folder, 'el', wname))
            report['png'] += a
            report['webp'] += b
        if e['type'] == 'SpriteRenderer':
            color = [[r3(c['t'])] + [r3(v) for v in c['rgba']] for c in colors] or [[0, 1, 1, 1, 1]]
        else:
            color = [[0, 1, 1, 1, 1]]
        elements.append({
            'name': name,
            'tex': 'el/' + wname,
            'layer': 4 if overlay else 0,
            'order': e.get('sortingOrder') or 0,
            'active': [[r3(a), r3(b)] for a, b in act],
            'color': color,
            'rect': [[r3(r['t']), r3(r['screen']['x'][0]), r3(r['screen']['x'][1]),
                      r3(r['screen']['y'][0]), r3(r['screen']['y'][1])] for r in rects],
        })

    tl = it['timeline']
    jump = tl['jump'][0] if tl.get('jump') else None
    # 스킬컷 끝 = 검은 판이 켜지는 시각(없으면 컷신 오브젝트들이 꺼지는 시각)
    black = [e for e in it['otherElements'] if e['path'].endswith('/black_bg') and e.get('activeIntervals')]
    if black:
        cut_end = black[0]['activeIntervals'][0][0]
    else:
        cut_end = min(s['active'][0][1] for s in spines if s['active'][0][0] < 0.5)
    play = {
        'code': code,
        'length': r3(tl['duration']),
        'jump': {'at': r3(jump['at']), 'to': r3(jump['to'])} if jump else None,
        'cutEnd': r3(cut_end),
        'files': sorted(files.values()),
        'spines': spines,
        'elements': elements,
    }
    if WRITE:
        with io.open(os.path.join(folder, 'play.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(play, f, ensure_ascii=False, separators=(',', ':'))
    report['codes'].append(code)
    moving = sum(1 for s in spines if 'samples' in s['frame'])
    print(f'{code}: 파일 {len(files)} · Spine {len(spines)}(움직임 {moving}) · 요소 {len(elements)}'
          f' · 컷 끝 {cut_end} · 반복 {play["jump"]}'
          + (' · 뺀 것 ' + ', '.join(f'{k}×{v}' for k, v in Counter(skipped).items()) if skipped else ''))


def main():
    data = json.load(io.open(os.path.join(SRC, '_skillcut_playback.json'), encoding='utf-8'))
    report = {'png': 0, 'webp': 0, 'codes': []}
    for it in sorted(data['items'], key=lambda x: x['code']):
        build_code(it, report)
    if WRITE:
        with io.open(os.path.join(L2D, 'skillcut.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(sorted(report['codes']), f)
    print(f'\n{len(report["codes"])}개 · 그림 PNG {report["png"] / 1e6:.1f}MB → WebP {report["webp"] / 1e6:.1f}MB'
          + ('' if WRITE else '  (확인만 - --write 로 쓴다)'))


if __name__ == '__main__':
    main()
