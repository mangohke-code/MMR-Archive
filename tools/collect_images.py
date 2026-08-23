"""로컬 이미지 폴더를 저장소 img/ 아래로 모아 넣고, DB 반영용 SQL 을 만든다.

원본 폴더는 사람이 정리한 것이라 표기가 DB 와 조금씩 다르다(띄어쓰기, 낱개 파일 등).
그래서 이름을 곧이곧대로 비교하지 않고 공백을 없앤 뒤 맞춰 보고, 그래도 안 맞는 것은
아래 MANUAL 에 적어 둔다. 양쪽에서 짝을 못 찾은 것은 전부 출력해서 눈으로 확인한다.

사용법:
    python tools/collect_images.py          # 확인만 (파일 복사 안 함)
    python tools/collect_images.py --write  # 실제 복사 + SQL 생성
"""

import io
import os
import re
import shutil
import sys

SRC = r'C:\Users\zroyh\Desktop\시트 관리용\니케 외 이미지'
DST = r'C:\Users\zroyh\Desktop\시트 관리용\정보모음-web\img'
SQL_DIR = r'C:\Users\zroyh\Desktop\시트 관리용'

WRITE = '--write' in sys.argv

# 폴더 이름과 DB 이름이 다른 것들. 공백만 다른 경우는 자동으로 맞춰지므로 여기 안 적는다.
MANUAL_SOUVENIR = {
    '바비큐상자': '바비큐 일당 상자',
    '조사지원상자': '조사 지원 상자',
}

# DB 에 테두리 이름이 아직 안 적힌 시즌. 파일 이름 앞부분(보스)으로 시즌을 정한다.
# S37 은 보스가 울트라인데 S7 이 이미 "울트라 프레임"을 써서 "울트라 H 프레임"으로 나온다.
# 사치스러운 거미는 DB 에 해당 행 자체가 없다(아직 안 열린 시즌으로 보인다).
EXTRA_FRAMES = {
    '울트라 H': 37,
    '애니힐리오': 38,
    '아일랜드 이터': 39,
    '사치스러운 거미': 40,
}

# GitHub Pages 에서 한글 파일명은 잘 되지만 이 문자들은 주소에서 문제를 일으킨다
BAD_CHARS = re.compile(r'[#%&+?]')


def norm(s):
    return re.sub(r'\s+', '', s or '')


def check_name(name, where):
    if BAD_CHARS.search(name):
        print(f'  !! 주소에서 문제되는 문자 포함 [{where}]: {name}')


def copy(src, dst_dir, dst_name):
    check_name(dst_name, dst_dir)
    if not WRITE:
        return dst_name
    os.makedirs(dst_dir, exist_ok=True)
    shutil.copy2(src, os.path.join(dst_dir, dst_name))
    return dst_name


def sql_escape(s):
    return s.replace("'", "''")


# ---------------------------------------------------------------- 기념품
def do_souvenir(db_names):
    src = os.path.join(SRC, '기념품')
    found = {}          # DB 이름 -> (원본경로, 확장자)
    unused = []

    for entry in sorted(os.listdir(src)):
        path = os.path.join(src, entry)
        if os.path.isdir(path):
            files = [f for f in sorted(os.listdir(path)) if not f.startswith('.')]
            if len(files) != 1:
                print(f'  ?? 파일이 {len(files)}개인 폴더: {entry}')
            if not files:
                continue
            key, filepath = entry, os.path.join(path, files[0])
        else:
            key, filepath = os.path.splitext(entry)[0], path

        key = MANUAL_SOUVENIR.get(key, key)
        match = next((n for n in db_names if norm(n) == norm(key)), None)
        if match:
            found[match] = (filepath, os.path.splitext(filepath)[1])
        else:
            unused.append(entry)

    rows = []
    for name, (path, ext) in sorted(found.items()):
        rows.append((name, copy(path, os.path.join(DST, 'souvenir'), name + ext)))
    return found, unused, rows


# ---------------------------------------------------------------- 코스튬 티켓
def do_costume(db_rows):
    src = os.path.join(SRC, '코스튬 가챠')
    rows, unused, missing_free = [], [], []
    seen = set()

    for entry in sorted(os.listdir(src)):
        path = os.path.join(src, entry)
        if not os.path.isdir(path):
            unused.append(entry)
            continue
        match = next((r for r in db_rows if norm(r['티켓']) == norm(entry)), None)
        if not match:
            unused.append(entry)
            continue
        seen.add(match['티켓'])

        for f in sorted(os.listdir(path)):
            ext = os.path.splitext(f)[1]
            kind = '무료티켓' if '_free' in f else '유료티켓'
            rows.append((match['티켓'], kind,
                         copy(os.path.join(path, f), os.path.join(DST, 'costume'),
                              f'{entry} {kind}{ext}')))
        # DB 에는 무료티켓이 있는데 파일이 없는 경우를 잡는다
        has_free = any(r[0] == match['티켓'] and r[1] == '무료티켓' for r in rows)
        if match['무료티켓'] and not has_free:
            missing_free.append(match['티켓'])

    return rows, unused, [r['티켓'] for r in db_rows if r['티켓'] not in seen], missing_free


# ---------------------------------------------------------------- 솔로 레이드 테두리
def do_frames(db_rows):
    src = os.path.join(SRC, '테두리')
    files = {os.path.splitext(f)[0]: f for f in sorted(os.listdir(src))
             if os.path.isfile(os.path.join(src, f))}
    used, rows, missing = set(), [], []

    for r in db_rows:
        for n in (1, 2, 3):
            title = r.get(f'테두리{n}')
            if not title:
                continue
            key = next((k for k in files if norm(k) == norm(title)), None)
            if not key:
                missing.append(f"S{r['시즌']} 테두리{n}: {title}")
                continue
            used.add(key)
            ext = os.path.splitext(files[key])[1]
            rows.append((r['id'], r['시즌'], n,
                         copy(os.path.join(src, files[key]), os.path.join(DST, 'frame'),
                              f"S{r['시즌']} {title}{ext}")))

    # DB 에 이름이 없는 시즌은 파일 쪽에서 거꾸로 짚는다
    extra = []
    for key in sorted(set(files) - used):
        m = re.match(r'^(.*) 프레임 (I{1,3})$', key)
        if not m:
            continue
        boss, roman = m.group(1), m.group(2)
        season = EXTRA_FRAMES.get(boss)
        if season is None:
            continue
        n = len(roman)
        rid = next((r['id'] for r in db_rows if r['시즌'] == season), None)
        ext = os.path.splitext(files[key])[1]
        extra.append((rid, season, n, key,
                      copy(os.path.join(src, files[key]), os.path.join(DST, 'frame'),
                           f'S{season} {key}{ext}')))
        used.add(key)

    return rows, sorted(set(files) - used), missing, extra


def main():
    import json
    data = json.load(io.open(os.path.join(os.path.dirname(__file__), '_db.json'), encoding='utf-8'))

    print('=' * 70)
    print('기념품')
    print('=' * 70)
    sv_found, sv_unused, sv_rows = do_souvenir(data['souvenir'])
    print(f'  DB {len(data["souvenir"])}개 중 {len(sv_found)}개 짝지음')
    for n in data['souvenir']:
        if n not in sv_found:
            print(f'  -- 이미지 못 찾음: {n}')
    for e in sv_unused:
        print(f'  ++ DB 에 없는 이미지: {e}')

    print()
    print('=' * 70)
    print('유니크 코스튬 티켓')
    print('=' * 70)
    cs_rows, cs_unused, cs_missing, cs_nofree = do_costume(data['costume'])
    print(f'  파일 {len(cs_rows)}개 만듦')
    for n in cs_missing:
        print(f'  -- 이미지 못 찾음: {n}')
    for e in cs_unused:
        print(f'  ++ DB 에 없는 폴더: {e}')
    for n in cs_nofree:
        print(f'  !! DB 엔 무료티켓이 있는데 _free 파일 없음: {n}')

    print()
    print('=' * 70)
    print('솔로 레이드 테두리')
    print('=' * 70)
    fr_rows, fr_unused, fr_missing, fr_extra = do_frames(data['frames'])
    print(f'  파일 {len(fr_rows) + len(fr_extra)}개 만듦'
          f' (DB 에 이름 있는 것 {len(fr_rows)} + 이름 없는 시즌 {len(fr_extra)})')
    for rid, season, n, title, fn in fr_extra:
        print(f'  ** S{season} 테두리{n} 이름도 같이 채움: {title}'
              + ('' if rid else '   ← DB 에 이 시즌 행이 없습니다'))
    for m in fr_missing:
        print(f'  -- 이미지 못 찾음: {m}')
    for e in fr_unused:
        print(f'  ++ DB 에 없는 이미지: {e}')

    if not WRITE:
        print('\n(확인만 했습니다. 실제로 복사하려면 --write)')
        return

    # ------------------------------------------------------------ SQL
    def w(path, text):
        io.open(os.path.join(SQL_DIR, path), 'w', encoding='utf-8').write(text)
        print(f'  SQL: {path}')

    lines = ['-- 기념품 이미지 (상대 경로)', 'BEGIN;', '']
    for name, fn in sv_rows:
        lines.append(f"""UPDATE "기념품" SET "이미지" = 'img/souvenir/{sql_escape(fn)}' WHERE "이름" = '{sql_escape(name)}';""")
    lines += ['', 'COMMIT;', '']
    w('update_souvenir_images.sql', '\n'.join(lines))

    lines = ['-- 유니크 코스튬 티켓 이미지 (상대 경로)', 'BEGIN;', '']
    for ticket, kind, fn in cs_rows:
        col = '무료티켓' if kind == '무료티켓' else '유료티켓'
        lines.append(f"""UPDATE "유니크_코스튬" SET "{col}" = 'img/costume/{sql_escape(fn)}' WHERE "티켓" = '{sql_escape(ticket)}';""")
    lines += ['', 'COMMIT;', '']
    w('update_costume_ticket_images.sql', '\n'.join(lines))

    lines = ['-- 솔로 레이드 테두리 이미지 (상대 경로)', 'BEGIN;', '']
    for rid, season, n, fn in fr_rows:
        lines.append(f"""UPDATE "솔로_레이드" SET "테두리{n}_이미지" = 'img/frame/{sql_escape(fn)}' WHERE id = {rid};""")
    if fr_extra:
        lines += ['', '-- DB 에 테두리 이름이 비어 있던 시즌. 이름과 이미지를 같이 넣는다.']
        for rid, season, n, title, fn in fr_extra:
            if rid is None:
                lines.append(f"-- S{season} 테두리{n}: DB 에 이 시즌 행이 없어 건너뜀 ({title})")
                continue
            lines.append(f"""UPDATE "솔로_레이드" SET "테두리{n}" = '{sql_escape(title)}', """
                         f""""테두리{n}_이미지" = 'img/frame/{sql_escape(fn)}' WHERE id = {rid};""")
    lines += ['', 'COMMIT;', '']
    w('update_frame_images.sql', '\n'.join(lines))


if __name__ == '__main__':
    main()
