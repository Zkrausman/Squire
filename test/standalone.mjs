// Existing adapter/process unit fixtures deliberately run outside a controller.
// This explicit test capability does not bypass Controller.producer scopes.
import test from 'node:test';
import { withStandaloneProcesses } from '../src/producer-context.mjs';
export default function standaloneTest(...args) {
  const callback = args.pop();
  return test(...args, t => withStandaloneProcesses(() => callback(t)));
}
