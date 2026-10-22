import { PgClient } from '@effect/sql-pg';
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';
import { Reactivity } from 'effect/unstable/reactivity';
import { constVoid } from 'effect/Function';
/* oxlint-disable sonarjs/use-type-alias, typescript/no-unsafe-type-assertion -- Existing compatibility boundary; expires: 2026-12-31. */
import { expect, it } from 'effect-rstest';
import { v1 } from '@authzed/authzed-node';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';

import { defineGlobalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { BusinessPermissionCodeSchema } from '../../src/permissions/business-permission.ts';
import {
  toAssortmentPermissionAccessKey,
  toBusinessPermissionAccessKey,
} from '../../src/permissions/context-access.ts';
import type {
  AssortmentPermissionAccessTarget,
  BusinessPermissionAccessTarget,
} from '../../src/permissions/context-access.ts';
import type {
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
} from '../../src/permissions/owner-authorization-overlay.ts';
import {
  allowOwnerAuthorizationOverlay,
  transactionalOwnerAuthorization,
} from '../../src/permissions/owner-authorization-overlay.ts';
import {
  defineRead,
  defineReadConditionalPermission,
  defineReadResourcePermission,
} from '../../src/reads/definition.ts';
import {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPolicyDenied,
} from '../../src/reads/errors.ts';
import type { ReadFinishContext, ReadHandlerResult } from '../../src/reads/context.ts';
import { makeReadRuntime, READ_RUNTIME_STAGES } from '../../src/reads/runtime.ts';
import { guardSpiceDbRpc } from '../../src/permissions/spicedb-transaction-guard.ts';
import { guardPoolAcquisition, IoInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import type { TransactionIo } from '../../src/db/transaction-io-guard.ts';
import { moduleReleaseFetch } from '../../src/http/unit-service-fetch.export.ts';
import { scriptedPgClientLayer } from '../../src/testing/scripted-pg-client.ts';
import type { SpiceDbRpc } from '../../src/permissions/spicedb-rpc.ts';
import { makeTestDatabase } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';
import { makeOutboxWorkerComposition } from '../support/outbox-worker-composition.ts';
import { testSqlConnection } from '../support/sql-connection.ts';

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
const makeHarness = Effect.fn(function* makeHarness(
  options: {
    readonly assortmentPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly assortmentPermissionKey?: string;
    readonly assortmentPermissionResponse?: 'empty';
    readonly authorityEvents?: string[];
    readonly businessPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly compositionAuthority?: ReadAuthorityFixture | 'missing';
    readonly compositionIsolation?: 'read committed' | 'repeatable read';
    readonly contextPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    /** Completed when the entrypoint context permission check starts. */
    readonly contextPermissionStarted?: Deferred.Deferred<boolean>;
    readonly failEvidence?: boolean;
    readonly failTransactionTimestamp?: boolean;
    readonly modulePermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly omitOwnerAuthorizationOverlay?: boolean;
    readonly onBusinessPermissionTarget?: (target: BusinessPermissionAccessTarget) => void;
    readonly onContextPermissionTarget?: (target: { readonly moduleId: string; readonly permission: string }) => void;
    readonly onLegalEntityPermission?: (permission: string | undefined) => void;
    readonly onLegalEntityTarget?: (legalEntityId: string, tenantId: string) => void;
    readonly onResourcePermission?: (permission: 'read' | 'write' | undefined) => void;
    readonly onResourceTarget?: (target: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
    }) => void;
    readonly onTenantPermission?: (permission: string) => void;
    readonly onTrustedStorefrontId?: (trustedStorefrontId: string | undefined) => void;
    readonly ownerAuthorizationOverlay?: OwnerAuthorizationOverlayService;
    readonly permissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resolvedScope?: typeof scope & {
      readonly legalEntityId?: string;
      readonly trustedStorefrontId?: string;
    };
    /** The resource permission check answers only after this completes. */
    readonly resourcePermissionAwaits?: Deferred.Deferred<boolean>;
    readonly resourcePermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resultPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resultTenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly sqlEvents?: string[];
    readonly tenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly transactionEvents?: string[];
  } = {},
) {
  let businessPermissionChecks = 0;
  const assortmentPermissionChecks: unknown[] = [];
  let contextPermissionChecks = 0;
  let evidence = 0;
  let authorityLocks = 0;
  let authorityReads = 0;
  let scopeInstalls = 0;
  let transactionTimestampReadCount = 0;
  let resourcePermissionChecks = 0;
  let tenantPermissionChecks = 0;
  const evidenceRows: EvidenceRow[] = [];
  const evidenceParameterRows: unknown[][] = [];
  const query = (text: string, values: readonly unknown[]) =>
    Effect.gen(function* executeReadQuery() {
      if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/u.test(text)) {
        options.sqlEvents?.push(text);
      }
      if (text.includes("current_setting('transaction_isolation')")) {
        return [{ isolation: options.compositionIsolation ?? 'read committed' }];
      }
      if (text.includes('pg_advisory_xact_lock_shared')) {
        authorityLocks += 1;
        options.authorityEvents?.push('authority_locked');
        return [];
      }
      if (text.includes('application_composition_authority')) {
        authorityReads += 1;
        const authority = options.compositionAuthority ?? {
          phase: 'active',
          revision: approvedCompositionRevision,
          unexpired: true,
        };
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
      return text.includes('current_setting')
        ? [
            {
              legal_entity_id: options.resolvedScope?.legalEntityId ?? '',
              tenant_id: scope.tenantId,
            },
          ]
        : [];
    });
  const database = { executor: yield* makeTestDatabase(query) };
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
  const ownerAuthorizationOptions =
    options.omitOwnerAuthorizationOverlay === true
      ? {}
      : {
          ownerAuthorizationOverlay: options.ownerAuthorizationOverlay ?? allowOwnerAuthorizationOverlay,
        };
  const runtime = makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(options.resolvedScope ?? scope) },
    {
      assortmentPermissions: ({ legalEntityId, principal, targets }) => {
        assortmentPermissionChecks.push(...targets);
        return Effect.succeed(
          options.assortmentPermissionResponse === 'empty'
            ? []
            : targets.map(({ target }) => {
                const expectedKey = toAssortmentPermissionAccessKey(principal.tenantId, legalEntityId, target);
                if (expectedKey === undefined) {
                  throw new Error('Test fixture requires a trusted tenant and legal entity scope');
                }
                return {
                  decision:
                    options.assortmentPermissionDecision ?? options.permissionDecision ?? ('unavailable' as const),
                  key: options.assortmentPermissionKey ?? expectedKey,
                };
              }),
        );
      },
      businessPermissions: ({ targets, trustedStorefrontId }) => {
        businessPermissionChecks += 1;
        options.onTrustedStorefrontId?.(trustedStorefrontId);
        const [target] = targets;
        if (target !== undefined) {
          options.onBusinessPermissionTarget?.(target);
        }
        return Effect.succeed(
          targets.map((businessTarget) => ({
            decision: options.businessPermissionDecision ?? options.permissionDecision ?? ('unavailable' as const),
            key: toBusinessPermissionAccessKey(businessTarget),
          })),
        );
      },
      contextPermissions: ({ targets }) => {
        contextPermissionChecks += 1;
        const [target] = targets;
        if (target !== undefined) {
          options.onContextPermissionTarget?.(target);
        }
        return (
          options.contextPermissionStarted === undefined
            ? Effect.void
            : Deferred.succeed(options.contextPermissionStarted, true)
        ).pipe(
          Effect.as(
            targets.map(({ moduleId, permission }) => ({
              decision: options.contextPermissionDecision ?? ('unavailable' as const),
              key: `${moduleId}:${permission}`,
            })),
          ),
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
      resources: ({ permission, resources }) => {
        resourcePermissionChecks += 1;
        options.onResourcePermission?.(permission);
        const [target] = resources;
        if (target !== undefined) {
          options.onResourceTarget?.(target);
        }
        return (
          options.resourcePermissionAwaits === undefined
            ? Effect.void
            : Deferred.await(options.resourcePermissionAwaits)
        ).pipe(
          Effect.as(
            resources.map((resource) => ({
              decision:
                options.resultPermissionDecision ??
                options.resourcePermissionDecision ??
                options.permissionDecision ??
                ('unavailable' as const),
              key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
            })),
          ),
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
    {
      onStage: (stage) => stages.push(stage),
      ...ownerAuthorizationOptions,
    },
  );
  return {
    assortmentPermissionChecks,
    authorityCounts: () => ({ authorityLocks, authorityReads, scopeInstalls }),
    evidence: () => evidence,
    evidenceParameterRows: () => evidenceParameterRows,
    evidenceRows: () => evidenceRows,
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
    {
      load: (_input, context) =>
        Effect.succeed({
          evidence: { resultCount: 0 },
          result: context.services.items,
        }),
    },
    () => Effect.succeed({ items }),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );

const assortmentReadTarget: AssortmentPermissionAccessTarget = {
  audience: { kind: 'SHARED' },
  commercialScope: {
    channel: {
      moduleId: 'commerce.channel',
      resourceId: 'web',
      resourceType: 'commerce.channel',
    },
    storefront: {
      moduleId: 'commerce.storefront',
      resourceId: 'storefront-a',
      resourceType: 'commerce.storefront',
    },
  },
  effectiveFrom: '2026-09-22T00:00:00.000Z',
  kind: 'assortment_binding',
  mode: 'create',
  permission: 'assortment.binding.create',
  ruleRevision: {
    moduleId: 'commerce.assortment',
    resourceId: 'rule-revision-1',
    resourceType: 'commerce.assortment.rule-revision',
  },
};

const assortmentReadRegistration = (handler: () => void) =>
  defineRead(
    {
      accessKind: 'detail',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'assortment.binding.create' },
        entrypointKey: 'commerce.assortment.binding-preview',
        moduleKey: 'commerce.assortment',
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'commerce.assortment.binding-preview.v1' },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'required',
      owningModuleKey: 'commerce.assortment',
      permissionTarget: 'assortment_permission',
      policies: [],
      readKey: 'commerce.assortment.binding-preview',
      resultSchema: Schema.String,
      schemaVersion: '1',
    },
    {
      load: () => {
        handler();
        return Effect.succeed({ evidence: { resultCount: 1 }, result: 'ok' });
      },
    },
    () => Effect.succeed({}),
    () => ({ assortmentPermission: assortmentReadTarget, kind: 'assortment_permission' }),
  );

it.effect(
  'checks an exact scoped Assortment read target and fails closed on denial, unavailable, or correlation errors',
  () =>
    Effect.gen(function* checksAssortmentReadTarget() {
      let handlerCalls = 0;
      const assortmentRegistration = assortmentReadRegistration(() => {
        handlerCalls += 1;
      });
      const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
        harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: assortmentRegistration,
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
        assortmentPermissionDecision: 'allowed',
        resolvedScope: trustedScope,
      });
      expect(yield* run(allowed)).toBe('ok');
      expect(allowed.assortmentPermissionChecks).toEqual([{ target: assortmentReadTarget }]);
      expect(handlerCalls).toBe(1);

      const denied = yield* makeHarness({ assortmentPermissionDecision: 'denied', resolvedScope: trustedScope });
      expect(Predicate.isTagged(yield* Effect.flip(run(denied)), 'ReadPermissionDenied')).toBe(true);
      expect(denied.assortmentPermissionChecks).toHaveLength(1);
      expect(handlerCalls).toBe(1);

      const unavailable = yield* makeHarness({
        assortmentPermissionDecision: 'unavailable',
        resolvedScope: trustedScope,
      });
      expect(Predicate.isTagged(yield* Effect.flip(run(unavailable)), 'ReadPermissionUnavailable')).toBe(true);
      expect(unavailable.assortmentPermissionChecks).toHaveLength(1);
      expect(handlerCalls).toBe(1);

      const empty = yield* makeHarness({ assortmentPermissionResponse: 'empty', resolvedScope: trustedScope });
      expect(Predicate.isTagged(yield* Effect.flip(run(empty)), 'ReadPermissionUnavailable')).toBe(true);
      expect(empty.assortmentPermissionChecks).toHaveLength(1);
      expect(handlerCalls).toBe(1);

      const mismatched = yield* makeHarness({
        assortmentPermissionDecision: 'allowed',
        assortmentPermissionKey: 'wrong-tenant:wrong-entity:assortment.binding.create',
        resolvedScope: trustedScope,
      });
      expect(Predicate.isTagged(yield* Effect.flip(run(mismatched)), 'ReadPermissionUnavailable')).toBe(true);
      expect(handlerCalls).toBe(1);

      const storefrontMismatch = yield* makeHarness({
        assortmentPermissionDecision: 'allowed',
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
      expect(storefrontMismatch.assortmentPermissionChecks).toHaveLength(0);
      expect(handlerCalls).toBe(1);
    }),
);

it.effect('derives configuration read scope from the scope the owning module declares', () =>
  Effect.gen(function* derivesConfigurationReadScope() {
    let handlerCalls = 0;
    const stableRuleTarget: AssortmentPermissionAccessTarget = {
      kind: 'assortment_configuration',
      permission: 'assortment.configuration.read',
      resource: {
        moduleId: 'commerce.assortment',
        resourceId: 'stable-rule-1',
        resourceType: 'commerce.assortment.stable-rule',
      },
      resourceScope: 'tenant',
    };
    const bindingTarget: AssortmentPermissionAccessTarget = {
      kind: 'assortment_configuration',
      permission: 'assortment.configuration.read',
      resource: {
        moduleId: 'commerce.assortment',
        resourceId: 'binding-1',
        resourceType: 'commerce.assortment.applicability-binding',
      },
      resourceScope: 'legal_entity',
    };
    const unknownTarget: AssortmentPermissionAccessTarget = {
      ...bindingTarget,
      resource: { ...bindingTarget.resource, resourceType: 'foreign.module.configuration' },
    };
    const configurationRegistration = (target: AssortmentPermissionAccessTarget) =>
      defineRead(
        {
          accessKind: 'detail',
          entrypoint: defineTenantModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'context_permission', permission: 'assortment.configuration.read' },
            entrypointKey: 'commerce.assortment.configuration-scope',
            moduleKey: 'commerce.assortment',
            role: 'api',
          }),
          evidencePolicy: { captureMode: 'metadata_only', policyKey: 'commerce.assortment.configuration-scope.v1' },
          inputSchema: Schema.Struct({}),
          legalEntityScope: 'optional',
          owningModuleKey: 'commerce.assortment',
          permissionTarget: 'assortment_permission',
          policies: [],
          readKey: 'commerce.assortment.configuration-scope',
          resultSchema: Schema.String,
          schemaVersion: '1',
        },
        {
          load: () => {
            handlerCalls += 1;
            return Effect.succeed({ evidence: { resultCount: 1 }, result: 'ok' });
          },
        },
        () => Effect.succeed({}),
        () => ({ assortmentPermission: target, kind: 'assortment_permission' }),
      );

    const tenantScoped = yield* makeHarness({ assortmentPermissionDecision: 'allowed' });
    const tenantResult = yield* tenantScoped.runtime.runRead({
      input: {},
      principal: scope,
      registration: configurationRegistration(stableRuleTarget),
      transport: { correlationId: scope.correlationId },
    });
    expect(tenantResult).toBe('ok');
    expect(tenantScoped.assortmentPermissionChecks).toEqual([{ target: stableRuleTarget }]);

    const legalEntityScoped = yield* makeHarness({ assortmentPermissionDecision: 'allowed' });
    const unavailable = yield* Effect.flip(
      legalEntityScoped.runtime.runRead({
        input: {},
        principal: scope,
        registration: configurationRegistration(bindingTarget),
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(unavailable, 'ReadPermissionUnavailable')).toBe(true);
    expect(legalEntityScoped.assortmentPermissionChecks).toHaveLength(0);

    const unknownType = yield* makeHarness({ assortmentPermissionDecision: 'allowed' });
    const unknownFailure = yield* Effect.flip(
      unknownType.runtime.runRead({
        input: {},
        principal: scope,
        registration: configurationRegistration(unknownTarget),
        transport: { correlationId: scope.correlationId },
      }),
    );
    expect(Predicate.isTagged(unknownFailure, 'ReadHandlerExecutionError')).toBe(true);
    expect(unknownType.assortmentPermissionChecks).toHaveLength(0);
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
    const ownerAuthorizationOverlay: OwnerAuthorizationOverlayService = transactionalOwnerAuthorization(
      (_transaction, input) =>
        Effect.sync(() => {
          ownerInputs.push(input);
          return 'denied' as const;
        }),
    );
    const harness = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      ownerAuthorizationOverlay,
      permissionDecision: 'allowed',
    });
    const deniedRegistration = defineRead(
      registration().descriptor,
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
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

it.effect('fails closed before owner authorization when PostgreSQL cannot provide transaction time', () =>
  Effect.gen(function* transactionTimeUnavailable() {
    let overlayCalls = 0;
    let handlerCalls = 0;
    const harness = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      failTransactionTimestamp: true,
      ownerAuthorizationOverlay: transactionalOwnerAuthorization(() => {
        overlayCalls += 1;
        return Effect.succeed('allowed' as const);
      }),
      permissionDecision: 'allowed',
    });
    const testRegistration = defineRead(
      registration().descriptor,
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
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
      {
        load: () =>
          Effect.succeed({
            evidence: { resultCount: 1 },
            result: { value: Option.none() },
          }),
      },
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
          { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) },
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
      { load: () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'hidden' }) },
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
          { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) },
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
      {
        load: () => {
          const result: string[] = [];
          const handlerResult = { evidence: { resultCount: 1 }, result };
          Object.defineProperty(handlerResult, 'result', { value: 42 });
          return Effect.succeed(handlerResult);
        },
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
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
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
      { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) },
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
        ownerAuthorizationOverlay: transactionalOwnerAuthorization(() => {
          overlayCalls += 1;
          return Effect.succeed('allowed' as const);
        }),
      });
      const scopedRegistration = defineRead(
        { ...registration().descriptor, policies: [{ denialStatus: 422, policyKey: policy.policyKey }] },
        {
          load: () => {
            handlerCalls += 1;
            return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
          },
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
      expect(harness.authorityCounts()).toEqual({ authorityLocks: 0, authorityReads: 1, scopeInstalls: 0 });
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
      {
        load: () => {
          events.push('handler');
          return Effect.succeed({ evidence: { resultCount: 0 }, result: ['current'] });
        },
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
    expect(events).toEqual(['authority_locked', 'scope_installed', 'factory', 'handler', 'transaction_settled']);
    // One unlocked admission precheck before authorization, then the locked fence around owner work.
    expect(harness.authorityCounts()).toEqual({ authorityLocks: 1, authorityReads: 2, scopeInstalls: 1 });
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
    expect(harness.authorityCounts()).toEqual({ authorityLocks: 0, authorityReads: 1, scopeInstalls: 0 });
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
    expect(harness.authorityCounts()).toEqual({ authorityLocks: 0, authorityReads: 0, scopeInstalls: 1 });
  }),
);

it.effect(
  'rejects unsafe Read transaction isolation at the fence before acquiring authority or running owner work',
  () =>
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
      expect(harness.authorityCounts()).toEqual({ authorityLocks: 0, authorityReads: 1, scopeInstalls: 0 });
      expect(harness.stages).not.toContain('scope_installed');
      expect(harness.evidence()).toBe(0);
    }),
);

it.effect('does not mint a revision for a local Read that requires cross-owner credentials', () =>
  Effect.gen(function* localReadCannotMintGatewayRevision() {
    const harness = yield* makeHarness();
    let handlerCalls = 0;
    const credentialedRegistration = defineRead(
      registration().descriptor,
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
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
    {
      load: () => {
        onHandler();
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
      },
    },
    () => Effect.succeed({}),
    () => ({ kind: 'legal_entity', permission: 'read_counterparty' }),
  );

it.effect('keeps authorization round trips and evidence outside the owner transaction', () =>
  Effect.gen(function* authorizationOutsideTransaction() {
    const events: string[] = [];
    const harness = yield* makeHarness({
      onLegalEntityTarget: () => events.push('spicedb'),
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId: '00000000-0000-4000-8000-000000000004' },
      sqlEvents: events,
    });
    yield* harness.runtime.runRead({
      input: {},
      principal: trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision),
      registration: counterpartyReadRegistration('required', () => events.push('handler')),
      transport: { correlationId: scope.correlationId },
    });
    // Every SpiceDB check finishes before the only transaction opens; it commits right after the handler.
    expect(events).toContain('spicedb');
    expect(events.lastIndexOf('spicedb')).toBeLessThan(events.indexOf('BEGIN'));
    expect(events.slice(events.indexOf('BEGIN'))).toEqual(['BEGIN', 'handler', 'COMMIT']);
    expect(harness.evidence()).toBe(1);
  }),
);

it.effect('runs owner prepare before the transaction, only owner load inside it, and owner finish after commit', () =>
  Effect.gen(function* ownerPipelineOutsideTransaction() {
    const events: string[] = [];
    const harness = yield* makeHarness({
      onLegalEntityTarget: () => events.push('spicedb'),
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId: '00000000-0000-4000-8000-000000000004' },
      sqlEvents: events,
    });
    const base = counterpartyReadRegistration('required', () => events.length);
    const ownerPipeline = defineRead(
      base.descriptor,
      {
        // Owner SpiceDB grants (prepare) and row filters (finish) stand in as the recorded owner events.
        // oxlint-disable perfectionist/sort-objects -- Steps stay in execution order: each step's types infer from the previous one.
        prepare: () =>
          Effect.sync(() => {
            events.push('owner-spicedb-grants');
            return { readAll: false };
          }),
        load: (_input, context) =>
          Effect.sync(() => {
            events.push('owner-load');
            expect(context.prepared).toEqual({ readAll: false });
            return ['visible', 'hidden'];
          }),
        finish: (_input, context) =>
          Effect.sync(() => {
            events.push('owner-spicedb-row-filter');
            const result = context.loaded.filter((row) => row === 'visible');
            return { evidence: { resultCount: result.length }, result };
          }),
        // oxlint-enable perfectionist/sort-objects
      },
      () => Effect.succeed({}),
      () => ({ kind: 'legal_entity', permission: 'read_counterparty' }),
    );
    expect(
      yield* harness.runtime.runRead({
        input: {},
        principal: trustVerifiedGatewayPrincipalContext(scope, approvedCompositionRevision),
        registration: ownerPipeline,
        transport: { correlationId: scope.correlationId },
      }),
    ).toEqual(['visible']);
    const begin = events.indexOf('BEGIN');
    const commit = events.indexOf('COMMIT');
    // No SpiceDB round trip, Core's or the owner's, runs while the transaction holds its connection.
    expect(events.slice(begin, commit + 1)).toEqual(['BEGIN', 'owner-load', 'COMMIT']);
    expect(events.indexOf('owner-spicedb-grants')).toBeLessThan(begin);
    expect(events.lastIndexOf('spicedb')).toBeLessThan(begin);
    expect(events.indexOf('owner-spicedb-row-filter')).toBeGreaterThan(commit);
    expect(harness.evidence()).toBe(1);
  }),
);

const unusedSpiceDbRpc = () => Effect.die(new Error('unused SpiceDB RPC'));

/** A SpiceDB RPC behind the production transaction guard; each round trip that reaches it is recorded. */
const guardedSpiceDb = (events: string[]): SpiceDbRpc =>
  guardSpiceDbRpc({
    checkBulkPermissions: unusedSpiceDbRpc,
    checkPermission: () =>
      Effect.sync(() => {
        events.push('spicedb-rpc');
        return v1.CheckPermissionResponse.create({
          permissionship: v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
        });
      }),
    close: constVoid,
    readRelationships: unusedSpiceDbRpc,
    writeRelationships: unusedSpiceDbRpc,
    writeSchema: unusedSpiceDbRpc,
  });
const spiceDbCheck = (rpc: SpiceDbRpc) => rpc.checkPermission(v1.CheckPermissionRequest.create({}));
const diedInsideTransaction = (
  exit: Exit.Exit<unknown, unknown>,
  readKey: string,
  io: TransactionIo = 'spicedb',
): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) &&
      Schema.is(Schema.instanceOf(IoInsideDatabaseTransaction))(reason.defect) &&
      reason.defect.operationKey === readKey &&
      reason.defect.io === io,
  );

it.effect('lets owner prepare, finish, and the owner overlay preparation reach SpiceDB outside the transaction', () =>
  Effect.gen(function* spiceDbOutsideTransaction() {
    const events: string[] = [];
    const spiceDb = guardedSpiceDb(events);
    const harness = yield* makeHarness({
      ownerAuthorizationOverlay: {
        prepare: () =>
          spiceDbCheck(spiceDb).pipe(
            Effect.orDie,
            Effect.as(() =>
              Effect.sync(() => {
                events.push('owner-overlay-check');
                return 'allowed' as const;
              }),
            ),
          ),
      },
      permissionDecision: 'allowed',
      sqlEvents: events,
    });
    const read = defineRead(
      registration().descriptor,
      {
        // oxlint-disable perfectionist/sort-objects -- Steps stay in execution order: each step's types infer from the previous one.
        prepare: () => spiceDbCheck(spiceDb).pipe(Effect.orDie),
        load: () => Effect.sync(() => events.push('owner-load')),
        finish: () => spiceDbCheck(spiceDb).pipe(Effect.orDie, Effect.as({ evidence: { resultCount: 0 }, result: [] })),
        // oxlint-enable perfectionist/sort-objects
      },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    expect(
      yield* harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: read,
        transport: { correlationId: scope.correlationId },
      }),
    ).toEqual([]);
    expect(events).toEqual([
      'spicedb-rpc',
      'spicedb-rpc',
      'BEGIN',
      'owner-overlay-check',
      'owner-load',
      'COMMIT',
      'spicedb-rpc',
    ]);
  }),
);

it.effect('refuses SpiceDB between BEGIN and COMMIT: owner load, service factory, and owner overlay check die', () =>
  Effect.gen(function* spiceDbInsideTransaction() {
    const events: string[] = [];
    const spiceDb = guardedSpiceDb(events);
    const { readKey } = registration().descriptor;
    const runWith = (
      options: Parameters<typeof makeHarness>[0],
      load: () => Effect.Effect<unknown>,
      services: () => Effect.Effect<object> = () => Effect.succeed({}),
    ) =>
      Effect.gen(function* runReadWithSpiceDb() {
        const harness = yield* makeHarness({ permissionDecision: 'allowed', sqlEvents: events, ...options });
        return yield* Effect.exit(
          harness.runtime.runRead({
            input: {},
            principal: scope,
            registration: defineRead(
              registration().descriptor,
              { load: () => load().pipe(Effect.as({ evidence: { resultCount: 0 }, result: [] })) },
              services,
              () => ({ kind: 'module', moduleId: 'core.shell' }),
            ),
            transport: { correlationId: scope.correlationId },
          }),
        );
      });
    const inLoad = yield* runWith({}, () => spiceDbCheck(spiceDb).pipe(Effect.orDie));
    const inServiceFactory = yield* runWith(
      {},
      () => Effect.void,
      () => spiceDbCheck(spiceDb).pipe(Effect.orDie, Effect.as({})),
    );
    const inOverlayCheck = yield* runWith(
      {
        ownerAuthorizationOverlay: transactionalOwnerAuthorization(() =>
          spiceDbCheck(spiceDb).pipe(Effect.orDie, Effect.as('allowed' as const)),
        ),
      },
      () => Effect.void,
    );
    expect(diedInsideTransaction(inLoad, readKey)).toBe(true);
    expect(diedInsideTransaction(inServiceFactory, readKey)).toBe(true);
    expect(diedInsideTransaction(inOverlayCheck, readKey)).toBe(true);
    // The guard fails before the transport: no round trip ran, and every transaction rolled back.
    expect(events.filter((event) => event === 'spicedb-rpc')).toEqual([]);
    expect(events.filter((event) => event === 'ROLLBACK')).toHaveLength(3);
  }),
);

const isRequest = Schema.is(Schema.instanceOf(Request));
/** Every fetch that reaches the platform is recorded; inside a marked transaction none may. */
const recordingFetch =
  (events: string[]) =>
  (input: Request | URL | string): Promise<Response> => {
    events.push(`fetch:${isRequest(input) ? input.url : String(input)}`);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
const [ownerModule] = makeOutboxWorkerComposition([{ appId: 'owner-release', moduleId: 'commerce.owner' }]).modules;
// @effect-diagnostics-next-line strictEffectProvide:off -- Test owner call over the platform fetch client.
const ownerFetch = HttpClient.get('https://owner.example/current').pipe(Effect.provide(FetchHttpClient.layer));
/** A second guarded Core client: its statements would check out a connection of their own. */
const secondPool = (events: string[]) =>
  Layer.build(
    scriptedPgClientLayer(
      Effect.succeed(
        testSqlConnection((text) =>
          Effect.sync(() => {
            events.push(`second-pool:${text}`);
            return [];
          }),
        ),
      ),
    ).pipe(Layer.provide(Reactivity.layer)),
  ).pipe(Effect.map((context) => guardPoolAcquisition(Context.get(context, PgClient.PgClient))));

it.effect('refuses outbound fetch, module transport, and a second pooled connection between BEGIN and COMMIT', () =>
  Effect.gen(function* remoteIoInsideTransaction() {
    const events: string[] = [];
    const { readKey } = registration().descriptor;
    const pool = yield* secondPool(events);
    const releaseModule = yield* Effect.fromNullishOr(ownerModule).pipe(Effect.orDie);
    const runWith = (load: () => Effect.Effect<unknown>) =>
      Effect.gen(function* runReadWithRemoteIo() {
        const harness = yield* makeHarness({ permissionDecision: 'allowed', sqlEvents: events });
        return yield* Effect.exit(
          harness.runtime.runRead({
            input: {},
            principal: scope,
            registration: defineRead(
              registration().descriptor,
              { load: () => load().pipe(Effect.as({ evidence: { resultCount: 0 }, result: [] })) },
              () => Effect.succeed({}),
              () => ({ kind: 'module', moduleId: 'core.shell' }),
            ),
            transport: { correlationId: scope.correlationId },
          }),
        );
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, recordingFetch(events)));
    // Owner code that maps the failed fetch away still dies: the mark re-raises the refusal.
    const fetchMappedAway = yield* runWith(() => ownerFetch.pipe(Effect.ignore));
    const fetchInLoad = yield* runWith(() => ownerFetch.pipe(Effect.orDie));
    const moduleTransport = yield* runWith(() =>
      moduleReleaseFetch(new Request('https://owner.example/api/records'), releaseModule).pipe(Effect.orDie),
    );
    const secondConnection = yield* runWith(() => pool.unsafe('select 1').withoutTransform.pipe(Effect.orDie));
    expect(diedInsideTransaction(fetchMappedAway, readKey, 'outbound-fetch')).toBe(true);
    expect(diedInsideTransaction(fetchInLoad, readKey, 'outbound-fetch')).toBe(true);
    expect(diedInsideTransaction(moduleTransport, readKey, 'module-transport')).toBe(true);
    expect(diedInsideTransaction(secondConnection, readKey, 'pool-acquisition')).toBe(true);
    // Nothing left the process and the second pool was never asked for a connection.
    expect(events.filter((event) => event.startsWith('fetch:') || event.startsWith('second-pool:'))).toEqual([]);
    expect(events.filter((event) => event === 'ROLLBACK')).toHaveLength(4);
    // Outside a transaction the same calls go through.
    yield* ownerFetch.pipe(Effect.provideService(FetchHttpClient.Fetch, recordingFetch(events)), Effect.orDie);
    yield* pool.unsafe('select 1').withoutTransform.pipe(Effect.orDie);
    expect(events.filter((event) => event.startsWith('fetch:') || event.startsWith('second-pool:'))).toEqual([
      'fetch:https://owner.example/current',
      'second-pool:select 1',
    ]);
  }),
);

it.effect('gives finish short owner transactions: owner state between remote calls, never remote I/O inside', () =>
  Effect.gen(function* finishOwnerTransactions() {
    const events: string[] = [];
    const { readKey } = registration().descriptor;
    const harness = yield* makeHarness({ permissionDecision: 'allowed', sqlEvents: events });
    const run = (
      finish: (
        input: Readonly<Record<string, never>>,
        context: ReadFinishContext<unknown, unknown>,
      ) => Effect.Effect<ReadHandlerResult<readonly string[]>>,
    ) =>
      Effect.exit(
        harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: defineRead(
            registration().descriptor,
            {
              // oxlint-disable perfectionist/sort-objects -- Steps stay in execution order: each step's types infer from the previous one.
              prepare: () => ownerFetch.pipe(Effect.orDie),
              load: () => Effect.sync(() => events.push('owner-load')),
              finish,
              // oxlint-enable perfectionist/sort-objects
            },
            () => Effect.succeed({}),
            () => ({ kind: 'module', moduleId: 'core.shell' }),
          ),
          transport: { correlationId: scope.correlationId },
        }),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, recordingFetch(events)));
    const interleaved = yield* run((_input, context) =>
      context
        .transaction((transaction) =>
          Effect.sync(() => events.push(`owner-state:${transaction.scope.tenantId === scope.tenantId}`)),
        )
        .pipe(
          Effect.andThen(ownerFetch),
          Effect.andThen(context.transaction(() => Effect.sync(() => events.push('owner-state-again')))),
          Effect.orDie,
          Effect.as({ evidence: { resultCount: 0 }, result: [] }),
        ),
    );
    expect(Exit.isSuccess(interleaved)).toBe(true);
    expect(events).toEqual([
      'fetch:https://owner.example/current',
      'BEGIN',
      'owner-load',
      'COMMIT',
      'BEGIN',
      'owner-state:true',
      'COMMIT',
      'fetch:https://owner.example/current',
      'BEGIN',
      'owner-state-again',
      'COMMIT',
    ]);
    events.length = 0;
    const fetchInOwnerTransaction = yield* run((_input, context) =>
      context.transaction(() => ownerFetch).pipe(Effect.orDie, Effect.as({ evidence: { resultCount: 0 }, result: [] })),
    );
    expect(diedInsideTransaction(fetchInOwnerTransaction, readKey, 'outbound-fetch')).toBe(true);
    expect(events.filter((event) => event.startsWith('fetch:'))).toEqual(['fetch:https://owner.example/current']);
    expect(events.at(-1)).toBe('ROLLBACK');
  }),
);

it.effect(
  'authorizes an explicit Legal Entity target before handler resolution without substituting the selected context',
  Effect.fn(function* explicitLegalEntityTarget() {
    const targetId = '00000000-0000-4000-8000-000000000099';
    const selectedId = '00000000-0000-4000-8000-000000000004';
    const observed: string[] = [];
    let handlerCalls = 0;
    const targetRead = defineRead(
      {
        ...registration().descriptor,
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
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
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
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)(
      'retail.settings.payment_term_preference.manage',
    );
    const currencyRead = defineRead(
      {
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
        permissionTarget: 'business_permission',
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
      {
        load: () => {
          observed.push('handler');
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 1 }, result: 'CZK' });
        },
      },
      () => Effect.succeed({}),
      ({ authorizationProfileId }, trustedScope) => ({
        businessPermission: {
          permission,
          target: {
            kind: 'retail_profile',
            legalEntityId: trustedScope.legalEntityId ?? '',
            profileId: authorizationProfileId,
            tenantId: trustedScope.tenantId,
          },
        },
        kind: 'business_permission',
      }),
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
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('counterparty.order_history.read');
    const StorefrontCounterpartyIdSchema = Schema.String.pipe(Schema.brand('StorefrontCounterpartyId'));
    const StorefrontIdSchema = Schema.String.pipe(Schema.brand('StorefrontId'));
    const StorefrontInputSchema = Schema.Struct({
      counterpartyId: StorefrontCounterpartyIdSchema,
      storefrontId: StorefrontIdSchema,
    });
    let handlerCalls = 0;
    const storefrontRead = defineRead(
      {
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
        permissionTarget: 'business_permission',
        policies: [],
        readKey: 'commerce.customer-context.storefront-orders',
        resultSchema: Schema.Array(Schema.String),
        schemaVersion: '1',
      },
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
      },
      () => Effect.succeed({}),
      ({ counterpartyId, storefrontId }, trustedScope) => ({
        businessPermission: {
          permission,
          target: {
            counterpartyId,
            kind: 'counterparty_storefront',
            legalEntityId: trustedScope.legalEntityId ?? '',
            storefrontId,
            tenantId: trustedScope.tenantId,
          },
        },
        kind: 'business_permission',
        // Deliberately mirrors payload to prove this field is not itself a trust source.
        trustedStorefrontId: storefrontId,
      }),
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
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('pricing.price_group.read');
    const counterpartyPermission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)(
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
          permissionTarget: 'business_permission',
          policies: [],
          readKey: 'pricing.price-group.read',
          resultSchema: Schema.String,
          schemaVersion: '1',
        },
        {
          load: ({ priceGroupId: handledPriceGroupId }) => {
            handlerCalls += 1;
            return Effect.succeed({ evidence: { resultCount: 1 }, result: handledPriceGroupId });
          },
        },
        () => Effect.succeed({}),
        (input) => ({
          businessPermission: {
            permission: targetPermission,
            target: {
              kind: 'price_group',
              priceGroupId: input.priceGroupId,
              pricingCatalogId: input.pricingCatalogId,
              tenantId: input.targetTenantId,
            },
          },
          kind: 'business_permission',
        }),
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
        Predicate.isTagged(yield* Effect.flip(run(invalidIdentifier, invalidInput)), 'ReadHandlerExecutionError'),
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
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('inventory.resource.read');
    const InventoryResourceIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('InventoryResourceId'));
    const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('InventoryReadTenantId'));
    const InputSchema = Schema.Struct({
      resourceId: InventoryResourceIdSchema,
      tenantId: TenantIdSchema,
    });
    let handlerCalls = 0;
    const read = defineRead(
      {
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
        permissionTarget: 'business_permission',
        policies: [],
        readKey: 'commerce.inventory.stock-position.read',
        resultSchema: Schema.String,
        schemaVersion: '1',
      },
      {
        load: ({ resourceId }) => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 1 }, result: resourceId });
        },
      },
      () => Effect.succeed(Object.freeze({})),
      (input) => ({
        businessPermission: {
          permission,
          target: {
            kind: 'inventory_resource',
            resource: {
              moduleId: 'commerce.inventory',
              resourceId: input.resourceId,
              resourceType: 'commerce.inventory.stock-position',
            },
            tenantId: input.tenantId,
          },
        },
        kind: 'business_permission',
      }),
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
      { load: () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'visible' }) },
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
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({
            evidence: { resultCount: 1 },
            result: 'visible',
          });
        },
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
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
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
        {
          load: () => {
            handlerCalls += 1;
            return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
          },
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
        { load: () => scenario.outcome },
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
      { load: () => Effect.succeed({ evidence: { resultCount: 1 }, result: [candidate] }) },
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
      { load: () => Effect.succeed({ evidence: { resultCount: 1 }, result: [candidate] }) },
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
      { load: () => Effect.succeed({ evidence: { resultCount: 1 }, result: [candidate] }) },
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
            { load: () => Effect.fail(failure) },
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
  it.effect(`keeps ${mode} Read interruption and waits for transaction settlement`, () =>
    Effect.gen(function* migratedTest25() {
      const events: string[] = [];
      const sqlEvents: string[] = [];
      const harness = yield* makeHarness({ sqlEvents, transactionEvents: events });

      const entered = yield* Deferred.make<boolean>();
      const blocked = yield* Deferred.make<boolean>();
      const governed = defineRead(
        registration().descriptor,
        {
          load: () =>
            Effect.gen(function* blockedReadHandler() {
              yield* Deferred.succeed(entered, true);
              yield* Deferred.await(blocked);
              return { evidence: { resultCount: 0 }, result: [] };
            }),
        },
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
      expect(events).toEqual(['transaction_settled', 'read_completed']);
      expect(sqlEvents).toContain('ROLLBACK');
      expect(sqlEvents).not.toContain('COMMIT');
      expect(harness.authorityCounts()).toEqual({
        authorityLocks: mode === 'governed' ? 1 : 0,
        authorityReads: mode === 'governed' ? 2 : 0,
        scopeInstalls: 1,
      });
      expect(harness.evidence()).toBe(0);
    }),
  );
}
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
        { load: () => Effect.fail(denied) },
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
      expect(sqlEvents).not.toContain('COMMIT');
      expect(harness.authorityCounts()).toEqual({
        authorityLocks: mode === 'governed' ? 1 : 0,
        authorityReads: mode === 'governed' ? 2 : 0,
        scopeInstalls: 1,
      });
    }),
  );
}

it.effect('enforces named entrypoint context permission before services and handler', () =>
  Effect.gen(function* enforcesNamedContextPermission() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    let serviceCalls = 0;
    let handlerCalls = 0;
    const observedTargets: unknown[] = [];
    const historyRead = defineRead(
      {
        ...registration().descriptor,
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
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
        },
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

it.effect('asks the primary and entrypoint permissions together, in one authorization round trip', () =>
  Effect.gen(function* asksPermissionsTogether() {
    const legalEntityId = '00000000-0000-4000-8000-000000000004';
    const historyRead = defineRead(
      {
        ...registration().descriptor,
        entrypoint: defineTenantModuleEntrypoint({
          access: 'historical_read',
          authorization: { kind: 'context_permission', permission: 'customer.group.history.read' },
          entrypointKey: 'commerce.customer-context.customer-group-history',
          moduleKey: 'commerce.customer-context',
          role: 'api',
        }),
        legalEntityScope: 'required',
        owningModuleKey: 'commerce.customer-context',
        permissionTarget: 'resource',
      },
      { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) },
      () => Effect.succeed({}),
      () => ({
        kind: 'resource',
        resource: { moduleId: 'commerce.customer-context', resourceId: 'group-1', resourceType: 'customer-group' },
      }),
    );
    // The resource decision answers only once the entrypoint check has started: run one after the other, the Read
    // would never finish and the test would time out.
    const entrypointStarted = yield* Deferred.make<boolean>();
    const harness = yield* makeHarness({
      contextPermissionDecision: 'allowed',
      contextPermissionStarted: entrypointStarted,
      permissionDecision: 'allowed',
      resolvedScope: { ...scope, legalEntityId },
      resourcePermissionAwaits: entrypointStarted,
    });
    const result = yield* harness.runtime.runRead({
      input: {},
      principal: counterpartyReadPrincipal(legalEntityId),
      registration: historyRead,
      transport: { correlationId: scope.correlationId },
    });
    expect(result).toEqual([]);
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
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('retail.profile.read');
    const conditional = defineReadConditionalPermission<Input, Subject>({
      branches: {
        GUEST: {
          requiredKinds: ['module'],
          resolve: () => [{ kind: 'module', moduleId: 'commerce.customer-context' }],
        },
        PROFILE: {
          requiredKinds: ['business_permission', 'resource_read'],
          resolve: (_input, subject, trustedScope) => [
            {
              businessPermission: {
                permission,
                target: {
                  kind: 'retail_profile',
                  legalEntityId: trustedScope.legalEntityId ?? '',
                  profileId: subject.profileId,
                  tenantId: trustedScope.tenantId,
                },
              },
              kind: 'business_permission',
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
      permissionKey: 'module.access',
      select: ({ subject }) => subject,
    });
    let handlerCalls = 0;
    const read = defineRead(
      {
        ...registration().descriptor,
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
      {
        load: () => {
          handlerCalls += 1;
          return Effect.succeed({
            evidence: { resultCount: 1 },
            result: ['visible'],
          });
        },
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
      { load: () => Effect.fail(new DeclaredReadFailure({ reasonCode: 'PURPOSE_NOT_ALLOWED' })) },
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
