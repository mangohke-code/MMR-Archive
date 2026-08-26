"""재언팩된 원본 glb 를 웹용으로 압축한다.

파이프라인: gltf-transform resample -> prune -> draco -> glb_webp.py
파일 이름에 공백·중점(·)·한글이 섞여 있어서 셸로 돌리면 인용이 계속 깨진다.
그래서 목록을 여기 적고 파이썬에서 직접 호출한다.
"""
import os
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
    ('S24 검은 뱀/bbg008_검은 뱀 H.S.T.A. · summon.glb', 'bbg008'),
    ('S26 프로비던스/xbg002_프로비던스 Z.E.U.S.glb', 'xbg002'),
    ('S33 온리 원/xbg003_온리 원 H.S.T.A.glb', 'xbg003'),
    ('S38 애니힐리오/xba003_애니힐리오 D.M.T.R.glb', 'xba003_1phase'),
    ('S38 애니힐리오/xba003_애니힐리오 D.M.T.R_xba003_dmtr.glb', 'xba003_2phase'),
]

GT = ['npx', '--yes', '@gltf-transform/cli@latest']


def run(args):
    r = subprocess.run(args, capture_output=True, text=True, shell=(os.name == 'nt'))
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
            src = os.path.join(SRC, rel.replace('/', os.sep))
            if not os.path.exists(src):
                print('건너뜀(원본 없음):', rel)
                continue
            a = os.path.join(tmp, 'a.glb')
            b = os.path.join(tmp, 'b.glb')
            c = os.path.join(tmp, 'c.glb')
            run(GT + ['resample', src, a])
            run(GT + ['prune', a, b])
            run(GT + ['draco', b, c])
            dst = os.path.join(UPLOAD, out + '.glb')
            run([sys.executable, WEBP, c, dst])
            shutil.copyfile(dst, os.path.join(LOCAL, out + '.glb'))
            print('%-16s %7.1f MB -> %5.1f MB' % (
                out, os.path.getsize(src) / 1e6, os.path.getsize(dst) / 1e6))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
