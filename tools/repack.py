"""재언팩된 원본 glb 를 웹용으로 압축한다.

파이프라인: gltf-transform resample -> prune -> draco -> glb_webp.py
파일 이름에 공백·중점(·)·한글이 섞여 있어서 셸로 돌리면 인용이 계속 깨진다.
그래서 목록을 여기 적고 파이썬에서 직접 호출한다.
"""
import json
import os
import struct
import shutil
import subprocess
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(BASE, '이미지', '보스')
UPLOAD = os.path.join(BASE, '업로드용 보스 3D')
LOCAL = os.path.join(BASE, '정보모음-web', 'img', 'boss')
WEBP = os.path.join(BASE, '정보모음-web', 'tools', 'glb_webp.py')

# (원본 상대경로, 출력 이름)
JOBS = [
    # 2026-09-13, 추출 프로그램이 갱신되면서 원본을 전부 새로 뽑았다.
    # 카메라 노드가 연출별로 갈라지고 pairedClip·cutTimes 가 붙었다.
    # 원본은 시즌 폴더가 아니라 이 폴더 하나에 모여 있다.
    ('추출프로그램 업데이트 이후/eba001_스톰브링어 A.N.M.I.glb', 'eba001'),
    ('추출프로그램 업데이트 이후/mbg002_그레이브 디거 raid.glb', 'mbg002'),
    ('추출프로그램 업데이트 이후/xba002_퀸 001 D.M.T.R.glb', 'xba002'),
    ('추출프로그램 업데이트 이후/xba001_미러 컨테이너.glb', 'xba001'),
    # 2026-09-16, 추출 프로그램이 "클립 많은 리그가 기본 이름을 갖는다" 로 바뀌면서
    # 베히모스 두 파일의 내용이 서로 뒤바뀌었다. 기본 이름 쪽이 2페이즈(클립 34개)고
    # _mbg003_psid 쪽이 1페이즈(클립 7개)다. 애니힐리오도 같이 뒤바뀌었지만 그쪽은
    # 둘을 합쳐 쓰므로 결과가 같다.
    ('추출프로그램 업데이트 이후/mbg003_베히모스 P.S.I.D_mbg003_psid.glb', 'mbg003_1phase'),
    ('추출프로그램 업데이트 이후/mbg003_베히모스 P.S.I.D.glb', 'mbg003_2phase'),
    # 검은 뱀은 스팟 번들이 둘인데, 카메라 셋은 본 번들에만 있다.
    # " · summon" 변형에는 카메라 클립이 아예 없어서 본 번들을 쓴다
    # (메쉬·재질·스킨·모델 클립 27개는 양쪽이 같다).
    ('추출프로그램 업데이트 이후/bbg008_검은 뱀 H.S.T.A.glb', 'bbg008'),
    # 거대 질량체 두 마리는 예전에 이 목록에 없었다(다른 경로로 만들어 올린 듯하다).
    ('추출프로그램 업데이트 이후/eba004_거대 질량체.glb', 'eba004'),
    ('추출프로그램 업데이트 이후/eba004_거대 질량체Q.glb', 'eba004_dmtr'),
    ('추출프로그램 업데이트 이후/xbg002_프로비던스 Z.E.U.S.glb', 'xbg002'),
    ('추출프로그램 업데이트 이후/xbg003_온리 원 H.S.T.A.glb', 'xbg003'),
    ('추출프로그램 업데이트 이후/xbg004_앨트루이아 Z.E.U.S.glb', 'xbg004'),
    ('추출프로그램 업데이트 이후/xbg005_에고비스타 P.S.I.D.glb', 'xbg005'),
    # 아일랜드 이터는 랜드 이터(ebg001)의 변종이다. 사치스러운 거미와 같은 이유로
    # 출력 이름에 변종을 적는다.
    ('추출프로그램 업데이트 이후/ebg001_아일랜드 이터.glb', 'ebg001_island'),
    # 사치스러운 거미는 하베스터(bbg001)의 변종이라 메쉬 이름이 원종과 같다.
    # 뷰어가 규칙을 파일 이름으로 가르므로 출력 이름에 변종을 적어 둔다.
    ('추출프로그램 업데이트 이후/bbg001_사치스러운 거미.glb', 'bbg001_rich'),
    # 애니힐리오는 1·2페이즈를 한 파일로 합친다. 페이즈 전환 연출이 두 파일에
    # 걸쳐 있어서, 나눠 두면 전환할 때마다 모델을 새로 받느라 연출이 끊긴다.
    # 두 파일은 노드·클립·메쉬 이름이 하나도 안 겹쳐서 그냥 붙이면 된다.
    (['추출프로그램 업데이트 이후/xba003_애니힐리오 D.M.T.R.glb',
      '추출프로그램 업데이트 이후/xba003_애니힐리오 D.M.T.R_xba003_dmtr.glb'], 'xba003'),
    # 리버렐리오 바디는 리그가 셋이다 - 1페이즈 몸, 2페이즈 몸, 해파리.
    # 2페이즈 전환이 셋을 같은 6.667 초에 동시에 돌리므로 한 파일로 합친다.
    # 해파리는 노드·클립·메쉬 이름이 나머지 둘과 하나도 안 겹친다.
    # 애니힐리오와 달리 1·2페이즈끼리는 63개가 겹치는데, 겹치는 것은 전부
    # 뼈와 fx 노드(parts_col_01~15 등)라 화면에 영향이 없다. 진짜 문제는
    # 카메라 하나뿐이고 그건 RENAMES 가 처리한다.
    (['추출프로그램 업데이트 이후/eba002_eba002 H.S.T.A.glb',
      '추출프로그램 업데이트 이후/eba002_eba002 H.S.T.A_eba002_hsta.glb',
      '추출프로그램 업데이트 이후/eba002_eba002 H.S.T.A_eba002_jellyfish_obj_var.glb'],
     'eba002'),
]

# 합치기 전에 이름을 갈아 둘 것. { 원본 상대경로: { 옛 이름: 새 이름 } }
#
# 리버렐리오 2페이즈 등장 카메라가 양쪽 파일에 같은 이름으로 한 번씩 실린다.
# 추출 규칙이 "카메라는 짝이 그 파일에 있을 때만 담는다" 인데, 전환 연출이 리그
# 둘을 동시에 돌려서 짝이 양쪽에 하나씩 있기 때문이다. 값은 201프레임 전부
# 똑같고 pairedClip 만 다르다(01 = 1페이즈 몸, 02 = 2페이즈 몸).
#
# 그대로 합치면 노드 이름도 클립 이름도 겹쳐서 three.js 가 뒤엣것에 _1 을 붙이고,
# 그러면 어느 카메라 클립이 어느 카메라 노드인지 못 가른다(cameraClipTarget 이
# 트랙 이름의 앞머리로 찾는다). 2페이즈 쪽 이름을 갈아 둔다.
#
# 짝짓기는 extras.pairedClip 을 먼저 보므로 이름을 바꿔도 짝은 안 어긋난다.
RENAMES = {
    '추출프로그램 업데이트 이후/eba002_eba002 H.S.T.A_eba002_hsta.glb': {
        'eba002_2phase_intro_camera': 'eba002_2phase_intro_02_camera',
    },
}

GT = ['npx', '--yes', '@gltf-transform/cli@latest']


def rename_in_glb(src, dst, table):
    """노드·애니메이션 이름만 바꿔 새 파일로 쓴다.

    인덱스는 건드리지 않는다 - glTF 애니메이션 채널은 노드를 번호로 가리키므로
    이름을 바꿔도 대상은 그대로다. three.js 는 불러올 때 노드 이름으로 트랙
    이름을 만들기 때문에, 노드와 클립 이름을 같이 갈아 주면 짝짓기가 맞는다.
    """
    with open(src, 'rb') as f:
        struct.unpack('<III', f.read(12))
        chunks = []
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            ln, ty = struct.unpack('<II', hdr)
            chunks.append([ty, f.read(ln)])
    doc = json.loads(chunks[0][1].decode('utf-8'))
    hit = 0
    for key in ('nodes', 'animations'):
        for item in doc.get(key) or []:
            fixed = table.get(item.get('name'))
            if fixed:
                item['name'] = fixed
                hit += 1
    # 노드 하나 + 클립 하나가 짝이다. 수가 안 맞으면 원본이 바뀐 것이니 멈춘다.
    if hit != 2 * len(table):
        raise RuntimeError('이름 바꾸기 대상이 %d개다(%d개여야 한다): %s'
                           % (hit, 2 * len(table), os.path.basename(src)))
    raw = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    raw += b' ' * ((4 - len(raw) % 4) % 4)
    chunks[0][1] = raw
    body = b''
    for ty, data in chunks:
        pad = b'\x00' if ty == 0x004E4942 else b' '
        data = data + pad * ((4 - len(data) % 4) % 4)
        body += struct.pack('<II', len(data), ty) + data
    with open(dst, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


def merge_scenes(path):
    """gltf-transform merge 는 씬을 파일 수만큼 남긴다. 로더는 기본 씬 하나만
    보기 때문에 뒤쪽 파일이 통째로 안 보인다. 루트를 한 씬으로 모은다."""
    with open(path, 'rb') as f:
        struct.unpack('<III', f.read(12))
        chunks = []
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            ln, ty = struct.unpack('<II', hdr)
            chunks.append([ty, f.read(ln)])
    doc = json.loads(chunks[0][1].decode('utf-8'))
    scenes = doc.get('scenes') or []
    if len(scenes) <= 1:
        return
    roots = []
    for sc in scenes:
        roots.extend(sc.get('nodes') or [])
    doc['scenes'] = [{'name': 'scene', 'nodes': roots}]
    doc['scene'] = 0
    raw = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    raw += b' ' * ((4 - len(raw) % 4) % 4)
    chunks[0][1] = raw
    body = b''
    for ty, data in chunks:
        pad = b'\x00' if ty == 0x004E4942 else b' '
        data = data + pad * ((4 - len(data) % 4) % 4)
        body += struct.pack('<II', len(data), ty) + data
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


def run(args):
    # 출력에 한글·기호가 섞여 나온다. 콘솔 기본 코덱(cp949)으로 읽으면 읽는 스레드가
    # 통째로 죽어서, 진짜 실패했을 때 오류 내용을 하나도 못 본다.
    r = subprocess.run(args, capture_output=True, text=True, shell=(os.name == 'nt'),
                       encoding='utf-8', errors='replace')
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout)[-800:])
    return r


def main():
    only = sys.argv[1:] or None
    tmp = tempfile.mkdtemp(prefix='repack')
    try:
        for rel, out in JOBS:
            if only and out not in only:
                continue
            rels = rel if isinstance(rel, list) else [rel]
            srcs = [os.path.join(SRC, r.replace('/', os.sep)) for r in rels]
            missing = [r for r, p in zip(rels, srcs) if not os.path.exists(p)]
            if missing:
                print('건너뜀(원본 없음):', missing[0])
                continue
            # 합치기 전에 겹치는 이름을 갈아 둔다
            for i, r in enumerate(rels):
                table = RENAMES.get(r)
                if table:
                    fixed = os.path.join(tmp, 'ren%d.glb' % i)
                    rename_in_glb(srcs[i], fixed, table)
                    srcs[i] = fixed
            a = os.path.join(tmp, 'a.glb')
            b = os.path.join(tmp, 'b.glb')
            c = os.path.join(tmp, 'c.glb')
            if len(srcs) > 1:
                m = os.path.join(tmp, 'm.glb')
                run(GT + ['merge'] + srcs + [m])
                merge_scenes(m)
                src = m
            else:
                src = srcs[0]
            run(GT + ['resample', src, a])
            run(GT + ['prune', a, b])
            run(GT + ['draco', b, c])
            dst = os.path.join(UPLOAD, out + '.glb')
            run([sys.executable, WEBP, c, dst])
            shutil.copyfile(dst, os.path.join(LOCAL, out + '.glb'))
            print('%-16s %7.1f MB -> %5.1f MB' % (
                out, sum(os.path.getsize(p) for p in srcs) / 1e6,
                os.path.getsize(dst) / 1e6))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
