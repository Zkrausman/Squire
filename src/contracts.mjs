import path from 'node:path';
import { createHash } from 'node:crypto';

export const VERSION = 1;
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const terminal = status => ['shipped', 'blocked', 'dependency_blocked'].includes(status);
export class Blocker extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'Blocker'; this.code = code; this.detail = detail; }
}
export function requireValue(condition, message) { if (!condition) throw new Blocker('invalid_config', message); }
function object(value, label) { requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); }
function keys(value, allowed, label) { object(value, label); for (const key of Object.keys(value)) requireValue(allowed.includes(key), `Unknown ${label} field: ${key}`); }
function text(value, label, max = 16000) { requireValue(typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'), `${label} must be nonempty text <= ${max} characters`); }
export function identifier(value, label = 'id') { text(value, label, 80); requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value), `${label} has invalid characters`); }
function integer(value, label, min, max) { requireValue(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be ${min}..${max}`); }
const executionFields = ['version', 'outcome', 'ownedPaths', 'contextPaths', 'invariants', 'checklist', 'stopWhen', 'maxAttempts'];
const checklistFields = ['id', 'assertion', 'steps', 'evidence'];
// Provider JSON-schema regexes do not support lookaround. Strict whitespace,
// NUL and relative-path semantics remain enforced by controller validation.
const nonblankTextSchema = maxLength => ({ type: 'string', minLength: 1, maxLength });
const pathSchema = { type: 'string', minLength: 1, maxLength: 500 };
const pathText = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !value.includes('\0') && !value.includes('\\') && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value) && !/[:*?"<>|]/.test(value) && (() => {
  const body = value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = body.split('/');
  return body.length > 0 && parts.every(part => part.length > 0 && part !== '.' && part !== '..');
})();
function relativePath(value, label) { requireValue(pathText(value), `${label} must be a safe relative path or path prefix`); }
function boundedTextArray(value, label, min, max, itemMax) {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= max, `${label} must contain ${min}..${max} items`);
  value.forEach(item => text(item, label, itemMax));
}
function validateExecution(execution) {
  keys(execution, executionFields, 'ticket execution');
  for (const field of executionFields) requireValue(Object.hasOwn(execution, field), `Missing ticket execution field: ${field}`);
  requireValue(execution.version === 1, 'Unsupported ticket execution version');
  text(execution.outcome, 'execution outcome', 2000);
  requireValue(Array.isArray(execution.ownedPaths) && execution.ownedPaths.length >= 1 && execution.ownedPaths.length <= 50, 'ownedPaths must contain 1..50 paths');
  execution.ownedPaths.forEach(p => relativePath(p, 'owned path'));
  requireValue(new Set(execution.ownedPaths).size === execution.ownedPaths.length, 'Duplicate owned path');
  requireValue(Array.isArray(execution.contextPaths) && execution.contextPaths.length <= 100, 'contextPaths must contain 0..100 paths');
  execution.contextPaths.forEach(p => relativePath(p, 'context path'));
  requireValue(new Set(execution.contextPaths).size === execution.contextPaths.length, 'Duplicate context path');
  boundedTextArray(execution.invariants, 'invariants', 1, 10, 2000);
  requireValue(Array.isArray(execution.checklist) && execution.checklist.length >= 1 && execution.checklist.length <= 10, 'checklist must contain 1..10 criteria');
  const ids = new Set();
  for (const criterion of execution.checklist) {
    keys(criterion, checklistFields, 'checklist criterion');
    for (const field of checklistFields) requireValue(Object.hasOwn(criterion, field), `Missing checklist criterion field: ${field}`);
    identifier(criterion.id, 'checklist criterion id');
    requireValue(!ids.has(criterion.id), `Duplicate checklist criterion id ${criterion.id}`); ids.add(criterion.id);
    text(criterion.assertion, 'checklist assertion', 2000);
    boundedTextArray(criterion.steps, 'checklist steps', 1, 10, 2000);
    text(criterion.evidence, 'checklist evidence', 2000);
  }
  text(execution.stopWhen, 'stopWhen', 2000);
  integer(execution.maxAttempts, 'maxAttempts', 1, 4);
  return execution;
}
// Directory prefixes end in `/`; all other ownership entries name one exact file.
export function pathIsOwned(candidatePath, ownedPaths) {
  if (!pathText(candidatePath) || candidatePath.endsWith('/') || !Array.isArray(ownedPaths)) return false;
  return ownedPaths.some(entry => pathText(entry) && (entry.endsWith('/') ? candidatePath.startsWith(entry) : candidatePath === entry));
}
export function commands(value, label, required = true) {
  requireValue(Array.isArray(value) && value.length <= 30 && (!required || value.length > 0), `${label} must contain ${required ? '1' : '0'}..30 commands`);
  const names = new Set();
  for (const command of value) {
    keys(command, ['name', 'argv', 'timeoutSeconds'], label); identifier(command.name, 'check name');
    requireValue(!names.has(command.name), `Duplicate check ${command.name}`); names.add(command.name);
    requireValue(Array.isArray(command.argv) && command.argv.length > 0 && command.argv.length <= 100, 'argv must be a nonempty array');
    for (const arg of command.argv) requireValue(typeof arg === 'string' && !arg.includes('\0') && arg.length <= 16000, 'Invalid command argument');
    text(command.argv[0], 'executable', 4096); integer(command.timeoutSeconds, 'command timeout', 1, 3600);
  }
  return value;
}
export function validateConfig(input) {
  keys(input, ['version', 'id', 'stateDir', 'goal', 'tickets', 'services', 'runtime', 'limits'], 'project');
  requireValue(input.version === VERSION, 'Unsupported project version'); identifier(input.id, 'project id');
  requireValue(typeof input.stateDir === 'string' && path.isAbsolute(input.stateDir), 'stateDir must be absolute');
  object(input.services, 'services'); requireValue(Object.keys(input.services).length > 0 && Object.keys(input.services).length <= 20, 'Provide 1..20 services');
  for (const [name, service] of Object.entries(input.services)) {
    identifier(name, 'service'); keys(service, ['source', 'branch', 'delivery', 'checks', 'setup', 'acceptance', 'protectedPaths'], `service ${name}`);
    text(service.source, 'source', 4096); text(service.branch, 'branch', 200);
    requireValue(!service.branch.startsWith('-') && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(service.branch) && !service.branch.includes('..'), 'Invalid branch');
    requireValue(path.isAbsolute(service.source) || /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(service.source), 'source must be an absolute Git path or GitHub HTTPS URL');
    const rel = path.relative(service.source, input.stateDir);
    if (path.isAbsolute(service.source)) requireValue(rel && (rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)), 'stateDir must be outside source repository');
    commands(service.checks, `${name} checks`); commands(service.setup ?? [], `${name} setup`, false); commands(service.acceptance ?? [], `${name} acceptance`, false);
    keys(service.delivery, ['kind', 'repository', 'requiredChecks', 'mergeMethod'], 'delivery');
    requireValue(['local', 'github'].includes(service.delivery.kind), 'Unsupported delivery kind');
    if (service.delivery.kind === 'local') requireValue(path.isAbsolute(service.source), 'Local delivery requires a local bare Git repository');
    if (service.delivery.kind === 'github') {
      text(service.delivery.repository, 'GitHub repository', 200);
      requireValue(/^[\w.-]+\/[\w.-]+$/.test(service.delivery.repository), 'Invalid GitHub repository');
      const remote = `https://github.com/${service.delivery.repository}`.toLowerCase();
      requireValue(service.source.replace(/\.git$/, '').toLowerCase() === remote, 'GitHub source must match delivery.repository');
      requireValue(Array.isArray(service.delivery.requiredChecks) && service.delivery.requiredChecks.length > 0 && service.delivery.requiredChecks.length <= 30, 'GitHub delivery requires explicit requiredChecks');
      for (const check of service.delivery.requiredChecks) {
        keys(check, ['name', 'appId'], 'requiredCheck'); text(check.name, 'required check name', 200); integer(check.appId, 'check appId', 1, 2147483647);
      }
      requireValue(new Set(service.delivery.requiredChecks.map(c => c.name)).size === service.delivery.requiredChecks.length, 'Duplicate requiredChecks');
      requireValue(['merge', 'squash'].includes(service.delivery.mergeMethod ?? 'squash'), 'Unsupported mergeMethod');
    }
    const protectedPaths = service.protectedPaths ?? ['.github/', 'AGENTS.md', '.codex/', '.agents/'];
    requireValue(Array.isArray(protectedPaths) && protectedPaths.length <= 50, 'Invalid protectedPaths');
    for (const p of protectedPaths) requireValue(typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.includes('..') && !p.includes('\\'), 'Invalid protected path');
    service.protectedPaths = protectedPaths;
  }
  const runtime = input.runtime ?? { kind: 'codex' };
  keys(runtime, ['kind', 'command', 'model', 'reasoning', 'authentication', 'roles'], 'runtime'); requireValue(runtime.kind === 'codex', 'Only subscription Codex is installed; other runtimes require an adapter');
  runtime.authentication ??= 'subscription'; requireValue(runtime.authentication === 'subscription', 'Initial Codex runtime requires subscription authentication');
  if (runtime.command !== undefined) commands([{ name: 'runtime', argv: runtime.command, timeoutSeconds: 60 }], 'runtime');
  if (runtime.model !== undefined) text(runtime.model, 'model', 100);
  if (runtime.reasoning !== undefined) requireValue(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(runtime.reasoning), 'Invalid reasoning');
  if (runtime.roles !== undefined) {
    keys(runtime.roles, ['plan', 'implement', 'review'], 'runtime roles');
    for (const role of Object.values(runtime.roles)) {
      keys(role, ['model', 'reasoning'], 'runtime role');
      if (role.model !== undefined) text(role.model, 'role model', 100);
      if (role.reasoning !== undefined) requireValue(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(role.reasoning), 'Invalid role reasoning');
    }
  }
  const limits = { maxParallel: 2, maxRepairs: 2, maxRebases: 3, maxAgentCalls: 100, agentTimeoutSeconds: 1800, ciTimeoutSeconds: 1800, rateLimitBackoffSeconds: 600, ...input.limits };
  keys(limits, ['maxParallel', 'maxRepairs', 'maxRebases', 'maxAgentCalls', 'agentTimeoutSeconds', 'ciTimeoutSeconds', 'rateLimitBackoffSeconds'], 'limits');
  for (const [key, max] of Object.entries({ maxParallel: 8, maxRepairs: 10, maxRebases: 10, maxAgentCalls: 1000, agentTimeoutSeconds: 7200, ciTimeoutSeconds: 7200, rateLimitBackoffSeconds: 86400 })) integer(limits[key], key, key.includes('Repairs') || key.includes('Rebases') ? 0 : 1, max);
  input.runtime = runtime; input.limits = limits;
  if (input.goal !== undefined) text(input.goal, 'goal');
  requireValue(input.goal || input.tickets?.length, 'Provide a goal or tickets');
  if (input.tickets !== undefined) validateTickets(input.tickets, input.services);
  return input;
}
export function validateTickets(tickets, services) {
  requireValue(Array.isArray(tickets) && tickets.length > 0 && tickets.length <= 100, 'Provide 1..100 tickets');
  const ids = new Set();
  for (const ticket of tickets) {
    keys(ticket, ['id', 'service', 'title', 'description', 'acceptance', 'dependsOn', 'execution'], 'ticket'); identifier(ticket.id, 'ticket id');
    requireValue(!ids.has(ticket.id), `Duplicate ticket ${ticket.id}`); ids.add(ticket.id);
    requireValue(Object.hasOwn(services, ticket.service), `Unknown service ${ticket.service}`);
    text(ticket.title, 'title', 200); text(ticket.description, 'description');
    requireValue(Array.isArray(ticket.acceptance) && ticket.acceptance.length > 0 && ticket.acceptance.length <= 30, 'Ticket acceptance criteria required');
    ticket.acceptance.forEach(a => text(a, 'acceptance', 2000));
    requireValue(Array.isArray(ticket.dependsOn) && ticket.dependsOn.length <= 100, 'dependsOn required');
    if (ticket.execution !== undefined) validateExecution(ticket.execution);
  }
  const visited = new Set(), active = new Set(), byId = new Map(tickets.map(t => [t.id, t]));
  function visit(id) {
    requireValue(ids.has(id), `Unknown dependency ${id}`); requireValue(!active.has(id), `Dependency cycle at ${id}`);
    if (visited.has(id)) return; active.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    active.delete(id); visited.add(id);
  }
  ids.forEach(visit); return tickets;
}
export const reviewSchema = {
  type: 'object', additionalProperties: false, required: ['headSha', 'verdict', 'summary', 'findings', 'checklist'],
  properties: { headSha: { type: 'string' }, verdict: { type: 'string', enum: ['pass', 'fail'] }, summary: { type: 'string' }, findings: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['priority', 'file', 'line', 'message'], properties: { priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, file: { type: 'string' }, line: { type: 'integer' }, message: { type: 'string' } }
  } }, checklist: { type: 'array', maxItems: 10, items: {
    type: 'object', additionalProperties: false, required: ['id', 'verdict', 'evidence'], properties: {
      id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' }, verdict: { type: 'string', enum: ['pass', 'fail'] }, evidence: { type: 'string', maxLength: 4000 }
    }
  } } }
};
export const planSchema = {
  type: 'object', additionalProperties: false, required: ['tickets'], properties: { tickets: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'service', 'title', 'description', 'acceptance', 'dependsOn', 'execution'], properties: {
      id: { type: 'string' }, service: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, dependsOn: { type: 'array', items: { type: 'string' } },
      execution: { type: 'object', additionalProperties: false, required: executionFields, properties: {
        version: { type: 'integer', const: 1 }, outcome: nonblankTextSchema(2000),
        ownedPaths: { type: 'array', minItems: 1, maxItems: 50, items: pathSchema },
        contextPaths: { type: 'array', maxItems: 100, items: pathSchema },
        invariants: { type: 'array', minItems: 1, maxItems: 10, items: nonblankTextSchema(2000) },
        checklist: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: checklistFields, properties: {
          id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' }, assertion: nonblankTextSchema(2000),
          steps: { type: 'array', minItems: 1, maxItems: 10, items: nonblankTextSchema(2000) }, evidence: nonblankTextSchema(2000)
        } } },
        stopWhen: nonblankTextSchema(2000), maxAttempts: { type: 'integer', minimum: 1, maximum: 4 }
      } }
    }
  } } }
};
export function validateReview(value, headSha, execution) {
  requireValue(value && value.headSha === headSha && ['pass', 'fail'].includes(value.verdict) && typeof value.summary === 'string' && Array.isArray(value.findings) && value.findings.length <= 100, 'Invalid or wrong-head review');
  for (const f of value.findings) requireValue(['P0', 'P1', 'P2', 'P3'].includes(f.priority) && typeof f.file === 'string' && Number.isSafeInteger(f.line) && f.line >= 0 && typeof f.message === 'string' && f.message.length > 0 && f.message.length < 16000, 'Invalid review finding');
  if (value.checklist !== undefined) {
    requireValue(Array.isArray(value.checklist) && value.checklist.length <= 10, 'Invalid review checklist');
    const ids = new Set(), expectedIds = execution ? new Set(execution.checklist.map(item => item.id)) : undefined;
    for (const item of value.checklist) {
      keys(item, ['id', 'verdict', 'evidence'], 'review checklist item');
      requireValue(Object.hasOwn(item, 'id') && Object.hasOwn(item, 'verdict') && Object.hasOwn(item, 'evidence'), 'Incomplete review checklist item');
      identifier(item.id, 'review checklist id');
      requireValue(!ids.has(item.id), `Duplicate review checklist id ${item.id}`); ids.add(item.id);
      requireValue(item.verdict === 'pass' || item.verdict === 'fail', 'Invalid review checklist verdict');
      requireValue(typeof item.evidence === 'string' && item.evidence.length <= 4000 && !item.evidence.includes('\0'), 'Invalid review checklist evidence');
      requireValue(item.verdict !== 'pass' || item.evidence.trim().length > 0, 'Passing checklist item requires evidence');
      if (expectedIds) requireValue(expectedIds.has(item.id), `Unknown review checklist id ${item.id}`);
    }
  }
  if (value.verdict === 'pass' && execution) {
    requireValue(Array.isArray(value.checklist) && value.checklist.length === execution.checklist.length, 'Passing review must report every execution checklist item');
    const items = new Map(value.checklist.map(item => [item.id, item]));
    requireValue(execution.checklist.every(criterion => items.has(criterion.id)), 'Passing review is missing an execution checklist item');
    requireValue(value.checklist.every(item => item.verdict === 'pass' && item.evidence.trim().length > 0), 'Passing review requires passing checklist evidence');
  }
  requireValue(value.verdict !== 'pass' || value.findings.length === 0, 'Passing review has unresolved findings'); return value;
}
