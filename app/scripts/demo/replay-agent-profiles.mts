#!/usr/bin/env node
/** Reviewed nine-row replay. --mode apply is an explicit operator cutover step, never bootstrap side work. */
import { NodeServices } from '@effect/platform-node';
import { Console, Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { readReviewedAgentProfiles, reviewedProfileInputs, runAgentProfileSetup } from './agent-profile-setup.mts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';

const command = Command.make(
  'replay-agent-profiles',
  {
    file: Flag.String('file').pipe(
      Flag.withDefault('/Volumes/DevWork/agent-scratch/people-model/reviewed-nine-agent-profiles.json'),
    ),
    mode: Flag.Literals('mode', ['dry-run', 'apply', 'verify']).pipe(Flag.withDefault('dry-run')),
    sha256: Flag.String('sha256'),
  },
  ({ file, mode, sha256 }) =>
    Effect.gen(function* reviewedNativeReplay() {
      // Validate exact approved bytes before reading principals or signing a session.
      const document = yield* readReviewedAgentProfiles(file, sha256);
      const inputs = yield* reviewedProfileInputs(document);
      const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
        session.close.pipe(Effect.ignore),
      );
      yield* Console.log(yield* runAgentProfileSetup(operator.principal, inputs, mode, sha256));
    }).pipe(
      Effect.scoped,
      // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- Executable Command composition root; --help must not open database/service resources.
      Effect.provide(AgentProfileOperatorLive),
    ),
);

if (import.meta.main) {
  await Effect.runPromise(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
