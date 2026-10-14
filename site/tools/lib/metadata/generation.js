// Text metadata written by image generators (PNG text chunks, GIF and JPEG comments).
import { AI_TOOL_PATTERN } from './signals.js';

const GENERATION_KEYS = new Set(['parameters', 'prompt', 'workflow', 'dream', 'sd-metadata', 'invokeai_metadata', 'invokeai_graph', 'fooocus_scheme', 'generation_data', 'negative_prompt', 'ai_metadata']);

export function textEntry(r, source, keyword, value) {
  if (!keyword || !value) return;
  const key = keyword.toLowerCase();
  const generation = GENERATION_KEYS.has(key);
  r.field(source, keyword, value, { flag: generation ? 'privacy' : undefined });
  if (generation) r.add('Generation data', keyword, value);
  else if (['comment', 'description', 'title', 'author', 'copyright', 'source', 'software', 'disclaimer', 'warning', 'creation time'].includes(key)) {
    const group = { comment: 'Comments', description: 'Description', title: 'Description', author: 'People', copyright: 'People', software: 'Software', 'creation time': 'Dates' }[key] ?? 'Description';
    r.add(group, keyword, value, { flag: group === 'People' ? 'privacy' : undefined });
  }
  if (key === 'parameters') parseA1111(value, r);
  else if (key === 'prompt' || key === 'workflow') parseComfy(key, value, r);
  else if (['dream', 'sd-metadata', 'invokeai_metadata', 'invokeai_graph'].includes(key)) r.signal('declared', 'InvokeAI generation data', `The "${keyword}" field stores generation settings written by InvokeAI.`, `${source} ${keyword}`);
  else if (key === 'fooocus_scheme') r.signal('declared', 'Fooocus generation data', 'Fooocus writes this field when it saves a generated image.', `${source} fooocus_scheme`);
  else if (key === 'software' && AI_TOOL_PATTERN.test(value)) r.signal('clue', 'AI tool named in metadata', `${keyword}: ${value.slice(0, 160)}`, `${source} ${keyword}`);
}

function parseA1111(text, r) {
  const lines = text.split('\n');
  const settings = lines.find((l) => /^Steps:\s*\d+/.test(l.trim()));
  const negIndex = lines.findIndex((l) => l.startsWith('Negative prompt:'));
  const promptEnd = negIndex >= 0 ? negIndex : lines.indexOf(settings);
  const prompt = lines.slice(0, promptEnd < 0 ? lines.length : promptEnd).join('\n').trim();
  if (prompt) r.add('Generation data', 'Prompt', prompt, { flag: 'privacy' });
  if (settings) {
    for (const part of settings.split(/,\s*(?=[A-Z][\w\s]*:)/)) {
      const m = part.match(/^\s*([^:]{1,40}):\s*(.+)$/);
      if (m && ['Steps', 'Sampler', 'CFG scale', 'Seed', 'Size', 'Model', 'Model hash', 'Version', 'Schedule type'].includes(m[1])) r.add('Generation data', m[1], m[2]);
    }
  }
  r.signal('declared', 'Stable Diffusion generation settings', 'A "parameters" field in the format written by AUTOMATIC1111, Forge and compatible tools records the prompt and sampler settings.', 'PNG parameters');
}

function parseComfy(key, text, r) {
  let graph;
  try { graph = JSON.parse(text); } catch { r.warn(`The ComfyUI "${key}" field is not valid JSON.`); return; }
  r.signal('declared', 'ComfyUI workflow embedded', 'ComfyUI saves its node graph inside generated images. The full workflow can be loaded back into ComfyUI.', 'PNG prompt and workflow chunks');
  if (key !== 'prompt' || !graph || typeof graph !== 'object') return;
  const nodes = Object.values(graph).filter((n) => n && typeof n === 'object' && typeof n.class_type === 'string');
  r.add('Generation data', 'ComfyUI nodes', String(nodes.length));
  const models = new Set(); const prompts = [];
  for (const n of nodes) {
    const inputs = n.inputs && typeof n.inputs === 'object' ? n.inputs : {};
    for (const k of ['ckpt_name', 'unet_name', 'lora_name', 'model_name']) if (typeof inputs[k] === 'string') models.add(inputs[k]);
    if (/CLIPTextEncode/i.test(n.class_type) && typeof inputs.text === 'string' && inputs.text.trim()) prompts.push(inputs.text.trim());
  }
  if (models.size) r.add('Generation data', 'Models', [...models].join(', '));
  prompts.slice(0, 4).forEach((p, i) => r.add('Generation data', prompts.length > 1 ? `Prompt text ${i + 1}` : 'Prompt text', p, { flag: 'privacy' }));
}
