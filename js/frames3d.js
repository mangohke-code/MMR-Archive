// 역대 테두리 탭: FBX -> glTF/Draco 변환 결과물(.glb)을 표시하는 3D 뷰어.
// Spine(L2D) 런타임과는 완전히 별개 스택(Three.js)이라 frames.js(classic script)와
// 분리된 모듈로 두고, window에 진입점만 노출해서 frames.js에서 호출한다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
  xbg003: { mode: 'phase1-all' }, // 온리 원 - 날개(2phase 태그)가 상시 노출 파츠라 1페이즈에서 같이 켠다
  mbg001: { mode: 'phase1-all' }, // 알트아이젠 - 1페이즈는 전체 파츠, 2페이즈는 phase002 파츠만
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

function detectBossCode(meshNames) {
  for (const name of meshNames) {
    const m = (name || '').match(/^([a-z]{2,4}\d{3})/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
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

function getBossTransform(bossCode, isCatalogExport) {
  // 신형 추출본은 루트 노드에 방향 회전이 이미 들어 있고(쿼터니언 [0,-1,0,0] = yaw 180도)
  // GLTFLoader 가 그걸 적용한다. 보스별 보정값은 구형 파이프라인이 어긋나게 뽑아준 걸
  // 손으로 맞춘 값이라, 신형에 얹으면 회전이 두 번 걸려 오히려 망가진다.
  // 같은 보스를 신형으로 다시 올리면 이 함수가 알아서 보정을 건너뛴다.
  // 좌우 180도가 이 보스들의 정면이다(테스트 뷰어에서 확인).
  if (isCatalogExport) return { rotation: [0, 180, 0], position: [0, 0, 0], scale: 1 };

  const raw = BOSS_TRANSFORM_OVERRIDES[bossCode] || {};
  return {
    rotation: raw.rotation || DEFAULT_ROTATION,
    position: raw.position || [0, 0, 0],
    scale: raw.scale || 1,
  };
}

// 사망 연출에서 떨어져 나가는 파편 본. 화면 잡기·카메라 추적 기준에서 뺀다.
const DEBRIS_BONE_RE = /twp/i;

// 몸통 중심축 본. 3ds Max Biped 표준 이름 + body/bust/neck 계열.
// 파츠가 떨어져 나가는 연출에서 파츠까지 평균 내면 본체와 파편 사이 빈 공간을 잡는다.
const CORE_BONE_RE = /(^|_)(bip\d*|pelvis|spine|neck|bust|head|body|root)/i;

// 카메라가 따라갈 본체 메쉬 — 파편을 뺀 본이 가장 많은 스킨드메쉬.
// 보스마다 이름이 달라서(body_skin / 1phase_skin) 이름으로 찍지 않는다.
function pickFocusMesh(meshes) {
  let best = null, bestN = -1;
  for (const m of meshes) {
    if (!m.isSkinnedMesh || !m.skeleton) continue;
    let n = 0;
    for (const b of m.skeleton.bones) if (!DEBRIS_BONE_RE.test(b.name || '')) n++;
    if (n > bestN) { bestN = n; best = m; }
  }
  return best;
}

// 본체 본의 평균 위치. 코어 본이 잡히면 그것만, 아니면 파편 뺀 전체.
function rigCenter(mesh, out) {
  if (!mesh || !mesh.skeleton) return null;
  const bones = mesh.skeleton.bones;
  const v = new THREE.Vector3();
  const gather = (useCore) => {
    let n = 0;
    out.set(0, 0, 0);
    for (const b of bones) {
      const name = b.name || '';
      if (DEBRIS_BONE_RE.test(name)) continue;
      if (useCore && !CORE_BONE_RE.test(name)) continue;
      b.getWorldPosition(v);
      out.add(v); n++;
    }
    return n;
  };
  let n = gather(true);
  if (n < 3) n = gather(false);
  return n ? out.divideScalar(n) : null;
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
const SEQ_RE = /^(.*?)_(start|loop|end|fire)(_\d+)?$/i;

function findSequences(clips) {
  const groups = new Map();
  clips.forEach((c, i) => {
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
    if (g.loop) steps.push({ clip: g.loop.clip, repeat: 2 });
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
  out.forEach(o => { o.label = o.key.replace(strip, ''); });
  return out;
}

// 클립 이름에 붙은 페이즈 번호. "xbg005_2phase_idle_01" -> "2"
function clipPhase(name) {
  const m = (name || '').match(/(?:^|_)(\d)phase_/i);
  return m ? m[1] : null;
}

// 페이즈 전환 클립. 에고비스타는 페이즈가 파일로 갈리지 않고 한 모델 안에서
// 깃털 본의 스케일로 갈린다 — phase_change 가 phase1_feather 를 1.0 -> 0.03 으로 줄이고
// phase2_feather 를 0.08 -> 1.0 으로 키운다. idle 클립 자체에는 그 스케일이 없어서,
// 포즈를 초기화한 상태에서 2페이즈 클립만 틀면 1페이즈 깃털이 그대로 남는다.
// 그래서 다른 페이즈로 넘어갈 때는 이 클립을 먼저 한 번 재생한다.
function findPhaseChangeClip(clips) {
  return clips.find(c => /phase_?change/i.test(c.name || '')) || null;
}

// idle / loop 만 반복하고 나머지는 한 번만 재생한 뒤 idle 로 돌아간다.
// 등장·사망 연출은 리그를 딴 곳에 놓고 시작해서, 반복시키면 끝나는 순간 순간이동한다.
function isOneShot(name) {
  return !/(^|_)(idle|loop)(_\d+)?$/i.test(name || '');
}

function disposeState(container) {
  const state = container.__framesModel3D;
  if (!state) return;
  if (state.rafId) cancelAnimationFrame(state.rafId);
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
  const animToggleEl = document.getElementById('frames-anim-toggle');
  if (animToggleEl) {
    animToggleEl.innerHTML = '';
    animToggleEl.classList.add('hidden');
  }
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
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 4.0);
  dirLight.position.set(1, 2, 1);
  scene.add(dirLight);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 1.6);
  dirLight2.position.set(-1, 0.5, -1);
  scene.add(dirLight2);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const state = { renderer, scene, camera, controls, rafId: null, paused: false };
  container.__framesModel3D = state;

  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);

  let mixer = null;
  const clock = new THREE.Clock();
  let initialCamPos = null;
  let initialTarget = null;

  loader.load(modelUrl, (gltf) => {
    if (container.__framesModel3D !== state) return; // 그 사이 다른 보스로 전환됨

    const meshNamesForBossCode = [];
    gltf.scene.traverse(o => { if (o.isMesh) meshNamesForBossCode.push(o.name); });
    const bossCode = detectBossCode(meshNamesForBossCode);

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
    pitchGroup.add(gltf.scene);
    yawGroup.add(pitchGroup);
    scene.add(yawGroup);

    const bossTransform = getBossTransform(bossCode, isCatalogExport);
    const [pitchDeg, yawDeg, rollDeg] = bossTransform.rotation;
    yawGroup.rotation.y = THREE.MathUtils.degToRad(yawDeg);
    pitchGroup.rotation.x = THREE.MathUtils.degToRad(pitchDeg);
    pitchGroup.rotation.z = THREE.MathUtils.degToRad(rollDeg);
    yawGroup.position.set(...bossTransform.position);
    yawGroup.scale.setScalar(bossTransform.scale);

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
        if (m.emissive) m.emissive.setRGB(0, 0, 0);
        if (!/^fx_/i.test(m.name || '')) {
          m.transparent = false;
          m.depthWrite = true;
          // 신형 추출본은 알파 컷아웃을 끈다.
          //
          // 이 파일들은 재질이 alphaMode=MASK / cutoff=0.5 로 나오는데, 미사일·총구·
          // 지네관절 같은 가늘고 긴 파츠는 텍스처 알파가 0.5 언저리라 그대로 두면
          // 중간중간 뚫려서 뚝뚝 끊긴 모습이 된다(테스트 뷰어에서 컷아웃을 끄면
          // 멀쩡하게 나오는 것으로 확인). 구형 변환본은 알파를 실제 구멍 모양으로
          // 쓰는 파츠가 있어서 기존 값을 유지한다.
          m.alphaTest = isCatalogExport ? 0 : 0.5;
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

    // 파츠 토글 목록에서는 보스 코드(예: bba001)를 빼고 보여준다 — fx_bba001_... 처럼
    // 접두사가 맨 앞이 아니라 중간에 낀 경우도 있어서, 위치 상관없이 전부 제거한다.
    // 실제 조회/저장에 쓰는 mesh.name은 그대로 두고, 화면 표시용 label만 별도로 붙인다.
    if (bossCode) {
      const stripCode = new RegExp(bossCode + '_?', 'ig');
      meshes.forEach(m => { m.label = (m.name || '').replace(stripCode, ''); });
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
    const focusMesh = pickFocusMesh(meshes);

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
    function poseFor(clipName) {
      const p = clipPhase(clipName);
      return (phaseEndPose && p && p !== '1') ? phaseEndPose : basePose;
    }

    const phaseConfig = getPhaseConfig(bossCode);
    const phaseGroups = {};
    // 신형 추출본은 파일 하나가 곧 페이즈 하나라 이름 기반 분류를 하지 않는다.
    if (!isCatalogExport) {
      meshes.forEach(m => {
        const p = meshPhase(m.name);
        if (p) (phaseGroups[p] = phaseGroups[p] || []).push(m);
      });
    }
    const phaseKeys = Object.keys(phaseGroups).sort((a, b) => Number(a) - Number(b));
    const minPhase = phaseKeys.length > 0 ? phaseKeys[0] : null;
    // 모든 보스는 항상 1페이즈(가장 낮은 페이즈)로 시작 - 다른 페이즈는 직접 선택해야 보인다.
    let currentPhase = minPhase;
    // 신형 추출본은 파일 하나가 곧 페이즈 하나라, 메쉬 이름의 phase 태그를 무시해야 한다.
    // 이걸 빼먹으면 2페이즈 파일의 "2phase_" 파츠들이 currentPhase(null) 와 비교돼
    // 전부 숨겨진다 — 실제로 11개 중 6개가 사라졌었다.
    const phaseOf = (name) => (isCatalogExport ? null : meshPhase(name));

    const isPhaseVisible = (p, current) => {
      if (p === null) return true;
      if (phaseConfig.mode === 'exclusive') return p === current;
      if (phaseConfig.mode === 'phase1-all') return current === minPhase ? true : p === current;
      return Number(p) <= Number(current); // cumulative
    };

    const enabledMeshes = new Set(
      meshes
        .filter(m => !isSkillOnlyEffect(m.name) && isPhaseVisible(phaseOf(m.name), currentPhase))
        .map(m => m.partKey)
    );

    function applyVisibility() {
      meshes.forEach(m => { m.visible = enabledMeshes.has(m.partKey); });
    }

    function renderToggleUI() {
      if (window.renderPartsToggle && meshes.length > 0) {
        window.renderPartsToggle('frames-parts-toggle', meshes, enabledMeshes, applyVisibility);
      }
    }

    applyVisibility();
    renderToggleUI();

    const phaseToggleEl = document.getElementById('frames-phase-toggle');
    if (phaseToggleEl) {
      if (phaseKeys.length > 1) {
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

    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() || 1;

    camera.position.set(center.x + radius * 0.8, center.y + radius * 0.5, center.z + radius * 0.8);
    controls.target.copy(center);

    // 보스마다 크기가 제각각이라 줌 한계도 모델 크기(radius) 기준 상대값으로 준다 —
    // 너무 가까이 가면 파츠를 뚫고 들어가 안 보이고, 너무 멀어지면 화면에서 안 보일 만큼
    // 작아지는 걸 막는다.
    controls.minDistance = radius * 0.05;
    controls.maxDistance = radius * 3;

    controls.update();

    // 스킨드메쉬의 지오메트리 바운딩박스는 바인드 포즈 기준이라, 재생 위치가 바인드와
    // 멀리 떨어진 모델(신형 추출본이 그렇다)에서는 카메라가 빈 곳을 보게 된다.
    // 기존 보스는 둘이 일치해서 이 보정이 아예 걸리지 않는다 — 어긋난 경우에만 고친다.
    const probe = new THREE.Vector3();
    if (focusMesh && rigCenter(focusMesh, probe) && !box.containsPoint(probe)) {
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

    initialCamPos = camera.position.clone();
    initialTarget = controls.target.clone();

    // 카메라 추적 — 등장·사망 연출은 리그를 통째로 옮긴다. 게임에서도 카메라가 같이
    // 움직여서 본체를 잡기 때문에 성립하는 연출이다.
    // 중심의 "절대 위치" 가 아니라 "처음 대비 변위" 를 따라가므로, 제자리에서만 움직이는
    // 기존 보스는 변위가 0 이라 아무 영향이 없다.
    const followBase = new THREE.Vector3();
    const followCur = new THREE.Vector3();
    const followDelta = new THREE.Vector3();
    const followWant = new THREE.Vector3();
    let followReady = false;
    if (focusMesh && rigCenter(focusMesh, followBase)) followReady = true;

    // 우클릭 팬이 안 먹히던 원인 — 추적이 매 프레임 시점을 원래 자리로 끌어당겨서
    // 사용자가 옮긴 만큼을 즉시 되돌리고 있었다. 조작 중에는 멈추고, 손을 떼면
    // 그 자리를 새 기준으로 잡는다.
    let userDragging = false;
    controls.addEventListener('start', () => { userDragging = true; });
    controls.addEventListener('end', () => {
      userDragging = false;
      initialTarget.copy(controls.target);
      if (focusMesh) rigCenter(focusMesh, followBase);
    });

    function updateFollow(dt) {
      if (userDragging || !followReady || !focusMesh) return;
      if (!rigCenter(focusMesh, followCur)) return;
      // 목표 = 처음 타깃 + (현재 중심 - 처음 중심)
      followWant.copy(initialTarget).add(followCur).sub(followBase);
      followDelta.copy(followWant).sub(controls.target);
      if (followDelta.lengthSq() < 1e-10) return;
      followDelta.multiplyScalar(1 - Math.pow(1e-7, Math.min(dt, 0.1)));
      controls.target.add(followDelta);
      camera.position.add(followDelta);
    }

    // 페이즈마다 idle 포즈가 다른 보스(예: 알트아이젠 - 런처 파츠가 1페이즈 idle에서는
    // 접힌 자세, 2페이즈 idle에서는 펼쳐진 자세)가 있다 - 파츠 표시만 바꾸고 애니메이션은
    // 그대로 두면, 2페이즈 전용 파츠가 1페이즈 포즈로 남아서 동떨어져 보인다.
    // 클립 이름에서 현재 페이즈에 해당하는 idle을 찾아 재생하고, 없으면(대부분의 보스는
    // idle 클립이 하나만 남아있음) 아무 idle이나 첫 클립으로 폴백한다.
    function findIdleClipForPhase(phase) {
      if (!gltf.animations || gltf.animations.length === 0) return null;
      if (phase !== null) {
        const match = gltf.animations.find(a => meshPhase(a.name) === phase && /idle|wait|stand/i.test(a.name || ''));
        if (match) return match;
      }
      return gltf.animations.find(a => /idle|wait|stand/i.test(a.name || '')) || gltf.animations[0];
    }

    let currentAction = null;

    // 클립 재생. 시퀀스(start->loop->end)를 위해 남은 단계를 큐로 들고 간다.
    // markActiveClip 은 아래 UI 블록에서 함수 선언으로 정의된다(호이스팅됨).
    let seqQueue = [];

    function playClipObject(clip, opts) {
      opts = opts || {};
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
      // 바깥에서 재생 상태를 들여다볼 수 있게 걸어둔다(검증·디버깅용).
      state.mixer = mixer;
      state.currentClip = clip.name;
      markActiveClip(opts.keepQueue ? null : clip.name);
    }

    function onClipFinished() {
      if (seqQueue.length) {
        const step = seqQueue.shift();
        playClipObject(step.clip, { repeat: step.repeat, keepQueue: true });
        return;
      }
      const idle = findIdleClipForPhase(currentPhase);
      // 포즈를 초기화하면 1페이즈 모습으로 돌아가므로 상태도 같이 맞춘다.
      shownPhase = null;
      if (idle) playSingle(idle);
    }

    function playSequence(seq) {
      const want = withPhaseChange(seq.steps[0].clip);
      if (want) {
        shownPhase = want;
        seqQueue = seq.steps.slice();
        playClipObject(phaseChangeClip, { repeat: 1, keepQueue: true });
      } else {
        shownPhase = clipPhase(seq.steps[0].clip.name) || shownPhase;
        seqQueue = seq.steps.slice(1);
        playClipObject(seq.steps[0].clip, { repeat: 1, keepQueue: true });
      }
      markActiveClip(seq.key);
    }

    // 지금 화면에 서 있는 페이즈.
    let shownPhase = null;

    // 목표 클립이 다음 페이즈면 전환 클립을 먼저 끼워 넣는다.
    function withPhaseChange(clip) {
      const want = clipPhase(clip.name);
      if (!phaseChangeClip || want === null) return null;
      const base = shownPhase === null ? '1' : shownPhase;
      if (want === base) return null;
      // 전환 클립은 1 -> 2 방향으로만 만들어져 있다. 되돌아갈 때 이걸 틀면 오히려
      // 다시 2페이즈 모습으로 끝나버리므로, 앞으로 갈 때만 끼운다.
      // 뒤로 갈 때는 poseFor() 가 알아서 초기 자세로 되돌려준다.
      if (Number(want) <= Number(base)) return null;
      return want;
    }

    function playSingle(clip) {
      seqQueue = [];
      const want = withPhaseChange(clip);
      if (want) {
        shownPhase = want;
        seqQueue = [{ clip, repeat: isOneShot(clip.name) ? 1 : 0 }];
        playClipObject(phaseChangeClip, { repeat: 1, keepQueue: true });
        markActiveClip(clip.name);
        return;
      }
      shownPhase = clipPhase(clip.name) || shownPhase;
      playClipObject(clip, { repeat: isOneShot(clip.name) ? 1 : 0 });
    }

    function updateAnimationForPhase() {
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
        camera.position.copy(initialCamPos);
        controls.target.copy(initialTarget);
        if (focusMesh) rigCenter(focusMesh, followBase);
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
    function markActiveClip(key) {
      const el = document.getElementById('frames-anim-toggle');
      if (!el) return;
      el.querySelectorAll('.frames-anim-btn').forEach(b => {
        b.classList.toggle('active', key !== null && b.dataset.key === key);
      });
    }

    const animEl = document.getElementById('frames-anim-toggle');
    if (animEl) {
      const seqs = findSequences(gltf.animations || []);
      const clips = gltf.animations || [];
      // 라벨에서 보스 코드를 뗀다. detectBossCode 는 메쉬 이름에서 뽑는데 클립과
      // 접두사가 다른 보스가 있어서(애니힐리오 1페이즈: 메쉬 xbga03_, 클립 xba003_)
      // 그 값으로 지우면 하나도 안 벗겨진다. 코드 자리를 패턴으로 잡는다.
      // 한 파일에 페이즈가 여럿이면 페이즈 태그는 남겨야 서로 구분이 된다.
      const multiPhase = new Set(clips.map(c => clipPhase(c.name)).filter(Boolean)).size > 1;
      const stripCodeRe = multiPhase
        ? /^[a-z]{2,4}\d{3}_/i
        : /^[a-z]{2,4}\d{3}_(\d?\d?phase_)?/i;
      const label = name => String(name).replace(stripCodeRe, '');

      // 구형 변환본은 클립이 idle(또는 페이즈별 idle) 뿐이고 그 전환은 페이즈 토글이
      // 이미 담당한다. 거기에 애니메이션 목록까지 띄우면 역할이 겹치고, 클립만 바꾸면
      // 파츠 표시와 어긋난다. 신형 추출본에서만 목록을 낸다.
      if (isCatalogExport && clips.length > 1) {
        animEl.classList.remove('hidden');

        // 주요 동작과 개별 클립을 구역으로 나눈다.
        //  - 주요: idle(맨 앞) + 연결 재생 묶음 + death/appearance 같은 단발 연출
        //  - 개별: 위 어디에도 안 들어간 나머지
        // 연결 묶음에 이미 들어간 start/loop/fire 는 개별 목록에서 뺀다 — 그대로 두면
        // 에고비스타처럼 클립이 49개인 보스에서 목록이 감당이 안 된다.
        const inSeq = new Set();
        seqs.forEach(sq => sq.steps.forEach(st => inSeq.add(st.clip.name)));

        const isIdle = c => /(^|_)idle(_\d+)?$/i.test(c.name || '');
        const isSolo = c => /(^|_)(death|appearance|appeanrance|phase_?change)/i.test(c.name || '');

        const mainBtns = []
          .concat(clips.filter(isIdle).map(c => ({ key: c.name, text: label(c.name), seq: false })))
          .concat(seqs.map(sq => ({ key: sq.key, text: label(sq.label), seq: true })))
          .concat(clips.filter(c => isSolo(c) && !inSeq.has(c.name)).map(c => ({ key: c.name, text: label(c.name), seq: false })));

        const mainKeys = new Set(mainBtns.map(b => b.key));
        const restBtns = clips
          .filter(c => !inSeq.has(c.name) && !mainKeys.has(c.name))
          .map(c => ({ key: c.name, text: label(c.name), seq: false }));

        const row = list => list.map(b =>
          `<button type="button" class="filter-chip frames-anim-btn${b.seq ? ' is-seq' : ''}" data-key="${b.key}">${b.text}</button>`
        ).join('');

        animEl.innerHTML =
          `<div class="anim-group"><span class="anim-group-label">주요 동작</span><div class="anim-row">${row(mainBtns)}</div></div>`
          + (restBtns.length
              ? `<div class="anim-group"><span class="anim-group-label">개별 클립</span><div class="anim-row">${row(restBtns)}</div></div>`
              : '');

        animEl.querySelectorAll('.frames-anim-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            if (container.__framesModel3D !== state) return;
            const key = btn.dataset.key;
            const sq = seqs.find(x => x.key === key);
            if (sq) playSequence(sq);
            else {
              const clip = clips.find(c => c.name === key);
              if (clip) playSingle(clip);
            }
          });
        });
        markActiveClip((findIdleClipForPhase(currentPhase) || {}).name || null);
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

    const restartBtn = document.getElementById('frames-spine-restart');
    if (restartBtn) {
      restartBtn.onclick = () => {
        if (container.__framesModel3D !== state) return;
        seekToRatio(0);
      };
    }

    function syncBar() {
      if (!fillEl || !currentAction) return;
      const dur = currentAction.getClip().duration || 0;
      const t = dur ? (currentAction.time % dur) : 0;
      fillEl.style.width = (dur ? (t / dur) * 100 : 0) + '%';
      if (codeEl) codeEl.textContent = t.toFixed(2) + ' / ' + dur.toFixed(2);
    }

    // 한 프레임 진행. rAF 와 분리해 둬서 밖에서도 결정적으로 돌려볼 수 있다.
    state.step = (dt) => {
      if (mixer && !state.paused) mixer.update(dt);
      updateFollow(dt);
      controls.update();
      renderer.render(scene, camera);
      syncBar();
    };

    function animate() {
      if (container.__framesModel3D !== state) return; // dispose됨
      state.rafId = requestAnimationFrame(animate);
      state.step(clock.getDelta());
    }
    animate();
  }, undefined, (err) => {
    console.error('[역대 테두리 3D] 모델 로드 실패:', err);
    if (onError) onError(err);
  });
};
