/* 이미지 전용 캐시.
 *
 * 깃허브 페이지는 모든 파일에 Cache-Control: max-age=600 을 붙이고 그 값을 바꿀 수
 * 없다. 그래서 10분이 지나면 이미지 190여 개가 전부 재검증 요청을 한 번씩 내고,
 * 배포할 때마다 ETag 앞부분(배포 시각)이 바뀌어서 내용이 그대로인 이미지까지
 * 통째로 다시 받는다. 여기서 이미지만 따로 담아 두고 네트워크를 아예 안 거친다.
 *
 * 담는 것   : 같은 출처(github.io / localhost)의 이미지 파일만.
 * 안 담는 것: HTML·CSS·JS·DB 응답·외부 CDN 이미지·3D 모델.
 *             그쪽까지 담으면 배포해도 화면이 안 바뀌는 문제가 생긴다.
 *
 * 파일 이름은 그대로 두고 그림만 바꾼 경우에는 아래 CACHE 의 숫자를 올려야 한다.
 * 올리면 예전 캐시를 통째로 버리고 처음부터 다시 담는다.
 */
const CACHE = 'mmr-img-v1';
const IMG_RE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

self.addEventListener('install', (e) => {
  // 새 워커를 기다리지 않고 바로 올린다.
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 버전이 올라갔으면 예전 이미지 캐시를 버린다.
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('mmr-img-') && n !== CACHE)
           .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 다른 출처는 건드리지 않는다. 외부 CDN 이미지는 응답 내용을 볼 수 없는
  // opaque 라서 담아 봐야 용량만 크게 먹고 검증도 안 된다.
  if (url.origin !== self.location.origin) return;
  if (!IMG_RE.test(url.pathname)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;                    // 담아 둔 게 있으면 네트워크를 안 탄다
    let res;
    try {
      res = await fetch(req);
    } catch (err) {
      // 오프라인이고 담아 둔 것도 없으면 평소처럼 실패한다.
      return Response.error();
    }
    // 담는 데 실패해도(용량 초과 등) 그림은 그대로 내보낸다.
    // 여기서 예외가 새면 이미지가 통째로 안 보인다.
    // 206(부분 응답)은 캐시에 넣을 수 없다.
    if (res && res.ok && res.status === 200) {
      try { await cache.put(req, res.clone()); } catch (err) { /* 무시 */ }
    }
    return res;
  })());
});
