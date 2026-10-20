import {types} from 'node:util';
import {closed, own, fail, text} from './job-spec.mjs';
import {captureUnitBinding} from './manager-custody.mjs';

const PATH = '/org/freedesktop/systemd1', MANAGER = 'org.freedesktop.systemd1.Manager';
const uint32 = n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;
const serial = n => uint32(n) && n !== 0;
function owner(value) {
  // Deliberate supported profile, not every possible D-Bus name spelling.
  if (typeof value !== 'string' || !/^:[0-9]+\.[0-9]+$/.test(value)) fail('manager_owner');
  return value;
}
function tuple(value, length, field) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length !== length || Reflect.ownKeys(value).length !== length + 1) fail(field);
  const out = [];
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !own(d, 'value')) fail(field);
    out.push(d.value);
  }
  return out;
}
function jobId(path) {
  if (typeof path !== 'string') fail('job_path');
  const match = /^\/org\/freedesktop\/systemd1\/job\/(0|[1-9][0-9]*)$/.exec(path);
  if (!match || !uint32(Number(match[1]))) fail('job_path');
  return Number(match[1]);
}

// Pure message descriptions only. There is no sender, bus client or native default.
export function encodeStopUnitRequest(input) {
  closed(input, ['binding', 'manager_owner', 'job_mode'], [], 'stop_request');
  const binding = captureUnitBinding(input.binding), managerOwner = owner(input.manager_owner);
  if (input.job_mode !== 'fail') fail('unsupported_stop_job_mode');
  return Object.freeze({binding, manager_owner: managerOwner,
    message: Object.freeze({destination: managerOwner, path: PATH, interface: MANAGER, member: 'StopUnit',
      signature: 'ss', body: Object.freeze([binding.unit_name, input.job_mode])})});
}

export function captureStopJobReply(expected, reply) {
  closed(expected, ['binding', 'manager_owner', 'request_serial'], [], 'stop_reply_context');
  const binding = captureUnitBinding(expected.binding), managerOwner = owner(expected.manager_owner);
  if (!serial(expected.request_serial)) fail('request_serial');
  closed(reply, ['sender', 'reply_serial', 'signature', 'body'], [], 'stop_method_reply');
  if (reply.sender !== managerOwner || reply.reply_serial !== expected.request_serial || reply.signature !== 'o') fail('stop_method_reply');
  const [path] = tuple(reply.body, 1, 'stop_method_reply.body'); const id = jobId(path);
  // This queued-job receipt deliberately has no job_acknowledged or empty claim.
  return Object.freeze({binding, manager_owner: managerOwner, request_serial: expected.request_serial, job_path: path, job_id: id});
}

export function decodeStopJobRemoved(receipt, event) {
  closed(receipt, ['binding', 'manager_owner', 'request_serial', 'job_path', 'job_id'], [], 'stop_job_receipt');
  const binding = captureUnitBinding(receipt.binding), managerOwner = owner(receipt.manager_owner);
  if (!serial(receipt.request_serial) || !uint32(receipt.job_id) || jobId(receipt.job_path) !== receipt.job_id) fail('stop_job_receipt');
  closed(event, ['sender', 'path', 'interface', 'member', 'signature', 'body'], [], 'manager_signal');
  if (!text(event.sender) || !text(event.path) || !text(event.interface) || !text(event.member)) fail('manager_signal');
  if (event.sender !== managerOwner || event.path !== PATH || event.interface !== MANAGER || event.member !== 'JobRemoved') {
    return Object.freeze({status: 'UNRELATED'});
  }
  if (event.signature !== 'uoss') fail('stop_job_signal');
  const [id, path, unit, result] = tuple(event.body, 4, 'stop_job_signal.body');
  if (!uint32(id) || jobId(path) !== id || !text(unit) || !text(result)) fail('stop_job_signal');
  if (id !== receipt.job_id || path !== receipt.job_path || unit !== binding.unit_name) return Object.freeze({status: 'UNRELATED'});
  if (result !== 'done') return Object.freeze({status: 'UNKNOWN'});
  // InvocationID is expected identity carried under qualified exclusive authority,
  // not a field attested by JobRemoved and never an atomic compare-and-swap.
  return Object.freeze({status: 'ACKNOWLEDGED', response: Object.freeze({binding, job_acknowledged: true})});
}
