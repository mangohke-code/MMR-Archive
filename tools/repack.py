"""재언팩된 원본 glb 를 웹용으로 압축한다.

파이프라인: gltf-transform resample -> prune -> draco -> glb_webp.py
파일 이름에 공백·중점(·)·한글이 섞여 있어서 셸로 돌리면 인용이 계속 깨진다.
그래서 목록을 여기 적고 파이썬에서 직접 호출한다.
"""
import gzip
import json
import re
import os
import struct
import shutil
import subprocess
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# 2026-09-30 원본 폴더가 이미지 -> 리소스 로 옮겨졌다.
# REPACK_SRC / REPACK_OUT 으로 바꿔 지정할 수 있다 — 새로 뽑은 원본을 올라가 있는
# 파일과 섞지 않고 따로 묶어 볼 때(정보모음-web/_local/new, 깃에 안 올라간다).
SRC = os.environ.get('REPACK_SRC') or os.path.join(BASE, '리소스', '보스')
UPLOAD = os.environ.get('REPACK_OUT') or os.path.join(BASE, '업로드용 보스 3D')
WEBP = os.path.join(BASE, '정보모음-web', 'tools', 'glb_webp.py')

# (원본 상대경로, 출력 이름)
JOBS = [
    # 2026-09-13, 추출 프로그램이 갱신되면서 원본을 전부 새로 뽑았다.
    # 카메라 노드가 연출별로 갈라지고 pairedClip·cutTimes 가 붙었다.
    # 원본은 시즌 폴더가 아니라 이 폴더 하나에 모여 있다.
    ('추출프로그램 업데이트 이후/eba001_스톰브링어 A.N.M.I.glb', 'eba001'),
    ('추출프로그램 업데이트 이후/mbg002_그레이브 디거 raid.glb', 'mbg002'),
    ('추출프로그램 업데이트 이후/xba002_퀸 001 D.M.T.R.glb', 'xba002'),
    # 2026-10-02 19:53 추출기부터 등장 맵 연출의 하모니 큐브 리그(appearance_bg_var)가 나온다.
    # bg_1 · bg_2 가 take1(3.167초) · take2(12.467초)와 같은 슬롯에서 돈다.
    (['추출프로그램 업데이트 이후/xba001_미러 컨테이너.glb',
      '추출프로그램 업데이트 이후/xba001_미러 컨테이너_xba001_appearance_bg_var.glb'], 'xba001'),
    # 2026-09-16, 추출 프로그램이 "클립 많은 리그가 기본 이름을 갖는다" 로 바뀌면서
    # 베히모스 두 파일의 내용이 서로 뒤바뀌었다. 기본 이름 쪽이 2페이즈(클립 34개)고
    # _mbg003_psid 쪽이 1페이즈(클립 7개)다. 애니힐리오도 같이 뒤바뀌었지만 그쪽은
    # 둘을 합쳐 쓰므로 결과가 같다.
    # 2026-10-02 재추출부터 부속 파일 이름이 리그 이름 기준이다(_mbg003_psid -> _mbg003_1phase_var).
    # 2페이즈 전환 맵 연출의 부품 리그 둘(_2phase_b2_take2_bmapob_var / (1), 2026-10-02 19:53 추출기부터)은
    # 넣지 않는다. 앞 컷(b1_take1_a) · 뒤 컷(take2)에 붙여 봤지만 화면 아래 끝에 걸치기만 해서 차이가 거의 없었다
    # (2026-10-02 사용자 판단).
    ('추출프로그램 업데이트 이후/mbg003_베히모스 P.S.I.D_mbg003_1phase_var.glb', 'mbg003_1phase'),
    ('추출프로그램 업데이트 이후/mbg003_베히모스 P.S.I.D.glb', 'mbg003_2phase'),
    # 검은 뱀은 스팟 번들이 둘인데, 카메라 셋은 본 번들에만 있다.
    # " · summon" 변형에는 카메라 클립이 아예 없어서 본 번들을 쓴다.
    # 2026-09-30 재추출부터 가운데 본체와 좌우 머리가 파일 셋으로 나온다(그 전에는
    # 추출기가 모든 클립을 왼쪽 머리에 붙여서 본체·오른쪽 머리가 빠져 있었다).
    # 셋은 뼈·메쉬 이름이 같아서 SUFFIXES 로 머리 쪽 이름을 갈라 합친다.
    # _sd_bbg008_var 는 보스 프리팹 밖 리그(outsidePrefab)라 넣지 않는다.
    (['추출프로그램 업데이트 이후/bbg008_검은 뱀 H.S.T.A.glb',
      '추출프로그램 업데이트 이후/bbg008_검은 뱀 H.S.T.A_bbg008_left_var.glb',
      '추출프로그램 업데이트 이후/bbg008_검은 뱀 H.S.T.A_bbg008_right_var.glb'], 'bbg008'),
    # 거대 질량체 두 마리는 예전에 이 목록에 없었다(다른 경로로 만들어 올린 듯하다).
    # 2026-10-02 19:53 추출기부터 등장·사망 맵 연출의 부속 리그(model_acc · death_acc_md)가 게임 타임라인과
    # 함께 나온다. 길이가 보스 동작과 같다(등장 13.5초 · 사망 7.333초).
    (['추출프로그램 업데이트 이후/eba004_거대 질량체.glb',
      '추출프로그램 업데이트 이후/eba004_거대 질량체_eba004_model_acc_var.glb',
      '추출프로그램 업데이트 이후/eba004_거대 질량체_eba004_death_acc_md_var.glb'], 'eba004'),
    (['추출프로그램 업데이트 이후/eba004_거대 질량체Q.glb',
      '추출프로그램 업데이트 이후/eba004_거대 질량체Q_eba004_model_acc_var.glb',
      '추출프로그램 업데이트 이후/eba004_거대 질량체Q_eba004_death_acc_md_var.glb'], 'eba004_dmtr'),
    ('추출프로그램 업데이트 이후/xbg002_프로비던스 Z.E.U.S.glb', 'xbg002'),
    ('추출프로그램 업데이트 이후/xbg003_온리 원 H.S.T.A.glb', 'xbg003'),
    ('추출프로그램 업데이트 이후/xbg004_앨트루이아 Z.E.U.S.glb', 'xbg004'),
    ('추출프로그램 업데이트 이후/xbg005_에고비스타 P.S.I.D.glb', 'xbg005'),
    # 아일랜드 이터는 랜드 이터(ebg001)의 변종이다. 사치스러운 거미와 같은 이유로
    # 출력 이름에 변종을 적는다.
    ('추출프로그램 업데이트 이후/ebg001_아일랜드 이터.glb', 'ebg001_island'),
    # 사치스러운 거미는 하베스터(bbg001)의 변종이라 메쉬 이름이 원종과 같다.
    # 뷰어가 규칙을 파일 이름으로 가르므로 출력 이름에 변종을 적어 둔다.
    # 다리 부품(_bbg001_psid_legs_parts_var, 2026-10-02 19:53 추출기부터)은 넣지 않는다. 게임 타임라인
    # bbg001_shot_07_leg_model 1.067~5.967초(skill_fire_02 -> skill_loop_03)에 켜지지만(controlActivation)
    # 움직임 데이터가 없어서 합치면 보스 머리 위 화면 밖(프리팹 y 50)에 가만히 떠 있기만 한다.
    ('추출프로그램 업데이트 이후/bbg001_사치스러운 거미.glb', 'bbg001_rich'),
    # 애니힐리오는 1·2페이즈를 한 파일로 합친다. 페이즈 전환 연출이 두 파일에
    # 걸쳐 있어서, 나눠 두면 전환할 때마다 모델을 새로 받느라 연출이 끊긴다.
    # 두 파일은 노드·클립·메쉬 이름이 하나도 안 겹쳐서 그냥 붙이면 된다.
    (['추출프로그램 업데이트 이후/xba003_애니힐리오 D.M.T.R.glb',
      # 2026-10-02 재추출부터 _xba003_dmtr -> _xba003_1phase_var
      '추출프로그램 업데이트 이후/xba003_애니힐리오 D.M.T.R_xba003_1phase_var.glb'], 'xba003'),
    # 2페 등장 맵 연출의 구체(_xba003_12phase_sphere_app_var, 2.233초 = 12phase_appeanrance)는 넣지 않는다.
    # 합쳐 보니 보스 위에서 검은 구체가 내려오는데, 구체 없는 쪽이 인게임에 맞다(2026-10-02 사용자 판단).
    # 리버렐리오 바디는 리그가 셋이다 - 1페이즈 몸, 2페이즈 몸, 해파리.
    # 2페이즈 전환이 셋을 같은 6.667 초에 동시에 돌리므로 한 파일로 합친다.
    # 해파리는 노드·클립·메쉬 이름이 나머지 둘과 하나도 안 겹친다.
    # 애니힐리오와 달리 1·2페이즈끼리는 63개가 겹치는데, 겹치는 것은 전부
    # 뼈와 fx 노드(parts_col_01~15 등)라 화면에 영향이 없다. 진짜 문제는
    # 카메라 하나뿐이고 그건 RENAMES 가 처리한다.
    # 2026-09-18 재추출에서 파일 이름이 바뀌었다(에셋 이름 -> 보스 이름 · 변종).
    #   eba002_eba002 H.S.T.A        -> eba002_리버렐리오 바디 H.S.T.A. · singleraid
    #   ..._eba002_hsta              -> ..._eba002_hsta_singleraid
    # 2026-09-30 재추출(부속 파일 이름이 리그 이름 기준으로 바뀜)
    #   ..._eba002_hsta_singleraid   -> ..._eba002_2phase_var
    (['추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid.glb',
      '추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid_eba002_2phase_var.glb',
      '추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid_eba002_jellyfish_obj_var.glb',
      # 2026-10-02 19:53 추출기부터 해파리가 맵 연출 셋(등장 · 2페 전환 · 사망)에 하나씩, 세 벌로
      # 나온다. 셋 다 맵 부모 배치(placement, 크기 1.333 · 사망 쪽은 z +75.6)가 붙는다.
      '추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid_boss_2phase_appearance _eba002_jellyfish_obj_var.glb',
      '추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid_boss_dead_eba002_jellyfish_obj_var.glb'],
     'eba002'),
    # 시즌 42 앨트루이아. 시즌 34 것(Z.E.U.S.)과 메쉬·카메라·공유 클립 20개가
    # 전부 같고, 스킬 3 한 벌(start/loop/fire)이 더 있고 재질 이름이 psid 로 갈렸다.
    ('추출프로그램 업데이트 이후/xbg004_앨트루이아 P.S.I.D.glb', 'xbg004_psid'),
    # 마더웨일은 시즌 1(기본)과 시즌 29(Z.E.U.S.) 두 벌로 나왔는데, 화면에 나오는 것은
    # 전부 같다 — 메쉬 13개의 기하, 텍스처 2장, 재질, 클립 41개의 키 값(노드 이름으로
    # 맞춰 대조), 카메라 3개까지 바이트로 일치한다. 다른 것은 이펙트 부착점·충돌체 같은
    # 빈 노드(ZEUS 에 +32, 기본에 +13)뿐이라 뷰어에는 안 보인다. 그래서 한 파일로 두 시즌을 댄다.
    ('bba001_마더웨일.glb', 'bba001'),
    # 지즈(시즌 28). 2026-10-02 추출본. 부속 파일 없이 하나로 나왔다.
    ('추출프로그램 업데이트 이후/eba005_지즈 A.N.M.I.glb', 'eba005'),
    # 울트라. 시즌 7(Z.E.U.S.)과 시즌 37(H.S.T.A.)이 메쉬·텍스처·동작·카메라까지 같은데
    # 스킬 묶음(게임 타임라인)이 달라서 둘로 낸다 — 뷰어가 파일 이름(bossKey)으로 묶음을 가른다.
    # 부속 _bbg006_intro_aircraft_var / _intro_nikke_var(전투기 · 양산형 니케)는 넣지 않는다. 긴 등장(17.6초)은
    # 기본 울트라(bbg006_map)에만 있고, Z.E.U.S. · H.S.T.A. 맵은 리그만 남고 트는 타임라인이 비어 있다
    # (추출 세션 확인, 2026-10-02). 원본 파일도 지웠다(휴지통).
    ('추출프로그램 업데이트 이후/bbg006_울트라 Z.E.U.S.glb', 'bbg006'),
    ('추출프로그램 업데이트 이후/bbg006_울트라 H.S.T.A.glb', 'bbg006_hsta'),
    # 크리스탈 체임버. 시즌 10(P.S.I.D.)과 시즌 35(A.N.M.I.)는 메쉬·동작·카메라 값이 같은데
    # 텍스처(psid / anmi)와 게임이 쓰는 동작이 달라서 둘로 낸다. 시즌 10 만 방어막·큰 뿔
    # 발광 층(fx_ 재질)이 있다.
    # 2026-10-02 19:53 추출기부터 등장 맵 연출(boss_appearance)의 리그가 배치(placement)와 함께
    # 나온다. take1 의 xcg001(크리스탈에 휩싸이는 작은 랩처)과 take2 의 검은 벽을 합친다.
    (['추출프로그램 업데이트 이후/xbg001_크리스탈 체임버 P.S.I.D.glb',
      '추출프로그램 업데이트 이후/xbg001_크리스탈 체임버 P.S.I.D_xbg001_1phase_xcg001_var.glb',
      '추출프로그램 업데이트 이후/xbg001_크리스탈 체임버 P.S.I.D_xbg001_1phase_black_t2_var.glb'], 'xbg001'),
    (['추출프로그램 업데이트 이후/xbg001_크리스탈 체임버 A.N.M.I.glb',
      '추출프로그램 업데이트 이후/xbg001_크리스탈 체임버 A.N.M.I_xbg001_1phase_xcg001_var.glb',
      '추출프로그램 업데이트 이후/xbg001_크리스탈 체임버 A.N.M.I_xbg001_1phase_black_t2_var.glb'], 'xbg001_anmi'),
    # 인디빌리아(시즌 13). 2026-10-02 추출본. 1페 등장 맵 연출(boss_appearance, 타임라인
    # ebg003_1phase_intro_01_parts 7.467초 = intro_01 슬롯)의 리그 둘 — parts_01(ecg007 몸·다리 + Object001),
    # parts_02(arms_parts) — 을 합친다.
    (['추출프로그램 업데이트 이후/ebg003_인디빌리아.glb',
      '추출프로그램 업데이트 이후/ebg003_인디빌리아_ebg003_1phase_intro_01_parts_01_md_var.glb',
      '추출프로그램 업데이트 이후/ebg003_인디빌리아_ebg003_1phase_intro_01_parts_02_md_var.glb'], 'ebg003'),
    # 크라켄 변종 둘(시즌 15 황금 · 시즌 27 환영). 메쉬·동작 구성이 같고 재질(golden / hologram)과
    # 게임이 쓰는 스킬(환영만 skill_06 이 타임라인)이 다르다. 뷰어 규칙은 /^bbg004/ 로 둘 다 잡는다.
    # 부속 파일은 넣지 않는다 — _bbg004_bg_var · _intro_bg_model_var · _outro_bg_model_var ·
    # _boss_dead_bbg004_bg_var 는 맵 배경(바다 수면 · 깊은 바다 판 · 물고기 떼 · 소품)이고,
    # _bbg004_squid 는 보스 프리팹 밖 리그(outsidePrefab)에 게임이 안 쓴다(inGameUse []).
    ('추출프로그램 업데이트 이후/bbg004_황금 크라켄.glb', 'bbg004_golden'),
    ('추출프로그램 업데이트 이후/bbg004_환영 크라켄.glb', 'bbg004_hologram'),
    # 니힐리스타(시즌 12). 2페이즈 전환 가운데 컷(카메라 Camera (2), 1.8초)이 비추는 눈 리그
    # _2phase_eye_mesh(동작 2phase_eye, placement = Camera (2) 자리)를 합친다.
    (['추출프로그램 업데이트 이후/mba002_니힐리스타.glb',
      '추출프로그램 업데이트 이후/mba002_니힐리스타_2phase_eye_mesh.glb'], 'mba002'),
    # 백빙룡(시즌 20). 니힐리스타(mba002)의 변종이라 출력 이름에 변종을 적는다.
    # 원본이 두 벌 나왔는데(_백빙룡 = 프리팹 mba002_whiteice_psid, _mba002_psid_var = …_psid_over)
    # 텍스처 · 메쉬 · 동작 값이 전부 같고 프리팹 이름과 내부 ID 만 다르다. 기본 쪽을 쓴다.
    # 눈 리그 부속(_phase002_appearance_model · _mba002_whiteice_psid_over)은 동작이 없고 비추는 카메라도
    # 없어서 넣지 않는다.
    ('추출프로그램 업데이트 이후/mba002_백빙룡.glb', 'mba002_whiteice'),
    # 알트아이젠. 시즌 4 = P.S.I.D.(보스 이미지 full_mbg001_psid_1), 시즌 32 = A.N.M.I. · singleraid(full_mbg001).
    # 메쉬 · 동작 구성이 같고 재질(psid_*)과 게임이 쓰는 스킬(A.N.M.I. 만 skill_04 · 05 가 타임라인)이 다르다.
    ('추출프로그램 업데이트 이후/mbg001_알트아이젠 P.S.I.D.glb', 'mbg001_psid'),
    ('추출프로그램 업데이트 이후/mbg001_알트아이젠 A.N.M.I. · singleraid.glb', 'mbg001'),
    # 글러트니(시즌 25, 보스 이미지 full_bbg009_anmi)와 차가운 심판자(시즌 30, full_bbg009_bh_psid_1).
    # 같은 리그(bbg009)에 서로의 동작이 실려 있어 DROP_CLIPS 로 상대 쪽 동작을 뺀다. 부속 파일 없음.
    ('추출프로그램 업데이트 이후/bbg009_글러트니 A.N.M.I.glb', 'bbg009'),
    ('추출프로그램 업데이트 이후/bbg009_차가운 심판자.glb', 'bbg009_bh'),
    # 블랙스미스(시즌 2, full_bbg003)와 콜라보 변종(시즌 5 9810811510911663, full_bbg003_ce002_1).
    # 좌우 촉수 부속(_bbg003_l/r_tentacle_var)은 본체에 같은 리그가 이미 들어 있다(bbg003_l/r_tentacle 뼈 아래).
    ('추출프로그램 업데이트 이후/bbg003_블랙스미스.glb', 'bbg003'),
    ('추출프로그램 업데이트 이후/bbg003_블랙스미스 ce002.glb', 'bbg003_ce002'),
    # 마테리얼H - 시즌 9 D.M.T.R.(full_ebg002_dmtr_1) · 시즌 22 H.S.T.A.(full_ebg002_hsta_1). 메쉬 · 동작 구성이 같고
    # 재질만 다르다. 부속 파일 없음.
    ('추출프로그램 업데이트 이후/ebg002_마테리얼H D.M.T.R.glb', 'ebg002_dmtr'),
    ('추출프로그램 업데이트 이후/ebg002_마테리얼H H.S.T.A.glb', 'ebg002_hsta'),
    # 하베스터(시즌 3, full_bbg001). 다리 부품(_bbg001_legs_parts_var)은 사치스러운 거미와 같은 이유로 넣지 않는다
    # (움직임 데이터가 없고 controlActivation 만 있다). 거미 전용 동작 rich_skill* 은 DROP_CLIPS 로 뺀다.
    ('추출프로그램 업데이트 이후/bbg001_하베스터.glb', 'bbg001'),
    # 토커티브(시즌 8, full_bbg002_1). 부속 파일 없음.
    ('추출프로그램 업데이트 이후/bbg002_토커티브.glb', 'bbg002'),
    # 랜드 이터(시즌 18, full_ebg001_hsta_1). 아일랜드 이터(ebg001_island)의 원종 - 메쉬 · 동작이 같고
    # 나무 메쉬 둘(1phase/2phase_tree)이 없다. 부속 파일 없음.
    ('추출프로그램 업데이트 이후/ebg001_랜드 이터 H.S.T.A.glb', 'ebg001_hsta'),
    # 모더니아 - 시즌 6(full_mbg004) · 시즌 21 A.N.M.I.(full_mbg004_anmi). A.N.M.I. 만 스커트 메쉬 둘이 더 있다.
    # 부속 _mbg004_rifle_var 는 보스 프리팹 밖 리그(outsidePrefab)이고 동작 둘 다 inGameUse [] 라 넣지 않는다.
    ('추출프로그램 업데이트 이후/mbg004_모더니아.glb', 'mbg004'),
    ('추출프로그램 업데이트 이후/mbg004_모더니아 A.N.M.I.glb', 'mbg004_anmi'),
]

# 합치기 전에 이름을 갈아 둘 것. { 원본 상대경로: { 옛 이름: 새 이름 } }
#
# 리버렐리오 2페이즈 등장 카메라가 양쪽 파일에 같은 이름으로 한 번씩 실린다.
# 추출 규칙이 "카메라는 짝이 그 파일에 있을 때만 담는다" 인데, 전환 연출이 리그
# 둘을 동시에 돌려서 짝이 양쪽에 하나씩 있기 때문이다. 값은 201프레임 전부
# 똑같고 pairedClip 만 다르다(01 = 1페이즈 몸, 02 = 2페이즈 몸).
#
# 그대로 합치면 노드 이름도 클립 이름도 겹쳐서 three.js 가 뒤엣것에 _1 을 붙이고,
# 그러면 어느 카메라 클립이 어느 카메라 노드인지 못 가른다(cameraClipTarget 이
# 트랙 이름의 앞머리로 찾는다). 2페이즈 쪽 이름을 갈아 둔다.
#
# 짝짓기는 extras.pairedClip 을 먼저 보므로 이름을 바꿔도 짝은 안 어긋난다.
#
# 2026-09-30 재추출부터는 동작 주인을 게임 타임라인·애니메이터 바인딩으로 정해서,
# 연출이 두 몸을 같이 묶으면 양쪽 파일에 같은 이름의 동작이 하나씩 실린다.
#   1페 몸 파일의 eba002_2phase_death  - root 만 움직이는 2채널(사망 내내 1페 몸은 꺼짐)
#   2페 몸 파일의 eba002_1phase_intro  - 같은 식(1페 등장 내내 2페 몸은 꺼짐)
# 합치면 이름이 겹쳐 뒤엣것에 _2 가 붙고, 연출 카메라가 이름으로 짝을 찾다가 먼저
# 온 빈 동작에 붙는다(2페 사망이 카메라만 돌고 몸은 안 움직였다). 빈 쪽 이름을 간다.
RENAMES = {
    '추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid.glb': {
        'eba002_2phase_death': 'eba002_2phase_death_1pvar',
    },
    '추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid_eba002_2phase_var.glb': {
        'eba002_2phase_intro_camera': 'eba002_2phase_intro_02_camera',
        'eba002_1phase_intro': 'eba002_1phase_intro_2pvar',
    },
}

# 리그 전체의 이름 뒤에 꼬리를 붙여 합칠 파일. { 원본 상대경로: (꼬리, 그대로 둘 노드 이름) }
#
# 검은 뱀 좌우 머리는 본체와 뼈·메쉬 이름이 전부 같다. 그대로 합치면 three.js 가
# 트랙을 이름으로 묶어서 머리 클립이 본체 뼈를 움직인다. 노드는 전부, 클립은 본체와
# 이름이 겹치는 것만(recall_enter_01, destroy_01) 꼬리를 붙인다. 꼬리를 앞이 아니라
# 뒤에 붙이는 건 뷰어의 뼈 이름 규칙(root·Helper_ 로 시작하는 기준 뼈 가르기)이
# 앞머리로 보기 때문이다. 루트(bbg008_left_var 등)는 이미 고유해서 그대로 둔다.
SUFFIXES = {
    '추출프로그램 업데이트 이후/bbg008_검은 뱀 H.S.T.A_bbg008_left_var.glb':
        ('_left', {'bbg008_left_var'}, {'bbg008_recall_enter_01', 'bbg008_destroy_01'}),
    '추출프로그램 업데이트 이후/bbg008_검은 뱀 H.S.T.A_bbg008_right_var.glb':
        ('_right', {'bbg008_right_var'}, {'bbg008_recall_enter_01', 'bbg008_destroy_01'}),
    # 맵 연출 부속 리그 - 뼈 이름(root 등)이 본체와 겹칠 수 있어 노드·메쉬 이름 전부에 꼬리를 붙인다.
    # 거대 질량체는 등장·사망 리그끼리도 메쉬 이름(eba003_body · led01 …)이 같다.
    '추출프로그램 업데이트 이후/eba004_거대 질량체_eba004_model_acc_var.glb': ('_accapp', set(), set()),
    '추출프로그램 업데이트 이후/eba004_거대 질량체_eba004_death_acc_md_var.glb': ('_accdead', set(), set()),
    '추출프로그램 업데이트 이후/eba004_거대 질량체Q_eba004_model_acc_var.glb': ('_accapp', set(), set()),
    '추출프로그램 업데이트 이후/eba004_거대 질량체Q_eba004_death_acc_md_var.glb': ('_accdead', set(), set()),
    '추출프로그램 업데이트 이후/xba001_미러 컨테이너_xba001_appearance_bg_var.glb': ('_bgvar', set(), set()),
    '추출프로그램 업데이트 이후/ebg003_인디빌리아_ebg003_1phase_intro_01_parts_01_md_var.glb': ('_mapa', set(), set()),
    '추출프로그램 업데이트 이후/ebg003_인디빌리아_ebg003_1phase_intro_01_parts_02_md_var.glb': ('_mapb', set(), set()),
    '추출프로그램 업데이트 이후/mba002_니힐리스타_2phase_eye_mesh.glb': ('_eye', set(), set()),
    # 리버렐리오 해파리 세 벌은 뼈·메쉬 이름이 전부 같다(동작 이름은 셋이 다르다).
    # 연출마다 자기 해파리만 켜야 해서 이름을 가른다 - _intro(1페 등장) · _change(2페 전환) · _dead(사망).
    '추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid_eba002_jellyfish_obj_var.glb':
        ('_intro', set(), set()),
    '추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid_boss_2phase_appearance _eba002_jellyfish_obj_var.glb':
        ('_change', set(), set()),
    '추출프로그램 업데이트 이후/eba002_리버렐리오 바디 H.S.T.A. · singleraid_boss_dead_eba002_jellyfish_obj_var.glb':
        ('_dead', set(), set()),
}

# 파일에서 아예 뺄 동작. { 원본 상대경로: 이름 정규식 } - 빼고 나면 prune 이 딸린 데이터도 지운다.
#
# 글러트니 파일에는 차가운 심판자(같은 bbg009 리그) 동작 bh_* 21개가, 차가운 심판자 파일에는 글러트니 동작
# 22개가 같이 실려 있다. 상대 쪽 동작은 inGameUse [] 이고 애니메이터 상태에도 없다. 전부 3000 채널 안팎이라
# 크기의 절반 가까이를 차지한다(글러트니 80.4 -> 41.9 MB).
DROP_CLIPS = {
    '추출프로그램 업데이트 이후/bbg009_글러트니 A.N.M.I.glb': r'^bbg009_bh_',
    '추출프로그램 업데이트 이후/bbg009_차가운 심판자.glb': r'^bbg009_(?!bh_)(?!.*_camera$)',
    # 하베스터 파일에 실린 사치스러운 거미 전용 동작(inGameUse [], 애니메이터 상태에도 없음)
    '추출프로그램 업데이트 이후/bbg001_하베스터.glb': r'^bbg001_rich_',
}

GT = ['npx', '--yes', '@gltf-transform/cli@latest']


def drop_clips_in_glb(src, dst, pattern):
    chunks, doc = _read_glb(src)
    rx = re.compile(pattern)
    doc['animations'] = [a for a in doc.get('animations') or [] if not rx.search(a.get('name') or '')]
    _write_glb(dst, chunks, doc)


def rename_in_glb(src, dst, table):
    """노드·애니메이션 이름만 바꿔 새 파일로 쓴다.

    인덱스는 건드리지 않는다 - glTF 애니메이션 채널은 노드를 번호로 가리키므로
    이름을 바꿔도 대상은 그대로다. three.js 는 불러올 때 노드 이름으로 트랙
    이름을 만들기 때문에, 노드와 클립 이름을 같이 갈아 주면 짝짓기가 맞는다.
    """
    with open(src, 'rb') as f:
        struct.unpack('<III', f.read(12))
        chunks = []
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            ln, ty = struct.unpack('<II', hdr)
            chunks.append([ty, f.read(ln)])
    doc = json.loads(chunks[0][1].decode('utf-8'))
    hit = 0
    seen = set()
    for key in ('nodes', 'animations'):
        for item in doc.get(key) or []:
            fixed = table.get(item.get('name'))
            if fixed:
                seen.add(item.get('name'))
                item['name'] = fixed
                hit += 1
    # 카메라는 노드 하나 + 클립 하나가 짝이고, 동작만 가르는 이름은 클립 하나다.
    # 적어 둔 이름이 하나라도 안 보이면 원본이 바뀐 것이니 멈춘다.
    missing = [k for k in table if k not in seen]
    if missing:
        raise RuntimeError('이름 바꾸기 대상이 없다: %s (%s)'
                           % (', '.join(missing), os.path.basename(src)))
    raw = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    raw += b' ' * ((4 - len(raw) % 4) % 4)
    chunks[0][1] = raw
    body = b''
    for ty, data in chunks:
        pad = b'\x00' if ty == 0x004E4942 else b' '
        data = data + pad * ((4 - len(data) % 4) % 4)
        body += struct.pack('<II', len(data), ty) + data
    with open(dst, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


def suffix_in_glb(src, dst, suffix, keep_nodes, clip_names):
    """노드·메쉬 이름 전부와 지정한 클립 이름에 꼬리를 붙여 새 파일로 쓴다(SUFFIXES)."""
    with open(src, 'rb') as f:
        struct.unpack('<III', f.read(12))
        chunks = []
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            ln, ty = struct.unpack('<II', hdr)
            chunks.append([ty, f.read(ln)])
    doc = json.loads(chunks[0][1].decode('utf-8'))
    for n in doc.get('nodes') or []:
        if n.get('name') and n['name'] not in keep_nodes:
            n['name'] += suffix
    # 메쉬 이름도 갈라야 한다. three.js 는 프리미티브가 여럿인 메쉬를 노드 이름이
    # 아니라 메쉬 이름으로 부른다(bbg008_body_skin_2, _3 …). 안 가르면 머리 메쉬가
    # 본체와 같은 이름에 번호만 달라서 이름 규칙으로 못 고른다.
    for m in doc.get('meshes') or []:
        if m.get('name'):
            m['name'] += suffix
    for a in doc.get('animations') or []:
        if a.get('name') in clip_names:
            a['name'] += suffix
    raw = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    raw += b' ' * ((4 - len(raw) % 4) % 4)
    chunks[0][1] = raw
    body = b''
    for ty, data in chunks:
        pad = b'\x00' if ty == 0x004E4942 else b' '
        data = data + pad * ((4 - len(data) % 4) % 4)
        body += struct.pack('<II', len(data), ty) + data
    with open(dst, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


def _read_glb(path):
    with open(path, 'rb') as f:
        struct.unpack('<III', f.read(12))
        chunks = []
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            ln, ty = struct.unpack('<II', hdr)
            chunks.append([ty, f.read(ln)])
    return chunks, json.loads(chunks[0][1].decode('utf-8'))


def _write_glb(path, chunks, doc):
    raw = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    raw += b' ' * ((4 - len(raw) % 4) % 4)
    chunks[0][1] = raw
    body = b''
    for ty, data in chunks:
        pad = b'\x00' if ty == 0x004E4942 else b' '
        data = data + pad * ((4 - len(data) % 4) % 4)
        body += struct.pack('<II', len(data), ty) + data
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


def _mat_mul(a, b):
    # glTF 열 우선 4x4
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def _trs_matrix(node):
    if 'matrix' in node:
        return list(node['matrix'])
    tx, ty, tz = node.get('translation', [0, 0, 0])
    x, y, z, w = node.get('rotation', [0, 0, 0, 1])
    sx, sy, sz = node.get('scale', [1, 1, 1])
    r = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
         2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
         2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]
    return [r[0] * sx, r[1] * sx, r[2] * sx, 0,
            r[3] * sy, r[4] * sy, r[5] * sy, 0,
            r[6] * sz, r[7] * sz, r[8] * sz, 0,
            tx, ty, tz, 1]


def has_placement(path):
    _, doc = _read_glb(path)
    return any((doc['nodes'][i].get('extras') or {}).get('placement')
               for i in doc['scenes'][doc.get('scene', 0)]['nodes'])


def place_in_glb(src, dst):
    """맵 번들에서 온 리그를 본체 파일 공간에 놓는다.

    2026-10-02 19:53 추출기부터 맵 리그 루트 extras.placement 에 "그 리그가 매달린 맵 부모가
    본체 루트의 부모 공간에서 어디인가" 가 들어온다(glTF 4x4, 열 우선). 루트 자체의 변환은
    그 아래에 붙으므로 최종 = placement x 루트 변환. 보스·맵 프리팹을 같은 원점에 둔다는
    가정으로 낸 값이다(placementAssumption).
      크리스탈 체임버 xcg001 · 검은 벽 - X축 +7도(본체 부모가 프리팹 안에서 -7도 기울어 있다)
      리버렐리오 해파리 세 벌 - 크기 1.333, 사망 쪽은 z +75.6
    """
    chunks, doc = _read_glb(src)
    for i in doc['scenes'][doc.get('scene', 0)]['nodes']:
        node = doc['nodes'][i]
        pl = (node.get('extras') or {}).get('placement')
        if not pl or len(pl) != 16:
            continue
        node['matrix'] = _mat_mul(pl, _trs_matrix(node))
        for k in ('translation', 'rotation', 'scale'):
            node.pop(k, None)
    _write_glb(dst, chunks, doc)


def merge_scenes(path):
    """gltf-transform merge 는 씬을 파일 수만큼 남긴다. 로더는 기본 씬 하나만
    보기 때문에 뒤쪽 파일이 통째로 안 보인다. 루트를 한 씬으로 모은다."""
    with open(path, 'rb') as f:
        struct.unpack('<III', f.read(12))
        chunks = []
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            ln, ty = struct.unpack('<II', hdr)
            chunks.append([ty, f.read(ln)])
    doc = json.loads(chunks[0][1].decode('utf-8'))
    scenes = doc.get('scenes') or []
    if len(scenes) <= 1:
        return
    roots = []
    for sc in scenes:
        roots.extend(sc.get('nodes') or [])
    doc['scenes'] = [{'name': 'scene', 'nodes': roots}]
    doc['scene'] = 0
    raw = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    raw += b' ' * ((4 - len(raw) % 4) % 4)
    chunks[0][1] = raw
    body = b''
    for ty, data in chunks:
        pad = b'\x00' if ty == 0x004E4942 else b' '
        data = data + pad * ((4 - len(data) % 4) % 4)
        body += struct.pack('<II', len(data), ty) + data
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


def run(args):
    # 출력에 한글·기호가 섞여 나온다. 콘솔 기본 코덱(cp949)으로 읽으면 읽는 스레드가
    # 통째로 죽어서, 진짜 실패했을 때 오류 내용을 하나도 못 본다.
    r = subprocess.run(args, capture_output=True, text=True, shell=(os.name == 'nt'),
                       encoding='utf-8', errors='replace')
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout)[-800:])
    return r


def main():
    only = sys.argv[1:] or None
    tmp = tempfile.mkdtemp(prefix='repack')
    try:
        for rel, out in JOBS:
            if only and out not in only:
                continue
            rels = rel if isinstance(rel, list) else [rel]
            srcs = [os.path.join(SRC, r.replace('/', os.sep)) for r in rels]
            # 폴더 없이 적힌 원본(마더웨일)도 새 원본은 이 폴더에 모여 있다
            srcs = [p if os.path.exists(p) else
                    os.path.join(SRC, '추출프로그램 업데이트 이후', os.path.basename(p))
                    for p in srcs]
            missing = [r for r, p in zip(rels, srcs) if not os.path.exists(p)]
            if missing:
                print('건너뜀(원본 없음):', missing[0])
                continue
            # 합치기 전에 겹치는 이름을 갈아 둔다
            for i, r in enumerate(rels):
                if r in DROP_CLIPS:
                    fixed = os.path.join(tmp, 'drop%d.glb' % i)
                    drop_clips_in_glb(srcs[i], fixed, DROP_CLIPS[r])
                    srcs[i] = fixed
                table = RENAMES.get(r)
                if table:
                    fixed = os.path.join(tmp, 'ren%d.glb' % i)
                    rename_in_glb(srcs[i], fixed, table)
                    srcs[i] = fixed
                # 맵 번들 리그(합칠 때 둘째부터)는 placement 대로 본체 공간에 놓는다
                if i > 0 and has_placement(srcs[i]):
                    fixed = os.path.join(tmp, 'pl%d.glb' % i)
                    place_in_glb(srcs[i], fixed)
                    srcs[i] = fixed
                if r in SUFFIXES:
                    fixed = os.path.join(tmp, 'suf%d.glb' % i)
                    suffix_in_glb(srcs[i], fixed, *SUFFIXES[r])
                    srcs[i] = fixed
            a = os.path.join(tmp, 'a.glb')
            b = os.path.join(tmp, 'b.glb')
            c = os.path.join(tmp, 'c.glb')
            if len(srcs) > 1:
                m = os.path.join(tmp, 'm.glb')
                run(GT + ['merge'] + srcs + [m])
                merge_scenes(m)
                src = m
            else:
                src = srcs[0]
            run(GT + ['resample', src, a])
            run(GT + ['prune', a, b])
            # 2026-10-04 - Draco(메쉬만) 대신 meshopt(메쉬 + 동작)로 압축하고 파일을 통째로 gzip 한다.
            # 용량의 대부분이 동작 데이터(키 값 59%, 채널 정의 JSON 36%)인데 Draco 는 동작을 안 줄이고,
            # Supabase 는 glb 를 압축 없이 보낸다. 글러트니 41.9 -> 21.2(meshopt) -> 7.1 MB(+gzip).
            # WebP 를 먼저 한다 - glb_webp.py 는 BIN 을 다시 써서 meshopt 버퍼 자리를 흐트러뜨릴 수 있다.
            # 이름은 그대로 .glb 다. 뷰어(loadModelFile)가 gzip 머리(1f 8b)를 보고 풀어서 읽는다.
            w = os.path.join(tmp, 'w.glb')
            run([sys.executable, WEBP, b, w])
            run(GT + ['meshopt', w, c])
            dst = os.path.join(UPLOAD, out + '.glb')
            os.makedirs(UPLOAD, exist_ok=True)
            with open(c, 'rb') as fi:
                raw = fi.read()
            with open(dst, 'wb') as fo:
                fo.write(gzip.compress(raw, 9))
            print('%-16s %7.1f MB -> %5.1f MB' % (
                out, sum(os.path.getsize(p) for p in srcs) / 1e6,
                os.path.getsize(dst) / 1e6))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
