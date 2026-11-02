import { requestPeopleSearchRebuild } from '../../api/people-search-rebuild.ts';
import { actionSuccess, actionCoreFailure, makeActionRuntimeDouble } from '../support/action-runtime-double.ts';
import { RequestPeopleSearchRebuildHttpHeadersSchema } from '../../shared/core-actions/request-people-search-rebuild.ts';
import { NodeCrypto } from '@effect/platform-node';
import { ActionRuntime, ActionPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { authorizePeopleSearchResults, mergeShellSystemSearch } from '../../api/modules/shell-system-search.ts';
import { ShellProviderUnavailableError } from '../../api/modules/shell-resources.ts';
import { ShellAuthenticationApi, ShellSearchResponseSchema } from '../../shared/api.ts';

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
};
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
for (const coreFails of [true, false]) {
  it.effect(`one ${coreFails ? 'Core' : 'business'} provider failure preserves the other hits as partial`, () =>
    Effect.gen(function* partial() {
      const failure = Effect.fail(new ShellProviderUnavailableError({}));
      const result = yield* mergeShellSystemSearch(
        coreFails ? Effect.succeed(businessResponse) : failure,
        coreFails ? failure : Effect.succeed(coreResponse),
      );
      expect(result.partial).toBe(true);
      expect(result.results).toHaveLength(1);
    }),
  );
}
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
      const failure = yield* authorizePeopleSearchResults(scope, [
        { ...person, ref: { ...person.ref, resourceType: 'core.identity.other' } },
      ]).pipe(Effect.provideContext(environment), Effect.flip);
      expect(Schema.is(ShellProviderUnavailableError)(failure)).toBe(true);
    }),
  );
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
