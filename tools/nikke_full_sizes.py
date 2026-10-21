"""픽업 상세 팝업 전신 이미지 크기 목록 - img/nikke-full/sizes.json (2026-10-21).

팝업은 모든 전신 그림을 같은 비율로 줄이고 그림 칸 폭을 그림에 맞춘다(pickup.js openPickupDetail).
그림을 받기 전에 칸 폭을 정해야 열 때 칸이 툭 바뀌지 않으므로 크기를 미리 적어 둔다.
전신 그림을 새로 넣으면 다시 돌린다:  python tools/nikke_full_sizes.py
"""

import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(os.path.dirname(HERE), 'img', 'nikke-full')


def main():
    sizes = {}
    for name in sorted(os.listdir(DIR)):
        if name.endswith('.webp'):
            with Image.open(os.path.join(DIR, name)) as im:
                sizes[name[:-5]] = list(im.size)
    with open(os.path.join(DIR, 'sizes.json'), 'w', encoding='utf-8') as f:
        json.dump(sizes, f, separators=(',', ':'))
    print(f'{len(sizes)}개 -> img/nikke-full/sizes.json')


if __name__ == '__main__':
    main()
