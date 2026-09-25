import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from './window-state.mjs';

const ownDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = 41827;
const assets = new Map([
  ['', ['window-web.html', 'text/html; charset=utf-8']],
  ['app.css', ['window-web.css', 'text/css; charset=utf-8']],
  ['app.js', ['window-web.js', 'text/javascript; charset=utf-8']],
]);

export async function createWindowWebServer({ root, token = randomBytes(24).toString('hex'), getRows = () => snapshot(root) }) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('Invalid window access token');
  const files = new Map(await Promise.all([...assets].map(async ([route, [name, type]]) =>
    [route, { bytes: await readFile(path.join(ownDir, name)), type }])));
  const prefix = `/${token}/`;
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    // A token protects against incidental access by other local pages. This is not OS isolation.
    if (!address || req.headers.host !== `127.0.0.1:${address.port}` || !['GET', 'HEAD'].includes(req.method)
      || !req.url?.startsWith(prefix) || req.url.includes('?') || req.url.includes('#')) {
      res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    const route = req.url.slice(prefix.length);
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    };
    if (route === 'api/runs') {
      try {
        const body = JSON.stringify(await getRows());
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        res.writeHead(503, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : '{"error":"Status unavailable"}');
      }
      return;
    }
    const file = files.get(route);
    if (!file) { res.writeHead(404, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': file.type });
    res.end(req.method === 'HEAD' ? undefined : file.bytes);
  });
  return { server, token, url: () => `http://127.0.0.1:${server.address().port}/${token}/` };
}

function edgePath() {
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (base) {
      const candidate = path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function openEdge(edge, root, url) {
  const browser = spawn(edge, [
    `--app=${url}`, `--user-data-dir=${path.join(root, 'web-profile')}`,
    '--no-first-run', '--disable-background-mode', '--window-size=760,620',
  ], { stdio: 'ignore', detached: true, windowsHide: false });
  browser.on('error', () => {});
  browser.unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32' || process.argv.length !== 4
    || !['--serve', '--open'].includes(process.argv[2]) || !path.isAbsolute(process.argv[3])) process.exitCode = 2;
  else {
    const root = process.argv[3];
    const edge = edgePath();
    if (!edge) process.exitCode = 2;
    else if (process.argv[2] === '--open') {
      try {
        const url = (await readFile(path.join(root, 'web-url.json'), 'utf8')).trim();
        if (!/^http:\/\/127\.0\.0\.1:41827\/[a-f0-9]{48}\/$/.test(url)) throw new Error('Invalid saved URL');
        const response = await fetch(`${url}api/runs`, { signal: AbortSignal.timeout(3_000) });
        if (!response.ok) throw new Error('Status service unavailable');
        openEdge(edge, root, url);
      } catch { process.exitCode = 1; }
    } else {
      const { server, url } = await createWindowWebServer({ root });
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(PORT, '127.0.0.1', resolve);
        });
        await mkdir(path.join(root, 'web-profile'), { recursive: true, mode: 0o700 });
        await writeFile(path.join(root, 'web-url.json'), url(), { mode: 0o600 });
        openEdge(edge, root, url());
        // Closing the browser never owns or cancels a Squire run. Reopen explicitly with --open.
      } catch { if (server.listening) server.close(); }
    }
  }
}
