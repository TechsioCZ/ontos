#!/usr/bin/env node
/**
 * RETIRED by authorization v2 (ADR-0030). The helper pseudonymized the demo company by copying legacy subject grants.
 */
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit } from 'effect';

import { refuseRetiredDemoAuthorization } from './retired-authorization.mts';

export const retiredDemoGrant = Effect.fail(
  refuseRetiredDemoAuthorization(
    'retired_pseudonymize_akros_demo',
    'The pseudonymization copied exact legacy subject grants to the new identities; v2 has no tuple copy, and a live relationship deletion needs its own approved retirement inventory.',
  ),
);

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    retiredDemoGrant.pipe(
      Effect.tapError((problem) => Console.error(`${problem.code}: ${problem.reason}`)),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
