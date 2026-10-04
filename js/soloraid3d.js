// 역대 테두리 탭: FBX -> glTF/Draco 변환 결과물(.glb)을 표시하는 3D 뷰어.
// Spine(L2D) 런타임과는 완전히 별개 스택(Three.js)이라 soloraid.js(classic script)와
// 분리된 모듈로 두고, window에 진입점만 노출해서 soloraid.js에서 호출한다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

// 모델 받기. 2026-10-04 부터 업로드 파일은 meshopt(동작 · 메쉬) 압축 + 파일 통째 gzip 이다 - Supabase 는 glb 를
// 압축 없이 보내서(42 MB 면 42 MB) 미리 gzip 해서 올린다. 파일 이름 · DB 주소는 그대로 .glb 이고, 받은 바이트가
// gzip(1f 8b)이면 브라우저 내장 DecompressionStream 으로 풀어서 읽는다. 예전 파일(그냥 glb)도 그대로 읽힌다.
// 진행 막대가 받은 바이트를 보여 주도록 onProgress 를 loader.load 와 같은 꼴로 부른다.
function loadModelFile(loader, url, onLoad, onProgress, onError) {
  (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    const total = +res.headers.get('content-length') || 0;
    let bytes;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const parts = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        loaded += value.byteLength;
        if (onProgress) onProgress({ loaded, total, lengthComputable: total > 0 });
      }
      bytes = new Uint8Array(loaded);
      let off = 0;
      for (const p of parts) { bytes.set(p, off); off += p.byteLength; }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    let buf = bytes.buffer;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      buf = await new Response(stream).arrayBuffer();
    }
    const base = url.split(/[?#]/)[0];
    loader.parse(buf, base.slice(0, base.lastIndexOf('/') + 1), onLoad, onError);
  })().catch(err => { if (onError) onError(err); });
}

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
  // 알트아이젠 - 1페이즈는 전체 파츠(프리팹에서 전부 켜짐), 2페이즈는 phase002 파츠만. 1페이즈 끝에 1페 파츠와
  // 2페 라이플 02 a · b 가 꺼진다(A.N.M.I. MonsterPhaseDataV2 - 아래 MESH_PHASE_FIX). P.S.I.D. 의 구형 페이즈
  // 데이터는 1페이즈 끝에 2페 몸까지 전부 끄도록 적혀 있어 맞지 않는다 - 같은 보스라 A.N.M.I. 쪽을 따른다.
  mbg001: { mode: 'phase1-all' },
  xba001: { mode: 'exclusive' },  // 미러 컨테이너 - 2페이즈에서 1phase 파츠는 전부 사라진다
  xbg005: { mode: 'exclusive' },  // 에고비스타 - 페이즈마다 깃털이 통째로 갈린다
  // 애니힐리오 - 1·2페이즈 파일을 합쳐 두었다. 변신하면 1페이즈 몸체는
  // 통째로 사라지고 2페이즈 파츠만 남는다.
  xba003: { mode: 'exclusive' },
  // 리버렐리오 바디 - 1·2페이즈 몸이 리그부터 다르다. 변신하면 1페이즈 몸은
  // 통째로 사라진다. 해파리는 페이즈 태그가 없어서 양쪽에 다 남는다(맞다 -
  // 1페 등장·전환·사망 세 연출에 다 나온다).
  eba002: { mode: 'exclusive' },
  // 니힐리스타 - 1페이즈가 끝나면 팔 · 무기 · 발칸 · 프로텍터가 꺼지고(MonsterPhaseDataV2, 전환 연출
  // 활성 트랙 0~0.017초), 2페이즈는 2phase 머리 · 날개가 켜진다. 1phase_head_01(오른쪽 머리)은 양쪽에 남는다.
  mba002: { mode: 'exclusive' },
  // 백빙룡 - 니힐리스타 변종. 게임이 쓰는 동작이 전부 phase02 쪽(첫 등장도 phase02_appearance_03)이라
  // 페이즈가 하나다. 1페이즈 태그를 2 로 접어 칩을 없앤다.
  mba002_whiteice: { merge: { 1: 2 } },
  // 크라켄(황금 bbg004_golden · 환영 bbg004_hologram) - 1페이즈는 껍데기(1phase_pinna)까지 전부,
  // 2페이즈는 껍데기가 부서져(1phase_destroy) 몸통 · 머리 · 촉수만 남는다.
  bbg004: { mode: 'phase1-all' },
  // 인디빌리아 - 1페이즈 몸(전갈)은 1페이즈가 끝날 때 통째로 꺼지고(MonsterPhaseData
  // EndDeActiveObjects), 2페이즈는 요르문간드 몸만 남는다.
  ebg003: { mode: 'exclusive' },
  // 아일랜드 이터 - 1페이즈는 전체 파츠, 2페이즈는 phase002·003 파츠 10개.
  ebg001_island: { mode: 'phase1-all', merge: { 3: 2 } },
  ebg001_hsta: { mode: 'phase1-all', merge: { 3: 2 } },   // 랜드 이터 - 아일랜드 이터의 원종, 구성이 같다
  // 그레이브 디거 - phase001/002/003 사이에 phase0025 가 끼어 있다.
  // 자리수 채운 이름이라 2.5 가 "25" 로 읽힐테고, 그러면 25페이즈 칩이
  // 없어서 그 클립들이 어느 목록에도 안 나온다. 2페이즈로 접어 둔다.
  mbg002: { merge: { 25: 2 } },
  // 지즈 - 1·2페이즈 몸이 따로다. 변신하면 1페이즈 몸·코어는 사라지고 2페이즈 몸·코어만
  // 남는다(2페이즈 동작 15개가 2페 코어 뼈만 움직이고 1페 코어 뼈는 안 건드린다).
  // 2페 코어는 프리팹에서 꺼져 있고 타임라인도 켜지 않는다 - 게임 코드가 켠다.
  eba005: { mode: 'exclusive' },
  // 울트라 - 1페이즈는 1·2페이즈 몸이 다 켜져 있다(프리팹에서 둘 다 켜짐, 2페 몸이 1페
  // 껍데기 안에 있다). 1페이즈가 끝나면 게임이 1페 몸·머리 셋·날개를 끈다
  // (MonsterPhaseData phase 1 EndDeActiveObjects). 2페이즈에는 2페 몸과 독주머니만 남는다.
  // 변종(bbg006_hsta)도 코드로 찾아서 같이 걸린다.
  bbg006: { mode: 'phase1-all' },
};

function getPhaseConfig(bossKey, bossCode) {
  const raw = PHASE_MODE_OVERRIDES[bossKey] || PHASE_MODE_OVERRIDES[bossCode];
  if (!raw) return { mode: 'cumulative', merge: null };
  if (typeof raw === 'string') return { mode: raw, merge: null };
  return { mode: raw.mode || 'cumulative', merge: raw.merge || null };
}

// 파츠를 부위별로 묶는다. 좌우로 갈린 파츠(arm_l / arm_r)가 한 묶음에 들어간다.
// 위에서부터 먼저 맞는 것을 쓴다 — 발광 껍데기는 부위보다 먼저 걸러야
// head_skin_fx 가 "머리" 로 새지 않는다.
const PART_GROUPS = [
  // 토커티브 로켓 발사기 - socket_rocket_left 가 아래 '날개'(rocket) 규칙에 걸리고 오른쪽은 철자가 rocke 라 안 걸린다
  ['무기', /^bbg002_socket_rocke?t?_(left|right)$/i],
  // 마테리얼H(ebg002) - 메쉬 이름이 main1_dmtr_skin · frame_skin00N_dmtr_wpl0N 꼴이라 아래 공용 규칙에 안 걸린다
  // (H.S.T.A. 도 메쉬 이름은 _dmtr 그대로다).
  ['본체', /^ebg002_main[12]_dmtr_skin$/i],
  ['팔',   /^ebg002_[bs][lr]arms_dmtr_skin$/i],
  ['무기', /^ebg002_frame_skin\d+_dmtr_wp[lrc]\d+$/i],
  ['프레임', /^ebg002_frame(\d_dmtr_skin|_dmtr_skin\d+)$/i],
  // 인디빌리아 1페 등장 맵 연출 리그(ecg007 · arms_parts) - 이름이 body · legs · arms 라 몸 파츠에 섞인다.
  // 니힐리스타 2페 전환 눈 리그(_eye)도 '머리' 로 새지 않게 여기서 거른다.
  ['연출', /_(map[ab]|eye)(_\d+)?$/i],
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
  // 미러 컨테이너 2페이즈 파츠 넷 - 재질별 프리미티브 셋(_2 · _3 · _4)으로 갈려 이름표가 안 붙었다. 한 파츠로 묶는다.
  { boss: /^xba001/i, re: /^(xba001_2phase_parts_[ud][lr]01_skin)(_\d+)?$/i, bySuffix: {}, merge: true },
  // 모더니아 - 본체 메쉬 이름이 보스 코드와 같은 mbg004 라 코드를 떼면 프리미티브 꼬리표(2 · 3)만 남는다.
  // body 로 이름 짓고 한 파츠로 묶는다. 미사일은 노드와 이름이 겹쳐 붙은 _1 을 뗀다.
  { boss: /^mbg004/i, re: /^mbg004(_\d+)?$/i, base: 'mbg004_body', bySuffix: {}, merge: true },
  { boss: /^mbg004/i, re: /^(mbg004_missile_(?:left|right)_skin)(_\d+)?$/i, bySuffix: {} },
  // 토커티브 - 몸통(재질별 프리미티브 셋)을 묶고, 노드와 이름이 겹쳐 붙은 _1 꼬리표를 뗀다.
  { boss: /^bbg002/i, re: /^(bbg002_(?:body|laser_01|left_parts_01|right_parts_01))(_\d+)?$/i, bySuffix: {}, merge: true },
  // 랜드 이터 - 2 · 3페이즈 몸과 탑(재질별 프리미티브)을 한 파츠로 묶는다. (아일랜드 이터는 손대지 않았다)
  { boss: /^ebg001_hsta/i, re: /^(ebg001_(?:phase00[23]_skin|phase001_parts_top_skin))(_\d+)?$/i, bySuffix: {}, merge: true },
  // 블랙스미스 - 다리(재질별 프리미티브 넷), S2 날개(뼈 이름과 겹쳐 _1 이 붙음)와 촉수(Object002 오른쪽 · Object004 왼쪽, 두 벌 x 프리미티브 둘)를
  // 한 파츠로 묶는다. 촉수 두 벌은 대기에서 같은 자리에 겹쳐 있고 둘 다 기본 꺼짐이다.
  { boss: /^bbg003/i, re: /^(bbg003_legs_skin|bbg003_Wing_Red|Object00[24])(_\d+)?$/i, bySuffix: {}, merge: true },
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
  //
  // 시즌 42(P.S.I.D.) 는 메쉬 이름은 그대로인데 재질만 xbg004_psid_* 로 갈렸다.
  // 그래서 두 이름을 다 적어 둔다. 발광 재질은 양쪽이 같다.
  { boss: /^xbg004/i, re: /^(xbg004_helm_\d+_skin)(_\d+)?$/i,
    bySuffix: { 'xbg004_body': '', 'xbg004_psid_body': '',
                'fx_xbg004_zeus_parts_glow': '_1' } },
  // 눈은 좌우 한 쌍인데 이름이 l_sdf_eye_02 / sdf_eye_01 로 엇갈려 있다.
  // 이 파일은 l 이 x+, r 이 x- 다(shield_l_skin x+0.31 / shield_r_skin x-0.31).
  // 실제 위치가 각각 x+0.33 / x-0.32 라 그대로 방패와 같은 꼴로 맞춘다.
  { boss: /^xbg004/i, re: /^xbg004_l_sdf_eye_\d+_skin(_\d+)?$/i, base: 'xbg004_sdf_eye_l_skin',
    bySuffix: { 'xbg004_shield': '', 'xbg004_psid_shield': '',
                'fx_xbg004_zeus_parts_glow': '_1' } },
  { boss: /^xbg004/i, re: /^xbg004_sdf_eye_\d+_skin(_\d+)?$/i, base: 'xbg004_sdf_eye_r_skin',
    bySuffix: { 'xbg004_shield': '', 'xbg004_psid_shield': '',
                'fx_xbg004_zeus_parts_glow': '_1' } },
  // 방패는 한 메쉬의 프리미티브 둘인데 어느 쪽도 발광이 아니다.
  // _1 은 발광 층 자리로 비워 두고, 게임이 쓰는 꼴대로 001 을 붙인다.
  { boss: /^xbg004/i, re: /^(xbg004_shield_[lr]_skin)(_\d+)?$/i,
    bySuffix: { 'xbg004_shield': '', 'xbg004_body': '001',
                'xbg004_psid_shield': '', 'xbg004_psid_body': '001' } },
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
  // merge - 일부러 한 파츠로 묶는다는 표시. 이름이 겹쳐도 번호를 붙여 가르지 않고
  // 목록에도 한 줄로 낸다(아래 "이름이 겹치는 보스" 처리 참고).
  { boss: /^xba003/i, re: /^xba003_2phase_body_skin(_\d+)?$/i,
    mat: 'xba003_phase02_body', to: 'xba003_2phase_body_skin', merge: true },
  { boss: /^xba003/i, re: /^xba003_2phase_body_skin(_\d+)?$/i,
    mat: 'xba003_phase02_body2', to: 'xba003_2phase_body_skin', merge: true },
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
  // 크리스탈 체임버 - 노드가 이름을 먼저 차지해서 메쉬마다 _1 · _2 가 붙는다. 방어막·큰 뿔은
  // 본체와 발광 층(fx_ 재질, 시즌 10 만 있다)이 같은 이름이라 재질로 가른다 — 본체는 꼬리표 없이,
  // 발광 층은 _1. 프리미티브가 하나뿐인 나머지는 꼬리표만 뗀다(몸통·파편·무기01 은 둘이라 그대로).
  { boss: /^xbg001/i, re: /^(xbg001_(?:left|right)_barrier)(_\d+)?$/i,
    bySuffix: { 'xbg001_psid_body': '', 'xbg001_anmi_body': '', 'fx_xbg001_barrier_uv': '_1' } },
  { boss: /^xbg001/i, re: /^(xbg001_(?:left|right)_bighorn)(_\d+)?$/i,
    bySuffix: { 'xbg001_psid_head': '', 'xbg001_anmi_head': '', 'fx_xbg001_bighorn_uv': '_1' } },
  { boss: /^xbg001/i,
    re: /^(xbg001_(?:horn|[LR]_legs|2phase_weapon|weapon_crystal01))(_\d+)?$/i, bySuffix: {} },
  // 인디빌리아 - 노드가 이름을 먼저 차지해서 꼬리표가 붙고, 메쉬 여럿이 재질별 프리미티브(2~5개)로
  // 갈려 몸통 _2~_5 처럼 여러 줄로 나왔다. 한 메쉬의 프리미티브는 한 파츠로 묶는다(merge).
  { boss: /^ebg003/i,
    re: /^(ebg003_(?:1phase_(?:scorpiontail|scorpiontail_wp|body|body_eye|legs_01|[lr]_arms|[lr]_arms_claw|vulcan)_skin|2phase_Jormungandr_(?:tail|head|teeath|vulcan)_skin))(_\d+)?$/i,
    bySuffix: {}, merge: true },
  // 니힐리스타 · 백빙룡 - 노드가 이름을 먼저 차지해서 꼬리표가 붙고, 머리 · 몸통은 재질별 프리미티브로
  // 갈려 여러 줄로 나왔다. 한 메쉬의 프리미티브는 한 파츠로 묶는다.
  { boss: /^mba002/i,
    re: /^(mba002_(?:1phase_head_01|2phase_head_003|body_0[12]|2phase_wings|phase1_(?:arms|arms_weapon|[lr]_armor|[lr]_ar)|[lr]_rl))(_\d+)?$/i,
    bySuffix: {}, merge: true },
  // 알트아이젠 - 꼬리표를 떼고, 몸통(4 · 5) · 레이저(3) · 캐논(2)의 재질별 프리미티브를 한 파츠로 묶는다.
  { boss: /^mbg001/i,
    re: /^(mbg001_phase00[12]_[a-z]+_\d+(?:_[ab])?_skin)(_\d+)?$/i,
    bySuffix: {}, merge: true },
  // 크라켄 - 노드가 이름을 먼저 차지해서 꼬리표가 붙고, 몸통 · 머리 · 껍데기는 재질별 프리미티브 둘로
  // 갈려 _2 · _3 두 줄로 나왔다. 한 메쉬의 프리미티브는 한 파츠로 묶는다.
  { boss: /^bbg004/i,
    re: /^(bbg004_(?:[lr]_[ud]_tentacle|2phase_body|2phase_head|1phase_pinna)_skin)(_\d+)?$/i,
    bySuffix: {}, merge: true },
  // 마더웨일 - 왼쪽 해치만 노드가 이름을 먼저 차지해서 _1 이 붙는다. 이름표가 안 걸려서 뗀다.
  { boss: /^bba001/i, re: /^(bba001_left_cover_skin)(_\d+)?$/i, bySuffix: {} },
  // 울트라 - 노드가 이름을 먼저 차지해서 메쉬에 _1 이 붙는다. 그 꼬리표 때문에 이름표가 안
  // 걸렸다. 프리미티브가 하나뿐인 것만 뗀다(몸 둘은 프리미티브가 둘이라 그대로).
  { boss: /^bbg006/i,
    re: /^(bbg006_(?:[lr]poison_skin|1phase_head_0\d|1phase_[lr]wings_01_skin))(_\d+)?$/i,
    bySuffix: {} },

  // 베히모스 2페이즈 - 여기도 노드가 이름을 먼저 차지해서 머신건에 _1 이 붙는다.
  // 그 꼬리표 때문에 이름표도, 3페이즈 기본 꺼짐 규칙도 안 걸렸다.
  // 프리미티브가 하나뿐이라 꼬리표만 떼면 된다(몸통 넷과 rl 둘은 여럿이라 그대로).
  { boss: /^mbg003/i, re: /^(mbg003_behemoth_[lr]_vulcan_skin)(_\d+)?$/i, bySuffix: {} },

  // 미러 컨테이너 - 노드가 메쉬와 같은 이름을 먼저 차지해서 모든 메쉬에 _1 이 붙는다.
  // 그 꼬리표 하나 때문에 파츠 이름표가 통째로 안 붙고 있었다(cube_skin_1 은
  // 표의 cube_skin 과 안 맞는다). 프리미티브가 하나뿐인 메쉬만 꼬리표를 뗀다.
  // 2phase_parts 넷과 몸통(xba001_skin)은 프리미티브가 여럿이라 빼 둔다 -
  // 꼬리표를 떼면 셋이 같은 이름이 돼서 목록이 "... 1 / ... 2" 로 갈린다.
  // (2phase_parts 넷은 2026-10-04 부터 맨 위 MESH_RENAME 의 merge 줄이 한 파츠로 묶는다)
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
        if (hit) {
          if (o.merge) m.userData.__mergePart = true;
          return (o.base || hit[1]) + (o.bySuffix[mat] || '');
        }
      } else if (o.re.test(m.name || '') && o.mat === mat
                 && (o.nth === undefined || o.nth === occ.get(m))) {
        if (o.merge) m.userData.__mergePart = true;
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
  // 알트아이젠(두 시즌) - 인게임 확인(사용자, 2026-10-04). 파츠 데이터 부위 13~18 이 이 메쉬들을 가리킨다.
  mbg001: {
    'phase002_rocket_01_skin': '미사일 포트 I',
    'phase001_rocket_02_skin': '미사일 포트 II',
    'phase002_rifle_02_a_skin': '터렛 I',
    'phase002_rifle_02_b_skin': '터렛 II',
    'phase001_rifle_04_a_skin': '터렛 III',
    'phase001_rifle_04_b_skin': '터렛 IV',
  },
  // 지즈 - 로케일 parts_name_ziz01~04 동그란 눈 I~IV. 순서는 인게임 확인(사용자, 2026-10-04):
  //   1페이즈 - 정면에서 좌상단부터 우하단까지 Z자(좌상 core_01 · 우상 core_04 · 좌하 core_02 · 우하 core_03,
  //            파츠 부위 번호 13~16 순서와도 같다)
  //   2페이즈 - 위쪽부터 시계방향(위 core_04 · 오른쪽 core_01 · 아래 core_02 · 왼쪽 core_03)
  eba005: {
    '1phase_core_01_skin': '동그란 눈 Ⅰ',
    '1phase_core_04_skin': '동그란 눈 Ⅱ',
    '1phase_core_02_skin': '동그란 눈 Ⅲ',
    '1phase_core_03_skin': '동그란 눈 Ⅳ',
    '2phase_core_04_skin': '동그란 눈 Ⅰ',
    '2phase_core_01_skin': '동그란 눈 Ⅱ',
    '2phase_core_02_skin': '동그란 눈 Ⅲ',
    '2phase_core_03_skin': '동그란 눈 Ⅳ',
  },
  // 마테리얼H - 로케일 parts_name_MaterialH. 메쉬와 이름은 인게임 확인(사용자, 2026-10-04). 두 시즌 공통.
  // (beamrail wpl03 · wpr03, metalbox wpl05 · wpr05, beambox frame1 · frame2 는 확인 전이라 비워 둔다)
  ebg002: {
    'frame_skin002_dmtr_wpr01': '전면 타워 R',
    'frame_skin003_dmtr_wpl01': '전면 타워 L',
    'frame_skin001_dmtr_wpc01': '전면 타워 C',
    'frame_skin004_dmtr_wpr02': '전면 기둥 터렛 R',
    'frame_skin007_dmtr_wpl02': '전면 기둥 터렛 L',
    'frame_skin010_dmtr_wpr04': '후면 기둥 터렛 R',
    'frame_skin009_dmtr_wpl04': '후면 기둥 터렛 L',
  },
  // 토커티브 - 인게임 확인(사용자, 2026-10-04). 파츠 데이터 부위 13 · 14 · 15 와 같은 순서다.
  bbg002: {
    'socket_rocket_left': '미사일 포트 I',
    'socket_rocke_right': '미사일 포트 II',
    'head': '코어',
  },
  // 모더니아 - 로케일 parts_name_Mordernia01~05. 파츠 데이터(MonsterPartsPrefab.Skin): 부위 13 L_socket_launcher04 ->
  // left_rifle, 14 R_socket_launcher04 -> right_rifle(미사일 포트 I · II, 번호 순서), 15 core_col -> head(시즌 6 만,
  // A.N.M.I. 는 Skin 없음), 16 · 17 L/R_skirt -> mbg007_l/r_skirt(A.N.M.I. 만).
  mbg004: {
    'left_rifle': '미사일 포트 I',
    'right_rifle': '미사일 포트 II',
    'head': '코어',
  },
  mbg004_anmi: {
    'left_rifle': '미사일 포트 I',
    'right_rifle': '미사일 포트 II',
    'mbg007_l_skirt': '스커트(좌)',
    'mbg007_r_skirt': '스커트(우)',
  },
  // 랜드 이터 - 로케일 parts_name_LandEater03~06(탑 · 활주로 · 외부 장갑 R · L). 파츠 데이터(MonsterPartsPrefab.Skin)가
  // 부위 3 -> parts_top, 2 -> parts_right, 1 -> parts_left, 15 -> parts_center 를 가리킨다. 이름으로 셋이 이어지고
  // 남는 활주로가 center 다. 코어 R · L(01 · 02)은 core_R/L_bone001(부위 13 · 14)로 메쉬가 없다.
  ebg001_hsta: {
    'phase001_parts_top_skin': '탑',
    'phase001_parts_center_skin': '활주로',
    'phase001_parts_right_skin': '외부 장갑 R',
    'phase001_parts_left_skin': '외부 장갑 L',
  },
  // 블랙스미스(S2 · S5 콜라보) - 팔 둘(파츠 데이터 부위 1 · 2, Skin left/right_Arms_skin)의 인게임 이름은
  // 대구경 라이플 L · R 이다(사용자 확인, 2026-10-04 - 처음엔 로케일 blacksmith01 · 02 컨테이너 L · R 로 붙였었다).
  // 촉수는 파괴 파츠가 아니라 모양대로 적는다.
  bbg003: {
    'left_Arms_skin': '대구경 라이플 L',
    'right_Arms_skin': '대구경 라이플 R',
    'Object002': '촉수 R',
    'Object004': '촉수 L',
  },
  // 니힐리스타 - 게임 로케일 parts_name_Nihilister01~06. 파츠 데이터(MonsterPartsPrefab.Skin)가 메쉬를 직접
  // 가리킨다 — l/r_ar_01 -> phase1_l/r_ar(발칸), l_arms_21 · r_arms_24 -> phase1_l/r_armor(프로텍터),
  // S2B_SplineIK_012 -> 2phase_head_003, S2B_SplineIK_001 -> 1phase_head_01. 머리 좌우는 동작으로 정했다 —
  // phase02_left_head_Destruction · generate 는 2phase_head_003 뼈만, right_head 쪽은 1phase_head_01 뼈만 움직인다.
  mba002: {
    'phase1_l_ar': '발칸 L',
    'phase1_r_ar': '발칸 R',
    'phase1_l_armor': '프로텍터 L',
    'phase1_r_armor': '프로텍터 R',
    '2phase_head_003': '왼쪽 머리',
    '1phase_head_01': '오른쪽 머리',
  },
  // 백빙룡 - 로케일 parts_name_WhiteIceDragon01~02. 파츠 데이터가 l/r_laser_09 -> 2phase_wings_l/r_parts 를 가리킨다.
  mba002_whiteice: {
    '2phase_wings_l_parts': '냉기의 원천(좌)',
    '2phase_wings_r_parts': '냉기의 원천(우)',
  },
  // 크라켄 - 게임 로케일 parts_name_kraken01~04(촉수 L · 거대 촉수 L · 촉수 R · 거대 촉수 R).
  // 파츠 데이터(MonsterPartsPrefab.Skin)가 촉수 메쉬를 직접 가리키고, 뼈 이름의 big/small 이
  // 거대 촉수/촉수와 맞는다 — Helper_Chain_Root_lb(9) -> l_u_tentacle, _ls(11) -> l_d_tentacle,
  // _rb(10) -> r_u_tentacle, _rs(12) -> r_d_tentacle. 동작 이름도 left_big / left_small 이다.
  bbg004: {
    'l_u_tentacle_skin': '거대 촉수 L',
    'l_d_tentacle_skin': '촉수 L',
    'r_u_tentacle_skin': '거대 촉수 R',
    'r_d_tentacle_skin': '촉수 R',
  },
  // 인디빌리아 - 게임 로케일 parts_name_Indivila01~05(집게 L · 집게 R · 꼬리 · 블레이드 · 코어).
  // 파츠 데이터(MonsterPartsPrefab.Skin)가 메쉬를 직접 가리킨다 — l/r_tongs_02 -> l/r_arms_claw_skin(집게),
  // core_col_03 -> body_eye_skin(코어), Control_ChainKnot_7 -> 1phase_scorpiontail_wp_skin(꼬리 끝),
  // 2phase_head_lcanine_01 -> 2phase_Jormungandr_teeath_skin(요르문간드 수염).
  // 꼬리 끝이 꼬리, 요르문간드 수염이 블레이드인 것은 사용자가 인게임으로 확인했다(2026-10-02).
  ebg003: {
    '1phase_l_arms_claw_skin': '집게 L',
    '1phase_r_arms_claw_skin': '집게 R',
    '1phase_scorpiontail_wp_skin': '꼬리',
    '2phase_Jormungandr_teeath_skin': '블레이드',
    '1phase_body_eye_skin': '코어',
  },
  // 크리스탈 체임버 - 게임 로케일 parts_name_barrier_left/right(보스 표시 없는 항목). 파츠 데이터의
  // 부서지는 파츠 13·14 가 left/right_barrier 를 가리키고, 인게임 이름이 크리스탈 혼 L·R 인 것을
  // 사용자가 확인했다(2026-10-02). 발광 층(_1, 시즌 10)은 " (발광)" 이 붙는다.
  xbg001: {
    'left_barrier': '크리스탈 혼 L',
    'right_barrier': '크리스탈 혼 R',
  },
  // 마더웨일 - 게임 로케일 parts_name_motherwhale01~09. 2026-10-02 재추출본의 파츠 데이터
  // (MonsterPartsPrefab.Skin)가 메쉬를 직접 가리킨다 — l/r_summon_01~03 -> left/right_boil_01~03,
  // l/r_cover_01 -> left/right_cover, socket_summon_01 -> core_skin. 부위 번호(13~21)도
  // 로케일 01~09 순서와 같다.
  bba001: {
    'left_boil_01_skin': '소환 포트 L Ⅰ',
    'left_boil_02_skin': '소환 포트 L Ⅱ',
    'left_boil_03_skin': '소환 포트 L Ⅲ',
    'right_boil_01_skin': '소환 포트 R Ⅰ',
    'right_boil_02_skin': '소환 포트 R Ⅱ',
    'right_boil_03_skin': '소환 포트 R Ⅲ',
    'left_cover_skin': '컨테이너 해치 L',
    'right_cover_skin': '컨테이너 해치 R',
    'core_skin': '코어',
  },
  // 프로비던스 - 게임 로케일 parts_name_providence01~06. 파츠 데이터가 부서지는 파츠로
  // arm_l/r · legs_l/r_skin001 · shoulder_l/r 를 가리킨다(arm2 가 아니다). 로케일 영어
  // Vambrace(완갑) · Pauldron(견갑) · Greave(각갑)와 부위가 그대로 맞는다.
  // 07 확장 파츠는 가리키는 메쉬가 없다(충돌체 parts_col_01~06 뿐).
  xbg002: {
    'arm_l_skin': '완갑 L',
    'arm_r_skin': '완갑 R',
    'shoulder_l_skin': '견갑 L',
    'shoulder_r_skin': '견갑 R',
    'legs_l_skin001': '각갑 L',
    'legs_r_skin001': '각갑 R',
  },
  bbg001: {
    'egg_skin': '알집',
  },
  // 울트라 - 게임 로케일 parts_name_ultra01~05(날개 L·R, 독주머니 L·R, 코어).
  // 독주머니는 파츠 데이터(MonsterPartsPrefab)가 l/rpoison_skin 을 직접 가리킨다.
  // 날개는 메쉬 이름 그대로 잇는다. 코어(core_col_01)는 머리 뼈에 붙은 충돌체라 메쉬가 없다.
  bbg006: {
    'lpoison_skin': '독주머니 L',
    'rpoison_skin': '독주머니 R',
    '1phase_lwings_01_skin': '날개 L',
    '1phase_rwings_01_skin': '날개 R',
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
    // 2페이즈 파츠 넷 - 로케일 MirrorContainer07~10 유리 구두 I~IV. 순서는 인게임 확인(사용자, 2026-10-04)
    '2phase_parts_ur01_skin': '유리 구두 Ⅰ',
    '2phase_parts_dr01_skin': '유리 구두 Ⅱ',
    '2phase_parts_ul01_skin': '유리 구두 Ⅲ',
    '2phase_parts_dl01_skin': '유리 구두 Ⅳ',
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

function partLabelOf(bossCode, m, fallback, bossKey) {
  // 변종은 파일 이름(bossKey)으로 먼저 찾는다 — 백빙룡은 니힐리스타와 보스 코드가 같은데 부서지는 파츠가 다르다.
  const table = (bossKey && PART_LABELS[bossKey]) || PART_LABELS[bossCode];
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
  //   리버렐리오 바디 - 1024x1024 텍스처 eba002_phase2_body 의 알파가 0 이 48.5%,
  //   1~127 이 26.8%, 128~254 가 20.9% 고 255 는 3.8% 뿐이다. 거의 전부가
  //   반투명이라는 뜻이다. 이 재질을 2페이즈 망토와 사각 파츠가 같이 쓰는데,
  //   불투명하게 그리면 인게임에서 희미하게 흩날리는 조각이 파랑·보라 덩어리로
  //   화면을 덮는다. 해파리(jellyfish, 512x512)도 알파 0 이 74.1% 다.
  //   내보내기가 이 둘에 _BloomIntensity 를 실어 준 것도 같은 얘기다
  //   (phase2_body 0.55 · jelly 0.7 - 게임이 블룸으로 번지게 하는 재질이다).
  //
  //   phase2_parts 는 여기 넣지 않는다. 같은 텍스처를 쓰지만 UV 가 불투명한
  //   구역에 얹혀 있는 머리 장식이고(뼈 26개짜리 작은 메쉬다), 반투명으로 돌리면
  //   깊이를 안 적어서 뒤에 있는 망토가 그 위에 덧칠된다 - 보는 각도에 따라
  //   머리가 가려졌다 나왔다 한다. 흩날리는 사각 조각은 이 메쉬가 아니라
  //   2페이즈 몸(2phase_body2_skin, 뼈 278개)에 들어 있다.
  { boss: /^eba002/i, mat: /^eba002_(phase2_body|jelly)$/i },
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
  // 리버렐리오 바디 해파리 - 연출에만 나오는 개체다. 평소에는 보스 뒤쪽 멀찍이
  // 떨어진 자리에 가만히 떠 있어서 화면만 어지럽힌다.
  // 아래 CLIP_SOLO_PARTS 가 등장·전환·사망에서만 켠다.
  { boss: /^eba002/i, re: /_jellyfish_[lr](_(intro|change|dead))?$/i },
  // 베히모스 머신건 좌우 - 3페이즈에서는 떨어져 나가서 달려 있지 않다.
  // 2페이즈 파일에 3페이즈가 같이 들어 있고 이 파츠에는 페이즈 꼬리표가 없어서,
  // 페이즈를 조건으로 단 줄이 필요하다.
  { boss: /^mbg003/i, re: /_vulcan_skin$/i, phase: '3' },
  // 검은 뱀 좌우 머리 - 평소에는 없다. 게임은 머리 둘을 담은 heads 묶음을 등장
  // take2(3.23~10.67초)와 2페 스킬02(2.33~5.00초)에만 켠다. 그 구간은 파일의
  // meshActivation 이 켠다(경로 …/heads 로 매칭).
  { boss: /^bbg008/i, re: /_skin_(left|right)(_\d+)?$/i },
  // 블랙스미스 촉수(Object002 오른쪽 · Object004 왼쪽) - 두 벌 다 프리팹에서 꺼진 채 시작한다(activeAtStart false).
  //   몸 뒤 소켓(socket_tail_new) 쪽 - S2 등장 타임라인 0~5.88초에만 켜진다(meshActivation 이 켠다)
  //   bbg003_l/r_tentacle 뼈 아래 쪽 - 켜는 타임라인이 파일에 없다
  { boss: /^bbg003/i, re: /^Object00[24](_\d+)?$/i },
  // 크리스탈 체임버(시즌 10) 방어막·큰 뿔 발광 층 - 프리팹에서 꺼진 채 시작하고(selfActive false)
  // 어느 타임라인도 켜지 않는다.
  { boss: /^xbg001/i, re: /_(left|right)_(barrier|bighorn)_1$/i },
  // 크리스탈 체임버 등장 맵 리그 - 맵 프리팹에서 꺼진 채 시작하고 게임 타임라인이
  // xcg001 은 0~6초, 검은 벽은 6~10.52초에만 켠다. 그 컷에서만 CLIP_SOLO_PARTS 가 켠다.
  { boss: /^xbg001/i, re: /^(xcg001_|crys_long|black_wall_du)/i },
  // 거대 질량체 · 미러 컨테이너 맵 연출 부속 리그 - 등장(·사망)에서만 켠다(CLIP_SOLO_PARTS)
  { boss: /^eba004/i, re: /_acc(app|dead)(_\d+)?$/i },
  { boss: /^xba001/i, re: /_bgvar(_\d+)?$/i },
  { boss: /^ebg003/i, re: /_map[ab](_\d+)?$/i },
  // 니힐리스타 2페 전환 가운데 컷의 눈 리그 - 그 컷(2phase_eye)에서만 켠다
  { boss: /^mba002$/i, re: /_eye(_\d+)?$/i },
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

// 화면 맞춤(정규화 상자)에서 빼는 메쉬 - 보스 몸이 아니라 맵 연출에서 온 리그다.
const FIT_SKIP_MESHES = [
  // 블랙스미스 촉수 - 대기 자세에서 몸(폭 0.3) 뒤로 0.91 까지 가늘게 뻗어 있어 맞춤이 작게 잡힌다
  { boss: /^bbg003/i, re: /^Object00[24](_\d+)?$/i },
  { boss: /^eba004/i, re: /_acc(app|dead)(_\d+)?$/i },
  { boss: /^eba002/i, re: /_jellyfish_[lr]/i },
  { boss: /^xba001/i, re: /_bgvar(_\d+)?$/i },
  { boss: /^xbg001/i, re: /^(xcg001_|crys_long|black_wall_du)/i },
  { boss: /^ebg003/i, re: /_map[ab](_\d+)?$/i },
  { boss: /^mba002$/i, re: /_eye(_\d+)?$/i },
];

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
  // 블랙스미스 촉수 - 메쉬 이름이 Object002 · Object004 라 공용 규칙에 안 걸려 '기타' 로 갔다
  { boss: /^bbg003/i, re: /^Object00[24]$/i, group: '촉수' },
  // 알트아이젠 미사일 포트(rocket) - 공용 '날개' 규칙(rocket)에 걸려서 무기로 옮긴다
  { boss: /^mbg001/i, re: /_rocket_\d+_skin$/i, group: '무기' },
];

// 파츠 패널의 묶음 순서. 여기 없는 묶음은 '기타' 바로 앞에 선다.
const PART_GROUP_ORDER = ['몸통', '본체', '머리', '어깨', '팔', '다리', '날개', '무기', '촉수', '가시',
  '부속', '프레임', '인간형', '소환수', '해파리', '발광', '연출', '기타'];

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

// 이름이 겹치는 클립. 사치스러운 거미는 파일에 dead_01 이 두 벌 들어 있다 —
// 애니메이터용과 사망 연출(타임라인)용으로 뼈 387개를 같이 움직이는데 위치가
// 최대 22 만큼 다르다. 목록에서 이름으로 찾으면 둘째는 영영 못 고르므로 번호를 붙여
// 가르되, 게임 타임라인이 쓰는 쪽(extras.timeline 이 있는 쪽)이 원래 이름을 갖게 한다.
// 연출 카메라가 pairedClip 이름으로 짝을 찾기 때문이다 — 순서대로 가르면 카메라가
// 애니메이터용에 붙어서 사망 연출이 게임과 다른 몸 동작으로 돌았다.
// defs 는 파일의 animations(순서가 clips 와 같다).
function dedupeClipNames(clips, defs) {
  const onTimeline = i => !!(defs && defs[i] && defs[i].extras && defs[i].extras.timeline);
  const groups = new Map();
  clips.forEach((c, i) => {
    const n = c.name || '';
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(i);
  });
  groups.forEach((idx, n) => {
    if (idx.length < 2) return;
    const keep = idx.find(onTimeline);
    const order = keep === undefined ? idx : [keep, ...idx.filter(i => i !== keep)];
    order.forEach((i, k) => { if (k > 0) clips[i].name = n + '_' + (k + 1); });
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

// 신형 추출본의 기본 배율·높이 보정. 시점 초기화도 이 값으로 돌아간다.
//   온리 원 - 소환수(ziz/behamoth/leviathan)가 본체에서 떨어져 있어서 정규화가
//   그만큼 작게 잡는다. 화면에 맞게 1.3 배, 0.3 아래로.
//   camY - 카메라 눈높이. 카메라와 시선을 같은 값만큼 올려서 각도는 그대로 둔다.
//   camDist - 기본 시점 거리. 안 적으면 공용값 2.3 을 쓴다. 이 값을 줄이면
//     모델은 그대로 두고 카메라만 다가간다 — 눈높이·각도는 안 바뀐다.
//   camDrop - 카메라만 이만큼 내린다(시선은 그대로). camY 와 달리 각도가 바뀐다 —
//     카메라가 시선보다 낮아져서 아래에서 올려다보는 구도가 된다.
const CATALOG_FIT_OVERRIDES = {
  xbg003: { scale: 1.0, position: [0, 0, 0], camY: 0.05 },
  // 미러 컨테이너는 옆으로 넓고 위아래로 낮아서, 세로 크기로 잡는 기본 눈높이가
  // 보스 발치까지 내려온다. 보스 한가운데로 올린다.
  xba001: { scale: 1.0, position: [0, 0, 0], camY: 0.33 },
  // 퀸 001 - 공용 거리 2.3 에서는 멀어 보인다(화면 세로 0.53). 1.84 로 당기면 0.66.
  xba002: { camDist: 1.84 },
  // 마더웨일 - 정면 조금 아래에서 올려다보는 구도(약 4.5도).
  // 카메라는 바닥 격자(높이 0)보다 위에 있어야 한다. 0.35 는 바닥 밑(-0.07)으로 들어가
  // 격자를 아래에서 봤고, 0.25 는 바닥과 거의 같은 높이(0.01)라 격자가 한 줄로 보였다.
  bba001: { camDrop: 0.2 },
  // 울트라 - 옆으로 넓고 낮은 거미형이라 공용 거리 2.3 에서는 화면 가로 32% · 세로 19% 로
  // 작게 잡혔다(사치스러운 거미 48%, 마더웨일 47%). 두 시즌(bbg006 / bbg006_hsta)에 같이 걸린다.
  //   2026-10-04 - 크라켄(화면 73~75%) · 프로비던스(63%) 크기에 맞춰 달라는 요청으로 1.6 -> 1.08(46% -> 약 68%).
  bbg006: { camDist: 1.08, camY: -0.07 },   // 가까이 가니 화면 아래로 -0.15 쏠려서 눈높이를 내린다
  // 모더니아 - 바닥 위로 띄운 만큼(CATALOG_FIT_BASE y) 눈높이도 올린다. 두 시즌 공통.
  //   거리 2.3 -> 1.79(53% -> 약 68%, 위와 같은 요청).
  //   같은 날 다시 '좀 멀게' 요청 - 1.79 -> 2.05(약 1.15배)
  mbg004: { camY: 0.07, camDist: 2.05 },        // 시즌 6 - 0.66배로 줄여서 띄운 높이 · 화면 중심이 달라 따로 맞췄다
  mbg004_anmi: { camY: 0.22, camDist: 2.05 },
  // 아래는 같은 요청(크라켄 · 프로비던스 크기, 화면 세로 · 가로 중 큰 쪽을 약 68% 로)으로 넣었다. 괄호는 공용 거리 2.3 에서 잰 값.
  // 거대 질량체 (30%). 0.85 -> 1.0('좀 멀게') -> 1.6('너무 가까워 스킬이 안 보인다') -> 1.8(요청). 1.0 에서 스킬 01 · 02 · 06 · 07 · 10 은
  // 화면 높이 0.8~1.0 배였고, 03 · 04 · 08 은 몸에서 멀리 뻗어 3~5 배라 공용 2.3 에서도 다 안 들어온다.
  eba004: { camDist: 1.8 },
  bbg002: { camDist: 0.95, camY: 0.05 },   // 토커티브 (28%)
  ebg001_hsta: { camDist: 1.45 },  // 랜드 이터 (43%)
  ebg001_island: { camDist: 1.45 },  // 아일랜드 이터 - 랜드 이터와 같은 모델이라 같은 거리(요청)
  xbg001: { camDist: 1.6 },        // 크리스탈 체임버 (41%). 1.39 에서 '좀 멀게' 요청으로 1.6
  // 스톰브링어 (45%) - 화면 중심보다 위(+0.29)에 있어 눈높이도 그만큼 올린다
  eba001: { camDist: 1.52, camY: 0.28 },
  // 인디빌리아 - PHASE_LIFT 로 1페이즈를 0.21 내린 만큼 처음 눈높이도 내린다(위 PHASE_LIFT 설명 참고)
  ebg003: { camY: -0.21, camDist: 2.0 },   // 거리는 '좀 가깝게' 요청(2.3 -> 2.0)
  // 아래는 같은 날 요청 - 크라켄은 좀 멀게, 알트아이젠 · 앨트루이아는 좀 가깝게(약 1.15배 / 0.87배)
  bbg004: { camDist: 2.65 },       // 크라켄 (황금 · 환영 공통)
  mbg001: { camDist: 2.0 },        // 알트아이젠 (두 시즌). 페이즈별 배율(PHASE_CAM_DIST 0.85 / 0.55)은 이 거리에 곱해진다
  xbg004: { camDist: 2.0 },        // 앨트루이아 (두 시즌)
  // 프로비던스 - 화면 중심보다 위(+0.23)라 카메라를 살짝 올린다(요청)
  xbg002: { camY: 0.15 },
  // 하베스터 - 같은 거리에서 사치스러운 거미보다 작게 잡혀(가로 42% · 47%) 화면 크기를 맞춘다(요청).
  // 보스 코드가 같아서 거미 줄(빈 값)을 따로 둬야 거미가 이 값을 안 쓴다.
  bbg001: { camDist: 2.1 },
  bbg001_rich: {},
  // 마테리얼H - 공용 거리 2.3 에서는 멀어 보인다(사용자 요청, 2026-10-04). 두 시즌(ebg002_dmtr / _hsta)에 같이 걸린다.
  ebg002: { camDist: 1.3 },
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
  ebg001_hsta: { pitch: 10 },   // 랜드 이터 - 아일랜드 이터와 같은 모델
  eba001: { y: 0.2 },           // 스톰브링어 - 기준 높이
  bba001: { y: 0.1, pitch: 10 },   // 마더웨일 - 기준 높이, 기준 상하 각도 10(사용자 요청, 2026-10-04). 두 시즌 공통
  // 백빙룡 - 바닥에 붙어 보여서 띄운다(사용자 요청, 2026-10-04). 니힐리스타(mba002)에는 안 걸린다.
  mba002_whiteice: { y: 0.15 },
  // 글러트니 · 차가운 심판자 - 기준 상하 각도(사용자 요청, 2026-10-04). bbg009_bh 는 보스 코드(bbg009)로 잡힌다.
  bbg009: { pitch: 20 },
  // 모더니아 - 떠 있는 기체인데 대기 자세에서 몸 아래(-0.23)와 아래로 뻗은 날(mbg005, -0.32)이 바닥 밑에 묻혔다.
  // 시즌 6 은 같은 거리에서 화면 세로 79% 로 A.N.M.I.(53%)보다 크게 잡혀 위가 잘려서 줄인다.
  // 키를 둘로 적는다 - mbg004_anmi 가 없으면 보스 코드(mbg004) 줄을 같이 쓴다.
  mbg004: { y: 0.27, scale: 0.66 },   // 0.8 -> 0.66: A.N.M.I. 와 같은 화면 크기(53%)로 맞춘 뒤 거리를 둘에 같이 줬다
  mbg004_anmi: { y: 0.32 },
  // 그레이브 디거 - 땅을 파는 모양이라 앞뒤로 길다(보이는 범위 x 0.32,
  // y 0.32, z 1.01). 정규화가 긴 쪽인 깊이로 잡아서 화면에서 매우 작아진다.
  mbg002: { scale: 2.2, y: -1.45 },
};

// 같은 보스라도 모델 항목(페이즈)마다 다르게 줘야 하면 "코드@페이즈" 로 적는다.
// 변종은 파일 이름(bossKey)으로도 찾는다 — 원종과 코드가 같기 때문이다.
function catalogFitBase(bossKey, bossCode, labelPhase) {
  return CATALOG_FIT_BASE[bossKey + '@' + labelPhase]
    || CATALOG_FIT_BASE[bossKey]
    || CATALOG_FIT_BASE[bossCode + '@' + labelPhase]
    || CATALOG_FIT_BASE[bossCode] || {};
}

// 페이즈마다 기본 시점 거리가 달라야 하는 보스. 배수로 적는다(1 이 공용 거리).
// 각도·눈높이는 그대로 두고 거리만 바꾼다.
//   리버렐리오 바디 - 2페이즈 몸이 1페이즈보다 작아서 같은 거리면 멀어 보인다.
const PHASE_CAM_DIST = [
  { boss: /^eba002/i, phase: '2', scale: 0.7 },
  // 울트라 - 2페이즈는 껍데기가 벗겨져 몸이 작다(같은 거리에서 가로 33%, 1페이즈 48%).
  { boss: /^bbg006/i, phase: '2', scale: 0.75 },
  // 지즈 - 2페이즈는 날개가 얇은 깃털뿐이라 몸이 작아 보인다(같은 거리에서 가로 50%, 1페이즈 57%).
  { boss: /^eba005/i, phase: '2', scale: 0.75 },
  // 니힐리스타 · 백빙룡 - 날개 뼈(깃털 · 미사일)가 좌우 ±55 까지 뻗어 있어 정규화 상자가 몸(±19)의
  // 세 배로 잡힌다. 1페이즈는 날개가 꺼져 있어도 뼈는 남아서 가로 12% 로 보였다.
  { boss: /^mba002$/i, phase: '1', scale: 0.35 },
  // 2페이즈는 백빙룡(같은 모습)과 같은 거리(사용자 요청, 2026-10-04). x · y 로 화면 가운데에 맞춘다(같은 날 요청).
  // 날갯짓으로 위끝이 크게 오르내려서 대기 4초 동안 10번 잰 화면 상자 중심의 평균으로 맞췄다.
  { boss: /^mba002$/i, phase: '2', scale: 0.6, x: 0.037, y: -0.017 },
  { boss: /^mba002_whiteice/i, phase: '2', scale: 0.6, x: 0.045, y: 0.149 },
  // 알트아이젠 - 2페이즈는 1페이즈 몸의 왼쪽 아래 일부(전차)만 남아 같은 거리에서 작고 왼쪽으로 쏠린다. 당기고 시선을 옮긴다.
  // 인디빌리아 2페이즈 - 카메라를 조금 내린다(사용자 요청, 2026-10-04). 시선을 내리면 보스가 화면 위로 올라간다.
  { boss: /^ebg003/i, phase: '2', y: -0.1 },
  { boss: /^mbg001/i, phase: '1', scale: 0.85 },   // 1페이즈도 조금 당긴다(사용자 요청, 2026-10-04)
  { boss: /^mbg001/i, phase: '2', scale: 0.55, x: -0.26 },
];

// 땅속에 묻어 두는 파편. 게임은 지형이 가려서 안 보이는데 뷰어 바닥은 비쳐서 드러난다. 이 뼈가 바닥(월드 y 0)
// 아래로 내려가 있으면 그 프레임만 크기를 0 으로 접는다(다음 프레임 첫머리에 되돌린다).
//   알트아이젠 2페이즈 - 대기가 부서진 1페 껍데기 조각(2phase_broken_*)과 런처 뚜껑(launcher_cap_*)을 y -0.59 에 둔다.
const UNDERGROUND_HIDE = [
  { boss: /^mbg001/i, re: /^(2phase_broken_\d+|launcher_cap_\d+)$/i },
];

// 페이즈마다 모델 높이를 따로 주는 보스. 정규화 그룹(normGroup)을 이만큼 올린다(정규화 단위).
// 모델 항목이 하나인데 페이즈 버튼으로 모습이 바뀌는 보스라 CATALOG_FIT_BASE(모델 항목 단위)로는 못 준다.
//   니힐리스타 - 2페이즈(날개 달린 모습)는 바닥에서 띄운다. 백빙룡(같은 모습)의 y 0.15 와 맞춘다(사용자 요청, 2026-10-04).
const PHASE_LIFT = [
  { boss: /^mba002$/i, phase: '2', y: 0.15 },
  // 인디빌리아 - 대기 자세에서 공중에 떠 있다(사용자 지적, 2026-10-04). 1페이즈 다리 최저 0.213, 2페이즈 0.041.
  // 시선은 처음 불러올 때만 같은 만큼 내린다(CATALOG_FIT_OVERRIDES camY). 페이즈를 바꿀 때 생기는 차이(+0.17)는
  // 추적 카메라가 리그를 따라가며 맞춘다 - 여기에 시선 이동까지 얹으면 두 번 움직여 2페이즈가 화면 아래로 쏠렸다.
  { boss: /^ebg003/i, phase: '1', y: -0.21 },
  { boss: /^ebg003/i, phase: '2', y: -0.04 },
];

// 클립 하나만 눈높이가 따로 필요한 경우. 그 클립을 재생하는 동안 카메라와 시선을
// 같은 값만큼 올린다 — 각도와 거리는 그대로다.
const CLIP_CAM_LIFT = [
];

// 클립 하나만 시점 거리를 따로 줘야 하는 경우. 그 클립을 재생하는 동안 카메라를 시선에서 scale 배로 물린다
// (눈높이 · 각도는 그대로). 다른 클립으로 넘어가면 기본 거리로 돌아온다.
//   거대 질량체 - 몸통은 화면 안인데 연출 덩어리(F_skin)가 펼쳐져 화면 밖으로 나간다(사용자 지적, 2026-10-04).
//   기본 거리 1.8 에서 전 구간 화면 범위: 스킬 08 묶음 y -1.16 ~ 1.26, 스킬 fire_09 y -1.71 ~ 1.14.
// 연출을 원점으로 옮기지 않을 동작(applyCineShift). 문제가 생긴 연출만 여기 적는다.
const CINE_NO_RECENTER = [
];

const CLIP_CAM_DIST = [
  { boss: /^eba004/i, re: /^eba004_skill_(start|loop|fire)_08$/i, scale: 1.4 },
  { boss: /^eba004/i, re: /^eba004_skill_fire_09$/i, scale: 2.0 },
];

function getBossTransform(bossCode) {
  // 추출본은 루트 노드에 방향 회전이 이미 들어 있고(쿼터니언 [0,-1,0,0] = yaw 180도)
  // GLTFLoader 가 그걸 적용한다. 좌우 180도가 이 보스들의 정면이다(테스트 뷰어에서 확인).
  // 정규화가 전체 바운딩 기준이라, 화면에서 벗어난 파츠까지 세면 보스가 작게 잡히는
  // 보스가 있다. 그런 보스만 기본 배율·높이를 손으로 맞춰 둔다.
  const fit = CATALOG_FIT_OVERRIDES[bossCode];
  return {
    rotation: [0, 180, 0],
    position: fit && fit.position ? fit.position.slice() : [0, 0, 0],
    scale: fit && fit.scale ? fit.scale : 1,
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
  // 본체 메쉬를 못 박는다 - 좌우 머리도 본 수가 같아서 자동으로 고르면 머리가 걸릴 수 있다.
  { boss: /^bbg008/i, mesh: /^bbg008_body_skin(_\d+)?$/i, bone: HEAD_BONE_RE },
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

// 연출 카메라는 추출본 값(위치·회전·화각)을 그대로 쓴다.
//
// 2026-09-30 추출기가 카메라 식을 고쳤다(카메라 = vcam 부모 월드 × 클립(0)⁻¹ ×
// 클립(t) × 음수스케일 부호, 유니티에서 타임라인을 재생해 218개 카메라를 대조).
// 그 전의 카메라 값은 틀려서 보스마다 보정을 표로 들고 있었다 — 홀더 끼우기,
// 좌우 밀기·뒤로 물리기·반대편으로 돌리기, 겨냥 다시 잡기, 게이트핏 화각 환산,
// 시선 뒤집기, 멀면 당기기, 파고들면 물리기. 새 파일로 바꾸면서 보정 없이 인게임과
// 맞는 것을 보스마다 눈으로 확인했고, 전부 걷어냈다.
//
// 뷰어가 하는 일은 둘뿐이다(applyCinematicCamera 의 syncCinematicTimeline).
//   타임라인 맞추기 - 카메라와 모델 클립이 타임라인에서 다른 시각에 시작하는
//                    연출(사치스러운 거미 등장은 모델이 4.73초 늦다)
//   메쉬 활성 구간 - 연출 중에만 켜지고 꺼지는 메쉬(검은 뱀 좌우 머리 등)
// 화각은 파일 값(fovDegrees)을 three.js 세로 화각으로 그대로 넣는다.

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
  // 한 동작에 카메라가 여럿 붙은 연출. 타임라인에서 컷마다 카메라가 갈린다 —
  // 지즈 1->2 변신은 모델 동작 하나(8.2초)에 Camera(0~3.317) · Camera (1)(3.317~8.183).
  const cutsByModel = new Map();
  // 내보내기가 짝을 적어 준 카메라부터 처리한다. 이름 규칙보다 이쪽이 정확하다 —
  // 베히모스 dead_camera2 는 이름만 보면 dead_2 와 붙지만 실제 짝은 dead 다.
  cams.forEach(cam => {
    const node = nodeOf.get(cam.name);
    const ud = (node && node.userData) || {};
    // 짝이 비어 있어도 후보(pairedClipCandidates)가 하나뿐이면 그것이 짝이다 — 니힐리스타 2페 전환
    // 가운데 컷 Camera (2)는 보스 동작이 없고 부속 눈 리그의 2phase_eye 를 비춘다.
    const cand = Array.isArray(ud.pairedClipCandidates) && ud.pairedClipCandidates.length === 1
      ? ud.pairedClipCandidates[0] : null;
    const paired = ud.pairedClip || cand;
    if (!paired) return;
    const target = models.find(c => c.name === paired);
    if (!target) return;
    if (!cutsByModel.has(target.name)) cutsByModel.set(target.name, []);
    cutsByModel.get(target.name).push({ clip: cam, node });
    // byModel 에는 먼저 나온 것을 둔다
    if (!byModel.has(target.name)) byModel.set(target.name, { clip: cam, node });
  });
  // 컷이 하나뿐인 동작은 지우고, 여럿이면 타임라인 시작 순으로 세운다
  const tlStartOf = p => (p.node.userData && typeof p.node.userData.timelineStart === 'number')
    ? p.node.userData.timelineStart : 0;
  cutsByModel.forEach((list, k) => {
    if (list.length < 2) cutsByModel.delete(k);
    else list.sort((a, b) => tlStartOf(a) - tlStartOf(b));
  });
  // 짝이 안 적힌 카메라만 이름으로 찾는다
  cams.forEach(cam => {
    const node0 = nodeOf.get(cam.name);
    if (node0 && node0.userData && node0.userData.pairedClip) return;
    if (node0 && node0.userData && Array.isArray(node0.userData.pairedClipCandidates)
        && node0.userData.pairedClipCandidates.length === 1) return;
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
  return { cams, byModel, cutsByModel };
}

// 파일에는 따로 들어 있지만 실제로는 이어서 도는 연출. 한 묶음으로 낸다.
//   미러 컨테이너 2페이즈 파츠는 되살아난 뒤(rebirth) 곧바로 부서진다(Destruction).
const MANUAL_SEQUENCES = [
  // 토커티브 대시 공격 - 타임라인 bbg002_shot_09_dashattack_model: start(0) -> loop(1.0) -> attack(1.933~5.9)
  { key: 'bbg002_front_dash_attack', boss: /^bbg002/i,
    steps: [/^bbg002_front_dash_start_01$/i, /^bbg002_front_dash_loop_01$/i, /^bbg002_front_dash_attack_01$/i] },
  // 블랙스미스 - 스킬 03 뒤에 이어지는 별도 연출(타임라인 bbg003_shot_06_blowbreak_model, trigger 24).
  // fire_loop_03(0~2.67) -> fire_end_03(2.67~5.67). 앞쪽 blow(start · loop · fire_03)는 자동 묶음이 잡는다.
  { key: 'bbg003_skill_03_break', boss: /^bbg003/i,
    steps: [/^bbg003_skill_fire_loop_03$/i, /^bbg003_skill_fire_end_03$/i] },
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
  // 마더웨일 등장 - 게임 타임라인에서 세 컷이 빈틈없이 이어진다(각 카메라 extras).
  //   appearance    0     ~ 2.667   (카메라 _camera_1)
  //   appearance_2  2.667 ~ 4.567   (카메라 _camera_2, 클립은 1.867 이라 0.033 남는다)
  //   appearance_3  4.567 ~ 7.800   (카메라 _camera_3)
  {
    key: 'bba001_appearance_all',
    steps: [/^bba001_appearance$/i, /^bba001_appearance_2$/i, /^bba001_appearance_3$/i],
  },
  // 크리스탈 체임버 등장 - 게임 타임라인(xbg001_appearance)은 카메라 세 컷이다.
  //   take1  0     ~ 6.0     작은 랩처(xcg001)가 크리스탈에 휩싸인다. 맵 연출(boss_appearance)이
  //                          맵 리그 xcg001 에 take1 동작을 튼다(본체에는 동작이 없다)
  //   take2  6.0   ~ 10.533  보스 + 검은 벽(맵 리그 black_t2) — 아래 SIMUL_CLIPS
  //   take3  10.533 ~ 18.767
  // 맵 리그는 repack 이 placement(X축 +7도)대로 본체 공간에 놓아 합친다. take1 카메라는
  // 짝(pairedClip)이 비어 있지만 이름이 같은 take1 동작에 붙는다.
  // 인디빌리아 등장(게임 타임라인 ebg003_1phase_intro_model, sceneType 0 / trigger 31)과
  // 1 -> 2페이즈 전환(ebg003_2phase_intro_model, sceneType 2 / trigger 32). 둘 다 카메라 두 컷이다.
  // 니힐리스타 1 -> 2페이즈(게임 타임라인 phase002_appearance_model, sceneType 2 / trigger 32) - 카메라 세 컷.
  // 가운데 컷(Camera (2), 2.967~4.767초)은 보스 동작 없이 부속 눈 리그(2phase_eye)를 비춘다.
  {
    key: 'mba002_phase02_appearance', boss: /^mba002$/i,
    steps: [/^mba002_phase02_appearance_01$/i, /^2phase_eye$/i, /^mba002_phase02_appearance_03$/i],
  },
  // 알트아이젠 2페 스킬 02(타임라인 mbg001_shot_10_cannon_model) - start 없이 loop(0~1.2) -> fire(1.2~4.6)
  { key: 'mbg001_phase002_skill_02', boss: /^mbg001/i,
    steps: [/^mbg001_phase002_skill_loop_02$/i, /^mbg001_phase002_skill_fire_02$/i] },
  // 크라켄 등장(게임 타임라인 bbg004_phase001_appearance_model, 카메라 네 컷 0 / 2.6 / 6.1 / 9.5초)과
  // 사망(bbg004_dead_model, 카메라 두 컷 0 / 6.133초). 그로기는 start -> loop -> wake 로 끝난다.
  {
    key: 'bbg004_appearance', boss: /^bbg004/i,
    steps: [/^bbg004_intro_take1$/i, /^bbg004_intro_take2$/i, /^bbg004_intro_take3$/i, /^bbg004_intro_take4$/i],
  },
  {
    key: 'bbg004_dead', boss: /^bbg004/i,
    steps: [/^bbg004_outro_take1$/i, /^bbg004_outro_take2$/i],
  },
  // 니힐리스타 · 백빙룡 머리 둘 - 부서지고(Destruction) -> 부서진 채 대기(Destruction_idle) -> 다시 돋는다(generate).
  // 세 동작 다 그 머리 뼈만 움직인다(왼쪽 551 · 541 채널) - 나머지 몸은 SIMUL_CLIPS 의 base 가 대기로 채운다.
  { key: 'mba002_phase02_left_head', boss: /^mba002/i,
    steps: [/^mba002_phase02_left_head_Destruction_02$/i, /^mba002_phase02_left_head_Destruction_02_idle$/i,
      /^mba002_phase02_left_head_generate$/i] },
  { key: 'mba002_phase02_right_head', boss: /^mba002/i,
    steps: [/^mba002_phase02_right_head_Destruction_01$/i, /^mba002_phase02_right_head_Destruction_01_idle$/i,
      /^mba002_phase02_right_head_generate$/i] },
  // 크라켄 촉수 넷 - 부서지고(Destruction) 다시 자라는(rebirth) 동작을 촉수마다 하나로 잇는다.
  // 원본 번호가 제각각이라(Destruction_01~04, rebirth_01) 아래 CLIP_SORT_FIX 로 순서를 세운다.
  { key: 'bbg004_left_big', boss: /^bbg004/i,
    steps: [/^bbg004_left_big_Destruction_01$/i, /^bbg004_left_big_rebirth_01$/i] },
  { key: 'bbg004_left_small', boss: /^bbg004/i,
    steps: [/^bbg004_left_small_Destruction_03$/i, /^bbg004_left_small_rebirth_01$/i] },
  { key: 'bbg004_right_big', boss: /^bbg004/i,
    steps: [/^bbg004_right_big_Destruction_02$/i, /^bbg004_right_big_rebirth_01$/i] },
  { key: 'bbg004_right_small', boss: /^bbg004/i,
    steps: [/^bbg004_right_small_Destruction_04$/i, /^bbg004_right_small_rebirth_01$/i] },
  {
    key: 'bbg004_groggy_01', boss: /^bbg004/i,
    steps: [/^bbg004_groggy_start_01$/i, /^bbg004_groggy_loop_01$/i, /^bbg004_groggy_wake_01$/i],
  },
  {
    key: 'ebg003_appearance', boss: /^ebg003/i,
    steps: [/^ebg003_1phase_intro_01$/i, /^ebg003_1phase_intro_02$/i],
  },
  {
    key: 'ebg003_2phase_intro', boss: /^ebg003/i,
    steps: [/^ebg003_2phase_intro_01$/i, /^ebg003_2phase_intro_02$/i],
  },
  // 미러 컨테이너 등장 - take1(하모니 큐브가 열리는 3.17초) 다음 take2. 맵 리그는 SIMUL_CLIPS 가 같이 돌린다.
  {
    key: 'xba001_appearance', boss: /^xba001/i,
    steps: [/^xba001_appearance_take1$/i, /^xba001_appearance_take2$/i],
  },
  {
    key: 'xbg001_appearance', boss: /^xbg001/i,
    steps: [/^xbg001_1phase_intro_take1$/i, /^xbg001_1phase_intro_take2$/i,
      /^xbg001_1phase_intro_take3$/i],
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
  // 울트라 - 스킬 묶음을 게임 타임라인(bbg006_skill_NN_model) 그대로 잇는다.
  // 시즌 37(H.S.T.A.)과 시즌 7(Z.E.U.S.)은 모델·동작이 같은데 묶음만 다르다.
  //   스킬 03  S7  start_03 -> loop_03 -> fire_03
  //            S37 start_03 -> loop_03            (fire_03 은 스킬 06 으로 갔다)
  //   스킬 06  S7  start_06 -> (2.0~4.333 빈 슬롯) -> 2phase_idle
  //            S37 start_06 -> fire_03 -> 2phase_idle
  // S7 의 스킬 03 은 이름 규칙대로 자동으로 묶인다. 스킬 07(loop 다섯 번)처럼 반복
  // 횟수만 다른 것은 applyTimelineLoops 가 파일 값으로 맞춘다.
  {
    key: 'bbg006_skill_03', boss: /^bbg006_hsta/i,
    steps: [/^bbg006_skill_start_03$/i, /^bbg006_skill_loop_03$/i],
  },
  {
    key: 'bbg006_skill_06', boss: /^bbg006_hsta/i,
    steps: [/^bbg006_skill_start_06$/i, /^bbg006_skill_fire_03$/i, /^bbg006_2phase_idle$/i],
  },
  {
    key: 'bbg006_skill_06', boss: /^bbg006$/i,
    steps: [/^bbg006_skill_start_06$/i, /^bbg006_2phase_idle$/i],
  },
];

// 자동으로 묶지 않는 클립. 사치스러운 거미의 cc(그로기)는 사이에 낀 대기 동작
// 이름이 cc_idle 이라 start/loop/end 규칙에 안 걸린다. 자동 묶음(start+end)을
// 막아 두고 MANUAL_SEQUENCES 에서 start -> idle -> end 로 손수 잇는다.
const NO_SEQUENCE = [
  // 토커티브 - 위 MANUAL_SEQUENCES 가 attack 까지 잇는다
  { boss: /^bbg002/i, re: /^bbg002_front_dash_(start|loop)_01$/i },
  // 크라켄 그로기 - 위 MANUAL_SEQUENCES 가 wake 까지 잇는다
  { boss: /^bbg004/i, re: /^bbg004_groggy_(start|loop)_01$/i },
  { boss: /^bbg001/i, re: /^bbg001_cc_/i },
  // 울트라 - 위 MANUAL_SEQUENCES 가 게임 타임라인대로 손수 잇는다
  { boss: /^bbg006_hsta/i, re: /^bbg006_skill_(start|loop|fire)_03$/i },
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
    // 기본값 한 번. 게임 타임라인에 든 동작은 뒤에 applyTimelineLoops 가 파일 값으로 바꾼다.
    // 타임라인 없이 애니메이터로만 쓰는 동작은 횟수가 게임 코드에 있어서 이 값이 남는다.
    // (예전에는 그로기만 두 번 돌렸다. 타임라인이 있는 그로기는 전부 슬롯 = 동작 한 번이라
    //  맞춰서 한 번으로 바꿨다 — 남아 있던 건 마더웨일 그로기뿐이었는데 너무 길었다.)
    if (g.loop) steps.push({ clip: g.loop.clip, repeat: 1 });
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
  // boss 를 적은 묶음은 그 보스에만 낸다(같은 클립 이름을 쓰는 변종끼리 묶음이 다를 때).
  // 반복 횟수는 여기서 정하지 않는다 — applyTimelineLoops 가 게임 타임라인 값으로 맞춘다.
  MANUAL_SEQUENCES.forEach(def => {
    if (def.boss && !def.boss.test(bossKey || '')) return;
    if (out.some(o => o.key === def.key)) return;
    const steps = def.steps.map(re => clips.find(c => re.test(c.name || '')));
    if (steps.some(c => !c)) return;
    out.push({ key: def.key, steps: steps.map(c => ({ clip: c, repeat: 1 })) });
  });
  out.forEach(o => { o.label = o.key.replace(strip, ''); });
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
  { re: /_phase002_appearance$/i, boss: /^ebg001/i, phase: '1' },
  // 이름에 페이즈가 안 붙은 이동·스킬은 2페이즈 것이다.
  { re: /_move_/i, boss: /^ebg001/i, phase: '2' },
  { re: /_skill_(?:start|loop|fire)_0[1235]$/i, boss: /^ebg001/i, phase: '2' },
  { re: /_dead$/i, boss: /^ebg001/i, phase: '2' },
  // 지즈 - 이름은 2페 등장이지만 1 -> 2 변신 연출이다(게임 데이터 sceneType 2 / trigger 32
  // = 2페 진입). 켜짐 구간도 1페 몸 0~5.53초, 2페 몸 4.67~8.2초다.
  { re: /^eba005_2phase_appearance_take1$/i, boss: /^eba005/i, phase: '1' },
  // 크리스탈 체임버 - 2phase_intro 는 1 -> 2 전환(타임라인 phase02, sceneType 2 / trigger 32)이라
  // 넘어가기 전 페이즈에 둔다. 사망은 2페이즈.
  { re: /^xbg001_2phase_intro$/i, boss: /^xbg001/i, phase: '1' },
  // 니힐리스타 전환은 1페이즈 목록(끝나면 2페이즈로 넘어간다). 백빙룡은 페이즈가 하나라 안 건다.
  { re: /^(mba002_phase02_appearance(_0[13])?|2phase_eye)$/i, boss: /^mba002$/i, phase: '1' },
  // 알트아이젠 전환은 1페이즈 목록(끝나면 2페이즈로 넘어간다)
  { re: /^mbg001_phase002_appearance$/i, boss: /^mbg001/i, phase: '1' },
  // 크라켄 - 등장은 1페이즈, 사망은 2페이즈
  { re: /^bbg004_(intro_take\d|appearance)$/i, boss: /^bbg004/i, phase: '1' },
  { re: /^bbg004_(outro_take\d|dead)$/i, boss: /^bbg004/i, phase: '2' },
  // 인디빌리아 1 -> 2페이즈 전환은 1페이즈 목록에 둔다(끝나면 2페이즈로 넘어간다)
  { re: /^ebg003_2phase_intro(_0[12])?$/i, boss: /^ebg003/i, phase: '1' },
  { re: /^xbg001_death$/i, boss: /^xbg001/i, phase: '2' },
  // 1페이즈 스킬·그로기는 이름에 페이즈 표시가 없다(2페이즈 것은 phase02_ 가 붙는다)
  { re: /^xbg001_(skill|groggy)_/i, boss: /^xbg001/i, phase: '1' },
  // 울트라 - 1페이즈로 등장해서 2페이즈에서 죽는다
  { re: /^bbg006_intro_take3$/i, boss: /^bbg006/i, phase: '1' },
  { re: /^bbg006_outro_take1$/i, boss: /^bbg006/i, phase: '2' },
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
  return clips.find(c => /^xbg001_2phase_intro$/i.test(c.name || ''))   // 크리스탈 체임버(아래 NOT_PHASE_SWITCH 참고)
    // NOT_PHASE_SWITCH 에는 보스를 적은 줄(객체)도 섞여 있다 — 정규식만 본다(보스를 적은 줄은 phase_change 이름이 아니다).
    // 예전에 re.test 를 객체에도 불러 온리 원 · 에고비스타 로드가 통째로 실패했다(2a67617 ~ ).
    || clips.find(c => /phase_?change/i.test(c.name || '')
      && !NOT_PHASE_SWITCH.some(o => o instanceof RegExp && o.test(c.name || '')))
    // 프로비던스처럼 클립 이름이 그냥 "xbg002_2phase" 인 보스도 있다.
    // 뒤에 아무것도 안 붙은 페이즈 이름은 그 페이즈로 넘어가는 연출로 본다.
    || clips.find(c => /^[a-z]{2,4}\d{3}_\d+phase$/i.test(c.name || ''))
    || null;
}

// 목록에 내지 않는 클립. 파일에는 있지만 보여 줄 게 없는 연출이다.
//   (미러 컨테이너 appearance_take1 은 예전에 여기서 감췄다 - 보스가 점으로 접혀 있어 빈 화면이었다.
//   2026-10-02 19:53 추출본부터 그 자리를 채우는 하모니 큐브 맵 리그가 들어와서 등장 묶음으로 되살렸다.)
const HIDDEN_CLIPS = [
  // 블랙스미스 · 마테리얼H empty - 애니메이터 빈 상태(0.03초 · 0.13초)
  { boss: /^bbg003/i, re: /^bbg003_empty$/i },
  { boss: /^ebg002/i, re: /^ebg002_empty$/i },
  // (스톰브링어 · 그레이브 디거 · 사치스러운 거미 shot 은 예전에 여기서 감췄다 - 혼자 틀면 몸이 굳었다.
  //  2026-10-03 부터 샷은 대기를 밑에 깔고 틀어서(OVERLAY_CLIP_RE) 다시 보인다.)
  // 맵 연출 부속 리그 동작 - 보스 동작에 딸려 같이 돈다(SIMUL_CLIPS)
  { boss: /^eba004/i, re: /^eba004_(appearance|death)_acc$/i },
  { boss: /^xba001/i, re: /^xba001_appearance_bg_\d$/i },
  { boss: /^ebg003/i, re: /^ebg003_1phase_intro_01_parts_0[12]$/i },
  // 니힐리스타 · 백빙룡 - 0.07초짜리 빈 동작(empty)
  { boss: /^mba002/i, re: /^mba002_phase0[12]_empty$/i },
  // 백빙룡 - 게임이 안 쓰는 동작(inGameUse []): 1페이즈 동작 전부 · jump · 니힐리스타 전환 앞 컷
  { boss: /^mba002_whiteice/i, re: /^mba002_(phase01_|jump_|phase02_appearance_01$)/i },
  // 크라켄 - 게임이 안 쓰는 동작(inGameUse [])
  { boss: /^bbg004/i, re: /^bbg004_legs_Field_spwan_(start|loop)$/i },
  // 사치스러운 거미 idle_02 는 0.03초짜리라 볼 게 없다.
  { boss: /^bbg001/i, re: /^bbg001_idle_02$/i },
  // 검은 뱀 좌우 머리 클립 - 본체 클립에 딸려서 같이 돈다(SIMUL_CLIPS). 혼자 틀면
  // 꺼져 있는 머리만 움직여서 볼 게 없다. destroy 는 게임이 쓰지 않는다(inGameUse []).
  { boss: /^bbg008/i, re: /_(left|right)(_take2|fire_02)$/i },
  { boss: /^bbg008/i, re: /_(recall_enter_01|destroy_01)_(left|right)$/i },
  // 리버렐리오 바디 - 게임이 연출 동안 꺼진 몸의 root 를 원점에 붙잡아 두는 동작.
  // 키가 처음부터 끝까지 전부 0 이라 아무것도 안 움직인다. 합칠 때 이름이 겹쳐서
  // repack 이 _1pvar / _2pvar 를 붙여 갈라 둔 것이다(tools/repack.py RENAMES).
  { boss: /^eba002/i, re: /^eba002_2phase_death_1pvar$/i },
  { boss: /^eba002/i, re: /^eba002_1phase_intro_2pvar$/i },
  // 스톰브링어 idle_2 도 0.03초짜리다.
  { boss: /^eba001/i, re: /^eba001_idle_2$/i },
  // 그레이브 디거 phase003_idle_empty 는 0.17초짜리다.
  { boss: /^mbg002/i, re: /^mbg002_phase003_idle_empty$/i },
  // 2.5페이즈 대기·전환은 목록에서 뺀다.
  { boss: /^mbg002/i, re: /^mbg002_phase0025_(idle|destroy)$/i },
  // 사망이 파일에 두 벌 들어 있다(애니메이터용 / 사망 연출용, dedupeClipNames 참고).
  // 연출용이 원래 이름을 갖고, _2 가 붙는 애니메이터용은 목록에서 뺀다.
  { boss: /^bbg001/i, re: /^bbg001_dead_01_2$/i },
  { boss: /^ebg001/i, re: /^ebg001_phase001_idle2$/i },
  { boss: /^ebg001/i, re: /^ebg001_phase003_appearance$/i },
  // 사망이 두 벌 들어 있다(ebg001_dead / ebg001_island_dead, 둘 다 6.67초).
  // 연출 카메라(ebg001_dead_scene_camera)가 짝으로 가리키는 쪽이 island_dead 라
  // 그쪽만 남긴다. 예전에는 반대로 감춰서, 보이는 dead 에는 카메라가 안 붙었다.
  { boss: /^ebg001/i, re: /^ebg001_dead$/i },
  // 리버렐리오 바디 - 위 SIMUL_CLIPS 가 대표 클립과 같이 돌리는 딸림 클립들.
  // 혼자 재생하면 나머지 몸이 가만히 있어서 연출이 반쪽이 된다.
  { boss: /^eba002/i, re: /^eba002_1phase_jelly$/i },
  { boss: /^eba002/i, re: /^eba002_2phase_intro_02$/i },
  { boss: /^eba002/i, re: /^eba002_2phase_intro_03jelly$/i },
  { boss: /^eba002/i, re: /^eba002_2phase_death_jelly$/i },
  // 크리스탈 체임버 - 게임이 안 쓰는 동작(extras.inGameUse []). 시즌마다 다르다.
  //   시즌 10(xbg001, P.S.I.D.)  2페 대기 02·03, 2phase_phase_change, 2페 스킬 04stone·08
  //   시즌 35(xbg001_anmi, A.N.M.I.)  1페 스킬 01·06·07, 2페 스킬 01~07
  { boss: /^xbg001$/i, re: /^xbg001_2phase_(idle_0[23]|phase_change)$/i },
  { boss: /^xbg001$/i, re: /^xbg001_phase02_skill_(start|loop|fire)_(04stone|08)$/i },
  { boss: /^xbg001_anmi/i, re: /^xbg001_skill_(start|loop|fire)_0[167]$/i },
  { boss: /^xbg001_anmi/i, re: /^xbg001_phase02_skill_(start|loop|fire)_0[1-7]$/i },
  // 등장 take2 에 딸려 도는 검은 벽 동작(SIMUL_CLIPS)
  { boss: /^xbg001/i, re: /^xbg001_1phase_black_take2$/i },
  // 울트라 - intro_take2 는 게임이 안 쓴다(inGameUse []). 같이 나온 전투기·양산형 니케
  // 부속 파일도 그 긴 등장용이라 넣지 않았다. 게임 등장은 intro_take3(appearance_short)다.
  { boss: /^bbg006/i, re: /^bbg006_intro_take2$/i },
];

// 앞부분을 잘라내고 쓰는 연출. 게임에서는 그 구간을 이펙트가 채우는데
// 내보내기에는 그게 없어서 볼 게 없는 구간에 쓴다.
//   from - 몇 초부터 쓸지(초). to - 몇 초까지 쓸지(초). 둘 다 선택이다.
const CLIP_TRIM = [
  // 스톰브링어 등장 - 3.5초까지는 보스가 y 12.6 상공에 멈춰 있고
  // 카메라도 안 움직인다(거리 13.0 고정, 화면 높이의 10%).
  { boss: /^eba001/i, re: /^eba001_appearance$/i, from: 3.5 },
  // 사치스러운 거미 사망 - 클립은 6.567초인데 게임 사망 타임라인은 5.917초에서
  // 끝난다(카메라 extras.timelineDuration). 그 뒤는 게임에서 안 보이는 구간이다.
  // (예전 파일은 이 구간에 카메라가 시체를 뚫고 지나가서 5.5초로 잘랐었다)
  //
  // 이 보스는 카메라를 두 줄로 따로 적어야 한다. applyClipTrim 은 짝인 카메라를
  // "모델클립이름_camera" 로 찾는데, 여기는 모델이 bbg001_dead_01 이고 카메라가
  // harvester_dead_scene_camera 라 이름이 안 이어진다. 게다가 이 연출은 카메라가
  // 시계라(timelineStart 0 / pairedClipTimelineStart 5.55e-16 로 timeOffset 이
  // 음수) 카메라를 안 자르면 길이가 그대로다.
  { boss: /^bbg001/i, re: /^bbg001_dead_01$/i, to: 5.917 },
  { boss: /^bbg001/i, re: /^harvester_dead_scene$/i, to: 5.917 },
];

// 첫 키에 쓰레기 자세가 박힌 동작. 0프레임에 부위 뿌리 크기가 0(안 보임)이고 그 아래 뼈의
// 위치 · 회전이 엉뚱한 값인데, 둘째 키(1프레임 뒤)에서야 정상이 된다. 게임은 그 한 프레임을
// 그냥 넘기지만 뷰어는 두 키 사이를 보간하면서 크기가 0 -> 1 로 커지는 동안 뼈가 수천 단위로
// 튀어 메쉬가 길게 찢어져 보인다. 위치 · 회전 트랙의 첫 키를 둘째 키 값으로 덮는다(크기는 그대로).
//   크라켄 촉수 rebirth 넷 - 0프레임 Helper_Chain_Root_* 크기 0, 사슬 뼈 위치 -5232 ~ 9171
//   (정상 2 ~ 16), 0.033초부터 정상.
const CLIP_FIRST_KEY_FIX = [
  { boss: /^bbg004/i, re: /^bbg004_(left|right)_(big|small)_rebirth_\d+$/i },
];

function applyFirstKeyFix(clips, bossKey) {
  CLIP_FIRST_KEY_FIX.forEach(rule => {
    if (!rule.boss.test(bossKey || '')) return;
    clips.forEach(c => {
      if (!rule.re.test(c.name || '')) return;
      c.tracks.forEach(t => {
        if (!/\.(position|quaternion)$/.test(t.name) || t.times.length < 2) return;
        const n = t.getValueSize();
        for (let k = 0; k < n; k++) t.values[k] = t.values[n + k];
      });
    });
  });
}

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
// 서로 다른 리그가 이미 한 파일에 다 들어 있으니 액션만 하나 더 얹으면 된다 -
// 클립끼리 건드리는 뼈가 하나도 안 겹치므로 서로 싸우지 않는다.
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
  // 크리스탈 체임버 등장 take2 - 맵의 검은 벽(black_t2)이 같은 슬롯(6.0~10.533)에서 돈다
  { boss: /^xbg001/i, main: /^xbg001_1phase_intro_take2$/i,
    with: [/^xbg001_1phase_black_take2$/i] },
  // 거대 질량체 등장·사망 - 맵 연출의 부속 리그(model_acc · death_acc_md)가 같은 길이로 같이 돈다
  { boss: /^eba004/i, main: /^eba004_appearance_f$/i, with: [/^eba004_appearance_acc$/i] },
  { boss: /^eba004/i, main: /^eba004_death$/i, with: [/^eba004_death_acc$/i] },
  // 미러 컨테이너 등장 - 맵 연출의 하모니 큐브 리그(appearance_bg_var)
  { boss: /^xba001/i, main: /^xba001_appearance_take1$/i, with: [/^xba001_appearance_bg_1$/i] },
  { boss: /^xba001/i, main: /^xba001_appearance_take2$/i, with: [/^xba001_appearance_bg_2$/i] },
  // 인디빌리아 1페 등장 앞 컷 - 맵 연출 리그 둘(ecg007 · arms_parts, 타임라인 0~7.467초 = intro_01 슬롯)
  { boss: /^ebg003/i, main: /^ebg003_1phase_intro_01$/i,
    with: [/^ebg003_1phase_intro_01_parts_01$/i, /^ebg003_1phase_intro_01_parts_02$/i] },
  // 검은 뱀 - 가운데 본체와 좌우 머리가 리그 셋이다(2026-09-30 재추출부터 머리가 따로
  // 나온다. tools/repack.py 가 머리 쪽 이름에 _left / _right 를 붙여 합친다).
  // 등장 take2 는 셋이 타임라인 3.23~10.67초에 같이 돈다(7.433초, 길이 같음).
  // 머리는 4.75~6.75초에 땅 위로 올라왔다가 다시 파고든다.
  { boss: /^bbg008/i, main: /^bbg008_appearance_take2$/i,
    with: [/^bbg008_appearance_left_take2$/i, /^bbg008_appearance_right_take2$/i] },
  // 2페 스킬02 - 셋이 2.33~5.00초에 같이 돈다(2.667초).
  { boss: /^bbg008/i, main: /^bbg008_2phase_skill_fire_02$/i,
    with: [/^bbg008_2phase_skill_leftfire_02$/i, /^bbg008_2phase_skill_rightfire_02$/i] },
];

// 게임이 대기 위에 덧입혀 트는 동작 — 레이어 정보가 없는 예전 파일에서만 이 이름으로 짐작한다.
// 레이어 정보가 있으면 동작의 animatorStates(레이어 1 이상)로 정한다 — 마더웨일 샷처럼 이름은 shot 인데
// 기본 레이어(0)에 있는 몸 전체 동작도 있다.
const OVERLAY_CLIP_RE = /(destruction|rebirth|generate|(^|_)shot(_|\d|$))/i;

// 덧입히는 동작에서 고정값 트랙을 걸러 낸다(클립을 제자리에서 고친다, 한 번만).
// 샷 · 파괴 동작 파일에는 실제로 안 움직이고 값만 박힌 뼈 트랙이 많다 — 미러 컨테이너 shot_03 은
// 2293 개 중 2259 개, 니힐리스타 2페 샷은 551 개 중 307 개. 그대로 두면 그 뼈가 대기 대신 고정값에
// 묶여 몸이 굳고, 몸 뿌리(root)가 대기와 다른 값(미러 컨테이너 위치 1.96)에 박혀 몸통 각도가 틀어지고,
// 머리 사슬 일부만 고정돼 머리가 몸과 어긋났다. 게임 레이어는 움직이는 뼈만 덮는 것으로 본다.
//   움직이는 트랙            -> 동작 것
//   몸 뿌리 쪽 뼈(rootLike)   -> 대기 것(고정값이어도)
//   대기 첫 값과 같은 고정값    -> 자리만 채운 키다, 대기 것
//   대기와 다른 고정값        -> 동작 것(포신 묶음 크기 0.535 처럼 일부러 잡은 자세)
function prepareOverlayClip(clip, idle, rootLike) {
  if (clip.__overlayPrepared) return;
  clip.__overlayPrepared = true;
  const nodeOf = t => t.name.slice(0, t.name.lastIndexOf('.'));
  const idleBy = new Map((idle ? idle.tracks : []).map(t => [t.name, t]));
  clip.tracks = clip.tracks.filter(t => {
    const n = t.getValueSize();
    const v = t.values;
    let moving = false;
    for (let i = n; i < v.length; i++) {
      if (Math.abs(v[i] - v[i % n]) > 1e-4) { moving = true; break; }
    }
    if (moving) return true;
    if (rootLike.has(nodeOf(t))) return false;
    const it = idleBy.get(t.name);
    if (!it) return true;
    const w = it.values;
    if (/\.quaternion$/.test(t.name)) {
      let dot = 0;
      for (let k = 0; k < 4; k++) dot += v[k] * w[k];
      return Math.abs(dot) < 0.9995;
    }
    for (let k = 0; k < n; k++) {
      if (Math.abs(v[k] - w[k]) > 1e-3 * Math.max(1, Math.abs(w[k]))) return true;
    }
    return false;
  });
}

// 레이어 마스크 안 뼈의 트랙만 남긴다(클립을 제자리에서 고친다, 한 번만).
function prepareMaskedClip(clip, mask) {
  if (clip.__overlayPrepared) return;
  clip.__overlayPrepared = true;
  clip.tracks = clip.tracks.filter(t => mask.has(t.name.slice(0, t.name.lastIndexOf('.'))));
}

// base - 밑에 까는 동작. 대표 클립이 일부 뼈만 움직일 때(머리 파괴처럼 게임이 대기 위에 덧입혀
// 트는 동작) 나머지 몸을 대기 자세로 채운다. 대표 클립이 건드리는 뼈의 트랙은 빼고 깔아서
// 두 동작이 같은 뼈를 반씩 나눠 갖지 않게 하고, 반복해서 돌린다.
const simulBaseCache = new Map();
function simulBaseClip(main, base) {
  const key = main.uuid + '|' + base.uuid;
  if (simulBaseCache.has(key)) return simulBaseCache.get(key);
  const nodeOf = t => t.name.slice(0, t.name.lastIndexOf('.'));
  const taken = new Set(main.tracks.map(nodeOf));
  const c = new THREE.AnimationClip(base.name + '__under_' + main.name, base.duration,
    base.tracks.filter(t => !taken.has(nodeOf(t))));
  simulBaseCache.set(key, c);
  return c;
}

function simulClipsFor(bossKey, name, clips) {
  const o = SIMUL_CLIPS.find(
    x => x.boss.test(bossKey || '') && x.main.test(name || ''));
  if (!o) return null;
  const find = re => (clips || []).find(c => re.test(c.name || ''));
  const main = (clips || []).find(c => c.name === name);
  const out = (o.with || []).map(find).filter(Boolean).map(c => ({ clip: c }));
  if (main) (o.base || []).map(find).filter(Boolean)
    .forEach(c => out.push({ clip: simulBaseClip(main, c), base: true, src: c.name }));
  return out.length ? out : null;
}

function isHiddenClip(bossKey, name) {
  return HIDDEN_CLIPS.some(o => o.boss.test(bossKey || '') && o.re.test(name || ''));
}

// 목록 이름을 손으로 바꾸는 자리. 규칙으로 풀면 다른 보스까지 딸려 바뀌는 경우에만 쓴다.
const CLIP_LABEL_FIX = [
  // 모더니아 등장 - 모델 동작 이름이 empty 다(카메라 mbg004_appearance_sign)
  { boss: /^mbg004/i, re: /^mbg004_empty$/i, label: 'appearance' },
  // strip - 정한 이름 대신 자동 이름에서 앞머리를 뗀다.
  // 차가운 심판자 - 동작이 전부 bbg009_bh_* 라 목록에 bh_ 가 줄줄이 붙는다(글러트니와 같은 리그의 변종 표시).
  { boss: /^bbg009_bh/i, re: /^bbg009_bh_/i, strip: /^bh_/i },
  // 짝인 ebg001_dead 를 목록에서 뺐으니 꼬리표도 뗀다
  { boss: /^ebg001/i, re: /_island_dead$/i, label: 'dead' },
  // 나머지 스킬은 묶음이라 페이즈 태그가 떨어진다. 낱개인 03 만 남아서 맞춰 준다.
  { boss: /^xba001/i, re: /_1phase_skill_03$/i, label: 'skill_03' },
  { boss: /^xba001/i, re: /_2phase_parts$/i, label: '2phase_parts' },
  { boss: /^mbg003/i, re: /_dead_all$/i, label: 'dead' },
  { boss: /^mbg003/i, re: /_2phase_take$/i, label: '2phase_take2+3' },
  { boss: /^mbg003/i, re: /_1phase_take$/i, label: '1phase_take1+2' },
  { boss: /^xbg003/i, re: /_appearance_all$/i, label: 'take01+appearance' },
  { boss: /^mbg001/i, re: /^mbg001_phase002_destroy$/i, label: 'dead' },
  // 백빙룡 첫 등장(sceneType 0 / trigger 31)은 니힐리스타 전환 끝 컷과 같은 동작이다
  { boss: /^mba002_whiteice/i, re: /^mba002_phase02_appearance_03$/i, label: 'appearance' },
  // 지즈 변신 - 모델 동작은 take1 하나뿐이고 take2 는 카메라만 있다. 꼬리표를 뗀다.
  { boss: /^eba005/i, re: /^eba005_2phase_appearance_take1$/i, label: '2phase_appearance' },
  // 울트라 - 게임이 쓰는 등장·사망 컷이 하나씩이라(take2 는 안 쓴다) 꼬리표를 떼고 이름을 맞춘다
  { boss: /^bbg006/i, re: /^bbg006_intro_take3$/i, label: 'appearance' },
  { boss: /^bbg006/i, re: /^bbg006_outro_take1$/i, label: 'dead' },
  // 사치스러운 거미 - 짝이던 idle_02 / dead_01_2 를 뺐고 cc 는 start·end 가
  // 하나씩뿐이라, 뒤에 붙은 번호가 더는 아무것도 안 가른다.
  { boss: /^bbg001/i, re: /^bbg001_idle_01$/i, label: 'idle' },
  { boss: /^bbg001/i, re: /^bbg001_dead_01$/i, label: 'dead' },
  { boss: /^bbg001/i, re: /^bbg001_cc_start_01$/i, label: 'cc_start' },
  { boss: /^bbg001/i, re: /^bbg001_cc_end_01$/i, label: 'cc_end' },
  // 앨트루이아 P.S.I.D.(시즌 42) — 클립 이름의 _03 이 스킬 번호가 아니다.
  //
  // 공백이 든 세 벌은 이름만 _03 이고 실제로는 스킬 5 다. 게임 타임라인을
  // 읽어 확인했다(추출 쪽 조사).
  //
  //   [xbg004_skill_03_model]  스킬 3
  //      0.00~2.33  xbg004_skill_fire_03   (공백 없음)
  //      2.33~3.88  xbg004_idle_01
  //   [xbg004_skill_05_model]  스킬 5 — P.S.I.D. 에만 있다
  //      0.00~1.83  xbg004 _skill_start_03 (공백)
  //      1.83~3.00  xbg004 _skill_loop_03  (공백)
  //      3.00~5.67  xbg004 _skill_fire_03  (공백)
  //
  // 스킬 3 은 원래 start/loop 가 없다. 선행 동작 없이 바로 나가는 패턴이라
  // 두 변종 모두 fire 하나뿐이다(스킬 1·2·4 는 셋 다 있다).
  // 시즌 34 에 이 세 벌이 없던 것은 스킬 5 자체가 없기 때문이다.
  //
  // 이름 사이의 공백도 게임 에셋 이름 그대로다. 'xbg004_skill_start_05' 가
  // 되어야 할 것이 'xbg004 _skill_start_03' 으로 붙은 제작 단계 오타로 보인다.
  { boss: /^xbg004_psid/i, re: /^xbg004 _skill_03$/,       label: 'skill_05' },
  { boss: /^xbg004_psid/i, re: /^xbg004 _skill_start_03$/, label: 'skill_start_05' },
  { boss: /^xbg004_psid/i, re: /^xbg004 _skill_loop_03$/,  label: 'skill_loop_05' },
  { boss: /^xbg004_psid/i, re: /^xbg004 _skill_fire_03$/,  label: 'skill_fire_05' },
];

// 목록 차례는 이름 끝 번호로 매긴다. 위처럼 이름의 번호가 실제와 다른 클립은
// 그대로 두면 엉뚱한 자리에 선다(스킬 5 가 3 과 4 사이에 낀다). 여기서 바로잡는다.
const CLIP_SORT_FIX = [
  // 크라켄 촉수 묶음 - 거대 촉수 L · 촉수 L · 거대 촉수 R · 촉수 R 순
  { boss: /^bbg004/i, re: /^bbg004_left_big(_(Destruction|rebirth)_\d+)?$/i, no: 1 },
  { boss: /^bbg004/i, re: /^bbg004_left_small(_(Destruction|rebirth)_\d+)?$/i, no: 2 },
  { boss: /^bbg004/i, re: /^bbg004_right_big(_(Destruction|rebirth)_\d+)?$/i, no: 3 },
  { boss: /^bbg004/i, re: /^bbg004_right_small(_(Destruction|rebirth)_\d+)?$/i, no: 4 },
  { boss: /^xbg004_psid/i, re: /^xbg004 _skill(_(?:start|loop|fire))?_03$/, no: 5 },
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
  // 크리스탈 체임버 등장 맵 리그(위 DEFAULT_OFF_MESHES 참고)
  { boss: /^xbg001/i, clip: /^xbg001_1phase_intro_take1$/i, show: /^(xcg001_|crys_long)/i },
  { boss: /^eba004/i, clip: /^eba004_appearance_f$/i, show: /_accapp(_\d+)?$/i },
  { boss: /^eba004/i, clip: /^eba004_death$/i, show: /_accdead(_\d+)?$/i },
  { boss: /^xba001/i, clip: /^xba001_appearance_take[12]$/i, show: /_bgvar(_\d+)?$/i },
  { boss: /^ebg003/i, clip: /^ebg003_1phase_intro_01$/i, show: /_map[ab](_\d+)?$/i },
  // 니힐리스타 2페 전환 - 양쪽 페이즈 파츠를 다 켜 두고 1페 팔은 활성 트랙(0~0.017초)이 끈다. 눈은 가운데 컷만.
  { boss: /^mba002$/i, clip: /^mba002_phase02_appearance_0[13]$/i, show: /./, hide: /_eye(_\d+)?$/i },
  { boss: /^mba002$/i, clip: /^2phase_eye$/i, show: /./ },
  // 인디빌리아 1 -> 2페이즈 전환 - 1페 몸(전갈)이 연출 내내 움직이고(1페 뼈 채널 785개),
  // 요르문간드 몸은 게임 타임라인 2.833초(intro_02 시작)부터 켜진다(meshActivation).
  { boss: /^ebg003/i, clip: /^ebg003_2phase_intro_0[12]$/i, show: /./, hide: /_map[ab](_\d+)?$/i },
  // 검은 벽(black_wall_du)은 take2 내내 켠다(게임 타임라인 6.0~10.52초 = take2 슬롯).
  // 파일 배치(루트 180도 + X축 +7도) 그대로 두면 보스 몸을 가리고 크리스탈 조각만 검은 바탕에
  // 떠 보인다. 인게임에도 검은 벽이 나온다(사용자 확인, 2026-10-02). 루트 180도를 빼면 벽이
  // 카메라 뒤로 가서 아예 안 보이므로 그쪽은 아니다.
  // 재질 glow_m 은 아틀라스의 "가운데 검은 원 + 가장자리 투명" 조각을 쓴다.
  { boss: /^xbg001/i, clip: /^xbg001_1phase_intro_take2$/i, show: /^black_wall_du$/i },
  // 페이즈 전환 연출은 그동안 양쪽 페이즈 파츠가 다 켜져 있어야 한다. 파츠가
  // 중간에 생기거나 사라지는 게 아니라, 처음부터 켜진 채로 안 보이는 곳에
  // 숨어 있다 나오거나 화면 밖으로 빠지는 연출이기 때문이다.
  // 에고비스타 phase_change 에서 1·2페이즈 깃털 조인트 28개가 전부 트랙을 갖는 것이
  // 그 증거다 — 갈아 끼울 대상이 아니다.
  // 리버렐리오 바디 - 페이즈 전환은 1·2페이즈 몸이 같이 나온다. 페이즈 방식이
  // exclusive 라 그냥 두면 2페이즈 목록에서 1페이즈 몸이 숨겨진다.
  // 해파리도 여기서 같이 켜진다(show 가 전부라서).
  // 2026-10-02 19:53 추출본부터 해파리가 연출마다 한 벌씩(_intro · _change · _dead) 들어온다.
  // 연출마다 자기 해파리만 켠다. 꼬리 없는 예전 파일(해파리 한 벌)에도 그대로 맞는다.
  { boss: /^eba002/i, clip: /^eba002_2phase_intro_01$/i, show: /./,
    hide: /_jellyfish_[lr]_(intro|dead)$/i },
  // 등장과 사망은 해파리만 되살린다.
  { boss: /^eba002/i, clip: /^eba002_1phase_intro$/i, show: /_jellyfish_[lr](_intro)?$/i },
  { boss: /^eba002/i, clip: /^eba002_2phase_death$/i, show: /_jellyfish_[lr](_dead)?$/i },
  { boss: /^xbg005/i, clip: /_phase_change$/i, show: /./ },
  { boss: /^ebg001/i, clip: /_phase002_appearance$/i, show: /./ },
  // 지즈 변신 - 1·2페이즈 몸을 다 켜 두고, 언제 보이는지는 파일의 meshActivation 에 맡긴다
  // (1페 몸 0~5.53초, 2페 몸 4.67~8.2초, 2페 코어는 첫 프레임만).
  { boss: /^eba005/i, clip: /^eba005_2phase_appearance_take1$/i, show: /./ },
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
// 조작 패널의 표시값은 건드리지 않는다 — 기준 180도 그대로 보인다.
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
  // 리버렐리오 바디 - 이름은 intro 지만 1 -> 2페이즈 전환이다.
  // 진짜 등장은 1phase_intro 쪽이다(아래 APPEARANCE_CLIPS).
  /^eba002_2phase_intro_01$/i,
  // 지즈 - 이름은 2페 등장이지만 1 -> 2 변신이다.
  /^eba005_2phase_appearance_take1$/i,
  // 크리스탈 체임버 1 -> 2페이즈(게임 타임라인 xbg001_phase02, sceneType 2 / trigger 32)
  /^xbg001_2phase_intro$/i,
  // 울트라 1 -> 2페이즈(게임 타임라인 bbg006_phase02, sceneType 2 / trigger 32)
  /^bbg006_1phase_destroy$/i,
  // 니힐리스타 1 -> 2페이즈 - 낱개 세 컷과 묶은 키까지
  /^mba002_phase02_appearance(_0[13])?$/i,
  /^2phase_eye$/i,
  // 알트아이젠 1 -> 2페이즈(게임 타임라인 mbg001_phase002_appearance_model, sceneType 2 / trigger 32)
  /^mbg001_phase002_appearance$/i,
  // 크라켄 1 -> 2페이즈(게임 타임라인 bbg004_phase002_appearance_model) - 껍데기가 부서진다
  /^bbg004_1phase_destroy$/i,
  // 인디빌리아 1 -> 2페이즈 - 낱개 두 컷과 그 둘을 묶은 키까지
  /^ebg003_2phase_intro(_0[12])?$/i,
];

// 이름에 appearance 가 안 들어가는 등장 연출. "등장·사망" 구역으로 보낸다.
//   베히모스 1페이즈는 take1(부품이 날아옴) + take2(조립 완료)가 이어진 등장이다.
// 카메라를 시계로 쓰는 연출. 모델 동작이 카메라보다 훨씬 짧고 타임라인 시작이 같아서(시차 0) 그대로 두면
// 모델 동작이 끝나는 순간 연출도 끝난다.
//   모더니아 등장 - 모델 mbg004_empty 0.03초(한 자세) + 카메라 mbg004_appearance_sign 6.1초
const CAMERA_CLOCK_CLIPS = [
  { boss: /^mbg004/i, re: /^mbg004_empty$/i },
];
const isCameraClockClip = (bossKey, name) =>
  CAMERA_CLOCK_CLIPS.some(o => o.boss.test(bossKey || '') && o.re.test(name || ''));

const APPEARANCE_CLIPS = [
  // 모더니아 등장 - 위 CAMERA_CLOCK_CLIPS 참고
  /^mbg004_empty$/i,
  /^mbg003_1phase_take[12]?$/i,
  // 리버렐리오 바디 - 이름에 appearance 가 안 들어간 등장 연출.
  /^eba002_1phase_intro$/i,
  // 울트라 - 게임 등장(appearance_short)
  /^bbg006_intro_take3$/i,
  // 알트아이젠 사망(타임라인 mbg001_dead_model, sceneType 4 / trigger 2) - 이름이 destroy 다
  /^mbg001_phase002_destroy$/i,
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
//   리버렐리오 바디: 1페이즈 2phase_intro_01 -> 2페이즈
// from - 토글을 낼 페이즈. 여럿이면 배열로 적는다.
// by - 페이즈를 무엇으로 넘기는가. 베히모스는 페이즈마다 모델 항목이 따로라
// 모델 칩을 넘기고, 에고비스타는 한 모델 안이라 페이즈 칩을 넘긴다.
const AUTO_PHASE_CHAIN = [
  { boss: /^mbg003/i, from: '1', by: 'model' },
  { boss: /^xbg005/i, from: '1', by: 'phase' },
  { boss: /^ebg001/i, from: '1', by: 'phase' },
  { boss: /^mbg002/i, from: ['1', '2'], by: 'phase' },
  // 리버렐리오 바디: 1페이즈 2phase_intro_01 -> 2페이즈.
  // 한 모델 안에 두 페이즈가 다 들어 있어 페이즈 칩을 넘긴다.
  { boss: /^eba002/i, from: '1', by: 'phase' },
  // 지즈: 1페이즈 2phase_appearance_take1(변신) -> 2페이즈. 한 모델 안이라 페이즈 칩.
  { boss: /^eba005/i, from: '1', by: 'phase' },
  // 크리스탈 체임버: 1페이즈 2phase_intro -> 2페이즈
  { boss: /^xbg001/i, from: '1', by: 'phase' },
  // 울트라: 1페이즈 1phase_destroy -> 2페이즈
  { boss: /^bbg006/i, from: '1', by: 'phase' },
  // 니힐리스타: 1페이즈 phase02_appearance -> 2페이즈
  { boss: /^mba002$/i, from: '1', by: 'phase' },
  // 알트아이젠: 1페이즈 phase002_appearance -> 2페이즈
  { boss: /^mbg001/i, from: '1', by: 'phase' },
  // 크라켄: 1페이즈 1phase_destroy -> 2페이즈
  { boss: /^bbg004/i, from: '1', by: 'phase' },
  // 인디빌리아: 1페이즈 2phase_intro -> 2페이즈
  { boss: /^ebg003/i, from: '1', by: 'phase' },
];
// 켬/끔은 모델을 바꿔 다시 불러도 유지돼야 한다 — 모듈 스코프에 둔다.
let autoPhaseChain = false;
// 다음 모델을 불러오면 그쪽 전환 연출을 바로 틀라는 표시.
let autoPhasePending = false;

// 이름에 phase_change 가 들어가지만 페이즈 전환이 아닌 동작.
//   크리스탈 체임버 2phase_phase_change - 2페이즈 대기 바꾸기(타임라인 phase02_idle_change,
//   sceneType 1). 전환은 2phase_intro 다.
//   백빙룡 phase02_appearance_03 - 니힐리스타에서는 전환 끝 컷이지만 백빙룡에서는 첫 등장이다
//   (sceneType 0 / trigger 31). 보스를 적은 줄은 그 보스에서만 뺀다.
const NOT_PHASE_SWITCH = [
  /^xbg001_2phase_phase_change$/i,
  { boss: /^mba002_whiteice/i, re: /^mba002_phase02_appearance_03$/i },
];

function isPhaseSwitchClip(name, bossKey) {
  if (NOT_PHASE_SWITCH.some(o => (o instanceof RegExp)
    ? o.test(name || '')
    : (o.boss.test(bossKey || '') && o.re.test(name || '')))) return false;
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
  const on = !!(ev.detail && ev.detail.tab === 'soloraid');
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
  const state = container.__soloRaidModel3D;
  if (!state) return;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  if (state.resizeObserver) state.resizeObserver.disconnect();
  if (state.controls) state.controls.dispose();

  // 다음 로드가 새로 연결하기 전까지, 이전(디스포즈된) 인스턴스를 가리키는
  // 핸들러가 남아있으면 클릭 시 에러가 나므로 항상 비워둔다.
  const resetBtn = document.getElementById('soloraid-spine-reset');
  if (resetBtn) resetBtn.onclick = null;
  const pauseBtn = document.getElementById('soloraid-spine-pause');
  if (pauseBtn) {
    pauseBtn.onclick = null;
    pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
  }
  const phaseToggleEl = document.getElementById('soloraid-phase-toggle');
  if (phaseToggleEl) {
    phaseToggleEl.innerHTML = '';
    phaseToggleEl.classList.add('hidden');
  }
  ['soloraid-anim-toggle'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
  });
  const restartBtn = document.getElementById('soloraid-spine-restart');
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
  container.__soloRaidModel3D = null;
}

window.disposeSoloRaidModel3D = disposeState;

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
  const box = document.getElementById('sr3d-loading');
  if (!box) return;
  box.classList.remove('hidden');
  box.classList.toggle('indeterminate', pct === null);
  const fill = box.querySelector('.sr3d-loading-fill');
  if (fill && pct !== null) fill.style.width = pct + '%';
  const el = box.querySelector('.sr3d-loading-sub');
  if (el) el.textContent = sub || '';
}

function hideLoadingBar(seq) {
  if (seq !== loadSeq) return;
  const box = document.getElementById('sr3d-loading');
  if (box) box.classList.add('hidden');
}

const MB = 1024 * 1024;

window.loadSoloRaidModel3D = function loadSoloRaidModel3D(container, modelUrl, options = {}) {
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
    const st = container.__soloRaidModel3D;
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
  //
  // 위 숫자들(0.6 / 4.0 / 1.6)은 예전 FBX 변환 모델을 맞추며 올린 값이다 — 그 모델들은
  // 재질이 뿌옇게 나와서 방향광을 세게 줘야 형태가 보였다. 지금 추출본은 텍스처와
  // 발광이 제대로 들어오므로 그 보정이 오히려 과해서, 중립적인 값으로 둔다.
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
  dirLight.position.set(1, 2, 1);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight2.position.set(-1, 0.5, -1);
  scene.add(ambientLight, dirLight, dirLight2);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // 후처리 사슬(톤매핑 + 블룸).
  let composer = null;
  let bloomPass = null;

  function setupPostFx() {
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
  container.__soloRaidModel3D = state;
  liveStates.add(state);
  watchTheme();

  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  loader.setMeshoptDecoder(MeshoptDecoder);
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

  loadModelFile(loader, modelUrl, (gltf) => {
    if (container.__soloRaidModel3D !== state) return; // 그 사이 다른 보스로 전환됨

    const meshNamesForBossCode = [];
    gltf.scene.traverse(o => { if (o.isMesh) meshNamesForBossCode.push(o.name); });
    dedupeClipNames(gltf.animations || [],
      (gltf.parser && gltf.parser.json && gltf.parser.json.animations) || null);
    const bossCode = detectBossCode(meshNamesForBossCode, modelUrl);
    // 규칙 표는 파일 이름까지 본다(변종 보스 구분). 표 안 쓰는 쪽(파츠 이름 자르기,
    // 코드로 찾는 표)은 그대로 bossCode 를 쓴다.
    const bossKey = bossKeyFrom(bossCode, modelUrl);
    // 이름으로 물린 표가 전부 이 뒤에 오므로 여기서 잘라 둔다.
    const trimmedClips = applyClipTrim(gltf.animations || [], bossKey);
    applyFirstKeyFix(gltf.animations || [], bossKey);

    // 신형(카탈로그에서 직접 뽑은) 추출본은 기존 FBX 변환본과 규칙이 다르다.
    //  - 루트 노드에 방향 회전이 이미 들어 있다 (공통 225도 보정을 주면 안 된다)
    //  - 페이즈가 파일 단위로 나뉜다 (메쉬 이름으로 페이즈를 거르면 안 된다 —
    //    애니힐리오 2페이즈 파일의 xba003_1phase_magiccarpet_skin 은 이름과 달리
    //    root_phase2 아래에 달린 2페이즈 현역 파츠다)
    //  - 등장·사망 클립이 리그를 통째로 딴 곳으로 옮긴다 (카메라가 따라가야 한다)
    //
    // 예전에는 FBX2glTF 로 변환한 구형 파일도 받아서 곳곳에 구형용 길을 따로 뒀다.
    // 2026-09 에 모델 19개가 전부 추출본으로 바뀌어 그 길은 다 걷어냈다. 혹시 구형이
    // 다시 올라오면 화면이 틀어질 테니 콘솔에만 알린다 — 추출본은 씬 루트에 "*_var"
    // 래퍼 노드가 있다(Draco 를 태우면 asset.generator 는 덮어써지지만 노드 이름은 남는다).
    if (!gltf.scene.children.some(o => /_var$/i.test(o.name || ''))
        && !/NikkeCatalogExplorer/i.test((gltf.asset && gltf.asset.generator) || '')) {
      console.warn('[솔로 레이드 3D] 추출본이 아닌 모델입니다. 방향·크기가 틀어질 수 있습니다.');
    }

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

    setupPostFx();

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

    const bossTransform = getBossTransform(bossCode);
    const [pitchDeg, yawDeg, rollDeg] = bossTransform.rotation;
    // 맞춰 둔 기준 각도. 슬라이더에는 안 들어가서 패널은 0 에서 출발한다 —
    // 배율·높이를 CATALOG_FIT_BASE 로 옮긴 것과 같은 방식이다.
    const fitBase0 = catalogFitBase(bossKey, bossCode, optLabelPhase);
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
      SL[k] = document.getElementById('sr3d-' + k);
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
        const b = document.getElementById('sr3d-' + k + 'v');
        if (b) b.textContent = SL[k].value;
      });
      markFaceButtons();
      const out = document.getElementById('sr3d-out');
      if (out) {
        out.value = 'rotation: [' + SL.pitch.value + ', ' + SL.yaw.value + ', ' + SL.roll.value + '],\n'
          + 'position: [' + SL.px.value + ', ' + SL.py.value + ', ' + SL.pz.value + '],\n'
          + 'scale: ' + SL.sc.value;
      }
    }

    Object.values(SL).forEach(el => {
      if (!el) return;
      el.oninput = () => { if (container.__soloRaidModel3D === state) applySliders(); };
    });

    document.querySelectorAll('.sr3d-face').forEach(btn => {
      btn.onclick = () => {
        if (container.__soloRaidModel3D !== state || !SL.yaw) return;
        SL.yaw.value = btn.dataset.yaw;
        applySliders();
      };
    });

    // 지금 yaw 와 맞는 방향 버튼에 불을 켠다. 슬라이더를 직접 돌려 어긋나면 다 꺼진다.
    function markFaceButtons() {
      const cur = SL.yaw ? Number(SL.yaw.value) : null;
      document.querySelectorAll('.sr3d-face').forEach(b => {
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
    //  - 알파컷: 텍스처 알파 때문인지 (기본 꺼짐)
    //  - 단면: 양면 렌더링의 깊이 정렬 문제인지
    let optWire = false;
    let optAlpha = false;
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
            mt.alphaTest = optAlpha ? 0.5 : 0.05;
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
        if (container.__soloRaidModel3D !== state) return;
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
        // emissive 는 실제 발광색이라 보존하되, 원본 값을 따로 기억해 둔다 —
        // 화면에는 기본으로 끄고 사용자가 고를 때 되살린다.
        if (m.emissive && (m.emissive.r || m.emissive.g || m.emissive.b)) {
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
          // 알파 컷아웃을 끈다.
          //
          // 추출본은 재질이 alphaMode=MASK / cutoff=0.5 로 나오는데, 미사일·총구·
          // 지네관절 같은 가늘고 긴 파츠는 텍스처 알파가 0.5 언저리라 그대로 두면
          // 중간중간 뚫려서 뚝뚝 끊긴 모습이 된다(테스트 뷰어에서 컷아웃을 끄면
          // 멀쩡하게 나오는 것으로 확인).
          // 0 으로 완전히 끄면 LED 발광판처럼 텍스처 대부분이 투명한 파츠가
          // 빨간 네모로 통째로 보인다. 아주 낮은 값으로 두면 완전 투명한 부분만
          // 잘리고, 알파가 0.3~0.5 언저리라 끊겨 보이던 가는 파츠는 그대로 남는다.
          m.alphaTest = 0.05;
        }
      });

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
        m.label = partLabelOf(bossCode, m, raw, bossKey);
        // PART_LABELS 의 인게임 이름이 붙었는지 - 파츠 패널이 이름표 붙은 파츠를 먼저 세운다
        m.userData.__namedPart = m.label !== raw;
      });
    }

    // 파츠 토글은 이름을 키로 쓰는데, 이름이 겹치는 보스가 있다 — 앨트루이아는 메쉬 31개
    // 중 이름이 20종뿐이라 helm_01~09 와 눈이 각각 두 개씩 같은 이름을 쓴다. 그대로 두면
    // 하나를 끄면 짝까지 같이 꺼진다. 겹치는 것만 뒤에 번호를 붙여 구분한다.
    // MESH_RENAME 에서 merge 로 일부러 합친 메쉬(애니힐리오 2페이즈 몸통 두 조각)는 같은 키를
    // 나눠 쓰게 두고 번호를 붙이지 않는다 — 원본은 한 메쉬라 인게임에서도 한 파츠다.
    {
      const seen = new Map();
      meshes.forEach(m => {
        if (m.userData.__mergePart) { m.partKey = m.name || 'mesh'; return; }
        const base = m.name || 'mesh';
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        m.partKey = n > 1 ? base + '#' + n : base;
      });
      // 두 번 이상 나온 이름은 첫 번째에도 번호를 붙여줘야 목록에서 구분이 된다
      const dup = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
      const idx = new Map();
      meshes.forEach(m => {
        if (!dup.has(m.name) || m.userData.__mergePart) return;
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
      // 크리스탈 체임버 - 페이즈 태그가 붙은 메쉬는 2phase_weapon 하나뿐인데, 뼈 크기로 보면 1·2페이즈
      // 대기 모두에서 보인다(페이즈로 숨는 파츠가 없다). 태그를 무시해야 페이즈 칩도 대기 동작
      // (1phase_idle_01 / 2phase_idle_01)으로 1·2 가 다 잡힌다 — 그대로면 "2" 하나뿐이라 칩이 안 나온다.
      { boss: /^xbg001/i, re: /^xbg001_2phase_weapon(_\d+)?$/i, phase: null },
      // 니힐리스타 1phase_head_01(오른쪽 머리)은 2페이즈에도 남는다(전환 활성 트랙 0~10.87초 Active,
      // 페이즈 데이터에서도 꺼지는 건 3페이즈 끝 = 사망).
      { boss: /^mba002$/i, re: /^mba002_1phase_head_01(_\d+)?$/i, phase: null },
      // 알트아이젠 2페 라이플 02 a · b 는 1페이즈 끝에 꺼진다(이름만 phase002)
      { boss: /^mbg001/i, re: /^mbg001_phase002_rifle_02_[ab]_skin(_\d+)?$/i, phase: '1' },
    ];
    const meshPhase = (name) => {
      const fix = MESH_PHASE_FIX.find(
        o => o.boss.test(bossKey || '') && o.re.test(name || ''));
      return fix ? fix.phase : foldPhase(phaseTag(name));
    };
    const basePose = capturePose(gltf.scene);
    // 몸 뿌리 쪽 뼈 - 자식 뼈가 전체의 30% 를 넘는 뼈(root · Pelvis 등). 덧입히는 동작에서 고정값이면
    // 늘 대기를 따른다(prepareOverlayClip).
    const rootLikeBones = new Set();
    {
      const bones = [];
      gltf.scene.traverse(o => { if (o.isBone) bones.push(o); });
      const cnt = new Map();
      bones.forEach(b => {
        for (let p = b.parent; p; p = p.parent) if (p.isBone) cnt.set(p, (cnt.get(p) || 0) + 1);
      });
      cnt.forEach((c, b) => { if (c > bones.length * 0.3) rootLikeBones.add(b.name); });
    }

    // 인게임 카메라. 있으면 등장·사망 연출에서 이걸 그대로 쓴다.
    const camNodes = findCameraNodes(gltf.scene);
    // 동작마다 파일이 적어 준 게임 정보(timeline·timelineStart·meshActivation 등).
    // gltf.animations 는 파일의 animations 와 순서가 같다.
    const clipExtrasByName = new Map();
    ((gltf.parser && gltf.parser.json && gltf.parser.json.animations) || []).forEach((a, i) => {
      const c = (gltf.animations || [])[i];
      if (c && !clipExtrasByName.has(c.name)) clipExtrasByName.set(c.name, a.extras || {});
    });
    const clipExtrasOf = name => clipExtrasByName.get(name) || {};

    // 애니메이터 레이어(2026-10-03 19:53 추출기부터 리그 루트 extras.animatorController, 동작 extras.animatorStates).
    // 파괴 · 재생 · 샷 같은 동작은 레이어 1 이상(전부 Override)에 있어 대기(레이어 0) 위에 덧입혀 돈다.
    // 유니티 합성 규칙(추출 세션이 엔진으로 확인): 레이어 마스크 가중치 > 0 인 뼈는 클립 곡선으로 덮고(고정값도),
    // 마스크 밖 곡선은 무시하고, 마스크 안이라도 곡선이 없으면 대기를 유지한다.
    const animatorCtrls = [];
    ((gltf.parser && gltf.parser.json && gltf.parser.json.nodes) || []).forEach(n => {
      const ac = n && n.extras && n.extras.animatorController;
      if (ac && Array.isArray(ac.layers)) animatorCtrls.push(ac);
    });
    const layerMaskCache = new Map();
    const layerMaskOf = (ac, L) => {
      const key = ac.name + '|' + L.index;
      if (layerMaskCache.has(key)) return layerMaskCache.get(key);
      const set = new Set();
      (L.skeletonMask || []).forEach(m => {
        if (!m || !(m.weight > 0) || typeof m.path !== 'string') return;
        const seg = m.path === '' ? (ac.animator || '') : m.path.split('/').pop();
        if (seg) set.add(THREE.PropertyBinding.sanitizeNodeName(seg));
      });
      layerMaskCache.set(key, set);
      return set;
    };
    // 이 동작이 덧입히는 동작이면 그 레이어 마스크(뼈 이름 Set), 아니면 null.
    // 레이어 정보가 아예 없는 예전 파일은 undefined 를 돌려준다(이름으로 짐작하는 옛 처리로 간다).
    function overlayMaskOf(clipName) {
      const states = clipExtrasOf(clipName).animatorStates;
      if (!Array.isArray(states) || !states.length) return animatorCtrls.length ? null : undefined;
      if (states.some(st => !(st.layer > 0))) return null;
      const li = states[0].layer;
      const hasClip = L => (L.states || []).some(st => (st.clips || []).some(c => c && c.name === clipName));
      let ac = animatorCtrls.find(a => a.layers[li] && hasClip(a.layers[li]));
      if (!ac) ac = animatorCtrls.find(a => a.layers[li] && a.layers[li].name === states[0].layerName);
      return ac ? layerMaskOf(ac, ac.layers[li]) : null;
    }

    const camPairs = camNodes.length
      ? pairCameraClips(gltf.animations || [], camNodes)
      : { cams: [], byModel: new Map(), cutsByModel: new Map() };
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
    const phaseChangeClip = findPhaseChangeClip(gltf.animations || []);
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


    // 묶음 안 반복 동작의 횟수를 게임 타임라인 값으로 정한다.
    //
    // 2026-10-02 재추출부터 동작마다 게임 타임라인 정보가 붙어 온다 — 속한 타임라인
    // (extras.timeline), 그 안의 슬롯 길이(timelineDuration), 반복용 동작인지
    // (unity.animationClip.m_LoopTime). 타임라인 쪽 반복 설정(playableAsset.m_Loop)은
    // 전부 0(동작 설정을 따름)이라, 반복용 동작은 슬롯을 채울 만큼 돈다.
    //   횟수 = 슬롯 길이 / 동작 길이
    // 울트라 skill_loop_07 은 1초짜리가 5초 슬롯이라 다섯 번, 사치스러운 거미 cc_idle 은
    // 1.5초짜리가 5.233초 슬롯이라 3.49번이다. 소수는 정수만큼 돈 뒤 남은 길이만큼 잘라 한 번 더.
    // 슬롯이 동작보다 짧으면 그만큼만 돈다(울트라 스킬 06 끝의 2phase_idle 3.0초 -> 1.533초).
    //
    // 동작마다 타임라인이 하나만 적혀 와서, 묶음의 첫 동작과 같은 타임라인일 때만 쓴다 —
    // 여러 곳에 쓰이는 동작은 다른 타임라인 값이 붙어 있을 수 있다(거대 질량체Q
    // skill_loop_04 에는 skill_05 타임라인 값 0.59 가 붙어 있다).
    // 타임라인 없이 애니메이터로만 쓰는 동작(점프·대시 등)은 횟수가 게임 코드에 있어서
    // 파일에 없다 — 그때는 기존 규칙(그로기 두 번, 나머지 한 번)을 둔다.
    function applyTimelineLoops(seqs) {
      seqs.forEach(sq => {
        if (sq.synthetic) return;
        const first = clipExtrasOf(sq.steps[0].clip.name);
        if (!first.timeline) return;
        const out = [];
        sq.steps.forEach(st => {
          const ex = clipExtrasOf(st.clip.name);
          const ac = (ex.unity && ex.unity.animationClip) || {};
          const dur = st.clip.duration || 0;
          const slot = ex.timelineDuration;
          if (!ac.m_LoopTime || ex.timeline !== first.timeline || !(slot > 0) || !(dur > 0)) {
            out.push(st);
            return;
          }
          const ratio = slot / dur;
          const whole = Math.floor(ratio + 1e-3);
          const rest = ratio - whole;
          if (whole >= 1) out.push({ clip: st.clip, repeat: whole });
          if (rest * dur > 1 / 60) {
            // 남은 길이만큼 자른 같은 이름의 클립. 이름이 같아야 목록·짝짓기가 그대로 간다.
            const cut = THREE.AnimationUtils.subclip(
              st.clip, st.clip.name, 0, Math.round(rest * dur * 1000), 1000);
            if (cut.tracks.length) out.push({ clip: cut, repeat: 1 });
          }
        });
        sq.steps = out.length ? out : sq.steps;
      });
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
    if (singleFilePhases) {
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
          // 접기(merge)도 여기서 건다 — 백빙룡은 phase01_idle 을 2 로 접어야 칩이 하나다
          .map(c => foldPhase(clipPhase(c.name)))
          .filter(Boolean))].sort((a, b) => Number(a) - Number(b));
    // 모델 고르는 칩의 이름이 페이즈를 가리키면(예: "3페이즈") 그 페이즈로 고정한다.
    // 같은 파일을 페이즈별 항목으로 두 번 등록해 쓰는 보스가 있다 — 베히모스 2페이즈
    // 파일에는 2·3페이즈 클립이 같이 들어 있고, DB 에 2페이즈/3페이즈로 나눠 적는다.
    const labelPhase = (String(options.modelLabel || '').match(/(\d+)\s*페이즈/) || [])[1] || null;
    const lockedPhase = labelPhase && phaseKeys.includes(labelPhase) ? labelPhase : null;
    const minPhase = lockedPhase || (phaseKeys.length > 0 ? phaseKeys[0] : null);
    // 모든 보스는 항상 1페이즈(가장 낮은 페이즈)로 시작 - 다른 페이즈는 직접 선택해야 보인다.
    let currentPhase = minPhase;
    // 추출본은 파일 하나가 곧 페이즈 하나라, 메쉬 이름의 phase 태그를 무시해야 한다.
    // 이걸 빼먹으면 2페이즈 파일의 "2phase_" 파츠들이 currentPhase(null) 와 비교돼
    // 전부 숨겨진다 — 실제로 11개 중 6개가 사라졌었다.
    const phaseOf = (name) => (singleFilePhases ? meshPhase(name) : null);

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

    // 메쉬 활성 구간(게임 타임라인의 켜고 끄기). 항목마다 { key, name, path, start, end }.
    let meshActItems = [];
    // 지금 켜져 있는 항목 key. null 이면 규칙이 없다.
    let clipMeshOn = null;
    let clipMeshKey = null;
    // 카메라가 없는 동작의 활성 구간 { list, start }
    let clipMeshAct = null;

    // 파일이 메쉬 노드마다 프리팹 경로를 적어 준다(extras.path). 프리미티브가 여럿인
    // 메쉬는 노드가 그룹이 되고 경로는 그룹에 붙으므로 위로 올라가며 찾는다.
    function meshPathOf(m) {
      for (let o = m; o; o = o.parent) {
        if (o.userData && typeof o.userData.path === 'string') return o.userData.path;
      }
      return null;
    }

    // 항목이 이 메쉬를 가리키는가.
    //  - 경로: 항목 경로 아래에 있으면(검은 뱀 heads 는 머리 둘을 담은 묶음이다 —
    //    메쉬 이름이 본체와 같아서 이름으로는 못 가른다)
    //  - 이름: 파일이 적어 준 이름과 three.js 가 붙인 이름이 다를 수 있다. 같은 이름의
    //    뼈가 있으면 메쉬 쪽에 _1 이 붙고(온리 원 ziz/behamoth/leviathan/2phase_wings),
    //    프리미티브가 여럿인 메쉬는 _2 _3 으로 갈린다. <이름> 과 <이름>_숫자 를 같이 본다.
    function meshActHits(o, m) {
      if (o.path) {
        const p = meshPathOf(m);
        if (p) return p === o.path || p.startsWith(o.path + '/');
      }
      const base = String(m.name || '').replace(/_\d+$/, '');
      return m.name === o.name || base === o.name;
    }

    // 걸리는 항목이 없으면 null. 여러 항목이 덮으면 모두 켜진 구간에만 보인다.
    function meshActState(m) {
      let hit = false;
      for (const o of meshActItems) {
        if (!meshActHits(o, m)) continue;
        hit = true;
        if (!clipMeshOn.has(o.key)) return false;
      }
      return hit ? true : null;
    }

    function startMeshAct(list) {
      meshActItems = list.map((o, i) => ({ key: i + ':' + o.name, name: String(o.name),
        path: typeof o.path === 'string' ? o.path : null, start: o.start, end: o.end }));
      clipMeshOn = null;
      clipMeshKey = null;
      return meshActItems.length ? meshActItems : null;
    }

    // tl - 타임라인 시각(초). 켜진 항목이 바뀔 때만 다시 칠한다.
    function updateMeshAct(tl) {
      let key = '';
      for (const o of meshActItems) {
        if (tl >= o.start - 1e-6 && tl < o.end - 1e-6) key += o.key + '|';
      }
      if (key === clipMeshKey) return;
      clipMeshKey = key;
      clipMeshOn = new Set(key ? key.slice(0, -1).split('|') : []);
      applyVisibility();
    }

    function clearClipMeshAct() {
      clipMeshAct = null;
      if (!clipMeshOn && !meshActItems.length) return;
      clipMeshOn = null;
      clipMeshKey = null;
      meshActItems = [];
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
        if (clipMeshOn && meshActItems.length) {
          const st = meshActState(m);
          if (st !== null) on = st;
        }
        m.visible = on;
      });
    }

    function renderToggleUI() {
      if (!meshes.length) return;
      const box = document.getElementById('soloraid-parts-toggle');
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
      // 같은 키를 나눠 쓰는 메쉬(merge 로 합친 조각)는 한 줄만 낸다
      const listedKeys = new Set();
      meshes
        .filter(m => isPhaseVisible(phaseOf(m.name), currentPhase))
        .filter(m => !listedKeys.has(m.partKey) && listedKeys.add(m.partKey))
        .forEach(m => findGroup(partGroupLabel(bossKey, m.name)).items.push(m));
      // 묶음은 정해 둔 순서로(PART_GROUP_ORDER). 예전에는 메쉬가 파일에 든 순서라 보스마다
      // '기타' 가 맨 앞에 오기도 했다(사용자 요청으로 정리, 2026-10-04).
      const groupRank = label => {
        const i = PART_GROUP_ORDER.indexOf(label);
        return i < 0 ? PART_GROUP_ORDER.length - 1 : i;
      };
      groups.forEach((g, i) => { g.__order = i; });
      groups.sort((a, b) => (groupRank(a.label) - groupRank(b.label)) || (a.__order - b.__order));
      // 묶음 안: 인게임 이름표(PART_LABELS)가 붙은 파츠를 먼저 이름 순(L -> R, Ⅰ -> Ⅱ, 숫자 순)으로,
      // 이름표 없는 파츠는 그 뒤에 내부 이름의 부위 -> 좌우 -> 번호 순으로 세운다.
      // (예전에는 전부 내부 이름으로 세워서 이름표 붙은 파츠가 영문 이름 사이에 섞였다)
      // 한글 가나다순으로는 우(右)가 좌(左)보다, 뒤가 앞보다 앞선다. 좌 -> 우, 앞 -> 뒤 로 서게 바꿔 비교한다.
      const labelOf = m => (m.userData.__namedPart && m.label) ? m.label
        .replace(/\(좌\)/g, '(L)').replace(/\(우\)/g, '(R)')
        .replace(/왼/g, 'L').replace(/오른/g, 'R')
        .replace(/\(앞\)/g, '(1)').replace(/\(뒤\)/g, '(2)') : null;
      groups.forEach(g => {
        g.items.forEach((m, i) => { m.__order = i; });
        g.items.sort((a, b) => {
          const la = labelOf(a), lb = labelOf(b);
          if (la && lb) {
            const c = la.localeCompare(lb, 'ko', { numeric: true });
            if (c) return c;
          } else if (la || lb) {
            return la ? -1 : 1;
          }
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
      const shownSeen = new Set();
      const shown = meshes.filter(m => isPhaseVisible(phaseOf(m.name), currentPhase))
        .filter(m => !shownSeen.has(m.partKey) && shownSeen.add(m.partKey));
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
          if (container.__soloRaidModel3D !== state) return;
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
          if (container.__soloRaidModel3D !== state) return;
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
          if (container.__soloRaidModel3D !== state) return;
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
          if (container.__soloRaidModel3D !== state) return;
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

    const phaseToggleEl = document.getElementById('soloraid-phase-toggle');
    if (phaseToggleEl) {
      if (phaseKeys.length > 1 && !lockedPhase) {
        phaseToggleEl.classList.remove('hidden');
        phaseToggleEl.innerHTML = phaseKeys.map(p => `
          <button type="button" class="filter-chip soloraid-phase-btn${p === currentPhase ? ' active' : ''}" data-phase="${p}">${p}페이즈</button>
        `).join('');
        phaseToggleEl.querySelectorAll('.soloraid-phase-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            currentPhase = btn.dataset.phase;
            refreshFocusMesh();
            applyPhaseCamDist(currentPhase);
            applyPhaseLift(currentPhase);
            phaseToggleEl.querySelectorAll('.soloraid-phase-btn').forEach(b => {
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

    // 정규화 후 정면에서 본다.
    //
    // 예전에는 바운딩박스 중심에서 x·z 로 똑같이 물러난 자리에 카메라를 뒀는데, 그러면
    // 항상 45도 대각선에서 보게 된다 — 테스트 뷰어는 정면(x=0, z=거리)이라 화면이
    // 전혀 다르게 보였다. 좌우·상하가 다 틀어져 보인 원인이 이것이다.
    let normHeight = 1;
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
    //
    // 맵 연출에서 온 리그(FIT_SKIP_MESHES)는 아예 재지 않는다. 거대 질량체 등장 부속은 뼈가
    // 529 유닛까지 뻗어 가장 큰 뭉치가 되고, 리버렐리오 해파리는 1.333배 배치가 붙은 뒤로
    // 49.1 이라 1페 몸(48.3)보다 커져서 기준 뭉치를 빼앗았다 - 보스가 작게 잡혔다.
    const fitGroups = new Map();
    const nv = new THREE.Vector3();
    meshes.forEach(m => {
      if (!m.isSkinnedMesh || !m.skeleton) return;
      if (FIT_SKIP_MESHES.some(o => o.boss.test(bossKey || '') && o.re.test(m.name || ''))) return;
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
      const fitBase = catalogFitBase(bossKey, bossCode, optLabelPhase);
      const bs = fitBase.scale || 1;
      normGroup.scale.setScalar(k * bs);
      normGroup.position.set(0, -nb.min.y * k * bs + (fitBase.y || 0), 0);
      // 눈높이는 기준 보정 전 크기로 잡는다 — 맞춰 둔 시점을 그대로 유지한다.
      normHeight = ns.y * k;
    }

    // 카메라와 시선을 같은 값만큼 올린다 — 각도는 그대로 두고 눈높이만 바꾼다.
    // 파일 이름(bossKey)을 먼저 본다 - 랜드 이터(ebg001_hsta)처럼 변종과 코드가 같은데 시점만 따로 줘야 할 때.
    const fitOv = CATALOG_FIT_OVERRIDES[bossKey] || CATALOG_FIT_OVERRIDES[bossCode] || {};
    const camLift = fitOv.camY || 0;
    camera.position.set(0, normHeight * 0.55 + camLift - (fitOv.camDrop || 0), fitOv.camDist || 2.3);
    controls.target.set(0, normHeight * 0.5 + camLift, 0);

    // 줌 한계. 정규화로 크기를 맞춰 두었으니 보스마다 같은 값을 쓴다 — 너무 가까이 가면
    // 파츠를 뚫고 들어가 안 보이고, 너무 멀어지면 화면에서 안 보일 만큼 작아진다.
    controls.minDistance = 0.4;
    controls.maxDistance = 12;
    camera.near = 0.01;
    camera.far = 100;
    camera.updateProjectionMatrix();

    controls.update();

    homeCamPos = camera.position.clone();
    homeTarget = controls.target.clone();
    initialTarget = controls.target.clone();

    // 페이즈마다 기본 거리가 다른 보스. 시선은 그대로 두고 거리만 늘였다 줄인다.
    let phaseCamScale = 1;
    const phaseCamShift = { x: 0, y: 0 };
    function applyPhaseCamDist(phase, initial) {
      if (!homeCamPos || !homeTarget) return;
      const rule = PHASE_CAM_DIST.find(
        o => o.boss.test(bossKey || '') && o.phase === String(phase));
      // x · y: 시선을 옆 · 위아래로 옮긴다. 추적은 리그 중심을 따라가므로 모델을 옮겨도 소용없고
      // 기준점(initialTarget)을 옮겨야 한다.
      const wantX = (rule && rule.x) || 0;
      const wantY = (rule && rule.y) || 0;
      if (wantX !== phaseCamShift.x || wantY !== phaseCamShift.y) {
        const dx = wantX - phaseCamShift.x;
        const dy = wantY - phaseCamShift.y;
        phaseCamShift.x = wantX;
        phaseCamShift.y = wantY;
        initialTarget.x += dx; homeTarget.x += dx; homeCamPos.x += dx;
        initialTarget.y += dy; homeTarget.y += dy; homeCamPos.y += dy;
        if (initial || followEnabled) {
          controls.target.x += dx; camera.position.x += dx;
          controls.target.y += dy; camera.position.y += dy;
          controls.update();
        }
      }
      const want = (rule && rule.scale) || 1;
      if (want === phaseCamScale) return;
      const k = want / phaseCamScale;
      phaseCamScale = want;
      homeCamPos.sub(homeTarget).multiplyScalar(k).add(homeTarget);
      // 사용자가 직접 돌려 둔 시점은 건드리지 않는다(추적을 끈 상태다).
      // 처음 불러올 때는 아직 아무도 시점을 안 건드렸으니 늘 옮긴다 — 추적이 켜지기 전이라
      // 예전에는 기준점만 바뀌고 카메라는 그대로였다(1페이즈 거리 보정이 처음에 안 먹었다).
      // initial 을 먼저 본다 — 처음 불러올 때는 followEnabled 가 아직 선언 전(let)이라 읽으면 오류가 난다.
      if (initial || followEnabled) {
        camera.position.sub(controls.target).multiplyScalar(k).add(controls.target);
        controls.update();
      }
    }
    applyPhaseCamDist(currentPhase, true);

    // 페이즈마다 모델 높이가 다른 보스(PHASE_LIFT). 시점은 그대로 두고 모델만 올린다.
    let phaseLift = 0;
    function applyPhaseLift(phase) {
      const rule = PHASE_LIFT.find(
        o => o.boss.test(bossKey || '') && o.phase === String(phase));
      const want = (rule && rule.y) || 0;
      if (want === phaseLift) return;
      normGroup.position.y += want - phaseLift;
      phaseLift = want;
    }
    applyPhaseLift(currentPhase);

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

    // 클립별 시점 거리(CLIP_CAM_DIST). 기본 시점(homeCamPos)을 시선 기준으로 늘였다 줄인다.
    let clipCamScale = 1;
    function applyClipCamDist(clipName) {
      if (!homeCamPos || !homeTarget) return;
      const rule = CLIP_CAM_DIST.find(
        o => o.boss.test(bossKey || '') && o.re.test(clipName || ''));
      const want = (rule && rule.scale) || 1;
      if (want === clipCamScale) return;
      const k = want / clipCamScale;
      clipCamScale = want;
      homeCamPos.sub(homeTarget).multiplyScalar(k).add(homeTarget);
      if (followEnabled) {
        camera.position.sub(controls.target).multiplyScalar(k).add(controls.target);
        controls.update();
      }
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
    const PAN_LIMIT = 1.2;

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
    const camWorldPos = new THREE.Vector3();
    const camWorldQuat = new THREE.Quaternion();
    const camWorldScl = new THREE.Vector3();
    const camFwd = new THREE.Vector3();
    let savedFov = null;

    // 타임라인 맞추기 — 모델 클립 시각과 메쉬 활성 구간.
    function syncCinematicTimeline() {
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
          syncSimulTime();
          if (mixer) mixer.update(0);
        }
      }
      if (cinematic.meshAct) {
        updateMeshAct(cinematic.cuts ? cinematic.tlNow
          : cinematic.camStart + cinematic.action.time);
      }
    }

    // 카메라가 여럿인 연출 — 지금 타임라인 시각(모델 동작 기준)에 걸린 컷의 카메라로
    // 갈아타고, 컷마다 카메라 클립 시각을 맞춘다. 슬롯보다 짧은 클립은 끝 프레임에 멈춘다.
    function syncCinematicCuts() {
      if (!cinematic.cuts || !currentAction) return;
      const tl = cinematic.modelStart + currentAction.time;
      cinematic.tlNow = tl;
      let active = cinematic.cuts[0];
      for (const c of cinematic.cuts) {
        const d = c.action.getClip().duration || 0;
        c.action.time = Math.max(0, Math.min(d, tl - c.start));
        if (tl >= c.start - 1e-6) active = c;
      }
      cinematic.node = active.node;
      if (mixer) mixer.update(0);
    }

    // 파일 카메라를 그대로 옮긴다. 위치·회전·화각 모두 파일 값이다.
    function applyCinematicCamera() {
      if (!cinematic || !cinematic.node || !followEnabled) {
        if (savedFov !== null) { camera.fov = savedFov; savedFov = null; camera.updateProjectionMatrix(); }
        return false;
      }
      syncCinematicCuts();
      const node = cinematic.node;
      node.updateWorldMatrix(true, false);
      node.matrixWorld.decompose(camWorldPos, camWorldQuat, camWorldScl);
      camera.position.copy(camWorldPos);
      camera.quaternion.copy(camWorldQuat);
      if (node.isPerspectiveCamera) {
        if (savedFov === null) savedFov = camera.fov;
        if (Math.abs(camera.fov - node.fov) > 1e-4) {
          camera.fov = node.fov;
          camera.updateProjectionMatrix();
        }
      }
      syncCinematicTimeline();
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
      && !/air|skill|(^|_)cc(_|$)|_Destruction_\d+_idle$/i.test(n || '');

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
    // 같은 연출을 나눠 맡는 다른 몸들의 액션(SIMUL_CLIPS). 재생바나 프레임 이동으로
    // 시각을 옮길 때 이쪽도 같이 옮겨야 한다 - 안 그러면 대표 몸만 움직이고
    // 나머지는 그 자리에 멈춰 있다.
    let simulActions = [];

    function syncSimulTime() {
      if (!simulActions.length || !currentAction) return;
      const t = currentAction.time;
      simulActions.forEach(a => {
        const d = a.getClip().duration || 0;
        a.time = a.__baseSrc ? ((a.__baseOffset || 0) + t) % (d || 1) : Math.max(0, Math.min(d, t));
        a.paused = false;
        a.enabled = true;
      });
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

    // 연출을 원점에서 — 게임 타임라인은 연출을 맵의 정해진 자리에서 돌려서 모델과 연출 카메라가 원점에서
    // 2 ~ 15 떨어진 곳에서 나왔다(대기 크기 약 1). 바닥 격자 · 조명은 원점에 있어서 보스가 빈 허공에 떴다.
    // 연출 카메라가 붙은 동작을 틀 때만 모델 중심(추적 기준 리그)의 가로 위치를 동작 전체에서 9번 재 중간값을 잡고,
    // 그만큼 gltf.scene 을 옮긴다. 연출 카메라도 gltf.scene 안에 있어서 같이 옮겨진다 — 화면 구도는 그대로다.
    // 높이는 건드리지 않는다. 다른 동작으로 넘어가면(playClipObject 의 cinematic = null) 되돌린다.
    // (사용자 요청, 2026-10-04)
    const cineCenterCache = new Map();
    let cineShifted = false;
    function cineCenterOf(clip) {
      if (!focusMesh) return null;
      if (cineCenterCache.has(clip.name)) return cineCenterCache.get(clip.name);
      const saved = capturePose(gltf.scene);
      let result = null;
      try {
        const probeMixer = new THREE.AnimationMixer(gltf.scene);
        restorePose(poseFor(clip.name));
        probeMixer.clipAction(clip).play();
        const xs = [], zs = [];
        const v = new THREE.Vector3();
        const d = clip.duration || 0;
        for (let i = 0; i <= 8; i++) {
          probeMixer.setTime(d * i / 8);
          gltf.scene.updateMatrixWorld(true);
          if (rigCenter(focusMesh, v, focusBone) && isFinite(v.x) && isFinite(v.z)) {
            xs.push(v.x); zs.push(v.z);
          }
        }
        probeMixer.stopAllAction();
        probeMixer.uncacheRoot(gltf.scene);
        if (xs.length) {
          const mid = a => a.slice().sort((p, q) => p - q)[a.length >> 1];
          result = { x: mid(xs), z: mid(zs) };
        }
      } finally {
        restorePose(saved);
        gltf.scene.updateMatrixWorld(true);
      }
      cineCenterCache.set(clip.name, result);
      return result;
    }
    function resetCineShift() {
      if (!cineShifted) return;
      gltf.scene.position.set(0, 0, 0);
      gltf.scene.updateMatrixWorld(true);
      cineShifted = false;
    }
    function applyCineShift(clip) {
      if (!cinematic || !followReady) return;
      if (CINE_NO_RECENTER.some(o => o.boss.test(bossKey || '') && o.re.test(clip.name || ''))) return;
      const c = cineCenterOf(clip);
      if (!c) return;
      const dx = followBase.x - c.x, dz = followBase.z - c.z;
      if (Math.hypot(dx, dz) < 0.05) return;
      // 월드 가로 이동을 gltf.scene 의 부모(normGroup) 공간으로 바꾼다 — 상하 각도(pitch)가 걸린 보스도 높이는 그대로
      normGroup.updateMatrixWorld(true);
      const a = normGroup.worldToLocal(new THREE.Vector3(0, 0, 0));
      const b = normGroup.worldToLocal(new THREE.Vector3(dx, 0, dz));
      gltf.scene.position.copy(b.sub(a));
      gltf.scene.updateMatrixWorld(true);
      cineShifted = true;
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
      // 등장·사망처럼 보스가 반대로 서 있는 연출은 모델을 돌려서 맞춘다.
      // 자세·카메라 측정보다 먼저 해야 담김 계산이 돌린 뒤 기준으로 나온다.
      setClipYaw(clip.name);
      // 앞 클립이 옮겨놓은 본을 원위치로. 믹서 교체만으로는 트랙 없는 본이 안 돌아온다.
      restorePose(poseFor(clip.name));
      // mixer.stopAllAction() + 캐시된 action을 reset/play로 재사용하면 3D 렌더링에
      // 눈에 보이는 변화는 없이 내부 바인딩 상태만 꼬이는 경우가 있어 — 믹서를 아예
      // 새로 만들어서 확실하게 교체한다.
      // 덧입히는 동작은 믹서가 트랙을 묶기 전에 덮을 트랙만 남긴다.
      //   레이어 정보가 있으면 - 그 레이어 마스크 안 뼈의 트랙만(고정값 포함)
      //   예전 파일(레이어 정보 없음) - 이름(파괴 · 재생 · 샷)으로 짐작하고 고정값 트랙을 거른다
      const overlayMask = overlayMaskOf(clip.name);
      const isOverlay = overlayMask instanceof Set
        || (overlayMask === undefined && OVERLAY_CLIP_RE.test(clip.name || ''));
      if (overlayMask instanceof Set) prepareMaskedClip(clip, overlayMask);
      else if (isOverlay) prepareOverlayClip(clip, findIdleClipForPhase(currentPhase), rootLikeBones);
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
      // 밑에 까는 대기(base)는 묶음의 다음 단계로 넘어가도 이어서 돈다 — 단계마다 0초로 돌아가면
      // 머리 동작이 바뀌는 순간 몸이 대기 첫 자세로 튄다.
      const prevBase = simulActions.find(a => a.__baseSrc);
      const simulList = simulClipsFor(bossKey, clip.name, gltf.animations) || [];
      // 파괴 · 재생 · 샷은 게임이 대기 위에 덧입혀 트는 동작이다 — 부위 뼈만 움직인다(크라켄 촉수 파괴는
      // 대기가 움직이는 뼈의 12%, 미러 컨테이너 포신 사격은 1%). 지금 페이즈의 대기를 밑에 깐다.
      // 그 동작이 움직이는 뼈는 대기 쪽에서 빼므로 몸 전체를 움직이는 샷이어도 결과가 같다.
      if (isOverlay && !simulList.some(s => s.base)) {
        const idle = findIdleClipForPhase(currentPhase);
        if (idle && idle !== clip) {
          simulList.push({ clip: simulBaseClip(clip, idle), base: true, src: idle.name });
        }
      }
      simulActions = simulList.map(s => {
        const a = mixer.clipAction(s.clip);
        if (s.base) {
          a.setLoop(THREE.LoopRepeat, Infinity);
          a.__baseSrc = s.src;
          a.__baseOffset = (opts.keepQueue && prevBase && prevBase.__baseSrc === s.src) ? prevBase.time : 0;
        } else if (opts.repeat) {
          a.setLoop(opts.repeat === 1 ? THREE.LoopOnce : THREE.LoopRepeat, opts.repeat);
          a.clampWhenFinished = true;
        }
        a.play();
        if (a.__baseSrc) a.time = a.__baseOffset;
        return a;
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
      resetCineShift();
      clearClipMeshAct();
      if (camPair) {
        const camAct = mixer.clipAction(camPair.clip);
        camAct.setLoop(THREE.LoopOnce, 1);
        camAct.clampWhenFinished = true;
        camAct.play();
        // 타임라인 배치. 카메라와 모델 클립이 타임라인에서 서로 다른 시각에
        // 놓인 연출이 있다 - 애니힐리오 1페 등장은 모델이 3.033 초 늦게
        // 시작한다. glb 는 둘 다 로컬 0 부터 굽기 때문에 그 차이를 여기서 낸다.
        //   모델 로컬 = 카메라 로컬 + (timelineStart - pairedClipTimelineStart)
        const cex = (camPair.node && camPair.node.userData) || {};
        let tlOff = (typeof cex.timelineStart === 'number'
          && typeof cex.pairedClipTimelineStart === 'number')
          ? cex.timelineStart - cex.pairedClipTimelineStart : 0;
        // 카메라를 시계로 쓸 연출(CAMERA_CLOCK_CLIPS) - 시차를 아주 작은 음수로 두면 camIsClock 이 선다
        if (tlOff >= 0 && isCameraClockClip(bossKey, clip.name)) tlOff = -1e-6;
        // 메쉬별 활성 구간(타임라인 기준). 연출 내내 켜져 있는 항목은 버린다.
        // 카메라가 여럿인 연출은 카메라 하나의 슬롯이 아니라 모델 동작 전체가 연출이다 —
        // 지즈 변신의 1페 몸(0~5.53초)이 첫 카메라 슬롯(3.317초)을 덮는다고 버려지면 안 된다.
        const maDur = (camPairs.cutsByModel.has(clip.name) && cex.pairedClipTimelineDuration)
          || cex.timelineDuration || 0;
        const meshAct = Array.isArray(cex.meshActivation)
          ? cex.meshActivation.filter(o => o && o.name
              && !(o.start <= 1e-6 && o.end >= maDur - 1e-6))
          : [];
        cinematic = { action: camAct, clip: camPair.clip, node: camPair.node,
          timeOffset: tlOff,
          camStart: (typeof cex.timelineStart === 'number') ? cex.timelineStart : 0,
          meshAct: startMeshAct(meshAct) };
        // 카메라가 여럿인 연출은 모델 동작이 시계고, 카메라는 타임라인 시각에 맞춰
        // 갈아탄다. 각 카메라 클립은 반복 없이 끝 프레임에 멈춘다(유니티 Hold) —
        // 지즈 take1 카메라는 클립 2.10초인데 슬롯이 3.317초까지라 그 사이는 끝 프레임이다.
        const cutList = camPairs.cutsByModel.get(clip.name);
        if (cutList) {
          cinematic.timeOffset = 0;
          cinematic.modelStart = (typeof cex.pairedClipTimelineStart === 'number')
            ? cex.pairedClipTimelineStart : 0;
          cinematic.cuts = cutList.map(p => {
            const a = p.clip === camPair.clip ? camAct : mixer.clipAction(p.clip);
            a.setLoop(THREE.LoopOnce, 1);
            a.clampWhenFinished = true;
            a.play();
            a.paused = true;   // 시각은 syncCinematicTimeline 이 모델에 맞춰 넣는다
            const u = p.node.userData || {};
            return { action: a, node: p.node,
              start: (typeof u.timelineStart === 'number') ? u.timelineStart : 0 };
          });
        }
      } else {
        // 카메라가 없는 동작도 메쉬 활성 구간을 가질 수 있다(검은 뱀 스킬02 는 좌우
        // 머리를 2.33~5.00초에만 켠다). 시각은 그 동작의 타임라인 시작 기준이다.
        const aex = clipExtrasOf(clip.name);
        const maDur = aex.timelineDuration || 0;
        const list = Array.isArray(aex.meshActivation)
          ? aex.meshActivation.filter(o => o && o.name
              && !(o.start <= 1e-6 && o.end >= maDur - 1e-6))
          : [];
        if (list.length) {
          clipMeshAct = { list: startMeshAct(list),
            start: (typeof aex.timelineStart === 'number') ? aex.timelineStart : 0 };
          updateMeshAct(clipMeshAct.start);
        }
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
      applyClipCamDist(clip.name);
      applyCineShift(clip);
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
      if (autoPhaseChain && autoPhaseAvailable() && isPhaseSwitchClip(state.currentClip, bossKey)) {
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
        byPhase ? '#soloraid-phase-toggle .soloraid-phase-btn'
                : '#soloraid-model-toggle .soloraid-model-btn'));
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

    const resetBtn = document.getElementById('soloraid-spine-reset');
    if (resetBtn) {
      resetBtn.onclick = () => {
        if (container.__soloRaidModel3D !== state) return;
        camera.position.copy(homeCamPos);
        controls.target.copy(homeTarget);
        // 팬으로 옮겨둔 추적 기준도 홈으로 되돌린다
        initialTarget.copy(homeTarget);
        if (focusMesh) rigCenter(focusMesh, followBase, focusBone);
        controls.update();
      };
    }

    const pauseBtn = document.getElementById('soloraid-spine-pause');
    if (pauseBtn) {
      pauseBtn.onclick = () => {
        if (container.__soloRaidModel3D !== state) return;
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
      document.querySelectorAll('#soloraid-anim-toggle .soloraid-anim-btn').forEach(b => {
        b.classList.toggle('active',
          activeMainKey !== null && b.dataset.key === activeMainKey && seqMatch(b));
      });
    }

    // 지금 실제로 도는 클립. 묶음을 재생하면 소속 클립에 차례로 불이 들어온다.
    function markPlayingClip(name) {
      document.querySelectorAll('#soloraid-anim-toggle .soloraid-anim-btn').forEach(b => {
        const on = b.dataset.key === name && seqMatch(b);
        b.classList.toggle('playing', on);
        if (!on) b.style.removeProperty('--anim-progress');
      });
    }

    const animEl = document.getElementById('soloraid-anim-toggle');
    if (animEl) {
      const seqs = findSequences(gltf.animations || [], bossKey);
      buildSyntheticSequences(seqs);
      applyTimelineLoops(seqs);
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
      // 코드 뒤에 공백이 끼는 클립이 있다("xbg004 _skill_start_03", "xbg004 _death_camera").
      // 밑줄만 보고 떼면 그런 이름은 앞머리가 그대로 남아서 목록에 코드가 노출된다.
      const stripCodeRe = multiPhase
        ? /^[a-z]{2,4}\d{3}\s*_/i
        : /^[a-z]{2,4}\d{3}\s*_(\d?\d?phase_)?/i;
      const label = name => String(name).replace(stripCodeRe, '');
      // 손으로 정해 둔 이름이 있으면 그쪽이 이긴다
      const labelOf = (raw, fallback) => {
        const fix = CLIP_LABEL_FIX.find(
          o => o.boss.test(bossKey || '') && o.re.test(raw || ''));
        if (!fix) return fallback;
        return fix.strip ? String(fallback).replace(fix.strip, '') : fix.label;
      };

      if (clips.length > 1) {
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
        // 머리가 부서진 채 멈춘 자세(니힐리스타 Destruction_0N_idle)는 이름만 idle 이다 — 대기로 보면
        // 머리 파괴 묶음 밖에 따로 한 줄씩 더 나온다.
        const isIdle = c => /(^|_)idle(_\d+)?$/i.test(stripPhaseTail(c.name))
          && !/skill|(^|_)cc(_|$)|_Destruction_\d+_idle$/i.test(c.name || '');
        // dead / death 표기가 보스마다 다르다
        const isSolo = c => /(^|_)(dead|death|appearance|appeanrance|phase_?change)/i.test(c.name || '');

        // 연출 길이. 카메라 클립이 모델보다 길게 놓인 연출은 카메라가 시계라서
        // (애니힐리오 1페 등장은 카메라 8.00초 / 모델 5.00초) 그쪽 길이를 적는다.
        // 재생바도 같은 값을 쓴다 - 버튼만 5초라고 적히면 헷갈린다.
        const playDur = c => {
          const pair = camPairs.byModel.get(c.name);
          if (!pair || !pair.node || !pair.node.userData) return c.duration;
          if (isCameraClockClip(bossKey, c.name)) return (pair.clip && pair.clip.duration) || c.duration;
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
          `<button type="button" class="sr3d-btn soloraid-anim-btn${cls ? ' ' + cls : ''}"`
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
        // 울트라 사망은 outro_take1 이다(다른 보스에는 outro 가 붙은 클립이 없다)
        const isDeadName = n => /(^|_)(dead|death|outro)/i.test(n);
        const isAirName = n => /(^|_)air/i.test(n);
        const groupOf = (name) => {
          const n = String(name);
          if (isBaseDespiteName(n)) return '기본';
          if (isPhaseSwitchClip(n, bossKey)) return '페이즈 전환';
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

        // 이름 끝의 번호. 같은 갈래 안에서 번호 순으로 세우는 데 쓴다 —
        // 묶음이 없는 낱개 클립(거대 질량체 skill_fire_09 는 start/loop 이 없다)이
        // 파일 순서대로 맨 뒤에 붙어서 10 번 뒤에 서 있었다.
        const seqNo = (name) => {
          const fix = CLIP_SORT_FIX.find(
            o => o.boss.test(bossKey || '') && o.re.test(name || ''));
          if (fix) return fix.no;
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
            // 단계가 전부 목록에서 빼는 동작이면 묶음도 뺀다(크리스탈 체임버 - 시즌마다 게임이
            // 안 쓰는 스킬 세트를 HIDDEN_CLIPS 로 적는다)
            if (sq.steps.every(st => isHiddenClip(bossKey, st.clip.name))) return;
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
            if (inSeq.has(c.name) || isIdle(c)) return;
            if (!inCurrentPhase(c.name)) return;
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
                + `<div class="toggle-switch-wrap anim-auto-phase soloraid-auto-phase`
                + `${autoPhaseChain ? ' active' : ''}" role="switch"`
                + ` aria-checked="${autoPhaseChain}" title="전환 연출이 끝나면 다음 페이즈로 이어서 재생">`
                + `<span class="toggle-label">자동 전환</span>`
                + `<div class="toggle-switch"></div></div></div>`;
            }
            parts.push(`<div class="anim-group">${head}${html}</div>`);
          });

          animEl.innerHTML = parts.join('');

          const autoBtn = animEl.querySelector('.soloraid-auto-phase');
          if (autoBtn) {
            autoBtn.addEventListener('click', () => {
              if (container.__soloRaidModel3D !== state) return;
              autoPhaseChain = !autoPhaseChain;
              autoBtn.classList.toggle('active', autoPhaseChain);
              autoBtn.setAttribute('aria-checked', String(autoPhaseChain));
            });
          }

          document.querySelectorAll('#soloraid-anim-toggle .soloraid-anim-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              if (container.__soloRaidModel3D !== state) return;
              const key = btn.dataset.key;
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
          const hit = c => (nextRe ? nextRe.test(c.name || '') : isPhaseSwitchClip(c.name, bossKey))
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
    if (window.syncSoloRaidCtlGroups) window.syncSoloRaidCtlGroups();

    if (onLoaded) onLoaded({ meshCount: meshes.length });

    // ── 재생바 ────────────────────────────────────────────────────
    // 애니메이션이 하나도 없는 모델이면 재생바를 감춘다.
    // (예전에는 없는 id(#soloraid-playbar)를 찾고 있어서 이 줄이 한 번도 안 돌았다.)
    const barEl = document.getElementById('sr3d-bar');
    const lineEl = document.getElementById('soloraid-timeline');
    const fillEl = document.getElementById('soloraid-timeline-fill');
    const codeEl = document.getElementById('soloraid-timecode');

    if (barEl) barEl.classList.toggle('hidden', !(gltf.animations && gltf.animations.length));

    function seekToRatio(ratio) {
      if (!currentAction) return;
      if (camIsClock()) {
        const cd = cinematic.action.getClip().duration || 0;
        const ct = Math.max(0, Math.min(cd, cd * ratio));
        cinematic.action.time = ct;
        cinematic.action.paused = false;
        cinematic.action.enabled = true;
        if (mixer) mixer.update(0);
        syncBar();
        return;
      }
      const dur = currentAction.getClip().duration || 0;
      const t = Math.max(0, Math.min(dur, dur * ratio));
      currentAction.time = t;
      currentAction.paused = false;
      currentAction.enabled = true;
      syncSimulTime();
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
        const st = container.__soloRaidModel3D;
        if (st && st.seekToRatio) st.seekToRatio(ratioAt(ev));
      });
      lineEl.addEventListener('pointermove', ev => {
        if (!scrubbing) return;
        const st = container.__soloRaidModel3D;
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
      document.querySelectorAll('#soloraid-glow-toggle .sr3d-btn')
        .forEach(b => b.classList.toggle('active', b.dataset.glow === glowMode));
    }

    const glowEl = document.getElementById('soloraid-glow-toggle');
    if (glowEl) {
      if (!glowMats.length) {
        glowEl.innerHTML = '';
      } else {
        glowEl.innerHTML = glowPresetsFor(bossCode).map(p =>
          `<button type="button" class="sr3d-btn sr3d-glow-btn${p.key === 'off' ? ' active' : ''}" data-glow="${p.key}">`
          + (p.css ? `<i style="background:${p.css}"></i>` : '') + p.label + '</button>'
        ).join('');
        glowEl.querySelectorAll('.sr3d-btn').forEach(b => {
          b.addEventListener('click', () => {
            if (container.__soloRaidModel3D !== state) return;
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
    bindToggle('sr3d-wire', () => optWire, v => { optWire = v; });
    bindToggle('sr3d-alpha', () => optAlpha, v => { optAlpha = v; });
    bindToggle('sr3d-single', () => optSingle, v => { optSingle = v; });

    const gridBtn = document.getElementById('sr3d-grid');
    if (gridBtn) {
      gridBtn.classList.toggle('active', gridHelper.visible);
      gridBtn.onclick = () => {
        if (container.__soloRaidModel3D !== state) return;
        gridHelper.visible = !gridHelper.visible;
        gridBtn.classList.toggle('active', gridHelper.visible);
      };
    }

    const followBtn = document.getElementById('sr3d-follow');
    if (followBtn) {
      followBtn.classList.toggle('active', followEnabled);
      followBtn.onclick = () => {
        if (container.__soloRaidModel3D !== state) return;
        followEnabled = !followEnabled;
        followBtn.classList.toggle('active', followEnabled);
        syncPanLock();
      };
    }
    syncPanLock();

    const zeroBtn = document.getElementById('sr3d-zero');
    if (zeroBtn) {
      zeroBtn.onclick = () => {
        if (container.__soloRaidModel3D !== state || !SL.yaw) return;
        const t = getBossTransform(bossCode);
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
      syncSimulTime();
      state.paused = true;
      const pb = document.getElementById('soloraid-spine-pause');
      if (pb) pb.innerHTML = '<i class="fas fa-play"></i>';
      if (mixer) mixer.update(0);
      syncBar();
    }
    const backBtn = document.getElementById('soloraid-step-back');
    if (backBtn) backBtn.onclick = () => { if (container.__soloRaidModel3D === state) stepFrames(-1 / 30); };
    const fwdBtn = document.getElementById('soloraid-step-fwd');
    if (fwdBtn) fwdBtn.onclick = () => { if (container.__soloRaidModel3D === state) stepFrames(1 / 30); };

    const restartBtn = document.getElementById('soloraid-spine-restart');
    if (restartBtn) {
      restartBtn.onclick = () => {
        if (container.__soloRaidModel3D !== state) return;
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
      const pb = document.querySelector('#soloraid-anim-toggle .soloraid-anim-btn.playing');
      if (pb) pb.style.setProperty('--anim-progress', pct.toFixed(1) + '%');
    }

    // 땅속 파편(UNDERGROUND_HIDE). 접어 둔 크기를 기억했다가 다음 프레임에 되돌린다 — 그 뼈에 크기 트랙이
    // 없는 동작이면 믹서가 안 덮어써서 접힌 채 남는다.
    const ugRules = UNDERGROUND_HIDE.filter(o => o.boss.test(bossKey || ''));
    const ugBones = [];
    if (ugRules.length) {
      gltf.scene.traverse(o => {
        if (o.isBone && ugRules.some(r => r.re.test(o.name || ''))) ugBones.push({ bone: o, saved: null });
      });
    }
    const ugV = new THREE.Vector3();
    function restoreUnderground() {
      ugBones.forEach(u => { if (u.saved) { u.bone.scale.copy(u.saved); u.saved = null; } });
    }
    function hideUnderground() {
      if (!ugBones.length) return;
      ugBones.forEach(u => {
        u.bone.updateWorldMatrix(true, false);
        ugV.setFromMatrixPosition(u.bone.matrixWorld);
        if (ugV.y < -0.05) {
          u.saved = u.bone.scale.clone();
          u.bone.scale.setScalar(1e-4);
        }
      });
    }

    // 한 프레임 진행. rAF 와 분리해 둬서 밖에서도 결정적으로 돌려볼 수 있다.
    state.step = (dt) => {
      // 예약된 클립 교체를 먼저 처리한다(옛 믹서가 이미 멈춘 뒤라 안전하다)
      runPendingNext();
      restoreUnderground();
      if (mixer && !state.paused) mixer.update(dt);
      hideUnderground();
      // 카메라가 없는 동작의 메쉬 활성 구간(검은 뱀 스킬02 의 좌우 머리)
      if (!cinematic && clipMeshAct && currentAction) {
        updateMeshAct(clipMeshAct.start + currentAction.time);
      }
      if (!applyCinematicCamera()) {
        updateFollow();
        clampPan();
        controls.update();
      }
      if (composer) composer.render();
      else renderer.render(scene, camera);
      syncBar();
    };

    function animate() {
      if (container.__soloRaidModel3D !== state) return; // dispose됨
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
