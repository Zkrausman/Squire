// Private, bounded App Server notification adapter. Its normalized CLI-shaped
// bytes are adapter output, never evidence that `codex exec --json` emitted them.
import {types} from 'node:util';
import {closed, nonnegative} from './job-spec.mjs';
import {iterateLargeProjectCodexJsonlFrames} from './provider-metadata.mjs';

const LIMIT = 1048576;
const FRAME_LIMIT = 4096;
const encoder = new TextEncoder();
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const byteBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
const fixed = (status, reason, projected_bytes = null) => Object.freeze({status, reason, projected_bytes});
const unknown = reason => fixed('UNKNOWN', reason);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const finiteTime = value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
const plainArray = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
function equalItem(left, right) {
  return left.id === right.id && left.type === right.type && left.phase === right.phase && left.text === right.text &&
    left.memoryCitation === right.memoryCitation && left.delivery === right.delivery && left.questions === right.questions;
}
function itemShape(item) {
  closed(item, ['type', 'id', 'text', 'phase', 'memoryCitation', 'delivery', 'questions'], [], 'item');
  if (item.type !== 'agentMessage' || !validId(item.id) || typeof item.text !== 'string' ||
      !['commentary', 'final_answer'].includes(item.phase) || item.memoryCitation !== null ||
      item.delivery !== null || item.questions !== null) throw 0;
  return item;
}
function turnError(value) {
  if (value === null) return;
  closed(value, ['message', 'codexErrorInfo', 'additionalDetails', 'misalignment'], [], 'turn_error');
  if (typeof value.message !== 'string' || value.additionalDetails !== null && typeof value.additionalDetails !== 'string') throw 0;
  const info = value.codexErrorInfo;
  const scalarInfo = ['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded',
    'flexUnavailable', 'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials',
    'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other'];
  if (info !== null && !scalarInfo.includes(info)) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw 0;
    const keys = Reflect.ownKeys(info);
    if (keys.length !== 1 || typeof keys[0] !== 'string') throw 0;
    const key = keys[0];
    const payload = info[key];
    if (['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(key)) {
      closed(info, [key], [], 'error_info');
      closed(payload, ['httpStatusCode'], [], 'error_info_payload');
      if (payload.httpStatusCode !== null && !Number.isSafeInteger(payload.httpStatusCode)) throw 0;
    } else if (key === 'activeTurnNotSteerable') {
      closed(info, [key], [], 'error_info');
      closed(payload, ['turnKind'], [], 'error_info_payload');
      if (!['review', 'compact'].includes(payload.turnKind)) throw 0;
    } else throw 0;
  }
  const misalignment = value.misalignment;
  if (misalignment !== null) {
    closed(misalignment, ['errorType', 'detailedExplanation', 'steer'], [], 'misalignment');
    if (misalignment.errorType !== null && typeof misalignment.errorType !== 'string' ||
        misalignment.detailedExplanation !== null && typeof misalignment.detailedExplanation !== 'string') throw 0;
    if (misalignment.steer !== null) {
      closed(misalignment.steer, ['message'], [], 'misalignment_steer');
      if (typeof misalignment.steer.message !== 'string') throw 0;
    }
  }
}
function turnShape(value) {
  closed(value, ['id', 'items', 'itemsView', 'status', 'error', 'startedAt', 'completedAt', 'durationMs'], [], 'turn');
  if (!validId(value.id) || !plainArray(value.items) || !['full', 'summary', 'notLoaded'].includes(value.itemsView) ||
      !['inProgress', 'completed', 'failed', 'interrupted'].includes(value.status) ||
      !finiteTime(value.startedAt) || !finiteTime(value.completedAt) || !finiteTime(value.durationMs)) throw 0;
  turnError(value.error);
  const items = value.items.map(itemShape);
  return {...value, items};
}
function notification(value) {
  closed(value, ['method', 'params'], ['emittedAtMs'], 'notification');
  if (typeof value.method !== 'string' || Object.hasOwn(value, 'emittedAtMs') && !nonnegative(value.emittedAtMs)) throw 0;
  return value;
}
function usageShape(value) {
  closed(value, ['total', 'last', 'modelContextWindow'], [], 'token_usage');
  const breakdown = usage => {
    closed(usage, ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'], [], 'token_breakdown');
    if (Object.values(usage).some(count => !nonnegative(count))) throw 0;
  };
  breakdown(value.total); breakdown(value.last);
  if (value.modelContextWindow !== null && !nonnegative(value.modelContextWindow)) throw 0;
}

function project(textValue) {
  const events = [
    {type: 'turn.started'},
    {type: 'item.completed', item: {type: 'agent_message', text: textValue}},
    {type: 'turn.completed'}
  ];
  const output = encoder.encode(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  if (output.byteLength > LIMIT) { output.fill(0); return null; }
  return output;
}

export function mapAppServerTurn(input) {
  let raw = null;
  try {
    closed(input, ['raw_payload_bytes', 'thread_id', 'turn_id', 'local_cancelled'], [], 'mapping_input');
    if (types.isProxy(input.raw_payload_bytes) || !types.isUint8Array(input.raw_payload_bytes) ||
        types.isSharedArrayBuffer(byteBuffer.call(input.raw_payload_bytes)) ||
        !validId(input.thread_id) || !validId(input.turn_id) || typeof input.local_cancelled !== 'boolean') throw 0;
    const size = byteLength.call(input.raw_payload_bytes);
    if (size > LIMIT) return unknown('ENVELOPE_REJECTED');
    raw = new Uint8Array(size);
    Uint8Array.prototype.set.call(raw, input.raw_payload_bytes);
    if (input.local_cancelled) return fixed('CANCELED', 'LOCAL_CANCELLATION');

    const starts = new Map();
    const completed = [];
    const completedById = new Map();
    let started = false, terminal = false, serverError = false, terminalResult = null;
    let finalText = null, finalCount = 0, frameCount = 0;
    const bind = (threadId, turnId) => {
      if (threadId !== input.thread_id || turnId !== input.turn_id) throw 0;
    };
    for (const rawEvent of iterateLargeProjectCodexJsonlFrames(raw)) {
      if (++frameCount > FRAME_LIMIT || terminal) throw 0;
      const event = notification(rawEvent);
      const p = event.params;
      switch (event.method) {
        case 'turn/started': {
          closed(p, ['threadId', 'turn'], [], 'turn_started');
          if (p.threadId !== input.thread_id || started) throw 0;
          const turn = turnShape(p.turn);
          if (turn.id !== input.turn_id || turn.status !== 'inProgress' || turn.error !== null ||
              turn.items.length !== 0 || turn.itemsView !== 'full') throw 0;
          started = true;
          break;
        }
        case 'item/started': {
          closed(p, ['item', 'threadId', 'turnId', 'startedAtMs'], [], 'item_started');
          bind(p.threadId, p.turnId);
          if (!started || !nonnegative(p.startedAtMs)) throw 0;
          const item = itemShape(p.item);
          if (starts.has(item.id) || completedById.has(item.id) || finalCount > 0) throw 0;
          starts.set(item.id, {id: item.id, phase: item.phase, text: item.text});
          break;
        }
        case 'item/agentMessage/delta': {
          closed(p, ['threadId', 'turnId', 'itemId', 'delta'], [], 'message_delta');
          bind(p.threadId, p.turnId);
          if (!started || !validId(p.itemId) || typeof p.delta !== 'string' || !starts.has(p.itemId) || completedById.has(p.itemId) || finalCount > 0) throw 0;
          break;
        }
        case 'item/completed': {
          closed(p, ['item', 'threadId', 'turnId', 'completedAtMs'], [], 'item_completed');
          bind(p.threadId, p.turnId);
          if (!started || !nonnegative(p.completedAtMs)) throw 0;
          const item = itemShape(p.item);
          const before = starts.get(item.id);
          if (!before || completedById.has(item.id)) throw 0;
          // Only text and phase can vary across an item lifecycle.
          if (before.id !== item.id) throw 0;
          starts.delete(item.id);
          const witness = {id: item.id, type: item.type, text: item.text, phase: item.phase,
            memoryCitation: item.memoryCitation, delivery: item.delivery, questions: item.questions};
          completed.push(witness); completedById.set(item.id, witness);
          if (item.phase === 'final_answer') { finalCount++; finalText = item.text; }
          else if (finalCount > 0) throw 0;
          break;
        }
        case 'thread/tokenUsage/updated': {
          closed(p, ['threadId', 'turnId', 'tokenUsage'], [], 'usage_updated');
          bind(p.threadId, p.turnId);
          if (!started) throw 0;
          usageShape(p.tokenUsage);
          break;
        }
        case 'error': {
          closed(p, ['error', 'willRetry', 'threadId', 'turnId'], [], 'server_error');
          bind(p.threadId, p.turnId);
          if (typeof p.willRetry !== 'boolean' || p.error === null) throw 0;
          turnError(p.error);
          serverError = true;
          break;
        }
        case 'turn/completed': {
          closed(p, ['threadId', 'turn'], [], 'turn_completed');
          if (p.threadId !== input.thread_id) throw 0;
          const turn = turnShape(p.turn);
          if (turn.id !== input.turn_id || !started) throw 0;
          terminal = true;
          if (turn.status === 'failed') { terminalResult = fixed('FAILED', 'TURN_FAILED'); break; }
          if (turn.status === 'interrupted') { terminalResult = fixed('INTERRUPTED', 'TURN_INTERRUPTED'); break; }
          if (turn.status !== 'completed' || turn.error !== null || starts.size !== 0 ||
              turn.itemsView !== 'full') throw 0;
          if (turn.items.length !== completed.length || turn.items.some((item, index) => !equalItem(item, completed[index]))) throw 0;
          if (serverError) { terminalResult = fixed('FAILED', 'SERVER_ERROR'); break; }
          if (finalCount !== 1 || typeof finalText !== 'string') throw 0;
          const projected_bytes = project(finalText);
          if (projected_bytes === null) throw 0;
          terminalResult = fixed('COMPLETED', 'NONE', projected_bytes);
          break;
        }
        default: throw 0;
      }
    }
    return terminal ? terminalResult ?? unknown('ENVELOPE_REJECTED') : unknown('MISSING_TERMINAL');
  } catch {
    return unknown('ENVELOPE_REJECTED');
  } finally {
    raw?.fill(0);
  }
}
