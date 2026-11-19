import type { OperationalScope } from '@app/core-runtime';
import { ReadPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  CallForbiddenSchema,
  CallUnavailableSchema,
  RequestExecutionSchema,
  callOkSchema,
} from '@app/core-runtime/sdk';
import type { CallOutcome, RequestExecution } from '@app/core-runtime/sdk';
import { makeExecutionStandIn } from '@app/core-runtime/testing/sdk';
import { MarketSubjectRestrictionsCurrentResponseSchema } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import type { MarketSubjectRestrictionsCurrentResponse } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { EligibleMarketTuplesRequestSchema } from '../../shared/apis/eligible-market-tuples.ts';
import { ResolveCommerceMarketRequestSchema } from '../../shared/apis/resolve-commerce-market.ts';
import type { EligibleMarketTuple } from '../../shared/market-contracts.ts';
import { eligibleMarketTuplesCalls, runEligibleMarketTuples } from '../../src/api/eligible-market-tuples.read.ts';
import type { EligibleMarketTuplesRunContext } from '../../src/api/eligible-market-tuples.read.ts';
import { resolveCommerceMarketCalls, runResolveCommerceMarket } from '../../src/api/resolve-commerce-market.read.ts';
import type { ResolveCommerceMarketRunContext } from '../../src/api/resolve-commerce-market.read.ts';
import type { MarketEligibilitySnapshot } from '../../src/domain/market-resolution.ts';
import { MarketResolutionPersistenceUnavailable } from '../../src/persistence/market-resolution-persistence.ts';
import type { MarketResolutionPersistence } from '../../src/persistence/market-resolution-persistence.ts';
import type { MarketSubjectRestrictionSnapshot } from '../../src/integrations/market-subject-restrictions.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const profileId = '99999999-9999-4999-8999-999999999999';
const retailProfileId = '12121212-1212-4121-8121-121212121212';
const counterpartyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storefrontRef = { appId: 'shop', tenantId } as const;
const at = '2030-06-01T00:00:00.000Z';
const sellerRef = {
  moduleId: 'core.identity' as const,
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity' as const,
  tenantId,
};
const eligibleTuple: EligibleMarketTuple = {
  associationRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.market-catalog.storefront-association',
    tenantId,
  },
  associationRevision: 4,
  channel: 'B2B',
  marketDefinitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  marketRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.market-catalog.market',
    tenantId,
  },
  sellingLegalEntityRef: sellerRef,
};
const snapshot: MarketEligibilitySnapshot = {
  completenessEvidence: Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)({
    observedAt: at,
    ownerRevision: 'market-eligibility:v1:proof',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market-eligibility:v1:shop:B2B:seller' },
  }),
  effectiveAt: Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema.fields.effectiveAt)(at),
  evaluatedAt: Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema.fields.effectiveAt)(
    '2030-06-01T00:00:01.000Z',
  ),
  facts: [{ lifecycle: 'ACTIVE', tuple: eligibleTuple }],
};
const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '77777777-7777-4777-8777-777777777777',
    authContextRef: 'session:market-resolution',
    authMethod: 'session',
    legalEntityId: sellerId,
    principalId,
    tenantId,
    trustedStorefrontId: storefrontRef.appId,
  }),
  correlationId: 'market-resolution-test',
};
const available: MarketResolutionPersistence = { load: () => Effect.succeed({ ...snapshot, generation: 7 }) };
const withSnapshot = (current: MarketEligibilitySnapshot, generation: number): MarketResolutionPersistence => ({
  load: () => Effect.succeed({ ...current, generation }),
});
const unavailable: MarketResolutionPersistence = {
  load: () =>
    Effect.fail(
      new MarketResolutionPersistenceUnavailable({
        code: 'market_resolution_persistence_unavailable',
        reason: 'fixture unavailable',
      }),
    ),
};
const ownerRestrictions: MarketSubjectRestrictionSnapshot = {
  allowedChannels: ['B2B'],
  allowedSellerIds: [sellerId],
  decision: 'ALLOWED',
  evidenceRefs: ['commerce-customer-context:counterparty-profile:revision:7'],
  observedAt: Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema.fields.effectiveAt)(
    '2030-06-01T00:00:00.500Z',
  ),
  ownerRevision: 'counterparty-profile:7',
  profileState: 'ACTIVE',
  subjectIdentityRef: profileId,
  subjectKind: 'COUNTERPARTY',
};
const counterpartySubject = {
  counterpartyRef: {
    moduleId: 'party.registry' as const,
    resourceId: counterpartyId,
    resourceType: 'party.registry.counterparty' as const,
    tenantId,
  },
  kind: 'COUNTERPARTY' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: profileId,
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
    tenantId,
  },
};

const retailSubject = {
  kind: 'RETAIL_PROFILE' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: retailProfileId,
    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
    tenantId,
  },
};

type Subject = typeof counterpartySubject | typeof retailSubject;

/** Customer Context's current restrictions for a subject, as its contract answers them. */
const ownerAnswer = (
  subject: Subject,
  restrictions: MarketSubjectRestrictionSnapshot = ownerRestrictions,
): CallOutcome<MarketSubjectRestrictionsCurrentResponse> =>
  callOkSchema(MarketSubjectRestrictionsCurrentResponseSchema).make({
    value: Schema.decodeUnknownSync(MarketSubjectRestrictionsCurrentResponseSchema)({
      channelConstraint: { allowedChannels: restrictions.allowedChannels, kind: 'ALLOWED_CHANNELS' },
      completenessEvidence: {
        observedAt: DateTime.formatIso(restrictions.observedAt),
        ownerRevision: restrictions.ownerRevision,
        scope: {
          kind: 'EXACT_PREDICATE',
          predicateRef: `market-subject-restrictions:${subject.profileRef.resourceId}`,
        },
      },
      decision: restrictions.decision,
      evidenceRefs: restrictions.evidenceRefs,
      marketConstraint: { kind: 'ANY_MARKET' },
      observedAt: DateTime.formatIso(restrictions.observedAt),
      outcome: 'SUBJECT_RESTRICTIONS_CURRENT',
      ownerRevision: restrictions.ownerRevision,
      profileState: restrictions.profileState,
      // A Retail Profile buys from exactly one fixed seller; a Counterparty from an allowed set.
      sellerConstraint:
        subject.kind === 'RETAIL_PROFILE'
          ? { kind: 'FIXED_SELLER', sellerRef: { ...sellerRef, resourceId: restrictions.allowedSellerIds[0] } }
          : {
              kind: 'ALLOWED_SELLERS',
              sellerRefs: restrictions.allowedSellerIds.map((resourceId) => ({ ...sellerRef, resourceId })),
            },
      subject,
    }),
  });
const ownerUnavailable: CallOutcome<MarketSubjectRestrictionsCurrentResponse> = CallUnavailableSchema.make({
  reason: 'owner unavailable',
  retryable: true,
});

interface Fixture {
  readonly answer?: CallOutcome<MarketSubjectRestrictionsCurrentResponse>;
  readonly persistence: MarketResolutionPersistence;
  readonly scope?: OperationalScope;
  readonly via?: RequestExecution['via'];
}

/**
 * Drives a read's `run` with Core's capability stand-ins, which keep the kernel's rule: a call while
 * the owner transaction is open, or a nested transaction, dies. Both reads declare the same call by the
 * same name, so one context type serves both.
 */
const harness = (
  calls: typeof eligibleMarketTuplesCalls | typeof resolveCommerceMarketCalls,
  readKey: string,
  fixture: Fixture,
) => {
  const loads: (MarketSubjectRestrictionSnapshot | undefined)[] = [];
  const persistence: MarketResolutionPersistence = {
    load: (request, restrictions) =>
      Effect.suspend(() => {
        loads.push(restrictions);
        return fixture.persistence.load(request, restrictions);
      }),
  };
  const standIn = makeExecutionStandIn(calls, {
    answers: {
      subjectRestrictions: ({ subject }) =>
        Effect.succeed(
          fixture.answer ?? ownerAnswer(subject.kind === 'COUNTERPARTY' ? counterpartySubject : retailSubject),
        ),
    },
    operationAt: DateTime.makeUnsafe(at),
    services: () => persistence,
  });
  const context: EligibleMarketTuplesRunContext & ResolveCommerceMarketRunContext = {
    access: {},
    call: standIn.call,
    execution: {
      compositionRevision: 'composition-revision-1',
      identity: RequestExecutionSchema.make({ via: fixture.via ?? 'person' }),
      operationKey: readKey,
      owningModuleKey: 'commerce.market-catalog',
    },
    readKey,
    scope: fixture.scope ?? scope,
    transaction: standIn.transaction,
  };
  return {
    calledWith: () => standIn.steps.flatMap((step) => (step.kind === 'call' ? [step.input] : [])),
    context,
    /** The subject restrictions each owner query received. */
    loadedWith: () => [...loads],
    /** The stand-in's steps, in order: the call, each transaction's begin and end. */
    steps: () => standIn.steps.map(({ kind }) => kind),
  };
};

/** Both reads, run over the same request shape, answering the outcome and what the stand-ins saw. */
const readsUnderTest = [
  {
    name: 'eligible-market-tuples',
    run: (encoded: typeof EligibleMarketTuplesRequestSchema.Encoded, fixture: Fixture) => {
      const probe = harness(eligibleMarketTuplesCalls, 'commerce.market-catalog.api.eligible-market-tuples', fixture);
      const outcome = runEligibleMarketTuples(
        Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)(encoded),
        probe.context,
      ).pipe(Effect.map(({ result }) => result.outcome));
      return { outcome, probe };
    },
  },
  {
    name: 'resolve-commerce-market',
    run: (encoded: typeof EligibleMarketTuplesRequestSchema.Encoded, fixture: Fixture) => {
      const probe = harness(resolveCommerceMarketCalls, 'commerce.market-catalog.api.resolve-commerce-market', fixture);
      const outcome = runResolveCommerceMarket(
        Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)(encoded),
        probe.context,
      ).pipe(Effect.map(({ result }) => result.outcome));
      return { outcome, probe };
    },
  },
] as const;

const eligible = (input: Parameters<typeof runEligibleMarketTuples>[0], fixture: Fixture) =>
  runEligibleMarketTuples(
    input,
    harness(eligibleMarketTuplesCalls, 'commerce.market-catalog.api.eligible-market-tuples', fixture).context,
  );
const resolve = (input: Parameters<typeof runResolveCommerceMarket>[0], fixture: Fixture) =>
  runResolveCommerceMarket(
    input,
    harness(resolveCommerceMarketCalls, 'commerce.market-catalog.api.resolve-commerce-market', fixture).context,
  );

describe('Commerce Market governed resolution reads', () => {
  it.effect('returns safe complete eligible tuples under trusted Storefront context', () =>
    Effect.gen(function* eligibleRead() {
      const input = Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        sellingLegalEntityRestriction: sellerRef,
        storefrontRef,
      });
      const result = yield* eligible(input, { persistence: available });
      expect(result.result).toMatchObject({ outcome: 'ELIGIBLE_MARKET_TUPLES', tuples: [eligibleTuple] });
      if (result.result.outcome === 'ELIGIBLE_MARKET_TUPLES') {
        expect(DateTime.formatIso(result.result.effectiveAt)).toBe(at);
        expect(DateTime.formatIso(result.result.evaluatedAt)).toBe('2030-06-01T00:00:01.000Z');
      }
      expect(result.evidence.resultCount).toBe(1);
    }),
  );

  it.effect('fails closed when the Storefront differs from trusted operational context', () =>
    Effect.gen(function* deniedStorefront() {
      const input = Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
        channel: 'B2C',
        effectiveAt: at,
        storefrontRef: { ...storefrontRef, appId: 'untrusted-shop' },
      });
      const error = yield* Effect.flip(eligible(input, { persistence: available }));
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );

  it.effect('uses owner restrictions instead of treating trusted principal seller scope as authority', () =>
    Effect.gen(function* ownerRestrictedSeller() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        sellingLegalEntityRestriction: {
          ...sellerRef,
          resourceId: '88888888-8888-4888-8888-888888888888',
        },
        storefrontRef,
        subject: counterpartySubject,
      });
      const result = yield* resolve(input, { persistence: available });
      expect(result.result).toMatchObject({ outcome: 'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL' });
    }),
  );

  it.effect('forwards fixed Retail seller restrictions into the authoritative eligibility predicate', () =>
    Effect.gen(function* retailRestrictions() {
      let receivedRestrictions: MarketSubjectRestrictionSnapshot | undefined;
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2C',
        effectiveAt: at,
        storefrontRef,
        subject: retailSubject,
      });
      const retailSnapshot: MarketSubjectRestrictionSnapshot = {
        ...ownerRestrictions,
        allowedChannels: ['B2C'],
        evidenceRefs: ['commerce-customer-context:retail-profile:revision:4'],
        ownerRevision: 'retail-profile:4',
        subjectIdentityRef: retailProfileId,
        subjectKind: 'RETAIL_PROFILE',
      };
      const result = yield* resolve(input, {
        answer: ownerAnswer(retailSubject, retailSnapshot),
        persistence: {
          load: (_request, restrictions) => {
            receivedRestrictions = restrictions;
            return Effect.succeed({
              ...snapshot,
              facts: [{ lifecycle: 'ACTIVE', tuple: { ...eligibleTuple, channel: 'B2C' } }],
              generation: 7,
            });
          },
        },
      });

      expect(receivedRestrictions).toEqual(retailSnapshot);
      expect(result.result).toMatchObject({
        outcome: 'MARKET_RESOLVED',
        subjectRestrictionEvidence: {
          ownerRevision: 'retail-profile:4',
          subjectKind: 'RETAIL_PROFILE',
        },
      });
    }),
  );

  it.effect('changes Counterparty eligibility when the owner changes the allowed seller set', () =>
    Effect.gen(function* changedCounterpartyRestriction() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
        subject: counterpartySubject,
      });
      const restrictionAwarePersistence: MarketResolutionPersistence = {
        load: (_request, restrictions) =>
          Effect.succeed({
            ...snapshot,
            completenessEvidence: {
              ...snapshot.completenessEvidence,
              ownerRevision: `market-eligibility:${restrictions?.ownerRevision ?? 'none'}`,
            },
            facts: snapshot.facts.filter(
              ({ tuple }) =>
                restrictions !== undefined &&
                restrictions.allowedSellerIds.includes(tuple.sellingLegalEntityRef.resourceId),
            ),
            generation: 7,
          }),
      };
      const before = yield* resolve(input, { persistence: restrictionAwarePersistence });
      const after = yield* resolve(input, {
        answer: ownerAnswer(counterpartySubject, {
          ...ownerRestrictions,
          allowedSellerIds: ['88888888-8888-4888-8888-888888888888'],
          ownerRevision: 'counterparty-profile:8',
        }),
        persistence: restrictionAwarePersistence,
      });

      expect(before.result.outcome).toBe('MARKET_RESOLVED');
      expect(after.result).toMatchObject({ outcome: 'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL' });
    }),
  );

  it.effect('attaches only safe owner-issued subject restriction evidence', () =>
    Effect.gen(function* restrictedResolution() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        sellingLegalEntityRestriction: sellerRef,
        storefrontRef,
        subject: counterpartySubject,
      });
      const result = yield* resolve(input, { persistence: available });
      expect(result.result).toMatchObject({
        outcome: 'MARKET_RESOLVED',
        subjectRestrictionEvidence: {
          decision: 'ALLOWED',
          evidenceRefs: ['commerce-customer-context:counterparty-profile:revision:7'],
          ownerRevision: 'counterparty-profile:7',
          subjectKind: 'COUNTERPARTY',
        },
      });
      if (result.result.outcome === 'MARKET_RESOLVED') {
        expect(DateTime.formatIso(result.result.effectiveAt)).toBe(at);
        expect(DateTime.formatIso(result.result.evaluatedAt)).toBe('2030-06-01T00:00:01.000Z');
      }
      expect(JSON.stringify(result.result)).not.toContain(profileId);
    }),
  );

  it.effect(
    'returns retryable inability without querying Market persistence when subject ownership is unavailable',
    () =>
      Effect.gen(function* unavailableSubjectOwner() {
        let persistenceCalls = 0;
        const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
          channel: 'B2B',
          effectiveAt: at,
          storefrontRef,
          subject: counterpartySubject,
        });
        const result = yield* resolve(input, {
          answer: ownerUnavailable,
          persistence: {
            load: () => {
              persistenceCalls += 1;
              return Effect.succeed({ ...snapshot, generation: 7 });
            },
          },
        });
        expect(result.result).toEqual({
          outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
          reason: 'Current Commerce Market eligibility could not be established',
          retryable: true,
        });
        expect(persistenceCalls).toBe(0);
      }),
  );

  it.effect('fails eligible-set discovery closed when mandatory subject-owner state is unavailable', () =>
    Effect.gen(function* unavailableEligibleSubjectOwner() {
      let persistenceCalls = 0;
      const input = Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
        subject: counterpartySubject,
      });
      const result = yield* eligible(input, {
        answer: ownerUnavailable,
        persistence: {
          load: () => {
            persistenceCalls += 1;
            return Effect.succeed({ ...snapshot, generation: 7 });
          },
        },
      });

      expect(result.result).toEqual({
        outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
        reason: 'Current Commerce Market eligibility could not be established',
        retryable: true,
      });
      expect(persistenceCalls).toBe(0);
    }),
  );

  it.effect('invalidates completeness when the owner subject revision changes', () =>
    Effect.gen(function* changedSubjectRevision() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
        subject: counterpartySubject,
      });
      const ownerAwarePersistence: MarketResolutionPersistence = {
        load: (_request, restrictions) =>
          Effect.succeed({
            ...snapshot,
            completenessEvidence: {
              ...snapshot.completenessEvidence,
              ownerRevision: `market-eligibility:v2:${restrictions?.ownerRevision ?? 'none'}`,
            },
            generation: 7,
          }),
      };
      const before = yield* resolve(input, { persistence: ownerAwarePersistence });
      const after = yield* resolve(input, {
        answer: ownerAnswer(counterpartySubject, { ...ownerRestrictions, ownerRevision: 'counterparty-profile:8' }),
        persistence: ownerAwarePersistence,
      });
      if (before.result.outcome === 'MARKET_RESOLVED' && after.result.outcome === 'MARKET_RESOLVED') {
        expect(before.result.completenessEvidence.ownerRevision).not.toBe(
          after.result.completenessEvidence.ownerRevision,
        );
      }
    }),
  );

  it.effect('returns a separate retryable inability when owner completeness cannot be established', () =>
    Effect.gen(function* unavailableResolution() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2C',
        effectiveAt: at,
        storefrontRef,
      });
      const result = yield* resolve(input, { persistence: unavailable });
      expect(result.result).toEqual({
        outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
        reason: 'Current Commerce Market eligibility could not be established',
        retryable: true,
      });
    }),
  );

  it.effect('invalidates prior completeness after a material lifecycle or association revision changes', () =>
    Effect.gen(function* invalidatedCompleteness() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
      });
      const changedSnapshot: MarketEligibilitySnapshot = {
        ...snapshot,
        completenessEvidence: {
          ...snapshot.completenessEvidence,
          ownerRevision: 'market-eligibility:v1:changed-material-state',
        },
      };
      const before = yield* resolve(input, { persistence: withSnapshot(snapshot, 7) });
      const after = yield* resolve(input, { persistence: withSnapshot(changedSnapshot, 8) });
      expect(before.result.outcome).toBe('MARKET_RESOLVED');
      expect(after.result.outcome).toBe('MARKET_RESOLVED');
      if (before.result.outcome === 'MARKET_RESOLVED' && after.result.outcome === 'MARKET_RESOLVED') {
        expect(before.result.selectedTuple.marketRef).toEqual(after.result.selectedTuple.marketRef);
        expect(before.result.completenessEvidence.ownerRevision).not.toBe(
          after.result.completenessEvidence.ownerRevision,
        );
      }
    }),
  );

  it.effect('keeps exact predicate completeness stable across an unrelated tenant generation change', () =>
    Effect.gen(function* stableExactPredicate() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
      });
      const before = yield* resolve(input, { persistence: withSnapshot(snapshot, 7) });
      const after = yield* resolve(input, { persistence: withSnapshot(snapshot, 99) });
      if (before.result.outcome === 'MARKET_RESOLVED' && after.result.outcome === 'MARKET_RESOLVED') {
        expect(before.result.completenessEvidence.ownerRevision).toBe(after.result.completenessEvidence.ownerRevision);
      }
    }),
  );
  it.effect('calls Customer Context before the owner transaction, never while it is open', () =>
    Effect.forEach(
      readsUnderTest,
      ({ name, run }) =>
        Effect.gen(function* callOutsideTransaction() {
          const { outcome, probe } = run(
            { channel: 'B2B', effectiveAt: at, storefrontRef, subject: counterpartySubject },
            { persistence: available },
          );
          expect({ name, outcome: yield* outcome }).toEqual({
            name,
            outcome: name === 'eligible-market-tuples' ? 'ELIGIBLE_MARKET_TUPLES' : 'MARKET_RESOLVED',
          });
          expect({ name, steps: probe.steps() }).toEqual({ name, steps: ['call', 'begin', 'end'] });
          expect(probe.calledWith()).toEqual([{ subject: counterpartySubject }]);
          expect(probe.loadedWith()).toEqual([ownerRestrictions]);
        }),
      { discard: true },
    ),
  );

  it.effect('makes no call for a guest or an absent subject and loads without subject restrictions', () =>
    Effect.forEach(
      readsUnderTest,
      ({ name, run }) =>
        Effect.forEach(
          [
            { channel: 'B2B', effectiveAt: at, storefrontRef },
            {
              channel: 'B2B',
              effectiveAt: at,
              storefrontRef,
              subject: { kind: 'GUEST', subjectRef: 'storefront-guest-session' },
            },
          ] as const,
          (request) =>
            Effect.gen(function* withoutSubjectCall() {
              const { outcome, probe } = run(request, { persistence: available });
              yield* outcome;
              expect({ name, steps: probe.steps() }).toEqual({ name, steps: ['begin', 'end'] });
              expect(probe.loadedWith()).toEqual([undefined]);
            }),
          { discard: true },
        ),
      { discard: true },
    ),
  );

  it.effect('answers UNAVAILABLE without a transaction when Customer Context gives no current restrictions', () =>
    Effect.forEach(
      readsUnderTest,
      ({ name, run }) =>
        Effect.forEach(
          [
            ownerUnavailable,
            CallForbiddenSchema.make({ reason: 'Customer Context refused the relayed requester' }),
            callOkSchema(MarketSubjectRestrictionsCurrentResponseSchema).make({
              value: Schema.decodeUnknownSync(MarketSubjectRestrictionsCurrentResponseSchema)({
                outcome: 'SUBJECT_RESTRICTIONS_UNAVAILABLE',
                reason: 'owner restrictions unavailable',
                retryable: true,
              }),
            }),
          ],
          (answer) =>
            Effect.gen(function* unavailableAnswer() {
              const { outcome, probe } = run(
                { channel: 'B2B', effectiveAt: at, storefrontRef, subject: counterpartySubject },
                { answer, persistence: available },
              );
              expect({ name, outcome: yield* outcome }).toEqual({ name, outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE' });
              expect({ name, steps: probe.steps() }).toEqual({ name, steps: ['call'] });
            }),
          { discard: true },
        ),
      { discard: true },
    ),
  );

  it.effect('answers UNAVAILABLE without a call or a transaction for a subject without a Legal Entity', () =>
    Effect.forEach(
      readsUnderTest,
      ({ name, run }) =>
        Effect.gen(function* withoutLegalEntity() {
          const { legalEntityId: _withoutLegalEntity, ...scopeWithoutLegalEntity } = scope;
          const { outcome, probe } = run(
            { channel: 'B2B', effectiveAt: at, storefrontRef, subject: counterpartySubject },
            { persistence: available, scope: scopeWithoutLegalEntity },
          );
          expect({ name, outcome: yield* outcome }).toEqual({ name, outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE' });
          expect({ name, steps: probe.steps() }).toEqual({ name, steps: [] });
        }),
      { discard: true },
    ),
  );

  it.effect('denies a request outside the trusted scope before any call or transaction', () =>
    Effect.forEach(
      readsUnderTest,
      ({ name, run }) =>
        Effect.gen(function* outsideScope() {
          const { outcome, probe } = run(
            {
              channel: 'B2B',
              effectiveAt: at,
              storefrontRef: { ...storefrontRef, appId: 'untrusted-shop' },
              subject: counterpartySubject,
            },
            { persistence: available },
          );
          const failure = yield* Effect.flip(outcome);
          expect({ denied: Schema.is(ReadPermissionDenied)(failure), name }).toEqual({ denied: true, name });
          expect({ name, steps: probe.steps() }).toEqual({ name, steps: [] });
        }),
      { discard: true },
    ),
  );

  /*
   * Which identity the call carries is Core's choice from the requirement's declared callers: both
   * requirements declare only the relayed person (see module-dependency-contracts.test.ts), so every
   * request kind relays its verified scope as an `Assertion` under the subject's Legal Entity, as the
   * hand-built `acquireMarketOwnerDelegation` did for every kind. The read itself makes the same call,
   * with the same input, before the same single transaction, whatever kind of request it serves.
   */
  it.effect('makes the same call before the same transaction for every request kind', () =>
    Effect.forEach(
      readsUnderTest,
      ({ name, run }) =>
        Effect.forEach(
          ['person', 'recovery', 'system', 'workload'] as const,
          (via) =>
            Effect.gen(function* perRequestKind() {
              const { outcome, probe } = run(
                { channel: 'B2B', effectiveAt: at, storefrontRef, subject: counterpartySubject },
                { persistence: available, via },
              );
              yield* outcome;
              expect({ name, steps: probe.steps(), via }).toEqual({ name, steps: ['call', 'begin', 'end'], via });
              expect({ calledWith: probe.calledWith(), name, via }).toEqual({
                calledWith: [{ subject: counterpartySubject }],
                name,
                via,
              });
            }),
          { discard: true },
        ),
      { discard: true },
    ),
  );
});
