// Text for the standard Helvetica font, which shows WinAnsi (Western European) characters. No MuPDF here,
// so the page can warn about characters that will not show.

// Unicode to WinAnsiEncoding for the characters that differ from Latin-1.
const WIN = new Map([[0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]]);

// Returns the WinAnsi codes and the characters actually drawn (others become '?').
export function winAnsi(text) {
  const codes = []; let shown = '';
  for (const ch of String(text).replace(/[\r\n\t]+/g, ' ')) {
    const cp = ch.codePointAt(0);
    let code = (cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff) ? cp : WIN.get(cp);
    if (code === undefined) code = 0x3f;
    codes.push(code); shown += code === 0x3f && cp !== 0x3f ? '?' : ch;
  }
  return { codes, shown };
}
export const isLatin = (text) => winAnsi(text).shown === String(text).replace(/[\r\n\t]+/g, ' ');
