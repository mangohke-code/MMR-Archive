// ===== 문의 탭 =====
//
// 제목·내용(필수)과 답변 받을 이메일(선택)을 받아서 Supabase 의 "문의" 표에 쓴다.
// 방문자는 쓰기만 할 수 있고 읽지는 못한다(읽기는 대시보드에서만).
//
// 스팸은 DB 에서 막는다 — 사이트 키가 공개라 이 화면을 거치지 않고 표에 바로 넣을 수
// 있기 때문에, 화면 쪽 검사는 우회당한다. DB 쪽에 걸어 둔 것:
//   - 쓸 수 있는 칸은 제목·내용·이메일 셋뿐(번호·작성일·처리는 못 건드린다)
//   - 제목 1~100자, 내용 5~2000자, 이메일은 비우거나 주소 모양(254자까지)
//   - 10분에 10건, 하루 50건, 처리 안 된 문의가 500건 차면 받지 않는다
//   - 하루 안에 같은 내용은 한 번만
// 여기서 하는 검사(숨은 칸·너무 빠른 제출·1분 쉬기)는 봇이 대충 긁는 것을 줄이는
// 보조일 뿐이다.
(function () {
  const MAX_SUBJECT = 100;
  const MIN_BODY = 5;
  const MAX_BODY = 2000;
  const MIN_OPEN_MS = 3000;          // 탭을 열고 이보다 빨리 보내면 사람이 아닌 걸로 본다
  const COOLDOWN_MS = 60 * 1000;     // 한 번 보내면 1분은 쉰다
  const LAST_KEY = 'mmr_contact_last';
  // DB 의 검사와 같은 모양. 여기서 먼저 걸러야 사람이 오타를 바로 고칠 수 있다.
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  let openedAt = Date.now();

  const $ = id => document.getElementById(id);

  function lastSent() {
    try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch (e) { return 0; }
  }

  function setStatus(msg, kind) {
    const el = $('contact-status');
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }

  function values() {
    return {
      subject: $('contact-subject').value.trim(),
      body: $('contact-body').value.trim(),
      email: $('contact-email').value.trim(),
    };
  }

  function emailOk(email) {
    return !email || (email.length <= 254 && EMAIL_RE.test(email));
  }

  function sync() {
    const v = values();
    $('contact-count').textContent = `${$('contact-body').value.length} / ${MAX_BODY}`;
    $('contact-email').classList.toggle('is-invalid', !emailOk(v.email));
    $('contact-send').disabled = !v.subject || v.body.length < MIN_BODY || !emailOk(v.email);
  }

  async function send() {
    const v = values();
    if (!v.subject || v.body.length < MIN_BODY || !emailOk(v.email)) return;

    // 숨은 칸이 채워져 있거나 너무 빨리 보냈으면 봇으로 본다. 봇에게 막혔다는 걸
    // 알려 주면 방법을 바꾸니, 보낸 것처럼 보이게만 하고 실제로는 안 보낸다.
    if ($('contact-hp').value || Date.now() - openedAt < MIN_OPEN_MS) {
      done();
      return;
    }

    const wait = COOLDOWN_MS - (Date.now() - lastSent());
    if (wait > 0) {
      setStatus(`방금 보내셨어요. ${Math.ceil(wait / 1000)}초 뒤에 다시 보낼 수 있어요.`, 'warn');
      return;
    }

    $('contact-send').disabled = true;
    setStatus('보내는 중…', '');
    let res;
    try {
      res = await supabaseClient.from('문의').insert({
        제목: v.subject,
        내용: v.body,
        이메일: v.email || null,
      });
    } catch (e) {
      res = { error: e };
    }

    if (res && res.error) {
      // DB 의 제한(너무 많음·같은 내용)은 사람이 읽을 문장으로 돌려준다(P0001)
      const msg = res.error.code === 'P0001' && res.error.message
        ? res.error.message
        : '보내지 못했어요. 잠시 뒤에 다시 시도해 주세요.';
      setStatus(msg, 'error');
      sync();
      return;
    }

    try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch (e) { /* 무시 */ }
    done();
  }

  function done() {
    $('contact-subject').value = '';
    $('contact-body').value = '';
    $('contact-email').value = '';
    sync();
    setStatus('보냈어요. 알려 주셔서 고마워요!', 'ok');
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('tab-contact')) return;

    $('contact-subject').maxLength = MAX_SUBJECT;
    $('contact-body').maxLength = MAX_BODY;
    ['contact-subject', 'contact-body', 'contact-email'].forEach(id =>
      $(id).addEventListener('input', sync));
    $('contact-send').addEventListener('click', send);

    // 푸터의 "문의" 링크. 탭을 옮기고 맨 위로 올린다.
    document.querySelectorAll('.contact-open-btn').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      switchTab('contact');
      window.scrollTo(0, 0);
    }));
    sync();
  });

  // 너무 빨리 보냈는지는 탭을 연 때부터 잰다
  document.addEventListener('mmr:tab-change', e => {
    if (e.detail && e.detail.tab === 'contact') {
      openedAt = Date.now();
      setStatus('');
    }
  });
})();
