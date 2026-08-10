# 새 이미지를 사이트에 올리고, DB 에 넣을 주소를 뽑아 준다.
#
# 예전 방식: 이미지를 base64 로 바꿔서 DB 칸에 통째로 붙여넣기
# 지금 방식: 이미지를 저장소에 올리고 DB 칸에는 주소만 붙여넣기
#            (파일 이름은 예전처럼 니케/코스튬 이름 그대로 쓰면 된다 - 한글도 된다)
#
# 사용법:
#   python tools/add_images.py nikke  "C:/.../라피.webp" "C:/.../마리안.webp"
#   python tools/add_images.py costume "C:/.../무료티켓.png"
#
# 첫 번째 인자는 어느 폴더에 넣을지:
#   nikke      니케 초상화 / 코스튬 이미지   (IMG_니케)
#   unreleased 미실장 캐릭터 이미지          (미실장_캐릭터)
#   costume    코스튬 티켓 이미지            (유니크_코스튬)
#   souvenir   기념품 이미지                 (기념품)
#
# 실행하면 파일을 복사하고 git 에 올린 뒤, DB 에 붙여넣을 주소를 출력한다.
# 배포에 1~2분 걸리므로 주소가 바로 안 열려도 잠시 기다리면 된다.

import os, shutil, subprocess, sys, urllib.parse

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 정보모음-web
PUBLIC_BASE = 'https://mangohke-code.github.io/MMR-Archive/img'
FOLDERS = {
    'nikke':      'IMG_니케 (이미지 / 코스튬1_이미지 / 코스튬2_이미지)',
    'unreleased': '미실장_캐릭터 (이미지1 / 이미지2)',
    'costume':    '유니크_코스튬 (무료티켓 / 유료티켓)',
    'souvenir':   '기념품 (이미지)',
}
ALLOWED = {'.webp', '.png', '.jpg', '.jpeg', '.gif'}


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in FOLDERS:
        print('사용법: python tools/add_images.py <폴더> <이미지파일...>\n')
        print('폴더 종류:')
        for k, v in FOLDERS.items():
            print(f'  {k:<11} {v}')
        sys.exit(1)

    folder, srcs = sys.argv[1], sys.argv[2:]
    dest_dir = os.path.join(BASE, 'img', folder)
    os.makedirs(dest_dir, exist_ok=True)

    added, urls = [], []
    for src in srcs:
        if not os.path.isfile(src):
            print(f'[건너뜀] 파일이 없다: {src}')
            continue
        name = os.path.basename(src)
        if os.path.splitext(name)[1].lower() not in ALLOWED:
            print(f'[건너뜀] 이미지 파일이 아니다: {name}')
            continue
        dest = os.path.join(dest_dir, name)
        if os.path.exists(dest):
            print(f'[덮어씀] 같은 이름이 이미 있다: {name}')
        shutil.copy2(src, dest)
        added.append(dest)
        # 주소에는 한글이 그대로 들어가도 브라우저가 알아서 처리한다.
        urls.append(f'{PUBLIC_BASE}/{folder}/{name}')

    if not added:
        print('올릴 파일이 없다.')
        return

    subprocess.run(['git', 'add'] + added, cwd=BASE, check=True)
    subprocess.run(['git', 'commit', '-q', '-m', f'이미지 {len(added)}개 추가 ({folder})'], cwd=BASE, check=True)
    subprocess.run(['git', 'push', '-q', 'origin', 'main'], cwd=BASE, check=True)

    print(f'\n{len(added)}개 올렸다. 아래 주소를 DB 의 해당 칸에 붙여넣으면 된다.')
    print(f'(대상 테이블: {FOLDERS[folder]})\n')
    for u in urls:
        print(u)


if __name__ == '__main__':
    main()
