#!/usr/bin/env node
/** Explicit audited setup input, never a runtime fallback or an API-key ownership registry. */
import { createHash } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { Console, Effect } from 'effect';
import { Command, Flag } from 'effect/cli';

import { demoAgentProfileSetup } from '../../apps/shell-super-app/api/auth/demo-seed/agent-profiles.ts';
import { explicitProfileInputs, runAgentProfileSetup } from './agent-profile-setup.mts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';

const command = Command.make(
  'ai-profiles',
  {
    mode: Flag.Literals('mode', ['dry-run', 'apply', 'verify']).pipe(Flag.withDefault('dry-run')),
  },
  ({ mode }) =>
    Effect.gen(function* explicitNativeSetup() {
      const inputs = yield* explicitProfileInputs(demoAgentProfileSetup);
      const sourceFingerprint = createHash('sha256').update('explicit-demo-agent-profile-input-v1').digest('hex');
      const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
        session.close.pipe(Effect.ignore),
      );
      yield* Console.log(yield* runAgentProfileSetup(operator.principal, inputs, mode, sourceFingerprint));
    }).pipe(
      Effect.scoped,
      // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- Executable Command composition root; --help must not open database/service resources.
      Effect.provide(AgentProfileOperatorLive),
    ),
);

if (import.meta.main) {
  await Effect.runPromise(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
