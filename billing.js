'use strict';
// ---- 有料版（月額480円）：パスキーの会員・Stripe の支払い・全ステージ ----
// サーバーは guitar-billing（このサイトの /api/*）。index.html の本体より先に読み込み、本体の定数・関数は関数の中でだけ使う
// 読譜トレーナーの billing.js が元（練習の記録の同期はまだない）

// 有料版の案内を出すか。止めるときは false にする（そのときは stages.js も全部入りに戻す）
const BILLING_ON = true;
const PRICE_LABEL = '月480円';

let account = { signedIn: false, paid: false, name: '', customer: false, periodEnd: 0, cancelAtEnd: false };

const apiPost = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー（${res.status}）`);
  return data;
};
const apiGet = async (url) => {
  const res = await fetch(url, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー（${res.status}）`);
  return data;
};

// 知らせ（順番に1つずつ。ダイアログより手前に出すため popover で最前面に置く）
let toastQueue = Promise.resolve();
const toast = (msg) => {
  toastQueue = toastQueue.then(() => new Promise((done) => {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = msg;
    if (typeof el.showPopover === 'function') el.popover = 'manual';
    document.body.appendChild(el);
    if (el.popover) el.showPopover();
    setTimeout(() => { el.remove(); done(); }, 4000);
  }));
};

// ---- パスキー（学習記録 my.habatakijuku.com の app.js と同じ変換） ----
const toBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const toB64url = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const creationOptions = (o) => ({
  ...o,
  challenge: toBytes(o.challenge),
  user: { ...o.user, id: toBytes(o.user.id) },
  excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })),
});
const requestOptions = (o) => ({
  ...o,
  challenge: toBytes(o.challenge),
  allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })),
});
const registrationJSON = (cred) => ({
  id: cred.id,
  rawId: toB64url(cred.rawId),
  type: cred.type,
  response: {
    clientDataJSON: toB64url(cred.response.clientDataJSON),
    attestationObject: toB64url(cred.response.attestationObject),
    transports: cred.response.getTransports ? cred.response.getTransports() : [],
  },
  clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
  authenticatorAttachment: cred.authenticatorAttachment || undefined,
});
const authenticationJSON = (cred) => ({
  id: cred.id,
  rawId: toB64url(cred.rawId),
  type: cred.type,
  response: {
    clientDataJSON: toB64url(cred.response.clientDataJSON),
    authenticatorData: toB64url(cred.response.authenticatorData),
    signature: toB64url(cred.response.signature),
    userHandle: cred.response.userHandle ? toB64url(cred.response.userHandle) : undefined,
  },
  clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
  authenticatorAttachment: cred.authenticatorAttachment || undefined,
});
const explainPasskey = (e) =>
  e && e.name === 'NotAllowedError' ? 'パスキーの操作が取り消されたか、時間切れになりました。' :
  e && e.name === 'InvalidStateError' ? 'この端末のパスキーは、もう登録してあります。' :
  (e && e.message) || 'パスキーを使えませんでした。';

// ---- 会員の状態と全ステージ ----
const refreshAccount = async () => {
  account = await apiGet('/api/me');
  if (account.paid) await loadFullStages();
  renderPlan();
};

// 有料版の人は、全ステージに差し替える（TAB_STAGES なども同じ配列を指しているので、中身を入れ替える）
const loadFullStages = async () => {
  if (!hasLocked()) return;
  const { stages } = await apiGet('/api/stages');
  for (const m of Object.keys(STAGES)) {
    if (Array.isArray(stages[m])) STAGES[m].splice(0, STAGES[m].length, ...stages[m]);
  }
  if (view === 'home') renderHome();
  if (view === 'play' && !run) renderStageInfo();
};

const dateLabel = (secs) => {
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

const planBtn = (id, label, cls) => `<button type="button" data-plan="${id}"${cls ? ` class="${cls}"` : ''}>${label}</button>`;

const renderPlan = () => {
  if (!BILLING_ON) return;
  $('planField').hidden = false;
  let status;
  let btns;
  if (account.paid) {
    status = `有料版をお使いです（${account.name}）。${account.cancelAtEnd ? `${dateLabel(account.periodEnd)}で終了します` : `次の更新日は${dateLabel(account.periodEnd)}です`}。`;
    btns = planBtn('portal', 'お支払い・解約', 'ghost') + planBtn('security', 'ログインと端末', 'ghost') + planBtn('logout', 'ログアウト', 'ghost');
  } else if (account.signedIn) {
    status = `${account.name} でログイン中。有料版にすると、全30ステージを練習できます（${PRICE_LABEL}）。`;
    btns = planBtn('buy', `有料版にする（${PRICE_LABEL}）`) + (account.customer ? planBtn('portal', 'お支払いの履歴', 'ghost') : '') + planBtn('security', 'ログインと端末', 'ghost') + planBtn('logout', 'ログアウト', 'ghost');
  } else {
    status = `無料で使えるのは、各道の最初の3ステージです。有料版（${PRICE_LABEL}）にすると、全30ステージを練習できます。`;
    btns = planBtn('buy', `有料版にする（${PRICE_LABEL}）`) + planBtn('login', 'ログイン（申し込み済みの方）', 'ghost');
  }
  $('planStatus').textContent = status + (account.signedIn && !account.hasEmail ? '（「ログインと端末」でメールアドレスを登録しておくと、端末をなくしても自分でログインし直せます）' : '');
  $('planBtns').innerHTML = btns;
};

// 有料のステージを押したときの案内
const showUpsell = () => {
  if (!BILLING_ON) return;
  $('upsellMsg').textContent = account.signedIn
    ? `${account.name} でログイン中です。有料版（${PRICE_LABEL}）にすると、このステージから先も練習できます。`
    : `有料版（${PRICE_LABEL}）にすると、このステージから先も練習できます。申し込みにはパスキー（指紋・顔・PINでログインするしくみ）を使い、パスワードやメールアドレスは要りません。`;
  $('upsellBtns').innerHTML = planBtn('buy', `有料版にする（${PRICE_LABEL}）`, 'gold')
    + (account.signedIn ? '' : planBtn('login', 'ログイン（申し込み済みの方）', 'ghost'));
  if (!$('upsellDlg').open) $('upsellDlg').showModal();
};

// ---- 申し込み・ログインの画面 ----
const openAcct = (v, message = '') => {
  const dlg = $('acctDlg');
  dlg.querySelectorAll('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== v; });
  $('acctMsg').textContent = message;
  $('acctMsg').hidden = !message;
  $('acctError').hidden = true;
  if (!dlg.open) dlg.showModal();
};
const acctError = (msg) => {
  $('acctError').textContent = msg;
  $('acctError').hidden = false;
};
const closeAcct = () => { if ($('acctDlg').open) $('acctDlg').close(); };

let afterSignIn = null; // ログインできたら続けてすること（申し込みなど）

const startCheckout = async () => {
  const { url } = await apiPost('/api/checkout');
  location.href = url;
};

const buyPlan = async () => {
  if (!account.signedIn) {
    afterSignIn = startCheckout;
    openAcct('register', '有料版の申し込みには、ギタートレーナー用のパスキー（指紋・顔・PINでログインするしくみ）を使います。パスワードやメールアドレスは要りません。');
    return;
  }
  await startCheckout();
};

const signedInDone = async (recovery) => {
  await refreshAccount();
  const next = () => {
    closeAcct();
    const fn = afterSignIn;
    afterSignIn = null;
    if (fn) fn().catch((e) => alert(e.message));
  };
  if (!recovery) return next();
  // 復旧コードは1回だけ見せる
  $('acctRecovery').textContent = recovery;
  openAcct('recovery');
  $('acctRecoveryDone').onclick = next;
};

const registerPasskey = async () => {
  if (!window.PublicKeyCredential) return acctError('このブラウザはパスキーに対応していません。新しいブラウザで開いてください。');
  try {
    const opt = await apiPost('/api/register/options', { name: $('acctName').value });
    const cred = await navigator.credentials.create({ publicKey: creationOptions(opt) });
    const done = await apiPost('/api/register/verify', { response: registrationJSON(cred) });
    // メールアドレス（任意）を入れていたら、確認メールを送る
    const mail = $('acctEmail').value.trim();
    if (mail) {
      await apiPost('/api/email/start', { email: mail })
        .then(() => pairToast('確認メールを送りました。メールのリンクを開くと登録が終わります'))
        .catch((e) => pairToast(`確認メールを送れませんでした（${e.message}）。設定の「ログインと端末」から送り直せます`));
    }
    await signedInDone(done.recovery);
  } catch (e) {
    acctError(explainPasskey(e));
  }
};

const loginPasskey = async () => {
  if (!window.PublicKeyCredential) return acctError('このブラウザはパスキーに対応していません。');
  try {
    const opt = await apiPost('/api/login/options');
    const cred = await navigator.credentials.get({ publicKey: requestOptions(opt) });
    await apiPost('/api/login/verify', { response: authenticationJSON(cred) });
    await signedInDone('');
  } catch (e) {
    acctError(explainPasskey(e));
  }
};

const recoverAccount = async () => {
  try {
    const done = await apiPost('/api/recover', { code: $('acctCode').value });
    // 使った復旧コードは無効になるので新しいコードを見せ、この端末のパスキーを作ってもらう
    // （iPhone の Safari はボタンを押した直後でないと作れないので、「この端末にパスキーを作る」のボタンを出す）
    afterSignIn = async () => {
      pairPending = true;
      openAcct('pairKey');
      pairOpt = await apiPost('/api/passkey/options').catch(() => null);
    };
    await signedInDone(done.recovery);
  } catch (e) {
    acctError(e.message);
  }
};

const pairNote = (m) => pairToast(m);
// ---- 別の端末でログイン：ログイン中の端末に8けたの番号を出し、新しい端末で入れる ----
let pairTimer = 0;
const showPairCode = async () => {
  clearTimeout(pairTimer);
  openAcct('pairOut');
  $('pairShow').textContent = '…';
  $('pairLeft').textContent = '';
  const { code, expiresIn } = await apiPost('/api/pair/start');
  $('pairShow').textContent = `${code.slice(0, 4)} ${code.slice(4)}`;
  const end = Date.now() + expiresIn * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    if (!$('acctDlg').open) return;
    if (!left) { $('pairShow').textContent = '時間切れ'; $('pairLeft').textContent = '「番号を出し直す」を押してください。'; return; }
    $('pairLeft').textContent = `あと ${Math.floor(left / 60)}分${String(left % 60).padStart(2, '0')}秒有効・1回だけ使えます`;
    pairTimer = setTimeout(tick, 1000);
  };
  tick();
};

// 知らせ（画面の下に3秒。順番に1つずつ出し、ダイアログより手前に出すため popover で最前面に置く）
let pairToastQueue = Promise.resolve();
const pairToast = (text) => {
  // アプリに toast（順番待ちあり）があれば、それと同じ列に並べる（2つ重ならないように）
  if (typeof toast === 'function') { toast(text); return; }
  pairToastQueue = pairToastQueue.then(() => new Promise((done) => {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = text;
    if (typeof el.showPopover === 'function') el.popover = 'manual';
    document.body.appendChild(el);
    if (el.popover) el.showPopover();
    setTimeout(() => { el.remove(); done(); }, 3200);
  }));
};
// 番号でログインしたら「この端末にパスキーを作る」画面を出す（iPhone の Safari は、ボタンを押した直後でないとパスキーを作れないので、押してもらう）
let pairOpt = null;
let pairPending = false;
const claimPair = async () => {
  try {
    await apiPost('/api/pair/claim', { code: $('pairCode').value });
    $('pairCode').value = '';
    pairPending = true;
    openAcct('pairKey');
    // 押した瞬間にすぐ作れるよう、先に合言葉をもらっておく
    pairOpt = await apiPost('/api/passkey/options').catch(() => null);
  } catch (e) {
    acctError(e.message);
  }
};
const makePairPasskey = async () => {
  if (!window.PublicKeyCredential) return acctError('このブラウザはパスキーに対応していません。新しいブラウザで開いてください。');
  try {
    const opt = pairOpt || await apiPost('/api/passkey/options');
    pairOpt = null;
    const cred = await navigator.credentials.create({ publicKey: creationOptions(opt) });
    await apiPost('/api/passkey/verify', { response: registrationJSON(cred) });
    closeAcct();
    pairToast('この端末にパスキーを作りました。次からはこの端末だけでログインできます');
  } catch (e) {
    pairOpt = null;
    acctError(`${explainPasskey(e)}　もう一度「この端末にパスキーを作る」を押してください。`);
  }
};

// ---- ログインと端末：メールアドレス（ログインの戻り道）・パスキーのある端末・ほかの端末のログアウト（*-billing の src/account.ts） ----
const dateShort = (secs) => { const d = new Date(secs * 1000); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
const renderSecurity = (info) => {
  const has = !!info.email;
  $('secEmailState').textContent = has
    ? `登録済み：${info.email}（パスキーも復旧コードもなくしたとき、ここにログインのリンクを送れます）`
    : 'まだ登録されていません。登録しておくと、パスキーも復旧コードもなくしたとき、このメールにログインのリンクを送れます。';
  $('secEmail').value = has ? '' : (info.suggest || '');
  $('secEmail').placeholder = has ? '変えるときは、新しいメールアドレス' : 'you@example.com';
  $('secEmailBtn').textContent = has ? 'メールアドレスを変える' : '確認メールを送る';
  $('secEmailRemove').hidden = !has;
  const ul = $('secDevices');
  ul.textContent = '';
  info.devices.forEach((d) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${d.label}${d.current ? '（この端末）' : ''}`;
    li.append(name);
    if (info.devices.length > 1) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link';
      b.dataset.removeDevice = String(d.id);
      b.textContent = '外す';
      li.append(b);
    }
    const meta = document.createElement('small');
    meta.textContent = `${dateShort(d.createdAt)} に作成${d.lastUsedAt ? `・最後に使ったのは ${dateShort(d.lastUsedAt)}` : ''}${d.synced ? '・iCloud などで同期' : ''}`;
    li.append(meta);
    ul.append(li);
  });
  $('secSessions').textContent = `ログイン中のブラウザ：${info.sessions}つ（この端末をふくむ）`;
};
const openSecurity = async () => {
  openAcct('security');
  $('secDevices').textContent = '読み込み中…';
  renderSecurity(await apiGet('/api/account'));
};
const secAction = async (fn, okMsg) => {
  try {
    $('acctError').hidden = true;
    await fn();
    if (okMsg) pairToast(okMsg);
    renderSecurity(await apiGet('/api/account'));
  } catch (e) {
    acctError(e.message);
  }
};

// メールでログイン：登録したメールにリンクを送る
const sendLoginMail = async () => {
  try {
    $('acctError').hidden = true;
    await apiPost('/api/email/login', { email: $('mailLoginAddr').value });
    $('mailLoginDone').hidden = false;
  } catch (e) {
    acctError(e.message);
  }
};

// メールのリンク（?mail=verify|login&t=…）から来たとき
const handleMailLink = async () => {
  const q = new URLSearchParams(location.search);
  const kind = q.get('mail');
  const t = q.get('t');
  if (!kind || !t) return;
  history.replaceState(null, '', location.pathname);
  try {
    if (kind === 'verify') {
      const { email } = await apiPost('/api/email/verify', { token: t });
      pairToast(`メールアドレス（${email}）を登録しました`);
    } else if (kind === 'login') {
      await apiPost('/api/email/claim', { token: t });
      // 記録の同期でページが読み直されても、パスキーを作る画面を出せるように覚えておく
      try { sessionStorage.setItem('needPasskey', '1'); } catch (e) { console.warn('sessionStorage を使えません', e); }
    }
  } catch (e) {
    alert(e.message);
  }
};
// メールのリンクでログインしたら、この端末にパスキーを作る画面を出す（ボタンを押して作る）
const offerPasskeyAfterLink = () => {
  let need = false;
  try {
    need = sessionStorage.getItem('needPasskey') === '1';
    sessionStorage.removeItem('needPasskey');
  } catch (e) {
    console.warn('sessionStorage を使えません', e);
  }
  if (!need || !account.signedIn) return;
  pairPending = true;
  openAcct('pairKey');
  apiPost('/api/passkey/options').then((o) => { pairOpt = o; }).catch(() => { pairOpt = null; });
};

const onPlanButton = async (what) => {
  try {
    if ($('upsellDlg').open) $('upsellDlg').close();
    if (what === 'buy') await buyPlan();
    else if (what === 'login') { afterSignIn = null; openAcct('login'); }
    else if (what === 'pair') await showPairCode();
    else if (what === 'security') await openSecurity();
    else if (what === 'portal') location.href = (await apiPost('/api/portal')).url;
    else if (what === 'logout') {
      await apiPost('/api/logout');
      location.reload();
    }
  } catch (e) {
    alert(e.message);
  }
};

// 支払い画面から戻ってきたとき
const handleCheckoutReturn = async () => {
  const q = new URLSearchParams(location.search);
  const result = q.get('checkout');
  if (!result) return;
  history.replaceState(null, '', location.pathname);
  if (result === 'cancel') {
    toast('申し込みは取り消されました');
    return;
  }
  const sessionId = q.get('session_id');
  if (result === 'done' && sessionId) {
    account = await apiPost('/api/checkout/confirm', { sessionId });
    if (account.paid) {
      await loadFullStages();
      toast('ありがとうございます。有料版になりました。全ステージを練習できます');
    } else {
      toast('お支払いの確認に時間がかかっています。少ししてから開き直してください');
    }
    renderPlan();
  }
};

const initBilling = () => {
  if (!BILLING_ON) return;
  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button[data-plan]') : null;
    if (b) onPlanButton(b.dataset.plan);
  });
  $('acctRegisterBtn').addEventListener('click', registerPasskey);
  $('acctLoginBtn').addEventListener('click', loginPasskey);
  $('acctRecoverBtn').addEventListener('click', recoverAccount);
  $('pairClaimBtn').addEventListener('click', claimPair);
  $('pairKeyBtn').addEventListener('click', makePairPasskey);
  // パスキーを作る画面を閉じたら（作っても・あとにしても）、ログインした状態を読み直す
  $('acctDlg').addEventListener('close', () => {
    if (!pairPending) return;
    pairPending = false;
    refreshAccount().catch((e) => console.warn('ログインの状態を読み直せませんでした', e));
  });
  $('pairCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') claimPair(); });
  $('pairNewBtn').addEventListener('click', () => showPairCode().catch((e) => acctError(e.message)));
  $('mailLoginBtn').addEventListener('click', sendLoginMail);
  $('mailLoginAddr').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLoginMail(); });
  $('secEmailBtn').addEventListener('click', () => secAction(() => apiPost('/api/email/start', { email: $('secEmail').value }), '確認メールを送りました。メールのリンクを開くと登録が終わります'));
  $('secEmailRemove').addEventListener('click', () => {
    if (confirm('メールアドレスの登録を消しますか？')) secAction(() => apiPost('/api/email/remove'), 'メールアドレスの登録を消しました');
  });
  $('secDevices').addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-remove-device]') : null;
    if (btn && confirm('この端末のパスキーを外しますか？その端末はログアウトされます。')) {
      secAction(() => apiPost('/api/devices/remove', { id: Number(btn.dataset.removeDevice) }), '端末を外しました');
    }
  });
  $('secPair').addEventListener('click', () => showPairCode().catch((e) => acctError(e.message)));
  $('secLogoutOthers').addEventListener('click', () => {
    if (confirm('この端末のほかを、すべてログアウトしますか？')) secAction(() => apiPost('/api/sessions/logout-others'), 'ほかの端末をログアウトしました');
  });
  $('acctDlg').addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-goto]') : null;
    if (b) openAcct(b.dataset.goto);
  });
  $('acctClose').addEventListener('click', () => { afterSignIn = null; closeAcct(); });
  renderPlan();
  handleMailLink()
    .then(refreshAccount)
    .then(offerPasskeyAfterLink)
    .then(handleCheckoutReturn)
    .catch((e) => console.warn('有料版の状態を確かめられませんでした', e));
};
