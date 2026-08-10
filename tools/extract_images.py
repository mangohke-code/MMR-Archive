# Supabase 안에 base64 로 박혀 있는 이미지를 파일로 빼내고, DB 값을 URL 로 바꾸는 SQL 을 만든다.
#
# 배경: 이미지가 data:image/... base64 문자열로 테이블에 그대로 들어 있어서, 페이지를 열 때마다
# 전 캐릭터 이미지를 통째로 내려받고 있었다(총 9.5MB 중 9.3MB 가 이미지). 파일로 빼서 저장소에
# 올리고 DB 에는 주소만 남기면 첫 로딩이 가벼워지고 이미지는 브라우저가 캐시한다.
#
# 사용법: python tools/extract_images.py
#   → 정보모음-web/img/... 에 이미지 저장
#   → 시트 관리용/replace_base64_images.sql 에 UPDATE 문 생성
#
# 파일 이름은 "번호_용도.확장자" 로 짓는다. 한글을 쓰면 URL 인코딩이 얽히므로 ASCII 로만 만들고,
# 어느 행의 어느 열인지는 같이 생성되는 SQL 이 정확히 연결해 준다.

import base64, io, json, os, re, urllib.parse, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 정보모음-web
IMG_ROOT = os.path.join(BASE, 'img')
SQL_OUT = os.path.join(os.path.dirname(BASE), 'replace_base64_images.sql')
PUBLIC_BASE = 'https://mangohke-code.github.io/MMR-Archive/img'

cfg = io.open(os.path.join(BASE, 'js', 'config.js'), encoding='utf-8').read()
SUPABASE_URL = re.search(r"SUPABASE_URL\s*=\s*'([^']+)'", cfg).group(1)
ANON_KEY = re.search(r"SUPABASE_ANON_KEY\s*=\s*'([^']+)'", cfg).group(1)

# (테이블, 저장 폴더, {열 이름: 파일 접미사})
TARGETS = [
    ('IMG_니케',      'nikke',     {'이미지': 'portrait', '코스튬1_이미지': 'costume1', '코스튬2_이미지': 'costume2'}),
    ('미실장_캐릭터', 'unreleased', {'이미지1': 'v1', '이미지2': 'v2'}),
    ('유니크_코스튬', 'costume',   {'무료티켓': 'ticket_free', '유료티켓': 'ticket_paid'}),
    ('기념품',        'souvenir',  {'이미지': 'item'}),
]

EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
       'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg'}


def fetch(table, columns):
    q = urllib.parse.quote(table) + '?select=' + urllib.parse.quote(columns)
    req = urllib.request.Request(SUPABASE_URL + '/rest/v1/' + q,
                                 headers={'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY})
    return json.load(urllib.request.urlopen(req))


def parse_data_uri(value):
    """data:image/png;base64,.... -> (확장자, 바이너리). 아니면 None"""
    m = re.match(r'^data:([^;,]+);base64,(.*)$', value, re.S)
    if not m:
        return None
    mime = m.group(1).strip().lower()
    ext = EXT.get(mime)
    if not ext:
        return None
    try:
        return ext, base64.b64decode(m.group(2))
    except Exception:
        return None


def main():
    updates, stats, skipped = [], [], []
    for table, folder, cols in TARGETS:
        rows = fetch(table, '번호,' + ','.join(cols))
        out_dir = os.path.join(IMG_ROOT, folder)
        os.makedirs(out_dir, exist_ok=True)
        saved = raw = 0
        for row in rows:
            no = row['번호']
            for col, suffix in cols.items():
                val = row.get(col)
                if not isinstance(val, str) or not val.startswith('data:'):
                    if isinstance(val, str) and val:
                        skipped.append(f'{table}.{col} 번호={no} (base64 아님)')
                    continue
                parsed = parse_data_uri(val)
                if not parsed:
                    skipped.append(f'{table}.{col} 번호={no} (형식 인식 실패)')
                    continue
                ext, blob = parsed
                name = f'{no}_{suffix}.{ext}'
                with open(os.path.join(out_dir, name), 'wb') as f:
                    f.write(blob)
                saved += 1
                raw += len(val)
                updates.append((table, col, no, f'{PUBLIC_BASE}/{folder}/{name}'))
        stats.append(f'{table}: {saved}개 저장, base64 {raw // 1024}KB 제거')

    with io.open(SQL_OUT, 'w', encoding='utf-8') as f:
        f.write('-- base64 로 들어있던 이미지를 저장소에 올린 파일 주소로 교체한다.\n')
        f.write('-- tools/extract_images.py 가 자동 생성한 파일이다. 한 번만 실행하면 된다.\n')
        f.write('-- 실행 전에 img/ 폴더가 배포되어 있어야 한다(안 그러면 이미지가 잠시 안 보인다).\n\n')
        f.write('BEGIN;\n\n')
        for table, col, no, url in updates:
            f.write(f'UPDATE "{table}" SET "{col}" = \'{url}\' WHERE 번호 = {no};\n')
        f.write('\nCOMMIT;\n\n')
        f.write('-- 확인: 아직 base64 로 남아있는 값이 있는지\n')
        for table, _, cols in TARGETS:
            conds = ' OR '.join(f"\"{c}\" LIKE 'data:%'" for c in cols)
            f.write(f'-- SELECT count(*) FROM "{table}" WHERE {conds};\n')

    print('\n'.join(stats))
    print(f'\nUPDATE 문 {len(updates)}개 → {SQL_OUT}')
    if skipped:
        print(f'\n건너뜀 {len(skipped)}건:')
        for s in skipped[:20]:
            print('  ' + s)


if __name__ == '__main__':
    main()
