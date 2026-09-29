import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Blocker, digest, VERSION } from './contracts.mjs';

// One transactional state envelope plus separate cursor-addressed outbox events.
// Synchronous transactions serialize mutations from concurrent repository lanes.
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.directory = directory;
    this.db = new DatabaseSync(path.join(directory, 'squire.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, config_hash TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }
  initialize(config) {
    const previous = this.db.prepare('SELECT config_hash FROM project WHERE id=?').get(config.id);
    const hash = digest(config);
    if (previous && previous.config_hash !== hash) throw new Blocker('config_changed', 'Project policy changed. Use a new project ID/state directory; an active queue cannot silently change authority.');
    if (previous) return this.get(config.id);
    const state = { version: VERSION, id: config.id, config, status: 'queued', paused: false, createdAt: Date.now(), agentCalls: 0, planningAttempt: 0,
      tickets: (config.tickets ?? []).map(spec => ({ spec, status: 'queued', attempts: 0, repairs: 0, rebases: 0 })), acceptance: {}, blocker: null };
    this.transaction(() => { this.db.prepare('INSERT INTO project VALUES (?,?,?)').run(config.id, hash, JSON.stringify(state)); this.emit(config.id, 'project.created', { status: 'queued' }); });
    return state;
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(id) { const row = this.db.prepare('SELECT state FROM project WHERE id=?').get(id); if (!row) throw new Blocker('not_found', `Project ${id} not found`); return JSON.parse(row.state); }
  list() { return this.db.prepare('SELECT id FROM project').all().map(r => this.get(r.id)); }
  update(id, fn, type, detail = {}) {
    return this.transaction(() => {
      const state = this.get(id); fn(state); state.updatedAt = Date.now();
      this.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(state), id);
      if (type) this.emit(id, type, detail); return state;
    });
  }
  emit(id, type, detail) { this.db.prepare('INSERT INTO events(project,data) VALUES (?,?)').run(id, JSON.stringify({ version: VERSION, project: id, type, at: Date.now(), ...detail })); }
  events(id, cursor = 0, limit = 200) { return this.db.prepare('SELECT cursor,data FROM events WHERE project=? AND cursor>? ORDER BY cursor LIMIT ?').all(id, cursor, limit).map(r => ({ cursor: Number(r.cursor), ...JSON.parse(r.data) })); }
  lease(resource) {
    const owner = randomUUID();
    this.transaction(() => {
      const held = this.db.prepare('SELECT * FROM leases WHERE resource=?').get(resource);
      if (held) {
        let alive = true; try { process.kill(held.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (alive) throw new Blocker('lease_busy', `Another live controller owns ${resource}`, { pid: held.pid });
        this.db.prepare('DELETE FROM leases WHERE resource=?').run(resource);
      }
      this.db.prepare('INSERT INTO leases VALUES (?,?,?)').run(resource, owner, process.pid);
    });
    return () => { this.db.prepare('DELETE FROM leases WHERE resource=? AND owner=?').run(resource, owner); };
  }
  pause(id) { return this.update(id, s => { s.paused = true; }, 'project.paused'); }
  resume(id, retry = false) {
    return this.update(id, s => {
      s.paused = false;
      if (retry) {
        for (const t of s.tickets) {
          if (['blocked', 'dependency_blocked', 'waiting_capacity'].includes(t.status)) {
            if (t.blocker?.code === 'postmerge_failed') t.status = 'postmerge';
            else if (t.mergeSha) t.status = 'postmerge';
            else if (t.headSha) t.status = 'verifying';
            else t.status = 'queued';
            t.retryAt = 0; delete t.blocker;
          }
        }
        for (const a of Object.values(s.acceptance)) if (a.status === 'failed') a.status = 'queued';
        s.blocker = null; s.status = 'queued';
      }
    }, 'project.resumed', { retry });
  }
}
