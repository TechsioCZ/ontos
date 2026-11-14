import { RecordKeySchema } from '@app/core-runtime/access/ids';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { ReadHandlerUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import type { ReadTestHarnessOptions } from '@app/core-runtime/testing/reads';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SqlError, UnknownError } from 'effect/sql/SqlError';

import { SearchLabelsRequestSchema, SearchLabelsResponseSchema } from '../../shared/apis/search-labels.ts';
import type { SearchLabelSourceRef } from '../../shared/apis/search-labels.ts';
import type { CounterpartyRef } from '../../shared/resources/counterparty.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import {
  deduplicateSearchLabelRefs,
  searchLabelsRead,
  selectAuthorizedSearchLabels,
} from '../../src/api/search-labels.read.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

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
const allowedResult = { labels: [{ label, resourceRef: ref, sourceRevision: 7 }] };
const wholeScope: ListAccessPredicate = { groups: [] };
const restrictedTo = ([first, ...rest]: readonly [string, ...string[]]): ListAccessPredicate => ({
  groups: [
    {
      clauses: [
        {
          conditions: [
            {
              _tag: 'RecordKeyIn',
              recordKeys: [RecordKeySchema.make(first), ...rest.map((key) => RecordKeySchema.make(key))],
            },
          ],
        },
      ],
    },
  ],
});
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T12:00:00Z'));
const runtimeRequest = (refs: readonly SearchLabelSourceRef[]) => ({
  input: { refs },
  principal: scope,
  registration: searchLabelsRead,
  transport: { correlationId: scope.correlationId },
});
const makeHarness = (
  executeOwnerQuery: ReadTestHarnessOptions['executeOwnerQuery'],
  access: ReadTestHarnessOptions['access'] = 'allowed',
) =>
  makeReadTestHarness({
    access,
    databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
    executeOwnerQuery,
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: partyRegistryBackendRegistration,
    scope,
  });
const isUnavailable = Schema.is(ReadHandlerUnavailable);

const select = (input: {
  readonly deniedFieldPaths?: readonly (readonly string[])[];
  readonly listAccess?: ListAccessPredicate;
  readonly refs?: readonly SearchLabelSourceRef[];
  readonly rows?: Parameters<typeof selectAuthorizedSearchLabels>[0]['rows'];
}) =>
  selectAuthorizedSearchLabels({
    deniedFieldPaths: input.deniedFieldPaths,
    listAccess: input.listAccess ?? wholeScope,
    refs: input.refs ?? [ref],
    rows: input.rows ?? [row],
    scope,
  });

it.effect('the gate alone decides the label: an allowed row and its declared field answer the name', () =>
  Effect.sync(() => {
    expect(select({})).toEqual(allowedResult);
    expect(select({ refs: [ref, counterpartyRef], rows: [row] })).toEqual({
      labels: [
        { label, resourceRef: ref, sourceRevision: 7 },
        { label, resourceRef: counterpartyRef, sourceRevision: 7 },
      ],
    });
  }),
);

it.effect('the gate row filter bounds which Counterparties contribute a label', () =>
  Effect.sync(() => {
    expect(select({ listAccess: restrictedTo([counterpartyId]) })).toEqual(allowedResult);
    expect(select({ listAccess: restrictedTo([otherId]) })).toEqual({ labels: [] });
  }),
);

it.effect('a denied identity field class withholds the name without failing the read', () =>
  Effect.sync(() => {
    expect(select({ deniedFieldPaths: [['labels', 'label']] })).toEqual({ labels: [] });
    expect(select({ deniedFieldPaths: [['labels']] })).toEqual({ labels: [] });
    expect(select({ deniedFieldPaths: [['other']] })).toEqual(allowedResult);
  }),
);

it.effect('empty, foreign and withdrawn names answer the same empty result', () =>
  Effect.sync(() => {
    expect(select({ refs: [], rows: [] })).toEqual({ labels: [] });
    expect(select({ rows: [] })).toEqual({ labels: [] });
    expect(select({ rows: [{ ...row, label: Option.none() }] })).toEqual({ labels: [] });
    expect(select({ refs: [{ ...ref, tenantId: otherId }], rows: [] })).toEqual({ labels: [] });
  }),
);

it.effect('a faulty association adapter fails closed instead of widening the result', () =>
  Effect.sync(() => {
    for (const invalidRow of [
      { ...row, legalEntityId: otherId },
      { ...row, tenantId: otherId },
      { ...row, partyId: otherId },
    ]) {
      expect(select({ rows: [invalidRow] })).toEqual({ labels: [] });
    }
    expect(select({ rows: [row, row] })).toEqual({ labels: [] });
    expect(select({ rows: [row, { ...row, counterpartyId: otherId }] })).toEqual({ labels: [] });
    const { legalEntityId: _company, ...unselectedScope } = scope;
    expect(
      selectAuthorizedSearchLabels({
        deniedFieldPaths: [],
        listAccess: wholeScope,
        refs: [ref],
        rows: [row],
        scope: unselectedScope,
      }),
    ).toEqual({ labels: [] });
  }),
);

it('accepts typed Party and Counterparty refs, bounds raw batches to 100, and declares only refs', () => {
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
  expect(searchLabelsRead.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(searchLabelsRead.descriptor.accessDeclaration).toMatchObject({
    key: 'party.registry.search-label.read',
    kind: 'read',
    selectors: ['all'],
  });
  expect(searchLabelsRead.descriptor.accessFieldGroups?.[0]).toMatchObject({
    fieldClass: 'personal_data',
    fields: ['labels.label'],
    key: 'party.registry.search-label-value.read',
    kind: 'field_read',
  });
  expect(searchLabelsRead.descriptor.legalEntityScope).toBe('required');
});

it.effect('deduplication retains distinct requested types and one association produces both typed labels', () =>
  Effect.sync(() => {
    expect(
      deduplicateSearchLabelRefs([ref, counterpartyRef, ref, counterpartyRef, { ...ref, tenantId: otherId }], tenantId),
    ).toEqual([ref, counterpartyRef]);
    const sameIdOtherType = { ...counterpartyRef, resourceId: partyId };
    expect(deduplicateSearchLabelRefs([ref, sameIdOtherType], tenantId)).toEqual([ref, sameIdOtherType]);
    expect(select({ refs: [ref, counterpartyRef, ref, counterpartyRef], rows: [row] })).toEqual({
      labels: [
        { label, resourceRef: ref, sourceRevision: 7 },
        { label, resourceRef: counterpartyRef, sourceRevision: 7 },
      ],
    });
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

  suite.effect('a denied identity field class withholds the name while the read still succeeds', () =>
    Effect.gen(function* deniedField() {
      const harness = yield* makeHarness(() => Effect.succeed([wireRow]), {
        'party.registry.search-label.read': 'allowed',
        'party.registry.search-label-value.read': 'denied',
      });
      const environment = yield* Layer.build(harness.layer);
      expect(yield* harness.runtime.runRead(runtimeRequest([ref])).pipe(Effect.provideContext(environment))).toEqual({
        labels: [],
      });
    }),
  );

  suite.effect('a denied declaration fails the read before any owner data loads', () =>
    Effect.gen(function* deniedDeclaration() {
      const harness = yield* makeHarness(() => Effect.die('Denied request must not load owner data'), 'denied');
      const environment = yield* Layer.build(harness.layer);
      const failure = yield* harness.runtime
        .runRead(runtimeRequest([ref, counterpartyRef]))
        .pipe(Effect.provideContext(environment), Effect.flip);
      expect(failure).toMatchObject({ code: 'read_permission_denied' });
      expect(harness.snapshot().ownerQueries).toHaveLength(0);
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
