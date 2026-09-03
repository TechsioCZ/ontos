// @effect-diagnostics asyncFunction:off
/* eslint-disable require-await, promise/prefer-await-to-callbacks, unicorn/no-useless-undefined -- The fake transaction mirrors Drizzle's callback and CRUD surface. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Predicate, Schema } from 'effect';
import { Pool } from 'pg';
import { defineRead } from '../../src/reads/definition.ts';
import { defineGlobalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
} from '../../src/reads/errors.ts';
import { makeReadRuntime, READ_RUNTIME_STAGES } from '../../src/reads/runtime.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import { coreDatabaseSchema } from '../../src/db/schema.ts';
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

const makeHarness = (
  options: {
    readonly failEvidence?: boolean;
    readonly onResourceTarget?: (target: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
    }) => void;
    readonly permissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resultPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
    readonly resolvedScope?: typeof scope & { readonly legalEntityId?: string };
  } = {},
) => {
  let evidence = 0;
  const evidenceRows: EvidenceRow[] = [];
  const QueryConfigSchema = Schema.Struct({ text: Schema.String });
  const query = async <Query, Values>(queryInput: Query, values?: Values) => {
    const { text } = Schema.decodeUnknownSync(QueryConfigSchema)(queryInput);
    if (text.includes('data_access_events')) {
      if (options.failEvidence === true) {
        throw new Error('private persistence detail');
      }
      const queryHash = Array.isArray(values)
        ? values.find((value) => Predicate.isString(value) && /^[\da-f]{64}$/u.test(value))
        : undefined;
      evidenceRows.push(queryHash === undefined ? {} : { queryHash });
      evidence += 1;
    }
    return text.includes('current_setting')
      ? {
          rows: [
            {
              legal_entity_id: options.resolvedScope?.legalEntityId ?? '',
              tenant_id: scope.tenantId,
            },
          ],
        }
      : { rows: [] };
  };
  const pool = new Pool();
  Object.defineProperty(pool, 'connect', {
    value: async () => ({ query, release: () => {} }),
  });
  Object.defineProperty(pool, 'query', { value: query });
  const database = {
    executor: drizzle({ client: pool, schema: coreDatabaseSchema }),
  };
  const stages: string[] = [];
  const runtime = makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(options.resolvedScope ?? scope) },
    {
      legalEntities: ({ legalEntityIds }) =>
        Effect.succeed(
          legalEntityIds.map((key) => ({
            decision: options.permissionDecision ?? ('unavailable' as const),
            key,
          })),
        ),
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
      tenants: ({ tenantIds }) =>
        Effect.succeed(
          tenantIds.map((key) => ({
            decision: options.permissionDecision ?? ('unavailable' as const),
            key,
          })),
        ),
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

test('runs every gate before the handler and persists evidence before releasing zero results', async () => {
  const harness = makeHarness();
  const result = await Effect.runPromise(
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

test('uses each denying Policy reference own declared HTTP status', async () => {
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
      const error = await Effect.runPromise(
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
      if (error._tag === 'ReadPolicyDenied') {
        assert.equal(error.httpStatus, denialStatus);
      }
    }),
  );
});

test('executes every governed access kind and computes hash-only query evidence inside Core', async () => {
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
          await Effect.runPromise(
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
        assert.match(String(harness.evidenceRows()[0]?.['queryHash']), /^[\da-f]{64}$/u);
      },
    ),
  );
});

test('rejects invalid input before opening a transaction or executing a handler', async () => {
  const harness = makeHarness();
  const error = await Effect.runPromise(
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

test('preserves typed result-validation failure across transaction rollback', async () => {
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
  const error = await Effect.runPromise(
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

test('never releases an allowed result when required evidence persistence fails', async () => {
  const harness = makeHarness({ failEvidence: true });
  const error = await Effect.runPromise(
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

test('preserves scoped service-factory unavailability and never invokes the handler', async () => {
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
  const error = await Effect.runPromise(
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

test('persists sanitized permission denial and never invokes the private handler', async () => {
  const legalEntityId = '00000000-0000-4000-8000-000000000004';
  const harness = makeHarness({
    permissionDecision: 'denied',
    resolvedScope: { ...scope, legalEntityId },
  });
  let handlerCalls = 0;
  const deniedRegistration = defineRead(
    {
      ...registration().descriptor,
      legalEntityScope: 'required',
      permissionTarget: 'legal_entity',
    },
    () => {
      handlerCalls += 1;
      return Effect.succeed({ evidence: { resultCount: 0 }, result: [] });
    },
    () => Effect.succeed({}),
    () => ({ kind: 'legal_entity' }),
  );
  const error = await Effect.runPromise(
    Effect.flip(
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
        registration: deniedRegistration,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(error._tag, 'ReadPermissionDenied');
  assert.equal(handlerCalls, 0);
  assert.equal(harness.evidence(), 1);
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
      inputSchema: Schema.Struct({
        moduleId: Schema.String,
        resourceId: Schema.String,
        resourceType: Schema.String,
      }),
      legalEntityScope: 'required',
      permissionTarget: 'resource',
      resultSchema: Schema.String,
    },
    () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'visible' }),
    () => Effect.succeed({}),
    (input) => ({ kind: 'resource', resource: input }),
  );
  const result = await Effect.runPromise(
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

test('rejects handler-controlled hashes in metadata-only evidence', async () => {
  const harness = makeHarness();
  const unboundedEvidence = defineRead(
    registration().descriptor,
    () => Effect.succeed({ evidence: { queryHash: 'raw query text', resultCount: 1 }, result: [] }),
    () => Effect.succeed({}),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );
  const error = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: unboundedEvidence,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(error._tag, 'ReadEvidenceValidationError');
  assert.equal(harness.evidence(), 0);
});

test('persists late definite denial after rolling back the owner transaction', async () => {
  const harness = makeHarness();
  const lateDenial = defineRead(
    registration().descriptor,
    () =>
      Effect.fail(
        new ReadPermissionDenied({
          code: 'read_permission_denied',
          reason: 'A late provider target check denied this read',
        }),
      ),
    () => Effect.succeed({}),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );
  const error = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runRead({
        input: {},
        principal: scope,
        registration: lateDenial,
        transport: { correlationId: scope.correlationId },
      }),
    ),
  );
  assert.equal(error._tag, 'ReadPermissionDenied');
  assert.equal(harness.evidence(), 1);
});

test('does not release generated search candidates denied by result-level authorization', async () => {
  const legalEntityId = '00000000-0000-4000-8000-000000000004';
  const candidate = {
    moduleId: 'inventory.stock',
    resourceId: 'stock-1',
    resourceType: 'inventory.stock.item',
  };
  const harness = makeHarness({
    permissionDecision: 'allowed',
    resolvedScope: { ...scope, legalEntityId },
    resultPermissionDecision: 'denied',
  });
  const searchRegistration = defineRead(
    {
      ...registration().descriptor,
      legalEntityScope: 'required',
      resultSchema: Schema.Array(
        Schema.Struct({
          moduleId: Schema.String,
          resourceId: Schema.String,
          resourceType: Schema.String,
        }),
      ),
    },
    () => Effect.succeed({ evidence: { resultCount: 1 }, result: [candidate] }),
    () => Effect.succeed({}),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
    (result) => result,
  );
  const error = await Effect.runPromise(
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
      const error = await Effect.runPromise(
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
