// ===== 픽업 예측 - 신규 픽업 속성 · 복각 (픽업 기록 탭 아래 서브 페이지, 사용자 요청 2026-10-31) =====
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
//   주년      - 주년마다, 첫 픽업 뒤 지난 복각 간격 안에 든 주년 캐릭터 중 몇이 복각됐나(반주년에는 복각이 없었다)
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

  // 날짜가 해마다 맞아떨어졌나 - 3회 이상, 전부 같은 달 · 날이거나 회차 간격이 모두 52주. 아니면(여름) 달만 보인다.
  function regular(occs) {
    const md = d => d.getMonth() * 100 + d.getDate();
    return occs.length >= 3 && occs.every((o, i) => !i || md(o.date) === md(occs[i - 1].date) || Math.round((o.date - occs[i - 1].date) / DAY) === 364);
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
    const date = nextDate(occs, today);
    return {
      family: f, conf: grade(pairs), date, exact: regular(occs), span: regular(occs) ? '' : monthSpan(occs, date), cands: cands.map(n => ({ name: n, from: last })),
      why: pairs.map(p => ({
        text: `${p.from.date.getFullYear()} ${p.from.event} 신규 → ${p.to.date.getFullYear()} ${p.to.event}`,
        rows: p.rows,
      })),
      // 지난 기록 칩 - 회차(해)마다 "복각 / 앞 회차 신규"
      track: pairs.map(p => ({ label: String(p.to.date.getFullYear()), text: `${p.hits}/${p.total}`, ok: p.hits === p.total })),
      summary: `전원 복각 ${pairs.filter(p => p.hits === p.total).length}/${pairs.length}회 · ${hits}/${total}명`,
    };
  }

  // 주년 - 주년마다 "첫 픽업 뒤 지난 복각 간격 안에 든 주년 캐릭터" 를 후보로 놓고 몇이 복각됐나를 본다.
  function anniversary(occs, A, today) {
    const full = occs.filter(o => isFullAnniv(o.season));
    if (!full.length) return null;
    const near = (a, b) => Math.abs(a - b) < 60 * DAY;
    // 지난 복각 간격(첫 픽업 -> 주년 복각)
    const lags = [];
    Object.entries(A.valid).forEach(([n, rs]) => rs.forEach(r => {
      if (fam(A.first[n].season) === '주년' && full.some(o => near(r.date, o.date))) lags.push(Math.round((r.date - A.first[n].date) / DAY));
    }));
    if (!lags.length) return { family: '주년', none: '같은 시즌 복각 없음' };
    const lo = Math.min(...lags) - 60, hi = Math.max(...lags) + 60, mid = median(lags);
    const lagOf = (n, d) => Math.round((d - A.first[n].date) / DAY);
    const rerunBy = (n, d) => (A.valid[n] || []).some(r => r.date < new Date(d.getTime() - 60 * DAY));
    // 주년마다 후보(간격 안 · 그전까지 복각 안 됨)와 그 자리 복각
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
    // 지난 주년은 한 번에 2~3명씩 복각됐다. 간격이 가장 가까운 넷만 후보로 내고 나머지는 근거에 적는다.
    const MAX = 4;
    const why = comps.map(c => ({ text: `${c.occ.date.getFullYear()} ${c.occ.season} ${c.occ.event}`, rows: c.rows }));
    if (occs.some(o => !isFullAnniv(o.season))) why.push({ text: '반주년 복각 없음', rows: [] });
    const rest = cands.slice(MAX);
    if (rest.length) why.push({ text: `기타 후보: ${rest.map(c => c.name).join(', ')}`, rows: [] });
    // 몇 주년인지 - 마지막 주년 번호 + 1
    const lastNo = parseInt(full[full.length - 1].season, 10);
    return {
      family: '주년', title: isFinite(lastNo) ? `${lastNo + 1}주년` : '주년',
      conf: grade(comps), date, exact: regular(full), cands: cands.slice(0, MAX), why,
      track: comps.map(c => ({ label: c.occ.season, text: `${c.hits}/${c.total}`, ok: c.hits === c.total })),
      summary: `복각 간격 ${Math.min(...lags)}~${Math.max(...lags)}일 · 중앙 ${Math.round(mid)}일 기준 순`,
    };
  }

  // ===== 신규 픽업 예측 (사용자 요청, 2026-10-31) =====
  // 시즌마다 지난 신규 캐릭터의 기업 · 버스트 · 우월코드 · 총기 · 유형 중 가장 많았던 값과 그 비율을 보인다.
  // 일반 이벤트와 콜라보는 뺀다(콜라보는 기업 간 협업이라 정기 규칙이 없다, 사용자 결정).
  // 필그림과 오버스펙(기업 끝 "(오)")은 한 범주로 센다 - 일반 기업과는 확률 · 성능이 다르다(사용자 지적).
  // 주년과 반주년은 따로 본다.
  const PICK_SKIP = new Set(['', '일반', '콜라보']);
  const PILGRIM = '필그림 · 오버스펙';
  const pickFam = s => (/^\d+주년$/.test(s) ? '주년' : /^\d+\.5주년$/.test(s) ? '반주년' : s);
  const corpOf = c => (/^필그림/.test(c) || /\(오\)$/.test(c) ? PILGRIM : c);
  const ATTRS = [
    ['기업', p => corpOf(String(p['기업'] || ''))],
    ['버스트', p => String(p['버스트'] || '')],
    ['우월코드', p => p['우월코드'] || ''],
    ['총기', p => p['총기'] || ''],
    ['유형', p => p['유형'] || ''],
  ];
  // 쏠림 단계 - 전원 같으면 매우 높음, 4분의 3 이상이면 높음, 그 밖은 근거 없음.
  // 게임사는 안 겹치게 내려는 쪽과 일관되게 내려는 쪽이 함께 있어서, 절반 남짓 쏠림은 예측 근거가 못 된다(사용자 지적, 2026-10-31).
  // 3명 미만 기록도 근거 없음.
  const PICK_LV = { vhigh: '매우 높음', high: '높음', vlow: '근거 없음' };
  const shareLevel = (hits, total) => {
    const r = total ? hits / total : 0;
    return total < 3 ? 'vlow' : r === 1 ? 'vhigh' : r >= 0.75 ? 'high' : 'vlow';
  };
  const fmtVal = (label, v) => (label === '버스트' ? `${v}버스트` : v);

  function pickupForecast(pickups, today) {
    const list = pickups.filter(p => p['시작일'] && p['니케'] && !p['복각'])
      .map(p => ({ p, f: pickFam(String(p['시즌'] || '')), date: day(p['시작일']) }))
      .filter(x => x.date && !PICK_SKIP.has(x.f))
      .sort((a, b) => a.date - b.date);
    // 회차 - 같은 계열 신규가 60일 안이면 한 회차
    const occ = {};
    list.forEach(x => {
      const arr = occ[x.f] = occ[x.f] || [];
      const last = arr[arr.length - 1];
      if (last && x.date - last.date < 60 * DAY) { last.rows.push(x.p); return; }
      arr.push({ date: x.date, season: x.p['시즌'], event: x.p['이벤트'], rows: [x.p] });
    });
    return Object.entries(occ).map(([f, occs]) => {
      const all = occs.flatMap(o => o.rows);
      // 속성마다 값 분포(도넛)와 가장 많은 값 - 동률이면 고르지 않는다
      const attrs = ATTRS.map(([label, get]) => {
        const cnt = {};
        all.forEach(p => { const v = get(p); if (v) cnt[v] = (cnt[v] || 0) + 1; });
        const dist = Object.entries(cnt).map(([v, n]) => ({ label: fmtVal(label, v), n })).sort((x, y) => y.n - x.n);
        const total = dist.reduce((n, d) => n + d.n, 0);
        const top = Object.keys(cnt).filter(k => cnt[k] === (dist[0] || {}).n);
        const one = top.length === 1;
        return { label, value: one ? top[0] : '', hits: one ? cnt[top[0]] : 0, total, conf: one ? shareLevel(cnt[top[0]], total) : 'vlow', dist };
      });
      // 같은 이벤트 둘째부터 - 첫째와 같은 값이었나 / 다른 값이었나. 4분의 3 이상 한쪽이면 "같음" · "다름"으로 본다.
      // 예) 여름은 기업 · 총기를 나눠 내고 바니걸은 기업을 몰아 낸다(사용자 지적, 2026-10-31).
      const byEv = {};
      all.forEach(p => (byEv[p['이벤트']] = byEv[p['이벤트']] || []).push(p));
      const pairs = ATTRS.map(([label, get]) => {
        let same = 0, total = 0;
        Object.values(byEv).forEach(ps => ps.slice(1).forEach(p => {
          const a = get(ps[0]), b = get(p);
          if (a && b) { total++; if (a === b) same++; }
        }));
        if (total < 3) return null;
        if (same / total >= 0.75) return { label, same: true, hits: same, total };
        if ((total - same) / total >= 0.75) return { label, same: false, hits: total - same, total };
        return null;
      });
      // 마지막 회차에 첫째만 들어와 있으면(3주 안) 그 회차의 둘째를 짐작한다 - 같음이면 첫째 값, 다름이면 첫째 값 제외
      const lastOcc = occs[occs.length - 1];
      const first = lastOcc.rows.length === 1 && lastOcc.date >= new Date(today.getTime() - 21 * DAY)
        && Object.values(byEv).some(ps => ps.length >= 2) ? lastOcc.rows[0] : null;
      if (first) {
        attrs.forEach((a, i) => {
          const pr = pairs[i], v = ATTRS[i][1](first);
          if (!pr || !v) return;
          const same = { label: '첫째와 같음', n: pr.same ? pr.hits : pr.total - pr.hits };
          const diff = { label: '첫째와 다름', n: pr.total - same.n };
          Object.assign(a, {
            value: v, exclude: !pr.same, hits: pr.hits, total: pr.total, conf: shareLevel(pr.hits, pr.total),
            dist: (pr.same ? [same, diff] : [diff, same]).filter(d => d.n),
          });
        });
      }
      // 몇 주년인지 - 마지막 회차 번호 + 1 (3.5주년 -> 4.5주년), 둘째를 짐작할 때는 진행 중인 회차 번호
      const lastNo = parseFloat(lastOcc.season);
      const title = (f === '주년' || f === '반주년') && isFinite(lastNo) ? `${lastNo + (first ? 0 : 1)}주년` : f;
      return {
        family: f, title, count: occs.length, attrs, occs, first,
        pairs: pairs.filter(Boolean),
        date: first ? new Date(lastOcc.date.getTime() + 7 * DAY) : nextDate(occs, today),
        exact: first ? true : regular(occs),
      };
    }).map(c => Object.assign(c, { span: c.exact ? '' : monthSpan(c.occs, c.date) }))
      .sort((a, b) => a.date - b.date);
  }

  // 날짜가 들쭉날쭉한 계열의 시기 - 최근 3회차 중 예상일 45일 안에 든 날짜를 예상 연도로 옮겨 초(1~10일) · 중순 · 말로 묶는다
  function monthSpan(occs, date) {
    const part = d => (d.getDate() <= 10 ? '초' : d.getDate() <= 20 ? '중순' : '말');
    const near = occs.slice(-3).map(o => new Date(date.getFullYear(), o.date.getMonth(), o.date.getDate()))
      .filter(d => Math.abs(d - date) <= 45 * DAY).sort((a, b) => a - b);
    if (!near.length) return '';
    const lo = near[0], hi = near[near.length - 1];
    if (lo.getMonth() !== hi.getMonth()) return `${lo.getMonth() + 1}월 ${part(lo)}~${hi.getMonth() + 1}월 ${part(hi)}`;
    return part(lo) === part(hi) ? part(lo) : `${part(lo)}~${part(hi)}`;
  }

  // 왼쪽 날짜 칸 - 연도 · 월.일 · D-day, 날짜가 들쭉날쭉한 계열은 연도 · 월 · 시기(초 · 중순 · 말)
  function dateBlock(c, today) {
    const md = d => `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    const dday = Math.ceil((c.date - today) / DAY);
    return `
        <div class="predict-date">
          <span class="predict-date-y">${c.date.getFullYear()}</span>
          ${c.exact ? `<b class="predict-date-md">${md(c.date)}</b>
          <em class="predict-date-d">${dday >= 0 ? `D-${dday}` : '지남'}</em>` : `<b class="predict-date-md">${c.date.getMonth() + 1}월</b>
          ${c.span ? `<em class="predict-date-d is-span">${esc(c.span)}</em>` : ''}`}
        </div>`;
  }

  // 속성 아이콘 - 아이콘 표(APP_DATA.iconImg). 필그림 · 오버스펙은 필그림 아이콘
  const iconOf = (label, v) => {
    const icons = ((typeof APP_DATA !== 'undefined' && APP_DATA.iconImg) || {})[label] || {};
    return icons[label === '기업' && v === PILGRIM ? '필그림' : v] || '';
  };

  // 값 분포 도넛 - 가장 많은 값은 단계 색, 나머지는 회색 농도 차례. 조각 사이 2px 틈, 마우스를 올리면 값 · 수
  function donut(dist, total) {
    if (!total) return '';
    const R = 18, C = 2 * Math.PI * R, GAP = dist.length > 1 ? 2 : 0;
    let off = 0;
    const segs = dist.map((d, i) => {
      const len = C * d.n / total;
      const seg = `<circle cx="24" cy="24" r="${R}" class="${i ? 'is-rest' : 'is-top'}" style="--o:${Math.max(0.6 - i * 0.12, 0.18)}"`
        + ` stroke-dasharray="${Math.max(len - GAP, 0.6).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}">`
        + `<title>${esc(d.label)} ${d.n}/${total}</title></circle>`;
      off += len;
      return seg;
    });
    return `<svg class="predict-donut" viewBox="0 0 48 48" role="img" aria-label="${esc(dist.map(d => `${d.label} ${d.n}`).join(', '))}">`
      + `<g transform="rotate(-90 24 24)">${segs.join('')}</g></svg>`;
  }

  function renderPickup(today) {
    const host = document.getElementById('predict-pickup');
    if (!host) return;
    const cards = pickupForecast(APP_DATA.pickup, today);
    // 자세히 - "이름 = {기업, 버스트, 우월코드, 총기, 유형}", 예측과 맞는 값은 초록 체크
    const detail = (c, p) => `${esc(p['니케'])} = {${ATTRS.map(([label, get], i) => {
      const raw = label === '기업' ? String(p['기업'] || '') : get(p);
      if (!raw) return '';
      const a = c.attrs[i];
      const hit = a.conf !== 'vlow' && a.value && !a.exclude && get(p) === a.value;
      return `<span${hit ? ' class="is-hit"' : ''}>${hit ? '✓ ' : ''}${esc(fmtVal(label, raw))}</span>`;
    }).filter(Boolean).join(', ')}}`;
    // 속성 칸 - 이름 · 단계 문구, 도넛(가운데 비율), 아이콘 · 값. 근거 없음이면 값 대신 "-"
    const attrCell = a => {
      const sure = a.conf !== 'vlow' && a.value;
      const icon = sure ? iconOf(a.label, a.value) : '';
      return `
            <div class="predict-attr is-${a.conf}">
              <dt>${esc(a.label)}</dt>
              <dd>
                <span class="predict-donut-wrap">${donut(a.dist, a.total)}${sure ? `<b>${a.hits}/${a.total}</b>` : ''}</span>
                <span class="predict-attr-val">${sure
                  ? `${icon ? `<img class="${a.label === '우월코드' ? 'is-code' : ''}" src="${esc(icon)}" alt="">` : ''}<span>${esc(fmtVal(a.label, a.value))}${a.exclude ? ' 제외' : ''}</span>`
                  : '-'}</span>
                <span class="predict-attr-lv">${PICK_LV[a.conf]}</span>
              </dd>
            </div>`;
    };
    host.innerHTML = cards.length ? `<ol class="predict-timeline">${cards.map((c, i) => `
      <li class="predict-row${i === 0 ? ' is-next' : ''}">
        ${dateBlock(c, today)}
        <article class="predict-card">
          <div class="predict-head">
            <span class="predict-fam">${esc(c.title)}</span>
            <span class="predict-count">기록 ${c.count}회</span>
            ${c.first ? `<span class="predict-count is-first">둘째 · 첫째 ${esc(c.first['니케'])}</span>` : ''}
          </div>
          <dl class="predict-attrs">${c.attrs.map(attrCell).join('')}
          </dl>
          ${c.pairs.length ? `<div class="predict-track">
            <span class="predict-track-label">같은 이벤트 둘째</span>
            ${c.pairs.map(pr => `<span class="predict-chip${pr.hits === pr.total ? ' is-ok' : ''}">${esc(pr.label)} ${pr.same ? '같음' : '다름'} <b>${pr.hits}/${pr.total}</b></span>`).join('')}
          </div>` : ''}
          <details class="predict-why">
            <summary>자세히</summary>
            <ul>${c.occs.map(o => `<li><span>${o.date.getFullYear()} ${esc(o.season)} ${esc(o.event)}</span><span class="predict-hits is-list">${o.rows.map(p =>
              `<i>${detail(c, p)}</i>`).join('')}</span></li>`).join('')}</ul>
          </details>
        </article>
      </li>`).join('')}</ol>` : '<p class="predict-empty">예측 없음</p>';
  }

  const CONF_LABEL = { vhigh: '매우 높음', high: '높음', mid: '중간', low: '낮음', vlow: '매우 낮음' };

  function render() {
    const host = document.getElementById('predict-list');
    if (!host || typeof APP_DATA === 'undefined' || !APP_DATA.pickup) return;
    const today = new Date();
    renderPickup(today);
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

    // 세로 시간줄 - 왼쪽에 예상 날짜, 오른쪽에 후보 그림. 가까운 것부터 위에서 아래로.
    host.innerHTML = cards.length ? `<ol class="predict-timeline">${cards.map((c, i) => {
      return `
      <li class="predict-row is-${c.conf}${i === 0 ? ' is-next' : ''}">
        ${dateBlock(c, today)}
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

  // 픽업 / 복각 보기 전환
  document.querySelectorAll('#predict-view-btns .pickup-view-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('#predict-view-btns .pickup-view-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.predict-pane').forEach(p => { p.hidden = p.id !== `predict-${btn.dataset.pview}`; });
  }));

  let rendered = false;
  document.addEventListener('mmr:tab-change', e => {
    if (!e.detail || e.detail.tab !== 'predict') return;
    if (typeof onAppDataReady === 'function') onAppDataReady(() => { if (!rendered) { rendered = true; render(); } });
  });
  window.renderPickupPredict = render;
})();
