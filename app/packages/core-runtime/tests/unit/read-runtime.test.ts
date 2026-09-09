import { Cause, Deferred, Effect, Exit, Fiber, Option, Predicate, Schema } from 'effect';
/* oxlint-disable sonarjs/use-type-alias, typescript/no-unsafe-type-assertion -- Existing compatibility boundary; expires: 2026-12-31. */
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';

import { defineGlobalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import {
  defineSystemModuleEntrypoint,
  defineTenantModuleEntrypoint,
} from '../../src/modules/module-entrypoint.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import { BusinessPermissionCodeSchema } from '../../src/permissions/business-permission.ts';
import { toBusinessPermissionAccessKey } from '../../src/permissions/context-access.ts';
import type { BusinessPermissionAccessTarget } from '../../src/permissions/context-access.ts';
import type {
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
} from '../../src/permissions/owner-authorization-overlay.ts';
import { allowOwnerAuthorizationOverlay } from '../../src/permissions/owner-authorization-overlay.ts';
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
import { makeReadRuntime, READ_RUNTIME_STAGES } from '../../src/reads/runtime.ts';
import { makeTestDatabase } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

const scope = Object.freeze({
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:read-runtime',
  authMethod: 'session' as const,
  correlationId: 'correlation-1',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
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
    readonly businessPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly contextPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly failEvidence?: boolean;
    readonly modulePermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly onBusinessPermissionTarget?: (target: BusinessPermissionAccessTarget) => void;
    readonly onContextPermissionTarget?: (target: {
      readonly moduleId: string;
      readonly permission: string;
    }) => void;
    readonly onLegalEntityPermission?: (permission: string | undefined) => void;
    readonly onResourcePermission?: (permission: 'read' | 'write' | undefined) => void;
    readonly onResourceTarget?: (target: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
    }) => void;
    readonly onTenantPermission?: (permission: string) => void;
    readonly onTrustedStorefrontId?: (trustedStorefrontId: string | undefined) => void;
    readonly omitOwnerAuthorizationOverlay?: boolean;
    readonly ownerAuthorizationOverlay?: OwnerAuthorizationOverlayService;
    readonly permissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resolvedScope?: typeof scope & {
      readonly legalEntityId?: string;
      readonly trustedStorefrontId?: string;
    };
    readonly resourcePermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resultPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resultTenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly tenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly transactionEvents?: string[];
  } = {},
) {
  let businessPermissionChecks = 0;
  let contextPermissionChecks = 0;
  let evidence = 0;
  let resourcePermissionChecks = 0;
  let tenantPermissionChecks = 0;
  const evidenceRows: EvidenceRow[] = [];
  const evidenceParameterRows: unknown[][] = [];
  const query = (text: string, values: readonly unknown[]) =>
    Effect.gen(function* executeReadQuery() {
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
          ownerAuthorizationOverlay:
            options.ownerAuthorizationOverlay ?? allowOwnerAuthorizationOverlay,
        };
  const runtime = makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(options.resolvedScope ?? scope) },
    {
      businessPermissions: ({ targets, trustedStorefrontId }) => {
        businessPermissionChecks += 1;
        options.onTrustedStorefrontId?.(trustedStorefrontId);
        const [target] = targets;
        if (target !== undefined) {
          options.onBusinessPermissionTarget?.(target);
        }
        return Effect.succeed(
          targets.map((businessTarget) => ({
            decision:
              options.businessPermissionDecision ??
              options.permissionDecision ??
              ('unavailable' as const),
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
        return Effect.succeed(
          targets.map(({ moduleId, permission }) => ({
            decision: options.contextPermissionDecision ?? ('unavailable' as const),
            key: `${moduleId}:${permission}`,
          })),
        );
      },
      legalEntities: ({ legalEntityIds, permission }) => {
        options.onLegalEntityPermission?.(permission);
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
            decision:
              options.modulePermissionDecision ??
              options.permissionDecision ??
              ('unavailable' as const),
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
    {
      onStage: (stage) => stages.push(stage),
      ...ownerAuthorizationOptions,
    },
  );
  return {
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
    (_input, context) =>
      Effect.succeed({
        evidence: { resultCount: 0 },
        result: context.services.items,
      }),
    () => Effect.succeed({ items }),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
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
it.effect(
  'runs the owner authorization overlay inside the transaction before the Read handler',
  () =>
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
      expect(ownerInputs[0]?.targets).toEqual([{ kind: 'module', moduleId: 'core.shell' }]);
      expect(handlerCalls).toBe(0);
      expect(harness.evidence()).toBe(1);
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
    const permission = yield* Schema.decodeUnknownEffect(BusinessPermissionCodeSchema)(
      'retail.settings.currency.manage',
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
          entrypointKey: 'commerce.customer-context.currency-preference',
          moduleKey: 'commerce.customer-context',
          role: 'api',
        }),
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'commerce.customer-context.currency-preference.v1',
        },
        inputSchema: CurrencyReadInputSchema,
        legalEntityScope: 'required',
        owningModuleKey: 'commerce.customer-context',
        permissionTarget: 'business_permission',
        policies: [],
        readKey: 'commerce.customer-context.currency-preference',
        resourcePermission: defineReadResourcePermission<CurrencyReadInput>(
          ({ requestedProfileId }) => ({
            permission: 'read',
            resource: {
              moduleId: 'commerce.customer-context',
              resourceId: requestedProfileId,
              resourceType: 'retail-profile',
            },
          }),
        ),
        resultSchema: Schema.String,
        schemaVersion: '1',
      },
      () => {
        observed.push('handler');
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 1 }, result: 'CZK' });
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
    expect(
      Predicate.isTagged(yield* Effect.flip(run(businessDenied)), 'ReadPermissionDenied'),
    ).toBe(true);
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
    expect(
      Predicate.isTagged(yield* Effect.flip(run(resourceDenied)), 'ReadPermissionDenied'),
    ).toBe(true);
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
    expect(
      Predicate.isTagged(yield* Effect.flip(run(businessUnavailable)), 'ReadPermissionUnavailable'),
    ).toBe(true);
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
    expect(
      Predicate.isTagged(yield* Effect.flip(run(resourceUnavailable)), 'ReadPermissionUnavailable'),
    ).toBe(true);
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
    const permission = yield* Schema.decodeUnknownEffect(BusinessPermissionCodeSchema)(
      'counterparty.order_history.read',
    );
    const StorefrontCounterpartyIdSchema = Schema.String.pipe(
      Schema.brand('StorefrontCounterpartyId'),
    );
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
      () => {
        handlerCalls += 1;
        return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
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
      resolvedScope: trustVerifiedGatewayPrincipalContext({
        ...scope,
        legalEntityId,
        trustedStorefrontId: 'storefront-a',
      }),
    });
    expect(Exit.isFailure(yield* Effect.exit(run(mismatch, 'storefront-b')))).toBe(true);
    expect(mismatch.permissionChecks().businessPermissionChecks).toBe(0);

    const observedTrustedStorefrontIds: (string | undefined)[] = [];
    const allowed = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      onTrustedStorefrontId: (value) => observedTrustedStorefrontIds.push(value),
      permissionDecision: 'allowed',
      resolvedScope: trustVerifiedGatewayPrincipalContext({
        ...scope,
        legalEntityId,
        trustedStorefrontId: 'storefront-a',
      }),
    });
    expect(yield* run(allowed, 'storefront-a')).toEqual([]);
    expect(observedTrustedStorefrontIds).toEqual(['storefront-a']);
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
it.effect('keeps read interruption and waits for transaction settlement', () =>
  Effect.gen(function* migratedTest25() {
    const events: string[] = [];
    const harness = yield* makeHarness({ transactionEvents: events });

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
        principal: scope,
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
    expect(harness.evidence()).toBe(0);
  }),
);
it.effect('prioritizes failed denial evidence while retaining permission denial in the cause', () =>
  Effect.gen(function* migratedTest26() {
    const harness = yield* makeHarness({ failEvidence: true });
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
        principal: scope,
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
    expect(
      Predicate.isTagged(yield* Effect.flip(run(unavailable)), 'ReadPermissionUnavailable'),
    ).toBe(true);
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
    const permission = yield* Schema.decodeUnknownEffect(BusinessPermissionCodeSchema)(
      'retail.profile.read',
    );
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
    const profileId = yield* Schema.decodeUnknownEffect(RetailRequestedProfileIdSchema)(
      'profile-1',
    );

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
          decisions.businessPermissionDecision === 'denied' ||
            decisions.resourcePermissionDecision === 'denied'
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
    class DeclaredReadFailure extends Schema.TaggedError<DeclaredReadFailure>()(
      'DeclaredReadFailure',
      { reasonCode: Schema.Literal('PURPOSE_NOT_ALLOWED') },
    ) {}
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
    expect((yield* Schema.decodeUnknownEffect(DeclaredReadFailure)(failure)).reasonCode).toBe(
      'PURPOSE_NOT_ALLOWED',
    );
  }),
);
