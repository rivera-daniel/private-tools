import { inspectFile, LIMITS } from '/tools/lib/metadata/index.js';
import { cleanableFormats } from '/tools/lib/clean/index.js';

const CLEANABLE = cleanableFormats();

self.onmessage = async ({ data: file }) => {
  try {
    if (file.size > LIMITS.maxFileBytes) throw new Error('This file is larger than 200 MB.');
    const report = await inspectFile(await file.arrayBuffer(), file.name);
    self.postMessage({ ok: true, report, cleanable: CLEANABLE.has(report.format) });
  } catch (error) {
    self.postMessage({ ok: false, error: error.message });
  }
};
