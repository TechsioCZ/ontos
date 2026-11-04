import {
  ContextAccess,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ContextAccessResult, ContextAccessService, OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import type { ReadTestHarnessOptions } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SqlError, UnknownError } from 'effect/sql/SqlError';

import { SearchLabelsRequestSchema, SearchLabelsResponseSchema } from '../../shared/apis/search-labels.ts';
import type { SearchLabelSourceRef } from '../../shared/apis/search-labels.ts';
import type { CounterpartyRef } from '../../shared/resources/counterparty.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { counterpartyReadRead } from '../../src/api/counterparty-read.read.ts';
import {
  authorizePartySearchLabels,
  deduplicateSearchLabelRefs,
  searchLabelsRead,
} from '../../src/api/search-labels.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const otherId = '90000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const ref: PartyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
};
const counterpartyRef: CounterpartyRef = {
  moduleId: 'party.registry',
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty',
  tenantId,
};
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '50000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:test',
    authMethod: 'session',
    legalEntityId,
    principalId: '60000000-0000-4000-8000-000000000001',
    tenantId,
  }),
  correlationId: 'party-labels-unit',
};
const label = 'Strojírny Vysočina';
const row = { counterpartyId, label: Option.some(label), legalEntityId, partyId, sourceRevision: 7, tenantId };
const wireRow = {
  counterparty_id: counterpartyId,
  current_display_name: label,
  legal_entity_id: legalEntityId,
  party_id: partyId,
  revision: 7,
  tenant_id: tenantId,
};
const resourceKey = `party.registry:party.registry.counterparty:${counterpartyId}`;
const allowedResult = { labels: [{ label, resourceRef: ref, sourceRevision: 7 }] };
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T12:00:00Z'));
const runtimeRequest = (refs: readonly SearchLabelSourceRef[]) => ({
  input: { refs },
  principal: scope,
  registration: searchLabelsRead,
  transport: { correlationId: scope.correlationId },
});
const makeHarness = (executeOwnerQuery: ReadTestHarnessOptions['executeOwnerQuery']) =>
  makeReadTestHarness({
    executeOwnerQuery,
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    legalEntityPermissionDecisions: { read_counterparty: 'denied' },
    scope,
  });

const authority = (
  company: ContextAccessResult['decision'] = 'denied',
  resource: ContextAccessResult['decision'] = 'allowed',
) => {
  const resourceCalls: Parameters<ContextAccessService['resources']>[0][] = [];
  const companyCalls: Parameters<ContextAccessService['legalEntities']>[0][] = [];
  const access: ContextAccessService = {
    legalEntities: (input) => {
      companyCalls.push(input);
      return Effect.succeed([{ decision: company, key: legalEntityId }]);
    },
    modules: () => Effect.die('Owner must not substitute module access for source authority'),
    resources: (input) => {
      resourceCalls.push(input);
      return Effect.succeed(
        input.resources.map((target) => ({
          decision: resource,
          key: `${target.moduleId}:${target.resourceType}:${target.resourceId}`,
        })),
      );
    },
    tenants: () => Effect.die('No blanket tenant Party permission may be required'),
  };
  return { access, companyCalls, resourceCalls };
};
const run = (
  access: ContextAccessService,
  rows: Parameters<typeof authorizePartySearchLabels>[2] = [row],
  refs: readonly SearchLabelSourceRef[] = [ref],
  currentScope = scope,
) => authorizePartySearchLabels({ refs }, currentScope, rows).pipe(Effect.provideService(ContextAccess, access));
const isUnavailable = Schema.is(ReadHandlerUnavailable);

it.effect('resource-only authority checks the real current-company Counterparty, not the Party ID', () =>
  Effect.gen(function* resourceOnly() {
    const { access, companyCalls, resourceCalls } = authority();
    expect(yield* run(access)).toEqual(allowedResult);
    expect(companyCalls).toEqual([
      { legalEntityIds: [legalEntityId], permission: 'read_counterparty', principalId: scope.principalId, tenantId },
    ]);
    expect(resourceCalls).toEqual([
      {
        legalEntityId,
        permission: 'read',
        principalId: scope.principalId,
        tenantId,
        resources: [
          { moduleId: 'party.registry', resourceId: counterpartyId, resourceType: 'party.registry.counterparty' },
        ],
      },
    ]);
    expect(counterpartyId).not.toBe(partyId);
  }),
);

it.effect('company read_counterparty independently authorizes only its associated display label', () =>
  Effect.gen(function* companyOnly() {
    const { access, resourceCalls } = authority('allowed', 'denied');
    expect(yield* run(access)).toEqual(allowedResult);
    expect(resourceCalls).toEqual([]);
    expect(yield* run(access, [])).toEqual({ labels: [] });
  }),
);

it.effect('denied, missing and canonically withdrawn names have identical empty responses', () =>
  Effect.gen(function* undiscoverable() {
    expect(yield* run(authority('denied', 'denied').access)).toEqual({ labels: [] });
    expect(yield* run(authority().access, [])).toEqual({ labels: [] });
    expect(yield* run(authority('allowed').access, [{ ...row, label: Option.none() }])).toEqual({ labels: [] });
  }),
);

it.effect('uncertain authority never becomes an empty or partial complete success', () =>
  Effect.gen(function* uncertainAuthority() {
    for (const [company, resource] of [
      ['denied', 'unavailable'],
      ['unavailable', 'denied'],
      ['unavailable', 'unavailable'],
    ] as const) {
      expect(isUnavailable(yield* run(authority(company, resource).access).pipe(Effect.flip))).toBe(true);
    }
    expect(isUnavailable(yield* run(authority('unavailable').access, []).pipe(Effect.flip))).toBe(true);
    expect(yield* run(authority('unavailable', 'allowed').access)).toEqual(allowedResult);
  }),
);

it.effect('mixed allowed and indeterminate resource decisions never release a partial batch', () =>
  Effect.gen(function* partialAuthority() {
    const secondCounterpartyId = '30000000-0000-4000-8000-000000000002';
    const access: ContextAccessService = {
      ...authority().access,
      resources: (input) =>
        Effect.succeed(
          input.resources.map((target) => ({
            decision: target.resourceId === counterpartyId ? ('allowed' as const) : ('unavailable' as const),
            key: `${target.moduleId}:${target.resourceType}:${target.resourceId}`,
          })),
        ),
    };
    expect(
      isUnavailable(
        yield* run(
          access,
          [row, { ...row, partyId: otherId, counterpartyId: secondCounterpartyId }],
          [ref, { ...ref, resourceId: otherId }],
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
  }),
);

it.effect('missing, duplicate, excess or mismatched permission responses fail unavailable', () =>
  Effect.gen(function* malformedAuthority() {
    const invalid: readonly (readonly ContextAccessResult[])[] = [
      [],
      [{ key: otherId, decision: 'allowed' }],
      [
        { key: resourceKey, decision: 'allowed' },
        { key: resourceKey, decision: 'allowed' },
      ],
    ];
    for (const decisions of invalid) {
      expect(
        isUnavailable(
          yield* run({ ...authority().access, resources: () => Effect.succeed(decisions) }).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
    expect(
      isUnavailable(yield* run({ ...authority().access, legalEntities: () => Effect.succeed([]) }).pipe(Effect.flip)),
    ).toBe(true);
  }),
);

it.effect('foreign refs are omitted; wrong-company, cross-tenant and unrequested associations fail closed', () =>
  Effect.gen(function* scopeIsolation() {
    expect(yield* run(authority().access, [], [{ ...ref, tenantId: otherId }])).toEqual({ labels: [] });
    for (const invalidRow of [
      { ...row, legalEntityId: otherId },
      { ...row, tenantId: otherId },
      { ...row, partyId: otherId },
    ]) {
      expect(isUnavailable(yield* run(authority('allowed').access, [invalidRow]).pipe(Effect.flip))).toBe(true);
    }
    const { legalEntityId: _company, ...unselectedScope } = scope;
    expect(isUnavailable(yield* run(authority().access, [], [], unselectedScope).pipe(Effect.flip))).toBe(true);
  }),
);

it.effect('duplicate or ambiguous Party-to-Counterparty mappings are unavailable', () =>
  Effect.gen(function* ambiguousAssociation() {
    expect(isUnavailable(yield* run(authority('allowed').access, [row, row]).pipe(Effect.flip))).toBe(true);
    expect(
      isUnavailable(
        yield* run(authority('allowed').access, [row, { ...row, counterpartyId: otherId }]).pipe(Effect.flip),
      ),
    ).toBe(true);
  }),
);

it('accepts typed Party and Counterparty refs, bounds raw batches to 100, and declares no query', () => {
  expect(Schema.is(SearchLabelsRequestSchema)({ refs: Array.from({ length: 100 }, () => ref) })).toBe(true);
  expect(Schema.is(SearchLabelsRequestSchema)({ refs: Array.from({ length: 101 }, () => ref) })).toBe(false);
  expect(Schema.is(SearchLabelsRequestSchema)({ refs: [ref, counterpartyRef] })).toBe(true);
  for (const invalidRef of [
    { ...ref, moduleId: 'other' },
    { ...ref, resourceType: 'party.registry.unknown' },
    { ...ref, resourceId: 'invalid' },
  ]) {
    expect(Schema.is(SearchLabelsRequestSchema)({ refs: [invalidRef] })).toBe(false);
  }
  expect(Object.keys(SearchLabelsRequestSchema.fields)).toEqual(['refs']);
  expect(Schema.is(SearchLabelsResponseSchema)(allowedResult)).toBe(true);
  expect(searchLabelsRead.descriptor.entrypoint.authorization).toEqual({
    kind: 'context_permission',
    permission: 'module.access',
  });
  expect(searchLabelsRead.descriptor.legalEntityScope).toBe('required');
});

it.effect('deduplication retains distinct requested types and one association can produce both typed labels', () =>
  Effect.gen(function* typedIdentity() {
    expect(
      deduplicateSearchLabelRefs([ref, counterpartyRef, ref, counterpartyRef, { ...ref, tenantId: otherId }], tenantId),
    ).toEqual([ref, counterpartyRef]);
    const sameIdOtherType = { ...counterpartyRef, resourceId: partyId };
    expect(deduplicateSearchLabelRefs([ref, sameIdOtherType], tenantId)).toEqual([ref, sameIdOtherType]);
    const { access, resourceCalls } = authority();
    expect(yield* run(access, [row], [ref, counterpartyRef, ref, counterpartyRef])).toEqual({
      labels: [
        { label, resourceRef: ref, sourceRevision: 7 },
        { label, resourceRef: counterpartyRef, sourceRevision: 7 },
      ],
    });
    expect(resourceCalls).toHaveLength(1);
    expect(resourceCalls[0]?.resources).toHaveLength(1);
  }),
);

// Public Core test kit runs the real registration/factory, SQL mapping, scope and evidence lifecycle.
// Its driver is scripted: these tests are not native PostgreSQL/RLS or live transport proof.
it.layer(NodeCrypto.layer)('governed Party label runtime', (suite) => {
  suite.effect('deduplicates before exact source loading and releases only labels/revisions after evidence', () =>
    Effect.gen(function* deduplicate() {
      const harness = yield* makeHarness((query) => {
        expect(query.scope).toEqual({ legalEntityId, tenantId });
        expect(query.params.filter((value) => value === partyId)).toHaveLength(1);
        expect(query.params).toContain(tenantId);
        expect(query.params).toContain(legalEntityId);
        const sql = query.sql.replaceAll('"party".', '');
        expect(sql).toContain('"counterparties"."party_id" = "parties"."party_id"');
        expect(sql).toContain('"counterparties"."tenant_id" = "parties"."tenant_id"');
        expect(sql).toContain('"parties"."party_id" in');
        expect(sql).toContain('"parties"."archived_at" is null');
        expect(sql).toContain('"counterparties"."archived_at" is null');
        expect(sql).not.toMatch(/limit|offset|customer|role_period|email|contact|notes/iu);
        return Effect.succeed([wireRow]);
      });
      const environment = yield* Layer.build(harness.layer);
      const result = yield* harness.runtime
        .runRead(runtimeRequest(Array.from({ length: 100 }, () => ref)))
        .pipe(Effect.provideContext(environment));
      expect(result).toEqual(allowedResult);
      expect(Object.keys(result.labels[0] ?? {}).toSorted()).toEqual(['label', 'resourceRef', 'sourceRevision']);
      expect(result.labels[0]?.sourceRevision).toBe(7);
      expect(harness.snapshot().evidenceWrites).toBe(1);
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
    }),
  );

  suite.effect('mixed typed refs use one OR association query and preserve both requested identities', () =>
    Effect.gen(function* mixedReferences() {
      const harness = yield* makeHarness((query) => {
        expect(query.params).toEqual([legalEntityId, tenantId, partyId, counterpartyId]);
        const sql = query.sql.replaceAll('"party".', '');
        expect(sql).toContain('"parties"."party_id" in');
        expect(sql).toContain('"counterparties"."counterparty_id" in');
        expect(sql).toContain(' or ');
        expect(sql).not.toMatch(/union|limit|offset|customer|role_period/iu);
        return Effect.succeed([wireRow]);
      });
      const environment = yield* Layer.build(harness.layer);
      const refs = Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? ref : counterpartyRef));
      expect(yield* harness.runtime.runRead(runtimeRequest(refs)).pipe(Effect.provideContext(environment))).toEqual({
        labels: [
          { label, resourceRef: ref, sourceRevision: 7 },
          { label, resourceRef: counterpartyRef, sourceRevision: 7 },
        ],
      });
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );

  suite.effect('wrong-type IDs never inherit a valid associated ref label', () =>
    Effect.gen(function* noTypeConflation() {
      const harness = yield* makeHarness(() => Effect.succeed([wireRow]));
      const environment = yield* Layer.build(harness.layer);
      const cases = [
        { refs: [ref, { ...counterpartyRef, resourceId: partyId }], expected: ref },
        { refs: [counterpartyRef, { ...ref, resourceId: counterpartyId }], expected: counterpartyRef },
      ];
      for (const { refs, expected } of cases) {
        expect(yield* harness.runtime.runRead(runtimeRequest(refs)).pipe(Effect.provideContext(environment))).toEqual({
          labels: [{ label, resourceRef: expected, sourceRevision: 7 }],
        });
      }
    }),
  );

  suite.effect('Counterparty-only requests compare only actual Counterparty IDs in the trusted company', () =>
    Effect.gen(function* counterpartyOnly() {
      const harness = yield* makeHarness((query) => {
        const sql = query.sql.replaceAll('"party".', '');
        expect(query.params).toEqual([legalEntityId, tenantId, counterpartyId]);
        expect(sql).toContain('"counterparties"."counterparty_id" in');
        expect(sql).not.toContain('"parties"."party_id" in');
        return Effect.succeed([wireRow]);
      });
      const environment = yield* Layer.build(harness.layer);
      expect(
        yield* harness.runtime.runRead(runtimeRequest([counterpartyRef])).pipe(Effect.provideContext(environment)),
      ).toEqual({ labels: [{ label, resourceRef: counterpartyRef, sourceRevision: 7 }] });
    }),
  );

  suite.effect(
    'CURRENT CORE BLOCKER: company-only authority cannot bypass the module gate in label or canonical Counterparty reads',
    () =>
      Effect.gen(function* actualAdmissionBlocker() {
        for (const permissionDecision of ['denied', 'unavailable'] as const) {
          const harness = yield* makeReadTestHarness({
            executeOwnerQuery: () => Effect.die('Module-gated request must not load owner data'),
            operationTime,
            ownerAuthorizationDecision: 'allowed',
            permissionDecision,
            legalEntityPermissionDecisions: { access: 'allowed', read_counterparty: 'allowed' },
            scope,
          });
          const environment = yield* Layer.build(harness.layer);
          const labelFailure = yield* harness.runtime
            .runRead(runtimeRequest([ref, counterpartyRef]))
            .pipe(Effect.provideContext(environment), Effect.flip);
          const canonicalFailure = yield* harness.runtime
            .runRead({
              input: { counterpartyRef },
              principal: scope,
              registration: counterpartyReadRead,
              transport: { correlationId: scope.correlationId },
            })
            .pipe(Effect.provideContext(environment), Effect.flip);
          const matches =
            permissionDecision === 'denied' ? Schema.is(ReadPermissionDenied) : Schema.is(ReadPermissionUnavailable);
          expect(matches(labelFailure)).toBe(true);
          expect(matches(canonicalFailure)).toBe(true);
          expect(harness.snapshot().stages).toContain('scope_validated');
          expect(harness.snapshot().stages).toContain('module_state_checked');
          expect(harness.snapshot().ownerQueries).toHaveLength(0);
        }
      }),
  );

  suite.effect('persistence failure remains unavailable and writes no successful evidence', () =>
    Effect.gen(function* persistenceUnavailable() {
      const harness = yield* makeHarness(() =>
        Effect.fail(new SqlError({ reason: new UnknownError({ cause: 'test source unavailable' }) })),
      );
      const environment = yield* Layer.build(harness.layer);
      expect(
        isUnavailable(
          yield* harness.runtime.runRead(runtimeRequest([ref])).pipe(Effect.provideContext(environment), Effect.flip),
        ),
      ).toBe(true);
      expect(harness.snapshot().evidenceWrites).toBe(0);
    }),
  );

  suite.effect('empty and foreign-only requests perform no source query', () =>
    Effect.gen(function* emptyBatch() {
      const harness = yield* makeHarness(() => Effect.die('Unexpected source lookup'));
      const environment = yield* Layer.build(harness.layer);
      for (const refs of [[], [{ ...ref, tenantId: otherId }]]) {
        expect(yield* harness.runtime.runRead(runtimeRequest(refs)).pipe(Effect.provideContext(environment))).toEqual({
          labels: [],
        });
      }
      expect(harness.snapshot().ownerQueries).toHaveLength(0);
    }),
  );

  suite.effect('malformed canonical source rows are unavailable rather than missing', () =>
    Effect.gen(function* malformedSource() {
      for (const invalid of [
        { ...wireRow, revision: 0 },
        { ...wireRow, current_display_name: '' },
        { ...wireRow, counterparty_id: 'bad-id' },
      ]) {
        const harness = yield* makeHarness(() => Effect.succeed([invalid]));
        const environment = yield* Layer.build(harness.layer);
        expect(
          isUnavailable(
            yield* harness.runtime.runRead(runtimeRequest([ref])).pipe(Effect.provideContext(environment), Effect.flip),
          ),
        ).toBe(true);
      }
    }),
  );

  suite.effect('every independent request re-reads canonical source and current authority without a result cache', () =>
    Effect.gen(function* currentLabels() {
      let count = 0;
      let currentLabel: string | null = 'Original';
      const harness = yield* makeHarness(() => {
        count += 1;
        return Effect.succeed([{ ...wireRow, current_display_name: currentLabel, revision: 7 + count }]);
      });
      const access = authority('allowed');
      const environment = yield* Layer.build(Layer.merge(harness.layer, Layer.succeed(ContextAccess, access.access)));
      const results = [];
      for (const current of ['Original', 'Corrected', null]) {
        currentLabel = current;
        const result = yield* harness.runtime.runRead(runtimeRequest([ref])).pipe(Effect.provideContext(environment));
        results.push(result.labels);
      }
      expect(count).toBe(3);
      expect(access.companyCalls).toHaveLength(3);
      expect(harness.snapshot().evidenceWrites).toBe(3);
      expect(results).toEqual([
        [{ label: 'Original', resourceRef: ref, sourceRevision: 8 }],
        [{ label: 'Corrected', resourceRef: ref, sourceRevision: 9 }],
        [],
      ]);
    }),
  );

  suite.effect('query text and oversized or malformed requests fail before source access', () =>
    Effect.gen(function* rejectInvalidPayloads() {
      const harness = yield* makeHarness(() => Effect.die('Unexpected source lookup'));
      const environment = yield* Layer.build(harness.layer);
      for (const input of [
        { refs: [ref], query: 'private query' },
        { refs: Array.from({ length: 101 }, () => ref) },
        { refs: [{ ...ref, resourceType: 'party.registry.unknown' }] },
      ]) {
        const failure = yield* harness.runtime
          .runRead({ ...runtimeRequest([]), input })
          .pipe(Effect.provideContext(environment), Effect.flip);
        expect(failure).toMatchObject({ code: 'read_input_invalid' });
      }
      expect(harness.snapshot().ownerQueries).toHaveLength(0);
      expect(harness.snapshot().evidenceWrites).toBe(0);
    }),
  );
});
