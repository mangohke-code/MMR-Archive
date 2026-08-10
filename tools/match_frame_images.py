# 테두리 이미지를 저장소에 올리고, 시즌·번호에 맞춰 UPDATE SQL 을 만든다.
#
# 파일 이름 규칙: "<시즌>-<테두리번호>.png"  예) 14-2.png = 14시즌의 테두리2
#
# 사용법: python tools/match_frame_images.py

import io, json, os, re, shutil, urllib.parse, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))       # 정보모음-web
SRC_DIR = r'C:\Users\zroyh\Desktop\시트 관리용\니케 외 이미지\테두리'
OUT_DIR = os.path.join(BASE, 'img', 'frame')
SQL_OUT = os.path.join(os.path.dirname(BASE), 'update_frame_images.sql')
PUBLIC_BASE = 'https://mangohke-code.github.io/MMR-Archive/img/frame'


def load_rows():
    cfg = io.open(os.path.join(BASE, 'js', 'config.js'), encoding='utf-8').read()
    url = re.search(r"SUPABASE_URL\s*=\s*'([^']+)'", cfg).group(1)
    key = re.search(r"SUPABASE_ANON_KEY\s*=\s*'([^']+)'", cfg).group(1)
    for table in ('솔로_레이드', '역대_테두리'):
        q = urllib.parse.quote(table) + '?select=' + urllib.parse.quote('id,시즌,보스')
        try:
            req = urllib.request.Request(url + '/rest/v1/' + q,
                                         headers={'apikey': key, 'Authorization': 'Bearer ' + key})
            return table, json.load(urllib.request.urlopen(req))
        except Exception:
            continue
    raise SystemExit('표를 읽지 못했다')


def main():
    table, rows = load_rows()
    by_season = {}
    for r in rows:
        by_season.setdefault(str(r['시즌']).strip(), r)

    picks, skipped = [], []
    for f in sorted(os.listdir(SRC_DIR)):
        if not f.lower().endswith(('.png', '.webp', '.jpg', '.jpeg')):
            continue
        m = re.match(r'^(\d+)-([123])$', os.path.splitext(f)[0])
        if not m:
            skipped.append(f'{f}: 이름이 "<시즌>-<번호>" 형식이 아니다')
            continue
        season, no = m.group(1), m.group(2)
        row = by_season.get(season)
        if not row:
            skipped.append(f'{f}: 표에 {season}시즌이 없다')
            continue
        picks.append({'파일': f, '시즌': season, '번호': no, 'id': row['id'], '보스': row['보스']})

    os.makedirs(OUT_DIR, exist_ok=True)
    for f in os.listdir(OUT_DIR):                 # 이번에 안 쓰는 파일은 정리
        if f not in {p['파일'] for p in picks}:
            os.remove(os.path.join(OUT_DIR, f))
    for p in picks:
        shutil.copy2(os.path.join(SRC_DIR, p['파일']), os.path.join(OUT_DIR, p['파일']))

    with io.open(SQL_OUT, 'w', encoding='utf-8') as out:
        out.write('-- 솔로 레이드 테두리 이미지 주소를 넣는다.\n')
        out.write('-- tools/match_frame_images.py 가 자동 생성했다. 이미지가 배포된 뒤 실행할 것.\n')
        out.write(f'-- 대상 표: {table} (기본키는 id)\n\n')
        out.write('BEGIN;\n\n')
        last = None
        for p in sorted(picks, key=lambda x: (int(x['시즌']), x['번호'])):
            if p['시즌'] != last:
                out.write(f"\n-- {p['시즌']}시즌 {p['보스']}\n")
                last = p['시즌']
            out.write(f'UPDATE "{table}" SET "테두리{p["번호"]}_이미지" = '
                      f"'{PUBLIC_BASE}/{p['파일']}' WHERE id = {p['id']};\n")
        out.write('\nCOMMIT;\n')

    seasons = sorted({p['시즌'] for p in picks}, key=int)
    print(f'테두리 {len(picks)}개 / 시즌 {len(seasons)}개 / 건너뜀 {len(skipped)}건')
    print(f'SQL → {SQL_OUT}')
    print('시즌:', ', '.join(seasons))
    if skipped:
        print('\n[건너뜀]')
        for s in skipped:
            print('  ' + s)


if __name__ == '__main__':
    main()
