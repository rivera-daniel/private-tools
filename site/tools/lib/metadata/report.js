import { LIMITS, clip, inflate } from './bytes.js';

// Sources that describe how the image is encoded rather than metadata about it.
const TECHNICAL = /^(Container|Items|JPEG|JFIF|PNG|WebP|GIF|BMP|JPEG XL|Photoshop document|Adobe APP14|Multi-Picture|RAF|TIFF)$/;
const metadataFields = (r) => [...r.sources].filter(([name]) => !TECHNICAL.test(name)).reduce((n, [, l]) => n + l.length, 0);

// One report per file. Three views of the same data:
// - sources: every decoded field, grouped by where it lives (EXIF IFD0, XMP dc, PNG chunks…)
// - highlights: curated key details (camera, location, people…)
// - blocks: every metadata block with its byte location, decoded or not. Metadata Cleaner removes these.
export class Report {
  constructor(size) {
    // category: Image, Document, Audio, Video, Archive, Program or Other.
    this.format = null; this.category = null; this.width = null; this.height = null; this.size = size;
    this.sources = new Map(); this.highlights = new Map(); this.blocks = []; this.structure = [];
    this.signals = []; this.warnings = []; this.c2pa = []; this.inflated = 0;
  }

  field(source, key, value, extra = {}) {
    if (value === undefined || value === null || value === '') return;
    if (!this.sources.has(source)) this.sources.set(source, []);
    const list = this.sources.get(source);
    if (list.length >= LIMITS.maxFieldsPerSource) { this.warn(`${source} has more than ${LIMITS.maxFieldsPerSource.toLocaleString('en-US')} fields. The rest are not listed.`); return; }
    list.push({ key: String(key), value: typeof value === 'string' ? clip(value) : String(value), ...extra });
  }

  add(group, key, value, extra = {}) {
    if (value === undefined || value === null || value === '') return;
    if (!this.highlights.has(group)) this.highlights.set(group, []);
    const list = this.highlights.get(group);
    if (list.length >= LIMITS.maxHighlightsPerGroup) return;
    const text = typeof value === 'string' ? clip(value) : String(value);
    if (list.some((f) => f.key === key && f.value === text)) return;
    list.push({ key, value: text, ...extra });
  }

  // A block is the outermost container unit holding metadata: a JPEG segment with its marker, a PNG chunk with
  // header and CRC, a HEIF item extent. Blocks found inside another block record it as their parent.
  // kind: EXIF, XMP, IPTC, ICC, C2PA, Comment, Text, Thumbnail, Photoshop, MakerNote, …
  block(kind, offset, length, extra = {}) {
    if (this.blocks.length >= LIMITS.maxStructure) return -1;
    const id = this.blocks.length;
    this.blocks.push({ id, kind, offset, length, decoded: true, parent: this.nest ?? null, ...extra });
    return id;
  }

  within(id, fn) {
    const previous = this.nest; this.nest = id < 0 ? previous : id;
    try { return fn(); } finally { this.nest = previous; }
  }

  // What the cleaner would remove: removable blocks with no removable ancestor, so nothing is counted twice.
  cleanable() {
    const removableAncestor = (b) => { for (let p = b.parent; p !== null && p !== undefined; p = this.blocks[p]?.parent) if (this.blocks[p]?.removable !== false) return true; return false; };
    return this.blocks.filter((b) => b.removable !== false && !removableAncestor(b));
  }

  struct(type, offset, length, note = '') {
    if (this.structure.length < LIMITS.maxStructure) this.structure.push({ type, offset, length, note });
    else if (this.structure.length === LIMITS.maxStructure) { this.structure.push({ type: '…', offset, length: 0, note: 'Further structures not listed' }); }
  }

  // short: the phrase used in the privacy summary, e.g. "exact location".
  signal(kind, title, detail, source, short) {
    if (!this.signals.some((s) => s.kind === kind && s.title === title)) this.signals.push({ kind, title, detail: clip(String(detail ?? '')), source, ...(short ? { short } : {}) });
  }

  warn(message) { if (this.warnings.length < 50 && !this.warnings.includes(message)) this.warnings.push(message); }

  async inflate(data, label) {
    const budget = LIMITS.maxInflateBytesPerFile - this.inflated;
    if (budget <= 0) { this.warn('The file holds more compressed metadata than the 32 MB limit. The rest was skipped.'); return new Uint8Array(); }
    try { const out = await inflate(data, Math.min(LIMITS.maxInflateBytes, budget)); this.inflated += out.length; return out; }
    catch (error) { this.warn(`Could not decompress ${label}: ${error.message}.`); return new Uint8Array(); }
  }

  toJSON() {
    return {
      format: this.format, category: this.category, width: this.width, height: this.height, size: this.size,
      sources: [...this.sources].map(([name, fields]) => ({ name, fields, technical: TECHNICAL.test(name) })),
      highlights: [...this.highlights].map(([name, fields]) => ({ name, fields })),
      blocks: this.blocks, structure: this.structure,
      signals: this.signals, warnings: this.warnings, c2pa: this.c2pa,
      fieldCount: metadataFields(this),
      cleanable: (() => { const list = this.cleanable(); return { blocks: list.length, bytes: list.reduce((n, b) => n + (b.length || 0), 0) }; })(),
      summary: summarize(this), provenance: provenance(this),
    };
  }
}

function summarize(r) {
  const exposures = r.signals.filter((s) => s.kind === 'privacy');
  const fields = metadataFields(r);
  const removable = r.cleanable();
  const what = `${fields.toLocaleString('en-US')} metadata field${fields === 1 ? '' : 's'} in ${removable.length} block${removable.length === 1 ? '' : 's'}`;
  if (exposures.length) {
    const names = exposures.slice(0, 3).map((s) => s.short ?? s.title.toLowerCase());
    if (exposures.length > 3) names.push(`${exposures.length - 3} more`);
    return { level: 'exposed', title: `${capitalize(listJoin(names))} found`, detail: `This file carries ${what}. Anyone you share it with can read them.` };
  }
  if (fields) return { level: 'some', title: 'No sensitive metadata found', detail: `This file carries ${what}, but none of it is location, names, serial numbers, prompts or hidden data.` };
  return { level: 'clean', title: 'No metadata found', detail: 'This file carries no readable metadata beyond its basic image properties.' };
}

function provenance(r) {
  const declared = r.signals.filter((s) => s.kind === 'declared');
  const clues = r.signals.filter((s) => s.kind === 'clue');
  const hasCamera = r.highlights.get('Camera')?.some((f) => f.key === 'Make' || f.key === 'Model');
  if (declared.length) return { level: 'declared', title: 'AI generation is declared in this file', detail: 'The file contains metadata stating it was created or edited with AI. Metadata can be added or edited by anyone, so treat this as a statement, not proof.' };
  if (clues.length) return { level: 'clues', title: 'Generator clues found', detail: 'Tool names associated with AI image generation appear in software fields. This is a clue, not a determination.' };
  if (r.c2pa.length) return { level: 'credentials', title: 'Content Credentials present', detail: 'A C2PA manifest describes this file’s history. Its signature was not verified here.' };
  if (hasCamera) return { level: 'camera', title: 'Camera metadata found, no AI declarations', detail: 'The file names a capture device. Camera metadata can be copied or forged, so this does not prove the image is a photograph.' };
  return { level: 'none', title: 'No provenance evidence found', detail: 'This does not mean the image is authentic or human-made. Metadata is often stripped by apps and social platforms, and invisible watermarks such as SynthID cannot be detected from metadata.' };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const listJoin = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
