/**
 * Release step: the canonical Action provisioner's derivation for every active Tenant and company, applied on each
 * stage release before it takes the authority.
 *
 * `authorization:provision-current-actions` derives each scope's Action edges from the composition and the installed
 * modules. This step uses the same derivation for the observed release, but for every active Tenant in the database,
 * not only the operator file's Tenants. That covers companies created outside the demo builders too. Administrators
 * hold Actions through `company_scope->write_all`, so a missing scope edge locks out everyone, administrators included.
 *
 * It writes only `tenant_scope`/`company_scope` and the `grant` link to each Action's `action_grant`, and only the
 * missing ones, as TOUCH. It never deletes. It writes no role policy (`action_grant` role edges): that stays with the
 * operator accounts file and the per-tenant scripts. It writes no intrinsic `self_credentials` either: that would let
 * every human of a Tenant run the self-key Actions, which the reviewed N1 plan asserts its catalogue manager cannot.
 * Revoking stays with the event-driven runtime reconciler, which uses the same derivation. The provisioner's apply
 * is not used: it needs the operator accounts file and a reviewed fingerprint, and it deletes edges in its scopes.
 */
import { v1 } from '@authzed/authzed-node';
import { Array as EffectArray, Config, Duration, Effect, Order, Redacted, Schedule, Schema } from 'effect';
import type { ConfigProvider } from 'effect';

import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { legalEntities, tenantModuleStates, tenants } from '../../packages/core-runtime/src/db/schema.ts';
import {
  buildActionAuthorizationRelationships,
  deriveScopedActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type { ActionAuthorizationProvisioningAction } from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { fullyConsistent } from '../../packages/core-runtime/src/permissions/client.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import type { SpiceDbConfigValue } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import type { SpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import {
  deriveActionAuthorizationInstalledModuleScopes,
  discoverCurrentActions,
} from '../provision-current-action-authorization.mts';

export class ReleaseActionAuthorizationError extends Schema.TaggedError<ReleaseActionAuthorizationError>()(
  'ReleaseActionAuthorizationError',
  { reason: Schema.String },
) {}
const fail = (reason: string) => new ReleaseActionAuthorizationError({ reason });

export interface ReleaseActionAuthorizationInventory {
  readonly companies: readonly { readonly legalEntityId: string; readonly status: string; readonly tenantId: string }[];
  readonly moduleStates: readonly { readonly moduleKey: string; readonly state: string; readonly tenantId: string }[];
  readonly tenants: readonly { readonly status: string; readonly tenantId: string }[];
}

export interface ReleaseActionAuthorizationResult {
  readonly companies: number;
  readonly desired: number;
  readonly tenants: number;
  readonly touched: number;
}

// SpiceDB refuses a write transaction above 1,000 updates.
const WRITE_BATCH = 500;
const SPICEDB_TIMEOUT_MILLISECONDS = 30_000;
const STEP_BUDGET = Duration.minutes(3);

const relationshipKey = (relationship: v1.Relationship) =>
  [
    relationship.resource?.objectType ?? '',
    relationship.resource?.objectId ?? '',
    relationship.relation,
    relationship.subject?.object?.objectType ?? '',
    relationship.subject?.object?.objectId ?? '',
    relationship.subject?.optionalRelation ?? '',
  ]
    .map(encodeURIComponent)
    .join(':');

/**
 * The canonical provisioner's scopes and scope/grant edges, for active Tenants only. A suspended or archived Tenant gets nothing
 * here because the runtime reconciler wants it empty. Inactive companies get no module keys, as in the provisioner.
 */
export const deriveReleaseActionAuthorization = (
  actions: readonly ActionAuthorizationProvisioningAction[],
  publishedModuleKeys: readonly string[],
  inventory: ReleaseActionAuthorizationInventory,
) =>
  Effect.try({
    catch: () => fail('The current Action edges could not be derived from the composition and the installed modules'),
    try: () => {
      const tenantIds = EffectArray.sort(
        inventory.tenants.flatMap(({ status, tenantId }) => (status === 'active' ? [tenantId] : [])),
        Order.String,
      );
      const scopes = deriveActionAuthorizationInstalledModuleScopes(
        publishedModuleKeys,
        tenantIds,
        inventory.moduleStates,
        inventory.companies,
      );
      const scoped = deriveScopedActionAuthorization(actions, scopes);
      return {
        companies: scopes.filter(({ legalEntityId }) => legalEntityId !== undefined).length,
        relationships: buildActionAuthorizationRelationships(scoped),
        tenants: tenantIds.length,
      };
    },
  });

/** Writes only the desired edges SpiceDB lacks, as TOUCH. Present edges, desired or not, are never changed. */
export const touchMissingActionAuthorization = (
  rpc: Pick<SpiceDbRpc, 'readRelationships' | 'writeRelationships'>,
  desired: readonly v1.Relationship[],
) =>
  Effect.gen(function* touchMissing() {
    const existing = yield* rpc
      .readRelationships(
        v1.ReadRelationshipsRequest.create({
          consistency: fullyConsistent,
          relationshipFilter: { resourceType: 'action' },
        }),
      )
      .pipe(Effect.mapError(() => fail('The live Action edges could not be read')));
    const present = new Set(
      existing.flatMap(({ relationship }) => (relationship === undefined ? [] : [relationshipKey(relationship)])),
    );
    const missing = desired.filter((relationship) => !present.has(relationshipKey(relationship)));
    yield* Effect.forEach(
      EffectArray.chunksOf(missing, WRITE_BATCH),
      (batch) =>
        rpc
          .writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: batch.map((relationship) =>
                v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship }),
              ),
            }),
          )
          .pipe(Effect.mapError(() => fail('Missing Action edges could not be written'))),
      { concurrency: 1, discard: true },
    );
    return missing.length;
  });

/** The administrator pool reads every Tenant; the runtime identity's row security would hide other Tenants. */
export const readReleaseActionAuthorizationInventory = Effect.gen(function* readInventory() {
  const database = yield* CoreDatabase;
  const [tenantRows, companies, moduleStates] = yield* Effect.all(
    [
      database.executor.select({ status: tenants.status, tenantId: tenants.tenantId }).from(tenants),
      database.executor
        .select({
          legalEntityId: legalEntities.legalEntityId,
          status: legalEntities.status,
          tenantId: legalEntities.tenantId,
        })
        .from(legalEntities),
      database.executor
        .select({
          moduleKey: tenantModuleStates.moduleKey,
          state: tenantModuleStates.state,
          tenantId: tenantModuleStates.tenantId,
        })
        .from(tenantModuleStates),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(() => fail('The Tenants, companies and installed modules could not be read')));
  return { companies, moduleStates, tenants: tenantRows } satisfies ReleaseActionAuthorizationInventory;
});

/**
 * Stage only, against the fixed stage SpiceDB, as the canonical provisioner requires. app-host passes the owner secrets
 * layered over the container environment, the same settings the N1 release grants child receives.
 */
export const loadReleaseActionAuthorizationConfiguration = (provider: ConfigProvider.ConfigProvider) =>
  Effect.gen(function* loadConfiguration() {
    const environment = yield* Config.all({
      SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    })
      .parse(provider)
      .pipe(
        Effect.mapError(() => fail('Release Action provisioning runs only on stage against the fixed stage SpiceDB')),
      );
    return yield* parseSpiceDbConfig({
      ...environment,
      SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
    }).pipe(Effect.mapError(() => fail('The stage SpiceDB configuration is invalid; values withheld')));
  });

/**
 * The database and SpiceDB round trips are retried twice; a configuration or derivation failure is final. The caller
 * does not publish the release on failure.
 */
export const provisionReleaseActionAuthorization = (
  snapshot: ActiveApplicationCompositionSnapshot,
  provider: ConfigProvider.ConfigProvider,
  open: (configuration: SpiceDbConfigValue) => SpiceDbRpc = (configuration) =>
    openSpiceDbGrpcRpc(configuration, SPICEDB_TIMEOUT_MILLISECONDS),
) =>
  Effect.gen(function* provisionRelease() {
    const configuration = yield* loadReleaseActionAuthorizationConfiguration(provider);
    const actions = yield* discoverCurrentActions(snapshot).pipe(
      Effect.mapError(() => fail('The release composition does not yield a complete Action set')),
    );
    const publishedModuleKeys = snapshot.composition.modules.map(({ moduleId }) => moduleId);
    const connect = Effect.acquireRelease(
      Effect.try({
        catch: () => fail('The stage SpiceDB connection could not be opened'),
        try: () => open(configuration),
      }),
      (client) => Effect.sync(() => client.close()),
    );
    return yield* Effect.gen(function* applyRelease() {
      const derived = yield* deriveReleaseActionAuthorization(
        actions,
        publishedModuleKeys,
        yield* readReleaseActionAuthorizationInventory,
      );
      const touched = yield* touchMissingActionAuthorization(yield* connect, derived.relationships);
      return {
        companies: derived.companies,
        desired: derived.relationships.length,
        tenants: derived.tenants,
        touched,
      } satisfies ReleaseActionAuthorizationResult;
    }).pipe(Effect.scoped, Effect.retry({ schedule: Schedule.spaced(Duration.seconds(5)), times: 2 }));
  }).pipe(
    Effect.timeoutOrElse({
      duration: STEP_BUDGET,
      orElse: () => Effect.fail(fail('Release Action provisioning exceeded its time budget')),
    }),
  );
