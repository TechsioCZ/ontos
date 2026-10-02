import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { ScheduledPriceRevisionSchema } from '@app/pricing-contracts/domain/price-schedule';
import {
  PriceSourceAssertionInputSchema,
  PriceSourceProvenanceSchema,
} from '@app/pricing-contracts/domain/price-source-provenance';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  applyPriceRevision as applyPriceRevisionWithServices,
  handleRevisePrice,
  RevisePriceAcknowledgementRequired,
  RevisePriceConflict,
  RevisePricePayloadSchema,
  RevisePriceRejected,
  RevisePriceSourceDependencyUnavailable,
  RevisePriceSourceHeld,
  RevisePriceSourceInvalid,
} from '../../src/actions/revise-price.action.ts';
import type { RevisePriceActionServices } from '../../src/actions/revise-price.action.ts';
import type { PricePersistence } from '../../src/services/price-persistence.service.ts';
import {
  preparePriceSourceEvidence,
  priceSourceFactFingerprint,
} from '../../src/services/price-source-provenance.service.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const legalEntityId = '33333333-3333-4333-8333-333333333333';
const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const effectivePeriod = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: null,
};
const scheduledRevision = Schema.decodeSync(ScheduledPriceRevisionSchema)({
  definition: {
    identityKey: {
      catalogSelection: {
        productRef: {
          moduleId: 'commerce.catalog' as const,
          resourceId: '55555555-5555-4555-8555-555555555555',
          resourceType: 'commerce.catalog.product' as const,
          tenantId,
        },
        variantRef: {
          moduleId: 'commerce.catalog' as const,
          resourceId: '66666666-6666-4666-8666-666666666666',
          resourceType: 'commerce.catalog.variant' as const,
          tenantId,
        },
      },
      commercialScope: { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: legalEntityId },
      currencyCode: 'CZK',
      priceGroupSelector: { kind: 'NO_GROUP' as const },
      unitBasis: {
        quantity: '1',
        unitRef: {
          moduleId: 'commerce.catalog' as const,
          resourceId: '77777777-7777-4777-8777-777777777777',
          resourceType: 'commerce.catalog.product-unit' as const,
          tenantId,
        },
      },
    },
    priceRef,
    revision: {
      effectiveFrom: effectivePeriod.effectiveFrom,
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX' as const,
      revision: 1,
      revisionId: '88888888-8888-4888-8888-888888888888',
    },
  },
  effectivePeriod,
  lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
});
const expectedCurrent = {
  effectivePeriod,
  priceRef,
  revision: 1,
  revisionId: scheduledRevision.definition.revision.revisionId,
  scheduleRevision: 1,
};
const sourceAssertion = Schema.decodeSync(PriceSourceAssertionInputSchema)({
  lineage: { kind: 'INITIAL' },
  mapping: { mappingContractRef: 'erp-price-v2', mappingContractVersion: '2' },
  originalAssertion: {
    monetaryAmount: { amount: '125', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX',
    unitBasis: scheduledRevision.definition.identityKey.unitBasis,
  },
  sourceAssertionId: '11111111-1111-4111-8111-111111111111',
  sourceAuthority: { sourceAuthorityRef: 'pricing-owner', sourceAuthorityVersion: '7' },
  sourceRecord: {
    sourceChangeCorrelation: 'change-85',
    sourceRecordRef: 'price-row-42',
    sourceRecordVersion: '10',
    sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
  },
  timing: {
    importedAt: '2026-09-27T12:00:00.500Z',
    ownerBusinessEffectiveAt: '2026-09-27T12:00:00.000Z',
    sourceEffectiveAt: '2026-09-27T11:59:00.000Z',
  },
});
const decodedPayload = Schema.decodeSync(RevisePricePayloadSchema)({
  expectedCurrent,
  intent: 'VALUE_ONLY_CURRENT',
  monetaryAmount: { amount: '125', currencyCode: 'CZK' },
  priceRef,
  reason: 'Revise current Price value',
  sourceAssertion,
});
if (decodedPayload.intent !== 'VALUE_ONLY_CURRENT') {
  throw new Error('The fixed test fixture must decode as a value-only Current edit');
}
const payload = decodedPayload;
const trusted = {
  actingPrincipalId: '99999999-9999-4999-8999-999999999999',
  actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  legalEntityId,
  requestCorrelationId: 'revise-price-unit',
  tenantId,
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T12:00:00.000Z')),
} as const;
const revisedScheduledRevision = Schema.decodeSync(ScheduledPriceRevisionSchema)({
  ...scheduledRevision,
  definition: {
    ...scheduledRevision.definition,
    revision: {
      ...scheduledRevision.definition.revision,
      effectiveFrom: '2026-09-27T12:00:00.000Z',
      monetaryAmount: payload.monetaryAmount,
      revision: 2,
      revisionId: '12111111-1111-4111-8111-111111111111',
    },
  },
  effectivePeriod: { effectiveFrom: '2026-09-27T12:00:00.000Z', effectiveTo: null },
  lineage: {
    correctedRevisionId: null,
    kind: 'VALUE_ONLY_CURRENT',
    previousRevisionId: scheduledRevision.definition.revision.revisionId,
  },
});
const provenanceFor = (revision: typeof scheduledRevision, assertion = sourceAssertion) =>
  Schema.decodeSync(PriceSourceProvenanceSchema)({
    canonicalLink: {
      effectiveFrom: revision.definition.revision.effectiveFrom,
      identityKey: revision.definition.identityKey,
      monetaryAmount: revision.definition.revision.monetaryAmount,
      monetaryBoundary: 'PRE_TAX',
      priceRef,
      revision: revision.definition.revision.revision,
      revisionId: revision.definition.revision.revisionId,
    },
    evidence: {
      lineage:
        assertion.lineage.kind === 'INITIAL'
          ? assertion.lineage
          : { ...assertion.lineage, actingPrincipalId: trusted.actingPrincipalId },
      recordedAt: trusted.trustedOperationAt.toISOString(),
      sourceAssertion: assertion,
      sourceFactFingerprint: priceSourceFactFingerprint(assertion),
      tenantId,
    },
    provenanceRef: '13111111-1111-4111-8111-111111111111',
  });
const persistenceSuccess = (
  outcome: 'REVISED' | 'UNCHANGED',
  revision = revisedScheduledRevision,
  assertion = sourceAssertion,
) => ({
  outcome,
  provenance: provenanceFor(revision, assertion),
  revision,
});
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    authContextRef: 'session:revise-price-unit',
    authMethod: 'session',
    legalEntityId,
    principalId: trusted.actingPrincipalId,
    tenantId,
  }),
  correlationId: 'revise-price-unit',
};
const acknowledgement = {
  actingPrincipalId: trusted.actingPrincipalId,
  fingerprint: 'a'.repeat(64),
  intendedEffectivePeriod: {
    effectiveFrom: '2026-09-27T12:00:00.000Z',
    effectiveTo: null,
  },
  intendedMonetaryAmount: payload.monetaryAmount,
  intent: 'VALUE_ONLY_CURRENT' as const,
  presentedFuture: [],
  priceRef,
  scheduleRevision: 1,
  targetRevisionId: scheduledRevision.definition.revision.revisionId,
};

const currentSchedule = {
  outcome: 'PRICE_SCHEDULE_CURRENT' as const,
  schedule: {
    current: scheduledRevision,
    future: [],
    observedAt: trusted.trustedOperationAt.toISOString(),
    priceRef,
    revisions: [scheduledRevision],
    scheduleRevision: 1,
  },
};

const servicesFor = (
  revise: PricePersistence['revise'],
  overrides: Partial<RevisePriceActionServices> = {},
): RevisePriceActionServices => ({
  assessExternalPriceInput: (request) => Effect.succeed(preparePriceSourceEvidence(request)),
  readSchedule: () => Effect.succeed(currentSchedule),
  revise,
  ...overrides,
});

const applyPriceRevision = (
  revisionPayload: Parameters<typeof applyPriceRevisionWithServices>[0],
  trustedContext: Parameters<typeof applyPriceRevisionWithServices>[1],
  revise: PricePersistence['revise'],
  overrides?: Partial<RevisePriceActionServices>,
) => applyPriceRevisionWithServices(revisionPayload, trustedContext, servicesFor(revise, overrides));

describe('Revise Price Action', () => {
  it('keeps conflict reasons and rejection codes closed', () => {
    const conflict = new RevisePriceConflict({
      code: 'revise_price_conflict',
      reason: 'BOUNDARY_CROSSED',
    });
    const rejection = new RevisePriceRejected({ code: 'revise_price_scope_mismatch', reason: 'Rejected' });
    expect(Schema.is(RevisePriceConflict)(conflict)).toBe(true);
    expect(
      Schema.is(RevisePriceConflict)({
        _tag: 'RevisePriceConflict',
        code: 'revise_price_conflict',
        reason: 'UNDECLARED_CONFLICT',
      }),
    ).toBe(false);
    expect(Schema.is(RevisePriceRejected)(rejection)).toBe(true);
    expect(
      Schema.is(RevisePriceRejected)({
        _tag: 'RevisePriceRejected',
        code: 'undeclared_rejection',
        reason: 'Rejected',
      }),
    ).toBe(false);
  });

  it.effect('maps persistence revision and no-op outcomes distinctly', () =>
    Effect.gen(function* mapAcceptedOutcomes() {
      const revised = yield* applyPriceRevision(payload, trusted, () => Effect.succeed(persistenceSuccess('REVISED')));
      const unchanged = yield* applyPriceRevision(payload, trusted, () =>
        Effect.succeed(persistenceSuccess('UNCHANGED')),
      );
      expect(revised.outcome).toBe('PRICE_REVISION_CREATED');
      expect(unchanged.outcome).toBe('PRICE_REVISION_UNCHANGED');
    }),
  );

  it.effect('binds source authority assessment to the owner-resolved exact Price identity', () =>
    Effect.gen(function* assessExactSourceTarget() {
      const requests: unknown[] = [];
      const result = yield* applyPriceRevisionWithServices(
        payload,
        trusted,
        servicesFor(() => Effect.succeed(persistenceSuccess('REVISED')), {
          assessExternalPriceInput: (request) => {
            requests.push(request);
            return Effect.succeed(preparePriceSourceEvidence(request));
          },
        }),
      );

      expect(result.outcome).toBe('PRICE_REVISION_CREATED');
      expect(requests).toEqual([
        {
          actingPrincipalId: trusted.actingPrincipalId,
          effectiveFrom: trusted.trustedOperationAt.toISOString(),
          identityKey: scheduledRevision.definition.identityKey,
          monetaryAmount: payload.monetaryAmount,
          sourceAssertion: payload.sourceAssertion,
          tenantId,
          trustedOperationAt: trusted.trustedOperationAt,
        },
      ]);
    }),
  );

  it.effect('fails closed before the canonical write when source authority is not established', () =>
    Effect.gen(function* rejectUnprovenSourceAuthority() {
      const assessments = [
        {
          expected: RevisePriceSourceInvalid,
          result: {
            outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID' as const,
            reason: 'SOURCE_AUTHORITY_REJECTED' as const,
            sourceAssertionId: payload.sourceAssertion.sourceAssertionId,
          },
        },
        {
          expected: RevisePriceSourceHeld,
          result: {
            outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD' as const,
            reason: 'SOURCE_AUTHORITY_UNRESOLVED' as const,
            sourceAssertionId: payload.sourceAssertion.sourceAssertionId,
          },
        },
        {
          expected: RevisePriceSourceDependencyUnavailable,
          result: {
            dependency: 'SOURCE_AUTHORITY' as const,
            outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE' as const,
            retryable: true as const,
            sourceAssertionId: payload.sourceAssertion.sourceAssertionId,
          },
        },
      ];
      let persistenceCalls = 0;
      const rejectUnexpectedPersistence = () => {
        persistenceCalls += 1;
        return Effect.die('unproven source authority must not persist');
      };
      for (const assessment of assessments) {
        const failure = yield* applyPriceRevisionWithServices(
          payload,
          trusted,
          servicesFor(rejectUnexpectedPersistence, {
            assessExternalPriceInput: () => Effect.succeed(assessment.result),
          }),
        ).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(assessment.expected);
      }
      expect(persistenceCalls).toBe(0);
    }),
  );

  it.effect('keeps duplicate source facts distinct from invalid provenance conflicts', () =>
    Effect.gen(function* mapSourceConflicts() {
      const duplicate = yield* applyPriceRevision(payload, trusted, () =>
        Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'SOURCE_FACT_CONFLICT' as const }),
      ).pipe(Effect.flip);
      const invalid = yield* applyPriceRevision(payload, trusted, () =>
        Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'SOURCE_PROVENANCE_INVALID' as const }),
      ).pipe(Effect.flip);

      expect(duplicate).toBeInstanceOf(RevisePriceSourceHeld);
      expect(duplicate).toMatchObject({ reason: 'DUPLICATE_CORRELATION_HELD' });
      expect(invalid).toBeInstanceOf(RevisePriceSourceInvalid);
      expect(invalid).toMatchObject({ reason: 'MAPPING_REJECTED' });
    }),
  );

  it.effect('fails a mismatched persisted commercial scope closed', () =>
    Effect.gen(function* rejectPersistenceScopeMismatch() {
      const mismatchedRevision = yield* Schema.decodeEffect(ScheduledPriceRevisionSchema)({
        ...revisedScheduledRevision,
        definition: {
          ...revisedScheduledRevision.definition,
          identityKey: {
            ...revisedScheduledRevision.definition.identityKey,
            commercialScope: {
              ...revisedScheduledRevision.definition.identityKey.commercialScope,
              sellingLegalEntityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            },
          },
        },
      });
      const failure = yield* applyPriceRevision(payload, trusted, () =>
        Effect.succeed(persistenceSuccess('REVISED', mismatchedRevision)),
      ).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(RevisePriceRejected);
      expect(failure).toMatchObject({ code: 'revise_price_scope_mismatch' });
    }),
  );

  it.effect('forwards a same-value edit with complete expected-Current evidence instead of short-circuiting', () =>
    Effect.gen(function* validateExpectedCurrentBeforeNoOp() {
      const sameValuePayload = {
        ...payload,
        monetaryAmount: scheduledRevision.definition.revision.monetaryAmount,
        sourceAssertion: {
          ...payload.sourceAssertion,
          originalAssertion: {
            ...payload.sourceAssertion.originalAssertion,
            monetaryAmount: scheduledRevision.definition.revision.monetaryAmount,
          },
        },
      };
      const failure = yield* Effect.flip(
        applyPriceRevision(sameValuePayload, trusted, (command) => {
          if (command.intent !== 'VALUE_ONLY_CURRENT') {
            return Effect.die('Expected the same-value Current edit command');
          }
          expect(command.expectedCurrent).toEqual(expectedCurrent);
          expect(command.monetaryAmount).toEqual(scheduledRevision.definition.revision.monetaryAmount);
          return Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'EXPECTED_CURRENT_MISMATCH' as const });
        }),
      );
      expect(failure).toBeInstanceOf(RevisePriceConflict);
      if (Schema.is(RevisePriceConflict)(failure)) {
        expect(failure.reason).toBe('EXPECTED_CURRENT_MISMATCH');
      }
    }),
  );

  it.effect('keeps future-schedule acknowledgement and stale schedule conflict typed', () =>
    Effect.gen(function* mapBlockingOutcomes() {
      const acknowledgementExit = yield* Effect.exit(
        applyPriceRevision(payload, trusted, () =>
          Effect.succeed({ acknowledgement, outcome: 'ACKNOWLEDGEMENT_REQUIRED' as const }),
        ),
      );
      const staleExit = yield* Effect.exit(
        applyPriceRevision(payload, trusted, () =>
          Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' as const }),
        ),
      );
      expect(acknowledgementExit.toString()).toContain(RevisePriceAcknowledgementRequired.name);
      expect(staleExit.toString()).toContain(RevisePriceConflict.name);
    }),
  );

  it.effect('rejects cross-principal and cross-Price acknowledgement redemption before persistence', () =>
    Effect.gen(function* rejectAcknowledgementSubstitution() {
      for (const substitutedAcknowledgement of [
        { ...acknowledgement, actingPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        {
          ...acknowledgement,
          priceRef: { ...acknowledgement.priceRef, resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        },
      ]) {
        const failure = yield* Effect.flip(
          applyPriceRevision({ ...payload, acknowledgement: substitutedAcknowledgement }, trusted, () =>
            Effect.die('must not persist a substituted acknowledgement'),
          ),
        );
        expect(failure).toBeInstanceOf(RevisePriceRejected);
        expect(Schema.is(RevisePriceRejected)(failure)).toBe(true);
        if (Schema.is(RevisePriceRejected)(failure)) {
          expect(failure.code).toBe('revise_price_acknowledgement_mismatch');
        }
      }
    }),
  );

  it.effect('redeems a challenged edit at a later server time without moving its authenticated start', () =>
    Effect.gen(function* redeemAtLaterServerTime() {
      const warningAt = { ...trusted, trustedOperationAt: instant('2026-09-27T12:00:00.000Z') };
      const retryAt = { ...trusted, trustedOperationAt: instant('2026-09-27T12:05:00.000Z') };
      const warningExit = yield* Effect.exit(
        applyPriceRevision(payload, warningAt, () =>
          Effect.succeed({ acknowledgement, outcome: 'ACKNOWLEDGEMENT_REQUIRED' as const }),
        ),
      );
      expect(warningExit.toString()).toContain(RevisePriceAcknowledgementRequired.name);

      const result = yield* applyPriceRevision({ ...payload, acknowledgement }, retryAt, (command) => {
        if (command.intent !== 'VALUE_ONLY_CURRENT') {
          return Effect.die('Expected the value-only retry command');
        }
        expect(command.trustedOperationAt).toEqual(retryAt.trustedOperationAt);
        expect(command.acknowledgement?.intendedEffectivePeriod.effectiveFrom).toBe(
          acknowledgement.intendedEffectivePeriod.effectiveFrom,
        );
        return Effect.succeed(persistenceSuccess('REVISED'));
      });
      expect(result.outcome).toBe('PRICE_REVISION_CREATED');
    }),
  );

  it.effect('commits the Action challenge before a distinct later Action redeems it', () =>
    Effect.gen(function* redeemAcrossActionCalls() {
      let auditCount = 0;
      const context = (actionInvocationId: string, revise: PricePersistence['revise']) => ({
        actionInvocationId,
        addDomainEvent: () => Effect.die('not used'),
        addOutboxMessage: () => Effect.die('not used'),
        recordAuditEvidence: () => {
          auditCount += 1;
          return Effect.void;
        },
        recordDataAccess: () => Effect.void,
        scope,
        services: servicesFor(revise),
      });

      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-27T12:00:00.000Z')));
      const challenge = yield* handleRevisePrice(
        payload,
        context('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', () =>
          Effect.succeed({ acknowledgement, outcome: 'ACKNOWLEDGEMENT_REQUIRED' as const }),
        ),
      );
      expect(challenge).toBeDefined();

      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-27T12:05:00.000Z')));
      const redeemed = yield* handleRevisePrice(
        { ...payload, acknowledgement },
        context('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', (command) => {
          expect(command.trustedOperationAt).toEqual(instant('2026-09-27T12:05:00.000Z'));
          return Effect.succeed(persistenceSuccess('REVISED'));
        }),
      );
      expect(redeemed).toMatchObject({ outcome: 'PRICE_REVISION_CREATED' });
      expect(auditCount).toBe(2);
    }),
  );

  it.effect('rejects a mismatched Price target before persistence', () =>
    Effect.gen(function* rejectTargetMismatch() {
      const mismatched = {
        ...payload,
        expectedCurrent: {
          ...payload.expectedCurrent,
          priceRef: { ...priceRef, resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        },
      };
      const exit = yield* Effect.exit(applyPriceRevision(mismatched, trusted, () => Effect.die('must not persist')));
      expect(exit.toString()).toContain(RevisePriceRejected.name);
    }),
  );

  it.effect('keeps a correction target bound to the exact Price identity', () =>
    Effect.gen(function* preserveCorrectionIdentity() {
      const correctionSource = yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
        ...sourceAssertion,
        lineage: {
          correctedSourceAssertionId: sourceAssertion.sourceAssertionId,
          kind: 'CORRECTION',
          reason: 'Correct the source amount',
        },
        originalAssertion: {
          ...sourceAssertion.originalAssertion,
          monetaryAmount: { amount: '99', currencyCode: 'CZK' },
        },
        sourceAssertionId: '11111111-1111-4111-8111-111111111112',
        sourceRecord: {
          ...sourceAssertion.sourceRecord,
          sourceChangeCorrelation: 'change-86',
          sourceRecordVersion: '11',
        },
        timing: {
          ...sourceAssertion.timing,
          ownerBusinessEffectiveAt: scheduledRevision.definition.revision.effectiveFrom,
        },
      });
      const correction = yield* Schema.decodeEffect(RevisePricePayloadSchema)({
        expectedScheduleRevision: 1,
        intent: 'CORRECT_REVISION',
        monetaryAmount: { amount: '99', currencyCode: 'CZK' },
        priceRef,
        reason: 'Correct the selected immutable Price Revision',
        sourceAssertion: correctionSource,
        targetRevisionId: scheduledRevision.definition.revision.revisionId,
      });
      if (correction.intent !== 'CORRECT_REVISION') {
        throw new Error('Expected the correction fixture to decode as CORRECT_REVISION');
      }
      const correctedRevision = yield* Schema.decodeEffect(ScheduledPriceRevisionSchema)({
        ...scheduledRevision,
        definition: {
          ...scheduledRevision.definition,
          revision: {
            ...scheduledRevision.definition.revision,
            monetaryAmount: correction.monetaryAmount,
            revision: 2,
            revisionId: '14111111-1111-4111-8111-111111111111',
          },
        },
        lineage: {
          correctedRevisionId: scheduledRevision.definition.revision.revisionId,
          kind: 'CORRECTION',
          previousRevisionId: scheduledRevision.definition.revision.revisionId,
        },
      });
      const result = yield* applyPriceRevision(correction, trusted, (command) => {
        if (command.intent !== 'CORRECT_REVISION') {
          return Effect.die('Expected a correction command');
        }
        expect(command.priceRef).toEqual(priceRef);
        expect(command.targetRevisionId).toBe(scheduledRevision.definition.revision.revisionId);
        return Effect.succeed(persistenceSuccess('REVISED', correctedRevision, correctionSource));
      });
      expect(result.outcome).toBe('PRICE_REVISION_CREATED');

      const mismatchedTenant = {
        ...correction,
        priceRef: { ...correction.priceRef, tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      };
      const exit = yield* Effect.exit(
        applyPriceRevision(mismatchedTenant, trusted, () => Effect.die('must not persist a cross-Tenant correction')),
      );
      expect(exit.toString()).toContain(RevisePriceRejected.name);
    }),
  );

  it.effect('binds valid expected-Current evidence to the complete branded PriceRef before persistence', () =>
    Effect.gen(function* rejectEveryValidRefSubstitution() {
      for (const expectedPriceRef of [
        { ...priceRef, resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        { ...priceRef, tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      ]) {
        const exit = yield* Effect.exit(
          applyPriceRevision(
            { ...payload, expectedCurrent: { ...payload.expectedCurrent, priceRef: expectedPriceRef } },
            trusted,
            () => Effect.die('must not persist'),
          ),
        );
        expect(exit.toString()).toContain(RevisePriceRejected.name);
      }
    }),
  );

  it.effect('preserves generalized currency decoding but holds unsupported Tenant currency before persistence', () =>
    Effect.gen(function* holdUnsupportedCurrency() {
      const eurPayload = yield* Schema.decodeEffect(RevisePricePayloadSchema)({
        ...payload,
        monetaryAmount: { amount: payload.monetaryAmount.amount, currencyCode: 'EUR' },
        sourceAssertion: {
          ...payload.sourceAssertion,
          originalAssertion: {
            ...payload.sourceAssertion.originalAssertion,
            monetaryAmount: {
              amount: payload.sourceAssertion.originalAssertion.monetaryAmount.amount,
              currencyCode: 'EUR',
            },
          },
        },
      });
      let persistenceCalls = 0;
      const failure = yield* applyPriceRevision(eurPayload, trusted, () => {
        persistenceCalls += 1;
        return Effect.die('unsupported Tenant currency must not persist');
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(RevisePriceSourceHeld);
      expect(failure).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'CURRENCY_NOT_SUPPORTED_FOR_TENANT',
      });
      expect(persistenceCalls).toBe(0);
    }),
  );

  it('rejects an invalid period and non-representable monetary amount', () => {
    const decode = Schema.decodeUnknownSync(RevisePricePayloadSchema, { onExcessProperty: 'error' });
    expect(() =>
      decode({
        effectivePeriod: {
          effectiveFrom: '2026-10-01T00:00:00.000Z',
          effectiveTo: '2026-10-01T00:00:00.000Z',
        },
        expectedScheduleRevision: 1,
        intent: 'SCHEDULE_REVISION',
        monetaryAmount: { amount: '1', currencyCode: 'CZK' },
        priceRef,
        reason: 'Invalid empty interval',
      }),
    ).toThrow();
    expect(() => decode({ ...payload, monetaryAmount: { amount: '0.0000000001', currencyCode: 'CZK' } })).toThrow();
  });

  it('rejects altered PriceRef brands and Storefront monetary selectors during Action decoding', () => {
    const decode = Schema.decodeUnknownSync(RevisePricePayloadSchema, { onExcessProperty: 'error' });
    for (const expectedPriceRef of [
      { ...priceRef, moduleId: 'commerce.catalog' },
      { ...priceRef, resourceType: 'commerce.pricing.not-price' },
    ]) {
      expect(() =>
        decode({ ...payload, expectedCurrent: { ...payload.expectedCurrent, priceRef: expectedPriceRef } }),
      ).toThrow();
    }
    expect(() => decode({ ...payload, storefrontId: 'storefront-web' })).toThrow();
  });
});
