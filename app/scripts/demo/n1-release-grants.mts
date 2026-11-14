#!/usr/bin/env node
/**
 * Release step for the N1 stage grants. app-host runs it after every release, beside the demo service grants.
 *
 * The retired step TOUCHed the reviewed N1 desired set into the engine. Authorization v2 retired the legacy N1 plan
 * (`ADR-0030`): the engine schema is fixed, every role policy is intent in PostgreSQL that one Core writer projects,
 * and a release step never writes or revokes a relationship. The reviewed access file is still validated here, so a
 * malformed review is refused by name; the policy itself is refused with the canonical remediation.
 */
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Schema } from 'effect';
import { Command } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { N1StageGrantError, decodeN1Access, refuseRetiredN1Grants } from './n1-stage-grants.mts';

export const N1_RELEASE_ACCESS_FILE = 'scripts/demo/n1-stage-access.json';

const fail = (reason: string) => new N1StageGrantError({ reason });

export const releaseN1Grants = Effect.gen(function* releaseN1GrantsProgram() {
  yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  const fs = yield* FileSystem.FileSystem;
  const access = yield* fs.readFileString(N1_RELEASE_ACCESS_FILE).pipe(
    Effect.mapError(() => fail('The committed N1 access file could not be read')),
    Effect.flatMap(decodeN1Access),
  );
  yield* Console.log({ accounts: access.accounts.length, tenantId: access.tenantId });
  return yield* refuseRetiredN1Grants('apply');
});

/** The command's process root: the platform services the file read and the log need. */
const ReleaseLayer = Layer.mergeAll(NodeServices.layer, ProcessDatabasePoolsLive, FetchHttpClient.layer);

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(
      Command.make('n1-release-grants', {}, () =>
        releaseN1Grants.pipe(
          Effect.tapError((failure) =>
            Console.error(
              Schema.is(N1StageGrantError)(failure)
                ? failure.reason
                : `N1 release grants stopped (${failure._tag}); credentials withheld`,
            ),
          ),
        ),
      ),
      { version: '1.0.0' },
    ).pipe(Effect.provide(ReleaseLayer)),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}

export { RETIRED_N1_GRANT_REMEDIATION } from './n1-stage-grants.mts';
