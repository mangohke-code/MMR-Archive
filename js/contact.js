// ===== 문의 탭 =====
//
// 내용 하나만 받는다(사용자 요청, 2026-10-30 - 제목 · 이메일 없앰).
// 기본은 공개라 Supabase 의 "문의" 표에 쓰고, 아래 목록에 내용 · 상태 · 운영자 답변이 보인다.
// '비공개로 보내기' 를 고르면 "문의_비공개" 표에 쓴다. 그쪽은 방문자가 못 읽는다.
// 상태(접수 · 처리 중 · 처리 완료 · 숨김)와 답변은 운영자가 대시보드에서 고친다. 숨김은 목록에서 빠진다.
//
// 스팸은 DB 에서 막는다 — 사이트 키가 공개라 이 화면을 거치지 않고 표에 바로 넣을 수
// 있기 때문에, 화면 쪽 검사는 우회당한다. DB 쪽에 걸어 둔 것(두 표를 합쳐서 센다):
//   - 쓸 수 있는 칸은 내용 하나뿐(번호 · 작성일 · 상태 · 답변은 못 건드린다)
//   - 내용 5~1000자
//   - 10분에 10건, 하루 50건, 접수 상태로 쌓인 문의가 500건 차면 받지 않는다
//   - 하루 안에 같은 내용은 한 번만
// 여기서 하는 검사(숨은 칸 · 너무 빠른 제출 · 1분 쉬기)는 봇이 대충 긁는 것을 줄이는
// 보조일 뿐이다.
(function () {
  const MIN_BODY = 5;
  const MAX_BODY = 1000;
  const MIN_OPEN_MS = 3000;          // 탭을 열고 이보다 빨리 보내면 사람이 아닌 걸로 본다
  const COOLDOWN_MS = 60 * 1000;     // 한 번 보내면 1분은 쉰다
  const LAST_KEY = 'mmr_contact_last';
  const PAGE = 10;                   // 목록을 한 번에 이만큼씩
  const COLS = '번호,내용,작성일,상태,답변,답변일';
  // 상태 → 칩 모양. DB 의 문의_상태 형식과 같은 값
  const STATUS_CLASS = { '접수': 'is-new', '처리 중': 'is-doing', '처리 완료': 'is-done' };

  let openedAt = Date.now();
  let loaded = 0;          // 목록에 그린 개수
  let total = null;        // 보이는 문의 전체 개수
  let loading = false;
  let boardStarted = false;

  const $ = id => document.getElementById(id);
  const esc = t => String(t === null || t === undefined ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function lastSent() {
    try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch (e) { return 0; }
  }

  function setStatus(msg, kind) {
    const el = $('contact-status');
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }

  function sync() {
    const body = $('contact-body').value.trim();
    $('contact-count').textContent = `${$('contact-body').value.length} / ${MAX_BODY}`;
    $('contact-send').disabled = body.length < MIN_BODY;
    const priv = $('contact-private').checked;
    $('contact-private-note').hidden = !priv;
    $('contact-private-wrap').classList.toggle('is-on', priv);
  }

  async function send() {
    const body = $('contact-body').value.trim();
    const priv = $('contact-private').checked;
    if (body.length < MIN_BODY) return;

    // 숨은 칸이 채워져 있거나 너무 빨리 보냈으면 봇으로 본다. 봇에게 막혔다는 걸
    // 알려 주면 방법을 바꾸니, 보낸 것처럼 보이게만 하고 실제로는 안 보낸다.
    if ($('contact-hp').value || Date.now() - openedAt < MIN_OPEN_MS) {
      done(priv);
      return;
    }

    const wait = COOLDOWN_MS - (Date.now() - lastSent());
    if (wait > 0) {
      setStatus(`방금 보내셨어요. ${Math.ceil(wait / 1000)}초 뒤에 다시 보낼 수 있어요.`, 'warn');
      return;
    }

    // 보내기 전에 한 번 더 묻는다(사용자 요청, 2026-10-10). 공개 문의는 바로 목록에 올라가므로 그것도 알려 준다.
    if (!(await confirmSend(body, priv))) return;

    $('contact-send').disabled = true;
    setStatus('보내는 중…', '');
    let res;
    try {
      res = await supabaseClient.from(priv ? '문의_비공개' : '문의').insert({ 내용: body });
    } catch (e) {
      res = { error: e };
    }

    if (res && res.error) {
      // DB 의 제한(너무 많음 · 같은 내용)은 사람이 읽을 문장으로 돌려준다(P0001)
      const msg = res.error.code === 'P0001' && res.error.message
        ? res.error.message
        : '보내지 못했어요. 잠시 뒤에 다시 시도해 주세요.';
      setStatus(msg, 'error');
      sync();
      return;
    }

    try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch (e) { /* 무시 */ }
    done(priv);
    if (!priv) reloadBoard();
  }

  // 보낼 내용을 보여 주고 보낼지 묻는다. 확인 창은 처음 한 번만 만든다.
  // 답은 단추 누름으로 바로 받는다 - dialog 의 close 사건은 브라우저에 따라 늦게 오거나 안 와서 기대지 않는다.
  let confirmFinish = null;
  function confirmSend(body, priv) {
    let dlg = $('contact-confirm');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'contact-confirm';
      // 안쪽 상자에 여백을 둔다 - 창 자체를 누른 것(= 바깥 어두운 바탕)과 구분하려고
      dlg.innerHTML = `<div class="cc-box">
        <h3 class="cc-title">문의를 보낼까요?</h3>
        <dl class="cc-summary">
          <dt>내용</dt><dd class="cc-body"></dd>
          <dt>공개</dt><dd class="cc-public"></dd>
        </dl>
        <div class="cc-actions">
          <button type="button" class="cc-cancel">취소</button>
          <button type="button" class="cc-send">보내기</button>
        </div></div>`;
      document.body.appendChild(dlg);
      const answer = ok => { if (confirmFinish) confirmFinish(ok); };
      dlg.querySelector('.cc-cancel').addEventListener('click', () => answer(false));
      dlg.querySelector('.cc-send').addEventListener('click', () => answer(true));
      // Esc · 바깥(어두운 바탕) 누름은 취소
      dlg.addEventListener('cancel', e => { e.preventDefault(); answer(false); });
      dlg.addEventListener('click', e => { if (e.target === dlg) answer(false); });
    }
    dlg.querySelector('.cc-body').textContent = body.length > 140 ? body.slice(0, 140) + '…' : body;
    const pub = dlg.querySelector('.cc-public');
    pub.textContent = priv ? '비공개 - 운영자만 봐요' : '공개 - 아래 목록에 바로 올라가요';
    pub.classList.toggle('is-empty', !priv);
    return new Promise(resolve => {
      confirmFinish = ok => {
        confirmFinish = null;
        if (dlg.open) dlg.close();
        resolve(ok);
      };
      dlg.showModal();
      dlg.querySelector('.cc-send').focus();
    });
  }

  function done(priv) {
    $('contact-body').value = '';
    $('contact-private').checked = false;
    sync();
    setStatus(priv ? '보냈어요. 알려 주셔서 고마워요!' : '보냈어요. 아래 목록에 올라갔어요.', 'ok');
  }

  // ===== 문의 목록 =====

  function fmtDate(v) {
    const d = new Date(v);
    if (isNaN(d)) return '';
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  function itemHtml(r) {
    const st = r['상태'] || '접수';
    const answer = r['답변'] ? `
      <div class="contact-answer">
        <div class="contact-answer-head"><b>운영자 답변</b>${r['답변일'] ? `<time>${fmtDate(r['답변일'])}</time>` : ''}</div>
        <p>${esc(r['답변'])}</p>
      </div>` : '';
    return `
      <li class="contact-item">
        <div class="contact-item-head">
          <span class="contact-no">#${esc(r['번호'])}</span>
          <time>${fmtDate(r['작성일'])}</time>
          <span class="contact-state ${STATUS_CLASS[st] || ''}">${esc(st)}</span>
        </div>
        <p class="contact-item-body">${esc(r['내용'])}</p>
        ${answer}
      </li>`;
  }

  async function loadMore() {
    if (loading) return;
    loading = true;
    $('contact-more').disabled = true;
    let res;
    try {
      res = await supabaseClient.from('문의').select(COLS, { count: 'exact' })
        .order('작성일', { ascending: false }).range(loaded, loaded + PAGE - 1);
    } catch (e) {
      res = { error: e };
    }
    loading = false;
    $('contact-more').disabled = false;
    const list = $('contact-list');
    if (res.error) {
      if (!loaded) list.innerHTML = '<li class="contact-empty">목록을 불러오지 못했어요.</li>';
      $('contact-more').hidden = true;
      return;
    }
    const rows = res.data || [];
    if (typeof res.count === 'number') total = res.count;
    if (!loaded && !rows.length) list.innerHTML = '<li class="contact-empty">아직 올라온 문의가 없어요.</li>';
    else list.insertAdjacentHTML('beforeend', rows.map(itemHtml).join(''));
    loaded += rows.length;
    $('contact-board-count').textContent = total ? `${total}건` : '';
    $('contact-more').hidden = total === null ? rows.length < PAGE : loaded >= total;
  }

  function reloadBoard() {
    loaded = 0;
    total = null;
    $('contact-list').innerHTML = '';
    loadMore();
  }

  // 문의 탭을 처음 열 때 한 번만 불러온다
  function startBoard() {
    if (boardStarted) return;
    boardStarted = true;
    loadMore();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('tab-contact')) return;

    $('contact-body').maxLength = MAX_BODY;
    $('contact-body').addEventListener('input', sync);
    $('contact-private').addEventListener('change', sync);
    $('contact-send').addEventListener('click', send);
    $('contact-more').addEventListener('click', loadMore);

    // 푸터의 "문의" 링크. 탭을 옮기고 맨 위로 올린다.
    document.querySelectorAll('.contact-open-btn').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      switchTab('contact');
      window.scrollTo(0, 0);
    }));
    sync();
    if ($('tab-contact').classList.contains('active')) startBoard();
  });

  // 너무 빨리 보냈는지는 탭을 연 때부터 잰다
  document.addEventListener('mmr:tab-change', e => {
    if (e.detail && e.detail.tab === 'contact') {
      openedAt = Date.now();
      setStatus('');
      startBoard();
    }
  });
})();
