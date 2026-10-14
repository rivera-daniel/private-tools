import { Bytes, LIMITS, utf8, latin1, concat, indexOfZero, fmtBytes } from './bytes.js';
import { AI_TOOL_PATTERN, sourceTypeSignal } from './signals.js';

function* boxes(b, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = b.u32(o); const type = b.ascii(o + 4, 4); let header = 8;
    if (size === 1) { if (!b.has(o + 8, 8)) return; size = b.u64(o + 8); header = 16; }
    else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    yield { type, start: o + header, end: o + size };
    o += size;
  }
}

function jumbfLabel(b, box) {
  for (const child of boxes(b, box.start, box.end)) {
    if (child.type !== 'jumd') continue;
    if (child.end - child.start < 17) return '';
    const toggles = b.u8at(child.start + 16);
    if (!(toggles & 2)) return '';
    const s = b.slice(child.start + 17, child.end - child.start - 17); const z = indexOfZero(s);
    return utf8.decode(z < 0 ? s : s.subarray(0, z));
  }
  return '';
}

// at: file offset of the JUMBF data, when known.
export function parseJumbf(b, r, { at, record = true } = {}) {
  try {
    for (const box of boxes(b, 0, b.length)) {
      if (box.type !== 'jumb' || jumbfLabel(b, box) !== 'c2pa') continue;
      const manifests = [];
      for (const m of boxes(b, box.start, box.end)) if (m.type === 'jumb') manifests.push(parseManifest(b, m, r));
      if (!manifests.length) continue;
      if (record) r.block('C2PA', at, b.length, { note: `${manifests.length} manifest${manifests.length === 1 ? '' : 's'}` });
      const active = manifests[manifests.length - 1];
      r.c2pa.push({ manifests: manifests.length, active: { label: active.label, generator: active.generator, title: active.title, signer: active.signer, actions: active.actions, assertions: active.assertions, ingredients: active.ingredients }, verified: false });
      r.add('Provenance', 'Content Credentials', `C2PA manifest present (${manifests.length} manifest${manifests.length === 1 ? '' : 's'}). Signature not verified.`);
      if (active.generator) {
        r.add('Provenance', 'Claim generator', active.generator);
        if (AI_TOOL_PATTERN.test(active.generator)) r.signal('clue', 'AI tool named in Content Credentials', `Claim generator: ${active.generator}`, 'C2PA claim');
      }
      if (active.title) r.add('Provenance', 'Manifest title', active.title);
      if (active.signer) r.add('Provenance', 'Signed by (unverified)', active.signer);
      for (const a of active.actions) {
        r.add('Provenance', 'Action', [a.action, a.softwareAgent && `by ${a.softwareAgent}`, a.digitalSourceType && `source: ${a.digitalSourceType.split('/').pop()}`].filter(Boolean).join(' · '));
        if (a.digitalSourceType) sourceTypeSignal(a.digitalSourceType, r, 'C2PA actions');
        if (a.softwareAgent && AI_TOOL_PATTERN.test(a.softwareAgent)) r.signal('clue', 'AI tool named in Content Credentials', `Software agent: ${a.softwareAgent}`, 'C2PA actions');
      }
      if (active.ingredients) r.add('Provenance', 'Ingredients', String(active.ingredients));
      r.signal('credentials', 'Content Credentials (C2PA) present', 'The file includes a signed provenance manifest. This tool reads it but does not verify the signature or trust chain.', 'C2PA');
    }
  } catch (error) {
    r.warn(`Content Credentials could not be fully read (${error.message}).`);
  }
}

function parseManifest(b, m, r) {
  const info = { label: jumbfLabel(b, m), generator: '', title: '', signer: '', actions: [], assertions: [], ingredients: 0 };
  const source = `Content Credentials ${shortLabel(info.label)}`;
  r.field(source, 'Manifest', info.label);
  r.field(source, 'Signature', 'Not verified');
  for (const child of boxes(b, m.start, m.end)) {
    if (child.type !== 'jumb') continue;
    const label = jumbfLabel(b, child);
    if (label === 'c2pa.claim' || label === 'c2pa.claim.v2') {
      const claim = firstContent(b, child, r);
      if (claim && typeof claim === 'object') {
        flatten(claim, 'claim', (k, v) => r.field(source, k, v));
        const g = claim.claim_generator ?? claim.claim_generator_info;
        info.generator = typeof g === 'string' ? g : [].concat(g ?? []).map((x) => [x?.name, x?.version].filter(Boolean).join(' ')).filter(Boolean).join(', ');
        if (typeof claim['dc:title'] === 'string') info.title = claim['dc:title'];
      }
    } else if (label === 'c2pa.signature') {
      info.signer = signerName(b.slice(child.start, child.end - child.start));
      if (info.signer) r.field(source, 'Signer (unverified)', info.signer);
    } else if (label === 'c2pa.assertions') {
      for (const a of boxes(b, child.start, child.end)) {
        if (a.type !== 'jumb') continue;
        const al = jumbfLabel(b, a);
        if (!al) continue;
        info.assertions.push(al);
        if (/^c2pa\.ingredient/.test(al)) info.ingredients++;
        if (/^c2pa\.thumbnail\.claim/.test(al)) { r.field(source, al, 'Preview image of this file'); continue; }
        if (/^c2pa\.thumbnail/.test(al)) { r.field(source, al, 'Preview image of an ingredient', { flag: 'privacy' }); r.signal('privacy', 'Preview of an earlier version', 'Content Credentials include a preview image of a source file used to make this one. It can show content that was later cropped or edited out.', 'C2PA ingredient thumbnail', 'a preview of an earlier version'); continue; }
        const value = firstContent(b, a, r);
        if (value === null) { r.field(source, al, 'Not decoded'); continue; }
        flatten(value, al, (k, v) => r.field(source, k, v));
        if (/^c2pa\.actions/.test(al)) {
          for (const act of Array.isArray(value?.actions) ? value.actions.slice(0, 50) : []) {
            if (!act || typeof act !== 'object') continue;
            const agent = typeof act.softwareAgent === 'string' ? act.softwareAgent : act.softwareAgent?.name;
            info.actions.push({ action: String(act.action ?? ''), softwareAgent: typeof agent === 'string' ? agent : '', digitalSourceType: typeof act.digitalSourceType === 'string' ? act.digitalSourceType : '' });
          }
        }
      }
    }
  }
  return info;
}

const shortLabel = (label) => { const m = label.match(/urn:(?:uuid|c2pa):([0-9a-f]{8})/i); return m ? `(${m[1]})` : `(${label.slice(0, 24)})`; };

function flatten(value, prefix, emit, depth = 0, budget = { n: 0 }) {
  if (budget.n > 2000) return;
  if (value instanceof Uint8Array) { budget.n++; emit(prefix, value.length > 64 ? fmtBytes(value.length) : [...value].map((x) => x.toString(16).padStart(2, '0')).join('')); return; }
  if (value === null || typeof value !== 'object') { budget.n++; emit(prefix, String(value)); return; }
  if (depth > 12) { emit(prefix, '…'); return; }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  for (const [k, v] of entries.slice(0, 500)) flatten(v, `${prefix} › ${k}`, emit, depth + 1, budget);
}

function firstContent(b, box, r) {
  for (const c of boxes(b, box.start, box.end)) {
    if (c.type === 'cbor') {
      try { return decodeCbor(b.slice(c.start, c.end - c.start)); }
      catch (error) { r.warn(`A Content Credentials record could not be decoded (${error.message}).`); return null; }
    }
    if (c.type === 'json') { try { return JSON.parse(utf8.decode(b.slice(c.start, c.end - c.start))); } catch { return null; } }
  }
  return null;
}

// Reads the signer common name from the certificate in the COSE signature, without verifying it.
function signerName(u8) {
  const s = latin1(u8); const names = [];
  for (let i = s.indexOf('\x06\x03\x55\x04\x03'); i >= 0 && names.length < 8; i = s.indexOf('\x06\x03\x55\x04\x03', i + 5)) {
    const len = s.charCodeAt(i + 6);
    if (len > 0 && len < 128) names.push(s.slice(i + 7, i + 7 + len));
  }
  const printable = names.filter((n) => /^[\x20-\x7e]+$/.test(n));
  // The first certificate's subject follows its issuer, so the second name is the signer when a chain is present.
  return printable.length > 1 ? printable[1] : printable[0] ?? '';
}

export function decodeCbor(u8) {
  const b = new Bytes(u8); let o = 0; let items = 0;
  const item = (depth) => {
    if (depth > LIMITS.maxCborDepth) throw new Error('nesting too deep');
    if (++items > LIMITS.maxCborItems) throw new Error('too many items');
    const ib = b.u8at(o++); const major = ib >> 5; const ai = ib & 31;
    const arg = () => {
      if (ai < 24) return ai;
      if (ai === 24) return b.u8at(o++);
      if (ai === 25) { const v = b.u16(o); o += 2; return v; }
      if (ai === 26) { const v = b.u32(o); o += 4; return v; }
      if (ai === 27) { const v = b.u64(o); o += 8; return v; }
      if (ai === 31) return -1;
      throw new Error('invalid length');
    };
    const len = arg();
    const take = (n) => { if (n < 0 || !b.has(o, n)) throw new Error('truncated'); const v = b.slice(o, n); o += n; return v; };
    const chunked = (m) => { const parts = []; while (b.u8at(o) !== 0xff) { if (b.u8at(o) >> 5 !== m) throw new Error('bad chunk'); parts.push(item(depth + 1)); } o++; return parts; };
    switch (major) {
      case 0: return len;
      case 1: return -1 - len;
      case 2: return len < 0 ? concat(chunked(2)) : take(len);
      case 3: return len < 0 ? chunked(3).join('') : utf8.decode(take(len));
      case 4: { const out = []; if (len < 0) { while (b.u8at(o) !== 0xff) out.push(item(depth + 1)); o++; } else { if (len > b.length - o) throw new Error('truncated'); for (let i = 0; i < len; i++) out.push(item(depth + 1)); } return out; }
      case 5: {
        const out = Object.create(null);
        const pair = () => { const k = item(depth + 1); const v = item(depth + 1); if (typeof k === 'string' || typeof k === 'number') out[k] = v; };
        if (len < 0) { while (b.u8at(o) !== 0xff) pair(); o++; } else { if (len > b.length - o) throw new Error('truncated'); for (let i = 0; i < len; i++) pair(); }
        return out;
      }
      case 6: return item(depth + 1);
      case 7: {
        if (ai === 20) return false; if (ai === 21) return true; if (ai === 22 || ai === 23) return null;
        if (ai === 25) { const s = len >> 15 ? -1 : 1; const e = (len >> 10) & 31; const f = len & 1023; return s * (e ? (e === 31 ? (f ? NaN : Infinity) : 2 ** (e - 15) * (1 + f / 1024)) : 2 ** -14 * (f / 1024)); }
        if (ai === 26) { const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, len); return dv.getFloat32(0); }
        if (ai === 27) { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, Math.floor(len / 2 ** 32)); dv.setUint32(4, len >>> 0); return dv.getFloat64(0); }
        return len;
      }
      default: throw new Error('invalid type');
    }
  };
  return item(0);
}
