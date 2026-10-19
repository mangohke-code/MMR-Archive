"""보스 등장 연출 효과를 사이트용으로 묶는다 - 모더니아 첫 등장(사용자 요청, 2026-10-20).

입력 (추출 세션이 만든 것, 리소스/보스/S<n> 모더니아/_등장연출_효과/):
    <코드>.json                 스킬 컷신 _skillcut_particles 형식. 다른 점: 좌표가 월드 그대로이고 카메라가 움직인다(cameraTrack),
                                60fps, drawOrder 에 3D 모델('model:k')이 들어 있다
    _skillcut_elements/<코드>/   요소 텍스처 PNG
    _skillcut_textures.json      텍스처 설정 · 머티리얼 칸 상태
    Spine 원본(.skel · .atlas · .png)은 리소스/보스/S6 모더니아/mbg004_모더니아(사용자가 뽑음)

하는 일:
    1) 매 프레임 효과 꼭짓점 · 법선과 Spine 월드 행렬을 그 프레임 카메라 공간(카메라 원점 · +z 앞)으로 옮긴다.
       스킬 컷신 렌더러(js/skillcut.js)는 '카메라 원점 · 회전 없음' 좌표를 그대로 투영한다(화면 = x / (z · tanHalfFov)).
       프레넬 시선(카메라 - 월드)도 카메라 공간에서 같은 값이 된다. 빌보드 입자는 그 프레임 카메라로 엔진이 만든 꼭짓점이다.
    2) tools/build_skillcut.py 의 build_code 로 같은 형식(play.json.gz · skel · atlas · webp)을 만든다.
       3D 모델 드로우는 사이트가 3D 뷰어로 따로 그려서 뺀다(이 연출 동안 모델은 화면 밖 - 효과 끈 기준 화면이 Spine 구간 빼고 전부 검정).

출력: img/boss-fx/<코드>/skillcut/ · 요소 텍스처 img/boss-fx/el/

사용법:
    python tools/build_bossfx.py            # 확인만
    python tools/build_bossfx.py --write    # 저장소에 쓴다
"""

import io
import json
import math
import os
import shutil
import sys

import build_skillcut as bs

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
BOSS = os.path.join(os.path.dirname(WEB), '리소스', '보스')
SPINE_SRC = os.path.join(BOSS, 'S6 모더니아', 'mbg004_모더니아')
STAGE = os.path.join(WEB, '_local', 'bossfx_src')     # build_code 가 읽는 폴더 구성(깃 제외)
OUT = os.path.join(WEB, 'img', 'boss-fx')

# 코드, 효과 폴더, Spine 파일 이름. 연출 길이 = 바깥 타임라인 FixedLength(추출 실측 10.3667초)
JOBS = [
    ('mbg004', os.path.join(BOSS, 'S6 모더니아', '_등장연출_효과'), 'mbg004_appearance'),
    ('mbg004_anmi', os.path.join(BOSS, 'S21 모더니아', '_등장연출_효과'), 'mbg004_anmi_appearance'),
]
LENGTH = 10.3666667
SPINE_SCALE = 0.01        # SkeletonDataAsset scale(추출 실측, 두 시즌 같음)


def cam_rows(track):
    rows = sorted(([t, v['world'], v['fieldOfView'], v['near'], v['far']] for t, v in track), key=lambda r: r[0])
    fovs = {round(r[2], 4) for r in rows}
    if len(fovs) != 1:
        raise SystemExit(f'화각이 바뀐다 {fovs} - 렌더러는 화각 하나를 전제로 한다')
    return rows


def cam_at(rows, t):
    cur = rows[0]
    for r in rows:
        if r[0] <= t + 1e-6:
            cur = r
        else:
            break
    return cur


def to_cam(m):
    """카메라 → 월드 행렬(행우선) 에서 월드 → 카메라 변환 함수(점 · 방향)"""
    cols = [(m[0], m[4], m[8]), (m[1], m[5], m[9]), (m[2], m[6], m[10])]
    c = (m[3], m[7], m[11])
    dot = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    pt = lambda p: [dot(cols[0], (p[0] - c[0], p[1] - c[1], p[2] - c[2])),
                    dot(cols[1], (p[0] - c[0], p[1] - c[1], p[2] - c[2])),
                    dot(cols[2], (p[0] - c[0], p[1] - c[1], p[2] - c[2]))]
    dr = lambda v: [dot(cols[0], v), dot(cols[1], v), dot(cols[2], v)]
    inv = [cols[0][0], cols[0][1], cols[0][2], -dot(cols[0], c),
           cols[1][0], cols[1][1], cols[1][2], -dot(cols[1], c),
           cols[2][0], cols[2][1], cols[2][2], -dot(cols[2], c),
           0, 0, 0, 1]
    return pt, dr, inv


def mul4(a, b):
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]


def with_camera_rows(gpu, cam_times):
    """gpu 는 월드 좌표가 바뀐 프레임만 있다. 카메라 공간에서는 카메라가 바뀐 프레임에도 값이 바뀌므로
    그 프레임마다 직전 월드 값을 다시 넣는다(그리는 것이 없는 프레임은 그대로 둔다)"""
    if not gpu:
        return gpu
    out = []
    times = sorted({r[0] for r in gpu} | {t for t in cam_times if t >= gpu[0][0]})
    gi = 0
    for t in times:
        while gi + 1 < len(gpu) and gpu[gi + 1][0] <= t + 1e-6:
            gi += 1
        out.append([t, json.loads(json.dumps(gpu[gi][1]))])
    return out


def to_camera_space(pdata):
    rows = cam_rows(pdata['cameraTrack'])
    cam_times = [r[0] for r in rows]
    n_pts = 0
    for e in pdata['elements']:
        for key in ('gpu', 'gpuLoop'):
            e[key] = with_camera_rows(e.get(key), cam_times)
            for t, slots in e.get(key) or []:
                pt, dr, _ = to_cam(cam_at(rows, t)[1])
                for s in slots or []:
                    if not s or not s.get('n'):
                        continue
                    p = s['pos']
                    s['pos'] = [v for i in range(0, len(p), 3) for v in pt(p[i:i + 3])]
                    n_pts += len(p) // 3
                    if s.get('nrm'):
                        q = s['nrm']
                        s['nrm'] = [v for i in range(0, len(q), 3) for v in dr(q[i:i + 3])]
    # Spine 월드 행렬: 그 행이 바뀐 시각과 카메라가 바뀐 시각마다 카메라 공간 행렬을 다시 낸다
    for sr in pdata.get('spineRenderers') or []:
        world = sorted(sr.get('world') or [], key=lambda r: r[0])
        if not world:
            continue
        times = sorted({w[0] for w in world} | {r[0] for r in rows if r[0] >= world[0][0]})
        out = []
        for t in times:
            w = [x for x in world if x[0] <= t + 1e-6][-1][1]
            out.append([t, mul4(to_cam(cam_at(rows, t)[1])[2], w)])
        sr['world'] = out
    fov = rows[0][2]
    pdata['camera'] = {'tanHalfFov': math.tan(math.radians(fov) / 2), 'near': rows[0][3], 'far': rows[0][4]}
    return n_pts


def stage(code, src, stem):
    """build_code 가 기대하는 폴더 구성: <코드>.json(카메라 공간) · _skillcut_elements/<코드>/ · <스켈>/"""
    root = os.path.join(STAGE, code)
    if os.path.isdir(root):
        shutil.rmtree(root)
    os.makedirs(os.path.join(root, stem))
    shutil.copytree(os.path.join(src, '_skillcut_elements', code), os.path.join(root, '_skillcut_elements', code))
    for ext in ('.skel', '.atlas', '.png'):
        shutil.copyfile(os.path.join(SPINE_SRC, stem + ext), os.path.join(root, stem, stem + ext))
    pdata = json.load(io.open(os.path.join(src, code + '.json'), encoding='utf-8'))
    n = to_camera_space(pdata)
    with io.open(os.path.join(root, code + '.json'), 'w', encoding='utf-8') as f:
        json.dump(pdata, f, ensure_ascii=False, separators=(',', ':'))
    return root, pdata, n


def main():
    bs.WRITE = '--write' in sys.argv
    bs.L2D = OUT
    bs.EL_DIR = os.path.join(OUT, 'el')
    report = {'png': 0, 'webp': 0, 'json': 0, 'codes': []}
    for code, src, stem in JOBS:
        root, pdata, n = stage(code, src, stem)
        bs.SRC = root
        texinfo = json.load(io.open(os.path.join(src, '_skillcut_textures.json'), encoding='utf-8'))
        st = pdata['shaderTimes'][0] - pdata['playback']['frameTimes'][0]
        spines = []
        for sr in pdata['spineRenderers']:
            names = {e[2] for _, ents in sr.get('anim') or [] if isinstance(ents, list) for e in ents}
            if len(names) != 1:
                raise SystemExit(f'{code}: Spine 애니메이션이 하나가 아니다 {names}')
            start = sr['activeIntervals'][0][0]
            bs.DATA_SCALE[sr['path']] = SPINE_SCALE
            spines.append({
                'path': sr['path'],
                'plays': [{'animation': names.pop(), 'loop': False, 'outerStart': start, 'outerVisibleStart': start,
                           'outerVisibleEnd': LENGTH, 'clipIn': 0, 'timeScale': 1}],
                'activeIntervals': sr['activeIntervals'],
                'files': {'skel': stem + '.skel', 'atlas': stem + '.atlas', 'png': [stem + '.png']},
                'drawOrder': {'sortingLayerValue': 0, 'sortingOrder': 0, 'worldZ': [sr['world'][0][1][11]]},
                'frame': {'static': True, 'value': {'centerX_px': 0, 'centerY_px': 0, 'halfHeight_px': 1}},
            })
        it = {
            'code': code,
            'resourceFiles': [{'skel': stem + '.skel', 'atlas': stem + '.atlas', 'png': [stem + '.png']}],
            'timeline': {'duration': LENGTH},
            'spines': spines,
            'particlesFile': code + '.json',
            'cutEnd': LENGTH,
            # 셰이더 시간(_TimeParameters.x = Time.time) - 타임라인 시각 차이(실측 매 프레임 같음)
            'playExtra': {'shaderT0': round(st, 4)},
        }
        print(f'{code}: 꼭짓점 {n} 개를 카메라 공간으로')
        bs.build_code(it, report, texinfo)
    print(f'\n{len(report["codes"])}개 · 그림 PNG {report["png"] / 1e6:.1f}MB → WebP {report["webp"] / 1e6:.1f}MB'
          f' · 재생 데이터(gzip) 합계 {report["json"] / 1e6:.1f}MB' + ('' if bs.WRITE else '  (확인만 - --write 로 쓴다)'))


if __name__ == '__main__':
    main()
