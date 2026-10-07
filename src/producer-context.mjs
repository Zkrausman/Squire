import { AsyncLocalStorage } from 'node:async_hooks';

// Context is an explicit capability, never selected through environment variables.
const context = new AsyncLocalStorage();
export const producerContext = () => context.getStore();
export const withProducer = (value, fn) => context.run({ ...value, lifecycle: value.lifecycle ?? {} }, fn);
export const withProducerJob = (jobId, fn) => context.run({ ...context.getStore(), jobId }, fn);
// Only standalone helpers/tests opt in. Controller producers always replace it.
export const withStandaloneProcesses = fn => context.run({ standalone: true }, fn);
