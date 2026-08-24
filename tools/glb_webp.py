# glb 안에 박힌 PNG 텍스처를 WebP 로 바꿔 넣는다.
#
# gltf-transform 의 webp 명령이 이 환경에서 libvips 색공간 오류로 죽어서
# ("parameter space not set") 직접 처리한다. 텍스처 자체는 평범한 8bit RGBA PNG 라
# Pillow 로 바꾸는 데 문제가 없다.
#
# 사용법:  python tools/glb_webp.py 입력.glb 출력.glb [품질]

import io
import json
import struct
import sys

from PIL import Image

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
EXT = 'EXT_texture_webp'


def read_glb(path):
    d = open(path, 'rb').read()
    magic, ver, _ = struct.unpack_from('<III', d, 0)
    assert magic == 0x46546C67, 'glb 가 아니다'
    off, js, bin_ = 12, None, b''
    while off < len(d):
        clen, ctype = struct.unpack_from('<II', d, off)
        chunk = d[off + 8:off + 8 + clen]
        if ctype == JSON_CHUNK:
            js = json.loads(chunk.decode('utf-8'))
        elif ctype == BIN_CHUNK:
            bin_ = chunk
        off += 8 + clen
    return js, bin_


def write_glb(path, js, bin_):
    jb = json.dumps(js, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    bb = bin_ + b'\x00' * ((4 - len(bin_) % 4) % 4)
    total = 12 + 8 + len(jb) + (8 + len(bb) if bb else 0)
    out = io.BytesIO()
    out.write(struct.pack('<III', 0x46546C67, 2, total))
    out.write(struct.pack('<II', len(jb), JSON_CHUNK)); out.write(jb)
    if bb:
        out.write(struct.pack('<II', len(bb), BIN_CHUNK)); out.write(bb)
    open(path, 'wb').write(out.getvalue())


def main(src, dst, quality=90):
    js, bin_ = read_glb(src)
    views = js['bufferViews']

    # 1) 이미지를 WebP 로 바꿔 새 바이트를 준비한다
    new_bytes = {}   # bufferView 번호 -> 새 바이트
    changed = 0
    for im in js.get('images', []):
        bvi = im.get('bufferView')
        if bvi is None or im.get('mimeType') != 'image/png':
            continue
        bv = views[bvi]
        start = bv.get('byteOffset', 0)
        raw = bin_[start:start + bv['byteLength']]
        img = Image.open(io.BytesIO(raw))
        buf = io.BytesIO()
        img.save(buf, 'WEBP', quality=quality, method=6)
        new_bytes[bvi] = buf.getvalue()
        im['mimeType'] = 'image/webp'
        changed += 1

    if not changed:
        print('바꿀 PNG 가 없다')
        return

    # 2) BIN 청크를 처음부터 다시 쌓는다.
    #    bufferView 길이가 바뀌므로 뒤쪽 오프셋이 전부 밀린다. 순서대로 다시 붙이면서
    #    새 오프셋을 기록한다. accessor 의 byteOffset 은 bufferView 기준 상대값이라
    #    건드릴 필요가 없다.
    out = bytearray()
    for i, bv in enumerate(views):
        data = new_bytes.get(i)
        if data is None:
            s = bv.get('byteOffset', 0)
            data = bin_[s:s + bv['byteLength']]
        # 정점/애니메이션 데이터는 4바이트 정렬이 필요하다
        while len(out) % 4:
            out.append(0)
        bv['byteOffset'] = len(out)
        bv['byteLength'] = len(data)
        out += data
    js['buffers'][0]['byteLength'] = len(out)

    # 3) 텍스처가 WebP 를 가리키게 한다.
    #    core glTF 의 mimeType 은 png/jpeg 만 허용해서, WebP 는 확장으로 선언해야 한다.
    webp_imgs = set()
    for idx, im in enumerate(js.get('images', [])):
        if im.get('mimeType') == 'image/webp':
            webp_imgs.add(idx)
    for tex in js.get('textures', []):
        src_i = tex.get('source')
        if src_i in webp_imgs:
            tex.setdefault('extensions', {})[EXT] = {'source': src_i}
            tex.pop('source', None)
    for key in ('extensionsUsed', 'extensionsRequired'):
        lst = js.setdefault(key, [])
        if EXT not in lst:
            lst.append(EXT)

    write_glb(dst, js, bytes(out))
    print('텍스처 %d개 변환' % changed)


if __name__ == '__main__':
    q = int(sys.argv[3]) if len(sys.argv) > 3 else 90
    main(sys.argv[1], sys.argv[2], q)
