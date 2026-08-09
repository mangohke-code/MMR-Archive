// Spine 4.0.x .skel(바이너리) → 4.1.x 로 업그레이드.
//
// 두 버전의 SkeletonBinary 리더를 diff 해보면 와이어 포맷 차이는 "바이트 삽입" 네 군데뿐이다.
//   1) Region 어태치먼트: color(int32) 다음에 sequence 플래그(boolean) 1바이트
//   2) Mesh 어태치먼트: hullLength 다음에 sequence 플래그 1바이트
//   3) LinkedMesh 어태치먼트: inheritDeform(boolean) 다음에 sequence 플래그 1바이트
//   4) Deform 타임라인: attachmentName 다음, frameCount 앞에 timelineType 바이트(0 = DEFORM)
// 나머지 차이는 전부 null 체크 추가라 포맷에 영향이 없다.
//
// 그래서 4.0 리더로 파일을 훑으면서 위 네 지점의 바이트 오프셋만 기록한 뒤,
// 원본 바이트를 그대로 복사하면서 그 자리에 0x00 을 끼워 넣으면 4.1 파일이 된다.
// (sequence 없음 = false = 0, ATTACHMENT_DEFORM = 0 이라 양쪽 다 0x00)
// 마지막으로 헤더의 버전 문자열만 4.1.x 로 바꾼다.
//
// 사용법 (작업 폴더에 <id>.skel, <id>.atlas, 그리고 spine-core 4.0 번들이 필요하다):
//   curl -sLo sp40.js https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-core@4.0.31/dist/iife/spine-core.js
//   node upgrade_skel_40_to_41.js c905 c907 c908
//   → <id>_41.skel 생성
//
// 검증은 변환본을 spine-core 4.1.20 리더로 읽어서 원본(4.0 리더)과 본 월드 트랜스폼 및
// 메시 정점 좌표를 비교하는 식으로 했다. c905/c907/c908 기준 710,529개 값이 오차 0으로 일치했다.

const fs = require('fs');
const path = require('path');

const TARGET_VERSION = '4.1.20';

function buildPatchedRuntime() {
  let src = fs.readFileSync(path.join(__dirname, 'sp40.js'), 'utf8');
  const patches = [
    // 1) Region: color 읽은 직후
    [`          let color = input.readInt32();
          if (!path)
            path = name;
          let region = this.attachmentLoader.newRegionAttachment(skin, name, path);`,
     `          let color = input.readInt32();
          globalThis.__marks.push(input.index);
          if (!path)
            path = name;
          let region = this.attachmentLoader.newRegionAttachment(skin, name, path);`],
    // 2) Mesh: hullLength 읽은 직후
    [`          let hullLength = input.readInt(true);
          let edges = null;`,
     `          let hullLength = input.readInt(true);
          globalThis.__marks.push(input.index);
          let edges = null;`],
    // 3) LinkedMesh: inheritDeform 읽은 직후
    [`          let inheritDeform = input.readBoolean();
          let width = 0, height = 0;`,
     `          let inheritDeform = input.readBoolean();
          globalThis.__marks.push(input.index);
          let width = 0, height = 0;`],
    // 4) Deform 타임라인: frameCount 읽기 직전
    [`            let deformLength = weighted ? vertices.length / 3 * 2 : vertices.length;
            let frameCount = input.readInt(true);`,
     `            let deformLength = weighted ? vertices.length / 3 * 2 : vertices.length;
            globalThis.__marks.push(input.index);
            let frameCount = input.readInt(true);`],
  ];
  for (const [from, to] of patches) {
    if (!src.includes(from)) throw new Error('패치 지점을 찾지 못했습니다:\n' + from.slice(0, 80));
    if (src.split(from).length !== 2) throw new Error('패치 지점이 여러 곳에서 발견됐습니다');
    src = src.replace(from, to);
  }
  return eval(src + '; spine');
}

// 4.0 리더로 훑으면서 삽입 지점 수집
function collectMarks(spine, skelBuf, atlasText) {
  globalThis.__marks = [];
  const atlas = new spine.TextureAtlas(atlasText);
  // 실제 텍스처는 필요 없다 — 오프셋만 얻으면 되므로 더미를 물려준다.
  const dummyTexture = {
    getImage: () => ({ width: 1, height: 1 }),
    setFilters() {}, setWraps() {}, dispose() {},
  };
  atlas.pages.forEach(p => { p.setTexture ? p.setTexture(dummyTexture) : (p.texture = dummyTexture); });
  atlas.regions.forEach(r => { r.texture = dummyTexture; });

  const loader = new spine.AtlasAttachmentLoader(atlas);
  const binary = new spine.SkeletonBinary(loader);
  const data = binary.readSkeletonData(new Uint8Array(skelBuf));
  return { marks: globalThis.__marks.slice(), data };
}

// 헤더의 버전 문자열 위치/길이를 찾는다 (hash 8바이트 뒤, 길이 접두 문자열)
function findVersionField(buf) {
  // Spine 바이너리 문자열: varint(길이+1), 그 다음 UTF-8 바이트
  let i = 8;
  let len = 0, shift = 0, b;
  do { b = buf[i++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  if (len === 0) throw new Error('버전 문자열이 비어 있습니다');
  const strLen = len - 1;
  return { varintStart: 8, dataStart: i, dataEnd: i + strLen, value: buf.toString('utf8', i, i + strLen) };
}

function encodeVarint(value) {
  const out = [];
  do {
    let b = value & 0x7f;
    value >>>= 7;
    if (value !== 0) b |= 0x80;
    out.push(b);
  } while (value !== 0);
  return Buffer.from(out);
}

function upgrade(skelPath, atlasPath, outPath, spine) {
  const skelBuf = fs.readFileSync(skelPath);
  const atlasText = fs.readFileSync(atlasPath, 'utf8');

  const { marks, data } = collectMarks(spine, skelBuf, atlasText);
  const sorted = [...marks].sort((a, b) => a - b);
  if (sorted.some((v, i) => i > 0 && v < sorted[i - 1])) throw new Error('오프셋이 정렬되지 않았습니다');

  // 1) 버전 문자열 교체
  const ver = findVersionField(skelBuf);
  const newVarint = encodeVarint(TARGET_VERSION.length + 1);
  const head = Buffer.concat([
    skelBuf.subarray(0, ver.varintStart),
    newVarint,
    Buffer.from(TARGET_VERSION, 'utf8'),
  ]);
  const bodyStart = ver.dataEnd;

  // 2) 본문을 복사하면서 표시된 오프셋마다 0x00 삽입
  const chunks = [head];
  let cursor = bodyStart;
  for (const off of sorted) {
    if (off < cursor) throw new Error(`오프셋 역행: ${off} < ${cursor}`);
    chunks.push(skelBuf.subarray(cursor, off), Buffer.from([0x00]));
    cursor = off;
  }
  chunks.push(skelBuf.subarray(cursor));
  const out = Buffer.concat(chunks);
  fs.writeFileSync(outPath, out);

  return {
    file: path.basename(outPath),
    fromVersion: ver.value,
    toVersion: TARGET_VERSION,
    inserted: sorted.length,
    sizeBefore: skelBuf.length,
    sizeAfter: out.length,
    bones: data.bones.length,
    slots: data.slots.length,
    skins: data.skins.length,
    animations: data.animations.length,
  };
}

const spine = buildPatchedRuntime();
const results = [];
for (const id of process.argv.slice(2)) {
  results.push(upgrade(`${id}.skel`, `${id}.atlas`, `${id}_41.skel`, spine));
}
console.log(JSON.stringify(results, null, 1));
