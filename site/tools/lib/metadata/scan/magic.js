// True file type from content, never from the name. own: the scan may set report.format to this name.
// Types another family reads and cleans (PDF, ZIP and its documents, OLE, the media family's formats,
// programs) stay unowned, so a file that family declined is never routed to its cleaner.
import { Bytes, latin1, startsWith } from '../bytes.js';
import { derKind } from './der.js';

const hex = (h, at = 0) => { const sig = h.match(/../g).map((x) => parseInt(x, 16)); return (u8) => sig.length + at <= u8.length && sig.every((x, i) => u8[at + i] === x); };
const ascii = (s, at = 0) => (u8) => startsWith(u8, s, at);
const riff = (form) => (u8) => startsWith(u8, 'RIFF') && startsWith(u8, form, 8);
const brand = (u8) => (startsWith(u8, 'ftyp', 4) ? latin1(u8.subarray(8, 12)) : '');
const IMAGE_BRANDS = /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif|avis|miaf|MiHE|MiHB)$/;
const ZIP_DOC = /\[Content_Types\]\.xml|word\/|xl\/|ppt\/|mimetypeapplication\/vnd\.oasis|mimetypeapplication\/epub\+zip/;

function peAt(u8, o = 0) {
  if (u8[o] !== 0x4d || u8[o + 1] !== 0x5a || o + 0x40 > u8.length) return false;
  const e = u8[o + 0x3c] | (u8[o + 0x3d] << 8) | (u8[o + 0x3e] << 16) | (u8[o + 0x3f] << 24);
  return e >= 0x40 && e < 0x10000 && startsWith(u8, 'PE\0\0', o + e);
}
const elfAt = (u8, o = 0) => startsWith(u8, '\x7fELF', o) && (u8[o + 4] === 1 || u8[o + 4] === 2) && (u8[o + 5] === 1 || u8[o + 5] === 2) && u8[o + 6] === 1;
const MACHO = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe];
const u32be = (u8, o = 0) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
const fatMacho = (u8) => (u32be(u8) === 0xcafebabe || u32be(u8) === 0xcafebabf) && u32be(u8, 4) > 0 && u32be(u8, 4) < 30;
// MPEG audio layer III frame header without an ID3 tag: sync, version and layer bits, valid bitrate and rate.
const mpegFrame = (u8, o) => u8[o] === 0xff && [0xfb, 0xfa, 0xf3, 0xf2, 0xe3, 0xe2].includes(u8[o + 1]) && (u8[o + 2] & 0xf0) !== 0xf0 && (u8[o + 2] & 0xf0) !== 0 && (u8[o + 2] & 0x0c) !== 0x0c;
const font = (u8) => hex('00010000')(u8) && u8.length > 12 && ((u8[4] << 8) | u8[5]) > 0 && ((u8[4] << 8) | u8[5]) < 100 && /^[a-zA-Z/ ]{4}$/.test(latin1(u8.subarray(12, 16)));

const T = (name, category, ext, test, own = true, extra = {}) => ({ name, category, ext: ext ? ext.split(' ') : [], test, own, ...extra });
const RAW = 'tif tiff dng cr2 nef nrw arw srf sr2 orf rw2 pef srw 3fr erf kdc dcr mef mos raw rwl iiq x3f';
const ZIP_EXT = 'zip docx docm dotx dotm xlsx xlsm xltx xltm pptx pptm potx ppsx odt ods odp odg odf ott epub jar war ear apk aab ipa xpi kmz 3mf vsdx nupkg whl appx msix appxbundle sketch pages numbers key usdz cbz oxps xps';

export const TYPES = [
  // Images. The image parsers own these.
  T('JPEG image', 'Image', 'jpg jpeg jpe jfif jif mpo', hex('ffd8ff'), false),
  T('PNG image', 'Image', 'png apng', ascii('\x89PNG\r\n\x1a\n'), false),
  T('GIF image', 'Image', 'gif', (u8) => startsWith(u8, 'GIF87a') || startsWith(u8, 'GIF89a'), false),
  T('WebP image', 'Image', 'webp', riff('WEBP'), false),
  T('TIFF or camera raw image', 'Image', RAW, (u8) => ['II*\0', 'MM\0*', 'IIRO', 'IIRS', 'IIU\0', 'II+\0', 'MM\0+'].some((s) => startsWith(u8, s)), false),
  T('Fujifilm raw image', 'Image', 'raf', ascii('FUJIFILMCCD-RAW'), false),
  T('HEIF image', 'Image', 'heic heif hif avif heics avifs cr3', (u8) => IMAGE_BRANDS.test(brand(u8)) || brand(u8) === 'crx ', false),
  T('JPEG XL image', 'Image', 'jxl', (u8) => startsWith(u8, '\0\0\0\x0cJXL \r\n\x87\n') || (u8[0] === 0xff && u8[1] === 0x0a), false),
  T('Photoshop document', 'Image', 'psd psb', ascii('8BPS'), false),
  T('BMP image', 'Image', 'bmp dib', (u8) => startsWith(u8, 'BM') && u8.length > 26 && u8[14] >= 12 && u8[15] === 0, false),
  T('ICO', 'Image', 'ico', (u8) => hex('00000100')(u8) && u8[4] + u8[5] > 0 && u8.length > 22 && u8[9] === 0),
  T('CUR', 'Image', 'cur', (u8) => hex('00000200')(u8) && u8[4] + u8[5] > 0 && u8.length > 22),
  T('ICNS', 'Image', 'icns', ascii('icns')),
  T('JPEG 2000', 'Image', 'jp2 jpf jpx j2k j2c jpm', (u8) => hex('0000000c6a5020200d0a870a')(u8) || hex('ff4fff51')(u8)),
  T('OpenEXR', 'Image', 'exr', hex('762f3101')),
  T('DDS', 'Image', 'dds', ascii('DDS ')),
  T('QOI', 'Image', 'qoi', ascii('qoif')),
  T('GIMP image', 'Image', 'xcf', ascii('gimp xcf')),
  T('Radiance HDR', 'Image', 'hdr pic', (u8) => startsWith(u8, '#?RADIANCE') || startsWith(u8, '#?RGBE')),
  // Documents.
  T('PostScript', 'Document', 'ps eps', (u8) => startsWith(u8, '%!PS') || hex('c5d0d3c6')(u8)),
  T('RTF document', 'Document', 'rtf', ascii('{\\rtf')),
  T('Microsoft compound file', 'Document', 'doc dot xls xlt ppt pot pps msi msp msg vsd pub mpp db', hex('d0cf11e0a1b11ae1'), false),
  T('DjVu document', 'Document', 'djvu djv', ascii('AT&TFORM')),
  // Archives.
  T('ZIP archive', 'Archive', ZIP_EXT, (u8) => u8.length >= 22 && u8[0] === 0x50 && u8[1] === 0x4b && [3, 5, 7].includes(u8[2]) && [4, 6, 8].includes(u8[3]), false,
    { refine: (u8) => (ZIP_DOC.test(latin1(u8.subarray(0, 8192))) ? { name: 'Office or OpenDocument file (ZIP)', category: 'Document' } : null) }),
  T('7z', 'Archive', '7z', hex('377abcaf271c')),
  T('RAR', 'Archive', 'rar', ascii('Rar!\x1a\x07')),
  T('gzip', 'Archive', 'gz tgz gzip svgz', hex('1f8b08')),
  T('xz', 'Archive', 'xz txz', hex('fd377a585a00')),
  T('bzip2', 'Archive', 'bz2 tbz2 tbz', (u8) => startsWith(u8, 'BZh') && u8[3] >= 0x31 && u8[3] <= 0x39 && hex('314159265359', 4)(u8)),
  T('Zstandard', 'Archive', 'zst tzst', hex('28b52ffd')),
  T('LZ4', 'Archive', 'lz4', hex('04224d18')),
  T('lzip', 'Archive', 'lz', ascii('LZIP')),
  T('Unix compress', 'Archive', 'z', hex('1f9d')),
  T('Cabinet', 'Archive', 'cab', ascii('MSCF\0\0\0\0')),
  T('Debian package', 'Archive', 'deb', (u8) => startsWith(u8, '!<arch>\ndebian-binary')),
  T('ar archive', 'Archive', 'a ar lib', ascii('!<arch>\n')),
  T('RPM package', 'Archive', 'rpm', hex('edabeedb')),
  T('XAR archive', 'Archive', 'xar pkg', ascii('xar!')),
  T('tar', 'Archive', 'tar', (u8) => startsWith(u8, 'ustar', 257)),
  T('ISO disc image', 'Archive', 'iso', (u8) => [0x8001, 0x8801, 0x9001].some((o) => startsWith(u8, 'CD001', o))),
  T('Disk image', 'Archive', 'vhd vmdk qcow qcow2 vdi', (u8) => startsWith(u8, 'conectix') || startsWith(u8, 'KDMV') || hex('514649fb')(u8) || startsWith(u8, '<<< Oracle VM VirtualBox Disk Image >>>')),
  T('LUKS encrypted volume', 'Other', 'luks img', hex('4c554b53babe')),
  // Audio and video. The media family owns the first group.
  T('MP3 audio', 'Audio', 'mp3', (u8) => startsWith(u8, 'ID3') || mpegFrame(u8, 0), false),
  T('FLAC audio', 'Audio', 'flac', ascii('fLaC'), false),
  T('Ogg media', 'Audio', 'ogg oga ogv opus spx', ascii('OggS'), false),
  T('WAV audio', 'Audio', 'wav wave', riff('WAVE'), false),
  T('AIFF audio', 'Audio', 'aif aiff aifc', (u8) => startsWith(u8, 'FORM') && (startsWith(u8, 'AIFF', 8) || startsWith(u8, 'AIFC', 8)), false),
  T('MPEG-4 audio', 'Audio', 'm4a m4b m4p m4r', (u8) => /^(M4A |M4B |M4P )$/.test(brand(u8)), false),
  T('QuickTime movie', 'Video', 'mov qt', (u8) => brand(u8) === 'qt  ' || (!brand(u8) && ['moov', 'mdat', 'wide', 'free'].some((t) => startsWith(u8, t, 4)) && u8.length > 16), false),
  T('MPEG-4 video', 'Video', 'mp4 m4v 3gp 3g2 f4v mp4v', (u8) => brand(u8) !== '' && !IMAGE_BRANDS.test(brand(u8)) && brand(u8) !== 'crx ', false),
  T('Matroska or WebM video', 'Video', 'mkv mka mks mk3d webm', hex('1a45dfa3'), false),
  T('AVI video', 'Video', 'avi', riff('AVI ')),
  T('MIDI', 'Audio', 'mid midi', ascii('MThd')),
  T('Flash video', 'Video', 'flv', ascii('FLV\x01')),
  T('Windows Media', 'Video', 'wmv wma asf', hex('3026b2758e66cf11')),
  T('MPEG program stream', 'Video', 'mpg mpeg vob', hex('000001ba')),
  T('MPEG transport stream', 'Video', 'ts mts m2ts', (u8) => u8.length > 376 && u8[0] === 0x47 && u8[188] === 0x47 && u8[376] === 0x47),
  T('AMR audio', 'Audio', 'amr', ascii('#!AMR')),
  T('Core Audio', 'Audio', 'caf', ascii('caff')),
  T('Monkey’s Audio', 'Audio', 'ape', ascii('MAC ')),
  T('WavPack', 'Audio', 'wv', ascii('wvpk')),
  T('AAC audio', 'Audio', 'aac', (u8) => u8[0] === 0xff && (u8[1] === 0xf1 || u8[1] === 0xf9) && (u8[2] & 0x3c) >> 2 < 13),
  // Programs. The programs family owns PE, ELF and Mach-O.
  T('Windows program', 'Program', 'exe dll sys ocx cpl scr efi mui drv node ax acm', (u8) => peAt(u8), false),
  T('ELF program', 'Program', 'so o ko elf axf prx out bin core', elfAt, false),
  T('Mach-O program', 'Program', 'dylib bundle macho', (u8) => MACHO.includes(u32be(u8)) || fatMacho(u8), false),
  T('Java class', 'Program', 'class', (u8) => u32be(u8) === 0xcafebabe && u32be(u8, 4) >= 45),
  T('Android DEX', 'Program', 'dex', ascii('dex\n')),
  T('WebAssembly', 'Program', 'wasm', ascii('\0asm')),
  T('Windows shortcut', 'Other', 'lnk', hex('4c0000000114020000000000c000000000000046')),
  // Fonts.
  T('TrueType font', 'Other', 'ttf', (u8) => font(u8) || startsWith(u8, 'true')),
  T('OpenType font', 'Other', 'otf', ascii('OTTO')),
  T('WOFF font', 'Other', 'woff', ascii('wOFF')),
  T('WOFF2 font', 'Other', 'woff2', ascii('wOF2')),
  T('TrueType collection', 'Other', 'ttc', ascii('ttcf')),
  // Databases and stores.
  T('SQLite', 'Other', 'sqlite sqlite3 db db3 sqlitedb', ascii('SQLite format 3\0')),
  T('Microsoft Access database', 'Other', 'mdb accdb', (u8) => startsWith(u8, 'Standard Jet DB', 4) || startsWith(u8, 'Standard ACE DB', 4)),
  T('KeePass database', 'Other', 'kdbx kdb', hex('03d9a29a')),
  T('Java keystore', 'Other', 'jks keystore', hex('feedfeed')),
  T('Binary property list', 'Other', 'plist', ascii('bplist00')),
  T('Finder folder data', 'Other', 'ds_store', hex('0000000142756431')),
  T('BitTorrent file', 'Other', 'torrent', ascii('d8:announce')),
  // Captures and dumps.
  T('Packet capture', 'Other', 'pcap cap dmp', (u8) => ['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].some((h) => hex(h)(u8))),
  T('Packet capture (pcapng)', 'Other', 'pcapng', hex('0a0d0d0a')),
  T('Windows memory dump', 'Other', 'dmp mdmp', ascii('MDMP\x93\xa7')),
  T('Windows registry hive', 'Other', 'dat hve', ascii('regf')),
  T('Windows event log', 'Other', 'evtx', ascii('ElfFile\0')),
  // Readers accept a PDF header anywhere in the first 1024 bytes, so this loose check runs last.
  T('PDF document', 'Document', 'pdf ai', (u8) => latin1(u8.subarray(0, 1024)).includes('%PDF-'), false),
];

// Extensions that only text formats use, so a binary file with one of them is mislabelled.
export const TEXT_EXT = new Set('txt text csv tsv json jsonl ndjson xml html htm xhtml md markdown yaml yml toml ini cfg conf log js mjs cjs ts tsx jsx css scss py rb go rs c h cc cpp hpp cs java kt swift php pl sh bash zsh ps1 bat cmd sql svg vcf ics eml srt vtt tex rst pem crt key pub asc env properties gitignore'.split(' '));

export function extension(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().toLowerCase();
  const dot = base.lastIndexOf('.');
  if (base === '.ds_store') return 'ds_store';
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1) : '';
}

const EXT_TYPES = new Map();
for (const t of TYPES) for (const e of t.ext) { if (!EXT_TYPES.has(e)) EXT_TYPES.set(e, []); EXT_TYPES.get(e).push(t); }
export const expectedFor = (ext) => EXT_TYPES.get(ext) ?? [];

// { name, category, own, ext, key? } for the content, or null when no signature matches.
export function sniff(u8) {
  for (const t of TYPES) {
    let hit = false;
    try { hit = t.test(u8); } catch { hit = false; }
    if (hit) return { ...t, ...(t.refine?.(u8) ?? {}) };
  }
  const der = u8[0] === 0x30 && u8.length < 1048576 ? derKind(u8) : null;
  if (der) return T(der, 'Other', 'der cer crt p12 pfx key p8 p7b p7s', null, true, { key: /private|PKCS#12/.test(der) });
  return null;
}

// Where the format's own structure ends, for formats whose parser may not report what follows.
// Returns a byte offset, or null when it cannot be determined.
export function logicalEnd(u8, type) {
  const b = new Bytes(u8);
  try {
    switch (type?.name) {
      case 'PDF document': {
        const tail = latin1(u8.subarray(Math.max(0, u8.length - 65536)));
        const at = tail.lastIndexOf('%%EOF');
        if (at < 0) return null;
        let end = u8.length - tail.length + at + 5;
        while (end < u8.length && (u8[end] === 0x0d || u8[end] === 0x0a || u8[end] === 0x20 || u8[end] === 0x00) && end - (u8.length - tail.length + at + 5) < 4) end++;
        return end;
      }
      case 'ZIP archive': case 'Office or OpenDocument file (ZIP)': {
        for (let o = u8.length - 22; o >= Math.max(0, u8.length - 22 - 65535); o--) if (b.u32(o, true) === 0x06054b50 && o + 22 + b.u16(o + 20, true) <= u8.length) return o + 22 + b.u16(o + 20, true);
        return null;
      }
      case '7z': return 32 + b.u64(12, true) + b.u64(20, true);
      case 'SQLite': {
        const page = b.u16(16) === 1 ? 65536 : b.u16(16); const pages = b.u32(28);
        return pages && b.u32(24) === b.u32(92) && page >= 512 ? page * pages : null;
      }
      case 'WAV audio': case 'AVI video': return 8 + b.u32(4, true) + (b.u32(4, true) & 1);
      case 'AIFF audio': return 8 + b.u32(4);
      case 'MPEG-4 audio': case 'MPEG-4 video': case 'QuickTime movie': case 'HEIF image': {
        let o = 0;
        for (let n = 0; o + 8 <= u8.length && n < 10000; n++) {
          let size = b.u32(o);
          if (size === 1) size = b.u64(o + 8); else if (size === 0) return u8.length;
          if (size < 8 || !/^[\x20-\x7e]{4}$/.test(b.ascii(o + 4, 4))) return o;
          o += size;
        }
        return Math.min(o, u8.length);
      }
      default: return null;
    }
  } catch { return null; }
}
