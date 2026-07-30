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

  const state = { renderer, scene, camera, controls, rafId: null };
  container.__framesModel3D = state;

  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);

  let mixer = null;
  const clock = new THREE.Clock();

  loader.load(modelUrl, (gltf) => {
    if (container.__framesModel3D !== state) return; // 그 사이 다른 보스로 전환됨

    scene.add(gltf.scene);

    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() || 1;

    camera.position.set(center.x + radius * 0.8, center.y + radius * 0.5, center.z + radius * 0.8);
    controls.target.copy(center);
    controls.update();

    if (gltf.animations && gltf.animations.length > 0) {
      mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(gltf.animations[0]).play();
    }

    if (onLoaded) onLoaded({ meshCount: (() => { let n = 0; gltf.scene.traverse(o => { if (o.isMesh) n++; }); return n; })() });

    function animate() {
      if (container.__framesModel3D !== state) return; // dispose됨
      state.rafId = requestAnimationFrame(animate);
      const dt = clock.getDelta();
      if (mixer) mixer.update(dt);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();
  }, undefined, (err) => {
    console.error('[역대 테두리 3D] 모델 로드 실패:', err);
    if (onError) onError(err);
  });
};
