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
const PHASE_MODE_OVERRIDES = {
  mbg001: { mode: 'phase1-all' }, // 알트아이젠 - 1페이즈는 전체 파츠, 2페이즈는 phase002 파츠만
  xba001: { mode: 'exclusive' },  // 미러 컨테이너 - 2페이즈에서 1phase 파츠는 전부 사라진다
  xbg005: { mode: 'exclusive' },  // 에고비스타 - 페이즈마다 깃털이 통째로 갈린다
};

function getPhaseConfig(bossCode) {
  const raw = PHASE_MODE_OVERRIDES[bossCode];
  if (!raw) return { mode: 'cumulative' };
  if (typeof raw === 'string') return { mode: raw };
  return { mode: raw.mode || 'cumulative' };
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
  ['무기', /(^|_)(weapon|gun|rifle|turret|shield|sword|magazine|missile|launcher|led)/i],
  // parts_ul / parts_dr 처럼 방향만 붙은 부속 파츠
  ['부속', /(^|_)parts?(_|\d|$)/i],
  // 거대 질량체(eba004) — main 이 몸체 전부고, 나머지 넷은 부위가 아니라
  // 등장·사망·특정 스킬에서만 펼쳐지는 연출/투사체 덩어리다.
  // idle 에서는 (0, 17.4, 8.8) 한 점에 접혀 있어서 크기가 0.1 유닛뿐이고,
  // death 에서 F_skin 이 1329, appearance 에서 C_skin 이 674 까지 펼쳐진다.
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
  { boss: /^xba003_1phase/i, re: /^xbga03_1phase_skin(_\d+)?$/i,
    base: 'xba003_1phase_skin', bySuffix: {} },
  { boss: /^xba003_1phase/i, re: /^xbga03_1phase_dl_skin(_\d+)?$/i,
    base: 'xba003_1phase_dl_skin', bySuffix: {} },
  { boss: /^xba003_1phase/i, re: /^xbga03_1phase_dr_skin(_\d+)?$/i,
    base: 'xba003_1phase_dr_skin', bySuffix: {} },
  { boss: /^xba003_1phase/i, re: /^xbga03_1phase_ul_skin(_\d+)?$/i,
    base: 'xba003_1phase_ul_skin', bySuffix: {} },
  { boss: /^xba003_1phase/i, re: /^xbga03_1phase_ur_skin(_\d+)?$/i,
    base: 'xba003_1phase_ur_skin', bySuffix: {} },
  // 애니힐리오 2페이즈 - 노드와 메쉬가 이름을 나눠 가져 붙는 꼬리표를 뗀다.
  { boss: /^xba003_2phase/i, re: /^(xba003_1phase_magiccarpet_skin)(_\d+)?$/i, bySuffix: {} },
  // 사치스러운 거미 - 노드와 메쉬가 같은 이름을 나눠 가져서 메쉬 쪽에 _1 이 붙는다.
  // 이름이 겹치는 메쉬는 없으니 꼬리표만 뗀다.
  { boss: /^bbg001/i, re: /^(bbg001_(?:body|legs_01|weapon_01))(_\d+)?$/i, bySuffix: {} },
];

function meshMatName(m) {
  const mt = Array.isArray(m.material) ? m.material[0] : m.material;
  return (mt && mt.name) || '';
}

// 한꺼번에 정해서 한 번에 갈아 끼운다. 하나씩 바꾸면 앞에서 바꾼 이름을 뒤에서 또 집는다.
function renameMeshes(bossKey, meshes) {
  const rules = MESH_RENAME.filter(o => o.boss.test(bossKey || ''));
  if (!rules.length) return;
  const next = meshes.map(m => {
    const mat = meshMatName(m);
    for (const o of rules) {
      if (o.bySuffix) {
        const hit = String(m.name || '').match(o.re);
        if (hit) return (o.base || hit[1]) + (o.bySuffix[mat] || '');
      } else if (o.re.test(m.name || '') && o.mat === mat) {
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
  { boss: /^xba003_2phase/i, re: /_turret03$/i },
];

function isDefaultOffMesh(bossKey, name) {
  return DEFAULT_OFF_MESHES.some(o => o.boss.test(bossKey || '') && o.re.test(name || ''));
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
  { boss: /^xba003_1phase/i, re: /_1phase_skin$/i, group: '몸통' },
  { boss: /^xba003_2phase/i, re: /_magiccarpet_skin$/i, group: '몸통' },
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
const CATALOG_FIT_OVERRIDES = {
  xbg003: { scale: 1.0, position: [0, 0, 0], camY: 0.05 },
  // 미러 컨테이너는 옆으로 넓고 위아래로 낮아서, 세로 크기로 잡는 기본 눈높이가
  // 보스 발치까지 내려온다. 보스 한가운데로 올린다.
  xba001: { scale: 1.0, position: [0, 0, 0], camY: 0.33 },
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
};

// 같은 보스라도 모델 항목(페이즈)마다 다르게 줘야 하면 "코드@페이즈" 로 적는다.
function catalogFitBase(bossCode, isCatalogExport, labelPhase) {
  if (!isCatalogExport) return {};
  return CATALOG_FIT_BASE[bossCode + '@' + labelPhase] || CATALOG_FIT_BASE[bossCode] || {};
}

// 클립 하나만 눈높이가 따로 필요한 경우. 그 클립을 재생하는 동안 카메라와 시선을
// 같은 값만큼 올린다 — 각도와 거리는 그대로다.
const CLIP_CAM_LIFT = [
  { boss: /^xbg003/i, re: /_take01$/i, y: 0.6 }, // 온리 원 take01
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

// 게임에는 있는데 전용 클립이 없는 스킬. 거대 질량체 05 번은 04 번 클립을 잘라 쓴다 —
// 타임라인이 skill_loop_04 를 1.17 초 지점부터, 이어서 skill_fire_04 를 통째로 얹는다.
// 그래서 파일에 *_05 라는 이름의 AnimationClip 이 아예 없다.
const SYNTHETIC_SEQUENCES = [
  {
    boss: /^eba004/i,
    key: 'skill_05',
    steps: [
      { re: /_skill_loop_04$/i, from: 1.17 },
      { re: /_skill_fire_04$/i },
    ],
  },
];

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
const CAMERA_FIX = [
  { boss: /^xbg002/i, aim: true },
  // 미러 컨테이너: 연출 카메라의 방향이 통째로 어긋난다. 뼈대 루트(*_var)에 걸린
  // 좌우 180도가 뼈대에만 걸리고 카메라 노드에는 안 걸려서, 보스만 홀로 뒤돌아
  // 있는 꼴이다. 그래서 방향은 기본 시점과 같게 잡고, 대상까지의 거리만 게임 값을
  // 따른다 — 다가오고 물러나는 카메라 워크는 그대로 남는다.
  // dist - 대상까지의 거리에 곱하는 값. 게임 값보다 조금 당겨 본다.
  { boss: /^xba001/i, idleAngle: true, dist: 0.85 },
  // 베히모스: 카메라 위치·화각은 게임 값이 맞는데 겨냥이 어긋난다(미러 컨테이너와
  // 같은 증상). 겨냥만 매 프레임 본체 중심으로 다시 잡는다.
  { boss: /^mbg003/i, lookAtFocus: true },
  // 앨트루이아: 등장·사망 카메라가 보스 뒤에 선다(등장 dz -3.15 ~ -2.17, idle 은 +2.25).
  // 방향은 기본 시점과 같게 두고 거리만 게임 값을 따른다.
  { boss: /^xbg004/i, lookAtFocus: true, idleAngle: true },
  // 에고비스타도 같다 — 등장 담김 0~99% 로 널뛰고 사망은 내내 0% 였다.
  // flip - 기본 시점의 반대편에서 잡는다. 등장·사망이 뒷모습이라 뒤집었다.
  { boss: /^xbg005/i, lookAtFocus: true, idleAngle: true, rescue: true },
  // 온리 원: 등장·사망 카메라가 모델을 관통하고 사망은 시작부터 뒤를 비춘다.
  // 되돌려 보정해도 원래 구도가 아니라, 아예 쓰지 않고 뷰어 시점으로 본다.
  // 카메라 클립은 목록에서 계속 감춘다 — 혼자 틀 게 아니다.
  { boss: /^xbg003/i, noCamera: true },
];

// 인게임 카메라가 바라보는 대상. Cinemachine 은 위치(Body)와 겨냥(Aim)을 따로
// 계산하는데, 내보내기에 겨냥 결과가 안 실려 오는 연출이 있다 — 미러 컨테이너
// 사망 카메라는 위치가 대상 주위를 정확히 돈다(거리 6.5~7.4 로 일정). 각도만
// 10~60 도씩 어긋난다. 그래서 위치·화각은 게임 값 그대로 쓰고, 겨냥만 이 본으로
// 매 프레임 다시 잡는다.
//   미러 컨테이너는 등장·사망 카메라가 전부 그렇다. 몸통 한가운데서 계속 도는
//   사각 부품(xba001_head)이 그 카메라들이 따라다니는 대상이다.
// clip 을 적지 않으면 그 보스의 연출 카메라 전부에 걸린다.
const CAMERA_LOOK_AT = [
  { boss: /^xba001/i, bone: /^[a-z]{2,4}\d{3}_head$/i },
  // 베히모스 1페이즈 등장 앞컷은 크레인이 주인공인데, 본체(y -2.09)와 크레인
  // (y -1.04)이 1 만큼 떨어져 있어서 본체를 중심에 두면 크레인이 화면 위끝
  // (화면 y +0.88)에 걸린다. 크레인 본 뭉치를 겨눈다.
  { boss: /^mbg003/i, clip: /_1phase_take1$/i, bone: /_exc_head_/i },
  // 뒷컷은 조립이 끝난 굴착기(1phase_ar_skin)가 주인공이다. 이 메쉬가 쓰는 본은
  // exc_body 계열이라 이름만으로는 본체와 안 갈린다 — 메쉬로 지정한다.
  { boss: /^mbg003/i, clip: /_1phase_take2$/i, mesh: /_1phase_ar_skin/i },
  // 에고비스타 사망은 도중에 겨냥이 바뀐다(인게임 확인) — 처음에는 몸통을
  // 잡다가, 대검이 땅에 꽂히는 순간부터 대검으로 넘어간다. 몸통은 body_skin 의
  // 척추·골반 본으로 잡는다. core 본은 1.8초부터 화면 밖(y 1.11)으로 튀고,
  // body_skin 전체 본(119개)을 쓰면 흩어지는 파편을 따라가 중심이 흔들린다. 본체 리그가 흩어지는
  // 클립이라 lookAtFocus 로는 둘 다 못 잡는다(카메라가 y -1.57 까지 내려가는데
  // 대검은 y +0.63 에 멈춰 있어 화면 위 -1.25 로 벗어났다).
  // 대검이 꽂히는 시점은 실측했다 — 1.6초에 y 3.12, 1.8초에 y 0.70, 그 뒤로는
  // 클립이 끝날 때까지 한 프레임도 안 움직인다.
  { boss: /^xbg005/i, clip: /_death$/i,
    bone: /^xbg005_(pelvis|spine_0[1-4])$/i, fixDist: 3 },
  { boss: /^xbg005/i, clip: /_death$/i, bone: /^xbg005_greatsword_(0[12]|parts_0[12])$/i,
    from: 1.7, blend: 0.5, fixDist: 2.5 },
];

// 한 클립에 여러 줄을 두면 시간순 단계가 된다. from 이 없으면 0초부터다.
function cameraLookAtFor(bossKey, clipName) {
  const hit = CAMERA_LOOK_AT.filter(
    o => o.boss.test(bossKey || '') && (!o.clip || o.clip.test(clipName || '')));
  return hit.length ? hit.slice().sort((a, b) => (a.from || 0) - (b.from || 0)) : null;
}

// 같은 보스 안에서 그 연출 하나만 따로 손봐야 할 때. 보스 설정 위에 덧씌운다.
const CLIP_CAMERA_FIX = [
  // 베히모스 페이즈 전환 뒤 두 컷은 카메라가 반대편에서 뒷모습을 잡는다.
  // 방향은 기본 시점과 같게 두고, 거리는 게임 값에서 조금 당긴다.
  { boss: /^mbg003/i, clip: /_2phase_take[23]$/i, idleAngle: true, dist: 0.6 },
  // 사망 첫 컷은 너무 붙어 있어서 뒤 컷과 크기가 안 맞는다. 물린다.
  { boss: /^mbg003/i, clip: /_dead$/i, dist: 2 },
  // 에고비스타 사망은 몸이 조각나 흩어진다. 구제 보정을 두면 그 파편까지 담으려고
  // 카메라가 10 이상 물러나서 본체가 점만 해진다. 이 클립만 끈다.
  { boss: /^xbg005/i, clip: /_death$/i, rescue: false },
  // 1페이즈 컷신도 카메라가 반대편에서 뒷모습을 잡는다. 방향은 기본 시점과 같게,
  // 거리는 게임 값에서 당긴다.
  { boss: /^mbg003/i, clip: /_1phase_take2$/i, idleAngle: true, dist: 0.7 },
  // take1 은 크레인이 본체와 따로 논다 — 정점 절반은 본체(y -1.9)에, 절반은
  // 격자 높이(y 0.1~0.36)에 떠 있다. 겨냥 높이를 격자(y 0)로 고정해 크레인 쪽을
  // 잡고, 흩어진 부품이 다 들어오게 거리를 물린다.
  { boss: /^mbg003/i, clip: /_1phase_take1$/i, idleAngle: true, dist: 0.9, aimY: 0 },
];

function cameraFixFor(bossKey, clipName) {
  const base = CAMERA_FIX.find(o => o.boss.test(bossKey || '')) || {};
  if (clipName === undefined) return base;
  const extra = CLIP_CAMERA_FIX.filter(
    o => o.boss.test(bossKey || '') && o.clip.test(clipName || ''));
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
  // 베히모스 - 페이즈 전환 연출의 뒤 두 컷
  {
    key: 'mbg003_2phase_take',
    steps: [/^mbg003_2phase_take2$/i, /^mbg003_2phase_take3$/i],
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
function findTrios(clips) {
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
  { re: /_appearance(_take\d+)?$/i, boss: /^(xbg003|xba001)/i, phase: '1' },
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
];

function clipPhaseOverride(bossKey, name) {
  const o = CLIP_PHASE_OVERRIDES.find(
    x => x.boss.test(bossKey || '') && x.re.test(name || ''));
  return o ? o.phase : null;
}

// 클립 이름에 붙은 페이즈 번호. "xbg005_2phase_idle_01" -> "2"
function clipPhase(name) {
  // 페이즈 태그가 이름 끝에 오는 보스가 있다 — 온리 원은 idle_1phase / idle_2phase 다.
  const m = (name || '').match(/(?:^|_)(\d)phase(?:_|$)/i);
  return m ? m[1] : null;
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
  // 사망이 파일에 두 벌 들어 있는데, 앞 5초가 같고 마지막 1초 남짓만 다르다.
  // 눈으로는 구분이 안 돼서 뒤엣것은 목록에서 뺀다.
  { boss: /^bbg001_rich/i, re: /^bbg001_dead_01_2$/i },
  { boss: /^bbg001_rich/i, re: /^bbg001_shot_/i },
];

function isHiddenClip(bossKey, name) {
  return HIDDEN_CLIPS.some(o => o.boss.test(bossKey || '') && o.re.test(name || ''));
}

// 목록 이름을 손으로 바꾸는 자리. 규칙으로 풀면 다른 보스까지 딸려 바뀌는 경우에만 쓴다.
const CLIP_LABEL_FIX = [
  // 짝인 take1 을 목록에서 뺐으니 꼬리표도 뗀다
  { boss: /^xba001/i, re: /_appearance_take2$/i, label: 'appearance' },
  // 나머지 스킬은 묶음이라 페이즈 태그가 떨어진다. 낱개인 03 만 남아서 맞춰 준다.
  { boss: /^xba001/i, re: /_1phase_skill_03$/i, label: 'skill_03' },
  { boss: /^xba001/i, re: /_2phase_parts$/i, label: '2phase_parts' },
  { boss: /^mbg003/i, re: /_dead_all$/i, label: 'dead' },
  { boss: /^mbg003/i, re: /_2phase_take$/i, label: '2phase_take2+3' },
  { boss: /^mbg003/i, re: /_1phase_take$/i, label: '1phase_take1+2' },
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
const CLIP_PART_SWAP = [
  { boss: /^xbg005/i, clip: /_phase_change$/i, at: 1.5,
    from: /_phase1_feather$/i, to: /_phase2_feather$/i },
];

function clipPartSwapFor(bossKey, name) {
  return CLIP_PART_SWAP.find(
    o => o.boss.test(bossKey || '') && o.clip.test(name || '')) || null;
}

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
    if (o.show) return { show: o.show };
    if (o.hide) return { hide: o.hide };
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
  /(^|_)12phase_appeanrance$/i,    // 애니힐리오 (원본 철자 그대로)
  /^[a-z]{2,4}\d{3}_\d+phase$/i,   // 프로비던스 - 뒤에 아무것도 안 붙은 페이즈 이름
  // 베히모스 - 1 -> 2페이즈 전환이 세 클립으로 이어진다. 앞 하나가 1페이즈 파일에,
  // 뒤 둘이 2페이즈 파일에 들어 있어서 파일을 넘어 잇지는 못한다.
  /^mbg003_2phase_b1_take1_a$/i,
  /^mbg003_2phase_take[23]?$/i,   // 낱개 두 컷과 그 둘을 묶은 키까지
  /^mbg003_3phase_intro$/i,       // 2 -> 3페이즈 전환
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
// 2 -> 3페이즈는 자동으로 넘기지 않는다. 그래서 토글도 1페이즈에만 낸다.
// by - 페이즈를 무엇으로 넘기는가. 베히모스는 페이즈마다 모델 항목이 따로라
// 모델 칩을 넘기고, 에고비스타는 한 모델 안이라 페이즈 칩을 넘긴다.
const AUTO_PHASE_CHAIN = [
  { boss: /^mbg003/i, from: '1', by: 'model' },
  { boss: /^xbg005/i, from: '1', by: 'phase' },
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
    const panel = getComputedStyle(document.body).getPropertyValue('--bg-panel').trim();
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
      return autoPhaseRule.by === 'model'
        ? optLabelPhase === autoPhaseRule.from
        : currentPhase === autoPhaseRule.from;
    }

    const bossTransform = getBossTransform(bossCode, isCatalogExport);
    const [pitchDeg, yawDeg, rollDeg] = bossTransform.rotation;
    // 맞춰 둔 기준 각도. 슬라이더에는 안 들어가서 패널은 0 에서 출발한다 —
    // 배율·높이를 CATALOG_FIT_BASE 로 옮긴 것과 같은 방식이다.
    const basePitch = catalogFitBase(bossCode, isCatalogExport, optLabelPhase).pitch || 0;
    yawGroup.rotation.y = THREE.MathUtils.degToRad(yawDeg);
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
      const base = SL.yaw ? +SL.yaw.value : yawDeg;
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
          if (!glow && !/^fx_/i.test(mt.name || '')) {
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
          // 바탕색은 빼고(가산이라 그대로 두면 회색이 더해진다) 흑백 텍스처를 발광 마스크로
          // 돌려서, 텍스처의 명암 그라디언트가 빛의 세기 분포가 되게 한다.
          if (m.color) m.color.setRGB(0, 0, 0);
          if (m.map && !m.emissiveMap) m.emissiveMap = m.map;
          applyFresnelGlow(m);
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
    const meshPhase = name => {
      const m = (name || '').match(/(\d+)phase|phase0*(\d+)/i);
      if (!m) return null;
      return String(parseInt(m[1] || m[2], 10));
    };
    const basePose = capturePose(gltf.scene);

    // 인게임 카메라. 있으면 등장·사망 연출에서 이걸 그대로 쓴다.
    const camNodes = findCameraNodes(gltf.scene);
    const camPairs = camNodes.length
      ? pairCameraClips(gltf.animations || [], camNodes)
      : { cams: [], byModel: new Map() };
    const cameraClipNames = new Set(camPairs.cams.map(c => c.name));
    // 목록에서 감추는 건 그대로 두고 재생만 막는다
    if (cameraFixFor(bossKey).noCamera) camPairs.byModel = new Map();
    // 카메라 클립이 붙은 모델 클립을 재생하는 동안 참이 된다
    let cinematic = null;
    const focusOverride = focusOverrideFor(bossKey);
    const focusMesh = pickFocusMesh(meshes, focusOverride);
    // 본 패턴이 있으면 그게 우선. 메쉬만 지정했으면 그 메쉬 전체가 기준이라는 뜻이다.
    const focusBone = focusOverride
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
            if (rigCenter(focusMesh, center, focusBone)) {
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

    const phaseConfig = getPhaseConfig(bossCode);
    // 신형 추출본은 보통 파일 하나가 곧 페이즈 하나다. 그런데 온리 원처럼 한 파일에
    // 1·2 페이즈가 다 든 보스가 있다. 메쉬 이름만으로는 구분이 안 된다 —
    // 애니힐리오 2페이즈 파일에도 1phase_magiccarpet 메쉬가 들어 있는데 그건 2페이즈에서
    // 쓰는 파츠다. 클립 쪽을 보면 정확하다: 그 파일은 2페이즈 클립만 갖고 있고,
    // 온리 원은 1·2 페이즈 클립을 둘 다 갖고 있다.
    const clipPhaseKeys = new Set((gltf.animations || []).map(c => clipPhase(c.name)).filter(Boolean));
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

    const isPhaseVisible = (p, current) => {
      if (p === null) return true;
      if (phaseConfig.mode === 'exclusive') return p === current;
      if (phaseConfig.mode === 'phase1-all') return current === minPhase ? true : p === current;
      return Number(p) <= Number(current); // cumulative
    };

    const enabledMeshes = new Set(
      meshes
        .filter(m => !isSkillOnlyEffect(m.name)
          && !isDefaultOffMesh(bossKey, m.name)
          && isPhaseVisible(phaseOf(m.name), currentPhase))
        .map(m => m.partKey)
    );

    // 지금 도는 클립이 한 부위만 내보내는 연출이면 여기에 그 규칙이 들어온다.
    let clipSolo = null;
    // 전환 도중 파츠 교체. done 은 경계를 넘었는지.
    let clipSwap = null;
    let clipSwapDone = false;
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

    function applyVisibility() {
      meshes.forEach(m => {
        let on = enabledMeshes.has(m.partKey);
        if (clipSolo) {
          // 이 연출에서만 켜는 파츠 — 평소 꺼둔 것을 되살린다.
          if (clipSolo.show && clipSolo.show.test(m.name)) on = true;
          else if (on && clipSolo.hide) on = !clipSolo.hide.test(m.name);
          else if (on && clipSolo.group
                   && clipSolo.group.test(m.name) && !clipSolo.keep.test(m.name)) on = false;
        }
        // 전환 도중 갈리는 파츠. 경계 전에는 옛 것만, 뒤에는 새 것만 보인다.
        // 새 파츠는 지금 페이즈에서 꺼져 있으므로 켜는 쪽도 여기서 정한다.
        if (clipSwap) {
          if (clipSwap.from.test(m.name)) on = !clipSwapDone;
          else if (clipSwap.to.test(m.name)) on = clipSwapDone;
        }
        // 이 연출에서만 켜지는 발광 파츠 — 평소 꺼둔 것을 잠깐 되살린다
        if (!on && clipGlow && clipGlow.parts.some(re => re.test(m.name))) on = true;
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
      meshes.forEach(m => findGroup(partGroupLabel(bossKey, m.name)).items.push(m));
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
      const totalOn = meshes.filter(m => enabledMeshes.has(m.partKey)).length;
      const allState = totalOn === meshes.length ? ' active' : (totalOn ? ' partial' : '');
      const allHtml = `
          <div class="part-group">
            <div class="part-group-head part-all${allState}">
              <div class="toggle-switch"></div>
              <span class="toggle-label">전체 파츠</span>
              <em>${totalOn}/${meshes.length}</em>
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

      // 전체 파츠: 하나라도 꺼져 있으면 전부 켜고, 다 켜져 있으면 전부 끈다
      const allHead = box.querySelector('.part-all');
      if (allHead) {
        allHead.addEventListener('click', () => {
          if (container.__framesModel3D !== state) return;
          const allOn = meshes.every(m => enabledMeshes.has(m.partKey));
          meshes.forEach(m => {
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
            phaseToggleEl.querySelectorAll('.frames-phase-btn').forEach(b => {
              b.classList.toggle('active', b.dataset.phase === currentPhase);
            });
            // 프리셋 적용: 페이즈 태그가 있는 파츠만 보스별 모드(누적/배타)에 맞게 다시
            // 켜고/끄고, 페이즈 태그가 없는 공용 파츠는 건드리지 않는다.
            meshes.forEach(m => {
              const p = phaseOf(m.name);
              if (p === null) return;
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

      const nb = new THREE.Box3();
      const nv = new THREE.Vector3();
      meshes.forEach(m => {
        if (!m.isSkinnedMesh || !m.skeleton) return;
        m.skeleton.bones.forEach(b => {
          if (DEBRIS_BONE_RE.test(b.name || '')) return;
          b.getWorldPosition(nv);
          nb.expandByPoint(normGroup.worldToLocal(nv.clone()));
        });
      });
      if (!nb.isEmpty()) {
        const ns = nb.getSize(new THREE.Vector3());
        const k = 1 / (Math.max(ns.x, ns.y, ns.z) || 1);
        const fitBase = catalogFitBase(bossCode, isCatalogExport, optLabelPhase);
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
      const camLift = (CATALOG_FIT_OVERRIDES[bossCode] || {}).camY || 0;
      camera.position.set(0, normHeight * 0.55 + camLift, 2.3);
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
      const rule = CLIP_CAM_LIFT.find(
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
    const camFwd = new THREE.Vector3();
    const camPull = new THREE.Vector3();
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
      node.matrixWorld.decompose(camWorldPos, camWorldQuat, camWorldScl);
      camera.position.copy(camWorldPos);
      camera.quaternion.copy(camWorldQuat);
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
      if (hasAim) camera.lookAt(camPull);
      // 치우친 각을 상수로 돌린다. 위치는 그대로라 카메라 워크는 유지된다.
      if (cinematic.aim) camera.quaternion.multiply(cinematic.aim);
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
      // 게임 카메라의 화각(yfov)을 따른다. 클립이 끝나면 원래 값으로 돌려놓는다.
      if (node.isPerspectiveCamera) {
        if (savedFov === null) savedFov = camera.fov;
        if (Math.abs(camera.fov - node.fov) > 1e-4) {
          camera.fov = node.fov;
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
      const list = gltf.animations || [];
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
      // 새 클립을 시작할 때는 시점을 홈으로 되돌린다.
      // 리그가 망가진 채 끝나는 클립이 있다 — 거대 질량체 death 는 본을 25 유닛
      // 흩뿌리고, 그러면 추적이 마지막 성한 자리에 시점을 붙들어 둔다. 그 상태가
      // 다음 클립까지 넘어가면 시점이 (5.1, 1.4, -0.6) 에 얼어붙어서, 그 뒤로 뭘
      // 재생하든 화면이 통째로 빈다.
      resetViewToHome();

      // 이 클립에 인게임 카메라가 붙어 있으면 같이 재생하고, 그동안 시점을 그쪽에 맡긴다.
      const camPair = camPairs.byModel.get(clip.name);
      cinematic = null;
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
        cinematic = { action: camAct, clip: camPair.clip, node: camPair.node,
          zoom: camZoom.get(clip.name) || 1, aim: camAim.get(clip.name) || null,
          near: camNear.get(clip.name) || 0, rescue: !!fix.rescue,
          flip: camNeedsFlip(clip.name),
          lookAtFocus: !!fix.lookAtFocus,
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
      clipSwap = clipPartSwapFor(bossKey, clip.name);
      clipSwapDone = false;
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
      if (e && e.action && e.action.getClip() !== (currentAction && currentAction.getClip())) return;
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
        const isAppearName = n => /(^|_)appea/i.test(n);           // appearance / appeanrance
        const isDeadName = n => /(^|_)(dead|death)/i.test(n);
        const isAirName = n => /(^|_)air/i.test(n);
        const groupOf = (name) => {
          const n = String(name);
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
          if (group === '기본') return isAirName(n) ? 2 : (isIdle({ name: n }) ? 0 : 1);
          return 0;
        };

        // 좌우 머리가 함께 나오는 연출은 하나로 묶는다. 낱개 좌·우 클립은 목록에서 뺀다
        // — 혼자 틀어봐야 옆 머리 하나만 허공에서 움직인다.
        const trios = findTrios(clips);
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
          const p = clipPhaseOverride(bossKey, name) || clipPhase(name);
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
              mkBtn(c.name, labelOf(c.name, label(c.name)), secs(c.duration))));
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
                mkBtn(c.name + '#trio', label(c.name) + '  (머리 3개)', secs(c.duration), 'is-seq'));
              return;
            }
            push(c.name,
              mkBtn(c.name, labelOf(c.name, label(c.name)), secs(c.duration),
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
          const sw = seqs.find(sq => isPhaseSwitchClip(sq.key) && inCurrentPhase(sq.steps[0].clip.name))
            || null;
          const swClip = sw ? null
            : clips.find(c => isPhaseSwitchClip(c.name) && inCurrentPhase(c.name));
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
      const dur = currentAction.getClip().duration || 0;
      currentAction.time = Math.max(0, Math.min(dur, dur * ratio));
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

    function syncBar() {
      if (!currentAction) return;
      const dur = currentAction.getClip().duration || 0;
      const t = dur ? (currentAction.time % dur) : 0;
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
      // 파츠가 갈리는 지점을 지났으면 그 순간 바꿔 끼운다
      if (clipSwap && currentAction) {
        const past = currentAction.time >= clipSwap.at;
        if (past !== clipSwapDone) { clipSwapDone = past; applyVisibility(); }
      }
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
