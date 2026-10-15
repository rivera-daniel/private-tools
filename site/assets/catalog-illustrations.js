import { ROADMAP_ART, ROADMAP_COLORS } from './roadmap-illustrations.js';
// Scalable catalog illustrations. Decorative artwork, never a simulated tool result.
export const ILLUSTRATION_KINDS = ['inspector', 'files', 'cleaner', 'archiver', 'pdfedit', ...Object.keys(ROADMAP_ART)];
export function illustration(kind, id) {
  const colors = {
    inspector: ['#55c6ff', '#0871e8'],
    files: ['#f4b69b', '#bc6049'],
    cleaner: ['#c5acff', '#7660cc'],
    archiver: ['#f7d77a', '#c18b26'],
    pdfedit: ['#b5d4ae', '#54876b'],
  };
  const [a, b] = colors[kind] ?? ROADMAP_COLORS[kind] ?? colors.files;
  const paper = '<path d="M30 18h47l17 17v67H30z" fill="url(#' + id + 'paper)"/><path d="M77 18v17h17" fill="#ccd9e4"/><path d="M43 48h37M43 58h37M43 68h24" stroke="#a4b2c4" stroke-width="4" stroke-linecap="round"/>';
  const lens = '<path d="m83 83 23 23" stroke="#162d44" stroke-width="12" stroke-linecap="round"/><path d="m85 83 20 20" stroke="#50667b" stroke-width="5" stroke-linecap="round"/><circle cx="67" cy="66" r="27" fill="#dbe9f5" stroke="#566d84" stroke-width="3"/><circle cx="67" cy="66" r="21" fill="#aedbfa" fill-opacity=".72" stroke="white" stroke-width="2"/><path d="M51 61a17 17 0 0 1 17-12" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"/>';
  const photo = '<rect x="24" y="24" width="66" height="66" rx="4" fill="white" transform="rotate(-12 57 57)"/><g transform="rotate(-12 57 57)"><path d="M29 29h56v51H29z" fill="#73c6f2"/><circle cx="72" cy="41" r="6" fill="#fff1b9"/><path d="m29 68 19-25 19 24 9-12 9 13v12H29z" fill="#548f9e"/><path d="m39 57 9-14 10 13-10-5z" fill="#f2f9ff"/><path d="M29 71q19-10 35 1t21-1v9H29z" fill="#256789"/></g>';
  const art = {
    inspector: photo + lens,
    files: paper + lens,
    cleaner: paper + '<path d="m91 56 11 9-26 31-12-10z" fill="#f0d4b9"/><path d="m64 82 18 15-14 17q-20 1-26-14z" fill="#d3b0ff" stroke="#fff" stroke-width="2"/><path d="m53 99 10 8m-4-14 10 8" stroke="#9673cd" stroke-width="2"/><path d="M99 29v12m-6-6h12M20 67v10m-5-5h10" stroke="#fff3cb" stroke-width="3" stroke-linecap="round"/>',
    archiver: '<rect x="24" y="24" width="80" height="83" rx="9" fill="#f5c968"/><path d="M24 40h80v14H24z" fill="#e9ad40"/><path d="M52 24h24v83H52z" fill="#886b4a"/><path d="M60 28h8m-8 10h8m-8 10h8m-8 10h8m-8 10h8" stroke="#f7e1ad" stroke-width="5"/><rect x="54" y="77" width="20" height="21" rx="4" fill="#d9e0e4" stroke="#657481" stroke-width="2"/><rect x="60" y="82" width="8" height="9" rx="2" fill="#886b4a"/>',
    pdfedit: paper + '<rect x="40" y="76" width="36" height="7" rx="2" fill="#bd5951"/><g transform="rotate(39 88 73)"><rect x="82" y="42" width="13" height="58" rx="2" fill="#f4cb70"/><path d="M82 100h13l-6.5 14z" fill="#f6e5c9"/><path d="m86 108 2.5 6 2.5-6z" fill="#364454"/><path d="M82 48h13v8H82z" fill="#cbd6e0"/></g>',
  };
  return `<svg class="tool-illustration" viewBox="0 0 128 128" aria-hidden="true"><defs><linearGradient id="${id}tile" x2=".2" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><linearGradient id="${id}paper" x2=".7" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#e1e9f2"/></linearGradient><filter id="${id}shadow" x="-30%" y="-30%" width="170%" height="180%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-opacity=".24"/></filter></defs><rect x="1" y="1" width="126" height="126" rx="28" fill="url(#${id}tile)"/><rect x="1.5" y="1.5" width="125" height="125" rx="27.5" fill="none" stroke="#fff" stroke-opacity=".25"/><g filter="url(#${id}shadow)">${art[kind] ?? ROADMAP_ART[kind] ?? paper}</g></svg>`;
}
