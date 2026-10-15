import { inspectImage, LIMITS } from '/lib/metadata/index.js';

self.onmessage = async ({ data: file }) => {
  try {
    if (file.size > LIMITS.maxFileBytes) throw new Error('This file is larger than 200 MB.');
    self.postMessage({ ok: true, report: await inspectImage(await file.arrayBuffer()) });
  } catch (error) {
    self.postMessage({ ok: false, error: error.message });
  }
};
