// Finds the external reference tools and runs them. Every tool is optional: a missing tool turns its
// checks into SKIP with the reason, never into PASS.
//
// Environment:
//   EXIFTOOL_DIR  directory holding an unpacked ExifTool distribution (the `exiftool` script and lib/)
//   EXIFTOOL      path to an exiftool executable (default: `exiftool` on PATH)
//   PERL5LIB      passed through, so ExifTool can find Archive::Zip for Office, ODF and EPUB files
//   FFMPEG, FFPROBE, QPDF, PDFINFO, PDFSIG, PDFDETACH  paths to those tools (default: on PATH)
//   PYTHON        a Python 3 interpreter (default: python3). For the generated Office and ODF inputs it
//                 needs python-docx, openpyxl, python-pptx and odfpy, for example from a throwaway venv.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
  return null;
}

function locate(envName, binary) {
  const fromEnv = process.env[envName];
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  return onPath(binary);
}

// Runs a command with a time limit. Returns { status, stdout, stderr } with stdout as a Buffer.
export function run(cmd, args, { input, timeout = 60000, maxBuffer = 256 * 1024 * 1024, env } = {}) {
  const r = spawnSync(cmd, args, { input, timeout, maxBuffer, env: env ?? process.env });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? Buffer.alloc(0), stderr: (r.stderr ?? Buffer.alloc(0)).toString('utf8'), error: r.error };
}

function exiftoolCommand() {
  if (process.env.EXIFTOOL_DIR) {
    const script = join(process.env.EXIFTOOL_DIR, 'exiftool');
    if (!existsSync(script)) return null;
    const perl = onPath('perl');
    return perl ? [perl, script] : null;
  }
  const bin = locate('EXIFTOOL', 'exiftool');
  return bin ? [bin] : null;
}

export function findTools() {
  const tools = {};
  const et = exiftoolCommand();
  if (et) {
    const v = run(et[0], [...et.slice(1), '-ver']);
    if (v.status === 0) tools.exiftool = { cmd: et, version: v.stdout.toString().trim() };
  }
  for (const [key, env, bin, arg] of [['ffmpeg', 'FFMPEG', 'ffmpeg', '-version'], ['ffprobe', 'FFPROBE', 'ffprobe', '-version'], ['qpdf', 'QPDF', 'qpdf', '--version'], ['pdfinfo', 'PDFINFO', 'pdfinfo', '-v'], ['pdfsig', 'PDFSIG', 'pdfsig', '-v'], ['pdfdetach', 'PDFDETACH', 'pdfdetach', '-v']]) {
    const path = locate(env, bin);
    if (!path) continue;
    const v = run(path, [arg]);
    if (v.error || (v.status !== 0 && !/version/i.test(v.stdout.toString() + v.stderr))) continue;
    tools[key] = { cmd: [path], version: (v.stdout.toString() + v.stderr).split('\n')[0].trim() };
  }
  const python = process.env.PYTHON || onPath('python3');
  if (python && existsSync(python)) {
    const v = run(python, ['-c', 'import sys; print(sys.version.split()[0])']);
    if (v.status === 0) {
      tools.python = { cmd: [python], version: v.stdout.toString().trim() };
      const mods = run(python, ['-c', 'import importlib.util as u\nfor m in ["docx","openpyxl","pptx","odf"]: print(m, bool(u.find_spec(m)))']);
      tools.python.modules = Object.fromEntries(mods.stdout.toString().trim().split('\n').filter(Boolean).map((l) => { const [m, ok] = l.split(' '); return [m, ok === 'True']; }));
    }
  }
  return tools;
}

// A long-running ExifTool (-stay_open), so thousands of files do not each pay Perl's start-up cost.
export class ExifTool {
  constructor(tool) {
    this.proc = spawn(tool.cmd[0], [...tool.cmd.slice(1), '-stay_open', 'True', '-@', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = ''; this.errors = ''; this.queue = []; this.seq = 0;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => { this.buffer += d; this.drain(); });
    this.proc.stderr.on('data', (d) => { this.errors += d; });
  }

  drain() {
    for (;;) {
      const head = this.queue[0];
      if (!head) return;
      const marker = `{ready${head.id}}`;
      const at = this.buffer.indexOf(marker);
      if (at < 0) return;
      const out = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + marker.length).replace(/^\r?\n/, '');
      this.queue.shift();
      const err = this.errors; this.errors = '';
      head.resolve({ stdout: out, stderr: err });
    }
  }

  // Returns ExifTool's JSON object for one file.
  async read(path, args = ['-j', '-a', '-G1', '-s', '-ee3', '-u']) {
    const id = ++this.seq;
    const p = new Promise((resolve) => this.queue.push({ id, resolve }));
    this.proc.stdin.write([...args, path, `-execute${id}`, ''].join('\n'));
    const { stdout, stderr } = await p;
    let json;
    try { json = JSON.parse(stdout)[0] ?? {}; } catch { json = {}; }
    return { tags: json, stderr };
  }

  close() { this.proc.stdin.end('-stay_open\nFalse\n'); }
}
