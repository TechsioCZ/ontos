#!/usr/bin/env node
/**
 * Exposes or checks the credential store claim of built units (`hosted-credential-claim.mts`).
 *
 *   node scripts/zerops/hosted-credential-claim-cli.mts expose <unit directory> [...]
 *   node scripts/zerops/hosted-credential-claim-cli.mts check <unit directory> [...]
 */
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { checkUnitClaims, exposeUnitClaims, HostedCredentialClaimError } from './hosted-credential-claim.mts';

const units = Argument.String('unit-directory').pipe(Argument.atLeast(1));
const command = Command.make('hosted-credential-claim').pipe(
  Command.withSubcommands([
    Command.make('expose', { units }, ({ units: directories }) =>
      exposeUnitClaims(directories.map((directory) => path.resolve(directory))).pipe(
        Effect.andThen(Console.log(`exposed the credential claim of ${directories.join(', ')}`)),
        Effect.tapError((problem) =>
          Console.error(
            `[hosted-credential-claim] ${Schema.is(HostedCredentialClaimError)(problem) ? problem.reason : 'a unit could not be read'}`,
          ),
        ),
      ),
    ),
    Command.make('check', { units }, ({ units: directories }) =>
      checkUnitClaims(directories.map((directory) => path.resolve(directory))).pipe(
        Effect.tapError((problem) => Console.error(`[hosted-credential-claim] ${problem.reason}`)),
      ),
    ),
  ]),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
  );
}
