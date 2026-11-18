// ===== 가챠 트래커 (베타, 사용자 요청 2026-11-18) =====
// 방식은 추출 프로그램 세션이 정리한 것(Desktop\Claude\니케_가챠트래커\정보모음_연동메모.md)을 그대로 옮겼다.
// - 출처: PC판 계정 사건 기록 %USERPROFILE%\AppData\LocalLow\com_proximabeta\NIKKE\NKSD_TRIGGER_<계정>(zip/trigger.txt).
//   종류 18 줄 = 니케 1장 획득. 니케에는 모집 기록 웹 주소·토큰이 없어서 이 파일이 유일한 출처다.
// - 사용자는 PowerShell 한 줄(GACHA_COMMAND)을 실행 -> 클립보드의 base64(gzip("NKT1\n" + "seq,니케번호,횟수,틱\n"×N))를 붙여넣는다.
// - 브라우저 안에서만 푼다. 서버로 보내지 않고, 붙여넣은 글자는 이 브라우저 localStorage 에만 둔다.
// - 배너 정보는 기록에 없다. 1초 안에 들어온 줄 = 한 묶음, 10장 묶음 = 10연차.
// - 니케 번호 -> 이름·등급은 게임 파일에 없어서 data/gacha-names.json(blablalink 기반)에서 읽는다. 없는 번호는 '#번호'.
(function () {
  const GACHA_COMMAND = "$d=Join-Path $env:USERPROFILE 'AppData\\LocalLow\\com_proximabeta\\NIKKE';$f=Get-ChildItem (Join-Path $d 'NKSD_TRIGGER_*') -EA 0|Sort-Object LastWriteTime -Desc|Select-Object -First 1;if(!$f){Write-Host 'NIKKE 기록 파일을 찾지 못했습니다. PC판에 로그인한 적이 있는지 확인하세요.' -F Yellow}else{$c=Join-Path $env:TEMP ('nkt_'+[guid]::NewGuid().ToString('N')+'.zip');Copy-Item $f.FullName $c -Force;Add-Type -A System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead($c);$r=New-Object IO.StreamReader($z.GetEntry('trigger.txt').Open());$o=New-Object Text.StringBuilder;[void]$o.Append(\"NKT1`n\");$n=0;while($null -ne ($l=$r.ReadLine())){$p=$l.Split(',');if($p.Count -ge 6 -and $p[2] -eq '18'){[void]$o.Append($p[1]+','+$p[3]+','+$p[4]+','+$p[5]+\"`n\");$n++}};$r.Close();$z.Dispose();Remove-Item $c -Force;$b=[Text.Encoding]::UTF8.GetBytes($o.ToString());$m=New-Object IO.MemoryStream;$g=New-Object IO.Compression.GZipStream($m,[IO.Compression.CompressionMode]::Compress);$g.Write($b,0,$b.Length);$g.Close();Set-Clipboard ([Convert]::ToBase64String($m.ToArray()));Write-Host \"모집 기록 $n 건을 클립보드에 복사했습니다. 사이트 입력칸에 붙여넣으세요.\" -F Green}";
  const NAMES_URL = 'data/gacha-names.json?v=1';
  const STORE_KEY = 'mmr-gacha-data';
  const TICKS_EPOCH = 621355968000000000n;   // 0001-01-01 -> 1970-01-01 (.NET 틱)
  const BATCH_TICKS = 10000000n;             // 1초
  const PAGE = 40;

  const $ = id => document.getElementById(id);
  const fmt = new Intl.NumberFormat('ko-KR');
  // 게임 일정처럼 한국시간으로 고정해서 보인다(사이트 공통 규칙)
  const dtf = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const dayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
  const monthKey = d => {
    const p = Object.fromEntries(dayFmt.formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}`;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let names = null;          // { "3001": ["라피", "SR"] }
  let namesReq = null;
  let state = null;          // { pulls, batches }
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
  const tag = (code, extra = '') => { const i = info(code); return `<span class="gacha-tag is-${i.rare}">${esc(i.name)}${extra}</span>`; };

  // 붙여넣은 글자 풀기: base64 -> gzip 풀기 -> 'NKT1' + 줄마다 seq,code,count,ticks
  async function decode(text) {
    const clean = String(text || '').replace(/\s+/g, '');
    if (!clean) throw new Error('붙여넣은 내용이 없습니다.');
    let bytes;
    try { bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0)); }
    catch (e) { throw new Error('기록 글자가 아닙니다. 명령을 실행한 뒤 바로 붙여넣어 주세요.'); }
    let raw;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      raw = await new Response(stream).text();
    } catch (e) { throw new Error('기록 글자가 잘렸거나 다른 내용입니다. 명령을 다시 실행해 주세요.'); }
    const lines = raw.split('\n');
    if (lines[0].trim() !== 'NKT1') throw new Error('알 수 없는 형식입니다. 위의 최신 명령을 써 주세요.');
    const seen = new Set();
    const pulls = [];
    for (const line of lines.slice(1)) {
      const p = line.trim().split(',');
      if (p.length < 4 || !/^\d+$/.test(p[3]) || seen.has(p[0])) continue;   // seq 로 중복 제거
      seen.add(p[0]);
      const ticks = BigInt(p[3]);
      pulls.push({ seq: p[0], code: p[1], count: Math.max(1, Number(p[2]) || 1), ticks, time: new Date(Number((ticks - TICKS_EPOCH) / 10000n)) });
    }
    if (!pulls.length) throw new Error('모집 기록이 0건입니다.');
    return pulls;
  }

  function group(pulls) {
    pulls.sort((a, b) => (a.ticks < b.ticks ? -1 : a.ticks > b.ticks ? 1 : 0));
    const batches = [];
    let cur = null;
    for (const p of pulls) {
      if (!cur || p.ticks - cur.last > BATCH_TICKS) { cur = { time: p.time, last: p.ticks, items: [] }; batches.push(cur); }
      cur.items.push(p);
      cur.last = p.ticks;
    }
    for (const b of batches) {
      b.size = b.items.reduce((s, p) => s + p.count, 0);
      b.ssr = b.items.some(p => info(p.code).rare === 'SSR');
    }
    return batches;
  }

  function render() {
    const { pulls, batches } = state;
    const total = pulls.reduce((s, p) => s + p.count, 0);
    const tens = batches.filter(b => b.size === 10);
    const tenSSR = tens.reduce((s, b) => s + b.items.filter(p => info(p.code).rare === 'SSR').length, 0);
    // 얻은 순서대로 펼쳐 SSR 사이 간격을 잰다
    const ssrRows = [];
    let since = 0;
    for (const p of pulls) {
      for (let i = 0; i < Math.min(p.count, 300); i++) {
        since++;
        if (info(p.code).rare === 'SSR') { ssrRows.push({ p, gap: since }); since = 0; }
      }
    }
    const unknown = new Set(pulls.filter(p => !(names && names[p.code])).map(p => p.code));
    $('gacha-range').innerHTML = `<span>${dtf.format(pulls[0].time)} ~ ${dtf.format(pulls[pulls.length - 1].time)}</span>`
      + (unknown.size ? `<span class="gacha-warn">이름 미등록 ${unknown.size}종</span>` : '');

    const rate = tens.length ? (tenSSR / (tens.length * 10) * 100).toFixed(2) : '-';
    const stats = [
      ['얻은 니케', fmt.format(total), '장'],
      ['10연차', fmt.format(tens.length), '회'],
      ['SSR', fmt.format(ssrRows.length), '장', 'is-ssr'],
      ['10연차 SSR 비율', rate, '%'],
      ['마지막 SSR 이후', fmt.format(since), '장'],
    ];
    $('gacha-stats').innerHTML = stats.map(([k, v, u, cls]) =>
      `<div class="gacha-stat ${cls || ''}"><span>${k}</span><b>${v}<small>${u}</small></b></div>`).join('');

    drawChart(pulls);

    $('gacha-ssr-body').innerHTML = ssrRows.slice().reverse().map(({ p, gap }) =>
      `<tr><td>${dtf.format(p.time)}</td><td>${tag(p.code)}</td><td class="num gacha-gap">${fmt.format(gap)}</td></tr>`).join('')
      || '<tr><td colspan="3" class="gacha-empty">SSR 기록 없음</td></tr>';

    renderNikke();
    renderBatches();
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
      .map(r => `<tr><td>${tag(r.code)}</td><td class="num">${fmt.format(r.n)}</td><td class="num">${dayFmt.format(r.first)}</td></tr>`)
      .join('') || '<tr><td colspan="3" class="gacha-empty">없음</td></tr>';
  }

  function renderBatches() {
    const onlySSR = $('gacha-only-ssr').checked;
    const list = state.batches.slice().reverse().filter(b => !onlySSR || b.ssr);
    $('gacha-batch-body').innerHTML = list.slice(0, shown).map(b =>
      `<tr${b.ssr ? ' class="has-ssr"' : ''}><td>${dtf.format(b.time)}</td><td class="num">${b.size}</td><td>${b.items.map(p => tag(p.code, p.count > 1 ? ' ×' + p.count : '')).join('')}</td></tr>`).join('')
      || '<tr><td colspan="3" class="gacha-empty">없음</td></tr>';
    $('gacha-more').hidden = list.length <= shown;
  }

  function drawChart(pulls) {
    const months = new Map();
    for (const p of pulls) {
      const k = monthKey(p.time);
      const m = months.get(k) || { n: 0, ssr: 0 };
      m.n += p.count;
      if (info(p.code).rare === 'SSR') m.ssr += p.count;
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
      svg += `<rect x="${x}" y="${y(d.n)}" width="${barW}" height="${h - padB - y(d.n)}" class="gc-bar"><title>${d.k} · ${fmt.format(d.n)}장 · SSR ${d.ssr}</title></rect>`;
      if (d.ssr) svg += `<circle cx="${x + barW / 2}" cy="${ys(d.ssr)}" r="3.5" class="gc-ssr"/>`;
      if (i % 3 === 0 || i === data.length - 1) svg += `<text x="${x + barW / 2}" y="${h - 8}" text-anchor="middle" class="gc-axis">${d.k.slice(2).replace('-', '.')}</text>`;
    });
    $('gacha-chart').innerHTML = svg + '</svg>'
      + '<div class="gacha-legend"><span class="is-bar">장수</span><span class="is-ssr">SSR</span></div>';
  }

  function setStatus(msg, kind) {
    const el = $('gacha-status');
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }

  async function load(text, remember) {
    setStatus('읽는 중…');
    try {
      const [pulls] = await Promise.all([decode(text), loadNames()]);
      state = { pulls, batches: group(pulls) };
      shown = PAGE;
      $('gacha-result').hidden = false;
      render();
      setStatus(`${fmt.format(pulls.length)}건`, 'ok');
      if (remember) { try { localStorage.setItem(STORE_KEY, String(text).replace(/\s+/g, '')); } catch (e) { /* 저장 못 해도 보기는 된다 */ } }
    } catch (e) {
      setStatus(e.message, 'error');
    }
  }

  function start() {
    if (started) return;
    started = true;
    loadNames();
    let saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { /* 무시 */ }
    if (saved) load(saved, false);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('tab-gacha')) return;
    $('gacha-cmd').textContent = GACHA_COMMAND;
    $('gacha-copy-cmd').addEventListener('click', async () => {
      const btn = $('gacha-copy-cmd');
      try { await navigator.clipboard.writeText(GACHA_COMMAND); btn.textContent = '복사됨'; }
      catch (e) {
        const r = document.createRange();
        r.selectNodeContents($('gacha-cmd'));
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        btn.textContent = 'Ctrl+C';
      }
      setTimeout(() => { btn.textContent = '명령 복사'; }, 2000);
    });
    $('gacha-load').addEventListener('click', () => load($('gacha-paste').value, true));
    $('gacha-paste').addEventListener('paste', () => setTimeout(() => load($('gacha-paste').value, true), 0));
    $('gacha-clear').addEventListener('click', () => {
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 무시 */ }
      $('gacha-paste').value = '';
      state = null;
      $('gacha-result').hidden = true;
      setStatus('지웠습니다.');
    });
    $('gacha-rare').addEventListener('change', () => { if (state) renderNikke(); });
    $('gacha-only-ssr').addEventListener('change', () => { if (state) { shown = PAGE; renderBatches(); } });
    $('gacha-more').addEventListener('click', () => { shown += 60; renderBatches(); });
    if ($('tab-gacha').classList.contains('active')) start();
  });

  document.addEventListener('mmr:tab-change', e => { if (e.detail && e.detail.tab === 'gacha') start(); });
})();
