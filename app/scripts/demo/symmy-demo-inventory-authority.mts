#!/usr/bin/env node
/** Enroll the reviewed Inventory SYSTEM receiver before stage publication; never create an external alias. */
import { randomUUID } from 'node:crypto';
import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Redacted, Schema } from 'effect';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { AccessReleaseStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { CoreDatabaseLive, CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import { enrollReleaseSystemWorkload } from '../../packages/core-runtime/src/install/release-system-workloads.ts';
import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_PATH,
  OntosModuleDeploymentContractSchema,
} from '../../packages/core-runtime/src/modules/manifest.ts';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import { inventorySourceProvisionSystemWorkload } from '../../verticals/inventory/src/source-provision-system-workload.ts';
import { requireSymmyDemoStage, symmyDemoPolicyScope } from './symmy-demo-source-policies.mts';

const catalogPath = new URL('../../topology/authorization-catalog.json', import.meta.url);
const catalogSchema = Schema.Struct({ declaredWorkloadKeys: Schema.Array(WorkloadKeySchema) });
const workloadKey = 'commerce.inventory.source-provision';
export const inventoryCandidateContractUrl = new URL(
  `../../verticals/inventory/dist/public${ONTOS_MODULE_CONTRACT_PATH}`,
  import.meta.url,
);

export class SymmyDemoInventoryAuthorityError extends Schema.TaggedError<SymmyDemoInventoryAuthorityError>()(
  'SymmyDemoInventoryAuthorityError',
  { reason: Schema.String },
) {}
const unavailable = (reason: string) => new SymmyDemoInventoryAuthorityError({ reason });

/** Read the complete build-generated candidate artifact; never compile owners during runtime enrollment. */
export const readSymmyInventoryCandidateContract = (artifact: URL = inventoryCandidateContractUrl) =>
  Effect.gen(function* readCandidateContract() {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs
      .readFile(artifact.pathname)
      .pipe(Effect.mapError(() => unavailable('The shipped Inventory candidate deployment contract is unavailable')));
    if (bytes.byteLength > ONTOS_MODULE_CONTRACT_MAX_BYTES) {
      return yield* unavailable('The shipped Inventory candidate deployment contract exceeds its size limit');
    }
    const text = yield* Effect.try({
      catch: () => unavailable('The shipped Inventory candidate deployment contract is not UTF-8'),
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    });
    const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema), {
      onExcessProperty: 'error',
    })(text).pipe(Effect.mapError(() => unavailable('The shipped Inventory candidate deployment contract is invalid')));
    if (contract.deployment.appId !== 'inventory' || contract.manifest.module.id !== 'commerce.inventory') {
      return yield* unavailable('The shipped candidate deployment contract does not identify Inventory');
    }
    return contract;
  });

export const SymmyDemoInventoryAuthorityLive = Layer.unwrap(
  Effect.gen(function* inventoryDatabaseLayer() {
    yield* requireSymmyDemoStage(yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
    const [runtime, admin] = yield* Effect.all([
      Config.Redacted('DATABASE_URL'),
      Config.Redacted('DATABASE_ADMIN_URL'),
    ]);
    const connections = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(admin),
      DATABASE_URL: Redacted.value(runtime),
    }).pipe(Effect.mapError(() => unavailable('The native runtime/admin database pair is required')));
    const database = Layer.mergeAll(
      CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, connections.runtime))),
      Layer.succeed(DatabaseIdentityEnrollmentContext, APP_DATABASE_IDENTITY_ENROLLMENT),
    );
    return Layer.mergeAll(database, AccessReleaseStoreLive.pipe(Layer.provide(database)));
  }),
);

/** No fixture contract or substituted installed catalog: load the complete reviewed candidate deployment artifact. */
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
  const contract = yield* readSymmyInventoryCandidateContract();
  const { executor } = yield* CoreDatabase;
  return yield* enrollReleaseSystemWorkload(
    { enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor },
    {
      contract,
      declaredWorkloadKeys: catalog.declaredWorkloadKeys,
      registration,
      runReference: `akros-inventory-${randomUUID()}`,
      tenantId: symmyDemoPolicyScope.tenantId,
    },
  );
});

if (import.meta.main) {
  NodeRuntime.runMain(
    bootstrapSymmyDemoInventoryAuthority.pipe(
      Effect.flatMap(({ outcome }) => Console.log(`[symmy-demo-inventory-authority] ${outcome}`)),
      Effect.provide(SymmyDemoInventoryAuthorityLive),
      Effect.provide(NodeCrypto.layer),
      Effect.provide(NodeServices.layer),
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Console.error('[symmy-demo-inventory-authority] failed; no authority is assumed')
          : Effect.void,
      ),
    ),
    { disableErrorReporting: true },
  );
}
