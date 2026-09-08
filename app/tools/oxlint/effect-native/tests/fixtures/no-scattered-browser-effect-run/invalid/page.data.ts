// expect-count: 3
import { Effect } from 'effect';
import { resolveModuleTarget, runEffectRequest } from '../contacts-api.ts';

export const loader = ({ moduleId }: { readonly moduleId: string }) =>
  runEffectRequest(resolveModuleTarget(moduleId));

export const action = async ({ moduleId }: { readonly moduleId: string }) =>
  runEffectRequest(resolveModuleTarget(moduleId));

export const prefetchShell = () => Effect.runPromise(resolveModuleTarget('shell'));
