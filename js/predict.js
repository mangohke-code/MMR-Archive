// ===== 복각 예측 (픽업 기록 탭 아래 서브 페이지, 사용자 요청 2026-10-31) =====
//
// 픽업 기록에서 "시즌이 맞는 복각"만 골라 다음에 누가 언제 복각될지 짐작한다. 매번 픽업 기록에서 다시 계산하므로
// 새 픽업이 들어오면 예측도 따라 바뀐다(맞은 예측은 후보에서 빠진다).
//
// 복각 대상 - 한정(콜라보 · 여름 · 크리스마스, common.js LIMITED_SEASONS) 또는 필그림 · 오버스펙(기업 끝 "(오)") 캐릭터만.
//   메이드 · 바니걸 · 할로윈처럼 상시 기업 캐릭터는 복각 픽업이 없다(사용자 지적, 2026-10-31 - 데이터도 그렇다).
// 시즌이 맞는 복각 - 캐릭터가 처음 픽업된 시즌과 복각된 이벤트의 시즌이 같은 계열일 때만 센다.
//   이벤트의 시즌은 그 이벤트의 신규 픽업 시즌이다(픽업 기록 화면과 같은 기준, pickup.js eventSeason).
//   예) 크리스마스 캐릭터가 9월 코인 러시(바니걸 이벤트)에 다시 나온 것은 뺀다.
//   0.5주년 · 1주년 … N주년은 한 계열(주년)로 본다.
// 계열마다 "회차"(그 계열 신규가 나온 이벤트 묶음, 60일 안이면 한 회차)를 세워 비교한다.
//   시즌 계열 - 앞 회차 신규가 다음 회차에 복각됐나
//   주년      - 정주년마다, 첫 픽업 뒤 지난 복각 간격 안에 든 주년 캐릭터 중 몇이 복각됐나(반주년에는 복각이 없었다)
// 가능성 5단계(사용자 요청, 2026-10-31) - 비교마다 "복각 수 / 후보 수"
//   매우 높음 - 3회 이상 연속 전원 복각
//   높음     - 2회 이상 연속 전원 복각, 전체 80% 이상
//   중간     - 2회 이상 비교, 절반 이상
//   낮음     - 2회 이상 비교, 4분의 1 이상
//   매우 낮음 - 그 밖
// 콜라보는 같은 작품이 다시 와야 복각이라 예측에서 뺀다(사용자 결정).
(function () {
  const DAY = 86400000;
  const SKIP_FAMILIES = new Set(['', '일반', '콜라보']);
  const fam = s => (/주년$/.test(String(s || '')) ? '주년' : String(s || ''));
  const isFullAnniv = s => /^\d+주년$/.test(String(s || ''));
  const day = v => { const d = new Date(String(v).slice(0, 10) + 'T00:00:00+09:00'); return isNaN(d) ? null : d; };
  const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const median = a => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const limitedSeasons = typeof LIMITED_SEASONS !== 'undefined' ? LIMITED_SEASONS : ['콜라보', '여름', '크리스마스'];
  const isEligible = p => limitedSeasons.includes(p.season)
    || /^필그림/.test(String(p.company || '')) || /\(오\)$/.test(String(p.company || ''));

  function analyze(pickups) {
    const list = pickups.filter(p => p['시작일'] && p['니케'])
      .map(p => ({ name: p['니케'], season: p['시즌'], event: p['이벤트'], company: p['기업'], date: day(p['시작일']), rerun: !!p['복각'] }))
      .filter(p => p.date)
      .sort((a, b) => a.date - b.date);
    const evSeason = {};
    list.forEach(p => { if (!p.rerun && p.event && !(p.event in evSeason)) evSeason[p.event] = p.season; });
    const first = {};
    list.forEach(p => { if (!first[p.name]) first[p.name] = p; });
    const eligible = n => !!first[n] && isEligible(first[n]);

    // 시즌이 맞는 복각 / 시즌이 안 맞아서 뺀 복각(콜라보 복각은 어느 쪽에도 안 센다)
    const valid = {}, skipped = [];
    list.filter(p => p.rerun && eligible(p.name)).forEach(p => {
      const f0 = fam(first[p.name].season);
      const fe = fam(evSeason[p.event]);
      if (f0 !== fe) skipped.push(p);
      else if (f0 && !SKIP_FAMILIES.has(f0)) (valid[p.name] = valid[p.name] || []).push(p);
    });

    // 계열별 회차(복각 대상 캐릭터만)
    const occ = {};
    list.filter(p => !p.rerun && isEligible(p)).forEach(p => {
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

  // 날짜가 해마다 맞아떨어졌나 - 전부 같은 달 · 날이거나 회차 간격이 모두 52주. 아니면(여름) 달만 보인다.
  function regular(occs) {
    const md = d => d.getMonth() * 100 + d.getDate();
    return occs.every((o, i) => !i || md(o.date) === md(occs[i - 1].date) || Math.round((o.date - occs[i - 1].date) / DAY) === 364);
  }

  // 비교 목록([{hits, total}])으로 가능성 단계를 정한다
  function grade(rows) {
    const total = rows.reduce((n, r) => n + r.total, 0);
    const hits = rows.reduce((n, r) => n + r.hits, 0);
    const rate = total ? hits / total : 0;
    let streak = 0;
    for (let i = rows.length - 1; i >= 0 && rows[i].hits === rows[i].total; i--) streak++;
    return streak >= 3 && rate === 1 ? 'vhigh'
      : streak >= 2 && rate >= 0.8 ? 'high'
      : rows.length >= 2 && rate >= 0.5 ? 'mid'
      : rows.length >= 2 && rate >= 0.25 ? 'low' : 'vlow';
  }

  function seasonal(f, occs, A, today) {
    if (occs.length < 2) return { family: f, none: '첫 회차' };
    const pairs = [];
    for (let i = 0; i + 1 < occs.length; i++) {
      const a = occs[i], b = occs[i + 1];
      const rows = a.names.map(n => {
        const hit = (A.valid[n] || []).find(r => r.date >= new Date(b.date - 30 * DAY) && r.date <= new Date(b.date.getTime() + 60 * DAY));
        return { name: n, hit: !!hit };
      });
      pairs.push({ from: a, to: b, rows, hits: rows.filter(r => r.hit).length, total: rows.length });
    }
    const total = pairs.reduce((n, p) => n + p.total, 0);
    const hits = pairs.reduce((n, p) => n + p.hits, 0);
    if (!hits) return { family: f, none: '같은 시즌 복각 없음' };
    const last = occs[occs.length - 1];
    const cands = last.names.filter(n => !(A.valid[n] || []).length);
    if (!cands.length) return null;
    return {
      family: f, conf: grade(pairs), date: nextDate(occs, today), exact: regular(occs), cands: cands.map(n => ({ name: n, from: last })),
      why: pairs.map(p => ({
        text: `${p.from.date.getFullYear()} ${p.from.event} 신규 → ${p.to.date.getFullYear()} ${p.to.event}`,
        rows: p.rows,
      })),
      // 지난 기록 칩 - 회차(해)마다 "복각 / 앞 회차 신규"
      track: pairs.map(p => ({ label: String(p.to.date.getFullYear()), text: `${p.hits}/${p.total}`, ok: p.hits === p.total })),
      summary: `전원 복각 ${pairs.filter(p => p.hits === p.total).length}/${pairs.length}회 · ${hits}/${total}명`,
    };
  }

  // 주년 - 정주년마다 "첫 픽업 뒤 지난 복각 간격 안에 든 주년 캐릭터" 를 후보로 놓고 몇이 복각됐나를 본다.
  function anniversary(occs, A, today) {
    const full = occs.filter(o => isFullAnniv(o.season));
    if (!full.length) return null;
    const near = (a, b) => Math.abs(a - b) < 60 * DAY;
    // 지난 복각 간격(첫 픽업 -> 정주년 복각)
    const lags = [];
    Object.entries(A.valid).forEach(([n, rs]) => rs.forEach(r => {
      if (fam(A.first[n].season) === '주년' && full.some(o => near(r.date, o.date))) lags.push(Math.round((r.date - A.first[n].date) / DAY));
    }));
    if (!lags.length) return { family: '주년', none: '같은 시즌 복각 없음' };
    const lo = Math.min(...lags) - 60, hi = Math.max(...lags) + 60, mid = median(lags);
    const lagOf = (n, d) => Math.round((d - A.first[n].date) / DAY);
    const rerunBy = (n, d) => (A.valid[n] || []).some(r => r.date < new Date(d.getTime() - 60 * DAY));
    // 정주년마다 후보(간격 안 · 그전까지 복각 안 됨)와 그 자리 복각
    const comps = [];
    full.forEach(o => {
      const pool = [];
      occs.forEach(src => src.names.forEach(n => {
        if (src.date >= o.date) return;
        const lag = lagOf(n, o.date);
        if (lag >= lo && lag <= hi && !rerunBy(n, o.date)) pool.push(n);
      }));
      if (!pool.length) return;
      const rows = pool.map(n => ({ name: n, hit: (A.valid[n] || []).some(r => near(r.date, o.date)), note: A.first[n].season }));
      comps.push({ occ: o, rows, hits: rows.filter(r => r.hit).length, total: rows.length });
    });
    const date = nextDate(full, today);
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
    const why = comps.map(c => ({ text: `${c.occ.date.getFullYear()} ${c.occ.season} ${c.occ.event}`, rows: c.rows }));
    if (occs.some(o => !isFullAnniv(o.season))) why.push({ text: '반주년 복각 없음', rows: [] });
    const rest = cands.slice(MAX);
    if (rest.length) why.push({ text: `기타 후보: ${rest.map(c => c.name).join(', ')}`, rows: [] });
    // 몇 주년인지 - 마지막 정주년 번호 + 1
    const lastNo = parseInt(full[full.length - 1].season, 10);
    return {
      family: '주년', title: isFinite(lastNo) ? `${lastNo + 1}주년` : '주년',
      conf: grade(comps), date, exact: regular(full), cands: cands.slice(0, MAX), why,
      track: comps.map(c => ({ label: c.occ.season, text: `${c.hits}/${c.total}`, ok: c.hits === c.total })),
      summary: `복각 간격 ${Math.min(...lags)}~${Math.max(...lags)}일 · 중앙 ${Math.round(mid)}일 기준 순`,
    };
  }

  const CONF_LABEL = { vhigh: '매우 높음', high: '높음', mid: '중간', low: '낮음', vlow: '매우 낮음' };

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

    // 세로 시간줄 - 왼쪽에 예상 날짜(크게) · D-day(날짜가 들쭉날쭉한 계열은 달만), 오른쪽에 후보 그림. 가까운 것부터 위에서 아래로.
    const md = d => `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    host.innerHTML = cards.length ? `<ol class="predict-timeline">${cards.map((c, i) => {
      const dday = Math.ceil((c.date - today) / DAY);
      return `
      <li class="predict-row is-${c.conf}${i === 0 ? ' is-next' : ''}">
        <div class="predict-date">
          <span class="predict-date-y">${c.date.getFullYear()}</span>
          ${c.exact ? `<b class="predict-date-md">${md(c.date)}</b>
          <em class="predict-date-d">${dday >= 0 ? `D-${dday}` : '지남'}</em>` : `<b class="predict-date-md">${c.date.getMonth() + 1}월</b>`}
        </div>
        <article class="predict-card is-${c.conf}">
          <div class="predict-head">
            <span class="predict-fam">${esc(c.title || c.family)}</span>
            <span class="predict-conf is-${c.conf}">${CONF_LABEL[c.conf]}</span>
          </div>
          <div class="predict-cands">
            ${c.cands.map(x => `
              <button type="button" class="predict-cand" data-nikke="${esc(x.name)}" title="픽업 기록에서 보기">
                <span class="predict-cand-img">${imgOf[x.name] ? `<img src="${esc(imgOf[x.name])}" alt="" loading="lazy">` : ''}</span>
                <span class="predict-cand-name">${esc(x.name)}</span>
                <span class="predict-cand-from">${x.from.date.getFullYear()} ${esc(x.from.season)}</span>
              </button>`).join('')}
          </div>
          <div class="predict-track">
            <span class="predict-track-label">지난 기록</span>
            ${(c.track || []).map(t => `<span class="predict-chip${t.ok ? ' is-ok' : ''}">${esc(t.label)} <b>${esc(t.text)}</b></span>`).join('')}
          </div>
          <details class="predict-why">
            <summary>자세히</summary>
            <p class="predict-why-sum">${esc(c.summary)}</p>
            <ul>${c.why.map(w => `<li><span>${esc(w.text)}</span>${w.rows.length ? `<span class="predict-hits">${w.rows.map(r =>
              `<i class="${r.hit ? 'is-hit' : 'is-miss'}">${r.hit ? '✓' : '✗'} ${esc(r.name)}${r.note ? ` (${esc(r.note)})` : ''}</i>`).join('')}</span>` : ''}</li>`).join('')}</ul>
          </details>
        </article>
      </li>`;
    }).join('')}</ol>` : '<p class="predict-empty">예측 없음</p>';

    const notes = document.getElementById('predict-notes');
    if (notes) {
      notes.innerHTML = `
        <summary>제외 항목</summary>
        <ul>
          <li>시즌 불일치 복각 ${A.skipped.length}건</li>
          <li>콜라보</li>
          ${none.map(n => `<li>${esc(n.family)} - ${esc(n.none)}</li>`).join('')}
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
