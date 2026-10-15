import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { redirectFor } from '../worker/index.js';

const at = (u) => redirectFor(new URL(u));

test('old address redirects to the tools origin with the /tools prefix removed', () => {
  assert.equal(at('https://danielrivera.ai/tools'), 'https://tools.danielrivera.ai/');
  assert.equal(at('https://danielrivera.ai/tools/'), 'https://tools.danielrivera.ai/');
  assert.equal(at('https://danielrivera.ai/tools/pdf-editor/'), 'https://tools.danielrivera.ai/pdf-editor/');
  assert.equal(at('https://danielrivera.ai/tools/archiver/worker.js?v=2'), 'https://tools.danielrivera.ai/archiver/worker.js?v=2');
  assert.equal(at('https://danielrivera.ai/toolsx/'), 'https://tools.danielrivera.ai/toolsx/');
});

test('tools origin is served from static assets', async () => {
  assert.equal(at('https://tools.danielrivera.ai/pdf-editor/'), null);
  const env = { ASSETS: { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) } };
  const served = await worker.fetch(new Request('https://tools.danielrivera.ai/archiver/'), env);
  assert.equal(await served.text(), 'asset /archiver/');
  const moved = await worker.fetch(new Request('https://danielrivera.ai/tools/archiver/'), env);
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('location'), 'https://tools.danielrivera.ai/archiver/');
});
