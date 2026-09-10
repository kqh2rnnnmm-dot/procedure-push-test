'use strict';
importScripts('./db.js');
const CACHE = 'procedure-push-shell-0.0.3';
const SHELL = ['./','./index.html','./style.css','./config.js','./app.js','./db.js','./manifest.webmanifest','./icons/icon-180.png','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('procedure-push-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(new URL('./index.html',self.registration.scope).href)));
  } else {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {}; try { data = event.data?.json() || {}; } catch {}
    const id = /^[a-f0-9-]{36}$/i.test(data.id || '') ? data.id : null;
    const clickToken = id ? crypto.randomUUID() : null;
    const receivedAt = Date.now();
    // Show a visible notification even if local storage is unavailable.
    await self.registration.showNotification('Тест напоминания', {
      body:'Пора проверить инструкцию. Нажми на это уведомление.',
      icon:new URL('./icons/icon-192.png',self.registration.scope).href,
      tag:id ? 'test-' + id : 'test-notification', renotify:false,
      data:{id,clickToken}, silent:false
    });
    if (id) {
      try {
        const old=(await TestDB.list()).find(x => x.id === id);
        await TestDB.patch(id,{receivedAt:old?.receivedAt || receivedAt,dueAt:data.dueAt,shownAt:Date.now(),clickToken});
      } catch {}
      const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
      clients.forEach(client => client.postMessage({type:'PUSH_RECEIVED',id}));
    }
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const id = event.notification.data?.id;
    const clickToken = event.notification.data?.clickToken;
    if (!/^[a-f0-9-]{36}$/i.test(id || '') || !/^[a-f0-9-]{36}$/i.test(clickToken || '')) return;
    try { await TestDB.patch(id,{openedAt:Date.now()}); } catch {}
    const target=new URL('./',self.registration.scope);target.searchParams.set('test',id);target.searchParams.set('open',clickToken);
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=clients.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      existing.postMessage({type:'PUSH_OPENED',id,clickToken});await existing.focus();
    } else await self.clients.openWindow(target.href);
  })());
});
