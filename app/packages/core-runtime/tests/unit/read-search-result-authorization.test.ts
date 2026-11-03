import { NodeCrypto } from '@effect/platform-node';
import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { denyPolicy, defineGlobalPolicy } from '../../src/actions/policy.ts';
import type { ActionPolicy } from '../../src/actions/policy.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { OperationAuthenticationRequired, OperationContextUnavailable } from '../../src/operations/errors.ts';
import type {
  ContextAccessResult,
  ContextAccessService,
  ResourceAccessTarget,
} from '../../src/permissions/context-access.ts';
import { transactionalOwnerAuthorization } from '../../src/permissions/owner-authorization-overlay.ts';
import type { ReadEvidenceMetadata } from '../../src/reads/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadAccessKind } from '../../src/reads/definition.ts';
import { makeReadRuntime, READ_RUNTIME_STAGES } from '../../src/reads/runtime.ts';
import {
  ReadHandlerExecutionError,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  ReadPolicyDenied,
  ReadResultValidationError,
} from '../../src/reads/errors.ts';
import {
  authorizeReadSearchCollection,
  defineReadSearchCollectionAuthorization,
} from '../../src/reads/search-result-authorization.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

const moduleId = 'demo.search-authorization';
const policyKey = `${moduleId}.evidence.v1`;
const scope: OperationalScope = Object.freeze({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:search-authorization',
  authMethod: 'session',
  correlationId: 'search-authorization-test',
  legalEntityId: '71000000-0000-4000-8000-000000000020',
  principalId: '72000000-0000-4000-8000-000000000023',
  tenantId: '70000000-0000-4000-8000-000000000020',
});
const operationAt = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-01-01T00:00:00.000Z')));
const ModuleIdSchema = Schema.String.pipe(Schema.brand('SearchFixtureModuleId'));
const ResourceIdSchema = Schema.String.pipe(Schema.brand('SearchFixtureResourceId'));
const HitSchema = Schema.Struct({
  ref: Schema.Struct({ moduleId: ModuleIdSchema, resourceId: ResourceIdSchema, resourceType: Schema.String }),
  title: Schema.String,
});
const ResultSchema = Schema.Struct({
  count: Schema.Finite,
  items: Schema.Array(HitSchema),
  subjects: Schema.Array(Schema.String),
});
type Hit = typeof HitSchema.Type;
type SearchResult = typeof ResultSchema.Type;
const hit = (resourceId: string): Hit =>
  Schema.decodeSync(HitSchema)({
    ref: { moduleId, resourceId, resourceType: `${moduleId}.record` },
    title: `Title ${resourceId}`,
  });
const candidates = [hit('allowed-a'), hit('secret-denied'), hit('allowed-b')];
const response = (items: readonly Hit[]): SearchResult => ({
  count: items.length,
  items,
  subjects: items.map((item) => item.ref.resourceId),
});
const adapter = () =>
  defineReadSearchCollectionAuthorization({
    items: (result: SearchResult) => result.items,
    resource: (item) => item.ref,
    resultSchema: ResultSchema,
    withItems: (_result, items) => response(items),
  });
const descriptor = (accessKind: ReadAccessKind = 'search') => ({
  accessKind,
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: `${moduleId}.search`,
    moduleKey: moduleId,
    role: 'search',
  }),
  evidencePolicy: { captureMode: 'metadata_only' as const, policyKey },
  inputSchema: Schema.Struct({ query: Schema.String }),
  legalEntityScope: 'required' as const,
  owningModuleKey: moduleId,
  permissionTarget: 'module' as const,
  policies: [],
  readKey: `${moduleId}.search`,
  resultSchema: ResultSchema,
  schemaVersion: '1',
});

const serviceFactory = () => Effect.succeed({});
const permissionTarget = () => ({ kind: 'module' as const, moduleId });
const registration = (
  items: readonly Hit[],
  options: {
    readonly accessKind?: ReadAccessKind;
    readonly authorization?: ReturnType<typeof adapter>;
    readonly captureMode?: 'hash_only' | 'metadata_only';
    readonly evidence?: ReadEvidenceMetadata;
    readonly mode?: 'collection' | 'generic' | 'owner';
    readonly policy?: ActionPolicy<{ readonly query: string }, typeof moduleId>;
  } = {},
) => {
  const ownerWork = {
    load: () =>
      Effect.succeed({ evidence: options.evidence ?? { resultCount: items.length }, result: response(items) }),
  };
  const executablePolicies = options.policy === undefined ? [] : [options.policy];
  const input = {
    ...descriptor(options.accessKind),
    evidencePolicy: { captureMode: options.captureMode ?? 'metadata_only', policyKey },
    policies: executablePolicies.map((policy) => ({ denialStatus: 422 as const, policyKey: policy.policyKey })),
  };
  if (options.mode === 'generic') {
    return defineRead(
      input,
      ownerWork,
      serviceFactory,
      permissionTarget,
      (result) => result.items.map((i) => i.ref),
      executablePolicies,
    );
  }
  if (options.mode === 'owner') {
    return defineRead(
      {
        ...input,
        resultAuthorization: {
          accessFiltering: 'legal_entity_scope',
          kind: 'owner-legal-entity-scope',
          requiredModuleAccess: true,
        },
      },
      ownerWork,
      serviceFactory,
      permissionTarget,
      undefined,
      executablePolicies,
    );
  }
  return defineRead(
    { ...input, resultAuthorization: options.authorization ?? adapter() },
    ownerWork,
    serviceFactory,
    permissionTarget,
    undefined,
    executablePolicies,
  );
};

type ResourceCheck = ContextAccessService['resources'];
type ScopeFailure = OperationAuthenticationRequired | OperationContextUnavailable;
const keyFor = (target: ResourceAccessTarget) => `${target.moduleId}:${target.resourceType}:${target.resourceId}`;
const decisionsFor = (resources: readonly ResourceAccessTarget[]): readonly ContextAccessResult[] =>
  resources.map((resource) => ({
    decision: resource.resourceId.startsWith('allowed') ? 'allowed' : 'denied',
    key: keyFor(resource),
  }));

/** Real Core lifecycle, Drizzle evidence writes and scoped transaction over a scripted SQL transport. */
const makeHarness = Effect.fn('SearchAuthorization.testHarness')(function* makeHarness(
  options: {
    readonly check?: ResourceCheck;
    readonly legalEntityDecision?: ContextAccessResult['decision'];
    readonly moduleDecision?: ContextAccessResult['decision'];
    readonly ownerDecision?: ContextAccessResult['decision'];
    readonly scope?: OperationalScope;
    readonly scopeFailure?: ScopeFailure;
    readonly tenantDecision?: ContextAccessResult['decision'];
    readonly tenantResources?: ContextAccessService['tenantResources'];
  } = {},
) {
  const selectedScope = options.scope ?? scope;
  const stages: string[] = [];
  const rows: (readonly unknown[])[] = [];
  const resourceChecks: Parameters<ResourceCheck>[0][] = [];
  const executor = yield* makeTestDatabase((sql, params) => {
    if (sql.includes('set_config') && sql.includes('transaction_timestamp')) {
      return Effect.succeed([
        { legal_entity_id: params[1], operation_at: operationAt, role: 'ontos_runtime', tenant_id: params[0] },
      ]);
    }
    if (sql.includes('set_config')) {
      return Effect.succeed([]);
    }
    if (sql.includes('transaction_timestamp')) {
      return Effect.succeed([{ operation_at: operationAt }]);
    }
    if (
      sql.trim().replaceAll(/\s+/gu, ' ') ===
      "select current_user::text as role, current_setting('ontos.tenant_id', true) as tenant_id, current_setting('ontos.legal_entity_id', true) as legal_entity_id"
    ) {
      return Effect.succeed([
        {
          legal_entity_id: selectedScope.legalEntityId ?? '',
          role: 'ontos_runtime',
          tenant_id: selectedScope.tenantId,
        },
      ]);
    }
    if (sql.includes('data_access_events')) {
      rows.push([...params]);
      return Effect.succeed([]);
    }
    if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/u.test(sql)) {
      return Effect.succeed([]);
    }
    return Effect.die(`Unexpected fixture SQL: ${sql}`);
  });
  const access: ContextAccessService = {
    legalEntities: ({ legalEntityIds }) =>
      Effect.succeed(legalEntityIds.map((key) => ({ decision: options.legalEntityDecision ?? 'allowed', key }))),
    modules: ({ moduleIds }) =>
      Effect.succeed(moduleIds.map((key) => ({ decision: options.moduleDecision ?? 'allowed', key }))),
    resources: (input) => {
      resourceChecks.push(input);
      return options.check?.(input) ?? Effect.succeed(decisionsFor(input.resources));
    },
    tenants: ({ tenantIds }) =>
      Effect.succeed(tenantIds.map((key) => ({ decision: options.tenantDecision ?? 'allowed', key }))),
  };
  if (options.tenantResources !== undefined) {
    Object.assign(access, { tenantResources: options.tenantResources });
  }
  return {
    principal: selectedScope,
    resourceChecks,
    rows,
    runtime: makeReadRuntime(
      { executor },
      openModuleEntrypointGateway,
      {
        resolve: () =>
          options.scopeFailure === undefined ? Effect.succeed(selectedScope) : Effect.fail(options.scopeFailure),
      },
      access,
      {
        databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
        onStage: (stage) => {
          stages.push(stage);
        },
        ownerAuthorizationOverlay: transactionalOwnerAuthorization(() =>
          Effect.succeed(options.ownerDecision ?? 'allowed'),
        ),
      },
    ),
    stages,
  };
});
const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, read: ReturnType<typeof registration>) =>
  harness.runtime.runRead({
    input: { query: 'query matching all fixture candidates' },
    principal: harness.principal,
    registration: read,
    transport: { correlationId: scope.correlationId },
  });
const expectAllowedEvidence = (rows: readonly (readonly unknown[])[], count: number) =>
  expect(rows).toEqual([
    [
      scope.tenantId,
      scope.legalEntityId,
      scope.principalId,
      scope.authBindingId,
      scope.authContextRef,
      scope.authMethod,
      'allowed',
      'evidence',
      'read_allowed',
      'search',
      moduleId,
      moduleId,
      count,
      policyKey,
      'metadata_only',
    ],
  ]);
const failureTag = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

it('admits only explicit search collection adapters and rejects ambiguous result resolvers', () => {
  for (const accessKind of ['detail', 'download', 'export', 'list', 'report'] as const) {
    expect(() => registration([], { accessKind })).toThrow();
  }
  const input = { ...descriptor(), resultAuthorization: adapter() };
  expect(() =>
    defineRead(
      input,
      { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: response([]) }) },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId }),
      () => [],
    ),
  ).toThrow();
  Reflect.set(
    input,
    'entrypoint',
    defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: `${moduleId}.api`,
      moduleKey: moduleId,
      role: 'api',
    }),
  );
  expect(() =>
    defineRead(
      input,
      { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: response([]) }) },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId }),
    ),
  ).toThrow();
});

it('freezes callbacks and rejects fabricated collection declarations', () => {
  const authorization = adapter();
  expect(Object.isFrozen(authorization)).toBe(true);
  expect(Reflect.set(authorization, 'select', () => [])).toBe(false);
  const invalid = adapter();
  const forged = { kind: 'search-collection', select: invalid.select };
  const input = { ...descriptor(), resultAuthorization: invalid };
  Reflect.set(input, 'resultAuthorization', Object.freeze(forged));
  expect(() =>
    defineRead(
      input,
      { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: response([]) }) },
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId }),
    ),
  ).toThrow();
});

it.layer(NodeCrypto.layer)('Core search collection lifecycle', (test) => {
  for (const scenario of [
    {
      items: candidates,
      name: 'mixed allowed/denied',
      retained: [candidates[0], candidates[2]].filter((i) => i !== undefined),
    },
    { items: [], name: 'no hits', retained: [] },
    { items: [hit('secret-denied')], name: 'denied only', retained: [] },
    { items: [hit('allowed-a')], name: 'allowed only', retained: [hit('allowed-a')] },
  ]) {
    test.effect(`returns admitted ${scenario.name} results and only post-filter evidence`, () =>
      Effect.gen(function* collectionLifecycle() {
        const harness = yield* makeHarness();
        expect(yield* run(harness, registration(scenario.items))).toEqual(response(scenario.retained));
        expect(harness.stages).toEqual(READ_RUNTIME_STAGES);
        expectAllowedEvidence(harness.rows, scenario.retained.length);
        expect(harness.resourceChecks).toEqual(
          scenario.items.length === 0
            ? []
            : [
                {
                  legalEntityId: scope.legalEntityId,
                  permission: 'read',
                  principalId: scope.principalId,
                  resources: scenario.items.map((item) => item.ref),
                  tenantId: scope.tenantId,
                },
              ],
        );
      }),
    );
  }

  test.effect('accepts exact keyed decisions out of order without changing result order', () =>
    Effect.gen(function* reorderedDecisions() {
      const harness = yield* makeHarness({
        check: ({ resources }) => Effect.succeed(decisionsFor(resources).toReversed()),
      });
      expect(yield* run(harness, registration(candidates))).toEqual(response([hit('allowed-a'), hit('allowed-b')]));
      expectAllowedEvidence(harness.rows, 2);
    }),
  );

  for (const malformed of [
    'missing',
    'duplicate',
    'foreign',
    'extra',
    'extra-field',
    'unavailable',
    'unknown',
    'undefined',
  ] as const) {
    test.effect(`fails closed on ${malformed} decisions without allowed evidence`, () =>
      Effect.gen(function* malformedDecisionTest() {
        const harness = yield* makeHarness({
          check: ({ resources }) => {
            const decisions = [...decisionsFor(resources)];
            const [first] = decisions;
            if (first !== undefined) {
              if (malformed === 'missing') {
                decisions.pop();
              } else if (malformed === 'duplicate') {
                decisions[1] = first;
              } else if (malformed === 'foreign') {
                decisions[0] = { ...first, key: 'foreign:resource:id' };
              } else if (malformed === 'extra') {
                decisions.push({ decision: 'allowed', key: 'foreign:resource:id' });
              } else if (malformed === 'extra-field') {
                Reflect.set(first, 'caveat', true);
              } else if (malformed === 'unknown') {
                Reflect.set(first, 'decision', 'conditional');
              } else if (malformed === 'undefined') {
                Reflect.set(first, 'decision', undefined);
              } else {
                Reflect.set(first, 'decision', 'unavailable');
              }
            }
            return Effect.succeed(decisions);
          },
        });
        const exit = yield* run(harness, registration(candidates)).pipe(Effect.exit);
        expect(Schema.is(ReadPermissionUnavailable)(failureTag(exit))).toBe(true);
        expect(harness.rows).toEqual([]);
        expect(harness.stages).not.toContain('evidence_persisted');
      }),
    );
  }

  for (const accessKind of ['detail', 'list', 'report', 'search'] as const) {
    test.effect(`preserves whole-result denial for non-opted-in ${accessKind} reads`, () =>
      Effect.gen(function* genericDenial() {
        const harness = yield* makeHarness();
        const exit = yield* run(harness, registration(candidates, { accessKind, mode: 'generic' })).pipe(Effect.exit);
        expect(Schema.is(ReadPermissionDenied)(failureTag(exit))).toBe(true);
        expect(harness.rows).toHaveLength(1);
        expect(harness.rows[0]).toContain('denied');
        expect(harness.stages).not.toContain('evidence_persisted');
      }),
    );
  }

  for (const gate of ['module', 'owner'] as const) {
    test.effect(`does not turn genuine ${gate} denial into an empty success`, () =>
      Effect.gen(function* genuineDenial() {
        const harness = yield* makeHarness(
          gate === 'module' ? { moduleDecision: 'denied' } : { ownerDecision: 'denied' },
        );
        const exit = yield* run(harness, registration(candidates)).pipe(Effect.exit);
        expect(Schema.is(ReadPermissionDenied)(failureTag(exit))).toBe(true);
        expect(harness.resourceChecks).toEqual([]);
        expect(harness.rows[0]).toContain('denied');
      }),
    );
  }

  test.effect('returns the full unchanged detail result when every generic result target is allowed', () =>
    Effect.gen(function* unchangedDetail() {
      const items = [hit('allowed-a'), hit('allowed-b')];
      const harness = yield* makeHarness();
      const read = registration(items, { accessKind: 'detail', mode: 'generic' });
      expect(read.descriptor.accessKind).toBe('detail');
      const result = yield* run(harness, read);
      expect(result).toEqual(response(items));
      expect(harness.rows).toHaveLength(1);
      // Core's existing evidence vocabulary stores both detail and report access as `read`.
      expect(harness.rows[0]).toContain('read');
      expect(harness.rows[0]).not.toContain('search');
      expect(harness.rows[0]).toContain(items.length);
    }),
  );

  for (const gate of ['module', 'owner'] as const) {
    test.effect(`does not turn ${gate} authorization unavailability into an empty success`, () =>
      Effect.gen(function* unavailableGate() {
        const harness = yield* makeHarness(
          gate === 'module' ? { moduleDecision: 'unavailable' } : { ownerDecision: 'unavailable' },
        );
        const exit = yield* run(harness, registration(candidates)).pipe(Effect.exit);
        expect(Schema.is(ReadPermissionUnavailable)(failureTag(exit))).toBe(true);
        expect(harness.resourceChecks).toEqual([]);
        expect(harness.rows).toEqual([]);
      }),
    );
  }

  test.effect('preserves a transient typed result-authorization failure instead of returning an empty collection', () =>
    Effect.gen(function* transientResultCheck() {
      const failure = new ReadPermissionUnavailable({
        code: 'read_permission_unavailable',
        reason: 'The authorization backend is temporarily unavailable',
      });
      const exit = yield* authorizeReadSearchCollection(adapter(), response(candidates), scope, () =>
        Effect.fail(failure),
      ).pipe(Effect.exit);
      expect(failureTag(exit)).toBe(failure);
    }),
  );

  test.effect('preserves unexpected authorization defects without releasing results or allowed evidence', () =>
    Effect.gen(function* authorizationDefect() {
      const harness = yield* makeHarness({ check: () => Effect.die('authorization transport failed') });
      const exit = yield* run(harness, registration(candidates)).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
      }
      expect(harness.rows).toEqual([]);
      expect(harness.stages).not.toContain('evidence_persisted');
    }),
  );

  test.effect('rejects invalid authentication before owner work and result authorization', () =>
    Effect.gen(function* invalidAuthentication() {
      const harness = yield* makeHarness();
      const exit = yield* harness.runtime
        .runRead({
          input: { query: 'query' },
          principal: { ...scope, authContextRef: '' },
          registration: registration(candidates),
          transport: { correlationId: scope.correlationId },
        })
        .pipe(Effect.exit);
      expect(Schema.is(ReadInputValidationError)(failureTag(exit))).toBe(true);
      expect(harness.stages).not.toContain('handler_executed');
      expect(harness.resourceChecks).toEqual([]);
      expect(harness.rows).toEqual([]);
    }),
  );

  for (const failure of [
    new OperationAuthenticationRequired({ code: 'operation_authentication_required', reason: 'Session expired' }),
    new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Authentication store unavailable',
    }),
  ]) {
    test.effect(`preserves scope authentication failure ${failure._tag} before result filtering`, () =>
      Effect.gen(function* authenticationFailure() {
        const harness = yield* makeHarness({ scopeFailure: failure });
        const exit = yield* run(harness, registration(candidates)).pipe(Effect.exit);
        expect(failureTag(exit)).toBe(failure);
        expect(harness.stages).not.toContain('handler_executed');
        expect(harness.resourceChecks).toEqual([]);
        expect(harness.rows).toEqual([]);
      }),
    );
  }

  test.effect('keeps semantic Policy denial and its declared status rather than filtering to empty', () =>
    Effect.gen(function* policyDenial() {
      const policy = defineGlobalPolicy<{ readonly query: string }>({
        evaluate: () => Effect.fail(denyPolicy('search_not_permitted_now', 'The search conflicts with current policy')),
        policyKey: `${moduleId}.semantic-policy.v1`,
      });
      const harness = yield* makeHarness();
      const exit = yield* run(harness, registration(candidates, { policy })).pipe(Effect.exit);
      const failure = failureTag(exit);
      expect(Schema.is(ReadPolicyDenied)(failure)).toBe(true);
      if (Schema.is(ReadPolicyDenied)(failure)) {
        expect(failure.httpStatus).toBe(422);
        expect(failure.policyReasonCode).toBe('search_not_permitted_now');
      }
      expect(harness.stages).not.toContain('handler_executed');
      expect(harness.resourceChecks).toEqual([]);
      expect(harness.rows).toHaveLength(1);
      expect(harness.rows[0]).toContain('denied');
      expect(harness.rows[0]).toContain('policy');
    }),
  );

  test.effect('keeps Policy evaluation defects fail-closed without rewriting generic Policy semantics', () =>
    Effect.gen(function* policyFailure() {
      const policy = defineGlobalPolicy<{ readonly query: string }>({
        evaluate: () => Effect.die('Policy dependency unavailable'),
        policyKey: `${moduleId}.unavailable-policy.v1`,
      });
      const harness = yield* makeHarness();
      const exit = yield* run(harness, registration(candidates, { policy })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
      }
      expect(harness.stages).not.toContain('handler_executed');
      expect(harness.resourceChecks).toEqual([]);
      expect(harness.rows).toEqual([]);
    }),
  );

  for (const tenantAllowed of [true, false]) {
    test.effect(
      `preserves the exact Core People ${tenantAllowed ? 'tenant' : 'company'} any_of alternative with collection filtering`,
      () =>
        Effect.gen(function* selectedPeopleAlternative() {
          const harness = yield* makeHarness({
            legalEntityDecision: tenantAllowed ? 'denied' : 'allowed',
            tenantDecision: tenantAllowed ? 'allowed' : 'denied',
            tenantResources: () => Effect.die('Selected-company People must use company resource authorization'),
          });
          const read = defineRead(
            {
              ...descriptor(),
              entrypoint: defineSystemModuleEntrypoint({
                access: 'read',
                authorization: { kind: 'context_permission', permission: 'module.access' },
                entrypointKey: 'core.identity.search.people',
                moduleKey: 'core.identity',
                role: 'search',
              }),
              owningModuleKey: 'core.identity',
              permissionTarget: 'tenant',
              readKey: 'core.identity.search.people',
              resultAuthorization: adapter(),
            },
            { load: () => Effect.succeed({ evidence: { resultCount: 3 }, result: response(candidates) }) },
            serviceFactory,
            () => ({
              kind: 'any_of',
              targets: [
                { kind: 'tenant', permission: 'read_people' },
                { kind: 'legal_entity', permission: 'read_people' },
              ],
            }),
          );
          expect(
            yield* harness.runtime.runRead({
              input: { query: 'query matching all fixture candidates' },
              principal: scope,
              registration: read,
              transport: { correlationId: scope.correlationId },
            }),
          ).toEqual(response([hit('allowed-a'), hit('allowed-b')]));
          expect(harness.resourceChecks).toHaveLength(1);
          expect(harness.resourceChecks[0]?.legalEntityId).toBe(scope.legalEntityId);
          expect(harness.resourceChecks[0]?.permission).toBe('read');
        }),
    );
  }

  test.effect('preserves the CRM/Finance owner-ledger mode without new resource grants', () =>
    Effect.gen(function* ownerLedgerParity() {
      const harness = yield* makeHarness({ check: () => Effect.die('Owner ledger must not check resource grants') });
      expect(yield* run(harness, registration(candidates, { mode: 'owner' }))).toEqual(response(candidates));
      expect(harness.resourceChecks).toEqual([]);
      expectAllowedEvidence(harness.rows, 3);
    }),
  );

  test.effect('drops pre-filter fingerprint and single-record evidence targets', () =>
    Effect.gen(function* finalMetadataOnly() {
      const harness = yield* makeHarness();
      expect(
        yield* run(
          harness,
          registration([hit('secret-denied')], {
            evidence: {
              resultCount: 1,
              targetResource: { resourceId: 'secret-denied', resourceType: `${moduleId}.record` },
            },
          }),
        ),
      ).toEqual(response([]));
      expectAllowedEvidence(harness.rows, 0);
    }),
  );

  test.effect('derives count and discards candidate fingerprints under hash-only capture', () =>
    Effect.gen(function* finalHashEvidence() {
      const harness = yield* makeHarness();
      expect(
        yield* run(
          harness,
          registration(candidates, {
            captureMode: 'hash_only',
            evidence: {
              resultCount: 999,
              resultFingerprintHash: 'b'.repeat(64),
              resultFingerprintSchema: 'candidate.v1',
            },
          }),
        ),
      ).toEqual(response([hit('allowed-a'), hit('allowed-b')]));
      expect(harness.rows).toHaveLength(1);
      expect(harness.rows[0]).toContain(2);
      expect(harness.rows[0]).not.toContain(999);
      expect(harness.rows[0]).not.toContain('b'.repeat(64));
      expect(harness.rows[0]).not.toContain('candidate.v1');
      expect(harness.rows[0]).toContain('hash_only');
    }),
  );

  for (const service of ['available', 'missing'] as const) {
    test.effect(`uses only exact tenant resource decisions when the service is ${service}`, () =>
      Effect.gen(function* tenantCollection() {
        const { legalEntityId: _company, ...tenantScope } = scope;
        const checks: Parameters<NonNullable<ContextAccessService['tenantResources']>>[0][] = [];
        const tenantResources: NonNullable<ContextAccessService['tenantResources']> = (input) => {
          checks.push(input);
          return Effect.succeed(decisionsFor(input.resources));
        };
        const harness = yield* makeHarness(
          service === 'missing' ? { scope: tenantScope } : { scope: tenantScope, tenantResources },
        );
        const read = defineRead(
          {
            ...descriptor(),
            entrypoint: defineTenantModuleEntrypoint({
              access: 'read',
              authorization: { kind: 'authenticated_principal' },
              entrypointKey: `${moduleId}.tenant-search`,
              moduleKey: moduleId,
              role: 'search',
            }),
            legalEntityScope: 'forbidden',
            permissionTarget: 'tenant',
            resultAuthorization: adapter(),
          },
          { load: () => Effect.succeed({ evidence: { resultCount: 3 }, result: response(candidates) }) },
          () => Effect.succeed({}),
          () => ({ kind: 'tenant', permission: 'read_people' }),
        );
        const exit = yield* run(harness, read).pipe(Effect.exit);
        if (service === 'missing') {
          expect(Schema.is(ReadPermissionUnavailable)(failureTag(exit))).toBe(true);
          expect(harness.rows).toEqual([]);
        } else {
          expect(exit).toEqual(Exit.succeed(response([hit('allowed-a'), hit('allowed-b')])));
          expect(checks).toEqual([
            {
              permission: 'read',
              principalId: scope.principalId,
              resources: candidates.map((item) => item.ref),
              tenantId: scope.tenantId,
            },
          ]);
        }
        expect(harness.resourceChecks).toEqual([]);
      }),
    );
  }

  for (const malformed of ['items-not-array', 'resource-null', 'resource-throws', 'rebuild-items-not-array'] as const) {
    test.effect(`rejects malformed owner resolver output: ${malformed}`, () =>
      Effect.gen(function* malformedResolver() {
        const authored = {
          items: (result: SearchResult) => result.items,
          resource: (item: Hit) => item.ref,
          resultSchema: ResultSchema,
          withItems: (_original: SearchResult, items: readonly Hit[]) => response(items),
        };
        if (malformed === 'items-not-array') {
          Reflect.set(authored, 'items', () => new Set(candidates));
        } else if (malformed === 'resource-null') {
          Reflect.set(authored, 'resource', () => null);
        } else if (malformed === 'resource-throws') {
          Reflect.set(authored, 'resource', () => Schema.decodeUnknownSync(HitSchema)({}));
        } else {
          Reflect.set(authored, 'withItems', () => ({ ...response([]), items: new Set() }));
        }
        const harness = yield* makeHarness();
        const exit = yield* run(
          harness,
          registration(candidates, { authorization: defineReadSearchCollectionAuthorization(authored) }),
        ).pipe(Effect.exit);
        expect(Schema.is(ReadHandlerExecutionError)(failureTag(exit))).toBe(true);
        expect(harness.rows).toEqual([]);
        expect(harness.stages).not.toContain('evidence_persisted');
      }),
    );
  }

  for (const defect of [
    'select',
    'rebuild',
    'restore-denied',
    'duplicate-target',
    'invalid-target',
    'schema',
  ] as const) {
    test.effect(`fails closed on adapter ${defect}`, () =>
      Effect.gen(function* adapterDefect() {
        const invalid = defineReadSearchCollectionAuthorization({
          items: (result: SearchResult) =>
            defect === 'select' ? Schema.decodeUnknownSync(Schema.Array(HitSchema))(null) : result.items,
          resource: (item: Hit) => (defect === 'invalid-target' ? { ...item.ref, resourceId: '' } : item.ref),
          resultSchema: ResultSchema,
          withItems: (original, items) => {
            if (defect === 'rebuild') {
              return Schema.decodeUnknownSync(ResultSchema)({});
            }
            if (defect === 'restore-denied') {
              return original;
            }
            const rebuilt = response(items);
            if (defect === 'schema') {
              Reflect.set(rebuilt, 'count', 'invalid');
            }
            return rebuilt;
          },
        });
        const harness = yield* makeHarness();
        const items = defect === 'duplicate-target' ? [hit('allowed-a'), hit('allowed-a')] : candidates;
        const exit = yield* run(harness, registration(items, { authorization: invalid })).pipe(Effect.exit);
        const errorSchema = defect === 'schema' ? ReadResultValidationError : ReadHandlerExecutionError;
        expect(Schema.is(errorSchema)(failureTag(exit))).toBe(true);
        expect(harness.rows).toEqual([]);
      }),
    );
  }
});
