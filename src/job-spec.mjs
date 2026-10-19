// Pure contract validation. No filesystem, process, provider, clock or network access.
import {types} from 'node:util';
export class ContractError extends TypeError {
  constructor(code, field) {
    super(`${code}: ${field}`);
    this.name = 'ContractError';
    this.code = code;
    this.field = field;
  }
}

export const own = (value, key) => Object.hasOwn(value, key);
export const fail = (field, code = 'invalid_contract') => { throw new ContractError(code, field); };
export const text = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
export const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
export function object(value, field) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(field);
}
export function closed(value, required, optional, field) {
  object(value, field);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) fail(field);
  if (required.some(key => !own(value, key))) fail(field);
  if (keys.some(key => !own(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail(field);
}
export function artifactPath(value) {
  return text(value) && !/[\\\r\n]/.test(value) && !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function artifactPaths(value) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('required_artifacts');
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  const keys = Reflect.ownKeys(value);
  if (!Number.isSafeInteger(length) || length <= 0 || keys.length !== length + 1 ||
      keys.some(key => typeof key !== 'string' || key !== 'length' &&
        (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) fail('required_artifacts');
  const captured = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !own(descriptor, 'value') || !artifactPath(descriptor.value)) fail('required_artifacts');
    captured.push(descriptor.value);
  }
  if (new Set(captured).size !== length) fail('required_artifacts');
  return Object.freeze(captured);
}
const required = ['job_id', 'task_scope', 'provider_id', 'requested_model',
  'max_wall_clock_sec', 'max_steps', 'required_artifacts'];
const uuid4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function validateJobSpec(input) {
  closed(input, required, ['fenced_history_ref'], 'JobSpec');
  if (typeof input.job_id !== 'string' || !uuid4.test(input.job_id)) fail('job_id');
  if (!text(input.task_scope)) fail('task_scope');
  if (!['agy_gemini', 'native_codex'].includes(input.provider_id)) fail('provider_id');
  if (!text(input.requested_model)) fail('requested_model');
  for (const field of ['max_wall_clock_sec', 'max_steps']) {
    if (!Number.isSafeInteger(input[field]) || input[field] <= 0) fail(field);
  }
  const artifacts = artifactPaths(input.required_artifacts);
  if (own(input, 'fenced_history_ref') && !text(input.fenced_history_ref)) fail('fenced_history_ref');
  const result = Object.fromEntries(required.map(key => [key, input[key]]));
  result.required_artifacts = artifacts;
  if (own(input, 'fenced_history_ref')) result.fenced_history_ref = input.fenced_history_ref;
  return Object.freeze(result);
}
