"""표의 코드 열을 기준으로 미실장 캐릭터 파일 주소를 잇는 SQL 을 만든다.

이름으로 맞추던 것을 코드로 바꾼다. 이름은 표기가 갈려서("드레이크" vs "드레이크 : ???")
맞추는 규칙이 필요했지만, 코드는 폴더 이름 그대로라 그냥 같은 값끼리 이으면 된다.

코드가 안 맞는 행은 이름으로 한 번 더 찾아보고, 찾으면 주석으로 알려 준다.
"""

import io
import json
import os
import re
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
SRC = r'C:\Users\zroyh\Desktop\시트 관리용\미실장 캐릭터'
OUT = r'C:\Users\zroyh\Desktop\시트 관리용\link_unreleased_by_code.sql'


def db_rows():
    cfg = io.open(os.path.join(WEB, 'js', 'config.js'), encoding='utf-8').read()
    url = re.search(r"SUPABASE_URL\s*=\s*'([^']+)'", cfg).group(1)
    key = re.search(r"SUPABASE_ANON_KEY\s*=\s*'([^']+)'", cfg).group(1)
    q = urllib.parse.urlencode({'select': '*', 'order': '번호'})
    req = urllib.request.Request(f'{url}/rest/v1/{urllib.parse.quote("미실장_캐릭터")}?{q}',
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key})
    return json.load(urllib.request.urlopen(req))


def scan():
    """{코드: {슬롯번호: {'이미지':…, 'skel':…, 'atlas':…}}}  슬롯은 _00 → 1, _01 → 2"""
    out = {}
    for entry in sorted(os.listdir(SRC)):
        path = os.path.join(SRC, entry)
        # 변형 번호가 없는 폴더(c8004)도 받는다. 그 경우 1번으로 본다.
        m = re.match(r'^(c\d+)(?:_(\d+))?$', entry)
        if not (m and os.path.isdir(path)):
            continue
        code = m.group(1)
        slot = int(m.group(2)) + 1 if m.group(2) else 1
        got = {}
        for f in sorted(os.listdir(path)):
            if f.endswith('.skel'):
                got['skel'] = f'l2d/{code}/{f}'
            elif f.endswith('.atlas'):
                got['atlas'] = f'l2d/{code}/{f}'
            elif f.startswith('mi_'):
                got['이미지'] = f'img/nikke/{f}'
            elif f.endswith('.txt'):
                got['이름'] = os.path.splitext(f)[0]
        out.setdefault(code, {})[slot] = got
    return out


def norm(s):
    return re.sub(r'\s+', '', s or '')


def esc(s):
    return str(s).replace("'", "''")


def main():
    rows = db_rows()
    folders = scan()

    by_code = {}
    for r in rows:
        c = (r.get('코드') or '').strip()
        if c:
            by_code.setdefault(c, []).append(r)

    matched, mismatched, no_row, no_folder = [], [], [], []

    for code in sorted(folders):
        hits = by_code.get(code, [])
        if len(hits) == 1:
            matched.append((hits[0], code, folders[code], None))
            continue
        if len(hits) > 1:
            print(f'  !! 코드 {code} 를 쓰는 행이 {len(hits)}개입니다 — 건너뜁니다')
            continue
        # 코드가 안 맞으면 이름으로 한 번 더
        name = folders[code][min(folders[code])].get('이름', '')
        cand = [r for r in rows if norm(r['이름1']).startswith(norm(name))]
        if len(cand) == 1:
            mismatched.append((cand[0], code, folders[code], cand[0].get('코드')))
        else:
            no_row.append((code, name))

    used = {id(r) for r, *_ in matched + mismatched}
    for r in rows:
        if id(r) not in used:
            no_folder.append(r)

    def stmt(row, code, slots, only_image=False):
        sets = []
        for slot, got in sorted(slots.items()):
            if got.get('이미지'):
                sets.append(f'"이미지{slot}" = \'{esc(got["이미지"])}\'')
            if only_image:
                continue
            if got.get('skel'):
                sets.append(f'"skel{slot}" = \'{esc(got["skel"])}\'')
            if got.get('atlas'):
                sets.append(f'"atlas{slot}" = \'{esc(got["atlas"])}\'')
        if not sets:
            return None
        return f'UPDATE "미실장_캐릭터" SET {", ".join(sets)} WHERE "번호" = {row["번호"]};'

    L = []
    L.append('-- 미실장 캐릭터 파일 주소 — 표의 코드 열 기준')
    L.append('--')
    L.append('-- 파일은 원본 이름 그대로 올려 뒀다(mi_c104_00_s.png). 어느 캐릭터인지는 코드로 잇는다.')
    L.append('-- 같은 코드에 _00 / _01 이 둘 다 있으면 _00 을 1번, _01 을 2번으로 넣는다.')
    L.append('')
    L.append('BEGIN;')
    L.append('')
    L.append('-- ===== 초상화 =====')
    for row, code, slots, _ in matched + mismatched:
        s = stmt(row, code, slots, only_image=True)
        if s:
            L.append(f'-- {row["이름1"]}  ({code})')
            L.append(s)
    L.append('')
    L.append('-- ===== L2D (skel / atlas) =====')
    L.append('-- 지금은 nikke-db 주소를 가리키고 있어서, 저장소에 올린 파일로 바꾼다.')
    for row, code, slots, _ in matched + mismatched:
        sets = []
        for slot, got in sorted(slots.items()):
            if got.get('skel'):
                sets.append(f'"skel{slot}" = \'{esc(got["skel"])}\'')
            if got.get('atlas'):
                sets.append(f'"atlas{slot}" = \'{esc(got["atlas"])}\'')
        if sets:
            L.append(f'-- {row["이름1"]}  ({code})')
            L.append(f'UPDATE "미실장_캐릭터" SET {", ".join(sets)} WHERE "번호" = {row["번호"]};')
    L.append('')
    L.append('COMMIT;')
    L.append('')

    if mismatched:
        L.append('')
        L.append('-- 코드가 표와 폴더에서 다른 행 --------------------------------------------')
        for row, code, slots, dbcode in mismatched:
            L.append(f'-- {row["이름1"]}: 표에는 {dbcode!r}, 파일은 {code!r} 입니다.')
            L.append(f'--   파일 쪽 코드로 맞추려면:')
            L.append(f'--   UPDATE "미실장_캐릭터" SET "코드" = \'{esc(code)}\' WHERE "번호" = {row["번호"]};')

    io.open(OUT, 'w', encoding='utf-8').write('\n'.join(L))

    print(f'코드로 맞은 캐릭터 {len(matched)}개')
    if mismatched:
        print(f'\n코드가 어긋나 이름으로 찾은 캐릭터 {len(mismatched)}개')
        for row, code, slots, dbcode in mismatched:
            print(f'  {row["이름1"]}: 표 {dbcode} / 파일 {code}')
    if no_row:
        print(f'\n표에 없는 폴더 {len(no_row)}개')
        for code, name in no_row:
            print(f'  {code}  {name}')
    if no_folder:
        print(f'\n폴더가 없는 표 행 {len(no_folder)}개')
        for r in no_folder:
            print(f'  {r["번호"]:>3}  {r["이름1"]}  코드={r.get("코드") or "(빈칸)"}')
    print(f'\nSQL: {os.path.basename(OUT)}')


if __name__ == '__main__':
    main()
