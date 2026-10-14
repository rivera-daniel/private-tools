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
