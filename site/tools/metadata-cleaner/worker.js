import { cleanImage } from '/tools/lib/clean/index.js';

self.onmessage = async ({ data: { id, file } }) => {
  try {
    const result = await cleanImage(await file.arrayBuffer());
    self.postMessage({ id, ...result }, result.ok ? [result.data.buffer] : []);
  } catch (error) {
    self.postMessage({ id, ok: false, reason: 'The cleaner stopped unexpectedly. The file may be damaged.' });
  }
};
