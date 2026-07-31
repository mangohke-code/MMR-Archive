// 역대 테두리 탭: FBX -> glTF/Draco 변환 결과물(.glb)을 표시하는 3D 뷰어.
// Spine(L2D) 런타임과는 완전히 별개 스택(Three.js)이라 frames.js(classic script)와
// 분리된 모듈로 두고, window에 진입점만 노출해서 frames.js에서 호출한다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

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

  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
  dirLight.position.set(1, 2, 1);
  scene.add(dirLight);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.6);
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

    scene.add(gltf.scene);

    // FBX 원본이 항상 정면 기준 오른쪽으로 돌아간 상태로 나온다 —
    // FBX2glTF 변환 시 좌표축 관례(Maya 등)와 우리가 카메라를 세팅하는 기준(+Z 방향)이
    // 어긋나는 것으로 보인다. 모든 보스에 공통이라 고정 보정값을 적용한다.
    gltf.scene.rotation.y = THREE.MathUtils.degToRad(-25);

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
        if (!/^fx_/i.test(m.name || '')) {
          m.transparent = false;
          m.depthWrite = true;
          m.alphaTest = 0.5;
        }
      });
    });

    // 스킬/등장 연출 전용 이펙트(fx_ 접두사) 메시는 기본적으로 꺼둔다 — idle 애니메이션만
    // 재생하는 정적 뷰어에서는 항상 화면에 떠 있으면 오히려 어색해 보인다.
    // 단, fx_fbx_monster_core(_outline)는 스킬 이펙트가 아니라 보스 몸체에 항상 붙어있는
    // 코어(약점) 표시라 거의 모든 보스에 공통으로 존재 — 이건 꺼두면 몸통 안쪽이 통째로
    // 비어 보이므로 예외로 기본 표시한다. 나머지는 토글로 직접 켤 수 있다.
    const isSkillOnlyEffect = name => /^fx_/i.test(name || '') && !/monster_core/i.test(name || '');

    // 페이즈별로 파츠가 통째로 나뉜 보스들 (예: 1phase_body / 2phase_body, phase001_*/phase002_*)
    // 이 있다. 그런데 보스마다 사정이 달라서 — 어떤 보스는 페이즈 파츠가 서로 배타적(교체)이지만,
    // 어떤 보스(예: 온리 원)는 1페이즈 파츠를 2페이즈에서도 그대로 재사용(누적)한다. 이걸 이름만
    // 보고 정확히 구분할 수 없어서, 기본값은 "누적"(선택한 페이즈 이하 전부 표시)으로 둔다 —
    // 파츠가 통째로 사라져 모델이 깨져 보이는 쪽보다, 배타적인 보스에서 파츠가 좀 겹쳐 보이는
    // 쪽이 덜 심각한 문제라서다. 프리셋이 안 맞는 보스는 파츠 토글에서 개별로 껐다 켰다 하면 된다.
    const meshPhase = name => {
      const m = (name || '').match(/(\d+)phase|phase0*(\d+)/i);
      if (!m) return null;
      return String(parseInt(m[1] || m[2], 10));
    };
    const phaseGroups = {};
    meshes.forEach(m => {
      const p = meshPhase(m.name);
      if (p) (phaseGroups[p] = phaseGroups[p] || []).push(m);
    });
    const phaseKeys = Object.keys(phaseGroups).sort((a, b) => Number(a) - Number(b));
    let currentPhase = phaseKeys.length > 0 ? phaseKeys[0] : null;

    const enabledMeshes = new Set(
      meshes
        .filter(m => {
          if (isSkillOnlyEffect(m.name)) return false;
          const p = meshPhase(m.name);
          if (p !== null && Number(p) > Number(currentPhase)) return false;
          return true;
        })
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
            // 프리셋 적용(누적): 선택한 페이즈 이하 태그의 파츠는 켜고, 그보다 뒤 페이즈
            // 파츠만 끈다 — 페이즈 태그가 없는 공용 파츠는 건드리지 않는다.
            meshes.forEach(m => {
              const p = meshPhase(m.name);
              if (p === null) return;
              if (Number(p) <= Number(currentPhase)) enabledMeshes.add(m.name);
              else enabledMeshes.delete(m.name);
            });
            applyVisibility();
            renderToggleUI();
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
    controls.update();

    initialCamPos = camera.position.clone();
    initialTarget = controls.target.clone();

    if (gltf.animations && gltf.animations.length > 0) {
      mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(gltf.animations[0]).play();
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
