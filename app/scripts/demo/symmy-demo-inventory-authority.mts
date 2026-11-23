#!/usr/bin/env node
/** Enroll the reviewed Inventory SYSTEM receiver before stage publication; never create an external alias. */
import { randomUUID } from 'node:crypto';
import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Redacted, Schema } from 'effect';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { AccessReleaseStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { makeCoreDatabase, CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { parseDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import { enrollReleaseSystemWorkload } from '../../packages/core-runtime/src/install/release-system-workloads.ts';
import { inventorySourceProvisionSystemWorkload } from '../../verticals/inventory/src/source-provision-system-workload.ts';
import { deriveOntosModuleDeploymentContract } from '../generate-ontos-module-contract.mts';
import { requireSymmyDemoStage, symmyDemoPolicyScope } from './symmy-demo-source-policies.mts';

const catalogPath = new URL('../../topology/authorization-catalog.json', import.meta.url);
const catalogSchema = Schema.Struct({ declaredWorkloadKeys: Schema.Array(Schema.String) });
const workloadKey = 'commerce.inventory.source-provision';

export class SymmyDemoInventoryAuthorityError extends Schema.TaggedError<SymmyDemoInventoryAuthorityError>()(
  'SymmyDemoInventoryAuthorityError',
  { reason: Schema.String },
) {}
const unavailable = (reason: string) => new SymmyDemoInventoryAuthorityError({ reason });

const RuntimeLive = Layer.unwrap(Effect.gen(function* runtime() {
  const [runtime, admin] = yield* Effect.all([
    Config.Redacted('DATABASE_URL'), Config.Redacted('DATABASE_ADMIN_URL'),
  ]);
  const connections = yield* parseDatabaseConnectionPair({
    DATABASE_URL: Redacted.value(runtime), DATABASE_ADMIN_URL: Redacted.value(admin),
  }).pipe(Effect.mapError(() => unavailable('The native runtime/admin database pair is required')));
  const database = Layer.mergeAll(
    Layer.effect(CoreDatabase, makeCoreDatabase(connections.runtime)),
    Layer.succeed(DatabaseIdentityEnrollmentContext, APP_DATABASE_IDENTITY_ENROLLMENT),
  );
  return Layer.mergeAll(database, AccessReleaseStoreLive.pipe(Layer.provide(database)));
}));

/** No fixture contract or substituted installed catalog: derive the complete reviewed owner deployment contract. */
export const bootstrapSymmyDemoInventoryAuthority = Effect.gen(function* bootstrap() {
  yield* requireSymmyDemoStage(yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
  const registration = inventorySourceProvisionSystemWorkload;
  if (registration.jobKey !== workloadKey) {
    return yield* unavailable('Inventory must declare exactly its native source-provision SYSTEM receiver');
  }
  const fs = yield* FileSystem.FileSystem;
  const catalog = yield* fs.readFileString(catalogPath.pathname).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(catalogSchema))),
    Effect.mapError(() => unavailable('The reviewed workload vocabulary is unavailable')),
  );
  const contract = yield* deriveOntosModuleDeploymentContract({ vertical: 'inventory' }).pipe(
    Effect.mapError(() => unavailable('The genuine Inventory deployment contract could not be derived')),
  );
  const { executor } = yield* CoreDatabase;
  return yield* enrollReleaseSystemWorkload(
    { executor, enrollment: APP_DATABASE_IDENTITY_ENROLLMENT },
    {
      contract, registration, declaredWorkloadKeys: catalog.declaredWorkloadKeys,
      tenantId: symmyDemoPolicyScope.tenantId,
      runReference: `akros-inventory-${randomUUID()}`,
    },
  );
});

if (import.meta.main) {
  const command = Effect.gen(function* runStageEnrollment() {
    yield* requireSymmyDemoStage(yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
    return yield* bootstrapSymmyDemoInventoryAuthority.pipe(Effect.provide(RuntimeLive));
  });
  NodeRuntime.runMain(command.pipe(
    Effect.flatMap(({ outcome }) => Console.log(`[symmy-demo-inventory-authority] ${outcome}`)),
    Effect.provide(NodeCrypto.layer),
    Effect.provide(NodeServices.layer),
    Effect.onExit((exit) => Exit.isFailure(exit)
      ? Console.error('[symmy-demo-inventory-authority] failed; no authority is assumed')
      : Effect.void),
  ), { disableErrorReporting: true });
}
