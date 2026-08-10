# 솔로 레이드 보스 이미지를 약점 속성에 맞춰 골라내고, 저장소에 올린 뒤 UPDATE SQL 을 만든다.
#
# 속성 상성은 꼬리잡기다: 작열 → 수냉 → 전격 → 철갑 → 풍압 → 작열
# (화살표 왼쪽이 오른쪽에 약하다. 즉 작열 보스의 약점은 수냉이다)
#
# 표에는 "약점 속성"이 적혀 있으므로, 보스 자신의 속성은 그 직전 값이다.
#   약점 작열 → 보스는 풍압(ANMI)   예) 11시즌 스톰 브링어 = 작열 약점 → ANMI 이미지
#   약점 수냉 → 보스는 작열(HSTA)
#   약점 전격 → 보스는 수냉(PSID)
#   약점 철갑 → 보스는 전격(ZEUS)
#   약점 풍압 → 보스는 철갑(DMTR)
#
# 고르는 규칙:
#   1) 보스 자신의 속성 코드가 붙은 파일이 있으면 그것을 쓴다 (확실)
#   2) 그 보스의 파일이 코드 없는 것 하나뿐이면 그것을 쓴다 (고를 여지가 없음)
#   3) 둘 다 아니면 건너뛰고 사유를 보고한다 (애매한 것은 손대지 않는다)
#   4) 한 이미지는 한 시즌에만 쓴다. 같은 파일이 두 시즌에 걸리면(같은 보스가 다른 속성으로
#      다시 나왔는데 파일은 하나뿐인 경우) 어느 쪽이 맞는지 알 수 없으므로 둘 다 건너뛴다.

import io, json, os, re, shutil, urllib.parse, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))       # 정보모음-web
SRC_DIR = r'C:\Users\zroyh\Desktop\시트 관리용\니케 외 이미지\보스'
OUT_DIR = os.path.join(BASE, 'img', 'boss')
SQL_OUT = os.path.join(os.path.dirname(BASE), 'update_boss_images.sql')
PUBLIC_BASE = 'https://mangohke-code.github.io/MMR-Archive/img/boss'

# 약점 속성 → (보스 자신의 속성, 영문 코드)
WEAK_TO_SELF = {
    '작열': ('풍압', 'ANMI'),
    '수냉': ('작열', 'HSTA'),
    '전격': ('수냉', 'PSID'),
    '철갑': ('전격', 'ZEUS'),
    '풍압': ('철갑', 'DMTR'),
}

# 표의 보스 이름 → 이미지 파일의 영문 이름
NAME_MAP = {
    '마더 웨일': 'Mother_Whale', '블랙스미스': 'Black_Smith', '하베스터': 'Harvester',
    '알트아이젠': 'Alteisen_MK.VI', '모더니아': 'Modernia', '울트라': 'Ultra',
    '토커티브': 'Chatterbox', '마테리얼H': 'Material_H', '크리스탈 체임버': 'Crystal_Chamber',
    '스톰 브링어': 'Storm_Bringer', '니힐리스타': 'Nihilister_Boss', '인디빌리아': 'Indivilia',
    '그레이브 디거': 'Grave_Digger_29', '황금 크라켄': 'Golden_Kraken', '미러 컨테이너': 'Mirror_Container',
    '거대 질량체': 'Massive_Object', '랜드 이터': 'Land_Eater', '베히모스': 'Behemoth',
    '백빙룡': 'White_Ice_Dragon', '거대 질량체Q': 'Massive_Object_Q', '검은 뱀': 'Black_Snake',
    '글러트니': 'Gluttony', '프로비던스': 'Providence', '환영 크라켄': 'Hologram_Kraken',
    '지즈': 'Ziz', '차가운 심판자': 'The_Merciless_Judge', '퀸 001': 'Queen_001',
    '온리 원': 'Only_One', '앨트루이아': 'Altruia', '에고비스타': 'Egovista',
    '애니힐리오': 'Annihilio', '아일랜드 이터': 'Island_Eater',
}


def load_rows():
    cfg = io.open(os.path.join(BASE, 'js', 'config.js'), encoding='utf-8').read()
    url = re.search(r"SUPABASE_URL\s*=\s*'([^']+)'", cfg).group(1)
    key = re.search(r"SUPABASE_ANON_KEY\s*=\s*'([^']+)'", cfg).group(1)
    # 이 표만 기본키가 번호가 아니라 id 다. 이름 변경 전/후 어느 쪽이든 읽히도록 둘 다 시도한다.
    for table, col in (('솔로_레이드', '약점_속성'), ('역대_테두리', '속성')):
        q = urllib.parse.quote(table) + '?select=' + urllib.parse.quote(f'id,시즌,보스,{col}')
        try:
            req = urllib.request.Request(url + '/rest/v1/' + q,
                                         headers={'apikey': key, 'Authorization': 'Bearer ' + key})
            rows = json.load(urllib.request.urlopen(req))
            return table, [{'id': r['id'], '시즌': r['시즌'], '보스': r['보스'], '약점': r[col]} for r in rows]
        except Exception:
            continue
    raise SystemExit('표를 읽지 못했다')


def index_files():
    """영문 보스 이름 -> {코드 또는 None: 파일명}"""
    files = {}
    for f in os.listdir(SRC_DIR):
        if not f.lower().endswith(('.webp', '.png', '.jpg', '.jpeg')):
            continue
        stem = os.path.splitext(f)[0]
        stem = re.sub(r'^Enemy_', '', stem)
        m = re.match(r'^(.*)_\(([A-Z.]+)\)$', stem)
        if m:
            name, code = m.group(1), m.group(2).replace('.', '')
        else:
            name, code = stem, None
        files.setdefault(name, {})[code] = f
    return files


def main():
    table_name, rows = load_rows()
    files = index_files()
    picks, skipped = [], []
    used_files = set()

    for r in sorted(rows, key=lambda x: int(x['시즌'])):
        boss, weak = r['보스'], (r['약점'] or '').strip()
        eng = NAME_MAP.get(boss)
        if not eng:
            skipped.append(f"시즌{r['시즌']} {boss}: 이미지 파일 이름을 모름")
            continue
        if weak not in WEAK_TO_SELF:
            skipped.append(f"시즌{r['시즌']} {boss}: 약점 속성이 비었거나 알 수 없음({weak!r})")
            continue
        self_attr, code = WEAK_TO_SELF[weak]
        variants = files.get(eng)
        if not variants:
            skipped.append(f"시즌{r['시즌']} {boss}: {eng} 이미지가 폴더에 없음")
            continue
        if code in variants:                      # 1) 속성 코드가 붙은 파일
            picked, why = variants[code], f'{self_attr}({code}) 표기 파일'
        elif len(variants) == 1 and None in variants:   # 2) 코드 없는 파일 하나뿐
            picked, why = variants[None], '변형이 없어 유일한 파일'
        else:
            have = ', '.join(sorted(k or '기본' for k in variants))
            skipped.append(f"시즌{r['시즌']} {boss}: {self_attr}({code}) 파일이 없음 (가진 것: {have})")
            continue
        picks.append({'id': r['id'], '시즌': r['시즌'], '보스': boss, '약점': weak,
                      '보스속성': self_attr, '파일': picked, '근거': why})

    # 한 이미지가 두 시즌에 걸리면 어느 쪽이 맞는지 알 수 없다 → 그 파일을 쓰는 시즌 전부 제외
    from collections import Counter
    dup = {f for f, n in Counter(p['파일'] for p in picks).items() if n > 1}
    if dup:
        for f in sorted(dup):
            seasons = [p for p in picks if p['파일'] == f]
            info = ', '.join(f"시즌{p['시즌']}({p['보스속성']})" for p in seasons)
            skipped.append(f'{f}: {info} 가 같은 파일을 가리킨다 → 어느 시즌 것인지 몰라 모두 제외')
        picks = [p for p in picks if p['파일'] not in dup]

    used_files = {p['파일'] for p in picks}
    os.makedirs(OUT_DIR, exist_ok=True)
    # 이전 실행에서 남은 파일 정리 (이번에 안 쓰는 것은 지운다)
    for f in os.listdir(OUT_DIR):
        if f not in used_files:
            os.remove(os.path.join(OUT_DIR, f))
    for f in sorted(used_files):
        shutil.copy2(os.path.join(SRC_DIR, f), os.path.join(OUT_DIR, f))

    with io.open(SQL_OUT, 'w', encoding='utf-8') as out:
        out.write('-- 솔로 레이드 보스 이미지를 약점 속성에 맞는 것으로 지정한다.\n')
        out.write('-- tools/match_boss_images.py 가 자동 생성했다. 이미지가 배포된 뒤 실행할 것.\n')
        out.write(f'-- 대상 표: {table_name} (이 표는 기본키가 번호가 아니라 id 다)\n\n')
        out.write('BEGIN;\n\n')
        for p in picks:
            out.write(f"-- 시즌{p['시즌']} {p['보스']} / 약점 {p['약점']} → 보스 {p['보스속성']}\n")
            out.write(f"UPDATE \"{table_name}\" SET \"보스_이미지\" = "
                      f"'{PUBLIC_BASE}/{p['파일']}' WHERE id = {p['id']};\n")
        out.write('\nCOMMIT;\n')

    print(f'고른 것 {len(picks)}건 / 건너뛴 것 {len(skipped)}건 / 복사한 파일 {len(used_files)}개')
    print(f'SQL → {SQL_OUT}\n')
    print('[고른 목록]')
    for p in picks:
        print(f"  시즌{p['시즌']:>2} {p['보스']:<12} 약점 {p['약점']} → {p['보스속성']:<3} {p['파일']}")
    if skipped:
        print('\n[건너뜀]')
        for s in skipped:
            print('  ' + s)


if __name__ == '__main__':
    main()
