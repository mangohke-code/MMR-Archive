"""미실장 캐릭터 폴더를 저장소로 모아 넣고 DB 반영용 SQL 을 만든다.

원본 폴더 하나가 캐릭터 한 버전이다. 폴더 이름은 코드(c104_00)라 사람이 알아볼 수 없어서,
안에 이름만 적힌 빈 txt 파일이 같이 들어 있다. 다만 파일명에 ':' 같은 문자를 못 넣으니
표에 적힌 정식 이름("드레이크 : ???")과는 다를 수 있다. 그래서 표 이름이 txt 이름으로
시작하는지로 맞춘다.

같은 코드에 _00 / _01 이 둘 다 있으면 한 캐릭터의 두 버전이다. _00 을 1번, _01 을 2번으로
넣는다(skel1/skel2, atlas1/atlas2, 이미지1/이미지2).

사용법:
    python tools/collect_unreleased.py          # 확인만
    python tools/collect_unreleased.py --write  # 복사 + SQL 생성
"""

import io
import json
import os
import re
import shutil
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
SRC = r'C:\Users\zroyh\Desktop\시트 관리용\미실장 캐릭터'
SQL_DIR = r'C:\Users\zroyh\Desktop\시트 관리용'

WRITE = '--write' in sys.argv
BAD_CHARS = re.compile(r'[#%&+?]')


def db_rows():
    cfg = io.open(os.path.join(WEB, 'js', 'config.js'), encoding='utf-8').read()
    url = re.search(r"SUPABASE_URL\s*=\s*'([^']+)'", cfg).group(1)
    key = re.search(r"SUPABASE_ANON_KEY\s*=\s*'([^']+)'", cfg).group(1)
    q = urllib.parse.urlencode({'select': '*', 'order': '번호'})
    req = urllib.request.Request(f'{url}/rest/v1/{urllib.parse.quote("미실장_캐릭터")}?{q}',
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key})
    return json.load(urllib.request.urlopen(req))


def norm(s):
    return re.sub(r'\s+', '', s or '')


def sql_escape(s):
    return str(s).replace("'", "''")


def copy(src, dst_dir, name):
    if BAD_CHARS.search(name):
        print(f'  !! 주소에서 문제되는 문자: {name}')
    if WRITE:
        os.makedirs(dst_dir, exist_ok=True)
        shutil.copy2(src, os.path.join(dst_dir, name))
    return name


def scan():
    """폴더를 코드별로 묶는다. {코드: {변형번호: {'name':…, 'dir':…, 'files':[…]}}}"""
    groups = {}
    for entry in sorted(os.listdir(SRC)):
        path = os.path.join(SRC, entry)
        if not os.path.isdir(path):
            continue
        m = re.match(r'^(c\d+)_(\d+)$', entry)
        if not m:
            print(f'  ?? 코드 형식이 아닌 폴더: {entry}')
            continue
        code, variant = m.group(1), int(m.group(2))
        files = sorted(os.listdir(path))
        txt = next((f for f in files if f.endswith('.txt')), None)
        if not txt:
            print(f'  ?? 이름 txt 가 없는 폴더: {entry}')
            continue
        # "장화_00" 처럼 txt 이름에 변형 번호가 붙어 있으면 뗀다
        name = re.sub(r'_\d+$', '', os.path.splitext(txt)[0])
        groups.setdefault(code, {})[variant] = {
            'name': name, 'dir': path, 'entry': entry, 'files': files,
        }
    return groups


def match_row(name, rows):
    """표 이름이 폴더 이름으로 시작하면 같은 캐릭터로 본다. 정확히 같은 것을 먼저 찾는다."""
    exact = [r for r in rows if norm(r['이름1']) == norm(name)]
    if len(exact) == 1:
        return exact[0], None
    prefix = [r for r in rows if norm(r['이름1']).startswith(norm(name))]
    if len(prefix) == 1:
        return prefix[0], None
    if len(prefix) > 1:
        return None, '표에서 여러 개와 겹침: ' + ', '.join(r['이름1'] for r in prefix)
    return None, None


def main():
    rows = db_rows()
    groups = scan()
    print(f'폴더 {sum(len(v) for v in groups.values())}개 / 코드 {len(groups)}개 / 표 {len(rows)}행')
    print()

    updates, inserts, warns = [], [], []
    used_rows = set()

    for code in sorted(groups):
        variants = groups[code]
        base_name = variants[min(variants)]['name']
        row, err = match_row(base_name, rows)
        if err:
            warns.append(f'{code} {base_name}: {err}')
            continue

        assets = {}
        for variant, info in sorted(variants.items()):
            slot = variant + 1               # _00 → 1번, _01 → 2번
            entry = info['entry']
            for f in info['files']:
                src = os.path.join(info['dir'], f)
                if f.endswith('.skel'):
                    assets[f'skel{slot}'] = 'l2d/' + code + '/' + copy(src, os.path.join(WEB, 'l2d', code), f)
                elif f.endswith('.atlas'):
                    assets[f'atlas{slot}'] = 'l2d/' + code + '/' + copy(src, os.path.join(WEB, 'l2d', code), f)
                elif f == f'{entry}.png':    # 아틀라스가 이 이름으로 참조하므로 그대로 둔다
                    copy(src, os.path.join(WEB, 'l2d', code), f)
                elif f.startswith('mi_'):
                    # 원본 이름 그대로 둔다. 캐릭터 이름으로 바꾸면 장화처럼 두 버전이 같은
                    # 이름이 되어 서로 덮어쓴다. 어느 캐릭터 것인지는 코드 열로 잇는다.
                    assets[f'이미지{slot}'] = 'img/nikke/' + copy(src, os.path.join(WEB, 'img', 'nikke'), f)
                # si_ 는 쓰지 않는다

            if not any(k.startswith('mi') for k in info['files']):
                pass
            if not any(f.startswith('mi_') for f in info['files']):
                warns.append(f'{entry} {info["name"]}: mi_ 이미지 없음 (이미지{slot} 못 채움)')

        assets['코드'] = code

        if row:
            used_rows.add(row['번호'])
            updates.append((row['번호'], row['이름1'], base_name, assets, len(variants)))
        else:
            inserts.append((base_name, assets, len(variants)))

    print('=' * 74)
    print(f'표에 있는 캐릭터 {len(updates)}개 — 주소만 갱신')
    print('=' * 74)
    for num, dbname, folder, a, nv in updates:
        tag = f' [{nv}버전]' if nv > 1 else ''
        same = '' if norm(dbname) == norm(folder) else f'  (폴더 "{folder}")'
        print(f'  {num:>3}  {dbname}{tag}{same}')

    print()
    print('=' * 74)
    print(f'표에 없는 캐릭터 {len(inserts)}개 — 새로 넣어야 함')
    print('=' * 74)
    for name, a, nv in inserts:
        print(f'  {name}{" [2버전]" if nv > 1 else ""}   {", ".join(sorted(a))}')

    print()
    print('=' * 74)
    print(f'폴더가 없는 표 행 {len([r for r in rows if r["번호"] not in used_rows])}개')
    print('=' * 74)
    for r in rows:
        if r['번호'] not in used_rows:
            print(f'  {r["번호"]:>3}  {r["이름1"]}')

    if warns:
        print()
        print('=' * 74)
        print('확인 필요')
        print('=' * 74)
        for w in warns:
            print(f'  {w}')

    if not WRITE:
        print('\n(확인만 했습니다. 실제로 복사하려면 --write)')
        return

    # ---------------------------------------------------------------- SQL
    lines = [
        '-- 미실장 캐릭터 L2D·초상화 주소 (상대 경로)',
        '--',
        '-- 파일은 원본 이름 그대로 올렸다(mi_c104_00_s.png). 캐릭터 이름으로 바꾸면 장화처럼',
        '-- 두 버전이 같은 이름이 되어 서로 덮어쓴다. 대신 코드 열로 어느 캐릭터인지 잇는다.',
        '',
        'ALTER TABLE "미실장_캐릭터" ADD COLUMN IF NOT EXISTS "코드" text;',
        '',
        'BEGIN;',
        '',
    ]
    for num, dbname, folder, a, nv in updates:
        sets = ', '.join(f'"{k}" = \'{sql_escape(v)}\'' for k, v in sorted(a.items()))
        lines.append(f'-- {dbname}')
        lines.append(f'UPDATE "미실장_캐릭터" SET {sets} WHERE "번호" = {num};')
    if inserts:
        lines += ['', '-- 표에 없던 캐릭터. 이름과 주소만 넣어 두었으니 소속·스쿼드·등장 시기는 채워야 한다.']
        for name, a, nv in inserts:
            cols = ', '.join(f'"{k}"' for k in sorted(a))
            vals = ', '.join(f"'{sql_escape(a[k])}'" for k in sorted(a))
            lines.append(f'INSERT INTO "미실장_캐릭터" ("이름1", {cols}) '
                         f"VALUES ('{sql_escape(name)}', {vals});")
    lines += ['', 'COMMIT;', '']
    out = os.path.join(SQL_DIR, 'update_unreleased_assets.sql')
    io.open(out, 'w', encoding='utf-8').write('\n'.join(lines))
    print(f'\n  SQL: {os.path.basename(out)}  (UPDATE {len(updates)} / INSERT {len(inserts)})')


if __name__ == '__main__':
    main()
