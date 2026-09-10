'use strict';
const $ = id => document.getElementById(id);
const networkNames = { 'wifi-no-vpn':'Wi-Fi без VPN', 'mobile-no-vpn':'Мобильная сеть без VPN', 'wifi-vpn':'Wi-Fi с VPN', 'mobile-vpn':'Мобильная сеть с VPN' };
const stateNames = { locked:'Экран заблокирован', background:'Приложение в фоне', closed:'Приложение закрыто' };
const connectionKey = 'procedure-push-connection-v1';
let connection, publicKey, registration, subscription, activeId, storageReady = false, busy = false;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const supported = isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function controls() {
  const canUse = supported && !(isIOS && !standalone) && storageReady && registration;
  $('allow').disabled = !canUse || !publicKey || busy || !!subscription;
  $('schedule').disabled = !canUse || !subscription || !connection || busy;
  if (isIOS && !standalone) $('permission-status').textContent = 'Открой приложение с иконки на экране «Домой».';
}
function bytes(value) {
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, x => x.charCodeAt(0));
}
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname !== 'functions.yandexcloud.net') throw new Error('Нужен HTTPS-адрес тестовой функции Яндекса без дополнительных параметров.');
  return url.href.replace(/\/$/, '');
}
async function api(action, body, candidate = connection) {
  const url = new URL(candidate.endpoint); url.searchParams.set('action', action);
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', mode:'cors', cache:'no-store', credentials:'omit', redirect:'error',
    headers: { 'X-Test-Code': candidate.code, ...(body ? {'Content-Type':'application/json'} : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)
  });
  let data; try { data = await response.json(); } catch { throw new Error('Сервер вернул непонятный ответ. Проверь адрес подключения.'); }
  if (!response.ok) throw new Error(data.error || 'Не удалось связаться с сервером.');
  return data;
}
async function connect(candidate) {
  const data = await api('config', null, candidate);
  if (typeof data.publicKey !== 'string' || bytes(data.publicKey).length !== 65) throw new Error('Сервер ещё не настроен для уведомлений.');
  if (new URL(data.appUrl).href !== new URL('./', location.href).href) throw new Error('Этот сервер настроен для другого адреса страницы. Сообщи мне адрес текущей страницы.');
  // Changing a server/key must not leave a subscription tied to the previous key.
  const existing = registration ? await registration.pushManager.getSubscription() : null;
  if (existing) {
    const oldKey = existing.options.applicationServerKey;
    const expected = bytes(data.publicKey);
    if (!oldKey || new Uint8Array(oldKey).some((v,i) => v !== expected[i]) || oldKey.byteLength !== expected.length) {
      await existing.unsubscribe(); subscription = null;
    } else subscription = existing;
  }
  connection = candidate; publicKey = data.publicKey;
  localStorage.setItem(connectionKey, JSON.stringify(candidate));
  $('connection').open = false;
  $('permission-status').textContent = subscription ? 'Уведомления разрешены.' : 'Сервер подключён. Нажми кнопку ниже.';
  status(subscription ? 'Можно запустить проверку.' : 'Теперь разреши уведомления.');
  controls();
}
$('connect-form').addEventListener('submit', async e => {
  e.preventDefault(); busy = true; controls(); $('connect').disabled = true;
  try { await connect({endpoint:endpoint($('endpoint').value.trim()), code:$('access-code').value.trim()}); }
  catch (error) { publicKey = null; subscription = null; status(error.message || 'Не удалось подключиться.', true); }
  finally { busy = false; $('connect').disabled = false; controls(); }
});
$('allow').addEventListener('click', async () => {
  // Request immediately in the tap handler, before any network operation (iOS).
  const permissionPromise = Notification.requestPermission();
  busy = true; controls();
  try {
    const permission = await permissionPromise;
    if (permission !== 'granted') throw new Error('Уведомления не разрешены. Проверь настройки уведомлений этого приложения на iPhone, затем вернись сюда.');
    subscription = await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:bytes(publicKey)});
    $('permission-status').textContent = 'Уведомления разрешены.'; status('Можно запустить проверку.');
  } catch (error) { status(error.message || 'Не удалось разрешить уведомления.', true); }
  finally { busy = false; controls(); }
});
$('schedule').addEventListener('click', async () => {
  busy = true; controls(); status('Передаю напоминание серверу…');
  let id;
  try {
    const recent = (await TestDB.list()).find(x => !x.receivedAt && !x.scheduleFailed && x.createdAt > Date.now() - 180000);
    if (recent) throw new Error('Предыдущая проверка ещё ожидается. Подожди до трёх минут после её запуска.');
    // Recheck permission/subscription after a settings change outside the app.
    subscription = await registration.pushManager.getSubscription();
    if (!subscription || Notification.permission !== 'granted') { subscription = null; throw new Error('Нужно снова разрешить уведомления.'); }
    id = crypto.randomUUID();
    await TestDB.patch(id, {createdAt:Date.now(), network:$('network').value, phoneState:$('phone-state').value, sound:null, status:'requesting'});
    const data = await api('schedule', {id, subscription:subscription.toJSON()});
    if (data.id !== id || !Number.isFinite(data.dueAt)) throw new Error('Сервер вернул непонятное подтверждение.');
    await TestDB.patch(id, {dueAt:data.dueAt, acceptedAt:data.acceptedAt, status:'accepted'});
    status('Сервер принял запрос. Теперь выполни выбранное действие с телефоном. Напоминание ожидается примерно через минуту; возможна задержка.');
  } catch(error) {
    if (id) await TestDB.patch(id, {status:'unconfirmed'}).catch(() => {});
    status((error.message || 'Запрос не подтверждён.') + (id ? ' Подтверждение могло потеряться, поэтому перед повтором подожди три минуты.' : ''), true);
  } finally { busy = false; controls(); await render().catch(() => {}); }
});
function time(value) { return value ? new Date(value).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—'; }
function node(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
async function render() {
  const tests = await TestDB.list(); $('empty').hidden = !!tests.length; $('export').disabled = !tests.length;
  $('history').replaceChildren();
  for (const t of tests.slice(0, 12)) {
    const box = node('article', ''); box.className = 'history-item';
    box.append(node('strong', networkNames[t.network] || 'Условия не записаны'), node('p', stateNames[t.phoneState] || ''));
    box.append(node('p', 'Запуск: ' + time(t.createdAt)), node('p', 'Получение: ' + time(t.receivedAt)));
    let label = t.receivedAt ? 'Получено на устройстве' : t.status === 'unconfirmed' ? 'Приём запроса не подтверждён' : 'Получение пока не подтверждено';
    const pill = node('span', label); pill.className = 'pill' + (t.receivedAt ? ' ok' : ''); box.append(pill);
    if (t.openedAt) box.append(node('p', 'Открыто из уведомления: ' + time(t.openedAt)));
    if (t.sound) box.append(node('p', 'Звук: ' + ({yes:'был',no:'не был',unknown:'не оценён'}[t.sound])));
    if (t.receivedAt && !t.sound) { const button = node('button', 'Записать результат'); button.onclick = () => showInstruction(t.id, false); box.append(button); }
    $('history').append(box);
  }
}
async function showInstruction(id, fromPush) {
  const tests = await TestDB.list();
  const test = tests.find(t => t.id === id);
  // A hand-edited URL is not evidence that a notification was received/opened.
  if (!test || !test.receivedAt) { status('Для этой проверки ещё нет записи о получении уведомления.'); return; }
  activeId = id; $('instruction').hidden = false; $('sound').value = test.sound || '';
  $('instruction').querySelector('h2').textContent = test.openedAt ? 'Уведомление открылось' : 'Запишем результат';
  $('result-status').textContent = '';
  if (fromPush) { $('instruction').scrollIntoView({behavior:'auto',block:'start'}); $('instruction').focus(); }
}
$('result-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!activeId || !['yes','no','unknown'].includes($('sound').value)) return;
  try { await TestDB.patch(activeId, {sound:$('sound').value, assessedAt:Date.now()}); $('result-status').textContent = 'Результат сохранён.'; await render(); }
  catch { $('result-status').textContent = 'Не удалось сохранить. Попробуй ещё раз.'; }
});
$('export').addEventListener('click', async () => {
  const records = (await TestDB.list()).map(({id,createdAt,dueAt,acceptedAt,receivedAt,openedAt,network,phoneState,sound,status}) => ({id,createdAt,dueAt,acceptedAt,receivedAt,openedAt,network,phoneState,sound,status}));
  const file = new Blob([JSON.stringify({version:'0.0.1',exportedAt:new Date().toISOString(),records},null,2)],{type:'application/json'});
  const url = URL.createObjectURL(file); const link = document.createElement('a'); link.href=url; link.download='notification-test-results.json'; document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url),60000);
});
async function refresh() { await render(); const id = new URL(location.href).searchParams.get('test'); if (id) await showInstruction(id, true); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && storageReady) refresh().catch(() => status('Не удалось прочитать историю.',true)); });
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
  if (e.data?.type === 'PUSH_RECEIVED') render().catch(() => {});
  if (e.data?.type === 'PUSH_OPENED') {
    const id=e.data.id;
    void (async () => {
      // Persist the notification click again from the focused Home Screen app.
      // This is only reached through a real notificationclick message; manually
      // editing the page URL still cannot create evidence of an opening.
      if (/^[a-f0-9-]{36}$/i.test(id || '')) {
        const test=(await TestDB.list()).find(x => x.id === id);
        if (test?.receivedAt && !test.openedAt) await TestDB.patch(id,{openedAt:Date.now()});
      }
      const url=new URL(location.href);url.searchParams.set('test',id);history.replaceState(null,'',url);
      await refresh();
    })().catch(() => status('Уведомление открылось, но отметку об открытии сохранить не удалось.',true));
  }
});
(async function init() {
  $('install').hidden = !isIOS || standalone;
  if (!supported || (isIOS && !standalone)) $('permission-status').textContent = isIOS && !standalone ? 'Открой приложение с иконки на экране «Домой».' : 'В этом браузере системные уведомления недоступны. Открой тест в Safari на iPhone с экрана «Домой».';
  try { await TestDB.open(); storageReady = true; await refresh(); }
  catch { status('Хранилище недоступно. Открой обычный режим браузера и проверь свободное место.',true); }
  if (isSecureContext && 'serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js',{scope:'./'}); registration = await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Подготовка заняла слишком много времени.')),15000))]); }
    catch { status('Не удалось подготовить приложение. Проверь соединение и обнови страницу.',true); }
  }
  try {
    const saved=JSON.parse(localStorage.getItem(connectionKey)||'null');
    $('endpoint').value=saved?.endpoint || window.PUSH_TEST_CONFIG?.endpoint || '';
    if (saved) { $('access-code').value=saved.code; await connect({endpoint:endpoint(saved.endpoint),code:saved.code}); }
    else { $('connection').open=true; status('Сервер ещё не подключён. Адрес и код будут выданы после настройки.'); }
  } catch { $('connection').open=true;status('Не удалось восстановить подключение. Проверь адрес, код и интернет.',true); }
  controls();
})();
