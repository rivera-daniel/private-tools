import { cleanFile } from '/lib/clean/index.js';

self.onmessage = async ({ data: { id, file, options } }) => {
  try {
    const result = await cleanFile(await file.arrayBuffer(), file.name, options);
    self.postMessage({ id, ...result }, result.ok ? [result.data.buffer] : []);
  } catch (error) {
    self.postMessage({ id, ok: false, reason: 'The cleaner stopped unexpectedly. The file may be damaged.' });
  }
};
