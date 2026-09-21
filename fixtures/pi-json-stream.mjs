import { randomUUID } from 'node:crypto';
// Synthetic Pi print JSON contract (not a provider integration or paid call).
export function piJsonEvents(text, profile = { provider: 'openai-codex', model: 'gpt-fixture', thinking: 'medium' }, id = randomUUID()) {
  const message = { role: 'assistant', content: [{ type: 'text', text }], api: profile.provider === 'anthropic' ? 'anthropic-messages' : profile.provider === 'openai' ? 'openai-responses' : 'openai-codex-responses', provider: profile.provider, model: profile.model, usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, totalTokens: 46, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 } }, stopReason: 'stop', timestamp: 1800000000000 };
  return [{ type: 'session', version: 3, id, timestamp: '2027-01-15T08:00:00.000Z', cwd: '/ticket/workspace' }, { type: 'agent_start' }, { type: 'turn_start' }, { type: 'message_start', message: structuredClone(message) }, { type: 'message_end', message }, { type: 'turn_end', message, toolResults: [] }, { type: 'agent_end', messages: [message] }];
}
export function piJsonStream(text, profile, id) { return piJsonEvents(text, profile, id).map(e => JSON.stringify(e)).join('\n') + '\n'; }
