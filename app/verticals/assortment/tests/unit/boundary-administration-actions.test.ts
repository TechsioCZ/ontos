import type {
  DomainEvent,
  DomainEventReference,
  OperationalScope,
  OutboxMessage,
  ScopedRoutineDefinition,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CreateClosedAssortmentBoundaryPayloadSchema,
  EndClosedAssortmentBoundaryPayloadSchema,
  ReplaceClosedAssortmentBoundaryPayloadSchema,
} from '../../shared/actions/boundary-administration.ts';
import { AssortmentCommercialScopeSchema } from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentPolicyPersistenceUnavailable,
  AssortmentPolicyTargetInvariant,
} from '../../shared/domain/policy-errors.ts';
import {
  createBoundaryPermissionTarget,
  boundaryAdmissionEvidence,
  boundaryMeaningFingerprint,
  collectionRevisionRef,
  replaceBoundaryPermissionTargets,
} from '../../src/actions/boundary-administration-support.ts';
import { handleCreateClosedAssortmentBoundary } from '../../src/actions/create-closed-assortment-boundary.action.ts';
import { handleEndClosedAssortmentBoundary } from '../../src/actions/end-closed-assortment-boundary.action.ts';
import { handleReplaceClosedAssortmentBoundary } from '../../src/actions/replace-closed-assortment-boundary.action.ts';
import type { BoundaryAdministrationService } from '../../src/services/boundary-administration.service.ts';
import {
  boundaryIntervalsOverlap,
  boundaryAdministrationPersistenceForScope,
  boundaryScopeConflict,
  matchesBoundaryCreateReplay,
  matchesBoundaryEndReplay,
} from '../../src/services/boundary-administration.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const scope = {
  authContextRef: 'boundary-test',
  authMethod: 'session',
  correlationId: 'boundary-test',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId,
} satisfies OperationalScope;
const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
const channelRef = ref('commerce.channel', 'commerce.channel.channel', 'channel-1');
const legalEntityRef = ref('party.registry', 'party.registry.legal-entity', scope.legalEntityId);
const profileRef = ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1');
const payload = Schema.decodeUnknownSync(CreateClosedAssortmentBoundaryPayloadSchema)({
  admissionSet: { entries: [] },
  commercialScope: { channelRef, sellingLegalEntityRef: legalEntityRef },
  decisionPurpose: 'PURCHASE',
  effectiveFrom: '2026-09-22T10:00:00.000Z',
  provenanceRef: 'test',
  reason: 'test',
  subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef },
});

type QueryRows = readonly object[];
type FakeTransactionOptions = Readonly<{
  readonly events: string[];
  readonly insertResults?: readonly (QueryRows | Effect.Effect<QueryRows, unknown>)[];
  readonly selectResults?: readonly QueryRows[];
}>;

const effectQuery = (rows: QueryRows | Effect.Effect<QueryRows, unknown>, events: string[], label: string) => {
  events.push(label);
  const baseEffect = Effect.isEffect(rows) ? rows : Effect.succeed(rows);
  // SAFETY: The fake query builder exposes the same fluent terminal methods used by this owner service.
  // SAFETY: The fake query builder deliberately augments an Effect with the fluent methods consumed by Drizzle.
  const effect = baseEffect as unknown as Effect.Effect<QueryRows> & {
    from: () => typeof effect;
    limit: () => typeof effect;
    returning: () => typeof effect;
    values: () => typeof effect;
    where: () => typeof effect;
  };
  effect.from = () => effect;
  effect.limit = () => effect;
  effect.returning = () => effect;
  effect.values = () => effect;
  effect.where = () => effect;
  return effect;
};

const fakeTransaction = ({ events, insertResults = [], selectResults = [] }: FakeTransactionOptions) => {
  let insertIndex = 0;
  let selectIndex = 0;
  // SAFETY: The harness deliberately implements only the select/insert/invoke capabilities consumed by the owner service.
  return {
    insert: () => {
      const currentInsertIndex = insertIndex;
      insertIndex += 1;
      const result = insertResults[currentInsertIndex] ?? [];
      return effectQuery(result, events, `insert:${insertIndex}`);
    },
    invoke: (_routine: ScopedRoutineDefinition) => {
      events.push('lock');
      return Effect.succeed([{ locked: true }]);
    },
    select: () => {
      const currentSelectIndex = selectIndex;
      selectIndex += 1;
      return effectQuery(selectResults[currentSelectIndex] ?? [], events, `select:${selectIndex}`);
    },
  } as unknown as ScopedTransactionExecutor;
};

const commonInput = {
  actionInvocationId: '40000000-0000-4000-8000-000000000001',
  actorPrincipalId: scope.principalId,
  legalEntityId: scope.legalEntityId,
  tenantId,
};

const createInput = { ...payload, ...commonInput };
const boundaryId = '50000000-0000-4000-8000-000000000001';
const endPayload = Schema.decodeUnknownSync(EndClosedAssortmentBoundaryPayloadSchema)({
  boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', boundaryId),
  effectiveAt: '2026-09-22T10:00:00.000Z',
  expectedBasisFingerprint: boundaryMeaningFingerprint(payload),
  provenanceRef: payload.provenanceRef,
  reason: payload.reason,
});
const endInput = { ...endPayload, ...commonInput };
const replacePayload = Schema.decodeUnknownSync(ReplaceClosedAssortmentBoundaryPayloadSchema)({
  effectiveAt: '2026-09-22T10:00:00.000Z',
  existingBoundaryRef: endPayload.boundaryRef,
  expectedExistingBasisFingerprint: endPayload.expectedBasisFingerprint,
  proposedAdmissionSet: payload.admissionSet,
  proposedCommercialScope: payload.commercialScope,
  proposedDecisionPurpose: payload.decisionPurpose,
  proposedEffectiveFrom: '2026-09-22T10:00:00.000Z',
  proposedSubject: payload.subject,
  provenanceRef: payload.provenanceRef,
  reason: payload.reason,
});
const replaceInput = { ...replacePayload, ...commonInput };

const boundaryServices = (overrides: Partial<BoundaryAdministrationService>): BoundaryAdministrationService => ({
  create: () => Effect.die('unused boundary service method'),
  end: () => Effect.die('unused boundary service method'),
  replace: () => Effect.die('unused boundary service method'),
  ...overrides,
});

const boundaryActionContext = (services: BoundaryAdministrationService) => {
  const events: DomainEvent[] = [];
  const outbox: OutboxMessage[] = [];
  // The production collector owns this opaque reference; this handler unit harness never dereferences it.
  const eventReference: DomainEventReference = Schema.decodeUnknownSync(Schema.Any)({});
  return {
    events,
    outbox,
    value: {
      actionInvocationId: commonInput.actionInvocationId,
      addDomainEvent: (event: DomainEvent) => {
        events.push(event);
        return Effect.succeed(eventReference);
      },
      addOutboxMessage: (_reference: DomainEventReference, message: OutboxMessage) => {
        outbox.push(message);
        return Effect.void;
      },
      compositionRevision: 'a'.repeat(64),
      recordAuditEvidence: (_evidence: Readonly<Record<string, Schema.Json>>) => Effect.void,
      recordDataAccess: () => Effect.void,
      scope,
      services,
    },
  };
};

it.effect('does not emit projection invalidation for replayed Boundary mutations', () =>
  Effect.gen(function* boundaryReplay() {
    const create = boundaryActionContext(
      boundaryServices({
        create: () =>
          Effect.succeed({
            admissionSet: {
              ...boundaryAdmissionEvidence(payload),
              collectionRevisionRef: collectionRevisionRef(tenantId, 'revision-1'),
            },
            boundaryId,
            created: false,
          }),
      }),
    );
    expect((yield* handleCreateClosedAssortmentBoundary(payload, create.value)).created).toBe(false);
    expect(create.events).toHaveLength(0);
    expect(create.outbox).toHaveLength(0);

    const end = boundaryActionContext(boundaryServices({ end: () => Effect.succeed({ ended: false }) }));
    expect((yield* handleEndClosedAssortmentBoundary(endPayload, end.value)).ended).toBe(false);
    expect(end.events).toHaveLength(0);
    expect(end.outbox).toHaveLength(0);

    const replace = boundaryActionContext(
      boundaryServices({ replace: () => Effect.succeed({ createdBoundaryId: boundaryId, replaced: false }) }),
    );
    expect((yield* handleReplaceClosedAssortmentBoundary(replacePayload, replace.value)).replaced).toBe(false);
    expect(replace.events).toHaveLength(0);
    expect(replace.outbox).toHaveLength(0);
  }),
);

it('derives EMPTY distinctly and canonicalizes admission evidence', () => {
  const empty = boundaryAdmissionEvidence(payload);
  expect(empty.setKind).toStrictEqual('EMPTY');
  expect(empty.memberCount).toStrictEqual(0);
  expect(createBoundaryPermissionTarget(payload, scope).admissionSet.setKind).toStrictEqual('EMPTY');
  expect(createBoundaryPermissionTarget(payload, scope).admissionSet.entries).toEqual([]);
  const foreignLegalEntityPayload = Schema.decodeUnknownSync(CreateClosedAssortmentBoundaryPayloadSchema)({
    admissionSet: payload.admissionSet,
    commercialScope: {
      ...payload.commercialScope,
      sellingLegalEntityRef: { ...legalEntityRef, resourceId: 'foreign-legal-entity' },
    },
    decisionPurpose: payload.decisionPurpose,
    effectiveFrom: '2026-09-22T10:00:00.000Z',
    provenanceRef: payload.provenanceRef,
    reason: payload.reason,
    subject: payload.subject,
  });
  expect(() => createBoundaryPermissionTarget(foreignLegalEntityPayload, scope)).toThrow(
    AssortmentPolicyTargetInvariant,
  );
  const allPayload = Schema.decodeUnknownSync(CreateClosedAssortmentBoundaryPayloadSchema)({
    admissionSet: { ...payload.admissionSet, entries: [{ kind: 'ALL' }] },
    commercialScope: payload.commercialScope,
    decisionPurpose: payload.decisionPurpose,
    effectiveFrom: '2026-09-22T10:00:00.000Z',
    provenanceRef: payload.provenanceRef,
    reason: payload.reason,
    subject: payload.subject,
  });
  const all = boundaryAdmissionEvidence(allPayload);
  expect(all.setKind).toStrictEqual('ENTRIES');
  expect(all.memberCount).toStrictEqual(1);
  expect(all.contentHash).not.toStrictEqual(empty.contentHash);
  expect(createBoundaryPermissionTarget(allPayload, scope).admissionSet.entries).toEqual([{ kind: 'ALL' }]);
  const productRef = ref('commerce.catalog', 'commerce.catalog.product', 'product-a');
  const categoryRef = ref('commerce.catalog', 'commerce.catalog.product-category', 'category-c');
  const exactPayload = Schema.decodeUnknownSync(CreateClosedAssortmentBoundaryPayloadSchema)({
    ...payload,
    admissionSet: {
      entries: [
        { kind: 'PRODUCT', productRef },
        { categoryRef, kind: 'CATEGORY' },
      ],
    },
    effectiveFrom: '2026-09-22T10:00:00.000Z',
  });
  expect(createBoundaryPermissionTarget(exactPayload, scope).admissionSet.entries).toEqual([
    {
      kind: 'CATEGORY',
      target: {
        moduleId: 'commerce.catalog',
        resourceId: 'category-c',
        resourceType: 'commerce.catalog.product-category',
      },
    },
    {
      kind: 'PRODUCT',
      target: { moduleId: 'commerce.catalog', resourceId: 'product-a', resourceType: 'commerce.catalog.product' },
    },
  ]);
  const foreignCatalogPayload = Schema.decodeUnknownSync(CreateClosedAssortmentBoundaryPayloadSchema)({
    ...payload,
    admissionSet: {
      entries: [{ kind: 'PRODUCT', productRef: { ...productRef, tenantId: '10000000-0000-4000-8000-000000000002' } }],
    },
    effectiveFrom: '2026-09-22T10:00:00.000Z',
  });
  expect(() => createBoundaryPermissionTarget(foreignCatalogPayload, scope)).toThrow(AssortmentPolicyTargetInvariant);
});
it('emits ordered end then create targets for replacement', () => {
  const existingBoundaryRef = ref(
    'commerce.assortment',
    'commerce.assortment.closed-assortment-boundary',
    'boundary-1',
  );
  const replacement = Schema.decodeUnknownSync(ReplaceClosedAssortmentBoundaryPayloadSchema)({
    effectiveAt: '2026-09-22T10:00:00.000Z',
    existingBoundaryRef,
    expectedExistingBasisFingerprint: 'a'.repeat(64),
    proposedAdmissionSet: payload.admissionSet,
    proposedCommercialScope: payload.commercialScope,
    proposedDecisionPurpose: payload.decisionPurpose,
    proposedEffectiveFrom: '2026-09-22T10:00:00.000Z',
    proposedSubject: payload.subject,
    provenanceRef: payload.provenanceRef,
    reason: payload.reason,
  });
  const targets = replaceBoundaryPermissionTargets(replacement, scope);
  expect(targets[0]?.permission).toStrictEqual('assortment.boundary.end');
  expect(targets[1]?.permission).toStrictEqual('assortment.boundary.create');
});
it('rejects equal and incomparable maximal scopes but permits a narrower scope', () => {
  const broad = { marketResourceId: null, storefrontResourceId: null };
  const market = { marketResourceId: 'market-1', storefrontResourceId: null };
  const storefront = { marketResourceId: null, storefrontResourceId: 'store-1' };
  const otherMarket = { marketResourceId: 'market-2', storefrontResourceId: null };
  const otherStorefront = { marketResourceId: null, storefrontResourceId: 'store-2' };
  expect(boundaryScopeConflict(broad, broad)).toStrictEqual(true);
  expect(boundaryScopeConflict(market, storefront)).toStrictEqual(true);
  expect(boundaryScopeConflict(broad, market)).toStrictEqual(false);
  expect(boundaryScopeConflict(market, otherMarket)).toStrictEqual(false);
  expect(boundaryScopeConflict(storefront, otherStorefront)).toStrictEqual(false);
  expect(boundaryIntervalsOverlap(undefined, Date.parse('2026-09-22T10:00:00.000Z'))).toStrictEqual(true);
  expect(
    boundaryIntervalsOverlap(Date.parse('2026-09-22T09:00:00.000Z'), Date.parse('2026-09-22T10:00:00.000Z')),
  ).toStrictEqual(false);
});
it('requires exact actor and durable meaning for create/end replay', () => {
  const input = {
    ...payload,
    actionInvocationId: '40000000-0000-4000-8000-000000000001',
    actorPrincipalId: '20000000-0000-4000-8000-000000000001',
    legalEntityId: scope.legalEntityId,
    tenantId,
  };
  const meaning = boundaryAdmissionEvidence(payload);
  const createRow = {
    actor: input.actorPrincipalId,
    provenance: input.provenanceRef,
    reason: input.reason,
    semanticFingerprint: '',
  };
  const fullCreateRow = { ...createRow, semanticFingerprint: boundaryMeaningFingerprint(payload) };
  expect(matchesBoundaryCreateReplay(fullCreateRow, input)).toStrictEqual(true);
  expect(matchesBoundaryCreateReplay({ ...fullCreateRow, actor: 'different' }, input)).toStrictEqual(false);
  const endReplayInput = {
    actionInvocationId: input.actionInvocationId,
    actorPrincipalId: input.actorPrincipalId,
    boundaryRef: {
      moduleId: 'commerce.assortment' as const,
      resourceId: 'boundary-1',
      resourceType: 'commerce.assortment.closed-assortment-boundary' as const,
      tenantId,
    },
    effectiveAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-09-22T10:00:00.000Z'),
    expectedBasisFingerprint: 'a'.repeat(64),
    legalEntityId: input.legalEntityId,
    provenanceRef: input.provenanceRef,
    reason: input.reason,
    tenantId,
  };
  const endRow = {
    actor: input.actorPrincipalId,
    basisFingerprint: endReplayInput.expectedBasisFingerprint,
    boundaryId: endReplayInput.boundaryRef.resourceId,
    effectiveAt: DateTime.toDateUtc(endReplayInput.effectiveAt),
    provenance: input.provenanceRef,
    reason: input.reason,
  };
  expect(matchesBoundaryEndReplay(endRow, endReplayInput)).toStrictEqual(true);
  expect(matchesBoundaryEndReplay({ ...endRow, reason: 'changed' }, endReplayInput)).toStrictEqual(false);
  expect(meaning.memberCount).toStrictEqual(0);
});

it.effect('takes the scope advisory lock before complete reads and propagates rollback failures', () =>
  Effect.gen(function* lockFirstAndRollback() {
    const events: string[] = [];
    const service = boundaryAdministrationPersistenceForScope(
      fakeTransaction({
        events,
        insertResults: [Effect.fail('insert failed')],
        selectResults: [[], [], []],
      }),
      scope,
    );
    const failure = yield* Effect.flip(service.create(createInput));
    expect(Schema.is(AssortmentPolicyPersistenceUnavailable)(failure)).toStrictEqual(true);
    expect(events[0]).toStrictEqual('lock');
    expect(events.slice(1, 3)).toStrictEqual(['select:1', 'select:2']);
  }),
);

it.effect('replays exact creates, rejects changed meaning, and returns a future-overlap conflict', () =>
  Effect.gen(function* replayCreateAndRejectOverlap() {
    const replayRow = {
      actor: commonInput.actorPrincipalId,
      id: 'boundary-1',
      provenance: payload.provenanceRef,
      reason: payload.reason,
      semanticFingerprint: boundaryMeaningFingerprint(payload),
    };
    const replayService = boundaryAdministrationPersistenceForScope(
      fakeTransaction({
        events: [],
        selectResults: [
          [replayRow],
          [
            {
              collectionKind: 'CLOSED_BOUNDARY_ADMISSION_SET',
              collectionRevisionId: 'revision-1',
              completeness: 'COMPLETE',
              contentHash: boundaryAdmissionEvidence(payload).contentHash,
              memberCount: 0,
            },
          ],
          [{ setKind: 'EMPTY' }],
        ],
      }),
      scope,
    );
    const replay = yield* replayService.create(createInput);
    expect(replay).toMatchObject({ boundaryId: 'boundary-1', created: false });

    const changedService = boundaryAdministrationPersistenceForScope(
      fakeTransaction({ events: [], selectResults: [[replayRow]] }),
      scope,
    );
    const changed = yield* changedService.create({ ...createInput, reason: 'changed' });
    expect(changed).toStrictEqual({ conflict: 'IDEMPOTENCY_REUSED', kind: 'conflict' });

    const overlapService = boundaryAdministrationPersistenceForScope(
      fakeTransaction({
        events: [],
        selectResults: [
          [],
          [
            {
              boundaryId: 'future',
              effectiveFrom: new Date('2026-09-23T10:00:00.000Z'),
              marketResourceId: null,
              storefrontResourceId: null,
            },
          ],
          [],
        ],
      }),
      scope,
    );
    const overlap = yield* overlapService.create(createInput);
    expect(overlap).toStrictEqual({ conflict: 'CONCURRENT_OVERLAP', kind: 'conflict' });
  }),
);

it.effect('allows a disjoint scope while retaining owner-derived admission evidence', () =>
  Effect.gen(function* allowDisjointScope() {
    const disjoint = {
      ...payload,
      commercialScope: Schema.decodeUnknownSync(AssortmentCommercialScopeSchema)({
        ...payload.commercialScope,
        commerceMarketRef: ref('commerce.market', 'commerce.market.market', 'market-1'),
      }),
    };
    const events: string[] = [];
    const service = boundaryAdministrationPersistenceForScope(
      fakeTransaction({
        events,
        insertResults: [[{ id: 'boundary-2' }], [{ id: 'revision-2' }], [{ id: 'set-2' }], []],
        selectResults: [
          [],
          [
            {
              boundaryId: 'other',
              effectiveFrom: new Date('2026-09-22T09:00:00.000Z'),
              marketResourceId: 'market-2',
              storefrontResourceId: null,
            },
          ],
          [],
        ],
      }),
      scope,
    );
    const result = yield* service.create({ ...disjoint, ...commonInput });
    expect(result).toMatchObject({ boundaryId: 'boundary-2', created: true });
    if ('admissionSet' in result) {
      expect(result.admissionSet.collectionRevisionRef.resourceId).toStrictEqual('revision-2');
    }
  }),
);

it.effect('replays exact end and replacement requests, rejects changed old targets, and enforces stale basis', () =>
  Effect.gen(function* replayEndAndReplacement() {
    const endRow = {
      actor: commonInput.actorPrincipalId,
      basisFingerprint: endInput.expectedBasisFingerprint,
      boundaryId,
      effectiveAt: DateTime.toDateUtc(endInput.effectiveAt),
      provenance: endInput.provenanceRef,
      reason: endInput.reason,
    };
    const endReplay = boundaryAdministrationPersistenceForScope(
      fakeTransaction({ events: [], selectResults: [[endRow]] }),
      scope,
    );
    expect(yield* endReplay.end(endInput)).toStrictEqual({ ended: false });
    const endMismatch = boundaryAdministrationPersistenceForScope(
      fakeTransaction({ events: [], selectResults: [[{ ...endRow, reason: 'changed' }]] }),
      scope,
    );
    expect(yield* endMismatch.end(endInput)).toStrictEqual({ conflict: 'IDEMPOTENCY_REUSED', kind: 'conflict' });

    const stale = boundaryAdministrationPersistenceForScope(
      fakeTransaction({
        events: [],
        selectResults: [
          [],
          [
            {
              channel: 'channel-1',
              purpose: 'PURCHASE',
              semanticFingerprint: 'b'.repeat(64),
              subjectKind: 'RETAIL_CUSTOMER_PROFILE',
              subjectResourceId: 'profile-1',
            },
          ],
        ],
      }),
      scope,
    );
    expect(yield* stale.end(endInput)).toStrictEqual({ kind: 'stale_basis' });

    const replacementRow = {
      actor: commonInput.actorPrincipalId,
      id: 'replacement-1',
      provenance: replaceInput.provenanceRef,
      reason: replaceInput.reason,
      semanticFingerprint: boundaryMeaningFingerprint({
        ...replaceInput,
        admissionSet: replaceInput.proposedAdmissionSet,
        commercialScope: replaceInput.proposedCommercialScope,
        decisionPurpose: replaceInput.proposedDecisionPurpose,
        effectiveFrom: replaceInput.proposedEffectiveFrom,
        subject: replaceInput.proposedSubject,
      }),
    };
    const replacementEnd = { ...endRow, boundaryId };
    const replacementReplay = boundaryAdministrationPersistenceForScope(
      fakeTransaction({ events: [], selectResults: [[replacementRow], [replacementEnd]] }),
      scope,
    );
    expect(yield* replacementReplay.replace(replaceInput)).toStrictEqual({
      createdBoundaryId: 'replacement-1',
      replaced: false,
    });
    const changedOldTarget = boundaryAdministrationPersistenceForScope(
      fakeTransaction({ events: [], selectResults: [[replacementRow], [{ ...replacementEnd, boundaryId: 'other' }]] }),
      scope,
    );
    expect(yield* changedOldTarget.replace(replaceInput)).toStrictEqual({
      conflict: 'IDEMPOTENCY_REUSED',
      kind: 'conflict',
    });
  }),
);

it.effect('uses one transaction seam for replace and propagates create rollback failure after end', () =>
  Effect.gen(function* replaceRollback() {
    const events: string[] = [];
    const replacement = boundaryAdministrationPersistenceForScope(
      fakeTransaction({
        events,
        insertResults: [[{ id: 'end-fact-1' }], Effect.fail('create failed')],
        selectResults: [
          [],
          [],
          [
            {
              channel: 'channel-1',
              purpose: 'PURCHASE',
              semanticFingerprint: endInput.expectedBasisFingerprint,
              subjectKind: 'RETAIL_CUSTOMER_PROFILE',
              subjectResourceId: 'profile-1',
            },
          ],
          [],
          [],
          [],
          [],
          [],
        ],
      }),
      scope,
    );
    const failure = yield* Effect.flip(replacement.replace(replaceInput));
    expect(Schema.is(AssortmentPolicyPersistenceUnavailable)(failure)).toStrictEqual(true);
    expect(events[0]).toStrictEqual('select:1');
    expect(events).toContain('lock');
    expect(events).toContain('insert:2');
  }),
);
