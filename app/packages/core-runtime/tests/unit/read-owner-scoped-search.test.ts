import { NodeCrypto } from '@effect/platform-node';
import { Cause, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { OperationalScope } from '../../src/operations/context.ts';
import { OperationContextDenied } from '../../src/operations/errors.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';

const moduleId = 'demo.owner-ledger';
const companyA = '71000000-0000-4000-8000-000000000020';
const companyB = '71000000-0000-4000-8000-000000000021';
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-01-01T00:00:00.000Z')));
const descriptor = () => ({
  accessKind: 'search' as const,
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.owner-ledger.search.records',
    moduleKey: moduleId,
    role: 'search',
  }),
  evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: 'demo.owner-ledger.search.evidence.v1' },
  inputSchema: Schema.Struct({ query: Schema.String }),
  legalEntityScope: 'required' as const,
  owningModuleKey: moduleId,
  permissionTarget: 'module' as const,
  policies: [],
  readKey: 'demo.owner-ledger.search.records',
  resultAuthorization: {
    accessFiltering: 'legal_entity_scope' as const,
    kind: 'owner-legal-entity-scope' as const,
    requiredModuleAccess: true as const,
  },
  resultSchema: Schema.Array(Schema.String),
  schemaVersion: '1',
});

it('requires a result resolver unless the exact owner-scoped declaration is present', () => {
  const { resultAuthorization: ignored, ...ordinary } = descriptor();
  expect(ignored.kind).toBe('owner-legal-entity-scope');
  expect(() =>
    defineRead(
      ordinary,
      { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId }),
    ),
  ).toThrow();
});

it('rejects absent/wrong filtering, optional company, non-module permission and ambiguous resolvers', () => {
  for (const invalid of ['missing-filter', 'wrong-filter', 'optional-company', 'wrong-permission'] as const) {
    const input = descriptor();
    if (invalid === 'missing-filter') {
      Reflect.deleteProperty(input.resultAuthorization, 'accessFiltering');
    } else if (invalid === 'wrong-filter') {
      Reflect.set(input.resultAuthorization, 'accessFiltering', 'resource_permission');
    } else if (invalid === 'optional-company') {
      Reflect.set(input, 'legalEntityScope', 'optional');
    } else {
      Reflect.set(input, 'permissionTarget', 'resource');
    }
    expect(() =>
      defineRead(
        input,
        { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) },
        () => Effect.succeed({}),
        () => ({ kind: 'module', moduleId }),
      ),
    ).toThrow();
  }
  expect(() =>
    defineRead(
      descriptor(),
      { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId }),
      () => [],
    ),
  ).toThrow();
});

it('freezes a separate result-authorization snapshot', () => {
  const input = descriptor();
  const registration = defineRead(
    input,
    { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) },
    () => Effect.succeed({}),
    () => ({ kind: 'module', moduleId }),
  );
  expect(Object.isFrozen(registration.descriptor.resultAuthorization)).toBe(true);
  Reflect.set(input.resultAuthorization, 'requiredModuleAccess', false);
  expect(registration.descriptor.resultAuthorization?.requiredModuleAccess).toBe(true);
});

const runScopedSearch = Effect.fn('Read.testOwnerScopedSearch')(function* run(
  selectedCompany: string | undefined,
  allowed: boolean,
  targetModule = moduleId,
) {
  const principal: OperationalScope = {
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'session:owner-scoped-search',
    authMethod: 'session' as const,
    correlationId: 'owner-scoped-search-test',
    principalId: '72000000-0000-4000-8000-000000000023',
    tenantId: '70000000-0000-4000-8000-000000000020',
  };
  if (selectedCompany !== undefined) {
    Object.assign(principal, { legalEntityId: selectedCompany });
  }
  let ownerRuns = 0;
  const registration = defineRead(
    descriptor(),
    {
      load: () =>
        Effect.sync(() => {
          ownerRuns += 1;
          return { evidence: { resultCount: 1 }, result: ['current-company-invoice'] };
        }),
    },
    () => Effect.succeed({}),
    () => ({ kind: 'module', moduleId: targetModule }),
  );
  const harness = yield* makeReadTestHarness({
    compositionRevision: 'a'.repeat(64),
    executeOwnerQuery: () => Effect.die('This owner has no SQL query in the fixture'),
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: allowed ? 'allowed' : 'denied',
    scope: principal,
  });
  const services = yield* Layer.build(harness.layer);
  const exit = yield* harness.runtime
    .runRead({
      input: { query: '2026' },
      principal,
      registration,
      transport: { correlationId: principal.correlationId },
    })
    .pipe(Effect.provideContext(services), Effect.exit);
  return { exit, ownerRuns };
});

it.layer(NodeCrypto.layer)('owner-scoped search', (test) => {
  test.effect('keeps module access and selected-company denial ahead of owner work', () =>
    Effect.gen(function* ownerScopedPermissionTest() {
      const positive = yield* runScopedSearch(companyA, true);
      expect(Exit.isSuccess(positive.exit) ? positive.exit.value : []).toEqual(['current-company-invoice']);
      expect(positive.ownerRuns).toBe(1);
      for (const company of [companyA, companyB]) {
        const denied = yield* runScopedSearch(company, false);
        expect(Exit.isFailure(denied.exit)).toBe(true);
        expect(denied.ownerRuns).toBe(0);
        const failure = Exit.isFailure(denied.exit)
          ? Option.getOrUndefined(Cause.findErrorOption(denied.exit.cause))
          : undefined;
        expect(Schema.is(OperationContextDenied)(failure)).toBe(true);
      }
      const foreignModule = yield* runScopedSearch(companyA, true, 'demo.foreign');
      expect(Exit.isFailure(foreignModule.exit)).toBe(true);
      expect(foreignModule.ownerRuns).toBe(0);
      const withoutCompany = yield* runScopedSearch(undefined, true);
      expect(Exit.isFailure(withoutCompany.exit)).toBe(true);
      expect(withoutCompany.ownerRuns).toBe(0);
    }),
  );
});
