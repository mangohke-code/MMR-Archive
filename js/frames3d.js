// 역대 테두리 탭: FBX -> glTF/Draco 변환 결과물(.glb)을 표시하는 3D 뷰어.
// Spine(L2D) 런타임과는 완전히 별개 스택(Three.js)이라 frames.js(classic script)와
// 분리된 모듈로 두고, window에 진입점만 노출해서 frames.js에서 호출한다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

// 보스별 페이즈 표시 방식 - 이름 패턴만으로는 "1페이즈 파츠를 2페이즈에서도 계속 쓰는지
// (cumulative)" 아니면 "페이즈마다 파츠가 완전히 교체되는지(exclusive)"를 구분할 수 없어서
// 보스마다 직접 확인해서 여기 등록한다. 등록 안 된 보스는 기본값(cumulative)을 쓴다.
// 모든 보스는 항상 1페이즈(가장 낮은 페이즈)로 시작하고, 다른 페이즈는 토글로 직접
// 선택해야 보인다 — defaultPhase 같은 시작 페이즈 예외는 두지 않는다.
// phase1-all: 1페이즈 상태에서는 페이즈 태그가 있는 파츠를 전부(다른 페이즈 태그 포함) 켜고,
// 그 외 페이즈에서는 그 페이즈 태그가 붙은 파츠만 켠다 — 예를 들어 날개처럼 2페이즈 태그가
// 붙었지만 실제로는 항상 보여야 하는 파츠가 있는 보스, 또는 페이즈별로 파츠가 완전히
// 갈리면서도 1페이즈에서는 전체를 다 보여줘야 하는 보스용.
//
// ※ 아래 보정 테이블 3종(PHASE_MODE / MESH_TRANSFORM / BOSS_TRANSFORM)은 전부
//   구형(FBX -> glTF 변환) 모델 전용이다. 신형 추출본에는 적용하지 않는다 —
//   신형은 방향·위치·페이즈가 파일 자체에 이미 들어 있어서, 여기 값을 또 얹으면
//   회전이 두 번 걸려 통째로 틀어진다. 같은 보스를 신형으로 재업로드해도 이 표를
//   지울 필요는 없다. 코드가 알아서 무시한다.
// merge - 이름에 붙은 페이즈 번호를 다른 번호로 접는다. 파일에는 페이즈가 셋인데
// 실제로는 둘인 보스가 있다(아일랜드 이터: 3페이즈는 존재하지 않는다).
// 변종은 파일 이름(bossKey)으로도 찾는다 — 원종과 코드가 같기 때문이다.
const PHASE_MODE_OVERRIDES = {
  mbg001: { mode: 'phase1-all' }, // 알트아이젠 - 1페이즈는 전체 파츠, 2페이즈는 phase002 파츠만
  xba001: { mode: 'exclusive' },  // 미러 컨테이너 - 2페이즈에서 1phase 파츠는 전부 사라진다
  xbg005: { mode: 'exclusive' },  // 에고비스타 - 페이즈마다 깃털이 통째로 갈린다
  // 애니힐리오 - 1·2페이즈 파일을 합쳐 두었다. 변신하면 1페이즈 몸체는
  // 통째로 사라지고 2페이즈 파츠만 남는다.
  xba003: { mode: 'exclusive' },
  // 리버렐리오 바디 - 1·2페이즈 몸이 리그부터 다르다. 변신하면 1페이즈 몸은
  // 통째로 사라진다. 해파리는 페이즈 태그가 없어서 양쪽에 다 남는다(맞다 -
  // 1페 등장·전환·사망 세 연출에 다 나온다).
  eba002: { mode: 'exclusive' },
  // 아일랜드 이터 - 1페이즈는 전체 파츠, 2페이즈는 phase002·003 파츠 10개.
  ebg001_island: { mode: 'phase1-all', merge: { 3: 2 } },
  // 그레이브 디거 - phase001/002/003 사이에 phase0025 가 끼어 있다.
  // 자리수 채운 이름이라 2.5 가 "25" 로 읽힐테고, 그러면 25페이즈 칩이
  // 없어서 그 클립들이 어느 목록에도 안 나온다. 2페이즈로 접어 둔다.
  mbg002: { merge: { 25: 2 } },
};

function getPhaseConfig(bossKey, bossCode) {
  const raw = PHASE_MODE_OVERRIDES[bossKey] || PHASE_MODE_OVERRIDES[bossCode];
  if (!raw) return { mode: 'cumulative', merge: null };
  if (typeof raw === 'string') return { mode: raw, merge: null };
  return { mode: raw.mode || 'cumulative', merge: raw.merge || null };
}

// 메시별 위치/크기 보정 - 극히 드물게, 원본 FBX에 애니메이션이 아예 없고 뼈대 바인드
// 포즈 오프셋/스케일도 0에 가까워서(게임 엔진 쪽 런타임 부착 시스템으로 위치·크기를
// 잡는 걸로 추정) 변환 결과물만으로는 원래 위치를 알 수 없는 파츠가 있다.
// offset: 스켈레톤 루트 본에 더할 로컬 위치, scale: 루트 본에 적용할 절대 배율(기존
// 바인드 포즈 스케일은 무시하고 이 값으로 고정 - 보스마다 파이프라인이 우연히 넣는
// 베이스 스케일이 달라질 수 있어서 상대 배율보다 절대값이 예측 가능하다).
const MESH_TRANSFORM_OVERRIDES = {
  // 온리 원 - 왕좌에 앉은 작은 인형 파츠. 크기는 원본 그대로(확대 안 함).
  // 위치는 사용자가 콘솔에서 직접 눈으로 확인해서 확정한 값 (y=0.315, z=-0.001).
  xbg003_rp_skin: { offset: [0, 0.315, -0.001] },
};

// 파츠를 부위별로 묶는다. 좌우로 갈린 파츠(arm_l / arm_r)가 한 묶음에 들어간다.
// 위에서부터 먼저 맞는 것을 쓴다 — 발광 껍데기는 부위보다 먼저 걸러야
// head_skin_fx 가 "머리" 로 새지 않는다.
const PART_GROUPS = [
  ['발광', /_fx(_\d+)?$/i],
  ['머리', /(^|_)(head|face|neck|eye|sdf)/i],
  ['몸통', /(^|_)(body|torso|chest|core|spine|bust)/i],
  ['어깨', /(^|_)(shoulder|pauldron|coverts)/i],
  ['팔',   /(^|_)arm/i],
  ['다리', /(^|_)(leg|foot|calf|thigh)/i],
  ['날개', /(^|_)(wing|feather|remiges|carpet|halo|orbiter|rocket)/i],
  ['무기', /(^|_)(weapon|gun|rifle|turret|shield|sword|magazine|missile|launcher|cannon|led)/i],
  // parts_ul / parts_dr 처럼 방향만 붙은 부속 파츠
  ['부속', /(^|_)parts?(_|\d|$)/i],
  // 거대 질량체(eba004) — main 이 몸체 전부고, 나머지 넷은 부위가 아니라
  // 등장·사망·특정 스킬에서만 펼쳐지는 연출/투사체 덩어리다.
  // idle 에서는 (0, 17.4, 8.8) 한 점에 접혀 있어서 크기가 0.1 유닛뿐이고,
  // death 에서 F_skin 이 1329, appearance 에서 C_skin 이 674 까지 펼쳐진다.
  // 리버렐리오 바디(eba002) — 좌우 해파리는 보스 몸이 아니라 따로 노는 개체다.
  // 리그가 아예 달라서 파일도 따로 나온다.
  ['해파리', /(^|_)jellyfish/i],
  // 온리 원(xbg003)
  ['촉수', /(^|_)tentacle/i],
  ['가시', /(^|_)thorn/i],
  // rp = rapture. 척추·목·머리·머리카락 18개·눈을 가진 인간형이고 상시 노출된다.
  ['인간형', /(^|_)(rp_skin|rap_)/i],
  // 프리팹에서 꺼진 채 시작하는 소환수 3종
  ['소환수', /(^|_)(ziz|beha?moth|leviathan)/i],
  ['본체', /(^|_)main(_\d+)?$/i],
  ['연출', /(^|_)([a-z])?[FCP]_skin(_\d+)?$/],
];

// 이름이 겹치는 메쉬의 이름을 재질로 다시 정한다.
//
// three.js 는 이름이 겹치면 불러온 순서대로 _1, _2 ... 를 붙인다. Draco 해제가
// 비동기라 그 순서가 매번 같지 않아서, 새로고침할 때마다 번호가 뒤바뀌었다.
// 재질 이름은 파일에 든 값이라 순서와 무관하다 — 그걸로 집는다.
//
// 프로비던스는 부위마다 "본체 + 패턴 발광" 두 겹인데, 원본 이름이 좌우·번호 모두
// 제각각이라 여기서 한 규칙으로 맞춘다.
//   본체 xbg002_arm / xbg002_shoulder / xbg002_head
//   발광 fx_xbg002_part_fresnel_purple
const MESH_RENAME = [
  // 퀸 001 — 보스 전체가 메쉬 하나에 프리미티브 넷이다. 파일 이름은 face 지만
  // 실제로는 몸통·가시·부속이 다 들어 있어서, 그대로 두면 face_skin_2~5 네 개가
  // 전부 “머리” 구역으로 묶인다. 재질 이름으로 나눈다.
  // parts 재질이 둘이라 nth 로 가른다(파일에 든 순서, 삼각형 1510 / 3352).
  { boss: /^xba002/i, re: /^xba002_face_skin(_\d+)?$/i, mat: 'xba002_body', to: 'xba002_body_skin' },
  { boss: /^xba002/i, re: /^xba002_face_skin(_\d+)?$/i, mat: 'xba002_thorn', to: 'xba002_thorn_skin' },
  { boss: /^xba002/i, re: /^xba002_face_skin(_\d+)?$/i, mat: 'xba002_parts', nth: 0, to: 'xba002_parts_01_skin' },
  { boss: /^xba002/i, re: /^xba002_face_skin(_\d+)?$/i, mat: 'xba002_parts', nth: 1, to: 'xba002_parts_02_skin' },
  // 리버렐리오 바디 — 1페이즈 몸이 페이즈 태그 없이 eba002_skin 이다. 그대로 두면
  // 페이즈가 2 하나로만 잡혀서 페이즈 단추가 아예 안 나온다(페이즈는 메쉬 이름의
  // 태그로 센다). 프리미티브 둘을 재질로 갈라 머리·몸통으로 나눈다.
  { boss: /^eba002/i, re: /^eba002_skin(_\d+)?$/i,
    mat: 'eba002_hsta_head', to: 'eba002_1phase_head_skin' },
  { boss: /^eba002/i, re: /^eba002_skin(_\d+)?$/i,
    mat: 'eba002_hsta_body', to: 'eba002_1phase_body_skin' },
  // 2페이즈 몸도 프리미티브 둘이다. 하나는 1페이즈와 같은 재질(hsta_body)을 쓰고
  // 하나만 2페이즈 전용(phase2_body)이라 재질로 갈린다.
  { boss: /^eba002/i, re: /^eba002_2phase_skin(_\d+)?$/i,
    mat: 'eba002_hsta_body', to: 'eba002_2phase_body_skin' },
  { boss: /^eba002/i, re: /^eba002_2phase_skin(_\d+)?$/i,
    mat: 'eba002_phase2_body', to: 'eba002_2phase_body2_skin' },
  // 프로비던스 팔 — 한 메쉬의 프리미티브 넷. 본체는 꼬리표 없이, 발광은 _1.
  { boss: /^xbg002/i, re: /^xbg002_arm_l_skin(_\d+)?$/i, mat: 'xbg002_arm', to: 'xbg002_arm_l_skin' },
  { boss: /^xbg002/i, re: /^xbg002_arm_l_skin(_\d+)?$/i, mat: 'fx_xbg002_part_fresnel_purple', to: 'xbg002_arm_l_skin_1' },
  { boss: /^xbg002/i, re: /^xbg002_arm_l_skin(_\d+)?$/i, mat: '', to: 'xbg002_arm_l_skin_2' },
  { boss: /^xbg002/i, re: /^xbg002_arm_l_skin(_\d+)?$/i, mat: 'xbg002_shoulder', to: 'xbg002_arm_l_skin_3' },
  { boss: /^xbg002/i, re: /^xbg002_arm_r_skin(_\d+)?$/i, mat: 'xbg002_arm', to: 'xbg002_arm_r_skin' },
  { boss: /^xbg002/i, re: /^xbg002_arm_r_skin(_\d+)?$/i, mat: 'fx_xbg002_part_fresnel_purple', to: 'xbg002_arm_r_skin_1' },
  { boss: /^xbg002/i, re: /^xbg002_arm_r_skin(_\d+)?$/i, mat: '', to: 'xbg002_arm_r_skin_2' },
  { boss: /^xbg002/i, re: /^xbg002_arm_r_skin(_\d+)?$/i, mat: 'xbg002_shoulder', to: 'xbg002_arm_r_skin_3' },
  // 어깨 — 원본은 좌우가 엇갈려 있었다. 재질로 집으면 저절로 짝이 맞는다.
  { boss: /^xbg002/i, re: /^xbg002_shoulder_l_skin(_\d+)?$/i, mat: 'xbg002_shoulder', to: 'xbg002_shoulder_l_skin' },
  { boss: /^xbg002/i, re: /^xbg002_shoulder_l_skin(_\d+)?$/i, mat: 'fx_xbg002_part_fresnel_purple', to: 'xbg002_shoulder_l_skin_1' },
  { boss: /^xbg002/i, re: /^xbg002_shoulder_r_skin(_\d+)?$/i, mat: 'xbg002_shoulder', to: 'xbg002_shoulder_r_skin' },
  { boss: /^xbg002/i, re: /^xbg002_shoulder_r_skin(_\d+)?$/i, mat: 'fx_xbg002_part_fresnel_purple', to: 'xbg002_shoulder_r_skin_1' },
  // 다리 — 원본은 발광 쪽이 꼬리표 없는 이름을 쓴다. 팔·어깨와 반대라서 뒤집는다.
  { boss: /^xbg002/i, re: /^xbg002_legs_l_skin001(_\d+)?$/i, mat: 'xbg002_head', to: 'xbg002_legs_l_skin001' },
  { boss: /^xbg002/i, re: /^xbg002_legs_l_skin001(_\d+)?$/i, mat: 'fx_xbg002_part_fresnel_purple', to: 'xbg002_legs_l_skin001_1' },
  { boss: /^xbg002/i, re: /^xbg002_legs_r_skin001(_\d+)?$/i, mat: 'xbg002_head', to: 'xbg002_legs_r_skin001' },
  { boss: /^xbg002/i, re: /^xbg002_legs_r_skin001(_\d+)?$/i, mat: 'fx_xbg002_part_fresnel_purple', to: 'xbg002_legs_r_skin001_1' },

  // 앨트루이아 — 부위마다 본체 + 발광 두 겹이고, 원본 그대로 두면 투구 아홉 쌍의
  // 번호가 제각각으로 붙는다(불러올 때마다 달라진다). 한 규칙으로 정한다.
  // re 의 첫 괄호가 기준 이름이고, 재질에 따라 꼬리표를 붙인다.
  { boss: /^xbg004/i, re: /^(xbg004_helm_\d+_skin)(_\d+)?$/i,
    bySuffix: { 'xbg004_body': '', 'fx_xbg004_zeus_parts_glow': '_1' } },
  // 눈은 좌우 한 쌍인데 이름이 l_sdf_eye_02 / sdf_eye_01 로 엇갈려 있다.
  // 이 파일은 l 이 x+, r 이 x- 다(shield_l_skin x+0.31 / shield_r_skin x-0.31).
  // 실제 위치가 각각 x+0.33 / x-0.32 라 그대로 방패와 같은 꼴로 맞춘다.
  { boss: /^xbg004/i, re: /^xbg004_l_sdf_eye_\d+_skin(_\d+)?$/i, base: 'xbg004_sdf_eye_l_skin',
    bySuffix: { 'xbg004_shield': '', 'fx_xbg004_zeus_parts_glow': '_1' } },
  { boss: /^xbg004/i, re: /^xbg004_sdf_eye_\d+_skin(_\d+)?$/i, base: 'xbg004_sdf_eye_r_skin',
    bySuffix: { 'xbg004_shield': '', 'fx_xbg004_zeus_parts_glow': '_1' } },
  // 방패는 한 메쉬의 프리미티브 둘인데 어느 쪽도 발광이 아니다.
  // _1 은 발광 층 자리로 비워 두고, 게임이 쓰는 꼴대로 001 을 붙인다.
  { boss: /^xbg004/i, re: /^(xbg004_shield_[lr]_skin)(_\d+)?$/i,
    bySuffix: { 'xbg004_shield': '', 'xbg004_body': '001' } },
  // 몸 중심선에 쌓인 고리 넷. 원본 번호(04 / 005 / 007 / 006)가 높이 순서와 안 맞아서
  // 아래에서 위로 다시 매긴다. idle 3종·스킬·그로기에서 위아래 순서가 같은 것을 확인했다.
  { boss: /^xbg004/i, re: /^xbg004_arms_04_skin_04(_\d+)?$/i,  base: 'xbg004_arms_04_skin_01', bySuffix: {} },
  { boss: /^xbg004/i, re: /^xbg004_arms_04_skin_005(_\d+)?$/i, base: 'xbg004_arms_04_skin_02', bySuffix: {} },
  { boss: /^xbg004/i, re: /^xbg004_arms_04_skin_007(_\d+)?$/i, base: 'xbg004_arms_04_skin_03', bySuffix: {} },
  { boss: /^xbg004/i, re: /^xbg004_arms_04_skin_006(_\d+)?$/i, base: 'xbg004_arms_04_skin_04', bySuffix: {} },
  // 하나뿐인데 번호가 붙은 것들 — 노드가 같은 이름을 먼저 차지해서 그렇다. 꼬리표만 뗀다.
  { boss: /^xbg004/i,
    re: /^(xbg004_(?:body_skin|shield_[lr]_led_skin))(_\d+)?$/i,
    bySuffix: {} },

  // 에고비스타 — 이름이 겹치는 메쉬는 없고, 노드가 이름을 먼저 차지해서 꼬리표만 붙었다.
  // 몸통은 한 메쉬의 프리미티브 둘이라 재질로 가른다.
  { boss: /^xbg005/i, re: /^(xbg005_body_skin)(_\d+)?$/i,
    bySuffix: { 'xbg005_body': '', 'xbg005_wings': '001' } },
  { boss: /^xbg005/i,
    re: /^(xbg005_(?:core_skin|phase[12]_feather|[lr]_coverts_skin|[lr]_pauldrons_skin))(_\d+)?$/i,
    bySuffix: {} },
  // 애니힐리오 1페이즈 - 원본 메쉬 이름이 xbga03_ 로 잘못 박혀 있다(xba003 오타).
  // 그대로 두면 보스 코드가 안 떨어져 나가서 파츠 이름이 통째로 나온다.
  // 1·2페이즈를 한 파일로 합치면서 bossKey 가 xba003 이 됐다. 페이즈 구분은
  // 아래 re 가 하므로 boss 쪽은 넓게 둔다.
  { boss: /^xba003/i, re: /^xbga03_1phase_skin(_\d+)?$/i,
    base: 'xba003_1phase_skin', bySuffix: {} },
  { boss: /^xba003/i, re: /^xbga03_1phase_dl_skin(_\d+)?$/i,
    base: 'xba003_1phase_dl_skin', bySuffix: {} },
  { boss: /^xba003/i, re: /^xbga03_1phase_dr_skin(_\d+)?$/i,
    base: 'xba003_1phase_dr_skin', bySuffix: {} },
  { boss: /^xba003/i, re: /^xbga03_1phase_ul_skin(_\d+)?$/i,
    base: 'xba003_1phase_ul_skin', bySuffix: {} },
  { boss: /^xba003/i, re: /^xbga03_1phase_ur_skin(_\d+)?$/i,
    base: 'xba003_1phase_ur_skin', bySuffix: {} },
  // 애니힐리오 2페이즈 동체 - 원본은 서브메쉬 둘짜리 한 메쉬인데(재질
  // xba003_phase02_body · _body2) 머티리얼별로 갈려 나와서 _2 · _3 으로 보였다.
  // 둘을 같은 이름으로 보내 한 파츠로 묶는다.
  { boss: /^xba003/i, re: /^xba003_2phase_body_skin(_\d+)?$/i,
    mat: 'xba003_phase02_body', to: 'xba003_2phase_body_skin' },
  { boss: /^xba003/i, re: /^xba003_2phase_body_skin(_\d+)?$/i,
    mat: 'xba003_phase02_body2', to: 'xba003_2phase_body_skin' },
  // 애니힐리오 2페이즈 - 노드와 메쉬가 이름을 나눠 가져 붙는 꼬리표를 뗀다.
  { boss: /^xba003/i, re: /^(xba003_1phase_magiccarpet_skin)(_\d+)?$/i, bySuffix: {} },
  // 온리 원 - 소환수 셋과 2페 날개는 뼈와 메쉬가 같은 이름이라 메쉬 쪽에 _1 이
  // 붙는다. 그 꼬리표 때문에 PART_LABELS 의 이름표(하늘·땅·바다의 마수)가
  // 안 걸렸다. 넷 다 프리미티브가 하나뿐이라 꼬리표만 떼면 된다.
  { boss: /^xbg003/i,
    re: /^(xbg003_(?:ziz_skin|behamoth_skin|leviathan_skin|2phase_wings_skin))(_\d+)?$/i,
    bySuffix: {} },
  // 사치스러운 거미 - 노드와 메쉬가 같은 이름을 나눠 가져서 메쉬 쪽에 _1 이 붙는다.
  // 이름이 겹치는 메쉬는 없으니 꼬리표만 뗀다.
  { boss: /^bbg001/i, re: /^(bbg001_(?:body|legs_01|weapon_01))(_\d+)?$/i, bySuffix: {} },

  // 베히모스 2페이즈 - 여기도 노드가 이름을 먼저 차지해서 머신건에 _1 이 붙는다.
  // 그 꼬리표 때문에 이름표도, 3페이즈 기본 꺼짐 규칙도 안 걸렸다.
  // 프리미티브가 하나뿐이라 꼬리표만 떼면 된다(몸통 넷과 rl 둘은 여럿이라 그대로).
  { boss: /^mbg003/i, re: /^(mbg003_behemoth_[lr]_vulcan_skin)(_\d+)?$/i, bySuffix: {} },

  // 미러 컨테이너 - 노드가 메쉬와 같은 이름을 먼저 차지해서 모든 메쉬에 _1 이 붙는다.
  // 그 꼬리표 하나 때문에 파츠 이름표가 통째로 안 붙고 있었다(cube_skin_1 은
  // 표의 cube_skin 과 안 맞는다). 프리미티브가 하나뿐인 메쉬만 꼬리표를 뗀다.
  // 2phase_parts 넷과 몸통(xba001_skin)은 프리미티브가 여럿이라 빼 둔다 -
  // 꼬리표를 떼면 셋이 같은 이름이 돼서 목록이 "... 1 / ... 2" 로 갈린다.
  { boss: /^xba001/i,
    re: /^(xba001_(?:cube_skin|weapon_[lr]\d+_skin|1phase_parts_[lr]\d+_skin))(_\d+)?$/i,
    bySuffix: {} },
];

function meshMatName(m) {
  const mt = Array.isArray(m.material) ? m.material[0] : m.material;
  return (mt && mt.name) || '';
}

// 한꺼번에 정해서 한 번에 갈아 끼운다. 하나씩 바꾸면 앞에서 바꾼 이름을 뒤에서 또 집는다.
function renameMeshes(bossKey, meshes) {
  const rules = MESH_RENAME.filter(o => o.boss.test(bossKey || ''));
  if (!rules.length) return;
  // 같은 재질을 쓰는 메쉬가 둘 이상일 때 가를 수 있게 몇 번째인지 세어 둔다.
  // 한 메쉬 안의 프리미티브 순서는 파일에 든 순서라 로드마다 같다.
  const occ = new Map();
  const cnt = new Map();
  meshes.forEach(m => {
    const mat = meshMatName(m);
    const i = cnt.get(mat) || 0;
    occ.set(m, i);
    cnt.set(mat, i + 1);
  });
  const next = meshes.map(m => {
    const mat = meshMatName(m);
    for (const o of rules) {
      if (o.bySuffix) {
        const hit = String(m.name || '').match(o.re);
        if (hit) return (o.base || hit[1]) + (o.bySuffix[mat] || '');
      } else if (o.re.test(m.name || '') && o.mat === mat
                 && (o.nth === undefined || o.nth === occ.get(m))) {
        return o.to;
      }
    }
    return m.name;
  });
  meshes.forEach((m, i) => { m.name = next[i]; });
}

// 파츠 목록에 띄울 인게임 이름. 파일 이름만 봐서는 무슨 부위인지 알 수 없어서
// 게임에서 쓰는 표기를 손으로 적어 둔다. 내부 이름(mesh.name)은 그대로 두고
// 보이는 글자만 바꾼다 — 기본 꺼짐·패턴 발광 표가 전부 내부 이름으로 물려 있다.
// 키는 보스 코드를 뗀 이름이다(위 MESH_RENAME 을 거친 뒤 기준).
// 적어 두지 않은 파츠는 지금처럼 파일 이름 그대로 나온다.
const PART_LABELS = {
  bbg001: {
    'egg_skin': '알집',
  },
  eba001: {
    'left_sr_01_skin': '터렛 Ⅰ',
    'right_sr_01_skin': '터렛 Ⅱ',
  },
  mbg002: {
    '1phase_parts_left_skin': '굴착기 L',
    '1phase_parts_right_skin': '굴착기 R',
    '1phase_sawtooth_skin': '기어',
    '2phase_drill_skin': '드릴',
  },
  // 애니힐리오. 1·2페이즈가 파일은 다르지만 코드는 같아서 한 표에 같이 적는다.
  xba003: {
    '1phase_skin': '몸통',
    '1phase_dl_skin': '난쟁이의 상자 Ⅰ',
    '1phase_dr_skin': '난쟁이의 상자 Ⅱ',
    '1phase_ul_skin': '난쟁이의 상자 Ⅲ',
    '1phase_ur_skin': '난쟁이의 상자 Ⅳ',
    '1phase_magiccarpet_skin': '마법의 양탄자',
    'turret01': '마녀의 까마귀 Ⅰ',
    'turret02': '마녀의 까마귀 Ⅱ',
    'turret03': '마녀의 까마귀 Ⅲ',
    'turret04': '마녀의 까마귀 Ⅳ',
    'turret05': '마녀의 까마귀 Ⅴ',
    '2phase_body_skin': '몸통',
    // 2페이즈 파츠 넷(parts_dl/dr/ul/ur)은 이름을 비워 둔다. 게임 로케일에
    // "난쟁이의 보물 I~IV" 가 있고 개수도 맞지만, 어느 메쉬가 몇 번인지
    // 잇는 데이터가 없다(MonsterPartsPrefab 의 Skin 이 2페이즈를 안 가리킨다).
  },
  // 온리 원 - 소환수 셋의 이름이 게임 로케일에 있다. 유대 신화에서 리바이어던은
  // 바다, 베히모스는 땅, 지즈는 하늘의 짐승이라 메쉬와 그대로 이어진다.
  xbg003: {
    'leviathan_skin': '바다의 마수',
    'behamoth_skin': '땅의 마수',
    'ziz_skin': '하늘의 마수',
  },
  // 에고비스타 - 메쉬 이름이 영어 그대로다(pauldron = 견갑, coverts = 날개덮깃).
  xbg005: {
    'l_pauldrons_skin': '견갑 L',
    'r_pauldrons_skin': '견갑 R',
    'l_coverts_skin': '날개 견갑 L',
    'r_coverts_skin': '날개 견갑 R',
  },
  // 미러 컨테이너 - 1페이즈 파츠는 좌우와 번호가 로케일과 그대로 맞는다.
  // 2페이즈 넷(dl/dr/ul/ur)은 "유리 구두 I~IV" 와 개수만 맞고 순서를 모른다 - 비워 둔다.
  xba001: {
    'cube_skin': '하모니 큐브 파편',
    '1phase_parts_l01_skin': '레플리카 유리 구두 L Ⅰ',
    '1phase_parts_l02_skin': '레플리카 유리 구두 L Ⅱ',
    '1phase_parts_l03_skin': '레플리카 유리 구두 L Ⅲ',
    '1phase_parts_r01_skin': '레플리카 유리 구두 R Ⅰ',
    '1phase_parts_r02_skin': '레플리카 유리 구두 R Ⅱ',
    '1phase_parts_r03_skin': '레플리카 유리 구두 R Ⅲ',
  },
  // 베히모스 - 파일이 페이즈별로 갈려 있어도 PART_LABELS 는 보스 코드로 찾으므로
  // 한 표에 1·2페이즈 파츠를 같이 적는다.
  mbg003: {
    '1phase_ar_skin': '개틀링 건',
    'behemoth_l_vulcan_skin': '머신건 L',
    'behemoth_r_vulcan_skin': '머신건 R',
  },
  xbg004: {
    'helm_01_skin': '성녀의 후광 1',
    'helm_02_skin': '성녀의 후광 2',
    'helm_03_skin': '성녀의 후광 3',
    'helm_04_skin': '성녀의 후광 4',
    'helm_05_skin': '성녀의 후광 5',
    'helm_06_skin': '성녀의 후광 6',
    'helm_07_skin': '성녀의 후광 7',
    'helm_08_skin': '성녀의 후광 8',
    'helm_09_skin': '성녀의 후광 9',
    'shield_l_skin': '최강의 방패 L (앞)',
    'shield_r_skin': '최강의 방패 R (앞)',
    'shield_l_skin001': '최강의 방패 L (뒤)',
    'shield_r_skin001': '최강의 방패 R (뒤)',
    'shield_l_led_skin': '최강의 방패 L (발광)',
    'shield_r_led_skin': '최강의 방패 R (발광)',
  },
};

// 겹쳐 있는 발광 층은 뒤에 이걸 붙여서 구분한다.
const PART_LABEL_GLOW = ' (발광)';

// 발광 층인지 — 재질 이름으로 가른다. 이름 뒤 번호는 못 믿는다.
function isGlowLayer(m) {
  return /(^|_)fx_|_glow$|fresnel/i.test(meshMatName(m));
}

function partLabelOf(bossCode, m, fallback) {
  const table = PART_LABELS[bossCode];
  if (!table) return fallback;
  const key = String(m.name || '').replace(new RegExp('^' + bossCode + '_?', 'i'), '');
  // 발광 층은 본체 이름을 물려받는다. 짝이 되는 본체 이름은 뒤 번호를 뗀 것.
  const hit = table[key] || (isGlowLayer(m) ? table[key.replace(/_\d+$/, '')] : null);
  if (!hit) return fallback;
  return isGlowLayer(m) ? hit + PART_LABEL_GLOW : hit;
}

// 프리팹에서 m_IsActive=false 로 꺼진 채 시작하는 메쉬. 화면에 늘 떠 있으면 안 되고,
// 런타임 코드(행동트리)가 필요할 때만 켠다. 애니메이션·머티리얼에는 흔적이 없어서
// 파일만 봐서는 알 수 없다.
// (온리 원 소환수 3종은 여기 넣지 않는다 — 평소에는 보이지 않을 만큼 작게 접혀
//  다른 자리에 놓여 있고, 필요할 때 자기 스킬 클립이 꺼내 쓴다. 상시 on 이어도 된다)
// 텍스처 알파를 반투명으로 살려야 하는 재질. 파일에는 전부 alphaMode=MASK
// (cutoff 0.5) 로 나와서 잡라내기 용도로만 적혀 있는데, 알파가 0/1 이 아니라
// 중간값으로 깔려 있는 재질은 그 알파가 곳 반투명도다.
//   스톰브링어 방패(eba001_shield_01_anmi) - 512x512 텍스처의 알파가
//   0 이 47.0%, 1~127 이 48.9%, 128~254 가 3.9%, 255 는 0.2% 뿐이다.
//   불투명하게 그리면 게임에서 살짝 비치는 방패가 판때기로 보인다.
const TRANSLUCENT_MATERIALS = [
  { boss: /^eba001/i, mat: /_shield_01_anmi$/i },
];

function isTranslucentMaterial(bossKey, matName) {
  return TRANSLUCENT_MATERIALS.some(
    o => o.boss.test(bossKey || '') && o.mat.test(matName || ''));
}

const DEFAULT_OFF_MESHES = [
  // 프로비던스 - 패턴 중에만 빛나는 파츠(fx_xbg002_part_fresnel_purple 재질).
  // 평소에는 꺼져 있고 아래 CLIP_GLOW_PARTS 가 해당 스킬에서만 잠깐 켠다.
  { boss: /^xbg002/i, re: /_(arm_[lr]_skin_1|legs_[lr]_skin001_1|shoulder_[lr]_skin_1)$/i },
  // 앨트루이아 - 발광 층(fx_xbg004_zeus_parts_glow 재질)은 평소 꺼둔다. 밑에 본체 층이
  // 그대로 있어서 파츠가 사라지지는 않고, 빛나야 할 때만 CLIP_GLOW_PARTS 가 켠다.
  { boss: /^xbg004/i, re: /_(helm_\d+_skin_1|sdf_eye_[lr]_skin_1)$/i },
  // 사치스러운 거미 알집 - 위 CLIP_SOLO_PARTS 설명 참고.
  { boss: /^bbg001_rich/i, re: /_egg_skin$/i },
  // 애니힐리오 마녀의 까마귀 III - 파츠는 있지만 보스전에서 나온 적이 없다.
  { boss: /^xba003/i, re: /_turret03$/i },
  // 온리 원 소환수 셋 - 프리팹에서 꺼진 채 시작한다. 보스 프리팹의 GameObject
  // m_IsActive 를 읽어 보면 ziz_skin / behamoth_skin / leviathan_skin 만
  // False 고 나머지 스킨은 전부 True 다. 나오는 연출에서만 CLIP_SOLO_PARTS 가
  // 켠다.
  { boss: /^xbg003/i, re: /_(ziz|behamoth|leviathan)_skin(_\d+)?$/i },
  // 베히모스 머신건 좌우 - 3페이즈에서는 떨어져 나가서 달려 있지 않다.
  // 2페이즈 파일에 3페이즈가 같이 들어 있고 이 파츠에는 페이즈 꼬리표가 없어서,
  // 페이즈를 조건으로 단 줄이 필요하다.
  { boss: /^mbg003/i, re: /_vulcan_skin$/i, phase: '3' },
];

// 페이즈마다 어떤 파츠가 꺼지는지 직접 적는 자리. 메쉬 이름의 phase 태그로는
// 안 맞는 보스에 쓴다 — 그레이브 디거는 1페이즈 파츠가 페이즈마다 차례로
// 떨어져 나간다. 적은 페이즈에서 꺼져야 하는 메쉬를 전부 나열한다
// (누적이 아니라 그 페이즈의 꺼진 목록 전체다).
const PHASE_PART_OFF = [
  { boss: /^mbg002/i, phase: '2', re: [
    /_1phase_skin(_\d+)?$/i, /_1phase_sawtooth_skin$/i, /_1phase_parts_(left|right)_skin$/i,
  ] },
  { boss: /^mbg002/i, phase: '3', re: [
    /_1phase_skin(_\d+)?$/i, /_1phase_sawtooth_skin$/i, /_1phase_parts_(left|right)_skin$/i,
    /_2phase_drill_skin$/i, /_2phase_skin(_\d+)?$/i,
    /_phase001_ar_(\d+|frame_\d+)_skin$/i,
  ] },
];

function hasPhasePartTable(bossKey) {
  return PHASE_PART_OFF.some(o => o.boss.test(bossKey || ''));
}

function isPhasePartOff(bossKey, phase, name) {
  const o = PHASE_PART_OFF.find(
    x => x.boss.test(bossKey || '') && x.phase === String(phase));
  return !!o && o.re.some(re => re.test(name || ''));
}

// phase 를 적은 줄은 그 페이즈에서만 꺼진다. 안 적은 줄은 예전처럼 늘 꺼진다.
function isDefaultOffMesh(bossKey, name, phase) {
  return DEFAULT_OFF_MESHES.some(o => o.boss.test(bossKey || '') && o.re.test(name || '')
    && (!o.phase || o.phase === String(phase)));
}

// 페이즈를 조건으로 꺼 두는 줄이 걸린 파츠인가. 페이즈를 바꿀 때 되살릴지
// 정하는 데 쓴다 - 조건 없이 꺼 둔 파츠는 페이즈를 넘겨도 꺼진 채로 둬야 한다.
function isPhaseScopedOff(bossKey, name) {
  return DEFAULT_OFF_MESHES.some(
    o => o.phase && o.boss.test(bossKey || '') && o.re.test(name || ''));
}

// 파츠 목록 정렬 키. 좌우 파츠가 바로 붙어 나오도록 세운다 — 왼쪽 다음 오른쪽.
// 이름에서 좌우 표시만 빼면 같은 부위의 좌우가 같은 키가 되고, 그 다음 l -> r 순으로
// 갈린다. 프로비던스 어깨는 shoulder_l_skin / shoulder_r_skin_1 / shoulder_l_skin001
// 처럼 좌우 이름 규칙조차 달라서 이렇게 해야 짝이 맞는다.
// 숫자는 자릿수를 맞춰 자연 순서로 둔다(2 가 10 보다 앞).
function partSortKey(name) {
  const n = String(name).toLowerCase();
  let side = 2; // 좌우 표시가 없으면 뒤로
  const noSide = n.replace(/(^|_)([lr])(?=_|\d|$)/g, (m, pre, s) => {
    if (side === 2) side = (s === 'l') ? 0 : 1;
    return pre;
  });
  return [noSide.replace(/\d+/g, d => d.padStart(6, '0')), side];
}

function comparePartKeys(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] - b[1];
}

// 이름만으로는 안 갈리는 파츠. 애니힐리오 1페이즈 몸통은 이름이 그냥 1phase_skin
// 이고, 마법의 양탄자는 magiccarpet 이라 carpet 앞에 밑줄이 없어서 날개에도 안
// 걸린다. 공용 정규식을 느슨하게 하면 다른 보스까지 흔들려서 여기서 바로잡는다.
const PART_GROUP_OVERRIDES = [
  { boss: /^xba003/i, re: /_1phase_skin$/i, group: '몸통' },
  { boss: /^xba003/i, re: /_magiccarpet_skin$/i, group: '몸통' },
  // 스톰브링어 - 재질 이름이 eba001_sr_anmi / eba001_rl_anmi 다. 공용 무기
  // 목록에 sr·rl 을 넣으면 베히모스 소환수(behemoth_l_rl_skin)까지 딸려온다.
  { boss: /^eba001/i, re: /(^|_)(sr|rl)(_|\d|$)/i, group: '무기' },
  // 그레이브 디거 - ar 은 베히모스(mbg003_1phase_ar_skin)와도 겹쳐서
  // 공용 목록에 못 넣는다. 보스 한정으로 둔다.
  { boss: /^mbg002/i, re: /(^|_)(sawtooth|drill)(_|\d|$)/i, group: '부속' },
  { boss: /^mbg002/i, re: /(^|_)ar(_|\d|$)/i, group: '무기' },
  // 퀸 001 - 메쉬 하나를 재질로 나눈 것이라 부위가 아니다. 한 구역에 모은다.
  { boss: /^xba002/i, re: /./, group: '몸통' },
  { boss: /^mbg002/i, re: /(^|_)\dphase_skin(_|\d|$)/i, group: '몸통' },
  // 에고비스타 - 이름은 feather 라 날개로 걸리지만 2페이즈 것은 등에 달린 깃이
  // 아니라 무기에 붙는 파츠다(인게임 확인). 1페이즈 것은 날개가 맞다.
  { boss: /^xbg005/i, re: /_phase2_feather(_|\d|$)/i, group: '무기' },
];

function partGroupLabel(bossKey, name) {
  const o = PART_GROUP_OVERRIDES.find(
    x => x.boss.test(bossKey || '') && x.re.test(name || ''));
  if (o) return o.group;
  for (const [label, re] of PART_GROUPS) if (re.test(name || '')) return label;
  return '기타';
}

// 규칙 표가 보고 판단하는 이름. 메쉬에서 뽑은 코드만으로는 변종 보스를 못 가른다 —
// 하베스터와 사치스러운 거미가 둘 다 bbg001 이다. 파일 이름이 코드로 시작하면
// 그 이름을 그대로 쓴다("bbg001_사치스러운 거미"). 기존 규칙은 /^bbg001/ 처럼
// 코드로 시작해서 변종에도 그대로 걸리고, 변종만 집으려면 뒤까지 적으면 된다.
// 원종만 집으려면 /^bbg001$/ 로 끝을 막는다.
function bossKeyFrom(bossCode, url) {
  if (!bossCode) return bossCode;
  let stem = String(url || '').split(/[?#]/)[0];
  stem = stem.slice(stem.lastIndexOf('/') + 1).replace(/\.glb$/i, '');
  try { stem = decodeURIComponent(stem); } catch (e) { /* 인코딩 깨진 이름은 그대로 */ }
  return stem.toLowerCase().startsWith(bossCode) ? stem : bossCode;
}

// 이름이 겹치는 클립. 사치스러운 거미는 파일에 dead_01 이 두 벌 들어 있는데,
// 목록에서 이름으로 찾으면 뒤엣것은 영영 못 고른다. 뒤엣것에 번호를 붙여 가른다.
function dedupeClipNames(clips) {
  const seen = new Map();
  clips.forEach(c => {
    const n = c.name || '';
    const hit = (seen.get(n) || 0) + 1;
    seen.set(n, hit);
    if (hit > 1) c.name = n + '_' + hit;
  });
}

function detectBossCode(meshNames, url) {
  for (const name of meshNames) {
    const m = (name || '').match(/^([a-z]{2,4}\d{3})/i);
    if (m) return m[1].toLowerCase();
  }
  // 메쉬 이름이 코드 꼴이 아닌 파일이 있다 — 애니힐리오 1페이즈는 xbga03 으로
  // 잘못 박혀 있다(xba003 오타). 그러면 파일 이름에서 찾는다.
  let stem = String(url || '').split(/[?#]/)[0];
  stem = stem.slice(stem.lastIndexOf('/') + 1);
  const f = stem.match(/^([a-z]{2,4}\d{3})/i);
  return f ? f[1].toLowerCase() : null;
}

// 보스 전체(모델 통째로) 회전/위치/크기 보정 - 보스마다 원본 좌표축이 조금씩 달라서
// 공통 기본값(회전만 좌우 225도)으로 안 맞으면 여기 개별 등록한다.
// rotation: [pitch, yaw, roll] 도 단위 - 기본값은 FBX2glTF 변환 시 공통으로 어긋나는
//   좌우 225도만 보정한 값.
// position: [x, y, z] - 모델 전체(바깥쪽 그룹)에 더할 오프셋. 기본 0.
// scale: 모델 전체에 곱할 배율. 기본 1.
const DEFAULT_ROTATION = [0, 225, 0];
const BOSS_TRANSFORM_OVERRIDES = {
  bba001: { rotation: [25, 228, 0] }, // 마더 웨일 - 확정
  bbg001: { rotation: [40, 227, 0], position: [0, 0, 0.08], scale: 0.5 }, // 하베스터 - 확정
  mbg001: { position: [-0.1, -0.1, 0], scale: 1 }, // 알트아이젠 - 확정 (회전은 기본값)
};

// 신형 추출본의 기본 배율·높이 보정. 시점 초기화도 이 값으로 돌아간다.
//   온리 원 - 소환수(ziz/behamoth/leviathan)가 본체에서 떨어져 있어서 정규화가
//   그만큼 작게 잡는다. 화면에 맞게 1.3 배, 0.3 아래로.
//   camY - 카메라 눈높이. 카메라와 시선을 같은 값만큼 올려서 각도는 그대로 둔다.
//   camDist - 기본 시점 거리. 안 적으면 공용값 2.3 을 쓴다. 이 값을 줄이면
//     모델은 그대로 두고 카메라만 다가간다 — 눈높이·각도는 안 바뀐다.
const CATALOG_FIT_OVERRIDES = {
  xbg003: { scale: 1.0, position: [0, 0, 0], camY: 0.05 },
  // 미러 컨테이너는 옆으로 넓고 위아래로 낮아서, 세로 크기로 잡는 기본 눈높이가
  // 보스 발치까지 내려온다. 보스 한가운데로 올린다.
  xba001: { scale: 1.0, position: [0, 0, 0], camY: 0.33 },
  // 퀸 001 - 공용 거리 2.3 에서는 멀어 보인다(화면 세로 0.53). 1.84 로 당기면 0.66.
  xba002: { camDist: 1.84 },
  // 검은 뱀 - 원본 파일이 모델을 원점에서 비켜 놓았다. 정규화는 높이(y)만 맞추고
  // 좌우·앞뒤는 파일 값을 그대로 두기 때문에, 격자 한가운데가 아니라 왼쪽 앞에 선다.
  // idle 12초를 훑어 잰 바운딩 중심이 x -0.309 / z +0.263 이라 그만큼 되민다.
  // position 은 yawGroup 에 걸려서 월드 좌표 그대로다(정규화 안쪽이 아니다).
  bbg008: { position: [0.309, 0, -0.263] },
};

// 정규화 직후에 한 번 더 먹이는 기준 보정. 이 값이 들어간 상태가 곧 "배율 1.0 / Y 0" 이다.
// 조작 패널에 1.3 / -0.3 같은 값이 떠 있으면 지금이 기본 상태인지 손댄 상태인지 알 수
// 없어서, 맞춰 둔 값을 여기로 옮기고 패널은 1.0 / 0 에서 출발하게 한다.
// 화면은 그대로다 — 바깥 그룹에 걸던 것을 안쪽(normGroup)으로 옮겼을 뿐이고,
// 좌우 회전은 Y 축이라 위아래 오프셋에도, 배율에도 영향을 주지 않는다.
const CATALOG_FIT_BASE = {
  xbg003: { scale: 1.3, y: -0.3 }, // 온리 원 - 소환수가 떨어져 있어 정규화가 작게 잡는다
  // pitch - 기준 상하 각도(도). 조작 패널에는 0 으로 표기된다.
  xba001: { scale: 2.6, y: 0, pitch: 10 }, // 미러 컨테이너 - 본이 본체 밖까지 뻗어 있어 작게 잡힌다
  // 베히모스 1페이즈는 화면에서 작게 잡힌다. 항목별로 줘야 해서 "@1" 로 적는다.
  'mbg003@1': { scale: 1.3, y: 0 },
  ebg001_island: { pitch: 10 }, // 아일랜드 이터 - 기준 상하 각도
  eba001: { y: 0.2 },           // 스톰브링어 - 기준 높이
  // 그레이브 디거 - 땅을 파는 모양이라 앞뒤로 길다(보이는 범위 x 0.32,
  // y 0.32, z 1.01). 정규화가 긴 쪽인 깊이로 잡아서 화면에서 매우 작아진다.
  mbg002: { scale: 2.2, y: -1.45 },
};

// 같은 보스라도 모델 항목(페이즈)마다 다르게 줘야 하면 "코드@페이즈" 로 적는다.
// 변종은 파일 이름(bossKey)으로도 찾는다 — 원종과 코드가 같기 때문이다.
function catalogFitBase(bossKey, bossCode, isCatalogExport, labelPhase) {
  if (!isCatalogExport) return {};
  return CATALOG_FIT_BASE[bossKey + '@' + labelPhase]
    || CATALOG_FIT_BASE[bossKey]
    || CATALOG_FIT_BASE[bossCode + '@' + labelPhase]
    || CATALOG_FIT_BASE[bossCode] || {};
}

// 클립 하나만 눈높이가 따로 필요한 경우. 그 클립을 재생하는 동안 카메라와 시선을
// 같은 값만큼 올린다 — 각도와 거리는 그대로다.
const CLIP_CAM_LIFT = [
];

function getBossTransform(bossCode, isCatalogExport) {
  // 신형 추출본은 루트 노드에 방향 회전이 이미 들어 있고(쿼터니언 [0,-1,0,0] = yaw 180도)
  // GLTFLoader 가 그걸 적용한다. 보스별 보정값은 구형 파이프라인이 어긋나게 뽑아준 걸
  // 손으로 맞춘 값이라, 신형에 얹으면 회전이 두 번 걸려 오히려 망가진다.
  // 같은 보스를 신형으로 다시 올리면 이 함수가 알아서 보정을 건너뛴다.
  // 좌우 180도가 이 보스들의 정면이다(테스트 뷰어에서 확인).
  // 정규화가 전체 바운딩 기준이라, 화면에서 벗어난 파츠까지 세면 보스가 작게 잡히는
  // 보스가 있다. 그런 보스만 기본 배율·높이를 손으로 맞춰 둔다.
  if (isCatalogExport) {
    const fit = CATALOG_FIT_OVERRIDES[bossCode];
    return {
      rotation: [0, 180, 0],
      position: fit && fit.position ? fit.position.slice() : [0, 0, 0],
      scale: fit && fit.scale ? fit.scale : 1,
    };
  }

  const raw = BOSS_TRANSFORM_OVERRIDES[bossCode] || {};
  return {
    rotation: raw.rotation || DEFAULT_ROTATION,
    position: raw.position || [0, 0, 0],
    scale: raw.scale || 1,
  };
}

// 보스 패턴에 따라 바뀌는 발광색.
// 원본 셰이더의 _GlowColor 는 HDR 이라 최대 성분이 1 을 넘는다. 내보내기가 그 최대값을
// 강도(KHR_materials_emissive_strength)로 빼내고 색을 정규화하므로 여기서도 같은 형식으로 적는다.
//   파랑   (0,      0.8376, 2.7922)
//   보라   (0.7495, 0,      2.7922)
//   노랑   (2.7922, 1.3961, 0)
const GLOW_PRESETS = [
  // 평소 모습이 기본이다. 파랑·보라·노랑은 보스 패턴 중에만 켜지는 색.
  { key: 'off',    label: '원본' },
  { key: 'blue',   label: '파랑',  rgb: [0, 0.300, 1], css: '#00A8FF' },
  { key: 'purple', label: '보라',  rgb: [0.268, 0, 1], css: '#8E00FF' },
  { key: 'yellow', label: '노랑',  rgb: [1, 0.500, 0], css: '#FFB000' },
];

// 보스마다 실제로 쓰는 색만 낸다. 적어 두지 않은 보스는 전부 낸다.
//   앨트루이아는 패턴 발광이 파랑 하나뿐이다.
const GLOW_KEYS_BY_BOSS = {
  xbg004: ['off', 'blue'],
};

function glowPresetsFor(bossCode) {
  const keys = GLOW_KEYS_BY_BOSS[bossCode];
  return keys ? GLOW_PRESETS.filter(p => keys.includes(p.key)) : GLOW_PRESETS;
}

// 발광 후처리.
//
// 게임은 블룸 threshold 를 1.0~1.05 로 쓴다(캐시에서 확인된 40개 표본 중 33개가 이 범위).
// 뷰어에 threshold 가 없으면 HDR 1.7 짜리 발광이 그대로 화면에 꽂혀서 하얗게 뜬다.
// 임계를 넘는 부분만 번지게 해야 "검은 몸체에 전류가 흐르는" 느낌이 난다.
const BLOOM = { threshold: 1.0, strength: 0.55, radius: 0.5 };

// 원본 셰이더의 프레넬 감쇠(_GlowPower)를 표준 재질에 얹는다.
//
// 발광 방식이 두 갈래다. 내보내기가 extras.unity 에 원본 값을 넣어 줘서 구분할 수 있다.
//   _GlowPower 3.0~5.0  : 텍스처가 없고 프레넬 항으로 테두리를 만든다 (fresnel 계열)
//   _GlowPower 0.01     : 사실상 감쇠 없음. 흑백 텍스처가 그라디언트를 만든다
// pow(rim, 0.01) 은 거의 1 이라, 같은 식을 두 갈래에 그대로 써도 후자는 영향이 없다.
function applyFresnelGlow(mat) {
  const unity = (mat.userData && mat.userData.unity) || null;
  const power = unity && typeof unity._GlowPower === 'number' ? unity._GlowPower : null;
  if (power === null || power <= 0) return;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowPower = { value: power };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uGlowPower;\nvoid main() {')
      // emissivemap_fragment 는 법선이 정해진 뒤에 온다. 여기서 발광량에 테두리 항을 곱한다.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float rim = 1.0 - abs(dot(normalize(vViewPosition), normal));
          totalEmissiveRadiance *= pow(clamp(rim, 0.0, 1.0), uGlowPower);
        }`
      );
  };
  // 감쇠 지수가 다르면 셰이더도 달라야 한다
  mat.customProgramCacheKey = () => 'glowpow:' + power;
  mat.needsUpdate = true;
}

// 사망 연출에서 떨어져 나가는 파편 본. 화면 잡기·카메라 추적 기준에서 뺀다.
const DEBRIS_BONE_RE = /twp/i;


// 몸통 중심축 본. 3ds Max Biped 표준 이름 + body/bust/neck 계열.
// 파츠가 떨어져 나가는 연출에서 파츠까지 평균 내면 본체와 파편 사이 빈 공간을 잡는다.
// 머리 본. 몸통이 흩어져도 머리를 잡아야 하는 보스에서 쓴다(검은 뱀).
const HEAD_BONE_RE = /(^|_)(head|skull|face|jaw)/i;
const CORE_BONE_RE = /(^|_)(bip\d*|pelvis|spine|neck|bust|head|body)/i;

// 원점에 붙박이로 남는 앵커. 리그가 멀리 가도 이 본들은 그대로라, 평균에 넣으면
// 중심을 자꾸 원점 쪽으로 끌어당긴다(검은 뱀: 머리가 2.12 인데 타깃은 1.15 였다).
const ANCHOR_BONE_RE = /^(root\d*|Helper_|Control_)/i;

// 카메라가 따라갈 본체 메쉬 — 파편을 뺀 본이 가장 많은 스킨드메쉬.
// 보스마다 이름이 달라서(body_skin / 1phase_skin) 이름으로 찍지 않는다.
// 본 수만으로 고르면 팔처럼 관절 많은 파츠가 이기는 보스가 있다.
// (프로비던스: arm_l 35본 vs head 34본 — 한 개 차이로 팔이 뽑혔다)
// 몸통·머리로 보이는 이름에 큰 가산점을 줘서 그쪽이 먼저 잡히게 한다.
const FOCUS_NAME_RE = /(^|_)(body|head|torso|chest)(\d*)(_|$)/i;

// 보스별로 화면 중심을 어디에 둘지 직접 지정한다.
// 자동 판정으로는 두 보스를 동시에 만족시킬 수 없다 —
//  - 애니힐리오는 사망 연출에서 머리가 동체보다 2.3 위로 떠오른다. 동체(skin_2)를 잡아야 한다.
//  - 검은 뱀은 동체가 몸 전체(209본)라 평균이 몸통 한가운데로 가고, 머리를 놓친다.
// mesh: 추적 기준 메쉬 이름 / bone: 그 메쉬 안에서도 이 본들만 평균낸다.
// 사람 몸통 골격(3ds Max Biped) + 이 보스가 따로 쓰는 가슴·목 본.
// 팔다리에 매달린 무기·날개는 뺀다.
const TORSO_BONE_RE = /(^|_)(bip\d*_(pelvis|spine\d*|neck\d*|head)|bust\d*|neckspi)/i;

const FOCUS_OVERRIDES = [
  // 애니힐리오: 사망 연출에서 무기 본(mwp/bwp 45개)이 떨어져 나가는데,
  // 동체 메쉬의 본 93개를 그냥 평균내면 그쪽으로 끌려간다. 사람 몸통만 잡는다.
  { boss: /^xba003/i, mesh: /2phase_body_skin_2$/i, bone: TORSO_BONE_RE },
  { boss: /^bbg008/i, bone: HEAD_BONE_RE },
  { boss: /^mbg002/i, mesh: /1phase_skin(_\d+)?$/i },
];

function focusOverrideFor(bossKey) {
  if (!bossKey) return null;
  return FOCUS_OVERRIDES.find(o => o.boss.test(bossKey)) || null;
}

function pickFocusMesh(meshes, override) {
  if (override && override.mesh) {
    const named = meshes.find(m => m.isSkinnedMesh && m.skeleton && override.mesh.test(m.name || ''));
    if (named) return named;
  }
  let best = null, bestScore = -1;
  for (const m of meshes) {
    if (!m.isSkinnedMesh || !m.skeleton) continue;
    // 발광용 겹쳐 그리는 껍데기(_fx)는 본체가 아니다
    if (/_fx(_\d+)?$/i.test(m.name || '')) continue;
    let n = 0;
    for (const b of m.skeleton.bones) if (!DEBRIS_BONE_RE.test(b.name || '')) n++;
    const score = n + (FOCUS_NAME_RE.test(m.name || '') ? 100000 : 0);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

// 이 메쉬의 정점이 실제로 매달려 있는 본만 추린다.
// 한 파일의 메쉬들이 스켈레톤 하나를 공유하는 경우가 많아서(애니힐리오 2페이즈는
// body_skin_2 / _3 가 같은 225본 스켈레톤을 쓴다) skeleton.bones 를 그대로 평균내면
// 어느 메쉬를 고르든 결과가 똑같아진다. skinIndex 로 걸러야 메쉬 지정이 의미를 갖는다.
function focusBonesOf(mesh) {
  if (mesh.userData.__focusBones) return mesh.userData.__focusBones;
  const bones = mesh.skeleton.bones;
  const idx = mesh.geometry && mesh.geometry.attributes.skinIndex;
  const wgt = mesh.geometry && mesh.geometry.attributes.skinWeight;
  let picked = null;
  if (idx && wgt) {
    const used = new Set();
    for (let i = 0; i < idx.count; i++) {
      for (let k = 0; k < 4; k++) {
        if (wgt.getComponent(i, k) > 0.001) used.add(idx.getComponent(i, k));
      }
    }
    if (used.size) picked = [...used].map(i => bones[i]).filter(Boolean);
  }
  const list = (picked || bones).filter(b => {
    const name = b.name || '';
    return !DEBRIS_BONE_RE.test(name) && !ANCHOR_BONE_RE.test(name);
  });
  mesh.userData.__focusBones = list.length ? list : bones.slice();
  return mesh.userData.__focusBones;
}

// 추적 기준점.
//  - boneFilter 가 정규식이면: 스켈레톤 전체에서 그 본들만 평균낸다(보스별 지정).
//  - 'all' 이면: 기준 메쉬에 매달린 본 전부(메쉬를 이름으로 지정한 경우).
//  - 없으면: 기준 메쉬의 본 중 중심축 -> 전체 순으로 물러난다.
// 겨냥 보정(AIM_CUT/AIM_ALL)이 쓰는 중심. rigCenter 는 메쉬 하나의 본 "평균"이라
// 본이 한쪽에 몰린 보스에서는 눈에 보이는 한가운데와 어긋난다. 프로비던스 등장
// 6.22초에서 그 차이가 화면 가로로 0.47 이나 났다. 여기서는 보이는 메쉬 전부의
// 본을 모아 bbox 한가운데를 쓴다 - 화면에 잡히는 덩어리의 중앙에 가깝다.
function visualCenter(meshes, out) {
  const v = new THREE.Vector3();
  let n = 0;
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  const seen = new Set();
  for (const m of meshes) {
    if (!m.isSkinnedMesh || !m.skeleton || !m.visible) continue;
    if (/_fx(_\d+)?$/i.test(m.name || '')) continue;
    for (const b of m.skeleton.bones) {
      if (seen.has(b)) continue;
      seen.add(b);
      const name = b.name || '';
      if (DEBRIS_BONE_RE.test(name) || ANCHOR_BONE_RE.test(name)) continue;
      if (!isBoneVisible(b)) continue;
      b.getWorldPosition(v);
      if (!isFinite(v.x) || !isFinite(v.y) || !isFinite(v.z)) continue;
      if (v.x < mnx) mnx = v.x; if (v.x > mxx) mxx = v.x;
      if (v.y < mny) mny = v.y; if (v.y > mxy) mxy = v.y;
      if (v.z < mnz) mnz = v.z; if (v.z > mxz) mxz = v.z;
      n++;
    }
  }
  if (!n) return null;
  out.set((mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2);
  return out;
}

function rigCenter(mesh, out, boneFilter) {
  if (!mesh || !mesh.skeleton) return null;
  const v = new THREE.Vector3();
  const gather = (bones, re, liveOnly) => {
    let n = 0;
    out.set(0, 0, 0);
    for (const b of bones) {
      const name = b.name || '';
      if (DEBRIS_BONE_RE.test(name) || ANCHOR_BONE_RE.test(name)) continue;
      if (re && !re.test(name)) continue;
      if (liveOnly && !isBoneVisible(b)) continue;
      b.getWorldPosition(v);
      // 원본 데이터에 NaN 이 섞여 있다 — 거대 질량체 skill_start_08 은
      // eba004_main_dr_173 의 위치 키 51 개 중 72 개 값이 NaN 이다. 그 본은 스케일이
      // 0 이라 게임에서는 안 보이지만, 평균에 한 개만 들어가도 중심 전체가 NaN 이 된다.
      if (!isFinite(v.x) || !isFinite(v.y) || !isFinite(v.z)) continue;
      out.add(v); n++;
    }
    return n;
  };
  // 보이는 본만 세고, 하나도 없으면 어쩔 수 없이 전부 센다.
  const live = (bones, re) => gather(bones, re, true) || gather(bones, re, false);

  const bones = focusBonesOf(mesh);

  // 보스별로 본을 콕 집었으면 그게 곧 정답이다. 기준 메쉬 안에서 먼저 찾고,
  // 하나도 없을 때만 스켈레톤 전체로 넓힌다.
  // 개수가 적다고 전체 평균으로 물러나면 안 된다 — 검은 뱀은 머리·턱 본이 전부
  // 7개(기준 메쉬 기준 2개)라, 예전에 "3개 미만이면 전체" 규칙에 걸려 몸통
  // 한가운데로 끌려갔다.
  if (boneFilter && boneFilter !== 'all') {
    let n = live(bones, boneFilter);
    if (!n) n = live(mesh.skeleton.bones, boneFilter);
    if (n) return out.divideScalar(n);
  }

  // 메쉬를 이름으로 지정했으면 그 메쉬 전체가 기준이다. 여기서 중심축으로 한 번 더
  // 좁히면 애니힐리오는 Bip001 상체 체인만 남아 결국 머리를 따라간다.
  if (boneFilter === 'all') {
    const n = live(bones, null);
    return n ? out.divideScalar(n) : null;
  }
  let n = live(bones, CORE_BONE_RE);
  if (n < 3) n = live(bones, null);
  return n ? out.divideScalar(n) : null;
}

// 스케일 0 으로 꺼둔 본인지. 게임은 파츠를 지우는 대신 크기를 0 으로 만든다 —
// 거대 질량체 skill_start_08 에서는 동체 메쉬의 본 759 개 중 755 개가 이 상태다.
// 안 보이는 본을 평균에 넣으면 화면에 없는 곳으로 시점이 끌려간다.
function isBoneVisible(bone) {
  const e = bone.matrixWorld.elements;
  const s2 = Math.max(
    e[0] * e[0] + e[1] * e[1] + e[2] * e[2],
    e[4] * e[4] + e[5] * e[5] + e[6] * e[6],
    e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
  return s2 > 1e-8;
}

// 추적 기준 본들이 퍼져 있는 정도. 리그가 한 점으로 접혔는지 보려고 쓴다.
function rigSpread(mesh, center, boneFilter) {
  if (!mesh || !mesh.skeleton) return 0;
  const bones = (boneFilter && boneFilter !== 'all')
    ? mesh.skeleton.bones.filter(b => boneFilter.test(b.name || ''))
    : focusBonesOf(mesh);
  const v = new THREE.Vector3();
  let max = 0;
  for (const b of bones) {
    if (!isBoneVisible(b)) continue;
    const d = b.getWorldPosition(v).distanceToSquared(center);
    // NaN 은 어떤 비교에도 false 라, 걸러내지 않으면 퍼짐 방어가 통째로 무력화된다
    if (isFinite(d) && d > max) max = d;
  }
  return Math.sqrt(max);
}

// 로드 직후의 모든 노드 트랜스폼. 클립을 바꿀 때 여기로 되돌린다.
function capturePose(root) {
  const list = [];
  root.traverse(o => list.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  return list;
}

// 클립마다 건드리는 본 집합이 다르다 — 사망 연출은 파편 본을 멀리 날려보내는데
// idle 에는 그 본들에 트랙이 없어서, 믹서를 새로 만들어도 아무도 되돌려주지 않는다.
// 그러면 idle 로 돌아와도 파편이 날아간 자리에 박힌 채 남는다.
function restorePose(list) {
  if (!list) return;
  for (const [o, p, q, sc] of list) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(sc); }
}

// start -> loop -> end/fire 로 이어지는 클립 묶음. 이름 규칙만으로 찾는다.
//   groggy_start / groggy_loop / groggy_end
//   skill_start_01 / skill_loop_01 / skill_fire_01
// 꼬리표가 번호만인 보스(skill_start_01)도 있고, 포신마다 갈리는 보스도 있다 —
// 미러 컨테이너는 shot_start_l1_02 / shot_fire_l1_02 / shot_end_l1_02 처럼
// 좌우 3문씩 여섯 벌이다. 그래서 꼬리표를 번호로 한정하지 않는다.
// (기존 보스 9개 클립 전부에 대해 결과가 달라지지 않는 것을 확인했다)
const SEQ_RE = /^(.*?)_(start|loop|end|fire)(_.+)?$/i;

// 게임에는 있는데 전용 클립이 없는 스킬을 원본 클립을 잘라 만들어 끼우는 자리.
// 지금은 비어 있다.
//
// 거대 질량체 05 번이 여기 있었다. 파일에 *_05 라는 이름의 AnimationClip 이 아예
// 없고(01·02·03·04·06·07·08·09·10 만 있다), 게임 타임라인이 skill_loop_04 를
// 1.17 초 지점부터, 이어서 skill_fire_04 를 통째로 얹어 쓴다. 그걸 그대로 재현해
// 목록에 skill_05 로 끼워 넣었었다(잘린 loop 가 1.663 초, 합쳐서 4.97 초).
// 원본 클립이 아니라 우리가 이어 붙인 것이라 목록에서 뺐다 — 되살리려면
// 아래 배열에 이 한 덩어리를 다시 넣으면 된다.
//   { boss: /^eba004/i, key: 'skill_05',
//     steps: [{ re: /_skill_loop_04$/i, from: 1.17 }, { re: /_skill_fire_04$/i }] }
const SYNTHETIC_SEQUENCES = [];

// 내보내기가 인게임 카메라를 같이 넣어 준다 — 카메라 노드 하나에 등장·사망용
// 카메라 클립이 붙는다. 클립이 자기 트랜스폼을 직접 움직이므로 커브 값이 곧 카메라
// 위치·회전이고, 노드가 모델과 같은 그룹 안에 있어 좌표계도 저절로 맞는다.
// 게임 카메라가 보스를 너무 멀리서 잡는 보스. 카메라 "움직임" 은 그대로 두고
// 모델 쪽으로 당기기만 한다.
// 애니힐리오·거대 질량체·검은 뱀은 원본 거리가 맞아서 건드리지 않는다 —
// 자동 판정으로 걸면 그쪽 프레이밍까지 바뀐다(검은 뱀 등장이 42% 에서 57% 로 커졌다).
// 온리 원은 아직 화각이 60 도로 하드코딩된 파일이라 멀게 잡힌다.
// 프로비던스는 연출별 화각(등장 40.5도 / 사망 45도)이 들어오면서 필요 없어졌다.
//   pull : 너무 멀리서 잡아서 모델 쪽으로 당긴다
//   aim  : 보스를 화면 한쪽으로 밀어놔서 겨누는 방향만 돌린다
//          (프로비던스 등장은 좌 6~9도 / 하 11~25도 로 밀려 화면 밖으로 나간다)
// ── 원본 확인 모드 ────────────────────────────────────────────
// 주소에 ?raw=1 을 붙이면 우리가 손으로 넣은 보정을 전부 끈다.
// 게임 파일에 든 값만으로 어떻게 보이는지 확인하는 용도다.
//   끄는 것 - 연출 카메라 보정 9단계(뒤집기·겨냥·거리·기울기·구조·확대·물림),
//             클립 앞부분 잘라내기, 목록에서 클립 감추기, 연출별 눈높이
//   두는 것 - 모델 정규화(화면에 담기 위한 균일 축소), 파츠 기본 표시,
//             재질 처리. 카메라와 모델에 똑같이 걸려서 구도를 바꾸지 않는다.
const RAW_MODE = (() => {
  try { return /[?&]raw=1(?:&|$)/.test(location.search); } catch (e) { return false; }
})();

// 켜져 있는 것을 화면에서 바로 알 수 있게 띠를 붙인다. 이걸 모르고 보면
// "왜 이렇게 어긋나지" 하고 엉뚱한 곳을 고치게 된다.
if (RAW_MODE) {
  try {
    const tag = document.createElement('div');
    tag.id = 'f3d-raw-tag';
    tag.textContent = '원본 확인 모드 — 뷰어 보정 꺼짐';
    tag.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);'
      + 'z-index:9999;padding:5px 12px;border-radius:999px;font:700 12px/1.4 system-ui;'
      + 'color:#fff;background:#c0392b;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none';
    (document.body || document.documentElement).appendChild(tag);
  } catch (e) { /* 표시는 못 붙어도 동작에는 지장이 없다 */ }
}

// 연출 홀더(cutsceneAnchor)를 적용할 카메라.
//
// 게임은 연출마다 "홀더" 노드를 두고 그 아래에서 카메라를 움직인다. 추출본의
// 카메라 커브가 그 홀더를 반영한 것도 있고 아닌 것도 있는데, 어느 쪽인지
// 파일이 말해주지 않는다(추출 쪽에서 구조적 근거를 못 찾았다).
//
// 그래서 연출별로 적어 둔다. 홀더 행렬 자체는 게임 값이고
// (extras.cutsceneAnchorNoMirror), 여기서 정하는 건 "적용할지 말지" 뿐이다.
// 41개 카메라를 적용/미적용 두 상태로 재서, 인게임 영상과 맞는 쪽을 골랐다.
//   프로비던스 등장  거리/세로 12.32 -> 4.40,  화면 점유 11% -> 28%
//   프로비던스 사망           13.57 -> 4.39,            9% -> 31%
//   온리 원 등장               6.66 -> 1.63,           22% -> 79%
//   그레이브 디거 사망  겨냥 83.4도 -> 25.5도
//   아일랜드 이터 2페 등장   136.9도 -> 33.3도
//   아일랜드 이터 사망        48.0도 -> 22.7도
//   사치스러운 거미 사망     171.6도 -> 98.1도 (아직 이상하지만 나아진다)
//
// 나머지 34개는 적용하면 오히려 무너진다(겨냥이 100도 넘게 튄다).
const CUTSCENE_ANCHOR_ON = [
  /^xbg002_appearance_camera$/i,
  /^xbg002_dead_camera$/i,
  /^ebg001_phase002_appearance_camera$/i,
  /^mbg002_dead_camera$/i,
  // 온리 원 take01 - 홀더 없이는 세로 중심이 클립 내내 -13.8 -> -1.7 도로
  // 12도를 훑고 지나간다(게이트핏 세로 반각이 8.6도라 앞부분이 화면 밖이다).
  // x z 를 넣으면 -4.5 +- 0.8 도로 고정되고 크기도 화면 높이의 90~130% 가 된다.
  // 홀더 평행이동 x 0.0 / y -4.8 / z +125.9, 회전 X축 25.0도(회전·y 는 안 쓴다).
  /^xbg003_take01_camera$/i,
  // 온리 원 등장 - 위 설명과 같다. RAW_CAM_BOSS 의 holder 와 짝이다.
  /^xbg003_appear_camera$/i,
];

// 홀더에서 수평 평행이동(x, z)만 꺼내 쓴다.
//
// 회전을 넣으면 카메라 무빙이 파일 값과 달라지는데, 인게임 영상과 대조해 보면
// 무빙 자체는 파일 값이 이미 맞다.
//
// y 를 빼는 이유는 따로다. 홀더의 수평 성분은 "모델이 놓인 자리"인데(그레이브
// 디거 사망에서 모델 중심 x=297.74, 홀더 x=297.69 로 일치한다) y 는 그렇지
// 않다 - 같은 보스에서 모델 y=2.77, 홀더 y=11.65 로 8.88 차이가 난다.
// y 는 카메라 리그가 지면에서 얼마나 높이 달려 있는지를 담은 값이고, 모델은
// 이미 제 높이에 있다. 그래서 y 까지 더하면 카메라가 두 번 올라가고, 파일
// 회전이 원래 6~21도 위를 보는 탓에 보스가 화면 아래로 밀려 잘려 나간다.
//
// 화면 안에 들어오는 정점 비율(9샘플 평균):
//                     홀더 없음   x z 만   전부
//   프로비던스 등장        82%      96%     70%
//   프로비던스 사망       100%      97%     63%
//   아일랜드 이터 2페        5%      66%     61%
//   그레이브 디거 사망       0%      94%     79%
// 연출 카메라의 화각을 화면비에 맞춰 고친다.
//
// 파일에 든 값은 Cinemachine 의 m_Lens.FieldOfView 이고 유니티 기준 세로 화각인데,
// 게임은 센서가 정사각(1,1)이고 게이트핏이 가로라서 그 각도가 실제로는 가로에
// 걸린다. 세로는 화면비에 따라 정해진다. three.js 의 camera.fov 는 세로라서
// 그대로 넣으면 화면이 그만큼 넓어지고 보스가 작게 잡힌다 — 16:9 에서 1.778 배다.
//
// 인게임 영상과 맞춰 본 값(세로 화면 점유):
//   온리 원 등장 후반   22% -> 39.1%   인게임 39%
//   프로비던스 등장 중반 37% -> 65.8%   인게임 71%
//   프로비던스 등장 초반 63% -> 112%    인게임 90% 이상(상하 잘림)
//
// 상수를 박지 않고 캔버스 비율에서 유도한다. 창 모양이 바뀌어도 게임과 같이
// 가로 화각을 지키고 세로만 따라 움직인다.
// 화면비는 게임 기준으로 고정한다. 캔버스 비율을 쓰면 창 모양에 따라 보스
// 크기가 달라져서 인게임과 대조할 수가 없다 - 창이 1.539 일 때 16:9 보다
// 세로 화각이 1.155 배 넓어지고 점유가 0.87 배로 줄었다.
const GAME_ASPECT = 16 / 9;

// 비교용 스위치. 주소에 ?gate=0 을 붙이면 게이트핏을 끄고 파일 화각을 그대로
// 쓴다. 화면에 다 들어오는 대신 보스가 작아진다 - 어느 쪽이 인게임에 가까운지
// 보스마다 갈려서, 눈으로 대보라고 열어 둔다.
const GATEFIT_OFF = (() => {
  try { return /[?&]gate=0(?:&|$)/.test(location.search); } catch (e) { return false; }
})();

// 비교용 스위치 2. ?aim=1 을 붙이면 연출 카메라가 매 프레임 보스 중심을
// 겨냥한다. 위치·거리·화각은 파일 값 그대로라 카메라 워크는 남는다.
//
// 파일의 회전은 보스를 시선축 아래 6~18도에 두다가 중간에 위로 올린다
// (-17.8도 ~ +4.1도). 인게임은 "정중앙 고정"이라는 관찰이 있어서, 파일
// 회전이 그대로 쓰이지 않는다는 가정을 눈으로 대볼 수 있게 열어 둔다.
// 추출 쪽에서 m_LookAt·Composer·LensShift·Dutch 가 전부 비어 있음을 확인했고,
// 겨냥 타겟을 조인트 중심으로 잡든 정점 중심으로 잡든 1도 이하 차이다.
const AIM_ALL = (() => {
  try { return /[?&]aim=1(?:&|$)/.test(location.search); } catch (e) { return false; }
})();

// 컷 단위 겨냥 보정. ?aim=2 로 켠다.
//
// ?aim=1(매 프레임 겨냥)은 구도를 맞추지만 카메라가 보스를 계속 따라다녀서
// 무빙이 죽는다. 게임 연출은 컷 안에서 방향이 고정돼 있고 컷이 바뀔 때 튄다.
// 그래서 컷이 시작될 때 한 번만 "보스가 화면 중앙에 오는 회전"과 파일 회전의
// 차이를 재서, 그 컷 동안 같은 값을 계속 더한다.
//   - 컷 안에서는 파일 회전 그대로 움직인다(무빙 유지)
//   - 구도는 컷 머리에서 맞춰진다
// 컷은 카메라 위치가 한 프레임에 크게 튀는 지점으로 잡는다. 프로비던스 등장은
// 3.30초까지 카메라가 완전히 정지해 있다가 3.40초에 거리 7.19 -> 4.34 로 뛴다.
const AIM_CUT = (() => {
  try { return /[?&]aim=2(?:&|$)/.test(location.search); } catch (e) { return false; }
})();

// 컷 안에서 겨냥이 대상을 따라가는 속도(초). 클수록 느리게 붙는다.
// 0 이면 컷 머리에서만 맞추고 그 뒤로는 안 따라간다.
// 주소에 ?d=0.8 처럼 붙여 바꿀 수 있다. 게임 쪽 CinemachineComposer 의
// m_HorizontalDamping / m_VerticalDamping 이 둘 다 0.5 라 그 값을 기본으로 둔다.
// 겨냥 보정을 기본으로 켜는 보스. 인게임 스크린샷과 대조해 맞는 것을 확인한
// 것만 올린다. 나머지는 주소에 ?aim=2 를 붙여야 켜진다.
//   프로비던스 - 등장 0.77/0.90/3.90/6.22초 네 지점을 인게임과 대조했다.
const AIM_CUT_BOSS = [
  /^xbg002/i,
];

function aimCutForBoss(bossKey) {
  return AIM_CUT_BOSS.some(re => re.test(bossKey || ''));
}

// 게이트핏(가로 화각 -> 16:9 세로 환산)을 끄고 파일 화각을 그대로 쓰는 보스.
// 온리 원에서는 게이트핏 쪽이 인게임과 맞았는데, 애니힐리오는 반대다 -
// 12phase_appeanrance · 2phase_appearance · death 세 클립을 인게임과 대보면
// 파일 화각(40도) 그대로가 맞다. 왜 갈리는지는 아직 모른다.
const GATEFIT_OFF_BOSS = [
  /^xba003/i,
  // 하베스터·사치스러운 거미 - 파일 화각 60도 그대로가 인게임과 맞는다.
  // 게이트핏을 걸면 36도로 좁아져서, 같은 크기로 보이게 하려면 카메라가
  // 훨씬 멀어져야 하고 그러면 원근이 죽는다. 인게임 사망 스크린샷은 가까이서
  // 넓은 화각으로 잡아 다리가 좌우 화면 밖으로 뻗어 나간다.
  /^bbg001/i,
];

function gateFitOffFor(bossKey) {
  return GATEFIT_OFF_BOSS.some(re => re.test(bossKey || ''));
}

// 연출 카메라를 그 자리에서 밀어 두는 자리. 파일 값 위에 얹는 평행이동이라
// 회전·화각·카메라 워크는 그대로 남고 구도만 옮겨진다.
// 카메라 로컬 기준이다 - x 는 화면 오른쪽, y 는 화면 위, z 는 뒤.
// ?raw=1 에는 안 걸린다.
//
// spin - 모델을 지나는 세로축 기준으로 카메라 리그를 통째로 돌린다(도).
//   추출본에 카메라 위치가 반대편으로 들어온 연출을 되돌리는 데 쓴다.
// roll - 화면 기울기(도). 양수면 화면이 반시계로 돈다.
// back - 시선축을 따라 뒤로 물리는 배율. RAW_CAM_BOSS 의 back 과 같은 방식이다.
//   z 로 고정값을 주면 안 되는 연출에 쓴다 - 컷마다 거리가 크게 달라지는 연출은
//   같은 값이 먼 컷에서는 조금, 가까운 컷에서는 과하게 먹는다.
//   pivot 은 물리는 "양" 을 재는 기준 본이다(방향은 늘 시선축이라 대충 맞으면 된다).
//
// 주의 - 파일 값을 얹은 직후, 뒤집기(cinematic.flip) 앞에서 적용된다. 뒤집기가
// 걸리는 연출에 쓰면 앞뒤·좌우가 반대로 먹으니 그때는 눈으로 확인하고 부호를 뒤집을 것.
const CLIP_CAM_MOVE = [
  // 아일랜드 이터 2페이즈 등장 - 보스가 화면 오른쪽으로 치우쳐 있다.
  // 카메라를 오른쪽으로 밀면 보스가 가운데로 온다. 7.8초 기준으로 맞췄다.
  //
  // 값은 그 시각의 "카메라 기준 가로 좌표" 를 그대로 적은 것이다. 7.8초에서
  // 보스 본들의 카메라 로컬 x 가 전부 0.216 근처였다(body_bone001 0.216 /
  // core_bone001 0.216 / head_bone001 0.219 / frame_bone001 0.218 /
  // phase002·003_skin 바운딩 중심 0.212 · 0.218). 그만큼 밀면 0 이 된다.
  // 화면비와 무관한 값이라 창 크기가 달라져도 가운데에 선다.
  //
  // 거리·높이 - 마지막 프레임(11.20초)을 인게임 스크린샷과 맞춘 값이다.
  // 16:9 로 렌더해서 보스 실루엣을 재고, 인게임에서 잰 값에 맞췄다.
  //   인게임   가로 73.2%,  세로 중심 +0.268
  //   맞추기 전 가로 92.6%,  세로 중심 +0.187  (화면 밖으로 잘렸다)
  //   맞춘 뒤  가로 73.2%,  세로 중심 +0.268
  // 세로 크기는 인게임 67.7% 에 못 맞춘다(맞춘 뒤 82.8%). 뷰어 쪽 자세가
  // 인게임보다 세로로 길어서 카메라로는 못 좁힌다 - 가로를 기준으로 삼았다.
  //
  // 실루엣을 잴 때 1페이즈 파편은 빼야 한다. 전환 연출은 CLIP_SOLO_PARTS 로
  // 파츠를 전부 켜 두는데, 버려진 1페이즈 껍데기가 화면 아래(세로 -0.9 ~ -4.25)
  // 까지 늘어져 있어서 같이 세면 세로 폭이 274% 로 잡힌다.
  //
  // 거리는 z 고정값으로는 못 맞춘다 - 카메라가 1.60 에서 0.44 까지 붙었다
  // 떨어졌다 해서 같은 값이 먼 컷에서는 조금, 가까운 컷에서는 과하게 먹는다.
  // 검은 뱀 사망 - 연출 내내 보스가 화면 왼쪽에 치우쳐 있다. 5초를 훑어 재니
  // 실루엣 무게중심이 평균 -0.329 였고, 화면을 꽉 채우는 두 프레임(0.6~0.9초)을
  // 빼면 거의 모든 지점이 음수다. 카메라를 왼쪽으로 밀어 보스를 오른쪽으로 옮긴다.
  //   -0.35 로 재 보니 평균이 +0.073 으로 넘어가서 -0.29 로 줄였다.
  { boss: /^bbg008/i, re: /_death$/i, x: -0.29 },
  // 그레이브 디거 등장 - 인게임이 훨씬 멀다. 마지막 프레임(6.65초)을 인게임
  // 스크린샷과 맞췄다. 16:9 로 렌더한 실루엣 기준:
  //   인게임      가로 10.4%  세로 18.1%
  //   맞추기 전   가로 45.1%  세로 61.9%
  //   맞춘 뒤     가로 10.4%  세로 16.9%
  // 세로까지 같이 맞는 것으로 보아 각도 차이로 보이던 것도 거리 때문이었다.
  //   인게임에 맞춘 값은 back 3.76 인데 그보다 가깝게 보고 싶다고 해서 낮췄다.
  //   가로 폭은 back 에 대해 45.1 / (1 + 1.211 x (back - 1)) 로 움직인다
  //   (두 지점을 재서 낸 식 - 3.76 에서 10.6%, 3.30 에서 12.1% 로 맞는다).
  //     3.76 -> 10.4%   인게임과 같음
  //     3.30 -> 12.1%
  //     2.83 -> 14.3%
  //     2.43 -> 17.4%   (식의 예측은 16.5% - back 이 작아질수록 조금씩 어긋난다)
  //     2.00 -> 21.7%   지금 값
  //   roll 은 마지막 프레임의 화면 기울기가 0 이 되는 값이다. 파일 카메라 자체가
  //   뒤 컷에서 +20.5도쯤 기울어 있어서 그걸 상쇄한다. 2.683초 컷을 경계로 파일
  //   기울기가 반대라(앞 컷 -7 ~ -11.6도) 앞 컷은 그만큼 더 기운 채로 남는다.
  { boss: /^mbg002/i, re: /^mbg002_appearance$/i, back: 2.00, roll: -20.5 },
  // 사치스러운 거미 등장 - back 1.5 를 줬었는데 게이트핏을 끄면서 필요 없어졌다.
  // 화각이 36도에서 60도로 넓어져 그것만으로 충분히 멀어진다(세로 21~66%).
  // 사치스러운 거미 사망 - 카메라 위치가 반대편으로 들어와 있어 뒷모습만 보였다.
  // spin 으로 반대편에 세우면 앞모습이 된다(사용자 확인).
  //
  // 거리는 인게임이 파일 값보다도 조금 더 가깝다. 같은 프레임(1.20초)을 대보면
  // 인게임은 세로 86% 에 다리가 좌우 화면 밖으로 나가는데 파일 값은 73.9% 다.
  // back 을 1 보다 작게 줘서 조금 더 다가간다.
  // (back 1.6 을 줬을 때는 인게임보다 훨씬 멀어졌다 - 그때 잘못 짚었다)
  //   x - 2.30초 기준으로 보스를 화면 한가운데에 세운다. 그 시각 본 바운딩
  //       중심의 카메라 로컬 가로 좌표가 +0.126 이라 그만큼 되민다.
  //       이 연출은 뒤집기가 안 걸린다(f = +1). spin 으로 반대편에 세우고 나면
  //       카메라가 이미 보스를 향하고 있어서 camNeedsFlip 이 참이 아니다.
  //       -0.126 을 줬더니 +0.252 로 두 배가 됐다 - 부호를 확인하고 넣을 것.
  { boss: /^bbg001_rich/i, re: /^bbg001_dead_01$/i, back: 0.49, spin: 180, x: 0.126 },
  // 검은 뱀 등장 take2 - 카메라가 3.43초에 각도를 오른쪽으로 돌린다. 그 앞뒤로
  // 원하는 그림이 달라서 구간을 갈랐다. 한 값으로는 둘 다 못 맞춘다.
  //   앞  얼굴 옆모습 클로즈업(인게임은 머리가 화면을 가득 채우고 가운데에 온다)
  //   뒤  몸 전체가 보이고 마지막에 가운데에 선다
  { boss: /^bbg008/i, re: /_appearance_take2$/i, to: 3.43 },
  { boss: /^bbg008/i, re: /_appearance_take2$/i, from: 3.43, x: -0.36, back: 1.4 },
  // 온리 원 등장 - 파일이 스스로 만드는 줌이 인게임보다 훨씬 약하다.
  // 카메라-보스 거리가 190 -> 136 -> 186 으로 1.39 배밖에 안 움직이는데,
  // 인게임은 중간 구간에서 받침대가 안 보일 만큼 바짝 붙는다.
  // 시작과 끝은 이미 인게임과 맞으므로(10초 세로 점유 39% 대 39%) 중간만
  // 당긴다. 열쇠 프레임으로 이어서 카메라가 도는 중에 툭 끊기지 않게 한다.
  // (지금은 뺐다 - 파일 값만으로 보는 중. 되살리려면 주석을 벗기면 된다)
  // { boss: /^xbg003/i, re: /^xbg003_appearance$/i, at: 0,   back: 1 },
  // { boss: /^xbg003/i, re: /^xbg003_appearance$/i, at: 3,   back: 1 },
  // { boss: /^xbg003/i, re: /^xbg003_appearance$/i, at: 5,   back: 0.45 },
  // { boss: /^xbg003/i, re: /^xbg003_appearance$/i, at: 6.5, back: 0.45 },
  // { boss: /^xbg003/i, re: /^xbg003_appearance$/i, at: 8.5, back: 1 },
  // 온리 원 take01 - 홀더를 켜면 구도는 안정되는데 너무 가깝다. 뒤로 뺀다.
  { boss: /^xbg003/i, re: /^xbg003_take01$/i, back: 1.8, y: 0.27 },
  { boss: /^ebg001_island/i, re: /_phase002_appearance$/i, x: 0.216, y: -0.036,
    back: 1.66, pivot: /^(Pelvis|body_bone\d+|head_bone\d+)$/i },
];

// 한 클립에 여러 줄을 두면 시간순 구간이 된다(from·to, 클립 로컬 초).
// 안 적으면 연출 전체다. 여러 줄이 겹치면 먼저 걸리는 줄이 이긴다.
function clipCamMoveFor(bossKey, clipName) {
  if (RAW_MODE) return null;
  const hit = CLIP_CAM_MOVE.filter(
    o => o.boss.test(bossKey || '') && o.re.test(clipName || ''));
  if (!hit.length) return null;
  return hit.slice().sort(
    (a, b) => camMoveTime(a) - camMoveTime(b));
}

function camMoveTime(o) {
  return (typeof o.at === 'number') ? o.at : (o.from || 0);
}

// 보간할 수 있는 값들. back 만 기본값이 1 이고 나머지는 0 이다.
const CAM_MOVE_KEYS = ['x', 'y', 'z', 'back', 'roll', 'spin'];
const camMoveLerp = {};

// 지금 시각에 걸리는 구간을 고른다.
// 두 가지 적는 법이 있다.
//
//   from / to  구간이다. 그 구간에 들어오면 값이 그대로 걸린다. 경계에서 값이
//              툭 바뀌므로 화면이 한 번 튄다 - 컷이 있는 자리에만 쓴다.
//   at         열쇠 프레임이다. 사이 값을 부드럽게 이어 준다. 카메라가 도는
//              도중에 거리를 바꿔야 하는 연출은 이쪽이다.
//
// 한 클립 안에서 둘을 섞지 말 것. at 을 적은 줄이 하나라도 있으면 그 클립은
// 전부 열쇠 프레임으로 읽는다.
function clipCamMoveAt(list, t) {
  if (!list) return null;
  if (typeof list[0].at === 'number') {
    let i = 0;
    while (i + 1 < list.length && t >= list[i + 1].at) i++;
    const a = list[i], b = list[i + 1];
    if (!b || t <= a.at) return a;
    // 양 끝에서 기울기가 0 이 되는 곡선. 그냥 직선으로 이으면 열쇠 프레임마다
    // 속도가 꺾여서 카메라가 덜컹거린다.
    const r = (t - a.at) / (b.at - a.at);
    const w = r * r * (3 - 2 * r);
    const out = camMoveLerp;
    for (const k in out) delete out[k];
    out.pivot = a.pivot || b.pivot;
    CAM_MOVE_KEYS.forEach(k => {
      if (typeof a[k] !== 'number' && typeof b[k] !== 'number') return;
      const d = (k === 'back') ? 1 : 0;
      const va = (typeof a[k] === 'number') ? a[k] : d;
      const vb = (typeof b[k] === 'number') ? b[k] : d;
      out[k] = va + (vb - va) * w;
    });
    return out;
  }
  for (const o of list) {
    if (t >= (o.from || 0) && t < (typeof o.to === 'number' ? o.to : Infinity)) return o;
  }
  return null;
}

// 연출 카메라를 파일 값 그대로 쓰는 보스. 이 보스에만 ?raw=1 을 상시로 걸어 둔
// 것과 같다 - 뒤집기·겨냥·거리·기울기·구조·확대·물림·게이트핏·타임라인 배치를
// 전부 건너뛰고 위치·회전·화각을 파일에서 읽은 그대로 쓴다.
//
// 에고비스타는 등장·사망 둘 다 보정을 얹은 쪽보다 원본이 인게임에 가깝다
// (인게임 영상 대조). 이 보스만 따로 끄면 되는 이유는 아래가 전부 비어 있어서다.
//   CUTSCENE_ANCHOR_ON · CLIP_TRIM · HIDDEN_CLIPS · CLIP_CAM_LIFT · CAMERA_FIX
//   타임라인 배치도 어긋나지 않는다(timelineStart = pairedClipTimelineStart = 0)
//   메쉬 활성 구간도 연출 내내 켜짐이라 걸러져 남는 게 없다
// 그래서 여기서 끄는 결과가 ?raw=1 로 본 화면과 정확히 같다.
// back - 원본 카메라를 모델 중심 기준으로 뒤로 물리는 배율(1 이면 파일 그대로).
//   중심에서 카메라로 뻗은 선 위에서만 움직이므로 회전과 화각은 손대지 않는다.
//   그래서 카메라 워크도, 보스가 화면에 잡히는 자리도 그대로고 크기만 줄어든다.
//   거리에 비례하니 가까이 붙는 컷도 같은 비율로 물러난다.
//   ?raw=1 에는 걸지 않는다 - 그쪽은 파일 값을 그대로 보는 기준선이어야 한다.
// pivot - 물러날 기준점을 낼 본. 이 본들의 평균이 중심이다.
//   몸 전체 바운딩으로 잡으면 안 된다 - 사망 연출은 파츠가 사방으로 흩어져서
//   중심이 카메라 코앞까지 끌려오고, 그러면 물러나는 양이 거의 0 이 된다.
//   흔들리지 않는 몸통 본만 골라 쓴다.
// clip - 그 보스 안에서 이 연출만 따로 잡을 때. 적으면 보스 한 줄보다 먼저 걸린다.
const RAW_CAM_BOSS = [
  { boss: /^xbg005/i, back: 1.12, pivot: /(^|_)(pelvis|spine_\d+|head)$/i },
  // 앨트루이아 - 등장·사망 둘 다 원본이 인게임에 가깝다. 거리는 그대로 두고
  // (back 없음) 보정만 끈다. 이쪽도 홀더·잘라내기·감추기·눈높이·카메라 보정
  // 표가 전부 비어 있고 타임라인도 안 어긋난다(tlStart = pairStart = 0).
  { boss: /^xbg004/i },
  // 퀸 001 · 거대 질량체(원종/Q) · 미러 컨테이너 - 위와 같은 조건이다.
  { boss: /^xba002/i },
  { boss: /^eba004/i },
  { boss: /^xba001/i },
  // 베히모스 - 페이즈 전환 다섯 컷만 조금 물린다. 등장·사망은 파일 값 그대로.
  //   1페이즈 take1 · take2, 2페이즈 b1_take1_a · take2 · take3
  { boss: /^mbg003/i,
    clip: /^mbg003_(?:1phase_take[12]|2phase_b1_take1_a|2phase_take[23])$/i,
    back: 1.12, pivot: /(^|_)(pelvis|spine_\d+|head(_\d+)?)$/i },
  { boss: /^mbg003/i },
  // 스톰브링어 - 여기도 원본이 인게임에 가깝다. 다만 이 보스는 ?raw=1 과
  // 완전히 같지는 않다. CLIP_TRIM(등장 앞 3.5초)과 HIDDEN_CLIPS(idle_2 · shot_*)
  // 가 남아 있어서다. 둘 다 카메라를 건드리지 않으므로 구도는 원본 그대로다.
  { boss: /^eba001/i },
  // 아일랜드 이터 - 1페이즈 등장과 사망만 원본이다. 2페이즈 등장은 홀더
  // (CUTSCENE_ANCHOR_ON)를 쓰므로 여기 넣으면 안 된다.
  { boss: /^ebg001_island/i, clip: /^ebg001_(?:phase001_appearance|island_dead)$/i },
  // 검은 뱀 - 등장 두 컷과 사망 모두 원본이 인게임에 가깝다.
  // 화각이 연출마다 다르다(등장1 33도 / 등장2 55.4도 / 사망 44도).
  { boss: /^bbg008/i },
  // 그레이브 디거 - 등장만 원본이다. 사망은 홀더(CUTSCENE_ANCHOR_ON)를 쓰고,
  // 그걸 적용해야 겨냥이 83.4도에서 25.5도로 잡힌다. 여기 넣으면 안 된다.
  //
  // 등장 카메라에도 홀더가 들어 있는데(z -434.92) 적용하면 12배쯤 멀어진다.
  // 마지막 프레임 기준 보스 가로 폭이 45.1% -> 2.8% 가 되는데 인게임은 10.4%다.
  // 이 보스의 등장 홀더는 쓰지 않는다.
  { boss: /^mbg002/i, clip: /^mbg002_appearance$/i },
  // 온리 원 등장 - 인게임 카메라 값만으로 어떻게 보이는지 확인하는 중이다.
  // 이 줄이 있으면 겨냥 보정(CAMERA_LOOK_AT)과 뒤따르는 단계가 전부 꺼진다.
  // take01 은 여기 없으므로 홀더와 CLIP_CAM_MOVE 가 그대로 걸린다.
  { boss: /^xbg003/i, clip: /^xbg003_appearance$/i, holder: 0.85 },
  { boss: /^xbg003/i, clip: /^xbg003_death$/i, back: 0.7 },
];

// clip 을 적어 둔 줄이 먼저다. 없으면 보스만 적힌 줄로 떨어진다.
function rawCamFor(bossKey, clipName) {
  return RAW_CAM_BOSS.find(
      o => o.boss.test(bossKey || '') && o.clip && o.clip.test(clipName || ''))
    || RAW_CAM_BOSS.find(o => o.boss.test(bossKey || '') && !o.clip)
    || null;
}

const AIM_DAMP = (() => {
  try {
    const m = /[?&]d=([\d.]+)(?:&|$)/.exec(location.search);
    return m ? Math.max(0, parseFloat(m[1]) || 0) : 0.5;
  } catch (e) { return 0.5; }
})();

if ((AIM_ALL || AIM_CUT) && !RAW_MODE) {   // 주소로 켰을 때만 띠를 붙인다
  try {
    const tag = document.createElement('div');
    tag.id = 'f3d-aim-tag';
    tag.textContent = AIM_CUT ? ('겨냥 비교 모드 — 컷 머리 + 추종 ' + AIM_DAMP + '초')
      : '겨냥 비교 모드 — 카메라가 보스 중심을 본다';
    tag.style.cssText = 'position:fixed;left:50%;top:' + (GATEFIT_OFF ? '38px' : '8px')
      + ';transform:translateX(-50%);z-index:9999;padding:5px 12px;border-radius:999px;'
      + 'font:700 12px/1.4 system-ui;color:#fff;background:#2e7d52;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none';
    (document.body || document.documentElement).appendChild(tag);
  } catch (e) { /* 표시는 못 붙어도 동작에는 지장이 없다 */ }
}

// 이쪽도 켜진 걸 모르면 엉뚱한 데를 고치게 된다. 띠를 붙인다.
if (GATEFIT_OFF && !RAW_MODE) {
  try {
    const tag = document.createElement('div');
    tag.id = 'f3d-gate-tag';
    tag.textContent = '화각 비교 모드 — 파일 화각 그대로(게이트핏 꺼짐)';
    tag.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);'
      + 'z-index:9999;padding:5px 12px;border-radius:999px;font:700 12px/1.4 system-ui;'
      + 'color:#fff;background:#2c6fb5;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none';
    (document.body || document.documentElement).appendChild(tag);
  } catch (e) { /* 표시는 못 붙어도 동작에는 지장이 없다 */ }
}

function gateFitFov(fovDeg, aspect) {
  const a = (aspect > 1e-6) ? aspect : 1;
  const halfW = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  return THREE.MathUtils.radToDeg(2 * Math.atan(halfW / a));
}

// scale 은 홀더를 얼마나 끼울지다(기본 1 = 통째로).
//
// 홀더는 거리를 재는 원점을 옮기기 때문에, 끼우는 양이 카메라가 당겨지는
// "비율" 을 바꾼다. 온리 원 등장으로 재보면 이렇다.
//   0     거리 190 -> 136   1.39 배   (파일 값 그대로. 인게임보다 한참 약하다)
//   0.85  거리  77 ->  23   3.4 배
//   1     거리  57 -> 3.9   14 배     (지나쳐서 카메라가 보스 안으로 들어간다)
// back 은 거리에 곱하는 값이라 이 비율을 못 바꾼다 - 여기서만 된다.
function cutsceneAnchorOf(node, scale) {
  if (RAW_MODE || !node || !node.userData) return null;
  if (!CUTSCENE_ANCHOR_ON.some(re => re.test(node.name || ''))) return null;
  const a = node.userData.cutsceneAnchorNoMirror || node.userData.cutsceneAnchor;
  if (!Array.isArray(a) || a.length !== 16) return null;
  const k = (typeof scale === 'number') ? scale : 1;
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, a[12] * k, 0, a[14] * k, 1];
}

// 뷰어가 연출 카메라에 손대는 보정은 이제 없다. 화면은 파일 값과
// cutsceneAnchor 평행이동만으로 정해진다.
const CAMERA_FIX = [];

// 인게임 카메라가 바라보는 대상. Cinemachine 은 위치(Body)와 겨냥(Aim)을 따로
// 계산하는데, 내보내기에 겨냥 결과가 안 실려 오는 연출이 있다 — 미러 컨테이너
// 사망 카메라는 위치가 대상 주위를 정확히 돈다(거리 6.5~7.4 로 일정). 각도만
// 10~60 도씩 어긋난다. 그래서 위치·화각은 게임 값 그대로 쓰고, 겨냥만 이 본으로
// 매 프레임 다시 잡는다.
//   미러 컨테이너는 등장·사망 카메라가 전부 그렇다. 몸통 한가운데서 계속 도는
//   사각 부품(xba001_head)이 그 카메라들이 따라다니는 대상이다.
// clip 을 적지 않으면 그 보스의 연출 카메라 전부에 걸린다.
const CAMERA_LOOK_AT = [
  // 온리 원 등장 - 위치는 맞는데 겨냥만 어긋난다. 파일 값으로 재보면 가로는
  // 10초 내내 +-1도 안에 들어오는데(정확하다), 세로는 5.5~7 초 구간에서만
  // 보스가 화면 중앙에서 10.5 도 아래로 내려간다. 게이트핏 세로 반각이 8.6 도라
  // 그 구간이 통째로 화면 밖이 된다 - 6.43 초에 화면이 비는 게 이것이다.
  //   t     0     2     4    4.77    6    6.43    7     8    10
  //   머리 -1.0   0.8   2.3   0.2   -6.9  -10.5  -7.7  -3.6  -2.7   (도)
  // 나머지 구간은 +-3.6 도라 겨냥을 다시 잡아도 크게 안 변한다.
  // (지금은 뺐다 - RAW_CAM_BOSS 로 파일 값만 쓰는 중이라 어차피 안 걸린다)
  // { boss: /^xbg003/i, clip: /^xbg003_appearance$/i, bone: /^xbag03_head_01$/i },
];

// 한 클립에 여러 줄을 두면 시간순 단계가 된다. from 이 없으면 0초부터다.
function cameraLookAtFor(bossKey, clipName) {
  const hit = CAMERA_LOOK_AT.filter(
    o => o.boss.test(bossKey || '') && (!o.clip || o.clip.test(clipName || '')));
  return hit.length ? hit.slice().sort((a, b) => (a.from || 0) - (b.from || 0)) : null;
}

// 같은 보스 안에서 그 연출 하나만 따로 손봐야 할 때. 보스 설정 위에 덧씌운다.
const CLIP_CAMERA_FIX = [];

function cameraFixFor(bossKey, clipName) {
  const base = CAMERA_FIX.find(o => o.boss.test(bossKey || '')) || {};
  if (clipName === undefined) return base;
  const extra = CLIP_CAMERA_FIX.filter(
    o => o.boss.test(bossKey || '') && (!o.clip || o.clip.test(clipName || '')));
  return extra.length ? Object.assign({}, base, ...extra) : base;
}

function cameraNeedsPull(bossKey) {
  const f = cameraFixFor(bossKey);
  return !!(f.pull || f.fit);
}

// 내보내기가 연출마다 카메라를 따로 넣어 준다 — 화각이 연출별로 다르기 때문이다
// (프로비던스는 등장 40.5도, 사망 45도). 그래서 노드를 전부 모은다.
function findCameraNodes(root) {
  const out = [];
  root.traverse(o => { if (o.isCamera) out.push(o); });
  return out;
}

// 이 클립이 어떤 카메라 노드를 움직이는가. 아니면 null.
function cameraClipTarget(clip, camNodes) {
  for (const node of camNodes) {
    const prefix = node.name + '.';
    if (clip.tracks.length > 0 && clip.tracks.every(t => String(t.name).startsWith(prefix))) return node;
  }
  return null;
}

// 카메라 클립 <-> 모델 클립 짝짓기.
//   eba004_appearance_camera        -> eba004_appearance_f
//   eba004_death_camera             -> eba004_death
//   bbg008_appearance_camera_take1  -> bbg008_appearance_take1
//   xba001_appearance_camera_01     -> xba001_appearance_take1
// 이름에 공백이 섞여 들어오는 파일이 있다 — 앨트루이아 사망 카메라는
// "xbg004 _death_camera" 다. 짝을 찾을 때는 공백을 빼고 본다.
function squash(name) {
  return String(name || '').replace(/\s+/g, '');
}

function pairCameraClips(clips, camNodes) {
  const nodeOf = new Map();
  clips.forEach(c => { const n = cameraClipTarget(c, camNodes); if (n) nodeOf.set(c.name, n); });
  const cams = clips.filter(c => nodeOf.has(c.name));
  const models = clips.filter(c => !nodeOf.has(c.name));
  const byModel = new Map();
  // 내보내기가 짝을 적어 준 카메라부터 처리한다. 이름 규칙보다 이쪽이 정확하다 —
  // 베히모스 dead_camera2 는 이름만 보면 dead_2 와 붙지만 실제 짝은 dead 다.
  cams.forEach(cam => {
    const node = nodeOf.get(cam.name);
    const paired = node && node.userData && node.userData.pairedClip;
    if (!paired) return;
    const target = models.find(c => c.name === paired);
    // 한 클립에 카메라가 둘 붙어 있으면 먼저 나온 것을 쓴다
    if (target && !byModel.has(target.name)) byModel.set(target.name, { clip: cam, node });
  });
  // 짝이 안 적힌 카메라만 이름으로 찾는다
  cams.forEach(cam => {
    const node0 = nodeOf.get(cam.name);
    if (node0 && node0.userData && node0.userData.pairedClip) return;
    // _camera / _camera1 / _camera_01 / _camera_take1 을 모두 받는다.
    const m = squash(cam.name).match(/^(.*?)_camera(?:_?(\d+))?(_take\d+)?$/i);
    if (!m) return;
    // take 꼬리표가 붙은 카메라는 같은 꼬리표를 가진 클립하고만 짝짓는다.
    let take = m[3] || '';
    // 카메라 이름 끝 번호가 곧 take 번호인 보스가 있다 — 미러 컨테이너는
    // appearance_camera_01 / _02 가 appearance_take1 / take2 짝이다.
    // 그 번호의 take 클립이 실제로 있을 때만 그렇게 본다.
    if (!take && m[2]) {
      const n = Number(m[2]);
      // 번호를 그대로 뒤에 붙이는 꼴(_camera2 <-> _2)을 먼저 본다.
      // take 쪽을 먼저 보면 이름만 비슷한 엉뚱한 take 클립으로 끌려간다.
      const t = '_take' + n;
      if (models.some(c => squash(c.name) === m[1] + '_' + n)) take = '_' + n;
      else if (models.some(c => squash(c.name).endsWith(t))) take = t;
    }
    const base = m[1] + take;
    // 정확히 같은 이름 -> 그 이름으로 시작 -> 그 이름이 나를 포함, 순으로 찾는다.
    const cand = models.filter(c => !take || squash(c.name).endsWith(take));
    let best = null, bestLen = -1;
    for (const c of cand) {
      const n = squash(c.name);
      let len = -1;
      if (n === base) len = 1000;
      else if (n.startsWith(base)) len = base.length;
      else if (base.startsWith(n)) len = n.length;
      if (len > bestLen) { bestLen = len; best = c; }
    }
    // 파일이 짝을 적어 준 쪽이 이긴다
    if (best && bestLen >= 8 && !byModel.has(best.name)) {
      byModel.set(best.name, { clip: cam, node: nodeOf.get(cam.name) });
    }
  });
  return { cams, byModel };
}

// 파일에는 따로 들어 있지만 실제로는 이어서 도는 연출. 한 묶음으로 낸다.
//   미러 컨테이너 2페이즈 파츠는 되살아난 뒤(rebirth) 곧바로 부서진다(Destruction).
const MANUAL_SEQUENCES = [
  {
    key: 'xba001_2phase_parts',
    steps: [/^xba001_2phase_parts_rebirth$/i, /^xba001_2phase_parts_Destruction_01$/i],
  },
  // 온리 원 등장 - 타임라인상 take01 다음에 appearance 가 바로 이어진다.
  //   take01      슬롯 0      ~ 2.8333   클립 2.5
  //   appearance  슬롯 2.8333 ~ 12.8333  클립 10
  // 두 슬롯이 소수점 끝까지 맞물린다(2.8333 x 60 = 170프레임).
  //
  // 슬롯은 2.8333 인데 클립은 2.5 라 0.333초(20프레임)가 남는데, 그 여백은
  // 타임라인 메타데이터에만 있고 애니메이션 데이터에는 없다(카메라 클립도 2.5초다).
  // 여기는 클립을 차례로 끝까지 재생하는 방식이라 그 여백은 재생되지 않는다 -
  // take01 2.5초를 마치면 곧바로 appearance 로 넘어간다.
  //
  // 묶어야 하는 또 다른 이유 - appearance 에는 소환수 크기 트랙이 아예 없어서
  // 직전 클립이 남긴 크기를 물려받는다. take01 이 하늘(ziz)을 1.00 으로 들고
  // 있다가 1.83 초부터 접어 2.33 초에 0.20 으로 끝내므로, 이어서 재생해야
  // appearance 가 접힌 상태에서 시작한다. 카메라 extras 의 meshActivation 도
  // ziz_skin / 2phase_wings_skin 을 타임라인 0 ~ 2.5 초(= take01 구간)에만
  // 켠다고 적어 두었다 - 같은 얘기다.
  {
    key: 'xbg003_appearance_all',
    steps: [/^xbg003_take01$/i, /^xbg003_appearance$/i],
  },
  // 베히모스 - 페이즈 전환 연출의 뒤 두 컷
  {
    key: 'mbg003_2phase_take',
    steps: [/^mbg003_2phase_take2$/i, /^mbg003_2phase_take3$/i],
  },
  // 애니힐리오 - 1 -> 2페이즈 전환은 두 컷이 바로 이어진다. 앞 컷은 1페이즈
  // 몸이 변형되는 장면이고(원본 철자 12phase_appeanrance), 뒤 컷이 2페이즈
  // 모습으로 서는 장면이다(xbga03 은 xba003 오타).
  {
    key: 'xba003_2phase_change',
    steps: [/^xba003_12phase_appeanrance$/i, /^xbga03_2phase_appearance$/i],
  },
  // 베히모스 1페이즈 등장 — take1 에서 크레인 부품 75개가 흩어져 날아오고
  // take2 에서 전부 제자리로 모인다. 둘이 이어져야 조립 연출로 읽힌다.
  {
    key: 'mbg003_1phase_take',
    steps: [/^mbg003_1phase_take1$/i, /^mbg003_1phase_take2$/i],
  },
  // 베히모스 - 사망은 두 컷이 바로 이어진다.
  // 키는 소속 클립 이름과 겹치면 안 된다(버튼 키가 겹쳐서 표시가 엉킨다).
  {
    key: 'mbg003_dead_all',
    steps: [/^mbg003_dead$/i, /^mbg003_dead_2$/i],
  },
  // 사치스러운 거미 두 번째 스킬. 파일 이름의 끝 번호로 묶으면 02, 03 에는 start
  // 가 없어서 낱개로 흩어진다. 인게임에서는 fire_02 -> loop_03 -> fire_01 로
  // 이어지고, 마지막 fire_01 은 skill_01 과 같은 클립을 다시 쓴다.
  // 실측도 같은 얘기다 - fire_02 끝(기본 자세에서 0.463)과 loop_03 끝(0.448)은
  // 기본 자세로 안 돌아오는데, fire_01 끝만 0.019 로 돌아온다.
  {
    key: 'bbg001_skill_02',
    steps: [/^bbg001_skill_fire_02$/i, /^bbg001_skill_loop_03$/i, /^bbg001_skill_fire_01$/i],
  },
  // 사치스러운 거미 그로기 - 사이에 낀 대기 동작 이름이 cc_idle 이다.
  {
    key: 'bbg001_cc',
    steps: [/^bbg001_cc_start_01$/i, /^bbg001_cc_idle$/i, /^bbg001_cc_end_01$/i],
  },
];

// 자동으로 묶지 않는 클립. 사치스러운 거미의 cc(그로기)는 사이에 낀 대기 동작
// 이름이 cc_idle 이라 start/loop/end 규칙에 안 걸린다. 자동 묶음(start+end)을
// 막아 두고 MANUAL_SEQUENCES 에서 start -> idle -> end 로 손수 잇는다.
const NO_SEQUENCE = [
  { boss: /^bbg001_rich/i, re: /^bbg001_cc_/i },
];

function isNoSequence(bossKey, name) {
  return NO_SEQUENCE.some(o => o.boss.test(bossKey || '') && o.re.test(name || ''));
}

function findSequences(clips, bossKey) {
  const groups = new Map();
  clips.forEach((c, i) => {
    if (isNoSequence(bossKey, c.name)) return;
    const m = (c.name || '').match(SEQ_RE);
    if (!m) return;
    const key = m[1] + (m[3] || '');
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)[m[2].toLowerCase()] = { i, clip: c };
  });
  const out = [];
  groups.forEach((g, key) => {
    if (!g.start || !(g.loop || g.end || g.fire)) return;
    const steps = [{ clip: g.start.clip, repeat: 1 }];
    // 루프를 몇 번 도는지는 파일에 없다(행동트리 영역). 그로기만 두 번 돌리고
    // 나머지는 한 번만 — 점프처럼 한 번에 끝나는 동작이 두 번 뛰면 이상하다.
    if (g.loop) steps.push({ clip: g.loop.clip, repeat: /groggy/i.test(key) ? 2 : 1 });
    if (g.fire) steps.push({ clip: g.fire.clip, repeat: 1 });
    if (g.end) steps.push({ clip: g.end.clip, repeat: 1 });
    out.push({ key, steps });
  });
  // 라벨은 보스 코드만 떼고 붙인다. 다만 한 파일에 페이즈가 여럿 들어 있는 보스
  // (에고비스타는 1phase/2phase 세트가 통째로 다 들어 있다)는 페이즈 태그를 남겨야
  // "groggy" 같은 이름이 두 개로 겹쳐 보이지 않는다.
  const phases = new Set(out.map(o => clipPhase(o.steps[0].clip.name)).filter(Boolean));
  const strip = phases.size > 1
    ? /^[a-z]{2,4}\d{3}_/i
    : /^[a-z]{2,4}\d{3}_(\d?\d?phase_)?/i;
  // 손으로 묶는 연출은 위 판정(phases)에 넣지 않는다 — 다른 보스의 라벨까지 흔든다.
  MANUAL_SEQUENCES.forEach(def => {
    if (out.some(o => o.key === def.key)) return;
    const steps = def.steps.map(re => clips.find(c => re.test(c.name || '')));
    if (steps.some(c => !c)) return;
    out.push({ key: def.key, steps: steps.map(c => ({ clip: c, repeat: 1 })) });
  });
  out.forEach(o => { o.label = o.key.replace(strip, ''); });
  return out;
}

// 좌우 머리가 따로 있는 보스가 있다. 검은 뱀은 특정 패턴에서 양옆에 머리가 하나씩
// 더 생겨 셋이 동시에 움직인다.
//
// 그 연출이 클립 세 벌로 들어 있다 — 가운데(이름 그대로), _left_, _right_.
// 좌우 위치가 애니메이션 자체에 들어 있어서(Helper_Chain_Root 이동이 최대 147 만큼
// 다르다) 모델을 셋 세워 각자 제 클립을 틀면 배치까지 그대로 재현된다.
// 머리 셋을 동시에 물려서 틀는 보스. 검은 뱀 하나뿐이라 대상을 적어 둔다.
// 이름만으로 가르면 스톰브링어의 이동 방향 셋(move_back_01 / _left_01 /
// _right_01)이 같이 걸려서, 따로 틀어야 할 이동이 한 덩어리로 묶인다.
const TRIO_BOSS = [/^bbg008/i];

function findTrios(clips, bossKey) {
  if (!TRIO_BOSS.some(re => re.test(bossKey || ''))) return [];
  const byName = new Map(clips.map(c => [c.name, c]));
  const out = [];
  clips.forEach(c => {
    // "..._left_take2" 와 "..._leftfire_02" 두 꼴이 다 있다.
    // 가운데 짝은 left 를 뺀 이름(appearance_take2 / skill_fire_02)이다.
    const m = (c.name || '').match(/^(.*)_left(_?)(.*)$/i);
    if (!m) return;
    const center = byName.get(m[1] + '_' + m[3]);
    const right = byName.get(m[1] + '_right' + m[2] + m[3]);
    if (center && right) out.push({ center, left: c, right });
  });
  return out;
}

// 이름 끝에 붙은 페이즈 태그를 뗀다. "xbg003_idle_1phase" -> "xbg003_idle"
// 대기 동작인지, 반복하는 클립인지 같은 판정은 이 꼬리표를 떼고 봐야 맞는다.
function stripPhaseTail(name) {
  return String(name || '').replace(/_\d+phase$/i, '');
}

// 이름에 페이즈 태그가 없는데도 한쪽 페이즈에서만 나오는 연출.
// 온리 원은 1페이즈로 등장해서 2페이즈에서 죽는다.
// 목록에 낼지 말지만 여기서 가른다 — 자세·카메라 계산은 건드리지 않는다.
const CLIP_PHASE_OVERRIDES = [
  // 온리 원·미러 컨테이너 - 1페이즈로 등장해서 2페이즈에서 죽는다
  // 묶음은 **첫 단계 클립의 이름**으로 페이즈를 가린다(묶음 키가 아니다).
  // 그래서 온리 원 등장 묶음은 take01 을 적어야 한다 - 안 적으면 페이즈 태그가
  // 없는 이름이라 1·2페이즈 양쪽에 다 나온다.
  { re: /_(appearance(_take\d+)?|take01)$/i, boss: /^(xbg003|xba001)/i, phase: '1' },
  { re: /_death$/i, boss: /^(xbg003|xba001)/i, phase: '2' },
  // 미러 컨테이너 포신 사격은 1페이즈 파츠를 쓴다
  { re: /_shot_(?:start|fire|end)_[lr]\d+_\d+$/i, boss: /^xba001/i, phase: '1' },
  // 베히모스는 3페이즈에서 죽는다
  { re: /_dead(_\d+|_all)?$/i, boss: /^mbg003/i, phase: '3' },
  // 에고비스타 - 1페이즈로 등장해서 2페이즈에서 죽는다. 전환 연출은 넘어간 쪽에 둔다.
  { re: /_appearance$/i, boss: /^xbg005/i, phase: '1' },
  { re: /_death$/i, boss: /^xbg005/i, phase: '2' },
  // 전환 연출은 넘어가기 전 페이즈에 둔다 — 1페이즈에서 눌러 2페이즈로 간다.
  { re: /_phase_change$/i, boss: /^xbg005/i, phase: '1' },
  // 애니힐리오 - 전환 연출 두 개(12phase_appeanrance, xbga03_2phase_appearance)를
  // 2페이즈 쪽에 모은다. 이어지는 한 연출이라 흩어 놓으면 순서를 알기 어렵다.
  // 1페이즈에는 등장과 대기만 남는다. 자동 전환은 쓰지 않는다 —
  // 전환 연출이 2페이즈 목록에 있으니 거기서 순서대로 보면 된다.
  { re: /_12phase_appeanrance$/i, boss: /^xba003/i, phase: '2' },
  // 그레이브 디거 - 등장은 1페이즈에서, 사망은 3페이즈에서만 나온다.
  { re: /^mbg002_appearance$/i, boss: /^mbg002/i, phase: '1' },
  { re: /^mbg002_dead$/i, boss: /^mbg002/i, phase: '3' },
  // 리버렐리오 바디 - 전환 연출도 넘어가기 전 페이즈에 둔다.
  { re: /^eba002_2phase_intro_01$/i, boss: /^eba002/i, phase: '1' },
  // 아일랜드 이터 - 2페이즈 등장은 1->2 전환 연출이라 넘어가기 전 페이즈에 둔다.
  { re: /_phase002_appearance$/i, boss: /^ebg001_island/i, phase: '1' },
  // 이름에 페이즈가 안 붙은 이동·스킬은 2페이즈 것이다.
  { re: /_move_/i, boss: /^ebg001_island/i, phase: '2' },
  { re: /_skill_(?:start|loop|fire)_0[1235]$/i, boss: /^ebg001_island/i, phase: '2' },
  { re: /_dead$/i, boss: /^ebg001_island/i, phase: '2' },
];

// 원래 페이즈 말고 다른 페이즈 목록에도 같이 내는 클립.
// 그레이브 디거는 2페이즈 skill_01 을 1페이즈에서도 쓴다.
const CLIP_EXTRA_PHASE = [
  { boss: /^mbg002/i, re: /^mbg002_phase002_skill_01(_|$)/i, phase: '1' },
];

function clipExtraPhase(bossKey, name, phase) {
  return CLIP_EXTRA_PHASE.some(
    o => o.boss.test(bossKey || '') && o.re.test(name || '') && o.phase === String(phase));
}

function clipPhaseOverride(bossKey, name) {
  const o = CLIP_PHASE_OVERRIDES.find(
    x => x.boss.test(bossKey || '') && x.re.test(name || ''));
  return o ? o.phase : null;
}

// 이름에 붙은 페이즈 번호. 표기가 보스마다 다르다.
//   xbg005_2phase_idle_01      -> 2   (숫자가 앞)
//   ebg001_phase001_idle       -> 1   (숫자가 뒤, 자리수 채움)
//   xbg005_phase1_feather      -> 1
// 앞뒤로 밑줄(또는 끝)을 요구해서 xba003_12phase_appeanrance 처럼 두 페이즈를
// 잇는 연출이 "12페이즈" 로 잡히지 않게 한다 — 그건 페이즈가 없는 클립이다.
const PHASE_TAG_RE = /(?:^|_)(\d)phase(?:_|$)|(?:^|_)phase0*(\d+)(?:_|$)/i;

function phaseTag(name) {
  const m = (name || '').match(PHASE_TAG_RE);
  if (!m) return null;
  return String(parseInt(m[1] || m[2], 10));
}

function clipPhase(name) {
  return phaseTag(name);
}

// 페이즈 전환 클립. 에고비스타는 페이즈가 파일로 갈리지 않고 한 모델 안에서
// 깃털 본의 스케일로 갈린다 — phase_change 가 phase1_feather 를 1.0 -> 0.03 으로 줄이고
// phase2_feather 를 0.08 -> 1.0 으로 키운다. idle 클립 자체에는 그 스케일이 없어서,
// 포즈를 초기화한 상태에서 2페이즈 클립만 틀면 1페이즈 깃털이 그대로 남는다.
// 그래서 다른 페이즈로 넘어갈 때는 이 클립을 먼저 한 번 재생한다.
function findPhaseChangeClip(clips) {
  return clips.find(c => /phase_?change/i.test(c.name || ''))
    // 프로비던스처럼 클립 이름이 그냥 "xbg002_2phase" 인 보스도 있다.
    // 뒤에 아무것도 안 붙은 페이즈 이름은 그 페이즈로 넘어가는 연출로 본다.
    || clips.find(c => /^[a-z]{2,4}\d{3}_\d+phase$/i.test(c.name || ''))
    || null;
}

// 목록에 내지 않는 클립. 파일에는 있지만 보여 줄 게 없는 연출이다.
//   미러 컨테이너 appearance_take1 은 3.17초 내내 보스가 폭 0.11 로 접혀 있어
//   화면에 점으로만 찍힌다. 게임에서는 이펙트가 그 자리를 채우는데 그건 내보내기에 없다.
const HIDDEN_CLIPS = [
  { boss: /^xba001/i, re: /_appearance_take1$/i },
  // 사치스러운 거미 idle_02 는 0.03초짜리라 볼 게 없다.
  { boss: /^bbg001_rich/i, re: /^bbg001_idle_02$/i },
  // 스톰브링어 idle_2 도 0.03초짜리다.
  { boss: /^eba001/i, re: /^eba001_idle_2$/i },
  { boss: /^eba001/i, re: /^eba001_shot_/i },
  // 그레이브 디거 phase003_idle_empty 는 0.17초짜리다.
  { boss: /^mbg002/i, re: /^mbg002_phase003_idle_empty$/i },
  { boss: /^mbg002/i, re: /^mbg002_phase001_shot_/i },
  // 2.5페이즈 대기·전환은 목록에서 뺀다.
  { boss: /^mbg002/i, re: /^mbg002_phase0025_(idle|destroy)$/i },
  // 사망이 파일에 두 벌 들어 있는데, 앞 5초가 같고 마지막 1초 남짓만 다르다.
  // 눈으로는 구분이 안 돼서 뒤엣것은 목록에서 뺀다.
  { boss: /^bbg001_rich/i, re: /^bbg001_dead_01_2$/i },
  { boss: /^bbg001_rich/i, re: /^bbg001_shot_/i },
  { boss: /^ebg001_island/i, re: /^ebg001_phase001_idle2$/i },
  { boss: /^ebg001_island/i, re: /^ebg001_phase003_appearance$/i },
  // 사망이 두 벌 들어 있다(ebg001_dead / ebg001_island_dead, 둘 다 6.67초).
  // 연출 카메라(ebg001_dead_scene_camera)가 짝으로 가리키는 쪽이 island_dead 라
  // 그쪽만 남긴다. 예전에는 반대로 감춰서, 보이는 dead 에는 카메라가 안 붙었다.
  { boss: /^ebg001_island/i, re: /^ebg001_dead$/i },
  // 리버렐리오 바디 - 위 SIMUL_CLIPS 가 대표 클립과 같이 돌리는 딸림 클립들.
  // 혼자 재생하면 나머지 몸이 가만히 있어서 연출이 반쪽이 된다.
  { boss: /^eba002/i, re: /^eba002_1phase_jelly$/i },
  { boss: /^eba002/i, re: /^eba002_2phase_intro_02$/i },
  { boss: /^eba002/i, re: /^eba002_2phase_intro_03jelly$/i },
  { boss: /^eba002/i, re: /^eba002_2phase_death_jelly$/i },
];

// 앞부분을 잘라내고 쓰는 연출. 게임에서는 그 구간을 이펙트가 채우는데
// 내보내기에는 그게 없어서 볼 게 없는 구간에 쓴다.
//   from - 몇 초부터 쓸지(초). to - 몇 초까지 쓸지(초). 둘 다 선택이다.
const CLIP_TRIM = [
  // 스톰브링어 등장 - 3.5초까지는 보스가 y 12.6 상공에 멈춰 있고
  // 카메라도 안 움직인다(거리 13.0 고정, 화면 높이의 10%).
  { boss: /^eba001/i, re: /^eba001_appearance$/i, from: 3.5 },
  // 사치스러운 거미 사망 - 5.5초부터 카메라가 시체를 뚫고 지나가 딴 데를 본다.
  // 겨냥이 100도를 넘고 화면 점유가 1.6% -> 0.3% 로 떨어져 끝까지 빈 화면이다.
  // 볼 게 없는 1초를 잘라낸다(6.57초 -> 5.5초).
  //
  // 이 보스는 카메라를 두 줄로 따로 적어야 한다. applyClipTrim 은 짝인 카메라를
  // "모델클립이름_camera" 로 찾는데, 여기는 모델이 bbg001_dead_01 이고 카메라가
  // harvester_dead_scene_camera 라 이름이 안 이어진다. 게다가 이 연출은 카메라가
  // 시계라(timelineStart 0 / pairedClipTimelineStart 5.55e-16 로 timeOffset 이
  // 음수) 카메라를 안 자르면 길이가 그대로다.
  { boss: /^bbg001_rich/i, re: /^bbg001_dead_01$/i, to: 5.5 },
  { boss: /^bbg001_rich/i, re: /^harvester_dead_scene$/i, to: 5.5 },
];

// gltf.animations 를 제자리에서 바꿄다. 이름은 그대로 두어서 이름으로 물린 표
// (구역 나누기·카메라 짝짓기·카메라 보정)가 그대로 동작하게 한다.
// 짝인 카메라 클립도 같은 만큼 잘라야 카메라가 그만큼 앞서 가지 않는다.
// 돌려주는 목록은 나중에 잘라낸 지점의 자세를 떠 두는 데 쓴다 — 그 지점
// 이전에만 키가 있는 본이 기본 자세로 튀는 것을 막는다.
function applyClipTrim(clips, bossKey) {
  const done = [];
  CLIP_TRIM.forEach(rule => {
    if (!rule.boss.test(bossKey || '')) return;
    clips.forEach((c, i) => {
      const isCam = /_camera$/i.test(c.name || '');
      const base = isCam ? c.name.replace(/_camera$/i, '') : (c.name || '');
      if (!rule.re.test(base)) return;
      // fps 를 1000 으로 두고 밀리초 단위로 자른다.
      const cut = THREE.AnimationUtils.subclip(
        c, c.name, Math.round((rule.from || 0) * 1000),
        (typeof rule.to === 'number') ? Math.round(rule.to * 1000) : 1e9, 1000);
      if (!cut.tracks.length) return;
      clips[i] = cut;
      if (!isCam) done.push({ name: c.name, src: c, from: rule.from });
    });
  });
  return done;
}

// 한 연출을 몸 여러 벌이 나눠 맡는 보스. 대표 클립을 재생할 때 딸림 클립을
// 같은 믹서에 같이 얹는다.
//
// 검은 뱀(playTrio)과는 경우가 다르다. 그쪽은 같은 몸 하나를 복제해서 좌·우
// 머리를 만드는 것이고, 여기는 서로 다른 리그가 이미 한 파일에 다 들어 있다.
// 복제할 게 없으니 액션만 하나 더 얹으면 된다 - 클립끼리 건드리는 뼈가 하나도
// 안 겹치므로 서로 싸우지 않는다.
//
// 리버렐리오 바디는 몸이 세 벌이다(1페이즈 · 2페이즈 · 해파리). 실측한 길이와
// 대상 리그는 이렇다.
//   1페 등장    8.400초  1phase_intro(1페)      + 1phase_jelly(해파리)
//   페이즈 전환 6.667초  2phase_intro_01(1페)   + 2phase_intro_02(2페)
//                                              + 2phase_intro_03jelly(해파리)
//   사망        3.500초  2phase_death(2페)      + 2phase_death_jelly(해파리)
// 길이가 정확히 같아서 시각을 따로 맞출 필요가 없다.
//
// 대표 클립은 연출 카메라가 붙은 쪽으로 고른다 - 카메라·자동 넘김·목록 표시가
// 전부 대표 클립 이름을 기준으로 돌아간다.
const SIMUL_CLIPS = [
  { boss: /^eba002/i, main: /^eba002_1phase_intro$/i,
    with: [/^eba002_1phase_jelly$/i] },
  { boss: /^eba002/i, main: /^eba002_2phase_intro_01$/i,
    with: [/^eba002_2phase_intro_02$/i, /^eba002_2phase_intro_03jelly$/i] },
  { boss: /^eba002/i, main: /^eba002_2phase_death$/i,
    with: [/^eba002_2phase_death_jelly$/i] },
];

function simulClipsFor(bossKey, name, clips) {
  const o = SIMUL_CLIPS.find(
    x => x.boss.test(bossKey || '') && x.main.test(name || ''));
  if (!o) return null;
  const out = o.with.map(re => (clips || []).find(c => re.test(c.name || '')))
    .filter(Boolean);
  return out.length ? out : null;
}

function isHiddenClip(bossKey, name) {
  if (RAW_MODE) return false;
  return HIDDEN_CLIPS.some(o => o.boss.test(bossKey || '') && o.re.test(name || ''));
}

// 목록 이름을 손으로 바꾸는 자리. 규칙으로 풀면 다른 보스까지 딸려 바뀌는 경우에만 쓴다.
const CLIP_LABEL_FIX = [
  // 짝인 take1 을 목록에서 뺐으니 꼬리표도 뗀다
  { boss: /^xba001/i, re: /_appearance_take2$/i, label: 'appearance' },
  // 짝인 ebg001_dead 를 목록에서 뺐으니 꼬리표도 뗀다
  { boss: /^ebg001_island/i, re: /_island_dead$/i, label: 'dead' },
  // 나머지 스킬은 묶음이라 페이즈 태그가 떨어진다. 낱개인 03 만 남아서 맞춰 준다.
  { boss: /^xba001/i, re: /_1phase_skill_03$/i, label: 'skill_03' },
  { boss: /^xba001/i, re: /_2phase_parts$/i, label: '2phase_parts' },
  { boss: /^mbg003/i, re: /_dead_all$/i, label: 'dead' },
  { boss: /^mbg003/i, re: /_2phase_take$/i, label: '2phase_take2+3' },
  { boss: /^mbg003/i, re: /_1phase_take$/i, label: '1phase_take1+2' },
  { boss: /^xbg003/i, re: /_appearance_all$/i, label: 'take01+appearance' },
  // 사치스러운 거미 - 짝이던 idle_02 / dead_01_2 를 뺐고 cc 는 start·end 가
  // 하나씩뿐이라, 뒤에 붙은 번호가 더는 아무것도 안 가른다.
  { boss: /^bbg001_rich/i, re: /^bbg001_idle_01$/i, label: 'idle' },
  { boss: /^bbg001_rich/i, re: /^bbg001_dead_01$/i, label: 'dead' },
  { boss: /^bbg001_rich/i, re: /^bbg001_cc_start_01$/i, label: 'cc_start' },
  { boss: /^bbg001_rich/i, re: /^bbg001_cc_end_01$/i, label: 'cc_end' },
];

// 연출을 재생하는 동안에만 그 부위 파츠 하나만 남기고 나머지를 감춘다.
// 사용자가 켜 둔 목록은 건드리지 않는다 — 클립이 바뀌면 원래대로 돌아온다.
//   미러 컨테이너 포신 사격은 좌우 3문 중 그 한 문만 나온다.
const CLIP_SOLO_PARTS = [
  {
    boss: /^xba001/i,
    clip: /_shot_(?:start|fire|end)_([lr])(\d)_\d+$/i,
    group: /_1phase_parts_[lr]\d+_skin/i,
    keep: m => new RegExp('_1phase_parts_' + m[1] + '0' + m[2] + '_skin', 'i'),
  },
  // 베히모스 jump_end 는 원본 데이터에서 포탑 본(l/r_catpult_01)만 바인드 자세를
  // 크게 벗어나, 그 본에 물린 정점이 바닥을 뚫는 바늘로 늘어난다. 압축 전 원본에서도
  // 같은 값이 나온다. 그 클립에서만 포탑을 감춘다.
  { boss: /^mbg003/i, clip: /_2phase_jump_end$/i, hide: /_catpult_skin/i },
  // 사치스러운 거미 알집은 rich_skill01 에서만 배에 붙어 움직인다. 다른 클립에는
  // 알집 본을 건드리는 트랙이 아예 없어서 원점에 못 박힌 채 남고, 몸이 그만큼
  // 멀어지면(등장 2.12, skill_fire_02 0.62 - 몸통 지름이 0.69다) 허공에 뜬다.
  // 그래서 평소에는 끄고(DEFAULT_OFF_MESHES) 이 클립에서만 되살린다.
  //
  // rich_skill02 는 트랙이 있긴 한데 여덟 덩어리를 바닥에 일직선으로 늘어놓는다.
  // x 간격이 0.112/0.111/0.112/0.111/0.112/0.111/0.112 로 완벽하게 균등하고 y·z
  // 도 번호에 따라 선형으로만 변한다 — 손으로 잡은 자세가 아니다. 반면 skill01
  // 은 배 주위에 불규칙하게 흩어져 있다. 무엇이 맞는지는 파일이 말해주지 않으니
  // 지어내지 않고 skill02 에서는 감춘다.
  { boss: /^bbg001_rich/i, clip: /_rich_skill01_/i, show: /_egg_skin$/i },
  // 페이즈 전환 연출은 그동안 양쪽 페이즈 파츠가 다 켜져 있어야 한다. 파츠가
  // 중간에 생기거나 사라지는 게 아니라, 처음부터 켜진 채로 안 보이는 곳에
  // 숨어 있다 나오거나 화면 밖으로 빠지는 연출이기 때문이다.
  // 에고비스타 phase_change 에서 1·2페이즈 깃털 조인트 28개가 전부 트랙을 갖는 것이
  // 그 증거다 — 갈아 끼울 대상이 아니다.
  // 리버렐리오 바디 - 페이즈 전환은 1·2페이즈 몸이 같이 나온다. 페이즈 방식이
  // exclusive 라 그냥 두면 2페이즈 목록에서 1페이즈 몸이 숨겨진다.
  { boss: /^eba002/i, clip: /^eba002_2phase_intro_01$/i, show: /./ },
  { boss: /^xbg005/i, clip: /_phase_change$/i, show: /./ },
  { boss: /^ebg001_island/i, clip: /_phase002_appearance$/i, show: /./ },
  // 애니힐리오도 같다. 앞 컷(12phase_appeanrance)은 1페이즈 본만 움직이는데
  // 2페이즈 목록에 두었더니 1페이즈 몸이 통째로 숨어 화면이 비었다.
  // 마녀의 까마귀 다섯은 전환 연출 내내 꺼져 있다.
  { boss: /^xba003/i, clip: /_12phase_appeanrance$/i, show: /./, hide: /_turret\d+(_\d+)?$/i },
  { boss: /^xba003/i, clip: /^xbga03_2phase_appearance$/i, show: /./, hide: /_turret\d+(_\d+)?$/i },
  // 온리 원 소환수 셋. 애니메이션 클립에는 켜고 끄는 커브가 없다 - 클립
  // 바인딩 1141개가 전부 Transform(위치·회전·크기)이다. 대신 루트 뼈의
  // 크기로 접었다 편다. 0.10 이 접힌 상태, 0.60~1.00 이 나온 상태다.
  // 그래서 크기가 0.10 이 아닌 클립에서만 켠다.
  //   skill_ziz_?phase_*_03       하늘 0.19~0.70
  //   skill_behemoth_?phase_*_03  땅 0.60
  //   skill_leviathan_?phase_*_03 바다 0.60
  //   take01                      하늘 1.00 -> 0.20  (meshActivation 이 켠다)
  //   death                       하늘 0.10->0.70 · 땅 0.72 · 바다 0.10->1.00
  //   그 밖의 클립 전부           셋 다 0.10
  // 켜 둔 클립 안에서 나타나고 사라지는 타이밍은 그 크기 곡선이 알아서 낸다.
  //
  // 사망만 여기 안 적는다. 소환수는 패턴마다 불려 나오고 각자 체력이 있는데,
  // 패턴 도중에 보스가 먼저 죽으면 그때 나와 있던 놈이 같이 스러진다.
  // 무엇이 나와 있을지가 전투 상황에 달렸으니 파일로 정해지지 않는다.
  // 사망 클립은 그 경우를 다 커버하려고 셋을 전부 움직여 둔다 - 뼈 트랙이
  // 하늘 24 · 땅 4 · 바다 8 개나 실제로 움직인다(대기 클립은 0 개다).
  // 사망 타임라인에 소환수를 켜는 ActivationTrack 이 없는 것도 같은 이유다 -
  // 이미 나와 있는 것을 켤 이유가 없다.
  // 그래서 기본은 꺼 두고, 파츠 패널에서 켜면 그대로 따라 움직이게 둔다.
  // 온리 원 take01 - 인간형(rp_skin)을 감춘다. 이건 파일이 시킨 게 아니다.
  // 등장 타임라인(xbg003_appearance_model)의 ActivationTrack 일곱 개를 전부
  // 풀어 봤는데 rp_skin 을 묶은 트랙이 아예 없다 - 프리팹 상태(켜짐) 그대로다.
  // 인게임에서 안 보이는 건 물 아래에 잠겨 있어서다. 뷰어에는 물이 없어서
  // 그대로 드러나므로 여기서 감춘다.
  { boss: /^xbg003/i, clip: /_take01$/i, hide: /_rp_skin(_\d+)?$/i },
  { boss: /^xbg003/i, clip: /_skill_ziz_\dphase_/i,
    show: /_ziz_skin(_\d+)?$/i },
  { boss: /^xbg003/i, clip: /_skill_behemoth_\dphase_/i,
    show: /_behamoth_skin(_\d+)?$/i },
  { boss: /^xbg003/i, clip: /_skill_leviathan_\dphase_/i,
    show: /_leviathan_skin(_\d+)?$/i },
];

// 연출 중에만 모델을 돌린다. 등장·사망만 보스가 반대로 서 있는 경우를 위한 것.
// 카메라를 반대편으로 옮기는 것(CAMERA_FIX.idleFlip)과 달리 거리·담김 계산이
// 안 어긋난다. 조작 패널의 표시값은 건드리지 않는다 — 기준 180도 그대로 보인다.
// 에고비스타로 재보니 뒷모습의 원인은 모델이 아니라 idleFlip 이었다(그건 걷어냈다).
// 지금은 해당되는 보스가 없다.
const CLIP_MODEL_YAW = [];

function clipModelYawFor(bossKey, name) {
  const o = CLIP_MODEL_YAW.find(
    x => x.boss.test(bossKey || '') && x.clip.test(name || ''));
  return o ? o.yaw : null;
}

// 연출 중에만 켜지는 발광 파츠. 좌우 한 쌍이 한 세트고, 그중 count 개를 무작위로 고른다.
// 색은 GLOW_PRESETS 의 key.
//   프로비던스: 스킬 01 은 오른팔 하나 노랑, 03 은 팔·다리 중 한 세트 파랑,
//               04 는 팔·다리·어깨 중 두 세트 보라.
// 전환 연출 도중에 파츠가 통째로 갈리는 보스. at(초) 전에는 from 만, 뒤에는 to 만
// 보인다. 리그가 알아서 바꿔주지 않는다 — 에고비스타 phase_change 를 재보면
// 1.5초를 경계로 phase1_feather 가 1.16 x 0.52 에서 0.58 x 0.05 로 납작하게
// 접히고, phase2_feather 가 0.03 짜리 점에서 0.41 x 0.38 로 펴진다. 둘 다 켜두면
// 접힌 깃털이 선으로, 안 펴진 깃털이 점으로 남는다.
const CLIP_GLOW_PARTS = [
  { boss: /^xbg002/i, clip: /_skill_(?:start|loop)_01$/i, color: 'yellow', count: 1,
    sets: [/_arm_r_skin_1$/i] },
  { boss: /^xbg002/i, clip: /_skill_(?:start|loop)_03$/i, color: 'blue', count: 1,
    sets: [/_arm_[lr]_skin_1$/i, /_legs_[lr]_skin001_1$/i] },
  { boss: /^xbg002/i, clip: /_skill_(?:start|loop)_04$/i, color: 'purple', count: 2,
    sets: [/_arm_[lr]_skin_1$/i, /_legs_[lr]_skin001_1$/i, /_shoulder_[lr]_skin_1$/i] },
  // 앨트루이아 — 파츠가 늘 보이는 대신 이 스킬 동안만 빛난다.
  //   02 는 성녀의 후광 아홉, 04 는 두 눈. 무작위 고름 없이 그 세트를 그대로 쓴다.
  { boss: /^xbg004/i, clip: /_skill_(?:start|loop)_02$/i, color: 'blue', count: 1,
    sets: [/_helm_\d+_skin_1$/i] },
  { boss: /^xbg004/i, clip: /_skill_(?:start|loop)_04$/i, color: 'blue', count: 1,
    sets: [/_sdf_eye_[lr]_skin_1$/i] },
];

function clipGlowRuleFor(bossKey, name) {
  return CLIP_GLOW_PARTS.find(
    o => o.boss.test(bossKey || '') && o.clip.test(name || '')) || null;
}

function clipSoloPartsFor(bossKey, name) {
  for (const o of CLIP_SOLO_PARTS) {
    if (!o.boss.test(bossKey || '')) continue;
    const m = (name || '').match(o.clip);
    if (!m) continue;
    // show 와 hide 를 같이 적을 수 있다 — "전부 켜되 이것만 빼고" 를 쓰려면
    // 둘을 같이 넘겨야 한다. 예전에는 show 만 있으면 hide 를 버리고 돌려줬다.
    if (o.show || o.hide) return { show: o.show || null, hide: o.hide || null };
    return { group: o.group, keep: o.keep(m) };
  }
  return null;
}

// 페이즈 전환 연출. 애니메이션 목록에서 "페이즈 전환" 구역으로 따로 뺀다 —
// 다른 동작과 성격이 달라서 기본 구역에 섞여 있으면 찾기 어렵다.
// 이름 규칙이 보스마다 제각각이라(온리 원 2phase_change / 애니힐리오 12phase_appeanrance
// - 원본 철자 그대로다 / 프로비던스 그냥 2phase) 보스별로 적어 둔다.
// 보스 코드로 가르지 않는다 — 애니힐리오는 메쉬(xbga03)와 클립(xba003)의 접두사가
// 서로 달라서, 메쉬에서 뽑은 보스 코드로 거르면 하나도 안 걸린다.
const PHASE_SWITCH_CLIPS = [
  /(^|_)2phase_change$/i,          // 온리 원
  /(^|_)phase_change$/i,           // 에고비스타
  // 애니힐리오 - 1페이즈 파일의 12phase_appeanrance 로 시작해서 2페이즈 파일의
  // xbga03_2phase_appearance 로 이어진다. 둘 다 원본 철자 그대로다
  // (12phase_appeanrance / xbga03 = xba003 오타).
  /(^|_)12phase_appeanrance$/i,
  /^xbga03_2phase_appearance$/i,
  // 아일랜드 이터 - 이름은 등장이지만 1 -> 2페이즈 전환 연출이다.
  // 진짜 등장은 phase001_appearance 쪽이다.
  /^ebg001_phase002_appearance$/i,
  /^[a-z]{2,4}\d{3}_\d+phase$/i,   // 프로비던스 - 뒤에 아무것도 안 붙은 페이즈 이름
  // 베히모스 - 1 -> 2페이즈 전환이 세 클립으로 이어진다. 앞 하나가 1페이즈 파일에,
  // 뒤 둘이 2페이즈 파일에 들어 있어서 파일을 넘어 잇지는 못한다.
  /^mbg003_2phase_b1_take1_a$/i,
  /^mbg003_2phase_take[23]?$/i,   // 낱개 두 컷과 그 둘을 묶은 키까지
  /^mbg003_3phase_intro$/i,       // 2 -> 3페이즈 전환
  /^mbg002_phase001_destroy$/i,   // 그레이브 디거 1 -> 2페이즈
  /^mbg002_phase002_destroy$/i,   // 그레이브 디거 2 -> 3페이즈
];

// 이름에 appearance 가 안 들어가는 등장 연출. "등장·사망" 구역으로 보낸다.
//   베히모스 1페이즈는 take1(부품이 날아옴) + take2(조립 완료)가 이어진 등장이다.
const APPEARANCE_CLIPS = [
  /^mbg003_1phase_take[12]?$/i,
];

function isAppearanceClip(name) {
  return APPEARANCE_CLIPS.some(re => re.test(name || ''));
}

// 페이즈 전환 연출이 끝나면 다음 페이즈 모델로 넘어가서 그쪽 전환 연출을 이어 트는
// 기능. 이렇게 이어지는 보스가 드물어서 대상을 지정한 보스에만 켠다.
//   베히모스: 1페이즈 2phase_b1_take1_a -> 2페이즈 2phase_take2+3
//   에고비스타: 1페이즈 phase_change -> 2페이즈
//   아일랜드 이터: 1페이즈 phase002_appearance -> 2페이즈
//   그레이브 디거: 1페이즈 phase001_destroy -> 2, 2페이즈 phase002_destroy -> 3
// from - 토글을 낼 페이즈. 여럿이면 배열로 적는다.
// by - 페이즈를 무엇으로 넘기는가. 베히모스는 페이즈마다 모델 항목이 따로라
// 모델 칩을 넘기고, 에고비스타는 한 모델 안이라 페이즈 칩을 넘긴다.
const AUTO_PHASE_CHAIN = [
  { boss: /^mbg003/i, from: '1', by: 'model' },
  { boss: /^xbg005/i, from: '1', by: 'phase' },
  { boss: /^ebg001_island/i, from: '1', by: 'phase' },
  { boss: /^mbg002/i, from: ['1', '2'], by: 'phase' },
];
// 켬/끔은 모델을 바꿔 다시 불러도 유지돼야 한다 — 모듈 스코프에 둔다.
let autoPhaseChain = false;
// 다음 모델을 불러오면 그쪽 전환 연출을 바로 틀라는 표시.
let autoPhasePending = false;

function isPhaseSwitchClip(name) {
  return PHASE_SWITCH_CLIPS.some(re => re.test(name || ''));
}

// idle / loop 만 반복하고 나머지는 한 번만 재생한 뒤 idle 로 돌아간다.
// 등장·사망 연출은 리그를 딴 곳에 놓고 시작해서, 반복시키면 끝나는 순간 순간이동한다.
function isOneShot(name) {
  return !/(^|_)(idle|loop)(_\d+)?$/i.test(stripPhaseTail(name));
}

// ── 테마 따라가기 ──────────────────────────────────────────────
// 뷰어 배경은 three.js 가 색 값을 복사해 들고 있어서, 테마를 바꿔도 CSS 변수만
// 바뀌고 화면은 그대로다. 다시 불러올 필요는 없다 — 살아 있는 뷰어를 모아 두고
// 색만 갈아 끼운다.
const liveStates = new Set();

// 솔로 레이드 탭을 벗어나면 뷰어를 재우고, 돌아오면 깨운다.
document.addEventListener('mmr:tab-change', ev => {
  const on = !!(ev.detail && ev.detail.tab === 'frames');
  liveStates.forEach(st => { st.offscreen = !on; });
});

function panelColor() {
  return getComputedStyle(document.body).getPropertyValue('--bg-panel').trim();
}

function applyThemeBackground(st) {
  // 배경을 안 칠하는(투명) 뷰어는 CSS 가 알아서 따라가므로 건드리지 않는다.
  if (!st || !st.scene || !st.scene.background) return;
  const panel = panelColor();
  if (!panel) return;
  try { st.scene.background.set(panel); } catch (e) { /* 색 파싱 실패는 무시 */ }
}

let themeWatcher = null;

function watchTheme() {
  if (themeWatcher) return;
  themeWatcher = new MutationObserver(() => liveStates.forEach(applyThemeBackground));
  themeWatcher.observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] });
}

function disposeState(container) {
  const state = container.__framesModel3D;
  if (!state) return;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  if (state.resizeObserver) state.resizeObserver.disconnect();
  if (state.controls) state.controls.dispose();

  // 다음 로드가 새로 연결하기 전까지, 이전(디스포즈된) 인스턴스를 가리키는
  // 핸들러가 남아있으면 클릭 시 에러가 나므로 항상 비워둔다.
  const resetBtn = document.getElementById('frames-spine-reset');
  if (resetBtn) resetBtn.onclick = null;
  const pauseBtn = document.getElementById('frames-spine-pause');
  if (pauseBtn) {
    pauseBtn.onclick = null;
    pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
  }
  const phaseToggleEl = document.getElementById('frames-phase-toggle');
  if (phaseToggleEl) {
    phaseToggleEl.innerHTML = '';
    phaseToggleEl.classList.add('hidden');
  }
  ['frames-anim-toggle'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
  });
  const barEl = document.getElementById('frames-playbar');
  if (barEl) barEl.classList.add('hidden');
  const restartBtn = document.getElementById('frames-spine-restart');
  if (restartBtn) restartBtn.onclick = null;

  if (state.renderer) {
    state.renderer.dispose();
    if (state.renderer.domElement && state.renderer.domElement.parentNode === container) {
      container.removeChild(state.renderer.domElement);
    }
  }
  if (state.scene) {
    state.scene.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => {
          Object.keys(m).forEach(key => {
            const val = m[key];
            if (val && val.isTexture) val.dispose();
          });
          m.dispose();
        });
      }
    });
  }
  liveStates.delete(state);
  container.__framesModel3D = null;
}

window.disposeFramesModel3D = disposeState;

// ── 불러오기 진행 막대 ─────────────────────────────────────────
// 보스를 고르면 큰 파일을 내려받는 동안 무대가 한참 비어 있다. 무슨 일이 일어나는지
// 보이도록 가운데에 막대를 띄운다. 내려받기가 끝나도 압축 해제(Draco)와 텍스처
// 올리기가 남아 있는데 그 구간은 길이를 알 수 없어서, 줄무늬가 흐르는 형태로 바꾼다.
// 보스를 연달아 누르면 앞 요청이 나중에 끝날 수 있어, 표를 든 쪽만 막대를 만진다.
let loadSeq = 0;

function setLoadingBar(seq, pct, sub) {
  if (seq !== loadSeq) return;
  // 페이즈 자동 전환으로 넘어오는 길에는 막대를 띄우지 않는다. 연출이 이어져야
  // 하는데 중간에 로딩 화면이 끼면 흐름이 끊긴다. 앞 페이즈 화면이 그대로
  // 남아 있다가 다음 모델로 바뀐다.
  if (autoPhasePending) return;
  const box = document.getElementById('f3d-loading');
  if (!box) return;
  box.classList.remove('hidden');
  box.classList.toggle('indeterminate', pct === null);
  const fill = box.querySelector('.f3d-loading-fill');
  if (fill && pct !== null) fill.style.width = pct + '%';
  const el = box.querySelector('.f3d-loading-sub');
  if (el) el.textContent = sub || '';
}

function hideLoadingBar(seq) {
  if (seq !== loadSeq) return;
  const box = document.getElementById('f3d-loading');
  if (box) box.classList.add('hidden');
}

const MB = 1024 * 1024;

window.loadFramesModel3D = function loadFramesModel3D(container, modelUrl, options = {}) {
  const { onError, onLoaded } = options;

  disposeState(container);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    console.error('[역대 테두리 3D] WebGL 렌더러 생성 실패:', err);
    if (onError) onError(err);
    return;
  }

  const width = container.clientWidth || 300;
  const height = container.clientHeight || 300;
  renderer.setSize(width, height);

  // 서랍을 여닫으면 무대 폭이 바뀌는데, 캔버스는 로드 시점 크기로 고정돼 있어서
  // 옆 칸(사이드바·서랍)을 덮어버렸다. 컨테이너를 지켜보다 같이 줄이고 늘린다.
  const resizeObserver = new ResizeObserver(() => {
    const st = container.__framesModel3D;
    if (!st || st.renderer !== renderer) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    // 세 번째 인자를 false 로 두면 CSS 크기를 안 고쳐서, 버퍼만 줄고 화면에서는
    // 예전 폭 그대로 남아 옆 칸을 덮는다. 기본값(true)으로 둬야 한다.
    renderer.setSize(w, h);
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w, h);
    st.camera.aspect = w / h;
    st.camera.updateProjectionMatrix();
  });
  resizeObserver.observe(container);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100);

  // 조명 세기.
  // 예전에 ambient를 크게 올렸다가 검은 보스가 회색으로 떠서 뿌옇게 보였던 적이 있어
  // ambient를 0.4까지 낮췄는데, 이번엔 전체가 너무 어두워졌다. 흰색이어야 할 백빙룡의
  // 화면 평균 밝기가 255 중 71밖에 안 됐다.
  // 그래서 ambient는 낮게 유지한 채(검정을 검정으로 두려고) 방향광만 크게 올린다.
  // 이 값에서 백빙룡 71 → 109, 검은 뱀 29 → 47 로 올라가고, 흰색이 날아가는 픽셀은
  // 1% 미만이라 하이라이트도 뭉개지지 않는다.
  // 조명은 모델을 읽은 뒤 종류에 맞게 세운다(setupLights).
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  const dirLight = new THREE.DirectionalLight(0xffffff, 4.0);
  dirLight.position.set(1, 2, 1);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 1.6);
  dirLight2.position.set(-1, 0.5, -1);
  scene.add(ambientLight, dirLight, dirLight2);

  // 위 숫자들은 구형(FBX 변환) 모델을 눈으로 맞춰 가며 올린 값이다 — 그 모델들은
  // 재질이 뿌옇게 나와서 방향광을 세게 줘야 형태가 보였다. 신형은 텍스처와 발광이
  // 제대로 들어오므로 그 보정이 오히려 과하다. 중립적인 값으로 되돌린다.
  function setupLights(isCatalogExport) {
    if (!isCatalogExport) return;
    ambientLight.intensity = 1.0;
    dirLight.intensity = 1.4;
    dirLight2.intensity = 0.6;
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // 후처리 사슬. 신형 추출본에서만 쓴다 — 구형은 발광이 없어서 걸어봐야 손해다.
  let composer = null;
  let bloomPass = null;

  function setupPostFx(enable) {
    if (!enable) return;
    // 톤매핑 없이 그대로 그리면 밝은 값이 255 에서 잘려 색이 날아간다.
    // ACES 는 중간톤을 눌러서 그냥 켜면 어두워진다 — 노출로 되돌린다.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 2.0;

    // 후처리를 태우면 알파가 사라져 캔버스가 불투명해진다. 투명 배경을 유지하려고
    // 애쓰는 것보다, 뷰어 판 색을 그대로 칠하는 편이 낫다(테마도 따라간다).
    const panel = panelColor();
    if (panel) {
      try { scene.background = new THREE.Color(panel); } catch (e) { /* 색 파싱 실패는 무시 */ }
    }

    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth || 300, container.clientHeight || 300),
      BLOOM.strength, BLOOM.radius, BLOOM.threshold
    );
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }

  const state = { renderer, scene, camera, controls, rafId: null, paused: false, resizeObserver };
  container.__framesModel3D = state;
  liveStates.add(state);
  watchTheme();

  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  const mySeq = ++loadSeq;
  setLoadingBar(mySeq, 0, '');

  let mixer = null;
  const clock = new THREE.Clock();
  // 홈(시점 초기화로 돌아갈 자리)과 추적 기준을 따로 둔다.
  // 예전에는 하나로 썼는데, 팬을 할 때마다 추적 기준을 새로 잡느라 홈까지 같이
  // 옮겨져서 "시점 초기화" 가 팬한 자리로 돌아왔다.
  let homeCamPos = null;
  let homeTarget = null;
  let initialTarget = null;

  loader.load(modelUrl, (gltf) => {
    if (container.__framesModel3D !== state) return; // 그 사이 다른 보스로 전환됨

    const meshNamesForBossCode = [];
    gltf.scene.traverse(o => { if (o.isMesh) meshNamesForBossCode.push(o.name); });
    dedupeClipNames(gltf.animations || []);
    const bossCode = detectBossCode(meshNamesForBossCode, modelUrl);
    // 규칙 표는 파일 이름까지 본다(변종 보스 구분). 표 안 쓰는 쪽(파츠 이름 자르기,
    // 코드로 찾는 표)은 그대로 bossCode 를 쓴다.
    const bossKey = bossKeyFrom(bossCode, modelUrl);
    // 이름으로 물린 표가 전부 이 뒤에 오므로 여기서 잘라 둔다.
    const trimmedClips = RAW_MODE ? [] : applyClipTrim(gltf.animations || [], bossKey);

    // 신형(카탈로그에서 직접 뽑은) 추출본은 기존 FBX 변환본과 규칙이 다르다.
    //  - 루트 노드에 방향 회전이 이미 들어 있다 (공통 225도 보정을 주면 안 된다)
    //  - 페이즈가 파일 단위로 나뉜다 (메쉬 이름으로 페이즈를 거르면 안 된다 —
    //    애니힐리오 2페이즈 파일의 xba003_1phase_magiccarpet_skin 은 이름과 달리
    //    root_phase2 아래에 달린 2페이즈 현역 파츠다)
    //  - 등장·사망 클립이 리그를 통째로 딴 곳으로 옮긴다 (카메라가 따라가야 한다)
    //
    // 판별은 씬 루트에 "*_var" 래퍼 노드가 있는지로 한다. 신형은 모델 전체가 그 노드
    // 하나에 담겨 나오고, 기존 변환본은 루트가 전부 "*_skin" 이라 겹치지 않는다.
    // asset.generator 로 보면 안 된다 — Draco 압축을 한 번 태우면 그 값이 변환 도구
    // 이름으로 덮어써져서(기존 모델도 전부 'glTF-Transform') 구분이 사라진다.
    // 노드 이름은 압축을 거쳐도 그대로 남는다.
    const isCatalogExport =
      gltf.scene.children.some(o => /_var$/i.test(o.name || ''))
      || /NikkeCatalogExplorer/i.test((gltf.asset && gltf.asset.generator) || '');

    // FBX 원본이 항상 정면 기준으로 돌아간 상태로 나온다 —
    // FBX2glTF 변환 시 좌표축 관례(Maya 등)와 우리가 카메라를 세팅하는 기준이 어긋나는 것으로
    // 보인다. 기본은 대부분 보스에 맞는 공통값(좌우 225도)이고, 안 맞는 보스는
    // BOSS_TRANSFORM_OVERRIDES에 개별 등록한다.
    //
    // 좌우(yaw)/상하(pitch)를 같은 Object3D의 rotation.x/y에 그대로 넣으면 오일러 회전
    // 순서(XYZ) 때문에 서로 얽혀서, 좌우를 크게 돌려놓은 상태에서 상하를 조정하면 화면에서는
    // 대각선/옆으로 도는 것처럼 보인다. 그래서 바깥쪽 그룹에서 좌우 회전 + 전체 위치/크기를,
    // 안쪽 그룹에서 상하/롤 회전만 담당하게 분리해서 서로 영향을 주지 않게 한다.
    const yawGroup = new THREE.Group();
    const pitchGroup = new THREE.Group();
    // normGroup: 신형 추출본을 "원점 중심 · 발이 바닥(y=0) · 최대변 1" 로 맞춘다.
    // 이렇게 해두면 보스마다 원본 단위가 제각각이어도 카메라를 똑같이 정면에 둘 수 있다.
    const normGroup = new THREE.Group();
    normGroup.add(gltf.scene);
    pitchGroup.add(normGroup);
    yawGroup.add(pitchGroup);
    scene.add(yawGroup);

    setupLights(isCatalogExport);
    setupPostFx(isCatalogExport);

    // 모델 고르는 칩 이름이 가리키는 페이즈. 같은 파일을 항목 둘로 등록해 쓰는 보스가
    // 있어서, 보정도 항목별로 달리 줘야 하는 경우가 있다.
    const optLabelPhase = (String(options.modelLabel || '').match(/(\d+)\s*페이즈/) || [])[1] || null;
    // 자동 페이즈 넘김을 낼지. 넘길 곳이 있는 페이즈에서만 낸다.
    const autoPhaseRule = AUTO_PHASE_CHAIN.find(o => o.boss.test(bossKey || '')) || null;
    function autoPhaseAvailable() {
      if (!autoPhaseRule) return false;
      const from = [].concat(autoPhaseRule.from);
      return autoPhaseRule.by === 'model'
        ? from.includes(optLabelPhase)
        : from.includes(currentPhase);
    }

    const bossTransform = getBossTransform(bossCode, isCatalogExport);
    const [pitchDeg, yawDeg, rollDeg] = bossTransform.rotation;
    // 맞춰 둔 기준 각도. 슬라이더에는 안 들어가서 패널은 0 에서 출발한다 —
    // 배율·높이를 CATALOG_FIT_BASE 로 옮긴 것과 같은 방식이다.
    const fitBase0 = catalogFitBase(bossKey, bossCode, isCatalogExport, optLabelPhase);
    const basePitch = fitBase0.pitch || 0;
    const baseYaw = fitBase0.yaw || 0;
    yawGroup.rotation.y = THREE.MathUtils.degToRad(yawDeg + baseYaw);
    pitchGroup.rotation.x = THREE.MathUtils.degToRad(pitchDeg + basePitch);
    pitchGroup.rotation.z = THREE.MathUtils.degToRad(rollDeg);
    yawGroup.position.set(...bossTransform.position);
    yawGroup.scale.setScalar(bossTransform.scale);

    // ── 조작 패널(테스트 뷰어와 같은 항목) ─────────────────────────
    // 슬라이더 기본값은 이 보스의 보정값으로 맞춰 둔다. 사용자가 만지면 그 값이 이긴다.
    const SL = {};
    ['yaw', 'pitch', 'roll', 'px', 'py', 'pz', 'sc'].forEach(k => {
      SL[k] = document.getElementById('f3d-' + k);
    });
    if (SL.yaw) {
      SL.yaw.value = yawDeg; SL.pitch.value = pitchDeg; SL.roll.value = rollDeg;
      SL.px.value = bossTransform.position[0];
      SL.py.value = bossTransform.position[1];
      SL.pz.value = bossTransform.position[2];
      SL.sc.value = bossTransform.scale;
    }

    // 연출용 강제 각도. null 이면 슬라이더(=표시값) 를 그대로 쓴다.
    let clipYaw = null;
    function applyModelYaw() {
      const base = (SL.yaw ? +SL.yaw.value : yawDeg) + baseYaw;
      yawGroup.rotation.y =
        THREE.MathUtils.degToRad(clipYaw !== null ? clipYaw : base);
    }
    function setClipYaw(name) {
      const want = clipModelYawFor(bossKey, name);
      if (want === clipYaw) return;
      clipYaw = want;
      applyModelYaw();
    }

    function applySliders() {
      if (!SL.yaw) return;
      applyModelYaw();
      pitchGroup.rotation.x = THREE.MathUtils.degToRad(+SL.pitch.value + basePitch);
      pitchGroup.rotation.z = THREE.MathUtils.degToRad(+SL.roll.value);
      yawGroup.position.set(+SL.px.value, +SL.py.value, +SL.pz.value);
      yawGroup.scale.setScalar(+SL.sc.value);
      Object.keys(SL).forEach(k => {
        const b = document.getElementById('f3d-' + k + 'v');
        if (b) b.textContent = SL[k].value;
      });
      markFaceButtons();
      const out = document.getElementById('f3d-out');
      if (out) {
        out.value = 'rotation: [' + SL.pitch.value + ', ' + SL.yaw.value + ', ' + SL.roll.value + '],\n'
          + 'position: [' + SL.px.value + ', ' + SL.py.value + ', ' + SL.pz.value + '],\n'
          + 'scale: ' + SL.sc.value;
      }
    }

    Object.values(SL).forEach(el => {
      if (!el) return;
      el.oninput = () => { if (container.__framesModel3D === state) applySliders(); };
    });

    document.querySelectorAll('.f3d-face').forEach(btn => {
      btn.onclick = () => {
        if (container.__framesModel3D !== state || !SL.yaw) return;
        SL.yaw.value = btn.dataset.yaw;
        applySliders();
      };
    });

    // 지금 yaw 와 맞는 방향 버튼에 불을 켠다. 슬라이더를 직접 돌려 어긋나면 다 꺼진다.
    function markFaceButtons() {
      const cur = SL.yaw ? Number(SL.yaw.value) : null;
      document.querySelectorAll('.f3d-face').forEach(b => {
        b.classList.toggle('active', cur !== null && Number(b.dataset.yaw) === cur);
      });
    }

    // 격자/축 — 바닥과 정면을 눈으로 잡을 때
    const gridHelper = new THREE.Group();
    gridHelper.add(new THREE.GridHelper(2, 20, 0x444450, 0x24242a));
    gridHelper.add(new THREE.AxesHelper(0.6));
    gridHelper.visible = true;   // 바닥·정면 기준이 되니 기본으로 켜 둔다
    scene.add(gridHelper);

    // 표시 방식 토글. 파츠가 이상하게 보일 때 원인을 좁히는 데 쓴다.
    //  - 와이어프레임: 지오메트리 자체가 뚫렸는지
    //  - 알파컷: 텍스처 알파 때문인지 (신형은 기본 꺼짐)
    //  - 단면: 양면 렌더링의 깊이 정렬 문제인지
    let optWire = false;
    let optAlpha = !isCatalogExport;
    let optSingle = false;

    function applyLookFlags() {
      meshes.forEach(m => {
        const glow = /_fx(_\d+)?$/i.test(m.name || '');
        [].concat(m.material).forEach(mt => {
          mt.wireframe = optWire;
          // 발광 파츠는 알파 블렌딩을 유지한다. 컷아웃을 걸면 판때기로 보인다.
          if (!glow && !mt.userData.translucent && !/^fx_/i.test(mt.name || '')) {
            // 끈 상태에서도 완전 투명(0)만은 잘라낸다 — 아니면 LED 발광판의 투명
            // 테두리가 네모로 통째로 보인다. 로드할 때 준 값과 같아야 한다.
            mt.alphaTest = optAlpha ? 0.5 : (isCatalogExport ? 0.05 : 0);
          }
          mt.side = optSingle ? THREE.FrontSide : THREE.DoubleSide;
          mt.needsUpdate = true;
        });
      });
    }

    function bindToggle(id, get, set) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('active', get());
      el.onclick = () => {
        if (container.__framesModel3D !== state) return;
        set(!get());
        el.classList.toggle('active', get());
        applyLookFlags();
      };
    }

    // FBX -> glTF 변환 과정에서 원래 불투명해야 할 몸체/무기 재질까지 alpha blend로
    // 나오는 경우가 있다 — 그러면 뒤쪽 파츠가 비쳐 보이는 정렬 문제가 생긴다.
    // 그렇다고 무조건 알파를 무시하고 완전 불투명 처리하면, 미사일/소켓처럼 텍스처의
    // 알파 채널을 실제 컷아웃(구멍 모양)으로 쓰는 파츠는 사각형 텍스처가 그대로 튀어나와 보인다.
    // 그래서 완전 불투명 대신 alphaTest 컷아웃으로 처리 — 깊이 정렬은 정상화하면서
    // 알파로 도려낸 모양은 그대로 유지된다. 이름이 fx_로 시작하는 이펙트 전용 재질만 예외.
    //
    // 또한 재질이 기본적으로 단면(FrontSide)이라, 안쪽으로 파인 구조(입 안쪽, 갑각류
    // 몸통 안쪽 등)를 밖에서 자유롭게 돌려 보면 뒷면이 통째로 안 보이거나 특정 각도에서
    // 투명하게 보이는 문제가 있었다 — 게임 자체는 고정 카메라라 안 보이던 뒷면인데,
    // 자유 회전 뷰어에서는 다 보이니 양면(DoubleSide)으로 강제한다.
    const meshes = [];
    gltf.scene.traverse(obj => {
      if (!obj.isMesh) return;
      meshes.push(obj);
      // 스킨드메쉬의 컬링용 바운딩 스피어는 바인드 포즈 기준으로 잡힌다. 애니메이션이
      // 본을 멀리 옮기면 그 구는 원점 근처에 남아서, 카메라가 본을 따라간 순간
      // three.js 가 "화면 밖"으로 판정해 메쉬를 통째로 안 그린다.
      obj.frustumCulled = false;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => {
        m.side = THREE.DoubleSide;
        // FBX2glTF가 재질마다 emissive를 회색(약 0x757575)으로 기본 설정해서 내보내는데,
        // 이게 실제 조명/텍스처 명암과 무관하게 표면 전체에 균일한 회색을 더해버려서
        // 어두운 톤의 보스가 반투명한 것처럼 뿌옇게 보이는 원인이었다 - 원본 FBX 뷰어에는
        // 없는 값이라 강제로 꺼둔다.
        // 구형은 FBX2glTF 가 박아 넣은 회색 emissive 를 지운다.
        // 신형은 실제 발광색이라 보존하되, 원본 값을 따로 기억해 둔다 —
        // 화면에는 기본으로 끄고 사용자가 고를 때 되살린다.
        if (!isCatalogExport) {
          if (m.emissive) m.emissive.setRGB(0, 0, 0);
        } else if (m.emissive && (m.emissive.r || m.emissive.g || m.emissive.b)) {
          // 재질 하나를 여러 메쉬가 나눠 쓰기 때문에 이 블록이 재질마다 여러 번 돈다.
          // 나눗셈을 그때마다 하면 밝기가 계속 깎인다(5.584 -> 0.087 까지 내려갔었다).
          if (!m.userData.glowColor) {
            // 내보내기는 강도에 _BloomIntensity 를 곱해서 준다. 그건 Unity 의 블룸
            // 후처리를 전제한 값이라, 후처리가 없는 이 뷰어에서 그대로 쓰면 하얗게 뜬다.
            // 도로 나눠서 셰이더의 HDR 최대값만 남긴다.
            const bloom = (m.userData.unity && m.userData.unity._BloomIntensity) || 1;
            m.emissiveIntensity = m.emissiveIntensity / bloom;
            // 나눠도 여전히 1.0 을 넘는 색이 있다(프로비던스 _GlowColor 는
            // 1.7, 0.489, 0.085). 게임에서는 넘친 만큼이 블룸으로 번지지만
            // 화면은 1.0 까지만 담을 수 있어서, 그대로 두면 채널마다 잘린다 —
            // 빨강만 1.7 -> 1.0 으로 눌리고 초록·파랑은 안 눌려서 색조가
            // 노란 쪽으로 밀린다. 가장 큰 성분이 1.0 이 되게 같이 줄여
            // 게임이 지정한 색조를 그대로 남긴다.
            const peak = m.emissiveIntensity
              * Math.max(m.emissive.r, m.emissive.g, m.emissive.b);
            if (peak > 1) m.emissiveIntensity /= peak;
            m.userData.glowColor = m.emissive.clone();
            m.userData.glowStrength = m.emissiveIntensity;
          }
        }
        // 재질 이름이 fx_ 로 시작하거나 메쉬 이름이 _fx 로 끝나면 발광·이펙트용이다.
        // 불투명으로 강제하면 빛나야 할 파츠가 판때기로 보인다.
        const isGlow = /^fx_/i.test(m.name || '') || /_fx(_\d+)?$/i.test(obj.name || '');
        if (isGlow) {
          // 원본은 프레넬(테두리) 발광 셰이더다. 표준 재질로 그대로 그리면 회색 껍데기가
          // 몸체를 통째로 덮어서 "그래픽 깨진 것처럼" 보인다.
          // 가산 합성으로 바꿔서 빛을 더하기만 하게 한다 — 발광을 끄면 아무것도 안 보인다.
          m.transparent = true;
          m.depthWrite = false;
          m.alphaTest = 0;
          m.blending = THREE.AdditiveBlending;
          // 발광층은 게임이 색을 직접 적어 준 자체발광이다. 본체를 보려고 걸어 둔
          // 톤매핑(ACES)과 노출 2.0 을 여기에 또 걸면 색이 흰 쪽으로 떠버린다
          // (프로비던스 주황 255,146,63 -> 252,210,135). 이 층만 빼 둔다.
          m.toneMapped = false;
          // 바탕색은 빼고(가산이라 그대로 두면 회색이 더해진다) 흑백 텍스처를 발광 마스크로
          // 돌려서, 텍스처의 명암 그라디언트가 빛의 세기 분포가 되게 한다.
          if (m.color) m.color.setRGB(0, 0, 0);
          if (m.map && !m.emissiveMap) m.emissiveMap = m.map;
          applyFresnelGlow(m);
        } else if (isTranslucentMaterial(bossKey, m.name)) {
          // 텍스처 알파를 그대로 투명도로 쓴다. 자르지 않는다.
          m.transparent = true;
          m.depthWrite = false;
          m.alphaTest = 0;
          m.userData.translucent = true;
        } else {
          m.transparent = false;
          m.depthWrite = true;
          // 신형 추출본은 알파 컷아웃을 끈다.
          //
          // 이 파일들은 재질이 alphaMode=MASK / cutoff=0.5 로 나오는데, 미사일·총구·
          // 지네관절 같은 가늘고 긴 파츠는 텍스처 알파가 0.5 언저리라 그대로 두면
          // 중간중간 뚫려서 뚝뚝 끊긴 모습이 된다(테스트 뷰어에서 컷아웃을 끄면
          // 멀쩡하게 나오는 것으로 확인). 구형 변환본은 알파를 실제 구멍 모양으로
          // 쓰는 파츠가 있어서 기존 값을 유지한다.
          // 0 으로 완전히 끄면 LED 발광판처럼 텍스처 대부분이 투명한 파츠가
          // 빨간 네모로 통째로 보인다. 아주 낮은 값으로 두면 완전 투명한 부분만
          // 잘리고, 알파가 0.3~0.5 언저리라 끊겨 보이던 가는 파츠는 그대로 남는다.
          m.alphaTest = isCatalogExport ? 0.05 : 0.5;
        }
      });

      // 메쉬별 보정도 구형 전용 — 신형은 트랜스폼이 파일에 제대로 들어 있다.
      const xform = isCatalogExport ? null : MESH_TRANSFORM_OVERRIDES[obj.name];
      if (xform) {
        const root = obj.isSkinnedMesh && obj.skeleton && obj.skeleton.bones[0] ? obj.skeleton.bones[0] : obj;
        if (xform.offset) {
          root.position.x += xform.offset[0];
          root.position.y += xform.offset[1];
          root.position.z += xform.offset[2];
        }
        if (xform.scale) root.scale.setScalar(xform.scale);
      }
    });

    // 스킬/등장 연출 전용 이펙트(fx_ 접두사) 메시는 기본적으로 꺼둔다 — idle 애니메이션만
    // 재생하는 정적 뷰어에서는 항상 화면에 떠 있으면 오히려 어색해 보인다.
    // 단, fx_fbx_monster_core(_outline)는 스킬 이펙트가 아니라 보스 몸체에 항상 붙어있는
    // 코어(약점) 표시라 거의 모든 보스에 공통으로 존재 — 이건 꺼두면 몸통 안쪽이 통째로
    // 비어 보이므로 예외로 기본 표시한다. 나머지는 토글로 직접 켤 수 있다.
    const isSkillOnlyEffect = name => /^fx_/i.test(name || '') && !/monster_core/i.test(name || '');

    // 좌우가 어긋난 이름을 먼저 맞바꾼다. 라벨·키·아래 보정표가 전부 이 이름을 쓴다.
    renameMeshes(bossKey, meshes);

    // 파츠 토글 목록에서는 보스 코드(예: bba001)를 빼고 보여준다 — fx_bba001_... 처럼
    // 접두사가 맨 앞이 아니라 중간에 낀 경우도 있어서, 위치 상관없이 전부 제거한다.
    // 실제 조회/저장에 쓰는 mesh.name은 그대로 두고, 화면 표시용 label만 별도로 붙인다.
    if (bossCode) {
      const stripCode = new RegExp(bossCode + '_?', 'ig');
      meshes.forEach(m => {
        const raw = (m.name || '').replace(stripCode, '');
        m.label = partLabelOf(bossCode, m, raw);
      });
    }

    // 파츠 토글은 이름을 키로 쓰는데, 이름이 겹치는 보스가 있다 — 앨트루이아는 메쉬 31개
    // 중 이름이 20종뿐이라 helm_01~09 와 눈이 각각 두 개씩 같은 이름을 쓴다. 그대로 두면
    // 하나를 끄면 짝까지 같이 꺼진다. 겹치는 것만 뒤에 번호를 붙여 구분한다.
    {
      const seen = new Map();
      meshes.forEach(m => {
        const base = m.name || 'mesh';
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        m.partKey = n > 1 ? base + '#' + n : base;
      });
      // 두 번 이상 나온 이름은 첫 번째에도 번호를 붙여줘야 목록에서 구분이 된다
      const dup = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
      const idx = new Map();
      meshes.forEach(m => {
        if (!dup.has(m.name)) return;
        const n = (idx.get(m.name) || 0) + 1;
        idx.set(m.name, n);
        m.partKey = m.name + '#' + n;
        m.label = (m.label || m.name) + ' ' + n;
      });
    }

    // 페이즈별로 파츠가 통째로 나뉜 보스들 (예: 1phase_body / 2phase_body, phase001_*/phase002_*)
    // 이 있다. 그런데 보스마다 사정이 달라서 — 어떤 보스는 페이즈 파츠가 서로 배타적(교체)이지만,
    // 어떤 보스(예: 온리 원)는 1페이즈 파츠를 2페이즈에서도 그대로 재사용(누적)한다. 이름 패턴만
    // 으로는 구분이 안 되므로 PHASE_MODE_OVERRIDES에 보스별로 등록해서 정확히 지정한다.
    // 파일에는 있는데 실제로는 없는 페이즈를 접는다(아일랜드 이터 3 -> 2).
    const foldPhase = p => {
      if (p === null) return null;
      const m = phaseConfig.merge;
      return (m && m[p] !== undefined) ? String(m[p]) : p;
    };
    // 메쉬 이름의 페이즈 태그가 실제와 다른 것들. 이름으로는 못 가른다.
    //   애니힐리오 - 1phase_magiccarpet 은 이름과 달리 2페이즈 파츠이고,
    //     터렛 다섯은 아예 태그가 없다. 둘 다 2페이즈에서만 쓴다.
    // 파일을 합치기 전에는 "파일 하나가 곧 페이즈" 라 안 걸렸던 문제다.
    const MESH_PHASE_FIX = [
      // 재질별로 갈린 메쉬는 뒤에 _1 _2 가 붙는다. 그것까지 받아야 한다.
      { boss: /^xba003/i, re: /^xba003_1phase_magiccarpet_skin(_\d+)?$/i, phase: '2' },
      { boss: /^xba003/i, re: /^xba003_turret\d+(_\d+)?$/i, phase: '2' },
    ];
    const meshPhase = (name) => {
      const fix = MESH_PHASE_FIX.find(
        o => o.boss.test(bossKey || '') && o.re.test(name || ''));
      return fix ? fix.phase : foldPhase(phaseTag(name));
    };
    const basePose = capturePose(gltf.scene);

    // 인게임 카메라. 있으면 등장·사망 연출에서 이걸 그대로 쓴다.
    const camNodes = findCameraNodes(gltf.scene);
    const camPairs = camNodes.length
      ? pairCameraClips(gltf.animations || [], camNodes)
      : { cams: [], byModel: new Map() };
    const cameraClipNames = new Set(camPairs.cams.map(c => c.name));
    // 카메라 클립이 붙은 모델 클립을 재생하는 동안 참이 된다
    let cinematic = null;
    const focusOverride = focusOverrideFor(bossKey);
    // 기준 메쉬는 페이즈에 따라 다시 고른다. 한 파일에 페이즈가 둘 다 들어 있으면
    // "본이 가장 많은 메쉬" 가 다른 페이즈 것일 수 있다 - 애니힐리오를 합친 뒤
    // 1페이즈를 보는데 2페이즈 몸체(본 253 대 98)가 기준이 됐다.
    let focusMesh = pickFocusMesh(meshes, focusOverride);
    // 본 패턴이 있으면 그게 우선. 메쉬만 지정했으면 그 메쉬 전체가 기준이라는 뜻이다.
    let focusBone = focusOverride
      ? (focusOverride.bone || (focusOverride.mesh && focusMesh ? 'all' : null))
      : null;

    // 페이즈가 파일이 아니라 본 스케일로 갈리는 보스가 있다(에고비스타). phase_change 가
    // 날개깃(remiges) 12개를 1.0 -> 0.03 으로 줄이고 대검 깃털을 0.08 -> 1.0 으로 키운다.
    // 그런데 2페이즈 클립들에는 그 날개깃 스케일 트랙이 아예 없어서, 클립만 틀면 아무도
    // 깃털을 치워주지 않는다. 게다가 우리는 클립을 바꿀 때마다 포즈를 초기화하므로
    // 전환 결과가 매번 지워진다.
    //
    // 그래서 전환이 끝난 시점의 자세를 미리 한 번 떠 두고, 2페이즈 클립을 재생할 때는
    // 초기 자세 대신 그 자세로 되돌린다. 클립이 실제로 건드리는 본은 어차피 클립이
    // 덮어쓰므로, 트랙이 없는 본(=깃털)만 전환 상태를 유지하게 된다.
    const phaseChangeClip = isCatalogExport ? findPhaseChangeClip(gltf.animations || []) : null;
    let phaseEndPose = null;
    if (phaseChangeClip) {
      const probe = new THREE.AnimationMixer(gltf.scene);
      const probeAction = probe.clipAction(phaseChangeClip);
      // 기본 반복 모드로 두면 정확히 duration 시점에서 처음으로 되감겨서 전환 "전" 자세를
      // 뜨게 된다(날개깃이 0.02 가 아니라 1.0 으로 잡힌다). 한 번만 재생하고 끝에서
      // 멈추도록 잠가야 한다.
      probeAction.setLoop(THREE.LoopOnce, 1);
      probeAction.clampWhenFinished = true;
      probeAction.play();
      probe.setTime(phaseChangeClip.duration);
      phaseEndPose = capturePose(gltf.scene);
      probe.stopAllAction();
      probe.uncacheRoot(gltf.scene);
      restorePose(basePose);
    }

    // 이 클립을 재생하기 전에 어떤 자세로 되돌려야 하는지.
    // 합성 클립은 잘라낸 지점의 자세에서 시작해야 한다. 원본 클립을 그 시점에
    // 얹어 떠 둔다 — 안 그러면 1.17 초 이후에 키가 없는 뼈가 기본 자세로 튄다.
    const syntheticPoses = new Map();

    function poseFor(clipName) {
      if (syntheticPoses.has(clipName)) return syntheticPoses.get(clipName);
      // 전환 클립 자신은 전환 "전" 자세에서 시작해야 한다. 이름에 2phase 가 들어 있어서
      // (프로비던스 xbg002_2phase, 온리 원 xbg003_2phase_change) 그냥 두면 자기 끝
      // 자세에서 시작하게 된다.
      if (phaseChangeClip && clipName === phaseChangeClip.name) return basePose;
      const p = clipPhase(clipName);
      return (phaseEndPose && p && p !== '1') ? phaseEndPose : basePose;
    }

    // 원본 클립을 특정 시점에 얹은 자세를 떠 온다. 화면에는 영향이 없다.
    function poseAtClipTime(clip, time) {
      const saved = capturePose(gltf.scene);
      let taken = null;
      try {
        const probe = new THREE.AnimationMixer(gltf.scene);
        restorePose(basePose);
        const act = probe.clipAction(clip);
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
        act.play();
        probe.setTime(time);
        taken = capturePose(gltf.scene);
        probe.stopAllAction();
        probe.uncacheRoot(gltf.scene);
      } finally {
        restorePose(saved);
        gltf.scene.updateMatrixWorld(true);
      }
      return taken;
    }

    // 잘라낸 클립은 잘라낸 지점의 자세에서 시작해야 한다.
    trimmedClips.forEach(t => syntheticPoses.set(t.name, poseAtClipTime(t.src, t.from)));

    // Unity 카메라는 +Z 를 보고 glTF/three 카메라는 -Z 를 본다. 내보내기가 이 차이를
    // 보정하지 않으면 시선이 정확히 180 도 뒤집혀서, 본체를 등지고 반대편 허공을 찍는다.
    // (거대 질량체 death 는 본체가 시선에서 149~179 도 벗어나 있었다.)
    // 내보내기가 나중에 고쳐질 수도 있으니 값을 박아두지 않고, 로드할 때 실제로 재서
    // 본체가 화면 앞에 오는 쪽을 고른다.
    const CAM_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    let cameraFlip = false;

    // 연출마다 따로 재 둔 좌우 뒤집기. 한 보스 안에서도 카메라마다 다른 파일이 있다
    // (베히모스 dead_camera 만 다른 축이다). 파일에 적힌 viewAxis 는 그대로 쓰면
    // 오히려 어긋나서, 실제로 어느 쪽이 본체를 향하는지 재서 정한다.
    const camFlipByClip = new Map();
    const camNeedsFlip = (modelName) =>
      camFlipByClip.has(modelName) ? camFlipByClip.get(modelName) : cameraFlip;

    // 게임 카메라가 보스를 너무 멀리서 잡는 클립이 있다(프로비던스·온리 원의 등장·사망은
    // 모델이 화면 높이의 20% 아래로 떨어진다). 화면비가 게임(세로)과 뷰어(가로)가 달라서
    // 같은 화각이라도 훨씬 작아 보인다.
    // 카메라의 "움직임" 은 그대로 두고 모델 쪽으로 당기기만 한다 — 시선 방향과 궤적 모양은
    // 유지되고 거리만 줄어든다. 클립마다 한 번 재서 상수로 쓰므로 프레임마다 흔들리지 않는다.
    const CAM_FILL = 0.62; // 모델이 화면 높이에서 차지하길 바라는 비율
    const camZoom = new Map();

    function measureCameraZoom() {
      if (!camNodes.length || !focusMesh || !camPairs.byModel.size) return;
      if (!cameraNeedsPull(bossKey)) return;
      const saved = capturePose(gltf.scene);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
      const center = new THREE.Vector3();
      try {
        camPairs.byModel.forEach((pair, modelName) => {
          const camClip = pair.clip, node = pair.node;
          const fovRad = THREE.MathUtils.degToRad(node.isPerspectiveCamera ? node.fov : 60);
          const wantHalf = Math.tan(fovRad * CAM_FILL / 2);
          const modelClip = (gltf.animations || []).find(c => c.name === modelName);
          if (!modelClip) return;
          const dur = Math.min(camClip.duration, modelClip.duration);
          const ratios = [];
          for (const frac of [0.2, 0.35, 0.5, 0.65, 0.8]) {
            restorePose(poseFor(modelName));
            const probe = new THREE.AnimationMixer(gltf.scene);
            probe.clipAction(modelClip).play();
            probe.clipAction(camClip).play();
            probe.setTime(dur * frac);
            gltf.scene.updateMatrixWorld(true);
            if (rigCenter(focusMesh, center, focusBone)) {
              const r = rigSpread(focusMesh, center, focusBone);
              node.matrixWorld.decompose(pos, quat, scl);
              const d = center.distanceTo(pos);
              if (r > 1e-6 && d > 1e-6) ratios.push((r / wantHalf) / d);
            }
            probe.stopAllAction();
            probe.uncacheRoot(gltf.scene);
          }
          if (!ratios.length) return;
          ratios.sort((a, b) => a - b);
          const k = ratios[Math.floor(ratios.length / 2)];
          // pull 은 멀 때만 당긴다. fit 은 가까울 때 뒤로도 물린다.
          const twoWay = !!cameraFixFor(bossKey).fit;
          if (k < 0.98 || (twoWay && k > 1.02)) {
            camZoom.set(modelName, Math.max(0.12, Math.min(6, k)));
          }
        });
      } finally {
        restorePose(saved);
        gltf.scene.updateMatrixWorld(true);
      }
    }

    // 연출 카메라가 보스를 화면 한쪽으로 밀어놓는 경우가 있다.
    // 카메라의 움직임(궤적·거리)은 그대로 두고 겨누는 방향만 상수로 돌린다.
    // 클립마다 여러 시점에서 "카메라가 보스를 보려면 얼마나 돌려야 하는지" 를 재고,
    // 그 평균을 한 번만 적용한다 — 매 프레임 다시 겨누면 원래 카메라 워크가 사라진다.
    const camAim = new Map();

    // 연출 중간에 카메라가 모델 안으로 파고드는 구간이 있다
    // (온리 원 등장 5초에 거리 0.14 — 화면에 보이는 정점이 1% 뿐이다).
    // 클립 전체 거리의 중앙값을 재서 그보다 가까워지지 않게만 막는다.
    // 나머지 구간은 원래 거리 그대로라 카메라 워크는 유지된다.
    const camNear = new Map();

    function measureCameraNear() {
      if (!camNodes.length || !focusMesh || !camPairs.byModel.size) return;
      if (!cameraFixFor(bossKey).near) return;
      const saved = capturePose(gltf.scene);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
      const center = new THREE.Vector3();
      try {
        camPairs.byModel.forEach((pair, modelName) => {
          const camClip = pair.clip, node = pair.node;
          const modelClip = (gltf.animations || []).find(c => c.name === modelName);
          if (!modelClip) return;
          const dur = Math.min(camClip.duration, modelClip.duration);
          const ds = [];
          for (let i = 1; i <= 12; i++) {
            restorePose(poseFor(modelName));
            const probe = new THREE.AnimationMixer(gltf.scene);
            probe.clipAction(modelClip).play();
            probe.clipAction(camClip).play();
            probe.setTime(dur * (i / 13));
            gltf.scene.updateMatrixWorld(true);
            if (rigCenter(focusMesh, center, focusBone)) {
              node.matrixWorld.decompose(pos, quat, scl);
              ds.push(center.distanceTo(pos));
            }
            probe.stopAllAction();
            probe.uncacheRoot(gltf.scene);
          }
          if (ds.length < 4) return;
          ds.sort((a, b) => a - b);
          const mid = ds[Math.floor(ds.length / 2)];
          if (mid > 1e-4 && ds[0] < mid * 0.85) camNear.set(modelName, mid * 0.85);
        });
      } finally {
        restorePose(saved);
        gltf.scene.updateMatrixWorld(true);
      }
    }

    function measureCameraAim() {
      if (!camNodes.length || !focusMesh || !camPairs.byModel.size) return;
      const fix = cameraFixFor(bossKey);
      if (!fix.aim && !fix.aimX) return;
      const saved = capturePose(gltf.scene);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
      const center = new THREE.Vector3(), dir = new THREE.Vector3();
      const FWD = new THREE.Vector3(0, 0, -1);
      try {
        camPairs.byModel.forEach((pair, modelName) => {
          const camClip = pair.clip, node = pair.node;
          const modelClip = (gltf.animations || []).find(c => c.name === modelName);
          if (!modelClip) return;
          const dur = Math.min(camClip.duration, modelClip.duration);
          const acc = new THREE.Vector3();
          let n = 0;
          for (const frac of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85]) {
            restorePose(poseFor(modelName));
            const probe = new THREE.AnimationMixer(gltf.scene);
            probe.clipAction(modelClip).play();
            probe.clipAction(camClip).play();
            probe.setTime(dur * frac);
            gltf.scene.updateMatrixWorld(true);
            if (rigCenter(focusMesh, center, focusBone)) {
              node.matrixWorld.decompose(pos, quat, scl);
              dir.copy(center).sub(pos);
              if (dir.lengthSq() > 1e-8) {
                // 카메라 기준 좌표로 옮겨서 방향만 모은다
                dir.normalize().applyQuaternion(quat.clone().invert());
                if (camNeedsFlip(modelName)) dir.applyQuaternion(CAM_FLIP.clone().invert());
                acc.add(dir); n++;
              }
            }
            probe.stopAllAction();
            probe.uncacheRoot(gltf.scene);
          }
          if (!n) return;
          acc.divideScalar(n);
          if (acc.lengthSq() < 1e-8) return;
          acc.normalize();
          // aimX 는 좌우만 돌린다 — 위아래 성분을 지우고 다시 정규화한다
          if (fix.aimX) {
            acc.y = 0;
            if (acc.lengthSq() < 1e-8) return;
            acc.normalize();
          }
          const off = Math.acos(Math.max(-1, Math.min(1, acc.dot(FWD)))) * 180 / Math.PI;
          // 이미 잘 맞으면 건드리지 않는다
          if (off < 3) return;
          camAim.set(modelName, new THREE.Quaternion().setFromUnitVectors(FWD, acc));
        });
      } finally {
        restorePose(saved);
        gltf.scene.updateMatrixWorld(true);
      }
    }

    // 이 클립이 실제로 움직이는 본의 한가운데. 한 파일에 페이즈가 둘 다 든 보스는
    // focusMesh(본이 가장 많은 메쉬 하나)가 다른 페이즈 것일 수 있어서, 그걸
    // 기준으로 재면 엉뚱한 답이 나온다 - 애니힐리오를 합친 뒤 1페이즈 카메라가
    // 2페이즈 몸체를 기준으로 판정돼 시선이 통째로 뒤집혔다.
    const clipBoneCenter = (clip, out) => {
      const names = new Set();
      (clip.tracks || []).forEach(t => {
        const i = (t.name || '').indexOf('.');
        if (i > 0) names.add(t.name.slice(0, i));
      });
      if (!names.size) return null;
      const v = new THREE.Vector3();
      let n = 0;
      out.set(0, 0, 0);
      gltf.scene.traverse(o => {
        if (!names.has(o.name)) return;
        if (DEBRIS_BONE_RE.test(o.name || '') || ANCHOR_BONE_RE.test(o.name || '')) return;
        o.getWorldPosition(v);
        if (!isFinite(v.x) || !isFinite(v.y) || !isFinite(v.z)) return;
        out.add(v); n++;
      });
      if (!n) return null;
      out.multiplyScalar(1 / n);
      return out;
    };

    function measureCameraFlip() {
      if (!camNodes.length || !focusMesh || !camPairs.byModel.size) return;
      const saved = capturePose(gltf.scene);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
      const center = new THREE.Vector3(), toModel = new THREE.Vector3();
      const fwd = new THREE.Vector3();
      let plain = 0, flipped = 0, n = 0;
      try {
        camPairs.byModel.forEach((pair, modelName) => {
          const camClip = pair.clip, node = pair.node;
          const modelClip = (gltf.animations || []).find(c => c.name === modelName);
          if (!modelClip) return;
          // 연출별로 따로 센다. 전체 표만 보면 축이 다른 한 대가 묻힌다.
          let cPlain = 0, cFlip = 0, cN = 0;
          const dur = Math.min(camClip.duration, modelClip.duration);
          for (const frac of [0.2, 0.4, 0.6, 0.8]) {
            restorePose(poseFor(modelName));
            const probe = new THREE.AnimationMixer(gltf.scene);
            probe.clipAction(modelClip).play();
            probe.clipAction(camClip).play();
            probe.setTime(dur * frac);
            gltf.scene.updateMatrixWorld(true);
            // 그 클립이 움직이는 본을 먼저 본다. 없으면 예전처럼 focusMesh 로.
            if (clipBoneCenter(modelClip, center) || rigCenter(focusMesh, center, focusBone)) {
              node.matrixWorld.decompose(pos, quat, scl);
              toModel.copy(center).sub(pos);
              if (toModel.lengthSq() > 1e-8) {
                toModel.normalize();
                fwd.set(0, 0, -1).applyQuaternion(quat);
                const dPlain = fwd.dot(toModel);
                fwd.set(0, 0, -1).applyQuaternion(quat.clone().multiply(CAM_FLIP));
                const dFlip = fwd.dot(toModel);
                plain += dPlain; flipped += dFlip; n++;
                cPlain += dPlain; cFlip += dFlip; cN++;
              }
            }
            probe.stopAllAction();
            probe.uncacheRoot(gltf.scene);
          }
          if (cN) camFlipByClip.set(modelName, cFlip > cPlain);
        });
      } finally {
        restorePose(saved);
        gltf.scene.updateMatrixWorld(true);
      }
      // 내적이 클수록 본체를 정면으로 본다는 뜻
      if (n) cameraFlip = flipped > plain;
    }

    // 파일에 없는 스킬을 원본 클립을 잘라 만들어 목록에 끼워 넣는다.
    function buildSyntheticSequences(seqs) {
      const list = gltf.animations || [];
      SYNTHETIC_SEQUENCES.forEach(def => {
        if (!def.boss.test(bossKey || '')) return;
        // 이미 진짜 클립이 있으면 손대지 않는다
        if (seqs.some(sq => sq.key.endsWith(def.key))) return;
        const steps = [];
        for (const st of def.steps) {
          const src = list.find(c => st.re.test(c.name || ''));
          if (!src) return; // 재료가 하나라도 없으면 만들지 않는다
          if (!st.from) { steps.push({ clip: src, repeat: 1 }); continue; }
          // fps 를 1000 으로 두고 밀리초 단위로 자른다
          const cut = THREE.AnimationUtils.subclip(
            src, src.name.replace(/_04$/, '_05'), Math.round(st.from * 1000), 1e9, 1000);
          if (!cut.tracks.length) return;
          syntheticPoses.set(cut.name, poseAtClipTime(src, st.from));
          steps.push({ clip: cut, repeat: 1 });
        }
        if (!steps.length) return;
        const entry = { key: def.key, label: def.key, steps, synthetic: true };
        // 번호 순서대로 보이도록 바로 앞 번호 묶음 뒤에 끼워 넣는다
        const prev = def.key.replace(/(\d+)$/, (n) => String(Number(n) - 1).padStart(n.length, '0'));
        const at = seqs.findIndex(sq => sq.key.endsWith(prev));
        if (at >= 0) seqs.splice(at + 1, 0, entry);
        else seqs.push(entry);
      });
    }

    // 애니메이션 목록을 다시 그리는 함수. 아래 목록 블록에서 채운다 —
    // 페이즈 토글이 여기를 불러서 그 페이즈의 클립만 남긴다.
    let renderAnimList = null;

    const phaseConfig = getPhaseConfig(bossKey, bossCode);
    // 신형 추출본은 보통 파일 하나가 곧 페이즈 하나다. 그런데 온리 원처럼 한 파일에
    // 1·2 페이즈가 다 든 보스가 있다. 메쉬 이름만으로는 구분이 안 된다 —
    // 애니힐리오 2페이즈 파일에도 1phase_magiccarpet 메쉬가 들어 있는데 그건 2페이즈에서
    // 쓰는 파츠다. 클립 쪽을 보면 정확하다: 그 파일은 2페이즈 클립만 갖고 있고,
    // 온리 원은 1·2 페이즈 클립을 둘 다 갖고 있다.
    const clipPhaseKeys = new Set(
      (gltf.animations || []).map(c => foldPhase(clipPhase(c.name))).filter(Boolean));
    const singleFilePhases = clipPhaseKeys.size > 1;
    const phaseGroups = {};
    if (!isCatalogExport || singleFilePhases) {
      meshes.forEach(m => {
        const p = meshPhase(m.name);
        if (p) (phaseGroups[p] = phaseGroups[p] || []).push(m);
      });
    }
    // 파츠에는 페이즈 태그가 없는데 클립만 페이즈로 갈리는 파일이 있다
    // (베히모스 2페이즈 파일에 2·3페이즈 클립이 같이 들어 있다).
    // "그 페이즈만의 대기 동작이 있으면 그 페이즈다" 로 본다 — 그래야 전환 클립
    // 한 개가 딸려 있을 뿐인 파일(베히모스 1페이즈)에 헛토글이 생기지 않는다.
    const phaseKeys = Object.keys(phaseGroups).length
      ? Object.keys(phaseGroups).sort((a, b) => Number(a) - Number(b))
      : [...new Set((gltf.animations || [])
          .filter(c => /(^|_)idle(_\d+)?$/i.test(stripPhaseTail(c.name))
            && !/air|skill/i.test(c.name || ''))
          .map(c => clipPhase(c.name))
          .filter(Boolean))].sort((a, b) => Number(a) - Number(b));
    // 모델 고르는 칩의 이름이 페이즈를 가리키면(예: "3페이즈") 그 페이즈로 고정한다.
    // 같은 파일을 페이즈별 항목으로 두 번 등록해 쓰는 보스가 있다 — 베히모스 2페이즈
    // 파일에는 2·3페이즈 클립이 같이 들어 있고, DB 에 2페이즈/3페이즈로 나눠 적는다.
    const labelPhase = (String(options.modelLabel || '').match(/(\d+)\s*페이즈/) || [])[1] || null;
    const lockedPhase = labelPhase && phaseKeys.includes(labelPhase) ? labelPhase : null;
    const minPhase = lockedPhase || (phaseKeys.length > 0 ? phaseKeys[0] : null);
    // 모든 보스는 항상 1페이즈(가장 낮은 페이즈)로 시작 - 다른 페이즈는 직접 선택해야 보인다.
    let currentPhase = minPhase;
    // 신형 추출본은 파일 하나가 곧 페이즈 하나라, 메쉬 이름의 phase 태그를 무시해야 한다.
    // 이걸 빼먹으면 2페이즈 파일의 "2phase_" 파츠들이 currentPhase(null) 와 비교돼
    // 전부 숨겨진다 — 실제로 11개 중 6개가 사라졌었다.
    const phaseOf = (name) => ((isCatalogExport && !singleFilePhases) ? null : meshPhase(name));

    const partTable = hasPhasePartTable(bossKey);
    const isPhaseVisible = (p, current) => {
      // 페이즈별 파츠 표가 있는 보스는 그 표만 본다.
      if (partTable) return true;
      if (p === null) return true;
      if (phaseConfig.mode === 'exclusive') return p === current;
      if (phaseConfig.mode === 'phase1-all') return current === minPhase ? true : p === current;
      return Number(p) <= Number(current); // cumulative
    };

    // 지금 페이즈에 보이는 메쉬 중에서 기준 메쉬를 다시 고른다.
    function refreshFocusMesh() {
      const pool = meshes.filter(m => isPhaseVisible(phaseOf(m.name), currentPhase));
      focusMesh = pickFocusMesh(pool.length ? pool : meshes, focusOverride);
      focusBone = focusOverride
        ? (focusOverride.bone || (focusOverride.mesh && focusMesh ? 'all' : null))
        : null;
    }

    // 그 페이즈에서 처음 보여줄 파츠. 초기화 버튼이 이걸 다시 쓴다 —
    // "처음 열었을 때" 가 아니라 "지금 페이즈의 기본" 으로 돌아가야 한다.
    const defaultPartKeys = phase => meshes
      .filter(m => !isSkillOnlyEffect(m.name)
        && !isDefaultOffMesh(bossKey, m.name, phase)
        && !isPhasePartOff(bossKey, phase, m.name)
        && isPhaseVisible(phaseOf(m.name), phase))
      .map(m => m.partKey);

    refreshFocusMesh();
    const enabledMeshes = new Set(defaultPartKeys(currentPhase));

    // 지금 도는 클립이 한 부위만 내보내는 연출이면 여기에 그 규칙이 들어온다.
    let clipSolo = null;
    // 연출 중에만 켜지는 발광 파츠. { parts: [정규식], color } 또는 null.
    let clipGlow = null;
    // 같은 스킬의 start -> loop 로 넘어갈 때 고른 세트를 그대로 쓰기 위한 표시.
    let clipGlowKey = null;
    // 발광 재질 목록이 아직 안 만들어졌으면 칠하지 않는다(첫 재생이 그보다 먼저다).
    let glowReady = false;

    // 사용자가 직접 고른 재생은 세트를 다시 뽑는다. 묶음 안에서 start -> loop 로
    // 넘어가는 것만 앞서 뽑은 세트를 그대로 쓴다(중간에 바뀌면 깜빡인다).
    function rerollClipGlow() { clipGlowKey = null; }

    // 이 클립에서 켤 발광 세트를 정한다. 같은 스킬 안에서는 다시 뽑지 않는다.
    function pickClipGlow(clipName) {
      const rule = clipGlowRuleFor(bossKey, clipName);
      if (!rule) { clipGlow = null; clipGlowKey = null; return; }
      const key = rule.color + ':' + ((String(clipName).match(/_(\d+)$/) || [])[1] || '');
      if (clipGlow && clipGlowKey === key) return;
      const pool = rule.sets.slice();
      const picked = [];
      for (let i = 0; i < rule.count && pool.length; i++) {
        picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      }
      clipGlow = { parts: picked, color: rule.color };
      clipGlowKey = key;
    }

    // meshActivation 이 지금 켜 두라고 한 메쉬 이름. null 이면 규칙이 없다.
    let clipMeshOn = null;
    let clipMeshKey = null;
    // 이 연출의 활성 구간 표에 이름이 오른 메쉬 전부. 여기 없는 메쉬는 손대지 않는다.
    let meshActNames = new Set();

    // 파일이 적어 준 이름과 three.js 가 붙인 이름이 다를 수 있다. 같은 이름의
    // 뼈가 있으면 메쉬 쪽에 _1 이 붙고(온리 원은 ziz/behamoth/leviathan/
    // 2phase_wings 넷이 다 그렇다 - 뼈와 메쉬가 같은 이름이다), 프리미티브가
    // 여럿인 메쉬는 _2 _3 으로 갈린다. 그래서 <이름> 과 <이름>_숫자 를 한
    // 항목으로 본다 - 안 그러면 activationTrack 이 아무것도 못 걸고 조용히
    // 넘어간다(온리 원 등장이 그랬다).
    function meshActKey(names, meshName) {
      if (names.has(meshName)) return meshName;
      const base = String(meshName || '').replace(/_\d+$/, '');
      return names.has(base) ? base : null;
    }

    function clearClipMeshAct() {
      if (!clipMeshOn && !meshActNames.size) return;
      clipMeshOn = null;
      clipMeshKey = null;
      meshActNames = new Set();
      applyVisibility();
    }

    function applyVisibility() {
      meshes.forEach(m => {
        let on = enabledMeshes.has(m.partKey);
        if (clipSolo) {
          // 이 연출에서만 켜는 파츠 — 평소 꺼둔 것을 되살린다.
          if (clipSolo.show && clipSolo.show.test(m.name)) on = true;
          // show 로 켠 뒤에도 hide 는 따로 본다. 둘을 같이 적어서 "전부 켜되
          // 이것만 빼고" 를 쓸 수 있어야 한다 — 애니힐리오 전환 연출이 그렇다.
          if (on && clipSolo.hide && clipSolo.hide.test(m.name)) on = false;
          if (on && clipSolo.group
              && clipSolo.group.test(m.name) && !clipSolo.keep.test(m.name)) on = false;
        }
        // 이 연출에서만 켜지는 발광 파츠 — 평소 꺼둔 것을 잠깐 되살린다
        if (!on && clipGlow && clipGlow.parts.some(re => re.test(m.name))) on = true;
        // 게임 타임라인의 메쉬 활성 구간. 여기 이름이 오르는 메쉬는 그 구간에만
        // 보인다 — 온리 원 등장은 소환수와 2페 날개를 2.5 초까지만 켠다.
        if (clipMeshOn && meshActNames.size) {
          const k = meshActKey(meshActNames, m.name);
          if (k) on = clipMeshOn.has(k);
        }
        m.visible = on;
      });
    }

    function renderToggleUI() {
      if (!meshes.length) return;
      const box = document.getElementById('frames-parts-toggle');
      if (!box) return;

      // 부위별로 묶는다. 프로비던스처럼 팔·다리·어깨가 좌우로 나뉜 보스는
      // 하나씩 끄기 번거로워서, 묶음 제목을 누르면 그 부위를 통째로 켜고 끈다.
      const groups = [];
      const findGroup = (label) => {
        let g = groups.find(x => x.label === label);
        if (!g) { g = { label, items: [] }; groups.push(g); }
        return g;
      };
      // 지금 페이즈에 안 쓰는 파츠는 목록에서 뺀다. 한 파일에 페이즈가 둘 다
      // 들어 있으면(애니힐리오) 쓰지도 않는 파츠가 절반씩 섞여 보인다.
      meshes
        .filter(m => isPhaseVisible(phaseOf(m.name), currentPhase))
        .forEach(m => findGroup(partGroupLabel(bossKey, m.name)).items.push(m));
      // 그룹 안에서 부위 -> 좌우 -> 번호 순으로 세운다
      groups.forEach(g => {
        g.items.forEach((m, i) => { m.__order = i; });
        g.items.sort((a, b) => {
          // 정렬은 늘 내부 이름으로. 표시 이름(인게임 표기)으로 세우면 이름을 적어 둔
          // 파츠만 엉뚱한 자리로 튄다.
          const c = comparePartKeys(partSortKey(a.name), partSortKey(b.name));
          return c || (a.__order - b.__order);
        });
      });

      const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      box.classList.remove('hidden');
      // 맨 위에 전체 켜기/끄기. 파츠가 많은 보스(프로비던스는 39개)에서
      // 하나씩 누르지 않고 한 번에 비우고 필요한 것만 켤 수 있게 한다.
      // 목록에 보이는 것만 센다 - 다른 페이즈 파츠까지 세면 "전체" 개수가
      // 화면과 안 맞는다.
      const shown = meshes.filter(m => isPhaseVisible(phaseOf(m.name), currentPhase));
      const totalOn = shown.filter(m => enabledMeshes.has(m.partKey)).length;
      const allState = totalOn === shown.length ? ' active' : (totalOn ? ' partial' : '');
      // 기본 상태와 다를 때만 초기화가 의미가 있다. 같으면 눌러도 변화가 없으니 죽여 둔다.
      const defKeys = defaultPartKeys(currentPhase);
      const shownKeys = new Set(shown.map(m => m.partKey));
      const onShown = [...enabledMeshes].filter(k => shownKeys.has(k));
      const isDefault = defKeys.length === onShown.length
        && defKeys.every(k => enabledMeshes.has(k));
      const allHtml = `
          <div class="part-group">
            <div class="part-group-head part-all${allState}">
              <div class="toggle-switch"></div>
              <span class="toggle-label">전체 파츠</span>
              <em>${totalOn}/${shown.length}</em>
              <button type="button" class="part-reset-btn"${isDefault ? ' disabled' : ''}
                      title="${isDefault ? '이미 기본 상태다' : '이 페이즈의 기본 파츠 상태로 되돌린다'}">초기화</button>
            </div>
          </div>`;
      box.innerHTML = allHtml + groups.map((g, gi) => {
        const on = g.items.filter(m => enabledMeshes.has(m.partKey)).length;
        const state = on === g.items.length ? ' active' : (on ? ' partial' : '');
        const rows = g.items.map(m => `
          <div class="toggle-switch-wrap part-toggle-item${enabledMeshes.has(m.partKey) ? ' active' : ''}" data-skin="${esc(m.partKey)}">
            <div class="toggle-switch"></div>
            <span class="toggle-label" title="${esc(m.name)}">${esc(m.label || m.name)}</span>
          </div>`).join('');
        return `
          <div class="part-group">
            <div class="part-group-head${state}" data-group="${gi}">
              <div class="toggle-switch"></div>
              <span class="toggle-label">${esc(g.label)}</span>
              <em>${on}/${g.items.length}</em>
            </div>
            <div class="part-group-body">${rows}</div>
          </div>`;
      }).join('');

      // 초기화: 지금 페이즈의 기본 파츠 상태로 되돌린다. 전체 파츠 줄 안에 있어서
      // 그대로 두면 줄의 켜기/끄기까지 같이 돈다 — 버블링을 끊는다.
      const resetBtn = box.querySelector('.part-reset-btn');
      if (resetBtn) {
        resetBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          if (container.__framesModel3D !== state) return;
          enabledMeshes.clear();
          defaultPartKeys(currentPhase).forEach(k => enabledMeshes.add(k));
          applyVisibility();
          renderToggleUI();
        });
      }

      // 전체 파츠: 하나라도 꺼져 있으면 전부 켜고, 다 켜져 있으면 전부 끈다
      const allHead = box.querySelector('.part-all');
      if (allHead) {
        allHead.addEventListener('click', () => {
          if (container.__framesModel3D !== state) return;
          const pool = meshes.filter(m => isPhaseVisible(phaseOf(m.name), currentPhase));
          const allOn = pool.every(m => enabledMeshes.has(m.partKey));
          pool.forEach(m => {
            if (allOn) enabledMeshes.delete(m.partKey);
            else enabledMeshes.add(m.partKey);
          });
          applyVisibility();
          renderToggleUI();
        });
      }

      // 묶음 제목: 하나라도 꺼져 있으면 전부 켜고, 다 켜져 있으면 전부 끈다
      box.querySelectorAll('.part-group-head[data-group]').forEach(head => {
        head.addEventListener('click', () => {
          if (container.__framesModel3D !== state) return;
          const items = groups[+head.dataset.group].items;
          const allOn = items.every(m => enabledMeshes.has(m.partKey));
          items.forEach(m => {
            if (allOn) enabledMeshes.delete(m.partKey);
            else enabledMeshes.add(m.partKey);
          });
          applyVisibility();
          renderToggleUI();
        });
      });

      box.querySelectorAll('.part-toggle-item').forEach(el => {
        el.addEventListener('click', () => {
          if (container.__framesModel3D !== state) return;
          const key = el.dataset.skin;
          if (enabledMeshes.has(key)) enabledMeshes.delete(key);
          else enabledMeshes.add(key);
          applyVisibility();
          renderToggleUI();
        });
      });
    }

    applyVisibility();
    renderToggleUI();

    const phaseToggleEl = document.getElementById('frames-phase-toggle');
    if (phaseToggleEl) {
      if (phaseKeys.length > 1 && !lockedPhase) {
        phaseToggleEl.classList.remove('hidden');
        phaseToggleEl.innerHTML = phaseKeys.map(p => `
          <button type="button" class="filter-chip frames-phase-btn${p === currentPhase ? ' active' : ''}" data-phase="${p}">${p}페이즈</button>
        `).join('');
        phaseToggleEl.querySelectorAll('.frames-phase-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            currentPhase = btn.dataset.phase;
            refreshFocusMesh();
            phaseToggleEl.querySelectorAll('.frames-phase-btn').forEach(b => {
              b.classList.toggle('active', b.dataset.phase === currentPhase);
            });
            // 프리셋 적용: 페이즈 태그가 있는 파츠만 보스별 모드(누적/배타)에 맞게 다시
            // 켜고/끄고, 페이즈 태그가 없는 공용 파츠는 건드리지 않는다.
            meshes.forEach(m => {
              if (partTable) {
                if (isPhasePartOff(bossKey, currentPhase, m.name)
                    || isSkillOnlyEffect(m.name)
                    || isDefaultOffMesh(bossKey, m.name, currentPhase)) {
                  enabledMeshes.delete(m.partKey);
                } else {
                  enabledMeshes.add(m.partKey);
                }
                return;
              }
              const p = phaseOf(m.name);
              // 평소 꺼 두는 파츠(마녀의 까마귀 III 처럼)는 페이즈를 바꿔도 그대로 둔다.
              if (isSkillOnlyEffect(m.name)
                  || isDefaultOffMesh(bossKey, m.name, currentPhase)) {
                enabledMeshes.delete(m.partKey);
                return;
              }
              if (p === null) {
                // 페이즈 꼬리표가 없는 공용 파츠는 건드리지 않는다. 다만 페이즈를
                // 조건으로 꺼 두는 줄이 걸린 파츠는 그 페이즈를 벗어나면 되살린다 -
                // 베히모스 머신건은 3페이즈에서만 빠진다.
                if (isPhaseScopedOff(bossKey, m.name)) enabledMeshes.add(m.partKey);
                return;
              }
              if (isPhaseVisible(p, currentPhase)) enabledMeshes.add(m.partKey);
              else enabledMeshes.delete(m.partKey);
            });
            applyVisibility();
            renderToggleUI();
            updateAnimationForPhase();
          });
        });
      } else {
        phaseToggleEl.classList.add('hidden');
        phaseToggleEl.innerHTML = '';
      }
    }

    // 신형 추출본은 정규화 후 정면에서 본다.
    //
    // 예전에는 바운딩박스 중심에서 x·z 로 똑같이 물러난 자리에 카메라를 뒀는데, 그러면
    // 항상 45도 대각선에서 보게 된다 — 테스트 뷰어는 정면(x=0, z=거리)이라 화면이
    // 전혀 다르게 보였다. 좌우·상하가 다 틀어져 보인 원인이 이것이다.
    let normHeight = 1;
    if (isCatalogExport) {
      normGroup.position.set(0, 0, 0);
      normGroup.scale.setScalar(1);
      normGroup.updateWorldMatrix(true, true);

      // 뼈를 씬 루트별로 묶어서 상자를 따로 잰다. 보스 몸에서 뚝 떨어져 떠 있는
      // 딴 개체가 상자를 부풀리면 보스가 그만큼 작게 잡히기 때문이다 -
      // 리버렐리오 바디는 해파리를 넣으면 229, 빼면 50.8 이라 보스가 제 크기의
      // 1/5 로 잡혔다. 파츠를 꺼도 소용없다. 정규화는 뼈 위치로만 재기 때문에
      // 보이고 안 보이고와 무관하다.
      //
      // 배포된 16종으로 대조해 보니 리버렐리오 말고는 값이 소수점까지 그대로다.
      // 대부분 리그가 하나뿐이라 아무 일도 안 하고, 둘인 애니힐리오는 두 뭉치가
      // 맞닿아 있어 둘 다 남는다.
      const fitGroups = new Map();
      const nv = new THREE.Vector3();
      meshes.forEach(m => {
        if (!m.isSkinnedMesh || !m.skeleton) return;
        m.skeleton.bones.forEach(b => {
          if (DEBRIS_BONE_RE.test(b.name || '')) return;
          let root = b;
          while (root.parent && root.parent !== gltf.scene) root = root.parent;
          let gbox = fitGroups.get(root);
          if (!gbox) { gbox = new THREE.Box3(); fitGroups.set(root, gbox); }
          b.getWorldPosition(nv);
          gbox.expandByPoint(normGroup.worldToLocal(nv.clone()));
        });
      });
      const nb = new THREE.Box3();
      if (fitGroups.size) {
        const gs = new THREE.Vector3();
        const widest = box => Math.max(box.getSize(gs).x, gs.y, gs.z);
        let main = null, mainMax = -1;
        fitGroups.forEach(gbox => {
          const w = widest(gbox);
          if (w > mainMax) { mainMax = w; main = gbox; }
        });
        // 가장 큰 뭉치에 그 크기의 절반만큼 여유를 주고, 거기 안 닿는 뭉치는 뺀다.
        const reach = main.clone().expandByScalar(mainMax * 0.5);
        fitGroups.forEach(gbox => { if (gbox.intersectsBox(reach)) nb.union(gbox); });
      }
      if (!nb.isEmpty()) {
        const ns = nb.getSize(new THREE.Vector3());
        const k = 1 / (Math.max(ns.x, ns.y, ns.z) || 1);
        const fitBase = catalogFitBase(bossKey, bossCode, isCatalogExport, optLabelPhase);
        const bs = fitBase.scale || 1;
        normGroup.scale.setScalar(k * bs);
        normGroup.position.set(0, -nb.min.y * k * bs + (fitBase.y || 0), 0);
        // 눈높이는 기준 보정 전 크기로 잡는다 — 맞춰 둔 시점을 그대로 유지한다.
        normHeight = ns.y * k;
      }
    }

    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() || 1;

    if (isCatalogExport) {
      // 카메라와 시선을 같은 값만큼 올린다 — 각도는 그대로 두고 눈높이만 바꾼다.
      const fitOv = CATALOG_FIT_OVERRIDES[bossCode] || {};
      const camLift = fitOv.camY || 0;
      camera.position.set(0, normHeight * 0.55 + camLift, fitOv.camDist || 2.3);
      controls.target.set(0, normHeight * 0.5 + camLift, 0);
    } else {
      camera.position.set(center.x + radius * 0.8, center.y + radius * 0.5, center.z + radius * 0.8);
      controls.target.copy(center);
    }

    // 보스마다 크기가 제각각이라 줌 한계도 모델 크기(radius) 기준 상대값으로 준다 —
    // 너무 가까이 가면 파츠를 뚫고 들어가 안 보이고, 너무 멀어지면 화면에서 안 보일 만큼
    // 작아지는 걸 막는다.
    if (isCatalogExport) {
      controls.minDistance = 0.4;
      controls.maxDistance = 12;
      camera.near = 0.01;
      camera.far = 100;
      camera.updateProjectionMatrix();
    } else {
      controls.minDistance = radius * 0.05;
      controls.maxDistance = radius * 3;
    }

    controls.update();

    // 스킨드메쉬의 지오메트리 바운딩박스는 바인드 포즈 기준이라, 재생 위치가 바인드와
    // 멀리 떨어진 모델(신형 추출본이 그렇다)에서는 카메라가 빈 곳을 보게 된다.
    // 기존 보스는 둘이 일치해서 이 보정이 아예 걸리지 않는다 — 어긋난 경우에만 고친다.
    const probe = new THREE.Vector3();
    if (!isCatalogExport && focusMesh && rigCenter(focusMesh, probe, focusBone) && !box.containsPoint(probe)) {
      const boneBox = new THREE.Box3();
      const bv = new THREE.Vector3();
      meshes.forEach(m => {
        if (!m.isSkinnedMesh || !m.skeleton) return;
        m.skeleton.bones.forEach(b => {
          if (DEBRIS_BONE_RE.test(b.name || '')) return;
          boneBox.expandByPoint(b.getWorldPosition(bv));
        });
      });
      if (!boneBox.isEmpty()) {
        const bSize = boneBox.getSize(new THREE.Vector3());
        const bCenter = boneBox.getCenter(new THREE.Vector3());
        const bRadius = bSize.length() || 1;
        camera.position.set(bCenter.x + bRadius * 0.8, bCenter.y + bRadius * 0.4, bCenter.z + bRadius * 0.8);
        controls.target.copy(bCenter);
        controls.minDistance = bRadius * 0.05;
        controls.maxDistance = bRadius * 4;
        camera.near = bRadius / 500;
        camera.far = bRadius * 50;
        camera.updateProjectionMatrix();
        controls.update();
      }
    }

    homeCamPos = camera.position.clone();
    homeTarget = controls.target.clone();
    initialTarget = controls.target.clone();

    // 클립 하나만 눈높이가 다른 경우(온리 원 take01). 기준점까지 같이 올려서
    // 추적도, 시점 초기화도 올라간 자리를 기준으로 돌게 한다.
    let clipCamLift = 0;
    function applyClipCamLift(clipName) {
      if (!homeCamPos) return;
      const rule = RAW_MODE ? null : CLIP_CAM_LIFT.find(
        o => o.boss.test(bossKey || '') && o.re.test(clipName || ''));
      const d = (rule ? rule.y : 0) - clipCamLift;
      if (!d) return;
      clipCamLift += d;
      homeCamPos.y += d;
      homeTarget.y += d;
      initialTarget.y += d;
      camera.position.y += d;
      controls.target.y += d;
    }

    // 시점 추적을 아예 끄는 연출.
//
// 리그가 통째로 부서져 바닥 아래로 떨어지는 클립은 따라가면 안 된다 - 화면이
// 파편을 쫓아 땅으로 꺾인다. 그레이브 디거 페이즈 전환이 그렇다.
// phase001_destroy 3.3초 기준 평균 높이:
//   1phase_skin  0.67 -> -5.85      1phase_parts_left  0.70 -> -5.19
//   1phase_sawtooth 0.79 -> -5.76   1phase_parts_right 0.69 -> -4.00
// 기준 본을 골라서 피하려 해도 안 된다 - 그 메쉬의 본이 전부 같이 떨어진다
// (Bone_BD_D_* 만 평균내도 -2.49 였다).
// 기준 메쉬를 차체(body_skin, 0.38 -> 0.37 로 꼼짝 안 한다)로 바꾸는 것도 해
// 봤는데 기본 시점이 통째로 어긋났다(보스가 화면 아래로 내려가고 9% 로 작아짐).
// 이 연출에서만 추적을 멈추는 것이 가장 좁은 고침이다.
const NO_FOLLOW_CLIPS = [
  { boss: /^mbg002/i, re: /_phase00[12]_destroy$/i },
];

function noFollowClip(bossKey, name) {
  return NO_FOLLOW_CLIPS.some(
    o => o.boss.test(bossKey || '') && o.re.test(name || ''));
}

// 카메라 추적 — 등장·사망 연출은 리그를 통째로 옮긴다. 게임에서도 카메라가 같이
    // 움직여서 본체를 잡기 때문에 성립하는 연출이다.
    // 중심의 "절대 위치" 가 아니라 "처음 대비 변위" 를 따라가므로, 제자리에서만 움직이는
    // 기존 보스는 변위가 0 이라 아무 영향이 없다.
    const followBase = new THREE.Vector3();
    const followCur = new THREE.Vector3();
    const followDelta = new THREE.Vector3();
    const followWant = new THREE.Vector3();
    const camOffset = new THREE.Vector3();
    const camWant = new THREE.Vector3();
    let followReady = false;
    let followSpread = 0;
    // start 클립을 재생하는 동안 시점을 붙들어 둘 자리.
    // 바로 뒤에 오는 loop 의 첫 프레임 중심을 미리 재서 여기에 넣는다.
    let followPin = null;
    if (focusMesh && rigCenter(focusMesh, followBase, focusBone)) {
      followReady = true;
      followSpread = rigSpread(focusMesh, followBase, focusBone);
    }

    // 우클릭 팬이 안 먹히던 원인 — 추적이 매 프레임 시점을 원래 자리로 끌어당겨서
    // 사용자가 옮긴 만큼을 즉시 되돌리고 있었다. 조작 중에는 멈추고, 손을 떼면
    // 그 자리를 새 기준으로 잡는다.
    let followEnabled = true;
    // 추적이 켜져 있으면 시선을 옮겨도 곧바로 되돌아와서 조작이 먹지 않는 것처럼
    // 보인다. 아예 팬을 잠가서 왜 안 되는지 헷갈리지 않게 한다.
    const syncPanLock = () => { controls.enablePan = !followEnabled; };
    let userDragging = false;
    controls.addEventListener('start', () => { userDragging = true; });
    controls.addEventListener('end', () => {
      userDragging = false;
      initialTarget.copy(controls.target);
      if (focusMesh) rigCenter(focusMesh, followBase, focusBone);
    });

    // 팬으로 시선을 옮길 수 있는 범위. 너무 멀리 밀어내면 모델을 다시 찾기 어렵다.
    const PAN_LIMIT = isCatalogExport ? 1.2 : radius * 0.6;

    function clampPan() {
      // 추적이 켜져 있으면 시선을 모델 쪽으로 멀리 옮겨야 한다. 여기서 되돌리면
      // 등장·사망처럼 리그가 멀리 가는 연출에서 카메라가 못 따라간다.
      if (followEnabled || !homeTarget) return;
      const off = controls.target.clone().sub(homeTarget);
      const d = off.length();
      if (d <= PAN_LIMIT) return;
      off.multiplyScalar(PAN_LIMIT / d);
      const fixed = homeTarget.clone().add(off);
      camera.position.add(fixed.clone().sub(controls.target));
      controls.target.copy(fixed);
    }

    // 인게임 카메라가 도는 동안에는 시점 계산을 하지 않는다 — 카메라 노드의 월드
    // 트랜스폼을 그대로 옮겨 쓴다. 그 노드가 모델과 같은 그룹(yaw/pitch/norm) 안에
    // 있어서 방향 보정과 정규화 배율이 저절로 함께 걸린다.
    const camIdleDir = new THREE.Vector3();
    const camAimTmp = new THREE.Vector3();
    const camStageTmp = new THREE.Vector3();
    // 본 뭉치의 한가운데. 여러 개가 걸리면 흔들림이 상쇄된다.
    function boneMid(bones, out) {
      out.set(0, 0, 0);
      bones.forEach(b => out.add(b.getWorldPosition(camAimTmp)));
      return out.divideScalar(bones.length || 1);
    }
    const camWorldPos = new THREE.Vector3();
    const camWorldQuat = new THREE.Quaternion();
    const camWorldScl = new THREE.Vector3();
    const camAnchorMat = new THREE.Matrix4();
    const camAnchorOut = new THREE.Matrix4();
    const camFwd = new THREE.Vector3();
    const camPull = new THREE.Vector3();
    const AXIS_Y = new THREE.Vector3(0, 1, 0);
    const camSpinQ = new THREE.Quaternion();
    // 컷 단위 겨냥 보정(AIM_CUT)이 컷 사이에 들고 가는 값
    const aimCutOff = new THREE.Quaternion();
    const aimCutFile = new THREE.Quaternion();
    const aimCutWant = new THREE.Quaternion();
    const aimCutPrev = { pos: new THREE.Vector3(), span: 1, time: 0, clip: null, valid: false };
    let savedFov = null;

    // 연출 카메라가 보스를 못 담는 프레임만 되돌린다.
    // 잘 잡히는 프레임에서는 보정량이 0 이라 게임 값 그대로다.
    const RESCUE_GOOD = 0.5;   // 이 이상 담기면 손대지 않는다
    const RESCUE_BAD = 0.15;   // 이 아래로 떨어지면 최대한 되돌린다
    const RESCUE_EASE = 0.15;  // 보정이 들어가고 빠지는 데 걸리는 시간(초)
    let rescueW = 0;
    const rsCenter = new THREE.Vector3();
    const rsV = new THREE.Vector3();
    const rsFwd = new THREE.Vector3();
    const rsUp = new THREE.Vector3(0, 1, 0);
    const rsMat = new THREE.Matrix4();
    const rsQuat = new THREE.Quaternion();

    // 화면에 들어오는 기준 본의 비율
    function framedRatio() {
      if (!focusMesh) return 1;
      const bones = focusBonesOf(focusMesh);
      const step = Math.max(1, Math.floor(bones.length / 40));
      let seen = 0, inside = 0;
      for (let i = 0; i < bones.length; i += step) {
        const b = bones[i];
        if (!isBoneVisible(b)) continue;
        b.getWorldPosition(rsV);
        if (!isFinite(rsV.x)) continue;
        seen++;
        rsV.project(camera);
        if (rsV.z > -1 && rsV.z < 1 && Math.abs(rsV.x) <= 1 && Math.abs(rsV.y) <= 1) inside++;
      }
      return seen ? inside / seen : 1;
    }

    function applyShotRescue(dt) {
      if (!focusMesh || !rigCenter(focusMesh, rsCenter, focusBone)) return;
      const ratio = framedRatio();
      // 화면에 얼마나 안 담기는가
      let want = 0;
      if (ratio < RESCUE_GOOD) {
        want = Math.min(1, (RESCUE_GOOD - ratio) / (RESCUE_GOOD - RESCUE_BAD));
      }
      // 얼마나 파고들었는가. 기준 본만 보면 몸통이 화면축 근처에 남아 있어서
      // 실제보다 멀쩡해 보인다 — 카메라가 모델 안에 있으면 그쪽을 따른다.
      const spread = rigSpread(focusMesh, rsCenter, focusBone);
      const half = THREE.MathUtils.degToRad(camera.fov) / 2;
      const wantDist = spread > 1e-5 ? spread / Math.tan(half * 0.9) : 0;
      const dist = camera.position.distanceTo(rsCenter);
      if (wantDist > 1e-5 && dist < wantDist) {
        want = Math.max(want, Math.min(1, 1 - dist / wantDist));
      }
      // 툭 튀지 않게 서서히 들어가고 빠진다
      const k = 1 - Math.pow(0.01, Math.min(dt, 0.1) / RESCUE_EASE);
      rescueW += (want - rescueW) * k;
      // 검증용 — 바깥에서 보정이 얼마나 걸렸는지 들여다본다
      state.rescue = { ratio, want, w: rescueW };
      if (rescueW < 0.002) { rescueW = 0; return; }

      // 시선을 보스 쪽으로
      rsMat.lookAt(camera.position, rsCenter, rsUp);
      rsQuat.setFromRotationMatrix(rsMat);
      camera.quaternion.slerp(rsQuat, rescueW);

      // 모델 안으로 파고들었으면 시선축을 따라 뒤로만 물린다
      if (wantDist > 1e-5) {
        const d = camera.position.distanceTo(rsCenter);
        if (d < wantDist) {
          rsFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
          camera.position.addScaledVector(rsFwd, -(wantDist - d) * rescueW);
        }
      }
    }

    function applyCinematicCamera(dt) {
      if (!cinematic || !cinematic.node || !followEnabled) {
        if (savedFov !== null) { camera.fov = savedFov; savedFov = null; camera.updateProjectionMatrix(); }
        return false;
      }
      const node = cinematic.node;
      node.updateWorldMatrix(true, false);
      // 홀더를 쓰는 연출은 카메라의 지역 변환 앞에 홀더(평행이동)를 끼운다.
      // 월드 행렬 앞에 곱하면 안 된다 — 홀더 값은 파일 원시 단위인데 뷰어는
      // 모델을 정규화(균일 축소)해서 얹어 놓기 때문에 축척이 어긋난다.
      // 부모(정규화 그룹) 아래, 카메라 지역 변환 위에 넣어야 같은 단위가 된다.
      const rawCam = cinematic.raw;
      // 파일 값 그대로 쓰는 연출(RAW_CAM_BOSS)은 홀더도 같이 끈다 - 홀더는
      // 뷰어가 얹는 보정이기 때문이다. 다만 holder 를 적어 둔 줄은 예외다.
      // 홀더가 있어야 카메라 워크가 성립하는 연출이 있다 - 온리 원 등장은
      // 홀더 없이는 거리가 190 -> 136 으로 1.39 배밖에 안 당겨지는데,
      // 홀더를 끼우면 57 -> 3.9 로 인게임처럼 확 파고든다. 홀더의 z(+133.4)가
      // 거리를 재는 원점을 옮겨서 당겨지는 비율 자체를 바꾸기 때문이다.
      // back 은 거리에 곱하는 값이라 이 비율을 못 바꾼다 - 홀더로만 된다.
      const anchorArr = (rawCam && !rawCam.holder)
        ? null : cutsceneAnchorOf(node, rawCam ? rawCam.holder : 1);
      if (anchorArr) {
        camAnchorMat.fromArray(anchorArr);
        camAnchorOut.multiplyMatrices(camAnchorMat, node.matrix);
        if (node.parent) camAnchorOut.premultiply(node.parent.matrixWorld);
        camAnchorOut.decompose(camWorldPos, camWorldQuat, camWorldScl);
      } else {
        node.matrixWorld.decompose(camWorldPos, camWorldQuat, camWorldScl);
      }
      camera.position.copy(camWorldPos);
      camera.quaternion.copy(camWorldQuat);
      // 연출별 카메라 밀기. 원본 갈래로 빠지는 연출에도 걸리도록 여기서 한다.
      const mv = clipCamMoveAt(cinematic.move,
        cinematic.action ? cinematic.action.time : 0);
      if (mv) {
        // spin - 모델을 지나는 세로축(월드 Y) 기준으로 카메라 리그를 통째로 돌린다.
        // 위치와 방향을 같이 돌리므로 보스를 보는 것은 그대로고 보는 쪽만 바뀐다.
        //
        // 추출본에 카메라 "위치" 가 반대편으로 들어온 연출이 있다. 뒤집기는 제자리
        // 회전이라 보스를 향하게는 해 주지만 여전히 뒤에서 보게 된다.
        // 사치스러운 거미 사망이 그렇다 - 정면 대비 카메라 각이 165~178도였다
        // (등장·대기는 0~4도로 정상이다).
        if (mv.spin) {
          camSpinQ.setFromAxisAngle(AXIS_Y, THREE.MathUtils.degToRad(mv.spin));
          camera.position.applyQuaternion(camSpinQ);
          camera.quaternion.premultiply(camSpinQ);
        }
        // 뒤집기(CAM_FLIP)는 카메라 로컬 Y 축 180도라 그 뒤로 x·z 축이 반대가 된다.
        // 이 밀기는 뒤집기보다 먼저 걸리므로, 뒤집히는 연출에서는 부호를 미리
        // 뒤집어 둬야 표에 적은 대로 화면이 움직인다. y 축은 뒤집혀도 그대로다.
        // (사치스러운 거미 사망이 그런 연출이다 - 안 뒤집으면 back 이 뒤가 아니라
        //  앞으로 먹어서 카메라가 시체를 뚫고 지나간다)
        const f = cinematic.flip ? -1 : 1;
        if (mv.x) camera.translateX(mv.x * f);
        if (mv.y) camera.translateY(mv.y);
        if (mv.z) camera.translateZ(mv.z * f);
        // 거리에 비례해 뒤로. 기준점은 양을 재는 데만 쓰고 방향은 시선축이다.
        if (mv.back && mv.back !== 1
            && rigCenter(focusMesh, camPull, mv.pivot || 'all')) {
          camera.translateZ(camera.position.distanceTo(camPull) * (mv.back - 1) * f);
        }
        // 화면 기울기. 시선축(카메라 로컬 Z) 기준이라 위치·거리·겨냥은 그대로다.
        // 평행이동 뒤에 건다 - 먼저 돌리면 x·y 가 기울어진 축을 따라간다.
        // 부호는 CAMERA_FIX 의 rollDeg 와 같다. 양수 = 화면이 반시계로 돈다.
        if (mv.roll) camera.rotateZ(-THREE.MathUtils.degToRad(mv.roll) * f);
      }
      // 원본 확인 모드에서는 파일 값(위치·회전·화각)만 쓰고 아래 보정을 전부 건너뛴다.
      // RAW_CAM_BOSS 에 든 보스는 주소에 아무것도 안 붙여도 이쪽으로 온다.
      if (RAW_MODE || rawCam) {
        if (node.isPerspectiveCamera) {
          if (savedFov === null) savedFov = camera.fov;
          if (Math.abs(camera.fov - node.fov) > 1e-4) {
            camera.fov = node.fov;
            camera.updateProjectionMatrix();
          }
        }
        // 파일 값이 너무 가까운 보스는 여기서 뒤로만 물린다. 회전도 화각도
        // 손대지 않으므로 카메라 워크는 그대로 남고 크기만 준다.
        //
        // 방향은 시선축(카메라 로컬 +Z)이다. 기준점에서 카메라로 뻗은 선을 쓰면
        // 기준점이 엉뚱한 데 잡힌 보스에서 엉뚱한 쪽으로 밀린다 - 베히모스
        // 1페이즈는 본 416개가 전부 exc_body_ 라 평균이 격자 아래(y -1.74)로
        // 내려가고, 그쪽을 기준으로 밀면 뒤가 아니라 위로 올라간다.
        // 시선축이면 기준점이 얼마나 어긋나든 "뒤로" 는 늘 맞고, 화면 한가운데에
        // 있던 것이 그 자리에 그대로 남는다.
        //
        // 물리는 양만 기준점까지의 거리에 비례시킨다 - 가까이 붙는 컷은 그만큼
        // 덜 물러난다. 여기는 대충 맞기만 하면 되므로 기준점이 조금 어긋나도 된다.
        const back = (!RAW_MODE && rawCam && rawCam.back) || 1;
        if (back !== 1 && rigCenter(focusMesh, camPull, rawCam.pivot || 'all')) {
          camera.translateZ(camera.position.distanceTo(camPull) * (back - 1));
        }
        camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
        controls.target.copy(camera.position).addScaledVector(camFwd, 2);
        return true;
      }
      // 타임라인 배치가 어긋난 연출은 모델 클립 시각을 맞춰 준다.
      // 카메라가 시계인 경우 모델 액션은 스스로 진행하지 않게 세워 두고
      // (안 그러면 모델이 먼저 끝나서 다음 클립으로 넘어간다) 시간만 얹는다.
      if (cinematic.timeOffset && currentAction && cinematic.action) {
        if (camIsClock() && !currentAction.paused) currentAction.paused = true;
        const want = cinematic.action.time + cinematic.timeOffset;
        const dur = currentAction.getClip().duration;
        const t = Math.max(0, Math.min(dur, want));
        if (Math.abs(currentAction.time - t) > 1e-4) {
          currentAction.time = t;
          if (mixer) mixer.update(0);
        }
      }
      // 메쉬 활성 구간. 켜지고 꺼지는 항목이 바뀔 때만 다시 칠한다.
      if (cinematic.meshAct) {
        const tl = cinematic.camStart + cinematic.action.time;
        let key = '';
        for (const o of cinematic.meshAct) {
          if (tl >= o.start - 1e-6 && tl < o.end - 1e-6) key += o.name + '|';
        }
        if (key !== clipMeshKey) {
          clipMeshKey = key;
          clipMeshOn = new Set(key ? key.slice(0, -1).split('|') : []);
          applyVisibility();
        }
      }
      if (cinematic.flip) camera.quaternion.multiply(CAM_FLIP);
      // 겨냥·거리 보정의 기준점. 대상 본을 정해 뒀으면 그 본, 아니면 본체 중심.
      let hasAim = false;
      // 이 단계에서 쓸 고정 거리. 0 이면 클립 값을 따른다.
      let stageDist = 0;
      if (cinematic.lookAt) {
        const st = cinematic.lookAt;
        const now = currentAction ? currentAction.time : 0;
        let i = 0;
        while (i + 1 < st.length && now >= st[i + 1].from) i++;
        boneMid(st[i].bones, camPull);
        stageDist = st[i].fixDist;
        // 넘어가는 동안은 앞 단계 겨냥점에서 이어 붙인다. 안 그러면 화면이 한 번 튄다.
        if (i > 0 && st[i].blend > 0) {
          const w = Math.min(1, Math.max(0, (now - st[i].from) / st[i].blend));
          if (w < 1) {
            boneMid(st[i - 1].bones, camStageTmp);
            camPull.lerp(camStageTmp, 1 - w);
            stageDist = st[i - 1].fixDist + (stageDist - st[i - 1].fixDist) * w;
          }
        }
        hasAim = true;
      } else if (cinematic.aimMode && cinematic.lookAtFocus) {
        hasAim = !!visualCenter(meshes, camPull);
      } else if ((cinematic.lookAtFocus || cinematic.idleAngle) && focusMesh) {
        hasAim = rigCenter(focusMesh, camPull, focusBone);
      }
      // 겨냥 높이를 못 박아야 하는 연출이 있다(베히모스 take1 은 격자 높이).
      if (hasAim && cinematic.aimY !== null) camPull.y = cinematic.aimY;
      // 방향은 기본 시점과 같게, 거리만 게임 값을 따른다.
      if (cinematic.idleAngle && hasAim && homeCamPos && homeTarget) {
        camIdleDir.copy(homeCamPos).sub(homeTarget);
        if (camIdleDir.lengthSq() > 1e-12) {
          camIdleDir.normalize();
          // fixDist - 게임 카메라의 거리를 아예 무시하고 고정한다. 리그가 부서지는
          // 연출은 게임 거리가 프레임마다 크게 흔들려서 배율(dist)로는 못 잡는다.
          const fixed = stageDist || cinematic.fixDist;
          const d = fixed > 0
            ? fixed
            : camera.position.distanceTo(camPull) * cinematic.dist;
          camera.position.copy(camPull).addScaledVector(camIdleDir, d);
        }
      } else if (cinematic.dist !== 1 && hasAim) {
        // 방향은 게임 값 그대로 두고 거리만 조정한다.
        camera.position.sub(camPull).multiplyScalar(cinematic.dist).add(camPull);
      }
      // 매 프레임 기준점을 향하게 다시 잡는다. 위치와 화각은 건드리지 않으므로
      // 게임의 카메라 워크는 그대로 남는다.
      if (hasAim) {
        if (cinematic.aimMode !== 'cut') {
          camera.lookAt(camPull);
        } else {
          // 컷이 바뀌었으면 이 프레임에서 오프셋을 다시 잰다.
          // 클립이 바뀌거나 되감으면 앞 컷의 값을 들고 가면 안 된다.
          const now = cinematic.action ? cinematic.action.time : 0;
          const rewound = now + 1e-4 < aimCutPrev.time;
          const jumped = !aimCutPrev.valid || rewound
            || aimCutPrev.clip !== (cinematic.action && cinematic.action._clip)
            || camera.position.distanceTo(aimCutPrev.pos) > aimCutPrev.span * 0.25;
          // 이 프레임에서 "보스가 화면 중앙에 오는" 오프셋을 구한다.
          aimCutFile.copy(camera.quaternion);
          camera.lookAt(camPull);
          aimCutWant.copy(aimCutFile).invert().premultiply(camera.quaternion);
          if (jumped || AIM_DAMP <= 0 && !aimCutPrev.valid) {
            // 컷 머리에서는 즉시 맞춘다.
            aimCutOff.copy(aimCutWant);
          } else if (AIM_DAMP > 0) {
            // 컷 안에서는 천천히 따라간다. 모델이 움직여도 화면에서 밀려나지
            // 않으면서, 카메라 워크(위치)는 파일 값 그대로 남는다.
            const k = 1 - Math.exp(-Math.max(1e-4, dt || 1 / 60) / AIM_DAMP);
            aimCutOff.slerp(aimCutWant, k);
          }
          camera.quaternion.copy(aimCutFile).multiply(aimCutOff);
          aimCutPrev.pos.copy(camera.position);
          aimCutPrev.span = Math.max(0.35, camera.position.distanceTo(camPull));
          aimCutPrev.time = now;
          aimCutPrev.clip = cinematic.action && cinematic.action._clip;
          aimCutPrev.valid = true;
        }
      }
      // 치우친 각을 상수로 돌린다. 위치는 그대로라 카메라 워크는 유지된다.
      if (cinematic.aim) camera.quaternion.multiply(cinematic.aim);
      // 화면 기울기 보정. rotateZ 는 카메라 로컬 Z(시선축) 기준이라 위치·거리·
      // 겨냥은 그대로 두고 화면만 굴러간다. 화면이 도는 방향과 부호가
      // 반대라 뒤집어 넣는다 — rollDeg 양수 = 화면이 반시계.
      if (cinematic.rollDeg) {
        const rt = cinematic.action ? cinematic.action.time : 0;
        if (rt >= cinematic.rollFrom && rt < cinematic.rollTo) {
          camera.rotateZ(-THREE.MathUtils.degToRad(cinematic.rollDeg));
        }
      }
      if (cinematic.rescue) applyShotRescue(dt || 1 / 60);
      // 너무 멀리서 잡는 클립은 같은 선 위에서 모델 쪽으로 당긴다.
      // 시선 방향은 그대로라 화면 구도는 유지되고 크기만 커진다.
      if (cinematic.zoom !== 1 && rigCenter(focusMesh, camPull, focusBone)) {
        camera.position.sub(camPull).multiplyScalar(cinematic.zoom).add(camPull);
      }
      // 모델 안으로 파고드는 구간만 뒤로 물린다. 방향은 그대로.
      if (cinematic.near > 0 && rigCenter(focusMesh, camPull, focusBone)) {
        const d = camera.position.distanceTo(camPull);
        if (d > 1e-5 && d < cinematic.near) {
          camera.position.sub(camPull).multiplyScalar(cinematic.near / d).add(camPull);
        }
      }
      // 게임 카메라의 화각을 따른다. 게이트핏이 가로라 화면비로 세로를 낸다.
      // 클립이 끝나면 원래 값으로 돌려놓는다.
      if (node.isPerspectiveCamera) {
        if (savedFov === null) savedFov = camera.fov;
        const want = (GATEFIT_OFF || gateFitOffFor(bossKey))
          ? node.fov : gateFitFov(node.fov, GAME_ASPECT);
        if (Math.abs(camera.fov - want) > 1e-4) {
          camera.fov = want;
          camera.updateProjectionMatrix();
        }
      }
      // 궤도 조작의 기준점도 시선 앞으로 옮겨 둔다 — 연출이 끝난 뒤 조작이 어색하지 않게.
      camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      controls.target.copy(camera.position).addScaledVector(camFwd, 2);
      return true;
    }

    // 시점을 처음 자리로. 추적이 꺼져 있으면 사용자가 맞춰둔 시점이므로 건드리지 않는다.
    function resetViewToHome() {
      if (savedFov !== null) { camera.fov = savedFov; savedFov = null; camera.updateProjectionMatrix(); }
      if (!followEnabled || !homeCamPos || !homeTarget) return;
      camera.quaternion.identity();
      camOffset.copy(homeCamPos).sub(homeTarget);
      controls.target.copy(initialTarget);
      camera.position.copy(initialTarget).add(camOffset);
    }

    // 추적이 켜져 있으면 매 프레임 시점을 처음 상태로 되돌린다 — 거리·각도까지
    // 전부. 예전에는 목표까지 부드럽게 따라가기만 해서, 리그가 빠르게 움직이는
    // 구간(애니힐리오 사망은 1 초에 2.2 내려간다)에서 화면이 뒤처지고, 그 오차가
    // 클립이 끝날 때까지 남았다.
    function updateFollow() {
      if (!followEnabled || userDragging || !followReady || !focusMesh) return;
      // 부서져 떨어지는 연출은 따라가지 않는다. 시점을 그대로 둔다.
      if (noFollowClip(bossKey, state.currentClip)) return;
      let ok = true;
      if (followPin) {
        // start 구간은 loop 가 시작될 자리에 시점을 고정한다. 이렇게 해야
        // start -> loop 로 넘어갈 때 화면이 튀지 않는다.
        followCur.copy(followPin);
      } else {
      if (!rigCenter(focusMesh, followCur, focusBone)) ok = false;
      // 리그 자체가 망가지는 구간이 있다. 거대 질량체가 두 경우를 다 보여준다 —
      // appearance_f 는 main 리그(본 760개)를 스케일 0 으로 접어 21 유닛 밖에 세워두고,
      // death 후반에는 반대로 본을 25 유닛 범위로 흩뿌린다(평소 퍼짐 0.4).
      // 접힌 리그의 "위치" 도, 흩어진 본의 "평균" 도 의미가 없어서 그대로 따라가면
      // 아무것도 없는 허공을 비춘다. 이럴 땐 마지막으로 멀쩡했던 시점을 유지한다.
      if (ok && followSpread > 0) {
        const spread = rigSpread(focusMesh, followCur, focusBone);
        if (spread < followSpread * 0.05 || spread > followSpread * 5) ok = false;
      }
      }
      if (ok) {
        // 목표 타깃 = 처음 타깃 + (현재 중심 - 처음 중심)
        followWant.copy(initialTarget).add(followCur).sub(followBase);
        followDelta.copy(followWant).sub(controls.target);
        if (followDelta.lengthSq() > 1e-12) {
          controls.target.copy(followWant);
          camera.position.add(followDelta);
        }
      }
      // 추적이 걸리든 안 걸리든 카메라 거리·각도는 항상 처음 상태로 되돌린다.
      // 여기서 일찍 빠져나가면 휠로 당긴 거리나 앞 프레임이 남긴 어긋남이 그대로 남는다.
      if (homeCamPos && homeTarget) {
        camOffset.copy(homeCamPos).sub(homeTarget);
        camWant.copy(controls.target).add(camOffset);
        if (camWant.distanceToSquared(camera.position) > 1e-12) camera.position.copy(camWant);
      }
    }

    // 페이즈마다 idle 포즈가 다른 보스(예: 알트아이젠 - 런처 파츠가 1페이즈 idle에서는
    // 접힌 자세, 2페이즈 idle에서는 펼쳐진 자세)가 있다 - 파츠 표시만 바꾸고 애니메이션은
    // 그대로 두면, 2페이즈 전용 파츠가 1페이즈 포즈로 남아서 동떨어져 보인다.
    // 클립 이름에서 현재 페이즈에 해당하는 idle을 찾아 재생하고, 없으면(대부분의 보스는
    // idle 클립이 하나만 남아있음) 아무 idle이나 첫 클립으로 폴백한다.
    // 순수 대기 동작만 고른다.
    // 배열 순서로 아무 idle 이나 집으면 프로비던스처럼 2phase_air_idle_01 이 먼저
    // 걸린다 — 그러면 페이즈 태그 때문에 전환 클립까지 딸려 재생된다.
    // 온리 원은 idle_1phase / idle_2phase 처럼 페이즈 태그가 이름 끝에 온다.
    // 그대로 보면 대기 동작으로 안 잡혀서, 페이즈를 바꿔도 1페이즈 idle 이 계속 돌았다.
    // cc 는 경직 상태다(사치스러운 거미: cc_start_01 -> cc_idle -> cc_end_01).
    // 그 안의 대기 동작이 이름 순으로 idle_01 보다 앞이라, 걸러내지 않으면 보스를
    // 열자마자 경직 자세로 서 있게 된다.
    const isPlainIdle = n => /(^|_)idle(_\d+)?$/i.test(stripPhaseTail(n))
      && !/air|skill|(^|_)cc(_|$)/i.test(n || '');

    function findIdleClipForPhase(phase) {
      // 목록에서 뻔 클립은 여기서도 고르면 안 된다 — 그레이브 디거의 숨긴
      // phase0025_idle 이 자동 전환 직후에 텔려서 목록에 없는 동작이 돌았다.
      const all = gltf.animations || [];
      const shown = all.filter(a => !isHiddenClip(bossKey, a.name));
      const list = shown.length ? shown : all;
      if (!list.length) return null;
      if (phase !== null) {
        const m = list.find(a => isPlainIdle(a.name) && meshPhase(a.name) === phase);
        if (m) return m;
      }
      return list.find(a => isPlainIdle(a.name) && !clipPhase(a.name))
        || list.find(a => isPlainIdle(a.name))
        || list.find(a => /idle|wait|stand/i.test(a.name || ''))
        || list[0];
    }

    let currentAction = null;

    // 옆 머리(좌·우)를 그릴 복제본. 쓸 일이 있을 때 한 번만 만든다.
    // 스킨드메쉬는 그냥 clone() 하면 뼈대가 원본을 가리켜서 같이 움직인다.
    // SkeletonUtils.clone 이 뼈대까지 복제해 준다.
    const sideRigs = [];

    function ensureSideRigs() {
      if (sideRigs.length) return sideRigs;
      for (let i = 0; i < 2; i++) {
        const root = cloneSkinned(gltf.scene);
        root.visible = false;
        normGroup.add(root);
        sideRigs.push({ root, base: capturePose(root), mixer: null });
      }
      return sideRigs;
    }

    function hideSideRigs() {
      sideRigs.forEach(r => {
        r.root.visible = false;
        if (r.mixer) { r.mixer.stopAllAction(); r.mixer = null; }
        restorePose(r.base);
      });
    }

    // 세 머리를 동시에 재생한다. 가운데는 본체가, 좌·우는 복제본이 맡는다.
    function playTrio(trio) {
      seqQueue = [];
      const rigs = ensureSideRigs();
      playClipObject(trio.center, { repeat: 1, keepQueue: true, keepSides: true });
      [trio.left, trio.right].forEach((clip, i) => {
        const r = rigs[i];
        restorePose(r.base);
        r.root.visible = true;
        r.mixer = new THREE.AnimationMixer(r.root);
        const act = r.mixer.clipAction(clip);
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
        act.play();
      });
      markActiveClip(trio.center.name + '#trio');
      markPlayingClip(trio.center.name);
    }

    // 위쪽(연결 재생)은 지금 고른 항목을, 아래쪽(개별 클립)은 실제로 도는 클립을 켠다.
    // 묶음을 재생하면 start -> loop -> end 순서로 아래쪽에 차례로 불이 들어온다.
    // markActiveClip 이 호이스팅돼서 먼저 불리므로 선언은 여기 위쪽에 둔다.
    let activeMainKey = null;
    // 같은 클립을 두 묶음이 나눠 쓰면 버튼이 둘 생긴다 — 사치스러운 거미의
    // skill_fire_01 은 skill_01 과 skill_02 에 모두 들어 있다. 키만 보고 불을
    // 켜면 둘 다 켜져서, 엉뚱한 묶음 버튼에 진행 막대가 차고 누른 표시도 같이
    // 들어왔다. 지금 어느 묶음을 재생 중인지 같이 본다(묶음 밖 버튼은 그대로).
    // 아래 markActiveClip 은 호이스팅돼서 playSingle 이 먼저 부른다 — 선언이
    // 그쪽보다 뒤에 있으면 TDZ 에 걸린다.
    let uiSeqKey = null;

    // 클립 재생. 시퀀스(start->loop->end)를 위해 남은 단계를 큐로 들고 간다.
    // markActiveClip 은 아래 UI 블록에서 함수 선언으로 정의된다(호이스팅됨).
    let seqQueue = [];

    // 어떤 클립의 첫 프레임에서 추적 중심이 어디인지 미리 재둔다.
    // 실제로 그 클립을 한 프레임 적용해 보고 자세를 되돌리는 방식이라, 재생 중인
    // 화면에는 영향이 없다. 클립당 한 번만 재고 캐시한다.
    const startCenterCache = new Map();
    function centerAtClipStart(clip) {
      if (!focusMesh) return null;
      if (startCenterCache.has(clip.name)) return startCenterCache.get(clip.name);
      const saved = capturePose(gltf.scene);
      let result = null;
      try {
        const probeMixer = new THREE.AnimationMixer(gltf.scene);
        restorePose(poseFor(clip.name));
        probeMixer.clipAction(clip).play();
        probeMixer.update(0);
        gltf.scene.updateMatrixWorld(true);
        const v = new THREE.Vector3();
        if (rigCenter(focusMesh, v, focusBone)) result = v;
        probeMixer.stopAllAction();
        probeMixer.uncacheRoot(gltf.scene);
      } finally {
        restorePose(saved);
        gltf.scene.updateMatrixWorld(true);
      }
      startCenterCache.set(clip.name, result);
      return result;
    }

    // start 클립에 이어서 재생될 loop(없으면 fire/end) 클립.
    function nextStepClip(clip) {
      const m = (clip.name || '').match(SEQ_RE);
      if (!m || m[2].toLowerCase() !== 'start') return null;
      // 묶음을 재생 중이면 실제로 다음에 올 클립이 큐에 들어 있다. 이름 규칙으로
      // 짚으면 틀리는 경우가 있다 — 사치스러운 거미 그로기는 다음이 cc_idle 인데
      // 이름만 보면 cc_end_01 을 집는다(loop/fire/end 순으로 찾기 때문).
      if (seqQueue.length) return seqQueue[0].clip;
      const prefix = m[1], suffix = m[3] || '';
      const list = gltf.animations || [];
      for (const kind of ['loop', 'fire', 'end']) {
        const found = list.find(c => c.name === prefix + '_' + kind + suffix);
        if (found) return found;
      }
      return null;
    }

    function playClipObject(clip, opts) {
      opts = opts || {};
      // 세 머리 재생이 아니면 옆 머리는 치운다
      if (!opts.keepSides) hideSideRigs();
      // 등장·사망처럼 보스가 반대로 서 있는 연출은 모델을 돌려서 맞춘다.
      // 자세·카메라 측정보다 먼저 해야 담김 계산이 돌린 뒤 기준으로 나온다.
      setClipYaw(clip.name);
      // 앞 클립이 옮겨놓은 본을 원위치로. 믹서 교체만으로는 트랙 없는 본이 안 돌아온다.
      restorePose(poseFor(clip.name));
      // mixer.stopAllAction() + 캐시된 action을 reset/play로 재사용하면 3D 렌더링에
      // 눈에 보이는 변화는 없이 내부 바인딩 상태만 꼬이는 경우가 있어 — 믹서를 아예
      // 새로 만들어서 확실하게 교체한다.
      mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.addEventListener('finished', onClipFinished);
      const action = mixer.clipAction(clip);
      if (opts.repeat) {
        action.setLoop(opts.repeat === 1 ? THREE.LoopOnce : THREE.LoopRepeat, opts.repeat);
        action.clampWhenFinished = true;
      }
      action.play();
      currentAction = action;
      // 같은 연출을 나눠 맡는 다른 몸들. 대표 클립과 길이가 같고 건드리는 뼈가
      // 안 겹치므로 같은 믹서에 그대로 얹으면 된다. finished 는 대표 클립 것만
      // 받으므로(onClipFinished 가 클립으로 가른다) 다음 클립 넘김도 안 꼬인다.
      (simulClipsFor(bossKey, clip.name, gltf.animations) || []).forEach(c => {
        const a = mixer.clipAction(c);
        if (opts.repeat) {
          a.setLoop(opts.repeat === 1 ? THREE.LoopOnce : THREE.LoopRepeat, opts.repeat);
          a.clampWhenFinished = true;
        }
        a.play();
      });
      // 새 클립을 시작할 때는 시점을 홈으로 되돌린다.
      // 리그가 망가진 채 끝나는 클립이 있다 — 거대 질량체 death 는 본을 25 유닛
      // 흩뿌리고, 그러면 추적이 마지막 성한 자리에 시점을 붙들어 둔다. 그 상태가
      // 다음 클립까지 넘어가면 시점이 (5.1, 1.4, -0.6) 에 얼어붙어서, 그 뒤로 뭘
      // 재생하든 화면이 통째로 빈다.
      resetViewToHome();

      // 이 클립에 인게임 카메라가 붙어 있으면 같이 재생하고, 그동안 시점을 그쪽에 맡긴다.
      const camPair = camPairs.byModel.get(clip.name);
      cinematic = null;
      clearClipMeshAct();
      if (camPair) {
        const camAct = mixer.clipAction(camPair.clip);
        camAct.setLoop(THREE.LoopOnce, 1);
        camAct.clampWhenFinished = true;
        camAct.play();
        // 겨냥 대상 본. 여러 개가 걸리면 그 뭉치의 한가운데를 본다 —
        // 베히모스 크레인은 본이 139개로 쪼개져 있어서 하나만 집으면 흔들린다.
        const stages = (cameraLookAtFor(bossKey, clip.name) || []).map(la => {
          let bones = [];
          if (la.mesh) {
            // 메쉬로 지정하면 그 메쉬가 실제로 쓰는 본만 모은다(skinIndex 기준).
            const target = meshes.find(m => la.mesh.test(m.name || ''));
            if (target) bones = focusBonesOf(target).slice();
          } else if (la.bone) {
            gltf.scene.traverse(o => {
              if (o.isBone && la.bone.test(o.name || '')) bones.push(o);
            });
          }
          return { bones, from: la.from || 0, blend: la.blend || 0, fixDist: la.fixDist || 0 };
        }).filter(o => o.bones.length);
        const fix = cameraFixFor(bossKey, clip.name);
        // 타임라인 배치. 카메라와 모델 클립이 타임라인에서 서로 다른 시각에
        // 놓인 연출이 있다 - 애니힐리오 1페 등장은 모델이 3.033 초 늦게
        // 시작한다. glb 는 둘 다 로컬 0 부터 굽기 때문에 그 차이를 여기서 낸다.
        //   모델 로컬 = 카메라 로컬 + (timelineStart - pairedClipTimelineStart)
        const cex = (camPair.node && camPair.node.userData) || {};
        const tlOff = (typeof cex.timelineStart === 'number'
          && typeof cex.pairedClipTimelineStart === 'number')
          ? cex.timelineStart - cex.pairedClipTimelineStart : 0;
        // 메쉬별 활성 구간(타임라인 기준). 연출 내내 켜져 있는 항목은 버린다.
        const maDur = cex.timelineDuration || 0;
        const meshAct = Array.isArray(cex.meshActivation)
          ? cex.meshActivation.filter(o => o && o.name
              && !(o.start <= 1e-6 && o.end >= maDur - 1e-6))
          : [];
        meshActNames = new Set(meshAct.map(o => String(o.name)));
        clipMeshOn = null;
        clipMeshKey = null;
        cinematic = { action: camAct, clip: camPair.clip, node: camPair.node,
          timeOffset: tlOff, meshAct: meshAct.length ? meshAct : null,
          camStart: (typeof cex.timelineStart === 'number') ? cex.timelineStart : 0,
          zoom: camZoom.get(clip.name) || 1, aim: camAim.get(clip.name) || null,
          near: camNear.get(clip.name) || 0, rescue: !!fix.rescue,
          rollDeg: fix.rollDeg || 0,
          rollFrom: fix.rollFrom || 0,
          rollTo: (typeof fix.rollTo === 'number') ? fix.rollTo : Infinity,
          flip: camNeedsFlip(clip.name),
          // 이 연출을 파일 값 그대로 쓸지. 클립 단위로 갈리므로 여기서 정해 둔다.
          raw: rawCamFor(bossKey, clip.name),
          move: clipCamMoveFor(bossKey, clip.name),
          lookAtFocus: AIM_ALL || AIM_CUT || aimCutForBoss(bossKey) || !!fix.lookAtFocus,
          // 'all' 은 매 프레임 겨냥, 'cut' 은 컷 머리에서 맞추고 천천히 따라가기.
          aimMode: AIM_ALL ? 'all' : ((AIM_CUT || aimCutForBoss(bossKey)) ? 'cut' : null),
          lookAt: stages.length ? stages : null, idleAngle: !!fix.idleAngle,
          dist: fix.dist || 1, fixDist: fix.fixDist || 0,
          aimY: (typeof fix.aimY === 'number') ? fix.aimY : null };
        rescueW = 0;
      }
      // start 구간은 뒤따라올 loop 의 첫 자리에 시점을 붙들어 둔다.
      // start 는 파츠를 펼치는 준비 동작이라 리그가 크게 흔들리는데, 그걸 따라가면
      // 정작 loop 로 넘어갈 때 화면이 한 번 크게 튄다.
      const nextClip = nextStepClip(clip);
      followPin = nextClip ? centerAtClipStart(nextClip) : null;
      // 자세 측정 때문에 흐트러졌을 수 있으니 이 클립 첫 프레임을 다시 얹는다
      if (nextClip) mixer.update(0);
      // 바깥에서 재생 상태를 들여다볼 수 있게 걸어둔다(검증·디버깅용).
      state.mixer = mixer;
      state.currentClip = clip.name;
      clipSolo = clipSoloPartsFor(bossKey, clip.name);
      pickClipGlow(clip.name);
      applyVisibility();
      if (glowReady) applyGlow();
      applyClipCamLift(clip.name);
      markActiveClip(opts.keepQueue ? undefined : clip.name);
      markPlayingClip(clip.name);
    }

    // finished 는 mixer.update() 안에서 터진다. 그 자리에서 곧바로 다음 클립으로
    // 갈아타면, 포즈를 되돌린 직후 아직 돌고 있던 옛 믹서가 마지막 자세를 다시
    // 덮어쓴다(clampWhenFinished 로 끝 자세를 붙들고 있어서 더 그렇다).
    // 그러면 새 클립이 건드리지 않는 본은 앞 클립 자세로 굳는다 —
    // 검은 뱀은 등장 연출 뒤 몸집이 5배로 남았다(0.94 -> 4.81).
    // 그래서 여기서는 예약만 하고, 실제 교체는 다음 프레임 첫머리에서 한다.
    let pendingNext = null;

    function onClipFinished(e) {
      // 연출 카메라 클립도 같은 믹서에서 돌아서 자기 몫의 finished 를 한 번 더 쏜다.
      // 그대로 두면 묶음의 다음 클립이 큐에서 빠진 직후 두 번째 신호가 들어와
      // 그 클립을 idle 로 덮어쓴다 — 베히모스 take2 다음 take3 가 그렇게 잘렸다.
      // 다만 카메라가 시계 노릇을 하는 연출은 모델 액션을 세워 두기 때문에
      // 모델 쪽 finished 가 아예 안 온다. 그때는 카메라의 신호를 받는다.
      if (e && e.action) {
        const isModel = e.action.getClip() === (currentAction && currentAction.getClip());
        const isClock = camIsClock() && cinematic && e.action === cinematic.action;
        if (!isModel && !isClock) return;
      }
      if (seqQueue.length) {
        const step = seqQueue.shift();
        pendingNext = () => playClipObject(step.clip, { repeat: step.repeat, keepQueue: true });
        return;
      }
      // 전환 연출이 끝났고 자동 넘김이 켜져 있으면 다음 페이즈 모델로 간다.
      if (autoPhaseChain && autoPhaseAvailable() && isPhaseSwitchClip(state.currentClip)) {
        // 같은 모델 안에서 페이즈만 바꾸는 쪽은 여기서 바로 부르면 mixer.update()
        // 안에서 믹서를 갈아 끼우게 된다 — 다음 프레임으로 미룬다.
        if (autoPhaseRule.by === 'phase') { pendingNext = goToNextPhase; return; }
        if (goToNextPhase()) return;
      }
      const idle = findIdleClipForPhase(currentPhase);
      if (idle) pendingNext = () => playSingle(idle);
    }

    // 칩을 다음 것으로 넘긴다. 칩의 클릭 처리를 그대로 쓰므로 불러오기·목록
    // 다시 그리기가 알아서 따라온다.
    function goToNextPhase() {
      const byPhase = autoPhaseRule && autoPhaseRule.by === 'phase';
      const btns = [].slice.call(document.querySelectorAll(
        byPhase ? '#frames-phase-toggle .frames-phase-btn'
                : '#frames-model-toggle .frames-model-btn'));
      const at = btns.findIndex(b => b.classList.contains('active'));
      if (at < 0 || at + 1 >= btns.length) return false;
      // 모델을 새로 불러오는 쪽만 대기표가 필요하다. 페이즈 칩은 그 자리에서
      // 그 페이즈 대기 동작을 틀어 준다.
      if (!byPhase) autoPhasePending = true;
      btns[at + 1].click();
      return true;
    }

    function runPendingNext() {
      if (!pendingNext) return;
      const fn = pendingNext;
      pendingNext = null;
      fn();
    }

    // 고른 애니메이션의 부속 클립만 재생한다. 예전에는 다음 페이즈 클립을 고르면
    // 전환 클립(2phase_change 등)을 앞에 끼워 넣었는데, 그러면 2페이즈 동작을 볼
    // 때마다 매번 전환 연출을 거쳐가야 했다. 페이즈가 바뀐 자세는 poseFor() 가
    // 전환 클립의 끝 자세로 미리 맞춰 주므로 끼워 넣지 않아도 모습은 맞다.
    function playSequence(seq) {
      rerollClipGlow();
      uiSeqKey = seq.key;
      seqQueue = seq.steps.slice(1);
      playClipObject(seq.steps[0].clip, { repeat: 1, keepQueue: true });
      markActiveClip(seq.key);
    }

    // seqKey - 묶음 밑의 하위 버튼을 눌러서 온 경우 그 묶음 이름.
    function playSingle(clip, seqKey) {
      rerollClipGlow();
      uiSeqKey = seqKey || null;
      seqQueue = [];
      playClipObject(clip, { repeat: isOneShot(clip.name) ? 1 : 0 });
    }

    function updateAnimationForPhase() {
      // 목록도 지금 페이즈의 클립만 남게 다시 그린다.
      if (renderAnimList) renderAnimList();
      const clip = findIdleClipForPhase(currentPhase);
      if (clip) playSingle(clip);
    }

    if (gltf.animations && gltf.animations.length > 0) {
      playSingle(findIdleClipForPhase(currentPhase));
    }

    const resetBtn = document.getElementById('frames-spine-reset');
    if (resetBtn) {
      resetBtn.onclick = () => {
        if (container.__framesModel3D !== state) return;
        camera.position.copy(homeCamPos);
        controls.target.copy(homeTarget);
        // 팬으로 옮겨둔 추적 기준도 홈으로 되돌린다
        initialTarget.copy(homeTarget);
        if (focusMesh) rigCenter(focusMesh, followBase, focusBone);
        controls.update();
      };
    }

    const pauseBtn = document.getElementById('frames-spine-pause');
    if (pauseBtn) {
      pauseBtn.onclick = () => {
        if (container.__framesModel3D !== state) return;
        state.paused = !state.paused;
        pauseBtn.innerHTML = state.paused
          ? '<i class="fas fa-play"></i>'
          : '<i class="fas fa-pause"></i>';
        pauseBtn.title = state.paused ? '재생' : '일시정지';
      };
    }

    // 애니메이션 목록. 클립이 idle 하나뿐인 보스(기존 테두리 보스 대부분)에서는
    // 아무것도 그리지 않고 숨긴 채로 둔다.
    // 이 함수는 호이스팅되어 위쪽 playSingle() 에서 먼저 불린다. 그래서 컨테이너를
    // 바깥 const 로 잡아두면 TDZ 에 걸린다 — 부를 때마다 직접 찾는다.
    const seqMatch = b => !b.dataset.seq || b.dataset.seq === uiSeqKey;

    function markActiveClip(key) {
      if (key !== undefined) activeMainKey = key;
      document.querySelectorAll('#frames-anim-toggle .frames-anim-btn').forEach(b => {
        b.classList.toggle('active',
          activeMainKey !== null && b.dataset.key === activeMainKey && seqMatch(b));
      });
    }

    // 지금 실제로 도는 클립. 묶음을 재생하면 소속 클립에 차례로 불이 들어온다.
    function markPlayingClip(name) {
      document.querySelectorAll('#frames-anim-toggle .frames-anim-btn').forEach(b => {
        const on = b.dataset.key === name && seqMatch(b);
        b.classList.toggle('playing', on);
        if (!on) b.style.removeProperty('--anim-progress');
      });
    }

    const animEl = document.getElementById('frames-anim-toggle');
    if (animEl) {
      const seqs = findSequences(gltf.animations || [], bossKey);
      buildSyntheticSequences(seqs);
      measureCameraFlip();
      measureCameraZoom();
      measureCameraAim();
      measureCameraNear();
      // 카메라 클립은 목록에 내지 않는다 — 짝이 되는 모델 클립을 재생할 때 같이 돈다.
      const clips = (gltf.animations || [])
        .filter(c => !cameraClipNames.has(c.name) && !isHiddenClip(bossKey, c.name));
      // 라벨에서 보스 코드를 뗀다. detectBossCode 는 메쉬 이름에서 뽑는데 클립과
      // 접두사가 다른 보스가 있어서(애니힐리오 1페이즈: 메쉬 xbga03_, 클립 xba003_)
      // 그 값으로 지우면 하나도 안 벗겨진다. 코드 자리를 패턴으로 잡는다.
      // 한 파일에 페이즈가 여럿이면 페이즈 태그는 남겨야 서로 구분이 된다.
      // 태그가 붙은 클립과 안 붙은 클립이 섞여 있으면 태그를 남겨야 한다.
      // (프로비던스: air_idle_01 과 2phase_air_idle_01 이 둘 다 "air_idle_01" 로 보였다)
      const multiPhase = new Set(clips.map(c => clipPhase(c.name))).size > 1;
      const stripCodeRe = multiPhase
        ? /^[a-z]{2,4}\d{3}_/i
        : /^[a-z]{2,4}\d{3}_(\d?\d?phase_)?/i;
      const label = name => String(name).replace(stripCodeRe, '');
      // 손으로 정해 둔 이름이 있으면 그쪽이 이긴다
      const labelOf = (raw, fallback) => {
        const fix = CLIP_LABEL_FIX.find(
          o => o.boss.test(bossKey || '') && o.re.test(raw || ''));
        return fix ? fix.label : fallback;
      };

      // 구형 변환본은 클립이 idle(또는 페이즈별 idle) 뿐이고 그 전환은 페이즈 토글이
      // 이미 담당한다. 거기에 애니메이션 목록까지 띄우면 역할이 겹치고, 클립만 바꾸면
      // 파츠 표시와 어긋난다. 신형 추출본에서만 목록을 낸다.
      if (isCatalogExport && clips.length > 1) {
        animEl.classList.remove('hidden');

        // 묶음과 그 구성 클립을 한 목록에 계층으로 편다.
        //   idle                 <- 단독
        //   groggy               <- 묶음(왼쪽 세로 강조선)
        //     groggy_start       <- 그 묶음에 속한 클립, 들여쓰기
        //     groggy_loop
        //     groggy_end
        //   death                <- 단독
        // skill_idle 처럼 앞에 다른 말이 붙은 것은 대기 동작이 아니라 단독 클립이다.
        // cc_idle 은 그로기 묶음 안에 들어가는 대기 동작이다. 여기서 걸러내지 않으면
        // 대기 동작 줄에 한 번, 묶음 밑에 한 번 해서 두 번 나온다.
        const isIdle = c => /(^|_)idle(_\d+)?$/i.test(stripPhaseTail(c.name))
          && !/skill|(^|_)cc(_|$)/i.test(c.name || '');
        // dead / death 표기가 보스마다 다르다
        const isSolo = c => /(^|_)(dead|death|appearance|appeanrance|phase_?change)/i.test(c.name || '');

        // 연출 길이. 카메라 클립이 모델보다 길게 놓인 연출은 카메라가 시계라서
        // (애니힐리오 1페 등장은 카메라 8.00초 / 모델 5.00초) 그쪽 길이를 적는다.
        // 재생바도 같은 값을 쓴다 - 버튼만 5초라고 적히면 헷갈린다.
        const playDur = c => {
          const pair = camPairs.byModel.get(c.name);
          if (!pair || !pair.node || !pair.node.userData) return c.duration;
          const u = pair.node.userData;
          if (typeof u.timelineStart !== 'number'
            || typeof u.pairedClipTimelineStart !== 'number') return c.duration;
          if (u.timelineStart >= u.pairedClipTimelineStart) return c.duration;
          return (pair.clip && pair.clip.duration) || c.duration;
        };
        const secs = n => n.toFixed(2) + 's';
        const inSeq = new Set();
        seqs.forEach(sq => { if (!sq.synthetic) sq.steps.forEach(st => inSeq.add(st.clip.name)); });

        const mkBtn = (key, text, time, cls, seq) =>
          `<button type="button" class="f3d-btn frames-anim-btn${cls ? ' ' + cls : ''}"`
          + ` data-key="${key}"${seq ? ` data-seq="${seq}"` : ''}>`
          + `<span class="anim-name">${text}</span><span class="anim-time">${time}</span></button>`;

        // 종류별로 나눈다. 배열 순서가 곧 화면 순서다 —
        // 페이즈 전환 / 등장·사망 / 기본 / 그로기 / 스킬 / 샷.
        // 지상·공중은 따로 두지 않고 기본 구역에 합치되, 아래 laneOf 로 갈래를
        // 나눠서 서로 섞이지는 않게 한다.
        const GROUPS = ['페이즈 전환', '등장·사망', '기본', '그로기', '스킬', '샷'];
        // 이름에 skill 이 들어 있어도 실제로는 대기 동작인 클립. 이름만 보면
        // 스킬 구역으로 가는데, 애니힐리오 2phase_skill_idle 은 스킬을 쓸 자세로
        // 서 있는 대기 동작이라 기본 구역이 맞다.
        const BASE_DESPITE_NAME = [
          { boss: /^xba003/i, re: /_2phase_skill_idle$/i },
        ];
        const isBaseDespiteName = (n) => BASE_DESPITE_NAME.some(
          o => o.boss.test(bossKey || '') && o.re.test(n));
        const isAppearName = n => /(^|_)appea/i.test(n);           // appearance / appeanrance
        const isDeadName = n => /(^|_)(dead|death)/i.test(n);
        const isAirName = n => /(^|_)air/i.test(n);
        const groupOf = (name) => {
          const n = String(name);
          if (isBaseDespiteName(n)) return '기본';
          if (isPhaseSwitchClip(n)) return '페이즈 전환';
          if (isAppearName(n) || isDeadName(n) || isAppearanceClip(n)) return '등장·사망';
          if (/(^|_)(groggy|cc)(_|\d|$)/i.test(n)) return '그로기';
          if (/(^|_)shot(_|\d|$)/i.test(n)) return '샷';
          if (/(^|_)skill(_|\d|$)/i.test(n)) return '스킬';
          return '기본';
        };
        // 한 구역 안의 갈래. 번호보다 먼저 이 값으로 세운다.
        const laneOf = (group, name) => {
          const n = String(name);
          if (group === '등장·사망') return isDeadName(n) ? 1 : 0;  // 사망이 아래
          // 공중을 먼저 본다 — air_idle_01 은 대기 동작이기도 해서, 순서를 바꾸면
          // 지상 대기 동작 옆에 붙어 버린다.
          if (group === '기본') {
            return isAirName(n) ? 2 : ((isIdle({ name: n }) || isBaseDespiteName(n)) ? 0 : 1);
          }
          return 0;
        };

        // 좌우 머리가 함께 나오는 연출은 하나로 묶는다. 낱개 좌·우 클립은 목록에서 뺀다
        // — 혼자 틀어봐야 옆 머리 하나만 허공에서 움직인다.
        const trios = findTrios(clips, bossKey);
        const trioSide = new Set();
        trios.forEach(t => { trioSide.add(t.left.name); trioSide.add(t.right.name); });
        const trioByCenter = new Map(trios.map(t => [t.center.name, t]));

        // 이름 끝의 번호. 같은 갈래 안에서 번호 순으로 세우는 데 쓴다 —
        // 묶음이 없는 낱개 클립(거대 질량체 skill_fire_09 는 start/loop 이 없다)이
        // 파일 순서대로 맨 뒤에 붙어서 10 번 뒤에 서 있었다.
        const seqNo = (name) => {
          const m = String(name).match(/_(\d+)$/);
          return m ? Number(m[1]) : Infinity;
        };

        // 한 파일에 페이즈가 여럿인 보스(온리 원)는 지금 고른 페이즈의 클립만 낸다.
        // groggy_1phase / groggy_2phase 처럼 페이즈가 확실히 갈린 동작이 양쪽에 다
        // 보이면 어느 쪽이 지금 모습인지 알 수 없다.
        const phaseFiltered = singleFilePhases && phaseKeys.length > 1;
        const inCurrentPhase = (name) => {
          if (!phaseFiltered) return true;
          if (clipExtraPhase(bossKey, name, currentPhase)) return true;
          const p = clipPhaseOverride(bossKey, name) || foldPhase(clipPhase(name));
          return !p || p === currentPhase;
        };

        renderAnimList = function () {
          const bucket = {};
          GROUPS.forEach(g => { bucket[g] = []; });
          // 묶음은 하위 버튼까지 한 덩어리로 넣는다. 안 그러면 번호로 다시 세울 때
          // 자식이 부모에게서 떨어진다.
          const push = (name, html, order) => {
            const g = groupOf(name);
            bucket[g].push({
              html,
              lane: laneOf(g, name),
              order: order === undefined ? Infinity : order,
            });
          };

          // 1) 대기 동작
          clips.filter(c => isIdle(c) && inCurrentPhase(c.name))
            .forEach(c => push(c.name,
              mkBtn(c.name, labelOf(c.name, label(c.name)), secs(playDur(c)))));
          // 2) 묶음 + 소속 클립
          seqs.forEach(sq => {
            if (!inCurrentPhase(sq.steps[0].clip.name)) return;
            const total = sq.steps.reduce((a, st) => a + st.clip.duration * (st.repeat || 1), 0);
            let html = mkBtn(sq.key, labelOf(sq.key, label(sq.label)), secs(total), 'is-seq');
            // 합성 묶음(파일에 없는 스킬을 원본 클립을 잘라 만든 것)은 하위 버튼을 내지
            // 않는다 — 재료 클립 버튼과 키가 겹치고, 잘라낸 클립은 clips 목록에 없다.
            if (!sq.synthetic) {
              const seen = new Set();
              sq.steps.forEach(st => {
                if (seen.has(st.clip.name)) return;
                seen.add(st.clip.name);
                html += mkBtn(st.clip.name, labelOf(st.clip.name, label(st.clip.name)),
                  secs(st.clip.duration), 'is-child', sq.key);
              });
            }
            push(sq.key, html, seqNo(sq.key));
          });
          // 3) 나머지
          clips.forEach(c => {
            if (inSeq.has(c.name) || isIdle(c) || trioSide.has(c.name)) return;
            if (!inCurrentPhase(c.name)) return;
            const trio = trioByCenter.get(c.name);
            if (trio) {
              // 머리 셋이 동시에 나오는 연출
              push(c.name,
                mkBtn(c.name + '#trio', label(c.name) + '  (머리 3개)', secs(playDur(c)), 'is-seq'));
              return;
            }
            push(c.name,
              mkBtn(c.name, labelOf(c.name, label(c.name)), secs(playDur(c)),
                isSolo(c) ? '' : 'is-extra'),
              seqNo(c.name));
          });

          const parts = [];
          GROUPS.forEach(g => {
            if (!bucket[g].length) return;
            // 갈래 -> 번호 순. 번호가 없으면 원래 자리를 지킨다.
            const items = bucket[g]
              .map((it, i) => ({ ...it, i }))
              .sort((a, b) => (a.lane - b.lane) || (a.order - b.order) || (a.i - b.i));
            let html = '';
            items.forEach((it, i) => {
              // 갈래가 바뀌는 자리에 가는 선을 넣어, 합쳐 둔 갈래끼리 눈으로 갈리게 한다.
              if (i > 0 && it.lane !== items[i - 1].lane) html += '<span class="anim-lane-split"></span>';
              html += it.html;
            });
            // 구역 이름 줄. 페이즈 전환에는 자동 넘김 토글을 오른쪽 끝에 얹는다
            // (해당 보스만) — 이름 옆이 비어 있어서 가운데를 비우고 양끝으로 민다.
            let head = `<span class="anim-group-label">${g}</span>`;
            if (g === '페이즈 전환' && autoPhaseAvailable()) {
              head = `<div class="anim-group-head">${head}`
                + `<div class="toggle-switch-wrap anim-auto-phase frames-auto-phase`
                + `${autoPhaseChain ? ' active' : ''}" role="switch"`
                + ` aria-checked="${autoPhaseChain}" title="전환 연출이 끝나면 다음 페이즈로 이어서 재생">`
                + `<span class="toggle-label">자동 전환</span>`
                + `<div class="toggle-switch"></div></div></div>`;
            }
            parts.push(`<div class="anim-group">${head}${html}</div>`);
          });

          animEl.innerHTML = parts.join('');

          const autoBtn = animEl.querySelector('.frames-auto-phase');
          if (autoBtn) {
            autoBtn.addEventListener('click', () => {
              if (container.__framesModel3D !== state) return;
              autoPhaseChain = !autoPhaseChain;
              autoBtn.classList.toggle('active', autoPhaseChain);
              autoBtn.setAttribute('aria-checked', String(autoPhaseChain));
            });
          }

          document.querySelectorAll('#frames-anim-toggle .frames-anim-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              if (container.__framesModel3D !== state) return;
              const key = btn.dataset.key;
              if (key.endsWith('#trio')) {
                const t = trioByCenter.get(key.slice(0, -5));
                if (t) playTrio(t);
                return;
              }
              const sq = seqs.find(x => x.key === key);
              if (sq) playSequence(sq);
              else {
                const clip = clips.find(c => c.name === key);
                if (clip) playSingle(clip, btn.dataset.seq || null);
              }
            });
          });
        };

        renderAnimList();
        markActiveClip((findIdleClipForPhase(currentPhase) || {}).name || null);

        // 앞 페이즈의 전환 연출이 끝나서 넘어온 참이면 이쪽 전환 연출을 바로 튼다.
        if (autoPhasePending) {
          autoPhasePending = false;
          // 규칙에 이어서 틀 클립을 적어 뒀으면 그쪽을 먼저 본다.
          const nextRe = autoPhaseRule && autoPhaseRule.next;
          const hit = c => (nextRe ? nextRe.test(c.name || '') : isPhaseSwitchClip(c.name))
            && inCurrentPhase(c.name);
          const sw = seqs.find(sq => hit(sq.steps[0].clip)) || null;
          const swClip = sw ? null : clips.find(hit);
          if (sw) playSequence(sw);
          else if (swClip) playSingle(swClip);
        }
      } else {
        animEl.classList.add('hidden');
        animEl.innerHTML = '';
      }
    }

    // 조작 패널에서 비어 있는 그룹(라벨만 남은 줄)을 감춘다
    if (window.syncFramesCtlGroups) window.syncFramesCtlGroups();

    if (onLoaded) onLoaded({ meshCount: meshes.length });

    // ── 재생바 ────────────────────────────────────────────────────
    const barEl = document.getElementById('frames-playbar');
    const lineEl = document.getElementById('frames-timeline');
    const fillEl = document.getElementById('frames-timeline-fill');
    const codeEl = document.getElementById('frames-timecode');

    if (barEl) barEl.classList.toggle('hidden', !(gltf.animations && gltf.animations.length));

    function seekToRatio(ratio) {
      if (!currentAction) return;
      if (camIsClock()) {
        const cd = cinematic.action.getClip().duration || 0;
        const ct = Math.max(0, Math.min(cd, cd * ratio));
        cinematic.action.time = ct;
        cinematic.action.paused = false;
        cinematic.action.enabled = true;
        aimCutPrev.valid = false;
        if (mixer) mixer.update(0);
        syncBar();
        return;
      }
      const dur = currentAction.getClip().duration || 0;
      const t = Math.max(0, Math.min(dur, dur * ratio));
      currentAction.time = t;
      currentAction.paused = false;
      currentAction.enabled = true;
      // 연출 카메라가 붙어 있으면 같이 옮긴다. 안 그러면 모델만 움직이고
      // 화면은 그대로라 재생바가 안 먹는 것처럼 보인다. 카메라 클립이 모델보다
      // 길거나 짧은 연출이 있어서(애니힐리오 1페는 카메라 8.00초 / 모델 5.00초)
      // 각자 길이로 잘라 넣는다.
      if (cinematic && cinematic.action) {
        const cd = cinematic.action.getClip().duration || 0;
        const ct = t - (cinematic.timeOffset || 0);
        cinematic.action.time = Math.max(0, Math.min(cd, ct));
        cinematic.action.paused = false;
        cinematic.action.enabled = true;
        // 컷 머리 겨냥은 앞 컷의 값을 들고 있으면 안 된다 — 다시 재게 한다.
        aimCutPrev.valid = false;
      }
      if (mixer) mixer.update(0);
      syncBar();
    }

    if (lineEl && !lineEl.__wired) {
      lineEl.__wired = true;
      const ratioAt = ev => {
        const r = lineEl.getBoundingClientRect();
        return r.width ? (ev.clientX - r.left) / r.width : 0;
      };
      let scrubbing = false;
      lineEl.addEventListener('pointerdown', ev => {
        scrubbing = true;
        lineEl.setPointerCapture(ev.pointerId);
        const st = container.__framesModel3D;
        if (st && st.seekToRatio) st.seekToRatio(ratioAt(ev));
      });
      lineEl.addEventListener('pointermove', ev => {
        if (!scrubbing) return;
        const st = container.__framesModel3D;
        if (st && st.seekToRatio) st.seekToRatio(ratioAt(ev));
      });
      const stop = () => { scrubbing = false; };
      lineEl.addEventListener('pointerup', stop);
      lineEl.addEventListener('pointercancel', stop);
    }
    state.seekToRatio = seekToRatio;

    // ── 발광색 ─────────────────────────────────────────────────────
    // 기본은 꺼둔다. 파츠 자체는 그대로 보이고 빛만 안 낸다.
    // "원본" 은 파일에 든 값, 나머지는 패턴별 색으로 바꿔 칠한다.
    // 발광 재질은 여러 파츠가 나눠 쓴다. 그대로 두면 한 파츠만 켤 수가 없다
    // (앨트루이아는 후광 아홉과 눈 둘이 같은 재질이다). 파츠마다 복제해서 갈라 둔다.
    meshes.forEach(m => {
      const one = mt => {
        if (!(mt && mt.userData && mt.userData.glowColor)) return mt;
        const c = mt.clone();
        // Material.copy 는 userData 를 JSON 으로 베낀다. 그런데 Color.toJSON 이
        // 16진수 숫자를 돌려줘서, 기억해 둔 발광색이 복제본에서는 Color 가 아니라
        // 숫자가 된다. 그걸 emissive.copy() 에 넣으면 r/g/b 가 undefined -> 셰이더
        // 에서 NaN 이 되고, 블룸의 가우시안 블러가 그 NaN 을 화면 전체로 퍼뜨려서
        // 뷰어가 통째로 검게 나온다. Color 로 되돌려 둔다.
        c.userData.glowColor = new THREE.Color(mt.userData.glowColor);
        // Material.copy 는 onBeforeCompile / customProgramCacheKey 도 안 베낀다.
        // 그래서 복제본에서는 프레넬(테두리) 감쇠가 통째로 빠져, 면 전체가 꽉 찬
        // 색으로 균일하게 빛났다 — 게임에서는 보는 각도에 따라 가장자리만 짙고
        // 가운데는 비쳐 보이는 부분이다. 복제본에도 다시 걸어 준다.
        applyFresnelGlow(c);
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(one) : one(m.material);
    });

    const glowMats = [];
    const glowOwner = new Map();
    meshes.forEach(m => [].concat(m.material).forEach(mt => {
      if (!(mt.userData && mt.userData.glowColor)) return;
      if (!glowMats.includes(mt)) glowMats.push(mt);
      glowOwner.set(mt, m);
    }));

    // 패턴에 따라 색이 바뀌는 건 fresnel 계열이다. 그런 재질이 없으면 전부에 칠한다.
    const patternMats = glowMats.filter(mt => /fresnel/i.test(mt.name || ''));
    const paintTargets = patternMats.length ? patternMats : glowMats;

    let glowMode = 'off';

    function applyGlow() {
      glowMats.forEach(mt => {
        const orig = mt.userData.glowColor;
        // 이 연출에서 켤 파츠가 정해져 있으면 그 파츠만 칠하고 나머지는 재운다.
        if (clipGlow && paintTargets.includes(mt)) {
          const owner = glowOwner.get(mt);
          const on = owner && clipGlow.parts.some(re => re.test(owner.name || ''));
          const p = on && GLOW_PRESETS.find(x => x.key === clipGlow.color);
          if (p && p.rgb) {
            mt.emissive.setRGB(p.rgb[0], p.rgb[1], p.rgb[2]);
            mt.emissiveIntensity = mt.userData.glowStrength;
          } else {
            mt.emissive.setRGB(0, 0, 0);
          }
          mt.needsUpdate = true;
          return;
        }
        if (!paintTargets.includes(mt)) {
          // 패턴과 무관한 상시 발광(몸체 띠 등)은 늘 파일 값 그대로
          mt.emissive.set(orig);
          mt.emissiveIntensity = mt.userData.glowStrength;
        } else if (glowMode === 'off') {
          // 평소 모습 — 패턴 색 파츠는 빛나지 않는다. 파일에 보라가 들어 있는 건
          // 패턴 중 한 색일 뿐이라, 그걸 상시로 켜두면 늘 보라로 빛나 보인다.
          // 꺼두면 아래 몸체가 그대로 비쳐서 head·weapon 과 같은 검은 금속이 된다.
          mt.emissive.setRGB(0, 0, 0);
        } else {
          const p = GLOW_PRESETS.find(x => x.key === glowMode);
          if (p && p.rgb) {
            // 색만 바꾸고 세기는 그 재질의 원래 값을 쓴다
            mt.emissive.setRGB(p.rgb[0], p.rgb[1], p.rgb[2]);
            mt.emissiveIntensity = mt.userData.glowStrength;
          }
        }
        mt.needsUpdate = true;
      });
      document.querySelectorAll('#frames-glow-toggle .f3d-btn')
        .forEach(b => b.classList.toggle('active', b.dataset.glow === glowMode));
    }

    const glowEl = document.getElementById('frames-glow-toggle');
    if (glowEl) {
      if (!glowMats.length) {
        glowEl.innerHTML = '';
      } else {
        glowEl.innerHTML = glowPresetsFor(bossCode).map(p =>
          `<button type="button" class="f3d-btn f3d-glow-btn${p.key === 'off' ? ' active' : ''}" data-glow="${p.key}">`
          + (p.css ? `<i style="background:${p.css}"></i>` : '') + p.label + '</button>'
        ).join('');
        glowEl.querySelectorAll('.f3d-btn').forEach(b => {
          b.addEventListener('click', () => {
            if (container.__framesModel3D !== state) return;
            glowMode = b.dataset.glow;
            applyGlow();
          });
        });
      }
      glowReady = true;
      applyGlow();
    }

    // 조작 패널 토글 연결
    applySliders();
    applyLookFlags();
    bindToggle('f3d-wire', () => optWire, v => { optWire = v; });
    bindToggle('f3d-alpha', () => optAlpha, v => { optAlpha = v; });
    bindToggle('f3d-single', () => optSingle, v => { optSingle = v; });

    const gridBtn = document.getElementById('f3d-grid');
    if (gridBtn) {
      gridBtn.classList.toggle('active', gridHelper.visible);
      gridBtn.onclick = () => {
        if (container.__framesModel3D !== state) return;
        gridHelper.visible = !gridHelper.visible;
        gridBtn.classList.toggle('active', gridHelper.visible);
      };
    }

    const followBtn = document.getElementById('f3d-follow');
    if (followBtn) {
      followBtn.classList.toggle('active', followEnabled);
      followBtn.onclick = () => {
        if (container.__framesModel3D !== state) return;
        followEnabled = !followEnabled;
        followBtn.classList.toggle('active', followEnabled);
        syncPanLock();
      };
    }
    syncPanLock();

    const zeroBtn = document.getElementById('f3d-zero');
    if (zeroBtn) {
      zeroBtn.onclick = () => {
        if (container.__framesModel3D !== state || !SL.yaw) return;
        const t = getBossTransform(bossCode, isCatalogExport);
        SL.yaw.value = t.rotation[1]; SL.pitch.value = t.rotation[0]; SL.roll.value = t.rotation[2];
        SL.px.value = t.position[0]; SL.py.value = t.position[1]; SL.pz.value = t.position[2];
        SL.sc.value = t.scale;
        applySliders();
      };
    }

    // 프레임 단위 이동 — 잠깐 나왔다 사라지는 파츠를 멈춰서 볼 때 쓴다
    function stepFrames(delta) {
      if (!currentAction) return;
      const dur = currentAction.getClip().duration || 0;
      currentAction.time = Math.max(0, Math.min(dur, currentAction.time + delta));
      state.paused = true;
      const pb = document.getElementById('frames-spine-pause');
      if (pb) pb.innerHTML = '<i class="fas fa-play"></i>';
      if (mixer) mixer.update(0);
      syncBar();
    }
    const backBtn = document.getElementById('frames-step-back');
    if (backBtn) backBtn.onclick = () => { if (container.__framesModel3D === state) stepFrames(-1 / 30); };
    const fwdBtn = document.getElementById('frames-step-fwd');
    if (fwdBtn) fwdBtn.onclick = () => { if (container.__framesModel3D === state) stepFrames(1 / 30); };

    const restartBtn = document.getElementById('frames-spine-restart');
    if (restartBtn) {
      restartBtn.onclick = () => {
        if (container.__framesModel3D !== state) return;
        seekToRatio(0);
      };
    }

    // 카메라 클립이 모델보다 길게 놓인 연출은 카메라가 시계 노릇을 한다.
    // 애니힐리오 1페 등장은 타임라인에서 카메라 0~8.033 초, 모델 3.033~8.033 초다
    // (하늘에서 떨어지는 연출이라 앞 3 초는 카메라만 움직인다). 모델 클립 길이인
    // 5 초로 재생하면 뒤 3 초가 통째로 잘린다.
    function camIsClock() {
      return !!(cinematic && cinematic.action && cinematic.timeOffset < 0);
    }
    function clockDuration() {
      if (camIsClock()) return cinematic.action.getClip().duration || 0;
      return currentAction ? (currentAction.getClip().duration || 0) : 0;
    }
    function clockTime() {
      if (camIsClock()) return cinematic.action.time;
      return currentAction ? currentAction.time : 0;
    }

    function syncBar() {
      if (!currentAction) return;
      const dur = clockDuration();
      const t = dur ? (clockTime() % dur) : 0;
      const pct = dur ? (t / dur) * 100 : 0;
      if (fillEl) fillEl.style.width = pct + '%';
      if (codeEl) codeEl.textContent = t.toFixed(2) + ' / ' + dur.toFixed(2);

      // 지금 도는 클립 버튼도 재생바처럼 색이 차오른다. 글자색만으로는 눈에 안 띈다.
      const pb = document.querySelector('#frames-anim-toggle .frames-anim-btn.playing');
      if (pb) pb.style.setProperty('--anim-progress', pct.toFixed(1) + '%');
    }

    // 한 프레임 진행. rAF 와 분리해 둬서 밖에서도 결정적으로 돌려볼 수 있다.
    state.step = (dt) => {
      // 예약된 클립 교체를 먼저 처리한다(옛 믹서가 이미 멈춘 뒤라 안전하다)
      runPendingNext();
      if (mixer && !state.paused) mixer.update(dt);
      if (!state.paused) sideRigs.forEach(r => { if (r.mixer) r.mixer.update(dt); });
      if (!applyCinematicCamera(dt)) {
        updateFollow();
        clampPan();
        controls.update();
      }
      if (composer) composer.render();
      else renderer.render(scene, camera);
      syncBar();
    };

    function animate() {
      if (container.__framesModel3D !== state) return; // dispose됨
      state.rafId = requestAnimationFrame(animate);
      // 다른 탭에 가 있는 동안은 한 프레임도 그리지 않는다. 안 보이는 곳에서
      // 계속 돌면 배터리와 GPU 만 먹는다. getDelta 는 버려서 돌아왔을 때
      // 그동안 흐른 시간이 한꺼번에 밀려들지 않게 한다.
      if (state.offscreen) { clock.getDelta(); return; }
      state.step(clock.getDelta());
    }
    animate();
    hideLoadingBar(mySeq);
  }, (e) => {
    // Content-Length 가 없으면(gzip 등) 비율을 못 낸다 — 받은 양만 보여준다.
    if (e && e.lengthComputable && e.total) {
      const pct = Math.min(100, e.loaded / e.total * 100);
      setLoadingBar(mySeq, pct,
        (e.loaded / MB).toFixed(1) + ' / ' + (e.total / MB).toFixed(1) + ' MB');
      // 다 받고 나면 압축 해제·텍스처 올리기가 남는다. 그 구간은 길이를 모른다.
      if (pct >= 100) setLoadingBar(mySeq, null, '준비 중');
    } else {
      setLoadingBar(mySeq, null, e ? (e.loaded / MB).toFixed(1) + ' MB' : '');
    }
  }, (err) => {
    console.error('[역대 테두리 3D] 모델 로드 실패:', err);
    hideLoadingBar(mySeq);
    if (onError) onError(err);
  });
};
