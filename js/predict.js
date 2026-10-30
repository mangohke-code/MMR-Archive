// ===== 복각 예측 (픽업 기록 탭 아래 서브 페이지, 사용자 요청 2026-10-31) =====
//
// 픽업 기록에서 "시즌이 맞는 복각"만 골라 다음에 누가 언제 복각될지 짐작한다. 매번 픽업 기록에서 다시 계산하므로
// 새 픽업이 들어오면 예측도 따라 바뀐다(맞은 예측은 후보에서 빠진다).
//
// 시즌이 맞는 복각 - 캐릭터가 처음 픽업된 시즌과 복각된 이벤트의 시즌이 같은 계열일 때만 센다.
//   이벤트의 시즌은 그 이벤트의 신규 픽업 시즌이다(픽업 기록 화면과 같은 기준, pickup.js eventSeason).
//   예) 크리스마스 캐릭터가 9월 코인 러시(바니걸 이벤트)에 다시 나온 것은 뺀다.
//   0.5주년 · 1주년 … N주년은 한 계열(주년)로 본다.
// 계열마다 "회차"(그 계열 신규가 나온 이벤트 묶음, 60일 안이면 한 회차)를 세워 다음 회차 복각을 본다.
//   확신 높음 - 3회 이상 연속으로 앞 회차 신규 전원이 다음 회차에 복각
//   확신 중간 - 2회 이상, 앞 회차 신규의 절반 이상이 복각 / 주년(정주년에 1~2.5년 전 주년 캐릭터가 복각)
//   확신 낮음 - 그 밖에 한 번이라도 맞은 적이 있는 것
// 일반 시즌은 상시 캐릭터라 복각 픽업이 없다. 콜라보는 같은 작품이 다시 와야 복각이라 예측에서 뺀다(사용자 결정).
(function () {
  const DAY = 86400000;
  const SKIP_FAMILIES = new Set(['', '일반', '콜라보']);
  const fam = s => (/주년$/.test(String(s || '')) ? '주년' : String(s || ''));
  const isFullAnniv = s => /^\d+주년$/.test(String(s || ''));
  const day = v => { const d = new Date(String(v).slice(0, 10) + 'T00:00:00+09:00'); return isNaN(d) ? null : d; };
  const fmt = d => `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const median = a => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function analyze(pickups) {
    const list = pickups.filter(p => p['시작일'] && p['니케'])
      .map(p => ({ name: p['니케'], season: p['시즌'], event: p['이벤트'], date: day(p['시작일']), rerun: !!p['복각'] }))
      .filter(p => p.date)
      .sort((a, b) => a.date - b.date);
    const evSeason = {};
    list.forEach(p => { if (!p.rerun && p.event && !(p.event in evSeason)) evSeason[p.event] = p.season; });
    const first = {};
    list.forEach(p => { if (!first[p.name]) first[p.name] = p; });

    // 시즌이 맞는 복각 / 시즌이 안 맞아서 뺀 복각(예측하지 않는 계열 - 콜라보 - 의 복각은 어느 쪽에도 안 센다)
    const valid = {}, skipped = [];
    list.filter(p => p.rerun).forEach(p => {
      const f0 = fam(first[p.name] && first[p.name].season);
      const fe = fam(evSeason[p.event]);
      if (f0 !== fe) skipped.push(p);
      else if (f0 && !SKIP_FAMILIES.has(f0)) (valid[p.name] = valid[p.name] || []).push(p);
    });

    // 계열별 회차
    const occ = {};
    list.filter(p => !p.rerun).forEach(p => {
      const f = fam(p.season);
      if (SKIP_FAMILIES.has(f)) return;
      const arr = occ[f] = occ[f] || [];
      const last = arr[arr.length - 1];
      if (last && p.date - last.date < 60 * DAY) { last.names.push(p.name); return; }
      arr.push({ date: p.date, event: p.event, season: p.season, names: [p.name] });
    });
    return { first, valid, skipped, occ };
  }

  // 다음 회차 날짜 - 회차가 전부 같은 달 · 날이면(신년 1월 1일) 그대로, 아니면 52주 뒤(같은 요일)
  function nextDate(occs, today) {
    const last = occs[occs.length - 1].date;
    const md = d => d.getMonth() * 100 + d.getDate();
    let next;
    if (occs.every(o => md(o.date) === md(last))) {
      next = new Date(last); next.setFullYear(last.getFullYear() + 1);
    } else {
      next = new Date(last.getTime() + 364 * DAY);
    }
    while (next < new Date(today.getTime() - 30 * DAY)) next = new Date(next.getTime() + 364 * DAY);
    return next;
  }

  function seasonal(f, occs, A, today) {
    if (occs.length < 2) return { family: f, none: '회차가 한 번뿐이라 비교할 앞뒤가 없어요' };
    const pairs = [];
    for (let i = 0; i + 1 < occs.length; i++) {
      const a = occs[i], b = occs[i + 1];
      const rows = a.names.map(n => {
        const hit = (A.valid[n] || []).find(r => r.date >= new Date(b.date - 30 * DAY) && r.date <= new Date(b.date.getTime() + 60 * DAY));
        return { name: n, hit: !!hit, date: hit && hit.date };
      });
      pairs.push({ from: a, to: b, rows });
    }
    const total = pairs.reduce((n, p) => n + p.rows.length, 0);
    const hits = pairs.reduce((n, p) => n + p.rows.filter(r => r.hit).length, 0);
    if (!hits) return { family: f, none: '같은 시즌 복각 사례가 없어요' };
    let streak = 0;
    for (let i = pairs.length - 1; i >= 0 && pairs[i].rows.every(r => r.hit); i--) streak++;
    const rate = hits / total;
    const conf = streak >= 3 && rate === 1 ? 'high' : (pairs.length >= 2 && rate >= 0.5 ? 'mid' : 'low');
    const last = occs[occs.length - 1];
    const cands = last.names.filter(n => !(A.valid[n] || []).length);
    if (!cands.length) return null;
    return {
      family: f, conf, date: nextDate(occs, today), cands: cands.map(n => ({ name: n, from: last })),
      why: pairs.map(p => ({
        text: `${p.from.date.getFullYear()} ${p.from.event} 신규 → ${p.to.date.getFullYear()} ${p.to.event}`,
        rows: p.rows.map(r => ({ name: r.name, hit: r.hit })),
      })),
      summary: `${pairs.length}번 중 ${pairs.filter(p => p.rows.every(r => r.hit)).length}번 전원 복각(${hits}/${total}명)`,
    };
  }

  // 주년 - 반주년에는 복각이 없었고, 정주년에 1~2.5년 전 주년 캐릭터가 복각됐다.
  function anniversary(occs, A, today) {
    const full = occs.filter(o => isFullAnniv(o.season));
    if (!full.length) return null;
    const lags = [];
    const why = [];
    full.forEach(o => {
      const rows = [];
      Object.entries(A.valid).forEach(([n, rs]) => rs.forEach(r => {
        if (Math.abs(r.date - o.date) < 60 * DAY && fam(A.first[n].season) === '주년') {
          lags.push(Math.round((r.date - A.first[n].date) / DAY));
          rows.push({ name: n, hit: true, note: `${A.first[n].season} · ${Math.round((r.date - A.first[n].date) / DAY)}일 뒤` });
        }
      }));
      if (rows.length) why.push({ text: `${o.date.getFullYear()} ${o.season} ${o.event}`, rows });
    });
    if (!lags.length) return { family: '주년', none: '같은 계열 복각 사례가 없어요' };
    const half = occs.filter(o => !isFullAnniv(o.season));
    const halfHit = half.some(o => Object.values(A.valid).some(rs => rs.some(r => Math.abs(r.date - o.date) < 60 * DAY)));
    if (!halfHit && half.length) why.push({ text: `반주년(${half.map(o => o.season).join(' · ')})에는 복각 없음`, rows: [] });
    const date = nextDate(full, today);
    const lo = Math.min(...lags) - 60, hi = Math.max(...lags) + 60, mid = median(lags);
    const cands = [];
    occs.forEach(o => o.names.forEach(n => {
      if ((A.valid[n] || []).length) return;
      const lag = Math.round((date - o.date) / DAY);
      if (lag >= lo && lag <= hi) cands.push({ name: n, from: o, score: Math.abs(lag - mid) });
    }));
    if (!cands.length) return null;
    cands.sort((a, b) => a.score - b.score);
    // 지난 정주년은 한 번에 2~3명씩 복각됐다. 간격이 가장 가까운 넷만 후보로 내고 나머지는 근거에 적는다.
    const MAX = 4;
    const rest = cands.slice(MAX);
    if (rest.length) why.push({ text: `간격이 더 먼 후보: ${rest.map(c => c.name).join(', ')}`, rows: [] });
    return {
      family: '주년', conf: why.filter(w => w.rows.length).length >= 2 ? 'mid' : 'low', date, cands: cands.slice(0, MAX), why,
      summary: `정주년 ${why.filter(w => w.rows.length).length}번, 첫 픽업 뒤 ${Math.min(...lags)}~${Math.max(...lags)}일에 복각(가운데 ${Math.round(mid)}일). 후보는 그 간격에 가까운 순`,
    };
  }

  const CONF_LABEL = { high: '확신 높음', mid: '확신 중간', low: '확신 낮음' };

  function render() {
    const host = document.getElementById('predict-list');
    if (!host || typeof APP_DATA === 'undefined' || !APP_DATA.pickup) return;
    const today = new Date();
    const A = analyze(APP_DATA.pickup);
    const imgOf = {};
    (APP_DATA.nikkeImg || []).forEach(n => { if (n['이름']) imgOf[n['이름']] = n['이미지']; });

    const cards = [], none = [];
    Object.entries(A.occ).forEach(([f, occs]) => {
      const r = f === '주년' ? anniversary(occs, A, today) : seasonal(f, occs, A, today);
      if (!r) return;
      if (r.none) none.push(r); else cards.push(r);
    });
    cards.sort((a, b) => a.date - b.date);

    host.innerHTML = cards.length ? cards.map(c => {
      const dday = Math.ceil((c.date - today) / DAY);
      return `
      <article class="predict-card is-${c.conf}">
        <div class="predict-head">
          <span class="predict-fam">${c.date.getFullYear()} ${esc(c.family)}</span>
          <span class="predict-conf is-${c.conf}">${CONF_LABEL[c.conf]}</span>
        </div>
        <div class="predict-when"><em>예상 시기</em><b>${fmt(c.date)} 전후</b>${dday >= 0 ? `<span>D-${dday}</span>` : '<span>지남</span>'}</div>
        <div class="predict-cands">
          ${c.cands.map(x => `
            <button type="button" class="predict-cand" data-nikke="${esc(x.name)}" title="픽업 기록에서 보기">
              <span class="predict-cand-img">${imgOf[x.name] ? `<img src="${esc(imgOf[x.name])}" alt="" loading="lazy">` : ''}</span>
              <span class="predict-cand-name">${esc(x.name)}</span>
              <span class="predict-cand-from">${x.from.date.getFullYear()} ${esc(x.from.season)} 신규</span>
            </button>`).join('')}
        </div>
        <details class="predict-why">
          <summary>근거 · ${esc(c.summary)}</summary>
          <ul>${c.why.map(w => `<li><span>${esc(w.text)}</span>${w.rows.length ? ` <span class="predict-hits">${w.rows.map(r =>
            `<i class="${r.hit ? 'is-hit' : 'is-miss'}">${r.hit ? '✓' : '✗'} ${esc(r.name)}${r.note ? ` (${esc(r.note)})` : ''}</i>`).join('')}</span>` : ''}</li>`).join('')}</ul>
        </details>
      </article>`;
    }).join('') : '<p class="predict-empty">지금 예측할 복각이 없어요.</p>';

    const notes = document.getElementById('predict-notes');
    if (notes) {
      notes.innerHTML = `
        <div class="predict-note-title">계산 방법</div>
        <ul>
          <li>캐릭터가 처음 픽업된 시즌과 <b>복각된 이벤트의 시즌이 같을 때만</b> 복각으로 셌어요. 시즌이 다른 이벤트(예: 크리스마스 캐릭터가 9월 코인 러시)에 나온 복각 ${A.skipped.length}건은 뺐어요.</li>
          <li>0.5주년 ~ N주년은 한 계열(주년)로 봤어요. 일반 시즌은 상시 캐릭터라, 콜라보는 같은 작품이 돌아와야 복각이라 예측하지 않아요.</li>
          <li>확신 높음: 3번 이상 연속 앞 회차 신규 전원 복각 · 중간: 규칙은 보이지만 사례가 적거나 후보가 갈림 · 낮음: 그 밖에 맞은 적이 있는 것</li>
          ${none.length ? `<li>예측하지 않은 시즌: ${none.map(n => `<b>${esc(n.family)}</b>(${esc(n.none)})`).join(' · ')}</li>` : ''}
        </ul>`;
    }

    host.querySelectorAll('.predict-cand').forEach(btn => btn.addEventListener('click', () => {
      if (typeof jumpToPickupNikke === 'function') jumpToPickupNikke(btn.dataset.nikke);
    }));
  }

  let rendered = false;
  document.addEventListener('mmr:tab-change', e => {
    if (!e.detail || e.detail.tab !== 'predict') return;
    if (typeof onAppDataReady === 'function') onAppDataReady(() => { if (!rendered) { rendered = true; render(); } });
  });
  window.renderPickupPredict = render;
})();
