// Lexical look-alikes that must never report: local runners, shadowed bindings, non-Effect
// namespaces, `.run` on a domain object, and re-exports that carry no runner.
import { runEffectRequest } from '../contacts-api.ts';

import { gateway } from '../gateway.ts';
import { workerPool } from '../worker-pool.ts';

const runEffectView = (value: string) => value.toUpperCase();

export const localView = runEffectView('local');

export const describeRunner = (runEffectRequest: string) => runEffectRequest.trim();

export const shadowedInBlock = () => {
  const scoped = (runEffectRequest: number) => runEffectRequest + 1;
  return scoped(1);
};

export const runGateway = () => gateway.run({ entrypoint: 'contacts' });

export const runOnPool = () => workerPool.runPromise('job');

export { gateway } from '../gateway.ts';
export * from '../contacts-api.ts';
export type { ContactsClient } from '../contacts-api.ts';
