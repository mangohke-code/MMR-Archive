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
//   69 있음 = 일반 모집 / 13 만 = 일반 외 모집(픽업 등, 어느 배너인지는 기록에 없음) / 13 없음 = 모집 외 획득(선택 상자·출석·교환 등).
//   모집 외 획득은 SSR 통계(장수·간격·마지막 SSR 이후)에서 뺀다. 실버 마일리지 교환분은 기록 자체에 없다.
// - 니케 번호 -> 이름·등급은 게임 파일에 없어서 data/gacha-names.json(blablalink 기반)에서 읽는다. 없는 번호는 '#번호'.
(function () {
  const NIKKE_DIR = '%USERPROFILE%\\AppData\\LocalLow\\com_proximabeta\\NIKKE';
  const MAX_FILE = 200 * 1024 * 1024;
  const NAMES_URL = 'data/gacha-names.json?v=1';
  const STORE_KEY = 'mmr-gacha-data';
  const TICKS_EPOCH = 621355968000000000n;   // 0001-01-01 -> 1970-01-01 (.NET 틱)
  const BATCH_TICKS = 10000000n;             // 1초
  const MATCH_TICKS = 30000000n;             // 3초
  const PAGE = 40;
  const TYPES = {
    normal: { label: '일반', cls: 'is-normal' },
    special: { label: '픽업 등', cls: 'is-special' },
    other: { label: '모집 외', cls: 'is-other' },
    unknown: { label: '구분 없음', cls: 'is-unknown' },
  };
  const isGacha = t => t !== 'other';

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
  const typeChip = t => `<span class="gacha-type ${TYPES[t].cls}">${TYPES[t].label}</span>`;

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

  function render() {
    const { pulls, batches, classified } = state;
    const sum = list => list.reduce((s, p) => s + p.count, 0);
    const total = sum(pulls);
    const gachaPulls = pulls.filter(p => isGacha(p.type));
    const tens = batches.filter(b => isGacha(b.type) && b.size === 10);
    const tenSSR = tens.reduce((s, b) => s + b.items.filter(isSSR).length, 0);

    // SSR 사이 간격은 모집으로 얻은 장수로만 잰다(모집 외 획득은 건너뛴다)
    const ssrRows = [];
    let since = 0;
    for (const p of pulls) {
      const gachaP = isGacha(p.type);
      for (let i = 0; i < Math.min(p.count, 300); i++) {
        if (gachaP) since++;
        if (isSSR(p)) { ssrRows.push({ p, gap: gachaP ? since : null }); if (gachaP) since = 0; }
      }
    }
    const ssrGacha = ssrRows.filter(r => r.gap !== null).length;

    const unknown = new Set(pulls.filter(p => !(names && names[p.code])).map(p => p.code));
    $('gacha-range').innerHTML = `<span>${dtf.format(pulls[0].time)} ~ ${dtf.format(pulls[pulls.length - 1].time)}</span>`
      + (unknown.size ? `<span class="gacha-warn">이름 미등록 ${unknown.size}종</span>` : '')
      + (classified ? '' : '<span class="gacha-warn">예전 명령 기록 · 모집 구분 없음</span>');

    const byType = t => sum(pulls.filter(p => p.type === t));
    const rate = tens.length ? (tenSSR / (tens.length * 10) * 100).toFixed(2) : '-';
    const stats = [
      ['얻은 니케', fmt.format(total), '장', '', classified ? `모집 외 ${fmt.format(byType('other'))}장` : ''],
      ['모집', fmt.format(sum(gachaPulls)), '장', '', classified ? `일반 ${fmt.format(byType('normal'))} · 픽업 등 ${fmt.format(byType('special'))}` : ''],
      ['10연차', fmt.format(tens.length), '회'],
      ['SSR', fmt.format(ssrGacha), '장', 'is-ssr', classified ? `모집 외 ${fmt.format(ssrRows.length - ssrGacha)}장 제외` : ''],
      ['10연차 SSR 비율', rate, '%'],
      ['마지막 SSR 이후', fmt.format(since), '장'],
    ];
    $('gacha-stats').innerHTML = stats.map(([k, v, u, cls, sub]) =>
      `<div class="gacha-stat ${cls || ''}"><span>${k}</span><b>${v}<small>${u}</small></b>${sub ? `<i>${sub}</i>` : ''}</div>`).join('');

    renderTypes();
    drawChart();

    $('gacha-ssr-body').innerHTML = ssrRows.slice().reverse().map(({ p, gap }) =>
      `<tr><td>${dtf.format(p.time)}</td><td>${tag(p)}</td><td>${typeChip(p.type)}</td>`
      + `<td class="num gacha-gap">${gap === null ? '-' : fmt.format(gap)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="gacha-empty">SSR 기록 없음</td></tr>';

    renderNikke();
    renderBatches();
  }

  // 모집 종류별 표(구분된 기록일 때만)
  function renderTypes() {
    const card = $('gacha-types');
    if (!state.classified) { card.hidden = true; return; }
    card.hidden = false;
    $('gacha-types-body').innerHTML = ['normal', 'special', 'other'].map(t => {
      const bs = state.batches.filter(b => b.type === t);
      const n = bs.reduce((s, b) => s + b.size, 0);
      const ssr = bs.reduce((s, b) => s + b.items.filter(isSSR).reduce((x, p) => x + p.count, 0), 0);
      const tens = isGacha(t) ? bs.filter(b => b.size === 10).length : null;
      return `<tr><td>${typeChip(t)}</td><td class="num">${fmt.format(n)}</td>`
        + `<td class="num">${tens === null ? '-' : fmt.format(tens)}</td><td class="num">${fmt.format(ssr)}</td>`
        + `<td class="num">${isGacha(t) && n ? (ssr / n * 100).toFixed(2) + '%' : '-'}</td></tr>`;
    }).join('');
  }

  function renderNikke() {
    const per = new Map();
    for (const p of state.pulls) {
      const row = per.get(p.code) || { code: p.code, n: 0, first: p.time };
      row.n += p.count;
      per.set(p.code, row);
    }
    const rare = $('gacha-rare').value;
    $('gacha-nikke-body').innerHTML = [...per.values()]
      .filter(r => !rare || info(r.code).rare === rare)
      .sort((a, b) => b.n - a.n)
      .map(r => `<tr><td>${tag({ code: r.code })}</td><td class="num">${fmt.format(r.n)}</td><td class="num">${dayFmt.format(r.first)}</td></tr>`)
      .join('') || '<tr><td colspan="3" class="gacha-empty">없음</td></tr>';
  }

  function renderBatches() {
    const onlySSR = $('gacha-only-ssr').checked;
    const type = $('gacha-type').value;
    const list = state.batches.slice().reverse().filter(b => (!onlySSR || b.ssr) && (!type || b.type === type));
    $('gacha-batch-body').innerHTML = list.slice(0, shown).map(b =>
      `<tr${b.ssr ? ' class="has-ssr"' : ''}><td>${dtf.format(b.time)}</td><td>${typeChip(b.type)}</td><td class="num">${b.size}</td>`
      + `<td>${b.items.map(p => tag(p, p.count > 1 ? ' ×' + p.count : '')).join('')}</td></tr>`).join('')
      || '<tr><td colspan="4" class="gacha-empty">없음</td></tr>';
    $('gacha-more').hidden = list.length <= shown;
  }

  // 월별 막대: 일반 · 픽업 등 · 모집 외를 쌓는다. 금색 점 = 그 달 모집 SSR 장수
  function drawChart() {
    const order = state.classified ? ['normal', 'special', 'other'] : ['unknown'];
    const months = new Map();
    for (const p of state.pulls) {
      const k = monthKey(p.time);
      const m = months.get(k) || { n: 0, ssr: 0, normal: 0, special: 0, other: 0, unknown: 0 };
      m.n += p.count;
      m[p.type] += p.count;
      if (isGacha(p.type) && isSSR(p)) m.ssr += p.count;
      months.set(k, m);
    }
    const data = [...months.keys()].sort().map(k => ({ k, ...months.get(k) }));
    const barW = 18, gap = 6, padL = 44, padB = 26, h = 210;
    const w = Math.max(padL + data.length * (barW + gap) + 10, 320);
    const max = Math.max(...data.map(d => d.n), 1);
    const maxS = Math.max(...data.map(d => d.ssr), 1);
    const y = v => h - padB - (v / max) * (h - padB - 14);
    const ys = v => h - padB - (v / maxS) * (h - padB - 14);
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="월별 획득 장수">`;
    for (const t of [0, Math.round(max / 2), max]) {
      svg += `<line x1="${padL}" x2="${w - 4}" y1="${y(t)}" y2="${y(t)}" class="gc-grid"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" class="gc-axis">${fmt.format(t)}</text>`;
    }
    data.forEach((d, i) => {
      const x = padL + i * (barW + gap) + 4;
      let acc = 0;
      for (const t of order) {
        if (!d[t]) continue;
        const top = y(acc + d[t]);
        svg += `<rect x="${x}" y="${top}" width="${barW}" height="${y(acc) - top}" class="gc-bar ${TYPES[t].cls}"/>`;
        acc += d[t];
      }
      const tip = order.filter(t => d[t]).map(t => `${TYPES[t].label} ${fmt.format(d[t])}`).join(' · ');
      svg += `<rect x="${x}" y="${y(d.n)}" width="${barW}" height="${h - padB - y(d.n)}" fill="transparent"><title>${d.k} · ${tip} · 모집 SSR ${d.ssr}</title></rect>`;
      if (d.ssr) svg += `<circle cx="${x + barW / 2}" cy="${ys(d.ssr)}" r="3.5" class="gc-ssr"/>`;
      if (i % 3 === 0 || i === data.length - 1) svg += `<text x="${x + barW / 2}" y="${h - 8}" text-anchor="middle" class="gc-axis">${d.k.slice(2).replace('-', '.')}</text>`;
    });
    $('gacha-chart').innerHTML = svg + '</svg><div class="gacha-legend">'
      + order.map(t => `<span class="${TYPES[t].cls}">${TYPES[t].label}</span>`).join('')
      + '<span class="is-ssr">모집 SSR</span></div>';
    // 폭이 모자라 가로로 밀릴 때는 최근 달이 보이게 오른쪽 끝에서 시작한다
    const box = $('gacha-chart');
    requestAnimationFrame(() => { box.scrollLeft = box.scrollWidth; });
  }

  function setStatus(msg, kind) {
    const el = $('gacha-status');
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }

  function show(data) {
    state = build(data);
    shown = PAGE;
    $('gacha-result').hidden = false;
    render();
    setStatus(`${fmt.format(state.pulls.length)}건`, 'ok');
  }

  async function loadFile(file) {
    if (!file) return;
    setStatus('읽는 중…');
    try {
      const raw = await fileToNkt(file);
      const data = parse(raw);
      await loadNames();
      show(data);
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
    tab.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; drop.classList.add('is-over'); } });
    tab.addEventListener('dragleave', e => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('is-over'); } });
    tab.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    tab.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      drop.classList.remove('is-over');
      loadFile(pickFile(e.dataTransfer.files));
    });
    $('gacha-clear').addEventListener('click', () => {
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 무시 */ }
      state = null;
      $('gacha-result').hidden = true;
      setStatus('지웠습니다.');
    });
    $('gacha-rare').addEventListener('change', () => { if (state) renderNikke(); });
    const reBatch = () => { if (state) { shown = PAGE; renderBatches(); } };
    $('gacha-only-ssr').addEventListener('change', reBatch);
    $('gacha-type').addEventListener('change', reBatch);
    $('gacha-more').addEventListener('click', () => { shown += 60; renderBatches(); });
    if (tab.classList.contains('active')) start();
  });

  document.addEventListener('mmr:tab-change', e => { if (e.detail && e.detail.tab === 'gacha') start(); });
})();
