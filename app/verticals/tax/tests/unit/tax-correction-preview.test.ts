import type { OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TaxCorrectionPreviewRequestSchema,
  TaxCorrectionPreviewResponseSchema,
} from '../../shared/apis/tax-correction-preview.ts';
import { readTaxCorrectionPreview } from '../../src/api/tax-correction-preview.read.ts';
import {
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
} from '../../src/domain/tax-correction-delta.ts';
import {
  HistoricalReadUsesAcceptedTaxTermsSchema,
  NewEventDeterminationUnsupportedSchema,
  NoNewTaxEventSchema,
} from '../../src/domain/tax-declared-purpose.ts';
import { TaxDependencyUnavailableSchema } from '../../src/domain/tax-non-success-outcome.ts';
import { acceptedTaxTermsInput } from './tax-correction-fixtures.ts';
import { exactDecimal } from './tax-domain-fixtures.ts';

type PreviewRequestInput = typeof TaxCorrectionPreviewRequestSchema.Encoded;

const decodeRequest = Schema.decodeUnknownSync(TaxCorrectionPreviewRequestSchema);
const encodeResponse = Schema.encodeSync(TaxCorrectionPreviewResponseSchema);

const scope = {
  authContextRef: 'tax-correction-preview-test',
  authMethod: 'session',
  correlationId: 'tax-correction-preview-test',
  legalEntityId: 'selling-legal-entity-1',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: 'tenant-1',
} satisfies OperationalScope;

const terms = acceptedTaxTermsInput([{ lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' }]);
/** Bound to its Decision, but the published Tax does not follow from the 899.90 CZK basis. */
const inconsistentTerms = acceptedTaxTermsInput(
  [{ lineValue: '899.90', occurrenceId: 'o-1', quantity: '10' }],
  [{ lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' }],
);

/** Stage C: a declared CORRECTION of one unit, over the given handed-over Accepted Tax Terms. */
const stageCCorrection = (acceptedTaxTerms: PreviewRequestInput['acceptedTaxTerms']): PreviewRequestInput => ({
  acceptedTaxTerms,
  declaredPurpose: {
    _tag: 'CORRECTION',
    correctionEventRef: 'return-1',
    correctionReason: 'CUSTOMER_RETURN',
    units: [
      {
        changes: [{ _tag: 'QUANTITY', quantityDelta: exactDecimal('-3') }],
        expectedPreviousState: { _tag: 'NO_ACCEPTED_CORRECTION' },
        taxableSupplyUnitId: 'taxable-supply-unit:o-1',
      },
    ],
  },
});

const preview = (input: PreviewRequestInput, at: OperationalScope = scope) =>
  readTaxCorrectionPreview(decodeRequest(input), {
    readKey: 'commerce.tax.api.tax-correction-preview',
    scope: at,
    services: {},
  }).pipe(Effect.map(({ result }) => result));

describe('Tax correction preview read', () => {
  it.effect('#948 F13-F15 #946 F16 previews a correction delta from the handed-over Accepted Tax Terms only', () =>
    Effect.gen(function* previewsCorrectionDelta() {
      const result = yield* preview({
        acceptedTaxTerms: terms,
        declaredPurpose: {
          _tag: 'CORRECTION',
          correctionEventRef: 'return-1',
          correctionReason: 'CUSTOMER_RETURN',
          units: [
            {
              changes: [{ _tag: 'QUANTITY', quantityDelta: exactDecimal('-3') }],
              expectedPreviousState: { _tag: 'NO_ACCEPTED_CORRECTION' },
              taxableSupplyUnitId: 'taxable-supply-unit:o-1',
            },
          ],
        },
      });

      expect(Schema.is(TaxCorrectionDeltaSchema)(result)).toBe(true);
      expect(encodeResponse(result)).toMatchObject({
        correctionTaxDelta: { amount: '-62.99', currency: 'CZK' },
        units: [{ proposedNext: { remainingPublishedTax: { amount: '146.99', currency: 'CZK' } } }],
      });
    }),
  );

  it.effect('A-1 previews a combined goods and Shipping change for one unit in a single correction', () =>
    Effect.gen(function* previewsCombinedChange() {
      const combinedTerms = acceptedTaxTermsInput([
        { lineValue: '100.00', occurrenceId: 'o-1', quantity: '2', shipping: '10.00' },
      ]);
      const result = yield* preview({
        acceptedTaxTerms: combinedTerms,
        declaredPurpose: {
          _tag: 'CORRECTION',
          correctionEventRef: 'return-1',
          correctionReason: 'CUSTOMER_RETURN',
          units: [
            {
              changes: [
                { _tag: 'QUANTITY', quantityDelta: exactDecimal('-2') },
                {
                  _tag: 'VALUE',
                  amountBasis: 'GROSS',
                  basisComponent: 'SHIPPING_ALLOCATION',
                  valueDelta: exactDecimal('-10'),
                },
              ],
              expectedPreviousState: { _tag: 'NO_ACCEPTED_CORRECTION' },
              taxableSupplyUnitId: 'taxable-supply-unit:o-1',
            },
          ],
        },
      });

      expect(Schema.is(TaxCorrectionDeltaSchema)(result)).toBe(true);
      expect(encodeResponse(result)).toMatchObject({
        correctionTaxDelta: { amount: '-22.74', currency: 'CZK' },
        units: [{ proposedNext: { remainingPublishedTax: { amount: '0.00', currency: 'CZK' } } }],
      });
    }),
  );

  it.effect('#947 F1-F3 #946 F21 a historical read is answered by the retained terms without any Tax evaluation', () =>
    Effect.gen(function* answersHistoricalRead() {
      const result = yield* preview({ acceptedTaxTerms: terms, declaredPurpose: { _tag: 'HISTORICAL_READ' } });

      expect(Schema.is(HistoricalReadUsesAcceptedTaxTermsSchema)(result)).toBe(true);
      expect(encodeResponse(result)).toMatchObject({ originalTaxDecisionId: 'tax-decision-1' });
    }),
  );

  it.effect('#948 F32-F37 a Fulfillment split is no new Tax event and fabricates no Decision', () =>
    Effect.gen(function* interpretsFulfillmentSplit() {
      const result = yield* preview({
        acceptedTaxTerms: terms,
        declaredPurpose: { _tag: 'NEW_EVENT', eventKind: 'PARTIAL_FULFILLMENT', eventRef: 'shipment-4-of-10' },
      });

      expect(Schema.is(NoNewTaxEventSchema)(result)).toBe(true);
      expect(Object.keys(result).toSorted()).toEqual(['_tag', 'eventRef']);
    }),
  );

  it.effect('#947 F16-F22 an independent later supply fails explicitly, with no live or historical fallback', () =>
    Effect.gen(function* rejectsIndependentSupply() {
      const result = yield* preview({
        acceptedTaxTerms: terms,
        declaredPurpose: { _tag: 'NEW_EVENT', eventKind: 'INDEPENDENT_SUPPLY', eventRef: 'later-supply-1' },
      });

      expect(Schema.is(NewEventDeterminationUnsupportedSchema)(result)).toBe(true);
      expect(Object.keys(result).toSorted()).toEqual(['_tag', 'eventRef']);
    }),
  );

  it.effect('#907 F214-F215 Accepted Tax Terms of another Tenant or Selling Legal Entity are not visible', () =>
    Effect.gen(function* hidesForeignTerms() {
      for (const foreign of [
        { ...scope, legalEntityId: 'selling-legal-entity-2' },
        { ...scope, tenantId: 'tenant-2' },
      ]) {
        for (const handedOver of [terms, inconsistentTerms]) {
          const failure = yield* Effect.flip(
            preview({ acceptedTaxTerms: handedOver, declaredPurpose: { _tag: 'HISTORICAL_READ' } }, foreign),
          );
          expect(failure.code).toBe('read_handler_not_found');
        }
      }
    }),
  );

  it.effect('#947 F13 #948 F7 an original record the owner cannot establish is the explicit unresolved outcome', () =>
    Effect.gen(function* answersUnavailableRecord() {
      for (const reason of ['MISSING', 'AMBIGUOUS'] as const) {
        const result = yield* preview(
          {
            acceptedTaxTerms: { _tag: 'ORIGINAL_RECORD_UNAVAILABLE', reason },
            declaredPurpose: { _tag: 'HISTORICAL_READ' },
          },
          { ...scope, tenantId: 'tenant-2' },
        );
        expect(Schema.is(TaxCorrectionHistoricalInputUnresolvedSchema)(result)).toBe(true);
        expect(encodeResponse(result)).toMatchObject({ unresolved: { _tag: 'ORIGINAL_RECORD_UNAVAILABLE', reason } });
      }
    }),
  );

  it.effect('#946 F12 #947 F13 a record whose Tax Result does not follow from its Decision is unresolved input', () =>
    Effect.gen(function* answersInconsistentRecord() {
      const result = yield* preview({
        acceptedTaxTerms: inconsistentTerms,
        declaredPurpose: { _tag: 'HISTORICAL_READ' },
      });

      expect(Schema.is(TaxCorrectionHistoricalInputUnresolvedSchema)(result)).toBe(true);
      expect(encodeResponse(result)).toMatchObject({ unresolved: { _tag: 'ORIGINAL_RECORD_INCONSISTENT' } });
    }),
  );

  it('#946 F8-F9 a structurally malformed handover is a contract violation, not a guessed baseline', () => {
    const { finalTax, ...withoutFinalTax } = terms;
    for (const malformed of [
      withoutFinalTax,
      { ...terms, orderCommitmentTime: '2026-10-08T10:00:02.000Z' },
      { ...terms, finalTax: { ...finalTax, decision: { ...finalTax.decision, units: [] } } },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(TaxCorrectionPreviewRequestSchema)({
          acceptedTaxTerms: malformed,
          declaredPurpose: { _tag: 'HISTORICAL_READ' },
        }),
      ).toThrow();
    }
  });

  describe('Stage C: H10 baseline (#945-#948)', () => {
    const orderSnapshotTerms = acceptedTaxTermsInput(
      [{ lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' }],
      undefined,
      { _tag: 'ORDER_SNAPSHOT' },
    );

    it('C-2 a declared CORRECTION over the Order Snapshot fails to decode; over the Billing Document it previews', () => {
      expect(() => decodeRequest(stageCCorrection(orderSnapshotTerms))).toThrow(/accepted Billing Document/u);
      expect(() => decodeRequest(stageCCorrection(terms))).not.toThrow();
    });

    it('C-3 HISTORICAL_READ and NEW_EVENT over the Order Snapshot are still answered (pre-document boundary)', () => {
      expect(() =>
        decodeRequest({ acceptedTaxTerms: orderSnapshotTerms, declaredPurpose: { _tag: 'HISTORICAL_READ' } }),
      ).not.toThrow();
      expect(() =>
        decodeRequest({
          acceptedTaxTerms: orderSnapshotTerms,
          declaredPurpose: { _tag: 'NEW_EVENT', eventKind: 'PARTIAL_FULFILLMENT', eventRef: 'shipment-4-of-10' },
        }),
      ).not.toThrow();
    });
  });

  it('#948 F11 #907 F193-F194 accepts no Payment refund or Fulfillment status as correction facts', () => {
    expect(() =>
      decodeRequest({
        acceptedTaxTerms: terms,
        declaredPurpose: {
          _tag: 'CORRECTION',
          correctionEventRef: 'refund-1',
          correctionReason: 'PAYMENT_REFUND',
          units: [
            {
              changes: [{ _tag: 'REFUND', refundAmount: exactDecimal('-100') }],
              expectedPreviousState: { _tag: 'NO_ACCEPTED_CORRECTION' },
              taxableSupplyUnitId: 'taxable-supply-unit:o-1',
            },
          ],
        },
      }),
    ).toThrow();
  });

  describe('Stage D: D4 outcome at the public boundary (#938 F22-F26)', () => {
    const unavailableHandover = { _tag: 'HISTORY_OWNER_UNAVAILABLE' } as const;

    it.effect('D-1 HISTORY_OWNER_UNAVAILABLE answers TAX_DEPENDENCY_UNAVAILABLE for every declared purpose', () =>
      Effect.gen(function* answersDependencyUnavailable() {
        for (const declaredPurpose of [
          { _tag: 'HISTORICAL_READ' } as const,
          stageCCorrection(unavailableHandover).declaredPurpose,
          { _tag: 'NEW_EVENT', eventKind: 'PARTIAL_FULFILLMENT', eventRef: 'shipment-4-of-10' } as const,
        ]) {
          for (const at of [scope, { ...scope, tenantId: 'tenant-2' }]) {
            const result = yield* preview({ acceptedTaxTerms: unavailableHandover, declaredPurpose }, at);
            expect(Schema.is(TaxDependencyUnavailableSchema)(result)).toBe(true);
            expect(Object.keys(encodeResponse(result))).toEqual(['_tag']);
          }
        }
      }),
    );

    it('D-1 the decode accepts HISTORY_OWNER_UNAVAILABLE as a declared CORRECTION handover', () => {
      expect(() => decodeRequest(stageCCorrection(unavailableHandover))).not.toThrow();
    });
  });
});
