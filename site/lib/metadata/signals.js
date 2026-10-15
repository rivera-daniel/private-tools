// Provenance and privacy interpretation, kept apart from the format parsers.

// Matched only against software fields (Software, CreatorTool, originating program, C2PA generator and agent),
// never free text. Names that are also ordinary words (Aurora, Imagen, Runway, Flux) need their product form.
export const AI_TOOL_PATTERN = /DALL[·\-\s]?E|Midjourney|Stable[\s-]?Diffusion|\bSDXL\b|ComfyUI|AUTOMATIC1111|Adobe Firefly|Google Imagen|\bGemini\b|NovelAI|InvokeAI|Fooocus|Leonardo\.?Ai|Ideogram|FLUX\.1|Runway\s?ML|Runway Gen-?\d|Kling AI|\bSora\b|GPT-4o|ChatGPT|OpenAI|Image Creator|Draw Things|DiffusionBee|Krea AI|Recraft|Grok Imagine|Nano Banana/i;

const AI_SOURCE_TYPES = {
  trainedalgorithmicmedia: 'Created by a trained AI model',
  compositewithtrainedalgorithmicmedia: 'Composite that includes AI-generated content',
  algorithmicmedia: 'Created by an algorithm without a trained model',
  compositesynthetic: 'Composite that includes synthetic content',
};

export function sourceTypeSignal(value, r, source) {
  for (const part of String(value).split(';')) {
    const code = part.trim().split('/').pop();
    const meaning = AI_SOURCE_TYPES[code.replace(/[^A-Za-z]/g, '').toLowerCase()];
    if (meaning) r.signal('declared', meaning, `Digital source type is "${code}" (IPTC vocabulary).`, source);
  }
}

// Cross-source privacy findings, run once after every parser has finished.
export function analyze(r) {
  const people = r.highlights.get('People') ?? [];
  if (people.length) r.signal('privacy', 'Names or ownership stored', 'Author, owner, credit or copyright fields name a person or organization.', 'Metadata', 'names');
  const camera = r.highlights.get('Camera') ?? [];
  if (camera.some((f) => /serial/i.test(f.key))) r.signal('privacy', 'Device serial number stored', 'A serial number can link this file to other photos from the same camera.', 'EXIF', 'a device serial number');
  if ((r.highlights.get('Generation data') ?? []).some((f) => f.flag === 'privacy')) r.signal('privacy', 'Prompt text stored', 'The full generation prompt is readable by anyone who has the file.', 'Generation data', 'prompt text');
  const location = (r.highlights.get('Location') ?? []).filter((f) => f.key !== 'GPS coordinates');
  if (location.length && !r.signals.some((s) => s.title === 'Exact location stored')) r.signal('privacy', 'Place names stored', `Location fields name a place: ${location.map((f) => f.value).slice(0, 3).join(', ')}.`, 'Metadata', 'place names');
  const software = (r.highlights.get('Software') ?? []).map((f) => f.value).join(' ');
  if (camera.length && /Photoshop|Lightroom|GIMP|Affinity|Pixelmator|Snapseed|Capture One/i.test(software)) r.add('Software', 'Note', 'Edited after capture');
}
