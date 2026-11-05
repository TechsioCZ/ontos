#!/usr/bin/env node
/**
 * Release reconcile for the N1 stage grants. app-host runs it after every release, next to the demo service grants.
 * It is additive: it TOUCHes the reviewed N1 desired set (the policy in n1-stage-grants.mts, identities in
 * n1-stage-access.json) and never revokes. Removing stale N1 grants stays with the operator plan/apply command.
 */
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Redacted, Schema } from 'effect';
import { Command } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { createN1GrantPlan, decodeN1Access, loadN1Contracts, N1StageGrantError } from './n1-stage-grants.mts';
import { reconcileServiceGrants } from './reconcile-stage-service-grants.mts';

export const N1_RELEASE_ACCESS_FILE = 'scripts/demo/n1-stage-access.json';

const fail = (reason: string) => new N1StageGrantError({ reason });

export const releaseN1Grants = Effect.gen(function* releaseN1GrantsProgram() {
  yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  const fs = yield* FileSystem.FileSystem;
  const access = yield* fs.readFileString(N1_RELEASE_ACCESS_FILE).pipe(
    Effect.mapError(() => fail('The committed N1 access file could not be read')),
    Effect.flatMap(decodeN1Access),
  );
  const plan = yield* createN1GrantPlan(access, yield* loadN1Contracts);
  const environment = yield* Config.all({
    SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
    SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
    SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
  });
  const configuration = yield* parseSpiceDbConfig({
    ...environment,
    SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
  });
  const rpc = yield* Effect.acquireRelease(
    Effect.try({
      catch: () => fail('The pinned native stage SpiceDB connection could not be opened'),
      try: () => openSpiceDbGrpcRpc(configuration, 10_000),
    }),
    (client) => Effect.sync(() => client.close()),
  );
  const result = yield* reconcileServiceGrants(rpc, plan.relationships, 'apply');
  return yield* Console.log({ applied: result.applied, desired: result.desired, missing: result.missing });
}).pipe(Effect.scoped);

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
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
