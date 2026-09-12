# -*- coding: utf-8 -*-
"""리포의 이미지와 DB가 가리키는 이미지를 맞춰 본다.

내는 것:
  [A] 리포에 있는데 DB 어디서도 안 쓰이는 파일  -> 지울 후보
  [B] DB 가 가리키는데 리포에 없는 파일          -> 화면에서 깨지는 것
  [C] 제대로 된 이름의 파일을 올려 뒀는데 DB 는 아직 옛 mi_*.png 를 가리키는 것
      -> DB 를 먼저 고치고, 그 다음에 mi_ 를 지우면 된다

주의: 파일 이름에 공백이 들어가므로(예: "드레이크 그레이트 빌런.webp")
      JSON 을 통째로 정규식으로 훑으면 이름이 잘린다. 반드시 값 단위로 봐야 한다.
      sparse-checkout 으로 안 받은 폴더는 판단할 수 없어서 건너뛴다.
"""
import io, json, os, re, sys, urllib.parse, urllib.request

URL = 'https://ivregkjnayxoyjuupuru.supabase.co'
KEY = ('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2cmVna2pu'
       'YXl4b3lqdXVwdXJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMTQxODQsImV4cCI6MjEwMDU5MDE4NH0'
       '.EwdZo5HAahijqmD-l43cuAk0N2dP7svmXRyeP6YWl7c')
TABLES = ['픽업_기록', '유니크_코스튬', '기념품', '스테이지_정보', '미실장_캐릭터',
          'IMG_니케', 'IMG_아이콘', 'IMG_챕터', '메인_업데이트', '메인_이벤트', '솔로_레이드']
EXT = re.compile(r'\.(png|jpe?g|webp|gif|svg|avif)$', re.I)


def fetch(table):
    rows, start = [], 0
    while True:
        q = URL + '/rest/v1/' + urllib.parse.quote(table) + '?select=*&limit=1000&offset=%d' % start
        req = urllib.request.Request(q, headers={'apikey': KEY, 'Authorization': 'Bearer ' + KEY})
        part = json.load(urllib.request.urlopen(req))
        rows += part
        if len(part) < 1000:
            return rows
        start += 1000


def collect(value, table, used):
    if isinstance(value, str):
        s = urllib.parse.unquote(value.strip())
        if EXT.search(s) and not s.lower().startswith('http'):
            used.setdefault(s.lstrip('./'), set()).add(table)
    elif isinstance(value, dict):
        for v in value.values():
            collect(v, table, used)
    elif isinstance(value, list):
        for v in value:
            collect(v, table, used)


def main():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(base)
    used = {}
    for t in TABLES:
        collect(fetch(t), t, used)

    have = set()
    for root, _, files in os.walk('img'):
        for f in files:
            if EXT.search(f):
                have.add((root + '/' + f).replace(os.sep, '/'))

    # 실제로 받아 둔 폴더만 판단한다
    checked = sorted({p.split('/')[1] for p in have})
    def known(p):
        return len(p.split('/')) > 1 and p.split('/')[1] in checked

    orphan = sorted(p for p in have if p not in used)
    missing = sorted(p for p in used if p not in have and known(p))

    out = io.open('_image_report.txt', 'w', encoding='utf-8')
    out.write('DB가 가리키는 리포 이미지 %d개 / 로컬 이미지 %d개\n' % (len(used), len(have)))
    out.write('확인한 폴더: %s\n' % ', '.join('img/' + c for c in checked))
    out.write('\n[A] 리포에 있는데 DB 어디서도 안 쓰임: %d개\n' % len(orphan))
    for p in orphan:
        out.write('    %s\n' % p)
    out.write('\n[B] DB가 가리키는데 리포에 없음: %d개\n' % len(missing))
    for p in missing:
        out.write('    %s  <- %s\n' % (p, ','.join(sorted(used[p]))))

    # [C] 이름이 제대로인 파일이 있는데 DB 는 아직 mi_ 를 쓰는 경우
    out.write('\n[C] 새 파일은 올렸는데 DB가 아직 mi_*.png 를 가리킴\n')
    rows = fetch('IMG_니케')
    n = 0
    for r in rows:
        for label, col in (('', '이미지'), ('코스튬1', '코스튬1_이미지'), ('코스튬2', '코스튬2_이미지')):
            cur = r.get(col) or ''
            if 'mi_' not in cur:
                continue
            name = r.get('이름') or ''
            if label:
                name = name + ' ' + (r.get(label) or '')
            key = re.sub(r'\s+', ' ', name.replace(' : ', ' ').replace(':', ' ')).strip()
            cand = 'img/nikke/%s.webp' % key
            if cand in have and cand not in used:
                n += 1
                out.write('    번호 %-4s %-22s %s\n        %s  ->  %s\n'
                          % (r.get('번호'), col, key, cur, cand))
    out.write('    합계 %d개\n' % n)
    out.close()
    print('_image_report.txt 에 적었다. 고아 %d / 깨짐 %d / DB갱신대상 %d' % (len(orphan), len(missing), n))


if __name__ == '__main__':
    main()
