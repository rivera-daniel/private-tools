// Readable strings and the personal details, network names and secrets they reveal. Patterns are
// bounded so hostile input cannot cause catastrophic backtracking.

export const STRING_LIMITS = { maxScanBytes: 32 * 1024 * 1024, maxChars: 6 * 1024 * 1024, perKind: 25, total: 400 };

// ASCII runs of at least minAscii printable bytes and UTF-16LE runs of at least minWide characters,
// from the given [start, end) ranges. Windows that look compressed or encrypted are skipped.
export function extractStrings(u8, ranges, { minAscii = 6, minWide = 5, skipDense = true } = {}) {
  const out = []; let chars = 0; let scanned = 0; let dense = 0;
  const take = (s) => { if (chars < STRING_LIMITS.maxChars) { out.push(s); chars += s.length + 1; } };
  for (const [from, to] of ranges) {
    for (let w = from; w < to && scanned < STRING_LIMITS.maxScanBytes && chars < STRING_LIMITS.maxChars; w += 65536) {
      const end = Math.min(to, w + 65536);
      scanned += end - w;
      if (skipDense && end - w >= 4096 && entropy(u8, w, end) > 7.5) { dense += end - w; continue; }
      const printable = (x) => (x >= 0x20 && x < 0x7f) || x === 9;
      for (let i = w, a = w; i <= end; i++) {
        if (i < end && printable(u8[i])) continue;
        if (i - a >= minAscii) take(String.fromCharCode(...u8.subarray(a, Math.min(i, a + 4096))));
        a = i + 1;
      }
      // UTF-16LE: a printable byte followed by a zero byte, at any alignment.
      for (let i = w; i + 1 < end;) {
        if (!(printable(u8[i]) && u8[i + 1] === 0)) { i++; continue; }
        let j = i; let s = '';
        while (j + 1 < end && printable(u8[j]) && u8[j + 1] === 0) { if (s.length < 4096) s += String.fromCharCode(u8[j]); j += 2; }
        if (s.length >= minWide) take(s);
        i = j + 1;
      }
    }
  }
  return { text: out.join('\n'), scanned, dense };
}

export function entropy(u8, from, to) {
  const counts = new Uint32Array(256);
  for (let i = from; i < to; i++) counts[u8[i]]++;
  let h = 0; const n = to - from;
  for (const c of counts) if (c) { const p = c / n; h -= p * Math.log2(p); }
  return h;
}

const GENERIC_USERS = /^(user|username|name|you|yourname|your_name|me|x|public|default|default user|all users|shared|guest|runner|runneradmin|vsts|vssadmin\w*|builder|buildbot|build|buildd|abuild|jenkins|travis|circleci|appveyor|vagrant|docker|ubuntu|ec2-user|admin|administrator|root|test|tester|example|john|jane|johndoe|janedoe|\$\w+|%\w+%|\*|\.+|<[^>]*>|\{[^}]*\}|\$\{[^}]*\})$/i;
const NOISE_HOSTS = /(^|\.)(w3\.org|xmlsoap\.org|purl\.org|ns\.adobe\.com|adobe\.com|schemas\.microsoft\.com|schemas\.openxmlformats\.org|openxmlformats\.org|iptc\.org|cipa\.jp|xml\.org|oasis-open\.org|openoffice\.org|libreoffice\.org|apple\.com|ietf\.org|example\.(com|org|net)|exif\.org|aiim\.org|npes\.org|mozilla\.org|xmlns\.com|schema\.org|ogp\.me|iec\.ch|color\.org|inkscape\.org|sodipodi\.sourceforge\.net|creativecommons\.org)$/i;
const CERT_URL = /^(ocsp|crl\d*|cacerts|aia|ts-ocsp|ts-crl|ts-aia)\.|\/(pki|repository|cps|crl|ocsp)\b/i;
const FILE_EXT_TLD = /^(png|jpe?g|gif|svg|webp|bmp|ico|js|mjs|css|html?|php|aspx?|json|xml|txt|md|exe|dll|so|py|rb|go|rs|java|class|zip|gz|pdf|docx?|xlsx?|pptx?|mov|mp[34]|wav|ttf|otf|woff2?|map|ts|tsx|jsx|vue|lock|log|ini|cfg|yml|yaml|toml|sh|bat|cmd|ps1|psd|tiff?|heic|avif|local|test|invalid|localhost|example)$/i;
const INTERNAL_SUFFIX = /\.(local|lan|internal|intranet|corp|localdomain|home\.arpa|private)$/i;
const CODE_WORDS = /^(this|self|window|document|config|settings|var|data|process|module|exports|options|props|state|context|global|globals|env|app|request|response|req|res|item|node|obj|object|value|result|args|param|params|it|that|new|my)$/i;

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
const DOC_IPV4 = /^(192\.0\.2|198\.51\.100|203\.0\.113)\./;

function validIpv6(s) {
  if (!s.includes(':') || s.split(':').length < 3 || !/\d/.test(s) || !/[0-9a-f]{3,4}/i.test(s)) return false;
  if (!s.includes('::') && s.split(':').length !== 8) return false;
  try { new URL(`http://[${s}]/`); return true; } catch { return false; }
}

// A path ends at its file name: words after "name.ext " are ordinary text.
const trimPath = (p) => p.replace(/(\\[^\\]*?\.[A-Za-z0-9]{1,5})\s.*$/, '$1').trimEnd();
const mask = (s) => (s.length <= 12 ? `${s.slice(0, 3)}…` : `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} characters)`);

// UUID version 1 embeds the creating machine's MAC address and the creation time.
function uuidV1(guid) {
  const h = guid.replace(/[{}-]/g, '').toLowerCase();
  if (h[12] !== '1' || !/[89ab]/.test(h[16])) return null;
  const node = h.slice(20);
  if (parseInt(node.slice(0, 2), 16) & 1) return null;
  const ticks = BigInt(`0x${h.slice(13, 16)}${h.slice(8, 12)}${h.slice(0, 8)}`);
  const ms = Number(ticks / 10000n) - 12219292800000;
  const date = new Date(ms);
  return { mac: node.match(/../g).join(':'), date: Number.isNaN(date.getTime()) ? '' : date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') };
}

// User name in a file path, or null when the path has none or uses a placeholder.
export function pathUser(path) {
  const m = /^[A-Za-z]:\\(?:Users|Documents and Settings)\\([^\\/:*?"<>|\r\n]{1,64})/i.exec(path) ?? /^\/(?:Users|home)\/([^/\0\r\n]{1,64})/.exec(path);
  if (!m) return null;
  const user = m[1].trim();
  return user && !GENERIC_USERS.test(user) ? user : null;
}

const PATTERNS = [
  ['Private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, () => 'PEM private key block'],
  ['Possible secret', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, (m) => `AWS access key: ${mask(m)}`],
  ['Possible secret', /\bgh[pousr]_[A-Za-z0-9]{36,251}\b|\bgithub_pat_[A-Za-z0-9_]{60,120}\b/g, (m) => `GitHub token: ${mask(m)}`],
  ['Possible secret', /\bglpat-[A-Za-z0-9_-]{20,40}\b/g, (m) => `GitLab token: ${mask(m)}`],
  ['Possible secret', /\bxox[abposr]-[A-Za-z0-9-]{10,80}/g, (m) => `Slack token: ${mask(m)}`],
  ['Possible secret', /\bAIza[0-9A-Za-z_-]{35}\b/g, (m) => `Google API key: ${mask(m)}`],
  ['Possible secret', /\b[sr]k_live_[0-9A-Za-z]{20,99}\b/g, (m) => `Stripe live key: ${mask(m)}`],
  ['Possible secret', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,200}\b/g, (m) => `API secret key: ${mask(m)}`],
  ['Possible secret', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, (m) => `SendGrid key: ${mask(m)}`],
  ['Possible secret', /\beyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,1000}/g, (m) => `JSON web token: ${mask(m)}`],
  ['Possible secret', /\b(?:https?|ftp|smb|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@"'<>]{1,64}:[^\s@/"'<>]{3,128}@[^\s"'<>]{3,200}/g, (m) => `Password in a link: ${m.replace(/:\/\/([^:]*):[^@]*@/, '://$1:•••@').slice(0, 200)}`],
  ['Email address', /\b[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}\b/g, (m) => (FILE_EXT_TLD.test(m.split('.').pop()) || /@\d+x\./.test(m) || NOISE_HOSTS.test(m.split('@')[1]) ? null : m)],
  ['User folder path', /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\/:*?"<>|\p{C}]{1,64}(?:\\[^\\/:*?"<>|\p{C}]{1,128}){0,12}/giu, (m) => (pathUser(m) ? trimPath(m) : null)],
  ['User folder path', /(?<![\w.~-])\/(?:Users|home)\/[^/\s"'<>:;,|*?]{1,64}(?:\/[^/\s"'<>:;,|*?]{1,128}){0,12}/g, (m) => (pathUser(m) ? m : null)],
  ['Network share', /(?<![\w\\])\\\\[A-Za-z][A-Za-z0-9._-]{0,62}\\[A-Za-z0-9$][^\\/:*?"<>|\r\n\t]{0,80}(?:\\[^\\/:*?"<>|\r\n\t]{1,128}){0,8}/g, (m) => m],
  ['URL', /\b(?:https?|ftp|sftp|file|smb):\/\/[^\s"'<>\\^`{|}\x00-\x1f]{3,500}/g, (m) => {
    const url = m.replace(/[.,;:!?)\]]+$/, '');
    let host = ''; try { host = new URL(url).hostname; } catch { return null; }
    return NOISE_HOSTS.test(host) || CERT_URL.test(host) || CERT_URL.test(url.replace(/^\w+:\/\/[^/]+/, '')) ? null : url;
  }],
  ['Internal host name', /(?<![\w.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,6}(?:local|lan|internal|intranet|corp|localdomain|home\.arpa|private)(?![\w-]|\.\w)/gi, (m) => (CODE_WORDS.test(m.split('.')[0]) ? null : m)],
  ['IP address', /(?<![\w.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\w.]|\.\d)/g, (m) => {
    const parts = m.split('.').map(Number);
    if (parts.every((p) => p < 10) || parts[0] === 0 || parts[0] >= 224 || m === '127.0.0.1' || m === '255.255.255.255') return null;
    return m;
  }],
  ['IP address', /(?<![\w:.])(?:[0-9A-Fa-f]{1,4}:){2,7}(?::|[0-9A-Fa-f]{1,4})(?::[0-9A-Fa-f]{1,4}){0,6}(?![\w:])/g, (m) => (validIpv6(m) && !/^::1?$/.test(m) ? m.toLowerCase() : null)],
  ['MAC address', /(?<![\w:-])[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}(?![\w:-])/g, (m) => (/^(00[:-]){5}00$|^(ff[:-]){5}ff$/i.test(m) ? null : m.toUpperCase().replace(/-/g, ':'))],
  ['GUID', /(?<![\w-])\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?(?![\w-])/g, (m) => (/^\{?0{8}-/.test(m) ? null : m.replace(/[{}]/g, '').toUpperCase())],
  ['Phone number', /(?<![\w+])(?:tel:|\+)\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,3}(?![\w])|(?<![\w(])\(\d{3}\) ?\d{3}-\d{4}(?!\d)/g, (m) => (m.replace(/\D/g, '').length >= 9 && m.replace(/\D/g, '').length <= 15 ? m : null)],
  ['GPS coordinates', /\bgeo:-?\d{1,2}\.\d{3,10},-?\d{1,3}\.\d{3,10}|[@=](-?\d{1,2}\.\d{4,10}),(-?\d{1,3}\.\d{4,10})|\b\d{1,2}°\s?\d{1,2}['′]\s?\d{1,2}(?:\.\d{1,4})?["″]?\s?[NS][,\s]{1,3}\d{1,3}°\s?\d{1,2}['′]\s?\d{1,2}(?:\.\d{1,4})?["″]?\s?[EW]\b|\b(?:lat(?:itude)?)["']?\s*[:=]\s*["']?-?\d{1,2}\.\d{4,10}["']?\s*[,;]\s*["']?(?:lon|lng|long|longitude)["']?\s*[:=]\s*["']?-?\d{1,3}\.\d{4,10}/gi, (m) => {
    const nums = m.match(/-?\d{1,3}\.\d+/g);
    if (nums && nums.length >= 2 && (Math.abs(Number(nums[0])) > 90 || Math.abs(Number(nums[1])) > 180)) return null;
    return m.replace(/^[@=]/, '');
  }],
];

// Finds details in text. strict limits phone numbers to text files, where they are least noisy.
// Returns { matches: [{ kind, value, flag? }], users: Set, notes: Map(kind -> extra info) }.
export function findDetails(text, { phones = true, publicIps = true } = {}) {
  const matches = []; const users = new Set(); const seen = new Set(); const counts = new Map(); const extra = [];
  for (const [kind, re, accept] of PATTERNS) {
    if (kind === 'Phone number' && !phones) continue;
    re.lastIndex = 0; let m;
    while ((m = re.exec(text))) {
      if (matches.length >= STRING_LIMITS.total) break;
      if ((counts.get(kind) ?? 0) >= STRING_LIMITS.perKind) break;
      const value = accept(m[0]);
      if (!value) continue;
      const key = `${kind}\0${value}`;
      if (seen.has(key)) continue;
      // An address inside a URL already listed is not repeated on its own.
      seen.add(key); counts.set(kind, (counts.get(kind) ?? 0) + 1);
      const item = { kind, value };
      if (kind === 'User folder path') { const u = pathUser(value); if (u) users.add(u); }
      if (kind === 'IP address' && value.includes('.') && DOC_IPV4.test(value)) item.doc = true;
      if (kind === 'IP address' && ((value.includes('.') && ipv4Private(value)) || /^(fc|fd|fe[89ab])/i.test(value))) item.internal = true;
      // In binary data, dotted version numbers look like public addresses. Only private ones are kept there.
      if (kind === 'IP address' && !item.internal && !publicIps) continue;
      if (kind === 'URL') { try { const host = new URL(value).hostname.replace(/^\[|\]$/g, ''); if (INTERNAL_SUFFIX.test(host) || (/^\d+\.\d+\.\d+\.\d+$/.test(host) && ipv4Private(host))) item.internal = true; } catch { /* listed as is */ } }
      if (kind === 'Internal host name') item.internal = true;
      if (kind === 'GUID') { const v1 = uuidV1(value); if (v1) { item.mac = v1.mac; extra.push({ kind: 'MAC address', value: `${v1.mac.toUpperCase()} (inside time-based GUID ${value}${v1.date ? `, created ${v1.date}` : ''})`, fromGuid: true }); } }
      matches.push(item);
    }
  }
  for (const e of extra) if ((counts.get('MAC address') ?? 0) < STRING_LIMITS.perKind && !seen.has(`MAC address\0${e.value}`)) { matches.push(e); counts.set('MAC address', (counts.get('MAC address') ?? 0) + 1); }
  return { matches, users };
}
