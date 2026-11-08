import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { NodeCrypto } from '@effect/platform-node';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import type { TestAccessOutcome } from '../../src/testing/access-gate.ts';
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
import { peopleSearchRead } from '../../src/people/people-search.ts';
import { admitPeopleSystemSearch, runPeopleSearch } from '../../src/people/system-search-provider.ts';
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
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-02T12:00:00.000Z'));
const request = { input: { query: 'Žofie' }, principal: scope, transport: { correlationId: scope.correlationId } };
it('declares canonical company-scoped People search without legacy permission resolvers', () => {
  const { descriptor } = peopleSearchRead;
  expect(descriptor.entrypoint.scope).toBe('system');
  expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(descriptor.legalEntityScope).toBe('required');
  expect(descriptor.accessKind).toBe('search');
  expect(descriptor.accessDeclaration).toMatchObject({
    key: 'core.identity.people-search.query',
    kind: 'read',
    modes: ['run'],
    risk: 'sensitive',
    selectors: [],
  });
  expect(getReadPermissionTargetResolver(peopleSearchRead)).toBeUndefined();
  expect(getReadResultPermissionTargetResolver(peopleSearchRead)).toBeUndefined();
});
interface CandidatePerson {
  readonly displayName: string;
  readonly kind: string;
  readonly principalId: string;
}
const searchCurrentCandidates = Effect.fn(function* searchCurrentCandidates(
  candidates: readonly CandidatePerson[],
  deniedId: string,
) {
  const harness = yield* makeReadTestHarness({
    access: 'allowed',
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
    scope,
  });
  const hits = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(
    candidates.map((person) => ({
      ...hit,
      ref: { ...hit.ref, resourceId: personResourceId(companyId, person.principalId) },
    })),
  );
  const environment = yield* Layer.build(
    Layer.mergeAll(harness.layer, Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) })),
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
          access: 'allowed',
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
          scope,
        });
        const environment = yield* Layer.build(
          Layer.mergeAll(
            harness.layer,
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
          access: 'allowed',
          executeOwnerQuery: () => Effect.succeed([{ display_name: currentName, principal_id: target }]),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          scope,
        });
        const runtime = yield* createCoreSearchQueryRuntime.pipe(
          Effect.provideService(CoreSearchProjectionStore, store),
        );
        const environment = yield* Layer.build(
          Layer.mergeAll(harness.layer, Layer.succeed(CoreSearchQueryRuntime, runtime)),
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
  suite.effect('mixed People batches equal independent current-evidence checks over people kinds only', () =>
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
      // Service, integration and system principals are excluded by their principal kind in the owner query,
      // never by a role key: the retired warm-up role heuristic is gone, so a human or agent row is decided
      // only by the live resource decision below.
      const searchCandidates = (candidates: readonly CandidatePerson[]) =>
        searchCurrentCandidates(candidates, deniedId);
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
        {
          ref: { ...hit.ref, resourceId: personResourceId(companyId, '30000000-0000-4000-8000-000000000006') },
          selectedLegalEntityId: companyId,
          title: 'Žofie Systémová',
        },
      ]);
      expect(yield* searchCandidates([])).toEqual([]);
    }),
  );
  for (const decision of ['denied', 'unavailable'] as const) {
    suite.effect(`${decision} people permission never queries the index or owner SQL`, () =>
      Effect.gen(function* deniedPeople() {
        const harness = yield* makeReadTestHarness({
          access: decision,
          executeOwnerQuery: () => Effect.die('Unauthorized SQL'),
          legalEntityPermissionDecisions: { read_people: 'allowed' },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
          tenantPermissionDecisions: { read_people: 'allowed' },
        });
        const environment = yield* Layer.build(
          Layer.mergeAll(
            harness.layer,
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
  suite.effect('canonical People permission does not require retired tenant or company grants', () =>
    Effect.gen(function* canonicalWithoutLegacyGrants() {
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: () => Effect.succeed([{ display_name: 'Žofie Nováková', principal_id: target }]),
        legalEntityPermissionDecisions: { read_people: 'denied' },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'denied',
        scope,
        tenantPermissionDecisions: { read_people: 'denied' },
      });
      const environment = yield* Layer.build(
        Layer.mergeAll(harness.layer, Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) })),
      );
      expect(yield* runPeopleSearch(request).pipe(Effect.provideContext(environment))).toEqual([
        { ref: hit.ref, selectedLegalEntityId: companyId, title: 'Žofie Nováková' },
      ]);
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );
  suite.effect('drops cross-company, wrong-tenant, and wrong-owner hits before owner SQL', () =>
    Effect.gen(function* forgedCandidates() {
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: () => Effect.die('Foreign candidate reached SQL'),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        scope,
      });
      const bad = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
        { ...hit, selectedLegalEntityId: '20000000-0000-4000-8000-000000000002' },
        { ...hit, ref: { ...hit.ref, tenantId: '10000000-0000-4000-8000-000000000002' } },
      ]);
      const environment = yield* Layer.build(
        Layer.mergeAll(harness.layer, Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed(bad) })),
      );
      const result = yield* runPeopleSearch(request).pipe(Effect.provideContext(environment));
      expect(result).toEqual([]);
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );
  suite.effect('a stale deleted/departed membership is not returned even while its document remains indexed', () =>
    Effect.gen(function* removedMember() {
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        scope,
      });
      const environment = yield* Layer.build(
        Layer.mergeAll(harness.layer, Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) })),
      );
      const result = yield* runPeopleSearch(request).pipe(Effect.provideContext(environment));
      expect(result).toEqual([]);
    }),
  );
  for (const legacyGranted of ['tenant', 'company'] as const) {
    suite.effect(`a legacy ${legacyGranted} grant cannot override canonical People denial`, () =>
      Effect.gen(function* permissionAlternative() {
        const harness = yield* makeReadTestHarness({
          access: 'denied',
          executeOwnerQuery: () => Effect.die('A legacy grant must not admit owner SQL'),
          legalEntityPermissionDecisions: { read_people: legacyGranted === 'company' ? 'allowed' : 'denied' },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          scope,
          tenantPermissionDecisions: { read_people: legacyGranted === 'tenant' ? 'allowed' : 'denied' },
        });
        const environment = yield* Layer.build(
          Layer.mergeAll(
            harness.layer,
            Layer.succeed(CoreSearchQueryRuntime, {
              search: () => Effect.die('A legacy grant must not query the index'),
            }),
          ),
        );
        const result = yield* runPeopleSearch(request).pipe(Effect.provideContext(environment));
        expect(result).toEqual([]);
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().evidenceWrites).toBe(1);
      }),
    );
  }
  for (const displayName of ['Žofie Nováková', 'Božena Dvořáková']) {
    for (const outcome of ['denied', 'unavailable'] as const) {
      suite.effect(`${outcome} current result ${displayName} retains the live resource decision`, () =>
        Effect.gen(function* resultPermission() {
          const harness = yield* makeReadTestHarness({
            access: 'allowed',
            executeOwnerQuery: () => Effect.succeed([{ display_name: displayName, principal_id: target }]),
            operationTime,
            ownerAuthorizationDecision: 'allowed',
            scope,
          });
          const environment = yield* Layer.build(
            Layer.mergeAll(
              harness.layer,
              Layer.succeed(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) }),
            ),
          );
          const access = Context.get(environment, ContextAccess);
          const scoped = Context.add(environment, ContextAccess, {
            ...access,
            resources: ({ resources }) =>
              Effect.succeed(
                resources.map((ref) => ({
                  decision: outcome,
                  key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
                })),
              ),
          });
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
type DecisionPropertyValue = AccessDecision[keyof AccessDecision] | 'granted';
const malformedDecisionOutcome = (decision: AccessDecision, key: PropertyKey): DecisionPropertyValue =>
  new Map<PropertyKey, DecisionPropertyValue>([
    ['admissionDeadline', decision.admissionDeadline],
    ['evidence', decision.evidence],
    ['outcome', 'granted'],
    ['reasons', decision.reasons],
    ['selectors', decision.selectors],
    ['structuralEvidence', decision.structuralEvidence],
  ]).get(key);

interface AdmissionControls {
  readonly access: TestAccessOutcome;
  readonly malformedOutcome?: boolean;
  readonly noPredicate?: boolean;
}

/** Coarse admission uses only the bound list gate, with no index, SQL or legacy permission adapter. */
const runAdmission = (controls: AdmissionControls, selectedScope: OperationalScope = scope) =>
  Effect.gen(function* run() {
    const scripted = makeScriptedBoundAccessGate(controls.access).bound;
    let calls = 0;
    const decision = yield* admitPeopleSystemSearch(selectedScope, {
      list: (question) =>
        Effect.gen(function* listPeople() {
          calls += 1;
          expect(question.carrier.accessDeclaration).toBe(peopleSearchRead.descriptor.accessDeclaration);
          expect(question.legalEntityScope).toBe(peopleSearchRead.descriptor.legalEntityScope);
          expect(question.scope).toBe(selectedScope);
          expect(Schema.is(Schema.Date)(question.now)).toBe(true);
          const listing = yield* scripted.list(question);
          if (controls.malformedOutcome === true) {
            return {
              ...listing,
              decision: new Proxy(listing.decision, {
                get: malformedDecisionOutcome,
              }),
            };
          }
          return controls.noPredicate === true ? { decision: listing.decision } : listing;
        }),
    });
    expect(calls).toBe(selectedScope.legalEntityId === undefined ? 0 : 1);
    return decision;
  });

it.layer(NodeCrypto.layer)('people search inventory admission', (suite) => {
  suite.effect('admits the canonical People list capability with its row predicate', () =>
    Effect.gen(function* allowedAdmission() {
      expect(yield* runAdmission({ access: 'allowed' })).toBe('allowed');
    }),
  );

  suite.effect('treats canonical denial and approval-only access as definite omission', () =>
    Effect.gen(function* deniedAdmission() {
      expect(yield* runAdmission({ access: 'denied' })).toBe('denied');
      expect(yield* runAdmission({ access: 'needs_approval' })).toBe('denied');
    }),
  );

  suite.effect('keeps unavailable or malformed canonical outcomes distinct from a definite denial', () =>
    Effect.gen(function* unavailableAdmission() {
      expect(yield* runAdmission({ access: 'unavailable' })).toBe('unavailable');
      expect(yield* runAdmission({ access: 'allowed', malformedOutcome: true })).toBe('unavailable');
    }),
  );

  suite.effect('never widens an allowed list decision without a row predicate', () =>
    Effect.gen(function* missingPredicateAdmission() {
      expect(yield* runAdmission({ access: 'allowed', noPredicate: true })).toBe('denied');
    }),
  );

  suite.effect('requires the original selected company before asking the gate', () =>
    Effect.gen(function* companyRequiredAdmission() {
      const { legalEntityId: _selectedCompany, ...withoutCompany } = scope;
      expect(yield* runAdmission({ access: 'allowed' }, withoutCompany)).toBe('denied');
    }),
  );
});
