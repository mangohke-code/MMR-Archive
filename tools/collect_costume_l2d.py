"""유니크 코스튬 L2D 리소스를 저장소로 모아 넣고 DB 반영용 SQL 을 만든다.

미실장 캐릭터 때와 같은 방식이다. 폴더 이름이 코드(c016_01)고, 안에 이름만 적힌 빈 txt 가
같이 들어 있다. txt 이름은 "니케 코스튬명" 을 붙여 쓴 것이라("라피 레드 후드 레드 플레이버")
표의 니케와 코스튬명을 이어 붙여 맞춘다. ':' 같은 문자는 파일명에 못 들어가므로 글자만
남기고 비교한다.

폴더 안에 _bg / _fg 하위 폴더가 있으면 추가 파츠다. bg 는 기본 텍스처보다 뒤, fg 는 앞에
그린다. 추가_파츠 열은 JSON 이 아니라 한 줄에 "순서,skel주소,atlas주소" 형식이다.

사용법:
    python tools/collect_costume_l2d.py          # 확인만
    python tools/collect_costume_l2d.py --write  # 복사 + SQL 생성
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
SRC = r'C:\Users\zroyh\Desktop\시트 관리용\이미지\코스튬'
OUT = r'C:\Users\zroyh\Desktop\시트 관리용\update_costume_l2d.sql'

WRITE = '--write' in sys.argv

# 코스튬 폴더가 아닌 것(작업하다 남은 원본 덤프 등)은 건너뛴다
SKIP_DIRS = {'목단'}


def db(table, select, order):
    cfg = io.open(os.path.join(WEB, 'js', 'config.js'), encoding='utf-8').read()
    url = re.search(r"SUPABASE_URL\s*=\s*'([^']+)'", cfg).group(1)
    key = re.search(r"SUPABASE_ANON_KEY\s*=\s*'([^']+)'", cfg).group(1)
    q = urllib.parse.urlencode({'select': select, 'order': order})
    req = urllib.request.Request(f'{url}/rest/v1/{urllib.parse.quote(table)}?{q}',
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key})
    return json.load(urllib.request.urlopen(req))


def norm(s):
    """글자와 숫자만 남긴다. 파일명에 못 쓰는 ':' 나 띄어쓰기 차이를 무시하려는 것."""
    return re.sub(r'[^0-9A-Za-z가-힣]', '', s or '')


def esc(s):
    return str(s).replace("'", "''")


def copy(src, name):
    if WRITE:
        shutil.copy2(src, name)
    return name


def scan():
    """{코드: {'name':…, 'main':{skel,atlas,png}, 'parts':[…], 'mi':…, 'extra':[…]}}"""
    out = {}
    for entry in sorted(os.listdir(SRC)):
        path = os.path.join(SRC, entry)
        if not os.path.isdir(path) or entry in SKIP_DIRS:
            continue
        if not re.match(r'^c\d+_\d+$', entry):
            print(f'  ?? 코드 형식이 아닌 폴더는 건너뜁니다: {entry}')
            continue

        info = {'name': None, 'main': {}, 'parts': [], 'mi': None, 'extra': [], 'files': []}

        # 코스튬 폴더 안의 모든 파일을 훑는다(하위 폴더 포함).
        # 하위 폴더 이름이 곧 파츠 이름이라 파일이 어디 있든 이름으로 판별할 수 있다.
        for root, _dirs, files in os.walk(path):
            for f in sorted(files):
                full = os.path.join(root, f)
                base, ext = os.path.splitext(f)
                if ext == '.txt':
                    info['name'] = base
                    continue
                if f.startswith('mi_'):
                    info['mi'] = full
                    info['files'].append(full)
                    continue
                if ext not in ('.skel', '.atlas', '.png'):
                    continue
                info['files'].append(full)

                stem = base[:-len('_action')] if base.endswith('_action') else base
                if stem == entry:
                    info['main'][ext[1:]] = f
                elif stem in (entry + '_bg', entry + '_fg'):
                    kind = stem[-2:]
                    part = next((p for p in info['parts'] if p['stem'] == stem), None)
                    if not part:
                        part = {'stem': stem, 'order': '뒤' if kind == 'bg' else '앞'}
                        info['parts'].append(part)
                    part[ext[1:]] = f
                else:
                    # c281_98 처럼 어디에도 안 붙는 것. 올려는 두고 파츠로는 안 쓴다.
                    grp = next((g for g in info['extra'] if g['stem'] == stem), None)
                    if not grp:
                        grp = {'stem': stem}
                        info['extra'].append(grp)
                    grp[ext[1:]] = f

        out[entry] = info
    return out


def main():
    costumes = db('유니크_코스튬', '번호,니케,코스튬명', '번호')
    nikke_img = db('IMG_니케', '번호,이름,코스튬1,코스튬2', '번호')
    folders = scan()

    print(f'폴더 {len(folders)}개 / 코스튬 표 {len(costumes)}행')
    print()

    matched, no_row = [], []
    used = set()
    for code, info in sorted(folders.items()):
        name = info['name']
        hit = [c for c in costumes if norm(c['니케'] + c['코스튬명']) == norm(name)]
        if len(hit) != 1:
            # 니케 이름을 줄여 적은 경우가 있다("아스카" vs "시키나미 아스카 랑그레이").
            # 코스튬명만으로 하나만 나오면 그걸로 본다.
            hit = [c for c in costumes
                   if norm(c['코스튬명']) and norm(name).endswith(norm(c['코스튬명']))]
        if len(hit) == 1:
            matched.append((hit[0], code, info))
            used.add(hit[0]['번호'])
        else:
            no_row.append((code, name, len(hit)))

    print('=' * 74)
    print(f'맞은 코스튬 {len(matched)}개')
    print('=' * 74)
    for row, code, info in matched:
        bits = []
        if info['parts']:
            bits.append('파츠 ' + ', '.join(f"{p['stem'][-2:]}({p['order']})" for p in info['parts']))
        standalone = [g for g in info['extra'] if 'skel' in g and 'atlas' in g]
        pages = [g for g in info['extra'] if g not in standalone]
        if standalone:
            bits.append('별도 ' + ', '.join(g['stem'] for g in standalone))
        if pages:
            # 아틀라스가 여러 장으로 나뉜 것. 같이 올리기만 하면 된다.
            bits.append(f'아틀라스 {len(pages)}장 더')
        if not info['mi']:
            bits.append('초상화 없음')
        missing = [k for k in ('skel', 'atlas', 'png') if k not in info['main']]
        if missing:
            bits.append('기본 ' + '/'.join(missing) + ' 없음')
        print(f"  {code:<10} {row['니케']} {row['코스튬명']}" + (f"   [{' · '.join(bits)}]" if bits else ''))

    if no_row:
        print()
        print('=' * 74)
        print(f'표에서 못 찾은 폴더 {len(no_row)}개')
        print('=' * 74)
        for code, name, n in no_row:
            print(f'  {code}  {name}  ({"여러 개와 겹침" if n else "없음"})')

    left = [c for c in costumes if c['번호'] not in used]
    if left:
        print()
        print('=' * 74)
        print(f'폴더가 없는 표 행 {len(left)}개')
        print('=' * 74)
        for c in left:
            print(f"  {c['번호']:>3}  {c['니케']} {c['코스튬명']}")

    if not WRITE:
        print('\n(확인만 했습니다. 실제로 복사하려면 --write)')
        return

    # ------------------------------------------------------------ 복사
    for row, code, info in matched:
        dst = os.path.join(WEB, 'l2d', code)
        os.makedirs(dst, exist_ok=True)
        for full in info['files']:
            f = os.path.basename(full)
            if f.startswith('mi_'):
                copy(full, os.path.join(WEB, 'img', 'nikke', f))
            else:
                copy(full, os.path.join(dst, f))

    # ------------------------------------------------------------ SQL
    L = ['-- 유니크 코스튬 L2D (상대 경로)',
         '--',
         '-- 파일은 원본 이름 그대로 올렸다. 어느 코스튬인지는 코드 열로 잇는다.',
         '-- _bg 는 기본 텍스처보다 뒤, _fg 는 앞에 그린다.',
         '',
         'ALTER TABLE "유니크_코스튬" ADD COLUMN IF NOT EXISTS "코드" text;',
         '',
         'BEGIN;',
         '']

    for row, code, info in matched:
        sets = [f'"코드" = \'{esc(code)}\'']
        if 'skel' in info['main']:
            sets.append(f'"skel" = \'l2d/{code}/{esc(info["main"]["skel"])}\'')
        if 'atlas' in info['main']:
            sets.append(f'"atlas" = \'l2d/{code}/{esc(info["main"]["atlas"])}\'')
        if info['parts']:
            lines = []
            for p in sorted(info['parts'], key=lambda x: x['stem']):
                if 'skel' in p and 'atlas' in p:
                    lines.append(f"{p['order']},l2d/{code}/{p['skel']},l2d/{code}/{p['atlas']}")
            if lines:
                sets.append(f'"추가_파츠" = \'{esc(chr(10).join(lines))}\'')
        L.append(f"-- {row['니케']} {row['코스튬명']}  ({code})")
        L.append(f'UPDATE "유니크_코스튬" SET {", ".join(sets)} WHERE "번호" = {row["번호"]};')

    # 초상화는 IMG_니케 의 코스튬N_이미지 로 들어간다
    L.append('')
    L.append('-- ===== 코스튬 초상화 (IMG_니케) =====')
    for row, code, info in matched:
        if not info['mi']:
            continue
        f = os.path.basename(info['mi'])
        img = next((n for n in nikke_img if norm(n['이름']) == norm(row['니케'])), None)
        if not img:
            L.append(f"-- {row['니케']}: IMG_니케 에 이 니케가 없어 건너뜁니다 ({f})")
            continue
        slot = 1 if norm(img.get('코스튬1') or '') == norm(row['코스튬명']) else (
               2 if norm(img.get('코스튬2') or '') == norm(row['코스튬명']) else None)
        if slot is None:
            L.append(f"-- {row['니케']} {row['코스튬명']}: IMG_니케 의 코스튬1/2 와 이름이 안 맞아 건너뜁니다 ({f})")
            continue
        L.append(f"UPDATE \"IMG_니케\" SET \"코스튬{slot}_이미지\" = 'img/nikke/{esc(f)}' "
                 f"WHERE \"번호\" = {img['번호']};")

    L.append('')
    L.append('COMMIT;')
    L.append('')

    extras = [(row, code, info) for row, code, info in matched if info['extra']]
    if extras:
        L.append('')
        L.append('-- 어느 파츠에도 안 붙는 별도 파일 -------------------------------------------')
        L.append('-- 올려는 뒀지만 파츠로는 안 넣었다. 뷰어로 보고 싶으면 아래처럼 잠깐 바꿔치기하고')
        L.append('-- 확인한 뒤 위의 UPDATE 를 다시 돌려 되돌리면 된다.')
        for row, code, info in extras:
            for g in info['extra']:
                if 'skel' in g and 'atlas' in g:
                    L.append(f"-- {row['니케']} {row['코스튬명']} — {g['stem']}")
                    L.append(f"--   UPDATE \"유니크_코스튬\" SET \"skel\" = 'l2d/{code}/{g['skel']}', "
                             f"\"atlas\" = 'l2d/{code}/{g['atlas']}' WHERE \"번호\" = {row['번호']};")

    io.open(OUT, 'w', encoding='utf-8').write('\n'.join(L))
    print(f'\n  SQL: {os.path.basename(OUT)}')


if __name__ == '__main__':
    main()
