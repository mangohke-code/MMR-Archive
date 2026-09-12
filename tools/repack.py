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
    # 2026-09-13, 추출 프로그램이 갱신되면서 원본을 전부 새로 뽑았다.
    # 카메라 노드가 연출별로 갈라지고 pairedClip·cutTimes 가 붙었다.
    # 원본은 시즌 폴더가 아니라 이 폴더 하나에 모여 있다.
    ('추출프로그램 업데이트 이후/eba001_스톰브링어 A.N.M.I.glb', 'eba001'),
    ('추출프로그램 업데이트 이후/mbg002_그레이브 디거 raid.glb', 'mbg002'),
    ('추출프로그램 업데이트 이후/xba002_퀸 001 D.M.T.R.glb', 'xba002'),
    ('추출프로그램 업데이트 이후/xba001_미러 컨테이너.glb', 'xba001'),
    ('추출프로그램 업데이트 이후/mbg003_베히모스 P.S.I.D.glb', 'mbg003_1phase'),
    ('추출프로그램 업데이트 이후/mbg003_베히모스 P.S.I.D_mbg003_psid.glb', 'mbg003_2phase'),
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
    ('추출프로그램 업데이트 이후/xba003_애니힐리오 D.M.T.R.glb', 'xba003_1phase'),
    ('추출프로그램 업데이트 이후/xba003_애니힐리오 D.M.T.R_xba003_dmtr.glb', 'xba003_2phase'),
]

GT = ['npx', '--yes', '@gltf-transform/cli@latest']


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
