# -*- coding: utf-8 -*-
"""미실장 캐릭터 초상화를 코드 이름 webp 로 리포에 들인다.

바깥 폴더 `이미지/미실장 캐릭터/<코드>/mi_<코드>_s[_n].png` 를 읽어
`img/nikke/<코드>.webp` 로 만든다. 니케 초상화와 같은 규칙이다.

  - 256x512 가 표준이다. 그보다 크면(잉닝·화피가 600x1200) 줄이고,
    작으면 건드리지 않는다 - 확대는 없는 화질을 지어내는 것이라 의미가 없다.
  - png 는 webp q90 으로. 같은 그림이 77% 작아진다(재서 확인).
  - 파일 이름 끝의 _1 은 내려받을 때 붙는 꼬리표라 떼고 읽는다.

옮기지 않고 "추가" 한다. DB 가 아직 옛 이름을 가리키는 동안 이미지가 깨지면
안 되므로, 새 이름을 먼저 만들고 SQL 을 돌린 뒤에 옛 파일을 지운다.
"""
import io
import os
import re

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
ROOT = os.path.dirname(WEB)
SRC = os.path.join(ROOT, '이미지', '미실장 캐릭터')
DST = os.path.join(WEB, 'img', 'nikke')
STD = (256, 512)
QUALITY = 90
NAME = re.compile(r'^mi_(c\d{3,4}_\d{2})_s(?:_\d+)?\.(png|webp)$', re.I)


def sources():
    """코드 -> 원본 경로. 같은 코드가 여러 개면 큰 쪽을 쓴다."""
    best = {}
    for folder in sorted(os.listdir(SRC)):
        d = os.path.join(SRC, folder)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            m = NAME.match(f)
            if not m:
                continue
            p = os.path.join(d, f)
            try:
                w, h = Image.open(p).size
            except Exception:
                continue
            code = m.group(1)
            if code not in best or w * h > best[code][1]:
                best[code] = (p, w * h)
    return {k: v[0] for k, v in best.items()}


def main():
    made = shrunk = 0
    rows = []
    for code, src in sorted(sources().items()):
        im = Image.open(src).convert('RGBA')
        if im.size[0] > STD[0] or im.size[1] > STD[1]:
            im = im.resize(STD, Image.LANCZOS)
            shrunk += 1
        dst = os.path.join(DST, code + '.webp')
        im.save(dst, 'WEBP', quality=QUALITY, method=6)
        made += 1
        rows.append((code, im.size, os.path.getsize(dst)))
    print('만든 파일 %d개 (그중 줄인 것 %d개)' % (made, shrunk))
    print('합계 %.2f MB' % (sum(r[2] for r in rows) / 1e6))
    return rows


if __name__ == '__main__':
    main()
