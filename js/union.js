// ===== 유니온 일지 (베타, 사용자 요청 2026-11-19) =====
// - 출처: PC버전 계정 캐시 %USERPROFILE%\AppData\LocalLow\com_proximabeta\NIKKE\<서버>_<계정>.nkcache
//   평문 SQLite. 표 GuildChatModel(Id TEXT PK, CreatedAt BIGINT(.NET 틱, UTC), Usn BIGINT(글쓴이 번호), Message TEXT).
// - 게임은 최근 1,000줄(약 한 달)만 남기고 지운다. 넣을 때마다 Id 로 합쳐 IndexedDB 에 쌓아 기록이 사라지지 않게 한다.
// - 글쓴이 이름은 파일에 없다(번호만). 이름은 사용자가 붙이고 localStorage 에 둔다.
// - 서버로 보내지 않는다. 다른 유니온원의 채팅이 들어 있으니 브라우저 안에서만 읽고 보관한다.
// - SQLite 읽기는 sql.js(WASM)를 처음 파일을 넣을 때 cdnjs 에서 불러온다.
(function () {
  const NIKKE_DIR = '%USERPROFILE%\\AppData\\LocalLow\\com_proximabeta\\NIKKE';
  const SQL_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/';
  // CDN 파일이 바뀌면 실행하지 않는다(cdnjs 공개 SRI 값과 같음, 2026-11-23 확인)
  const SQL_SRI = 'sha512-n7swEtVCvXpQ7KxgpPyp0+DQQEf5vPpmzCRl14x2sp2v5LpCYCjrAx03mkBAbWwGF9eUoIk8YVcDFuJRIeYttg==';
  const TICKS_EPOCH = 621355968000000000n;   // 0001-01-01 -> 1970-01-01 (.NET 틱)
  const MAX_FILE = 100 * 1024 * 1024;
  const DB_NAME = 'mmr-union';
  const NAMES_KEY = 'mmr-union-names';       // { 계정: { 글쓴이 번호: 이름 } }
  const ACC_KEY = 'mmr-union-account';
  // 채팅의 ::sticker_0:: ~ ::sticker_7:: = 이모티콘(사용자 확인, 2026-11-19). 그림은 img/emote
  const EMOTES = ['hello', 'thanks', 'delight', 'kidkid', 'sad', 'anger', 'cheerup', 'suprise'];
  const PAGE = 300;

  const $ = id => document.getElementById(id);
  const fmt = new Intl.NumberFormat('ko-KR');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 사이트 공통 규칙: 한국시간으로 고정해서 보인다
  const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
  const parts = ms => Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const WEEK = { Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토', Sun: '일' };
  const dayStr = ms => { const p = parts(ms); return `${p.year}.${p.month}.${p.day}`; };
  const msOf = t => Number((BigInt(t) - TICKS_EPOCH) / 10000n);
  // 보안: 멤버 번호는 숫자만 받는다(남이 만든 백업 · 파일에 HTML 을 넣어 화면에서 실행시키는 것을 막음)
  const okRow = r => r && r.id && /^\d+$/.test(String(r.t)) && /^\d{1,20}$/.test(String(r.usn));
  const cmpT = (a, b) => (a.t.length - b.t.length) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0);   // 틱은 글자로 둔다(2^53 넘음)

  let account = null;        // 지금 보는 계정(파일 이름의 숫자_숫자)
  let rows = [];             // 지금 계정의 글 [{id, t, usn, msg}] (오래된 순)
  let names = {};
  let shown = PAGE;
  let started = false;
  try { names = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}') || {}; } catch (e) { names = {}; }

  // ===== 보관(IndexedDB): 저장소 chat, 키 = 계정|글 번호 =====
  let dbReq = null;
  function db() {
    if (!dbReq) {
      dbReq = new Promise((res, rej) => {
        if (!window.indexedDB) { rej(new Error('이 브라우저는 기록 보관(IndexedDB)을 지원하지 않습니다.')); return; }
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => {
          const s = r.result.createObjectStore('chat', { keyPath: 'k' });
          s.createIndex('acc', 'acc');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error || new Error('기록 보관소를 열지 못했습니다.'));
      });
    }
    return dbReq;
  }
  const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });
  async function loadAccount(acc) {
    const d = await db();
    return new Promise((res, rej) => {
      const r = d.transaction('chat').objectStore('chat').index('acc').getAll(acc);
      r.onsuccess = () => res(r.result.filter(okRow).map(x => ({ id: x.id, t: x.t, usn: x.usn, msg: x.msg })).sort(cmpT));
      r.onerror = () => rej(r.error);
    });
  }
  async function accounts() {
    const d = await db();
    return new Promise((res, rej) => {
      const r = d.transaction('chat').objectStore('chat').index('acc').openKeyCursor(null, 'nextunique');
      const out = [];
      r.onsuccess = () => { const c = r.result; if (c) { out.push(c.key); c.continue(); } else res(out); };
      r.onerror = () => rej(r.error);
    });
  }
  // 새 글만 넣고 몇 줄이 새로 들어갔는지 돌려준다
  async function addRows(acc, list) {
    const have = new Set((await loadAccount(acc)).map(r => r.id));
    const fresh = list.filter(r => okRow(r) && !have.has(r.id));
    if (fresh.length) {
      const d = await db();
      const tx = d.transaction('chat', 'readwrite');
      const st = tx.objectStore('chat');
      for (const r of fresh) st.put({ k: acc + '|' + r.id, acc, id: r.id, t: String(r.t), usn: String(r.usn), msg: String(r.msg) });
      await done(tx);
    }
    return fresh.length;
  }
  async function clearAccount(acc) {
    const d = await db();
    const tx = d.transaction('chat', 'readwrite');
    const idx = tx.objectStore('chat').index('acc');
    const r = idx.openCursor(acc);
    r.onsuccess = () => { const c = r.result; if (c) { c.delete(); c.continue(); } };
    await done(tx);
  }

  // ===== 파일 읽기(sql.js) =====
  let sqlReq = null;
  function loadSql() {
    if (!sqlReq) {
      sqlReq = new Promise((res, rej) => {
        if (window.initSqlJs) { res(); return; }
        const s = document.createElement('script');
        s.src = SQL_BASE + 'sql-wasm.js';
        s.integrity = SQL_SRI;
        s.crossOrigin = 'anonymous';
        s.onload = res;
        s.onerror = () => rej(new Error('파일 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'));
        document.head.appendChild(s);
      }).then(() => window.initSqlJs({ locateFile: f => SQL_BASE + f }));
      sqlReq.catch(() => { sqlReq = null; });
    }
    return sqlReq;
  }
  const accountOf = name => {
    const m = String(name).match(/(\d+_\d+)\.nkcache$/i);
    return m ? m[1] : null;
  };
  async function readFile(file) {
    const acc = accountOf(file.name);
    if (!acc) throw new Error('숫자_숫자.nkcache 파일을 넣어 주세요.');
    if (file.size > MAX_FILE) throw new Error('파일이 너무 큽니다.');
    const buf = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(buf.subarray(0, 15)) !== 'SQLite format 3') throw new Error('계정 캐시 파일(.nkcache)이 아닙니다.');
    const SQL = await loadSql();
    const d = new SQL.Database(buf);
    try {
      if (!d.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='GuildChatModel'").length) return { acc, list: [] };
      // CreatedAt · Usn 은 2^53 을 넘을 수 있어 글자로 꺼낸다
      const st = d.prepare('SELECT Id, CAST(CreatedAt AS TEXT), CAST(Usn AS TEXT), Message FROM GuildChatModel');
      const list = [];
      while (st.step()) {
        const [id, t, usn, msg] = st.get();
        if (id && /^\d+$/.test(String(t))) list.push({ id: String(id), t: String(t), usn: String(usn), msg: msg == null ? '' : String(msg) });
      }
      st.free();
      return { acc, list };
    } finally {
      d.close();
    }
  }

  // ===== 화면 =====
  function setStatus(msg, kind) {
    const el = $('union-status');
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }
  function setImportOpen(open) {
    $('union-import').classList.toggle('is-collapsed', !open);
    $('union-reimport').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  const nameOf = usn => ((names[account] || {})[usn] || '').trim();
  // 글쓴이 번호는 UID 8자리 고정(앞 0 이 숫자로 읽으며 빠진다: 2225 -> 00002225, 사용자 지적 2026-11-19)
  const uidOf = usn => esc(String(usn).padStart(8, '0'));
  const writerLabel = usn => nameOf(usn) || '#' + uidOf(usn);
  const STICKER_RE = /::sticker_([0-7])::/g;
  // 글 안의 이모티콘 표시를 그림으로(지금 기록은 이모티콘만 단독으로 온다)
  const msgHtml = msg => esc(msg).replace(STICKER_RE, (m, n) =>
    `<img class="union-emote" src="img/emote/icn_emote_${EMOTES[n]}.webp" alt="${EMOTES[n]}" title="${EMOTES[n]}" loading="lazy">`);
  const msgText = msg => msg.replace(STICKER_RE, (m, n) => `[이모티콘:${EMOTES[n]}]`);
  // 글쓴이마다 같은 색(번호로 색상환 위치를 정한다)
  const hueOf = usn => { let h = 0; for (const c of String(usn)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

  async function show(acc) {
    account = acc;
    try { localStorage.setItem(ACC_KEY, acc); } catch (e) { /* 무시 */ }
    rows = await loadAccount(acc);
    shown = PAGE;
    const accs = await accounts();
    const sel = $('union-account');
    sel.innerHTML = accs.map(a => `<option value="${esc(a)}"${a === acc ? ' selected' : ''}>${esc(a)}</option>`).join('');
    // 계정이 둘 이상일 때만 고르기를 보인다(드롭다운은 select 를 .mmr-dd 로 감싼다 - common.js)
    const box = sel.closest('.mmr-dd') || sel;
    box.hidden = accs.length < 2;
    if (sel.__mmrDropdown) sel.__mmrDropdown();
    $('union-result').hidden = !rows.length;
    $('union-loaded').hidden = !rows.length;
    if (rows.length) {
      setImportOpen(false);
      $('union-range').innerHTML = `<b>${dayStr(msOf(rows[0].t))} ~ ${dayStr(msOf(rows[rows.length - 1].t))}</b><span>${fmt.format(rows.length)}줄</span>`;
    } else setImportOpen(true);
    renderWriters();
    renderList();
  }

  function filtered() {
    const q = $('union-q').value.trim().toLowerCase();
    const w = $('union-writer').value;
    let list = rows;
    if (w) list = list.filter(r => r.usn === w);
    if (q) list = list.filter(r => r.msg.toLowerCase().includes(q) || writerLabel(r.usn).toLowerCase().includes(q));
    return list;
  }

  // 채팅처럼 오래된 글이 위, 가장 최근 글이 맨 아래(사용자 요청, 2026-11-19). 최근 shown 줄만 그리고 '이전 글 더 보기'로 위에 붙인다.
  // keep: 'bottom' = 맨 아래로 내림, 'top' = 위에 더 붙인 뒤 보던 자리 유지
  function renderList(keep = 'bottom') {
    const list = filtered();
    $('union-count').textContent = list.length === rows.length ? `전체 ${fmt.format(rows.length)}줄` : `${fmt.format(list.length)}줄 / 전체 ${fmt.format(rows.length)}줄`;
    const page = list.slice(Math.max(0, list.length - shown));
    const box = $('union-list');
    const fromBottom = box.scrollHeight - box.scrollTop;
    let lastDay = '';
    const html = [];
    // 같은 날 · 같은 시:분 · 같은 글쓴이가 잇달아 보낸 글은 시각 · 이름 칸을 한 번만 쓰고 내용만 쌓는다(화면 표기만)
    for (let i = 0; i < page.length;) {
      const r = page[i], p = parts(msOf(r.t));
      const day = `${p.year}.${p.month}.${p.day}`, hm = `${p.hour}:${p.minute}`;
      if (day !== lastDay) { html.push(`<div class="union-day"><span>${day} (${WEEK[p.weekday] || p.weekday})</span></div>`); lastDay = day; }
      const msgs = [];
      let j = i;
      while (j < page.length && page[j].usn === r.usn) {
        const q = parts(msOf(page[j].t));
        if (`${q.year}.${q.month}.${q.day}` !== day || `${q.hour}:${q.minute}` !== hm) break;
        msgs.push(`<span class="union-msg">${msgHtml(page[j].msg)}</span>`);
        j++;
      }
      html.push(`<div class="union-row"><time>${hm}</time>`
        + `<span class="union-who${nameOf(r.usn) ? '' : ' is-nameless'}" style="--uh:${hueOf(r.usn)}" title="#${uidOf(r.usn)}">${esc(writerLabel(r.usn))}</span>`
        + `<div class="union-msgs">${msgs.join('')}</div></div>`);
      i = j;
    }
    box.innerHTML = html.join('') || '<div class="gacha-empty">맞는 글이 없습니다.</div>';
    $('union-more').hidden = list.length <= shown;
    box.scrollTop = keep === 'top' ? box.scrollHeight - fromBottom : box.scrollHeight;
  }

  function renderWriters() {
    const count = new Map();
    for (const r of rows) count.set(r.usn, (count.get(r.usn) || 0) + 1);
    // 번호(UID) 순(사용자 요청, 2026-11-19). 8자리로 맞추면 글자 순 = 숫자 순
    const list = [...count.entries()].sort((a, b) => (uidOf(a[0]) < uidOf(b[0]) ? -1 : 1));
    $('union-writer-list').innerHTML = list.map(([usn, n]) =>
      `<label class="union-writer"><span class="union-who is-id" style="--uh:${hueOf(usn)}">#${uidOf(usn)}</span>`
      + `<span class="search-box union-name"><input type="text" data-usn="${esc(usn)}" value="${esc(nameOf(usn))}" placeholder="이름" maxlength="20" aria-label="#${uidOf(usn)} 이름"></span>`
      + `<em>${fmt.format(n)}줄</em></label>`).join('');
    // 글쓴이 고르기: 이름이 있으면 이름, 없으면 번호
    const sel = $('union-writer');
    const cur = sel.value;
    sel.innerHTML = '<option value="">멤버 전체</option>' + list.map(([usn, n]) =>
      `<option value="${esc(usn)}"${usn === cur ? ' selected' : ''}>${esc(writerLabel(usn))} (${fmt.format(n)})</option>`).join('');
    if (cur && !count.has(cur)) sel.value = '';
    if (sel.__mmrDropdown) sel.__mmrDropdown();
  }

  // ===== 파일 넣기 =====
  async function loadFiles(files) {
    const list = [...(files || [])].filter(f => /\.nkcache$/i.test(f.name));
    if (!list.length) { setStatus('숫자_숫자.nkcache 파일을 넣어 주세요.', 'error'); return; }
    setStatus('읽는 중…');
    try {
      const msgs = [];
      let last = null;
      for (const f of list) {
        const { acc, list: got } = await readFile(f);
        if (!got.length) { msgs.push(`${f.name}: 유니온 채팅이 없습니다`); continue; }
        const added = await addRows(acc, got);
        msgs.push(`새로 ${fmt.format(added)}줄 더함(파일 ${fmt.format(got.length)}줄)`);
        last = acc;
      }
      if (last) await show(last);
      setStatus(msgs.join(' · '), last ? 'ok' : 'error');
    } catch (e) {
      setStatus(e && e.message ? e.message : '파일을 읽지 못했습니다.', 'error');
    }
  }

  // ===== 백업 · 내보내기 =====
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const stamp = () => { const p = parts(Date.now()); return `${p.year}${p.month}${p.day}`; };
  const lineTime = t => { const p = parts(msOf(t)); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };

  function saveBackup() {
    const data = { type: 'mmr-union-log', version: 1, account, names: names[account] || {}, rows: rows.map(r => ({ id: r.id, t: r.t, usn: r.usn, msg: r.msg })) };
    download(`유니온일지_${account}_${stamp()}.json`, JSON.stringify(data), 'application/json');
  }
  async function loadBackup(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.type !== 'mmr-union-log' || !Array.isArray(data.rows) || !/^\d+_\d+$/.test(String(data.account))) throw new Error('유니온 일지 백업 파일이 아닙니다.');
      const acc = String(data.account);
      const list = data.rows.filter(r => r && r.id && /^\d+$/.test(String(r.t))).map(r => ({ id: String(r.id), t: String(r.t), usn: String(r.usn), msg: String(r.msg == null ? '' : r.msg) }));
      const added = await addRows(acc, list);
      // 이름표는 비어 있는 번호에만 채운다(지금 붙인 이름을 덮지 않는다)
      if (data.names && typeof data.names === 'object') {
        const cur = names[acc] || (names[acc] = {});
        for (const [usn, nm] of Object.entries(data.names)) if (!cur[usn] && typeof nm === 'string' && nm.trim()) cur[usn] = nm.trim().slice(0, 20);
        saveNames();
      }
      await show(acc);
      setStatus(`백업에서 새로 ${fmt.format(added)}줄 더함`, 'ok');
    } catch (e) {
      setStatus(e && e.message ? e.message : '백업 파일을 읽지 못했습니다.', 'error');
    }
  }
  function exportTxt() {
    const text = rows.map(r => `${lineTime(r.t)} [${writerLabel(r.usn)}] ${msgText(r.msg)}`).join('\r\n');
    download(`유니온일지_${account}_${stamp()}.txt`, text, 'text/plain;charset=utf-8');
  }
  function exportCsv() {
    // 보안: = + - @ 로 시작하는 칸은 엑셀이 수식으로 실행하므로 앞에 ' 를 붙여 글자로 둔다(채팅 · 이름은 남이 쓴 글)
    const q = v => { let t = String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
    const text = '﻿' + ['시각(한국시간),멤버 번호,이름,내용'].concat(rows.map(r => [lineTime(r.t), uidOf(r.usn), nameOf(r.usn), msgText(r.msg)].map(q).join(','))).join('\r\n');
    download(`유니온일지_${account}_${stamp()}.csv`, text, 'text/csv;charset=utf-8');
  }
  function saveNames() {
    try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch (e) { /* 무시 */ }
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      const accs = await accounts();
      if (!accs.length) return;
      let acc = null;
      try { acc = localStorage.getItem(ACC_KEY); } catch (e) { /* 무시 */ }
      await show(accs.includes(acc) ? acc : accs[0]);
    } catch (e) {
      setStatus(e && e.message ? e.message : '저장해 둔 기록을 읽지 못했습니다.', 'error');
    }
  }

  const hasFiles = e => !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
  document.addEventListener('DOMContentLoaded', () => {
    const tab = $('tab-union');
    if (!tab) return;
    $('union-dir').textContent = NIKKE_DIR;
    $('union-copy-dir').addEventListener('click', async () => {
      const btn = $('union-copy-dir');
      try { await navigator.clipboard.writeText(NIKKE_DIR); btn.textContent = '복사됨'; }
      catch (e) {
        const r = document.createRange();
        r.selectNodeContents($('union-dir'));
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        btn.textContent = 'Ctrl+C';
      }
      setTimeout(() => { btn.textContent = '주소 복사'; }, 2000);
    });
    const input = $('union-file');
    input.addEventListener('change', () => { loadFiles(input.files); input.value = ''; });
    // 끌어다 놓기: 탭 어디에 놓아도 받는다
    const drop = $('union-drop');
    let depth = 0;
    const off = () => { depth = 0; drop.classList.remove('is-over'); tab.classList.remove('is-dragging'); };
    tab.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; drop.classList.add('is-over'); tab.classList.add('is-dragging'); } });
    tab.addEventListener('dragleave', e => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) off(); } });
    tab.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    tab.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      off();
      const files = [...e.dataTransfer.files];
      const json = files.find(f => /\.json$/i.test(f.name));
      if (json && !files.some(f => /\.nkcache$/i.test(f.name))) loadBackup(json); else loadFiles(files);
    });
    $('union-reimport').addEventListener('click', () => setImportOpen($('union-import').classList.contains('is-collapsed')));

    let qTimer = 0;
    $('union-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { shown = PAGE; renderList(); }, 150); });
    $('union-writer').addEventListener('change', () => { shown = PAGE; renderList(); });
    $('union-more').addEventListener('click', () => { shown += PAGE; renderList('top'); });
    $('union-account').addEventListener('change', e => show(e.target.value));
    // 이름 붙이기: 입력하는 대로 저장하고, 목록 · 글쓴이 고르기는 입력이 멈추면 다시 그린다
    let nTimer = 0;
    $('union-writer-list').addEventListener('input', e => {
      const el = e.target.closest('input[data-usn]');
      if (!el || !account) return;
      const cur = names[account] || (names[account] = {});
      const v = el.value.trim().slice(0, 20);
      if (v) cur[el.dataset.usn] = v; else delete cur[el.dataset.usn];
      saveNames();
      clearTimeout(nTimer);
      nTimer = setTimeout(() => {
        const sel = $('union-writer');
        [...sel.options].forEach(o => { if (o.value) o.textContent = `${writerLabel(o.value)} (${fmt.format(rows.filter(r => r.usn === o.value).length)})`; });
        renderList();
      }, 300);
    });
    $('union-save').addEventListener('click', () => { if (account) saveBackup(); });
    const load = $('union-load');
    load.addEventListener('change', () => { loadBackup(load.files[0]); load.value = ''; });
    $('union-txt').addEventListener('click', () => { if (account) exportTxt(); });
    $('union-csv').addEventListener('click', () => { if (account) exportCsv(); });
    $('union-clear').addEventListener('click', async () => {
      if (!account || !confirm('이 계정의 유니온 일지를 이 브라우저에서 지웁니다. 백업 파일이 없으면 되돌릴 수 없습니다. 지울까요?')) return;
      const acc = account;
      await clearAccount(acc);
      const accs = await accounts();
      if (accs.length) { await show(accs[0]); } else {
        account = null; rows = [];
        $('union-result').hidden = true;
        $('union-loaded').hidden = true;
        setImportOpen(true);
      }
      setStatus('지웠습니다.');
    });
    ['union-writer', 'union-account'].forEach(id => mmrDropdown($(id)));   // common.js
    if (tab.classList.contains('active')) start();
  });

  document.addEventListener('mmr:tab-change', e => {
    if (e.detail && e.detail.tab === 'union') start();
  });
})();
