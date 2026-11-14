import { v1 } from '@authzed/authzed-node';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionSnapshotSchema,
  AgentProposalCommandAuthorizationPreflightLive,
  AgentProposalCommandPreparationLive,
  AgentProposalQueueModuleReview,
  ContextAccess,
  loadDatabaseConnectionPair,
  makeActionRuntimeLive,
  makeContextAccessLive,
  makeDatabaseIdentityEnrollmentLive,
  OntosDeploymentAppIdSchema,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  OperationalScopeResolver,
  parseDatabaseConnectionPair,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot, DatabaseConnectionPair } from '@app/core-runtime';
import { AccessCatalogModulesSchema } from '@app/core-runtime/access/catalog';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { InstalledModuleCatalogServiceLive } from '@app/core-runtime/modules/active-application-composition';
import {
  AccessDecisionLive,
  AccessDecisionLogBatchLive,
  AccessDecisionLogLive,
  AccessIntentLive,
  AccessPrincipalKindSourceLive,
  ActionAuthority,
  ActionAuthorityLive,
  ActionRepositoryLive,
  LegalEntityCandidatesLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import type { PgClient } from '@effect/sql-pg';
import {
  Config,
  ConfigProvider,
  Context,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Tracer,
} from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { SqlConnection } from 'effect/sql';
import { expect, it } from 'effect-rstest';

import { DecisionCheck } from '../../../../packages/core-runtime/src/access/decision/engine.ts';
import { DatabasePoolRegistryLive, DatabasePools } from '../../../../packages/core-runtime/src/db/database-client.ts';
import { AccessDecisionGate } from '../../../../packages/core-runtime/src/access/enforcement/contract.ts';
import { buildPeopleSearchDocuments } from '../../../../packages/core-runtime/src/people/people-search-projection.ts';
import {
  admitPeopleSystemSearch,
  PeopleSearchReadLive,
} from '../../../../packages/core-runtime/src/people/system-search-provider.ts';
import { deriveCoreSearchRepresentation } from '../../../../packages/core-runtime/src/search/evidence-codec.ts';
import {
  coreSearchDocumentBodyText,
  coreSearchDocumentPayload,
  CoreSearchProjectionStoreLive,
} from '../../../../packages/core-runtime/src/search/persistence.ts';
import { enginePortOf } from '../../../../packages/core-runtime/src/access/enforcement/enforcement-live.ts';
import { ActiveApplicationCompositionSource } from '../../../../packages/core-runtime/src/modules/active-application-composition-source-service.ts';
import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY } from '../../../../packages/core-runtime/src/modules/module-dependency-contracts.ts';
import {
  createSpiceDbPermissionClient,
  SPICEDB_CHECK_TIMEOUT_MS,
} from '../../../../packages/core-runtime/src/permissions/client.ts';
import type { SpiceDbPermissionClient } from '../../../../packages/core-runtime/src/permissions/client.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../../../packages/core-runtime/src/permissions/schema.ts';
import {
  ActionPermission,
  makeActionPermissionLive,
} from '../../../../packages/core-runtime/src/permissions/service.ts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { spiceDbTransport } from '../../../../packages/core-runtime/src/permissions/spicedb-transport.node.ts';
import { makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { deriveOntosModuleDeploymentContract } from '../../../../scripts/generate-ontos-module-contract.mts';
import { callerModuleAccess, moduleCarriers } from '../../api/agent-platform/caller.ts';
import type { AgentPlatformCaller, ModuleCarrier } from '../../api/agent-platform/caller.ts';
import {
  claimForApproval,
  listCompanyProposalPage,
  loadBatchProposals,
  loadProposalBatch,
  markApplied,
  markRejected,
  principalNames,
  requireCurrentProposalClaim,
} from '../../api/agent-platform/proposal-store.ts';
import { AgentActionRequestIdentity } from '../../api/auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../../api/auth/agent-request-identity.ts';
import { StaffAuthenticationNamespaceRegistryLive } from '../../api/auth/authentication-namespace-registry.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';
import {
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogLive,
} from '../../api/modules/installed-module-catalog.ts';
import { ShellPeopleSystemSearchLive, ShellSystemSearch } from '../../api/modules/shell-system-search.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import {
  buildAccessGraph,
  replacedDatabase,
  templateDatabaseLayer,
} from '../support/access-admin-real-gate-fixture.ts';

/*
 * LOCAL MEASUREMENT of the agent approval path in the shape of stage's N1 demo tenant: six installed modules, one
 * company, the tenant owner (full access from bootstrap) deciding one agent's work-tasks proposals. Real Postgres
 * (a private clone of the migrated template), real SpiceDB, the real access gate, Action authority, Core Read and
 * Action runtimes, composed as the Shell composes them (`api/index.ts`, `makeShellAuthenticationApiRuntime`).
 *
 * Not real here: module owners. The Core Read's module visibility review (`AgentProposalQueueModuleReview`) is a stub
 * that sees every subject; the Shell's own owner calls (module review, apply, follow-up) are not made at all. The
 * active composition comes from memory instead of the HTTP composition source.
 *
 * Every step is measured on its own, after one warm-up of the same reads. The report lists counts and timings only.
 */

const releaseIntentPath = new URL('../../../../topology/application-release-intent.json', import.meta.url);
const catalogArtifactPath = new URL('../../../../topology/authorization-catalog.json', import.meta.url);
const ReleaseIntentSchema = Schema.fromJsonString(
  Schema.Struct({ modules: Schema.Array(Schema.Struct({ appId: OntosDeploymentAppIdSchema })) }),
);
const TEMPLATE_DATABASE = 'p14_access_admin_template';
const reportPath = Config.option(Config.String('STAGE_SHAPE_REPORT'));
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The modules stage's N1 demo tenant installs that the release composes. */
const N1_MODULES = [
  'commerce.customer-context',
  'commerce.market-catalog',
  'commerce.storefront-registry',
  'demo.merchandise',
  'party.registry',
  'work.tasks',
];

const TASKS_APP = 'work-tasks';
const TASKS_MODULE = 'work.tasks';
const TASKS_SLUG = 'apply-command';

const installedComposition = Effect.gen(function* installedComposition() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const intent = yield* Schema.decodeUnknownEffect(ReleaseIntentSchema)(
    yield* fileSystem.readFileString(yield* path.fromFileUrl(releaseIntentPath)),
  );
  const contracts = yield* Effect.forEach(
    intent.modules,
    ({ appId }) => deriveOntosModuleDeploymentContract({ vertical: appId }),
    { concurrency: 4 },
  );
  const receiverDeployment = { appId: 'shell-super-app', buildMarker: ultramodernDeliveryUnit.buildMarker } as const;
  const document = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
    deployment: receiverDeployment,
    schemaVersion: '2',
  });
  return yield* makeCompositionSnapshot(contracts, 600_000, { document, receiverDeployment });
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const publishedCatalog = Effect.gen(function* publishedCatalog() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const artifact = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema, schemaVersion: Schema.Number })),
  )(yield* fileSystem.readFileString(yield* path.fromFileUrl(catalogArtifactPath)));
  return artifact.modules;
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

// ---------------------------------------------------------------------------------------------------------------
// Recording: every finished span (name, ms, SQL text of statements), every Action-authority batch.
// ---------------------------------------------------------------------------------------------------------------

const SPICEDB_SPANS = new Set([
  'AccessDecision.spicedbCheckBulk',
  'SpiceDb.contextAccess.checkBulkPermissions',
  'SpiceDb.contextAccess.checkPermission',
  'SpiceDb.actionPermission.checkBulkPermissions',
  'SpiceDb.actionPermission.checkPermission',
]);
const OWNER_REVIEW_SPAN = 'Stub.moduleVisibilityReview';
/** Calls that leave the process: SpiceDB, a module owner, the composition source. */
const REMOTE_SPANS = new Set([...SPICEDB_SPANS, OWNER_REVIEW_SPAN, 'Stub.compositionSourceLoad']);

const LEASE_SPAN = 'test.pool.lease';
const LEASE_STATEMENT_SPAN = 'test.pool.statement';
const LEASE_ATTRIBUTE = 'test.lease';
const ACQUIRED_BY_ATTRIBUTE = 'test.acquiredBy';
const WAITED_ATTRIBUTE = 'test.waitedMs';

interface SpanRecord {
  /** The code that took a pool lease (lease spans only). */
  readonly acquiredBy: string | undefined;
  readonly endNs: bigint;
  /** The pool lease a lease or lease statement span belongs to. */
  readonly lease: string | undefined;
  readonly ms: number;
  readonly name: string;
  /** Statement text of a database span; parameters are placeholders and never recorded. */
  readonly sql: string | undefined;
  readonly startNs: bigint;
  /** How long a lease waited for the pool to hand out its connection (lease spans only). */
  readonly waitedMs: number;
}

const recordingTracer = (records: SpanRecord[]) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const text = span.attributes.get('db.query.text');
        const lease = span.attributes.get(LEASE_ATTRIBUTE);
        const acquiredBy = span.attributes.get(ACQUIRED_BY_ATTRIBUTE);
        const waited = span.attributes.get(WAITED_ATTRIBUTE);
        records.push({
          acquiredBy: Predicate.isString(acquiredBy) ? acquiredBy : undefined,
          endNs: endTime,
          lease: Predicate.isString(lease) ? lease : undefined,
          ms: Number(endTime - options.startTime) / 1e6,
          name: options.name,
          sql: Predicate.isString(text) ? text : undefined,
          startNs: options.startTime,
          waitedMs: Predicate.isNumber(waited) ? waited : 0,
        });
      };
      return span;
    },
  });

interface AuthorityCall {
  readonly keys: number;
  readonly ms: number;
}

const appendCall = (calls: Ref.Ref<readonly AuthorityCall[]>, call: AuthorityCall) =>
  Ref.update(calls, (current) => [...current, call]);

/** The live Action authority, recording how many Action keys each batch asked and how long it took. */
const recordedAuthority = (calls: Ref.Ref<readonly AuthorityCall[]>) =>
  Layer.effect(
    ActionAuthority,
    Effect.gen(function* recordAuthority() {
      const live = yield* ActionAuthority;
      const checkActionAuthorities: typeof live.checkActionAuthorities = Effect.fn('test.recordedAuthority')(
        function* checkRecorded(input) {
          const [duration, value] = yield* Effect.timed(live.checkActionAuthorities(input));
          yield* appendCall(calls, { keys: input.actionKeys.length, ms: Duration.toMillis(duration) });
          return value;
        },
      );
      return { checkActionAuthorities, checkActionProposalPermission: live.checkActionProposalPermission };
    }),
  );

/** A SpiceDB client whose every RPC is a span of its own, named after the service that asks it. */
const spannedSpiceDb =
  (source: string) =>
  (configuration: Parameters<typeof createSpiceDbPermissionClient>[0], timeout: number): SpiceDbPermissionClient => {
    const client = createSpiceDbPermissionClient(configuration, timeout);
    return {
      checkBulkPermissions: (request) =>
        client.checkBulkPermissions(request).pipe(Effect.withSpan(`SpiceDb.${source}.checkBulkPermissions`)),
      checkPermission: (request) =>
        client.checkPermission(request).pipe(Effect.withSpan(`SpiceDb.${source}.checkPermission`)),
      close: client.close,
    };
  };

// ---------------------------------------------------------------------------------------------------------------
// Pool leases: the Core database is opened over the process-shared pool exactly as stage opens it
// (`ONTOS_DATABASE_POOL_SHARED=true`, `openDatabaseClient`), and every checkout of that pool is recorded: when it was
// taken and given back, which code took it, and how long a statement was running on it. A lease's hold time minus its
// statement time is the time it was held while the request waited on something else (remote calls, other fibers, CPU).
// ---------------------------------------------------------------------------------------------------------------

/** Span names that only describe the statement itself, never the code that asked for it. */
const isStatementSpan = (name: string) =>
  name.startsWith('sql.') ||
  name.startsWith('test.pool.') ||
  name === 'postgres' ||
  name.startsWith('drizzle') ||
  name.startsWith('db.');

/** The nearest named spans above the code that took the connection. */
const acquiringSpans = (span: Option.Option<Tracer.AnySpan>) => {
  const names: string[] = [];
  let current = Option.getOrUndefined(span);
  while (current !== undefined && Predicate.isTagged(current, 'Span') && names.length < 3) {
    if (!isStatementSpan(current.name)) {
      names.push(current.name);
    }
    current = Option.getOrUndefined(current.parent);
  }
  return names.join(' < ') || '-';
};

const leaseStatement = <A, E, R>(lease: string, statement: Effect.Effect<A, E, R>) =>
  statement.pipe(Effect.withSpan(LEASE_STATEMENT_SPAN, { attributes: { [LEASE_ATTRIBUTE]: lease } }));

/** A checked-out connection whose every statement is a span of its lease. */
const timedConnection = (connection: SqlConnection.Connection, lease: string): SqlConnection.Connection => ({
  execute: (text, params, transformRows) => leaseStatement(lease, connection.execute(text, params, transformRows)),
  executeRaw: (text, params) => leaseStatement(lease, connection.executeRaw(text, params)),
  executeStream: (text, params, transformRows) => connection.executeStream(text, params, transformRows),
  executeUnprepared: (text, params, transformRows) =>
    leaseStatement(lease, connection.executeUnprepared(text, params, transformRows)),
  executeValues: (text, params) => leaseStatement(lease, connection.executeValues(text, params)),
  executeValuesUnprepared: (text, params) => leaseStatement(lease, connection.executeValuesUnprepared(text, params)),
});

/** Each checkout is a span from checkout to return, named after the code that took it. */
const recordedReserve = (pool: PgClient.PgClient, leases: { next: number }) =>
  Effect.gen(function* reserveRecorded() {
    const [waited, connection] = yield* Effect.timed(pool.reserve);
    const acquiredBy = acquiringSpans(yield* Effect.option(Effect.currentSpan));
    leases.next += 1;
    const lease = `lease-${String(leases.next)}`;
    yield* Effect.makeSpanScoped(LEASE_SPAN, {
      attributes: {
        [ACQUIRED_BY_ATTRIBUTE]: acquiredBy,
        [LEASE_ATTRIBUTE]: lease,
        [WAITED_ATTRIBUTE]: Duration.toMillis(waited),
      },
    });
    return timedConnection(connection, lease);
  });

/** The host's pool registry, with every checkout of its pools recorded as a lease span. */
const recordingPoolRegistry = (registry: (typeof DatabasePools)['Service']): (typeof DatabasePools)['Service'] => {
  const leases = { next: 0 };
  return {
    acquire: (configuration) =>
      registry.acquire(configuration).pipe(
        Effect.map(
          (pool): PgClient.PgClient =>
            new Proxy(pool, {
              get: (target, property) => {
                if (property === 'reserve') {
                  return recordedReserve(target, leases);
                }
                const member: unknown = Predicate.hasProperty(target, property) ? target[property] : undefined;
                return member;
              },
            }),
        ),
      ),
  };
};

const nsToMs = (ns: bigint) => Math.round(Number(ns) / 1e5) / 10;

interface Lease {
  readonly acquiredBy: string;
  readonly busyNs: bigint;
  readonly endNs: bigint;
  /** Periods the connection was held with no statement running on it. */
  readonly gaps: readonly (readonly [bigint, bigint])[];
  readonly startNs: bigint;
  readonly statements: number;
  readonly waitedMs: number;
}

const earlier = (left: bigint, right: bigint) => (left < right ? left : right);
const later = (left: bigint, right: bigint) => (left > right ? left : right);

/** The leases of one step, with the statements that ran on each. */
const leasesOf = (records: readonly SpanRecord[]): readonly Lease[] => {
  const statements = new Map<string, SpanRecord[]>();
  for (const record of records) {
    if (record.name === LEASE_STATEMENT_SPAN && record.lease !== undefined) {
      statements.set(record.lease, [...(statements.get(record.lease) ?? []), record]);
    }
  }
  return records.flatMap((record) => {
    if (record.name !== LEASE_SPAN || record.lease === undefined) {
      return [];
    }
    const ran = (statements.get(record.lease) ?? []).toSorted((left, right) => Number(left.startNs - right.startNs));
    const gaps: (readonly [bigint, bigint])[] = [];
    let idleFrom = record.startNs;
    for (const statement of ran) {
      if (statement.startNs > idleFrom) {
        gaps.push([idleFrom, statement.startNs]);
      }
      idleFrom = later(idleFrom, statement.endNs);
    }
    if (record.endNs > idleFrom) {
      gaps.push([idleFrom, record.endNs]);
    }
    return [
      {
        acquiredBy: record.acquiredBy ?? '-',
        busyNs: ran.reduce((sum, statement) => sum + (statement.endNs - statement.startNs), 0n),
        endNs: record.endNs,
        gaps,
        startNs: record.startNs,
        statements: ran.length,
        waitedMs: record.waitedMs,
      },
    ];
  });
};

/** The most connections the leases held at one time. */
const maxConcurrentLeases = (leases: readonly Lease[]) => {
  const events = leases
    .flatMap(({ endNs, startNs }) => [
      { at: startNs, delta: 1 },
      { at: endNs, delta: -1 },
    ])
    .toSorted((left, right) => (left.at === right.at ? left.delta - right.delta : Number(left.at - right.at)));
  let current = 0;
  let max = 0;
  for (const { delta } of events) {
    current += delta;
    max = Math.max(max, current);
  }
  return max;
};

/** Which spans that are not statements started while a lease sat idle: the work it was held waiting on. */
const idleCauses = (leases: readonly Lease[], records: readonly SpanRecord[]) => {
  const causes = new Map<string, number>();
  const work = records.filter(({ name }) => !isStatementSpan(name) && name !== 'measured.step');
  for (const [gapStart, gapEnd] of leases.flatMap(({ gaps }) => gaps)) {
    if (gapEnd - gapStart >= 1_000_000n) {
      for (const record of work) {
        const overlap = earlier(record.endNs, gapEnd) - later(record.startNs, gapStart);
        if (overlap > 500_000n && record.startNs >= gapStart) {
          causes.set(record.name, (causes.get(record.name) ?? 0) + Number(overlap) / 1e6);
        }
      }
    }
  }
  return [...causes]
    .toSorted(([, left], [, right]) => right - left)
    .slice(0, 8)
    .map(([name, ms]) => ({ ms: Math.round(ms * 10) / 10, name }));
};

interface AcquirerTotals {
  readonly count: number;
  readonly heldNs: bigint;
  readonly idleNs: bigint;
  readonly maxIdleNs: bigint;
}

const NO_TOTALS: AcquirerTotals = { count: 0, heldNs: 0n, idleNs: 0n, maxIdleNs: 0n };

const leaseReport = (records: readonly SpanRecord[]) => {
  const leases = leasesOf(records);
  const byAcquirer = new Map<string, AcquirerTotals>();
  for (const lease of leases) {
    const held = lease.endNs - lease.startNs;
    const idle = held - lease.busyNs;
    const entry = byAcquirer.get(lease.acquiredBy) ?? NO_TOTALS;
    byAcquirer.set(lease.acquiredBy, {
      count: entry.count + 1,
      heldNs: entry.heldNs + held,
      idleNs: entry.idleNs + idle,
      maxIdleNs: later(entry.maxIdleNs, idle),
    });
  }
  const heldNs = leases.reduce((sum, lease) => sum + (lease.endNs - lease.startNs), 0n);
  const busyNs = leases.reduce((sum, lease) => sum + lease.busyNs, 0n);
  return {
    byAcquirer: [...byAcquirer]
      .toSorted(([, left], [, right]) => Number(right.idleNs - left.idleNs))
      .slice(0, 10)
      .map(([acquiredBy, entry]) => ({
        acquiredBy,
        count: entry.count,
        heldMs: nsToMs(entry.heldNs),
        idleMs: nsToMs(entry.idleNs),
        maxIdleMs: nsToMs(entry.maxIdleNs),
      })),
    heldMs: nsToMs(heldNs),
    /** Remote calls made while a connection of this step was checked out; a sequential request must make none. */
    heldAcrossRemoteCalls: leases.flatMap(({ acquiredBy, endNs, startNs }) =>
      records
        .filter((record) => REMOTE_SPANS.has(record.name) && record.startNs >= startNs && record.endNs <= endNs)
        .map(({ name }) => `${acquiredBy} held across ${name}`),
    ),
    idleCauses: idleCauses(leases, records),
    idleMs: nsToMs(heldNs - busyNs),
    leases: leases.length,
    maxConcurrent: maxConcurrentLeases(leases),
    maxWaitedMs: Math.round(Math.max(0, ...leases.map(({ waitedMs }) => waitedMs)) * 10) / 10,
    /** Every message to PostgreSQL on a checked-out connection, BEGIN and COMMIT included. */
    roundTrips: records.filter(({ name }) => name === LEASE_STATEMENT_SPAN).length,
    /** Every checkout in the order it was taken: who took it, its statements, how long it was held and idle. */
    sequence: leases
      .toSorted((left, right) => Number(left.startNs - right.startNs))
      .map((lease) => ({
        acquiredBy: lease.acquiredBy.split(' < ').slice(0, 2).join(' < '),
        heldMs: nsToMs(lease.endNs - lease.startNs),
        idleMs: nsToMs(lease.endNs - lease.startNs - lease.busyNs),
        statements: lease.statements,
      })),
    waitedMs: Math.round(leases.reduce((sum, { waitedMs }) => sum + waitedMs, 0) * 10) / 10,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// The Shell's composition (api/index.ts makeShellAuthenticationApiRuntime) over this case's database and SpiceDB.
// ---------------------------------------------------------------------------------------------------------------

/** Every subject is visible: what a module owner answers for a person who sees all its records. */
const visibleEverywhere = Layer.succeed(AgentProposalQueueModuleReview, {
  review: (input) =>
    Effect.succeed({
      items: input.subjects.map((subject) => ({ key: subject.key, visible: true })),
      state: 'ok' as const,
    }).pipe(Effect.withSpan(OWNER_REVIEW_SPAN)),
});

/** The owner's review hiding `proposalId` (a private record this person may not see) and showing the rest. */
const hidingReview = (proposalId: string): (typeof AgentProposalQueueModuleReview)['Service'] => ({
  review: (input) =>
    Effect.succeed({
      items: input.subjects.map((subject) => ({ key: subject.key, visible: subject.key !== proposalId })),
      state: 'ok' as const,
    }),
});

/**
 * Opens the case's runtime database as stage's Shell opens it: over the process-shared pool registry
 * (`ONTOS_DATABASE_POOL_SHARED=true`), capped at stage's six connections, every checkout recorded as a lease span.
 */
const sharedPoolDatabase = Effect.fn('test.sharedPoolDatabase')(function* sharedPoolDatabase(
  runtime: DatabaseConnectionPair['runtime'],
) {
  const registry = Context.get(
    yield* Layer.build(DatabasePoolRegistryLive.pipe(Layer.provide(Reactivity.layer))),
    DatabasePools,
  );
  return yield* makeCoreDatabase({ ...runtime, maxConnections: 10 }).pipe(
    Effect.provideService(DatabasePools, recordingPoolRegistry(registry)),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '6', ONTOS_DATABASE_POOL_SHARED: 'true' }),
    ),
  );
});

const shellLayer = (input: {
  readonly authorityCalls: Ref.Ref<readonly AuthorityCall[]>;
  readonly runtime: DatabaseConnectionPair['runtime'];
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}) =>
  Layer.unwrap(
    Effect.gen(function* buildShell() {
      const database = yield* sharedPoolDatabase(input.runtime);
      const configuration = yield* loadSpiceDbConfig();
      const rpc = yield* Effect.acquireRelease(
        Effect.sync(() => spiceDbTransport.open(configuration, SPICEDB_CHECK_TIMEOUT_MS)),
        (opened) => Effect.sync(() => opened.close()),
      );
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
        input.snapshot,
      );
      const composition = ActiveApplicationCompositionConfigLive.pipe(
        Layer.provide(
          Layer.succeed(ActiveApplicationCompositionSource, {
            load: Effect.succeed(encoded).pipe(Effect.withSpan('Stub.compositionSourceLoad')),
          }),
        ),
      );
      const base = Layer.mergeAll(
        Layer.succeed(CoreDatabase, database),
        makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT),
        NodeServices.layer,
        NodeCrypto.layer,
      );
      const ports = Layer.mergeAll(
        AccessIntentLive.pipe(Layer.provide(TenantIntentLoaderLive)),
        AccessDecisionLogLive,
        AccessDecisionLogBatchLive,
        AccessPrincipalKindSourceLive,
        LegalEntityCandidatesLive,
        Layer.succeed(DecisionCheck, enginePortOf(rpc)),
        composition,
      ).pipe(Layer.provideMerge(base));
      const gate = AccessDecisionLive.pipe(Layer.provideMerge(ports));
      const authority = recordedAuthority(input.authorityCalls).pipe(
        Layer.provide(ActionAuthorityLive.pipe(Layer.provide(gate))),
        Layer.provideMerge(gate),
      );
      const contextAccess = Layer.mergeAll(
        Layer.effect(ContextAccess, makeContextAccessLive(spannedSpiceDb('contextAccess'))),
        StaffAuthenticationNamespaceRegistryLive,
      );
      const moduleStates = TenantModuleStateServiceLive.pipe(Layer.provide(base));
      const moduleStateGate = ModuleStateGateLive.pipe(Layer.provide(moduleStates));
      const entrypointGateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGate));
      const scopeResolver = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(contextAccess, authority)));
      const shared = Layer.mergeAll(contextAccess, moduleStates, moduleStateGate, entrypointGateway, scopeResolver);
      const readRuntime = ReadRuntimeLive.pipe(Layer.provide(Layer.mergeAll(shared, authority)));
      const preparation = AgentProposalCommandPreparationLive.pipe(
        Layer.provide(Layer.mergeAll(contextAccess, authority)),
      );
      const actionRuntime = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
        Layer.provide(
          Layer.mergeAll(
            shared,
            InstalledModuleCatalogServiceLive.pipe(Layer.provide(composition)),
            ActionRepositoryLive.pipe(Layer.provide(base)),
            Layer.effect(ActionPermission, makeActionPermissionLive(spannedSpiceDb('actionPermission'))),
            AgentProposalCommandAuthorizationPreflightLive.pipe(Layer.provide(preparation)),
          ).pipe(Layer.provideMerge(authority)),
        ),
      );
      // The Shell's People branch of `/shell/search` (api/index.ts): the system search over the one Read runtime and
      // the Core search index.
      const peopleSearch = ShellPeopleSystemSearchLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            readRuntime,
            PeopleSearchReadLive.pipe(Layer.provide(CoreSearchProjectionStoreLive.pipe(Layer.provide(base)))),
          ),
        ),
        Layer.provide(authority),
      );
      return Layer.mergeAll(
        readRuntime,
        actionRuntime,
        preparation,
        peopleSearch,
        visibleEverywhere,
        ShellInstalledModuleCatalogLive.pipe(Layer.provide(composition)),
        shared,
      ).pipe(Layer.provideMerge(authority));
    }),
  );

// ---------------------------------------------------------------------------------------------------------------
// The case: one cloned database, the N1 tenant, its owner, one agent who may propose work-tasks changes.
// ---------------------------------------------------------------------------------------------------------------

interface StageCase {
  readonly admin: PgClient.PgClient;
  readonly agent: string;
  readonly agentBinding: string;
  /** A person of the company with no role at all. */
  readonly bystander: string;
  readonly bystanderBinding: string;
  readonly companyId: string;
  readonly owner: string;
  readonly ownerBinding: string;
  readonly runtime: DatabaseConnectionPair['runtime'];
  readonly tenantId: string;
}

/**
 * An agent's cells over everything for `moduleKey`: `propose` where a capability admits it, `run` on its routine ones.
 * An agent may never hold `run` on a sensitive capability.
 */
const agentCellsOf = (catalog: typeof AccessCatalogModulesSchema.Type, moduleKey: string) =>
  catalog
    .flatMap(({ descriptors }) => descriptors.map(({ accessDeclaration }) => accessDeclaration))
    .flatMap((declaration) => {
      if (declaration === undefined || !declaration.key.startsWith(`${moduleKey}.`)) {
        return [];
      }
      if (declaration.modes.includes('propose')) {
        return [{ capabilityKey: declaration.key, mode: 'propose', selector: { _tag: 'all' } }];
      }
      return declaration.risk !== 'sensitive' && declaration.modes.includes('run')
        ? [{ capabilityKey: declaration.key, mode: 'run', selector: { _tag: 'all' } }]
        : [];
    });

/** A signed-in staff session's trusted principal. */
const sessionPrincipal = (input: {
  readonly bindingId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId: input.bindingId,
    authContextRef: `session:agent-approval:${input.principalId}`,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId: input.legalEntityId,
    principalId: input.principalId,
    tenantId: input.tenantId,
  }).pipe(Effect.orDie);

const seedTenant = Effect.fn('test.seedTenant')(function* seedTenant(
  admin: PgClient.PgClient,
  runtimeUrl: string,
  ids: {
    readonly agent: string;
    readonly agentBinding: string;
    readonly bystander: string;
    readonly bystanderBinding: string;
    readonly companyId: string;
    readonly owner: string;
    readonly ownerBinding: string;
    readonly tenantId: string;
  },
) {
  const crypto = yield* Crypto.Crypto;
  const { agent, agentBinding, bystander, bystanderBinding, companyId, owner, ownerBinding, tenantId } = ids;
  const configuration = yield* loadSpiceDbConfig();
  yield* Effect.acquireUseRelease(
    Effect.sync(() => newSpiceDbGrpcClient(configuration)),
    (client) =>
      Effect.tryPromise(
        async () => await client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      ),
    (client) => Effect.sync(() => client.close()),
  );
  const catalog = yield* publishedCatalog;
  yield* admin.unsafe(
    `insert into core.tenants (tenant_id, slug, name, status, default_locale)
     values ('${tenantId}', 'n1-${tenantId.slice(0, 8)}', 'N1 demo tenant', 'active', 'cs')`,
  );
  yield* admin.unsafe(
    `insert into core.legal_entities
       (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
     values ('${companyId}', '${tenantId}', 'N1 company', 'CZ', '${companyId.slice(-8)}', 'active')`,
  );
  for (const [principalId, kind, name] of [
    [owner, 'human', 'N1 owner'],
    [agent, 'agent', 'N1 agent'],
    [bystander, 'human', 'N1 bystander'],
  ] as const) {
    yield* admin.unsafe(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
       values ('${principalId}', '${tenantId}', '${kind}', '${name}', 'active')`,
    );
    yield* admin.unsafe(
      `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, status)
       values ('${tenantId}', '${companyId}', '${principalId}', 'active')`,
    );
  }
  for (const [principalId, bindingId] of [
    [owner, ownerBinding],
    [agent, agentBinding],
    [bystander, bystanderBinding],
  ] as const) {
    yield* admin.unsafe(
      `insert into core.principal_auth_bindings
         (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type,
          provider_subject_id, status)
       values ('${bindingId}', '${tenantId}', '${principalId}', '${STAFF_AUTHENTICATION_NAMESPACE_ID}', 'better-auth',
               'user', '${bindingId}', 'active')`,
    );
  }
  for (const { moduleId: moduleKey } of catalog) {
    yield* admin.unsafe(
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state)
       values (gen_random_uuid(), '${tenantId}', '${moduleKey}', 'active')`,
    );
  }
  const graph = yield* buildAccessGraph({ adminUrl: runtimeUrl, configuration });
  const ownerScope = {
    ...(yield* sessionPrincipal({ bindingId: ownerBinding, legalEntityId: companyId, principalId: owner, tenantId })),
    correlationId: 'agent-approval-seed',
  };
  const { legalEntityId: _company, ...tenantOwnerScope } = ownerScope;
  const bootstrap = yield* graph.bootstrap.bootstrapTenantAccess({
    legalEntityIds: [LegalEntityIdSchema.make(companyId)],
    modules: catalog,
    scope: tenantOwnerScope,
  });
  const scopeIds = yield* admin.unsafe<{ readonly legal_entity_id: string | null; readonly scope_id: string }>(
    `select scope_id, legal_entity_id from core.access_scopes where tenant_id = '${tenantId}'`,
  );
  for (const { scope_id: scopeId } of scopeIds) {
    yield* admin.unsafe(
      `insert into core.access_memberships
         (membership_id, tenant_id, scope_id, agent_id, kind, status, valid_from, recorded_by)
       values (gen_random_uuid(), '${tenantId}', '${scopeId}', '${agent}', 'member', 'active',
               now() - interval '1 day', '${owner}')`,
    );
    yield* admin.unsafe(
      `insert into core.access_memberships
         (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by)
       values (gen_random_uuid(), '${tenantId}', '${scopeId}', '${bystander}', 'member', 'active',
               now() - interval '1 day', '${owner}')`,
    );
  }
  // The agent's role: every `run` capability of work tasks in the company, so it may propose their changes.
  const companyScopeId = scopeIds.find(({ legal_entity_id: scoped }) => scoped === companyId)?.scope_id;
  const cells = agentCellsOf(catalog, TASKS_MODULE);
  const roleId = yield* crypto.randomUUIDv4();
  const roleRevisionId = yield* crypto.randomUUIDv4();
  yield* admin.unsafe(
    `insert into core.access_roles (role_id, tenant_id, created_by, name)
     values ('${roleId}', '${tenantId}', '${owner}', 'Agent work tasks')`,
  );
  yield* admin.unsafe(
    `insert into core.access_role_revisions
       (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
     values ('${roleRevisionId}', '${tenantId}', '${roleId}', 1, '${bootstrap.catalogSnapshotId}',
             '${jsonText(cells)}'::jsonb, '${owner}', 'manual')`,
  );
  for (const cell of cells) {
    yield* admin.unsafe(
      `insert into core.access_grant_incarnations
         (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
       values (gen_random_uuid(), '${tenantId}', '${companyScopeId}', '${roleId}', '${cell.capabilityKey}',
               '${cell.mode}', 'all', '${jsonText(cell)}'::jsonb, 'active')`,
    );
  }
  yield* admin.unsafe(
    `insert into core.access_assignments
       (incarnation_id, tenant_id, scope_id, agent_id, role_id, role_revision_id, status, assigned_by, valid_from)
     values (gen_random_uuid(), '${tenantId}', '${companyScopeId}', '${agent}', '${roleId}',
             '${roleRevisionId}', 'active', '${owner}', now() - interval '1 day')`,
  );
  // Stage's N1 tenant: its six modules plus Core's own (`installedModuleKeysOf`: every tenant installs `core.*`),
  // then the graph projected through the one Core writer.
  yield* admin.unsafe(`delete from core.tenant_module_states where tenant_id = '${tenantId}'`);
  const coreModules = catalog.flatMap(({ moduleId }) => (moduleId.startsWith('core.') ? [moduleId] : []));
  for (const moduleKey of [...N1_MODULES, ...coreModules]) {
    yield* admin.unsafe(
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state)
       values (gen_random_uuid(), '${tenantId}', '${moduleKey}', 'active')`,
    );
  }
  yield* graph.writer.reconcileTenant({ scope: tenantOwnerScope });
});

const withStageCase = <A, E, R>(run: (stageCase: StageCase) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* stageCase() {
      const crypto = yield* Crypto.Crypto;
      const server = yield* loadDatabaseConnectionPair();
      const caseDatabase = `agent_approval_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
      const serverAdmin = yield* makeTestPgClient(server.admin.connectionString, { maxConnections: 1 });
      yield* serverAdmin.unsafe(`create database "${caseDatabase}" template "${TEMPLATE_DATABASE}"`);
      yield* Effect.addFinalizer(() =>
        serverAdmin.unsafe(`drop database if exists "${caseDatabase}" with (force)`).pipe(Effect.orDie),
      );
      const databases = yield* parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: replacedDatabase(server.admin.connectionString, caseDatabase),
        DATABASE_URL: replacedDatabase(server.runtime.connectionString, caseDatabase),
      });
      const admin = yield* makeTestPgClient(databases.admin.connectionString, { maxConnections: 2 });
      // The template grants Core's tables only; a deployment also lets its Action runner take the access scope fence
      // (`trustRoutinesForIdentities`), which every protected Action does inside its transaction.
      yield* admin.unsafe('grant usage on schema trust to ontos_runtime');
      yield* admin.unsafe('grant execute on function trust.lock_access_scope_fence(uuid, uuid) to ontos_runtime');
      const ids = {
        agent: yield* crypto.randomUUIDv4(),
        agentBinding: yield* crypto.randomUUIDv4(),
        bystander: yield* crypto.randomUUIDv4(),
        bystanderBinding: yield* crypto.randomUUIDv4(),
        companyId: yield* crypto.randomUUIDv4(),
        owner: yield* crypto.randomUUIDv4(),
        ownerBinding: yield* crypto.randomUUIDv4(),
        tenantId: yield* crypto.randomUUIDv4(),
      };
      yield* seedTenant(admin, databases.runtime.connectionString, ids);
      return yield* run({ ...ids, admin, runtime: databases.runtime });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

// ---------------------------------------------------------------------------------------------------------------
// One measured step: wall time, statements by (verb, table), transactions, SpiceDB calls, rows written, authority.
// ---------------------------------------------------------------------------------------------------------------

/** Literal values become `?`, whitespace one space: the statement's fingerprint, never its data. */
const fingerprintOf = (text: string) =>
  text
    .replaceAll(/'(?:[^']|'')*'/gu, '?')
    .replaceAll(/\$\d+/gu, '$')
    .replaceAll(/\b\d+(?:\.\d+)?\b/gu, '?')
    .replaceAll('"', '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .toLowerCase();

/** Where a statement names its table, in order: a write's target, then a read's first source, then a called function. */
const TABLE_PATTERNS = [
  /^insert into (?<table>[\w.]+)/u,
  /^update (?<table>[\w.]+)/u,
  /^delete from (?<table>[\w.]+)/u,
  / from (?<table>[\w.]+)/u,
  /^select (?<table>[\w.]+)\(/u,
];

/** The statement's verb and the first table it names. */
const verbTableOf = (text: string) => {
  const fingerprint = fingerprintOf(text);
  const verb = fingerprint.split(' ', 1)[0] ?? '-';
  const table = TABLE_PATTERNS.map((pattern) => pattern.exec(fingerprint)?.groups?.['table']).find(
    (name) => name !== undefined,
  );
  return { table: table ?? '-', verb };
};

/** Row counts of every plain table of the case database: before and after a step, the rows it inserted or deleted. */
const tableCounts = Effect.fn('test.tableCounts')(function* tableCounts(admin: PgClient.PgClient) {
  const tables = yield* admin.unsafe<{ readonly name: string }>(
    `select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_%'`,
  );
  const counts = yield* admin.unsafe<{ readonly name: string; readonly rows: number }>(
    tables.map(({ name }) => `select '${name}' as name, count(*)::int as rows from ${name}`).join(' union all '),
  );
  return new Map(counts.map(({ name, rows }) => [name, rows] as const));
});

const changedRows = (before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>) =>
  Object.fromEntries(
    [...after].flatMap(([name, rows]) => {
      const delta = rows - (before.get(name) ?? 0);
      return delta === 0 ? [] : [[name, delta] as const];
    }),
  );

interface Grouped {
  count: number;
  ms: number;
}

const grouped = <Key extends string>(entries: readonly { readonly key: Key; readonly ms: number }[]) => {
  const groups = new Map<Key, Grouped>();
  for (const { key, ms } of entries) {
    const entry = groups.get(key) ?? { count: 0, ms: 0 };
    groups.set(key, { count: entry.count + 1, ms: entry.ms + ms });
  }
  return [...groups]
    .toSorted(([, left], [, right]) => right.ms - left.ms)
    .map(([key, { count, ms }]) => ({ count, key, ms: Math.round(ms * 10) / 10 }));
};

const stepReport = (input: {
  readonly authority: readonly AuthorityCall[];
  readonly evidenceRows: number;
  readonly label: string;
  readonly records: readonly SpanRecord[];
  readonly rowsWritten: Readonly<Record<string, number>>;
}) => {
  const { records } = input;
  const statements = records.filter(({ sql }) => sql !== undefined);
  const spicedb = records.filter(({ name }) => SPICEDB_SPANS.has(name));
  const fingerprints = grouped(statements.map(({ ms, sql }) => ({ key: fingerprintOf(sql ?? ''), ms })));
  return {
    authority: {
      calls: input.authority.length,
      keysPerCall: input.authority.map(({ keys }) => keys),
      ms: Math.round(input.authority.reduce((sum, { ms }) => sum + ms, 0)),
    },
    compositionLoads: records.filter(({ name }) => name === 'Stub.compositionSourceLoad').length,
    evidenceRows: input.evidenceRows,
    fingerprints: fingerprints.map(({ count, key }) => ({ count, statement: key })),
    label: input.label,
    ms: Math.round(records.find(({ name }) => name === 'measured.step')?.ms ?? -1),
    ownerReviewStubCalls: records.filter(({ name }) => name === OWNER_REVIEW_SPAN).length,
    pool: leaseReport(records),
    // Identical statement fingerprints run more than once in this step, literals stripped.
    repeated: fingerprints
      .filter(({ count, key }) => count > 1 && key.startsWith('select'))
      .map(({ count, key, ms }) => ({ count, ms, statement: key.slice(0, 220), ...verbTableOf(key) })),
    rowsWritten: input.rowsWritten,
    spicedb: { calls: spicedb.length, ms: Math.round(spicedb.reduce((sum, { ms }) => sum + ms, 0)) },
    statementGroups: grouped(
      statements.map(({ ms, sql }) => {
        const { table, verb } = verbTableOf(sql ?? '');
        return { key: `${verb} ${table}`, ms };
      }),
    ),
    statements: statements.length,
    topSpans: grouped(
      records.filter(({ name }) => name !== 'measured.step').map(({ ms, name }) => ({ key: name, ms })),
    ).slice(0, 12),
    transactions: records.filter(({ name }) => name === 'sql.transaction').length,
  };
};

type StepReport = ReturnType<typeof stepReport>;

const measureStep = <A, E, R>(input: {
  readonly admin: PgClient.PgClient;
  readonly authorityCalls: Ref.Ref<readonly AuthorityCall[]>;
  readonly correlationId: string;
  readonly label: string;
  readonly step: Effect.Effect<A, E, R>;
}) =>
  Effect.gen(function* measureOneStep() {
    const before = yield* tableCounts(input.admin);
    yield* Ref.set(input.authorityCalls, []);
    const records: SpanRecord[] = [];
    const value = yield* input.step.pipe(Effect.withSpan('measured.step'), Effect.withTracer(recordingTracer(records)));
    const after = yield* tableCounts(input.admin);
    const [evidence] = yield* input.admin.unsafe<{ readonly count: number }>(
      `select count(*)::int as count from core.access_decision_logs where correlation_id = '${input.correlationId}'`,
    );
    return {
      report: stepReport({
        authority: yield* Ref.get(input.authorityCalls),
        evidenceRows: evidence?.count ?? -1,
        label: input.label,
        records,
        rowsWritten: changedRows(before, after),
      }),
      value,
    };
  });

/** Statement fingerprints that more than one step of one route ran, with each step's count. */
const acrossSteps = (steps: readonly StepReport[]) => {
  const seen = new Map<string, Record<string, number>>();
  for (const step of steps) {
    for (const { count, statement } of step.fingerprints) {
      seen.set(statement, { ...seen.get(statement), [step.label]: count });
    }
  }
  return [...seen].flatMap(([statement, counts]) =>
    Object.keys(counts).length > 1 && statement.startsWith('select')
      ? [{ counts, statement: statement.slice(0, 220), ...verbTableOf(statement) }]
      : [],
  );
};

// ---------------------------------------------------------------------------------------------------------------

/** A Core Read's transport: the request correlation, nothing else. */
const readTransport = (correlationId: string) => ({ correlationId });

/** A value the test itself produced; its absence is a defect of the test. */
const present = <A>(value: A | undefined) =>
  value === undefined ? Effect.die('A seeded value is missing') : Effect.succeed(value);

/**
 * One pending batch of one work-tasks proposal, with the columns the Core insert writes. Its proposer is the owner's own
 * approval connection (an AI client connected as the person): the gate refuses an `agent` principal outright
 * (`resolveGateActor`, deny.agent_forbidden), so an approval claim, which re-asks the proposer's `propose` right, only
 * succeeds for a human proposer.
 */
const seedPendingBatch = Effect.fn('test.seedPendingBatch')(function* seedPendingBatch(
  stageCase: StageCase,
  name: string,
) {
  const crypto = yield* Crypto.Crypto;
  const batchId = yield* crypto.randomUUIDv4();
  const proposalId = yield* crypto.randomUUIDv4();
  const title = `Task ${name}`;
  yield* stageCase.admin.unsafe(
    `insert into core.agent_proposals
       (proposal_id, tenant_id, legal_entity_id, batch_id, batch_instruction, position, agent_principal_id, agent_label,
        app_id, module_key, action_slug, command_json, reference_audiences_json, summary, target_label, reason, risk,
        diff_json, status)
     values ('${proposalId}', '${stageCase.tenantId}', '${stageCase.companyId}', '${batchId}', 'Measured ${name} batch',
             0, '${stageCase.owner}', 'N1 agent', '${TASKS_APP}', '${TASKS_MODULE}', '${TASKS_SLUG}',
             '${jsonText({ _tag: 'CreateTask', title })}'::jsonb, '[]'::jsonb, 'Create ${title}', '${title}',
             'Measured proposal', 'low', '${jsonText([{ after: title, field: 'title', label: 'Název' }])}'::jsonb,
             'pending')`,
  );
  return { batchId, proposalId };
});

/** The sum of one count over the steps of a route. */
const totalOf = (
  steps: readonly { readonly evidenceRows: number; readonly statements: number; readonly transactions: number }[],
  count: 'evidenceRows' | 'statements' | 'transactions',
) => steps.reduce((sum, step) => sum + step[count], 0);

const measureApprovalPath = Effect.fn('test.measureApprovalPath')(function* measureApprovalPath(stageCase: StageCase) {
  const crypto = yield* Crypto.Crypto;
  const snapshot = yield* installedComposition;
  const authorityCalls = yield* Ref.make<readonly AuthorityCall[]>([]);
  // The active composition's authority row, as the release publisher writes it: owner writes are admitted against it.
  yield* stageCase.admin.unsafe(
    `insert into core.application_composition_authority (authority_key, revision, phase, valid_until, subscriptions_json)
     values ('active', '${snapshot.composition.revision}', 'active', now() + interval '1 day', '[]'::jsonb)
     on conflict (authority_key) do update set revision = excluded.revision, phase = 'active',
       valid_until = excluded.valid_until`,
  );
  const context = yield* Layer.build(shellLayer({ authorityCalls, runtime: stageCase.runtime, snapshot }));
  const { admin, agent, companyId, owner, ownerBinding, tenantId } = stageCase;
  const ownerPrincipal = yield* sessionPrincipal({
    bindingId: ownerBinding,
    legalEntityId: companyId,
    principalId: owner,
    tenantId,
  });
  const inShell = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideContext(context));
  /** The session caller as the Shell resolves it at ingress: its scope from the real resolver. */
  const callerFor = (correlationId: string) =>
    inShell(
      Effect.gen(function* resolveCaller() {
        const scope = yield* (yield* OperationalScopeResolver).resolve({
          correlationId,
          legalEntityScope: 'required',
          principal: ownerPrincipal,
        });
        return {
          legalName: 'N1 company',
          principal: { ...ownerPrincipal, legalEntityId: companyId },
          scope,
        } satisfies AgentPlatformCaller;
      }),
    );
  const measure = <A, E, R>(label: string, correlationId: string, step: Effect.Effect<A, E, R>) =>
    measureStep({ admin, authorityCalls, correlationId, label, step: inShell(step) });
  const actionTransport = (correlationId: string) =>
    crypto.randomUUIDv4().pipe(Effect.map((key) => ({ correlationId, idempotencyKey: `measure-${key}` })));

  // Three pending batches of one work-tasks proposal each, inserted as the Core submit Action writes them
  // (`proposalCommandsFromTransaction` insert). The submit itself (an OAuth approval connection) is not measured.
  const batches = yield* Effect.forEach(['warm-up', 'reject', 'approve'], (name) => seedPendingBatch(stageCase, name), {
    concurrency: 1,
  });
  const [warmUp, rejected, approved] = yield* Effect.all([
    present(batches[0]),
    present(batches[1]),
    present(batches[2]),
  ]);

  // Warm-up, measured as the first use in this process (pools, the SpiceDB channel, the composition cache and code
  // never run before): the queue's three reads once, then one reject (its batch read and the reject Action).
  const warm = yield* callerFor('warm-up');
  const coldQueue = yield* measure(
    'cold queue',
    'warm-up',
    Effect.all([
      callerModuleAccess(warm),
      principalNames(warm.principal, readTransport('warm-up')),
      listCompanyProposalPage(warm.principal, {}),
    ]).pipe(Effect.provideService(AgentReadRequestIdentity, readTransport('warm-up'))),
  );
  const warmReject = yield* actionTransport('warm-up-reject');
  const coldReject = yield* measure(
    'cold reject',
    'warm-up-reject',
    loadBatchProposals(warm.principal, warmUp.batchId).pipe(
      Effect.andThen(markRejected(warm.principal, { batchId: warmUp.batchId, proposalId: warmUp.proposalId })),
      Effect.provideService(AgentReadRequestIdentity, warmReject),
      Effect.provideService(AgentActionRequestIdentity, warmReject),
    ),
  );

  // Queue (`loadAgentQueue`): Q1 caller authority, Q2 principal names, Q3 the proposal page.
  const q1Caller = yield* callerFor('q1-caller-access');
  const q1 = yield* measure('Q1 callerModuleAccess', 'q1-caller-access', callerModuleAccess(q1Caller));
  const q2Caller = yield* callerFor('q2-principal-names');
  const q2 = yield* measure(
    'Q2 principalNames',
    'q2-principal-names',
    principalNames(q2Caller.principal, readTransport('q2-principal-names')),
  );
  const q3Caller = yield* callerFor('q3-proposal-page');
  const q3 = yield* measure(
    'Q3 listCompanyProposalPage',
    'q3-proposal-page',
    listCompanyProposalPage(q3Caller.principal, {}).pipe(
      Effect.provideService(AgentReadRequestIdentity, readTransport('q3-proposal-page')),
    ),
  );
  // The queue route's own shape (`loadAgentQueue`): the caller's authority, then names and the page side by side.
  const queueCaller = yield* callerFor('q-route');
  const queueRoute = yield* measure(
    'Q loadAgentQueue reads',
    'q-route',
    callerModuleAccess(queueCaller).pipe(
      Effect.andThen(
        Effect.all(
          [
            principalNames(queueCaller.principal, readTransport('q-route')),
            listCompanyProposalPage(queueCaller.principal, {}),
          ],
          { concurrency: 3 },
        ),
      ),
      Effect.provideService(AgentReadRequestIdentity, readTransport('q-route')),
    ),
  );
  expect(q1.value.write.has(TASKS_MODULE)).toBe(true);
  expect(q2.value.get(agent)).toBe('N1 agent');
  expect(q3.value.proposals.some((row) => row.batchId === rejected.batchId)).toBe(true);

  // A person of the company without any right reads no proposal: the read is refused before a row is loaded.
  const bystanderPrincipal = yield* sessionPrincipal({
    bindingId: stageCase.bystanderBinding,
    legalEntityId: companyId,
    principalId: stageCase.bystander,
    tenantId,
  });
  const refused = yield* inShell(
    listCompanyProposalPage(bystanderPrincipal, {}).pipe(
      Effect.provideService(AgentReadRequestIdentity, readTransport('no-rights')),
      Effect.flip,
    ),
  );
  expect(Predicate.isTagged(refused, 'ReadPermissionDenied')).toBe(true);

  // A proposal the module owner's review hides stays hidden, even from the owner who may run its Action.
  const hidden = yield* inShell(
    listCompanyProposalPage(ownerPrincipal, {}).pipe(
      Effect.provideService(AgentProposalQueueModuleReview, hidingReview(rejected.proposalId)),
      Effect.provideService(AgentReadRequestIdentity, readTransport('hidden-by-review')),
    ),
  );
  expect(hidden.proposals.some((row) => row.proposalId === rejected.proposalId)).toBe(false);
  expect(hidden.proposals.some((row) => row.batchId === approved.batchId)).toBe(true);

  // Decide (reject): D1 the exact batch read, D2 the reject Core Action.
  const decideCaller = yield* callerFor('d1-batch');
  const d1 = yield* measure(
    'D1 loadBatchProposals',
    'd1-batch',
    loadBatchProposals(decideCaller.principal, rejected.batchId).pipe(
      Effect.provideService(AgentReadRequestIdentity, readTransport('d1-batch')),
    ),
  );
  expect(d1.value.map((row) => row.status)).toEqual(['pending']);
  const rejectTransport = yield* actionTransport('d2-reject');
  const d2 = yield* measure(
    'D2 markRejected',
    'd2-reject',
    markRejected(decideCaller.principal, { batchId: rejected.batchId, proposalId: rejected.proposalId }).pipe(
      Effect.provideService(AgentReadRequestIdentity, rejectTransport),
      Effect.provideService(AgentActionRequestIdentity, rejectTransport),
    ),
  );
  expect(d2.value.affectedProposalIds).toEqual([rejected.proposalId]);

  // Approve, Core parts only (`approveCoreRow`); the owner apply between claim and mark-applied is skipped.
  const approveCaller = yield* callerFor('a-approve');
  const approveTransport = yield* actionTransport('a-approve');
  const withApproveTransport = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(AgentReadRequestIdentity, approveTransport),
      Effect.provideService(AgentActionRequestIdentity, approveTransport),
    );
  const a1 = yield* measure(
    'A1 claimForApproval',
    'a-approve',
    withApproveTransport(
      claimForApproval(approveCaller.principal, {
        batchId: approved.batchId,
        proposalId: approved.proposalId,
      }),
    ),
  );
  expect(a1.value.affectedProposalIds).toEqual([approved.proposalId]);
  const reservationId = yield* present(a1.value.reservationId);
  const a2 = yield* measure(
    'A2 requireCurrentProposalClaim',
    'a-approve',
    withApproveTransport(requireCurrentProposalClaim(approveCaller.principal, a1.value, 'claim-approval')),
  );
  const a3 = yield* measure(
    'A3 markApplied',
    'a-approve',
    withApproveTransport(
      markApplied(approveCaller.principal, {
        applyResult: { taskId: approved.proposalId },
        batchId: approved.batchId,
        proposalId: approved.proposalId,
        reservationId,
        revert: { kind: 'none', reason: 'Measurement' },
      }),
    ),
  );
  expect(a3.value.affectedProposalIds).toEqual([approved.proposalId]);
  const a4 = yield* measure(
    'A4 loadProposalBatch',
    'a-approve',
    withApproveTransport(loadProposalBatch(approveCaller.principal, approved.batchId)),
  );
  expect(a4.value.proposals.map((row) => row.status)).toEqual(['applied']);
  expect(a2.value.reservations?.length ?? 0).toBeGreaterThan(0);

  const queue = [q1.report, q2.report, q3.report];
  const decide = [d1.report, d2.report];
  const approve = [a1.report, a2.report, a3.report, a4.report];
  const path = yield* reportPath;
  if (Option.isSome(path)) {
    yield* (yield* FileSystem.FileSystem).writeFileString(
      `${path.value}.agent-approval.json`,
      yield* encodeReport({
        acrossSteps: {
          approve: acrossSteps(approve),
          decide: acrossSteps(decide),
          queue: acrossSteps(queue),
        },
        cold: [coldQueue.report, coldReject.report].map(({ fingerprints: _fingerprints, ...step }) => step),
        steps: [...queue, queueRoute.report, ...decide, ...approve].map(
          ({ fingerprints: _fingerprints, ...step }) => step,
        ),
      }),
    );
  }
  // The counts are written first, so a run that breaks a bound still leaves its numbers.
  // Scope setup now reads the connected role before installing scope. Only that one extra query per transaction
  // is allowed above the old budgets; extra owner, authorization or evidence queries still break the fence.
  const statementsPerScope = 2;
  const previousStatementsPerScope = 1;
  const scopeSetupIncrease = (transactions: number) =>
    transactions * (statementsPerScope - previousStatementsPerScope);
  expect([totalOf(queue, 'transactions'), totalOf(decide, 'transactions'), totalOf(approve, 'transactions')]).toEqual([
    38, 50, 105,
  ]);
  const installed = yield* inShell(
    Effect.gen(function* admittedCatalog() {
      return yield* (yield* ShellInstalledModuleCatalog).load;
    }),
  );
  const admittedModule = (moduleId: string) => moduleId.startsWith('core.') || N1_MODULES.includes(moduleId);
  // The owner is allowed in run mode. Routine allows leave no row; a mode refusal still does.
  const leavesEvidence = (declaration: ModuleCarrier['declaration']) =>
    declaration !== undefined && (declaration.risk !== 'routine' || !declaration.modes.includes('run'));
  const carrierRows = moduleCarriers(installed).filter(
    ({ declaration, moduleId }) => admittedModule(moduleId) && leavesEvidence(declaration),
  ).length;
  const actionRows = installed.contracts.flatMap(({ manifest }) =>
    manifest.publicSurface.actions.filter(
      (action) =>
        admittedModule(action.owningModuleId) &&
        action.legalEntityScope !== 'forbidden' &&
        leavesEvidence(action.accessDeclaration),
    ),
  ).length;
  // Q1 asks each carrier and each Action; Q3 asks the Actions again. Q2 is authenticated-only.
  // The merge adds six Customer Context Actions and Party's legacy-IČO fence: 7 × 3 = 21 extra rows.
  expect(totalOf(queue, 'evidenceRows')).toBe(carrierRows + 2 * actionRows);
  expect(totalOf(queue, 'statements')).toBeLessThanOrEqual(184 + scopeSetupIncrease(38));
  expect(totalOf(decide, 'statements')).toBeLessThanOrEqual(220 + scopeSetupIncrease(50));
  expect(totalOf(approve, 'statements')).toBeLessThanOrEqual(463 + scopeSetupIncrease(105));
  // Every step checks a connection out only for its statements: none is held while the request waits on SpiceDB, a
  // module owner or the composition source, and no request holds more than two at once (the gate reads two scopes of
  // a batch side by side, never more), so six connections queue only behind other requests.
  for (const step of [...queue, ...decide, ...approve]) {
    expect({ held: step.pool.heldAcrossRemoteCalls, label: step.label }).toEqual({ held: [], label: step.label });
    expect(step.pool.maxConcurrent).toBeLessThanOrEqual(2);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// People search through the Shell (`/shell/search`, its People branch) for one surname, in a company of a few hundred.
// ---------------------------------------------------------------------------------------------------------------

const PEOPLE = 400;
const SURNAME = 'Zelenka';
const FIRST_NAMES = [
  'Adam',
  'Bára',
  'Cyril',
  'Dana',
  'Emil',
  'Fanda',
  'Gita',
  'Hana',
  'Ivan',
  'Jana',
  'Karel',
  'Lucie',
];
const SURNAMES = ['Novák', 'Svoboda', 'Dvořák', 'Černý', 'Procházka', 'Kučera', 'Veselý', 'Horák', 'Němec', 'Pokorný'];

/** Person `index`'s name: every hundredth is a Zelenka, the rest carry surnames that never match it. */
const personName = (index: number) =>
  `${FIRST_NAMES[index % FIRST_NAMES.length] ?? 'Ema'} ${
    index % 100 === 7 ? SURNAME : `${SURNAMES[index % SURNAMES.length] ?? 'Malý'} ${String(index)}`
  }`;

/**
 * `PEOPLE` active people of the company and their People index rows, written as the people projection writes them
 * (`buildPeopleSearchDocuments`, then the store's insert of each document).
 */
const seedPeople = Effect.fn('test.seedPeople')(function* seedPeople(stageCase: StageCase) {
  const crypto = yield* Crypto.Crypto;
  const { admin, companyId, tenantId } = stageCase;
  const people = yield* Effect.forEach(
    Array.from({ length: PEOPLE }, (_, index) => index),
    (index) =>
      crypto.randomUUIDv4().pipe(
        Effect.map((principalId) => ({
          displayName: personName(index),
          legalEntityId: companyId,
          principalId,
          tenantId,
        })),
      ),
  );
  yield* admin.unsafe(
    `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
     select (p->>'principalId')::uuid, '${tenantId}', 'human', p->>'displayName', 'active'
       from jsonb_array_elements($1::jsonb) p`,
    [jsonText(people)],
  );
  yield* admin.unsafe(
    `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, status)
     select '${tenantId}', '${companyId}', (p->>'principalId')::uuid, 'active' from jsonb_array_elements($1::jsonb) p`,
    [jsonText(people)],
  );
  const documents = yield* buildPeopleSearchDocuments({ people, projectionVersion: '1', tenantId });
  const rows = yield* Effect.forEach(
    documents,
    (document) =>
      Effect.fromResult(coreSearchDocumentBodyText(document)).pipe(
        Effect.map((bodyText) => ({
          bodyText,
          facets: coreSearchDocumentPayload(document),
          legalEntityId: document.selectedLegalEntityId ?? null,
          resourceId: document.ref.resourceId,
          searchFormatVersion: deriveCoreSearchRepresentation(document).searchFormatVersion,
          searchTextV1: deriveCoreSearchRepresentation(document).searchTextV1,
          title: document.title,
        })),
      ),
    { concurrency: 1 },
  );
  yield* admin.unsafe(
    `insert into core.search_index_entries
       (tenant_id, legal_entity_id, source_module_key, source_resource_type, source_resource_id, title, body_text,
        search_text_v1, search_format_version, search_source_version, deleted, facets_json, projection_version)
     select '${tenantId}', (r->>'legalEntityId')::uuid, 'core.identity', 'core.identity.person', r->>'resourceId',
            r->>'title', r->>'bodyText', r->>'searchTextV1', (r->>'searchFormatVersion')::int, 1, false, r->'facets', 1
       from jsonb_array_elements($1::jsonb) r`,
    [jsonText(rows)],
  );
  return people.filter(({ displayName }) => displayName.endsWith(SURNAME)).map(({ principalId }) => principalId);
});

const measurePeopleSearch = Effect.fn('test.measurePeopleSearch')(function* measurePeopleSearch(stageCase: StageCase) {
  const snapshot = yield* installedComposition;
  const authorityCalls = yield* Ref.make<readonly AuthorityCall[]>([]);
  yield* stageCase.admin.unsafe(
    `insert into core.application_composition_authority (authority_key, revision, phase, valid_until, subscriptions_json)
     values ('active', '${snapshot.composition.revision}', 'active', now() + interval '1 day', '[]'::jsonb)
     on conflict (authority_key) do update set revision = excluded.revision, phase = 'active',
       valid_until = excluded.valid_until`,
  );
  const zelenkas = yield* seedPeople(stageCase);
  const context = yield* Layer.build(shellLayer({ authorityCalls, runtime: stageCase.runtime, snapshot }));
  const { admin, companyId, owner, ownerBinding, tenantId } = stageCase;
  const ownerPrincipal = yield* sessionPrincipal({
    bindingId: ownerBinding,
    legalEntityId: companyId,
    principalId: owner,
    tenantId,
  });
  const inShell = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideContext(context));
  /** The Shell's People branch for one query, as `/shell/search` runs it once its own read is admitted. */
  const peopleBranch = (principal: typeof ownerPrincipal, correlationId: string, query: string) =>
    Effect.gen(function* searchPeople() {
      const scope = yield* (yield* OperationalScopeResolver).resolve({
        correlationId,
        legalEntityScope: 'required',
        principal,
      });
      const admission = yield* admitPeopleSystemSearch(scope, yield* AccessDecisionGate);
      return { admission, response: yield* (yield* ShellSystemSearch).search(scope, query) };
    });
  const measure = <A, E, R>(label: string, correlationId: string, step: Effect.Effect<A, E, R>) =>
    measureStep({ admin, authorityCalls, correlationId, label, step: inShell(step) });

  const cold = yield* measure(
    'cold people search',
    'people-cold',
    peopleBranch(ownerPrincipal, 'people-cold', 'Novák'),
  );
  const warm = yield* measure('people search', 'people-search', peopleBranch(ownerPrincipal, 'people-search', SURNAME));
  expect(cold.value.admission).toBe('allowed');
  expect(warm.value.admission).toBe('allowed');
  const found = warm.value.response.results.map(({ ref }) => ref.resourceId);
  expect(found.toSorted()).toEqual(zelenkas.map((principalId) => `${companyId}.${principalId}`).toSorted());
  expect(warm.value.response.results.every(({ title }) => title?.endsWith(SURNAME) === true)).toBe(true);
  expect(warm.value.response.partial).toBe(false);

  // A person of the company without the People list right finds nobody.
  const bystander = yield* sessionPrincipal({
    bindingId: stageCase.bystanderBinding,
    legalEntityId: companyId,
    principalId: stageCase.bystander,
    tenantId,
  });
  const refused = yield* measure(
    'people search without the right',
    'people-bystander',
    peopleBranch(bystander, 'people-bystander', SURNAME),
  );
  expect(refused.value.admission).toBe('denied');
  expect(refused.value.response.results).toEqual([]);

  // Many hits cost what few hits cost: no question is asked per person found.
  const many = yield* measure(
    'people search, 40 hits',
    'people-many',
    peopleBranch(ownerPrincipal, 'people-many', 'Novák'),
  );
  expect(many.value.response.results).toHaveLength(40);

  // Typing a surname without waiting: every keystroke from the second letter is its own search, all in flight at once.
  const burst = yield* measure(
    'six keystrokes at once',
    'people-burst',
    Effect.all(
      ['Ze', 'Zel', 'Zele', 'Zelen', 'Zelenk', SURNAME].map((query) =>
        peopleBranch(ownerPrincipal, 'people-burst', query),
      ),
      { concurrency: 'unbounded' },
    ),
  );
  expect(burst.value.map(({ response }) => response.results.length)).toEqual([4, 4, 4, 4, 4, 4]);

  const path = yield* reportPath;
  if (Option.isSome(path)) {
    yield* (yield* FileSystem.FileSystem).writeFileString(
      `${path.value}.people-search.json`,
      yield* encodeReport({
        steps: [cold.report, warm.report, many.report, refused.report, burst.report].map(
          ({ fingerprints: _fingerprints, ...step }) => step,
        ),
      }),
    );
  }
  // The counts are written first, so a run that breaks a bound still leaves its numbers. One People search for one
  // surname: three gate decisions (the Shell's admission, the read's list right, the People list right), each with
  // its own evidence row, two scope resolutions, the index query, the read and its evidence. Each of the 22 scoped
  // transactions adds only its connected-role query to the old 71 statements and 115 PostgreSQL messages.
  const scopedTransactions = 22;
  const additionalStatementsPerScope = 2 - 1;
  const connectedRoleQueries = scopedTransactions * additionalStatementsPerScope;
  expect(warm.report.pool.heldAcrossRemoteCalls).toEqual([]);
  expect(warm.report.pool.maxConcurrent).toBe(1);
  expect([warm.report.transactions, warm.report.spicedb.calls, warm.report.evidenceRows]).toEqual([22, 5, 3]);
  expect(warm.report.statements).toBeLessThanOrEqual(71 + connectedRoleQueries);
  expect(warm.report.pool.leases).toBeLessThanOrEqual(24);
  expect(warm.report.pool.roundTrips).toBeLessThanOrEqual(115 + connectedRoleQueries);
  // Ten times the hits, the same work: no question is asked, and no row read, per person found.
  expect([
    many.report.statements,
    many.report.transactions,
    many.report.spicedb.calls,
    many.report.pool.leases,
    many.report.evidenceRows,
  ]).toEqual([
    warm.report.statements,
    warm.report.transactions,
    warm.report.spicedb.calls,
    warm.report.pool.leases,
    warm.report.evidenceRows,
  ]);
  return warm.report;
});

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '900 seconds' })(
  'agent approval path in the shape of stage',
  (suite) => {
    suite.effect(
      'measures queue, reject and the Core parts of approve for the N1 owner, step by step',
      () =>
        withStageCase((stageCase) =>
          measureApprovalPath(stageCase).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
        ),
      900_000,
    );
    suite.effect(
      'measures the People branch of the Shell search for one surname in a company of a few hundred people',
      () =>
        withStageCase((stageCase) =>
          measurePeopleSearch(stageCase).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
        ),
      900_000,
    );
  },
);
