import { historicalOwnerContract, historicalOwnerReadTarget } from '../support/historical-owner-targets.ts';
import { remainingPermissionBaselines } from './owner-permission-baseline.ts';
import { fixtureOwnerContract, ownerPermissionTarget } from '../support/owner-permission-target.ts';
import type { ActiveApplicationCompositionServiceContract } from '../../src/modules/active-application-composition.ts';
import { bindingSubjectRead, resolveExternalSubjectRead } from '../../src/auth/external-identity/read.ts';
import { ExternalIdentityError } from '../../src/auth/external-identity-contracts.ts';
import { ActiveApplicationCompositionUnavailableError } from '../../src/modules/active-application-composition-errors.ts';
import { ModuleOperationRequirementError } from '../../src/modules/module-operation-requirement-error.ts';
import { requireModuleOperation } from '../../src/modules/module-operation-requirement.ts';
import type { ReadRuntimeOptions } from '../../src/reads/runtime.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import type { VerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../support/outbox-worker-composition.ts';
import {
  legalEntityDetailRead,
  LegalEntityDetailRequestSchema,
} from '../../src/generated-reads/legal-entity-detail.ts';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Predicate,
  Schema,
} from 'effect';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Reactivity } from 'effect/reactivity';
/* oxlint-disable sonarjs/use-type-alias, typescript/no-unsafe-type-assertion -- Existing compatibility boundary; expires: 2026-12-31. */
import { expect, it } from 'effect-rstest';
import {
  ConnectionError,
  ConstraintError,
  SqlError,
  SqlSyntaxError,
  UniqueViolation,
  UnknownError,
} from 'effect/sql/SqlError';

import { defineGlobalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import type { OwnerPermissionAccessTarget } from '../../src/permissions/context-access.ts';
import type {
  OwnerAuthorizationInput,
  OwnerAuthorizationOutcome,
  OwnerAuthorizationOverlayService,
} from '../../src/access/enforcement/owner-overlay.ts';
import { allowOwnerAuthorizationOverlay } from '../../src/access/enforcement/owner-overlay.ts';
import type { AccessPrincipalKind, AccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import {
  defineRead,
  defineReadOwnerPermission,
  defineReadConditionalPermission,
  defineReadResourcePermission,
} from '../../src/reads/definition.ts';
import type { ReadServiceFactory, ResolvedReadPermissionTarget } from '../../src/reads/definition.ts';
import type { ReadFinishContext, ReadLoadContext, ReadPrepareContext } from '../../src/reads/context.ts';
import {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPolicyDenied,
} from '../../src/reads/errors.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import { makeReadRuntime, READ_RUNTIME_STAGES } from '../../src/reads/runtime.ts';
import { makeTestDatabaseFromClient } from '../support/database.ts';
import { scriptedPgClientLayer, testSqlConnection } from '../../src/testing/scripted-pg-client.ts';
import {
  guardPoolAcquisition,
  OpenDatabaseTransaction,
  refuseInsideDatabaseTransaction,
} from '../../src/db/transaction-io-guard.ts';
import { coreRelations, tenants } from '../../src/db/schema.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';
import { fixtureReadAccess } from '../support/access-declaration-fixtures.ts';

const FixturePermissionCodeSchema = Schema.String;

const scope: OperationalScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:read-runtime',
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-000000000003',
    tenantId: '00000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'correlation-1',
});
const transactionOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-09-28T09:00:00.000Z')));
const approvedCompositionRevision = 'a'.repeat(64);
const installAndReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";
interface ReadAuthorityFixture {
  readonly phase: 'active' | 'draining' | 'sealed' | 'migrated';
  readonly revision: string;
  readonly unexpired: boolean;
}
const pricingCatalogId = '50000000-0000-4000-8000-000000000001';
const priceGroupId = '60000000-0000-4000-8000-000000000001';
const otherPriceGroupId = '60000000-0000-4000-8000-000000000002';
const EvidenceRowSchema = Schema.Struct({
  queryHash: Schema.optionalKey(Schema.String),
});
type EvidenceRow = Schema.Schema.Type<typeof EvidenceRowSchema>;
const ModuleIdSchema = Schema.String.pipe(Schema.brand('ModuleId'));
const ResourceIdSchema = Schema.String.pipe(Schema.brand('ResourceId'));
const RetailAuthorityProfileIdSchema = Schema.String.pipe(Schema.brand('RetailAuthorityProfileId'));
const RetailRequestedProfileIdSchema = Schema.String.pipe(Schema.brand('RetailRequestedProfileId'));
const CurrencyReadInputSchema = Schema.Struct({
  authorizationProfileId: RetailAuthorityProfileIdSchema,
  requestedProfileId: RetailRequestedProfileIdSchema,
});
type CurrencyReadInput = typeof CurrencyReadInputSchema.Type;
const ResourceTargetSchema = Schema.Struct({
  moduleId: ModuleIdSchema,
  resourceId: ResourceIdSchema,
  resourceType: Schema.String,
});
/** These local registrations are synthetic Core infrastructure probes, with no business-provider implementation. */
const historicalFixtureOwner = (moduleId: string) => {
  const base = makeModuleContractFixture({ appId: moduleId.replaceAll('.', '-'), moduleId }).manifest;
  const manifest = defineOntosModuleManifest({
    ...base,
    publicSurface: { ...base.publicSurface, actions: [], api: {}, components: {} },
  });
  return defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [] });
};

const makeHarness = Effect.fn(function* makeHarness(
  options: {
    readonly accessDecision?: BoundAccessGate;
    readonly applicationComposition?: ActiveApplicationCompositionServiceContract;
    readonly authorityEvents?: string[];
    readonly businessPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly compositionAuthority?: ReadAuthorityFixture | 'missing';
    readonly compositionIsolation?: 'read committed' | 'repeatable read';
    readonly contextPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly failEvidence?: boolean;
    readonly failTransactionTimestamp?: boolean;
    readonly legalEntityRows?: readonly {
      readonly legalName: string;
      readonly status: string;
      readonly welcome: string | null;
    }[];
    readonly modulePermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly omitOwnerAuthorizationOverlay?: boolean;
    readonly omitOwnerRegistration?: boolean;
    readonly onBusinessPermissionTarget?: (
      target: Readonly<{ readonly permission: string; readonly target: object }>,
    ) => void;
    readonly onCheckout?: (count: number) => void;
    readonly onContextPermissionTarget?: (target: { readonly moduleId: string; readonly permission: string }) => void;
    readonly onLegalEntityPermission?: (permission: string | undefined) => void;
    readonly onLegalEntityTarget?: (legalEntityId: string, tenantId: string) => void;
    readonly onOwnerPermissionPrincipal?: (
      principal: Readonly<{ readonly principalId: string; readonly tenantId: string }>,
    ) => void;
    readonly onResourcePermission?: (permission: 'read' | 'write' | undefined) => void;
    readonly onResourceTarget?: (target: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
    }) => void;
    readonly onTenantPermission?: (permission: string) => void;
    readonly onTrustedStorefrontId?: (trustedStorefrontId: string | undefined) => void;
    readonly ownerAuthorizationOverlay?: OwnerAuthorizationOverlayService;
    readonly ownerPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly ownerPermissionKey?: string;
    readonly ownerPermissionResponse?: 'empty';
    readonly permissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly principalKinds?: AccessPrincipalKinds;
    readonly readCompositionAuthority?: () => ReadAuthorityFixture | 'missing';
    readonly resolvedScope?: typeof scope & {
      readonly legalEntityId?: string;
      readonly trustedStorefrontId?: string;
    };
    readonly resourcePermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resultPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resultTenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly runtimeAdmission?: Pick<
      ReadRuntimeOptions,
      'applicationComposition' | 'expectedDeployment' | 'ownerRegistration' | 'shellSystemReads'
    >;
    readonly sqlEvents?: string[];
    readonly tenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly transactionEvents?: string[];
    readonly transactionSettlementFailure?: SqlError;
  } = {},
) {
  let businessPermissionChecks = 0;
  const ownerPermissionChecks: unknown[] = [];
  let contextPermissionChecks = 0;
  let evidence = 0;
  let legalEntityReads = 0;
  let authorityLocks = 0;
  let authorityReads = 0;
  let scopeInstalls = 0;
  let transactionTimestampReadCount = 0;
  let checkedOutConnections = 0;
  let resourcePermissionChecks = 0;
  let tenantPermissionChecks = 0;
  const evidenceRows: EvidenceRow[] = [];
  const evidenceParameterRows: unknown[][] = [];
  const databaseScopeRow = () => ({
    legal_entity_id: options.resolvedScope?.legalEntityId ?? '',
    role: 'ontos_runtime',
    tenant_id: options.resolvedScope?.tenantId ?? scope.tenantId,
  });
  const currentAuthority = () =>
    options.readCompositionAuthority?.() ??
    options.compositionAuthority ?? {
      phase: 'active',
      revision: approvedCompositionRevision,
      unexpired: true,
    };
  const query = (text: string, values: readonly unknown[]) => {
    if (text.includes('legal_entities')) {
      legalEntityReads += 1;
      return Effect.succeed(options.legalEntityRows ?? []);
    }
    return Effect.gen(function* executeReadQuery() {
      if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/u.test(text)) {
        options.sqlEvents?.push(text);
      }
      // The publication fence is one combined statement (isolation probe + guarded lock) and, on the
      // older form, two separate statements. The CASE never acquires the lock under an unsupported
      // isolation, so the lock counts only when this transaction is READ COMMITTED.
      if (
        text.includes('pg_advisory_xact_lock_shared') &&
        (options.compositionIsolation ?? 'read committed') === 'read committed'
      ) {
        authorityLocks += 1;
        options.authorityEvents?.push('authority_locked');
      }
      if (text.includes("current_setting('transaction_isolation')")) {
        return [{ isolation: options.compositionIsolation ?? 'read committed' }];
      }
      if (text.includes('application_composition_authority')) {
        authorityReads += 1;
        const authority = currentAuthority();
        return authority === 'missing'
          ? []
          : [
              {
                phase: authority.phase,
                revision: authority.revision,
                subscriptionsJson: [],
                unexpired: authority.unexpired,
              },
            ];
      }
      if (text.includes('set_config')) {
        scopeInstalls += 1;
        options.authorityEvents?.push('scope_installed');
      }
      // A session-setting role installs its scope and reads back the connected role in one statement.
      if (text === installAndReadScopeSql) {
        return [databaseScopeRow()];
      }
      if (text.includes('transaction_timestamp')) {
        transactionTimestampReadCount += 1;
        if (options.failTransactionTimestamp === true) {
          return yield* new SqlError({
            reason: new ConnectionError({ cause: new Error('transaction clock unavailable') }),
          });
        }
        return [{ operation_at: transactionOperationAt }];
      }
      if (text.includes('data_access_events')) {
        if (options.failEvidence === true) {
          return yield* new SqlError({
            reason: new ConnectionError({
              cause: new Error('private persistence detail'),
            }),
          });
        }
        const queryHash = values.filter(Predicate.isString).find((value) => /^[\da-f]{64}$/u.test(value));
        evidenceRows.push(queryHash === undefined ? {} : { queryHash });
        evidenceParameterRows.push([...values]);
        evidence += 1;
      }
      return text.includes('current_setting') ? [databaseScopeRow()] : [];
    });
  };
  const executeSql = (text: string, values: readonly unknown[]) => {
    if (text === 'COMMIT' && options.transactionSettlementFailure !== undefined) {
      options.sqlEvents?.push(text);
      return Effect.fail(options.transactionSettlementFailure);
    }
    return query(text, values);
  };
  const client = yield* Layer.build(
    scriptedPgClientLayer(
      Effect.acquireRelease(
        Effect.sync(() => {
          checkedOutConnections += 1;
          options.onCheckout?.(checkedOutConnections);
          return testSqlConnection(executeSql);
        }),
        () =>
          Effect.sync(() => {
            checkedOutConnections -= 1;
            options.onCheckout?.(checkedOutConnections);
          }),
      ),
    ).pipe(Layer.provide(Reactivity.layer)),
  );
  const database = {
    executor: yield* makeTestDatabaseFromClient(
      guardPoolAcquisition(Context.get(client, PgClient.PgClient)),
      coreRelations,
    ),
  };
  const transact = database.executor.transaction.bind(database.executor);
  const transaction: typeof database.executor.transaction = (body) =>
    transact(body).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          options.transactionEvents?.push('transaction_settled');
        }),
      ),
    );
  Object.defineProperty(database.executor, 'transaction', {
    value: transaction,
  });
  const stages: string[] = [];
  const accessDecisionOptions = options.accessDecision === undefined ? {} : { accessDecision: options.accessDecision };
  const ownerAuthorizationOptions =
    options.omitOwnerAuthorizationOverlay === true
      ? {}
      : {
          ownerAuthorizationOverlay: options.ownerAuthorizationOverlay ?? allowOwnerAuthorizationOverlay,
        };
  let ownedRuntimeOptions: ReadRuntimeOptions = {
    databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    onStage: (stage) => stages.push(stage),
    ...ownerAuthorizationOptions,
    ...accessDecisionOptions,
    ...options.runtimeAdmission,
  };
  if (options.applicationComposition !== undefined) {
    ownedRuntimeOptions = { ...ownedRuntimeOptions, applicationComposition: options.applicationComposition };
  }
  if (options.principalKinds !== undefined) {
    ownedRuntimeOptions = { ...ownedRuntimeOptions, principalKinds: options.principalKinds };
  }
  const constructRuntime = (ownerRegistration?: VerticalRuntimeRegistration) => {
    const runtimeOptions =
      ownerRegistration === undefined ? ownedRuntimeOptions : { ...ownedRuntimeOptions, ownerRegistration };
    return makeReadRuntime(
      database,
      openModuleEntrypointGateway,
      { resolve: () => Effect.succeed(options.resolvedScope ?? scope) },
      {
        contextPermissions: ({ targets }) => {
          contextPermissionChecks += 1;
          const [target] = targets;
          if (target !== undefined) {
            options.onContextPermissionTarget?.(target);
          }
          return Effect.succeed(
            targets.map(({ moduleId, permission }) => ({
              decision: options.contextPermissionDecision ?? ('unavailable' as const),
              key: `${moduleId}:${permission}`,
            })),
          );
        },
        legalEntities: ({ legalEntityIds, permission, tenantId }) => {
          options.onLegalEntityPermission?.(permission);
          for (const legalEntityId of legalEntityIds) {
            options.onLegalEntityTarget?.(legalEntityId, tenantId);
          }
          return Effect.succeed(
            legalEntityIds.map((key) => ({
              decision: options.permissionDecision ?? ('unavailable' as const),
              key,
            })),
          );
        },
        modules: ({ moduleIds }) =>
          Effect.succeed(
            moduleIds.map((key) => ({
              decision: options.modulePermissionDecision ?? options.permissionDecision ?? ('unavailable' as const),
              key,
            })),
          ),
        ownerPermissions: ({ principal, targets, trustedStorefrontId }) => {
          if (targets.every(({ target }) => target.contract.targetResourceType === 'historical_owner_permission')) {
            businessPermissionChecks += 1;
            options.onTrustedStorefrontId?.(trustedStorefrontId);
            const first = targets[0]?.target;
            if (first !== undefined) {
              options.onBusinessPermissionTarget?.({ permission: first.definition.key, target: first.target });
            }
            return Effect.succeed(
              targets.map(({ target }) => ({
                decision: options.businessPermissionDecision ?? options.permissionDecision ?? ('unavailable' as const),
                key: target.key,
              })),
            );
          }
          ownerPermissionChecks.push(...targets);
          options.onOwnerPermissionPrincipal?.(principal);
          return Effect.succeed(
            options.ownerPermissionResponse === 'empty'
              ? []
              : targets.map(({ target }) => {
                  const expectedKey = target.key;
                  if (expectedKey === undefined) {
                    throw new Error('Test fixture requires a trusted tenant and legal entity scope');
                  }
                  return {
                    decision: options.ownerPermissionDecision ?? options.permissionDecision ?? ('unavailable' as const),
                    key: options.ownerPermissionKey ?? expectedKey,
                  };
                }),
          );
        },
        resources: ({ permission, resources }) => {
          resourcePermissionChecks += 1;
          options.onResourcePermission?.(permission);
          const [target] = resources;
          if (target !== undefined) {
            options.onResourceTarget?.(target);
          }
          return Effect.succeed(
            resources.map((resource) => ({
              decision:
                options.resultPermissionDecision ??
                options.resourcePermissionDecision ??
                options.permissionDecision ??
                ('unavailable' as const),
              key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
            })),
          );
        },
        tenants: ({ permission, tenantIds }) => {
          options.onTenantPermission?.(permission);
          tenantPermissionChecks += 1;
          return Effect.succeed(
            tenantIds.map((key) => ({
              decision:
                tenantPermissionChecks > 1
                  ? (options.resultTenantPermissionDecision ??
                    options.tenantPermissionDecision ??
                    options.permissionDecision ??
                    ('unavailable' as const))
                  : (options.tenantPermissionDecision ?? options.permissionDecision ?? ('unavailable' as const)),
              key,
            })),
          );
        },
      },
      runtimeOptions,
    );
  };
  const baseRuntime = constructRuntime();
  const runRead: typeof baseRuntime.runRead = (input) =>
    options.omitOwnerRegistration === true || options.runtimeAdmission !== undefined
      ? baseRuntime.runRead(input)
      : constructRuntime(historicalFixtureOwner(input.registration.descriptor.owningModuleKey)).runRead(input);
  const runtime = { runRead };
  return {
    authorityCounts: () => ({ authorityLocks, authorityReads, scopeInstalls }),
    checkedOutConnections: () => checkedOutConnections,
    evidence: () => evidence,
    evidenceParameterRows: () => evidenceParameterRows,
    evidenceRows: () => evidenceRows,
    legalEntityReads: () => legalEntityReads,
    ownerPermissionChecks,
    permissionChecks: () => ({
      businessPermissionChecks,
      contextPermissionChecks,
      resourcePermissionChecks,
    }),
    runtime,
    stages,
    transactionTimestampReads: () => transactionTimestampReadCount,
  };
});
const registration = (items: readonly string[] = []) =>
  defineRead(
    {
      accessDeclaration: fixtureReadAccess('core.shell'),
      accessKind: 'list',
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        authorization: {
          kind: 'context_permission',
          permission: 'module.access',
        },
        entrypointKey: 'core.shell.items',
        moduleKey: 'core.shell',
        role: 'api',
      }),
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'core.shell.items.v1',
      },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'forbidden',
      owningModuleKey: 'core.shell',
      permissionTarget: 'module',
      policies: [],
      readKey: 'core.shell.items',
      resultSchema: Schema.Array(Schema.String),
      schemaVersion: '1',
    },
    (_input, context) =>
      Effect.succeed({
        evidence: { resultCount: 0 },
        result: context.services.items,
      }),
    () => Effect.succeed({ items }),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );

const boundaryInput = Schema.Struct({});
type BoundaryInput = typeof boundaryInput.Type;
interface BoundaryPreparation {
  readonly ready: true;
}
const boundaryRows = (transaction: Pick<ScopedTransactionExecutor, 'select'>, readScope: OperationalScope) =>
  transaction
    .select({ tenantId: tenants.tenantId })
    .from(tenants)
    .where(sql`${tenants.tenantId} = ${readScope.tenantId}`)
    .pipe(
      Effect.mapError(
        () =>
          new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: 'Owner SQL is unavailable',
          }),
      ),
    );
interface BoundaryServices {
  readonly rows: ReturnType<typeof boundaryRows>;
}
const boundaryServices: ReadServiceFactory<BoundaryServices> = (transaction, readScope) =>
  Effect.succeed({ rows: boundaryRows(transaction, readScope) });

for (const verified of [false, true]) {
  for (const control of [
    'success',
    'prepare-unavailable',
    'finish-unavailable',
    'prepare-interrupted',
    'finish-interrupted',
    'load-unavailable',
    'evidence-unavailable',
    'stale-after-prepare',
    'stale-in-finish',
  ] as const) {
    it.effect(`releases actual ${verified ? 'verified' : 'native'} Read checkouts across ${control}`, () =>
      Effect.gen(function* stagedCheckoutBoundary() {
        const acquired = { count: 0 };
        let revision = '';
        let authority: ReadAuthorityFixture;
        const sqlEvents: string[] = [];
        const phases: string[] = [];
        const remote = (phase: 'prepare' | 'finish') =>
          Effect.gen(function* remoteOwnerPhase() {
            expect(acquired.count).toBe(0);
            expect(Option.isNone(yield* OpenDatabaseTransaction)).toBe(true);
            yield* refuseInsideDatabaseTransaction('spicedb', `read-boundary.${phase}`);
            if (phase === 'finish') {
              expect(sqlEvents.at(-1)).toBe('COMMIT');
            }
            phases.push(phase);
            if (control === `${phase}-unavailable`) {
              return yield* new ReadHandlerUnavailable({
                code: 'read_handler_unavailable',
                reason: 'Remote owner is unavailable',
              });
            }
            if (control === `${phase}-interrupted`) {
              return yield* Effect.interrupt;
            }
            if (
              (phase === 'prepare' && control === 'stale-after-prepare') ||
              (phase === 'finish' && control === 'stale-in-finish')
            ) {
              authority = { phase: 'active', revision: 'f'.repeat(64), unexpired: true };
            }
            return yield* Effect.void;
          });
        const staged = defineRead(
          {
            accessDeclaration: {
              key: 'test.read-boundaries.value.read',
              kind: 'read',
              modes: ['run'],
              placement: { group: 'boundaries', level: 'basic' },
              risk: 'routine',
              selectors: [],
            },
            accessKind: 'detail',
            entrypoint: defineTenantModuleEntrypoint({
              access: 'read',
              authorization: { kind: 'protected' },
              entrypointKey: 'test.read-boundaries.value',
              moduleKey: 'test.read-boundaries',
              role: 'api',
            }),
            evidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.read-boundaries.evidence' },
            inputSchema: boundaryInput,
            legalEntityScope: 'forbidden',
            owningModuleKey: 'test.read-boundaries',
            policies: [],
            readKey: 'test.read-boundaries.value',
            resultSchema: Schema.Array(Schema.String),
            schemaVersion: '1',
          },
          {
            finish: (_input: BoundaryInput, context: ReadFinishContext<BoundaryPreparation, readonly string[]>) =>
              Effect.gen(function* finishOutsideCheckout() {
                expect(context.compositionRevision).toBe(revision);
                yield* remote('finish');
                if (control !== 'stale-in-finish') {
                  yield* context.transaction((transaction) =>
                    Effect.gen(function* shortOwnerStateRead() {
                      expect(acquired.count).toBe(1);
                      expect(Option.isSome(yield* OpenDatabaseTransaction)).toBe(true);
                      yield* boundaryRows(transaction, context.scope);
                    }),
                  );
                  expect(acquired.count).toBe(0);
                  expect(sqlEvents.at(-1)).toBe('COMMIT');
                  yield* refuseInsideDatabaseTransaction('outbound-fetch', 'read-boundary.after-owner-state');
                }
                return { evidence: { resultCount: context.loaded.length }, result: context.loaded };
              }),
            load: (_input: BoundaryInput, context: ReadLoadContext<BoundaryServices, BoundaryPreparation>) =>
              Effect.gen(function* loadInsideCheckout() {
                expect(context.compositionRevision).toBe(revision);
                expect(acquired.count).toBe(1);
                expect(Option.isSome(yield* OpenDatabaseTransaction)).toBe(true);
                phases.push('load');
                yield* context.services.rows;
                if (control === 'load-unavailable') {
                  return yield* new ReadHandlerUnavailable({
                    code: 'read_handler_unavailable',
                    reason: 'Owner SQL is unavailable',
                  });
                }
                return ['loaded'];
              }),
            prepare: (_input: BoundaryInput, context: ReadPrepareContext) =>
              Effect.gen(function* prepareOutsideCheckout() {
                expect(context.compositionRevision).toBe(revision);
                yield* remote('prepare');
                return { ready: true } as const;
              }),
          },
          boundaryServices,
        );
        const owner = makeTestOperationOwner({ moduleId: 'test.read-boundaries', reads: [staged] });
        ({ revision } = (yield* owner.snapshot).composition);
        authority = { phase: 'active', revision, unexpired: true };
        const harness = yield* makeHarness({
          accessDecision: makeScriptedBoundAccessGate('allowed').bound,
          failEvidence: control === 'evidence-unavailable',
          onCheckout: (count) => {
            acquired.count = count;
          },
          readCompositionAuthority: () => authority,
          runtimeAdmission: {
            applicationComposition: owner.applicationComposition,
            expectedDeployment: owner.expectedDeployment,
            ownerRegistration: owner.ownerRegistration,
          },
          sqlEvents,
        });
        const fiber = yield* harness.runtime
          .runRead({
            input: {},
            principal: verified ? trustVerifiedGatewayPrincipalContext(scope, revision) : scope,
            registration: staged,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(Effect.forkChild);
        const exit = yield* Fiber.await(fiber);
        expect(harness.checkedOutConnections()).toBe(0);
        expect(sqlEvents.some((statement) => /SAVEPOINT/u.test(statement))).toBe(false);
        if (control === 'success') {
          if (Exit.isFailure(exit)) {
            return yield* Effect.failCause(exit.cause);
          }
          expect(exit).toEqual(Exit.succeed(['loaded']));
          expect(phases).toEqual(['prepare', 'load', 'finish']);
          expect(harness.evidence()).toBe(1);
          expect(harness.authorityCounts().authorityLocks).toBe(verified ? 4 : 3);
          expect(sqlEvents.filter((statement) => statement === 'COMMIT')).toHaveLength(verified ? 4 : 3);
        } else {
          expect(harness.evidence()).toBe(0);
          if (!Exit.isFailure(exit)) {
            expect.unreachable('A failed or stale phase must not release its loaded result');
          }
          if (control.endsWith('interrupted')) {
            expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          } else {
            const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
            expect(
              Predicate.isTagged(
                error,
                control === 'evidence-unavailable' ? 'ReadEvidencePersistenceError' : 'ReadHandlerUnavailable',
              ),
            ).toBe(true);
          }
          if (control === 'stale-after-prepare' || control.startsWith('prepare-')) {
            expect(phases).toEqual(['prepare']);
          } else if (control === 'load-unavailable') {
            expect(phases).toEqual(['prepare', 'load']);
          } else {
            expect(phases).toEqual(['prepare', 'load', 'finish']);
          }
        }
        return yield* Effect.void;
      }),
    );
  }
}

const ownerReadTarget = ownerPermissionTarget(
  { legalEntityId: '00000000-0000-4000-8000-000000000002', tenantId: scope.tenantId },
  'read',
  { requiredStorefrontId: 'storefront-a' },
);

const ownerReadRegistration = (
  handler: () => void,
  targetFor: (scope: OperationalScope) => OwnerPermissionAccessTarget = () => ownerReadTarget,
) =>
  defineRead(
    {
      accessDeclaration: fixtureReadAccess('commerce.fixture'),
      accessKind: 'detail',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'fixture.read' },
        entrypointKey: 'commerce.fixture.binding-preview',
        moduleKey: 'commerce.fixture',
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'commerce.fixture.binding-preview.v1' },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'required',
      owningModuleKey: 'commerce.fixture',
      permissionTarget: 'owner_permission',
      policies: [],
      readKey: 'commerce.fixture.binding-preview',
      resultSchema: Schema.String,
      schemaVersion: '1',
    },
    () => {
      handler();
      return Effect.succeed({ evidence: { resultCount: 1 }, result: 'ok' });
    },
    () => Effect.succeed({}),
    defineReadOwnerPermission(fixtureOwnerContract, (_input, resolvedScope) => targetFor(resolvedScope)),
  );

it.effect(
  'checks an exact scoped Owner read target and fails closed on denial, unavailable, or correlation errors',
  () =>
    Effect.gen(function* checksOwnerReadTarget() {
      let handlerCalls = 0;
      const ownerRegistration = ownerReadRegistration(() => {
        handlerCalls += 1;
      });
      const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
        harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: ownerRegistration,
          transport: { correlationId: scope.correlationId },
        });
      const trustedScope = trustVerifiedGatewayPrincipalContext(
        {
          ...scope,
          legalEntityId: '00000000-0000-4000-8000-000000000002',
          trustedStorefrontId: 'storefront-a',
        },
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      const allowed = yield* makeHarness({
        ownerPermissionDecision: 'allowed',
        resolvedScope: trustedScope,
      });
      expect(yield* run(allowed)).toBe('ok');
      expect(allowed.ownerPermissionChecks).toEqual([{ target: ownerReadTarget }]);
      expect(handlerCalls).toBe(1);

      const denied = yield* makeHarness({ ownerPermissionDecision: 'denied', resolvedScope: trustedScope });
      expect(Predicate.isTagged(yield* Effect.flip(run(denied)), 'ReadPermissionDenied')).toBe(true);
      expect(denied.ownerPermissionChecks).toHaveLength(1);
      expect(handlerCalls).toBe(1);

      const unavailable = yield* makeHarness({
        ownerPermissionDecision: 'unavailable',
        resolvedScope: trustedScope,
      });
      expect(Predicate.isTagged(yield* Effect.flip(run(unavailable)), 'ReadPermissionUnavailable')).toBe(true);
      expect(unavailable.ownerPermissionChecks).toHaveLength(1);
      expect(handlerCalls).toBe(1);

      const empty = yield* makeHarness({ ownerPermissionResponse: 'empty', resolvedScope: trustedScope });
      expect(Predicate.isTagged(yield* Effect.flip(run(empty)), 'ReadPermissionUnavailable')).toBe(true);
      expect(empty.ownerPermissionChecks).toHaveLength(1);
      expect(handlerCalls).toBe(1);

      const mismatched = yield* makeHarness({
        ownerPermissionDecision: 'allowed',
        ownerPermissionKey: 'wrong-tenant:wrong-entity:owner.binding.create',
        resolvedScope: trustedScope,
      });
      expect(Predicate.isTagged(yield* Effect.flip(run(mismatched)), 'ReadPermissionUnavailable')).toBe(true);
      expect(handlerCalls).toBe(1);

      const storefrontMismatch = yield* makeHarness({
        ownerPermissionDecision: 'allowed',
        resolvedScope: trustVerifiedGatewayPrincipalContext(
          {
            ...scope,
            legalEntityId: trustedScope.legalEntityId,
            trustedStorefrontId: 'storefront-b',
          },
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ),
      });
      const storefrontFailure = yield* Effect.flip(run(storefrontMismatch));
      expect(Predicate.isTagged(storefrontFailure, 'ReadPermissionUnavailable')).toBe(true);
      expect(storefrontMismatch.ownerPermissionChecks).toHaveLength(0);
      expect(handlerCalls).toBe(1);
    }),
);

it.effect(
  'rechecks Current permission after revocation while retaining the same published definition and opaque Read',
  () =>
    Effect.gen(function* rechecksRevokedOwnerPermission() {
      let handlerCalls = 0;
      const ownerRegistration = ownerReadRegistration(() => {
        handlerCalls += 1;
      });
      const trustedScope = trustVerifiedGatewayPrincipalContext(
        {
          ...scope,
          legalEntityId: '00000000-0000-4000-8000-000000000002',
          trustedStorefrontId: 'storefront-a',
        },
        approvedCompositionRevision,
      );
      interface RevocationOptions {
        ownerPermissionDecision: 'allowed' | 'denied';
        resolvedScope: typeof trustedScope;
      }
      const options: RevocationOptions = {
        ownerPermissionDecision: 'allowed',
        resolvedScope: trustedScope,
      };
      const harness = yield* makeHarness(options);
      expect(
        yield* harness.runtime.runRead({
          input: {},
          principal: trustedScope,
          registration: ownerRegistration,
          transport: { correlationId: scope.correlationId },
        }),
      ).toBe('ok');
      options.ownerPermissionDecision = 'denied';
      const failure = yield* Effect.flip(
        harness.runtime.runRead({
          input: {},
          principal: trustedScope,
          registration: ownerRegistration,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
      expect(harness.ownerPermissionChecks).toEqual([{ target: ownerReadTarget }, { target: ownerReadTarget }]);
      expect(ownerReadTarget.contract).toBe(fixtureOwnerContract);
      expect(handlerCalls).toBe(1);
    }),
);

it.effect('uses each fresh Principal and Tenant for Current owner permission instead of an earlier allow', () =>
  Effect.gen(function* rechecksOwnerActorAndTenant() {
    let handlerCalls = 0;
    const checkedPrincipals: Readonly<{ readonly principalId: string; readonly tenantId: string }>[] = [];
    const ownerRegistration = ownerReadRegistration(
      () => {
        handlerCalls += 1;
      },
      (resolvedScope) => ownerPermissionTarget(resolvedScope, 'fresh-subject'),
    );
    const trustedScope = trustVerifiedGatewayPrincipalContext(
      {
        ...scope,
        legalEntityId: '00000000-0000-4000-8000-000000000002',
        trustedStorefrontId: 'storefront-a',
      },
      approvedCompositionRevision,
    );
    interface ActorOptions {
      onOwnerPermissionPrincipal: (
        principal: Readonly<{ readonly principalId: string; readonly tenantId: string }>,
      ) => void;
      ownerPermissionDecision: 'allowed' | 'denied';
      resolvedScope: typeof trustedScope;
    }
    const options: ActorOptions = {
      onOwnerPermissionPrincipal: ({ principalId, tenantId }) => {
        checkedPrincipals.push({ principalId, tenantId });
      },
      ownerPermissionDecision: 'allowed',
      resolvedScope: trustedScope,
    };
    const harness = yield* makeHarness(options);
    expect(
      yield* harness.runtime.runRead({
        input: {},
        principal: trustedScope,
        registration: ownerRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ).toBe('ok');
    options.ownerPermissionDecision = 'denied';
    const nextPrincipals = [
      { ...trustedScope, principalId: '00000000-0000-4000-8000-000000000009' },
      { ...trustedScope, tenantId: '00000000-0000-4000-8000-000000000099' },
    ];
    for (const nextPrincipal of nextPrincipals) {
      const current = trustVerifiedGatewayPrincipalContext(nextPrincipal, approvedCompositionRevision);
      options.resolvedScope = current;
      const failure = yield* Effect.flip(
        harness.runtime.runRead({
          input: {},
          principal: current,
          registration: ownerRegistration,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
    }
    expect(checkedPrincipals).toEqual(
      [trustedScope, ...nextPrincipals].map(({ principalId, tenantId }) => ({ principalId, tenantId })),
    );
    expect(harness.ownerPermissionChecks).toHaveLength(3);
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('rejects payload-selected foreign contracts and copied definitions before a permissive Current check', () =>
  Effect.gen(function* rejectsOwnerDefinitionSubstitution() {
    let handlerCalls = 0;
    const base = ownerReadRegistration(() => {
      handlerCalls += 1;
    });
    const ownerRegistration = defineRead(
      {
        ...base.descriptor,
        inputSchema: Schema.Struct({ variant: Schema.Literals(['valid', 'foreign-contract', 'copied-definition']) }),
      },
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 1 }, result: 'ok' });
      },
      () => Effect.succeed({}),
      defineReadOwnerPermission<{ readonly variant: 'valid' | 'foreign-contract' | 'copied-definition' }>(
        fixtureOwnerContract,
        ({ variant }, resolvedScope) => {
          const target = ownerPermissionTarget(resolvedScope, 'definition-bound');
          if (variant === 'foreign-contract') {
            const definition = Object.freeze({ ...target.definition, owningCapability: 'commerce.foreign' });
            return Object.freeze({
              ...target,
              contract: Object.freeze({
                ...fixtureOwnerContract,
                owningModuleKey: 'commerce.foreign',
                permissions: Object.freeze([definition]),
              }),
              definition,
            });
          }
          return variant === 'copied-definition'
            ? Object.freeze({ ...target, definition: Object.freeze({ ...target.definition }) })
            : target;
        },
      ),
    );
    const trustedScope = trustVerifiedGatewayPrincipalContext(
      {
        ...scope,
        legalEntityId: '00000000-0000-4000-8000-000000000002',
        trustedStorefrontId: 'storefront-a',
      },
      approvedCompositionRevision,
    );
    const harness = yield* makeHarness({ ownerPermissionDecision: 'allowed', resolvedScope: trustedScope });
    expect(
      yield* harness.runtime.runRead({
        input: { variant: 'valid' },
        principal: trustedScope,
        registration: ownerRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ).toBe('ok');
    for (const variant of ['foreign-contract', 'copied-definition'] as const) {
      const failure = yield* Effect.flip(
        harness.runtime.runRead({
          input: { variant },
          principal: trustedScope,
          registration: ownerRegistration,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(
        Predicate.isTagged(
          failure,
          variant === 'foreign-contract' ? 'ReadHandlerExecutionError' : 'ReadPermissionUnavailable',
        ),
      ).toBe(true);
    }
    expect(harness.ownerPermissionChecks).toHaveLength(1);
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('retains owner-declared tenant and Legal Entity scope without a fallback', () =>
  Effect.gen(function* derivesConfigurationReadScope() {
    let handlerCalls = 0;
    const tenantTarget = ownerPermissionTarget(scope, 'tenant-owned');
    const entityTarget = ownerPermissionTarget(
      { ...scope, legalEntityId: '00000000-0000-4000-8000-000000000002' },
      'entity-owned',
    );
    const invalidTarget = ownerPermissionTarget(scope, 'invalid', { scopeKind: 'unknown_scope' });
    const configurationRegistration = (target: OwnerPermissionAccessTarget) =>
      defineRead(
        {
          accessDeclaration: fixtureReadAccess('commerce.fixture'),
          accessKind: 'detail',
          entrypoint: defineTenantModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'context_permission', permission: 'fixture.read' },
            entrypointKey: 'commerce.fixture.configuration-scope',
            moduleKey: 'commerce.fixture',
            role: 'api',
          }),
          evidencePolicy: { captureMode: 'metadata_only', policyKey: 'commerce.fixture.configuration-scope.v1' },
          inputSchema: Schema.Struct({}),
          legalEntityScope: 'optional',
          owningModuleKey: 'commerce.fixture',
          permissionTarget: 'owner_permission',
          policies: [],
          readKey: 'commerce.fixture.configuration-scope',
          resultSchema: Schema.String,
          schemaVersion: '1',
        },
        () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 1 }, result: 'ok' });
        },
        () => Effect.succeed({}),
        defineReadOwnerPermission(fixtureOwnerContract, () => target),
      );

    const tenantScoped = yield* makeHarness({ ownerPermissionDecision: 'allowed' });
    const tenantResult = yield* tenantScoped.runtime.runRead({
      input: {},
      principal: scope,
      registration: configurationRegistration(tenantTarget),
      transport: { correlationId: scope.correlationId },
    });
    expect(tenantResult).toBe('ok');
    expect(tenantScoped.ownerPermissionChecks).toEqual([{ target: tenantTarget }]);

    const legalEntityScoped = yield* makeHarness({ ownerPermissionDecision: 'allowed' });
    const unavailable = yield* Effect.flip(
      legalEntityScoped.runtime.runRead({
        input: {},
        principal: scope,
        registration: configurationRegistration(entityTarget),
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(unavailable, 'ReadPermissionUnavailable')).toBe(true);
    expect(legalEntityScoped.ownerPermissionChecks).toHaveLength(0);

    const unknownType = yield* makeHarness({ ownerPermissionDecision: 'allowed' });
    const unknownFailure = yield* Effect.flip(
      unknownType.runtime.runRead({
        input: {},
        principal: scope,
        registration: configurationRegistration(invalidTarget),
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(unknownFailure, 'ReadPermissionUnavailable')).toBe(true);
    expect(unknownType.ownerPermissionChecks).toHaveLength(0);
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('runs every gate before the handler and persists evidence before releasing zero results', () =>
  Effect.gen(function* migratedTest1() {
    const harness = yield* makeHarness();
    const result = yield* harness.runtime.runRead({
      input: {},
      principal: scope,
      registration: registration(),
      transport: { correlationId: scope.correlationId },
    });
    expect(result).toEqual([]);
    expect(harness.evidence()).toBe(1);
    expect(harness.stages).toEqual(READ_RUNTIME_STAGES);
  }),
);
it.effect('runs the owner authorization overlay inside the transaction before the Read handler', () =>
  Effect.gen(function* ownerOverlayReadTest() {
    let handlerCalls = 0;
    const ownerInputs: OwnerAuthorizationInput[] = [];
    const ownerAuthorizationOverlay: OwnerAuthorizationOverlayService = {
      authorize: (_transaction, input) =>
        Effect.sync(() => {
          ownerInputs.push(input);
          return 'denied' as const;
        }),
    };
    const harness = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      ownerAuthorizationOverlay,
      permissionDecision: 'allowed',
    });
    const deniedRegistration = defineRead(
      registration().descriptor,
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const error = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: deniedRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(error, 'ReadPermissionDenied')).toBe(true);
    expect(ownerInputs).toHaveLength(1);
    expect(ownerInputs[0]?.operation).toBe('read');
    expect(ownerInputs[0]?.operationAt).toEqual(DateTime.makeUnsafe(Date.parse('2026-09-28T09:00:00.000Z')));
    expect(harness.transactionTimestampReads()).toBe(1);
    expect(ownerInputs[0]?.targets).toEqual([{ kind: 'module', moduleId: 'core.shell' }]);
    expect(handlerCalls).toBe(0);
    expect(harness.evidence()).toBe(1);
  }),
);

/**
 * Answers outside the owner contract. Before this the Read path let an unknown answer through to the
 * handler (pre-existing fail-open); each is now unavailable and the handler never runs.
 */
/** Untyped values the compiler cannot vet, as a type escape or a separately built owner unit could send. */
const outOfContract = Schema.decodeUnknownEffect(Schema.Any);
const OUT_OF_CONTRACT_OWNER_ANSWERS: readonly (readonly [string, () => Effect.Effect<OwnerAuthorizationOutcome>])[] = [
  ['ALLOWED', () => outOfContract('ALLOWED').pipe(Effect.orDie)],
  ['{}', () => outOfContract({}).pipe(Effect.orDie)],
  ['{decision: allowed}', () => outOfContract({ decision: 'allowed' }).pipe(Effect.orDie)],
  ['null', () => outOfContract(null).pipe(Effect.orDie)],
  ['undefined', () => outOfContract(globalThis.undefined).pipe(Effect.orDie)],
  ['a thrown defect', () => Effect.die(new Error('owner rule defect'))],
];

it.effect('a synchronous throw inside the owner overlay is unavailable on the Read path, never a 500', () =>
  Effect.gen(function* synchronousOwnerThrowRead() {
    let handlerCalls = 0;
    const harness = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      ownerAuthorizationOverlay: {
        authorize: () => {
          throw new TypeError('owner rule private detail');
        },
      },
      permissionDecision: 'allowed',
    });
    const testRegistration = defineRead(
      registration().descriptor,
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: testRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(failure, 'ReadPermissionUnavailable')).toBe(true);
    expect(handlerCalls).toBe(0);
  }),
);

it.effect('a Read refusal with unreportable owner codes still refuses and reports deny.owner_rule', () =>
  Effect.gen(function* unreportableReadCodes() {
    const entries: string[] = [];
    const harness = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      ownerAuthorizationOverlay: {
        authorize: () =>
          Effect.succeed({ decision: 'denied' as const, reasons: ['deny.owner.someone@example.test'] as const }),
      },
      permissionDecision: 'allowed',
    });
    const testRegistration = defineRead(
      registration().descriptor,
      () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }),
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: testRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- Test-owned diagnostic logger capture.
      Effect.provide(
        Logger.layer([Logger.make((options) => entries.push(JSON.stringify(Logger.formatStructured.log(options))))]),
      ),
    );
    expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
    const warning = entries.find((entry) => entry.includes('Read refused'));
    expect(warning).toContain('"reasons":"deny.owner_rule"');
    expect(warning).not.toContain('example.test');
  }),
);

for (const [label, answer] of OUT_OF_CONTRACT_OWNER_ANSWERS) {
  it.effect(`answers an owner overlay's ${label} as unavailable on the Read path`, () =>
    Effect.gen(function* outOfContractOwnerRead() {
      let handlerCalls = 0;
      const harness = yield* makeHarness({
        contextPermissionDecision: 'allowed',
        ownerAuthorizationOverlay: {
          authorize: answer,
        },
        permissionDecision: 'allowed',
      });
      const testRegistration = defineRead(
        registration().descriptor,
        () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
        () => Effect.succeed({}),
        () => ({ kind: 'module', moduleId: 'core.shell' }),
      );
      const failure = yield* Effect.flip(
        harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: testRegistration,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Predicate.isTagged(failure, 'ReadPermissionUnavailable')).toBe(true);
      expect(handlerCalls).toBe(0);
    }),
  );
}

it.effect('fails closed before owner authorization when PostgreSQL cannot provide transaction time', () =>
  Effect.gen(function* transactionTimeUnavailable() {
    let overlayCalls = 0;
    let handlerCalls = 0;
    const harness = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      failTransactionTimestamp: true,
      ownerAuthorizationOverlay: {
        authorize: () => {
          overlayCalls += 1;
          return Effect.succeed('allowed' as const);
        },
      },
      permissionDecision: 'allowed',
    });
    const testRegistration = defineRead(
      registration().descriptor,
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: testRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    );

    expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
    expect(overlayCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(harness.transactionTimestampReads()).toBe(1);
  }),
);

it.effect('keeps owner-neutral Reads available without an owner adapter', () =>
  Effect.gen(function* ownerNeutralReadWithoutOverlay() {
    const harness = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      omitOwnerAuthorizationOverlay: true,
      permissionDecision: 'allowed',
    });
    const result = yield* harness.runtime.runRead({
      input: {},
      principal: scope,
      registration: registration(),
      transport: { correlationId: scope.correlationId },
    });
    expect(result).toEqual([]);
  }),
);
it.effect('validates decoded transformed results and preserves their nullable JSON encoding', () =>
  Effect.gen(function* migratedTest2() {
    const harness = yield* makeHarness();
    const ResultSchema = Schema.Struct({
      value: Schema.OptionFromNullOr(Schema.String),
    });
    const transformedRegistration = defineRead(
      { ...registration().descriptor, resultSchema: ResultSchema },
      () =>
        Effect.succeed({
          evidence: { resultCount: 1 },
          result: { value: Option.none() },
        }),
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const result = yield* harness.runtime.runRead({
      input: {},
      principal: scope,
      registration: transformedRegistration,
      transport: { correlationId: scope.correlationId },
    });
    const encoded = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(ResultSchema))(result);

    expect(Option.isNone(result.value)).toBe(true);
    expect(encoded).toEqual({ value: null });
  }),
);
it.effect('uses each denying Policy reference own declared HTTP status', () =>
  Effect.all(
    ([409, 422] as const).map((denialStatus) =>
      Effect.gen(function* migratedTest4() {
        const harness = yield* makeHarness();
        const policy = defineGlobalPolicy<Readonly<Record<string, never>>>({
          evaluate: () => Effect.fail(denyPolicy(`policy-${denialStatus}`, 'Denied by test Policy')),
          policyKey: `global.read-policy-${denialStatus}.v1`,
        });
        const governed = defineRead(
          {
            ...registration().descriptor,
            policies: [{ denialStatus, policyKey: policy.policyKey }],
          },
          () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }),
          () => Effect.succeed({}),
          () => ({ kind: 'module', moduleId: 'core.shell' }),
          undefined,
          [policy],
        );
        const error = yield* Effect.flip(
          harness.runtime.runRead({
            input: {},
            principal: scope,
            registration: governed,
            transport: { correlationId: scope.correlationId },
          }),
        );
        expect(Predicate.isTagged(error, 'ReadPolicyDenied')).toBe(true);
        expect(
          (yield* Schema.decodeEffect(ReadPolicyDenied)(
            yield* Effect.filterOrFail(Effect.succeed(error), Schema.is(ReadPolicyDenied)),
          )).httpStatus,
        ).toBe(denialStatus);
      }),
    ),
    { concurrency: 'unbounded' },
  ),
);
it.effect('persists the canonical permission target when a Policy denies the read', () =>
  Effect.gen(function* policyDenialEvidence() {
    const target = {
      moduleId: 'inventory.policy-denial',
      resourceId: 'stock-1',
      resourceType: 'inventory.policy-denial-item',
    };
    const policy = defineGlobalPolicy<typeof target>({
      evaluate: () => Effect.fail(denyPolicy('policy-target', 'Denied by target evidence test')),
      policyKey: 'global.read-policy-target-evidence.v1',
    });
    const deniedRead = defineRead(
      {
        ...registration().descriptor,
        inputSchema: ResourceTargetSchema,
        permissionTarget: 'resource',
        policies: [{ denialStatus: 422, policyKey: policy.policyKey }],
        resultSchema: Schema.String,
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'hidden' }),
      () => Effect.succeed({}),
      (input) => ({ kind: 'resource', resource: input }),
      undefined,
      [policy],
    );
    const harness = yield* makeHarness({ permissionDecision: 'allowed' });
    const error = yield* Effect.flip(
      harness.runtime.runRead({
        input: target,
        principal: scope,
        registration: deniedRead,
        transport: { correlationId: scope.correlationId },
      }),
    );

    expect(Predicate.isTagged(error, 'ReadPolicyDenied')).toBe(true);
    expect(harness.evidence()).toBe(1);
    const values = harness.evidenceParameterRows()[0] ?? [];
    expect(values).toContain(target.moduleId);
    expect(values).toContain(target.resourceId);
    expect(values).toContain(target.resourceType);
  }),
);
it.effect('executes every governed access kind and computes hash-only query evidence inside Core', () =>
  Effect.all(
    (['detail', 'download', 'export', 'list', 'report', 'search'] as const).map((accessKind) =>
      Effect.gen(function* migratedTest6() {
        const legalEntityId = '00000000-0000-4000-8000-000000000004';
        const harness = yield* makeHarness({
          permissionDecision: 'allowed',
          resolvedScope: { ...scope, legalEntityId },
        });
        const governed = defineRead(
          {
            ...registration().descriptor,
            accessKind,
            evidencePolicy: {
              captureMode: 'hash_only',
              policyKey: `core.shell.${accessKind}.hash.v1`,
            },
            legalEntityScope: 'required',
          },
          () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }),
          () => Effect.succeed({}),
          () => ({ kind: 'module', moduleId: 'core.shell' }),
          accessKind === 'search' ? () => [] : undefined,
        );
        expect(
          yield* harness.runtime.runRead({
            input: {},
            principal: {
              authBindingId: '00000000-0000-4000-8000-000000000005',
              authContextRef: 'better-auth-session:read-runtime',
              authMethod: 'session',
              legalEntityId,
              principalId: scope.principalId,
              tenantId: scope.tenantId,
            },
            registration: governed,
            transport: { correlationId: scope.correlationId },
          }),
        ).toEqual([]);
        expect(String(harness.evidenceRows()[0]?.queryHash)).toMatch(/^[\da-f]{64}$/u);
      }),
    ),
    { concurrency: 'unbounded' },
  ),
);
it.effect('rejects invalid input before opening a transaction or executing a handler', () =>
  Effect.gen(function* migratedTest7() {
    const harness = yield* makeHarness();
    const error = yield* Effect.flip(
      harness.runtime.runRead({
        input: { unexpected: Symbol('invalid') },
        principal: {},
        registration: registration(),
        transport: {},
      }),
    );
    expect(Predicate.isTagged(error, 'ReadInputValidationError')).toBe(true);
    expect(harness.evidence()).toBe(0);
  }),
);
it.effect('preserves typed result-validation failure across transaction rollback', () =>
  Effect.gen(function* migratedTest8() {
    const harness = yield* makeHarness();
    const invalidRegistration = defineRead(
      registration().descriptor,
      () => {
        const result: string[] = [];
        const handlerResult = { evidence: { resultCount: 1 }, result };
        Object.defineProperty(handlerResult, 'result', { value: 42 });
        return Effect.succeed(handlerResult);
      },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const error = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: {
          authBindingId: '00000000-0000-4000-8000-000000000005',
          authContextRef: 'better-auth-session:read-runtime',
          authMethod: 'session',
          principalId: scope.principalId,
          tenantId: scope.tenantId,
        },
        registration: invalidRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(error, 'ReadResultValidationError')).toBe(true);
    expect(harness.evidence()).toBe(0);
  }),
);
it.effect('never releases an allowed result when required evidence persistence fails', () =>
  Effect.gen(function* migratedTest9() {
    const harness = yield* makeHarness({ failEvidence: true });
    const error = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: registration(),
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(error, 'ReadEvidencePersistenceError')).toBe(true);
    expect(harness.evidence()).toBe(0);
  }),
);
it.effect('preserves scoped service-factory unavailability and never invokes the handler', () =>
  Effect.gen(function* migratedTest10() {
    const harness = yield* makeHarness();
    let handlerCalls = 0;
    const unavailableRegistration = defineRead(
      registration().descriptor,
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
      () =>
        Effect.fail(
          new OperationContextUnavailable({
            code: 'operation_context_unavailable',
            reason: 'The owner repository scope is temporarily unavailable',
          }),
        ),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const error = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: unavailableRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(error, 'OperationContextUnavailable')).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(harness.evidence()).toBe(0);
  }),
);

it.effect('passes only the exact verified gateway revision into scoped Read service factories', () =>
  Effect.gen(function* readFactoryGatewayRevision() {
    const revision = 'a'.repeat(64);
    const verified = trustVerifiedGatewayPrincipalContext(scope, revision);
    const revisions: (string | undefined)[] = [];
    const scopedRegistration = defineRead(
      registration().descriptor,
      () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }),
      (_transaction, _scope, compositionRevision) =>
        Effect.sync(() => {
          revisions.push(compositionRevision);
          return {};
        }),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );

    for (const principal of [verified, { ...verified, compositionRevision: 'b'.repeat(64) }, scope]) {
      const harness = yield* makeHarness();
      yield* harness.runtime.runRead({
        input: {},
        principal,
        registration: scopedRegistration,
        transport: { correlationId: scope.correlationId },
      });
    }
    expect(revisions).toEqual([revision, undefined, undefined]);
  }),
);

it.effect('rejects stale, draining, sealed, migrated, expired, or missing Read authority before any owner work', () =>
  Effect.gen(function* rejectedReadAuthority() {
    const authorityCases = [
      'missing',
      { phase: 'active', revision: 'b'.repeat(64), unexpired: true },
      { phase: 'draining', revision: approvedCompositionRevision, unexpired: true },
      { phase: 'sealed', revision: approvedCompositionRevision, unexpired: true },
      { phase: 'migrated', revision: approvedCompositionRevision, unexpired: true },
      { phase: 'active', revision: approvedCompositionRevision, unexpired: false },
    ] as const;
    const principal = trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision);
    for (const compositionAuthority of authorityCases) {
      let factoryCalls = 0;
      let handlerCalls = 0;
      let overlayCalls = 0;
      let policyCalls = 0;
      const policy = defineGlobalPolicy<Readonly<Record<string, never>>>({
        evaluate: () => {
          policyCalls += 1;
          return Effect.fail(denyPolicy('must-not-run', 'A stale Read cannot evaluate owner Policies'));
        },
        policyKey: 'global.read-authority-fence.v1',
      });
      const harness = yield* makeHarness({
        compositionAuthority,
        ownerAuthorizationOverlay: {
          authorize: () => {
            overlayCalls += 1;
            return Effect.succeed('allowed' as const);
          },
        },
      });
      const scopedRegistration = defineRead(
        { ...registration().descriptor, policies: [{ denialStatus: 422, policyKey: policy.policyKey }] },
        () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
        () =>
          Effect.sync(() => {
            factoryCalls += 1;
            return {};
          }),
        () => ({ kind: 'module', moduleId: 'core.shell' }),
        undefined,
        [policy],
      );
      const failure = yield* Effect.flip(
        harness.runtime.runRead({
          input: {},
          principal,
          registration: scopedRegistration,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect({ factoryCalls, handlerCalls, overlayCalls }).toEqual({
        factoryCalls: 0,
        handlerCalls: 0,
        overlayCalls: 0,
      });
      expect(policyCalls).toBe(0);
      expect(harness.authorityCounts()).toEqual({ authorityLocks: 1, authorityReads: 1, scopeInstalls: 0 });
      expect(harness.transactionTimestampReads()).toBe(0);
      expect(harness.evidence()).toBe(0);
      expect(harness.stages).toEqual(['input_decoded']);
    }
  }),
);

it.effect('admits the new active Read revision before scope, service factory, and handler work', () =>
  Effect.gen(function* currentReadAuthority() {
    const revision = 'b'.repeat(64);
    const events: string[] = [];
    const harness = yield* makeHarness({
      authorityEvents: events,
      compositionAuthority: { phase: 'active', revision, unexpired: true },
      transactionEvents: events,
    });
    const scopedRegistration = defineRead(
      registration().descriptor,
      () => {
        events.push('handler');
        return Effect.succeed({ evidence: { resultCount: 0 }, result: ['current'] });
      },
      (_transaction, _scope, compositionRevision) =>
        Effect.sync(() => {
          expect(compositionRevision).toBe(revision);
          events.push('factory');
          return {};
        }),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    expect(
      yield* harness.runtime.runRead({
        input: {},
        principal: trustVerifiedGatewayPrincipalContext(scope, revision),
        registration: scopedRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ).toEqual(['current']);
    // The owner transaction installs the read's scope, and the after-commit allowed evidence opens its
    // own short scoped transaction, so a successful read installs scope twice.
    expect(events).toEqual([
      'authority_locked',
      'transaction_settled',
      'authority_locked',
      'scope_installed',
      'factory',
      'handler',
      'transaction_settled',
      'authority_locked',
      'scope_installed',
      'transaction_settled',
    ]);
    expect(harness.authorityCounts()).toEqual({ authorityLocks: 3, authorityReads: 3, scopeInstalls: 2 });
    expect(harness.evidence()).toBe(1);
  }),
);

it.effect('persists no denied evidence for a stale admitted Read', () =>
  Effect.gen(function* staleReadCannotPersistDenial() {
    const harness = yield* makeHarness({
      compositionAuthority: { phase: 'active', revision: 'b'.repeat(64), unexpired: true },
      contextPermissionDecision: 'denied',
      permissionDecision: 'denied',
    });
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision),
        registration: registration(),
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(harness.evidence()).toBe(0);
    expect(harness.stages).toEqual(['input_decoded']);
    expect(harness.authorityCounts()).toEqual({ authorityLocks: 1, authorityReads: 1, scopeInstalls: 0 });
  }),
);

it.effect('leaves owner-local Reads independent from composition authority queries', () =>
  Effect.gen(function* localReadAuthorityIndependence() {
    const harness = yield* makeHarness({ compositionAuthority: 'missing' });
    expect(
      yield* harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: registration(['local']),
        transport: { correlationId: scope.correlationId },
      }),
    ).toEqual(['local']);
    // The owner transaction installs the read's scope, and the after-commit allowed evidence opens its
    // own short scoped transaction, so a successful read installs scope twice.
    expect(harness.authorityCounts()).toEqual({ authorityLocks: 0, authorityReads: 0, scopeInstalls: 2 });
  }),
);

it.effect('rejects unsafe Read transaction isolation before acquiring authority or executing owner code', () =>
  Effect.gen(function* rejectSnapshotReadAuthority() {
    const harness = yield* makeHarness({ compositionIsolation: 'repeatable read' });
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision),
        registration: registration(),
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(harness.authorityCounts()).toEqual({ authorityLocks: 0, authorityReads: 0, scopeInstalls: 0 });
    expect(harness.stages).toEqual(['input_decoded']);
    expect(harness.evidence()).toBe(0);
  }),
);

it.effect('does not mint a revision for a local Read that requires cross-owner credentials', () =>
  Effect.gen(function* localReadCannotMintGatewayRevision() {
    const harness = yield* makeHarness();
    let handlerCalls = 0;
    const credentialedRegistration = defineRead(
      registration().descriptor,
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
      (_transaction, _scope, compositionRevision) =>
        compositionRevision === undefined
          ? Effect.fail(
              new OperationContextUnavailable({
                code: 'operation_context_unavailable',
                reason: 'Cross-owner Read credentials require a verified gateway revision',
              }),
            )
          : Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const failure = yield* harness.runtime
      .runRead({
        input: {},
        principal: scope,
        registration: credentialedRegistration,
        transport: { correlationId: scope.correlationId },
      })
      .pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'OperationContextUnavailable')).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(harness.evidence()).toBe(0);
  }),
);

const counterpartyReadRegistration = (legalEntityScope: 'required' | 'optional', onHandler: () => void) =>
  defineRead(
    {
      ...registration().descriptor,
      legalEntityScope,
      permissionTarget: 'legal_entity',
    },
    () => {
      onHandler();
      return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
    },
    () => Effect.succeed({}),
    () => ({ kind: 'legal_entity', permission: 'read_counterparty' }),
  );

it.effect(
  'authorizes an explicit Legal Entity target before handler resolution without substituting the selected context',
  Effect.fn(function* explicitLegalEntityTarget() {
    const targetId = '00000000-0000-4000-8000-000000000099';
    const selectedId = '00000000-0000-4000-8000-000000000004';
    const observed: string[] = [];
    let handlerCalls = 0;
    // O62: an `authenticated_principal` Read is unprotected, so it must not inherit a carrier.
    const { accessDeclaration, ...unprotectedRegistration } = registration().descriptor;
    expect(accessDeclaration?.key).toBe('core.shell.fixture.read');
    const targetRead = defineRead(
      {
        ...unprotectedRegistration,
        entrypoint: defineSystemModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'authenticated_principal' },
          entrypointKey: 'core.identity.api.target-test',
          moduleKey: 'core.identity',
          role: 'api',
        }),
        legalEntityScope: 'optional',
        owningModuleKey: 'core.identity',
        permissionTarget: 'legal_entity',
        readKey: 'core.identity.api.target-test',
      },
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
      () => Effect.succeed({}),
      () => ({ kind: 'legal_entity', legalEntityId: targetId, permission: 'access' }),
    );
    for (const decision of ['allowed', 'denied', 'unavailable'] as const) {
      const harness = yield* makeHarness({
        onLegalEntityTarget: (id, tenantId) => observed.push(`${tenantId}:${id}`),
        permissionDecision: decision,
        resolvedScope: { ...scope, legalEntityId: selectedId },
      });
      const outcome = yield* Effect.exit(
        harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: targetRead,
          transport: { correlationId: scope.correlationId },
        }),
      );
      if (decision === 'allowed') {
        expect(Exit.isSuccess(outcome)).toBe(true);
      } else {
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(harness.stages).not.toContain('handler_executed');
      }
    }
    expect(handlerCalls).toBe(1);
    expect(observed).toEqual(Array.from({ length: 3 }, () => `${scope.tenantId}:${targetId}`));
  }),
);

/** Core's principal kind of the acting principal, as the access gate reads it. */
const principalKindsOf = (kind: AccessPrincipalKind | undefined): AccessPrincipalKinds => ({
  readKind: () => Effect.succeed(Option.fromUndefinedOr(kind)),
});

const selectedCompanyRead = (target: ResolvedReadPermissionTarget) => {
  const { accessDeclaration, ...unprotectedRegistration } = registration().descriptor;
  expect(accessDeclaration?.key).toBe('core.shell.fixture.read');
  return defineRead(
    {
      ...unprotectedRegistration,
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'authenticated_principal' },
        entrypointKey: 'core.identity.api.selected-company-test',
        moduleKey: 'core.identity',
        role: 'api',
      }),
      legalEntityScope: 'required',
      owningModuleKey: 'core.identity',
      permissionTarget: 'legal_entity',
      readKey: 'core.identity.api.selected-company-test',
    },
    () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }),
    () => Effect.succeed({}),
    () => target,
  );
};

const selectedCompanyId = '00000000-0000-4000-8000-000000000004';
const otherCompanyId = '00000000-0000-4000-8000-000000000099';
const selectedCompanyScope = { ...scope, legalEntityId: selectedCompanyId };

/** A legacy target run once: the outcome and every company the retired relation was asked about, with its permission. */
const runSelectedCompanyRead = Effect.fn(function* runSelectedCompanyRead(
  target: ResolvedReadPermissionTarget,
  kind: AccessPrincipalKind | undefined,
) {
  // A person who exists only in the v2 model holds no legacy `legal_entity#member` tuple: the relation denies.
  const asked: string[] = [];
  let permission: string | undefined;
  const harness = yield* makeHarness({
    onLegalEntityPermission: (requested) => {
      permission = requested;
    },
    onLegalEntityTarget: (id) => asked.push(id),
    permissionDecision: 'denied',
    principalKinds: principalKindsOf(kind),
    resolvedScope: selectedCompanyScope,
  });
  const outcome = yield* Effect.exit(
    harness.runtime.runRead({
      input: {},
      principal: selectedCompanyScope,
      registration: selectedCompanyRead(target),
      transport: { correlationId: scope.correlationId },
    }),
  );
  return { asked, outcome, permission };
});

const deniedByLegacyRelation = (outcome: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(outcome) && Option.exists(Cause.findErrorOption(outcome.cause), Schema.is(ReadPermissionDenied));

it.effect(
  "answers a person's own selected company from the resolved scope, never the retired company relation",
  Effect.fn(function* personInSelectedCompany() {
    // Scope resolution already refused any company this person may not select (O28).
    const own = yield* runSelectedCompanyRead({ kind: 'legal_entity' }, 'human');
    expect(Exit.isSuccess(own.outcome)).toBe(true);
    expect(own.asked).toEqual([]);
  }),
);

it.effect(
  'asks the retired company relation for another company and for an explicit permission on the own company',
  Effect.fn(function* legacyTargetsStayLegacy() {
    const other = yield* runSelectedCompanyRead({ kind: 'legal_entity', legalEntityId: otherCompanyId }, 'human');
    expect(deniedByLegacyRelation(other.outcome)).toBe(true);
    expect(other.asked).toEqual([otherCompanyId]);
    const explicit = yield* runSelectedCompanyRead({ kind: 'legal_entity', permission: 'manage_people' }, 'human');
    expect(deniedByLegacyRelation(explicit.outcome)).toBe(true);
    expect(explicit.asked).toEqual([selectedCompanyId]);
    expect(explicit.permission).toBe('manage_people');
  }),
);

it.effect(
  'keeps the retired company relation for a workload, an agent or an unreadable kind in its own company',
  Effect.fn(function* nonPersonInSelectedCompany() {
    // A workload behind a verified module call may select every company of its tenant, so its scope proves nothing.
    for (const kind of ['service', 'agent', undefined] as const) {
      const run = yield* runSelectedCompanyRead({ kind: 'legal_entity' }, kind);
      expect(deniedByLegacyRelation(run.outcome)).toBe(true);
      expect(run.asked).toEqual([selectedCompanyId]);
    }
  }),
);

it.effect(
  'never answers a bare company alternative inside any_of from the resolved scope',
  Effect.fn(function* selectedCompanyAlternative() {
    const run = yield* runSelectedCompanyRead(
      { kind: 'any_of', targets: [{ kind: 'legal_entity' }, { kind: 'module', moduleId: 'core.identity' }] },
      'human',
    );
    expect(deniedByLegacyRelation(run.outcome)).toBe(true);
    expect(run.asked).toEqual([selectedCompanyId]);
  }),
);

const counterpartyReadPrincipal = (legalEntityId: string) => ({
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:read-runtime',
  authMethod: 'session' as const,
  legalEntityId,
  principalId: scope.principalId,
  tenantId: scope.tenantId,
});

it.effect(
  'checks conjunctive business and Resource read permissions before disclosure',
  Effect.fn(function* checksConjunctiveReadPermissions() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    const input = {
      authorizationProfileId: 'retail-authority-profile-a',
      requestedProfileId: 'retail-requested-profile-b',
    };
    const observed: string[] = [];
    let handlerCalls = 0;
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)(
      'retail.settings.payment_term_preference.manage',
    );
    const currencyRead = defineRead(
      {
        accessDeclaration: fixtureReadAccess('commerce.customer-context'),
        accessKind: 'detail',
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read',
          authorization: {
            kind: 'context_permission',
            permission: 'module.access',
          },
          entrypointKey: 'commerce.customer-context.payment-term-preference',
          moduleKey: 'commerce.customer-context',
          role: 'api',
        }),
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'commerce.customer-context.payment-term-preference.v1',
        },
        inputSchema: CurrencyReadInputSchema,
        legalEntityScope: 'required',
        owningModuleKey: 'commerce.customer-context',
        permissionTarget: 'owner_permission',
        policies: [],
        readKey: 'commerce.customer-context.payment-term-preference',
        resourcePermission: defineReadResourcePermission<CurrencyReadInput>(({ requestedProfileId }) => ({
          permission: 'read',
          resource: {
            moduleId: 'commerce.customer-context',
            resourceId: requestedProfileId,
            resourceType: 'retail-profile',
          },
        })),
        resultSchema: Schema.String,
        schemaVersion: '1',
      },
      () => {
        observed.push('handler');
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 1 }, result: 'CZK' });
      },
      () => Effect.succeed({}),
      defineReadOwnerPermission(historicalOwnerContract(permission), ({ authorizationProfileId }, trustedScope) =>
        historicalOwnerReadTarget(permission, {
          kind: 'retail_profile',
          legalEntityId: trustedScope.legalEntityId ?? '',
          profileId: authorizationProfileId,
          tenantId: trustedScope.tenantId,
        }),
      ),
    );
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
      harness.runtime.runRead({
        input,
        principal: counterpartyReadPrincipal(legalEntityId),
        registration: currencyRead,
        transport: { correlationId: scope.correlationId },
      });
    const allowed = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      onBusinessPermissionTarget: (target) => {
        expect(target).toEqual({
          permission,
          target: {
            kind: 'retail_profile',
            legalEntityId,
            profileId: input.authorizationProfileId,
            tenantId: scope.tenantId,
          },
        });
        observed.push('business_permission');
      },
      onResourcePermission: (resourcePermission) => {
        observed.push(`resource_permission:${resourcePermission ?? 'missing'}`);
      },
      onResourceTarget: (target) => {
        expect(target).toEqual({
          moduleId: 'commerce.customer-context',
          resourceId: input.requestedProfileId,
          resourceType: 'retail-profile',
        });
      },
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
      resourcePermissionDecision: 'allowed',
    });
    expect(yield* run(allowed)).toBe('CZK');
    expect(observed).toEqual(['business_permission', 'resource_permission:read', 'handler']);

    const ownerMissing = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      omitOwnerAuthorizationOverlay: true,
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
      resourcePermissionDecision: 'allowed',
    });
    const ownerMissingFailure = yield* Effect.flip(run(ownerMissing));
    expect(Predicate.isTagged(ownerMissingFailure, 'ReadPermissionUnavailable')).toBe(true);
    expect(ownerMissing.permissionChecks()).toEqual({
      businessPermissionChecks: 1,
      contextPermissionChecks: 0,
      resourcePermissionChecks: 1,
    });
    expect(handlerCalls).toBe(1);

    const businessDenied = yield* makeHarness({
      businessPermissionDecision: 'denied',
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
      resourcePermissionDecision: 'allowed',
    });
    expect(Predicate.isTagged(yield* Effect.flip(run(businessDenied)), 'ReadPermissionDenied')).toBe(true);
    expect(businessDenied.permissionChecks()).toEqual({
      businessPermissionChecks: 1,
      contextPermissionChecks: 0,
      resourcePermissionChecks: 1,
    });

    const resourceDenied = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
      resourcePermissionDecision: 'denied',
    });
    expect(Predicate.isTagged(yield* Effect.flip(run(resourceDenied)), 'ReadPermissionDenied')).toBe(true);
    expect(resourceDenied.permissionChecks()).toEqual({
      businessPermissionChecks: 1,
      contextPermissionChecks: 0,
      resourcePermissionChecks: 1,
    });

    const businessUnavailable = yield* makeHarness({
      businessPermissionDecision: 'unavailable',
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
      resourcePermissionDecision: 'allowed',
    });
    expect(Predicate.isTagged(yield* Effect.flip(run(businessUnavailable)), 'ReadPermissionUnavailable')).toBe(true);
    expect(businessUnavailable.permissionChecks()).toEqual({
      businessPermissionChecks: 1,
      contextPermissionChecks: 0,
      resourcePermissionChecks: 1,
    });

    const resourceUnavailable = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
      resourcePermissionDecision: 'unavailable',
    });
    expect(Predicate.isTagged(yield* Effect.flip(run(resourceUnavailable)), 'ReadPermissionUnavailable')).toBe(true);
    expect(resourceUnavailable.permissionChecks()).toEqual({
      businessPermissionChecks: 1,
      contextPermissionChecks: 0,
      resourcePermissionChecks: 1,
    });
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('rejects payload Storefront promotion and requires an exact trusted scope match', () =>
  Effect.gen(function* checkTrustedStorefrontReadScope() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)('counterparty.order_history.read');
    const StorefrontCounterpartyIdSchema = Schema.String.pipe(Schema.brand('StorefrontCounterpartyId'));
    const StorefrontIdSchema = Schema.String.pipe(Schema.brand('StorefrontId'));
    const StorefrontInputSchema = Schema.Struct({
      counterpartyId: StorefrontCounterpartyIdSchema,
      storefrontId: StorefrontIdSchema,
    });
    let handlerCalls = 0;
    const storefrontRead = defineRead(
      {
        accessDeclaration: fixtureReadAccess('commerce.customer-context'),
        accessKind: 'list',
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read',
          authorization: {
            kind: 'context_permission',
            permission: 'module.access',
          },
          entrypointKey: 'commerce.customer-context.storefront-orders',
          moduleKey: 'commerce.customer-context',
          role: 'api',
        }),
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'commerce.customer-context.storefront-orders.v1',
        },
        inputSchema: StorefrontInputSchema,
        legalEntityScope: 'required',
        owningModuleKey: 'commerce.customer-context',
        permissionTarget: 'owner_permission',
        policies: [],
        readKey: 'commerce.customer-context.storefront-orders',
        resultSchema: Schema.Array(Schema.String),
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
      () => Effect.succeed({}),
      defineReadOwnerPermission(historicalOwnerContract(permission), ({ counterpartyId, storefrontId }, trustedScope) =>
        historicalOwnerReadTarget(permission, {
          counterpartyId,
          kind: 'counterparty_storefront',
          legalEntityId: trustedScope.legalEntityId ?? '',
          storefrontId,
          tenantId: trustedScope.tenantId,
        }),
      ),
    );
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, storefrontId: string) =>
      harness.runtime.runRead({
        input: { counterpartyId: 'counterparty-1', storefrontId },
        principal: counterpartyReadPrincipal(legalEntityId),
        registration: storefrontRead,
        transport: { correlationId: scope.correlationId },
      });

    const untrusted = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
    });
    expect(Exit.isFailure(yield* Effect.exit(run(untrusted, 'storefront-a')))).toBe(true);
    expect(untrusted.permissionChecks().businessPermissionChecks).toBe(0);

    const mismatch = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      permissionDecision: 'allowed',
      resolvedScope: trustVerifiedGatewayPrincipalContext(
        {
          ...scope,
          legalEntityId,
          trustedStorefrontId: 'storefront-a',
        },
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    });
    expect(Exit.isFailure(yield* Effect.exit(run(mismatch, 'storefront-b')))).toBe(true);
    expect(mismatch.permissionChecks().businessPermissionChecks).toBe(0);

    const observedTrustedStorefrontIds: (string | undefined)[] = [];
    const allowed = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      onTrustedStorefrontId: (value) => observedTrustedStorefrontIds.push(value),
      permissionDecision: 'allowed',
      resolvedScope: trustVerifiedGatewayPrincipalContext(
        {
          ...scope,
          legalEntityId,
          trustedStorefrontId: 'storefront-a',
        },
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    });
    expect(yield* run(allowed, 'storefront-a')).toEqual([]);
    expect(observedTrustedStorefrontIds).toEqual(['storefront-a']);
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('governs tenant-only Price Group reads with stable target evidence and fail-closed outcomes', () =>
  Effect.gen(function* governsPriceGroupRead() {
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)('pricing.price_group.read');
    const counterpartyPermission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)(
      'counterparty.order_history.read',
    );
    const PriceGroupIdSchema = Schema.String.pipe(Schema.brand('PriceGroupId'));
    const PricingCatalogIdSchema = Schema.String.pipe(Schema.brand('PricingCatalogId'));
    const TargetTenantIdSchema = Schema.String.pipe(Schema.brand('TargetTenantId'));
    const InputSchema = Schema.Struct({
      priceGroupId: PriceGroupIdSchema,
      pricingCatalogId: PricingCatalogIdSchema,
      targetTenantId: TargetTenantIdSchema,
    });
    let handlerCalls = 0;
    const makePriceGroupRead = (targetPermission: typeof permission) =>
      defineRead(
        {
          accessDeclaration: fixtureReadAccess('pricing.price-group-catalog'),
          accessKind: 'detail',
          entrypoint: defineTenantModuleEntrypoint({
            access: 'read',
            authorization: {
              kind: 'context_permission',
              permission: 'pricing.price-group.read',
            },
            entrypointKey: 'pricing.price-group.read',
            moduleKey: 'pricing.price-group-catalog',
            role: 'api',
          }),
          evidencePolicy: {
            captureMode: 'metadata_only',
            policyKey: 'pricing.price-group.read.v1',
          },
          inputSchema: InputSchema,
          legalEntityScope: 'forbidden',
          owningModuleKey: 'pricing.price-group-catalog',
          permissionTarget: 'owner_permission',
          policies: [],
          readKey: 'pricing.price-group.read',
          resultSchema: Schema.String,
          schemaVersion: '1',
        },
        ({ priceGroupId: handledPriceGroupId }) => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 1 }, result: handledPriceGroupId });
        },
        () => Effect.succeed({}),
        defineReadOwnerPermission(historicalOwnerContract(permission), (input) =>
          historicalOwnerReadTarget(targetPermission, {
            kind: 'price_group',
            priceGroupId: input.priceGroupId,
            pricingCatalogId: input.pricingCatalogId,
            tenantId: input.targetTenantId,
          }),
        ),
      );
    const read = makePriceGroupRead(permission);
    const input = {
      priceGroupId,
      pricingCatalogId,
      targetTenantId: scope.tenantId,
    };
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, nextInput = input) =>
      harness.runtime.runRead({
        input: nextInput,
        principal: scope,
        registration: read,
        transport: { correlationId: scope.correlationId },
      });

    const first = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      contextPermissionDecision: 'allowed',
    });
    const second = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      contextPermissionDecision: 'allowed',
    });
    expect(yield* run(first)).toBe(priceGroupId);
    expect(yield* run(second)).toBe(priceGroupId);
    expect(first.evidenceRows()[0]?.queryHash).toBe(second.evidenceRows()[0]?.queryHash);
    const evidenceValues = first.evidenceParameterRows()[0] ?? [];
    expect(evidenceValues).toContain(permission);
    expect(evidenceValues).toContain(`${pricingCatalogId}:${priceGroupId}`);
    expect(evidenceValues).toContain('price_group');

    const wrongPriceGroup = yield* makeHarness({
      businessPermissionDecision: 'denied',
      contextPermissionDecision: 'allowed',
    });
    expect(
      Predicate.isTagged(
        yield* Effect.flip(
          run(wrongPriceGroup, {
            ...input,
            priceGroupId: otherPriceGroupId,
          }),
        ),
        'ReadPermissionDenied',
      ),
    ).toBe(true);

    const crossTenant = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      contextPermissionDecision: 'allowed',
    });
    expect(
      Predicate.isTagged(
        yield* Effect.flip(
          run(crossTenant, {
            ...input,
            targetTenantId: '00000000-0000-4000-8000-000000000099',
          }),
        ),
        'ReadPermissionUnavailable',
      ),
    ).toBe(true);
    expect(crossTenant.permissionChecks().businessPermissionChecks).toBe(0);

    const unavailable = yield* makeHarness({
      businessPermissionDecision: 'unavailable',
      contextPermissionDecision: 'allowed',
    });
    expect(Predicate.isTagged(yield* Effect.flip(run(unavailable)), 'ReadPermissionUnavailable')).toBe(true);

    for (const invalidInput of [
      { ...input, priceGroupId: 'DEALER' },
      { ...input, pricingCatalogId: 'DEALER' },
    ]) {
      const invalidIdentifier = yield* makeHarness({
        businessPermissionDecision: 'allowed',
        contextPermissionDecision: 'allowed',
      });
      expect(
        Predicate.isTagged(yield* Effect.flip(run(invalidIdentifier, invalidInput)), 'ReadPermissionUnavailable'),
      ).toBe(true);
      expect(invalidIdentifier.permissionChecks().businessPermissionChecks).toBe(0);
      expect(invalidIdentifier.evidence()).toBe(0);
    }

    const mismatchedPermission = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      contextPermissionDecision: 'allowed',
    });
    expect(
      Predicate.isTagged(
        yield* Effect.flip(
          mismatchedPermission.runtime.runRead({
            input,
            principal: scope,
            registration: makePriceGroupRead(counterpartyPermission),
            transport: { correlationId: scope.correlationId },
          }),
        ),
        'ReadHandlerExecutionError',
      ),
    ).toBe(true);
    expect(mismatchedPermission.permissionChecks().businessPermissionChecks).toBe(0);
    expect(mismatchedPermission.evidence()).toBe(0);
    expect(handlerCalls).toBe(2);
  }),
);

it.effect('governs one exact Inventory Resource read without deriving authority from selected context', () =>
  Effect.gen(function* governsInventoryResourceRead() {
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)('inventory.resource.read');
    const InventoryResourceIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('InventoryResourceId'));
    const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('InventoryReadTenantId'));
    const InputSchema = Schema.Struct({
      resourceId: InventoryResourceIdSchema,
      tenantId: TenantIdSchema,
    });
    let handlerCalls = 0;
    const read = defineRead(
      {
        accessDeclaration: fixtureReadAccess('commerce.inventory'),
        accessKind: 'detail',
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'context_permission', permission: 'inventory.resource.read' },
          entrypointKey: 'commerce.inventory.stock-position.read',
          moduleKey: 'commerce.inventory',
          role: 'api',
        }),
        evidencePolicy: { captureMode: 'metadata_only', policyKey: 'inventory.resource.read.v1' },
        inputSchema: InputSchema,
        legalEntityScope: 'optional',
        owningModuleKey: 'commerce.inventory',
        permissionTarget: 'owner_permission',
        policies: [],
        readKey: 'commerce.inventory.stock-position.read',
        resultSchema: Schema.String,
        schemaVersion: '1',
      },
      ({ resourceId }) => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 1 }, result: resourceId });
      },
      () => Effect.succeed(Object.freeze({})),
      defineReadOwnerPermission(historicalOwnerContract(permission), (input) =>
        historicalOwnerReadTarget(permission, {
          kind: 'inventory_resource',
          resource: {
            moduleId: 'commerce.inventory',
            resourceId: input.resourceId,
            resourceType: 'commerce.inventory.stock-position',
          },
          tenantId: input.tenantId,
        }),
      ),
    );
    const resourceId = '70000000-0000-4000-8000-000000000001';
    const input = { resourceId, tenantId: scope.tenantId };
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, nextInput?: typeof input) =>
      harness.runtime.runRead({
        input: nextInput ?? input,
        principal: scope,
        registration: read,
        transport: { correlationId: scope.correlationId },
      });

    const allowed = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      contextPermissionDecision: 'allowed',
    });
    expect(yield* run(allowed)).toBe(resourceId);
    const evidenceValues = allowed.evidenceParameterRows()[0] ?? [];
    expect(evidenceValues).toContain(resourceId);
    expect(evidenceValues).toContain('commerce.inventory.stock-position');

    const crossTenant = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      contextPermissionDecision: 'allowed',
    });
    expect(
      Predicate.isTagged(
        yield* Effect.flip(run(crossTenant, { ...input, tenantId: '00000000-0000-4000-8000-000000000099' })),
        'ReadPermissionUnavailable',
      ),
    ).toBe(true);
    expect(crossTenant.permissionChecks().businessPermissionChecks).toBe(0);
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('persists sanitized permission denial and never invokes the private handler', () =>
  Effect.gen(function* migratedTest11() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    const legalEntityPermissions: (string | undefined)[] = [];
    const harness = yield* makeHarness({
      onLegalEntityPermission: (permission) => legalEntityPermissions.push(permission),
      permissionDecision: 'denied',
      resolvedScope: { ...scope, legalEntityId },
    });
    let handlerCalls = 0;
    const deniedRegistration = counterpartyReadRegistration('required', () => {
      handlerCalls += 1;
    });
    const error = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: counterpartyReadPrincipal(legalEntityId),
        registration: deniedRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(error, 'ReadPermissionDenied')).toBe(true);
    expect(legalEntityPermissions).toEqual(['read_counterparty']);
    expect(handlerCalls).toBe(0);
    expect(harness.evidence()).toBe(1);
  }),
);
it.effect('fails closed when explicit Counterparty read authority is unavailable', () =>
  Effect.gen(function* migratedTest12() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    let handlerCalls = 0;
    const harness = yield* makeHarness({
      permissionDecision: 'unavailable',
      resolvedScope: { ...scope, legalEntityId },
    });
    const counterpartyRead = counterpartyReadRegistration('optional', () => {
      handlerCalls += 1;
    });
    const error = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: counterpartyReadPrincipal(legalEntityId),
        registration: counterpartyRead,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(error, 'ReadPermissionUnavailable')).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(harness.evidence()).toBe(0);
  }),
);
it.effect('derives the authorized resource from decoded input and ignores conflicting transport hints', () =>
  Effect.gen(function* migratedTest13() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    let authorizedTarget: { moduleId: string; resourceId: string; resourceType: string } | undefined;
    const harness = yield* makeHarness({
      onResourceTarget: (target) => {
        authorizedTarget = target;
      },
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
    });
    const target = {
      moduleId: 'inventory.stock',
      resourceId: 'stock-1',
      resourceType: 'inventory.stock.item',
    };
    const targetRegistration = defineRead(
      {
        ...registration().descriptor,
        inputSchema: ResourceTargetSchema,
        legalEntityScope: 'required',
        permissionTarget: 'resource',
        resultSchema: Schema.String,
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'visible' }),
      () => Effect.succeed({}),
      (input) => ({ kind: 'resource', resource: input }),
    );
    const result = yield* harness.runtime.runRead({
      input: target,
      principal: {
        ...scope,
        authBindingId: '00000000-0000-4000-8000-000000000005',
        authContextRef: 'better-auth-session:read-runtime',
        authMethod: 'session',
        legalEntityId,
      },
      registration: targetRegistration,
      transport: {
        correlationId: scope.correlationId,
        targetModuleKey: 'forged.module',
        targetResourceId: 'forged-resource',
        targetResourceType: 'forged.type',
      },
    });
    expect(result).toBe('visible');
    expect(authorizedTarget).toEqual(target);
  }),
);
it.effect('authorizes a canonical Resource through explicit tenant Party administration alternatives', () =>
  Effect.gen(function* migratedTest14() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    const target = {
      moduleId: 'party.registry',
      resourceId: 'counterparty-1',
      resourceType: 'counterparty',
    };
    const policyTargets: unknown[] = [];
    const policy = defineGlobalPolicy<typeof target>({
      evaluate: ({ target: policyTarget }) => {
        policyTargets.push(policyTarget);
        return Effect.void;
      },
      policyKey: 'party.registry.counterparty-read.v1',
    });
    let handlerCalls = 0;
    const counterpartyRead = defineRead(
      {
        ...registration().descriptor,
        inputSchema: ResourceTargetSchema,
        legalEntityScope: 'required',
        permissionTarget: 'resource',
        policies: [{ denialStatus: 422, policyKey: policy.policyKey }],
        resultSchema: Schema.String,
      },
      () => {
        handlerCalls += 1;
        return Effect.succeed({
          evidence: { resultCount: 1 },
          result: 'visible',
        });
      },
      () => Effect.succeed({}),
      (input) => ({
        kind: 'any_of',
        targets: [
          { kind: 'resource', resource: input },
          { kind: 'tenant', permission: 'manage_party_identity' },
        ],
      }),
      undefined,
      [policy],
    );
    const principal = {
      ...scope,
      authBindingId: '00000000-0000-4000-8000-000000000005',
      authContextRef: 'better-auth-session:read-runtime',
      authMethod: 'session' as const,
      legalEntityId,
    };

    const tenantAdmin = yield* makeHarness({
      permissionDecision: 'denied',
      tenantPermissionDecision: 'allowed',
    });
    expect(
      yield* tenantAdmin.runtime.runRead({
        input: target,
        principal: scope,
        registration: counterpartyRead,
        transport: {
          correlationId: scope.correlationId,
          targetModuleKey: 'forged.module',
          targetResourceId: 'forged-resource',
          targetResourceType: 'forged.type',
        },
      }),
    ).toBe('visible');
    expect(policyTargets).toEqual([
      {
        targetModuleKey: 'party.registry',
        targetResourceId: 'counterparty-1',
        targetResourceType: 'counterparty',
      },
    ]);

    const resourceAuthority = yield* makeHarness({
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
      tenantPermissionDecision: 'denied',
    });
    expect(
      yield* resourceAuthority.runtime.runRead({
        input: target,
        principal,
        registration: counterpartyRead,
        transport: { correlationId: scope.correlationId },
      }),
    ).toBe('visible');

    const indeterminate = yield* makeHarness({
      modulePermissionDecision: 'allowed',
      permissionDecision: 'denied',
      resolvedScope: { ...scope, legalEntityId },
      tenantPermissionDecision: 'unavailable',
    });
    const unavailable = yield* Effect.flip(
      indeterminate.runtime.runRead({
        input: target,
        principal,
        registration: counterpartyRead,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(unavailable, 'ReadPermissionUnavailable')).toBe(true);
    expect(indeterminate.evidence()).toBe(0);

    const denied = yield* makeHarness({
      modulePermissionDecision: 'allowed',
      permissionDecision: 'denied',
      resolvedScope: { ...scope, legalEntityId },
      tenantPermissionDecision: 'denied',
    });
    const denial = yield* Effect.flip(
      denied.runtime.runRead({
        input: target,
        principal,
        registration: counterpartyRead,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(denial, 'ReadPermissionDenied')).toBe(true);
    expect(denied.evidence()).toBe(1);
    expect(handlerCalls).toBe(2);
  }),
);
it.effect('rejects generic tenant access as an alternative permission target', () =>
  Effect.gen(function* migratedTest15() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    let handlerCalls = 0;
    const invalid = defineRead(
      {
        ...registration().descriptor,
        legalEntityScope: 'required',
        permissionTarget: 'resource',
      },
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
      () => Effect.succeed({}),
      () =>
        // SAFETY: This intentionally forges a runtime-invalid alternative to prove validation fails closed.
        ({
          kind: 'any_of',
          targets: [
            {
              kind: 'resource',
              resource: {
                moduleId: 'party.registry',
                resourceId: 'counterparty-1',
                resourceType: 'counterparty',
              },
            },
            { kind: 'tenant', permission: 'access' },
          ],
        }) as never,
    );
    const failure = yield* Effect.flip(
      (yield* makeHarness({
        resolvedScope: { ...scope, legalEntityId },
      })).runtime.runRead({
        input: {},
        principal: {
          ...scope,
          authBindingId: '00000000-0000-4000-8000-000000000005',
          authContextRef: 'better-auth-session:read-runtime',
          authMethod: 'session',
          legalEntityId,
        },
        registration: invalid,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerExecutionError')).toBe(true);
    expect(handlerCalls).toBe(0);
  }),
);
for (const scenario of [
  {
    expectedFailure: 'ReadPermissionUnavailable',
    name: 'never treats missing Legal Entity scope as an allowed alternative',
    permission: 'manage_party_identity',
    resultTargets: null,
    tenantPermissionDecision: 'denied',
  },
  {
    expectedFailure: 'ReadHandlerExecutionError',
    name: 'rejects alternative targets whenever result authorization cannot preserve them',
    permission: 'read_party_identity',
    resultTargets: () => [],
    tenantPermissionDecision: 'allowed',
  },
] as const) {
  it.effect(scenario.name, () =>
    Effect.gen(function* tableScenario() {
      let handlerCalls = 0;
      const alternativeRead = defineRead(
        { ...registration().descriptor, permissionTarget: 'tenant' },
        () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
        () => Effect.succeed({}),
        () => ({
          kind: 'any_of',
          targets: [
            { kind: 'tenant', permission: scenario.permission },
            { kind: 'module', moduleId: 'party.registry' },
          ],
        }),
        scenario.resultTargets ?? undefined,
      );
      const failure = yield* Effect.flip(
        (yield* makeHarness({
          tenantPermissionDecision: scenario.tenantPermissionDecision,
        })).runtime.runRead({
          input: {},
          principal: scope,
          registration: alternativeRead,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Predicate.isTagged(failure, scenario.expectedFailure)).toBe(true);
      expect(handlerCalls).toBe(0);
    }),
  );
}

for (const scenario of [
  {
    expectedEvidence: 0,
    expectedFailure: 'ReadEvidenceValidationError',
    name: 'rejects handler-controlled hashes in metadata-only evidence',
    outcome: Effect.succeed({
      evidence: { queryHash: 'raw query text', resultCount: 1 },
      result: [],
    }),
  },
  {
    expectedEvidence: 1,
    expectedFailure: 'ReadPermissionDenied',
    name: 'persists late definite denial after rolling back the owner transaction',
    outcome: Effect.fail(
      new ReadPermissionDenied({
        code: 'read_permission_denied',
        reason: 'A late provider target check denied this read',
      }),
    ),
  },
]) {
  it.effect(scenario.name, () =>
    Effect.gen(function* tableScenario() {
      const harness = yield* makeHarness();
      const failingRead = defineRead(
        registration().descriptor,
        () => scenario.outcome,
        () => Effect.succeed({}),
        () => ({ kind: 'module', moduleId: 'core.shell' }),
      );
      const error = yield* Effect.flip(
        harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: failingRead,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Predicate.isTagged(error, scenario.expectedFailure)).toBe(true);
      expect(harness.evidence()).toBe(scenario.expectedEvidence);
    }),
  );
}

it.effect('does not release generated search candidates denied by result-level authorization', () =>
  Effect.gen(function* migratedTest20() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    const candidate = yield* Schema.decodeEffect(ResourceTargetSchema)({
      moduleId: 'inventory.stock',
      resourceId: 'stock-1',
      resourceType: 'inventory.stock.item',
    });
    const harness = yield* makeHarness({
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
      resultPermissionDecision: 'denied',
    });
    const searchRegistration = defineRead(
      {
        ...registration().descriptor,
        legalEntityScope: 'required',
        resultSchema: Schema.Array(ResourceTargetSchema),
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: [candidate] }),
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
      (result) => result,
    );
    const error = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: {
          ...scope,
          authBindingId: '00000000-0000-4000-8000-000000000005',
          authContextRef: 'better-auth-session:read-runtime',
          authMethod: 'session',
          legalEntityId,
        },
        registration: searchRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(error, 'ReadPermissionDenied')).toBe(true);
    expect(harness.evidence()).toBe(1);
  }),
);
it.effect('authorizes tenant-scoped Party search results without fabricating a Legal Entity', () =>
  Effect.gen(function* migratedTest21() {
    const candidate = yield* Schema.decodeEffect(ResourceTargetSchema)({
      moduleId: 'party.registry',
      resourceId: 'party-1',
      resourceType: 'party.registry.party',
    });
    let resourceChecks = 0;
    const tenantPermissions: string[] = [];
    const harness = yield* makeHarness({
      onResourceTarget: () => {
        resourceChecks += 1;
      },
      onTenantPermission: (permission) => tenantPermissions.push(permission),
      permissionDecision: 'allowed',
    });
    const searchRegistration = defineRead(
      {
        ...registration().descriptor,
        accessKind: 'search',
        legalEntityScope: 'optional',
        permissionTarget: 'tenant',
        resultSchema: Schema.Array(ResourceTargetSchema),
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: [candidate] }),
      () => Effect.succeed({}),
      () => ({ kind: 'tenant', permission: 'read_party_identity' }),
      (result) => result,
    );

    expect(
      yield* harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: searchRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ).toEqual([candidate]);
    expect(tenantPermissions).toEqual(['read_party_identity', 'read_party_identity']);
    expect(resourceChecks).toBe(0);
  }),
);
it.effect('fails closed when tenant-scoped Party result authorization becomes unavailable', () =>
  Effect.gen(function* migratedTest22() {
    const candidate = yield* Schema.decodeEffect(ResourceTargetSchema)({
      moduleId: 'party.registry',
      resourceId: 'party-1',
      resourceType: 'party.registry.party',
    });
    const harness = yield* makeHarness({
      permissionDecision: 'allowed',
      resultTenantPermissionDecision: 'unavailable',
    });
    const searchRegistration = defineRead(
      {
        ...registration().descriptor,
        accessKind: 'search',
        legalEntityScope: 'optional',
        permissionTarget: 'tenant',
        resultSchema: Schema.Array(ResourceTargetSchema),
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: [candidate] }),
      () => Effect.succeed({}),
      () => ({ kind: 'tenant', permission: 'read_party_identity' }),
      (result) => result,
    );
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: searchRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(failure, 'ReadPermissionUnavailable')).toBe(true);
  }),
);
it.effect('preserves declared owner read availability and not-found failures but sanitizes defects', () =>
  Effect.gen(function* migratedTest23() {
    const failures = [
      new ReadHandlerUnavailable({
        code: 'read_handler_unavailable',
        reason: 'A provider is temporarily unavailable',
      }),
      new ReadHandlerNotFound({
        code: 'read_handler_not_found',
        reason: 'The resource does not exist',
      }),
      new Error('secret owner defect'),
    ] as const;
    const expectedTags = ['ReadHandlerUnavailable', 'ReadHandlerNotFound', 'ReadHandlerExecutionError'];
    yield* Effect.forEach(
      failures,
      (failure, index) =>
        Effect.gen(function* migratedTest24() {
          const harness = yield* makeHarness();
          const failingRegistration = defineRead(
            registration().descriptor,
            () => Effect.fail(failure),
            () => Effect.succeed({}),
            () => ({ kind: 'module', moduleId: 'core.shell' }),
          );
          const error = yield* Effect.flip(
            harness.runtime.runRead({
              input: {},
              principal: scope,
              registration: failingRegistration,
              transport: { correlationId: scope.correlationId },
            }),
          );
          const expectedTag = expectedTags[index];
          if (expectedTag === undefined) {
            expect.unreachable('Expected value to be present');
          }
          expect(Predicate.isTagged(error, expectedTag)).toBe(true);
          expect(error.reason).not.toMatch(/secret/u);
          expect(harness.evidence()).toBe(0);
        }),
      { concurrency: 'unbounded' },
    );
  }),
);
for (const mode of ['local', 'governed'] as const) {
  for (const Reason of [ConnectionError, ConstraintError, UniqueViolation, SqlSyntaxError, UnknownError] as const) {
    it.effect(`classifies ${mode} Read transaction ${Reason.name} without leaking driver details`, () =>
      Effect.gen(function* readTransactionSqlFailure() {
        const sqlEvents: string[] = [];
        const failure = new SqlError({
          reason: new Reason({ cause: new Error('private transaction detail'), constraint: 'test_unique_constraint' }),
        });
        const harness = yield* makeHarness({ sqlEvents, transactionSettlementFailure: failure });
        const error = yield* Effect.flip(
          harness.runtime.runRead({
            input: {},
            principal:
              mode === 'governed' ? trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision) : scope,
            registration: registration(['unreleased result']),
            transport: { correlationId: scope.correlationId },
          }),
        );
        expect(sqlEvents).toContain('COMMIT');
        expect(
          Predicate.isTagged(
            error,
            Reason === ConnectionError ? 'ReadHandlerUnavailable' : 'ReadHandlerExecutionError',
          ),
        ).toBe(true);
        expect(error.reason).not.toContain('private transaction detail');
        expect(error).toHaveProperty('cause', failure);
        expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
        expect(harness.authorityCounts()).toEqual({
          authorityLocks: mode === 'governed' ? 1 : 0,
          authorityReads: mode === 'governed' ? 1 : 0,
          // A verified request first settles its short admission transaction. If that commit fails,
          // no owner scope, service factory, handler or allowed evidence may run.
          scopeInstalls: mode === 'governed' ? 0 : 1,
        });
      }),
    );
  }
}
for (const mode of ['local', 'governed'] as const) {
  it.effect(`keeps ${mode} Read interruption and waits for transaction settlement`, () =>
    Effect.gen(function* migratedTest25() {
      const events: string[] = [];
      const sqlEvents: string[] = [];
      const harness = yield* makeHarness({ sqlEvents, transactionEvents: events });

      const entered = yield* Deferred.make<boolean>();
      const blocked = yield* Deferred.make<boolean>();
      const governed = defineRead(
        registration().descriptor,
        () =>
          Effect.gen(function* blockedReadHandler() {
            yield* Deferred.succeed(entered, true);
            yield* Deferred.await(blocked);
            return { evidence: { resultCount: 0 }, result: [] };
          }),
        () => Effect.succeed({}),
        () => ({ kind: 'module', moduleId: 'core.shell' }),
      );
      const fiber = yield* harness.runtime
        .runRead({
          input: {},
          principal:
            mode === 'governed' ? trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision) : scope,
          registration: governed,
          transport: { correlationId: scope.correlationId },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      events.push('read_completed');
      const exit = yield* Fiber.await(fiber);
      if (!Exit.isFailure(exit)) {
        expect.unreachable('Expected value to be present');
      }
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(events).toEqual(
        mode === 'governed'
          ? ['transaction_settled', 'transaction_settled', 'read_completed']
          : ['transaction_settled', 'read_completed'],
      );
      expect(sqlEvents).toContain('ROLLBACK');
      expect(sqlEvents.filter((statement) => statement === 'COMMIT')).toHaveLength(mode === 'governed' ? 1 : 0);
      expect(harness.authorityCounts()).toEqual({
        authorityLocks: mode === 'governed' ? 2 : 0,
        authorityReads: mode === 'governed' ? 2 : 0,
        scopeInstalls: 1,
      });
      expect(harness.evidence()).toBe(0);
    }),
  );
}
const protectedIdentityRead = <Failure>(
  handler: () => Effect.Effect<
    { readonly evidence: { readonly resultCount: number }; readonly result: { readonly name: string } },
    Failure
  >,
) =>
  defineRead(
    {
      accessDeclaration: fixtureReadAccess('core.shell'),
      accessKind: 'detail',
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'protected' },
        entrypointKey: 'core.shell.identity',
        moduleKey: 'core.shell',
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.shell.identity.v1' },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'forbidden',
      owningModuleKey: 'core.shell',
      permissionTarget: 'module',
      policies: [],
      readKey: 'core.shell.identity',
      resultSchema: Schema.Struct({ name: Schema.String }),
      schemaVersion: '1',
    },
    handler,
    () => Effect.succeed(Object.freeze({})),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );

/** Records whether Core incorrectly lends an owner SQL transaction to the standalone gate. */
const allowingGate = (decidedIn: (transaction: CoreTransaction | undefined) => void): BoundAccessGate => ({
  decide: (_input, transaction) =>
    Effect.sync(() => {
      decidedIn(transaction);
      return {
        evidence: [],
        outcome: 'ALLOWED' as const,
        reasons: [{ code: 'allow.actor_identity' as const }],
        selectors: [],
      };
    }),
  list: () => Effect.die('the identity read is not row-scoped'),
  selectableLegalEntities: () => Effect.succeed([]),
});

it.effect('authorizes outside owner SQL and preserves a governed Read typed owner failure', () =>
  Effect.gen(function* keepsDecisionOnTypedFailure() {
    const sqlEvents: string[] = [];
    const decidedIn: (CoreTransaction | undefined)[] = [];
    const notFound = new ReadHandlerNotFound({
      code: 'read_handler_not_found',
      reason: 'The subject is not recognised',
    });
    const harness = yield* makeHarness({
      accessDecision: allowingGate((transaction) => decidedIn.push(transaction)),
      sqlEvents,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runRead({
        input: {},
        principal: trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision),
        registration: protectedIdentityRead(() => Effect.fail(notFound)),
        transport: { correlationId: scope.correlationId },
      }),
    );
    // The canonical gate owns its scoped evidence. Core lends it no owner transaction, and the
    // failed owner load rolls back independently after the initial composition admission committed.
    expect(decidedIn).toEqual([undefined]);
    expect(sqlEvents).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK']);
    expect(harness.evidence()).toBe(0);
    expect(harness.checkedOutConnections()).toBe(0);
    if (!Exit.isFailure(exit)) {
      expect.unreachable('Expected a typed failure');
    }
    expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(notFound));
    expect(Cause.hasDies(exit.cause)).toBe(false);
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false);
  }),
);
it.effect('rolls back the governed owner load on a defect without holding the gate transaction', () =>
  Effect.gen(function* rollsBackDecisionOnDefect() {
    const sqlEvents: string[] = [];
    const decidedIn: (CoreTransaction | undefined)[] = [];
    const harness = yield* makeHarness({
      accessDecision: allowingGate((transaction) => decidedIn.push(transaction)),
      sqlEvents,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runRead({
        input: {},
        principal: trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision),
        registration: protectedIdentityRead(() => Effect.die(new Error('owner defect'))),
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(decidedIn).toEqual([undefined]);
    expect(sqlEvents).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK']);
    expect(harness.evidence()).toBe(0);
    expect(harness.checkedOutConnections()).toBe(0);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) {
      expect.unreachable('Expected a defect');
    }
    expect(Cause.hasDies(exit.cause)).toBe(true);
  }),
);
for (const mode of ['local', 'governed'] as const) {
  it.effect(`prioritizes failed ${mode} denial evidence while retaining permission denial in the cause`, () =>
    Effect.gen(function* migratedTest26() {
      const sqlEvents: string[] = [];
      const harness = yield* makeHarness({ failEvidence: true, sqlEvents });
      const denied = new ReadPermissionDenied({
        code: 'read_permission_denied',
        reason: 'Denied by read handler',
      });
      const governed = defineRead(
        registration().descriptor,
        () => Effect.fail(denied),
        () => Effect.succeed({}),
        () => ({ kind: 'module', moduleId: 'core.shell' }),
      );
      const exit = yield* Effect.exit(
        harness.runtime.runRead({
          input: {},
          principal:
            mode === 'governed' ? trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision) : scope,
          registration: governed,
          transport: { correlationId: scope.correlationId },
        }),
      );
      if (!Exit.isFailure(exit)) {
        expect.unreachable('Expected value to be present');
      }
      const failures = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
      expect(failures.length).toBe(2);
      expect(Predicate.isTagged(failures[0], 'ReadEvidencePersistenceError')).toBe(true);
      expect(failures[1]).toBe(denied);
      expect(Predicate.isTagged(failures[1], 'ReadPermissionDenied')).toBe(true);
      expect(sqlEvents).toContain('ROLLBACK');
      expect(sqlEvents.filter((statement) => statement === 'COMMIT')).toHaveLength(mode === 'governed' ? 1 : 0);
      expect(harness.authorityCounts()).toEqual({
        authorityLocks: mode === 'governed' ? 3 : 0,
        authorityReads: mode === 'governed' ? 3 : 0,
        scopeInstalls: 2,
      });
    }),
  );
}

it.effect('authorizes optional tenant Party Reads with a genuine tenant module permission without Legal Entity', () =>
  Effect.gen(function* authorizesTenantPartyRead() {
    let handlerCalls = 0;
    const targets: unknown[] = [];
    const read = defineRead(
      {
        ...registration().descriptor,
        accessDeclaration: fixtureReadAccess('party.registry'),
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'context_permission', permission: 'module.access' },
          entrypointKey: 'party.registry.api.party-detail',
          moduleKey: 'party.registry',
          role: 'api',
        }),
        legalEntityScope: 'optional',
        owningModuleKey: 'party.registry',
        permissionTarget: 'tenant',
      },
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 1 }, result: ['party'] });
      },
      () => Effect.succeed({}),
      () => ({ kind: 'tenant', permission: 'read_party_identity' }),
    );
    const harness = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      onContextPermissionTarget: (target) => targets.push(target),
      tenantPermissionDecision: 'allowed',
    });
    expect(
      yield* harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: read,
        transport: { correlationId: scope.correlationId },
      }),
    ).toEqual(['party']);
    expect(targets).toEqual([{ moduleId: 'party.registry', permission: 'module.access' }]);
    expect(handlerCalls).toBe(1);
    for (const [tenantPermissionDecision, contextPermissionDecision, tag] of [
      ['denied', 'allowed', 'ReadPermissionDenied'],
      ['allowed', 'denied', 'ReadPermissionDenied'],
      ['unavailable', 'allowed', 'ReadPermissionUnavailable'],
      ['allowed', 'unavailable', 'ReadPermissionUnavailable'],
    ] as const) {
      const rejected = yield* makeHarness({ contextPermissionDecision, tenantPermissionDecision });
      const failure = yield* Effect.flip(
        rejected.runtime.runRead({
          input: {},
          principal: scope,
          registration: read,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Predicate.isTagged(failure, tag)).toBe(true);
    }
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    const selectedLegalEntity = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      modulePermissionDecision: 'denied',
      resolvedScope: { ...scope, legalEntityId },
      tenantPermissionDecision: 'allowed',
    });
    const failure = yield* Effect.flip(
      selectedLegalEntity.runtime.runRead({
        input: {},
        principal: counterpartyReadPrincipal(legalEntityId),
        registration: read,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
    expect(selectedLegalEntity.permissionChecks().contextPermissionChecks).toBe(0);
    for (const legalEntityScope of ['required', 'forbidden'] as const) {
      const strict = defineRead(
        { ...read.descriptor, legalEntityScope },
        () => Effect.die('A strict-scope Read must not reach the handler'),
        () => Effect.succeed({}),
        () => ({ kind: 'tenant', permission: 'read_party_identity' }),
      );
      const strictScope = yield* makeHarness({
        contextPermissionDecision: 'allowed',
        tenantPermissionDecision: 'allowed',
      });
      expect(
        Predicate.isTagged(
          yield* Effect.flip(
            strictScope.runtime.runRead({
              input: {},
              principal: scope,
              registration: strict,
              transport: { correlationId: scope.correlationId },
            }),
          ),
          'ReadPermissionUnavailable',
        ),
      ).toBe(true);
      expect(strictScope.permissionChecks().contextPermissionChecks).toBe(0);
    }
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('enforces named entrypoint context permission before services and handler', () =>
  Effect.gen(function* enforcesNamedContextPermission() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    let serviceCalls = 0;
    let handlerCalls = 0;
    const observedTargets: unknown[] = [];
    const historyRead = defineRead(
      {
        ...registration().descriptor,
        accessDeclaration: fixtureReadAccess('commerce.customer-context'),
        entrypoint: defineTenantModuleEntrypoint({
          access: 'historical_read',
          authorization: {
            kind: 'context_permission',
            permission: 'customer.group.history.read',
          },
          entrypointKey: 'commerce.customer-context.customer-group-history',
          moduleKey: 'commerce.customer-context',
          role: 'api',
        }),
        legalEntityScope: 'required',
        owningModuleKey: 'commerce.customer-context',
        permissionTarget: 'resource',
      },
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
      () => {
        serviceCalls += 1;
        return Effect.succeed({});
      },
      () => ({
        kind: 'resource',
        resource: {
          moduleId: 'commerce.customer-context',
          resourceId: 'group-1',
          resourceType: 'customer-group',
        },
      }),
    );
    const principal = counterpartyReadPrincipal(legalEntityId);
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
      harness.runtime.runRead({
        input: {},
        principal,
        registration: historyRead,
        transport: { correlationId: scope.correlationId },
      });

    const allowed = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      onContextPermissionTarget: (target) => observedTargets.push(target),
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
    });
    expect(yield* run(allowed)).toEqual([]);
    expect(observedTargets).toEqual([
      {
        moduleId: 'commerce.customer-context',
        permission: 'customer.group.history.read',
      },
    ]);

    const denied = yield* makeHarness({
      contextPermissionDecision: 'denied',
      resolvedScope: { ...scope, legalEntityId },
      resourcePermissionDecision: 'unavailable',
    });
    expect(Predicate.isTagged(yield* Effect.flip(run(denied)), 'ReadPermissionDenied')).toBe(true);
    expect(denied.evidence()).toBe(1);

    const unavailable = yield* makeHarness({
      contextPermissionDecision: 'unavailable',
      resolvedScope: { ...scope, legalEntityId },
      resourcePermissionDecision: 'allowed',
    });
    expect(Predicate.isTagged(yield* Effect.flip(run(unavailable)), 'ReadPermissionUnavailable')).toBe(true);
    expect(unavailable.evidence()).toBe(0);
    expect(serviceCalls).toBe(1);
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('executes only the selected finite conditional authorization branch', () =>
  Effect.gen(function* executesConditionalAuthorizationBranch() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    const SubjectSchema = Schema.Union([
      Schema.Struct({ kind: Schema.Literal('GUEST') }),
      Schema.Struct({
        kind: Schema.Literal('PROFILE'),
        profileId: RetailRequestedProfileIdSchema,
      }),
    ]);
    const InputSchema = Schema.Struct({ subject: SubjectSchema });
    type Input = typeof InputSchema.Type;
    type Subject = typeof SubjectSchema.Type;
    const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)('retail.profile.read');
    const conditional = defineReadConditionalPermission<Input, Subject>({
      branches: {
        GUEST: {
          requiredKinds: ['module'],
          resolve: () => [{ kind: 'module', moduleId: 'commerce.customer-context' }],
        },
        PROFILE: {
          requiredKinds: ['owner_permission', 'resource_read'],
          resolve: (_input, subject, trustedScope) => [
            {
              kind: 'owner_permission',
              ownerPermission: historicalOwnerReadTarget(permission, {
                kind: 'retail_profile',
                legalEntityId: trustedScope.legalEntityId ?? '',
                profileId: subject.profileId,
                tenantId: trustedScope.tenantId,
              }),
            },
            {
              kind: 'resource_read',
              permission: 'read',
              resource: {
                moduleId: 'commerce.customer-context',
                resourceId: subject.profileId,
                resourceType: 'retail-customer-profile',
              },
            },
          ],
        },
      },
      ownerContract: historicalOwnerContract(permission),
      permissionKey: 'module.access',
      select: ({ subject }) => subject,
    });
    let handlerCalls = 0;
    const read = defineRead(
      {
        ...registration().descriptor,
        accessDeclaration: fixtureReadAccess('commerce.customer-context'),
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read',
          authorization: {
            kind: 'context_permission',
            permission: 'module.access',
          },
          entrypointKey: 'commerce.customer-context.profile-resolution',
          moduleKey: 'commerce.customer-context',
          role: 'api',
        }),
        inputSchema: InputSchema,
        legalEntityScope: 'required',
        owningModuleKey: 'commerce.customer-context',
        permissionTarget: 'conditional',
      },
      () => {
        handlerCalls += 1;
        return Effect.succeed({
          evidence: { resultCount: 1 },
          result: ['visible'],
        });
      },
      () => Effect.succeed({}),
      conditional,
    );
    const principal = counterpartyReadPrincipal(legalEntityId);
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, input: Input) =>
      harness.runtime.runRead({
        input,
        principal,
        registration: read,
        transport: { correlationId: scope.correlationId },
      });
    const profileId = yield* Schema.decodeEffect(RetailRequestedProfileIdSchema)('profile-1');

    const guest = yield* makeHarness({
      modulePermissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
    });
    expect(yield* run(guest, { subject: { kind: 'GUEST' } })).toEqual(['visible']);
    expect(guest.permissionChecks()).toEqual({
      businessPermissionChecks: 0,
      contextPermissionChecks: 0,
      resourcePermissionChecks: 0,
    });

    for (const decisions of [
      {
        businessPermissionDecision: 'denied',
        resourcePermissionDecision: 'allowed',
      },
      {
        businessPermissionDecision: 'allowed',
        resourcePermissionDecision: 'denied',
      },
      {
        businessPermissionDecision: 'unavailable',
        resourcePermissionDecision: 'allowed',
      },
      {
        businessPermissionDecision: 'allowed',
        resourcePermissionDecision: 'unavailable',
      },
    ] as const) {
      const harness = yield* makeHarness({
        ...decisions,
        modulePermissionDecision: 'allowed',
        resolvedScope: { ...scope, legalEntityId },
      });
      const failure = yield* Effect.flip(
        run(harness, {
          subject: { kind: 'PROFILE', profileId },
        }),
      );
      expect(
        Predicate.isTagged(
          failure,
          decisions.businessPermissionDecision === 'denied' || decisions.resourcePermissionDecision === 'denied'
            ? 'ReadPermissionDenied'
            : 'ReadPermissionUnavailable',
        ),
      ).toBe(true);
      expect(harness.permissionChecks().businessPermissionChecks).toBe(1);
      expect(harness.permissionChecks().resourcePermissionChecks).toBe(1);
    }
    expect(handlerCalls).toBe(1);
  }),
);

it.effect('preserves only schema-declared owner Read failures', () =>
  Effect.gen(function* preservesDeclaredDomainFailure() {
    class DeclaredReadFailure extends Schema.TaggedError<DeclaredReadFailure>()('DeclaredReadFailure', {
      reasonCode: Schema.Literal('PURPOSE_NOT_ALLOWED'),
    }) {}
    const declared = defineRead(
      { ...registration().descriptor, domainErrorSchema: DeclaredReadFailure },
      () => Effect.fail(new DeclaredReadFailure({ reasonCode: 'PURPOSE_NOT_ALLOWED' })),
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const failure = yield* Effect.flip(
      (yield* makeHarness()).runtime.runRead({
        input: {},
        principal: scope,
        registration: declared,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(failure, 'DeclaredReadFailure')).toBe(true);
    expect((yield* Schema.decodeUnknownEffect(DeclaredReadFailure)(failure)).reasonCode).toBe('PURPOSE_NOT_ALLOWED');
  }),
);

it.effect('keeps exact count and order for a three-position conditional plan', () =>
  Effect.gen(function* validatesRepeatedResourcePositions() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    const InputSchema = Schema.Struct({ kind: Schema.Literals(['PROFILE', 'GUEST']) });
    const moduleRequirement = { kind: 'module', moduleId: 'core.shell' } as const;
    const profileRequirement = {
      kind: 'resource_read',
      permission: 'read',
      resource: { moduleId: 'core.shell', resourceId: 'profile-1', resourceType: 'profile' },
    } as const;
    const addressRequirement = {
      kind: 'resource_read',
      permission: 'read',
      resource: { moduleId: 'core.shell', resourceId: 'address-1', resourceType: 'address' },
    } as const;
    for (const resolvedPlan of ['exact', 'short', 'long', 'reordered'] as const) {
      let handlerCalls = 0;
      const targets: string[] = [];
      const read = defineRead(
        { ...registration().descriptor, inputSchema: InputSchema, permissionTarget: 'conditional' },
        () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 1 }, result: ['visible'] });
        },
        () => Effect.succeed({}),
        defineReadConditionalPermission<typeof InputSchema.Type, typeof InputSchema.Type>({
          branches: {
            GUEST: { requiredKinds: ['module'], resolve: () => [moduleRequirement] },
            PROFILE: {
              requiredKinds: ['module', 'resource_read', 'resource_read'],
              resolve: () => {
                if (resolvedPlan === 'short') {
                  return [moduleRequirement, profileRequirement];
                }
                if (resolvedPlan === 'long') {
                  return [moduleRequirement, profileRequirement, addressRequirement, addressRequirement];
                }
                if (resolvedPlan === 'reordered') {
                  return [profileRequirement, moduleRequirement, addressRequirement];
                }
                return [moduleRequirement, profileRequirement, addressRequirement];
              },
            },
          },
          permissionKey: 'module.access',
          select: (input) => input,
        }),
      );
      const harness = yield* makeHarness({
        modulePermissionDecision: 'allowed',
        onResourceTarget: ({ resourceId }) => targets.push(resourceId),
        resolvedScope: { ...scope, legalEntityId },
        resourcePermissionDecision: 'allowed',
      });
      const result = harness.runtime.runRead({
        input: { kind: 'PROFILE' },
        principal: counterpartyReadPrincipal(legalEntityId),
        registration: read,
        transport: { correlationId: scope.correlationId },
      });
      if (resolvedPlan === 'exact') {
        expect(yield* result).toEqual(['visible']);
        expect(targets).toEqual(['profile-1', 'address-1']);
        expect(handlerCalls).toBe(1);
      } else {
        expect(Predicate.isTagged(yield* Effect.flip(result), 'ReadHandlerExecutionError')).toBe(true);
        expect(targets).toEqual([]);
        expect(handlerCalls).toBe(0);
      }
    }
  }),
);

it.effect('fails a metadata-less synthetic Read closed before permission and handler work', () =>
  Effect.gen(function* unknownReadOwnerMetadata() {
    const harness = yield* makeHarness({ omitOwnerRegistration: true, permissionDecision: 'allowed' });
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: registration(),
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(harness.permissionChecks().contextPermissionChecks).toBe(0);
  }),
);

it.effect('does not turn a partial authority plus inbound revision into a requirement lease', () =>
  Effect.gen(function* partialReadAuthorityCannotAttest() {
    let authorityLoads = 0;
    const applicationComposition: ActiveApplicationCompositionServiceContract = {
      load: Effect.suspend(() => {
        authorityLoads += 1;
        return Effect.fail(
          new ActiveApplicationCompositionUnavailableError({
            cause: new Error('Synthetic partial constructor'),
            reason: 'No receiving build was bound',
          }),
        );
      }),
    };
    const harness = yield* makeHarness({ applicationComposition, permissionDecision: 'allowed' });
    const read = defineRead(
      { ...registration().descriptor, domainErrorSchema: ModuleOperationRequirementError },
      () =>
        requireModuleOperation('core.shell.unqualified-operation').pipe(
          Effect.as({ evidence: { resultCount: 0 }, result: [] }),
        ),
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision),
        registration: read,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Schema.is(ModuleOperationRequirementError)(failure)).toBe(true);
    expect(authorityLoads).toBe(0);
    expect(harness.evidence()).toBe(0);
  }),
);

/** Synthetic host metadata; the operation itself is the exact production Core Legal Entity Read. */
const coreReadHost = (metadata: 'matching' | 'intrinsic' | 'core' | 'required' | 'provided' = 'matching') => {
  const base = makeModuleContractFixture({ appId: 'core-read-host', moduleId: 'test.core-read-host.module' }).manifest;
  const moduleId = base.module.id;
  // O62: an `authenticated_principal` Read is unprotected, so it must not inherit a carrier.
  const { accessDeclaration: _inheritedAccess, ...unprotectedRegistration } = registration().descriptor;
  const ownRead = defineRead(
    {
      ...unprotectedRegistration,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'authenticated_principal' },
        entrypointKey: `${moduleId}.api.host-read`,
        moduleKey: moduleId,
        role: 'api',
      }),
      legalEntityScope: 'required',
      owningModuleKey: moduleId,
      readKey: `${moduleId}.api.host-read`,
    },
    () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }),
    () => Effect.succeed({}),
    () => ({ kind: 'module', moduleId }),
  );
  const manifest = defineOntosModuleManifest({
    ...base,
    publicSurface: {
      ...base.publicSurface,
      actions: [],
      api:
        metadata === 'provided'
          ? { host: HttpApi.make('Host').add(HttpApiGroup.make('host').add(HttpApiEndpoint.get('detail', '/detail'))) }
          : {},
      components: {},
      operationContracts:
        metadata === 'provided' ? [{ apiKey: 'host', operationKey: 'host.detail', registration: ownRead }] : [],
    },
    requirements: {
      coreCapabilities: metadata === 'core' ? [{ id: 'ontos.host-unpublished', version: '1' }] : [],
      intrinsic: metadata === 'intrinsic' ? [{ moduleId: 'test.provider', requiredOperations: [] }] : [],
      operations:
        metadata === 'required'
          ? [
              {
                condition: `${moduleId}.condition.provider`,
                entrypointKey: ownRead.descriptor.entrypoint.entrypointKey,
                evidence: ['test.provider.fact'],
                key: `${moduleId}.requires.provider`,
                provider: { entrypointKey: 'test.provider.api.detail', moduleId: 'test.provider', schemaVersion: '1' },
              },
            ]
          : [],
      schemaVersion: '1',
    },
  });
  return defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [], reads: [ownRead] });
};

const coreLegalEntityInput = () =>
  Schema.decodeUnknownSync(LegalEntityDetailRequestSchema)({
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: '00000000-0000-4000-8000-000000000004',
      resourceType: 'core.identity.legal-entity',
      tenantId: scope.tenantId,
    },
  });

it.effect('runs the exact Core Legal Entity Read in a genuine vertical-bound receiver without Party', () =>
  Effect.gen(function* genuineCoreReadInVerticalReceiver() {
    const snapshot = yield* freshOutboxWorkerCompositionSnapshot(
      makeOutboxWorkerComposition([
        { appId: 'core-read-host', buildMarker: 'actual-host-build', moduleId: 'test.core-read-host.module' },
      ]),
    );
    const harness = yield* makeHarness({
      accessDecision: makeScriptedBoundAccessGate('allowed').bound,
      compositionAuthority: { phase: 'active', revision: snapshot.composition.revision, unexpired: true },
      legalEntityRows: [{ legalName: 'Managed Legal Entity', status: 'active', welcome: null }],
      runtimeAdmission: {
        applicationComposition: { load: Effect.succeed(snapshot) },
        expectedDeployment: { appId: 'core-read-host', buildMarker: 'actual-host-build' },
        ownerRegistration: coreReadHost(),
      },
    });
    const input = coreLegalEntityInput();
    const result = yield* harness.runtime.runRead({
      input,
      principal: scope,
      registration: legalEntityDetailRead,
      transport: { correlationId: scope.correlationId },
    });
    expect(result).toEqual({ ...input, legalName: 'Managed Legal Entity', status: 'active' });
    expect(harness.legalEntityReads()).toBe(1);
    expect(harness.evidence()).toBe(1);
    expect(harness.authorityCounts().authorityLocks).toBe(2);
  }),
);

it.effect('rejects recreated Core Reads, wrong receiver builds and every mismatched host contract block', () =>
  Effect.gen(function* coreReadHostAdmissionRemainsExact() {
    const snapshot = yield* freshOutboxWorkerCompositionSnapshot(
      makeOutboxWorkerComposition([
        { appId: 'core-read-host', buildMarker: 'actual-host-build', moduleId: 'test.core-read-host.module' },
      ]),
    );
    let recreatedCalls = 0;
    const recreated = defineRead(
      { ...legalEntityDetailRead.descriptor },
      (input) => {
        recreatedCalls += 1;
        return Effect.succeed({
          evidence: { resultCount: 1 },
          result: { ...input, legalName: 'Forged', status: 'active' as const },
        });
      },
      () => Effect.succeed({}),
      (input) => ({ kind: 'legal_entity', legalEntityId: input.legalEntityRef.resourceId, permission: 'access' }),
    );
    for (const control of [
      'recreated',
      'unknown-host',
      'wrong-build',
      'intrinsic',
      'core',
      'required',
      'provided',
      'denied',
    ] as const) {
      let runtimeAdmission: Pick<
        ReadRuntimeOptions,
        'applicationComposition' | 'expectedDeployment' | 'ownerRegistration'
      > = {
        applicationComposition: { load: Effect.succeed(snapshot) },
        expectedDeployment: {
          appId: 'core-read-host',
          buildMarker: control === 'wrong-build' ? 'other-build' : 'actual-host-build',
        },
      };
      if (control !== 'unknown-host') {
        runtimeAdmission = {
          ...runtimeAdmission,
          ownerRegistration: coreReadHost(
            control === 'recreated' || control === 'wrong-build' || control === 'denied' ? 'matching' : control,
          ),
        };
      }
      const harness = yield* makeHarness({
        accessDecision: makeScriptedBoundAccessGate(control === 'denied' ? 'denied' : 'allowed').bound,
        compositionAuthority: { phase: 'active', revision: snapshot.composition.revision, unexpired: true },
        legalEntityRows: [{ legalName: 'Managed Legal Entity', status: 'active', welcome: null }],
        runtimeAdmission,
      });
      const readInput = {
        input: coreLegalEntityInput(),
        principal: scope,
        transport: { correlationId: scope.correlationId },
      };
      const failure =
        control === 'recreated'
          ? yield* Effect.flip(harness.runtime.runRead({ ...readInput, registration: recreated }))
          : yield* Effect.flip(harness.runtime.runRead({ ...readInput, registration: legalEntityDetailRead }));
      expect(
        Predicate.isTagged(failure, control === 'denied' ? 'ReadPermissionDenied' : 'ReadHandlerUnavailable'),
      ).toBe(true);
      expect(harness.legalEntityReads()).toBe(0);
      expect(harness.evidence()).toBe(control === 'denied' ? 1 : 0);
    }
    expect(recreatedCalls).toBe(0);
  }),
);

/** Controlled constructor definitions; the Shell integration exercises the real production factory. */
const shellHostDefinitions = (onHandler: () => void, attest = false) => {
  const make = (key: string, role: 'api' | 'search') =>
    defineRead(
      {
        accessKind: 'detail',
        domainErrorSchema: ModuleOperationRequirementError,
        entrypoint: defineSystemModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'authenticated_principal' },
          entrypointKey: key,
          moduleKey: 'core.shell',
          role,
        }),
        evidencePolicy: { captureMode: 'metadata_only', policyKey: `${key}.evidence.v1` },
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'forbidden',
        owningModuleKey: 'core.shell',
        permissionTarget: 'tenant',
        policies: [],
        readKey: key,
        resultSchema: Schema.String,
        schemaVersion: '1',
      },
      () => {
        onHandler();
        const result = Effect.succeed({ evidence: { resultCount: 1 }, result: 'shell-host-result' });
        return attest ? requireModuleOperation('core.shell.unpublished-provider').pipe(Effect.andThen(result)) : result;
      },
      () => Effect.succeed({}),
      () => ({ kind: 'tenant', permission: 'access' }),
    );
  return {
    composition: make('core.shell.composition', 'api'),
    moduleTarget: make('core.shell.module-target', 'api'),
    resourceDetail: make('core.shell.resource-detail-timeline', 'api'),
    search: make('core.shell.search', 'search'),
    tenantModuleTarget: make('core.shell.tenant-module-target', 'api'),
  };
};

it.effect('admits only captured Shell definitions at the actual authoritative Shell build and revision', () =>
  Effect.gen(function* closedShellHostBinding() {
    const snapshot = yield* freshOutboxWorkerCompositionSnapshot(makeOutboxWorkerComposition());
    for (const control of [
      'allowed',
      'recreated',
      'copied',
      'foreign',
      'wrong-build',
      'wrong-revision',
      'no-authority',
      'no-receiver',
      'denied',
    ] as const) {
      let handlers = 0;
      const definitions = shellHostDefinitions(() => {
        handlers += 1;
      });
      const recreated = shellHostDefinitions(() => {
        handlers += 1;
      }).composition;
      const copied = new Proxy(definitions.composition, {});
      const foreign = defineRead(
        {
          ...definitions.composition.descriptor,
          entrypoint: defineTenantModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'authenticated_principal' },
            entrypointKey: 'test.foreign.api.read',
            moduleKey: 'test.foreign',
            role: 'api',
          }),
          owningModuleKey: 'test.foreign',
          readKey: 'test.foreign.api.read',
        },
        () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'foreign' }),
        () => Effect.succeed({}),
        () => ({ kind: 'tenant', permission: 'access' }),
      );
      let admission: Pick<
        ReadRuntimeOptions,
        'applicationComposition' | 'expectedDeployment' | 'ownerRegistration' | 'shellSystemReads'
      > = { shellSystemReads: definitions };
      if (control !== 'no-authority') {
        admission = { ...admission, applicationComposition: { load: Effect.succeed(snapshot) } };
      }
      if (control !== 'no-receiver') {
        admission = {
          ...admission,
          expectedDeployment: {
            ...snapshot.composition.shell.deployment,
            buildMarker:
              control === 'wrong-build' ? 'another-shell-build' : snapshot.composition.shell.deployment.buildMarker,
          },
        };
      }
      if (control === 'foreign') {
        admission = { ...admission, shellSystemReads: { ...definitions, composition: foreign } };
      }
      const harness = yield* makeHarness({
        compositionAuthority: { phase: 'active', revision: snapshot.composition.revision, unexpired: true },
        permissionDecision: control === 'denied' ? 'denied' : 'allowed',
        runtimeAdmission: admission,
      });
      let selectedRegistration = definitions.composition;
      if (control === 'recreated') {
        selectedRegistration = recreated;
      }
      if (control === 'copied') {
        selectedRegistration = copied;
      }
      const result = harness.runtime.runRead({
        input: {},
        principal: control === 'wrong-revision' ? trustVerifiedGatewayPrincipalContext(scope, 'b'.repeat(64)) : scope,
        registration: selectedRegistration,
        transport: { correlationId: scope.correlationId },
      });
      if (control === 'allowed') {
        expect(yield* result).toBe('shell-host-result');
        expect(handlers).toBe(1);
        expect(harness.evidence()).toBe(1);
      } else {
        const failure = yield* Effect.flip(result);
        expect(
          Predicate.isTagged(failure, control === 'denied' ? 'ReadPermissionDenied' : 'ReadHandlerUnavailable'),
        ).toBe(true);
        expect(handlers).toBe(0);
      }
    }
  }),
);

it.effect('gives bound Shell system Reads no provider-operation execution lease', () =>
  Effect.gen(function* shellSystemReadsCannotAttestProviders() {
    const snapshot = yield* freshOutboxWorkerCompositionSnapshot(makeOutboxWorkerComposition());
    const definitions = shellHostDefinitions(() => {}, true);
    const harness = yield* makeHarness({
      compositionAuthority: { phase: 'active', revision: snapshot.composition.revision, unexpired: true },
      permissionDecision: 'allowed',
      runtimeAdmission: {
        applicationComposition: { load: Effect.succeed(snapshot) },
        expectedDeployment: snapshot.composition.shell.deployment,
        shellSystemReads: definitions,
      },
    });
    for (const boundRead of [definitions.composition, definitions.tenantModuleTarget]) {
      const failure = yield* Effect.flip(
        harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: boundRead,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Schema.is(ModuleOperationRequirementError)(failure)).toBe(true);
    }
    expect(harness.evidence()).toBe(0);
  }),
);

for (const row of remainingPermissionBaselines) {
  if (row.target.kind === 'tax_selling_legal_entity') {
    continue;
  }
  it.effect(`freezes corrected ${row.target.kind} Read history and query identity`, () =>
    Effect.gen(function* familyReadBaseline() {
      let handlerCalls = 0;
      const permission = yield* Schema.decodeEffect(FixturePermissionCodeSchema)(row.permission);
      const key = `${row.owner}.baseline.${row.target.kind.replaceAll('_', '-')}`;
      const read = defineRead(
        {
          accessDeclaration: fixtureReadAccess(row.owner),
          accessKind: 'detail',
          entrypoint: defineTenantModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'context_permission', permission: row.permission },
            entrypointKey: key,
            moduleKey: row.owner,
            role: 'api',
          }),
          evidencePolicy: { captureMode: 'hash_only', policyKey: `${key}.evidence.v1` },
          inputSchema: Schema.Struct({ value: Schema.String }),
          legalEntityScope: row.tenantOnly ? 'forbidden' : 'required',
          owningModuleKey: row.owner,
          permissionTarget: 'owner_permission',
          policies: [],
          readKey: key,
          resultSchema: Schema.String,
          schemaVersion: '1',
        },
        () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 1 }, result: 'baseline' });
        },
        () => Effect.succeed({}),
        defineReadOwnerPermission(historicalOwnerContract(permission), () =>
          historicalOwnerReadTarget(permission, row.target),
        ),
      );
      const actor = row.tenantOnly ? scope : counterpartyReadPrincipal('00000000-0000-4000-8000-000000000002');
      const resolved = row.tenantOnly ? scope : { ...scope, legalEntityId: '00000000-0000-4000-8000-000000000002' };
      const resolvedScope =
        row.target.kind === 'counterparty_storefront'
          ? trustVerifiedGatewayPrincipalContext(
              { ...resolved, trustedStorefrontId: row.target.storefrontId },
              'a'.repeat(64),
            )
          : resolved;
      interface FamilyReadBaselineOptions {
        businessPermissionDecision: 'allowed' | 'denied' | 'unavailable';
        contextPermissionDecision: 'allowed';
        permissionDecision: 'allowed';
        resolvedScope: typeof resolvedScope;
      }
      const options: FamilyReadBaselineOptions = {
        businessPermissionDecision: 'allowed',
        contextPermissionDecision: 'allowed',
        permissionDecision: 'allowed',
        resolvedScope,
      };
      const harness = yield* makeHarness(options);
      expect(
        yield* harness.runtime.runRead({
          input: { value: 'baseline' },
          principal: actor,
          registration: read,
          transport: { correlationId: 'baseline-family-read' },
        }),
      ).toBe('baseline');
      const values = harness.evidenceParameterRows()[0] ?? [];
      expect(values).toContain(row.readTarget.moduleId);
      expect(values).toContain(row.readTarget.resourceId);
      expect(values).toContain(row.readTarget.resourceType);
      expect(harness.evidenceRows()[0]?.queryHash).toBe(row.readHash);
      options.businessPermissionDecision = 'denied';
      const revoked = yield* Effect.flip(
        harness.runtime.runRead({
          input: { value: 'baseline' },
          principal: actor,
          registration: read,
          transport: { correlationId: 'baseline-family-read-after-revoke' },
        }),
      );
      expect(Predicate.isTagged(revoked, 'ReadPermissionDenied')).toBe(true);
      expect(handlerCalls).toBe(1);
    }),
  );
}
it.effect(
  'runs the genuine Core binding-subject Read through scoped repository lookup without a host registration',
  () =>
    Effect.gen(function* genuineCoreBindingSubjectRead() {
      const harness = yield* makeHarness({
        accessDecision: makeScriptedBoundAccessGate('allowed').bound,
        omitOwnerRegistration: true,
      });
      const failure = yield* Effect.flip(
        harness.runtime.runRead({
          input: {
            authBindingId: '00000000-0000-4000-8000-000000000005',
            authenticationNamespaceId: 'test.identity.realm',
          },
          principal: scope,
          registration: bindingSubjectRead,
          transport: { correlationId: scope.correlationId },
        }),
      );
      // The ordinary empty repository reaches the domain not-found result, rather than rejecting owner admission.
      expect(failure).toEqual(new ExternalIdentityError({ code: 'identity_not_found' }));
      expect(harness.stages).toContain('scope_installed');
      expect(harness.authorityCounts().scopeInstalls).toBeGreaterThan(0);
    }),
);

it.effect('rejects a recreated Core binding-subject Read before its handler runs', () =>
  Effect.gen(function* recreatedCoreBindingSubjectRead() {
    let handlerCalls = 0;
    const recreated = defineRead(
      bindingSubjectRead.descriptor,
      () => {
        handlerCalls += 1;
        return Effect.fail(new ExternalIdentityError({ code: 'identity_not_found' }));
      },
      () => Effect.succeed({}),
      () => ({ kind: 'tenant', permission: 'access' }),
    );
    const harness = yield* makeHarness({ omitOwnerRegistration: true, permissionDecision: 'allowed' });
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {
          authBindingId: '00000000-0000-4000-8000-000000000005',
          authenticationNamespaceId: 'test.identity.realm',
        },
        principal: scope,
        registration: recreated,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
    expect(harness.stages).toEqual(['input_decoded', 'scope_validated']);
    expect(handlerCalls).toBe(0);
    expect(harness.evidence()).toBe(0);
  }),
);

it.effect('rejects a recreated Core external-subject resolution Read before its handler runs', () =>
  Effect.gen(function* recreatedCoreExternalSubjectRead() {
    let handlerCalls = 0;
    const recreated = defineRead(
      resolveExternalSubjectRead.descriptor,
      () => {
        handlerCalls += 1;
        return Effect.fail(new ExternalIdentityError({ code: 'identity_unavailable' }));
      },
      () => Effect.succeed({}),
      () => ({ kind: 'tenant', permission: 'access' }),
    );
    const harness = yield* makeHarness({ omitOwnerRegistration: true, permissionDecision: 'allowed' });
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: {
          authenticationNamespaceId: 'test.identity.realm',
          providerSubjectId: 'test-external-subject',
          subjectType: 'user',
        },
        principal: scope,
        registration: recreated,
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
    expect(harness.stages).toEqual(['input_decoded', 'scope_validated']);
    expect(handlerCalls).toBe(0);
    expect(harness.evidence()).toBe(0);
  }),
);
