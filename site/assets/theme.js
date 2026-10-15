// Loaded in <head> so the saved theme applies before first paint. With no saved choice, the system setting wins.
const root = document.documentElement;
const saved = localStorage.getItem('theme');
if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;

const ORDER = ['system', 'light', 'dark'];
const LABELS = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };
const ICONS = {
  system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
};

function current() { return root.dataset.theme ?? 'system'; }

function render(button) {
  const mode = current();
  button.setAttribute('aria-label', `${LABELS[mode]}. Change theme.`);
  button.title = LABELS[mode];
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[mode]}</svg>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('theme-toggle');
  if (!button) return;
  render(button);
  button.addEventListener('click', () => {
    const next = ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length];
    if (next === 'system') { delete root.dataset.theme; localStorage.removeItem('theme'); }
    else { root.dataset.theme = next; localStorage.setItem('theme', next); }
    render(button);
  });
});

// Offline use: a service worker stores this page's files after the first visit (see /sw.js).
// Registration waits for the page to load and does nothing where service workers are unavailable.
const OFFLINE_ICONS = {
  ready: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.8 8.6 4.7 4.7 0 0 1 17.5 18z"/><path d="m9.5 13 2 2 3.5-3.5"/>',
  offline: '<path d="M3 3l18 18M9.2 6.2A6 6 0 0 1 17.8 8.6a4.7 4.7 0 0 1 2.7 7.9M17 18H7a4.5 4.5 0 0 1-1.6-8.7"/>',
};
const OFFLINE_TEXT = { ready: 'Available offline', offline: 'Offline' };
const OFFLINE_TITLE = {
  ready: 'This page is saved in your browser and works without a network connection.',
  offline: 'No network connection. Pages you have opened before still work.',
};

function offlineIndicator() {
  const footer = document.querySelector('.footer-bottom, .catalog-footer');
  if (!footer) return null;
  const el = document.createElement('span');
  el.className = 'offline-status';
  el.setAttribute('role', 'status');
  el.hidden = true;
  footer.append(el);
  let ready = false;
  const render = () => {
    const state = !navigator.onLine ? 'offline' : ready ? 'ready' : null;
    el.hidden = !state;
    if (!state || el.dataset.state === state) return;
    el.dataset.state = state;
    el.title = OFFLINE_TITLE[state];
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${OFFLINE_ICONS[state]}</svg><span>${OFFLINE_TEXT[state]}</span>`;
  };
  addEventListener('online', render);
  addEventListener('offline', render);
  render();
  return { setReady() { ready = true; render(); } };
}

// The app's base URL, from this script's own address (assets/theme.js), so the site works under any path.
const APP = document.currentScript ? new URL('../', document.currentScript.src) : null;

function ask(worker, message) {
  const channel = new MessageChannel();
  const reply = new Promise((resolve) => { channel.port1.onmessage = (e) => resolve(e.data ?? {}); });
  worker.postMessage(message, [channel.port2]);
  return reply;
}

const HANDOVER_WAIT = 4000; // ms

async function enableOffline() {
  const indicator = offlineIndicator();
  const reg = await navigator.serviceWorker.register(new URL('sw.js', APP), { scope: APP.pathname, updateViaCache: 'none' });
  const controller = navigator.serviceWorker.controller;
  // A new version finished installing earlier. If this is the only open tab, let it take over now and reload,
  // so the page and every file it loads later come from the same deploy. With other tabs open it waits.
  if (reg.waiting && controller && (await ask(controller, { type: 'tabs' })).count === 1) {
    // The browser sometimes holds the hand-over until the next navigation. If it has not happened after a few
    // seconds this page carries on with the version it has; the switch still reloads it whenever it comes.
    const handedOver = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => { location.reload(); resolve(true); }, { once: true });
      setTimeout(() => resolve(false), HANDOVER_WAIT);
    });
    reg.waiting.postMessage({ type: 'activate' });
    if (await handedOver) return;
  }
  const worker = controller ?? (await navigator.serviceWorker.ready).active;
  if (worker && (await ask(worker, { type: 'cache', url: location.href })).ok === true) {
    root.dataset.offlineReady = '';
    indicator?.setReady();
  }
}

if ('serviceWorker' in navigator && APP) {
  addEventListener('load', () => { enableOffline().catch(() => {}); }, { once: true });
}
