import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
/* oxlint-disable sonarjs/use-type-alias, typescript/no-unsafe-type-assertion -- Existing compatibility boundary; expires: 2026-12-31. */
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { Cause, Deferred, Effect, Exit, Fiber, Option, Predicate, Schema } from 'effect';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import assert from 'node:assert/strict';
import test from 'node:test';
import { defineGlobalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import { defineRead } from '../../src/reads/definition.ts';
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
const ResourceTargetSchema = Schema.Struct({
  moduleId: ModuleIdSchema,
  resourceId: ResourceIdSchema,
  resourceType: Schema.String,
});

const makeHarness = (
  options: {
    readonly failEvidence?: boolean;
    readonly onLegalEntityPermission?: (permission: string | undefined) => void;
    readonly onResourceTarget?: (target: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
    }) => void;
    readonly onTenantPermission?: (permission: string) => void;
    readonly permissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resolvedScope?: typeof scope & { readonly legalEntityId?: string };
    readonly resultPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resultTenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly tenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly transactionEvents?: string[];
  } = {},
) => {
  let evidence = 0;
  let tenantPermissionChecks = 0;
  const evidenceRows: EvidenceRow[] = [];
  const query = (text: string, values: readonly unknown[]) =>
    Effect.gen(function* executeReadQuery() {
      if (text.includes('data_access_events')) {
        if (options.failEvidence === true) {
          return yield* new SqlError({
            reason: new ConnectionError({ cause: new Error('private persistence detail') }),
          });
        }
        const queryHash = values
          .filter(Predicate.isString)
          .find((value) => /^[\da-f]{64}$/u.test(value));
        evidenceRows.push(queryHash === undefined ? {} : { queryHash });
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
  const database = { executor: makeTestDatabase(query) };
  const transact = database.executor.transaction.bind(database.executor);
  const transaction: typeof database.executor.transaction = (body) =>
    transact(body).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          options.transactionEvents?.push('transaction_settled');
        }),
      ),
    );
  Object.defineProperty(database.executor, 'transaction', { value: transaction });
  const stages: string[] = [];
  const runtime = makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(options.resolvedScope ?? scope) },
    {
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
            decision: options.permissionDecision ?? ('unavailable' as const),
            key,
          })),
        ),
      resources: ({ resources }) => {
        const [target] = resources;
        if (target !== undefined) {
          options.onResourceTarget?.(target);
        }
        return Effect.succeed(
          resources.map((resource) => ({
            decision:
              options.resultPermissionDecision ??
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
                : (options.tenantPermissionDecision ??
                  options.permissionDecision ??
                  ('unavailable' as const)),
            key,
          })),
        );
      },
    },
    { onStage: (stage) => stages.push(stage) },
  );
  return { evidence: () => evidence, evidenceRows: () => evidenceRows, runtime, stages };
};

const registration = (items: readonly string[] = []) =>
  defineRead(
    {
      accessKind: 'list',
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'core.shell.items',
        moduleKey: 'core.shell',
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.shell.items.v1' },
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

void test('runs every gate before the handler and persists evidence before releasing zero results', async () => {
  const harness = makeHarness();
  const result = await runEffectTestPromise(
    harness.runtime.runRead({
      input: {},
      principal: scope,
      registration: registration(),
      transport: { correlationId: scope.correlationId },
    }),
  );
  assert.deepEqual(result, []);
  assert.equal(harness.evidence(), 1);
  assert.deepEqual(harness.stages, READ_RUNTIME_STAGES);
});

void test('validates decoded transformed results and preserves their nullable JSON encoding', async () => {
  const harness = makeHarness();
  const ResultSchema = Schema.Struct({ value: Schema.OptionFromNullOr(Schema.String) });
  const transformedRegistration = defineRead(
    { ...registration().descriptor, resultSchema: ResultSchema },
    () => Effect.succeed({ evidence: { resultCount: 1 }, result: { value: Option.none() } }),
    () => Effect.succeed({}),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );
  const result = await runEffectTestPromise(
    harness.runtime.runRead({
      input: {},
      principal: scope,
      registration: transformedRegistration,
      transport: { correlationId: scope.correlationId },
    }),
  );
  const encoded = await runEffectTestPromise(
    Schema.encodeUnknownEffect(Schema.toCodecJson(ResultSchema))(result),
  );

  assert.ok(Option.isNone(result.value));
  assert.deepEqual(encoded, { value: null });
});

void test('uses each denying Policy reference own declared HTTP status', async () => {
  await Promise.all(
    ([409, 422] as const).map(async (denialStatus) => {
      const harness = makeHarness();
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
      const error = await runEffectTestPromise(
        Effect.flip(
          harness.runtime.runRead({
            input: {},
            principal: scope,
            registration: governed,
            transport: { correlationId: scope.correlationId },
          }),
        ),
      );
      assert.equal(error._tag, 'ReadPolicyDenied');
      assert.equal(Schema.decodeSync(ReadPolicyDenied)(error).httpStatus, denialStatus);
    }),
  );
});

void test('executes every governed access kind and computes hash-only query evidence inside Core', async () => {
  await Promise.all(
    (['detail', 'download', 'export', 'list', 'report', 'search'] as const).map(
      async (accessKind) => {
        const legalEntityId = '00000000-0000-4000-8000-000000000004';
        const harness = makeHarness({
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
        assert.deepEqual(
          await runEffectTestPromise(
            harness.runtime.runRead({
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
          ),
          [],
        );
        assert.match(String(harness.evidenceRows()[0]?.queryHash), /^[\da-f]{64}$/u);
      },
    ),
  );
});

void test('rejects invalid input before opening a transaction or executing a handler', async () => {
  const harness = makeHarness();
  const error = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runRead({
        input: { unexpected: Symbol('invalid') },
        principal: {},
        registration: registration(),
        transport: {},
      }),
    ),
  );
  assert.equal(error._tag, 'ReadInputValidationError');
  assert.equal(harness.evidence(), 0);
});

void test('preserves typed result-validation failure across transaction rollback', async () => {
  const harness = makeHarness();
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
  const error = await runEffectTestPromise(
    Effect.flip(
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
    ),
  );
  assert.equal(error._tag, 'ReadResultValidationError');
  assert.equal(harness.evidence(), 0);
});

void test('never releases an allowed result when required evidence persistence fails', async () => {
  const harness = makeHarness({ failEvidence: true });
  const error = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: registration(),
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(error._tag, 'ReadEvidencePersistenceError');
  assert.equal(harness.evidence(), 0);
});

void test('preserves scoped service-factory unavailability and never invokes the handler', async () => {
  const harness = makeHarness();
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
  const error = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: unavailableRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(error._tag, 'OperationContextUnavailable');
  assert.equal(handlerCalls, 0);
  assert.equal(harness.evidence(), 0);
});

const counterpartyReadRegistration = (
  legalEntityScope: 'required' | 'optional',
  onHandler: () => void,
) =>
  defineRead(
    { ...registration().descriptor, legalEntityScope, permissionTarget: 'legal_entity' },
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

void test('persists sanitized permission denial and never invokes the private handler', async () => {
  const legalEntityId = '00000000-0000-4000-8000-000000000004';
  const legalEntityPermissions: (string | undefined)[] = [];
  const harness = makeHarness({
    onLegalEntityPermission: (permission) => legalEntityPermissions.push(permission),
    permissionDecision: 'denied',
    resolvedScope: { ...scope, legalEntityId },
  });
  let handlerCalls = 0;
  const deniedRegistration = counterpartyReadRegistration('required', () => {
    handlerCalls += 1;
  });
  const error = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: counterpartyReadPrincipal(legalEntityId),
        registration: deniedRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(error._tag, 'ReadPermissionDenied');
  assert.deepEqual(legalEntityPermissions, ['read_counterparty']);
  assert.equal(handlerCalls, 0);
  assert.equal(harness.evidence(), 1);
});

test('fails closed when explicit Counterparty read authority is unavailable', async () => {
  const legalEntityId = '00000000-0000-4000-8000-000000000004';
  let handlerCalls = 0;
  const harness = makeHarness({
    permissionDecision: 'unavailable',
    resolvedScope: { ...scope, legalEntityId },
  });
  const counterpartyRead = counterpartyReadRegistration('optional', () => {
    handlerCalls += 1;
  });
  const error = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: counterpartyReadPrincipal(legalEntityId),
        registration: counterpartyRead,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(error._tag, 'ReadPermissionUnavailable');
  assert.equal(handlerCalls, 0);
  assert.equal(harness.evidence(), 0);
});

test('derives the authorized resource from decoded input and ignores conflicting transport hints', async () => {
  const legalEntityId = '00000000-0000-4000-8000-000000000004';
  let authorizedTarget: { moduleId: string; resourceId: string; resourceType: string } | undefined;
  const harness = makeHarness({
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
  const result = await runEffectTestPromise(
    harness.runtime.runRead({
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
    }),
  );
  assert.equal(result, 'visible');
  assert.deepEqual(authorizedTarget, target);
});

test('authorizes a canonical Resource through explicit tenant Party administration alternatives', async () => {
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
      return Effect.succeed({ evidence: { resultCount: 1 }, result: 'visible' });
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

  const tenantAdmin = makeHarness({
    permissionDecision: 'denied',
    tenantPermissionDecision: 'allowed',
  });
  assert.equal(
    await runEffectTestPromise(
      tenantAdmin.runtime.runRead({
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
    ),
    'visible',
  );
  assert.deepEqual(policyTargets, [
    {
      targetModuleKey: 'party.registry',
      targetResourceId: 'counterparty-1',
      targetResourceType: 'counterparty',
    },
  ]);

  const resourceAuthority = makeHarness({
    permissionDecision: 'allowed',
    resolvedScope: { ...scope, legalEntityId },
    tenantPermissionDecision: 'denied',
  });
  assert.equal(
    await runEffectTestPromise(
      resourceAuthority.runtime.runRead({
        input: target,
        principal,
        registration: counterpartyRead,
        transport: { correlationId: scope.correlationId },
      }),
    ),
    'visible',
  );

  const indeterminate = makeHarness({
    permissionDecision: 'denied',
    resolvedScope: { ...scope, legalEntityId },
    tenantPermissionDecision: 'unavailable',
  });
  const unavailable = await runEffectTestPromise(
    Effect.flip(
      indeterminate.runtime.runRead({
        input: target,
        principal,
        registration: counterpartyRead,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(unavailable._tag, 'ReadPermissionUnavailable');
  assert.equal(indeterminate.evidence(), 0);

  const denied = makeHarness({
    permissionDecision: 'denied',
    resolvedScope: { ...scope, legalEntityId },
    tenantPermissionDecision: 'denied',
  });
  const denial = await runEffectTestPromise(
    Effect.flip(
      denied.runtime.runRead({
        input: target,
        principal,
        registration: counterpartyRead,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(denial._tag, 'ReadPermissionDenied');
  assert.equal(denied.evidence(), 1);
  assert.equal(handlerCalls, 2);
});

test('rejects generic tenant access as an alternative permission target', async () => {
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
  const failure = await runEffectTestPromise(
    Effect.flip(
      makeHarness({ resolvedScope: { ...scope, legalEntityId } }).runtime.runRead({
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
    ),
  );
  assert.equal(failure._tag, 'ReadHandlerExecutionError');
  assert.equal(handlerCalls, 0);
});

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
  test(scenario.name, async () => {
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
    const failure = await runEffectTestPromise(
      Effect.flip(
        makeHarness({
          tenantPermissionDecision: scenario.tenantPermissionDecision,
        }).runtime.runRead({
          input: {},
          principal: scope,
          registration: alternativeRead,
          transport: { correlationId: scope.correlationId },
        }),
      ),
    );
    assert.equal(failure._tag, scenario.expectedFailure);
    assert.equal(handlerCalls, 0);
  });
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
  test(scenario.name, async () => {
    const harness = makeHarness();
    const failingRead = defineRead(
      registration().descriptor,
      () => scenario.outcome,
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const error = await runEffectTestPromise(
      Effect.flip(
        harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: failingRead,
          transport: { correlationId: scope.correlationId },
        }),
      ),
    );
    assert.equal(error._tag, scenario.expectedFailure);
    assert.equal(harness.evidence(), scenario.expectedEvidence);
  });
}

void test('does not release generated search candidates denied by result-level authorization', async () => {
  const legalEntityId = '00000000-0000-4000-8000-000000000004';
  const candidate = Schema.decodeSync(ResourceTargetSchema)({
    moduleId: 'inventory.stock',
    resourceId: 'stock-1',
    resourceType: 'inventory.stock.item',
  });
  const harness = makeHarness({
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
  const error = await runEffectTestPromise(
    Effect.flip(
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
    ),
  );
  assert.equal(error._tag, 'ReadPermissionDenied');
  assert.equal(harness.evidence(), 1);
});

test('authorizes tenant-scoped Party search results without fabricating a Legal Entity', async () => {
  const candidate = Schema.decodeSync(ResourceTargetSchema)({
    moduleId: 'party.registry',
    resourceId: 'party-1',
    resourceType: 'party.registry.party',
  });
  let resourceChecks = 0;
  const tenantPermissions: string[] = [];
  const harness = makeHarness({
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

  assert.deepEqual(
    await runEffectTestPromise(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: searchRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ),
    [candidate],
  );
  assert.deepEqual(tenantPermissions, ['read_party_identity', 'read_party_identity']);
  assert.equal(resourceChecks, 0);
});

test('fails closed when tenant-scoped Party result authorization becomes unavailable', async () => {
  const candidate = Schema.decodeSync(ResourceTargetSchema)({
    moduleId: 'party.registry',
    resourceId: 'party-1',
    resourceType: 'party.registry.party',
  });
  const harness = makeHarness({
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
  const failure = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: searchRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(failure._tag, 'ReadPermissionUnavailable');
});

test('preserves declared owner read availability and not-found failures but sanitizes defects', async () => {
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
  const expectedTags = [
    'ReadHandlerUnavailable',
    'ReadHandlerNotFound',
    'ReadHandlerExecutionError',
  ];
  await Promise.all(
    failures.map(async (failure, index) => {
      const harness = makeHarness();
      const failingRegistration = defineRead(
        registration().descriptor,
        () => Effect.fail(failure),
        () => Effect.succeed({}),
        () => ({ kind: 'module', moduleId: 'core.shell' }),
      );
      const error = await runEffectTestPromise(
        Effect.flip(
          harness.runtime.runRead({
            input: {},
            principal: scope,
            registration: failingRegistration,
            transport: { correlationId: scope.correlationId },
          }),
        ),
      );
      assert.equal(error._tag, expectedTags[index]);
      assert.doesNotMatch(error.reason, /secret/u);
      assert.equal(harness.evidence(), 0);
    }),
  );
});

void test('keeps read interruption and waits for transaction settlement', async () => {
  const events: string[] = [];
  const harness = makeHarness({ transactionEvents: events });
  const exit = await runEffectTestPromise(
    Effect.gen(function* interruptReadTest() {
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
      return yield* Fiber.await(fiber);
    }),
  );
  assert.ok(Exit.isFailure(exit));
  assert.ok(Cause.hasInterruptsOnly(exit.cause));
  assert.deepEqual(events, ['transaction_settled', 'read_completed']);
  assert.equal(harness.evidence(), 0);
});

void test('prioritizes failed denial evidence while retaining permission denial in the cause', async () => {
  const harness = makeHarness({ failEvidence: true });
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
  const exit = await runEffectTestPromise(
    Effect.exit(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: governed,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  const failures = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
  assert.equal(failures.length, 2);
  assert.equal(failures[0]?._tag, 'ReadEvidencePersistenceError');
  assert.equal(failures[1], denied);
  assert.equal(failures[1]._tag, 'ReadPermissionDenied');
});
