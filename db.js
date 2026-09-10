/* Shared by the page and service worker. No subscriptions or secrets in reports. */
(function (root) {
  'use strict';
  let opened;
  function open() {
    if (!opened) opened = new Promise((resolve, reject) => {
      const request = indexedDB.open('procedure-push-test-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('tests', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opened = null; reject(request.error); };
      request.onblocked = () => reject(new Error('Закрой другие вкладки теста и попробуй ещё раз.'));
    });
    return opened;
  }
  async function patch(id, values) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('tests', 'readwrite');
      const store = tx.objectStore('tests');
      const get = store.get(id);
      let record;
      get.onsuccess = () => { record = { ...(get.result || {}), ...values, id }; store.put(record); };
      tx.oncomplete = () => resolve(record);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Не удалось сохранить результат.'));
    });
  }
  async function list() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('tests').objectStore('tests').getAll();
      request.onsuccess = () => resolve(request.result.sort((a,b) => (b.createdAt || b.receivedAt || 0) - (a.createdAt || a.receivedAt || 0)));
      request.onerror = () => reject(request.error);
    });
  }
  root.TestDB = { open, patch, list };
})(typeof self !== 'undefined' ? self : globalThis);
