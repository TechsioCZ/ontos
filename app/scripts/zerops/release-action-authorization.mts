/**
 * Release step: the canonical Action provisioner's derivation for every active Tenant and company, applied on each
 * stage release before it takes the authority.
 *
 * `authorization:provision-current-actions` derives each scope's Action edges from the composition and the installed
 * modules. This step uses the same derivation for the observed release, but for every active Tenant in the database,
 * not only the operator file's Tenants. That covers companies created outside the demo builders too. Administrators
 * hold Actions through `company_scope->write_all`, so a missing scope edge locks out everyone, administrators included.
 *
 * The step owns every `action` edge: `tenant_scope`/`company_scope`, the `grant` link to each Action's `action_grant`,
 * and the intrinsic `self_credentials` edge of the two own-key Actions (every signed-in person manages their own
 * credentials, which act only with that person's rights). It TOUCHes the missing ones and DELETEs every present one
 * the derivation does not produce: Actions of uninstalled or unpublished modules, suspended Tenants, inactive
 * companies. The per-tenant grant scripts write no `action` edges. It writes no role policy (`action_grant` role
 * edges): that stays with the operator accounts file and the per-tenant scripts. The event-driven runtime reconciler
 * uses the same derivation between releases. The provisioner's apply is not used: it needs the operator accounts file
 * and a reviewed fingerprint.
 */
import path from 'node:path';

import { v1 } from '@authzed/authzed-node';
import {
  Array as EffectArray,
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Order,
  Redacted,
  Schedule,
  Schema,
} from 'effect';
import type { ConfigProvider } from 'effect';

import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { legalEntities, tenantModuleStates, tenants } from '../../packages/core-runtime/src/db/schema.ts';
import {
  buildActionAuthorizationRelationships,
  buildIntrinsicSelfCredentialRelationships,
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
  readonly revoked: number;
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
 * The canonical provisioner's scopes and edges, for active Tenants only. A suspended or archived Tenant gets nothing
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
        relationships: [
          ...buildActionAuthorizationRelationships(scoped),
          ...buildIntrinsicSelfCredentialRelationships(actions, scoped),
        ],
        tenants: tenantIds.length,
      };
    },
  });

/**
 * Every live Action edge. The provisioning step reads it before the inventory: an edge the runtime reconciler wrote
 * for a module installed meanwhile then also appears in the inventory read after it, so the step never revokes it.
 */
export const readLiveActionAuthorization = (rpc: Pick<SpiceDbRpc, 'readRelationships'>) =>
  rpc
    .readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: fullyConsistent,
        relationshipFilter: { resourceType: 'action' },
      }),
    )
    .pipe(
      Effect.map((rows) => rows.flatMap(({ relationship }) => (relationship === undefined ? [] : [relationship]))),
      Effect.mapError(() => fail('The live Action edges could not be read')),
    );

/** One operation over many edges, in batches SpiceDB accepts. */
const writeActionEdges = (
  rpc: Pick<SpiceDbRpc, 'writeRelationships'>,
  relationships: readonly v1.Relationship[],
  operation: v1.RelationshipUpdate_Operation,
  reason: string,
) =>
  Effect.forEach(
    EffectArray.chunksOf(relationships, WRITE_BATCH),
    (batch) =>
      rpc
        .writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: batch.map((relationship) => v1.RelationshipUpdate.create({ operation, relationship })),
          }),
        )
        .pipe(Effect.mapError(() => fail(reason))),
    { concurrency: 1, discard: true },
  );

/** TOUCHes the desired edges SpiceDB lacks, then DELETEs the live edges the derivation does not produce. */
export const reconcileActionAuthorization = (
  rpc: Pick<SpiceDbRpc, 'writeRelationships'>,
  live: readonly v1.Relationship[],
  desired: readonly v1.Relationship[],
) =>
  Effect.gen(function* reconcileLive() {
    // An empty derivation would revoke every Action of every Tenant; Core Actions always derive for an active Tenant.
    if (desired.length === 0) {
      return yield* fail('The derivation produced no Action edges; nothing was revoked');
    }
    const present = new Set(live.map(relationshipKey));
    const wanted = new Set(desired.map(relationshipKey));
    const missing = desired.filter((relationship) => !present.has(relationshipKey(relationship)));
    const stale = live.filter((relationship) => !wanted.has(relationshipKey(relationship)));
    const { DELETE, TOUCH } = v1.RelationshipUpdate_Operation;
    yield* writeActionEdges(rpc, missing, TOUCH, 'Missing Action edges could not be written');
    yield* writeActionEdges(rpc, stale, DELETE, 'Stale Action edges could not be revoked');
    return { revoked: stale.length, touched: missing.length };
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
      const rpc = yield* connect;
      const live = yield* readLiveActionAuthorization(rpc);
      const derived = yield* deriveReleaseActionAuthorization(
        actions,
        publishedModuleKeys,
        yield* readReleaseActionAuthorizationInventory,
      );
      const { revoked, touched } = yield* reconcileActionAuthorization(rpc, live, derived.relationships);
      return {
        companies: derived.companies,
        desired: derived.relationships.length,
        revoked,
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

/** Under the deployed workspace, readable for the container's whole life, so the result never races the log window. */
export const RELEASE_ACTION_AUTHORIZATION_STATUS_FILE = '.zerops/runtime/release-action-authorization.json';

const ReleaseActionAuthorizationStatusSchema = Schema.Struct({
  companies: Schema.optional(Schema.Number),
  desired: Schema.optional(Schema.Number),
  finishedAt: Schema.DateTimeUtcFromString,
  outcome: Schema.Literals(['applied', 'failed']),
  reason: Schema.optional(Schema.String),
  revision: Schema.String,
  revoked: Schema.optional(Schema.Number),
  tenants: Schema.optional(Schema.Number),
  touched: Schema.optional(Schema.Number),
});
export type ReleaseActionAuthorizationStatus = typeof ReleaseActionAuthorizationStatusSchema.Type;

/** Counts, revision and sanitized reason only. A write failure is logged and never changes the release outcome. */
export const recordReleaseActionAuthorization = (workspace: string, status: ReleaseActionAuthorizationStatus) =>
  Effect.gen(function* recordStatus() {
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(workspace, RELEASE_ACTION_AUTHORIZATION_STATUS_FILE);
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(ReleaseActionAuthorizationStatusSchema))(status);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, `${text}\n`);
  }).pipe(
    Effect.tapError(() =>
      Console.error(
        `[app-host] release Action authorization status ${RELEASE_ACTION_AUTHORIZATION_STATUS_FILE} not written`,
      ),
    ),
    Effect.ignore,
  );
