import { NodeCrypto } from '@effect/platform-node';
import { Context, DateTime, Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import { ReadPermissionUnavailable, ReadHandlerUnavailable } from '../../src/reads/errors.ts';
import { getReadPermissionTargetResolver, getReadResultPermissionTargetResolver } from '../../src/reads/definition.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { CoreSearchQueryRuntime } from '../../src/search/query-runtime.ts';
import { CoreSearchProjectionHitSchema } from '../../src/search/projection.ts';
import { PeopleSearchVisibility } from '../../src/people/people-search-visibility.ts';
import { peopleSearchRead } from '../../src/people/people-search.ts';
import { runPeopleSearch } from '../../src/people/system-search-provider.ts';
import { PersonRefSchema } from '../../src/resources/person.ts';
import { personResourceId } from '../../src/people/person-identity.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const companyId = '20000000-0000-4000-8000-000000000001';
const target = '30000000-0000-4000-8000-000000000002';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:people-test',
    authMethod: 'session',
    legalEntityId: companyId,
    principalId: '30000000-0000-4000-8000-000000000001',
    tenantId,
  }),
  correlationId: 'people-search-test',
};
const hit = Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
  archived: false,
  facets: [],
  metadata: [],
  ref: {
    moduleId: 'core.identity',
    resourceId: personResourceId(companyId, target),
    resourceType: 'core.identity.person',
    tenantId,
  },
  selectedLegalEntityId: companyId,
  title: 'Žofie Nováková',
});
const expectedRef = Schema.decodeUnknownSync(PersonRefSchema)(hit.ref);
const visibility = Layer.succeed(PeopleSearchVisibility, { visible: (_tenantId, ids) => Effect.succeed(new Set(ids)) });
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-02T12:00:00.000Z'));
const request = { input: { query: 'Žofie' }, principal: scope, transport: { correlationId: scope.correlationId } };
it('retains the exact directory permission alternative and required selected-company scope plus row gate', () => {
  expect(peopleSearchRead.descriptor.entrypoint.scope).toBe('system');
  expect(peopleSearchRead.descriptor.legalEntityScope).toBe('required');
  const resolver = getReadPermissionTargetResolver(peopleSearchRead);
  expect(Predicate.isFunction(resolver)).toBe(true);
  if (Predicate.isFunction(resolver)) {
    expect(resolver({ query: 'Žofie' }, scope)).toEqual({
      kind: 'any_of',
      targets: [
        { kind: 'tenant', permission: 'read_people' },
        { kind: 'legal_entity', permission: 'read_people' },
      ],
    });
  }
  expect(
    getReadResultPermissionTargetResolver(peopleSearchRead)?.(
      [{ ref: expectedRef, selectedLegalEntityId: companyId, title: hit.title }],
      scope,
    ),
  ).toEqual([hit.ref]);
});
it.layer(NodeCrypto.layer)('people search governed read', (suite) => {
  suite.effect(
    'uses the Core index in trusted scope then validates exact live membership before returning safe rows',
    () =>
      Effect.gen(function* readPeople() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            expect(query.scope).toEqual({ legalEntityId: companyId, tenantId });
            expect(query.sql).toContain('"core"."principal_company_memberships"');
            expect(query.sql).not.toMatch(/ilike|tsquery|similarity/iu);
            expect(query.params).toContain(companyId);
            expect(query.params).toContain(tenantId);
            expect(query.params).toContain(target);
            return Effect.succeed([{ display_name: 'Žofie Nováková', principal_id: target }]);
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const environment = yield* Layer.build(
          Layer.mergeAll(
            harness.layer,
            visibility,
            Layer.succeed(CoreSearchQueryRuntime, {
              search: (input, observed) => {
                expect(input).toMatchObject({ selectedLegalEntityId: companyId, tenantId });
                expect(observed).toEqual(scope);
                return Effect.succeed([hit]);
              },
            }),
          ),
        );
        const result = yield* runPeopleSearch(request).pipe(Effect.provideContext(environment));
        expect(result).toEqual([{ ref: hit.ref, selectedLegalEntityId: companyId, title: 'Žofie Nováková' }]);
        expect(harness.snapshot().evidenceWrites).toBe(1);
      }),
  );
  for (const decision of ['denied', 'unavailable'] as const) {
    suite.effect(`${decision} people permission never queries the index or owner SQL`, () =>
      Effect.gen(function* deniedPeople() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('Unauthorized SQL'),
          legalEntityPermissionDecisions: { read_people: decision },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
          tenantPermissionDecisions: { read_people: decision },
        });
        const environment = yield* Layer.build(
          Layer.mergeAll(
            harness.layer,
            visibility,
            Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.die('Unauthorized projection query') }),
          ),
        );
        const effect = runPeopleSearch(request).pipe(Effect.provideContext(environment));
        if (decision === 'denied') {
          expect(yield* effect).toEqual([]);
        } else {
          expect(Schema.is(ReadPermissionUnavailable)(yield* effect.pipe(Effect.flip))).toBe(true);
        }
        expect(harness.snapshot().ownerQueries).toEqual([]);
      }),
    );
  }
  suite.effect('drops cross-company, wrong-tenant, and wrong-owner hits before owner SQL', () =>
    Effect.gen(function* forgedCandidates() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Foreign candidate reached SQL'),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const bad = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
        { ...hit, selectedLegalEntityId: '20000000-0000-4000-8000-000000000002' },
        { ...hit, ref: { ...hit.ref, tenantId: '10000000-0000-4000-8000-000000000002' } },
      ]);
      const environment = yield* Layer.build(
        Layer.mergeAll(
          harness.layer,
          visibility,
          Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed(bad) }),
        ),
      );
      const result = yield* runPeopleSearch(request).pipe(Effect.provideContext(environment));
      expect(result).toEqual([]);
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );
  suite.effect('a stale deleted/departed membership is not returned even while its document remains indexed', () =>
    Effect.gen(function* removedMember() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const environment = yield* Layer.build(
        Layer.mergeAll(
          harness.layer,
          visibility,
          Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) }),
        ),
      );
      const result = yield* runPeopleSearch(request).pipe(Effect.provideContext(environment));
      expect(result).toEqual([]);
    }),
  );
  for (const tenantAllowed of [true, false]) {
    suite.effect(
      `directory permission alternative ${tenantAllowed ? 'tenant' : 'company'} works without the other grant`,
      () =>
        Effect.gen(function* permissionAlternative() {
          const harness = yield* makeReadTestHarness({
            executeOwnerQuery: () => Effect.succeed([{ display_name: 'Žofie Nováková', principal_id: target }]),
            legalEntityPermissionDecisions: { read_people: tenantAllowed ? 'denied' : 'allowed' },
            operationTime,
            ownerAuthorizationDecision: 'allowed',
            permissionDecision: 'allowed',
            scope,
            tenantPermissionDecisions: { read_people: tenantAllowed ? 'allowed' : 'denied' },
          });
          const environment = yield* Layer.build(
            Layer.mergeAll(
              harness.layer,
              visibility,
              Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) }),
            ),
          );
          const result = yield* runPeopleSearch(request).pipe(Effect.provideContext(environment));
          expect(result).toHaveLength(1);
        }),
    );
  }
  for (const outcome of ['denied', 'unavailable', 'hidden'] as const) {
    suite.effect(`${outcome} result is never returned after live visibility/resource checking`, () =>
      Effect.gen(function* resultPermission() {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.succeed([{ display_name: 'Žofie Nováková', principal_id: target }]),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const environment = yield* Layer.build(
          Layer.mergeAll(
            harness.layer,
            visibility,
            Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) }),
          ),
        );
        const access = Context.get(environment, ContextAccess);
        const scoped = Context.add(
          Context.add(environment, ContextAccess, {
            ...access,
            resources: ({ resources }) =>
              Effect.succeed(
                resources.map((ref) => ({
                  decision: outcome === 'hidden' ? ('allowed' as const) : outcome,
                  key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
                })),
              ),
          }),
          PeopleSearchVisibility,
          { visible: (_tenantId, ids) => Effect.succeed(new Set(outcome === 'hidden' ? [] : ids)) },
        );
        const effect = runPeopleSearch(request).pipe(Effect.provideContext(scoped));
        if (outcome === 'unavailable') {
          expect(Schema.is(ReadHandlerUnavailable)(yield* effect.pipe(Effect.flip))).toBe(true);
        } else {
          expect(yield* effect).toEqual([]);
        }
      }),
    );
  }
});
