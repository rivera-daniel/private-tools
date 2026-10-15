// Independent verification of the Metadata Cleaner: cleans a corpus with planted secrets, then checks every
// output with external reference tools (ExifTool, ffprobe/ffmpeg, qpdf, poppler, Python zipfile) and a
// byte scanner that shares no code with the cleaner. Prints a format x check matrix and writes it to
// test-results/independent-report.md. Exits non-zero on any failure.
//
//   npm run test:independent            all items
//   npm run test:independent -- jpeg    only items whose id contains "jpeg"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFile, cleanableFormats } from '../../site/lib/clean/index.js';
import { findTools, ExifTool } from './tools.mjs';
import { makeCorpus } from './make-corpus.mjs';
import { CHECKS } from './checks.mjs';

const filter = process.argv[2] ?? '';
const tools = findTools();
const { items: all, skipped } = await makeCorpus(tools);
const items = all.filter((i) => i.id.includes(filter));
const et = tools.exiftool ? new ExifTool(tools.exiftool) : null;
const dir = mkdtempSync(join(tmpdir(), 'pt-independent-'));
const results = [];

try {
  for (const item of items) {
    const row = { item, cleaner: null, checks: {} };
    results.push(row);
    let r;
    try { r = await cleanFile(item.data, item.name, item.options); } catch (error) { row.cleaner = { status: 'fail', detail: `threw: ${error.message}` }; continue; }
    if (item.expect === 'refuse') { row.cleaner = r.ok ? { status: 'fail', detail: 'cleaned a format it should refuse' } : { status: 'pass', detail: `refused: ${r.reason}` }; continue; }
    if (!r.ok) { row.cleaner = { status: 'fail', detail: `refused: ${r.reason}` }; continue; }
    row.cleaner = { status: 'pass', detail: `${r.bytesBefore} -> ${r.bytesAfter} bytes${Object.keys(item.options).length ? `, options: ${Object.keys(item.options).join(', ')}` : ''}` };
    const ext = item.name.slice(item.name.lastIndexOf('.'));
    const inPath = join(dir, `${item.id}-in${ext}`); const outPath = join(dir, `${item.id}-out${ext}`);
    writeFileSync(inPath, item.data); writeFileSync(outPath, r.data);
    const ctx = { item, input: item.data, output: r.data, inPath, outPath, tools, et };
    for (const [name, check] of CHECKS) {
      let res;
      try { res = await check(ctx); } catch (error) { res = { status: 'fail', detail: `check crashed: ${error.message}` }; }
      if (res) row.checks[name] = res;
    }
  }
} finally {
  et?.close();
  rmSync(dir, { recursive: true, force: true });
}

// Coverage: every format the cleaner claims must have at least one cleaned item.
const covered = new Set(results.filter((r) => r.item.expect === 'clean').map((r) => r.item.format));
const uncovered = filter ? [] : [...cleanableFormats()].filter((f) => !covered.has(f));

const COLS = ['cleaner', ...CHECKS.map(([n]) => n)];
const mark = (s) => (s ? { pass: 'PASS', fail: 'FAIL', skip: 'skip' }[s.status] : '-');
const cell = (row, col) => (col === 'cleaner' ? row.cleaner : row.checks[col]);

// Format x check: FAIL if any item fails, PASS if at least one passes, skip if all skipped.
const formats = [...new Set(results.map((r) => r.item.format))];
const summary = formats.map((f) => {
  const rows = results.filter((r) => r.item.format === f);
  return [f, rows.length, ...COLS.map((c) => {
    const cells = rows.map((r) => cell(r, c)).filter(Boolean);
    if (!cells.length) return '-';
    if (cells.some((x) => x.status === 'fail')) return 'FAIL';
    if (cells.some((x) => x.status === 'pass')) return 'PASS';
    return 'skip';
  })];
});

const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const failures = []; const policy = []; const skips = [];
for (const r of results) for (const c of COLS) {
  const x = cell(r, c);
  if (!x) continue;
  if (x.status === 'fail') failures.push(`- **${r.item.id}** (${r.item.format}, ${r.item.source}) ${c}: ${x.detail}`);
  if (x.status === 'skip') skips.push(`- ${r.item.id} ${c}: ${x.detail}`);
  if (/product decision/.test(x.detail ?? '')) policy.push(`- ${r.item.id} ${c}: ${x.detail.slice(x.detail.indexOf('kept, product decision'))}`);
}
for (const f of uncovered) failures.push(`- **${f}**: no cleaned corpus item covers this cleanable format`);

const toolList = Object.entries(tools).map(([k, v]) => `${k} ${v.version}`).join(', ') || 'none';
const report = [
  '# Independent cleaner verification', '',
  `Tools: ${toolList}`, `Items: ${results.length} (${results.filter((r) => r.item.source === 'built-in').length} built-in, ${results.filter((r) => r.item.source !== 'built-in').length} from external generators)`, '',
  '## Format x check', '', table(['format', 'items', ...COLS], summary), '',
  '## Items', '', table(['item', 'format', 'source', ...COLS], results.map((r) => [r.item.id, r.item.format, r.item.source, ...COLS.map((c) => mark(cell(r, c)))])), '',
  `## Failures (${failures.length})`, '', failures.length ? failures.join('\n') : 'None.', '',
  '## Kept by design (product decisions)', '', policy.length ? policy.join('\n') : 'None.', '',
  '## Skipped', '', [...skipped.map((s) => `- generator: ${s}`), ...skips].join('\n') || 'None.', '',
].join('\n');

console.log(report);
mkdirSync(new URL('../../test-results/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../test-results/independent-report.md', import.meta.url), report);
process.exitCode = failures.length ? 1 : 0;
