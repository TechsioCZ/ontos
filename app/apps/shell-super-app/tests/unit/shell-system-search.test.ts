import { requestPeopleSearchRebuild } from '../../api/people-search-rebuild.ts';
import { actionSuccess, actionCoreFailure, makeActionRuntimeDouble } from '../support/action-runtime-double.ts';
import { RequestPeopleSearchRebuildHttpHeadersSchema } from '../../shared/core-actions/request-people-search-rebuild.ts';
import { NodeCrypto } from '@effect/platform-node';
import { ActionRuntime, ActionPermissionDenied, ContextAccess, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { corePeopleSystemSearchProvider, PeopleSearchResponseSchema } from '@app/core-runtime/people/search';
import type { PeopleSearchResponse } from '@app/core-runtime/people/search';
import { interpretCoreSystemSearchPresentation } from '@app/core-runtime/search-contract';
import { Context, DateTime, Effect, Fiber, Layer, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { authorizePeopleSearchResults, mergeShellSystemSearch } from '../../api/modules/shell-system-search.ts';
import { ShellProviderUnavailableError } from '../../api/modules/shell-resources.ts';
import {
  SHELL_SEARCH_REQUEST_BUDGET_MILLIS,
  withShellSearchRequestBudget,
} from '../../api/modules/shell-governed-search.ts';
import {
  ShellAuthenticationApi,
  ShellSearchPresentationInventorySchema,
  ShellSearchResponseSchema,
} from '../../shared/api.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:system-search',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'system-search-test',
};
const person = {
  ref: {
    moduleId: 'core.identity',
    resourceId: `${legalEntityId}.${principalId}`,
    resourceType: 'core.identity.person',
    tenantId,
  },
  selectedLegalEntityId: legalEntityId,
  title: 'Žofie Nováková',
} satisfies PeopleSearchResponse[number];
const unexpectedCoreFields = { extra: 'untrusted' };
const coreResponse = Schema.decodeUnknownSync(ShellSearchResponseSchema)({
  partial: false,
  results: [{ ...person, kind: 'resource' }],
});
const businessResponse = Schema.decodeUnknownSync(ShellSearchResponseSchema)({
  partial: false,
  results: [
    {
      kind: 'resource',
      ref: { moduleId: 'example.owner', resourceId: 'record-1', resourceType: 'example.owner.record', tenantId },
      selectedLegalEntityId: legalEntityId,
      title: 'Alena',
    },
  ],
});

it.effect('merges and deduplicates Core/business hits with stable ordering', () =>
  Effect.gen(function* merge() {
    const result = yield* mergeShellSystemSearch(
      Effect.succeed({ ...businessResponse, results: [...businessResponse.results, ...coreResponse.results] }),
      Effect.succeed(coreResponse),
    );
    expect(result.partial).toBe(false);
    expect(result.results.map(({ title }) => title)).toEqual(['Alena', 'Žofie Nováková']);
  }),
);
it.effect('preserves approved relevance across business and People instead of alphabetizing the merge', () =>
  Effect.gen(function* commonRelevance() {
    const business = Schema.decodeUnknownSync(ShellSearchResponseSchema)({
      partial: false,
      results: businessResponse.results.map((row) => ({ ...row, relevance: { score: 100, version: '1' } })),
    });
    const people = Schema.decodeUnknownSync(ShellSearchResponseSchema)({
      partial: false,
      results: coreResponse.results.map((row) => ({ ...row, relevance: { score: 900, version: '1' } })),
    });
    const result = yield* mergeShellSystemSearch(Effect.succeed(business), Effect.succeed(people));
    expect(result.results.map(({ title }) => title)).toEqual(['Žofie Nováková', 'Alena']);
    expect(result.results.map(({ relevance }) => relevance)).toEqual([
      { score: 900, version: '1' },
      { score: 100, version: '1' },
    ]);
    const reversed = yield* mergeShellSystemSearch(Effect.succeed(people), Effect.succeed(business));
    expect(reversed.results).toEqual(result.results);
  }),
);

it.effect('breaks equal relevance by normalized title and complete ref without boosting optional display fields', () =>
  Effect.gen(function* deterministicTies() {
    const business = Schema.decodeUnknownSync(ShellSearchResponseSchema)({
      partial: false,
      results: businessResponse.results.map((row) => ({
        ...row,
        subtitle: 'An exact-looking identifier never grants relevance',
        title: 'Žofie',
      })),
    });
    const people = Schema.decodeUnknownSync(ShellSearchResponseSchema)({
      partial: false,
      results: coreResponse.results.flatMap((row) => [
        { ...row, title: 'zofie' },
        { ...row, ref: { ...row.ref, resourceId: 'another-person' }, title: 'ZOFIE' },
      ]),
    });
    const result = yield* mergeShellSystemSearch(Effect.succeed(business), Effect.succeed(people));
    expect(result.results.map(({ ref }) => `${ref.moduleId}:${ref.resourceId}`)).toEqual([
      `core.identity:${person.ref.resourceId}`,
      'core.identity:another-person',
      'example.owner:record-1',
    ]);
    expect(result.results.every((row) => row.relevance === undefined)).toBe(true);
    expect(
      (yield* mergeShellSystemSearch(
        Effect.succeed({ ...people, results: people.results.toReversed() }),
        Effect.succeed(business),
      )).results,
    ).toEqual(result.results);
  }),
);

for (const stalledBranch of ['business', 'People'] as const) {
  it.effect(`a stalled ${stalledBranch} merge branch expires as unavailable, never complete or partial empty`, () =>
    Effect.gen(function* boundedMerge() {
      const pending = yield* mergeShellSystemSearch(
        stalledBranch === 'business' ? Effect.never : Effect.succeed(businessResponse),
        stalledBranch === 'People' ? Effect.never : Effect.succeed(coreResponse),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(SHELL_SEARCH_REQUEST_BUDGET_MILLIS);
      expect(Schema.is(ShellProviderUnavailableError)(yield* Fiber.join(pending))).toBe(true);
    }),
  );
}

it.effect('a governed business-then-People merge spends one deadline, not a new budget for the system branch', () =>
  Effect.gen(function* sequentialMergeDeadline() {
    const stageMillis = SHELL_SEARCH_REQUEST_BUDGET_MILLIS * 0.6;
    const pending = yield* withShellSearchRequestBudget(
      Effect.sleep(stageMillis).pipe(
        Effect.as(businessResponse),
        Effect.flatMap((business) =>
          mergeShellSystemSearch(Effect.succeed(business), Effect.sleep(stageMillis).pipe(Effect.as(coreResponse))),
        ),
      ),
      () => new ShellProviderUnavailableError({}),
    ).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(SHELL_SEARCH_REQUEST_BUDGET_MILLIS);
    expect(Schema.is(ShellProviderUnavailableError)(yield* Fiber.join(pending))).toBe(true);
  }),
);

it.effect('preserves the captured Core-native catalog once across the real merge and keeps the full person ID', () =>
  Effect.gen(function* capturedSystemTarget() {
    const presentation = Schema.decodeUnknownSync(ShellSearchPresentationInventorySchema)({
      business: { compositionRevision: 'a'.repeat(64), entries: [], schemaVersion: '1' },
      pages: [],
      system: corePeopleSystemSearchProvider.presentation,
    });
    const result = yield* mergeShellSystemSearch(
      Effect.succeed({ ...businessResponse, presentation }),
      Effect.succeed(coreResponse),
      presentation,
    );
    expect(result.presentation).toEqual(presentation);
    expect(result.presentation?.system).not.toHaveProperty('pageKey');
    const target = interpretCoreSystemSearchPresentation(corePeopleSystemSearchProvider.presentation, {
      recordId: person.ref.resourceId,
    });
    expect(Result.isSuccess(target)).toBe(true);
    if (Result.isFailure(target)) {
      throw new Error(target.failure.message);
    }
    expect(target.success.navigationPath).toBe(corePeopleSystemSearchProvider.navigationPath);
    expect(target.success.queryParameters).toEqual([
      { name: corePeopleSystemSearchProvider.presentation.queryParameterName, value: person.ref.resourceId },
    ]);
  }),
);

it.effect('refuses a catalog from another captured revision during merge', () =>
  Effect.gen(function* crossRevisionCatalog() {
    const business = Schema.decodeUnknownSync(ShellSearchPresentationInventorySchema)({
      business: { compositionRevision: 'a'.repeat(64), entries: [], schemaVersion: '1' },
      pages: [],
    });
    const system = Schema.decodeUnknownSync(ShellSearchPresentationInventorySchema)({
      business: { compositionRevision: 'b'.repeat(64), entries: [], schemaVersion: '1' },
      pages: [],
      system: corePeopleSystemSearchProvider.presentation,
    });
    const failure = yield* mergeShellSystemSearch(
      Effect.succeed({ ...businessResponse, presentation: business }),
      Effect.succeed(coreResponse),
      system,
    ).pipe(Effect.flip);
    expect(Schema.is(ShellProviderUnavailableError)(failure)).toBe(true);
  }),
);

for (const coreFails of [true, false]) {
  it.effect(
    `one ${coreFails ? 'Core' : 'business'} provider failure never exposes the other hits as an incomplete success`,
    () =>
      Effect.gen(function* partial() {
        const failure = Effect.fail(new ShellProviderUnavailableError({}));
        const failureResult = yield* mergeShellSystemSearch(
          coreFails ? Effect.succeed(businessResponse) : failure,
          coreFails ? failure : Effect.succeed(coreResponse),
        ).pipe(Effect.flip);
        expect(Schema.is(ShellProviderUnavailableError)(failureResult)).toBe(true);
      }),
  );
}
it.effect('rejects an upstream partial response instead of presenting incomplete hits', () =>
  Effect.gen(function* incompleteUpstream() {
    const failure = yield* mergeShellSystemSearch(
      Effect.succeed({ ...businessResponse, partial: true }),
      Effect.succeed(coreResponse),
    ).pipe(Effect.flip);
    expect(Schema.is(ShellProviderUnavailableError)(failure)).toBe(true);
  }),
);
it.effect('all providers unavailable remains a typed failure, while denied Core permission is empty success', () =>
  Effect.gen(function* totalFailure() {
    const failure = Effect.fail(new ShellProviderUnavailableError({}));
    expect(
      Schema.is(ShellProviderUnavailableError)(yield* mergeShellSystemSearch(failure, failure).pipe(Effect.flip)),
    ).toBe(true);
    expect(
      (yield* mergeShellSystemSearch(Effect.succeed(businessResponse), Effect.succeed({ partial: false, results: [] })))
        .partial,
    ).toBe(false);
  }),
);
it.layer(NodeCrypto.layer)('Core system row authorization', (suite) => {
  for (const decision of ['allowed', 'denied', 'unavailable'] as const) {
    suite.effect(`Shell independently applies ${decision} per-person resource permission`, () =>
      Effect.gen(function* rowPermission() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('Shell system validation must never query owner SQL'),
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-02T12:00:00.000Z')),
          permissionDecision: decision,
          scope,
        });
        const environment = yield* Layer.build(harness.layer);
        const result = authorizePeopleSearchResults(scope, [person]).pipe(Effect.provideContext(environment));
        if (decision === 'unavailable') {
          expect(Schema.is(ShellProviderUnavailableError)(yield* result.pipe(Effect.flip))).toBe(true);
        } else {
          expect(yield* result).toHaveLength(decision === 'allowed' ? 1 : 0);
        }
      }),
    );
  }
  suite.effect('discards wrong tenant and company even when graph permits both, and rejects foreign types', () =>
    Effect.gen(function* trustedContext() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('No owner SQL'),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-02T12:00:00.000Z')),
        permissionDecision: 'allowed',
        scope,
      });
      const environment = yield* Layer.build(harness.layer);
      const bad = [
        { ...person, selectedLegalEntityId: '20000000-0000-4000-8000-000000000002' },
        { ...person, ref: { ...person.ref, tenantId: '10000000-0000-4000-8000-000000000002' } },
        { ...person, ref: { ...person.ref, resourceId: `20000000-0000-4000-8000-000000000002.${principalId}` } },
      ];
      expect(yield* authorizePeopleSearchResults(scope, bad).pipe(Effect.provideContext(environment))).toEqual([]);
      const failure = yield* Schema.decodeUnknownEffect(PeopleSearchResponseSchema)([
        { ...person, ref: { ...person.ref, resourceType: 'core.identity.other' } },
      ]).pipe(
        Effect.flatMap((values) => authorizePeopleSearchResults(scope, values)),
        Effect.provideContext(environment),
        Effect.flip,
      );
      expect(Schema.isSchemaError(failure)).toBe(true);
    }),
  );
  for (const values of [
    [{ ...person, title: '' }],
    [{ ...person, selectedLegalEntityId: 'not-a-uuid' }],
    [{ ...person, ref: { ...person.ref, resourceId: principalId } }],
    [{ ...person, ref: { ...person.ref, ...unexpectedCoreFields } }],
    [{ ...person, ...unexpectedCoreFields }],
  ] satisfies readonly PeopleSearchResponse[]) {
    suite.effect(`rejects malformed Core rows before checking resource permissions: ${JSON.stringify(values)}`, () =>
      Effect.gen(function* malformedCoreRows() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('No owner SQL'),
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-02T12:00:00.000Z')),
          permissionDecision: 'allowed',
          scope,
        });
        const environment = yield* Layer.build(harness.layer);
        const failure = yield* authorizePeopleSearchResults(scope, values).pipe(
          Effect.provideService(ContextAccess, {
            ...Context.get(environment, ContextAccess),
            resources: () => Effect.die('Malformed Core rows must fail before permission checks'),
          }),
          Effect.flip,
        );
        expect(Schema.is(ShellProviderUnavailableError)(failure)).toBe(true);
      }),
    );
  }
});

it('publishes the rebuild only on its tenant-session Action endpoint with an idempotency header', () => {
  expect(ShellAuthenticationApi.groups.peopleAdministration.endpoints.requestPeopleSearchRebuild.path).toBe(
    '/core.identity/actions/request-people-search-rebuild',
  );
  expect(() => Schema.decodeUnknownSync(RequestPeopleSearchRebuildHttpHeadersSchema)({})).toThrow();
});
it.effect(
  'rebuild adapter passes the original tenant principal/payload through ActionRuntime and preserves denial',
  () =>
    Effect.gen(function* governedRebuild() {
      const { legalEntityId: _company, ...tenantPrincipal } = scope;
      const context = {
        principal: tenantPrincipal,
        transport: { correlationId: 'rebuild-transport', idempotencyKey: 'rebuild-once' },
      };
      const payload = { reason: 'Repair projection' };
      const success = makeActionRuntimeDouble([actionSuccess({ status: 'requested' })]);
      expect(
        yield* requestPeopleSearchRebuild(context, payload).pipe(Effect.provideService(ActionRuntime, success.runtime)),
      ).toEqual({ status: 'requested' });
      expect(success.principals).toEqual([tenantPrincipal]);
      expect(success.payloads).toEqual([payload]);
      const denied = makeActionRuntimeDouble([
        actionCoreFailure(new ActionPermissionDenied({ code: 'action_permission_denied', reason: 'Denied' })),
      ]);
      expect(
        Schema.is(ActionPermissionDenied)(
          yield* requestPeopleSearchRebuild(context, payload).pipe(
            Effect.provideService(ActionRuntime, denied.runtime),
            Effect.flip,
          ),
        ),
      ).toBe(true);
    }),
);
