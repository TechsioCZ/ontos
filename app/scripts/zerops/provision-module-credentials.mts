#!/usr/bin/env node
/**
 * The platform's module credential provisioning, run with the Shell's settings (its Better Auth secret and database).
 * Every environment runs this same program: the app host on each boot, the local demo on each start.
 *
 *   node scripts/zerops/provision-module-credentials.mts issue <operation-id> <app-id> [...]
 *     Issues each module a fresh key and writes the pass's output (keys included) to standard output, the only thing
 *     this command writes there. Whoever runs it reads that pipe into memory; it is never written to a file.
 *   node scripts/zerops/provision-module-credentials.mts retire <provider-key-id> [...]
 *     Revokes every module credential bound before the given (current) ones.
 *
 * Diagnostics go to standard error and name modules and counts only, never a key.
 */
import { CorePersistenceLive, DatabaseConfigLive } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit, Layer, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { ApiKeyServiceLive } from '../../apps/shell-super-app/api/auth/api-key-service.ts';
import { AuthConfigLive } from '../../apps/shell-super-app/api/auth/config.ts';
import { ShellCryptoLive } from '../../apps/shell-super-app/api/auth/gateway-issuer.ts';
import {
  provisionModuleCredentials,
  retireSupersededModuleCredentials,
} from '../../apps/shell-super-app/api/auth/module-credential-provisioning.ts';
import { AuthPersistenceLive } from '../../apps/shell-super-app/api/auth/runtime-infrastructure.ts';
import { ProvisioningOutputJsonSchema } from './module-credentials.mts';

const authPersistenceLive = AuthPersistenceLive.pipe(Layer.provide(AuthConfigLive));
const ProvisioningLive = Layer.mergeAll(
  ApiKeyServiceLive.pipe(Layer.provide(Layer.merge(authPersistenceLive, ShellCryptoLive))),
  authPersistenceLive,
  CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive)),
);

const issue = Command.make(
  'issue',
  {
    appIds: Argument.String('app-id').pipe(Argument.atLeast(1)),
    operationId: Argument.String('operation-id'),
  },
  ({ appIds, operationId }) =>
    Effect.gen(function* issueModuleCredentials() {
      const provisioned = yield* provisionModuleCredentials({ appIds, operationId });
      const output = yield* Schema.encodeUnknownEffect(ProvisioningOutputJsonSchema)({
        credentials: Object.fromEntries(provisioned.credentials),
        failedAppIds: provisioned.failedAppIds,
        providerKeyIds: [...provisioned.providerKeyIds],
        schemaVersion: 1,
      });
      yield* Console.error(
        provisioned.failedAppIds.length === 0
          ? `[module-credentials] issued for ${[...provisioned.credentials.keys()].join(', ')}`
          : `[module-credentials] NOT issued for ${provisioned.failedAppIds.join(', ')}`,
      );
      return yield* Console.log(output);
    }),
);

const retire = Command.make(
  'retire',
  { providerKeyIds: Argument.String('provider-key-id').pipe(Argument.atLeast(1)) },
  ({ providerKeyIds }) =>
    retireSupersededModuleCredentials(new Set(providerKeyIds)).pipe(
      Effect.flatMap((outcome) =>
        Console.error(
          `[module-credentials] retired ${String(outcome.retired)} superseded credential(s); ${String(outcome.failed)} could not be`,
        ),
      ),
    ),
);

const command = Command.make('provision-module-credentials').pipe(
  Command.withSubcommands([issue, retire]),
  Command.provide(ProvisioningLive),
);

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      // Never print a failure's details: a provider error can carry request material.
      Effect.tapError(() => Console.error('[module-credentials] provisioning failed; details withheld')),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
