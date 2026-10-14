import { LIMITS } from './bytes.js';
import { AI_TOOL_PATTERN, sourceTypeSignal } from './signals.js';

const HIGHLIGHTS = {
  'xmp:CreatorTool': ['Software', 'Creator tool'], 'xmp:CreateDate': ['Dates', 'Created'], 'xmp:ModifyDate': ['Dates', 'Modified'],
  'photoshop:DateCreated': ['Dates', 'Created (Photoshop)'], 'dc:creator': ['People', 'Creator'], 'dc:rights': ['People', 'Rights'],
  'dc:title': ['Description', 'Title'], 'dc:description': ['Description', 'Description'], 'dc:subject': ['Description', 'Keywords'],
  'photoshop:Credit': ['People', 'Credit'], 'photoshop:AuthorsPosition': ['People', 'Author position'], 'photoshop:City': ['Location', 'City'],
  'photoshop:State': ['Location', 'State'], 'photoshop:Country': ['Location', 'Country'], 'Iptc4xmpCore:Location': ['Location', 'Location'],
  'Iptc4xmpExt:DigitalSourceType': ['Provenance', 'Digital source type'], 'tiff:Make': ['Camera', 'Make'], 'tiff:Model': ['Camera', 'Model'],
  'aux:SerialNumber': ['Camera', 'Body serial number'], 'exifEX:BodySerialNumber': ['Camera', 'Body serial number'], 'aux:Lens': ['Camera', 'Lens model'],
  'exifEX:LensModel': ['Camera', 'Lens model'], 'exif:GPSLatitude': ['Location', 'GPS latitude'], 'exif:GPSLongitude': ['Location', 'GPS longitude'],
  'xmpMM:DocumentID': ['File', 'Document ID'], 'xmpMM:OriginalDocumentID': ['File', 'Original document ID'], 'photoshop:History': ['Software', 'Edit history'],
  'Iptc4xmpExt:AISystemUsed': ['Provenance', 'AI system used'], 'Iptc4xmpExt:AIPromptInformation': ['Generation data', 'Prompt'],
  'Iptc4xmpExt:AISystemVersionUsed': ['Provenance', 'AI system version'], 'xmpRights:Owner': ['People', 'Rights owner'], 'aux:OwnerName': ['People', 'Camera owner'],
  'Iptc4xmpCore:CreatorContactInfo': ['People', 'Creator contact'],
};
const PRIVATE = /SerialNumber|OwnerName|GPS|Location|City|State|Country|CreatorContactInfo|Ci(Adr|Email|Tel|Url)|creator$|Owner|AuthorsPosition|AIPromptInformation/;
const STRUCTURAL = /^(rdf:|x:|xmlns|xml:)/;

// Linear scan over tags. Regex-heavy XML matching backtracks badly on hostile input.
export function parseXmp(xml, r, source = 'XMP') {
  if (!xml || typeof xml !== 'string') return;
  if (xml.length > LIMITS.maxXmpChars) { r.warn(`${source} packet is larger than 4 MB. Only the first 4 MB was read.`); xml = xml.slice(0, LIMITS.maxXmpChars); }
  r.field(source, 'Packet size', `${xml.length.toLocaleString('en-US')} characters`);
  const values = new Map();
  const put = (key, value) => {
    // Pre-2004 files use the xap prefixes for the xmp namespaces.
    key = key.replace(/(^| › )xap(MM|Rights|BJ|TPg|DynA|G)?:/g, '$1xmp$2:');
    value = decodeEntities(value).trim();
    if (!key || !value) return;
    const list = values.get(key) ?? [];
    if (!list.includes(value) && list.length < 200) list.push(value);
    values.set(key, list);
  };
  const stack = [];
  const path = () => stack.filter((n) => !STRUCTURAL.test(n)).join(' › ');
  let i = 0; const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i && stack.length) put(path(), xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); if (e < 0) break; if (stack.length) put(path(), xml.slice(lt + 9, e)); i = e + 3; continue; }
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') { const e = xml.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag[0] === '/') { stack.pop(); continue; }
    const name = /^[^\s/>]+/.exec(tag)?.[0] ?? '';
    const parent = STRUCTURAL.test(name) ? path() : [path(), name].filter(Boolean).join(' › ');
    for (const [key, value] of attributes(tag)) {
      if (STRUCTURAL.test(key) || !key.includes(':')) continue;
      put(parent ? `${parent} › ${key}` : key, value);
    }
    if (!tag.endsWith('/') && stack.length < 64) stack.push(name);
  }
  for (const [key, list] of values) {
    const value = list.join('; ');
    const top = key.split(' › ')[0];
    const prefix = top.includes(':') ? top.split(':')[0] : 'other';
    const flag = PRIVATE.test(key) ? 'privacy' : undefined;
    r.field(`${source} ${prefix}`, key, value, { flag });
    const hl = HIGHLIGHTS[key];
    if (hl) r.add(hl[0], hl[1], value, { flag });
    if (/DigitalSourceType$/i.test(key)) sourceTypeSignal(value, r, `${source} ${key}`);
    if (key === 'Iptc4xmpExt:AISystemUsed') r.signal('declared', 'AI system named in metadata', `AI system used: ${value.slice(0, 160)}`, `${source} ${key}`);
    else if ((key === 'xmp:CreatorTool' || key === 'tiff:Software') && AI_TOOL_PATTERN.test(value)) r.signal('clue', 'AI tool named in metadata', `${key}: ${value.slice(0, 160)}`, `${source} ${key}`);
    if (key === 'exif:GPSLatitude') r.signal('privacy', 'Exact location stored', `XMP stores GPS coordinates (${value}${values.get('exif:GPSLongitude') ? `, ${values.get('exif:GPSLongitude')[0]}` : ''}).`, `${source} exif:GPSLatitude`, 'exact location');
    if (key === 'Iptc4xmpExt:AIPromptInformation') r.signal('privacy', 'Prompt text stored', 'The generation prompt is readable by anyone who has the file.', `${source} ${key}`, 'prompt text');
  }
  // China's TC260 label for AI-generated content.
  const aigc = [...values].find(([k]) => /(^|:)AIGC$/i.test(k));
  if (aigc) {
    r.add('Provenance', 'AIGC label', aigc[1].join('; '));
    r.signal('declared', 'AI-generated content label', 'The file carries an AIGC label in the format required for AI-generated content in China.', `${source} AIGC`);
  }
}

// Hand-rolled so that unterminated quotes cannot cause quadratic rescans.
export function* attributes(tag) {
  let j = tag.search(/[\s/]|$/);
  while (j < tag.length) {
    while (j < tag.length && /[\s/]/.test(tag[j])) j++;
    const start = j;
    while (j < tag.length && !/[\s=/]/.test(tag[j])) j++;
    const key = tag.slice(start, j);
    while (j < tag.length && /\s/.test(tag[j])) j++;
    if (tag[j] !== '=') { if (j === start) j++; continue; }
    j++;
    while (j < tag.length && /\s/.test(tag[j])) j++;
    const q = tag[j];
    if (q !== '"' && q !== "'") continue;
    const end = tag.indexOf(q, j + 1);
    if (end < 0) return;
    yield [key, tag.slice(j + 1, end)];
    j = end + 1;
  }
}

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') { const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
  });
}
