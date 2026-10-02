import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { validateConfig, identifier, Blocker } from './contracts.mjs';
import { Controller } from './controller.mjs';

export function publicState(state) {
  const { config, ...rest } = state;
  return { ...rest, services: Object.keys(config.services), limits: config.limits };
}
export async function createControlServer(store, { port = 0, providers = {}, tickMs = 1000 } = {}) {
  await mkdir(store.directory, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(store.directory, 'control-token');
  let token;
  try { token = (await readFile(tokenFile, 'utf8')).trim(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; token = randomBytes(32).toString('hex'); await writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 }); }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Blocker('control_token', 'Invalid control token file');
  const active = new Map(); let closing = false;
  const launch = id => {
    if (closing || active.has(id)) return;
    const abort = new AbortController();
    const promise = Promise.resolve().then(() => new Controller(store, id, providers).run(abort.signal)).catch(e => {
      if (e.code !== 'lease_busy') store.update(id, s => { s.status = 'blocked'; s.blocker = { code: e.code ?? 'controller_error', message: e.message }; }, 'project.blocked', { message: e.message });
    }).finally(() => active.delete(id));
    active.set(id, { abort, promise });
  };
  const schedule = () => {
    for (const state of store.list()) if (!state.paused && !['completed', 'blocked'].includes(state.status)) launch(state.id);
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (code, body) => { response.writeHead(code); response.end(JSON.stringify(body)); };
    try {
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${server.address().port}`) return send(403, { error: 'Invalid control ingress' });
      const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return send(401, { error: 'Control token required' });
      const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1') return send(404, { error: 'Unknown API version' });
      let body;
      if (request.method === 'POST') {
        let bytes = 0, chunks = [];
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 512 * 1024) throw new Blocker('request_size', 'Request body too large'); chunks.push(chunk); }
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      }
      if (parts[1] === 'projects' && parts.length === 2) {
        if (request.method === 'GET') return send(200, { version: 1, projects: store.list().map(publicState) });
        if (request.method === 'POST') {
          if (body.stateDir !== store.directory) throw new Blocker('invalid_config', 'Project stateDir must match the control server state root');
          const config = validateConfig(body), state = store.initialize(config); launch(config.id); return send(202, publicState(state));
        }
      }
      if (parts[1] === 'projects' && parts.length >= 3) {
        const id = parts[2]; identifier(id);
        if (parts.length === 3 && request.method === 'GET') return send(200, publicState(store.get(id)));
        if (parts.length === 4 && parts[3] === 'events' && request.method === 'GET') {
          const cursor = Number(url.searchParams.get('after') ?? '0');
          if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Blocker('invalid_config', 'Invalid event cursor');
          return send(200, { version: 1, events: store.events(id, cursor) });
        }
        if (parts.length === 4 && parts[3] === 'pause' && request.method === 'POST') return send(200, publicState(store.pause(id)));
        if (parts.length === 4 && parts[3] === 'resume' && request.method === 'POST') {
          const state = store.resume(id, body.retry === true); launch(id); return send(202, publicState(state));
        }
      }
      send(404, { error: 'Unknown control operation' });
    } catch (e) { send(e.code === 'not_found' ? 404 : 400, { error: e.message, code: e.code ?? 'invalid_request' }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const timer = setInterval(schedule, tickMs); schedule();
  return { server, tokenFile, url: `http://127.0.0.1:${server.address().port}`, launch, async close() {
    closing = true; clearInterval(timer);
    for (const { abort } of active.values()) abort.abort();
    await Promise.allSettled([...active.values()].map(value => value.promise));
    await new Promise(resolve => server.close(resolve));
  } };
}
