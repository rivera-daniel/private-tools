// Fuzzer worker process: inspects and cleans one input per message and reports what happened, including
// its own peak memory for that case. Runs as a child process so a hang can be killed and memory measured
// per process. Messages use advanced serialization, so bytes travel as Uint8Array.
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectFile } from '../../site/tools/lib/metadata/index.js';
import { cleanFile } from '../../site/tools/lib/clean/index.js';

// Linux: writing 5 to clear_refs resets the peak resident size, so VmHWM measures this case alone.
function resetPeak() { try { writeFileSync('/proc/self/clear_refs', '5'); return true; } catch { return false; } }
function peakMb() {
  try { const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8')); if (m) return Number(m[1]) / 1024; } catch { /* not Linux */ }
  return process.memoryUsage().rss / 1048576;
}

process.on('message', async ({ id, data, name, options }) => {
  const u8 = data;
  resetPeak();
  const out = { id };
  const t0 = performance.now();
  try { const r = await inspectFile(u8, name); out.inspect = { format: r.format ?? null, warnings: r.warnings.length }; }
  catch (error) { out.inspectError = `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}`; }
  const t1 = performance.now();
  try {
    const r = await cleanFile(u8, name, options);
    out.clean = r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.reason };
  } catch (error) { out.cleanError = `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}`; }
  out.ms = { inspect: t1 - t0, clean: performance.now() - t1 };
  out.peakMb = peakMb();
  process.send(out);
});

process.on('unhandledRejection', (error) => { process.send({ fatal: `unhandled rejection: ${error?.stack ?? error}` }); process.exit(70); });
