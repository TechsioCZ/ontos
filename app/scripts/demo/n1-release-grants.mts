#!/usr/bin/env node
/**
 * Release reconcile for the N1 stage grants. app-host runs it after every release, next to the demo service grants.
 * It is additive: it TOUCHes the reviewed N1 desired set (the policy in n1-stage-grants.mts, identities in
 * n1-stage-access.json) and never revokes. Removing stale N1 grants stays with the operator plan/apply command.
 */
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Command } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { coreActionCatalog } from '../../packages/core-runtime/src/modules/actions/catalog.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { decodeN1Access, n1GrantRelationships, n1ManifestSources, N1StageGrantError } from './n1-stage-grants.mts';
import { reconcileServiceGrants } from './reconcile-stage-service-grants.mts';

export const N1_RELEASE_ACCESS_FILE = 'scripts/demo/n1-stage-access.json';
// The owners the reviewed N1 plan builds from; with the core Actions they are the whole N1 action universe.
const n1OwnerModules = new Set<string>(n1ManifestSources.map(({ moduleId }) => moduleId));

const fail = (reason: string) => new N1StageGrantError({ reason });

export const releaseN1Grants = Effect.gen(function* releaseN1GrantsProgram() {
  yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  const fs = yield* FileSystem.FileSystem;
  const access = yield* fs.readFileString(N1_RELEASE_ACCESS_FILE).pipe(
    Effect.mapError(() => fail('The committed N1 access file could not be read')),
    Effect.flatMap(decodeN1Access),
  );
  // The active composition is the same local source the demo grants read: no public HTTP while the app is starting.
  const source = yield* ActiveApplicationCompositionService;
  // Only the N1 owners and the core Actions: the same universe the reviewed plan builds from. Other owners' Actions
  // would widen the desired set beyond the plan.
  const coreKeys = new Set(coreActionCatalog.map(({ actionKey }) => actionKey));
  const actions = (yield* discoverCurrentActions(yield* source.load)).filter(
    ({ actionKey, owningModuleKey }) => coreKeys.has(actionKey) || n1OwnerModules.has(owningModuleKey),
  );
  const relationships = yield* n1GrantRelationships(access, actions);
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
  const result = yield* reconcileServiceGrants(rpc, relationships, 'apply');
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
      Effect.provide(
        Layer.mergeAll(
          ActiveApplicationCompositionConfigLive.pipe(
            Layer.provide(ActiveApplicationCompositionSourceLive),
            Layer.provide(FetchHttpClient.layer),
          ),
          ProcessDatabasePoolsLive,
          NodeServices.layer,
        ),
      ),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
