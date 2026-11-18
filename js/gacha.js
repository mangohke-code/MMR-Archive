// ===== 가챠 트래커 (베타, 사용자 요청 2026-11-18) =====
// 방식은 추출 프로그램 세션이 정리한 것(Desktop\Claude\니케_가챠트래커\정보모음_연동메모.md, nksd_file_reader.js)을 옮겼다.
// - 출처: PC판 계정 사건 기록 %USERPROFILE%\AppData\LocalLow\com_proximabeta\NIKKE\NKSD_TRIGGER_<계정>(zip/trigger.txt).
//   한 줄 = s,seq,종류,값,횟수,틱,e. 니케에는 모집 기록 웹 주소·토큰이 없어서 이 파일이 유일한 출처다.
//   종류 18 = 니케 획득(값 = 니케 번호, 횟수 = 장수), 13 = 모집 1번(횟수 = 뽑은 장수), 69 = 일반 모집일 때만 13 과 같이 찍힘.
// - 사용자는 그 파일을 끌어다 놓거나 골라서 넣는다. 브라우저 안에서 zip 을 직접 풀고(외부 라이브러리 없음) 13·18·69 줄만 쓴다.
//   예전에는 PowerShell 명령을 실행해 붙여넣게 했는데, '사이트의 명령을 그대로 실행'하는 구조가 위험해서 뺐다(사용자 결정, 2026-11-18).
// - 서버로 보내지 않는다. 고른 줄만 "NKT2\n" + "종류,seq,값,횟수,틱\n"×N 으로 적어 gzip+base64 로 이 브라우저 localStorage 에 둔다.
//   예전 명령으로 붙여 둔 NKT2·NKT1(종류 18 만, 모집 구분 없음) 저장분도 그대로 읽는다.
// - 1초 안에 들어온 18 줄 = 한 묶음, 10장 묶음 = 10연차. 묶음 첫 줄 앞 3초 ~ 끝 줄 뒤 3초 안의 13·69 로 나눈다:
//   69 있음 = 일반 모집 / 13 만 = 일반 외 모집 '픽업·소셜'(픽업 · 선택 특수 · 소셜 포인트, 서로 구분 불가) / 13 없음 = 모집 외 획득(선택 상자·출석·교환 등).
//   모집 외 획득은 SSR 통계(장수·간격·마지막 SSR 이후)에서 뺀다. 실버 마일리지 교환분은 기록 자체에 없다.
// - 니케 번호 -> 이름·등급은 게임 파일에 없어서 data/gacha-names.json(blablalink 기반)에서 읽는다. 없는 번호는 '#번호'.
(function () {
  const NIKKE_DIR = '%USERPROFILE%\\AppData\\LocalLow\\com_proximabeta\\NIKKE';
  const MAX_FILE = 200 * 1024 * 1024;
  const NAMES_URL = 'data/gacha-names.json?v=2';
  const STORE_KEY = 'mmr-gacha-data';
  const TICKS_EPOCH = 621355968000000000n;   // 0001-01-01 -> 1970-01-01 (.NET 틱)
  const BATCH_TICKS = 10000000n;             // 1초
  const MATCH_TICKS = 30000000n;             // 3초
  const PAGE = 40;
  const TYPES = {
    normal: { label: '일반', cls: 'is-normal' },
    pickup: { label: '픽업', cls: 'is-pickup', title: '필그림 · 오버스펙 · 한정 · 어브노말 니케가 나온 모집(소셜 포인트 모집에 없는 니케라 픽업으로 확정)' },
    special: { label: '픽업·소셜', cls: 'is-special', title: '일반 모집이 아닌 모집: 픽업 · 선택 특수 · 소셜 포인트(기록으로는 구분 불가)' },
    mileage: { label: '골드 마일리지', cls: 'is-mileage', title: '픽업 기간에 모집 외로 얻은 픽업 니케 = 골드 마일리지 200장 교환' },
    other: { label: '모집 외', cls: 'is-other', title: '선택 상자 · 출석 보상 등' },
    unknown: { label: '구분 없음', cls: 'is-unknown' },
  };
  const isGacha = t => t === 'normal' || t === 'pickup' || t === 'special' || t === 'unknown';
  const unitOf = t => (isGacha(t) ? '회' : '명');   // 모집 = 횟수(회), 모집 외 · 교환 = 획득 니케(명)

  const $ = id => document.getElementById(id);
  const fmt = new Intl.NumberFormat('ko-KR');
  // 게임 일정처럼 한국시간으로 고정해서 보인다(사이트 공통 규칙)
  // 표 칸이 좁아서 '2026.11.18 05:21' 처럼 붙여 쓴다
  const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = d => Object.fromEntries(partsFmt.formatToParts(d).map(x => [x.type, x.value]));
  const dayStr = d => { const p = parts(d); return `${p.year}.${p.month}.${p.day}`; };
  const dtf = { format: d => { const p = parts(d); return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`; } };
  const dayFmt = { format: dayStr };
  const monthKey = d => { const p = parts(d); return `${p.year}-${p.month}`; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tickTime = t => new Date(Number((t - TICKS_EPOCH) / 10000n));
  const byTicks = (a, b) => (a.ticks < b.ticks ? -1 : a.ticks > b.ticks ? 1 : 0);

  let names = null;          // { "3001": ["라피", "SR"] }
  let namesReq = null;
  let state = null;          // { pulls, batches, classified }
  let shown = PAGE;
  let started = false;

  function loadNames() {
    if (!namesReq) {
      namesReq = fetch(NAMES_URL).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
        .then(d => { names = d || {}; return names; });
    }
    return namesReq;
  }
  function info(code) {
    const hit = names && names[code];
    return hit ? { name: hit[0], rare: hit[1] } : { name: '#' + code, rare: 'U' };
  }
  const isSSR = p => info(p.code).rare === 'SSR';
  const tag = (p, extra = '') => {
    const i = info(p.code);
    return `<span class="gacha-tag is-${i.rare}">${esc(i.name)}${extra}${p.isNew ? '<em>NEW</em>' : ''}</span>`;
  };
  const typeChip = t => `<span class="gacha-type ${TYPES[t].cls}"${TYPES[t].title ? ` title="${TYPES[t].title}"` : ''}>${TYPES[t].label}</span>`;

  // NKT2 / NKT1 글자 -> { pulls, gacha, normal, classified }
  function parse(raw) {
    const lines = raw.split('\n');
    const head = lines[0].trim();
    if (head !== 'NKT2' && head !== 'NKT1') throw new Error('알 수 없는 형식입니다.');
    const v2 = head === 'NKT2';
    const seen = new Set();
    const pulls = [], gacha = [], normal = [];
    for (const line of lines.slice(1)) {
      const p = line.trim().split(',');
      const [kind, seq, val, cnt, tk] = v2 ? p : ['18', ...p];
      if (!tk || !/^\d+$/.test(tk) || seen.has(seq)) continue;   // seq 로 중복 제거
      seen.add(seq);
      const ticks = BigInt(tk);
      const count = Math.max(1, Number(cnt) || 1);
      if (kind === '18') pulls.push({ seq, code: val, count, ticks, time: tickTime(ticks) });
      else if (kind === '13') gacha.push({ ticks, count });
      else if (kind === '69') normal.push({ ticks, count });
    }
    if (!pulls.length) throw new Error('니케 획득 기록이 0건입니다.');
    return { pulls, gacha, normal, classified: v2 };
  }

  // 저장해 둔 글자(base64(gzip(NKT))) 풀기 · 만들기
  async function unpackSaved(text) {
    const bytes = Uint8Array.from(atob(String(text).replace(/\s+/g, '')), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  async function packForSave(raw) {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // zip 바이트에서 이름이 name 인 항목을 푼다(추출 프로그램 세션 nksd_file_reader.js 의 unzipEntry).
  // NIKKE 기록 파일은 크기가 작아도 ZIP64 로 저장돼 있어서, 크기·위치가 0xFFFFFFFF 면 추가 필드(id 0x0001)의 8바이트 값을 쓴다.
  async function unzipEntry(buf, name) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('NIKKE 기록 파일(NKSD_TRIGGER_…)이 아닙니다.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('기록 파일이 깨졌습니다.');
      const method = dv.getUint16(p + 10, true);
      let csize = dv.getUint32(p + 20, true);
      let usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      let local = dv.getUint32(p + 42, true);
      const entryName = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
      if (usize === 0xFFFFFFFF || csize === 0xFFFFFFFF || local === 0xFFFFFFFF) {
        let x = p + 46 + nlen;
        const xend = x + xlen;
        while (x + 4 <= xend) {
          const id = dv.getUint16(x, true), sz = dv.getUint16(x + 2, true);
          if (id === 0x0001) {
            let q = x + 4;
            const u64 = () => { const v = Number(dv.getBigUint64(q, true)); q += 8; return v; };
            if (usize === 0xFFFFFFFF) usize = u64();
            if (csize === 0xFFFFFFFF) csize = u64();
            if (local === 0xFFFFFFFF) local = u64();
            break;
          }
          x += 4 + sz;
        }
      }
      if (entryName === name) {
        const lnlen = dv.getUint16(local + 26, true), lxlen = dv.getUint16(local + 28, true);
        const start = local + 30 + lnlen + lxlen;
        const data = buf.subarray(start, start + csize);
        if (method === 0) return data;
        if (method !== 8) throw new Error('지원하지 않는 기록 파일입니다.');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      p += 46 + nlen + xlen + clen;
    }
    throw new Error('NIKKE 기록 파일(NKSD_TRIGGER_…)이 맞는지 확인해 주세요.');
  }

  // 기록 파일 -> NKT2 글자(종류 13·18·69 줄만)
  async function fileToNkt(file) {
    if (file.size > MAX_FILE) throw new Error('파일이 너무 큽니다. NKSD_TRIGGER_… 파일을 넣어 주세요.');
    const buf = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder().decode(await unzipEntry(buf, 'trigger.txt'));
    const out = ['NKT2'];
    for (const line of text.split('\n')) {
      const p = line.split(',');                         // s,seq,종류,값,횟수,틱,e
      if (p.length >= 6 && (p[2] === '13' || p[2] === '18' || p[2] === '69')) out.push(`${p[2]},${p[1]},${p[3]},${p[4]},${p[5].trim()}`);
    }
    return out.join('\n') + '\n';
  }

  // 묶음(1초 안) 나누기 + 모집 종류 붙이기 + 처음 얻은 니케(NEW) 표시
  function build({ pulls, gacha, normal, classified }) {
    pulls.sort(byTicks);
    gacha.sort(byTicks);
    normal.sort(byTicks);
    const batches = [];
    let cur = null;
    for (const p of pulls) {
      if (!cur || p.ticks - cur.last > BATCH_TICKS) { cur = { time: p.time, first: p.ticks, last: p.ticks, items: [] }; batches.push(cur); }
      cur.items.push(p);
      cur.last = p.ticks;
    }
    // 시각순 두 줄 맞추기: 묶음마다 [첫 줄-3초, 끝 줄+3초] 안의 아직 안 쓴 13·69 를 하나씩 가져간다
    const take = (list, ptr, b) => {
      while (ptr.i < list.length && list[ptr.i].ticks < b.first - MATCH_TICKS) ptr.i++;
      if (ptr.i < list.length && list[ptr.i].ticks <= b.last + MATCH_TICKS) { ptr.i++; return true; }
      return false;
    };
    const gp = { i: 0 }, np = { i: 0 };
    const seenCode = new Set();
    for (const b of batches) {
      b.size = b.items.reduce((s, p) => s + p.count, 0);
      const g = classified && take(gacha, gp, b);
      const n = classified && take(normal, np, b);
      b.type = !classified ? 'unknown' : n ? 'normal' : g ? 'special' : 'other';
      b.ssr = b.items.some(isSSR);
      for (const p of b.items) {
        p.type = b.type;
        p.isNew = !seenCode.has(p.code);
        seenCode.add(p.code);
      }
    }
    return { pulls, batches, classified };
  }

  // ===== 픽업 기록 잇기 (사용자 요청, 2026-11-19) =====
  // 기록에는 어느 배너에서 뽑았는지가 없어서, 배너 하나에 장수를 나눠 주지 않는다.
  // 사이트 픽업 기록(APP_DATA.pickup: 니케 · 시작일 · 종료일)으로 할 수 있는 것만 한다:
  // - 그 니케의 픽업 기간에 얻은 픽업 니케 = '픽업 획득'(초상화 격자)
  // - 그 니케의 픽업 기간에 '모집 외'로 얻은 픽업 니케 = 골드 마일리지 교환(200장)으로 본다(사용자 확인)
  // 날짜만 적힌 기간은 한국시간 시작일 0시 ~ 종료일 끝까지로 본다.
  const kstDay = (v, end) => {
    if (!v) return NaN;
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T${end ? '23:59:59.999' : '00:00:00'}+09:00`);
    return Date.parse(s);
  };
  const MILEAGE_COST = 200;
  // 니케 이미지 표(nikkeImg)에 없으면 캐릭터 도감(codex 의 이름N · 이미지N)에서 찾는다
  let codexImg = null;
  function nikkeImgOf(name) {
    const row = (APP_DATA.nikkeImg || []).find(n => n['이름'] === name);
    if (row && row['이미지']) return row['이미지'];
    if (!codexImg && APP_DATA.ready) {
      codexImg = new Map();
      for (const r of APP_DATA.codex || []) {
        for (let i = 1; r['이름' + i] !== undefined; i++) {
          if (r['이름' + i] && r['이미지' + i] && !codexImg.has(r['이름' + i])) codexImg.set(r['이름' + i], r['이미지' + i]);
        }
      }
    }
    return (codexImg && codexImg.get(name)) || '';
  }
  let pickupPeriods = null;   // 니케 이름 -> [{start, end, event}]
  function loadPickupPeriods() {
    if (pickupPeriods || !APP_DATA.ready) return pickupPeriods;
    pickupPeriods = new Map();
    for (const p of APP_DATA.pickup || []) {
      const s = kstDay(p['시작일'], false), e = kstDay(p['종료일'], true);
      if (!p['니케'] || isNaN(s) || isNaN(e)) continue;
      if (!pickupPeriods.has(p['니케'])) pickupPeriods.set(p['니케'], []);
      pickupPeriods.get(p['니케']).push({ start: s, end: e, event: p['이벤트'] || '', rerun: String(p['복각']) === 'true' });
    }
    return pickupPeriods;
  }
  // 신규 픽업 기간에 나온 그 픽업 니케 = 무조건 픽업(사용자 확인, 2026-11-19: 일반 · 소셜 모집에는 기간이 끝나고 한두 달 뒤에 들어간다).
  // 복각 기간은 일반 · 소셜 · 픽업을 가릴 수 없어서 쓰지 않는다.
  const inNewPickup = p => {
    const list = pickupPeriods && pickupPeriods.get(info(p.code).name);
    const t = p.time.getTime();
    return !!list && list.some(r => !r.rerun && r.start <= t && t <= r.end);
  };
  const inPickup = p => {
    const list = pickupPeriods && pickupPeriods.get(info(p.code).name);
    const t = p.time.getTime();
    return !!list && list.some(r => r.start <= t && t <= r.end);
  };
  // 소셜 포인트 모집에 없는 니케(사용자 확인, 2026-11-19): 필그림 · 오버스펙(기업 끝 '(오)') · 한정 시즌(LIMITED_SEASONS) · 어브노말.
  // 픽업·소셜 묶음에 이 니케(또는 신규 픽업 기간의 그 픽업 니케)가 하나라도 있으면 그 묶음은 소셜이 아니라 픽업으로 확정한다.
  // 묶음 단위라서, 확정 니케와 같은 10연차에 나온 다른 니케(픽뚫 SSR 등)도 '픽업' 묶음으로 보인다.
  // 픽업 기록에 없는 초기 필그림은 캐릭터 도감 소속(필그림)으로 찾는다.
  let sureNames = null;
  function loadSureNames() {
    if (sureNames || !APP_DATA.ready) return sureNames;
    sureNames = new Set();
    const limited = typeof LIMITED_SEASONS !== 'undefined' ? LIMITED_SEASONS : [];
    for (const p of APP_DATA.pickup || []) {
      const co = String(p['기업'] || '');
      if (co === '어브노말' || co === '필그림' || co.endsWith('(오)') || limited.includes(p['시즌'])) sureNames.add(p['니케']);
    }
    for (const r of APP_DATA.codex || []) {
      for (let i = 1; r['이름' + i] !== undefined; i++) if (r['이름' + i] && r['소속' + i] === '필그림') sureNames.add(r['이름' + i]);
    }
    return sureNames;
  }
  // 모집 외로 얻은 픽업 니케(그 니케의 픽업 기간 안) -> 골드 마일리지. 묶음 전체가 그렇다면 묶음 종류도 바꾼다.
  function applyPickup() {
    if (!state || !state.classified || !loadPickupPeriods()) return;
    const sure = loadSureNames();
    for (const b of state.batches) {
      if (b.type === 'special' && b.items.some(p => sure.has(info(p.code).name) || inNewPickup(p))) {
        b.type = 'pickup';
        for (const p of b.items) p.type = 'pickup';
        continue;
      }
      if (b.type !== 'other' && b.type !== 'mileage') continue;
      let all = true;
      for (const p of b.items) {
        p.type = inPickup(p) ? 'mileage' : 'other';
        if (p.type !== 'mileage') all = false;
      }
      b.type = all ? 'mileage' : 'other';
    }
  }

  function render() {
    const { pulls, batches, classified } = state;
    const sum = list => list.reduce((s, p) => s + p.count, 0);
    const gachaN = sum(pulls.filter(p => isGacha(p.type)));
    const tens = batches.filter(b => isGacha(b.type) && b.size === 10).length;
    let ssrGacha = 0, ssrAll = 0;
    for (const p of pulls) {
      if (!isSSR(p)) continue;
      ssrAll += p.count;
      if (isGacha(p.type)) ssrGacha += p.count;
    }
    const unknown = new Set(pulls.filter(p => !(names && names[p.code])).map(p => p.code));
    $('gacha-range').innerHTML = `<b>${dayStr(pulls[0].time)} ~ ${dayStr(pulls[pulls.length - 1].time)}</b>`
      + `<span>${fmt.format(pulls.length)}건</span>`
      + (unknown.size ? `<span class="gacha-warn">이름 미등록 ${unknown.size}종</span>` : '')
      + (classified ? '' : '<span class="gacha-warn">예전 명령 기록 · 모집 구분 없음</span>');
    // 픽업·소셜(일반 외)에 소셜 포인트 모집이 섞여 있다는 경고(구분된 기록일 때만)
    $('gacha-social-warn').hidden = !classified;

    const byType = t => sum(pulls.filter(p => p.type === t));
    // 한눈에(요약 오른쪽 세로 판). 단위: 획득 니케 · SSR = 명, 모집 횟수 = 회, 티켓 = 장(사용자 요청, 2026-11-19)
    state.overview = [
      ['획득 니케', fmt.format(sum(pulls)), '명', '', classified ? `모집 외 ${fmt.format(byType('other') + byType('mileage'))}명 포함` : ''],
      ['모집', fmt.format(gachaN), '회', '', classified ? `일반 ${fmt.format(byType('normal'))} · 픽업 ${fmt.format(byType('pickup'))} · 픽업·소셜 ${fmt.format(byType('special'))}` : ''],
      // 사용 재화 판은 종류별과 같은 숫자라 없애고(사용자 지적, 2026-11-19) 쥬얼 환산만 여기로 옮겼다
      ['쥬얼 환산', fmt.format(gachaN * 300), '쥬얼', 'is-jewel', '모집 1회 = 300 쥬얼 · 소셜 포함'],
      ['10연차', fmt.format(tens), '회', '', ''],
      ['모집 SSR', fmt.format(ssrGacha), '명', 'is-ssr', classified ? `모집 외 ${fmt.format(ssrAll - ssrGacha)}명 제외` : ''],
      ['SSR 확률', gachaN ? (ssrGacha / gachaN * 100).toFixed(2) : '-', '%', 'is-ssr', '모집 전체 기준'],
    ];
    renderView();
  }

  function renderOverview() {
    $('gacha-overview-body').innerHTML = state.overview.map(([k, v, u, cls, sub]) =>
      `<div class="go-row ${cls}"><div class="go-k"><span>${k}</span>${sub ? `<i>${sub}</i>` : ''}</div><b>${v}<small>${u}</small></b></div>`).join('');
  }

  // 보기 하나만 그린다(안 보이는 것까지 만들지 않는다). 그린 보기는 기록이 바뀔 때까지 다시 안 그린다.
  let drawn = new Set();
  function renderView() {
    document.querySelectorAll('#gacha-views [data-view]').forEach(b => {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.gacha-view').forEach(v => { v.hidden = v.dataset.view !== view; });
    if (drawn.has(view)) {
      if (view === 'summary') scrollChartEnd();
      else fitMarquees(document.querySelector(`.gacha-view[data-view="${view}"]`));
      return;
    }
    drawn.add(view);
    // 오른쪽 판을 먼저 채워야 차트 높이를 그 높이에 맞출 수 있다(차트를 먼저 그리면 낮게 그려졌다가 나중에 길어졌다)
    if (view === 'summary') { renderOverview(); renderTypes(); drawHours(); drawChart(); }
    else if (view === 'pickup') renderPickups();
    else if (view === 'first') renderFirst();
    else if (view === 'nikke') renderNikke();
    else if (view === 'history') renderBatches();
  }

  // 모집 종류별: 종류마다 한 줄 판(장수 크게, 10연차 · SSR · 비율)
  function renderTypes() {
    const card = $('gacha-types');
    if (!state.classified) { card.hidden = true; return; }
    card.hidden = false;
    const order = ['normal', 'pickup', 'special', 'mileage', 'other'];
    const rows = order.map(t => {
      const items = state.pulls.filter(p => p.type === t);
      const n = items.reduce((s, p) => s + p.count, 0);
      if (!n && (t === 'mileage' || t === 'pickup')) return '';
      const ssr = items.filter(isSSR).reduce((s, p) => s + p.count, 0);
      const tens = state.batches.filter(b => b.type === t && b.size === 10).length;
      const cells = isGacha(t)
        ? `<span><em>10연차</em>${fmt.format(tens)}회</span><span><em>SSR</em>${fmt.format(ssr)}명</span><span><em>확률</em>${n ? (ssr / n * 100).toFixed(2) + '%' : '-'}</span>`
        : t === 'mileage'
          ? `<span><em>사용</em>${fmt.format(n * MILEAGE_COST)}장</span><span class="is-dim">통계 제외</span>`
          : `<span><em>SSR</em>${fmt.format(ssr)}명</span><span class="is-dim">통계 제외</span>`;
      return `<div class="gacha-typerow ${TYPES[t].cls}"><div class="gt-head">${typeChip(t)}<b>${fmt.format(n)}<small>${unitOf(t)}</small></b></div><div class="gt-cells">${cells}</div></div>`;
    });
    // 픽업 · 픽업·소셜은 원래 한 종류(일반 외 모집, 기록상 13만 있음)를 나눈 것이라 뒤 판 하나로 묶는다(사용자 요청, 2026-11-19)
    const [normal, pickup, special, ...rest] = rows;
    $('gacha-types-body').innerHTML = normal + (pickup ? `<div class="gt-group">${pickup}${special}</div>` : special) + rest.join('');
  }


  // 픽업 획득(사용자 요청, 2026-11-19): 픽업 기간(사이트 픽업 기록의 시작일 ~ 종료일)마다 나눠,
  // 그 기간에 얻은 픽업 니케별로 '픽업으로 몇 장 · 티켓(골드 마일리지) 교환으로 몇 장'만 보인다. 최근 기간부터.
  function pickupGroups() {
    const groups = new Map();
    for (const p of state.pulls) {
      // 일반 모집(69)은 픽업이 아님이 확실하니 뺀다(복각 기간에 일반 모집에서 나온 같은 니케)
      if (!(p.type === 'pickup' || p.type === 'special' || p.type === 'unknown' || p.type === 'mileage')) continue;
      const nm = info(p.code).name;
      const t = p.time.getTime();
      const row = (pickupPeriods.get(nm) || []).find(r => r.start <= t && t <= r.end);
      if (!row) continue;
      const key = `${row.start}|${row.end}`;
      if (!groups.has(key)) groups.set(key, { start: row.start, end: row.end, events: new Set(), nikkes: new Map() });
      const g = groups.get(key);
      if (row.event) g.events.add(row.event);
      const n = g.nikkes.get(nm) || { name: nm, pick: 0, ex: 0, rerun: row.rerun };
      if (p.type === 'mileage') n.ex += p.count; else n.pick += p.count;
      g.nikkes.set(nm, n);
    }
    return [...groups.values()].sort((a, b) => b.start - a.start || b.end - a.end);
  }
  function renderPickups() {
    if (!loadPickupPeriods()) { $('gacha-pickups').innerHTML = '<div class="gacha-empty">픽업 기록을 불러오는 중</div>'; return; }
    const groups = pickupGroups();
    let pick = 0, ex = 0;
    for (const g of groups) for (const n of g.nikkes.values()) { pick += n.pick; ex += n.ex; }
    $('gacha-pickup-sum').textContent = `픽업 ${fmt.format(pick)}명 · 교환 ${fmt.format(ex)}명`;
    $('gacha-pickups').innerHTML = groups.map(g => {
      const tiles = [...g.nikkes.values()].map(n => {
        const img = nikkeImgOf(n.name);
        return `<div class="gp-nikke${n.ex ? ' has-ex' : ''}">
          <span class="gp-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : ''}</span>
          <span class="gp-body">${mq(n.name, 'b')}
            <span class="gp-counts"><span class="gp-kind${n.rerun ? ' is-rerun' : ''}">${n.rerun ? '복각' : '신규'}</span>${n.pick ? `<span class="is-pick">픽업 <strong>${fmt.format(n.pick)}</strong>명</span>` : ''}${n.ex ? `<span class="is-ex">교환 <strong>${fmt.format(n.ex)}</strong>명</span>` : ''}</span></span>
        </div>`;
      }).join('');
      // 이벤트 이름은 한 줄(길면 줄이 넘어가 판이 세로로 길어졌다). 넘치면 좌우로 천천히 흐른다(mq)
      const ev = [...g.events].join(' · ');
      return `<article class="gacha-period"><div class="gp-head"><b>${rangeStr(g.start, g.end)}</b>${ev ? mq(ev, 'span', 'gp-ev') : ''}</div><div class="gp-list">${tiles}</div></article>`;
    }).join('') || '<div class="gacha-empty">픽업 기간에 얻은 픽업 니케 없음</div>';
    fitMarquees($('gacha-pickups'));
  }
  const rangeStr = (from, to) => {
    const a = dayStr(new Date(from)), z = dayStr(new Date(to));
    if (a === z) return a;
    return a.slice(0, 4) === z.slice(0, 4) ? `${a} ~ ${z.slice(5)}` : `${a} ~ ${z}`;
  };

  // 신규 획득: 니케마다 처음 얻은 순간 하나씩. 기본은 최신부터, 단추로 오래된순. 번호는 처음 얻은 차례(1 = 맨 처음).
  const FIRST_ORDER_KEY = 'mmr-gacha-first-order';
  let firstOldest = false;
  try { firstOldest = localStorage.getItem(FIRST_ORDER_KEY) === '1'; } catch (e) { /* 무시 */ }
  function renderFirst() {
    const btn = $('gacha-first-order');
    btn.querySelector('span').textContent = firstOldest ? '오래된순' : '최신순';
    btn.setAttribute('aria-pressed', firstOldest ? 'true' : 'false');
    const rare = $('gacha-first-rare').value;
    const all = state.pulls.filter(p => p.isNew).map((p, k) => ({ p, no: k + 1 }));
    const list = all.filter(({ p }) => !rare || info(p.code).rare === rare);
    if (!firstOldest) list.reverse();
    $('gacha-first-grid').innerHTML = list.map(({ p, no }) => {
      const i = info(p.code), img = nikkeImgOf(i.name);
      return `<div class="gacha-first is-${i.rare}">`
        + `<span class="gf-no">${no}</span>`
        + `<span class="gf-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : ''}</span>`
        + `<span class="gf-body">${mq(i.name, 'b')}<span>${dayStr(p.time)} ${typeChip(p.type)}</span></span></div>`;
    }).join('') || '<div class="gacha-empty">없음</div>';
    fitMarquees($('gacha-first-grid'));
  }

  // 니케별: 칸 격자(초상화 · 이름 · 횟수 크게). 횟수가 같으면 이름 가나다순
  const koCmp = new Intl.Collator('ko').compare;
  function renderNikke() {
    const per = new Map();
    for (const p of state.pulls) {
      const row = per.get(p.code) || { code: p.code, n: 0 };
      row.n += p.count;
      per.set(p.code, row);
    }
    const rare = $('gacha-rare').value;
    $('gacha-nikke-grid').innerHTML = [...per.values()]
      .filter(r => !rare || info(r.code).rare === rare)
      .sort((a, b) => b.n - a.n || koCmp(info(a.code).name, info(b.code).name))
      .map(r => {
        const i = info(r.code), img = nikkeImgOf(i.name);
        return `<div class="gacha-nk is-${i.rare}"><span class="gf-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : ''}</span>`
          + mq(i.name, 'span', 'gn-name') + `<b>${fmt.format(r.n)}<small>회</small></b></div>`;
      })
      .join('') || '<div class="gacha-empty">없음</div>';
    fitMarquees($('gacha-nikke-grid'));
  }

  // 잘리는 글자(니케 이름 · 이벤트 이름)는 좌우로 천천히 흐르게 한다(사용자 요청, 2026-11-19).
  // 칸보다 길 때만 is-over 를 붙이고, 밀어야 할 거리(--mq-shift)와 시간(--mq-dur)을 글자 길이에 맞춘다.
  const mq = (text, tagName, cls = '') => `<${tagName} class="gx-mq ${cls}" title="${esc(text)}"><span>${esc(text)}</span></${tagName}>`;
  function fitMarquees(root) {
    if (!root || !root.offsetWidth) return;   // 안 보이는 보기는 폭을 못 잰다(보일 때 다시 부른다)
    const els = [...root.querySelectorAll('.gx-mq')];
    const overs = els.map(el => el.firstElementChild.offsetWidth - el.clientWidth);   // 한 번에 재고 한 번에 쓴다
    els.forEach((el, k) => {
      const over = overs[k];
      el.classList.toggle('is-over', over > 1);
      if (over > 1) {
        el.style.setProperty('--mq-shift', `-${over + 2}px`);
        el.style.setProperty('--mq-dur', `${(3 + over / 25).toFixed(1)}s`);
      }
    });
  }

  function renderBatches() {
    const onlySSR = $('gacha-only-ssr').checked;
    const type = $('gacha-type').value;
    const list = state.batches.slice().reverse().filter(b => (!onlySSR || b.ssr) && (!type || b.type === type));
    $('gacha-batch-body').innerHTML = list.slice(0, shown).map(b =>
      `<tr${b.ssr ? ' class="has-ssr"' : ''}><td>${dtf.format(b.time)}</td><td>${typeChip(b.type)}</td><td class="num">${b.size}</td>`
      + `<td class="gacha-items">${b.items.map(p => tag(p, p.count > 1 ? ' ×' + p.count : '')).join('')}</td></tr>`).join('')
      || '<tr><td colspan="4" class="gacha-empty">없음</td></tr>';
    $('gacha-more').hidden = list.length <= shown;
  }

  // 기간별 막대(주간 · 월별 · 연간): 일반 · 픽업·소셜 · 골드 마일리지 · 모집 외를 쌓는다. 금색 점 = 그 기간 모집 SSR 장수.
  // 빈 기간도 칸을 둬서 시간 간격이 고르게 보인다. 막대에 마우스를 올리면(폰은 누르면) 세부 내역 툴팁.
  const PERIOD_KEY = 'mmr-gacha-period';
  let period = 'month';
  try { const v = localStorage.getItem(PERIOD_KEY); if (['week', 'month', 'year'].includes(v)) period = v; } catch (e) { /* 무시 */ }
  const DAY = 86400000;
  // 한국시간 날짜를 UTC 0시 숫자로(주 계산용)
  const kstMidnight = d => { const p = parts(d); return Date.UTC(+p.year, +p.month - 1, +p.day); };
  const periodKey = d => {
    if (period === 'year') return parts(d).year;
    if (period === 'month') return monthKey(d);
    const t = kstMidnight(d);
    const mon = t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;   // 그 주 월요일
    return new Date(mon).toISOString().slice(0, 10);
  };
  const nextKey = k => {
    if (period === 'year') return String(+k + 1);
    if (period === 'month') { const [y, m] = k.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }
    return new Date(Date.parse(k + 'T00:00:00Z') + 7 * DAY).toISOString().slice(0, 10);
  };
  // 주간은 '11월 3주'(그 주 월요일이 그 달 몇째 월요일인지). 해가 바뀐 첫 눈금에는 '27년'을 붙인다.
  const weekOf = k => { const d = +k.slice(8, 10); return { y: k.slice(0, 4), m: +k.slice(5, 7), n: Math.ceil(d / 7) }; };
  const keyLabel = (k, withYear) => {
    if (period === 'year') return k;
    if (period === 'month') return k.slice(2).replace('-', '.');
    const w = weekOf(k);
    return `${withYear ? w.y.slice(2) + '년 ' : ''}${w.m}월 ${w.n}주`;
  };
  const keyTitle = k => {
    if (period === 'year') return `${k}년`;
    if (period === 'month') return k.replace('-', '.');
    const w = weekOf(k);
    const md = t => new Date(t).toISOString().slice(5, 10).replace('-', '.');
    const t0 = Date.parse(k + 'T00:00:00Z');
    return `${w.y}년 ${w.m}월 ${w.n}주 <small>${md(t0)} ~ ${md(t0 + 6 * DAY)}</small>`;
  };

  // 막대 하나 쌓기(기간별 · 시간대별 공통). 픽업 · 픽업·소셜이 붙어 있으면 한 막대로 그리고
  // 경계를 그라데이션으로 섞는다(사용자 요청, 2026-11-19: 둘은 기록상 한 종류를 나눈 것이라 경계가 흐릿한 게 맞다).
  // 그라데이션은 막대마다 경계 위치가 달라서 막대마다 하나(gid)씩 만든다.
  const BLEND_PX = 16;
  function stackBar(d, order, x, barW, y, gid) {
    let out = '', acc = 0;
    for (let k = 0; k < order.length; k++) {
      const t = order[k];
      if (!d[t]) continue;
      if (t === 'pickup' && order[k + 1] === 'special' && d.special) {
        const top = y(acc + d.pickup + d.special), mid = y(acc + d.pickup), bot = y(acc);
        const hgt = Math.max(bot - top, 0.01);
        const f = (mid - top) / hgt;                       // 위에서부터 픽업·소셜(위) 비율
        const half = Math.min(BLEND_PX / 2 / hgt, 0.35);
        const o = v => Math.min(1, Math.max(0, v)).toFixed(4);
        out += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="${o(f - half)}" style="stop-color:var(--gacha-pick)"/><stop offset="${o(f + half)}" style="stop-color:var(--gacha-sure)"/></linearGradient>`
          + `<rect x="${x}" y="${top}" width="${barW}" height="${hgt}" class="gc-bar is-blend" style="fill:url(#${gid})"/>`;
        acc += d.pickup + d.special;
        k++;
        continue;
      }
      const top = y(acc + d[t]);
      out += `<rect x="${x}" y="${top}" width="${barW}" height="${y(acc) - top}" class="gc-bar ${TYPES[t].cls}"/>`;
      acc += d[t];
    }
    return out;
  }

  let chartData = [];
  // 넓은 화면(요약 두 칸)에서는 왼쪽 칸(시간대별 + 기간별) 높이를 오른쪽 판들(한눈에 · 종류별) 높이에 맞춘다(사용자 요청, 2026-11-19).
  // 시간대별 판은 높이가 고정이라 기간별 차트 높이로 맞춘다. 한 번 그려 보고 모자라거나 넘친 만큼 고쳐 한 번 더 그린다.
  // 한 칸 화면에서는 420px.
  const CHART_MIN_H = 420;
  let chartH = CHART_MIN_H;
  function drawChart() {
    paintChart(chartH);
    const side = document.querySelector('.gacha-side');
    const main = document.querySelector('.gacha-main');
    const twoCol = side && side.offsetHeight > 0
      && Math.abs(side.getBoundingClientRect().top - main.getBoundingClientRect().top) < 2;
    const want = twoCol ? Math.max(CHART_MIN_H, Math.round(chartH + side.offsetHeight - main.offsetHeight)) : CHART_MIN_H;
    if (Math.abs(want - chartH) > 2) { chartH = want; paintChart(chartH); }
  }

  // ===== 시간대별 모집(사용자 요청, 2026-11-19) =====
  // 한국시간 0~23시마다 모집 횟수를 일반 · 픽업 · 픽업·소셜로 쌓는다(모집 외 · 골드 마일리지는 모집이 아니라 뺀다).
  // 24칸을 판 폭에 맞춰 채우고, 막대에 올리면(폰은 누르면) 그 시간 내역 툴팁.
  let hourData = [];
  const HOUR_H = 260;
  function drawHours() {
    const order = state.classified ? ['normal', 'pickup', 'special'] : ['unknown'];
    const data = Array.from({ length: 24 }, (_, hr) => ({ hr, order, n: 0, ssr: 0, normal: 0, pickup: 0, special: 0, unknown: 0 }));
    for (const b of state.batches) {
      if (!isGacha(b.type)) continue;
      const d = data[Number(parts(b.time).hour) % 24];
      for (const p of b.items) {
        d.n += p.count;
        d[p.type] += p.count;
        if (isSSR(p)) d.ssr += p.count;
      }
    }
    hourData = data;
    const total = data.reduce((s, d) => s + d.n, 0);
    const peak = data.reduce((a, d) => (d.n > a.n ? d : a), data[0]);
    $('gacha-hours-sum').textContent = total ? `최다 시간대 ${peak.hr}시 · ${fmt.format(peak.n)}회` : '';
    const box = $('gacha-hours-chart');
    const padL = 52, padR = 16, padB = 30, padT = 14, h = HOUR_H;
    const w = Math.max(320, box.clientWidth || 0);
    const slot = (w - padL - padR) / 24;
    const barW = Math.max(6, Math.round(slot * 0.66));
    const every = slot >= 34 ? 1 : slot >= 18 ? 2 : 3;
    const max = Math.max(...data.map(d => d.n), 1);
    const maxS = Math.max(...data.map(d => d.ssr), 1);
    const y = v => h - padB - (v / max) * (h - padB - padT);
    const ys = v => h - padB - (v / maxS) * (h - padB - padT);   // 금색 점 = 그 시간 모집 SSR(기간별 차트와 같은 방식)
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="시간대별 모집">`;
    for (const t of [0, Math.round(max / 2), max]) {
      svg += `<line x1="${padL}" x2="${w - padR}" y1="${y(t)}" y2="${y(t)}" class="gc-grid"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" class="gc-axis">${fmt.format(t)}</text>`;
    }
    data.forEach((d, i) => {
      const x0 = padL + i * slot, x = x0 + (slot - barW) / 2;
      svg += `<rect x="${x0}" y="${padT - 6}" width="${slot}" height="${h - padB - padT + 6}" class="gc-hit" data-i="${i}"/>`;
      svg += stackBar(d, order, x, barW, y, `gh${i}`);
      if (d.ssr) svg += `<circle cx="${x + barW / 2}" cy="${ys(d.ssr)}" r="4.5" class="gc-ssr"/>`;
      if (i % every === 0) svg += `<text x="${x + barW / 2}" y="${h - 9}" text-anchor="middle" class="gc-axis">${i}시</text>`;
    });
    box.innerHTML = `<div class="gacha-chart-scroll">${svg}</svg></div><div class="gacha-tip" hidden></div><div class="gacha-legend">`
      + order.map(t => `<span class="${TYPES[t].cls}">${TYPES[t].label}</span>`).join('') + '<span class="is-ssr">모집 SSR</span></div>';
  }
  function hourTipHtml(d) {
    const total = hourData.reduce((s, x) => s + x.n, 0);
    const hh = String(d.hr).padStart(2, '0');
    const rows = d.order.filter(t => d[t]).map(t =>
      `<div class="gt-row"><span class="gacha-legend-dot ${TYPES[t].cls}"></span><span>${TYPES[t].label}</span><b>${fmt.format(d[t])}회</b></div>`).join('');
    return `<div class="gt-title">${d.hr}시 <small>${hh}:00 ~ ${hh}:59</small></div>${rows || '<div class="gt-row"><span></span><span>기록 없음</span><b></b></div>'}`
      + (d.n ? `<div class="gt-row gt-sum"><span></span><span>모집</span><b>${fmt.format(d.n)}회</b></div>`
        + `<div class="gt-row"><span></span><span>전체 중</span><b>${(d.n / total * 100).toFixed(1)}%</b></div>`
        + `<div class="gt-row"><span class="gacha-legend-dot is-ssr"></span><span>모집 SSR</span><b>${fmt.format(d.ssr)}명</b></div>` : '');
  }
  function paintChart(h) {
    document.querySelectorAll('#gacha-period [data-period]').forEach(b => b.classList.toggle('active', b.dataset.period === period));
    const order = state.classified ? ['normal', 'pickup', 'special', 'mileage', 'other'] : ['unknown'];
    const buckets = new Map();
    const bucket = k => {
      if (!buckets.has(k)) buckets.set(k, { n: 0, ssr: 0, tens: 0, normal: 0, pickup: 0, special: 0, mileage: 0, other: 0, unknown: 0 });
      return buckets.get(k);
    };
    for (const b of state.batches) {
      const m = bucket(periodKey(b.time));
      if (isGacha(b.type) && b.size === 10) m.tens++;
      for (const p of b.items) {
        m.n += p.count;
        m[p.type] += p.count;
        if (isGacha(p.type) && isSSR(p)) m.ssr += p.count;
      }
    }
    const keys = [...buckets.keys()].sort();
    const data = [];
    for (let k = keys[0], guard = 0; k && k <= keys[keys.length - 1] && guard < 2000; k = nextKey(k), guard++) {
      data.push({ k, order, ...(buckets.get(k) || bucket(k)) });
    }
    chartData = data;
    // 기본 칸 폭으로 그리되, 판에 자리가 남으면 칸을 넓혀 판 폭을 채운다(연간 · 짧은 기록)
    // 오른쪽 여백(padR)은 마지막 칸 날짜 글자가 잘리지 않을 만큼(주간 '26.11.16' 이 칸보다 넓다)
    const [baseW, baseGap] = { week: [16, 6], month: [26, 10], year: [72, 30] }[period];
    const padL = 52, padR = 40, padB = 30, padT = 16;
    const avail = ($('gacha-chart').clientWidth || 0) - padL - padR;
    const slot = Math.min(200, Math.max(baseW + baseGap, Math.floor(avail / Math.max(1, data.length))));
    const barW = Math.max(baseW, Math.round(slot * baseW / (baseW + baseGap)));
    const gap = slot - barW;
    const w = Math.max(padL + data.length * (barW + gap) + padR, 320);
    const max = Math.max(...data.map(d => d.n), 1);
    const maxS = Math.max(...data.map(d => d.ssr), 1);
    const y = v => h - padB - (v / max) * (h - padB - padT);
    const ys = v => h - padB - (v / maxS) * (h - padB - padT);
    const every = Math.max(1, Math.ceil((period === 'week' ? 84 : 72) / (barW + gap)));
    let labelYear = '';
    // 주간 날짜(사용자 요청, 2026-11-19): 달마다 1주를 먼저 적고(n월 1주), 1월은 1주 대신 '26년 1월'.
    // 앞 날짜와 64px 안쪽이면 건너뛰고, 맨 끝 주는 자리가 있으면 '11월 3주'처럼 적는다.
    const weekLabels = new Map();
    if (period === 'week') {
      const slotW = barW + gap, minGap = 64;
      let lastX = -Infinity;
      data.forEach((d, i) => {
        const wk = weekOf(d.k);
        if (wk.n !== 1 || i * slotW - lastX < minGap) return;
        weekLabels.set(i, wk.m === 1 ? `${wk.y.slice(2)}년 1월` : `${wk.m}월 1주`);
        lastX = i * slotW;
      });
      const li = data.length - 1;
      if (li >= 0 && !weekLabels.has(li) && li * slotW - lastX >= minGap) weekLabels.set(li, keyLabel(data[li].k, false));
    }
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="기간별 획득">`;
    for (const t of [0, Math.round(max / 4), Math.round(max / 2), Math.round(max * 3 / 4), max]) {
      svg += `<line x1="${padL}" x2="${w - padR + 8}" y1="${y(t)}" y2="${y(t)}" class="gc-grid"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" class="gc-axis">${fmt.format(t)}</text>`;
    }
    data.forEach((d, i) => {
      const x = padL + i * (barW + gap) + 4;
      svg += `<rect x="${x - gap / 2}" y="${padT - 6}" width="${barW + gap}" height="${h - padB - padT + 6}" class="gc-hit" data-i="${i}"/>`;
      svg += stackBar(d, order, x, barW, y, `gt${i}`);
      if (d.ssr) svg += `<circle cx="${x + barW / 2}" cy="${ys(d.ssr)}" r="${period === 'week' ? 3.5 : 4.5}" class="gc-ssr"/>`;
      // 마지막 칸 날짜는 늘 적고, 바로 앞 눈금 날짜와 겹치면 앞의 것을 뺀다
      const last = i === data.length - 1;
      if (period === 'week') {
        if (weekLabels.has(i)) svg += `<text x="${x + barW / 2}" y="${h - 9}" text-anchor="middle" class="gc-axis">${weekLabels.get(i)}</text>`;
      } else if ((i % every === 0 && data.length - 1 - i >= every) || last) {
        const yr = d.k.slice(0, 4);
        svg += `<text x="${x + barW / 2}" y="${h - 9}" text-anchor="middle" class="gc-axis">${keyLabel(d.k, yr !== labelYear)}</text>`;
        labelYear = yr;
      }
    });
    $('gacha-chart').innerHTML = `<div class="gacha-chart-scroll">${svg}</svg></div><div class="gacha-tip" hidden></div><div class="gacha-legend">`
      + order.map(t => `<span class="${TYPES[t].cls}">${TYPES[t].label}</span>`).join('')
      + '<span class="is-ssr">모집 SSR</span></div>';
    scrollChartEnd();
  }
  function chartTipHtml(d) {
    const rows = d.order.filter(t => d[t]).map(t =>
      `<div class="gt-row"><span class="gacha-legend-dot ${TYPES[t].cls}"></span><span>${TYPES[t].label}</span><b>${fmt.format(d[t])}${unitOf(t)}</b></div>`).join('');
    return `<div class="gt-title">${keyTitle(d.k)}</div>${rows || '<div class="gt-row"><span></span><span>기록 없음</span><b></b></div>'}`
      + (d.n ? `<div class="gt-row gt-sum"><span></span><span>획득 니케</span><b>${fmt.format(d.n)}명</b></div>`
        + `<div class="gt-row"><span></span><span>10연차</span><b>${fmt.format(d.tens)}회</b></div>`
        + `<div class="gt-row"><span class="gacha-legend-dot is-ssr"></span><span>모집 SSR</span><b>${fmt.format(d.ssr)}명</b></div>` : '');
  }
  // 막대 툴팁(기간별 · 시간대별 공통): box 안의 .gc-hit 칸에 올리면 getD(번호)의 내역을 html 로 보인다
  function setupTip(box, getD, html) {
    let cur = null;
    const hide = () => {
      const tip = box.querySelector('.gacha-tip');
      if (tip) tip.hidden = true;
      if (cur) cur.classList.remove('is-on');
      cur = null;
    };
    const showAt = (hit, ev) => {
      const d = getD(Number(hit.dataset.i));
      const tip = box.querySelector('.gacha-tip');
      if (!d || !tip) return;
      if (cur !== hit) {
        if (cur) cur.classList.remove('is-on');
        cur = hit;
        hit.classList.add('is-on');
        tip.innerHTML = html(d);
      }
      tip.hidden = false;
      const r = box.getBoundingClientRect();
      const hr = hit.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = hr.left - r.left + hr.width + 10;
      if (left + tw > r.width) left = hr.left - r.left - tw - 10;
      left = Math.max(0, Math.min(left, r.width - tw));
      let top = (ev ? ev.clientY - r.top : hr.top - r.top) - th / 2;
      top = Math.max(0, Math.min(top, r.height - th));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    };
    const onPoint = e => {
      const hit = e.target.closest && e.target.closest('.gc-hit');
      if (hit) showAt(hit, e); else hide();
    };
    box.addEventListener('pointermove', onPoint);
    box.addEventListener('pointerdown', onPoint);   // 폰: 누르면 보인다
    box.addEventListener('pointerleave', hide);
    box.addEventListener('scroll', hide, true);
  }
  // 폭이 모자라 가로로 밀릴 때는 최근 달이 보이게 오른쪽 끝에서 시작한다
  function scrollChartEnd() {
    const box = document.querySelector('#gacha-chart .gacha-chart-scroll');
    if (!box) return;
    box.classList.toggle('can-drag', box.scrollWidth > box.clientWidth + 1);
    box.scrollLeft = box.scrollWidth;
    requestAnimationFrame(() => { box.scrollLeft = box.scrollWidth; });
  }
  // 마우스로 차트를 잡아 끌면 좌우로 움직인다(사용자 요청, 2026-11-19). 4px 넘게 움직여야 끌기로 본다(그냥 누름은 툴팁).
  // 폰 · 터치는 원래 손가락으로 밀리므로 마우스만 다룬다.
  function setupDrag(box) {
    let sc = null, sx = 0, sl = 0, id = null, moved = false;
    box.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      const s = e.target.closest && e.target.closest('.gacha-chart-scroll');
      if (!s || s.scrollWidth <= s.clientWidth + 1) return;
      sc = s; sx = e.clientX; sl = s.scrollLeft; id = e.pointerId; moved = false;
    });
    box.addEventListener('pointermove', e => {
      if (!sc || e.pointerId !== id) return;
      const dx = e.clientX - sx;
      if (!moved) {
        if (Math.abs(dx) < 4) return;
        moved = true;
        sc.setPointerCapture(id);
        sc.classList.add('is-dragging');
      }
      sc.scrollLeft = sl - dx;
      e.preventDefault();
    });
    const end = () => {
      if (!sc) return;
      sc.classList.remove('is-dragging');
      try { sc.releasePointerCapture(id); } catch (err) { /* 무시 */ }
      sc = null;
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  function setStatus(msg, kind) {
    const el = $('gacha-status');
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }

  // 기록이 있으면 가져오기 판을 한 줄로 접는다
  function setImportOpen(open) {
    $('gacha-import').classList.toggle('is-collapsed', !open);
    $('gacha-reimport').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function show(data) {
    state = build(data);
    shown = PAGE;
    drawn = new Set();
    $('gacha-result').hidden = false;
    $('gacha-loaded').hidden = false;
    setImportOpen(false);
    applyPickup();
    render();
    setStatus('');
    // 픽업 기록(사이트 데이터)이 늦게 오면 그때 골드 마일리지 · 픽업 획득을 다시 계산한다
    if (!APP_DATA.ready) onAppDataReady(() => { if (!state) return; applyPickup(); drawn = new Set(); render(); });
  }

  async function loadFile(file) {
    if (!file) return;
    setStatus('읽는 중…');
    try {
      const raw = await fileToNkt(file);
      const data = parse(raw);
      await loadNames();
      show(data);
      setStatus(`${fmt.format(state.pulls.length)}건 읽음`, 'ok');
      try { localStorage.setItem(STORE_KEY, await packForSave(raw)); } catch (e) { /* 저장 못 해도 보기는 된다 */ }
    } catch (e) {
      setStatus(e && e.message ? e.message : '기록 파일을 읽지 못했습니다.', 'error');
    }
  }

  // 파일이 여러 개 오면 이름이 NKSD_TRIGGER 로 시작하는 것 중 가장 최근 것
  function pickFile(list) {
    const files = [...(list || [])];
    const nk = files.filter(f => /^NKSD_TRIGGER/i.test(f.name));
    return (nk.length ? nk : files).sort((a, b) => b.lastModified - a.lastModified)[0];
  }

  async function loadSaved(text) {
    try {
      const [data] = await Promise.all([unpackSaved(text).then(parse), loadNames()]);
      show(data);
    } catch (e) {
      setStatus('저장해 둔 기록을 읽지 못했습니다. 파일을 다시 넣어 주세요.', 'error');
    }
  }

  function start() {
    if (started) return;
    started = true;
    loadNames();
    let saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { /* 무시 */ }
    if (saved) loadSaved(saved);
  }

  const hasFiles = e => !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
  const VIEW_KEY = 'mmr-gacha-view';
  let view = 'summary';
  try { const v = localStorage.getItem(VIEW_KEY); if (['summary', 'pickup', 'first', 'nikke', 'history'].includes(v)) view = v; } catch (e) { /* 무시 */ }

  document.addEventListener('DOMContentLoaded', () => {
    const tab = $('tab-gacha');
    if (!tab) return;
    $('gacha-dir').textContent = NIKKE_DIR;
    $('gacha-copy-dir').addEventListener('click', async () => {
      const btn = $('gacha-copy-dir');
      try { await navigator.clipboard.writeText(NIKKE_DIR); btn.textContent = '복사됨'; }
      catch (e) {
        const r = document.createRange();
        r.selectNodeContents($('gacha-dir'));
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        btn.textContent = 'Ctrl+C';
      }
      setTimeout(() => { btn.textContent = '주소 복사'; }, 2000);
    });
    const input = $('gacha-file');
    input.addEventListener('change', () => { loadFile(pickFile(input.files)); input.value = ''; });
    // 끌어다 놓기: 탭 어디에 놓아도 받는다(엉뚱한 곳에 놓아 브라우저가 파일을 열어 버리지 않게)
    const drop = $('gacha-drop');
    let depth = 0;
    tab.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; drop.classList.add('is-over'); tab.classList.add('is-dragging'); } });
    tab.addEventListener('dragleave', e => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) { drop.classList.remove('is-over'); tab.classList.remove('is-dragging'); } } });
    tab.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    tab.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      drop.classList.remove('is-over');
      tab.classList.remove('is-dragging');
      loadFile(pickFile(e.dataTransfer.files));
    });
    $('gacha-reimport').addEventListener('click', () => setImportOpen($('gacha-import').classList.contains('is-collapsed')));
    $('gacha-clear').addEventListener('click', () => {
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 무시 */ }
      state = null;
      $('gacha-result').hidden = true;
      $('gacha-loaded').hidden = true;
      setImportOpen(true);
      setStatus('지웠습니다.');
    });
    document.querySelectorAll('#gacha-views [data-view]').forEach(b => b.addEventListener('click', () => {
      view = b.dataset.view;
      try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* 무시 */ }
      if (state) renderView();
    }));
    $('gacha-rare').addEventListener('change', () => { if (state) renderNikke(); });
    $('gacha-first-rare').addEventListener('change', () => { if (state) renderFirst(); });
    // 창 폭이 바뀌면 막대 폭을 다시 맞춘다(요약을 보고 있을 때만)
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state || !tab.classList.contains('active')) return;
        if (view === 'summary') { drawHours(); drawChart(); } else fitMarquees(document.querySelector(`.gacha-view[data-view="${view}"]`));
      }, 200);
    });
    document.querySelectorAll('#gacha-period [data-period]').forEach(b => b.addEventListener('click', () => {
      period = b.dataset.period;
      try { localStorage.setItem(PERIOD_KEY, period); } catch (e) { /* 무시 */ }
      if (state) drawChart();
    }));
    $('gacha-first-order').addEventListener('click', () => {
      firstOldest = !firstOldest;
      try { localStorage.setItem(FIRST_ORDER_KEY, firstOldest ? '1' : '0'); } catch (e) { /* 무시 */ }
      if (state) renderFirst();
    });
    setupTip($('gacha-chart'), i => chartData[i], chartTipHtml);
    setupTip($('gacha-hours-chart'), i => hourData[i], hourTipHtml);
    setupDrag($('gacha-chart'));
    ['gacha-first-rare', 'gacha-rare', 'gacha-type'].forEach(id => mmrDropdown($(id)));   // common.js
    // 오른쪽 판 높이가 바뀌면(글꼴이 늦게 오거나 폭이 바뀌어 줄이 넘어갈 때) 차트 높이를 다시 맞춘다
    if (window.ResizeObserver) {
      let sideH = 0, raf = 0;
      new ResizeObserver(([e]) => {
        const hgt = Math.round(e.contentRect.height);
        if (!hgt || hgt === sideH) return;
        sideH = hgt;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { if (state && view === 'summary' && drawn.has('summary')) drawChart(); });
      }).observe(document.querySelector('.gacha-side'));
    }
    const reBatch = () => { if (state) { shown = PAGE; renderBatches(); } };
    $('gacha-only-ssr').addEventListener('change', reBatch);
    $('gacha-type').addEventListener('change', reBatch);
    $('gacha-more').addEventListener('click', () => { shown += 60; renderBatches(); });
    if (tab.classList.contains('active')) start();
  });

  document.addEventListener('mmr:tab-change', e => {
    if (!(e.detail && e.detail.tab === 'gacha')) return;
    start();
    // 다른 탭에 있는 동안 그려졌으면 높이를 못 쟀으니 다시 그린다
    if (state && view === 'summary' && drawn.has('summary')) requestAnimationFrame(() => { drawHours(); drawChart(); });
    else if (state && drawn.has(view)) setTimeout(() => fitMarquees(document.querySelector(`.gacha-view[data-view="${view}"]`)), 0);
  });
})();
