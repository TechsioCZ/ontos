import { NodeCrypto } from '@effect/platform-node';
import { Context, DateTime, Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import type { ContextAccessDecision, ContextAccessService } from '../../src/permissions/context-access.ts';
import { ReadPermissionUnavailable, ReadHandlerUnavailable } from '../../src/reads/errors.ts';
import { getReadPermissionTargetResolver, getReadResultPermissionTargetResolver } from '../../src/reads/definition.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { CoreSearchQueryRuntime } from '../../src/search/query-runtime.ts';
import {
  CoreSearchProjectionHitSchema,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';
import { CoreSearchProjectionStore } from '../../src/search/projection-store.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { buildPeopleSearchDocuments } from '../../src/people/people-search-projection.ts';
import { PeopleSearchVisibility } from '../../src/people/people-search-visibility.ts';
import { peopleSearchRead } from '../../src/people/people-search.ts';
import {
  admitPeopleSystemSearch,
  peopleAdmissionDecisionOf,
  runPeopleSearch,
} from '../../src/people/system-search-provider.ts';
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
interface CandidatePerson {
  readonly displayName: string;
  readonly kind: string;
  readonly principalId: string;
}
const searchCurrentCandidates = Effect.fn(function* searchCurrentCandidates(
  candidates: readonly CandidatePerson[],
  deniedId: string,
  hiddenId: string,
  serviceId: string,
) {
  const harness = yield* makeReadTestHarness({
    executeOwnerQuery: (query) => {
      // Model only bound predicates; this scripted transport does not prove native SQL/RLS.
      const kinds = [...query.sql.matchAll(/"kind" = \$(?<position>\d+)/gu)].map(
        (match) => query.params[Number(match.groups?.['position']) - 1],
      );
      expect(kinds).toEqual(['human', 'agent']);
      return Effect.succeed(
        candidates
          .filter((person) => kinds.includes(person.kind) && query.params.includes(person.principalId))
          .map((person) => ({ display_name: person.displayName, principal_id: person.principalId })),
      );
    },
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    scope,
  });
  const hits = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(
    candidates.map((person) => ({
      ...hit,
      ref: { ...hit.ref, resourceId: personResourceId(companyId, person.principalId) },
    })),
  );
  const environment = yield* Layer.build(
    Layer.mergeAll(
      harness.layer,
      Layer.succeed(PeopleSearchVisibility, {
        visible: (observedTenant, ids) => {
          expect(observedTenant).toBe(tenantId);
          expect(ids).not.toContain(serviceId);
          return Effect.succeed(new Set(ids.filter((id) => id !== hiddenId)));
        },
      }),
      Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
    ),
  );
  const access = Context.get(environment, ContextAccess);
  const checked = Context.add(environment, ContextAccess, {
    ...access,
    resources: ({ resources }) =>
      Effect.succeed(
        resources.map((ref) => ({
          decision:
            ref.resourceId === personResourceId(companyId, deniedId) ? ('denied' as const) : ('allowed' as const),
          key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
        })),
      ),
  });
  const result = yield* runPeopleSearch(request).pipe(Effect.provideContext(checked));
  expect(harness.snapshot().ownerQueries).toHaveLength(candidates.length === 0 ? 0 : 1);
  return result;
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
  suite.effect(
    'rematches current names while new names still require projection discovery, without cached answers',
    () =>
      Effect.gen(function* currentNameEvidence() {
        const store = makeInMemoryCoreSearchProjectionStore();
        const projectionContext = attestOutboxWorkerHandlerContext({
          attemptNumber: 1,
          claimId: 'people-current-name-claim',
          compositionRevision: 'a'.repeat(64),
          consumerModuleKey: 'core.identity',
          correlationId: scope.correlationId,
          deliveryId: 'people-current-name-delivery',
          domainEventId: 'people-current-name-event',
          legalEntityScope: 'forbidden',
          messageId: 'people-current-name-message',
          producerModuleKey: 'core.identity',
          tenantId,
          tenantSequenceNo: 1n,
          topic: 'core.identity.principal-lifecycle-changed.v1',
          workerKey: 'core.identity.project-people-lifecycle-search',
        });
        const projectName = Effect.fn(function* projectName(displayName: string, version: string) {
          const documents = yield* buildPeopleSearchDocuments({
            people: [{ displayName, legalEntityId: companyId, principalId: target, tenantId }],
            projectionVersion: version,
            tenantId,
          });
          yield* store.replace(
            {
              documents,
              moduleId: 'core.identity',
              rebuildVersion: version,
              resourceType: 'core.identity.person',
              tenantId,
            },
            projectionContext,
          );
        });
        yield* projectName('Žofie Nováková', '1');
        let currentName = 'Božena Nováková';
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.succeed([{ display_name: currentName, principal_id: target }]),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const runtime = yield* createCoreSearchQueryRuntime.pipe(
          Effect.provideService(CoreSearchProjectionStore, store),
        );
        const environment = yield* Layer.build(
          Layer.mergeAll(harness.layer, visibility, Layer.succeed(CoreSearchQueryRuntime, runtime)),
        );
        let resourceDecision: 'allowed' | 'denied' | 'unavailable' = 'allowed';
        const access = Context.get(environment, ContextAccess);
        const checked = Context.add(environment, ContextAccess, {
          ...access,
          resources: ({ resources }) =>
            Effect.succeed(
              resources.map((ref) => ({
                decision: resourceDecision,
                key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
              })),
            ),
        });
        const search = (query: string) =>
          runPeopleSearch({ ...request, input: { query } }).pipe(Effect.provideContext(checked));
        for (const query of ['Žofie', 'Novakova Zofie']) {
          expect(yield* search(query)).toEqual([]);
        }
        // A current matching name cannot invent a candidate absent from the name-only projection.
        const beforeUndiscoveredQuery = harness.snapshot().ownerQueries.length;
        expect(yield* search('Božena')).toEqual([]);
        expect(harness.snapshot().ownerQueries).toHaveLength(beforeUndiscoveredQuery);
        const expected = [{ ref: hit.ref, selectedLegalEntityId: companyId, title: currentName }];
        expect(yield* search('Novakova')).toEqual(expected);
        yield* projectName(currentName, '2');
        for (const query of ['Božena Nováková', 'bozena novakova', 'Nováková Božena', 'novakova bozena']) {
          expect(yield* search(query)).toEqual(expected);
        }
        resourceDecision = 'denied';
        expect(yield* search('bozena novakova')).toEqual([]);
        resourceDecision = 'unavailable';
        expect(Schema.is(ReadHandlerUnavailable)(yield* search('bozena novakova').pipe(Effect.flip))).toBe(true);
        resourceDecision = 'allowed';
        const beforeRename = harness.snapshot().ownerQueries.length;
        currentName = 'Anežka Dvořáková';
        expect(yield* search('bozena novakova')).toEqual([]);
        expect(harness.snapshot().ownerQueries).toHaveLength(beforeRename + 1);
      }),
  );
  suite.effect('mixed People batches equal independent current-evidence checks without leaking service accounts', () =>
    Effect.gen(function* batchEquivalence() {
      const people = [
        { displayName: 'Božena Nováková', kind: 'human', principalId: target },
        { displayName: 'Žofie Nováková', kind: 'human', principalId: '30000000-0000-4000-8000-000000000003' },
        { displayName: 'Žofie Agentová', kind: 'agent', principalId: '30000000-0000-4000-8000-000000000004' },
        { displayName: 'Žofie Zamítnutá', kind: 'human', principalId: '30000000-0000-4000-8000-000000000005' },
        { displayName: 'Žofie Systémová', kind: 'agent', principalId: '30000000-0000-4000-8000-000000000006' },
        { displayName: 'Žofie Služba', kind: 'service', principalId: '30000000-0000-4000-8000-000000000007' },
        { displayName: 'Žofie Integrace', kind: 'integration', principalId: '30000000-0000-4000-8000-000000000008' },
        { displayName: 'Žofie Systém', kind: 'system', principalId: '30000000-0000-4000-8000-000000000009' },
      ];
      const deniedId = '30000000-0000-4000-8000-000000000005';
      const hiddenId = '30000000-0000-4000-8000-000000000006';
      const serviceId = '30000000-0000-4000-8000-000000000007';
      const searchCandidates = (candidates: readonly CandidatePerson[]) =>
        searchCurrentCandidates(candidates, deniedId, hiddenId, serviceId);
      const batched = yield* searchCandidates(people);
      const independent = yield* Effect.forEach(people, (person) => searchCandidates([person]), { concurrency: 1 });
      expect(batched).toEqual(
        independent
          .flat()
          .toSorted(
            (left, right) =>
              left.title.localeCompare(right.title) || left.ref.resourceId.localeCompare(right.ref.resourceId),
          ),
      );
      expect(batched).toEqual([
        {
          ref: { ...hit.ref, resourceId: personResourceId(companyId, '30000000-0000-4000-8000-000000000004') },
          selectedLegalEntityId: companyId,
          title: 'Žofie Agentová',
        },
        {
          ref: { ...hit.ref, resourceId: personResourceId(companyId, '30000000-0000-4000-8000-000000000003') },
          selectedLegalEntityId: companyId,
          title: 'Žofie Nováková',
        },
      ]);
      expect(yield* searchCandidates([])).toEqual([]);
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
  for (const displayName of ['Žofie Nováková', 'Božena Dvořáková']) {
    for (const outcome of ['denied', 'unavailable', 'hidden'] as const) {
      suite.effect(`${outcome} current result ${displayName} retains live visibility/resource decisions`, () =>
        Effect.gen(function* resultPermission() {
          const harness = yield* makeReadTestHarness({
            executeOwnerQuery: () => Effect.succeed([{ display_name: displayName, principal_id: target }]),
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
  }
});
interface AdmissionControls {
  readonly legalEntity: ContextAccessDecision;
  readonly malformedModules?: boolean;
  readonly module: ContextAccessDecision;
  readonly tenant: ContextAccessDecision;
}
/** Coarse admission only: no owner query, no data provider, no issuer may run. */
const runAdmission = (controls: AdmissionControls) =>
  Effect.gen(function* run() {
    const harness = yield* makeReadTestHarness({
      executeOwnerQuery: () => Effect.die('people inventory admission must not run an owner query'),
      operationTime,
      ownerAuthorizationDecision: 'allowed',
      permissionDecision: 'allowed',
      scope,
    });
    // Build the harness environment once and read its native service, so no library-level `Effect.provide` is needed.
    const environment = yield* Layer.build(harness.layer);
    const native = Context.get(environment, ContextAccess);
    const access: ContextAccessService = {
      ...native,
      legalEntities: ({ legalEntityIds }) =>
        Effect.succeed(legalEntityIds.map((key) => ({ decision: controls.legalEntity, key }))),
      modules: ({ moduleIds }) =>
        Effect.succeed(
          controls.malformedModules === true
            ? [{ decision: controls.module, key: 'wrong.module' }]
            : moduleIds.map((key) => ({ decision: controls.module, key })),
        ),
      tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: controls.tenant, key }))),
    };
    const decision = yield* admitPeopleSystemSearch(scope, access);
    expect(harness.snapshot().ownerQueries).toEqual([]);
    return decision;
  });

it.layer(NodeCrypto.layer)('people search inventory admission', (suite) => {
  suite.effect('requires both the module gate and an allowed directory alternative', () =>
    Effect.gen(function* allowedAdmission() {
      expect(yield* runAdmission({ legalEntity: 'denied', module: 'allowed', tenant: 'allowed' })).toBe('allowed');
      expect(yield* runAdmission({ legalEntity: 'allowed', module: 'allowed', tenant: 'denied' })).toBe('allowed');
      expect(yield* runAdmission({ legalEntity: 'allowed', module: 'allowed', tenant: 'allowed' })).toBe('allowed');
      // The directory alternative is an OR: one allowed target satisfies it even when the other is indeterminate.
      expect(yield* runAdmission({ legalEntity: 'allowed', module: 'allowed', tenant: 'unavailable' })).toBe('allowed');
      expect(yield* runAdmission({ legalEntity: 'unavailable', module: 'allowed', tenant: 'allowed' })).toBe('allowed');
    }),
  );

  suite.effect('denies only on a definite denial of the module gate or the whole directory alternative', () =>
    Effect.gen(function* deniedAdmission() {
      expect(yield* runAdmission({ legalEntity: 'allowed', module: 'denied', tenant: 'allowed' })).toBe('denied');
      expect(yield* runAdmission({ legalEntity: 'denied', module: 'allowed', tenant: 'denied' })).toBe('denied');
    }),
  );

  suite.effect('fails closed as unavailable on indeterminate or malformed decisions', () =>
    Effect.gen(function* indeterminateAdmission() {
      expect(yield* runAdmission({ legalEntity: 'unavailable', module: 'allowed', tenant: 'unavailable' })).toBe(
        'unavailable',
      );
      expect(yield* runAdmission({ legalEntity: 'allowed', module: 'unavailable', tenant: 'allowed' })).toBe(
        'unavailable',
      );
      expect(
        yield* runAdmission({ legalEntity: 'allowed', malformedModules: true, module: 'allowed', tenant: 'allowed' }),
      ).toBe('unavailable');
      // A definite module denial still wins over an indeterminate directory alternative.
      expect(yield* runAdmission({ legalEntity: 'unavailable', module: 'denied', tenant: 'unavailable' })).toBe(
        'denied',
      );
    }),
  );

  suite.effect(
    'the decision reader rejects any literal outside the closed vocabulary, a wrong key or a bad count',
    () =>
      Effect.sync(() => {
        const allowed = [{ decision: 'allowed', key: 'core.identity' }] as const;
        expect(peopleAdmissionDecisionOf(allowed, 'core.identity')).toBe('allowed');
        expect(peopleAdmissionDecisionOf([{ decision: 'granted', key: 'core.identity' }], 'core.identity')).toBe(
          'unavailable',
        );
        expect(peopleAdmissionDecisionOf([{ decision: '', key: 'core.identity' }], 'core.identity')).toBe(
          'unavailable',
        );
        expect(peopleAdmissionDecisionOf(allowed, 'other.module')).toBe('unavailable');
        expect(
          peopleAdmissionDecisionOf(
            [
              { decision: 'allowed', key: 'core.identity' },
              { decision: 'allowed', key: 'core.identity' },
            ],
            'core.identity',
          ),
        ).toBe('unavailable');
        expect(peopleAdmissionDecisionOf([], 'core.identity')).toBe('unavailable');
      }),
  );
});
