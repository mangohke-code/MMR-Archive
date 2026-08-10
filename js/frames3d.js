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

function getBossTransform(bossCode) {
  const raw = BOSS_TRANSFORM_OVERRIDES[bossCode] || {};
  return {
    rotation: raw.rotation || DEFAULT_ROTATION,
    position: raw.position || [0, 0, 0],
    scale: raw.scale || 1,
  };
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

    const bossTransform = getBossTransform(bossCode);
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
          m.alphaTest = 0.5;
        }
      });

      const xform = MESH_TRANSFORM_OVERRIDES[obj.name];
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

    // 페이즈별로 파츠가 통째로 나뉜 보스들 (예: 1phase_body / 2phase_body, phase001_*/phase002_*)
    // 이 있다. 그런데 보스마다 사정이 달라서 — 어떤 보스는 페이즈 파츠가 서로 배타적(교체)이지만,
    // 어떤 보스(예: 온리 원)는 1페이즈 파츠를 2페이즈에서도 그대로 재사용(누적)한다. 이름 패턴만
    // 으로는 구분이 안 되므로 PHASE_MODE_OVERRIDES에 보스별로 등록해서 정확히 지정한다.
    const meshPhase = name => {
      const m = (name || '').match(/(\d+)phase|phase0*(\d+)/i);
      if (!m) return null;
      return String(parseInt(m[1] || m[2], 10));
    };
    const phaseConfig = getPhaseConfig(bossCode);
    const phaseGroups = {};
    meshes.forEach(m => {
      const p = meshPhase(m.name);
      if (p) (phaseGroups[p] = phaseGroups[p] || []).push(m);
    });
    const phaseKeys = Object.keys(phaseGroups).sort((a, b) => Number(a) - Number(b));
    const minPhase = phaseKeys.length > 0 ? phaseKeys[0] : null;
    // 모든 보스는 항상 1페이즈(가장 낮은 페이즈)로 시작 - 다른 페이즈는 직접 선택해야 보인다.
    let currentPhase = minPhase;
    const isPhaseVisible = (p, current) => {
      if (p === null) return true;
      if (phaseConfig.mode === 'exclusive') return p === current;
      if (phaseConfig.mode === 'phase1-all') return current === minPhase ? true : p === current;
      return Number(p) <= Number(current); // cumulative
    };

    const enabledMeshes = new Set(
      meshes
        .filter(m => !isSkillOnlyEffect(m.name) && isPhaseVisible(meshPhase(m.name), currentPhase))
        .map(m => m.name)
    );

    function applyVisibility() {
      meshes.forEach(m => { m.visible = enabledMeshes.has(m.name); });
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
              const p = meshPhase(m.name);
              if (p === null) return;
              if (isPhaseVisible(p, currentPhase)) enabledMeshes.add(m.name);
              else enabledMeshes.delete(m.name);
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

    initialCamPos = camera.position.clone();
    initialTarget = controls.target.clone();

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

    function updateAnimationForPhase() {
      const clip = findIdleClipForPhase(currentPhase);
      if (!clip) return;
      // mixer.stopAllAction() + 캐시된 action을 reset/play로 재사용하면 3D 렌더링에
      // 눈에 보이는 변화는 없이 내부 바인딩 상태만 꼬이는 경우가 있어(같은 본을 다른
      // 클립 두 개가 번갈아 참조할 때 재생 자체는 "isRunning: true"로 보이는데도 실제
      // 포즈는 갱신이 안 되는 현상 확인됨) — 믹서를 아예 새로 만들어서 확실하게 교체한다.
      mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(clip).play();
    }

    if (gltf.animations && gltf.animations.length > 0) {
      mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(findIdleClipForPhase(currentPhase)).play();
    }

    const resetBtn = document.getElementById('frames-spine-reset');
    if (resetBtn) {
      resetBtn.onclick = () => {
        if (container.__framesModel3D !== state) return;
        camera.position.copy(initialCamPos);
        controls.target.copy(initialTarget);
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

    if (onLoaded) onLoaded({ meshCount: meshes.length });

    function animate() {
      if (container.__framesModel3D !== state) return; // dispose됨
      state.rafId = requestAnimationFrame(animate);
      const dt = clock.getDelta();
      if (mixer && !state.paused) mixer.update(dt);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();
  }, undefined, (err) => {
    console.error('[역대 테두리 3D] 모델 로드 실패:', err);
    if (onError) onError(err);
  });
};
